<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 会话持久化能力核验与常驻缺口清单（P1.2）

| 项 | 内容 |
|---|---|
| 文档版本 | v0.1 |
| 生效日期 | 2026-08-12 |
| 任务包 | [`roadmap.md`](./roadmap.md) **P1.2 🔍 会话持久化能力核验与常驻缺口清单** |
| 判据依据 | [`charter.md`](./charter.md) §4 **AC-1**（本文不复制判据原文之外的任何解释） |
| 协议依据 | [`protocol.md`](./protocol.md) §8 状态机（**本文不改它**，只在它留的闭合点上落定义） |
| 性质 | **核验**，不是实现。基座已有 append-only JSONL 与多个恢复入口，本文回答「它满不满足 AC-1」 |
| 复现 | `bash demo/ac1-restart.sh` |

## 0. 结论摘要

| # | 结论 | 强度 |
|---|---|---|
| 1 | roadmap 关于 `--continue` **无持久化索引、成本随历史线性增长**的判断——**代码与实测都成立** | 代码 + 实测 |
| 2 | roadmap 关于 `--resume <id>` **直接定位**的判断——**成立**，但要加一条限定：**参数必须是 UUID**。传自定义标题会把全量扫描原样带回来，且是**跨 worktree** 的，比 `--continue` 更贵 | 代码（§1.2） |
| 3 | 两个入口都保持 `session_id`，只有 `--fork-session` 换 id——**成立** | 代码 + 实测 |
| 4 | 半写行的读取侧容错——**成立**，位置在 `src/utils/text/json.ts`，不是会话模块里 | 代码 + 实测 |
| 5 | AC-1 的「≤ 10 s」在两个历史规模点位上都**大幅达标**：历史放大后 `--resume` 的加载耗时仍是**几十毫秒**（7 → 24 ms），而 `--continue` 涨到 **474 ms**（18 → 474 ms） | 实测 |
| 6 | `kill -9` 三个崩溃点后**磁盘无损坏、`session_id` 不变、无悬空 `tool_use`** | 实测 |
| 7 | **新发现的缺口**：`--resume <id>` 在**时间戳并列**时会丢掉尾部消息（本次实测每次丢 3 条）。`--continue` 不受影响。这是我们钉死的那个入口上的问题，必须处置。**（已过期注，2026-08-16）**：已由提交 `3e7a401` 修复并列为 roadmap 速查表 P1.2 行的证据；`acceptance-m0.md` §8.4 复核 `WARN=0` | 实测 + 代码（§1.5） |
| 8 | AC-1 的「不重放历史即可续答」**需凭据，未测**。**（已过期注，2026-08-16）**：已于 2026-08-12 补测通过（roadmap v2.13）；本机腿走查中该判据脚本内恒 SKIP，现场留档见 `acceptance-m0.md` §4.3 | — |

**一句话**：基座的会话持久化足以支撑 AC-1 的时限与 `session_id` 两条判据，且余量很大；真正要补的既不是解析器也不是性能，而是**两处语义**——`--resume` 的锚点选取（§1.5）与崩溃丢失窗口的协议含义（§3）。

---

## 1. 两条 roadmap 修正的代码核实

方法：**以代码为准**。roadmap 与本节冲突处，本节给出 `文件:行号`。

### 1.1 `--continue`：确实无索引，确实是「readdir + stat 每个文件 + 读尾部」

调用链（每一环都核实过）：

| 环 | 位置 | 干了什么 |
|---|---|---|
| CLI 入口 | `src/cli/program/rootAction.tsx:2419-2429` | `--continue` → `loadConversationForResume(undefined, undefined)` |
| 分支 | `src/utils/session/conversationRecovery.ts:508-535` | `source === undefined` 这一支，注释原文就是 `// --continue: most recent session` |
| 列表 | `src/utils/sessionStorage/sessionListing.ts:118-135` | `loadMessageLogs()`，**不带 limit** |
| 扫盘 | `sessionListing.ts:54-61` → `sessionDiscovery.ts:564-605` | `getSessionFilesLite`：**readdir 整个项目目录** |
| stat | `sessionDiscovery.ts:117-160` | `getSessionFilesWithMtime`：对**每一个** `.jsonl` 做 `stat`（`Promise.all` 并发，但一个都不少） |
| 读尾部 | `sessionListing.ts:122-126` | `enrichLogs(sessionLogs, 0, sessionLogs.length)`——**count = 全部**，不是分页 |
| 实际读 | `sessionDiscovery.ts:612-659` → `:330-404` → `src/utils/session/sessionStoragePortable.ts:213-240` | 每个文件 `open` 一次，读**头 64 KiB + 尾 64 KiB**（`LITE_READ_BUF_SIZE = 65536`，`sessionStoragePortable.ts:17`） |
| 串行 | `sessionDiscovery.ts:666-693` | `enrichLogs` 是 `while` + `await`，**逐个文件串行** |

