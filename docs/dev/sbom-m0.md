<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# M0 第三方依赖 SBOM 与许可证清单

> **本文件由 `bun run sbom` 生成，不要手改。**改判据请改 `scripts/sbom.ts`。
>
> 输入：`bun.lock`（SHA-256 `b71839e708f564ed…`）+ `node_modules` 的 `license` 字段。机器可读版本见同目录 [`sbom-m0.json`](./sbom-m0.json)（CycloneDX 1.5 形状）。

对应 roadmap **P8.4** 交付物①，章程 §5 与风险 L-2 的证据链见 [`license-chain-m0.md`](./license-chain-m0.md)。

## 0. 三条读表须知

**① `dev` 不等于「不分发」。**`vite.config.ts` 设 `ssr.noExternal: true`（仅 `doubaoime-asr` / `opus-encdec` 例外），构建把依赖整体打进 `dist/`；而基座把绝大多数运行时库放在 `devDependencies` 里——根 `package.json` 的 `dependencies` 只有 5 项。**因此本表的 runtime/dev 划分反映的是 package.json 字段归属，不是产物边界。传染性许可的处置不得以「它是 dev 依赖」为由放行。**

**② 本仓库不发 npm 包**（章程 N-14）。分发形态是演示与竞赛材料随附的源码/产物，不是 registry 上的包。许可义务按「分发」评估仍然成立。

**③ 平台受限的 optional 依赖在本机不装**，因而读不到 `license` 字段。它们单列一节，不混进「许可缺失」清单。

## 1. 统计总览

| 项 | 数 |
|---|---|
| 组件总数（lockfile 条目，含重复解析） | 1453 |
| ├ 第三方组件 | 1417 |
| └ workspace 自有包 | 36 |
| 唯一 name@version（第三方） | 1085 |
| runtime 可达 | 197 |
| dev 可达 | 1255 |
| 未被任何根可达（解析遗漏或纯 peer） | 1 |
| 本机未安装（去重，平台受限 optional） | 216 |

## 2. 许可分布

按归一化后的许可表达式统计，范围为**本机已安装的第三方组件**（去重到 name@version，共 862 项）。未安装的 223 项读不到字段，单列在 §5，不计入本表。

「分类」按 §3 的 SPDX 求值口径给出：`(A OR B)` 取较宽松的一支，所以 `(BSD-3-Clause OR GPL-2.0)` 显示为宽松。

| 许可表达式 | 分类 | 组件数 |
|---|---|---|
| `MIT` | 宽松 | 548 |
| `Apache-2.0` | 宽松 | 213 |
| `ISC` | 宽松 | 42 |
| `BSD-3-Clause` | 宽松 | 22 |
| `BSD-2-Clause` | 宽松 | 10 |
| `BlueOak-1.0.0` | 宽松 | 6 |
| `MIT OR Apache-2.0` | 宽松 | 5 |
| `LGPL-3.0-or-later` | 弱传染（文件级） | 3 |
| `MPL-2.0` | 弱传染（文件级） | 3 |
| `0BSD` | 宽松 | 2 |
| `SEE LICENSE IN LICENSE` | 未判定 | 2 |
| `(BSD-2-Clause OR MIT OR Apache-2.0)` | 宽松 | 1 |
| `(BSD-3-Clause OR GPL-2.0)` | 宽松 | 1 |
| `(MIT OR CC0-1.0)` | 宽松 | 1 |
| `CC0-1.0` | 宽松 | 1 |
| `SEE LICENSE IN LICENSE.md` | 未判定 | 1 |
| `SEE LICENSE IN README.md` | 未判定 | 1 |

## 3. 传染性许可扫描（P8.4 DoD 判据）

判定口径：SPDX 表达式按 `OR` 取最宽松分支、`AND` 取最严格分支求值——`(MIT OR GPL-2.0)` **不算命中**，因为可以取 MIT 那一支；`GPL-2.0 WITH Classpath-exception-2.0` 降一档，因为该例外正是为解除链接传染而写的。扫描覆盖 GPL / LGPL / AGPL / SSPL / EUPL / CC-BY-SA / OSL / CDDL / MPL / EPL / CPL / MS-RL / APSL / GFDL / Sleepycat / QPL / CECILL / Artistic 等族。

**结论：强传染 / 网络传染命中 0 项；弱传染（文件级）命中 6 项；受限/非自由 0 项。**

