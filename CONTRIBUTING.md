# 贡献指南

欢迎参与**阡陌 AgentNest**。这份文档讲**怎么在这个仓库里干活**；架构、模块地图、feature flag 体系这些「代码是什么样」的问题，一律以 [`CLAUDE.md`](CLAUDE.md) 为准。

> 术语保留英文原文（feature flag、barrel、ratchet 等），因为它们同时是代码里的标识符，翻译会让搜索失效。

## 1. 开始之前

按这个顺序读：

1. [`CLAUDE.md`](CLAUDE.md) —— 唯一的架构真源。**「路径与隔离不变式」一节在动任何路径相关代码前必读。**
2. 本文档 —— 工作流与规范。
3. 你要改的那块代码附近的 `docs/`。

**这个仓库是两层。**阡陌基于团队负责人自有的开源项目 **open-claude-code**（CLI 名 `occ`，MIT 许可）构建，
并在其上实现常驻化改造与智能体通信网络。基座以零改动快照导入，**目录结构原样保留在仓库根**，阡陌自己的代码是
`packages/` 下的 `@qianmo/*` workspace 包加上对基座运行时的改造（溯源见 [`BASE.md`](BASE.md)）。

因此你要动的那块代码属于哪一层，决定了适用哪套规矩：

- **基座那层**是 Anthropic Claude Code CLI 的逆向/反编译还原版，目标是恢复核心功能、裁掉次要能力，
  并与官方 Claude Code 做到用户态完全隔离。很多模块是 stub 或被 feature flag 关掉的 —— 看到「空实现」
  先确认是不是有意为之，再动手补。**改它要考虑上游同步成本**（见 §1 之后各节与 `CLAUDE.md` §2.3：能走扩展点就别改核心）。
- **阡陌那层**是本项目的自有工作，范围以 [`docs/dev/charter.md`](docs/dev/charter.md) 为唯一依据。

分不清某个 `packages/` 子目录属于哪一层，看它 `package.json` 的 `name`：`@qianmo/*` 是阡陌的，其余是基座的。

## 2. 环境准备

```bash
bun install          # 这是 Bun 项目，不是 Node 项目
```

- **Bun 而非 Node**：所有 import、构建、执行都走 Bun API（`engines.bun >= 1.3.11`，`.tool-versions` 钉了具体版本）。**不要用 `npx`，用 `bunx`** —— pre-commit hook 曾因为这个坏掉过。
- 首次跑 `bun run dev` 前不需要额外配置；feature flag 的默认启用列表见 `scripts/defines.ts`。

## 3. 日常工作流

```bash
bun run dev                    # 开发模式
bun test src/path/to/x.test.ts # 单个测试文件
bun run precheck               # 任务完成前必须跑，且必须零错误
```

`precheck` = `tsc --noEmit` + `biome check --fix` + 三道毫秒级门禁 + 全量 `bun test`。注意它**会改写你的文件**（`check:fix` 而非 `check`），跑完记得看 `git diff`。

推送 / 发 PR 之前跑 **`bun run verify`** —— 它是只读式的近 CI 全量检查（`biome ci` 而非 `--fix`），并补上 `precheck` 不含的几道重活（`check:cycles`、`check:unused`、`check:bundle`、`build:vite`、分片测试）。**`precheck` 过 ≠ CI 会过**，两者的差集就在这里。

**九道 `check:*` 门禁必须全部接进 `verify` 与 CI。** 一道定义了却没接的门禁比没有更糟：它看着在，其实从不运行，而写的人以为有人在守。2026-08-26 清出过两道这样的孤儿——`check:identity-paths`（守三方身份隔离，且在干净树上恒红）与 `check:docs-i18n`（守文档站死链），后者的失守直接导致 `sync-docs-i18n.ts` 与 `check-docs-i18n.ts` 对同一条约定分叉而无人发现。**新增 `check:*` 脚本时，同一个提交里必须把它接进 `verify` 和 `.github/workflows/ci.yml`。**

完整命令表在 [`CLAUDE.md`](CLAUDE.md) 的 Commands 一节，这里不复制。

## 4. 「指针不复制」铁律

**同一个事实只允许存在于一个地方，其他地方只放指针。**

这条不是洁癖，是有代价的教训：`AGENTS.md` 曾经是 `CLAUDE.md` 的完整副本，两份漂移到相差 783 行，审计发现副本里有 **21 处与代码不符的陈述** —— 不存在的 workspace package、过期的 feature flag 计数、脚本早已删除的命令。现在 `AGENTS.md` 只剩 17 行指针。

落到日常：

