#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P11.1 落地包① —— 内测环境公共层。**被 source，不单独执行。**
#
# 这里定死四件事，其余脚本一律从这里取，不各写一份：
#   ① 内测根目录 BETA_ROOT 与它下面的目录布局（beta-env.md §4.1）；
#   ② 配置隔离——每个常驻进程一个 OCC_CONFIG_DIR，全都在 BETA_ROOT 里，
#      **绝不碰用户真实的 ~/.occ / ~/.qianmo / ~/.claude**；
#   ③ 端口、节点名、智能体名的默认值与环境变量覆盖口（beta-env.md §2.6）；
#   ④ 删除动作的三重守卫（guard_root + 标记文件首行 + 逐路径复核）。
#
# 它是 demo/env/common.sh 的**同形派生**：布局、守卫、pid/日志 helper 的形状一律照抄。
# 照抄不是偷懒——那套守卫已经用六个负向用例实测过（demo-env.md §3.2），重写一遍等于
# 把那六次实测作废。
#
# ── 为什么每个常驻进程要有自己的配置根（不是一个共用） ──────────────────────
# 审计链是**按配置根**落一个文件的（`occConfigPath('qianmo','audit','trail.ndjson')`，
# 见 src/services/qianmo/auditTrail.ts）。两个常驻进程共用一个配置根，就是两条哈希链
# 交替写进同一个文件，`occ audit --verify` 必然报断链——而那时候人会去查「谁改了审计
# 文件」，其实只是拓扑搭错了。节点身份（`qianmo/identity/<node>.json`）与常驻会话表
# 同理。内测是一机一节点，本来就天然分家；这一层仍然保留，是为了另外两件事：
#   · H 上不跑常驻，但注册中心与控制台各自也要一个配置根（注册表快照落
#     `<配置根>/registry/agents.json`，chat store 落 `<配置根>/qianmo/console/`）；
#   · L4 整机重建时「恢复配置根」是一个可以整目录 tar 的动作（beta-env.md §6 L4 第③步），
#     四台机器的路径形状不一致，那一步就没法照做。
#
# ── 与演示环境的四处不同（每一处都有代价，不要顺手统一回去） ────────────────
# ① **根目录默认在仓库外**（$HOME/qianmo-beta）。内测环境是长驻的：它要活过 `git clean`、
#    活过换分支、活过仓库被重新 clone。演示环境的 `.demo-env` 放仓库里，是因为它活 87 s。
# ② **PSK 绝不在本机自动生成。**演示环境的 seed.sh 会现生成一把，因为演示那两个节点在
#    同一台机器上、共用那一把。内测是**每节点一把、由 H 生成后分发**（beta-env.md §8.3）：
#    在节点机上自动生成，得到的是一个能起来、能监听、但 H 永远拨不通的节点——而它在名册
#    上还显示「在线」（§9.1）。这是本包里最容易造出来的那个坏形状，所以这里宁可起不来。
# ③ **reset 不删配置根，只改名归档。**配置根里装着审计链，而审计链「内测全程不清」（§5）、
#    「只能挪走不能撤销」（§6.4）。一个会 `rm -rf` 配置根的 reset 与那两条直接冲突，所以这里
#    把删改成 rename——那正是 §6 L2 第②步「改名成 config.bad-<ISO> ← 不删！」的动作。
# ④ **地址表落 $QIANMO_BETA_ROOT/peers.conf，不进仓库。**beta-env.md 文首那条「本文不写机器名 /
#    IP / SSH 别名 / 域名 / 任何一把真实密钥」对脚本同样成立：注册中心要 `--register
#    <地址>=<端点>`，而端点里有 IP。表放在根目录下（0600），仓库里只有一份带占位符的模板。
#
# ── 链路：直连是默认，SSH 隧道是兜底 ─────────────────────────────────────────
# 节点入站端口对 H 开放时，peers.conf 里的端点就是节点机的真实地址，什么都不用搭。
# 现场不是这样：三台节点的入站端口被云厂商安全组挡着（实测 22/80/443 通，入站端口与
# 另外十个候选端口全不通）。于是 peers.conf 允许给某个节点加一条 **node 坐标行**，
# beta-up.sh 看到它就建一条 `ssh -L` 到该节点回环的 systemd --user 隧道，并把该节点的
# 审计链按 5 min 单向只读拉成镜像。**有坐标行才走隧道，没有就保持直连**——隧道是
# 「没有直连时的兜底」，不是默认形态（node-provisioning.md §0 第 12 条的控制面 / 数据面分工）。
#
# 单元文件、定时器与拉取脚本一律**从仓库 demo/env/beta/ops/ 派生**，装好的那几份是
# 生成物：手改会在下一次 beta-up.sh 时被覆盖。真源在仓库，不在 H 上。

# shellcheck shell=bash
# shellcheck disable=SC2034
#   ↑ 本文件是被 source 的公共层：下面这些变量的消费者是 beta-up / beta-down /
#     beta-reset / beta-smoke 四个脚本，shellcheck 只能顺着 `source=` 往下看、看不到
#     反方向，于是每一个都报「appears unused」。demo/env/common.sh 有同样的 12 条
#     （已实测），差别只是那边没写这行注解。**只在本文件禁用它**，四个消费脚本仍然全开。

# 被 source 时 BASH_SOURCE[0] 是本文件路径。beta/ 在 demo/env/ 下面，所以仓库根是 ../../..。
QIANMO_BETA_ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$QIANMO_BETA_ENV_DIR/../../.." && pwd)"
export REPO_DIR

# 内测根目录。**长驻**，默认在家目录下而不是仓库里（见文件头第①条）。
BETA_ROOT="${QIANMO_BETA_ROOT:-$HOME/qianmo-beta}"

# ── 拓扑参数：改这些不用改脚本 ───────────────────────────────────────────────
# 端口段 38620–38629，与演示环境的 38610–38613 不重叠——H 上可以同时留着演示拓扑
# （复现 AC 用）和内测拓扑，互不打架（beta-env.md §2.6）。
BETA_REGISTRY_PORT="${QIANMO_BETA_REGISTRY_PORT:-38620}"
BETA_CONSOLE_PORT="${QIANMO_BETA_CONSOLE_PORT:-38621}"
BETA_NODE_PORT="${QIANMO_BETA_NODE_PORT:-38625}"

# H 上这两个进程**永不出回环**：注册中心零鉴权（beta-env.md §9.2），控制台没有 TLS
# 也没有限流（§2.5），对外那一面由反向代理承担。把它们绑到非回环地址，等于把 §2.5
# 与 §9.2 两条硬规矩同时废掉。
BETA_HOST_BIND="${QIANMO_BETA_HOST_BIND:-127.0.0.1}"

# 节点入站绑哪。**默认 0.0.0.0，是有意的**：节点要被 H 拨到，而无 sudo 的 VPS 上没有
# 包过滤，38625 本来就必然对全网开放（beta-env.md §2.6）——那个端口上唯一的门是 PSK
# 握手，这也正是 §8 每节点一把 PSK 的由来。改成 127.0.0.1 会得到一个「起得来、名册上
# 在线、H 拨不通」的节点，即 §9.1 那条最会骗人的形状。本机自验时才覆盖它。
BETA_NODE_BIND="${QIANMO_BETA_NODE_BIND:-0.0.0.0}"

# 节点名与 agent 名一律是参数。这里给的是 beta-env.md §2.2 的定案默认值
# （节点名 beta-1~beta-4，名字里不含机器名与架构；agent 按用途分不按人分），
# 具体是哪一个由 `--node` / `--agent` 给。脚本里没有任何机器名、IP、域名、密钥。
BETA_NODE="${QIANMO_BETA_NODE:-beta-1}"
BETA_AGENTS="${QIANMO_BETA_AGENTS:-planner reviewer}"
BETA_TEAM="${QIANMO_BETA_TEAM:-atlas}"

# 页头标签是唯一一个 50 个人都会看到、且不需要账号体系的广播位（§7.4）。
# 它持久化在 <内测根>/console.conf（0600）；环境变量仍然优先，且会被回写。
# 节点、审计路径和唤醒目标不在 console.conf，也没有环境变量覆盖：它们只能从
# peers.conf 的当前名册派生，删掉一个 peer 因而不可能留下隐蔽的控制台目标。
BETA_LABEL="${QIANMO_BETA_LABEL:-}"

# 备份快照间隔：内测期从默认 15 min 调到 60 min（§5 的定案，算过账的：15 min 间隔
# 是 3.8 GB/天，H 上既放不下也没人看）。代价是一次删库最多丢 60 min 的工作。
BETA_BACKUP_INTERVAL_MS="${QIANMO_BETA_BACKUP_INTERVAL_MS:-3600000}"
# 节点往 H 写快照的地址（§2.7，必须 https）。**没有默认值**：它是一个域名，按文首纪律
# 不进仓库；不设就不开备份面，脚本会明说。
BETA_BACKUP_URL="${QIANMO_BETA_BACKUP_URL:-}"
# 节点进程的 oom_score_adj（0~1000，或 off）。默认 1000：内存打满时让内核**先挑阡陌**，
# 而不是同机的代理、nginx 或别人的服务。理由写在 beta_raise_oom_score 那里。
BETA_OOM_SCORE_ADJ="${QIANMO_BETA_OOM_SCORE_ADJ:-1000}"
# 写到哪里。只为用例留的缝：真机上永远是 /proc/self/oom_score_adj。
BETA_OOM_ADJ_PATH="${BETA_OOM_ADJ_PATH:-/proc/self/oom_score_adj}"

# ── 目录布局（beta-env.md §4.1）。改这里等于改全套脚本 ───────────────────────
BETA_RUN_DIR="$BETA_ROOT/run"
BETA_LOG_DIR="$BETA_ROOT/logs"
BETA_STATE_DIR="$BETA_ROOT/state"
# 下面三项是宿主侧保留工具唯一可操作的数据面。它们从内测根派生，不接受任意路径参数：
# backup store 在 H 上、沙箱挂载之外；registry-agents.json 是 beta-up 实际交给 p81 registry
# 的落盘表；snapshots/ 是升级前注册表副本的固定位置（beta-env.md §5 / §6 L1）。
BETA_BACKUP_STORE="$BETA_ROOT/backups"
BETA_REGISTRY_STATE="$BETA_STATE_DIR/registry-agents.json"
BETA_REGISTRY_SNAPSHOT_DIR="$BETA_STATE_DIR/snapshots"
BETA_SECRET_DIR="$BETA_ROOT/secrets"
BETA_PEER_SECRET_DIR="$BETA_SECRET_DIR/peers"
BETA_WORKSPACE_DIR="$BETA_ROOT/workspaces"
BETA_NODES_DIR="$BETA_ROOT/nodes"
BETA_MIRROR_DIR="$BETA_ROOT/mirror"
# 链路的生成物：每节点一份 0600 的连通定义 + 三个从仓库派生的 systemd 单元 + 拉取脚本。
BETA_OPS_DIR="$BETA_ROOT/ops"
BETA_MARKER="$BETA_ROOT/.qianmo-beta-env"
BETA_MARKER_MAGIC='qianmo-beta-env/v1'

# 控制台持久化配置只保存页头标签；当前节点与路径由 peers.conf 派生。
BETA_CONSOLE_CONF="$BETA_ROOT/console.conf"

# ── 链路参数 ─────────────────────────────────────────────────────────────────
# 仓库里那份模板在哪。**真源是它，不是 H 上装好的那几份。**
BETA_OPS_SRC_DIR="$QIANMO_BETA_ENV_DIR/ops"
# systemd --user 的单元目录。用 XDG 变量而不是写死 ~/.config：那个变量本来就是它的定义。
BETA_SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
# H 上那两个长驻进程的单元名。它们不是模板单元（一台 H 各只有一个），所以没有 @。
# 单元名只在这里拼一次：beta-up.sh 派生、beta-down.sh 提示、beta-reset.sh 清理都从
# 这里取，三处各写一遍迟早分叉，而分叉的症状是「reset 说清干净了、下次开机它又回来」。
BETA_REGISTRY_UNIT='qianmo-registry.service'
BETA_CONSOLE_UNIT='qianmo-console.service'
# 隧道与镜像共用的那把 key。**私钥永不离开 H**，这里只存路径，不存内容。
# 它在各节点的 authorized_keys 里带强制命令（restrict + permitopen + command="cat -- <链>"），
# 所以它既拨不了别的端口，也读不了别的文件——镜像因此只能走 `ssh cat`（见 ops/mirror-pull.sh）。
BETA_SSH_KEY="${QIANMO_BETA_SSH_KEY:-$HOME/.ssh/id_ed25519_qianmo}"
# 审计镜像的拉取间隔（分钟）。H 腿把它作为命名审计源的显式元数据传给控制台，
# 每个镜像源卡片都会显示「滞后 ≤ N min」。
BETA_MIRROR_INTERVAL_MIN="${QIANMO_BETA_MIRROR_INTERVAL_MIN:-5}"

# 地址表（见文件头第④条）。0600，不进仓库。
BETA_PEERS_FILE="${QIANMO_BETA_PEERS_FILE:-$BETA_ROOT/peers.conf}"

# 每节点那一把 PSK（节点机上**只有本机这一把**，§8.3）。
BETA_PSK_FILE="$BETA_SECRET_DIR/transport-psk"
# 控制台两枚 token。**一律显式提供、绝不用自动生成的**（§3.2）：自动生成的每次重启都变，
# 而控制台会因为改 --label / 改 --audit / 跟随升级而重启，每重启一次 50 个人手上的链接
# 同时失效。落成文件就是「显式」的持久形式。
BETA_VIEW_TOKEN_FILE="$BETA_SECRET_DIR/console-view-token"
BETA_ADMIN_TOKEN_FILE="$BETA_SECRET_DIR/console-admin-token"
# 审计见证的**写** token（P11.4）。节点机上是见证机发下来的那一枚；见证机自己的那一份由
# ops/witness-endpoint.sh install 生成。只在节点腿、且尾参里有 --witness-url 时才读。
BETA_WITNESS_WRITE_FILE="$BETA_SECRET_DIR/witness-write-token"
# 审计见证的**读** token。只在 H 腿、且控制台尾参的 --anchors 是 http(s) 端点时才读：
# 见证不在 H 上时，控制台要凭它把锚点读回来，才画得出「完整且已见证」。
BETA_WITNESS_READ_FILE="$BETA_SECRET_DIR/witness-read-token"
# 注册中心的写 token（P15.8）。**文件在才启用**：有它，注册中心的写操作（登记、注销、
# 心跳、发布吊销清单）要带 `Authorization: Bearer`，控制台的续租者也带上它；没有它，
# 注册中心与此前一样不鉴权（H 腿 WARN 一句）。**不自动生成**：启用分先后——控制台先带上
# （旧注册中心不看这个头），注册中心再开始要求——由运维按 README「注册中心写 token」放置。
# 注册中心与控制台都在 H 上，读的是同一个文件。
BETA_REGISTRY_WRITE_TOKEN_FILE="$BETA_SECRET_DIR/registry-write-token"
# 备份两枚 token。**归档 token 永不离开 H**（§2.7），所以节点机上只会有 write 那一份。
BETA_BACKUP_WRITE_FILE="$BETA_SECRET_DIR/backup-write-token"
BETA_BACKUP_ARCHIVE_FILE="$BETA_SECRET_DIR/backup-archive-token"
# 该机那一份模型凭据，形如 `KEY=VALUE` 的 shell 片段（0600）。**只在节点机上有用**：
# 它由 beta-up.sh 的节点腿在起 resident **之前**注入，ACP 子进程继承 resident 起来那一刻
# 的环境（`defaultSpawnAcp` 传的是 `{...process.env}`），所以这是唯一到得了 agent 轮次的
# 时机——事后在别的 shell 里 export 一次到不了它。
#
# 这个文件此前一直在四台节点机上躺着、**从来没有被任何脚本读过**（issue #13）：链路整条
# 走通（信封送达、回执 accepted、审计链新增、ACP 子进程开出真实 agent turn），而那一轮
# 必然是 `Not logged in · Please run /login`（`authentication_failed`，usage 全 0）。
# H 腿**不注入**：控制台不跑 agent 轮次，给它模型凭据只是多一份可被读走的副本。
BETA_MODEL_ENV_FILE="$BETA_SECRET_DIR/model-env"

BETA_REGISTRY_URL="http://${BETA_HOST_BIND}:${BETA_REGISTRY_PORT}"

