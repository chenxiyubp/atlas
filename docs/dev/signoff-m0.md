<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — M0 结项双人签字表（P9.3）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.0** |
| 生效日期 | 2026-08-15 / 关闭 2026-08-17 |
| 任务包 | [`roadmap.md`](./roadmap.md) **P9.3 文档补齐与双人签字**（owner：全体，喻永昌汇总） |
| DoD | 每个核心模块的 backup **能独立复述设计原理并接手改动**（由 owner 出 3 道问题现场验证），双人签字入库（章程 §6.3 对策 P-2、§7.2 条款 3） |
| 状态 | **按负责人 2026-08-17 决议关闭**：逐包现场验证与手写签字**豁免**——实际开发主要由负责人本人承担（章程 v2.3 分工调整后 owner 名单读作方向辅助人），P-2 想防的「知识只在一个人脑子里」已由 17 份 README + 3 道题 + `base-modifications.md` 落成可查产物，现场答题仪式对该目的不再必要。下表签字栏**保留空白**如实反映「未逐人手签」；本表转为分工与题库索引留档，M1 若要恢复仪式照表即可 |

> **owner / backup 栏读法**（roadmap v2.3「任务包字段说明」）：自 v2.3 起**全部任务包的主开发均为喻永昌**，roadmap 各任务包 owner 栏的原名单读作「方向辅助人 / 第二知情人」。P9.3 的双人签字是章程明确写「双人」的流程要件，**不受 v2.3 分工调整影响**，仍按原文执行：owner 出题、backup 作答并签字确认能接手。下表的姓名逐包照抄各 README「双人签字」节，README 又照抄 roadmap 对应任务包 owner 栏；`@qianmo/adapter` 无独立任务包，签字人按 P1.1 推定（README 已注明，签字时就地更正）。

## 1. 签字表（17 个 `@qianmo/*` 包）

签字规则：backup 先不看 README 答 owner 出的 3 道题（题在各 README 末节），owner 判定「能独立复述并接手」后双方签名；任一题答不出即不签，回到 README 补读后择日重验。签字与日期手填；本表入库后每次签字以提交记录为准。

| # | 包 | 任务包 | owner（出题人） | backup（答题人 / 接手人） | 3 道题位置 | owner 签名 / 日期 | backup 签名 / 日期 |
|---|---|---|---|---|---|---|---|
| 1 | `@qianmo/protocol` | P1.1 | 喻永昌 | 陈曦宇 | [`packages/protocol/README.md`](../../packages/protocol/README.md) 末节 | | |
| 2 | `@qianmo/registry` | P2.1 | 陈曦宇 | 喻永昌 | [`packages/registry/README.md`](../../packages/registry/README.md) 末节 | | |
| 3 | `@qianmo/transport` | P2.2 | 陈曦宇 | 陈子轩 | [`packages/transport/README.md`](../../packages/transport/README.md) 末节 | | |
| 4 | `@qianmo/activator` | P2.5 | 董宗岳 | 陈曦宇 | [`packages/activator/README.md`](../../packages/activator/README.md) 末节 | | |
| 5 | `@qianmo/adapter` | （P1.1 §12.1 第 8 项，推定） | 喻永昌 | 陈曦宇 | [`packages/adapter/README.md`](../../packages/adapter/README.md) 末节 | | |
| 6 | `@qianmo/resident` | P3.1 | 董宗岳 | 陈子轩 | [`packages/resident/README.md`](../../packages/resident/README.md) 末节 | | |
| 7 | `@qianmo/router` | P4.2 | 陈曦宇 | 陈子轩 | [`packages/router/README.md`](../../packages/router/README.md) 末节 | | |
| 8 | `@qianmo/capability` | P4.3 | 陈曦宇 | 喻永昌 | [`packages/capability/README.md`](../../packages/capability/README.md) 末节 | | |
| 9 | `@qianmo/sandbox` | P1.3 | 董宗岳 | 陈曦宇 | [`packages/sandbox/README.md`](../../packages/sandbox/README.md) 末节 | | |
| 10 | `@qianmo/memory` | P2.3 | 董宗岳 | 李怡康 | [`packages/memory/README.md`](../../packages/memory/README.md) 末节 | | |
| 11 | `@qianmo/recall` | P3.3 | 董宗岳 | 李怡康 | [`packages/recall/README.md`](../../packages/recall/README.md) 末节 | | |
| 12 | `@qianmo/backup` | P4.4 | 董宗岳 | 陈子轩 | [`packages/backup/README.md`](../../packages/backup/README.md) 末节 | | |
| 13 | `@qianmo/diagnosis` | P5.1 | 李怡康 | 董宗岳 | [`packages/diagnosis/README.md`](../../packages/diagnosis/README.md) 末节 | | |
| 14 | `@qianmo/negotiation` | P5.2 | 喻永昌 | 陈曦宇 | [`packages/negotiation/README.md`](../../packages/negotiation/README.md) 末节 | | |
| 15 | `@qianmo/tunnel` | P5.3 | 陈曦宇 | 董宗岳 | [`packages/tunnel/README.md`](../../packages/tunnel/README.md) 末节 | | |
| 16 | `@qianmo/audit` | P7.2 | 陈曦宇 | 陈子轩 | [`packages/audit/README.md`](../../packages/audit/README.md) 末节 | | |
| 17 | `@qianmo/capacity` | P6.2 | 李怡康 | 喻永昌 | [`packages/capacity/README.md`](../../packages/capacity/README.md) 末节 | | |

