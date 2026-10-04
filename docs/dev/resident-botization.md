<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌常驻 agent「bot 化」改造设计规格

**版本** v0.1-draft · **日期** 2026-08-18
**设计输入** hermes-agent 机制研究 + 常驻线现状调研（2026-08-18）
**范围依据** 负责人 2026-08-18 指令；对应 roadmap M1「第二产品线验证 · 运维值守场景原型（连续运行 7 天）」+「记忆能力上线」+「多租户与配额雏形」三行方向
**性质** 设计件。**本文只写规格，本次入库（P13.1）未改任何仓库代码文件，只回写 roadmap / charter 的范围与任务包框架。**评审通过前，§2~§5 的技术设计细节不生效、不得据此直接开工代码批次。

---

## 0. 本文的输入、约束与核对状态

### 0.1 两份输入

本文基于两份独立的工作输入整理而成：一份是 hermes-agent 项目的常驻 / bot 化机制研究（下称"机制清单"，含 A1–A7 / B1–B10 / C1–C6 / D1–D7 / E1–E8 / F1–F9 / G 共 47+6 条机制），另一份是阡陌常驻线的现状与硬约束调研（下称"现状调研"，含八要素、H-1~H-9、G-1~G-9、T11 测试盲区）。**两份输入本身不入库、不作为本仓库文档**——本文的义务是把它们的结论**逐条复述并给出判定**（§2~§4 对齐现状调研、§3 对机制清单逐条给采纳判定），因此本文对自身论证是**自足**的：读者不需要另外找到那两份工作稿，就能核对每一条判定的理由与出处（源码文件:行号）。下表只是两份输入的名称与用途索引，供追溯：

| 输入（工作稿，不入库） | 用途 |
|---|---|
| 机制清单 §6（A1–A7 / B1–B10 / C1–C6 / D1–D7 / E1–E8 / F1–F9 / G） | 机制清单，本文 §3 逐条给采纳判定 |
| 现状调研（八要素、H-1~H-9、G-1~G-9、T11 测试盲区） | 现状与硬约束，本文 §2/§4 逐条对齐 |

### 0.2 已定的设计约束（不再议）

- **D11 协议先行**：任何新消息类型必须同步设计 `isReplyType` / 判环（H-8）/ 去重 / TTL / 回执；协议级数值上限只出现在 `LIMITS`。
- **D12 书面变更先行**：本文 §6 给 roadmap 条目全文与 charter delta 草案；**实施第一批 = 本文入 `docs/dev/` + roadmap 回写**，代码批次在其后。
- 不做真并发（H-9）、不做 mTLS（独立 M1 线，`key-distribution.md`）、不做计费（N-1 保持 `costLimit ≡ 0`）、不动信箱/传输既有不变式（A 类 ack 语义、refused 不吃配额）。
- 优先扩展点；改核心必须写「为什么扩展点不够用」（T-5 对策④）；新增包一律 `@qianmo/<domain>` workspace 形态；全部过 precheck / 循环依赖双向棘轮 / mock 卫生。

### 0.3 本轮源码核对（防调研漂移）

| 核对项 | 结论 | 出处 |
|---|---|---|
| 协议枚举 | ✅ 成立，但**是 11 种不是 10 种** | `packages/protocol/src/message.ts:13-39` |
| `isReplyType` | ✅ 7 个回复类（含协商三个），非回复类只有 4 个 | `message.ts:64-79` |
| turn-gate | ✅ 35 行 promise 尾链，无上界 / 无超时 / 无优先级 | `packages/resident/src/turn-gate.ts:4-35` |
| contextId 透传 | ✅ 零业务消费；**但它已随整条信封落进信箱 `text`**（见 §4.3） | `message.ts:217`、`packages/adapter/src/wrapper.ts:200-201` |
| hermes relay 契约 | ✅ A1–A4 成立；**契约文本自称 PRIMITIVE，行为层显式 out of scope** | `hermes-agent/docs/relay-connector-contract.md` §3.2/§3.3/§3.4 |
| H-3 回执压在 admission 之后 | ✅ 逐字成立 | `packages/transport/src/receiver.ts:107`、`outbox.ts:84` |
| wake 不产生协议 ack | ✅ 成立（`#registerTask` 只对 TaskRequest 触发） | `src/services/qianmo/resident.ts:873` |
| 「常驻等于永久 yolo」 | ❌ **不成立**，见 §0.4 与 §4.5 | `acp-client.ts:101`、`src/utils/permissions/permissions.ts:540-552` |
| `P12.x` 编号可用 | ❌ **已被占用**（mTLS 线） | `docs/dev/key-distribution.md:717-720` |

### 0.4 与输入报告不符的四处（详情见 §7.3）

1. **消息类型是 11 种**（状态报告两处写 10）。
2. **常驻不是永久 yolo，是永久 deny-unless-preapproved**：ACP 会话开的是 `permissionMode: 'dontAsk'`，基座在权限链末端把 `ask` 一律翻成 `deny`（不可被提前 return 旁路）；`requestPermission` 又硬编码回 `cancelled`。真实风险面是**预批准白名单 + 跨节点 prompt injection（T-7）**，不是「什么都放行」。
3. **hermes 的 scale-to-zero 在契约层只是原语**，「谁决定睡」「谁挂起机器」被逐字标为 out of scope；`gateway/scale_to_zero.py` 是消费这组原语的**另一层**。抄的时候必须把原语/行为两层分开抄，否则会把行为层的假设当契约。
4. **`P12.1~P12.4` 已被 `key-distribution.md` 占用**，本批次改用 `P13.x`。

---

## 1. 总体形态图（一页）

改造后的一个常驻节点长这样。**粗体是本批次新增或改形的东西。**

```
                    ┌──────────────────────────────────────────────┐
                    │  中枢 qm console （已存在，本批次长出调度）   │
                    │                                              │
                    │  名册 / 审计 / 上限 / 唤醒 / 对话（已有）     │
                    │  **@qianmo/scheduler**                       │
                    │    一次性预约表（jobId, fireAt, dedupKey）   │
                    │    崩溃安全文件存储 + CAS + 补跑塌缩         │
                    │  **notify 收件面**（订阅 + 展示 + 已读）      │
                    └───────┬──────────────────────────────▲───────┘
                            │ ① 中枢拨号并 **hold 住通道**  │
                            │    （节点仍然只监听，H-2 不动）│
                            ▼                              │
      ══════════════ 一条双向逻辑通道（跨物理断线存活）════╪══════
                            │                              │
       ② wake / task.request│                              │③ **notify**
                            │                              │  （反向复用同一通道）
┌───────────────────────────▼──────────────────────────────┴───────────────┐
│ 常驻节点进程（宿主，`src/services/qianmo/resident.ts`）                    │
│                                                                          │
│  transport server ──> router.inbound（授权/跳数/判环/预算，refused 不落盘）│
│        │                                                                 │
│        ├─ **ESTOP 哨兵检查**（文件；在途从不杀）                          │
│        ├─ #registerTask（channel.hold + taskTtl 定时器 + 前置快照）        │
│        ├─ adapter.deliver ── 写基座信箱（唯一持久副作用，排最后）          │
│        │        └──►【**回执在此返回**：durable write 之后，模型读之前】   │
│        └─ **不再 await 轮询**（H-3 解耦）                                  │
│                                                                          │
│  poller(500ms) ─> reader.poll ─> 账本 detected(fsync)                     │
│        │                          │                                      │
│        │                          ├─ **contextOf(snapshot)** ──┐         │
│        │                          │                             ▼        │
│        │                    **NodeTurnGate v2**        **SessionManager** │
│        │                     有界队列 / 超时剔除 /      (agent, contextId) │
│        │                     深度埋点 / FIFO           → sessionId + LRU  │
│        │                          │                       + idle GC       │
│        │                          ▼                                       │
│        │                    ACP 子进程 turn ──> onAccepted                 │
│        │                          │              └─ markAdmitted+markRead │
│        │                          │                 └─►【**协议 ack**：    │
│        │                          │                    仍晚于 read 翻转】 │
│        │                          ▼                                       │
│        │                    turn 完成 ─> #settleTask ─> task.result       │
│        │                                     └─ **回复投递台账**（B1）     │
│        │                                                                  │
│  **可靠性件套**：lifecycle 哨兵(B2) / 重启熔断(B3) / 不活动早失败(B10)     │
│  **MCP 扩展点**：只给 `qianmo_notify` 一个工具（E4 收窄；不给排程能力）    │
│  **记忆 sidecar**：@qianmo/recall 注入挂在用户消息，不进 system prompt(D3) │
└──────────────────────────────────────────────────────────────────────────┘
```

**这张图里最重要的一条**：③ 的 notify 走的是 ① 那条**已存在的入站通道的反方向**（`TransportChannel` 的 doc 逐字：*Application handler on either endpoint of a **bidirectional** channel*，`packages/transport/src/channel.ts:34`）。因此**节点仍然一次都不拨号**，H-2「常驻纯入站」不变式一字不动。这是本设计相对「给 resident 加 --registry / 加出站拨号」那条路线的核心取舍。

**代价（如实写）**：中枢不在线时，节点没有地方投 notify。此时 notify 落进节点侧的投递台账（B1）等通道回来再排空 —— 方向与 hermes 相反（hermes 是 relay 替睡着的 gateway 缓冲，这里是节点替缺席的中枢缓冲）。hermes 那个方向（替睡着的**节点**缓冲）在本批次**不做**，见 §3.A。

---

## 2. 协议扩展设计（本文最详的一节）

### 2.1 为什么必须先动协议

`atlas-resident-status.md` H-1 的判断成立且是硬的：`MessageType` 是一个封闭枚举，`validateMessage` 用 `isMessageType` 拒掉任何不在枚举里的 `type`。主动通知没有任何办法「借」现有类型表达——

- 借 `task.result`：它是终局回复，按 `taskId` 相关，且 `isReplyType` 为真（不进判环）。用它发主动消息等于**凭空造一个没有请求的回复**，判环表对它无保护，`isTaskResultPayload` 又是字段封闭的两分支，塞不进通知语义。
- 借 `task.request`：语义是「请你干活」，会在对端开一个 turn。中枢收到不该开 turn。
- 借 `wake`：语义是「把休眠节点叫起来」，方向是 activator→节点，反过来用是语义污染。

所以：**新增一个类型，且必须一次把 §2.2–§2.6 六件事一起定死。**

### 2.2 新类型 `notify`

```ts
// packages/protocol/src/message.ts
export enum MessageType {
  // …现有 11 个不动…
  /** Node-originated announcement. Not a reply, not a task. See protocol.md §14. */
  Notify = 'notify',
}
```

**方向**：处理方节点 → 已建立通道的对端（M1 内实际只有中枢一个消费者）。
**不做的方向**：节点 → 节点。那需要节点拨号，撞 H-2，本批次明确不做（§7.1）。

**payload（字段受控）**：

```ts
export const NOTIFY_KINDS = ['watch', 'task', 'health'] as const
export const NOTIFY_SEVERITIES = ['info', 'warn', 'error'] as const

export interface NotifyPayload {
  /** 通知的来源类别。watch=值守发现；task=某个既有任务的带外播报；health=节点自述。 */
  readonly kind: (typeof NOTIFY_KINDS)[number]
  readonly severity: (typeof NOTIFY_SEVERITIES)[number]
  /** 一行人读摘要。长度上限见 §2.5。 */
  readonly summary: string
  /** 观察发生的本地 epoch ms（不是发送时刻）。 */
  readonly observedAt: number
  /** 详情，可缺省。超长走 §9.3 既有的「落盘 + 引用」路径，不改 maxMessageBytes。 */
  readonly detail?: string
  /** 发送方幂等键。**接收方不消费它**，见 §2.4 去重。 */
  readonly dedupKey?: string
  /** 台账重投标记。诚实的 at-least-once：重投必须可见（hermes B1）。 */
  readonly redelivered?: true
  /** 由哪个中枢任务/值守作业引发。审计相关用，不是相关键。 */
  readonly causeTaskId?: string
}
```

**与既有两个封闭 payload 的一处刻意分歧**：`isAckPayload` / `isTaskResultPayload` 用的是**精确键数**（`hasExactKeys`）。`NotifyPayload` 有四个可选字段，精确键数表达不了。判定改为**白名单 + 必填子集**：

```ts
const NOTIFY_REQUIRED = ['kind', 'severity', 'summary', 'observedAt']
const NOTIFY_ALLOWED  = [...NOTIFY_REQUIRED, 'detail', 'dedupKey', 'redelivered', 'causeTaskId']
// 必填全在 + 无键在白名单之外 + 逐字段类型校验
```

这是**取舍不是疏忽**：字段封闭的目的是「远端不能夹带业务字段进来」，白名单同样做到；精确键数额外带来的「版本必须一致」在这里是负资产（见 §2.6 能力发现）。**这一条要写进 `protocol.md` 的规则表，否则将来有人会「顺手统一」回精确键数并让所有带可选字段的 notify 被判非法。**

### 2.3 `notify` 与既有 `wake` 的关系

三条线各管一件事，**不许合并**：

