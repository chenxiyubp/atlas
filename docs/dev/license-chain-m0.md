<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# M0 许可链证据包与 `NOTICE` 核对（P8.4）

> **状态：v0.1-draft。**本文是 roadmap **P8.4「软著与开源预检」**交付物 ②③④ 的工程侧部分：
> 许可链证据包核对表、根 `NOTICE` 与实际状态一致性核对、以及学校科技处咨询的议题清单模板。
>
> **本文不构成法律意见。**所有涉及"MIT 能否覆盖上游被还原的表达"一类判断，一律留给
> 学校科技处/知识产权办公室（章程风险 L-2 对策③、`base-adoption.md` §5 Q-1）。
>
> **v0.1-draft 只列建议、不改文件；2026-08-15 起负责人授权处置了其中的事实性勘误。**
> `NOTICE` / `README*` / `LICENSE` / `BASE.md` 属对外表述面与溯源真源，改动须走章程 §5.8 第 4 条
> （负责人 + 安全 owner 双签）与 §2.4（`BASE.md` 由负责人维护）。**已落地的是 D-1（举证命令勘误）、
> D-3、D-4 的 `NOTICE` 侧与 D-2 的 `BASE.md` 侧**——均为把章程 v2.4 已定案的事实落到文本上，
> 不改任何口径实质；`LICENSE`（D-5）与 `package.json`（D-6）**未动**。逐条状态见 §3.2。
>
> **2026-08-29 更新（章程 v2.16 转 AGPL）**：`LICENSE` 已动——但**不是** D-5 建议的那种动法。
> 负责人决议把阡陌自有代码改以 **AGPL-3.0-or-later** 发布，基座 MIT 原文移到 `LICENSE.base`，
> 本仓库自此是**双许可仓库**。D-5 因此**关闭为已处置**（新的 `LICENSE` 是阡陌自己的许可文件，
> 不再是"只有基座版权行"的状态），D-4 的 `vendor/audio-capture/` 许可归属**没有关闭、反而变紧**——
> 逐条见 §3.2。根 `package.json` 的 `license` 字段随之改为 `AGPL-3.0-or-later`（D-6 的其余项仍不改）。
>
> 配套：机器可读依赖清单见 [`sbom-m0.json`](./sbom-m0.json)，人读摘要见 [`sbom-m0.md`](./sbom-m0.md)（`bun run sbom` 生成）。
>
> **2026-08-30 更新（D-9 收口取得进展）**：上一条说"D-4 的 `vendor/audio-capture/` 许可归属没有关闭、
> 反而变紧"仍然成立，但**卡住它的根本原因已经解决**——`packages/audio-capture-napi/native/` 新增了该
> 模块的 Rust 源码并标注 AGPL-3.0-or-later，六个 triple 中 **`arm64-darwin` / `x64-darwin` / `arm64-linux`
> / `x64-linux` 四项已用该源码重建、真加载验证并替换了 `vendor/` 里的产物**，仅 `arm64-win32` /
> `x64-win32` 两个 Windows triple 仍是原厂二进制、许可仍待定。**D-9 由"仍待人"转为"部分处置"**，不是
> "已处置"——六个 triple 还没有全部换完。逐条状态见 D-9；`NOTICE` 一/1 与五/5 同批改写。
>
> **2026-08-30 更新（D-9 已收口）**：上一段是当日较早时点的记录，**保留不改**。同日晚些时候，剩余的
> `x64-win32` / `arm64-win32` 两个 triple 也已用同一份仓库内源码构建并装入 `vendor/`——构建走新增的
> 手动触发工作流 `.github/workflows/build-audio-capture-windows.yml`（仅 `workflow_dispatch`，
> `windows-latest`，两个 job）。**六个 triple 至此全部出自本仓库自有的 AGPL-3.0-or-later 源码，
> `vendor/` 里不再有来源不明、许可未定的二进制，D-9 由"部分处置"转为 ✅ 已处置。**
> **但有一处验证缺口必须记明**：`arm64-win32` 从未在任何机器上被加载或执行过（`windows-latest` runner
> 是 x86_64，结构上加载不了 aarch64 的 DLL，工作流对此打印显式跳过理由而非假装通过），它的证据只有
> 构建成功、`clippy -- -D warnings` 干净与结构性核对，**待在真实 Windows on ARM 机器上补一次加载验证**。
> **那是验证缺口，不是许可缺口**——该产物与其余五个同出一份源码。逐条见 D-9；`NOTICE` 一/1 与五/5、
> D-4 升级注、T-5.4（**原编号 T-5.3，2026-08-30 因与弱传染许可那条 T-5.3 重号而重编**，见该条内说明）、U-4 同批改写。

---

## 1. 本文覆盖什么、不覆盖什么

| P8.4 交付物 | 本文 | 说明 |
|---|---|---|
| ① 第三方依赖 SBOM 与许可证清单 | 指针 | 见 [`sbom-m0.md`](./sbom-m0.md) / [`sbom-m0.json`](./sbom-m0.json) |
| ② 许可链证据包 | **§2** | 列"应有哪些件、每件当前在哪、缺什么"，**不代取需要人去取的材料** |
| ③ 根 `NOTICE` 与实际状态一致性核对 | **§3** | 逐条核对 + 建议改动（待双签） |
| ④ 学校科技处咨询记录 | **§5 模板** | 咨询本身是人做的；本文给议题清单，至少含 L-2 与 L-5 |
| 依赖树里的授权疑点人工核读 | **§4** | SBOM 只读字段、不读授权正文，语义结论记在这里 |

**DoD 中机器可判的两条**：

- **无 GPL 类传染性许可项** —— `bun run sbom --check` 判定。当前结果：**强传染 / 网络传染 0 项，受限/非自由 0 项**；弱传染（文件级）5 项，逐项处置见 [`sbom-m0.md`](./sbom-m0.md) §3。
- **`NOTICE` 与实际状态一致** —— 见 §3。两条硬差异（D-1、D-2）**已于 2026-08-15 处置**（负责人授权），
  另处置 D-3、D-4 的 `NOTICE` 侧。**工程侧一致性已达成**；本条最终判 PASS 仍需负责人 + 安全 owner
  对改后文本双签（章程 §5.8 第 4 条）。**2026-08-30 更新**：此处原写「且 D-4 的 `vendor/audio-capture/`
  许可归属仍是待人项（见 U-4）」——该待人项已随 D-9 收口，六个 triple 全部出自本仓库自有的
  AGPL-3.0-or-later 源码，**许可面没有待办**；U-4 现在挂的是一项工程验证待办（`arm64-win32` 的运行时
  加载验证），它不影响本条的 PASS 判定。

---

## 2. 许可链证据包核对表

章程 L-2 对策② 列了四件：基座 `LICENSE`（MIT）、npm 公开发布记录、负责人对基座的归属关系、pin 提交与 tag。
下表按"一件证据 = 一行"展开，并补上本次审计发现的两件（E-6、E-7）。

**状态图例**：✅ 齐备且在仓库内可查 · 🟡 齐备但在仓库外（需保存快照入证据包） · ❌ 缺口（需人去取或需负责人补记）

| # | 证据件 | 应证明什么 | 当前位置 | 状态 |
|---|---|---|---|---|
| **E-1** | 基座 `LICENSE`（MIT 正文 + `Copyright (c) 2026 open-claude-code contributors`） | 基座以 MIT 授权，允许使用/修改/再分发，条件是保留声明 | 本仓库根 [`LICENSE.base`](../../LICENSE.base)（随基座快照导入，内容未改动；**2026-08-29 起由 `LICENSE` 改名到此**，根 `LICENSE` 现为阡陌自有层的 AGPL-3.0 正文） | ✅ |
| **E-2** | 上游仓库同一 tag 的 `LICENSE` | 仓库内那份就是上游那份 | 上游 GitHub `https://github.com/sweetcornna/open-claude-code`（URL 出处见 E-5 说明） | 🟡 需存网页/tarball 快照 |
| **E-3** | npm 公开发布记录 | 基座是**公开发布**的开源包，不是私下产物 | npm registry。已实查（2026-08-15）：包名 `@sweetcornna/open-claude-code`，`license: "MIT"`，**v2.38.3 发布时间 `2026-08-11T14:06:24.040Z`**，包首次发布 `2026-08-03T06:27:30Z` | 🟡 需存 `npm view` 输出与包页面快照 |
| **E-4** | **npm tarball 的 `gitHead` 字段** | **把 npm 上的 v2.38.3 与 pin 提交直接绑死** | 实查结果：`gitHead = 848ad8c2c8daca9f5aa2410da555553e07700f5d`，与本仓库 `BASE.md` 记录的 pin **逐字一致**；同版本 `dist.shasum = 41a7d8a71c3ec5454beb0c0196d8165752724e14` | 🟡 需存快照 |
| **E-5** | pin 提交与 tag | 锁定的是哪一版基座 | `BASE.md`（pin 全 SHA + tag v2.38.3）。**本仓库 `git tag` 为空（实测 0 个 tag）**——本仓库经快照导入、不含上游历史，tag 只存在于上游仓库。pin 的可核性靠三条互相独立的链路：① `BASE.md` 记录；② E-4 的 npm `gitHead`；③ P7.4 演练在一次性 clone 中比对上游 tag 的结果（见 [`upstream-sync-drill.md`](./upstream-sync-drill.md) §2：`git diff 3380c88 v2.38.3` 的基座文件修改数为 **0**，零改动快照声明成立） | ✅（本仓库侧）/ 🟡（上游侧需快照） |
| **E-6** | 第三方依赖 SBOM 与许可清单 | 依赖树里没有会污染成果的许可 | [`sbom-m0.json`](./sbom-m0.json) / [`sbom-m0.md`](./sbom-m0.md)，`bun run sbom` 可复现 | ✅ |
| **E-7** | 依赖树中唯一一项非开源授权的定性与影响面 | 主动披露而不是被问出来 | 见 §4（`@anthropic-ai/claude-agent-sdk`） | ✅ |
| **E-8** | **负责人对基座的归属关系** | 「基座是项目负责人自有的开源项目」这句话本身 | **仓库内无任何证据。**仓库里能查到的只有账号标识：npm maintainer `sweetcornna`（登记的邮箱是负责人的个人邮箱，本文不内联；`npm view @sweetcornna/open-claude-code maintainers` 可查）、GitHub 组织/用户 `sweetcornna`、`package.json` 的 `author: "open-claude-code"` | ❌ **最大缺口，见下** |
| **E-9** | 上游仓库 URL 写进溯源真源 | 溯源可追 | **已补记（2026-08-15，负责人授权，单独提交）**：`BASE.md` 现记「上游仓库 `https://github.com/sweetcornna/open-claude-code`」，原本地路径 `/Users/cornna/project/open-claude-code` 保留但标注为导入当时的本地副本、非权威地址；另补 npm 侧佐证一行（`repository.url` + v2.38.3 `gitHead`，即 E-3/E-4） | ✅ |