**「没有持久化索引」核实到底**：全仓检索 `sessionIndex` / `session-index` / `SESSION_INDEX`——**零命中**。`sessionDiscovery.ts:292` 那个 `getLogsWithoutIndex` 的函数名与它的文档注释（"bypassing the session index"）是**遗留命名**，本仓库里并不存在它所说的那个索引。

> **修正一条 roadmap 的措辞**：roadmap P1.2 写「成本随历史线性增长」。更准确的说法是——`--continue` 的成本随**项目目录下的会话文件数**线性增长，与**当前会话本身有多长**基本无关。这个区别对常驻节点是实质性的：常驻节点复用同一个 `session_id`，它的会话文件会变大，但**文件数**是被每次冷启动/分叉推高的（见 §4 G-5）。

### 1.2 `--resume <id>`：直接定位——但只有传 UUID 时才是

| 环 | 位置 | 干了什么 |
|---|---|---|
| CLI 入口 | `src/cli/program/rootAction.tsx:2695` | `maybeSessionId = validateUuid(options.resume)` |
| **UUID 分支** | `rootAction.tsx:2990-2997` | 直接 `loadConversationForResume(sessionId, undefined)` |
| 定位 | `conversationRecovery.ts:543-546` → `sessionStorage/logAssembly.ts:459-474` | `getLastSessionLog(sessionId)` → `loadSessionFile(sessionId)` |
| 拼路径 | `sessionStorage/transcriptLoader.ts:741-745` | `join(projectDir, ` `${sessionId}.jsonl` `)`——**一次 join，一次 open，不 readdir、不 stat 兄弟文件** |

**必须补上的限定**：`--resume` 的参数**不是 UUID** 时走的是完全不同的一条路——`rootAction.tsx:2713-2730` 调 `searchSessionsByCustomTitle`，而它（`sessionListing.ts:70-111`）先 `getStatOnlyLogsForWorktrees`（**跨 worktree 的全量 readdir**，`sessionDiscovery.ts:42-110`）再 `enrichLogs(allStatLogs, 0, allStatLogs.length)`（**全量 enrich**）。

> **这是本节最重要的一条**：roadmap 只写了「恢复入口钉死 `--resume <id>`」。按代码，正确的表述是「**钉死 `--resume <UUID>`**」。若常驻节点为了可读性用自定义标题恢复，`--continue` 的线性成本会原样回来，而且因为跨 worktree**更贵**。落地时节点启动参数必须是 UUID，不能是标题。

### 1.3 两个入口都保持 `session_id`，只有 `--fork-session` 换 id

`src/utils/session/sessionRestore.ts:422-438`：

```
// Reuse the resumed session's ID unless --fork-session is specified
if (!opts.forkSession) { ... switchSession(asSessionId(sid), ...) }
```

`--continue`（`rootAction.tsx:2437-2445`）与 `--resume`（`:3008-3014`）都走同一个 `processResumedConversation`，`forkSession` 都取自同一个 CLI 开关。`--fork-session` 分支（`sessionRestore.ts:439-450`）**保留新进程的全新 id**。实测见 §2.2。

### 1.4 半写行的读取侧容错在哪

**不在会话模块里，在通用 JSONL 解析器里**：

- `src/utils/text/json.ts:129-153`（Buffer 路径）与 `:155-175`（string 路径）：逐行 `JSON.parse`，`catch { /* Skip malformed lines */ }`。
- `src/utils/text/json.ts:102-127`：Bun 的 `Bun.JSONL.parseChunk` 快路径出错时，跳到下一个 `\n` 继续解析，把已解析的部分留下。
- 上游调用者 `sessionStorage/transcriptLoader.ts:538` 的 `parseJSONL<Entry>(buf)`，外面还套了一层 `try { ... } catch {}`（`:440, 613-615`）。

> 因此 roadmap 的判断成立：**「补一个容错解析器」不需要做**。实测见 §2.5。

### 1.5 与 roadmap 记载不符 / 需要补强的三处

| # | roadmap 记载 | 代码事实 | 处置 |
|---|---|---|---|
| 1 | 「恢复入口钉死 `--resume <id>`」 | 只有 **UUID** 参数才直接定位；非 UUID 触发跨 worktree 全量扫描 | 落地时钉死 UUID（§1.2）。**不改 roadmap**，请负责人决定是否回写 |
| 2 | 「成本随历史线性增长」 | 精确地说是随**会话文件数**，不是随当前会话长度 | §1.1 已澄清；影响 §4 G-5 的处置方向 |
| 3 | （未提及） | **`--resume <id>` 在时间戳并列时丢尾部消息** | 见下，列入 §5 后续动作第 1 条 |

**第 3 条展开**（这是本次核验最实质的发现）：

