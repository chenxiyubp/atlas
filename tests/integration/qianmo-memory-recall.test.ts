// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AC-4 —— 项目记忆可跨会话检索唤醒（roadmap P3.3 的 DoD，逐条对应）。
 *
 * 判据三条，本文件逐条落成用例：
 *
 *   ① 写入 5 条历史决策 → **新开无任何对话历史的会话**提问 → 命中 5/5，
 *      且输出中标注**来源 ID 与写入时间**。
 *   ② 对 3 条**从未写入**的伪造决策不产生幻觉引用。
 *   ③ （v2.2）来源标注在**两家供应商下均生效，切换供应商不改代码**。
 *
 * ## 「无历史会话」在这里是什么意思
 *
 * 每个问题都**独立构造一个只含一条用户消息的 messages 数组**：没有前一轮、
 * 没有 resume、没有跨问题共享的助手轮。模型能看到的项目知识只有系统提示词里
 * 那段 `<qianmo-memory>` 块，而它是当场从磁盘上的记忆库渲染出来的。所以「命中」
 * 只可能来自记忆注入，不可能来自对话上下文。
 *
 * ## 这里跑的是真代码还是仿真
 *
 * **全部真代码 + 真网络**：真的 `FileMemoryStore`（写在临时目录里的真文件）、
 * 真的 `@qianmo/recall` 检索与注入、基座真的适配链（`anthropicMessagesToOpenAI`
 * / `anthropicToolsToOpenAI` / `buildOpenAIRequestBody` / `applyCompatRule` /
 * `getOpenAIClient` / `adaptOpenAIStreamToAnthropic`）。没有任何 `mock.module`，
 * 没有录制回放。
 *
 * ## 为什么不用某家的原生引用块（D-6）
 *
 * 原生 `search_result` 引用块与结构化输出互斥、且只此一家有，照它实现会让 AC-4
 * 与 AC-5（模型中立）在 S1 之后互相打架。本文件用的是**工具层强制引用**：
 * 同一个 `qianmo_memory_answer` 工具定义（纯 JSON Schema，不含任何供应商名）
 * 送进两条 provider，回来的 `citations` 逐个到记忆库里解析——**解析不到的 ID
 * 无法被引用**。伪造决策不产生幻觉引用因此是一次查表，不是一句祈使。
 *
 * ## 凭据缺失时
 *
 * 无 `OPENAI_API_KEY` + `OPENAI_BASE_URL` 时真调用整组自动 skip 并打印原因，
 * 留下不需要凭据的确定性检查。凭据只从环境变量读，仓库内不存放任何密钥。
 *
 * 与 `provider-adapter-consistency.test.ts`（P1.4/AC-5）的关系：那份是 AC-5 的
 * 存档证据，本文件不去改它，因此这里另起了一份更小的调用壳（只装配文本与
 * tool_use，不需要 thinking 回填）。provider 配置仍共用同一个 fixture 文件，
 * 保证「两家」的定义只有一个出处。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  BetaRawMessageStreamEvent,
  BetaToolUnion,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions.mjs'

import {
  adaptOpenAIStreamToAnthropic,
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  asSystemPrompt,
  type UserMessage,
} from '@ant/model-provider'
import { FileMemoryStore, type MemoryEntry } from '@qianmo/memory'
import {
  buildRecallSystemPrompt,
  handleMemoryAnswer,
  MEMORY_ANSWER_TOOL,
  MEMORY_ANSWER_TOOL_NAME,
  recall,
} from '@qianmo/recall'
import { getOpenAIClient } from '../../src/services/api/openai/client.js'
import {
  buildOpenAIRequestBody,
  isOpenAIThinkingEnabled,
} from '../../src/services/api/openai/requestBody.js'
import { applyCompatRule } from '../../src/services/providerRegistry/providerCompatMatrix.js'
import {
  ProvidersFileSchema,
  type ProviderConfig,
} from '../../src/services/providerRegistry/types.js'

// ── provider 配置：与 AC-5 共用同一个 fixture ───────────────────────────────

const QIANMO_PROVIDERS_FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'qianmo-providers.json',
)

function loadFixtureProviders(): ProviderConfig[] {
  return ProvidersFileSchema.parse(
    JSON.parse(readFileSync(QIANMO_PROVIDERS_FIXTURE, 'utf-8')),
  )
}

// ── 凭据门禁 ────────────────────────────────────────────────────────────────

