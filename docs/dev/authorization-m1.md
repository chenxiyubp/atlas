<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 用户授权流与权限审计（M1 · 权限模型上线 · P14）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.0（生效）**。2026-09-26 负责人委托主 agent 评审定案；负责人本人拍板四项（N-2 A′、E-1 窗口后部署、P16 花费、上游报告时机）。本文直接涉及其中三项：D-2 以 N-2 A′ 为前提；E-1 修复随 v2.46.3 在 7 天长跑窗口后部署；舰队修好之后，带着修复方案向基座上游报告 E-1 |
| 日期 | 2026-09-26 |
| 核对基点 | 源码以 `9770e8a7`（main，v2.46.2 合并提交）为准，代码树与评审基点 `08095aac` 相同。v0.1 写于 `93ed2285`，漂移的行号已逐条改正 |
| 范围依据 | roadmap M1 方向表「权限模型上线」行：内容「用户授权流（授权申请 → 用户确认 → 时效凭据 → 主动撤销）；权限审计报表」，出口判据「所有需确认动作 100% 经过用户授权链路，抽查无绕过」。**「需确认动作」的定义见 §1.1；对外引用这条判据时必须同时附上这个定义** |
| 任务包 | P14.0 ~ P14.9（§6）。P14.0 已在做（分支 `security/resident-permission-bypass`）；P14.1 是本文的定稿与范围回写 |
| 不改动 | 本文只改设计；章程 C-5 补注与 roadmap 回写随本版同批完成（P14.1） |
| 相邻文档 | [`tenancy-m1.md`](./tenancy-m1.md)（P15，§3.3 与其 §3.5 已对账）、[`memory-m1.md`](./memory-m1.md)（P16，常驻工具面新增工具要进 P14.2 快照与 hardline）、[`key-distribution.md`](./key-distribution.md)（P11.2 / P12）、[`console.md`](./console.md)、[`resident-botization.md`](./resident-botization.md)（P13）、`protocol.md` §10 |
| 结论一句话 | 三级权限的第三级在生产上没有消费者；**今天的 `dontAsk` 不是 fail-closed**：放行入口除了宿主，还有 plan+bypass、hook、agent 模式覆盖、Skill 规则注入四条，其中 E-1 在现网姿态下就能打穿。所以**先 P14.0 堵旁路**，再在现网的 `acceptEdits` 姿态上接授权流：审批者是 P15 的个人账号、按会话属主路由；控制台另持审批私钥；grant 是本节点的持久行加状态机；撤销靠短寿命、本地撤销与急停 |

**变更记录**

| 版本 | 日期 | 说明 |
|---|---|---|
| v0.1-draft | 2026-09-26 | 初稿（`93ed2285`），决策点 D-1 ~ D-7 待裁定 |
| **v1.0** | **2026-09-26** | **定案。2026-09-26 负责人委托主 agent 评审定案；负责人本人拍板四项（N-2 A′、E-1 窗口后部署、P16 花费、上游报告时机）。**① 评审用真 ACP 子进程实测推翻 v0.1 的承重前提「`dontAsk` 是 fail-closed、宿主 `requestPermission` 是唯一放行入口」，新增事实 F-16 ~ F-26 与旁路 E-1 ~ E-6（§0）。② 新增 P14.0「常驻权限旁路加固」排在最前（已在做），新增 P14.9「上线前置」；P14.6 缩小；估算重算为 152–264（§6）。③ D-1 改为 `acceptEdits`；D-2 改为 P15 个人账号、按会话属主路由、独立审批会话，不发第三枚 token；D-4 改为 60 s；新增 D-8、D-9；D-6 定为 P15.8（§7）。④ 投递路径改为节点 → 中枢专用消息，不走 notify（§3.2）。⑤ 威胁模型补 TH-8 ~ TH-14，删去「控制台与节点同机不在保证范围」，改为部署硬前提（§2、§9）。⑥ §4 改为以配置姿态判定，I-9 / I-10 降为记账不变式，新增 I-11、I-12，抽查改为全量复判。⑦ 摘要改为按工具的规范化投影（§3.4）。⑧ 与 P15 接口对账（§3.3），§8 用评审答复替换 |

## 0. 现状：测量结果

M1 这一行的授权流**尚未开工**。下表是读代码与评审实验所得。行号以 `9770e8a7` 为准。

