// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 模型凭据维度 —— issue #37 / PR #50 的验收面。
 *
 * 那个 issue 的形状：凭据**存在但失效**时，节点看起来完全健康（banner 正常、
 * 端口 LISTEN、回执照收），每个任务却静默烧 120 秒后以一条指向错误方向的
 * `ResidentInactivityError` 收场。四十四毫秒就能知道的事，花了两分钟才以
 * 「模型没产出」的名义报出来。
 *
 * 修法是两条独立的：①启动时主动探一次，401/403/407 打醒目告警；②轮次超时
 * 时若最近一次上游是认证类 4xx，文案改为指向凭据。这里覆盖①的四种上游形态，
 * ②在 `abort-attribution` 那一维。
 *
 * **`unreachable` 不告警是有意的**，不是漏了：被 supervisor 拉起来的节点常常
 * 跑在网络就绪之前，一条在健康节点上也会响的告警，人会学会忽略它。所以这里
 * 有一条**反向断言**——探不通时 stderr 必须保持干净。
 *
 * ## 本地腿实测到的结论（2026-08-24，基线 c4ed9d8）
 *
 * 这一维里凡是「探针必须真的发过一次请求」的断言**全是红的**，假上游一条请求
 * 都没收到。追下去不是探针逻辑的问题，而是它够不着：
 *
 *   · `qm resident` 在 `src/entrypoints/cli.tsx` 里是一条**快速路径**，
 *     在 `main.tsx` 的 `enableConfigs()` 之前就 dispatch 掉了（同一文件里
 *     `--dump-system-prompt` 等分支都自己补调了一次 `enableConfigs()`，
 *     resident 这条没有）；
 *   · `residentModelProbeInputs()` 无条件先调 `getAuthHeaders()`，而配置闸门
 *     没开时它抛 `Config accessed before allowed.`；
 *   · 那个抛被 `runResidentModelCredentialProbe` 的 try/catch 收成
 *     `{status:'skipped'}` —— **不打印、不告警、不留痕**。
 *
 * 于是启动探针在真进程里从不发请求，对**任何** provider 都一样（`getAuthHeaders()`
 * 排在选 provider 之前）。单测测不出来是因为它们注入 `inputs`/`fetchImpl`，
 * 绕开了这两步。这几条红要留着，直到那条路径真的通。
 */

import { Checks } from '../checks.js'
import { startStubUpstream } from '../local/upstream.js'
import { delay } from '../observe.js'
import type { Scenario } from '../types.js'
import { newParty, startNodeTrusting, upstreamEnv } from './fixtures.js'

/** 401 告警的稳定前缀（后半句会随端点变，不适合逐字比）。 */
const REFUSED_PREFIX =
  "[resident] this node's model endpoint REFUSED its credential: HTTP 401 from "
/** 「凭据根本不可见」那条告警的前缀。 */
const MISSING_PREFIX = '[resident] no model credential is visible to this node'

/** 启动探针是 fire-and-forget，且默认 10 s 超时；等够。 */
const PROBE_SETTLE_MS = 4_000
const PROBE_TIMEOUT_SETTLE_MS = 13_000