| | `wake` | `task.request` | `notify` |
|---|---|---|---|
| 方向 | activator / 中枢 → 节点 | 请求方 → 处理方 | **处理方 → 已连接对端** |
| 语义 | 把节点叫起来 | 请你干活 | 我有事要告诉你 |
| 开 turn？ | 会（经信箱） | 会 | **不会** |
| 进任务状态机？ | 是（文档要求 ack，实现未做，见下） | 是 | **否**（与 ping/pong 同类） |
| 判环表 | 进 | 进 | **进**（详见 §2.4） |
| 需要协议 ack？ | 文档说需要 | 需要 | **不需要** |

**顺带记一条既有的文档实现差**（本轮复核确认，不属本设计的改动）：`protocol.md:175` 写 `wake` **需要 ack**，实现里 `#registerTask` 只对 `MessageType.TaskRequest` 触发（`resident.ts:873`），所以 wake 在常驻侧不产生协议 ack。这条要么改文档要么改实现——本批次把它放进 P13.5 的 DoD（补 wake 端到端用例时一并定夺），不在本节替它下结论。**已定夺（2026-08-19，`114436d6`，P13.5）**：结论是**改文档不改实现**——`protocol.md:175` 现写 `wake`「**不产生协议 ack**，投递保证到「传输回执」为止」，与常驻侧实现一致，本段记录的那条差异因此已不存在；四条依据与对照式用例出处见 `protocol.md` §14.8.1。本段保留为当时的发现记录，不改。

### 2.4 六件必须一起定的事

#### ① `isReplyType(Notify) === false`

理由是正面的而不是「反正它不是回复」：判环键是 `(处理者地址, taskId)`，`isReplyType` 的存在是因为**回复天然复用请求的 taskId**，形状与回访重合（`message.ts:53-79` 的长注释）。`notify` **不复用任何既有 taskId**（见②），所以它不需要豁免，也不该拿豁免——拿了就等于在判环网上开一个「任何人都可以自称通知」的洞。

#### ② 每条 `notify` 带**全新** `taskId`，用 `contextId` 做归组

这是本节最容易做错的一格。两个候选：

- **(a) 复用引发它的任务的 taskId** ——❌ **必然坏**。同一个值守作业的第二条 notify 会在接收方的判环表上命中 `(中枢地址, 同一 taskId)`，被判 `E_LOOP` 切断。**这正是 H-8 描述的那个坑，且它只在第二条消息上才出现**（第一条永远是绿的），是本设计里最容易漏进生产的一条。
- **(b) 全新 taskId + `contextId` 归组** ——✅ 采用。`contextId` 是「跨任务的会话上下文」（`protocol.md:126`），一个值守作业就是一个 contextId，天然合适；判环键因此永远 fresh；`causeTaskId` 放 payload 里供审计串联，**不做相关键**（不违反 C-1）。

#### ③ 去重：**只在发送方，接收方零改动**

- 接收方两级去重（`msgId` + `fingerprint`）**一行不改**。真正的重传（at-least-once 重发同一信封）沿用同一个 `msgId`，仍被现有 `DedupTable` 挡住。
- 「同一个事实被发了两次」这类**应用层**重复，由**发送方**的投递台账按 `dedupKey` 在窗口内抑制（hermes A6 的 `dedup_key`、B1 的台账）。
- 台账驱动的**再投**（不是重传）用新信封（新 `msgId`、新 `createdAt`、同 `dedupKey`），并且**必须置 `redelivered: true`**。hermes B1 逐字：*`attempting` 重投时带可见的 recovered 标记 = 诚实的 at-least-once，绝不静默重复*。
- **为什么不让接收方按 `dedupKey` 抑制**：那要求接收方为每个 `contextId` 持有一段时间窗内的键集合，是**无界的新接收方状态**；而发送方本来就要有台账（否则 notify 会在通道断开时无痕消失）。一个机制解决两个问题，不新增第二处状态。

#### ④ TTL

- `deliverTtlMs` 默认取新常量 `LIMITS.defaultNotifyTtlMs`（§2.5）。
- `taskTtlMs`：`notify` 不进任务状态机，但信封字段是必填的。`createNotify()` **把 `taskTtlMs` 设成与 `deliverTtlMs` 相等**。理由：留成 5 min 默认值会让一条投递已过期的 notify 在状态机口径上「还活着」四分半钟，是纯误导。
- 过期后**不重传原信封**（那会被 `E_TTL_EXPIRED` 拒），走③的「新信封 + 同 dedupKey + redelivered」。

#### ⑤ 回执

- **传输回执**：走既有 `ReceiptFrame`（Accepted / Duplicate / Rejected），无改动。
- **协议 ack**：**不要求**。理由：A 类 ack 的语义被 `protocol.md` §4.3 钉死为「目标 agent 已把消息取进输入 —— `read` 翻转」。中枢不是 agent、没有信箱、没有 read 标志位。对 notify 要求 A 类 ack 是**范畴错误**，硬做只会逼出一个语义被稀释的第二种 ack，而 AC-2 的整条论证都建立在 ack 只有一种含义上。
- 因此 notify 的投递保证 = **传输回执 + 发送方台账**，写进 `protocol.md`。

#### ⑥ 限流

`notify` 走**独立**的出站预算 `LIMITS.notifyRatePerMinute`，不与 `ratePerMinute`（入站 600/min）共用。理由抄 hermes 那段写得最好的取舍（`onebot/rate_limit.py:1-19`）：**令牌桶是突发预算，滑动窗口是对房里的人的承诺**。notify 是直接送到人眼前的东西，需要的是后者——**滑动窗口硬上限**，安静一小时后不放行一整批。

### 2.5 `LIMITS` 新增三项（唯一出处铁律）

```ts
export const LIMITS = {
  // …现有五项一个不动…
  /** Default DELIVERY deadline for `notify` (2 min). */
  defaultNotifyTtlMs: 120_000,
  /** Per-node outbound `notify` ceiling, sliding window (hard promise to a human). */
  notifyRatePerMinute: 60,
  /** Upper bound of the node turn queue; a fuller queue is refused, not queued. */
  maxQueuedTurns: 32,
} as const
```

逐项理由（**每个数字都要能被问倒**）：

| 项 | 值 | 为什么是这个数 |
|---|---|---|
| `defaultNotifyTtlMs` | 120 s | 比 `defaultTtlMs`(30 s) 宽，因为对端是可能正在重启的中枢而不是一个在跑的 agent；比 `defaultTaskTtlMs`(5 min) 窄，因为一条超过两分钟没送到的通知，人再看到时已经是历史而不是告警。**再投由台账负责，所以这里不需要留得很长。** |
| `notifyRatePerMinute` | 60 | 刻意比入站 `ratePerMinute`(600) 低一个数量级：入站预算是防打击，出站预算是防**本节点自己**在无人值守下把人淹掉。1 条/秒的持续上限对「值守」这类场景绰绰有余，而任何超过它的产出都更可能是 bug 而不是真事。 |
| `maxQueuedTurns` | 32 | 节点级串行（H-9）+ 单 turn 分钟级 ⇒ 32 深的队列在最坏情况下已经排到半小时之外，远超任何发送方的 `taskTtlMs`（默认 5 min）。**再大就只是把已经注定超时的消息多存一会儿。**取 2 的幂便于位运算无关，纯粹是可读。 |

**明确不新增的**：`maxWatchesPerNode` —— 因为本设计把值守作业的状态**全部放在中枢**，节点侧零值守状态（§4.1），所以没有这个上限的对象。

**明确不改的**：`maxMessageBytes`（256 KiB）、`maxHops`、`defaultTtlMs`、`defaultTaskTtlMs`、`ratePerMinute` 一个不动。

**连带**：charter §3.3 C-4 逐字枚举了那五个数值，新增三项必须回写章程并升版本号（§6.2）。

### 2.6 新增一个错误码 `E_BUSY`，以及「加错误码不是自由的加法」

需要一个码表达「节点现在不接新活」，两个场景共用：队列满（§4.2）、ESTOP 已启（§4.5）。

```ts
/** The node is not taking new work: queue at `LIMITS.maxQueuedTurns`, or ESTOP engaged. */
E_BUSY = 'E_BUSY',
```

**但这里有一个必须写下来的兼容陷阱**：`isTaskResultPayload` 校验 `PROTOCOL_ERROR_CODES.has(payload.code)`（`message.ts:496-497`）。所以一个**旧节点**收到携带 `E_BUSY` 的 `task.result{failed}`，会判定 payload 非法并整条拒收——**它不会退化成「看不懂但收下」，它会退化成「这条结果不存在」**。因此：

> **规则 N-1（本设计新增，写进 `protocol.md`）**：新增 `ProtocolErrorCode` 只允许发给**已在能力发现里声明支持它**的对端；对未声明的对端一律降级为语义最近的既有码。`E_BUSY` 的降级目标是 `E_RATE_LIMITED`。

一个码 + 两种 `reason` 文案，而不是两个码 —— 因为**每多一个码就多一份上面这种兼容负担**，而「队列满」与「已暂停」在发送方视角的处置完全一样（等一会儿再来）。

### 2.7 能力发现：`supportedTypes`（hermes F3 的直译）

hermes F3 逐字：*连接器广播它实际实现的 op 名；缺省/空 ⇒ 假定 legacy 集；**新 op 只在被显式广播时才用***。这比 semver 协商稳，直接抄。

**落点选择：传输握手的 `ReadyFrame`，不是注册中心。**

- 注册中心的 `AgentRecord.capabilities` 是**会过期的登记**，且当前部署形态下节点根本不连注册中心（H-2，注册中心代心跳）。用它做能力发现等于用一份可能陈旧的表决定发不发一条会被拒的消息。
- 握手是**每条连接一次、当场权威**的，且这条连接就是消息要走的那条。

```ts
// packages/transport/src/frames.ts
export interface ReadyFrame {
  readonly t: FrameType.Ready
  readonly v: 1                       // ← 不动
  readonly node?: string
  /** Message types this endpoint implements. Absent/empty ⇒ LEGACY_MESSAGE_TYPES. */
  readonly supportedTypes?: readonly string[]
}
```

**必须先看的既有约束**（本轮复核 + `key-distribution.md:724` 已踩过一次）：`frames.ts:318` 是 `if (parsed['v'] !== FRAME_VERSION) return null` —— **版本不等的帧直接被丢弃**。所以「升 `FRAME_VERSION` 让两代共存」这条路走不通，迁移**只能在 v1 之内用可选字段做**。这与 mTLS 线给 `AuthFrame` 加可选 `sig` 是同一条路子、同一个文件，**两条线会在 `frames.ts` 上撞车，排期必须错开或指定合并顺序**（§5.8）。

```ts
// packages/protocol/src/message.ts
/** The 11 types every v0 node has always spoken. The floor of capability discovery. */
export const LEGACY_MESSAGE_TYPES: readonly MessageType[] = Object.freeze([...])
```

**旧节点怎么办（逐种情形）**：

| 情形 | 行为 |
|---|---|
| 对端 `supportedTypes` 缺省 / 为空 | 视为 `LEGACY_MESSAGE_TYPES`。**不发 notify**，台账记 `unsupported`，控制台显示「该节点不支持主动通知（协议版本较旧）」 |
| 对端声明了 `notify` | 正常发 |
| 我方是旧节点、收到 `notify` | `validateMessage` 返回 `E_BAD_TYPE` → 回一个 Rejected 回执。**这是确定性死亡**，发送方按 hermes B7 的负面缓存记住它（**任一次成功即清标**），不无限重试 |
| 我方是新节点、对端是旧的中枢 | 同上，退化为「没有主动通知」，其余功能不受影响 |

**明确不做静默降级**：不把发不出去的 notify 改写成 `task.request` 投给对端。那会在对端开一个它没要求的 turn，是把「能力缺失」偷换成「行为变化」。hermes F3 的 *新 op 只在被显式广播时才用* 就是这个意思。

### 2.8 `protocol.md` 增量草案要点

新增 **§14「主动通知（`notify`）」**，内容对应本节六小节；同时改动既有四处：

| 位置 | 改动 |
|---|---|
| §3.4 消息类型表 | 加 `notify` 一行；**并在「v0.1 明确不定义 `task.progress`」那段后面补一句**：`notify` 不是 progress 的复活——progress 被否决的理由是「中间语义必然触碰旧上下文、属 B 类 ack」，而 `notify` **不产生 ack、不进任务状态机、不复用 taskId**，三条都在被否决的那条之外。**这句必须写，否则下一个读者会认为 §3.4 自相矛盾。** |
| §6.1 判环 | 补一句：非回复类的新类型必须自带 fresh `taskId`，理由与举例（§2.4②） |
| §8 状态机 | 加一行：`notify` 与 `ping`/`pong` 同列，**不进任务状态机**，只有 `created → sent → delivered/expired` |
| §11 错误码表 | 加 `E_BUSY`；并新增「规则 N-1：新错误码不是自由加法」一段（§2.6） |
| §12.3 未查证项 | 新增一条：`supportedTypes` 的握手扩展与 mTLS 线的 `sig` 扩展同在 `frames.ts` v1 内，两者的合并顺序未验证 |

---

## 3. hermes 机制采纳判定表（§6 全部条目，一条不漏）

判定口径：**采纳**（本批次做，注明落在哪个包/哪个实施包）/ **改造后采纳** / **已成立·登记备查**（atlas 结构上已有，写进文档防被改坏）/ **本轮不做**（注明理由与去向）。

**总计 47 条（A7 + B10 + C6 + D7 + E8 + F9）：采纳 19、改造后采纳 12、已成立或登记备查 6、本轮不做 10。**另 G 表 6 条逐条复核仍不适用。

