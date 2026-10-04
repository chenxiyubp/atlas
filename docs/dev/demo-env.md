<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# M0 演示环境（P8.1）

> **v0.1 · 2026-08-15 · 本地腿已实测；真机腿 2026-08-16 首验通过（§7.1，roadmap v2.39④）；「未参与部署的成员」形式要件按负责人决议 2026-08-17 豁免（roadmap v2.41③），P8.1 已完成**
>
> （本行于 2026-09-26 回写；原文「本地腿已实测，真机腿未验证」见 git 历史。）
>
> 一台全新机器按 §4 的 runbook 敲命令，就能起出「两个节点 + 一个注册中心」的完整本地
> 演示拓扑。真机腿（Dormice + gVisor）的脚本在 `demo/env/remote/`，**已于 2026-08-16 在真机首验通过**（§7.1），
> 原因见 §7.1。

| 项 | 内容 |
| --- | --- |
| 任务包 | roadmap P8.1（依赖 P6.1；owner 董宗岳 / backup 陈子轩） |
| DoD | 全新机器 **30 min 内**从零复现完整演示环境，由未参与部署的成员实测 |
| 交付物 | `demo/env/`（bootstrap / seed / up / down / reset / smoke + `remote/`）、`demo/lib/p81-{registry,probe}.ts`、本文 |
| 本地腿实测 | ✅ 干净 `git clone` 起跑到冒烟通过，见 §4.3 的计时表 |
| 真机腿实测 | ✅ **2026-08-16 真机首验通过**（burn-vm-01 经 IAP 隧道；两处脚本缺陷当场修掉），见 §7.1 |
| 状态真源 | 各任务包的完成状态一律以 `roadmap.md` 的「完成状态速查」为准，本文不复述 |

---

## §1 两条腿

演示环境分成两条互不依赖的腿。**分栏不是为了好看，是为了不让「真机不可用」变成「什么都
演示不了」**——本地腿不需要任何云资源就能撑起 **AC-1 / AC-3 / AC-6(b)(c) / AC-7 / AC-8**
五条（且这五条连模型凭据都不需要），配上模型凭据再加 **AC-4 / AC-5** 两条；**非真机不可的
只有 AC-2 的休眠态与 AC-6(a)**。

| | 本地腿 | 真机腿 |
| --- | --- | --- |
| 跑在哪 | 任意一台装了 bun 的开发机（macOS / Linux 都可） | 装了 Dormice + gVisor 的 Linux 宿主 + 目标沙箱 |
| 起法 | `demo/env/up.sh` | `demo/env/remote/prepare-host.sh` + `prepare-sandbox.sh` |
| 拓扑 | 一台机器上**两个真进程**：两个配置根、两条审计链、两把节点身份 | 宿主跑 activator + 注册中心，沙箱内跑常驻 occ |
| 休眠态 | 没有（本地进程不会冻结） | 有（`docker pause` + `memory.reclaim`，AC-2 判据要的就是它） |
| 状态 | ✅ 已实测 | ✅ 2026-08-16 真机首验通过（§7.1；原状态「脚本未验证」） |

§6 是「哪条腿能演哪几条 AC」的完整对照表。

---

## §2 环境依赖清单

### 2.1 必须

| 依赖 | 要求 | 为什么是这个数 |
| --- | --- | --- |
| **Bun** | **1.3.13**（`.tool-versions` 的 pin）。硬下限是 `package.json` 的 `engines.bun >= 1.3.11` | 见 §2.2——这是本仓库最敏感的一条 |
| **Node** | 任意现代版本（本文实测 v26.3.0） | 不是给 `occ` 用的：`demo/lib/p61-worker.ts` 真的会 `spawn` 一个 node 子进程跑 AC-7 的分块计算；`demo/p61-e2e.sh` 因此把它列进了 `required` |
| **git** | 任意 | 克隆仓库；`seed.sh` 还要用它给两个节点各建一个真 git 工作区（AC-6(b) 恢复演示的对象就是这个形状） |
| **bash** | 4.x 或 macOS 自带的 3.2 均可 | `demo/env/*.sh` 只用两者都有的写法；未用 GNU 专有选项（`timeout` 在 macOS 上就不存在，脚本里因此一处没用） |
| **make** | 任意 GNU make | **只有 AC-7 冒烟那条命令要它**（`make -C demo p61-smoke`）；§4.2 的六条命令一条都不用。Debian/Ubuntu 的 minimal 镜像**不带 make**，且没有 sudo 就装不上——绕法见 §4.4 |
| **unzip** | 任意（或 `busybox unzip`） | **只有 bun 官方安装器要它**——`bun.sh/install` 会直接 `error: unzip is required to install bun` 退出，`~/.bun` 都不会生成。Debian/Ubuntu 的 minimal 镜像**不带 unzip**，无 sudo 装不上；这是第二台全新机器实测时**唯一的硬卡点**（§4.4）。无 sudo 的绕法在 §4.1 的装 bun 段前面：Debian 自带 `busybox`，两行垫片即可 |
| 内存 | **最低 2 GB**（含 swap 更稳） | 实测峰值 **1563 MB**，全在 `bun run build`（vite）那一步；2 GB 的机器上最低可用只剩 409 MB、动了 43 MB swap——**过得去，但余量很薄**。1 GB 的机器按此推算会 OOM。数据见 §4.4 |
| 磁盘 | **约 2.1 GB**（Linux x64 实测家目录总量）：`node_modules` 1.4 GB + `dist` 104 MB + node 运行时 204 MB + 源码与演示状态 | macOS / arm64 上小一截（`node_modules` 938 MB + `dist` 102 MB，合计约 1.3 GB）。**平台差几乎全在 `node_modules`**——两处实测分别见 §4.3 与 §4.4 |