| # | 事实 | 出处 / 证据 |
|---|---|---|
| F-1 | capability 令牌 `<claims>.<sig>`，claims 八个键**字段封闭**，键数与键名双重比对（多一个键即拒） | `packages/protocol/src/capability.ts:124-133`、`:146-153` |
| F-2 | 规则 S-1：`act = user-confirmed` 且 `iss ≠ 本节点` 一律拒，判在验签之前（在绑定与时钟检查之后） | `packages/capability/src/token.ts:212-223` |
| F-3 | 默认策略 `SIGNED_TASK_POLICY` 只要求 `task.request` / `wake` 到 `write-limited`；**没有任何消息类型要求 `user-confirmed`**。现网连 `write-limited` 也不强制：`beta-up.sh` 显式带 `--open-policy --audit-signed-tasks`（F-24） | `packages/capability/src/policy.ts:90-93` |
| F-4 | 生产代码里签发 `user-confirmed` 的地方为零；唯一签发点在演示脚本，那次「用户授权」是脚本化钩子（`mode: 'scripted-hook'`）；控制台签发器钉死 `write-limited`。**另**：`NodeCapabilities.issue(input)` 是透传的，`act` 可以来自变量，所以「按字面量扫签发点」扫不全 | `demo/lib/p61-scenario.ts:417-439`；`src/cli/handlers/consoleWakeIdentity.ts:125-140`；`packages/capability/src/gate.ts` 的 `issue` |
| F-5 | 协商出借方的 `authorize` 钩子是同步布尔，缺省 `?? true`（未接即放行）。`LenderNegotiator` 在 `src/` 与 `packages/` 生产代码里没有构造点，`@qianmo/negotiation` 在生产代码里零引用，常驻宿主也不处理 `resource.*`，所以 **C_net 在生产上是空集**，`negotiation.*` 审计事件在生产上不存在 | `packages/negotiation/src/lender.ts:75-79`、`:173-178` |
| F-6 | 常驻 ACP 会话的权限上下文由 `getEmptyToolPermissionContext()` 建，`alwaysAllowRules` 为空，只有 `mode` 被覆盖。**这只在建会话那一刻成立**：Skill 的 `allowed-tools` 会在运行中往 `alwaysAllowRules.command` 注入规则（F-19） | `src/services/acp/agent/createSessionMethod.ts:119`、`:197-206`；`packages/tool-runtime/src/Tool.ts:221-229` |
| F-7 | 常驻缺省模式 `dontAsk`；`dontAsk` 把 `ask` 在管线末端翻成 `deny`，**但只在模式仍是 `dontAsk` 时生效**。模型用 `EnterPlanMode` 把模式改成 `plan` 后转换失效，再叠加 plan + bypass 可用就是全放行（F-16）。`--allow-workspace-edits` 下是 `acceptEdits` | `packages/resident/src/acp-client.ts:158`；`src/utils/permissions/permissions.ts:540-553`；`src/services/qianmo/resident.ts:1821-1823` |
| F-8 | 宿主 `requestPermission` 恒答 `cancelled`；ACP 桥把它当拒绝，本轮照常 `end_turn`，模型拿到 "Permission request cancelled by client"（评审实测 s1） | `packages/resident/src/acp-client.ts:120-124`；`src/services/acp/permissions.ts:145-161`；`createSessionMethod.ts:147` |
| F-9 | ACP 桥的 `ExitPlanMode` 分支向客户端提供 `auto` / `acceptEdits` / `default` / `bypassPermissions` 四个选项，选中即改会话模式。这个分支**排在权限管线之前**，只要会话进了 `plan`，在任何模式下都能到达宿主 | `src/services/acp/permissions.ts:66-77`、`:195` 起 |
| F-10 | 常驻 hardline 拒绝表在 `checkPermissions` 内求值，先于任何 allow；不从会话配置读取。hook allow 路径也会经过 `checkRuleBasedPermissions`。评审实测 hardline 在 hook allow 下（h3）和 plan 模式下（d4）都挡住了 | `packages/resident/src/guard.ts`；`src/services/qianmo/residentGuard.ts:92` |
| F-11 | 信任档（`untrusted` / `verified-capability`）只改给模型的措辞，**没有任何代码按档位门控执行** | `console.md` §4.7；`demo/lib/acceptance/scenarios/trust.ts:158` |
| F-12 | 控制台鉴权是 view / admin 两枚 bearer token；cookie 12 h，装的就是 token 本身，**无服务端吊销** | `console.md` §4.1、§8.1；`packages/console/src/auth.ts:135` |
| F-13 | 审计链里与授权相关的只有：router 的 `capability_denied`（落为 `capability` 源）、证书目录事件、影子审计 `capability_shadow_refusal`、activator 的 `capability.denied`；**工具级权限判决（dontAsk 拒、hardline 拒、宿主应答）不进审计链** | `src/services/qianmo/auditTrail.ts:169-178`、`:601`、`:654`；`packages/activator/src/audit.ts:18` |
| F-14 | `qm audit` 支持 `--trace/--agent/--task/--from/--to/--limit/--json/--verify/--witness/--path`；`TrailQuery` 有 `source` / `outcome` 两个条件但 CLI 未暴露 | `src/cli/handlers/qianmoAudit.ts:111-135`；`packages/audit/src/query.ts:24-37` |
| F-15 | S-3 扫描：列目录、禁变更权限的基座 API、fixture 钉住红方向。**它只扫阡陌自己的代码调用**；E-1、E-3、E-4 是基座**工具**自己改模式或规则，这个扫描看不到 | `packages/capability/test/authorization-invariants.test.ts:41-69` |
| F-16 | `EnterPlanMode` 在常驻会话实际给模型的工具面里（评审实验 D 抓到的模型请求 `tools` 字段），只读、没有 `checkPermissions`，任何模式都放行；进入 `plan` 后，只要 bypass 可用就全放行。ACP 建会话时这个标志取 `isAcpBypassPermissionModeAvailable()`，**非 root 进程恒为真** | `packages/builtin-tools/src/tools/EnterPlanModeTool/EnterPlanModeTool.ts:71-73`；`src/utils/permissions/permissions.ts:1327-1330`；`createSessionMethod.ts:197-206`；`src/services/acp/agent/permissionMode.ts:150-155` |
| F-17 | PreToolUse hook 回 `allow` 时跳过 `canUseTool`，只剩 deny / ask 规则、工具 `checkPermissions` 的 deny 与 safetyCheck 起作用。hook 配置快照在第一次使用时抓取、**进程级**，而一个节点只有一个 ACP 子进程，所以一个工作区的项目 hook 会作用到同一子进程里别的工作区的会话（评审实测 p3） | `src/services/tools/toolHooks.ts:364-398`；`src/utils/hooks/hooksConfigSnapshot.ts:106-134` |
| F-18 | 自定义 agent 定义里的 `permissionMode` 在父会话不是 `acceptEdits` / `bypassPermissions` / `auto` 时生效；常驻会话下子 agent 默认异步，它的 ask 自动拒、不到宿主 | `packages/builtin-tools/src/tools/AgentTool/runAgent.ts:635-666` |
| F-19 | Skill 的 `allowed-tools` 在运行中注入 `alwaysAllowRules.command`；`hooks` frontmatter 注册为会话 hook，只受 `isRestrictedToPluginOnly('hooks')` 门控 | `packages/builtin-tools/src/tools/SkillTool/SkillTool.ts:779-809`；`src/utils/processUserInput/processSlashCommand.tsx:1248-1257` |
| F-20 | `ExecuteExtraTool` 自己回 `passthrough`（要问一次），但批准后对目标工具**只在 `deny` 时拦截**，目标工具的 ask 被吞掉。评审实测经它在 E-1 下建出了 cron 作业，75 s 内没观察到触发 | `packages/builtin-tools/src/tools/ExecuteTool/ExecuteTool.ts:186-203`、`:221-226` |
| F-21 | `requestPermission` 只带 `toolCallId / title / kind / rawInput`，**不带工具名**；工具名在同一 `toolCallId` 之前的 `tool_call` sessionUpdate 的 `_meta.claudeCode.toolName` 里 | `src/services/acp/permissions.ts:125-131`；`src/services/acp/bridge/notifications.ts:142`、`:158`、`:190` |
| F-22 | notify 回的是**任务发起方**的通道（`to: task.envelope.from`、`channel: task.channel`）；节点侧台账只在该对端下一次入站时排空 | `src/services/qianmo/resident.ts:1313-1375`、`:837-842` |
| F-23 | 控制台按需拨号：第一次对话调 `linkFor` 时才建链，之后带自动重连常驻；没对话过的节点没有链路 | `src/cli/handlers/consoleChat.ts:686-722`；`packages/transport/src/client.ts` 的重连 |
| F-24 | 现网常驻姿态是 `acceptEdits`；任务策略是开放 + 影子审计 | `demo/env/beta/beta-up.sh:1161-1178`；`demo/env/resident-task-policy.test.ts:36-40` |
| F-25 | hardline 覆盖缺口：同机其他配置根（控制台的 identity、token）、记忆根、配置根下的 `agents/`、`skills/`、`plugins/`，以及配置根下不在 `resident/`、`qianmo/` 里的文件。`IDENTITY_DIRS` 只有 `.occ` / `.qianmo` / `.claude`，`NODE_STATE_DIRS` 只在 `stateRoots` 内生效 | `packages/resident/src/guard.ts:58`、`:65`、`:82`；评审 hardline 探针（§0.2） |
| F-26 | 常驻会话实际给模型的工具面（22 个）：`Agent, TaskOutput, Bash, Glob, Grep, ExitPlanMode, Read, Edit, Write, NotebookEdit, WebFetch, TodoWrite, WebSearch, TaskStop, AskUserQuestion, Skill, EnterPlanMode, SendMessage, Workflow, SearchExtraTools, ExecuteExtraTool, qianmo_notify` | 评审实验 D 抓的模型请求 `tools` 字段 |

**一句话诊断**：三级权限的第三级在生产上没有消费者（F-3、F-4），「用户授权链路」不存在；**今天的 `dontAsk` 不是 fail-closed**；放行入口除了宿主 `requestPermission`，还有 plan+bypass（E-1）、hook（E-2）、agent 模式覆盖（E-3）、Skill 规则注入（E-4）四条。

### 0.1 旁路编号

| # | 旁路 | 现网能否打穿 | 处置 |
|---|---|---|---|
| **E-1** | `EnterPlanMode` 进入 plan + bypass（F-16） | **能**：`dontAsk` / `acceptEdits` / `default` 三种模式下，之后的 `Bash touch <工作区外>` 与 `Write <工作区外>` 都执行了，宿主零请求；能挡住的只剩 hardline。能否在现网被利用取决于节点进程 uid（root 且未设 `IS_SANDBOX` 时 bypass 不可用），**uid 未核实** | P14.0。修复随 v2.46.3 在窗口后部署；舰队修好之后，带着修复方案向基座上游报告 |
| E-2 | PreToolUse hook `allow`（F-17） | 取决于运维与工作区是否预置 hook；进程级快照会跨工作区污染 | P14.0（安全模式） |
| E-3 | agent 定义里的 `permissionMode`（F-18） | 父会话 `acceptEdits`（现网）时这条覆盖被跳过；`default` / `dontAsk` 下生效 | P14.0（安全模式） |
| E-4 | Skill 的 `allowed-tools` / `hooks`（F-19） | 审批人只看到 `{skill:"helper"}`，批准后同一轮里的 Bash 不再询问 | P14.0（安全模式） |
| E-5 | `ExecuteExtraTool` 吞掉目标工具的 ask（F-20） | 它本身要问一次，所以只是**审批不透明**，不算免审批 | P14.5 审批页展开目标与参数 |
| E-6 | 同机 hardline 覆盖缺口（F-25） | 现网 beta-4 与控制台同在中枢机，节点 hardline 对控制台 identity 判 `clear` | P14.0 词法规则 + P14.9 部署前提 |

### 0.2 评审实验摘要（真实输出，节选）

装置：`src/entrypoints/cli.tsx --acp` 起真 ACP 子进程（`OCC_IDENTITY=qianmo`、临时 `OCC_CONFIG_DIR`、`CLAUDE_CODE_USE_OPENAI=1` 指向本地假模型）；宿主侧用 `@agentclientprotocol/sdk` 的 `ClientSideConnection` 记录每次 `requestPermission`；`initialize` 与 `newSession` 的 `_meta` 与 `ResidentAcpConnection` 相同。假模型只按脚本发 `tool_call`，**不产生任何模型质量结论**。脚本未入库，P14.2 把它收进仓库作旁路语料。

