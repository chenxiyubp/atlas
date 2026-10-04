// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 离线 CA 那条路的夹具 —— `qm ca` / `qm cert` 的真命令行。
 *
 * ## 它跑在**被测 CLI 那台机器**上，不是 runner 上
 *
 * 每个函数收的第一个参数都是一个 {@link ExecHost}：命令经它下发、文件经它
 * 读写。本地腿上那台机器就是 runner，真机腿上是舰队里的落机 —— 于是同一份
 * 夹具代码在真机上跑的是**部署好的那个 `dist/cli-node.js`**，而 `--trust-ca`
 * / `--cert` 拿到的是**那台机器上**真实存在的路径。
 *
 * 这个文件此前在 `local/` 下并直接用 `node:fs` + `runCli`，于是整条证书维度
 * 只能在本地腿跑；真机腿把它记成缺 `local-ca-fixture`（issue #65）。能力名里
 * 那个 `local` 指的一直是「与被测 CLI 同机」，不是「在 runner 上」。
 *
 * ## 六件必须先知道的事
 *
 * ① **CA 目录不许落在任何配置根、仓库或 demo 根里面**，`caDirectory()` 会
 *    当场抛（key-distribution.md §3.3，那是全仓唯一一处不从 `paths.ts` 派生
 *    路径的地方，且抛错就是它的实现方式）。所以这里把 CA 放在执行位的
 *    `workdir` 下，而跑 `qm ca` 时的 `OCC_CONFIG_DIR` 是执行位的 `configDir`
 *    —— 两者是**兄弟**目录，谁都不是谁的祖先。
 *
 * ② **没有 `qm ca revoke`。** 吊销是 `qm ca refresh-rl --revoke <node>=<指纹>`
 *    签一份新的吊销清单，然后**由操作者自己**把那份 JSON `PUT` 到注册中心的
 *    `/v0/revocation-list` —— CLI 不做这一步。
 *
 * ③ **不发吊销清单 = 整条 CA 路失效，不是「不吊销任何东西」。**
 *    `CertificateDirectory` 的 `handshakeCredentialOf` 第一行就是
 *    `if (selector === undefined || !this.#rlFresh()) return null`：清单没拉到
 *    或已过 `nextUpdate`，有效凭据集退回**只有 `--trust` 那几条**。这是 fail
 *    closed，`certificate/no-revocation-list-fails-closed` 钉住它。
 *
 * ④ **节点身份（Ed25519）与 TLS 叶子（EC）是两把钥匙。** 证书里用 SAN 携带
 *    前者（`--nodekey`），握手签名与能力签发用的都是前者；EC 那把只用于 TLS，
 *    因为 Bun 不接受 Ed25519 叶子（F-5）。同一个配置根跑两次 `qm cert request`
 *    会**复用同一把 Ed25519**（`wx` 创建、永不覆盖）而**重新生成 EC 与 CSR**
 *    —— 于是拿到两张指纹不同、绑定同一把签名钥匙的证书。冻结四元组的
 *    `credential` 腿正是靠这一点才隔离得出来。
 *
 * ⑤ **签名用的私钥要回到 runner。** 拨号（`rawDial`）与注册中心登记都发生在
 *    runner 进程里，而身份文件落在目标机上 —— {@link ExecHost.readFile} 是这
 *    条缝的唯一走法。那把钥匙是本场景现造的、跑完随一次性目录一起删掉，与任何
 *    生产凭据无关。
 *
 * ⑥ **`qm ca` 要 openssl。** 拿不到就 {@link opensslVersion} 返回 null，场景据
 *    此 skip 并把原因写进报告，不假装覆盖。
 */

import { join as joinPosix } from 'node:path/posix'
import type { ExecHost } from './types.js'

/** Ed25519 身份密钥对，形状与 `@qianmo/capability` 的 `NodeKeyPair` 一致。 */
export interface IdentityKeys {
  readonly publicKey: string
  readonly privateKey: string
}