### 2.2 Bun 版本为什么敏感（**这条别跳过**）

三件事叠在一起：

1. **`.tool-versions` 是 1.3.13，CI 用 `bun-version-file` 读它**（roadmap P0.4：CI 从前写
   `bun-version: latest`，与 pin 不一致，已修）。所以「CI 上是绿的」这句话只对 1.3.13 成立。
2. **`bun.lock` 是被 1.3.13 规范化过的**：bun 1.3.13 在装新依赖时把 493 条空解析字段改写成
   显式 URL（roadmap v2.31 记录，属一次性机械变更）。用别的版本跑 `bun install` 有可能把它
   改回去——那是一次谁都没打算做的提交，`bootstrap.sh` 因此在版本不一致时明确警告。
3. **本仓库的测量结论绑在具体版本上**：`process.memoryUsage().heapUsed` 在 Bun 1.3.13 下是
   **冻结常量**（`docs/dev/baseline-m0.md` §2.3），采样一律走 `bun:jsc heapStats`。换版本
   之前先看那一节，别拿旧结论套新运行时。

`bootstrap.sh` 的处置：**低于 `engines` 下限直接失败；与 pin 不一致则警告并继续**——把
1.3.14 的机器一律拦死会挡掉真实存在的验收路径（甲骨文那台 ARM 机就是 1.3.14），但
lockfile 若因此出现改动，**不要提交**。

### 2.3 只有真机腿需要

| 依赖 | 要求 | 出处 |
| --- | --- | --- |
| Docker | 已登记 `runsc` 运行时 | `demo/ac6a-sandbox.sh` 的 `command -v docker`；AC-6(a) 的 gVisor 出生契约 |
| gVisor | `runsc release-20260622.0`，systrap 平台 | `selection-m0.md` §1（不在此复述实验数据） |
| Dormice | 已安装并运行；`dor doctor` 全绿；`dormice.service` 应设开机自起 | roadmap P0.1 的服务器侧判据与遗留三项 |
| cgroup v2 | 可读 `/sys/fs/cgroup/cgroup.controllers` | P5.1 的 `oomKillDelta` 依赖它；macOS 上同一 OOM 只能给中等置信 |

版本与机器规格的真源是 `selection-m0.md` §1 与 roadmap 的「现状基线」表，本文只给指针。

### 2.4 端口

全部绑在回环，且都能用环境变量改（`demo/env/common.sh`）：

| 端口 | 谁在用 | 环境变量 |
| --- | --- | --- |
| 38610 | 注册中心 HTTP v0 | `QIANMO_DEMO_REGISTRY_PORT` |
| 38611 | 节点 A 的入站 WebSocket | `QIANMO_DEMO_NODE_A_PORT` |
| 38612 | 节点 B 的入站 WebSocket | `QIANMO_DEMO_NODE_B_PORT` |

其余 demo（AC-3、AC-7、混沌注入等）**各自起完自己的进程就收摊**，不占固定端口。

### 2.5 凭据：谁要、谁不要

| 演示 | 传输 PSK | 备份凭据 | 沙箱 daemon bearer | **模型凭据** |
| --- | --- | --- | --- | --- |
| `demo/env/up.sh` + `smoke.sh` | 要（seed 自动生成） | — | — | **ack 不要**，见下方脚注 |
| AC-3 `demo/ac3-loop-rate.sh` | 要 | — | — | 不要 |
| AC-6(b)(c) `demo/ac6b-restore.sh` | — | 要（seed 自动生成） | — | 不要 |
| AC-7 `make -C demo p61-smoke` | 要 | — | — | 不要（模型那一段是桩） |
| AC-8 `demo/chaos-inject.sh` | 要 | — | — | 不要 |
| P5.1 `demo/p51-diagnosis.sh` | — | — | — | 不要 |
| AC-1 `demo/ac1-restart.sh` | — | — | — | **最后一条判据要**（无凭据时明确跳过，不静默） |
| AC-4 / AC-5 | — | — | — | **要**（两家供应商） |
| AC-2 / AC-6(a)（真机腿） | 要 | — | **要** | 要（沙箱内跑真 turn） |

> **脚注（ack 与凭据的关系，说准一点）**：ack 是在**durable read 之后、turn 之前**发出的
> （P4.1 的设计，见 roadmap P4.1 与 `src/services/qianmo/resident.ts`），所以它在链路上早于
> 任何模型调用。本机两次实测 ack 分别是 **59 ms / 414 ms**。但要如实说明：**实测这两次的
> 机器环境里是有模型凭据的**（ACP 子进程继承环境变量），「没有凭据也能 ack」这句话依据的
> 是链路顺序，不是在一台无凭据机器上跑出来的对照。`task.result` 则确实要凭据，见 §7.3。

PSK 与备份凭据由 `demo/env/seed.sh` 在本机现生成（0600，落在 `DEMO_ROOT/secrets/`，
`.demo-env/` 已进 `.gitignore`）。**它们是演示专用的一次性密钥，不是任何真实系统的密钥。**
模型凭据本文不管——它按 occ 自己的方式配（环境变量或 `occ` 登录），演示脚本一个都不读。

