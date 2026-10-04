<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 与 A2A 的对齐评估

| 项 | 内容 |
|---|---|
| 文档版本 | **v0.1**（草案原文即终稿；负责人决议 2026-08-17 评审通过，roadmap v2.41①） |
| 撰写日期 | 2026-08-15 |
| 覆盖阶段 | M0 · S6 任务包 P6.4 |
| 撰写 | （待署名） |
| 依据 | 范围与非目标见 [`charter.md`](./charter.md) N-4、§3.3 C-1；任务包与 DoD 见 [`roadmap.md`](./roadmap.md) P6.4；我方协议见 [`protocol.md`](./protocol.md)；选型决议 D-9 与「A2A 线上细节未取证」的记录见 [`selection-m0.md`](./selection-m0.md) §4、§6 |
| 性质 | 见下方「本文性质」五条 |

**变更记录**

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1 草案 | 2026-08-15 | 初稿。落实 P6.4 三项交付物：字段映射表（15 个概念面）、差距清单（27 条，逐条三选一）、M1 收敛建议。同时关闭 `protocol.md` §12.3 第 8 条与 `selection-m0.md` §6 记录的「A2A 线上细节未取证」 |
| v0.1（评审通过） | 2026-09-26 | 只回写状态：负责人 2026-08-17 决议评审通过（roadmap v2.41①：三个判断点与 G-18 按草案建议定案）。文首版本行与「本文性质」第 1 条随之改写，正文零改动；原草案状态见 git 历史 |

**本文性质**

1. **本文已评审通过，P6.4 已完成**（负责人决议 2026-08-17，roadmap v2.41①；非全员逐条评审）。§6 的三个判断点与 G-18 按本文建议定案；§5 的收敛点按第 2 条读。本条于 2026-09-26 回写；原草案状态（「该评审尚未进行，结论不构成决定」）见 git 历史。
2. **只评估不实现**（章程 N-4）。本文不产生任何代码改动，也不为 M0 内的任何实现背书。凡写「收敛点在 X 包」者，指的是**若 M1 决定做**，改动落在哪里，而不是「该做」。
3. **我方字段一律取自代码，不取自文档印象。**每一格都能回到 `packages/` 下的一个类型定义，出处清单见 §8。凡代码与 `protocol.md` 表述有出入者，以代码为准并就地标注。**本文一律只写字段名、不写数值**——协议级数值的唯一出处是 `packages/protocol/src/limits.ts` 的 `LIMITS`（`protocol.md` §11 现值速查表是唯一被允许复制的地方），本文不做第二份。
4. **A2A 侧一律取自规范原文**，版本与取证方式见 §0。凡本文写「无对应」，都是在 §0 所列的两份文件里逐词检索后的结论，不是印象。
5. 本文引用 A2A 规范是**公开标准的正常引用**，不构成与 Linux Foundation 或 A2A 项目的任何关联性主张（章程 §5.8）。

---

## 0. 依据的 A2A 规范版本、取证时间与取证方式

| 项 | 内容 |
|---|---|
| 项目 | Agent2Agent (A2A) Protocol，Linux Foundation 托管（2025-06 由 Google 捐赠） |
| **最新发布版本** | **v1.0.1**，发布于 2026-05-28（GitHub release tag） |
| **线上协议版本号** | **`1.0`**。A2A §3.6 规定协议版本只用 `Major.Minor`，patch 号不参与协商、不得出现在请求 / 响应 / Agent Card 中 |
| 取证日期 | **2026-08-15** |
| 取证对象 | `github.com/a2aproject/A2A`，仓库 SHA **`134a382ed38a0c527902e21b5b61c1666a60402e`** |
| 文件 1 | `specification/a2a.proto`（blob `2814f0f9a8a3db0fa1976dd4aece8ce38700a0bf`）——**数据模型的真源**。规范 §4 明写「defines a canonical data model using Protocol Buffers」，所有绑定 MUST 提供功能等价表示 |
| 文件 2 | `docs/specification.md`（blob `6d38bbfb03a036371cf03cca1331a510f603c1e9`）——规范正文 |

**取证对象是 `main` 而不是 `v1.0.1` 标签，这一点要交代清楚。**`specification/a2a.proto` 自 v1.0.1 发布（2026-05-28）以来只有**一次**提交：`cfc9d34`（2026-07-21，PR #1997），内容是把 `AgentInterface.url` 注释里的 gRPC 示例从 `https://grpc.example.com/a2a` 改成 `grpc.example.com:443`，**纯注释，零字段变化**。因此本文所依据的数据模型与 v1.0.1 在字段层面完全一致。

**一处必须点名的纠错。**a2a-protocol.org 的规范页摘要、以及大量二手资料，至今仍在讲 AgentCard 的 `preferredTransport` / `additionalInterfaces` / `protocolVersion` 三个字段——**那是 v0.3 的形态，v1.0 里不存在**。v1.0 的 AgentCard 用的是 `supported_interfaces`（JSON: `supportedInterfaces`）一个有序列表，首项即首选；协议版本号下沉到每个 `AgentInterface.protocol_version`。本文全部以 proto 为准。这也正是 `selection-m0.md` §6 记录的「A2A JSON-RPC 线上方法名三处口径冲突，未取证，勿写进代码」那条警告的现实依据——**二手口径确实是错的**。

**JSON 编码约定**（A2A §5.5，映射表读法所需）：proto 的 snake_case 字段在所有 JSON 绑定里 MUST 写成 camelCase（`context_id` → `contextId`）；枚举按 ProtoJSON 序列化为**原样的 SCREAMING_SNAKE_CASE 字符串**（`TASK_STATE_INPUT_REQUIRED` → `"TASK_STATE_INPUT_REQUIRED"`）。本文表格里 A2A 侧一律写 proto 名，需要 JSON 名时自行按此规则转换。

**方法名（关闭 `selection-m0.md` §6 的悬案）**，A2A §5.3 的规范映射表，三种绑定共 11 个操作：

| 功能 | JSON-RPC 方法 | gRPC 方法 | REST 端点 |
|---|---|---|---|
| 发消息 | `SendMessage` | `SendMessage` | `POST /message:send` |
| 流式发消息 | `SendStreamingMessage` | `SendStreamingMessage` | `POST /message:stream` |
| 查任务 | `GetTask` | `GetTask` | `GET /tasks/{id}` |
| 列任务 | `ListTasks` | `ListTasks` | `GET /tasks` |
| 取消任务 | `CancelTask` | `CancelTask` | `POST /tasks/{id}:cancel` |
| 订阅任务 | `SubscribeToTask` | `SubscribeToTask` | `POST /tasks/{id}:subscribe` |
| 推送配置（增/查/列/删） | `CreateTaskPushNotificationConfig` 等 4 个 | 同名 | `/tasks/{id}/pushNotificationConfigs[/{configId}]` |
| 取扩展卡 | `GetExtendedAgentCard` | `GetExtendedAgentCard` | `GET /extendedAgentCard` |

**本节的连带效果**：`protocol.md` §12.3 第 8 条「A2A 的线上细节一律未取证」与 `selection-m0.md` §6 的同款记录，**至此关闭**。D-9「协议自研 + 概念对齐 A2A、不采用 A2A 子集」的三处免费对齐（任务状态机名、`taskId` / `contextId` 分离、Agent Card 形状）经本次逐字段核对**全部成立**，见 §3.4、§3.1、§3.3。

---

## 1. 一句话结论

> **A2A 与阡陌协议不在同一层。**A2A 是「一个客户端调用一个不透明智能体服务」的**应用层 API**——三种传输绑定、请求/响应加流、任务是服务端侧可查询的资源、身份在传输层。阡陌协议是「一个节点把一个信封投递到另一个节点」的**网络层**——寻址、跳数、两条时限、判环、两级去重、审计哈希链。

这个判断决定了怎么读 §3 的映射表：**表里大部分「无对应」不是缺口，是层次差**。A2A 不会长出 `hops`，正如 IP 不会长出 HTTP 的 `Content-Type`。

