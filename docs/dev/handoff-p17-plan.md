<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — P17 本地—云端接力 · 工程实施计划

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.0**（2026-09-29，主 agent 按负责人委托编写） |
| 上位设计 | [`handoff-m1.md`](./handoff-m1.md) v1.1（范围、场景、AC-H1~H5 以设计为准，本文只讲怎么做） |
| 核对基点 | 本仓库 `c0c52924`（main，#153 合并提交）；fork 仓库 `sweetcornna/qianmo-codex` 钉上游标签 `rust-v0.158.0`（提交 `064c6b8c`） |
| 用法 | 每个工作包一张卡：仓库、要改的文件、接口、步骤、完成标准、依赖、估算、计划时间。按卡开工；卡里没写的不做 |
| 口径 | 全部为计划，**尚无运行数据**。真机工作排在 7 天长跑窗口（至 2026-10-03T18:20:23Z）之后 |

**原则**：M1 只服务单个用户（负责人本人）；能用上游已有能力就不改上游；能放阡陌侧 TS 就不放 Rust fork；不预先做多用户、通知中心、网页终端。

---

## §0 实施前定下的七件事

调研（读代码核实，未实跑）发现设计 v1.0 有两处与现网冲突、几处可以更省，已在设计 v1.1 中改正。开发按下表执行：

| # | 定案 | 原因 |
|---|---|---|
| D-1 | **节点不向注册中心登记**，由中枢代登记（与现网规则 H-2 一致）。节点桥只监听，由中枢拨入 | 现网节点从不主动连接注册中心；设计 v1.0 §2 第 3 条与之相反 |
| D-2 | **代码和会话走同一条数据面：git over SSH，由发起方拨出，节点从不拨号**。本地推到中枢；中枢推给节点、再从节点取回结果；接回时本地从中枢取 | 中枢的 TLS 前置请求体上限 1 MiB、剥掉 Upgrade、只允许一个上游，走 HTTP 要大改；节点现有密钥只能读审计链 |
| D-3 | **节点模式不进 Rust fork**。节点上由阡陌侧的 TS 节点桥 `qm handoff node` 经 app-server 协议驱动本机 `qmcode app-server` | 上游 app-server 的 WebSocket JSON-RPC 足够完成「恢复会话 → 开回合 → 等结束」，fork 越小越好合并 |
| D-4 | **阡陌侧命令收进一个根命令 `qm handoff`**（子命令 `mcp` `sync` `now` `status` `pull` `attach` `send` `node`） | `qm mcp` 与基座现有 `mcp` 命令组重名；一个根命令只需在 cli-golden 表里加一项 |
| D-5 | **fork 名称**：二进制 `qmcode`，状态目录 `~/.qmcode`（环境变量 `QMCODE_HOME`），系统配置 `/etc/qmcode`；文档里仍称「阡陌 Codex」 | 与官方 Codex 同机共存；产品名不用 Codex 商标 |
| D-6 | **远程直连不经中枢**：`qm handoff attach` 用用户自己的 SSH 访问节点，读节点上的 app-server 令牌文件，开 `ssh -L` 隧道，再以 `qmcode --remote ws://127.0.0.1:<端口>` 接入 | M1 只有负责人一人使用，本人有节点 SSH；app-server 不提供 wss，中枢前置也不支持 WebSocket |
| D-7 | **通知**：中枢在任务状态变化时可选 POST 一个用户自配的 webhook（`--handoff-notify-url`，如 ntfy、Bark、企业微信机器人）；另有 `qm handoff status --wait` | 现网没有任何外推渠道；只做一条 POST，不做通知中心 |

## §1 总体结构