### E-8 说明：这件必须由人去取，工程侧取不到

"负责人自有"目前在文档里是**立项决议的断言**（章程 §5.1 归属行的核实出处就写着"立项决议"），仓库里没有任何可独立验证的对应关系。要闭合它，需要下列材料**至少三选二**，且都只能由负责人本人提供：

1. **npm 账号所有权**：以 `sweetcornna` 账号登录 npmjs.com 的账号设置页截图（含绑定邮箱），或 `npm whoami` 在负责人机器上的输出录屏；
2. **GitHub 账号所有权**：`github.com/sweetcornna` 账号设置页 / 仓库 Settings 页截图，证明对 `sweetcornna/open-claude-code` 有 owner 权限；
3. **实名对应**：上述账号邮箱与负责人本人身份的对应（学校邮箱绑定、或账号页公开的实名信息）。

**不要用"我们能推到那个仓库"来代替**——推送权限不等于著作权归属。这三件是科技处咨询时最可能被追问的一组，建议在咨询前先备齐（见 §5 议题 T-2）。

---

## 3. 根 `NOTICE` 与实际状态一致性核对

核对对象：根 [`NOTICE`](../../NOTICE)、[`LICENSE`](../../LICENSE)、[`README.md`](../../README.md)（含基座 `README.zh.md` / `README.ja.md`）、[`BASE.md`](../../BASE.md)、`src/constants/brand.ts` 顶部注释、根 `package.json` 的 `name` / `license` / `author`。

### 3.1 一致的部分（无需改动）

| 核对项 | 结论 |
|---|---|
| 许可声明为 MIT | ⚠️ **2026-08-29 起该行作废**（章程 v2.16 转 AGPL）。原结论：✅ 一致，`NOTICE` 一/1 = MIT；`LICENSE` = MIT 正文；`package.json` `"license": "MIT"`；`README.md` §许可 = MIT。**新口径见下一行** |
| 许可声明为**双许可**（2026-08-29 起） | ✅ 一致（实读核对 2026-08-29）。`NOTICE` 一/1 = 双许可说明；`LICENSE` = AGPL-3.0 正文（34,523 B，与 gnu.org 原文逐字节相同）；`LICENSE.base` = MIT 正文（与 `base-snapshot/v2.46.0:LICENSE` 逐字节相同）；根 `package.json` `"license": "AGPL-3.0-or-later"`；`README.md` §许可 = 双许可表 |
| `@qianmo/*` 随仓库以 MIT 发布（章程 §5.5） | ⚠️ **2026-08-29 起改为 AGPL-3.0-or-later**。原结论：✅ 一致，17 个包 `license` 字段全部为 `MIT`。现状：**19 个 `@qianmo/*` 包的 `license` 字段全部为 `AGPL-3.0-or-later`**（包数由 17 增至 19 是期间新增包，不是本次变更），逐包核对见 [`sbom-m0.md`](./sbom-m0.md) §7.1 |
| `@qianmo/*` 版权头两行（章程 §5.5 v2.5，v2.16 改值） | ✅ 全覆盖。原核对（2026-08-15）：17 个包 217 个 `.ts` 全部为 `// Copyright 2026 Qianmo AgentNest Team` + `// SPDX-License-Identifier: MIT`，比例 **217/217**。**2026-08-29 的处置记录**：全仓 **564 个**阡陌文件已改写、`MIT` 头剩 **0** 个；**这不是今天的判据值**。今天的判据值现跑现算，命令与口径见根 [`NOTICE`](../../NOTICE) 一、许可；逐包比例见 [`sbom-m0.md`](./sbom-m0.md) §7.1 |
| 商标声明与章程 §5.8 第 2 条 | ✅ 一致。`NOTICE` 四/4 声明"无关联、未获背书、未获赞助"，与章程 §5.2② 第 2 条、README.md 末段逐条对应 |
| "明确不改"标识清单 | ✅ 一致。`NOTICE` 四列出的 5 条（系统提示词前缀 / `claude-code/<version>` UA / OTel `service.name` / `CLAUDE.md`·`CLAUDE.local.md`·`AGENTS.md` / `CLAUDECODE=1`）与 `src/constants/brand.ts` 顶部注释、章程 §5.2③ **逐条一致，无增无漏** |
| 基座性质如实声明（逆向复原） | ✅ 一致。`NOTICE` 三 与章程 §5.2②、`base-adoption.md` §5 R-1 一致；且**不作法律判断**的措辞与章程口径吻合 |
| 提到 npm 包名 `@sweetcornna/open-claude-code` | ✅ 提到了。`NOTICE` 二（中）与 2（英）均列出 |
| 基座 README 的"仅供学习研究用途"（L-5） | ✅ 已解除。仓库内 `README.zh.md`（第 190 行）与 `README.ja.md`（第 168 行）的许可段已无用途限定，与章程 L-5「已解决」一致（实读核对） |

### 3.2 差异清单（每条前缀即当前状态：✅ 已处置 / 决定保留 · 🟡 部分处置 · ⏸ 仍待人）

> 本节 v0.1-draft 时是"只列建议、不要直接改"。**2026-08-15 起，D-1 / D-2 / D-3 与 D-4 的 `NOTICE` 侧
> 已由负责人授权处置**；每条开头的引用块是处置记录，其下的"原现状/实际/实测"保留为处置依据，
> **不再是现状描述**。
>
> **2026-08-30 更新（末句三处均已过期，原文照录如下并就地改写）**：原写「未标"已处置"的条目
> （D-4 的许可归属、D-5）仍是待人项，`LICENSE` 与根 `package.json` 未动」。现状是——**D-5** 已于
> 2026-08-29 随章程 v2.16 转 AGPL 关闭为 ✅ 已处置；**D-4 的许可归属**已随 **D-9** 于 2026-08-30 收口，
> D-4 本条同日转 ✅；**`LICENSE` 与根 `package.json` 都已在 2026-08-29 改动**（前者换成 AGPL-3.0 正文、
> 基座 MIT 原文移到 `LICENSE.base`，后者 `license` 字段改为 `AGPL-3.0-or-later`）。**本节现已无未处置
> 的差异条目。**
>
> **2026-08-30 再更新（新增 D-10 后，末句已被新条目推翻，原文照录如下并就地改写）**：原写「本节现已无未处置的差异条目。」现改为——**本节列出的差异条目（含新增 D-10）均已处置**；D-10 所涉 C 类文书的个人信息公开风险属于转公开前另议事项，不是本节的许可口径待决项。

#### D-1 ✅ 已处置 —— `NOTICE` 的成果边界举证命令是失效的（原**硬差异，DoD 阻断项**）

> **处置（2026-08-15，负责人授权，与本次修订同一提交）**：`NOTICE` 中文「二、基座溯源」节末与英文
> section 2 节末的举证命令已改为以本仓库导入提交 `3380c88` 为基线（工作面 `git diff 3380c88..HEAD`、
> 工作记录 `git log 3380c88..HEAD`、基座贡献边界 `git show --stat 3380c88`，另加 `67f6081` / `74f7a22`），
> 并各补一句「本仓库经零改动快照导入、不含上游 git 历史，故以导入提交为基线」；**`848ad8c2` 作为上游
> pin 的 SHA 陈述保留**（那是事实，只是不能当本仓库的 diff 基线）。`README.md` 基座说明段同批修正。
> 中英两部分内容等同。**下方原文保留为处置依据，不再是现状描述。**

- **原现状**：`NOTICE` 中文版第 45–46 行、英文版第 133–134 行写着
  「pin 提交 848ad8c2 之后的全部提交为阡陌团队的工作。`git diff 848ad8c2..HEAD` 即为本项目的工作面。」
- **实际**：章程 **v2.4 §5.5「举证命令勘误」**已判定该命令在本仓库不可执行——本仓库经快照导入、不含上游 git 历史，`848ad8c2` 是**上游仓库**的 SHA。正确基线是**本仓库的基座导入提交 `3380c88`**。
- **实测（2026-08-15，两组对照）**：

  | 环境 | `git rev-parse 848ad8c2` | `git diff --shortstat 848ad8c2..HEAD` |
  |---|---|---|
  | 从本仓库做的**干净 clone** | `fatal: unknown revision` | 无法执行 |
  | 当前开发机主检出 | 意外解析成功 | 466 files / +72,275 / −555 |
  | 当前开发机主检出（正确命令 `3380c88..HEAD`） | — | 431 files / +71,710 / −1,362 |

  主检出里 `848ad8c2` 之所以解析得出，是因为本地存在一个**游离对象**——它不被任何 ref 可达（`git for-each-ref --contains` 为空、`git merge-base --is-ancestor` 为否），因此**不随 clone/fetch 传播**，也会被 `git gc --prune` 回收。
