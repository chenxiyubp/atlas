<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest — 控制台模型服务（provider）管理与商业级改造设计（M1 · P18）

| 项 | 内容 |
|---|---|
| 文档版本 | **v1.1（生效）**。负责人决定来自 2026-10-03 对话记录（§0.1 的 D-1 ~ D-7），其余裁定由主 agent 按 M1 委托作出（§1.2）。v1.0 的四个待决点负责人已于同日拍板，见 §13 |
| 日期 | 2026-10-03 |
| 核对基点 | origin/main `33dc81bf`（PR #154 的合入提交）。**本文自己引用的行号**都在这个提交上核过，清单见附 B。**从 hermes 调研 §11 转引的阡陌行号**按该调研的基线 `e123b2ec` 记，本文没有逐条在 `33dc81bf` 上复核 |
| 本文范围 | **只有设计，不改代码。**范围回写与本版同批完成，记为 P18.0：章程 v2.22、roadmap v2.80、`beta-env.md` v1.4 补注、`node-provisioning.md` 补注、`tenancy-m1.md` §6.1 补注 |
| 范围依据 | 负责人 2026-10-03 的原话与三项决定（§0.1）；章程 v2.22 的 N-5 补注和新增的 §2.4；roadmap v2.80 在 M1 方向表新增的「模型服务与控制台商业级」一行 |
| 上游文档（只给指针，不复制） | [`console.md`](./console.md)、[`beta-env.md`](./beta-env.md)（§8.3）、[`node-provisioning.md`](./node-provisioning.md)（v0.1-draft，§3.3、§3.4、§5、§8）、[`tenancy-m1.md`](./tenancy-m1.md)（§3.2、§6）、[`authorization-m1.md`](./authorization-m1.md)（TH-5）、[`key-distribution.md`](./key-distribution.md) |
| 调研输入（不入库） | 运维本机私有证据目录 `m1-work/providers/` 下的五份调研：`atlas-provider-matrix.md`（运行时现状与热切换）、`console-audit.md`（控制台商业级差距审计，A1–K2 编号出自这里）、`ccswitch-research.md`、`vendors-research.md`（2026-10-03 按各厂商官网核实）、`hermes-research.md`（§11 调用层逐项对照，#1–#33 编号出自这里） |
| 编号 | 本文的包记作 P18.x（全仓 grep 过，没有占用）。调研件里的编号原样引用：控制台差距 A1…K2，hermes 差异 #1…#33 |
| 结论一句话 | 模型服务按六件事来做：**目录只放一处，中枢加密保管密钥且只写不读，用 SSH 第六类动作下发，节点原子写入，在空闲时热切换，期望状态和实际状态分开对账。**控制台上从预设卡片选厂商、只填 key、一键切换，节点不用重启。每个模型发不发 effort、走哪条线路，都是显式字段；界面上显示的就是节点用真实门控函数算出来的结果。调用层按 hermes 给的三批补齐（止血 → 推理一致性 → 韧性），规则表放进阡陌自有文件，基座文件只改调用点。控制台先换多路由外壳、补齐十一项 P0，再做模型服务页。核心包 P18.0–P18.13 合计 **632–930 人时** |

**变更记录**

| 版本 | 日期 | 说明 |
|---|---|---|
| **v1.1** | **2026-10-03** | **回写负责人对 v1.0 §13 四点的拍板（D-4 ~ D-7）。**第六类动作不要 provision token，用个人账号的 ops 角色；真 key 只用现有 `gpt-6-luna` 凭据；多 key 轮换进 M1，新增 P18.18（B4，24–40 人时），核心合计改为 656–970 人时，全部合计改为 1006–1480 人时；发版预先授权，由主 agent 执行。同步改了 §0.1、§0.5、§1.2 R-13、§1.3 O-3、§5.6 第 2 行、§7.4、§8.4、§9、§10、§11、§13 |
| **v1.0** | **2026-10-03** | **定案。**负责人三项决定（前端技术形态不变、中枢持有加密密钥并新增第六类动作、套餐 key 支持并标注条款）；改写两处旧定案（`beta-env.md` §8.3「H 上没有这一份」、`node-provisioning.md`「动作集钉死五类」）；hermes §11 的 33 项全部落到包里，没有「待补」项；包表分 B0–B5 六批 |

---

## §0 问题定义

### 0.1 负责人原话与决定（2026-10-03，对话记录）

原话：

> 「优化前端，让前端完全商业级生产级完成度和可用度，而且我希望前端能很容易的像 ccswitch 那般配置 api 服务」
>
> 「要无缝适配各种 ai，使用 ccswitch 并且去各个 ai 官网调研，也可以使用 hermes agent 那一套」
>
> 「调用模型兼容尽量参照 hermes agent，他们做的很好」

以下决定照此定案，不再回问。D-1 ~ D-3 是设计之前定的；D-4 ~ D-7 是同日对 v1.0 §13 四个待决点的拍板：

| # | 决定 | 落在本文哪里 |
|---|---|---|
| **D-1** | 前端保持**服务端渲染、零新依赖、零外部资产**，这是 2026-08-28 的定案，不变。交互只用少量原生 JS 做渐进增强 | §6、§7.1 |
| **D-2** | **中枢持有模型密钥**，加密存储，只写不读。SSH 控制面新增**第六类钉死动作「下发模型配置」**。这条推翻两处旧定案，逐条见 §1.3 | §2、§3.7–§3.8、§7 |
| **D-3** | **套餐 key 也支持**。界面上标出条款限制，由使用者自己判断 | §4.3、§6.6 |
| **D-4** | 第六类动作**不要求 provision token**，要求个人账号的 ops 角色，由动作账本记录操作者。确认 R-13 | §1.2 R-13、§1.3 O-3、§7.4 |
| **D-5** | **真 key 只用舰队现有的 `gpt-6-luna` 凭据**；其他预设一律保持「未评估」 | §8.4、§13 |
| **D-6** | **多 key 轮换（hermes #2）进 M1**，新增包 P18.18 | §9.2 P18.18、§13 |
| **D-7** | **发版预先授权**：P18 核心包合入、干净 clone 的 `bun run verify` 全绿之后，主 agent 直接定版本号、打标签、发布，并部署到内测舰队；之后各包的开发、合并、发版、部署都不再逐项等负责人授权 | §9.2 P18.13、§13 |

### 0.2 已经执行的现场事实

- 2026-10-03，三个常驻节点已经换成 `gpt-6-luna`，节点环境设了 `OPENAI_WIRE_API=responses`、`CLAUDE_CODE_EFFORT_LEVEL=max`、`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1`。
- **第三项不能省。**`gpt-6-luna` 不在能力表里：`isChatGPTCodexReasoningModel` 匹配不到 `gpt-6`，全 `src` 也搜不到 `gpt-6`。于是 `modelSupportsEffort()` 返回 false，Responses 线在 `src/services/api/openai/index.ts:350` 就不发 `reasoning.effort`。设了 `ALWAYS_ENABLE` 之后，`effort.ts:60` 第一行就返回 true，effort 才会发出去。负责人抓请求体证实了这一点。
- 这次切换是负责人知情决定的，让 7 天长跑在 2026-10-03T09:33:08Z 提前结束。三个节点切换前后用同一份交付树、同一组启动参数，只换了 `secrets/model-env`。
- **教训**：「这个模型发不发 effort」「走哪条线路」都不能留给模型名启发式去猜，要做成**每个模型的显式字段**；控制台显示的值必须和线上发出的请求体是同一个判断（§3.4、§5.2）。

### 0.3 要解决的五件事

| # | 问题 | 现状（`33dc81bf`） |
|---|---|---|
| Q1 | 像 CC Switch 一样配置模型服务：选预设 → 只填 key → 一键切换 | 控制台里没有任何 provider 或 model 的代码。基座的 `/provider` 档案只服务本机终端（`src/services/providerProfiles/`） |
| Q2 | 密钥由中枢保管 | 密钥在每台节点的 `secrets/model-env` 里，以 shell 片段形式存放；`beta-env.md` §8.3 明写 H 上没有这一份 |
| Q3 | 下发到节点，并且不重启就生效 | 改 `model-env` 永远进不了已经在跑的进程。直接写 `settings.json` 会让同一个 ACP 子进程里的所有会话一起串线（matrix §4.4 三个问题） |
| Q4 | 无缝适配各家模型，兼容做法参照 hermes | hermes §11 列了 33 项差异；最大的几处：第三方线路没有 fallback；未知模型一律发 `max_tokens: 64000`；只认 `reasoning_content`；回放不看目标端点 |
| Q5 | 控制台整体达到商业级、生产级的完成度 | 审计列出 P0 十一项、P1 约三十项、P2 约十七项（`console-audit.md` §9） |

### 0.4 「商业级」的判据

控制台整体沿用 `console-audit.md` §1 的八条（URL 可直达、异步动作有即时反馈、按角色呈现、失效与离线有明确状态、后台刷新不吞掉正在做的事、键盘可达且满足 AA 对比度、防点击劫持且凭据不进 URL、多实例长跑下性能可预期）。模型服务另外加四条：

1. **配置只要三步**：选预设（或自定义）→ 填 key → 保存并切换。已知厂商不需要用户知道线路、URL 后缀或 effort 字段名。
2. **结果是可验证的**：界面上的「线路 / 模型 / 发不发 effort / 档位」等于节点按真实门控函数算出的值，也等于录制桩收到的请求体（AC-P4）。
3. **可对账**：期望状态（中枢）和实际状态（节点）分开记录，漂移有类型、有修复动作，不会静默。
4. **密钥只写不读**：任何页面、接口、日志、导出、账本、进程参数里都看不到明文（AC-P2）。

### 0.5 本版不做

| 不做 | 理由 |
|---|---|
| 计费、定价、账单 | 章程 N-1 仍然有效。界面上不展示价格，目录里也不存价格 |
| 多 key 池的 `random` 选取策略（hermes 四种之一） | 不可复现，测试难以断言；多 key 轮换本身已经进 M1（D-6，P18.18），只做 `fill_first`、`round_robin`、`least_used` 三种 |
| 同一节点同时挂多家 provider | 阡陌一个进程只服务一家 provider（hermes §11.1 对照），v1 也只做「节点当前用哪一份档案」 |
| 托管 OAuth 或订阅登录（ChatGPT、Claude、Copilot、xAI 订阅） | 有条款风险（`ccswitch-research.md` §9.3 第 8 条），而且登录态是节点本地的 0600 文件，每小时刷新，不适合集中下发 |
| 本地协议互转代理、熔断与故障转移代理 | 协议兼容只走阡陌自己的线路与 compat 规则（§5），控制台不再造一层代理（CC Switch 那套约 8.1 万行） |
| 中枢直接调用厂商 API | 中枢不跑 agent 轮次。测连、测速、拉模型列表都在节点上执行，那才是真实要走的那条网络路径（§5.5） |
| 推广链接、厂商 logo、赞助排序 | 我们是工具，不做导流。只显示文字，链接只指向官方文档 |
| agent 粒度的暂停动作 | `tenancy-m1.md` §6.1 写的「装机面第六类动作」原意就是这个，M1 仍然不做；第六类这个编号现在让给了模型配置（§1.3 O-4） |

---

## §1 决策

### 1.1 负责人决定

见 §0.1 的 D-1 ~ D-7。

### 1.2 主 agent 裁定

| # | 裁定 | 理由 |
|---|---|---|
| **R-1** | **目录只放一处**：新建零依赖包 `@qianmo/providers`（`packages/providers`），里面放类型、预设、校验器、第六类动作的协议 schema、闭合兼容键集。控制台和节点都 import 这一份，控制台自己**不维护任何厂商清单** | hermes B5「一处成员关系，其余只管呈现」。测试锁住「控制台可见的集合 = 节点可用的集合」 |
| **R-2** | **编译器放在 src 一侧**（`src/services/qianmo/providers/`），用基座的 `ALL_PROFILE_ENV_KEYS`、`buildActivationEnvPatch`、`buildActivationModelSettingsPatch` 生成补丁 | 包不能 import `src`。编译器和节点写入都复用基座档案激活那条已经验证过的语义（先把全部受管键置为删除，再覆盖），不另起一套 |
| **R-3** | **中枢存储分两份**：非密钥的档案与事件写进哈希链 NDJSON（复用 `packages/console/src/ledger.ts` 的行格式，严格读）；密钥单独存一个可重写的 0600 文件，按信封加密；主密钥与密文分处两个目录，内测部署时主密钥放在**配置根之外** | 照 `node-provisioning.md` §3.3 的 (b) 方案。轮换时旧密文必须真的删掉，所以密钥文件不能是只追加的 |
| **R-4** | **第六类动作 = 专用 SSH key + `authorized_keys` 强制命令 + stdin 传 JSON + 节点侧 `qm provider` 白名单**。密钥只走 stdin，不进 argv、URL、日志、审计 | 闭合由目标机的 sshd 强制，这一点在 H 失陷后仍然有效（`node-provisioning.md` §4.4 第 4 条）。客户端发的是一个不存在的哨兵命令，强制命令那一行丢了时会失败，不会静默成功（§2.5） |
| **R-5** | **写入与切换分两阶段**：`apply` 只校验并写一份 pending 意图；真正改写 `settings.json`，由 resident 在 ACP 子进程**代际边界**上完成 | 如果在旧一代子进程活着的时候改 `settings.json`，下一次 `createSession` 就会把新 env 写进整个进程，同一子进程里正在跑的会话会被换线（matrix §4.4 问题 1、2） |
| **R-6** | **热切换等空闲**：没有在途 turn 时才回收 ACP 子进程；最多等 30 min，到上限只告警、不强杀 | 回收时在途任务会被判失败（matrix §4.5 第 2 行）；值守作业的长 turn 不能被换配置打断 |
| **R-7** | **换厂商或换线路时，会话默认重置**；只换同一端点上的模型时保留会话。等 P18.8（hermes #4 回放过滤、#23 密文跨端点）合入、节点自报 `replayFilter` 之后，才允许跨厂商保留会话 | 历史里别家的 thinking 签名、`encrypted_content`、`reasoning_content` 发给新端点会 400 |
| **R-8** | **effort 是每个模型的显式字段**：`send` 取 `always / never / auto` 三态，加上档位和可选档位集合；档位只往低夹。chat 线的 `always` 在 P18.5 改掉门控之前**拒收** | §0.2 的教训。chat 线今天只对 ChatGPT codex 推理模型发 `reasoning_effort`（`openai/index.ts:499`），显式覆盖到不了线上，会出现「显示开、线上不发」 |
| **R-9** | **测连、测速、拉模型列表都在节点上执行**，返回三态 `{ok, reachable, message}` | hermes B7。中枢不碰厂商 API |
| **R-10** | **预设以国产厂商的 Anthropic 兼容线优先**；OpenAI、xAI 走 Responses；Gemini 走原生线；Mistral 走 Chat。按量和套餐分成两组。所有预设在真 key 冒烟之前一律标「未评估」 | `vendors-research.md` §6.1；CLAUDE.md「未评估」声明必须保留 |
| **R-11** | **调用层照 hermes 三批排期**；规则表放进新建的阡陌自有文件，基座文件只改调用点；阡陌的「恰好一次」重试屏障保留，新加的重试都要过这道屏障（#29） | hermes §11.7 的落法前提；章程 §7.2 第 7 条（v2.12 强化）「改完之后基座差异要退化成标识符替换或纯插入」 |
| **R-12** | **控制台先抽外壳（A1），再逐页迁移**；`legacyParity.golden.json` 按规程重生，每个包都在 PR 里写明「这次 legacy 行为本来就要变」 | 一次性重写会让 legacy 守卫整体失效（`console-audit.md` §7） |
| **R-13** | 第六类动作**不要求 provision token**，要求**个人账号的 ops 角色**，并由动作账本（P15.9）记录操作者 | 模型配置不属于装机类动作；provision token 只给 1–2 人，装机账本明写「不记操作者」，而切换模型是日常运维动作，需要知道是谁做的。这条碰到了 08-18 定案 ③ 的边界，负责人 2026-10-03 已确认（D-4） |
| **R-14** | 基座的 `providerCompatMatrix.ts` 里那套 `applyCompatRule`（没有任何生产调用方）在 P18.8 用新规则表取代后**删除**，不留两套 | hermes #4：「要么删掉要么接上，不要留两套」。这张矩阵的判据只看历史里有没有 thinking 块，hermes 的按目标端点判定更好 |
| **R-15** | 照搬 hermes 的规则表时，每个新文件头注明「规则来源 NousResearch/hermes-agent `文件:行号`，取于 `f9b29c49b6`」；`NOTICE` 第五节加一条第三方 MIT 声明，措辞照 `CLAUDE.full.md` §§0–2 和章程许可条款写 | hermes §11.8 的署名提醒。逐字复制的字符串和正则会触发 MIT 的保留义务 |
| **R-16** | 估算单位用**人时**（主开发 + AI 协作），与 `tenancy-m1.md`、`handoff-m1.md` 一致；调研件里的人日乘 8 换算 | 和现有包表口径统一 |

### 1.3 被推翻或改写的旧定案

格式统一为「原定案 → 新定案 → 依据」。原文旁边的补注随本版一起落地（P18.0）。

| # | 出处 | 原定案 | 新定案 | 依据 |
|---|---|---|---|---|
| **O-1** | `beta-env.md` §8.3 持密面表「每台节点机 `secrets/model-env`」一行 | 「**H 上没有这一份**——控制台不跑 agent 轮次，给它只是多一处可被读走的副本，而 H 正是同时装着 admin token、四把 PSK 与 SSH 私钥的那台机器」 | **H 持有全部模型密钥**：以信封加密存放（§3.8），控制台只写不读（§7.5），经第六类动作下发到节点的 `settings.json`（0600）。原文对风险的判断（H 已经是单点）仍然成立，代价写在 §7.7。节点上的 `model-env` 不再放 provider 键，迁移见 §2.9 | 负责人 2026-10-03 决定（D-2） |
| **O-2** | `node-provisioning.md` 文首「负责人已定」第 ② 条、§0 第 6 行、§5 标题与 §5.0 | 「动作集**钉死成有限五类**（装 / 起 / 停 / 建隧道 / 拉审计镜像），**不留任意命令字段**」 | **钉死成有限六类**，第六类是「下发模型配置」（`model-apply`）。「钉死」与「不留任意命令字段」两条原样保留：第六类的子操作是闭合集合 `{status, probe, models, apply}`，参数只认 JSON schema 里的字段；它的闭合同样由目标机 sshd 的强制命令保证（§2.5） | 负责人 2026-10-03 决定（D-2） |
| **O-3** | `node-provisioning.md` 文首第 ③ 条 | 「**单独一枚 `provision` token**，装机类动作要它，admin token 拿不到」 | **不改原文**。第六类不算装机类动作，不要求 provision token，要求个人账号的 ops 角色并记操作者（R-13）。这是本文对原定案适用范围的解读，负责人 2026-10-03 已确认（D-4） | 主 agent 裁定，负责人确认（D-4） |
| **O-4** | `tenancy-m1.md` §6.1「明确不做（M1）」 | 「装机面第六类动作；节点侧的单 agent 暂停」 | 「第六类」这个编号让给模型配置。原意（agent 粒度的暂停动作）在 M1 **仍然不做**；以后要做时编为第七类 | 随 O-2 |
| **O-5** | `node-provisioning.md` §3.4 OpenBao 升级触发条件第 2 条 | 「凭据种类超过『私钥 + 指纹』两类（例如引入了要定期轮换的第三方 API 凭据）」时重新评估 (c) | **触发条件已经成立，已经重评，结论仍然是不复用。**§3.4 代价第 1–4 条（跨项目部署耦合、要伸手改别人的部署、新的运行时供应链、成果边界）都没有变；节点数是 3，远低于 20。复用 OpenBao 本来能买到的三样东西，替代做法如下：审计日志 → 动作账本加密钥事件只记指纹；版本化 → 不做，轮换时旧值立即删除；seal → 不做，如实写明信封加密防不住 H 失陷 | 主 agent 按 §3.4 写死的条件重评 |
| **O-6** | 章程 N-5 v2.14 解禁行 | 解禁的是「一个**运维用**的最小 Web 控制台」；「不做面向终端用户的产品级前端」 | 章程 v2.22 补注：控制台扩为商业级完成度的运维与内测成员控制台，并加上模型服务管理；技术形态（服务端渲染、零依赖、零外部资产）不变；「面向终端用户的产品级前端」理解为面向校外公众的产品前端，**仍然不做** | 负责人 2026-10-03 原话与 D-1 |
| **O-7** | `console-audit.md` §5.3 的分期建议（只读 → 编辑非密钥 → 写密钥并先评审） | 审计建议，不是定案 | 一期就包含密钥写入。审计要求的「先评审」由本文 §7 的威胁分析加上负责人 D-2 代替 | D-2 |

