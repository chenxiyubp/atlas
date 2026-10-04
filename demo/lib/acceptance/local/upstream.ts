// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 可控假上游 —— 一个 OpenAI 兼容的本地模型端点。
 *
 * **它证明什么、不证明什么**（照 `tests/integration/qianmo-end-to-end.test.ts`
 * 的规矩，每个 stub 都要自己交代边界）：
 *
 *   证明的：常驻节点起了 ACP 子进程、子进程真的按环境里的凭据去打模型端点、
 *   一轮任务在链路上走完了、以及**发给模型的 system prompt 里写的是哪个工作
 *   目录**（那是 issue #44 唯一不靠人眼的观测点）。
 *
 *   不证明的：任何与模型质量、上游协议细节、真实厂商行为有关的事。它只按
 *   OpenAI chat-completions 的最小形状应答，够让基座的流适配器收下一轮而已。
 *
 * 为什么必须支持 **SSE**：基座默认 `stream: true`。早先一版只回非流式 JSON，
 * 表现是「turn 一直不结束、上游被重打六次、transcript 里只有 user 行没有
 * assistant 行」—— 看起来像常驻卡住，其实是假上游不会说流。**改这个文件前
 * 先确认流式分支还在。**
 *
 * 四种行为对应验收矩阵里模型凭据那一维（issue #37）：
 *   `ok`          正常应答     → 启动探针判 `reachable`，不告警
 *   `refuse`      401          → 启动探针判 `refused`，**必须**告警
 *   `hang`        接受连接不答 → 探针 10 s 超时判 `unreachable`，**不**告警
 *   `error`       500          → 也是 `reachable`（只有 401/403/407 算拒绝）
 */

export type UpstreamBehavior = 'ok' | 'refuse' | 'hang' | 'error'

export interface CapturedRequest {
  readonly at: number
  readonly method: string
  readonly path: string
  readonly body: string
}

export interface StubUpstream {
  /** `http://127.0.0.1:<port>/v1`，直接给 `OPENAI_BASE_URL`。 */
  readonly baseUrl: string
  readonly port: number
  /** 收到的全部请求原文（system prompt 就在里面）。 */
  requests(): readonly CapturedRequest[]
  /** 运行中改行为：用来测「启动时有效、运行中过期」。 */
  setBehavior(behavior: UpstreamBehavior): void
  stop(): Promise<void>
}

export interface StubUpstreamOptions {
  readonly behavior?: UpstreamBehavior
  /** 助手回复的正文，默认 `'ok'`。 */
  readonly reply?: string
}

export function startStubUpstream(
  options: StubUpstreamOptions = {},
): StubUpstream {
  let behavior: UpstreamBehavior = options.behavior ?? 'ok'
  const reply = options.reply ?? 'ok'
  const captured: CapturedRequest[] = []

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // 挂起分支要占着连接不放，Bun 默认 10 s 就把请求掐了，那会把 `hang`
    // 变成一次连接错误 —— 探针本来要观察的「接受了但不答」就消失了。
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      let body = ''
      try {
        body = await req.text()
      } catch {
        body = ''
      }
      captured.push({
        at: Date.now(),
        method: req.method,
        path: url.pathname,
        body,
      })

      if (behavior === 'refuse') {
        return Response.json(
          {
            error: {
              message: 'Invalid API key',
              type: 'invalid_request_error',
            },
          },
          { status: 401 },
        )
      }
      if (behavior === 'error') {
        return Response.json(
          { error: { message: 'stub upstream failure' } },
          { status: 500 },
        )
      }
      if (behavior === 'hang') {
        // 永不 resolve：连接建立、请求收下、应答不来。
        return await new Promise<Response>(() => {})
      }

      const wantsStream = /"stream"\s*:\s*true/.test(body)
      return wantsStream ? streamingReply(reply) : jsonReply(reply)
    },
  })

  // `server.port` 的类型是 `number | undefined`（Bun 也支持 unix socket）。
  // 这里显式给的是 TCP 端口，拿不到就是环境出了问题，早失败好过晚失败。
  const port = server.port
  if (port === undefined) {
    throw new Error('假上游没有拿到 TCP 端口')
  }

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    port,
    requests: () => captured,
    setBehavior: next => {
      behavior = next
    },
    stop: async () => {
      await server.stop(true)
    },
  }
}

function jsonReply(content: string): Response {
  return Response.json({
    id: 'stub-completion',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'qianmo-acceptance-stub',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function streamingReply(content: string): Response {
  const chunks = [
    chunk({ role: 'assistant', content }),
    { ...base(), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ]
  const text =
    chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') +
    'data: [DONE]\n\n'
  return new Response(text, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  })
}

function base(): Record<string, unknown> {
  return {
    id: 'stub-completion',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'qianmo-acceptance-stub',
  }
}

function chunk(delta: Record<string, unknown>): Record<string, unknown> {
  return { ...base(), choices: [{ index: 0, delta, finish_reason: null }] }
}

/**
 * 从抓到的请求里挑出 system prompt 报的工作目录。
 *
 * 这是 issue #44 的判据来源：基座在 `env_info_simple` 段里写
 * `Primary working directory: <cwd>`，而那段是**按段名缓存在进程全局**的，
 * 于是第一个跑起来的 agent 会把它钉死给整个进程。要看这条有没有被修好，
 * 只能看真正发出去的那份 prompt。
 */
export function workingDirectoriesSeen(
  requests: readonly CapturedRequest[],
): readonly string[] {
  const seen: string[] = []
  for (const request of requests) {
    for (const match of request.body.matchAll(
      /Primary working directory: ([^\\"\n]+)/g,
    )) {
      const value = match[1]
      if (value !== undefined && !seen.includes(value)) seen.push(value)
    }
  }
  return seen
}