- `insertMessageChain` 在 `...message` 展开**之后**无条件覆盖时间戳：`src/utils/sessionStorage/transcriptWriter.ts:857-883`（`timestamp: new Date().toISOString()` 在 `:879`）。消息自己带的时间戳到不了磁盘，**同一次 `recordTranscript` 写出的条目因此共用一个毫秒**。
- `--resume` 的锚点：`logAssembly.ts:487` 的 `findLatestMessage(messages.values(), m => !m.isSidechain)`，而 `findLatestMessage`（`logAssembly.ts:27-42`）用 **`t > maxTime` 严格大于**——并列时**保留先出现的那条**（Map 迭代序 = 文件顺序）。
- `--continue` 的锚点：`loadFullLog`（`logAssembly.ts:343-390`）把候选集**限定在 `leafUuids`（链尾）**，正常情况下只有一条，因此不受并列影响。
- 后果：一次写出 k 条消息、且它们落在时间戳最大值上时，`--resume` 的锚点退到这 k 条里的**第一条**，其后的 **k−1 条进不了会话链**。

实测（§2.6）：目标会话每片 4 条，`--resume` 每次少 3 条真实消息。**常驻节点每次唤醒都要 resume 一次，这个丢失会累积。**

---

## 2. AC-1 三条判据的实测

### 2.0 方法与安全边界

- **入口**：全部走基座**自己的**函数，不写替身实现——`recordTranscript` / `flushSessionStorage` / `recordFileHistorySnapshot` 写，`loadConversationForResume` 读，参数形态与 CLI 分支一一对应（`conversationRecovery.ts:508-550`）。
- **隔离**：全程 `OCC_CONFIG_DIR` 指向 `mktemp -d` 出来的临时配置根，**不读写用户真实的 `~/.occ` / `~/.qianmo`**。
- **凭据**：**全程不读取任何凭据、不发起任何模型 API 调用**。因此 AC-1 的第二条判据只能标「需凭据，未测」（§2.7）。
- **合成历史**：`demo/lib/ac1-gen-history.ts` 生成，不手写 JSONL。
- **环境**：`bun 1.3.13`，`Darwin 25.5.0 arm64`（macOS）。**未在 Linux 上复测**（见 §6）。

复现：`bash demo/ac1-restart.sh`。下面所有数字都来自 2026-08-12 的完整运行，**逐条为脚本真实输出，无一条为估算**；耗时类数字的 run 间抖动见 §2.3 末尾。整体结果：`PASS=22  FAIL=0  WARN=2  SKIPPED=1`。

### 2.1 两个历史规模点位

| 点位 | 项目目录下会话文件数 | 目标会话消息数 | 目标会话文件大小 | 项目目录总量 |
|---|---|---|---|---|
| small | 5（各 40 条） | 200 | ~0.25 MB | ~1.5 MB |
| large | **1000**（各 40 条） | **3000** | **3,710,149 B ≈ 3.54 MiB** | **54 MB / 1001 个文件** |

> large 点位的目标文件 3.54 MiB，**没有越过** `SKIP_PRECOMPACT_THRESHOLD = 5 MiB`（`sessionStoragePortable.ts:478`），因此大文件的「跳过压缩边界前内容」那条路径**本次未被触发**——列入 §6 未查证项。

### 2.2 判据一：`session_id` 一致性 —— **达标**

```
PASS: [small] --resume 保持 session_id（bb000000-0000-4000-8000-00000000000f）
PASS: [small] --continue 保持 session_id（bb000000-0000-4000-8000-00000000000f）
PASS: [large] --resume 保持 session_id（bb000000-0000-4000-8000-00000000000f）
PASS: [large] --continue 保持 session_id（bb000000-0000-4000-8000-00000000000f）
```

三个 `kill -9` 崩溃点之后同样保持：

```
PASS: write: session_id 一致（aa000000-0000-4000-8000-000000000001）
PASS: snapshot: session_id 一致（aa000000-0000-4000-8000-000000000002）
PASS: tool: session_id 一致（aa000000-0000-4000-8000-000000000003）
```

### 2.3 判据三：「启动到可接收新消息 ≤ 10 s」 —— **达标，余量很大**

```
  [small] --resume    wall=0.439s  loadMs=7    messageCount=198
  [small] --continue  wall=0.663s  loadMs=18   messageCount=200
  [large] --resume    wall=0.468s  loadMs=24   messageCount=2998
  [large] --continue  wall=0.900s  loadMs=474  messageCount=3000
  {"resumeLoadGrowth":3.43,"continueLoadGrowth":26.33,"continueGrowsFaster":true}
PASS: [small] --resume 冷启动到会话就绪 0.439s ≤ 10s
PASS: [large] --resume 冷启动到会话就绪 0.468s ≤ 10s
PASS: 历史放大后 --continue 的加载成本涨得比 --resume 快（与钉死 --resume 的理由一致）
```

读法：

- `wall` 是**冷进程**墙钟：bun 启动 + 模块加载 + 会话加载。其中约 **0.42 s 是与历史无关的公共底噪**（模块加载），两个入口共享。
- `loadMs` 是进程内计时的**纯加载耗时**，剔掉了底噪——**只有这一项随历史增长**。
- 历史从 small 放大到 large（会话文件数 ×200、目标会话 ×15）：**`--resume` 的加载耗时 7 ms → 24 ms**，**`--continue` 18 ms → 474 ms**。

