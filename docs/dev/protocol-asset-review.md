<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 协议资产处置复核（P0.5）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.0** |
| 生效日期 | 2026-08-12 |
| 覆盖阶段 | M0 原型验证期（2026H2）· S0 任务包 P0.5 |
| 撰写 | 喻永昌（项目负责人） |
| 依据 | 范围与法律边界见 [`charter.md`](./charter.md) §5.5；任务包与 DoD 见 [`roadmap.md`](./roadmap.md) P0.5；基座能力盘点见 [`base-adoption.md`](./base-adoption.md) |
| 性质 | 复核记录 + 关系定性。**§6 的定性结论是 P1.1 的直接输入**（roadmap P1.1 交付物明列"新增一节：与基座既有单机信箱机制的关系"） |

**变更记录**

| 版本 | 日期 | 说明 |
|---|---|---|
| v1.0 | 2026-08-12 | 初稿。落实 P0.5 四项交付物：① 逐包复核结论（维持）；② 与基座既有机制的关系定性（**上层封装**）；③ 版权头决定（**加**，已落地 15 个文件）；④ `license` 字段清理（`Apache-2.0` → `MIT`，已落地 2 个文件）。结论已回写章程 §5.5（v2.5） |

**本文性质**

1. 本文是**复核与定性的记录性文档**——不是范围依据，也不是排期依据。范围以 `charter.md` 为准，排期与 DoD 以 `roadmap.md` 为准，**协议级数值上限以 `@qianmo/protocol` 的 `LIMITS` 为唯一出处**。凡本文与上述真源冲突，以真源为准。
2. **本文对基座机制的每一条断言都给出 `文件:行号`**，全部为 2026-08-12 在本仓库工作区实际读码所得。凡未实际验证者一律在 §8 显式标注「未查证」，不以推断充事实。
3. 被引用的是**基座 open-claude-code 自己的代码**（MIT，项目负责人自有）。这不构成对 Anthropic 官方 Claude Code 的源码引用，章程 §5.6② 的「不贴代码」纪律对象不变、强度不变。

---

## 1. 复核结论总表

| # | 复核对象 | 结论 | 状态 |
|---|---|---|---|
| 1 | `@qianmo/protocol` 处置（原样复活并接入 workspace） | **维持**，不推翻 | 无需动作 |
| 2 | `@qianmo/registry` 处置（原样复活并接入 workspace） | **维持**，不推翻 | 无需动作 |
| 3 | `@qianmo/runtime-adapter` 处置（仅取设计不取代码） | **维持**，不推翻 | 无需动作 |
| 4 | 版权头 | **加**（章程 §5.5「提请评审」就此关闭） | 已落地，15 个文件 |
| 5 | 两包 `license` 字段 | `Apache-2.0` → **`MIT`** | 已落地，2 个文件 |
| 6 | **两包与基座既有单机信箱机制的关系** | **上层封装**（对「节点内同队消息」保留纯并存的例外） | 定性完成，落地在 P1.1 |

> 第 3 项不在 P0.5 本次的动作面内（本次未复活、未新增任何 `runtime-adapter` 代码），复核只确认该决议无需推翻：理由在 §6.3——它抽象的运行时层已被基座本体取代，而本次定性恰恰把"节点内运行时"整段留给了基座，`runtime-adapter` 的抽象因此更加没有落点。

---

## 2. 逐包复核（交付物①）：维持

### 2.1 `@qianmo/protocol` —— 维持

复核的实质问题是：**这份协议资产是否与基座重复、是否会与基座打架**。逐条核对后结论是「不重复、不打架」：

| 该包提供的东西 | 基座有没有 | 依据 |
|---|---|---|
| 两级地址 `qianmo://<node>/<agent>`（`address.ts`） | **没有**。基座寻址只有一个裸的 agent 名，无 node 维度 | `packages/builtin-tools/src/tools/SendMessageTool/SendMessageTool.ts:69-73` 的 `to` 只接受「teammate name 或 `*`」 |
| 信封字段 `msgId` / `traceId` / `type` / `ttlMs` / `hops`（`message.ts:40-59`） | **没有**。基座消息只有 `from` / `text` / `timestamp` / `read` / `color?` / `summary?` | `src/utils/agents/teammateMailbox.ts:51-58` |
| 环路检测（`E_LOOP`）与跳数上限（`E_TOO_MANY_HOPS`） | **没有**。全仓 `src/utils/swarm/` 与 `teammateMailbox.ts` 内 `hop` / `loop` 概念零命中 | 见 §4.5 |
| TTL 过期（`E_TTL_EXPIRED`） | **没有**。基座信箱消息不过期，只按条数/字节数压缩 | `teammateMailbox.ts:176-189` 的 `compactMailboxMessages` 只按数量与字节裁剪 |
| 入站速率预算（`E_RATE_LIMITED`） | **没有**。`src/utils/swarm/` 与 `teammateMailbox.ts` 内速率/限流相关标识零命中 | 见 §4.5 |
| 未知收件人报错（`E_UNKNOWN_AGENT`） | **没有**，且是相反行为：向不存在的名字发消息会**静默成功** | 见 §4.3 |

