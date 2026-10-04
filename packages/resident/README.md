<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @qianmo/resident —— 常驻 ACP 宿主的读者、账本与闸门

**一句话定位**：给 ACP 宿主补上一个**在空闲时也会醒来的信箱读者**，并让「检测到 → 输入被受理 → 翻转 read → 一个 turn 打完」这四步落在一本可崩溃恢复的账本上；外加节点级 turn 串行、解冻感知的截止时钟、以及向宿主上报忙闲的活动通道。

| 项 | 指针 |
| --- | --- |
| 任务包 | roadmap **P3.1**（休眠与唤醒）；网络任务改为逐条 ACP turn、durable read 后发 ack 由 **P4.1** 补入；队列治理与回执解耦 **P13.3**、多会话隔离 **P13.4**、可靠性件套（投递台账 / 终止取证 / 重启熔断 / ESTOP / 不活动早失败）**P13.5**、主动通知出站 **P13.6**、记忆接线与无人值守安全收窄 **P13.7** |
| 章程条目 | charter **§3.2 R-3**（休眠与唤醒，基座起点：部分，v2.7 定案） |
| 协议真源 | `protocol.md` §4.5（ack 由谁发出）、§4.5.1（回执与 ack 分层）、§5.3（时间跳跃闸门 T-2）、§4.6（`task.result` 契约与 `redelivered`）、§11.3（规则 N-1 降级）、§14.8.1（`wake` 不产生 ack 的定夺） |
| 完成状态 | roadmap「完成状态速查」P3.1 行 |

## 1. 模块架构图

```mermaid
flowchart TD
  poller["poller.ts · ResidentPoller<br/>从完成处重排，不补跑漏掉的 tick"]
  runtime["runtime.ts · ResidentNodeRuntime<br/>按 to 的 agent 段分发；每 agent 一个 reader"]
  gate["turn-gate.ts · NodeTurnGate<br/>跨会话按到达顺序串行<br/>有界 FIFO · 出队剔过期"]
  reader["reader.ts · ResidentMailboxReader<br/>#poll → 恢复 pending → 读信箱 → 记 detected<br/>→ submit turn → onAccepted 时 markAdmitted + markRead"]
  ledger["ledger.ts · FileAdmissionLedger<br/>NDJSON · 0700/0600 · fsync · 有界压实"]
  contracts["contracts.ts（端口）<br/>ResidentMailboxPort · ResidentTurnPort<br/>AdmissionLedger · 三相记录类型"]
  identity["mailbox-identity.ts<br/>from / timestamp / text 三元组计数"]
  timings["timings.ts · ResidentTimingRecorder<br/>detected/queued/admitted/read/first_content/turn_completed"]
  deadline["deadline-clock.ts · ResidentDeadlineClock<br/>nowFor(createdAt) 扣掉冻结重叠段"]

  turnport["acp-turn.ts · AcpResidentTurnPort<br/>isAccepted / execute<br/>qianmo/input-status · input-accepted · session-activity"]
  client["acp-client.ts · ResidentAcpConnection<br/>ClientSideConnection + ndJsonStream"]
  sessions["sessions.ts · ResidentSessionManager<br/>start 只开 DEFAULT_CONTEXT，其余懒建<br/>sessionFor 取租约、release 还租约"]
  key["session-key.ts · sessionKeyOf<br/>(agent, contextId) 唯一构造点"]
  gc["session-gc.ts · selectEvictableSessions<br/>LRU + 空闲 TTL，三类永不驱逐"]
  store["session-store.ts · FileResidentSessionStore<br/>原子落盘、损坏即 fail closed<br/>读旧格式、越上限即抛不截断"]
  supervisor["supervisor.ts · ResidentSupervisor<br/>指数退避重启 · 快速连挂即 parking"]
  activity["activity.ts · ResidentActivityReporter<br/>busy/idle 经 transport 报给宿主 keepalive"]

  delivery["delivery-ledger.ts · FileDeliveryLedger<br/>回执不来的 task.result 四态台账<br/>pending→attempting→delivered/failed，上限即 abandoned"]
  estop["estop.ts · ResidentEstop<br/>单次 stat，存在即急停<br/>空/损坏仍算 engaged"]
  lifecycle["lifecycle.ts · ResidentLifecycleSentinel<br/>phase=running 留在盘上 ⇒ 上一条命被杀"]
  inactivity["inactivity.ts · ResidentInactivityWatchdog<br/>turn 静默即早失败，reason 说明原因"]
  notify["notify.ts · ResidentNotifier<br/>出站 notify：滑动窗 + 台账 + 按序排空<br/>只走对端已开的通道，一次都不拨号"]
  grants["grant-store.ts · FileGrantStore（P14.3）<br/>挂起行 + 绑定行，一本追加台账<br/>损坏即 fail closed，hardline 优先于 grant"]

  acp["ACP 子进程（occ --acp）"]
  host["宿主：@qianmo/activator 的 ResidentActivityController"]

  poller --> runtime
  runtime --> reader
  runtime --> gate
  reader --> gate
  reader --> ledger
  reader --> identity
  reader --> timings
  reader -->|端口| contracts
  turnport -.->|"实现"| contracts
  ledger -.->|"实现"| contracts
  reader --> turnport
  turnport --> client
  client --> sessions
  sessions --> store
  sessions --> key
  sessions --> gc
  store --> key
  gc --> key
  runtime -->|"resolveSession(agent, contextId)"| sessions
  supervisor --> client
  client <--> acp
  activity --> host
  deadline -.->|"nowFor"| reader

  poller -->|"poll 前查"| estop
  reader -->|"recordRecovery / abandon"| ledger
  turnport --> inactivity
  inactivity -.->|"session/cancel"| client
  notify -->|"复用 P13.5 台账"| delivery
  grants -->|"先问"| hardline["guard.ts · ResidentHardline"]
  grants -->|"engaged 即不命中"| estop
```

四个可靠性件套模块（`delivery-ledger` / `estop` / `lifecycle` / `inactivity`，P13.5）在包内**没有任何互相依赖**，也不参与准入循环的判定——它们各自被宿主接线一次，见 §3.3。

`deadline-clock.ts` 的 `nowFor` 同时被上层（`src/services/qianmo/resident.ts`、`@qianmo/router` 的 `deadlineNow`）用作「过闸门的时钟」，因此一个刚解冻的节点不会把所有在飞投递一起判死。

