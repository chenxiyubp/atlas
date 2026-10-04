<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — SPDX 文件头补齐与证据命令勘误复盘（PR #132）

| 项 | 内容 |
| --- | --- |
| 文档版本 | **v1.0** |
| 撰写日期 | 2026-08-30 |
| 对象 | PR #132「补齐 SPDX 文件头，并清掉判据与举证链上五条『自称可复现却在陈述假事』的命令」。分支 `chore/spdx-headers-qianmo`，**12 笔提交 / 73 个文件**，基点 `aea019d8`，合入于 `dcde53d8`（2026-08-30） |
| 排期出处 | [`roadmap.md`](./roadmap.md) v2.70。**本文是那一行的正文**；表里只留一句话、一个指针和留给负责人的开放项 |
| 许可计数出处 | 根 `NOTICE` 一、许可。**本文不复制那里的任何计数**，只给指针 |
| 权威归属判据 | `CLAUDE.md` §2.5 ——「文件在不在 `base-snapshot/v2.46.0` 那棵零改动快照里」，快照之外 = 阡陌自有 |
| 性质 | 复盘记录。不是范围依据（那是 [`charter.md`](./charter.md)），也不是排期依据（那是 [`roadmap.md`](./roadmap.md)） |

**变更记录**

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v1.0 | 2026-08-30 | 初稿。由 roadmap v2.70 那一行拆出并重组 —— **拆分前该行 20,174 字节 / 10,811 字符**，是次长版本行（8,878 字节）的 2.3 倍、71 个版本行均值（2,959 字节）的 6.8 倍；**拆分后 1,346 字节**，行数与该行的裸竖线数均未变（927 行、4 根）。同时补入三项此前只活在会话工件里的内容：五条坏命令的来源归因（**本文按可检验判据重算，结论与原归因不同**，见 §4.7）、缺陷形态的计数（§5）、建全仓棘轮者必看的两个坑（§6） |

**本文性质**

1. **本文写出的每条命令、每个数字、每个提交 SHA、每个行号，都在 2026-08-30 于主检出实跑核对过。**凡未验证的一律就地标注。这条不是客套：本批十轮审查里挑出了五条「看起来完全合理、一跑就是假的」命令，而 roadmap v2.70 那一行正是其中第五条藏过九轮逐句审查的地方。
2. **本文不复制 `NOTICE` 一、许可的那套许可计数。**要具体数字就去那里读，它给的是现跑现算的命令。止住这种复制正是本文存在的理由之一（`CLAUDE.md` §1.1⑧「指针不复制」）。
3. **本文里的数没有一个是不变量，所以凡是给绝对数的地方，命令一律锚到提交上。**判据值随文件增删而变，行号随被引文件而变。**本文件自己就是最好的例子，而且它同时踩中两套口径**：它带阡陌文件头（进「前 5 行窗口」那一套），正文里又逐字记述这条判据（进「全文匹配」那一套）——所以本文一入库，两个数**一起**从 646 / 650 变成 **647 / 651**（2026-08-30 实测：写作时未 `git add`，`git grep` 读 646 / 650，`git grep --untracked` 读 647 / 651）。两个数的差此刻是 **4**，且本文入库不改变它（本文同时进两套集合）—— 但**那个 4 也不是不变量**，什么会让它变、为什么，见 §6.1。**这一格的初稿只写了「646 → 647」、漏了全文匹配那一半**，是复核时被指出来的 —— 同一个形态又来了一次。
4. 命令均为 bash/zsh 写法（含 `<(...)` 进程替换），在**仓库根**执行。§4.4 说明了「在仓库根之外执行」会怎样悄悄给出另一个答案。

---

## 0. 一句话

`NOTICE` 立的双许可机器判据在当时**不成立**：66 个阡陌自有文件漏了那两行头，按判据会被读成基座 MIT 层。补完之后顺着证据链往下核，又清掉五条自称可复现、实际在稳定陈述假事的命令。判据值 **580 → 646**（锚定补头提交 `c9c74627`；这个数随仓库增删带头文件而变，命令与锚法见 §1.1）。

真正值得留下来的不是补头本身（那是机械劳动），是**两条被自己的证据推翻的原判断**（§2.2、§2.3）、**五条坏命令的来源**（§4）和**一个反复出现的缺陷形态**（§5）。

## 1. 补头本身

### 1.1 范围怎么定的

**不能用文件头自己定范围** —— 那是循环论证：漏加头的文件恰恰就是判据看不见的那一批。用的是 `CLAUDE.md` §2.5 的权威判据「在不在 `base-snapshot/v2.46.0` 里」。

补头落在提交 `c9c74627`（2026-08-30，`chore(license): 给 66 个阡陌自有文件补上 SPDX 文件头`），66 个文件：

```
git show --name-only --format='' c9c74627 | grep -c .              # 66
git show --name-only --format='' c9c74627 | grep . \
  | cut -d/ -f1 | sort | uniq -c | sort -rn
# 24 docs / 18 src / 16 demo / 5 scripts / 2 tests / 1 packages
```

判据值。**这里给的是锚到提交的写法，不是工作区写法** —— 理由见「本文性质」第 3 条：不锚的话，这个数每增删一个带头文件就变，写进文档的那一刻就开始过期（`git grep <rev>` 会在每行前多一段 rev，所以字段号要从 `$2`/`-f1` 挪到 `$3`/`-f2`）：

```
# 补头之后
git grep -n "SPDX-License-Identifier: AGPL-3.0-or-later" c9c74627 \
  | awk -F: '$3<=5' | cut -d: -f2 | sort -u | wc -l                 # 646
# 补头之前（同一条，锚到父提交）
git grep -n "SPDX-License-Identifier: AGPL-3.0-or-later" c9c74627^ \
  | awk -F: '$3<=5' | cut -d: -f2 | sort -u | wc -l                 # 580
```

对应的工作区写法是 `git grep -n <pat> | awk -F: '$2<=5' | cut -d: -f1 | sort -u | wc -l` —— 它答的是「**此刻**的树是多少」，不是 646，**引用它必须现跑现算**。

