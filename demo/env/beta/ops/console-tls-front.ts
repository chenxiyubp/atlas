// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌内测 · 控制台的 TLS 前置（beta-env.md §2.5 的「反代」）。
 *
 *   bun demo/env/beta/ops/console-tls-front.ts \
 *     --listen 0.0.0.0:38443 --upstream http://127.0.0.1:38621 \
 *     --cert <证书链 PEM> --key <私钥 PEM>
 *
 * 为什么是一个 Bun 小程序而不是 nginx：控制台所在的那台机器上，443 与 nginx 属于
 * 机器主人的另一套业务，不归本仓库管，也不能碰。§2.5 要的是「控制台只听回环，外面
 * 一层做 TLS 终结」，并不要求那一层是 nginx；它要的是下面三条强制配置，而这三条写成
 * 代码之后可以被测试钉住，写在一份别人的 nginx 配置里就没人能测（`throttle.ts` 头注
 * 对限流说过同一句话）。
 *
 * **只做转发，不改控制台。**控制台一行代码不动，它本来就为「站在反代后面」留好了口子：
 * 用 `X-Forwarded-Proto` 判断要不要给会话 cookie 加 `Secure`，302/303 只发相对路径，
 * 登录限流按套接字对端地址计（在反代后面会塌缩成一个全局桶，`throttle.ts` 已接受）。
 *
 * §2.5 的三条强制配置在这里的落点：
 *
 *  1. **访问日志不记 query string。**view token 走 `?token=`，日志一旦记下 query，
 *     日志文件就和 token 等价。这里每个请求只记一行：时间、对端、方法、**路径**、
 *     状态、耗时——没有 query、没有任何请求头。见 {@link accessLogLine}。
 *  2. **上游是一张显式白名单。**这张表在命令行上只有一项（`--upstream`），而且必须是
 *     回环、明文 http、不带路径，并且**不许是注册中心的端口**（它零鉴权，§9.2）。
 *     备份服务是 §2.5 允许的第二项，但它一期没有长驻入口（beta-up.sh「④ 备份服务」），
 *     所以这里不为它留位置：没有的东西不进白名单。
 *  3. **`X-Forwarded-Proto: https` 由这里自己设，不透传客户端送来的。**客户端送来的
 *     `Forwarded` / `X-Forwarded-*` / `X-Real-IP` 一律先删掉。
 *
 * 另外三件不在 §2.5 里、但转发器不做就会坏的事：
 *
 *  - **重定向原样交还浏览器**（`redirect: 'manual'`）。默认的 `follow` 会让这里替浏览器
 *    跟随登录后的 303，浏览器于是拿不到那条 `Set-Cookie`，登录永远「成功」却进不去。
 *  - **空闲超时从控制台的 SSE 心跳推出来**，与 `packages/console/src/http.ts` 里
 *    `idleTimeout` 那段注释同一个道理：`Bun.serve` 默认 10 s，比 15 s 的心跳短，
 *    聊天流会每十秒被掐断一次、浏览器不停重连。用例把这两个数钉在一起。
 *  - **客户端断开时一并断开上游**（把 `request.signal` 交给上游请求），否则控制台那边
 *    的 SSE 流会一直挂着，心跳写给一个已经没人读的连接。
 *
 * 证书只在启动时读。续期之后要重启本进程（`console-cert.sh` 的部署钩子做这件事）。
 * 本文件刻意只依赖 Bun 与 `node:` 内建：它要能直接从一棵只有 `demo/` 的交付树里跑。
 */

import { statSync } from 'node:fs'

/** 注册中心的端口（`common.sh` 的 `BETA_REGISTRY_PORT`）。它零鉴权，永不进白名单。 */
export const REGISTRY_PORT = 38620

/**
 * 控制台聊天流的心跳间隔，毫秒。**是 `@qianmo/console` 的 `CHAT_STREAM_HEARTBEAT_MS`
 * 的一份抄本**——本文件不能 import 仓库代码（见文件头末段），所以抄一份，由用例断言
 * 两边相等。改了那边而没改这里，用例会红。
 */