真正的差距集中在三处，且都不在层次差上：

1. **我方没有能力描述面。**`AgentRecord.capabilities` 是一串裸字符串；A2A 的 `AgentCard` 是结构化的技能 + 协议能力 + 安全方案 + 接口清单。任何 A2A 客户端连**发现**我方智能体都做不到。
2. **我方的「任务」是一条消息的终态，A2A 的任务是一个可查询的资源。**我方发出 `task.result` 之后除审计日志外无处可查；A2A 有 `GetTask` / `ListTasks` / `SubscribeToTask` 与九个状态。落差最大的三项是取消、多轮追问、进度。
3. **两套授权模型方向相反。**我方把凭据放在信封 `cap` 上、绑 `taskId` 与 `aud`、每节点 Ed25519 自签；A2A §7 首段明写身份「handled at the protocol layer, not within A2A semantics」，凭据在传输层，方案是 OAuth2 / OIDC / mTLS / APIKey / HTTP Auth。**这一处是有意为之的分歧，不是我方欠账**——理由见 G-16。

---

## 2. 层次对照（读映射表前必须先看这张）

| 阡陌的层 | 承载物 | A2A 的对应层 | 是否有对应物 |
|---|---|---|---|
| 传输 | `@qianmo/transport`：单条 wss 长连 + 6 种帧 | 三种绑定（JSON-RPC / gRPC / HTTP+JSON） | 有，但形态相反（对等长连 vs 客户端-服务端） |
| 路由与治理 | 信封的 `to` / `hops` / `deliverTtlMs` / `fingerprint`；`@qianmo/router` 的判环与限流 | **无此层** | 无 |
| 会话与任务 | `taskId` / `contextId` / `task.request` / `task.result` | `Task` / `Message` / `TaskState` | 有，概念对齐成立 |
| 内容 | `payload`（`unknown` + 按 `type` 判别） | `Part[]` / `Artifact[]` | 有，我方粒度更粗 |
| 发现 | `@qianmo/registry`：地址 → 端点，心跳租约 | Agent Card + `/.well-known/agent-card.json` | 有，机制相反（中心登记 vs 自述拉取） |
| 授权 | 信封 `cap` + `@qianmo/capability` 三级 | `securitySchemes` + 传输层凭据 + `TASK_STATE_AUTH_REQUIRED` | 有，位置相反 |
| 资源出借 | `@qianmo/negotiation` 四段式 + `@qianmo/tunnel` | **无此层** | 无 |
| 审计 | `@qianmo/audit` 哈希链 | **无此层**（§13.4 只有一句 SHOULD 的最佳实践） | 无 |
| 常驻与休眠 | `AgentStatus.dormant` + `wake` + `@qianmo/activator` | **无此层**（A2A 假定服务端一直在） | 无 |

---

## 3. 字段映射表

覆盖 **15 个概念面**：信封、地址与寻址、注册中心与发现、消息类型、任务状态机、错误码、传输、流与推送、按需隧道、资源协商、capability 与授权、审计与追踪、去重、限流与防循环、大 payload。

我方字段名一律取自 `packages/` 下的类型定义；A2A 字段名一律取自 `a2a.proto`（snake_case）。

### 3.1 消息信封 → A2A `Message` / `Task`

我方定义：`packages/protocol/src/message.ts` 的 `QianmoMessage`。

| 我方字段 | A2A 字段 | 语义差异 |
|---|---|---|
| `v`（恒 `0`） | **无对应字段**；最近的是服务参数 `A2A-Version`（HTTP header 或 query） | A2A 把版本放**传输层的服务参数**，不放消息体；且规定空值按 `0.3` 解释（§3.6.2）。我方放信封内 |
| `msgId` | `Message.message_id` | **形似而语义窄一档**。A2A：「Agents **MAY** utilize the messageId to detect duplicate messages」（§3.3.1）。我方：`msgId` 是一级去重键，重传时不变，接收端**必须**去重（AC 判据：重投 3 次只处理 1 次） |
| `traceId`（W3C `traceparent`） | **无对应** | A2A 正文不定义任何 trace 字段。可塞进 `Message.metadata` 或 HTTP header（W3C trace context 与 A2A 正交），但那是我方的约定，不是 A2A 的字段 |
| `taskId` | `Message.task_id` / `Task.id` | **生成方相反。**A2A §3.4.2：taskId **由服务器生成**，「Client-provided `taskId` values for creating new tasks is **NOT** supported」，客户端带 taskId 只能引用已存在的任务，否则 MUST 回 `TaskNotFoundError`。我方：由发送方在 `createMessage` 里 `newId()` 生成，且它是判环键的一半（D-2）。见 G-2 |
| `contextId` | `Message.context_id` / `Task.context_id` | **概念对齐成立**（D-9 三处之一）。差异：A2A 允许 agent 拒绝客户端提供的 contextId，且拒绝时 MUST 报错、MUST NOT 另生成一个（§3.4.1）；我方无此约束，`contextId` 可选、透传 |
| `from` | **无对应**。最近的是 `Message.role` ∈ `{ROLE_USER, ROLE_AGENT}` | **最大的一处结构差。**A2A 消息没有发送方地址，只有二值角色；发送方身份在传输层的认证凭据里。我方 `from` 是完整 `qianmo://` 地址，且承担安全不变式 E-1（`protocol.md` §3.2） |
| `to` | **无对应** | A2A 是点对点调用：「寄给谁」由你调用哪个 URL 决定，不进消息体。**因此 A2A 消息不可路由** |
| `type`（11 个 `MessageType`） | 部分对应 = 方法名（§0 表）+ `StreamResponse` 的 oneof 分支 | 我方把类型放在**信封上的判别式**；A2A 的等价物散在方法名与响应联合里。逐条对应见 §3.4 |
| `payload` | `Message.parts[]`（`Part` 的 oneof：`text` / `raw` / `url` / `data`，加 `media_type` / `filename` / `metadata`）；输出侧走 `Artifact.parts[]` | A2A 的内容是**分片、有 MIME 类型的列表**；我方是一个 `unknown` 加按 `type` 判别的封闭结构，`task.result` 的成功分支只有一个 `content: string`。A2A §3.7 还明确「Messages SHOULD NOT be used to deliver task outputs，Results SHOULD BE returned using Artifacts」 |
| `createdAt` | **无对应**（`TaskStatus.timestamp` 是状态被记录的时刻，不是消息创建时刻） | 我方两条时限都以它为起点 |
| `deliverTtlMs` | **无对应** | 全文逐词检索：A2A 规范中 `TTL` 零命中、`deadline` 零命中。见 G-6 |
| `taskTtlMs` | **无对应** | 同上。A2A 侧最接近的是 `SendMessageConfiguration.return_immediately`（调用是否阻塞到终态/中断态），那是**调用形态**不是时限 |
| `hops` | **无对应** | 「hop」在规范全文零命中（唯一的 `hop` 子串出现在示例里的 "coffee shops"） |
| `fingerprint` | **无对应** | A2A 只有 messageId 级的 MAY 去重，无内容指纹 |
| `origin`（`{node, agent, capIss?, receivedAt?}`） | **无对应** | A2A 无来源标注字段 |
| `trust`（恒 `'untrusted'`） | **无对应** | A2A §13 有安全考量正文，无对应字段 |
| `cap` | **无对应**（授权凭据在传输层；任务内授权走 `TASK_STATE_AUTH_REQUIRED`） | 见 §3.8 与 G-16 |
| `costLimit` | **无对应** | M0 恒为 0（章程 N-1），见 G-25 |

**A2A 有、我方没有的 `Message` 字段：**

