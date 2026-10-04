// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The parsing half of `qm watch` — the half a bad jobs file hits.
 *
 * Everything here fires at *registration*, which is the point: a watch job is
 * written once and runs for a week into a channel that is silent by design, so
 * a defect that only surfaces on the fire path surfaces unattended, every
 * period, with nobody reading. The last moment a human is looking is the
 * moment the file is parsed.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  NodeCapabilities,
  NonceStore,
  OPEN_POLICY,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  verifyCapability,
  type ShadowRefusal,
} from '@qianmo/capability'
import {
  CapabilityLevel,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
  newId,
  parseCapabilityToken,
  type NotifyPayload,
} from '@qianmo/protocol'
import { turnStepDedupKey } from '@qianmo/resident'
import { assertJob } from '@qianmo/scheduler'
import { createConsoleWakeIssuer } from '../consoleWakeIdentity.js'
import {
  WATCH_HELP_TEXT,
  buildWatchRequest,
  classifyWatchNotify,
  isWatchHelpRequest,
  loadWatchSigningIdentity,
  parseWatchArgs,
  parseWatchJobs,
  watchSigningNotice,
  type WatchConfig,
} from '../watch.js'

const JOB = {
  id: 'disk-watch',
  title: 'disk every ten minutes',
  target: 'qianmo://beta-1/reviewer',
  url: 'ws://127.0.0.1:38611',
  prompt: 'check / and /var; call qianmo_notify only if either is over 90%',
  schedule: { everyMs: 600_000 },
  taskTtlMs: 900_000,
  notifyPolicy: 'agent-initiated',
}

function jobsFile(...jobs: readonly unknown[]): string {
  return JSON.stringify(jobs)
}

/** The run-mode config, or a failed assertion saying which mode came back. */
function runConfig(args: readonly string[]): WatchConfig {
  const parsed = parseWatchArgs(args, 'qianmo')
  if (parsed.mode !== 'run') throw new Error(`expected run, got ${parsed.mode}`)
  return parsed
}

describe('qm watch argument parsing', () => {
  test('requires both a jobs file and the hub address', () => {
    expect(() => parseWatchArgs([], 'qianmo')).toThrow('requires --jobs')
    expect(() => parseWatchArgs(['--jobs', 'a.json'], 'qianmo')).toThrow(
      'requires --from',
    )
  })

  test('refuses to run under any identity but the node one', () => {
    // The same gate `resident-wake` has, for the same reason: dialling other
    // people's nodes is part of the Qianmo identity, not of plain occ.
    expect(() =>
      parseWatchArgs(
        ['--jobs', 'a.json', '--from', 'qianmo://hub/console'],
        'occ',
      ),
    ).toThrow('OCC_IDENTITY=qianmo')
  })

  test('rejects an address that is not a qianmo address', () => {
    expect(() =>
      parseWatchArgs(['--jobs', 'a.json', '--from', 'hub'], 'qianmo'),
    ).toThrow()
  })

  test('takes both --name value and --name=value, and defaults the state dir', () => {
    const parsed = runConfig([
      '--jobs=a.json',
      '--from',
      'qianmo://hub/console',
    ])
    expect(parsed.jobsPath).toBe('a.json')
    expect(parsed.from).toBe('qianmo://hub/console')
    expect(parsed.once).toBe(false)
    // Derived from the config root rather than spelled — CLAUDE.md's path
    // invariant applies to this command like every other.
    expect(parsed.stateDir).toContain('scheduler')
  })

  test('signing is off unless --sign is given', () => {
    const base = ['--jobs', 'a.json', '--from', 'qianmo://hub/console']
    expect(runConfig(base).sign).toBe(false)
    expect(runConfig([...base, '--sign']).sign).toBe(true)
  })

  test('--print-identity needs only --from and refuses anything that would run jobs', () => {
    expect(
      parseWatchArgs(
        ['--print-identity', '--from', 'qianmo://hub/console'],
        'qianmo',
      ),
    ).toEqual({ mode: 'print-identity', from: 'qianmo://hub/console' })
    expect(() => parseWatchArgs(['--print-identity'], 'qianmo')).toThrow(
      '--print-identity requires --from',
    )
    for (const extra of [
      ['--jobs', 'a.json'],
      ['--sign'],
      ['--once'],
      ['--state-dir', '/tmp/x'],
    ]) {
      expect(() =>
        parseWatchArgs(
          ['--print-identity', '--from', 'qianmo://hub/console', ...extra],
          'qianmo',
        ),
      ).toThrow('--print-identity takes only --from')
    }
  })

  test('points a mistyped option at the help instead of guessing', () => {
    expect(() =>
      parseWatchArgs(
        ['--jobs', 'a.json', '--from', 'qianmo://hub/console', '--evry', '5'],
        'qianmo',
      ),
    ).toThrow('watch --help')
  })

  test('help is recognized anywhere and names every required flag', () => {
    expect(isWatchHelpRequest(['--jobs', 'a.json', '--help'])).toBe(true)
    expect(isWatchHelpRequest(['--jobs', 'a.json'])).toBe(false)
    for (const flag of [
      '--jobs',
      '--from',
      '--state-dir',
      '--once',
      '--sign',
      '--print-identity',
    ]) {
      expect(WATCH_HELP_TEXT).toContain(flag)
    }
    // The order rule and the silence rule are both things an operator gets
    // wrong without being told, so the help says them.
    expect(WATCH_HELP_TEXT).toContain('--trust <node>=<publicKey>')
    expect(WATCH_HELP_TEXT).toContain('watch_step_received')
    // The brake is only useful if it is documented where somebody looks.
    expect(WATCH_HELP_TEXT).toContain('ESTOP')
  })
})