### 1.4 验收判据

全部通过，章程 §8 M1 行的追加项才算满足（章程 v2.22）。

| # | 判据 | 怎么证 |
|---|---|---|
| **AC-P1** | **一键切换，不用重启**：在控制台上选预设、填 key、点「保存并切换」之后，节点 resident 的 pid 不变；下一个新会话的请求发往新端点，带新模型和预期的 effort 字段 | 真 resident + 真 ACP 子进程 + 录制桩（假厂商 HTTP 服务，记录请求体）端到端用例 |
| **AC-P2** | **密钥只写不读**：用一把金丝雀 key 走完「填写 → 存储 → 下发 → 测连 → 切换 → 导出 → 轮换 → 删除」全流程，下列位置**零命中**：中枢与节点的日志、所有页面 HTML 与 JSON 响应、动作账本、`providers.ndjson`、导出文件、`ps` 采样到的 argv、ssh 命令行、审计链。明文只允许出现在 ssh 的 stdin、节点 `settings.json`（0600）和进程内存里 | 扫描用例；`ps` 采样在 Linux CI 上跑 |
| **AC-P3** | **漂移可见**：在节点上手改一个受管键，控制台在下一次状态刷新时显示「本地改动」；不带「覆盖」确认的下发被节点以 `conflict` 拒绝 | 端到端用例 |
| **AC-P4** | **显示 = 节点计算 = 线上请求体**：对每个预设，在 effort 三态下，控制台显示的线路、是否发 effort、档位，等于节点 `status` 的计算值，也等于录制桩收到的请求体 | 逐预设对等表测试（hermes §11.6 第 2 条的可执行版本） |
| **AC-P5** | **控制台 P0 十一项**（A1、C1、C7、D1、D2、D5、H1、H3、H4、J1、J2）各有可机检的测试；H1 另有响应头断言和一次真实的 iframe 嵌入测试 | 包内单测加浏览器级用例（K1 路线） |
| **AC-P6** | **真机**：在内测舰队上，**同一份部署连续两轮零红**。每轮至少包括一次真 key 三态测连、一次真实切换（比如从 `gpt-6-luna` 换到另一个模型再换回来），以及 AC-P2 的金丝雀扫描 | 舰队验收脚本；一轮绿不算数 |

---

## §2 总体架构

### 2.1 一张图

```
                 浏览器（服务端渲染页面 + 少量原生 JS）
                        │  cookie 会话 + x-qianmo-console 头
                        ▼
┌──────────────────── 中枢 H：控制台进程 ─────────────────────┐
│ packages/console        路由 /providers …   视图   ProviderPort（接口）│
│ src/cli/handlers/consoleProviders*.ts（宿主侧实现）                    │
│   ├─ 档案账本  occConfigPath('qianmo','console','providers.ndjson')    │
│   ├─ 密文库    occConfigPath('qianmo','console','provider-secrets.json')│
│   ├─ 主密钥    --provider-key-file（内测：H 的 secrets/ 下，配置根之外）│
│   ├─ 编译器    src/services/qianmo/providers/compile.ts                │
│   └─ 执行器    按节点串行；local 直跑 / ssh 走专用 key                  │
└──────────────┬──────────────────────────────────────────────────────┘
               │ ssh -i <专用 key> -o StrictHostKeyChecking=yes node qianmo-model-apply-v1
               │ stdin：一行 JSON（含密钥）     stdout：一行 JSON（不含任何值）
               ▼
┌──────────────────── 节点：sshd 强制命令 ─────────────────────┐
│ command="<部署根>/demo/env/beta/ops/model-apply.sh <节点名>",restrict │
│   → 忽略 SSH_ORIGINAL_COMMAND，按脚本位置推出内测根                    │
│   → OCC_IDENTITY=qianmo OCC_CONFIG_DIR=<根>/nodes/<节点>/config        │
│   → exec qm provider serve-stdin --node <节点名>                       │
│ qm provider：校验白名单 → 写 pending 意图 → 发 SIGHUP（可选）          │
│ resident：空闲时 → 提交 pending 到 settings.json(0600) → 拉起新一代 ACP │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 三处各管什么

| 位置 | 管什么 | 不管什么 |
|---|---|---|
| **目录** `@qianmo/providers` | 预设数据（每条带官网出处和核实日期）、档案与模型的类型、校验器、第六类动作协议 schema（`v: 1`）、闭合兼容键集、密钥指纹函数 | 不 import `src`，不读写文件，不联网 |
| **中枢** 控制台进程 | 期望状态（档案、作用域、修订号）、密文、动作账本、执行器、页面 | 不调用厂商 API；不把密钥返回给任何调用方；不推断节点实际状态（只展示节点回报的） |
| **节点** `qm provider` + resident | 校验（与中枢用同一份 schema 再校验一次，**不信任中枢**）、受管键所有权、原子写入、代际切换、计算实际状态、测连 | 不接受白名单外的任何键；不执行任何字符串命令 |

### 2.3 一次「保存并切换」的完整时序

1. ops 在 `/providers/new?preset=deepseek` 上填 key，点「测连」。中枢把**候选档案**（含 key）通过 `probe` 发到目标节点，节点用候选配置测一次，返回三态（§5.5）。这一步不落盘。
2. ops 点「保存并切换」，选作用域（全局默认，或者某几个节点）。浏览器带上 `If-Match: <档案修订号>`。
3. 中枢校验角色（个人账号的 ops 角色）、修订号、目录 schema。然后在**同一把档案锁内**：密钥加密后写入密文库（tmp + rename，0600）；`providers.ndjson` 追加 `profile.saved`、`secret.set`（只记指纹）、`scope.assigned` 三条事件；动作账本记一条（操作者、动作、目标、`requestId`）。
4. 执行器按节点**串行**发 `apply`。`expect.ownedHash` 取**中枢记录的**该节点上一次成功下发后的 `appliedHash`，不取现查的值，否则节点上的本地改动永远查不出来。首次托管时为 `null`，节点只核对自己确实没有被托管过；中枢没有记录而节点已被托管（例如中枢配置根被归档过）时，按冲突处理，由 ops 选择覆盖。
5. 节点 `serve-stdin` 读一行 JSON（上限 64 KiB），对照 schema、闭合键集、节点名逐项校验；取 `apply.lock`（`O_EXCL`）；核对 `expect.ownedHash` 是否等于磁盘上的受管键哈希，不等就返回 `conflict`。
6. 节点编译出补丁，写成 pending 意图 `occConfigPath('qianmo','provider','pending.json')`（0600，tmp + rename），返回 `ok: true, state.pending: true`。如果 resident 的 pid 文件核对通过，就给它发一个 SIGHUP；核对不通过就不发信号，resident 会在下一次轮询（5 s）时发现 pending。
7. resident 看到 pending：如果当前一代 ACP 子进程**没有在途 turn**，就停掉它（`supervisor.recycle()`，不计入快速失败），然后**提交 pending**（§2.6），再拉起新一代。有在途 turn 就继续等，新到的投递沿用现有「等下一代」的语义。等满 30 min 发告警，不强杀。
8. 新一代子进程的 `createSession` 读到新的 `settings.json`；按会话策略，被重置的会话开新会话，保留的会话经 `unstable_resumeSession` 续上（§2.7）。
9. resident 写 `generation.json`：代号、起始时间、这一代加载时受管键的哈希。
10. 中枢在 apply 之后每 5 s 拉一次 `status`，最多拉 2 min；之后回到常规的 10 min 后台刷新。拉到 `loadedHash == appliedHash` 就显示「已生效」。
11. 页面通过已有的 revision 推送机制拿到「状态变了」，只替换那一行（D1 保态）；toast 显示结果（D2）。
12. 对话页按这次切换的时间点，在转录里画一条分隔线「已切换到 DeepSeek · deepseek-v4-pro · 新会话」（§6.3.8）。

### 2.4 期望状态与实际状态

**期望**（中枢，`providers.ndjson` 折叠出来的结果）：每个节点的 `{profileId, revision}`。节点有单独指定的就用指定的，没有就用全局默认，两样都没有就是「不托管」。

**实际**（节点 `status` 返回）：

| 字段 | 含义 |
|---|---|
| `managed` | 节点上有没有 `occConfigPath('qianmo','provider','state.json')` |
| `applied` | `{profileId, revision, requestId, at}`：最后一次提交到 `settings.json` 的档案 |
| `onDiskHash` | 现在磁盘上受管键的规范化哈希（密钥按指纹计入） |
| `appliedHash` | 提交那一刻的受管键哈希 |
| `loadedHash` | 当前这一代 ACP 子进程加载的受管键哈希（来自 `generation.json`） |
| `pending` | `{requestId, since, waitingTurns}` 或 `null` |
| `resident` | `{running, generation, inFlight}` |
| `effective` | 节点在**单独的进程**里，把 `settings.json` 应用到自己的 `process.env`（和 `createSession` 同一序列）之后，用真实函数算出的：`apiProvider`（`getAPIProvider()`）、`wire`（`resolveOpenAIWireProtocol()` 或线路固定值）、`model`、`effortOnWire`（`modelSupportsEffort()`，chat 线另按当时代码里的门控判断）、`effortLevel`、`contextTokens` |
| `inheritedProviderKeys` | resident 自身环境里出现的 provider 类键名（不含值），由 resident 启动时写入 |
| `capabilities` | 节点代码支持的特性：`chatEffortHonorsOverride`（P18.5 之后为 true）、`replayFilter`（P18.8 之后为 true）、`protocol: 1` |

**漂移类型**（页面上每类都有中文说明和修复动作）：

| 类型 | 判定 | 页面动作 |
|---|---|---|
| `unmanaged` | `managed == false` | 「接管」：首次下发，写首次备份 |
| `out-of-sync` | 期望 `{id, rev}` ≠ `applied` | 「下发」 |
| `pending` | `pending != null` | 显示等待时长和在途 turn 数；超过 30 min 标为告警 |
| `local-edit` | `onDiskHash ≠ appliedHash` | 「查看差异（只列键名）」→「覆盖」或「接受为本地配置并停止托管」 |
| `not-loaded` | `loadedHash ≠ appliedHash` 且没有 pending | 「等待下一代」；resident 没在运行时显示「节点未运行」 |
| `env-residue` | `inheritedProviderKeys` 非空 | 提示级：「resident 进程环境里还有旧的模型变量 · 子进程已剥离 · 下次重启后消失」 |
| `unreachable` | 最近一次 `status` 失败 | 显示失败原因和时间，保留上一次成功的实际状态，并标明「过期」 |
| `retiring-model` | 正在用的模型在目录的下线表里，已经到期或 14 天内到期 | 告警，给出替换候选 |

### 2.5 第六类动作：协议

**通道**

- 中枢到每个远端节点**单独一把** ed25519 key（与隧道、镜像那把不是同一把：`authorized_keys` 里同一把公钥只有第一行的选项生效，强制命令不同就必须是不同的 key）。内测环境下私钥放在 H 上、内测根之外，0600、目录 0700，做法和现有的 `QIANMO_BETA_SSH_KEY` 一致；`node-provisioning.md` 的凭据库落地之后，迁到它的一次性 agent（`ssh-add -`）。
- 节点 `~/.ssh/authorized_keys` 加一行：`command="<部署根>/demo/env/beta/ops/model-apply.sh <节点名>",restrict <公钥>`。不开端口转发。
- 中枢调用：`ssh -i <key> -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<中枢自有 known_hosts> -o ConnectTimeout=10 <user>@<host> qianmo-model-apply-v1`。**客户端命令是一个不存在的哨兵**：强制命令那一行被别的东西改写之后，sshd 会去执行这个哨兵，结果是「命令不存在」而失败，不会静默成功。（`beta-env.md` §8.3 讲过，那一行住在我们不拥有的文件里，失效是静默的。）
- `model-apply.sh` 忽略 `SSH_ORIGINAL_COMMAND`；内测根从**脚本自己的位置**推出来，不读任何参数；节点名只认 `[a-z0-9-]{1,32}`，并核对 `<根>/nodes/<节点名>/config` 存在；然后 `exec` 本地 `qm provider serve-stdin --node <节点名>`，带 `OCC_IDENTITY=qianmo` 和该节点的 `OCC_CONFIG_DIR`。脚本里不出现密钥，也不 `set -x`。
- **中枢同机节点**（内测里 beta-4 和中枢同在 p11）：走 `local`，执行同一个脚本、同样的 stdin，只是不经过 ssh。

**请求**（stdin，一行 JSON，≤ 64 KiB）

```jsonc
{
  "v": 1,
  "op": "apply",                  // status | probe | models | apply
  "requestId": "01JB…",           // 中枢生成；节点按它去重
  "node": "beta-1",               // 必须等于脚本参数里的节点名，否则 node-mismatch
  "expect": { "ownedHash": "sha256:…" },   // apply 必带；节点从未托管时为 null
  "profile": {
    "id": "deepseek-paygo", "revision": 7,
    "lane": "anthropic",          // anthropic | openai-chat | openai-responses | gemini | grok
    "baseUrl": "https://api.deepseek.com",
    "auth": { "scheme": "bearer", "secret": "<明文，整条协议里只有这一处>" },
                                  // 或 { "scheme": "bearer", "keep": "<指纹>" }：沿用节点上已有的值，指纹不符就报 secret-mismatch
    "models": [ /* §3.2 */ ],
    "compat": { "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1" }   // 只许 §3.6 的闭合键
  },
  "probe": { "mode": "auth" },    // 只用于 op=probe：auth | latency | call
  "recycle": { "sessions": "reset" },   // keep | reset；见 §2.7
  "dryRun": false,                // true：只校验和编译，返回将要写的键名差异
  "force": false                  // true：不核对 expect.ownedHash，覆盖节点上的本地改动；只在 ops 确认「覆盖」后发送，并记进动作账本
}
```

**响应**（stdout，一行 JSON；**任何字段都不回显值**，只给键名、哈希和指纹）

```jsonc
{ "v": 1, "requestId": "01JB…", "ok": false, "code": "conflict",
  "message": "节点上的受管键在上次下发后被改过", "diffKeys": ["OPENAI_BASE_URL"], "state": { /* §2.4 */ } }