export const CONSOLE_CHAT_HEARTBEAT_MS = 15_000

/**
 * 本前置的空闲超时，秒。控制台自己取心跳的两倍；这里再多给一倍，因为前置与控制台
 * 之间还隔着一次转发，两层恰好同一个数时谁先掐断取决于调度，不值得去赌。
 * `Bun.serve` 的上限是 255。
 */
export const IDLE_TIMEOUT_S = Math.min(
  255,
  Math.ceil((CONSOLE_CHAT_HEARTBEAT_MS / 1_000) * 4),
)

/**
 * 请求体上限。控制台最大的请求体是一条聊天消息；登录表单自己只收 4 KiB。
 * 两层落点：`startFront` 的 `maxRequestBodySize`（只挡声明了长度的）与
 * `readCappedBody` 的边读边数（chunked 也挡）。
 */
export const MAX_BODY_BYTES = 1024 * 1024

export const DEFAULT_LISTEN = '0.0.0.0:38443'

/** 逐跳头：只对一跳有意义，不能转发（RFC 9110 §7.6.1）。 */
const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
] as const

/** 客户端送来的转发类头。直连时它们由调用者随手写，一律不信、先删。 */
const CLIENT_FORWARDING = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-real-ip',
] as const

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

export interface FrontConfig {
  readonly listenHost: string
  readonly listenPort: number
  /** 唯一的上游：`http://<回环>:<端口>/`。 */
  readonly upstream: URL
  readonly certFile: string
  readonly keyFile: string
}

export class FrontConfigError extends Error {
  override readonly name = 'FrontConfigError'
}

function parsePort(text: string, what: string): number {
  if (!/^\d{1,5}$/.test(text)) {
    throw new FrontConfigError(`${what} 的端口不是数字：${text}`)
  }
  const port = Number(text)
  if (port > 65_535) throw new FrontConfigError(`${what} 的端口越界：${text}`)
  return port
}

/** `host:port`，host 可以是 `[::1]` 这种带方括号的 IPv6。 */
export function parseListen(text: string): { host: string; port: number } {
  const cut = text.lastIndexOf(':')
  if (cut <= 0)
    throw new FrontConfigError(`--listen 要写成 <地址>:<端口>：${text}`)
  let host = text.slice(0, cut)
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  return { host, port: parsePort(text.slice(cut + 1), '--listen') }
}

/**
 * 白名单的唯一一项。拒绝的每一种都对应一次「看着能跑、其实把不该暴露的东西挂上了
 * 公网」：非回环（绕过控制台自己的回环绑定）、https（上游那一跳本来就是回环明文，
 * 写成 https 只说明指错了地方）、带路径（控制台的路由都从 `/` 起）、注册中心端口。
 */