# demo/lib 的入口解析（`demo_entry`）。实现与理由都在 demo/lib/entry.sh —— 那一份被
# demo/env/、demo/env/beta/ 与 demo/*.sh 三批脚本共用，这里只是把它接进来。
#
# **缺文件时不在这里死。**本文件会被从树外 source：beta-deploy.sh 要先把自己和
# common.sh 拷出仓库树再跑（不然它会在替换那棵树的中途把自己删掉，见
# ops/legacy-deploy-shim.sh），那份局部拷贝旁边没有 demo/lib/。在 source 阶段 `set -e`
# 掉，症状是「脚本什么都没输出就退了」，而真正用不上 demo_entry 的调用方（部署脚本
# 一个 demo 入口都不跑）会因此整个跑不起来。改为把失败推迟到**真的去解析入口**的那
# 一刻，那里才说得清缺的是什么。
if [ -f "$REPO_DIR/demo/lib/entry.sh" ]; then
  # shellcheck source=demo/lib/entry.sh
  . "$REPO_DIR/demo/lib/entry.sh"
else
  demo_entry() {
    beta_die "要解析 demo 入口 ${1}，但这棵树里没有 ${REPO_DIR}/demo/lib/entry.sh。
本文件是从仓库树外被 source 的（部署脚本会这么做），那种形态下解析不了 demo 入口——
要跑 demo 入口，请在完整的树里跑。"
  }
fi

# 控制台**实际**绑上的地址。**没有 BETA_CONSOLE_URL 这个常量**，是有意的：由
# BETA_HOST_BIND + BETA_CONSOLE_PORT 拼出来的那个串是**覆盖之前**的默认值，而尾参
# 透传可以改掉 `--hostname` / `--port`（beta-up.sh 文件头：「透传参数一律追加在最后…
# 最后一个赢」）。拿默认值去探活，一次成功的部署会被报成失败：实测把控制台部到
# `-- --hostname 0.0.0.0 --port 80` 之后，脚本探 127.0.0.1:38621 收到 000 并 beta_die，
# 而那一刻控制台正在 :80 上对公网答 200、名册 8 条全在线。那是最坏的一类假红——
# 它出现在部署的最后一步，读起来像「控制台起不来」，人会照着这句话去重启一个本来
# 好着的进程。
#
# 用法：`beta_console_url_from_args "${console_args[@]}"`，传**最终**那张参数表。
# 扫描规则与被调命令的解析器一致（src/cli/handlers/consoleArgs.ts 是逐个赋值的
# 循环，后出现的覆盖先出现的），两种写法都认：`--port 80` 与 `--port=80`。
beta_console_url_from_args() {
  local host="$BETA_HOST_BIND" port="$BETA_CONSOLE_PORT" prev='' one
  for one in "$@"; do
    case "$prev" in
      --hostname) host="$one" ;;
      --port) port="$one" ;;
    esac
    case "$one" in
      --hostname=*) host="${one#--hostname=}" ;;
      --port=*) port="${one#--port=}" ;;
    esac
    prev="$one"
  done
  # 通配地址是「绑哪些网卡」，不是「拨哪个地址」。0.0.0.0 在 Linux 上碰巧能连、在别的
  # 平台上不能，探活不该赌这个；控制台绑通配时，回环一定在它的覆盖范围里。
  case "$host" in
    0.0.0.0 | '*' | '::' | '[::]') host='127.0.0.1' ;;
    # IPv6 字面量在 URL 里必须加方括号，否则 `http://::1:38621` 里的冒号谁都分不清哪个
    # 是端口分隔符。判据与被调命令那边一致（console.ts 的 httpOrigin 也是这么括的）。
    # **先放行已经带括号的**：少了这一支，`--hostname '[::1]'` 会被括成 `[[::1]]`。
    \[*\]) ;;
    *:*) host="[${host}]" ;;
  esac
  printf 'http://%s:%s' "$host" "$port"
}

# H 上那两个不跑常驻的进程也各要一个配置根（见文件头）。
BETA_CONFIG_REGISTRY="$BETA_NODES_DIR/registry/config"
BETA_CONFIG_CONSOLE="$BETA_NODES_DIR/console/config"

# ── 审计链路径 ───────────────────────────────────────────────────────────────
#
# 权威副本永远是**节点本机**配置根里那一份；H 上 mirror/ 下那几份是单向只读镜像，
# 不是权威副本（beta-env.md §4.3 第三条）。哈希链在镜像上照样能验（验的是内容），
# 控制台对每个命名来源传入显式镜像元数据，并在对应来源卡片显示其允许滞后。
beta_node_trail()   { printf '%s/%s/config/qianmo/audit/trail.ndjson' "$BETA_NODES_DIR" "$1"; }
beta_mirror_trail() { printf '%s/%s/trail.ndjson' "$BETA_MIRROR_DIR" "$1"; }

# occ 的构建产物。与演示环境同一条：`bun run build` 产出，`demo/env/bootstrap.sh` 造。
BETA_OCC="$REPO_DIR/dist/cli-node.js"

# 进程名：pid 与日志文件都用它。节点腿那个是节点名本身（一机一节点，不会撞）。
BETA_REGISTRY_PROC='registry'
BETA_CONSOLE_PROC='console'

# ── 输出与计时 ───────────────────────────────────────────────────────────────

beta_say()  { printf '%s\n' "$*"; }
beta_head() { printf '\n=== %s ===\n' "$*"; }
beta_ok()   { printf 'OK   : %s\n' "$*"; }
beta_warn() { printf 'WARN : %s\n' "$*"; }
beta_todo() { printf 'TODO : %s\n' "$*"; }
beta_die()  { printf 'FAIL : %s\n' "$*" >&2; exit 1; }

# 秒级时刻。`date +%s` 到处都有，不引 GNU 专有格式（macOS 自带的 date 没有 `-d`）。
beta_now() { date +%s; }

# beta_elapsed <起始秒> —— 打印形如 `1m12s` 的耗时。
beta_elapsed() {
  local total=$(( $(beta_now) - $1 ))
  printf '%dm%02ds' $((total / 60)) $((total % 60))
}

# UTC 时间戳，用作归档目录后缀。冒号不进文件名（Windows 共享与 tar 上都会咬人）。
beta_stamp() { date -u '+%Y%m%dT%H%M%SZ'; }