| 包 | 版本 | 许可 | 分类 | 引入路径 | 字段归属 | 处置建议 |
|---|---|---|---|---|---|---|
| `@img/sharp-libvips-darwin-arm64` | 1.0.4 | `LGPL-3.0-or-later` | 弱传染（文件级） | image-processor-napi → image-processor-napi/sharp → image-processor-napi/sharp/@img/sharp-libvips-darwin-arm64 | runtime | 可留用（预编译共享库，非 JS，不进 `dist/` 的 JS bundle，随 `node_modules` 以独立文件形式存在）：未修改其源码即不传染到本仓库代码；分发时须随附其许可与版权声明，并保留使用者替换该库的可能（LGPL §4） |
| `@img/sharp-libvips-darwin-arm64` | 1.2.4 | `LGPL-3.0-or-later` | 弱传染（文件级） | (root) → sharp → @img/sharp-libvips-darwin-arm64 | dev | 可留用（预编译共享库，非 JS，不进 `dist/` 的 JS bundle，随 `node_modules` 以独立文件形式存在）：未修改其源码即不传染到本仓库代码；分发时须随附其许可与版权声明，并保留使用者替换该库的可能（LGPL §4） |
| `@img/sharp-libvips-darwin-arm64` | 1.3.1 | `LGPL-3.0-or-later` | 弱传染（文件级） | cloud-artifacts → wrangler → miniflare → miniflare/sharp → miniflare/sharp/@img/sharp-libvips-darwin-arm64 | dev | 可留用（预编译共享库，非 JS，不进 `dist/` 的 JS bundle，随 `node_modules` 以独立文件形式存在）：未修改其源码即不传染到本仓库代码；分发时须随附其许可与版权声明，并保留使用者替换该库的可能（LGPL §4） |
| `lightningcss` | 1.32.0 | `MPL-2.0` | 弱传染（文件级） | (root) → vite → lightningcss | dev | 可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明 |
| `lightningcss-darwin-arm64` | 1.32.0 | `MPL-2.0` | 弱传染（文件级） | (root) → vite → lightningcss → lightningcss-darwin-arm64 | dev | 可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明 |
| `postcss-values-parser` | 6.0.2 | `MPL-2.0` | 弱传染（文件级） | (root) → … → precinct → detective-postcss → postcss-values-parser | dev | 可留用：未修改其源文件时义务止于该文件；分发时须随附其许可与版权声明 |

## 4. 许可字段缺失 / 非 SPDX / `SEE LICENSE IN`

「包内许可文件」列直接看磁盘：`SEE LICENSE IN <file>` 指向的文件**未必随包发布**，那种情况下授权正文在本机根本不存在，必须回到上游仓库取。

