<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 上游同步演练记录（P7.4）

> 本文是 roadmap P7.4 的交付物。**§1~§6 是演练**：目的是测出冲突成本，不是真的升级（章程 §5.7、N-13），
> M0 期间基座 pin 冻结在 v2.38.3，演练不产生任何代码合入。
> **§7 是真做**：2026-08-17 的 P10.2 首次真实同步（v2.38.3 → v2.46.0，已合入，`BASE.md`「上游同步记录」），
> 与演练预测逐项对照。
> 状态：P7.4 评审已通过、章程 §5.7 已回写并定稿（roadmap v2.41），DoD 闭环。

## 1. 演练参数

| 项 | 值 |
| --- | --- |
| 演练日期 | 2026-08-15 |
| 起点（当前 pin） | v2.38.3 · `848ad8c2c8daca9f5aa2410da555553e07700f5d` |
| 目标 tag | v2.46.0 · `1128a3919a7f01298a6cbf5c468a839c6cf4ee6a` |
| 目标选择依据 | 上游当前最新正式 release（GitHub `get_latest_release`，draft:false / prerelease:false），发布于 2026-08-14T08:37:54Z |
| 区间规模 | 61 个提交、8 个 release、650 文件、+60,363 / −7,417 行 |
| 我方基线 | `60ecff1c`（分支 s4/p4.2-loop-and-rate），自导入点起 420 文件、+67,362 / −1,358 行 |
| 演练环境 | 一次性 clone，不在主检出、不加 remote、不推送 |

## 2. 方法：三方应用，不是 merge

本仓库是**零改动快照导入**、不含上游历史，`git merge upstream/<tag>` 会被判定为
unrelated histories 并产出满屏假冲突。正确做法是三方应用：

```bash
git clone file:///path/to/atlas p74-drill && cd p74-drill
git remote add upstream <上游 URL>
git fetch --no-tags upstream tag v2.38.3 tag v2.46.0
git checkout -b drill/p74-v2.46.0
git diff --binary v2.38.3 v2.46.0 > upstream.patch
git apply --3way --whitespace=nowarn upstream.patch
```

**前提已验证**：`git diff 3380c88 v2.38.3` 的唯一差异是 39 个 atlas 独有的立项文档/图片，
基座文件被修改数为 0 —— 零改动快照声明成立，故每个基线 blob 精确命中。

## 3. 结果

### 3.1 冲突清单（5 文件 / 7 块，全部为内容冲突）

| 文件 | 块 | 上游 | 我方 | 归因族 |
| --- | --- | --- | --- | --- |
| `CLAUDE.md` | 2 | +5/-2 | +82/-117 | 其他（fork 文档就地替换） |
| `README.md` | 2 | +2/-2 | +76/-126 | 其他（对外表述） |
| `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts` | 1 | +24/-1 | +16/-1 | 其他（provider 兼容修复） |
| `src/services/api/openai/responsesAdapter.ts` | 1 | +116/-40 | +15/-10 | 常驻化改造 |
| `scripts/unused-budget.json` | 1 | +2/-2 | +1/-1 | CI 门禁 P0.4 |

其余冲突类型经逐项验证**均为 0**：我方删/上游改 0、上游删/我方改 0（上游本区间未删任何文件）、
新增撞名 0（上游新增 261 文件 ∩ 我方新增 372 文件 = 空集）。

### 3.2 按族统计

| 族 | 改基座文件数 | 冲突文件 | 冲突块 |
| --- | --- | --- | --- |
| 身份隔离改名 P0.3 | 9 | 0 | 0 |
| 常驻化改造 | ~20 | 1 | 1 |
| CI 门禁 P0.4 | 6（+1 删除） | 1 | 1 |
| `@qianmo/*` 新增 | 0（372 新增文件 / 17 包） | 0 | 0 |
| 其他（文档/provider/测试） | 9 | 3 | 5 |

**最反直觉的一条：冲突的大头不是代码，是文档**——7 个冲突块里 4 个出自
`CLAUDE.md` 与 `README.md`，技术含量最低却最占工时（需要负责人与安全 owner 参与决策）。

### 3.3 干净应用面