const API_KEY = process.env.OPENAI_API_KEY
const BASE_URL_OVERRIDE = process.env.OPENAI_BASE_URL
const LIVE_OPT_OUT = process.env.QIANMO_PROVIDER_LIVE === '0'

const skipReason = LIVE_OPT_OUT
  ? 'QIANMO_PROVIDER_LIVE=0 —— 显式关闭了真调用'
  : !API_KEY
    ? 'OPENAI_API_KEY 未设置'
    : !BASE_URL_OVERRIDE
      ? 'OPENAI_BASE_URL 未设置'
      : undefined

const LIVE = skipReason === undefined

if (!LIVE) {
  console.error(
    `[AC-4] 记忆检索唤醒真调用已跳过：${skipReason}。` +
      `设置 OPENAI_API_KEY 与 OPENAI_BASE_URL 后重跑即可。`,
  )
}

const LIVE_TIMEOUT_MS = 240_000
const MAX_TOKENS = 8192

// ── 五条历史决策与提问 ──────────────────────────────────────────────────────

type Decision = {
  readonly key: string
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly tags: readonly string[]
  /** 提问**刻意不复用条目用词**——纯确定性检索正是在这里失手的。 */
  readonly question: string
  /** 回答里必须出现的实质内容（大小写不敏感）。 */
  readonly mustMention: readonly string[]
}

const DECISIONS: readonly Decision[] = [
  {
    key: 'runtime',
    title: '统一用 Bun 作为运行时与测试器',
    summary: '本项目统一用 Bun 跑代码与跑测试，不引入 npm / pnpm',
    body: '理由：本地与 CI 行为一致，workspace 内部包自动链接。相关命令是 bun install / bun test。',
    tags: ['toolchain'],
    question: '装依赖和跑单测该用哪个包管理工具？给出结论。',
    mustMention: ['bun'],
  },
  {
    key: 'protocol',
    title: '跨节点消息走自研协议，概念对齐 A2A',
    summary: '协议自研，不直接采用现成协议栈；链路标识采用 W3C traceparent',
    body: '不把外部协议栈整包引入；只在概念层面对齐 A2A。',
    tags: ['protocol'],
    question: '节点之间通信是拿现成的框架，还是我们自己写的？',
    mustMention: ['自研'],
  },
  {
    key: 'sandbox',
    title: '沙箱定为 Dormice + gVisor，occ 跑在沙箱内',
    summary: '隔离环境选 Dormice 搭配 gVisor，编程智能体进程运行在沙箱内部',
    body: '架构上钉死「occ 跑在沙箱内」，不是沙箱跑在 occ 里。',
    tags: ['sandbox'],
    question: '智能体的隔离环境最后是怎么定的？',
    mustMention: ['dormice'],
  },
  {
    key: 'capability',
    title: 'capability 用每节点 Ed25519 签发，PSK 只做接入门禁',
    summary: '授权凭证由每个节点用 Ed25519 私钥签发；预共享密钥只用于接入门禁',
    body: '纯对称密钥无法阻止持有者伪造任意节点的令牌，因此授权面必须是签名的。',
    tags: ['security'],
    question: '授权凭证到底是对称密钥，还是签名的？',
    mustMention: ['ed25519'],
  },
  {
    key: 'memory',
    title: 'M0 不做向量检索，只做确定性检索',
    summary: '记忆召回在 M0 只做结构化条目 + 标签 + 关键词 + 时间衰减',
    body: '向量检索的召回质量不可控，放到 M1 与治理机制一起做。',
    tags: ['memory'],
    question: '记忆召回这一块要不要上 embedding？',
    mustMention: ['向量'],
  },
]

/**
 * 三条**从未写入**的伪造决策。
 *
 * 三个话题与那五条条目正交（前端框架 / 日志后端 / 数据库），提问却都带着
 * 「把那条决策的来源 ID 给我」这类**索要引用的压力**——这是幻觉引用最容易
 * 出现的形状。任何一条引用被接受都是失败。
 */
const FABRICATED: readonly { key: string; question: string }[] = [
  {
    key: 'vue',
    question: '前端 UI 框架是不是定了用 Vue？把那条决策的来源 ID 给我。',
  },
  {
    key: 'elasticsearch',
    question: '日志统一发到 Elasticsearch 是哪条决策定的？引用它。',
  },
  {
    key: 'postgres',
    question: '数据库选型定的是 PostgreSQL 吧？给出对应记忆条目的 ID。',
  },
]

const PROJECT_KEY = 'atlas'

// ── 一次真调用：基座适配链 + 我们的工具定义 ─────────────────────────────────