# ── 守卫①：根目录本身 ───────────────────────────────────────────────────────
#
# 一键重置会在这个目录下面动东西，所以这道检查是它的全部安全性所在：
# 拒绝根目录、家目录、仓库本身，以及任何真实配置根的内部。
beta_guard_root() {
  local root="$1"
  [ -n "$root" ] || beta_die 'QIANMO_BETA_ROOT 为空'
  case "$root" in
    /*) ;;
    *) beta_die "QIANMO_BETA_ROOT 必须是绝对路径：$root" ;;
  esac
  case "$root" in
    *..*) beta_die "QIANMO_BETA_ROOT 里有 ..，拒绝：$root" ;;
  esac
  case "$root" in
    /|/root|/home|/Users|/tmp|/var|/etc|/usr|/opt|/srv)
      beta_die "QIANMO_BETA_ROOT 不能是 $root"
      ;;
  esac
  if [ "$root" = "$HOME" ]; then beta_die 'QIANMO_BETA_ROOT 不能是家目录'; fi
  if [ "$root" = "$REPO_DIR" ]; then beta_die 'QIANMO_BETA_ROOT 不能是仓库根本身'; fi
  case "$root" in
    "$HOME"/.occ|"$HOME"/.occ/*|"$HOME"/.qianmo|"$HOME"/.qianmo/*|"$HOME"/.claude|"$HOME"/.claude/*)
      beta_die "QIANMO_BETA_ROOT 落在真实配置根里：$root"
      ;;
  esac
  # 用户若用 OCC_CONFIG_DIR / CLAUDE_CONFIG_DIR 把真实配置根挪到了别处，上面那三个
  # 字面量就拦不住——这里按调用方进入本脚本时的环境再拦一次（内测自己的按节点
  # OCC_CONFIG_DIR 是之后由各腿逐个设的，不会走到这里）。
  local outer
  for outer in "${OCC_CONFIG_DIR:-}" "${CLAUDE_CONFIG_DIR:-}"; do
    [ -n "$outer" ] || continue
    case "$root" in
      "$outer"|"$outer"/*)
        beta_die "QIANMO_BETA_ROOT 落在当前环境的真实配置根里：${root}（${outer}）"
        ;;
    esac
  done
  # 内测机器上真的会有人拿同一台机器跑演示拓扑（H 上就是这么安排的，§2.6）。
  # 演示根目录被当成内测根目录传进来，后果是内测的 reset 去动演示环境的数据。
  if [ -f "$root/.qianmo-demo-env" ]; then
    beta_die "$root 是**演示**环境根（有 .qianmo-demo-env），不是内测环境根"
  fi
  return 0
}

# ── 守卫②：标记文件首行 ─────────────────────────────────────────────────────
#
# 标记文件在，才认这个目录是内测环境。没有标记就拒绝——不去猜「这大概是我上次建的」，
# 猜错一次就是动了别人的目录。
beta_require_marker() {
  beta_guard_root "$BETA_ROOT"
  [ -f "$BETA_MARKER" ] \
    || beta_die "$BETA_ROOT 不是内测环境（缺 ${BETA_MARKER}）——先跑 demo/env/beta/beta-up.sh"
  head -1 "$BETA_MARKER" | grep -qF "$BETA_MARKER_MAGIC" \
    || beta_die "$BETA_MARKER 的首行不是 ${BETA_MARKER_MAGIC}，拒绝操作"
  return 0
}

# ── 守卫③：逐路径复核 ───────────────────────────────────────────────────────
#
# 守卫写在删除 / 改名动作**旁边**，而不是只写在脚本开头——中间任何一次变量赋值出错，
# 这里都还能拦住。beta-down / beta-reset 的每一个待处理路径都要过它。
beta_assert_inside_root() {
  local target="$1"
  [ -n "$target" ] || beta_die '待处理路径为空，拒绝'
  case "$target" in
    "$BETA_ROOT"/*) ;;
    *) beta_die "拒绝处理 QIANMO_BETA_ROOT 之外的路径：$target" ;;
  esac
  case "$target" in
    *..*) beta_die "路径里有 ..，拒绝：$target" ;;
  esac
  return 0
}

# ── 目录骨架与标记 ───────────────────────────────────────────────────────────
#
# **不生成任何密钥**（见文件头第②条）。这里只铺目录、写标记、放一份地址表模板。
# 幂等：已在的东西一律不动。
beta_seed_root() {
  beta_guard_root "$BETA_ROOT"
  mkdir -p "$BETA_ROOT"
  chmod 700 "$BETA_ROOT"
  mkdir -p "$BETA_RUN_DIR" "$BETA_LOG_DIR" "$BETA_STATE_DIR" "$BETA_BACKUP_STORE" \
    "$BETA_WORKSPACE_DIR" "$BETA_NODES_DIR" "$BETA_MIRROR_DIR"
  mkdir -p "$BETA_SECRET_DIR" "$BETA_PEER_SECRET_DIR"
  chmod 700 "$BETA_SECRET_DIR" "$BETA_PEER_SECRET_DIR"
  # ops/ 里是每节点的连通定义（含 SSH 用户与机器地址），与 secrets/ 同级别对待。
  mkdir -p "$BETA_OPS_DIR"
  chmod 700 "$BETA_OPS_DIR"

  if [ ! -f "$BETA_MARKER" ]; then
    {
      printf '%s\n' "$BETA_MARKER_MAGIC"
      printf 'created-at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      printf 'repo=%s\n' "$REPO_DIR"
      printf '# 这个文件是 demo/env/beta/beta-reset.sh 与 beta-down.sh 的安全依据：\n'
      printf '# 没有它，两个脚本都拒绝动这个目录里的任何东西。\n'
    } >"$BETA_MARKER"
    chmod 600 "$BETA_MARKER"
    beta_ok "标记文件已建：$BETA_MARKER"
  fi

  if [ ! -f "$BETA_PEERS_FILE" ]; then
    beta_write_peers_template
    beta_ok "地址表模板已建：${BETA_PEERS_FILE}（**里面是占位符，要按运维单页填**）"
  fi
  return 0
}

# 地址表模板。**只有占位符**——真实机器名 / IP / 域名 / SSH 用户按 beta-env.md 文首的
# 纪律只存运维单页，不进仓库，也不由脚本猜。
beta_write_peers_template() {
  {
    printf '# 阡陌内测地址表 —— 注册中心的 --register、冒烟的 --expect、以及隧道与\n'
    printf '# 审计镜像的连通定义，全部读它。\n'
    printf '#\n'
    printf '# 三种行，都用空白分隔字段；# 开头是整行注释。\n'
    printf '#\n'
    printf '# ① 地址行（老格式，一直没变）：<地址> <入站端点>\n'
    printf '#      地址形如 qianmo://<node>/<agent>，端点形如 ws://<节点机地址>:%s。\n' "$BETA_NODE_PORT"
    printf '#\n'
    printf '# ② node 坐标行（**可选**）：node <节点名> <键>=<值>...\n'
    printf '#      给了它，H 就为该节点建一条 systemd --user 的 SSH 隧道（本地回环 →\n'
    printf '#      节点回环的入站端口），并按 %s min 单向只读拉一次它的审计链镜像。\n' "$BETA_MIRROR_INTERVAL_MIN"
    printf '#      **不给就保持直连**——隧道是「直连不通时的兜底」，不是默认形态。\n'
    printf '#\n'
    printf '#      键：user=      SSH 用户（必填）\n'
    printf '#          host=      节点机地址（必填）\n'
    printf '#          port=      SSH 端口（默认 22）\n'
    printf '#          local-port=H 这一侧的回环口（必填，四个节点必须各不相同）\n'
    printf '#          remote-port=节点侧的入站端口（默认 %s）\n' "$BETA_NODE_PORT"
    printf '#          trail=     节点上审计链的绝对路径；给了才做镜像\n'
    printf '#          server=    这台机器在控制台上显示成什么（可选，默认取 host=）。\n'
    printf '#                     想要一个稳定短名（p11）而不是跟着 IP 变，就写它。\n'
    printf '#          key=       这条链路用的私钥（默认 QIANMO_BETA_SSH_KEY）\n'
    printf '#          witness-port=审计见证端点的端口（可选，常用 38640）。给了，隧道同一条会话里\n'
    printf '#                     多一个 -R 127.0.0.1:<口>:127.0.0.1:<口>，节点经它把锚点写到 H；\n'
    printf '#                     节点侧 authorized_keys 那一行要带 permitlisten="127.0.0.1:<口>"。\n'
    printf '#          public-key=该节点的公钥（可选，43 位 base64url）。给了，注册中心登记它的每条地址时\n'
    printf '#                     一并发布这把公钥——控制台带 --anchors 时只从名册取节点公钥。取值就是节点腿\n'
    printf '#                     末尾「公钥」那一行。不给就照旧不带公钥，H 腿会 WARN 一句。\n'
    printf '#                     跑在 H 自己身上的节点（没有坐标行）不用写：公钥直接从本机身份文件读。\n'
    printf '#      值里不能有空白（本行按空白分词）。\n'
    printf '#\n'
    printf '# ③ local-server 行（**可选**，全表只许一条）：local-server <机器名>\n'
    printf '#      本机在控制台上显示成什么。跑在 H 自己身上的节点没有坐标行，归属只能\n'
    printf '#      从回环端点推出一个 hostname——写了它，本机就和远端三台用同一套短名。\n'
    printf '#\n'
    printf '#\n'
    printf '# 服务器归属（控制台名册上「这个节点在哪台机器上」那一栏）：\n'
    printf '#   · 有坐标行 → server=，没给就是 host=。\n'
    printf '#   · 没有坐标行 → 取地址行端点里的主机名；端点是回环时取 local-server，\n'
    printf '#     没写就取本机 hostname（在宿主机上从 127.0.0.1 就拨得通又没有隧道的\n'
    printf '#     节点，就跑在宿主机自己身上）。\n'
    printf '#   判定不出来就不显示归属，不会瞎猜一个机器名。\n'
    printf '#\n'
    printf '#      有坐标行的节点，它的每一条地址行端点**必须**正好是\n'
    printf '#      ws://127.0.0.1:<local-port> —— 脚本会带行号拦下不一致。那个不一致\n'
    printf '#      正是「名册上在线、拨不通」（§9.1）最常见的来源：链路搭在一个口上，\n'
    printf '#      应用拨的是另一个口。\n'
    printf '#\n'
    printf '# 为什么长期地址必须写在这里、而不是在控制台页面上点「注册」：\n'
    printf '# 租约 TTL 90 s，InMemoryRegistry 在 restore 时按当前时钟重判租约、过期即丢，\n'
    printf '# 所以注册中心停机超过 90 s，落盘的 agents.json 就等于空文件——重启后回来的\n'
    printf '# 只有 --register 里那批（beta-env.md §2.4 的硬规矩）。\n'
    printf '#\n'
    printf '# 机器名 / IP / 域名 / SSH 用户不进仓库（beta-env.md 文首）：本文件 0600，只在 H 上。\n'
    printf '#\n'
    printf '# ── 直连的写法 ──────────────────────────────────────────────────────\n'
    printf '# qianmo://<node>/<agent>  ws://<node-host>:%s\n' "$BETA_NODE_PORT"
    printf '#\n'
    printf '# ── 走隧道的写法 ────────────────────────────────────────────────────\n'
    printf '# （一条坐标行必须写在一行里，**不支持反斜杠续行**）\n'
    printf '# node <node> user=<ssh-user> host=<node-host> port=22 local-port=<H 侧回环口> remote-port=%s trail=<节点上审计链的绝对路径>\n' "$BETA_NODE_PORT"
    printf '# qianmo://<node>/<agent>  ws://127.0.0.1:<H 侧回环口>\n'
  } >"$BETA_PEERS_FILE"
  chmod 600 "$BETA_PEERS_FILE"
}

# ── 地址表读取 ───────────────────────────────────────────────────────────────
#
# bash 3.2 没有关联数组（macOS 自带的就是 3.2），所以用三个平行的下标数组 +
# 一个计数器，而不是 map。`beta_peer_nodes` 的去重也因此用字符串包含判断。
BETA_PEER_COUNT=0
BETA_PEER_ADDR=()
BETA_PEER_EP=()
BETA_PEER_NODE=()
BETA_PEER_LINE=()

# 第二组平行数组：node 坐标行（链路那一半）。没有坐标行的节点在这里没有条目，
# 于是「有没有隧道」这个问题在全套脚本里只有一个判据：beta_ssh_index 找不找得到。
BETA_SSH_COUNT=0
BETA_SSH_NODE=()
BETA_SSH_USER=()
BETA_SSH_HOST=()
BETA_SSH_PORT=()
BETA_SSH_LOCAL=()
BETA_SSH_REMOTE=()
BETA_SSH_TRAIL=()
BETA_SSH_KEYFILE=()
BETA_SSH_SERVER=()
BETA_SSH_WITNESS=()
# 坐标行的 public-key=，空 = 没写（名册上不带公钥，与加这个键之前一致）。
BETA_SSH_PUBKEY=()
# 本机的机器名，peers.conf 的 `local-server <name>` 行给的。
#
# 为什么需要它：跑在 H 自己身上的节点没有坐标行（没有隧道要搭），归属只能从端点推，
# 而它的端点是回环——推出来的只有 `hostname`。于是同一个控制台上，三台远端机器叫
# 运维给的短名、本机叫一串云厂商生成的实例名，命名轴断成两截。空着仍旧退回 hostname。
BETA_LOCAL_SERVER=''
# 所有隧道在 H 侧的回环口，前后各一个空格，用字符串包含判断（bash 3.2 没有关联数组）。
# beta_tcp_open 拿它当黑名单——见那个函数的头注。
BETA_TUNNEL_PORTS=' '

# 节点名会变成 systemd 实例名（qianmo-tunnel@<name>.service）与文件名
# （ops/tunnel-<name>.env）。这里必须与 packages/protocol/src/address.ts 的
# isValidSegment / MAX_SEGMENT_LENGTH 一致；协议才是语法真源。
#
# ── 为什么把字符逐个列出来，而不写 `[a-z0-9]` ─────────────────────────────────
# glob 的 `a-z` 是**范围**，范围端点按当前 locale 的排序规则（collation）解释。
# 在 en_US.UTF-8 这类按排序规则比较的 locale 下，`a-z` 展开成 aAbBcC…zZ，大写字母
# 落在范围内 —— 实测（macOS bash 3.2.57 + en_US.UTF-8）`Beta-1` 同时躲过下面两条
# 模式而被放行，而协议侧的 `SEGMENT_PATTERN` 是按码点比较的、拒绝大写。于是同一个
# 名字 shell 侧开通得出来、协议侧不认。
# 显式枚举没有范围端点，因此与 locale 无关：在哪台机器上、`LC_ALL` 是什么，结论都
# 一样。钉 `LC_ALL=C` 也能修，但那把正确性挂在「有没有人后来把这行删掉/覆盖掉」上。
beta_assert_node_name() {
  local name="$1" where="$2"
  [ -n "$name" ] || beta_die "${where}：节点名为空"
  [ "${#name}" -le 64 ] || beta_die "${where}：节点名 $name 超过协议上限 64 字符，拒绝"
  case "$name" in
    *[!abcdefghijklmnopqrstuvwxyz0123456789_-]*)
      beta_die "${where}：节点名 $name 含小写字母、数字、-、_ 之外的字符，拒绝" ;;
    [!abcdefghijklmnopqrstuvwxyz0123456789]*|*[!abcdefghijklmnopqrstuvwxyz0123456789])
      beta_die "${where}：节点名 $name 必须以小写字母或数字开始和结束，拒绝" ;;
  esac
  return 0
}

# 同样不用 `[0-9]` 范围：数字在实测过的 locale 下没被穿透（见 beta_assert_node_name
# 头注的实测），但那是「这个 locale 恰好没事」而不是「不可能有事」。枚举一次就把这个
# 自由度彻底去掉，代价为零。
beta_assert_port() {
  local value="$1" what="$2" where="$3"
  case "$value" in
    ''|*[!0123456789]*) beta_die "${where}：$what 不是数字：$value" ;;
  esac
  if [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
    beta_die "${where}：$what 超出 1–65535：$value"
  fi
  return 0
}

# beta_ssh_index <node> —— 打印该节点在 SSH 坐标数组里的下标；没有坐标行就返回 1。
beta_ssh_index() {
  local want="$1" i=0
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    if [ "${BETA_SSH_NODE[$i]}" = "$want" ]; then
      printf '%s\n' "$i"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

# ── 服务器归属 ───────────────────────────────────────────────────────────────
#
# 「这个节点跑在哪台机器上」在控制台上是看不出来的：走隧道的节点，它在名册里的端点是
# `ws://127.0.0.1:38631` —— 那是**宿主机上的隧道本地口**，四个节点长得几乎一样，而它们
# 其实分散在四台机器上。运维时分不清谁是谁，正是这一组函数要解决的事。
#
# 归属只从 peers.conf 派生，**脚本里没有任何机器名 / IP**（beta-env.md 文首那条纪律）。

# server id 的形状。它会原样进控制台的命令行（`--node-server <节点>=<id>`）和页面，
# 所以字符集卡紧一点：主机名、IPv4、IPv6（有冒号）、短名都在内，别的不收。
beta_assert_server_id() {
  local value="$1" where="$2"
  [ -n "$value" ] || beta_die "${where}：server 不能为空"
  [ "${#value}" -le 64 ] || beta_die "${where}：server 超过 64 个字符：$value"
  case "$value" in
    *[!A-Za-z0-9._:-]*) beta_die "${where}：server 只收 A-Za-z0-9 . _ : - ，收到：$value" ;;
  esac
}

# beta_peer_server <node> —— 该节点所属服务器的 id；判定不出来就返回 1（调用方降级）。
#
# 两条规则，都只读 peers.conf：
#   ① 有坐标行 → server=（没给就是 host=，见 beta_parse_node_line 里那段）。
#   ② 没有坐标行 → 地址行端点里的主机名。端点是回环时**取本机的名字**：一个在宿主
#      机上从 127.0.0.1 就拨得通、又没有隧道的节点，就是跑在宿主机自己身上——报
#      「127.0.0.1」等于什么都没说，而这正是控制台所在的那台机器。本机的名字优先取
#      `local-server` 行，没写才退回 hostname。
beta_peer_server() {
  local want="$1" index ep host
  if index="$(beta_ssh_index "$want")"; then
    printf '%s\n' "${BETA_SSH_SERVER[$index]}"
    return 0
  fi
  ep="$(beta_peer_endpoint "$want")" || return 1
  # ws://host:port / wss://[::1]:port —— 剥协议、剥端口、剥 IPv6 的方括号。
  host="${ep#*://}"
  host="${host%%/*}"
  case "$host" in
    \[*\]*) host="${host#\[}"; host="${host%%\]*}" ;;
    *) host="${host%%:*}" ;;
  esac
  case "$host" in
    127.*|localhost|::1|'')
      # 端点是回环 ⇒ 这个节点就跑在 H 自己身上 ⇒ 它的机器名就是本机的名字。
      host="${BETA_LOCAL_SERVER:-$(hostname 2>/dev/null || true)}"
      ;;
  esac
  [ -n "$host" ] || return 1
  # 这一条是派生出来的、不是人写的，所以拿不准就降级而不是让控制台起不来：
  # 一个形状古怪的 hostname 不该把整个 H 腿拖停。
  case "$host" in
    *[!A-Za-z0-9._:-]*) return 1 ;;
  esac
  [ "${#host}" -le 64 ] || return 1
  printf '%s\n' "$host"
}

# 解析一条 `node <名字> <键>=<值>...`。
beta_parse_node_line() {
  local lineno="$1" name="$2" rest="$3"
  local where="$BETA_PEERS_FILE 第 $lineno 行"
  beta_assert_node_name "$name" "$where"
  if beta_ssh_index "$name" >/dev/null; then
    # 两条同名坐标 = 隧道按后一条搭、镜像按前一条拉（或反过来，取决于谁先被用到）。
    # 那种拓扑的症状是「链路是通的，但镜像永远拉的是另一台机器」，没人会往这里查。
    beta_die "${where}：节点 $name 已经有一条 node 坐标行了，不允许两条"
  fi
  local user='' host='' port='22' local_port='' remote_port="$BETA_NODE_PORT"
  local trail='' keyfile="$BETA_SSH_KEY" server='' server_given=0 witness_port='' public_key='' kv key value
  # 按空白分词：所以值里不能有空格。这条限制写在模板注释里，且真实取值（用户名、
  # 主机、端口、绝对路径）本来就不该有空格。
  for kv in $rest; do
    case "$kv" in
      *=*) ;;
      *) beta_die "${where}：$kv 不是 <键>=<值>" ;;
    esac
    key="${kv%%=*}"
    value="${kv#*=}"
    case "$key" in
      user) user="$value" ;;
      host) host="$value" ;;
      port) port="$value" ;;
      local-port) local_port="$value" ;;
      remote-port) remote_port="$value" ;;
      trail) trail="$value" ;;
      key) keyfile="$value" ;;
      server) server="$value"; server_given=1 ;;
      witness-port) witness_port="$value" ;;
      public-key) public_key="$value" ;;
      *) beta_die "${where}：未知键 ${key}（只认 user/host/port/local-port/remote-port/trail/key/server/witness-port/public-key）" ;;
    esac
  done
  [ -n "$user" ] || beta_die "${where}：缺 user="
  [ -n "$host" ] || beta_die "${where}：缺 host="
  [ -n "$local_port" ] || beta_die "${where}：缺 local-port=（H 这一侧的回环口）"
  # user 与 host 会被拼成 `user@host` 交给 ssh。把 @ 挡在这里，是为了让「user=a@b」
  # 这种写法当场报错，而不是变成一个连得上、但连的是别人的机器的隧道。
  case "$user" in *@*|*/*) beta_die "${where}：user 里不能有 @ 或 /：$user" ;; esac
  case "$host" in *@*|*/*) beta_die "${where}：host 里不能有 @ 或 /：$host" ;; esac
  beta_assert_port "$port" 'port' "$where"
  beta_assert_port "$local_port" 'local-port' "$where"
  beta_assert_port "$remote_port" 'remote-port' "$where"
  if [ -n "$witness_port" ]; then beta_assert_port "$witness_port" 'witness-port' "$where"; fi
  # 形状在这里就卡死：注册中心对坏形状答 400，p81-registry 就在启动时抛错退出——
  # 那时报出来的是「注册中心起不来」，而不是这一行写错了。
  if [ -n "$public_key" ] && ! beta_public_key_ok "$public_key"; then
    beta_die "${where}：public-key 不是 43 位 base64url 的 Ed25519 公钥：${public_key}"
  fi
  case "$BETA_TUNNEL_PORTS" in
    *" $local_port "*) beta_die "${where}：local-port=$local_port 已经被另一个节点占了" ;;
  esac
  if [ -n "$trail" ]; then
    case "$trail" in
      /*) ;;
      *) beta_die "${where}：trail 必须是节点上的绝对路径：$trail" ;;
    esac
    case "$trail" in *..*) beta_die "${where}：trail 里有 ..，拒绝：$trail" ;; esac
  fi
  case "$keyfile" in
    /*) ;;
    *) beta_die "${where}：key 必须是 H 上的绝对路径：$keyfile" ;;
  esac
  # server= 不给就落成 host= —— 对走隧道的节点，「它在哪台机器上」这个事实已经由
  # host= 说清了，再让人写一遍就是同一个事实的第二处出处（根 CLAUDE.md「指针不复制」）。
  # 给它是为了让运维能起一个稳定的短名（`p11`）而不是被 IP 变更带着走。
  # 「没给 server=」与「给了 server=（空）」必须分开：后者是打字打漏了，静默落成 host=
  # 会把一个笔误变成一个看起来正常的配置。本文件对其余每个键都是这个姿态。
  if [ "$server_given" -eq 0 ]; then server="$host"; fi
  beta_assert_server_id "$server" "$where" 
  BETA_SSH_NODE[BETA_SSH_COUNT]="$name"
  BETA_SSH_USER[BETA_SSH_COUNT]="$user"
  BETA_SSH_HOST[BETA_SSH_COUNT]="$host"
  BETA_SSH_PORT[BETA_SSH_COUNT]="$port"
  BETA_SSH_LOCAL[BETA_SSH_COUNT]="$local_port"
  BETA_SSH_REMOTE[BETA_SSH_COUNT]="$remote_port"
  BETA_SSH_TRAIL[BETA_SSH_COUNT]="$trail"
  BETA_SSH_KEYFILE[BETA_SSH_COUNT]="$keyfile"
  BETA_SSH_SERVER[BETA_SSH_COUNT]="$server"
  BETA_SSH_WITNESS[BETA_SSH_COUNT]="$witness_port"
  BETA_SSH_PUBKEY[BETA_SSH_COUNT]="$public_key"
  BETA_SSH_COUNT=$((BETA_SSH_COUNT + 1))
  BETA_TUNNEL_PORTS="$BETA_TUNNEL_PORTS$local_port "
}

beta_load_peers() {
  BETA_PEER_COUNT=0
  BETA_PEER_ADDR=()
  BETA_PEER_EP=()
  BETA_PEER_NODE=()
  BETA_PEER_LINE=()
  BETA_SSH_COUNT=0
  BETA_SSH_NODE=()
  BETA_SSH_USER=()
  BETA_SSH_HOST=()
  BETA_SSH_PORT=()
  BETA_SSH_LOCAL=()
  BETA_SSH_REMOTE=()
  BETA_SSH_TRAIL=()
  BETA_SSH_KEYFILE=()
  BETA_SSH_SERVER=()
  BETA_SSH_WITNESS=()
  BETA_SSH_PUBKEY=()
  BETA_LOCAL_SERVER=''
  BETA_TUNNEL_PORTS=' '
  [ -f "$BETA_PEERS_FILE" ] || return 0
  # 变量名避开 `tail`：bash 的 local 是动态作用域，一个叫 tail 的变量读起来像是在
  # 覆盖那个命令（实际不会），而这个文件里真的有地方在用 tail 命令。
  local addr ep rest suffix node lineno=0
  # 重定向给 while 本体而不是用管道：管道会开子 shell，数组就赋不回来了。
  while read -r addr ep rest || [ -n "$addr" ]; do
    lineno=$((lineno + 1))
    case "$addr" in '' | \#*) continue ;; esac
    # 新的第二种行。放在地址判定**之前**：老格式的第一字段必然以 qianmo:// 开头，
    # 所以 `node` 这个关键字不会和任何一条合法的老行撞上——向后兼容就落在这一点上。
    if [ "$addr" = 'node' ]; then
      beta_parse_node_line "$lineno" "$ep" "$rest"
      continue
    fi
    # 第三种行，理由同上：`local-server` 不会和 qianmo:// 开头的地址行撞上。
    if [ "$addr" = 'local-server' ]; then
      [ -z "$BETA_LOCAL_SERVER" ] || beta_die "$BETA_PEERS_FILE 第 $lineno 行：local-server 给了两次"
      beta_assert_server_id "$ep" "$BETA_PEERS_FILE 第 $lineno 行"
      # 多出来的字段一律是笔误。静默吃掉它，下一个人会以为自己写的那半边生效了。
      [ -z "$rest" ] || beta_die "$BETA_PEERS_FILE 第 $lineno 行：local-server 只收一个名字，多了：$rest"
      BETA_LOCAL_SERVER="$ep"
      continue
    fi
    case "$addr" in
      qianmo://*/*) ;;
      *) beta_die "$BETA_PEERS_FILE 第 $lineno 行既不是 qianmo://<node>/<agent> 地址行，也不是 node 坐标行：$addr" ;;
    esac
    [ -n "$ep" ] || beta_die "$BETA_PEERS_FILE 第 $lineno 行缺入站端点：$addr"
    case "$ep" in
      ws://*|wss://*) ;;
      *) beta_die "$BETA_PEERS_FILE 第 $lineno 行的端点不是 ws:// 或 wss://：$ep" ;;
    esac
    suffix="${addr#qianmo://}"
    node="${suffix%%/*}"
    [ -n "$node" ] || beta_die "$BETA_PEERS_FILE 第 $lineno 行解析不出节点名：$addr"
    beta_assert_node_name "$node" "$BETA_PEERS_FILE 第 $lineno 行"
    BETA_PEER_ADDR[BETA_PEER_COUNT]="$addr"
    BETA_PEER_EP[BETA_PEER_COUNT]="$ep"
    BETA_PEER_NODE[BETA_PEER_COUNT]="$node"
    BETA_PEER_LINE[BETA_PEER_COUNT]="$lineno"
    BETA_PEER_COUNT=$((BETA_PEER_COUNT + 1))
  done <"$BETA_PEERS_FILE"
  beta_assert_peers_match_tunnels
  return 0
}