## 2. 对外 API 面

读 `src/index.ts`（另有 `./activity` 与 `./timings` 两个子入口，供宿主侧的 `@qianmo/activator` 单独引用）：

- **`ResidentNodeRuntime` / `ResidentAgentBinding`** —— 节点级门面：`deliver(message)` 按收件地址的 agent 段选 reader，`pollAll()` 全量轮询；`assertDeliverable(message)` 是 `deliver` 的同步半边，供宿主在**落盘之前**问「这条本节点收不收」。
- **`ResidentMailboxReader` / `ResidentMailboxReaderOptions` / `ResidentPollResult`** —— 一个 agent 的准入循环，单飞（同一时刻只有一次 `poll` 在跑）。
- **`ResidentPoller` / `DEFAULT_RESIDENT_POLL_INTERVAL_MS`** —— 驱动轮询的定时器，从**完成**处重排。
- **`NodeTurnGate` / `NodeTurnRequest` / `NodeTurnQueueFullError` / `NodeTurnExpiredError`** —— 节点级 turn 串行闸门：显式有界 FIFO 队列，上界取 `LIMITS.maxQueuedTurns`，出队时按 `deadlineAt` 剔除过期项。
- **`FileAdmissionLedger`** 与端口类型 **`AdmissionLedger` / `AdmissionRecord`（`detected` / `admitted` / `read`）/ `PendingAdmission` / `AdmissionQueryResult` / `AdmissionIntegrityIssue`** —— 崩溃恢复账本。
- **`ResidentMailboxPort` / `ResidentTurnPort` / `ResidentTurnInput` / `ResidentTurnResult` / `ResidentMailboxMessage`** —— 两个端口，让整包不依赖任何具体信箱或 ACP 实现。
- **`AcpResidentTurnPort` / `AcpPromptConnection` / `ACP_INPUT_ACCEPTED_METHOD` / `ACP_INPUT_STATUS_METHOD` / `ACP_SESSION_ACTIVITY_METHOD`** —— `ResidentTurnPort` 的 ACP 实现与三个扩展方法名。
- **`ResidentAcpConnection` / `createResidentAcpStream` / `ResidentAcpClientOptions` / `ResidentActivitySink`** —— ACP 客户端侧连接。
- **`ResidentSessionManager` / `ResidentSessionResolver` / `ResidentAgentSession` / `ResidentSessionConnection` / `ResidentSessionManagerOptions` / `pendingSessionIds`**、**`FileResidentSessionStore` / `MemoryResidentSessionStore` / `ResidentSessionStore` / `ResidentSessionRecord` / `ResidentSessionStoreOptions` / `MAX_STORED_RESIDENT_SESSIONS`** —— `(agent, contextId) → sessionId` 的映射、落盘与租约。
- **`sessionKeyOf` / `agentOfSessionKey` / `contextOfSessionKey` / `isSessionKey` / `DEFAULT_CONTEXT` / `SESSION_KEY_SEPARATOR`** —— 会话键的**唯一**构造与解析点。
- **`selectEvictableSessions` / `assertGcPolicy` / `DEFAULT_RESIDENT_SESSION_GC_POLICY` / `ResidentSessionGcPolicy` / `ResidentSessionGcInput`** —— 会话 GC 的纯选择器与它的显式常量。
- **`ResidentSupervisor` / `ResidentChildConnection` / `ResidentSupervisorOptions`** —— ACP 子进程监督。
- **`ResidentDeadlineClock`** —— 解冻感知的截止时钟，导出 `nowFor(createdAt)`。
- **`ResidentTimingRecorder` / `ResidentTimingStage` / `ResidentTimingEvent` / `ResidentTimingSink` / `DEFAULT_RESIDENT_TIMING_CAPACITY`** —— 全链路埋点（P4.1 的独立核验取的就是它）。`queued` 阶段带 `queueDepth`（该 turn 交接时排到的位次，1 = 直接进门），**只观察不参与任何判定**（hermes B8）。
- **`ResidentActivityReporter` / `RESIDENT_ACTIVITY_AGENT` / `isResidentActivityMessage` / `isResidentActivityPayload` / `ResidentActivityPayload`** —— 忙闲上报。
- **`residentMailboxIdentity` / `readCountsByIdentity` / `messageCountsByIdentity`** —— 基座信箱条目的身份三元组与计数（基座不给消息 id）。

可靠性件套（P13.5），四件互不依赖：

- **`FileDeliveryLedger` / `DeliveryLedger` / `DeliveryLedgerEntry` / `DeliveryPhase` / `DeliveryIntegrityIssue` / `MAX_DELIVERY_ATTEMPTS`** —— 回执不来的终态回复的投递台账。
- **`ResidentEstop` / `ResidentEstopOptions` / `ResidentEstopStatus`** —— 急停哨兵，一次 `stat`。
- **`ResidentLifecycleSentinel` / `ResidentPriorLife` / `ResidentLifecycleRecord` / `ResidentLifecyclePhase` / `ResidentLifecycleOptions` / `RESIDENT_LIFECYCLE_HEARTBEAT_MS`** —— 终止取证哨兵。宿主经 `onPriorLife` 拿到判定；`qm resident` 把它打在 stdout 启动 banner 之后单独一行（`{"node":…,"priorLife":"killed"|"clean"|"unknown"}`，`killed` 附上一条命记录里的 `pid` / `startedAt` / `updatedAt`），不进审计链，行格式见 `src/cli/handlers/resident.ts` 的 `residentPriorLifeLine`。
- **`ResidentInactivityWatchdog` / `ResidentInactivityError` / `ResidentInactivityOptions` / `ResidentInactivityTurn` / `DEFAULT_RESIDENT_INACTIVITY_MS`** —— 不活动早失败看门狗。
- **`MAX_ADMISSION_RECOVERIES`** —— 重启熔断的上限，配套 `AdmissionLedger.recordRecovery` / `abandon` 与记录类型 `RecoveringAdmissionRecord` / `AbandonedAdmissionRecord`。

主动通知出站（P13.6）：

