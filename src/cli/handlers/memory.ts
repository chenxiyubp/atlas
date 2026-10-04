// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm memory` — the operator's write path into a resident node's memory
 * (design `memory-m1.md` §6.4 row 1, P16.W).
 *
 *   qm memory add --agent <a> --context <c> --title <t> [--body-file <f>] ...
 *   qm memory list [--agent <a> [--context <c>]] [--all] [--full]
 *   qm memory revoke <id> --agent <a> --context <c> --reason <text>
 *   qm memory invalidate <id> --agent <a> --context <c> [--at <iso>]
 *
 * Until this existed nothing in production wrote memory, so every resident
 * partition was empty and "memory is live" had no source to be true about.
 *
 * WHO THIS IS FOR
 *
 * Somebody who already holds this machine: it reads and writes the node's
 * config root directly, with that account's file permissions and nothing
 * else. There is no network surface and no approval step, because the person
 * running it could edit the same files by hand. The agent-side writer is the
 * other row of §6.4 and is not here.
 *
 * WHAT IT REFUSES
 *
 *   - a write without both `--agent` and `--context`: the partition is the
 *     one those two name (`residentMemoryScope`, the same mapping the sidecar
 *     reads with), and there is no default to fall back on;
 *   - an agent this node has never run: the check reads the resident's own
 *     session file under this config root, which also catches the most likely
 *     operator mistake — a shell whose `OCC_CONFIG_DIR` points somewhere other
 *     than the node's, where the write would land in a store nobody reads;
 *   - a write as another account than the one owning the node's state: entry
 *     files are 0600, so the resident could not read what `sudo` wrote.
 *
 * `revoke` and `invalidate` are `FileMemoryStore`'s two operations passed
 * through unchanged: the first withdraws the record (ingest axis), the second
 * ends the fact (event axis). There is no delete.
 *
 * Options are parsed here rather than by Commander, like `cert` and `audit`.
 */

import { readFileSync, statSync } from 'node:fs'
import { userInfo } from 'node:os'
import {
  defaultMemoryRoot,
  FileMemoryStore,
  isRecallable,
  type MemoryEntry,
  type WorkingScope,
} from '@qianmo/memory'
import { INJECTION_BUDGET, recall } from '@qianmo/recall'
import {
  agentOfSessionKey,
  assertNodeOwnedMemoryRoot,
  contextOfSessionKey,
  DEFAULT_CONTEXT,
  FileResidentSessionStore,
  invalidateResidentMemory,
  residentMemoryScope,
  revokeResidentMemory,
  sessionKeyOf,
  writeResidentMemory,
  type ResidentMemorySource,
  type ResidentMemoryTarget,
} from '@qianmo/resident'
import { occConfigDir, occConfigPath } from '../../config/paths.js'
import { invokedBinName } from '../../constants/brand.js'
import { residentOptionValue } from './residentArgs.js'

/** `--help` anywhere means help, matching `cert` / `audit` (whole-token). */
function isHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

export const QIANMO_MEMORY_HELP_TEXT = `Usage: ${invokedBinName()} memory <command> [options]

Write, list and retire the memory a resident agent on this node recalls.
Entries go to the partition of one agent and one requester context: the
partition every turn of that (agent, context) pair reads from.

Commands:

  add                      Write one entry.
  list                     Show partitions, their entry counts and entries.
  revoke <id>              Withdraw an entry: never recalled again, kept on
                           disk for audit.
  invalidate <id>          End the fact: not recalled from --at on, still
                           recalled for earlier points in time.

Common options:

  -h, --help               Print this and exit.

Target (required by add, revoke and invalidate):

  --agent <name>           An agent this node runs (\`resident --agent\`).
  --context <id>           The requester context: a watch job id, a console
                           chat id, or \`default\` for requests that carry
                           none.

add:

  --title <text>           Required. One line.
  --summary <text>         One line; defaults to the title.
  --body <text>            The entry body.
  --body-file <path>       Read the body from a file; \`-\` reads stdin.
  --tag <tag>              Repeatable.
  --valid-at <iso-time>    When the fact became true; defaults to now.
  --invalid-at <iso-time>  When the fact stops being true, if known.

list:

  --agent <name>           Only this agent's partitions.
  --context <id>           Only this context (needs --agent).
  --all                    Include revoked, invalidated and not-yet-valid
                           entries, marked as such.
  --full                   Include summary, tags, validity and body.

revoke:

  --reason <text>          Required. Recorded with the entry.

invalidate:

  --at <iso-time>          When the fact stopped being true; defaults to now.

Entries are recorded with source user:qm-cli:<account running this command>.
The store is the one the resident on this config root reads; set
OCC_CONFIG_DIR (and CLAUDE_CODE_REMOTE_MEMORY_DIR, if the node uses it) the
same way the resident was started, and run as the account the resident runs
as: entry files are private to their owner.
`