describe('the jobs file', () => {
  test('accepts a well-formed job and keeps its url beside it', () => {
    const [entry] = parseWatchJobs(jobsFile(JOB))
    expect(entry?.job.id).toBe('disk-watch')
    expect(entry?.job.taskTtlMs).toBe(900_000)
    expect(entry?.url).toBe('ws://127.0.0.1:38611')
    // The scheduler never sees the url: it decides *when*, the handler decides
    // *where*, and that boundary is what keeps the package free of a transport.
    expect(entry?.job).not.toHaveProperty('url')
  })

  test('a job with no url is rejected rather than skipped at fire time', () => {
    const { url: _url, ...noUrl } = JOB
    expect(() => parseWatchJobs(jobsFile(noUrl))).toThrow('needs a "url"')
  })

  test('two jobs with one id are refused, because they would share a dedup key', () => {
    // `dedupKey` is `"<jobId>:<fireAtMs>"`. Two jobs under one id firing at the
    // same instant claim the same key, so one of them silently never runs —
    // and "silently" is the part that makes this worth a hard error.
    expect(() =>
      parseWatchJobs(jobsFile(JOB, { ...JOB, title: 'a different job' })),
    ).toThrow('two jobs with id')
  })

  test('an invalid job stops the whole file, not just itself', () => {
    expect(() =>
      parseWatchJobs(jobsFile(JOB, { ...JOB, id: 'other', taskTtlMs: 0 })),
    ).toThrow('taskTtlMs')
    expect(() =>
      parseWatchJobs(jobsFile({ ...JOB, target: 'not-an-address' })),
    ).toThrow()
  })

  test('a file that is not an array says so', () => {
    expect(() => parseWatchJobs(JSON.stringify(JOB))).toThrow('JSON array')
  })
})

const HUB = 'qianmo://hub/console'
const TARGET_NODE = 'beta-1'
const NOW = 1_800_000_000_000

function signedFixture() {
  const keys = generateNodeKeyPair()
  // The console's issuer, reused as-is: the watch face adds no signing code
  // of its own, so testing it here tests what `--sign` actually uses.
  const issue = createConsoleWakeIssuer('hub', keys)
  // What `qm resident --trust hub=<publicKey>` builds: the key in the
  // directory, and the name in the trusted issuers next to the node itself.
  const directory = new StaticPublicKeyDirectory([['hub', keys.publicKey]])
  return { keys, issue, directory }
}

function nodeGate(
  directory: StaticPublicKeyDirectory,
  options: {
    readonly open?: boolean
    readonly onShadowRefusal?: (refusal: ShadowRefusal) => void
  } = {},
): NodeCapabilities {
  return new NodeCapabilities({
    node: TARGET_NODE,
    directory,
    policy: options.open === true ? OPEN_POLICY : SIGNED_TASK_POLICY,
    trustedIssuers: ['hub', TARGET_NODE],
    ...(options.onShadowRefusal === undefined
      ? {}
      : {
          shadowPolicy: SIGNED_TASK_POLICY,
          onShadowRefusal: options.onShadowRefusal,
        }),
  })
}

