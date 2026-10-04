<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 本地—云端接力设计（M1 · P17，以开源 Codex 为底座）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.1（生效）**。v1.0 于 2026-09-28 由负责人委托主 agent 评审定案，随 #153 合入；v1.1（2026-09-29）按实施前调研改正与现网冲突的两处并收窄 fork 改动，工程做法见 [`handoff-p17-plan.md`](./handoff-p17-plan.md) |
| 日期 | 2026-09-28 |
| 核对基点 | v1.0：本仓库 `c344cb64`（main，#149 合并提交）；上游 `openai/codex` 最新发行 `rust-v0.158.0`（2026-09-28），本机实测 `codex-cli 0.154.0`。v1.1：本仓库 `c0c52924`；fork 钉 `rust-v0.158.0`（提交 `064c6b8c`），读代码核实，未实跑 |
| 本文范围 | 只有设计，不改代码。范围回写见章程 v2.20、roadmap v2.77 |
| 范围依据 | 负责人 2026-09-28 决议（对话记录）：① 与 Claude Code、Codex 等 agent 工具相互连接，本地与云端协同开发、同步数据，关机前说一声即转交云端；云端节点互通保留。② 与 M1 在途工作**并行追加**。③ 用户可远程直连云端真实 CLI 的界面。④ **接力线底层不用 occ，以开源 Codex 为底座，fork 后按需改造** |
| 编号 | P17.x |
| 结论一句话 | fork 开源 Codex（Apache-2.0）为「阡陌 Codex」：本地用它或 Claude Code 干活，说一声「转交」，工作区和会话同步到中枢，中枢确认落地后回「可以关机」；云端节点跑阡陌 Codex 的 app-server 守护进程续跑，用户从任意机器用阡陌 Codex 界面远程接入；现有 `qianmo://` 节点网络保留作派发通道 |

**先做最小可用，再按真实使用补。**M1 只服务单个用户（负责人本人），不为多用户、多租户预先设计。

---

## §0 与现有工作的关系

- **只换接力线的底座。**现有 occ 基座、M0 成果、M1 的 P13 / P14 / P15 / P16 与内测舰队不动。整个项目是否从 occ 迁到 Codex，**本文不决定**，等接力线跑通后再议。
- **复用的是阡陌自研的 TS 层**：`@qianmo/protocol` / `registry` / `transport` / `router` / `audit` 与中枢 `qm console`。这些包本身基本不依赖 occ（`registry` 只借 `src/config/paths.ts` 定存储位置）；`qm` 命令目前与 occ 同一次构建产出，接力线沿用 `qm`，但不用 occ 的 agent 运行时。`@qianmo/resident` 绑在 occ 的 ACP 上，接力线不用它。
- 真机工作排在 7 天长跑窗口（至 2026-10-03T18:20:23Z）之后。

## §1 场景与验收判据

| # | 场景 | 必须做到 |
|---|---|---|
| U-1 | **关机转交**：在阡陌 Codex 或 Claude Code 里说「我要关机了，交给云端」 | 最后一次同步落地后才回「可以关机」 |
| U-2 | **云端续跑** | 中枢派给节点；节点上的阡陌 Codex 带着原会话继续，不重新问背景 |
| U-3 | **远程直连** | 任意机器上的阡陌 Codex 界面连到节点的 app-server，看到并接管同一会话 |
| U-4 | **接回** | 本地没动过就快进；动过就另开分支，不覆盖本地改动 |

| 编号 | 判据 |
|---|---|
| **AC-H1 安全关机** | 回「可以关机」时，中枢影子提交树哈希 = 本地工作区（含未跟踪、未忽略文件）树哈希，会话记录已完整落地 |
| **AC-H2 上下文续接** | 沿用 AC-1 的方法：本地会话里推出的上下文事实，云端首条相关回答能命中 |
| **AC-H3 两入口** | 同一用例从阡陌 Codex 与 Claude Code 发起都通过 AC-H1、AC-H2 |
| **AC-H4 远程直连** | 从另一台机器接入节点上运行中的会话，输入被执行 |
| **AC-H5 接回不覆盖** | 本地未改 → 快进；本地有改 → 另开分支，本地文件逐字节不变 |

## §2 底座：阡陌 Codex

| 项 | 内容 |
|---|---|
| 上游 | `github.com/openai/codex`，Rust，**Apache-2.0**（已用 GitHub API 核实） |
| 放在哪 | **单独的 fork 仓库 `github.com/sweetcornna/qianmo-codex`**（2026-09-28 已建并同步到上游 main），保留上游完整 git 历史，按上游发行标签定期合并；不导入本仓库（避开 Rust 工具链混入 Bun monorepo，也避开 occ 快照导入那种无历史的同步成本） |
| 许可 | fork 仓库保持 Apache-2.0，保留上游 `LICENSE` 与 `NOTICE`，改过的文件标注修改；本仓库 AGPL 部分只经协议与它通信 |
| 身份隔离 | 改二进制名与状态目录（不用 `codex`、`~/.codex`），与官方 Codex 同机共存；不用 OpenAI / Codex 商标作产品名，对外按章程 §5.8 办 |
| 改造原则 | 改动尽量放在新增 crate 或上游已有扩展点（hooks、MCP、app-server 协议、model provider 配置）里，少改上游核心文件，降低合并成本 |

