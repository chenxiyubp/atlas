// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The preset catalog (§4.2–§4.4). The ONLY vendor list in the codebase: the
 * console renders it, the node validates against the same module (R-1).
 *
 * Provenance. Every entry records the official page it was taken from and the
 * date that page was read (`source`). All of them were read on 2026-10-03 via
 * the vendors research file, which quotes the vendors' own docs; none was
 * exercised with a real key, so every entry is `evaluated: false` (§8.4) and
 * must stay so until a real-key smoke test records evidence. Anything the
 * research could not confirm is listed in `unverified` instead of being filled
 * in.
 *
 * Capability bits. A model with `send: always | never` needs the explicit,
 * all-six capability list (§3.2). The three thinking bits are prefilled with
 * the value the base computes TODAY for a non-Claude third-party model on that
 * lane (read from `thinking.ts` / `betas.ts` at 33dc81bf): Anthropic lane
 * `thinking = true`, `adaptive_thinking = false`, `interleaved_thinking =
 * false`; OpenAI lanes all three `false`. That keeps a preset from changing
 * thinking behaviour on the strength of a document nobody has tested. Where a
 * vendor's docs suggest otherwise it is noted in `unverified`.
 */

import type {
  AuthScheme,
  CompatEnv,
  EffortLevel,
  Lane,
  ModelCapabilities,
  ModelEffort,
  ModelRole,
  ModelTier,
  Plan,
  ProbeSpec,
  ProviderModel,
  Terms,
} from './types.js'

export type PresetGroup = 'cn-paygo' | 'intl' | 'plan' | 'local' | 'custom'

/** Display order of the groups (§4.1 rule 6, §6.3.2). */
export const PRESET_GROUPS: readonly PresetGroup[] = [
  'cn-paygo',
  'intl',
  'plan',
  'local',
  'custom',
]

export type PresetSite = { id: string; label: string; baseUrl: string }

export type TemplateVar = { name: string; label: string }

/** Soft hint only (§4.1 rule 4): never a reason to refuse a key. */
export type KeyHint = {
  prefixes: readonly string[]
  /** Regex source, for formats a prefix cannot express. */
  pattern?: string
  display: string
}

export type Preset = {
  id: string
  vendor: string
  name: string
  group: PresetGroup
  plan: Plan
  lane: Lane
  /** Default site's base URL; may hold `{Name}` placeholders. */
  baseUrl: string
  /** Alternative sites; the first entry equals `baseUrl`. Empty for one site. */
  sites: readonly PresetSite[]
  templateVars: readonly TemplateVar[]
  authScheme: AuthScheme
  models: readonly ProviderModel[]
  compat: CompatEnv
  probe: ProbeSpec
  /** `null` = the research found no official statement of the format. */
  keyHint: KeyHint | null
  /** A value local servers accept in place of a key (`ollama`, `dummy`). */
  placeholderKey?: string
  terms: Terms | null
  source: { url: string; verifiedAt: string }
  /** Literal `false`: flipping it needs evidence and a type change (§8.4). */
  evaluated: false
  /** `false` keeps it out of the preset grid (reachable only via custom). */
  listed: boolean
  unverified: readonly string[]
  notes: readonly string[]
}

const VERIFIED_AT = '2026-10-03'

const FAMILY: ModelCapabilities = { mode: 'family' }

/** Base family default for a non-Claude model on the Anthropic lane. */
const ANTHROPIC_LANE_BITS: ModelCapabilities = {
  mode: 'explicit',
  thinking: true,
  adaptive_thinking: false,
  interleaved_thinking: false,
}

/** Base family default for a non-Claude model on an OpenAI lane. */
const OPENAI_LANE_BITS: ModelCapabilities = {
  mode: 'explicit',
  thinking: false,
  adaptive_thinking: false,
  interleaved_thinking: false,
}

const MAIN_TIERS: readonly ModelTier[] = ['opus', 'sonnet', 'fable']
const FAST_TIERS: readonly ModelTier[] = ['haiku']
const ALL_TIERS: readonly ModelTier[] = ['opus', 'sonnet', 'haiku', 'fable']

const AUTO: ModelEffort = { send: 'auto' }

function always(
  levels: readonly EffortLevel[],
  level?: EffortLevel,
): ModelEffort {
  return level === undefined
    ? { send: 'always', levels }
    : { send: 'always', levels, level }
}

const NEVER: ModelEffort = { send: 'never' }

function model(
  id: string,
  role: ModelRole,
  tiers: readonly ModelTier[],
  capabilities: ModelCapabilities,
  effort: ModelEffort,
  contextTokens?: number,
): ProviderModel {
  return contextTokens === undefined
    ? { id, role, tiers, capabilities, effort }
    : { id, role, tiers, capabilities, effort, contextTokens }
}

const get = (path: string, free = true) =>
  ({ method: 'GET', path, free }) as const

const NO_PROBE: ProbeSpec = { auth: null, models: null }