**维持。**推翻的代价（重写一份等价的信封与校验）没有对应收益，且该包 `LIMITS` 四项数值与章程 §3.3 C-4 逐项一致，是 C-4 的唯一出处，推翻会连带动到章程正文。

### 2.2 `@qianmo/registry` —— 维持

| 该包提供的东西 | 基座有没有 | 依据 |
|---|---|---|
| 心跳租约（`lastHeartbeatAt` / `expiresAt`，默认 90 s，`registry.ts:5,180-192`） | **没有**。基座 roster 是 spawn 时写入的静态成员表，只有一个 `isActive?: boolean` 标志，无租约、无过期 | `src/utils/swarm/teamHelpers.ts:74-91`（`TeamFile.members` 定义）、`src/utils/agents/teamDiscovery.ts:52-55`（由 `isActive` 直接推 running/idle） |
| 端点注册（`endpoint` 可为 `qianmo://` 地址或 http(s) URL，`registry.ts:49-59`） | **没有**。基座成员表记的是 `tmuxPaneId` / `cwd` / `sessionId` 这类本机坐标 | `teamHelpers.ts:83-86` |
| 抢注冲突保护（同名不同端点返回 `E_CONFLICT`，`registry.ts:137-143`） | **没有** | 同上 |
| 网络可达的发现接口（HTTP v0，`http.ts:153-179`） | **没有**。基座发现是本机读 `config.json` 文件 | `teamHelpers.ts:124-144` |

**维持。**基座的成员表与本包解决的是两件不同的事——前者是**队伍成员资格**（谁在这个 team 里、UI 怎么画），后者是**存活性租约与可达端点**（现在还能不能寻到、往哪儿投）。两者语义不重叠，不构成"平行抽象"。

**但复核查出该包一处真实缺口**，见 §7 给 P1.1 的输入第 ③ 条：`InMemoryRegistry` 的键是**单段裸名**（`registry.ts:112` 用 `isValidSegment(name)` 校验、`registry.ts:158` 的 `resolve(name)` 按裸名查），**不是** `node/agent` 两级。两个节点各有一个 `reviewer` 时会在同一个注册中心里撞名，而 AC-2 要解析的正是 `qianmo://node-b/reviewer`。这是**维持处置之后要在 P1.1/P2.1 补的功能缺口，不是推翻该包的理由**。

---

## 3. 版权头与 license（交付物③④）

### 3.1 版权头：**加**（章程 §5.5「提请评审」关闭）

- **决定**：给 `@qianmo/*` 全部自有源文件加统一版权头。
- **理由**：风险 L-1（成果认定争议）在章程 §6.2 的评级是高/中；逐文件版权头是软著申请材料的标准实践，且**零运行时成本、零协议影响**。与之相对，"与基座现状一致（不加）"这条理由只在美观上成立，抵不过 L-1。
- **格式**（两行行注释，置于文件最前，与原有模块级 JSDoc 之间空一行）：

  ```ts
  // Copyright 2026 Qianmo AgentNest Team
  // SPDX-License-Identifier: MIT
  ```

- **落地范围**：`packages/protocol/{src,test}` 与 `packages/registry/{src,test}` 下全部 `.ts`，**共 15 个文件**（protocol：`src/` 6 + `test/` 3；registry：`src/` 4 + `test/` 2）。`package.json` / `tsconfig.json` 不加。
- **对后续包的约定**：此后新增的 `@qianmo/*` 源文件一律带头。**本条不追加 CI 断言**——M0 不为一条格式约定新增门禁（章程 N-12 的同类取舍），漏加由 PR 评审兜。
- **v2.18 指针（2026-08-30）**：上条「不追加 CI 断言」已随章程 v2.18 反转；现行口径见 [`charter.md`](./charter.md) §5.5 与门禁 `check:license-headers`。

### 3.2 `license` 字段：`Apache-2.0` → `MIT`

- **决定**：`packages/protocol/package.json` 与 `packages/registry/package.json` 的 `"license"` 改为 `"MIT"`。
- **理由**：章程 §5.5「许可」条已定"自研 `@qianmo/*` 作为 workspace 包随仓库以 MIT 发布，旧版 Apache-2.0 决定作废，S0 内清理"。这是**明列的 S0 清理项**，不是新决定。
- **两包均 `private: true`、不对外分发**，字段不影响任何分发行为；改它是为了让工作区与章程一致，避免答辩/软著材料中出现同一仓库两种许可的可疑面。