- 645 / 650 文件干净落下（99.2%）
- 67,584 行干净落下（99.7%）
- 1784 个上游 hunk 中仅 7 个冲突（**0.39%**）
- 261 个纯新增文件零交互落下（+37,566 行）
- 双方都改的 17 个文件中 12 个自动合并成功
- **零依赖漂移**：上游对 `package.json` 唯一改动是版本号，`bun.lock` 未动（偶然，不能假设下次也如此）

### 3.4 合并后验证

- `bun run typecheck`：**exit 0**
- `bun test`：**11311 条全绿**（原始输出 3 条 fail 系演练沙箱 `EROFS: mkdir '/mock'`，
  失败文件为上游全新增、我方从未触碰，关闭沙箱重跑 8 pass / 0 fail）
- 最高风险自动合并 `src/utils/permissions/filesystem.ts`（上游 +242/-28 落在三身份并集逻辑上）
  经逐行核对，我方保护清单并集与 worktree 豁免完整保留，未发现静默语义破坏

## 4. 工时估算

| 档位 | 块 | 保守工时 |
| --- | --- | --- |
| 机械重放（棘轮数字重测量） | 1 | 0.5 h |
| 需要理解语义（watchdog 错误语义、sawOutput 提取） | 2 | 3 h |
| 需要重新决策（fork 文档定位、对外表述口径） | 4 | 4 h |
| 门禁重测量 | — | 1 h |
| 全量 verify 回归 | — | 2 h |
| 61 提交语义影响审阅 | — | 4 h |
| **合计** | | **10–20 h（中位 ~14 h，1.5–2.5 人日）** |

## 5. 结论与行动项

1. **基座关系是健康的，不是债务。**0.39% 的冲突率与全绿的合并后验证说明，
   「优先走扩展点」的纪律确实生效了。
2. **把 `CLAUDE.md` / `README.md` 改薄**（文件名在「明确不改」清单里不可改，但内容可降为
   基座原文 + 指向阡陌自有文档的指针）。收益最大、成本最低——可消除 57% 的冲突块，
   且天然符合「指针不复制」铁律。
   **✅ P10.3① 已落地（2026-08-17）**：落地形态与这里的设想相反但等效——不是「基座原文 +
   指针」，而是**阡陌增量在前、基座原文逐字附在后**（`BASE-CLAUDE.md` 并回 `CLAUDE.md`
   下半部分并删除）。理由：我方相对上游 preimage 的差异必须退化成**一次纯插入**才可干净合并，
   而「改薄成指针」删掉的恰恰是上游 hunk 要落的那些行。用本次演练留下的真实上游对象复跑
   `git apply --3way`：整改前 4 个冲突块（`CLAUDE.md` 2 + `README.md` 2）**全部消失**，
   且合并后阡陌部分一字未动、基座部分自动升级为上游 v2.46.0 版本。
3. **把 `FreezeAwareWatchdog` 等常驻化替换抽成注入点**，不要在基座文件里就地替换——
   本次唯一的代码语义冲突正是这里。同一模式适用于 `claude.ts` / gemini client 的同类替换。
   **✅ P10.3② 已落地（2026-08-17）**：按下面第 6 条的规则派生——上游现成的间接层就是
   `setTimeout` / `clearTimeout` 这对全局函数的**形状**，于是注入点做成同形的
   `setFreezeAwareTimeout` / `clearFreezeAwareTimeout`（含尾随实参透传），三个基座文件回到
   上游原文的控制流与变量名，body 改动行 99 → 20。同一条复跑实验：`responsesAdapter.ts`
   对上游补丁的冲突 **1 → 0**（三文件均干净落下）。
4. **把 `unused-budget.json` 拆成「基座基线 + 阡陌增量」**，消除每次同步必然冲突的棘轮数字。
   **✅ P10.3③ 已落地（`14f8ead9`）**：基线文件回到基座 `3380c88` 的原数字且 `--update`
   永不写它，增量落 `scripts/unused-budget.qianmo.json`，有效预算 = 基线 + 增量。
5. **评估把 ACP 常驻会话逻辑收进 `@qianmo/resident`**——本次零冲突纯属侥幸（上游本区间没动
   ACP，但它是上游活跃演进面），`entry.ts` 只留挂载点这条路已被 +15/-0 的现状证明可行。
6. **P0.3 身份隔离是模范样板**：变化收拢进两个定义点、其余文件只换 helper 调用，而上游自己也在
   用同一批 helper（上游新增 33,355 行代码中 `BIN_NAME` 出现 55 次、硬编码字面量 0 次），于是
   上游每次演进自动落在派生层之下。建议成文规则：**改造基座前先找上游现成的间接层；有就在它
   下面派生，没有就先抽间接层**。