> **run 间抖动**：连续三次运行里，`--resume` 的 `loadMs` 在 **7 ~ 15 ms**（small）与 **24 ~ 25 ms**（large）之间；`--continue` 在 **18 ~ 23 ms**（small）与 **438 ~ 474 ms**（large）之间。绝对值抖，**两条曲线的分离是稳定的**——这是本节唯一要下的结论。因此上面那个 `resumeLoadGrowth` 比值（1.6 ~ 3.4）**不要单独引用**：它的分母只有个位数毫秒，抖动会把比值放大。

**这就是钉死 `--resume` 的实测依据**：`--continue` 的曲线是「跑得越久越慢」，而验收现场看到的是一次性快照——最难解释的失效方式正是这种。按本次曲线外推，`--continue` 要撞 10 s 需要约两万个会话文件量级；**外推值不是实测值**，不得引用为结论（§6）。

> **口径声明（重要）**：本节的 `wall` **不是 occ CLI 的完整启动时间**。真实 CLI 还要挂 TUI、跑认证、起 MCP server。AC-1 的 10 s 预算里，本文测的是**会话恢复这一段**；**完整启动时间未测得**（需要构建产物 + 凭据，见 §6）。结论只敢下到这一步：**会话恢复不是 10 s 预算的瓶颈，量级上差两个数量级。**

### 2.4 `kill -9` 三个崩溃点 —— **一致性达标**

`demo/lib/ac1-crash-writer.ts` 制造现场，退出码全部 `137`（= 128 + SIGKILL）。

| 崩溃点 | 现场构造 | SIGKILL 来源 | 结果 |
|---|---|---|---|
| **写事件中** | 前 4 条已落盘；再 2 条**已入写队列、未 drain**（`FLUSH_INTERVAL_MS = 100`，`transcriptWriter.ts:307`） | 被测进程在同一 tick 内自投（要卡进 100 ms 窗口，从 shell 发信号赢不了竞态） | 4 条可读回，2 条丢失，**0 条损坏行** |
| **快照中** | `recordFileHistorySnapshot` 已入队未落盘 | 同上 | 4 条可读回，快照丢失，**0 条损坏行** |
| **工具执行中** | 带 `tool_use` 的 assistant 已落盘（磁盘上 `rawToolUse=1, rawToolResult=0`），`tool_result` 永不写出 | **外部 `kill -9 <pid>`**（该点状态静止，无竞态） | 读回后 **`danglingToolUse=0`** |

```
  崩溃点 write: 退出码 137（137 = 128+SIGKILL）
  {"sessionId":"aa...001","found":true,"messageCount":4,"rawLines":4,"rawBytes":3110,"malformedLines":0,...}
  崩溃点 snapshot: 退出码 137（137 = 128+SIGKILL）
  {"sessionId":"aa...002","found":true,"messageCount":4,"rawLines":4,"rawBytes":3110,"malformedLines":0,...}
  外部 kill -9 40615
  崩溃点 tool: 退出码 137（137 = 128+SIGKILL）
  {"sessionId":"aa...003","found":true,"messageCount":4,"rawLines":5,"rawBytes":4212,"malformedLines":0,"rawToolUse":1,"rawToolResult":0,"loadedToolUse":0,"danglingToolUse":0}
```

三点说明：

1. **「无悬空 `tool_use`」是硬要求**，不是锦上添花：未配对的 `tool_use` 会被模型 API 直接拒绝，恢复出来的会话根本发不出去。基座在 `conversationRecovery.ts:183-185` 的 `filterUnresolvedToolUses` 里处理掉了，实测 `loadedToolUse=0`（那条 `tool_use` 连同它所在的 assistant 消息一起被滤掉）。
2. **SIGKILL 一定会跳过 flush**：基座把 flush 注册成退出清理钩子（`transcriptWriter.ts:186-201`），`kill -9` 一律绕过——这正是丢失窗口存在的原因（§3）。
3. **三个崩溃点在本平台上都没有产生半写行**：`appendFile` 的写由内核整体完成，进程被杀不会把一行撕开。半写行的容错另测（§2.5）。

### 2.5 半写行容错 —— **达标**（人为制造）

既然 `kill -9` 本身撕不开一行，就按字节把最后一行截半（断电 / 满盘 / NFS 会产生这种形态）：

```
  {"sessionId":"aa...001","found":true,"messageCount":4,"rawLines":4,"rawBytes":2910,"malformedLines":1,...}
PASS: 截断确实造出了半写行（1 条）
PASS: 半写行不影响其余消息读回（4 条）
PASS: 半写行下 session_id 仍一致
```

> 注意 `messageCount` 仍是 4：被截断的那条本来就是最后一条的一部分，其余 4 条完好，且 `--resume` 的返回里补了一条合成 sentinel（`conversationRecovery.ts:222-241`）。**「丢」的形态是截断，不是错乱**——这一点是 §3 语义成立的前提。

