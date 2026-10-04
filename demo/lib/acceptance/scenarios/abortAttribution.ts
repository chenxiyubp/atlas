// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 中止归因维度 —— issue #39 / PR #50 的验收面。
 *
 * **委托方的描述在这里要修正一处**，否则断言会写反：
 *
 * > 「常驻看门狗超时写出的 transcript **不得**匹配用户中断那条正则」
 *
 * 实际上 PR #50 是把那条正则**放宽**成同时收两种标记的：
 *
 *     /^(?:\s*<[a-z][\w-]*[\s>]|\[Request (?:interrupted|aborted)[^\]]*\])/
 *
 * 它在 `sessionStorage/entries.ts` 与 `session/sessionStoragePortable.ts` 各有
 * 一份，作用是「续答时跳过首条合成消息」——看门狗写的那条**也应该**被跳过，
 * 所以放宽是对的。
 *
 * 真正**不得**匹配的是另一个东西：`isUserInterruptionText()`，它按
 * `'[Request interrupted by user'` 做 `includes`，`/insights` 的
 * `user_interruptions` 计数就是它数出来的。无人值守节点上那个计数**必须恒为
 * 0**。两者是两个机制，混作一谈会得到一条永远绿或永远红的用例。
 *
 * 因此这一维分两层：
 *   · 两条契约场景（秒级）：把上面两个机制各自的行为钉死；
 *   · 一条真跑场景（**约 150 秒**）：让上游挂起、等常驻的 120 s 看门狗真的
 *     掐掉一轮，然后去 transcript 里看写下的是哪条标记。
 */

import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { sendEnvelope } from '../local/send.js'
import { startStubUpstream } from '../local/upstream.js'
import { readTimings, waitForAbortMarker, waitForTurn } from '../observe.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  AGENT,
  SENDER,
  SENDER_NODE,
  newParty,
  startNodeTrusting,
  upstreamEnv,
} from './fixtures.js'

const USER_MARKER = '[Request interrupted by user]'
const WATCHDOG_MARKER =
  '[Request aborted by the resident watchdog: no agent activity]'