### A. 休眠 / 唤醒（7 条）

| # | 机制 | 判定 | 落点与理由 |
|---|---|---|---|
| A1 | buffered-flip 三帧握手 | **本轮不做** | 它解决的是「**节点**要睡了、别丢它的入站」。atlas 当前四节点里只有 beta-1 有休眠态，且休眠是被动的（不报忙→宿主停心跳→沙箱冻结），没有「节点主动宣告要睡」这一步。**先做主动性再做主动休眠**，否则会给一个还不存在的行为层写契约。去向：M1 后续包，与 R-3 的休眠半边一起 |
| A2 | ack 门控的有序重放 | **改造后采纳（半条）** | 「按序 + ack 门控 + 只重投未 ack 的尾巴」这三条**照搬进 notify 的发送方台账**（§4.4 B1）。不采纳的是它的载体（relay 的 `inbound(bufferId)` 帧）——atlas 的载体是传输层已有的 `ReceiptFrame` |
| A3 | wake poke = 无载荷无签名 GET | **本轮不做（但记为最省事的一条）** | atlas 的唤醒信道已经是 `wake` 消息 + activator，不缺一条 HTTP GET。**它真正的价值在 A1 落地那天**：那时需要一个「不带数据因而不需要鉴权」的叫醒信道。现在做等于给不存在的休眠态配唤醒器 |
| A4 | 注册 wakeUrl 是可挂起的前置条件 | **改造后采纳（写成文档硬校验，不写代码）** | 对应到 atlas 是**「一个能被冻结的节点，必须先有一条能把它叫醒的路径」**。当前 activator + keepalive 已经承担这件事。本批次把它写成 `beta-env.md` 的一条部署前置校验，不新增代码 |
| A5 | idle 判据必须由节点自己算 | **已经成立，登记备查** | atlas 的 `activity.ts` 就是节点自己上报忙闲、宿主据此开停 keepalive（`packages/activator/src/activity.ts:26-31`）。**这条 hermes 踩的坑 atlas 结构上避开了**，但要写进设计文档防止将来有人改成「宿主看有没有连接判 idle」 |
| A6 | 外部一次性预约替代常驻 ticker | **采纳（本批次的核心之一）** | `@qianmo/scheduler`，§4.1。`dedup_key = "<jobId>:<fireAtMs>"` 逐字照搬；CAS at-most-once 照搬；**「刻意没有周期性唤醒」这条尤其照搬** |
| A7 | 降级绝不失去触发器 | **改造后采纳，且有一处刻意背离** | hermes 的兜底是「回落节点内建 ticker」。atlas **不做节点内 ticker**，理由是它会让节点永远不空闲、从而永远不冻结——正是 A6 要避免的那件事。atlas 的替代兜底是三条：① 调度器自身有监督与重启；② 重启时对错过的 fire 做**补跑塌缩为一次**（hermes cron 同款）；③ 控制台显式显示「调度器缺席 N 分钟」。**这条背离必须写进设计文档，否则它看起来像漏做** |

### B. 常驻可靠性（10 条）

| # | 机制 | 判定 | 落点与理由 |
|---|---|---|---|
| B1 | 投递义务台账 | **采纳** | P13.5。两个对象：**① `task.result` 的回复台账**（现状：`#settleTask` 发出后等回执，回执不来只落 `onError`，结果**无痕丢失**——状态报告点名的唯一无痕丢失产物）；**② notify 台账**（§2.4③ 的去重与再投都挂在它上面）。四态 `pending→attempting→delivered/failed`，毒行有尝试上限 → `abandoned` |
| B2 | 终止原因取证哨兵 | **采纳** | P13.5。`occConfigPath('resident','lifecycle.json')` 记 `phase`；启动读到 `phase=running` ⇒ 上一条命被 SIGKILL/OOM 带走。**成本极低收益极高**：atlas 现在要靠人关联四份日志才能回答「为什么挂了」 |
| B3 | 重启风暴熔断 | **采纳，且这里有一个真实缺口** | P13.5。现状 supervisor 有 `maxRapidFailures=5 → park`，但**缺少 hermes 那一半**：`reader.#recover` 会重放 `detected` 账本记录，**如果正是那条记录把节点搞崩，就是一个无限崩溃循环**（今天没有任何计数器阻止它）。补：同一 `messageId` 连续 3 次重启后标 `abandoned` 并把该 task 结算为 failed，**节点照常服务新消息**；读写失败 **fail-open** |
| B4 | 崩溃恢复 = 合成事件重跑 | **已经成立，只补一处** | atlas 的三相账本（detected→admitted→read）+ `qianmo/input-status` 判上一代是否进模型，已经比 hermes 的「120 s 活跃窗口」更精确。**唯一要补的是 hermes 那个容易漏的细节**：「启动期先排队真实 inbound 直到恢复完成」——现状 `#poll` 是先处理 pending 且 pending 非空时直接 return（`reader.ts:88-96`），行为上已等价，**写进 README 的不变式表防止被改坏** |
| B5 | 外部控制只用文件标记 + epoch | **改造后采纳（只取 epoch）** | atlas 有真控制面（`qm console` + 传输层），不需要 hermes 那条「没有外部控制通道」的将就。**但 epoch 这一招要抄**：ESTOP 哨兵、drain 标记这类「持久化的临时状态」必须能被一次重启清掉（hermes NS-570：孤儿标记让实例拒服 52 分钟）。落点：ESTOP 文件带 `engagedAt`，节点启动时**不**自动清（暂停就该跨重启有效），但 drain 类标记必须盖实例 epoch。**两者的区别要写清楚** |
| B6 | 全局急停哨兵 ESTOP | **采纳** | P13.5。`occConfigPath('resident','ESTOP')`。三个检查点：poller 每次 poll 前、scheduler 每次 fire 前、`#receive` 的 router 之后信箱写入之前（→ `E_BUSY`，refused 不吃配额，L-1 成立）。**在途从不杀**（pause-new-work）。**空/损坏文件仍算 engaged（fail safe）** |
| B7 | 死目标自愈注册表 | **改造后采纳（缩到一处）** | 只用于 §2.7 的能力发现：对端回 `E_BAD_TYPE` ⇒ 记「该对端不支持 notify」；**任一次成功即清标**；只记这一种确定性死亡；文件损坏降级为内存态 |
| B8 | 观察契约与策略分离 | **采纳（作为规范约束）** | `ResidentTimingRecorder` 已经是这个形状（`timings.ts:49-53`：记录失败被吞，「Timing is evidence, not part of admission or execution semantics」）。本批次新增的 `queued` 阶段与 lifecycle 采样**必须遵守同一条**：观察永不改变行为。写进 P13.3/P13.5 的 DoD |
| B9 | 观察者钩子 fail-open + schema 版本戳 | **改造后采纳** | `@qianmo/audit` 已是 append-only + 哈希链。要补的是 **schema 版本戳**：新增的 notify / queued / lifecycle 三类事件进审计链时带 `schemaVersion`，否则三天后读链的人无法判断一条记录缺字段是「旧版本」还是「被篡改」 |
| B10 | 不活动超时而非墙钟超时 | **改造后采纳，方向相反** | hermes 用不活动超时**替代**墙钟超时以免误杀长任务。atlas 的墙钟是 `taskTtlMs`，**它属于发送方**（协议字段），节点无权延长。所以 atlas 的不活动超时是**更早失败**而不是更晚：turn 在 `inactivityMs` 内既无 `session/update` 也无 `first_content` ⇒ 提前结算为 failed 并在 `reason` 里说明是不活动，让发送方可以带更长的 `taskTtlMs` 重试。**长任务的正解是中枢给值守作业设更长的 `taskTtlMs`，不是节点偷偷续命** |

### C. 收件、队列与隔离（6 条）

| # | 机制 | 判定 | 落点与理由 |
|---|---|---|---|
| C1 | 会话键单一真源 + 回退 | **采纳** | P13.4。`sessionKeyOf(agent, contextId)` 是唯一构造点；**`contextId` 缺省时回退到一个显式的 `DEFAULT_CONTEXT` 常量**——hermes 那条「无 chat_id 时若不回退，所有此类会话塌缩成一个 = 跨用户历史串味」在 atlas 是逐字成立的：不回退就是所有无 contextId 的远端请求者共用一条上下文，也就是今天的状态 |
| C2 | Turn lease：按事务归属方加锁 | **改造后采纳（判据成立，形态不同）** | hermes 的 bug 是「守卫按 routing key、transcript 归 session_id，二者多对一」。atlas 做完 P13.4 后**会出现同一个形状**：门是节点级（一个 `#gate`），而 transcript 归 `sessionId`，多对一。**现在的节点级串行意外地免疫了这个 bug**——但队列治理（P13.3）一旦加了任何形式的并行或重排，它立刻成立。**处置：P13.3 的 DoD 里写死一条反向断言——同一 `sessionId` 的两个 turn 永不重叠，且这条断言不依赖「门是全局的」这个事实** |
| C3 | 单槽位合并 + 溢出 FIFO 的二元排队 | **本轮不做（合并那半）** | atlas 的 `selectResidentSnapshot` 已经有一套合并语义（非网络消息批量成一个 snapshot，网络消息一条一个 snapshot，`resident.ts:171-181`）。再叠一层「突发折叠」会与它打架。**FIFO 那半本来就是现状。**记为遗留：突发折叠在 M1 值守场景里没有对象（值守是定时的不是突发的） |
| C4 | 审批类命令必须内联派发 | **登记为反例，本轮无对象** | atlas 的常驻 `requestPermission` 直接回 `cancelled`（`acp-client.ts:47-51`），**没有任何阻塞等待**，所以不存在「排队导致死锁」。**但这条要留在文档里**：M1 的「权限模型上线」一旦让 `requestPermission` 真的去等一个人，C4 立刻成立，且那时门里已经有队列了 |
| C5 | 内存压力驱逐 + 三类永不驱逐 | **改造后采纳（只取豁免清单）** | 不做 cgroup 推导（见 C6）。**取的是三类豁免**，用在 P13.4 的会话 GC 上：① 有在途 task 的会话永不驱逐；② 最近 N 个永不驱逐（前缀缓存最值钱）；③ **账本里还有 pending 记录的会话永不驱逐**（对应 hermes 的「transcript 未落盘完的」）。第③条是 atlas 特有且最容易漏的 |
| C6 | `auto` 预算在小机器上算错是常态 | **采纳（作为纪律，不作为代码）** | 用户实测 `memory_high_mb: auto` 在 1.9 GB 机上算出 1278 MB。atlas 的四节点里三台是无 sudo 小 VPS。**纪律：本批次不引入任何 `auto` 推导的数值；会话上限、队列上限全是显式常量**（`LIMITS.maxQueuedTurns` 就是这条的产物） |

### D. Prompt 与上下文（7 条）

| # | 机制 | 判定 | 落点与理由 |
|---|---|---|---|
| D1 | stable / context / volatile 三层排序 | **本轮不做** | 这是基座 system prompt 的组织方式，改它属于改基座核心，且与本批次目标（值守/队列/多会话/记忆/安全）无一条相交。去向：如果将来 P13.7 的记忆注入被证明击穿了前缀缓存，再回来看 |
| D2 | 时间戳只到天 | **本轮不做（但值得单独提一个一行 PR）** | 改动量一行、收益是每次 compaction/resume 不白丢缓存。**但它在基座核心里**，与本批次无依赖，混进来只会让这批 PR 多一处上游冲突面。单独提，不进本批次 |
| D3 | 动态内容的唯一缓存安全通道 = 用户消息 sidecar | **采纳（记忆接线的落点，本批次指定）** | P13.7。`@qianmo/recall` 的注入**挂在当轮用户消息上，不进 system prompt**。这是任务书点名的锚点④，也是 hermes 全仓唯一被标为「缓存安全」的动态注入通道 |
| D4 | ephemeral system prompt 排除在缓存之外 | **本轮不做** | atlas 没有等价通道，造一个属于改基座核心。D3 已经覆盖了本批次的需求 |
| D5 | 记忆注入是冻结快照 | **采纳** | P13.7。`@qianmo/recall` 的 `recall→rank→inject` 在**一轮开始时取一次**，本轮内后续写入不影响本轮注入。**要写成注释解释原因**（hermes `memory_tool.py:686-688` 的写法值得照抄语气） |
| D6 | compaction 的诚实代价说明 | **采纳（作为文档规范）** | 本文自身遵守：§4.2 的回执解耦、§1 的中枢缺席代价、A7 的刻意背离，都是「给出取舍而不是只给开关」 |
| D7 | 压缩失败软退出而非记成耗尽 | **本轮不做** | 需要跨进程压缩锁才有对象，atlas 单节点内并发度为 1。去向：H-9 真并发那条线 |

### E. 工具、审批与安全（8 条）