| A2A 字段 | 我方 | 说明 |
|---|---|---|
| `Message.role` | 无对应 | 见上 `from` 行 |
| `Message.metadata`（`google.protobuf.Struct`） | **无对应** | 我方 `protocol.md` §3.1 明令 `payload` 不得重述信封语义，但也**没有开放的自由 metadata 位**。A2A 侧这个位子是几乎所有跨边界补丁的落点——G-6 与 G-10 的收敛动作都落在这里 |
| `Message.extensions[]`（扩展 URI 数组） | 无对应 | A2A 的正式扩展机制，配 `AgentCapabilities.extensions[]` 声明 |
| `Message.reference_task_ids[]` | 无对应 | 引用其他任务作上下文 |
| `Part.media_type` / `Part.filename` | 无对应 | 我方超限 payload 走 `$blob`，见 §3.9 |
| `tenant`（出现在几乎所有请求消息上） | 无对应 | 多租户路由标识，章程 N-2 已排除，见 G-24 |

### 3.2 地址与寻址

我方定义：`packages/protocol/src/address.ts`。

| 我方 | A2A | 语义差异 |
|---|---|---|
| `qianmo://<node>/<agent>`，段字符集 `[a-z0-9]` 起止、内可含 `-_`、1–64 字符（`address.ts:16`）；`parseAddress` / `formatAddress` / `assertAddress` | `AgentInterface.url`（HTTP 类绑定生产环境 MUST 为绝对 HTTPS URL；gRPC 为 `hostname:port`） | **我方地址是逻辑标识**，要经注册中心解析成端点；**A2A 的 url 就是物理端点**。A2A 里**不存在与部署位置解耦的智能体标识符**。见 G-4 |
| `node` 段（节点层级） | **无对应** | A2A 没有「节点」这一层——一个智能体就是一个 URL |
| `AgentRecord.endpoint`：`qianmo://` / `http(s):` / `ws(s):` / `ws+unix:`（`registry.ts` 的 `isValidEndpoint`） | `AgentInterface.url` + `protocol_binding`（开放字符串，官方三值 `JSONRPC` / `GRPC` / `HTTP+JSON`）+ `protocol_version` | A2A 一个智能体可同时暴露多个绑定与多个协议版本，按 `supported_interfaces` 顺序表选首选（§8.3.2 是 MUST）；我方一个 agent 一个端点，无绑定协商 |
| 规则 A-1（22 个 Windows 保留设备名禁用）、A-2（team 名归一化正则） | **无对应** | 这两条是我方与基座文件信箱耦合的产物（`protocol.md` §2.2/§2.3），A2A 侧无落点也不需要 |

### 3.3 注册中心 → Agent Card 与发现

我方定义：`packages/registry/src/registry.ts` 的 `AgentRecord`；HTTP 面 `packages/registry/src/http.ts`。

| 我方字段 / 端点 | A2A | 语义差异 |
|---|---|---|
| `AgentRecord.address` | 无直接对应（身份≈`AgentCard.name` + 所选 interface 的 url） | `AgentCard.name` 是人读名，**不保证唯一**，不能当键 |
| `AgentRecord.endpoint` | `AgentCard.supported_interfaces[].url` | 见 §3.2 |
| `AgentRecord.capabilities: readonly string[]`（≤64 条，每条 ≤64 字符自由字符串） | `AgentCard.skills[]`：`AgentSkill{ id, name, description, tags[], examples[], input_modes[], output_modes[], security_requirements[] }`；**另有** `AgentCard.capabilities`：`AgentCapabilities{ streaming, push_notifications, extensions[], extended_agent_card }` | **差距最大的一格。**我方一个裸标签数组同时被当成「会什么」和「支持什么协议特性」；A2A 把这两件事**分成两个字段**，且技能是结构化的。见 G-1 |
| `AgentRecord.publicKey`（Ed25519，base64url 无填充 43 字符，`protocol/src/capability.ts` 的 `PUBLIC_KEY_PATTERN`） | `AgentCard.signatures[]`：`AgentCardSignature{ protected, signature, header }`，JWS（RFC 7515）+ JCS 规范化（RFC 8785），签名时 MUST 排除 `signatures` 字段本身 | **用途不同，不可互换。**A2A 签的是**卡本身**（防篡改）；我方发布的是**节点公钥**，用来验消息上的 capability 令牌。两者都该有，A2A 缺后者、我方缺前者 |
| `AgentRecord.status`（`online` / `dormant` / `offline`，后者由租约推导，不可自称） | **无对应** | A2A 假定服务端一直在。这条直接关系 AC-2：发送方要按 `statusOf` 决定 `deliverTtlMs`（规则 T-3）。见 G-11 |
| `registeredAt` / `lastHeartbeatAt` / `expiresAt`（心跳租约，`registry.ts` 的 `DEFAULT_TTL_MS`） | **无对应**。A2A 的时效性靠 HTTP 缓存（§8.6：`Cache-Control` / `ETag` / `If-None-Match`） | 我方是**推**（心跳续租，不续即离线），A2A 是**拉**（客户端按缓存策略重取卡） |
| `POST /v0/agents`、`GET|DELETE /v0/agents/{addr}`、`POST /v0/agents/{addr}/heartbeat`、`GET /v0/health` | `GET /.well-known/agent-card.json`；`GetExtendedAgentCard`（要求 `capabilities.extended_agent_card` 为真，且需认证） | **中心登记 vs 智能体自述。**A2A §8.2 也提到「Registries/Catalogs」是一种发现途径，但**不定义其接口**——所以我方的注册中心与 A2A 不冲突，只是 A2A 管不着 |
| **无对应** | `AgentCard.provider{url, organization}`、`version`、`documentation_url`、`icon_url`、`description`、`default_input_modes[]`、`default_output_modes[]`、`security_schemes`（map）、`security_requirements[]` | 我方注册记录里一个都没有。见 G-1 |

### 3.4 消息类型 → A2A 操作

| 我方 `MessageType` | A2A 对应物 | 语义差异 |
|---|---|---|
| `task.request` | `SendMessage` / `SendStreamingMessage`（携带 `Message`，`role = ROLE_USER`） | A2A 是**有返回值的 RPC**（回 `Task` 或 `Message`）；我方是单向信封，回复是另一条独立信封 |
| `ack` | **无对应**。最近的是 `TASK_STATE_SUBMITTED`（「successfully submitted and acknowledged」） | **差异是本质的。**我方 ack 是 A 类：断言且只断言「目标智能体已把这条消息取进自己的输入」（基座信箱 `read` 翻转），payload 字段封闭为 `{handler, ackAt}`（规则 K-1，`message.ts` 的 `ACK_PAYLOAD_KEYS`）。A2A 的 SUBMITTED 是**服务端建了一个任务**，不断言任何智能体已取件。见 G-12 之外单列于 §4 |
| `task.result` | `Task`（`status.state` = `TASK_STATE_COMPLETED` / `FAILED`）+ `Task.artifacts[]`；流式时是 `TaskStatusUpdateEvent` | **我方是发出去的一条消息，A2A 是查得到的资源。**发完之后我方除审计日志外无处可查；A2A 有 `GetTask` / `ListTasks` |
| `ping` / `pong` | **无对应** | A2A 无存活探测；我方的 keepalive 另有一层在 transport 帧（`FrameType.KeepAlive`），那一层是因为代理不把控制帧计入空闲计时（`frames.ts` 注释） |
| `wake` | **无对应** | A2A 无休眠概念。见 G-11 |
| `error` | 绑定层错误：JSON-RPC `-3200x` / gRPC status / HTTP status；异步链路上的失败表现为 `TASK_STATE_FAILED` + `TaskStatus.message` | **我方错误是一条进状态机的消息；A2A 错误是一次调用的失败返回。**详见 §3.6 |
| `resource.request` / `resource.offer` / `resource.grant` / `resource.release` | **全部无对应** | A2A 无资源出借语义。见 §3.11 与 G-19 |

### 3.5 生命周期状态机

我方状态见 `protocol.md` §8.1（5 个在途 + 7 个终态）；A2A 见 `TaskState` 枚举（9 个值，含 `UNSPECIFIED`）。