- **为什么这条必须改**：这是**答辩现场最危险的一种不一致**——在负责人自己机器上跑得出结果（且是**另一个**结果：多出 36 个文件，那是导入前立项提交 `67f6081`/`74f7a22` 的申报材料），到评审方的 clone 上直接 `unknown revision`。风险 L-1 的举证一旦当场跑失败，伤害远大于命令本身。
- **原建议改动（已执行）**：`NOTICE` 中英两处的举证命令改为 `git diff 3380c88..HEAD`，并按章程 §5.5 补一句"另加导入前的立项提交 `67f6081`、`74f7a22`"。**README.md 第 20 行有同一处错误，已同批修正。**

#### D-2 ✅ 已处置 —— `BASE.md` 的上游记录不含公开仓库 URL（原**硬差异**）

> **处置（2026-08-15，负责人授权，单独提交 `0c2f3b17`）**：`BASE.md` 已补上游公开仓库 URL
> （原本地路径保留并标注为导入当时的本地副本）、npm 侧佐证一行，并新增「上游同步演练记录」一节
> 记入 P7.4 对 v2.46.0 的演练（0.39% 冲突率 / typecheck 零错 / 11311 测试全绿 / 工时 10–20 h，
> 详见 [`upstream-sync-drill.md`](./upstream-sync-drill.md)）。**pin 不变、零改动声明不变。**
> 第 7 行已过期的括注「（立项文档提交后生效）」同批删去。**下方原文保留为处置依据。**

- **原现状**：`BASE.md` 第 3 行记「导入自本地仓库 `/Users/cornna/project/open-claude-code` 的已提交快照」。
- **章程要求**：§5.6① 规定 `BASE.md` 内容"至少包括：**上游仓库**、pin 提交全 SHA 与对应 tag、导入日期、零改动声明、同步记录"。**上游仓库这一项当前是一条本地路径**，对仓库之外的任何人都不可验证。
- **公开 URL 有据可查**：`https://github.com/sweetcornna/open-claude-code`（根 `README.md` 第 20 行；npm 元数据 `repository.url` = `git+https://github.com/sweetcornna/open-claude-code.git`）。
- **建议改动**：由负责人在 `BASE.md` 补记公开仓库 URL。这属于"导入/同步记录"事件，是 §2.4 允许改 `BASE.md` 的两类之一，**不得在功能 PR 里顺手改**。
- **顺带**：`BASE.md` 第 7 行"上游同步：暂定人工比对……（立项文档提交后生效）"的括号已过期（立项文档早已入库）；且 **P7.4 演练已执行**（记录见 [`upstream-sync-drill.md`](./upstream-sync-drill.md)，该文自述"评审与章程 §5.7 回写待做，DoD 未闭环"）**但未记入 `BASE.md`**——roadmap P7.4 交付物一栏写明"`BASE.md` 记录本次演练"。同属负责人维护范围。

#### D-3 ✅ 已处置 —— `NOTICE` 五「第三方组件」的表述已落后于实际

- **原现状**：「完整的依赖与许可清单（SBOM）**随项目发布材料提供**。」
- **实际**：SBOM 现已入库，`bun run sbom` 可复现。
- **处置（2026-08-15）**：`NOTICE` 五（中）/ 5（英）改为指向仓库内路径 `docs/dev/sbom-m0.json` 与 `docs/dev/sbom-m0.md`，并注明由 `bun run sbom` 生成、可复现。遵守"指针不复制"，清单内容未抄进 `NOTICE`。

#### D-4 ✅ 已处置（**原 🟡 部分处置，2026-08-30 转 ✅**）—— `NOTICE` 五未覆盖仓库内的预编译二进制

- **现状**：`NOTICE` 五只说"基座及其依赖树引入的第三方组件"。
- **实际**：仓库里还有**不来自 npm 依赖树**的第三方二进制（详见 [`sbom-m0.md`](./sbom-m0.md) §6）：
  - `vendor/audio-capture/`：**6 个平台的 `audio-capture.node`（已入库）**，仓库内**无源码、无构建脚本、无 LICENSE、无溯源记录**，且由 `build.ts` / `scripts/post-build.ts` 复制进 `dist/vendor/` 随产物分发；
  - `src/utils/vendor/ripgrep/`：ripgrep 可执行文件，**不入库**（`.gitignore` 第 12 行），由 `scripts/postinstall.cjs` 从 `microsoft/ripgrep-prebuilt` v15.0.1 下载并逐档案校验 SHA-256——**这一项溯源是清楚的**。
- **处置（2026-08-15）**：`NOTICE` 五（中）/ 5（英）已补「随仓库分发的预编译原生二进制」两条，逐条写明位置、入库状态、是否随 `dist/` 分发、以及许可溯源状态。ripgrep 一条溯源清楚（构建工程 microsoft/ripgrep-prebuilt 以 MIT 发布，ripgrep 本体许可以上游 BurntSushi/ripgrep 的许可文件为准）；`vendor/audio-capture/` 一条如实写「源码与许可待上游确认」，**未推定任何许可**。
- **`vendor/audio-capture/` 上游溯源核查结果（2026-08-15 实查，结论：上游同样没有）**：

  | 查了什么 | 结果 |
  |---|---|
  | 上游仓库树 `https://github.com/sweetcornna/open-claude-code/tree/main/vendor/audio-capture` | **只有六个平台三元组目录**（`arm64|x64-darwin|linux|win32`），无源码、无 `Cargo.toml` / `build.rs` / `binding.gyp`、无 `LICENSE`、无 `README` |
  | 上游 `packages/audio-capture-napi/` | 与本仓库一致，**纯 TypeScript**（`package.json` / `tsconfig.json` / `src/`），无原生源码 |
  | 上游仓库根与 README | 未提及 `vendor/`、预编译二进制或音频采集的构建方式 |
  | 本仓库全树 `Cargo.toml` / `*.rs` | **0 命中** |
  | 二进制符号（`strings` 读 `.node`） | Rust + napi-rs 构建：静态链接 `napi 2.16.17`、`cpal 0.15.3`；平台相关 `coreaudio-rs 0.11.3`（darwin）、`alsa 0.9.1`（linux）、`windows 0.54.0`（win32）；导出 `start_recording` / `stop_recording` / `start_playback` / `microphone_authorization_status` 等 |

  **能确定的**：这是一个用 Rust + napi-rs 写的音频采集/播放插件，静态链接了上述几个公开 crate。
  **不能确定的**：**模块自身**的源码在哪、以什么许可发布。静态链接的 crate 各有其自身许可（以各自 crates.io / 仓库的许可文件为准，本文不代为判定），但它们的许可**不能**替代模块自身的许可声明。
- **原"仍待人（U-4，范围已收窄）"，保留为处置历程、不再是现状描述**（下方 2026-08-30 更新已收口）：既然上游仓库里也没有源码与 LICENSE，这一条只能由**负责人以基座作者身份**给出：该原生模块的源码在哪个仓库/分支、以什么许可发布，以及是否愿意把源码或 LICENSE 补进上游 `vendor/audio-capture/`。M0 演示不使用音频能力（章程 N-9 口径），但"不使用"不等于"不分发"——它随 `dist/vendor/` 出货。咨询议题 T-5.2 **当时**保持不变——**2026-08-30 更新**：该议题问的「需不需要在申报前移除、或由基座作者补齐源码与许可」已经有答（补齐了），更新注见 §5.5 T-5.2。

> **2026-08-29 升级（转 AGPL 之后）**：本条从"待人项"升级为**必须收口项**，理由与两条收口路径见新增的
> **D-9**。一句话：MIT 下"许可待确认"可以挂着，AGPL 下挂不住——copyleft 要求随分发提供 Corresponding Source。
>
> **2026-08-30 更新（分两步，当日完成）**：先是源码入库并标注 AGPL，六个 triple 中 `arm64-darwin` /
> `x64-darwin` / `arm64-linux` / `x64-linux` 四项完成替换并真加载验证（D-9 一度判为"部分处置"）；
> 同日 `x64-win32` / `arm64-win32` 也由手动触发的 GitHub Actions 工作流用同一份源码构建并装入，
> **六个 triple 全部出自本仓库自有源码，本条描述的"原厂二进制、许可待定"已不复存在**，D-9 转
> ✅ 已处置。**唯一尚存的是一项验证待办而非许可待办**：`arm64-win32` 没有运行时证据（构建它的 runner
> 是 x86_64），欠一次真实 Windows on ARM 机器上的加载验证。现状与逐 triple 证据等级见 D-9，本条不再重复。

#### D-5 ✅ 已处置 —— `LICENSE` 只有基座的版权行，没有阡陌的（原观察项）

> **处置（2026-08-29，负责人决议，章程 v2.16）**：**没有按本条原来的建议做**（"在 MIT 正文里增列阡陌版权行"），
> 而是换了一条更彻底的路——`git mv LICENSE LICENSE.base` 保留基座 MIT 原文，`LICENSE` 换成 **AGPL-3.0 正文**，
> 本仓库自此是双许可仓库。原建议里"不要凭工程判断改 `LICENSE`"这一条**仍然成立且被遵守**：本次动 `LICENSE`
> 是负责人的许可决议，不是工程判断。