| # | 机制 | 判定 | 落点与理由 |
|---|---|---|---|
| E1 | 审批等待时间从工具 deadline 中扣除 | **本轮无对象，登记** | atlas 常驻不等人（`requestPermission → cancelled`）。与 C4 同批：M1「权限模型上线」那天必须一起做，否则「人去泡了杯咖啡 = 工具超时」 |
| E2 | Hardline 黑名单在所有旁路之前 | **改造后采纳，但前提被修正** | 任务书写的「常驻等于永久 yolo」**不成立**（§0.4②）：`dontAsk` 在权限链末端把 `ask` 翻成 `deny`，且**刻意放在最后以免被提前 return 旁路**（`permissions.ts:540-542` 的注释逐字）。所以 atlas 缺的不是「yolo 的刹车」，而是 **「预批准白名单没有天花板」**：一条 `settings.json` 的 allow 规则今天可以放行任何东西。落点（P13.7）：一份**常驻专属的 hardline 拒绝表，求值在 allow 规则之前**，且它**不从会话配置读取**（写死在 `@qianmo/*` 里）。至少含：写 `settings.json` / 节点身份文件 / PSK 文件 / 审计链文件 / `admission.ndjson`（= hermes E3 的 atlas 版） |
| E3 | 配置文件本身就是安全策略，双面封堵 | **采纳** | 同上。**双面**是关键：file 工具与 shell 两侧同时封堵，否则是「unpaired theater」。atlas 的对象清单见 E2 |
| E4 | cron 上下文的工具面必须收窄 | **采纳（本批次的一条硬设计）** | P13.6/P13.7。定时派生的 turn **拿不到排程能力**——`@qianmo/scheduler` 全部状态在中枢，节点侧连排程 API 都不存在，所以这条是**结构上成立而不是靠配置**。给出去的 MCP 工具面只有一个 `qianmo_notify`。hermes 的话：「无人值守的轮次不能自己造更多无人值守的轮次」 |
| E5 | 对组装后的完整 prompt 做注入扫描 | **改造后采纳** | 对象是 `formatPrompt(snapshot)` 的**产物**（含远端 `text` 与 §9.4 的来源标注），不是入参。这正是 charter T-7 的判定面，且 T-7 已写死「不以模型是否被说服验收」。落点 P13.7 |
| E6 | 溢出落盘而非截断 | **已经成立** | `packages/adapter/src/blob.ts` + `protocol.md` §9.3 的「大 payload 落盘、`text` 只放引用」就是这条。登记备查 |
| E7 | 不可信工具输出包裹 + 分隔符中和 | **采纳** | 现状 `wrapper.ts` 已把远端信封**结构上**嵌在 `envelope` 之下（M-2），并在顶层放 `notice` 标签（§9.4）。缺的是 **分隔符中和**：远端 `text` 里的围栏 / CDATA / 伪标签今天原样进模型。落点 P13.7 |
| E8 | 插件覆盖内置工具需双重同意 | **本轮不做，登记** | 对象是「`@qianmo/*` 的 MCP 工具与基座工具重名」。本批次只加一个 `qianmo_notify`，前缀天然不撞。**规则写进文档**：`@qianmo/*` 提供的工具一律 `qianmo_` 前缀，撞名即失败而不是覆盖 |

### F. 扩展性与网络形态（9 条）

| # | 机制 | 判定 | 落点与理由 |
|---|---|---|---|
| F1 | 注册表的每个可选字段替换掉一处核心修改 | **采纳（作为文档规范）** | 这是把 CLAUDE.md §2.3「优先走扩展点」落成**可验证形式**的方法：扩展点文档里直接写「本字段替代了哪处核心改动」。落点：`base-modifications.md` 的新增行按此格式写 |
| F2 | 探测必须无副作用 | **采纳（作为规范）** | 本批次唯一的探测是 §2.7 的能力发现，它读握手帧、零副作用。写进 DoD 防回潮 |
| F3 | 能力发现用 `supported_ops` 而非版本号 | **采纳（§2.7 直译）** | 核心机制之一。逐条对应见 §2.7 |
| F4 | 加性扩展走 `_meta.<vendor>` 命名空间 | **已经成立** | `acp-client.ts:92,100-103` 已在用 `_meta: { qianmo: {...} }`。P13.4 的多会话如需给 ACP 传 contextId，**必须继续走这里** |
| F5 | 信任边界单点化 + 测试守护 | **改造后采纳（只取「有测试守护」那半）** | atlas 节点必然持有仓库凭据，做不到「节点持有零密钥」。**可以做且必须做的是**：哪些密钥只在中枢（调度器凭据、控制台 token）、哪些必须下发到节点（PSK、节点私钥），写成清单**并加一条扫描断言**（中枢侧凭据的字面量/路径不得出现在节点侧代码里）。这正是 `key-distribution.md` P12.1 已经在做的形状，照抄 |
| F6 | 链路鉴权与业务鉴权分离 + 4401 latch | **本轮不做（属 mTLS 线）** | `key-distribution.md` P12.3 已经在处理握手与鉴权。**只留一条交叉提醒**：那条线用 4003 表示证书到期主动断连，本设计不引入新的 close code |
| F7 | 单派发者姿态 + 原子事件认领 | **采纳（缩小版）** | `@qianmo/scheduler` 的 CAS at-most-once 就是这条（§4.1）。M1 只有一个中枢，但**存储层的 CAS 现在就要有**，否则「起了第二个 console」这件事会以重复派发的形式出现，而那是运维随手会做的事 |
| F8 | 插件数据目录 ≠ 插件安装目录 | **采纳（作为纪律）** | `@qianmo/*` 的运行期状态一律在 `occConfigPath(...)` 下，不在包目录里。现状已成立（`resident/sessions.json`、`resident/<agent>/admission.ndjson`），新增的 scheduler / 台账 / lifecycle / ESTOP 同此 |
| F9 | 记忆插件发现优先级刻意反转为「内置优先」 | **本轮不做，登记为一条待答的问题** | atlas 的 `@qianmo/memory` 是按路径解析的存储（`defaultMemoryRoot`）。**要问一遍 hermes 问的那个问题：把一个目录丢进工作树能不能悄悄劫持这个节点的记忆？** P13.7 的 DoD 里写一条负向用例回答它 |

### G. 明确不适用的（6 条，逐条确认仍不适用）

| 机制 | 复核结论 |
|---|---|
| A2A 靠提示词 + shell 命令 | **仍不适用**，且本设计**正面回答了它提出的那个诘问**（「如果传输层最终只被用来转发一段文本、跑一轮、回一段文本，它相对 `POST /chat` 的增量是什么」）：增量是**判环 + 跳数 + 双时限 + 指纹去重 + 能力发现**，其中前四项 A2A 与 hermes 都没有，而本批次的 notify **正是靠它们才能安全地长出来**——§2.4② 的「复用 taskId 会在第二条消息被判环切断」在一个没有判环的系统里根本不会被讨论到 |
| `peer dm` 的 600 s 同步阻塞 | **仍不适用**。atlas 的 `sendAndWait` 5 s 默认 + `task.result` 异步回程本来就是 runs 面形态 |
| cron 的「无失败退避」 | **仍不适用**。值守作业有真实副作用，`@qianmo/scheduler` 必须有失败退避（§4.1） |
| holographic HRR/FTS5 语义存储 | **仍不适用**（N-8）。**但半衰期公式 `0.5^(age_days/half_life)` 与「decay 只乘在检索分上、不进 system prompt」的位置选择**——后者 atlas 的 `@qianmo/recall` 的 `recencyFactor` 已经是这个位置；前者可在 M1 解禁语义检索时对照 |
| `trajectory_compressor.py` | 仍不适用 |
| `qzone_tool.py` 路线 / `acp_registry/` | 仍不适用 |

---

## 4. 四条目标锚点的落地设计

### 4.1 锚点① 值守场景原型（M1 出口：至少 1 个真实值守场景连续运行 7 天）

**形态**：定时**完全反转**到中枢，节点侧零值守状态。

```
@qianmo/scheduler （新包，跑在 qm console 进程内）
├── job.ts      作业定义：{ id, title, target(qianmo://…), prompt, schedule, taskTtlMs, notifyPolicy }
├── store.ts    崩溃安全文件存储 + **CAS**（F7；防第二个 console 重复派发）
├── reserve.ts  一次性预约：只算下一次 fireAt，跑完再算下一次（A6；**没有周期性唤醒**）
├── fire.ts     到点 → 拨号目标节点 → 发 task.request（带作业的 taskTtlMs、contextId=jobId）
└── backoff.ts  失败退避（对 hermes cron「无失败退避」的刻意背离，G 表第三行）
```

关键设计点，逐条：

1. **`dedupKey = "<jobId>:<fireAtMs>"`**（A6 逐字）。重复预约幂等。
2. **补跑塌缩为一次**，grace = 周期的一半，clamp `[120s, 7200s]`（hermes 数值直接采用，理由相同：避免中枢重启时雪崩）。
3. **`contextId = jobId`**：一个值守作业 = 一条 `contextId` = 节点侧一个独立 ACP 会话（§4.3）。**这条把锚点①和锚点③在设计上焊死**——值守作业的上下文不会与人工对话互相污染，7 天连续运行也就不会把一条会话撑爆。
4. **`taskTtlMs` 由作业指定**，不用默认 5 min。这是 B10 的正解：长任务靠发送方给更长的截止时间，不靠节点偷偷续命。
5. **产出默认静默**。turn 跑完回 `task.result` 给调度器（进审计链、进控制台的作业历史）；**只有 agent 显式调用 `qianmo_notify` 工具，人才会被打扰**。这是 hermes `[SILENT]` 哨兵的正向版本——默认不打扰，而不是默认打扰再靠哨兵抑制。
6. **调度器缺席是可见的**：控制台显示 `调度器最后一次 tick: N 分钟前`。这是 A7 背离后的补偿（节点没有内建 ticker 兜底，所以缺席必须刺眼）。

**为什么不放在节点里**：节点会被冻结；一个 60 s ticker 会让节点永不空闲、永不冻结，直接抵消 R-3 的休眠形态。hermes 的 Chronos 契约里逐字写了同一条（*刻意没有周期性唤醒 —— 那会抵消 scale-to-zero*）。

**7 天连续运行的判据配套**（写进 P13.6 DoD）：lifecycle 哨兵（B2）在 7 天内无 `phase=running` 的孤儿记录；调度器 fire 台账 `delivered / abandoned` 计数与作业周期对得上；notify 台账无 `pending` 超过一个 TTL 窗口的条目。

### 4.2 锚点② 队列治理与回执解耦（H-3 正面解决）

#### (a) 队列治理：`NodeTurnGate` v2

现状（35 行，`turn-gate.ts`）是 promise 尾链：`#queued` 只加减不检查，没有队列对象可供检查，因而**上界、超时剔除、优先级、深度埋点四件事一件都做不了**。改成显式队列：

```ts
interface QueuedTurn {
  readonly work: () => Promise<unknown>
  /** 该 turn 对应信封的任务截止（epoch ms）；无对应信封时为 Infinity。 */
  readonly deadlineAt: number
  readonly enqueuedAt: number
  readonly sessionId: string        // C2 的反向断言要它
}
```

- **上界**：`LIMITS.maxQueuedTurns`。满时**不入队**，向上抛一个可被 `#receive` 识别的拒绝 → 回 `E_BUSY`（未声明支持则降级 `E_RATE_LIMITED`，§2.6）。**拒绝发生在信箱写入之前**，因此 refused 不吃收件箱配额（L-1 成立，与现有 `#receive` 里 router 拒绝的位置一致）。
- **超时剔除**：出队时先比 `deadlineAt`，已过期的**直接丢弃不执行**。现状是「信封 timeout 到期发了 `E_TASK_TIMEOUT`，但门内的 work 仍然会跑」——即节点会为一个已经宣告失败的任务烧一个完整 turn。这是本批次能拿到的最大一笔实打实的资源回收。
- **优先级**：**不做**。FIFO。理由：值守作业与人工请求的相对优先级是产品判断，M1 没有判据要求它，加了就得维护一张会长歪的表。
- **深度埋点**：`ResidentTimingStage` 增加 `'queued'`（入队时刻）；`'dequeued'` 不单设——`admitted` 已经标记了开始执行。同时 `ResidentTimingEvent` 增加可选 `queueDepth`。**观察不改变行为**（B8）。
- **C2 的反向断言**（P13.3 DoD 硬要求）：同一 `sessionId` 的两个 turn 永不重叠，且该断言**不得写成「因为门是全局的所以不会」**——要写成一条独立于门粒度的不变式检查，这样将来门变细时它会红。

#### (b) 回执解耦：动的是传输回执，不是协议 ack

这是本节必须论证清楚的一格。

**现状链路**（`receiver.ts:107` → `#receive` → `deliver` → `runtime.deliver` → `reader.poll()` → `#submit` → `await admission`）：`admission` 只在 turn 真的跑到 `onAccepted` 时才 resolve。所以**排队 = 传输回执迟迟不回 = 发送方 `sendAndWait` 5 s 超时**。

**改动**：`#receive` 只 await 到 **`adapter.deliver`（写基座信箱）** 为止，**不再 await `runtime.deliver`（轮询）**。轮询照旧被 500 ms poller 拉起。

```
改前：validate → dedup → router → registerTask → adapter.deliver(写信箱) → poll → 排队 → turn → onAccepted →→→ 回执
改后：validate → dedup → router → registerTask → adapter.deliver(写信箱) →→→ 回执
                                                                          ↘ poll（不 await）→ 排队 → turn → onAccepted → **协议 ack**
```

**与 AC-2「ack 晚于 durable read」的相容性论证**（四条，缺一不可）：