漏加的不是边角料：`src/constants/identity.ts` 就在里面 —— 那是 `CLAUDE.md` §2.3 点名的**身份 roster 唯一真源**。

### 1.2 为什么是 66 不是 67

`BASE.md` 同样在快照之外、同样缺头（`grep -c "SPDX-License-Identifier" BASE.md` = 0，`git cat-file -e base-snapshot/v2.46.0:BASE.md` 报 `exists on disk, but not in ...`），但 `CLAUDE.md` §2.4 写死「只有导入与上游同步两类事件才写它，功能 PR 里顺手改一律回退」，故**有意跳过**。

这一格后来自己长出了一条坏命令，见 §4.3。

### 1.3 三个 shebang 文件的头落在第 3 行

`demo/ac1-restart.sh`、`demo/ac2-wake-forward.sh`、`scripts/check-macro-guards.ts` 的两行头加在 shebang **之后**，于是 SPDX 落第 3 行 —— 仍在判据的「前 5 行」窗口内。复核（66 个里 SPDX 不在第 2 行的恰好只有这三个）：

```
git show --name-only --format='' c9c74627 | grep . | while read f; do
  n=$(grep -n "SPDX-License-Identifier: AGPL-3.0-or-later" "$f" | head -1 | cut -d: -f1)
  [ "$n" != "2" ] && echo "$f -> line $n"
done
```

> 这一条与 §6 的棘轮设计直接相关：`packages/activator` 那道现成范式判的是「**恰好**第 1–2 行」，而 `NOTICE` 的口径是「前 5 行内」。两套判据在这三个文件上分叉。

## 2. 根因

### 2.1 成文决定：不为版权头新增 CI 断言

漏加不是手滑，是一条**已经过期的成文决定**。章程 §5.5（v2.5，2026-08-12）原文：

> 格式为文件最前两行行注释 `// Copyright 2026 Qianmo AgentNest Team` + `// SPDX-License-Identifier: MIT` …… **已于 P0.5 落地，覆盖 `protocol` / `registry` 两包 `src/` 与 `test/` 共 15 个 `.ts` 文件**；此后新增的 `@qianmo/*` 源文件一律带头，**不为此新增 CI 断言**（漏加由 PR 评审兜）。

那条决定作出时覆盖 **15** 个文件；今天判据覆盖 **646** 个、横跨整个仓库，约 **43 倍**（646 ÷ 15 = 43.07）。「由 PR 评审兜」这一道这次一口气漏了 66 个。**漏加不是偶发，是那条决定在覆盖面涨了 40 多倍之后失效了。**

### 2.2 被推翻的原判断①：「仓库里根本没有版权头门禁」

这句是本批的原始根因叙事，**它是假的**，第七轮审查证伪。

仓库里有一道版权头门禁，只是只盖了一个包：`packages/activator/test/surface-invariant.test.ts` 第 209 行的

```
test('every source file carries the two-line copyright header', () => { ... })
```

逐字断言 `// Copyright 2026 Qianmo AgentNest Team` 与 `// SPDX-License-Identifier: AGPL-3.0-or-later` 两行。它随 `6f30c45c`（2026-08-12，`feat(activator): 新建 @qianmo/activator`）**建包时即加**，比本次漏加事件（`c9c74627`，2026-08-30）早 **18 天**。

接线齐全，逐条实跑核过：

| 接线 | 证据 |
| --- | --- |
| 普通单测，本地 `precheck` 覆盖 | `package.json:76` 的 `precheck` 以 `bun test` 结尾 |
| 分片脚本收得到 | `scripts/test-shards.sh:84` 的 `for d in src/* packages/* …` |
| `verify` 与 CI 都跑那个脚本 | `package.json:77` 的 `verify` 含 `./scripts/test-shards.sh`；`.github/workflows/ci.yml:111` 是 `run: ./scripts/test-shards.sh --coverage` |
| 不是死代码 | `bun test packages/activator/test/surface-invariant.test.ts` → **27 pass / 0 fail** |

**而它给出的证据方向是反的**：

```
git show --name-only --format='' c9c74627 -- packages/activator   # 无输出
```

补头的 66 个文件里 `packages/activator/` 一个都没有 —— **唯一被门禁盖住的目录，恰恰是零漏加的那个**。这不是「门禁形同虚设」的例子，是门禁有效的例子。

**但这条证据只能说到这里。**66 个按顶层目录分是 `docs` 24 / `src` 18 / `demo` 16 / `scripts` 5 / `tests` 2 / `packages` 1，落在 `packages/` 的那 1 个是 `packages/console/README.md`（连 `.ts` 都不是）。整棵 `packages/` 树本来就几乎没漏，所以「被盖住的目录干净」**单独并不能**把门禁的功劳与「包目录本来就整齐」分开。它坐实的只是：**这道门禁接线齐全、断言与接线都现成**（这一点撑起 §7 的开放项），而不是「没有门禁可抄」。

**原盘点逐条属实，但它漏看了 `bun test`。**实测 `package.json` 的 11 条 `check` / `check:*`（`check` / `:fix` / `:bundle` / `:unused` / `:unused:raw` / `:docs-i18n` / `:cycles` / `:prompt-purity` / `:mock-hygiene` / `:macro-guards` / `:identity-paths`）确实没有一条查版权头，`scripts/check-*.ts` 里 SPDX 也确实只出现在脚本自己的文件头里。**但门禁不只有 `check:*`，单测本身就是门禁的一部分** —— 只数 `check:*` 就会把这仓库里唯一存在的那道数漏。

**这是本批的第二处教训：盘点口径不全，比盘点结论写错更难被发现。**它与 §3 的行号失准、与 §4 里那几条命令同型。

> **另注一处巧合**：`6f30c45c` 与章程 v2.5 同为 **2026-08-12**。写下「不为此新增 CI 断言」的同一天，实践就在当天新建的那个包里自发加了一道，只是从没有人把它推到全仓。

### 2.3 被推翻的原判断②：「那道门禁跑了半个多月」

改完 §2.2 之后，为了论证「设全仓棘轮不必从零建」，正文写了那道测试「一直在门禁里跑」「已经在 CI 里跑了半个多月」。**这句被本表自己的 v2.63 推翻**，第八轮审查抓到。