```
本地（可关机）                        中枢（p11，qm console）                  云端节点
qmcode 界面 /handoff ─┐               裸仓 <root>/handoff/repos/<项目>.git       qm handoff node（节点桥，TS）
Claude Code ──────────┼ qm handoff ─▶ 台账 handoff.ndjson                          │ WebSocket JSON-RPC（127.0.0.1）
  （MCP：qm handoff mcp）│  sync/now    │                                          ▼
                      │  git push ──▶ │ ── git push（SSH）──▶ 节点工作仓            qmcode app-server
                      │  POST /v0/handoff   task.request（qianmo://，中枢拨入）──▶   │ thread/resume → turn/start
                      └◀ qm handoff pull ◀ git fetch ◀── git fetch（SSH）── qianmo/<task> 分支、会话 ref
qm handoff attach ═══ 用户本人 SSH -L 隧道 ═══════════════════════════════════▶ 同一会话
```

**git 引用约定**（中枢裸仓与节点工作仓相同）：

| 引用 | 内容 | 谁写 |
|---|---|---|
| `refs/qianmo/wip/<设备>/<分支>` | 影子提交：父提交为本地 HEAD，树为工作区（含未提交、未跟踪但未忽略的文件） | 本地 `qm handoff sync` |
| `refs/qianmo/sessions/<设备>/<会话 id>` | 单文件树：会话记录原文（qmcode 的 rollout JSONL，或 Claude Code 的 JSONL）；每次同步一个新提交，父为上次 | 本地；节点回传时设备名为 `cloud` |
| `refs/heads/qianmo/<task>` | 云端产出分支，起点为影子提交 | 节点桥；中枢取回 |

**接力清单**（`POST /v0/handoff` 的请求体，也是 `task.request` 的 payload 主体；只放引用，不放代码与会话正文，信封上限 256 KiB）：

```jsonc
{
  "kind": "handoff",                 // payload 形状标记；task.request 的 payload 协议层不校验
  "project": "atlas",                // 中枢裸仓名
  "device": "cornna-mbp",
  "branch": "main",                  // 本地当前分支
  "wip": "<影子提交 sha>",
  "tree": "<本地工作区树哈希>",       // AC-H1 核对用
  "tool": "qmcode" | "claude-code",
  "sessionId": "<thread id 或 CC 会话 id>",
  "sessionRef": "refs/qianmo/sessions/<设备>/<会话 id>",
  "sessionCommit": "<会话提交 sha>",
  "cwd": "/Users/…/atlas",           // 本地工作目录，节点侧用于 cwd 重映射
  "brief": { "goal": "…", "done": "…", "remaining": "…" },
  "deadline": "2026-11-20T02:00:00Z"
}
```

`taskId`、截止时间在信封上各有一份（协议要求 payload 不重复信封字段，中枢派发时把 `deadline` 换算成 `taskTtlMs`）。`task.result` 的 `content` 放 JSON 字符串：`{"status","branch","head","threadId","summary"}`。

**台账状态**：`accepted`（数据已落地，此刻回「可以关机」）→ `dispatched` → `running` → `done` / `failed` → `returned`。一台节点同一时刻只跑一个接力任务。

## §2 工作包

### P17.1 fork 与身份隔离（仓库：`sweetcornna/qianmo-codex`）