1. **两者是不同的东西。** AC-2 约束的是**协议 `ack`**（`createAck`，由 `#ackTask` 在 `onRead` 回调里发出）。本改动动的是**传输层 `ReceiptFrame`**，它是链路层「我收到这个信封且不会丢」的确认。协议 ack 的发出点**一行未动**，仍然严格晚于 `mailbox.markRead` 成功翻转。
2. **回执提早到的那个点仍然是持久点。** `adapter.deliver` 的信箱写入是这条路径上**唯一的持久副作用且被刻意排在最后**（现有注释就这么写的）。回执因此仍然只在「这条消息已经落到磁盘」之后返回，而不是「我看到它了」。
3. **H-6 的驱逐问题不受影响。** 基座信箱的配额执行方式是**丢消息（未读也丢）**，正是这一点让「写完即回 **ack**」不成立（`protocol.md` §4.5 逐字）。本改动**没有**让 ack 写完即回——ack 仍等 read 翻转。它只是让**链路回执**不再替 ack 背书。**如果一条消息被驱逐了，发送方会看到「传输回执到了、ack 永远不来」，然后在 `deliverTtlMs` 上判 `expired`** —— 这与 §4.5 的三种观察结果表格**完全一致**，没有引入第四种。
4. **失败上报路径不缺。** 现状 `receiver.ts:108-123` 用回执的 `Rejected` 状态把 handler 抛错报回发送方。解耦后，发生在信箱写入之后的失败（账本完整性、turn 失败）不再能进回执 —— 但它们**本来就有更好的通道**：`#settleTask` 的 `task.result{failed}` / `errorReply`，且那条通道携带 `ProtocolErrorCode` 而回执只携带一个截断的 reason。**净变化是失败信息变多不是变少。**

**一处必须保留的同步检查**：`runtime.deliver` 现在会校验「消息是发给本节点的、且该 agent 已配置」（`runtime.ts:107-115`）。这个校验**必须移到信箱写入之前并保持同步**，否则一条投给未配置 agent 的消息会先落盘再被丢。设计上拆出 `runtime.assertDeliverable(message)`，`#receive` 在 `adapter.deliver` 之前调用它，`E_UNKNOWN_AGENT` 照旧。

**这条改动的代价（如实写）**：发送方 5 s 内拿到的回执，从此**只保证「已落盘」不保证「已排上队」**。一个 32 深队列的节点会连续回 Accepted 然后在几分钟后回一批 `E_TASK_TIMEOUT`。**这不是退步（今天是超时，也就是既拿不到回执也拿不到结果），但它是行为变化，必须写进 `protocol.md` §4 与控制台文案。**

### 4.3 锚点③ 多会话隔离 `(agent, contextId) → sessionId`

**一个让这件事比预想简单得多的事实**（本轮核对发现）：`contextId` **不需要另外传** —— `packages/adapter/src/wrapper.ts` 把**整条信封**序列化进基座信箱条目的 `text`（嵌在 `envelope` 之下），而 `resident.ts:150-169` 的 `networkEnvelope()` 已经在把它解回来取 `msgId`。所以：

```ts
// src/services/qianmo/resident.ts —— 与 networkMessageId 并列的一个新提取器
function networkContextId(messages: readonly ResidentMailboxMessage[]): string | undefined {
  if (messages.length !== 1) return undefined
  const ctx = networkEnvelope(messages[0])?.contextId
  return typeof ctx === 'string' && ctx.length > 0 ? ctx : undefined
}
```

**协议零改动、适配器零改动、基座零改动。**

**第二个有利事实**：`selectResidentSnapshot`（`resident.ts:171-181`）**已经保证一个 snapshot 里最多一条网络消息**（网络消息一条一个 snapshot）。因此一个 snapshot **不可能横跨两个 contextId**，不需要做「按 contextId 切分 snapshot」这件容易做错的事。

**改动清单**：

| 位置 | 改动 |
|---|---|
| `sessions.ts` | `#sessions: Map<string,string>` 的键从 `agent` 改为 `sessionKeyOf(agent, contextId)`；`start()` 只为每个 agent 建 `DEFAULT_CONTEXT` 会话；其余 **懒建**（首次见到新 contextId 时 `newSession`） |
| `session-store.ts` | 值从 `sessionId` 改为 `{ sessionId, createdAt, lastUsedAt }`；原子写与损坏 fail-closed 不动 |
| `reader.ts` | `readonly sessionId: string` → `resolveSession: (snapshot) => Promise<string>`；`DetectedAdmissionRecord.sessionId` **照旧记录解析后的具体值**，所以崩溃恢复一行不改 |
| `runtime.ts` | reader 构造时注入 resolver |

**会话 GC（把 G-5/G-6 从「将来」变「立刻」）**：

- **上限**：每 agent `maxSessionsPerAgent`（显式常量，不 auto 推导，C6）。超限按 LRU 驱逐。
- **空闲 TTL**：`sessionIdleTtlMs`，到期驱逐。
- **三类永不驱逐**（C5 的 atlas 版）：① 有在途 task 的；② 最近 N 个（前缀缓存最值钱）；③ **账本里还有 pending 记录的**。
- **驱逐 = 从映射表删除 + 不再 resume**，**不删 ACP 侧会话数据**（那是基座的东西，且 `--resume` 还要用）。
- **G-6（单文件上界越线静默截断）**：`session-store.ts` 写入前检查条目数，超过 `maxStoredSessions` 时**先驱逐再写**，**绝不静默截断**；写入失败 fail-closed（现状即如此）。
- **G-9（`--resume` 时间戳并列丢尾部）**：多会话会**放大**这个问题（每个 context 每次唤醒都 resume 一次）。P13.4 的 DoD 里必须有一条：N 个会话连续 resume M 轮后，条目数与预期一致。

**要点**：`(agent, contextId)` 的键构造必须**只有一处**（C1）。写成 `sessionKeyOf()` 导出并加一条测试断言「全仓只有这一处拼接」。

### 4.4 锚点④ 记忆接线

**目标**：`@qianmo/memory` / `@qianmo/recall`（今天全仓零 import）接进常驻链路。

**注入位置（本设计指定，不可改）**：hermes D3 的**用户消息 sidecar** —— 也就是 `formatPrompt(snapshot)` 的产物里，**紧贴当轮内容**，**不进 system prompt**。

```
formatPrompt(snapshot) =
    [基座 formatTeammateMessages 的既有产物]
  + "\n\n" + renderInjection(selectForInjection(rankEntries(recall(scope))))   ← 新增
```

理由三条：① 这是 hermes 全仓唯一被标为缓存安全的动态注入通道；② 它落在缓存前缀**之后**，因此每轮变化不击穿前缀缓存；③ atlas 若把它放进 system prompt，等于每轮重建 system prompt，代价是每轮全部前缀缓存作废——在 7 天连续运行的值守场景里这是纯亏损。

**冻结快照（D5）**：一轮开始时 `recall` 取一次，本轮内后续写入不影响本轮注入。**要写成注释解释原因**，否则将来有人会「优化」成实时读。

**作用域**：`recall` 的 scope 用 `(agent, contextId)` —— 与 §4.3 的会话键同源。这样值守作业的记忆与人工对话的记忆天然分区。

**尊重 AC-4 与 N-8**：
- AC-4 判据（命中 5/5、伪造决策不产生幻觉引用）由 `@qianmo/recall` 既有的 `verifyCitations` 承担，**本批次不碰它的判据**。
- N-8（不上向量检索）**保持**。M1「记忆能力上线」里的语义检索**明确标注为后续包**，不在本批次（§7.1）。
- `INJECTION_BUDGET` 的「小规模全量注入」形态不动。**但要新增一条 DoD**：注入预算 + 队列深度 + 工具 schema 三者叠加后的 token 估算，不得把值守 turn 推进 auto-compact（hermes 那条「50+ 工具多出 20–30k token」的教训）。

### 4.5 锚点⑤ 无人值守安全

**先修正前提**（§0.4②）：常驻**不是**永久 yolo。

- `newSession` 传 `permissionMode: 'dontAsk'`（`acp-client.ts:101`）。
- 基座 `dontAsk` 的语义是 **「不提示、未预批准即拒绝」**（`coreSchemas.ts:354` 逐字：*Don't prompt for permissions, deny if not pre-approved*），且这个转换**刻意放在权限链末端**以免被提前 return 旁路（`permissions.ts:540-542`）。
- `requestPermission` 又被硬编码回 `cancelled`（`acp-client.ts:47-51`）。

所以真实风险面是三条，逐条给落点：

| 风险 | hermes 对应 | atlas 落点（均在 P13.7） |
|---|---|---|
| **预批准白名单没有天花板**：一条 `settings.json` 的 allow 规则今天可以放行任意东西，包括改 `settings.json` 自己 | E2 + E3 | **常驻专属 hardline 拒绝表，求值在 allow 之前，且不从会话配置读取**（写死在 `@qianmo/*`）。对象至少含：`settings.json`、节点身份文件、PSK、审计链、`admission.ndjson`、`sessions.json`。**file 工具与 shell 双面封堵**，否则是 unpaired theater |
| **跨节点内容构成 prompt injection**（charter T-7 已登记，OWASP ASI06） | E5 + E7 | ① **对组装后的完整 prompt 扫描**（不是对入参）；② **远端 `text` 的分隔符中和**（围栏 / CDATA / 伪标签），现状 `wrapper.ts` 只做了结构隔离没做内容中和；③ 判定基准沿用 T-7 已写死的「不以模型是否被说服验收」 |
| **无人值守的轮次自己造更多无人值守的轮次** | E4 | **结构上不可能**：排程状态全在中枢，节点侧不存在排程 API。给 ACP 子进程的 MCP 工具面**只有 `qianmo_notify` 一个**（经 `newSession({ mcpServers })` 注入 —— 这是扩展点，基座零改动） |

**`qianmo_notify` 工具的接入形态**：`newSession` 现在传 `mcpServers: []`（`acp-client.ts:99`）。改为传一个由常驻宿主自己起的 loopback MCP server。**这是走扩展点而不是改核心**——基座的 `createSessionMethod` 本来就接 `params.mcpServers`（`createSessionMethod.ts:289`）。

> **勘误（P13.6 实作时坐实，2026-08-19）**：上句前提不成立——`createSessionMethod` 的 `params.mcpServers` 只进 `computeSessionFingerprint`（`createSessionMethod.ts:289`），交给查询引擎的是写死的 `mcpClients: []`（同文件 :181），该参数从未产出过工具；且真接 MCP 客户端栈会把工具名变成 `mcp__<server>__…`，与 §E8 的 `qianmo_` 前缀规则冲突。实作改为 `isQianmoResident` 门控下的直接 Tool 注入（一处受控核心改动，非常驻会话工具表逐字不变，有结构断言护着）。E4 的结构性结论不受影响。

> **实现选项待 P13.6 首日定**：loopback HTTP MCP（一个进程、多会话共用）vs stdio 子进程（每会话一个进程）。默认取前者，理由是后者会让每个 context 多一个进程，而 §4.3 刚把会话数从 8 放开到「每 agent 若干」。

---

## 5. 实施包切分

七个包。**第一包必须是文档与范围回写。**每包给：目标 / 改动文件 / 新增测试 / 可机检 DoD / 门禁 / 风险 / 依赖。

> **编号说明**：`P12.1~P12.4` 已被 `docs/dev/key-distribution.md:717-720` 占用（mTLS 落地线）。本批次让号，用 **`P13.x`**。若负责人把两条线排进同一迭代，本批次仍用 P13.x —— 编号不复用是台账可查的前提。

### 依赖顺序

```
P13.1 文档与范围回写（阻塞全部）
  ├─> P13.2 协议扩展 ────┬─> P13.6 定时反转与 notify 接线
  ├─> P13.3 队列治理 ────┤     （还需 P13.5 的台账）
  ├─> P13.4 多会话隔离 ──┼─> P13.7 记忆接线与安全收窄
  └─> P13.5 可靠性件套 ──┘
```

P13.3 / P13.4 / P13.5 三包**可并行派发**（互不改同一文件的同一区域：P13.3 动 `turn-gate.ts` + `#receive`；P13.4 动 `sessions.ts`/`session-store.ts`/`reader.ts` 的 session 参数；P13.5 新增文件为主）。**P13.3 与 P13.4 都碰 `reader.ts`，合并时以 P13.4 先落为准**（它改的是构造参数签名）。

---

### P13.1 设计定稿与范围回写（**第一包，必做**）

- **目标**：把本文变成仓库内的设计件，并把范围变更写进 roadmap / charter。**代码批次在此之后。**
- **改动文件**：
  - 新增 `docs/dev/resident-botization.md`（本文，转为 v0.1-draft 入库形态）
  - `docs/dev/roadmap.md`：新增 M1 第 3 迭代小节 + M1 方向表两行补注 + 版本行（全文见 §6.1）
  - `docs/dev/charter.md`：§3.3 C-4 的 `LIMITS` 数值清单增三项 + R-3 补注 + 版本行（全文见 §6.2）
  - `docs/dev/protocol.md`：**只标注「§14 待 P13.2 落地」的占位与四处待改点**，不写正文（正文随代码走，避免文档先于实现定死细节）
- **新增测试**：无（纯文档）
- **可机检 DoD**：
  - `docs/dev/roadmap.md` 附录文档索引表新增本文一行
  - 全仓 grep：`P12.1` ~ `P12.4` 仍只出现在 `key-distribution.md`（证明未撞号）
  - charter §3.3 C-4 列出的数值个数 = 8（原 5 + 新 3）
  - `bun run verify` 绿（文档改动不该影响，但要跑一次证明基线干净）