```

**错误码**（闭合集合；`message` 是给人看的中文，`code` 给程序用）：

`bad-request`（JSON 或 schema 不合法）· `version-skew`（`v` 不支持）· `unsupported-op` · `node-mismatch` · `unknown-key`（档案里出现闭合集合之外的键）· `bad-value`（值不合法，例如 URL 不是 https 且不是回环地址、模型没有占任何档位、档位无法往低夹）· `effort-unsendable`（这条线路在当前节点代码上发不了显式 effort）· `retired-model`（模型已经过了下线日期）· `secret-mismatch` · `conflict` · `busy`（`apply.lock` 被占）· `write-failed` · `probe-failed`（只用于 probe，三态见 §5.5）

**限制**：stdin 超过 64 KiB 就拒绝；单个操作有超时（`status` 20 s，`probe` 的 auth/latency 30 s、call 90 s，`apply` 30 s；apply 只写 pending，不等切换完成）；中枢对同一个节点**同时只发一个操作**；节点上 `apply.lock` 是第二道锁。

**为什么只走 stdin**：argv 会出现在 `ps` 和审计里；URL 会进各种日志；环境变量会被子进程继承。stdin 读完就丢，进程内只留在编译补丁的那一段内存里。

### 2.6 节点侧写入

**受管键的所有权**（照 CC Switch 的「关键字段所有权」）：

- 档案只拥有 `settings.json` 里的三块：`modelType`；`env` 里属于 `ALL_PROFILE_ENV_KEYS`（基座的单一名单）或闭合兼容键集（§3.6）的键；`modelSettings` 的五个槽位。
- 切换时：受管的 `env` 键先全部置为删除，再写入新档案的键（`buildActivationEnvPatch` 的语义）；`modelSettings` 五个槽位整体重写（`buildActivationModelSettingsPatch` 的语义）。兼容键只删「上一次由我们写入、而且值没被改过」的。
- 其余键归节点和运维，**一律不碰**。不认识的键当作用户键保留。
- **拒收**：`CLAUDE_CODE_USE_*`（线路一律用 `modelType` 表达）、`LD_PRELOAD`、`PATH`、`NODE_OPTIONS` 这类进程级键，以及闭合集合之外的任何键。原因是 userSettings 的 `env` 会被**全量**应用到进程上（`managedEnv.ts` 的 `getEffectiveSettingsEnv`），白名单一旦漏了，就等于能远程改 `PATH`。

**写入步骤**：

1. 取 `occConfigPath('qianmo','provider','apply.lock')`（`O_EXCL`；锁文件里记 pid 和时间，进程已经不在的陈旧锁可以回收）。
2. **首次托管**：把当时的 `settings.json` 原样复制到 `occConfigPath('qianmo','provider','first-write','settings.json')`（0600），以后永不覆盖。
3. 写 pending 意图（tmp + fsync + rename，0600）：`{requestId, profile:{id,revision}, patch, expectHash, sessions}`。补丁里含密钥，所以 pending 文件和 `settings.json` 一样是 0600。
4. **提交**（由 resident 在代际边界执行；没有 resident 在运行时由 `qm provider` 直接执行）：先把 `settings.json` `chmod 0600`（文件不存在就先建一个 `{}`，权限 0600），再用基座的 `updateSettingsForSource('userSettings', patch)` 写入。基座这条写路径（`src/utils/filesystem/file.ts` 的 `writeFileSyncAndFlush_DEPRECATED`）是 tmp + rename，rename 之后保留原文件的权限；**但临时文件是按进程 umask 创建、写完内容之后才 chmod 的**，中间有一个短窗口。所以提交时再加两条：配置根目录必须是 0700（不是就拒绝提交并告警），提交所在的同步代码段内临时把 umask 设为 `077`，写完立即恢复。提交前再核对一次 `onDiskHash == expectHash`，不等就放弃提交，状态记为 `conflict` 并告警。提交成功后删掉 pending，写 `state.json`（`applied`、`appliedHash`、本次写入的兼容键及其值的哈希）。
5. **崩溃恢复**：resident 启动时如果发现合法的 pending，先提交再拉起 ACP（向前滚）；pending 无法解析就改名为 `pending.bad-<ISO>` 并告警，不提交。

**接口约定**（P18.2 提供，P18.3 和 P18.7 调用，这里先钉死）：

```ts
// src/services/qianmo/providers/node.ts
export function stageProviderApply(req: ApplyRequest): StageResult          // 校验、写 pending
export function commitPendingProviderConfig(): CommitResult                  // 由 resident 在代际边界调用
export function readProviderState(): ProviderNodeState                       // §2.4 除 effective 以外的字段
export function computeEffectiveProviderState(): EffectiveState              // 在独立进程里调用
```

### 2.7 热切换：在空闲时回收 ACP 子进程

取 `atlas-provider-matrix.md` §4.5「最小正确改法」的第 1–3 行，另加探测口径一行。那张表的第 4 行（`qm provider apply`）落在 §2.5、§2.6，第 5 行（迁移）落在 §2.9。

| 改哪里 | 改什么 |
|---|---|
| `packages/resident/src/supervisor.ts`（`ResidentSupervisor`，`:45`） | 加 `recycle()`：只停当前这一代，不中止整个循环；这一次停止**不计入**快速失败；当前一代存活时间超过 `stableAfter` 时，退避重置为 2 s |
| `src/services/qianmo/resident.ts` | 加 `recycleAcpWhenIdle({sessions})`：等到没有在途任务、没有进行中的 turn，调 `commitPendingProviderConfig()`，再 `recycle()`。等待期间新到的投递沿用「等下一代」；满 30 min 发 notify 告警，不强杀。`sessions: 'reset'` 时，清掉会话存储里的会话映射，下一次投递开新会话（值守作业也一样） |
| `src/cli/handlers/resident.ts` | 在 `SIGTERM` / `SIGINT`（`:1949-1950`）旁边加 `SIGHUP` → 立即检查 pending；另加每 5 s 一次的 pending stat 轮询（用 stat，不用 `fs.watchFile`：Linux 上它首个 stat 之前的改动会被当成基线）。写 `occConfigPath('resident','resident.pid')`，内容 `{pid, startedAt, nonce}`；`qm provider` 发信号前核对进程的启动时间，核对不通过就不发信号，只靠轮询。启动时写 `inheritedProviderKeys`（只有键名） |
| `src/cli/handlers/residentModelProbe.ts` | 回收之后重跑一次模型探测，改为读 `getEffectiveSettingsEnv()`，不再只看本进程的 env（不改的话，配置迁到 settings 之后，启动告警会误报「没有凭据」） |

**会话策略**：

- `baseUrl` 的主机和 `lane` 都没变（只换模型或 effort）：`keep`。
- 其他情况默认 `reset`，直到节点 `capabilities.replayFilter == true`（P18.8 已合入并部署）。之后由 ops 在切换对话框里选，默认仍然是 `reset`。
- 会话续上之后钉住的是哪个模型：matrix §4.5 写的是「新钉住的是新 provider 的默认模型，除非用户在会话里显式选过」，这一点要在 P18.3 用真 ACP 子进程验证（§11 第 4 条）。

### 2.8 中枢同机节点

与 `authorization-m1.md` P14.9 的约束一致：中枢机上的节点不能读到中枢的密文库和主密钥。做法：同机节点的配置根和中枢配置根分开（内测里已经分开：`<根>/nodes/console/config` 和 `<根>/nodes/<节点>/config`）；resident 的 hardline 保护根里加入中枢的 `qianmo/console` 目录和主密钥所在目录，用 P14.9 的同一张表。走 `local` 时，执行器只把 JSON 写进子进程的 stdin，不经过任何文件。

### 2.9 现有节点的迁移（P18.13）

1. 中枢开启 `--accounts`（模型服务的写操作要个人账号的 ops 角色），用户告知照 `beta-env.md` §3.6。
2. 为每个远端节点生成专用 key，在节点上装好那一行 `authorized_keys`，中枢的 known_hosts 登记主机指纹。
3. 在控制台上按节点当前的实际配置建档案（例如 `gpt-6-luna`、`openai-responses`、effort `always` / `max`），**首次下发**。节点写首次备份，`settings.json` 成为唯一来源。
4. P18.7 合入后，ACP 子进程的 spawn env 会剥掉 provider 类键，所以 `model-env` 里残留的键**不需要重启也不会再生效**。下一个维护窗口再把这些键从 `model-env` 删掉，重启一次 resident，`env-residue` 提示随之消失。
5. 部署节奏按当时的发版规矩办：只部署已经批准的发行标签，不部署 main（§13 第 4 点）。

---

## §3 数据模型

### 3.1 档案（Profile）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | `[a-z0-9-]{1,48}` | 创建时生成，不可改 |
| `name` | 字符串 ≤ 40 | 显示名，例如「DeepSeek 按量」 |
| `presetId` | 字符串或 `null` | 来自哪个预设；自定义为 `null` |
| `plan` | `paygo` / `plan` / `local` / `custom` | 按量 / 套餐 / 本地 / 自定义。套餐会触发条款提示（§4.3） |
| `site` | 字符串或 `null` | 站点，例如 `cn` / `intl`。国内站和国际站的 key 一般不互通，所以站点和 key 成组保存 |
| `lane` | `anthropic` / `openai-chat` / `openai-responses` / `gemini` / `grok` | **线路是显式字段**。编译成 `modelType` 加 `OPENAI_WIRE_API`（§3.3）；不靠模型名去猜 |
| `baseUrl` | URL | 必须是 https，或者是回环地址或私网地址上的 http（本地服务）。**地址在节点上解析**：`localhost` 指的是节点自己 |
| `templateValues` | 键值表 | URL 里的变量，例如百炼的 `{WorkspaceId}`、`{region}`。表单上渲染成必填框 |
| `auth` | `{scheme, envKey}` | `scheme` 取 `bearer` 或 `x-api-key`，决定写进 `ANTHROPIC_AUTH_TOKEN` 还是 `ANTHROPIC_API_KEY`（OpenAI 一侧一律 `OPENAI_API_KEY`）。**Anthropic 线的第三方主机必须有 key**：没有 key 时运行时可能把节点本地的官方登录凭据发给第三方，所以编译器直接拒绝 |
| `secret` | 只存在中枢密文库里 | 档案本体只记 `secretFingerprint` 和 `secretSetAt` |
| `models` | 数组，见 §3.2 | 至少一个，`role` 为 `main` 的恰好一个 |
| `compat` | 闭合键集的子集（§3.6） | |
| `probe` | `{auth, models}` | 预设自带的验 key 与拉模型请求说明（§5.5）；自定义档案用通用规则 |
| `terms` | `{restricted: bool, note, url}` | 套餐条款提示，来自预设 |
| `evaluated` | `false` 或 `{at, by, evidence}` | 只有在 §8 的真 key 冒烟通过之后才能改成非 false；界面上显示「未评估」 |
| `effortLock` | 档位或 `null` | 设了值就编译成 `CLAUDE_CODE_EFFORT_LEVEL`，锁定全档案的 effort 档位（§3.4） |
| `revision` | 整数 | 每次保存加一，用于冲突检测 |

### 3.2 模型条目（Model）

| 字段 | 说明 |
|---|---|
| `id` | 发到线上的模型名（方舟允许填 `ep-…`）。**第三方模型名一律不加 `[1m]`**（那是 Claude Code 客户端的标记，Kimi Code 收到 `k3[1m]` 会 401） |
| `role` | `main`，或者 `fast` / `extra` |
| `tiers` | 这个模型占哪些档位：`opus` / `sonnet` / `haiku` / `fable` 的子集。主模型至少占一个档位，否则显式能力没有地方挂（§3.4） |
| `capabilities` | `mode: 'family'`：不写能力覆盖，按基座的模型族默认判断；`mode: 'explicit'`：六个布尔位 `effort`、`xhigh_effort`、`max_effort`、`thinking`、`adaptive_thinking`、`interleaved_thinking` 全部显式给出。**这份列表是全有或全无的**：基座的读法是「列表存在但不含某一项就等于 false」（`modelSupportOverrides.ts` `get3PModelCapabilityOverride`），所以只要有一项要显式，六项就都要显式。页面切到「显式」时，用节点算出的当前值预填 |
| `effort` | `{send, level, levels}`：`send` 取 `always`、`never`、`auto` 三者之一，见 §3.4 |
| `contextTokens` | 可选。编译成 `modelSettings.<slot>.contextTokens`。不新开第三个上下文覆盖（`CLAUDE.full.md` 的规则） |
| `maxOutputTokens` | 可选。供 P18.5 的 hermes #3 使用：有值才发 `max_tokens`，没值就不发（§5.6） |
| `retireAt` | 可选，ISO 时间。来自目录的下线表；到期以后编译器拒绝（`retired-model`） |

### 3.3 编译：档案 → 节点 `settings.json`

| 档案字段 | anthropic | openai-chat | openai-responses | gemini | grok |
|---|---|---|---|---|---|
| `lane` | `modelType: 'anthropic'` | `modelType: 'openai'` + `OPENAI_WIRE_API=chat` | `modelType: 'openai'` + `OPENAI_WIRE_API=responses` | `modelType: 'gemini'` | `modelType: 'grok'` |
| `baseUrl` | `ANTHROPIC_BASE_URL` | `OPENAI_BASE_URL` | `OPENAI_BASE_URL` | `GEMINI_BASE_URL` | `GROK_BASE_URL` |
| `secret` | `ANTHROPIC_AUTH_TOKEN`（bearer）或 `ANTHROPIC_API_KEY`（x-api-key），另一个置为删除 | `OPENAI_API_KEY` | `OPENAI_API_KEY` | `GEMINI_API_KEY` | `GROK_API_KEY` |
| 主模型 | `ANTHROPIC_MODEL` | `OPENAI_MODEL` | `OPENAI_MODEL` | `GEMINI_MODEL` | `GROK_MODEL` |
| 档位 | `ANTHROPIC_DEFAULT_<T>_MODEL` 及 `_NAME` / `_DESCRIPTION` / `_SUPPORTED_CAPABILITIES` | `OPENAI_DEFAULT_<T>_…` | 同左 | `GEMINI_DEFAULT_<T>_…` | `GROK_DEFAULT_<T>_…` |
| `contextTokens` / `effort.level` | `modelSettings.<slot>` | 同左 | 同左 | 同左 | 同左 |

**DeepSeek 是特例**：预设写的是 `modelType: 'openai'` 加 `OPENAI_BASE_URL=https://api.deepseek.com`，由运行时已有的镜像自动改走官方 Anthropic 端点（`deepseekWire.ts`，`CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE` 默认开）。这样 DeepSeek 专有的调优（128 个函数上限、编码温度、effort 阶梯）照常生效，界面上显示的线路是节点算出来的 `anthropic`。

所有键名都来自基座的 `PROFILE_ENV_KEYS`，再加上 §3.6 的闭合键集。**测试断言**：编译器能写出的键集合 ⊆ `ALL_PROFILE_ENV_KEYS ∪ COMPAT_KEYS`；目录里每个预设编译出来的补丁都能通过节点的白名单。

### 3.4 effort 的编译规则

| `send` | anthropic、openai-responses | openai-chat | gemini、grok |
|---|---|---|---|
| `always` | 模型的能力切到 `explicit`，`effort: true`；`xhigh_effort` / `max_effort` 按 `levels` 是否包含对应档位来定。模型钉进它占的档位，覆盖才能命中（基座只在「模型名等于某个档位钉住的值」时读这一档的能力） | **P18.5 合入、节点自报 `chatEffortHonorsOverride` 之前拒收**，返回 `effort-unsendable`。之后规则同左 | v1 只允许 `auto`。P18.5 让能力覆盖也读 `GEMINI_` / `GROK_` 前缀之后再放开 |
| `never` | 能力 `explicit`，`effort: false` | 同左（不发本来就是今天的行为） | 同上 |
| `auto` | 能力 `family`，不写覆盖；节点算出来是什么就显示什么 | 同左 | 同左 |

- **档位**：`level` 写进模型所占每个档位的 `modelSettings.<slot>.effort`，主模型另外写 `default` 槽。档案级的 `effortLock` 设了值时，另写 `CLAUDE_CODE_EFFORT_LEVEL`（它的优先级高于 `modelSettings`，对档案里所有模型生效，所以它的值也要先对每个模型的 `levels` 往低夹，夹不了就拒绝）。舰队现在的 `CLAUDE_CODE_EFFORT_LEVEL=max` 迁移过来就是 `effortLock: max`。`CLAUDE_CODE_EFFORT_LEVEL` 只有一个值，所以「往低夹」取的是所有受约束模型 `levels` 的交集里、不高于请求的最高一档（例如 `max` 遇到 `[low, high, max]` 和 `[low, medium, high]` 两个模型，写 `high`）。
- **哪个槽对主循环生效（P18.2 实算，§11 第 3 条）**：用节点 `status` 里 `effective` 的计算函数 `computeEffectiveProviderState` 实算。它在独立进程里运行，进程环境里的 provider 键先剥掉，五个槽各给一个不同的档位，看算回来的是哪一档（`src/services/qianmo/providers/__tests__/effective.test.ts`）。结论如下：
  - 新会话的主循环读 **`default`** 槽。anthropic 和 openai-responses 两条线都一样；主模型同时占着 opus / sonnet / fable，也不改变这一点。
  - 会话切到快速模型后，读它所占的档位（haiku）；按 id 切回主模型，又回到 `default`。
  - 所以主模型的 `default` 槽和它的档位槽必须写同一个值，编译器就是这样写的。
  - `CLAUDE_CODE_EFFORT_LEVEL` 压过所有槽。
  - 非 anthropic 线路上，节点 `settings.json` 里残留的 `model` 字段算一次选择，会盖过档案的主模型：值是别名就换到别名对应的槽，值是具体 id 就连模型一起换掉。anthropic 线不受影响，因为 `ANTHROPIC_MODEL` 会盖住它。编译器和基座 `/provider` 都不管这个字段。
- **只往低夹**：请求的档位不在 `levels` 里，就取不高于它的最高一档；没有更低的就拒绝（`bad-value`），**不往高夹**。界面上只提供 `levels` 里的档位，所以基座里那些往上映射的规则（例如 DeepSeek、Grok 的 `medium → high`）不会被触发。基座本身不会按 `max_effort` / `xhigh_effort` 往下夹（`effort.ts:131-132` 注释：「API errors are the user's responsibility」），所以夹取必须在编译时做。`always` 没写 `level` 时按 `high` 编译（不发 effort 时 API 自己用的就是 `high`），再往低夹，夹不到同样拒绝。什么都不写不行：运行时会退回族默认值，第三方 opus / sonnet 槽的族默认值是 `xhigh`，而且不按 `levels` 夹。实算中阶跃预设的 `levels` 是 `[low, medium, high]`，不写档位时线上会收到 `xhigh`。
- **`CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`**：只有档案里**每个**模型都是 `send: always` 时才写，作为简写，和舰队现在的配置一致。它是全局开关，会影响 haiku 档和子 agent，所以不是首选。
- **显示 = 线上**：页面上「发 effort」这一列只取节点的 `effective.effortOnWire`，中枢自己不判断。

### 3.5 字段所有权

见 §2.6。补充一点：基座 `/provider` 命令在节点上也能写这些键。节点上有人手动跑了 `/provider` 激活，就会表现为 `local-edit` 漂移，不会被静默覆盖。

### 3.6 闭合兼容键集

`ALL_PROFILE_ENV_KEYS` 之外，编译器和节点白名单只认这几个：

| 键 | 用途 | 约束 |
|---|---|---|
| `CLAUDE_CODE_EFFORT_LEVEL` | effort 锁定（§3.4） | 值属于 `low/medium/high/xhigh/max` |
| `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT` | 简写（§3.4） | 只能是 `1` |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | 非 Anthropic 主机上不发 Claude 专有的 beta 字段（`vendors-research.md` §6.5 第 2 条） | 只能是 `1`。Anthropic 线的第三方预设默认带上 |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Anthropic 线的输出上限 | 正整数 |
| `API_TIMEOUT_MS` | 慢端点（本地模型） | 30000–1800000 |
| `ANTHROPIC_CUSTOM_HEADERS` | 只用于 Anthropic 多 workspace 的 key 要求带的 `anthropic-workspace-id` | 头名只许 `anthropic-workspace-id` |
| `CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE` | 让 DeepSeek 退回 Chat 线 | 只能是 `0` |