| 我方状态 | A2A `TaskState` | 语义差异 |
|---|---|---|
| `created` / `queued` / `sent` | **无对应** | 发送方本地状态，A2A 不建模客户端侧 |
| `delivered` | **无对应** | 「本节点已持有但智能体未读」这一档 A2A 没有 |
| `acked` | ≈ `TASK_STATE_SUBMITTED` | 断言强度不同，见 §3.4 |
| **（我方没有）** | `TASK_STATE_WORKING` | `protocol.md` §3.4 明确不定义 `task.progress`。见 G-13 |
| `completed` | `TASK_STATE_COMPLETED` | **名对齐成立**（D-9 三处之一）。内容形态不同：我方 `content: string`，A2A `artifacts[]` |
| `failed` | `TASK_STATE_FAILED` | 同上对齐 |
| **（我方没有）** | `TASK_STATE_CANCELED` | 我方无取消操作也无该终态；`protocol.md` §4.6 把「被取消」并进了 `E_TASK_FAILED`。见 G-14 |
| **（我方没有）** | `TASK_STATE_REJECTED` | 我方拒绝表现为 `error(<code>)` + 终态 `failed`，不是一个可查询的任务状态 |
| **（我方没有）** | `TASK_STATE_INPUT_REQUIRED` | 我方是「一条请求一条结果」，中途不能要输入。见 G-15 |
| **（我方没有）** | `TASK_STATE_AUTH_REQUIRED` | 我方授权在入站校验时一次判定（`NodeRouter.inbound` → `E_CAP_INSUFFICIENT`），没有「任务中途要授权、挂起等对端补」这条路。见 G-17 |
| `dropped` / `expired` / `timeout` / `loop_detected` / `rate_limited` | **全部无对应** | 五个都是**投递面**终态，A2A 不建模投递 |

**一处值得记下的同向设计**：A2A §7.6.4 明写「Agents **MUST NOT** treat the `TASK_STATE_AUTH_REQUIRED` state transition, by itself, as authorization for any particular operation」。这与我方章程 C-5「消息不能替用户授权」是同一个判断。差别在于 A2A 靠一句 MUST NOT，我方靠规则 S-1 的一次签名校验。

### 3.6 错误码

我方 `ProtocolErrorCode` 19 个（`packages/protocol/src/errors.ts`），A2A 9 个 A2A-specific error + 5 类通用分类（§3.3.2、§5.4）。

| 我方码 | A2A | 语义差异 |
|---|---|---|
| `E_BAD_ENVELOPE` / `E_BAD_ADDRESS` / `E_BAD_TYPE` | Validation Errors 类（JSON-RPC `-32602` / gRPC `INVALID_ARGUMENT` / HTTP 400） | 分类对得上，粒度我方细 |
| `E_BAD_VERSION` | `VersionNotSupportedError`（`-32009`） | 我方判信封 `v`，A2A 判服务参数 `A2A-Version` |
| `E_TOO_LARGE` | 无专门码（落 Validation 或 HTTP 413） | |
| `E_UNKNOWN_AGENT` | **无对应**。`TaskNotFoundError` 不是它——A2A 没有「找不到这个智能体」，调不通就是网络层的事 | 见 G-18（这条码本身构成一处信息泄漏） |
| `E_TTL_EXPIRED` / `E_TASK_TIMEOUT` / `E_EVICTED` / `E_UNDELIVERABLE` / `E_LOOP` / `E_TOO_MANY_HOPS` / `E_RATE_LIMITED` | **全部无对应** | 投递面 |
| `E_TASK_FAILED` | `TASK_STATE_FAILED`（是**状态**不是错误码） | |
| `E_CAP_INVALID` / `E_CAP_INSUFFICIENT` | Authentication / Authorization Errors 类（HTTP 401 / 403） | A2A 对这两类附了两条硬约束：MUST NOT 泄漏无权访问的资源是否存在；SHOULD NOT 区分「不存在」与「无权限」 |
| `E_PAYLOAD_UNAVAILABLE` | 无对应 | `$blob` 是我方独有，见 §3.9 |
| `E_BUDGET_EXHAUSTED` / `E_RESOURCE_REFUSED` | 无对应 | N-1 与资源协商，均我方独有 |
| `E_RUNTIME_THROTTLED`（**不在** `ProtocolErrorCode` 内，定义在 `@qianmo/router`，永不上线） | 无对应 | 我方刻意把运行时层与协议层的限流码分开（§6.4）；A2A 无此区分 |
| **（我方没有）** | `TaskNotCancelableError` / `PushNotificationNotSupportedError` / `UnsupportedOperationError` / `ContentTypeNotSupportedError` / `InvalidAgentResponseError` / `ExtendedAgentCardNotConfiguredError` / `ExtensionSupportRequiredError` | 全部因为对应能力我方没有；A2A 允许「声明不支持并回相应错误」，这是合规路径而不是缺陷 |

### 3.7 传输

| 我方（`@qianmo/transport`） | A2A | 语义差异 |
|---|---|---|
| 单条 wss 长连接 + 自定义帧语法 `FRAME_VERSION = 1`：`challenge` / `auth` / `ready` / `envelope` / `receipt` / `keep_alive` | 三种绑定：JSON-RPC 2.0、gRPC、HTTP+JSON(REST)，功能等价性是 MUST（§5.1） | **我方是双向对等长连接；A2A 三种绑定全是客户端→服务端的请求/响应**（流式也是服务端单向推） |
| `ReceiptFrame{msgId, status ∈ accepted/duplicate/rejected, code?, reason?}` | **无对应** | 我方在传输层就给出逐条投递回执，其中 `duplicate` 是去重命中的显式告知；A2A 无 |
| PSK 握手：`HMAC-SHA256(psk, [v, serverNonce, clientNonce, node, channelId])`（`handshake.ts` 的 `computeMac`），PSK ≥16 字符，取自 `QIANMO_TRANSPORT_PSK` | `MutualTlsSecurityScheme` / `HTTPAuthSecurityScheme` / `OAuth2SecurityScheme`（含 authorization code+PKCE、client credentials、device code）/ `OpenIdConnectSecurityScheme` / `APIKeySecurityScheme` | 我方是**对称 PSK 作接入门禁**（章程 N-3 已把它写成局限，不是主张）；A2A 全是标准企业方案。A2A §7.1：生产部署 MUST 加密，SHOULD TLS 1.3+ |
| `channelId`：跨物理重连保持的逻辑连接标识 | **无对应** | |

### 3.8 capability 与授权

| 我方 | A2A | 语义差异 |
|---|---|---|
| 信封字段 `cap`，形态 `<claims>.<sig>`，claims `{iss, sub, aud, act, taskId, nbf, exp, nonce}`，Ed25519 分离签名（`protocol/src/capability.ts`） | **无对应**——凭据在传输层的 header / metadata，形态由 `securitySchemes` 决定 | A2A §7 首段：「Identity information is handled at the protocol layer, **not within A2A semantics**」。这是**方向相反的两个设计**，见 G-16 |
| `act` 三级：`read` / `write-limited` / `user-confirmed`（`CapabilityLevel`） | **无对应**（最近的是 OAuth scopes，但那是部署决定，不是协议枚举） | |
| 规则 S-1：`user-confirmed` 令牌只认本节点私钥签发，`iss ≠ 本节点`一律 `E_CAP_INSUFFICIENT` | 思想同向、机制相反的 `TASK_STATE_AUTH_REQUIRED`：「我需要授权，请客户端去弄」 | 我方是「你说你有授权我不信，除非是我自己签的」。两者都在防 confused deputy，但 A2A 靠流程 + MUST NOT，我方靠密码学 |
| `SIGNED_TASK_POLICY`（**P12.4 起的默认**，未签名 `task.request` 被拒）/ `OPEN_POLICY`（`--open-policy` 逃生开关） | A2A §7.4：服务端 **MUST** authenticate every incoming request | M0 的默认配置以 A2A 口径衡量是不合规的服务端；P12.4 切默认之后这条对齐（见 G-27），逃生开关打开时仍不合规 |
| 规则 M-2（包装对象顶层 `type` 不得命中基座 10 个保留类型）、E-1/E-2（`from` 永不等于本地身份）、S-3（权限不可提升）、`notice` 固定模板 | **无对应**（A2A §13 有安全考量正文，无结构性字段） | 这四条是我方与基座耦合面上的结构性阻断（`protocol.md` §10.2），A2A 侧既无该耦合也无该字段 |