> ⚠️ 一条要知道的事实：常驻节点的 ACP 子进程**继承整个进程环境**。演示环境隔离的是
> *配置根*，不是环境变量——你 shell 里的真实模型凭据会被子进程用上。这在需要跑真 turn 的
> 演示里正是想要的；不想要就在干净 shell 里起 `up.sh`。

---

## §3 目录布局与隔离

```
DEMO_ROOT/                      # 默认 <repo>/.demo-env，用 QIANMO_DEMO_ROOT 改
├── .qianmo-demo-env            # 标记文件 —— 一键重置的安全依据（见 §3.2）
├── secrets/                    # 0700：PSK、备份只写/归档凭据（各 0600）
├── nodes/
│   ├── node-a/config/          # 节点 A 的 OCC_CONFIG_DIR
│   ├── node-b/config/          # 节点 B 的 OCC_CONFIG_DIR
│   └── registry/config/        # 注册中心进程的配置根
├── workspaces/{node-a,node-b}/ # 各是一个真 git 仓库
├── state/                      # 注册表落盘、timings、probe/topology 快照、种子摘要
├── run/                        # pid 文件、registry ready 文件
└── logs/                       # 每个进程一对 .out / .err
```

### 3.1 配置隔离：三条硬规矩

1. **一切路径从 `src/config/paths.ts` 派生**（CLAUDE.md §1.1②）。演示脚本只设
   `OCC_CONFIG_DIR`，从不拼 `~/.occ` 之类的字面量。
2. **绝不碰用户真实配置根**。`~/.occ`、`~/.qianmo`、`~/.claude` 三个都是禁区；`common.sh`
   的 `demo_guard_root` 会拒绝把 `DEMO_ROOT` 设到它们里面（也拒绝家目录、仓库根、`/`）。
3. **每个节点一个配置根，不共用**。理由是审计链按配置根落一个文件
   （`occConfigPath('qianmo','audit','trail.ndjson')`）：两个常驻进程共用一个配置根，就是
   两条哈希链交替写进同一个文件，`occ audit --verify` 必然报断链——而那时候人会去查「谁改
   了审计文件」，其实只是拓扑搭错了。节点身份与常驻会话表同理。真实部署里两个节点本来
   就在两台机器上、各有各的配置根，这里只是把它复刻出来。

查某个节点的审计链就指着它自己的配置根查：

```bash
OCC_CONFIG_DIR=$PWD/.demo-env/nodes/node-b/config bun dist/cli-node.js audit --verify
```

### 3.2 一键重置为什么敢删东西

`demo/env/reset.sh` 的删除动作要同时满足三条，缺一条就退出：

1. `DEMO_ROOT` 通过 `demo_guard_root`（不是 `/`、家目录、仓库根，不在 `~/.occ` / `~/.qianmo` / `~/.claude` 里，也不在调用方环境里 `OCC_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` 指向的真实配置根里）；
2. `DEMO_ROOT` 下有标记文件 `.qianmo-demo-env`，**且首行是我们写的那一行**；
3. 每一个待删路径都在 `DEMO_ROOT` 之内——**逐个复核**，不信任变量拼接的结果。

六个负向用例已实测拒绝（对外变量名是 `QIANMO_DEMO_ROOT`，脚本内部才叫 `DEMO_ROOT`）：`QIANMO_DEMO_ROOT=$HOME`、`=<仓库根>`、`=~/.occ/demo`、`=~/.claude/x`、
`=$OCC_CONFIG_DIR/sub`（外层环境设了 `OCC_CONFIG_DIR` 时）、以及「目录存在但没有标记文件」——每例先在目标目录放一个哨兵文件，事后哨兵原样还在。

默认**保留**演示密钥（换 PSK 等于把还连着的对端全部踢下线，那是另一件事），要换用
`reset.sh --rotate-secrets`。

---

## §4 30 min runbook

### 4.1 前提

一台能上网的机器（首次 `bun install` 要下依赖，`postinstall` 还要去 GitHub 下 ripgrep），
外加 git、bun、node 三样。**后两样在全新的 Linux 机器上通常都没有，而 `bootstrap.sh` 的前置
检查会因此直接失败**——所以这里给出装法，两条都装进家目录，**不需要 sudo**：

```bash
# 0) 安装器要 unzip。没有 unzip 又没有 sudo 时（Debian/Ubuntu minimal 常见），用系统自带的 busybox 垫一个：
if ! command -v unzip >/dev/null && command -v busybox >/dev/null; then
  mkdir -p "$HOME/bin" && printf '#!/bin/sh\nexec busybox unzip "$@"\n' > "$HOME/bin/unzip" && chmod +x "$HOME/bin/unzip"
  export PATH="$HOME/bin:$PATH"
fi

# bun —— 必须是 .tool-versions 的 pin（§2.1/§2.2）。不带 -s 装到的是 latest，那是另一回事。
curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.13"
export PATH="$HOME/.bun/bin:$PATH"   # 安装器只写 ~/.bashrc；当前 shell 要自己 export
bun --version                        # 应为 1.3.13

# node —— 不是给 occ 用的，是 demo/lib/p61-worker.ts 真的会 spawn 它（§2.1）。
# 版本随意，取当前 LTS 即可；下面的文件名按 https://nodejs.org/dist/latest-v22.x/ 现况替换。
mkdir -p "$HOME/.local/node"
curl -fsSL https://nodejs.org/dist/latest-v22.x/node-v22.23.2-linux-x64.tar.xz \
  | tar -xJ -C "$HOME/.local/node" --strip-components=1
export PATH="$HOME/.local/node/bin:$PATH"
node --version
```

