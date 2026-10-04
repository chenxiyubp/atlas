<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 边界用例库 v1（P5.4）

这个目录只放一种东西：**五类边界问题的自动化用例**，每条都指向 `docs/dev/protocol.md`
§8.3 那张表里的具体一行。

## 为什么单独一个目录，而不是散在各包里

散在各包里的边界用例有两个问题，都在别处踩过：

1. **看不出覆盖了哪几类。**§8.3 把边界问题分成五类，而「这一类有没有用例」是个要能
   一眼回答的问题——章程 AC-8 的判据就是拿它来问的。散在十几个 `__tests__` 里，回答
   这个问题要靠人去数。
2. **它们跨包。**一条真实的边界往往横跨协议、传输、路由、协商四个包（例如「消息风暴」
   同时压着两层限流与判环），放进任何一个包的用例集都不合适。

所以这里的用例**只做组合**，不重复各包内部已经证明过的细节：包内用例证明零件对，
这里证明**边界发生时，装在一起的东西表现对**。

## 五类与它们的 §8.3 出处

| 类 | §8.3 里的行 | 这里的文件 |
|---|---|---|
| ① 触发时机 | 目标休眠需唤醒 / 刚解冻时全部截止时间同时越阈 | `trigger-timing.test.ts` |
| ② 超时 | 投递时限三处判定 / 任务时限 / 报价时限 | `timeouts.test.ts` |
| ③ 消息风暴 | 单发送方入站洪水 / 单发送方对单目标高频 / A→B→A 回环 | `message-storm.test.ts` |
| ④ 额度耗尽 | `costLimit ≠ 0` / 协议层入站预算 / 贷方满员 | `quota-exhaustion.test.ts` |
| ⑤ 异常退出 | 发送方 `sent` 后崩溃 / 接收方处理中抛错 / 借方隧道中途消失 / 接收方在回复上线、回执未归时停机 | `abnormal-exit.test.ts`（组件层）、`abnormal-exit-resident.test.ts`（整台常驻节点） |

**v2 追加（P7.1）**：`chaos-recovery.test.ts` —— 四类混沌注入（杀进程 / 断网 / 打满磁盘 /
拨动时钟）的**确定性对应物**。它不属于上面五类中的某一类，因为每类注入都横跨几类边界；
它的位置是**混沌跑批与 CI 之间的桥**：

| | `demo/chaos-inject.sh` | `chaos-recovery.test.ts` |
|---|---|---|
| 找**没想到**的组合 | ✅ 一小时随机 | ✗ |
| 防**已知**失效回归 | ✗（跑一小时才碰一次） | ✅ 每次提交 |
| 能复现 | 靠 `--seed` | 本来就确定 |

## 规矩

- **一条用例只测一个边界**，并在注释里写清它对应 §8.3 的哪一行。看不出对应关系的用例
  不属于这里。
- **修边界 bug 的 PR 必须先在这里加一条会红的用例**（PR 模板的必填项就是问这个）。
- **进 CI**：`scripts/test-shards.sh` 的分片列表里有 `tests/boundary`。加新目录时别忘了
  它——不在列表里的测试目录在 CI 里根本不会跑，而本地 `bun test` 会跑，于是「本地绿、
  CI 也绿」会同时成立且都没有意义。
- **混沌跑批发现的失败**，处置见 [`docs/dev/boundary-day.md`](../../docs/dev/boundary-day.md)：
  先复现（记 seed），再决定它是新边界还是缺陷。**不要**为了让报告变绿，顺手往混沌那边的
  `KNOWN_BOUNDARIES` 里加一行——那张表是「我们理解并接受的失败」，往里加等于宣称理解了它。
- **修掉一个内测期缺陷，就在下面的追踪表里加一行**，写明它钉在哪条用例上；没有用例就如实写
  「无用例」，别空着。

## 内测期缺陷追踪（2026-08-17 起，盘点于 2026-09-26）

roadmap M1「边界用例库」的出口判据之一是「内测期新增缺陷 80% 有对应用例」。这张表回答
那个问题：每行一个缺陷，写它属于五类中的哪一类（多数不属于），以及仓库里哪条用例钉住它。

**收录口径。**来源四处：已关闭的 GitHub issue、2026-08-17 起的 `fix` 提交、roadmap 变更
记录 v2.43–v2.71 里点名的「真缺陷 / 缺陷 / 隐患」、`docs/dev/validation-report-20260908.md`
的 B-1 / C-1。只收**已落地代码**在产品（`src/`、`packages/`、构建、`demo/env` 部署脚本）或
验收套件（`demo/lib/acceptance`）里的行为缺陷；同一缺陷的多笔提交并成一行。