- **`ResidentNotifier` / `ResidentNotifierOptions` / `NotifyChannel` / `NotifyOutcome`** —— 出站 `notify` 的全部：滑动窗预算、台账、按序排空。`NotifyChannel` 是 `TransportChannel` 的结构化子集，本模块**不 import `@qianmo/transport`**（`test/no-dial.test.ts` 钉住这一条）。
- **`ResidentNotifyEventType` / `ResidentNotifyEvent` / `ResidentNotifyAuditSink` / `NOTIFY_EVENT_SCHEMA_VERSION`** —— 审计事件与它的 schema 版本戳（hermes B9）。
- **`AcpResidentTurnPort.activeTurn(sessionId)`** —— 某会话正在跑的 turn，供宿主把一次 `qianmo_notify` 归到出钱的那个任务上。

记忆接线与安全收窄（P13.7）：

- **`ResidentMemorySidecar` / `ResidentMemorySidecarOptions` / `residentRecallScope` / `assertNodeOwnedMemoryRoot` / `INJECTION_BUDGET`** —— 用户消息 sidecar 的记忆注入：按 `(agent, contextId)` 取 working 层、渲染成块、失败 fail-open。`ResidentPromptScope`（`contracts.ts`）是那对键的载体，**两半永不在这里拼成一个字符串**（拼法只许在 `sessionKeyOf`，不变式 #7）。可选的 `semantic` 选项接上 `@qianmo/recall` 的语义叠加（`docs/dev/memory-m1.md` §5，P16.6），**缺省即关**：`renderHybrid` 此时就是 `render`。开启后 `formatPrompt` 可以异步返回 `ResidentAssembledPrompt`（两段式组装），其 `retrieval` 由 reader 写进同一条 `detected` 记录；关闭时 `detected` 记录不带这个字段，与原先逐字节相同。
- **`ResidentHardline` / `HARDLINE_TARGETS` / `HardlineDenial` / `ResidentHardlineOptions`** —— 常驻专属的预批准天花板：冻结字面量、路径与命令两面同表、`stateRoots` 只增不减。
- **`scanAssembledPrompt` / `PromptScanExpectation` / `PromptInjectionFinding`** —— 对**组装后**完整 prompt 的结构扫描（块计数 + 属性名），不作任何「像不像注入」的判断。
- 中和函数在 `@qianmo/adapter/sanitize`（`sanitizeRemoteText` / `sanitizeRemoteAttribute` / `hasUnneutralizedDelimiter`），不在本包：分隔符词汇属于包装格式，归 adapter。

生产写入路径（P16.W，`memory-m1.md` §6.4）：

- **`writeResidentMemory` / `revokeResidentMemory` / `invalidateResidentMemory` / `residentMemoryScope` / `ResidentMemoryTarget` / `ResidentMemorySource` / `ResidentMemoryWriteError`** —— 往 `(agent, contextId)` 分区写、撤（摄取轴）、失效（事件轴）。分区由 `residentRecallScope` 算出，与 sidecar 读的是同一个映射；来源只收 `user` / `agent`。今天唯一的调用方是 `qm memory`（`src/cli/handlers/memory.ts`）；agent 侧写入工具等 P14.4 与 P16.5，复用同一组函数。

用户授权流（P14.3，`authorization-m1.md` §3.4 / §3.5；宿主接线在 P14.4）：

- **`FileGrantStore` / `FileGrantStoreOptions` / `AUTHZ_LEDGER_FILE`** —— 挂起请求与 grant 的持久化状态机，落在 `<config>/resident/authz.ndjson`（hardline 的 `NODE_STATE_DIRS` 已覆盖；构造时若 hardline 不拒这个路径就抛错）。`ask` 记挂起行，`applyDecision` 按「结构 → 绑定 → 时钟 → 审批者集 → 验签 → nonce → ESTOP → 追加」校验，追加是唯一副作用；`use` 先问 hardline、再看 ESTOP、再按摘要找 grant，`allow-once` 的消费先 fsync 再放行；另有 `revoke` / `revokeApprover` / `endContext` / `sweep` / `pending`。坏行或不可能的状态迁移使所有调用拒绝（`integrity`），只有未确认的撕裂尾行被忽略并在下次追加前截掉。
- **`AuthzCall` / `AuthzGrant` / `AskOutcome` / `DecisionOutcome` / `UseOutcome` / `AuthzRefusal` / `AuthzIntegrityIssue`** —— 上述调用的入参与结果类型。签名对象与摘要在 `@qianmo/capability`（`authz.ts`）。

协议级数值一律以 `@qianmo/protocol` 的 `LIMITS` 为唯一出处，本包不复制。

## 3. 最容易被改坏的六条不变式

| # | 不变式 | 改坏了会怎样 | 钉住它的测试 |
| --- | --- | --- | --- |
| 1 | **ack 必须晚于 durable read**：账本三相 `detected → admitted → read` 只能单向推进，`onRead` 是唯一的 ack 钩子（接线在 `src/services/qianmo/resident.ts` 的 `#ackTask`） | 提前发 ack，AC-2 独立核验里「每条 ack 都晚于沙箱内的 durable read」这条就不成立，且崩溃后无法判断消息到底进没进模型输入 | `test/ledger.test.ts`「advances detected to admitted to read without going backwards」；`test/reader.test.ts`「fsyncs detection before prompt and flips read from the admission callback」「the read callback fires after the flip, the terminal one after the turn」 |
| 2 | **turn 在输入被受理之前就结束 = 失败，不是空成功**；取消 / 拒答 / 触顶都是失败；不认识的 stop reason **不许**被编成失败 | 把它们报成 `completed`，请求方会收到一个它区分不出真假的成功 `task.result` | `test/reader.test.ts`「fails promptly when a turn completes before admission」；`test/acp-turn.test.ts`「a cancelled turn is a failed result, not an empty completed one」「refusals and ceiling stops are failures too, not truncated successes」「an unfamiliar stop reason is not invented into a failure」 |
| 3 | **节点级 turn 串行，且失败的 turn 也必须放行下一个** | 并行开 turn 会让同一节点的两个会话互相踩；失败不释放则整个节点在第一个异常上永久停摆 | `test/turn-gate.test.ts` 两条；`test/reader.test.ts`「returns after admission while retaining the gate until turn completion」 |
| 4 | **账本损坏是报错，不是跳过**：`poll()` 一旦查到 integrity issue 直接抛，压实也拒绝在损坏上进行 | 静默跳过损坏行 = 悄悄丢一条已经承诺过要处理的消息，而这正是账本存在的理由 | `test/ledger.test.ts`「reports a torn tail and refuses to compact damage」「rejects malformed records and unknown fields at runtime」 |
| 5 | **定时器从完成处重排、不补跑漏掉的 tick；截止时间按冻结重叠段扣除** | 冻结期间定时器不补跑（E4），补跑会在解冻瞬间打出一串堆积调用；不扣冻结段则所有「距上次多久」的判据会在同一毫秒一起越阈 | `test/poller.test.ts`「reschedules after each completed poll instead of replaying missed ticks」；`test/deadline-clock.test.ts`「the first deadline query after thaw observes the freeze」「excludes only the overlapping parts of multiple freezes」 |
| 6 | **传输回执与协议 ack 是两层，不许合并**（P13.3）：链路回执只承诺「已落盘」，在 `adapter.deliver` 返回处就发；协议 `ack` 承诺「已进模型输入」，仍只在 `markRead` 翻转成功之后由 `#ackTask` 发出。`#receive` **不再 await 轮询** | 合成一层有两种错法，各错一个方向：让回执等 turn ＝ 排队顶穿发送方 5 s 预算，一个忙节点在每个对端眼里等同于失联（H-3 本身）；让 ack 跟着回执提前 ＝ 基座信箱按「丢消息（未读也丢）」执行配额，写完即回的 ack 会替一条可能被驱逐的消息背书 | `src/services/qianmo/__tests__/resident.integration.test.ts`「a second request is receipted inside the budget while a turn holds the gate」（占门时第二条 5 s 内 Accepted，且该 taskId 的 ack **没有**发出）、「an ACP crash while busy comes back as a failed task.result」（回执 Accepted 之后的失败仍从 `task.result` 回去） |

