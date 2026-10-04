// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `console-tls-front.ts` 的契约：beta-env.md §2.5 的三条强制配置，外加让登录与聊天流
 * 在反代后面照常工作的那三件事（重定向交还浏览器、空闲超时跟着 SSE 心跳走、流式透传）。
 *
 * 不 mock 任何东西：上游是一个真的 `Bun.serve`（回环、随机端口），TLS 那一格用现场
 * 生成的自签证书真握手一次。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { CHAT_STREAM_HEARTBEAT_MS } from '@qianmo/console'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as connectTls } from 'node:tls'
import {
  CONSOLE_CHAT_HEARTBEAT_MS,
  createFrontHandler,
  FrontConfigError,
  IDLE_TIMEOUT_S,
  MAX_BODY_BYTES,
  parseFrontArgs,
  REGISTRY_PORT,
  startFront,
} from './console-tls-front.js'

const PEER = { requestIP: () => ({ address: '203.0.113.7' }) }

/** 请求体一块的大小，与 Bun 从套接字交给请求体流的块同一量级。 */
const CHUNK_BYTES = 64 * 1024

let upstream: ReturnType<typeof Bun.serve>
let upstreamUrl: URL
/** 上游 `/sink` 被打到的次数：「不进上游」就是这个数不变。 */
let sinkHits = 0