### 3.9 大 payload

| 我方 | A2A | 语义差异 |
|---|---|---|
| `$blob` 引用 `{ id, bytes, sha256 }`（`adapter/src/blob.ts` 的 `BlobRef`），因基座信箱单条 `text` 的硬上限（基座导出的 `MAX_MAILBOX_MESSAGE_TEXT_BYTES`）而设（`protocol.md` §9.3） | `Part.url`（指向文件的远端引用）/ `Part.raw`（base64 内联） | 目的相近（内容不内联），机制不同：A2A 的 `Part.url` 是**给对端取**的引用；我方 `$blob` 是**本节点暂存区**的私有引用，生命周期绑该 `taskId` 的任务时限。**A2A 没有校验和字段**，我方有 `sha256` 且取不到时回 `E_PAYLOAD_UNAVAILABLE`、不静默降级 |

### 3.10 审计与追踪

| 我方（`@qianmo/audit`） | A2A | 语义差异 |
|---|---|---|
| `AuditRecord{ seq, at, source, kind, traceId?, taskId?, msgId?, node?, peer?, outcome ∈ ok/refused/dropped, code?, detail?, prev }`；`prev` 是前一条的 sha-256，append-only（`O_APPEND | O_NOFOLLOW`） | **无对应** | A2A 完全不定义审计。§13.4 只有一句「Agents **SHOULD** provide audit trails for sensitive operations」，无数据模型 |
| `Task.history` 的对应物 | `Task.history[]`（`Message` 列表） | 这是 A2A 侧最接近的东西，但 §3.7 明说「not all Messages are guaranteed to be persisted」、由智能体自行决定存什么——**它是会话记录，不是不可否认的链** |
| `reconstructChain(records, traceId)`：按 `seq` 全序还原一条链（含被拒、被丢、被去重的） | 无对应 | 按 `seq` 而不是时间戳排序，因为两个节点的钟不一致（P7.2 实施记录） |

### 3.11 资源协商与按需隧道

| 我方 | A2A | 语义差异 |
|---|---|---|
| 四段式 `resource.request` → `resource.offer` → `resource.grant` → `resource.release`；`ResourceNeed{durationMs, cpuCores, memoryMb}`；`ResourceOfferPayload{offerId, granted, offerExpiresAt, capability?}`；`ReleaseReason` ∈ `completed`/`expired`/`abandoned`/`failed`（`protocol/src/negotiation.ts`） | **全部无对应** | A2A 的模型是「调用一个服务让它替我干活」；资源出借是「把我的机器借给你跑你自己的东西」。**这不是同一件事**，A2A 不会长出它 |
| `LenderPolicy{ceiling, offerTtlMs, clampToCeiling?, maxConcurrentLeases?}`（上限**不在** `LIMITS`，因为它是本地决定） | 无对应 | |
| `@qianmo/tunnel`：租约存在才开监听、首条消息按字节相等核对贷方自铸令牌、`TeardownReason` ∈ `released`/`expired`/`peer-lost`/`withdrawn`、**不重连** | **无对应** | A2A 无隧道概念 |

### 3.12 去重、限流、防循环

| 我方 | A2A | 语义差异 |
|---|---|---|
| 一级去重键 `msgId`、二级去重键 `fingerprint = sha256([from,to,type,taskId,payloadDigest])`，两级 TTL 均为投递时限（`protocol/src/fingerprint.ts`） | `messageId` 的 MAY 级去重（§3.3.1）；Get / Cancel 天然幂等 | 我方是**必须**且两级；A2A 是**可以**且一级 |
| 协议层入站预算 `LIMITS.ratePerMinute`，按**发送节点**计（`InboundBudget`）；运行时层令牌桶（`RuntimeThrottle`），两层各自的键、上限出处、审计事件、拒绝码都不同 | **无对应**。§3.3.2 只把 rate limit 举作 System Errors 的一个例子 | |
| 判环键 `(处理者地址, taskId)`，首次回访即切断；`LIMITS.maxHops` 兜底；回复类消息（`isReplyType`）不进判环表 | **无对应** | 见 §1 的层次判断 |

### 3.13 流与推送（A2A 有、我方全无）

| A2A | 我方 | 说明 |
|---|---|---|
| `SendStreamingMessage` / `SubscribeToTask` → `StreamResponse{task \| message \| status_update \| artifact_update}`；MUST 保序；一个任务可有多条并发流并广播 | **无对应** | 见 G-21 |
| `TaskPushNotificationConfig{tenant, id, task_id, url, token, authentication{scheme, credentials}}` + 四个配置操作；webhook 走纯 HTTP POST（无论主绑定是什么） | **无对应** | 见 G-22 |
| `AgentCapabilities.streaming` / `push_notifications` 声明为 false 即可合规拒绝（回 `UnsupportedOperationError` / `PushNotificationNotSupportedError`） | — | 这是本文把 G-21/G-22 判为「长期保留差异」的依据 |

---

## 4. 差距清单

**27 条**。每条一行，含差距、互操作时会坏什么、三选一标注与一句理由。

「互操作」在本表中指两个方向：**出向** = 我方以 A2A 客户端身份调用第三方智能体；**入向** = 第三方 A2A 客户端调用我方节点。