export const abortAttributionScenarios: readonly Scenario[] = [
  {
    id: 'abort-attribution/markers-are-distinct',
    dimension: 'abort-attribution',
    title: '看门狗标记与用户中断标记是两条不同的串',
    expected: '基座常量里两条标记互不包含，且用户那条一字未改',
    requires: ['read-repo-source'],
    async run() {
      const constants = await import(
        '../../../../src/utils/messages/constants.js'
      )
      const userMarker = constants.INTERRUPT_MESSAGE
      const watchdogMarker = constants.INACTIVITY_ABORT_MESSAGE
      return new Checks()
        .note('用户中断标记', userMarker)
        .note('看门狗标记', watchdogMarker)
        .eq(userMarker, USER_MARKER, '用户中断标记（基座用户可见面，不许动）')
        .eq(watchdogMarker, WATCHDOG_MARKER, '看门狗标记')
        .expect(
          !watchdogMarker.includes(USER_MARKER.slice(0, -1)),
          '看门狗标记不含用户中断标记的前缀',
          watchdogMarker,
        )
        .done('两条标记分得开')
    },
  },

  {
    id: 'abort-attribution/insights-counter-ignores-watchdog',
    dimension: 'abort-attribution',
    title: '/insights 的用户中断计数不认看门狗标记',
    expected:
      'isUserInterruptionText(看门狗标记) === false，isUserInterruptionText(用户标记) === true',
    requires: ['read-repo-source'],
    async run() {
      const constants = await import(
        '../../../../src/utils/messages/constants.js'
      )
      const isUser = constants.isUserInterruptionText
      const forWatchdog = isUser(constants.INACTIVITY_ABORT_MESSAGE)
      const forUser = isUser(constants.INTERRUPT_MESSAGE)
      const forToolUse = isUser(constants.INACTIVITY_ABORT_MESSAGE_FOR_TOOL_USE)
      return new Checks()
        .eq(forUser, true, '用户中断标记应被计入')
        .eq(forWatchdog, false, '看门狗标记不应被计入')
        .eq(forToolUse, false, '看门狗（工具轮）标记不应被计入')
        .note(
          '为什么这条重要',
          '常驻是无人值守的：那里的「用户中断」计数本该恒为 0。一次基础设施故障被计进人为取消，排查方向会直接跑偏。',
        )
        .done('计数器只认真正的用户中断')
    },
  },

  {
    id: 'abort-attribution/skip-pattern-covers-both',
    dimension: 'abort-attribution',
    title: '续答时跳过首条合成消息的正则，两种标记都覆盖',
    expected: '同一条正则同时命中用户中断标记与看门狗标记',
    requires: ['read-repo-source'],
    async run() {
      const constants = await import(
        '../../../../src/utils/messages/constants.js'
      )
      const entries = await import(
        '../../../../src/utils/sessionStorage/entries.js'
      )
      const pattern = entries.SKIP_FIRST_PROMPT_PATTERN
      return new Checks()
        .note('正则', String(pattern))
        .expect(
          pattern.test(constants.INTERRUPT_MESSAGE),
          '命中用户中断标记',
          constants.INTERRUPT_MESSAGE,
        )
        .expect(
          pattern.test(constants.INACTIVITY_ABORT_MESSAGE),
          '命中看门狗标记（PR #50 放宽的正是这里，不是收窄）',
          constants.INACTIVITY_ABORT_MESSAGE,
        )
        .done('跳过规则两条都收')
    },
  },

  {
    id: 'abort-attribution/watchdog-transcript-e2e',
    dimension: 'abort-attribution',
    title:
      '真跑：上游挂起 → 120 s 看门狗掐掉 → transcript 写的不是「用户中断」',
    expected:
      "transcript 里出现看门狗标记、且不出现 '[Request interrupted by user'；timings 里是 turn_failed/ResidentInactivityError",
    requires: ['spawn-node', 'raw-dial', 'read-node-files', 'stub-upstream'],
    // 常驻的无活动超时是硬编码的 120 s（没有 CLI 开关），所以这一条**必然**
    // 要花两分半。别把它调短——调短就测不到真正的那条路径了。
    timeoutMs: 260_000,
    async run(ctx) {
      const upstream = startStubUpstream({ behavior: 'hang' })
      ctx.cleanup(() => upstream.stop())
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        env: upstreamEnv(upstream.baseUrl),
      })
      await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        payload: { trigger: 'manual', prompt: 'acceptance watchdog probe' },
      })
      const terminal = await waitForTurn(ctx, node, AGENT, 220_000)
      const timings = await readTimings(ctx.driver, node)
      // 宿主写 turn_failed 与子进程落 transcript 是两个进程里的两件事，
      // 必须等后者（理由见 waitForAbortMarker 的注释）。
      const markers = await waitForAbortMarker(ctx.driver, node)

      const checks = new Checks()
        .note(
          'timings',
          timings.map(e => `${e.stage} ${e.error ?? ''}`).join('\n'),
        )
        .note('transcript 里的中止标记', markers)
        .note('假上游收到的请求数', upstream.requests().length)

      if (terminal === undefined) {
        return checks.skip(
          '220 s 内这一轮没有走到终态（这台机器上 ACP 子进程可能没能起来），无法观察看门狗写的标记',
        )
      }

      return checks
        .eq(terminal.stage, 'turn_failed', '终态 stage')
        .eq(terminal.error, 'ResidentInactivityError', '终态错误类型')
        .expect(
          markers.includes(WATCHDOG_MARKER),
          'transcript 里写的是看门狗标记',
          markers,
        )
        .expect(
          !markers.some(m => m.startsWith('[Request interrupted by user')),
          "transcript 里没有 '[Request interrupted by user'",
          markers,
        )
        .done('基础设施故障没有被伪装成人为取消')
    },
  },
]