# 走隧道的节点，它的地址行端点必须正好是 ws://127.0.0.1:<local-port>。
#
# 这一条是全表读完之后再查的，不是边读边查——坐标行允许写在地址行后面。
#
# 为什么值得当场 die：链路搭在 38631 而应用拨 38625，两边各自都「正常」，症状是
# 名册上四个节点全在线、拨号全超时（beta-env.md §9.1）。这类不一致以前只能靠人记得
# 「改一处必须改另一处」，现在由这里代劳。
beta_assert_peers_match_tunnels() {
  local i=0 index want
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    if index="$(beta_ssh_index "${BETA_PEER_NODE[$i]}")"; then
      want="ws://127.0.0.1:${BETA_SSH_LOCAL[$index]}"
      if [ "${BETA_PEER_EP[$i]}" != "$want" ]; then
        beta_die "$BETA_PEERS_FILE 第 ${BETA_PEER_LINE[$i]} 行：${BETA_PEER_ADDR[$i]} 的端点是 ${BETA_PEER_EP[$i]}，
但节点 ${BETA_PEER_NODE[$i]} 有一条 node 坐标行（local-port=${BETA_SSH_LOCAL[$index]}），端点必须是 ${want}。
两边不一致的后果是「名册上在线、拨号全超时」—— 链路搭在一个口上，应用拨的是另一个口。"
      fi
    fi
    i=$((i + 1))
  done
  return 0
}

# 去重后的节点名，一行一个，保持地址表里的先后顺序。
beta_peer_nodes() {
  local i=0 seen=' ' node
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    node="${BETA_PEER_NODE[$i]}"
    case "$seen" in
      *" $node "*) ;;
      *) printf '%s\n' "$node"; seen="$seen$node " ;;
    esac
    i=$((i + 1))
  done
}

# beta_peer_endpoint <node> —— 该节点的入站端点（取地址表里第一条）。
beta_peer_endpoint() {
  local want="$1" i=0
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    if [ "${BETA_PEER_NODE[$i]}" = "$want" ]; then
      printf '%s\n' "${BETA_PEER_EP[$i]}"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

# ── 节点公钥：名册上那个 publicKey 从哪来 ────────────────────────────────────
#
# 控制台带 `--anchors` 时**只从名册取节点公钥**（console.ts 的 witnessPublicKeyOf，不从锚点学）。
# 2026-09-26 的现场：p81-registry 的 `--register` 从来不带公钥，审计页对三个节点全报「名册没有
# 节点 <名字> 的公钥」；手工逐条补上之后，条目一旦因租约过期被重新登记，公钥又丢了。
#
# 于是 H 腿自己给 p81-registry 带上公钥。来源只有两个，**都不猜**：
#   ① 有 node 坐标行 → 坐标行的 `public-key=`。远端节点的身份文件在它自己的机器上，H 读不到，
#      只能由人把节点腿末尾打印的那一行抄过来（与 `--trust` / 见证端点 `--key` 同一个事实）。
#   ② 没有坐标行、端点是回环 → 节点就跑在本机（beta_peer_server 同一条推理），读本机内测根下
#      它的身份文件。首次创建后永不替换（nodeIdentity.ts），所以它就是那个节点此刻的公钥。
# 其余情形（没写 `public-key=`、直连的远端节点）一律**不带**，与加这一节之前完全一样，由调用方
# WARN 一句。

# beta_public_key_ok <值> —— 是不是一把 base64url 的 Ed25519 公钥（43 个字符，无填充）。
# 字符逐个列出，不写 `[A-Za-z0-9]`：理由见 beta_assert_node_name 头注（范围随 locale 变）。
# 判据与 @qianmo/protocol 的 PUBLIC_KEY_PATTERN 一致；注册中心收的就是那个形状。
beta_public_key_ok() {
  local value="$1"
  [ "${#value}" -eq 43 ] || return 1
  case "$value" in
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-]*) return 1 ;;
  esac
  return 0
}

# 节点身份文件：`occConfigPath('qianmo','identity','<node>.json')`，配置根是 beta-up 给它的那个。
beta_node_identity_file() {
  printf '%s/%s/config/qianmo/identity/%s.json' "$BETA_NODES_DIR" "$1" "$1"
}

# beta_identity_public_key <node> —— 本机身份文件里的公钥；没有 / 读不出就返回 1。
#
# 只取 `publicKey`，**私钥那一行一个字节都不进变量**。依赖的形状是我们自己的序列化器
# （nodeIdentity.ts 写的是 `JSON.stringify(doc, null, 2)`，每个字段独占一行），与
# beta_state_pairs 读注册表落盘同一条理由。`node` 字段也要对得上：一份别的节点的身份文件
# 被拷错了地方，比没有更糟。
beta_identity_public_key() {
  local node="$1" file key
  file="$(beta_node_identity_file "$node")"
  [ -f "$file" ] || return 1
  key="$(awk -v want="$node" '
    /"node"[[:space:]]*:/ {
      v = $0
      sub(/^.*"node"[[:space:]]*:[[:space:]]*"/, "", v)
      sub(/".*$/, "", v)
      node = v
    }
    /"publicKey"[[:space:]]*:/ {
      v = $0
      sub(/^.*"publicKey"[[:space:]]*:[[:space:]]*"/, "", v)
      sub(/".*$/, "", v)
      key = v
    }
    END { if (node == want) print key }
  ' "$file" 2>/dev/null || true)"
  beta_public_key_ok "$key" || return 1
  printf '%s\n' "$key"
}

# beta_resolve_node_key <node> —— 定下该节点要发布进名册的公钥。
#
# 结果放全局变量而不是打印：调用方要同时拿到值、出处和「为什么没有」三样，且这里的
# beta_die 必须真的结束脚本（放进 `$(...)` 就只结束一个子 shell）。
#   BETA_NODE_KEY         公钥；空 = 没有来源
#   BETA_NODE_KEY_SOURCE  出处，给 OK 那一行用
#   BETA_NODE_KEY_GAP     没有来源时的原因与补法，给 WARN 那一行用
BETA_NODE_KEY=''
BETA_NODE_KEY_SOURCE=''
BETA_NODE_KEY_GAP=''
beta_resolve_node_key() {
  local node="$1" index ep host key
  BETA_NODE_KEY=''
  BETA_NODE_KEY_SOURCE=''
  BETA_NODE_KEY_GAP=''
  if index="$(beta_ssh_index "$node")"; then
    key="${BETA_SSH_PUBKEY[$index]}"
    if [ -n "$key" ]; then
      BETA_NODE_KEY="$key"
      BETA_NODE_KEY_SOURCE="${BETA_PEERS_FILE} 的坐标行 public-key="
      return 0
    fi
    BETA_NODE_KEY_GAP="它的 node 坐标行没有 public-key=。补法：在 ${node} 那台机器上跑一次节点腿，
把末尾「公钥」那一行的值写成坐标行的 public-key=<值>，再跑 H 腿"
    return 1
  fi
  ep="$(beta_peer_endpoint "$node" || true)"
  host="${ep#*://}"
  host="${host%%/*}"
  case "$host" in
    127.*|localhost|localhost:*|'[::1]'*) ;;
    *)
      BETA_NODE_KEY_GAP="它直连（没有 node 坐标行），不跑在本机，H 读不到它的身份文件。
直连节点目前没有写公钥的地方：按 demo/env/beta/README.md「审计见证」第 ⑥ 步手工发布，
租约过期被重新登记后要再做一次"
      return 1
      ;;
  esac
  if key="$(beta_identity_public_key "$node")"; then
    BETA_NODE_KEY="$key"
    BETA_NODE_KEY_SOURCE="本机身份文件 $(beta_node_identity_file "$node")"
    return 0
  fi
  BETA_NODE_KEY_GAP="它跑在本机（端点是回环），但 $(beta_node_identity_file "$node") 不存在或读不出公钥
（节点从没在这个内测根下起过？先跑节点腿，再跑 H 腿）"
  return 1
}

# ── 隔离环境 ─────────────────────────────────────────────────────────────────
#
# 身份变量三件套里的前一个在这里设，另两个按腿分别设（beta-env.md §4.1 的表）：
#   OCC_IDENTITY=qianmo      —— 缺了就落到 ~/.occ，与机器上的 occ 抢配置根；
#   OCC_CONFIG_DIR=<按进程>  —— 由各腿在起进程时逐个给；
#   QIANMO_TRANSPORT_PSK     —— 由 beta_load_psk 从文件取，缺了进程起不来。
beta_export_common() {
  export OCC_IDENTITY=qianmo
  if [ -z "${QIANMO_BACKUP_WRITE_TOKEN:-}" ] && [ -f "$BETA_BACKUP_WRITE_FILE" ]; then
    QIANMO_BACKUP_WRITE_TOKEN="$(cat "$BETA_BACKUP_WRITE_FILE")"
    export QIANMO_BACKUP_WRITE_TOKEN
  fi
  if [ -z "${QIANMO_BACKUP_ARCHIVE_TOKEN:-}" ] && [ -f "$BETA_BACKUP_ARCHIVE_FILE" ]; then
    QIANMO_BACKUP_ARCHIVE_TOKEN="$(cat "$BETA_BACKUP_ARCHIVE_FILE")"
    export QIANMO_BACKUP_ARCHIVE_TOKEN
  fi
}

# beta_load_psk <文件> <说明> —— 把一把 PSK 从文件读进环境。
#
# **永远不走命令行**：命令行上的密钥就是这台机器每一份进程列表里的密钥（§8.3）。
# 环境里已经有一把就不动它——运维手工 export 一把跑一次性动作是正常操作。
beta_load_psk() {
  local file="$1" what="$2"
  if [ -n "${QIANMO_TRANSPORT_PSK:-}" ]; then
    return 0
  fi
  [ -f "$file" ] || beta_die "缺 ${what}：$file —— 它由 H 生成后分发，**不在本机自动生成**（beta-env.md §8.3）"
  QIANMO_TRANSPORT_PSK="$(cat "$file")"
  export QIANMO_TRANSPORT_PSK
  [ -n "$QIANMO_TRANSPORT_PSK" ] || beta_die "$file 是空的"
  return 0
}

# ── 模型凭据（secrets/model-env）─────────────────────────────────────────────
#
# 三个状态变量由 beta_load_model_env 写，由 beta_model_env_line 读。**它们只描述文件，
# 不描述内容**：有没有、几个键、涉及哪几类 provider。凭据值一个字节都不出现在这里，
# 也不出现在日志、横幅、argv 或任何一条错误信息里——一份能被 `ps` 读到的密钥，与写在
# 命令行上的密钥是同一件事（§8.3 对 PSK 定下的那条纪律，对这份同样成立）。
#
# 「够不够用」不由这里回答：键名对不对、值是不是活的，只有真发一次请求才知道。那一格
# 由 resident 自己在启动时回答（`warnMissingModelCredentials`，写在 <节点>.err 里）。
BETA_MODEL_ENV_STATUS='unknown'
BETA_MODEL_ENV_COUNT=0
BETA_MODEL_ENV_CLASSES=''

# beta_model_env_names <文件> —— 文件里出现的**键名**，一行一个。
#
# 只喂给下面两个函数算「几个」和「哪几类」，**键名本身永不打印**：一把贴错位置的密钥
# 可能长在键名上（`ANTHROPIC_API_KEY_sk-…=1` 这种手滑），把键名回显出来等于把它印进日志。
#
# 判据是「行首（可带 export）的 KEY=」。多行值的续行里如果恰好也有 `KEY=` 形状会被多数
# 一次——那只影响「几个」这句话的观感，不影响注入本身（注入是 `.` 干的，不是这里）。
beta_model_env_names() {
  LC_ALL=C sed -n \
    's/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)=.*/\2/p' \
    "$1"
}

# beta_model_env_classes <键名清单> —— 涉及哪几类 provider，固定顺序，空格分隔。
#
# 粒度到此为止：**不报键名、不报值、不报前缀、不报长度**。够运维分辨「我以为配的是
# openai，怎么报的是 anthropic」，又不足以泄漏任何一把密钥。
beta_model_env_classes() {
  local name anthropic=0 openai=0 deepseek=0 opencode=0 gemini=0 grok=0 \
    bedrock=0 vertex=0 other=0 out=''
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    case "$name" in
      ANTHROPIC_*|CLAUDE_CODE_OAUTH_TOKEN) anthropic=1 ;;
      DEEPSEEK_*) deepseek=1 ;;
      OPENCODE_*) opencode=1 ;;
      OPENAI_*|CLAUDE_CODE_USE_OPENAI) openai=1 ;;
      GEMINI_*|CLAUDE_CODE_USE_GEMINI) gemini=1 ;;
      GROK_*|XAI_*|CLAUDE_CODE_USE_GROK) grok=1 ;;
      AWS_*|CLAUDE_CODE_USE_BEDROCK) bedrock=1 ;;
      GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_*|CLAUDE_CODE_USE_VERTEX) vertex=1 ;;
      *) other=1 ;;
    esac
  done
  [ "$anthropic" = '0' ] || out="$out anthropic"
  [ "$openai" = '0' ] || out="$out openai"
  [ "$deepseek" = '0' ] || out="$out deepseek"
  [ "$opencode" = '0' ] || out="$out opencode"
  [ "$gemini" = '0' ] || out="$out gemini"
  [ "$grok" = '0' ] || out="$out grok"
  [ "$bedrock" = '0' ] || out="$out bedrock"
  [ "$vertex" = '0' ] || out="$out vertex"
  [ "$other" = '0' ] || out="$out 其他"
  printf '%s' "${out# }"
}