| 包 | 版本 | `license` 字段 | 问题 | 包内许可文件 | 引入路径 |
|---|---|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.2.114 | `SEE LICENSE IN README.md` | see-license-in, non-spdx | `LICENSE.md` | (root) → @anthropic-ai/claude-agent-sdk |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` | 0.2.114 | `SEE LICENSE IN LICENSE.md` | see-license-in, non-spdx | `LICENSE.md` | (root) → @anthropic-ai/claude-agent-sdk → @anthropic-ai/claude-agent-sdk-darwin-arm64 |
| `@modelcontextprotocol/server-filesystem` | 2026.7.10 | `SEE LICENSE IN LICENSE` | see-license-in, non-spdx | **无** | (root) → @modelcontextprotocol/server-filesystem |
| `@modelcontextprotocol/server-memory` | 2026.7.4 | `SEE LICENSE IN LICENSE` | see-license-in, non-spdx | **无** | (root) → @modelcontextprotocol/server-memory |

本脚本只读字段、不读授权正文。**上表每一项的人工核读结论记在 [`license-chain-m0.md`](./license-chain-m0.md) §4**，其中包含本次审计查到的非开源授权项的定性与其影响面判定。

## 5. 本机未安装的组件（许可待补）

本机 `darwin-arm64`。共 223 项在 lockfile 里但本机 `node_modules` 中不存在，因而读不到 `license` 字段；其中 216 项是被 `os`/`cpu` 过滤掉的平台原生包。**结项材料若要覆盖全平台，须在各目标平台分别跑一次本脚本再并表。**

按引入者归组。「同族已安装样本的许可」是同一引入者下已装组件的许可集合——平台变体包通常与同族一致，可据此预判，但**不构成判定**。

| 引入者 | 未安装项数 | 同族已安装样本的许可 |
|---|---|---|
| `sharp` | 62 | `MIT`、`Apache-2.0`、`LGPL-3.0-or-later`、`ISC` |
| `esbuild` | 50 | `MIT` |
| `rollup` | 24 | `MIT` |
| `oxc-parser` | 19 | `MIT` |
| `oxc-resolver` | 19 | `MIT` |
| `rolldown` | 14 | `MIT` |
| `lightningcss` | 10 | `MPL-2.0` |
| `@anthropic-ai/claude-agent-sdk` | 7 | `SEE LICENSE IN LICENSE.md` |
| `@biomejs/biome` | 7 | `MIT OR Apache-2.0` |
| `workerd` | 4 | `Apache-2.0` |

另有 7 项**不受平台限制却仍未安装**（多为未被选中的 optional / peer 分支），逐项列出：

| 包 | 版本 | 引入路径 |
|---|---|---|
| `@emnapi/core` | 1.9.2 | (root) → vite → rolldown → @rolldown/binding-wasm32-wasi → @emnapi/core |
| `@emnapi/runtime` | 1.11.3 | cloud-artifacts → … → @img/sharp-freebsd-wasm32 → @img/sharp-freebsd-wasm32/@img/sharp-wasm32 → @img/sharp-freebsd-wasm32/@img/sharp-wasm32/@emnapi/runtime |
| `@emnapi/runtime` | 1.9.2 | image-processor-napi → image-processor-napi/sharp → image-processor-napi/sharp/@img/sharp-wasm32 → @emnapi/runtime |
| `@emnapi/wasi-threads` | 1.2.1 | (root) → … → @rolldown/binding-wasm32-wasi → @emnapi/core → @emnapi/wasi-threads |
| `@img/sharp-wasm32` | 0.35.2 | cloud-artifacts → … → miniflare/sharp → @img/sharp-freebsd-wasm32 → @img/sharp-freebsd-wasm32/@img/sharp-wasm32 |
| `@napi-rs/wasm-runtime` | 1.1.3 | (root) → knip → oxc-parser → @oxc-parser/binding-wasm32-wasi → @napi-rs/wasm-runtime |
| `@tybys/wasm-util` | 0.10.1 | (root) → … → @oxc-parser/binding-wasm32-wasi → @napi-rs/wasm-runtime → @tybys/wasm-util |

## 6. 预编译原生二进制的许可来源核对

| 位置 | 内容 | 入库状态 | 目录内 LICENSE | 溯源 |
|---|---|---|---|---|
| `vendor/audio-capture/` | 6 个平台三元组的 audio-capture.node 预编译 N-API 插件 | 入库（git 跟踪） | 无 | 源码 packages/audio-capture-napi/native/（Rust crate，Cargo.toml license = AGPL-3.0-or-later）；构建脚本 scripts/build-audio-capture.sh；由 build.ts / post-build.ts 复制进 dist/vendor/ |
| `src/utils/vendor/ripgrep/` | ripgrep 可执行文件（rg） | 不入库（.gitignore 第 12 行），由 postinstall 下载 | 无 | scripts/postinstall.cjs：microsoft/ripgrep-prebuilt v15.0.1，逐档案 SHA-256 硬编码校验 |
| `packages/audio-capture-napi/` | TS 装载层 + 原生 Rust 源码 crate（native/），包内无预编译产物 | 入库 | 无 | package.json 无 license 字段（private:true）；TS 装载层 1 个 .ts，带阡陌版权头 0 个（观察值）；TS 装载层 1/1 见于基座快照 base-snapshot/v2.46.0 = 基座导入层，随 LICENSE.base（MIT）；native/ 为阡陌自研 Rust crate（Cargo.toml license = AGPL-3.0-or-later，源文件带 SPDX 头） |
| `packages/color-diff-napi/` | 纯 TypeScript 装载层，包内无原生产物 | 入库 | 无 | package.json 无 license 字段（private:true）；TS 装载层 4 个 .ts，带阡陌版权头 0 个（观察值）；TS 装载层 4/4 见于基座快照 base-snapshot/v2.46.0 = 基座导入层，随 LICENSE.base（MIT） |
| `packages/image-processor-napi/` | 纯 TypeScript 装载层，包内无原生产物 | 入库 | 无 | package.json 无 license 字段（private:true）；TS 装载层 1 个 .ts，带阡陌版权头 0 个（观察值）；TS 装载层 1/1 见于基座快照 base-snapshot/v2.46.0 = 基座导入层，随 LICENSE.base（MIT） |
| `packages/modifiers-napi/` | 纯 TypeScript 装载层，包内无原生产物 | 入库 | 无 | package.json 无 license 字段（private:true）；TS 装载层 2 个 .ts，带阡陌版权头 0 个（观察值）；TS 装载层 2/2 见于基座快照 base-snapshot/v2.46.0 = 基座导入层，随 LICENSE.base（MIT） |
| `packages/url-handler-napi/` | 纯 TypeScript 装载层，包内无原生产物 | 入库 | 无 | package.json 无 license 字段（private:true）；TS 装载层 2 个 .ts，带阡陌版权头 0 个（观察值）；TS 装载层 2/2 见于基座快照 base-snapshot/v2.46.0 = 基座导入层，随 LICENSE.base（MIT） |

## 7. workspace 自有包

「版权头」列 = 该包 `.ts` 文件中首两行为 `// Copyright 2026 Qianmo AgentNest Team` + `// SPDX-License-Identifier: AGPL-3.0-or-later` 的比例（章程 §5.5 要求 `@qianmo/*` 全覆盖）。

### 7.1 阡陌自有（`@qianmo/*`）