| 项 | 内容 |
|---|---|
| 分支 | 在 fork 仓库从标签 `rust-v0.158.0` 建 `qianmo/main`，之后所有阡陌改动都在这条线上；上游 `main` 分支保持纯镜像 |
| 要改的文件（均在 `codex-rs/` 下） | ① `cli/Cargo.toml:9-11` `[[bin]] name` → `qmcode`；`cli/src/main.rs:122` 的 `bin_name` 与 `override_usage`<br>② `utils/home-dir/src/lib.rs:14,59`：`CODEX_HOME` → `QMCODE_HOME`，`.codex` → `.qmcode`<br>③ `config/src/loader/mod.rs:79,725`、`config/src/loader/layer_io.rs:22`：`/etc/codex` → `/etc/qmcode`<br>④ `app-server-daemon/src/settings.rs:32`：`auto_update_enabled` 默认改 `false`（该 daemon 默认会从上游地址装回官方包）<br>⑤ 顺手：`tui/src/external_editor.rs:185`、`tui/src/status/helpers.rs:300` 的显示路径 |
| 不改 | app-server 方法名与通知名、`originator` 头值 `codex_cli_rs`、注入子进程的 `CODEX_THREAD_ID` 等 `CODEX_*` 环境变量、rollout 文件格式与文件名、项目级 `.codex/` 目录与 `AGENTS.md` |
| 新增文件 | 仓库根 `QIANMO.md`：改动清单（逐文件）、合并上游的步骤（§4）、构建命令；按 Apache-2.0 第 4 条在改过的文件头部加一行修改说明，保留 `LICENSE`、`NOTICE` 原样 |
| 构建 | 在构建机 p2 上原生编译：`cargo build --release --bin qmcode`（工具链按 `rust-toolchain.toml` 钉 1.95.0）；节点若有 aarch64，在同架构机器上原生编，不在 macOS 上交叉编译。脚本放 fork 仓库 `qianmo/build-linux.sh`，产物命名 `qmcode-<上游标签>-<短提交>-<架构>` |
| 完成标准 | 本机同时装官方 `codex` 与 `qmcode`：各自登录、各自会话目录，互不可见（`ls ~/.codex/sessions ~/.qmcode/sessions` 对照）；`cargo test -p codex-utils-home-dir -p codex-config` 通过；p2 出一份 Linux x86_64 产物并记录编译时长 |
| 依赖 | 无 |
| 估算 | 12–24 人时 |
| 计划时间 | 即日起，**最迟 2026-10-11** |

### P17.2 探针（仓库：两边都不改产品代码；结论写 `docs/dev/handoff-probe-p17.md`）

在一台节点上逐项实跑，每项记：命令、版本、结果、结论（通过 / 不通过 / 有条件）。**第 1 项不通过就先停，回负责人**。

| # | 探什么 | 怎么判 |
|---|---|---|
| 1 | **模型网关是否提供 OpenAI Responses API**（`/v1/responses`，SSE）。上游已删除 `wire_api = "chat"`，只剩 Responses | `qmcode exec` 配自定义 `[model_providers.qianmo]` 跑通一个多轮、带工具调用的任务。不通过就在网关侧补兼容层，另立工作包 |
| 2 | `qmcode app-server --listen ws://127.0.0.1:<端口> --ws-auth capability-token --ws-token-file <文件>` 在节点（含 gVisor 沙箱内）常驻 | 连续 24 h `/readyz` 正常；gVisor 内 bwrap 能否建 user namespace，不能就按 `sandbox: danger-full-access` 只靠外层隔离 |
| 3 | 会话跨机：把本机一份 rollout JSONL 放到节点 `$QMCODE_HOME/sessions/YYYY/MM/DD/`，`thread/resume` 显式传 `cwd` | 按 AC-H2 方法续接命中；远程界面翻历史是否为空（paginated 投影未生成时）记下来 |
| 4 | Claude Code 会话导入：改写 JSONL 里的 `cwd` 后放到 app-server 进程 `$HOME/.claude/projects/qianmo-import/`，调 `externalAgentConfig/import` | 拿到 `successes[0].target` 作 thread id，续接命中；长会话是否一上来就触发压缩 |
| 5 | 远程直连：另一台机器 `ssh -L` + `qmcode --remote ws://127.0.0.1:<本地端口> --remote-auth-token-env …` 接入正在运行的线程；与节点桥同时连接同一线程 | 两个连接都能收到事件，界面输入被执行 |
| 6 | fork 内置配置：`config/defaults.toml` 里的 `[mcp_servers.qianmo]` 与 `notify` 首次启动即生效，用户 `config.toml` 写 `enabled = false` 可关 | 本机实测 |
| 7 | 回合结束后会话文件何时落盘完整：`notify` 回调时刻 vs `turn/completed` 时刻 vs 文件稳定 | 决定 P17.4 同步时要不要等文件稳定 |