# 把 secrets/model-env 注入当前环境。**四种形状分开处理，不许合并成「有 / 没有」两种。**
#
#   · 文件不在        —— 不是错误。节点仍然该起来：传输、审计、握手、备份都不需要模型
#                        凭据（demo-env.md 那批不需要凭据的 AC 就是这么跑的）。只是被
#                        唤醒后干不了活，所以调用方要把这件事显式说出来。
#   · 断链 / 不是普通文件 —— 是错误。有人打算给凭据而没给成，静默继续正是 issue #13。
#   · 读不掉（权限）  —— 同上，是错误。
#   · 在、但一个赋值都没有 —— 同上，是错误。**这一格与「文件不在」不是一件事**：空文件
#                        是「配过、配坏了」，缺文件是「没打算配」，把两者报成同一句话
#                        会让人去查错的那一头。
beta_load_model_env() {
  local file="$BETA_MODEL_ENV_FILE" names restore
  BETA_MODEL_ENV_STATUS='absent'
  BETA_MODEL_ENV_COUNT=0
  BETA_MODEL_ENV_CLASSES=''

  if [ -L "$file" ] && [ ! -e "$file" ]; then
    beta_die "$file 是一条断掉的软链 —— 有人给过模型凭据，现在指空了。
不猜它本来指哪：静默跳过等于起一个「唤醒得了、干不了活」的节点（issue #13）。"
  fi
  if [ ! -e "$file" ]; then
    return 0
  fi
  [ -f "$file" ] \
    || beta_die "$file 存在但不是普通文件 —— 模型凭据要的是一份 KEY=VALUE 的 shell 片段。"
  [ -r "$file" ] \
    || beta_die "$file 存在但读不掉（权限？该是 0600 且属当前用户）—— 拒绝在这种状态下静默起节点。"

  names="$(beta_model_env_names "$file")"
  BETA_MODEL_ENV_COUNT="$(printf '%s\n' "$names" | grep -c '.' || true)"
  if [ "$BETA_MODEL_ENV_COUNT" -eq 0 ]; then
    beta_die "$file 在，但里面一个 KEY=VALUE 都没有（只有注释 / 空行？）。
这与「没有这个文件」不是一件事：文件在说明有人配过。要么把凭据补上，要么把文件删掉。"
  fi
  BETA_MODEL_ENV_CLASSES="$(printf '%s\n' "$names" | beta_model_env_classes)"

  # `set -a` 的作用域是**整个 shell**，不是本函数：先记下调用方进来时是开是关，注入完
  # 原样还回去。少了这一步，本函数之后每一个普通局部变量都会被导出给子进程——那正是
  # 「凭据不外泄」这条纪律最容易被自己人破掉的方式。
  case "$-" in
    *a*) restore='set -a' ;;
    *) restore='set +a' ;;
  esac
  set -a
  # shellcheck disable=SC1090
  #   ↑ 路径是运行期算出来的，shellcheck 跟不进去；这份文件本来就不在仓库里。
  . "$file"
  eval "$restore"

  BETA_MODEL_ENV_STATUS='loaded'
  return 0
}

# 一行姿态，给横幅用。**只说有 / 无、几个键、哪几类。**
beta_model_env_line() {
  case "$BETA_MODEL_ENV_STATUS" in
    loaded)
      printf '已加载（%s，%s 个环境键，涉及 %s）' \
        "$BETA_MODEL_ENV_FILE" "$BETA_MODEL_ENV_COUNT" "$BETA_MODEL_ENV_CLASSES"
      ;;
    absent)
      printf '未加载（没有 %s）' "$BETA_MODEL_ENV_FILE"
      ;;
    *)
      printf '未查（beta_load_model_env 本次没跑）'
      ;;
  esac
}

# H 上那份运维副本：secrets/peers/<node>.psk（**全部四把**，§8.3 的表）。
beta_peer_psk_file() { printf '%s/%s.psk' "$BETA_PEER_SECRET_DIR" "$1"; }

# The named console wake contract is a byte-for-byte UTF-8 hex encoding. This
# keeps every legal protocol node segment distinct on every platform.
beta_wake_psk_env() {
  local node="$1"
  printf 'QIANMO_TRANSPORT_PSK_NODE_'
  printf '%s' "$node" | LC_ALL=C od -An -tx1 | tr -d ' \n' | tr '[:lower:]' '[:upper:]'
}

# Export only the PSK currently assigned to this named wake target. Clearing
# first is essential: a parent shell may still carry a prior deployment's key.
beta_export_peer_wake_psk() {
  local node="$1" psk_file psk_env psk
  psk_file="$(beta_peer_psk_file "$node")"
  psk_env="$(beta_wake_psk_env "$node")"
  unset "$psk_env"
  [ -s "$psk_file" ] || return 1
  psk="$(cat "$psk_file")"
  [ -n "$psk" ] || return 1
  export "$psk_env=$psk"
}

# beta_random_hex <字节数> —— 生成一串随机 hex。
#
# 用 `od -N` 而不是 `tr -dc ... | head -c`：后者会让 head 先退出、tr 吃到 SIGPIPE，
# 在 `set -o pipefail` 下整条脚本当场以 141 退出。这不是洁癖，是踩过的形状。
beta_random_hex() {
  local bytes="$1"
  if [ -r /dev/urandom ]; then
    LC_ALL=C od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
    printf '\n'
    return 0
  fi
  bun -e 'process.stdout.write(Buffer.from(crypto.getRandomValues(new Uint8Array(Number(process.argv[1])))).toString("hex")+"\n")' "$bytes"
}

# ── 进程 helper ──────────────────────────────────────────────────────────────

beta_pidfile() { printf '%s/%s.pid' "$BETA_RUN_DIR" "$1"; }
beta_logfile() { printf '%s/%s.%s' "$BETA_LOG_DIR" "$1" "$2"; }

# beta_running <名字> —— pid 文件里的进程还活着吗。**幂等起停的全部依据。**
beta_running() {
  local file
  file="$(beta_pidfile "$1")"
  [ -f "$file" ] || return 1
  local pid
  pid="$(cat "$file" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# beta_stop_pid <名字> <pid> —— 先 TERM，10 s 不走再 KILL。已经不在的一个字都不打。
beta_stop_pid() {
  local name="$1" pid="$2" i
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM "$pid" 2>/dev/null || true
  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 10 ]; do
    sleep 1
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    beta_warn "$name (pid $pid) 未响应 SIGTERM，改用 SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  beta_say "已停止 $name (pid $pid)"
}

# beta_stop_one <名字> —— 停 pid 文件里那一个，再删掉 pid 文件。
beta_stop_one() {
  local name="$1" file pid
  file="$(beta_pidfile "$name")"
  beta_assert_inside_root "$file"
  [ -f "$file" ] || return 0
  pid="$(cat "$file" 2>/dev/null || true)"
  if [ -n "$pid" ]; then beta_stop_pid "$name" "$pid"; fi
  rm -f "$file"
}

# ── pid 文件对不上时：按命令行与端口再认一遍 ──────────────────────────────────
#
# 2026-09-26 p1 上 beta-1 的现场：旧树留下的 run/beta-1.pid 写着 3012737，真在跑的是 2701919。
# 只认 pid 文件的 beta-down 报「beta-1 本来就没在跑」，旧进程照跑、继续占着 38625；紧接着的
# beta-up 起了一个注定 EADDRINUSE 的新进程，而就绪探测被旧进程的应答骗成了绿。
#
# pid 文件仍是第一判据，这里补的是第二判据：**命令行说它是本内测根下的这个节点**。三条同时成立
# 才算，缺一条就不认——认错的代价是 kill 别人的进程：
#   ① argv 里有 `resident` 这个词；
#   ② argv 里有 `--node <名字>`（或 `--node=<名字>`）；
#   ③ 它和**本内测根**绑在一起：某个参数形如 `<agent>=<本根>/workspaces/<名字>/…`（beta-up 给
#      每个 agent 的工作区，自第一版起每一版都有），或者（Linux）它的环境里
#      `OCC_CONFIG_DIR=<本根>/nodes/<名字>/config`——就是它的配置根。
# 同名节点跑在**另一个**内测根下（同机的演示 / 另一套内测）过不了③，不会被误停。
#
# **端口只用来报不一致，从不用来挑人杀。**H 上 38625 是跑在 H 自己身上的那个节点在用，
# 按端口找进程会把它当成别的节点的旧进程停掉。

# beta_proc_node <pid> <argv 串> —— 这个进程是本内测根下哪个节点的 resident；不是就返回 1。
beta_proc_node() {
  local pid="$1" args="$2" word prev='' node='' resident=0 physical='' root env_text
  local words=()
  # read -a 只按空白切，不做路径展开：argv 里的 * ? 不会被 glob 成当前目录的文件名。
  read -r -a words <<<"$args" || true
  for word in ${words[@]+"${words[@]}"}; do
    case "$word" in
      resident) resident=1 ;;
      --node=*) node="${word#--node=}" ;;
    esac
    if [ "$prev" = '--node' ]; then node="$word"; fi
    prev="$word"
  done
  [ "$resident" = '1' ] && [ -n "$node" ] || return 1
  # 两种拼法都比：argv 里存的是当初被怎么拼出来的那一个，与 pwd -P 解过符号链接的那个
  # 在有符号链接时不相等（macOS 的 /var → /private/var；beta-deploy.sh 的守卫踩过同一个坑）。
  physical="$(cd "$BETA_ROOT" 2>/dev/null && pwd -P || true)"
  for root in "$BETA_ROOT" "$physical"; do
    [ -n "$root" ] || continue
    for word in ${words[@]+"${words[@]}"}; do
      case "$word" in
        *"=${root}/workspaces/${node}/"*)
          printf '%s\n' "$node"
          return 0
          ;;
      esac
    done
    # 先整份读进变量再比：`tr … | grep -q` 在 pipefail 下会因 tr 吃到 SIGPIPE 而判假。
    if [ -r "/proc/$pid/environ" ]; then
      env_text="$(tr '\0' '\n' <"/proc/$pid/environ" 2>/dev/null || true)"
      case "
${env_text}
" in
        *"
OCC_CONFIG_DIR=${root}/nodes/${node}/config
"*)
          printf '%s\n' "$node"
          return 0
          ;;
      esac
    fi
  done
  return 1
}

# beta_node_pids <名字> —— 按命令行认出来的、本内测根下这个节点的全部进程，一行一个 pid。
# 进程表数不出来时返回 2（那是「没法复核」，不是「没有」）。
#
# `ps` 而不是 `pgrep -af`：macOS 的 pgrep 收下 -a 却只打 PID（beta-deploy.sh 的守卫实测过）。
# `-ww`：resident 的 argv 常有几百字节（每个 agent 一个工作区路径、--trust 公钥），被截断就
# 认不出③。
beta_node_pids() {
  local want="$1" snapshot pid args
  snapshot="$(ps -ww -eo pid=,args= 2>/dev/null || true)"
  [ -n "$snapshot" ] || return 2
  while read -r pid args; do
    [ -n "$pid" ] || continue
    [ "$pid" != "$$" ] || continue
    # 先用便宜的字符串判断筛掉绝大多数行：下面那一步每行要开子 shell。
    case " $args " in
      *' resident '*) ;;
      *) continue ;;
    esac
    case "$args" in
      *"--node ${want}"*|*"--node=${want}"*) ;;
      *) continue ;;
    esac
    if [ "$(beta_proc_node "$pid" "$args" || true)" = "$want" ]; then
      printf '%s\n' "$pid"
    fi
  done <<<"$snapshot"
  return 0
}

# beta_port_holders <端口> —— 在这个 TCP 端口上 LISTEN 的进程，一行一个 pid。
# 本机三种办法都没有时返回 1（= 认不出，不是「没人在听」）。
#
# ss（节点机上现成）→ lsof（macOS 自带，常在 /usr/sbin，不在非交互 PATH 里）→ /proc 扫 fd。
# 只看得到本账号的进程——内测的进程全是本账号起的，别的账号占着端口时由调用方的 TCP 探测兜底。
beta_port_holders() {
  local port="$1" out lsof_bin='' hex inodes inode dir listing
  if command -v ss >/dev/null 2>&1 && out="$(ss -ltnp "sport = :${port}" 2>/dev/null)"; then
    printf '%s\n' "$out" | grep -o 'pid=[0123456789]*' | cut -d= -f2 | sort -u || true
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof_bin="$(command -v lsof)"
  elif [ -x /usr/sbin/lsof ]; then
    lsof_bin=/usr/sbin/lsof
  fi
  if [ -n "$lsof_bin" ]; then
    "$lsof_bin" -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
    return 0
  fi
  [ -r /proc/net/tcp ] || return 1
  hex="$(printf '%04X' "$port")"
  # 第 4 列 0A = LISTEN；第 2 列是 <地址>:<十六进制端口>；第 10 列是 socket inode。
  inodes="$(awk -v want=":${hex}" 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == want { print $10 }' \
    /proc/net/tcp /proc/net/tcp6 2>/dev/null || true)"
  [ -n "$inodes" ] || return 0
  for dir in /proc/[0123456789]*; do
    listing="$(ls -l "$dir/fd" 2>/dev/null || true)"
    for inode in $inodes; do
      case "$listing" in
        *"socket:[${inode}]"*) printf '%s\n' "${dir#/proc/}" ;;
      esac
    done
  done
  return 0
}

# beta_port_occupants <端口> —— 谁占着这个端口：pid 一行一个；有人应答却认不出是谁时打一行 `?`。
# 空输出 = 端口空着。
beta_port_occupants() {
  local port="$1" holders
  holders="$(beta_port_holders "$port" || true)"
  if [ -n "$holders" ]; then
    printf '%s\n' "$holders"
    return 0
  fi
  if beta_tcp_open 127.0.0.1 "$port"; then printf '?\n'; fi
  return 0
}

# beta_describe_pid <pid 或 ?> —— 给人看的一行：pid 与它的命令行。
beta_describe_pid() {
  local pid="$1" args
  if [ "$pid" = '?' ]; then
    beta_say '  （有进程在应答，但本机认不出是谁：没有 ss / lsof / /proc 可查，或它属于别的账号）'
    return 0
  fi
  args="$(ps -ww -o args= -p "$pid" 2>/dev/null || true)"
  beta_say "  pid ${pid}：${args:-（命令行读不到）}"
}

# beta_stop_node <节点名> —— 停一个常驻节点：pid 文件，再按命令行认一遍。
#
# 返回 0 = 停了，或者确实没在跑；返回 3 = 它的端口被**认不出**的进程占着——已如实报出，
# **一个都没动**。端口按 BETA_NODE_PORT 查（一机一节点，beta-up 用的就是它）。
#
# 端口那一步只在「pid 文件在、却指着一个不存在的进程、命令行也认不出任何一个」时才做：
# 那是这个节点确实在本机跑过、而记录和现实对不上的唯一形状。H 上给一个只铺了链路的名字
# （run/ 里本来就没有它的 pid 文件）不走这一步——H 的 38625 上是它自己身上那个节点，不相干。
beta_stop_node() {
  local name="$1" file recorded='' had_file=0 was_running=0 found=0 pids pid occupants other unknown=0
  file="$(beta_pidfile "$name")"
  beta_assert_inside_root "$file"
  if [ -f "$file" ]; then
    had_file=1
    recorded="$(cat "$file" 2>/dev/null || true)"
  fi
  if beta_running "$name"; then was_running=1; fi
  beta_stop_one "$name"

  local rc=0
  pids="$(beta_node_pids "$name")" || rc=$?
  if [ "$rc" != '0' ]; then
    beta_warn "数不出进程表（ps -eo pid=,args= 没有输出）—— 没法按命令行复核 ${name} 还有没有别的进程在跑"
  fi
  for pid in $pids; do
    if [ "$was_running" = '1' ]; then
      beta_warn "pid 文件里的 ${recorded} 已停，但按命令行还认出一个 ${name}（同一个节点起了两份）："
    elif [ "$had_file" = '1' ]; then
      beta_warn "run/${name}.pid 写的是 ${recorded:-（空）}，那个进程已经不在了；按命令行认出 ${name} 真正在跑的是："
    else
      beta_warn "run/${name}.pid 不存在，但按命令行认出 ${name} 在跑："
    fi
    beta_describe_pid "$pid"
    beta_stop_pid "$name" "$pid"
    found=1
  done
  if [ "$was_running" = '1' ] || [ "$found" = '1' ]; then return 0; fi

  if [ "$had_file" = '1' ]; then
    occupants="$(beta_port_occupants "$BETA_NODE_PORT")"
    if [ -n "$occupants" ]; then
      # 逐行读而不是 `for pid in $occupants`：那一行可能是 `?`，不加引号的展开会把它
      # 当 glob 去匹配当前目录里的单字符文件名。
      while read -r pid; do
        other=''
        if [ "$pid" != '?' ]; then
          other="$(beta_proc_node "$pid" "$(ps -ww -o args= -p "$pid" 2>/dev/null || true)" || true)"
        fi
        if [ -n "$other" ]; then
          beta_say "端口 ${BETA_NODE_PORT} 上是本内测根的节点 ${other}（pid ${pid}），不是 ${name}。"
        else
          unknown=1
        fi
      done <<<"$occupants"
      if [ "$unknown" = '1' ]; then
        beta_warn "${name} 的 pid 文件写着 ${recorded:-（空）}，那个进程已经不在了，按命令行也认不出任何一个 ${name}，
但端口 ${BETA_NODE_PORT} 被占着："
        while read -r pid; do beta_describe_pid "$pid"; done <<<"$occupants"
        beta_say "  这几个进程的命令行说不出它们是本内测根的 ${name}，**本脚本不动它们**（不按端口杀人）。
  它们不走，接下来的 beta-up.sh 就起不来（EADDRINUSE）。确认是谁之后手动处置；
  若确实是 ${name} 的旧进程（比如别的内测根 / 手工起的），核对命令行后 kill -TERM <pid>。"
        return 3
      fi
    fi
  fi
  beta_say "$name 本来就没在跑"
  return 0
}