**CI 上的真实执行有窗口，不是「一直在跑」。**实测（`gh run list --workflow=ci.yml`，全部 175 条 run 按日期与结论分组）：

| 日期 | 执行情况 |
| --- | --- |
| 08-14 ~ 08-17 | 有 run 且有绿的（抽查 `31801769324` / `31941752229` / `32050180684`：`ci` 18 步、`windows` 9 步，真 runner） |
| 08-18 ~ 08-20 | **一条 run 都没有** |
| 08-21 ~ 08-28 | 共 106 条，**全部 failure**，抽查 `33202671535` / `32587395530` / `32456490494` 每个 job 都是 `steps: 0` —— Actions 配额耗尽、没有 runner 接单的签名（roadmap v2.63 已记这段「没人看见过它的结论」） |
| 08-29 ~ 08-30 | 有 run 且绿（`33264333632`：`ci` 22 步、`windows` 9 步） |

复核方式：

```
gh run list --workflow=ci.yml --limit 400 --json createdAt,conclusion   # 按日期分组
gh run view <id> --json jobs                                            # 看每个 job 的 steps 数
```

**把「接线在 CI 配置里存在了 18 天」写成了「在 CI 里跑了 18 天」。**这段空档里盖住它的是本地 `precheck` / `bun test`，不是 CI。

§7 开放项的结论不依赖这一条 —— 它靠的是「断言逻辑与接线已经写好、可以直接复制」，不靠跑了多久。

## 3. 连带伤害：行号引用的连锁位移

### 3.1 本批修正的 17 个记号

被引用文件各多 3 行（两行头 + 一行空行），于是指向它们的行号引用整体下移。同批修正 **17 个**行号记号，分布在 **12 行**、**4 份**文档（`base-adoption.md` / `base-modifications.md` / `resident-botization.md` / `roadmap.md`）。

**计数口径写在这里，好让读者数出同一个数**：`文件名:行号` 形式的**主引用**记 **13** 个；紧随其后省略文件名的**续引裸 `:N`**（如「`roadmap.md:379`，交付物在 `:378`」里的那个 `:378`）另记 **4** 个；一行里出现几个记几个，`:57-77` 这样的区间算一个记号，同一记号在不同行重复出现分别计数。13 + 4 = 17。

复核（`c9c74627` 在这四份文档上是 `+4/−1`、`+4/−1`、`+10/−7`、`+6/−3`，各减去 3 行文件头即得 1 + 1 + 7 + 3 = 12 行）：

```
git show --numstat --format='' c9c74627 -- \
  docs/dev/base-adoption.md docs/dev/base-modifications.md \
  docs/dev/resident-botization.md docs/dev/roadmap.md
git show c9c74627 -- docs/dev/base-adoption.md docs/dev/base-modifications.md \
  docs/dev/resident-botization.md docs/dev/roadmap.md
# 逐对变动行比对 :N 记号的增删
```

### 3.2 另有 8 个补头之前就已失准

判法：**若原引用本来准确，位移应恰好 +3**。逐对相减，偏差不为 0 的就是原本已失准的：

| 旧值 → 新值 | 实际位移 | 偏差 |
| --- | --- | --- |
| `charter.md:174` → `:180` | +6 | 3 |
| `charter.md:166` → `:172` | +6 | 3 |
| `roadmap.md:833` → `:852` | +19 | 16 |
| `roadmap.md:836` → `:855` | +19 | 16 |
| `roadmap.md:345` → `:378`（后被 §3.4 再推 1 行） | +33 | 30 |
| `roadmap.md:344` → `:377`（同上） | +33 | 30 |
| `protocol.md:311` → `:378` | +67 | 64 |
| `protocol.md:594` → `:693` | +99 | 96 |

**偏差最大的一对**是 `protocol.md` 的 `:311`·`:594`（D-2 判环粒度论证）。真值经 `sed` 逐个核过：第 378 行是「**为什么不是节点粒度**：节点粒度会误杀合法 spiral……（D-2）」，第 693 行是那条「同一节点的两个 agent 可以登记不同的公钥」的已闭合缺口记录。

**指错对象最明显的一对**是 `base-adoption.md` 里指向 P0.2 交付物 / DoD 的 `roadmap.md:344`·`:345`（各偏 30）—— 偏得不是最多，但它当时实际指着的是排期表的 S5/S6 两行，**连表都指错了**；而那两个数看上去正好像是「交付物在前一行、DoD 在后一行」，读的人不跳过去核根本看不出来。

### 3.3 第三、四轮又挖出 15 个，而且反推法结构上抓不到

| 簇 | 数量与分布 | 旧 → 新 | 偏差 |
| --- | --- | --- | --- |
| `src/services/qianmo/resident.ts` | 2 处（`resident-botization.md`） | `:386` → `:873` | 487 |
| `packages/transport/src/frames.ts` | 8 处（`resident-botization.md` 4、`roadmap.md` 2、`key-distribution.md` 2） | `:169` → `:318` | 149 |
| `docs/dev/key-distribution.md` | 5 处（全在 `resident-botization.md`） | `:536-539` ×3 与 `:532-543` → `:717-720`；`:543` → `:724` | — |

真值逐个 `sed` 核过：`resident.ts:873` 是 `message.type === MessageType.TaskRequest` / `? this.#registerTask(...)`；`frames.ts:318` 是 `if (parsed['v'] !== FRAME_VERSION) return null`；`key-distribution.md:717-720` 是 P12.1 ~ P12.4 四行落地包，`:724` 是那条「`FRAME_VERSION` 严格相等、迁移只能在 v1 之内做」的约束。

那 5 处 `key-distribution.md` 引用**原本指着 §10.1「控制台展示」那张表**，而它们声称指的是 §13 的 P12.x 落地包编号与 `frames.ts` 的版本相等约束 —— **连节都指错了**，与 §3.2 那对 `roadmap.md:344`·`:345` 同型。

