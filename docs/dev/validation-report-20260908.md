<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 AgentNest 项目验证报告

验证时间：2026-09-08（UTC 证据文件生成于 2026-09-09 00:45–01:08）  
被测提交：`fb24003f596e551baa9ef34fac6d1733f8b3f997`  
证据目录：`/Users/cornna/Documents/Codex/atlas-validation-20260908/`

## 1. 总体结论

核心链路在本机和一台真实 ARM64 P2 测试主机上可以运行：真实注册中心、常驻节点、控制台、签名唤醒、ACP、模型调用、工作区读取、审计和聊天页面均有执行证据。当前不能给出“完整可运行”结论，置信度中等偏高：全套真实进程场景为 **113 pass / 1 fail / 3 skip / 0 error**，且 `recovery/lifecycle-records-hard-kill` 真实失败；仓库 `precheck` 首轮为 **13215 pass / 36 skip / 1 fail**，重试曾为 **13216 pass / 36 skip / 0 fail**，最终重跑又因同一 FileReadTool 套件的 5 秒随机超时为 **13215 pass / 36 skip / 1 fail**。日志分别在 `evidence/precheck-retry.log` 和 `evidence/precheck-final.log`。

## 2. 阶段 0：环境与项目认知

- 技术栈：Bun 1.3.13、TypeScript strict、Bun test、Vite 分包构建；阡陌功能位于 20 个 `@qianmo/*` workspace 包，并在基座 CLI 中提供 `qm resident`、`console`、`resident-wake`、`audit`、`ca`、`cert`、`watch`。
- 状态：注册表、审计链、会话、准入账本、记忆和工作区均可用文件存储；不要求 PostgreSQL/Redis。模型端点实际 `GET /v1/models` 返回 200 并列出 `gpt-6-astra`。
- 本次配置：模型 key 只存外部验证目录的 0600 文件，未写入仓库或报告；遥测显式关闭。模型请求使用用户提供的 `https://api.cornna.xyz/v1`、`gpt-6-astra`。
- P2：`cornna-p2` 为 Linux ARM64，Bun 1.3.13、Docker 存在但普通用户无 Docker socket 权限；root 侧只有 `runc`，未发现 `runsc`，`dormice` inactive。P2 可用于真实跨机常驻验证，不能作为 Linux runsc 沙箱或 Dormice 验收环境。

## 3. 阶段 1：功能清单

已按用户确认的清单继续：P0 15 项、P1 31 项、P2 10 项，共 56 项；现有真实场景表有 117 条。完整表在外部证据目录的 `功能清单.md`、场景入口在 `evidence/scenario-inventory.tsv`，源码入口快照在 `evidence/source-surface.txt`。

## 4. 阶段 2：真实启动证据

启动脚本只在外部验证目录中运行，建立了两个配置根、两个工作区、真实注册中心和真实控制台。`evidence/startup.json` 记录端口、PID、argv、节点地址和 commit；`evidence/local-ports.txt` 记录监听端口。

- 注册中心 `http://127.0.0.1:39710`、节点 `39711/39712`、控制台 `39713` 均真实监听；`GET /v0/health` 返回 200。
- 节点 banner 报 `sourceCommit=fb24003f...`，配置根分别写出 identity、timings、sessions、admission 和 audit trail。
- `bun run build:vite` 完成，`dist/cli-qianmo.js --version` 返回 `2.46.1 (Qianmo Node)`，`check:bundle` 证据在 `evidence/bundle.log`。
- P2 节点经 SSH 隧道本地端口 `39721` 启动，banner 同样报告被测 commit；模型配置注入后无 credential warning。

## 5. 阶段 3：功能验证结果与证据

### P0/P1 核心结果

真实 API 矩阵见 `evidence/console-probe.json`：匿名 401、view 调 admin 403、非法注册 400、注册/心跳 200、匿名审计 401、view 审计 200、缺字段唤醒 400、白名单外唤醒 403、真实签名唤醒 200。重复注册按实现语义替换记录并刷新租约，未判作冲突。

真实控制台页面已用浏览器打开并验证：管理员身份、名册、服务器备注、限额、审计链、唤醒表单和聊天页面均渲染；聊天页面实际新建会话、发送消息并收到 `RESULT: Validation fixture: project Atlas; value 17; multiplier 3.`，页面显示已投递、已读、工具 `Find`/`Read` 和 15 秒完成耗时。浏览器现场不是静态 HTML 检查，页面证据来自 CUA accessibility state。

本地端到端场景完整摘要在 `evidence/acceptance-full2/SUMMARY.txt` 和 `results.ndjson`：

|维度|通过|失败|跳过|说明|
|---|---:|---:|---:|---|
|handshake|13|0|1|PSK、签名、错误凭据和冲突|
|policy/capability/trust|28|0|1|默认签名策略、过期、重放、信任文案|
|delivery/wake|12|0|0|真实传输、回执、拒绝和 CLI round-trip|
|model-credential|6|0|0|401、不可达、挂起、500、缺凭据|
|multi-agent/audit|13|0|1|隔离、链完整性、篡改和镜像边界|
|recovery|4|1|0|SIGKILL 取证失败，见问题 B-1|
|launcher/limits/console/certificate|33|0|0|启动器、限额、控制台路由、证书场景|