export function parseUpstream(text: string): URL {
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new FrontConfigError(`--upstream 不是 URL：${text}`)
  }
  if (url.protocol !== 'http:') {
    throw new FrontConfigError(`--upstream 只接受 http://（回环明文）：${text}`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new FrontConfigError(
      `--upstream 必须是回环地址（127.0.0.1 / localhost / [::1]）：${text}`,
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new FrontConfigError('--upstream 里不能带用户名或口令')
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new FrontConfigError(`--upstream 只写到端口为止，不带路径：${text}`)
  }
  // 端口从原文里取，不从 `url.port` 取：WHATWG URL 会把协议的默认端口规范化成空串，
  // 于是明明写了 `http://127.0.0.1:80`，`url.port` 却是 ''（2026-09-26 在 H 上被它挡过一次）。
  const written = /:(\d{1,5})\/?$/.exec(text)
  if (written === null) {
    throw new FrontConfigError(`--upstream 要显式写端口：${text}`)
  }
  if (Number(written[1]) === REGISTRY_PORT) {
    throw new FrontConfigError(
      `--upstream 指向了注册中心的端口 ${REGISTRY_PORT}——它零鉴权，永不经反代暴露（beta-env.md §2.5 第 2 条）`,
    )
  }
  return url
}

export function parseFrontArgs(argv: readonly string[]): FrontConfig {
  let listen = DEFAULT_LISTEN
  let upstream: string | undefined
  let certFile: string | undefined
  let keyFile: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    const take = (): string => {
      if (value === undefined || value.startsWith('--')) {
        throw new FrontConfigError(`${flag} 后面缺一个值`)
      }
      i++
      return value
    }
    switch (flag) {
      case '--listen':
        listen = take()
        break
      case '--upstream':
        upstream = take()
        break
      case '--cert':
        certFile = take()
        break
      case '--key':
        keyFile = take()
        break
      default:
        throw new FrontConfigError(
          `不认识的参数：${flag}（只有 --listen --upstream --cert --key）`,
        )
    }
  }
  if (upstream === undefined) throw new FrontConfigError('缺 --upstream')
  if (certFile === undefined) throw new FrontConfigError('缺 --cert')
  if (keyFile === undefined) throw new FrontConfigError('缺 --key')
  const { host, port } = parseListen(listen)
  return {
    listenHost: host,
    listenPort: port,
    upstream: parseUpstream(upstream),
    certFile,
    keyFile,
  }
}

/**
 * 私钥文件的权限必须只有属主可读——与控制台对 token 文件的要求同一条（beta-env.md
 * §8.3「过宽就拒绝启动」）。宽了不是警告：那把私钥就是这个域名。
 */
export function assertPrivateKeyFile(path: string): void {
  let mode: number
  try {
    mode = statSync(path).mode
  } catch {
    throw new FrontConfigError(`读不到私钥文件：${path}`)
  }
  if ((mode & 0o077) !== 0) {
    throw new FrontConfigError(
      `私钥文件权限过宽（${(mode & 0o777).toString(8)}），要 600：${path}`,
    )
  }
}

/**
 * 访问日志的一行。**只有路径，没有 query**——这一条是 §2.5 第 1 条本身，
 * 用例专门断言带 `?token=` 的请求在日志里找不到那串值。
 */
export function accessLogLine(fields: {
  readonly at: Date
  readonly peer: string
  readonly method: string
  readonly pathname: string
  readonly status: number
  readonly ms: number
}): string {
  return `${fields.at.toISOString()} ${fields.peer || '-'} ${fields.method} ${fields.pathname} ${fields.status} ${fields.ms}ms`
}

/** 发往上游的请求头：删逐跳头与客户端的转发类头，再由这里设 `X-Forwarded-Proto`。 */
export function upstreamHeaders(incoming: Headers, peer: string): Headers {
  const headers = new Headers(incoming)
  for (const name of HOP_BY_HOP) headers.delete(name)
  for (const name of CLIENT_FORWARDING) headers.delete(name)
  // Host 交给 fetch 按上游 URL 重写：控制台只发相对跳转、不读 Host。
  headers.delete('host')
  headers.set('x-forwarded-proto', 'https')
  // 控制台刻意不读它（登录限流按套接字对端地址计，`throttle.ts`）。设上它只为
  // 控制台自己的日志与将来的排障留一个真实来源；它是这里写的，不是客户端写的。
  if (peer !== '') headers.set('x-forwarded-for', peer)
  return headers
}

function downstreamHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream)
  for (const name of HOP_BY_HOP) headers.delete(name)
  return headers
}

/**
 * 边读边数：累计一超过 {@link MAX_BODY_BYTES} 就取消读取、返回 `'too-large'`，
 * 最多比上限多读一块。**不能先 `arrayBuffer()` 读完再比**：不带 `Content-Length`
 * 的 chunked 请求会被整个缓冲进内存，而这发生在鉴权之前——公网上任何人都能拿它
 * 放大这台机器的内存（pentest-m1.md F-1）。写法与 `@qianmo/cloud-artifacts` 的
 * `readBoundedBody` 同一套；本文件不能 import 仓库代码（见文件头末段），所以各写一份。
 */
