// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 策略维度：`--open-policy` 与 `--require-signed-tasks` 两态。
 *
 * 这一维的重点不是「开放放行、严格拒绝」那两条显然的，而是**那条反直觉的**：
 *
 *   `OPEN_POLICY` 只是不再*要求* token，它从不*跳过*验证。
 *
 * `NodeCapabilities.check()` 在 `message.cap !== undefined` 时**先**跑
 * `verifyCapability`，那个函数的入参里根本没有 policy 这一项，也没有办法传。
 * 所以开放策略下带一个坏 token 照样是 `E_CAP_INVALID`，nonce 照样被消费。
 * 三条场景把这件事从三个角度钉住：坏签名、过期、重放。
 *
 * 顺带钉住两条参数面的事实：默认是**严格**（P12.4 起 `requireSignedTasks`
 * 出厂为 true），以及两个开关同时给会在解析期直接报错、而不是按优先级和稀泥。
 *
 * ## 开放策略下也要有一条会红的判据（issue #116）
 *
 * 2026-08-27 从公网经控制台唤醒 beta-1：回执 `accepted`、任务也真跑完了 ——
 * 而节点审计链上紧挨着 `message_accepted` 的前一条是
 *
 *   `capability_shadow_refusal … required:"write-limited" presented:"read"`
 *
 * 也就是说，**「控制台能唤醒节点」当时不是因为鉴权通过，而是因为鉴权被关着**。
 * 四台节点都跑在 `--open-policy`，那条拒绝只记不拦。翻历史看它一直如此。
 *
 * 那件事本身**不需要再定**：`SIGNED_TASK_POLICY` 要求 `wake` 出示
 * `write-limited`（理由写在 `policy.ts`：一次 wake 开的是一个能改工作区的轮次），
 * 而控制台带 `--wake-sign` 时签发的正是 `write-limited` 令牌 —— 那条开关
 * 2026-08-23 就在了，整条链路由 `console/wake-sign-round-trip` 钉着。
 * 08-27 那台控制台只是**没带那个开关**（或节点没 `--trust` 它的公钥）。
 *
 * 缺的是**判据**：当时没有任何存活判据会提前说这件事，要等关掉 open policy
 * 那天才发现 —— 也就是最坏的时刻。下面两条补上：
 *
 *   · `policy/open-records-what-strict-would-refuse` 钉住**机制**：开放策略 +
 *     `--audit-signed-tasks` 时，那条影子拒绝确实被记下来了，且内容说得出
 *     「要什么、出示了什么、会用哪个码拒」。它坏了，下面那条就变成永远绿。
 *   · `policy/no-outstanding-shadow-refusal` 是**判据本身**：链上一条影子拒绝
 *     都不该有。它在 open policy 下照样会红，08-27 那天就会红。
 */

import { Checks, stripMinifiedSourceFrame } from '../checks.js'
import { readTrail } from '../observe.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import {
  mint,
  sendEnvelope,
  withBrokenSignature,
  receiptScene,
} from '../local/send.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  NODE,
  SENDER,
  SENDER_NODE,
  newParty,
  newTaskId,
  startNodeTrusting,
} from './fixtures.js'