- 写文档前先搜一遍这个事实是不是已经写在别处。是，就链接过去。
- 需要在两处都提到时，一处写完整内容，另一处只写「见 X」。
- 代码注释同理：注释该写代码本身表达不了的约束（为什么必须这样），而不是复述代码在做什么。

## 5. 提交规范

**Conventional Commits**：

```
<type>: <描述>
<type>(<scope>): <描述>
```

- 常用 type：`feat`、`fix`、`docs`、`chore`、`refactor`、`perf`、`test`
- **scope 可选**，用于点明改动范围：`refactor(messages):`、`fix(acp):`、`perf(sessionStorage):`
- **语言**：中英文都接受，仓库历史两者都有。同一个 PR 内保持一致即可。描述要说清**做了什么**，别写 "update code" 这种。
- 一个提交一件事。重构与行为改动分开提交 —— 混在一起的 diff 没法审。

## 6. 代码规范

- **TypeScript strict，tsc 必须零错误。**
- **生产代码禁止 `as any`**（测试里的 mock 数据可以）。类型对不上优先 `as unknown as SpecificType` 双重断言或补 interface；未知结构用 `Record<string, unknown>`；联合类型用类型守卫收窄，不要强转。
- **Biome** 管 lint 与格式化，覆盖 `src/`、`scripts/`、`packages/`。42 条规则因反编译代码被关掉，只留 `recommended` 基线。`.tsx` 是 120 列 + 强制分号，其他文件 80 列 + 按需分号 —— 移动代码到不同扩展名的文件会导致重排，拆分时留意。
- **`feature()` 的位置约束**：`import { feature } from 'bun:bundle'` 是 Bun 内置模块。`feature('X')` **只能出现在 `if` 语句或三元表达式的条件位置**，不能赋值给变量、不能放进箭头函数体、不能作为 `&&` 链的一部分。这是编译器限制，不是风格偏好。
- **React Compiler 产物**：组件里的 `const $ = _c(N)` memoization 样板是反编译产物，正常现象，别"清理"。

## 7. 测试规范

- 框架 `bun:test`；单元测试就近放 `src/**/__tests__/<module>.test.ts`，集成测试放 `tests/integration/`。
- **只 mock 有副作用的依赖链**，不 mock 纯函数/纯数据模块。
- **`mock.module` 是进程全局的**（last-write-wins），会污染同进程里所有其他测试文件 —— 这是本仓库最难查的一类失败。核心规则：**不要 mock 被测模块的上层业务模块**，要 mock 就 mock 底层（比如 mock `axios` 而不是 mock 调用它的 API 模块）。
- `log.ts` / `debug.ts` 用 `tests/mocks/` 下的共享 mock，不要在测试文件里内联。
- 修 bug 先写出会红的测试，再让它变绿。**不要为了让测试过而削弱断言或 skip 用例。**

完整的 mock 规则与污染排查方法在 [`CLAUDE.md`](CLAUDE.md) 的 Testing 一节。

## 8. 路径与隔离不变式

occ 必须能和官方 Claude Code 装在同一台机器上互不干扰。**所有路径都从 `src/config/paths.ts` 派生**，禁止字面量拼接 `homedir() + '.claude'`。

隔离改造前有 12 处绕过 helper 直接拼路径，其中两处是真实事故：卸载逻辑会 `rm -rf ~/.claude/local`（等于删掉官方 CLI 的本地安装），`doctor` 上报的路径和它实际检查的路径根本不是同一个。

具体对照表（要什么用什么、绝对不要写什么）、以及**故意保持不变**的那几项（`CLAUDE.md` 文件名、`CLAUDECODE=1`、`~/.claude/ide` 锁文件目录），见 [`CLAUDE.md`](CLAUDE.md) 的「路径与隔离不变式」。改这块之前请务必读完。

## 9. 循环依赖棘轮（ratchet）

`bun run check:cycles` 用 madge 统计循环依赖，与 `scripts/cycle-budget.json` 的预算比对。**它是双向严格的**：超预算失败，低于预算**也**失败。

- 环数**变多** → 先想办法破环。确实是新功能的合理代价，才 `--update` 抬预算，并在提交信息里说明理由。
- 环数**变少** → 恭喜，`bun run check:cycles -- --update` 把改进锁进预算，防止回退。

一个反复出现的现象要知道：**把大文件拆成 barrel + 子模块，往往会让 total 数字上升,而真实耦合是下降的** —— madge 的 DFS 会为多出来的一跳枚举出更多路径。判断方法是对比拆分前后的**边集**（谁 import 谁），而不是看环数。这类情况照常 `--update`，但提交信息要写清楚是表示性变化还是真新增耦合。