7. **跟随节奏建议每 2–4 周 / 每 5–8 个 release 一次**（回写章程 §5.7 的输入）——成本随攒积
   超线性增长，且上游 3 天 61 提交的活跃度很高。另：上游 v2.45.0 起把一方遥测改为显式
   opt-in，对常驻形态是明确想要的隐私改进，构成主动同步的业务理由。

## 6. 演练纪律确认

- 演练全程在一次性工作副本内进行，主检出未加 remote、未改动任何文件（事后由主 agent
  独立复核：主检出 remote 仅 origin、工作树干净）。**勘误（2026-08-15）**：原文「一次性 clone」「无上游对象」不准确——
  工作副本是本仓库的 git worktree（`.occ/worktrees/p74-upstream-sync`），与主检出共享对象库，`fetch` 的上游 tag 对象因此
  留在主检出 pack 中（约 1,800 个不可达提交，无 ref 指向，`git clone` 不带走）；这不影响任何演练结论，但意味着本机主检出上
  `848ad8c2` 可解析，举证须以 `3380c88` 为基线或用干净 clone（见 `BASE.md` 演练记录与 roadmap v2.35⑥(b)）
- 演练分支 `drill/p74-v2.46.0` 未提交、未推送到任何 remote
- 基座 pin 保持冻结在 v2.38.3；`BASE.md` 的演练记录条目由负责人决定是否及如何追加
  （CLAUDE.md §2.4），草稿已随评审材料提交

---

## 7. 真实同步的实记（P10.2，2026-08-17）—— 与演练预测逐项对照

演练之后、真做之前，M1 的 **P10.3** 先把演练点名的三条整改做掉（`CLAUDE.md`/`README.md`
携回基座原文、看门狗抽 `setTimeout` 同形注入点、`unused-budget.json` 拆基线+增量）。下表
是同一区间（`848ad8c2` → `1128a391`，v2.38.3 → v2.46.0）真做一次的实测，与 §3 的演练数字
并列：

| 项 | 演练（2026-08-15） | 真做（2026-08-17） | 说明 |
| --- | --- | --- | --- |
| 区间 | 61 提交 / 650 文件 / 1784 hunk | 同左（同一区间） | 目标 tag 未变，v2.46.0 仍是上游最新正式 release |
| **冲突** | **5 文件 / 7 块 / 0.39%** | **1 文件 / 1 块 / 0.06%** | P10.3 预先消掉 6 块，全部兑现 |
| 冲突明细 | `CLAUDE.md` 2、`README.md` 2、`unused-budget.json` 1、`responsesAdapter.ts` 1、`openaiStreamAdapter.ts` 1 | 只剩 `openaiStreamAdapter.ts` 1 | 前四项即 P10.3 ①②③ 的靶子 |
| 依赖漂移 | 零 | 零（`package.json` 只动版本号，`bun.lock` 未动，`bun install` 报 no changes） | 演练说「偶然，不能假设下次也如此」——这次仍然是零，但结论不变 |
| 合并后 typecheck | exit 0 | exit 0 | |
| 合并后单测 | 11311 全绿 | **11344 pass / 0 fail** | 3 条 `EROFS: mkdir '/mock'` 是执行环境沙箱所致，关沙箱重跑 8 pass —— 与演练同一现象 |
| 其余门禁 | 未跑 | `check:cycles` 443/2054 **恰在上游新预算上**（我方代码零环增量）、`check:identity-paths` 0 绕过、`check:mock-hygiene` 全零、`check:prompt-purity` 在预算、`biome ci` exit 0、`build:vite` + `check:bundle` 通过、双入口 `--version` 均报 2.46.0 | `check:unused` 按设计跳闸后重新测量（见 roadmap v2.45） |
| 工时 | 估 10–20 h（中位 ~14 h） | **约 1.5 h**（主 agent 组织 + 2 个子代理并行审计 + 1 个子代理归因，含全部门禁与文档回写） | 估算是**人**的工时、且假定 7 块冲突里 4 块要负责人与安全 owner 决策；本次冲突降到 1 块、决策项归零，加上并行审计，因此不具可比性——**不要拿它去修正演练的工时模型** |

### 7.1 演练没预测到、真做时才出现的六件事

