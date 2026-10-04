<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — M0 验收走查判定记录表（AC-1 ~ AC-8）

| 项 | 内容 |
|---|---|
| 文档版本 | **v0.2-draft** |
| 生效日期 | 2026-08-15 |
| 任务包 | [`roadmap.md`](./roadmap.md) **P8.2 全量验收走查**（owner：喻永昌主持，全体参与） |
| 判据依据 | [`charter.md`](./charter.md) **v2.9 §4**（§4 判据自 v2.8 起未再改动；v2.9 只回写 §5.7）（判据原文在那里，本表不复制，只放指针与走查需要的阈值） |
| 完成状态依据 | [`roadmap.md`](./roadmap.md) **「完成状态速查」表**（该表自称完成状态的唯一出处，本表以它为准） |
| 用途 | 走查现场的操作与判定底稿：每条 AC 敲什么、镜头给什么、判什么、缺什么 |
| 状态 | **本机腿（§8）、凭据腿（§9.1/§9.2/§9.4）、真机腿（§9.3/§9.5）均已走查**。八条 AC 全部 PASS-已走查（AC-5 以替代第二供应商收口，qwen 重跑降级为补充项）；**流程件已由负责人 2026-08-17 决议全部关闭**（评审通过、双签通过、现场评议以本表留档为准——见 roadmap v2.41），本表即 M0 验收的最终判定记录 |
| 走查驱动 | [`demo/walkthrough.sh`](../../demo/walkthrough.sh) —— 一键跑完本机腿并落 transcript / 报告 JSON / `summary.json`；用法与产物形态见 §8.1 |
| 编制口径 | 每个数字、SHA、路径、用例数都在仓库里核过，核法见 §6「核对记录」；核不到的一律写「未核到」。**§8 里的数字全部来自 §8 那次实跑**，不是转述 |

> **这份表不替代任何东西。**判据原文在章程 §4；完成状态在 roadmap 速查表；各包的实施细节与边界在 roadmap 变更记录里。本表只做一件事：把它们收敛成一张**能照着敲命令、照着判 PASS/FAIL** 的走查底稿。

---

## 1. 总览表

判定列的取值定义（**只有走查现场能改写它们**）：

| 取值 | 含义 |
|---|---|
| **PASS-已走查（本机）** | **判据已在本次走查里当场跑过**（`demo/walkthrough.sh`，§8 有 transcript + 报告 JSON + sha256），不是转述历史证据 |
| **PASS-证据齐** | 判据全部有实测证据，且走查现场能在本机原样复跑 |
| **PASS-待复跑** | 判据全部有实测证据，但复跑需要额外条件（真机 / 凭据），现场能否重现取决于条件是否具备 |
| **部分** | 判据的**某个子项**证据不完整或换环境后不成立 |
| **待真机** | 证据只在非目标环境测得，目标环境未测 |
| **未通过** | 判据有实测不达标 |

| AC | 一句话判据（全文见 charter §4） | 当前判定 | 证据类型 | 一键命令 | 证据锚点 | 最后实测 |
|---|---|---|---|---|---|---|
| **AC-1** | `kill -9` 后 `--resume` 续答，`session_id` 一致，启动到可收消息 ≤ 10 s | **PASS-已走查（本机；判据②已于 08-16 凭据现场留档，14 项全过）** | 本机脚本 + 一次真调用现场 | `demo/walkthrough.sh --only ac1`（＝ `bash demo/ac1-restart.sh`）；判据②现场见 §9.2 | `5508358`＋`3e7a401`；`docs/dev/session-persistence-review.md`；§8.3 本次实跑；**判据②留档**：`~/qianmo-acceptance/20260816T151742Z/ac1-criterion2/`（§9.2，`session.jsonl` sha256 `419a15cf…`） | 脚本部分：2026-08-15 走查；判据②：**2026-08-16 现场留档** |
| **AC-2** | 跨节点唤醒休眠智能体，ack ≤ 60 s、result ≤ 5 min、10/10 | **PASS-已走查（真机，2026-08-16 复跑）**：10/10，八条 check 全 true，每轮先确认 frozen；ack P95 5.589 s / result max 8.976 s（较 08-13 的 8.022 / 12.422 s 均降约三成）；独立核验取常驻侧证据三项全 true | 真机（burn-vm-01 经 IAP 隧道） | `bash demo/p41-task-result.sh` | **§9.3**（`~/qianmo-acceptance-remote/20260816T153435Z/ac2/`，`report.json` sha256 `9bf6a17d…`）；roadmap v2.20 + 速查表 P4.1 行；`demo/lib/p41-report-core.ts` 八条 check | **2026-08-16 真机复跑**（前次 2026-08-13） |
| **AC-3** | 回环在首次回访同一 `(处理者地址, taskId)` 时切断；两层限流各自生效 | **PASS-已走查（本机）** | 本机自动化（真 transport，unix socket） | `demo/walkthrough.sh --only ac3`（＝ `QIANMO_TRANSPORT_PSK=… bash demo/ac3-loop-rate.sh`） | roadmap v2.21 + 速查表 P4.2 行；`demo/lib/ac3-report-core.ts` 十条 check；**§8.3 本次实跑十条全 true** | **2026-08-15 本次走查**（前次 2026-08-14） |
| **AC-4** | 项目记忆跨会话命中 5/5、标注来源 ID 与写入时间、伪造决策零引用 | **PASS-已走查（本机凭据，deepseek 腿）**：命中 **5/5** 逐条带来源 ID、伪造决策零引用 **3/3**。qwen 腿因网关上游 502 未取（判据不要求双腿，见 §9.1） | 真调用集成测试 | `source <凭据文件> && demo/walkthrough.sh --only ac4` | §9.1（`~/qianmo-acceptance/20260816T150910Z/`）；速查表 P3.3 行；`packages/recall/` 51 用例 + 集成 19 用例 | **2026-08-16 凭据走查** |
| **AC-5** | 同一任务在 ≥ 2 个供应商适配器下跑通，仅改配置不改代码；一致性三项全绿 | **PASS-已走查（判据字面满足，2026-08-17 以替代第二供应商收口）**：判据不点名 qwen——「命令行逐字相同、只改配置文件」两跑在 **deepseek-v4-pro（compat=deepseek）× kimi-k3（compat=strict-openai）**上双绿（配置差异恰 2 行），一致性三项在两条不同 compat 档上 **9 pass / 0 fail** 且**未改一行测试代码**（只临时换夹具数据 1 行、跑完 sha256 校验还原）；qwen 上游 502/503 同分钟对照留档为上游可用性证据。**qwen 补充项已于 08-17 取消**（夹具按 §9.4 末条整条替换为 kimi-k3 / `qianmo-alt`，`cff9b138` + `cfd68052`，换后真调用 9 pass）；G-4 定性限定仍在 | 真调用集成测试 + 端到端脚本 | `source <凭据文件> && demo/walkthrough.sh --only ac5,ac5e2e`；替代腿见 §9.4 | **§9.4**（`~/qianmo-acceptance/20260817T010250Z/ac5-alt/`）；§9.1；`docs/dev/p1.4-provider-verification.md` v0.1 | **2026-08-17 替代腿收口**（08-16 deepseek 腿；qwen 补充项待网关） |
| **AC-6** | (a) 越权写被拒留痕；(b) `rm -rf` 后 10 min 内完整恢复；(c) 删备份被拒 | **三子项全 PASS-已走查**：(a) 真机 5/5（2026-08-16 复跑），runsc 出生契约现场 + 五条审计事件齐全；(b)(c) 本机十一条 check 全 true + **真机挂载边界已测（2026-08-16，28/28 全 true）**——store 在沙箱唯一可写 bind 之外（沙箱内 ENOENT）、HTTP 面无删除动词（405×4 / 403×2 全审计）、`rm -rf` 后 **60 ms** 恢复且 git status / HEAD / exec 位逐一一致。**§4.1「最可能需要豁免的一条」就此闭合，AC-6 不再需要豁免** | (a) 真机；(b)(c) 本机 + 真机 | (a) `bash demo/ac6a-sandbox.sh`；(b)(c) `demo/walkthrough.sh --only ac6b`；挂载边界见 §9.5 | (a) **§9.3**（`.../ac6a/`，末行 `passed:5,total:5`）+ 速查表 P1.3 行；(b)(c) roadmap v2.23 + 速查表 P4.4 行、`demo/lib/ac6b-report-core.ts` 十一条 check、**§8.3 本次实跑十一条全 true**；**挂载边界 §9.5**（`~/qianmo-acceptance-remote/20260816T165237Z/ac6bc-mount/`，report sha256 `4207dc6a…`） | (a) **2026-08-16 真机复跑**；(b)(c) 2026-08-15 本机走查；**挂载边界 2026-08-16 真机首测** |
| **AC-7** | ≥ 10 min 全程无人工干预的六环节连续演示，3/3 | **PASS-已走查（本机）**（本次在 `856d0ff8` 上又跑通一次 3/3；真机副本仍待补传） | 本机（单进程逻辑双节点） | `demo/walkthrough.sh --with-ac7`（＝ `make -C demo p61-accept`，`SEED=6101 MINUTES=10 CHUNKS=20`） | `87c4609b`；`docs/dev/scenario-mcm.md` §9 三行正式记录（**仍是正式记录**）；归档包 sha256 `2be9d926…3140`（**私有验收目录，仓库内无副本**）；**§8.3 本次走查三轮**（digest 与 §9 逐字相同） | **2026-08-15 本次走查**（同日另有 §9 那次正式记录） |
| **AC-8** | 五类边界每类 ≥ 2 条、总数 ≥ 12、全部进 CI 且连续 5 次构建全绿 | **PASS-已走查（本机）**（边界库与 60 min 混沌均当场跑过；CI 五连绿已于 2026-08-16 在 `d162fe72` **重取一次、5/5 全绿**，早先的 `a8b06a9` 五连绿仍在——§4.5） | 自动化 + CI | `demo/walkthrough.sh --with-chaos 60`（含 `bun test tests/boundary`） | 速查表 P5.4/P7.1 行；**实数 39 条**（本次实跑 39 pass / 0 fail）；**§8.3 本次 60 min 混沌五条 check 全 true、177 次注入、四类 `stalled` 全 0、`unmapped=0`**；CI 5 连绿于 `a8b06a9`，五个 run id 均已核到 `success` | 边界库与混沌 60 min：**2026-08-15 本次走查**（混沌前次 2026-08-14）；CI 五连绿：`a8b06a9` |

**按 DoD 口径的当前汇总**：8 条中 **0 条未通过**；**0 条需要豁免**（判据本身都有达标实测）。真正卡在走查现场的是**能否复跑**，不是能否达标——详见 §4。

> **v0.2 补充**：「能否复跑」这个风险在**本机腿上已经消解**——AC-3 / AC-6(b)(c) / AC-8 与 AC-1 脚本部分已于 2026-08-15 在 `b3cda44f` 上复跑通过，AC-7 在同日的 `856d0ff8` 上跑通 3/3（两者之间 AC-7 相关代码零改动，§8.3 有 `git diff` 依据），逐项 transcript 与报告 JSON 见 §8。剩下的复跑风险只在**真机腿**（AC-2 / AC-6(a)）与**凭据腿**（AC-1 判据② / AC-4 / AC-5）——**这两条腿也已于 2026-08-16 ~ 08-17 全部实跑并留档（§9），复跑风险就此清零**（AC-5 的 qwen 原夹具重跑是补充项，不在风险面上）。

---

## 2. 逐条记录

各节格式统一：判据指针 → 复现命令与前置 → 实测数据 → 机器判据 check 清单 → 独立核验点 → 已知边界与未覆盖 → 录屏脚本 → 待办与 owner。

**owner 栏读法（roadmap v2.3）**：全部任务包的**主开发均为喻永昌**，下文「方向辅助人」即 roadmap 各任务包 owner 行中的名字，括号内为第二辅助。

---

### 2.1 AC-1 · 进程重启后凭持久化会话恢复上下文并续答

**判据指针**：`charter.md` §4 判据表 **AC-1** 行（v2.8 未改动，`§4` v2.2 说明段明确「AC-1 判据一字未改」）。走查只需记住三个数：

- `session_id` **重启前后一致**；
- 从进程启动到可接收新消息 **≤ 10 s**；
- 不重放对话历史即可续答，且引用到**只有重启前上下文才知道**的项目细节。

**复现命令与前置条件**

| # | 动作 | 命令 | 前置 |
|---|---|---|---|
| 1 | 崩溃一致性 + `session_id` + 启动预算 | `bash demo/ac1-restart.sh` | 只要 `bun`。脚本自建 `mktemp` 配置根（`OCC_CONFIG_DIR`），**不碰用户真实 `~/.occ`/`~/.qianmo`，不读凭据、不发模型请求** |
| 2 | 判据②「不重放历史即可续答」 | **脚本不覆盖**，须现场手工做一次真调用（见下方录屏脚本第 5 步） | 一份可用的模型供应商凭据；一次真实多轮任务现场 |

脚本可调参数（默认值即验收档）：`AC1_SMALL_SESSIONS=5` / `AC1_LARGE_SESSIONS=1000` / `AC1_MSGS_PER_SESSION=40` / `AC1_BUDGET_S=10`。

**实测数据**

| 项 | 数值 | 样本 | 日期 | SHA / 机器 |
|---|---|---|---|---|
| `--resume` 纯加载耗时（小 → 大历史） | **7 ms → 24 ms** | 两个历史规模点位 | 2026-08-12 | `session-persistence-review.md` v0.1；机器未标注，**未核到** |
| `--continue` 纯加载耗时（同上） | **18 ms → 474 ms** | 同上 | 2026-08-12 | 同上 |
| `kill -9` 三崩溃点后一致性 | 磁盘无损坏行、`session_id` 不变、无悬空 `tool_use` | 写事件中 / 快照中 / 工具执行中 各 1 | 2026-08-12 | 同上 |
| 判据②真调用补测 | 答对上下文推出的代号 `QM-seven-bridges`，`session_id` 一致，端到端 **5.2 s** | 1 次 | 2026-08-12 | roadmap 速查表 P1.2 行；**无留档报告、无 SHA 锚定** |

**机器判据 check 清单**（`demo/ac1-restart.sh` 无 report-core，判据是脚本内 `ok`/`bad` 计数，`FAIL != 0` 即退出码 1）

1. 三个崩溃点各 4 条：退出码 137 / `session_id` 一致 / 磁盘无损坏行 / 无悬空 `tool_use` / 崩溃前消息可读回；
2. 半写行（字节级截断）三条：确实造出了半写行 / 其余消息仍可读回 / `session_id` 仍一致；
3. 两个历史规模点位 × 两个入口：`--resume` 与 `--continue` 各保持 `session_id`；
4. `--resume` 冷启动墙钟 ≤ `AC1_BUDGET_S`（默认 10 s），两个点位各一条；
5. 「历史放大后 `--continue` 的加载成本涨得比 `--resume` 快」——这是把入口钉死在 `--resume` 的理由的**反向断言**；
6. 4c 段：两个入口读回条数一致则 `ok`，`--resume` 少读则 `warn`（**warn 不计入 FAIL**，见下方边界）。

**独立核验点**

- 判据②的证据是**一次叙述性记录**，不是留档报告。走查现场必须**当场重做一次**，否则这一条只有第二手陈述。
- 代号法（让模型在对话中由文件规则算出一个只存在于上下文的字符串）是判据②唯一可信的形态——直接问「继续刚才那步」无法排除模型现编。

**已知边界与未覆盖**

- **脚本第 5 节恒 `SKIPPED`**：`demo/ac1-restart.sh` 里判据②那一段是无条件跳过的固定文案，脚本**刻意不读任何凭据、不发任何模型调用**。因此「脚本全绿」≠「AC-1 三条判据全过」。这是本条最容易在走查现场被误读的地方。
- **`--resume` 时间戳并列丢尾部消息**：`session-persistence-review.md` §0 第 7 条把它记为「必须处置」的新缺口（实测每次丢 3 条）。修复提交 `3e7a401`（「修复 --resume 时间戳并列丢尾部消息」）已在，且被 roadmap 速查表 P1.2 行列为证据之一，但 **review 文档未回写**，脚本 4c 段的 `warn` 分支也仍在。**v0.2 已核到（§8.4）**：本次实跑 4c 段两个规模点位（200 条 / 3000 条）都报 `ok`，全程 `WARN=0`——修复确已生效，`warn` 分支没被触发。**剩下的只是回写 `session-persistence-review.md` §0 第 7 条**（本表不改 review 文档）。
- 恢复入口按 P1.2 的 v2.2 修正**钉死 `--resume <UUID>`**；review 文档另加一条限定：参数必须是 UUID，传自定义标题会把全量扫描带回来、且是跨 worktree 的，比 `--continue` 更贵。演示不要传标题。
- 崩溃丢失窗口的语义已回写 `protocol.md`（P1.2 交付物之一），走查若被问到「丢的那一小段算什么」，答案在那里。

