<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 身份隔离三者共存正式验收（M1 · P10.1）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.1** |
| 日期 | 2026-08-17（v1.0）／2026-08-18（v1.1） |
| v1.1 改了什么 | 只回写 `qm` 由「名义上的 CLI 名」变成**真的可安装的 `bin`** 这一件事：§1 的观察方式补第二条、§2 表与其下新增一段、复现命令补一条。**验收结论、§3 扫描记录、§4 真机枚举、§5 对账一字未动** |
| 任务包 | retro-m0.md §7.2 **P10.1 身份隔离三者共存正式验收**（M1 首迭代；依赖 P0.3，已闭） |
| 三方 | ① 官方 Claude Code（`.claude`）② occ 默认身份（`.occ`）③ 阡陌节点态（`OCC_IDENTITY=qianmo` → `.qianmo`） |
| 结论 | **通过**：四类资产（配置根 / 凭据 / 缓存 / 项目资产）三方两两不相交；全仓生产代码**零绕过** `paths.ts`（2648 文件机器扫描，本包顺手修掉最后 3 处）；真机上官方与 occ **已长期实际共存**且互不越界 |
| 复现 | `bun test src/config/__tests__/identityIsolation.test.ts`（9 用例）＋ `bun test src/constants/__tests__/invokedBinName.test.ts`（6 用例，v1.1 新增，见 §1）＋ `bun run check:identity-paths`（棘轮）＋ §4 的真机枚举命令 |

## 1. 验收对象与方法

隔离机制本身是 P0.3 交付的（`src/config/paths.ts` 单点派生 + `src/constants/identity.ts`
的 `byIdentity`/`acrossIdentities` 双答案设计）。本包做的是**正式验收**，不是重做：

1. **子进程探针实测**（`identityProbe.runner.ts`）：身份在模块加载期钉死，所以诚实的观察
   只能来自**新进程**——起法有两种：带不同 `OCC_IDENTITY` 与一次性 HOME 起一个，或者走
   `qm` 入口（它在自己的文件里把 `OCC_IDENTITY` 默认成 `qianmo`，见 §2）。**这不是两个
   身份判定点**：判定始终只有 `src/constants/identity.ts` 里 `IDENTITY_MODE` 那一处读
   `OCC_IDENTITY`，`qm` 只是那个 env 的另一个**写入方**，而且是 `??=` 的默认值写入——
   调用方显式给的值仍然胜出。9 条用例覆盖命名空间解析、写保护并集、凭据互不可见、
   **解析后落盘树前缀不相交**（本包新增）。
   **v1.1 补记**：同一个探针另被 `src/constants/__tests__/invokedBinName.test.ts` 的 6 条
   用例驱动（它用**真实文件**而不是软链做 shim——Bun 会在填 `argv[1]` 之前解析软链），
   钉的是「显示名 ≠ 身份」：叫 `qm` 的 shim 在没有 `OCC_IDENTITY` 时配置根仍解析到
   `.occ`。
2. **零绕过机器扫描**（`scripts/check-identity-paths.ts`，本包新增，`bun run
   check:identity-paths`）：扫 `src/` 与各包 `src/` 全部生产文件，注释剥离后禁三类
   字面量。零容忍、无预算文件——正确数字就是零。
3. **真机枚举**（§4）：在本开发机上枚举三方四类资产的实际路径与存在性。

## 2. 四类资产的三方对照（探针解析值）

| 资产类 | 官方 Claude Code | occ | 阡陌节点态（qianmo） |
|---|---|---|---|
| 用户级配置根（含凭据 `.credentials.json`） | `~/.claude` | `~/.occ` | `~/.qianmo` |
| 全局状态文件（mcpServers / OAuth 账户） | `~/.claude.json` | `~/.occ.json` | `~/.qianmo.json` |
| env-paths 缓存根（macOS） | `~/Library/Caches/claude-cli-nodejs` | `~/Library/Caches/occ-nodejs` | `~/Library/Caches/qianmo-nodejs` |
| XDG data / cache / state | （官方自管） | `~/.local/share/occ` 等三处 | `~/.local/share/qianmo` 等三处 |
| 项目资产目录（settings / hooks / agents） | `<proj>/.claude` | `<proj>/.occ` | `<proj>/.qianmo` |
| CLI 名（`package.json` 的 `bin`） | `claude` | `occ`（另有 `occ-bun` / `open-claude-code` 两个同物别名） | **`qm`** → `dist/cli-qianmo.js` |

**`qm` 自 2026-08-18 起是真的装得出来的名字**，不再只是「这个身份对外该叫什么」的一格
登记：`bin` 第四项 `qm` 指向 `scripts/entrypoints.ts` 生成的 `dist/cli-qianmo.js`，该文件头
一行就是 `process.env.OCC_IDENTITY ??= "qianmo"`，随后才**动态** import 运行时农场——静态
import 会被 ESM 提升并先于模块体的语句求值，农场会赶在赋值之前按 occ 的配置根初始化。
`??=` 而非 `=`，所以 `OCC_IDENTITY=occ qm …` 仍然是 occ。**身份仍然只从 env 判定**（§1）；
另有一个 `invokedBinName()`（`src/constants/brand.ts`）回答「用户敲的是哪个名字」，**只用于
帮助文本**，`BIN_NAME` 一个字节没动。它与 `BIN_NAME` 何时不一致、以及一处已决定不修的显示
不准，见 [`console.md`](./console.md) §3；`qm` 是 bun shebang 这件事的代价见同文 §2.1。

