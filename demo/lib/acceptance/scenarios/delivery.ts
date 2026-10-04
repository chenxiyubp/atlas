// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 投递维度 —— issue #34 / PR #42 的验收面。
 *
 * 那个 issue 的形状：**投递层拒绝时节点什么都不回**，于是发起方只能落到兜底
 * 文案「原因见该节点的审计链」，排查必须登机。PR #42 给非 task 类型也补了一条
 * `errorReply`，所以现在每一种拒绝都该带着真 code 回来。
 *
 * 因此这一维的每条断言都是**两半**：
 *   ① 拿到的 code 是那个具体的（`E_UNKNOWN_AGENT` / `E_UNDELIVERABLE` …）；
 *   ② 拿到的 reason **不是**兜底那句。
 * 只测 ① 会漏掉「补发了但内容是兜底」的退化，只测 ② 会漏掉「换了另一个错误
 * 码」的退化。
 */

import { Checks, stripMinifiedSourceFrame } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { mint, sendEnvelope, receiptScene } from '../local/send.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  NODE,
  SENDER,
  SENDER_NODE,
  TEAM,
  newParty,
  newTaskId,
  startNodeTrusting,
} from './fixtures.js'

/** 发起方在拿不到 error 信封时会落到的兜底文案（中英各一）。 */
const FALLBACK_ZH = '原因见该节点的审计链'
const FALLBACK_EN = "the reason is in that node's audit trail"

