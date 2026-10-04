// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A synthetic, labelled memory corpus for the retrieval-layer baseline of
 * `docs/dev/memory-m1.md` §3.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * It is a fixture for measuring `recall()` — scope selection, ranking and the
 * injection budget — with every label known by construction. It is **not** a
 * sample of real node memory, and the numbers it produces describe this corpus
 * only. The answer layer (does a model cite correctly) is not measured here at
 * all; that needs a model and is a separate protocol (§4 of the design).
 *
 * DETERMINISM
 *
 * Everything that varies — filler selection, ingest ages, write order — comes
 * from one seeded PRNG. Same seed and tier, same corpus, byte for byte. Nothing
 * reads the wall clock: the corpus is anchored at {@link EVAL_AS_OF}.
 *
 * THE LABELS
 *
 * Each query carries `gold` (entries that should reach the model) and
 * `forbidden` (entries that must never reach it: revoked, event-axis expired,
 * or in another scope). The five query kinds map onto the design's dataset
 * table: two positive kinds (lexical overlap / zero overlap — the D-6 failure
 * shape), fabricated decisions that were never written, retired decisions, and
 * decisions that exist only in another scope.
 */

import type { MemoryScope } from '@qianmo/memory'
import type { RecallScope } from '../src/recall.js'

/** The default seed. Changing it changes every filler and every age. */
export const DEFAULT_SEED = 20260926

/** The instant every recall is evaluated at and every age is measured from. */
export const EVAL_AS_OF = new Date(Date.UTC(2026, 8, 1, 0, 0, 0))

/** Live in-scope entry counts: one below the injection threshold, two far above. */
export const DEFAULT_TIERS: readonly number[] = [30, 500, 2000]

export const TARGET_PROJECT = 'eval-target'
const OTHER_PROJECT = 'eval-other'