git 一般自带；没有就按发行版的常规办法装。`make` **不在这一步的必需项里**——六条命令都不
用它，只有 §4.3 表里作佐证的 AC-7 冒烟要，见 §2.1 与 §4.4。

### 4.2 六条命令

```bash
# ① 取代码
git clone <仓库地址> atlas && cd atlas

# ② 装依赖 + 构建 occ + 自检（每步打耗时，最后给总耗时）
./demo/env/bootstrap.sh

# ③ 铺种子：目录、演示密钥、两个节点工作区、AC-7 数据集
./demo/env/seed.sh

# ④ 起拓扑：注册中心 + 两个常驻节点，最后自动做一次就绪探测
./demo/env/up.sh

# ⑤ 自检：按名解析 + 真拨号 + 审计链 +（可选）发一条真消息等 ack
./demo/env/smoke.sh --with-task

# ⑥ 再跑一个本地 AC 作为端到端佐证（AC-3 最快）
export QIANMO_TRANSPORT_PSK="$(cat .demo-env/secrets/transport-psk)"
./demo/ac3-loop-rate.sh
```

停机 `./demo/env/down.sh`，回到种子态 `./demo/env/reset.sh`。

### 4.3 时间预算（本机实测，macOS / M 系列 / bun 1.3.13）

**这是一次真实跑批的数字**，方法是：从当前工作树 `git clone` 到一个新目录，把尚未提交的
P8.1 产物复制进去，然后**只按上面六条命令敲**（另加一条 AC-7 冒烟作佐证），用 `date +%s`
逐段计时。原始日志留在实施会话的临时目录，表里每一行都能对上其中一段。

| 步骤 | 实测 | 说明 |
| --- | --- | --- |
| ① `git clone` | **1 s** | 本地克隆；从远端拉取要另算网络时间 |
| ② `bootstrap.sh` | **10 s** | 前置检查 0 s + `bun install`（1717 包 / 8.35 s）9 s + `bun run build` 1 s + 自检（`bun test demo/lib`，85 pass）0 s |
| ③ `seed.sh` | **0 s** | 目录、密钥、两个 git 工作区、AC-7 数据集 |
| ④ `up.sh` | **5 s** | 含就绪探测重试（节点 A 首次拨号 3.45 s，是它还在启动） |
| ⑤ `smoke.sh --with-task` | **1 s** | 解析 12 ms / 拨号 2 ms / **ack 414 ms**；两条审计链 intact |
| ⑥ `ac3-loop-rate.sh` | **2 s** | 十条 check 全 true，`pass=true` |
| ⑦ `make -C demo p61-smoke` | **63 s** | AC-7 的 1 min 冒烟模式，**不在必需路径上**，作佐证；`pass=true` |
| **合计（①~⑦ + `down.sh`）** | **87 s（1 min 27 s）** | 距 30 min 预算有 20 倍余量 |

> **计时口径四条**（不写清楚，这张表就会被当成承诺）：
> 1. **bun 的全局缓存是热的**（`~/.bun/install/cache` 里已有本仓库的依赖），且是**本地**
>    clone。真正的全新机器要另加：依赖下载（约 938 MB 装出来，按 20 MB/s 估 1~2 min，
>    按 5 MB/s 估 5 min 以上）、从远端 clone、以及 `postinstall` 去 GitHub 下 ripgrep
>    （本次实测 1.8 MB，**它走的是外网，内网机器上这一步会卡住**）。
> 2. 这是**开发机**（macOS / Apple Silicon）的数字。CI runner 或云上 1~2 vCPU 的小机器上
>    `bun install` 与 `bun run build` 会明显更慢。
> 3. 表里没有「人读文档、装 bun、配网络」的时间。DoD 的 30 min 是给**未参与部署的成员**
>    的，那份时间要算在里面——这也是把 runbook 压到六条命令的原因。
> 4. ⑦ 的 63 s 里有 60 s 是 AC-7 冒烟模式**规定的最短时长**（`--minutes 1`），不是机器慢。

### 4.4 全新机器实测（Debian 13 x86_64 / 2 vCPU / 冷缓存 / 公网）

§4.3 那张表自己声明了四条测不到的东西（冷缓存、公网下载、小机器、装 bun 的时间）。这一节
就是去测它们的：一台**从没装过本仓库依赖**的 Debian 13 VPS，2 vCPU、2 GB 内存（约 1.5 GB
可用）+ 5 GB swap，无 bun、无 node、无 make、**无 sudo**，全部装进家目录。

