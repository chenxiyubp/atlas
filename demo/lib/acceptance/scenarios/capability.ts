// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 能力 token 维度 —— `verifyCapability` 的每一条校验各一条场景。
 *
 * 断言的是**逐字的 reason 串**，不是只判 code。理由：`E_CAP_INVALID` 这一个
 * code 底下挂着九种不同的原因，只判 code 的用例在「过期」被误判成「aud 不
 * 匹配」时照样绿。运维读到的也正是这句 reason（它经 error 信封原样上到发起
 * 方，再原样进控制台），所以它就是产品面。
 *
 * 校验顺序是有意设计的（`token.ts` 文件头）：结构 → 绑定 → 时钟 → 规则 S-1 →
 * 签名 → 重放。两处会咬人的后果，各有一条场景钉着：
 *   · **S-1 排在签名之前** —— 远端签发的 `user-confirmed` 即使签名是垃圾，
 *     报的也是 `E_CAP_INSUFFICIENT`（规则 S-1），不是 `E_CAP_INVALID`；
 *   · **nonce 排在最后** —— 一个伪造 token 不会烧掉真 token 的 nonce。
 */

import { CapabilityLevel } from '@qianmo/protocol'
import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import {
  mint,
  newIssuer,
  sendEnvelope,
  withBrokenSignature,
  receiptScene,
} from '../local/send.js'
import type { Scenario, ScenarioContext } from '../types.js'
import {
  ADDRESS,
  NODE,
  SENDER,
  SENDER_NODE,
  newParty,
  newTaskId,
  startNodeTrusting,
  type Party,
} from './fixtures.js'

/** 起一个认识 `party` 的严格档节点，并回一个「发一条带 cap 的唤醒」的闭包。 */
async function capabilityFixture(ctx: ScenarioContext, party: Party) {
  const node = await startNodeTrusting(ctx, party, { policy: 'signed-task' })
  return {
    node,
    async send(cap: string, taskId: string, prompt = 'acceptance') {
      return await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
        payload: { trigger: 'manual', prompt },
      })
    },
  }
}

/** 一条「坏 token 该报什么」的场景模板。 */
function refusal(spec: {
  readonly id: string
  readonly title: string
  readonly code: 'E_CAP_INVALID' | 'E_CAP_INSUFFICIENT'
  readonly reason: string | ((node: string) => string)
  readonly cap: (party: Party, taskId: string) => string
  /** token 绑的 taskId 与信封的不同时用（默认两者相同）。 */
  readonly envelopeTaskId?: (taskId: string) => string
}): Scenario {
  return {
    id: spec.id,
    dimension: 'capability',
    title: spec.title,
    expected: `${spec.code} + ${JSON.stringify(
      typeof spec.reason === 'function' ? spec.reason(NODE) : spec.reason,
    )}`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const fixture = await capabilityFixture(ctx, party)
      const taskId = newTaskId()
      const cap = spec.cap(party, taskId)
      const envelopeTaskId = spec.envelopeTaskId?.(taskId) ?? taskId
      const result = await fixture.send(cap, envelopeTaskId, spec.id)
      const expectedReason =
        typeof spec.reason === 'function' ? spec.reason(NODE) : spec.reason
      return new Checks()
        .eq(result.receipt, 'rejected', 'receipt')
        .eq(result.errorCode, spec.code, 'error code')
        .eq(result.errorReason, expectedReason, 'error reason')
        .note('frames', result.frames.join('\n'))
        .done(spec.title)
    },
  }
}