**录屏脚本**

1. 镜头先给 `git rev-parse --short HEAD` 与 `bun --version`（钉住是哪次构建）。
2. 敲 `bash demo/ac1-restart.sh`，**全程不加速**。
3. 镜头必须停在这几行上：
   - 每个崩溃点的 `崩溃点 xxx: 退出码 137（137 = 128+SIGKILL）`；
   - 每个崩溃点的四条 `PASS:`（尤其 `session_id 一致`）；
   - 半写行段的 `截断确实造出了半写行（N 条）` 与 `半写行不影响其余消息读回`；
   - `[large] --resume 冷启动到会话就绪 X.XXXs ≤ 10s`（**这一行就是 ≤ 10 s 判据**）；
   - 4b 段的四个数值对比（`--continue` 在 large 上明显更贵）；
   - 末行 `PASS=… FAIL=0 WARN=… SKIPPED=1`。
4. **明确念出**：`SKIPPED=1` 是判据②，脚本不测它。
5. 切到判据②的现场演示：
   - 起一个带真实凭据的 occ 会话，在项目里放一条只有读文件才推得出的规则，让模型算出代号并在对话中说出来；
   - 记下 `session_id`；多轮进行中 `kill -9` 该进程；
   - `occ --resume <session_id>`，追问时**明确要求不要重新读文件**；
   - 镜头给到：模型答出同一个代号 + 前后 `session_id` 逐字相同 + 从启动到可收消息的墙钟。
6. 收尾镜头给脚本打印的现场目录路径（证明证据可取回）。

**待办与 owner**

| 待办 | owner |
|---|---|
| 判据②现场重做一次并留档（报告 + SHA 锚定），补上「无留档」这个缺口 | 主开发：喻永昌；方向辅助人：董宗岳（backup 陈子轩） |
| ~~确认 `3e7a401` 之后脚本 4c 段是否已从 `warn` 转 `ok`~~ —— **已确认为 `ok`（§8.4，`WARN=0`）**；仍需回写 `session-persistence-review.md` §0 第 7 条 | 同上 |

---

### 2.2 AC-2 · 跨节点按名寻址唤醒休眠智能体并回执

**判据指针**：`charter.md` §4 判据表 **AC-2** 行（**判据经 D-1 / D-3 修订，已于 2026-08-12 由 P0.8 评审通过、章程 v2.8 生效**）。四个数：

- 休眠态 = **进程不占用可分配内存、且不消耗 CPU 配额**（认沙箱冻结态）；
- ack **≤ 60 s**；result **≤ 5 min**；
- 连续 10 次、成功率 **10/10**、ack **P95 ≤ 60 s**；
- 测量跑在**独立的非阻塞基准 job** 上并留档，**CI 阻塞位只放超时兜底**（D-3）。

**复现命令与前置条件**

```bash
QIANMO_SANDBOX_DAEMON_URL=…      # Dormice daemon 的回环基址（非回环会被代码拒绝）
QIANMO_SANDBOX_DAEMON_TOKEN=…    # bearer，不回显、不落盘、不进日志
QIANMO_TRANSPORT_PSK=…           # 两跳共用
QIANMO_AC2_SANDBOX=…             # 目标沙箱在 daemon 里的 name（不是 id）
QIANMO_AC2_TARGET_URL=…          # 从宿主看过去的沙箱内监听地址
QIANMO_P41_ACTIVITY_PORT=…
QIANMO_P41_FREEZE_AFTER_SECONDS=…
QIANMO_P41_STOP_AFTER_SECONDS=…
bash demo/p41-task-result.sh
```

**前置**：Linux 真机 + Dormice + gVisor（`runsc`），常驻 occ 已跑在目标沙箱内且 `--port` 与 `QIANMO_AC2_TARGET_URL` 对应、activity 上报指向脚本起的 activity 端口。缺任一环境变量脚本**直接退出 2，不静默跳过**。沙箱镜像**必须带 bun**（`@qianmo/transport` 服务端半边用 `Bun.serve`，基础镜像只有 node 24——roadmap v2.16 决策③记为设计约束）。

**实测数据**（2026-08-13，GCP + Dormice + gVisor + `@qianmo/registry` 真注册中心）

| 项 | 数值 | 上限 | 样本 |
|---|---|---|---|
| 成功率 | **10/10** | 10/10 | 10 轮 |
| ack p50 | 2.490 s | — | 10 |
| **ack P95** | **8.022 s** | 60 s | 10（**P95 即最大值，即第 1 轮冷链路建连**） |
| ack 第 2 ~ 10 轮 | 2.073 ~ 3.483 s | — | 9 |
| result p50 | 3.471 s | — | 10 |
| **result max** | **12.422 s** | 5 min | 10 |
| 按名解析 | 8 ~ 11 ms | — | 10 |

> **数字冲突提醒**：roadmap 另有两处写「ack P95 4.440 s、result max 5.885 s」。判定与理由见 §5.1——**正式记录取 8.022 s / 12.422 s**。

**机器判据 check 清单**（`demo/lib/p41-report-core.ts`，八条不合并，任一 false 即 `pass=false`）

`rounds` · `successRate` · `ackP95` · `resultMax` · `frozenBefore` · `closedReplies` · `noStrayReplies` · `resolvedByRegistry`

**独立核验点**（v2.20 的做法，走查应照做——**不采信宿主回执**）

1. 进沙箱取常驻侧 timings：10 条 `msgId` 各有 `detected / admitted / read / first_content / turn_completed` 五个时间点；
2. **每条 ack 都晚于 durable read**（`protocol.md` §4.5）、**每条 result 都晚于 `turn_completed`**，`turn_failed` = 0；
3. 沙箱内信箱累计 22 条全部已读、22 个唯一 `msgId`、类型全为 `task.request`；
4. activator 审计 `link.opened=1`、`task-route.registered=10`、`task-reply.forwarded=20`（10 ack + 10 result）——**全程只有一条进沙箱的链路，回程没有第二条连接**。

**已知边界与未覆盖**（照 roadmap 抄要点，不美化）

- **P95 就是最大值，最大值一直是第 1 轮的冷链路建连**。十个样本的 P95 落在 max 上，所以这项判据实际上报的是「最慢的那一轮」。对 60 s 的线绰绰有余，**但不能当稳态分位数读**。
- **样本是固定 SSE 模型桩**，测的是链路不是真实模型的思考时间。**不要拿这组数字当「任务耗时」基准。**
- P2.5 的那组 43 ms / 423 ms 数字**不能外推**成常驻节点基准：被唤醒的是 94 KB 单文件测试节点（roadmap v2.16 决策②）。
- **M0 不支持「同一任务并发派给同一节点的多个 agent」**：P4.1 的回程 task route 以 `taskId` 为唯一键，从沙箱回来的 ack 也只带这一个键。这是**相关性约束不是判环**，码为 `E_BAD_ENVELOPE`（roadmap v2.21 边界③）。
- ACP 跨会话并发未处理：M0 锁定「一节点同一时刻一个活跃 turn」（v2.15 决策 Q3），同节点多 agent 不能真并发。
- **基座缺陷备案**：ACP `initialize` 对外声明支持 MCP 但从不构造 MCP client。**演示脚本须避开「用 Zed/Cursor 接 ACP 并配 MCP server」这条路径**（v2.15 末条）。
- **workbench-host 在 2026-08-15 全程 SSH 不可达**（TCP 通、无 banner，已排除本机因素，roadmap v2.31）。走查前必须先确认真机可达。

**录屏脚本**

1. 镜头给真机 `uname -a` + `git rev-parse --short HEAD`；
2. 给一次 `docker inspect`（或 daemon 的 `listSandboxes`）证明目标沙箱 runtime 是 `runsc`；
3. 起脚本前先让镜头看到目标沙箱 **`state=frozen`**（脚本每轮也会自查，但开场这一眼是给观众的）；
4. 敲 `bash demo/p41-task-result.sh`，镜头跟到十轮跑完；
5. 镜头必须给到报告 JSON 的这几段：`checks` 八条全 `true`、`pass: true`、`sendToAck.p95Ms`、`sendToResult.maxMs`、`complete: 10`；
6. **切到独立核验**：`docker exec` 进沙箱 `cat` 常驻侧 timings，镜头给 10 条 `msgId` 与「ack 时间戳 > durable read 时间戳」的比对；
7. 镜头给 activator 审计的三个计数（`link.opened=1` 最关键——它证明回程没有第二条连接）；
8. **明确念出**：模型是固定 SSE 桩；P95 = max = 第 1 轮冷链路。

**待办与 owner**

| 待办 | owner |
|---|---|
| 确认 workbench-host 可达；不可达则走查此条改为「放映 08-13 留档报告 + 说明复跑受阻」 | 主开发：喻永昌；方向辅助人：陈曦宇 + 董宗岳（联合，喻永昌兜底） |
| 复跑后把新报告与 08-13 报告并列，若数值差异大需说明环境差异 | 同上 |

---

### 2.3 AC-3 · 消息循环被即时切断，两层限流各自生效

**判据指针**：`charter.md` §4 判据表 **AC-3** 行（**判据经 D-2 修订，P0.8 已通过、章程 v2.8 生效**）。要点：

- 判环粒度 = **首次回访同一处理者地址（`node/agent`）+ 同一任务标识**即切断，`LIMITS.maxHops` **仅作兜底**；
- 产生 **1 条** `loop_detected` 审计事件，含完整消息链 trace_id；
- 限流**两层独立验证**：运行时层单发送方对单目标 60 s / 20 条，第 21 条被拒并返回明确错误码；协议层接收节点对单发送方入站预算 `LIMITS.ratePerMinute`（**数值以 `@qianmo/protocol` 的 `LIMITS` 为唯一出处，本表不复制**）；
- **两层机制不得混写**。

**复现命令与前置条件**

```bash
QIANMO_TRANSPORT_PSK=… bash demo/ac3-loop-rate.sh
```

**只需要 `bun` 与一把 PSK**——不需要沙箱、不需要 daemon、不需要模型凭据。四个场景各起一对全新节点跑在真 transport（unix socket，按 P2.2 测试口径不用 TCP）。报告是一行 JSON，退出码即结论。**这是八条 AC 里现场复跑成本最低的一条。**

**实测数据**（2026-08-14）

| 场景 | 观测 |
|---|---|
| ① A→B→A 回环 | 在**两跳**处被切（`maxHops=8`，因此不是兜底救的场）；发送方收到 `error(E_LOOP)`；`loop_detected` **恰 1 条**，带 trace-id 段 / 跳链 / 判环键 |
| ② 合法 spiral（同节点、不同目标地址） | 正常投递，`loop_detected` **0 条** |
| ③ 运行时层 | 第 21 条本地被拒（`E_RUNTIME_THROTTLED`）且**没上线**；换目标即放行 |
| ④ 协议层 | 按**真实 `LIMITS.ratePerMinute`** 打满后下一条回 `E_RATE_LIMITED`；发送方换了 **31 个 agent 名字**仍不多拿配额（证明这层按**节点**计） |

> **2026-08-15 本次走查复跑**（运行 ②，HEAD `b3cda44f`——**这是 AC-3 量具被 `9736ddca` 修订之后的版本**）：十条 check 全 `true`、`pass: true`，用时 1 s。`loop.hopCountAtCut=2` 仍小于同一份报告里给出的 `loop.maxHops`（**不是跳数兜底救的场**），`spiral.loopEvents=0`，`budget.senderAgents=31`；新的 `protocolBudgetAtLimit` 在本机上 `burstElapsedMs=23`、`refillAllowance=0`，即**退化回原先那条严格判据**（`accepted === LIMITS.ratePerMinute`）。逐行 transcript 与报告 JSON 见 §8.3 ~ §8.5。

**机器判据 check 清单**（`demo/lib/ac3-report-core.ts`，十条不合并）

`loopCutAtFirstRevisit` · `loopReportedToSender` · `loopNotByHopBackstop` · `loopAuditEvent` · `loopAuditCarriesChain` · `spiralNotCut` · `runtimeThrottleAtCapacity` · `runtimeThrottleStaysLocal` · `protocolBudgetAtLimit` · `layersDoNotOverlap`

其中三条值得在走查时点名：

- `loopNotByHopBackstop` = `hopCountAtCut < maxHops`——**证明是处理者粒度命中的，不是跳数兜底救的场**。两者都会切断，只有前者满足「首次回访即切断」。
- `spiralNotCut` = D-2 改动的**全部意义**。没有这条等于没改。
- `layersDoNotOverlap` = 运行时层不产协议事件、协议层不产运行时事件——判据里「两层不得混写」的机器形态。

**独立核验点**

- `protocolBudgetAtLimit` 里的 `senderAgents > 1` 是负向证据：**多开 agent 名字不多拿配额**。走查时值得把这个数（31）念出来。
- 运行时层的 `E_RUNTIME_THROTTLED` **不入协议码表**，且入站判决的返回类型窄化到 `ProtocolErrorCode`——把运行时码回给对端是**编译错误**，不是一条约定。这一点可以现场用一次 `bun run typecheck` 的失败演示，但**不是判据要求**。

**已知边界与未覆盖**

- **回复类消息（`ack`/`task.result`/`error`/`pong`）不进判环表**。它们按 C-1 带原任务 `taskId` 回请求方，形状与「回访」完全一致——照判据字面实现会在**第一条 ack** 上切断 AC-2 的回程。判据本身不必改，但走查若被问到「那 ack 怎么不判环」，答案是 `@qianmo/protocol` 的 `isReplyType`。
- **运行时令牌桶在 M0 没有长驻的生产调用方**（agent 面的跨节点发送工具不在章程 §3 范围内）。现有生产接线只有一次性的 `residentWake` CLI 与复现脚本。**不得宣称「限流已在生产链路上跑了一个月」。**
- **`withHop` 的「转发前追加」半边有实现有用例，但 M0 没有第三方中转节点**，因此无生产调用方。
- 自动回复乒乓（每圈新 `taskId`）判环与跳数**都看不见**，只有运行时令牌桶抓得住——包内有专门用例把这件事说明白，而不是假装判环能管。

**录屏脚本**

1. 镜头给 `git rev-parse --short HEAD`；
2. 敲 `QIANMO_TRANSPORT_PSK=… bash demo/ac3-loop-rate.sh`；
3. 报告 JSON 出来后，镜头**逐条**给 `checks` 的十个 `true`（这一条的说服力全在「十条不合并」上，不要只给 `pass: true`）；
4. 单独放大三处观测值：`loop.hopCountAtCut`（2）与 `loop.maxHops`（8）并排、`spiral.loopEvents: 0`、`budget.senderAgents: 31`；
5. 镜头给 `loop_detected` 审计事件全文（trace-id 段、跳链、判环键三个字段齐全）；
6. **明确念出**：运行时层第 21 条**没上线**（`runtimeThrottleStaysLocal`），这不是「被对端拒了」。

**待办与 owner**

| 待办 | owner |
|---|---|
| 无阻塞项。走查现场直接复跑 | 主开发：喻永昌；方向辅助人：陈曦宇（backup 陈子轩） |

---

### 2.4 AC-4 · 项目记忆可跨会话检索唤醒

**判据指针**：`charter.md` §4 判据表 **AC-4** 行（判据一字未改）。三个数：

- 5 条不同决策，新开**无任何对话历史**的会话提问，命中 **5/5**；
- 输出中标注**记忆条目来源 ID 与写入时间**；
- 对**未写入的伪造决策**不产生幻觉引用。

roadmap P3.3 的 v2.2 补充另加一条同口径要求：**来源标注在两家供应商下均生效，切换供应商不改代码**。

**复现命令与前置条件**

```bash
export OPENAI_API_KEY=…      # 凭据只从环境变量来，仓库内无密钥
export OPENAI_BASE_URL=…
bun test tests/integration/qianmo-memory-recall.test.ts     # AC-4 真调用
bun test packages/recall                                     # 51 条包内用例，无需凭据
```

**无凭据时**：真调用整组自动 skip 并打印原因（本次实跑 `3 pass / 20 skip / 0 fail`），只留下不需要凭据的确定性检查。**没有一键 demo 脚本**——这条 AC 的复现载体是集成测试文件本身。

**实测数据**