另有两条有专门用例、容易被「优化」掉的性质：**一个 turn 的正文不能漏进下一个**（`test/acp-turn.test.ts`），**未知的受理通知不能翻转任何信箱条目**（同上）。

### 3.1 多会话隔离与会话 GC 的不变式（P13.4）

设计出处：`docs/dev/resident-botization.md` §4.3（hermes C1 / C5 / C6，关 G-5 / G-6，缓解 G-9）。

| # | 不变式 | 改坏了会怎样 | 钉住它的测试 |
| --- | --- | --- | --- |
| 7 | **`sessionKeyOf(agent, contextId)` 是全仓唯一的键构造点**（解析同理，`agentOfSessionKey` / `contextOfSessionKey`） | 第二处拼法不会报错，它只是把一个请求者的 turn 悄悄送进另一个请求者的历史——这正是本模块存在的理由 | `test/session-key.test.ts`「sessionKeyOf is the only place in the repository that builds the key」（含正向对照：先证明扫描规则确实认得那三种手拼形状，再断言全仓零命中） |
| 8 | **无 `contextId` 一律回退 `DEFAULT_CONTEXT`**，且此时行为与多会话之前逐字一致 | 不回退＝所有不带 contextId 的远端请求者塌缩成一条上下文，也就是改造前的状态 | `test/sessions.test.ts`「no contextId lands in the default context, exactly as before」；`test/multi-session.test.ts` 里 `m4` 那条 |
| 9 | **三类永不驱逐**：① 有在途 turn 的（`sessionFor` 取的租约，`release` 还）② 每 agent 最近 N 条（前缀缓存最值钱）③ **账本还有 pending 记录的**（第③条是阡陌特有、最容易漏） | ③ 被漏掉＝把一条已经承诺过要 durable 处理的消息连同它的会话一起丢掉 | `test/sessions.test.ts` 三条负向用例各一；`test/session-gc.test.ts` 的 LRU / TTL / 每 agent 计数 |
| 10 | **`session-store` 到上限先驱逐后写，绝不静默截断**：策略层（manager）先 GC 腾位，存储层越限直接抛 | 静默丢一条映射＝一条活着的 ACP 会话从此没有任何东西指向它，而且没有任何地方会报出来（G-6） | `test/session-store.test.ts`「refuses to grow past the ceiling instead of dropping an entry to fit」；`test/sessions.test.ts`「evicts to make room before writing a new context, never truncating」 |
| 11 | **旧格式 `sessions.json`（`{agent: sessionId}`）必须读得动**，并抬到 `sessionKeyOf(agent, DEFAULT_CONTEXT)` | 拒读＝升级当场丢掉全部会话，这比 fail-closed 想防的那个失败更糟 | `test/session-store.test.ts`「reads the legacy one-session-per-agent file and lifts it onto the default context」 |

两条容易误读的地方：

- **驱逐 = 从映射表删除 + 不再 resume，不删 ACP 侧会话数据**——那是基座的东西，且 `--resume` 还要用。
- **GC 的三个数值全是显式常量**（`DEFAULT_RESIDENT_SESSION_GC_POLICY`），**不做任何 `auto` 推导**（hermes C6：`memory_high_mb: auto` 在 1.9 GB 机上算出 1278 MB，而四台节点里三台是无 sudo 小 VPS）。`lastUsedAt` 的写盘按 60 s 合并，因为它唯一的消费者是一把以小时计的 LRU，每轮 fsync 一次是纯写放大。

### 3.2 队列治理的不变式（P13.3）

设计出处：`docs/dev/resident-botization.md` §4.2(a)。表 #6 是同一批次的另一半（回执解耦，§4.2(b)）。

