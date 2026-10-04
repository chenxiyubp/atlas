// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AC-5 一致性测试套件（roadmap P1.4）：多轮 / 工具调用 / 流式，对两个 provider
 * 各跑一遍。
 *
 * ## 判据解读的限定（必须先读）
 *
 * 章程 §4 AC-5 要求「≥ 2 个不同模型供应商**适配器**」。本仓库基座只有一种
 * `ProviderKind`（`src/services/providerRegistry/types.ts` 的
 * `z.literal('openai-compat')`），所以这里给出的两条 provider 走**同一个
 * kind**，差别在 `compatRule` 选出的 `CompatProfile`，以及模型名触发的
 * DeepSeek 调优门（`isDeepSeekTuningActiveForModel`）。这两处在代码里走**不同
 * 分支**、产出**不同的线上请求体**，是本仓库现有代码能给出的最强「两家适配器」
 * 证据，但**不等于**判据字面要求的「两个不同供应商适配器」。缺口逐条写在
 * `docs/dev/p1.4-provider-verification.md`。
 *
 * ## 这里跑的是真代码还是仿真
 *
 * **全部是基座真代码 + 真网络**：`anthropicMessagesToOpenAI` /
 * `anthropicToolsToOpenAI`（消息与工具的 Anthropic→OpenAI 转换）、
 * `buildOpenAIRequestBody`（线上请求体构造，含 DeepSeek 调优门）、
 * `applyCompatRule`（provider 注册中心的兼容档案）、`getOpenAIClient`（真 SDK
 * 客户端）、`adaptOpenAIStreamToAnthropic`（OpenAI SSE → Anthropic 事件流）。
 * 没有任何 `mock.module`，没有录制回放。
 *
 * 唯一没有走到的是 `queryModelOpenAI` 的外层查询管线（工具权限、deferred tools、
 * 计费与遥测），它需要一整个 `Options` 与 `Tools` 上下文；那一层由端到端编程任务
 * 用例（`scripts/qianmo-provider-task.ts`）覆盖。
 *
 * ## 凭据缺失时
 *
 * 无 `OPENAI_API_KEY` + `OPENAI_BASE_URL` 时整组自动 skip 并打印原因，CI 不会因
 * 缺凭据变红。凭据只从环境变量读，仓库内不存放任何密钥。
 */

import { describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionTool,
} from 'openai/resources/chat/completions/completions.mjs'

import {
  adaptOpenAIStreamToAnthropic,
  anthropicMessagesToOpenAI,
  anthropicToolsToOpenAI,
  asSystemPrompt,
  type AssistantMessage,
  type UserMessage,
} from '@ant/model-provider'
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

// ── provider 配置：唯一出处是那个 JSON 文件，测试自己不写 provider 常量 ──────

/**
 * AC-5 的「仅改配置」证据面之一：两个 provider 的全部差异都在这个文件里，
 * 测试代码对两者**逐字相同**（同一个 `runConsistencySuite` 被调用两次）。
 */
const QIANMO_PROVIDERS_FIXTURE = join(
  import.meta.dir,
  'fixtures',
  'qianmo-providers.json',
)

function loadFixtureProviders(): ProviderConfig[] {
  const raw = readFileSync(QIANMO_PROVIDERS_FIXTURE, 'utf-8')
  return ProvidersFileSchema.parse(JSON.parse(raw))
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
  // 让缺凭据的运行留下可读痕迹，而不是静默跳过。
  console.error(
    `[AC-5] provider 一致性套件已跳过：${skipReason}。` +
      `设置 OPENAI_API_KEY 与 OPENAI_BASE_URL 后重跑即可。`,
  )
}

/** 真调用超时。deepseek-v4-pro 是推理模型，reasoning 阶段本身就慢。 */
const LIVE_TIMEOUT_MS = 240_000

/** 给足预算：推理模型会把小 max_tokens 全部花在 reasoning 上。 */
const MAX_TOKENS = 8192

// ── 消息构造 helper ─────────────────────────────────────────────────────────

const SYSTEM = asSystemPrompt([
  'You are a terse test fixture. Follow the instruction exactly and do not add commentary.',
])

function userMessage(text: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: { role: 'user', content: text },
  }
}

function userToolResult(toolUseId: string, content: string): UserMessage {
  return {
    type: 'user',
    uuid: randomUUID(),
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
        },
      ],
    },
  }
}

// ── 流式事件的装配（把适配器输出还原成可以回填进下一轮的 AssistantMessage）──