**这 15 个用 §3.2 那套反推法结构上就抓不到**：被引的三个文件都不在补头的 66 个里，行数根本没动，「若原本准确则应恰好位移 3 行」这个筛子从一开始就不会把它们放进候选。抓到它们靠的是拿每条引用去比源文件的实际内容 —— 那是人工核对，不是可复现判据。

第五轮另抓到第四簇：`key-distribution.md` 里 3 处 `frames.ts:71`（第 71 行是 `readonly v: typeof FRAME_VERSION`），真值是 `frames.ts:79-92`（`AuthFrame.node` 的注释块在 79–91、字段在 92）。现全仓零残留。

**所以 17、8、15 这三个数只说明本批查了多少，不说明还剩多少。**仓库里还有多少失准引用，本 PR 答不了 —— 这正是 §7 开放项在行号这一面的同型缺口。

### 3.4 本条自己又演示了一遍

往版本表里新增 v2.70 那一行，使 `roadmap.md` 该行以下全部下移 1 行，于是刚改准的四个引用又差了 1：`base-adoption.md` 里「roadmap P0.2 的 DoD 共**五项**」那句的 `roadmap.md:378`·`:377` 应为 `:379`·`:378`；`resident-botization.md` 里「(b) M1 方向表两行补注」那条的 `roadmap.md:852`·`:855` 应为 `:853`·`:856`。四处已一并改到真值（等长替换，不改行数，不再引发新的连锁）。

> **这两处这里故意用内容锚而不是行号锚**（原记录写的是 `base-adoption.md:390` 与 `resident-botization.md:812`）。理由就在本节标题里：那两份文档正被别的批次改着，写死行号等于当场再造一个失准引用。**能用唯一的内容串定位就别写行号** —— 这是行号引用这一面唯一不用建门禁就能拿到的收益。

现值核过：

```
sed -n '378p;379p' docs/dev/roadmap.md     # 交付物 / DoD 两行
sed -n '853p;856p' docs/dev/roadmap.md     # M1 方向表「记忆能力上线」/「第二产品线验证」
```

**任何往那张表加行的批次都会重犯这一条。**本文替换 v2.70 那一行时也因此把「行数不变」当成硬不变式 —— 它是表格里的单行，替换内容不改行数。

## 4. 五条坏命令

「坏命令」的定义：**文件里自称可复现的证据命令，照抄跑下去却稳定地陈述一件假事。**十轮审查逐条挖出五条，第五条到第十轮才现形。

### 4.1 第一条 · `NOTICE` 的反例核对命令缺 `-c core.quotePath=false`

- **是什么**：「有没有人把 AGPL 头误贴到基座文件上」的反例检查，原文写 `git grep -l "SPDX…" -- . | while … head -5 "$f" …`。
- **错在哪**：默认 `git ls-files` / `git grep -l` 把非 ASCII 文件名输出成带双引号的八进制转义串，那种名字喂给 `head` 读不到文件，被静默跳过而少算。本仓库现有 **33** 个非 ASCII 文件名（`git -c core.quotePath=false ls-files | LC_ALL=C grep -c '[^ -~]'`）。而**同一份 `NOTICE` 在 13 行之前刚说过这个开关不能省**（`a3d3c595:NOTICE` 第 53 行是那句话，第 66 行是缺开关的命令）。
- **怎么修的**：`4822e771` 给两处（中英双版）补上开关，并就地写明理由。
- **发现于**：第一轮无上下文复核。
- **一条不能省的限定**（本文自己实测后加的）：今天那 33 个非 ASCII 路径**全是二进制资产**（27 `.jpg` / 2 `.png` / 2 `.pdf` / 2 `.docx`），它们本来就不会被 `git grep -l "SPDX…"` 列出来，所以这条修正**在今天不改变那条反例检查的实际输出**，它挡的是「将来出现一个中文名的文本文件、又误贴了 AGPL 头」。`git grep -l` 确实会转义路径这一点是实测的：`git grep -al $'\xff' -- 'docs/assets/brand/封面.jpg'` 输出 `"docs/assets/brand/\345\260\201\351\235\242.jpg"`，加上 `-c core.quotePath=false` 才是原名。

### 4.2 第二条 · `--diff-filter=M/D/A` 不是合法语法

- **是什么**：roadmap v2.70 里用来拆「改 / 删 / 增」三类的命令。
- **错在哪**：git 不接受 `/` 分隔的 change class。实跑：

  ```
  git diff --diff-filter=M/D/A --name-status base-snapshot/v2.46.0
  # error: unknown change class '/' in --diff-filter=M/D/A   (exit 129)
  ```

- **怎么修的**：`31999c1f` 换成 `git diff --name-status base-snapshot/v2.46.0 | cut -f1 | sort | uniq -c` —— 在仓库根实跑得 **733 A / 135 D / 180 M**，合计 1048，与 `git diff --shortstat base-snapshot/v2.46.0` 的文件数一致。
- **发现于**：第三轮。

### 4.3 第三条 · `scripts/sbom.ts` 的断言与它紧邻的复核命令互相打架

- **是什么**：块注释里断言「第三类（形态上带得了头却被漏掉的阡陌文件）当天由一批补头提交清零」，紧跟着给出复核命令。
- **错在哪**：那条命令实跑输出 `BASE.md`。根因是命令里的 `grep -E` 只挡形态类（`.json` / `.png` / `.lock`），挡不住「有意不加」类，而 `BASE.md` 是 `.md`，直接被扩展名过滤器放行。
- **怎么修的**：`bff3f098` 加 `| grep -vx 'BASE.md'` 一档并写明理由 —— 排除之后输出真的为空，是恢复真相不是掩盖遗漏；硬编码 `BASE.md` 之后，将来真出现别的漏加文件命令仍会抓出来。现跑现验：

  ```
  comm -23 <(git -c core.quotePath=false ls-files | sort) \
           <(git -c core.quotePath=false ls-tree -r --name-only base-snapshot/v2.46.0 | sort) \
    | grep -E '\.(ts|tsx|md|sh)$|(^|/)Makefile$' \
    | grep -vx 'BASE.md' \
    | while IFS= read -r f; do
        head -5 "$f" | grep -qa 'SPDX-License-Identifier: AGPL-3.0-or-later' || printf '%s\n' "$f"
      done
  # 无输出；去掉 `grep -vx 'BASE.md'` 那一档则输出 BASE.md
  ```

