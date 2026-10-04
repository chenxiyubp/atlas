<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @qianmo/recall —— 记忆检索唤醒与强制引用

在 `@qianmo/memory` 之上做**确定性检索 + 小规模全量注入 + 工具层强制引用**：候选集只按 scope 取，排序不进模型，模型给出的每个引用 ID 都要回存储里解析一次，解析不到就不能被引用。

| 项 | 指针 |
| --- | --- |
| 任务包 | roadmap **P3.3 记忆检索唤醒 v0**（交付物 / DoD 三条真机判据 / 完成记录都在那里） |
| 章程条目 | charter §3.2 **R-2 分层记忆**的「检索唤醒」半边 + §4 **AC-4**；N-8：M0 不做向量检索，M1 的语义层只按「叠加，不替换」进入（`docs/dev/memory-m1.md` §5） |
| 关键决策 | D-6（小规模全量注入 + 工具层强制引用，取代供应商原生引用块）——出处 `docs/dev/selection-m0.md` |
| 协议级数值 | 本包的 `INJECTION_BUDGET` / `RANKING` 是**召回层策略，不跨节点边界**，故不属 `@qianmo/protocol` 的 `LIMITS`；协议级上限一律见 `LIMITS` |

---

## 1. 模块架构图

```mermaid
flowchart TB
  store[("@qianmo/memory<br/>FileMemoryStore")]

  subgraph pkg["@qianmo/recall"]
    index["index.ts"]

    recallmod["recall.ts<br/>recall() · injectedIds()<br/>captureEvents()"]
    tokenizemod["tokenize.ts<br/>tokenize()<br/>CJK 二元组 / Latin 整词"]
    rankmod["rank.ts<br/>scoreEntry / rankEntries<br/>recencyFactor / compareRanked<br/>RANKING"]
    injectmod["inject.ts<br/>selectForInjection<br/>renderEntry / renderInjection<br/>citationInstructions<br/>buildRecallSystemPrompt<br/>INJECTION_BUDGET"]
    toolmod["tool.ts<br/>MEMORY_ANSWER_TOOL<br/>parseMemoryAnswerArgs"]
    citationmod["citation.ts<br/>verifyCitations · checkOne<br/>normaliseCitationId<br/>handleMemoryAnswer<br/>renderCitedAnswer"]
  end

  model(["模型（任一供应商）<br/>经基座适配链"])
  caller(["调用方 / 演示链路"])

  index --> recallmod
  index --> citationmod

  caller -->|"question + scope"| recallmod
  recallmod -->|"query（只传 scope + asOf，<br/>不传 text / tags）"| store
  store -->|"live 条目 + events 环形缓冲"| recallmod
  recallmod -->|"tokensOf(question)"| tokenizemod
  recallmod -->|"打分排序（无模型）"| rankmod
  recallmod -->|"套预算"| injectmod
  recallmod -->|"RecallResult<br/>（含 events / degraded / tokens）"| caller

  injectmod -->|"&lt;qianmo-memory&gt; 块 + 引用规则"| model
  toolmod -->|"纯 JSON Schema 工具声明"| model
  model -->|"tool_use args:<br/>answer + citations 列表"| citationmod

  citationmod -->|"parseMemoryAnswerArgs 校形状"| toolmod
  citationmod -->|"injectedIds(result) 作白名单"| recallmod
  citationmod -->|"getEntry(id) 逐个解析<br/>（不解析就不能引用）"| store
  citationmod -->|"MemoryAnswer{ok, answer, report, rejection}"| caller
```

**关键顺序**：`scope 取候选` →`排序（只决定次序，从不过滤）` → `套预算` → `注入` → `模型经工具回答` → `逐 ID 回查存储` → 通过才渲染来源行。来源行由存储自己的 `formatCitation` 生成，**不取模型文本**，所以模型写错写入时间也进不了用户面前。

---

## 2. 对外 API 面（`src/index.ts`）