---

## 4. 基座既有机制的实际形状（关系定性的事实基础）

> 本节每条断言均给出 `文件:行号`。**这是定性结论的依据，不是对基座的评价**。

### 4.1 信箱是**文件**，不是进程内队列

每个 teammate 有一个磁盘上的收件箱 JSON 文件，路径 `<配置根>/teams/<team>/inboxes/<agent>.json`：

- `src/utils/agents/teammateMailbox.ts:285-295` —— `getInboxPath(agentName, teamName)` 拼出该路径；文件名由 agent 名经 `sanitizePathComponent` 得到。
- `src/utils/config/envUtils.ts:17-19` —— `getTeamsDir()` = `join(getClaudeConfigHomeDir(), 'teams')`。
- `src/utils/config/envUtils.ts:15` —— `getClaudeConfigHomeDir = occConfigDir`，即**配置根经 `src/config/paths.ts` 派生**（`src/config/paths.ts:134-139`）。这一点对阡陌至关重要，见 §6.2 第 2 条。
- 读写：`teammateMailbox.ts:313-336`（`readMailbox`）、`teammateMailbox.ts:362-...`（`writeToMailbox`，经 `lockfile` 串行化 + 临时文件 rename 原子替换，见 `teammateMailbox.ts:156-174, 391-399`）。
- 并发设计意图写在锁选项注释里：`teammateMailbox.ts:32-35` 明言重试退避是为了让"**swarm 中的多个 Claude 进程**"排队等锁而不是直接失败。

### 4.2 消息形状：一个 `text` 字段，协议塞在字符串里

```
TeammateMessage = { from, text, timestamp, read, color?, summary? }
```
（`teammateMailbox.ts:51-58`）

没有 `msgId`、没有 `traceId`、没有 `type`、没有 TTL、没有 `hops`。**基座自己的带内控制协议是把 JSON 塞进 `text` 实现的**：

- `src/utils/swarm/permissionSync.ts:8-18` —— 模块头明写"本系统使用 teammate 信箱传递消息：worker 把权限请求写进 leader 的信箱，leader 把响应写回 worker 的信箱"。
- `SendMessageTool.ts:46-65` —— `shutdown_request` / `shutdown_response` / `plan_approval_response` 是判别联合，作为**消息内容**发送。
- `teammateMailbox.ts:65-82` —— `shouldRetainUnreadAsProtocolMessage` 靠"`text` 看起来像 JSON 且带 `type` 字段"来识别协议消息。

这条事实对定性有直接作用：**把结构化信封序列化进 `text` 不是阡陌发明的绕路，是基座既有且在跑的做法**（见 §6.2 第 3 条）。

### 4.3 「按名寻址」= 名字直接当文件名，无解析、无存活性检查

单播路径**完全不查 roster**：

- `SendMessageTool.ts:159-169` —— `handleMessage` 拿到 `recipientName` 后直接 `writeToMailbox(recipientName, …)`，中间没有任何查找、存在性判断或存活性判断。
- `teammateMailbox.ts:376-389` —— `writeToMailbox` 在加锁前用 `flag: 'wx'` **按需创建收件箱文件**（已存在则吞掉 `EEXIST`）。
- 合起来的行为是：**向一个根本不存在的收件人发消息会静默成功**，返回 `Message sent to X's inbox`（`SendMessageTool.ts:176`），消息落在一个永远没人读的文件里。

只有广播路径读 roster：`SendMessageTool.ts:203-224`（`readTeamFileAsync` → 遍历 `teamFile.members`，跳过自己）。

roster 本体是 `<配置根>/teams/<team>/config.json`：`teamHelpers.ts:117-126`（路径）、`teamHelpers.ts:66-92`（`TeamFile` 结构：`members[]` 带 `agentId` / `name` / `sessionId?` / `tmuxPaneId` / `cwd` / `isActive?` 等）、`teamHelpers.ts:133-144`（同步读）、`teamHelpers.ts:168-172`（写）。

**基座在工具边界上显式拒绝任何带限定符的地址**——`SendMessageTool.ts:599-606`：`to` 含 `@` 直接返回失败，理由写在错误文案里："`to` must be a bare teammate name or `*` — **there is only one team per session**"。这是本次复核最有分量的一条依据：基座不是"碰巧没有节点维度"，而是**在设计上把地址空间关死在裸名上**。推论有两条：① 阡陌的 `qianmo://` 地址**永远不可能**穿过 `SendMessageTool` 这个工具面（含 `://` 与 `/`，且该工具只接受裸名）；② 因此 §6 的入站适配器必须直接调用 `writeToMailbox`，**不能**取道 `SendMessageTool`。