**不收**：`CLAUDE_CODE_USE_*`；`CLAUDE_CODE_SUBAGENT_MODEL`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`（这两个是节点策略，不是 provider 的属性）；`CLAUDE_CODE_AUTO_COMPACT_WINDOW`（不开第三个上下文覆盖）；`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`（作为第二步加固另议，见 §10）。

### 3.7 存储位置

运行时路径一律由 `src/config/paths.ts` 的 `occConfigPath(...)`（`:157`）派生，和 `consoleArgs.ts:190-235` 的现有约定一致。唯一的例外是用显式参数指定的文件：主密钥的 `--provider-key-file`，和控制台两枚 token 的 `--view-token-file` / `--admin-token-file` 是同一种做法；不给参数时仍然用 `occConfigPath` 派生的默认位置。

| 位置 | 内容 | 权限 | 写法 |
|---|---|---|---|
| 中枢 `occConfigPath('qianmo','console','providers.ndjson')` | 档案与事件：`profile.saved` / `profile.deleted` / `scope.assigned` / `secret.set` / `secret.cleared`（只记指纹）/ `apply.result` | 0600 | 只追加的哈希链，用 `ledger.ts` 的格式严格读：有一行坏了，模型服务页就拒绝服务并告警，节点继续用最后一次下发的配置 |
| 中枢 `occConfigPath('qianmo','console','provider-secrets.json')` | `{v:1, entries:{<profileId>:{fp, wrappedKey, iv, tag, ct, at}}}` | 0600，目录 0700 | 整体重写（tmp + fsync + rename）；轮换和删除时旧条目**真的消失** |
| 中枢主密钥 | 32 字节随机数 | 0600，目录 0700 | 内测环境用 `--provider-key-file` 指向 H 的 `secrets/` 目录（和控制台两枚 token 同一个目录，在配置根之外）。不给这个参数时默认 `occConfigPath('qianmo','console-keys','provider-master.key')`。权限过宽时拒绝启动模型服务这一面 |
| 节点 `settings.json`（`<OCC_CONFIG_DIR>/settings.json`） | 受管键 | 0600 | §2.6 |
| 节点 `occConfigPath('qianmo','provider', …)` | `apply.lock`、`pending.json`、`state.json`、`generation.json`、`first-write/settings.json` | 0600，目录 0700 | §2.6 |
| 节点 `occConfigPath('resident','resident.pid')` | `{pid, startedAt, nonce}` | 0600 | §2.7 |

### 3.8 加密

- **信封加密**，照 `node-provisioning.md` §3.3 (b)：每把 key 用一把随机数据密钥做 AES-256-GCM 加密，数据密钥再用主密钥包起来；附加数据（AAD）为 `profileId` 加档案的修订号，防止把密文挪到另一份档案上用。只用 `node:crypto`，零新依赖。
- **它防的是误拷贝，不防 H 失陷**（原文第三段的口径不变）：主密钥和密文在同一台机器上。
- **复制路径的显式排除**（那一节的硬规矩照搬，四条都要写成配置里的显式排除）：① 审计镜像拉取：结构上够不到（强制命令只放行单个文件）；② 配置根 tar 快照：排除 `qianmo/console/provider-secrets.json`；内测部署的主密钥不在配置根里，用默认位置的部署还要排除 `qianmo/console-keys/`；③ 备份 store：同 ②；④ `beta-reset.sh` 的 purge 类参数够不到 `secrets/`。`--archive-config` 改名归档会把密文一起带走，但它留在 H 上、属于同一个信任域，而主密钥不在里面。这一条是**有意的偏离**，脚本归档时打印一行说明。
- **主密钥丢了**：密文库不为空、主密钥却不存在时，模型服务这一面 fail-closed（页面显示「主密钥缺失」，所有下发被拒），**绝不静默重新生成**，因为那会让所有密文变成孤儿。节点继续用最后一次下发的配置。
- **OpenBao**：§1.3 O-5，已重评，不复用。

### 3.9 导入与导出

- **导出**：选中的档案导出为 JSON：`{v:1, kind:'qianmo-providers', profiles:[…]}`。**不含密钥，也不含指纹**；文件头有一行 `"secrets": "not-included"`。
- **导入**：先 dry-run，页面整份展示要导入的内容；出现闭合集合之外的键就整份拒绝并列出键名；`id` 已存在时只给「另存为新档案」，不覆盖。导入的档案一律没有密钥，`evaluated` 一律重置为 false。
- **分享**：只分享不含 key 的模板，key 由接收方自己填。不做深链（CC Switch 把 key 放进 URL 查询串，本文不照搬）。

---

## §4 预设目录

### 4.1 选线规则

1. 厂商**官方**提供 Anthropic 兼容端点、并且有 Claude Code 接入文档的，优先走 Anthropic 线。运行时本来就说 Anthropic Messages，这条线不经过协议转换，thinking、tool_use、缓存标记都原样往返（`vendors-research.md` §6.1）。
2. 必须走 OpenAI 线的四家：OpenAI 和 xAI 走 **Responses**（OpenAI 的 GPT-6.1 Sol、GPT-6 Astra 在 Chat 上不能带工具，`gpt-5.3-codex` 只支持 Responses；xAI 的 Chat 已标为 legacy，Anthropic 兼容已废弃）；Gemini 走运行时已有的**原生**线；Mistral 只有 **Chat**。
3. Anthropic 线一律用 Bearer（`ANTHROPIC_AUTH_TOKEN`），并把 `ANTHROPIC_API_KEY` 置为删除。只有 Anthropic 官方用 `x-api-key`。
4. key 前缀只做**软提示**，不做硬拒绝。最有用的场景是发现计划和端点填错了，例如在按量 URL 上填了套餐 key（`vendors-research.md` §6.3）。
5. 每条预设记官网出处和核实日期。本版全部核实于 **2026-10-03**，依据是调研件对官网原文的抓取，**没有用真 key**。所有预设在通过 §8 的真 key 冒烟之前一律标「未评估」。
6. **不收**推广参数，不收 logo，不按赞助排序。展示顺序：先国内按量，再国际，再套餐，再本地；每组内按字母序。

### 4.2 按量预设

| 预设 id | 厂商 | 线路 | Base URL | 主模型 / 快速模型 | effort 默认 | 官网出处 |
|---|---|---|---|---|---|---|
| `deepseek` | DeepSeek | anthropic（经运行时镜像，见 §3.3） | `https://api.deepseek.com` | `deepseek-v4-pro` / `deepseek-flash` | always · `levels: low, high, max` · `level: max` | https://api-docs.deepseek.com/guides/anthropic_api/ |
| `kimi` | 月之暗面 开放平台 | anthropic | `https://api.moonshot.cn/anthropic`（国际站 `.ai`） | `kimi-k3` / `kimi-k2.6` | always · `low, high, max` | https://platform.kimi.com/docs/api/messages |
| `zhipu` | 智谱 | anthropic | `https://open.bigmodel.cn/api/anthropic`（z.ai：`https://api.z.ai/api/anthropic`） | `glm-5.3` / `glm-5.3-flash` | auto | https://docs.bigmodel.cn/cn/guide/capabilities/thinking |
| `qwen` | 阿里云百炼 | anthropic | `https://{WorkspaceId}.{region}.maas.aliyuncs.com/apps/anthropic` | `qwen3.8-max` / `qwen3.8-flash` | auto | https://help.aliyun.com/zh/model-studio/base-url |
| `minimax` | MiniMax | anthropic | `https://api.minimax.cn/anthropic`（国际站 `api.minimax.io`） | `MiniMax-M3` / `MiniMax-M2.7-highspeed` | never（effort 只对 M3.1 生效） | https://platform.minimax.cn/docs/api-reference/text-anthropic-api |
| `ark` | 火山方舟 | anthropic | `https://ark.cn-beijing.volces.com/api/compatible` | `doubao-seed-2-1-pro-260915` / `doubao-seed-2-1-lite-260915` | auto | https://www.volcengine.com/docs/82379/1449737 |
| `siliconflow` | 硅基流动 | anthropic | `https://api.siliconflow.cn`（根地址） | `deepseek-ai/DeepSeek-V4-Pro` / `deepseek-ai/DeepSeek-V4-Flash` | auto | https://docs.siliconflow.cn/docs/api/chat-completions-post |
| `qianfan` | 百度千帆 | anthropic | `https://qianfan.baidubce.com/anthropic` | `ernie-5.1` / `ernie-4.5-turbo-128k` | auto | https://cloud.baidu.com/doc/qianfan-api/s/3m7of64lb |
| `tokenhub` | 腾讯 TokenHub | anthropic | `https://tokenhub.tencentmaas.com`（Anthropic 的 base 不带 `/v1`） | `hy4-preview` / `hy3` | auto | https://cloud.tencent.com/document/product/1823/130079 |
| `stepfun` | 阶跃星辰 | anthropic | `https://api.stepfun.com`（国际站 `.ai`） | `step-5-preview` / `step-3.7-flash` | always · `low, medium, high`（Anthropic 端只认 `output_config.effort`，没有 thinking 字段） | https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create |
| `mimo` | 小米 MiMo | anthropic | `https://api.xiaomimimo.com/anthropic` | `mimo-v2.6-pro` / `mimo-v2.6-flash` | never（effort 只分开和关） | https://mimo.mi.com/static/docs/api/chat/anthropic-api.md |
| `openai` | OpenAI | openai-responses | `https://api.openai.com/v1` | `gpt-6.1-sol`、`gpt-6-luna`、`gpt-6-astra` / `gpt-5.3-codex` | always · 各模型的 `levels` 以官网页面为准，录入时逐个核对 | https://developers.openai.com/api/docs/guides/reasoning |
| `anthropic` | Anthropic | anthropic（官方，`x-api-key`） | `https://api.anthropic.com` | `claude-opus-5-5`、`claude-sonnet-5-5` / `claude-haiku-4-5` | auto（官方模型在基座能力表里） | https://platform.claude.com/docs/en/build-with-claude/effort |
| `xai` | xAI | openai-responses（经 OpenAI 线，不走运行时的 Grok 线，因为后者调的是 Chat） | `https://api.x.ai/v1` | `grok-4.7` / `grok-4.3` | never，直到 hermes #13 的真实端点核实完成（§5.10） | https://docs.x.ai/developers/model-capabilities/text/reasoning |
| `gemini` | Google Gemini | gemini（原生） | `https://generativelanguage.googleapis.com/v1beta` | `gemini-3.8-flash` / `gemini-3.1-pro-preview` | auto。可用地区不含中国大陆和港澳，节点在这些地区会被拒，表单上提示 | https://ai.google.dev/gemini-api/docs/api-key |
| `mistral` | Mistral | openai-chat | `https://api.mistral.ai/v1` | `mistral-medium-3-5` / `mistral-small-2603` | never。推理关闭：开推理后 `content` 是数组，运行时还没有处理 | https://docs.mistral.ai/studio/conversations/reasoning |
| `openrouter` | OpenRouter | anthropic（只用于 Claude 模型） | `https://openrouter.ai/api` | `~anthropic/claude-sonnet-latest` 等 | auto | https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration |
| `azure` | Azure OpenAI（模板） | openai-responses | `https://{resource}.openai.azure.com/openai/v1/` | 部署名（用户填写） | always（同 OpenAI） | https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle |

补充说明：

- 表里的 effort 默认是**预设的初值**，ops 可以按模型改。依据是调研件对各家官方推理参数页的摘录（`vendors-research.md` §1 的「推理参数」一列）。凡是写 `always` 的，都还要在 P18.13 的录制桩对等测试和真 key 冒烟中复核。
- Azure 的鉴权写法（`api-key` 头还是 SDK 发 Bearer）调研件没有定论，标为**未验证**；P18.13 之前不显示在预设列表里，只能从「自定义」进入。
- Anthropic 官方预设：多 workspace 的 key 每次请求都要带 `anthropic-workspace-id`，表单上留一个可选字段，编译成 `ANTHROPIC_CUSTOM_HEADERS`（§3.6）。

### 4.3 套餐预设与条款提示

D-3：套餐 key 支持，界面标出条款限制，由使用者自行判断。所有套餐预设 `plan: 'plan'`、`terms.restricted: true`。

| 预设 id | 套餐 | 线路与 Base URL | key 前缀提示 | 官网出处 |
|---|---|---|---|---|
| `zhipu-coding` | 智谱 GLM Coding Plan | anthropic · `https://open.bigmodel.cn/api/anthropic`（与按量同址，靠 key 区分） | `{id}.{secret}` | https://docs.bigmodel.cn/cn/coding-plan/quick-start |
| `qwen-coding` | 百炼 Coding Plan | anthropic · `https://coding.dashscope.aliyuncs.com/apps/anthropic`（国际 `coding-intl`） | `sk-sp-` | https://help.aliyun.com/zh/model-studio/coding-plan |
| `qwen-token` | 百炼 Token Plan | anthropic · `https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic` | `sk-sp-` | https://help.aliyun.com/zh/model-studio/token-plan-quickstart |
| `kimi-code` | Kimi Code | anthropic · `https://api.kimi.com/coding/`（带结尾斜杠；海外 `api.kimi.ai`） | `sk-kimi-` | https://www.kimi.com/code/docs/ |
| `minimax-plan` | MiniMax M Plan | anthropic · 同按量地址（`MiniMax-M3.1-Flash-Preview` 只开放给订阅） | `sk-cp-` | https://platform.minimax.cn/docs/api-reference/text-anthropic-api |
| `ark-coding` | 方舟 Coding Plan | anthropic · `https://ark.cn-beijing.volces.com/api/coding` · 模型 `ark-code-latest` | 未核实 | https://www.volcengine.com/docs/82379/1928262 |
| `qianfan-token` | 千帆 Token Plan | anthropic · `https://qianfan.baidubce.com/anthropic/tokenplan/personal` 或 `…/tokenplan/team` | 未核实 | https://cloud.baidu.com/doc/qianfan/s/Dmrabu8b6 |
| `tencent-plan` | 腾讯 Token Plan / Coding Plan | anthropic · `https://api.lkeap.cloud.tencent.com/plan/anthropic` 或 `/coding/anthropic` | `sk-tp-` / `sk-sp-` | https://cloud.tencent.com/document/product/1823/130060 |
| `stepfun-plan` | 阶跃 Step Plan | anthropic · `https://api.stepfun.com/step_plan` | 未核实 | https://platform.stepfun.com/docs/zh/api-reference/chat/messages-create |
| `mimo-token` | MiMo Token Plan | anthropic · 域名 `token-plan-cn` / `token-plan-sgp` / `token-plan-ams`（均为 `.xiaomimimo.com`），**Anthropic 路径调研件没有核实**，以官方页面为准，录入时核对 | `tp-`（个人）/ `ttp-`（团队） | https://mimo.mi.com/static/docs/api/chat/anthropic-api.md |

不收：千帆 Coding Plan（已停售）。

**条款提示**（卡片角标和表单顶部各一处，文案见 §6.6）：以上各家的条款大多把用途限定为「交互式编程工具」，或者明文禁止用于应用后端、自动化脚本（`vendors-research.md` §6.7 逐家列了原文出处）。远端常驻 agent 代为调用算不算违规，是合规判断，不是技术判断。界面只陈述事实和出处链接，**不替用户下结论，也不拦截**。

### 4.4 本地与模板

| 预设 id | 线路 | Base URL（**按节点解析**） | 说明 |
|---|---|---|---|
| `ollama` | anthropic（Ollama ≥ 0.14.0）；旧版本选 openai-chat | `http://localhost:11434` | key 填占位 `ollama`；模型 `model:tag` |
| `vllm` | anthropic（vLLM ≥ 0.11.1）；旧版本选 openai-chat | `http://localhost:8000` | 只认 Bearer；模型是 `--served-model-name` |
| `lmstudio` | anthropic（LM Studio ≥ 0.4.1）；旧版本选 openai-chat | `http://localhost:1234` | |
| `custom-anthropic` / `custom-openai` | 用户选 | 用户填 | 没有预设能力：effort 默认 `auto`，能力默认 `family`，页面显示节点算出的结果（§5.3） |

本地服务探测成功不代表模型已经加载（`vendors-research.md` §6.4 最后一行），测连结果的说明文字要写清楚。

### 4.5 不收录

订阅 OAuth 与反代（ChatGPT、Claude、Copilot、xAI 订阅登录）· Bedrock / Vertex / Foundry（云厂商凭据体系不同，内测用不到）· Gemini 的 OpenAI 兼容层（原生线更完整，而且兼容层有 `thought_signature` 回放的坑）· Anthropic 的 OpenAI 兼容垫片（订阅扣「额外用量」池，会 400，官方也说不适合生产）· 老混元平台（已冻结）· 中转站与聚合转售（OpenRouter 之外）。

### 4.6 MiMo 下线处理

- **事实**：`mimo-v2.5-pro`、`mimo-v2.5` 于 **2026-10-21 10:00（北京时间）**下线，没有自动替换；`mimo-v2-flash` 已于 06-30 下线。现行模型是 `mimo-v2.6-pro`、`mimo-v2.6-flash`。
- **目录**：预设只写 v2.6；下线表记上面三个 id 和日期。节点正在用的模型进入 14 天窗口就报 `retiring-model`，过期之后编译器拒绝下发。
- **基座预设**：`src/utils/model/chinaLlmProviders.ts:239-308` 的 MiMo 段（默认 `mimo-v2.5-pro`，haiku 档 `mimo-v2-flash`，模型表三个 id 全是下线 id）会让基座 `/provider` 向导的用户在 10-21 之后直接失败。**P18.1 在截止日之前改这一段**，只改数据（id 换成 v2.6），不改结构。
- **不动**：`src/components/opencodeLogin/opencodeCatalog.ts` 里的 `mimo-*` 是 OpenCode 自己转售的模型 id，下不下线由 OpenCode 决定，本次没有核实；`src/services/api/openai/__tests__/thinking.test.ts` 里的 `mimo-v2-*` 只是在测「名字里含 mimo 时开思考」，与线上 id 无关。

### 4.7 对调研件的更正与补充

- `vendors-research.md` §6.6 第 3 条说「Gemini 原生路径没有处理 thought signature」，**不对**。原生线在 `packages/@ant/model-provider/src/providers/gemini/convertMessages.ts:206-244` 回放 `thoughtSignature`，在 `streamAdapter.ts:105` 捕获。这一条的检索只查了 `thought_signature` 和 `src/` 一侧，漏了 `providers/gemini/`。该条后半句「`thinkingBudget` 在 Gemini 3 上是 legacy 参数」仍然成立，和 hermes §11.10 第 7 条一起作为待核实项（§5.10）。
- `vendors-research.md` §6.6 第 1 条（GPT-6 系不会自动走 Responses）在 `33dc81bf` 上仍然成立：`isCodexFamilyModel` 只匹配 `codex` 和 `gpt-5(.x)`，全 `src` 搜不到 `gpt-6`。本设计不靠模型名去猜：OpenAI 预设显式写 `lane: openai-responses`；另外 P18.5 用 hermes #22 加一张主机表，`api.openai.com` 默认走 Responses，放在显式的 `OPENAI_WIRE_API` 之后。

---

## §5 调用层兼容

### 5.1 原则

1. **三层正交**（hermes B1）：线路（wire）× 档案（目录里的数据）× 怪癖（按主机或模型查的规则表）。新增一家时，绝大多数情况只加一行数据，不动主循环。
2. **能力判断是一架有序梯子**（hermes B6）：显式覆盖总是生效，默认值只补空缺。对应到阡陌：档案里的显式能力字段 → 基座能力表 → 模型族默认。
3. **只往低夹**（hermes B4）：effort 档位在编译时夹（§3.4），运行时不再悄悄升档。
4. **阡陌的长处保留**：「恰好一次」的重放屏障（#29，`streamAssembly.ts` 的 commitment）、DeepSeek 的 128 个函数上限和编码温度（#30）、正文中夹着空 `reasoning_content` 时直接忽略（#31）、错误诊断脱敏（#32）。所有新加的重试和降级都走同一道屏障；新的错误文案匹配都在**脱敏之前**、对结构化字段做。
5. **落法**（hermes §11.7 的前提）：要改的阡陌调用层文件**全部属于基座层**。所以新规则表一律放进新建的阡陌自有文件（带 AGPL 双行头），基座文件只改调用点，目标形态是「一次纯插入」或「一次调用替换」（章程 §7.2 第 7 条（v2.12 强化））。

新文件的位置：

| 新文件目录 | 谁调用 | 为什么放这里 |
|---|---|---|
| `src/services/qianmo/modelCompat/` | `src/services/api/**` 下的调用点 | 阡陌自有目录 |
| `packages/@ant/model-provider/src/shared/qianmo/` | 同一个包里的 `openaiStreamAdapter.ts`、`openaiConvertMessages.ts`、`openaiConvertTools.ts` | 这个包不能 import `src`。基座目录里放阡陌自有文件是有先例的：`packages/@ant/model-provider/src/shared/__tests__/emptyModelResponse.test.ts` 已经带 AGPL 头 |
| `@qianmo/providers` | 运行时按（主机，模型）查目录里的 `maxOutputTokens` 等 | 目录只有一处（R-1） |

### 5.2 effort：显式字段、只往低夹、显示等于线上

- **字段**：§3.2、§3.4。
- **门控统一**：P18.5 把 chat 线的门控从 `isChatGPTCodexReasoningModel(openaiModel)`（`openai/index.ts:499`）改成和显示、Responses 线、Anthropic 线（`claude.ts:471`）同一个 `modelSupportsEffort()`；值仍由 `getChatReasoningEffort` 换算，后续由 P18.8 的厂商表（hermes #14）按目标端点选键。改完之后，节点在 `capabilities` 里报 `chatEffortHonorsOverride: true`，编译器才放开 chat 线的 `always`。
- **能力覆盖的读法补两处**（P18.5，基座 `modelSupportOverrides.ts`）：① 档位表加上 `FABLE`（今天只有 OPUS / SONNET / HAIKU 三档，而 `PROFILE_ENV_KEYS` 里写了 FABLE 档的 `_SUPPORTED_CAPABILITIES`，结果是写了没人读）；② `gemini` / `grok` 两条线读自己前缀的档位（今天这两条线落到 `ANTHROPIC_TIERS`）。两处都是在常量表里插入条目。
- **词表映射**照搬 hermes §11.2.7 的各行，按目标端点选发哪个键（#14），**不再三种思考方言一起发**（今天 `requestBody.ts` 对 deepseek / mimo 名字的模型同时发 `thinking`、`enable_thinking`、`chat_template_kwargs`）。

### 5.3 未知模型：显式能力字段

- 目录里没有的模型，控制台默认 `capabilities.mode = family`、`effort.send = auto`、`maxOutputTokens` 为空。第三方目录里的未知模型，基座最后会按「不发 effort」处理（`effort.ts` 里 `modelSupportsEffort` 的末行对第三方目录返回 false），节点会把这个结果报回来；ops 想发，就把能力切到「显式」并选 `always`。
- 节点 `status` 把基座对这个模型的实际判断（`effortOnWire`、上下文窗口、是否发 thinking）报回来，页面并排显示「目录值 / 节点算出的值」。两者不一致时，以节点值为准显示，并提示「目录没有这个模型 · 可在能力里显式设置」。
- `max_tokens`：P18.5 落 hermes #3，未知模型**不发**，有显式值或目录值才发；Claude / MiniMax / Qwen3 名字的模型补发；`OPENAI_MAX_TOKENS` 照旧可以覆盖。hermes 的风险提示照样成立：#3 必须和 #5（输出上限错误的识别和恢复）同批做。

### 5.4 推理内容归一化

| 方向 | 规则 | 包 |
|---|---|---|
| 读 | `delta.reasoning_content ?? delta.reasoning`；`reasoning_details[]` 存进消息级元数据（和 `_openaiReasoningItems` 同一种做法）；正文里内联的 `<think>`、`<thinking>`、`<thought>`、`<reasoning>`、`REASONING_SCRATCHPAD` 用一个小状态机转成 thinking 增量，跨增量的半截标签先扣住（标签集合照搬） | P18.8（#7、#8） |
| 回放 | 按**目标端点**查 hermes §11.2.3 的家族表：kimi / deepseek / mimo 要求回放，要求回放的补 `" "`；其余端点（包括 Mistral、Cerebras、Groq 这些严格端点）一律剥掉这个键；`reasoning_details` 只回放给 OpenRouter 和 MiniMax；Gemini 的 `extra_content` 只回放给 Gemini 系目标 | P18.8（#4、#10） |
| 跨端点 | Responses 的 `encrypted_content` 存的时候附上 base URL 指纹，回放时指纹不符就丢掉 | P18.8（#23） |
| 剥 | 可能带推理档位的键：`reasoning, reasoning_effort, thinking, thinking_config, thinking_budget, enable_thinking, think, verbosity`，作为「剥推理字段」的白名单 | P18.8（#14） |

DeepSeek 的空推理回放到底该用 `""` 还是 `" "`，两边的注释说法相反（hermes §11.10 第 2 条）。**在真实端点核实之前，保持阡陌现在的 `""`**，只对表里其他要求回放的家族补 `" "`。

### 5.5 测连三态与 `/v1` 纠正（都在节点上执行）

| 模式 | 做什么 | 花钱吗 |
|---|---|---|
| `auth`（测连） | 按预设的 `probe.auth` 发一次验 key 请求（例如 OpenRouter `GET /api/v1/key`、xAI `GET /v1/api-key`、智谱用免费的 `glm-4.7-flash` 发 `max_tokens: 1`、方舟 `count_tokens`），**判定看响应体，不只看状态码**（Gemini、xAI 坏 key 返回 400，智谱部分路径鉴权失败也返回 200） | 不花（智谱那一条用免费模型） |
| `latency`（测速） | 先热身一次，再连发三次 `auth`，报中位数和最小值。文案写明「网络往返 · 不含推理」 | 不花 |
| `call`（真实调用） | 用候选配置在一个临时配置根（`occConfigPath('qianmo','provider','probe-<requestId>')`，0600，用完删掉）里跑一次 `-p`，单轮、无工具、最小输出，走**真实的运行时线路**，包括 effort 门控 | **花一次最小调用**。确认对话框上写明 |