export const capabilityScenarios: readonly Scenario[] = [
  {
    id: 'capability/valid-admitted',
    dimension: 'capability',
    title: '有效 token：被接收，且不回 error 信封',
    expected: "receipt='accepted'，无 error 信封",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const fixture = await capabilityFixture(ctx, party)
      const taskId = newTaskId()
      const cap = mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId })
      const result = await fixture.send(cap, taskId)
      return new Checks()
        .note('回执现场', receiptScene(result))
        .eq(result.receipt, 'accepted', 'receipt')
        .eq(result.errorCode, undefined, 'error code')
        .done('有效 token 被接收')
    },
  },

  refusal({
    id: 'capability/expired',
    title: '过期（exp 已过）',
    code: 'E_CAP_INVALID',
    reason: 'capability has expired',
    cap: (party, taskId) =>
      mint(party.issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        nbf: Date.now() - 120_000,
        exp: Date.now() - 60_000,
      }),
  }),

  refusal({
    id: 'capability/not-yet-valid',
    title: '未生效（nbf 在将来）',
    code: 'E_CAP_INVALID',
    reason: 'capability is not yet valid',
    cap: (party, taskId) =>
      mint(party.issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        nbf: Date.now() + 120_000,
        exp: Date.now() + 300_000,
      }),
  }),

  refusal({
    id: 'capability/audience-mismatch',
    title: 'aud 不是本节点',
    code: 'E_CAP_INVALID',
    reason: node => `capability audience someone-else is not this node ${node}`,
    cap: (party, taskId) =>
      mint(party.issuer, { sub: ADDRESS, aud: 'someone-else', taskId }),
  }),

  refusal({
    id: 'capability/subject-mismatch',
    title: 'sub 与 message.to 不一致',
    code: 'E_CAP_INVALID',
    reason: node =>
      `capability subject qianmo://${node}/other does not match handler ${ADDRESS}`,
    cap: (party, taskId) =>
      mint(party.issuer, {
        sub: `qianmo://${NODE}/other`,
        aud: NODE,
        taskId,
      }),
  }),

  refusal({
    id: 'capability/task-binding-mismatch',
    title: 'taskId 绑定不符',
    code: 'E_CAP_INVALID',
    reason: 'capability is bound to another task',
    cap: (party, _taskId) =>
      mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId: newTaskId() }),
  }),

  refusal({
    id: 'capability/unknown-issuer',
    title: '签发者不在信任集（拿不到公钥）',
    code: 'E_CAP_INVALID',
    reason: 'no published public key for issuer outsider',
    cap: (_party, taskId) =>
      mint(newIssuer('outsider'), { sub: ADDRESS, aud: NODE, taskId }),
  }),

  refusal({
    id: 'capability/bad-signature',
    title: '签名验不过',
    code: 'E_CAP_INVALID',
    reason: 'capability signature does not verify',
    cap: (party, taskId) =>
      withBrokenSignature(
        mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId }),
      ),
  }),

  refusal({
    id: 'capability/malformed',
    title: '根本不是一个 token',
    code: 'E_CAP_INVALID',
    reason: 'capability token is malformed',
    cap: () => 'this-is-not-a-capability-token',
  }),

  refusal({
    id: 'capability/act-insufficient',
    title: 'act 档位不足（read 够不到 write-limited）',
    code: 'E_CAP_INSUFFICIENT',
    reason: `wake from ${SENDER_NODE} needs write-limited, presented read`,
    cap: (party, taskId) =>
      mint(party.issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        act: CapabilityLevel.Read,
      }),
  }),

  refusal({
    id: 'capability/rule-s1-remote-user-confirmed',
    title: '规则 S-1：远端签发的 user-confirmed 一律不认',
    code: 'E_CAP_INSUFFICIENT',
    reason: `user-confirmed capability issued by ${SENDER_NODE}, not by this node (rule S-1)`,
    cap: (party, taskId) =>
      mint(party.issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        act: CapabilityLevel.UserConfirmed,
      }),
  }),

  {
    id: 'capability/nonce-replay',
    dimension: 'capability',
    title: 'nonce 重放：同一个 token 用第二次被拒',
    expected:
      "第一次 accepted；第二次 E_CAP_INVALID + 'capability nonce has already been used'",
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const fixture = await capabilityFixture(ctx, party)
      const taskId = newTaskId()
      const cap = mint(party.issuer, { sub: ADDRESS, aud: NODE, taskId })
      const first = await fixture.send(cap, taskId, 'first')
      // 换 payload，否则先撞上传输层的指纹去重（回 duplicate），
      // 测到的就不是能力层的 nonce 了。
      const second = await fixture.send(cap, taskId, 'second')
      return new Checks()
        .eq(first.receipt, 'accepted', '第一次 receipt')
        .eq(second.receipt, 'rejected', '第二次 receipt')
        .eq(second.errorCode, 'E_CAP_INVALID', '第二次 error code')
        .eq(
          second.errorReason,
          'capability nonce has already been used',
          '第二次 error reason',
        )
        .done('token 是一次性的')
    },
  },

  {
    id: 'capability/forgery-does-not-burn-nonce',
    dimension: 'capability',
    title: '伪造 token 不会烧掉真 token 的 nonce（nonce 检查排在最后）',
    expected: '先送一个签名坏掉的同 nonce token，真 token 随后仍被接收',
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const fixture = await capabilityFixture(ctx, party)
      const taskId = newTaskId()
      const nonce = crypto.randomUUID()
      const real = mint(party.issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        nonce,
      })
      const forged = withBrokenSignature(real)
      const attack = await fixture.send(forged, taskId, 'forged')
      const genuine = await fixture.send(real, taskId, 'genuine')
      return new Checks()
        .eq(attack.errorCode, 'E_CAP_INVALID', '伪造那次的 code')
        .eq(
          attack.errorReason,
          'capability signature does not verify',
          '伪造那次的 reason',
        )
        .eq(genuine.receipt, 'accepted', '真 token 的 receipt')
        .eq(genuine.errorCode, undefined, '真 token 没有被 nonce 拒掉')
        .done('伪造不消耗真 token 的 nonce')
    },
  },
]