export const deliveryScenarios: readonly Scenario[] = [
  {
    id: 'delivery/unknown-agent',
    dimension: 'delivery',
    title: '未知 agent：回 E_UNKNOWN_AGENT，而不是「原因见审计链」',
    expected:
      "E_UNKNOWN_AGENT + 'resident agent ghost is not configured'，且 reason 不含兜底文案",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, {
        policy: 'signed-task',
      })
      const taskId = newTaskId()
      const ghost = `qianmo://${NODE}/ghost`
      // token 必须绑到**同一个不存在的 handler**：绑到 main 的话会先在
      // `sub` 那步被拒，永远走不到 agent 查找，测到的是另一条分支。
      const cap = mint(party.issuer, { sub: ghost, aud: NODE, taskId })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ghost,
        cap,
        taskId,
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_UNKNOWN_AGENT', 'error code')
        .eq(
          result.errorReason,
          'resident agent ghost is not configured',
          'error reason',
        )
        .notContains(result.errorReason, FALLBACK_ZH, 'reason')
        .notContains(result.errorReason, FALLBACK_EN, 'reason')
        .done('未知 agent 带真 code 回来')
    },
  },

  {
    id: 'delivery/wrong-node',
    dimension: 'delivery',
    title: '寄给别的节点：回 E_UNKNOWN_AGENT 并点名本节点',
    expected: `E_UNKNOWN_AGENT + 'message is not addressed to resident node ${NODE}'`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      // 开放档 + 不带 token：能力层不拦，直落投递层。带 token 反而会先在
      // `aud` 那步被拒（token 的 aud 只能是本节点）。
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: 'qianmo://elsewhere/main',
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_UNKNOWN_AGENT', 'error code')
        .eq(
          result.errorReason,
          `message is not addressed to resident node ${NODE}`,
          'error reason',
        )
        .notContains(result.errorReason, FALLBACK_ZH, 'reason')
        .done('错节点带真 code 回来')
    },
  },

  {
    id: 'delivery/mailbox-write-failure',
    dimension: 'delivery',
    title: '信箱写不进去：回 E_UNDELIVERABLE 并带上底层错误原文',
    expected: "E_UNDELIVERABLE + reason 以 'mailbox write failed:' 开头",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      // 信箱**不在 agent 工作区里**，在配置根下的 `teams/<team>/inboxes/`
      // （`writeToMailbox` → `getTeamsDir()`）。早先这条场景去改工作区权限，
      // 结果投递照常成功、场景永远 skip —— 观察点根本不在那儿。
      //
      // 目录要等第一条消息投进去才存在，所以先正常投一条，再把目录设成
      // 0o500（可进不可写），第二条才撞得上写失败。0o000 不行：那样连 stat
      // 都做不了，失败点会前移，报出来的就不是 mailbox write。
      const first = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      // 存在性与权限位都经驱动：真机腿上配置根在另一台机器上，`node:fs` 在
      // 那里改的是 runner 自己的一条不存在的路径 —— 于是投递照常成功，
      // 而这条场景会走进「本机不强制权限位」那个 skip 分支，说一句假话。
      const inboxRel = `teams/${TEAM}/inboxes`
      if ((await ctx.driver.listNodeDir(node, inboxRel)) === undefined) {
        return new Checks()
          .note('第一条的 receipt', first.receipt)
          .skip(`第一条消息之后信箱目录仍不存在（${inboxRel}），无法构造写失败`)
      }
      await ctx.driver.setNodePathMode(node, inboxRel, '500')
      ctx.cleanup(async () => {
        try {
          await ctx.driver.setNodePathMode(node, inboxRel, '700')
        } catch {
          // 目录可能已经被清掉了。
        }
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        payload: {
          trigger: 'manual',
          prompt: 'second, into a read-only inbox',
        },
      })
      const checks = new Checks()
        .note('receipt', result.receipt)
        .note(
          'error',
          `${result.errorCode ?? '-'} / ${result.errorReason ?? '-'}`,
        )
      if (result.errorCode === undefined && result.receipt === 'accepted') {
        // 这台机器上写入没有失败（例如以 root 跑，或文件系统不认这个位）。
        // 那就不是被测系统的问题，如实跳过而不是假装通过。
        return checks.skip(
          '本机上把工作区置为只读没能让信箱写入失败（root 或文件系统不强制权限位）',
        )
      }
      return checks
        .eq(result.errorCode, 'E_UNDELIVERABLE', 'error code')
        .expect(
          result.errorReason?.startsWith('mailbox write failed:') === true,
          "reason 以 'mailbox write failed:' 开头",
          result.errorReason,
        )
        .notContains(result.errorReason, FALLBACK_ZH, 'reason')
        .done('信箱写失败带真 code 回来')
    },
  },

  {
    id: 'delivery/node-unreachable',
    dimension: 'delivery',
    title: '节点不可达：发起方拿到连接失败，而不是一条假的成功',
    expected: 'resident-wake 非零退出，输出里没有 receipt',
    requires: ['exec-node-cli'],
    timeoutMs: 150_000,
    async run(ctx) {
      // 经驱动跑，发起方就在**目标机上** —— 「拨一个没人听的口会怎样」在真机
      // 上要连着那台机器的网络栈一起问，在 runner 上问只是又跑了一遍本地腿。
      const host = await ctx.driver.execHost(ctx)
      // 目标机上此刻没人在听的一个口。它保证的只有「现在没人听」，而这条场景
      // 要的正是这个。
      const port = await host.freePort()
      const result = await host.exec(
        [
          'resident-wake',
          '--url',
          `ws://127.0.0.1:${port}`,
          '--from',
          SENDER,
          '--to',
          ADDRESS,
          '--prompt',
          'acceptance unreachable probe',
          '--timeout-ms',
          '8000',
        ],
        {
          env: { QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK },
          timeoutMs: 120_000,
        },
      )
      return new Checks()
        .note('执行位置', `${host.describe} · ws://127.0.0.1:${port}`)
        .expect(result.code !== 0, '退出码非零', result.code)
        .notContains(result.stdout, '"receipt"', 'stdout')
        .note('stderr', stripMinifiedSourceFrame(result.stderr).slice(0, 2_000))
        .done('不可达没有被报成成功')
    },
  },

  {
    id: 'delivery/refusal-reaches-cli-sender',
    dimension: 'delivery',
    title: '经 qm resident-wake 发起时，拒绝原因原样传到发起方',
    expected:
      "非零退出，stderr 含 'E_CAP_INSUFFICIENT' 与 needs write-limited；不含审计链兜底句",
    requires: ['spawn-node', 'exec-node-cli'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, {
        policy: 'signed-task',
      })
      // 发起方也要是**被测的那个二进制**：真机腿上它就落在节点那台机器上，
      // 于是拨的是 `hostEndpoint`（节点自己的回环口）而不是 runner 侧的隧道口。
      // 此前这里调本地 `runCli`，`requires` 里的 `exec-node-cli` 纯属装饰
      // ——issue #61 那个形状。
      const host = await ctx.driver.execHost(ctx, { sameMachineAs: node })
      const result = await host.exec(
        [
          'resident-wake',
          '--url',
          node.hostEndpoint,
          '--from',
          SENDER,
          '--to',
          ADDRESS,
          '--prompt',
          'acceptance refusal probe',
          '--timeout-ms',
          '20000',
        ],
        {
          env: { QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK },
          timeoutMs: 60_000,
        },
      )
      const output = `${result.stdout}\n${result.stderr}`
      return new Checks()
        .note('执行位置', host.describe)
        .expect(result.code !== 0, '退出码非零', result.code)
        .contains(output, 'E_CAP_INSUFFICIENT', '输出')
        .contains(output, 'needs write-limited', '输出')
        .notContains(output, FALLBACK_EN, '输出')
        .note('原文', output.slice(0, 2_000))
        .done('CLI 发起方看得到真原因')
    },
  },
]