- **原现状**：`LICENSE` 仅 `Copyright (c) 2026 open-claude-code contributors`；`NOTICE` 第 2 行另有 `Copyright 2026 Qianmo AgentNest Team`。
- **原说明**：MIT 只要求**保留**上游声明，因此原状不违规；但软著材料通常希望在许可文件里也体现本团队的版权主体。
- **为什么这个处置更好**：原建议解决的是"许可文件里看不到阡陌"，但**没有解决归属本身** ——
  一份 MIT 正文加两行版权，读者仍然读不出哪些文件是谁的。双许可 + SPDX 文件头把这件事变成**机器可判**的：
  `git grep -n "SPDX-License-Identifier: AGPL-3.0-or-later" | awk -F: '$2<=5' | cut -d: -f1 | sort -u`
  出来的 564 个文件就是阡陌那一层（**限定在文件头**必不可少——不加 `awk -F: '$2<=5'` 会把「正文里引用了
  这行字」的文档也算进来，数目对不上会让这条判据看起来是错的），其余不带 SPDX 头的就是基座那一层。
  **这同时也是软著材料要的那条边界**（章程 §5.5 的成果边界，与 `base-snapshot/v2.46.0` 的 git 举证互为印证）。
  **其中 564 是 2026-08-29 当天的实测值，属本条处置的记录、不是"现在是多少"**——每新增一个带该文件头的
  文件它就会变，2026-08-30 补头提交 `c9c74627` 之后实测是 **646**（该提交之前为 580）；判据本身不变，
  数要现跑现算，对外陈述以根 `NOTICE` 一/1 为准。
  **加不加前 5 行限定的差值同样要现跑，不要照抄**：截至 2026-08-30 是 **4**（`CLAUDE.md`、`CONTRIBUTING.md`、
  `NOTICE`、`README.md` —— 都是正文里引用了这行字、却不在前 5 行内的文档）。它在 `c9c74627` 之前是 8，
  变小不是因为哪份文档删了引用，而是因为 `charter.md` / `license-chain-m0.md` / `roadmap.md` / `sbom-m0.md`
  这四份自己也补上了文件头，于是两种算法都数得到它们。**这个差值两头都会动**（新文档引用这行字会让它变大、
  被引用的文档补头会让它变小），现跑现算：
  `comm -13 <(git grep -n "SPDX-License-Identifier: AGPL-3.0-or-later" | awk -F: '$2<=5' | cut -d: -f1 | sort -u) <(git grep -l "SPDX-License-Identifier: AGPL-3.0-or-later" | sort -u)`
  **另一条勘误（2026-08-30 追记）**：上面那句「**其余不带 SPDX 头的就是基座那一层**」是**已被证伪的反向推断**，
  照本文体例作签署当日的理由记述原样保留，**但它不是现行口径**——现行口径见根 `NOTICE` 一、许可「文件头只在一个方向上
  作数」一段。具体个数与拆分、以及带着阡陌改动而有意不加头的基座文件数量，均应按该处命令现跑现算，本文不重复。
- **落地核对（2026-08-29 实读）**：
  - `LICENSE` = 34,523 B / 661 行，sha256 `0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0`，
    与 `https://www.gnu.org/licenses/agpl-3.0.txt` 逐字节相同；**正文之前不加任何前言**——
    GitHub 的许可识别按全文比对，加一行说明就会被识别成 "Other"。说明文字一律放 `NOTICE`。
  - `LICENSE.base` 与 `git show base-snapshot/v2.46.0:LICENSE` 逐字节相同（1,450 B）。
- **仍开放的一条**：AGPL §13 只在"用户通过网络与本程序交互"时触发。阡陌的**控制台**与**节点**都落在这一格，
  因此运营方（包括我们自己在 p11 上的部署）负有向使用者提供 Corresponding Source 的义务。
  **这不是本文能收口的事**——它属于运营纪律，写进 §5 咨询议题 T-4 的新增子项 T-4.1。

#### D-6 ✅ 决定保留 —— 根 `package.json` 仍带基座的发布元数据（观察项，**不改**）

- **现状**：`name` = `@sweetcornna/open-claude-code`、`version` = `2.38.3`、`author` = `open-claude-code`、`repository`/`homepage`/`bugs` 均指向基座仓库。
  **2026-08-29 更新**：`license` 字段已随章程 v2.16 改为 `AGPL-3.0-or-later`（**只改这一个字段**）。
  `name` / `version` / `author` / `repository` 等**仍按本条结论不改**——那是基座发布面，本仓库不 publish。
- **张力**：README 与章程 N-14 都写明"本仓库不发 npm 包"，而 `package.json` 看起来就是基座那个 npm 包。审查者可能据此提问。
- **建议**：**不改**（这是基座发布面，`CLAUDE.md` §0 明确不维护），但**在答辩 Q&A 预案（P8.3）里备一句解释**："这是 fork 布局的自然结果，本仓库不执行 `publish`，`publish-npm.yml` 与 release 流程按 roadmap P0.4 处置。"

#### D-7 ✅ 已处置 —— 首次上游同步后 `NOTICE` / `README.md` 的 pin 陈述过期（**新差异，本节 v0.1 起草时尚不存在**）

> **处置（2026-08-28，开源就绪批次）**：`NOTICE` 中文「二、基座溯源」与英文 section 2 的溯源块、
> 以及 `README.md` 第 20 行，均改为**区分两个 pin**：导入提交 `848ad8c2`（v2.38.3，历史锚点，
> 不随同步变化）与当前锁定 `1128a391`（v2.46.0，2026-08-17 首次同步后）。用词与 `BASE.md`
> 第 6 / 8 行一致。中英两部分内容等同。**属事实性勘误**，未改变任何口径或范围。

- **怎么来的**：D-1 那批（2026-08-15）修的是**举证基线**（`848ad8c2..HEAD` → `3380c88..HEAD`），
  当时 pin 陈述本身是对的。两天后 P10.2 把基座同步到 v2.46.0、pin 迁至 `1128a391`
  （章程 v2.13、`BASE.md`「上游同步记录」），**同一处文本因此第二次失准**——这次错的不是命令而是事实。
- **为什么必须改**：`NOTICE` 是溯源声明，是评审方读「基座是什么版本」的地方。它与 `BASE.md` 各说一个 pin，
  等于对外声明与溯源真源自相矛盾；`README.md` 更是自相矛盾——第 20 行说锁定在 v2.38.3，
  第 22 行同时描述「v2.38.3 → v2.46.0 的首次同步」。
- **给下次同步的提示**：pin 出现在 `BASE.md`（2 处）、`NOTICE`（中英各 1 处）、`README.md`（1 处）。
  **`BASE.md` 之外那三处不在同步流程的 checklist 里**，v2.13 回写就是这么漏掉的。
  建议把它们并入 `upstream-sync-drill.md` 的同步后回写清单。

#### D-8 ✅ 已处置 —— `SECURITY.md` 与 issue 模板仍是基座的对外面（原**硬差异，转公开阻断项**）

> **处置（2026-08-28，开源就绪批次）**：`SECURITY.md` 按本仓库重写；
> `.github/ISSUE_TEMPLATE/` 的 `bug_report.md` / `feature_request.md` / `config.yml` 改指本仓库。

- **原现状**：三份文件自 v2.46.0 同步以来**与基座逐字相同**（`git diff base-snapshot/v2.46.0..HEAD` 无差异）。
  于是本仓库的漏洞报告入口指向 `sweetcornna/open-claude-code/security/advisories/new`、
  issue 前必读指向基座的 issue 列表与 README、`config.yml` 指向基座 Discussions
  （**本仓库 Discussions 未启用**，那是一条死链）。
- **为什么这条比看起来严重**：仓库转公开后，第一份安全报告会**私密地进到另一个仓库**。
  报告者以为已经报了，本仓库却收不到，且因为 advisory 私密，双方都不会发现投递错了地方。
- **改了什么**：`SECURITY.md` 去掉基座的「受支持版本」表（本仓库不发版本，判据是 commit）、
  补 M0 阶段与未经审计的如实声明、新增「问题出在哪一侧」归属表（阡陌 / 基座 / 上游三分），
  并把安全边界从基座那五条换成阡陌的威胁模型（签名分档与能力令牌、`LIMITS` 防放大、
  每节点 PSK 与身份私钥、控制台的转义顺序即 XSS 边界），基座继承的隔离与凭据两条保留。
- **同批**：`CONTRIBUTING.md` 开篇仍写「欢迎参与 open-claude-code」并把本项目自述为「逆向/反编译社区版」
  ——那是**基座**的定位。按章程 §5.8 标准表述改成「两层」结构；基座那层的逆向溯源**如实保留**（§5.8 第 3 条
  要求被问及时不回避，删掉反而违规）。另补 §10.1「仓库外的贡献者」（fork 流程、不需要 CLA、范围以章程为准、
  基座改动优先发上游、安全问题不走 PR/issue）。
- **未动**：`.github/pull_request_template.md`（已是阡陌版）、`.github/workflows/ci.yml`。

#### D-9 ✅ 已处置（**新增于 2026-08-29 → 2026-08-30 部分处置 → 2026-08-30 已处置**）—— `vendor/audio-capture/` 在 copyleft 下不能再"待确认"