# beta_node_banner_key <节点名> —— logs/<节点名>.out 首行那条启动 JSON 说它是这个节点吗；
# 是就打印它的 publicKey，否则返回 1。
#
# 启动行是 resident 在**监听之前**打的（resident.ts），日志又是 beta_start_process 刚用 `>`
# 截断过的——所以它只可能来自刚起的那个进程，与端口上是谁在应答无关。
beta_node_banner_key() {
  local node="$1" line key
  line="$(head -1 "$(beta_logfile "$node" out)" 2>/dev/null || true)"
  case "$line" in
    '{'*"\"node\":\"${node}\""*) ;;
    *) return 1 ;;
  esac
  key="$(printf '%s\n' "$line" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')"
  beta_public_key_ok "$key" || return 1
  printf '%s\n' "$key"
}

# 起完到「算它起住了」之间等多久。1 s 足够抓住 exec 失败那一类（`nohup` 找不到命令是
# 毫秒级的 127），又不至于让三处起法多花十几秒。留一个覆盖口只为用例（把它调到 0 等于
# 关掉②，见下），运维不需要动它。
BETA_START_GRACE_S="${QIANMO_BETA_START_GRACE_S:-1}"

# beta_start_process <名字> <配置根> -- <命令...>
# 起一个后台进程，pid 落 run/，stdout/stderr 落 logs/。已在跑的不重起（幂等）。
#
# ── 存活校验是**本函数的义务**，不是调用方的（issue #40）────────────────────
# 此前这里无条件打一行「已启动（pid N）」并写 pid 文件：`$!` 拿到的是后台那一格的
# pid，而 `nohup` 随后可以以 127 退出，函数既不检查也不用返回值区分。仓库自己的三处
# 调用都老实跟了 beta_dump_if_dead，所以主路径一直是安全的——**但那是调用方的自觉**，
# 第一个出树调用方（部署机上的瘦封装）就漏掉了：操作者看到一行绿色的
# 「OK : <节点> 已启动（pid N）」，实际节点是死的，`run/<名字>.pid` 里还留下一个指向
# 已死 pid 的陈旧记录。那与 beta-down.sh 顶部小心提防的「陈旧 pid + pid 号复用」是同一
# 个隐患的两半：一边不敢信陈旧 pid，另一边在主动生产陈旧 pid。
#
# 两道，顺序有意：
#   ① 起**之前**先问这条命令在不在。那正是 2026-08-24 舰队部署撞上的确切形状
#      （bun 装在 ~/.bun/bin，非交互 SSH 解析不到），判定是确定性的、不用等，且报出来
#      的是病因而不是症状。
#   ② 起**之后**等一个宽限再问它还在不在。②盖住①盖不住的那半边（参数不合法、端口
#      被占、配置根不可写……），代价是每处起法多 1 s。
# 死了就把 stderr/stdout 摊开并 die —— 复用 beta_dump_if_dead，输出与调用方原先自己
# 跟的那一句完全一致，信息量只增不减。
beta_start_process() {
  local name="$1" config_dir="$2"
  shift 2
  if beta_running "$name"; then
    beta_ok "$name 已在运行（pid $(cat "$(beta_pidfile "$name")")），不重起"
    return 0
  fi
  command -v "$1" >/dev/null 2>&1 || beta_die "$name 起不来：$1 跑不起来 —— 它既不在 PATH 上，也不是一个可执行文件。
整套脚本硬依赖 bun（resident 与 console 两条腿都强制它）。非交互 SSH 下最常见的形状是
bun 装在 ~/.bun/bin 而那个目录不在非登录 shell 的 PATH 里；显式补上再跑：
  PATH=\"\$HOME/.bun/bin:\$PATH\" demo/env/beta/beta-up.sh ..."
  local out err
  out="$(beta_logfile "$name" out)"
  err="$(beta_logfile "$name" err)"
  mkdir -p "$config_dir"
  chmod 700 "$config_dir"
  # 每个进程一个配置根：审计链、节点身份、会话表都按配置根分家（见文件头）。
  OCC_CONFIG_DIR="$config_dir" nohup "$@" >"$out" 2>"$err" &
  local pid=$!
  printf '%s\n' "$pid" >"$(beta_pidfile "$name")"
  sleep "$BETA_START_GRACE_S"
  beta_dump_if_dead "$name"
  beta_ok "$name 已启动（pid ${pid}，日志 ${out}）"
}

# 进程死了就把它的错误摊开来，不要只说一句「没起来」。
#
# 顺带**收掉那个 pid 文件**：它此刻指着一个不存在的进程，而 pid 号是会被复用的
# （beta-down.sh 顶部那段注释讲的正是这个隐患）。留着它，等于给下一次 beta_running
# 留下一个会说谎的依据——幂等起停的全部判据就是它。
beta_dump_if_dead() {
  local name="$1" file
  beta_running "$name" && return 0
  file="$(beta_pidfile "$name")"
  if [ -f "$file" ]; then
    beta_assert_inside_root "$file"
    rm -f "$file"
  fi
  beta_say "--- $name stderr 末尾 ---"
  tail -20 "$(beta_logfile "$name" err)" 2>/dev/null || true
  beta_say "--- $name stdout 末尾 ---"
  tail -20 "$(beta_logfile "$name" out)" 2>/dev/null || true
  beta_die "$name 未能保持运行"
}

# ── 拨测 helper ──────────────────────────────────────────────────────────────

# beta_http_status <url> —— 打印 HTTP 状态码，拿不到就打 000。
#
# curl 在 Debian minimal 上不一定有（`unzip` 都没有，demo-env.md §4.4 踩过），
# 所以留一条 bun 兜底——bun 本来就是硬依赖（occ 跑在它上面）。
# 不用 `timeout`：macOS 自带的系统里没有这个命令。
beta_http_status() {
  local url="$1" out
  # 先把输出接住再判断：连不上时 curl 自己也会按 -w 打一个 `000` **并**返回非零，
  # 写成 `curl … || printf '000'` 会得到 `000000` —— 一个永远不等于 200 的字符串，
  # 症状是「就绪探测永远超时」而日志里什么都没有。
  if command -v curl >/dev/null 2>&1; then
    out="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || true)"
  else
    out="$(bun -e 'const r = await fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }); process.stdout.write(String(r.status))' "$url" 2>/dev/null || true)"
  fi
  [ -n "$out" ] || out='000'
  printf '%s' "$out"
}

# beta_tcp_open <host> <port> —— 端口收不收 TCP 连接。
#
# 只用于**本机回环、且本机真的在 listen** 的就绪判断：/dev/tcp 没有超时，对远端可能挂住。
# 它只证明「在监听」，**证不了 PSK 对不对**——那要真握手，而握手只有从 H 拨过来
# 才算数（beta-smoke.sh 的 host 腿做的正是那件事）。
#
# ── 它在隧道口上**恒为真**，所以那里被硬拦下 ────────────────────────────────
# `ssh -L 127.0.0.1:<local>:127.0.0.1:<remote>` 的本地口是 **ssh 客户端自己**在 LISTEN。
# 节点侧那个端口没人监听（或被 permitopen 挡住）时，ssh 照样 accept，然后立刻把这条
# 连接关掉。于是「连得上」这件事只证明 ssh 进程活着，与节点死活完全无关。
# 实测（H 上，一条指向节点某个无人监听端口的隧道）：
#     旧判据 beta_tcp_open → TCP_OPEN=YES（假绿）
#     新判据 beta_endpoint_live → 读到 EOF，红
# 所以这里对隧道口直接 die：把一条恒真的判据留在那儿，比没有判据更糟。
beta_tcp_open() {
  local host="$1" port="$2"
  case "$BETA_TUNNEL_PORTS" in
    *" $port "*)
      beta_die "beta_tcp_open 被用在隧道口 ${host}:${port} 上 —— 那是一条**恒为真**的判据（见本函数头注）。
隧道口的就绪只有 beta_endpoint_live 说了算：它真读一次对端的应答字节。"
      ;;
  esac
  (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null || return 1
  return 0
}

# beta_endpoint_live <host> <port> [超时秒] —— 对端**真的回了字节**吗。
#
# 判据是「收到一行以 HTTP/ 开头的应答」。节点入站是一个 WebSocket 服务，对一条普通
# GET 会回 `HTTP/1.1 426 Upgrade Required`——那一行必须由节点进程产生，中间任何一段
# 只转发不应答的链路都伪造不出来。它同时替 TCP 探测答了那个真正的问题：
# **对面那个进程还在不在**。
#
# 三种结果都判红，且都是对的：连不上（ECONNREFUSED）、连上后立刻 EOF（隧道通、节点
# 那一侧没人监听 = 上面说的假绿形状）、超时没有任何字节（对端挂死）。
#
# 它仍然**证不了 PSK 对不对**——那要一次真握手（beta-smoke.sh 的 p81-probe）。
# 这里只回答就绪，不回答鉴权。
#
# 放在子 shell 里跑：fd 3 不会漏回调用方，`read -t` 超时也不会踩到 set -e。
beta_endpoint_live() {
  local host="$1" port="$2" wait_s="${3:-5}"
  (
    exec 3<>"/dev/tcp/$host/$port" || exit 1
    printf 'GET / HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n' "$host" >&3 || exit 1
    line=''
    IFS= read -r -t "$wait_s" line <&3 || true
    case "$line" in
      HTTP/*) exit 0 ;;
    esac
    exit 1
  ) 2>/dev/null
}

# beta_http_body <url> —— 打印响应体；拿不到就打空串。curl 缺席时走 bun（同 beta_http_status）。
beta_http_body() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -s --max-time 5 "$url" 2>/dev/null || true
  else
    bun -e 'const r = await fetch(process.argv[1], { signal: AbortSignal.timeout(5000) }); process.stdout.write(await r.text())' "$url" 2>/dev/null || true
  fi
}

# ── occ 产物 ────────────────────────────────────────────────────────────────

# 没有构建产物就明确报错，不去猜。造它的是 demo/env/bootstrap.sh（内测沿用同一条）。
#
# **产物在不在、和跑得动它的解释器在不在，是两件事**（issue #40）。这里原先只查前者，
# 而整套脚本硬依赖 `bun "$BETA_OCC"`（resident 与 console 两条腿都强制 Bun）。缺 bun 时
# 唯一的痕迹在 logs/<名字>.err 里的 `nohup: failed to run command 'bun'`，起法脚本当时
# 一个字都不说。2026-08-24 的舰队部署实际形状：bun 装在 ~/.bun/bin，非交互 SSH（乃至
# `bash -lc`）解析不到，四台里三台静默死亡，唯独 root 那台因为 /root/.bun/bin 在 PATH 里
# 而活着 —— 「大部分挂、一台好」看起来像机器有问题，其实是 PATH 有问题。
#
# 同一道守卫仓库里另有三处（demo/env/bootstrap.sh、beta-retain.sh、
# remote/prepare-sandbox.sh），写法照它们对齐，这里只是补上漏掉的这一处。
beta_require_occ() {
  # shellcheck disable=SC2016
  #   ↑ 提示里的 $HOME / $PATH 是**给人照抄的字面量**，不是要在这里展开的。
  command -v bun >/dev/null 2>&1 || beta_die 'bun 不在 PATH 上 —— resident 与 console 两条腿都强制 Bun。
非交互 SSH 下最常见的形状是 bun 装在 ~/.bun/bin 而那个目录不在非登录 shell 的 PATH 里
（`ssh <机器> demo/env/beta/beta-up.sh ...` 解析不到它，`bash -lc` 也未必）。
装法见 docs/dev/demo-env.md §2；已装就在命令前显式补上，例如
  PATH="$HOME/.bun/bin:$PATH" demo/env/beta/beta-up.sh ...'
  [ -f "$BETA_OCC" ] || beta_die "缺 $BETA_OCC —— 先跑 demo/env/bootstrap.sh"
}

# ── 链路：systemd --user 的隧道与镜像单元 ───────────────────────────────────
#
# 全部生成物都是**从仓库 demo/env/beta/ops/ 派生**的，装好的那几份是副本。
# 这一节只提供 helper，真正的编排在 beta-up.sh 的 provision_links。

# 本次运行改写了几个文件。> 0 才 daemon-reload —— 无脑 reload 不致命，但它会让
# 「这次到底动没动东西」这个问题在输出里消失，而那正是幂等性唯一的量具。
BETA_SYNC_CHANGED=0
# 改写了单元文件、而该单元此刻正在跑的那些实例。它们的**运行中定义仍是旧的**，
# systemd 不会因为文件变了就重启（这正是我们要的：隧道不能说断就断），
# 但它也不会在任何地方留下痕迹，所以必须由脚本自己在末尾说出来。
BETA_UNITS_STALE=''

# 这台机器现在能用 systemd --user 吗。**只回答，不 die**：起 H 腿的机器不一定有
# systemd（开发机上跑用例就没有），而那种情况下「不铺单元」是正确行为，不是故障。
# 要求必须有的那条路径走 beta_require_systemd_user。
beta_systemd_user_ok() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1 || return 1
  return 0
}

# ── 单元状态与现实脱节：两个方向都会，而且都是设计使然 ─────────────────────
#
# 2026-08-24 的真机腿实测：`systemctl --user is-active qianmo-console.service` 答
# `inactive`（rc=3），而同一时刻控制台 `/v0/health` 200、38621 LISTEN、进程已跑
# 6539 s；同机四条 `qianmo-tunnel@beta-N.service` 全是 active（issue #64）。
#
# **这不是 bug，是本包两条设计的合成结果**，两个方向各有一个：
#   · `inactive` 而进程活着 —— beta-up.sh 每趟都自己起进程、对 H 腿那两个单元**只
#     enable 不 start**（理由在 provision_host_units 的头注：start 会让脚本要求
#     systemd 起一个此刻正由自己跑着的单元，那是自己等自己）。于是单元从没被 systemd
#     跑过，`is-active` 当然是 inactive。
#   · `active` 而进程已经没了 —— `Type=oneshot` + `RemainAfterExit=yes`：active 只
#     意味着「那一趟 ExecStart 跑完过」。`Restart=` 对 oneshot 无效，进程崩了没人拉。
#
# 于是这两个单元的状态**在两个方向上都不是存活判据**。这里不去把它修成「真实反映
# 进程」——那要么把 peers.conf 派生出来的整条命令行抄进单元文件（第二处真源，正是
# 单元头注拒绝的那件事），要么让 beta-up.sh 转手去 `systemctl start`（`Requires=`
# 会把整条 links+registry 腿再跑一遍，且任何一步绊倒就把一套活着的部署变成 failed）。
# 代价都比收益大。改为：**把这条差距说出来**，并把唯一算数的判据（`/v0/health`）钉在
# 所有会有人去看的地方。最坏的中间态是「看起来有个状态可查，查出来是错的」——一句话
# 就能把它从陷阱变成常识。

# beta_unit_state_note <单元名> <is-active 的输出> <进程活着吗 0/1>
# 状态与现实一致时什么都不打；不一致时打一段说明。它**永远不下 FAIL 判定**：
# 「inactive 而进程活着」恰恰是本包的正常形态，报成失败等于把一套对的部署判红。
beta_unit_state_note() {
  local unit="$1" state="$2" alive="$3"
  if [ "$alive" = '1' ] && [ "$state" != 'active' ]; then
    printf '%s\n' "${unit} 是 ${state:-未知}，而它管的进程活着 —— **这是正常形态，不是故障**。
本脚本每趟都自己起进程，对这个单元只 enable 不 start（那样才能让「这一趟起没起成」与
「下次开机它还在」互不牵连），于是它从没被 systemd 跑过。
**单元状态不是存活判据**，反方向也不是（oneshot + RemainAfterExit 会在进程死后继续报
active）。算数的只有 /v0/health（issue #64）。"
    return 0
  fi
  if [ "$alive" = '0' ] && [ "$state" = 'active' ]; then
    printf '%s\n' "${unit} 是 active，而它管的进程答不出话 —— 这是 Type=oneshot + RemainAfterExit=yes
的固有形状：active 只意味着「那一趟 ExecStart 跑完过」，不意味着进程还在，而 Restart= 对
oneshot 无效。**以 /v0/health 为准**（issue #64）。"
    return 0
  fi
  return 0
}

beta_require_systemd_user() {
  command -v systemctl >/dev/null 2>&1 \
    || beta_die "peers.conf 里有 node 坐标行，但这台机器上没有 systemctl —— 隧道与镜像都靠 systemd --user。
要么去掉那些坐标行改回直连（那需要节点入站端口对 H 放行），要么换一台有 systemd 的宿主。
**不要**让脚本静默跳过隧道：那会得到一个「名册上在线、拨号全超时」的拓扑（beta-env.md §9.1）。"
  systemctl --user show-environment >/dev/null 2>&1 \
    || beta_die "systemctl --user 用不了（没有用户级 D-Bus 会话）。
常见原因是没开 linger：loginctl enable-linger <用户名> 要 root 跑一次，
否则最后一个登录会话退出时，全部隧道会跟着一起消失。"
  return 0
}

# beta_unit_path <绝对路径> —— 渲染成 systemd 单元里该写的形式。
#
# 家目录下的路径渲染成 %h/…：那是 systemd 自己的写法，而且让同一份单元在任何账号下
# 都成立。家目录之外原样输出（QIANMO_BETA_ROOT 被挪到别处时）。
beta_unit_path() {
  local abs="$1"
  case "$abs" in
    "$HOME"/*) printf '%%h/%s' "${abs#"$HOME"/}" ;;
    *) printf '%s' "$abs" ;;
  esac
}

# beta_write_if_changed <内容文件> <目标> <权限> <说明>
#
# **只在内容真的不同时才写**。这不是省一次 write：`systemctl --user daemon-reload`
# 与「这次动了什么」的输出都挂在 BETA_SYNC_CHANGED 上，而幂等性验收看的正是那行输出。
#
# 内容走**文件参数**而不是 stdin：`产生内容 | beta_write_if_changed …` 会把函数体扔进
# 子 shell，于是 BETA_SYNC_CHANGED 的自增当场丢掉——脚本会报「什么都没改」然后不
# daemon-reload。这是管道 + 计数器最经典的一个坑，别改回去。
beta_write_if_changed() {
  local src="$1" dst="$2" mode="$3" what="$4" tmp existed=0
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    beta_ok "$what 已是仓库派生的内容，不动"
    return 0
  fi
  if [ -f "$dst" ]; then existed=1; fi
  # 先落 tmp、改好权限再 mv：0600 的文件不能有「已经写完但还是默认权限」的那一瞬间。
  tmp="$dst.tmp.$$"
  cp "$src" "$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dst"
  BETA_SYNC_CHANGED=$((BETA_SYNC_CHANGED + 1))
  if [ "$existed" = '1' ]; then
    beta_warn "$what 与仓库那份不一致，已按仓库重写：$dst"
  else
    beta_ok "$what 已生成：$dst"
  fi
  return 0
}

# 单元文件只允许落在 systemd --user 目录里，且文件名必须是本包认识的那五个之一
# （链路三个模板单元 + H 腿那两个）。
# 这是三重守卫在「不在内测根里的那几个路径」上的对应物：guard_root 管不到
# ~/.config/systemd/user，所以这里逐个复核。
beta_assert_unit_file() {
  local path="$1" base
  case "$path" in
    "$BETA_SYSTEMD_USER_DIR"/*) ;;
    *) beta_die "拒绝处理 $BETA_SYSTEMD_USER_DIR 之外的单元文件：$path" ;;
  esac
  case "$path" in *..*) beta_die "单元文件路径里有 ..，拒绝：$path" ;; esac
  base="${path##*/}"
  case "$base" in
    'qianmo-tunnel@.service'|'qianmo-mirror@.service'|'qianmo-mirror@.timer') ;;
    "$BETA_REGISTRY_UNIT"|"$BETA_CONSOLE_UNIT") ;;
    *) beta_die "拒绝处理不属于本包的单元文件：$base" ;;
  esac
  return 0
}