这些场景会起真实 `qm resident` / `qm console` 和 TCP/Unix 资源，但其中模型凭据矩阵使用本地可控上游夹具，不能替代厂商模型质量验收；真实模型证据来自上述本机和 P2 的唤醒、聊天流程。

## 6. 阶段 4：端到端流程

|流程|结论|证据与失败路径|
|---|---|---|
|管理员打开控制台 → 查看名册/限额/审计 → 创建聊天会话 → 发送消息 → ACP 读工作区 → 页面显示结果|完整跑通|浏览器现场；真实 transcript、timings、audit 在 `runtime/validation-a` 下。|
|控制台签名唤醒 → 本机节点收信 → 真实 gpt-6-astra 调用 → 读取 `INPUT.txt` → 返回结果|完整跑通|`console-probe.json` 的 200 receipt；`validation-a` transcript 与 `timings.jsonl` 有 `first_content`/`turn_completed`。|
|本机控制台 → SSH 隧道 → P2 ARM64 节点 → 真实 gpt-6-astra → 读取远端文件 → 回执|完整跑通|`p2-console-wake.json`、`p2-runtime-observation.txt`、`p2-transcript.jsonl`，结果为 `RESULT: P2 cross-machine workspace`。|
|直接 `resident-wake` 不带 capability → 签名任务节点|按预期失败|`p2-wake-result.txt`：`E_CAP_INSUFFICIENT: wake from console needs write-limited, presented read`，receipt 为 `E_UNDELIVERABLE`。|
|节点 SIGKILL → 读取 lifecycle → 重启/正常 SIGTERM|失败|`recovery/lifecycle-records-hard-kill`：运行中和 SIGKILL 后记录为 undefined，正常停止才有 `phase=stopped`。|

## 7. 问题清单

### 阻塞

无启动阻塞；核心链路已能执行。

### 严重

**B-1：SIGKILL 后 lifecycle 取证缺失。** 复现：运行 `recovery/lifecycle-records-hard-kill`，启动真实节点后发送 SIGKILL，读取该配置根的 `resident/lifecycle.json`。预期 `phase=running`，实际文件不存在/解析为 undefined；SIGTERM 正常停止后才写出 `stopped`。影响：硬杀后无法确认上一次生命周期，削弱崩溃恢复与运维取证。建议：在启动阶段以原子写入先落 `running`，再启动可被杀死的工作，随后重复场景验证。业务修复尚未做。

**B-2：门禁全量测试存在时序抖动。** 首轮 `FileReadTool token-cap auto-pagination > offset/limit...`、最终重跑的 `...a file under the cap is untouched and still dedups` 均超过 5 秒；隔离重跑该文件 8/8 通过、0.7 秒。影响：CI/本地全量门禁可能假红。建议先保存慢测现场，再定位分片并发/共享资源，不要放宽断言或跳过。

### 一般

**C-1：本地演示注册表租约与控制台快照口径不同。** 验证脚本给注册中心 1 小时 TTL，而控制台显示固定 90 秒后“滞后/过期”；实际节点仍监听。影响只在自定义 TTL 的运维显示，默认演示配置应保持同一来源。建议控制台读取注册中心返回的 TTL 或禁止不一致配置。

**C-2：P2 没有 runsc/Dormice。** 不是代码失败，但 Linux 沙箱、Dormice 冻结/唤醒、systemd 镜像流程无法真实验收；不能用本机 macOS 或普通 runc 替代。

### 建议

**D-1：审计链当前显示“未见证”。** 链完整性为 `empty/intact` 或真实记录无问题，但没有外部 witness；生产部署应接入独立见证端点后再验一次。

## 8. 验证边界与改动

- 未执行真实支付、真实用户通知、生产部署、删除数据等危险动作。
- 未能验证 runsc 沙箱、Dormice、跨机审计镜像搬运、Windows/24 小时性能；P2 的证据只覆盖跨机节点/模型/工作区。
- 缺少第三方真实账户的 OAuth/Keychain、Cloudflare/R2、Langfuse/Sentry、浏览器外部 MCP、Happy 手机端，因此这些功能仅列入清单或用本地替代面验证。
- 未修改业务逻辑。仓库新增本报告；验证脚本、日志、私有模型配置和运行时状态全部在外部证据目录，模型 key 未进入仓库。`bun run precheck` 的 `check:fix` 未产生源代码 diff（以最终 `git status` 为准）。

## 9. 下一步

1. 修复并复测 B-1 lifecycle 原子落盘与 SIGKILL 取证。
2. 复现并消除 B-2 全量测试时序抖动，直到 `bun run precheck` 零错误。
3. 统一注册表 TTL 与控制台 limits 来源，补回归场景。
4. 在具备 runsc、Docker 权限、Dormice 和 systemd 的独立 Linux 测试主机上运行沙箱/冻结/镜像流程；再做一次 `--target fleet`，不要把本次 P2 节点证据扩展成完整部署结论。
5. 接入 witness 后重新验证外部见证状态，再进行长时驻留和多设备测试。