| 步骤 | 实测 | 说明 |
| --- | --- | --- |
| ⓪ 装 bun 1.3.13 | **2 s** | 官方安装器 `-s "bun-v1.3.13"`，落在 `~/.bun` |
| ⓪ 装 node v22.23.2 | **4 s** | 官方 tarball 解到 `~/.local/node`。**runbook 原先只写了「node 已装」**，机器上没有，`bootstrap.sh` 前置检查当场 `FAIL : node 不在 PATH 上` —— 已补进 §4.1 |
| ① `git clone` | **3 s** | 本次走的是 `git bundle` + `scp`（73 MB / 54 s），不是公网 clone；真从远端拉要按各自的网络另算 |
| ② `bootstrap.sh` | **21 s** | 冷缓存：前置检查 0 s + `bun install --frozen-lockfile`（**1737 包 / 11.3 s**，含 `postinstall` 去 GitHub 下 ripgrep **2249 KB**）12 s + `bun run build` 8 s + 自检（85 pass）1 s。把 `~/.bun/install/cache`、`node_modules`、`dist` 全删掉复跑一次，**仍是 21 s** |
| ③ `seed.sh` | **0 s** | 与 §4.3 同 |
| ④ `up.sh` | **8 s** | 就绪探测里 node-a 首次拨号 **6513 ms**（开发机 3.45 s）—— 2 vCPU 上常驻进程起得慢，探测重试吸收掉了 |
| ⑤ `smoke.sh --with-task` | **1 s** | 解析 13 ms / 拨号 6 ms / **ack 1161 ms**（开发机 59 ms、414 ms）；两条审计链 intact；`pass=true` |
| ⑥ `ac3-loop-rate.sh` | **2 s** | 本次（`da98d86f`）**`pass=false`** —— 十条 check 里 `protocolBudgetAtLimit` 为 false（`accepted=601`，期望 600），连跑四次全红；同一 HEAD 在开发机上十条全 true。**是判据缺陷不是机器或限流器的问题，已修**（判据改为按突发用时算「顶」，见 §7.5），修后**已在这台机器上复跑 4/4 绿**（同一 HEAD 的修订量具：`sent=603 / accepted=602 / burstElapsedMs 218–250 / refillAllowance=2`，第 603 条回 `E_RATE_LIMITED`，十条 check 全 true） |
| ⑦ AC-7 冒烟 | **61 s** | `pass=true`，`resultDigest` 与 `expectedDigest` 一致，七条 check 全 true。**这台机器没有 make**，实际敲的是 `p61-smoke` 目标展开后的两条命令（`bun run demo/lib/p61-seed.ts --reset --seed 6101` + `cd demo && ./p61-e2e.sh --mode smoke --minutes 1 --chunks 4 --iterations 3`） |
| ⑧ `down.sh` | **4 s** | 三个进程全停；`pgrep` 复核无残留 |
| **合计（①~⑧）** | **100 s（1 min 40 s）** | 加上 ⓪ 的 6 s 与 bundle 传输 54 s，从「一台什么都没有的机器」到「跑完并停机」约 **2 min 40 s**。距 30 min 预算约 11 倍余量 |

**口径说明**（和 §4.3 一样，不写清楚就会被当成承诺）：

1. **谁跑的**：一个**只照本文 §4 敲命令的代理**，不是团队成员。它不看脚本源码，只在 runbook
   跑不通时才去读源码定位缺陷。所以这一轮能证明「runbook 照着敲能不能走通」，**但不能替代
   DoD 要的「由未参与部署的成员实测」**——人读文档、判断报错、决定怎么绕的时间不在表里。
2. **网络**：单流下行实测 nodejs.org **1.8 MB/s**、GitHub Releases **5.5 MB/s**；但 `bun install`
   多连接并发，1737 个包冷装只用 11.3 s，聚合带宽远高于单流。§4.3 口径①担心的「5 MB/s 要 5 min
   以上」在这台机器上没有发生，**换一台网络差的机器仍可能发生**。ripgrep 那一步走公网 GitHub，
   **本次通了**——内网机器上它照样会卡住。
3. **内存：过了，但余量薄。**全程峰值占用 **1563 MB**、最低可用 **409 MB**、swap 只动了 43 MB，
   峰值全部落在 `bun run build`（vite）那 8 s 里。**没有触发 OOM，也没走 runbook 里的降级手段**
   （`bootstrap.sh` 有 `--skip-build` / `--skip-selftest`，本次都没用上）。据此把 §2.1 的最低内存
   写成 2 GB。
4. **磁盘比 §4.3 大一截**：`node_modules` 在 Linux x64 上是 **1.4 GB**（macOS/arm64 是 938 MB），
   包数也不同（1737 vs 1717）——平台相关的可选依赖不一样。家目录总占用 2.1 GB。
5. **⑦ 的 61 s 里 60 s 仍是冒烟模式规定的最短时长**，不是机器慢；但 `compute.spanMs` 是 51 s，
   已经吃掉那 60 s 的大半——更慢的机器上这一条有撑破 1 min 窗口的余地。
6. **无模型凭据**：这台机器 `env` 里一个模型凭据都没有，也没有任何 `~/.occ` / `~/.claude` /
   `~/.qianmo` 配置根。这正好把 §7.3 一直没实测的那一半测了，结论与原先的预期**相反**，见该节。

**第二台全新机器复跑（按上表实测后修订的 runbook，只读文档不读源码）**：另一台 Debian 13 x86_64 /
2 vCPU / 1973 MB（其上已有他人服务占约 700 MB）/ 无 sudo / 无 unzip。①~⑧ 净耗时 **105 s**（bootstrap 26 s：
1737 包 14 s + build 11 s + 自检 86 pass；up 8 s，node-a 首拨 7121 ms；smoke ack **1299 ms**；AC-3 十条全 true；
AC-7 冒烟 61 s `pass=true`；down 3 s 无残留），含操作者全部往返的墙钟 **8 min 19 s**。**唯一硬卡点**：§4.1 第一条
命令因机器无 `unzip` 直接失败——已把 unzip 列进 §2.1、把 busybox 垫片写进 §4.1、故障表加一行（本次修订）；其余
六条命令与无 make 绕法**一字未改全部跑通**，`bun.lock` 未被改写。内存峰值 used **1631 MB** / 最低可用 **341 MB** /
swap 峰值 393 MB（比基线多 196 MB）——2 GB 机器上还跑着别的东西时会真的动几百 MB swap，§2.1 的「余量很薄」如是。
补上 unzip 一条之后，本 runbook 可判为「未参与部署者可复现」；DoD 里「由**成员**实测」的形式要件已按负责人决议 2026-08-17 豁免（roadmap v2.41③：两台全新机器实测已覆盖实质；原文「仍待人」见 git 历史）。