| 场景 | 模式 | 动作 | 宿主收到的请求 | 结果 |
|---|---|---|---|---|
| s1 | default | Bash `touch <外>` | 1 | 未执行（cancelled） |
| s2 | dontAsk | 同上 | 0 | 未执行 |
| s5 | default | 同上，宿主回 allow | 1 | 已执行（宿主放行有效） |
| **s7 / d3** | **dontAsk** | EnterPlanMode → Bash / Write `<外>` | **0** | **已执行** |
| **d1** | **acceptEdits** | EnterPlanMode → Bash `<外>` | **0** | **已执行** |
| d4 | dontAsk | EnterPlanMode → Bash 读配置根 settings.json | 0 | hardline 拒 |
| **h1 / h2** | dontAsk / default | 用户级 PreToolUse hook allow → Bash `<外>` | **0** | **已执行** |
| **p3** | dontAsk | 另一个没有 hook 的工作区，同一子进程 | **0** | **已执行**（进程级快照污染） |
| **s6 / s6c** | default / dontAsk | Agent → `permissionMode: bypassPermissions` 的子 agent → Bash `<外>` | **0** | **已执行** |
| s6b | acceptEdits | 同上 | 0 | 子 agent 被拒 |
| **g1** | default | 宿主只批准 Skill → 同一轮 Bash `<外>` | 1（title=`Skill`） | **Bash 已执行，没有第二次询问** |
| **f1** | dontAsk | EnterPlanMode → ExecuteExtraTool(CronCreate) | 0 | **CronCreate 成功**；75 s 内没观察到触发 |

`CLAUDE_CODE_SAFE_MODE=1` 复跑：h1、p1 被拒，h2 到宿主，s6 / s6b / s6c 子 agent 文件都没生成；**s7 仍然执行**——安全模式堵不住 E-1，要另从工具面剔除。

hardline 探针（`ResidentHardline`，`stateRoots=[…/nodes/beta-4/config]`，仿现网布局）：节点自己的 identity 判 DENY；**同机控制台的 identity（`…/nodes/console/config/qianmo/identity/*.json`）判 `clear`**，Bash `cat` 也是 `clear`；`<cfg>/memory/`、`<cfg>/skills/`、`<cfg>/agents/`、`<cfg>/plugins/` 与工作区 `.claude/agents|skills/` 都是 `clear`。

## 1. 问题与范围

### 1.1 「需确认动作」的判定规则

需确认动作集合 **C = C_tool ∪ C_net**：

| 子集 | 判定规则 | 判定点 |
|---|---|---|
| **C_tool**（节点内工具面） | 在**配置姿态**下（节点启动时的模式，现网是 `acceptEdits`；**不是**会话运行中的当前模式）、空规则集、无 hook 时，基座权限管线对一次工具调用给出 **`ask`** 的全部调用。判定函数就是 `hasPermissionsToUseTool` 在这些条件下的返回（`src/services/acp/permissions.ts:89-104` 的 `ask` 分支） | 宿主 `requestPermission`（`packages/resident/src/acp-client.ts:120`） |
| **C_net**（跨节点资源） | 出借方在发出 `resource.offer` 之前的放行判断（`lender.ts:173`）。**M1 生产上是空集**（F-5）：出借方协商器在生产代码里没有构造点 | 出借方 `authorize` |

**不属于 C 的几类**，各有归宿：

- **hardline 命中**：恒拒，**不可确认**。grant 不能打开 hardline 目标（F-10）。
- **管线直接 `allow` 的调用**：读操作、`acceptEdits` 下工作目录内的编辑。它们的边界由姿态决定，姿态进报表（§5）。
- **子 agent 的 ask**：常驻会话下子 agent 异步，ask 自动拒（F-18），不可审批。
- **`AskUserQuestion`**：拒；它不是动作。
- **`ExitPlanMode`**：拒；P14.0 之后它不在常驻工具面里。
- **运维启动姿态**（`--allow-workspace-edits`、`--open-policy`、`--trust`、`--approver`、安全模式开关）：启动时决定，不是运行时授权；进报表的「姿态」栏。

**前提**：P14.0 落地之前，§4 的任何判据都不成立（E-1 ~ E-4 让 ask 不产生请求）。

C_tool 的枚举方式：P14.2 用固定语料跑一遍真实管线，把「哪些返回 ask」产出成快照入库；**快照变化即红**，按平台分文件（PowerShell 只在 Windows、沙箱只在 Linux），并钉 CI 平台。这也是上游同步改变基座权限语义时能及时发现的地方。

> **对外口径**（凡在答辩、报告、README、发行说明里说「所有需确认动作 100% 经过用户授权链路」，必须同时写明下列定义）：C 以**配置姿态**下的基座判定为准；`acceptEdits` 下工作区内的编辑不在 C 里；子 agent 的 ask 是自动拒绝而不是可审批；C_net 在 M1 为空；以上成立的前提是 P14.0 已部署到该节点。

### 1.2 与三级权限的关系

| 等级 | 含义（本文之后） | 能触发什么 | 谁能签 |
|---|---|---|---|
| `read` | 看 | 不开 turn，只有回复类 | 任何消息（未签名即此档） |
| `write-limited` | 有界本地工作 | 开 turn；turn 内**只能做不 ask 的动作**，C 中动作一律转入授权流 | `--trust` 中的签发者（含控制台） |
| `user-confirmed` | 本节点的用户对**某一个具体动作**说了「是」 | C 中与某条 grant 绑定的那一个动作 | **只由本节点自签**（S-1 不动），前提是本节点验过审批者的决定 |

两条不变：**消息的等级是上限，不是加法**（S-3）；**跨节点消息永远不携带 in-node 动作的 `user-confirmed`**。

现网是开放策略（F-24）：`write-limited` 行的「开 turn」在现网不需要签名，挂起行里记录的信任档在 `key-distribution.md` §9.2 阶段 ③ 之前全是 `untrusted`。

## 2. 威胁模型