- **门禁**：`verify`
- **风险**：charter 改动需负责人确认（§2.4 `BASE.md` 那条纪律不适用——改的是 charter 不是 BASE.md，但 charter 同样是范围真源）
- **依赖**：无

---

### P13.2 协议扩展：`notify` / 能力发现 / `LIMITS` / `E_BUSY`

- **目标**：把 §2 全部落地。**协议先行，其余包都等它。**
- **改动文件**：
  - `packages/protocol/src/message.ts`：`MessageType.Notify`、`LEGACY_MESSAGE_TYPES`、`NotifyPayload` + `isNotifyPayload`、`createNotify()`；`isReplyType` **不动**（新类型不进）
  - `packages/protocol/src/limits.ts`：三个新常量
  - `packages/protocol/src/errors.ts`：`E_BUSY`
  - `packages/protocol/src/validate.ts`：notify 的 payload 分支
  - `packages/transport/src/frames.ts`：`ReadyFrame.supportedTypes?`（**v1 内可选字段，不动 `FRAME_VERSION`**）
  - `packages/transport/src/handshake.ts` / `client.ts` / `server.ts`：广播与读取 `supportedTypes`，暴露 `channel.supports(type)`
  - `packages/router/src/rate.ts`：notify 的独立出站滑动窗口
  - `docs/dev/protocol.md`：§14 全文 + §3.4/§6.1/§8/§11/§12.3 五处改动（§2.8）
- **新增测试**：
  - `notify` 的判环用例：**同一 contextId 连发 3 条 notify，第 2、3 条不得被判 `E_LOOP`**（这是 §2.4② 那个坑的正面用例，**只测第 1 条等于没测**）
  - `isReplyType(Notify) === false` 的显式断言 + 一条注释说明为什么不给豁免
  - `createNotify()` 的 `taskTtlMs === deliverTtlMs` 断言
  - 能力发现：`supportedTypes` 缺省 ⇒ 落回 `LEGACY_MESSAGE_TYPES`；声明后才允许发 notify；旧节点收 notify 回 `E_BAD_TYPE`
  - **兼容陷阱用例**：一个只认 `LEGACY` 码集的 `isTaskResultPayload` 对携带 `E_BUSY` 的 failed result 判非法 —— 断言这条**是事实**，从而把「降级为 `E_RATE_LIMITED`」这条规则钉住
  - `LIMITS` 三个新值的存在性 + charter 一致性（若已有该类断言则扩展）
- **可机检 DoD**：`packages/protocol` 与 `packages/transport` 用例全绿；`bun run check:cycles` 双向在预算内；协议包对外 API 变更在 `index.ts` 显式导出；`FRAME_VERSION` 未变（grep 断言）
- **门禁**：`verify`（含 `check:cycles`、`check:unused`）
- **风险**：**与 mTLS 线 `P12.3` 在 `frames.ts` 撞车**（那条线给 `AuthFrame` 加可选 `sig`）。处置：两包不得并行，先落者在 PR 描述里写明 `frames.ts:318` 的严格版本相等约束，后落者 rebase
- **依赖**：P13.1

---

### P13.3 队列治理与回执解耦（H-3 正面解决）

- **目标**：§4.2 全部；补 T11 测试盲区**①（队列压力/深度）**与**④（排队导致回执超时）**
- **改动文件**：
  - `packages/resident/src/turn-gate.ts`：重写为显式有界队列（35 行 → 约 120 行）
  - `packages/resident/src/timings.ts`：`ResidentTimingStage` 增 `'queued'`；`ResidentTimingEvent` 增 `queueDepth?`
  - `packages/resident/src/reader.ts`：向 gate 传 `deadlineAt` / `sessionId`
  - `packages/resident/src/runtime.ts`：新增 `assertDeliverable(message)`（同步）
  - `src/services/qianmo/resident.ts`：`#receive` 改为 await 到 `adapter.deliver` 为止；队列满 → `E_BUSY`（带 §2.6 的降级）
  - `packages/resident/README.md`：「最容易被改坏的五条不变式」表**扩为六条**，新增回执/ack 分层那条
  - `docs/dev/protocol.md` §4：补「传输回执 ≠ 协议 ack」的分层说明与代价
- **新增测试**：
  - **盲区①**：向门连续压 `maxQueuedTurns + 1` 个 turn，第 N+1 个被拒且返回 `E_BUSY`；`queued` 埋点的深度序列与预期一致
  - **盲区①(b)**：已过期的排队项在出队时被丢弃且 **`work` 从未被调用**（用 spy 断言，不是断言耗时）
  - **盲区④**：一个 turn 占门时投第二条 `task.request`，**传输回执在 5 s 内返回 Accepted**（这条用例今天会红，是本包存在的理由）
  - **C2 反向断言**：同一 `sessionId` 的两个 turn 永不重叠；断言实现**不得引用门的粒度**
  - refused（队列满）**不吃收件箱配额**：断言信箱条目数未增
  - 回执解耦后，信箱写入之后的失败仍以 `task.result{failed}` 到达发送方
- **可机检 DoD**：上述用例全绿；`packages/resident` 既有 47 条用例零回归；零新增 mock（该包现状零 mock，**这条必须保持**）
- **门禁**：`verify` + `check:mock-hygiene`
- **风险**：`#receive` 的时序改动会影响 `stop()` 的三步顺序（`#failActiveTasks` → `#drainReplyReceipts` → `transport.stop()`）。**该顺序被注释钉死，本包不得改它**，只能验证解耦后它仍成立（加一条集成用例）
- **依赖**：P13.1（`E_BUSY` 需 P13.2，可在 P13.2 落地前用降级码开发）

---

### P13.4 多会话隔离与会话 GC

- **目标**：§4.3 全部；顺带关掉 G-5 / G-6，缓解 G-9；补 T11 盲区**②（多 agent 并发投递 / `runtime.pollAll` 无覆盖）**
- **改动文件**：
  - `packages/resident/src/sessions.ts`：`sessionKeyOf(agent, contextId)` 唯一构造点；懒建；`DEFAULT_CONTEXT` 显式常量
  - `packages/resident/src/session-store.ts`：值扩为 `{ sessionId, createdAt, lastUsedAt }`；条目上限 + 先驱逐后写（**绝不静默截断**）
  - `packages/resident/src/reader.ts`：`sessionId` → `resolveSession(snapshot)`
  - `packages/resident/src/runtime.ts`：注入 resolver
  - `src/services/qianmo/resident.ts`：新增 `networkContextId()` 提取器（与 `networkMessageId` 并列）
  - `packages/resident/README.md`：会话键与 GC 的不变式
- **新增测试**：
  - 同一 agent、两个 contextId ⇒ 两个不同 `sessionId`；两条上下文互不可见（**这是「跨用户历史串味」的正面用例**）
  - 无 contextId ⇒ 落 `DEFAULT_CONTEXT`，与今天行为字节一致（回归保护）
  - **盲区②**：`runtime.pollAll()` 在多 agent × 多 context 下的并发投递，断言每条消息进了正确的会话
  - GC：LRU 驱逐；空闲 TTL 驱逐；**三类永不驱逐各一条负向用例**（有在途 task / 最近 N 个 / 账本有 pending）
  - G-6：`session-store` 到达上限时先驱逐再写，条目数不超上限且**无条目被截断**
  - G-9：N 个会话连续 resume M 轮后条目数与预期一致
  - 崩溃恢复不回归：账本 `detected` 记录里的 `sessionId` 仍能正确 resume
  - 全仓断言：`sessionKeyOf` 之外没有第二处会话键拼接
- **可机检 DoD**：上述全绿；47 条既有用例零回归；零新增 mock
- **门禁**：`verify` + `check:mock-hygiene`
- **风险**：`sessions.json` 的**格式变更**需要向后兼容读（旧格式是 `{agent: sessionId}`）。**必须能读旧文件**，否则升级即丢全部会话——写一条迁移用例
- **依赖**：P13.1

---

### P13.5 常驻可靠性件套（B1 / B2 / B3 / B6 / B10）

- **目标**：§3.B 判定为采纳的五条；补 T11 盲区**③（wake 常驻侧端到端）**
- **改动文件**：
  - 新增 `packages/resident/src/delivery-ledger.ts`（B1；四态 + 尝试上限 + `abandoned` + 启动 sweep）
  - 新增 `packages/resident/src/lifecycle.ts`（B2；`phase` 哨兵 + 内存采样）
  - 新增 `packages/resident/src/estop.ts`（B6；单次 `stat`；空/损坏 = engaged）
  - 新增 `packages/resident/src/inactivity.ts`（B10；早失败看门狗）
  - `packages/resident/src/ledger.ts`：B3 的同一 `messageId` 连续重启计数 + `abandoned`
  - `packages/resident/src/poller.ts`：poll 前查 ESTOP
  - `src/services/qianmo/resident.ts`：`#settleTask` 的回复走投递台账；`#receive` 查 ESTOP → `E_BUSY`；lifecycle 的启停接线
  - `packages/audit/src/record.ts`：`schemaVersion`（B9）
- **新增测试**：
  - B1：回执不来 ⇒ 台账留 `attempting`；重启后 sweep 认领并重投，**重投带 `redelivered` 标记**；尝试上限后 `abandoned`
  - B2：写 `phase=running` 后模拟非正常退出，下次启动能判出「上一条命是被杀的」
  - B3：**同一条毒 `detected` 记录连续 3 次重启后被 `abandoned`，节点仍能服务新消息**（这是本包最重要的一条用例：今天它是无限崩溃循环）
  - B6：ESTOP 存在时新 `task.request` 回 `E_BUSY` 且**在途 turn 不被杀**；**空文件仍算 engaged**
  - B10：turn 静默超过 `inactivityMs` ⇒ 提前失败且 `reason` 含不活动字样；有活动时不误杀
  - **盲区③**：wake 的常驻侧端到端（真进程 + 真传输）—— 并在此用例里**定夺 `protocol.md:175` 那条文档实现差**（wake 到底该不该产生 ack），把结论回写文档
  - fail-open：台账/lifecycle/ESTOP 文件不可读时不阻断服务
- **可机检 DoD**：上述全绿；新增四个模块各自有 README 段或文件头注释说明**「本机制不做什么」**（hermes 那种诚实注释是 atlas 既有风格）
- **门禁**：`verify` + `check:mock-hygiene`（新增文件系统交互**优先用模块自带 setter，不用 `mock.module`**）
- **风险**：四个新文件都写磁盘，可能与既有 fsync 账本争 IO。**B8 纪律**：观察类写盘（lifecycle 心跳）cadence 写成**代码常量 ≥ 30 s**，任何配置都不能把它变成高频写者
- **依赖**：P13.1（`E_BUSY` 需 P13.2）

---

### P13.6 定时反转与 notify 接线（值守场景原型）

- **目标**：§4.1 全部 + §2 的 notify 端到端跑通。**这是 M1 出口判据「至少 1 个真实值守场景连续运行 7 天」的载体。**
- **改动文件**：
  - 新增 `packages/scheduler/`（`@qianmo/scheduler`）：`job.ts` / `store.ts`（CAS）/ `reserve.ts` / `fire.ts` / `backoff.ts` / `index.ts` / `README.md`
  - `packages/console/src/deps.ts`：新增 `SchedulerPort` 与 `NotifyPort`
  - `packages/console/src/view/`：作业页 + 通知页 + 「调度器最后 tick」显示
  - `src/cli/handlers/consolePorts.ts` / `console.ts`：调度器与 notify 订阅的接线（中枢拨号并 hold 通道）
  - `src/services/qianmo/resident.ts`：notify 的出站（复用入站通道反方向）+ 出站限流 + 台账
  - 新增 notify MCP server（loopback）与 `qianmo_notify` 工具；`acp-client.ts` 的 `mcpServers` 由 `[]` 改为注入
  - `docs/dev/console.md`：新增作业与通知两节
- **新增测试**：
  - 预约幂等：同一 `<jobId>:<fireAtMs>` 重复预约只 fire 一次
  - CAS at-most-once：两个 scheduler 实例共享 store，同一 fire 只有一个赢
  - 补跑塌缩：中枢停机跨越 5 个周期后重启，只补跑一次
  - 失败退避：连续失败的作业间隔递增（对 hermes「无退避」的刻意背离，用例即证据）
  - notify 端到端：agent 调 `qianmo_notify` ⇒ 中枢收到 ⇒ 审计链可查
  - **中枢缺席**：通道断开时 notify 落台账，通道回来后按序排空且**不重复**（A2 的 ack 门控重放）
  - **E4 结构性断言**：给 ACP 会话注入的 MCP 工具表**只含 `qianmo_notify`**，不含任何排程能力
  - 出站限流：超过 `notifyRatePerMinute` 时被滑动窗口挡住（**不是令牌桶**——安静一小时后不放行一整批，用例要覆盖这个差异）
- **可机检 DoD**：上述全绿；`@qianmo/scheduler` 进 CI 分片；**一个真实值守作业在内测节点上连续跑 ≥ 24 h 并留档**（7 天由 M1 验收承接，本包只出 24 h 的量具与首段数据）
- **门禁**：`verify` + `check:cycles`（新包必然影响环预算，**双向棘轮要同批更新预算文件**）
- **风险**：① 中枢成为定时的单点（A7 背离的代价）—— 用「调度器缺席可见」+ 监督补偿；② MCP server 形态未定（loopback HTTP vs stdio），**首日 spike 定夺并留档**
- **依赖**：P13.2、P13.5