1. **上游新增文件会带进新的身份路径硬编码。**`src/utils/plugins/eval/discovery.ts`（v2.46.0
   新增）把 `.occ` / `.claude` 直接写进 `SKIP_DIRS`，被 `check:identity-paths` 抓到并改成从
   `paths.ts` 派生。演练只跑了 typecheck 与单测，没跑这道棘轮，所以看不见这类问题。
   **结论：同步后的门禁必须跑全套棘轮，不能只跑 typecheck + test。**
2. **`check:unused` 会按设计跳闸。**P10.3③ 的拆分让上游补丁把基线文件改成上游自己的新数字，
   而我方树上量出的实际值与之有差，双向棘轮因此在同步后第一次运行时必然 fail —— 这是**要的**
   行为（强制重新测量，而不是让合并把数字悄悄吸收）。
3. **两侧可能撞同一个修。**`throttleAndCircuitBreaker.test.ts` 上我方与上游各加了一次
   `setSkillLearningConfigForTest`，自动合并成两条连续调用。有效配置逐字相同，撤回我方 10 行后
   该文件回到与上游逐字节一致——**这是同步该收的红利：携带增量减少，不是增加。**
4. **成果边界的度量基线会失效。**上游 6 万行进入本仓库历史后，`git diff 3380c88..HEAD` 不再
   等于阡陌工作面。处理办法是为当前基座树打一个无父提交的零改动快照标签
   `base-snapshot/v2.46.0`（章程 §5.5 v2.13 条、`BASE.md`）。**这条是演练完全没有触及的面，
   却是这几件事里后果最重的一件**——它直接关系软著与竞赛的成果认定。

5. **pin 不只写在 `BASE.md` 里，回写会漏。**（2026-08-28 补记）同步把 pin 迁到 `1128a391`
   之后，`BASE.md` 与章程 §5.5 都跟进了，但**对外面的三处 pin 陈述没有**：`NOTICE` 中文
   「二、基座溯源」块、`NOTICE` 英文 section 2 块、`README.md` 基座说明段。于是溯源声明与
   溯源真源各说一个版本，`README.md` 更是同一页里第 20 行说「锁定 v2.38.3」、第 22 行说
   「v2.38.3 → v2.46.0 的首次同步」。十一天后做开源就绪时才发现（`license-chain-m0.md` D-7）。
   **结论：同步后的回写清单必须包含 `BASE.md` 之外的这三处**——它们不在任何门禁的视野里，
   `check:*` 全绿也不会提示。写法用「导入 pin（历史锚点）/ 当前锁定」两行并列，
   不要只改数字：单写一个 pin 就是这次失准的成因。

6. **版权头门禁的快照 pin 也要回写。**同步后更新 `scripts/check-license-headers.ts` 的期望快照标签常量，
   与 `BASE.md` 的当前锁定一致；漏改会让门禁用旧快照把上游新文件判成阡陌自有并变红，不会静默错。

### 7.2 被真做验证的两条设计判断

- **P10.3① 的「反直觉形态」是对的。**演练建议「改薄成指针」，实际落地成「阡陌增量在前、基座原文
  逐字附在后」。真做时两文件的基座原文部分**自动升级为 v2.46.0 版本、零冲突**，且阡陌部分一字
  未动（实测 `diff <(git show 1128a391:CLAUDE.md) <(tail -n 171 CLAUDE.md)` 为空）。
- **§5⑥ 的「在上游现成的间接层之下派生」是对的。**上游本次把 `responsesAdapter.ts` 的空闲超时
  错误从 `{ retryable: !retryWindowClosed() }` 改成 `{ retryable: true, ...(replayable) }` 的
  二维拆分——**改的正是回调体内部**，而 P10.3② 之后我方改的是回调外面那个标识符，两者天然不
  相交，于是演练里唯一的代码语义冲突这次一声不响地过去了。

## 8. 2026-08-26：本仓库删除了 134 个基座文件，冲突画像随之改变

PR #114 删掉了英日文档树（`docs/en/**`、`docs/ja/**` 各 64 页）、
`CHANGELOG.en.md` / `CHANGELOG.ja.md`，以及基座发布面的四个脚本
（`scripts/release.ts`、`releaseCore.ts`、`changelog-section.ts` 及其测试）。