const MEMORY_TOOL: BetaToolUnion = {
  // 中立定义 → Anthropic 工具形状的唯一一处改名（`inputSchema` 是 MCP 的写法）。
  // 它对两条 provider **逐字相同**，所以它不是「换供应商要改的代码」。
  name: MEMORY_ANSWER_TOOL.name,
  description: MEMORY_ANSWER_TOOL.description,
  input_schema: MEMORY_ANSWER_TOOL.inputSchema,
} as unknown as BetaToolUnion

type ModelTurn = {
  readonly text: string
  readonly toolCalls: readonly { name: string; input: unknown }[]
  readonly stopReason: string | null
}

function userMessage(text: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: text },
  }
}

/** 只装配本用例需要的两样：正文文本与 tool_use 参数。 */
function assemble(events: readonly BetaRawMessageStreamEvent[]): ModelTurn {
  let text = ''
  let stopReason: string | null = null
  const buffers = new Map<number, { name: string; args: string }>()
  const order: number[] = []

  for (const event of events) {
    if (event.type === 'content_block_start') {
      const block = event.content_block as unknown as Record<string, unknown>
      if (block['type'] === 'tool_use') {
        buffers.set(event.index, {
          name: String(block['name'] ?? ''),
          args: '',
        })
        order.push(event.index)
      }
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta as unknown as Record<string, unknown>
      if (delta['type'] === 'text_delta') {
        text += String(delta['text'] ?? '')
      } else if (delta['type'] === 'input_json_delta') {
        const buffer = buffers.get(event.index)
        if (buffer) buffer.args += String(delta['partial_json'] ?? '')
      }
    } else if (event.type === 'message_delta') {
      const delta = event.delta as unknown as Record<string, unknown>
      if (typeof delta['stop_reason'] === 'string') {
        stopReason = delta['stop_reason']
      }
    }
  }

  const toolCalls = order.map(index => {
    const buffer = buffers.get(index)
    if (!buffer) throw new Error(`assemble: missing tool buffer at ${index}`)
    return {
      name: buffer.name,
      input:
        buffer.args.trim().length === 0
          ? {}
          : (JSON.parse(buffer.args) as unknown),
    }
  })

  return { text, toolCalls, stopReason }
}

/**
 * 问一个问题。
 *
 * `messages` 每次都是**新建的单条用户消息**——这就是判据里的「新开无任何对话
 * 历史的会话」。系统提示词由 `@qianmo/recall` 当场从记忆库渲染。
 */
async function askWithMemory(params: {
  provider: ProviderConfig
  system: string[]
  question: string
}): Promise<{ turn: ModelTurn; wireBody: Record<string, unknown> }> {
  const { provider, system, question } = params
  const model = provider.defaultModel
  const baseURL = BASE_URL_OVERRIDE ?? provider.baseUrl
  const enableThinking = isOpenAIThinkingEnabled(model)

  const openaiMessages = anthropicMessagesToOpenAI(
    [userMessage(question)],
    asSystemPrompt([...system]),
    { enableThinking },
  )
  const openaiTools: ChatCompletionTool[] = anthropicToolsToOpenAI([
    MEMORY_TOOL,
  ])

  const body = buildOpenAIRequestBody({
    model,
    messages: openaiMessages,
    tools: openaiTools,
    toolChoice: undefined,
    enableThinking,
    maxTokens: MAX_TOKENS,
    baseURL,
    effortValue: 'low',
  })
  const wireBody = applyCompatRule(
    body as unknown as Record<string, unknown>,
    provider.compatRule,
  )

  const client = getOpenAIClient({
    apiKeyOverride: API_KEY,
    baseURLOverride: baseURL,
  })
  const stream = await client.chat.completions.create(
    wireBody as unknown as ChatCompletionCreateParamsStreaming,
  )

  const events: BetaRawMessageStreamEvent[] = []
  for await (const event of adaptOpenAIStreamToAnthropic(stream, model)) {
    events.push(event)
  }
  return { turn: assemble(events), wireBody }
}

// ── 记忆库夹具 ──────────────────────────────────────────────────────────────

type MemoryFixture = {
  readonly store: FileMemoryStore
  readonly byKey: ReadonlyMap<string, MemoryEntry>
  dispose(): void
}

/**
 * 真磁盘上的一座记忆库，五条决策各写一条 project 层条目。
 *
 * 根目录是临时目录：`defaultMemoryRoot()` 指向开发者自己节点的记忆，测试永远
 * 不碰它。
 */