| # | 不变式 | 改坏了会怎样 | 钉住它的测试 |
| --- | --- | --- | --- |
| 12 | **队列上界只有一个数**：`LIMITS.maxQueuedTurns`，`NodeTurnGate` 直接读它，本包不复制、不允许构造参数覆盖 | 抄一份就会漂——协议里写 32、节点上跑 64，于是发送方按 32 深度估的等待时间是错的，而这个数正是「等多久还值得等」的唯一依据 | `test/turn-gate.test.ts`「refuses at the queue bound instead of growing without one」（深度序列 `0,1,…,32` + 第 33 个被拒） |
| 13 | **过期项在出队时丢弃，且 `work` 从未被调用** | 现状是「信封 timeout 到期发了 `E_TASK_TIMEOUT`，门内的 work 照跑」——节点为一个已经宣告失败的任务烧掉一整个 turn，这是本批次能拿到的最大一笔资源回收 | `test/turn-gate.test.ts` 两条（**spy 断言 work 调用次数为 0，不是断言耗时**）；`test/reader.test.ts`「an entry past its task deadline is never detected, nor blocks the next」 |
| 14 | **队列满的拒绝发生在信箱写入之前**，且按 N-1 降级（对端声明了后 legacy 类型才发 `E_BUSY`，否则 `E_RATE_LIMITED`） | 先写再拒＝refused 吃掉了收件人的信箱配额，把别人的未读挤出去（rule L-1）；不降级＝老对端把整条 `task.result` 判为畸形并拒收，答案根本到不了 | `src/services/qianmo/__tests__/resident.integration.test.ts`「a full turn queue refuses before the mailbox write, downgrading for old peers」 |
| 15 | **同一 `sessionId` 的两个 turn 永不重叠**，且这条断言**不引用门的粒度** | 写成「因为门是全局的所以不会」，将来门变细时它不会红——而那正是唯一需要它红的时刻 | `test/queue-governance.test.ts`「two turns of one session never overlap」（三个 agent 共用一条会话，按 turn 的进出区间判交叠） |

三处容易误读：

- **恢复路径故意不带 `deadlineAt`**。账本里的 `detected` 记录是本节点已经写下的承诺，而账本除了推进到 `read` 没有别的退休方式（`abandoned` 是 P13.5 的）。在那里丢弃 turn 会把记录永久搁浅，此后每次 poll 都重新发现、重新丢弃、重新报错——用一个 500 ms 的错误循环换掉一个 turn，不划算。过期判定因此放在**写任何东西之前**的准入过滤里。
- **`#receive` 问的是 `gate.saturated`，不是接住门抛出来的拒绝**。回执解耦之后，门内抛出的异常已经不可能回到 `#receive`；而「写之前拒绝」与「`#receive` 看得见」这两条要同时成立，只有先问后写这一种写法。门自己的上界仍在，那条是硬不变式，`saturated` 只是发送方听得到的那半。
- **没有优先级轴，FIFO**。值守作业与人工请求谁更急是产品判断，M1 没有判据要求它，加了就得维护一张会长歪的表。

### 3.3 可靠性件套的不变式（P13.5）

设计出处：`docs/dev/resident-botization.md` §3.B（hermes B1 / B2 / B3 / B6 / B10）。四件互不依赖，**共用一条总纪律**：件套自身的读写失败一律 **fail-open**——它们存在是为了让节点少丢东西，绝不能反过来成为节点停摆的原因。

| # | 不变式 | 改坏了会怎样 | 钉住它的测试 |
| --- | --- | --- | --- |
| 16 | **回执不来的 `task.result` 留在台账里，重启后再投且带 `redelivered` 标记**；再投是**新信封**（新 `msgId`、新 `createdAt`、同 `taskId`），不是重传 | 不留＝这条答案**无痕消失**，对端永远等一个没人记得欠它的东西（状态报告点名的唯一无痕丢失产物）；重传原信封＝重启走完后 `deliverTtlMs` 早已过期，只换回一个 `E_TTL_EXPIRED` | `test/delivery-ledger.test.ts` 第一条；`src/services/qianmo/__tests__/resident.integration.test.ts`「an unreceipted task.result is redelivered after a restart, marked as a repeat」 |
| 17 | **再投只由对端的入站接触触发，节点一次都不拨号**（H-2） | 为再投开一条出站连接＝H-2 这条不变式就此作废，而它是整个值守形态的地基 | 同上集成用例（第二段先连上、发一条，owed 的回复才回去） |
| 18 | **`redelivered` 按规则 N-1 降级**：只发给声明了后 legacy 类型的对端 | 比该字段旧的节点用**精确键数**校验 `task.result`，多一个键＝**整条拒收**，那条已经算出来的答案根本到不了（protocol.md §11.3 的陷阱逐字复现） | 集成用例「a peer too old for the marker still gets its answer, without the field」；`packages/protocol/test/message.test.ts`「the redelivery marker」四条 |
| 19 | **同一条毒 `detected` 记录连续 3 次重启后 `abandoned`，而节点照常服务新消息** | 今天这是**无限崩溃循环**：`#recover` 无条件重放 pending 记录，若正是它把节点搞崩，没有任何计数器拦得住。supervisor 的 `maxRapidFailures` 不顶用——它 park 的是**节点**，正是本熔断要避免的结局 | `test/restart-breaker.test.ts`「a poison record is abandoned after three restarts, and the node keeps serving」（末段断言的是**新消息仍被服务**，那才是熔断保护的东西） |
| 20 | **重启计数必须挺过压实**（`recovering` 记录带 attempt，`#apply` 取 max） | 压实丢掉计数＝上限每次重写都归零，毒记录被永远重放——熔断被一次「顺手整理」原地取消 | `test/restart-breaker.test.ts`「the count is durable, so it survives compaction and a reopen」；`test/delivery-ledger.test.ts`「compaction keeps the attempt count」 |
| 21 | **ESTOP 存在即急停：一次 `stat`，空文件与损坏文件同样算 engaged**；拒绝发生在**信箱写入之前**（→ `E_BUSY`，按 N-1 降级）；**在途从不杀** | 读内容再判＝`touch ESTOP`（人拉闸最自然的动作）会被读成「没写理由，继续跑」；先写再拒＝refused 吃掉收件人的信箱配额（rule L-1）；杀在途＝把一个慢答案变成丢答案 | `test/estop.test.ts` 七条（含空文件、损坏文件、「内容说 off 也照样 engaged」）；集成用例「ESTOP refuses new work with E_BUSY, never touches a running turn, and an empty file counts」 |
| 22 | **ESTOP 不在重启时自清**，而 drain 类标记（尚未落地）必须盖实例 epoch | 两者反过来就是 hermes NS-570：一个孤儿标记让实例拒服 52 分钟。暂停**就该**跨重启有效，「排空本实例」**就该**被重启抹掉 | `estop.ts` 类注释把两者的差别写死；`test/estop.test.ts`「it re-reads on every call」 |
| 23 | **`phase=running` 留在盘上 ⇒ 上一条命是被杀的**；读**必须**先于写 | 先写后读＝把要取证的证据当场抹掉；不区分「没文件 / 解析不了」与「被杀」＝唯一的信号被污染，此后没人再信它 | `test/lifecycle.test.ts`「a life that never stamped `stopped` is read as killed」「the read happens before the stamp, or the evidence is erased」「a torn file is unknown, never killed」；真 `qm resident` 进程三条命：`src/services/qianmo/__tests__/resident.integration.test.ts`「`qm resident` prints how the previous life ended: unknown, killed, clean」 |
| 24 | **心跳节奏是代码常量且 ≥ 30 s，没有任何配置能把它变成高频写者**（B8） | 观察类写盘一旦可配，就会有人把它调到秒级，然后与账本的 fsync 抢 IO——而账本那笔才是消息可靠性真正依赖的 | `test/lifecycle.test.ts`「re-stamps no more often than the code constant allows」「the cadence is a code constant of at least 30 s (B8)」 |
| 25 | **不活动看门狗只让 turn **更早**失败，绝不延长任何期限**，且 `reason` 说明是不活动 | 反方向＝节点偷偷续了发送方设的 `taskTtlMs`，从此每个发送方的超时估计都是假的；只报裸超时＝发送方分不出「静默」与「拒答/崩溃」，也就不知道「带更长 `taskTtlMs` 重试」才是该做的事 | `test/inactivity.test.ts` 九条；集成用例「a turn whose ACP side goes silent fails early, and says it was inactivity」 |
| 26 | **件套四件读写失败一律 fail-open**（台账 / 哨兵 / 熔断记录 / ESTOP） | 可靠性件套自己把节点弄停，是它能造成的最坏结果——比它要防的每一种丢失都糟 | `test/estop.test.ts`「a stat that fails for any other reason fails open」；`test/lifecycle.test.ts`「an unwritable path fails open」；`test/delivery-ledger.test.ts`「an unreadable file fails open」「damage is stepped over」；`test/restart-breaker.test.ts`「a ledger that cannot record the attempt fails open」；`test/poller.test.ts`「a predicate that throws fails open」 |

