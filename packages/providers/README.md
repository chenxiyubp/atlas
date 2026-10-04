<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# @qianmo/providers —— 模型服务的唯一目录

**一句话定位**：模型服务档案的类型、预设目录、下线表、校验器、闭合兼容键集、密钥指纹和第六类动作协议 schema v1。纯数据加纯函数：没有运行时依赖，不读写文件，不联网。控制台和节点都只引用这个包，控制台自己不留厂商清单（R-1）。

| 项 | 指针 |
| --- | --- |
| 任务包 | roadmap **P18.2**（目录与编译器） |
| 设计真源 | [`docs/dev/providers-console-m1.md`](../../docs/dev/providers-console-m1.md) §2.4–§2.6、§3、§4、§5.2、§5.3 |
| 编译器 | `src/services/qianmo/providers/compile.ts`（要复用基座的 `ALL_PROFILE_ENV_KEYS` 和激活补丁，包里引用不到，所以放在 `src` 侧） |
| 节点写入库 | `src/services/qianmo/providers/node.ts`，调用约定写在模块头注释里 |

## 1. 模块

| 文件 | 内容 |
| --- | --- |
| `types.ts` | `ProviderProfile`（中枢存的，不含密钥值）、`WireProfile`（协议里下发的）、`ProviderModel`、`KeyRef`、`WireKey`、`NodeCapabilities`；每个闭合词表同时导出成运行时元组 |
| `presets.ts` | 33 条预设，分按量（国内、国际）、套餐、本地、自定义五组 |
| `retirements.ts` | §4.6 的下线表和 14 天预警窗口 |
| `validate.ts` | `parseWireProfile` / `parseProviderProfile`：未知字段一律拒收，不忽略；§3.4 effort 规则；URL 和模板；密钥列表 |
| `effort.ts` | 档位只往低夹：`clampEffortDown`、`clampSharedEffortDown`（`effortLock` 用）、`compiledEffortLevel` |
| `compatKeys.ts` | §3.6 闭合兼容键集、取值范围，以及进程级禁止键（`PATH`、`LD_PRELOAD`、`CLAUDE_CODE_USE_*` 等） |
| `protocol.ts` | 第六类动作 schema v1：`parseProviderRequest`、节点状态和响应类型 |
| `errors.ts` | 错误码：§2.5 的码表，再加 `unsupported-multi-key` |
| `fingerprint.ts` | 单把密钥的对账指纹 |
| `secretRef.ts` | `profileId + keyId` 二元组和它的槽键 |

## 2. 数据模型要点

- **能力**：档案只存三个 thinking 位（`capabilities.mode: 'explicit'`），三个 effort 位由 `effort.send` 和 `levels` 推出。这样「effort 发不发」只有一处说了算。`auto` 必须配 `family`（不写覆盖）；`always` / `never` 必须配 `explicit`（基座把列表里缺的项读成 false，所以要么六项全写，要么一项不写）。
- **显式能力要挂在 opus / sonnet / haiku 档上**。P18.5 之前，基座的能力覆盖不读 FABLE 档。
- **档位只往低夹**。请求的档位不在 `levels` 里，就取不高于它的最高一档；没有更低的就拒绝。`always` 没写 `level` 时按 `high` 编译，再往低夹。不写的话，运行时会退回族默认值（第三方 opus / sonnet 槽是 `xhigh`），而这个默认值不会按 `levels` 夹。
- **多把密钥**（数据模型为 P18.18 预留）：`keys` 有 1 到 8 项，`keySelection` 取 `fill_first | round_robin | least_used`，默认 `fill_first`。v1 只校验枚举值，不实现策略；编译和下发只用 `primaryKey()` 选出的那一把（`priority` 最高，同分按列表顺序）。节点在 `capabilities.multiKey` 为 false 时收到多把，返回 `unsupported-multi-key`，不截断。
- **指纹**：`fp1:` 加 `SHA-256("qianmo/provider-key-fingerprint/v1\0" + key)` 的前 128 位。每把密钥各算一个，用来对账（`keep` 按指纹认节点上那把），**不是**密钥末几位。
- **密文库的键**（归 P18.6）：用 `secretSlotKey({ profileId, keyId })` 得到 `<profileId>:<keyId>`；两段都只含 `[a-z0-9-]`，冒号不会撞。

## 3. 协议 v1

操作闭合为 `status / probe / models / apply`；请求不超过 64 KiB；顶层未知字段返回 `bad-request`；`v` 不等于 1 返回 `version-skew`。`apply` 带 `expect.ownedHash`（第一次下发为 `null`），以及 `recycle.sessions`、`dryRun`、`force`。响应里不回显任何密钥值，只给指纹和键名。

## 4. 预设

每条预设都有官方文档 URL 和核实日期（`source.verifiedAt`），`evaluated` 一律是 `false`：没有用真 key 验证过（§11 第 1 条）。调研件没有核实的项写在各预设的 `unverified` 里，不编造：Azure 的鉴权写法、MiMo Token Plan 的 Anthropic 路径、方舟和千帆套餐的 key 前缀。

## 5. 节点侧调用约定（摘要）

详见 `src/services/qianmo/providers/node.ts` 的模块头注释。

1. `stageProviderApply(req)`：校验请求，加锁，核对 `expect.ownedHash`，写一次性的首写备份和 `pending.json`（0600）。**不碰 `settings.json`。**
2. `commitPendingProviderConfig()`：唯一写 `settings.json` 的入口。只能在 ACP 代际边界调用（旧子进程已停，新子进程还没起），或者在常驻进程启动、拉起第一个子进程之前调用。配置根不是 0700 就拒绝。
3. 崩溃后只往前滚：磁盘仍是 `expectHash` 就正常提交；已经是 `targetHash` 就补写状态；`state.applied` 已记下这个 `requestId` 就丢掉意图。其余情况都按第三方改动处理，返回 `conflict`。

## 6. 测试

```sh
bun test packages/providers
bun test src/services/qianmo/providers
```