- 估算 12–24 人时；依赖 P17.1 产物；计划 **2026-10-12 至 10-18**（第 2、3、5 项需真机，在长跑窗口之后）。
- 完成标准：7 项都有结论；设计 v1.1 中被推翻的地方回写并升版。

### P17.3 两个入口（仓库：本仓库 + fork）

**本仓库**

| 项 | 内容 |
|---|---|
| 新文件 | `src/cli/handlers/handoff.ts`（`qm handoff` 各子命令分派）<br>`src/cli/handlers/handoffMcp.ts`（stdio MCP 服务，用仓库已装的 `@modelcontextprotocol/server` v2 直接写，样板参照 `src/utils/computerUse/mcpServer.ts` 的 `serveStdio` + `tools/list`、`tools/call`；**不复用基座 `src/entrypoints/mcp.ts`**，它绑着整套基座工具） |
| 改动 | `src/entrypoints/cli.tsx` fast path 加 `args[0] === 'handoff'` 分支（仿 `resident`）；`src/cli/program/commands/qianmo.tsx` 加帮助条目；`tests/integration/cli-golden.test.ts` 的 `ROOT_COMMANDS` 加 `handoff` |
| MCP 工具（仅五个，名字带 `qianmo_` 前缀） | `qianmo_status`：同步状态与进行中的接力任务<br>`qianmo_handoff {goal, done, remaining, deadline?}`：执行一次 `qm handoff now`，返回「可以关机」或失败原因<br>`qianmo_task {taskId?}`：查一个任务的状态与摘要<br>`qianmo_pull {taskId?}`：执行接回<br>`qianmo_send {taskId, text}`：给云端正在跑的任务追加一句话 |
| Claude Code 接法 | 文档给两行命令：`claude mcp add qianmo -- qm handoff mcp`；在 `~/.claude/settings.json` 的 `Stop` 与 `SessionEnd` hook 调 `qm handoff sync --hook claude-code`（从 stdin 读 `session_id`、`transcript_path`、`cwd`）。**阡陌不代写用户的 `~/.claude`** |
| 会话定位 | 每次 hook 或 notify 回调时，把「cwd → 最近的工具、会话 id、会话文件路径」记到 `occConfigPath('qianmo','handoff','sessions.json')`；`qianmo_handoff` 按当前 cwd 取最近一条。qmcode 的会话文件按 thread id 在 `$QMCODE_HOME/sessions/**/rollout-*-<id>.jsonl` 查找，`QMCODE_HOME` 的默认值由 `src/config/paths.ts` 新增的 helper 给出（identity-paths 门禁禁止在别处拼家目录路径） |

**fork**

| 项 | 内容 |
|---|---|
| `codex-rs/config/defaults.toml` | 加 `[mcp_servers.qianmo] command = "qm", args = ["handoff", "mcp"]`；加 `notify = ["qm", "handoff", "sync", "--hook", "qmcode"]`（回合结束时把 thread id、cwd 作为最后一个参数传入；用户自设 `notify` 会覆盖它，文档写明） |
| `/handoff` `/pull` | `tui/src/slash_command.rs` 加两个变体与说明；`tui/src/chatwidget/slash_dispatch.rs` 加分支，复用界面现成的 `!` 执行路径，分别执行 `qm handoff now` 与 `qm handoff pull`（带 `CODEX_THREAD_ID` 环境变量，结果显示在界面）；`tui/src/chatwidget/input_submission.rs` 把对应函数改为 `pub(super)`。约 25 行 Rust |
| 完成标准 | 在 qmcode 里输入 `/handoff`、在 Claude Code 里说「交给云端」，都走到 `qm handoff now` 并显示结果；MCP 工具表恰为上述五项；cli-golden、fork 的 TUI 快照测试更新并通过 |

- 估算 20–36 人时；依赖 P17.1（fork 部分）；计划 **2026-10-19 至 11-08**，与 P17.4 并行。

