// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 唤醒维度。
 *
 * 三条容易写反的事实，这里逐条钉住：
 *
 * ① **`qm resident-wake` 从不签名。** `parseResidentWakeArgs` 返回的
 *    `issueCapability` 恒为 undefined，`--wake-sign` 是 **`qm console`** 的
 *    开关。所以「签名唤醒」这条要自己铸 token 发，或者驱动控制台。
 *
 * ② **「签名者不在 `--trust` 里」不是一条拒绝路径。** 用 `--trust` 分发公钥
 *    时，没被 `--trust` 收录的签发者压根拿不到公钥，报的是
 *    `no published public key for issuer X`（`E_CAP_INVALID`）。真正意义上的
 *    「验得了签但不是授权方」只在 `--trust-ca` 那条路上才成立，那时消息**会
 *    被投递**、只是 `notice.trust` 停在 `untrusted`。两种形态分成两条场景，
 *    免得把「拿不到公钥」误当成「不受信任」。
 *
 * ③ **唤醒的重放有两层，答复完全不同。** 一字不差的信封撞传输层指纹去重，
 *    回的是 `receipt='duplicate'`（**成功语义**，不是错误）；换了 payload 但
 *    复用同一个 token，撞的才是能力层 nonce，回 `E_CAP_INVALID`。
 */

import { Checks, stripMinifiedSourceFrame } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { mint, newIssuer, sendEnvelope, receiptScene } from '../local/send.js'
import { readMailbox, waitForMailbox } from '../observe.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  AGENT,
  NODE,
  SENDER,
  SENDER_NODE,
  TEAM,
  newParty,
  newTaskId,
  startNodeTrusting,
} from './fixtures.js'