---

### P13.7 记忆接线与无人值守安全收窄

- **目标**：§4.4 + §4.5 全部
- **改动文件**：
  - `src/services/qianmo/resident.ts`：`formatPrompt` 里接 `@qianmo/recall` 的 sidecar 注入（冻结快照）
  - 新增 `packages/resident/src/guard.ts`：常驻专属 hardline 拒绝表（**不从会话配置读取**）+ 组装后 prompt 的注入扫描 + 远端 `text` 分隔符中和
  - `packages/adapter/src/wrapper.ts`：分隔符中和的落点（或新增 `sanitize.ts`）
  - `packages/resident/package.json`：新增对 `@qianmo/memory` / `@qianmo/recall` 的依赖
  - `docs/dev/protocol.md` §10.2 / charter T-7 相关段落的指针更新（不改判据）
- **新增测试**：
  - AC-4 不回归：`@qianmo/recall` 既有的命中 5/5 与伪造引用负样本在常驻链路下仍成立
  - **注入位置断言**：注入内容出现在用户消息里、**不出现在 system prompt 里**（结构断言，不是文本 grep）
  - 冻结快照：一轮内写入记忆，本轮注入内容不变
  - 作用域：`(agent, contextId)` 分区，A 作业的记忆不进 B 作业的注入
  - **E2/E3 双面封堵**：file 工具与 shell 两侧对同一敏感路径各一条负向用例（**只封一侧就是 unpaired theater**，用例要能抓住只封一侧）
  - **E5**：注入扫描的对象是**组装后**的完整 prompt —— 用一条「入参干净、组装后含注入」的用例证明
  - **E7**：远端 `text` 里的围栏 / CDATA / 伪标签被中和
  - **F9 的那个问题**：往工作树丢一个记忆目录**不能**劫持本节点的记忆（负向用例）
  - token 预算：注入 + 队列 + 工具 schema 叠加后不触发 auto-compact（估算断言）
- **可机检 DoD**：上述全绿；`check:cycles` 双向在预算内（新增两个包依赖会动环数，**预算同批更新**）
- **门禁**：`verify` + `check:cycles` + `check:mock-hygiene`
- **风险**：`@qianmo/recall` 引入到 resident 会让依赖图变化，**worktree 里的 `check:unused` 结论不作数**（CLAUDE.md §3.1，已骗过两个子代理）—— DoD 里写死「本包的 `check:unused` 结论必须在主检出或干净 clone 上取」
- **依赖**：P13.4（作用域需要 contextId）

---

## 6. 范围回写草案（全文）

**版本号勘误（P13.1 实施时记）**：下文草案起草时假定 roadmap 顺延到 **v2.48**、charter 顺延到 **v2.13**。P13.1 实际落地时复核分支基线（`s4/p11-console`，`b4b233af`，与本文头部所记一致）发现，**该提交上 roadmap / charter 的实际最新版本已经是 v2.53 / v2.14**——晚于草案起草时点的若干个批次（含 P11 三份设计件、`qm` 命令名落地等）已经并入同一提交，草案的版本号假设未跟着更新。故**实际写入的版本号是 roadmap v2.54、charter v2.15**，不是下文草案里的 v2.48 / v2.13。**下文原样保留草案初稿**（含 v2.48 / v2.13 字样）以存起草时的推理过程；以 roadmap.md、charter.md 两文件里的实际改动为准。

### 6.1 `docs/dev/roadmap.md`

#### (a) 新增小节，插在「### 7.3 M1 第 2 迭代」对应的 M1 节之后（与 retro §7 同格式）

```markdown
### M1 第 3 迭代（暂编 S12）· 常驻 agent bot 化

> 依据 `docs/dev/resident-botization.md`（v0.1-draft，评审通过才生效）。本迭代**是 M1 头两迭代
> 「不排新功能」约束之后的第一批功能实现**，承接 M1 方向表的「第二产品线验证」「记忆能力上线」
> 两行，以及「多租户与配额雏形」中与配额机制相关的那半。
>
> **编号说明**：`P12.1~P12.4` 已被 `key-distribution.md` 占用（mTLS 落地线），本批次让号用
> `P13.x`。两条线在 `packages/transport/src/frames.ts` 上有交集（都在 v1 内加可选字段），
> **排期不得并行**，先落者在 PR 描述里记 `frames.ts:318` 的严格版本相等约束。

| 包 | 目标 | 依赖 | DoD（判据） | owner | 估算 |
|---|---|---|---|---|---|
| **P13.1** ⚖️ **设计定稿与范围回写** | 把设计件入库并回写 roadmap / charter，**代码批次在其后** | 无 | `docs/dev/resident-botization.md` 入库并过评审；本表入 roadmap；charter §3.3 C-4 数值清单由 5 项增至 8 项并升版本号；全仓 grep 证明未与 `P12.x` 撞号 | 喻永昌 | **4–8 人时** |
| **P13.2** ⭐ **协议扩展：`notify` / 能力发现 / `LIMITS` / `E_BUSY`** | 长出唯一一个 agent 主动发起的消息类型，并给跨版本参差一条稳的路 | P13.1 | `MessageType.Notify` + `NotifyPayload` 落地且 `isReplyType` **不给它豁免**；**同一 contextId 连发 3 条 notify 第 2、3 条不被判 `E_LOOP`**（只测第 1 条等于没测）；`ReadyFrame.supportedTypes?` 在 **v1 内**加、`FRAME_VERSION` 未变（grep 断言）；缺省 ⇒ 落回 `LEGACY_MESSAGE_TYPES` 且不发 notify；`E_BUSY` 对未声明支持的对端降级为 `E_RATE_LIMITED`，并有一条用例把「旧节点会整条拒收带新码的 failed result」这个事实钉住；`LIMITS` 新增三项且 charter 一致 | 陈曦宇 | **16–28 人时** |
| **P13.3** ⭐ **队列治理与传输回执解耦（H-3）** | 让排队不再顶穿发送方 5 s 回执超时，并给队列装上上界与超时剔除 | P13.1（`E_BUSY` 依 P13.2） | `NodeTurnGate` 有界（`LIMITS.maxQueuedTurns`）、过期项出队即丢且 `work` **从未被调用**（spy 断言）、`queued` 进 `ResidentTimingStage`；**一个 turn 占门时第二条 task.request 的传输回执 5 s 内返回 Accepted**（该用例今天必红）；**协议 ack 的发出点一行未动**，仍严格晚于 `markRead`；队列满的拒绝发生在信箱写入之前（refused 不吃配额）；同一 `sessionId` 两个 turn 永不重叠，且该断言不引用门的粒度；`packages/resident` 零 mock 保持 | 董宗岳 | **20–36 人时** |
| **P13.4** ⭐ **多会话隔离 `(agent, contextId)` 与会话 GC** | 让不同远端请求者/值守作业不再共用一条上下文，并顺带关掉 G-5 / G-6 | P13.1 | `sessionKeyOf(agent, contextId)` 是全仓唯一构造点（扫描断言）；无 contextId 回退 `DEFAULT_CONTEXT` 且与今天行为字节一致；`runtime.pollAll` 在多 agent × 多 context 下有覆盖（T11 盲区②）；GC 的三类永不驱逐各一条负向用例；`session-store` 到上限先驱逐后写、**无静默截断**（G-6）；**能读旧格式 `sessions.json`**（升级不丢会话）；协议 / 适配器 / 基座**三处零改动** | 董宗岳 | **16–30 人时** |
| **P13.5** ⭐ **常驻可靠性件套（投递台账 / 终止取证 / 重启熔断 / ESTOP / 不活动早失败）** | 把「无痕丢失」「无限崩溃循环」「没有急停」三个空洞补上 | P13.1（`E_BUSY` 依 P13.2） | 回执不来的 `task.result` 进台账并在重启后重投且**带 `redelivered` 标记**；`phase=running` 哨兵能判出上一条命是被杀的；**同一条毒 `detected` 记录连续 3 次重启后 `abandoned`、节点仍服务新消息**；ESTOP 文件存在时新任务回 `E_BUSY` 且**在途从不杀**、**空文件仍算 engaged**；不活动看门狗提前失败且 `reason` 说明原因；四者读写失败一律 fail-open；**wake 常驻侧端到端用例补齐（T11 盲区③）并据此定夺 `protocol.md:175` 的文档实现差** | 陈子轩 | **20–36 人时** |
| **P13.6** ⭐ **定时反转（`@qianmo/scheduler`）与主动通知接线** | 值守场景原型的载体：定时由中枢持有、节点只被叫醒；产出默认静默，只有显式 notify 才打扰人 | P13.2、P13.5 | `dedupKey = "<jobId>:<fireAtMs>"` 幂等；两个 scheduler 实例共享 store 时 CAS at-most-once；跨 5 个周期停机后**补跑塌缩为一次**；失败退避递增；notify 端到端（agent 工具 → 中枢 → 审计链）；**中枢缺席时 notify 落台账、回来后按序排空且不重复**；**注入给 ACP 的 MCP 工具表只含 `qianmo_notify`、不含任何排程能力**（E4 结构性断言）；出站限流是**滑动窗口不是令牌桶**（用例覆盖「安静一小时后不放行一整批」）；**节点一次都不拨号**（H-2 不变式的扫描断言）；一个真实值守作业连续跑 ≥ 24 h 留档 | 李怡康 + 董宗岳 | **28–48 人时** |
| **P13.7** ⭐ **记忆接线与无人值守安全收窄** | 把 `@qianmo/memory` / `@qianmo/recall` 接进常驻链路（sidecar 位置），并给「预批准白名单没有天花板」装上天花板 | P13.4 | 注入出现在**用户消息**里、**不出现在 system prompt** 里（结构断言）；一轮内是冻结快照；作用域按 `(agent, contextId)` 分区；AC-4 的 5/5 与伪造引用负样本在常驻链路下不回归；hardline 拒绝表求值**在 allow 规则之前**且**不从会话配置读取**，file 与 shell **双面封堵各一条负向用例**；注入扫描的对象是**组装后**的完整 prompt（用「入参干净、组装后含注入」的用例证明）；远端 `text` 的分隔符被中和；**往工作树丢一个记忆目录不能劫持本节点记忆**；注入 + 队列 + 工具 schema 叠加后不触发 auto-compact；**`check:unused` 结论只在主检出或干净 clone 上取** | 董宗岳 + 陈曦宇 | **24–40 人时** |

**合计 128–226 人时**，顺序：P13.1 → P13.2 →（P13.3 / P13.4 / P13.5 可并行）→ P13.6 → P13.7。
P13.3 与 P13.4 都碰 `reader.ts`，**合并以 P13.4 先落为准**（它改的是构造参数签名）。

**本迭代明确不做**（理由见设计件 §7.1）：节点主动休眠的三帧握手（A1/A2/A3）、节点→节点 notify、
真并发（H-9）、mTLS（另线）、语义检索（N-8 保留）、计费（N-1 保留，`costLimit` 仍恒为 0）、
队列优先级、基座 system prompt 三层分层（D1/D2）。
```

#### (b) M1 方向表两行补注（改 `roadmap.md:853` 与 `:856`）

```markdown
| **记忆能力上线** | 语义检索（在确定性检索之上叠加，非替换）、记忆治理（冲突消解、过期废止、跨项目隔离）。**（v2.48 补注）确定性检索接进常驻链路那一段由 P13.7 承接**（注入位置定为用户消息 sidecar，不进 system prompt）；**语义检索仍在 N-8 之内、由本行的后续包承接** | 检索命中率与幻觉引用率有量化指标并优于 M0 基线 |

| **第二产品线验证** | 运维值守场景原型（常驻智能体的第二类应用）。**（v2.48 补注）载体为 M1 第 3 迭代 P13.6**：定时由中枢 `@qianmo/scheduler` 持有、节点只被叫醒；产出默认静默，只有 agent 显式调用 `qianmo_notify` 才打扰人 | 至少 1 个真实值守场景连续运行 7 天 |
```

#### (c) 版本行（加在 `roadmap.md` 变更表首）

```markdown
| **v2.48** | **2026-08-18** | **M1 第 3 迭代立项：常驻 agent bot 化（P13.1~P13.7）**，依据 `docs/dev/resident-botization.md`（v0.1-draft，评审通过才生效）。参照 hermes-agent 的 bot 模式与常驻原理做了逐条采纳判定（A~F 共 **47** 条：采纳 19、改造后采纳 12、已成立或登记备查 6、本轮不做 10；另 G 表 6 条复核仍不适用）。**四条设计主线**：① 协议先行长出唯一一个 agent 主动发起的类型 `notify`（fresh `taskId` + `contextId` 归组，**不给 `isReplyType` 豁免**——复用 taskId 会让同一值守作业的**第二条**通知被判 `E_LOOP`，第一条永远是绿的）；② 传输回执与协议 ack 分层（回执提前到 durable 信箱写入之后，**ack 的发出点一行未动**，AC-2 不变式相容性论证见设计件 §4.2）；③ `(agent, contextId) → sessionId` 多会话（**协议 / 适配器 / 基座三处零改动**——`contextId` 已随整条信封落进信箱 `text`）；④ 定时完全反转到中枢，节点侧零值守状态（节点内 ticker 会让节点永不冻结，抵消 R-3）。**`LIMITS` 新增三项**（`defaultNotifyTtlMs` / `notifyRatePerMinute` / `maxQueuedTurns`），charter §3.3 C-4 同步回写（charter v2.13）。**编号让号**：`P12.1~P12.4` 已被 `key-distribution.md` 占用，本批次用 `P13.x`；两条线在 `frames.ts` v1 可选字段上有交集，**排期不得并行**。**M0 排期、日期、产能、关键路径均未动。** |
```

