// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 证书维度 —— `--trust-ca` 那条路的整条链。
 *
 * 这一维和 `handshake` 维度的差别值得先说清楚：那边测的是 `--trust`
 * （一张手工分发的 `节点名 → 公钥` 表），**证书完全不参与**；这边测的是
 * 「离线 CA 签发 + 注册中心分发 + 吊销清单撤销」这条另一套机制。两条路在
 * `CertificateDirectory` 里**同时存在**，`--trust` 那条**永远压过** CA 那条
 * —— 这不是巧合，是 key-distribution.md §6.4 写下的取舍，
 * `certificate/explicit-trust-outranks-revocation` 把它连同代价一起钉住。
 *
 * 五条读断言前必须知道的事实：
 *
 * ① **一条完整的正向链有五步，缺任何一步都会得到同一个 `unknown_signer`。**
 *    `qm ca init` → `qm cert request` → `qm ca issue` → 把证书**带 certificate
 *    字段**登记进注册中心 → 把签好的吊销清单 `PUT` 上去。线上永远是
 *    `4003 / 'unauthorized'`，具体是哪一步漏了只有节点自己的审计链知道，
 *    而审计链对这五种情况记的**也是同一个 `unknown_signer`**。所以这一维的
 *    每条拒绝场景都必须配一条对照（同一次运行里另一张证书仍然通），否则
 *    「配错了」和「被拒了」在报告里长得一模一样。**对照必须在同一轮里**——
 *    分成两条场景跑在不同轮次，正是这条纪律要防的那种绿。`no-revocation-
 *    list-fails-closed` 是唯一没法用「另一张证书」当对照的（清单缺失时整条
 *    CA 路是关的，谁都通不过），它的对照落在链路上：{@link
 *    probeRegistryFromNodeHost} 先证明节点那台机器够得着注册中心（issue #86）。
 *
 * ② **没有吊销清单 = 整条 CA 路关闭**，不是「什么都没吊销」。fail closed。
 *
 * ③ **吊销的键是证书指纹，不是节点名。** 同一个节点的另一张证书不受影响 ——
 *    这正是「换证」这件事在协议里的样子。
 *
 * ④ **CA 只回答「这个主体是谁」，不回答「它能做什么」。** 所以 `--trust-ca`
 *    单独存在时，一个 CA 认得的签发者签出来的能力 token **验得过签、消息也
 *    会被投递**，但 `notice.trust` 停在 `untrusted` —— 授权名单只有 `--trust`
 *    与本节点自己。`certificate/verified-signature-is-not-authorization` 是
 *    这一条的落点，也是「验得了签 ≠ 是授权方」这个说法唯一成立的形态。
 *
 * ⑤ **这一维的每条路径都是目标机上的路径。** CA 目录、CSR、证书、节点配置根
 *    全部由 {@link ExecHost} 在被测 CLI 那台机器上造出来，场景一行 `node:fs`
 *    都不用、也不知道驱动把节点根放在哪。此前这里直接拼 `join(ctx.workdir,
 *    'node-<名>', 'config')` —— 那是本地驱动的内部布局，`requires` 里写的
 *    是 `local-ca-fixture` 而真正的耦合是「知道 LocalDriver 把根放在哪」
 *    （issue #65）。这一层耦合一旦留着，下一个把它搬上真机的人会得到一条
 *    「节点起来了、证书目录空着」的假红。
 */

import { CapabilityLevel } from '@qianmo/protocol'
import { Checks, stripMinifiedSourceFrame } from '../checks.js'
import { rawDial } from '../local/dial.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import {
  initCa,
  issueCertificate,
  issueExpiredCertificate,
  opensslVersion,
  publishAgentCertificate,
  publishRevocationList,
  signRevocationList,
  tlsKeyPath,
  type CaHandle,
  type IssuedCertificate,
} from '../ca.js'
import { mint, sendEnvelope, type Issuer, receiptScene } from '../local/send.js'
import { delay, handshakeRejections, waitForMailbox } from '../observe.js'
import type {
  ExecHost,
  NodeHandle,
  Scenario,
  ScenarioContext,
} from '../types.js'
import {
  ADDRESS,
  AGENT,
  NODE,
  SENDER,
  SENDER_NODE,
  TEAM,
  newTaskId,
  nodeSpec,
} from './fixtures.js'
const CLOSE_UNAUTHORIZED = 4003
const CLOSE_NORMAL = 1000