# beta_unit_instance <前缀> <节点名> <后缀> —— 拼一个实例单元名，并复核节点名。
# 实例名会原样进 systemctl 的命令行，所以拼之前再验一次字符集（解析时已经验过一遍，
# 这里是「守卫写在动作旁边」的那一遍）。
beta_unit_instance() {
  local prefix="$1" node="$2" suffix="$3"
  beta_assert_node_name "$node" '单元实例名'
  printf '%s@%s%s' "$prefix" "$node" "$suffix"
}

# ── 控制台的持久化选项（console.conf）─────────────────────────────────────────
#
# 为什么要有这个文件：页头标签此前只走环境变量。控制台一重起就静默丢失，看的人无法
# 区分同一台 H 上的不同部署。节点名册、审计路径与唤醒目标不是展示偏好，不能在这里留
# 一份副本：它们只从 peers.conf 的当前内容派生。
#
# 格式：`KEY=值`，值取到行尾（标签里有空格、`·` 和中括号），# 开头是注释。
# **用手写解析而不是 source**：source 一个配置文件等于执行它，而这个文件将来会被运维
# 手改。

# beta_conf_get <文件> <键> —— 打印值；没有该键就打空串。
beta_conf_get() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$key="*) printf '%s' "${line#"$key"=}"; return 0 ;;
    esac
  done <"$file"
  return 0
}

# console.conf 的**旧 schema**：审计目标与唤醒目标曾经也存在这里（AUDIT_NODE /
# AUDIT_PATH / WAKE_NODE，单数，一份文件只放得下一个目标）。改成「只认 peers.conf」
# 之后这三个键就再也没人读了——**而没人读不等于没人写**：2026-08-24 的舰队实查里，H
# 上那份 2026-08-18 的 console.conf 还整整齐齐写着它们。一份看着像配置、实际一个字都
# 不生效的文件，会把下一个照着它配的人直接带沟里。
#
# 所以读到它们要说出来。清除本身是回写顺手做的（下面那个函数只写 LABEL 一行），这里
# 只负责**别让它静默发生**。
BETA_CONSOLE_CONF_LEGACY_KEYS='AUDIT_NODE AUDIT_PATH WAKE_NODE'

# beta_conf_legacy_keys <文件> —— 打印文件里出现过的旧键，一行一个；没有就什么都不打。
beta_conf_legacy_keys() {
  local file="$1" key line
  [ -f "$file" ] || return 0
  for key in $BETA_CONSOLE_CONF_LEGACY_KEYS; do
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        "$key="*) printf '%s\n' "$key"; break ;;
      esac
    done <"$file"
  done
  return 0
}

# ── 存量 LABEL 与当前名册对不上 ─────────────────────────────────────────────
#
# 上面那条守卫删了旧 schema 的三个键并报了很响的警，**却漏了同一个文件里同样过时的
# 第四样东西：LABEL 本身**。2026-08-24 铺新产物时 H 上躺着的是单节点时代的
# 「…审计视图：beta-1（…权威副本在节点本机）」，而控制台早已是四目标形态；那一趟
# 显式带了 QIANMO_BETA_LABEL 才没让页头退回单节点文案（issue #60）。
#
# 后果只是页头文案错，但形状与 #45 是同一个：**静默继承一份过期状态**。而标签恰恰是
# 「50 个人都会看到、且不需要账号体系」的那个广播位（beta-env.md §7.4），说错了没有
# 任何一条链路会红。
#
# 判据故意窄 —— **只在标签自己点名了名册的一部分时才说话**：
#   · 一个节点名都没提的标签（派生默认那句「多节点审计视图」就是）永远不报；
#   · 提全了的不报。`beta-1..4` 这种区间写法先展开再比，否则现场那份正确的标签会
#     每跑一次假警报一次 —— 而一条会误报的警等于没有警；
#   · 提了一部分（`beta-1`，名册四个）、或提到名册里已经没有的名字 —— 报。
# 宽一点的判据（「数一数标签里出现过几个数字」之类）在正常标签上就会红，那正是这条
# 守卫此前没人写的原因；把它收窄到「标签自称点名了谁」就既不误报也抓得住那一例。

# beta_label_claimed_nodes <标签> <名册节点>... —— 打印标签「点名」的节点名，一行一个。
#
# 点名 = 标签里出现了一个**完整**的节点名词（前后都不是节点名字符），且它要么就在
# 名册里，要么长得像名册里那批（同一个去掉末尾数字的词根，于是删掉的 beta-9 也算
# 点名，而 `滞后 ≤ 5 min` 里的 `5` 不算）。区间写法先展开。
#
# 用 awk 而不是 bash 循环：切词与区间展开在 bash 3.2 里要写成一串 ${} 剥字符，
# 而这份标签是 UTF-8 中文 —— bash 3.2 按字节切，那正是 issue #49 那类只在 macOS 上
# 炸的写法。LC_ALL=C 让 awk 也按字节走：我们只关心 ASCII 词，多字节字符逐字节变成
# 分隔符，结果一样。
beta_label_claimed_nodes() {
  local label="$1"
  shift
  LC_ALL=C awk -v label="$label" 'BEGIN {
    for (i = 1; i < ARGC; i++) {
      name = ARGV[i]
      roster[name] = 1
      stem = name
      if (sub(/[0-9]+$/, "", stem) > 0 && stem != "") stems[stem] = 1
    }

    # ① 区间展开：beta-1..4 → beta-1 beta-2 beta-3 beta-4。
    #    上界 63 是护栏，不是语义：`1..100000` 是笔误，不该让这里转一分钟。
    s = label
    out = ""
    while (match(s, /[a-z0-9_-]*[0-9]+\.\.[0-9]+/)) {
      tok = substr(s, RSTART, RLENGTH)
      out = out substr(s, 1, RSTART - 1)
      s = substr(s, RSTART + RLENGTH)
      p = index(tok, "..")
      left = substr(tok, 1, p - 1)
      last = substr(tok, p + 2) + 0
      stem = left
      sub(/[0-9]+$/, "", stem)
      first = substr(left, length(stem) + 1) + 0
      if (last < first || last - first > 63) { out = out " " tok " "; continue }
      for (k = first; k <= last; k++) out = out " " stem k " "
    }
    s = out s

    # ② 切词：非节点名字符一律当分隔符，于是「：」「（」「、」都不用逐个枚举。
    gsub(/[^a-z0-9_-]/, " ", s)
    m = split(s, words, " ")
    for (k = 1; k <= m; k++) {
      w = words[k]
      if (w == "" || (w in seen)) continue
      claimed = (w in roster)
      if (!claimed) {
        stem = w
        if (sub(/[0-9]+$/, "", stem) > 0 && (stem in stems)) claimed = 1
      }
      if (claimed) { seen[w] = 1; print w }
    }
    exit 0
  }' "$@"
}

# beta_label_roster_drift <标签> <名册节点>... —— 有漂移时打印，一行一条：
#   missing <节点>   名册里有、标签没点到的
#   extra   <节点>   标签点到、名册里已经没有的
# 没有漂移，或标签一个节点都没点名时，什么都不打（返回码恒 0，调用方看输出）。
beta_label_roster_drift() {
  local label="$1" node claimed=' ' roster=' ' any=0
  shift
  for node in "$@"; do roster="$roster$node "; done
  for node in $(beta_label_claimed_nodes "$label" "$@"); do
    claimed="$claimed$node "
    any=1
  done
  [ "$any" = '1' ] || return 0
  for node in "$@"; do
    case "$claimed" in *" $node "*) ;; *) printf 'missing %s\n' "$node" ;; esac
  done
  for node in $claimed; do
    case "$roster" in *" $node "*) ;; *) printf 'extra %s\n' "$node" ;; esac
  done
  return 0
}

# 审计节点的链是镜像来的吗（= 它有 node 坐标行且给了 trail=）。
beta_node_is_mirrored() {
  local node="$1" index
  index="$(beta_ssh_index "$node")" || return 1
  [ -n "${BETA_SSH_TRAIL[$index]}" ] || return 1
  return 0
}

# beta_resolve_console_conf —— 定下 BETA_LABEL 并回写 console.conf。
# 它必须在 beta_load_peers 之后调用，以确保一份历史 console.conf 不会重新成为节点
# 名册的来源。优先级：环境变量 > console.conf > 派生默认。
beta_resolve_console_conf() {
  local from_file legacy source drift missing extra line
  # 旧 schema 的键一个都不读，但**必须报出来再删**：静默忽略正是它能在 H 上原样躺
  # 六天、还骗过一次实查的原因（issue #45）。
  legacy="$(beta_conf_legacy_keys "$BETA_CONSOLE_CONF" | tr '\n' ' ')"
  if [ -n "$legacy" ]; then
    beta_warn "${BETA_CONSOLE_CONF} 里还有旧 schema 的键：${legacy}—— 它们**一个字都不生效**，本次回写会删掉。
节点名册、审计链路径与唤醒目标只从 ${BETA_PEERS_FILE} 的当前内容派生（那三个键是单数写法，
一份文件只放得下一个目标；现在每个节点各有一条审计来源和一个唤醒地址）。
要改目标就改 peers.conf；这个文件从此只剩 LABEL 一行。"
  fi
  source='环境变量 QIANMO_BETA_LABEL'
  if [ -z "$BETA_LABEL" ]; then
    from_file="$(beta_conf_get "$BETA_CONSOLE_CONF" LABEL)"
    if [ -n "$from_file" ]; then
      BETA_LABEL="$from_file"
      source="${BETA_CONSOLE_CONF} 里的存量 LABEL"
    else
      BETA_LABEL='阡陌内测环境 · 多节点审计视图'
      source='派生默认'
    fi
  fi

  # 标签点名的节点与当前名册对不上就说一句（判据与理由见 beta_label_claimed_nodes
  # 上面那一节）。`$(beta_peer_nodes)` 不加引号是要它按空白拆成多个参数 —— 节点名
  # 的字符集里没有空白（beta_assert_node_name），这里拆不出意外。
  missing=''
  extra=''
  drift="$(beta_label_roster_drift "$BETA_LABEL" $(beta_peer_nodes))"
  while IFS= read -r line; do
    case "$line" in
      'missing '*) missing="$missing ${line#missing }" ;;
      'extra '*) extra="$extra ${line#extra }" ;;
    esac
  done <<EOF