**注意基座还有第二条投递通道**（与本文讨论的信箱无关，勿混）：`SendMessageTool.ts:673-695` 的 `call` 会先查 `appState.agentNameRegistry` / `toAgentId(input.to)`，命中进程内 subagent 任务时走 `queuePendingMessage` 或 `resumeAgentBackground`，**不落盘**；未命中才落到 team 信箱。阡陌不接这条通道。

投递是**收件人轮询**，不是推送，两种形态各有节奏：

- 进程内 teammate：`src/utils/swarm/inProcessRunner.ts:711`（`POLL_INTERVAL_MS = 500`）、`:695`（"Polls the teammate's mailbox every 500ms"）。
- 窗格 teammate（tmux / iTerm2 / Windows Terminal）：`src/hooks/useInboxPoller.ts:261`（`INBOX_POLL_INTERVAL_MS = 1000`）、`:1154`（`useInterval`）。

**进程内 teammate 并没有内存旁路**——它读的是同一个磁盘文件：`inProcessRunner.ts:785-788` 调 `readMailbox(identity.agentName, identity.teamName)`，紧跟的注释 `:791-793` 明写 "readMailbox() already reads all messages from disk"。

### 4.4 作用域边界：**跨进程/跨会话成立，跨主机不成立**

章程 §3.3 C-2 现写"基座的 Agent Teams 有单机 roster 与按名信箱寻址，但**明确不支持跨会话/跨主机寻址**"。**以代码为准，这句话一半属实、一半不属实**：

**「不支持跨主机」——属实。**

- 信箱与 roster 都是本机文件系统路径（`teammateMailbox.ts:285-295`、`teamHelpers.ts:117-126`），没有任何网络传输参与。
- 全部 backend 都是本机形态：`src/utils/swarm/backends/types.ts:12` —— `BackendType = 'tmux' | 'iterm2' | 'windows-terminal' | 'in-process'`。终端复用器与进程内任务，**没有 ssh、没有 socket、没有 HTTP**。
- 地址里根本没有主机维度（`SendMessageTool.ts:69-73`），且带限定符的地址被工具边界硬拒（`SendMessageTool.ts:599-606`，见 §4.3）——**这不是遗漏，是设计**。

**「不支持跨会话」——不属实。**

- teammate 是**独立操作系统进程**：`src/utils/swarm/spawnUtils.ts:22-27` —— `getTeammateCommand()` "Gets the command to use for spawning teammate processes"，默认返回 `process.execPath` / `process.argv[1]`，由 pane backend 在新窗格里拉起。
- roster 逐成员记录各自的 `sessionId?`（`teamHelpers.ts:86`），即成员本来就分属不同会话。
- 信箱的文件锁**就是为跨进程并发写设计的**（`teammateMailbox.ts:32-35`）。
- leader 与 teammate 之间的权限审批往返（`permissionSync.ts:8-18`）本身就是一次跨进程、跨会话的消息往返。

**修正措辞（提请负责人处理，本次未动 §3.3 C-2 原文）**：应为「基座有单机 roster 与按名信箱寻址，**同主机跨进程/跨会话可用**（文件信箱 + 文件锁），但**不支持跨主机寻址**，且地址中无节点维度、投递前无解析与存活性检查」。

> 该措辞不影响 C-2 的「基座起点：部分」判定，也不影响任何 AC 判据——它影响的是 P1.1 与 P2.1 的设计输入：**节点内已经有一条可用的跨进程投递通道，阡陌不需要在节点内再造一条**。这正是 §6 选择「上层封装」而不是「并存」的关键事实。

### 4.5 限额：有配额，无跳数、无环路、无速率

**有的**（`teammateMailbox.ts:44-49`）：

| 常量 | 值 |
|---|---|
| `MAX_MAILBOX_MESSAGES` | 1 000 条 |
| `MAX_READ_MAILBOX_MESSAGES` | 200 条 |
| `MAX_UNREAD_PROTOCOL_MAILBOX_MESSAGES` | 2 000 条 |
| `MAX_MAILBOX_MESSAGE_TEXT_BYTES` | **64 KiB**（超限直接抛错，`teammateMailbox.ts:96-103`） |
| `MAX_MAILBOX_RETAINED_BYTES` | 2 MiB |
| `MAX_MAILBOX_FILE_BYTES` | 4 MiB（读写两侧都断言，`teammateMailbox.ts:138-146, 156-165`） |