### 2.6 顺带实测出来的缺口：时间戳并列丢尾部

```
=== 4c. 已知缺口：时间戳并列时 --resume 会丢掉尾部消息 ===
  [small] --resume 读回 198 条，--continue 读回 200 条
WARN: [small] --resume 比 --continue 少 2 条
  [large] --resume 读回 2998 条，--continue 读回 3000 条
WARN: [large] --resume 比 --continue 少 2 条
```

算细账（small 点位，每片 4 条）：200 条的下标 0..199，最后一片是 196..199 共用一个毫秒 → `--resume` 锚点退到 196（user 消息）→ 会话链 0..196 共 197 条 → 因为末条是 user，补 1 条 sentinel → **198**。`--continue` 锚点是链尾 199（assistant）→ **200**，不补 sentinel。**真实丢失是 3 条**，显示差 2 条的那 1 条差额来自 sentinel。

机理与出处见 §1.5。处置见 §5 A-1。

### 2.7 判据二：「不重放历史即可续答」 —— **需凭据，未测**

```
SKIPPED: needs model credentials
```

**未测原因**：该判据要求重启后直接追问「继续刚才那步」，并检查回答里引用了**只有重启前上下文才知道的项目细节**。这必须真调模型 API，本次执行环境无可用凭据，且本任务明令不得读取或使用任何凭据。

**测它需要什么**（交给有凭据的执行者）：

1. 一个可用的模型供应商凭据（`occ` 已登录，或供应商 API key）。
2. 一次**真实的**多轮任务现场——必须包含至少一个「只有跑过才知道」的项目细节（例如某个文件里的具体函数名、某次工具调用的具体输出），否则模型可以靠常识蒙对，验收就失去判别力。
3. 步骤：跑到多轮中途 → `kill -9` → `occ --resume <UUID>` → **不重放任何历史**，直接问「继续刚才那步」 → 比对输出是否引用了那个细节。
4. **同时记录完整的进程启动墙钟**（本文 §2.3 只测了会话恢复这一段）。
5. 建议一并覆盖 §2.6 的并列缺口：现场若命中，恢复出来的会话会缺尾部消息，「续答」可能悄悄基于一个更早的上下文——**这正是最难在验收现场解释的那类失效**。

---

## 3. 丢失窗口语义（与 `protocol.md` §8 对齐）

### 3.1 窗口是什么，有多大

| 事实 | 出处 |
|---|---|
| 转录条目先进**进程内写队列**，由定时器批量落盘 | `transcriptWriter.ts:366-393`（`enqueueWrite`）、`:395-422`（`scheduleDrain`） |
| 定时器周期 **100 ms** | `transcriptWriter.ts:307` `FLUSH_INTERVAL_MS = 100` |
| 落盘就是一次 `appendFile`，**没有 fsync** | `transcriptWriter.ts:424-433` |
| flush 挂在退出清理钩子上，**SIGKILL 一律绕过** | `transcriptWriter.ts:186-201` |
| 队列超过 1000 条会**丢弃最旧的**并 reject | `transcriptWriter.ts:373-383` |

**所以**：`kill -9` 的丢失窗口 = **最多一个 100 ms 的批次**（外加正在 drain 的那一批的剩余部分）。因为没有 fsync，「落盘」的强度是**进程崩溃安全，不是整机掉电安全**——已 `appendFile` 的字节留在 page cache 里，进程被杀不丢，宿主掉电会丢。**AC-1 的口径是 `kill -9`，本文的语义按这个口径定；掉电不在其内**（§4 G-8）。

### 3.2 关键区分：丢的是「转录」，不是「信箱」

阡陌最后一跳落在基座信箱（`protocol.md` §9），而信箱与会话转录是**两套存储、两套写入路径**：

- 信箱写入是**临时文件 + `rename` 原子替换**（`src/utils/agents/teammateMailbox.ts:156-174` 的 `writeMailboxAtomic`），且在文件锁内**立即**执行——投递（`:370-424`）与 `read` 翻转（`markMessageAsReadByIndex`，`:440-496`）都走这条路。**没有 100 ms 缓冲。**
- 会话转录写入才是上面那个带缓冲的路径。

**因此丢失窗口的真正后果不是「消息没了」，而是两个存储错位**：信箱里那条消息可能已经是 `read: true`（于是阡陌侧的 A 类 ack 已经成立并已回程，`protocol.md` §8.2 迁移 16），而**会话转录里没有它**——处理方重启后，对话上下文里不记得收到过这条消息。**这比丢消息更危险，因为它不触发任何超时。**

### 3.3 语义定义（五条，全部落在 `protocol.md` §8 已有的迁移上，不新增状态、不新增错误码）

