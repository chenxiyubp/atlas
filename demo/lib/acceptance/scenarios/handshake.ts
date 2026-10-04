// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 握手维度。
 *
 * **读断言之前先知道这条事实：wire 上分辨不出握手失败的种类。**
 * 十二种拒绝（错 PSK、坏签名、未知签名者、缺 credential、证书过期……）
 * 在线上全部是 `4003 / 'unauthorized'`，服务端在握手完成前**从不发 error 帧**。
 * 所以每条场景的断言分两层：
 *
 *   ① 线上那层 —— 关闭码（这是发起方唯一能看到的）；
 *   ② 节点那层 —— 审计链里 `auth_rejected` 记录的 `code`，**但只有五种理由
 *      进链**（见 `observe.ts` 的 `AUDITED_HANDSHAKE_REJECTIONS`）。
 *
 * 把两层写死在断言里，是为了让「哪些失败可归因」这件事本身也被钉住：
 * 有人往 `HANDSHAKE_AUDITED` 里加一种或去掉一种，`rejection-attributable`
 * 会立刻变红。
 */

import { generateNodeKeyPair } from '@qianmo/capability'
import { newChannelId } from '@qianmo/transport'
import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK, WRONG_PSK } from '../local/driver.js'
import { bogusEnvelopeFrame, malformedFrame, rawDial } from '../local/dial.js'
import {
  AUDITED_HANDSHAKE_REJECTIONS,
  delay,
  handshakeRejections,
  waitForRejection,
} from '../observe.js'
import type { Scenario } from '../types.js'
import { newParty, startNodeTrusting } from './fixtures.js'

const CLOSE_UNAUTHORIZED = 4003
const CLOSE_PROTOCOL_ERROR = 1002
const CLOSE_CHANNEL_CONFLICT = 4004
const CLOSE_NORMAL = 1000