> **处置②（2026-08-30 同日，工程交付，Windows 两个 triple 收口，本条关闭）**：剩余的
> `x64-win32` / `arm64-win32` 已用同一份仓库内源码构建并装入 `vendor/`。**六个 triple 至此全部出自本仓库
> 自有的 AGPL-3.0-or-later 源码，`vendor/` 里不再有来源不明、许可未定的二进制。**
>
> - **构建路径**：新增 `.github/workflows/build-audio-capture-windows.yml`，**仅 `workflow_dispatch`
>   手动触发**（不进 push / pull_request 阻塞门禁——那些 runner 不带 Rust，原生模块缺失时应用本就优雅
>   降级），`windows-latest` runner，矩阵两个 job 对应 `x86_64-pc-windows-msvc` 与
>   `aarch64-pc-windows-msvc`。跑了两次：`33291590858`（main 上，两 job 均成功，但产物有依赖面退化，
>   **未装进仓库**）与 `33292271322`（本分支上，带静态 CRT 修复，**这批才是装进 `vendor/` 的产物**）。
> - **第一次构建暴露的退化与修法**：第一版自建产物比原厂多出四项依赖——三个 `api-ms-win-crt-*` 转发器
>   （UCRT，Windows 10+ 自带，无所谓）与 **`vcruntime140.dll`**（有所谓：来自 Visual C++ 可再发行组件包，
>   既不随 Windows 出厂、也不随 Node.js 安装程序分发）。目标机缺它时 `require()` 抛错，而
>   `packages/audio-capture-napi/src/index.ts` 的 `loadModule()` 会吞掉 `require` 错误静默降级——**故障
>   表现是语音模式无声消失、不留任何报错线索**。原厂产物本就是静态链接 CRT 构建的
>   （`bcryptprimitives` + `ntdll` + `dbghelp` 正是 Rust 静态 CRT 二进制的典型形态），所以这是本次重写
>   引入的退化。修法是新增 `packages/audio-capture-napi/native/.cargo/config.toml`，**按 target** 分别打开
>   `-C target-feature=+crt-static`，只作用于两个 `windows-msvc` triple；**不能写成 `[build] rustflags`**
>   ——那会波及已经在目标架构上真加载验证过的 macOS / Linux 产物。工作流无需改动（无 `env:` 块、无
>   `RUSTFLAGS` / `CARGO_HOME` / `--config`，`working-directory` 就是 crate 目录，cargo 自会向上找到这份
>   配置）。判据与做法见 `docs/dev/audio-capture-native.md` §3.2。
> - **`x64-win32` —— 已替换，且在目标平台上真加载验证过**：工作流在 windows-latest（x86_64）runner 上用
>   Node 真 `require()` 加载刚构建出的 `.node`，逐个断言八个导出均为函数，并调用
>   `microphoneAuthorizationStatus()` 返回 **3**（落在 0..=3 的合法区间内）。日志原文：
>   `x64 原生模块加载验证通过；八个导出均为函数，授权状态为 3。`
> - **`arm64-win32` —— 已替换，但从未在任何机器上被加载或执行过**：`windows-latest` runner 是 x86_64，
>   结构上加载不了 aarch64 的 DLL。**工作流对此不假装通过**，而是打印一行显式跳过理由：
>   `跳过 arm64 原生模块加载验证：windows-latest 运行器是 x86_64，无法加载或执行 aarch64-pc-windows-msvc 构建。`
>   该 triple 取得的证据只有 `cargo build --release` 成功、`cargo clippy --release -- -D warnings` 干净，
>   加上下面的结构性核对。**这是本轮最重要的诚实点：它与其余五个 triple 的证据等级不同，不得用"已验证"
>   一类措辞覆盖它。** 待在真实 Windows on ARM 机器上补一次加载验证——**那是验证缺口，不是许可缺口**：
>   许可上这两个产物已出自本仓库的 AGPL 源码，与其余四个同源。
> - **结构性核对（在 macOS 上对下载来的第二批产物逐项做的）**：PE 机器类型与 triple 相符
>   （`x64-win32` = `0x8664` / IMAGE_FILE_MACHINE_AMD64，`arm64-win32` = `0xaa64` /
>   IMAGE_FILE_MACHINE_ARM64，两者 characteristics 都带 DLL 位 `0x2022`）；`napi_register_module_v1`
>   存在；八个导出函数名字符串两个产物都齐全。
> - **依赖面等价性证据，且这条比 Linux 那次更强**：提取被引用的 DLL 名
>   （`strings -a <file> | grep -oiE '[A-Za-z0-9_.-]+\.dll' | tr 'A-Z' 'a-z' | sort -u`）逐项对照，
>   原厂与自建产物**同为 8 项、`diff` 无输出**：`advapi32.dll` / `api-ms-win-core-synch-l1-2-0.dll` /
>   `bcryptprimitives.dll` / `dbghelp.dll` / `kernel32.dll` / `ntdll.dll` / `ole32.dll` / `oleaut32.dll`；
>   `vcruntime140.dll` 已消除。**Linux 那次自建产物比原厂多出 `libgcc_s.so.1` / `libm.so.6` 两个，
>   Windows 这两个是零差异。**（注：提取出的列表里还会有 crate 自身的模块名——原厂是
>   `audio_capture_napi.dll`、自建是 `audio_capture.dll`，那是构建产物重命名前的原名，不是外部依赖，
>   已从对照中排除。）
>   **2026-08-30 补注（方法与数字已更正，结论未变）**：上面这条当时用的是 `strings` 启发式，它只能
>   过度包含，分不出装载期导入、延迟导入与碰巧出现的字符串。同日改用 PE **导入表**复核四个文件
>   （新旧 × x64/arm64）：**装载期导入实为 7 项、延迟导入 0 项，四者完全相同**——`dbghelp.dll`
>   **不在导入表里**，它是 Rust std backtrace 在 panic 时 `LoadLibrary` 的符号化目标，被 `strings`
>   误算成了第 8 项。**「原厂与自建逐项相等、`vcruntime140.dll` 已消除」这个结论不受影响**，改的是
>   方法与那个数字（8 → 7）。可复现命令与理由以 `docs/dev/audio-capture-native.md` §3.2 为准，
>   `NOTICE` 中英两侧同批改写。
> - **装进仓库的产物指纹**：`vendor/audio-capture/x64-win32/audio-capture.node` sha256
>   `d0d79b7aa288d9f34d1dca6ac6c0f87d01dc18e72743bb162842520ae6920120`（809984 字节）；
>   `vendor/audio-capture/arm64-win32/audio-capture.node` sha256
>   `d619e905d5f3249c828bdea1093e82a2d34a6fc8db8a20731de514f245bfb230`（752640 字节）。被替换掉的原产物
>   sha256 分别为 `2a8267f4a1fc66202006269341597bcc1923a2975f95f46e8d8c3080e2e2d972`（x64）与
>   `983860892f4b2b179c16be3f8b2f7ec07249abbdbea394ddaf178e61a1bd290c`（arm64），仍可由
>   `git show 5459375f:vendor/audio-capture/<平台>/audio-capture.node` 取回。
> - **落点**：`NOTICE` 一/1 与五/5（中英两侧同批）、本文（文首状态块、本条、D-4 升级注、T-5.4〔当时写作 T-5.3，2026-08-30 重编，见该条〕、U-4）、
>   `docs/dev/audio-capture-native.md` §3.2、`packages/audio-capture-napi/native/.cargo/config.toml`。
>   **`BASE.md` 一字未动。**

> **处置①（2026-08-30 当日较早，工程交付，源码入库；保留为处置历程，不再是现状描述）**：本条卡住的根本原因——"源码位置尚未提供"——已经解决。
> `packages/audio-capture-napi/native/` 新增了一个 Rust + napi-rs 2.16 / cpal 0.15.3 crate，**从零重写**
> （clean-room，未反编译原二进制），10 个源文件全部带 `Copyright 2026 Qianmo AgentNest Team` +
> `SPDX-License-Identifier: AGPL-3.0-or-later` 两行头，落在本仓库的 AGPL 层内；实现了
> `packages/audio-capture-napi/src/index.ts` 约定的全部八个函数（`startRecording` / `stopRecording` /
> `isRecording` / `startPlayback` / `writePlaybackData` / `stopPlayback` / `isPlaying` /
> `microphoneAuthorizationStatus`）。下方"收口二选一"里，选的是**第①条**（补源码并标 AGPL），不是摘除。
>
> **六个 triple 逐条现状（截至处置①，4/6 已完成，均为真加载验证，非结构性推断；余下两个见处置②）**：
>
> - `arm64-darwin` —— **已替换**：从零构建成功，`clippy --all-targets -- -D warnings` 与 crate 自带单元
>   测试均通过；**本机 Bun 真机验证**录音（16 kHz / 16-bit LE / mono，50 ms 分块，三轮一致，
>   15584–15600 Hz）与播放（起停/幂等/重启），八个导出齐全，`microphoneAuthorizationStatus()` 返回 3，
>   与原厂二进制、独立 Swift 探针三方一致。`vendor/audio-capture/arm64-darwin/audio-capture.node`
>   现在就是这份自建产物，已可标 AGPL。
> - `x64-darwin` —— **已替换**：通过 **Rosetta 2 + 真实 x86_64 Node v26.3.0**，与原厂二进制**并排加载
>   对比**——八个导出齐全、`microphoneAuthorizationStatus()` 返回 3、状态位一致，已可标 AGPL。
> - `x64-linux` —— **已替换**：通过 **Docker `linux/amd64` + `node:22-slim`**（装 `libasound2`）与原厂
>   二进制并排加载对比，逐项一致，已可标 AGPL。
> - `arm64-linux` —— **已替换**：通过 **Docker `linux/arm64` 原生容器**与原厂二进制并排加载对比，逐项
>   一致，已可标 AGPL。
> - `arm64-win32` / `x64-win32` —— 本机（macOS）无法构建，需要真实 MSVC 工具链，**当时仍是原厂二进制、
>   许可仍待定**，待 Windows 机器或 CI。（**已于同日由 CI 收口，见上方处置②。**）
>
> **关于 `--allow-unverified-install`（避免被误读成"硬装未验证产物"）**：`scripts/build-audio-capture.sh`
> 的自动校验闸门只能验证"本机能否原生 `require()` 加载"，`x64-darwin` / `arm64-linux` / `x64-linux` 三个
> 跨架构产物因此走的是这个标志——但**这不等于没验证**：它们是先在容器（两个 Linux triple）或 Rosetta 2
> （`x64-darwin`）**目标架构上真实加载**、与原厂二进制并排对比逐项一致之后，才手工确认安装的，与"完全没
> 测过就装"是两回事。
>
> **一条运行时依赖等价性证据（回答"换成自建产物会不会让 Linux 用户跑不起来"）**：对 Linux 产物用
> `readelf -d` 比较 `NEEDED` 段——原厂二进制依赖 `libasound.so.2` / `libpthread.so.0` / `libc.so.6` /
> `libdl.so.2` / `ld-linux-x86-64.so.2`；自建产物依赖以上全部，**外加** `libgcc_s.so.1` / `libm.so.6`。
> **结论：ALSA 这个硬依赖原厂本来就有，不是自建产物引入的**；多出的两个在任何 glibc 系统上必然存在。
> 运行时依赖面没有实质变化。
>
> 另有一条新增的构建前提：crate 需要 **Rust ≥ 1.85**（`coreaudio-sys` 要求 edition2024），已用 crate 内
> `rust-toolchain.toml` 钉住 `1.85.0`，`Cargo.toml` 同步写了 `rust-version = "1.85"`。构建脚本、验证步骤与
> 装载层契约见 `docs/dev/audio-capture-native.md`（源码与 vendor 目录的对应关系、`--install` 校验闸门等，
> 该文档已有完整记录，此处不复述）；`NOTICE` 一/1 与五/5 同批改写为反映这一进度。
>
> **当时为什么判"部分处置"而不是"已处置"（保留为当日较早时点的判断依据）**：六个 triple 里还有两个
> （`arm64-win32` / `x64-win32`）的 `vendor/` 二进制仍是随基座快照带入的原厂产物，标注仍是"许可待定"
> ——**没有把"四个已验证替换"和"六个二进制全部合规"混为一谈**。**这条判断已由上方的处置②于同日收口。**
> **下方原文保留为处置依据，不再是现状描述。**