interface AssembledTurn {
  events: BetaRawMessageStreamEvent[]
  /** 按到达顺序拼接的正文文本。 */
  text: string
  /** 推理文本（Anthropic thinking 块）。非推理模型为空串。 */
  thinking: string
  /** text_delta 事件条数 —— 用来证明「真的是流式」而不是一次性整块返回。 */
  textDeltaCount: number
  /** thinking_delta 事件条数。 */
  thinkingDeltaCount: number
  toolUses: Array<{ id: string; name: string; input: unknown }>
  stopReason: string | null
  usage: { input: number; output: number } | undefined
  /** 可直接塞回 messages 数组的助手轮。 */
  assistant: AssistantMessage
}

function assemble(events: BetaRawMessageStreamEvent[]): AssembledTurn {
  let text = ''
  let thinking = ''
  let textDeltaCount = 0
  let thinkingDeltaCount = 0
  let stopReason: string | null = null
  let usage: { input: number; output: number } | undefined
  const toolBuf = new Map<number, { id: string; name: string; args: string }>()
  const toolOrder: number[] = []

  for (const ev of events) {
    if (ev.type === 'content_block_start') {
      const block = ev.content_block as unknown as Record<string, unknown>
      if (block['type'] === 'tool_use') {
        toolBuf.set(ev.index, {
          id: String(block['id'] ?? ''),
          name: String(block['name'] ?? ''),
          args: '',
        })
        toolOrder.push(ev.index)
      }
    } else if (ev.type === 'content_block_delta') {
      const delta = ev.delta as unknown as Record<string, unknown>
      if (delta['type'] === 'text_delta') {
        text += String(delta['text'] ?? '')
        textDeltaCount += 1
      } else if (delta['type'] === 'thinking_delta') {
        thinking += String(delta['thinking'] ?? '')
        thinkingDeltaCount += 1
      } else if (delta['type'] === 'input_json_delta') {
        const buf = toolBuf.get(ev.index)
        if (buf) buf.args += String(delta['partial_json'] ?? '')
      }
    } else if (ev.type === 'message_delta') {
      const delta = ev.delta as unknown as Record<string, unknown>
      const reason = delta['stop_reason']
      if (typeof reason === 'string') stopReason = reason
      const u = (ev as unknown as Record<string, unknown>)['usage'] as
        | Record<string, unknown>
        | undefined
      if (u) {
        usage = {
          input: Number(u['input_tokens'] ?? 0),
          output: Number(u['output_tokens'] ?? 0),
        }
      }
    }
  }

  const toolUses = toolOrder.map(index => {
    const buf = toolBuf.get(index)
    if (!buf) throw new Error(`assemble: missing tool buffer at ${index}`)
    let input: unknown = {}
    if (buf.args.trim().length > 0) {
      input = JSON.parse(buf.args)
    }
    return { id: buf.id, name: buf.name, input }
  })

  // 回填用的助手轮。thinking 块必须保留：DeepSeek 的 reasoning_content 回声
  // 契约就靠它，`applyCompatRule('deepseek')` 的 always-preserve 分支也靠它。
  const content: Record<string, unknown>[] = []
  if (thinking.length > 0) {
    content.push({ type: 'thinking', thinking, signature: '' })
  }
  if (text.length > 0) {
    content.push({ type: 'text', text })
  }
  for (const tu of toolUses) {
    content.push({
      type: 'tool_use',
      id: tu.id,
      name: tu.name,
      input: tu.input,
    })
  }

  const assistant: AssistantMessage = {
    type: 'assistant',
    uuid: randomUUID(),
    message: {
      role: 'assistant',
      content: content as unknown as AssistantMessage['message']['content'],
    },
  }

  return {
    events,
    text,
    thinking,
    textDeltaCount,
    thinkingDeltaCount,
    toolUses,
    stopReason,
    usage,
    assistant,
  }
}

// ── 一次真调用：基座适配器全链路 ────────────────────────────────────────────

/**
 * 走一遍基座的 OpenAI 适配链：
 * 消息转换 → 工具转换 → 请求体构造（含 DeepSeek 调优门）→ compat 档案裁剪
 * → 真 HTTP 流 → Anthropic 事件流适配。
 *
 * 返回装配结果与**实际发出的线上请求体**（后者是「两家走了不同分支」的物证）。
 */
async function callProvider(params: {
  provider: ProviderConfig
  messages: (UserMessage | AssistantMessage)[]
  tools?: BetaToolUnion[]
}): Promise<{ turn: AssembledTurn; wireBody: Record<string, unknown> }> {
  const { provider, messages, tools = [] } = params
  const model = provider.defaultModel
  // baseUrl 以环境变量为准（网关地址可能随部署变动），配置文件里的值是默认。
  const baseURL = BASE_URL_OVERRIDE ?? provider.baseUrl
  const enableThinking = isOpenAIThinkingEnabled(model)

  const openaiMessages = anthropicMessagesToOpenAI(messages, SYSTEM, {
    enableThinking,
  })
  const openaiTools: ChatCompletionTool[] = anthropicToolsToOpenAI(tools)

  const body = buildOpenAIRequestBody({
    model,
    messages: openaiMessages,
    tools: openaiTools,
    toolChoice: undefined,
    enableThinking,
    maxTokens: MAX_TOKENS,
    baseURL,
    // 三档里的最低档：一致性套件不需要最贵的推理预算。
    effortValue: 'low',
  })

  // provider 注册中心声明的兼容档案。基座的线上请求路径目前**没有**调用它
  // （见 docs/dev/p1.4-provider-verification.md 的缺口 G-2），这里显式调用，
  // 把注册中心声明的适配行为一并纳入核验。
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
  for await (const ev of adaptOpenAIStreamToAnthropic(stream, model)) {
    events.push(ev)
  }

  return { turn: assemble(events), wireBody }
}