export const handshakeScenarios: readonly Scenario[] = [
  {
    id: 'handshake/psk-ok',
    dimension: 'handshake',
    title: 'psk 档：正确的 PSK 握手成功',
    expected: '拿到 ready 帧、连接不被拒绝关闭',
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party)
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        settleMs: 300,
      })
      return new Checks()
        .expect(probe.authed, '握手完成（收到 ready 帧）', probe.authed)
        .expect(
          probe.closeCode === CLOSE_NORMAL || probe.closeCode === undefined,
          '不是被拒绝关闭的',
          probe.closeCode,
        )
        .note('frames', probe.frames.join('\n'))
        .done('psk 档握手成功')
    },
  },

  {
    id: 'handshake/psk-wrong',
    dimension: 'handshake',
    title: 'psk 档：错的 PSK 被 4003 拒绝',
    expected: `关闭码 ${CLOSE_UNAUTHORIZED}、reason 'unauthorized'、且没有 ready 帧`,
    // `attach-node` 而不是 `spawn-node`：错 PSK 这件事的材料全在**发起方**
    // 手里，节点是什么配置、信任谁都不影响判定 —— 它只需要一台活着的节点。
    // 写成 `spawn-node` 会让真机腿白白跳掉它，而那条腿本来一条数据面场景都
    // 没有（issue #61 的第二条佐证）。`read-node-files` 是补声明的：下面那句
    // `handshakeRejections` 本来就在读节点上的审计链。
    requires: ['attach-node', 'raw-dial', 'read-node-files'],
    timeoutMs: 120_000,
    async run(ctx) {
      const party = newParty()
      // `attach: true` 是 `requires` 里那个 `attach-node` 在驱动那一侧的对应物：
      // 真机腿据此去**附着部署好的那台内测节点**，而不是给这条场景现起一个
      // 一次性的。少了它这条腿就再也碰不到生产数据面了。
      const node = await startNodeTrusting(ctx, party, { attach: true })
      // 经 `ctx.driver.dial` 而不是直接 `rawDial`：真机腿的端点是按主机分配的
      // 隧道口，只有驱动知道该往哪儿拨。
      const probe = await ctx.driver.dial(ctx, node, {
        auth: { mode: 'psk', psk: WRONG_PSK },
        nodeName: party.peerNode,
        settleMs: 300,
      })
      await delay(500)
      const audited = await handshakeRejections(ctx.driver, node)
      return (
        new Checks()
          .note('端点', node.endpoint)
          .expect(!probe.authed, '没有握手成功', probe.authed)
          .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
          .eq(probe.closeReason, 'unauthorized', '关闭原因')
          // 这条不是断言而是留痕：bad_mac **不在** HANDSHAKE_AUDITED 里，
          // 所以一次错 PSK 在节点上不留任何痕迹。归因边界由
          // `handshake/rejection-attributable` 那条负责钉。
          .note('审计链里的握手拒绝（bad_mac 预期不在其中）', audited)
          .done('错 PSK 被 4003 拒绝')
      )
    },
  },

  {
    id: 'handshake/signature-ok',
    dimension: 'handshake',
    title: 'signature 档：受信任的签名握手成功',
    expected: '拿到 ready 帧',
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'signature', psk: ACCEPTANCE_PSK, keys: party.peerKeys },
        settleMs: 300,
      })
      return new Checks()
        .expect(probe.authed, '握手完成', probe.authed)
        .note('frames', probe.frames.join('\n'))
        .done('signature 档握手成功')
    },
  },

  {
    id: 'handshake/signature-bad',
    dimension: 'handshake',
    title: 'signature 档：签名不对被拒，且审计链记下 bad_signature',
    expected: `4003；审计链出现 code='bad_signature'`,
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      // 名字是受信任的那个，钥匙不是 —— 这才测得到「签名不验证通过」，
      // 换个名字测到的是 unknown_signer，两条是不同的分支。
      const impostor = generateNodeKeyPair()
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'signature', psk: ACCEPTANCE_PSK, keys: impostor },
        settleMs: 300,
      })
      const audited = await waitForRejection(ctx, node, 'bad_signature')
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .expect(
          audited,
          '审计链里出现 bad_signature',
          await handshakeRejections(ctx.driver, node),
        )
        .done('坏签名被拒且可归因')
    },
  },

  {
    id: 'handshake/unknown-signer',
    dimension: 'handshake',
    title: 'signature 档：签名者不在信任集被拒',
    expected: `4003；审计链出现 code='unknown_signer'`,
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const probe = await rawDial({
        url: node.endpoint,
        node: 'never-trusted',
        auth: {
          kind: 'signature',
          psk: ACCEPTANCE_PSK,
          keys: generateNodeKeyPair(),
        },
        settleMs: 300,
      })
      const audited = await waitForRejection(ctx, node, 'unknown_signer')
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .expect(
          audited,
          '审计链里出现 unknown_signer',
          await handshakeRejections(ctx.driver, node),
        )
        .done('未知签名者被拒且可归因')
    },
  },

  {
    id: 'handshake/credential-half',
    dimension: 'handshake',
    title: 'credential 档：只给 credential 不给 proof 被拒',
    expected: `4003；审计链出现 code='credential_required'`,
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: {
          kind: 'half_credential',
          psk: ACCEPTANCE_PSK,
          keys: party.peerKeys,
          selector: 'sha256:acceptance-selector',
        },
        settleMs: 300,
      })
      const audited = await waitForRejection(ctx, node, 'credential_required')
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .expect(
          audited,
          '审计链里出现 credential_required',
          await handshakeRejections(ctx.driver, node),
        )
        .done('半截 credential 被拒')
    },
  },

  {
    id: 'handshake/credential-without-signature',
    dimension: 'handshake',
    title: 'credential 档：带 credential 却不带 sig 被拒',
    expected: '4003（对端有 signing 时按 bad_signature 处理）',
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: {
          kind: 'credential_without_sig',
          psk: ACCEPTANCE_PSK,
          credential: {
            selector: 'sha256:acceptance',
            source: 'certificate',
            id: 'F1',
          },
        },
        settleMs: 300,
      })
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .done('缺 sig 的 credential 被拒')
    },
  },

  {
    id: 'handshake/envelope-before-auth',
    dimension: 'handshake',
    title: '未握手就发 Envelope → CLOSE_UNAUTHORIZED 4003',
    expected: `关闭码 ${CLOSE_UNAUTHORIZED}、reason 'unauthorized'`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party)
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'none' },
        sendBeforeAuth: [bogusEnvelopeFrame()],
        settleMs: 300,
      })
      return new Checks()
        .expect(!probe.authed, '没有握手成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .eq(probe.closeReason, 'unauthorized', '关闭原因')
        .note('收到的帧', probe.frames.join('\n'))
        .done('未授权信封被 4003 挡住')
    },
  },

  {
    id: 'handshake/malformed-before-auth',
    dimension: 'handshake',
    title: '未握手就发解析不了的帧 → CLOSE_PROTOCOL_ERROR 1002',
    expected: `关闭码 ${CLOSE_PROTOCOL_ERROR}（不是 4003 —— 解析失败与「帧不对」是两条分支）`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party)
      const probe = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'none' },
        sendBeforeAuth: [malformedFrame()],
        settleMs: 300,
      })
      return new Checks()
        .eq(probe.closeCode, CLOSE_PROTOCOL_ERROR, '关闭码')
        .eq(
          probe.closeReason,
          'unauthorized',
          '关闭原因（握手前仍是 unauthorized）',
        )
        .done('畸形帧按 1002 处理')
    },
  },

  {
    id: 'handshake/channel-conflict-peer-node',
    dimension: 'handshake',
    title: '冻结四元组 · peerNode 腿变化 → 4004',
    expected: `关闭码 ${CLOSE_CHANNEL_CONFLICT}、reason 'logical channel identity conflict'`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party)
      const channelId = newChannelId()
      // 第一条连接必须**还活着**：清掉出站队列后的通道会被立刻释放，
      // 串行地「拨完再拨」根本触发不了冲突（这个坑真踩过）。
      const holder = rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        channelId,
        settleMs: 6_000,
      })
      await delay(1_000)
      const intruder = await rawDial({
        url: node.endpoint,
        node: 'another-node',
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        channelId,
        settleMs: 400,
      })
      const first = await holder
      return new Checks()
        .expect(first.authed, '第一条连接握手成功并持有通道', first.authed)
        .expect(!intruder.authed, '第二条没有握手成功', intruder.authed)
        .eq(intruder.closeCode, CLOSE_CHANNEL_CONFLICT, '关闭码')
        .eq(
          intruder.closeReason,
          'logical channel identity conflict',
          '关闭原因',
        )
        .done('换节点名重用通道被 4004 挡住')
    },
  },

  {
    id: 'handshake/channel-conflict-authentication',
    dimension: 'handshake',
    title: '冻结四元组 · authentication 腿变化 → 4004',
    expected: `同一节点名换档位重用通道 → ${CLOSE_CHANNEL_CONFLICT}`,
    requires: ['spawn-node', 'raw-dial'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      const channelId = newChannelId()
      const holder = rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        channelId,
        settleMs: 6_000,
      })
      await delay(1_000)
      const upgraded = await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'signature', psk: ACCEPTANCE_PSK, keys: party.peerKeys },
        channelId,
        settleMs: 400,
      })
      const first = await holder
      return new Checks()
        .expect(first.authed, '第一条（psk 档）握手成功', first.authed)
        .expect(
          !upgraded.authed,
          '第二条（signature 档）没有握手成功',
          upgraded.authed,
        )
        .eq(upgraded.closeCode, CLOSE_CHANNEL_CONFLICT, '关闭码')
        .eq(
          upgraded.closeReason,
          'logical channel identity conflict',
          '关闭原因',
        )
        .done('换认证档位重用通道被 4004 挡住')
    },
  },

  {
    id: 'handshake/rejection-attributable',
    dimension: 'handshake',
    title: '可归因的握手拒绝恰好是那五种（可观测边界）',
    expected:
      '审计链只收 channel_identity_mismatch / bad_credential_proof / unknown_signer / bad_signature / credential_required；bad_mac 等不进链',
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, { signHandshake: true })
      // 一次制造两类：进链的（unknown_signer）与不进链的（bad_mac）。
      await rawDial({
        url: node.endpoint,
        node: 'never-trusted',
        auth: {
          kind: 'signature',
          psk: ACCEPTANCE_PSK,
          keys: generateNodeKeyPair(),
        },
        settleMs: 200,
      })
      await rawDial({
        url: node.endpoint,
        node: party.peerNode,
        auth: { kind: 'psk', psk: WRONG_PSK },
        settleMs: 200,
      })
      await delay(1_000)
      const audited = await handshakeRejections(ctx.driver, node)
      const checks = new Checks()
        .note('审计链里的握手拒绝', audited)
        .expect(
          audited.includes('unknown_signer'),
          'unknown_signer 进链',
          audited,
        )
        .expect(
          !audited.includes('bad_mac'),
          'bad_mac 不进链（错 PSK 在节点上不留痕迹，这是当前的可观测边界）',
          audited,
        )
      for (const rejection of audited) {
        checks.expect(
          AUDITED_HANDSHAKE_REJECTIONS.includes(rejection),
          `${rejection} 在已记录的可归因集合内`,
          AUDITED_HANDSHAKE_REJECTIONS,
        )
      }
      return checks.done('可归因边界与代码一致')
    },
  },
]