三处最容易误读：

- **投递台账与准入账本对损坏的态度相反，这是刻意的。**准入账本查到 integrity issue 直接抛（不变式 #4）——一条撕裂的准入记录意味着一条已承诺要读的消息可能丢了。投递台账则**记下、报告、跨过去**——一条撕裂的投递记录最多让一条回复多发一次或不发，比「节点拒绝服务」轻。roadmap P13.5 把件套整体放在 fail-open 那一侧。
- **熔断只数 `detected` 记录，不数 `admitted` 的。**B3 要断的环是「重放一个能把节点搞崩的 prompt」，而 `admitted` 记录只剩一次 read 翻转，那条路上已经没有 prompt 了。
- **「3 次重启」与「3 次交接」是同一个数。**计数器数的是**恢复交接**，而一次重启在记录把节点带走时恰好产生一次交接；一条只是让 turn 失败、没能把节点带走的记录，会在原地把三次用完——同一个判决来得更早，同样正确。

### 3.4 主动通知出站的不变式（P13.6）

设计出处：`docs/dev/resident-botization.md` §2（notify 协议面）、§4.1⑤（产出默认静默）、§3.E row E4。

| # | 不变式 | 改坏了会怎样 | 钉住它的测试 |
| --- | --- | --- | --- |
| 27 | **notify 的出站预算是 `NotifyBudget` 滑动窗，不是 `router.outbound()`**（那条会先撞 `RuntimeThrottle` 的 20/min 对偶桶） | 走 `outbound()` ⇒ 协议写着 60/min 而实现最多给到 20/min，一个永远花不完的数字；换成令牌桶 ⇒ 安静一小时后一分钟内放行 2× 上限，正是「把人淹掉」那个失败 | `test/notify.test.ts`「an hour of quiet does not release a batch of two windows」「a shut window stops the drain rather than stepping over it」；`packages/router/test/rate.test.ts` 四条 |
| 28 | **每次重投都取全新 `taskId`**（与 `task.result` 的重投相反） | `notify` 不是 reply 类型，`LoopGuard` 会记 `(to, taskId)`；沿用上一次的 taskId ⇒ 两分钟内的重投被判 `E_LOOP`，被环检测切掉而不是被投递逻辑处理 | `test/notify.test.ts`「a second attempt is marked redelivered and takes a fresh taskId」 |
| 29 | **中枢缺席时落台账、回来后按序排空且不重复**；排空只由对端入站接触触发（H-2 与不变式 #17 同一条） | 不落 ⇒ 值守作业的发现随通道断开无痕消失；乱序 ⇒ 同一作业的两条通知在人眼前颠倒；为排空拨号 ⇒ H-2 作废 | `test/notify.test.ts`「the backlog drains in the order it was made, and only once」「a backlog survives the process that made it」「nothing goes to a peer that has not come back」；`test/no-dial.test.ts` 四条 |
| 30 | **注入给 ACP 会话的工具面只有 `qianmo_notify` 一个，且节点侧根本不存在排程 API**（E4 是结构成立，不是配置成立） | 无人值守的轮次能给自己排更多无人值守的轮次——这条一旦破，节点的产出速率不再有任何上界 | `src/services/qianmo/__tests__/notifyTool.test.ts`「is exactly one tool, and it is qianmo_notify」「carries no scheduling capability, by name or by description」（含诱饵正向对照） |
| 31 | **对端没声明 `notify` 就一条都不发，且不改写成别的类型** | 静默降级成 `task.request` ⇒ 在对端开一个它没要求的 turn，把「能力缺失」偷换成「行为变化」（hermes F3） | `test/notify.test.ts` 两条；`src/services/qianmo/__tests__/resident.integration.test.ts`「a hub that never declared notify is told nothing at all」 |
| 41 | **过程行的 `dedupKey` 只由 `turnStepDedupKey` 拼、只由 `parseTurnStepDedupKey` 读** | `qm watch` 靠这个格式把过程行和 agent 自己发的通知分开（§4.1⑤ 产出默认静默，`docs/dev/console.md` §10.1.3）。另拼一种格式，中枢就会把每个工具步骤都当成给人的通知打印出来 | `test/acp-turn.test.ts`「every step key a turn raises parses back, and nothing else does」；`src/cli/handlers/__tests__/watch.test.ts`「a tool step the node raised is process data, including a failure」；`tests/integration/qianmo-watch-signed.test.ts` |

三处容易误读：