| # | 差距 | 影响（互操作时会坏什么） | 标注 | 理由 |
|---|---|---|---|---|
| G-1 | **无 Agent Card / 无结构化能力描述面。**`AgentRecord.capabilities` 是 ≤64 条裸字符串，A2A 要 `AgentCard`（skills + capabilities + securitySchemes + interfaces + provider + 输入输出 MIME） | **入向全断。**A2A 客户端连 `/.well-known/agent-card.json` 都拿不到，无法发现我方智能体、无法选绑定、无法知道要带什么凭据 | **M1 收敛** | 这是互操作的第一道门，不通则后面全部无从谈起；而且它是**纯增量**——发一张卡不需要动信封、不动状态机、不动任何既有判据 |
| G-2 | **`taskId` 生成方相反。**A2A 由服务器生成、明令客户端不得为新任务提供；我方由发送方生成且它是判环键的一半 | **两向都坏。**出向：对端回的 taskId 与我方 `LoopGuard` 里的键不是同一个，判环与相关键同时失准。入向：我方要求信封必带 taskId，而 A2A 客户端不会给 | **M1 收敛** | 不解决则跨边界任务有两套 ID，审计链断。**但收敛点是网关的映射表，不是改我方 `taskId` 归属**——改归属会打掉 D-2 的起始播种设计。见 §6 判断点 ② |
| G-3 | **A2A 消息无发送方地址**（只有 `role` 二值） | 入向：`from` 无处可取，只能由网关按连接身份合成。出向：我方 `from` 在对端看不见 | **长期保留差异** | 层次差：A2A 点对点调用里「谁寄的」由传输层凭据回答。要求 A2A 加 `from` 等于要求它变成路由协议 |
| G-4 | **A2A 消息无收件地址、不可路由**；且无与部署位置解耦的智能体标识符（url 即身份） | 我方的多跳路径在 A2A 侧不可表达；一个 A2A 段就是路由图上的一个黑盒 | **长期保留差异** | 同 G-3。我方的地址-端点分离是常驻/迁移/休眠的前提（AC-2），不能为对齐放弃 |
| G-5 | **无 `hops` / `maxHops`** | 出向：经过一个 A2A 中转后跳数计数清零，`maxHops` 兜底失效 | **长期保留差异** | A2A 不做路由，不会加这类字段。我方对策是**在网关边界保守累计**（出网关记一跳、回程继续计），不指望对端配合 |
| G-6 | **无投递时限 / 任务时限**（`deliverTtlMs` / `taskTtlMs` 在 A2A 全无对应，`TTL`、`deadline` 全文零命中） | 出向：我方单边计时判 `E_TASK_TIMEOUT` 之后，对端仍可能在跑并回结果，回来的是一个已被判死的任务；入向：A2A 客户端不知道我方会超时 | **M1 收敛** | A2A 有正式扩展机制（`AgentExtension{uri, description, required, params}` + `Message.extensions[]`），TTL 恰是「不理解也能安全忽略」的语义，把 `required` 设 false 即可——**这正是 A2A 给这类字段留的位置** |
| G-7 | **无内容指纹二级去重**（A2A 的 messageId 去重是 MAY） | 出向：发送方崩溃重启后为同一件事重建的请求，A2A 对端会当成新任务执行两次 | **长期保留差异** | A2A 的任务是服务端资源、有 `ListTasks` 可查，重复处置在它的模型里是客户端的事。我方要跨边界防重只需网关侧保留自己的指纹表，不需要对端配合，不值得推 A2A 规范 |
| G-8 | **无判环机制**（`(处理者地址, taskId)` 在 A2A 无对应） | 出向：A→A2A→A 的回环检测不到，AC-3 出了边界就失效 | **M1 收敛** | AC-3 是章程判据，不能因为出边界就不作数。收敛点是「网关把出向调用当作一次处理者访问记进 `LoopGuard`」，**不需要 A2A 有等价物** |
| G-9 | **入向来源标注缺失**：A2A 消息进我方链路时无 `origin` / `trust` 可取 | 入向：`protocol.md` §10.2 要求的四个结构性阻断中，「来源标注」这一环在网关处断掉 | **M1 收敛** | 这一条不需要 A2A 配合——`origin` 本来就规定「全部由接收侧填写，不采信信封自述」，网关就是接收侧。不做则 T-7 的防线在 A2A 入口有个洞 |
| G-10 | **出向不可信标记无落点**：`trust` / `notice` 在 A2A 侧只能塞 `Message.metadata` | 出向：对端不会知道这条内容来自不可信的跨节点链路 | **长期保留差异** | 对端信不信、怎么标注，是对端的部署决定；我方能做的只有如实标注在 metadata 里。指望 A2A 定义一个全网通用的 `trust` 字段不现实 |
| G-11 | **无智能体在线/休眠/离线状态，也无心跳租约**（`AgentStatus` 在 A2A 无对应） | 入向：A2A 客户端不知道我方节点可能处于冻结态，会在唤醒完成前按自己的超时断连——**唤醒代价 9–10 秒（E2 实测），足以打掉默认超时** | **长期保留差异** | 休眠-唤醒是阡陌产品线①的核心（AC-2），A2A 假定服务端常在，它没有理由长出这个字段。**但必须配一条 M1 动作**：在 Agent Card 里用 `AgentExtension` 声明「本智能体可能休眠，首次调用延迟可达 N 秒」 |
| G-12 | **`ack` 与 `TASK_STATE_SUBMITTED` 语义不等价**：我方 ack 断言「智能体已取件」（`read` 翻转），A2A 的 SUBMITTED 只断言「服务端建了任务」 | 出向：把对端的 SUBMITTED 当成我方 ack 会**高估投递保证**——它不排除消息在对端排队里烂掉。入向：我方按 `read` 翻转才回 SUBMITTED 会比 A2A 客户端预期的慢一个轮询周期 | **长期保留差异** | 我方 ack 的定义是 AC-2 60 s 线成立的全部依据（`protocol.md` §4.2 的 A 类），放松它等于放弃判据。网关只需**不做等价映射**：把我方 ack 映射成 SUBMITTED 可以，反向不可以 |
| G-13 | **无 `TASK_STATE_WORKING` / 无进度事件** | 入向：A2A 客户端订阅我方任务时从 SUBMITTED 直接跳到 COMPLETED，中间空白（A2A 状态机不强制经过 WORKING，所以**不违规、只是体验退化**） | **长期保留差异** | `protocol.md` §3.4 已论证过不引入 `task.progress`：进度事件必然触碰旧工作集，会把 A 类 ack 的边界搅浑。网关可以在收到我方 ack 后自行置 WORKING，那是网关的自由，不必进协议 |
| G-14 | **无取消**（既无 `CancelTask` 等价操作，也无 `canceled` 终态；`protocol.md` §4.6 把「被取消」并进了 `E_TASK_FAILED`） | 两向都坏。入向：A2A 客户端调 `CancelTask`，我方只能回 `TaskNotCancelableError`。出向：我方无法撤回已发给对端的任务，只能干等 `taskTtlMs` | **M1 收敛** | 取消不是花哨功能，是长任务的基本操作；我方的替代品（干等任务时限到期）在 AC-7 那种真实建模任务上不可接受。而且它**不需要新终态**——一条新的请求类消息 + 既有的 `failed`(`E_TASK_FAILED`) 就够 |
| G-15 | **无 `TASK_STATE_INPUT_REQUIRED` / 无多轮追问** | 出向：对端要求补充输入时，我方收到一个不在终态集合里的状态，只能判 `failed`——**一次本可完成的任务被判死**。这是本表里**唯一一条会静默把成功变成失败**的差距 | **M1 收敛** | 多轮是 A2A 的核心模式之一，出向遇到是常态而非例外。**但它是本文所有 M1 项里唯一动到 §8 状态机骨架的**（要引入一个非终态的等待），见 §6 判断点 ③ |
| G-16 | **授权凭据位置相反**：我方在信封 `cap` 上、绑 `taskId` 与 `aud`、每节点 Ed25519；A2A 在传输层，且明写身份不属于 A2A 语义 | 两向都要在网关处做凭据形态转换；我方的 `act` 三级在 A2A 侧无表达 | **长期保留差异** | **这一条必须保留且要在对外材料里说清是有意为之。**`cap` 绑 `taskId` 与 `aud` 是规则 S-1 得以成立的结构：把它挪到传输层，就等于把「用户确认不可伪造」交还给对称的接入凭据，章程 C-5 从结构性保证退回约定（D-8 的原始论证） |
| G-17 | **无 `TASK_STATE_AUTH_REQUIRED` 路径**：我方授权是入站一次判定，没有「任务中途要授权、挂起等对端补」 | 出向：对端进入 AUTH_REQUIRED 时我方无动作可做，任务挂到超时 | **M1 收敛** | 与 G-15 同一类失效（把可完成的任务拖死），且落点相同（状态机的非终态等待）。**若 G-15 被评审否决，本条应随之改判为长期保留差异**——两条共用一个机制，不能只做一半 |
| G-18 | **错误码可区分「不存在」与「无权限」**：`E_UNKNOWN_AGENT` vs `E_CAP_INSUFFICIENT`，与 A2A §3.3.2「SHOULD NOT distinguish」相反 | 一个持有合法 PSK 的对端可以用错误码**枚举本节点上有哪些 agent** | **M1 收敛** | 这条与互操作无关——**是我方自己的一处信息泄漏，A2A 只是把它照出来了**。改动面小（`@qianmo/router` 的 inbound 判决两支回同一个码）。代价要写明：合并后运维少一个诊断信号，需在审计日志里仍分开记（`AuditRecord.code` 是本地的，不上线） |
| G-19 | **资源协商四段式在 A2A 无任何对应物** | 跨 A2A 边界时借出/借入完全无法表达；这套语义只在阡陌网络内部生效 | **长期保留差异** | A2A 的模型是「调用一个服务」，资源出借是「把机器借出去跑对方的东西」，不是同一件事。若将来真要跨厂商，正确路径是**发布一个 A2A extension URI**（`AgentExtension`），而不是等 A2A 收编 |
| G-20 | **按需隧道在 A2A 无对应物** | 同 G-19 | **长期保留差异** | 隧道是资源协商的执行面，随 G-19 一起走扩展路径。且隧道的核心性质（租约不在就没有监听、不重连）是本地部署纪律，不是线上协议 |
| G-21 | **无流式**（`SendStreamingMessage` / `SubscribeToTask` / `StreamResponse`） | 入向：只能声明 `capabilities.streaming = false` 并回 `UnsupportedOperationError`——**这是 A2A 明确允许的合规路径**（§3.3.4） | **长期保留差异** | 声明清楚即合规，互操作不坏。而且我方最后一跳是基座文件信箱，整条消息一次写入，逐 token 流式在这条链上**没有落点** |
| G-22 | **无 push notification / webhook**（四个配置操作与 `TaskPushNotificationConfig` 全无） | 入向：声明 `capabilities.pushNotifications = false` 并回 `PushNotificationNotSupportedError`，同样合规 | **长期保留差异** | 同 G-21 的合规理由；且 webhook 解决的问题（客户端不保持连接）我方没有——我方对端是常驻节点，有长连接 |
| G-23 | **内容模型粒度差**：我方 `payload: unknown` + `task.result.content: string`；A2A 是 `Part[]`（text / raw / url / data + `media_type` + `filename`）与 `Artifact[]`，且 §3.7 明确输出走 Artifact 不走 Message | 两向：对端返回图片/文件/结构化数据时我方只能取 text 或整体 JSON 化；我方回的纯字符串在 A2A 侧不是合规的输出形态 | **M1 收敛** | AC-7 的真实建模任务回传的就不止纯文本。而且这是**纯 payload 层改动**——不动信封、不动状态机、不动判据。改动面：`@qianmo/protocol` 的 `TaskResultPayload` |
| G-24 | **无 `tenant` / 无多租户路由** | 入向：不受影响（`tenant` 是可选的）。出向：若所选 `AgentInterface` 带 `tenant`，客户端 **MUST** 在每个请求里原样回填（§8.3.2） | **不适用** | 章程 N-2 明列多租户为非目标。出向那半只是网关的一行透传，不构成设计差距 |
| G-25 | **`costLimit` 在 A2A 无对应** | 无影响 | **不适用** | 章程 N-1：M0 恒为 0，只验证硬上限能拦住。计费语义整体是 M0 非目标 |
| G-26 | **版本协商位置不同**：我方 `v` 在信封内且恒为 0；A2A 用服务参数 `A2A-Version`，只认 Major.Minor，空值按 `0.3` 解释 | 无影响——网关发 `A2A-Version: 1.0` 即可，不涉及我方信封 | **不适用** | 我方 `v` 恒为 0 且零外部对端（`protocol.md` §1.3），两个版本号管的是两件事，不必统一 |
| G-27 | ~~**M0 默认策略允许未签名的 `task.request`**（`OPEN_POLICY`）~~；A2A §7.4 要求服务端 **MUST** authenticate every incoming request | 入向：以 A2A 口径衡量，我方节点是不合规的服务端 | **已收敛（P12.4，2026-08-20）** | `capability/src/policy.ts` 的模块注释当初写下的收敛条件——「有了拿钥匙的途径」——由 P12.1~P12.3 满足，默认于 P12.4 切成 `SIGNED_TASK_POLICY`（`key-distribution.md` §9.2 ②）。**逃生开关 `--open-policy` 仍在**，打开时这条重新不合规，这是明写的取舍而不是遗漏（§9.3：回滚零代价）。**注意可选的一直只是「是否强制出示」**：任何已出示的令牌 M0 也全程校验 |