beforeAll(() => {
  upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url)
      if (url.pathname === '/echo') {
        return Response.json({
          path: url.pathname,
          search: url.search,
          headers: Object.fromEntries(request.headers),
        })
      }
      if (url.pathname === '/sink' && request.method === 'POST') {
        sinkHits++
        return Response.json({
          bytes: (await request.arrayBuffer()).byteLength,
        })
      }
      if (url.pathname === '/login' && request.method === 'POST') {
        const form = await request.text()
        const headers = new Headers({ location: '/' })
        headers.append('set-cookie', 'a=1; Path=/; HttpOnly')
        headers.append('set-cookie', `b=${form.length}; Path=/`)
        return new Response(null, { status: 303, headers })
      }
      if (url.pathname === '/stream') {
        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: first\n\n'))
            setTimeout(() => {
              controller.enqueue(encoder.encode('data: second\n\n'))
              controller.close()
            }, 400)
          },
        })
        return new Response(stream, {
          headers: { 'content-type': 'text/event-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  })
  upstreamUrl = new URL(`http://127.0.0.1:${upstream.port}/`)
})

afterAll(async () => {
  await upstream.stop(true)
})

describe('parseFrontArgs：白名单只有一项，且只能是回环上的控制台', () => {
  const base = ['--cert', '/c.pem', '--key', '/k.pem']

  test('完整参数照单全收；--listen 缺省为 0.0.0.0:38443', () => {
    const config = parseFrontArgs([
      '--upstream',
      'http://127.0.0.1:38621',
      ...base,
    ])
    expect(config.listenHost).toBe('0.0.0.0')
    expect(config.listenPort).toBe(38443)
    expect(config.upstream.origin).toBe('http://127.0.0.1:38621')
  })

  test('显式写成协议默认端口（:80）也照收——URL 会把它规范化成空串，不能拿它判断', () => {
    const config = parseFrontArgs([
      '--upstream',
      'http://127.0.0.1:80',
      ...base,
    ])
    expect(config.upstream.origin).toBe('http://127.0.0.1')
  })

  test('IPv6 回环的监听地址去掉方括号', () => {
    const config = parseFrontArgs([
      '--listen',
      '[::1]:9443',
      '--upstream',
      'http://[::1]:38621',
      ...base,
    ])
    expect(config.listenHost).toBe('::1')
    expect(config.listenPort).toBe(9443)
  })

  test.each([
    ['非回环上游', 'http://10.0.0.5:38621'],
    ['https 上游', 'https://127.0.0.1:38621'],
    ['带路径的上游', 'http://127.0.0.1:38621/v0'],
    ['带 query 的上游', 'http://127.0.0.1:38621/?x=1'],
    ['不写端口', 'http://127.0.0.1'],
    ['带口令', 'http://u:p@127.0.0.1:38621'],
    ['注册中心端口', `http://127.0.0.1:${REGISTRY_PORT}`],
  ])('拒绝%s', (_label, value) => {
    expect(() => parseFrontArgs(['--upstream', value, ...base])).toThrow(
      FrontConfigError,
    )
  })

  test('注册中心端口的拒绝理由里点名 §2.5 第 2 条', () => {
    expect(() =>
      parseFrontArgs([
        '--upstream',
        `http://127.0.0.1:${REGISTRY_PORT}`,
        ...base,
      ]),
    ).toThrow(/注册中心/)
  })

  test.each([
    [['--cert', '/c.pem', '--key', '/k.pem']],
    [['--upstream', 'http://127.0.0.1:38621', '--key', '/k.pem']],
    [['--upstream', 'http://127.0.0.1:38621', '--cert', '/c.pem']],
    [['--upstream', 'http://127.0.0.1:38621', ...base, '--verbose']],
    [['--upstream', '--cert', '/c.pem', '--key', '/k.pem']],
    [['--listen', '0.0.0.0', '--upstream', 'http://127.0.0.1:1', ...base]],
  ])('缺值、缺项或多出参数都拒绝：%j', argv => {
    expect(() => parseFrontArgs(argv)).toThrow(FrontConfigError)
  })
})

describe('空闲超时跟着控制台的 SSE 心跳走', () => {
  test('本文件里的心跳抄本与 @qianmo/console 一致', () => {
    expect(CONSOLE_CHAT_HEARTBEAT_MS).toBe(CHAT_STREAM_HEARTBEAT_MS)
  })

  test('空闲超时至少是心跳的两倍，且不超过 Bun 的上限 255 s', () => {
    expect(IDLE_TIMEOUT_S * 1_000).toBeGreaterThanOrEqual(
      2 * CHAT_STREAM_HEARTBEAT_MS,
    )
    expect(IDLE_TIMEOUT_S).toBeLessThanOrEqual(255)
  })
})

describe('转发', () => {
  test('X-Forwarded-Proto 由前置自己设成 https，客户端送来的转发类头一律丢掉', async () => {
    const lines: string[] = []
    const handle = createFrontHandler(upstreamUrl, line => lines.push(line))
    const response = await handle(
      new Request('https://qianmo.example:38443/echo?x=1', {
        headers: {
          'x-forwarded-proto': 'http',
          'x-forwarded-for': '198.51.100.1',
          'x-forwarded-host': 'evil.example',
          forwarded: 'for=198.51.100.1;proto=http',
          'x-real-ip': '198.51.100.1',
          'x-keep': 'yes',
        },
      }),
      PEER,
    )
    expect(response.status).toBe(200)
    const echoed = (await response.json()) as {
      search: string
      headers: Record<string, string>
    }
    expect(echoed.search).toBe('?x=1')
    expect(echoed.headers['x-forwarded-proto']).toBe('https')
    expect(echoed.headers['x-forwarded-for']).toBe('203.0.113.7')
    expect(echoed.headers['x-forwarded-host']).toBeUndefined()
    expect(echoed.headers.forwarded).toBeUndefined()
    expect(echoed.headers['x-real-ip']).toBeUndefined()
    expect(echoed.headers['x-keep']).toBe('yes')
  })

  test('访问日志只记路径：带 ?token= 的请求在日志里找不到那串值', async () => {
    const lines: string[] = []
    const handle = createFrontHandler(upstreamUrl, line => lines.push(line))
    const secret = 'probe-token-6f1d0c9b'
    await handle(new Request(`https://h/echo?token=${secret}`), PEER)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(' GET /echo 200 ')
    expect(lines[0]).toContain('203.0.113.7')
    expect(lines.join('\n')).not.toContain(secret)
    expect(lines.join('\n')).not.toContain('token')
  })

  test('303 与多条 Set-Cookie 原样交还浏览器，不在前置这里被跟随', async () => {
    const handle = createFrontHandler(upstreamUrl, () => {})
    const response = await handle(
      new Request('https://h/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=abcdef',
      }),
      PEER,
    )
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/')
    const cookies = response.headers.getSetCookie()
    expect(cookies).toHaveLength(2)
    // 请求体原样到了上游（上游把它的长度写进了第二条 cookie）。
    expect(cookies[1]).toContain('b=12')
  })

  test('超过上限的请求体在前置这里就挡下，不进上游', async () => {
    const lines: string[] = []
    const handle = createFrontHandler(upstreamUrl, line => lines.push(line))
    const response = await handle(
      new Request('https://h/login', {
        method: 'POST',
        body: new Uint8Array(MAX_BODY_BYTES + 1),
      }),
      PEER,
    )
    expect(response.status).toBe(413)
    expect(lines[0]).toContain(' POST /login 413 ')
  })

  test('上游不在：502，应答里不带上游地址或内部错误', async () => {
    const gone = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(''),
    })
    const deadUrl = new URL(`http://127.0.0.1:${gone.port}/`)
    await gone.stop(true)
    const handle = createFrontHandler(deadUrl, () => {})
    const response = await handle(new Request('https://h/echo'), PEER)
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(text).not.toContain('127.0.0.1')
    expect(text).not.toContain(String(deadUrl.port))
  })

  test('事件流逐块透传：第一块在上游关流之前就到', async () => {
    const handle = createFrontHandler(upstreamUrl, () => {})
    const started = performance.now()
    const response = await handle(new Request('https://h/stream'), PEER)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    const firstAt = performance.now() - started
    expect(new TextDecoder().decode(first.value)).toContain('data: first')
    // 上游 400 ms 后才发第二块并关流；第一块若要等到关流才出来，就是被缓冲了。
    expect(firstAt).toBeLessThan(300)
    let rest = ''
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      rest += new TextDecoder().decode(chunk.value)
    }
    expect(rest).toContain('data: second')
  })
})