### P17.4 同步、中枢存储与台账（仓库：本仓库）

**新包 `@qianmo/handoff`**（`packages/handoff/`，纯逻辑，不依赖 occ 运行时；按 §2.2 包规范登记 workspace 依赖）

| 文件 | 职责 |
|---|---|
| `src/manifest.ts` | 接力清单类型与校验（白名单字段、长度上限、sha 形状）；`task.result.content` 的编码与解析 |
| `src/shadow.ts` | 影子提交：临时 `GIT_INDEX_FILE` → `git read-tree HEAD`（空仓库用空树）→ `git add -A -- . ':(exclude).env*'` 及密钥类排除表 → 对变更文件跑 `scanForSecrets`（`packages/tool-runtime/src/secretScanner.ts`），命中即中止并报出文件与规则 → `git write-tree` → `git commit-tree -p HEAD`。全程不动用户的 HEAD、index、stash、工作区文件 |
| `src/session.ts` | 把会话文件写成单文件树并 `commit-tree`（父为上一次的会话提交） |
| `src/ledger.ts` | 追加式 NDJSON 台账与状态机；重启时重放恢复；同一节点互斥 |
| `test/` | 用真 git 在临时目录跑：未跟踪文件被纳入、忽略文件与 `.env*` 被排除、秘密命中拒推、用户 index 前后逐字节不变、台账重放 |

**本地命令**（`src/cli/handlers/handoff.ts`）

| 命令 | 行为 |
|---|---|
| `qm handoff init --hub <ssh目标:路径> --console <https://…> [--device <名>]` | 在当前仓库登记接力配置（存 `occConfigPath('qianmo','handoff','projects.json')`，按仓库根路径索引）；不改用户的 git remote |
| `qm handoff sync [--hook qmcode\|claude-code]` | 做影子提交与会话提交，`git push <hub> <sha>:refs/qianmo/wip/…` 与会话 ref；去抖 5 s；失败只记日志，不打断用户的工具 |
| `qm handoff now [--goal …]` | 强制同步 → 用 `git ls-remote` 核对两个 ref 的 sha 与本地一致 → 计算本地工作区树哈希并与影子提交的树比对（AC-H1）→ `POST /v0/handoff` → 中枢回 `accepted` 后打印「已落地，可以关机」与 taskId。任何一步不一致都不打印这句话 |
| `qm handoff status [--wait]` | 查中枢台账；`--wait` 阻塞到状态变化 |

**中枢**

| 项 | 内容 |
|---|---|
| 裸仓 | `occConfigPath('qianmo','handoff','repos','<项目>.git')`，首次推送前由 `qm handoff init` 经 SSH 调中枢上的 `git init --bare` 建好 |
| SSH 闸门 | 新增 `demo/env/beta/ops/handoff-git-gate.sh`：放在 `authorized_keys` 的 `command=` 里，只放行 `git-upload-pack` / `git-receive-pack` 且路径必须在指定根目录下，其余一律拒绝；配 `restrict`。按 `ops/` 目录惯例同时加 `handoff-git-gate.test.ts`（越界路径、非 git 命令、路径穿越都必须被拒）。中枢上给用户本机一把钥匙，节点上给中枢一把**新**钥匙（与只读审计链的那把分开，不放宽它） |
| API | `packages/console`：`deps.ts` 加 `HandoffPort`，`http.ts` 的 `dispatchApi` 加 `head === 'handoff'`：<br>`POST /v0/handoff`（member 及以上）：校验清单 → 在裸仓 `git cat-file -e` 确认 `wip`、`sessionCommit` 存在且 `wip` 的树 = 清单 `tree` → 记 `accepted` → 返回 taskId<br>`GET /v0/handoff`、`GET /v0/handoff/:taskId`（viewer 及以上）<br>`POST /v0/handoff/:taskId/send`（member）<br>实现放 `src/cli/handlers/consoleHandoff.ts`，台账放 `occConfigPath('qianmo','handoff','ledger.ndjson')` |
| 审计 | `packages/audit/src/record.ts` 的 `AuditSource` 加 `handoff`；事件 `handoff.accepted` / `.dispatched` / `.completed` / `.failed` / `.returned` / `.attach-requested` |
| 完成标准 | 本地与中枢都在本机回环上跑的集成测试：`now` 在核对通过前不打印「可以关机」；故意删掉中枢上的会话对象，`now` 必须失败；中枢进程重启后台账与任务状态不丢；用户 index、HEAD、stash 不变 |