/** Non-Anthropic host on the Anthropic lane: no Claude-only beta fields (§3.6). */
const THIRD_PARTY_ANTHROPIC: CompatEnv = {
  CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
}

const PLAN_TERMS_NOTE =
  '套餐条款多限定用于交互式编程工具 · 远端智能体代为调用可能不符合条款 · 请对照官方条款自行判断'

function planTerms(url: string): Terms {
  return { restricted: true, note: PLAN_TERMS_NOTE, url }
}

const UNVERIFIED_PREFIX = '密钥前缀厂商文档未写明'
const THINKING_BITS_NOTE =
  '三个 thinking 能力位按基座对该线路非 Claude 模型的族默认值预填 · 未用真 key 验证'

type PresetInput = Omit<
  Preset,
  'evaluated' | 'listed' | 'sites' | 'templateVars' | 'unverified' | 'notes'
> &
  Partial<
    Pick<Preset, 'listed' | 'sites' | 'templateVars' | 'unverified' | 'notes'>
  >

function preset(input: PresetInput): Preset {
  return {
    sites: [],
    templateVars: [],
    unverified: [],
    notes: [],
    listed: true,
    ...input,
    evaluated: false,
  }
}

const source = (url: string) => ({ url, verifiedAt: VERIFIED_AT })

// ---------------------------------------------------------------------------
// 国内按量（§4.2）
// ---------------------------------------------------------------------------