- **怎么来的**：D-4 把这六个 `.node` 的许可归属列为待人项时，仓库是 MIT——MIT 不要求随分发提供源码，
  所以"许可待确认"是一个可以挂着的状态。**转 AGPL 之后它不再是。**AGPL 要求分发时提供
  Corresponding Source，而这六个二进制随 `dist/vendor/` 出货、源码不在任何人手上。
- **负责人已定的方向（2026-08-29）**：**把它们一并纳入 copyleft 并补齐源码。**
- **卡在哪**：**源码位置尚未提供。**在它到位之前，`NOTICE` 与本文都**不把这六个文件标成 AGPL** ——
  标了却给不出源码，等于让本仓库违反自己的许可，比"许可待定"严重得多。
- **当前如实状态**：它们既不在 AGPL 层（不带 SPDX 头），也不属于基座 MIT 层（那层覆盖的是源码形态的基座代码），
  而是**许可待定的随附二进制**。`NOTICE` 五/5 已如实写明这一点与两条收口路径。
- **收口二选一**（**必须选一条，不能长期挂着**）：
  1. 负责人给出源码仓库/分支 → 源码入库或在 `NOTICE` 给出可取地址 → 六个二进制标 AGPL，本条关闭；
  2. 把它们从分发中摘除 —— 删 `build.ts` / `scripts/post-build.ts` 的复制步骤，
     `packages/audio-capture-napi/` 装载层降级为"原生模块缺失时禁用音频采集"。
     代价是音频采集能力在产物中消失；M0 演示本就不使用它（章程 N-9），**这条路是可行的**。
- **责任人**：喻永昌（以基座作者身份给源码）/ 陈曦宇（口径与 `NOTICE` 复核）。

#### D-10 ✅ 已处置（**新增于 2026-08-30 → 当日已处置**）—— 非代码资产的许可口径此前待明确，现已按三类定案

> **处置（2026-08-30，负责人决议）**：非代码资产共 **34** 个，按三类分别定性：A 类自制作品（**27** 个）适用 **CC BY-SA 4.0**；B 类第三方标识（**3** 个）**不授出**，移入 `NOTICE` 五「第三方组件」如实披露；C 类申报文书（**4** 个）**保留所有权利**。三类逐文件清单与定性理由见根 [`NOTICE`](../../NOTICE) 一、许可；本文不复制清单。M0 流程件已于 2026-08-17 由负责人决议全部关闭，不另设评审、双签或其他形式要件待办。

- **原现状**：`NOTICE` 一、许可原先写明：按路径判据落在阡陌 AGPL 层的还有 **27** 张 `.jpg`、**3** 张 `.png`、**2** 份 `.pdf`、**2** 份 `.docx` 等非代码资产；AGPL-3.0 是软件许可，这些作品适用什么许可不由该判据决定，**目前是待明确项**，本文件不代负责人下结论。
- **实际**：本次核对发现 `docs/assets/brand/大赛logo大图.png` 与 `大赛logo横版.png` 是中国国际大学生创新大赛的官方标识（第三方标识），`封面.jpg` 把该标识合成进了画面；两份 docx/pdf 又内嵌了封面。仓库内没有任何授权记录、来源记录或使用许可。因此这不只是措辞问题，B 类不随本仓库任何许可授出。
- **实测（2026-08-30）**：按 `base-snapshot/v2.46.0` 路径差集命令核得非代码资产共 **34** 个，扩展名拆分为 **27** 张 `.jpg`、**3** 张 `.png`、**2** 份 `.pdf`、**2** 份 `.docx`，与负责人决议记录的合计表一致。
- **风险（本次不处置）**：C 类申报文书含在校学生个人信息（学号、姓名、指导教师、团队成员），且已入库跟踪；仓库转公开时会随历史一并公开，从 HEAD 删除也去不掉 `67f6081` 里的那一份。本批只落许可口径，转公开前是否脱敏另议。
- **后续处置（2026-09-26，负责人决议「从当前版本移除，历史不动」）**：四份 C 类申报文书已从当前版本移出，原件由负责人另存；`docs/README.md` 里的成员联系方式与学号、本文 E-8 行与「E-8 说明」里内联的负责人个人邮箱同批删去。**不改写历史**：从 `67f6081` 到移出之前的提交、以及此前发行的源码包里仍有这些文件，上一条所说「从 HEAD 删除也去不掉」依然成立。许可口径不变（从未授出），见根 [`NOTICE`](../../NOTICE) 一.7 的 C 类。

---

## 4. 依赖树里的非 SPDX / 非开源授权项：人工核读结论

`bun run sbom` 只读 `license` 字段、不读授权正文。[`sbom-m0.md`](./sbom-m0.md) §4 列出的 4 项，逐项人工核读结果如下（核读日期 2026-08-15）。

| 包 | `license` 字段 | 实际授权（读正文） | 影响面 | 处置 |
|---|---|---|---|---|
| **`@anthropic-ai/claude-agent-sdk` 0.2.114** | `SEE LICENSE IN README.md` | 包内 `LICENSE.md` 全文为：**「© Anthropic PBC. All rights reserved.」**+ 指向 Anthropic 法律条款页。**这是专有授权，不是开源许可** | 位于根 `devDependencies`。全仓**仅两处引用**：`src/cli/print/runHeadlessStreaming.ts:29` 是 **`import type`（纯类型，编译期擦除）**，`src/services/acp/agent/AcpAgent.ts:5` 是注释里的一句"不使用它"。**实测 `dist/` 中无任何该包的引用**（`grep -rl "claude-agent-sdk" dist` 无输出），即**不进入分发产物** | **主动披露**，不要等被问。见下方"为什么这条重要" |
| `@anthropic-ai/claude-agent-sdk-darwin-arm64` 0.2.114 | `SEE LICENSE IN LICENSE.md` | 同上（上一项的平台原生包） | 同上；另有 7 个平台变体在 lockfile 中、本机未安装 | 同上 |
| `@modelcontextprotocol/server-filesystem` 2026.7.10 | `SEE LICENSE IN LICENSE` | **包内没有 `LICENSE` 文件**（tarball 只含 `README.md` / `dist/` / `package.json`）——字段指向的文件未随包发布，授权正文在本机不存在 | 仅被**测试**使用（`tests/integration/qianmo-mcp-conformance.test.ts` 以子进程启动 `node_modules/.../dist/index.js`），不被 `src/` 引用、不进 `dist/` | 到上游 `modelcontextprotocol/servers` 仓库取许可正文存证；**不阻断** |
| `@modelcontextprotocol/server-memory` 2026.7.4 | `SEE LICENSE IN LICENSE` | 同上（包内无 `LICENSE` 文件） | 同上 | 同上 |

### 为什么 `@anthropic-ai/claude-agent-sdk` 这条重要

它把两件本来分开的事放到了一起：`NOTICE` 四声明"本项目与 Anthropic 无关联"，而依赖树里确实躺着一个 **Anthropic PBC 保留一切权利**的包。这不是矛盾——依赖一个公司的 SDK 与"获得该公司授权/背书"是两回事——但它是**评审方一查 `package.json` 就能看到、而我们没主动说**的那一类事实，正是风险 L-1/L-4 最容易被放大的形态。

**工程侧已确认的缓解事实**（可直接用于答辩）：

1. 它是**类型依赖**，不是运行时依赖——唯一的代码引用是一个 `import type`；
2. **产物里没有它**——`dist/` 中零引用（可现场复跑 `grep -rl "claude-agent-sdk" dist`）；
3. 因此**分发阡陌产物不构成再分发该 SDK**。

### 决定（2026-08-15，负责人授权）：**保留依赖 + 主动披露**，不移除

原提请评审的问题是「要不要把这一处 `import type` 换成本地类型声明，让依赖树里彻底没有专有授权项」。**决定不换，理由三条**：

1. **影响面本来就极小**：全仓仅一处 `import type`（`src/cli/print/runHeadlessStreaming.ts:29`，编译期擦除）加两处注释，`dist/` 零命中——它已经不在分发面上，移除它换来的只是「依赖清单里少一行」的观感。
2. **代价落在基座依赖图上**：移除要改基座根 `package.json` 与 `bun.lock`。基座的发布面本仓库不维护（`CLAUDE.md` §0），且每动一次依赖图，下次上游同步就多一处必然冲突——P7.4 演练的结论正是「上游对 `package.json` 的唯一改动是版本号、`bun.lock` 未动」这份零漂移是当前低冲突率的一部分（[`upstream-sync-drill.md`](./upstream-sync-drill.md) §3.3）。**为观感去动基座依赖图不值。**
3. **披露比移除更符合口径**：风险 L-1/L-4 怕的是「评审方一查 `package.json` 就看到、而我们没主动说」，解法是**说**，不是**藏**。移除后依赖清单干净了，但「曾经依赖过」仍在 git 历史里，反而多一层要解释的东西。

