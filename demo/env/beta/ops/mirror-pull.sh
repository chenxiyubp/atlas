#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · 把一个节点的审计链**单向只读**拉到 H 的 mirror/<node>/trail.ndjson。
#
#   mirror-pull.sh <node>
#
# **这个文件由 `beta-up.sh --role host` 从仓库拷进 <内测根>/ops/。**改那一份没有意义
# ——下一次 beta-up.sh 会照仓库这一份覆盖它。要改就改 demo/env/beta/ops/mirror-pull.sh。
#
# 权威副本永远是节点本机那一份（beta-env.md §4.3）；这里拉到 H 的是镜像，用途只有两个：
# 出事时四条链摆在一起看，以及给 P11.4 的锚定留取样点。**页面上必须能看出它是镜像**：
# H 腿从 peers.conf 派生命名 --audit 与 --audit-mirror 参数，来源卡片显示镜像与允许滞后；
# console.conf 只保存页头标签。
#
# 方向纪律：**只从节点拉，绝不往节点推。**
#
# ── 为什么只剩 `ssh cat` 一条路径（原先几台走 rsync）───────────────────────────
# H 的那把 key 在四台节点的 authorized_keys 里现在带**强制命令**：
#     restrict,port-forwarding,permitopen="127.0.0.1:<入站端口>",command="/usr/bin/cat -- <链>"
# 强制命令会**忽略客户端发来的命令**，于是 rsync 协商不到远端的 `rsync --server --sender`，
# 必然挂在握手上。这不是退化——它正是这把 key 被收紧的证据：它连自己那条审计链之外的
# 任何东西都读不到。链文件只有 KB 量级，全量 cat 无代价。
#
# 下面那条 ssh 仍把 `cat -- <链>` 作为远端命令发过去：**在强制命令下它是空转**
# （只会落进 SSH_ORIGINAL_COMMAND），但万一哪天选项行被回退，这个脚本照旧是对的。

# ── 退出码的契约（systemd 把非零当 failed，所以这不是风格问题）─────────────────
# 0 = 镜像更新了，**或者**远端链还没建起来。后者是合法初始态：一条链的第一条记录要
#     等这个节点第一次真做协议工作。把它当失败，就是每 5 分钟造一次 service failure
#     ——内测环境曾经这样连续失败数天，于是没有人再看这四个单元的状态（issue #9）。
#     节点侧写到一半的 torn_tail 也走 0（照常镜像，stderr 说一声），理由在下面那条
#     分支里。
# 1 = 真失败：SSH 不通/认证被拒（含传输中途断掉，ssh 给 255）、远端文件存在但读不了、
#     或者「远端说没有这个文件／拉到空文件，而本地已经有一份非空镜像」（链消失了）。
# **这两类必须分开，但更不能把第二类一起吞掉**——把一个吵闹的盲区换成一个安静的
# 盲区，比现在更糟。`mirror-pull.test.ts` 逐格钉住这张表。

set -euo pipefail

node="${1:?用法：mirror-pull.sh <node>}"

# 内测根从**本脚本自己的位置**推，不从 $HOME 拼：systemd 单元里这个脚本的路径就是
# <内测根>/ops/mirror-pull.sh，所以 QIANMO_BETA_ROOT 换到哪里，这里跟着换。
# 写死 $HOME/qianmo-beta 的版本在一个非默认根的机器上会安静地拉进错误的目录。
OPS_DIR="$(cd "$(dirname "$0")" && pwd)"
BETA_ROOT="$(cd "$OPS_DIR/.." && pwd)"

env_file="$OPS_DIR/tunnel-$node.env"
[ -f "$env_file" ] || {
  printf '缺 %s —— 它由 beta-up.sh 从 peers.conf 的 node 坐标行派生\n' "$env_file" >&2
  exit 1
}
# shellcheck disable=SC1090
#   ↑ 路径按参数拼，shellcheck 无法静态跟进；文件是本脚本的同伴生成物、0600。
. "$env_file"
: "${NODE_SSH_USER:?}" "${NODE_SSH_HOST:?}" "${NODE_SSH_PORT:?}" "${NODE_SSH_KEY:?}" "${REMOTE_TRAIL:?}"

# MIRROR_METHOD 现在只有一个合法值。留着这个分支不是为了扩展性，是为了让「有人把
# rsync 写回去」当场报错并说明理由，而不是挂在 ssh 握手上等到超时。
case "${MIRROR_METHOD:-cat}" in
  cat) ;;
  rsync)
    printf 'MIRROR_METHOD=rsync 已不可用：这把 key 带强制命令，rsync 起不了远端 --sender。改成 cat。\n' >&2
    exit 1
    ;;
  *)
    printf '未知 MIRROR_METHOD=%s（只支持 cat）\n' "$MIRROR_METHOD" >&2
    exit 1
    ;;
esac