| # | 威胁 | 现状 | 本设计的控制 | 残余 |
|---|---|---|---|---|
| TH-1 | **confused deputy**（章程 C-5 / T-7）：A 的消息诱导 B 的 agent 执行 C 中动作，并声称「用户已同意」 | S-1 挡住远端 `user-confirmed`（F-2） | 审批只认 B 自己的 `--approver` 集（与 `--trust` 不相交，I-6）；审批绑定 B 自己生成的 `requestId` 与动作摘要；审批页展示「由谁的哪条消息引发」及其信任档 | 用户被 agent 写的理由说服：展示宿主渲染的原始输入并把 agent 文字标为不可信，不以「用户没被骗」验收（章程 T-7 对策①） |
| TH-2 | **重放** | `NonceStore` 在内存（`packages/capability/src/nonce.ts:34`），重启即清空 | 审批带 `aud`、`nonce`、`exp`；**一次性由持久化的请求状态机保证**（`pending → approved/denied/expired` 单向迁移）；allow-once 用后即消耗 | 时间窗 grant 在窗内可重复用于同一摘要（定义如此，上限见 D-5） |
| TH-3 | **凭据外泄** | admin token / cookie 外泄即完全控制台权限，直到换 token（F-12） | 审批走独立的 HttpOnly 审批会话，**不要求 Bearer-only**（Bearer-only 会把凭据放进页面 JS，而页面 CSP 是 `script-src 'unsafe-inline'`）；审批私钥与控制台对话、唤醒私钥分开（D-3）；grant 只在签发节点、只对一个摘要有效 | 审批私钥外泄：可伪造审批，直到每个节点移除 `--approver` 条目并重启（O(N)，与 `--trust` 同一局限） |
| TH-4 | **撤销传播延迟** | 无撤销对象 | §3.5：本地 ESTOP 即时、撤销消息一跳、审批者吊销按 approver 扇出、grant 短寿命封顶 | 节点不可达时，最坏 = grant 剩余寿命（≤ 60 min） |
| TH-5 | **控制台会话劫持**（CSRF、XSS、点击劫持、陈旧页面） | CSRF 有 `X-Qianmo-Console` + 无 CORS；CSP 为 `<meta>` 形式（`packages/console/src/view/page.ts:740`）；`packages/console` 与 `src/cli/handlers` 里没有 `frame-ancestors` / `X-Frame-Options` | 审批 POST 回传页面展示的摘要，服务端复核；审批页加 `X-Frame-Options: DENY` 与 CSP 响应头；agent 文本只走既有出口转义 | — |
| TH-6 | **agent 自我授权** | 见 E-1 ~ E-4 | ① 挂起行只由宿主从 `requestPermission` 创建，`qianmo_notify` 造不出挂起行；② hardline **按词法**拒绝任何 `*/qianmo/identity/*` 与控制台落盘物，不依赖 `stateRoots`；控制台用独立 uid（D-3）；③ `ExitPlanMode` 不在常驻工具面，宿主对它的模式选项恒拒；④ `authz.*` 由宿主消费，永不进信箱与 agent 上下文；⑤ 空规则集只在建会话时成立，运行中靠 P14.0 的安全模式与工具面剔除 | hardline 是词法匹配，可被混淆（`guard.ts` 头注释） |
| TH-7 | **审批疲劳** | 无 | 同一 `(agent, contextId, digest)` 的挂起请求去重；每会话挂起上限与每节点每小时请求上限是节点本地策略，**不进 `LIMITS`**；超限直接拒并记 `authz.refused(reason=budget)`。承载姿态取 `acceptEdits`，工作区内编辑不产生审批 | 上限数值待 P14.4 以语料定 |
| TH-8 | **结构旁路**（E-1 ~ E-4） | 基座工具自己改模式或注入规则，宿主看不到 | P14.0：常驻工具面剔除 `EnterPlanMode` / `ExitPlanMode` / `CronCreate` / `CronDelete` / `CronList`；ACP 子进程缺省 `CLAUDE_CODE_SAFE_MODE=1`；I-11 真 ACP 旁路语料 | 基座行为漂移：修法依赖基座当前语义，I-11 语料进上游同步棘轮 |
| TH-9 | **审批不透明的权限放大** | 批准 `Skill{skill}` 等于授出它的 `allowed-tools` / `hooks`；批准 `ExecuteExtraTool` 等于执行目标工具；批准写 `.qianmo/agents/*`、`<cfg>/{agents,skills}/*` 等于一次批准、永久授权；`acceptEdits` 下批准 `npm test` 执行的是 agent 刚在工作区写的脚本 | 这些配置写入进 hardline（不可批准），或靠安全模式让它们失效；审批页展开 `ExecuteExtraTool` 的目标与参数；审批页列出「本会话 agent 改过的文件」 | 批准的命令仍可能执行 agent 写的代码，只能靠呈现缓解 |
| TH-10 | **同机共置** | 控制台与 beta-4 同在中枢机、同一用户，节点 hardline 不覆盖控制台配置根（F-25） | D-3 的词法规则 + 独立 uid；**部署硬前提**（P14.9） | — |
| TH-11 | **显示欺骗** | 原始输入里的 bidi 控制字符、ANSI 序列、超长行能藏住尾部 | 审批页把控制字符与 bidi 字符显式化，不截断全文，超长只折叠不省略 | — |
| TH-12 | **脱离 turn 的后台动作** | 异步子 agent 在 `end_turn` 之后还在跑；`run_in_background`、`Monitor`、Cron | 不在活动 turn 内到达的 ask 一律拒并记 `authz.refused(reason=no-turn)`；Cron 从常驻工具面剔除 | — |
| TH-13 | **审批请求的路由泄漏** | 按「与 notify 同路」实现的话，原始输入会发给任务发起方（F-22） | 投递改为节点 → 中枢专用消息（§3.2） | — |
| TH-14 | **注册中心投毒** | 控制台从名册取节点公钥（`c30a0917`）；同机 agent 能写回环上的注册中心 | **P14 不从注册中心取任何授权材料**；注册中心写 token 归 P15.8 | — |

**不在本模型内**：沙箱逃逸与节点宿主 root 失陷（由沙箱与章程 A-1 承担）；「模型没被说服」不作为任何一条控制的依据（章程 T-7 对策①）。v0.1 的排除项「控制台与节点同机且无沙箱不在保证范围」**删除**：现网正是这个拓扑，改为 P14.9 的部署硬前提。

**残余风险**：现场三个常驻节点都没有沙箱冻结态（`beta-env.md` §2.2 的 2026-09-26 现场注）；hardline 是最后一道，而它是词法匹配。

## 3. 流程

### 3.1 总图

```
 发起方                        目标节点 B（宿主进程）                                   中枢（审批控制台）
 ① 本节点 turn 内工具调用 ─┐
 ② 对端 task.request 引发 ─┴─> ACP ask ─> requestPermission ─> 不在活动 turn 内？ ─是─> 拒，authz.refused(no-turn)
                                  │否
                                  GrantStore 命中？
                                  是 ─> 放行（allow-once 即消耗），记 authz.grant_used
                                  否 ─> 挂起行 + authz.requested ─> 节点台账
                                        本次调用：有界等待或拒绝（D-4）          ⇄ 控制台主动建立的链路（控制台拨号）
                                                                                   按会话属主路由到审批人（P15 账号）
                                  校验 AuthzDecision ─> 自签 grant 行 <────────── authz.decision（审批私钥签名）
                                        记 authz.approved / authz.denied
                                  删 grant，记 authz.revoked <─────────────────── authz.revoke（单条 / 按审批者）
```

### 3.2 发起点与投递

- **①② 节点内工具调用**（含对端消息引发的 turn）：唯一入口是宿主 `requestPermission`，前提是 P14.0 已堵住 E-1 ~ E-4。承载姿态是 `acceptEdits`（D-1）。`--approver` 与 `dontAsk` 同时出现（即给了 `--approver` 却没给 `--allow-workspace-edits`）时**拒绝启动**。挂起行记录来源：`from`、`taskId`、`traceId`、该消息的信任档、`contextId`。
- **toolName 的来源**：`requestPermission` 不带工具名（F-21）。宿主按 `toolCallId` 关联同一轮里先到的 `tool_call` sessionUpdate 的 `_meta.claudeCode.toolName`；P14.2 要有一条用例证明它总是先于 `requestPermission` 到达，否则退回用 `(kind, title)`。**不为此改基座 `src/services/acp/permissions.ts`**。
- **投递路径**（不走 notify：notify 回的是任务发起方，F-22）：
  1. 节点把挂起行写进台账（`<config>/resident/` 下，已被 `NODE_STATE_DIRS` 覆盖）。
  2. 审批控制台对 `--approver` 覆盖的每个节点**主动拨号并保持链路**。控制台拨号、节点不拨号，H-2 不变。
  3. 链路就绪时节点推送挂起行，控制台通过 `supportedTypes` 声明自己能收 `authz.request`（节点 → 中枢的专用消息），不升 `FRAME_VERSION`。
  4. 中枢按会话属主路由到审批人（§3.3）；控制台不在线时挂起行留在节点台账，链路恢复后按序排空、不重复。
  5. 节点只向身份匹配的链路推送。PSK 档下这只是标签（与 `tenancy-m1.md` §1.4 同一局限），mTLS / L1 签名握手档下由密码学保证。
- **非控制台会话发起的 turn**（对端 `task.request`、值守作业、`DEFAULT_CONTEXT`）一律走 D-4(a)：立即拒绝，挂起行只能由 ops 审批。**值守作业只能设计成不触发 C**：授权流对值守作业只会拒绝。
- **③ 资源协商**：M1 生产空集（F-5）。P14.6 只做出借方 `authorize` 接 GrantStore 的契约与用例。

### 3.3 「用户」是谁（与 P15 v1.0 §3.5 对账）

**审批者 = P15 的个人账号主体**，按会话属主路由审批。

