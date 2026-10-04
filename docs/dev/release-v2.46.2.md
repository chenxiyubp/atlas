<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 阡陌 v2.46.2 GitHub Release

负责人 2026-09-26 决定：修复合入 `main` 后发布 v2.46.2，修正 v2.46.1 构建产物启动即崩溃的回归。发行仓库、形式与 v2.46.1 相同（`sweetcornna/atlas`，源码归档 + `SHA256SUMS`）；基座 pin 仍为 v2.46.0（09-26 核对：上游最新正式 release 就是 v2.46.0，本次无同步）。

## 为什么要发这一版

按 v2.46.1 标签构建的产物，`-p` 与交互入口启动即报 `ReferenceError: init_external is not defined`（详见 [v2.46.1 发行说明](release-v2.46.1.md)「已知问题」）。本版包含修复，并让门禁能抓到同类问题。

## 变化

构建与依赖：

- 修复构建产物启动即崩溃：vite 升到 8.3.1（rolldown 1.2.11），绕开 rolldown 1.0.2–1.1.1 的代码生成回归（`767302b8`）。
- `bun run check:bundle` 新增两道检查：chunk 内被调用却未绑定的懒初始化函数（静态），以及两个入口 `-p` 的无网络、无真实凭据运行期冒烟（`5e2446b3`）；冒烟关掉官方插件市场的后台自动安装，不再与「未预期出网」判据抢时序（`22d6d737`）。
- 清掉 09-08 之后新发布的依赖安全公告：hono 4.13.7、sharp 0.35.4、smol-toml 1.9.0，`bun audit` 回到 0 条（`aa19a419`）。

常驻节点与控制台：

- 常驻节点的 lifecycle 取证在真节点上生效：此前 `start()` 从未执行，SIGKILL 后留不下 `running` 记录；启动后单起一行报出上一条命的结局（`killed` / `clean` / `unknown`）（`aceddc5e`、`5439c301`、`b1c13a11`）。
- 控制台按注册中心实际发出的租约判断滞后与过期，不再固定按 90 s（`b14dcc81`）。
- 控制台上注册的 agent 由控制台持续续租，活过租约，注册中心或控制台重启后都能回来（`fe5bd71c`、`4d55cd1f`）。
- `qm watch --sign`：值守作业的任务可以签名，节点按受信来源执行；正常结束的作业不再产生对人通知（`52c58a00`、`62a429db`）。
- 审计见证的发送方不再重发已被端点接受的链头，空闲节点的 `.err` 不再每个周期记一条 409。端点对同一 seq 的 409 回带已存的 head，head 相同即按已接受处理（`9ed943af`）。端点没有一起升级时，节点每次重启后到链头第一次前进之前，每个周期仍会记一条 409。
- 审计见证的陈旧判定改为只在链越过最新锚点、且见证侧超过 2T 没收到新锚点时成立。链头已锚定的空闲节点不再被判陈旧：`occ audit --verify --witness` 不再报 `stale`，控制台审计页不再显示「未见证」（`e7b2c3bc`）。

测试与门禁：

- 根治整仓测试的两处偶发失败：ACP 工作区套件遗留的进程全局 cwd（`8ea69bc2`、`72a59bd3`），以及 macOS 杀掉拷贝的系统二进制导致的部署脚本用例假红（`0831a66b`）。
- 边界用例库 41 条，内测期缺陷追踪表 72 条中 62 条有用例（`b1e10022`、`7403678c`）。

另含 M1 三份设计草案（权限、租户、记忆，均为 v0.1-draft、待评审，不改变任何运行行为）与内测环境运维脚本（控制台 TLS 前置、见证端点启动器、可用性探针、注册中心登记带节点公钥、pid 文件对不上真进程时的停起判定）。完整列表见合并提交。

## 使用与验证边界

```sh
git clone --branch v2.46.2 https://github.com/sweetcornna/atlas.git
cd atlas
bun install --frozen-lockfile
bun run build:vite
bun run check:bundle
```

与 v2.46.1 不同，这里用 `check:bundle` 而不是 `--version` 做产物验证：前者包含运行期冒烟，会实际走到 `-p` 的模块初始化。

本版仍为源码发行。真实节点、真实 provider、沙箱（runsc/Dormice）与 Windows 的验收边界同 v2.46.1；平台或凭据相关的跳过测试不算作真实部署已验证。