- **发现于**：第五轮（两方终审）。

### 4.4 第四条 · 「基线与 `-- .` 都不能省」，方向写反

**是什么**：给 §4.2 那条 `--name-status` 命令加的括注。**错在哪**：两个开关只有一个「不能省」，而且括注给的理由只支撑其中一个。四格实跑：

| 执行位置 | 不带 `-- .` | 带 `-- .` |
| --- | --- | --- |
| 仓库根 | 733 / 135 / 180 | 733 / 135 / 180 |
| `scripts/` 下 | 733 / 135 / 180 | **24 / 4 / 13** |

所以：**基线不能省** —— 裸 `git diff --shortstat` 比的是工作区对索引，在干净工作区没有任何输出（本文写作时工作区有另一批次的两个改动，故用 `git diff --shortstat -- ':!<那两个文件>'` 验的：输出为空）。而 `-- .` **可省，且在仓库根之外的目录里带上它会静默把结果收窄到当前目录**，反而出错。

**怎么修的**：`36c54973` 把方向改对；`e993d62e` 再把示例命令自己带着的那个 `-- .` 去掉 —— 上一轮改了说明、没改命令，同一行里说明与示例互相打架又活了两轮。**发现于**：第六轮（说明写反）、第八轮（示例未跟上）。

### 4.5 第五条 · `comm` 两侧缺 `| sort`

**这条最重，也最能说明 roadmap v2.70 那一行为什么必须拆。**它被 v2.70 那一行明确标注成「**现成对照命令**」，是写给后来建全仓版权头棘轮的人照抄的；而**同一个 PR 的 `NOTICE` 一、许可里 `-c core.quotePath=false` 逐字出现 12 次、明写着不能省**（`grep -o 'core\.quotePath=false' NOTICE | wc -l` = 12）—— 本 PR 自己立的规矩，被自己在另一份文档里破掉。它能藏过九轮逐句审查，正是因为那一行有两万字节：**审计的原话是「这一行的内容只有写它的人能定位」**，第十轮换角度（整体自洽性，而不是逐句查新增）才把它翻出来。这就是本文存在的直接理由。

原文（缺两侧 `| sort`，也缺 `quotePath`）：

```
comm -23 <(git ls-files) <(git ls-tree -r --name-only base-snapshot/v2.46.0)
```

裸跑 **747**，权威值 **733**。差额拆开是 **47 个误报 + 33 个漏报**（733 − 33 + 47 = 747），33 个漏报**全部**是非 ASCII 文件名，与全仓非 ASCII 文件名总数相等。

`bf9053f9` 换成 `NOTICE` 里那条完整写法，并就地写明两个开关各管什么。

### 4.6 第五条的因果，第一次修的时候写反了

第一版修正写的是：「省掉 `-c core.quotePath=false` 会漏掉 33 个非 ASCII 文件名，省掉 `| sort` 会让 `comm` 的归并错位」。**听起来合理，实测是错的。**四种组合真跑：

| 组合 | 结果 |
| --- | --- |
| 都不加 | 747 |
| 只加 `-c core.quotePath=false` | **747**（没变） |
| 只加两侧 `\| sort` | **733**（对了） |
| 两个都加 | 733 |

所以：**两侧的 `| sort` 单独就决定这一步的计数** —— `comm` 是归并比较，而两条 git 命令按**未转义**字节序输出却按**转义后**的形式打印，有序前提被破坏。**`-c core.quotePath=false` 不影响这一步的计数**，它决定**下一步还能不能用**：不加则那 33 个名字是带引号的八进制转义串，喂给「再筛前 5 行」的 `head` 读不到文件、被静默跳过而少算。实测（只加 `sort` 不加 `quotePath` 时，733 条里有 33 条落不到文件；两个都加则为 0）：

```
while IFS= read -r f; do [ -f "$f" ] || echo "$f"; done \
  < <(comm -23 <(git ls-files | sort) \
               <(git ls-tree -r --name-only base-snapshot/v2.46.0 | sort)) | wc -l   # 33
```

`NOTICE` 的表述从一开始就是对的 —— 它写的是「那种名字喂给 `head` 读不到文件，会被静默跳过而少算」，准确地归在下游那一步。写错的是修正稿。

**这条留在这里当反面例子**：凡是往文档里写「A 导致 B」的因果句，先跑一次「只有 A」和「只有 B」的对照。这次跑对照只花了两分钟，而它推翻的是一句已经写进仓库、准备给后来者照抄的话。**对称的解释比不对称的更容易被当成对的** —— 两个开关看起来该各管一件事，就真给它们各分了一件，而那个拆分没有任何实测支撑。

### 4.7 来源归因

`03-handover.md` 记的原归因是「补头前就存在于文档里 **2** / 本 PR 前几轮新写进去 **2** / 修第五条时又写反因果 **1**」，即「五条里三条是这轮工作自己造的」。

**这条归因我复核不出来。**按一条可检验的判据重算 —— 「命令原文在 PR 基点 `aea019d8` 上是否存在」：

| # | 在基点上存在？ | 证据 |
| --- | --- | --- |
| ① `quotePath` | **否** | 基点 `NOTICE` 里没有那条反例检查；它由本 PR 的 `a3d3c595` 写入 |
| ② `--diff-filter=M/D/A` | **否** | `git grep -c 'diff-filter=M/D/A' aea019d8` 无命中；由 `1fa9f28b` 写入 |
| ③ `sbom.ts` 与 `BASE.md` | **命令是，断言否** | 命令原文在基点 `scripts/sbom.ts` 里且写法正确；基点上与它配对的是「本仓库当下就有一批这样的文件」，自洽。是补头 + `a3d3c595` 改写成「清零」把这一对拆散的 |
| ④ `-- .` 方向 | **否** | `git grep -c '都不能省' aea019d8` 只命中三个无关文件；由 `bff3f098` 写入 |
| ⑤ 裸 `comm` | **否** | `git grep -c 'comm -23 <(git ls-files)' aea019d8` 无命中；基点上三处 `comm -23` 全是带 `quotePath` + `sort` 的正确写法；裸写法由 `1fa9f28b` 写入 |