**上游已有、直接用的**（出处为上游仓库 `codex-rs/` 目录）：

| 能力 | 上游位置 | 用途 |
|---|---|---|
| app-server 守护进程与远程接入 | `app-server`、`app-server-daemon`；CLI 的 `--remote ws(s)://…` 与 `--remote-auth-token-env`、`remote-control`、`queue --thread` | 节点常驻、远程直连、往会话里投消息 |
| 会话持久化与恢复、分叉 | `thread-store`、`rollout`；`resume` / `fork` / `exec resume` | 云端续跑 |
| 导入 Claude Code 会话 | `external-agent-migration/src/sessions/records_cla.rs` | Claude Code → 云端 Codex 续接（导入质量待 P17.2 实测） |
| hooks、MCP 客户端、沙箱、多模型接入 | `hooks`、`rmcp-client`、`linux-sandbox`、`model-provider` | 回合结束同步、接阡陌工具、节点执行隔离、接我们的模型网关 |

**要改的**（全部改动清单，不预先扩；v1.1 收窄）：

1. 身份隔离：二进制 `qmcode`、状态目录 `~/.qmcode`（`QMCODE_HOME`）、系统配置 `/etc/qmcode`；关掉 app-server 托管守护进程的自动更新默认值。
2. 内嵌默认配置 `config/defaults.toml`：出厂注册阡陌的 MCP 服务 `qm handoff mcp`，回合结束的 `notify` 回调 `qm handoff sync`。
3. 界面内 `/handoff`、`/pull` 两个命令，执行 `qm handoff now` / `qm handoff pull`（约 25 行 Rust）。

~~节点模式：守护进程启动时向阡陌注册中心登记，把中枢派来的任务转成 app-server 的会话恢复与新回合，完成时回报。~~ **v1.1 移出 fork**：现网规则 H-2 是节点不连注册中心、由中枢代登记；节点上改由阡陌侧 TS 节点桥 `qm handoff node` 经 app-server 协议驱动本机 `qmcode app-server`。fork 里也不再加 `handoff` / `pull` CLI 子命令，由 `qm handoff` 提供。

## §3 架构

```
本地（可关机）                       中枢 qm console                      云端节点
阡陌 Codex（界面） ─┐                同步仓（每项目一个裸仓，               节点桥 qm handoff node
Claude Code +        ┼─ 同步 ──▶    代码与会话同在）                        └▶ 阡陌 Codex app-server（沙箱内，常驻）
  qm handoff mcp     │              接力台账 ── git push + task.request ──▶ 产出 qianmo/<task> 分支
                     └◀── 接回 ──   通知     ◀── git fetch + 回报 ──
阡陌 Codex --remote ══════════════ 远程直连（用户本人 SSH 隧道）══════════▶ 同一会话
                                   节点 ⇄ 节点：现有 qianmo:// 网络不变
```

## §4 两个入口

- **阡陌 Codex**：内建 `/handoff`、`/pull`，不需要额外配置。
- **Claude Code**：`claude mcp add` 注册 `qm handoff mcp`（v1.1：`qm mcp` 与基座 `mcp` 命令组重名，改名；工具：`qianmo_status`、`qianmo_handoff`、`qianmo_task`、`qianmo_pull`、`qianmo_send`），回合结束与会话结束 hook 调 `qm handoff sync`。Claude Code 会话在节点上经上游导入器转成 Codex 会话续跑；导入不理想时退化为「简报 + 最近几轮」。
- 对官方 `~/.claude`、`~/.codex` 只读，默认不写；凭据从不随同步或接力移动。

## §5 同步

| 对象 | 方式 | 时机 |
|---|---|---|
| 代码与未提交改动 | 临时 index 做影子提交，推到中枢 `refs/qianmo/wip/<设备>/<分支>`；不动用户的 HEAD、index、stash | 文件变更去抖后；回合结束；转交时强制 |
| 会话 | 阡陌 Codex 的会话文件 / Claude Code 的 JSONL，作为单文件提交推到同一裸仓的 `refs/qianmo/sessions/<设备>/<会话 id>`（v1.1：与代码同走 git over SSH，一条数据面） | 同上 |
| 项目记忆 | `AGENTS.md` / `CLAUDE.md` 随代码走 | — |

- 按项目开启。排除 `.gitignore` 命中项、`.env*`、密钥类文件；推前扫一遍秘密，命中就拒推并报出。
- 落地核对：代码比树哈希，会话比提交哈希（v1.1）。云端只写 `qianmo/<task>` 分支。

## §6 接力