export const policyScenarios: readonly Scenario[] = [
  {
    id: 'policy/open-admits-unsigned',
    dimension: 'policy',
    title: 'OPEN_POLICY：不带 token 的唤醒被放行',
    expected: "receipt='accepted'，且没有 error 信封",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      return new Checks()
        .eq(result.receipt, 'accepted', 'receipt')
        .eq(result.errorCode, undefined, 'error 信封的 code')
        .note('frames', result.frames.join('\n'))
        .done('开放策略放行无 token 唤醒')
    },
  },

  {
    id: 'policy/signed-refuses-unsigned-wake',
    dimension: 'policy',
    title: 'SIGNED_TASK_POLICY：不带 token 的唤醒被拒，且拒绝原因逐字可见',
    expected:
      "E_CAP_INSUFFICIENT + 'wake from ctl needs write-limited, presented read'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, {
        policy: 'signed-task',
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_CAP_INSUFFICIENT', 'error code')
        .eq(
          result.errorReason,
          `wake from ${SENDER_NODE} needs write-limited, presented read`,
          'error reason',
        )
        .done('严格策略拒绝无 token 唤醒')
    },
  },

  {
    id: 'policy/signed-refuses-unsigned-task',
    dimension: 'policy',
    title: 'SIGNED_TASK_POLICY：不带 token 的 task.request 同样被拒',
    expected:
      "E_CAP_INSUFFICIENT + 'task.request from ctl needs write-limited, presented read'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, {
        policy: 'signed-task',
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        type: 'task.request' as never,
        payload: { instruction: 'acceptance probe' },
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_CAP_INSUFFICIENT', 'error code')
        .eq(
          result.errorReason,
          `task.request from ${SENDER_NODE} needs write-limited, presented read`,
          'error reason',
        )
        .done('严格策略拒绝无 token 任务')
    },
  },

  {
    id: 'policy/open-still-verifies-bad-token',
    dimension: 'policy',
    title: 'OPEN_POLICY 下坏签名的 token 仍然被验、仍然被拒',
    expected:
      "E_CAP_INVALID + 'capability signature does not verify'（开放策略不跳过验证）",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      const taskId = newTaskId()
      const cap = withBrokenSignature(
        mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId }),
      )
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_CAP_INVALID', 'error code')
        .eq(
          result.errorReason,
          'capability signature does not verify',
          'error reason',
        )
        .done('开放策略下坏 token 照样被拒')
    },
  },

  {
    id: 'policy/open-still-checks-expiry',
    dimension: 'policy',
    title: 'OPEN_POLICY 下过期的 token 仍然被拒',
    expected: "E_CAP_INVALID + 'capability has expired'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      const taskId = newTaskId()
      const now = Date.now()
      const cap = mint(party.issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        nbf: now - 120_000,
        exp: now - 60_000,
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
      })
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, 'E_CAP_INVALID', 'error code')
        .eq(result.errorReason, 'capability has expired', 'error reason')
        .done('开放策略下过期 token 照样被拒')
    },
  },

  {
    id: 'policy/open-still-consumes-nonce',
    dimension: 'policy',
    title: 'OPEN_POLICY 下 nonce 照样被消费（重放被拒）',
    expected: "第二次 E_CAP_INVALID + 'capability nonce has already been used'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { policy: 'open' })
      const taskId = newTaskId()
      const cap = mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId })
      const common = {
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
      }
      const first = await sendEnvelope({
        ...common,
        payload: { trigger: 'manual', prompt: 'first' },
      })
      // payload 必须变：两条一字不差的信封会先撞上**传输层的指纹去重**，
      // 回的是 receipt='duplicate' 而不是能力层的 nonce 拒绝，测到的就成了
      // 另一个机制。
      const second = await sendEnvelope({
        ...common,
        payload: { trigger: 'manual', prompt: 'second' },
      })
      return new Checks()
        .eq(first.receipt, 'accepted', '第一次的 receipt')
        .eq(second.receipt, 'rejected', '第二次的 receipt')
        .eq(second.errorCode, 'E_CAP_INVALID', '第二次的 error code')
        .eq(
          second.errorReason,
          'capability nonce has already been used',
          '第二次的 error reason',
        )
        .done('开放策略下 nonce 仍然一次性')
    },
  },

  {
    id: 'policy/both-flags-refused',
    dimension: 'policy',
    title: '两个策略开关同时给 → 解析期报错，不按优先级和稀泥',
    expected:
      "非零退出 + 'resident takes either --open-policy or --require-signed-tasks, not both'",
    requires: ['exec-node-cli'],
    timeoutMs: 150_000,
    async run(ctx) {
      // 经 `ctx.driver.execHost` 而不是本地的 `runCli`：真机腿要问的是**那台
      // 机器上部署的那个二进制**怎么反应（p12 还是 x86_64），在 runner 上
      // spawn 一次只是把本地腿又跑了一遍（issue #61）。
      const host = await ctx.driver.execHost(ctx)
      const workspace = await host.mkdir('ws-main')
      const result = await host.exec(
        [
          'resident',
          '--node',
          'flagprobe',
          '--team',
          'acceptance',
          '--agent',
          `main=${workspace}`,
          '--port',
          // 解析期就该被拒，这个口不会被 bind —— 要的只是「语法上是个端口」
          // 加上「万一将来解析顺序变了，撞的也不是别人的服务」。
          String(await host.freePort()),
          '--hostname',
          '127.0.0.1',
          '--open-policy',
          '--require-signed-tasks',
        ],
        {
          env: { QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK },
          timeoutMs: 120_000,
        },
      )
      const output = stripMinifiedSourceFrame(
        `${result.stdout}\n${result.stderr}`,
      )
      return new Checks()
        .note('执行位置', host.describe)
        .expect(result.code !== 0, '退出码非零', result.code)
        .contains(
          output,
          'resident takes either --open-policy or --require-signed-tasks, not both',
          '错误输出',
        )
        .done('互斥开关在解析期就被挡住')
    },
  },

  {
    id: 'policy/default-is-signed',
    dimension: 'policy',
    title: '不给策略开关时默认是严格档，并且会警告没选',
    expected:
      "banner 里 requireSignedTasks=true，stderr 里出现 'no task policy was given'",
    requires: ['spawn-node'],
    async run(ctx) {
      const party = newParty()
      // 故意不经 fixtures 的 policy 参数：这里要测的正是「一个都不给」。
      const node = await ctx.driver.startNode(ctx, {
        name: NODE,
        agents: { main: `${ctx.workdir}/ws-main` },
        auth: { mode: 'psk', psk: ACCEPTANCE_PSK },
        policy: 'signed-task',
        omitPolicyFlag: true,
        trust: [`${party.peerNode}=${party.peerKeys.publicKey}`],
      })
      const banner = (await node.stdout())
        .split('\n')
        .find(line => line.includes('publicKey'))
      const stderr = await node.stderr()
      // 顺手验一次「默认真的是严格档」的行为面，而不是只信 banner 的字段：
      // 一条不带 token 的唤醒必须被拒。
      const probe = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      return new Checks()
        .note('启动 banner', banner ?? '(没有 banner)')
        .contains(banner, '"requireSignedTasks":true', 'banner 的策略字段')
        .contains(stderr, 'no task policy was given', 'stderr 的未选策略警告')
        .eq(probe.errorCode, 'E_CAP_INSUFFICIENT', '行为面：无 token 唤醒被拒')
        .done('默认档位是 SIGNED_TASK_POLICY 且会提醒没选')
    },
  },

  {
    id: 'policy/open-records-what-strict-would-refuse',
    dimension: 'policy',
    title: '开放策略 + --audit-signed-tasks：放行了，但影子拒绝把真相记下来',
    expected:
      "receipt='accepted'，且链上有 capability_shadow_refusal（required=write-limited, presented=read）",
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'open',
        // §9.2 阶段①的另一半。没有它，开放策略是**哑的**：放行了，而「若强制
        // 会怎样」一个字都不留 —— 下面那条判据也就无从谈起。
        extraArgs: ['--audit-signed-tasks'],
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      const records = await readTrail(ctx.driver, node)
      const shadow = records.filter(r => r.kind === 'capability_shadow_refusal')
      const detail = shadow.at(-1)?.detail ?? {}
      return new Checks()
        .note('回执现场', receiptScene(result))
        .note('影子拒绝', JSON.stringify(shadow.map(r => r.detail)))
        .note('链长度', records.length)
        .eq(result.receipt, 'accepted', 'receipt（开放策略放行）')
        .eq(result.errorCode, undefined, 'error 信封的 code')
        .expect(shadow.length > 0, '链上记下了影子拒绝', shadow.length)
        .eq(detail.type, 'wake', '影子拒绝的消息类型')
        .eq(detail.required, 'write-limited', '若强制则要求的等级')
        .eq(detail.presented, 'read', '实际出示的等级')
        .eq(detail.wouldRefuseWith, 'E_CAP_INSUFFICIENT', '若强制会用的错误码')
        .done('开放策略放行的同时记下了「若强制会被拒」')
    },
  },

  {
    id: 'policy/no-outstanding-shadow-refusal',
    dimension: 'policy',
    title:
      '这台节点上没有欠着的影子拒绝 —— 关掉 open policy 也不会突然全线被拒',
    expected: '审计链里 capability_shadow_refusal 一条都没有',
    // 只要一台活着的节点加读文件：真机腿据此读**部署好的那台**的生产链，
    // 这条判据在那里才有它真正的价值。
    requires: ['attach-node', 'read-node-files'],
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { attach: true })
      const records = await readTrail(ctx.driver, node)
      // **空链不是通过。**本地腿附着的是一台刚起来的节点，链上一条都没有，
      // 「没有影子拒绝」于是无条件成立 —— 那是一条什么都没看的绿。如实记 skip，
      // 让它在报告里与真正查过的那一轮分开；这条判据的价值在真机腿上，那里
      // `attach-node` 拿到的是部署好的那台的生产链。
      if (records.length === 0) {
        return new Checks().skip(
          '这台节点的审计链是空的 —— 没有可查的历史，「一条都没有」证明不了任何事',
        )
      }
      const shadow = records.filter(r => r.kind === 'capability_shadow_refusal')
      // 最近几条原文进证据 —— 这条红的时候要回答的问题是「谁、发的什么、缺哪一档」，
      // 一个计数回答不了。
      const quoted = shadow
        .slice(-5)
        .map(r => JSON.stringify({ seq: r.seq, at: r.at, detail: r.detail }))
        .join('\n')
      return (
        new Checks()
          .note('链长度', records.length)
          // 链是空的与「一条都没有」在计数上一样，而它们的含义完全不同：
          // 前者是这条判据什么都没看，写出来免得被读成通过。
          .note(
            '扫描到的记录种类',
            JSON.stringify([...new Set(records.map(r => r.kind))]),
          )
          .note('影子拒绝原文（最近 5 条）', quoted === '' ? '(没有)' : quoted)
          .expect(
            shadow.length === 0,
            '一条影子拒绝都没有欠着',
            `${shadow.length} 条：${quoted}`,
          )
          .done('这台节点在严格策略下也不会被拒')
      )
    },
  },
]