- 估算 32–56 人时；依赖 P17.1（只为拿到 qmcode 会话文件样本）；计划 **2026-10-19 至 11-08**。

### P17.5 节点桥与云端续跑（仓库：本仓库）

**`qm handoff node`**（`src/cli/handlers/handoffNode.ts` + `packages/handoff/src/appserver.ts`）

| 项 | 内容 |
|---|---|
| 监听 | `startTransportServer`（`@qianmo/transport`），入站先过 `NodeRouter.inbound`；签名口径与控制台 `--chat-sign` 一致。**不拨号、不连注册中心** |
| 可复用 | `@qianmo/protocol` 的 `createAck`、`createTaskResult`、`errorReply`、`createNotify`；`@qianmo/resident` 的 `FileDeliveryLedger`、`ResidentEstop`、`ResidentActivityReporter`（仅沙箱内需要）。先例 `demo/lib/ac2-target.ts`（70 行）。注意 `@qianmo/resident` 包入口会连带加载 ACP SDK，节点桥随 `qm` 一起构建时可接受 |
| app-server 客户端 | 手写用到的少数方法的类型（不拷贝上游生成的绑定）：`initialize`（`clientInfo`）→ `initialized` → `thread/resume {threadId, cwd, approvalPolicy:"never", sandbox:"danger-full-access"}` → `turn/start {threadId, input:[{type:"text", text, text_elements:[]}]}` → 等 `turn/completed`（按 `turn.id` 对应，`status` 为 `completed` / `interrupted` / `failed`）。帧不带 `"jsonrpc"` 字段；握手带 `Authorization: Bearer <令牌>`，不带 `Origin` |
| 执行步骤 | ① 收 `task.request`（`payload.kind === "handoff"`），立即回 ack<br>② 工作仓已由中枢推入对象：`git worktree add <根>/work/<taskId> -b qianmo/<taskId> <wip>`；工作仓**不配任何 remote**，节点上无用户的代码托管凭据，所以只可能产生 `qianmo/` 分支<br>③ 会话：qmcode 会话 → 从会话 ref 取出 JSONL，放入 `$QMCODE_HOME/sessions/YYYY/MM/DD/`；Claude Code 会话 → 改写每行 `cwd` 为工作目录后放入 app-server 进程 `$HOME/.claude/projects/qianmo-import/`，调 `externalAgentConfig/import`，取 `successes[0].target`；导入失败退化为「简报 + 最近 20 轮原文」开新线程<br>④ `thread/resume` 传 `cwd` 为工作目录，`turn/start` 发简报（模板固定：目标、已完成、剩余，外加「只在当前分支提交，不推送、不发布、不付款，遇到这类动作停下说明」）<br>⑤ `turn/completed` 后：把工作目录里未提交的改动提交到 `qianmo/<taskId>`；把会话文件提交为 `refs/qianmo/sessions/cloud/<threadId>`；回 `task.result`（content 为 JSON）<br>⑥ 回执不到时结果进投递台账；中枢在任务进行期间每 60 s 发一次 `ping`，节点桥收到任何入站消息时补投欠着的结果 |
| `send` | `payload.kind === "handoff.send"`：对该线程 `turn/start`（进行中则上游自动转为 steer） |
| 中枢侧派发 | `consoleHandoff.ts`：启动参数 `--handoff-node <节点>=<qianmo 地址>` 与 `--handoff-node-git <节点>=<ssh 目标:路径>`（PSK 沿用 `transportPskEnvVarForNode`）；选一个空闲节点 → `git push` 清单里的三个对象到节点工作仓 → 发 `task.request`（`taskTtlMs` 由 `deadline` 换算）→ 收到结果后 `git fetch` 节点的 `qianmo/<taskId>` 与云端会话 ref 回裸仓 → 台账 `done` / `failed` → 按 D-7 发 webhook |
| 节点起停 | `demo/env/beta/handoff-node.sh start\|stop`：经 `beta_start_process` 拉起 `qmcode app-server --listen ws://127.0.0.1:<端口> --ws-auth capability-token --ws-token-file <文件>` 与 `qm handoff node`，状态都在 `QIANMO_BETA_ROOT` 下；qmcode 二进制放部署树新顶层 `qmcode/`，用 `beta-deploy.sh --only qmcode` 单独更新；**不用** `app-server daemon`。模型走 `[model_providers.qianmo]`（API key 由环境变量给，节点不登录个人订阅） |
| 完成标准 | 单测：用一个假的 app-server（测试里起一个 Bun WebSocket 服务，只实现上述方法）跑通①–⑥，含结果补投。真机：空白节点上续跑一次真实任务，按 AC-H2 方法判续接；节点工作仓除 `qianmo/` 外没有新分支 |