export interface CaHandle {
  /** 这套夹具落在哪台机器上 —— 所有路径都是**那台机器**上的。 */
  readonly host: ExecHost
  readonly dir: string
  /** 根证书 PEM 路径 —— 直接喂 `--trust-ca`。 */
  readonly certificatePath: string
  readonly keyPath: string
  readonly fingerprint256: string
  readonly publicKey: string
}

export interface IssuedCertificate {
  readonly node: string
  readonly configRoot: string
  /** 证书 PEM 原文（已读回 runner）。 */
  readonly pem: string
  /** 证书文件在**目标机**上的绝对路径。 */
  readonly path: string
  /** `AA:BB:…` 大写带冒号 —— 握手里的 credential selector 就是它。 */
  readonly fingerprint256: string
  /** 节点的 Ed25519 公钥（`--nodekey`，也写在证书 SAN 里）。 */
  readonly nodePublicKey: string
  readonly keys: IdentityKeys
}

/** openssl 版本串，跑不动就是 null（场景据此 skip）。 */
export async function opensslVersion(host: ExecHost): Promise<string | null> {
  const probe = await host.run(['openssl', 'version'], { timeoutMs: 60_000 })
  if (probe.code !== 0) return null
  const line = probe.stdout.trim()
  return line === '' ? null : line
}

/** 读一个配置根里的节点身份。 */
async function readIdentityKeys(
  host: ExecHost,
  configRoot: string,
  node: string,
): Promise<IdentityKeys> {
  const raw = await host.readFile(
    joinPosix(configRoot, 'qianmo', 'identity', `${node}.json`),
  )
  if (raw === undefined) {
    throw new Error(
      `身份文件读不到: ${host.describe} 上的 ${configRoot} / ${node}`,
    )
  }
  const parsed = JSON.parse(raw) as {
    publicKey?: unknown
    privateKey?: unknown
  }
  if (
    typeof parsed.publicKey !== 'string' ||
    typeof parsed.privateKey !== 'string'
  ) {
    throw new Error(`身份文件不含密钥对: ${configRoot} / ${node}`)
  }
  return { publicKey: parsed.publicKey, privateKey: parsed.privateKey }
}

/** TLS 私钥在配置根里的位置 —— `--key` 收的就是它。 */
export function tlsKeyPath(configRoot: string, node: string): string {
  return joinPosix(configRoot, 'qianmo', 'identity', `${node}.tls.key`)
}

export async function initCa(
  host: ExecHost,
  options: { readonly dirName?: string; readonly cn?: string } = {},
): Promise<CaHandle> {
  // **兄弟**目录，不是 `configDir` 的后代 —— 见文件头 ①。
  const dir = joinPosix(host.workdir, options.dirName ?? 'ca')
  const result = await host.exec(
    [
      'ca',
      'init',
      '--ca-dir',
      dir,
      '--cn',
      options.cn ?? 'qianmo-acceptance-ca',
    ],
    { timeoutMs: 120_000 },
  )
  if (result.code !== 0) {
    throw new Error(
      `qm ca init 失败 (${result.code}) 于 ${host.describe}: ${result.stderr}`,
    )
  }
  return {
    host,
    dir,
    certificatePath: joinPosix(dir, 'ca.crt'),
    keyPath: joinPosix(dir, 'ca.key'),
    fingerprint256: field(result.stdout, 'fingerprint256'),
    publicKey: field(result.stdout, 'public key'),
  }
}

/**
 * 走完「节点出 CSR + PoP → CA 签发」两步，返回签好的证书。
 *
 * `--pop` 与 `--nodekey` 从 `qm cert request` 打印的那条**可直接照抄的**
 * `qm ca issue …` 命令里取 —— 那条命令行本身就是产品面，从它取值顺带把
 * 「打印出来的东西真的能用」也验了。
 */