**按这条判据是「4 条本 PR 自造 + 1 条被本 PR 拆散」，不是 2/2/1。**方向与原归因一致、程度更重：**这一轮工作制造的可错表面比它清掉的多。**这正是第十轮判「已过收益拐点，应当收尾」的主要依据。

> 还有第六条同型的，第四轮自查抓到、原归因未计入：v2.70 ④ 里写的复核命令
> `grep -rn 'frames\.ts:169\|resident\.ts:386\|key-distribution\.md:53[0-9]' docs/` 应无输出 ——
> 它当时**永远不会无输出**，因为 v2.70 那一行的正文自己就写着这些旧值作为变更记录，grep 必命中该行本身；
> 当时的修法是加 `| grep -v 'v2.70'` 排除项。**本文把那些旧值搬了过来，于是这个问题也跟着搬了过来**：
> 现在命中的是本文件而不是 roadmap（实测 `grep -rl … docs/` 只列出 `docs/dev/spdx-backfill-retro.md`），
> 排除项相应改为 `--exclude=spdx-backfill-retro.md`。这与 §6.1 是同一个形状：**判据类文档会匹配到自己。**

## 5. 缺陷形态：一句概括得太满的话

十轮下来，**每一轮新写的内容都会引入新的、更靠外层的问题，且形态高度一致 —— 都是「一句概括得太满的话」**。`01-review-log.md` 逐条点名的实例有七条：

1. 「其后**全部**提交为阡陌团队的工作」（`NOTICE`，被同文件后文承认的 `d04a79dd` 推翻）
2. 「**87 个阡陌自有**却无头的全集」（roadmap，把路径判据划出的集合说成所有权主张）
3. 「仓库里**根本没有**版权头门禁」（§2.2）
4. 「把这 180 个**逐个**筛过」（`NOTICE`）—— 实测那 180 个里有 **7 条** `git diff --numstat` 报 `-`（`bun.lock` 加 6 个 `vendor/audio-capture/*/audio-capture.node`，因 `.gitattributes` 的 `binary` / `-diff`），**行数比法对它们根本跑不了**
5. 「**其余每一个**都还留着来自快照的行」（`NOTICE`，被同文件 30 行后自己推翻）
6. 「基线与 `-- .` **都**不能省」（§4.4）
7. 「那道门禁**一直**在跑 / 已经在 CI 里跑了半个多月」（§2.3）

本批自己的计数是 **11 次**，第 11 次就是 §4.6 那条编出来的对称因果；**另有第 12 次在写后续批次方案时被拦下**（核对「那套拆分散在几处」时连续三次把 grep 写错：匹配太松命中十六进制色值、pathspec 写成 `'*.md' '*.ts'` 漏掉没有扩展名的 `NOTICE`、去掉 pathspec 又冒出一个巧合命中）。

**其中 8 ~ 10 次没有单独留档**，只有计数 —— 这个数只在本批内部可复核，本文如实标注。

两条可以带走的：

- **为了让文档读起来干净有力，最省事的写法就是把限定条件省掉，而每一次省略都在事实层面制造一个可被证伪的全称断言。**
- **pathspec 与匹配宽窄是这类计数最容易错的两个旋钮**，而它们错了都不会报错，只会安静地给一个看起来合理的数。§4 五条里有三条是这个机理。

## 6. 留给建全仓棘轮的人：两个坑

### 6.1 判据类文档会匹配到自己，豁免表里必须有它们

`CLAUDE.md` / `CONTRIBUTING.md` / `README.md` 三份文件的正文里**记述**这条判据，于是**全文匹配必然命中自己**，而它们都在基座快照里 —— 门禁一上来就红。实测两套口径的差：

```
# 前 5 行窗口（判据本身），锚到 c9c74627
git grep -n "SPDX-License-Identifier: AGPL-3.0-or-later" c9c74627 \
  | awk -F: '$3<=5' | cut -d: -f2 | sort -u | wc -l          # 646
# 全文匹配，同一个锚
git grep -l "SPDX-License-Identifier: AGPL-3.0-or-later" c9c74627 \
  | cut -d: -f2 | sort -u | wc -l                            # 650

# 「带头 ⇒ 阡陌自有」的反例：全文匹配命中的文件里有哪些其实在快照内
git grep -l "SPDX-License-Identifier: AGPL-3.0-or-later" c9c74627 | cut -d: -f2 \
  | while IFS= read -r f; do
      git cat-file -e "base-snapshot/v2.46.0:$f" 2>/dev/null && printf '%s\n' "$f"
    done
# → CLAUDE.md / CONTRIBUTING.md / README.md（3 个）
# 同一条检查换成前 5 行窗口那一套 → 无输出，零反例
```

**两个绝对数都会动。**差的那 4 份是「正文里记述判据、却不把它当自己的头」的文件 —— `CLAUDE.md` / `CONTRIBUTING.md` / `README.md`（都在快照里，**是反例**）加 `NOTICE`（不在快照里、是阡陌自有，判据里「前 5 行」那个限定正为它而设，**不是反例**）。

**「差恒为 4」这句只能说到这里，别当不变量用**（这是本文写作中拦下的第二次「概括得太满」）：新增一个**带头**的文件会给两个数各 +1，差不变；但新增一个**只在正文里引用这个串、自己不带头**的文件只会给全文匹配 +1，**差就变成 5** —— 现有这 4 份自己就是这条机理的证明，`NOTICE` 正是「串在正文里、不在前 5 行」的活样本。差稳不稳，取决于将来有没有人再写一份「记述判据的文档」—— 而那恰恰就是本节要提醒的那类文件，也正是棘轮豁免表要盯的那一格。

> **本文自己是第 5 份「记述判据的文档」，但它落在另一格：既带头、又在正文里逐字引用**，于是**同时**进两套命中集，两个数一起 +1 —— 入库后 646 / 650 变成 **647 / 651**，差仍是 4（写作时以 `git grep --untracked` 预测、实测如此）。**上一版这里内联着不带锚的 `# 646` / `# 650`，它们会在本文提交的那一刻失效**，是复核时被指出来的。这正是本节要讲的那件事，第 4 次以「写这份文档的人自己」的身份发生（前三次：第四轮那条自命中的 `grep`、第十轮那次用全文匹配查反例、以及下面这条陈旧引用复核命令）。