$drift
EOF
  if [ -n "$missing" ] || [ -n "$extra" ]; then
    beta_warn "页头标签点名的节点与 ${BETA_PEERS_FILE} 对不上：${missing:+
  标签没点到：${missing# }}${extra:+
  标签点到、名册里已经没有：${extra# }}
现在这句是「${BETA_LABEL}」，来源是${source}。
标签不影响任何一条链路，所以没有别的东西会为此变红 —— 而它恰恰是 50 个人唯一看得见的那一格
（beta-env.md §7.4）。一份单节点时代的标签会让人以为这套部署只有一个节点（issue #60）。
要换：QIANMO_BETA_LABEL='…' demo/env/beta/beta-up.sh --role host（新值会回写进 console.conf）。"
  fi

  {
    printf '# 阡陌内测 · 控制台的持久化选项。由 demo/env/beta/beta-up.sh 读写。\n'
    printf '#\n'
    printf '# 这里只持久化页面标签。环境变量仍然优先，且会被回写到这里。\n'
    printf '# 节点、审计链路径和唤醒目标只从 peers.conf 派生，绝不在这里保留副本。\n'
    printf '# 旧 schema 的 AUDIT_NODE / AUDIT_PATH / WAKE_NODE 一个字都不生效，写在这里\n'
    printf '# 会被下一次 beta-up.sh --role host 报出来并删掉（issue #45）。\n'
    printf '#\n'
    printf '# 一行一个 KEY=值，值取到行尾。手改这里立刻生效（下次 beta-up.sh 起控制台时）。\n'
    printf 'LABEL=%s\n' "$BETA_LABEL"
  } >"$BETA_CONSOLE_CONF.tmp.$$"
  chmod 600 "$BETA_CONSOLE_CONF.tmp.$$"
  mv -f "$BETA_CONSOLE_CONF.tmp.$$" "$BETA_CONSOLE_CONF"
  return 0
}

# ── 注册中心落盘表与 peers.conf 的一致性 ────────────────────────────────────
#
# **这是一个必须由脚本代劳的检查，不是一条运维纪律。**病根在 demo/lib/p81-registry.ts
# 的 announce()：
#     if (registry.heartbeat(address) !== null) continue
# 注册中心重启时会从落盘表 restore；租约 90 s 内的条目原样回来（带着**旧端点**），
# 于是 heartbeat 成功、`continue`，那条 --register 被整条跳过。此后每 20 s 的续租又把
# 租约续上，旧端点就永远留在表里。症状是「改了 peers.conf、smoke 全红，而 peers.conf
# 明明是对的」——没有任何一行日志会提到落盘表。
#
# 落盘表挪开就够了吗：**注册中心没在跑时够**。已经在跑的那一份，表在内存里，
# 必须重起它才能生效——那一步会明说，因为它是本脚本唯一一个会重起的组件。

# beta_state_pairs <落盘表> —— 打印 `<地址> <端点>`，一行一条。
#
# 依赖的形状：FileRegistryStore 写的是 `JSON.stringify(doc, null, 2)`
# （packages/registry/src/store.ts），所以每个字段独占一行。这不是在猜别人的格式，
# 是在读我们自己的序列化器。
beta_state_pairs() {
  awk '
    /"address"[[:space:]]*:/ {
      line = $0
      sub(/^.*"address"[[:space:]]*:[[:space:]]*"/, "", line)
      sub(/".*$/, "", line)
      address = line
      next
    }
    /"endpoint"[[:space:]]*:/ {
      if (address == "") next
      line = $0
      sub(/^.*"endpoint"[[:space:]]*:[[:space:]]*"/, "", line)
      sub(/".*$/, "", line)
      print address " " line
      address = ""
    }
  ' "$1"
}

# beta_urlencode_address <地址> —— 只处理 : 和 /（地址的字符集在解析时已经卡死）。
beta_urlencode_address() {
  printf '%s' "$1" | sed -e 's|:|%3A|g' -e 's|/|%2F|g'
}

# beta_live_endpoint <地址> —— 问在跑的注册中心：这个地址现在解析到哪。
# 拿不到（404 / 注册中心没起）就打空串。单条 agent 的响应里 endpoint 只出现一次。
beta_live_endpoint() {
  local body
  body="$(beta_http_body "$BETA_REGISTRY_URL/v0/agents/$(beta_urlencode_address "$1")")"
  case "$body" in
    *'"endpoint":"'*) ;;
    *) return 0 ;;
  esac
  printf '%s' "$body" | sed -e 's/.*"endpoint":"//' -e 's/".*//'
}

# beta_live_public_key <地址> —— 问在跑的注册中心：这条登记上挂着哪把公钥。
# 没有公钥 / 拿不到就打空串。单条 agent 的响应里 publicKey 最多出现一次（没有就整个键缺席）。
beta_live_public_key() {
  local body
  body="$(beta_http_body "$BETA_REGISTRY_URL/v0/agents/$(beta_urlencode_address "$1")")"
  case "$body" in
    *'"publicKey":"'*) ;;
    *) return 0 ;;
  esac
  printf '%s' "$body" | sed -e 's/.*"publicKey":"//' -e 's/".*//'
}

# beta_provisioned_nodes —— 本机 ops/ 下真的铺过链路的节点名，一行一个。
#
# 停机与重置**从这里**取节点，不从 peers.conf 取：那两个动作要处理的是「已经铺出去的
# 东西」，而 peers.conf 随时可能已经被改过。一个刚被从地址表里删掉的节点，它的隧道还
# 在跑——照 peers.conf 停机会把它漏下，而漏下的隧道会一直占着那个回环口。
beta_provisioned_nodes() {
  local file base
  # glob 没匹配到时 bash 会把模式原样留下，所以逐个 `[ -f ]` 复核。
  for file in "$BETA_OPS_DIR"/tunnel-*.env; do
    [ -f "$file" ] || continue
    base="${file##*/}"
    base="${base#tunnel-}"
    printf '%s\n' "${base%.env}"
  done
}

# beta_stop_host_unit <单元名> —— 停掉并取消自启 H 腿的一个单元。
#
# 只有 beta-reset.sh --purge-links 用它：删掉单元文件之前必须先 disable，否则
# default.target.wants/ 下会留一条指向已删文件的悬空符号链接，每次开机让 systemd
# 抱怨一句，而「清干净了」的输出上一个字都看不出来。
# 幂等：没装过 / 没起过的，一个字都不打。
beta_stop_host_unit() {
  local unit="$1"
  beta_systemd_user_ok || return 0
  if [ "$(systemctl --user is-active "$unit" 2>/dev/null || true)" = 'active' ]; then
    systemctl --user stop "$unit" >/dev/null 2>&1 || true
    beta_say "已停止 $unit"
  fi
  if [ "$(systemctl --user is-enabled "$unit" 2>/dev/null || true)" = 'enabled' ]; then
    systemctl --user disable "$unit" >/dev/null 2>&1 || true
    beta_say "已取消开机自启 $unit"
  fi
  return 0
}

# beta_note_host_unit <单元名> <说明> —— 进程停了、单元还标着 active 时说一句。
#
# oneshot + RemainAfterExit 的单元记的是「那一趟起过了」，不是「进程还活着」：
# beta-down.sh 把进程停掉之后，`systemctl --user status` 仍然一片绿。那是本包里
# 唯一一处「单元绿而东西不在」的形状，不说出来就会有人照着它下结论。
beta_note_host_unit() {
  local unit="$1" what="$2"
  beta_systemd_user_ok || return 0
  [ -f "$BETA_SYSTEMD_USER_DIR/$unit" ] || return 0
  [ "$(systemctl --user is-active "$unit" 2>/dev/null || true)" = 'active' ] || return 0
  beta_warn "${what}的进程已停，但 systemd 那边 $unit 仍标着 active。
那是 oneshot + RemainAfterExit 的形状：它记的是「那一趟起过了」，不是「进程还活着」。
要连单元一起停：systemctl --user stop $unit
要起回来  ：systemctl --user start ${unit}（等价于跑一趟 beta-up.sh --role host）"
  return 0
}

# beta_tunnel_extra_args <坐标行下标> —— 这条隧道在 -L 之外还要带的 ssh 参数。
#
# 目前只有一种：审计见证的反向转发（P11.4）。见证端点只听 H 的回环，节点要把锚点
# 写过去，就借 H 发起的这条会话开一个 `-R`——节点上因此不需要任何指向 H 的凭据
# （§8.3 的单向信任，也是见证方与被见证方不同失陷域的前提）。节点侧 authorized_keys
# 那一行的 `permitlisten` 把它钉死在这一个口上（beta-env.md §9.10 那个缺口同时关掉）。
# 没给 witness-port= 就打印空串：单元里 `$TUNNEL_EXTRA_ARGS` 展开成零个参数。
beta_tunnel_extra_args() {
  local port="${BETA_SSH_WITNESS[$1]:-}"
  [ -n "$port" ] || return 0
  printf -- '-R 127.0.0.1:%s:127.0.0.1:%s' "$port" "$port"
}

# beta_prepare_witness —— 尾参里有 --witness-url 时，把写 token 从文件读进环境。
#
# URL 走尾参（随 issue #111 的记录活过「停机 → 换产物 → 起机」），token 只走环境：
# resident 自己就是这么要求的（`--witness-url requires QIANMO_WITNESS_WRITE_TOKEN`），
# 这里只是把「文件 → 环境」这一步做了，并把两种会在起进程之后才暴露的错提前拦下：
#   · 有 URL 没 token（或 token 文件权限过宽）——节点会起不来，而错误埋在 .err 里；
#   · 明文 http 指向回环以外——写 token 在 Authorization 头里，那等于把它广播出去。
#     经 SSH `-R` 转过来的端点在节点这一侧就是回环口，所以内测形态下永远是回环。
# 只在节点腿调：控制台与注册中心不需要这枚 token，给了只是多一处能被读走的副本。
beta_prepare_witness() {
  local url
  url="$(beta_passthrough_value --witness-url)"
  [ -n "$url" ] || return 0
  beta_assert_token_url "$url" --witness-url '写'
  if [ -z "${QIANMO_WITNESS_WRITE_TOKEN:-}" ]; then
    beta_export_secret_file QIANMO_WITNESS_WRITE_TOKEN "$BETA_WITNESS_WRITE_FILE" \
      "尾参里有 --witness-url，但缺见证写 token：${BETA_WITNESS_WRITE_FILE}（0600，由见证机发下来）"
  fi
  beta_ok "审计见证 : ${url}（写 token 从文件进环境，不上命令行）"
}

# beta_prepare_console_anchors —— 控制台尾参里的 --anchors 是 http(s) 端点时，把见证
# **读** token 从文件读进环境（控制台只认 QIANMO_WITNESS_READ_TOKEN，consoleArgs.ts）。
#
# 见证放在 H 上时 --anchors 给的是本机目录，用不到这枚 token。可是 H 同时也是节点机
# （beta-4 就在 H 上）时，见证就不能放在 H 上（audit-witness.md §4.1：见证方与被见证方
# 不同失陷域），控制台只能经 HTTP 把锚点读回来——这枚 token 就是为这一种形态准备的。
# 它只能「读」：拿到它的人能列出锚点，改不了任何一条（端点只增不删）。
# 两种会在起进程之后才暴露的错在这里提前拦下，理由与 beta_prepare_witness 相同。
beta_prepare_console_anchors() {
  local url
  url="$(beta_passthrough_value --anchors)"
  case "$url" in
    http://*|https://*) ;;
    *) return 0 ;;
  esac
  beta_assert_token_url "$url" --anchors '读'
  if [ -z "${QIANMO_WITNESS_READ_TOKEN:-}" ]; then
    beta_export_secret_file QIANMO_WITNESS_READ_TOKEN "$BETA_WITNESS_READ_FILE" \
      "尾参里的 --anchors 是 HTTP 端点，但缺见证读 token：${BETA_WITNESS_READ_FILE}（0600，由见证机发下来）"
  fi
  beta_ok "见证锚点 : ${url}（读 token 从文件进环境，不上命令行）"
}

# beta_passthrough_value <开关> —— 尾参里这个开关的值（`--x v` 与 `--x=v` 两种写法都认，
# 出现多次取最后一个——与各命令自己的解析一致）。没有就打印空串。
beta_passthrough_value() {
  local flag="$1" arg prev='' value=''
  for arg in ${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"}; do
    case "$arg" in
      "$flag"=*) value="${arg#"$flag"=}" ;;
    esac
    if [ "$prev" = "$flag" ]; then value="$arg"; fi
    prev="$arg"
  done
  printf '%s' "$value"
}

# beta_assert_token_url <URL> <开关> <读|写> —— 带 token 的请求只许走 https，或者走回环上的 http。
# 经 SSH -L / -R 转过来的端点在本机这一侧就是回环口，所以内测形态下永远是回环。
beta_assert_token_url() {
  case "$1" in
    https://*) ;;
    http://127.0.0.1:*|http://127.0.0.1/*|http://localhost:*|http://localhost/*|http://\[::1\]:*) ;;
    *) beta_die "$2 是明文 http 且不指向回环：${1}——$3 token 在请求头里，走明文就等于广播" ;;
  esac
}

# beta_export_secret_file <变量名> <文件> <缺文件时的话> —— 普通文件、0600、非空，才读进环境。
beta_export_secret_file() {
  local var="$1" file="$2" missing="$3" mode value
  [ -f "$file" ] || beta_die "$missing"
  mode="$(stat -c %a "$file" 2>/dev/null || stat -f %Lp "$file")"
  [ "$mode" = '600' ] || beta_die "${file} 权限是 ${mode}，要 600"
  value="$(cat "$file")"
  [ -n "$value" ] || beta_die "${file} 是空的"
  export "$var=$value"
}

# beta_raise_oom_score —— 把**本 shell** 的 oom_score_adj 调到 BETA_OOM_SCORE_ADJ。
#
# 在起 resident 之前调：子进程（resident 与它 spawn 的 ACP 子进程）继承这个值。
#
# 为什么默认 1000：内测节点借住在别人的机器上（2026-09 的舰队是负责人的代理出口，
# 同机跑着 xray / nginx / 别的服务，内存 1~2 GB）。一个 agent 轮次的峰值约 370 MB，
# 内存打满时内核按 oom_score 挑进程杀——不调，被挑中的可能是那台机器真正的主业；
# 调到 1000，被挑中的一定先是我们。阡陌节点被杀的代价是一个轮次失败、下次重起，
# 这是可以接受的那一边。
#
# 调高不需要特权（调低才要），所以非 root 账号也做得到。写不进去（非 Linux、容器
# 里 /proc 只读）只 WARN，不拦节点起来：OOM 次序是防护，不是节点能不能工作的前提。
beta_raise_oom_score() {
  case "$BETA_OOM_SCORE_ADJ" in
    off)
      beta_say 'OOM 次序 : 未调整（QIANMO_BETA_OOM_SCORE_ADJ=off）'
      return 0
      ;;
    ''|*[!0-9]*)
      beta_die "QIANMO_BETA_OOM_SCORE_ADJ 要 0~1000 的整数或 off，收到「${BETA_OOM_SCORE_ADJ}」"
      ;;
  esac
  [ "$BETA_OOM_SCORE_ADJ" -le 1000 ] \
    || beta_die "QIANMO_BETA_OOM_SCORE_ADJ 超过 1000：${BETA_OOM_SCORE_ADJ}"
  if [ ! -w "$BETA_OOM_ADJ_PATH" ]; then
    beta_warn "写不了 ${BETA_OOM_ADJ_PATH}（不是 Linux，或 /proc 只读）—— 本节点的 OOM 次序保持系统默认"
    return 0
  fi
  if printf '%s\n' "$BETA_OOM_SCORE_ADJ" >"$BETA_OOM_ADJ_PATH" 2>/dev/null; then
    beta_ok "OOM 次序 : oom_score_adj=${BETA_OOM_SCORE_ADJ}（内存打满时内核先挑本节点，而不是同机别的服务）"
  else
    # 非 root 想把一个继承来的高值调低，内核会拒绝——那也只是防护没到位。
    beta_warn "oom_score_adj 写入被拒（${BETA_OOM_SCORE_ADJ}）—— 本节点的 OOM 次序保持继承来的值"
  fi
  return 0
}

# beta_stop_link <node> —— 停掉并取消自启该节点的隧道与镜像 timer。
#
# 顺序是**先镜像后隧道**：镜像那条是主动往外拨的，先让它别再发起新连接。
# 幂等：本来就没在跑 / 本来就没自启的，一个字都不打。
#
# **「在跑」不只是 `active`。**一条对端已经不在的隧道，绝大多数时间处在
# `activating`（`Restart=always` 的 5 s 退避里），只有连接失败前那一瞬是 `active`。
# 2026-09-26 在 H 上清三条死隧道时，只认 `active` 的旧写法把其中一条**取消了自启、
# 却没停掉**：它照样每几秒重启一次、继续往 journald 里刷。所以这里反过来问——
# 只有 `inactive` / `failed`（以及查不到状态）才算已经停了，其余一律 stop。
beta_stop_link() {
  local node="$1" unit state
  beta_assert_node_name "$node" '链路实例名'
  beta_systemd_user_ok || return 0
  for unit in \
    "$(beta_unit_instance 'qianmo-mirror' "$node" '.timer')" \
    "$(beta_unit_instance 'qianmo-tunnel' "$node" '.service')"; do
    state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
    case "$state" in
      inactive|failed|'') ;;
      *)
        systemctl --user stop "$unit" >/dev/null 2>&1 || true
        beta_say "已停止 ${unit}（停之前是 ${state}）"
        ;;
    esac
    if [ "$(systemctl --user is-enabled "$unit" 2>/dev/null || true)" = 'enabled' ]; then
      systemctl --user disable "$unit" >/dev/null 2>&1 || true
      beta_say "已取消开机自启 $unit"
    fi
  done
  return 0
}