**落地**：根 `NOTICE` 五（中）/ 5（英）已补一条**开发期专有授权依赖披露**——写明它是 devDependencies、专有授权（包内 LICENSE.md「© Anthropic PBC. All rights reserved.」）、仅 `import type`、`dist/` 零命中不随产物分发、其许可条款以其包内 LICENSE 为准，并明确该披露**不构成**与 Anthropic, PBC 的关联/授权/背书关系。同时保留 P8.3 Q&A 预案里的三条缓解事实。

**仍要做的**：科技处议题 T-5.1（是否需要在申报材料中同样披露）不变，等其口径。

---

## 5. 学校科技处 / 知识产权办公室咨询议题清单（模板）

> **使用方式**：咨询由**安全 owner（陈曦宇）**主办、负责人（喻永昌）参加（章程 §6.2 L-2 责任人）。
> 本清单是**去咨询时带的问题单**，不是答案单。**每条都要带走一句可复述的口径**——章程 P8.4 的 DoD 写的是
> "科技处咨询已完成并有**书面或可复述的口径**"，只带回"他们说应该没问题"不算完成。
>
> **退路预留**：若口径要求更强隔离，**立即触发范围评审**（章程 L-2 对策⑤）。不要假定一定过。

### 5.0 咨询前须备齐

- [ ] §2 表中 ✅ / 🟡 各项的快照（网页、`npm view` 输出、tarball 元数据）
- [ ] **E-8 的归属关系材料**（最可能被追问的一组，工程侧取不到）
- [ ] 本文 §3 的 `NOTICE` 差异清单（说明哪些已修、哪些待其口径再定）
- [ ] [`sbom-m0.md`](./sbom-m0.md)（一句话结论：无强传染许可项）
- [ ] `base-adoption.md` §5 R-1 的事实四条（**逆向工程溯源，不要隐去**）

### 5.1 议题 T-1 ⚖️ 逆向工程溯源与 MIT 的覆盖范围（**风险 L-2 核心，必问**）

> 出处：章程 §6.2 L-2、`base-adoption.md` §5 **Q-1**。

**事实陈述（照读，不要润色）**：本项目的基座 open-claude-code 由项目负责人自有并以 MIT 在 npm 公开发布；该基座**自述**为对 Anthropic Claude Code 的**逆向复原（reverse-engineered restoration）**，并记录它 fork 自另一个还原工程。

**要问的**：

- **T-1.1** MIT 是基座作者对**其自身还原与原创工作**的授权。它能否覆盖**上游被还原的表达**？在软著申请与竞赛成果认定中，这一层会被如何看待？
- **T-1.2** 我方是该基座的**下游 fork**（公开事实，不隐瞒）。软著申请时，作品说明里应当如何描述"基于自有 MIT 开源项目的下游 fork + 自研常驻化改造与通信网络"这一形态？**是按"改编作品"申报，还是只就新增部分申报？**
- **T-1.3** 若评审方要求证明"新增部分独立可分"，`git diff 3380c88..HEAD` 这类 git 基线举证是否被接受？还有没有更被认可的举证形式？
- **T-1.4** **退路**：若贵处认为溯源风险不可接受，我们应当把隔离做到什么程度才算达标？（此问的答案直接决定是否触发范围评审）

### 5.2 议题 T-2 ⚖️ 归属关系的举证标准

> 对应本文 **E-8 缺口**。

- **T-2.1** 「基座是项目负责人自有」这一事实，需要哪些材料才算证成？npm/GitHub 账号所有权截图够不够？需不需要更正式的权属声明？
- **T-2.2** 负责人个人持有的开源项目，被用作**学校立项项目**的基座，权属上有没有需要事先处理的事项（职务作品认定、学校对成果的权利主张等）？
- **T-2.3** 若基座本身也需要登记，与本项目的软著是分开登记还是合并？

### 5.3 议题 T-3 ⚖️ 用途限定与商业化路径（**风险 L-5 轨道**）

> 章程 L-5 已于 2026-08-11 由基座侧修正三语 README 而**解除**（用途限定移除，许可正文与自述一致，见章程 §6.2 L-5、`base-adoption.md` §5 Q-2）。
> **本议题是复核，不是重开**——目的是拿到科技处对"已解除"这一判断的确认。

- **T-3.1** 基座 README 曾含"**仅供学习研究用途**"字样、其后由基座作者（即本项目负责人）自行修正。这种"作者自行修正自述"的处理方式，在申报材料里需要说明吗？**历史版本仍留在上游 git 历史里**，会不会构成问题？
- **T-3.2** 已解除的这一条，与 **M3 商业化**（章程规划 2028）之间还有没有遗留约束？
- **T-3.3** 若答辩现场被出示 README 的**历史版本**并追问，建议口径是什么？

### 5.4 议题 T-4 许可文件与声明的形式要求

> 对应本文 **D-5**（已按另一条路处置）与 **D-9**（新增于 2026-08-29，**2026-08-30 已处置**；**原编号 D-8，2026-08-30 因与 `SECURITY.md` 那条 D-8 重号而重编为 D-9**）。

- **T-4.1**（**原题已作废，2026-08-29**）原问：沿用基座 MIT 时，`LICENSE` 是否要增列本团队版权行。
  该问题已随章程 v2.16 转 AGPL 而消失——`LICENSE` 现在是阡陌自己的许可文件。**替换为下面两问：**
  - **T-4.1a** 本仓库现为**双许可**（阡陌层 AGPL-3.0-or-later / 基座层 MIT），
    以 **SPDX 文件头** 作为两层判据。软著申报接受这种边界举证方式吗？
    还需要什么形式要件（例如逐文件清单、或在申报材料中单列 AGPL 层的文件数与行数）？
  - **T-4.1b** AGPL-3.0 §13 要求：用户通过**网络**与程序交互时，运营方须向该用户提供 Corresponding Source。
    阡陌的控制台与常驻节点都落在这一格，**包括我方自己在 p11 上对公网开放的部署**。
    履行方式（页面上给出源码地址是否足够、需不需要给出与运行版本一致的 tarball、`SOURCE_COMMIT` 算不算）
    请给口径。**这条不是形式要件而是持续义务**，是本次转 AGPL 带来的唯一新增运营负担。
- **T-4.2** 根 `NOTICE` 现有的四节结构（许可 / 基座溯源 / 基座性质如实声明 / Anthropic 商标）是否满足申报要求？还缺什么？
- **T-4.3** 代码中**技术性保留**的 Anthropic 标识（系统提示词前缀、User-Agent、OTel `service.name`、`CLAUDECODE=1` 等，改动会破坏功能）——现有的"技术性保留不构成关联性主张"声明措辞是否足够？

- **T-4.4**（新增）转许可**不可追溯**这一点，我方在 `NOTICE` / `README.md` / 章程 v2.16 三处都写明了
  （此前按 MIT 取得副本者的授权不受影响，AGPL 只适用于此后发布的版本）。这样表述是否准确、是否够？

### 5.5 议题 T-5 第三方依赖与预编译二进制

- **T-5.1** 依赖树中存在一项 **Anthropic PBC 专有授权**的包（`@anthropic-ai/claude-agent-sdk`，仅类型引用、不进产物，见 §4）。**是否需要在申报材料中主动披露？**
- **T-5.2** 仓库内含**源码与许可未确认的预编译原生二进制**（`vendor/audio-capture/`；**上游仓库里同样只有六个 `.node`、无源码无 LICENSE**，实查见 D-4）。它随产物分发但 M0 不使用该功能——需不需要在申报前移除、或由基座作者补齐源码与许可？（`NOTICE` 已如实披露现状，未推定许可）

  **2026-08-30 更新（本议题问的那件事已经有答，原题保留可读）**：源码已由负责人以基座作者身份补齐并入库
  ——`packages/audio-capture-napi/native/`（Rust + napi-rs，从零重写、非反编译，标 `AGPL-3.0-or-later`）；
  `vendor/` 下六个 triple 的产物已全部换成由该源码构建的产物。**本议题给出的两条路里走的是第二条**
  （由基座作者补齐源码与许可），「申报前移除」不再需要考虑；「源码与许可未确认」这个前提在**本仓库**
  已不成立。**上游仓库仍然只有六个 `.node`、无源码无 LICENSE**——本仓库不代上游收口，是否把源码回贡上游
  按章程 v2.16 ③ 逐次决定。**剩下的不是许可问题**：`arm64-win32` 从未在任何机器上被加载或执行过，欠一次
  真实 Windows on ARM 机器上的加载验证；那是验证缺口，许可上它与其余五个同出一份 AGPL 源码。负责人
  2026-08-30 决定不做这一项（本项目没有该架构的机器），无限期挂起。**因此本议题仍需科技处答的只剩一问**：
  随产物分发一个源码在手、但从未经过运行时验证的二进制，申报材料里要不要单独说明？（与 T-5.4 末段同一问）
- **T-5.3** 弱传染许可（LGPL-3.0-or-later 的 `@img/sharp-libvips-*`、MPL-2.0 的 `lightningcss` 等，共 5 项）在软著申报中需要单独说明吗？