- **`redelivered` 在 notify 上不做 N-1 降级，在 `task.result` 上做**（对比不变式 #18）。不是疏漏：`isNotifyPayload` 用白名单校验，`redelivered` 从 `notify` 诞生那天起就在白名单里，所以「认得类型但不认得该字段」的对端不存在；而 `task.result` 用精确键数校验，多一个键就是整条拒收。
- **谁被通知不由 agent 决定。**工具只交四个字段；收件人、`contextId` 与通道全由宿主从「正在跑的那个 turn 背后的任务」推导（`AcpResidentTurnPort.activeTurn`）。一个能自己填收件人的 agent，就是一个能拿节点凭据给任意对端发消息的 agent。
- **没有网络任务在跑时一律拒绝，不猜。**本地队友信件起的 turn 没有对端，此时挑「最近那个中枢」会把一个 agent 的发现发给一个从没问过的控制台。

### 3.5 记忆接线与无人值守安全的不变式（P13.7）

设计出处：`docs/dev/resident-botization.md` §4.4（hermes D3 / D5 / F9）与 §4.5（hermes E2 / E3 / E5 / E7）。

| # | 不变式 | 改坏了会怎样 | 钉住它的测试 |
| --- | --- | --- | --- |
| 32 | **记忆注入在用户消息里，永不进 system prompt** | 进 system prompt ＝ 每轮重建前缀、每次唤醒作废全部缓存；在 7 天连跑的值守场景里这是纯亏损，且它不会报错，只会变慢变贵 | `test/memory-sidecar.test.ts`「nothing on the resident path routes memory into a system prompt」（扫描 `buildRecallSystemPrompt` 等四种形状，含诱饵正向对照与「render 不是 system prompt」负向对照）；`src/services/qianmo/__tests__/residentPrompt.test.ts`「the sidecar is appended after the batch, inside the same user message」 |
| 33 | **一轮只 recall 一次，产物随 `detected` 记录落盘**；turn 内后续步骤与崩溃后重放读的都是那一份 | 改成实时读 ＝ 同一个 turn 的两步看见两份证据，答案不可复现、不可审计，且可能引用一条它决策时并不在眼前的记录——而 AC-4 要的正是「答案带得出它用了什么」 | `test/memory-sidecar.test.ts`「a memory written mid-turn does not change the prompt the turn is running on」（turn 执行中途写入；断言在跑的 prompt 与账本里那份都不含它，并用「重新 render 能看到」排除假绿） |
| 34 | **作用域是 `(agent, contextId)` 且只取 working 层**；context 半边取自 `sessionKeyOf` 自己的归一化 | 收 project / baseline 层进来 ＝ 一个请求者的记忆露给下一个，正是这条分区要防的；自己再归一化一次 ＝ 记忆分区与会话分区迟早漂开，且漂开时没有任何东西会红 | `test/memory-sidecar.test.ts` 四条（context 之间、agent 之间、缺 contextId、共享层不进注入） |
| 35 | **contextId → 目录名的映射全域且单射**：合法段走 `v-` 前缀、其余走 `d-` + sha256，两支靠**前缀**区分而不是靠形状 | 靠形状区分 ＝ 对端把别人的摘要原样打进来就落进别人的目录；不单射 ＝ 两个 context 共用一个目录，也就是跨请求者串台 | `test/memory-sidecar.test.ts`「a hostile contextId is digested, and stays injective」 |
| 36 | **记忆根必须绝对路径**（hermes F9） | 相对根按 `process.cwd()` 解析，而常驻 turn 的 cwd 就是 agent 所在的仓库——一个提交进仓库的 `memory/` 目录当场变成本节点的记忆 | `test/memory-sidecar.test.ts`「a relative root is refused…」「the sidecar refuses to be built on a store that is not node-owned」「a memory directory planted in the working tree is not recalled」 |
| 37 | **hardline 表求值在 allow 之前，且不从会话配置读取** | 从配置读 ＝ 表的第一项就是 `settings.json`，等于问它保护的文件要不要保护它；排在 allow 之后 ＝ 一条 allow 规则或一个答 allow 的 PreToolUse hook 就能放行表上的任何东西 | `src/services/qianmo/__tests__/residentGuard.test.ts`「a pre-approved write to a protected target is refused anyway」「the allow is never even consulted for a protected target」；`test/guard.test.ts`「neither the table nor its wiring reads configuration」（含诱饵与「点名不等于读取」负向对照）、「the table is frozen」 |
| 38 | **file 与 shell 两面同表封堵**，且只封一面会被用例抓住 | 只封 file ＝ unpaired theater，`Bash` 能 cat / tee / sed -i / rm 掉每一个目标 | `test/guard.test.ts` 逐目标两面各一条 + 「a shell-only spelling is caught, which a file-side-only guard could not be」（裸相对路径，file 面根本不经手）；`residentGuard.test.ts`「the shell surface is refused for the same target as the file surface」 |
| 39 | **注入扫描的对象是组装后的完整 prompt，不是入参** | 逐字段校验答的是「这个字符串干净吗」，而注入是**组装动作本身**造出来的：`from` 只是一个带引号的普通字符串，直到渲染器把它插进 `teammate_id="…"` 那一刻才多出一个属性 | `test/guard.test.ts`「inputs that are clean field by field still assemble into an injection」；`residentPrompt.test.ts` 同名一条（含「中和之后同样的入参组装得干净」的对照） |
| 40 | **远端 `text` / `from` / `summary` 的分隔符在渲染前中和**；命中扫描时**内容 fail-closed、可用性 fail-open** | 不中和 ＝ 一条 `</teammate-message>` 就提前关块，其后的内容读起来像宿主自己的框架；命中后让节点停摆 ＝ 正是攻击者要的结果 | `residentPrompt.test.ts` 四条（伪标签 / 伪记忆块 / 围栏 / CDATA）+「a scan finding withholds the remote content but keeps the node answering」「the withheld stand-in never quotes what triggered it」 |

三处容易误读：

- **`&` 故意不转义。**转义它会让映射严格单射（更整齐），也会把对端发来的每个 `&&` 改坏——而 `&` 变不出 `<` 或 `>`，重建不出任何分隔符。这是排版与可用性的取舍，不是漏掉的一项。
- **hardline 的落点是包裹工具的 `checkPermissions`，不是改 `permissions.ts`。**本构建里能答 allow 的只有两条漏斗，且两条都经过 `checkPermissions`（`hasPermissionsToUseToolInner` 的 1c/1d 在 bypass 模式 2a 与整工具 allow 规则 2b 之上；hook 已答 allow 的那条仍跑 `checkRuleBasedPermissions`）。包一层同时压过两条，而不必在每次上游同步里重解一个热路径核心文件。
- **词法匹配挡不住刻意混淆，这是预批准的天花板不是沙箱。**写进 `guard.ts` 的模块注释里，免得将来有人把它当成越权防护的全部。