describe('qm watch --sign: the task.request a fire sends', () => {
  const job = assertJob({ ...JOB, id: 'disk-watch' })

  test('carries a write-limited token bound to this task, and the node verifies it', () => {
    const { keys, issue, directory } = signedFixture()
    const message = buildWatchRequest({ from: HUB, job, issue, now: () => NOW })

    // The envelope is the one §4.1 asks for, signed or not.
    expect(message.contextId).toBe('disk-watch')
    expect(message.taskTtlMs).toBe(900_000)
    expect(message.to).toBe(JOB.target)

    const verified = verifyCapability(message.cap, {
      node: TARGET_NODE,
      handler: message.to,
      taskId: message.taskId,
      now: NOW,
      directory,
      nonces: new NonceStore(),
    })
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.claims).toMatchObject({
      iss: 'hub',
      aud: TARGET_NODE,
      sub: JOB.target,
      act: CapabilityLevel.WriteLimited,
      taskId: message.taskId,
    })
    expect(keys.publicKey).toBe(directory.publicKeyOf('hub') ?? '')
  })

  test('never signs user-confirmed (rule S-1): the level is write-limited, every time', () => {
    const { issue } = signedFixture()
    for (let index = 0; index < 5; index += 1) {
      const message = buildWatchRequest({ from: HUB, job, issue })
      const parsed = parseCapabilityToken(message.cap)
      expect(parsed?.claims.act).toBe(CapabilityLevel.WriteLimited)
    }
    // And the source says so structurally: the watch face names no level at
    // all, so there is no branch that could pick a higher one.
    const source = readFileSync(join(import.meta.dir, '..', 'watch.ts'), 'utf8')
    expect(source).not.toContain('UserConfirmed')
    expect(source).not.toContain("'user-confirmed'")
  })

  test('each fire mints its own task and its own token', () => {
    const { issue } = signedFixture()
    const first = buildWatchRequest({ from: HUB, job, issue })
    const second = buildWatchRequest({ from: HUB, job, issue })
    expect(first.taskId).not.toBe(second.taskId)
    expect(first.cap).not.toBe(second.cap)
  })

  test('the node admits it at the verified tier under the enforcing policy', () => {
    const { issue, directory } = signedFixture()
    const message = buildWatchRequest({ from: HUB, job, issue, now: () => NOW })
    const decision = nodeGate(directory).check(message, NOW)
    expect(decision).toMatchObject({
      ok: true,
      level: CapabilityLevel.WriteLimited,
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
      issuer: 'hub',
    })
  })

  test('signed: no shadow refusal under --open-policy --audit-signed-tasks; unsigned: exactly the one the fleet saw', () => {
    const { issue, directory } = signedFixture()
    const refusals: ShadowRefusal[] = []
    const gate = nodeGate(directory, {
      open: true,
      onShadowRefusal: refusal => refusals.push(refusal),
    })

    const signed = buildWatchRequest({ from: HUB, job, issue, now: () => NOW })
    expect(gate.check(signed, NOW)).toMatchObject({
      ok: true,
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
    })
    expect(refusals).toEqual([])

    // Today's behaviour without --sign, word for word what the fleet survey
    // found in the node's audit trail.
    const unsigned = buildWatchRequest({ from: HUB, job, now: () => NOW })
    expect(unsigned.cap).toBeUndefined()
    expect(gate.check(unsigned, NOW)).toMatchObject({
      ok: true,
      trust: TRUST_UNTRUSTED,
    })
    expect(refusals.map(refusal => refusal.reason)).toEqual([
      'task.request from hub needs write-limited, presented read',
    ])
  })

  test('unsigned under the enforcing policy is refused as insufficient', () => {
    const { directory } = signedFixture()
    const unsigned = buildWatchRequest({ from: HUB, job, now: () => NOW })
    expect(nodeGate(directory).check(unsigned, NOW)).toMatchObject({
      ok: false,
      code: ProtocolErrorCode.E_CAP_INSUFFICIENT,
    })
  })

  test('signing before the node trusts the hub is refused under both policies', () => {
    // The order rule, as the node sees it: a key nobody distributed.
    const { issue } = signedFixture()
    const message = buildWatchRequest({ from: HUB, job, issue, now: () => NOW })
    for (const open of [false, true]) {
      expect(
        nodeGate(new StaticPublicKeyDirectory(), { open }).check(message, NOW),
      ).toMatchObject({
        ok: false,
        code: ProtocolErrorCode.E_CAP_INVALID,
        reason: 'no published public key for issuer hub',
      })
    }
  })

  test('an issuer that cannot sign fails the fire; nothing unsigned goes out', () => {
    expect(() =>
      buildWatchRequest({
        from: HUB,
        job,
        issue: () => {
          throw new Error('identity unreadable')
        },
      }),
    ).toThrow('identity unreadable')
  })
})

