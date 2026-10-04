// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 多 agent 维度 —— issue #44 的验收面。
 *
 * **写这几条时它是红的，并且应该是红的。** 基线 `origin/s4/p11-console` 上
 * 一个 `resident` 配两个 `--agent`、先给 A 投一轮再给 B 投一轮之后：
 *
 *   · 两个 session 的 transcript 落进**同一个**文件；
 *   · 那个文件所在的 project 目录按一个 agent 的工作区命名，文件里每行的
 *     `cwd` 却是**另一个** agent 的工作区；
 *   · 发给模型的 system prompt 里 `Primary working directory:` 只会出现第一个
 *     跑起来的 agent 的目录。
 *
 * 根因不在参数解析（`--agent name=cwd` 一路传到 `session/new` 都是对的），
 * 而在 `STATE` 里三个进程级单例：`originalCwd`、system-prompt 段缓存、
 * transcript 文件指针 —— 没有任何 ACP 路径在换 session 时重建它们。
 *
 * 断言写成「每个 agent 的 session 必须落在自己工作区的 project 目录下、且
 * 文件里的 cwd 就是自己的工作区」，因为那是**修好之后必然成立**的形态，
 * 而不是围着当前 bug 的形状写。
 */

import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { sendEnvelope } from '../local/send.js'
import { startStubUpstream, workingDirectoriesSeen } from '../local/upstream.js'
import {
  delay,
  readMailbox,
  readTranscripts,
  sessionIdsByAgent,
  waitForTurn,
} from '../observe.js'
import type { Scenario, ScenarioContext } from '../types.js'
import {
  NODE,
  SENDER,
  SENDER_NODE,
  TEAM,
  newParty,
  startNodeTrusting,
  upstreamEnv,
} from './fixtures.js'

const AGENT_A = 'alpha'
const AGENT_B = 'bravo'