**没有的**：跳数、环路检测、速率限制。在 `src/utils/swarm/` 全目录与 `teammateMailbox.ts` 内检索 `hop` / `hops` / `loop_detected` / `loopDetect` 与 `rateLimit` / `rate limit` / `throttle`，**零命中**。这与章程 §3.3 C-4 现有的判定"基座信箱有配额但无跳数与循环概念"一致，本次复核**核实属实**。没有任何机制能阻止 A→B→A 的消息乒乓。

**配额的执行方式是「丢消息」，而且未读消息也会被丢。**每次写入都先压缩再落盘（`teammateMailbox.ts:271-279` 的 `writeCompactedMailbox`），压缩按三档优先级保留——未读协议消息 → 未读普通消息 → 已读消息（`teammateMailbox.ts:198-248`），任何一档超出 `MAX_MAILBOX_RETAINED_BYTES`（2 MiB）就不再保留。被挤掉的未读消息会以 `logError` 记一条（`teammateMailbox.ts:250-269`），**但发送方拿不到任何反馈**。

这条对 §6 的方案有直接约束：**"写进收件箱成功" ≠ "已投递"**，见 §7 输入第 ⑥ 条。

### 4.6 没有回执

`handleMessage` 在文件写完的那一刻就返回 `success: true`（`SendMessageTool.ts:159-186`），与收件人是否存在、是否读到、是否处理无关。**基座没有 ack 概念**。AC-2 要的 60 s 内 ack 回执，在基座这一侧一行现成实现都没有——必须由阡陌协议层产生。

### 4.7 信箱与 roster 都跨进程重启存活，但清理是尽力而为

- **存活**：收件箱与 roster 都是普通磁盘文件（`teammateMailbox.ts:156-174` 原子写、`teamHelpers.ts:168-172` 写 roster），不带 pid、不带 session id 作用域。进程重启后原样还在。
- **清理是尽力而为**：本会话创建的 team 目录注册在一个模块级集合里，由 `gracefulShutdown` 触发 `cleanupSessionTeams()` 删除（`teamHelpers.ts:562-565`、`:578-592`）。模块级集合意味着 `SIGKILL` / 崩溃 / 断电时清理**不会执行**，team 目录连同全部收件箱会留在盘上。

对 §6 的意义是正向的：**阡陌节点不需要为"收件箱在不在"做特殊处理**，它是持久的；同时也提醒 P2.x —— 阡陌节点的 team 目录不应依赖基座的会话级清理来回收。

---

## 5. 阡陌两包的形状（对照）

| 维度 | `@qianmo/protocol` / `@qianmo/registry` | 出处 |
|---|---|---|
| 地址 | `qianmo://<node>/<agent>`，两段各 1–64 字符 `[a-z0-9_-]` | `packages/protocol/src/address.ts:13-21,36-49` |
| 信封 | `v` / `msgId` / `traceId` / `from` / `to` / `type` / `payload` / `createdAt` / `ttlMs` / `hops` | `packages/protocol/src/message.ts:40-59` |
| 消息类型 | `task.request` / `task.result` / `ping` / `pong` / `wake` / `error` | `packages/protocol/src/message.ts:9-22` |
| 上限 | `maxMessageBytes` 256 KiB、`maxHops` 8、`defaultTtlMs` 30 s、`ratePerMinute` 600 | `packages/protocol/src/limits.ts:2-11`（**唯一出处**） |
| 校验 | 结构 + 边界两阶段，错误码 10 种 | `packages/protocol/src/validate.ts:50-232`、`errors.ts:2-23` |
| 注册 | 裸名 → 端点，90 s 心跳租约，抢注冲突保护 | `packages/registry/src/registry.ts:5,81-192` |
| 发现接口 | HTTP v0 over `Bun.serve`，默认绑 `127.0.0.1` | `packages/registry/src/http.ts:153-179,201-223` |
| 纯度 | protocol 无 I/O、无第三方依赖；registry 仅依赖 protocol | `packages/protocol/src/index.ts:1-6`、`packages/registry/package.json` |

**当前接线状态（复核实测）**：两包在仓库内**没有任何外部消费方**——除包自身与包自身的测试外，`@qianmo/protocol` / `@qianmo/registry` / `withHop` 在全仓（排除 `node_modules`）零引用。也就是说，**今天两套机制在物理上完全没有接触面，"打架"尚未发生**；定性要解决的是"接线时按哪种方式接"，不是"现在怎么拆"。

---

## 6. 关系定性（交付物②）：**上层封装**

### 6.1 结论