**三态**：`{ok: true}` 可用；`{ok: false, reachable: true}` 服务可达，但凭据、模型或参数被拒（附状态码和脱敏后的厂商错误码）；`{ok: false, reachable: false}` 连不上（DNS、TLS、超时、连接被拒）。`message` 是中文的原因和下一步。

**`/v1` 纠正**（hermes B8）：OpenAI 线拉 `/models` 返回 404，而 base 不以 `/v1` 结尾时，再试 `{base}/v1/models`，成功就返回 `suggestion.baseUrl`；Anthropic 线的 base 以 `/v1` 结尾时（运行时会自己拼 `/v1/messages`），建议去掉。页面把建议值填进表单，并显示「已按探测结果改为 …」，用户可以改回去；**不在背后静默保存**。

**拉模型列表**：预设自带的模型表 → `GET /models`（候选地址逐个回退，只有 404/405 才换下一个）→ 手动输入。很多国产 Anthropic 端点没有 `/models`（百炼 404、智谱 200 加错误体、方舟没有这个端点），所以预设自带模型表是主路径。

### 5.6 hermes §11 三十三项逐项落位

批次照 hermes §11.7 的三批：**第一批止血 → P18.5（B1）；第二批推理一致性 → P18.8（B2）；第三批韧性 → P18.12（B3）**。hermes 没有分批的几项（#13、#21、#22、#25、#26）按性质归入相近的一批，表里标「本文归入」。估算是 hermes 的单人人日，括号里是换算后的人时。「改的基座文件」一列为空表示不改基座；改基座的理由统一列在 §5.8。

| # | 项 | 批 | 包 | 改法摘要（规则表一律放新文件） | 改的基座文件（只改调用点） | 估算 |
|---|---|---|---|---|---|---|
| 1 | 第三方线路的模型 fallback | 三 | P18.12 | `retryThirdPartyEventStream` 放弃时，按分类结果（5xx 重试用尽、模型不存在、权限或模型被禁用）抛 `FallbackTriggeredError`，复用 `query.ts` 现有的分支；换模型前先过 #4 的回放过滤 | `src/services/api/streamAssembly.ts`；各第三方线路的错误出口（`openai/index.ts` 今天把车道内的错误转成一条错误消息，要让 `FallbackTriggeredError` 透传；gemini、grok 两条线同理） | 2–3（16–24） |
| 2 | 多 key 轮换 | 本文归入（D-6） | P18.18 | 同家多 key 池：429 先同 key 重试一次再换，用量上限立即换，402 立即换并冷却 1 h，401 换并冷却 5 min，`Retry-After` / `reset_at` 优先于默认冷却；换 key 只在 commitment 屏障之前发生 | `src/services/api/openai/{retry.ts,index.ts}`、`src/services/api/retryClassification.ts`（纯插入：调用池模块） | 3–5（24–40） |
| 3 | `max_tokens` 默认值 | 一 | P18.5 | 未知模型不发；目录或显式值才发；保留 `OPENAI_MAX_TOKENS`；Claude / MiniMax / Qwen3 名字补发。必须和 #5 同批 | `src/services/api/openai/index.ts`（`:389-393` 一带） | 1（8） |
| 4 | 推理回放策略 | 二 | P18.8 | 照搬 §11.2.3 家族表；`anthropicMessagesToOpenAI` 加一个「目标端点」参数；删掉 `applyCompatRule` 那套（R-14） | `packages/@ant/model-provider/src/shared/openaiConvertMessages.ts`、`src/services/providerRegistry/providerCompatMatrix.ts` | 2（16） |
| 5 | 输出上限 vs 溢出 | 一 | P18.5 | 照搬 §11.4.4 的识别表和取数规则；在 `isPromptTooLongMessage` 之前先判输出上限；第三方线路加「缩小上限重发一次」，走 commitment 屏障 | `src/services/api/errors.ts`、`src/services/api/streamAssembly.ts` 的重发点 | 2（16） |
| 6 | 溢出文案表 | 一 | P18.5 | 合并 hermes 的 30 多条；护栏：**先匹配限流文案再匹配溢出**，**先判输出上限再判溢出** | `src/services/api/errors.ts` | 0.5（4） |
| 7 | `delta.reasoning` 与 `reasoning_details` | 二 | P18.8 | 读 `reasoning_content ?? reasoning`；`reasoning_details` 存元数据，只对 OpenRouter / MiniMax 回放 | `openaiStreamAdapter.ts`、`openaiConvertMessages.ts` | 1（8） |
| 8 | 正文里内联的 `<think>` | 二 | P18.8 | 流适配器加状态机，标签集合照搬 | `openaiStreamAdapter.ts` | 1–1.5（8–12） |
| 9 | 工具增量：index 复用、名字、整数 id | 一 | P18.5 | 槽位按「index + 最近一次的 id」区分；名字允许后到覆盖（在 `content_block_start` 之前缓冲到第一个非空名字）；id 一律 `String(id)` | `openaiStreamAdapter.ts`（`:313-379` 一带） | 1（8） |
| 10 | Gemini `extra_content` 回放（OpenAI 兼容端点） | 二 | P18.8 | 捕获后存进 tool_use 的元数据，目标模型名含 `gemini` / `gemma` 才回放 | `openaiStreamAdapter.ts`、`openaiConvertMessages.ts` | 1（8） |
| 11 | `max_completion_tokens` | 一 | P18.5 | 官方 OpenAI 或 Azure 主机一律用新名；其他主机上模型去掉前缀后以 `o1/o3/o4/gpt-5` 开头的用新名；否则用 `max_tokens`（hermes §11.2.5 的建议规则；`gpt-4o`、`gpt-4.1` 是否也要用新名，没核实，先不加） | `src/services/api/openai/requestBody.ts` | 0.5（4） |
| 12 | 推理模型的采样参数 | 一 | P18.5 | 推理模型（o 系列、gpt-5/6、Kimi、开了思考的端点）不发 temperature，副查询也一样；把现有两处「字段被拒就去掉重试一次」（`prompt_cache_key`、`reasoning.summary`）抽成通用机制，复用 hermes「参数不受支持」的文案表 | `requestBody.ts`、`src/services/api/openai/index.ts`、`src/services/api/openai/responsesAdapter.ts` | 1（8） |
| 13 | Grok 的 effort 映射 | 二（本文归入） | P18.8 | 照搬 hermes 的允许名单和夹取表（`grok-3-mini`、`grok-4.20-multi-agent`、`grok-4.3`、`grok-4.5`、`grok-4.6`）；**真实端点核实之前不默认开**（§5.10）。xAI 预设走 OpenAI 线的 Responses，不经过 Grok 线 | `src/services/api/grok/reasoning.ts` | 1 + 核实（8） |
| 14 | Kimi / GLM / MiniMax / Ollama Cloud / 自定义端点的 effort | 二 | P18.8 | §11.2.7 对应各行进一张阡陌自有厂商表；按目标端点选键（Kimi 的 `thinking` 和 `reasoning_effort` 二选一；GLM 只在用户有偏好时才发；MiniMax 总是发 `reasoning_split: true`；Ollama 关思考必须显式发 `"none"`） | `requestBody.ts` | 2–3（16–24） |
| 15 | 429 区分额度耗尽、限流、过载 | 一 | P18.5 | 照搬计费文案表和计费错误码表：命中就判 `billing_error`，不重试；过载不换 key | `src/services/api/retryClassification.ts` | 0.5（4） |
| 16 | `Retry-After` 上限 | 三 | P18.12 | 交互式终端保留 60 s；常驻和无人值守会话放宽到 600 s，按运行形态取上限 | `src/services/api/openai/retry.ts` | 0.5（4） |
| 17 | Z.AI 过载的长退避 | 三 | P18.12 | 照搬判据（429，body 含 1305 或 temporarily overloaded，coding 端点）和退避表 | `openai/retry.ts` | 0.5（4） |
| 18 | chat 线的空闲看门狗 | 三 | P18.12 | 复用 Responses 线的 `CLAUDE_STREAM_IDLE_TIMEOUT_MS` 机制，把 chat 流包起来 | `src/services/api/openai/index.ts` 的 chat 流包装处 | 0.5–1（4–8） |
| 19 | 流里夹带的错误块（DeepInfra 形状） | 三 | P18.12 | 先写夹具确认现状；遇到「没有 `choices`、带 `error` 或 `error_type`」的块就抛不可重试错误 | `openaiStreamAdapter.ts` | 0.5（4） |
| 20 | 工具结果里的图片 | 三 | P18.12 | 默认保留 list 形内容；照搬「工具消息不收多模态」文案表做被动降级；按（端点，模型）记住结果 | `openaiConvertMessages.ts` | 1.5（12） |
| 21 | 工具 schema 消毒 | 三（本文归入） | P18.12 | 主动执行无损的几条（`$ref` 的兄弟关键字、空 properties、type 数组）；`pattern/format` 和含 `/` 的 enum 走被动（收到对应的 400 才剥）；Moonshot 子集按主机启用；属性名规则也给 Anthropic 线用 | `packages/@ant/model-provider/src/shared/openaiConvertTools.ts` | 2（16） |
| 22 | 按主机强制 wire | 一（本文归入） | P18.5 | 在 `resolveOpenAIWireProtocol` 里加主机表（`api.openai.com` 推理加工具、`api.meta.ai`、Anthropic 垫片、Azure），放在显式 `OPENAI_WIRE_API` **之后** | `src/services/api/openai/wireProtocol.ts` | 0.5（4） |
| 23 | Responses `encrypted_content` 跨端点 | 二 | P18.8 | 推理条目附 base URL 指纹，不符就丢 | `responsesAdapter.ts` | 0.5（4） |
| 24 | 思考耗尽、工具调用被截断 | 三 | P18.12 | 续写前先判断：「结束原因是 `length` 且只有 thinking」或者「最后一块是没闭合的 tool_use」，命中就改为调高上限重发一次 | `src/query.ts` | 1（8） |
| 25 | 空响应的判据 | 三（本文归入） | P18.12 | 借用「`output_tokens = 0` 连续两次就停」，不借成本预算 | `streamAssembly.ts` | 0.25（2） |
| 26 | usage 字段 | 二（本文归入） | P18.8 | 补 `reasoning_tokens`（chat 与 Responses 两处）和 Anthropic 式顶层缓存字段的回退；P15.7 按人计量会用到 | `packages/@ant/model-provider/src/shared/openaiUsage.ts`、`responsesAdapter.ts` | 0.25（2） |
| 27 | content_filter | 三 | P18.12 | 至少在界面上标出「被内容过滤截断」；fallback 依赖 #1 | `openaiStreamAdapter.ts` | 0.5（4） |
| 28 | developer 角色 | **不做** | — | 只在强制走 chat 时才有影响，hermes 也说可以不做 | — | 0.25（不计） |
| 29 | 重放安全（恰好一次） | 约束 | 全部 | **保留阡陌的做法**；#1、#5、#12 新加的重试都必须走同一道屏障 | — | — |
| 30 | DeepSeek 128 个函数上限、编码温度 | 约束 | — | 阡陌独有，保留 | — | — |
| 31 | 正文中夹着空的 `reasoning_content` | 约束 | — | 阡陌独有，保留（#8 的状态机不能破坏这一条，回归用例照旧） | — | — |
| 32 | 错误诊断脱敏 | 约束 | 全部 | 保留；新的文案匹配都在脱敏之前、对结构化字段做 | — | — |
| 33 | 测试 | 三 | P18.12 | 按 §5.9 的四条做（preload 清凭据、逐厂商请求体对等表、构造夹具、真实调用 opt-in） | `tests/preload.ts` | 2（16） |

**阡陌追加项**（不在 hermes 33 项里，来自 §0.2 的教训和 matrix 的 T7）：

| # | 项 | 批 | 包 | 改的基座文件 | 估算 |
|---|---|---|---|---|---|
| Q-1 | chat 线 effort 门控改用 `modelSupportsEffort()`，节点自报 `chatEffortHonorsOverride` | 一 | P18.5 | `src/services/api/openai/index.ts`（`:499-506`） | 4–8 人时 |
| Q-2 | 能力覆盖读 FABLE 档，以及 `gemini` / `grok` 自己前缀的档位 | 一 | P18.5 | `src/utils/model/modelSupportOverrides.ts` | 4 人时 |

**各批合计**（人时，含追加项与对等夹具）：第一批 P18.5 **64–88**；第二批 P18.8 **72–96**；第三批 P18.12 **88–112**。三批合计 224–296 人时，约 28–37 人日，与 hermes 估的 28–33 人日一致（多出来的是 Q-1、Q-2 和归入的几项）。hermes 自陈的误差是 ±50%。

**批间依赖**：#4 是第二批的第一项，后面几项都要往它的表里加行；#1 依赖 #4（换模型前要先过滤回放）；#3 必须和 #5 同批。

### 5.7 规则表的落点

照搬 hermes §11.8 的十四张表，**只搬事实，不搬代码**。每个新文件头写「规则来源 NousResearch/hermes-agent `文件:行号`，取于 `f9b29c49b6`，取用日期」（R-15）。

| 表 | 新文件（阡陌自有） | 被谁调用 | 批 |
|---|---|---|---|
| 推理回放家族表与回放策略 | `shared/qianmo/reasoningEcho.ts` | `openaiConvertMessages.ts` | 二 |
| 推理字段名清单（读与剥） | `shared/qianmo/reasoningFields.ts` | 流适配器、`requestBody.ts` | 二 |
| 内联思考标签集合 | `shared/qianmo/thinkTags.ts` | 流适配器 | 二 |
| effort 厂商映射（§11.2.7） | `src/services/qianmo/modelCompat/effortVendors.ts` | `requestBody.ts`、`grok/reasoning.ts` | 二 |
| `max_completion_tokens` 前缀表 | `modelCompat/outputTokenParam.ts` | `requestBody.ts` | 一 |
| 必须走 Responses 的主机和模型 | `modelCompat/wireHosts.ts` | `wireProtocol.ts` | 一 |
| 工具 schema 规则清单 | `shared/qianmo/schemaRules.ts` | `openaiConvertTools.ts` | 三 |
| 上下文溢出文案表 | `modelCompat/overflowText.ts` | `errors.ts` | 一 |
| 输出上限的识别与取数 | `modelCompat/outputCap.ts` | `errors.ts`、`streamAssembly.ts` | 一 |
| 计费、限流、过载、用量上限、载荷过大、图片过大、工具消息不收多模态的文案表与计费错误码表 | `modelCompat/errorText.ts` | `retryClassification.ts` | 一（计费、限流、过载），三（其余） |
| 「参数不受支持」文案表 | `modelCompat/unsupportedParam.ts` | 通用剥参数机制 | 一 |
| Z.AI 过载判据与退避表 | `modelCompat/vendorBackoff.ts` | `openai/retry.ts` | 三 |
| usage 字段映射 | `shared/qianmo/usageFields.ts` | `openaiUsage.ts` | 二 |
| 凭据环境变量清单（测试用） | `tests/support/credentialEnv.ts` | `tests/preload.ts` | 三 |

（`shared/qianmo/` 指 `packages/@ant/model-provider/src/shared/qianmo/`，`modelCompat/` 指 `src/services/qianmo/modelCompat/`。）

### 5.8 要改的基座核心与理由

逐个文件用 `git cat-file -e base-snapshot/v2.46.0:<path>` 核过，都属于基座层。每个改基座的包在 `docs/dev/base-modifications.md` 登记（每一批由该批的调用层包统一登记，避免同批文件冲突，见 §9.3）。

| 基座文件 | 包 | 改什么 | 为什么扩展点不够 | 目标形态 |
|---|---|---|---|---|
| `src/utils/model/chinaLlmProviders.ts` | P18.1 | MiMo 段换成 v2.6 的 id | 基座 `/provider` 向导直接读这张静态表，没有覆盖层；我们的目录只服务控制台，管不到基座向导的用户 | 只替换值 |
| `src/services/api/openai/index.ts` | P18.5、P18.12 | Q-1 门控；#3 `maxTokens`；#12 剥参数通用化；#18 chat 流看门狗；#1 让 `FallbackTriggeredError` 透传 | 这几处判断都**内联**在请求组装里，没有钩子；chat 线门控只认一个谓词，环境变量和显式覆盖都到不了它 | 一次调用替换（谓词换成 `modelSupportsEffort`）＋若干处纯插入（调用新模块） |
| `src/utils/model/modelSupportOverrides.ts` | P18.5 | Q-2：档位表加 FABLE，`gemini` / `grok` 读自己的前缀 | 档位表是模块内常量，`get3PModelCapabilityOverride` 是唯一入口；基座自己的 `PROFILE_ENV_KEYS` 写了这些键却没人读 | 常量表插入条目 |
| `src/services/api/errors.ts` | P18.5 | #5、#6 | 溢出正则和 `isPromptTooLongMessage` 是常量加函数，判定顺序（限流 → 输出上限 → 溢出）只能在函数入口插入 | 函数入口纯插入 |
| `src/services/api/retryClassification.ts` | P18.5、P18.12 | #15，以及第三批其余文案表 | 分类管线是有序的 if 链，没有注册点 | 在 rate_limit 判定前纯插入 |
| `src/services/api/openai/requestBody.ts` | P18.5、P18.8 | #11、#12、#14 | 请求体是一个函数组装出来的，键名选择没有钩子 | 调用点替换 |
| `src/services/api/openai/wireProtocol.ts` | P18.5 | #22 | `resolveOpenAIWireProtocol` 是唯一的选线函数 | 在显式值判定之后纯插入一次查表 |
| `src/services/api/openai/responsesAdapter.ts` | P18.5、P18.8 | #12（summary 重试并入通用机制）、#23、#26 | 同上，状态都在适配器内部 | 调用点替换 |
| `packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts` | P18.5、P18.8、P18.12 | #7、#8、#9、#10、#19、#27 | 流解析是单个状态机，没有插件点 | 在 delta 分派处插入调用 |
| `packages/@ant/model-provider/src/shared/openaiConvertMessages.ts` | P18.8、P18.12 | #4、#10、#20 | 转换函数不知道目标端点，必须加参数 | 加一个可选参数，默认值保持现状 |
| `packages/@ant/model-provider/src/shared/openaiConvertTools.ts` | P18.12 | #21 | 同上 | 调用点插入 |
| `packages/@ant/model-provider/src/shared/openaiUsage.ts` | P18.8 | #26 | 字段映射是内联的 | 插入回退 |
| `src/services/api/grok/reasoning.ts` | P18.8 | #13 | 允许名单是常量 | 换成查表 |
| `src/services/providerRegistry/providerCompatMatrix.ts` | P18.8 | 删除 `applyCompatRule` 及其死数据（R-14） | 不是扩展点不够，是两套规则不能并存 | 删除；`base-modifications.md` 记明理由 |
| `src/services/api/gemini/index.ts`、`src/services/api/grok/index.ts` | P18.12（如需） | #1：车道内错误出口让 `FallbackTriggeredError` 透传 | 错误出口内联在各车道的流处理里 | 在 catch 分支纯插入一次判断 |
| `src/services/api/openai/retry.ts` | P18.12 | #16、#17 | 上限与退避是常量 | 调用点插入 |
| `src/services/api/streamAssembly.ts` | P18.5、P18.12 | #5 重发、#1、#25 | `retryThirdPartyEventStream` 是第三方线路唯一的重试循环，fallback 只能从这里抛 | 在放弃分支插入 |
| `src/query.ts` | P18.12 | #24 | 续写决策内联在主循环里 | 在续写前插入一次判断 |
| `tests/preload.ts` | P18.12 | #33 清凭据环境变量 | preload 是全局唯一入口 | 纯插入 |
| `src/entrypoints/cli.tsx` | P18.7 | `qm provider` 快速路径 | 现有 `qm` 子命令（resident、audit、console、watch 等）都是在这里插入的快速路径，没有注册机制 | 纯插入一段，与现有快速路径同形 |
| `src/utils/process/subprocessEnv.ts` | P18.7 | 清理名单加 `OPENAI_API_KEY`、`GEMINI_API_KEY`、`GROK_API_KEY`、`XAI_API_KEY`、`OPENCODE_API_KEY` | 名单是模块内常量 `GHA_SUBPROCESS_SCRUB`，没有注入点；这几把 key 和名单里已有的 `ANTHROPIC_API_KEY` 同等敏感 | 常量表插入五项 |