// ── 三项一致性 ──────────────────────────────────────────────────────────────

const WEATHER_TOOL: BetaToolUnion = {
  name: 'get_build_status',
  description:
    'Return the CI build status for a project. Call this instead of guessing.',
  input_schema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project name' },
    },
    required: ['project'],
  },
} as unknown as BetaToolUnion

function runConsistencySuite(provider: ProviderConfig): void {
  describe(`provider ${provider.id} (${provider.defaultModel}, compat=${provider.compatRule})`, () => {
    test(
      '流式：事件序列完整、正文分多个 delta 到达',
      async () => {
        const { turn } = await callProvider({
          provider,
          messages: [
            userMessage(
              'Write exactly one sentence of at least twenty words about ocean tides. No preamble.',
            ),
          ],
        })

        const types = turn.events.map(e => e.type)
        expect(types[0]).toBe('message_start')
        expect(types[types.length - 1]).toBe('message_stop')
        expect(types).toContain('content_block_start')
        expect(types).toContain('content_block_stop')
        expect(types).toContain('message_delta')

        // 「流式」的实质判据：正文分多次到达，不是一发整块。
        expect(turn.textDeltaCount).toBeGreaterThan(1)
        expect(turn.text.trim().length).toBeGreaterThan(40)
        expect(turn.stopReason).toBe('end_turn')

        console.error(
          `[AC-5][${provider.id}][流式] text_delta=${turn.textDeltaCount} ` +
            `thinking_delta=${turn.thinkingDeltaCount} ` +
            `usage=${turn.usage ? `${turn.usage.input}/${turn.usage.output}` : '未返回'} ` +
            `stop=${turn.stopReason}`,
        )
      },
      LIVE_TIMEOUT_MS,
    )

    test(
      '多轮：第三轮答案依赖第一轮的上下文',
      async () => {
        const first = await callProvider({
          provider,
          messages: [
            userMessage(
              'Remember this number: 41. Reply with the single word OK and nothing else.',
            ),
          ],
        })
        expect(first.turn.text.toUpperCase()).toContain('OK')

        // 第二轮把**模型自己产生的**助手轮回填进去（含 thinking 块，如果有），
        // 走的是 anthropicMessagesToOpenAI 的真实回放路径。
        const second = await callProvider({
          provider,
          messages: [
            userMessage(
              'Remember this number: 41. Reply with the single word OK and nothing else.',
            ),
            first.turn.assistant,
            userMessage(
              'Add one to the number I asked you to remember. Reply with only the resulting number.',
            ),
          ],
        })

        expect(second.turn.text).toContain('42')

        console.error(
          `[AC-5][${provider.id}][多轮] 第一轮="${first.turn.text.trim().slice(0, 40)}" ` +
            `回填 thinking 块=${first.turn.thinking.length > 0 ? '有' : '无'} ` +
            `第二轮="${second.turn.text.trim().slice(0, 60)}"`,
        )
      },
      LIVE_TIMEOUT_MS,
    )

    test(
      '工具调用：发起调用 + 回灌 tool_result 后据其作答',
      async () => {
        const prompt = userMessage(
          'What is the CI build status of the project named qianmo? ' +
            'You must call the get_build_status tool; do not answer from memory.',
        )

        const first = await callProvider({
          provider,
          messages: [prompt],
          tools: [WEATHER_TOOL],
        })

        expect(first.turn.toolUses.length).toBeGreaterThan(0)
        const call = first.turn.toolUses[0]
        if (!call) throw new Error('unreachable: toolUses is non-empty')
        expect(call.name).toBe('get_build_status')
        expect(call.id.length).toBeGreaterThan(0)
        expect(typeof call.input).toBe('object')
        expect(
          String((call.input as Record<string, unknown>)['project']),
        ).toContain('qianmo')
        expect(first.turn.stopReason).toBe('tool_use')

        // 回灌工具结果 —— 这一步同时是 reasoning_content 回声契约的实测：
        // DeepSeek 档案 always-preserve，strict-openai 档案一律剥除。
        const second = await callProvider({
          provider,
          messages: [
            prompt,
            first.turn.assistant,
            userToolResult(
              call.id,
              '{"project":"qianmo","status":"failing","failing_job":"typecheck"}',
            ),
          ],
          tools: [WEATHER_TOOL],
        })

        expect(second.turn.text.toLowerCase()).toContain('failing')

        console.error(
          `[AC-5][${provider.id}][工具调用] 调用=${call.name} ` +
            `参数=${JSON.stringify(call.input)} stop=${first.turn.stopReason} ` +
            `回灌后答复="${second.turn.text.trim().slice(0, 80)}"`,
        )
      },
      LIVE_TIMEOUT_MS,
    )
  })
}