/** 对端节点的配置根名 —— 同一个根 = 同一把 Ed25519 身份钥匙。 */
const PEER_CONFIG = 'peer-config'
/** 将来那个被测节点自己的配置根名（`--cert` 那两条要它，见 K-2）。 */
const NODE_CONFIG = 'node-config'

/**
 * 一套签发链的家当，全部落在**被测 CLI 那台机器**上。
 *
 * `host` 是经 `execHost(ctx, { forNodeSpawn: true })` 拿到的执行位 —— 那个
 * `forNodeSpawn` 是承重的：它保证夹具与本场景后面起的一次性节点同机，否则
 * `--trust-ca` 指的是另一台机器上的一条路径。
 */
export interface CaFixture {
  readonly host: ExecHost
  readonly ca: CaHandle
  /** 对端（`ctl`）的配置根，目标机上的绝对路径。 */
  readonly peerConfig: string
  /** 将来那个被测节点自己的配置根，目标机上的绝对路径。 */
  readonly nodeConfig: string
}

export interface CertificateFixture extends CaFixture {
  /** **runner 侧**的注册中心基址 —— 场景自己 PUT / POST 用这个。 */
  readonly registryUrl: string
  /**
   * **节点那台机器上**的注册中心基址 —— 喂 `--registry-url` 用这个。
   *
   * 本地腿两者相同；真机腿上节点在舰队机器里，它拨的是一条反向隧道的入口。
   * 把 `registryUrl` 喂给它等于让那台机器去打它自己的某个空端口，而现场是
   * 每一次 CA 握手都以 `unknown_signer` 收场。
   */
  readonly registryHostUrl: string
}

/** 只要签发链，不要注册中心（`--cert` 那两条场景根本不拉证书目录）。 */
export async function caFixture(ctx: ScenarioContext): Promise<CaFixture> {
  const host = await ctx.driver.execHost(ctx, { forNodeSpawn: true })
  const ca = await initCa(host)
  return {
    host,
    ca,
    peerConfig: await host.mkdir(PEER_CONFIG),
    nodeConfig: await host.mkdir(NODE_CONFIG),
  }
}

export async function certificateFixture(
  ctx: ScenarioContext,
): Promise<CertificateFixture> {
  const base = await caFixture(ctx)
  const registry = await ctx.driver.startRegistry(ctx)
  return {
    ...base,
    registryUrl: registry.url,
    registryHostUrl: registry.hostUrl,
  }
}

/**
 * 起一个只认 CA、**一条 `--trust` 都不给**的严格握手节点。
 *
 * 不走 `startNodeTrusting`：那个 helper 一定会发 `--trust`，而显式信任会
 * 短路掉整条证书路径（有效期不看、吊销不查），于是每一条本该红的场景都会
 * 变绿。这条区别是这一维最容易搞砸的地方。
 */
export async function startCaOnlyNode(
  ctx: ScenarioContext,
  fixture: CertificateFixture,
  options: {
    readonly trust?: readonly string[]
    readonly signHandshake?: boolean
  } = {},
): Promise<NodeHandle> {
  return await ctx.driver.startNode(
    ctx,
    nodeSpec(ctx, {
      policy: 'open',
      ...(options.signHandshake === false
        ? {}
        : { requireSignedHandshake: true }),
      ...(options.trust === undefined ? {} : { trust: options.trust }),
      extraArgs: [
        '--trust-ca',
        fixture.ca.certificatePath,
        '--registry-url',
        fixture.registryHostUrl,
      ],
    }),
  )
}

/** 用证书的指纹当 selector 拨一次 credential 档握手。 */
export async function dialWithCertificate(
  node: NodeHandle,
  certificate: IssuedCertificate,
  options: { readonly channelId?: string; readonly settleMs?: number } = {},
) {
  return await rawDial({
    url: node.endpoint,
    node: certificate.node,
    auth: {
      kind: 'credential_signature',
      psk: ACCEPTANCE_PSK,
      keys: certificate.keys,
      credential: {
        selector: certificate.fingerprint256,
        source: 'certificate',
        id: certificate.fingerprint256,
      },
    },
    ...(options.channelId === undefined
      ? {}
      : { channelId: options.channelId }),
    settleMs: options.settleMs ?? 500,
  })
}

/**
 * openssl 拿不到就整条维度没法跑 —— 如实 skip，别假装覆盖。
 *
 * 问的是**目标机**的 openssl，不是 runner 的：`qm ca` 在哪台机器上跑，就由
 * 哪台机器的 openssl 说了算。
 */