**「钉住」的判据。**用例要能在修复前变红：逐条读过修复提交（或同一 PR）的 diff，确认用例是
随修复一起加的、或随修复改了断言；本目录新补的两条另在修复提交的父提交上实跑过。只断言
「是个字符串」这类钉不住的，算无用例。

### 表

路径相对仓库根。「类」一栏写五类中的哪一类及 §8.3 的行；不属于五类的写「—」。

| 缺陷 | 类 | 钉住它的用例 | 状态 |
|---|---|---|---|
| #7 CA 化节点与纯 `--trust` 节点握手失败 | — | `packages/transport/test/signed-handshake.test.ts:720` | 已修 `43db2c0d`，用例随修复加 |
| #9 审计镜像链路失败，控制台把缺失的链显示成完整 | — | `packages/console/test/view.test.ts:1017`；`demo/env/beta/ops/mirror-pull.test.ts:265` | 已修 `57de76cc` `eed5792d`，随修复加 |
| #10 部署静默把舰队从 open policy 翻成要求任务签名 | — | `src/cli/handlers/__tests__/resident.test.ts:442`；`demo/env/resident-task-policy.test.ts:137` | 已修 `bf15a64f`，随修复加 |
| #12 握手层的安全拒绝不进审计链 | — | `src/services/qianmo/__tests__/auditTrail.test.ts:333` | 已修 `113e7395`，随修复加 |
| #13 节点的 model-env 从未加载 | — | `demo/env/beta/beta-model-env.test.ts:279` | 已修 `6dc9d4b1`，随修复加 |
| #14 控制台唤醒不签发 capability | — | `src/cli/handlers/__tests__/consoleWakeCapability.test.ts:122` | 已修 `dd51e191`，同 PR `05d6ca4a` 加 |
| #15 macOS 构建内联纯 JS `ws`，Bun 下握手必失败 | — | 无 | 已修 `28d7cb26`，**无用例** |
| #17 节点名校验受 locale 影响，大写能绕过 | — | `demo/env/beta/beta-wake-psk.test.ts:145` | 已修 `47f79851`，随修复加 |
| #28 跨节点消息被钉死为 untrusted，唤醒后 agent 一律拒绝 | — | `packages/adapter/test/inbound.test.ts:177`；`src/services/qianmo/__tests__/resident.integration.test.ts:2148` | 已修 `bff11ad8` 等，随修复加 |
| #29 控制台把策略拒绝显示成不可达 | — | `src/cli/handlers/__tests__/consoleWakeRefusal.test.ts:102` | 已修 `846cab07` `d2f49b00`，随修复加 |
| #30 resident stderr 带出整块 minified 源码 | — | `src/cli/handlers/__tests__/resident.test.ts:882` | 已修 `bfde4785`，随修复加 |
| #34 投递层拒绝的 wake 不回 error 信封 | ① 唤醒失败 | `src/services/qianmo/__tests__/resident.integration.test.ts:1619` | 已修 `6d5a99d7`，随修复加（提交说明记了改前红在哪行） |
| #37 凭据只验「可见」不验「可用」，失效 key 静默挂 120 s | — | `src/cli/handlers/__tests__/residentModelProbe.test.ts:365`；`packages/resident/test/inactivity.test.ts:222` | 已修 `317a92c3` 等四笔，随修复加 |
| #39 常驻看门狗超时被记成「用户中断」 | ② 任务时限到期 | `packages/resident/test/acp-turn.test.ts:204`；`src/utils/__tests__/inactivityAbortMarker.test.ts:43` | 已修 `7f68813c`，随修复加 |
| #40 `beta_start_process` 无条件报已启动 | — | `demo/env/beta/beta-start-process.test.ts:121` | 已修 `6b30684d`，随修复加 |
| #44 多 agent 节点工作区串用、transcript 混写 | — | `src/services/acp/agent/__tests__/workspaceIsolation.test.ts:167` | 已修 `24af7a54`，随修复加 |
| #46 postinstall 只下当前架构的 ripgrep | — | `scripts/__tests__/postinstall.test.ts:209` | 已修 `a3a0ef24`，随修复加 |
| #49 变量紧跟全角标点，bash 3.2 下 unbound | — | `demo/env/shell-fullwidth-expansion.test.ts:91` | 已修 `c526d8c2`，随修复加 |
| #52 ACP 会话全局量不可重入，并发轮次互相改写 | — | `src/services/acp/agent/__tests__/concurrentTurns.test.ts:196` | 已修 `f10b84d0`，同 PR `1d2b8770` 加 |
| #53 `--trust` 同名异值 last-write-wins | — | `packages/capability/test/token.test.ts:306` | 已修 `c4a42ffc`，随修复加 |
| #60 `console.conf` 的陈旧 LABEL 静默存活 | — | `demo/env/beta/beta-console-label.test.ts:165` | 已修 `da774688`，随修复加 |
| #64 systemd 单元状态与进程存活脱节 | — | `demo/env/beta/beta-unit-liveness.test.ts:65` | 已修 `6bce005a`，随修复加 |
| #68 `session/list` 拿到别的 session 轮次的 cwd | — | `src/services/acp/__tests__/agent.test.ts:1643` | 已修 `e5bc0ba7`，随修复加 |
| #70 产物无来源标记，报告盖的是套件那侧的 commit | — | `scripts/__tests__/defines.test.ts:148`；`demo/lib/acceptance/__tests__/report-core.test.ts:601` | 已修 `2c2a844a` `dc254602` `defefe6b` 等，随修复加 |
| #75 `typeof MACRO` 守卫在产物里恒假，四处 define 丢失 | — | `scripts/__tests__/checkMacroGuards.test.ts:16`（门禁 `check:macro-guards`）；`src/constants/__tests__/buildProvenance.test.ts:66` | 已修 `28b012f6`，随修复加 |
| #79 ACP 握手报开发占位版本 `2.1.888` | — | 无（`agent.test.ts:301` 只断言是字符串，钉不住） | 已修 `64943513`，**无用例** |
| #81 `cli.tsx` 手抄的 MACRO 兜底漂移 | — | `tests/integration/raw-source-macro-defines.test.ts:228` | 已修 `9702a177`，同 PR `b55eda43` 加 |
| #83 SSHDeploy 的 dev 回退把 `cli.tsx` 当二进制发出去 | — | 无 | 已修 `06d7b327`，**无用例** |
| #111 节点重启静默丢掉启动时的透传参数 | — | `demo/env/beta/beta-up-args.test.ts:484` | 已修 `ccc6cc86` `0dad3f95`，随修复加 |
| `64451a7e` resident 选项空值：`--port=` 被解析成 0 | — | `src/cli/handlers/__tests__/resident.test.ts:743` | 已修，随修复加 |
| `c628ff0d` 网关省掉 `choices` 的终态 usage chunk 抛 TypeError | — | 无（既有用例只覆盖 `choices: []`） | 已修，**无用例** |
| `5c96d0b8` 注册中心续租吞掉端点变更 | — | `demo/lib/p81-announce-core.test.ts:65` | 已修，随修复加 |
| `9b8cbf58` 拆机时在途回复的回执被拒成「closed before receipt」 | ⑤ 接收方在 delivered 后崩溃（拆机那一半） | `tests/boundary/abnormal-exit-resident.test.ts:82`；另 `src/services/qianmo/__tests__/resident.integration.test.ts:271`（概率性，CI 慢机偶发红，本机打不红） | 已修；本目录用例本次补，修复父提交上 5/5 红 |
| `c7567476` `--version` 快路径让阡陌节点自称 Open Claude Code | — | 无 | 已修，**无用例** |
| `d0e59d08` ① 同一节点有显式 `--trust` 又有 CA 证书时握手必败 | — | `packages/transport/test/handshake-signing.test.ts:297` | 已修，随修复加 |
| `d0e59d08` ② 注册中心不可达时 fail-shut，拒掉 `--trust` 名单上的证书型对端 | — | `src/services/qianmo/__tests__/certificateDirectory.test.ts:1270` | 已修，随修复加 |
| `d0e59d08` `6d55bfa1` ③ 保留通道不按认证身份绑定，别的身份可继承未回执的 payload | — | `packages/transport/test/retained-channel-auth.test.ts:348` | 已修，随修复加 |
| `d0e59d08` ④ 缺 `proofCredential` 时静默跳过第二证明 | — | `packages/transport/test/retained-channel-auth.test.ts:1347` | 已修，随修复加 |
| `d0e59d08` ④ 客户端致命关闭不关 outbox，挂着的等待只能等满自身时限 | ① 唤醒失败 / 目标不可达（重连预算耗尽那条路径） | `tests/boundary/trigger-timing.test.ts:192`；另 `packages/transport/test/retained-channel-auth.test.ts:1158`（4003）、`:956`（4004） | 已修；4003/4004 两条随修复加，重连预算耗尽那条此前无用例，本次补，修复父提交上红 |
| `3eb5e0b0` skill-learning 观察者把配置 / VCR / 文件系统错误一律吞成回退 | — | `src/services/skillLearning/__tests__/throttleAndCircuitBreaker.test.ts:471` | 已修，随修复加 |
| `4f5633e7` 投出去的树上 `demo/lib` 入口跑不起来 | — | `scripts/__tests__/demoBundles.test.ts:80` | 已修，同 PR `e7a9851d` 加 |
| `a6afa8fa` 控制台探活打错地址，成功的部署报成失败 | — | `demo/env/beta/beta-console-url.test.ts:67` | 已修，随修复加 |
| `f48906c8` `4aba06ec` 节点 agent 写不了自己的工作区 | — | `src/cli/handlers/__tests__/resident.test.ts:310`；`demo/env/resident-task-policy.test.ts:137` | 已修，随修复加 |
| `4d29d00a` 通知工具自己多占一行过程 | — | `packages/resident/test/acp-turn.test.ts:383` | 已修，随修复加 |
| `8583adff` ACP 起不来时整台节点从网络上消失（v2.63 ⑧ 记的隐患） | ⑤ 接收方崩溃（agent 永远起不来） | `src/services/qianmo/__tests__/resident.integration.test.ts:275` | 已修，随修复加 |
| `741db042` `17229fce` Windows 语音产物动态链接 CRT，语音模式无声消失 | — | 无 | 已修，**无用例** |
| `e1620d86` 聊天元数据损坏时会话正文恢复失败 | — | `src/cli/handlers/__tests__/consoleChat.test.ts:852` | 已修，随修复加 |
| `887e275c` 协议错误描述信任输入的字符串转换 | — | `packages/protocol/test/validate.test.ts:153` | 已修，随修复加 |
| `468bc0e2` 登录限流在未过期时反复遍历全部来源 | — | `packages/console/test/login.test.ts:915` | 已修，随修复加 |
| `9ac042ec` 配置错误对话框渲染失败时挂起 | — | `src/components/__tests__/invalidConfigDialog.test.ts:9` | 已修，随修复加 |
| `0f73440e` 注册服务绑定失败仍留下时钟定时器 | — | `packages/registry/test/http.test.ts:73` | 已修，随修复加 |
| `0149842b` 注册接口对非法 URL 编码不给结构化错误 | — | `packages/registry/test/http.test.ts:91` | 已修，随修复加 |
| `4430f0a7` 读不了序号超过四位的既有备份 | — | `packages/backup/test/store.test.ts:138` | 已修，随修复加 |
| `3e5b21f3` 制品替换在新版本写成功前就删了旧版本 | — | `packages/cloud-artifacts/src/index.test.ts:54` | 已修，随修复加 |
| `5f5cb3b6` 制品上传流不在读取时执行体积上限 | — | `packages/cloud-artifacts/src/index.test.ts:112` | 已修，随修复加 |
| `7aecd760` 协议消息类型接受对象继承属性 | — | `packages/protocol/test/validate.test.ts:165` | 已修，随修复加 |
| `6869dfcc` SSH 凭据代理 socket 不在私有目录 | — | `src/ssh/__tests__/SSHAuthProxy.test.ts:13` | 已修，随修复加 |
| B-1 SIGKILL 之后 lifecycle 取证缺失 | ⑤ 目标进程被 SIGKILL | `src/services/qianmo/__tests__/resident.integration.test.ts:1541`；`packages/resident/test/lifecycle.test.ts`；场景 `recovery/lifecycle-records-hard-kill` | 已修 `aceddc5e` `5439c301`，随修复加 |
| C-1 控制台的租约判定固定按 90 s，不读注册中心实际 TTL | ① 目标在注册中心已过租约 | `packages/console/test/view.test.ts:350`；`packages/console/test/http.test.ts`；场景 `console/registry-lease-custom-ttl` | 已修 `b14dcc81` `c998dd7b`，随修复加 |
| #61 真机腿假绿：驱动零次调用仍报 PASS | — | `demo/lib/acceptance/__tests__/report-core.test.ts:123` | 已修 `bc40f4e7` `20c212ba` `09caf3c0`，随修复加 |
| #85 NDJSON 只在收尾写，驱动内硬等待不吃倍率 | — | `demo/lib/acceptance/__tests__/report-core.test.ts:267`；`fleetGuards.test.ts:191` | 已修 `dccea348` `e4ad8cb0`，随修复加 |
| #86 缺吊销清单那条场景没有同轮对照 | — | 无（改在场景本身，没有单测守它） | 已修 `a1766029` `25f06a95`，**无用例** |
| #89 本地腿 `launcherHost.run` 是同步 spawn | — | 无 | 已修 `808d7e3a`，**无用例** |
| #91 本地驱动四处就绪等待不吃超时倍率 | — | 无（只有 ② 远端预算那一半有：`fleetTransport.test.ts:1406`） | 已修 `10048cb5` `834b274e`，**主体无用例** |
| #96 FleetDriver 把 SSH 传输失败当成产品结论 | — | `demo/lib/acceptance/__tests__/fleetTransport.test.ts:308` `:384` `:491` | 已修 `5c40be5b` `67becaa3` `0327e926`，随修复加 |
| #98 FleetDriver 其余调用点同病 | — | `demo/lib/acceptance/__tests__/fleetTransport.test.ts:846` | 已修 `f812b914`，随修复加 |
| #100 每轮几千次 SSH 握手，一次抖动就判红 | — | `demo/lib/acceptance/__tests__/fleetSshMux.test.ts:271` | 已修 `98ef50fe` `05eb484e`，同 PR `60428b1a` 加 |
| #105 转发隧道自己死掉，被报成节点拨不通 | — | `demo/lib/acceptance/__tests__/fleetTransport.test.ts:1510` | 已修 `3180b2c3` 等三笔，随修复加 |
| #109 收帧窗口不吃 `--timeout-scale` | — | `demo/lib/acceptance/__tests__/fleetGuards.test.ts:230` | 已修 `dd090480`，随修复加 |
| `14c838c6` 真机腿超时不按倍率放大，慢一步的场景记成 error | — | `demo/lib/acceptance/__tests__/fleetGuards.test.ts:168` | 已修，同 PR `451fb5e0` 加 |
| `4d7d58f7` beta-4 的默认 SSH 目标指向一台空机 | — | `demo/lib/acceptance/__tests__/fleetGuards.test.ts:313` | 已修，钉默认值的断言随修复改 |
| `0cd40d16` 节点在就绪前退出，就绪等待仍等满预算 | — | 无 | 已修，**无用例** |