// ── 不需要凭据的确定性检查：两条 provider 确实走了不同分支 ───────────────────

describe('AC-5 provider 配置与适配分支（无需凭据）', () => {
  test('配置文件解析出恰好两个 openai-compat provider，且 compat 档案不同', () => {
    const providers = loadFixtureProviders()
    expect(providers.length).toBe(2)
    expect(new Set(providers.map(p => p.kind))).toEqual(
      new Set(['openai-compat']),
    )
    expect(new Set(providers.map(p => p.compatRule))).toEqual(
      new Set(['deepseek', 'strict-openai']),
    )
    // 密钥只来自环境变量，配置文件里存的是变量名。
    for (const p of providers) {
      expect(p.apiKeyEnv).toMatch(/^[A-Z0-9_]+$/)
    }
  })

  test('同一段对话在两条 provider 下产出不同的线上请求体', () => {
    const providers = loadFixtureProviders()
    const bodies = providers.map(provider => {
      const enableThinking = isOpenAIThinkingEnabled(provider.defaultModel)
      const body = buildOpenAIRequestBody({
        model: provider.defaultModel,
        messages: anthropicMessagesToOpenAI([userMessage('hi')], SYSTEM, {
          enableThinking,
        }),
        tools: [],
        toolChoice: undefined,
        enableThinking,
        maxTokens: MAX_TOKENS,
        baseURL: provider.baseUrl,
        effortValue: 'low',
      })
      return {
        id: provider.id,
        wire: applyCompatRule(
          body as unknown as Record<string, unknown>,
          provider.compatRule,
        ),
      }
    })

    const deepseek = bodies.find(b => b.id === 'qianmo-deepseek')?.wire
    const strictOpenai = bodies.find(b => b.id === 'qianmo-alt')?.wire
    if (!deepseek || !strictOpenai) throw new Error('fixture ids changed')

    // DeepSeek 分支：thinking 三件套 + reasoning_effort + 保留 stream_options
    expect(deepseek['thinking']).toEqual({ type: 'enabled' })
    expect(deepseek['enable_thinking']).toBe(true)
    expect(deepseek['reasoning_effort']).toBe('low')
    expect(deepseek['stream_options']).toEqual({ include_usage: true })

    // strict-openai 分支：一个 thinking 字段都不带，stream_options 被剥除
    expect(strictOpenai['thinking']).toBeUndefined()
    expect(strictOpenai['enable_thinking']).toBeUndefined()
    expect(strictOpenai['chat_template_kwargs']).toBeUndefined()
    expect(strictOpenai['reasoning_effort']).toBeUndefined()
    expect(strictOpenai['stream_options']).toBeUndefined()

    expect(JSON.stringify(deepseek)).not.toBe(JSON.stringify(strictOpenai))
  })

  test('reasoning_content 回声策略：deepseek 保留、strict-openai 剥除', () => {
    const assistantWithThinking: AssistantMessage = {
      type: 'assistant',
      uuid: randomUUID(),
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'chain of thought', signature: '' },
          { type: 'text', text: 'answer' },
        ] as unknown as AssistantMessage['message']['content'],
      },
    }
    const converted = anthropicMessagesToOpenAI(
      [userMessage('q'), assistantWithThinking, userMessage('follow up')],
      SYSTEM,
      { enableThinking: true },
    )
    const body: Record<string, unknown> = {
      model: 'x',
      messages: converted as unknown as Record<string, unknown>[],
    }

    const kept = applyCompatRule(body, 'deepseek')['messages'] as Record<
      string,
      unknown
    >[]
    const stripped = applyCompatRule(body, 'strict-openai')[
      'messages'
    ] as Record<string, unknown>[]

    expect(kept.some(m => 'reasoning_content' in m)).toBe(true)
    expect(stripped.some(m => 'reasoning_content' in m)).toBe(false)
  })
})

// ── 真调用：同一套断言，对两条 provider 各跑一遍 ────────────────────────────

describe.skipIf(!LIVE)('AC-5 适配器一致性（真网络）', () => {
  for (const provider of loadFixtureProviders()) {
    runConsistencySuite(provider)
  }
})