export async function opensslGate(
  checks: Checks,
  host: ExecHost,
): Promise<string | undefined> {
  const version = await opensslVersion(host)
  checks.note('openssl', `${host.describe}: ${version ?? '(跑不动)'}`)
  return version === null
    ? `${host.describe} 上没有可用的 openssl；qm ca 的签发链跑不起来（这是 CA 工具的外部依赖，不是被测系统的缺陷）`
    : undefined
}

/** {@link probeRegistryFromNodeHost} 的一次探测结果。 */
interface RegistryProbe {
  /** curl 自己的退出码；连不上是非 0（拒连 7、超时 28），HTTP 4xx/5xx 仍是 0。 */
  readonly exitCode: number
  /** HTTP 状态码；一个字节都没收到时是 0。 */
  readonly status: number
  /** 响应体原文。 */
  readonly body: string
}

/**
 * 从**节点那台机器**上打一次注册中心。
 *
 * ## 它存在的理由：把两种失败分开（issue #86）
 *
 * 这一维的每条拒绝场景都要一条同轮对照（头注 ①）。`no-revocation-list-fails-
 * closed` 没法用「另一张证书仍然通」那种对照 —— 清单缺失时整条 CA 路是关的，
 * 谁都通不过。于是它剩下的唯一同轮对照就是**链路本身**：先证明节点那台机器
 * 够得着注册中心，再证明清单缺失导致了拒绝。少了前一半，「隧道根本没通」与
 * 「fail closed」在报告里长得完全一样 —— 两者都是每一次 CA 握手以
 * `unknown_signer` 收场，而两者都会让那条场景变绿。
 *
 * ## 必须喂 `registryHostUrl`，不是 `registryUrl`
 *
 * 见 {@link CertificateFixture.registryHostUrl}：本地腿两者相同，真机腿上前者
 * 是那台机器上一条反向隧道的入口。拿 runner 侧那个地址去 curl，验的是 runner
 * 自己够不够得着自己 —— 恒真，等于什么都没验。
 *
 * ## 为什么是 curl 而不是 `fetch`
 *
 * `fetch` 跑在 runner 进程里，够不着真机腿那条隧道的**远端**。curl 经
 * {@link ExecHost.run} 下发到目标机，两条腿上问的都是「节点那侧看到的地址」。
 * 真机腿本来就假定目标机有 curl（`FleetDriver.#reverseTunnel` 的预检就是
 * 一次远端 curl），所以这不是新增的外部依赖。
 */
async function probeRegistryFromNodeHost(
  host: ExecHost,
  url: string,
): Promise<RegistryProbe> {
  // `-w` 的格式串把状态码接在响应体后面另起一行；连不上时 curl 仍会写出
  // `000`，于是「连不上」与「HTTP 000」不会退化成同一个 undefined。
  //
  // 换行写成 `\n` 两个字符交给 curl 自己转义，**不要**在 argv 里塞一个真
  // 换行：真机腿的 `run` 把整条命令拼成一个字符串交给 ssh 的远端 shell
  // （`FleetDriver.#ssh` 的 `lines.join('\n')`），argv 里的真换行虽然此刻
  // 被单引号护着仍然成立，但那条命令从此就依赖「谁都不会按行再处理它」。
  const result = await host.run(
    ['curl', '-sS', '--max-time', '10', '-w', '\\n%{http_code}', url],
    { timeoutMs: 60_000 },
  )
  const cut = result.stdout.lastIndexOf('\n')
  const tail = cut === -1 ? result.stdout : result.stdout.slice(cut + 1)
  const status = Number.parseInt(tail.trim(), 10)
  return {
    exitCode: result.code,
    status: Number.isNaN(status) ? 0 : status,
    body: cut === -1 ? '' : result.stdout.slice(0, cut),
  }
}

/**
 * 在**目标机**的一个一次性配置根里起一条会自己退出的 `qm resident`，用来测
 * 启动期的拒绝。
 *
 * `configDir` 给了就用它 —— `--cert` 的那条 K-2 检查要求证书绑的是**这个根
 * 里**的身份，所以证书签在哪个根里，就得拿哪个根去起。
 */
async function residentStartupProbeOn(
  host: ExecHost,
  extraArgs: readonly string[],
  configDir?: string,
): Promise<{ readonly code: number; readonly output: string }> {
  const workspace = await host.mkdir('probe-ws')
  const result = await host.exec(
    [
      'resident',
      '--node',
      NODE,
      '--team',
      TEAM,
      '--agent',
      `${AGENT}=${workspace}`,
      '--port',
      String(await host.freePort()),
      '--hostname',
      '127.0.0.1',
      '--open-policy',
      ...extraArgs,
    ],
    {
      env: { QIANMO_TRANSPORT_PSK: ACCEPTANCE_PSK },
      timeoutMs: 120_000,
      ...(configDir === undefined ? {} : { configDir }),
    },
  )
  return {
    code: result.code,
    output: stripMinifiedSourceFrame(`${result.stdout}\n${result.stderr}`),
  }
}