export async function issueCertificate(
  ca: CaHandle,
  options: {
    readonly node: string
    /**
     * 节点的配置根，**目标机上的绝对路径**（Ed25519 身份就落在这里，复用同一个
     * 根即复用同一把钥匙）。
     */
    readonly configRoot: string
    /** 输出文件名，放在执行位的 workdir 下。 */
    readonly outName: string
    readonly hosts?: readonly string[]
    readonly days?: number
    /**
     * 同一个 CA 再签同一个节点时要给：`qm ca issue` 默认拒绝覆盖
     * `issued/<节点>.crt`（旧证书指纹只剩台账里那一行，覆盖要显式说）。
     */
    readonly replace?: boolean
  },
): Promise<IssuedCertificate> {
  const { host } = ca
  const hosts = options.hosts ?? ['127.0.0.1']
  const issueCommand = await certRequest(
    ca,
    options.node,
    hosts,
    options.configRoot,
  )

  const out = joinPosix(host.workdir, options.outName)
  const issue = await host.exec(
    [
      'ca',
      'issue',
      options.node,
      '--ca-dir',
      ca.dir,
      '--csr',
      issueCommand.value('--csr'),
      '--pop',
      issueCommand.value('--pop'),
      '--nodekey',
      issueCommand.value('--nodekey'),
      ...hosts.flatMap(entry => ['--host', entry]),
      ...(options.days === undefined ? [] : ['--days', String(options.days)]),
      ...(options.replace === true ? ['--replace'] : []),
      '--out',
      out,
    ],
    { timeoutMs: 120_000 },
  )
  if (issue.code !== 0) {
    throw new Error(
      `qm ca issue 失败 (${issue.code}) 于 ${host.describe}: ${issue.stderr}`,
    )
  }
  const pem = await host.readFile(out)
  if (pem === undefined) {
    throw new Error(`签好的证书读不回来: ${host.describe} 上的 ${out}`)
  }
  return {
    node: options.node,
    configRoot: options.configRoot,
    pem,
    path: out,
    fingerprint256: field(issue.stdout, 'fingerprint256'),
    nodePublicKey: issueCommand.value('--nodekey'),
    keys: await readIdentityKeys(host, options.configRoot, options.node),
  }
}

/** 跑一次 `qm cert request`，把它打印的那条 issue 命令拆成可取值的形状。 */
async function certRequest(
  ca: CaHandle,
  node: string,
  hosts: readonly string[],
  configRoot: string,
): Promise<{ readonly value: (flag: string) => string }> {
  const request = await ca.host.exec(
    ['cert', 'request', '--node', node, ...hosts.flatMap(h => ['--host', h])],
    { configDir: configRoot, timeoutMs: 120_000 },
  )
  if (request.code !== 0) {
    throw new Error(
      `qm cert request 失败 (${request.code}) 于 ${ca.host.describe}: ${request.stderr}`,
    )
  }
  const line = request.stdout
    .split('\n')
    .find(candidate => candidate.trim().startsWith('qm ca issue'))
  if (line === undefined) {
    throw new Error(`qm cert request 没有打印 issue 命令:\n${request.stdout}`)
  }
  const tokens = line.trim().split(/\s+/)
  return {
    value: (flag: string): string => {
      const found = tokens[tokens.indexOf(flag) + 1]
      if (found === undefined) throw new Error(`issue 命令缺 ${flag}: ${line}`)
      return found
    },
  }
}

/**
 * 签一份吊销清单并把 JSON 原文交出来（**不**发布 —— 那是下一步，也是操作者
 * 自己要做的那一步，见文件头 ②）。
 */
export async function signRevocationList(
  ca: CaHandle,
  options: {
    readonly revoke?: readonly {
      readonly node: string
      readonly fingerprint256: string
    }[]
    readonly outName?: string
    readonly reason?: string
  } = {},
): Promise<string> {
  const out = joinPosix(
    ca.host.workdir,
    options.outName ?? 'revocation-list.json',
  )
  const revoke = options.revoke ?? []
  const argv = ['ca', 'refresh-rl', '--ca-dir', ca.dir, '--out', out]
  for (const entry of revoke) {
    argv.push('--revoke', `${entry.node}=${entry.fingerprint256}`)
  }
  if (revoke.length > 0) {
    argv.push('--reason', options.reason ?? 'acceptance revocation')
  }
  const result = await ca.host.exec(argv, { timeoutMs: 120_000 })
  if (result.code !== 0) {
    throw new Error(
      `qm ca refresh-rl 失败 (${result.code}) 于 ${ca.host.describe}: ${result.stderr}`,
    )
  }
  const document = await ca.host.readFile(out)
  if (document === undefined) {
    throw new Error(`吊销清单读不回来: ${ca.host.describe} 上的 ${out}`)
  }
  return document
}