另外：手写 lazy `require()` 当"破环器"**无效** —— madge 把 `require` 边也算进去。不要再加这类代码。

### 9.1 Mock 卫生棘轮

`bun run check:mock-hygiene` 与 `scripts/mock-hygiene-budget.json` 比对，同样双向严格，同样在 precheck 和 CI 里。

规则只有一条：**mock 仓库内的模块必须走 `tests/mocks/` 的 helper，不能写内联 `mock.module('src/…', () => ({ … }))`。** 外部 specifier（`bun:bundle`、`axios`、`node:*`）豁免——它们没有可委托的仓库模块。

脚本查两类，分别记账：

1. **内联表面** —— `mock.module('src/…', () => ({ … }))`。
2. **未复位的覆盖** —— `setupXMock({ … })` / `.setup({ … })` 在模块顶层装了覆盖，全文件却没有任何 `.reset()`。

为什么值得一条棘轮：Bun 把一个分片的所有测试文件跑在**同一个进程**里，而 `mock.module` 是进程全局、last-write-wins 的。所以内联 mock 不是「给自己」装的，是给此后加载的每个文件装的。而且**表面完整也不够**，关键是覆盖的生命周期：

- `src/utils/sandbox/__tests__/` spread 了真实模块（表面完整），只把 `getSettingsFilePathForSource` 永久钉成 `undefined` → `changeDetector.test.ts` 监听了错误目录。
- `MagicDocs/__tests__/prompts.test.ts` 在套件结束后装了个**手写的** fs 适配器，缺 `mkdirSync` 等一批 `*Sync` 方法 → `updateSettingsForSource` 抛错被吞 → `pluginOperations.builtinSecurity.test.ts` 拿到 `success:false`。

两个都只在 Linux 上炸：**Bun 的测试文件顺序由文件系统决定，既不是字母序也不是命令行参数顺序，本地无法复现、也无法用参数控制**。CI 从 v2.11.0 到 v2.30.0 连续 55 次全红。正确写法是 `setup()` 装完整表面 → `beforeAll` 里 `set()` → **`afterAll` 里 `reset()`**；能用模块自带的 setter（如 `setFsImplementation`/`setOriginalFsImplementation`）就别用 `mock.module`。

存量按文件记在预算里，逐步转换；每转换一处跑 `--update` 提交更低基线。

### 9.2 死代码棘轮

`bun run check:unused` 是**套在 knip 外面的棘轮**，不是裸 knip。裸 knip 报 ~1900 条未使用导出/类型，其中相当一部分**不能删** —— 光 `src/entrypoints/sdk/` 就占约 170 条，那是 Agent SDK 的公开 schema 表面，`coreTypes.generated.ts` 正是从 `coreSchemas.ts` 生成的，"内部没人 import"是预期状态而非缺陷。照 knip 的话删会破坏已发布的契约。

所以按可信度分两档：

- **硬性零**（`files` / `dependencies` / `devDependencies` / `optionalPeerDependencies` / `unlisted` / `unresolved` / `binaries`）—— 已逐条核实清空，再出现就是真事故（没人 import 的文件、没人用的依赖、解析不到的 import）。**一出现就 fail。**
- **预算档**（`exports` / `types` / `duplicates`）—— 存量记在 `scripts/unused-budget.json`，双向严格，与前面几个棘轮同一套契约。

想看原始报告用 `bun run check:unused:raw`。

**核实过再删。** knip 在这个仓库假阳性不少：vendored Ink（`packages/@ant/*` 被整体排除在分析外）让它把 `auto-bind`、`cli-boxes`、`emoji-regex`、`react-reconciler`、`wrap-ansi` 等十个**在用**的依赖报成未使用 —— 照单删会直接搞坏构建。这类只能进 `ignoreDependencies` 并写明原因。`@napi-rs/keyring` 同理：它是**故意可选**的动态 import（模块缺失就降级到加密文件存储），不是漏声明。

### 9.3 版权头门禁

`bun run check:license-headers` 是全仓版权头门禁；需要看报数时跑
`bun run check:license-headers --report`。它是**硬零、无预算文件**，并且双向查：① 基座快照之外的阡陌自有文件漏掉前 5 行的两行头；② 基座快照内的基座文件误贴 AGPL 头。任一方向出现一例就失败，不按存量做棘轮。

豁免是**豁免名单，不是白名单**（fail-closed）：新出现的格式默认进入检查，只有确实带不了或不该带头的扩展名/路径才可豁免。具体表只看脚本的 `EXEMPT_EXTENSIONS` / `EXEMPT_PATHS` 常量，理由看 [`NOTICE`](NOTICE) 一、许可；不要在文档再抄一份。

