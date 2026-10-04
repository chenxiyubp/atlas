// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The fixed corpus behind the C_tool ask snapshot (design
 * `authorization-m1.md` §1.1, P14.2).
 *
 * C_tool is "every call the base pipeline answers `ask` for, under the
 * **carried** posture (`acceptEdits`), empty rules, no hooks". There is no way
 * to enumerate that set from the code without re-implementing the pipeline, so
 * the corpus enumerates *calls*: at least one per tool the resident model is
 * offered (review F-26), one per deferred tool reachable through
 * `ExecuteExtraTool`, and for every tool with a path or command argument the
 * inside/outside-the-workspace split that decides it. Each call is run once in
 * a real `--acp` child with a host that refuses everything, and what happened
 * to it is the snapshot entry.
 *
 * `effect` is a human judgement recorded next to each call — what the call
 * would change if it ran. It never feeds the verdict; it exists so that an
 * `allowed` verdict on a call with a side effect is visible as such (the D-7
 * reconsideration trigger, see the snapshot test).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUTHZ_LEDGER_FILE } from '@qianmo/resident'
import type {
  HostPolicy,
  ScriptedCall,
  ScriptedStep,
} from './resident-acp-harness.js'

/** What a call would change if the node let it run. */
export type ProbeEffect =
  /** Reads, lookups, in-process bookkeeping. */
  | 'none'
  /** Writes inside the agent's own workspace. */
  | 'workspace'
  /** Writes anywhere else on the node's filesystem. */
  | 'filesystem'
  /** Traffic leaving the process for another host. */
  | 'network'
  /** Starts work that outlives the call: a subagent, a background process. */
  | 'process'
  /** A message to the node's operator. */
  | 'operator'

/** The paths and endpoints a probe may name. */
export interface ProbeContext {
  /** The agent's workspace (the session cwd). */
  readonly workspace: string
  /** A directory outside the workspace, with `secret.txt` in it. */
  readonly outside: string
  /** The child's identity config root (`OCC_CONFIG_DIR`). */
  readonly config: string
  /**
   * A second node's config root on the same host, holding a console identity
   * key — the co-located layout review F-25 / E-6 measured.
   */
  readonly consoleConfig: string
  /** A loopback URL nothing sensitive listens on (the model double). */
  readonly loopbackUrl: string
  /** The node's default memory store (`defaultMemoryRoot()` in the child). */
  readonly memory: string
}

export interface AskProbe {
  /** Stable key in the snapshot. */
  readonly id: string
  /** The tool under probe, as the model names it. */
  readonly tool: string
  /** Set when the call reaches `tool` through another tool. */
  readonly via?: 'ExecuteExtraTool'
  readonly effect: ProbeEffect
  /** One line: what this call is here to pin. */
  readonly note: string
  /** The scripted calls; the **last** one is the probe. */
  readonly steps: (ctx: ProbeContext) => readonly ScriptedStep[]
  /** Defaults to refusing every request. */
  readonly hostPolicy?: HostPolicy
}

/** A throwaway node layout: config root, workspace, outside dir, peer root. */
export function plantAskFixture(loopbackUrl: (port: number) => string): {
  readonly root: string
  readonly config: string
  readonly workspace: string
  context(port: number): ProbeContext
} {
  const root = mkdtempSync(join(tmpdir(), 'qm-ask-'))
  // `nodes/<name>/config`, like the fleet: a config root whose path carries no
  // `.occ` / `.qianmo` segment, so only the lexical rules and `stateRoots`
  // protect it — the layout F-25 was measured on.
  const config = join(root, 'nodes', 'beta-4', 'config')
  const consoleConfig = join(root, 'nodes', 'console', 'config')
  const workspace = join(root, 'workspaces', 'beta-4', 'main')
  const outside = join(root, 'outside')
  const memory = join(config, 'memory')
  mkdirSync(join(config, 'qianmo', 'identity'), { recursive: true })
  mkdirSync(join(memory, 'working', 'main'), { recursive: true })
  writeFileSync(join(memory, 'working', 'main', 'entry.md'), 'remembered\n')
  mkdirSync(join(config, 'resident'), { recursive: true })
  mkdirSync(join(consoleConfig, 'qianmo', 'identity'), { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(config, 'qianmo', 'identity', 'beta-4.json'), '{}\n')
  writeFileSync(
    join(consoleConfig, 'qianmo', 'identity', 'console.json'),
    '{"key":"console-private-key-material"}\n',
  )
  writeFileSync(join(config, 'resident', AUTHZ_LEDGER_FILE), '')
  writeFileSync(join(outside, 'secret.txt'), 'outside\n')
  writeFileSync(join(workspace, 'note.txt'), 'alpha\n')
  writeFileSync(join(workspace, 'draft.md'), '# draft\n')
  writeFileSync(
    join(workspace, 'nb.ipynb'),
    JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          id: 'c1',
          metadata: {},
          source: ['print(1)'],
          outputs: [],
          execution_count: null,
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }),
  )
  writeFileSync(
    join(outside, 'nb.ipynb'),
    '{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}',
  )
  return {
    root,
    config,
    workspace,
    context: port => ({
      workspace,
      outside,
      config,
      consoleConfig,
      loopbackUrl: loopbackUrl(port),
      memory,
    }),
  }
}