/** `sanitizePath`：非字母数字一律换 `-`（与基座的 project 目录命名同形）。 */
function projectDirNameOf(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * 起一个双 agent 节点，**先给 A 投一轮、再给 B 投一轮**。
 *
 * 顺序是判据的一部分：issue #44 的触发条件正是「向**非首个** agent 发任务」，
 * 只投一个 agent 的话第二个 agent 的 cwd 恰好会是对的，测了等于没测。
 */
async function twoAgentRun(ctx: ScenarioContext) {
  const upstream = startStubUpstream({ behavior: 'ok' })
  ctx.cleanup(() => upstream.stop())
  const node = await startNodeTrusting(ctx, newParty(), {
    policy: 'open',
    agents: [AGENT_A, AGENT_B],
    env: upstreamEnv(upstream.baseUrl),
  })
  const workspaces = node.spec.agents

  for (const agent of [AGENT_A, AGENT_B]) {
    await sendEnvelope({
      url: node.endpoint,
      psk: ACCEPTANCE_PSK,
      fromNode: SENDER_NODE,
      from: SENDER,
      to: `qianmo://${NODE}/${agent}`,
      payload: { trigger: 'manual', prompt: `acceptance probe for ${agent}` },
    })
    await waitForTurn(ctx, node, agent, 120_000)
  }

  const sessions = await sessionIdsByAgent(ctx.driver, node)
  // transcript 是 ACP **子进程**落的盘，而 `waitForTurn` 等的是**宿主**写的
  // timings —— 两个进程，宿主那条一定先到。所以再等一小会儿「两个 session 的
  // 文件都出现」，到点就照现状交出去。
  //
  // 这不是给 #44 留后路：等到就等到，等不到那条红才成立。少了这一步，一条本来
  // 只是慢了半秒的 transcript 会被记成「文件根本没生成」，而那正是 #44 的形态
  // —— 两者混在一起，这一维的红就不可信了。
  const wanted = Object.values(sessions)
  const deadline = Date.now() + 15_000
  let transcripts = await readTranscripts(ctx.driver, node)
  while (
    Date.now() < deadline &&
    !wanted.every(id => transcripts.some(t => t.sessionId === id))
  ) {
    await delay(500)
    transcripts = await readTranscripts(ctx.driver, node)
  }

  return { node, upstream, workspaces, sessions, transcripts }
}

export const multiAgentScenarios: readonly Scenario[] = [
  {
    id: 'multi-agent/routes-to-each-agent',
    dimension: 'multi-agent',
    title: '两个 agent 各自收到寄给自己的消息',
    expected: '每个 agent 的信箱里都有一条，且各自开了独立 ACP session',
    // `stub-upstream` 是补声明的：`twoAgentRun` 起了一个假上游并 `waitForTurn`
    // 等两轮走完。少了这一条，真机腿上它会通过能力差集、然后对着一个**在
    // runner 上**的假上游等 120 s × 2，最后以 `error` 收场 —— 一次因为
    // `requires` 写漏而红的场景，正是 issue #61 那个形状的另一面。
    // 真机腿实测出来的，本地腿看不见（那边假上游就在同一台机器上）。
    requires: ['spawn-node', 'raw-dial', 'read-node-files', 'stub-upstream'],
    timeoutMs: 240_000,
    async run(ctx) {
      const run = await twoAgentRun(ctx)
      const inboxA = await readMailbox(ctx.driver, run.node, TEAM, AGENT_A)
      const inboxB = await readMailbox(ctx.driver, run.node, TEAM, AGENT_B)
      return new Checks()
        .note('会话表', run.sessions)
        .expect(inboxA.length > 0, `${AGENT_A} 的信箱非空`, inboxA.length)
        .expect(inboxB.length > 0, `${AGENT_B} 的信箱非空`, inboxB.length)
        .expect(
          run.sessions[AGENT_A] !== undefined &&
            run.sessions[AGENT_B] !== undefined &&
            run.sessions[AGENT_A] !== run.sessions[AGENT_B],
          '两个 agent 拿到两个不同的 session id',
          run.sessions,
        )
        .done('按 agent 段路由正确')
    },
  },

  {
    id: 'multi-agent/workspace-isolation',
    dimension: 'multi-agent',
    title: '每个 agent 的 session 跑在自己的工作区里',
    expected:
      '每个 agent 的 transcript 里的 cwd 等于它自己 --agent 指定的目录；两个 agent 的 cwd 不同',
    requires: ['spawn-node', 'raw-dial', 'read-node-files', 'stub-upstream'],
    knownIssue: '#44',
    timeoutMs: 240_000,
    async run(ctx) {
      const run = await twoAgentRun(ctx)
      const checks = new Checks()
        .note('工作区配置', run.workspaces)
        .note('会话表', run.sessions)
        .note(
          'transcript',
          run.transcripts
            .map(
              t =>
                `${t.projectDir}/${t.sessionId}.jsonl cwd=${t.cwds.join(',')}`,
            )
            .join('\n'),
        )
        .note(
          'system prompt 里报出的工作目录',
          workingDirectoriesSeen(run.upstream.requests()),
        )

      for (const agent of [AGENT_A, AGENT_B]) {
        const sessionId = run.sessions[agent]
        const transcript = run.transcripts.find(t => t.sessionId === sessionId)
        checks.expect(
          transcript !== undefined,
          `${agent} 的 session 有自己的 transcript 文件`,
          sessionId ?? '(没有 session)',
        )
        if (transcript === undefined) continue
        // transcript 里记的是 realpath 后的目录，配置里给的可能是软链路径，
        // 所以比「以 ws-<agent> 结尾」而不是逐字比整条路径。
        checks.expect(
          transcript.cwds.length === 1 &&
            transcript.cwds[0]?.endsWith(`ws-${agent}`) === true,
          `${agent} 的 transcript 里 cwd 是自己的工作区`,
          transcript.cwds,
        )
        checks.expect(
          transcript.projectDir.endsWith(projectDirNameOf(`ws-${agent}`)),
          `${agent} 的 transcript 落在自己工作区的 project 目录下`,
          transcript.projectDir,
        )
      }

      const dirsSeen = workingDirectoriesSeen(run.upstream.requests())
      checks.expect(
        dirsSeen.length >= 2,
        'system prompt 里出现过两个不同的工作目录（每个 agent 各被告知自己的）',
        dirsSeen,
      )
      return checks.done('多 agent 工作区隔离')
    },
  },

  {
    id: 'multi-agent/separate-transcripts',
    dimension: 'multi-agent',
    title: '两个 agent 的转录不混在同一个文件里',
    expected:
      '两个 session 各有一个 transcript 文件，且没有任何文件同时含两个 session',
    requires: ['spawn-node', 'raw-dial', 'read-node-files', 'stub-upstream'],
    knownIssue: '#44',
    timeoutMs: 240_000,
    async run(ctx) {
      const run = await twoAgentRun(ctx)
      const ids = [run.sessions[AGENT_A], run.sessions[AGENT_B]].filter(
        (v): v is string => v !== undefined,
      )
      const matched = ids.filter(id =>
        run.transcripts.some(t => t.sessionId === id),
      )
      return new Checks()
        .note('会话表', run.sessions)
        .note(
          'transcript 文件',
          run.transcripts
            .map(
              t =>
                `${t.projectDir}/${t.sessionId}.jsonl (${t.lines} 行, cwd=${t.cwds.join(',')})`,
            )
            .join('\n'),
        )
        .eq(ids.length, 2, '拿到两个 session id')
        .eq(matched.length, 2, '两个 session 各自都有 transcript 文件')
        .expect(
          run.transcripts.length >= 2,
          'transcript 文件数不少于 2（两个 agent 不共用一个文件）',
          run.transcripts.length,
        )
        .done('转录按 session 分家')
    },
  },

  {
    id: 'multi-agent/unknown-agent-does-not-fan-out',
    dimension: 'multi-agent',
    title: '寄给不存在的 agent 不会落进任何一个真 agent 的信箱',
    expected: 'E_UNKNOWN_AGENT，且两个 agent 的信箱都还是空的',
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        agents: [AGENT_A, AGENT_B],
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: `qianmo://${NODE}/charlie`,
      })
      const inboxA = await readMailbox(ctx.driver, node, TEAM, AGENT_A)
      const inboxB = await readMailbox(ctx.driver, node, TEAM, AGENT_B)
      return new Checks()
        .eq(result.errorCode, 'E_UNKNOWN_AGENT', 'error code')
        .eq(inboxA.length, 0, `${AGENT_A} 的信箱条数`)
        .eq(inboxB.length, 0, `${AGENT_B} 的信箱条数`)
        .done('未知 agent 不会误投')
    },
  },
]