function writeFiveDecisions(): MemoryFixture {
  const directory = mkdtempSync(join(tmpdir(), 'qianmo-ac4-'))
  const store = new FileMemoryStore({ root: join(directory, 'memory') })
  const byKey = new Map<string, MemoryEntry>()
  for (const decision of DECISIONS) {
    byKey.set(
      decision.key,
      store.write({
        scope: { layer: 'project', projectKey: PROJECT_KEY },
        title: decision.title,
        summary: decision.summary,
        body: decision.body,
        tags: decision.tags,
        source: { kind: 'session', id: `ac4-${decision.key}` },
      }),
    )
  }
  return {
    store,
    byKey,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  }
}

// ── 不需要凭据的确定性检查 ──────────────────────────────────────────────────

describe('AC-4 来源标注机制与供应商无关（无需凭据）', () => {
  test('同一个工具定义在两条 provider 下转换出逐字相同的函数声明', () => {
    const declarations = loadFixtureProviders().map(provider => {
      const enableThinking = isOpenAIThinkingEnabled(provider.defaultModel)
      const body = buildOpenAIRequestBody({
        model: provider.defaultModel,
        messages: anthropicMessagesToOpenAI(
          [userMessage('q')],
          asSystemPrompt(['s']),
          { enableThinking },
        ),
        tools: anthropicToolsToOpenAI([MEMORY_TOOL]),
        toolChoice: undefined,
        enableThinking,
        maxTokens: MAX_TOKENS,
        baseURL: provider.baseUrl,
        effortValue: 'low',
      })
      const wire = applyCompatRule(
        body as unknown as Record<string, unknown>,
        provider.compatRule,
      )
      return { id: provider.id, tools: wire['tools'] }
    })

    expect(declarations.length).toBe(2)
    const [first, second] = declarations
    // 请求体的其余部分两家不同（AC-5 已实测），但**工具声明这一段完全一致**：
    // 引用机制不随供应商变化，这正是「切换供应商不改代码」的结构性证据。
    expect(JSON.stringify(first?.tools)).toBe(JSON.stringify(second?.tools))
    expect(JSON.stringify(first?.tools)).toContain(MEMORY_ANSWER_TOOL_NAME)
  })

  test('线上请求体里不含任何供应商原生引用特性', () => {
    const provider = loadFixtureProviders()[0]
    if (!provider) throw new Error('fixture ids changed')
    const enableThinking = isOpenAIThinkingEnabled(provider.defaultModel)
    const wire = applyCompatRule(
      buildOpenAIRequestBody({
        model: provider.defaultModel,
        messages: anthropicMessagesToOpenAI(
          [userMessage('q')],
          asSystemPrompt(['s']),
          { enableThinking },
        ),
        tools: anthropicToolsToOpenAI([MEMORY_TOOL]),
        toolChoice: undefined,
        enableThinking,
        maxTokens: MAX_TOKENS,
        baseURL: provider.baseUrl,
        effortValue: 'low',
      }) as unknown as Record<string, unknown>,
      provider.compatRule,
    )
    const serialized = JSON.stringify(wire)
    // D-6：原生引用块与结构化输出互斥且只此一家有。它一旦出现在线上请求里，
    // AC-4 就又被绑回单一供应商，与 AC-5 重新冲突。
    // （`citations` 这个词在请求体里是有的 —— 那是我们自己工具的入参名，
    // 不是供应商特性开关，所以这里查的是特性键本身。）
    expect(serialized).not.toContain('search_result')
    expect(serialized).not.toContain('citations_enabled')
    expect(wire['citations']).toBeUndefined()
    expect(wire['response_format']).toBeUndefined()
  })

  test('注入块带着来源 ID 与写入时间，且只含 live 条目', () => {
    const fixture = writeFiveDecisions()
    try {
      const result = recall(fixture.store, {
        question: DECISIONS[0]?.question,
        scope: { layers: ['project'], projectKey: PROJECT_KEY },
      })
      expect(result.mode).toBe('full')
      expect(result.entries.length).toBe(DECISIONS.length)

      const block = buildRecallSystemPrompt(result).join('\n')
      for (const entry of fixture.byKey.values()) {
        expect(block).toContain(entry.id)
        expect(block).toContain(entry.createdAt)
      }

      // 废止一条后重投：撤下的条目不得再出现在提示词里。
      const revoked = fixture.byKey.get('runtime')
      if (!revoked) throw new Error('fixture keys changed')
      fixture.store.revoke(revoked.id, { reason: '用于用例', by: 'ac4-test' })
      const after = recall(fixture.store, {
        scope: { layers: ['project'], projectKey: PROJECT_KEY },
      })
      expect(buildRecallSystemPrompt(after).join('\n')).not.toContain(
        revoked.id,
      )
    } finally {
      fixture.dispose()
    }
  })
})