- 估算 32–56 人时；依赖 P17.2（第 1–4 项结论）、P17.4；计划 **2026-11-09 至 11-29**。

### P17.6 远程直连与接回（仓库：本仓库）

| 命令 | 行为 |
|---|---|
| `qm handoff attach [taskId]` | 向中枢取任务的节点与 threadId（记审计 `handoff.attach-requested`）→ 用用户自己的 SSH 配置读节点令牌文件 → 后台开 `ssh -N -L <本地端口>:127.0.0.1:<app-server 端口>` → 以环境变量传令牌，执行 `qmcode --remote ws://127.0.0.1:<本地端口> --remote-auth-token-env QMCODE_REMOTE_TOKEN` 并恢复该线程 → 退出时关隧道。令牌不经中枢 |
| `qm handoff pull [taskId]` | `git fetch <hub> refs/heads/qianmo/<taskId>`；判「本地没动过」= 当前 HEAD 等于影子提交的父提交，且工作区树哈希等于影子提交的树 → 当前分支 `merge --ff-only`；否则建 `qianmo/<taskId>-return`，打印差异统计，工作区文件不动。qmcode 入口另把云端会话放回本机 `$QMCODE_HOME/sessions/`，本地可 `qmcode resume <threadId>` 接着聊。台账记 `returned` |

- 完成标准：AC-H4 从另一台机器接入并输入被执行；AC-H5 两条路径各一条用例（本地未改 → 快进；本地已改 → 另开分支，用 `shasum` 比对全部工作区文件前后一致）。
- 估算 16–32 人时；依赖 P17.5；计划 **2026-11-30 至 12-13**。

### P17.7 端到端关机演练

| 项 | 内容 |
|---|---|
| 做法 | 两个入口（qmcode、Claude Code）各跑一轮 U-1→U-4：本机转交后关机或断网 ≥ 30 min，期间用另一台设备接入一次，回来接回 |
| 通过条件 | AC-H1~H5 全部满足；**同一份部署连续两轮全部通过**，单轮通过不算 |
| 记录 | `docs/dev/handoff-drill-p17.md`：环境、版本（本仓库提交、qmcode 标签与提交）、每轮时间线、判据逐条结果、失败与修复 |
| 估算 / 计划 | 16–24 人时；**2026-12-14 至 12-27** |

之后从 **2027-01** 起邀请校内开发者试用，记录每周转交次数、云端完成率、接回后人工修正比例、第二周与第四周留存，以及单次接力成本（节点时长、模型用量、存储与流量）。