export const wakeScenarios: readonly Scenario[] = [
  {
    id: 'wake/signed-accepted',
    dimension: 'wake',
    title: '签名唤醒：被接收并真的投进信箱',
    expected:
      "receipt='accepted'，信箱里出现一条 notice.trust='verified-capability'",
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    timeoutMs: 120_000,
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, {
        policy: 'signed-task',
      })
      const taskId = newTaskId()
      const cap = mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
      })
      const inbox = await waitForMailbox(ctx, node, TEAM, AGENT)
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'accepted', 'receipt')
        .eq(result.errorCode, undefined, 'error code')
        .expect(inbox.length > 0, '信箱里有一条', inbox.length)
        .eq(inbox.at(-1)?.trust, 'verified-capability', 'notice.trust')
        .done('签名唤醒走通')
    },
  },

  {
    id: 'wake/unsigned-refused',
    dimension: 'wake',
    title: '严格档下未签名的唤醒被拒，且信箱不落条',
    expected: 'E_CAP_INSUFFICIENT，信箱仍为空',
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      const result = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      const inbox = await readMailbox(ctx.driver, node, TEAM, AGENT)
      return new Checks()
        .eq(result.errorCode, 'E_CAP_INSUFFICIENT', 'error code')
        .eq(inbox.length, 0, '信箱条数（拒绝必须在写信箱之前，规则 L-1）')
        .done('未签名唤醒被拒且未落盘')
    },
  },

  {
    id: 'wake/signer-not-published',
    dimension: 'wake',
    title: '签发者的公钥没被分发过：拿不到公钥，按 E_CAP_INVALID 拒',
    expected: "E_CAP_INVALID + 'no published public key for issuer stranger'",
    requires: ['spawn-node', 'raw-dial'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      const taskId = newTaskId()
      const cap = mint(newIssuer('stranger'), {
        sub: ADDRESS,
        aud: NODE,
        taskId,
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
        .eq(result.errorCode, 'E_CAP_INVALID', 'error code')
        .eq(
          result.errorReason,
          'no published public key for issuer stranger',
          'error reason',
        )
        .note(
          '读这条时注意',
          '这**不是**「签名者不受信任」，而是「根本拿不到它的公钥」。用 --trust 分发时两者重合；要区分开需要 --trust-ca 那条路。',
        )
        .done('未分发公钥的签发者被拒')
    },
  },

  {
    id: 'wake/envelope-replay-is-duplicate',
    dimension: 'wake',
    title: '一字不差地重发：传输层去重，回 duplicate（成功语义，不是错误）',
    expected: "第二次 receipt='duplicate'，且没有 error 信封",
    requires: ['spawn-node', 'raw-dial'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      const first = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
      })
      const second = await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        message: first.message,
      })
      return new Checks()
        .eq(first.receipt, 'accepted', '第一次 receipt')
        .eq(second.receipt, 'duplicate', '第二次 receipt')
        .eq(second.errorCode, undefined, '第二次没有 error 信封')
        .done('重发被幂等吸收')
    },
  },

  {
    id: 'wake/token-replay-refused',
    dimension: 'wake',
    title: '换了内容但复用同一个 token：能力层 nonce 拦下',
    expected: "第二次 E_CAP_INVALID + 'capability nonce has already been used'",
    requires: ['spawn-node', 'raw-dial'],
    timeoutMs: 120_000,
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, {
        policy: 'signed-task',
      })
      const taskId = newTaskId()
      const cap = mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId })
      const base = {
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
      }
      const first = await sendEnvelope({
        ...base,
        payload: { trigger: 'manual', prompt: 'wake one' },
      })
      const second = await sendEnvelope({
        ...base,
        payload: { trigger: 'manual', prompt: 'wake two' },
      })
      return new Checks()
        .eq(first.receipt, 'accepted', '第一次 receipt')
        .eq(second.errorCode, 'E_CAP_INVALID', '第二次 error code')
        .eq(
          second.errorReason,
          'capability nonce has already been used',
          '第二次 error reason',
        )
        .done('token 重放被拦')
    },
  },

  {
    id: 'wake/cli-round-trip',
    dimension: 'wake',
    title: 'qm resident-wake 端到端：开放档下拿到 accepted 回执',
    expected:
      'stdout 是一行 JSON，含 msgId / taskId / receipt=accepted，退出码 0',
    requires: ['spawn-node', 'exec-node-cli'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      // 发起方跑在**节点那台机器上**、用那台机器上部署好的二进制，所以拨的是
      // `hostEndpoint`。此前这里调本地 `runCli`：那让 `exec-node-cli` 这条
      // `requires` 在真机腿上什么都没保证（issue #61 的形状）。
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
          'acceptance cli wake',
          '--timeout-ms',
          '30000',
        ],
        {
          env: { QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK },
          timeoutMs: 60_000,
        },
      )
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = JSON.parse(result.stdout.trim()) as Record<string, unknown>
      } catch {
        parsed = undefined
      }
      return new Checks()
        .note('执行位置', host.describe)
        .note('stdout', result.stdout)
        .note('stderr', result.stderr.slice(0, 1_500))
        .eq(result.code, 0, '退出码')
        .expect(parsed !== undefined, 'stdout 是一行 JSON', result.stdout)
        .eq(parsed?.receipt, 'accepted', 'receipt')
        .expect(
          typeof parsed?.msgId === 'string' &&
            typeof parsed?.taskId === 'string',
          '回执带 msgId 与 taskId',
          parsed,
        )
        .done('CLI 唤醒走通')
    },
  },

  {
    id: 'wake/print-wake-identity-format',
    dimension: 'wake',
    title: 'qm console --print-wake-identity 只输出一行 <node>=<公钥>',
    expected: "stdout 恰好一行，形如 'console=<43 字符 base64url>'，退出码 0",
    requires: ['exec-node-cli'],
    timeoutMs: 150_000,
    async run(ctx) {
      // 这条命令**会在配置根里生成一把新的唤醒身份**，所以它必须落在一次性
      // 配置根里，绝不能是节点的生产根 —— 那是往内测机的身份目录里塞控制面
      // 凭据。`execHost` 存在的第一理由就是这个（见 types.ts 的对比表）。
      const host = await ctx.driver.execHost(ctx)
      const result = await host.exec(['console', '--print-wake-identity'], {
        env: { QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK },
        timeoutMs: 120_000,
      })
      const lines = result.stdout.split('\n').filter(l => l !== '')
      const line = lines[0] ?? ''
      return new Checks()
        .note('执行位置', host.describe)
        .note('stdout', result.stdout)
        .note('stderr', stripMinifiedSourceFrame(result.stderr).slice(0, 1_000))
        .eq(result.code, 0, '退出码')
        .eq(lines.length, 1, 'stdout 行数')
        .expect(
          /^[a-zA-Z0-9][\w-]*=[A-Za-z0-9_-]{43}$/.test(line),
          '格式是 <node>=<43 字符 base64url 公钥>',
          line,
        )
        .expect(
          line.startsWith('console='),
          '默认 --chat-from 的节点段是 console',
          line,
        )
        .done('唤醒身份可直接抄给 --trust')
    },
  },
]