这道门禁是因为「由 PR 评审兜」已经失效：判据覆盖从 **15** 个文件涨到 **647** 个，约 **43 倍**，2026-08-30 一次漏了 **66** 个。背景与依据见 [`docs/dev/spdx-backfill-retro.md`](docs/dev/spdx-backfill-retro.md) §2.1。

它依赖 `base-snapshot/*` 标签。浅克隆或 `--no-tags` 克隆取不到标签时会**红着退出**，这是有意的 fail-closed，不是门禁坏了；补拉：

```sh
git fetch --depth 1 origin 'refs/tags/base-snapshot/*:refs/tags/base-snapshot/*'
```

`packages/activator/test/surface-invariant.test.ts` 的包内测试**依然在**，它判「恰好第 1–2 行、恰好 `//` 形式」，比全仓门禁更严；两者口径不同是有意的，不要「统一」掉。

## 10. Pull Request

1. 从 `main` 切分支。
2. 小步提交，每个提交都能独立通过 typecheck。
3. 提交前跑 `bun run precheck`（零错误）和 `bun run check:cycles`。
4. 按 [PR 模板](.github/pull_request_template.md)填写，**验证方式一栏要贴实际跑过的命令和结果** ——「应该没问题」不算验证。
5. pre-commit hook 会自动对暂存文件跑 `biome check --fix`；CI 会跑 `biome ci` + typecheck + 环数棘轮 + 全量测试 + 构建。

发现了问题但不在本次范围内？**记录，不要顺手改。** 在 PR 描述里列出来。夹带无关改动的 diff 会拖慢审查，也让回滚变得危险。

### 10.1 仓库外的贡献者

没有本仓库写权限就 fork 一份，从你 fork 的 `main` 切分支，改完往本仓库的 `main` 发 PR。上面五条同样适用。

- **不需要签 CLA，但要知道你改的是哪一层。**本仓库是双许可的（见 [`NOTICE`](NOTICE) 一、许可），
  两层都按 inbound = outbound 并入：
  - 改**阡陌自有代码**（基座快照之外，文件头只是标记）→ 你的贡献按 **AGPL-3.0-or-later** 并入。
  - 改**基座那层**（文件在基座快照里，用 `git cat-file -e base-snapshot/v2.46.0:<路径>` 判）→ 按 **MIT** 并入，`LICENSE.base` 是它的正文。**不能用「没有 SPDX 头」反推基座层**——仓库里有 86 个文件无头却是阡陌自有，其中就有 20 个 `package.json` 与 20 个 `tsconfig.json` 这类最常被改的，判据见 [`NOTICE`](NOTICE) 一、许可。
  提交即表示你有权以对应许可贡献这些代码。**新增的阡陌源文件请带上那两行版权头**（章程 §5.5）——
  归属判据仍是基座快照，不是文件头；全仓门禁与包内测试的分工见 §9.3。
  `@qianmo/activator` 的包内测试仍断言那两行头**必须恰好在第 1–2 行且使用 `//` 形式**，
  只覆盖该包 `src/` 下的 `.ts`，不覆盖其余目录；那是**约定检查，不是归属判定**。
  缺头的真实风险是**下游许可扫描器等外部工具**——那类工具通常按
  文件头默认判定，会把它误判为基座层。
- **先开 issue 再动大工程。**这是一个有明确范围的在研项目：阡陌那层的范围以 [`docs/dev/charter.md`](docs/dev/charter.md) §3 为准，§2.2 列的非目标当前一律不做。
  落在非目标里的 PR 我们会如实说明并关闭——**先问一句能省掉整块白做的工。**