async function readCappedBody(
  request: Request,
): Promise<ArrayBuffer | 'too-large'> {
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return 'too-large'
  if (request.body === null) return new ArrayBuffer(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      return 'too-large'
    }
    chunks.push(value)
  }
  return Bun.concatArrayBuffers(chunks)
}

export interface PeerSource {
  requestIP(request: Request): { readonly address: string } | null
}

export type FrontHandler = (
  request: Request,
  server?: PeerSource,
) => Promise<Response>

/**
 * 转发一个请求。独立导出，让每一条规则都能不起 TLS、直接拿 `Request` 测。
 */
export function createFrontHandler(
  upstream: URL,
  log: (line: string) => void,
): FrontHandler {
  return async (request, server) => {
    const started = performance.now()
    const incoming = new URL(request.url)
    const peer = server?.requestIP(request)?.address ?? ''
    const finish = (response: Response): Response => {
      log(
        accessLogLine({
          at: new Date(),
          peer,
          method: request.method,
          pathname: incoming.pathname,
          status: response.status,
          ms: Math.round(performance.now() - started),
        }),
      )
      return response
    }

    let body: ArrayBuffer | undefined
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const read = await readCappedBody(request)
      if (read === 'too-large') {
        return finish(new Response('request body too large\n', { status: 413 }))
      }
      body = read
    }

    const target = new URL(incoming.pathname + incoming.search, upstream)
    let response: Response
    try {
      response = await fetch(target, {
        method: request.method,
        headers: upstreamHeaders(request.headers, peer),
        body,
        redirect: 'manual',
        // 原样转交字节：自动解压会留下一个与正文不符的 content-encoding 头。
        decompress: false,
        signal: request.signal,
      })
    } catch {
      // 不回显错误细节：上游地址与内部错误不该出现在公网应答里。
      return finish(new Response('upstream unavailable\n', { status: 502 }))
    }

    return finish(
      new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: downstreamHeaders(response.headers),
      }),
    )
  }
}

export interface FrontHandle {
  readonly port: number
  stop(): Promise<void>
}

export function startFront(
  config: FrontConfig,
  log: (line: string) => void,
): FrontHandle {
  assertPrivateKeyFile(config.keyFile)
  const handler = createFrontHandler(config.upstream, log)
  const server = Bun.serve({
    hostname: config.listenHost,
    port: config.listenPort,
    idleTimeout: IDLE_TIMEOUT_S,
    // 只挡声明长度的请求（Bun 1.3.13 实测）：声明的 Content-Length 超限时在套接字层
    // 直接回 413，不进 handler，所以这类请求不出现在访问日志里。不带 Content-Length
    // 的 chunked 请求它不管，照样进 handler，那一层靠 readCappedBody 边读边数。
    maxRequestBodySize: MAX_BODY_BYTES,
    tls: { cert: Bun.file(config.certFile), key: Bun.file(config.keyFile) },
    fetch: (request, bunServer) => handler(request, bunServer),
  })
  return {
    port: server.port as number,
    stop: async () => {
      await server.stop(true)
    },
  }
}

if (import.meta.main) {
  let config: FrontConfig
  let front: FrontHandle
  try {
    config = parseFrontArgs(process.argv.slice(2))
    front = startFront(config, line => process.stdout.write(`${line}\n`))
  } catch (error) {
    process.stderr.write(
      `[console-tls-front] ${error instanceof Error ? error.message : String(error)}\n`,
    )
    process.exit(2)
  }
  process.stdout.write(
    `[console-tls-front] listening https://${config.listenHost}:${front.port} -> ${config.upstream.origin}\n`,
  )
  const shutdown = (): void => {
    void front.stop().then(() => process.exit(0))
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