- **T-5.4**（新增，2026-08-29，对应 **D-9**；**原编号 D-8，2026-08-30 重编，见 D-9 条内说明**。**本条自身也重过一次号**：新增时误取了已被上面那条弱传染许可占用的 **T-5.3**，2026-08-30 重编为 **T-5.4**——先来的那条不动；roadmap v2.68 ⑧ 的落点写作「T-5.3」，指的就是本条）在 **AGPL** 下随产物分发一个**源码不在手上**的预编译原生二进制
  （`vendor/audio-capture/` 六个 `.node`），法律风险有多大？我方当前的处置是**不给它标 AGPL、如实写明许可待定**，
  并准备了两条收口路径（补源码 / 从分发中摘除）。请判断：① 现状是否已构成对本仓库自身许可的违反？
  ② 若短期内取不到源码，是否应当立即执行"摘除"那条路？

  **2026-08-30 更新（D-9 由"仍待人"转"部分处置"，4/6 已验证替换）**：源码已经入库并标注 AGPL
  （`packages/audio-capture-napi/native/`），六个 triple 中 **`arm64-darwin` / `x64-darwin` /
  `arm64-linux` / `x64-linux` 四项已完成替换**——均为在目标架构上真加载验证（本机 Bun、Rosetta 2 +
  真实 x86_64 Node、Docker `linux/amd64`/`linux/arm64` 容器），并排对比原厂二进制逐项一致，不是结构性
  推断；`readelf -d` 的 `NEEDED` 段比对显示 Linux 产物的运行时依赖面较原厂只多两个 glibc 系统必然自带的
  库，无实质回归。**仅剩 `arm64-win32` / `x64-win32` 两个 triple**（本机无法构建，需真实 MSVC 工具链，
  待 Windows 机器或 CI）仍是原厂二进制。**对已替换的四个 triple，问题①不再成立**（源码在手、已标注、
  已验证）；**对未替换的两个 Windows triple，问题①②依旧成立**——仍在分发一份源码不在手上的二进制，
  仍需科技处判断在剩余替换完成前是否要先行"摘除"这两个 triple，抑或按当前进度继续补齐即可。

  **2026-08-30 再更新（D-9 已处置，6/6 完成）**：同日晚些时候，`x64-win32` / `arm64-win32` 两个 triple
  也已用同一份源码构建并替换——构建走新增的手动触发工作流
  `.github/workflows/build-audio-capture-windows.yml`（仅 `workflow_dispatch`，`windows-latest`，
  两个 job 分别对应 `x86_64-pc-windows-msvc` 与 `aarch64-pc-windows-msvc`）。**问题①②对全部六个 triple
  都不再成立**：仓库不再分发任何源码不在手上的二进制，"摘除"那条路也不再需要考虑。**尚存的是一项
  验证待办，不是许可待办**：`arm64-win32` 从未被加载或执行过（runner 是 x86_64，加载不了 aarch64 的
  DLL），欠一次真实 Windows on ARM 机器上的加载验证。若科技处对"未经运行时验证但源码在手"的产物另有
  口径，请一并给出。

### 5.6 咨询结论回填（**咨询后填，空着即视为 P8.4 未闭环**）

| 议题 | 科技处口径（可复述） | 是否触发范围评审 | 记录人 / 日期 |
|---|---|---|---|
| T-1 | | | |
| T-2 | | | |
| T-3 | | | |
| T-4 | | | |
| T-5 | | | |

---

## 6. 未决事项

| # | 事项 | 谁做 | 阻断什么 | 状态 |
|---|---|---|---|---|
| U-1 | `NOTICE` 中英两处举证命令改为 `3380c88..HEAD`（D-1）；`README.md` 同批修正 | — | **P8.4 DoD「`NOTICE` 与实际状态一致」** | ✅ **已处置**（2026-08-15，负责人授权）。**剩余**：改后文本仍需负责人 + 安全 owner 双签确认（章程 §5.8 第 4 条） |
| U-2 | `BASE.md` 补记上游公开仓库 URL；补记 P7.4 演练（D-2） | — | P8.4 证据包 E-9；P7.4 交付物 | ✅ **已处置**（提交 `0c2f3b17`，负责人授权的记录事件） |
| U-3 | 取齐 E-8 归属关系材料 | 负责人本人 | 科技处咨询 T-2；证据包最大缺口 | ⏸ **仍待人**（工程侧取不到，见 §2「E-8 说明」） |
| U-4 | **`arm64-win32` 产物的一次运行时加载验证**（D-9 收口后剩下的唯一项）<br>**原题「`vendor/audio-capture/` 源码位置与许可说明（D-4）」已于 2026-08-30 闭**，保留在下方状态栏里可读 | **谁有 Windows on ARM 机器谁跑**（当前无人）<br>**原责任人「负责人（以基座作者身份）」的那份待办已闭**——源码已提供并入库，许可面不再需要负责人做任何事 | **无**。许可归属、证据包完整性与咨询 T-5.2 都已不被本条阻断；本条只影响**对外表述的准确性**——`arm64-win32` 的证据等级低于其余五个 triple，任何地方都不得用「六个 triple 全部验证通过」把它盖过去 | ⏸ **无限期挂起的工程验证待办，不是「即将完成」**（2026-08-30 定性）：**本项目没有 Windows on ARM 机器，负责人 2026-08-30 决定不做这一项，未排期**。它欠的是一次在真实 Windows on ARM 上的 `require()` 加载；**许可上没有任何待定项**——该产物与其余五个同出一份仓库内的 AGPL 源码。挂着 ⏸ 记录的是「这条证据确实缺」，不是「有人正在做」。<br>**以下为处置历程，保留原文不改：**<br>**（原状）仍待人，范围已收窄**：`NOTICE` 侧已如实披露（含上游同样无源码/无 LICENSE 的核查结果与二进制符号读出的 crate 清单）；缺的只剩「模块自身源码在哪、以什么许可发布」<br>**2026-08-30 更新**：模块自身源码已提供并入库（`packages/audio-capture-napi/native/`，AGPL-3.0-or-later），U-4 问的那两问就此有答。**范围收窄为工程收尾而非负责人待办**：六个 triple 中 **`arm64-darwin` / `x64-darwin` / `arm64-linux` / `x64-linux` 四项已用该源码重建、真加载验证并替换 `vendor/` 产物**，仅 `arm64-win32` / `x64-win32` 两个 Windows triple 仍待构建替换（需真实 MSVC 工具链，待 Windows 机器或 CI），见 D-9<br>**2026-08-30 再更新（D-9 已处置）**：`x64-win32` / `arm64-win32` 两个 triple 已由手动触发的 GitHub Actions 工作流 `.github/workflows/build-audio-capture-windows.yml` 用同一份源码构建并装入 `vendor/`，**六个 triple 全部出自本仓库自有源码，仓库内不再有许可未定的二进制**，U-4 的许可面就此没有待办。**剩下的是一项验证待办而非许可待办**：`arm64-win32` 从未在任何机器上被加载或执行过（构建它的 runner 是 x86_64），欠一次真实 Windows on ARM 机器上的加载验证——保持 ⏸ 只是因为这件事仍需一台我方没有的机器（**该句已由本行开头的 2026-08-30 定性取代：那台机器本项目不会有，负责人已决定不做**） |
| U-5 | 上游 `LICENSE` / npm 页面 / tarball 元数据快照存证（E-2/E-3/E-4） | 安全 owner | 证据包 🟡 转 ✅ | ⏸ 仍待人 |
| U-6 | 科技处咨询实施并回填 §5.6 | 安全 owner 主办 | **P8.4 DoD「科技处咨询已完成」** | ⏸ 仍待人 |
| U-7 | 是否移除对 `@anthropic-ai/claude-agent-sdk` 的类型依赖（§4） | — | 无（优化项） | ✅ **已决**：保留 + 主动披露，理由与落地见 §4「决定」 |
| U-8 | 在其它目标平台各跑一次 `bun run sbom` 并表（本机 `darwin-arm64` 读不到 198 项平台包的许可字段） | 谁有对应机器谁跑 | SBOM 全平台完整性 | ⏸ 仍待人 |
| U-9 | `LICENSE` 是否增列阡陌版权行（D-5） | 科技处口径（T-4.1）后由负责人定 | 无（形式项） | ✅ **已处置（2026-08-29，随章程 v2.16 转 AGPL）**：走的不是本条问的那条路——`LICENSE` 换成 AGPL-3.0 正文、基座 MIT 原文移到 `LICENSE.base`，「在 MIT 正文里增列版权行」这个问法随之消失，D-5 同日转 ✅；归属改由 SPDX 文件头机器可判。原题 T-4.1 已作废并换成 T-4.1a / T-4.1b。<br>**（原状，保留可读）** ⏸ 仍待人，**本次未动 `LICENSE`**<br>**勘误（2026-08-30 追记）**：上面「归属改由 SPDX 文件头机器可判」是已被证伪的说法，照本条处置当日的记录原样保留，**不是现行口径**——现行口径见根 `NOTICE` 一/1「文件头只在一个方向上作数」一段：归属的权威判据是**路径**（该文件在不在基座零改动快照 `base-snapshot/v2.46.0` 那棵树里），文件头只是这条判据的**标记**、不是判据本身；正向的「带头 ⇒ 阡陌自有」成立，反向（无头 ⇒ 基座）不成立 |
| U-10 | `NOTICE` / `README.md` 的 pin 陈述跟进首次上游同步（D-7） | — | `NOTICE` 与 `BASE.md` 互相矛盾 | ✅ **已处置**（2026-08-28）。改的是已双签件的正文，属 D-1 同类的**事实性勘误**（把 `BASE.md` 与章程 v2.13 已定案的事实落到文本上），按 D-1 先例处理；**不另设签署待办**——M0 流程件已于 2026-08-17 负责人决议关闭（roadmap v2.41） |
| U-11 | `SECURITY.md` 与 issue 模板对外化（D-8） | — | **仓库转公开**（漏洞报告会误投基座仓库） | ✅ **已处置**（2026-08-28）。新写的对外文本，负责人转公开前过一眼即可；同上不另设签署待办 |
| U-12 | 把 `NOTICE` / `README.md` 的 pin 陈述并入上游同步后的回写清单 | — | 无（防复发） | ✅ **已处置**（2026-08-28）：记入 [`upstream-sync-drill.md`](./upstream-sync-drill.md) §7.1 第 5 条 |
| U-13 | 非代码资产许可口径（D-10） | — | 原先阻断 `NOTICE` 一、许可里那三处「待明确」中的第一处 | ✅ **已处置**（2026-08-30，负责人决议）。M0 流程件已于 2026-08-17 由负责人决议全部关闭，不另设评审 / 双签待办；三类口径见 [`NOTICE`](../../NOTICE) 一、许可 |