/**
 * 不带 Content-Length 的流式请求体，同时记下被读走了多少字节。
 * `highWaterMark: 0`：读取端真去要才产出下一块，所以「产出的」就是「前置读入的」。
 */
function countingBody(total: number): {
  readonly stream: ReadableStream<Uint8Array>
  readonly seen: { pulled: number; cancelled: boolean }
} {
  const seen = { pulled: 0, cancelled: false }
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (seen.pulled >= total) {
          controller.close()
          return
        }
        const size = Math.min(CHUNK_BYTES, total - seen.pulled)
        seen.pulled += size
        controller.enqueue(new Uint8Array(size))
      },
      cancel() {
        seen.cancelled = true
      },
    },
    { highWaterMark: 0 },
  )
  return { stream, seen }
}

function streamingPost(
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://h/sink', {
    method: 'POST',
    headers,
    body,
    // @ts-expect-error Bun supports duplex for streaming request bodies
    duplex: 'half',
  })
}

describe('请求体上限：边读边数，不先整个读进内存（pentest-m1.md F-1）', () => {
  test('chunked、不带 Content-Length、超限：413，最多多读一块就停，不进上游', async () => {
    const lines: string[] = []
    const handle = createFrontHandler(upstreamUrl, line => lines.push(line))
    const { stream, seen } = countingBody(16 * MAX_BODY_BYTES)
    const request = streamingPost(stream)
    expect(request.headers.get('content-length')).toBeNull()
    const hitsBefore = sinkHits
    const response = await handle(request, PEER)
    expect(response.status).toBe(413)
    expect(lines[0]).toContain(' POST /sink 413 ')
    // 修之前这里是 16 MiB：整个请求体读完才比上限。
    expect(seen.pulled).toBeLessThanOrEqual(MAX_BODY_BYTES + CHUNK_BYTES)
    expect(seen.cancelled).toBe(true)
    expect(sinkHits).toBe(hitsBefore)
  })

  test('chunked、恰好等于上限：照常转发，上游收到的字节一个不少', async () => {
    const handle = createFrontHandler(upstreamUrl, () => {})
    const { stream, seen } = countingBody(MAX_BODY_BYTES)
    const response = await handle(streamingPost(stream), PEER)
    expect(response.status).toBe(200)
    expect(((await response.json()) as { bytes: number }).bytes).toBe(
      MAX_BODY_BYTES,
    )
    expect(seen.pulled).toBe(MAX_BODY_BYTES)
    expect(seen.cancelled).toBe(false)
  })

  test('声明的 Content-Length 超限：一个字节都不读就挡下', async () => {
    const handle = createFrontHandler(upstreamUrl, () => {})
    const { stream, seen } = countingBody(16 * MAX_BODY_BYTES)
    const hitsBefore = sinkHits
    const response = await handle(
      streamingPost(stream, { 'content-length': String(MAX_BODY_BYTES + 1) }),
      PEER,
    )
    expect(response.status).toBe(413)
    expect(seen.pulled).toBe(0)
    expect(sinkHits).toBe(hitsBefore)
  })
})

/**
 * 用裸 TLS 套接字发一个 POST，返回应答的状态行。`fetch` 自己决定带 Content-Length
 * 还是 Transfer-Encoding，这里要测的恰恰是这两种请求头形状本身。`blocks` 块请求体
 * 按 chunked 编码发，服务端一开口就停止上传。
 */
function rawTlsPost(
  port: number,
  head: string,
  blocks: number,
): Promise<string> {
  return new Promise(resolve => {
    let reply = ''
    const socket = connectTls({
      host: '127.0.0.1',
      port,
      rejectUnauthorized: false,
    })
    const guard = setTimeout(() => socket.destroy(), 4_000)
    const finish = (): void => {
      clearTimeout(guard)
      socket.destroy()
      resolve(reply.split('\r\n')[0] ?? '')
    }
    socket.on('data', data => {
      reply += data.toString('latin1')
      if (reply.includes('\r\n\r\n')) finish()
    })
    socket.on('error', () => {})
    socket.on('close', finish)
    socket.on('secureConnect', async () => {
      socket.write(
        `POST /sink HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n${head}\r\n`,
      )
      const frame = Buffer.concat([
        Buffer.from(`${CHUNK_BYTES.toString(16)}\r\n`),
        Buffer.alloc(CHUNK_BYTES),
        Buffer.from('\r\n'),
      ])
      for (let i = 0; i < blocks && reply === '' && !socket.destroyed; i++) {
        if (!socket.write(frame)) {
          // 两个监听器用完一起摘掉：只挂 once 的话，drain 先到时 close 那个会留下，
          // 每次背压攒一个，上传一大就触发 MaxListeners 告警。
          await new Promise<void>(settle => {
            const resume = (): void => {
              socket.off('drain', resume)
              socket.off('close', resume)
              settle()
            }
            socket.on('drain', resume)
            socket.on('close', resume)
          })
        }
      }
      if (blocks > 0 && reply === '' && !socket.destroyed) {
        socket.write('0\r\n\r\n')
      }
    })
  })
}