| 导出 | 一句话 |
| --- | --- |
| `recall(store, request)` | 一次完整检索：按 scope 取 live 候选 → 排序 → 套预算，返回 `RecallResult` |
| `RecallRequest` / `RecallScope` | 入参：`question`（只用于排序）、`tags`（奖励项）、`scope`（层/项目/任务/周期）、`asOf`、`halfLifeMs`、`budget` |
| `RecallResult` | 结果：`entries` / `mode`（`full` \| `ranked`）/ `candidateCount` / `omittedCount` / `tokens` / `events` / `degraded` / `asOf` |
| `injectedIds(result)` | 模型实际看到的 ID 集合——引用核验的白名单 |
| `rankEntries` / `scoreEntry` / `compareRanked` / `recencyFactor` / `tokensOf` / `RankedEntry` / `RankingInput` | 确定性排序：标签命中 ×4、题面词 ×2、正文词 ×1，再乘以 30 天半衰期的衰减因子；全序（分数 → 写入时间 → id） |
| `RANKING` | 上述权重与 `decimals: 6` 的舍入位（浮点尾数不得决定顺序） |
| `tokenize(text)` | 确定性分词：Latin/数字整词（≥2 字符、去极小停用词表），CJK 按**字符二元组**；固定 Unicode 区间而非 `\p{Script=Han}` |
| `selectForInjection` / `Selection` / `InjectionBudget` / `INJECTION_BUDGET` | 预算裁剪（50 条 / 20 000 字符），按排序次序走，第一条超限即停 |
| `renderEntry` / `renderInjection` / `InjectionView` / `InjectionMode` | 渲染 `<qianmo-memory>` 块；块头写明 `mode` 与 `omitted`，降级时额外打一条 WARNING |
| `citationInstructions` / `buildRecallSystemPrompt` | 提示词的**协作半边**（规则在前、记忆在后）；强制半边在 `verifyCitations` |
| `MEMORY_ANSWER_TOOL` / `MEMORY_ANSWER_TOOL_NAME` / `RecallToolDefinition` / `ToolInputSchema` | 供应商中立的工具声明（`qianmo_memory_answer`，`answer` + `citations` 双必填、`additionalProperties: false`） |
| `parseMemoryAnswerArgs` / `MemoryAnswerArgs` / `RecallToolError` | 只校**形状**（缺 `citations` 是违约不是空列表），不判内容真假 |
| `verifyCitations` / `CitationReport` / `CitationCheck` / `CitationStatus` | 六种判定：`ok` / `unknown` / `malformed` / `retired` / `not-injected` / `unreadable`，互不合并 |
| `normaliseCitationId` | 从模型给的整行引用里抠出裸 ID——对格式宽容，对实质不让步 |
| `handleMemoryAnswer` / `MemoryAnswer` / `MemoryAnswerOptions` | 强制点：核验 → 通过就附来源行，不通过给出可喂回模型的 `rejection` 文本 |
| `renderCitedAnswer` | 把 `accepted` 条目按引用顺序渲染成「来源 / sources」列表 |
| `recallHybrid` / `HybridRecallResult` / `SemanticRecall` / `RetrievalEvent` | M1 语义叠加（`docs/dev/memory-m1.md` §5，P16.6）：异步；full 模式不启用、不调 embedding；ranked 模式先保留确定性注入集的前 ⌈\|I_det\|·floorRatio⌉ 条，其余名额按 RRF 融合确定性名次与语义名次填充；任何语义侧故障退回与 `recall()` 相同的结果，标 `hybrid-degraded` 并带事件 |
| `HYBRID_DEFAULTS` / `resolveHybridConfig` / `HybridConfig` | 融合参数：保底比例 0.5、RRF k = 60、每次补算 32 条、覆盖率闸 0.95、超时 300 ms、输入截断 8 000 字、同源占比 0.5。**全部是提议值，未测量** |
| `RETRIEVAL_MODES` / `RetrievalMode` | `deterministic` / `hybrid` / `hybrid-degraded`；块头只在 `hybrid` 时多一个 `retrieval="hybrid"`，语义填充进来的条目前加一行 `via: semantic` |
| `EmbeddingProvider` / `EmbeddingBatch` | 模型中立的 embedding 接口（`id` / `model` / `dimensions` / `embed(texts, { signal })`），不含供应商名；真实适配是 P16.7 |
| `VectorIndex` / `VectorKey` / `InMemoryVectorIndex` | 向量索引只是排序缓存，键为 `(entryId, contentHash, providerId, model, dimensions)`，只按本轮候选查询；持久化是 P16.8 |
| `EmbeddingUsageMeter` / `FileEmbeddingUsageMeter` / `defaultEmbeddingUsagePath` | 成本上限：按 token、按节点、按 UTC 自然日，计数器持久化在 `occConfigPath('qianmo', 'embedding', 'usage.json')`；调用前预留、调用后按供应商 usage 对账；文件坏了按「已用尽」处理，不清零 |