### 6.2 `docs/dev/charter.md` delta

**只有一处是必须的，另两处是补注。**

#### (a) 【必须】§3.3 C-4 的 `LIMITS` 数值清单（`charter.md:180`）

原文：

> **所有协议级数值上限以 `@qianmo/protocol` 的 `LIMITS` 为唯一出处**（`maxHops=8`、`maxMessageBytes=256KiB`、`defaultTtlMs=30s`、`defaultTaskTtlMs=5min`、`ratePerMinute=600`），文档与其他包不得各写一份。

改为：

> **所有协议级数值上限以 `@qianmo/protocol` 的 `LIMITS` 为唯一出处**（`maxHops=8`、`maxMessageBytes=256KiB`、`defaultTtlMs=30s`、`defaultTaskTtlMs=5min`、`ratePerMinute=600`、**`defaultNotifyTtlMs=2min`**、**`notifyRatePerMinute=60`**、**`maxQueuedTurns=32`**），文档与其他包不得各写一份。**v2.13 新增后三项**（随 M1 P13.2 的主动通知与队列治理）：`defaultNotifyTtlMs` 是 `notify` 的投递时限默认值，取值介于 30 s 与 5 min 之间——对端是可能正在重启的中枢而不是在跑的 agent，但一条超过两分钟没送到的通知对人已经是历史而不是告警，再投由发送方台账负责；`notifyRatePerMinute` 刻意比入站 `ratePerMinute` 低一个数量级，因为入站预算防的是外部打击、出站预算防的是**本节点在无人值守下把人淹掉**；`maxQueuedTurns` 是节点 turn 队列的上界，在节点级串行（分钟级单 turn）下 32 深已经排到远超任何发送方的 `taskTtlMs`，再大只是把注定超时的消息多存一会儿。依据见 `docs/dev/resident-botization.md` §2.5。

#### (b) 【补注，建议】§3.2 R-3（`charter.md:172`）末尾追加

> **v2.13 补注**：R-3 原文的唤醒触发源「消息到达 / 定时 / 手动」中的**「定时」自 M1 P13.6 起明确由中枢持有、节点侧零定时状态**。理由是结构性的而非偏好：节点内的周期性 ticker 会让节点永远不空闲、因而永远不进入 R-3 定义的沙箱冻结态，直接抵消本条。代价是中枢成为定时的单点，补偿为「调度器缺席可见」+ 调度器自身监督 + 重启时补跑塌缩为一次。**R-3 的判据与形态未改。**

#### (c) 【明确不改，写进本文以免被误加】

- **N-1**（计费）：本设计**不碰** `costLimit`，它仍恒为 0、非零仍在出站被拒。M1 方向表的「多租户与配额雏形」里本设计只贡献**机制**（`notifyRatePerMinute` 的滑动窗口、`maxQueuedTurns` 的硬上界），**不接任何计价**。**无 N-1 delta。**
- **N-8**（语义/向量检索）：保持。P13.7 接的是既有的**确定性**检索。**无 N-8 delta。**
- **§4 AC-1 ~ AC-8**：一字不改。特别是 **AC-2** —— §4.2 的论证结论是本设计动的是传输回执而非协议 ack，ack 的发出点严格不变。**无 AC delta。**
- **§3.3 C-1**：新增消息类型与新增错误码都在 C-1 已经授权的范围内（它说的是「消息生命周期状态机、错误码表」而不是枚举内容）。**无 C-1 delta。**
- **`BASE.md`**：一字不动（§2.4 纪律：只有「导入」与「上游同步」两类事件才写它）。

---

## 7. 明确不做清单与遗留风险

### 7.1 明确不做（本批次）

| 项 | 理由 | 去向 |
|---|---|---|
| 节点主动休眠的三帧握手（hermes A1/A2/A3） | 当前四节点只有 beta-1 有休眠态，且休眠是被动的（不报忙→停心跳→沙箱冻结），没有「节点宣告要睡」这一步。**先有主动性再有主动休眠**，否则是给不存在的行为层写契约 | M1 后续包，与 R-3 休眠半边一起 |
| **节点 → 节点** 的 notify | 需要节点拨号，撞 H-2。本设计用「复用入站通道反方向」绕开了拨号需求，但那只在对端已经拨进来时成立——中枢会，另一个节点不会 | 与注册中心产品化/mTLS 一起看 |
| 真并发（H-9） | roadmap v2.15 Q3 裁定须回基座核心，M1 候选未排期 | 不变 |
| mTLS | 独立 M1 线（`key-distribution.md` P12.1~P12.4） | 不变 |
| 计费 | N-1 保留 | M2+ |
| 语义/向量检索 | N-8 保留 | M1「记忆能力上线」的后续包 |
| 队列优先级 | 产品判断，M1 无判据要求，加了就得维护一张会长歪的表 | 有真实需求时再提 |
| 突发消息折叠（hermes C3 前半） | 与既有 `selectResidentSnapshot` 的合并语义打架；值守是定时的不是突发的，M1 无对象 | 记为遗留 |
| 基座 system prompt 三层分层与时间戳按天（D1/D2） | 属改基座核心，与本批次目标零相交；混进来只增加上游冲突面 | D2 值得单独提一个一行 PR |
| 新增第二个错误码 | 每多一个码就多一份 §2.6 的兼容负担；`E_BUSY` 一个码 + 两种 reason 已够 | — |
| `maxWatchesPerNode` | 值守状态全在中枢，节点侧零值守状态，这个上限没有对象 | — |

### 7.2 遗留风险

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| R-a | **`frames.ts` 上与 mTLS 线撞车**：两条线都在 v1 内加可选字段（`supportedTypes` / `sig`），且 `frames.ts:318` 是严格版本相等 | 中 / 中 | 排期不并行；先落者在 PR 描述记该约束；后落者 rebase 而不是 merge |
| R-b | **中枢成为定时单点**（A7 的刻意背离） | 中 / 中 | 调度器缺席可见 + 自身监督 + 重启补跑塌缩为一次；**不引入节点内 ticker 兜底**（会抵消 R-3） |
| R-c | **回执语义变化是对外可见的行为变化**：Accepted 从此只保证「已落盘」不保证「已排上队」 | 中 / 低 | 写进 `protocol.md` §4 与控制台文案；这不是退步（今天是超时，也就是既无回执也无结果），但它是变化 |
| R-d | **多会话把 G-9（`--resume` 时间戳并列丢尾部）放大**：每 context 每次唤醒 resume 一次 | 中 / 中 | P13.4 的 DoD 里有 N×M resume 后条目数断言；若实测证伪，需在 M1 内单独排一个包处理 G-9 本体 |
| R-e | **`sessions.json` 格式变更** | 高 / 低 | 必须能读旧格式，有迁移用例；否则升级即丢全部会话 |
| R-f | **hardline 拒绝表可能与基座权限模型演进不一致**：M1「权限模型上线」会让 `requestPermission` 真的去等人，届时 C4（审批必须内联派发）与 E1（审批等待从 deadline 扣除）**同时成立**，而那时门里已经有队列了 | 中 / 中 | 本文 §3.C/E 已把两条登记为「本轮无对象但届时必做」；权限模型那个包必须把本文这两行当输入 |
| R-g | **notify 的产出质量取决于 agent 是否愿意调工具**：默认静默的代价是「该报的没报」 | 中 / 中 | 值守作业的 prompt 里显式要求；P13.6 的 24 h 留档要人工核对「该报未报」的条数 |
| R-h | **`check:unused` 在 worktree 里假阳性**（CLAUDE.md §3.1，已骗过两个子代理） | 低 / 高 | P13.7 的 DoD 写死：结论只在主检出或干净 clone 上取 |
| R-i | **`protocol.md` §12.3 的那条未查证项仍未查证**（轮询循环解冻后是否热页 —— A 类 ack 成立的关键假设） | 中 / 中 | 不属本设计范围，但 §4.2 的回执解耦**降低了对它的依赖**（回执不再等模型），值得在 P13.3 的报告里顺带记一句 |

### 7.3 与两份输入报告不符之处（四条，含证据）

| # | 输入报告的说法 | 实际 | 出处 |
|---|---|---|---|
| 1 | `atlas-resident-status.md`：「协议 **10** 种消息类型」（§0 第 5 行与 §3 各一次） | **11 种**：task.request / ack / task.result / ping / pong / wake / error / resource.{request,offer,grant,release}。`isReplyType` 为真的 7 个，为假的 4 个 | `packages/protocol/src/message.ts:13-39` |
| 2 | 任务书：「常驻等于永久 yolo」 | **不成立**。常驻是 `permissionMode: 'dontAsk'` = **不提示、未预批准即拒绝**，且该转换刻意放在权限链末端以免被提前 return 旁路；`requestPermission` 又硬编码回 `cancelled`。真实风险面是**预批准白名单没有天花板 + 跨节点 prompt injection（T-7）**，不是「什么都放行」。这改变了 hermes E2 的落法：需要的不是「yolo 的刹车」，而是**求值在 allow 规则之前的 hardline 表** | `packages/resident/src/acp-client.ts:47-51,101`；`src/utils/permissions/permissions.ts:540-552`；`src/entrypoints/sdk/coreSchemas.ts:354` |
| 3 | `hermes-study.md` §6.A：把 scale-to-zero 的三帧握手 / wake poke 呈现为已落地的行为 | 契约文本**逐字把 §3.2/§3.3 标为 PRIMITIVE**，并把「决定睡」「真挂起机器」「NAS 健康模型」写进 *NOT in scope*；§3.4 是一份**给未来行为层的义务清单**。`gateway/scale_to_zero.py` 确实存在（9.7 KB），但它是**消费**这组原语的另一层。抄的时候必须原语/行为两层分开抄，否则会把行为层的假设当成契约 | `hermes-agent/docs/relay-connector-contract.md` §3.2/§3.3/§3.4 |
| 4 | 任务书：「建议编号 P12.x」 | **P12.1~P12.4 已被占用**（`key-distribution.md` 的 mTLS 落地四包）。本设计改用 P13.x | `docs/dev/key-distribution.md:717-720` |

**另有三处不是「不符」但输入报告没说、而设计强依赖的事实**（本轮核对新得）：

- **`contextId` 已经随整条信封落进基座信箱条目的 `text`**（嵌在 `envelope` 之下），且 `resident.ts` 的 `networkEnvelope()` 已在解它取 `msgId`。**多会话隔离因此是协议 / 适配器 / 基座三处零改动**，比状态报告 §7 第 2 条估计的还便宜。
- **`selectResidentSnapshot` 保证一个 snapshot 最多一条网络消息**，所以 snapshot 不可能横跨两个 contextId —— 省掉了「按 contextId 切分 snapshot」这件最容易做错的事。
- **`TransportChannel` 的文档逐字写着 bidirectional**，且 `channel.hold()` 就是为「断线后留着这条通道以便稍后回复」设计的。**主动通知因此可以完全不碰 H-2**——节点一次都不用拨号。

---

## 附录 A · 本文的核实状态

| 类别 | 状态 |
|---|---|
| 协议枚举 / `isReplyType` / `LIMITS` / 错误码 | 本轮直接读 `message.ts`、`limits.ts`、`errors.ts` 全文 |
| turn-gate / reader / runtime / contracts / sessions / timings / acp-client | 本轮直接读全文 |
| 宿主 `resident.ts` 的任务生命周期（`#receive` / `#registerTask` / `#settleTask` / `#drainReplyReceipts` / `#startAcp`） | 本轮直接读 `:255-805` |
| `receiver.ts` 回执时序、`outbox.ts` 5 s 默认、`channel.ts` 双向性 | 本轮直接读 |
| `wrapper.ts` 的信箱 `text` 形状（contextId 可得性的依据） | 本轮直接读 `:1-80` |
| 基座 `dontAsk` 语义 | 本轮直接读 `permissions.ts:540-552`、`PermissionMode.ts:72-77`、`coreSchemas.ts:354` |
| hermes relay 契约的 PRIMITIVE 边界与 `supported_ops` | 本轮直接读 `docs/relay-connector-contract.md` §2/§3.2/§3.3/§3.4 |
| hermes 可靠性五件套文件存在性 | 本轮直接 `ls` + 读 `estop.py` 文件头 |
| roadmap / charter / retro 的条目格式与编号约定 | 本轮直接读 roadmap `:281-400,760-876`、charter `:129-230,425-430`、retro `:399-417` |
| `P12.x` 占用 | 本轮直接读 `key-distribution.md:717-720` |
| hermes §2/§3/§4/§5 的其余细节 | **未复核**，沿用 `hermes-study.md` 的行号与结论 |
| atlas `packages/activator`、`@qianmo/audit`、`@qianmo/console` 的内部细节 | **仅读了 index 与关键片段**，实施包开工时需各自复核 |