### 4.5 跑不动时先看哪

| 症状 | 多半是 | 怎么办 |
| --- | --- | --- |
| `bun install --frozen-lockfile` 失败 | lockfile 与 `package.json` 不一致，或 bun 版本不对 | 先核对 §2.2；**不要**改成不带 `--frozen-lockfile` 蒙混过去——那条参数正是用来抓这类问题的 |
| `up.sh` 报「拓扑未就绪」 | 端口被占，或节点起来就死了 | 看 `.demo-env/logs/*.err`；换端口用 §2.4 的环境变量 |
| `smoke.sh` 的 probe `resolved:false` | 注册中心没起来或租约过期 | 看 `logs/registry.err`；租约 90 s、续租 20 s 一次 |
| `smoke.sh` 的 task `acked:false` | 目标节点没收下 | 看目标节点的 `.err`；PSK 两边必须逐字相同 |
| 审计链报断链 | 多半是两个节点共用了配置根 | 见 §3.1 第 3 条 |
| `bun.sh/install` 报 `unzip is required to install bun` | 机器没有 unzip（minimal 镜像常见） | 有 sudo 就装 unzip；没有就用 §4.1 开头的 busybox 垫片，然后**原样重跑**同一条安装命令 |

---

## §5 日常操作

```bash
demo/env/up.sh                 # 起拓扑（幂等：已在跑的进程不会被重起）
demo/env/smoke.sh              # 快检：解析 + 拨号 + 审计链
demo/env/smoke.sh --with-task  # 再加一条真消息，等 ack
demo/env/smoke.sh --with-ac3   # 再跑一遍 AC-3 一键复现
demo/env/down.sh               # 停机，数据不动
demo/env/reset.sh              # 停机 + 清状态 + 重铺种子（保留密钥）
demo/env/reset.sh --rotate-secrets   # 连密钥一起换
```

**把演示凭据导进当前 shell**（跑那些自己读环境变量的 demo 时要）：

```bash
export QIANMO_TRANSPORT_PSK="$(cat .demo-env/secrets/transport-psk)"
export QIANMO_BACKUP_WRITE_TOKEN="$(cat .demo-env/secrets/backup-write-token)"
export QIANMO_BACKUP_ARCHIVE_TOKEN="$(cat .demo-env/secrets/backup-archive-token)"

./demo/ac6b-restore.sh      # AC-6(b)(c)：实测 11 条 check 全绿，恢复耗时 19 ms
./demo/p51-diagnosis.sh     # P5.1：不需要任何凭据
```

**摊到两台机器**：脚本里没有任何「同机」假设，只有默认值绑在回环上。把
`QIANMO_DEMO_HOST` 改成对外地址、两台机器各起自己那个节点、注册中心里对端的 endpoint
写成对端的真实地址即可。跨机传输本身已在两台真实机器、跨架构、走公网验证过（roadmap
v2.12），本目录的脚本**没有在双机形态下跑过**。

---

## §6 哪条腿能演哪几条 AC

| 判据 | 本地腿 | 真机腿 | 一键复现 |
| --- | --- | --- | --- |
| **AC-1** 重启后恢复上下文 | ✅（最后一条判据需模型凭据，无则明确跳过） | 同左 | `demo/ac1-restart.sh` |
| **AC-2** 跨节点唤醒 + 回执 | ⚠️ **只能演一半**：按名解析 → 投递 → ack 全都成立（`smoke.sh --with-task` 实测 ack 59 / 414 ms），但**没有休眠态**——本地进程不会冻结，而 AC-2 判据要的正是「对端处于冻结态」 | ✅ 唯一成立处 | 本地 `demo/env/smoke.sh --with-task`；真机 `demo/p41-task-result.sh` |
| **AC-3** 环路切断 + 两层限流 | ✅ | 同左 | `demo/ac3-loop-rate.sh` |
| **AC-4** 记忆跨会话检索 | ⚠️ 需模型凭据；无独立 demo 脚本，判据由 `tests/integration/qianmo-memory-recall.test.ts` 承载 | 同左 | `bun test tests/integration/qianmo-memory-recall.test.ts` |
| **AC-5** 模型中立 | ⚠️ 需两家供应商凭据 | 同左 | 见 roadmap P1.4 的记录 |
| **AC-6(a)** 沙箱越权被拒 | ❌ 本地没有沙箱 | ✅ | `demo/ac6a-sandbox.sh` |
| **AC-6(b)(c)** 删库可恢复 / 备份删不掉 | ✅ | 同左（真机还要验沙箱挂载边界，见 roadmap P4.4 的「边界」） | `demo/ac6b-restore.sh` |
| **AC-7** 数模场景端到端 | ✅ | 同左 | `make -C demo p61-smoke`（1 min 冒烟）/ `make -C demo p61`（正式） |
| **AC-8** 边界用例 + 混沌 | ✅ | 同左 | `bun test tests/boundary` + `demo/chaos-inject.sh` |
| P5.1 原因级诊断 | ✅（macOS 上 OOM 只能给中等置信，见 §2.3） | ✅ | `demo/p51-diagnosis.sh` |
| P7.3 性能基线 | ⚠️ **只作仪器校准**，report-core 会把本地数据挡在正式表外 | ✅ 正式数据唯一来源 | `demo/p73-baseline.sh` |

