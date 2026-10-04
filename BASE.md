# 基座溯源

- 基座：open-claude-code（CLI 名 `occ`）
- 上游仓库：https://github.com/sweetcornna/open-claude-code
- 导入来源：上游仓库的本地副本 /Users/cornna/project/open-claude-code 的已提交快照（导入当时使用的本地克隆，非权威地址；权威地址为上一行的上游仓库 URL）
- 基座提交（**当前 pin**）：1128a3919a7f01298a6cbf5c468a839c6cf4ee6a（chore(release): v2.46.0）—— 2026-08-17 由 P10.2 首次真实同步从 v2.38.3 迁移，见下方「上游同步记录」
- 基座版本：v2.46.0 · 许可：MIT（见根目录 LICENSE）
- **导入 pin（历史，不随同步变化）**：848ad8c2c8daca9f5aa2410da555553e07700f5d（chore(release): v2.38.3）—— 零改动快照导入时的上游提交，`docs/dev/license-chain-m0.md` 的 npm 侧佐证锚在它上面
- npm 侧佐证（实查 2026-08-15）：npm 包 `@sweetcornna/open-claude-code` 的 `repository.url` = `git+https://github.com/sweetcornna/open-claude-code.git`；v2.38.3 的 `gitHead` = `848ad8c2c8daca9f5aa2410da555553e07700f5d`，与上方 pin 逐字一致。证据件明细见 docs/dev/license-chain-m0.md §2（E-3 / E-4 / E-9）
- 导入方式：`git archive` 零改动快照；本文件所在提交即导入提交，自该提交起 atlas 树上的一切差异均为阡陌自有改动
- 上游同步：暂定人工比对基座新版本后选择性同步，策略详见 docs/dev/base-adoption.md

## 上游同步演练记录

M0 期间基座 pin 冻结在 v2.38.3、不跟随上游发版（章程 N-13）。本节记录的是**演练**，不是实际同步；演练不改变 pin、不产生代码合入。

### 2026-08-15 · 目标 v2.46.0 · 演练，未合入

- 目标 tag：v2.46.0（`1128a3919a7f01298a6cbf5c468a839c6cf4ee6a`），当时上游最新正式 release
- 方法：一次性 clone 内做**三方应用**（`git diff v2.38.3 v2.46.0` → `git apply --3way`），不是 merge；主检出未加 remote，演练分支未提交、未推送。**勘误（2026-08-15，主 agent 复核）**：演练实际在本仓库的一个 git worktree（`.occ/worktrees/p74-upstream-sync`）内 fetch 上游 tag，worktree 与主检出**共享对象库**，因此上游历史对象（含 `848ad8c2` 及其 1,391 个祖先，共约 1,800 个不可达提交）进入了主检出的 pack——它们**不在任何 ref 上**，`git clone` 不会带走，干净 clone 中 `848ad8c2` 仍不可解析；但本机主检出上 `git diff 848ad8c2..HEAD` 会「跑得通」且给出另一组数字，答辩/举证一律用干净 clone 或以 `3380c88` 为基线
- 结果摘要：区间 61 提交 / 650 文件；冲突 **5 文件 7 块 = 1784 个上游 hunk 的 0.39%**；合并后 `bun run typecheck` exit 0、`bun test` **11311 条全绿**；跟随一次的工时估算 **10–20 h**（中位约 14 h）
- 详见：docs/dev/upstream-sync-drill.md（含冲突清单、按族统计与五条行动项）
- 执行：实施方执行，负责人授权本条记录写入（章程 §2.4「BASE.md 由负责人维护」的记录事件）
- **pin 不变**（仍为 848ad8c2 = v2.38.3）；**零改动快照声明不变**

## 上游同步记录

M0 已收口（roadmap v2.42），章程 N-13「M0 期间不跟随上游发版」随之失效；M1 起按章程 §5.7 定稿的节奏（每 2–4 周 / 每 5–8 个 release）跟随。本节记录的是**真实合入**，会改变 pin。

### 2026-08-17 · v2.38.3 → v2.46.0 · 已合入（P10.2 首次真实同步）

- 目标 tag：v2.46.0（`1128a3919a7f01298a6cbf5c468a839c6cf4ee6a`），实查仍是上游最新正式 release（GitHub releases 列表，2026-08-14T08:37:54Z 发布，其后无新 release）
- 区间：`848ad8c2..1128a391` = **61 提交 / 10 个 release 提交（v2.39.0 ~ v2.46.0）/ 650 文件 / 1784 hunk / +60,363 −7,417**
- 方法：`git diff --binary 848ad8c2 1128a391 | git apply --3way`（不是 merge——本仓库不含上游历史，`git merge` 会判 unrelated histories）。上游对象来自 P7.4 演练时进入本机对象库的那批（见上一节的勘误），本次未新增 remote、未 fetch
- **冲突：1 文件 / 1 块 = 1784 个上游 hunk 的 0.06%**（演练同区间为 5 文件 / 7 块 / 0.39%）。差额由 M1 的 P10.3 减冲突整改预先消掉：`CLAUDE.md` 2 块、`README.md` 2 块、`scripts/unused-budget.json` 1 块、`src/services/api/openai/responsesAdapter.ts` 1 块，共 6 块，全部实测归零
- 唯一冲突：`packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts`（上游 +24/−1 加 `sawOutput`，我方 +16/−1 加 qwen 空 reasoning 守卫），两侧语义正交、取并集，见提交 `3476dd93`
- 依赖漂移：**零**。上游对 `package.json` 的唯一改动是版本号（2.38.3 → 2.46.0），`bun.lock` 未动，`bun install` 报 no changes
- 提交切分（为守成果边界举证，章程 §5.5 / L-1）：`d04a79dd` 的**改动内容全部来自上游补丁**——649 个文件由 `git apply --3way` 自动合并落下、零人工判断，唯一冲突文件在该提交里取上游侧逐字原文；阡陌的判断从下一个提交起才出现。举证时把 `d04a79dd` 这一笔从工作面里排除（`git diff 3380c88..HEAD` 会把上游这 6 万行算进来，**同步之后不能再直接用它当工作面**——正确口径见下一条）
- **同步后的成果边界口径**（重要，与章程 §5.5 v2.13 条配套）：`git diff 3380c88..HEAD` **不再等于**阡陌工作面（会把上游 6 万行算进来，实测虚报成 1,111 文件 / +173,478 行）。改用为当前基座树打的**零改动快照标签**：
  - 阡陌工作面：`git diff base-snapshot/v2.46.0..HEAD` —— 实测 2026-08-17：**509 文件 / +113,674 / −310**
  - 当前基座边界：`git show --stat base-snapshot/v2.46.0`
  - 工作记录：仍是 `git log 3380c88..HEAD`，但须声明其中 `d04a79dd` 一笔的内容全部来自上游
  - 该标签指向提交 `972b01d86436254e1e9766ba82d713538cd05bc3`：**无父提交**、树与上游 `1128a391` 逐字节一致（`git diff base-snapshot/v2.46.0 1128a391` 为空），**不引入上游 git 历史**——与导入提交 `3380c88` 同一原则
  - **导入提交 `3380c88` 的地位不变**：仍是「阡陌工作从哪里开始」的历史起点，只是不再兼任「基座内容有多少」的度量基线。此后每次同步照打一个 `base-snapshot/<版本>`
- 合并后验证：见 docs/dev/roadmap.md v2.45 与 docs/dev/upstream-sync-drill.md §7
- 执行：实施方执行，负责人授权（章程 §2.4 的「上游同步」记录事件）