**覆盖率：62 / 72 = 86.1%**（有用例的行 / 全部行）。五类边界的 7 行全部已钉：B-1 与 C-1 在本表
初稿时尚未修复（未修的缺陷写用例只会是一条红用例），随后同一批次修复并随修复加了用例。无用例的
另外 10 行都不属于五类。

### 没收进表的

- **单测自身的偶发与假绿**（不是产品，也不是验收套件）：#5 #23 #25 #33 #56 #102；
  `1be556c9` `933440a0` `3ea33645` `eeb64693` `fdcda493` `ad2a89ea` `ab3b82a6` `57eb6755`
  `9ddc7e08` `051cbe47` `746338c5`；roadmap v2.63 ② 的 beta-deploy 固件 `exec` 竞态。
- **能力缺口或经查不是缺陷**：#8（测试覆盖缺口）、#38（启动器表达不了参数）、#45（缺 systemd
  单元）、#62（场景如实 skip）、#65（场景未走驱动，但不是假绿）、#113（起法不在仓库里）、
  #116（原诊断被推翻：控制台没带 `--wake-sign`，补的是验收判据）；v2.60、v2.61 各自写明
  「不是缺陷」的那两条。
- **文档、许可 / SBOM、依赖升级、棘轮与门禁接线**：#47；`ecdd6f25` `30e82286` `a386e4dc`；
  `7bd7a216` `483d5e1f` `15ded629` `91fd57dd` `46f1c057` `9a894089`（未用导出）；`0de95fa9`
  `b916583b`；`c34f2cfc` `fda29b1f`（测试出网与 VCR 提示）；`d811e1c7`（路径约定违例，提交
  说明写明零行为变化）；`3476dd93`（上游同步的冲突解法）。
- **同批或同 PR 内的自修**（修的是本批刚写、尚未交付的代码）：`8bac1f76` `54a0a3f1` `ced64604`
  `7ef3d48b` `e573e257` `da9d2346` `270d1799` `92ba7e82` `2ca362f3` `74bc2d4b` `f35d3272`
  `4b1f9ee1` `b711f0a6` `266ad4b8`（PR #3 内）；`fea5889a` `7bd79c1d` `b6242bc6`（评审条目）；
  `d88a9e51`（PR #94 内）；`f3b14aea` `5e755ba4` `98bb0434`（PR #63 内，并入 #61 那一行）；
  `26c4669a`（PR #69 内）；v2.46 ⑥ 的注册表单占位符（与功能同一提交）；v2.64 ④ ACP 重启
  缝里的误结算（`8583adff` 同一提交引入又修掉）；`e5e0e6a1`（错误修法，已由 `684a8dc3`
  撤回）。
