<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# `@qianmo/console`

阡陌控制面板：一个跑在本机环回地址上的单页控制台，用来**看**这张网络、并对它做**少数几件事**。

- **看**：在线节点名册（能力、心跳、租约到期）、审计轨迹（可按 trace / task / agent / 时间窗过滤，可按 `traceId` 还原完整消息链）、协议与运行时的各项上限。
- **做**：注册 / 注销一个节点、补一次心跳、发起一次唤醒。页面上注册成功的条目由 host 侧的 `occ console` 记进登记簿并持续续租，直到在页面上注销（`docs/dev/console.md` §7.3）；本包只看到一个 `RegistryPort`。

页面本身是服务端渲染的 HTML，外加三个可局部刷新的片段；没有构建步骤、没有第三方依赖、不打包任何外部资源。

## 怎么起

```bash
occ console                      # 绑 127.0.0.1，端口随机，token 自动生成
occ console --port 8787          # 指定端口
```

启动后 CLI 会把**带 token 的 URL** 打到 stdout，直接点开即可。CLI 接线（参数、把三个端口接到真实的注册中心 / 审计文件 / 传输层）在 host 侧的 `occ console` 命令里，不在本包内——本包只认 `ConsoleDeps`（见 `src/deps.ts`），任何一个端口都可以用一个普通对象替换，这也是它的测试方式。

以库的形式用：

```ts
import { createConsoleHandler, resolveTokens, startConsoleServer } from '@qianmo/console'

const tokens = resolveTokens({ hostname: '127.0.0.1', generate: () => crypto.randomUUID() })
const server = startConsoleServer(deps, 8787, { tokens })
// 只想测路由、不想占端口：
const handle = createConsoleHandler(deps, tokens)
```

## 路由表

| 方法 | 路径 | 角色 | 返回 |
| --- | --- | --- | --- |
| GET | `/` | view | `text/html`，整页 |
| GET | `/assets/app.css` | 公开 | `text/css` |
| GET | `/assets/app.js` | 公开 | `text/javascript` |
| GET | `/v0/health` | 公开 | `{ status: 'ok' }` |
| GET | `/v0/agents` | view | `{ agents }` |
| POST | `/v0/agents` | **admin** | 注册，返回 `ConsoleAgent` |
| DELETE | `/v0/agents/<urlencoded address>` | **admin** | 204 |
| POST | `/v0/agents/<urlencoded address>/heartbeat` | **admin** | `ConsoleAgent` |
| GET | `/v0/audit?source=&outcome=&traceId=&taskId=&agent=&from=&to=&limit=` | view | `AuditPage` |
| GET | `/v0/audit/chain/<urlencoded traceId>` | view | `{ chain }`（可为 `null`） |
| GET | `/v0/limits` | view | `LimitsSnapshot` |
| POST | `/v0/wake` | **admin** | `WakeOutcome`；没有唤醒通道时 501 |
| GET | `/fragments/{roster,audit,limits}` | view | `text/html` 片段 |
| GET | `/fragments/chain/<urlencoded traceId>` | view | `text/html` 片段，一条消息链 |

约定：

- 整个 `qianmo://…` 地址放在**一个**百分号编码的 path segment 里（`qianmo%3A%2F%2Fnode-b%2Freviewer`），与注册中心 HTTP v0 一致。
- 错误一律是 `{ "error": { "code": "…", "message": "…" } }`。
- 名册的在线 / 滞后 / 过期按注册中心给每条记录的租约（`expiresAt − lastHeartbeatAt`）判，不按控制台自己的数；`/v0/limits` 的 `registryTtlMs` 只是 `@qianmo/registry` 的出厂默认，用于兜底。口径见 `docs/dev/console.md` §7.1。
- `limit` 非正整数或超过 500 一律夹到 500；`from` / `to` 接受 epoch 毫秒或 ISO 字符串，解析不了就当没给（过滤器输到一半不该 400）。
- 两个 assets 路由公开：浏览器不会给页面里的 `<link>` / `<script>` 带上凭据，锁上它们只会得到一张没有样式的页面；这两个文件是编译进来的常量，不含任何实例数据。

## 鉴权模型

**两个 token，不是一个带 scope 字段的 token。**

| token | 能做什么 |
| --- | --- |
| view | 名册、审计、上限，只读 |
| admin | view 的全部，外加注册 / 注销 / 心跳 / 唤醒 |

- 凭据可以放在 `Authorization: Bearer <token>` 头里，也可以放在 URL 的 `?token=<token>` 上——后者是浏览器直接打开页面时唯一可行的方式（地址栏发不出自定义头），也正是 CLI 打印带 token 的 URL 的原因。
- **刻意不用 cookie。**cookie 是环境凭据，浏览器会把它带给任何本地页面发往这个端口的跨源 POST，那会让每条 admin 路由变成 CSRF 目标。"必须出示一个外部源读不到的 token" 就是这里的 CSRF 防线。
- 比较是常数时间的（`timingSafeEqual`），长度不同直接不匹配，空 token 永不匹配。
- 401（没给或给错）/ 403（拿 view token 敲 admin 路由）**都不回显收到的 token**。
- 角色在方法之前判定：匿名调用者不该从 405 里学到某条路由接受哪些动词。

**token 从哪来（`resolveTokens`，纯函数，策略只有这一处）**：

1. 绑在环回地址（`127.0.0.1` / `::1` / `localhost`，含整个 127/8）且没给 token → 自动生成两个。
2. 绑在**非环回**地址（`0.0.0.0`、某个内网 IP、一台 VPS 的公网口）→ **必须显式给两个 token，缺任一个就拒绝启动**。fail closed：这种情况下"自动生成并打到 stdout"等于把名册、审计和唤醒按钮交给第一个扫到这个端口的人。
3. 两个 token 都至少 16 个字符，且**必须不同**——相同就等于只读用户也能唤醒节点。这条对生成出来的 token 同样适用。

M0 内没有 TLS（章程 N-3），所以第 2 种用法的前提是外面已经有一层（反向代理 / SSH 隧道 / WireGuard）。

## 它读什么、不写什么

控制台是一个**观察面加少量动作**的东西，边界写死在 `src/deps.ts` 的端口里：

- **不碰任何私钥。**名册里的 `publicKey` 是节点自己公布的公钥，控制台只显示；私钥既不读也不经过这里。
- **不读会话内容。**它看不到任何一次对话、任何一条 prompt、任何一份工作区文件。唤醒请求里的 prompt 是**操作者当场输入**的那一句，不是从别处读出来的。
- **审计只读。**审计端口只有 `read` 和 `chain` 两个方法，没有写、没有删、没有截断。审计文件的完整性判定（`chain` / `intact` / `issueCount`）原样透出，不做美化——链断了就显示链断了，链**不在**就显示未建立（`AuditChainState` 四态，见 `docs/dev/console.md` §7.1）。
- **不自己开 socket、不自己找文件。**注册中心在哪、审计文件是哪个、唤醒怎么发，全部由 CLI 注入；本包是叶子，不 import host 的 `src/`。
- **不落盘。**没有任何状态写在本地：token 只在内存里，页面每次都是现渲染的。

## 布局

```
src/deps.ts     端口契约（控制台能看到的全部东西）
src/auth.ts     双 token、角色判定、token 来源策略
src/http.ts     路由、鉴权接线、失败降级、Bun.serve
src/view/       服务端 HTML 渲染（整页 + 三个片段）
src/assets/     编译进来的 CSS 与前端脚本常量
test/           路由 / 鉴权矩阵 / 过滤器解析，全部用手写假端口
```

```bash
bun test packages/console/
```