| 项 | 数值 | 样本 | 日期 | 锚点 |
|---|---|---|---|---|
| 决策命中 | **10/10** | 5 条决策 × 2 家 provider | **未标注，未核到** | roadmap 速查表 P3.3 行 |
| 伪造决策引用数 | **0/6** | 3 条伪造 × 2 家 | 同上 | 同上 |
| 工具声明跨供应商一致 | 两家转换后**逐字相同** | 1 条确定性用例 | 本次实跑通过（无需凭据） | `tests/integration/qianmo-memory-recall.test.ts:383` |
| 包内用例 | **51 pass / 0 fail** | — | 2026-08-15 本次实跑 | `packages/recall/` |
| 集成用例 | **19 条**（3 确定性 + 5 决策 × 2 + 3 伪造 × 2） | — | 2026-08-15 本次实跑（真调用部分 skip） | 计数说明见 §6.4 |

**机器判据 check 清单**（无 report-core；判据落在用例断言上，逐条对应判据字面）

| 判据 | 落点 |
|---|---|
| 命中 + 标注来源 ID | `expect(answered.answer).toContain(expected.id)` |
| 标注**写入时间** | `expect(answered.answer).toContain(expected.createdAt)` |
| 无对话历史 | 每个问题**独立构造只含一条用户消息的 messages 数组**——没有前一轮、没有 resume、没有跨问题共享的助手轮 |
| 伪造决策零引用 | `expect(answered.report.accepted).toEqual([])`；引用逐个 `getEntry` 解析，**解析不到即无法被引用** |
| 供应商无关 | 同一 `qianmo_memory_answer` 工具定义（纯 JSON Schema、零供应商名）送进两条 provider，转换后逐字相同 |

**独立核验点**

- **「不产生幻觉引用」是一次查表，不是一句祈使**：模型凭空造的 ID 在记忆库里解析不到，进不了 `accepted`。走查时应把这句话说清楚——它是这条 AC 与「提示词让模型别乱说」的本质区别。
- **零 mock、零回放**：真 `FileMemoryStore`（临时目录里的真文件）+ 真 `@qianmo/recall` + 基座真适配链。

**已知边界与未覆盖**

- **候选集只按 scope 取、绝不按词过滤**——词过滤正是 D-6 实测到的「0 结果」失败面。当前是**小规模全量注入**（< 50 条 / < 20k 字符即全投）。**条目规模超过这个量级时，5/5 从「结构性保证」退回「概率」**，这是 M0 的真实边界。
- 不做向量检索（章程 N-8）。
- 记忆层单个损坏文件曾会让整次召回抛错（P2.3 评审打回项），已改为**部分结果 + 显式事件通道**；`getEntry` 定点查询仍抛错。走查若演示损坏场景，注意这两种行为不同。
- **最后实测日期在 roadmap 与文档里都没有写**，只能定位到 P3.3 完成的时间窗。走查时应现场重跑取得新日期。

**录屏脚本**

1. 镜头给 `git rev-parse --short HEAD`；
2. 先跑**无凭据**档：`bun test tests/integration/qianmo-memory-recall.test.ts`，镜头给 `3 pass / 20 skip` 与打印出来的跳过原因——**证明凭据门禁是真的**；
3. `export OPENAI_API_KEY/OPENAI_BASE_URL` 后重跑（镜头**不要拍到密钥**，先在别处 export 或用 `history -d`）；
4. 镜头给两家 provider 各 8 条用例全绿；
5. 放大 stderr 上的 `[AC-4][provider][key] 引用=… 答复="…"` 行——**每条决策的引用 ID 与答复正文**；
6. 放大三条伪造决策的 `[AC-4][provider][伪造:…] 模型给出的引用=… 判定=…`——镜头要停在「引用数为 0」上；
7. 补一个镜头给注入块本身（`buildRecallSystemPrompt` 的输出），证明**来源 ID 与写入时间在提示词里就带着**。

**待办与 owner**

| 待办 | owner |
|---|---|
| 现场重跑取得带日期与 SHA 的记录，补上「最后实测日期未核到」这个缺口 | 主开发：喻永昌；方向辅助人：董宗岳（backup 李怡康） |

---

### 2.5 AC-5 · 模型中立：同一任务在两家供应商下均跑通

**判据指针**：`charter.md` §4 判据表 **AC-5** 行（判据一字未改）。三条子判据：

- 同一编程任务在 **≥ 2 个不同模型供应商适配器**下均完成并通过任务自带的测试断言；
- 两次运行**仅修改配置文件，不改任何代码**；
- 适配器一致性测试套件（**多轮 / 工具调用 / 流式** 三项）对两家全绿。

`charter.md` §4.1 已决：AC-5 **不降级**，仍计为「我方实现的验收项」。

**复现命令与前置条件**

```bash
export OPENAI_API_KEY=… OPENAI_BASE_URL=…
# ① 一致性套件（三项 × 两条 provider）
bun test tests/integration/provider-adapter-consistency.test.ts
# ② 编程任务，两条 provider 各一次
bun run scripts/qianmo-provider-task.ts --provider qianmo-deepseek
bun run scripts/qianmo-provider-task.ts --provider qianmo-alt
# ③「命令行逐字相同、只改配置文件」的最强形态
cp tests/integration/fixtures/ac5-config-a.json /tmp/ac5-providers.json
bun run scripts/qianmo-provider-task.ts --provider qianmo-ac5 --providers-file /tmp/ac5-providers.json
cp tests/integration/fixtures/ac5-config-b.json /tmp/ac5-providers.json
bun run scripts/qianmo-provider-task.ts --provider qianmo-ac5 --providers-file /tmp/ac5-providers.json
```

无凭据时一致性套件 `3 pass / 6 skip / 0 fail` 并打印跳过原因（本次实跑复现）。每次运行把取证材料留在临时目录：`occ-stdout.json` / `occ-stderr.log` / `model-patch.diff` / `task-tests.log` / 该次用的 `config/providers.json`。

**实测数据**（2026-08-12，`docs/dev/p1.4-provider-verification.md` v0.1）

| 项 | 数值 | 强度 |
|---|---|---|
| 一致性三项 × 两条 provider | **6 个用例全绿**，零 mock 零回放 | 实测（§2） |
| 编程任务两条 provider | 各完成，任务自带断言 **5 pass / 0 fail**，测试文件 sha256 前后一致 | 实测（§3） |
| 「仅改配置不改代码」 | **最强形态**：两次运行命令行**逐字相同**，唯一变化是配置文件里的两行 | 实测（§3.2） |
| 第三条适配器路径（G-1 补齐） | 网关另提供 Anthropic **原生端点**；occ 走原生路径（不做消息转换、不走流适配）同样完成该任务，**5 pass / 0 fail** | 实测（§5 G-1） |

**机器判据 check 清单**（无 report-core；判据落在用例与脚本退出码上）

1. 一致性套件三项 × 2 provider = 6 个真调用用例全绿；
2. 编程任务脚本退出码 0 + 任务自带 `bun test` 5 pass / 0 fail；
3. 测试文件 sha256 前后一致（**证明模型没改测试来蒙混**）；
4. 两次运行的命令行逐字相同（§3.2 的判据形态）。

**独立核验点**

- **判据字面要的「两个不同供应商适配器」由 G-1 那条证据满足**：`openai-compat` 路径与原生 Anthropic 路径是**两段结构上完全不同的适配器代码**，不是同一段代码里的不同分支。走查时应以这条为主证据，`deepseek` × `strict-openai` 那对作为补充。
- 选 `deepseek` × `strict-openai` 不是随手挑的——它是 `COMPAT_PROFILES` 里唯一把三个开关（`supportsStreamUsageOption` / `supportsThinkingField` / `reasoningContentEcho`）全部拉开的一对。

**已知边界与未覆盖**

- **G-4 仍未关闭**：两条 provider（以及原生路径）**都指向同一个网关**。没有验证真实厂商端点之间的 HTTP 层差异——鉴权头形态、错误码语义、限流响应头、SSE 分帧习惯。**这恰恰是「换供应商」最容易翻车的地方。** 处置只需一份第二家直连凭据，套件本身不用改。
- **G-2**：`applyCompatRule` 在基座线上请求路径**没有任何调用者**，compat 档案目前是死代码，只有单测与本套件显式调用它。因此「档案的行为差异经过实测」成立，「基座跑起来时走这条路」**不成立**。
- **G-3**：空 `reasoning_content` 把最终助手消息切碎（实测一次两点问答被切成 **251 块**，其中 125 个空 thinking）。真实影响是**会话膨胀与回放成本**，**不是**任务输出丢失——原报告推出的「`result` 为空」（D-5）已被五次实测证伪并撤销。
- G-5 / G-6：一致性套件没覆盖 `queryModelOpenAI` 外层管线；没有失败面测试（超时 / 429 / 5xx / 模型不存在 / 密钥失效）。

**录屏脚本**

1. 镜头给 `git rev-parse --short HEAD`；
2. 先跑无凭据档，镜头给 `3 pass / 6 skip` 与跳过原因；
3. 设好凭据后跑一致性套件，镜头给 6 个真调用用例全绿；
4. **最有说服力的一段是 §3.2 的「逐字相同」**：镜头先 `diff` 两个配置文件（只有两行不同），再连敲两次**完全一样**的命令行，两次都给到任务自带测试 5 pass；
5. 镜头给两次运行的 `model-patch.diff`（模型各自写的实现不同）与测试文件 sha256（相同）——**实现变了、测试没变**；
6. 补一段原生 Anthropic 路径的运行（换 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`、不设 `CLAUDE_CODE_USE_OPENAI`），镜头给同样的 5 pass；
7. **明确念出 G-4**：三条路径仍指向同一网关，厂商 HTTP 层差异未验证。

**待办与 owner**

| 待办 | owner |
|---|---|
| 若走查前能拿到第二家**直连**凭据，重跑一次即可关闭 G-4；拿不到则在走查现场如实说明 | 主开发：喻永昌；方向辅助人：陈子轩（backup 董宗岳） |
| G-2 / G-3 的归属（P1.4 的尾巴还是另开任务包）待负责人表态，见 `p1.4-provider-verification.md` §7 | 负责人 |

---

### 2.6 AC-6 · 爆炸半径受控：越权被拒、删库可恢复

**判据指针**：`charter.md` §4 判据表 **AC-6** 行（判据一字未改）。**三个子项全部通过**才算：

- **(a)** 沙箱内向宿主白名单外路径写入被拒，产生审计事件；
- **(b)** 智能体 `rm -rf` 删除自身工作区后，由其**无删除权限**的备份在 **10 min 内**完整恢复，恢复后 `git status` 与删除前一致；
- **(c)** 智能体尝试删除备份本身时被拒。

§4.1 曾记录 AC-6(a) 的一个开放提请评审问题（沙箱是否直接采用基座权限模式作第一道、容器作第二道）——**已于 2026-08-17 由负责人决议关闭（章程 v2.11）：双层，结论与已验收形态一致**。

#### (a) 越权写被拒

**复现命令与前置条件**

```bash
QIANMO_SANDBOX_DAEMON_URL=… QIANMO_SANDBOX_DAEMON_TOKEN=… QIANMO_P13_SANDBOX=… \
  bash demo/ac6a-sandbox.sh
```

**前置**：Linux 真机 + Dormice daemon + **`docker` 在 PATH**（脚本用真实 `docker inspect` 做出生契约断言，并直接读 cgroup 计数器）。缺环境变量退出 2。

**实测数据**：**5/5**（roadmap 速查表 P1.3 行），脚本末尾输出 `{"sandboxName":…,"runtime":"runsc","passed":5,"total":5}`。**具体日期未在文档中标注，未核到。**

**机器判据 check 清单**（`demo/lib/ac6a-sandbox.ts`，五个探针，每个探针成功后写一条审计事件；任一失败即 `throw`）

| # | 探针 | 判据来源 | 审计事件 kind |
|---|---|---|---|
| 1 | 出生契约（真实 `docker inspect` + `runsc`） | 内核/控制面 | `runtime.attested`（失败时写 `runtime.noncompliant`） |
| 2 | 向 `/` 写入（`/qianmo-p13-denied`）**必须非 0 退出** | 判据 (a) 本体 | `filesystem.write_denied` |
| 3 | `sleep 30` 在 1 s 超时下**必须 137 退出** | 超时强杀 | `execution.timeout_enforced` |
| 4 | CPU 打满后 cgroup `cpu.stat` 的 `nr_throttled` 增长 | 内核计数器 | `resource.cpu_throttled` |
| 5 | 堆撑爆后 cgroup `memory.events` 的 `oom_kill` 增长 | 内核计数器 | `resource.memory_oom_killed` |
| 6 | 审计**可回查且无完整性问题**：每条 append 返回的 `eventId` 都能在 `query()` 里找到 | 留痕判据 | — |

**独立核验点**

- 探针 4 / 5 的证据是**内核 cgroup 计数器的前后差值**，不是 RPC 的返回值——OOM 时 daemon 可能丢掉 exec 流，**计数器才是证据**。这一点走查时值得点名：它是「测量而非宣称」的样板。
- 沙箱内先验 `command -v occ`，确保测的是**真的跑得起 occ 的沙箱**。

**已知边界与未覆盖**

- 架构钉死为「**occ 跑在沙箱内**」，不是「沙箱作为 occ 的受限执行区」。理由是硬的：daemon 的凭据**无权限分级**（销毁沙箱与执行命令同一把），**AC-6(c) 只能靠「智能体在物理上够不到 daemon」成立**；把 occ 放沙箱外这条判据直接不成立。
- 审计文件 0600、目录 0700，**无命令 / 输出 / 凭据字段**。
- §4.1 的 AC-6(a) 提请评审问题**已闭合**（负责人决议 2026-08-17，章程 v2.11）——走查时若被问到，答「双层：基座权限模式第一道、gVisor 容器第二道，书面结论在章程 §4.1 该行」。

#### (b)(c) 删库可恢复 / 备份删不掉

**复现命令与前置条件**

```bash
QIANMO_BACKUP_WRITE_TOKEN=… QIANMO_BACKUP_ARCHIVE_TOKEN=… bash demo/ac6b-restore.sh
```

**只需 `bun` / `git` / `tar`**，不需要沙箱与 daemon。工作区**由脚本自己在临时目录里新建，不接受外部路径**——一个会对操作员给的路径执行 `rm -rf` 的演示脚本本身就是事故。

**实测数据**（2026-08-14，本机）

| 项 | 数值 | 预算 |
|---|---|---|
| 恢复耗时 | **20 ms** | 10 min |
| `git status --porcelain` 与 `HEAD` | **逐字一致** | — |
| 只写凭据的 DELETE/PUT/PATCH | **四次全 405** | — |
| 只写凭据的列表 / 读取 | **两次全 403** | — |
| 快照 | 仍在 | — |

> **2026-08-15 本次走查复跑**（运行 ②，HEAD `b3cda44f`）：十一条 check 全 `true`、`pass: true`。恢复耗时 **20 ms**（预算 10 min；运行 ① 是 18 ms），删除前 `git status --porcelain` **3 行**（`gitStatusWasNonTrivial` 成立），四次 DELETE/PUT/PATCH 全 **405**、两次列表/读取全 **403**、快照仍在。见 §8.3 ~ §8.5。**这次复跑同样没有触到沙箱挂载边界**——它本机测不到，§4.1 的定夺照旧。

**机器判据 check 清单**（`demo/lib/ac6b-report-core.ts`，十一条不合并）

`workspaceWasDeleted` · `restoreSucceeded` · `withinBudget` · `gitStatusIdentical` · **`gitStatusWasNonTrivial`** · `headIdentical` · `execBitPreserved` · `removalRefused` · `writerCannotRead` · `denialsAudited` · `snapshotSurvives`

> `gitStatusWasNonTrivial`（要求 `statusLines >= 3`）是这十一条里最该在走查时点名的一条：**一个干净工作区恢复回来当然「一致」，那不是证据**。工作区造了五种状态（已提交 / 已暂存 / 未暂存 / 未跟踪 / 可执行位）。

**独立核验点**

- **边界不是 chmod，是一个进程**：POSIX 上「删掉一个文件」的权限来自它**所在目录**的写位，与「创建一个文件」是同一个位；sticky bit 只收窄成「只能删自己的」，而那正是本例要防的。所以只写这件事由**进程边界**承担——store 在宿主侧，沙箱只能经一个**没有删除动词**的 socket 面够到它。
- `@qianmo/backup` **全包没有任何删除路径**——不是带守卫的删除，是根本没有那个方法（三层守卫：类型 / 运行时 allowlist / import 期形状断言）。

**已知边界与未覆盖**（历史上 AC-6 判「部分」的原因；第一条已于 2026-08-16 闭合）

- **沙箱挂载边界本机测不到**：两侧同进程，测的是**凭据面与动词面，不是挂载**。真机部署仍需把 store 放在沙箱够不到的地方，并只把只写凭据（`QIANMO_BACKUP_WRITE_TOKEN`）注入沙箱。**→ 已于 2026-08-16 在真机（burn-vm-01，runsc 沙箱）实测闭合，28/28 check 全 true，见 §9.5。**
- **常驻节点里的任务前快照不等待**：等它就是把一次 `tar` 挡在 ack 前面，而 AC-2 的 ack 线是已经量过的预算。因此语义是「任务开始**前后**」而不是「任务开始的那一瞬」。要更强的保证得由掌握任务生命周期的调用方 `await beforeTask`——脚本化跑批可以，ACP turn 里不行。
- **M0 不做保留策略与轮转**（N-12）。

**录屏脚本**

1. **(a) 段**（真机）：镜头给 `docker inspect` 的 runtime 字段（`runsc`）→ 敲 `bash demo/ac6a-sandbox.sh` → 镜头给末行 `"passed":5,"total":5` → 再切一个镜头 `cat` 审计文件，给到五条事件的 `kind` 与 cgroup 计数器前后值（`nrThrottledBefore/After`、`oomKillBefore/After`）；
2. **(b)(c) 段**（本机即可）：敲 `bash demo/ac6b-restore.sh` → 镜头**必须**给到脚本打印的删除前 `git status --porcelain`（≥ 3 行，非平凡）→ 给到 `rm -rf` 那一步 → 给到恢复后的 `git status --porcelain` 与 `HEAD`，与删除前**并排比对**；
3. 镜头给报告 JSON 的十一条 `checks` 全 `true` 与 `elapsedMs`（20 ms 对 10 min 预算）；
4. 镜头给四次 405 与两次 403 的原始响应码；
5. **明确念出**：本机测的是凭据面与动词面；**沙箱挂载边界已于 2026-08-16 真机实测**（§9.5，28/28）——现场可加映 `report.json` 的 `layout.dockerMounts`（唯一可写 bind 是 workspace）与 `storeListEnoent` 等 ENOENT 探针。

**待办与 owner**

| 待办 | owner |
|---|---|
| ~~**(b)(c) 真机部署形态的挂载边界验证**（store 在沙箱挂载之外、沙箱内只有只写凭据）~~ **已完成（2026-08-16，§9.5，28/28 全 true）** | 主开发：喻永昌；方向辅助人：董宗岳（backup 陈子轩） |
| ~~(a) 现场复跑并记录日期与 SHA~~ **已完成（2026-08-16 真机复跑 5/5，§9.3）** | 主开发：喻永昌；方向辅助人：董宗岳（backup 陈曦宇） |
| ~~§4.1 AC-6(a) 提请评审问题的书面结论~~ **已决（负责人决议 2026-08-17，章程 v2.11：双层——基座权限模式第一道、gVisor 容器第二道）** | 负责人 |

---

### 2.7 AC-7 · 数模竞赛场景端到端连续演示

**判据指针**：`charter.md` §4 判据表 **AC-7** 行（判据一字未改）。要点：

- 一次 **≥ 10 min**、**全程无人工修改代码或数据**的连续演示；
- 六环节：提交建模任务 → 节点 A 失败并给出**原因级**诊断（明确报出「内存不足 OOM」而非「执行失败」）→ 向节点 B 发起资源协商 → 用户授权后建立加密隧道 → 任务在借用资源上跑完 → 隧道自动拆除并留痕；
- **连续 3 次执行成功 3/3**。

**复现命令与前置条件**

```bash
QIANMO_TRANSPORT_PSK=… QIANMO_P61_KEEP_ARTIFACTS=1 \
  make -C demo p61-accept       # 默认 SEED=6101 MINUTES=10 CHUNKS=20 ITERATIONS=3