function unknownOption(command: string, arg: unknown): never {
  throw new Error(
    `unknown memory ${command} option ${String(arg)}` +
      ` (run \`${invokedBinName()} memory --help\` for the list)`,
  )
}

// ---------------------------------------------------------------------------
// Terminal output

/**
 * Characters that are not printed as themselves: C0 and C1 controls (escape
 * sequences start here) and the bidirectional overrides that make a line read
 * differently from its bytes. An entry's text can come from anywhere, and an
 * operator listing a partition should see the text, not have their terminal
 * reconfigured by it.
 */
function isUnprintable(code: number): boolean {
  return (
    (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  )
}

/** Spelled as a code point so the source file itself stays plain ASCII. */
const REPLACEMENT_CHARACTER = String.fromCodePoint(0xfffd)

function printable(text: string, keepLines: boolean): string {
  let out = ''
  for (const character of text.replace(/\r\n?/g, '\n')) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0x0a || code === 0x2028 || code === 0x2029) {
      out += keepLines ? '\n' : ' '
    } else {
      out += isUnprintable(code) ? REPLACEMENT_CHARACTER : character
    }
  }
  return out
}

function line(text: string): string {
  return printable(text, false)
}

// ---------------------------------------------------------------------------
// Parsing

interface TargetFlags {
  agent?: string
  context?: string
}

/** Consumes `--agent` / `--context` at `index`; returns the next index or -1. */
function readTargetFlag(
  args: readonly string[],
  index: number,
  flags: TargetFlags,
): number {
  const arg = args[index]
  if (arg === '--agent' || arg?.startsWith('--agent=')) {
    const parsed = residentOptionValue(args, index, '--agent')
    flags.agent = parsed.value
    return parsed.next
  }
  if (arg === '--context' || arg?.startsWith('--context=')) {
    const parsed = residentOptionValue(args, index, '--context')
    flags.context = parsed.value
    return parsed.next
  }
  return -1
}

function requireTarget(
  command: string,
  flags: TargetFlags,
): ResidentMemoryTarget {
  if (flags.agent === undefined || flags.context === undefined) {
    throw new Error(
      `memory ${command} needs --agent and --context: they name the partition ` +
        'the entry belongs to, and there is no default one',
    )
  }
  return { agent: flags.agent, contextId: flags.context }
}

function parseTime(flag: string, value: string): Date {
  const time = /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)
    ? Date.parse(value)
    : Number.NaN
  if (!Number.isFinite(time)) {
    throw new Error(
      `${flag} must be an ISO 8601 date or date-time (got ${JSON.stringify(value)})`,
    )
  }
  return new Date(time)
}

/** The positional `<id>` of `revoke` / `invalidate`, taken from the front. */
function splitId(
  command: string,
  args: readonly string[],
): { id: string; rest: readonly string[] } {
  const [id, ...rest] = args
  if (id === undefined || id.startsWith('-')) {
    throw new Error(`memory ${command} needs the entry id first`)
  }
  return { id, rest }
}

// ---------------------------------------------------------------------------
// Node checks

/**
 * `source.id` of every entry this command writes, and `by` of a revoke.
 *
 * A label for the audit trail, not an authentication: the account name as the
 * runtime reports it (Bun takes it from `$USER` and answers `unknown` without
 * one; Node reads the password database), falling back to the uid. Anyone who
 * can run this command can already write the store's files directly, so a
 * stronger claim here would protect nothing.
 */