// ── 真调用：同一套断言，对两条 provider 各跑一遍 ────────────────────────────

function runRecallSuite(provider: ProviderConfig): void {
  describe(`provider ${provider.id} (${provider.defaultModel}, compat=${provider.compatRule})`, () => {
    let fixture: MemoryFixture

    beforeAll(() => {
      fixture = writeFiveDecisions()
    })

    afterAll(() => {
      fixture.dispose()
    })

    for (const decision of DECISIONS) {
      test(
        `命中「${decision.key}」并标注来源 ID 与写入时间`,
        async () => {
          const expected = fixture.byKey.get(decision.key)
          if (!expected) throw new Error('fixture keys changed')

          // 检索 → 注入。整个上下文只有这一段记忆，没有任何对话历史。
          const result = recall(fixture.store, {
            question: decision.question,
            scope: { layers: ['project'], projectKey: PROJECT_KEY },
          })
          expect(result.mode).toBe('full')
          expect(result.degraded).toBe(false)

          const { turn } = await askWithMemory({
            provider,
            system: buildRecallSystemPrompt(result),
            question: decision.question,
          })

          const call = turn.toolCalls.find(
            c => c.name === MEMORY_ANSWER_TOOL_NAME,
          )
          if (!call) {
            throw new Error(
              `模型没有调用 ${MEMORY_ANSWER_TOOL_NAME}；stop=${turn.stopReason} text=${turn.text.slice(0, 200)}`,
            )
          }

          const answered = handleMemoryAnswer(
            fixture.store,
            result,
            call.input,
            { requireCitation: true },
          )

          expect(answered.report.problems).toEqual([])
          expect(answered.ok).toBe(true)
          expect(answered.report.accepted.map(e => e.id)).toContain(expected.id)
          // 判据字面：输出中标注**来源 ID 与写入时间**。
          expect(answered.answer).toContain(expected.id)
          expect(answered.answer).toContain(expected.createdAt)
          const lower = answered.args.answer.toLowerCase()
          for (const needle of decision.mustMention) {
            expect(lower).toContain(needle.toLowerCase())
          }

          console.error(
            `[AC-4][${provider.id}][${decision.key}] 引用=${answered.report.accepted
              .map(e => e.id)
              .join(',')} 答复="${answered.args.answer.trim().slice(0, 80)}"`,
          )
        },
        LIVE_TIMEOUT_MS,
      )
    }

    for (const fake of FABRICATED) {
      test(
        `伪造决策「${fake.key}」不产生幻觉引用`,
        async () => {
          const result = recall(fixture.store, {
            question: fake.question,
            scope: { layers: ['project'], projectKey: PROJECT_KEY },
          })

          const { turn } = await askWithMemory({
            provider,
            system: buildRecallSystemPrompt(result),
            question: fake.question,
          })
          const call = turn.toolCalls.find(
            c => c.name === MEMORY_ANSWER_TOOL_NAME,
          )
          if (!call) {
            throw new Error(
              `模型没有调用 ${MEMORY_ANSWER_TOOL_NAME}；stop=${turn.stopReason} text=${turn.text.slice(0, 200)}`,
            )
          }

          const answered = handleMemoryAnswer(fixture.store, result, call.input)

          // 结构性判据：没有任何一条引用能通过校验。模型若凭空造 ID，
          // `getEntry` 解析不到，它就进不了 accepted——这不靠提示词。
          expect(answered.report.accepted).toEqual([])
          expect(answered.answer).not.toContain('来源 / sources')

          console.error(
            `[AC-4][${provider.id}][伪造:${fake.key}] ` +
              `模型给出的引用=${JSON.stringify(answered.args.citations)} ` +
              `判定=${answered.report.checks.map(c => `${c.id}:${c.status}`).join(',') || '（无引用）'} ` +
              `答复="${answered.args.answer.trim().slice(0, 80)}"`,
          )
        },
        LIVE_TIMEOUT_MS,
      )
    }
  })
}

describe.skipIf(!LIVE)('AC-4 记忆检索唤醒（真网络）', () => {
  for (const provider of loadFixtureProviders()) {
    runRecallSuite(provider)
  }
})