```

`p61-accept` 内部循环三次 `make p61`，每次先 `p61-reset`。冒烟档是 `make -C demo p61-smoke`（1 min，**不得计入 3/3**）。需要 `bun` 与 `node`。**不需要沙箱、daemon 或模型凭据**。`QIANMO_P61_KEEP_ARTIFACTS` 非空即保留证据目录。

**实测数据**（**正式记录** = `scenario-mcm.md` §9 三行表 = roadmap v2.31）

| 轮次 | task ID | commit / 机器 | seed | durationMs | spanMs | checks | `pass` / `ac7Eligible` |
|---|---|---|---|---|---|---|---|
| 1 | `958fef1f-…` | `87c4609b` / macOS（Darwin 25.5.0 arm64） | 6101 | **600,988** | 509,992 | 七项全绿 | true / true |
| 2 | `722fb1ef-…` | 同上 | 6101 | **600,236** | 509,999 | 七项全绿 | true / true |
| 3 | `eddd4942-…` | 同上 | 6101 | **600,259** | 510,000 | 七项全绿 | true / true |

每轮 20/20 worker、600 + 1 条背景投递、结果 digest 三轮均为 `cdecda39b681…3bb266` 且与 expected 一致、`message_accepted=1210`、lender pending 0、审计链 intact、0 failure / 0 skipped。归档包 `p61-accept-87c4609b-20260815-082113.tar.gz`（sha256 `2be9d926…3140`），**暂存本地私有验收目录，仓库内无副本**。

> **前一组数字（600,357 / 600,445 / 600,407 ms，spanMs 509,994 / 509,977 / 510,000）是 2026-08-14 的首次 3/3**，跑在**未提交的工作树**上、产物按当时默认被清理，**无 SHA 可锚、无留档**，已被上表取代。见 §5.2。

> **2026-08-15 本次走查又跑了一遍 3/3**（运行 ①，HEAD `856d0ff8`，同一条 `make -C demo p61-accept`，`SEED=6101 MINUTES=10 CHUNKS=20`）：三轮 `durationMs` **600,533 / 600,259 / 601,168**，`spanMs` 509,987 / 509,987 / 509,997，七条 check 全绿、`pass` 与 `ac7Eligible` 三轮均 `true`，**结果 digest 三轮相同且与 expected 逐字相同（`cdecda39b681…3bb266`，与 §9 正式记录那次也相同）**。这是**第三组**数字，**不取代** `scenario-mcm.md` §9 的正式记录——正式记录仍以 §9 三行表为准，本次是「结项 HEAD 上能复跑」的证据。明细见 §8.3。

**机器判据 check 清单**（`demo/lib/p61-report-core.ts`，七条 + 一个 `ac7Eligible` 闸门）

`taskSubmitted` · **`diagnosisNamesOom`** · `leaseNegotiated` · `authorizedAndTokenMinted` · `computedOnBorrowedResource` · `tunnelTornDownClean` · `continuousNoIntervention`

`ac7Eligible = (mode === 'acceptance') && durationMs >= 600_000 && pass`——**冒烟档在结构上进不了验收记录**。

几条值得在走查时点名：

- `diagnosisNamesOom` 要求 `diagnosis.cause === 'oom'` **且证据非空**——判据字面的「原因级而非『执行失败』」在这里是机器判的。
- `computedOnBorrowedResource` 里有一组**双来源对账**：宿主计数器的 `tunnel.takenWork` 与审计侧的 `tunnel.admitted===1` + `tunnel.carried >= chunks-1` 必须同时成立，**两边同时成立才说明工作确实是从隧道进去的**。
- `tunnelTornDownClean` 要求 `redialFailed`——**「无残留」是再拨一次并要求失败测出来的**，不是 `stop()` 之后的祝愿。
- `continuousNoIntervention` 要求 `background.deliveredAfterTeardown > 0`——拆完隧道**常驻链路还在投递**，证明拆的是隧道不是整个网络。

**独立核验点**

- **`uncaught` / `skipped` 曾是硬编码字面量**（判据因此永远为真，恰违反本项目「测量而非宣称」纪律），落地前审计发现并改为**真处理器计数与计划/派发差集推导**。上表是修完之后重跑的。走查时应说明这段历史——它本身就是这份报告可信的理由。
- 三轮必须**严格串行连续**：`make -C demo p61-accept` 的循环保证了这一点。smoke、手工拼接的三次单跑、失败后在原目录修补再续跑，**均不得计数**（`scenario-mcm.md` §9 首句）。

**已知边界与未覆盖**（roadmap v2.30「诚实边界不藏」原样转述要点）

- **授权是脚本化本地同意（`scripted-hook`），不是真人点击**；
- **A / B 是同一个 runner 内的逻辑节点**——真实包 / 信封 / unix socket / 子进程，但**不是跨机生产拓扑**；
- unix 演示是 **WebSocket + PSK，不冒称 TLS**；
- 隧道**只 A→B**，结果由同一 runner 从 B store 读取；
- worker 与 runner **共用算法**；
- **生产接线仍归 P8.2**（即本次走查）。
- **真机（workbench-host）副本待补传**；`scenario-mcm.md` §9 明确「补传前『已归档真机』不得勾选」。
- P2.4（场景需求文档）**仍未完成**：赛中真实痛点待补写、全文待全员评审。**AC-7 已通过 ≠ P2.4 完成**——这两件事不要混。

**录屏脚本**

> **这是唯一一条录屏时长 ≥ 30 min 的 AC（三轮 × 10 min）。** 建议：完整录第 1 轮，第 2 / 3 轮录起止与报告即可，但**必须让镜头证明三轮是同一次 `p61-accept` 的连续输出**（不切断、不重开终端）。

1. 镜头给 `git rev-parse --short HEAD`、`bun --version`、`node --version`、`uname -a`；
2. 敲 `QIANMO_TRANSPORT_PSK=… QIANMO_P61_KEEP_ARTIFACTS=1 make -C demo p61-accept`；
3. 第 1 轮的六个环节，镜头逐帧停到：
   - 帧 1：任务提交（`p61.task-submitted`）；
   - 帧 2：**A 的子进程真实 OOM**（不是模拟）→ 诊断输出 `cause: "oom"` 与 `evidence`；
   - 帧 3：`resource.request` → `offer`（镜头给「报价永不大于请求」的三个字段对比）；
   - 帧 4：`scripted-hook` 授权 → 临时 Ed25519 签发 → `act: "user-confirmed"` 复验通过；
   - 帧 5：隧道打开 → 20 块逐块完成 → `resultDigest` 与 expected 逐字相同；
   - 帧 6：`release` → 隧道关闭 → **同址再拨失败** → 常驻链路仍在投递；
4. 每轮结束镜头给报告 JSON：七条 `checks` 全 `true`、`pass: true`、`ac7Eligible: true`、`durationMs`（≥ 600000）；
5. 三轮跑完镜头给三份报告并排（三个不同 task ID、同一 seed、同一 digest）；
6. 镜头给 `QIANMO_P61_KEEP_ARTIFACTS` 打印出的证据目录与归档包 sha256；
7. **明确念出五条诚实边界**（脚本化授权 / 逻辑双节点 / 非 TLS / 单向隧道 / 共用算法）。

**待办与 owner**

| 待办 | owner |
|---|---|
| 真机副本补传（workbench-host 恢复后），补传后才可勾选「已归档真机」 | 主开发：喻永昌；方向辅助人：李怡康（协同全体，喻永昌主持） |
| P2.4 的赛中真实痛点补写与全员评审（**不影响 AC-7 判定**，但影响 P2.4 的 DoD） | 方向辅助人：李怡康（backup 喻永昌） |

---

### 2.8 AC-8 · 通信边界问题沉淀为自动化回归用例

**判据指针**：`charter.md` §4 判据表 **AC-8** 行（判据一字未改）。四个数 + 一条流程约束：

- 五类边界（**触发时机 / 超时 / 消息风暴 / 欠费额度耗尽 / 异常退出**）**每类至少 2 条**；
- M0 结束时用例总数 **≥ 12 条**；
- **全部进 CI 且连续 5 次构建全绿**；
- 流程约束：M0 期间每修复一类边界问题，**同一 PR 内必须附带对应用例**，无用例的边界修复 PR 不予合入。

**复现命令与前置条件**

```bash
bun test tests/boundary                                        # ① 确定性边界库，无需任何前置
QIANMO_TRANSPORT_PSK=… ./demo/chaos-inject.sh --minutes 60      # ② 混沌跑批（可 --seed <n> 重放）
occ audit --verify                                             # ③ 审计链完整性
```

三条动作即 `docs/dev/boundary-day.md` 的「一次边界日」。混沌跑批**不需要沙箱与 daemon**；磁盘注入在 Linux 上用 `/dev/full`、macOS 上用 `hdiutil` 建的 1 MiB 真卷。

**实测数据**

| 项 | 数值 | 判据线 | 日期 / 锚点 |
|---|---|---|---|
| 边界用例总数 | **39 条**（本次实跑 `39 pass / 0 fail / 102 expect()`，6 个文件） | ≥ 12 | 2026-08-15 本次实跑 |
| 每类条数 | 触发时机 4 / 超时 6 / 消息风暴 9 / 额度耗尽 5 / 异常退出 5（**五类 = 29 条**）；另 `chaos-recovery` 10 条 | 每类 ≥ 2 | 同上 |
| 60 min 混沌跑批 | seed `2145259399`；**177 次注入**（kill-worker 42 / cut-network 47 / fill-disk 45 / clock-drift 43）；**7,389 条成功投递** | — | 2026-08-14 |
| 混沌结果 | 四类 `stalled` 全 0、**0 未捕获**、**0 unmapped**、审计链完好；87 条被捕获失败全部是实际 ENOSPC 且正确归到 disk full | — | 同上 |
| 恢复时间最大值 | kill-worker 103 ms / cut-network 513 ms / fill-disk 112 ms / clock-drift 103 ms | — | 同上 |
| **CI 5 连绿** | 五个 run 均 `completed / success`，**全部在同一 SHA `a8b06a9aee1f6fa84ea2c57593cc6129476256a1`**：`31799841764` / `31800391530` / `31800890960` / `31801288270` / `31801769324`。**2026-08-16 重取**：`d162fe721eadfb3b83e1189ae545c004d23c2344` 上串行 `workflow_dispatch` 五次，`31940540478` / `31940845668` / `31941139584` / `31941438394` / `31941752229` 均 `completed / success`（10:00Z–10:34Z） | 连续 5 次全绿 | 两组均已用 `gh run view` **逐个核到** |

> **2026-08-15 本次走查复跑**（运行 ②，HEAD `b3cda44f`）：**边界库 39 pass / 0 fail / 102 expect() / 6 files**（与上表逐字一致）；**60 min 混沌五条 check 全 `true`、`pass: true`**——seed `153528247`、**177 次注入**（kill-worker 36 / cut-network 43 / fill-disk 45 / clock-drift 53）、**四类 `stalled` 全 0**、`delivered=7380`、`uncaught=0`、**`unmapped=0`**（87 条被捕获失败全部是真 `ENOSPC` 且归到 `disk full`）、审计链 `intact`。各类恢复时间最大值：kill-worker 150 ms / cut-network 492 ms / fill-disk 112 ms / clock-drift 103 ms。见 §8.3 ~ §8.5。
>
> **CI 五连绿已于 2026-08-16 在 `d162fe72` 重取一次（5/5）**——重取前两次 dispatch 各红一次，红的都是 MCP watcher 正向用例（Linux 上首个 stat 之前的改动被当基线，用例已修，见 §4.5）；`a8b06a9` 那组仍作为首次证据保留。

**机器判据 check 清单**（`demo/lib/chaos-report-core.ts`，五条）

`noUncaught` · `everyKindInjected` · **`systemKeptWorking`** · `everyFailureMapped` · `trailIntact`

- **`systemKeptWorking` 是重心**：每次注入之后都记「系统又成功处理了多少条」，`progressAfter === 0` 即 `stalled`。**什么都不干的一小时同样没有未捕获异常**——所以「没崩」不是判据。
- `everyKindInjected`：四类里跑了三类的报告不是四类的证据；造不出来的如实记 `skipped` 并**判不通过**。
- `everyFailureMapped`：对不上已知边界的失败一条即判红（`unmapped`）。

**独立核验点**

- **注入器自己被这套判据抓到两次**，都已修：① 第一版 `fill-disk` 往一个**空的** 1 MiB 卷追加 200 字节，每次都成功——**一次什么都没注入的注入，比不注入更糟，它把假的绿色变成真的报告**；② 随机挑选会让短跑批**整类漏掉**，改为**先覆盖每类一次再随机**。走查时讲这两条比讲 177 次注入更有说服力。
- **CI 五连绿是在修完三处真实缺口之后才算的**：根包漏声明 `@qianmo/sandbox`（`acf5e57`）、Knip 不认识两个由 shell 启动的 demo runner（`36ce286`）、MCP watcher 正向用例把「收到事件」猜成固定等待 2.6 秒（`a8b06a9`）。三个 SHA 均已核到。
- **`scripts/test-shards.sh` 曾让「CI 绿」失去意义**：分片列表不含新目录，`demo/lib` 下的报告核心用例自 P4.1 起**从未在 CI 里跑过**。P5.4 把 `tests/boundary` 与 `demo/lib` 加进列表后实跑 53 个分片全绿。**这条缺口的形态值得在走查时说出来：它让「本地绿」与「CI 绿」同时成立，且第二个绿没有意义。**

**已知边界与未覆盖**

- **`docs/dev/boundary-day.md` 目前只有模板，没有一条填好的记录。**60 min 跑批的结果记在 roadmap v2.29，**没有回填到边界日记录表**。判据不要求边界日记录，但流程约束（每双周一次）**在文档上无执行痕迹**。
- 混沌跑批**默认不保留证据目录**（失败时才保留，路径打在 stderr）——与 `p73-baseline.sh` 相反。走查若要留档需自行保存 stdout。**v0.2 起这件事由 `demo/walkthrough.sh` 兜住**：它把每一项的 stdout 另抄一份（`chaos.stdout.txt`）并抽出报告 JSON（`chaos-report.json`），跑批成功时也留档。
- **CI 5 连绿锚定在 `a8b06a9`**，不是走查当天的 HEAD。判据字面只说「全部进 CI 且连续 5 次构建全绿」，未要求锚在结项 SHA 上。**是否需要在结项 HEAD 上重跑一次 5 连绿，需负责人定夺**（见 §4）。

**录屏脚本**

1. 镜头给 `git rev-parse --short HEAD`；
2. 敲 `bun test tests/boundary`，镜头给末行 `39 pass / 0 fail`，再 `ls tests/boundary/` 给六个文件名——**五类各一个文件 + chaos-recovery**；
3. 打开 `tests/boundary/README.md`，镜头给「五类与它们的 §8.3 出处」那张表（**每条用例都指向 `protocol.md` §8.3 的具体一行**）；
4. **混沌跑批不适合现场录 60 min**：建议现场跑 `--minutes 2 --interval-seconds 5` 的冒烟档并镜头给五条 `checks`，同时**放映 08-14 那份 60 min 报告**（seed `2145259399`、177 次注入、7,389 条投递、四类 `stalled` 全 0）；若走查时间允许，另起一台机器后台跑 60 min 正式档并在走查末尾回收结果；
5. 镜头给 `occ audit --verify` 的 `intact: true`；
6. 镜头切到 GitHub Actions 页面，给五个 run 的 **run id + conclusion success + 同一个 head SHA**（这是判据「连续 5 次构建全绿」的直接证据）；
7. 镜头给 `.github/pull_request_template.md` 的「本 PR 修复的边界问题对应哪条用例」必填段——**流程约束的证据**；
8. **明确念出**：39 条对 12 条的线；混沌判据的重心是「注入之后系统还在干活」而不是「没崩」。

**待办与 owner**

| 待办 | owner |
|---|---|
| 走查前补一次边界日并**回填 `boundary-day.md` 的记录表**（当前只有模板，零记录） | 主开发：喻永昌；方向辅助人：陈子轩（backup 陈曦宇） |
| 请负责人裁定：CI 5 连绿是否需在结项 HEAD 上重取 | 负责人 |

---

## 3. 判定与 DoD 口径

P8.2 的 DoD：**8 条全部 PASS，或未通过项 ≤ 2 条且有双签豁免决议**（章程 §4「豁免规则」：需说明根因、给出 M1 补做计划，由负责人 + 该方向 owner 双签；**豁免不得超过 2 条，否则 M0 判定为未通过**）。

**按现有证据，8 条判据都有达标实测，没有一条测出来是不达标的。**因此本表的判断是：

> **当前不存在「未通过」项。存在的是「证据已在、复跑受阻」与「子项未在目标环境验证」两类风险。**

这两类必须分开说，因为它们对应完全不同的处置：

| 类型 | 含义 | 属于「未通过」吗 | 处置 |
|---|---|---|---|
| **证据已在、复跑受阻** | 判据已有达标实测并留档，但走查现场无法重现（真机不可达 / 凭据不在手） | **不是**。判据的成立与否由实测决定，不由能否当场重演决定 | 放映留档报告 + 说明受阻原因；**是否接受留档作为走查证据，由负责人定夺** |
| **子项未在目标环境验证** | 判据的某个子项只在替代环境测过，目标环境未测 | **可能是**。取决于「替代环境的结论能否外推到目标环境」 | 需要负责人逐条裁定；不能外推的才进豁免流程 |

**本表不替负责人做这个判断。** 下面只把候选摆出来。

---

## 4. 需负责人定夺的候选项

按「最可能需要表态」排序。

### 4.1 AC-6(b)(c)：沙箱挂载边界真机未验证 —— **已于 2026-08-16 关闭（走了「补做」而非豁免）**

- **原缺口**：十一条 check 本机全绿，但**两侧同进程**，测的是**凭据面与动词面，不是挂载**；AC-6(c) 在真机部署下还要再加一条「store 目录在沙箱挂载之外」，本机测不出来。原文给负责人的两个定性选项是「(i) 判 PASS、挂载归部署事项」与「(ii) 判部分未通过并豁免、M1 补做」。
- **关闭方式**：**两个选项都没用——直接把真机验证做掉了**（原文「补做成本：低」的判断成立）。2026-08-16 在 burn-vm-01 的 runsc 沙箱（模板 `qm-p13`）里实测挂载边界 + 完整删库恢复链路，**28/28 check 全 true**：store（`/var/lib/qianmo/backups`）不在任何 docker/沙箱挂载之下、沙箱内全 ENOENT、HTTP 面无删除动词且拒绝全审计、`rm -rf` 后 60 ms 恢复且 git status / HEAD / exec 位一致。产物与逐条数字见 §9.5。**AC-6 三子项就此全部有真机/本机对应证据，不再需要豁免。**

### 4.2 AC-2 / AC-6(a)：真机不可达时的走查形态

- **事实**：两条都要 Dormice + gVisor 真机。roadmap v2.31 记录 **workbench-host 在 2026-08-15 全程 SSH 不可达**（TCP 通、无 banner，已排除本机因素）；P7.3 的正式数据也因此阻塞。
- **性质**：**「证据已在、复跑受阻」**，不是未通过。AC-2 有 08-13 的 10/10 留档，AC-6(a) 有 5/5 留档。
- **需要表态**：走查现场若真机仍不可达，
  - 放映留档报告是否算走查通过？
  - 还是把这两条挂起、等真机恢复后补录一次，再签结项？
- **不建议**的做法：把 AC-2 降级到本机 unix socket 复现——那会让「休眠态 = 沙箱冻结」这条 D-1 修订后的判据**当场不成立**。

### 4.3 AC-1 判据②：证据是叙述，不是留档 —— **已于 2026-08-16 关闭**

- **原缺口**：「不重放历史即可续答」的唯一记录是 roadmap v2.13 的文字叙述，无留档、`demo/ac1-restart.sh` 该节恒 SKIP。
- **关闭方式**：按本节处置建议做了一次现场并留档（§9.2）：CSPRNG 现生成的独特常量两轮写入 → 第三轮任务进行中 `kill -9`（退出码 137）→ `--resume` 单条追问（命令行与追问句均不含历史与常量）→ 回答逐字给出常量名与数值；`session.jsonl` 19 行自证无历史重发（被杀轮的 user 消息后无 assistant 回复）。14 项检查全过，产物与 sha256 见 §9.2。隔离与 `ac1-restart.sh` 同等（mktemp 配置根，事后核对真实 `~/.occ` 零写入）。

### 4.4 AC-5：G-4 定性

- **事实**：判据字面的「≥ 2 个不同供应商适配器」由 G-1 那条证据满足（openai-compat 与原生 Anthropic 是两段结构不同的适配器代码）。但**三条路径都指向同一个网关**，厂商 HTTP 层差异未验证（G-4）。
- **性质**：判据字面已满足；G-4 是**证据强度**问题不是判据问题。
- **需要表态**：结项材料里如何表述。`p1.4-provider-verification.md` §7 已把这件事挂在负责人名下，至今**未见书面结论**。

### 4.5 AC-8：CI 5 连绿的锚点

- **事实**：首组五连绿全部在 `a8b06a9`，走查时 HEAD 已推进（分支 `s4/p4.2-loop-and-rate`；v0.1 编制时 HEAD `6bada14c`，**§8 本机腿走查时 HEAD 已到 `856d0ff8`**）。判据字面不要求锚在结项 SHA 上。
- **2026-08-16 已重取一次（无需再表态）**：在 `d162fe72` 上串行 `workflow_dispatch` 五次全绿（run id 见 §2.8 数据表「CI 5 连绿」行）。**过程如实记**：重取前在 `74ff0154` 与 `0e9e7c3b` 各 dispatch 一次都红，红的都是 `src/services/mcp/__tests__/configWatcher.test.ts` 的正向用例（前者 5 s 超时，后者显式 15 s 仍超时）——不是节拍慢，是 **Linux 上 `fs.watchFile` 的首个 stat 异步落地、抢在它前面的写/删被当成基线永不上报**；在 Debian 13 x86_64 上原用例 15 跑 8 败、改文件前先等 1.5 s 则 15/15 绿。修在用例上（`d162fe72`：`settleWatcherBaseline()`；`0e9e7c3b`：显式预算，并坐实 bunfig `[test] timeout` 在 Bun 1.3.13 下不生效、全仓实际预算是默认 5 s），生产代码未动。结项 HEAD 若再推进，是否第三次重取由负责人按成本（约 35 min 串行）定。

### 4.6 不影响 AC 判定、但影响结项完整性的三项

这三项是**任务包 DoD 未满足**，不是 AC 未通过，别混在一起数豁免：

| 任务包 | 状态 | 缺什么 |
|---|---|---|
| **P2.4** 数模场景需求文档 | 🟡 草案 | 赛中真实痛点待补写 + 全员评审 |
| **P6.4** A2A 对齐评估报告 | 🟡 草案 | 全员评审未进行 |
| **P7.3** 性能与稳定性基线 | 🟡 本地腿就绪 | 正式 24 h 长跑、n=100 唤醒双阶梯、T3 吞吐正式表**全部待真机** |
| **P7.4** 上游同步演练 | 🟡 数据已入库 | 评审、章程 §5.7 回写、`BASE.md` 记录（负责人）三项 |

---

## 5. 文档内互相矛盾的数字（本表的判定）

**规矩**：矛盾一律列出，给出判断与理由，不悄悄选一个。

### 5.1 AC-2 的 ack P95 与 result max —— **三处写法，两组数字**

| 出处 | ack P95 | result max |
|---|---|---|
| roadmap **v2.20 变更记录**（line 53） | **8.022 s**（p50 2.490 s） | **12.422 s**（p50 3.471 s） |
| roadmap **完成状态速查 P4.1 行**（line 211） | **8.022 s** | **12.422 s** |
| roadmap **v2.16 决策①的「已闭合」补注**（line 90） | 4.440 s | — |
| roadmap **P4.1 任务包「验收完成」条**（line 548） | 4.440 s | 5.885 s |

**判定：正式记录取 `ack P95 = 8.022 s`、`result max = 12.422 s`。** 三条理由：

1. **两处 4.440 s 的写法都把 v2.20 变更记录列为自己的出处**（line 90 写「已闭合（v2.20…）」、line 548 写「基准报告见 v2.20 变更记录」），而 v2.20 原文写的是 8.022 s。**引用与被引用不一致时，被引用的那份是源。**
2. **完成状态速查表自称「完成状态的唯一出处」**，它写的是 8.022 / 12.422，与 v2.20 一致。**二对二时，规则说了算。**
3. v2.20 那组数字**自带内部一致性**：它同时给出 p50（2.490 / 3.471）、P95 = max、以及「第 2 ~ 10 轮 ack 在 2.073 ~ 3.483 s」的区间，并解释了 P95 等于 max 的原因（第 1 轮冷链路建连）。**4.440 / 5.885 那组没有任何配套数字**，无法自洽校验。

**推测（未核实，仅供负责人参考）**：4.440 / 5.885 可能来自评审九条修复**之前**的一次跑批——v2.20 特别注明其数字「跑在评审九条修复之后的构建上，与合入 main 的代码一致」，这句限定暗示存在一次修复前的跑批。**仓库内未见那份报告，未核到。**

**处置建议**：roadmap 的 line 90 与 line 548 需要勘误。**本表不改 roadmap**（P8.2 只产出本表），请负责人决定是否回写。

### 5.2 AC-7 的三轮时长 —— **两组，其中一组已被明确取代**

| 出处 | 三轮 durationMs | spanMs |
|---|---|---|
| roadmap **v2.30**（2026-08-14 首次 3/3） | 600,357 / 600,445 / 600,407 | 509,994 / 509,977 / 510,000 |
| roadmap **v2.31** + **速查表 P6.1 行** + **`scenario-mcm.md` §9**（重跑） | **600,988 / 600,236 / 600,259** | **509,992 / 509,999 / 510,000** |

**判定：正式记录取第二组。** 这不算「未声明的矛盾」——v2.31 与 `scenario-mcm.md` §9 都**明写**首次 3/3「跑在未提交的工作树上且成功产物按当时默认被清理，无 SHA 可锚、无留档，被本次取代」。**但走查材料里必须只用第二组**，否则会出现两套数字并存的观感问题。

### 5.3 P1.2 的状态：任务包标题 vs 速查表

- 任务包标题（line 408）：**「状态：⚠️ 基本完成，AC-1 一条判据需凭据待补」**
- 完成状态速查表 P1.2 行（line 199）：**「✅ 已完成」**，并写明最后一条判据已于 2026-08-12 真机补测通过。

**判定：以速查表为准（它自称唯一出处，且 v2.13 变更记录明确「P1.2 转为已完成」）。任务包标题未同步，属回写遗漏。**

### 5.4 `session-persistence-review.md` §0 的两条结论已过期

- 第 7 条把「`--resume` 时间戳并列丢尾部消息」记为**必须处置的新缺口** —— 修复提交 `3e7a401` 已在，且被速查表 P1.2 行列为证据。
- 第 8 条写「不重放历史即可续答**需凭据，未测**」 —— 已于 2026-08-12 补测通过（v2.13）。

**判定：以 roadmap 速查表与 v2.13 为准，review 文档 v0.1 未回写。** 走查若放映该文档，需口头补一句。

### 5.5 roadmap 文头「依据」栏指向 charter v2.4，charter 实际已到 v2.9

> **已修**（roadmap v2.35，2026-08-15）：文头「依据」栏已对齐章程版本；下文保留为核对记录。

roadmap 文档版本 v2.34 / 生效 2026-08-15，其文头「依据」栏写 `charter.md` **v2.4**；charter 当前是 **v2.9**（v2.9 只回写 §5.7，§4 自 v2.8 未动）——原为 **v2.8**（2026-08-12 生效，P0.8 判据修订通过）。roadmap 正文多处正确引用「章程 v2.8」，**只有文头那一栏没跟上**。属指针失修，不影响判据。

### 5.6 「尚未开始且需要人的」清单未收尾

> **已修**（roadmap v2.35，2026-08-15）：P0.1 已按 v2.10 口径从该清单移除，悬空顿号一并清理；下文保留为核对记录。

roadmap line 245 仍列 **P0.1**（5 人各自跑通）与 **P0.2**，但 v2.10 已把 P0.1 的 DoD 重述并**实测通过**（干净 clone + `--frozen-lockfile` + precheck 9217 pass / 0 fail），「逐人跑通降级为按需自查，不再阻塞」。该行末尾还有一个悬空的顿号。**P0.2（全员通读与能力盘点定稿）确实仍未完成。**

---

## 6. 核对记录

本节列出编制本表时**实际执行过的核验**。凡未列入本节的数字，一律来自被引用文档的原文转述，**本表不为其真实性背书**。

### 6.1 SHA 存在性（`git cat-file -e <sha>^{commit}`，19 个全部命中）

| SHA | 提交标题 |
|---|---|
| `3380c88` | feat: 导入 open-claude-code v2.38.3（848ad8c2）作为基座 —— 零改动快照 + BASE.md 溯源 |
| `67f6081` | 立项初始化：工程地基、立项章程与路线图、基座调研报告 |
| `74f7a22` | chore: 撤下洁净室自研脚手架（基座路线变更前置清理） |
| `8ac2b14` | merge: S0 P0.3 身份隔离（方案 A 三者共存） |
| `bb496a6` | merge: S0 P0.4 CI 门禁移植与裁剪 |
| `507b8fb` | merge: S0 P0.5 协议资产处置复核 |
| `35ab634` | merge: S0 P0.7 宿主加固脚本入库与绑定不变式 |
| `682ffff` | merge: S1 P1.1 消息协议草案 v0.1 |
| `5fd3853` | merge: S1 协议信封 v0.1 落地 |
| `5508358` | merge: S1 P1.2 会话持久化能力核验与常驻缺口清单 |
| `3e7a401` | merge: 修复 --resume 时间戳并列丢尾部消息 |
| `15c7eb8` | merge: S2 P2.1 前半 —— 注册键改 `<node>/<agent>` 复合键 |
| `3e6d407` | merge: S2 @qianmo/memory 分层记忆 |
| `ba8237f` | chore(gates): unused 棘轮 exports 1253 → 1252 |
| `acf5e57` | fix(workspace): 补上 sandbox 根依赖 |
| `36ce286` | fix(knip): 把两个 demo runner 纳入入口图 |
| `a8b06a9` | test(mcp): watcher 正向用例等待真实文件事件 |
| `87c4609b` | docs(a2a): P6.4 A2A 对齐评估报告 v0.1 草案 |
| `6bada14c` | fix(test): legacy 目录只读断言不再依赖 readdir 顺序（编制本表时的 HEAD） |

> **注**：`87c4609b` 的提交标题是一份 A2A 文档，而它被引作 AC-7 正式记录的锚点。这不矛盾——AC-7 的重跑是在**该提交所对应的工作树**上执行的，锚的是代码状态不是提交内容。走查时若被问到，按这个说法答。

**`848ad8c2`（上游 pin）在本仓库不是有效 git 对象**，本表未对它做存在性核验——这是预期行为（CLAUDE.md §0）。

### 6.2 路径存在性（`ls`，全部命中）

`demo/ac1-restart.sh` · `demo/ac2-wake-forward.sh` · `demo/ac3-loop-rate.sh` · `demo/ac6a-sandbox.sh` · `demo/ac6b-restore.sh` · `demo/p41-task-result.sh` · `demo/p61-e2e.sh` · `demo/chaos-inject.sh` · `demo/p31-resident-wake.sh` · `demo/p51-diagnosis.sh` · `demo/p73-baseline.sh` · `demo/Makefile` · `scripts/qianmo-provider-task.ts` · `scripts/qianmo-programming-tasks.ts` · `tests/integration/provider-adapter-consistency.test.ts` · `tests/integration/qianmo-memory-recall.test.ts` · `tests/integration/qianmo-loop-and-rate.test.ts` · `src/cli/handlers/qianmoAudit.ts` · `docs/dev/baseline-m0.md` · `docs/dev/session-persistence-review.md` · `docs/dev/p1.4-provider-verification.md` · `docs/dev/scenario-mcm.md` · `docs/dev/boundary-day.md` · `tests/boundary/README.md` · `.github/pull_request_template.md`

report-core 全部命中：`demo/lib/{ac3,ac6b,p41,p61,chaos,p51,p73}-report-core.ts`（`demo/lib/p31-report-core.ts` 存在但**不含 `checks` 结构**，AC 判据不经它）。

### 6.3 check 项名（从 report-core 源码逐字抄出，非转述）

| AC | 文件 | 条数 | check 名 |
|---|---|---|---|
| AC-2 | `demo/lib/p41-report-core.ts` | **8** | `rounds` `successRate` `ackP95` `resultMax` `frozenBefore` `closedReplies` `noStrayReplies` `resolvedByRegistry` |
| AC-3 | `demo/lib/ac3-report-core.ts` | **10** | `loopCutAtFirstRevisit` `loopReportedToSender` `loopNotByHopBackstop` `loopAuditEvent` `loopAuditCarriesChain` `spiralNotCut` `runtimeThrottleAtCapacity` `runtimeThrottleStaysLocal` `protocolBudgetAtLimit` `layersDoNotOverlap` |
| AC-6(b)(c) | `demo/lib/ac6b-report-core.ts` | **11** | `workspaceWasDeleted` `restoreSucceeded` `withinBudget` `gitStatusIdentical` `gitStatusWasNonTrivial` `headIdentical` `execBitPreserved` `removalRefused` `writerCannotRead` `denialsAudited` `snapshotSurvives` |
| AC-7 | `demo/lib/p61-report-core.ts` | **7** + `ac7Eligible` | `taskSubmitted` `diagnosisNamesOom` `leaseNegotiated` `authorizedAndTokenMinted` `computedOnBorrowedResource` `tunnelTornDownClean` `continuousNoIntervention` |
| AC-8（混沌） | `demo/lib/chaos-report-core.ts` | **5** | `noUncaught` `everyKindInjected` `systemKeptWorking` `everyFailureMapped` `trailIntact` |
| AC-6(a) | `demo/lib/ac6a-sandbox.ts` | **5 探针**（无 checks 对象，失败即 throw，末行输出 `passed:5,total:5`） | `runtime.attested` / `filesystem.write_denied` / `execution.timeout_enforced` / `resource.cpu_throttled` / `resource.memory_oom_killed` |
| （P5.1，AC-7 帧 2 的支撑） | `demo/lib/p51-report-core.ts` | 6 | `allCategoriesInjected` `enoughSamplesPerCategory` `overallAccuracyMet` `everyCategoryAboveHalf` `noUnknownVerdicts` `everyVerdictHasEvidence` |

AC-1 / AC-4 / AC-5 **没有 report-core**：AC-1 的判据是脚本内 `PASS`/`FAIL` 计数（`FAIL != 0` → 退出码 1），AC-4 / AC-5 的判据是集成测试的断言。

### 6.4 用例数实数统计（本次实跑，非转述）

| 对象 | 命令 | 结果 |
|---|---|---|
| 边界库 | `bun test tests/boundary` | **39 pass / 0 fail / 102 expect() / 6 files**，与 roadmap 的「39 条」**一致** |
| 边界库分文件 | `grep -c` | `abnormal-exit` 5 · `chaos-recovery` 10 · `message-storm` 9 · `quota-exhaustion` 5 · `timeouts` 6 · `trigger-timing` 4 = **39**；**五类（不含 chaos-recovery）= 29**，与 P5.4 的「29 条」一致；**每类均 ≥ 2** |
| `@qianmo/recall` 包内 | `bun test packages/recall` | **51 pass / 0 fail / 5 files**，与 roadmap 的「51 包内用例」**一致** |
| AC-4 集成 | `bun test tests/integration/qianmo-memory-recall.test.ts` | 无凭据：**3 pass / 20 skip**，bun 报「Ran 23 tests」。**真实用例数 = 19**（3 确定性 + 5 决策 × 2 provider + 3 伪造 × 2 provider）；多出的 4 个是 bun 把每个 `describe` 的 `beforeAll`/`afterAll` 各记为一条 `(unnamed)` 跳过项（junit reporter 逐条核实）。**roadmap 的「19 集成用例」正确，bun 的 23 会误导——走查时按 19 说** |
| AC-5 一致性 | `bun test tests/integration/provider-adapter-consistency.test.ts` | 无凭据：**3 pass / 6 skip / 0 fail**，与 `p1.4-provider-verification.md` §6 写的「3 pass / 6 skip / 0 fail」**逐字一致**；有凭据时的 6 个真调用用例即「三项 × 两条 provider」 |
| provider fixture | `cat tests/integration/fixtures/qianmo-providers.json` | 确为 **2 条**（`qianmo-deepseek` / `qianmo-alt`；后者原名 `qianmo-qwen`、2026-08-17 按 §9.4 替换为 kimi-k3 并中性化 id，`cff9b138` / `cfd68052`），`kind` 均为 `openai-compat`，`baseUrl` **相同**（G-4 的直接证据） |

### 6.5 CI 5 连绿（`gh run view <id>`，五个全部核到）

| run id | conclusion | status | headSha |
|---|---|---|---|
| `31799841764` | `success` | `completed` | `a8b06a9aee1f6fa84ea2c57593cc6129476256a1` |
| `31800391530` | `success` | `completed` | 同上 |
| `31800890960` | `success` | `completed` | 同上 |
| `31801288270` | `success` | `completed` | 同上 |
| `31801769324` | `success` | `completed` | 同上 |

**五次全绿、且全部锚在同一个 SHA 上**——这正是判据「连续 5 次构建全绿」要的形态。

### 6.6 其他核到的事实

- `.github/pull_request_template.md` 第 10 ~ 15 行确有「本 PR 修复的边界问题对应哪条用例」必填段，含「先写出会红的测试再让它变绿」的表述——**AC-8 流程约束的证据成立**。
- `package.json` 有 `verify:p32`（`bun run scripts/qianmo-programming-tasks.ts`）与 `verify`（含 `check:cycles` / `check:unused` / `check:bundle`）。
- `demo/ac1-restart.sh` 第 5 节确为**无条件 `skip`**（源码中是固定文案，无凭据探测分支）——「脚本不覆盖 AC-1 判据②」是代码事实，不是推测。
- `demo/lib/p61-report-core.ts` 的 `ac7Eligible` 确实要求 `mode === 'acceptance' && durationMs >= 600_000 && pass`。
- `docs/dev/boundary-day.md` 全文 53 行，**「## 记录」下只有一个空模板**，零条已填记录。

### 6.7 未核到的项（如实列出，不补）

| 项 | 为什么未核到 |
|---|---|
| AC-4 的最后实测日期 | roadmap 与相关文档均未标注具体日期 |
| AC-6(a) 真机 5/5 的具体日期与机器 | 速查表 P1.3 行只写结论，未标日期 |
| AC-1 判据②的留档报告 | 仓库内不存在该报告文件；只有 roadmap 的文字叙述 |
| AC-1 实测所用机器 | `session-persistence-review.md` 未标注 |
| ack P95 4.440 s / result max 5.885 s 的原始报告 | 仓库内未见对应报告，无法判断它出自哪次跑批 |
| AC-2 / AC-7 / P3.1 / P3.2 的原始记录与归档包 | 按纪律留在验收机与本地**用户私有目录**（0700 / 0600），仓库内无副本，本表不记路径 |
| ~~`demo/ac1-restart.sh` 在 `3e7a401` 之后第 4c 段报 `ok` 还是 `warn`~~ | **v0.2 已核到**：§8.4 实跑，两个规模点位均 `ok`、`WARN=0`（编制 v0.1 时未跑该脚本） |
| 三份基准报告的原始 JSON | 同上，均在私有目录 |

---

## 7. 走查日程模板（v0.2 收缩版）

**v0.1 的一整天日程作废。**本机腿（AC-3 / AC-6(b)(c) / AC-7 / AC-8 + AC-1 脚本部分）已由 `demo/walkthrough.sh` 跑完并留证（分两轮跑的，原因见 §8.3），见 §8——**它们不再占走查现场的时间，现场只做放映与问答**。

**真人还剩三件事**，合计约半天：

| 序 | 事 | 预计耗时 | 需要谁在场 | 需要什么 | 判据落点 |
|---|---|---|---|---|---|
| **1** | **真机两条**：AC-2（`demo/p41-task-result.sh`）+ AC-6(a)（`demo/ac6a-sandbox.sh`） | 65 min | 主开发 + 陈曦宇 + 董宗岳 | **Dormice + gVisor 真机可达**；AC-2 八个环境变量、AC-6(a) 三个 | §2.2 / §2.6(a) 的 check 清单与独立核验点 |
| **2** | **凭据三条**：AC-4 / AC-5 一条命令跑完；AC-1 判据②另做一次真调用现场 | 30 min（脚本）＋ 20 min（AC-1② 现场） | 主开发 + 董宗岳 / 陈子轩 | 一份 provider 凭据（仓库外文件），AC-5 若有第二家**直连**凭据一并用上（关 G-4） | §2.4 / §2.5 的用例断言；AC-1② 见 §2.1 录屏脚本第 5 步 |
| **3** | **判定与豁免评审** | 45 min | **全体 + 负责人 + 安全 owner** | §8 的 `summary.json` + 真机与凭据两批结果 | §4 五个候选逐条表态；若有豁免，当场形成**双签决议** |

**第 2 件的「一条命令」**（凭据只从仓库外的文件 `source` 进环境，`walkthrough.sh` 只探测变量存在与否，不打印值、不落盘）：

```bash
source <凭据文件> && demo/walkthrough.sh --only ac4,ac5,ac5e2e
```

它跑三项：AC-4 真调用集成测试、AC-5 一致性套件、AC-5 的「命令行逐字相同、只改配置文件」两跑（`p1.4-provider-verification.md` §3.2 那个形态）。产物与本机腿同形：transcript + `summary.json`。
**AC-1 判据②进不了这条命令**——它要的是一次真实多轮任务现场（在对话里由文件规则算出代号、`kill -9`、`--resume` 后追问），脚本化就失去了意义。这是本表里**唯一真正需要真人操作键盘**的判据。

**约束三条**（v0.1 的三条里，只有这些还成立）

1. **真机两条必须排在同一段**——真机一旦可达就一次做完，避免二次窗口。真机不可达时改为「放映 08-13 / P1.3 留档 + 说明受阻」，并在第 3 件里单独表态（§4.2）。
2. **第 3 件必须有负责人与安全 owner 双人在场**——豁免决议要双签（章程 §4），事后补签会让决议的时间点说不清。
3. **本机腿若要在现场重跑**，直接 `demo/walkthrough.sh --skip-slow`（约 15 s 跑完 AC-3 / AC-6(b)(c) / AC-8），不要手工一条条敲——手敲会漏掉环境快照与 sha256。

**走查现场必须产出的三样东西**（口径不变，只是第一样的形态换了）

- 本表判定列逐条填写完毕，且每条都能指向证据：本机腿指向 §8 的 transcript sha256，真机腿与凭据腿指向当场产生的报告；
- §4 五个候选的书面表态；
- 若有豁免：根因 + M1 补做计划 + 负责人与该方向 owner 双签（**豁免上限 2 条**）。

---

## 8. 走查记录（本机腿，2026-08-15）

**这一节记的是「实际跑了什么、跑出了什么」，不是预判。**每个数字都出自本次实跑的 transcript 或报告 JSON，路径与 sha256 逐条列在 §8.5。

### 8.1 驱动、产物形态、以及 transcript 替代了什么

本机腿由 [`demo/walkthrough.sh`](../../demo/walkthrough.sh) 一次驱动跑完：

```bash
demo/walkthrough.sh --with-ac7 --with-chaos 60          # 本次用的就是这条
demo/walkthrough.sh --skip-slow                         # 现场想快速复跑三项快项（约 15 s）
source <凭据文件> && demo/walkthrough.sh --only ac4,ac5,ac5e2e   # 凭据腿补齐
demo/walkthrough.sh --list                              # 看全部项目 id
```

它做四件事，缺一不可：

| # | 做什么 | 为什么 |
|---|---|---|
| 1 | 每一项都跑在 `script -q` 下，落一份**完整终端 transcript** | 这是**录屏的机器可核对替代**：逐行、不可裁剪、带 sha256，且**能 grep**（录屏不能） |
| 2 | 抓每个 demo 自己 emit 的**报告 JSON**（判据的机器形态）单独存盘 | 判定不看人念了什么，看 `checks` 里那几个布尔 |
| 3 | 记录起止时间、退出码、`git rev-parse HEAD`、机器与运行时版本 | 「哪次构建、哪台机器、跑了多久」是证据的一部分 |
| 4 | 写 `summary.json` 与 `SUMMARY.md`（每项 pass/fail/skip + 依据行 + transcript sha256） | 一份能直接进结项材料的汇总 |

**transcript 替代什么、不替代什么**——这一条要在走查现场说清楚：

- **替代**：v0.1 各节「录屏脚本」里要求的**录屏文件**这一交付形态。镜头要停的那几行，现在以文本形式逐行在 transcript 里，且有 sha256 锚定，任何人可离线复核。
- **不替代**：① 真人在镜头前**念出的口头限定**（各 AC 的诚实边界，见各节「已知边界与未覆盖」）；② 真机（AC-2 / AC-6(a)）与凭据（AC-1 判据② / AC-4 / AC-5）这两类**本来就不在本机腿内**的东西；③ 答辩现场的问答。
- **真人录屏仍可在答辩前补拍**（各节「录屏脚本」原样可用），但**判定不再依赖它**——判定依赖的是 transcript + 报告 JSON + sha256。

**凭据与秘密的处置**（走查若被问到，答案在这里）：

- 驱动**只探测** `OPENAI_API_KEY` / `OPENAI_BASE_URL` **是否存在**，不读值、不打印、不落盘；本次两者都不在，AC-4 / AC-5 如实记 `skip` 并打印补齐命令。
- 子命令需要的 `QIANMO_TRANSPORT_PSK` / 两把 backup token 由驱动**每次现生成**（`/dev/urandom` 32 字节 → 64 hex）经环境变量注入，**不写进任何文件**，进程结束即弃。**不复用 `demo/env/`**（那是 P8.1 的演示拓扑，与验收走查是两件事）。
- 产物目录 `0700`、文件 `0600`，落在**仓库外**的私有验收目录；仓库内只留本节的 sha256 与关键数字。

### 8.2 环境快照

| 项 | 值 |
|---|---|
| 日期 | **2026-08-15**（本机 PDT）；transcript 与产物目录名用的是 UTC，所以里面写的是 `2026-08-16T04:47…Z` / `…T05:58…Z` —— **同一天的同一段时间，不是两天** |
| HEAD | 本机腿跑了**两次**：运行 ① 在 **`856d0ff8`**、运行 ② 在 **`b3cda44f`**。为什么是两次、哪一项取哪一次，见 §8.3 |
| 工作树 | 两次都是 `dirty: true` —— 改动只有**文档**与**未跟踪的新文件**（`demo/walkthrough.sh` 本身、并行工作中的各包 README）。**被测代码没有未提交的改动**，走查现场可当场 `git status` 复核 |
| 机器 | `Darwin CornnaMacBook-Pro.local 25.5.0 … arm64`，macOS 26.5.2（25F84） |
| 运行时 | bun 1.3.13 / node v26.3.0 / GNU Make 3.81 |
| 凭据 | `OPENAI_API_KEY` 不在、`OPENAI_BASE_URL` 不在（只探测存在与否） |
| 真机 | 未接入。AC-2 / AC-6(a) 不在本次范围内 |

> **两次的 HEAD 都不是 v0.1 的 `6bada14c`**：v0.1 编制于 `6bada14c`，其后主线继续推进（S8/S9 的一串提交，其中包括一次**对 AC-3 量具本身的修订**——见 §8.3）。**§8 的每个数字都标了它属于哪一次运行、哪个 SHA。**

### 8.3 结果表：哪一项取哪一轮

本机腿实际跑了**两轮**，都是同一条驱动、同一台机器、同一天。如实记下来：

| 轮 | 产物目录（私有，仓库外） | 起 / 止（UTC） | HEAD | 跑了哪些项 | 结局 |
|---|---|---|---|---|---|
| **①** | `~/qianmo-acceptance/20260816T044739Z/` | 04:47:39Z / — | `856d0ff8` | `ac3` `ac6b` `ac8` `ac1` `ac7` `chaos` | 前五项全绿（`ac7` 用时 1802 s）；**混沌步跑到第 33 min 被外部 `SIGTERM` 打断**，见下方「① 的混沌为什么没有报告」 |
| **②** | `~/qianmo-acceptance/20260816T055831Z/` | 05:58:31Z / 06:59:05Z（3634 s） | `b3cda44f` | `ac3` `ac6b` `ac8` `ac1` `chaos`（60 min） | **五项全 pass、0 fail、0 interrupted**，`summary.json` / `SUMMARY.md` 齐 |

**判定逐项取哪一轮**（同一项两轮都跑过时取更靠后的 HEAD）：

| # | 项 | AC | 取自 | HEAD | 判定 | 退出码 / 用时 | 关键数字 |
|---|---|---|---|---|---|---|---|
| 1 | `ac3` | **AC-3** | 轮 ② | `b3cda44f` | **PASS** | 0 / 1 s | **十条 check 全 `true`**；`hopCountAtCut=2 < maxHops`；`spiral.loopEvents=0`；`senderAgents=31`；`sent=601`、`accepted=LIMITS.ratePerMinute`、`burstElapsedMs=23`、`refillAllowance=0` |
| 2 | `ac6b` | **AC-6(b)(c)** | 轮 ② | `b3cda44f` | **PASS** | 0 / < 1 s | **十一条 check 全 `true`**；`elapsedMs=20`（预算 600,000 ms）；`statusLines=3`（非平凡工作区）；`removalStatuses=[405,405,405,405]`；`listStatus=403`、`readStatus=403`；`snapshotSurvives=true` |
| 3 | `ac8`（边界库） | **AC-8** | 轮 ② | `b3cda44f` | **PASS** | 0 / 2 s | **39 pass / 0 fail / 102 expect() / 6 files** |
| 4 | `chaos`（60 min） | **AC-8** | 轮 ② | `b3cda44f` | **PASS** | 0 / 3623 s | **五条 check 全 `true`**；seed `153528247`；**177 次注入**（kill-worker 36 / cut-network 43 / fill-disk 45 / clock-drift 53），**四类 `stalled` 全 0**；`delivered=7380`；`uncaught=0`；**`unmapped=0`**（87 条被捕获失败全部是真 `ENOSPC` 且归到 `disk full`）；`trailIntact=true` |
| 5 | `ac1`（脚本部分） | **AC-1** | 轮 ② | `b3cda44f` | **PASS**（判据②如实 SKIP） | 0 / 8 s | **`PASS=24  FAIL=0  WARN=0  SKIPPED=1`**；`[small] --resume` 冷启动 **0.451 s**、`[large]` **0.464 s**，两者 ≤ 10 s；4c 段两个规模点位均 `ok` |
| 6 | `ac7` | **AC-7** | **轮 ①** | `856d0ff8` | **PASS（3/3）** | 0 / 1802 s | 三轮 `durationMs` **600,533 / 600,259 / 601,168**（均 ≥ 600,000），`spanMs` 509,987 / 509,987 / 509,997；**每轮七条 check 全 `true`、`pass` 与 `ac7Eligible` 均 `true`**；**20/20 worker 三轮皆满**（`chunks=20 completed=20 workerOks=20`）；**digest 三轮相同且与 expected 逐字相同**（`cdecda39b681…3bb266`）；`message_accepted` 1210 / 1210 / **1212**；背景投递 600+1 / 600+1 / **601+1**（拆隧道后仍在投递）；`lenderPending=0`、`redialFailed=true`、`trail.intact=true`、`failures=0`、`skipped=0` |
| — | `ac4` / `ac5` / `ac5e2e` | AC-4 / AC-5 | — | — | **未跑** | — | 无凭据。驱动开场即打印「AC-4/AC-5 跳过：无凭据，`source <凭据文件> && demo/walkthrough.sh --only ac4,ac5,ac5e2e` 即可补齐」，两项**不进 `summary.json` 的 items**（没跑过的东西不该在结果表里占一行） |

> **第 6 行为什么可以取轮 ①**：`git diff 856d0ff8..b3cda44f` 在 AC-7 的**全部相关路径**上一个文件都没动——`demo/lib/p61-{scenario,worker,seed,report-core}.ts`、`demo/p61-e2e.sh`、`demo/Makefile`、`demo/p61-data`，以及 `packages/{tunnel,negotiation,capacity,diagnosis,transport,protocol,audit}/src`。这条命令走查现场可当场复核；**不是「差不多就行」，是有依据的外推。**
>
> **第 1 行为什么必须取轮 ②**：两轮之间 **AC-3 的量具本身被改过**——`9736ddca fix(demo): AC-3 协议层预算判据按突发用时算「顶」，慢机器不再判红`（另有 `c7a02607` 已被 `7e83649a` 撤回）。十条 check 的**名字与条数没变**，变的是 `protocolBudgetAtLimit` 的内部算法与新增观测字段。轮 ② 跑的才是当前量具，且在本机上 `refillAllowance=0`，即**退化回原先那条最严的判据**。

**① 的混沌为什么没有报告 —— 是被打断，不是没跑起来**

这一条要写准，因为「没跑起来」和「跑了 33 分钟被杀」在结项材料里是两件完全不同的事：

| 证据 | 说明 |
|---|---|
| `chaos.transcript.log`（198 B，4 行）末行是 `chaos: seed=151078669 minutes=60 interval=20s kinds=kill-worker,cut-network,fill-disk,clock-drift` | 这行由 `demo/lib/chaos-inject.ts` 在**初始化完成之后**打印（`disk.available` 已判定、四类都在列表里 —— 说明 macOS 那个 1 MiB 真卷已经建起来了），紧接着才进注入循环。**能打出这行就等于已经起来了。** |
| 跑批期间 `ps` 实测到 `bash ./demo/chaos-inject.sh --minutes 60` 与 `bun run demo/lib/chaos-inject.ts --minutes 60` 两个活进程 | 起止时间与 05:17:52Z 的开场一致 |
| 驱动日志在 05:51 出现 `Terminated: 15` | 外部 `SIGTERM`。触发源是**会话管理器对后台任务约一小时的上限**（轮 ① 从 04:47 起算，到 05:51 正好 64 min），不是脚本自身退出 |
| `chaos.stdout.txt` = **0 字节** | 这正是「跑到一半被杀」的形状：`chaos-inject.ts` 全程只在**最后**用 `emit()` 打一行报告 JSON，中途不产出 stdout。**空 stdout 不代表没注入，只代表没跑到终点。** |
| 轮 ② 用**同一条命令、同一份代码**跑满 60 min 并 `pass=true` | 直接排除「参数没传对 / PSK 没注入 / 磁盘卷建不起来」这类驱动缺陷 |

**结论**：轮 ① 的混沌**跑了约 33 min 的 60 min**，被外部信号中止，**没有留下可判定的报告**，因此 §8.3 表里 AC-8 的混沌一栏取轮 ②。轮 ① 的这段 transcript 是**残篇，不得据此判 PASS 或 FAIL**。

> **这件事已经回灌进驱动**：`walkthrough.sh` 现在装了 `INT`/`TERM` 处理器——被打断时把在跑那项记成 `interrupted`（记录里明写「残篇不得据此判 PASS 或 FAIL」）、照常写出 `summary.json` 与 `SUMMARY.md` 再退出，而不是让 `WORK` 连同已完成项的记录一起蒸发（轮 ① 就是这么丢掉 `summary.json` 的）。这条兜底**用一次真实的进程组 `TERM` 验证过**，`totals.interrupted` 从 0 变 1、`summary.json` 照常落盘。

### 8.4 依据行摘录（走查时要念的那几个数）

以下逐字取自 `summary.json` 的 `evidence` 字段（驱动从报告 JSON 与 transcript 里抠出来的，不是手抄）。

**轮 ②（`b3cda44f`，`~/qianmo-acceptance/20260816T055831Z/summary.json`）**

```
ac3    pass=true
       hopCountAtCut=2 maxHops=8
       senderAgents=31