| 包 | 路径 | `license` | private | 版权头 |
|---|---|---|---|---|
| `@qianmo/activator` | `packages/activator` | AGPL-3.0-or-later | 是 | 30/30 |
| `@qianmo/adapter` | `packages/adapter` | AGPL-3.0-or-later | 是 | 15/15 |
| `@qianmo/audit` | `packages/audit` | AGPL-3.0-or-later | 是 | 5/5 |
| `@qianmo/backup` | `packages/backup` | AGPL-3.0-or-later | 是 | 13/13 |
| `@qianmo/capability` | `packages/capability` | AGPL-3.0-or-later | 是 | 13/13 |
| `@qianmo/capacity` | `packages/capacity` | AGPL-3.0-or-later | 是 | 13/13 |
| `@qianmo/console` | `packages/console` | AGPL-3.0-or-later | 是 | 28/28 |
| `@qianmo/diagnosis` | `packages/diagnosis` | AGPL-3.0-or-later | 是 | 6/6 |
| `@qianmo/memory` | `packages/memory` | AGPL-3.0-or-later | 是 | 15/15 |
| `@qianmo/negotiation` | `packages/negotiation` | AGPL-3.0-or-later | 是 | 7/7 |
| `@qianmo/protocol` | `packages/protocol` | AGPL-3.0-or-later | 是 | 17/17 |
| `@qianmo/recall` | `packages/recall` | AGPL-3.0-or-later | 是 | 13/13 |
| `@qianmo/registry` | `packages/registry` | AGPL-3.0-or-later | 是 | 9/9 |
| `@qianmo/resident` | `packages/resident` | AGPL-3.0-or-later | 是 | 48/48 |
| `@qianmo/router` | `packages/router` | AGPL-3.0-or-later | 是 | 10/10 |
| `@qianmo/sandbox` | `packages/sandbox` | AGPL-3.0-or-later | 是 | 7/7 |
| `@qianmo/scheduler` | `packages/scheduler` | AGPL-3.0-or-later | 是 | 11/11 |
| `@qianmo/transport` | `packages/transport` | AGPL-3.0-or-later | 是 | 29/29 |
| `@qianmo/tunnel` | `packages/tunnel` | AGPL-3.0-or-later | 是 | 5/5 |
| `@qianmo/witness` | `packages/witness` | AGPL-3.0-or-later | 是 | 7/7 |

### 7.2 基座既有 workspace 包

基座包普遍不写 `license` 字段。它们 `private: true` 且不单独发布，由 `LICENSE.base`（MIT，基座层）覆盖——见 `NOTICE` 一、许可。**根 `LICENSE` 是阡陌自有层的 AGPL-3.0，不覆盖它们**：两层的权威判据是文件在不在基座快照 `base-snapshot/*` 里，不是文件头——**带头 ⇒ 属于 AGPL 层**成立，反向不成立：无头文件既可能是基座文件，也可能是不在基座快照里的阡陌文件；另有一批带着阡陌改动的基座文件有意不加头，这是独立限制、不是反例。具体个数与拆分现跑现算，命令与口径见 `NOTICE` 一、许可。**不建议在本任务里补字段**：那是基座发布面（CLAUDE.md §0）。

| 包 | 路径 | `license` | private |
|---|---|---|---|
| `@ant/computer-use-input` | `packages/@ant/computer-use-input` | (缺失) | 是 |
| `@ant/computer-use-mcp` | `packages/@ant/computer-use-mcp` | (缺失) | 是 |
| `@ant/computer-use-swift` | `packages/@ant/computer-use-swift` | (缺失) | 是 |
| `@ant/model-provider` | `packages/@ant/model-provider` | (缺失) | 是 |
| `@anthropic/ink` | `packages/@ant/ink` | (缺失) | 是 |
| `@open-claude-code/agent-tools` | `packages/agent-tools` | (缺失) | 是 |
| `@open-claude-code/builtin-tools` | `packages/builtin-tools` | (缺失) | 是 |
| `@open-claude-code/mcp-client` | `packages/mcp-client` | (缺失) | 是 |
| `@open-claude-code/tool-runtime` | `packages/tool-runtime` | (缺失) | 是 |
| `@open-claude-code/workflow-engine` | `packages/workflow-engine` | MIT | 否 |
| `audio-capture-napi` | `packages/audio-capture-napi` | (缺失) | 是 |
| `cloud-artifacts` | `packages/cloud-artifacts` | (缺失) | 是 |
| `color-diff-napi` | `packages/color-diff-napi` | (缺失) | 是 |
| `image-processor-napi` | `packages/image-processor-napi` | (缺失) | 是 |
| `modifiers-napi` | `packages/modifiers-napi` | (缺失) | 是 |
| `url-handler-napi` | `packages/url-handler-napi` | (缺失) | 是 |