下面这条就是第三次的延续：§3.3 的正文里写着 `frames.ts:169`、`resident.ts:386`、`key-distribution.md:536-539` 这些旧值作为变更记录，所以那条陈旧引用的复核命令必须排除本文件：

```
grep -rn 'frames\.ts:169\|resident\.ts:386\|key-distribution\.md:5[34][0-9]' docs/ \
  --exclude=spdx-backfill-retro.md
# 应无输出
```

> **顺带修掉原命令的一个洞**：原写法用的是 `key-distribution\.md:53[0-9]`，只盖得住那 5 处里的 4 处（`:536-539` ×3 与 `:532-543`），**盖不住 `:543` 那一处**。今天四簇都已归零，所以这个洞现在不会给出假绿；但作为回归护栏它是漏的，故本文改用 `5[34][0-9]`。

### 6.2 `packages/activator` 那道测试就是现成范式

不必从零建（§2.2 已证它接线齐全、现跑现验）。断言逻辑（读文件前两行、逐字比对那两个字符串）与接线方式（普通单测，自动落进 `test-shards.sh` 的 `packages/*` 分片）都不用再设计，**剩下的只是把它的 `sourceFiles()` 从「本包 `src/` 下的 `.ts`」换成全仓判据加一张豁免表**。

三处必须先想清楚：

1. **豁免表**至少要含 §6.1 那三个自匹配文件，以及 `NOTICE` 一、许可里列出的那三类「不能算漏」的文件（带不了注释头的 / 技术上带得了但不该带的 / 有意不加的）。**具体清单与计数以 `NOTICE` 一、许可为准，那里有现跑现算的命令；本文不复制。**
2. **窗口口径**：现成范式判「**恰好**第 1–2 行」（`sourceFiles()` 取每个文件前两行逐字比对），`NOTICE` 的口径是「**前 5 行内**」。§1.3 那三个 shebang 文件正落在两者的分叉上。
3. **`sourceFiles()` 目前是 `readdirSync(SRC_DIR)` 非递归、只取 `.ts`**，换成全仓判据时要一并处理递归与非 `.ts` 文件（补头的 66 个里 24 个是 `docs/` 下的 `.md`）。

且本次之后「**形态上带得了注释头却没带的阡陌文件**」已归零 —— 正是钉零的时机，与 `check:mock-hygiene` 从 241 清到 0 之后设棘轮防回潮是同一个形状。

## 7. 留给负责人的开放项（本批未落地）

**两条开放项已由后续一批于 2026-08-30 收口，见下。**

1. **要不要把版权头判据做成全仓棘轮。**判据现在是机器可判的，成本很低且有现成实现可比照（§6.2）。**但这条不能由实施方自行落地**：反转章程 §5.5「不为此新增 CI 断言」是**章程级决定、不是工程判断**，而 `CLAUDE.md` §2.1 写明范围变更必须回写章程并升版本号、无书面变更不开工。本批**只记证据、不建门禁**。
   - **后续批次收口（2026-08-30）**：已落地，见 [`charter.md`](./charter.md) v2.18 与 `scripts/check-license-headers.ts`。
2. **章程 §5.5 的头模板原文仍写 `SPDX-License-Identifier: MIT`**（`grep -n "SPDX-License-Identifier: MIT" docs/dev/charter.md` → 第 26、341 行）。v2.16 转 AGPL 之后未回改 —— **照它建门禁会断错值**。本批未改章程。
   - **后续批次收口（2026-08-30）**：已落地，见 [`charter.md`](./charter.md) v2.18 与 `scripts/check-license-headers.ts`。上条括号内的「第 26、341 行」是锚定提交 `060cd550` 的历史实跑结果；现行树上同一命令只命中 `charter.md` 的 v2.5 变更记录行，规范性模板已不再命中。

## 8. 同批其他改动（只给指针）

| 面 | 做了什么 | 真源 |
| --- | --- | --- |
| `NOTICE` 一、许可 | 计数与「判据尚未覆盖全部」段落按补头后的现状改写；新增一段说明被改造过的基座文件为何有意不带头 | `NOTICE` 一、许可（**唯一出处**，含现跑现算的命令） |
| `NOTICE` 二、成果边界 | 举证命令由 `git diff 3380c88..HEAD` 改为 `git diff base-snapshot/v2.46.0..HEAD` —— 前者在 2026-08-17 首次上游同步之后会把上游 v2.46.0 的内容一并算成我方工作，**这是一次把我方工作量向下修正的勘误**。两个绝对数每加一笔提交都会变大，**引用前现跑现算**，不要抄任何写死的数 | `NOTICE`；口径见 `CLAUDE.md` §0 与章程 §5.5（v2.13 起已改用后者） |
| `docs/dev/license-chain-m0.md` | D-5 计数刷新为补头后的现状；「不限定前 5 行会多出几个」改写成带日期锚 + 现跑现算 | 该文件 |
| `scripts/sbom.ts` / `docs/dev/sbom-m0.md` | 让生成器自己写出那两行文件头 —— `sbom-m0.md` 由 `bun run sbom` 整体覆盖，手加的头会在下次生成时被无声抹掉、判据静默掉到 645，且没有任何门禁会报错（**这段效果是本批实测的，本文未重跑 `bun run sbom`**；本文核过的是 `bf9053f9:scripts/sbom.ts` 的 `buildMarkdown` 现在确实在开头 push 那两行，且 `bf9053f9:docs/dev/sbom-m0.md` 头两行就是它们）。另订正三处已被自己证伪的陈述与 §2.2 那句根因 | `scripts/sbom.ts` 的块注释 |
| `docs/dev/positioning-m0.md` | 已双签件只加 §0′ 附注，**正文一字未改**。核过：全 PR 该文件 `+55/−4`，10 个 hunk 里只有 4 个含删除（旧行 23 / 27 / 39 / 41），**全部落在 §0′ 内**（§0′ 在基点上是第 21–41 行），正文区的 6 个 hunk 是纯插入（`@@ -N,0 +…`） | 该文件 §0′ |