ac6b   pass=true
       elapsedMs=20 statusLines=3
ac8     39 pass
        0 fail
       Ran 39 tests across 6 files. [1.85s]
ac1    PASS=24  FAIL=0  WARN=0  SKIPPED=1
       PASS: [small] --resume 冷启动到会话就绪 0.451s ≤ 10s
       PASS: [large] --resume 冷启动到会话就绪 0.464s ≤ 10s
       WARN 行数=0
chaos  pass=true seed=153528247
       delivered=7380
       byKind={"kind":"kill-worker","count":36,"stalled":0},{"kind":"cut-network","count":43,"stalled":0},
              {"kind":"fill-disk","count":45,"stalled":0},{"kind":"clock-drift","count":53,"stalled":0}
       unmapped=0
```

**轮 ①（`856d0ff8`）的 AC-7 三轮**（逐字取自三份 `ac7-run-N.report.json`，按 `startedAt` 排序）

```
轮1 task=b8186d93 durationMs=600533 spanMs=509987 digest=cdecda39b681…  20/20 worker  msgAccepted=1210  bg=600+1  checks 7/7  pass=true ac7Eligible=true
轮2 task=546bfc81 durationMs=600259 spanMs=509987 digest=cdecda39b681…  20/20 worker  msgAccepted=1210  bg=600+1  checks 7/7  pass=true ac7Eligible=true
轮3 task=30455511 durationMs=601168 spanMs=509997 digest=cdecda39b681…  20/20 worker  msgAccepted=1212  bg=601+1  checks 7/7  pass=true ac7Eligible=true
```

几处值得在走查时点名：

- **`WARN 行数=0`**：AC-1 脚本 4c 段的 `warn` 分支（`--resume` 时间戳并列丢尾部消息）**这次没被触发**，两个规模点位都报 `ok`——`3e7a401` 的修复确已生效（§2.1 与 §6.7 已据此回写）。
- **`SKIPPED=1` 就是 AC-1 判据②**，脚本刻意不读凭据、不发模型调用。**「脚本全绿」≠「AC-1 三条判据全过」**，这句话在走查现场必须念出来。
- **`unmapped=0`** 是混沌判据里最硬的一条：87 条被捕获的失败**全部**能对上已知边界（都是真 `ENOSPC` → `disk full`），对不上一条就判红。
- **四类 `stalled` 全 0** 才是重心；「没崩」不是判据——**什么都不干的一小时同样没有未捕获异常**。
- AC-7 第 3 轮的 `msgAccepted=1212`、背景投递 `601+1` 比前两轮各多 1~2 条，因为那一轮多跑了约 900 ms（`durationMs=601168`）。**如实记，不抹平。**

### 8.5 产物清单与 sha256

两个目录都在**仓库外**的私有验收目录（`0700` / 文件 `0600`），仓库内只留这张表。sha256 用 `shasum -a 256` 实算。

**轮 ②：`~/qianmo-acceptance/20260816T055831Z/`**

| 文件 | sha256 |
|---|---|
| `summary.json` | `a3afddb25cf13b99219892be99633c08b7730b5d2b097d579381250ab38d3a48` |
| `SUMMARY.md` | `de374ca1ce213b2fbe1c23e76dd929112e745606be92ba64c63fda28cd9e510b` |
| `ac3-report.json` | `5b85b9931ec1b0a7f195bce6feb9ffeeb322fc1d935eb7e6cf3d032998d1a205` |
| `ac3.transcript.log` | `2fa317189da3ec6f2af7ba759e3bef0069ec45f7337137ae8b6ec640b4ac9140` |
| `ac6b-report.json` | `d61a7e5d0d29b2e51fb8cc5c8b966f3837ec379830b601f7f438b8e8be48ff84` |
| `ac6b.transcript.log` | `b361670e35e4bb519f918e4b0b41b3643071fff96e768b367dc05a9fce6380f5` |
| `ac8.transcript.log` | `a7129f8d39634cba335ccbd5c052b40334718720a115b1e1a9b0883091df6b25` |
| `ac1.transcript.log` | `f57fa816b770149a1fcef58674bbb37a40c8eb525ba57ef8340a10c41e41f93f` |
| `chaos-report.json` | `76f7a59e2297f30f689895427d14582793aa4f7f85dfc2027585f895372fe095` |
| `chaos.transcript.log` | `fbc74aafad94babd17265d7e4e165224df4c70b96c6e243e904a76886ec1af3f` |

**轮 ①：`~/qianmo-acceptance/20260816T044739Z/`**（本表只取仍在用的 AC-7 证据，其余项已被轮 ② 取代）

| 文件 | sha256 |
|---|---|
| `ac7.transcript.log` | `e8c31b402a45f8ee509a000f3fb3f8d9a88a66397f8ac7622413b0fd670260ff` |
| `ac7-report.jsonl` | `6f949aaa8ea9e137acb53372bde51e93674f3291d49d3f2f3e369d39cb0e2665` |
| `ac7-run-1.report.json`（task `b8186d93`） | `17cc8fd6ceccae8fac9711bb852534f91a2a993d77d6f3ec0e305771bd29eca0` |
| `ac7-run-2.report.json`（task `546bfc81`） | `e00e96a9aa9c694fef2d83d9f49855deecac0b7ca029976e6607b3f44537ea82` |
| `ac7-run-3.report.json`（task `30455511`） | `32fa52b2dfdb8cb68fb5c9b3721c3cd80d569ca14c912af1c87d83e23d46e9fa` |
| `chaos.transcript.log`（**残篇，198 B**） | `2ec67779d76fb84d6f0d3cecf99ac38f235f98c7de4b552c05dbecfd337277ba` |

> 两处如实说明：
>
> 1. **`ac7-report.jsonl` 里是 6 行不是 3 行**——驱动第一版按「行首 `{`」抓报告，把 `p61-seed` 每轮先打的那行数据集 JSON 也抓进来了。**已修**为按 `"checks":{` 特征抓（轮 ② 的 `chaos` 就只抓到 1 行）。这份 jsonl 保持原样归档，不回改。
> 2. **`ac7-run-N.report.json` 的轮次号是事后按 `startedAt` 校正过的**——第一版按 `mkdtemp` 目录名的字典序排，把第 3 轮标成了 `run-1`。**已修**为按目录 mtime 从旧到新排。文件内容一字未动（sha256 与校正前一致），改的只是文件名。

### 8.6 本次走查没有覆盖什么

**别把「本机腿全绿」读成「AC 全过」。**本次没碰的，逐条列出：

- **真机腿**：AC-2、AC-6(a) 全程未接入 Dormice / gVisor 真机，**一次都没跑**。判定沿用 §2.2 / §2.6(a) 的留档，处置见 §4.2。
- **凭据腿**：AC-4、AC-5 未跑（无凭据）；**AC-1 判据②** 是脚本内恒 SKIP，本次同样未测。补齐路径见 §7 第 2 件。
- **AC-6 的沙箱挂载边界**：本机两侧同进程，测的是凭据面与动词面，**挂载测不到**。§4.1 的定夺不因本次走查而改变。
- **AC-7 的五条诚实边界一条未变**：脚本化本地授权、A/B 是同一 runner 内的逻辑节点、WebSocket+PSK 不冒称 TLS、隧道只 A→B、worker 与 runner 共用算法。
- **CI 五连绿没有在结项 HEAD 上重取**（§4.5 仍待负责人裁定）。
- **真人录屏未拍**。transcript 替代的是「录屏文件」这一形态，不替代口头限定与现场问答（§8.1）。

**一条正面的旁证**：轮 ② 四份本机 transcript（`ac3` / `ac6b` / `ac1` / `ac8`）里 **64 位十六进制串出现 0 次**——驱动现生成的 PSK 与两把 backup token（各 64 hex）**没有落进任何 transcript**，与 §8.1 「不打印值、不落盘」的说法一致，可用 `grep -oE '[0-9a-f]{64}'` 当场复核。

## 9. 走查记录（凭据腿与真机腿，2026-08-16 ~ 08-17）

> 与 §8 同一形态：一切判定以产物目录里的 transcript / report 为准，本节只放指针与要念的数字。执行方式：主 agent 派子代理实跑、回收后抽查复核（report.json 合法性、sha256、回答内容、产物目录密钥零泄漏均由主 agent 二次亲验）。凭据取自负责人本机 `~/.occ/provider-profiles.json` 的 `opencode` 档（api.cornna.xyz 聚合网关），全程只经环境变量传递。

### 9.1 AC-4 / AC-5：`source <凭据文件> && demo/walkthrough.sh --only ac4,ac5,ac5e2e`

跑了两轮，**轮 ① 三项全红是凭据文件缺陷不是回归**——提取凭据时 `OPENAI_BASE_URL` 少了 `/v1`，而两个集成测试的 env 覆盖优先于仓库内夹具的正确 baseUrl，网关对 `/chat/completions`（无 `/v1`）回 200 + SPA HTML，SSE 解析器报 `IncompleteOpenAIStreamError`。凭据文件已修（补 `/v1`），轮 ① 产物 `~/qianmo-acceptance/20260816T150017Z/` 保留作反面教材。

**轮 ②（`~/qianmo-acceptance/20260816T150910Z/`）：**

| 项 | 判定 | 要念的数字 |
| --- | --- | --- |
| ac4 | **deepseek 腿全绿**（11 pass / 8 fail，8 条 fail 全在 qwen 腿） | 命中 **5/5** 逐条带来源 ID（`qm-mem-cee1b5a8…` 等五条）；伪造决策零引用 **3/3**（vue / elasticsearch / postgres 引用均 `[]`） |
| ac5 | **deepseek 腿一致性三项 3/3**（6 pass / 3 fail 全在 qwen 腿） | 流式 `text_delta=29 thinking_delta=21 stop=end_turn`；多轮首轮 `"OK"`→第三轮 `"42"`；工具调用 `get_build_status` `stop=tool_use` 回灌后据其作答 |
| ac5e2e | **run A（deepseek-v4-pro，compat=deepseek）全绿**：`occExitCode 0`、`taskTestsExitCode 0`、`taskTestsUntouched true`。**run B（qwen3.8-max，compat=strict-openai）被网关阻断** | 两跑命令行逐字相同、只换 providersFile（sha `5b8968b6…` / `ab7a57a3…`） |

**qwen 腿受阻根因（主 agent 亲测复现）**：网关 qwen 家族上游整体 502/503（`qwen3.8-max`→502、`deepseek-v4-pro`→200，`/v1/models` 仍列出 `qwen3.8-max`，故是上游可用性不是配置错）。**待网关恢复后重跑同一条命令即补齐**；deepseek 腿证据完整，不必重取。

transcript sha256：轮 ② `ac4 4aafbf55…` / `ac5 155732e9…` / `ac5e2e 1d4df8ea…`（完整值见产物目录 `checksums` 或现场重新 `shasum`）。

### 9.2 AC-1 判据②：「不重放历史即可续答」现场留档（关闭 §4.3）

产物 `~/qianmo-acceptance/20260816T151742Z/ac1-criterion2/`，**14 项检查全过**。隔离与 `demo/ac1-restart.sh` 同等：mktemp 的 `OCC_CONFIG_DIR`/`CLAUDE_CONFIG_DIR`，凭据走基座自己的 `--providers-file` 解析路径（`scripts/qianmo-provider-task.ts` 同款），事后核对真实 `~/.occ` 零写入。

| 步 | 事实 |
| --- | --- |
| 独特细节 | 常量 `QM_LATCH_C52B33` = `4987`，CSPRNG 运行时现生成（训练语料不可能含有） |
| turn 1 / 2 | `--session-id 19f0173e-…` 两轮分别写入常量名与数值，session_id 一致 |
| turn 3 | 600 字任务开工后（会话文件 10→13 行）外部 `kill -9` 整棵进程树，退出码 137，无残留 |
| turn 4 | `--resume` 单条追问（命令行与追问句均不含历史/常量），**11 s** 出答，session_id 仍同一串 |
| 判定 | 回答原文给出 `` `QM_LATCH_C52B33` `` 与 `4987`；`session.jsonl`（19 行）自证无历史重发——被杀轮的 user 消息后没有 assistant 回复，追问是单条 user 消息 |

关键 sha256：`session.jsonl` `419a15cf…`、`turn4.answer.txt` `227b8bda…`、`report.json` `9955d557…`、transcript `bd7260c7…`（完整清单在产物目录）。另有一份首轮现场（`20260816T150740Z/`，常量 `QM_LATCH_3F3040`，实质同样全过）——其 `report.json` 因脚本 heredoc 缺陷不是合法 JSON，**不要引用**，留作过程记录。

**脚本已落库（同日）**：`demo/ac1-criterion2.sh`（不含任何凭据，网关/模型可用 `AC1C2_BASE_URL` / `AC1C2_MODEL` 覆盖），并注册为 walkthrough 凭据腿 `ac1c2`——`source <凭据文件> && demo/walkthrough.sh --only ac1c2` 即可复跑；落库版已端到端复验一次（14/0，产物 `~/qianmo-acceptance/20260816T152554Z/`）。`demo/ac1-restart.sh` 第 5 节保持恒 SKIP 不动（它的「不读凭据」立场保留，指过来即可）。

### 9.3 真机腿走查（burn-vm-01 经 IAP 隧道，2026-08-16）

> 执行方式同 §9：子代理在真机实跑，主 agent 回收后经 `workbench-iap` 二次登机复核（sha256、report 判定、产物权限）。机器：GCP burn-vm-01（原 `workbench-host`；SSH 直连自 08-14 起坏，机器本身健康，经 gcloud IAP 隧道访问）。代码：本仓库 HEAD `62a9439c`，**bun 按 runbook 钉 1.3.13**（装前 1.3.14），`bun.lock` 与本机逐字节一致。产物根：`~/qianmo-acceptance-remote/20260816T153435Z/`（0700/0600 复核过）。

- **AC-2**：见 §1 行。十轮明细与上次并排、独立核验三项、六个文件的 sha256 全在产物目录；第 1 轮 5.6 s 冷唤醒、其余九轮 1.8–2.6 s 的形状与 08-13 一致。
- **AC-6(a)**：见 §1 行。沙箱按账本已无 p13 存量，用尚存镜像 `qianmo-node:p13` 注册模板 `qm-p13` 新建一次性沙箱，跑完 destroy；**模板注册保留在机器上**（复现便利，删除待负责人裁定）。
- **P8.1 remote 首验**：结果回写在 `demo/env/remote/README.md` 与 `demo-env.md` §7.1；两处脚本缺陷修在 `b6d464c2`。
- **过程事故如实记**：往真机送代码时两条并发 `--delete` rsync 打坏过远端树（已用 tar + scp 重建；根因是仓库根下 21 GB `.claude/` 与 6.4 GB `.occ/` 不在排除清单、首条 rsync 超时被误判结束）——**`.occ/` 含凭据，绝不可同步出去**，同步姿势已写进 `demo-env.md` §7.1。此事故发生在产物产出之前，不影响任何验收数字。

### 9.4 AC-5 替代第二供应商腿（2026-08-17）

> qwen 家族上游宕机 8 h+ 后主 agent 决定不空等：判据原文「≥ 2 个供应商适配器」不点名 qwen。子代理实跑、主 agent 复核 sha256 / 夹具零残留 / 代码断言后采信。产物 `~/qianmo-acceptance/20260817T010250Z/ac5-alt/`（MANIFEST 含全部 sha256）。

- **选型**：kimi-k3（`compat=strict-openai`）——预检三候选（kimi-k3 / glm-5 / minimax-m2.5）均 200，选 kimi 的依据是基座自己的注释（`src/services/api/openai/requestBody.ts:97` 把 Kimi/GLM 与 DeepSeek 并列为 strict OpenAI-compatible）；glm-5 在 512 预算下 `finish_reason=length` 有断言风险。
- **两跑**（命令行逐字相同，只改 `--providers-file` 内容，差异恰 2 行：`defaultModel` + `compatRule`）：run A deepseek-v4-pro 与 run C kimi-k3 **均** `occExitCode 0`、任务测试 5 pass、`taskTestsUntouched true`；两跑产出的实现体一字不差；run A 四项哈希与 p1.4 §3.2 历史值逐字一致（脚本与夹具未漂移）。适配差异点有两处可指到行：`providerCompatMatrix.ts` 的两档 profile（run C 三条剥离分支全命中）与 `deepseekTuning` 模型名门（`contextWindow` 1,000,000 vs 200,000）。p1.4 §5 G-2（`applyCompatRule` 线上路径无调用者）仍成立，换供应商不改变该结论。
- **一致性三项**：先在未改动仓库取 qwen 基线 **3 fail 全 503**（nginx 时间戳留档，与同分钟 deepseek/kimi 全绿对照——上游可用性铁证）；随后**只换夹具数据一行**（`qianmo-providers.json` 第二条 `defaultModel` → kimi-k3，id 与 compatRule 不动）得 **9 pass / 0 fail**，跑完 trap + sha256 校验还原（`git diff` 对该文件为空）。**测试代码零改动**；顺带坐实测试把第二腿的 id/变量名写死为 `qwen`（`provider-adapter-consistency.test.ts:513-515`）——日志打 `[qianmo-qwen]` 实跑 kimi 即证据。
- **主 agent 决定（记录在案）**：仓库暂不动——qwen 恢复监视在挂，若在 p6 长跑回收（08-17 06:21Z 后）时仍未恢复，则执行子代理建议的**最小整条替换**四步（config-b 与 qianmo-providers 各 1 行换 kimi-k3、测试内 `qianmo-qwen` id 中性化重命名单独一个 refactor 提交、回写 p1.4 与本表）；**不新增第三份夹具**（三份近似文件养一份死的，违「指针不复制」）。
- **→ 替换已于 2026-08-17 执行完毕**（负责人决议「暂停试验」后随收口一并做，qwen 彼时仍 502 逾 20 h、恢复监视撤下）：夹具换行 `cff9b138`、id 中性化 `qianmo-alt` + 变量名去 qwen 化 `cfd68052`；换后真调用 **9 pass / 0 fail**（deepseek + kimi 双腿）、`precheck` 零错（9985 pass）；p1.4 升 v0.2 勘误。**qwen 原夹具重跑这个补充项就此取消**——现行夹具已不锚定 qwen，判据早已由替代腿满足。

### 9.5 AC-6(b)(c) 真机挂载边界 + 删库恢复（burn-vm-01，2026-08-16）—— 关闭 §4.1

> 执行方式同 §9.3（子代理真机实跑，主 agent 经 `workbench-iap` 二次登机逐字段复核 report / 审计 / sha256）。驱动脚本 `ac6bc-driver.ts`（sha256 `38a6af41…`）随产物归档，schema `qianmo.ac6bc-mount-boundary.v1`。产物根：`~/qianmo-acceptance-remote/20260816T165237Z/ac6bc-mount/`（0700/0600，`SHA256SUMS.txt` 含全部 22 个文件；`report.json` sha256 `4207dc6a…`，`exit-code` = 0）。沙箱：模板 `qm-p13`、runtime **runsc**、只读根文件系统、容器 `94339c8b2a3a`。

**28/28 check 全 true，`pass: true`**，分四组：

| 组 | check（依 report 逐字） | 要念的数字 |
| --- | --- | --- |
| ① 挂载边界（AC-6(c) 的真机增量，本机测不到的那条） | `singleWritableBindIsWorkspace` `storeNotUnderAnyDockerMount` `storeNotUnderAnySandboxMount` `storeListEnoent/StatEnoent/ReadEnoent` `storeTouchDenied` `storeMkdirDenied` `storeFindDeleteFailed` `ownWorkspaceHostPathAbsent` `peerWorkspaceHostPathAbsent` `dormiceRootAbsent` `noSnapshotObjectVisible` | 沙箱唯一可写 bind 是 workspace（`/var/lib/dormice/mnt/<uuid>` → `/home/user`）；store `/var/lib/qianmo/backups` 不在任何 docker/沙箱挂载之下（`nonRootMountsCoveringStore: []`）；沙箱内 `ls/stat/cat` store 全 **ENOENT**（rc 2/1/1）——**路径在沙箱的命名空间里根本不存在** |
| ② 动词面（与本机 §2.6 同构，这次隔着真沙箱） | `snapshotCreatedFromSandbox` `listDeniedFromSandbox` `readDeniedFromSandbox` `removalRefusedFromSandbox` `denialsAudited` | 备份服务只在 docker 网桥宿主端（`172.17.0.1`）：POST 快照 **201**、list **403**、read **403**、删除动词 **405×4**；审计 9 事件（`snapshot-created` ×1、`read-denied` ×2、`mutation-denied` ×4、`snapshot-read` + `workspace-restored`），`mutationDeniedEvents=4` / `readDeniedEvents=2` 与探针次数逐一对上 |
| ③ 删库恢复（AC-6(b)） | `workspaceWasDeleted` `hostSeesDeletion` `restoreSucceeded` `withinBudget` `storeIntactAfterWipe` | 沙箱内 `rm -rf` 工作区、宿主侧确认删除可见；恢复 **60 ms**（预算 600,000 ms）；wipe 前后 store 两文件 sha256 逐字节不变（快照 11,781 B，`088a8ba7…`） |
| ④ 恢复保真 + 出生契约 | `gitStatusIdentical` `gitStatusWasNonTrivial` `headIdentical` `execBitPreserved` `birthContractOk` | `git status --porcelain` 删除前后逐字相同且**非平凡**（≥3 行，五种状态齐备）；HEAD 与可执行位一致；runsc + 只读根现场核过 |

**两条如实注**（report `notes` 原文的意思）：① `rm -rf` 对不存在的路径按 POSIX 退 0，所以 `rmRfStore` rc=0 **不是证据**——证据是 `storeIntactAfterWipe` 与那几条 ENOENT；② 沙箱经网桥够得到 HTTP 面，但那个面上没有删除动词——这正是 §2.6「边界不是 chmod，是一个进程」在真机形态下的样子。

## 附：本表与其他文档的关系

| 要什么 | 去哪 |
|---|---|
| 判据原文与豁免规则 | `charter.md` §4、§4.1 |
| 任务包完成状态 | `roadmap.md`「完成状态速查」表（**唯一出处**） |
| 各包实施细节、边界、决策理由 | `roadmap.md` 变更记录 v2.13 ~ v2.34 与各任务包正文 |
| AC-1 的核验方法与代码依据 | `session-persistence-review.md`（注意 §0 第 7、8 条已过期，见 §5.4） |
| AC-5 的选型、能力差异与六条缺口 | `p1.4-provider-verification.md` |
| AC-7 的六帧分镜、时间轴、诚实边界、3/3 正式记录 | `scenario-mcm.md` §3 / §4 / §8 / §9 |
| AC-8 的边界日流程与记录表 | `boundary-day.md`（**目前只有模板**） |
| 边界五类与 `protocol.md` §8.3 的对应 | `tests/boundary/README.md` |
| 协议级数值上限（跳数 / 体积 / TTL / 速率） | `@qianmo/protocol` 的 `LIMITS`（**唯一出处，本表与所有文档均不复制数值**） |