function operatorSource(): ResidentMemorySource {
  let name = ''
  try {
    name = userInfo().username
  } catch {
    name = ''
  }
  if (name.length === 0 || name === 'unknown') {
    name =
      typeof process.getuid === 'function'
        ? `uid-${process.getuid()}`
        : 'unknown'
  }
  return { kind: 'user', id: `qm-cli:${name}` }
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** The resident's session file under this config root. */
function residentSessionsPath(): string {
  return occConfigPath('resident', 'sessions.json')
}

function residentSessionKeys(): readonly string[] {
  return Object.keys(
    new FileResidentSessionStore(residentSessionsPath()).entries(),
  )
}

/**
 * Refuse an agent this config root has never run.
 *
 * The resident opens the default context of every `--agent` at start-up and
 * records it in `resident/sessions.json`, and session GC always keeps an
 * agent's most recent sessions — so an agent that has run here has at least one
 * key in that file. Unreadable counts as "cannot confirm": a write into a
 * partition nobody reads is the failure this check exists to prevent.
 */
function assertNodeRunsAgent(agent: string): void {
  const path = residentSessionsPath()
  let keys: readonly string[]
  try {
    keys = residentSessionKeys()
  } catch (error) {
    throw new Error(
      `cannot confirm that agent ${agent} runs on this node: ${
        error instanceof Error ? error.message : String(error)
      } (${path})`,
    )
  }
  const agents = [
    ...new Set(
      keys.flatMap(key => {
        const name = agentOfSessionKey(key)
        return name === undefined ? [] : [name]
      }),
    ),
  ].sort()
  if (agents.includes(agent)) return
  throw new Error(
    agents.length === 0
      ? `no resident has run from this config root (no sessions in ${path}); ` +
          'start the node first, or set OCC_CONFIG_DIR to the root it runs from'
      : `agent ${agent} does not run on this node (agents with sessions in ` +
          `${path}: ${agents.join(', ')})`,
  )
}

/**
 * Refuse to write as another account than the one that owns the node's state.
 *
 * Entries are written 0600 and directories 0700. A file created by
 * `sudo qm memory add` belongs to root, and a resident running under its own
 * account cannot read it: the command reports success and the entry is
 * unreadable on every turn after. `revoke` and `invalidate` rewrite the file,
 * so they would do the same to an entry that was fine. Skipped where there is
 * no uid (Windows); a root that does not exist yet is the session check's to
 * report.
 */
function assertSameOwner(paths: readonly string[]): void {
  if (typeof process.getuid !== 'function') return
  const self = process.getuid()
  for (const path of paths) {
    let owner: number
    try {
      owner = statSync(path).uid
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (owner !== self) {
      throw new Error(
        `${path} belongs to uid ${owner} and this command runs as uid ${self}; ` +
          'entries are private to their owner, so the resident could not read ' +
          'what this wrote. Run it as the account the resident runs as',
      )
    }
  }
}

/** Everything a write checks before it touches the store. */
function assertWritableFor(agent: string): FileMemoryStore {
  const store = openStore()
  assertSameOwner([occConfigDir(), store.root])
  assertNodeRunsAgent(agent)
  return store
}

function openStore(): FileMemoryStore {
  const store = new FileMemoryStore({ root: defaultMemoryRoot() })
  // Same rule the resident applies to the root it reads: a relative root
  // would resolve against this shell's cwd, not the node's store.
  assertNodeOwnedMemoryRoot(store.root)
  return store
}

// ---------------------------------------------------------------------------
// Partitions

function partitionPath(scope: WorkingScope): string {
  return `working/${scope.projectKey}/${scope.taskId}`
}

/** `v-` segments are verbatim; `d-` segments are digests and stay as they are. */
function segmentLabel(segment: string): string {
  return segment.startsWith('v-') ? segment.slice(2) : `(${segment})`
}

/**
 * Human names for partition directories, from the session keys the resident
 * has recorded. A context with `:` or `@` in it is stored verbatim in the
 * session key but digested in the memory directory name, so the session file
 * is where its name can be read back. A context the session layer digested as
 * well is not recoverable from either and keeps its directory label; the key
 * is then not a fixed point of `sessionKeyOf`, which is how it is told apart.
 */
function partitionNames(
  sessionKeys: readonly string[],
): ReadonlyMap<string, string> {
  const names = new Map<string, string>()
  for (const key of sessionKeys) {
    const agent = agentOfSessionKey(key)
    const contextId = contextOfSessionKey(key)
    if (agent === undefined || contextId === undefined) continue
    if (sessionKeyOf(agent, contextId) !== key) continue
    names.set(
      partitionPath(residentMemoryScope({ agent, contextId })),
      `${agent} / ${contextId}`,
    )
  }
  return names
}

function partitionName(
  scope: WorkingScope,
  names: ReadonlyMap<string, string>,
): string {
  return (
    names.get(partitionPath(scope)) ??
    `${segmentLabel(scope.projectKey)} / ${segmentLabel(scope.taskId)}`
  )
}

interface PartitionState {
  readonly live: number
  readonly mode: 'full' | 'ranked'
  readonly injected: number
}

function partitionState(
  store: FileMemoryStore,
  scope: WorkingScope,
): PartitionState {
  const result = recall(store, {
    scope: {
      layers: ['working'],
      projectKey: scope.projectKey,
      taskId: scope.taskId,
    },
  })
  return {
    live: result.candidateCount,
    mode: result.mode,
    injected: result.entries.length,
  }
}

function describeMode(state: PartitionState): string {
  return state.mode === 'full'
    ? 'mode full: every live entry is injected into each turn'
    : `mode ranked: ${state.injected} of ${state.live} live entries fit the per-turn ` +
        `budget (${INJECTION_BUDGET.maxEntries} entries / ` +
        `${INJECTION_BUDGET.maxChars} characters)`
}

function entryStatus(entry: MemoryEntry, asOf: string): string {
  if (entry.retirement !== null) return entry.retirement.kind
  if (isRecallable(entry, asOf)) return 'live'
  if (entry.validAt > asOf) return 'not yet valid'
  return 'invalidated'
}

// ---------------------------------------------------------------------------
// Commands

function runAdd(args: readonly string[]): void {
  const target: TargetFlags = {}
  let title: string | undefined
  let summary: string | undefined
  let body: string | undefined
  let bodyFile: string | undefined
  const tags: string[] = []
  let validAt: Date | undefined
  let invalidAt: Date | undefined

  for (let index = 0; index < args.length; index++) {
    const targetNext = readTargetFlag(args, index, target)
    if (targetNext >= 0) {
      index = targetNext
      continue
    }
    const arg = args[index]
    const take = (name: string): string => {
      const parsed = residentOptionValue(args, index, name)
      index = parsed.next
      return parsed.value
    }
    if (arg === '--title' || arg?.startsWith('--title='))
      title = take('--title')
    else if (arg === '--summary' || arg?.startsWith('--summary='))
      summary = take('--summary')
    else if (arg === '--body' || arg?.startsWith('--body='))
      body = take('--body')
    else if (arg === '--body-file' || arg?.startsWith('--body-file='))
      bodyFile = take('--body-file')
    else if (arg === '--tag' || arg?.startsWith('--tag='))
      tags.push(take('--tag'))
    else if (arg === '--valid-at' || arg?.startsWith('--valid-at='))
      validAt = parseTime('--valid-at', take('--valid-at'))
    else if (arg === '--invalid-at' || arg?.startsWith('--invalid-at='))
      invalidAt = parseTime('--invalid-at', take('--invalid-at'))
    else unknownOption('add', arg)
  }

  const where = requireTarget('add', target)
  if (title === undefined) throw new Error('memory add needs --title')
  if (body !== undefined && bodyFile !== undefined) {
    throw new Error('memory add takes --body or --body-file, not both')
  }
  const text =
    bodyFile === undefined
      ? (body ?? '')
      : readFileSync(bodyFile === '-' ? 0 : bodyFile, 'utf8')
  if (text.length > INJECTION_BUDGET.maxChars) {
    throw new Error(
      `the body is ${text.length} characters, more than the whole per-turn ` +
        `memory budget (${INJECTION_BUDGET.maxChars}); split it into smaller entries`,
    )
  }

  const store = assertWritableFor(where.agent)
  const source = operatorSource()
  const entry = writeResidentMemory(store, {
    ...where,
    title,
    summary: summary ?? title,
    body: text,
    source,
    ...(tags.length === 0 ? {} : { tags }),
    ...(validAt === undefined ? {} : { validAt }),
    ...(invalidAt === undefined ? {} : { invalidAt }),
  })
  const scope = residentMemoryScope(where)
  const state = partitionState(store, scope)
  process.stdout.write(
    `Wrote ${entry.id} to ${line(where.agent)} / ${line(where.contextId)}\n` +
      `  partition  ${partitionPath(scope)}\n` +
      `  source     ${line(`${entry.source.kind}:${entry.source.id}`)}\n` +
      `  written    ${entry.createdAt}\n` +
      `  root       ${line(store.root)}\n` +
      `This partition now holds ${count(state.live, 'live entry', 'live entries')}; ` +
      `${describeMode(state)}.\n`,
  )
}

function runList(args: readonly string[]): void {
  const target: TargetFlags = {}
  let all = false
  let full = false
  for (let index = 0; index < args.length; index++) {
    const targetNext = readTargetFlag(args, index, target)
    if (targetNext >= 0) {
      index = targetNext
      continue
    }
    const arg = args[index]
    if (arg === '--all') all = true
    else if (arg === '--full') full = true
    else unknownOption('list', arg)
  }
  if (target.context !== undefined && target.agent === undefined) {
    throw new Error('memory list --context needs --agent')
  }

  let sessionKeys: readonly string[] = []
  const warnings: string[] = []
  try {
    sessionKeys = residentSessionKeys()
  } catch (error) {
    warnings.push(
      `partition names are unavailable: ${
        error instanceof Error ? error.message : String(error)
      } (${residentSessionsPath()})`,
    )
  }
  const names = partitionNames(sessionKeys)

  const store = openStore()
  const only =
    target.agent === undefined
      ? undefined
      : residentMemoryScope({
          agent: target.agent,
          contextId: target.context ?? DEFAULT_CONTEXT,
        })
  const entries = store.query({
    layers: ['working'],
    includeRetired: true,
    ...(only === undefined ? {} : { projectKey: only.projectKey }),
    ...(only === undefined || target.context === undefined
      ? {}
      : { taskId: only.taskId }),
  })
  for (const event of store.events.all()) {
    warnings.push(`${event.type}: ${line(String(event.detail.path ?? ''))}`)
  }

  const partitions = new Map<
    string,
    { scope: WorkingScope; entries: MemoryEntry[] }
  >()
  if (only !== undefined && target.context !== undefined) {
    partitions.set(partitionPath(only), { scope: only, entries: [] })
  }
  for (const entry of entries) {
    if (entry.scope.layer !== 'working') continue
    const key = partitionPath(entry.scope)
    const bucket = partitions.get(key) ?? { scope: entry.scope, entries: [] }
    bucket.entries.push(entry)
    partitions.set(key, bucket)
  }

  const asOf = new Date().toISOString()
  const out: string[] = [`Memory root ${line(store.root)}`]
  const ordered = [...partitions.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  let liveTotal = 0
  const blocks: string[] = []
  for (const [key, { scope, entries: inPartition }] of ordered) {
    const state = partitionState(store, scope)
    liveTotal += state.live
    const shown = inPartition.filter(
      entry => all || entryStatus(entry, asOf) === 'live',
    )
    const block = [
      '',
      `${line(partitionName(scope, names))}  (${key})`,
      `  ${state.live} live, ${inPartition.length - state.live} not live; ` +
        describeMode(state),
    ]
    for (const entry of shown) {
      const status = entryStatus(entry, asOf)
      block.push(
        `  ${entry.id}  ${entry.createdAt}  ` +
          `${line(`${entry.source.kind}:${entry.source.id}`)}  ` +
          `${status === 'live' ? '' : `[${status}] `}${line(entry.title)}`,
      )
      if (full) {
        block.push(
          `      summary  ${line(entry.summary)}`,
          `      tags     ${entry.tags.length === 0 ? '(none)' : line(entry.tags.join(', '))}`,
          `      valid    ${entry.validAt} .. ${entry.invalidAt ?? '(open)'}`,
        )
        if (entry.retirement !== null) {
          block.push(
            `      ${entry.retirement.kind}  ${entry.expiredAt ?? ''} by ` +
              `${line(entry.retirement.by)}: ${line(entry.retirement.reason)}`,
          )
        }
        block.push('      body')
        for (const bodyLine of printable(entry.body.trimEnd(), true).split(
          '\n',
        )) {
          block.push(`        ${bodyLine}`)
        }
      }
    }
    blocks.push(block.join('\n'))
  }
  out.push(
    `${count(partitions.size, 'partition', 'partitions')}, ` +
      count(liveTotal, 'live entry', 'live entries'),
  )
  process.stdout.write(`${[...out, ...blocks].join('\n')}\n`)
  if (warnings.length > 0) {
    process.stderr.write(
      warnings.map(warning => `warning: ${warning}\n`).join(''),
    )
    process.exitCode = 1
  }
}

function runRevoke(args: readonly string[]): void {
  const { id, rest } = splitId('revoke', args)
  const target: TargetFlags = {}
  let reason: string | undefined
  for (let index = 0; index < rest.length; index++) {
    const targetNext = readTargetFlag(rest, index, target)
    if (targetNext >= 0) {
      index = targetNext
      continue
    }
    const arg = rest[index]
    if (arg === '--reason' || arg?.startsWith('--reason=')) {
      const parsed = residentOptionValue(rest, index, '--reason')
      reason = parsed.value
      index = parsed.next
    } else unknownOption('revoke', arg)
  }
  const where = requireTarget('revoke', target)
  if (reason === undefined || reason.trim().length === 0) {
    throw new Error(
      'memory revoke needs --reason: it is recorded with the entry',
    )
  }

  const store = assertWritableFor(where.agent)
  const source = operatorSource()
  const revoked = revokeResidentMemory(store, {
    ...where,
    id,
    reason,
    by: source.id,
  })
  process.stdout.write(
    `Revoked ${revoked.id} (${line(where.agent)} / ${line(where.contextId)}) ` +
      `at ${revoked.expiredAt ?? ''}: it is no longer recalled at any point ` +
      'in time and stays on disk for audit.\n',
  )
}

function runInvalidate(args: readonly string[]): void {
  const { id, rest } = splitId('invalidate', args)
  const target: TargetFlags = {}
  let at: Date | undefined
  for (let index = 0; index < rest.length; index++) {
    const targetNext = readTargetFlag(rest, index, target)
    if (targetNext >= 0) {
      index = targetNext
      continue
    }
    const arg = rest[index]
    if (arg === '--at' || arg?.startsWith('--at=')) {
      const parsed = residentOptionValue(rest, index, '--at')
      at = parseTime('--at', parsed.value)
      index = parsed.next
    } else unknownOption('invalidate', arg)
  }
  const where = requireTarget('invalidate', target)

  const store = assertWritableFor(where.agent)
  const invalidated = invalidateResidentMemory(store, {
    ...where,
    id,
    ...(at === undefined ? {} : { at }),
  })
  process.stdout.write(
    `Invalidated ${invalidated.id} (${line(where.agent)} / ` +
      `${line(where.contextId)}) as of ${invalidated.invalidAt ?? ''}: turns ` +
      'from then on do not recall it; earlier points in time still do.\n',
  )
}

/** Entry point. Errors become one line on stderr plus exit 1, never a stack. */
export function runQianmoMemory(args: readonly string[]): void {
  if (args.length === 0 || isHelpRequest(args)) {
    process.stdout.write(QIANMO_MEMORY_HELP_TEXT)
    return
  }
  const [command, ...rest] = args
  try {
    switch (command) {
      case 'add':
        runAdd(rest)
        return
      case 'list':
        runList(rest)
        return
      case 'revoke':
        runRevoke(rest)
        return
      case 'invalidate':
        runInvalidate(rest)
        return
      default:
        throw new Error(
          `unknown memory command ${String(command)} ` +
            '(expected add, list, revoke or invalidate)',
        )
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(
      `${invokedBinName()} memory ${line(String(command))}: ${line(message)}\n`,
    )
    process.exitCode = 1
  }
}