- **基座那层的改动优先发给[上游](https://github.com/sweetcornna/open-claude-code)。**在这里改基座代码，每次上游同步都要重解一遍；发到上游则两边都受益。
  **现在还多一条理由**：上游是 MIT，本仓库的阡陌层是 AGPL——MIT 能并进 AGPL，反过来不成立。
  基座那层的改动直接发上游就没有这个方向问题；发在这里再想回贡，需要单独授权。
- **安全问题不要发 PR，也不要开 issue**，走 [`SECURITY.md`](SECURITY.md) 的私密通道——公开的修复补丁本身就会暴露漏洞。

## 11. 本仓库不发布

**阡陌不发 npm 包、不打 tag、不跑基座的 release 流程**（章程 N-13/N-14，另见
[`CLAUDE.md`](CLAUDE.md) §0）。`publish-npm.yml` 已按 roadmap P0.4 移除；
`scripts/release.ts` / `scripts/releaseCore.ts` / `scripts/changelog-section.ts`
**已于 2026-08-26 一并删除** —— 它们只服务那个不存在的工作流，留着只会让人以为
这里有一条发布路径。`.github/workflows/` 下只有 `ci.yml`。

因此下面这些**都不是我们的面**，看到别去维护：

| 基座的发布面 | 在本仓库的状态 |
| --- | --- |
| `npm publish` / `--provenance` | 不做 |
| git tag `v<version>` + GitHub Release | 不做（`base-snapshot/*` 标签是另一回事，见 §12 与 CLAUDE.md §2.5） |
| `CHANGELOG.md` 的发布约定与多语言译本 | 不维护；文件保留为历史记录 |
| `package.json` 的 `version` | 只作为 `MACRO.VERSION` 的构建真源，不代表任何已发布版本 |

**版本号相关的唯一约束**：`package.json` 的 `version` 仍会编进产物（`scripts/defines.ts`），
所以它得是个合法 semver；除此之外它不承载对外含义。真正用来标识「跑的是哪份产物」的是
编译进 `dist/` 的 `SOURCE_COMMIT`，读法见 `demo/env/beta/beta-deploy.sh` 的校验段。

## 12. 文档放哪里

| 内容 | 位置 |
| --- | --- |
| 架构、模块地图、约定 | [`CLAUDE.md`](CLAUDE.md)（唯一真源） |
| 跨工具入口 | `AGENTS.md`（**只放指针**，不要往里抄内容） |
| 功能说明、集成指南 | `docs/zh/features/`、`docs/` 下按主题分目录 |
| 编号的功能规格与人工验收清单 | `spec/feature_<日期>_<编号>_<名字>/` |
| 设计文档、实施计划、评审记录 | `docs/zh/superpowers/{specs,plans,reviews}/` |

`spec/` 与 `docs/zh/superpowers/` 的分工：`spec/` 是**带编号、带人工验收清单**的正式功能规格（`spec-design.md` + `spec-plan-N.md` + `spec-human-verify.md` 一套）；`docs/zh/superpowers/` 是**按日期归档**的设计/计划/评审文档，更轻量、更连续。新功能要走人工验收就进 `spec/`，否则进 `docs/zh/superpowers/`。

**关于 `.claude/` 与 `.occ/` 双目录**：仓库里两个都有，这是有意的。`.claude/` 放**跨工具生态共享**的资产（skills、agents —— 官方 Claude Code 和其他 AI 工具也读这里），`.occ/` 放 **occ 独有**的运行时产物（workflow-runs 等）。判断标准：别的工具也该看到 → `.claude/`；只有 occ 认识 → `.occ/`。

## 13. 文档语言

`docs.json` 的 `navigation.languages` 现在**只声明一棵树**：

| 语言 | 目录 | 状态 |
| --- | --- | --- |
| `zh` | `docs/zh/**` | 完整，且是默认 |

**英文与日文文档树已于 2026-08-26 移除**（`docs/en/**`、`docs/ja/**` 各 64 页，
连同 `CHANGELOG.en.md`、`CHANGELOG.ja.md`）。理由：本项目不发布英日文档站，
那 128 个文件是纯维护负担 —— 而**落后的译本比没有译本更糟**，它会让读者以为
自己看到的是现状。

**三份 README 全部保留**，它们不在这条规则内，原因有两层：`README.md` 是 GitHub
首页；而 `README.zh.md` 与 `README.ja.md` 是**法律链举证件** ——
`docs/dev/license-chain-m0.md` 把它们列为核对对象并记着「`README.ja.md`（第 168 行）
的许可段已无用途限定，实读核对」，章程风险 **L-5「已解除」**的对策②也以它们为据。
删掉等于把举证件抽走，而章程 §5 是强制条款。**精简时先查一遍 `docs/dev/` 有没有
把某个文件当证据引用**，这一条比「它看起来没人引用」优先。

**不要手改 `docs.json` 的 navigation**，它由 `bun run sync:docs-i18n` 从磁盘状态生成：
Mintlify 对「声明了但文件不存在」的导航项不会跳过，而是发布成一个 404。

**要加回一种语言，改 `scripts/sync-docs-i18n.ts` 的 `LANGS`，那是唯一出处。**
只改 `docs.json` 不改它，下一次 sync 会把你的改动覆盖掉；反过来，只从 `docs.json`
删语言而不改 `LANGS`，sync 会把空的语言树原样写回去，站点上就是一个空页签
（2026-08-26 实测踩过）。只剩一种语言时，页面顶部的切换行不再生成。