---

## 3. 最容易被改坏的七条不变式

| # | 不变式 | 改坏会怎样 | 哪个测试钉住 |
| --- | --- | --- | --- |
| 1 | **候选集只按 scope 取，绝不按词过滤**——`recall()` 调 `store.query` 时不传 `text` / `tags`；分词与标签只进 `rank.ts` 作打分信号 | 加一条词过滤就复现 D-6 实测的 0 结果失败面：问「语义搜索」而条目写「向量数据库」，返回空集，答案里一条记忆都没有 | `test/recall.test.ts`：`a question that shares no wording still gets every entry` / `scope is a partition, not a guess: another project is not a candidate` |
| 2 | **引用解析不到即无法被引用**，且六种判定互不合并——尤其 `unreadable`（真条目坏了）不得并进 `unknown`（伪造） | 合并两者会把一条**真记忆报成幻觉**，这是本链路最坏的错误；放宽解析则 AC-4 的负向判据从「查表」退回「祈祷模型别编」 | `test/citation.test.ts`：`a fabricated id resolves to nothing and is rejected` / `a damaged genuine entry is reported as unreadable, never as fabricated` / `a real entry that was never shown is not a grounded citation` |
| 3 | **只投 live 条目，每次从盘上重建，不缓存**——废止后下一次召回即消失，且已废止条目不可被引用 | 加缓存或放开 `includeRetired`，「废止后必须重投」从自动性质退回成一条要人记得执行的流程 | `test/recall.test.ts`：`a revoked entry is gone from the very next recall` / `an invalidated fact leaves the present but keeps answering the past`；`test/citation.test.ts`：`a revoked entry may not be cited` |
| 4 | **工具声明是纯数据：无 SDK、无供应商名、不使用任何原生引用块** | 改回原生 `search_result` 引用块，AC-4 与 AC-5 从此永久打架——该路径与结构化输出互斥、且只在一家的线上存在 | `test/tool.test.ts`：`is plain data: no vendor, no SDK, no native citation feature` / `declares both fields as required` |
| 5 | **存储的降级事件必须抬到结果上**（`RecallResult.events` + `degraded`），上层不得重新盖回静默；排序里衰减是**乘子不是加项** | 前者一盖回，`@qianmo/memory` 为「一个坏文件不拖垮召回」所做的修复就白做了——节点醒来记忆变少而无人知晓；后者一改成加项，常驻节点每隔数周醒来一次，榜首会随墙钟静默漂移 | `test/recall.test.ts`：`recall returns the healthy entries and carries the failure out` / `only the events of this recall are reported`；`test/rank.test.ts`：`relevance dominates recency: a stale hit outranks a fresh miss` |
| 6 | **条目内容只是数据，不能成为块的框架**——`renderEntry` 对所有字段转义 `<` `>`，单行字段折掉一切换行，正文里读起来像分隔行、`entry_id:` / `citation:` 行或 fence 的行首字符实体化；不含这些片段的条目逐字节不变 | 正文一句 `</qianmo-memory>` 就让常驻组装扫描失败、整轮远端文本被扣，full 模式下每轮都扣；正文还能伪造一条带他处真 id 的条目 | `test/inject.test.ts`（全部用例）；`packages/resident/test/memory-sidecar.test.ts`：`the assembled-prompt scan stays clean`；`src/services/qianmo/__tests__/residentPrompt.test.ts`：`the turn keeps its remote text` |
| 7 | **语义层只叠加、不替换**——候选集仍只按 scope 取，索引只按候选查询；ranked 模式保底部分 ⊆ 注入集（每次结果都校验，违反即退化）；full 模式与语义层故障时结果与 `recall()` 逐字节相同 | 语义层一旦能过滤或替换候选，D-6 的「0 结果」失败面与 I-1 一起回来；保底一失守，被改写的索引就能把确定性前列挤出块 | `test/hybrid.test.ts`（全部用例）；`packages/resident/test/memory-sidecar.test.ts`：`the semantic overlay (P16.6)` |