describe('startFront：真 TLS', () => {
  const openssl = Bun.which('openssl')
  let dir = ''

  beforeAll(() => {
    if (openssl === null) return
    dir = mkdtempSync(join(tmpdir(), 'tls-front-'))
    const made = Bun.spawnSync([
      openssl,
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ])
    if (made.exitCode !== 0) throw new Error(made.stderr.toString())
    chmodSync(join(dir, 'key.pem'), 0o600)
  })

  afterAll(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
  })

  test.skipIf(openssl === null)('私钥文件权限过宽就拒绝启动', () => {
    chmodSync(join(dir, 'key.pem'), 0o644)
    try {
      expect(() =>
        startFront(
          {
            listenHost: '127.0.0.1',
            listenPort: 0,
            upstream: upstreamUrl,
            certFile: join(dir, 'cert.pem'),
            keyFile: join(dir, 'key.pem'),
          },
          () => {},
        ),
      ).toThrow(/权限过宽/)
    } finally {
      chmodSync(join(dir, 'key.pem'), 0o600)
    }
  })

  test.skipIf(openssl === null)(
    '声明的 Content-Length 超限：Bun 在套接字层回 413，不进 handler',
    async () => {
      const lines: string[] = []
      const front = startFront(
        {
          listenHost: '127.0.0.1',
          listenPort: 0,
          upstream: upstreamUrl,
          certFile: join(dir, 'cert.pem'),
          keyFile: join(dir, 'key.pem'),
        },
        line => lines.push(line),
      )
      const hitsBefore = sinkHits
      try {
        const status = await rawTlsPost(
          front.port,
          `Content-Length: ${MAX_BODY_BYTES + 1}\r\n`,
          0,
        )
        expect(status).toContain(' 413 ')
        // 没进 handler，所以访问日志里没有这一行：挡它的是 maxRequestBodySize。
        expect(lines).toHaveLength(0)
        expect(sinkHits).toBe(hitsBefore)
      } finally {
        await front.stop()
      }
    },
  )

  test.skipIf(openssl === null)(
    'chunked 超限：maxRequestBodySize 挡不住，由 handler 边读边数回 413',
    async () => {
      const lines: string[] = []
      const front = startFront(
        {
          listenHost: '127.0.0.1',
          listenPort: 0,
          upstream: upstreamUrl,
          certFile: join(dir, 'cert.pem'),
          keyFile: join(dir, 'key.pem'),
        },
        line => lines.push(line),
      )
      const hitsBefore = sinkHits
      try {
        const status = await rawTlsPost(
          front.port,
          'Transfer-Encoding: chunked\r\n',
          (16 * MAX_BODY_BYTES) / CHUNK_BYTES,
        )
        expect(status).toContain(' 413 ')
        // Bun 1.3.13 实测：maxRequestBodySize 只挡声明了长度的请求，chunked 照样进
        // handler，所以日志里有这一行。哪天 Bun 在套接字层挡住 chunked，这条会红，
        // 届时回头改 startFront 里的注释。
        expect(lines.some(line => line.includes(' POST /sink 413 '))).toBe(true)
        expect(sinkHits).toBe(hitsBefore)
      } finally {
        await front.stop()
      }
    },
  )

  test.skipIf(openssl === null)('https 握手之后转发到回环上游', async () => {
    const lines: string[] = []
    const front = startFront(
      {
        listenHost: '127.0.0.1',
        listenPort: 0,
        upstream: upstreamUrl,
        certFile: join(dir, 'cert.pem'),
        keyFile: join(dir, 'key.pem'),
      },
      line => lines.push(line),
    )
    try {
      const response = await fetch(`https://127.0.0.1:${front.port}/echo`, {
        tls: { rejectUnauthorized: false },
      })
      expect(response.status).toBe(200)
      const echoed = (await response.json()) as {
        headers: Record<string, string>
      }
      expect(echoed.headers['x-forwarded-proto']).toBe('https')
      expect(echoed.headers['x-forwarded-for']).toBe('127.0.0.1')
      expect(lines.some(line => line.includes(' GET /echo 200 '))).toBe(true)
    } finally {
      await front.stop()
    }
  })
})