// ---------------------------------------------------------------------------
// 冻结四元组剩下的两条腿
//
// 前两条（`peerNode` / `authentication`）在上面的数组里，只要 psk 与 signature
// 两档就造得出来。剩下两条只在 `--trust-ca` 那条路上才有形状 —— `credential`
// 这一格在 `--trust` 档上恒为 `(explicit, <节点名>)`，换 selector 也不动它。
// ---------------------------------------------------------------------------

import {
  certificateFixture,
  dialWithCertificate,
  opensslGate,
  startCaOnlyNode,
} from './certificate.js'
import {
  issueCertificate,
  publishAgentCertificate,
  publishRevocationList,
  signRevocationList,
} from '../ca.js'
import { readFileSync as readSource } from 'node:fs'
import { join as joinPath } from 'node:path'
import { REPO_ROOT } from '../local/spawn.js'
export const credentialChannelScenarios: readonly Scenario[] = [
  {
    id: 'handshake/channel-conflict-credential',
    dimension: 'handshake',
    title: '冻结四元组 · credential 腿变化 → 4004',
    expected: `同一节点、同一把签名钥匙，换一张证书重用通道 → ${CLOSE_CHANNEL_CONFLICT}；审计链记 channel_identity_mismatch`,
    requires: [
      'spawn-node',
      'raw-dial',
      'exec-node-cli',
      'read-node-files',
      'local-ca-fixture',
    ],
    timeoutMs: 300_000,
    async run(ctx) {
      const checks = new Checks()
      const fixture = await certificateFixture(ctx)
      const skipReason = await opensslGate(checks, fixture.host)
      if (skipReason !== undefined) return checks.skip(skipReason)

      // 同一个配置根签两次：Ed25519 身份是 `wx` 创建、永不覆盖，所以两张证书
      // 绑的是**同一把签名钥匙**，四元组里只有 credential 那一格不同。
      const first = await issueCertificate(fixture.ca, {
        node: 'ctl',
        configRoot: fixture.peerConfig,
        outName: 'cert-one.crt',
      })
      const second = await issueCertificate(fixture.ca, {
        node: 'ctl',
        configRoot: fixture.peerConfig,
        outName: 'cert-two.crt',
      })
      const rl = await signRevocationList(fixture.ca)
      await publishRevocationList(fixture.registryUrl, rl)
      await publishAgentCertificate(fixture.registryUrl, {
        address: 'qianmo://ctl/op',
        endpoint: 'ws://127.0.0.1:1',
        publicKey: first.nodePublicKey,
        certificate: first.pem,
      })
      await publishAgentCertificate(fixture.registryUrl, {
        address: 'qianmo://ctl/spare',
        endpoint: 'ws://127.0.0.1:2',
        publicKey: second.nodePublicKey,
        certificate: second.pem,
      })
      const node = await startCaOnlyNode(ctx, fixture)

      const channelId = newChannelId()
      // 第一条连接必须还活着 —— 与上面两条同一个坑：通道空了就被释放。
      const holder = dialWithCertificate(node, first, {
        channelId,
        settleMs: 6_000,
      })
      await delay(1_000)
      const intruder = await dialWithCertificate(node, second, {
        channelId,
        settleMs: 400,
      })
      const held = await holder
      await delay(500)
      const audited = await handshakeRejections(ctx.driver, node)

      return checks
        .note('夹具位置', fixture.host.describe)
        .note('第一张证书指纹', first.fingerprint256)
        .note('第二张证书指纹', second.fingerprint256)
        .expect(
          first.keys.publicKey === second.keys.publicKey,
          '两张证书绑定同一把签名钥匙（隔离出 credential 这一格）',
          `${first.keys.publicKey} / ${second.keys.publicKey}`,
        )
        .expect(held.authed, '第一条连接握手成功并持有通道', held.authed)
        .expect(!intruder.authed, '第二条没有握手成功', intruder.authed)
        .eq(intruder.closeCode, CLOSE_CHANNEL_CONFLICT, '关闭码')
        .eq(
          intruder.closeReason,
          'logical channel identity conflict',
          '关闭原因',
        )
        .expect(
          audited.includes('channel_identity_mismatch'),
          '审计链里出现 channel_identity_mismatch',
          audited,
        )
        .done('换证书重用通道被 4004 挡住')
    },
  },

  {
    id: 'handshake/channel-conflict-signing-key',
    dimension: 'handshake',
    title:
      '冻结四元组 · signingPublicKey 腿：本地腿造不出（并附一条防回潮的检查）',
    expected:
      '要么这条链路仍然造不出来（记 skip 并说明），要么产品新增了让它造得出来的开关 —— 那时这条必须变红，提醒把场景补上',
    requires: ['read-repo-source'],
    timeoutMs: 60_000,
    async run(ctx) {
      // 为什么造不出来，逐条：
      //   · `--trust <节点>=<公钥>` 是一张静态表，一个节点只有一个公钥，
      //     进程活着期间不会变；
      //   · `--trust-ca` 那条路上公钥来自证书，而 `credential` 的 selector 就是
      //     那张证书的指纹 —— 换公钥必然同时换指纹，两条腿一起动，隔离不出来；
      //   · 证书目录只在**启动时**同步拉一次，随后按 `DEFAULT_REGISTRY_POLL_
      //     INTERVAL_MS`（一小时）轮询，而重启会把在持的那条连接一起带走 ——
      //     「同一条通道上换一把签名钥匙」因此没有落点。
      // 于是这条腿由 `packages/transport/test/retained-channel-auth.test.ts`
      // 用一个手写的 HandshakeCredentialDirectory 覆盖，那里能在两次拨号之间
      // 换答案。这条场景负责的是**别让这个结论悄悄过期**。
      const source = readSource(
        joinPath(REPO_ROOT, 'src/cli/handlers/resident.ts'),
        'utf8',
      )
      const pollConstant =
        /DEFAULT_REGISTRY_POLL_INTERVAL_MS\s*=\s*([0-9_]+)/.exec(source)?.[1]
      // 出现任何「让轮询间隔可配」的命令行开关，这条结论就作废了。
      const pollFlag = /--registry-poll[a-z-]*/.exec(source)?.[0]
      const unitTest = readSource(
        joinPath(
          REPO_ROOT,
          'packages/transport/test/retained-channel-auth.test.ts',
        ),
        'utf8',
      )
      ctx.log(`poll interval constant = ${pollConstant ?? '(没找到)'}`)

      const checks = new Checks()
        .note('轮询间隔常量', pollConstant ?? '(没找到)')
        .note('命令行上的轮询开关', pollFlag ?? '(没有)')
        .expect(
          unitTest.includes('signingPublicKey') ||
            unitTest.includes('secondKeys'),
          'transport 的单测仍然覆盖着这条腿（本地腿放弃它的前提）',
          unitTest.includes('secondKeys'),
        )
      if (pollFlag !== undefined) {
        return checks
          .expect(
            false,
            `产品新增了 ${pollFlag}：证书目录能在两次拨号之间换答案了，这条腿从此造得出来，请把本场景改写成真实断言`,
            pollFlag,
          )
          .done('结论过期')
      }
      return checks.skip(
        '本地腿造不出：--trust 是静态表；--trust-ca 那条路上公钥与 credential 指纹绑死、换一个必然换另一个；证书目录只在启动时同步一次、之后每小时轮询，而重启会带走在持连接。这条腿由 packages/transport/test/retained-channel-auth.test.ts 用手写目录覆盖。',
      )
    },
  },
]