---

## 4. 与基座的关系

- **定性**：本包**不改基座核心**，只消费基座的两样东西——① 模型适配链（`anthropicToolsToOpenAI` 等）把中立工具声明转成各家格式，这正是 AC-5「切换供应商不改代码」成立的地方；② 全量注入这一形态本身照搬基座 `MEMORY.md` 每轮整体载入的做法，只是叠加了条目级 ID 与写入时间。
- **不采用基座的召回路径**：基座 `findRelevantMemories()` 是一次 Sonnet 调用，与章程 N-8 冲突；本包检索路径零模型。判定依据见 `docs/dev/base-adoption.md` §3.1「分层记忆」行。
- 基座改造点全量清单见 `docs/dev/base-modifications.md`。

---

## 5. 边界与已知未做

| 事项 | 一行摘要 | 指针 |
| --- | --- | --- |
| 语义检索只做叠加 | M0 用可解释性换召回率；M1 的语义层（`hybrid.ts`）只在 ranked 模式重排填充名额，不过滤、不替换确定性检索；真实 embedding 适配（P16.7）与索引持久化（P16.8）不在本包现有代码里 | 章程 N-8；`docs/dev/memory-m1.md` §5 |
| 二元组会过匹配 | CJK 二元组会跨词边界命中，是刻意的取舍——过匹配只损失排序精度，欠匹配会丢条目 | `src/tokenize.ts` 顶部注释 |
| 提示词只是协作半边 | 引用规则本身不被信任，唯一强制点是 `verifyCitations`；章程 §6.1 T-7「不以模型是否被说服验收」 | `src/inject.ts` `citationInstructions` 注释 |
| 单条超预算的条目仍会被注入 | 字符预算不得把块压成空——从模型内部看，空块与「没有记忆」无法区分 | `src/inject.ts` `selectForInjection` 注释 |
| `requireCitation` 默认关 | 「记忆里没有记录这件事」是正确答案，AC-4 的负向判据依赖模型能这么答 | `src/citation.ts` `MemoryAnswerOptions` 注释 |

---

## 6. 怎么跑测试

```bash
bun test packages/recall/test                              # 包内：51 用例 / 5 文件（实跑 2026-08-15）
bun test tests/integration/qianmo-memory-recall.test.ts    # AC-4 集成腿：23 用例
```

- 包内逐文件：`citation` 15 / `recall` 11 / `rank` 9 / `tokenize` 8 / `tool` 8 = **51 pass / 0 fail / 132 expect**，零 mock。
- 集成腿共 **23 个用例**；无 `OPENAI_API_KEY` + `OPENAI_BASE_URL` 时真调用整组自动 skip（实跑 **3 pass / 20 skip**），留下不需要凭据的确定性检查。凭据只从环境变量读，仓库内不存密钥。

### 评测（`eval/`，`docs/dev/memory-m1.md` §2–§4）