dest_dir="$BETA_ROOT/mirror/$node"
mkdir -p "$dest_dir"
dest="$dest_dir/trail.ndjson"
tmp="$dest.tmp.$$"
cleanup() { rm -f "$tmp"; }
trap cleanup EXIT
# **真正兜住残留的是下面这一行，不是上面那个 trap。**实测（bash 3.2，四组对照）：
# 脚本停在前台的 `ssh` 上时被单独 kill -TERM，`trap ... EXIT` **不跑**，临时文件留下；
# 把 HUP/INT/TERM 一起挂上去也一样不跑——bash 把信号 trap 推迟到前台命令结束之后，
# 而那条 ssh 还在。信号发给整个进程组（systemd 默认 KillMode=control-group 就是这样，
# ssh 跟着一起死）时两种写法都清得干净，SIGKILL 则两种都清不掉。
#
# 所以 trap 只保常规路径与 errexit，残留由**下一次运行开头扫一遍**收掉。安全的前提写在
# 这里：这个目录只有本实例（`qianmo-mirror@<node>.service`，oneshot + timer，同实例不会
# 重叠）会写，所以此刻还在的 `.tmp.*` 一定属于一个已经死掉的运行。
rm -f "$dest".tmp.*

# shellcheck disable=SC2086
#   ↑ 选项串故意分词：它们是一串独立的 ssh 参数，不是一个带空格的值。
common_opts="-i $NODE_SSH_KEY -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 -p $NODE_SSH_PORT"

# stdout 进临时文件，stderr 进变量（`2>&1 >file` 的顺序就是这个意思，反过来写两边都
# 进文件）。要拿住 stderr，是因为**它是我们唯一能用来区分「链还没建」与「拉取失败」
# 的信号**：那把 key 带强制命令（本文件头注），客户端发不了 `test -e` 去先问一句，
# 而 `cat` 对「没这个文件」与「有但读不了」给的是**同一个退出码 1**。
#
# `LC_ALL=C` + `SendEnv` 是尽力把远端那句话固定成英文（服务端不收就不收，不报错）。
# 判定**不依赖**它：认不出的信息一律当失败处理，这个方向才是安全的那一边。
set +e
# shellcheck disable=SC2086
stderr="$(LC_ALL=C ssh -n -o SendEnv=LC_ALL $common_opts \
  "$NODE_SSH_USER@$NODE_SSH_HOST" "cat -- '$REMOTE_TRAIL'" 2>&1 >"$tmp")"
status=$?
set -e

# 远端说的是「没这个文件」吗？「Permission denied」、「Is a directory」那些都不算——它们是真故障。
remote_trail_missing() {
  case "$stderr" in
    *'No such file or directory'*) return 0 ;;
    *ENOENT*) return 0 ;;
    *) return 1 ;;
  esac
}

# 「链还没开始」只在**还没有镜像**时才是合法初始态。已经拉到过一份、现在远端突然说没有，
# 那是链消失了，必须当故障报——这正是审计面最不能静默的一种。
mirror_started() { [ -s "$dest" ]; }

pending() {
  printf '%s  %s  远端审计链尚未创建（%s）——合法的初始态，不是拉取失败\n' \
    "$(date -u +%FT%TZ)" "$node" "$1"
  exit 0
}

fail() {
  printf '%s 拉取失败：%s\n' "$node" "$1" >&2
  [ -z "$stderr" ] || printf '  远端/ssh 说：%s\n' "$stderr" >&2
  exit 1
}

if [ "$status" -eq 255 ]; then
  # 255 是 ssh **自己**的错（连不上、认证被拒、主机键不对），跟远端命令的退出码分开。
  fail 'SSH 本身失败（连接/认证/主机键）'
elif [ "$status" -ne 0 ]; then
  if remote_trail_missing; then
    if mirror_started; then
      fail '远端链文件消失了（本地已有一份非空镜像）'
    fi
    pending '远端还没有这个文件'
  fi
  fail "远端 cat 退出码 $status"
elif [ ! -s "$tmp" ]; then
  # 文件存在但零字节：节点刚建链、还没写第一条时就是这个形状。同样只在本地还没有
  # 镜像时算初始态；**永远不用空文件盖掉一条已有的链**（`occ audit --verify` 对空文件
  # 不报错，页面上也看不出来）。
  if mirror_started; then
    fail '拉到的是空文件，而本地已有一份非空镜像，保留上一份'
  fi
  pending '远端链文件存在但还是空的'
elif [ "$(tail -c 1 "$tmp" | wc -l)" -ne 1 ]; then
  # 结尾断在一行中间。**这不算拉取失败，但要说一声**——两件事在这里必须分清：
  #
  # - 传输被截断：ssh 会给非零（连接断是 255，远端被信号打死是 128+n），已经在上面
  #   那两个分支里失败掉了。exit 0 意味着远端命令**跑完了**，所以拿到的就是节点上
  #   那一份的样子。
  # - 节点侧写到一半崩了：`@qianmo/audit` 的 `readTrail` 把它叫 `torn_tail` 并**明说
  #   它不是篡改**（那是一次硬重启的正常样子）。为它每 5 分钟造一次 service failure，
  #   就是把 issue #9 那个形状原样搬到另一个格子里，而且这一份数据还是该镜像过来的。
  printf '%s 拉到的内容不以换行结尾（torn_tail：节点侧最后一次写没写完）——照常镜像\n' \
    "$node" >&2
fi

chmod 600 "$tmp"
# 原子替换：`occ audit --verify` 永远不会读到半个文件。
mv -f "$tmp" "$dest"
printf '%s  %s  bytes=%s lines=%s\n' "$(date -u +%FT%TZ)" "$node" "$(wc -c <"$dest")" "$(wc -l <"$dest")"