> **阡陌协议层封装在基座信箱之上：跨节点这一段由 `@qianmo/protocol` + `@qianmo/registry` 全程负责；消息到达目标节点后的「最后一跳」——把内容送进目标智能体的上下文——复用基座既有的文件信箱，不另造。**
>
> **例外（退化为并存的那一部分）**：节点内、同 team 的 teammate 之间的日常消息**原样走基座信箱，不进阡陌协议层**。阡陌不接管它、不代理它、不为它加 trace。

一句话的边界：**阡陌管"跨节点怎么到"，基座管"到了之后怎么进上下文"。**

### 6.2 为什么它们不打架（四条结构性理由，逐条有依据）

1. **命名空间不重叠，且只有一处翻译点。**基座寻址的实际形态是本机路径 `<配置根>/teams/<team>/inboxes/<agent>.json`（§4.1）；阡陌寻址是 `qianmo://<node>/<agent>`（§5）。两者不共用任何标识符空间。把后者翻译成前者的地方**只有一个**——节点入站适配器（P1.1 定义、P2.x 落地）。单一翻译点意味着语义冲突只可能出现在一个文件里，不会弥散。

2. **目录根同源且随身份切换，物理上不可能串台。**信箱根是 `occConfigDir()/teams`（`envUtils.ts:15,17-19` → `src/config/paths.ts:134-139`）。P0.3 的身份隔离已经让阡陌节点态、occ 本体、官方 Claude Code 三者各自拥有独立配置根，因此**阡陌节点的信箱与 occ 本体的信箱天然不是同一批文件**。这条不是约定，是路径派生的必然结果。

3. **"信封序列化进 `text`"是基座既有做法，不是新增的耦合。**基座自己的权限审批、关机请求、plan 审批都是把带 `type` 的 JSON 塞进 `text` 完成的（§4.2），信箱侧还专门有 `shouldRetainUnreadAsProtocolMessage` 识别这类消息并优先保留（`teammateMailbox.ts:65-82`）。阡陌的入站适配器把 `QianmoMessage` 序列化进 `text`，走的是同一条既有通道，**不需要改基座任何一行**。

4. **方向单一，无回调。**阡陌 → 基座信箱是**只写**方向（调用导出函数 `writeToMailbox`）。基座不反向调用阡陌任何东西。ack 与 `task.result` 由阡陌侧的智能体适配层显式发出（因为基座根本没有 ack，§4.6），不依赖基座产生任何事件。这消除了双向依赖，也消除了循环依赖棘轮（`bun run check:cycles`）上的风险。

### 6.3 为什么不是「替换」

- **代价**：要替换就得同时改 `SendMessageTool.ts`（795 行）、`inProcessRunner.ts`（1 656 行）、`permissionSync.ts`（928 行）三处基座核心。
- **牵连面**：基座信箱同时承载**带 UI 耦合的带内控制协议**——权限审批往返（`permissionSync.ts:8-18`）、关机请求/批准（`SendMessageTool.ts:46-65`）、plan 审批。替换信箱等于把这三套流程连同它们的 UI 一起重写，而这些**都不在章程 §3 范围内**。
- **纪律**：直接违反 `CLAUDE.md` §2.3「优先走扩展点，能不改核心就不改」与章程 §6.1 T-5 对策②，把上游漂移面推到最大——而 T-5 正是 M0 已识别的中/中风险。
- **收益**：对 AC-2 / AC-3 的判据**零贡献**。判据要的是跨节点寻址、唤醒、回执、环路切断，没有一条要求节点内消息也走同一套信封。

**否决。**

### 6.4 为什么不是「并存」（纯并列、互不知情）

纯并存的意思是：两套机制各干各的，跨节点消息到达节点 B 之后，由阡陌自己再造一条节点内投递通道，把消息送进目标智能体的上下文。

- 这正是 roadmap P0.5 点名要避免的「**默认叠加**」：基座已经有一条在跑的、经过文件锁串行化的、有压缩与配额策略的节点内投递通道（§4.1、§4.5），再造一条等于**同一个智能体有两个互不知情的收件通道**——它得同时轮询两处，或者我们得改基座让它轮询第二处（于是又回到 §6.3 的改核心）。
- §4.4 的核实结论直接否掉了纯并存的唯一技术理由：如果基座信箱真的"不支持跨会话"，那阡陌为跨进程投递另造一套还情有可原；但**它支持**（同主机跨进程/跨会话本来就在用），所以没有理由不复用。

**否决。**

### 6.5 场景边界表（谁走谁）