**两两不相交在两个层面被钉住**：命名空间字符串逐项不同（用例「every isolation-bearing
value differs」），且**解析后的落盘树互不为前缀**（用例「resolved cache and XDG trees
are prefix-disjoint and HOME-scoped」）——后者防的是「一个产品的递归删除/复制吃掉另一个
产品的缓存」这种字符串比较看不出的事故。

**写保护是并集而非本身份**：任一身份运行时，三方的配置根与全局文件**全部**在保护清单里
（用例「write protection covers every identity, in every identity」）——这是 P0.3 修过的
真实回归（只保护自己 + `.claude`，会放任沙箱命令改写第三方的 `~/.occ/.credentials.json`）。

**凭据互不可见**：qianmo 登录后 occ 读不到、occ 登录落在 `.occ` 不碰 `.qianmo`、各自读回
各自的 token（用例「credentials do not cross identities」）。

## 3. 零绕过扫描：结果与本包修掉的最后三处

`bun run check:identity-paths` → **`2648 production files scanned, 0 bypasses`**。

首次扫描抓到 3 处真实绕过，已随本包修复（行为逐字不变，均为「该用 legacy 常量而裸写了
字面量」）：

| 处 | 原样 | 修法 |
|---|---|---|
| `src/utils/terminal/ide.ts:482`（WSL Windows 侧 IDE 锁目录启发式） | `resolve(wslPath, '.claude', 'ide')` | `LEGACY_CONFIG_DIR_BASENAME` |
| `src/utils/terminal/ide.ts:507`（同上，`/mnt/c/Users/*` 枚举） | `join(usersDir, user.name, '.claude', 'ide')` | 同上 |
| `src/config/migrateFromClaude.ts:787`（迁移读 legacy 全局文件） | `join(sourceDir, '..', '.claude.json')` | 新增 `LEGACY_GLOBAL_CONFIG_FILENAME`（与目录基名同源派生，不会漂移） |

**按设计豁免、不算绕过**（首扫核实过一遍，写死在脚本头注里）：第三方工具点目录
（`.bun` / `.codex` / `.config` / `.ccr`——它们不属于三身份命名空间）；User-Agent 模板里的
`claude-cli/<version>` 与 `claude-cli-internal` 仓库名（CLAUDE.md §1.1③「明确不改」的
协议位）；旧安装清理必须认得的 `claude-cli-native-` 前缀。

## 4. 真机枚举（本开发机，2026-08-17）

| 路径 | 状态 | 说明 |
|---|---|---|
| `~/.claude`、`~/.claude.json`、`~/Library/Caches/claude-cli-nodejs` | **存在** | 官方 Claude Code 活跃使用中 |
| `~/.occ`、`~/.occ.json`、`~/Library/Caches/occ-nodejs` | **存在** | occ 活跃使用中（`~/.occ` 含真实凭据） |
| `~/.qianmo`、`~/.qianmo.json`、`~/Library/Caches/qianmo-nodejs` | 不存在 | 节点态身份在本机尚未启用——派生正确、落盘为零，**如实记录** |

即：**官方与 occ 在同一台机器上长期真实共存、四类资产零交叠**；qianmo 的隔离面由同一
套派生给出（§2 表第三列），其正确性由子进程探针在一次性 HOME 里实测。枚举命令：
探针 `report` 子命令只派生路径、零写入，可对真实 HOME 直接跑。

## 5. DoD 对账（retro §7.2 P10.1 行）

| DoD | 状态 |
|---|---|
| 三者共存实测通过并留档（四类互不读写） | ✅ §2/§4；9 用例（`bec20efa`），真机枚举本文 |
| 零处绕过 `paths.ts` 的全仓 grep 自查**入库** | ✅ `scripts/check-identity-paths.ts` + `bun run check:identity-paths`（`ddd11ffc`）；顺手修掉最后 3 处（`ab2e8746`） |
| 报告进 `docs/dev/` | ✅ 本文 |

**边界如实记**：① 官方 Claude Code 侧「不越界」的证据是**结构性的**（occ/qianmo 的保护
清单覆盖 `.claude`，且官方产品不认识 `.occ`/`.qianmo` 名字）加**观察性的**（本机长期共存
无事故）——没有对官方产品做注入式实测，它不是我们的被测物。② 棘轮未进 precheck/CI，
是独立命令；要不要挂进 `verify` 由 M1 门禁评审定（挂上是一行）。③ macOS 钥匙串条目的
隔离归 P0.3 原验收（`macOsKeychainHelpers.ts` 按身份取前缀），本文不重测。