| 做什么 | 命令 | 说明 |
| --- | --- | --- |
| M0 检索基线（v0.1 语料） | `bun run qianmo:recall-baseline` | 输出逐字节等于 §3 公布的 SHA-256，不要改它 |
| M0 检索基线（M1 语料） | `bun run qianmo:recall-baseline --corpus synthetic-v1`（或 `docs-dev-v1`；`--digest` 只出语料哈希） | 加固合成语料与 `docs/dev` 第二语料，种子与档位按预注册，不接受 `--seed` / `--tiers` |
| 重生成第二语料 | `bun run scripts/qianmo-recall-docs-corpus.ts [--check]` | 只读钉住提交上的文件；人名、账号只以哈希入库 |
| 回答层 token 预估 | `bun run scripts/qianmo-recall-answer-eval.ts --dry-run` | 离线；默认给出 P16.4 试跑（`prereg.toml` `[trial]`）与 P16.12 对比（`[plan]`）两份。M1 臂的注入块由 `recallHybrid` 在替身向量（非语义）上选出，另报 embedding token 预估 |
| 回答层回放 / 真调用 | 同一脚本 `--replay <fixture>` / `--live`（`--live` 必须带 `--cap-input` / `--cap-output`） | 缺凭据自动跳过；token 账本在 `occConfigPath('qianmo','recall-eval')` 下，持久化、重启不清零。M1 臂回放时读 fixture 里落档的向量（`embeddings`），缺向量或退化即中止；P16.7 之前 `--live` 拒绝 M1 臂 |
| 留出集零词面校验 | `bun run scripts/qianmo-recall-heldout-check.ts <file>` | 用语料自己的分词逐题核对与 gold 条目零重叠，末行给出 `heldout_ids_sha256`；0 干净 / 1 有问题 / 2 文件或用法错 |
| 冻结预注册值 | `bun run scripts/qianmo-recall-freeze.ts [--check]` | 重算语料哈希、M0 基线哈希与留出集哈希，只填空着的键；已有值只核不改，不一致退出 1 |

预注册值只从 `eval/prereg.toml` 读，命令行没有覆盖开关；键缺省即「未生成」，用到它的判据拒判。对比只接受 `[plan]` 这一份计划，`--corpus` / `--tiers` / `--reps` / `--arms` 只能收窄试跑。R2–R4 只在留出集（`eval/heldout/synthetic-v1.heldout.toml`，由独立代理交付）上判定，交付并冻结哈希之前拒判。

---

## 7. P9.3 双人签字栏

> roadmap v2.3 起 owner 栏语义为「方向辅助人」，主开发统一为喻永昌；**P9.3 双人签字属明确写「双人」的流程要件，不受该条影响**，仍按本任务包 owner / backup 执行（roadmap v2.3 例外条款）。

| 角色 | 姓名（按 roadmap P3.3 owner 栏） | 签名 | 日期 |
| --- | --- | --- | --- |
| owner | 董宗岳 | | |
| backup | 李怡康 | | |

**owner 出给 backup 的三道题**：

1. 为什么 `recall()` 调 `store.query` 时**不传** `text` 和 `tags`，而分词器和标签权重明明就在同一个包里？如果给候选集加一条词过滤，会在哪个具体场景下把答案变成空？（说出 D-6 实测到的那个例子）
2. 模型回了一个 `citations: ["qm-mem-xxxx"]`，请把 `handleMemoryAnswer` 走一遍：这个 ID 可能落进哪六种判定？其中哪两种绝对不能合并、为什么合并了会产生「本链路最坏的错误」？（提示：`@qianmo/memory` 的 `getEntry` 为此专门选择抛错而不是返回 `null`）
3. 为什么工具声明里一个供应商名字都不能出现？如果改用某家的原生引用块，AC-4 和 AC-5 会在什么时候、以什么形式打架？另外：`INJECTION_BUDGET` 和 `RANKING` 为什么不放进 `@qianmo/protocol` 的 `LIMITS`？
