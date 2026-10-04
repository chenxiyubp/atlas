# 阡陌 AgentNest（Qianmo AgentNest）

> 阡陌交通，鸡犬相闻。

**阡陌**是一个**云端常驻智能体交流网络**。智能体不再是一次性的对话进程，而是长期驻留在云端的个体：它拥有自己的地址、分层记忆与休眠/唤醒生命周期；当它需要别人时，沿着阡陌小径把消息递到另一个节点上的另一个智能体手里。田连阡陌，鸡犬相闻——这正是我们希望智能体之间形成的样子：各自安居，彼此可达。

两条产品线：

| 产品线 | 内容 | 在网络中的角色 |
|---|---|---|
| ① 云端常驻编程智能体 | 沙箱驻留、项目记忆、休眠唤醒、随叫随到、模型中立 | **节点** |
| ② 智能体通信协作网络 | 注册发现、按名寻址、加密消息、权限分级、限流防循环、跨节点资源协同 | 连接节点的**网络** |

当前阶段：**M1 开发期**。M0 原型验证已于 **2026-08-17 收口**（八条验收判据全部通过、零豁免，见 [`docs/dev/roadmap.md`](docs/dev/roadmap.md) v2.42 与 [`docs/dev/acceptance-m0.md`](docs/dev/acceptance-m0.md)）。范围与验收标准以 [`docs/dev/charter.md`](docs/dev/charter.md) 为唯一依据。

---

## 基座说明