### 5.9 测试方法（hermes §11.6 的四条）

1. **preload 清凭据**：按后缀（`_API_KEY`、`_TOKEN`、`_SECRET` 等）匹配，再加一份显式名单。这一条同时消掉 `codexPinnedSearch` 那个条件性红点的来源。
2. **逐厂商请求体对等表**：输入是（厂商，模型，base URL，effort，思考开关，是否副查询），断言请求体里的键和值。它同时就是 §5.6 那张映射表、AC-P4 的可执行版本。P18.5 建表头，每批往里加行。
3. **构造夹具**：每条厂商特例配一个 SSE 块序列夹具（JSONL）。文件头写明「依据 hermes `文件:行号` 的注释或厂商文档构造，**不是录制的**」，免得被当成实测证据。
4. **真实调用 opt-in**：设了环境变量才跑，不进 CI；结果作为 `evaluated` 的证据入档（§8.4）。

### 5.10 要真实端点核实才能定的项

照 hermes §11.10。没核实之前，一律保持阡陌现状，或者默认关闭：

| 项 | 核实之前的做法 |
|---|---|
| DeepSeek 空推理回放用 `""` 还是 `" "` | 保持 `""` |
| o 系列与 `max_tokens`、`temperature`；`gpt-4o`、`gpt-4.1` 是否拒 `max_tokens` | 按 #11、#12 的规则做，`gpt-4o` / `gpt-4.1` 不加进按名强制 |
| xAI grok-4 系列是否接受 `reasoning_effort` | xAI 预设 effort `never` |
| DeepInfra 流内错误在阡陌这边的表现 | 先写夹具（#19 的第一步） |
| OpenAI SDK 的 `timeout` 在流式请求里覆盖到哪一段 | #18 照做，不依赖 SDK 超时 |
| Gemini 3 对 `thinkingBudget` 的处理 | 保持原生线现状，预设 effort `auto` |
| `stream_options.include_usage` 哪些端点拒 | 保持现状 |
| hermes 的规则表是 2026-08 的状态，会过期 | 每张表带出处和日期；配构造夹具 |

---

## §6 控制台信息架构

### 6.1 外壳与路由

照 `console-audit.md` §6 的目标结构，所有 URL 都服务端渲染。脚本关闭时，导航和只读视图照常可用；写操作需要脚本（它们都要带 `x-qianmo-console` 头，§7.2）。

```
外壳：顶栏（面包屑 · 页标题 · 主操作 · 全局健康徽标「注册中心 审计 链路 模型」 · 用户菜单「角色 · 退出」）
      侧栏分组导航（窄屏下进抽屉） · toast 区 · 会话失效模态

运行
  总览          /                     健康指标卡、近期异常、待办（证书、吊销清单、未见证、模型漂移）
  节点          /nodes                名册（搜索、筛选）→ /nodes/<node>（智能体 · 模型 · 证书 · 服务器 · 审计 · 会话 · 操作历史）
  对话          /chat                 线程头显示目标节点当前生效的模型；切换处画分隔线
  消息链        /audit                倒序、分页、游标 → /audit/trace/<traceId>
  告警          /alerts               J5（P1）
  值守作业      /jobs                 J6（P1）
  审批          /approvals            J8（条件：P14.5 之后）
配置
  模型服务      /providers            本文主体（§6.3）
  服务器        /servers              备注、节点接入（J9，装机面，另线）
管理
  账号与访问    /access               成员 · 邀请 · 会话 · 操作记录（H3、H4）
  用量          /usage                J7（条件：P15.7 之后）
  设置与关于    /settings             实例信息 · 版本 · 限额（原「限额」区块）· 主题
```

**实现约束**：

- P18.4 抽出 `renderShell({active, breadcrumb, title, actions, body, pageCss, pageScript})`，并新建 `packages/console/src/routes/` 路由表，**一次性为每个区域建好桩文件**（`providers.ts`、`access.ts`、`audit.ts`、`nodes.ts` 等）。后续每个页面包只改自己那一个路由文件和自己的视图文件，同一批的包之间文件不相交（§9.3）。
- 每页的 CSS 和脚本片段由路由模块自己导出，外壳只内联当前页的那一份，**不往共享的 `css.ts` 里加东西**。这样既没有跨包冲突，首屏也只带本页需要的东西（G1）。
- 页面之间共用的交互（toast、`<dialog>`、行内保态刷新、会话失效模态）只在 P18.4 写一次，放在 `assets/client.ts`。
- 对话页（`/chat`）现有的分工不变：「服务端渲染 HTML，客户端只渲染文本」，SSE 只推 revision。

### 6.2 P0 十一项落位

| 项 | 内容 | 包 |
|---|---|---|
| A1 | 多路由外壳 | P18.4 |
| C1 | 会话失效与 401 的统一处理（模态 + 停轮询 + 重新登录后回到原页） | P18.4 |
| C7 | 按权限呈现：没有权限的控件不出现，或者禁用并写明原因 | P18.4（外壳与现有页面）；之后每个页面包自己遵守 |
| D1 | 轮询保态：刷新不收起展开的行、不丢焦点和输入 | P18.4 |
| D2 | toast 与统一的操作反馈 | P18.4 |
| D5 | 审计列表可用：倒序、分页、游标、搜索 | P18.11 |
| H1 | 防点击劫持：CSP 改为响应头并加 `frame-ancestors 'none'`，再加 `X-Frame-Options: DENY` | P18.4 |
| H3 | 账号与访问页 | P18.10 |
| H4 | 操作记录：后端是 P15.9 的动作账本，页面在 P18.10 | P15.9 + P18.10 |
| J1 | 模型服务 | 后端 P18.2 / P18.6 / P18.7，页面 P18.9 |
| J2 | 智能体生命周期：后端是 P15.2 余下部分，页面在 P18.11 | P15.2 + P18.11 |

P18.4 顺带做审计「第一批」里不依赖评审的几项：A5（侧栏计数）、C3（HTML 错误页）、D7（去掉全局 `user-select: none`），以及 K1（零依赖的 CDP 浏览器级测试；D1、C1、C7 这类缺陷只有浏览器级测试抓得到）。

### 6.3 模型服务页（CC Switch 式）

#### 6.3.1 `/providers`：一屏看清楚

- **顶部**：「全局默认」卡片：档案名、线路、主模型、effort 状态、几个节点在用、几个节点有漂移。
- **节点矩阵**：每个节点一行，列为「期望 · 实际 · 状态 · 线路 · 模型 · effort（节点算出）· 最近测连 · 操作」。状态徽标用 §2.4 的漂移类型。行操作：下发、测连、查看差异、改为单独指定。
- **档案列表**：卡片形式，显示名称、厂商、按量或套餐、线路、主模型、「未评估」或「已评估（日期）」、密钥状态（已设置 / 未设置，**不显示任何片段**）。
- **主操作**：「新增模型服务」。

#### 6.3.2 新增：从预设开始

1. `/providers/new`：预设卡片网格，分「国内按量 / 国际 / 套餐 / 本地 / 自定义」五组。搜索框是纯子串匹配，用一个 GET 表单实现，不需要脚本（hermes B16）。卡片只有文字，没有 logo。
2. 点一张卡片进 `/providers/new?preset=<id>`。表单**默认只有一个必填项：密钥**。站点、模板变量（例如百炼的 WorkspaceId）有的话才出现，并且是必填。
3. 「高级」默认收起，有非默认值时自动展开：线路、Base URL、模型与档位、每个模型的能力与 effort、兼容开关。
4. 密钥输入框：`type="password"`、`autocomplete="off"`。前缀不匹配时只给软提示，例如「这个前缀通常属于套餐密钥 · 当前选的是按量地址」，不拦截。
5. 「测连」「测速」「真实调用」三个按钮：目标节点默认是全局默认作用域下的第一个在线节点，可以改选。结果就地显示三态（§5.5）。`/v1` 纠正直接改写表单里的值并提示。
6. 「拉取模型列表」：结果做成可搜索的下拉，按预设模型表、`/models` 返回值的顺序合并。
7. 提交时只有两类硬错误：格式不合法、身份冲突（id 重复）。其余缺项都算软问题，可以「仍然保存」，但「保存并切换」要求测连结果为 `ok`（或者 ops 勾选「跳过测连」，这一选择记进动作账本）。

#### 6.3.3 编辑与密钥

- 密钥字段只有三种状态：「未设置」「已设置 · 设置于 2026-10-03 14:20」「已设置 · 指纹 3f9a1c2e」（指纹只给 ops 看）。操作只有「重新填写」和「清除」。**任何接口都不返回明文**，也不返回首尾几位（比 hermes B9 的「末 4 位」更严）。
- 保存要带 `If-Match` 修订号；修订号不符时返回 409，页面提示「此服务已被他人修改 · 刷新后再保存」，并列出被改动的字段名。
- 删除：还有节点在用（期望或实际）时拒绝，要先指定替代档案。

#### 6.3.4 切换与作用域

- 「切换到此服务」打开 `<dialog>`：选作用域（全局默认，或者勾选节点）；显示每个受影响节点的「当前 → 目标」；显示会话策略（§2.7）和 dry-run 得到的键名差异。
- 确认之后，按节点逐个执行。每个节点一行进度：「已下发 · 等待空闲 · 已生效」或者失败原因。部分失败时页面明确列出哪几台没成功，可以单独重试。
- 改全局默认时，单独指定过的节点不受影响，对话框里会列出来。

#### 6.3.5 测连与测速

见 §5.5。页面上把三种检查各自测了什么写清楚：测连「验证地址和密钥 · 不产生费用」；测速「网络往返 · 不含推理」；真实调用「走完整线路发一次最小请求 · 会产生一次计费调用」。

#### 6.3.6 导入导出

见 §3.9。导出按钮旁边写「导出不含密钥」。导入先进入预览页，整份显示，有闭合集合之外的键就整份拒绝。

#### 6.3.7 冲突

- **编辑冲突**：§6.3.3 的 409。
- **节点冲突**：节点返回 `conflict` 时，页面显示被改动的键名（不显示值），给两个选择：「覆盖节点上的改动」（重发 apply，带 `force`，记进账本），或者「停止托管这个节点」（只在中枢一侧把期望改成「不托管」，不动节点文件）。

#### 6.3.8 节点详情的「模型」页签与对话页

- `/nodes/<node>` 的「模型」页签：只读，显示期望、实际、漂移、`effective` 的全部字段、最近 10 次下发与测连记录，链回 `/providers?node=<node>`。
- 对话页的线程头显示目标节点当前生效的模型，做成只读标签。发消息的人需要知道这一轮用的是哪个模型。
- 转录里在切换发生的时间点画一条分隔线。数据来自 `providers.ndjson` 的 `apply.result` 事件，由视图按时间戳插入，**不改对话存储**。

### 6.4 其他页面

| 页面 | 包 | 要点 |
|---|---|---|
| `/access` 账号与访问 | P18.10 | 成员列表（角色、最近登录、会话数）；邀请（签发、作废、剩余次数）；会话（强制下线）；操作记录（H4：主体、动作、目标、`requestId`、结果；筛选；只有 ops 能看全部，member 只能看到和自己有关的）。账号后端 P15.3 / P15.5 已经在 main 里（`21b2dd3f`、`fb2ca677`） |
| `/audit` 消息链 | P18.11 | D5：倒序、分页、游标、搜索；G2 的轮询成本随着改成增量 |
| `/nodes`、`/nodes/<node>` | P18.11 | A3 节点详情；J2 生命周期（发布、暂停、恢复、退役）用 `<dialog>` 二次确认；注册和唤醒改成节点页上的动作 |

### 6.5 P1 与 P2 的顺序

- **P1（B4，P18.14）**：先修「状态与反馈」一组（C2、C4、C5、C6、C8、D3、D4、I1、I2、H5），再做「外观、性能、可访问性」一组（A2、A4、B1、D6、E1、F1、G1、H2、时区）。I1（把文案门禁扩到动态文案）和 C5（错误映射）放在同一个提交里，因为门禁一扩，现有的 20 条错误串会立即失败。
- **P1（B5，P18.15）**：J5 告警中心、J6 值守作业页。
- **条件（B5，P18.16）**：J7 用量（P15.7 之后）、J8 审批（P14.5 之后）。
- **P2（B5，P18.17）**：B2–B5、D8–D10、E2、F2、I3、I4、J10、J11、K2。J11 多语言只有在需要英文界面时才做。J9 节点接入属于装机面，归 `node-provisioning.md` 那条线，不在本文。

### 6.6 文案样稿

规则：冷静、精简、专业；不用感叹号、emoji、语气词和营销腔；**可见文案不用「。，、」，用「 · 」分隔**（`console-audit.md` §1；控制台禁句读门禁）。

| 场景 | 文案 |
|---|---|
| 页标题 / 主操作 | 模型服务 · 新增模型服务 |
| 空态 | 还没有模型服务 · 从预设开始 |
| 预设分组 | 国内按量 · 国际 · 套餐 · 本地 · 自定义 |
| 卡片标签 | 按量 · 套餐 · 未评估 · 已评估 2026-10-12 |
| 只填 key 的提示 | 选好预设后只需填写密钥 |
| 密钥框占位 | 粘贴密钥 · 保存后不再显示 |
| 密钥状态 | 已设置 · 设置于 2026-10-03 14:20 |
| 前缀软提示 | 这个前缀通常属于套餐密钥 · 当前选的是按量地址 |
| 套餐条款提示 | 套餐条款多限定用于交互式编程工具 · 远端智能体代为调用可能不符合条款 · 请对照官方条款自行判断 |
| 地区提示（Gemini） | 该服务的可用地区不含中国大陆和港澳 · 节点所在地区可能被拒 |
| 测连结果 | 可用 · 312 ms ／ 服务可达 · 密钥被拒 401 ／ 无法连接 · 连接超时 |
| 地址纠正 | 已按探测结果改为 https://example.com/v1 |
| 真实调用确认 | 将通过节点发送一次最小请求 · 会产生一次计费调用 |
| 切换确认 | 节点在空闲时切换 · 进行中的对话不受影响 · 更换厂商会开始新的会话 |
| 进度 | 已下发 · 等待空闲 · 已生效 |
| 等待超时 | 已等待 30 分钟 · 节点仍有 2 个进行中的对话 · 未强制切换 |
| 编辑冲突 | 此服务已被他人修改 · 刷新后再保存 |
| 节点冲突 | 节点上的配置在上次下发后被改过 · 覆盖或停止托管 |
| 未托管 | 未托管 · 当前由节点本地配置决定 |
| 环境残留 | 节点进程环境里还有旧的模型变量 · 子进程已剥离 · 下次重启后消失 |
| 无权限 | 需要运维角色的个人账号 |
| 导出 | 导出不含密钥 |
| 主密钥缺失 | 主密钥缺失 · 模型服务已停用 · 节点继续使用上次下发的配置 |
| 对话分隔线 | 已切换到 DeepSeek · deepseek-v4-pro · 新会话 |

### 6.7 渐进增强的边界

| 能力 | 无脚本 | 有脚本 |
|---|---|---|
| 所有页面的导航与只读视图 | 可用 | 可用 |
| 预设搜索 | 可用（GET 表单） | 可用 |
| 测连、测速、拉模型列表 | 不可用（需要带 `x-qianmo-console` 头） | 可用 |
| 保存、切换、删除、导入 | 不可用，并写明原因 | 可用 |
| 后台刷新 | 手动刷新页面 | 行内保态刷新（D1） |

---

## §7 安全

### 7.1 响应头（H1）

- `DOCUMENT_HEADERS`（`packages/console/src/respond.ts:30`）加上 `content-security-policy`（取 `view/page.ts:171` 的 `CSP` 常量，再加 `frame-ancestors 'none'`）和 `x-frame-options: DENY`。`<meta>` 里的 CSP 保留，但 `frame-ancestors` 写在 meta 里浏览器会忽略（`authorization-m1.md` TH-5），所以必须走响应头。
- 现有 CSP 里有 `script-src 'unsafe-inline'`（页面是全内联的）。新页面不引入外部脚本，也不加 `connect-src` 以外的源。

### 7.2 CSRF

沿用现有的两道：cookie 是 `HttpOnly; SameSite=Strict`，只限本主机（`auth.ts`）；凡不是纯文档读的路由，cookie 鉴权的请求都必须带 `x-qianmo-console` 头（`auth.ts:123`），跨源页面不经 CORS 预检加不上这个头，而控制台不响应 CORS。模型服务的所有写路由都属于 guarded 级别。另外：写操作带 `If-Match`；危险操作（切换、删除、清除密钥、覆盖节点改动）走 `<dialog>` 二次确认。

### 7.3 按角色呈现

| 主体 | 模型服务页能看到 | 能做 |
|---|---|---|
| `viewer` | 节点用的是哪个厂商、哪个模型、什么线路、什么状态；**看不到**指纹、Base URL 主机以外的部分、操作记录 | 无 |
| `member` | 同 viewer；对话页的模型标签 | 无 |
| `ops`（个人账号） | 全部，包括指纹、漂移差异的键名、操作记录 | 全部写操作 |
| break-glass admin | 同 viewer | **无**。和 `tenancy-m1.md` §3.4 的四条限制同一取向：用后轮换、限制用途 |
| legacy token（不开 `--accounts`） | 同 viewer | 无。页面写明「需要运维角色的个人账号」 |

### 7.4 第六类动作的权限

- 要求个人账号的 `ops` 角色；动作账本（P15.9）记录主体、动作（`provider.save`、`provider.secret.set`、`provider.apply`、`provider.probe.call` 等）、目标、`requestId`、结果。
- 不要求 provision token（R-13，负责人已确认，D-4）。
- 节点侧不认识「角色」：节点只认 sshd 强制命令和 schema。**中枢失陷**时，攻击者能做的事被限制在「把六类动作的参数改成别的合法值」：比如把节点的模型服务换成攻击者的端点，从而截获后续的对话内容。这一条写进 §7.7。

### 7.5 密钥纪律（禁地清单）

照 `node-provisioning.md` §4.4 的写法，模型密钥**永不出现**在：