const CN_PAYGO: readonly Preset[] = [
  preset({
    id: 'ark',
    vendor: '火山方舟',
    name: '火山方舟 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/compatible',
    authScheme: 'bearer',
    models: [
      model('doubao-seed-2-1-pro-260915', 'main', MAIN_TIERS, FAMILY, AUTO),
      model('doubao-seed-2-1-lite-260915', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: {
      auth: {
        method: 'POST',
        path: '/api/compatible/v1/messages/count_tokens',
        body: {
          model: 'doubao-seed-2-1-pro-260915',
          messages: [{ role: 'user', content: 'ping' }],
        },
        free: false,
      },
      models: null,
    },
    keyHint: null,
    terms: null,
    source: source('https://www.volcengine.com/docs/82379/1449737'),
    unverified: [
      UNVERIFIED_PREFIX,
      'count_tokens 是否计费文档未写 · 按计费处理',
      '官方 Claude Code 示例的模型版本是 -260628 · 推荐表是 -260915 · 以控制台为准',
    ],
    notes: [
      'model 字段也可以填自定义推理接入点 ep-…',
      '数据面没有模型列表端点',
    ],
  }),
  preset({
    id: 'deepseek',
    vendor: 'DeepSeek',
    name: 'DeepSeek 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://api.deepseek.com',
    authScheme: 'bearer',
    models: [
      model(
        'deepseek-v4-pro',
        'main',
        MAIN_TIERS,
        ANTHROPIC_LANE_BITS,
        always(['low', 'high', 'max'], 'max'),
      ),
      model(
        'deepseek-flash',
        'fast',
        FAST_TIERS,
        ANTHROPIC_LANE_BITS,
        always(['low', 'high', 'max'], 'max'),
      ),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: get('/user/balance'), models: get('/models') },
    keyHint: { prefixes: ['sk-'], display: 'sk-' },
    terms: null,
    source: source('https://api-docs.deepseek.com/guides/anthropic_api/'),
    unverified: [THINKING_BITS_NOTE],
    notes: [
      '编译成 OPENAI_* 形式 · 由运行时镜像改走官方 Anthropic 端点（设计 §3.3）',
      'deepseek-v4-flash 是遗留别名 · 官方主名 deepseek-flash',
    ],
  }),
  preset({
    id: 'kimi',
    vendor: '月之暗面',
    name: 'Kimi 开放平台 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    sites: [
      {
        id: 'cn',
        label: '国内站',
        baseUrl: 'https://api.moonshot.cn/anthropic',
      },
      {
        id: 'intl',
        label: '国际站',
        baseUrl: 'https://api.moonshot.ai/anthropic',
      },
    ],
    authScheme: 'bearer',
    models: [
      model(
        'kimi-k3',
        'main',
        MAIN_TIERS,
        ANTHROPIC_LANE_BITS,
        always(['low', 'high', 'max'], 'max'),
        1_000_000,
      ),
      model(
        'kimi-k2.6',
        'fast',
        FAST_TIERS,
        ANTHROPIC_LANE_BITS,
        always(['low', 'high', 'max'], 'max'),
      ),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: get('/v1/users/me/balance'), models: get('/v1/models') },
    keyHint: null,
    terms: null,
    source: source('https://platform.kimi.com/docs/api/messages'),
    unverified: [UNVERIFIED_PREFIX, THINKING_BITS_NOTE],
    notes: ['国内站与国际站的密钥完全独立 · 混用返回 401'],
  }),
  preset({
    id: 'mimo',
    vendor: '小米 MiMo',
    name: '小米 MiMo 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://api.xiaomimimo.com/anthropic',
    authScheme: 'bearer',
    models: [
      model(
        'mimo-v2.6-pro',
        'main',
        MAIN_TIERS,
        ANTHROPIC_LANE_BITS,
        NEVER,
        1_000_000,
      ),
      model(
        'mimo-v2.6-flash',
        'fast',
        FAST_TIERS,
        ANTHROPIC_LANE_BITS,
        NEVER,
        1_000_000,
      ),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: get('/v1/models'), models: get('/v1/models') },
    keyHint: { prefixes: ['sk-'], display: 'sk-' },
    terms: null,
    source: source('https://mimo.mi.com/static/docs/api/chat/anthropic-api.md'),
    unverified: [
      THINKING_BITS_NOTE,
      '文档只写 api-key 头与 Bearer · 没写 x-api-key',
    ],
    notes: [
      'effort 只分开和关 · 不分强度',
      'mimo-v2.5-pro 与 mimo-v2.5 于 2026-10-21 下线 · 见下线表',
    ],
  }),
  preset({
    id: 'minimax',
    vendor: 'MiniMax',
    name: 'MiniMax 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://api.minimax.cn/anthropic',
    sites: [
      {
        id: 'cn',
        label: '国内站',
        baseUrl: 'https://api.minimax.cn/anthropic',
      },
      {
        id: 'intl',
        label: '国际站',
        baseUrl: 'https://api.minimax.io/anthropic',
      },
    ],
    authScheme: 'bearer',
    models: [
      model(
        'MiniMax-M3',
        'main',
        MAIN_TIERS,
        ANTHROPIC_LANE_BITS,
        NEVER,
        1_000_000,
      ),
      model(
        'MiniMax-M2.7-highspeed',
        'fast',
        FAST_TIERS,
        ANTHROPIC_LANE_BITS,
        NEVER,
      ),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: get('/v1/models'), models: get('/v1/models') },
    keyHint: null,
    terms: null,
    source: source(
      'https://platform.minimax.cn/docs/api-reference/text-anthropic-api',
    ),
    unverified: [
      UNVERIFIED_PREFIX,
      THINKING_BITS_NOTE,
      '厂商文档的 thinking.type 只列 adaptive 与 disabled · 基座族默认发 enabled · 是否被接受未核实',
    ],
    notes: ['effort 只对 M3.1 生效 · MiniMax-M3.1-Flash-Preview 只开放给订阅'],
  }),
  preset({
    id: 'qianfan',
    vendor: '百度千帆',
    name: '百度千帆 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://qianfan.baidubce.com/anthropic',
    authScheme: 'bearer',
    models: [
      model('ernie-5.1', 'main', MAIN_TIERS, FAMILY, AUTO),
      model('ernie-4.5-turbo-128k', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: get('/v2/models'), models: get('/v2/models') },
    keyHint: { prefixes: ['bce-v3/ALTAK-'], display: 'bce-v3/ALTAK-' },
    terms: null,
    source: source('https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb'),
    notes: ['坏密钥返回 403'],
  }),
  preset({
    id: 'qwen',
    vendor: '阿里云百炼',
    name: '阿里云百炼 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://{WorkspaceId}.{region}.maas.aliyuncs.com/apps/anthropic',
    templateVars: [
      { name: 'WorkspaceId', label: '业务空间 ID' },
      { name: 'region', label: '地域（例如 cn-beijing）' },
    ],
    authScheme: 'bearer',
    models: [
      model('qwen3.8-max', 'main', MAIN_TIERS, FAMILY, AUTO, 1_000_000),
      model('qwen3.8-flash', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: { prefixes: ['sk-', 'sk-ws'], display: 'sk- · sk-ws' },
    terms: null,
    source: source('https://help.aliyun.com/zh/model-studio/base-url'),
    unverified: [
      'compatible-mode/v1/models 只有探测证据 · 官方文档未见',
      'sk-ws 前缀只见于英文版文档',
    ],
    notes: [
      'Anthropic 层没有模型列表接口',
      '各地域密钥互相独立 · 专属域名只认所属业务空间的密钥',
    ],
  }),
  preset({
    id: 'siliconflow',
    vendor: '硅基流动',
    name: '硅基流动 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://api.siliconflow.cn',
    authScheme: 'bearer',
    models: [
      model('deepseek-ai/DeepSeek-V4-Pro', 'main', MAIN_TIERS, FAMILY, AUTO),
      model('deepseek-ai/DeepSeek-V4-Flash', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: {
      auth: get('/v1/user/info'),
      models: get('/v1/models?sub_type=chat'),
    },
    keyHint: null,
    terms: null,
    source: source(
      'https://docs.siliconflow.cn/docs/api/chat-completions-post',
    ),
    unverified: [UNVERIFIED_PREFIX, '国际站当前模型 ID 未核实'],
    notes: ['Anthropic 线填根地址 · 不带 /v1', '没有 Responses'],
  }),
  preset({
    id: 'stepfun',
    vendor: '阶跃星辰',
    name: '阶跃星辰 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://api.stepfun.com',
    sites: [
      { id: 'cn', label: '国内站', baseUrl: 'https://api.stepfun.com' },
      { id: 'intl', label: '国际站', baseUrl: 'https://api.stepfun.ai' },
    ],
    authScheme: 'bearer',
    models: [
      model(
        'step-5-preview',
        'main',
        MAIN_TIERS,
        ANTHROPIC_LANE_BITS,
        always(['low', 'medium', 'high']),
        1_000_000,
      ),
      model(
        'step-3.7-flash',
        'fast',
        FAST_TIERS,
        ANTHROPIC_LANE_BITS,
        always(['low', 'medium', 'high']),
      ),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: get('/v1/models'), models: get('/v1/models') },
    keyHint: null,
    terms: null,
    source: source(
      'https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create',
    ),
    unverified: [
      UNVERIFIED_PREFIX,
      THINKING_BITS_NOTE,
      'Messages 端字段表没有 thinking · 基座族默认会发 thinking · 是否被忽略未核实',
    ],
    notes: ['Anthropic 端只认 output_config.effort'],
  }),
  preset({
    id: 'tokenhub',
    vendor: '腾讯',
    name: '腾讯 TokenHub 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://tokenhub.tencentmaas.com',
    authScheme: 'bearer',
    models: [
      model('hy4-preview', 'main', MAIN_TIERS, FAMILY, AUTO),
      model('hy3', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: get('/v1/models'), models: get('/v1/models') },
    keyHint: null,
    terms: null,
    source: source('https://cloud.tencent.com/document/product/1823/130079'),
    unverified: [UNVERIFIED_PREFIX],
    notes: [
      'Anthropic 的 base 不带 /v1',
      '模型要先在控制台开通 · 否则返回 402',
    ],
  }),
  preset({
    id: 'zhipu',
    vendor: '智谱',
    name: '智谱 按量',
    group: 'cn-paygo',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    sites: [
      {
        id: 'cn',
        label: '国内站',
        baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      },
      { id: 'intl', label: 'z.ai', baseUrl: 'https://api.z.ai/api/anthropic' },
    ],
    authScheme: 'bearer',
    models: [
      model('glm-5.3', 'main', MAIN_TIERS, FAMILY, AUTO, 1_000_000),
      model('glm-5.3-flash', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: {
      auth: {
        method: 'POST',
        path: '/api/paas/v4/chat/completions',
        body: {
          model: 'glm-4.7-flash',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        },
        free: true,
      },
      models: null,
    },
    keyHint: {
      prefixes: [],
      pattern: '^[^.\\s]+\\.[^.\\s]+$',
      display: '{id}.{secret}',
    },
    terms: null,
    source: source('https://docs.bigmodel.cn/cn/guide/capabilities/thinking'),
    unverified: ['国内站与 z.ai 的密钥是否互通未核实'],
    notes: [
      '部分路径鉴权失败也返回 HTTP 200 · 测连要看响应体',
      '订阅过 Coding Plan 的账号按量只能走 Chat 线',
    ],
  }),
]

// ---------------------------------------------------------------------------
// 国际（§4.2）
// ---------------------------------------------------------------------------

const OPENAI_LEVELS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]

const INTL: readonly Preset[] = [
  preset({
    id: 'anthropic',
    vendor: 'Anthropic',
    name: 'Anthropic',
    group: 'intl',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    authScheme: 'x-api-key',
    models: [
      model('claude-opus-5-5', 'main', ['opus'], FAMILY, AUTO),
      model('claude-sonnet-5-5', 'extra', ['sonnet'], FAMILY, AUTO),
      model('claude-haiku-4-5', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: {},
    probe: { auth: get('/v1/models'), models: get('/v1/models') },
    keyHint: { prefixes: ['sk-ant-api'], display: 'sk-ant-api' },
    terms: null,
    source: source(
      'https://platform.claude.com/docs/en/build-with-claude/effort',
    ),
    notes: [
      '官方模型在基座能力表里 · effort 用 auto',
      '多 workspace 的密钥要带 anthropic-workspace-id · 填进 ANTHROPIC_CUSTOM_HEADERS',
    ],
  }),
  preset({
    id: 'azure',
    vendor: 'Azure OpenAI',
    name: 'Azure OpenAI（模板）',
    group: 'intl',
    plan: 'paygo',
    lane: 'openai-responses',
    baseUrl: 'https://{resource}.openai.azure.com/openai/v1/',
    templateVars: [{ name: 'resource', label: '资源名' }],
    authScheme: 'bearer',
    models: [],
    compat: {},
    probe: NO_PROBE,
    keyHint: null,
    terms: null,
    source: source(
      'https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle',
    ),
    listed: false,
    unverified: [
      '鉴权写法未核实：REST 示例用 api-key 头 · SDK 发 Bearer（设计 §11 第 7 条）',
    ],
    notes: ['模型字段填部署名', 'P18.13 之前只能从自定义进入'],
  }),
  preset({
    id: 'gemini',
    vendor: 'Google',
    name: 'Google Gemini',
    group: 'intl',
    plan: 'paygo',
    lane: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authScheme: 'bearer',
    models: [
      model(
        'gemini-3.8-flash',
        'main',
        ['sonnet', 'haiku'],
        FAMILY,
        AUTO,
        1_048_576,
      ),
      model(
        'gemini-3.1-pro-preview',
        'extra',
        ['opus', 'fable'],
        FAMILY,
        AUTO,
        1_048_576,
      ),
    ],
    compat: {},
    probe: {
      auth: get('/v1beta/openai/models'),
      models: get('/v1beta/openai/models'),
    },
    keyHint: null,
    terms: null,
    source: source('https://ai.google.dev/gemini-api/docs/api-key'),
    unverified: [
      UNVERIFIED_PREFIX,
      'Gemini 3 对 thinkingBudget 的处理（§5.10）',
    ],
    notes: [
      '该服务的可用地区不含中国大陆和港澳 · 节点所在地区可能被拒',
      'v1 只允许 effort auto',
    ],
  }),
  preset({
    id: 'mistral',
    vendor: 'Mistral',
    name: 'Mistral',
    group: 'intl',
    plan: 'paygo',
    lane: 'openai-chat',
    baseUrl: 'https://api.mistral.ai/v1',
    authScheme: 'bearer',
    models: [
      model('mistral-medium-3-5', 'main', MAIN_TIERS, OPENAI_LANE_BITS, NEVER),
      model('mistral-small-2603', 'fast', FAST_TIERS, OPENAI_LANE_BITS, NEVER),
    ],
    compat: {},
    probe: { auth: get('/v1/models'), models: get('/v1/models') },
    keyHint: null,
    terms: null,
    source: source('https://docs.mistral.ai/studio/conversations/reasoning'),
    unverified: [UNVERIFIED_PREFIX, THINKING_BITS_NOTE],
    notes: ['推理关闭：开推理后 content 是数组 · 运行时还没有处理'],
  }),
  preset({
    id: 'openai',
    vendor: 'OpenAI',
    name: 'OpenAI',
    group: 'intl',
    plan: 'paygo',
    lane: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    authScheme: 'bearer',
    models: [
      model(
        'gpt-6.1-sol',
        'main',
        ['sonnet'],
        OPENAI_LANE_BITS,
        always(OPENAI_LEVELS),
        1_050_000,
      ),
      model(
        'gpt-6-astra',
        'extra',
        ['opus', 'fable'],
        OPENAI_LANE_BITS,
        always(OPENAI_LEVELS),
        1_050_000,
      ),
      model(
        'gpt-6-luna',
        'fast',
        FAST_TIERS,
        OPENAI_LANE_BITS,
        always(OPENAI_LEVELS),
        1_050_000,
      ),
      model('gpt-5.3-codex', 'extra', [], FAMILY, AUTO),
    ],
    compat: {},
    probe: { auth: get('/v1/models'), models: get('/v1/models') },
    keyHint: { prefixes: ['sk-'], display: 'sk-' },
    terms: null,
    source: source('https://developers.openai.com/api/docs/guides/reasoning'),
    unverified: [
      THINKING_BITS_NOTE,
      '各模型 levels 摘自官网 reasoning 页 · 服务端是否按 max 执行没有证据（设计 §11 第 2 条）',
      'gpt-6.1-sol 官网写不支持 none 与 minimal · 其余档位未逐个用真 key 核对',
    ],
    notes: ['GPT-6 系必须走 Responses · Chat 上不能带工具'],
  }),
  preset({
    id: 'openrouter',
    vendor: 'OpenRouter',
    name: 'OpenRouter（Claude 模型）',
    group: 'intl',
    plan: 'paygo',
    lane: 'anthropic',
    baseUrl: 'https://openrouter.ai/api',
    authScheme: 'bearer',
    models: [
      model(
        '~anthropic/claude-sonnet-latest',
        'main',
        ['sonnet'],
        FAMILY,
        AUTO,
      ),
      model(
        '~anthropic/claude-opus-latest',
        'extra',
        ['opus', 'fable'],
        FAMILY,
        AUTO,
      ),
      model('~anthropic/claude-haiku-latest', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: get('/api/v1/key'), models: get('/api/v1/models') },
    keyHint: {
      prefixes: ['sk-or-v1-'],
      pattern: '^sk-or-v1-[0-9a-f]{64}$',
      display: 'sk-or-v1-',
    },
    terms: null,
    source: source(
      'https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration',
    ),
    notes: [
      'Anthropic 线只对 Claude 模型有保证',
      '/api/v1/models 不鉴权 · 不能用来验密钥',
    ],
  }),
  preset({
    id: 'xai',
    vendor: 'xAI',
    name: 'xAI Grok',
    group: 'intl',
    plan: 'paygo',
    lane: 'openai-responses',
    baseUrl: 'https://api.x.ai/v1',
    authScheme: 'bearer',
    models: [
      model('grok-4.7', 'main', MAIN_TIERS, OPENAI_LANE_BITS, NEVER, 500_000),
      model('grok-4.3', 'fast', FAST_TIERS, OPENAI_LANE_BITS, NEVER, 1_000_000),
    ],
    compat: {},
    probe: { auth: get('/v1/api-key'), models: get('/v1/models') },
    keyHint: { prefixes: ['xai-'], display: 'xai-' },
    terms: null,
    source: source(
      'https://docs.x.ai/developers/model-capabilities/text/reasoning',
    ),
    unverified: [
      THINKING_BITS_NOTE,
      'grok-4 系是否接受 reasoning effort 待真实端点核实（§5.10）· 核实前 never',
    ],
    notes: ['走 OpenAI 线的 Responses · 不走运行时的 Grok 线'],
  }),
]

// ---------------------------------------------------------------------------
// 套餐（§4.3）
// ---------------------------------------------------------------------------

const PLAN: readonly Preset[] = [
  preset({
    id: 'ark-coding',
    vendor: '火山方舟',
    name: '方舟 Coding Plan',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding',
    authScheme: 'bearer',
    models: [model('ark-code-latest', 'main', ALL_TIERS, FAMILY, AUTO)],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: null,
    terms: planTerms('https://www.volcengine.com/docs/82379/1928262'),
    source: source('https://www.volcengine.com/docs/82379/1928262'),
    unverified: [
      '套餐密钥前缀未核实（设计 §11 第 7 条）',
      'Coding Plan 是否用专属密钥 · 文档说法矛盾',
    ],
    notes: ['不要用 /api/v3 · 那个地址不消耗套餐额度'],
  }),
  preset({
    id: 'kimi-code',
    vendor: '月之暗面',
    name: 'Kimi Code',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://api.kimi.com/coding/',
    sites: [
      { id: 'cn', label: '国内', baseUrl: 'https://api.kimi.com/coding/' },
      { id: 'intl', label: '海外', baseUrl: 'https://api.kimi.ai/coding/' },
    ],
    authScheme: 'bearer',
    models: [
      model(
        'k3',
        'main',
        ALL_TIERS,
        ANTHROPIC_LANE_BITS,
        always(['low', 'high', 'max'], 'max'),
      ),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: { prefixes: ['sk-kimi-'], display: 'sk-kimi-' },
    terms: planTerms('https://www.kimi.com/code/docs/'),
    source: source('https://www.kimi.com/code/docs/'),
    unverified: [THINKING_BITS_NOTE],
    notes: [
      '与开放平台的密钥和地址都不通用',
      '带结尾斜杠 · 模型名不能带 [1m]（k3[1m] 会返回 401）',
    ],
  }),
  preset({
    id: 'mimo-token',
    vendor: '小米 MiMo',
    name: 'MiMo Token Plan',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
    sites: [
      {
        id: 'cn',
        label: '中国',
        baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic',
      },
      {
        id: 'sgp',
        label: '新加坡',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
      },
      {
        id: 'ams',
        label: '阿姆斯特丹',
        baseUrl: 'https://token-plan-ams.xiaomimimo.com/anthropic',
      },
    ],
    authScheme: 'bearer',
    models: [
      model('mimo-v2.6-pro', 'main', ALL_TIERS, ANTHROPIC_LANE_BITS, NEVER),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: {
      prefixes: ['tp-', 'ttp-'],
      display: 'tp-（个人）· ttp-（团队）',
    },
    terms: planTerms(
      'https://mimo.mi.com/static/docs/api/chat/anthropic-api.md',
    ),
    source: source('https://mimo.mi.com/static/docs/api/chat/anthropic-api.md'),
    unverified: [
      'Anthropic 路径未核实（设计 §11 第 7 条）· 厂商原文「以 Token Plan 页面显示为准」· 录入时核对',
      THINKING_BITS_NOTE,
    ],
    notes: ['个人版与团队版密钥互相独立'],
  }),
  preset({
    id: 'minimax-plan',
    vendor: 'MiniMax',
    name: 'MiniMax M Plan',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://api.minimax.cn/anthropic',
    sites: [
      {
        id: 'cn',
        label: '国内站',
        baseUrl: 'https://api.minimax.cn/anthropic',
      },
      {
        id: 'intl',
        label: '国际站',
        baseUrl: 'https://api.minimax.io/anthropic',
      },
    ],
    authScheme: 'bearer',
    models: [
      model('MiniMax-M3.1-Flash-Preview', 'main', ALL_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: get('/v1/models'), models: get('/v1/models') },
    keyHint: { prefixes: ['sk-cp-'], display: 'sk-cp-' },
    terms: planTerms(
      'https://platform.minimax.cn/docs/api-reference/text-anthropic-api',
    ),
    source: source(
      'https://platform.minimax.cn/docs/api-reference/text-anthropic-api',
    ),
    notes: ['与按量同址 · 靠密钥区分', '订阅密钥只能用 M Plan 额度'],
  }),
  preset({
    id: 'qianfan-token',
    vendor: '百度千帆',
    name: '千帆 Token Plan',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://qianfan.baidubce.com/anthropic/tokenplan/personal',
    sites: [
      {
        id: 'personal',
        label: '个人版',
        baseUrl: 'https://qianfan.baidubce.com/anthropic/tokenplan/personal',
      },
      {
        id: 'team',
        label: '企业版',
        baseUrl: 'https://qianfan.baidubce.com/anthropic/tokenplan/team',
      },
    ],
    authScheme: 'bearer',
    models: [model('deepseek-v4-pro', 'main', ALL_TIERS, FAMILY, AUTO)],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: null,
    terms: planTerms('https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6'),
    source: source('https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6'),
    unverified: ['套餐密钥前缀未核实（设计 §11 第 7 条）'],
    notes: ['Token Plan 路径下没有 /models', '千帆 Coding Plan 已停售 · 不收'],
  }),
  preset({
    id: 'qwen-coding',
    vendor: '阿里云百炼',
    name: '百炼 Coding Plan',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
    sites: [
      {
        id: 'cn',
        label: '国内',
        baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      },
      {
        id: 'intl',
        label: '国际',
        baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
      },
    ],
    authScheme: 'bearer',
    models: [model('qwen3.7-plus', 'main', ALL_TIERS, FAMILY, AUTO)],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: { prefixes: ['sk-sp-'], display: 'sk-sp-' },
    terms: planTerms('https://help.aliyun.com/zh/model-studio/coding-plan'),
    source: source('https://help.aliyun.com/zh/model-studio/coding-plan'),
    notes: ['/v1/models 不带密钥也返回列表 · 不能用来验密钥'],
  }),
  preset({
    id: 'qwen-token',
    vendor: '阿里云百炼',
    name: '百炼 Token Plan',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
    sites: [
      {
        id: 'cn',
        label: '国内',
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
      },
      {
        id: 'intl',
        label: '国际',
        baseUrl:
          'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic',
      },
    ],
    authScheme: 'bearer',
    models: [model('qwen3.8-max', 'main', ALL_TIERS, FAMILY, AUTO)],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: { prefixes: ['sk-sp-'], display: 'sk-sp-' },
    terms: planTerms(
      'https://help.aliyun.com/zh/model-studio/token-plan-quickstart',
    ),
    source: source(
      'https://help.aliyun.com/zh/model-studio/token-plan-quickstart',
    ),
    notes: ['官方示例的模型名是 auto · 本预设用 qwen3.8-max'],
  }),
  preset({
    id: 'stepfun-plan',
    vendor: '阶跃星辰',
    name: '阶跃 Step Plan',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://api.stepfun.com/step_plan',
    authScheme: 'bearer',
    models: [
      model(
        'step-5-preview',
        'main',
        ALL_TIERS,
        ANTHROPIC_LANE_BITS,
        always(['low', 'medium', 'high']),
        1_000_000,
      ),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: null,
    terms: planTerms(
      'https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create',
    ),
    source: source(
      'https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create',
    ),
    unverified: ['套餐密钥前缀未核实', THINKING_BITS_NOTE],
    notes: ['打按量地址不消耗 Step Plan 额度 · 填错不报错'],
  }),
  preset({
    id: 'tencent-plan',
    vendor: '腾讯',
    name: '腾讯 Token Plan / Coding Plan',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/anthropic',
    sites: [
      {
        id: 'token',
        label: 'Token Plan',
        baseUrl: 'https://api.lkeap.cloud.tencent.com/plan/anthropic',
      },
      {
        id: 'coding',
        label: 'Coding Plan',
        baseUrl: 'https://api.lkeap.cloud.tencent.com/coding/anthropic',
      },
    ],
    authScheme: 'bearer',
    models: [
      model('hy4-preview', 'main', MAIN_TIERS, FAMILY, AUTO),
      model('hy3', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: {
      prefixes: ['sk-tp-', 'sk-sp-'],
      display: 'sk-tp-（Token Plan）· sk-sp-（Coding Plan）',
    },
    terms: planTerms('https://cloud.tencent.com/document/product/1823/130060'),
    source: source('https://cloud.tencent.com/document/product/1823/130060'),
    unverified: ['lkeap 套餐路径的 /models 是否存在未核实'],
    notes: [
      'Coding Plan 只有 tc-code-latest 与 glm-5 · 选 Coding Plan 时要改模型',
      '套餐里的 glm-5 于 2026-10-09 下线',
    ],
  }),
  preset({
    id: 'zhipu-coding',
    vendor: '智谱',
    name: '智谱 GLM Coding Plan',
    group: 'plan',
    plan: 'plan',
    lane: 'anthropic',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    authScheme: 'bearer',
    models: [
      model('glm-5.3', 'main', MAIN_TIERS, FAMILY, AUTO, 1_000_000),
      model('glm-5.3-flash', 'fast', FAST_TIERS, FAMILY, AUTO),
    ],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: {
      prefixes: [],
      pattern: '^[^.\\s]+\\.[^.\\s]+$',
      display: '{id}.{secret}',
    },
    terms: planTerms('https://docs.bigmodel.cn/cn/coding-plan/quick-start'),
    source: source('https://docs.bigmodel.cn/cn/coding-plan/quick-start'),
    notes: ['与按量同址 · 靠密钥区分'],
  }),
]

// ---------------------------------------------------------------------------
// 本地与模板（§4.4）
// ---------------------------------------------------------------------------

const LOCAL: readonly Preset[] = [
  preset({
    id: 'lmstudio',
    vendor: 'LM Studio',
    name: 'LM Studio（本地）',
    group: 'local',
    plan: 'local',
    lane: 'anthropic',
    baseUrl: 'http://localhost:1234',
    authScheme: 'bearer',
    models: [],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: null, models: get('/v1/models') },
    keyHint: null,
    placeholderKey: 'lmstudio',
    terms: null,
    source: source('https://lmstudio.ai/docs/integrations/claude-code'),
    unverified: ['当前版本号与默认上下文未核实'],
    notes: [
      'LM Studio ≥ 0.4.1 才有 Anthropic 端点 · 旧版本选 openai-chat',
      '地址按节点解析 · localhost 指节点自己',
      '探测成功不代表模型已经加载',
    ],
  }),
  preset({
    id: 'ollama',
    vendor: 'Ollama',
    name: 'Ollama（本地）',
    group: 'local',
    plan: 'local',
    lane: 'anthropic',
    baseUrl: 'http://localhost:11434',
    authScheme: 'bearer',
    models: [],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: null, models: get('/v1/models') },
    keyHint: null,
    placeholderKey: 'ollama',
    terms: null,
    source: source('https://docs.ollama.com/integrations/claude-code'),
    notes: [
      'Ollama ≥ 0.14.0 才有 Anthropic 端点 · 旧版本选 openai-chat',
      '模型写 model:tag',
      '地址按节点解析 · localhost 指节点自己',
      '探测成功不代表模型已经加载',
    ],
  }),
  preset({
    id: 'vllm',
    vendor: 'vLLM',
    name: 'vLLM（本地）',
    group: 'local',
    plan: 'local',
    lane: 'anthropic',
    baseUrl: 'http://localhost:8000',
    authScheme: 'bearer',
    models: [],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: { auth: null, models: get('/v1/models') },
    keyHint: null,
    placeholderKey: 'dummy',
    terms: null,
    source: source(
      'https://docs.vllm.ai/en/latest/serving/integrations/claude_code/',
    ),
    notes: [
      'vLLM ≥ 0.11.1 才有 Anthropic 端点 · 旧版本选 openai-chat',
      '只认 Bearer · 模型名是 --served-model-name',
      '地址按节点解析 · localhost 指节点自己',
    ],
  }),
]

const CUSTOM: readonly Preset[] = [
  preset({
    id: 'custom-anthropic',
    vendor: '自定义',
    name: '自定义 Anthropic 兼容',
    group: 'custom',
    plan: 'custom',
    lane: 'anthropic',
    baseUrl: '',
    authScheme: 'bearer',
    models: [],
    compat: THIRD_PARTY_ANTHROPIC,
    probe: NO_PROBE,
    keyHint: null,
    terms: null,
    source: source('https://code.claude.com/docs/en/llm-gateway-connect'),
    notes: ['没有预设能力 · effort 默认 auto · 能力默认 family'],
  }),
  preset({
    id: 'custom-openai',
    vendor: '自定义',
    name: '自定义 OpenAI 兼容',
    group: 'custom',
    plan: 'custom',
    lane: 'openai-chat',
    baseUrl: '',
    authScheme: 'bearer',
    models: [],
    compat: {},
    probe: NO_PROBE,
    keyHint: null,
    terms: null,
    source: source(
      'https://developers.openai.com/api/reference/chat-completions/overview',
    ),
    notes: ['没有预设能力 · effort 默认 auto · 能力默认 family'],
  }),
]

/** Every preset, in display order: group order, then id order within a group. */
export const PRESETS: readonly Preset[] = [
  ...CN_PAYGO,
  ...INTL,
  ...PLAN,
  ...LOCAL,
  ...CUSTOM,
]

export function presetById(id: string): Preset | undefined {
  return PRESETS.find(entry => entry.id === id)
}

/** Presets shown in the grid (§6.3.2); unlisted ones stay reachable by id. */
export function listedPresets(): readonly Preset[] {
  return PRESETS.filter(entry => entry.listed)
}