本仓库是 **[open-claude-code](https://github.com/sweetcornna/open-claude-code)（CLI 名 `occ`，MIT 许可）的下游 fork**。基座由项目负责人自有并已在 npm 公开发布（`@sweetcornna/open-claude-code`），以零改动快照方式导入本仓库根目录。**导入 pin** 是上游提交 `848ad8c2c8daca9f5aa2410da555553e07700f5d`（= tag `v2.38.3`，历史锚点，不随同步变化）；**当前 pin** 是 `1128a3919a7f01298a6cbf5c468a839c6cf4ee6a`（= tag `v2.46.0`），2026-08-17 首次上游同步后跟进——两个 pin 的分工与完整同步记录见 [`BASE.md`](BASE.md)。阡陌的自有代码以 `@qianmo/*` workspace 包的形式加入，常驻化改造直接落在基座运行时上。

**成果边界**：基座导入于**本仓库提交 `3380c88`**，其后的全部提交即阡陌团队的工作，唯一例外是纯上游同步提交 `d04a79dd`（2026-08-17，内容全部来自上游补丁，详见下文）——工作记录 `git log 3380c88..HEAD`，另加导入前的立项提交 `67f6081`、`74f7a22`。**2026-08-17 首次上游同步（v2.38.3 → v2.46.0）之后**，基座内容在历史里出现了第二次，因此工作面改用基座零改动快照标签举证：工作面 `git diff base-snapshot/v2.46.0..HEAD`、当前基座边界 `git show --stat base-snapshot/v2.46.0`；工作记录里 `d04a79dd` 一笔的内容全部来自上游，须单独声明（详见 [`BASE.md`](BASE.md)「上游同步记录」与章程 §5.5）。本仓库经零改动快照导入、**不含上游 git 历史**，故举证基线是导入提交 `3380c88`，而不是上游 pin `848ad8c2`（那是上游仓库的 SHA，在本仓库不是有效 git 对象）；上游溯源以 [`BASE.md`](BASE.md) 的记录与上游仓库比对为准。

完整溯源与上游同步记录见 [`BASE.md`](BASE.md)；采用理由、能力盘点与风险见 [`docs/dev/base-adoption.md`](docs/dev/base-adoption.md)；许可与商标声明见 [`NOTICE`](NOTICE)。

基座本体可独立安装试用（注意：这是基座的发布物，阡陌本仓库不发 npm 包）：

```bash
npm install -g @sweetcornna/open-claude-code
```

---

## 目录导览

本仓库是 fork 布局：**基座目录结构原样保留在仓库根**，阡陌自己的东西挂在其中。

```
.
├── BASE.md                  基座溯源记录（上游、pin、同步历史）—— 不随功能 PR 改动
├── LICENSE                  AGPL-3.0（阡陌自有代码）
├── LICENSE.base             MIT（基座原文，逐字保留）
├── NOTICE                   许可范围、基座溯源、Anthropic 商标声明
├── CLAUDE.md                本仓库对 AI 代理的工程约定（先读它）；下半部分附基座 CLAUDE.md 原文
│
├── src/                     ← 基座：CLI 主体（入口、REPL、命令、服务、工具）
├── packages/                ← 基座 + 阡陌
│   ├── @ant/                  基座：Ink UI 框架、model-provider 等
│   ├── builtin-tools/         基座：内建工具
│   ├── tool-runtime/          基座：host facade 接口层
│   ├── workflow-engine/       基座：确定性工作流引擎
│   ├── …                      基座其余包
│   └── @qianmo/*              阡陌：自有 workspace 包（协议 / 注册 / 传输 / 记忆 …）
├── scripts/                 ← 基座：构建、门禁、基准脚本
├── tests/                   ← 基座：集成测试
├── vendor/                  ← 基座：预编译原生二进制（**不是**隔离目录，见 CLAUDE.md）
│
└── docs/
    ├── zh/ en/ ja/            ← 基座：基座自身的三语功能与内部文档
    ├── README.md              阡陌：申报材料索引（计划书与申请书已移出仓库）
    ├── dev/                   阡陌：立项文档（见下）
    └── assets/                阡陌：品牌与图表素材（许可见 NOTICE 一、许可；大赛 logo 不授出）
```

### 立项文档（`docs/dev/`）

| 文档 | 用途 |
|---|---|
| [`charter.md`](docs/dev/charter.md) | **立项章程** —— 定位、范围与非目标、验收标准 AC-1~AC-8、工程基座与法律边界、风险、分工。**M0 阶段的唯一范围依据** |
| [`roadmap.md`](docs/dev/roadmap.md) | **路线图** —— 排期基础假设、关键路径、S0~S9 任务包与完成判据、M1/M2 规划 |
| [`base-adoption.md`](docs/dev/base-adoption.md) | **基座采用报告** —— 基座是什么、为什么改路线（含放弃洁净室的代价）、两条产品线各自的能力与缺口、上游同步策略、风险 |

### 申报材料（`docs/`）

图表与品牌素材见 [`docs/README.md`](docs/README.md)。计划书与申请书含团队成员的个人信息，已于 2026-09-26 移出仓库，说明见同一文件。

---

## 开发入门

沿用基座的命令与门禁，不另起一套。

**环境要求**：[Bun](https://bun.sh/) ≥ 1.3.11（版本偏低会遇到难以定位的问题，基座对此敏感）。

```bash
bun install          # 安装依赖，workspace 内部包自动链接

bun run dev          # 开发模式启动
bun run precheck     # typecheck + lint fix + test —— 任务完成后必须零错误通过
```

其他常用：

```bash
bun test <path>            # 跑单个测试文件
bun run typecheck
bun run check:cycles       # 循环依赖棘轮（双向严格：超预算与低于预算都 fail）
bun run check:mock-hygiene # mock 卫生棘轮
```

完整脚本清单见 `package.json`。

**开工前必读**：
1. 本仓库的 [`CLAUDE.md`](CLAUDE.md) —— 阡陌自己的约定，以及基座硬规则中与阡陌开发直接相关的部分。
2. [`CLAUDE.md`](CLAUDE.md) 的**基座原文部分**（分界注释以下的下半部分，即基座 CLAUDE.md 原文）—— 架构地图、路径与隔离不变式、测试与 mock 规范。**改任何路径相关代码前必须读它。**
3. [`docs/dev/charter.md`](docs/dev/charter.md) §5 —— 工程基座与法律边界，强制条款。

**提交规范**：Conventional Commits + 中文描述（`feat:` / `fix:` / `docs:` / `chore:` / `refactor:`），沿用基座约定。全部走 PR + 至少一人评审，不直推主干。

**本仓库不发 npm 包、不跑基座的 release 流程**（章程 N-14）。

---

## 许可

**双许可仓库，两层各有各的许可，分界线就是成果边界本身。**

| 哪一层 | 许可 | 正文 | 怎么认出来 |
|---|---|---|---|
| 阡陌自有代码 | **GNU AGPL-3.0-or-later** | [`LICENSE`](LICENSE) | 文件头带 `SPDX-License-Identifier: AGPL-3.0-or-later` |
| 由基座导入的代码 | **MIT** | [`LICENSE.base`](LICENSE.base) | 文件在基座快照里：`git cat-file -e base-snapshot/v2.46.0:<路径>`。**不能用「不带 SPDX 头」反推**，见 [`NOTICE`](NOTICE) 一、许可 |

```bash
# 举出属于 AGPL 那一层的文件——作数的是这条命令，不是某个写死的数字
# （每新增一个带该文件头的文件它就会变；带日期锚的实测值以根 NOTICE 一/1 为准）
# 限定在文件头，所以不会把「正文里引用了这行字」的文档（NOTICE、本文件等）算进去
git grep -n "SPDX-License-Identifier: AGPL-3.0-or-later" \
  | awk -F: '$2<=5' | cut -d: -f1 | sort -u
```

选 AGPL 而不是 GPL，是因为阡陌的产品线②是**网络型产品**：最可能被无偿占用的方式
是把它做成托管服务对外提供，而这正是 GPL-3.0 管不着、AGPL-3.0 §13 管得着的那一格。

MIT 可并入 AGPL 作品，反向不成立——因此本仓库对基座那层的改动若要回贡上游（MIT），
需要单独授权。本次变更**不可追溯**：此前按 MIT 取得副本者的授权不受影响。

覆盖范围、`vendor/audio-capture/` 六个预编译二进制的来源与逐个的证据等级，详见 [`NOTICE`](NOTICE)。

"Claude"、"Claude Code" 与 "Anthropic" 是 Anthropic, PBC 的商标。本项目与 Anthropic 无关联、未获其背书。

---

## 附：基座 open-claude-code 原版 README（与上游同步保持逐字一致）

> 以下是基座 open-claude-code 的 README 原文（导入点 `3380c88` 的逐字副本），保留在此是为了让上游同步的补丁干净落下（P10.3①，见 [`docs/dev/upstream-sync-drill.md`](docs/dev/upstream-sync-drill.md) §5②）。
> **它描述的是基座本身，不是阡陌**；阡陌的介绍与对外口径见本文件上半部分。不要在这里就地改写——要改等上游同步带进来。

# Open Claude Code (occ)

[![GitHub Stars](https://img.shields.io/github/stars/sweetcornna/open-claude-code?style=flat-square&logo=github&color=yellow)](https://github.com/sweetcornna/open-claude-code/stargazers)
[![GitHub Issues](https://img.shields.io/github/issues/sweetcornna/open-claude-code?style=flat-square&color=orange)](https://github.com/sweetcornna/open-claude-code/issues)
[![Last Commit](https://img.shields.io/github/last-commit/sweetcornna/open-claude-code?style=flat-square&color=blue)](https://github.com/sweetcornna/open-claude-code/commits/main)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?style=flat-square&logo=bun)](https://bun.sh/)

> An open-source terminal AI coding assistant that coexists with official Claude Code.

**English** · [简体中文](./README.zh.md) · [日本語](./README.ja.md)

**open-claude-code** (`occ`) is a full restoration of Anthropic's [Claude Code](https://docs.anthropic.com/en/docs/claude-code), extended with Goal-driven execution, multi-agent orchestration, Artifacts and ACP support — and **fully isolated from official Claude Code**, so both can be installed on the same machine without interfering.

## Isolation from official Claude Code

This is the main difference from other forks. Before isolation, the fork shared `~/.claude`, `~/.claude.json`, the cache tree — **and the same macOS keychain entry**, so signing in to either CLI overwrote the other's OAuth token. Now they are separate:

| | open-claude-code | Official Claude Code |
| --- | --- | --- |
| User config | `~/.occ/` | `~/.claude/` |
| Global state | `~/.occ.json` | `~/.claude.json` |
| Project assets | `.occ/` | `.claude/` |
| Cache | `~/.cache/occ-nodejs/` | `~/.cache/claude-cli-nodejs/` |
| Credentials (macOS) | `Open Claude Code-credentials-<hash>` | `Claude Code-credentials` |
| Enterprise policy | `/etc/occ`, `win.open-claude-code.occ` | `/etc/claude-code`, `com.anthropic.claudecode` |
| Env override | `OCC_CONFIG_DIR` | `CLAUDE_CONFIG_DIR` (still honoured) |

**Deliberately shared:** the `CLAUDE.md` / `CLAUDE.local.md` / `AGENTS.md` memory filenames are unchanged, because they are a cross-tool convention and renaming them would lose context in every existing repository. Child processes still receive `CLAUDECODE=1` (many user hook scripts gate on it) plus `OCC=1`. IDE lockfiles are searched in both roots, since the marketplace extension is Anthropic's and writes to `~/.claude/ide`.

### Migrating from official Claude Code

```sh
occ migrate --dry-run          # show what would be copied
occ migrate                    # do it (secrets stripped)
occ migrate --with-credentials # bring your login across too
```

Both modes copy the **same things**: settings, skills, agents, commands, output-styles, workflows, plugins, rules and MCP server definitions. They differ only in whether secrets ride along. The first-run wizard offers the same three choices.

- **Default (no credentials):** strips the OAuth token, the API key, the secret half of `settings.env`, MCP `env`/`headers`, and the `apiKeyHelper` / `awsAuthRefresh` / `awsCredentialExport` / `gcpAuthRefresh` / `otelHeadersHelper` hooks that resolve credentials by running a command. **Routing config is kept**: `*_BASE_URL`, `*_MODEL`, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_USE_*`, `*_AUTH_MODE` and certificate *paths* such as `CLAUDE_CODE_CLIENT_CERT` / `CLAUDE_CODE_CLIENT_KEY` (a path is not a secret, and the mTLS pair is useless split — only `..._PASSPHRASE` is stripped). Everything stripped is listed by name before anything is written.
- **`--with-credentials`:** also copies the OAuth token, the legacy API key and the account keys in `~/.claude.json` (`primaryApiKey`, `oauthAccount`, `customApiKeyResponses`, `workspaceApiKey`), so occ works without a fresh `/login`. **Caveat:** the server rotates the OAuth refresh token and both CLIs now hold the same one, so whichever refreshes first invalidates the other — pick one for day-to-day use.
- Changed your mind after the default run? `occ migrate --with-credentials` tops up the login *and* restores the `settings.json` secrets the first run stripped — filling only what is missing, never overwriting a value you have since changed on the occ side. The `.migrated` marker records which categories ran, so it will not lock you out.
- `--skip-account-data` / `--no-account-data` are the pre-2.9 spellings and now mean the default mode.
- Two places are copied verbatim and **named in the report** because nothing here can classify them: `settings.json`'s `pluginConfigs`, and the files inside `plugins/`. Fields a plugin declares `sensitive` live in secure storage, which this mode never touches — but that split is enforced by each plugin's own manifest, so the residue is yours to review.

**Session history is never copied.** The credential copy is one-way and no-clobber: an existing occ login always wins, and the official keychain entry is never modified. `~/.claude` is read-only throughout: nothing is written, moved or deleted there.

## Quick start (published package)

```sh
npm i -g @sweetcornna/open-claude-code

occ           # run on Node.js
occ-bun       # run on Bun
occ update    # update to the latest version
```

> **The scope is required.** The unscoped `open-claude-code` name on npm is a squatted `0.0.0`
> placeholder that is not this project: it has no `bin`, so `npm i -g open-claude-code` appears to
> succeed (`added 1 package`) and leaves you with no `occ` command at all.

> The pre-2.8 `ccb` / `ccb-bun` names have been removed — scripts still calling them must switch to `occ` / `occ-bun`.

## Quick start (from source)

### Requirements

Use the latest Bun — older versions cause a lot of strange bugs.

- [Bun](https://bun.sh/) >= 1.3.11

```bash
# Linux / macOS
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# Already installed
bun upgrade
```

### Install and run

```bash
cd /path/to/open-claude-code
bun install

bun run dev      # development mode
bun run build    # build
```

The build uses code splitting; output lands in `dist/` and runs under both Bun and Node.js.

### First-time `/login`

Run `/login` in the REPL and pick **Anthropic Compatible** to use any third-party compatible service — no Anthropic account required. OpenAI, Gemini and Grok have their own sections.

| Field | Description | Example |
| --- | --- | --- |
| Base URL | API endpoint | `https://api.example.com/v1` |
| API Key | Auth key | `sk-xxx` |
| Haiku Model | Fast model ID | `claude-haiku-4-5-20251001` |
| Sonnet Model | Balanced model ID | `claude-sonnet-5` |
| Opus Model | High-capability model ID | `claude-opus-5` |
| Fable Model | Top-tier model ID | `claude-fable-5` |

**Tab / Shift+Tab** moves between fields, **Enter** confirms; Enter on the last field saves.

## Features

| Feature | Description | Docs |
| --- | --- | --- |
| **Goal-driven execution** | `/goal <objective>` drives the agent across turns until done, with a token budget, completion/blocked audit and `pause`/`resume`/`continue`/`clear` | [`src/commands/goal/`](./src/commands/goal/) |
| **Ultracode multi-agent orchestration** | `/ultracode` plus the `Workflow` tool runs deterministic JS scripts (`agent`/`pipeline`/`parallel`/`phase`); `/workflows` gives a live panel, with journal replay and a concurrency cap | [docs](./docs/zh/features/workflow-scripts.md) |
| **Artifacts** | The model renders HTML/dashboards/reports into standalone pages. Local `file://` output by default; opt in to a shared or self-hosted URL (Cloudflare Worker + R2, 7d/30d expiry) | [docs](./packages/cloud-artifacts/README.md) |
| **ACP protocol** | Connect Zed, Cursor and other IDEs, with session resume, Skills and permission bridging | [docs](./docs/zh/features/acp-zed.md) |
| **Remote Control** | `occ remote-control` hands the session to [Happy](https://github.com/slopus/happy) (phone / web / end-to-end encrypted) over occ's own ACP agent; the server is self-hostable | [docs](./docs/zh/features/remote-control-self-hosting.md) |
| **Langfuse monitoring** | Inspect every agent loop in detail, export to a dataset in one click | [docs](./docs/zh/features/langfuse-monitoring.md) |
| **Web search** | Built-in search via Bing / Brave | [docs](./docs/zh/features/web-browser-tool.md) |
| **Poor mode** | Disables memory extraction and typing suggestions to cut concurrent requests | `/poor` |
| **Channels** | MCP servers push external messages into the session (Feishu/Slack/Discord…) | [docs](./docs/zh/features/channels.md) |
| **Custom providers** | OpenAI / Anthropic / Gemini / Grok compatible | [docs](./docs/zh/features/all-features-guide.md) |
| Voice mode | Voice input, including Doubao (`/voice doubao`) | [docs](./docs/zh/features/voice-mode.md) |
| Computer Use | Screenshots, keyboard and mouse control | [docs](./docs/zh/features/computer-use.md) |
| Browser MCPs (user-configured) | Add any browser MCP through ordinary MCP configuration; names such as `chrome-devtools` and `mcp-chrome` are not reserved | [docs](./docs/zh/extensibility/mcp-configuration.mdx) |
| `/dream` | Automatic memory consolidation | [docs](./docs/zh/features/auto-dream.md) |

## Feature flags

Enable with `FEATURE_<FLAG_NAME>=1`:

```bash
FEATURE_FORK_SUBAGENT=1 bun run dev
```

The 33 flags on by default are in `DEFAULT_BUILD_FEATURES` in [`scripts/defines.ts`](./scripts/defines.ts); anything else needs the env var. Per-feature notes live in [`docs/zh/features/`](./docs/zh/features/).

## Debugging in VS Code

TUI (REPL) mode needs a real terminal, so use **attach mode**:

```bash
bun run dev:inspect     # prints ws://localhost:8888/xxxx
```

Set breakpoints under `src/`, then F5 → **"Attach to Bun (TUI debug)"**.

## Development

```bash
bun run precheck      # typecheck + lint fix + test — must pass with zero errors
bun run typecheck
bun run test
bun run build:vite
```

Architecture, the module map, the path/isolation invariants and the testing rules are in [`CLAUDE.md`](./CLAUDE.md) — **read it before touching any path-related code**.

## Acknowledgements

- [doubaoime-asr](https://github.com/starccy/doubaoime-asr) — Doubao ASR SDK, which gives Voice Mode a speech input path that needs no Anthropic OAuth
- [free-search-mcp](https://github.com/sweetcornna/free-search-mcp) — local-first, no-API-key search MCP server. WebSearch's `free` source is a port of its keyless engine pool (DuckDuckGo / Mojeek / Bing), RRF fusion and SearXNG rescue pass

## License

The restoration and original work in this repository are released under the [MIT License](./LICENSE). "Claude", "Claude Code" and "Anthropic" are trademarks of [Anthropic](https://www.anthropic.com/); this project is not affiliated with, or endorsed by, Anthropic.