1. 任何 HTTP 响应（页面、JSON、错误体、SSE）；
2. URL、查询串、cookie、`localStorage`；
3. 进程参数（中枢的 ssh 命令行、节点的 `qm` 命令行）；
4. 日志（中枢、节点、systemd journal）；已知的密钥值在写日志前逐字替换为 `***`（CC Switch 的做法），兜底只记 origin；
5. `providers.ndjson`、动作账本、审计链；只记指纹；
6. 导出文件与导入预览；
7. 节点上的 agent 可见面：resident 的 hardline 已经拒绝读 `settings.json`；P18.7 让 ACP 子进程的 spawn env 剥掉 provider 类键，并为它的子进程打开 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`、把五把 key 补进清理名单（§5.8），这样 Bash 工具里 `echo $OPENAI_API_KEY` 拿不到。**这不是机密边界**：agent 和密钥在同一个用户、同一棵进程树里，其他读法（例如 `/proc`）不在本文的防御范围内（§12）。

### 7.6 操作审计（H4）

- 后端是 P15.9（`tenancy-m1.md` §6：用 `@qianmo/audit` 的哈希链写，`--verify` 能判出篡改；片段轮询和 SSE 不写账）。
- 模型服务额外要求：**每次 apply 都记节点回报的结果**（成功、`conflict`、`busy` 等），不只记「发起了」。
- 页面在 `/access` 的「操作记录」页签（P18.10）。

### 7.7 威胁模型的变化

| 拿下谁 | 之前 | 之后 |
|---|---|---|
| 一台节点 | 自己那把 PSK、自己的审计链与工作区、自己的模型密钥 | **不变**。节点上没有任何指向 H 的凭据；它拿到的只有自己那份模型配置 |
| **H** | 四把 PSK、归档 token、控制台两枚 token、一把能在四台节点上跑五类动作的 SSH 私钥（`beta-env.md` §8.3 的表） | 以上全部，**再加**：全部模型密钥（主密钥和密文在同一台机器上，信封加密在这里帮不上忙）；每台节点一把能执行第六类动作的 key，可以**改写节点的模型服务**，把节点的对话流量导到攻击者的端点 |

缓解，以及没有缓解的部分：第六类动作的闭合由节点的 sshd 强制，H 失陷之后也只能「下发一份合法的模型配置」，不能执行任意命令；节点自己再按 schema 校验一遍，不信任中枢；每次 apply 的结果节点都留有 `state.json`，事后可以对账。**没有缓解的**：H 失陷时模型密钥泄漏，对话流量可以被重定向。这是负责人 D-2 接受的代价，和原文对「H 是单点」的判断是同一个结论，只是单点里多了两样东西。

---

## §8 测试与验收

### 8.1 每个包的完成标准

- 每个包都有可机检的完成标准（§9.2 的「完成标准」列），用例必须带**正向对照**：关掉被测的那条逻辑，对应的用例就要变红。
- 改基座的包：在 `base-modifications.md` 登记；PR 描述写明「为什么扩展点不够」（§5.8）；跑完整的 `bun run precheck`，推送前跑 `bun run verify`。
- 改控制台视图的包：按规程用 `CONSOLE_PARITY_UPDATE=1` 重生 `legacyParity.golden.json`，并在 PR 里写明「这次 legacy 行为本来就要变」。golden 属于**生成物**，由合入者在 rebase 之后重生，不算文件范围冲突。
- 每个包同步更新 `docs/dev/console.md` 的路由表和 `packages/console/README.md`（B3 里由 P18.11 统一回写，§9.3）。

### 8.2 录制桩

一个假的厂商 HTTP 服务（Bun.serve，只听回环），按路径模拟 Anthropic Messages、OpenAI Chat、OpenAI Responses 三种形状，**把收到的请求体逐条记下来**。AC-P1、AC-P4 都靠它。它不是真厂商，测出来的只是「阡陌这一侧发了什么」。

### 8.3 金丝雀扫描（AC-P2）

一把形如真 key 的随机金丝雀串，走完全流程后在下列位置 grep：中枢配置根（排除 `provider-secrets.json`）、节点配置根（排除 `settings.json` 和 `pending.json`）、所有日志、页面快照、账本、导出文件，以及流程进行中每 100 ms 采样一次的 `ps -eo args`。必须零命中。

### 8.4 真机验收（AC-P6）

- **同一份部署连续两轮零红**，一轮绿不算数。
- 每轮包括：所有节点 `status` 无漂移；一次真 key 三态测连（`auth`）；一次真实切换并切回；一次 `call` 模式的真实调用；AC-P2 金丝雀扫描；一次「resident 有在途 turn 时下发」，验证要等空闲、在途 turn 不失败。
- 真 key 只用舰队现有的 `gpt-6-luna` 凭据，`call` 模式会花少量费用（D-5，§13 第 2 点）。
- 预设的 `evaluated` 只有在真 key 冒烟通过之后才能改，证据（日期、提交、结果摘要，不含 key）记进档案；没有冒烟的预设一直显示「未评估」，**不能在任何对外材料里写「已兼容 X」**（hermes §11.11 最后一条）。
- 7 天长跑已于 2026-10-03T09:33:08Z 因负责人换模型提前结束（§0.2）；真机工作在它的收数完成之后进行；部署只用发行标签，不部署 main；发版由主 agent 执行（D-7）。

---

## §9 工作包

### 9.1 批次总览

| 批 | 包 | 说明 |
|---|---|---|
| **B0** 立即 | P18.0、P18.1 | P18.1 必须在 **2026-10-21 10:00（北京时间）**之前合入 |
| **B1** | P18.2、P18.3、P18.4、P18.5；P15.9（指针） | 调用层**第一批（止血）**在这里。P18.3 与 P18.2 可以并行开发，合入顺序是 P18.2 先 |
| **B2** | P18.6、P18.7、P18.8；P15.2 余下（指针） | 调用层**第二批（推理一致性）**在这里 |
| **B3** | P18.9、P18.10、P18.11、P18.12 | 调用层**第三批（韧性）**在这里；三个页面包同批 |
| **B4** | P18.18、P18.13、P18.14 | 多 key 轮换、真机验收与控制台 P1 收口。P18.18 先于 P18.13 合入，真机验收的部署要包含它 |
| **B5** | P18.15、P18.16（条件）、P18.17 | 批内串行（三包都要动 `deps.ts` 或共享样式），或者先拆成不相交的文件再并行 |

**关键路径**：P18.0 → P18.4 → P18.6 → P18.9 → P18.13，合计 226–358 人时。调用层这条 P18.5 → P18.8 → P18.12 → P18.18 → P18.13（264–368 人时）与它相当，两条都要盯。P18.2 → P18.3 → P18.7（76–120 人时）与 P18.4 并行，在 P18.9 之前汇合。

### 9.2 包表

「改基座」一列标「是」的，理由见 §5.8；`base-modifications.md` 的登记由该批的调用层包统一做（§9.3）。

| 包 | 批 | 目标 | 文件范围 | 依赖 | 改基座 | 完成标准（可机检） | 估算（人时） |
|---|---|---|---|---|---|---|---|
| **P18.0** ⚖️ 设计定案与范围回写 | B0 | 本文 v1.0；章程 v2.22；roadmap v2.80；`beta-env.md` v1.4 补注；`node-provisioning.md` 补注；`tenancy-m1.md` §6.1 补注 | `docs/dev/{providers-console-m1,charter,roadmap,beta-env,node-provisioning,tenancy-m1}.md` | 无 | 否 | 本文文首为 v1.0；`git grep -n "P18\."` 只命中这六份文档；章程 N-5 行含 v2.22 补注（扩展范围、仍不解禁的项、签字）；roadmap 方向表与 M1 速查各多一行（🟡），**没有任何一行改成 ✅**；`check:license-headers` 与 `check:docs-i18n` 退出码为 0 | 6–10 |
| **P18.1** MiMo 预设止血 | B0 | §4.6 | `src/utils/model/chinaLlmProviders.ts` 的 MiMo 段及其测试；`docs/dev/base-modifications.md` | 无 | 是（只替换值） | 该文件里不再出现 `mimo-v2.5-pro`、`mimo-v2.5`、`mimo-v2-flash`（grep 断言）；默认模型 `mimo-v2.6-pro`，haiku 档 `mimo-v2.6-flash`；`/provider` 向导选 MiMo 的既有用例全绿 | 2–4 |
| **P18.2** 目录与编译器 | B1 | `@qianmo/providers`（类型、预设、下线表、校验器、协议 schema v1、闭合键集、指纹）；src 侧编译器；节点写入库（§2.6 的四个接口） | `packages/providers/**`（新）；`src/services/qianmo/providers/**`（新）；`bun.lock` | P18.0 | 否 | 包的 `package.json` 没有 `dependencies`（断言）；编译器能写的键 ⊆ `ALL_PROFILE_ENV_KEYS ∪ COMPAT_KEYS`（断言）；每个预设编译出的补丁都过节点白名单；§3.4 的编译表逐格有用例，含 chat 线 `always` 在 `chatEffortHonorsOverride=false` 时返回 `effort-unsendable`、「没有更低档就拒绝」；拒收 `CLAUDE_CODE_USE_*`、`PATH`、`LD_PRELOAD`；在临时配置根上验证：`settings.json` 与 pending 是 0600，提交过程中的临时文件也是 0600（rename 之前截获断言），配置根不是 0700 时拒绝提交，首次备份只写一次，提交前哈希不符就放弃，崩溃后向前滚；用 `computeEffectiveProviderState` 实算「哪个 `modelSettings` 槽对主循环生效」，结论写回本文 §3.4；每条预设都带官网 URL 和核实日期（结构断言） | 32–48 |
| **P18.3** 节点热切换 | B1 | §2.7 | `packages/resident/src/supervisor.ts`、`src/services/qianmo/resident.ts`、`src/cli/handlers/resident.ts`、`src/cli/handlers/residentModelProbe.ts` 及其测试 | P18.2（提交接口） | 否 | 真 ACP 子进程用例：有在途 turn 时 pending 不提交，turn 结束后提交并换代，resident pid 不变；回收不计入快速失败（连续两次回收不会 park）；30 min 上限用 `ManualClock` 断言只告警不强杀；`sessions: reset` 之后下一次投递开新会话，`keep` 时续上并核对钉住的模型（结论写回本文 §2.7）；pid 文件的启动时间不符时不发信号 | 20–32 |
| **P18.4** 控制台外壳与 P0 基础 | B1 | A1、A5、C1、C3、C7、D1、D2、D7、H1、K1；路由表与各区域的桩文件；动作账本的端口接口（实现在 P15.9） | `packages/console/src/{http.ts,respond.ts,deps.ts}`；`packages/console/src/view/{page.ts,chatPage.ts,bits.ts,agents.ts,shell.ts}`（`shell.ts` 新建）；`packages/console/src/routes/**`（新）；`packages/console/src/assets/**`；`packages/console/test/**`（含 golden、`browser/**`）；`packages/console/README.md`；`docs/dev/console.md` | P18.0 | 否 | 每个 URL 都服务端渲染、无脚本可读（逐路由用例）；响应头带 `frame-ancestors 'none'` 和 `X-Frame-Options: DENY`，一次真实的 iframe 嵌入被拒（K1）；401 时出现失效模态且轮询停止（K1）；轮询刷新之后展开的行和焦点都还在（K1）；viewer 页面上不出现任何写控件（扫描断言）；侧栏计数口径正确；HTML 请求出错时返回 HTML 错误页；golden 按规程重生；控制台包仍然零第三方依赖 | 108–164 |
| **P18.5** 调用层第一批 · 止血 | B1 | hermes #3、#5、#6、#9、#11、#12、#15、#22；Q-1、Q-2；对等表的表头；`NOTICE` 第三方声明 | `src/services/qianmo/modelCompat/**`（新）；`packages/@ant/model-provider/src/shared/qianmo/**`（新）；`src/services/api/{errors.ts,retryClassification.ts,streamAssembly.ts}`；`src/services/api/openai/{index.ts,requestBody.ts,wireProtocol.ts,responsesAdapter.ts}`；`packages/@ant/model-provider/src/shared/openaiStreamAdapter.ts`；`src/utils/model/modelSupportOverrides.ts`；`NOTICE`；`docs/dev/base-modifications.md`；新增测试 | P18.0 | **是** | hermes §11.9 的实测在修复后翻转：①C 后到的名字生效，①D 两个调用不再合并；③ vLLM 和 LM Studio 的输出上限错误不再判成溢出，「Too many tokens, please wait」这类限流文案也不判溢出；④ 未知模型不发 `max_tokens`；`insufficient_quota` 判为 billing，不重试；chat 线在显式覆盖下发 `reasoning_effort`、`modelSupportsEffort` 为 false 时不发（对等表）；FABLE 档的能力覆盖生效；`api.openai.com` 未显式指定时走 Responses，显式 `OPENAI_WIRE_API=chat` 仍走 chat；新加的重试越过 commitment 屏障之后不再重放（用例）；§11.9-⑤ 那 147 条既有用例保持全绿 | 64–88 |
| P15.9（指针） | B1 | 控制台动作账本后端 | 以 `tenancy-m1.md` §6 为准。本批只许动 `packages/console/src/actionLedger.ts`（新）、`src/cli/handlers/consoleActionLedger.ts`（新）、`src/cli/handlers/console.ts`、`src/cli/handlers/consoleArgs.ts` | P15.5（已在 main）、P18.4 的端口接口 | 否 | 见 `tenancy-m1.md` §6；P18.6 合入后补「模型服务每类写动作各记一条」的用例 | 8–14（计入 P15，不计入本表合计） |
| **P18.6** 中枢存储与第六类动作 | B2 | 档案账本、密文库、主密钥、编译预览、执行器（local / ssh）、`ProviderPort` 的实现、节点脚本与内测接线 | `src/cli/handlers/consoleProviders*.ts`（新）；`src/cli/handlers/{console.ts,consoleArgs.ts}`；`packages/console/src/deps.ts`（`ProviderPort`）；`demo/env/beta/ops/model-apply.sh`（新）及其测试；`demo/env/beta/{common.sh,beta-up.sh,beta-reset.sh,README.md}`；`docs/dev/beta-env.md`（§8.3 新增持密面的行） | P18.2、P18.4、P15.9 | 否 | 密文库 0600、目录 0700；主密钥权限过宽时拒绝启动模型服务这一面；轮换之后旧密文从文件里消失（字节扫描）；主密钥缺失而密文存在时 fail-closed，且不重新生成；`providers.ndjson` 有坏行时页面拒绝服务；ssh 命令行不含密钥（argv 断言）；客户端命令是哨兵，强制命令缺失时操作失败；`model-apply.sh` 忽略 `SSH_ORIGINAL_COMMAND`，节点名不合法时拒绝；同一节点的两次 apply 串行；`StrictHostKeyChecking=yes` 且 known_hosts 缺条目时拒绝；`beta-reset.sh` 任何参数都不动主密钥（用例） | 40–64 |
| **P18.7** 节点侧 `qm provider` | B2 | `serve-stdin` / `status` / `probe` / `models` / `apply`；ACP spawn env 剥离；子进程清理 | `src/cli/handlers/provider*.ts`（新）；`src/entrypoints/cli.tsx`；`src/cli/program/commands/qianmo.tsx`；`src/services/qianmo/residentAcpEnv.ts`；`src/utils/process/subprocessEnv.ts` | P18.2、P18.3 | **是**（`cli.tsx` 一处快速路径；`subprocessEnv.ts` 名单加五项；由 P18.8 统一登记） | stdin 超过 64 KiB 时拒绝；错误码闭合集合逐个有用例；响应里不出现任何值（扫描断言）；托管节点的 ACP 子进程 env 里没有 `ALL_PROFILE_ENV_KEYS` 和 `CLAUDE_CODE_USE_*`（真子进程断言），未托管节点的行为与今天逐字节一致；Bash 工具的子进程看不到 `OPENAI_API_KEY`（真 ACP 用例）；probe 三态各有用例（录制桩：200 好 key、200 加错误体、400 坏 key、连接被拒）；`/v1` 纠正有用例；`call` 模式的临时配置根用完即删 | 24–40 |
| **P18.8** 调用层第二批 · 推理一致性 | B2 | hermes #4、#7、#8、#10、#13、#14、#23、#26；删除 `applyCompatRule` | 新规则文件；`packages/@ant/model-provider/src/shared/{openaiConvertMessages.ts,openaiStreamAdapter.ts,openaiUsage.ts}`；`src/services/api/openai/{requestBody.ts,responsesAdapter.ts}`；`src/services/api/grok/reasoning.ts`；`src/services/providerRegistry/providerCompatMatrix.ts` 及其测试；`docs/dev/base-modifications.md`（登记本批全部基座改动，含 P18.7 的两处） | P18.5 | **是** | hermes §11.9-① 的 A、B、E、F 翻转；回放家族表逐行有对等用例（严格端点不带 `reasoning_content`，kimi、deepseek、mimo 带）；内联标签被切在两个增量之间的用例；正文中夹空 `reasoning_content` 的既有用例仍绿（#31）；Kimi 不会同时发 `thinking` 和 `reasoning_effort`；换端点之后 `encrypted_content` 被丢弃；全仓 grep `applyCompatRule` 为空；节点 `capabilities.replayFilter` 为 true | 72–96 |
| P15.2 余下（指针） | B2 | 暂停、恢复、退役的后端 | 以 `tenancy-m1.md` §6 为准。本批不许动 `console.ts`、`consoleArgs.ts`、`deps.ts`（归 P18.6），确实要动时排到 P18.6 合入之后 | P15.1 | 否 | 见 `tenancy-m1.md` §6 | 8–16（计入 P15） |
| **P18.9** 模型服务页 | B3 | §6.3 全部 | `packages/console/src/routes/providers.ts`；`packages/console/src/view/providers*.ts`（新）；路由模块自带的样式与脚本片段；`packages/console/src/view/chatPage.ts`（模型标签、分隔线） | P18.4、P18.6、P18.7 | 否 | AC-P1（端到端：录制桩 + 真 resident）；AC-P3；AC-P4 的界面一侧（显示值取自节点 `effective`，结构断言中枢不自己算）；无脚本时只读可用，写控件写明原因；viewer、member、break-glass、legacy 四种主体都看不到写控件和指纹（扫描断言）；所有可见文案过禁句读门禁；导出文件不含 key 和指纹；导入出现未知键时整份拒绝 | 56–88 |
| **P18.10** 账号与访问 · 操作记录页 | B3 | H3、H4 的页面 | `packages/console/src/routes/access.ts`；`packages/console/src/view/{access.ts,invite.ts}`（`access.ts` 新建）；`packages/console/src/{accountsHttp.ts,access.ts}`；`docs/dev/beta-env.md` §3.6（告知措辞需要改时） | P18.4、P15.9 | 否 | 成员、邀请、会话、操作记录四个页签各有 HTTP 用例；强制下线之后该主体的 SSE 连接数为零；member 只看得到与自己有关的操作记录；邀请页 `Referrer-Policy: no-referrer`（断言） | 48–72 |
| **P18.11** 审计列表 · 生命周期 · 节点详情 | B3 | D5、J2 的页面、A3 | `packages/console/src/routes/{audit.ts,nodes.ts}`；`packages/console/src/view/{audit.ts,agents.ts,node.ts}`（`node.ts` 新建）；`packages/console/src/deps.ts`（`AuditPort` 游标）；`src/cli/handlers/consolePorts.ts`；`packages/audit` 的只读查询；`docs/dev/console.md`；`packages/console/README.md` | P18.4、P15.2 余下 | 否 | 10 万条审计下首屏响应时间有上界（基准用例记数）；游标分页无重复、无遗漏；生命周期四个动作都走二次确认并进动作账本；节点详情的「模型」页签显示 §2.4 的全部字段；`console.md` 路由表与实际路由一致（扫描断言） | 56–80 |
| **P18.12** 调用层第三批 · 韧性 | B3 | hermes #1、#16–#21、#24、#25、#27、#33 | 新规则文件；`src/services/api/{streamAssembly.ts,retryClassification.ts}`；`src/services/api/openai/{retry.ts,index.ts}`；`packages/@ant/model-provider/src/shared/{openaiStreamAdapter.ts,openaiConvertMessages.ts,openaiConvertTools.ts}`；`src/services/api/{gemini,grok}/index.ts`（如需）；`src/query.ts`；`tests/preload.ts`；`tests/support/**`（新）；`docs/dev/base-modifications.md` | P18.8 | **是** | 第三方线路配了 `fallbackModels` 时，5xx 重试用尽会切到 fallback（以前从不发生），切换前回放已过滤；常驻会话的 `Retry-After` 上限 600 s、交互式 60 s，各一条用例；chat 流空闲超时会触发；DeepInfra 形状的错误块不重试；工具结果图片被拒之后降级并记住；思考耗尽时不续写；preload 之后，开发机带订阅登录态时 `codexPinnedSearch` 不再红；逐厂商对等表覆盖目录里的全部预设 | 88–112 |
| **P18.13** 迁移与真机验收 | B4 | §2.9 迁移；AC-P6 | `demo/env/beta/**` 的 runbook 与验收脚本；`docs/dev/beta-env.md`；本文回写 v1.1 | P18.3、P18.6、P18.7、P18.9、P18.5、P18.18；主 agent 打的发行标签（D-7） | 否 | 同一份部署连续两轮零红并留档（§8.4）；至少一个预设的 `evaluated` 改为非 false，并附证据 | 16–32 |
| **P18.14** 控制台 P1 收口 | B4 | §6.5 的 P1 两组 | `packages/console/src/**` 里路由文件以外的视图与 assets；`src/cli/handlers/consolePorts.ts` 的错误映射 | P18.4（建议排在 B3 之后，减少 golden 往返） | 否 | `console-audit.md` §4 各项的「改法」逐条有用例；I1 与 C5 在同一个提交里；亮色和暗色对比度都达 AA（K1 计算）；375 px 宽可以读状态、可以发对话（K1） | 144–216 |
| **P18.15** 告警与值守作业页 | B5 | J5、J6 | `packages/console/src/routes/{alerts.ts,jobs.ts}`；`NotifyPort`、`SchedulerPort`（`deps.ts`、`consolePorts.ts`） | P18.4 | 否 | 告警有收件箱、未读角标、级别筛选；值守作业页显示上次和下次触发、ESTOP 状态，`lastTickAt` 缺席可见 | 48–64 |
| **P18.16** 用量与审批页（条件） | B5 | J7、J8 | `packages/console/src/routes/{usage.ts,approvals.ts}`；`deps.ts` | P15.7、P14.5 | 否 | 用量按自然日、按人；审批页与 P14 协议的契约用例 | 48–80 |
| **P18.17** 控制台 P2 | B5 | §6.5 的 P2 | 视图与样式 | P18.14 | 否 | 各项「改法」逐条有用例 | 110–150 |
| **P18.18** 多 key 轮换（D-6） | B4 | hermes #2：同一份档案挂 1..N 把 key，节点调用层按策略选取、按错误分类换 key 并冷却；中枢逐把加密保管；控制台逐把管理、显示每把的状态 | `packages/providers/**`（池字段；P18.2 已经按多 key 定好 schema）；`src/services/qianmo/providers/**`；`src/services/qianmo/modelCompat/credentialPool*.ts`（新）；`src/services/api/openai/{retry.ts,index.ts}`、`src/services/api/retryClassification.ts`；`src/cli/handlers/consoleProviders*.ts`；`src/cli/handlers/provider*.ts`；`packages/console/src/routes/providers.ts`、`packages/console/src/view/providers*.ts`；`docs/dev/base-modifications.md` | P18.6、P18.7、P18.9、P18.12 | **是**（三个调用层文件，纯插入） | 单 key 档案的编译、写入、请求行为与 P18.12 合入时逐字节一致（回归用例）；`fill_first`、`round_robin`、`least_used` 三种策略各有用例；hermes 行为表逐行有录制桩用例：429 先同 key 重试一次再换，用量上限立即换，402 立即换并冷却 1 h，401 换并冷却 5 min，`Retry-After` / `reset_at` 优先；全部 key 都在冷却时报错，并给出最早的恢复时间；换 key 越过 commitment 屏障之后不再重放；冷却状态持久化在节点 0600 文件里，重启后仍然有效；节点 `status` 逐把报 `ok / cooling / dead`，只带 key id，不带值；轮换或删除单把 key 之后，旧密文从密文库消失（字节扫描）；AC-P2 的金丝雀扫描覆盖多 key 流程。真机只有一把真 key（D-5），轮换只用录制桩验证，P18.13 不要求真机轮换 | 24–40 |

### 9.3 同批文件范围（互不相交）

- **B1**：`bun.lock` 只归 P18.2；`NOTICE` 与 `base-modifications.md` 只归 P18.5；`packages/console/**` 只归 P18.4；`console.ts`、`consoleArgs.ts` 只归 P15.9；resident 四个文件只归 P18.3。P18.5 与 P18.2 不共享文件（编译器在 `src/services/qianmo/providers/`，规则表在 `src/services/qianmo/modelCompat/`）。
- **B2**：`console.ts`、`consoleArgs.ts`、`deps.ts`、`demo/env/beta/**`、`beta-env.md` 归 P18.6；`cli.tsx`、`qianmo.tsx`、`residentAcpEnv.ts`、`subprocessEnv.ts` 归 P18.7；模型调用层文件与 `base-modifications.md` 归 P18.8；P15.2 余下避开前面这些文件。
- **B3**：每个页面包只改自己的路由文件和视图文件（P18.4 已经建好桩）；`deps.ts`、`consolePorts.ts`、`console.md`、`README.md` 只归 P18.11；`chatPage.ts` 只归 P18.9；`beta-env.md` 只归 P18.10；调用层文件归 P18.12。
- **B4**：`packages/console/src/routes/providers.ts`、`view/providers*.ts`、调用层三个文件和 `base-modifications.md` 归 P18.18，P18.14 避开这几个文件；P18.13 只动 `demo/env/beta/**` 和文档。
- **不算冲突的生成物**：`legacyParity.golden.json` 由合入者在 rebase 之后按规程重生（§8.1）。
- 同一批里两个包都要改同一个文件时，按本节的归属裁决；另一个包把要改的内容写在 PR 描述里，由归属包代改，或者排到下一批。

### 9.4 合计

| 范围 | 人时 |
|---|---|
| 核心：P18.0–P18.13 与 P18.18（M1 出口相关） | **656–970** |
| 其中调用层三批（P18.5、P18.8、P18.12） | 224–296 |
| 其中控制台 P0 与模型服务页（P18.4、P18.9、P18.10、P18.11） | 268–404 |
| 控制台 P1、P2 与条件页（P18.14–P18.17） | 350–510 |
| 其中多 key 轮换（P18.18，D-6） | 24–40 |
| **全部** | **1006–1480** |
| 指针包（计入 P15，不计入上面各行） | P15.9 8–14；P15.2 余下 8–16 |

估算按「主开发 + AI 协作」口径。调研件自陈的误差是 ±50%（hermes §11.10 第 9 条），本表沿用这个量级，没有再细拆到文件级。

---

## §10 放弃的备选方案

| 备选 | 结论 | 原因 |
|---|---|---|
| 中枢不持有密钥，只生成「下发包」，由人到节点上执行 apply（matrix §12 D1 不批时的退路） | 否 | 负责人 D-2 决定中枢持有。这条做不到「像 CC Switch 一样一键切换」 |
| 控制台集中存密钥并**代理**模型调用 | 否 | 中枢不跑 agent 轮次；代理会让所有对话流量过 H，延迟和单点都会加重；也会引入一层本地代理（§0.5） |
| 从注册中心读节点的模型信息 | 否 | 注册中心的读路由零鉴权，可以被投毒（TH-14）；实际状态必须经已认证的链路由节点自报 |
| 页面上只打出一条 CLI 命令，让人到节点上去改 | 只作为应急 runbook | 做不到「内测用户无需接触 CLI」，不算商业级 |
| resident 每次 spawn 前重读 `model-env` | 否 | 要用 TS 解析 shell 片段，和 bash 的 `.` 语义必然有分歧（matrix §4.5） |
| 只写 `settings.json`，不回收子进程 | 否 | 同一子进程里的会话会一起串线（matrix §4.4） |
| 一阶段写入：`apply` 直接改 `settings.json` | 否 | 回收之前的新会话会把新 env 带进整个旧进程（R-5） |
| 用 `unstable_setSessionModel` 按会话换模型 | 否 | 只能换模型，换不了 key 和 URL |
| `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`，由宿主显式传 env | 暂缓，作为第二步加固 | 隔离性最好，但它的名单漏了 `OPENAI_WIRE_API`，也挡不住 `modelType`，要补基座名单（matrix §4.5） |
| 第六类动作复用隧道或镜像那把 key | 否 | `authorized_keys` 里同一把公钥只有第一行的选项生效，强制命令只能有一个 |
| 第六类动作改走一条新的签名控制消息（经节点链路而不是 SSH） | 否 | 节点不拨号、不监听控制面；新消息类型要改协议（P13.2 量级的代价）；闭合不再由节点的 sshd 强制，H 失陷后的那道缓解就没了 |
| 复用 H 上的 OpenBao | 否 | §1.3 O-5 |
| 显示 key 的末 4 位（CC Switch、hermes B9 的做法） | 否 | 对账用指纹就够了；末几位是真实的密钥材料 |
| 用 `fs.watchFile` 监听 pending | 否 | Linux 上它首个 stat 之前的改动会被当成基线（项目里已经踩过）；改用 stat 轮询加 SIGHUP |
| 前端改成 SPA，或者引入前端框架 | 否 | D-1 |
| 移植 hermes desktop 的设置页组件 | 否 | 只借形；控制台已经定案「不移植那 10.6k 行 React」 |
| 把内部规范形从 Anthropic 改成 OpenAI chat | 否 | 阡陌的 Anthropic 线是无损的主路径（hermes §11.12） |
| 照 hermes 引入 `ProviderProfile` 类层级加插件发现 | 暂缓 | 一个进程只服务一家；需要的只是几张表加少量钩子 |
| 用 LiteLLM 之类的库替换转换层 | 否 | 会和现有转换层叠成两层，还要引入外部依赖 |
| 录制真实流量做 VCR 夹具 | 本阶段否 | 用构造夹具并注明出处代替；真实调用只做 opt-in |
| 整份导入 CC Switch 的预设表 | 否 | 一大半是中转站；整份编排是作者的作品；带推广参数 |
| 套餐 key 默认隐藏或拦截 | 否 | D-3 |
| 多 key 池的 `random` 策略 | 否 | 不可复现，测试难以断言（§0.5） |
| 按会话选模型（hermes B11 的 session 作用域） | 暂缓 | v1 只做节点级；以后可以在不换 provider 的前提下用 `unstable_setSessionModel` 做 |
| 价格展示与「贵模型确认」（hermes B13） | 否 | N-1；价格变化快，目录里不存价格 |

---

## §11 存疑与未验证

1. **所有预设都没有用真 key 验证过**。调研件的「实测」只是用空 key 或无效 key 探路由和错误体形状；本文的预设表是官网文档的整理，不是兼容性证据。
2. **OpenAI 各模型可用的 effort 档位**：舰队上 `gpt-6-luna` 的请求体里确实发了 `max`（负责人抓包），但服务端是否按 `max` 执行，没有证据。OpenAI 预设各模型的 `levels` 在录入时要逐个对照官网。
3. **哪个 `modelSettings` 槽对主循环模型生效**：P18.2 已实算，结论见 §3.4。新会话读 `default`，切到别的模型后读该模型所占的档位。实算调用的是节点自己的函数，没有起真的 ACP 子进程。`session/set_model` 之后读哪个槽，是按 `QueryEngine` 用的同一个函数（`getMainLoopModelSettingsSlot`）推出来的，没有在真会话里核对。
4. **会话续上之后钉住的模型**：matrix §4.5 说是新 provider 的默认模型，除非用户显式选过；需要 P18.3 用真 ACP 子进程验证（§2.7）。
5. **hermes §11 里所有「某厂商会 400」的结论**都来自 hermes 或阡陌的代码注释，不是实测（§5.10）。
6. **从 hermes 转引的阡陌行号**按 `e123b2ec`，没有在 `33dc81bf` 上逐条复核。本文自己引用的行号已复核（附 B）。
7. **Azure 的鉴权写法**、**MiMo Token Plan 的 Anthropic 路径**、**方舟和千帆套餐的 key 前缀**，调研件都没有核实（§4.2、§4.3）。
8. **pid 文件的启动时间核对**依赖 Linux 的 `/proc/<pid>/stat`；macOS 开发机上退化为只靠轮询，功能不受影响。
9. **Windows 节点**不在本文范围：0600 的语义在 Windows 上不成立（CC Switch 也有这个问题）。内测舰队全是 Linux。
10. **中枢同机节点的隔离**依赖 P14.9（hardline 覆盖中枢机上全部秘密路径），P14.9 还没实现。
11. **roadmap「M1 完成状态速查」的「注册发现产品化」行**仍写着 P15.3 / P15.5「未实现」，但 `21b2dd3f`（P15.3）、`fb2ca677`（P15.5）、`d74e0c9f`（P15.8）已经在 main 里。本文按任务约束不改那一行，只在 roadmap v2.80 的版本行里记下这个出入，由下一次状态回写处理。
12. **估算**是读代码和调研件之后给的，误差可能在 ±50%。
13. **多 key 轮换没有真机证据**：负责人只提供一把真 key（D-5），P18.18 的轮换行为只用录制桩验证。

---

## §12 遗留风险

- **H 的单点扩大**（§7.7）：多了全部模型密钥，以及改写节点模型服务的能力。信封加密防不住 H 失陷。
- **节点上的 agent 能读到密钥**：agent 和密钥在同一个用户、同一棵进程树里。P18.7 的 env 剥离和子进程清理只挡住 shell 展开这一条最常见的路。
- **切换可能迟迟不生效**：值守作业的长 turn 会让回收一直等；到 30 min 只告警，不强杀。
- **「三种思考方言一起发」改成按端点选键之后**，原来碰巧能用的组合可能变成什么都不发（hermes §11.11），需要逐家回归。
- **#3 的回退风险**：未知模型不发 `max_tokens` 之后，有些端点不传上限时默认值很小，思考会把预算吃光。所以 #3 和 #5 同批，并给 Claude、MiniMax、Qwen3 名字的模型补发。
- **规则表会过期**：hermes 记录的是 2026-08 的状态，目录记录的是 2026-10-03 的官网。建议每月核一次官网，下线表要有人维护。
- **基座改动面变大**：§5.8 列了 22 个基座文件。用纯插入、调用替换的形态减少上游同步冲突；每个文件都在 `base-modifications.md` 登记。
- **golden 的往返**：B3 三个页面包同批，golden 由合入者重生，合入顺序要事先排好。
- **登录方式迁移**：中枢开 `--accounts` 会改变内测用户的登录方式，需要按 `beta-env.md` §3.6 告知，并给共享 token 留迁移期。
- **套餐 key 的条款风险**由使用者自己判断，但厂商封禁 key 的后果会落在节点可用性上。
- **`authorized_keys` 那一行被改写**：哨兵命令让它变成显式失败，但定期巡检仍然要做（同 `beta-env.md` §8.3 对镜像那一行的要求）。
- **对外表述**：在 §8.4 的真 key 冒烟通过之前，任何预设都不能写成「已兼容」。

---

## §13 负责人拍板（v1.0 的四个待决点，2026-10-03 已全部拍板）

v1.0 写成时这四点待定，负责人当天拍板，结果记为 §0.1 的 D-4 ~ D-7。

| # | 问题 | 拍板结果 | 对本文的影响 |
|---|---|---|---|
| 1 | 第六类动作要不要 provision token。这碰到了 2026-08-18 定案 ③「装机类动作要单独一枚 provision token」的适用范围 | **不要**。要求个人账号的 ops 角色，由动作账本记录操作者（D-4） | 无。R-13、O-3 按原文执行 |
| 2 | **真 key 与花费**：AC-P6 需要真 key；`call` 模式每次花一次最小调用；其他预设要评估，也需要对应厂商的 key | **只用舰队现有的 `gpt-6-luna` 凭据**（D-5） | AC-P6 用这份凭据。P18.13「至少一个预设评估通过」只能落在它对应的那条：OpenAI 兼容自定义网关，走 Responses（§4.4）。其他预设保持「未评估」，对外不写「已兼容」 |
| 3 | **hermes #2 多 key 轮换**是否进入 M1 | **进 M1**（D-6） | 新增 P18.18（B4，24–40 人时）；§0.5、§5.6、§9、§10、§11 已同步。P18.2 的 schema 一开始就按多 key 定 |
| 4 | **发版**：真机验收需要一个包含 P18 的发行标签 | **预先授权**，由主 agent 发版并部署（D-7） | P18.13 不再等批准；仍然只部署发行标签，不部署 main |

---

## 附 A：出处索引

| 内容 | 出处 |
|---|---|
| 运行时选路、激活变量、热切换的三个问题与最小改法、`gpt-6-luna` 能力回退实测 | `atlas-provider-matrix.md` §1、§4.4、§4.5、§10 |
| 控制台差距 A1–K2、P0 / P1 / P2 估算、目标信息架构、模型服务页的位置 | `console-audit.md` §4、§5、§6、§9 |
| 字段所有权、事务化写入、冲突检测、期望与实际、只写不读、不照搬清单 | `ccswitch-research.md` §5、§6、§7、§9 |
| 各厂商端点、线路、鉴权、key 前缀、验 key 请求、已知坑、套餐条款 | `vendors-research.md` §1、§6（各条附官网 URL） |
| 调用层 33 项差异、三批、规则表、实测、存疑、风险 | `hermes-research.md` §11（基线 hermes `f9b29c49b6`、阡陌 `e123b2ec`） |
| 借鉴项 B1–B17 | `hermes-research.md` §10.1 |
| 信封加密、OpenBao 评估、受限 key、provision token | `node-provisioning.md` §3.3、§3.4、§5.1、§8 |
| 持密面表 | `beta-env.md` §8.3 |
| 账号、角色、break-glass、动作账本、生命周期 | `tenancy-m1.md` §3.2、§3.4、§6 |

## 附 B：本文在 `33dc81bf` 上复核过的代码事实

| 事实 | 位置 |
|---|---|
| Responses 线按 `modelSupportsEffort(openaiModel)` 决定发不发 effort | `src/services/api/openai/index.ts:350` |
| chat 线只对 `isChatGPTCodexReasoningModel(openaiModel)` 发 `reasoningEffort` | `src/services/api/openai/index.ts:499-506` |
| `modelSupportsEffort` 先看 `CLAUDE_CODE_ALWAYS_ENABLE_EFFORT`，再看能力覆盖 | `src/utils/model/effort.ts:51`、`:60`、`:63` |
| max / xhigh 档不按能力往下夹（「API errors are the user's responsibility」） | `src/utils/model/effort.ts:131-147` |
| Anthropic 线按 `modelSupportsEffort` 门控 | `src/services/api/claude.ts:471` |
| 能力覆盖只读 OPUS / SONNET / HAIKU 三档，按线路选前缀；列表存在但不含某项即为 false | `src/utils/model/modelSupportOverrides.ts:3-75` |
| `PROFILE_ENV_KEYS` 含四档（含 FABLE）的 `_SUPPORTED_CAPABILITIES`；`ALL_PROFILE_ENV_KEYS` 是去重并集 | `src/services/providerProfiles/envKeys.ts:57`、`:138` |
| 档案激活：受管键先置为删除再覆盖；`modelSettings` 五槽整体重写 | `src/services/providerProfiles/profiles.ts:387`、`:426` |
| `modelSettings` 槽位 `default/haiku/sonnet/opus/fable`，`effort` 枚举含 `max`；`CLAUDE_CODE_EFFORT_LEVEL` 优先 | `src/utils/settings/types.ts:288-306`、`:1030-1045` |
| `isCodexFamilyModel` 只匹配 `codex` 与 `gpt-5(.x)`；`src` 中搜不到 `gpt-6` | `src/utils/model/chatgptModels.ts:140-144` |
| MiMo 预设用的是下线 id | `src/utils/model/chinaLlmProviders.ts:246-308` |
| 原生 Gemini 线回放并捕获 `thoughtSignature` | `packages/@ant/model-provider/src/providers/gemini/convertMessages.ts:206-244`、`streamAdapter.ts:105` |
| 基座 settings 写入是 tmp + rename；已有文件时临时文件按 umask 创建、写完才 chmod 成原权限 | `src/utils/filesystem/file.ts:362`、`:405-436`（`writeFileSyncAndFlush_DEPRECATED`）；`src/utils/settings/settings.ts:420` |
| 子进程清理名单不含 `OPENAI_API_KEY` 等五项，且只在 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` 打开时生效 | `src/utils/process/subprocessEnv.ts:15-53`、`:86` |
| `occConfigPath` 定义；控制台路径约定 | `src/config/paths.ts:157`；`src/cli/handlers/consoleArgs.ts:190-235` |
| `DOCUMENT_HEADERS` 没有 CSP、`frame-ancestors`、XFO；CSP 只在 `<meta>` 里 | `packages/console/src/respond.ts:30`；`packages/console/src/view/page.ts:171`、`:758` |
| 角色 `viewer / member / ops`；`x-qianmo-console` 头；cookie `HttpOnly; SameSite=Strict` | `packages/console/src/accounts.ts:160`；`packages/console/src/auth.ts:123`；`packages/console/src/access.ts:344` |
| 控制台哈希链账本的严格读 | `packages/console/src/ledger.ts` 文件头注释 |
| `ResidentSupervisor`；resident 的 SIGTERM / SIGINT；`warnMissingModelCredentials` | `packages/resident/src/supervisor.ts:45`；`src/cli/handlers/resident.ts:1949-1950`、`:1229` |
| 基座目录里已有阡陌自有（AGPL 头）文件 | `packages/@ant/model-provider/src/shared/__tests__/emptyModelResponse.test.ts` |
| 内测节点配置根 | `demo/env/beta/common.sh:1221`（`OCC_CONFIG_DIR=${root}/nodes/${node}/config`） |
| P15.3、P15.5、P15.8 已在 main | `21b2dd3f`、`fb2ca677`、`d74e0c9f` |