const call = (name: string, input: Record<string, unknown>): ScriptedCall => ({
  name,
  input,
})

const bash = (command: string): ScriptedCall =>
  call('Bash', { command, description: 'probe' })

/** Discover, then call, a deferred tool — the only route the base offers. */
const viaExecute =
  (target: string, params: Record<string, unknown>) =>
  (): readonly ScriptedCall[] => [
    call('SearchExtraTools', { query: `select:${target}`, max_results: 1 }),
    call('ExecuteExtraTool', { tool_name: target, params }),
  ]

/** Approves reads only — the precondition an edit tool insists on. */
const approveReadsOnly: HostPolicy = request =>
  (request as { toolCall?: { kind?: unknown } }).toolCall?.kind === 'read'

/** The id a backgrounded command reports, for a later call to name. */
function backgroundTaskId(results: readonly string[]): string {
  const match = /with ID: ([\w-]+)/.exec(results.at(-1) ?? '')
  return match?.[1] ?? 'no-background-task'
}

/**
 * Approves the outer `ExecuteExtraTool` request only. Used where the inner
 * tool's own verdict is the thing being pinned (E-5: the inner ask is not
 * surfaced a second time).
 */
export const approveExecuteOnly: HostPolicy = request =>
  JSON.stringify(
    (request as { toolCall?: { rawInput?: unknown } }).toolCall?.rawInput ?? {},
  ).includes('"tool_name"')