| 接口点 | P14 | P15（`tenancy-m1.md` §3.5） |
|---|---|---|
| 审批者标识 | `AuthzDecision.approver` = `<控制台名>/<subject>`，例如 `hub/u:7f3a…` | `ConsolePrincipal.subject`（`u:<16 位十六进制>`，永不复用） |
| 谁能批哪条 ask | 审批者集合 = `ownerOf(contextId)` ∪ 个人 `ops` 账号；`ownerOf` 为空的 ask 只由 ops 批 | 导出 `ownerOf(contextId)` |
| 审批凭据 | **独立的 HttpOnly 审批会话**（独立 cookie 名，只装会话 id，`HttpOnly; Secure; SameSite=Strict`），由个人凭据单独换取，30 min 失效；决定 POST 另要 `X-Qianmo-Console` 头与回传摘要。脚本可用个人凭据 `Authorization: Bearer`。**不要求 Bearer-only，不另发第三枚 token** | `ConsolePrincipal.credential` 与 `authenticatedAt` |
| 不能审批的主体 | `legacy:view`；break-glass admin token | D7 的四条限制 |
| 节点侧校验 | 节点本地 `--approver <name>=<publicKey>`，只认一把控制台审批公钥；**节点不能离线校验主体**，主体由控制台背书 | 不提供节点可离线校验的审批者材料 |
| 主体吊销 | `authz.revoke` 带 `approver` 维度，控制台吊销主体时扇出；节点不可达时最坏延迟 = D-5 上限 | 吊销时回调扇出 |
| 账本 | 节点审计链是授权判决的权威记录；报表的「审批者」注明由控制台背书 | 控制台动作账本（P15.9）记「主体对 `requestId` 提交了决定」，两边以 `requestId` 关联 |
| 求值顺序 | 认证 → 会话属主作用域 → 授权 | 同 |
| 注册中心 | **不从注册中心取任何授权材料**（节点公钥、审批投递端点） | P15.8 注册中心写 token |
| 先后 | P14.5 排在 P15.5 之后 | P15.5 先落 |

`--approver` 与 `--trust` 是两条轴：`--trust` 答「谁能指挥本节点」，`--approver` 答「谁能代表本节点的用户同意」（沿用 `key-distribution.md` §10.5 的分轴论证）。

**启用顺序只有一个方向**，与 `--wake-sign` 同理：

```
1. qm console --print-approver-identity     # → console=<approverPublicKey>
2. 每个节点加 --approver console=<approverPublicKey>（姿态保持 acceptEdits；前提 P14.0 已部署、P14.9 已满足），重启节点
3. 控制台开启审批（前提 P15.5 账号已上线），重启控制台
```

反过来做的后果可诊断而不是静默：第 2 步之前节点的 ask 仍按缺省拒绝，控制台的审批会被节点以 `authz.refused(reason=approver)` 拒掉并落链。

### 3.4 时效凭据的形状

**grant = 本节点的持久行加状态机。**签发者就是唯一校验者，把 grant 做成本节点自签 capability 只在「agent 能写 grant 表却读不到节点私钥」时有增益，而两者同受 hardline 保护，所以 capability 形式可选、不作安全论证。绑定行 `{grantId, requestId, digest, scope, contextId, approver, decisionRef, expiresAt, consumedAt?, revokedAt?}` 与挂起行都放在 `<config>/resident/` 下，这里已被 hardline 的 `NODE_STATE_DIRS` 覆盖，不必再加 basename。

**审批者的「是」不能用 capability 装**，三个原因，任一单独成立：

1. 审批来自控制台 = 远端签发者，`act = user-confirmed` 按 S-1 必拒（F-2）；降为 `write-limited` 则与对话令牌同形，缺签名域分隔。
2. claims 字段封闭（F-1），装不下 `decision`、`digest`、`approver`。
3. 审批的一次性不能靠内存 nonce 表（TH-2），要靠持久化的挂起行。

因此新增 **`AuthzDecision`**（P14.3 实现，`protocol.md` 增一节承载）：

| 字段 | 取值 | 约束 |
|---|---|---|
| `v` | `1` | 其他值即拒 |
| `requestId` | 节点生成的 128 bit 随机 id | 必须命中本节点一条 `pending` 挂起行 |
| `aud` | 目标节点名 | ≠ 本节点即拒 |
| `sub` | `qianmo://<node>/<agent>` | 与挂起行一致 |
| `digest` | 64 位 hex | 与挂起行一致；控制台从页面回传，服务端先复核 |
| `decision` | `allow-once` / `allow-window` / `deny` | — |
| `windowMs` | 整数 | `allow-window` 时 `0 < windowMs ≤ 60 min`，其余为 `0` |
| `approver` | `<控制台名>/<subject>` | 由控制台背书；`legacy:*` 值即拒 |
| `nbf` / `exp` | epoch ms | `exp − nbf ≤` 请求 TTL |
| `nonce` | 随机串 | 只作第二道；一次性以挂起行迁移为准 |

字段封闭；签名覆盖原样送达的字节，独立签名域 `qianmo-authz-decision-v1`。校验顺序照搬 `verifyCapability` 的纪律：结构 → 绑定（`aud`、`requestId` 命中本节点挂起行、`digest` 相等）→ 时钟 → 审批者集 → 验签 → 状态机迁移（最后一步才有副作用）。`authz.request` 由节点私钥在 `qianmo-authz-request-v1` 域下签名。密钥、编码、签名原语全部复用 `packages/capability/src/keys.ts`，不引入依赖。M1 没有租户，`AuthzDecision` 不带 `tenant` 字段。

**摘要**：`digest = sha256(canonicalJSON([node, agent, contextId, toolName, project(toolName, rawInput)]))`。按工具的规范化投影：

| 工具 | 投影 |
|---|---|
| Bash | `command`、`run_in_background`、`dangerouslyDisableSandbox`；**去掉 `description`** |
| Write | `file_path` 与 `sha256(content)` |
| Edit | `file_path`、`old_string`、`new_string`、`replace_all` |
| Read | `file_path`、`offset`、`limit` |
| WebFetch | `url` |
| ExecuteExtraTool | `tool_name`，外加对 `params` 按目标工具递归投影 |
| 其余工具 | 全量规范化 |

按原样 `rawInput` 做摘要的话，Bash 的 `description` 与键序一变就摘要不符、反复申请。

### 3.5 主动撤销：短寿命 + 本地撤销 + 急停

吊销清单适合「签发方离线、校验方众多」的证书（`key-distribution.md` §6.4）。grant 恰好相反：签发方与唯一校验方是同一个节点。

| 撤销对象 | 路径 | 最坏延迟 |
|---|---|---|
| 单条 grant | 控制台 `authz.revoke`（审批私钥签名）→ 一跳 → 节点删 grant、记 `authz.revoked` | 节点在线：一次投递；不可达：grant 剩余寿命（≤ 60 min）。控制台对未送达的撤销显示「未送达」 |
| 某审批者签过的全部 grant | P15 吊销主体 → 控制台按 `approver` 扇出 `authz.revoke` | 同上 |
| 节点全部 grant | 节点本地 ESTOP（P13.5）：engaged 时 GrantStore 一律不命中 | 即时 |
| 会话结束 | 该 `contextId` 的 grant 一并失效 | 即时 |
| 挂起请求 | 自然过期，记 `authz.expired` | 请求 TTL |
| 审批私钥 | 从各节点 `--approver` 移除并重启 | 取决于运维，无上界 |

**撤销消息在节点侧不受 ESTOP 与队列满影响**：`#receive` 里 `authz.*` 的消费位置紧接 `this.#router.inbound(message)`（`src/services/qianmo/resident.ts:826`）之后、ESTOP（`:848`）之前，撤销永远能进。**不做续签**：时间窗到期即失效。

### 3.6 调用方在审批期间看到什么

两种形态（D-4）：**有界同步等待**——宿主持有这次 `requestPermission` 最多 `min(60 s, 看门狗剩余 − 10 s, 任务 TTL 剩余)`，期间审批到达即放行，只对签名控制台会话发起的 turn；**拒绝即返回**——宿主立刻拒绝，拒绝文本由宿主生成（含 `requestId`，不含任何远端文字）。超时退回拒绝即返回；控制台随后提供「批准并继续」：批准后发一条新的入站 `task.request` 续跑，这是入站任务，不违反 E4 与 R-3。

约束来自既有机制：turn 门是节点级串行 FIFO（`packages/resident/src/turn-gate.ts:76-138`，上限 `maxQueuedTurns: 32`，`packages/protocol/src/limits.ts:61`），等待会阻塞整个节点的队列；`defaultTaskTtlMs = 5 min` 封顶整条任务；不活动看门狗 `DEFAULT_RESIDENT_INACTIVITY_MS = 120_000`（`packages/resident/src/inactivity.ts:15`）必须知道「在等审批」不是卡死。

## 4. 「100% 经过、无绕过」的机器判据

**被判定的性质**：凡**被执行**、且在**配置姿态**下判为 ask 的调用，都有一条对应的 `authz.grant_used`，且能沿 `grantId → requestId` 追到一条 `authz.approved`。被拒的动作不算绕过。C 随姿态变化，姿态由报表如实呈现。

思路与 S-3 相同：**把旁路逐条列出，每条变成一个会变红的断言，并用 fixture 钉住红方向**。