export const certificateScenarios: readonly Scenario[] = [
  {
    id: 'certificate/handshake-ok',
    dimension: 'certificate',
    title: 'CA 签发 → 注册中心分发 → credential 档握手走通',
    expected:
      '一条 --trust 都不给、只给 --trust-ca 与 --registry-url 的节点接受这张证书的握手；审计链里没有拒绝记录',
    requires: [
      'spawn-node',
      'raw-dial',
      'exec-node-cli',
      'read-node-files',
      'local-ca-fixture',
    ],
    timeoutMs: 240_000,
    async run(ctx) {
      const checks = new Checks()
      const fixture = await certificateFixture(ctx)
      const skip = await opensslGate(checks, fixture.host)
      if (skip !== undefined) return checks.skip(skip)

      const certificate = await issueCertificate(fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'peer.crt',
      })
      const rl = await signRevocationList(fixture.ca)
      const rlStatus = await publishRevocationList(fixture.registryUrl, rl)
      const agentStatus = await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: certificate.nodePublicKey,
        certificate: certificate.pem,
      })
      const node = await startCaOnlyNode(ctx, fixture)
      const probe = await dialWithCertificate(node, certificate)
      await delay(500)
      const rejections = await handshakeRejections(ctx.driver, node)

      return checks
        .note('夹具位置', fixture.host.describe)
        .note('CA 指纹', fixture.ca.fingerprint256)
        .note('节点证书指纹', certificate.fingerprint256)
        .note('节点 Ed25519 公钥', certificate.nodePublicKey)
        .eq(rlStatus, 200, '发布吊销清单的 HTTP 码')
        .eq(agentStatus, 201, '登记带证书的节点的 HTTP 码')
        .expect(probe.authed, '握手完成（收到 ready 帧）', probe.authed)
        .expect(
          probe.closeCode === CLOSE_NORMAL || probe.closeCode === undefined,
          '不是被拒绝关闭的',
          probe.closeCode,
        )
        .eq(rejections.length, 0, '审计链里的握手拒绝条数')
        .note('frames', probe.frames.join('\n'))
        .done('CA 路的正向握手走通')
    },
  },

  {
    id: 'certificate/revoked-refused',
    dimension: 'certificate',
    title: '吊销的证书握不上手，同一节点的另一张证书照样能握',
    expected:
      "被吊销那张 → 4003 + 审计链 code='unknown_signer'；同一节点未吊销的那张 → 握手成功",
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
      const skip = await opensslGate(checks, fixture.host)
      if (skip !== undefined) return checks.skip(skip)

      // 同一个配置根签两次 = 同一把 Ed25519、两张不同指纹的证书。
      const revoked = await issueCertificate(fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'revoked.crt',
      })
      const replacement = await issueCertificate(fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'replacement.crt',
        // 第二张：CA 里已有这个节点的副本，重签要显式说覆盖。
        replace: true,
      })
      const rl = await signRevocationList(fixture.ca, {
        revoke: [{ node: SENDER_NODE, fingerprint256: revoked.fingerprint256 }],
      })
      await publishRevocationList(fixture.registryUrl, rl)
      // 两条登记地址、同一个节点段：证书事实表按指纹存，于是两张都进得去。
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: revoked.nodePublicKey,
        certificate: revoked.pem,
      })
      await publishAgentCertificate(fixture.registryUrl, {
        address: `qianmo://${SENDER_NODE}/spare`,
        endpoint: 'ws://127.0.0.1:2',
        publicKey: replacement.nodePublicKey,
        certificate: replacement.pem,
      })
      const node = await startCaOnlyNode(ctx, fixture)

      const withRevoked = await dialWithCertificate(node, revoked)
      const withReplacement = await dialWithCertificate(node, replacement)
      await delay(600)
      const rejections = await handshakeRejections(ctx.driver, node)

      return checks
        .note('夹具位置', fixture.host.describe)
        .note('被吊销的指纹', revoked.fingerprint256)
        .note('换发的指纹', replacement.fingerprint256)
        .note('吊销清单原文', rl)
        .expect(
          revoked.keys.publicKey === replacement.keys.publicKey,
          '两张证书绑定同一把签名钥匙（证明差别只在指纹上）',
          `${revoked.keys.publicKey} / ${replacement.keys.publicKey}`,
        )
        .expect(
          !withRevoked.authed,
          '被吊销那张没有握手成功',
          withRevoked.authed,
        )
        .eq(withRevoked.closeCode, CLOSE_UNAUTHORIZED, '被吊销那张的关闭码')
        .eq(withRevoked.closeReason, 'unauthorized', '被吊销那张的关闭原因')
        .expect(
          rejections.includes('unknown_signer'),
          "审计链里出现 code='unknown_signer'（吊销在线上与「不认识」不可分辨）",
          rejections,
        )
        .expect(
          withReplacement.authed,
          '换发那张仍然握得上（吊销的键是指纹，不是节点名）',
          withReplacement.authed,
        )
        .done('吊销按指纹生效')
    },
  },

  {
    id: 'certificate/expired-refused',
    dimension: 'certificate',
    title: '过了有效期的证书握不上手，同一节点的有效证书照样能握',
    expected:
      "过期证书 → 4003 + 审计链 code='unknown_signer'；有效证书 → 握手成功",
    requires: [
      'spawn-node',
      'raw-dial',
      'exec-node-cli',
      'read-node-files',
      'local-ca-fixture',
    ],
    timeoutMs: 300_000,
    async run(ctx) {
      const { X509Certificate } = await import('node:crypto')
      const checks = new Checks()
      const fixture = await certificateFixture(ctx)
      const skip = await opensslGate(checks, fixture.host)
      if (skip !== undefined) return checks.skip(skip)

      const valid = await issueCertificate(fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'valid.crt',
      })
      const expired = await issueExpiredCertificate(fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'expired.crt',
      })
      const rl = await signRevocationList(fixture.ca)
      await publishRevocationList(fixture.registryUrl, rl)
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: valid.nodePublicKey,
        certificate: valid.pem,
      })
      await publishAgentCertificate(fixture.registryUrl, {
        address: `qianmo://${SENDER_NODE}/stale`,
        endpoint: 'ws://127.0.0.1:2',
        publicKey: expired.nodePublicKey,
        certificate: expired.pem,
      })
      const node = await startCaOnlyNode(ctx, fixture)

      const withExpired = await dialWithCertificate(node, expired)
      const withValid = await dialWithCertificate(node, valid)
      await delay(600)
      const rejections = await handshakeRejections(ctx.driver, node)
      const parsed = new X509Certificate(expired.pem)

      return (
        checks
          .note('夹具位置', fixture.host.describe)
          .note('过期证书指纹', expired.fingerprint256)
          // 有效期原文进证据：这条断言的形状是「被拒了」，而被拒的理由在线上
          // 与在审计链上都塌缩成 unknown_signer。留着这两个日期，读报告的人
          // 才能确认被拒的那张**确实**是一张过期证书，而不是一张签坏了的。
          .note('过期证书有效期', `${parsed.validFrom} → ${parsed.validTo}`)
          .note('有效证书指纹', valid.fingerprint256)
          .expect(
            new Date(parsed.validTo).getTime() < Date.now(),
            '那张证书的 notAfter 确实已经过去',
            parsed.validTo,
          )
          .expect(
            !withExpired.authed,
            '过期证书没有握手成功',
            withExpired.authed,
          )
          .eq(withExpired.closeCode, CLOSE_UNAUTHORIZED, '过期证书的关闭码')
          .expect(
            rejections.includes('unknown_signer'),
            "审计链里出现 code='unknown_signer'（过期与「不认识」在链上也不可分辨）",
            rejections,
          )
          .expect(
            withValid.authed,
            '同一节点的有效证书仍然握得上（证明拒绝来自有效期而不是配置）',
            withValid.authed,
          )
          .done('过期证书被拒')
      )
    },
  },

  {
    id: 'certificate/no-revocation-list-fails-closed',
    dimension: 'certificate',
    title: '没有吊销清单时整条 CA 路关闭（fail closed，不是「什么都没吊销」）',
    expected:
      '同轮对照：节点那台机器 curl 得到 /v0/health 200；证书本身完全有效、也已登记，但注册中心上没有吊销清单 → 握手仍然 4003',
    requires: [
      'spawn-node',
      'raw-dial',
      'exec-node-cli',
      'read-node-files',
      'local-ca-fixture',
    ],
    timeoutMs: 240_000,
    async run(ctx) {
      const checks = new Checks()
      const fixture = await certificateFixture(ctx)
      const skip = await opensslGate(checks, fixture.host)
      if (skip !== undefined) return checks.skip(skip)

      const certificate = await issueCertificate(fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'peer.crt',
      })
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: certificate.nodePublicKey,
        certificate: certificate.pem,
      })
      // 故意**不**发布吊销清单。
      const missing = await fetch(`${fixture.registryUrl}/v0/revocation-list`)

      // 同轮对照（issue #86）。这一维每条拒绝场景都得配一条对照（头注 ①），
      // 而这一条没法用「另一张证书仍然通」那种形态 —— 清单缺失时整条 CA 路
      // 是关的，谁都通不过。所以对照落在**链路**上：先在节点那台机器上证明
      // 注册中心够得着、且答的确实是注册中心本身，再去证明清单缺失导致了
      // 拒绝。没有这一半，「隧道没通」与「fail closed」在报告里长得一模一样。
      const health = await probeRegistryFromNodeHost(
        fixture.host,
        `${fixture.registryHostUrl}/v0/health`,
      )
      const rlFromHost = await probeRegistryFromNodeHost(
        fixture.host,
        `${fixture.registryHostUrl}/v0/revocation-list`,
      )

      const node = await startCaOnlyNode(ctx, fixture)
      const probe = await dialWithCertificate(node, certificate)
      await delay(500)
      const rejections = await handshakeRejections(ctx.driver, node)

      return checks
        .note('夹具位置', fixture.host.describe)
        .note('节点那侧的注册中心地址', fixture.registryHostUrl)
        .eq(missing.status, 404, '注册中心上还没有吊销清单')
        .eq(
          health.exitCode,
          0,
          '对照：节点那台机器 curl 注册中心的退出码（非 0 = 根本够不着）',
        )
        .eq(health.status, 200, '对照：节点那台机器上 /v0/health 的 HTTP 码')
        .contains(
          health.body,
          '"status":"ok"',
          '对照：答话的确实是注册中心本身，不是那个口上的别的东西',
        )
        .eq(
          rlFromHost.status,
          404,
          '对照：从节点那台机器看，吊销清单也确实是 404（不是拉不到）',
        )
        .expect(!probe.authed, '握手没有成功', probe.authed)
        .eq(probe.closeCode, CLOSE_UNAUTHORIZED, '关闭码')
        .expect(
          rejections.includes('unknown_signer'),
          "审计链里出现 code='unknown_signer'",
          rejections,
        )
        .note(
          '为什么是这样',
          'handshakeCredentialOf 第一行就是 `if (selector === undefined || !this.#rlFresh()) return null`：拉不到清单时有效凭据集退回只剩 --trust 那几条。撤销机制不可用时宁可谁都不认，也不认一份可能已经作废的名单。',
        )
        .done('链路通着、清单缺着 → fail closed')
    },
  },

  {
    id: 'certificate/explicit-trust-outranks-revocation',
    dimension: 'certificate',
    title: '仍被 --trust 钉着的对端，吊销对它无效（§6.4 写明的边界）',
    expected:
      '同一张已吊销的证书：只给 --trust-ca 时被拒；同时把该节点写进 --trust 时被放行',
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
      const skip = await opensslGate(checks, fixture.host)
      if (skip !== undefined) return checks.skip(skip)

      const certificate = await issueCertificate(fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'peer.crt',
      })
      const rl = await signRevocationList(fixture.ca, {
        revoke: [
          { node: SENDER_NODE, fingerprint256: certificate.fingerprint256 },
        ],
      })
      await publishRevocationList(fixture.registryUrl, rl)
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: certificate.nodePublicKey,
        certificate: certificate.pem,
      })

      const caOnly = await startCaOnlyNode(ctx, fixture)
      const refused = await dialWithCertificate(caOnly, certificate)
      await ctx.driver.stopNode(caOnly)

      const pinned = await startCaOnlyNode(ctx, fixture, {
        trust: [`${SENDER_NODE}=${certificate.nodePublicKey}`],
      })
      const admitted = await dialWithCertificate(pinned, certificate)

      return checks
        .note('夹具位置', fixture.host.describe)
        .note('被吊销的指纹', certificate.fingerprint256)
        .expect(!refused.authed, '只给 --trust-ca 时被拒', refused.authed)
        .eq(refused.closeCode, CLOSE_UNAUTHORIZED, '只给 --trust-ca 时的关闭码')
        .expect(
          admitted.authed,
          '同时写进 --trust 时被放行（显式信任短路整条证书路径）',
          admitted.authed,
        )
        .note(
          '这条为什么是绿的',
          '显式 --trust 条目在 handshakeCredentialOf 里排在最前面并直接返回，既不看有效期也不查吊销。所以要真正把一个节点摘出去，必须**同时**删掉 --trust 条目并发布吊销清单 —— 只做后一半是无效操作（key-distribution.md §6.4）。',
        )
        .done('显式信任压过吊销，代价已被钉住')
    },
  },

  {
    id: 'certificate/registry-url-requires-trust-ca',
    dimension: 'certificate',
    title: '--registry-url 没有 --trust-ca 时在解析期就被拒',
    expected: "非零退出 + '--registry-url requires --trust-ca'",
    requires: ['exec-node-cli'],
    timeoutMs: 180_000,
    async run(ctx) {
      // 注册中心是零鉴权的，它给出的证书与吊销清单只有 CA 签名这一道验证。
      // 没有 CA 根就去信它，等于把「谁是谁」交给任何能打到那个端口的人。
      const host = await ctx.driver.execHost(ctx)
      const probe = await residentStartupProbeOn(host, [
        '--registry-url',
        'http://127.0.0.1:1',
      ])
      return new Checks()
        .note('执行位置', host.describe)
        .note('输出', probe.output.slice(0, 1_500))
        .expect(probe.code !== 0, '退出码非零', probe.code)
        .contains(
          probe.output,
          '--registry-url requires --trust-ca',
          '错误输出',
        )
        .done('缺 CA 根时不许去信注册中心')
    },
  },

  {
    id: 'certificate/cert-without-trust-ca-is-plaintext',
    dimension: 'certificate',
    title: '给了 --cert/--key 却没给 --trust-ca：节点照起，但明说「这是明文」',
    expected:
      "stderr 出现 'mTLS is NOT enabled' 与 'serving plaintext ws://'，且一次普通的 ws PSK 拨号照样握得上（行为面证明它真的是明文）",
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'local-ca-fixture'],
    timeoutMs: 240_000,
    async run(ctx) {
      const checks = new Checks()
      const fixture = await caFixture(ctx)
      const skip = await opensslGate(checks, fixture.host)
      if (skip !== undefined) return checks.skip(skip)

      // 证书必须绑**本节点自己**的身份（K-2 的启动检查），所以先在节点将来
      // 会用的那个配置根里把身份与 CSR 造出来，再让驱动**用同一个根**起节点
      // —— `NodeSpec.configRoot` 存在的全部理由就是这个顺序。
      const own = await issueCertificate(fixture.ca, {
        node: NODE,
        configRoot: fixture.nodeConfig,
        outName: 'own.crt',
      })
      const node = await ctx.driver.startNode(
        ctx,
        nodeSpec(ctx, {
          policy: 'open',
          configRoot: fixture.nodeConfig,
          extraArgs: [
            '--cert',
            own.path,
            '--key',
            tlsKeyPath(fixture.nodeConfig, NODE),
          ],
        }),
      )
      const stderr = await node.stderr()
      const probe = await rawDial({
        url: node.endpoint,
        node: SENDER_NODE,
        auth: { kind: 'psk', psk: ACCEPTANCE_PSK },
        settleMs: 300,
      })

      return (
        checks
          .note('夹具位置', fixture.host.describe)
          .note('节点配置根', node.configRoot)
          .note('stderr', stderr.slice(0, 2_000))
          .contains(stderr, 'mTLS is NOT enabled', 'stderr')
          .contains(stderr, 'serving plaintext ws://', 'stderr')
          .expect(
            node.endpoint.startsWith('ws://'),
            '监听地址仍是 ws://',
            node.endpoint,
          )
          // 只断言那句告警不够 —— 要证明的是「它真的没在做 TLS」。
          .expect(probe.authed, '明文 PSK 拨号照样握得上', probe.authed)
          .note(
            '为什么这条重要',
            '三个开关只有凑齐才有 mTLS（F-10）。缺一个时节点不会拒绝启动，只会退回明文 —— 那是一台「看起来配好了」的机器，而唯一的区别只在 stderr 的这一行里。',
          )
          .done('缺 CA 根时明确退回明文而不是假装加密')
      )
    },
  },

  {
    id: 'certificate/cert-from-another-ca-refused-at-startup',
    dimension: 'certificate',
    title: '--cert 不是 --trust-ca 那个 CA 签的 → 启动期拒绝',
    expected: "非零退出 + '--cert was not signed by the CA in --trust-ca'",
    // `local-ca-fixture` 而不是只写 `exec-node-cli`：两张证书、两个 CA 目录、
    // 以及那个装着节点身份的配置根都得在**被测二进制那台机器**上，而且证书
    // 必须在起节点之前就签好。这条**不是**「能不能在目标机上跑 CLI」的问题，
    // 声明成那个就是装饰性 requires（issue #61）。
    requires: ['exec-node-cli', 'local-ca-fixture'],
    timeoutMs: 240_000,
    async run(ctx) {
      const checks = new Checks()
      const fixture = await caFixture(ctx)
      const skip = await opensslGate(checks, fixture.host)
      if (skip !== undefined) return checks.skip(skip)

      const own = await issueCertificate(fixture.ca, {
        node: NODE,
        configRoot: fixture.nodeConfig,
        outName: 'own.crt',
      })
      // 第二个 CA：证书没变，换掉的是「拿谁的根去验它」。
      const other = await initCa(fixture.host, {
        dirName: 'other-ca',
        cn: 'another-ca',
      })
      const probe = await residentStartupProbeOn(
        fixture.host,
        [
          '--cert',
          own.path,
          '--key',
          tlsKeyPath(fixture.nodeConfig, NODE),
          '--trust-ca',
          other.certificatePath,
        ],
        fixture.nodeConfig,
      )
      return checks
        .note('执行位置', fixture.host.describe)
        .note('签发证书的 CA 指纹', fixture.ca.fingerprint256)
        .note('拿去验它的 CA 指纹', other.fingerprint256)
        .note('输出', probe.output.slice(0, 1_500))
        .expect(probe.code !== 0, '退出码非零', probe.code)
        .contains(
          probe.output,
          '--cert was not signed by the CA in --trust-ca',
          '错误输出',
        )
        .done('换代 CA 的错配在启动期就被挡住')
    },
  },

  {
    id: 'certificate/verified-signature-is-not-authorization',
    dimension: 'certificate',
    title: '验得了签但不是授权方：消息照投，notice.trust 停在 untrusted',
    expected:
      "只给 --trust-ca 时，CA 认得的签发者签出的能力 token 验得过签、消息被接收，但 notice.trust='untrusted'",
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
      const skip = await opensslGate(checks, fixture.host)
      if (skip !== undefined) return checks.skip(skip)

      const certificate = await issueCertificate(fixture.ca, {
        node: SENDER_NODE,
        configRoot: fixture.peerConfig,
        outName: 'peer.crt',
      })
      const rl = await signRevocationList(fixture.ca)
      await publishRevocationList(fixture.registryUrl, rl)
      await publishAgentCertificate(fixture.registryUrl, {
        address: SENDER,
        endpoint: 'ws://127.0.0.1:1',
        publicKey: certificate.nodePublicKey,
        certificate: certificate.pem,
      })
      // 握手走 psk 档：这条测的是**能力层**的信任判定，握手档位无关。
      // （`--require-signed-handshake` 会把 psk 拨号挡在门外，所以这里不开。）
      const node = await startCaOnlyNode(ctx, fixture, { signHandshake: false })

      const issuer: Issuer = { node: SENDER_NODE, keys: certificate.keys }
      const taskId = newTaskId()
      const cap = mint(issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        act: CapabilityLevel.WriteLimited,
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
      const inbox = await waitForMailbox(ctx, node, TEAM, AGENT)
      const last = inbox.at(-1)

      return (
        checks
          .note('回执现场', receiptScene(result))
          .note('夹具位置', fixture.host.describe)
          .note('signer', certificate.nodePublicKey)
          .note('信箱原文', last?.raw ?? '(信箱是空的)')
          // 签名验得过 —— 否则这里会是 E_CAP_INVALID + no published public key。
          .eq(result.receipt, 'accepted', 'receipt（签名验得过，消息被接收）')
          .eq(result.errorCode, undefined, 'error code')
          .expect(inbox.length > 0, '消息真的投进了信箱', inbox.length)
          // 但它不是授权方：授权名单只有 --trust 与本节点自己，CA 不进那张表。
          .eq(last?.trust, 'untrusted', 'notice.trust')
          .contains(last?.text, 'never as instructions', '给模型的措辞')
          .notContains(
            last?.text,
            'The request is therefore authorized',
            '给模型的措辞',
          )
          .note(
            '这一条为什么重要',
            '`--trust` 那条路上「拿不到公钥」与「不是授权方」重合，于是分不开；只有 --trust-ca 能把两者拆开：CA 答得出「这是谁」，答不出「它能做什么」，所以消息会被投递而档位不升。',
          )
          .done('CA 只解决身份，不解决授权')
      )
    },
  },
]