> `protocol.md` §8.3 的「⑤ 异常退出 / 崩溃瞬间的丢失窗口」一行写的是：「发送方由 7 / 12 / 18 转 `expired` 后按 at-least-once 重投；两级去重保证幂等」，并注明「P1.2 的『丢失窗口语义』在此闭合」。以下五条就是那个闭合，**与该行一致，并把 §3.2 那种「已 ack 但转录缺失」的情形显式挂到已有的迁移 21/22 上**。

**L-1 — 丢失窗口内的转录缺失，等价于「处理方重启后无该任务记录」。**
不新造状态。它命中的是 `protocol.md` §8.2 的**迁移 22**（`acked` → `failed`，「处理方进程异常退出且重启后无该任务记录」），并由**迁移 21**（任务时限到期，`E_TASK_TIMEOUT`）兜底。理由：这条消息可能已经 `acked`（§3.2），走 7 / 12 / 18 的投递时限那三条线**已经来不及了**——投递时限的终点就是 `acked`（`protocol.md` §5.1），已 `acked` 的消息不会再被投递时限管住。**能兜住它的只有任务时限。**

**L-2 — 消息**是否重投**：重投。**
触发者按消息死在哪一段分两种，**两种都已在 §8 里有迁移，不需要新增**：

| 死亡位置 | 发送方看到的 | 迁移 | 回执 |
|---|---|---|---|
| 还没进信箱（transport 或入站适配器侧） | 投递时限到期 | 7 / 12 / 18 → `expired` | `E_TTL_EXPIRED` |
| 已进信箱、甚至已 `acked`，但转录落在丢失窗口里 | 任务时限到期、无 `task.result` | 21（22 兜底）→ `timeout` | `E_TASK_TIMEOUT` |

**L-3 — 发送方**如何得知**：只通过那两条时限线，不新增任何通知机制。**
明确**不做**「接收方重启后主动告知丢了什么」。理由是硬的：**接收方按定义不知道自己丢了什么**——丢的东西在进程内存队列里，随进程消失，磁盘上不留任何痕迹。要让它知道，就得先同步落盘（fsync）或上 WAL，那是把持久化等级整体抬一档，与 M0 范围不匹配（章程 §3 未列入）。**在 M0 内，「丢了这一小段」对发送方的唯一可观测形式就是超时。**

**L-4 — 是否计入 at-least-once 的保证范围：计入。**
at-least-once 的保证边界是「发送方重投直到收到 A 类 ack 或落到某个终态」，接收方的丢失窗口是它**要覆盖的失效之一，不是例外**。幂等仍由 `protocol.md` §7.2 的两级去重承担：重传用同一 `msgId`（一级），发送方崩溃重启后重新构造的信封用 `fingerprint`（二级）。

> **对 P4.2 的告诫（务必写进去重表的实现说明）**：两级去重表**当前不跨进程持久化**（`protocol.md` §7.2 只规定了以投递时限为表项 TTL，没规定持久化）。这恰恰是 L-1 能成立的前提——处理方崩溃重启后去重表是空的，重投才会被**真正执行**而不是被幂等挡回去回带一个并不存在的「首次结果」。**若将来为了跨重启抵御重复而把去重表持久化，必须同时持久化「首次结果」**，否则会造出「记得见过、不记得结果」的死角：重投被吸收，结果永远回不来，只能等任务时限。

**L-5 — 时间跳跃闸门 T-2 不适用于崩溃重启。**
`protocol.md` §5.3 的 T-2 闸门是为**沙箱解冻**设计的（重置本节点持有的**全部在途消息**的截止时间基准）。崩溃重启**不得**套用它：重启后的节点**根本没有在途消息表**（它在内存里，随进程消失），闸门无事可重置；把重启也塞进闸门，只会让本该超时的消息凭空多活一个宽限窗口。**这条是防误用的，不是新机制。**

### 3.4 一致性边界：丢失只会是截断，不会是错乱

§2.4 三个崩溃点实测**磁盘 0 条损坏行**；即便人为撕出半写行，读取侧也只是跳过它（§2.5）。append-only + 跳过坏行 ⇒ **丢的形态永远是「尾部截断」**。

这是 L-1 ~ L-4 成立的地基：截断语义下，「丢了这一小段」= 「这一小段从未发生」，接收方重启后处在一个**合法的、更早的**状态，重投可以安全地把它推回去。若丢失可能表现为**错乱**（半条消息被当成完整消息读进来），重投就不再安全，整套 at-least-once 都要重新论证。

### 3.5 与 `protocol.md` 的关系

**本文不改 `protocol.md`。** §8.3 已为本包留了闭合点，本节就落在那个点上：**没有新状态、没有新终态、没有新错误码、没有新计时线**。若负责人认为 §8.3 那一行需要补一个指向本文的指针，列在 §5 A-3——**指针不复制**，内容留在本文一处。

---

## 4. 常驻化缺口清单（输出给 P3.1）

基座的会话是**交互进程内**的。常驻节点比它多要下面这些东西。每条写清「缺什么 / 为什么 / 在哪补」。