| 场景 | 走谁 | 说明 |
|---|---|---|
| 同节点、同 team 的 teammate 互发消息 | **基座信箱原样** | 不进阡陌协议层，不加 trace，不改行为。这是"并存"的例外部分 |
| 跨节点 `qianmo://node-b/<agent>` 的 `task.request` / `task.result` / `ping` / `pong` / `wake` | **阡陌协议层全程** | 校验、限流、环路切断、TTL、审计都在阡陌侧；到达节点 B 后经入站适配器落到该节点的基座信箱 |
| 跨节点消息进入目标智能体上下文的最后一跳 | **基座信箱**（`writeToMailbox`） | 只写方向，不改基座代码 |
| ack / 回执 / `loop_detected` 审计事件 | **阡陌协议层** | 基座没有 ack（§4.6），必须自产 |
| 节点内消息的审计与限流 | **v0 不做** | M0 无判据要求；为统一而改基座核心不划算（N-12 同类取舍） |
| 智能体的注册与存活性 | **`@qianmo/registry`** | 基座 `TeamFile` 继续是基座的内部事务，阡陌不读它、不写它、不同步它 |

---

## 7. 给 P1.1 的输入要点

roadmap P1.1 的交付物明列"新增一节：与基座既有单机信箱机制的关系（替换 / 并存 / 封装，依 P0.5 结论）"。**结论即 §6：上层封装。**除此之外，本次复核查出**七条必须在 P1.1 解决的具体问题**（第 ⑧ 条是无需处理的兼容性事实，一并列出以免将来重查）：

**① 体积上限对不齐（硬冲突，必须在 P1.1 定死处置）**

`LIMITS.maxMessageBytes` = **256 KiB**（`packages/protocol/src/limits.ts:4`），而基座信箱单条消息的 `text` 上限是 **64 KiB**、超限直接抛错（`teammateMailbox.ts:47, 96-103`）。按 §6 的封装方案，信封要序列化进 `text`，于是**一条协议上完全合法的 65 KiB ~ 256 KiB 消息会在最后一跳抛错**。

三条出路，P1.1 必须选一条并写进协议文档：(a) 入站适配器把大 payload 落盘、`text` 里只放引用；(b) 分片重组；(c) 改 `LIMITS.maxMessageBytes`。**注意 (c) 要连带改章程 §3.3 C-4 的数值并升版本号**（`LIMITS` 是唯一出处），不是包内改个常量了事——**本次复核不动数值**。

**② TTL 语义在最后一跳失效**

基座信箱消息**不过期**，只按条数与字节数压缩（`teammateMailbox.ts:176-189`），而 `LIMITS.defaultTtlMs` = 30 s（`limits.ts:8`）。消息落进收件箱后，收件人可能在 500 ms 后读到，也可能在几分钟后读到（`inProcessRunner.ts:695` 的 500 ms 轮询只保证下限）。**TTL 必须由阡陌侧在入站与出站两处自行判定，不能指望基座**。这条与章程 §3.3 C-4 已记的 `ttlMs` 拆分问题（投递时限 / 任务时限）是同一件事的两面，P1.1 一并处理。

**③ 注册中心的键是裸名，撑不住两级地址**

`InMemoryRegistry` 按单段裸名注册与解析（`packages/registry/src/registry.ts:112` 的 `isValidSegment(name)`、`:158` 的 `resolve(name)`），而 AC-2 要解析的是 `qianmo://node-b/reviewer`。两节点同名 agent 会撞名（`registry.ts:137-143` 会把它判成 `E_CONFLICT`，但这是错的语义——它们本来就是两个不同的智能体）。P1.1 定地址语义时必须一并定**注册键**：是 `node/agent` 复合键，还是每节点一个 registry 分区。**这是功能缺口，不是设计错误**——该包设计时还没有 node 维度。

**④ `from` 字段的形态与 `withHop` 的接线**

- 基座 `TeammateMessage.from` 是裸名，且参与 UI 着色查找与消息去重指纹（`teammateMailbox.ts:84-90`）。跨节点消息落进基座信箱时，`from` 放裸名还是放完整 `qianmo://` 地址，P1.1 要定——放完整地址不会破坏任何断言（去重指纹只做字符串相等），但会影响 UI 着色命中。**未查证**：着色未命中时的降级行为（见 §8）。
- `withHop`（`packages/protocol/src/message.ts:105-124`）当前**零生产调用方**（§5 实测）。环路机制要真正生效必须在路由处接线，"函数已经存在"不等于机制已生效。

**⑤ 入站适配器必须直接调 `writeToMailbox`，不能取道 `SendMessageTool`**

`SendMessageTool` 在工具边界上硬拒任何含 `@` 的 `to`，错误文案是 "there is only one team per session"（`SendMessageTool.ts:599-606`，见 §4.3）。`qianmo://<node>/<agent>` 既不是裸名也过不了这道校验。P1.1 的协议文档里应把这条写成明确约束：**阡陌的入站适配器调用的是 `teammateMailbox.writeToMailbox`（导出函数，`teammateMailbox.ts:362-366`），不是那个工具**。这同时也是 §6.2 第 4 条"只写、无回调"能成立的原因。