describe('qm watch startup: signed or loudly not', () => {
  let root: string | undefined
  let previous: string | undefined

  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    previous = undefined
    if (root !== undefined) rmSync(root, { recursive: true, force: true })
    root = undefined
  })

  test('unsigned: a warning on stderr naming both failures and the fix', () => {
    const notice = watchSigningNotice(undefined, HUB)
    expect(notice.stdout).toBeUndefined()
    const warning = notice.stderr ?? ''
    for (const part of [
      'NOT signed',
      'E_CAP_INSUFFICIENT',
      '--open-policy',
      'untrusted',
      `watch --print-identity --from ${HUB}`,
      '--trust <node>=<publicKey>',
      '--sign',
    ]) {
      expect(warning).toContain(part)
    }
  })

  test('signed: one stdout line that is exactly what --trust takes', () => {
    const notice = watchSigningNotice({ node: 'hub', publicKey: 'PK' }, HUB)
    expect(notice.stderr).toBeUndefined()
    expect(notice.stdout).toBe(
      '[watch] signing task requests as hub=PK (write-limited)',
    )
  })

  test('the identity is the --from node key under the config root, created once and reused', () => {
    root = mkdtempSync(join(tmpdir(), 'qianmo-watch-identity-'))
    previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = root
    const keyFile = join(root, 'qianmo', 'identity', 'hub.json')
    expect(existsSync(keyFile)).toBe(false)

    const first = loadWatchSigningIdentity(HUB)
    expect(first.node).toBe('hub')
    expect(existsSync(keyFile)).toBe(true)
    const second = loadWatchSigningIdentity(HUB)
    expect(second.publicKey).toBe(first.publicKey)

    // The token it signs verifies against the key it reports.
    const message = buildWatchRequest({
      from: HUB,
      job: assertJob({ ...JOB }),
      issue: first.issue,
      now: () => NOW,
    })
    const decision = nodeGate(
      new StaticPublicKeyDirectory([['hub', first.publicKey]]),
    ).check(message, NOW)
    expect(decision).toMatchObject({
      ok: true,
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
    })
  })
})

describe('what reaches a person: only what the agent sent itself', () => {
  function payload(overrides: Partial<NotifyPayload>): NotifyPayload {
    return {
      kind: 'task',
      severity: 'info',
      summary: 'x',
      observedAt: NOW,
      ...overrides,
    }
  }

  test('a tool step the node raised is process data, including a failure', () => {
    // The key comes from the builder the node uses, not from a hand-written
    // string, so a change to the node's format fails here.
    const requestMsgId = newId()
    for (const phase of ['start', 'failed'] as const) {
      expect(
        classifyWatchNotify(
          payload({
            severity: phase === 'failed' ? 'warn' : 'info',
            dedupKey: turnStepDedupKey(requestMsgId, 'call_1', phase),
            causeTaskId: newId(),
          }),
        ),
      ).toBe('step')
    }
  })

  test('an alert the agent sent is for a person, whatever key it chose', () => {
    const stepShaped = turnStepDedupKey(newId(), 'call_1', 'start')
    for (const shape of [
      // kind=watch is never a step, even with a step-shaped key.
      { kind: 'watch' as const, dedupKey: stepShaped },
      { kind: 'watch' as const, dedupKey: '/' },
      { kind: 'health' as const },
      // An agent may pick kind=task too; its own keys do not look like steps.
      { kind: 'task' as const },
      { kind: 'task' as const, dedupKey: 'disk:/' },
      { kind: 'task' as const, dedupKey: 'backup:nightly:failed' },
    ]) {
      expect(classifyWatchNotify(payload(shape))).toBe('notification')
    }
  })
})
