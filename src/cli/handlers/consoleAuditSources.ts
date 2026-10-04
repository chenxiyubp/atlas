// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台的审计来源：每个 `--audit` 一个只读端口，连同见证验签用的节点公钥从哪来
 * （K-11 F-3，并入 tenancy-m1.md P15.8）。从 `console.ts` 拆出来，是为了让测试从
 * argv 一路走到验签结论，走的就是 `runConsole` 那一条路。
 *
 * **不从注册中心的名册取。**此前控制台带 `--anchors` 时，拿名册里那条记录的
 * `publicKey` 去验锚点签名。名册是谁都能写的公告板（写 token 之前零鉴权；有了写
 * token，也只说明写的人拿着 token，不说明那把钥是节点的）：把某节点的钥换成自己的，
 * 再配一套自签锚点，一条被改写的审计链就会在页面上显示为「完整」——真锚点因为
 * 「签名不对」被丢掉，篡改检测整个失声。
 *
 * 现在只有两个来源，都要运维在控制台这一侧确立：
 *
 * 1. `--trust <node>=<publicKey>`，与节点侧 `--trust` 同一个形状；
 * 2. `--trust-ca`：名册里的**证书**，经本地 CA 根校验、且吊销清单新鲜时才用
 *    （`CertificateDirectory`，与节点侧准入同一个类、同一套降级规则）。名册在这里
 *    只是证书的搬运工，伪造的证书过不了 CA 校验。
 *
 * 两者都给时显式条目恒胜（§8.2）。
 *
 * **刷新按需、限频**：第一次查询时拉一次，之后最多每分钟一次。控制台没有常驻
 * 轮询器，这里也不开定时器——页面没人看时不打注册中心；有人看时，吊销与新证书
 * 在一分钟内生效。
 */

import type { ConsoleAuditSource, ConsoleResult } from '@qianmo/console'
import {
  StaticPublicKeyDirectory,
  type PublicKeyDirectory,
} from '@qianmo/capability'
import { CertificateDirectory } from '../../services/qianmo/certificateDirectory.js'
import type { ConsoleCliConfig } from './consoleArgs.js'
import { createAuditPort } from './consolePorts.js'

/** 两次向注册中心拉证书与吊销清单之间至少隔多久。 */
const CERTIFICATE_REFRESH_INTERVAL_MS = 60_000

interface WitnessKeyOptions {
  /** `--trust` 的条目。 */
  readonly trusted: readonly (readonly [string, string])[]
  /** `--trust-ca` 的 PEM；不给就只有显式条目。 */
  readonly caCertificatePem?: string
  /** 证书从这里读（只读，`GET /v0/agents` 与 `GET /v0/revocation-list`）。 */
  readonly registryUrl: string
  /** 测试注入点。 */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>
  readonly now?: () => number
}

/** `createAuditPort` 的 `publicKeyOf`：只答运维在控制台这一侧确立过的钥。 */
function createWitnessKeyResolver(
  options: WitnessKeyOptions,
): (node: string) => Promise<ConsoleResult<string>> {
  const now = options.now ?? Date.now
  let directory: PublicKeyDirectory
  let refresh: () => Promise<void> = async () => {}

  if (options.caCertificatePem === undefined) {
    directory = new StaticPublicKeyDirectory(options.trusted)
  } else {
    const certificates = new CertificateDirectory({
      caCertificatePem: options.caCertificatePem,
      trusted: options.trusted,
      registryUrl: options.registryUrl,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      now,
    })
    directory = certificates
    let refreshedAt: number | null = null
    refresh = async () => {
      const at = now()
      if (
        refreshedAt !== null &&
        at - refreshedAt < CERTIFICATE_REFRESH_INTERVAL_MS
      ) {
        return
      }
      refreshedAt = at
      // 网络失败在 `refresh` 里一律吞成「沿用上一次」，不会抛到这里。
      await certificates.refresh()
    }
  }

  return async node => {
    await refresh()
    const publicKey = directory.publicKeyOf(node)
    if (publicKey === null) {
      return {
        ok: false,
        failure: {
          code: 'not_found',
          message: `没有节点 ${node} 的可信公钥（--trust 或 --trust-ca）`,
        },
      }
    }
    return { ok: true, value: publicKey }
  }
}

/**
 * 每个 `--audit` 来源一个端口，按命令行顺序。
 *
 * `caCertificatePem` 由调用方读好传进来（`console.ts` 的证书栏也要用同一份）。
 * 带 `--anchors` 时公钥只从 `--trust` 与 CA 校验过的证书来；`parseConsoleArgs` 已经
 * 拒绝了两者都没有的配置。标了 `--audit-mirror` 的来源按前缀副本比对锚点。
 */
export function consoleAuditSources(
  config: Pick<
    ConsoleCliConfig,
    'auditTargets' | 'auditMirrors' | 'anchors' | 'trusted' | 'registryUrl'
  >,
  caCertificatePem: string | undefined,
): ConsoleAuditSource[] {
  const publicKeyOf =
    config.anchors === undefined
      ? undefined
      : createWitnessKeyResolver({
          trusted: config.trusted ?? [],
          registryUrl: config.registryUrl,
          ...(caCertificatePem === undefined ? {} : { caCertificatePem }),
        })

  return config.auditTargets.map(target => {
    const mirror = config.auditMirrors.find(
      candidate => candidate.node === target.node,
    )
    return {
      node: target.node,
      audit: createAuditPort({
        path: target.path,
        ...(config.anchors === undefined ? {} : { witness: config.anchors }),
        ...(publicKeyOf === undefined ? {} : { publicKeyOf }),
        // A mirror is the node's chain as of its last pull: anchors past its
        // end are "not covered yet", not a mismatch.
        ...(mirror === undefined ? {} : { mirror: true }),
      }),
      kind: mirror === undefined ? 'authoritative' : 'mirror',
      ...(mirror === undefined ? {} : { maxLagMinutes: mirror.maxLagMinutes }),
    }
  })
}