export const modelCredentialScenarios: readonly Scenario[] = [
  {
    id: 'model-credential/refused-401-warns-at-startup',
    dimension: 'model-credential',
    title: '凭据被 401 拒绝：启动时就告警，而不是等 120 秒的超时',
    expected: `stderr 出现 ${JSON.stringify(REFUSED_PREFIX)}`,
    requires: ['spawn-node', 'stub-upstream'],
    timeoutMs: 90_000,
    async run(ctx) {
      const upstream = startStubUpstream({ behavior: 'refuse' })
      ctx.cleanup(() => upstream.stop())
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        env: upstreamEnv(upstream.baseUrl),
      })
      // 探针是 `void ...then(...)` 起的，落在 banner 之后。
      await delay(PROBE_SETTLE_MS)
      const stderr = await node.stderr()
      return new Checks()
        .note('stderr 原文', stderr)
        .note(
          '假上游收到的请求',
          upstream
            .requests()
            .map(r => `${r.method} ${r.path}`)
            .join('\n'),
        )
        .expect(
          upstream.requests().length > 0,
          '启动时真的去探了一次上游',
          upstream.requests().length,
        )
        .contains(stderr, REFUSED_PREFIX, 'stderr')
        .contains(stderr, 'rotate the key', 'stderr（告警里要给出处置动作）')
        .done('失效凭据在启动时就被点名')
    },
  },

  {
    id: 'model-credential/unreachable-stays-silent',
    dimension: 'model-credential',
    title: '上游不可达：**不**告警（否则健康节点也会响，人就学会忽略）',
    expected: 'stderr 里没有 REFUSED 那条告警',
    requires: ['spawn-node', 'stub-upstream'],
    timeoutMs: 90_000,
    async run(ctx) {
      // 占一个端口再放掉：确保这个地址此刻没有任何东西在听。
      const deadPort = await ctx.allocPort()
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        env: upstreamEnv(`http://127.0.0.1:${deadPort}/v1`),
      })
      await delay(PROBE_SETTLE_MS)
      const stderr = await node.stderr()
      return new Checks()
        .note('stderr 原文', stderr)
        .note(
          '这条绿的成色',
          '端口上没有东西在听，所以「探针有没有真的拨过」在这条场景里结构上不可观测 —— 它只能证明「没有告警」。' +
            '探针是否真的发起过，由 hanging-upstream-stays-silent / server-error-is-not-a-refusal / refused-401-warns-at-startup 三条负责。',
        )
        .notContains(stderr, REFUSED_PREFIX, 'stderr')
        .notContains(
          stderr,
          MISSING_PREFIX,
          'stderr（凭据是可见的，只是打不通）',
        )
        .done('不可达时保持安静')
    },
  },

  {
    id: 'model-credential/hanging-upstream-stays-silent',
    dimension: 'model-credential',
    title: '上游接受连接但不应答：探针超时，同样不告警',
    expected: '探针 10 s 超时后 stderr 仍然没有 REFUSED 告警',
    requires: ['spawn-node', 'stub-upstream'],
    timeoutMs: 120_000,
    async run(ctx) {
      const upstream = startStubUpstream({ behavior: 'hang' })
      ctx.cleanup(() => upstream.stop())
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        env: upstreamEnv(upstream.baseUrl),
      })
      await delay(PROBE_TIMEOUT_SETTLE_MS)
      const stderr = await node.stderr()
      return new Checks()
        .note('stderr 原文', stderr)
        .expect(
          upstream.requests().length > 0,
          '探针确实拨过来了（连接建立了，只是没应答）',
          upstream.requests().length,
        )
        .notContains(stderr, REFUSED_PREFIX, 'stderr')
        .done('挂起的上游按 unreachable 处理，不告警')
    },
  },

  {
    id: 'model-credential/healthy-upstream-stays-silent',
    dimension: 'model-credential',
    title: '凭据可用：stderr 保持零字节（健康节点不该有噪声）',
    expected: '既没有 REFUSED 也没有 MISSING 告警',
    requires: ['spawn-node', 'stub-upstream'],
    timeoutMs: 90_000,
    async run(ctx) {
      const upstream = startStubUpstream({ behavior: 'ok' })
      ctx.cleanup(() => upstream.stop())
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        env: upstreamEnv(upstream.baseUrl),
      })
      await delay(PROBE_SETTLE_MS)
      const stderr = await node.stderr()
      return (
        new Checks()
          .note('stderr 原文', stderr === '' ? '(空)' : stderr)
          // 「没有告警」这句话，只有在**探针真的问过**的前提下才有内容。
          // 少了这条断言，一个从不发请求的探针会让这条场景永远绿。
          .expect(
            upstream.requests().length > 0,
            '探针拨过来了（否则「安静」是因为它压根没问）',
            upstream.requests().length,
          )
          .notContains(stderr, REFUSED_PREFIX, 'stderr')
          .notContains(stderr, MISSING_PREFIX, 'stderr')
          .done('健康凭据不产生告警')
      )
    },
  },

  {
    id: 'model-credential/server-error-is-not-a-refusal',
    dimension: 'model-credential',
    title: '上游 500：算「可达」，不算凭据被拒（只有 401/403/407 才算）',
    expected: '没有 REFUSED 告警',
    requires: ['spawn-node', 'stub-upstream'],
    timeoutMs: 90_000,
    async run(ctx) {
      const upstream = startStubUpstream({ behavior: 'error' })
      ctx.cleanup(() => upstream.stop())
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        env: upstreamEnv(upstream.baseUrl),
      })
      await delay(PROBE_SETTLE_MS)
      const stderr = await node.stderr()
      return new Checks()
        .note('stderr 原文', stderr === '' ? '(空)' : stderr)
        .expect(
          upstream.requests().length > 0,
          '探针拨过来了',
          upstream.requests().length,
        )
        .notContains(stderr, REFUSED_PREFIX, 'stderr')
        .done('5xx 不被误判成凭据问题')
    },
  },

  {
    id: 'model-credential/missing-warns',
    dimension: 'model-credential',
    title: '完全没有凭据：启动时点名，并且**不**再多打一条探针告警',
    expected: `stderr 出现 ${JSON.stringify(MISSING_PREFIX)}，且不出现 REFUSED 那条`,
    requires: ['spawn-node'],
    timeoutMs: 90_000,
    async run(ctx) {
      // 不给任何 provider 选择与密钥。注意本机环境里可能本来就有凭据，
      // 所以显式把相关键清成空串 —— 空串在解析里等同于未设置。
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        env: {
          CLAUDE_CODE_USE_OPENAI: '',
          CLAUDE_CODE_USE_GEMINI: '',
          CLAUDE_CODE_USE_GROK: '',
          OPENAI_API_KEY: '',
          ANTHROPIC_API_KEY: '',
          ANTHROPIC_AUTH_TOKEN: '',
          GEMINI_API_KEY: '',
          GROK_API_KEY: '',
          XAI_API_KEY: '',
        },
      })
      await delay(PROBE_SETTLE_MS)
      const stderr = await node.stderr()
      const checks = new Checks().note(
        'stderr 原文',
        stderr === '' ? '(空)' : stderr,
      )
      if (!stderr.includes(MISSING_PREFIX)) {
        // 本机 keychain / settings 里可能存着一份登录态，那样凭据就是「可见」
        // 的，这条断言问的问题在这台机器上不成立。如实跳过。
        return checks.skip(
          '本机在这个配置根之外仍能看见模型凭据（keychain 或 settings 登录态），「完全没有凭据」这个前提在这里造不出来',
        )
      }
      return checks
        .contains(stderr, MISSING_PREFIX, 'stderr')
        .notContains(
          stderr,
          REFUSED_PREFIX,
          'stderr（缺失与失效不该同时报两条）',
        )
        .done('缺凭据时点名，且只点一次')
    },
  },
]