| # | 缺什么 | 为什么（出处） | 在哪补 |
|---|---|---|---|
| **G-1** | **「上次是崩溃还是干净退出」的标记** | 基座只有一个 worktree 维度的近似物：`currentSessionWorktree` 三态（`transcriptWriter.ts:281-284`），由退出清理钩子写 `null`；`kill -9` 绕过钩子 ⇒ 转录里没有任何「上次怎么结束的」痕迹 | **阡陌侧的节点状态文件**（不要塞进基座转录）。P3.1 的休眠/唤醒状态机据它决定「续跑」还是「等指令」 |
| **G-2** | **中断轮的自动续跑** | 基座**有**这个能力，但只在 headless/print 路径上接了线：`runHeadlessStreaming.ts:189-204` 消费 `turnInterruptionState`；交互 REPL 路径不消费。而 `deserializeMessagesWithInterruptDetection`（`conversationRecovery.ts:160-248`）在所有路径上都算出了它 | 常驻宿主定的是 **ACP**（章程 v2.2）。**先查证 ACP 路径是否复用 headless 那一段**（本文未查证，§6）；不复用就在 P3.1 唤醒后的第一步自己接 |
| **G-3** | **在途状态的持久化** | 写队列、去重表、判环表、在途消息表、权限审批状态、MCP 连接、定时器——**全在进程内存**。转录只记「对话」，不记「任务进度」 | **阡陌自己的节点状态存储**（P3.1 交付物）。不要试图塞进基座转录：转录是 append-only 的对话流水，塞进去会同时污染上下文与恢复成本 |
| **G-4** | **多 agent 的会话身份** | 会话身份是**进程级单例**（`STATE.sessionId`，`switchSession` 全局切换，`bootstrap/state/session.ts:44-55`）。同一进程里来回 `switchSession` 承载多个 agent 会互相踩 | 走基座既有的子 agent / sidechain（`recordSidechainTranscript`、`getAgentTranscriptPath`，`sessionStorage/paths.ts:66`）或多进程。P2.5 / P3.1 的宿主进程模型要显式定死 |
| **G-5** | **会话文件的清理/归档策略** | `--continue` 与 `--resume <非 UUID>` 的成本随**项目目录下会话文件数**线性增长（§1.1、§1.2）。常驻节点会持续积累会话文件；本次 large 点位 1001 个文件 = 54 MB，`--continue` 加载已到 438 ms | P3.1 的常驻生命周期定保留策略；运维脚本可挂在 P0.4 的门禁旁边。**即便钉死 `--resume <UUID>`，`/resume` 选择器与任何跨会话检索仍然吃这条成本** |
| **G-6** | **单个会话文件的上界** | 读侧有两道兜底：`MAX_TRANSCRIPT_READ_BYTES = 50 MB`（`sessionStorage/paths.ts:48`）、`MAX_JSONL_READ_BYTES = 100 MB`（`utils/text/json.ts:192`，超限只读尾部并**跳过第一条半行**）；`> 5 MB` 时走 `SKIP_PRECOMPACT_THRESHOLD` 的跳过路径（`sessionStoragePortable.ts:478`）。**越线后的行为是静默截断，不是报错** | P3.1 的压缩/归档策略；同时把「转录字节数」纳入常驻节点的可观测指标——**这是一条必须能看见的线** |
| **G-7** | **写队列溢出的背压与告警** | 队列 ≥ 1000 条时 `splice` 掉最旧的并 reject（`transcriptWriter.ts:373-383`）。100 ms 的 drain 周期内攒够 1000 条需要一次 burst，但常驻高吞吐节点做得到 | 节点侧监控 reject 计数 + 背压。**这是静默丢数据的路径，必须有计数器** |
| **G-8** | **持久化等级的显式定级** | 没有 fsync（`transcriptWriter.ts:424-433`）。当前等级 = **进程崩溃安全，非整机掉电安全**（§3.1） | 本文 §3 已定级。若 AC-1 将来要覆盖「宿主掉电」，需要显式 fsync 或 WAL——**那是范围变更，须回写章程** |
| **G-9** | **`--resume` 锚点的并列缺陷** | §1.5 / §2.6。常驻节点每次唤醒都 resume 一次，丢失会**累积** | §5 A-1（需负责人决定是否动基座核心） |

---

## 5. 后续动作