**标注分布**（合计 **27** 条）：

| 标注 | 条数 | 编号 |
|---|---|---|
| **M1 收敛** | **11** | G-1、G-2、G-6、G-8、G-9、G-14、G-15、G-17、G-18、G-23、~~G-27~~（**已收敛，P12.4**） |
| **长期保留差异** | **13** | G-3、G-4、G-5、G-7、G-10、G-11、G-12、G-13、G-16、G-19、G-20、G-21、G-22 |
| **不适用** | **3** | G-24、G-25、G-26 |

无一条以「后续再定」结尾（DoD 硬要求）。三条「不适用」全部指向章程既有的非目标条款（N-1 / N-2）或我方 `v` 恒为 0 的现状，不是回避。

---

## 5. M1 收敛建议

### 5.1 值得在 M1 对齐的，按改动面归包

| 落点 | 收敛哪几条 | 改动性质 |
|---|---|---|
| **`@qianmo/registry`（或新增一个只做卡的薄包）** | G-1、G-11 的配套动作 | 从 `AgentRecord` 生成 A2A `AgentCard` 并在 `/.well-known/agent-card.json` 暴露；`capabilities: string[]` 升级为结构化 skill（`id` / `name` / `description` / `tags`）；用 `AgentExtension` 声明休眠与首调延迟。**纯增量，不动既有 HTTP 面** |
| **新增一个双向网关包** | G-2、G-8、G-9 全部；G-5 / G-7 / G-10 的边界侧对策 | 出向：把 `task.request` 译成 `SendMessage`，维护 `我方 taskId ↔ 对端 taskId` 映射表，出网关记一跳并写 `LoopGuard`。入向：按连接身份合成 `from` 与 `origin`，拒绝客户端提供的 taskId 并自生成。**这是本节最大的一块，也是最需要先裁定的一块——见 §6 判断点 ①** |
| **`@qianmo/protocol`** | G-14（取消）、G-23（内容分片）；G-6 的扩展 URI 定义 | `MessageType` 加 `task.cancel`（`isReplyType` 不变）；`TaskResultPayload` 的成功分支由 `content: string` 扩成分片列表并带 `media_type`；为 TTL 定义一个我方自有的 `AgentExtension` URI 与 params 形状。**前两项动线上契约，必须升 `v` 并写迁移**（`protocol.md` §1.3 的条件已不再满足——M1 会有已部署对端） |
| **`@qianmo/router`** | G-18 | inbound 判决在「未知 agent」与「权限不足」两支上回同一个码；审计侧仍分开记 |
| **`@qianmo/capability`** | G-27 | ~~`OPEN_POLICY` 切 `SIGNED_TASK_POLICY`~~ —— **已于 P12.4 落地**（`gate.ts` 的默认、`--open-policy` 逃生开关）。此行保留为已完成项的指针 |
| **`@qianmo/audit`** | 全部 M1 收敛项的连带动作 | `AuditSource` 增加一个成员，网关的出向调用与入向回调都必须写进 trail——否则一条跨 A2A 的链在我方日志里会**断头**，而 C-6 要问的正是这个 |
| **状态机（`protocol.md` §8）** | G-15、G-17 | 唯一动骨架的一项：要引入一个「非终态的等待」，七个终态穷举的表述随之要改。**建议与 §6 判断点 ③ 一并裁定，不要拆开做** |

### 5.2 建议坚持不改的，以及理由

| 坚持不改 | 理由 |
|---|---|
| **信封上带 `from` / `to`**（G-3、G-4） | 没有这两个字段就没有路由，没有路由就没有产品线②。A2A 不需要它们是因为 A2A 不路由，不是因为它们不该存在 |
| **`hops` / `maxHops` / 判环键 `(处理者地址, taskId)`**（G-5、G-8 的机制本身） | AC-3 是章程判据。收敛动作是在**边界上保守累计**，不是把机制交给对端 |
| **两条时限拆分**（G-6 的机制本身） | 拆分本身解决的是 AC-2 与默认值的矛盾（`protocol.md` §5.1），与 A2A 无关。收敛动作只是把它**声明**给对端，不是取消它 |
| **`cap` 在信封上、每节点 Ed25519、规则 S-1**（G-16） | **本文最坚决的一条。**这是章程 C-5 从「约定」变成「结构性保证」的唯一支点（D-8 的原始论证）。挪到传输层就是退回 PSK 的对称世界 |
| **A 类 ack 的定义**（G-12） | AC-2 的 60 s 线全靠它成立。网关可以把我方 ack 映射成 SUBMITTED，**反向映射一律禁止** |
| **审计哈希链**（G-21 的机制本身） | A2A 是双边协议，审计是部署方的事，它不定义也不该定义。我方的链服务于 C-6 与 AC-8 的本地不可否认性 |
| **资源协商与按需隧道**（G-19、G-20） | 它们不是 A2A 的缺项，是另一个问题域。若要跨厂商，走 `AgentExtension` 发布，不改核心 |
| **不做流式、不做 webhook**（G-21、G-22） | A2A 的能力协商本来就允许声明不支持，声明清楚即合规。做了也没有落点（信箱一次写入）或没有需求（对端是常驻节点） |