| # | 旁路 | 断言 | 形态 |
|---|---|---|---|
| I-1 | 会话进入不 ask 的宽松模式 | `ResidentPermissionMode` ⊆ {`dontAsk`, `default`, `acceptEdits`}；常驻代码剥离注释后不出现 `'bypassPermissions'` / `'auto'` 字面量；**结构断言**：常驻工具面不含 `EnterPlanMode`、`ExitPlanMode`、`CronCreate`、`CronDelete`、`CronList`；真 ACP 用例「EnterPlanMode 不可用」 | 类型 + 单测 + 扫描 + 真 ACP |
| I-2 | allow 规则进入常驻会话 | 建会话后 `alwaysAllowRules` 为空；**真 ACP 用例：Skill `allowed-tools` 在常驻会话里不生效**；ACP 子进程环境带 `CLAUDE_CODE_SAFE_MODE=1` | 集成 + 真 ACP |
| I-3 | 宿主在别处放行 | 宿主回 `selected` 的构造点全仓唯一（授权模块内），`optionId` 只可能是 `allow` / `reject` | 扫描 + fixture |
| I-4 | 模式切换选项（F-9） | 对 `ExitPlanMode` 请求宿主恒拒；四个 optionId 各一条负向用例 | 单测 |
| I-5 | 额外的 `user-confirmed` 签发点 | **运行时**：`NodeCapabilities.issue()` 对 `UserConfirmed` 抛错，只有 grant 模块走专用函数；**扫描**：所有 `issueCapability(` / `.issue(` 调用点的 `act` 必须是字面量 | 单测 + 扫描 + fixture |
| I-6 | 审批者与指挥者混同 | `--approver` 公钥 ∩（`--trust` ∪ 证书目录 ∪ 本节点公钥）= ∅，否则拒绝启动；**每次校验决定时也做**（`--trust-ca` 证书目录会运行中变化） | 单测 |
| I-7 | 协商缺省放行（F-5） | `LenderOptions.authorize` 必填；`lender.ts` 中不再有 `?? true` | typecheck + 扫描 |
| I-8 | 基座 API 改权限状态 | S-3 扫描的 `SCANNED` 加入授权模块；`FORBIDDEN` 补入 P14.2 探针确认的改规则 / 改模式 API | 既有扫描扩容 |
| I-9 | 有 ask 没记录 | 宿主每次收到 `requestPermission` 先写 `authz.asked` 再作答（spy 断言次数相等）。**这是记账不变式，不得当作无绕过的证据**：旁路根本不产生请求 | 单测 |
| I-10 | 审计链自洽 | `qm audit --authz-report` 发现「`grant_used` 无对应 `approved`」「`approved` 无对应 `requested`」即退出码 1。**同为记账不变式** | CLI |
| **I-11** | 结构旁路回退 | 真 ACP 子进程旁路语料：E-1 ~ E-5 各一条，修复回退时必红；语料加进上游同步棘轮全套 | 真 ACP + fixture |
| **I-12** | hardline 覆盖面 | 控制台 identity（同机不同配置根）的词法规则、记忆根、配置根下的 `agents/`、`skills/`、`plugins/`、挂起行与绑定行位置，file 与 shell 双面各一条负向用例 | 单测 |

**抽查方法**（出口判据后半句）：

1. **攻击语料**（验收场景 `authz/*`，放在 `demo/lib/acceptance/scenarios/`）：对 P14.2 快照中每一类 ask 至少取一个动作，分别经签名控制台对话与签名对端 `task.request` 触发。判据：恰好一条 `authz.requested`；批准前无副作用；批准后恰好一次 `authz.grant_used` 与副作用；重放审批、他节点审批、`--trust` 节点签的审批、摘要被换的审批、`legacy:*` 主体的审批各被拒一次并有记录。**同一份部署连续两轮零红才算通过**。
2. **全量复判**（取代 v0.1 的随机抽 k 个 turn）：对一个时间窗内的**全部**常驻 turn，取节点侧会话转录中实际执行过的工具调用（**含子 agent sidechain 转录**），用**配置姿态**、空规则、无 hook 离线重跑基座权限管线；凡判为 ask 而无对应 `authz.grant_used` 的即为绕过。离线管线、零模型调用。复判脚本不读宿主写的任何授权记录。**局限**：复判时的文件系统状态与当时不同，路径类判定可能有偏差，报告里写明。

## 5. 权限审计报表

**数据来源**：节点审计链（授权判决的权威记录）加控制台动作账本（P15.9，谁提交了决定），两边以 `requestId` 关联。报表可信度等于链的可信度：先跑 `--verify`（有见证则带 `--witness`），结果印在报表头。

| 类别 | kind（source） | 状态 |
|---|---|---|
| 授权流 | `authz.asked` / `authz.requested` / `authz.approved` / `authz.denied` / `authz.expired` / `authz.revoked` / `authz.grant_used` / `authz.refused`（带 `reason`：replay、aud、approver、digest、expired、estop、budget、no-turn） | P14 新增，落 `capability` 源 |
| hardline | `authz.hardline_denied`：ACP 子进程经一个新的 `qianmo/*` ext 通知上报，宿主落链（沿用 `packages/resident/src/acp-turn.ts:50-61` 的通道形态） | P14 新增 |
| 姿态 | `authz.posture`：启动时记模式、`--allow-workspace-edits`、策略、信任集名、审批者集名、**安全模式开关、是否存在 managed hook、P16 远端 embedding 开关** | P14 新增 |
| 既有 | `capability_denied`、影子审计 `capability_shadow_refusal`、证书目录事件（`auditTrail.ts:169-178`、`:601`、`:654`） | 已有；`negotiation.*` 在生产上不存在（F-5） |

**为什么落 `capability` 源**：读取端不校验 `source`（`packages/audit/src/trail.ts:165-181`）；这些都是 C-5 的判决，与 `capability_denied` 同层，控制台按源筛选时一处可见。新增源的代价只是控制台筛选项（`packages/console/src/view/audit.ts:293`）与其计数断言（`packages/console/test/view.test.ts:963-968`）。

**报表字段**：逐条请求一行——`requestId`、节点、agent、`contextId`、来源（`from` / `taskId` / `traceId` / 信任档）、工具、摘要前 12 位、状态、审批者（注明由控制台背书）、决定时延、grant 作用域与到期、使用时刻、拒绝次数；汇总按节点 × 时间窗；外加姿态一栏。

**呈现**：CLI 上 `qm audit` 暴露 `TrailQuery` 已有的 `--source` / `--outcome`，新增 `--kind`（前缀匹配）与 `--authz-report [--from --to] [--json]`，I-10 的退出码语义与 `--verify` 一致（`qianmoAudit.ts:100-103` 的头注释）。控制台：viewer 只看汇总计数；审批人看到自己会话的待批列表原始输入与逐条报表；ops 看全部。

## 6. 任务包

### 6.1 包表