| # | 动作 | 归属 | 说明 |
|---|---|---|---|
| **A-1** | **修 `getLastSessionLog` 的锚点选取** | 需负责人决定（**动基座核心**） | 两个候选方案：① 把候选集限定到 `leafUuids`（与 `loadFullLog`/`--continue` 一致，`logAssembly.ts:384-388`）；② `findLatestMessage` 在并列时取**后出现**的（`>` 改 `>=`）。**本包不擅自改**：它改变的是全仓 `--resume` 的锚点语义，会波及分叉/分支会话，需要回归面评估。影响：AC-1 的「输出与重启前上下文一致」 |
| **A-2** | **节点启动参数钉死 `--resume <UUID>`** | P3.1 / P2.5 落地时 | 传自定义标题会触发跨 worktree 全量扫描（§1.2）。写进节点启动脚本与运行手册 |
| **A-3** | 在 `protocol.md` §8.3 的「崩溃瞬间的丢失窗口」行补一个指向本文 §3 的指针 | `protocol.md` 维护者 | **本包不改 `protocol.md`**。指针不复制：语义留在本文一处 |
| **A-4** | 去重表若要持久化，必须同时持久化「首次结果」 | P4.2 | 理由见 §3.3 L-4 的告诫框 |
| **A-5** | 把三个崩溃点固化为 CI 用例 | P0.4 / P3.1 | 本包的三个用例在 `demo/ac1-restart.sh` 里，是真进程 + 真 `kill -9`，**没有进 `bun test`**——它们要起真实进程、耗时秒级，塞进单测分片会拖垮门禁。建议做法：CI 单开一个非阻塞 job 跑 `demo/ac1-restart.sh`，与 D-3 定的「延迟测量走独立非阻塞基准 job」同一个套路 |
| **A-6** | 补测 AC-1 第二条判据 | 有凭据的执行者 | 步骤见 §2.7 |
| **A-7** | 在 Linux x86_64 演示服务器上复测 §2.3 | P8.1 复现验证时顺带 | 本次全部数字来自 macOS arm64（§6） |

---

## 6. 未查证 / 开放项（如实列出，不以推断充事实）

1. **平台**：所有实测只在 `Darwin 25.5.0 arm64` + `bun 1.3.13` 上跑过。演示服务器是 Debian 12 x86_64（roadmap 现状基线）。绝对数字必然不同；「`--continue` 线性、`--resume` 近似常数」这个**形状**预期不变，但**未在 Linux 上实测**。
2. **完整启动时间未测得**。§2.3 的 `wall` 是「bun 冷进程 + 模块加载 + 会话加载」，**不是 occ CLI 的完整启动**（TUI 挂载、认证、MCP server 启动都没算）。测它需要构建产物与凭据。因此本文只能断言「会话恢复不是 10 s 预算的瓶颈」，**不能**断言「AC-1 的 10 s 整体达标」。
3. **`--continue` 撞 10 s 的规模是外推值，不是实测点位**（§2.3）。按 roadmap P0.6 的引用纪律，引用它必须连同「未实测」一起引。
4. **大文件路径未触发**：large 点位的目标会话 3.54 MiB，没越过 5 MiB 的 `SKIP_PRECOMPACT_THRESHOLD`。`> 5 MB` 的分块扫描 + 压缩边界截断路径（`transcriptLoader.ts:440-499`）**本次完全没跑到**。
5. **合成历史与真实会话形状不同**：512 B 填充文本、无工具结果、无附件、无压缩边界、无 sidechain。真实会话的单条体量、条数分布、边界事件都更复杂。
6. **ACP 路径是否消费 `turnInterruptionState` 未查证**（§4 G-2）。这条直接决定 P3.1 「唤醒后自动续跑」要不要自己写。
7. **信箱 `read` 翻转与阡陌 A 类 ack 的确切时序未实测**。§3.2 的判断基于 `teammateMailbox.ts:156-174, 440-496` 的写入形态（临时文件 + rename，锁内立即执行）与 `protocol.md` §4.5 的定义，**没有跑过端到端**。
8. **跨项目目录 resume 未测**：`sessionProjectDir` 非空时（git worktree / 跨项目）`getTranscriptPathForSession` 走另一条分支（`sessionStorage/paths.ts:26-44`），成本与一致性都未测。**常驻节点很可能会用到 worktree**。
9. **`--fork-session` 换 id 只做了代码核实，没有实测**（`sessionRestore.ts:439-450`）。本文所有实测都在 `forkSession = false` 的路径上。
10. **写队列溢出（G-7）未实测**。1000 条上限是读代码得到的，没有构造 burst 去撞它。

---

## 附：本包交付的脚本

| 文件 | 作用 |
|---|---|
| `demo/ac1-restart.sh` | 一键复现。依赖模型凭据的那一段优雅跳过并打印 `SKIPPED: needs model credentials`，其余全部真跑 |
| `demo/lib/ac1-common.ts` | 合成消息构造、参数解析、JSON 输出 |
| `demo/lib/ac1-gen-history.ts` | 走基座真实写入路径合成历史（两个规模点位） |
| `demo/lib/ac1-measure.ts` | 冷进程测量 `--resume` / `--continue` 的加载成本 |
| `demo/lib/ac1-crash-writer.ts` | 三个崩溃点的现场构造 |
| `demo/lib/ac1-verify.ts` | 崩溃后一致性核验（`session_id` / 损坏行 / 悬空 `tool_use`） |
| `demo/lib/ac1-project-dir.ts` | 按基座口径解析会话存储目录（shell 侧不自己拼 sanitize 规则） |

全部脚本**只用临时配置根**（`OCC_CONFIG_DIR`），**不读取任何凭据**，**不发起任何模型 API 调用**。