## §3 排期与估算汇总

| 包 | 仓库 | 估算（人时） | 计划时间 | 依赖 |
|---|---|---|---|---|
| P17.0 设计 | 本仓库 | 2–4 | 已完成（#153） | — |
| P17.1 fork 与身份隔离 | fork | 12–24 | 即日起至 10-11 | — |
| P17.2 探针 | 两边（只记结论） | 12–24 | 10-12 至 10-18 | P17.1 |
| P17.3 入口 | 两边 | 20–36 | 10-19 至 11-08 | P17.1 |
| P17.4 同步与中枢 | 本仓库 | 32–56 | 10-19 至 11-08 | P17.1 |
| P17.5 节点桥与续跑 | 本仓库 | 32–56 | 11-09 至 11-29 | P17.2、P17.4 |
| P17.6 直连与接回 | 本仓库 | 16–32 | 11-30 至 12-13 | P17.5 |
| P17.7 关机演练 | — | 16–24 | 12-14 至 12-27 | 全部 |
| **合计** | | **142–256** | | |

比设计 v1.0 的 150–268 略少：节点模式从 Rust 挪到 TS，fork 里不再加 CLI 子命令。

## §4 fork 的上游合并

- 只按上游**发行标签**合并，不跟 `main`；每次合并在 `QIANMO.md` 记一行：标签、冲突文件、耗时。
- 近 30 天上游 `codex-rs/` 有 1480 个提交，但本计划要改的文件里 `utils/home-dir`、`config/defaults.toml` 近 30 天零改动；`cli/src/main.rs`、`tui/src/slash_command.rs`、`tui/src/chatwidget/slash_dispatch.rs` 每个发行周期会被碰到，冲突是「枚举与 match 各加一行」这一类，手工解决。
- 合并后必须：`cargo test` 覆盖上面改过的 crate；重跑 P17.2 第 3、5 项；重新出 Linux 产物。
- 高频改动的 `core`、`tui/src/chatwidget.rs`、`tui/src/app/event_dispatch.rs` 不碰。

## §5 本仓库门禁清单（每个 PR）

- `bun run precheck` 零错误（会写格式化，检查 diff 里没有无关文件）；推送前 `bun run verify`。
- 新文件带两行版权头；新包 `@qianmo/handoff` 按 §2.2 登记 workspace 依赖；unused 预算、cycles 双向棘轮同步更新。
- 路径一律经 `src/config/paths.ts`（含新增的 qmcode 家目录 helper）；identity-paths 门禁不放宽。
- 仓库内模块不内联 `mock.module`；git 与 WebSocket 相关测试用真 git、临时目录和测试内起的假服务，不 mock。
- 协议不加新消息类型；`task.result` 与 ack 的 payload 保持封闭；`AuditSource` 新增 `handoff` 一项。
- 不改 `BASE.md`、不动 `base-snapshot/*`；改基座文件（`cli.tsx` fast path、cli-golden）在 PR 里写明原因。

## §6 风险与退路

| 风险 | 退路 |
|---|---|
| 网关不提供 Responses API（P17.2 第 1 项） | 网关侧加 Responses → Chat 兼容层，另立工作包；P17.5 顺延 |
| gVisor 内 bwrap 不可用 | 节点上 `sandbox: danger-full-access`，只靠外层隔离（设计 §8 已允许） |
| 只拷 JSONL 时远程界面翻不到历史 | 节点桥在 resume 后触发一次投影；不行就接受「模型上下文完整、界面历史为空」并在文档写明 |
| Claude Code 长会话导入超上下文 | 退化为「简报 + 最近 20 轮原文」 |
| 上游改了 app-server 方法或参数 | 钉标签；节点桥只用 §2 P17.5 列出的六个方法与通知，合并时对照检查 |
| 中枢机位置与数据境内存储 | 负责人确认中枢机房位置（设计 §10 已列） |