**范围、AC 判据、排期均未动；`BASE.md` 一字未动**（`git diff aea019d8..bf9053f9 -- BASE.md` 无输出）。`docs/dev/charter.md` 只在补头那笔多了两行文件头（它本身也在那 66 个里），条款与决定一字未改 —— §2.1 与 §7 提到的两处章程问题都只是记录。

## 9. 复核命令清单

按本文出现顺序，均为 2026-08-30 在主检出、仓库根实跑：

| # | 命令（要点） | 出处 |
| --- | --- | --- |
| 1 | 判据值，**锚到提交**：`git grep -n "SPDX…" c9c74627 \| awk -F: '$3<=5' \| cut -d: -f2 \| sort -u \| wc -l` → **646**；换 `c9c74627^` → **580**；换 `dcde53d8`（合入点）→ 646 | §1.1 |
| 2 | `git show --name-only --format='' c9c74627 \| grep -c .` → 66 | §1.1 |
| 3 | `… \| cut -d/ -f1 \| sort \| uniq -c \| sort -rn` → 24/18/16/5/2/1 | §1.1 |
| 4 | `git cat-file -e base-snapshot/v2.46.0:BASE.md` → 不在快照里 | §1.2 |
| 5 | 66 个里 SPDX 不在第 2 行的 → 恰好那三个 shebang 文件 | §1.3 |
| 6 | `git show --name-only --format='' c9c74627 -- packages/activator` → 无输出 | §2.2 |
| 7 | `bun test packages/activator/test/surface-invariant.test.ts` → 27 pass | §2.2 |
| 8 | `gh run list --workflow=ci.yml` + `gh run view <id> --json jobs` → 执行窗口与 `steps: 0` 签名 | §2.3 |
| 9 | `git show --numstat --format='' c9c74627 -- <四份文档>` → 12 行 / 17 个记号 | §3.1 |
| 10 | `sed -n '378p' docs/dev/protocol.md` / `'693p'` 等，逐个核行号真值 | §3.2 §3.3 §3.4 |
| 11 | `git diff --diff-filter=M/D/A …` → exit 129 | §4.2 |
| 12 | `git diff --name-status base-snapshot/v2.46.0 \| cut -f1 \| sort \| uniq -c` → 733/135/180；在 `scripts/` 下带 `-- .` → 24/4/13 | §4.2 §4.4 |
| 13 | `sbom.ts` 那条命令带 / 不带 `grep -vx 'BASE.md'` → 空 / `BASE.md` | §4.3 |
| 14 | `comm` 四种组合 → 747 / 747 / 733 / 733；误报 47、漏报 33、非 ASCII 名 33 | §4.5 §4.6 |
| 15 | `grep -o 'core\.quotePath=false' NOTICE \| wc -l` → 12 | §4.5 |
| 16 | 全文匹配 650 vs 前 5 行 646；反例 3 个 vs 0 个 | §6.1 |
| 17 | `grep -rn '<三簇旧值>' docs/ --exclude=spdx-backfill-retro.md` → 无输出 | §6.1 |
| 18 | `grep -n "SPDX-License-Identifier: MIT" docs/dev/charter.md` → 第 26、341 行 | §7 |
| 19 | `git diff --numstat base-snapshot/v2.46.0..bf9053f9 \| awk '$1=="-"'` 与 M 集合取交 → 7 条（`bun.lock` + 6 个 `.node`）；`.gitattributes:52`、`:68` | §5 |
| 20 | `git diff -U0 aea019d8..bf9053f9 -- docs/dev/positioning-m0.md \| grep '^@@'` → 10 个 hunk，含删除的 4 个都在 §0′ 内 | §8 |
| 21 | `git show bf9053f9:scripts/sbom.ts \| grep -n 'out\.push(.<!--'` → `buildMarkdown` 第 1497–1498 行两条 | §8 |
| 22 | `git diff aea019d8..bf9053f9 --shortstat` → 73 files changed；`git diff aea019d8..bf9053f9 -- BASE.md` 无输出 | 头部元信息、§8 |
| 23 | `git grep -al` 对非 ASCII 路径的转义行为（带 / 不带 `-c core.quotePath=false`）；那 33 个路径的扩展名分布 → 27 jpg / 2 png / 2 pdf / 2 docx，全是二进制 | §4.1 |
| 24 | **本文入库对两套口径的影响**。写作当时（本文件未 `git add`）实测：`git grep` 读 646 / 650，`git grep --untracked` 读 **647 / 651** —— **入库后两条命令同为 647 / 651，所以这条是带条件的历史测量，不是入库后可复现的判据**。入库后仍可复现的是：两数之差恒为 **4**，且锚到提交的 `… c9c74627 …` 两条永远是 646 / 650 | 本文性质 3、§6.1 |
| 25 | 锚定写法的稳定性：`c9c74627` 上窗口 646 / 全文 650、差集恰为 `CLAUDE.md`·`CONTRIBUTING.md`·`NOTICE`·`README.md`、快照内反例 3 vs 0 —— 与在当下的树上跑出的差集、反例集**逐个相同**。另核过差为什么不是不变量：`head -5 NOTICE \| grep -c '<那个串>'` = 0 而全文 `grep -c` > 0，`NOTICE` 就是「只进全文匹配、不进前 5 行窗口」的活样本 | §6.1、本文性质 3 |
| 26 | 替换 v2.70 那一行后：`wc -l docs/dev/roadmap.md` = 927（与改前相等）、`git diff --numstat` = `1 1`、该行裸竖线 4 根（与改前相等）、该行 1,346 字节 | §3.4、变更记录 |

**没有验证的**：本文未跑 `bun run precheck` / `bun run verify` / `bun run sbom`；未做任何法律判断；`NOTICE` 中英两版只核到「本文引用的那几处」，未做逐句对照；`01-review-log.md` 里「概括得太满」第 8 ~ 10 次没有单独留档，本文只转述计数（§5）。