| 包 | 目标 | 依赖 | DoD（可机检） | 估算 |
|---|---|---|---|---|
| **P14.0** 常驻权限旁路加固（热修，**进行中**，分支 `security/resident-permission-bypass`） | 修 E-1 ~ E-4；hardline 按词法拒绝身份私钥路径，以及配置根下的 `agents/`、`skills/`、`plugins/`；ACP 子进程安全模式；常驻工具面去掉 plan 与 Cron 类工具 | 无（不依赖任何 D 决策） | 真 ACP 旁路语料 E-1 ~ E-4 各一条：修复前红（回退修复的 fixture 下红）、修复后绿；常驻工具面不含 `EnterPlanMode` / `ExitPlanMode` / `CronCreate` / `CronDelete` / `CronList`（结构断言）；`defaultSpawnAcp` 产出的子进程环境含 `CLAUDE_CODE_SAFE_MODE=1`，关闭它的开关 `--allow-user-customization` 进 `authz.posture`（单测）；hardline 对同机控制台 `*/qianmo/identity/*`、`<cfg>/{agents,skills,plugins}/*` 判 DENY，file 与 shell 双面各一条负向用例；`bun run precheck` 全绿；基座文件改动为零，或只有 `createSessionMethod.ts` 一行（H3，可选）且 PR 注明理由。**部署**：随 v2.46.3 在 2026-10-03T18:20:23Z 窗口后部署；舰队修好后向基座上游报告 E-1 | 8–16 |
| **P14.1** ⚖️ 设计定稿与范围回写 | 本文 v1.0；章程 C-5 补注；roadmap 回写 | 无 | 本文文首为 v1.0；章程版本号升一（v2.19）且 C-5 行含本文的补注；roadmap M1 节出现 P14.0–P14.9 指针；`git grep -n "P14\.[0-9]"` 只命中本文、roadmap、章程、`beta-env.md`（§3.6 告知）与两份相邻设计；§7 每条决策有结论 | 4–8 |
| **P14.2** 探针、ask 快照与旁路语料 | 证明 §3.2 的前提，产出 C_tool 快照；把评审实验收进仓库 | P14.0 | 常驻 ACP 会话在 `acceptEdits` 下对一条工作区外 Bash 写操作到达宿主 `requestPermission`（真 ACP 子进程，非 mock）；语料覆盖 F-26 全部 22 个工具，外加经 `ExecuteExtraTool` 能触达的延迟工具；ask 快照按平台分文件入库；toolName 的 `tool_call` 先于 `requestPermission` 到达有一条用例；安全模式开时 hook、agent、skill 不生效，关时同一用例红；I-11 语料进上游同步棘轮的脚本列表（grep 断言） | 12–20 |
| **P14.3** 授权对象与 GrantStore | `AuthzRequest` / `AuthzDecision` / grant 行的类型、签名与校验；持久化挂起行状态机；规范化摘要 | P14.2 | 字段封闭（多键即拒）；两个签名域互不接受；校验顺序用例（未签名垃圾烧不掉真审批的 nonce）；重放 / 他节点 / 摘要不符 / 过期 / 非审批者 / `legacy:*` approver 各一条负向用例；重启后重放同一审批被拒；grant 与 hardline 冲突时 hardline 胜；§3.4 投影表每个工具一条「描述或键序变化不改摘要」的用例；挂起行与绑定行落在 `<config>/resident/` 下（file 与 shell 双面各一条负向用例）；零 mock | 20–32 |
| **P14.4** 常驻宿主接线 | `requestPermission` → GrantStore → 挂起 / 放行；hardline 拒绝上报；姿态记录 | P14.3 | I-1、I-3、I-4、I-9 全绿；`--approver` 与 `dontAsk` 同时出现时拒绝启动；不在活动 turn 内到达的 ask 被拒并记 `authz.refused(reason=no-turn)`；ESTOP engaged、审批者被吊销、会话结束时 grant 不命中；等待形态按 D-4 实现（60 s 与两个上限各一条 `ManualClock` 用例）且不触发看门狗误判；§5 表中 P14 新增的 kind 全部有落链用例；`packages/resident` 零 mock 保持 | 28–44 |
| **P14.5** 传输与控制台审批面 | `authz.request` / `authz.decision` / `authz.revoke` 三个消息类型与审批页 | P14.4、**P15.5** | 新类型经 `supportedTypes` 声明、`FRAME_VERSION` 未变（grep 断言）；控制台对 `--approver` 覆盖的节点主动建链，节点零次拨号（H-2 扫描断言）；控制台缺席时挂起行留节点台账、回来后按序排空不重复；中枢按会话属主路由（他人会话的 ask 不出现在审批人列表，用例）；审批决定只收审批会话或个人凭据 Bearer，`legacy:*` 与 break-glass 被拒；回传摘要不符即拒；审批页带 `X-Frame-Options: DENY` 与 CSP 响应头；bidi 与控制字符显式化语料；`ExecuteExtraTool` 审批页展开目标与参数；未送达的撤销显示为未送达；按审批者扇出撤销有用例 | 36–64 |
| **P14.6** 出借方 `authorize` 接 GrantStore 的契约与用例 | 按 D-9 缩小 | P14.3 | I-7 成立（typecheck + 扫描）；无 grant 时 offer 被拒并产生挂起行；有 grant 时放行并记 `authz.grant_used`；AC-7 连续 3/3 不回归。演示脚本 `p61-scenario.ts` 的脚本化钩子不在本包范围 | 4–8 |
| **P14.7** 无绕过棘轮与全量复判 | §4 的 I-2、I-5、I-6、I-8、I-10、I-11、I-12 与两种抽查 | P14.4、P14.5 | 每个扫描都有「会开火」的 fixture；E-1 ~ E-4 各一个复判 fixture，回退修复后复判必报 ≥ 1；复判覆盖子 agent sidechain；`authz/*` 验收场景在同一份部署连续两轮零红 | 20–36 |
| **P14.8** 权限审计报表 | CLI 与控制台两处呈现 | P14.3、P14.4 | `--source/--outcome/--kind` 有用例；`--authz-report` 在链断时报表头标红且退出码 1；viewer 调报表只得到计数（403 / 字段缺失各一条用例）；报表能按 `requestId` 关联控制台动作账本 | 16–28 |
| **P14.9** 上线前置：中枢同机节点处置 | P14 在舰队上启用之前，中枢机不得运行用户能驱动的节点，或该节点改用独立的非特权 uid，并且 hardline 覆盖中枢的全部秘密路径（现网 beta-4 在中枢机上） | P14.0 | `beta-up.sh` 断言：`peers.conf` 里与中枢同机的节点（`server=` 等于 `local-server`）若启用 `--approver`，必须同时满足独立 uid 与 hardline 覆盖清单，否则拒绝启动（正负用例各一条）；运维单页记录 beta-4 的处置结论（挪走 / 独立 uid / 只由 ops 驱动）；窗口后执行 | 4–8 |

**合计 152–264 人时**。

**顺序**：P14.0（已在做，独立）→ P14.1 → P14.2 → P14.3 →（P14.4 → P14.5）∥ P14.6 → P14.7；P14.8 在 P14.4 之后可并行；P14.9 在舰队启用 `--approver` 之前完成。串行约束：

- P14.5 在 P15.5 之后（两者都改 `auth.ts`、`http.ts`）。
- `src/services/qianmo/resident.ts` 的 `#receive` 上，`authz.*` 消费的位置固定为：`router.inbound` → **`authz.*` 消费**（不受 ESTOP 和队列满影响）→ ESTOP → 队列 → deliver。同期改 `#receive` 的包串行合并。
- P16.5 给常驻工具面加 `qianmo_memory_answer`，会改 `createSessionMethod.ts` 与 `residentToolSurface`：新工具必须进 P14.2 快照与 hardline 用例，与 P14.4 串行，P16 的 PR 要重跑 I-11 旁路语料。
- P14.5 动 `packages/protocol` 的消息类型，与同期碰 `message.ts` 的包不得并行合并。

### 6.2 明确不做

- 账号体系本身（P15）；本文只消费 P15 §3.5 的接口。
- **注册中心鉴权**：归 P15.8「注册中心写 token」；P14 写死一条：**不从注册中心取任何授权材料**。
- **改基座 `permissions.ts`**：授权钩子放在 ACP 客户端侧。基座文件改动限 `createSessionMethod.ts` 一行（H3：常驻会话设 `isBypassPermissionsModeAvailable: false`，可选纵深），PR 注明理由。
- 改 capability claims 字段集（F-1）、放宽 S-1、让跨节点消息携带 in-node `user-confirmed`。
- 策略语言与通配 grant（「允许所有 `git push *`」）：v1 只做精确摘要。
- 自动续签、移动端推送审批、以模型判断代替结构约束。
- Qianmo 自定的「必须确认」下限表（D-7）。
- 新的更严模式开关：原稿的「`dontAsk` → `default`」放弃（D-1）。

## 7. 决策（已定）

依据：主 agent 裁定（2026-09-26，依负责人委托）；E-1 的部署时机与上游报告时机由负责人本人拍板。