**结论**：本地腿能撑起 AC-1 / AC-3 / AC-6(b)(c) / AC-7 / AC-8 五条完整判据（其中 AC-3、
AC-6(b)(c)、AC-7、AC-8 连模型凭据都不需要），配上凭据再加 AC-4 / AC-5，外加 AC-2 的前半段；
**AC-2 的休眠态与 AC-6(a) 非真机不可**。

本次干净 clone 实跑中，AC-3（十条 check 全 true）与 AC-7 冒烟（`pass=true`）都在这台开发机
上一次通过，见 §4.3。

---

## §7 已知坑

### 7.1 真机腿已于 2026-08-16 首验通过（原「本任务包最大的缺口」已闭）

原状态：两个脚本从仓库记载反推、一条没在真机跑过——验收机 `workbench-host` SSH 直连不可达。
**2026-08-16 转机**：机器本身健康（串口日志佐证），坏的只是直连路径；经 **gcloud IAP 隧道**
（本机 SSH 别名 `workbench-iap`）恢复访问后在 burn-vm-01 完成首验，「`~/p41-ops/setup.sh`
取不回来」一说同时证伪（该文件在、已读取，本次 AC-2 现场准备即基于它）。

首验结果（详情与逐条出处回写在 `demo/env/remote/README.md`）：

- **`prepare-host.sh`**：修两处后 **PASS=10 / FAIL=0 / WARN=1 / exit=0**。两处缺陷都是首跑抓出：
  `dor doctor` 须以 daemon 的身份 + EnvironmentFile 跑（普通用户空环境必卡 running-as-root，
  同机同刻 11/1 vs 20/0）；守卫要 `sudo -n test -r`（0600 root:root 的文件拿调用者身份判可读
  永远为假）。剩余 1 WARN 是已知遗留②（`workbench:0.7.10` 镜像缺失）。**新发现**：root 版
  doctor 报「防火墙规则未持久化」——云元数据 DROP 规则只在内存里，重启静默丢失，待装
  `dormice-metadata-firewall` unit；roadmap P0.1 遗留③（active 但 disabled）在该机已消。
- **`prepare-sandbox.sh`**：真沙箱（gVisor，2 GB cgroup）内四节全通——`bun install` 36.68 s /
  1737 包、build 在限内成功、常驻 ALIVE、宿主实拨 38622 得 `101 Switching Protocols`。
  修一处：PSK 长度前置判（短 PSK 原本要白等 install+build 约 70 s 才被 `assertUsablePsk`
  打死；最小长度从 `handshake.ts` 现读）。沙箱实测补记：无预装 bun（README 预判对）、
  无 `ss`/`netstat`、node v24.18.0、外网可达。
- **同步姿势（重要）**：往这台机器送代码**禁止**对仓库根裸 rsync——仓库根下有 `.claude/`
  （约 21 GB worktrees）与 `.occ/`（约 6.4 GB，**内含凭据，同步出去即外泄**）。用
  `tar`（排除 `.git` / `.claude` / `.occ` / `node_modules` / `dist`）+ `scp`（实测 73 MB / 传输 68 s）。
  往沙箱送代码用 `docker cp` 或沙箱内 `git clone`——`dor sandbox push` 对 76 MB tarball
  直接报 `Request body is too large`。

### 7.2 从源码直接跑常驻起不来 ACP 子进程

`bun run src/entrypoints/cli.tsx resident` 的 ACP 子进程会连续失败五次然后被 park，整个常驻
进程随之退出——`--acp` 那条快路径由 `feature('ACP')` 把守，而 feature flag 是**编译期**注入的
（`docs/dev/baseline-m0.md` §9.4 记的就是这个）。所以 `up.sh` 用的是 `bun run build` 出来的
`dist/cli-node.js`，不是源码入口。走 `bun run dev` 也行，代价是进程树多两层。

### 7.3 `smoke.sh --with-task` 的结果字段只是观测

`pass` 只看 **ack**。`task.result` 的 `outcome` 是观测字段，不是判据——它不影响拓扑判定。
要端到端的结果，跑真机腿或带凭据的 AC-7 链路。

**v0.2 勘误：原先写的「无凭据的机器上它应当是 `failed`」是推测，而且推错了。**§4.4 那台
Debian 机器上 `env` 里没有任何模型凭据、也没有任何 `~/.occ` / `~/.claude` / `~/.qianmo`
配置根，`resultOutcome` **照样是 `completed`**（ack 1161 ms）。所以这个字段并不能用来判断
「这台机器上有没有配模型」——它到底反映了什么还没查清（多半是这条链路上的 result 根本
没走到真模型调用）。**在查清之前，不要拿它作任何结论**，包括不要拿它当「凭据配好了」的
旁证。

### 7.4 `check:unused` 只在主检出作数

在 git worktree 里跑 `bun run check:unused` 会得到约 76 个「未使用文件」的**假阳性**，根因与
处置见 `CLAUDE.md` §3.1。本任务包新增的两个 TS runner 已加进 `knip.json` 的入口图。