### 5.3 M1 之前不该做的

- **M0 内不写任何 A2A 相关代码**（章程 N-4）。本节全部内容的前提是「M1 决定做」。
- **不要为了对齐 A2A 而改 `LIMITS`。**本文没有一条建议指向 `LIMITS` 的任何数值。
- **不要把 A2A 的错误码引进 `ProtocolErrorCode`。**两套码在两层，混进来会让 §6.4 那条「两层限流不得混写」的纪律失去参照物。

---

## 6. 最需要人来定夺的三个判断点

DoD 的「全员评审通过」要真的有内容，就得先把这三条摆到桌面上。本文对每条都给了倾向，但**倾向不是决定**。

### ① 网关是否已经越过 N-4 的线

章程 N-4 写的是「只做协议对齐评估报告与字段映射分析，**不实现完整 A2A 协议栈，不追求与任何第三方智能体真实互通**」。而 §5.1 里过半的 M1 收敛项落点是「一个双向网关包」。

- 本文立场：**M0 内一行不写**，这一点没有争议；但 P6.4 的产出如果只说「有差距」而不说「收敛落在哪」，收敛建议就是空话，DoD 的第三项交付物（M1 收敛建议）会名存实亡。
- 需要裁定的是：**把「M1 建网关」写进本文，算不算已经越过 N-4 的评估边界**？如果算，本文 §5.1 要退回到只描述差距、不指落点。
- 相关但不同的一问：即便 M1 做，**是做「完整 A2A 协议栈」还是做「一个只支持 JSON-RPC 绑定的最小网关」**？后者的工作量与前者差一个量级，而 A2A §5.1 要求同一智能体暴露的**所有**绑定功能等价——它没要求你暴露多个绑定。

### ② `taskId` 的归属

A2A 明令：taskId 由服务器生成，客户端**不得**为新任务提供（§3.4.2）。我方 `taskId` 由发送方 `createMessage` 生成，且是判环键的一半。

两条路：

- **甲（本文倾向）**：不改我方归属，在网关维护映射表。代价是跨边界任务有两个 ID，审计链要靠映射表才能串起来——而映射表本身是一个会丢的状态。
- **乙**：改我方归属为「由接收方生成 taskId 并在 ack 里回带」。代价是**判环键在第一跳之前不存在**，D-2 点名的「起始节点不自我播种」问题会以新形态回来，`NodeRouter.outbound()` 现在一次做完的三件事要拆开重做。

**这条不是撰写者能定的**，它同时牵动 D-2、AC-3 与 §5.1 的网关设计。

### ③ 多轮追问（G-15 + G-17）要不要进状态机

这是本文所有 M1 项里**唯一动到 `protocol.md` §8 骨架**的一项。引入 `INPUT_REQUIRED` / `AUTH_REQUIRED` 意味着：

- 「七个终态、穷举、无第八个」的表述要改；
- 「一条 `task.request` 对一条 `task.result`」的不变式要改；
- `taskTtlMs` 在等待人类输入期间怎么算，要重新定义（等人可以是几小时，而 `LIMITS.defaultTaskTtlMs` 的现值是分钟量级）。

而不做的代价也是实的：**这是差距清单里唯一一条会把「本可完成的任务」静默变成失败的**（G-15 的影响列）。

本文倾向：**做，但两条一起做**（G-15 与 G-17 共用同一个机制，只做一半会得到一个半截的等待态）。**若评审否决 G-15，G-17 应随之改判为「长期保留差异」。**

### 顺带请评审确认的两条

- **G-18（错误码信息泄漏）的取舍。**A2A 的 SHOULD NOT 是有道理的，但我方是受 PSK 门禁保护的封闭网络（章程 N-3），威胁模型不同：能发出这条消息的对端已经过了接入门禁。合并两个码会关掉一条枚举通道，也会让运维在真实故障时分不清「打错地址」与「没权限」。**建议由安全 owner 拍板**，本文只把它列出来。
- **§0 的取证结论要不要回写 `protocol.md` §12.3 与 `selection-m0.md` §6。**那两处都写着「A2A 线上细节未取证」，本文已经取证。按「指针不复制」铁律，正确做法是那两处改成指向本文的指针，而不是复制结论过去。**但那两份文档是他人维护的真源，本文不动它们**，列在此处等评审派活。

---

## 7. 未查证 / 开放项（如实列出，不以推断充事实）

1. **本文未与任何真实 A2A 实现对跑过一次。**全部结论基于规范原文的静态阅读。A2A 有官方 SDK 与合规测试（§12.8 提到 interoperability testing），本文**没有**运行过它们。任何「照本文做就能互通」的推论都不成立。
2. **`AgentCard.skills` 的实际填法未验证。**本文只核对了字段名与类型，没有考察真实生态里 skill 粒度怎么切，也没有考察我方现有的 `capabilities` 字符串能不能一对一映射过去。G-1 的工作量估计因此是不可靠的。
3. **A2A 扩展机制（`AgentExtension`）的实际接受度未考察。**G-6 与 G-11 的收敛路径都押在它上面。规范定义了它，但**生态里有多少客户端真的会读 `Message.extensions[]`、未知。**若实际上没人读，G-6 的「M1 收敛」应改判为「长期保留差异」。
4. **A2A v1.0 的 patch 演进节奏未考察。**本文锚定 v1.0.1；如果 M1 开工时已到 v1.1 或 v2，§3 的映射表要重做一遍，不能沿用。
5. **我方 `@qianmo/negotiation` 与 `@qianmo/tunnel` 的字段是按 P5.2 / P5.3 落地状态读的**，若 P5.4 之后有变动，§3.11 要跟着改。
6. **本文没有评估性能维度的差距。**A2A 的三种绑定在延迟/吞吐上的表现、以及我方单条 wss 长连与之相比如何，一律未测。P7.3 的基线报告出来之后可以补一节，本文不写。

---

## 8. 附：本文引用到的我方代码位置

| 概念 | 文件 |
|---|---|
| 信封 / 消息类型 / ack / task.result | `packages/protocol/src/message.ts` |
| 地址 | `packages/protocol/src/address.ts` |
| 错误码 | `packages/protocol/src/errors.ts` |
| 协议级数值上限 | `packages/protocol/src/limits.ts`（**唯一出处**，本文正文一律引用字段名不写数值） |
| 内容指纹 | `packages/protocol/src/fingerprint.ts` |
| capability 令牌形状 | `packages/protocol/src/capability.ts` |
| 资源协商四段式载荷 | `packages/protocol/src/negotiation.ts` |
| 注册记录 / 租约 / 状态 | `packages/registry/src/registry.ts` |
| 注册中心 HTTP 面 | `packages/registry/src/http.ts` |
| 判环 / 两层限流 / 入站顺序 | `packages/router/src/router.ts`、`loop.ts`、`rate.ts` |
| 授权策略 | `packages/capability/src/policy.ts` |
| 审计记录与链 | `packages/audit/src/record.ts`、`trail.ts`、`query.ts` |
| 传输帧与握手 | `packages/transport/src/frames.ts`、`handshake.ts` |
| 包装对象 / 来源标注 / blob 引用 | `packages/adapter/src/wrapper.ts`、`blob.ts` |
| 出借策略上限 | `packages/negotiation/src/policy.ts` |
| 隧道拆除语义 | `packages/tunnel/src/contracts.ts` |