| # | 问题 | 结论 | 理由 |
|---|---|---|---|
| D-1 | 常驻会话模式 | **`acceptEdits`**，即现网正在用的。前提是 P14.0 先把旁路全部堵上。`--approver` 与 `dontAsk` 同时出现时拒绝启动 | 放弃原稿的「`dontAsk` → `default`」：`default` 下每次工作区写入都要审批（s4），疲劳会压垮 TH-7；而且 agent 定义里的 `permissionMode` 在 `default` 下仍然会生效（E-3，s6） |
| D-2 | 「用户」的凭据 | **审批人就是 P15 的个人账号主体**，按会话属主路由；审批走独立的 HttpOnly 审批会话，**不要求 Bearer-only**；不另发第三枚 token | Bearer-only 会把凭据放进页面 JS，而页面 CSP 是 `unsafe-inline`，XSS 能直接偷走持久凭据；HttpOnly cookie 只能被当场借用。以 N-2 A′（章程 v2.19）为前提 |
| D-3 | 审批签名密钥 | 控制台**另持一把审批私钥**；hardline 按词法拒绝 `*/qianmo/identity/*`；控制台用独立 uid 运行 | 只有密钥不同，I-6「审批者 ∩ 指挥者 = ∅」才能机械判定；现网同机（F-25） |
| D-4 | 审批期间的调用形态 | 同步等待 **N = 60 s**，并以看门狗剩余时间和任务 TTL 剩余时间封顶；只对签名控制台会话；超时退回立即拒绝，由控制台提供「批准并继续」。摘要按工具做规范化投影；`toolName` 靠 `tool_call` 通知关联，补一条到达顺序的用例 | 120 s 看门狗加节点级串行 turn 门，90 s 等待会阻塞全节点；「批准并继续」发入站任务，不打开节点自开 turn 的能力 |
| D-5 | grant 时效 | 时间窗上限 **60 min**；allow-once 单次消费、10 min 到期；ESTOP、审批者被吊销、会话结束时 grant 立即失效；grant 绑定 `contextId`，`allow-window` 只对同一摘要 | 上限同时是节点不可达时撤销的最坏延迟 |
| D-6 | 注册中心鉴权归属 | 单列 **P15.8「注册中心写 token」**，挂在 P15；P14 不从注册中心取任何授权材料；K-11 F-3 并入 P15.8 | v0.1 两份设计互推；登记簿与续租者都在 P15 |
| D-7 | 「必须确认」下限表 | 不加。复议条件：P14.2 的快照里出现任何「有副作用却被直接放行」的项 | 真正的「无需确认却有副作用」来自结构旁路，不来自单条命令 |
| D-8（新） | ACP 子进程的安全模式与常驻工具面 | 并入 P14.0：子进程缺省 `CLAUDE_CODE_SAFE_MODE=1`，开关进 `authz.posture`；常驻工具面去掉 plan 与 Cron 类工具 | 实测安全模式堵住 E-2 / E-3 / E-4，E-1 要另从工具面剔除；两处都是本地文件（`resident.ts` 的 `defaultSpawnAcp`、`residentGuard.ts` 的 `withResidentHardline`） |
| D-9（新） | C_net | **生产上是空集**：出借方协商器在生产代码里没有构造点。P14.6 缩小成「出借方 `authorize` 接 GrantStore 的契约与用例」；出口判据的 C 在 M1 只含 C_tool | F-5 |
| D-10（新，负责人拍板） | E-1 修复进舰队与上游报告的时机 | 修复随 v2.46.3 **在 7 天长跑窗口（至 2026-10-03T18:20:23Z）后**部署；**舰队修好之后**，带着修复方案向基座上游报告 | 窗口内重启节点会作废长跑证据；上游报告是对外可见动作，带修复方案去报 |

**评审修改清单里没有采纳的条目**：

- `AuthzDecision` 加 `tenant` 字段、节点比对 `--tenant`：**不采纳**，M1 不做租户（N-2 A′）。
- 审批会话「30 min 重新认证」之外的「≤ 10 min 近期认证」（P15 评审提议）：**取 30 min**，两份设计统一为同一个数。
- `default` 作为「可选的更严档」保留一个开关：**不采纳**，裁定只写 `acceptEdits`，M1 不新增模式开关。
- P14.6 里「演示迁到真实审批」：**不采纳**，裁定把 P14.6 缩成契约与用例。

## 8. 未核实与存疑

评审已答复的 v0.1 §8 条目（改为结论，方法见右列）：

| v0.1 §8 条目 | 结论 | 方法 |
|---|---|---|
| `default` 下 ask 一律到达宿主 | **主线程上成立**（s1、s4、s8）；三个例外不到宿主：hook allow（E-2）、plan+bypass（E-1）、子 agent（自动拒，或经 E-3 放行） | 真 ACP 子进程实验 A、B、D |
| 「`default` + 全拒」与 `dontAsk` 允许集相等 | 所测语料上主线程等价（s1 对 s2；`ls` 在 `default` 下也不问，s9）；PowerShell 模式分支对 `dontAsk` 回 `passthrough`，只在 Windows 出现（`packages/builtin-tools/src/tools/PowerShellTool/modeValidation.ts:132-143`）。**等价不是安全性质**：两种模式都能被 E-1 / E-2 打穿，所以 P14.2 不再用它作判据 | 实验 A、D；读代码 |
| PreToolUse hook 在常驻会话执行 | **执行，而且完全绕过**宿主（h1 / h2 / p1 / p2）；快照跨会话污染（p3）；hardline 仍然有效（h3）；安全模式下用户级与项目级 hook 失效 | 实验 B、C 及安全模式复跑 |
| 控制台是否对每个节点常驻连接 | **否**：按需拨号，对话过的节点才有常驻链路（F-23） | 读代码 |
| 现网模式与开关 | 仓库内可核实：`beta-up.sh` 固定 `--open-policy --audit-signed-tasks --allow-workspace-edits`，有测试钉住（F-24） | 读代码 |
| `tenancy-m1.md` 对账 | 已对账（§3.3） | — |
| `guard.ts` 头注释与 F-6 不一致 | 头注释对常驻会话基本仍然成立：settings 的 allow 规则不进来，但 hook allow 与 Skill `allowed-tools` 都能在常驻会话里放行。头注释保留，改的是 F-6 | 实验 B、G |

**仍未核实**：

- **现网节点进程 uid**：E-1 的前提是非 root，或设了 `IS_SANDBOX`。仓库里没有 uid 证据，没有连舰队。
- **`CLAUDE_CODE_SAFE_MODE=1` 对现网的副作用**：只在本地假模型下验证了 hook、agent 失效与本轮照常 `end_turn`；是否影响节点从 settings 读取的 provider 或模型配置、是否影响 P13.7 记忆 sidecar、`qm watch` 端到端与验收场景，都没验证。另按 `src/utils/config/envUtils.ts:68-74` 的注释，安全模式关掉的不止 hook、agent、skill、plugin，还有 CLAUDE.md、自定义命令、output style 与 settings 里声明的 MCP server（管理员策略仍生效；`qianmo_notify` 是直接注入的工具，不经 MCP，见 `notifyTool.ts` 头注释）；常驻 agent 是否依赖工作区 CLAUDE.md 没查。P14.0 在部署前要补。
- **Cron 在 ACP 模式下是否触发**：E-1 下 `CronCreate` 能建出作业，75 s 内没触发；调度循环在 ACP 模式下是否运行没查清。「节点自开 turn」没有被证实。
- **E-3 只测了 `permissionMode: bypassPermissions`**；`plan` 加 bypass 的变体是静态推断。
- **Skill `hooks` frontmatter 的注册**只做了静态核实；实测的是 `allowed-tools`。
- **toolName 的到达顺序**：`tool_call` 是否总先于 `requestPermission` 到达，没测（P14.2）。
- **全量复判的可行性**：离线重建 `ToolUseContext` 时文件系统状态不同，没有原型。
- **估算**是对 v0.1 区间的增量修正，没有经过排期评审；日期不在本文承诺范围内。

## 9. 部署计划与上线前置

1. **P14.0**：代码可以先合入；部署随 v2.46.3 在 2026-10-03T18:20:23Z 之后。部署之前舰队上 E-1 仍然开着。
2. **上游报告**：P14.0 在舰队上部署并复测之后，带着修复方案向基座上游报告 E-1。报告是对外可见动作，材料按章程 §5.8 的对外口径由负责人确认。
3. **P14.9**：中枢同机节点处置完成、`beta-up.sh` 断言上线之后，才允许任何节点带 `--approver` 启动。
4. **P15.5** 上线之后，控制台才开启审批（§3.3 启用顺序第 3 步）。
5. 对外引用出口判据时，附 §1.1 的对外口径。

**遗留风险**：

- 即使 P14.0 落地，hardline 仍是词法匹配，可以被混淆；现场节点没有沙箱。
- `acceptEdits` 下，批准的命令可能执行 agent 在工作区里写的代码（TH-9），只能靠审批页呈现缓解。
- 审批私钥在中枢。中枢失陷时所有节点的审批都可以伪造，撤销是 O(N) 的。
- 基座行为漂移：E-1 ~ E-4 的修法都依赖基座当前语义；I-11 语料若没进上游同步棘轮，就会静默回退。
- E-1 在修复部署到舰队之前一直存在。