**⑥ 「写进收件箱」不等于「已投递」——ack 必须端到端**

基座信箱的配额执行方式是**丢消息**，而且**未读消息也会被丢**（`teammateMailbox.ts:198-248` 的三档保留 + `:250-269` 的驱逐日志，详见 §4.5），发送方拿不到任何反馈；再叠加基座本来就没有 ack（§4.6）。因此 P1.1 定 ack 语义时必须写死：**`ack` 由目标智能体的阡陌适配层在真正读到消息之后发出，绝不能由入站适配器"写完文件即回 ack"**。

这条与章程 §6.1 T-1 对策④/⑤（把 ack 与 result 分离、显式区分"触碰旧工作集的 ack"与"不触碰的 ack"）是同一个设计点的两个约束，P1.1 一并落。**注意它对 AC-2 的 10/10 成功率有直接影响**：写完即回 ack 会让一次被驱逐的消息表现为"ack 到了、result 永远不来"。

**⑦ team 名的归一化要钉死（基座既有的不一致）**

基座对 team 名用了**两个不同的净化函数**：roster 目录走 `sanitizeName`（`teamHelpers.ts:102-104`，`replace(/[^a-zA-Z0-9]/g,'-')` **并转小写**），收件箱目录走 `sanitizePathComponent`（`src/utils/task/tasks.ts:311-313`，`replace(/[^a-zA-Z0-9_-]/g,'-')`，**保留 `_` 与大小写**）。名为 `Alpha_Team` 的队伍，config 落在 `teams/alpha-team/`，收件箱落在 `teams/Alpha_Team/inboxes/`。

**限定**：本条由静态读两个函数得出，**未实际执行验证**。对阡陌的处置很简单——**节点内使用的 team 名一律预先归一化为小写、仅含 `[a-z0-9-]`**（阡陌地址段字符集本就更窄），从源头绕开这处不一致，不去改基座。

**⑧ 一条兼容性好消息（无需处理）**

基座把 agent 名当文件名前先过 `sanitizePathComponent`，其实现是 `input.replace(/[^a-zA-Z0-9_-]/g, '-')`（`src/utils/task/tasks.ts:311-313`）。阡陌地址段的字符集是 `[a-z0-9_-]`（`packages/protocol/src/address.ts:13`），是其**真子集**——因此阡陌的 agent 名作为基座收件箱文件名**不会被改写**，不存在"两个不同的阡陌 agent 映射到同一个收件箱文件"的风险。

---

## 8. 未查证 / 开放项

如实列出本次**没有**验证到的点，不以推断充事实：

1. **`findTeammateColor` 未命中时的降级行为**——`SendMessageTool.ts:171` 的着色查找在收件人不在本地 appState 时返回什么、UI 如何呈现，**未查证**。影响面仅限展示，不影响投递。
2. **入站适配器的实际可行性未动手验证**——§6 的封装方案基于对 `writeToMailbox` 导出签名（`teammateMailbox.ts:362-366`）的静态阅读，**未实际写过一行调用代码、未跑通一次端到端投递**。与章程 §3.3 C-3 对基座传输层的态度同理：**可改造性未验证，本文的定性不作为工时承诺**。
3. **基座信箱在阡陌节点态下的行为未实测**——身份切换后 `occConfigDir()` 指向阡陌配置根，信箱路径随之改变（§6.2 第 2 条是路径派生的必然结论），但**未在阡陌身份下实际跑过一次 teammate 消息往返**。
4. **`in-process` teammate 的收件路径已查证、但残留一个小问号**——已确认进程内 teammate 读的就是同一个磁盘文件、没有内存旁路（`inProcessRunner.ts:785-788` 与注释 `:791-793`，见 §4.3）。**残留未查证**的是 `src/tasks/InProcessTeammateTask/types.ts:58-59` 提到的 `teamContext.inProcessMailboxes` 究竟是 UI 侧的另一份镜像还是别的东西。它不影响 §6 的定性（投递路径已确认唯一），若 P1.1 选择 in-process 形态承载阡陌节点内智能体，再查清即可。
5. **§7⑦ 的 team 名净化不一致未执行验证**——由静态读两个函数得出，未实际跑出目录分叉。处置方案（阡陌侧预先归一化）对它是否成立不敏感。
6. **章程 §3.3 C-2 措辞修正未落笔**——§4.4 给出了修正建议，但按本次任务的授权范围，**本次只改章程 §5.5 与版本号/变更记录，C-2 原文一字未动**。修正提请负责人在后续版本处理。