### 3.6 生产写入路径的不变式（P16.W）

设计出处：`docs/dev/memory-m1.md` §6.2–§6.4。

| # | 不变式 | 改坏了会怎样 | 钉住它的测试 |
| --- | --- | --- | --- |
| 42 | **写入与召回走同一个分区映射**：`residentMemoryScope` 由 `residentRecallScope` 算出，`contextId` 必须显式给出，空串不算 `default` | 写方自己拼 `{ projectKey, taskId }` ＝ 条目落进一个没有任何 turn 读的目录，运维以为写上了，节点永远看不见，且没有任何东西会红 | `test/memory-writer.test.ts`「an entry written for (agent, context) is what that context recalls」「the scope is the recall scope, for verbatim and digested contexts alike」「an empty context is refused instead of meaning "default"」；`src/services/qianmo/__tests__/residentMemoryWrite.integration.test.ts`（`qm memory add` 子进程 → 真 `QianmoResident` → ACP 子进程收到的 prompt 里有该条目） |
| 43 | **来源只收 `user` / `agent`，改动只许在本分区内**，且「不存在」与「在别的分区」回同一句话 | 放进 `session` / `archive` 等来源 ＝ 条目的信任级由调用方自称；拒绝文案不同 ＝ 只能碰本分区的写方可以借拒绝探测别处的 id（`memory-m1.md` §6.3 缺口 1） | `test/memory-writer.test.ts`「only user and agent provenance is accepted, even from an untyped caller」「an entry of another partition cannot be changed, and the refusal does not say it exists」 |

## 4. 与基座的关系

- **定性：部分**（charter §3.2 R-3，v2.7 定案；P0.2 复核完成）。roadmap P3.1 的 v2.15 勘误把理由改写过一次，结论未变：
  - **唤醒半边零核心改动**——正解是 ACP 自带的 `session/prompt`，不是原文列的四条通道（在 ACP 宿主下一条都不通）。
  - **休眠半边必须改核心**——真正的理由不是「基座没有 idle 事件」（它有四个），而是**基座没有任何进程内扩展点**：插件清单能声明的全是子进程或 Markdown。
- [`base-adoption.md`](../../docs/dev/base-adoption.md) §3.1「休眠与唤醒」判定为**无**（可复用的只有 supervisor 骨架）。
- 代码层面：**本包对基座 `src/` 零 import**——它是端口化的，信箱与 ACP 都是注入进来的。真正的基座核心改动面在 `src/services/qianmo/resident.ts` 与 `src/cli/handlers/resident.ts`（`occ resident`），按章程 T-5 对策④，那些 PR 需注明「为什么扩展点不够用」。
- 外部依赖：`@agentclientprotocol/sdk`（ACP 宿主协议），以及 `@qianmo/protocol` / `@qianmo/transport`。

## 5. 边界与已知未做

- roadmap「完成状态速查」P3.1 行的边界原文：**本包只完成 AC-2 后半（休眠 → 唤醒 → 可响应）；跨节点 ack/result 仍归 P4.1，不在此冒领。**
- 真机验收数据（baseline 2/2 与 candidate 1.1/1.5 各 10/10、accept→first content P95 等）在 roadmap v2.17 与 `demo/p31-resident-wake.sh`，**不在包内**；A/B 只决定了两个专用默认值（resident activity 重连 1.1、宿主 resident keepalive 1.5），通用 transport/协议默认仍为 2。
- 长时驻留的内存与吞吐基线属 **P7.3**，roadmap 完成状态速查 P7.3 行标注「本地腿就绪、正式 24 h / n=100 唤醒 / T3 吞吐数据待真机」。
- `protocol.md` §12.3 第 1 条与本包直接相关：**「轮询循环解冻后是否属热页」是 A 类 ack 成立的关键假设，尚未实测**。

## 6. 怎么跑测试

```bash
bun test packages/resident
```

实测：**153 pass / 0 fail，21 个测试文件**（`acp-turn` / `deadline-clock` / `delivery-ledger` / `estop` / `inactivity` / `ledger` / `lifecycle` / `multi-session` / `no-dial` / `notify` / `poller` / `queue-governance` / `reader` / `restart-breaker` / `session-gc` / `session-key` / `session-store` / `sessions` / `supervisor` / `timings` / `turn-gate`），零 mock；宿主侧接线的集成用例另在 `src/services/qianmo/__tests__/resident.integration.test.ts`（15 条）。

`session-key.test.ts` 会扫全仓源码（`src/**` 与 `packages/*/src|test/**`，跳过 `node_modules` 与 `packages/@ant`），约 3700 个文件、几百毫秒。`no-dial.test.ts` 只扫本包 `src/**` 加宿主两个文件，毫秒级。

## 7. P9.3 双人签字

> owner 栏语义见 roadmap「任务包字段说明」（v2.3）：主开发一律是喻永昌，owner 栏原名单读作「方向辅助人 / 第二知情人」，括号内 backup 读作「第二辅助」。下表按 P3.1 的 owner 栏填名。

| 角色 | 姓名 | 签字 | 日期 |
| --- | --- | --- | --- |
| owner（P3.1 owner 栏） | 董宗岳 | | |
| backup（P3.1 括号内） | 陈子轩 | | |

### backup 需能独立复述的 3 道题

1. 一条网络任务从进沙箱到发出 `ack`，账本上依次会出现哪三条记录？`ack` 挂在哪一步之后、为什么不能提前？如果进程在中间任意一点被 `kill -9`，下一次 `poll()` 会怎么恢复？
2. ACP 的 turn 结束了但输入从没被受理过——这种情况现在算成功还是失败，为什么？再说：一个本版本没见过的 stop reason 应该被当成什么，理由是什么？
3. 常驻宿主为什么是 ACP 而不是基座的 daemon supervisor？「休眠那半必须改基座核心」的真正理由是什么（注意：不是「基座没有 idle 事件」）？