export const ASK_CORPUS: readonly AskProbe[] = [
  // ── Agent / tasks ──
  {
    id: 'agent-general',
    tool: 'Agent',
    effect: 'process',
    note: 'spawning a subagent',
    steps: () => [
      call('Agent', {
        description: 'probe',
        prompt: 'say hello',
        subagent_type: 'general-purpose',
      }),
    ],
  },
  {
    id: 'task-output',
    tool: 'TaskOutput',
    effect: 'none',
    note: "reading the turn's own background task",
    steps: () => [
      call('Bash', {
        command: 'sleep 2',
        description: 'probe',
        run_in_background: true,
      }),
      results =>
        call('TaskOutput', {
          task_id: backgroundTaskId(results),
          block: false,
          timeout: 1,
        }),
    ],
  },
  {
    id: 'task-stop',
    tool: 'TaskStop',
    effect: 'process',
    note: "stopping the turn's own background task",
    steps: () => [
      call('Bash', {
        command: 'sleep 30',
        description: 'probe',
        run_in_background: true,
      }),
      results => call('TaskStop', { task_id: backgroundTaskId(results) }),
    ],
  },

  // ── Bash ──
  {
    id: 'bash-read-workspace',
    tool: 'Bash',
    effect: 'none',
    note: 'read-only command in the workspace',
    steps: () => [bash('ls')],
  },
  {
    id: 'bash-read-outside',
    tool: 'Bash',
    effect: 'none',
    note: 'read-only command naming a file outside the workspace',
    steps: ctx => [bash(`cat ${join(ctx.outside, 'secret.txt')}`)],
  },
  {
    id: 'bash-touch-workspace',
    tool: 'Bash',
    effect: 'workspace',
    note: 'filesystem write inside the workspace',
    steps: ctx => [bash(`touch ${join(ctx.workspace, 'touched.txt')}`)],
  },
  {
    id: 'bash-rm-workspace',
    tool: 'Bash',
    effect: 'workspace',
    note: 'filesystem delete inside the workspace',
    steps: ctx => [bash(`rm -f ${join(ctx.workspace, 'draft.md')}`)],
  },
  {
    id: 'bash-redirect-workspace',
    tool: 'Bash',
    effect: 'workspace',
    note: 'shell redirection writing inside the workspace',
    steps: ctx => [bash(`echo x > ${join(ctx.workspace, 'redirect.txt')}`)],
  },
  {
    id: 'bash-touch-outside',
    tool: 'Bash',
    effect: 'filesystem',
    note: 'filesystem write outside the workspace (P14.2 DoD 1)',
    steps: ctx => [bash(`touch ${join(ctx.outside, 'touched.txt')}`)],
  },
  {
    id: 'bash-network',
    tool: 'Bash',
    effect: 'network',
    note: 'outbound request from the shell',
    steps: ctx => [bash(`curl -s ${ctx.loopbackUrl}`)],
  },
  {
    id: 'bash-background',
    tool: 'Bash',
    effect: 'process',
    note: 'background process from the shell',
    steps: () => [
      call('Bash', {
        command: 'sleep 1',
        description: 'probe',
        run_in_background: true,
      }),
    ],
  },
  {
    id: 'bash-git-init',
    tool: 'Bash',
    effect: 'workspace',
    note: 'version-control mutation inside the workspace',
    steps: () => [bash('git init -q')],
  },

  // ── Search ──
  {
    id: 'glob-workspace',
    tool: 'Glob',
    effect: 'none',
    note: 'listing inside the workspace',
    steps: () => [call('Glob', { pattern: '*' })],
  },
  {
    id: 'glob-outside',
    tool: 'Glob',
    effect: 'none',
    note: 'listing outside the workspace',
    steps: ctx => [call('Glob', { pattern: '*', path: ctx.outside })],
  },
  {
    id: 'grep-workspace',
    tool: 'Grep',
    effect: 'none',
    note: 'search inside the workspace',
    steps: () => [call('Grep', { pattern: 'alpha' })],
  },
  {
    id: 'grep-outside',
    tool: 'Grep',
    effect: 'none',
    note: 'search outside the workspace',
    steps: ctx => [call('Grep', { pattern: 'outside', path: ctx.outside })],
  },

  // ── File tools ──
  {
    id: 'read-workspace',
    tool: 'Read',
    effect: 'none',
    note: 'read inside the workspace',
    steps: ctx => [
      call('Read', { file_path: join(ctx.workspace, 'note.txt') }),
    ],
  },
  {
    id: 'read-outside',
    tool: 'Read',
    effect: 'none',
    note: 'read outside the workspace',
    steps: ctx => [
      call('Read', { file_path: join(ctx.outside, 'secret.txt') }),
    ],
  },
  {
    id: 'write-workspace',
    tool: 'Write',
    effect: 'workspace',
    note: 'new file inside the workspace',
    steps: ctx => [
      call('Write', {
        file_path: join(ctx.workspace, 'written.txt'),
        content: 'x\n',
      }),
    ],
  },
  {
    id: 'write-outside',
    tool: 'Write',
    effect: 'filesystem',
    note: 'new file outside the workspace',
    steps: ctx => [
      call('Write', {
        file_path: join(ctx.outside, 'written.txt'),
        content: 'x\n',
      }),
    ],
  },
  {
    id: 'edit-workspace',
    tool: 'Edit',
    effect: 'workspace',
    note: 'edit inside the workspace (after the read the tool requires)',
    steps: ctx => [
      call('Read', { file_path: join(ctx.workspace, 'note.txt') }),
      call('Edit', {
        file_path: join(ctx.workspace, 'note.txt'),
        old_string: 'alpha',
        new_string: 'beta',
      }),
    ],
  },
  {
    id: 'edit-outside',
    tool: 'Edit',
    effect: 'filesystem',
    note: 'edit outside the workspace (host approves the prerequisite read)',
    hostPolicy: approveReadsOnly,
    steps: ctx => [
      call('Read', { file_path: join(ctx.outside, 'secret.txt') }),
      call('Edit', {
        file_path: join(ctx.outside, 'secret.txt'),
        old_string: 'outside',
        new_string: 'changed',
      }),
    ],
  },
  {
    id: 'notebook-edit-workspace',
    tool: 'NotebookEdit',
    effect: 'workspace',
    note: 'notebook cell edit inside the workspace',
    steps: ctx => [
      call('Read', { file_path: join(ctx.workspace, 'nb.ipynb') }),
      call('NotebookEdit', {
        notebook_path: join(ctx.workspace, 'nb.ipynb'),
        cell_id: 'c1',
        new_source: 'print(2)',
      }),
    ],
  },
  {
    id: 'notebook-edit-outside',
    tool: 'NotebookEdit',
    effect: 'filesystem',
    note: 'notebook edit outside the workspace (host approves the prerequisite read)',
    hostPolicy: approveReadsOnly,
    steps: ctx => [
      call('Read', { file_path: join(ctx.outside, 'nb.ipynb') }),
      call('NotebookEdit', {
        notebook_path: join(ctx.outside, 'nb.ipynb'),
        new_source: 'print(3)',
        cell_type: 'code',
        edit_mode: 'insert',
      }),
    ],
  },

  // ── Network ──
  {
    id: 'web-fetch-loopback',
    tool: 'WebFetch',
    effect: 'network',
    note: 'fetch from a host outside the preapproved list',
    steps: ctx => [
      call('WebFetch', { url: `${ctx.loopbackUrl}probe`, prompt: 'summary' }),
    ],
  },
  {
    id: 'web-fetch-preapproved',
    tool: 'WebFetch',
    effect: 'network',
    note: 'fetch from a preapproved documentation host (egress blocked by the harness proxy)',
    steps: () => [
      call('WebFetch', {
        url: 'https://docs.python.org/3/?q=probe',
        prompt: 'summary',
      }),
    ],
  },
  {
    id: 'web-search',
    tool: 'WebSearch',
    effect: 'network',
    note: 'web search',
    steps: () => [call('WebSearch', { query: 'probe' })],
  },

  // ── Session bookkeeping and conversation ──
  {
    id: 'todo-write',
    tool: 'TodoWrite',
    effect: 'none',
    note: 'todo list (session state)',
    steps: () => [
      call('TodoWrite', {
        todos: [{ content: 'probe', status: 'pending', activeForm: 'Probing' }],
      }),
    ],
  },
  {
    id: 'ask-user-question',
    tool: 'AskUserQuestion',
    effect: 'none',
    note: 'question to a user a headless node does not have',
    steps: () => [
      call('AskUserQuestion', {
        questions: [
          {
            question: 'Which one?',
            header: 'Choice',
            options: [
              { label: 'A', description: 'first' },
              { label: 'B', description: 'second' },
            ],
            multiSelect: false,
          },
        ],
      }),
    ],
  },
  {
    id: 'skill-unknown',
    tool: 'Skill',
    effect: 'process',
    note: 'invoking a skill (none are loadable under safe mode)',
    steps: () => [call('Skill', { skill: 'no-such-skill' })],
  },
  {
    id: 'send-message',
    tool: 'SendMessage',
    effect: 'filesystem',
    note: 'message to a teammate: a mailbox file under <config>/teams/',
    steps: () => [
      call('SendMessage', { to: 'nobody', summary: 'probe', message: 'hi' }),
    ],
  },
  {
    id: 'workflow-inline',
    tool: 'Workflow',
    effect: 'process',
    note: 'running an inline workflow script',
    steps: () => [
      call('Workflow', {
        operation: 'run',
        script: 'export default async function () { return 1 }',
        description: 'probe',
      }),
    ],
  },
  {
    id: 'search-extra-tools',
    tool: 'SearchExtraTools',
    effect: 'none',
    note: 'deferred-tool discovery',
    steps: () => [
      call('SearchExtraTools', { query: 'select:Monitor', max_results: 1 }),
    ],
  },
  {
    id: 'qianmo-notify',
    tool: 'qianmo_notify',
    effect: 'operator',
    note: 'notification to the operator channel',
    steps: () => [
      call('qianmo_notify', {
        kind: 'health',
        severity: 'info',
        summary: 'probe',
      }),
    ],
  },

  // ── Removed from the resident surface by P14.0 (review F-26 still lists two) ──
  {
    id: 'enter-plan-mode',
    tool: 'EnterPlanMode',
    effect: 'none',
    note: 'E-1 entry point; must not be callable',
    steps: () => [call('EnterPlanMode', {})],
  },
  {
    id: 'exit-plan-mode',
    tool: 'ExitPlanMode',
    effect: 'none',
    note: 'mode-switch prompt (F-9); must not be callable',
    steps: () => [call('ExitPlanMode', { plan: 'probe' })],
  },
  {
    id: 'execute-cron-create',
    tool: 'CronCreate',
    via: 'ExecuteExtraTool',
    effect: 'process',
    note: 'scheduler through the indirect route, host approving the outer call',
    steps: viaExecute('CronCreate', {
      cron: '* * * * *',
      prompt: 'probe',
      recurring: true,
    }),
    hostPolicy: approveExecuteOnly,
  },
  {
    id: 'execute-enter-plan-mode',
    tool: 'EnterPlanMode',
    via: 'ExecuteExtraTool',
    effect: 'none',
    note: 'E-1 through the indirect route, host approving the outer call',
    steps: viaExecute('EnterPlanMode', {}),
    hostPolicy: approveExecuteOnly,
  },

  // ── Deferred tools, through ExecuteExtraTool (host refuses the outer call) ──
  {
    id: 'execute-discover-skills',
    tool: 'DiscoverSkills',
    via: 'ExecuteExtraTool',
    effect: 'none',
    note: 'deferred: skill discovery',
    steps: viaExecute('DiscoverSkills', { description: 'probe' }),
  },
  {
    id: 'execute-enter-worktree',
    tool: 'EnterWorktree',
    via: 'ExecuteExtraTool',
    effect: 'workspace',
    note: 'deferred: create a git worktree and move into it',
    steps: viaExecute('EnterWorktree', { name: 'probe' }),
  },
  {
    id: 'execute-exit-worktree',
    tool: 'ExitWorktree',
    via: 'ExecuteExtraTool',
    effect: 'workspace',
    note: 'deferred: leave (and optionally delete) a worktree',
    steps: viaExecute('ExitWorktree', { action: 'keep' }),
  },
  {
    id: 'execute-goal',
    tool: 'GoalTool',
    via: 'ExecuteExtraTool',
    effect: 'none',
    note: 'deferred: goal status',
    steps: viaExecute('GoalTool', { action: 'get' }),
  },
  {
    id: 'execute-local-memory-recall',
    tool: 'LocalMemoryRecall',
    via: 'ExecuteExtraTool',
    effect: 'none',
    note: 'deferred: local memory lookup',
    steps: viaExecute('LocalMemoryRecall', { action: 'list_stores' }),
  },
  {
    id: 'execute-monitor-outside',
    tool: 'Monitor',
    via: 'ExecuteExtraTool',
    effect: 'filesystem',
    note: 'deferred: long-running shell monitor writing outside the workspace',
    steps: viaExecute('Monitor', {
      command: 'touch /nonexistent-qianmo-probe/monitor',
      description: 'probe',
    }),
  },
  {
    id: 'execute-refresh-mcp-tools',
    tool: 'RefreshMcpTools',
    via: 'ExecuteExtraTool',
    effect: 'none',
    note: 'deferred: MCP refresh (no servers in a resident session)',
    steps: viaExecute('RefreshMcpTools', {}),
  },
  {
    id: 'execute-vault-http-fetch',
    tool: 'VaultHttpFetch',
    via: 'ExecuteExtraTool',
    effect: 'network',
    note: 'deferred: authenticated HTTP request',
    steps: viaExecute('VaultHttpFetch', {
      url: 'https://example.invalid/',
      method: 'POST',
      vault_auth_key: 'probe',
    }),
  },
  {
    id: 'execute-wait-for-mcp-servers',
    tool: 'WaitForMcpServers',
    via: 'ExecuteExtraTool',
    effect: 'none',
    note: 'deferred: MCP readiness',
    steps: viaExecute('WaitForMcpServers', {}),
  },
  {
    id: 'execute-artifact',
    tool: 'artifact',
    via: 'ExecuteExtraTool',
    effect: 'network',
    note: 'deferred: publish a file as an artifact',
    steps: ctx =>
      viaExecute('artifact', { file_path: join(ctx.workspace, 'draft.md') })(),
  },
  {
    id: 'direct-deferred-monitor',
    tool: 'Monitor',
    effect: 'process',
    note: 'a deferred tool called directly, skipping discovery',
    steps: () => [call('Monitor', { wait_seconds: 1, description: 'probe' })],
  },

  // ── Hardline: refused before any ask (F-10). The E-6 targets (co-located
  //    console key, memory store) are cases of the bypass corpus instead. ──
  {
    id: 'hardline-read-authz-ledger',
    tool: 'Read',
    effect: 'none',
    note: 'P14.3 pending and grant rows under <config>/resident/, file surface',
    steps: ctx => [
      call('Read', {
        file_path: join(ctx.config, 'resident', AUTHZ_LEDGER_FILE),
      }),
    ],
  },
  {
    id: 'hardline-bash-authz-ledger',
    tool: 'Bash',
    effect: 'filesystem',
    note: 'P14.3 pending and grant rows under <config>/resident/, shell surface',
    steps: ctx => [
      bash(`echo '{}' >> ${join(ctx.config, 'resident', AUTHZ_LEDGER_FILE)}`),
    ],
  },
  {
    id: 'hardline-write-config-agent',
    tool: 'Write',
    effect: 'filesystem',
    note: 'agent definition under the config root (TH-9)',
    steps: ctx => [
      call('Write', {
        file_path: join(ctx.config, 'agents', 'esc.md'),
        content: '---\nname: esc\npermissionMode: bypassPermissions\n---\n',
      }),
    ],
  },
]