### 7.5 AC-3 一键复现在慢机器上判红（**§4.2 第 ⑥ 条；已修，慢机器复跑 4/4 绿**）

**现象**（`da98d86f` 及更早）：§4.4 那台 2 vCPU 的 Debian 上，`demo/ac3-loop-rate.sh`
**确定性判红**（连跑四次，`pass=false`），红的是十条 check 里的 `protocolBudgetAtLimit`：
`budget.accepted=601`，而判据要它等于 `perMinute=600`。同一个 HEAD 在开发机（macOS / arm64）
上十条全 true。

**根因不在限流器，在判据的隐含假设。**`InboundBudget` 是**连续补充**的令牌桶
（`packages/router/src/rate.ts`，容量 600 / 窗口 60 s，即**每 100 ms 回一个令牌**，注释里写明
是刻意不用固定窗口的）。而旧的 `runInboundBudget` 连发 `LIMITS.ratePerMinute + 1 = 601` 条，
要第 601 条被拒——这只有在**整个 601 条的突发在 100 ms 内发完**时才成立。开发机跑得进
（实测整段突发 **23 ms**），2 vCPU 的机器跑不进，于是期间补回一个令牌，第 601 条被正常放行。
`accepted` 的上限就是发出去的 601 条，再慢也不会涨到 602，所以这个红是「非黑即白」的。

**修法（P4.2 面，`demo/lib/ac3-{loop-rate,report-core}.ts`）**：不冻结时钟、不放宽判据，
而是让判据断言令牌桶**自己的契约**：

- 发送方一条接一条发到**第一次被拒为止**（上限 2 × `perMinute`，到顶还没被拒就判红），并按
  `Date.now()` 记下突发用时 `burstElapsedMs`——与桶读的是同一个时钟，且区间包住桶从建立到
  拒绝的整段，所以据此算出的回补量是桶实际回补量的**上界**；
- report-core 算 `refillIntervalMs = 60_000 / perMinute`、`refillAllowance =
  floor(burstElapsedMs / refillIntervalMs)`，判据为：`refusedCode === E_RATE_LIMITED`
  ∧ `accepted === sent − 1`（被拒之前一条不漏、被拒即停）∧ `perMinute ≤ accepted ≤ perMinute +
  refillAllowance` ∧ `senderAgents > 1`。开发机上 `burstElapsedMs < 100`，`refillAllowance = 0`，
  判据退化回原先的 `accepted === 600`，一个数都不差；慢机器上 `accepted` 会是 600 加上突发期间
  真正补回的令牌数，报告里 `sent` / `burstElapsedMs` / `refillAllowance` 三个数摆在一起自洽。

**验证**（开发机，人为放慢突发——在每条发送后临时插入 `Bun.sleep`，不入库）：1 ms/条 →
`sent=609, accepted=608, burstElapsedMs=842, refillAllowance=8`、`pass=true`；5 ms/条 →
`sent=637, accepted=636, burstElapsedMs=3663, refillAllowance=36`、`pass=true`——上界贴着实际
回补量走，没有松动。反向：把接收方预算临时改成 5000/min，`sent=1200, accepted=1200`、无
`refusedCode`、`protocolBudgetAtLimit=false`，红得对。用 `yes` 把全部核心压满只能把突发拖到
66 ms，仍在一个回补间隔内，说明开发机上光靠 CPU 加压复现不了慢机器的红，所以才用插 sleep。
**§4.4 那台 Debian 上的复跑已做（2026-08-15，主 agent）**：把修订后的 `demo/lib/ac3-*.ts` 与 `demo/ac3-loop-rate.sh` 复制到该机同一检出上连跑四次，全部 `pass=true`：`sent=603 / accepted=602 / burstElapsedMs` 218 / 245 / 247 / 250 ms / `refillAllowance=2`——桶在突发期间确实多回补了 2 个令牌，判据上界与之贴合；被拒那条码为 `E_RATE_LIMITED`。

**仍然要记住的一条**：这条判据要求机器**每条消息快过一个回补间隔**（< 100 ms/条，比原先
「601 条 100 ms 内发完」松 600 倍），且在 2 × `perMinute` 条内到顶。慢过这个的机器会以
`sent=1200`、无 `refusedCode` 判红——那时红的是机器，不是限流器，看 `burstElapsedMs` 就能分辨。

### 7.6 `.demo-env/` 永不入库

已加进 `.gitignore`。里面有演示密钥（0600）与节点身份私钥——**任何时候看到它出现在
`git status` 的待提交列表里，都是先修 `.gitignore` 而不是 `git add`。**

---

## §8 后续动作

| # | 动作 | 阻塞在 | 归属 |
| --- | --- | --- | --- |
| 1 | ~~未参与部署的成员按 §4 实测一遍并计时（DoD 的正式判据）~~ **已豁免**（负责人决议 2026-08-17，roadmap v2.41③） | 无 | P8.1 owner |
| 2 | ~~真机腿两个脚本在验收机上跑通并回写 `demo/env/remote/README.md`~~ **已完成**（2026-08-16，§7.1，roadmap v2.39④） | `workbench-host` 可达 | P8.1 owner |
| 3 | 双机形态（两台机器各一个节点）实跑一次 | 第二台机器 | P8.2 |
| 4 | 把 P7.2 后四层 sink（协商 / 隧道 / 备份 / 扩容）接进 `up.sh` 的启动路径 | 无 | P8.2（roadmap 已把这件事记在 P7.2 的「留给 P8.2」里） |