**这一条直接推翻了 §3.1 的一项前提。**那里逐项验证过「**我方删/上游改 = 0**」，
所以 P10.2 那次真实同步从未处理过这个冲突类型。现在它一次性有了 134 条路径。
叠加 §3.3「冲突的大头不是代码，是文档」（7 个冲突块里 4 个出自文档），
**下一次同步在文档面上的表现会与前两次都不一样**。

### 下次同步遇到这些路径时怎么办

`git apply --3way` 对「目标文件已不存在」的 hunk 不会静默跳过，它会失败并要求处理。
处置规则**只有一条，别临时判断**：

> **本仓库已删除的路径，保持删除。**上游对它们的任何改动一律不接。

具体做法是在应用前先把这些路径从上游 diff 里剔掉：

```sh
git diff <旧 tag>..<新 tag> -- . \
  ':(exclude)docs/en' ':(exclude)docs/ja' \
  ':(exclude)CHANGELOG.en.md' ':(exclude)CHANGELOG.ja.md' \
  ':(exclude)scripts/release.ts' ':(exclude)scripts/releaseCore.ts' \
  ':(exclude)scripts/changelog-section.ts' \
  ':(exclude)scripts/__tests__/releaseCore.test.ts' \
  > /tmp/upstream.patch
```

**这张排除表要跟着删除动作走。**再删基座文件时，同一个 PR 里就把路径补进这里 ——
否则下一次同步的人只会看到一屏「apply 失败」，而看不出哪些是故意的。

### 不受影响的两件事

- **成果边界照旧可举证。**§2.5 禁的是 rebase 掉导入提交、squash 跨越它、强推、
  删 `base-snapshot/*` 标签。删文件是普通提交，标签与历史都在，
  `git diff base-snapshot/v2.46.0..HEAD` 仍然成立 —— 只是现在也会列出删除。
- **`BASE.md` 不动。**它只记「导入」与「上游同步」两类事件（CLAUDE.md §2.4），
  精简不是其中之一。

---

## 9. 2026-08-29：`LICENSE` 变成了本仓库自己的文件（转 AGPL 的同步面后果）

章程 v2.16 把阡陌自有代码改以 **AGPL-3.0-or-later** 发布，做法是
`git mv LICENSE LICENSE.base` + 把 AGPL-3.0 正文写进 `LICENSE`。
这对上游同步只有一条影响，但它是**新的冲突类型**：

> **`LICENSE` 从此是本仓库自己的文件，上游对它的任何改动一律不接。
> 上游 `LICENSE` 的改动应当落到 `LICENSE.base`。**

因为上游那份文件的路径没变（还是 `LICENSE`），所以上游一旦改动它，
`git apply --3way` 会把 AGPL 正文当成"我方对 MIT 正文的本地修改"来三方合并 ——
**那会得到一份两种许可搅在一起的文件，而且大概率能干净应用、不报冲突**。
这是本节存在的全部理由：它不像 §8 那类"文件已删所以 apply 失败"，
它是**会静默成功的错误**。

### 做法

同步前把 `LICENSE` 从上游 diff 里剔掉，与 §8 的排除表并列：

```sh
git diff <旧 tag>..<新 tag> -- . \
  ':(exclude)LICENSE' \
  ':(exclude)docs/en' ':(exclude)docs/ja' \
  … # §8 的其余排除项
  > /tmp/upstream.patch
```

然后**单独看一眼上游 `LICENSE` 变没变**：

```sh
git diff <旧 tag>..<新 tag> -- LICENSE
```

- 没变（常态）—— 什么都不用做，`LICENSE.base` 保持原样。
- 变了 —— 把上游那份**手工写进 `LICENSE.base`**，并在 `BASE.md` 的同步记录里
  单独记一句"上游许可正文有变更"。**不要动 `LICENSE`。**

### 一条可以直接跑的自检

同步收尾时验一次 `LICENSE.base` 仍与基座快照一致：

```sh
git show base-snapshot/<当前 tag>:LICENSE | diff - LICENSE.base && echo "LICENSE.base OK"
```

（换 pin 之后判据里的 tag 跟着换；上游许可正文若真的变过，
这条自检应当对**新**快照成立，而不是对旧的。）

### 不受影响的

- **SPDX 文件头不会与上游冲突。**基座文件一个都不带 SPDX 头，
  阡陌文件上游根本没有 —— 两层在源文件上零重叠，这也正是转 AGPL 选这条边界的原因。