**每人担子（供排现场时间用，按表逐行数得）**：

| 姓名 | 作为 backup 要答题的包（#） | 作为 owner 要出题/判定的包（#） |
|---|---|---|
| 陈曦宇 | 5 个：1 / 4 / 5 / 9 / 14 | 6 个：2 / 3 / 7 / 8 / 15 / 16 |
| 陈子轩 | 5 个：3 / 6 / 7 / 12 / 16 | 0 |
| 喻永昌 | 3 个：2 / 8 / 17 | 3 个：1 / 5 / 14 |
| 李怡康 | 2 个：10 / 11 | 2 个：13 / 17 |
| 董宗岳 | 2 个：13 / 15 | 6 个：4 / 6 / 9 / 10 / 11 / 12 |
| 合计 | 17 | 17 |

同一个人在同一包里不能既是 owner 又是 backup（表内无此情况）。

## 2. 另外两件 P9.3 交付物的位置（本表只给指针）

| 交付物 | 位置 | 状态 |
|---|---|---|
| 每个 `@qianmo/*` 包的 README + 模块架构图 | `packages/<name>/README.md`（17 份，mermaid 架构图 + API 面 + 不变式与钉住它的测试 + 边界 + 3 道题） | ✅ 已入库（2026-08-15）；mermaid 未做渲染级验证，首次在渲染器里打开时若有语法问题按包修 |
| 对基座的改造点清单（改了哪些基座文件、为什么、扩展点为何不够用） | [`base-modifications.md`](./base-modifications.md) | ✅ 已入库；其中 7 行「理由待改动人确认」——改动人即主开发，签字会前自行确认并把 ⚠️ 转 ✅ |
| 双人签字表 | 本文 | 🟡 待签 |

## 3. 现场验证怎么排（建议，一次 90 分钟）

1. 每包 5 分钟：backup 口头答 3 题，owner 只判「能不能接手」，不讨论对错细节（细节回 README）；
2. 按 backup 分组串行：陈曦宇 5 包 → 陈子轩 5 包 → 喻永昌 3 包 → 李怡康 2 包 → 董宗岳 2 包；
3. 未通过的包记在下表，不签，一周内重验一次；两次不过即触发章程 P-2 对策（换 backup 或补文档）。

| 包 | 首次结果 | 未过原因 | 重验日期 / 结果 |
|---|---|---|---|
| | | | |