/** 把签好的吊销清单发布到注册中心（零鉴权，见 console.md §8.2）。 */
export async function publishRevocationList(
  registryUrl: string,
  document: string,
): Promise<number> {
  const response = await fetch(`${registryUrl}/v0/revocation-list`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: document,
  })
  return response.status
}

/**
 * 把一个带证书的节点登记进注册中心。
 *
 * **必须直接打注册中心，不能走控制台的代理路由** —— 控制台的
 * `parseRegisterInput` 收 address / endpoint / capabilities / publicKey /
 * status 五个字段，**没有 `certificate`**。经控制台登记的记录进不了
 * `CertificateDirectory` 的证书事实表，于是每一次 CA 握手都会以
 * `unknown_signer` 收场，而现场看起来像「证书签错了」。
 */
export async function publishAgentCertificate(
  registryUrl: string,
  input: {
    readonly address: string
    readonly endpoint: string
    readonly publicKey: string
    readonly certificate: string
  },
): Promise<number> {
  const response = await fetch(`${registryUrl}/v0/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  return response.status
}

function field(stdout: string, label: string): string {
  const match = new RegExp(`^\\s+${label}\\s+(\\S+)\\s*$`, 'm').exec(stdout)
  if (match?.[1] === undefined) {
    throw new Error(`输出里没有 ${label} 这一行:\n${stdout}`)
  }
  return match[1]
}

/**
 * 签一张**已经过期**的节点证书。
 *
 * ## 为什么不能用 `qm ca issue`
 *
 * 它的 `--days` 走 `positiveInteger`，最短就是一天，签出来的证书今天一定有效。
 * 要观测「过期的对端证书会被怎么处理」，只能自己指定绝对有效期。
 *
 * ## 为什么是 `openssl ca` 而不是 `openssl x509 -req -not_before/-not_after`
 *
 * 后两个开关 **OpenSSL 3.5 起才有**，而舰队里三台 aarch64 与控制台机上是
 * 3.0.13/3.0.20 —— 按那条路走，这一维在真机腿上只能整条 skip，理由还是一句
 * 「本机 openssl 太老」。`openssl ca -startdate/-enddate` 从 1.x 就在，实测在
 * 3.0.13 上对 `qm ca init` 产出的 **Ed25519** CA 私钥也工作。两条腿共用这一条
 * 路径，不按版本分岔 —— 分岔就意味着本地绿的那条和真机跑的那条不是一回事。
 *
 * ## 除了有效期，其余一切仍是产品的
 *
 * CSR 来自 `qm cert request`、签名用 `qm ca init` 生成的那把 CA 私钥、SAN 由
 * `@qianmo/protocol` 的 `formatNodeSanEntries` 生成（与 `ca/operations.ts` 同
 * 一个函数），扩展三行与那边逐字相同。手抄一份 SAN 格式会让这条场景在格式
 * 改动时变成假绿 —— 那正是它要抓的东西之一。
 *
 * 主机分类（DNS 还是 IP）在这里是就地判断的，`ca/operations.ts` 的
 * `classifyHosts` 没有导出。调用方只传 `127.0.0.1` 这类字面量，判断不含歧义。
 */
export async function issueExpiredCertificate(
  ca: CaHandle,
  options: {
    readonly node: string
    readonly configRoot: string
    readonly outName: string
    readonly host?: string
  },
): Promise<IssuedCertificate> {
  const { formatNodeSanEntries } = await import('@qianmo/protocol')
  const { X509Certificate } = await import('node:crypto')
  const execHost = ca.host
  const target = options.host ?? '127.0.0.1'

  await certRequest(ca, options.node, [target], options.configRoot)
  const csrPath = joinPosix(
    options.configRoot,
    'qianmo',
    'identity',
    `${options.node}.tls.csr`,
  )
  const keys = await readIdentityKeys(
    execHost,
    options.configRoot,
    options.node,
  )
  const isIp = /^[0-9.]+$/.test(target) || target.includes(':')
  const extensions =
    `subjectAltName=${formatNodeSanEntries({
      node: options.node,
      publicKey: keys.publicKey,
      dnsNames: isIp ? [] : [target],
      ipAddresses: isIp ? [target] : [],
    })}\n` +
    'basicConstraints=CA:FALSE\n' +
    'extendedKeyUsage=serverAuth,clientAuth\n'

  const scratch = await execHost.mkdir(`expired-${options.node}`)
  const extPath = await execHost.writeFile(
    `expired-${options.node}/ext.cnf`,
    extensions,
  )
  // `openssl ca` 要一张自己的台账：数据库、序列号、以及放签发副本的目录。
  // 全部落在这层一次性 scratch 里，路径一律绝对 —— 那样就不必依赖 cwd，而
  // 「远端命令的 cwd 是什么」在两个驱动上本来就不是同一件事。
  await execHost.writeFile(`expired-${options.node}/index.txt`, '')
  await execHost.writeFile(`expired-${options.node}/serial`, '01\n')
  const configPath = await execHost.writeFile(
    `expired-${options.node}/ca.cnf`,
    [
      '[ ca ]',
      'default_ca = CA_default',
      '[ CA_default ]',
      `dir = ${scratch}`,
      `database = ${joinPosix(scratch, 'index.txt')}`,
      `serial = ${joinPosix(scratch, 'serial')}`,
      `new_certs_dir = ${scratch}`,
      `certificate = ${ca.certificatePath}`,
      `private_key = ${ca.keyPath}`,
      // Ed25519 不吃摘要参数，`default` 让 openssl 自己按密钥类型决定。
      'default_md = default',
      'policy = policy_acceptance',
      'email_in_dn = no',
      'unique_subject = no',
      'preserve = no',
      '[ policy_acceptance ]',
      // `qm cert request` 出的 CSR 主体只有 CN，但把常见字段一并放开：
      // policy 里没列的属性会被静默丢掉，而「主体少了一段」是一种很难看出来
      // 的漂移。
      'countryName = optional',
      'stateOrProvinceName = optional',
      'localityName = optional',
      'organizationName = optional',
      'organizationalUnitName = optional',
      'commonName = supplied',
      'emailAddress = optional',
      '',
    ].join('\n'),
  )

  // 一整年前签发、一个月前就到期 —— 「过去某一刻起、过去某一刻止」。
  const stamp = (at: number): string => {
    const iso = new Date(at).toISOString()
    return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
  }
  const day = 24 * 60 * 60 * 1000
  const out = joinPosix(execHost.workdir, options.outName)
  const signed = await execHost.run(
    [
      'openssl',
      'ca',
      '-batch',
      '-config',
      configPath,
      '-in',
      csrPath,
      '-out',
      out,
      '-notext',
      '-startdate',
      stamp(Date.now() - 400 * day),
      '-enddate',
      stamp(Date.now() - 30 * day),
      '-extfile',
      extPath,
    ],
    { timeoutMs: 120_000 },
  )
  const pem = await execHost.readFile(out)
  if (signed.code !== 0 || pem === undefined) {
    throw new Error(
      `openssl 签发过期证书失败 (${signed.code}) 于 ${execHost.describe}: ` +
        `${signed.stderr.slice(0, 800)}`,
    )
  }
  return {
    node: options.node,
    configRoot: options.configRoot,
    pem,
    path: out,
    fingerprint256: new X509Certificate(pem).fingerprint256,
    nodePublicKey: keys.publicKey,
    keys,
  }
}