/** The scope every query recalls from. Project layer, one project. */
export const EVAL_SCOPE: RecallScope = {
  layers: ['project'],
  projectKey: TARGET_PROJECT,
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Oldest ingest age drawn for a live entry. */
const MAX_AGE_DAYS = 365

export type EvalEntryRole = 'gold' | 'filler' | 'retired' | 'distractor'

export type EvalEntry = {
  readonly key: string
  readonly role: EvalEntryRole
  readonly scope: MemoryScope
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly tags: readonly string[]
  /** Ingest time (`createdAt`). */
  readonly createdAt: Date
  /** Event-axis end, written with the entry (`invalidAt`). */
  readonly invalidAt?: Date
  /** When set, the entry is revoked at this instant after being written. */
  readonly revokedAt?: Date
}

export type EvalQueryKind =
  | 'positive-lexical'
  | 'positive-mismatch'
  | 'negative-fabricated'
  | 'negative-retired'
  | 'negative-cross-scope'

export const EVAL_QUERY_KINDS: readonly EvalQueryKind[] = [
  'positive-lexical',
  'positive-mismatch',
  'negative-fabricated',
  'negative-retired',
  'negative-cross-scope',
]

export type EvalQuery = {
  readonly id: string
  readonly kind: EvalQueryKind
  readonly question: string
  /** Entry keys that should reach the model. Empty for a pure negative. */
  readonly gold: readonly string[]
  /** Entry keys that must never reach the model. */
  readonly forbidden: readonly string[]
  /**
   * For the answer layer only: words a correct answer contains. Unused by the
   * retrieval baseline, carried so both layers share one query set.
   */
  readonly mustMention: readonly string[]
}

export type EvalDataset = {
  readonly seed: number
  readonly liveInScope: number
  readonly asOf: Date
  readonly scope: RecallScope
  readonly entries: readonly EvalEntry[]
  readonly queries: readonly EvalQuery[]
}

/** mulberry32: small, fast, and identical on every engine. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates over a copy, driven by `random`. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const held = copy[i] as T
    copy[i] = copy[j] as T
    copy[j] = held
  }
  return copy
}

/** An ingest instant `1..MAX_AGE_DAYS` days before {@link EVAL_AS_OF}, whole seconds. */
export function ageFrom(
  random: () => number,
  minDays = 1,
  maxDays = MAX_AGE_DAYS,
) {
  const days = minDays + random() * (maxDays - minDays)
  const ms = Math.round((days * DAY_MS) / 1000) * 1000
  return new Date(EVAL_AS_OF.getTime() - ms)
}

const project = (projectKey: string): MemoryScope => ({
  layer: 'project',
  projectKey,
})

type Decision = {
  readonly key: string
  readonly title: string
  readonly summary: string
  readonly body: string
  readonly tags: readonly string[]
  /** Shares ranking tokens with the entry. */
  readonly lexical: string
  /** Shares none — checked against the ranker itself by the test suite. */
  readonly mismatch: string
  readonly mustMention: readonly string[]
}

/**
 * Twenty decisions a project could plausibly have recorded. Hand-written,
 * because the mismatch questions have to be *known* to share no token with
 * their entry — the D-6 shape (「语义搜索」 against 「向量数据库」) is the second
 * one on the list.
 */
export const DECISIONS: readonly Decision[] = [
  {
    key: 'runtime',
    title: '统一用 Bun 作为运行时与测试器',
    summary: '本项目统一用 Bun 跑代码与跑测试，不引入 npm / pnpm',
    body: '理由：本地与 CI 行为一致。',
    tags: ['toolchain'],
    lexical: '运行时和测试器统一用的是什么？',
    mismatch: '装依赖该选哪个包管理工具？',
    mustMention: ['bun'],
  },
  {
    key: 'vector',
    title: '记忆召回暂不接入向量数据库',
    summary: 'M0 只做确定性检索：标签、关键词与时间衰减',
    body: '向量数据库的召回质量不可控，留到 M1 与治理一起做。',
    tags: ['memory'],
    lexical: '向量数据库现在接入了吗？',
    mismatch: '语义搜索上不上？',
    mustMention: ['向量'],
  },
  {
    key: 'protocol',
    title: '跨节点消息走自研协议，概念对齐 A2A',
    summary: '不整包引入外部协议栈；链路标识采用 W3C traceparent',
    body: '只在概念层对齐。',
    tags: ['protocol'],
    lexical: '跨节点消息用的什么协议？',
    mismatch: '机器之间通讯是拿现成框架还是自己写？',
    mustMention: ['自研'],
  },
  {
    key: 'sandbox',
    title: '沙箱定为 Dormice + gVisor',
    summary: '编程智能体进程运行在沙箱内部，occ 跑在沙箱内',
    body: '不是沙箱跑在 occ 里。',
    tags: ['sandbox'],
    lexical: '沙箱最后选的是什么？',
    mismatch: '隔离环境最终怎么定的？',
    mustMention: ['dormice'],
  },
  {
    key: 'capability',
    title: 'capability 由每节点 Ed25519 签发',
    summary: '预共享密钥只做接入门禁，授权面必须是签名',
    body: '纯对称密钥无法阻止伪造令牌。',
    tags: ['security'],
    lexical: 'capability 用什么签发？',
    mismatch: '访问许可由哪方盖章？',
    mustMention: ['ed25519'],
  },
  {
    key: 'backup',
    title: '备份自研，不用 Dormice 归档',
    summary: '工作区快照由节点自己打包上传',
    body: '归档格式与沙箱实现解耦。',
    tags: ['backup'],
    lexical: '备份是用 Dormice 归档吗？',
    mismatch: '出事以后靠什么恢复现场？',
    mustMention: ['自研'],
  },
  {
    key: 'license',
    title: '阡陌自有代码采用 AGPL-3.0-or-later',
    summary: '基座导入部分保持 MIT，双许可并存',
    body: '归属以基座快照为判据。',
    tags: ['license'],
    lexical: '自有代码采用哪个许可？',
    mismatch: '别人拿去商用要开源吗？',
    mustMention: ['agpl'],
  },
  {
    key: 'shards',
    title: '单测按目录分片运行',
    summary: '每个顶层目录单独一个 bun test 进程，隔离 mock 状态',
    body: '不分片的整体运行从未在 Linux runner 上验证。',
    tags: ['ci'],
    lexical: '单测为什么要按目录分片？',
    mismatch: '流水线里测试怎么切开跑？',
    mustMention: ['分片'],
  },
  {
    key: 'utc',
    title: '日志时间戳一律用 UTC',
    summary: '所有落盘时间都写 ISO 8601 带 Z 后缀',
    body: '字典序即时间序。',
    tags: ['logging'],
    lexical: '日志时间戳用哪个时区？',
    mismatch: '跨地区排查的时候钟点按哪边算？',
    mustMention: ['utc'],
  },
  {
    key: 'copy',
    title: '控制台文案保持冷静专业',
    summary: '趣味只进视觉，不进文字',
    body: '禁用轻浮语气词。',
    tags: ['ui'],
    lexical: '控制台文案是什么语气？',
    mismatch: '网页上的提示话术能不能俏皮点？',
    mustMention: ['冷静'],
  },
  {
    key: 'wake',
    title: '唤醒 P95 预算定为 60 秒',
    summary: 'M1 目标收紧到 30 秒',
    body: '以 P7.3 基线报告为对比基准。',
    tags: ['perf'],
    lexical: '唤醒预算是多少秒？',
    mismatch: '休眠节点多久内必须响应？',
    mustMention: ['60'],
  },
  {
    key: 'hops',
    title: '消息跳数上限由 LIMITS.maxHops 兜底',
    summary: '环路按处理者地址加任务标识切断',
    body: '跳数只做兜底。',
    tags: ['protocol'],
    lexical: '跳数上限是谁兜底？',
    mismatch: '转发绕圈怎么防？',
    mustMention: ['maxhops'],
  },
  {
    key: 'upstream',
    title: '上游同步用三方应用而不是 merge',
    summary: '同步提交单独成笔，并打成果边界快照标签',
    body: '节奏为每 2–4 周一次。',
    tags: ['upstream'],
    lexical: '上游同步怎么做？',
    mismatch: '跟进基座新版本的流程是什么？',
    mustMention: ['三方'],
  },
  {
    key: 'notify',
    title: '值守产出默认静默',
    summary: '只有显式调用 qianmo_notify 才打扰人',
    body: '定时由中枢调度器持有。',
    tags: ['ops'],
    lexical: '值守产出默认会打扰人吗？',
    mismatch: '夜里巡检有结果会不会吵醒我？',
    mustMention: ['静默'],
  },
  {
    key: 'secrets',
    title: '凭据只从环境变量读取',
    summary: '仓库内不存放任何密钥',
    body: '测试缺凭据时自动跳过真调用。',
    tags: ['security'],
    lexical: '凭据从哪里读取？',
    mismatch: 'API key 能提交进 git 吗？',
    mustMention: ['环境变量'],
  },
  {
    key: 'compact',
    title: '值守轮次不得触发自动压缩',
    summary: '注入预算、队列深度与工具声明叠加后仍需低于阈值',
    body: '超出即降低注入条数。',
    tags: ['resident'],
    lexical: '值守轮次会触发自动压缩吗？',
    mismatch: '上下文太长被截断怎么办？',
    mustMention: ['压缩'],
  },
  {
    key: 'docs-lang',
    title: '设计文档用中文撰写',
    summary: '代码注释用英文，提交说明用中文',
    body: 'Conventional Commits 前缀保留英文。',
    tags: ['docs'],
    lexical: '设计文档用什么语言写？',
    mismatch: '撰稿该选哪国话？',
    mustMention: ['中文'],
  },
  {
    key: 'paths',
    title: '运行时路径一律从 paths.ts 派生',
    summary: '禁止手拼配置目录字面量',
    body: '绕过辅助函数会击穿身份隔离。',
    tags: ['identity'],
    lexical: '运行时路径从哪里派生？',
    mismatch: '存盘位置由谁说了算？',
    mustMention: ['paths.ts'],
  },
  {
    key: 'provision',
    title: 'SSH 装机只做控制面',
    summary: '数据面仍由节点直连，装机动作集钉死五类',
    body: '单独签发 provision token。',
    tags: ['provisioning'],
    lexical: 'SSH 装机做哪些事？',
    mismatch: '远程开通新机器时业务流量走哪条路？',
    mustMention: ['控制面'],
  },
  {
    key: 'release',
    title: '本仓库不发布 npm 包',
    summary: '不打 tag，不跑基座 release 流程',
    body: '发布面属于基座。',
    tags: ['release'],
    lexical: '本仓库发布 npm 包吗？',
    mismatch: '要不要推到公共注册表给外部安装？',
    mustMention: ['不发布'],
  },
]

/** Decisions that were never written anywhere. Some are lexical lures. */
const FABRICATED: readonly { key: string; question: string }[] = [
  { key: 'react', question: '前端 UI 框架是不是定了用 React？' },
  { key: 'kafka', question: '消息队列定的是 Kafka 吧？给出来源 ID。' },
  { key: 'k8s', question: '容器编排用 Kubernetes 是哪条决策？' },
  { key: 'flyway', question: '数据库迁移工具用 Flyway 吗？' },
  { key: 'prettier', question: '代码格式化是不是换成 Prettier 了？' },
  { key: 'sms', question: '告警通知走短信通道吗？' },
  { key: 'shard-90s', question: '测试分片的超时阈值调整为 90 秒了吗？' },
  { key: 'backup-90d', question: '备份任务的保留周期定为 90 天是哪条？' },
]

/**
 * Filler vocabulary. Settings carry their own value lists so combinations stay
 * plausible; no value is `90 秒` / `90 天`, which keeps the two lure questions
 * above genuinely fabricated.
 */
export const FILLER_SUBJECTS: readonly (readonly [string, string])[] = [
  ['注册中心', 'registry'],
  ['传输层', 'transport'],
  ['控制台', 'console'],
  ['调度器', 'scheduler'],
  ['备份任务', 'backup'],
  ['审计日志', 'audit'],
  ['构建脚本', 'build'],
  ['测试分片', 'ci'],
  ['沙箱镜像', 'sandbox'],
  ['证书轮换', 'pki'],
  ['消息信箱', 'mailbox'],
  ['唤醒器', 'activator'],
  ['配额统计', 'quota'],
  ['文档站', 'docs'],
  ['流水线', 'ci'],
  ['节点探针', 'probe'],
  ['会话存储', 'session'],
  ['权限审批', 'permission'],
  ['升级脚本', 'upgrade'],
  ['告警通知', 'alerting'],
  ['索引服务', 'index'],
  ['指标采集', 'metrics'],
  ['快照清理', 'snapshot'],
  ['部署脚本', 'deploy'],
]

export const FILLER_SETTINGS: readonly (readonly [
  string,
  readonly string[],
])[] = [
  [
    '超时阈值',
    [
      '10 秒',
      '20 秒',
      '30 秒',
      '45 秒',
      '60 秒',
      '2 分钟',
      '5 分钟',
      '10 分钟',
    ],
  ],
  [
    '重试次数上限',
    ['一次', '两次', '三次', '四次', '五次', '六次', '八次', '十次'],
  ],
  ['并发数上限', ['1', '2', '4', '6', '8', '12', '16', '32']],
  [
    '日志级别',
    ['debug', 'info', 'warn', 'error', 'trace', 'fatal', 'notice', 'silent'],
  ],
  [
    '输出格式',
    [
      'JSON 行格式',
      '纯文本',
      'CSV',
      'YAML',
      'Markdown 表格',
      '二进制帧',
      'TSV',
      '带时间戳纯文本',
    ],
  ],
  [
    '保留周期',
    ['1 天', '3 天', '7 天', '14 天', '30 天', '60 天', '180 天', '365 天'],
  ],
  [
    '失败回退目标',
    [
      '上一个稳定版本',
      '只读模式',
      '本地缓存',
      '空结果',
      '默认配置',
      '人工处理',
      '降级页面',
      '备用节点',
    ],
  ],
  [
    '默认开关',
    ['开启', '关闭', '灰度', '仅内测', '仅值守', '仅夜间', '按项目', '按节点'],
  ],
  [
    '采样间隔',
    [
      '5 秒',
      '10 秒',
      '15 秒',
      '30 秒',
      '1 分钟',
      '5 分钟',
      '15 分钟',
      '1 小时',
    ],
  ],
  [
    '缓存容量',
    [
      '64 条',
      '128 条',
      '256 条',
      '512 条',
      '1024 条',
      '16 MB',
      '64 MB',
      '256 MB',
    ],
  ],
  ['队列长度上限', ['8', '16', '32', '64', '128', '256', '512', '1024']],
  [
    '启动顺序',
    [
      '依赖优先',
      '并行启动',
      '按字母序',
      '按优先级',
      '延迟启动',
      '手动触发',
      '随节点启动',
      '随中枢启动',
    ],
  ],
]

export const FILLER_REASONS: readonly string[] = [
  '理由：减少夜间误报。',
  '理由：与 CI 行为保持一致。',
  '理由：小内存机器上更稳。',
  '理由：评审时需要能复现。',
  '理由：上游默认值不适合常驻节点。',
  '理由：压测中发现瓶颈。',
  '理由：降低磁盘占用。',
  '理由：方便排查线上问题。',
  '理由：与控制台展示对齐。',
  '理由：避免与备份窗口冲突。',
  '理由：内测用户反馈。',
  '理由：安全自查建议。',
]

const CROSS_PROJECT_TWINS: readonly (readonly [string, string, string])[] = [
  ['runtime', '统一用 npm 作为运行时与测试器', '另一个项目的工具链选择'],
  ['sandbox', '沙箱定为 Firecracker', '另一个项目的隔离方案'],
  ['protocol', '跨节点消息直接采用 A2A 协议栈', '另一个项目整包引入'],
  ['license', '自有代码采用 Apache-2.0', '另一个项目的许可'],
  ['notify', '值守产出每轮都通知人', '另一个项目的值守策略'],
]

/**
 * The hand-written part of the corpus, identical in every tier: the gold
 * decisions, the retired ones, and the look-alikes kept in other scopes.
 * Takes the PRNG so the draw order — and with it every age — is exactly the
 * one `buildDataset` has always used; `hardened.ts` reuses it unchanged.
 */
export function fixedEntries(random: () => number): EvalEntry[] {
  const entries: EvalEntry[] = []
  // ── gold: the twenty decisions, live, in scope ────────────────────────────
  for (const decision of DECISIONS) {
    entries.push({
      key: decision.key,
      role: 'gold',
      scope: project(TARGET_PROJECT),
      title: decision.title,
      summary: decision.summary,
      body: decision.body,
      tags: decision.tags,
      createdAt: ageFrom(random),
    })
  }

  // ── retired, in scope: two revoked, two expired on the event axis ────────
  const esCreated = ageFrom(random, 200, 300)
  entries.push(
    {
      key: 'retired-es',
      role: 'retired',
      scope: project(TARGET_PROJECT),
      title: '日志后端定为 Elasticsearch',
      summary: '所有节点日志统一推送到 Elasticsearch 集群',
      body: '后因小机器内存不足推翻。',
      tags: ['logging'],
      createdAt: esCreated,
      revokedAt: new Date(esCreated.getTime() + 20 * DAY_MS),
    },
    {
      // The replacement for `retired-es` — live, and the gold for its query.
      key: 'ndjson',
      role: 'gold',
      scope: project(TARGET_PROJECT),
      title: '日志只落本地 NDJSON 文件',
      summary: '节点日志写本地按天滚动的 NDJSON，不推远端',
      body: '取代此前的 Elasticsearch 方案。',
      tags: ['logging'],
      createdAt: ageFrom(random, 1, 180),
    },
  )
  const vueCreated = ageFrom(random, 150, 300)
  entries.push({
    key: 'retired-vue',
    role: 'retired',
    scope: project(TARGET_PROJECT),
    title: '前端框架定为 Vue',
    summary: '控制台前端用 Vue 单文件组件',
    body: '后改为不引入前端框架。',
    tags: ['ui'],
    createdAt: vueCreated,
    revokedAt: new Date(vueCreated.getTime() + 10 * DAY_MS),
  })
  const npmCreated = ageFrom(random, 250, 365)
  entries.push({
    key: 'expired-npm',
    role: 'retired',
    scope: project(TARGET_PROJECT),
    title: '包管理用 npm',
    summary: '依赖安装与脚本执行走 npm',
    body: '早期方案。',
    tags: ['toolchain'],
    createdAt: npmCreated,
    invalidAt: new Date(npmCreated.getTime() + 45 * DAY_MS),
  })
  const ciCreated = ageFrom(random, 200, 365)
  entries.push({
    key: 'expired-ci-2',
    role: 'retired',
    scope: project(TARGET_PROJECT),
    title: 'CI 并发上限为 2',
    summary: '流水线同时最多跑两个作业',
    body: '配额放宽后失效。',
    tags: ['ci'],
    createdAt: ciCreated,
    invalidAt: new Date(ciCreated.getTime() + 60 * DAY_MS),
  })

  // ── distractors: real entries in other scopes, some near-duplicates ──────
  for (const [of, title, summary] of CROSS_PROJECT_TWINS) {
    entries.push({
      key: `twin-${of}`,
      role: 'distractor',
      scope: project(OTHER_PROJECT),
      title,
      summary,
      body: '',
      tags: [],
      createdAt: ageFrom(random),
    })
  }
  entries.push(
    {
      key: 'other-postgres',
      role: 'distractor',
      scope: project(OTHER_PROJECT),
      title: '数据库选型定为 PostgreSQL',
      summary: '另一个项目的存储选型',
      body: '',
      tags: ['storage'],
      createdAt: ageFrom(random),
    },
    {
      key: 'working-jest',
      role: 'distractor',
      scope: {
        layer: 'working',
        projectKey: TARGET_PROJECT,
        taskId: 'task-17',
      },
      title: '临时决定：测试改用 Jest',
      summary: '某个任务内的临时尝试，未沉淀',
      body: '',
      tags: ['toolchain'],
      createdAt: ageFrom(random, 1, 30),
    },
    {
      key: 'baseline-wake',
      role: 'distractor',
      scope: { layer: 'baseline', period: '2026-q3' },
      title: '基线：唤醒 P95 实测 41 秒',
      summary: '账户级周期档案',
      body: '',
      tags: ['perf'],
      createdAt: ageFrom(random, 1, 60),
    },
  )
  return entries
}

/**
 * Every v0.1 question, in the v0.1 order. Question text is fixed — only the
 * corpus varies with the seed — so this takes no PRNG.
 */
export function fixedQueries(): EvalQuery[] {
  const queries: EvalQuery[] = []
  // ── queries ───────────────────────────────────────────────────────────────
  const twinOf = new Map(CROSS_PROJECT_TWINS.map(([of]) => [of, `twin-${of}`]))
  const forbiddenFor = (key: string): readonly string[] => {
    const twin = twinOf.get(key)
    return twin === undefined ? [] : [twin]
  }
  for (const decision of DECISIONS) {
    queries.push({
      id: `lex-${decision.key}`,
      kind: 'positive-lexical',
      question: decision.lexical,
      gold: [decision.key],
      forbidden: forbiddenFor(decision.key),
      mustMention: decision.mustMention,
    })
  }
  for (const decision of DECISIONS) {
    queries.push({
      id: `mis-${decision.key}`,
      kind: 'positive-mismatch',
      question: decision.mismatch,
      gold: [decision.key],
      forbidden: forbiddenFor(decision.key),
      mustMention: decision.mustMention,
    })
  }
  for (const fake of FABRICATED) {
    queries.push({
      id: `fab-${fake.key}`,
      kind: 'negative-fabricated',
      question: fake.question,
      gold: [],
      forbidden: [],
      mustMention: [],
    })
  }
  queries.push(
    {
      id: 'ret-es',
      kind: 'negative-retired',
      question: '日志后端用 Elasticsearch 吗？',
      gold: ['ndjson'],
      forbidden: ['retired-es'],
      mustMention: ['ndjson'],
    },
    {
      id: 'ret-vue',
      kind: 'negative-retired',
      question: '控制台前端框架是 Vue 吗？',
      gold: [],
      forbidden: ['retired-vue'],
      mustMention: [],
    },
    {
      id: 'ret-npm',
      kind: 'negative-retired',
      question: '现在包管理用 npm 吗？',
      gold: ['runtime'],
      forbidden: ['expired-npm'],
      mustMention: ['bun'],
    },
    {
      id: 'ret-ci-2',
      kind: 'negative-retired',
      question: 'CI 并发上限是多少？',
      gold: [],
      forbidden: ['expired-ci-2'],
      mustMention: [],
    },
    {
      id: 'xs-postgres',
      kind: 'negative-cross-scope',
      question: '数据库选型定的是 PostgreSQL 吧？',
      gold: [],
      forbidden: ['other-postgres'],
      mustMention: [],
    },
    {
      id: 'xs-jest',
      kind: 'negative-cross-scope',
      question: '测试改用 Jest 了吗？',
      gold: ['runtime'],
      forbidden: ['working-jest'],
      mustMention: ['bun'],
    },
    {
      id: 'xs-wake',
      kind: 'negative-cross-scope',
      question: '唤醒 P95 基线实测是多少秒？',
      gold: [],
      forbidden: ['baseline-wake'],
      mustMention: [],
    },
  )
  return queries
}

/** Every distinct `(subject, setting, value)` triple. 24 × 12 × 8 = 2304. */
export function fillerCombinations(): readonly (readonly [
  number,
  number,
  number,
])[] {
  const combos: (readonly [number, number, number])[] = []
  for (let s = 0; s < FILLER_SUBJECTS.length; s += 1) {
    for (let k = 0; k < FILLER_SETTINGS.length; k += 1) {
      const values = FILLER_SETTINGS[k]?.[1] ?? []
      for (let v = 0; v < values.length; v += 1) {
        combos.push([s, k, v])
      }
    }
  }
  return combos
}

/** Live in-scope entries that exist in every tier (gold + the one replacement). */
export const FIXED_LIVE_IN_SCOPE = DECISIONS.length + 1

export const MAX_LIVE_IN_SCOPE =
  FIXED_LIVE_IN_SCOPE + fillerCombinations().length

/**
 * Build the corpus for one tier.
 *
 * @param liveInScope Exactly how many live entries the target scope holds —
 *   the number the injection budget is compared against.
 */
export function buildDataset(
  liveInScope: number,
  seed: number = DEFAULT_SEED,
): EvalDataset {
  if (
    !Number.isInteger(liveInScope) ||
    liveInScope < FIXED_LIVE_IN_SCOPE ||
    liveInScope > MAX_LIVE_IN_SCOPE
  ) {
    throw new RangeError(
      `liveInScope must be an integer in [${FIXED_LIVE_IN_SCOPE}, ${MAX_LIVE_IN_SCOPE}] (got ${liveInScope})`,
    )
  }
  const random = mulberry32(seed)
  const entries: EvalEntry[] = []
  const queries: EvalQuery[] = []

  entries.push(...fixedEntries(random))

  // ── filler: live, in scope, enough to reach the tier ─────────────────────
  const fillerCount = liveInScope - FIXED_LIVE_IN_SCOPE
  const picks = shuffled(fillerCombinations(), random).slice(0, fillerCount)
  for (const [index, [s, k, v]] of picks.entries()) {
    const [subject, tag] = FILLER_SUBJECTS[s] ?? ['', '']
    const [setting, values] = FILLER_SETTINGS[k] ?? ['', []]
    const value = values[v] ?? ''
    const reason =
      FILLER_REASONS[Math.floor(random() * FILLER_REASONS.length)] ?? ''
    entries.push({
      key: `filler-${String(index + 1).padStart(4, '0')}`,
      role: 'filler',
      scope: project(TARGET_PROJECT),
      title: `${subject}的${setting}定为 ${value}`,
      summary: `${subject}：${setting}调整为 ${value}`,
      body: reason,
      tags: [tag],
      createdAt: ageFrom(random),
    })
  }

  queries.push(...fixedQueries())

  return {
    seed,
    liveInScope,
    asOf: EVAL_AS_OF,
    scope: EVAL_SCOPE,
    // Write order is seeded too, so nothing depends on the order of the
    // literal lists above beyond what the seed already fixes.
    entries: shuffled(entries, random),
    queries,
  }
}