- **清单**：`taskId`、发起工具与会话 id、本地 cwd、影子提交、会话位置、简报（目标、已完成、剩余）、截止时间。
- **状态**：`accepted`（此刻回「可以关机」）→ `running` → `done` / `failed` → `returned`。回「可以关机」只看数据是否落地，不等派发。
- **派发**：走现有 `task.request`，回执、重投、去重、防环、限流沿用；选一个在线空闲节点。

## §7 云端执行、直连、接回

- **执行**：中枢把影子提交与会话推到节点工作仓（v1.1：全部由中枢发起，节点不拨号），节点桥检出影子提交、建 `qianmo/<task>` 分支；导入会话（重映射 cwd），经 app-server 恢复会话并以简报开新回合。模型走我们自己的网关（API key），不在节点上用个人订阅登录。
- **直连**：用户用 `阡陌 Codex --remote ws://127.0.0.1:<端口>` 经本人 SSH 隧道连节点 app-server；令牌是节点 app-server 的令牌文件，经同一条 SSH 读取，不经中枢（v1.1：app-server 不提供 wss，中枢前置不支持 WebSocket；M1 只有负责人一人使用）。节点端口不对公网。
- **接回**：取回 `qianmo/<task>` 与接回简报；本地没动过就快进，动过就另建 `qianmo/<task>-return` 并报差异。

## §8 安全

- 接力是用户本人发起的授权，范围限于该项目、`qianmo/` 前缀分支、截止时间内。云端不推默认分支、不打标签、不发布、不付款；遇到这类动作停下来通知用户。
- 节点上仍在 Dormice + gVisor 沙箱内运行；Codex 自带沙箱在 gVisor 里能否工作待 P17.2 实测，不行就只靠 gVisor 这一层。
- 转交、派发、直连、接回写 `@qianmo/audit`。

## §9 任务包（P17.x）

| 包 | 目标 | DoD | 估算（人时） |
|---|---|---|---|
| **P17.0** 设计与范围回写 | 本文、章程 v2.20、roadmap v2.77 入库 | 评审通过 | 2–4 |
| **P17.1** 建 fork 与身份隔离 | 阡陌 Codex 能构建、能与官方 Codex 同机共存 | fork 仓库已建（`sweetcornna/qianmo-codex`），钉在一个上游发行标签；Linux x86_64 / aarch64 构建产物；改名后与官方 Codex 同机各用各的状态目录；上游测试不新增失败 | 12–24 |
| **P17.2** 探针 | 先量最大的未知 | 在一台节点的沙箱里：app-server 守护进程常驻、远程界面接入、接我们的模型网关、Claude Code 会话导入后按 AC-H2 方法续接。每项记结论与版本号 | 12–24 |
| **P17.3** 入口 | `/handoff` `/pull` 与 `qm handoff mcp` | 两个入口都能发起转交与接回；MCP 工具表只含 §4 五项 | 20–36 |
| **P17.4** 同步与中枢存储 | 同步 + 落地核对 + 台账 | 不改用户 HEAD / index / stash；秘密命中拒推；核对不等不回「可以关机」；中枢重启台账不丢 | 32–56 |
| **P17.5** 节点接入网络与续跑 | 派发到节点并续跑 | 节点由中枢代登记；`task.request` → 节点桥 → app-server 恢复会话并开回合；完成回报与 notify；AC-H2；只推 `qianmo/` 分支 | 32–56 |
| **P17.6** 直连与接回 | AC-H4、AC-H5 | 远程界面经 SSH 隧道与节点令牌接入；接回两条路径各一条用例 | 16–32 |
| **P17.7** 端到端演练 | 关机演练 | 两个入口各跑一轮 U-1→U-4，本机转交后断网 ≥ 30 min，全部通过；同一份部署连续两轮全部通过才算（v1.1） | 16–24 |

**合计 142–256 人时**（v1.0 为 150–268；v1.1 节点模式移出 fork 后下调）。逐包的文件、接口与排期见 [`handoff-p17-plan.md`](./handoff-p17-plan.md)。顺序：P17.1 → P17.2 →（P17.3 / P17.4 并行）→ P17.5 → P17.6 → P17.7。

## §10 风险

| 风险 | 对策 |
|---|---|
| 上游迭代很快（本机 0.154 到上游 0.158 只隔数日），app-server 协议标着 experimental | 钉版本；改动集中在新增 crate 与扩展点；按上游发行定期合并，每次跑上游测试 |
| Codex 对模型接口的要求与我们的网关不匹配 | P17.2 先量；不匹配就在网关侧补兼容层 |
| Claude Code 会话导入质量不够 | 退化为「简报 + 最近几轮」，任务不丢 |
| Codex 沙箱在 gVisor 内不可用 | 只靠 gVisor 一层，并在节点配置里显式关掉 Codex 沙箱 |
| Rust 构建慢、占资源 | 在构建机上出 Linux 产物，本地只装二进制 |
| 同步仓存放位置与章程 §1.6「数据境内存储」 | 负责人确认中枢机房位置 |
