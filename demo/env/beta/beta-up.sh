#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P11.1 落地包① —— 起内测拓扑。**两条腿一个脚本，用 --role 区分。**
#
#   demo/env/beta/beta-up.sh --role host              # H：注册中心 + 控制台（+ 备份服务，见下）
#   demo/env/beta/beta-up.sh --role node --node <名字> # 任一节点机：该机那一个常驻节点
#
# 为什么两条腿合一个脚本而不是拆两个：它们共用**同一套**根目录布局、同一套守卫、同一份
# 地址表与同一组端口常量。拆成两个文件的第一天是干净的，第三次改端口的时候就会有一边
# 忘了改——而那种不一致的症状是「名册上在线、拨不通」（beta-env.md §9.1），最难查的一类。
#
#   注册中心 :  127.0.0.1:38620   永不出回环（零鉴权，§9.2）
#   控制台   :  127.0.0.1:38621   由反代以 TLS 暴露，它是用户唯一的对外面（§2.5）
#   节点入站 :  0.0.0.0:38625     每台节点机各一个
#
# ── 节点入站怎么被 H 拨到：两种形态，peers.conf 说了算 ──────────────────────
# ① **直连**（默认形态）：peers.conf 里该节点的端点就是它的真实地址。节点入站绑
#    0.0.0.0，那个端口上唯一的门是 PSK 握手（§2.6/§8）。
# ② **SSH 隧道**（兜底）：该节点在 peers.conf 里另有一条 `node` 坐标行。现场三台节点的
#    入站端口被云厂商安全组挡着（实测 22/80/443 通，入站端口与另外十个候选端口全不通），
#    所以本脚本为这些节点建 systemd --user 的 `ssh -L`，把节点的 127.0.0.1:38625 映到 H
#    的回环口；peers.conf 的端点写成那个回环口，**应用层一行代码不改**。这时那个端口
#    根本不对外开放，门是 sshd 的公钥 + PSK 两道。
#    同一条坐标行还定义了审计链的单向只读镜像（节点 → H，5 min 一次）。
#
# **隧道不是默认形态**：没有坐标行的节点保持直连（node-provisioning.md §0 第 12 条的
# 控制面 / 数据面分工）。单元与拉取脚本从 demo/env/beta/ops/ 派生，真源在仓库。
#
# **幂等**：已在跑的进程不重起（照 demo/env/up.sh 的 demo_running）。这是 §6 L0 的前提——
# 「① beta-down.sh <name> 只停这一个 → ③ beta-up.sh 幂等，已在跑的不会被重起」。
#
# ── 尾参透传：`--` 之后的一切原样交给底层命令 ────────────────────────────────
#
#   beta-up.sh --role node --node <名字> -- --trust <节点>=<公钥>   # → resident
#   beta-up.sh --role host               -- --wake-sign            # → console
#
# **为什么是一条透传约定，而不是给每个参数配一个专用开关**（issue #38）：本脚本管的是
# **拓扑**——端口、配置根、PSK 从哪读、审计链在哪、任务策略两个开关。`--trust` /
# `--wake-sign` 管的是 resident 与 console 自己的**策略**，而那一侧还有一长串同类的
# （`--require-signed-tasks`、`--trust-ca`、`--cert`、`--chat-url`…）。今天补三个专用开关，
# 明天就有第四个够不着——2026-08-24 的舰队部署正是卡在这里：签名唤醒是本仓库已实现、
# 却用本仓库的部署脚本部署不出来的能力，只能在部署机上手写瘦封装绕开这里的参数解析，
# 那份封装不可重复、不可交接。一条透传约定让这类参数**再也不用改这个脚本**。
#
# **节点腿的尾参会被记下来**（issue #111）：写进 `<root>/state/<节点>.passthrough`，
# 下一次不带 `--` 跑节点腿时原样读回来并打印。给了 `--` 就以这一趟为准并重写记录，
# 给一个**空的** `--` 是明确清空。方向与控制台腿相反，理由写在 `resolve_node_passthrough`
# 那段注释里——一句话：换产物每次都要重跑本脚本，而「不给就撤掉」在这里等于让
# 「停机 → 换产物 → 起机」默认改掉节点的策略面。
#
# 三件事跟着这条约定：
#   · 透传参数一律**追加在最后**。它是逃生门：真要覆盖上面某个默认值时，最后一个赢。
#   · 它是逃生门**不是旁路**：`--view-token` / `--admin-token` 的值形式当场拦下（密钥
#     不上命令行，理由见 run_host 里那段注释）。
#   · **`--print-wake-identity` 本身不是透传参数**，它是本脚本自己的开关。那不是一次
#     启动而是一次查询：透传过去会被 beta_start_process 起成后台进程、把那一行公钥
#     写进 logs/console.out 然后退出，于是存活校验（issue #40）如实报它「起不来」。
#     `--` 里的**其余**参数照样跟着那次查询走：身份由 --chat-from 决定，所以
#     `--print-wake-identity -- --chat-from <地址>` 与 `--role host -- --chat-from <地址>`
#     必须问出同一把钥匙——两边不一致就等于分发了一把控制台根本不用来签名的公钥。
#
# ── 开机自启：控制台与注册中心各一个 systemd --user 单元 ────────────────────
#
# 隧道与审计镜像早就有单元，唯独这两个一直是裸进程 —— H 一重启就都没了，且不会自动
# 回来（issue #45）。本脚本每次起 H 腿都派生并安装它们（模板真源在 demo/env/beta/ops/），
# **只 enable 不 start**：这一趟的进程由本脚本自己起。
#
# 单元的 ExecStart 调的就是本脚本，用 `--only` 限定起哪一块 —— 命令行是 peers.conf 派生
# 的，抄进单元文件就是第二处真源。控制台的尾参落进 <root>/ops/console.env，于是
# `--wake-sign` 这类开关活得过一次重启。
#
# 全部状态在 QIANMO_BETA_ROOT 下（默认 $HOME/qianmo-beta）。**不碰用户真实的 ~/.occ / ~/.qianmo。**
# 停机用 beta-down.sh，回到可重起的干净运行态用 beta-reset.sh。

set -euo pipefail

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ROLE=''
NODE_GIVEN=0
AGENTS_GIVEN=''
PRINT_WAKE_IDENTITY=0
# host 腿只起其中一部分。空 = 全套（= 改造前的行为，一个字都没变）。
# 它是给 systemd 单元用的：控制台与注册中心各一个单元，各自只该起自己那一块。
ONLY_GIVEN=''
# `--` 之后的一切，原样追加给底层命令。空数组在 bash 3.2 的 `set -u` 下不能直接
# `"${PASS_THROUGH[@]}"` 展开，所以下面每一处都用 `${PASS_THROUGH[@]+"..."}` 的形式。
PASS_THROUGH=()
# 给没给过 `--` 与「`--` 后面是空的」是两件事，节点腿要靠它们区分「沿用上一次」
# 和「明确清空」（issue #111）。`PASS_THROUGH=()` 两种情况下长得一样。
PASS_THROUGH_GIVEN=0
READY_TIMEOUT_S="${QIANMO_BETA_READY_TIMEOUT_S:-90}"

usage() {
  beta_say '用法：'
  beta_say '  beta-up.sh --role host [--only links|registry|console]... [-- <透传给 console 的参数>...]'
  beta_say '  beta-up.sh --role node --node <名字> [--agent <名字>]... [--port <端口>] [-- <透传给 resident 的参数>...]'
  beta_say '  beta-up.sh --print-wake-identity'
  beta_say ''
  beta_say '本脚本支持的全部参数：'
  beta_say '  --role host|node        起哪条腿。除 --print-wake-identity 外必给'
  beta_say '  --node <名字>           节点腿：这台机器上那一个节点的名字'
  beta_say '  --agent <名字>          节点腿：跑哪些 agent；可给多次，给了就把默认那份整体顶掉'
  beta_say '  --port <端口>           节点腿：入站端口'
  beta_say '  --only links|registry|console'
  beta_say '                          host 腿：只起这一块；可给多次。不给 = 全套（默认）'
  beta_say '                          systemd 单元用的就是它，日常起机不需要'
  beta_say '  --print-wake-identity   只打印控制台的唤醒签名身份（<节点>=<公钥>）后退出，不起任何进程'
  beta_say '  -h, --help              本页'
  beta_say '  -- <args>...            其余参数原样追加给底层命令：host 腿给 console，node 腿给 resident'
  beta_say ''
  beta_say '签名唤醒链路就用尾参透传，三步，顺序不能换：'
  beta_say '  ① H 上   ：beta-up.sh --print-wake-identity            → 打出 <节点>=<公钥>'
  beta_say '  ② 每台节点：beta-up.sh --role node --node <名字> -- --trust <节点>=<公钥>'
  beta_say '  ③ H 上   ：beta-up.sh --role host -- --wake-sign'
  beta_say ''
  # 页头标签在这里单独占一段，而不是留给「变量与完整说明见 README」那一句：**本脚本
  # 没有 --label**，而这是每次起 H 腿都会碰到的东西（issue #60）。三条路只有一条通：
  #   · `--label` —— 不存在；
  #   · 尾参 `-- --label "…"` —— 这一趟的进程会带上它，但标签里必然有空白，写不进
  #     ops/console.env 的一行（write_console_env 会为此 WARN），于是活不过一次重启；
  #   · 环境变量 —— 唯一能被回写进 console.conf、因而活过重启的入口。
  beta_say '页头标签（控制台唯一那格广播位）只有一个入口，本脚本没有 --label：'
  beta_say "  QIANMO_BETA_LABEL='阡陌内测环境 · 审计视图：…' beta-up.sh --role host"
  beta_say '  不给就沿用 <内测根>/console.conf 里的存量值，再没有就用派生默认。'
  beta_say '  存量标签点名的节点与 peers.conf 对不上时，本脚本会 WARN 一句。'
  beta_say '  尾参里的 --label 只对这一趟的进程生效：标签含空白，写不进 ops/console.env。'
  beta_say ''
  beta_say '其余变量与完整说明见 demo/env/beta/README.md。'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --role)   ROLE="${2:-}"; shift 2 ;;
    --role=*) ROLE="${1#--role=}"; shift ;;
    --node)   BETA_NODE="${2:-}"; NODE_GIVEN=1; shift 2 ;;
    --node=*) BETA_NODE="${1#--node=}"; NODE_GIVEN=1; shift ;;
    # --agent 可以给多次（每节点 2 个，§2.2）。第一次给就把默认那份整体顶掉，
    # 而不是追加——否则「我只想跑一个 agent」会变成「跑了三个」。
    --agent)   AGENTS_GIVEN="$AGENTS_GIVEN ${2:-}"; shift 2 ;;
    --agent=*) AGENTS_GIVEN="$AGENTS_GIVEN ${1#--agent=}"; shift ;;
    --port)   BETA_NODE_PORT="${2:-}"; shift 2 ;;
    --port=*) BETA_NODE_PORT="${1#--port=}"; shift ;;
    # host 腿限定起哪几块（可给多次）。不给 = 全套。
    --only)   ONLY_GIVEN="$ONLY_GIVEN ${2:-}"; shift 2 ;;
    --only=*) ONLY_GIVEN="$ONLY_GIVEN ${1#--only=}"; shift ;;
    # 它**不是**一次启动，所以它自己不能靠尾参表达（见文件头「尾参透传」第三段）；
    # 尾参里的其余参数仍然跟着那次查询走。
    --print-wake-identity) PRINT_WAKE_IDENTITY=1; shift ;;
    --) shift; PASS_THROUGH=("$@"); PASS_THROUGH_GIVEN=1; break ;;
    -h|--help) usage; exit 0 ;;
    # 未知参数把**本脚本支持的参数集**一并打出来。原先只有一句「用 --help 看用法」，
    # 于是排查要多走一步；而这条路上最常见的未知参数恰恰是 resident / console 认识、
    # 本脚本不认识的那些（--trust / --wake-sign / --require-signed-tasks …），所以
    # 顺手把出口指出来。
    *)
      usage >&2
      beta_die "未知参数 $1 —— 上面是本脚本支持的全部参数。
如果它是 resident / console 的参数（--trust / --wake-sign / --require-signed-tasks 之类），
把它放到 -- 后面透传，例如：beta-up.sh --role node --node <名字> -- $1"
      ;;
  esac
done

# --print-wake-identity 不起任何进程，所以它不需要 --role；给了也只能是 host。
if [ "$PRINT_WAKE_IDENTITY" = '1' ]; then
  case "$ROLE" in
    ''|host) ROLE='host' ;;
    *) beta_die "--print-wake-identity 问的是控制台（H 腿）的身份，与 --role $ROLE 不搭" ;;
  esac
else
  [ -n "$ROLE" ] || { usage; beta_die '缺 --role host|node'; }
  case "$ROLE" in
    host|node) ;;
    *) beta_die "--role 只能是 host 或 node，收到 $ROLE" ;;
  esac
fi

# --only 只对 host 腿有意义，且只认三个值。**在这里当场拦下**：拼错一个字（`--only
# consle`）如果只是「一块都不匹配」，结果是一趟什么都没起、还退 0——systemd 会把它记成
# 一次成功的启动，而控制台根本不在。
ONLY=''
if [ -n "$ONLY_GIVEN" ]; then
  [ "$ROLE" = 'host' ] || beta_die "--only 只对 --role host 有意义（节点腿一台机器就一个常驻），收到 --role ${ROLE:-<空>}"
  for _only in $ONLY_GIVEN; do
    case "$_only" in
      links|registry|console) ONLY="$ONLY $_only" ;;
      *) beta_die "--only 只认 links / registry / console，收到：$_only" ;;
    esac
  done
  unset _only
fi

# host_wants <块名> —— 这一趟要不要起这一块。没给 --only 就全要。
host_wants() {
  local want="$1" item
  [ -n "$ONLY" ] || return 0
  for item in $ONLY; do
    if [ "$item" = "$want" ]; then return 0; fi
  done
  return 1
}

# 尾参透传是一条**逃生门，不是一条旁路**：脚本自己保证的那几件事在它后面仍然成立。
# 现在只有一条是能被尾参推翻的 —— 两枚控制台 token 一律走 `--*-token-file`，因为命令行
# 上的密钥就是这台机器每一份进程列表里的密钥（`ps -eo args` / `/proc/<pid>/cmdline` 每个
# 本地账号都读得到，run_host 里那段注释是它的出处）。值形式在这里当场拦下并指到文件
# 形式；其余参数一律不管、原样透传。
#
# **它必须对每一处 PASS_THROUGH 的来源都跑一遍**，所以是个函数而不是一段直写的
# 循环：节点腿的尾参记录（issue #111）是第二个来源，从文件读回来的那一份如果不
# 再过一次这道门，这条守卫就正好变成它自己那句话里说的「旁路」——手改一次记录
# 文件，往后每一次不带 `--` 的重起都会把 token 摆进 `ps` 里。
assert_no_token_values_in_passthrough() {
  local _arg
  for _arg in ${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"}; do
    case "$_arg" in
      --view-token|--view-token=*|--admin-token|--admin-token=*)
        beta_die "尾参里不能出现 ${_arg%%=*} —— 命令行上的 token 会出现在这台机器每一份进程列表里。
本脚本已经在用 --view-token-file / --admin-token-file 传这两枚（0600 文件，在 ${BETA_SECRET_DIR} 下），
要换 token 就改那两个文件的内容。"
        ;;
    esac
  done
}
assert_no_token_values_in_passthrough

# 去掉累加时留下的前导空格：它只影响打印出来那一行的观感，`for a in $BETA_AGENTS`
# 的分词本来就吃得下——但那一行是运维照着抄进运维单页的，别让它带个空格。
if [ -n "$AGENTS_GIVEN" ]; then
  BETA_AGENTS="$(printf '%s' "$AGENTS_GIVEN" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
fi

# 四道开工前的准备，两条腿与 --print-wake-identity 共用同一份。
bootstrap() {
  beta_seed_root
  beta_require_marker
  beta_require_occ
  beta_export_common
}

STARTED_AT="$(beta_now)"
if [ "$PRINT_WAKE_IDENTITY" = '1' ]; then
  # 这一路的标准输出上只能有那一行公钥（它要能被 `$(...)` 接住），而首跑时铺目录会打
  # 「标记文件已建 / 地址表模板已建」两行。整段推到 stderr，而不是逐条加 >&2：以后往
  # bootstrap 里再加一步时，漏掉那一条就会把公钥那一行污染掉，且只在首跑的机器上复现。
  bootstrap >&2
else
  bootstrap
fi
cd "$REPO_DIR"

# ─────────────────────────────────────────────────────────────────────────────
# --print-wake-identity：只回答「该往每个节点的 --trust 里粘什么」
#
# **前台跑、不写 pid、不落日志**：它不是一次启动，是一次查询（控制台自己也把这条路
# 排在读任何凭据之前，正是为了在一台还没配好 token 的机器上也答得出来——那恰好就是
# 分发公钥的那一刻的状态）。
#
# 两个细节决定它能不能用：
#   · **配置根必须和控制台那一份是同一个**。唤醒身份按配置根落盘，拿另一个根打印出来
#     的公钥与控制台真正用来签名的那一把不是同一把，而症状是节点端验签失败——一条
#     「密钥不匹配」的错，查起来看不出是打印的时候就错了。
#   · **标准输出上只有那一行 `<节点>=<公钥>`**，铺目录/守卫的絮语一律推到 stderr，
#     这样它能直接被 `$(...)` 接住喂给下一条命令的 --trust。
# 首次运行会现场创建那把私钥（0600，在配置根里），这是有意的：分发公钥这一步本来就
# 该发生在控制台第一次带 --wake-sign 起来之前。
# ─────────────────────────────────────────────────────────────────────────────
if [ "$PRINT_WAKE_IDENTITY" = '1' ]; then
  mkdir -p "$BETA_CONFIG_CONSOLE"
  chmod 700 "$BETA_CONFIG_CONSOLE"
  beta_say '控制台唤醒签名身份（整行原样放进每个节点的 --trust）：' >&2
  # 尾参一并带上：身份由 --chat-from 决定，这一路与起控制台那一路必须问同一个身份。
  OCC_CONFIG_DIR="$BETA_CONFIG_CONSOLE" bun "$BETA_OCC" console --print-wake-identity \
    ${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"}
  beta_say '' >&2
  beta_say '下一步 : 每台节点机上' >&2
  beta_say '           demo/env/beta/beta-up.sh --role node --node <名字> -- --trust <上面那一行>' >&2
  beta_say '         回到 H 上' >&2
  beta_say '           demo/env/beta/beta-down.sh console && demo/env/beta/beta-up.sh --role host -- --wake-sign' >&2
  exit 0
fi

# 每条地址要随登记一并发布的节点公钥，下标与 BETA_PEER_ADDR 对齐；空 = 不带
# （与加公钥之前的行为一致）。由 resolve_peer_keys 填。
BETA_PEER_KEY=()
# 这一趟算过没有：注册中心与控制台两块都要用，只算一次、只说一遍。
BETA_PEER_KEYS_RESOLVED=0

# 定下每个节点的公钥，逐节点说一句出处或缺口（来源规则见 common.sh 的
# beta_resolve_node_key）。同一份结果有两个去处：
#
#   · 注册中心：随登记发布（2026-09-26 D9b）。手工补上的那一份挂在条目上，条目一旦因租约
#     过期被重新登记就丢了——而 p81-registry 的登记本来就是整条声明，缺省即清空。
#   · 控制台：带 --anchors 时以 `--trust <节点>=<公钥>` 直接交给它（K-11 F-3）。控制台
#     **不再**从名册取验签公钥：名册的写口不鉴权（或只凭一枚共享 token），谁往里写一把
#     公钥，谁就能让一条改过的链显示「已见证」。这里的来源（坐标行、本机身份文件）都不经过
#     注册中心。
resolve_peer_keys() {
  local node i
  if [ "$BETA_PEER_KEYS_RESOLVED" = '1' ]; then return 0; fi
  BETA_PEER_KEY=()
  for node in $(beta_peer_nodes); do
    if beta_resolve_node_key "$node"; then
      beta_ok "名册公钥：${node} → ${BETA_NODE_KEY}（${BETA_NODE_KEY_SOURCE}）"
    else
      beta_warn "名册不带 ${node} 的公钥：${BETA_NODE_KEY_GAP}。
登记照旧（与加公钥之前一样）；但控制台带 --anchors 时也没有它的可信公钥，审计页对它报「没有节点 ${node} 的可信公钥」。"
    fi
    i=0
    while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
      if [ "${BETA_PEER_NODE[$i]}" = "$node" ]; then BETA_PEER_KEY[i]="$BETA_NODE_KEY"; fi
      i=$((i + 1))
    done
  done
  BETA_PEER_KEYS_RESOLVED=1
}

# beta_peer_key_of <节点> —— resolve_peer_keys 给这个节点定下的公钥；没有就打印空串。
beta_peer_key_of() {
  local i=0
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    if [ "${BETA_PEER_NODE[$i]}" = "$1" ]; then
      printf '%s' "${BETA_PEER_KEY[$i]:-}"
      return 0
    fi
    i=$((i + 1))
  done
}

# 注册中心那一块。从 run_host 里提出来只为让 --only 的取舍读起来是一行。
start_registry() {
  beta_head "② 注册中心（$BETA_PEER_COUNT 条登记）"
  resolve_peer_keys
  assert_registry_matches_peers
  local ready="$BETA_RUN_DIR/registry-ready.json"
  local args i key keyed=' '
  args=(
    bun run "$(demo_entry p81-registry)"
    --ready "$ready"
    --port "$BETA_REGISTRY_PORT"
    --host "$BETA_HOST_BIND"
    --state "$BETA_REGISTRY_STATE"
  )
  i=0
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    args+=(--register "${BETA_PEER_ADDR[$i]}=${BETA_PEER_EP[$i]}")
    # 公钥按节点给一次：它是节点的事实（protocol.md §10.1），p81-registry 把它挂到该节点
    # 的每一条登记上。公钥不是凭据，上命令行没有顾虑。
    key="${BETA_PEER_KEY[$i]:-}"
    case "$keyed" in
      *" ${BETA_PEER_NODE[$i]} "*) ;;
      *)
        if [ -n "$key" ]; then
          args+=(--public-key "${BETA_PEER_NODE[$i]}=${key}")
          keyed="${keyed}${BETA_PEER_NODE[$i]} "
        fi
        ;;
    esac
    i=$((i + 1))
  done
  # 写 token 传文件路径（token 不上命令行）。权限与长度由 p81-registry 自己查：不是
  # 0600 就不起，报错在 registry.err 里。
  if [ -f "$BETA_REGISTRY_WRITE_TOKEN_FILE" ]; then
    args+=(--write-token-file "$BETA_REGISTRY_WRITE_TOKEN_FILE")
    beta_ok "注册中心写操作要 token：${BETA_REGISTRY_WRITE_TOKEN_FILE}"
  else
    beta_warn "注册中心写操作不鉴权：没有 ${BETA_REGISTRY_WRITE_TOKEN_FILE}。
本机任何账号都能改名册、发布吊销清单。启用步骤见 demo/env/beta/README.md「注册中心写 token」。"
  fi
  if ! beta_running "$BETA_REGISTRY_PROC"; then rm -f "$ready"; fi
  beta_start_process "$BETA_REGISTRY_PROC" "$BETA_CONFIG_REGISTRY" "${args[@]}"

  i=0
  while [ ! -s "$ready" ] && [ "$i" -lt 30 ]; do
    sleep 1
    i=$((i + 1))
    beta_dump_if_dead "$BETA_REGISTRY_PROC"
  done
  [ -s "$ready" ] || beta_die "注册中心 30 s 内没有写出 ready 文件（见 $(beta_logfile "$BETA_REGISTRY_PROC" err)）"
  beta_ok "注册中心就绪：$BETA_REGISTRY_URL"
}

# ─────────────────────────────────────────────────────────────────────────────
# host 腿：注册中心 + 控制台（+ 备份服务）
# ─────────────────────────────────────────────────────────────────────────────
run_host() {
  beta_load_peers
  if [ "$BETA_PEER_COUNT" -eq 0 ]; then
    beta_die "$BETA_PEERS_FILE 里一条地址都没有 —— 按里面的注释填上「<地址> <端点>」再跑。
凡是要长期存在的地址都必须写进这里（= 注册中心的 --register 启动参数）：
租约 90 s，注册中心停机超过 90 s 后落盘表等于空文件，重启后回来的只有 --register 那批
（beta-env.md §2.4 的硬规矩）。控制台页面上点的那个「注册」活不过一次 90 s 以上的重启。"
  fi

  # console.conf 只保存页头标签；节点、审计路径和唤醒目标只认 peers.conf。
  # 必须在 beta_load_peers 之后，避免历史 console.conf 重新成为一份节点名册。
  beta_resolve_console_conf

  # 开机自启的两个单元。**先于起进程铺**：这一趟起没起成功都不影响「下次开机它还在」，
  # 而反过来（起完再铺）会让一次半途失败的启动同时丢掉持久化。
  beta_head '⓪ 开机自启（控制台与注册中心的 systemd --user 单元）'
  provision_host_units

  if host_wants links; then
    beta_head '① 链路（SSH 隧道与审计镜像）'
    provision_links
  fi

  if host_wants registry; then
    start_registry
  else
    beta_say ''
    beta_say '（--only 未点名 registry，跳过注册中心）'
  fi

  if ! host_wants console; then
    beta_say ''
    beta_say '（--only 未点名 console，跳过控制台）'
    beta_head "H 腿这一块就绪，耗时 $(beta_elapsed "$STARTED_AT")"
    return 0
  fi

  beta_head '③ 控制台'
  # 两枚 token 一律从文件取、一律显式传（§3.2）。首跑时现生成一次并落 0600 文件——
  # 「显式」要的是**跨重启稳定**，而文件正是它的持久形式；自动生成的那条路（控制台
  # 自己 resolveTokens）每次重启都变，50 个人手上的链接会同时失效。
  local view admin
  if [ ! -s "$BETA_VIEW_TOKEN_FILE" ]; then
    beta_random_hex 24 >"$BETA_VIEW_TOKEN_FILE"
    chmod 600 "$BETA_VIEW_TOKEN_FILE"
    beta_ok "view token 已生成（0600，不回显）：$BETA_VIEW_TOKEN_FILE"
  fi
  if [ ! -s "$BETA_ADMIN_TOKEN_FILE" ]; then
    beta_random_hex 24 >"$BETA_ADMIN_TOKEN_FILE"
    chmod 600 "$BETA_ADMIN_TOKEN_FILE"
    beta_ok "admin token 已生成（0600，不回显）：$BETA_ADMIN_TOKEN_FILE"
  fi
  view="$(cat "$BETA_VIEW_TOKEN_FILE")"
  admin="$(cat "$BETA_ADMIN_TOKEN_FILE")"
  [ "$view" != "$admin" ] || beta_die '两枚 token 相同 —— resolveTokens 会拒绝，先删掉其中一个重跑'

  local console_args
  console_args=(
    bun "$BETA_OCC" console
    --port "$BETA_CONSOLE_PORT"
    --hostname "$BETA_HOST_BIND"
    --registry "$BETA_REGISTRY_URL"
    --label "$BETA_LABEL"
    # 传**文件路径**而不是 token 值：命令行上的密钥就是这台机器每一份进程列表里的
    # 密钥（`ps -eo args` / `/proc/<pid>/cmdline` 每个本地账号都读得到）。这条纪律
    # console.md §4.4 早就给 PSK 定下了，token 这半边一直没落实——在 H 上实测确认过
    # admin token 明文可读，宿主上还跑着别的账号与一批容器。两个文件本来就是 0600 的，
    # 换成 `--*-token-file` 之后进程列表里只剩路径。
    # 上面 `$view`/`$admin` 仍要读一次，因为「两枚不能相同」这条得在起进程之前查出来。
    --view-token-file "$BETA_VIEW_TOKEN_FILE"
    --admin-token-file "$BETA_ADMIN_TOKEN_FILE"
  )
  # 续租者（控制台页面上点的「注册」）带注册中心写 token。只看文件在不在，不看注册中心
  # 是否已经在要求：没在要求的注册中心不看这个头，所以控制台可以先于注册中心启用。
  if [ -f "$BETA_REGISTRY_WRITE_TOKEN_FILE" ]; then
    console_args+=(--registry-token-file "$BETA_REGISTRY_WRITE_TOKEN_FILE")
  fi
  # peers.conf is the one node roster. Every distinct node gets exactly one
  # audit source and one wake URL; console.conf never adds a target of its own.
  # server 在这里声明而不是循环里写 `local server=$(...)`：那种写法的退出码是 local 的，
  # 恒为 0，于是「判定不出来就降级」那一支永远走不到。
  local node audit_path wake_url psk_file server
  for node in $(beta_peer_nodes); do
    if beta_node_is_mirrored "$node"; then
      audit_path="$(beta_mirror_trail "$node")"
      console_args+=(--audit "$node=$audit_path")
      console_args+=(--audit-mirror "$node=$BETA_MIRROR_INTERVAL_MIN")
    else
      audit_path="$(beta_node_trail "$node")"
      console_args+=(--audit "$node=$audit_path")
    fi
    if [ ! -f "$audit_path" ]; then
      beta_warn "审计链文件还不存在：$node → ${audit_path}（该节点单独显示为空链）"
    fi

    # 服务器归属。名册上四个节点的端点长得几乎一样（走隧道的都是 ws://127.0.0.1:386xx），
    # 看不出谁在哪台机器上；这一行把 peers.conf 已经知道的那件事传给控制台。
    # **判定不出来就不传**：控制台缺这个参数时整体降级为「不显示归属」，比显示一个
    # 猜出来的机器名好——运维照着错的机器名去查，比没有归属更贵。
    if server="$(beta_peer_server "$node")"; then
      console_args+=(--node-server "$node=$server")
    else
      beta_warn "服务器归属未知：${node}（peers.conf 里既没有坐标行、端点也解不出主机名）"
    fi

    wake_url="$(beta_peer_endpoint "$node")"
    console_args+=(--wake-url "$node=$wake_url")
    psk_file="$(beta_peer_psk_file "$node")"
    if beta_export_peer_wake_psk "$node"; then
      beta_ok "唤醒目标：$node → $wake_url"
    else
      beta_warn "唤醒目标局部降级：$node 缺 PSK：$psk_file"
    fi
  done
  # 见证锚点的验签公钥（K-11 F-3，理由见 resolve_peer_keys 上方）。控制台带 --anchors 而
  # 一把可信公钥都没有（--trust / --trust-ca 都没给）时会拒绝启动，这里先说清楚为什么。
  # 尾参里另给的 `--trust <节点>=…` 与这里算出来的不一致，控制台同样拒绝启动。
  if [ -n "$(beta_passthrough_value --anchors)" ]; then
    local key trusted=0
    resolve_peer_keys
    for node in $(beta_peer_nodes); do
      key="$(beta_peer_key_of "$node")"
      if [ -n "$key" ]; then
        console_args+=(--trust "$node=$key")
        trusted=$((trusted + 1))
      fi
    done
    if [ "$trusted" -eq 0 ] \
      && [ -z "$(beta_passthrough_value --trust)" ] \
      && [ -z "$(beta_passthrough_value --trust-ca)" ]; then
      beta_die "控制台带 --anchors，但没有一把可信公钥：peers.conf 的坐标行都没有 public-key=，
本机也没有节点身份文件，尾参里也没有 --trust / --trust-ca。锚点只按注册中心以外确立的公钥验签，
控制台会拒绝启动。补上公钥来源（见上面「名册不带 … 的公钥」各行的补法）后再跑。"
    fi
    beta_ok "见证验签公钥：${trusted} 个节点经 --trust 交给控制台（不从注册中心取）"
  fi
  # 尾参透传（见文件头）。追加在最后：`--wake-sign` 这类开关就是从这里进来的。
  console_args+=(${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"})
  beta_prepare_console_anchors
  beta_start_process "$BETA_CONSOLE_PROC" "$BETA_CONFIG_CONSOLE" "${console_args[@]}"

  # 探活与下面每一行报出去的地址，都必须是控制台**实际**绑上的那个，而不是覆盖之前的
  # 默认值——尾参可以把它挪走（common.sh 的 beta_console_url_from_args 有实测记录）。
  local console_url
  console_url="$(beta_console_url_from_args "${console_args[@]}")"

  i=0
  local status='000'
  while [ "$i" -lt "$READY_TIMEOUT_S" ]; do
    beta_dump_if_dead "$BETA_CONSOLE_PROC"
    status="$(beta_http_status "$console_url/v0/health")"
    if [ "$status" = '200' ]; then break; fi
    sleep 2
    i=$((i + 2))
  done
  [ "$status" = '200' ] \
    || beta_die "控制台 ${READY_TIMEOUT_S}s 内没有回 ${console_url}/v0/health 200（收到 ${status}，见 $(beta_logfile "$BETA_CONSOLE_PROC" err)）"
  beta_ok "控制台就绪：$console_url"

  if [ -n "$ONLY" ]; then
    beta_head "H 腿这一块就绪，耗时 $(beta_elapsed "$STARTED_AT")"
    beta_say "控制台   : ${console_url}（页头标签：${BETA_LABEL}）"
    return 0
  fi

  beta_head '④ 备份服务'
  # **这里是一个真缺口，不是省略。**`packages/backup` 只导出库函数 `startBackupService()`，
  # 仓库里唯一的调用方是 `demo/lib/ac6b-restore.ts`——那是个一次性演示：它在临时目录里建
  # store、跑完删库恢复就 stop。没有 `occ backup-*` 子命令，也没有任何长驻启动器。
  # 本包的硬约束是「只写 shell 与文档，不含任何功能代码改动」（beta-env.md §10 包①），
  # 所以这里**不伪造**一个入口，只如实报缺。
  # 后果（要写进运维单页）：§2.7 的备份面一期起不来 → 节点不能带 `--backup-url` →
  # §5 里「备份 store 72 h + 14 天日留存」那一行暂时没有数据可管，AC-6(b) 的恢复演示
  # 仍能用 `demo/ac6b-restore.sh` 单独跑。补这个入口是另一个包的事。
  beta_todo '备份服务未启动：@qianmo/backup 没有可执行入口（详见 README「这个脚本不做什么」）'

  beta_head "H 腿就绪，耗时 $(beta_elapsed "$STARTED_AT")"
  beta_say "注册中心 : ${BETA_REGISTRY_URL}（$BETA_PEER_COUNT 条登记，永不出回环）"
  beta_say "控制台   : ${console_url}（由反代以 TLS 暴露；两枚 token 在 ${BETA_SECRET_DIR}）"
  beta_say "审计视图 : $(beta_peer_nodes | tr '\n' ' ')（逐节点独立）"
  beta_say "页头标签 : $BETA_LABEL"
  beta_say "页头标签 : 持久化在 ${BETA_CONSOLE_CONF}；节点清单只认 $BETA_PEERS_FILE"
  if beta_systemd_user_ok; then
    beta_say "开机自启 : ${BETA_REGISTRY_UNIT} + ${BETA_CONSOLE_UNIT}（systemd --user，要 loginctl enable-linger）"
    # 这一行必须紧跟上一行：上一行会让人以为「那两个单元的状态可以拿来查死活」，而它
    # 此刻已经是 inactive 了——本脚本刚刚自己起了进程，只 enable 没 start（issue #64）。
    beta_say "存活判据 : ${console_url}/v0/health 答 200；**上面那两个单元的状态不算数**"
    beta_say '           （两个方向都不算：常年 inactive 而进程活着，也会在进程死后继续 active）'
  else
    beta_say '开机自启 : 无 —— 这台机器上没有可用的 systemd --user，重启后要靠人重跑本脚本'
  fi
  if [ "$BETA_SSH_COUNT" -gt 0 ]; then
    beta_say "链路     : $BETA_SSH_COUNT 条 SSH 隧道 + 审计镜像（systemd --user，见 ${BETA_OPS_DIR}）"
  else
    beta_say '链路     : 全部直连（peers.conf 里没有 node 坐标行）'
  fi
  if [ -n "$BETA_UNITS_STALE" ]; then
    beta_say ''
    beta_warn "下面这些单元的**文件**已按仓库模板更新，但它们此刻正在跑的仍是旧定义 ——
systemd 不会因为文件变了就重启单元（那正是我们要的：隧道不能说断就断）。
它也不会在任何地方留下痕迹，所以只有这一行会告诉你。要让新定义生效，在维护窗口里跑：
  systemctl --user restart$BETA_UNITS_STALE
（重起隧道 = 该节点在几秒内不可达，注册中心的租约 90 s 兜得住，但正在跑的投递会断。）"
  fi
  beta_say ''
  beta_say '下一步   : demo/env/beta/beta-smoke.sh --role host'
}

# ─────────────────────────────────────────────────────────────────────────────
# 链路：为有 node 坐标行的节点建隧道与审计镜像
#
# **幂等是这里的第一要求**：它对着一个正在跑的现场执行，四条隧道与四个 timer 一律
# 不重起。做法是把每一步都写成「先问状态，不同才动」：
#   · 单元文件与拉取脚本用 beta_write_if_changed（内容相同就不写）；
#   · daemon-reload 只在真写过东西时跑；
#   · enable / start 都先 is-enabled / is-active，已经对了就只打一行「不重起」；
#   · **绝不 restart**。文件变了而单元在跑，如实报到末尾那段 WARN 里。
# ─────────────────────────────────────────────────────────────────────────────
provision_links() {
  # 先收残：有过链路、现在 peers.conf 里已经没有坐标行的节点。
  # 这条路径是真会走到的 —— 安全组放行之后「改回直连」就是把坐标行删掉，而删掉之后
  # 那条隧道**照样在跑**：它占着那个回环口，还让「H 到节点」多一跳谁都想不起来的转发。
  sweep_orphan_links

  if [ "$BETA_SSH_COUNT" -eq 0 ]; then
    beta_say 'peers.conf 里没有 node 坐标行 —— 全部节点按**直连**处理，不建隧道、不做镜像。'
    beta_say '隧道是「直连不通时的兜底」，不是默认形态：要用它就给该节点加一条 node 坐标行'
    beta_say "（写法见 $BETA_PEERS_FILE 顶部的注释）。"
    return 0
  fi
  beta_require_systemd_user
  mkdir -p "$BETA_OPS_DIR"
  chmod 700 "$BETA_OPS_DIR"
  mkdir -p "$BETA_SYSTEMD_USER_DIR"
  BETA_SYNC_CHANGED=0
  BETA_UNITS_STALE=''

  render_ops_files

  local i=0
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    write_tunnel_env "$i"
    i=$((i + 1))
  done

  if [ "$BETA_SYNC_CHANGED" -gt 0 ]; then
    systemctl --user daemon-reload
    beta_ok "systemd --user 已 daemon-reload（本次改写了 $BETA_SYNC_CHANGED 个文件）"
  else
    beta_ok '单元与连通定义全部已是仓库派生的内容，无需 daemon-reload'
  fi

  i=0
  local node unit trail
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    node="${BETA_SSH_NODE[$i]}"
    unit="$(beta_unit_instance 'qianmo-tunnel' "$node" '.service')"
    ensure_unit "$unit" "隧道 $node"
    trail="${BETA_SSH_TRAIL[$i]}"
    if [ -n "$trail" ]; then
      unit="$(beta_unit_instance 'qianmo-mirror' "$node" '.timer')"
      ensure_unit "$unit" "审计镜像 ${node}（${BETA_MIRROR_INTERVAL_MIN} min）"
    else
      beta_say "提示 : $node 的坐标行没有 trail=，不做审计镜像（H 上看不到它的链）"
    fi
    i=$((i + 1))
  done

  i=0
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    wait_tunnel_live "${BETA_SSH_NODE[$i]}" "${BETA_SSH_LOCAL[$i]}"
    i=$((i + 1))
  done
}

# 铺过链路、但 peers.conf 里已经没有它坐标行的节点：停掉、取消自启、删掉连通定义。
#
# **不动 mirror/<node>/**：那里面是已经拉回来的审计链副本，「只能挪走、不能撤销」
# （beta-env.md §6.4）对它同样成立。
sweep_orphan_links() {
  local node env_file
  for node in $(beta_provisioned_nodes); do
    if beta_ssh_index "$node" >/dev/null; then continue; fi
    beta_warn "$node 在 peers.conf 里已经没有 node 坐标行了 —— 停掉它那条链路并删掉连通定义
（改回直连时就是这个形状。不收掉的话它会一直占着那个回环口，而 peers.conf 上已经看不到它了。）"
    beta_stop_link "$node"
    env_file="$BETA_OPS_DIR/tunnel-$node.env"
    beta_assert_inside_root "$env_file"
    rm -f "$env_file"
    beta_say "已删除 ${env_file}（mirror/$node/ 一条没动）"
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# H 腿的开机自启：控制台与注册中心各一个 systemd --user 单元
#
# 隧道与审计镜像早就有单元，唯独这两个一直是裸进程 —— H 一重启就都没了，且不会自动
# 回来（issue #45）。这里补上的就是那一件事。
#
# 三条与隧道那套一致：模板真源在仓库 demo/env/beta/ops/、派生进 <内测根>/ops/ 与
# ~/.config/systemd/user/、内容相同就不写（beta_write_if_changed）。
#
# **只 enable，不 start。**start 会在「本脚本正跑在这个单元里」的时候要求 systemd 起
# 一个正在启动的单元，那是自己等自己。enable 只是一个符号链接，幂等且不执行任何东西，
# 而「重启后自动回来」要的正是它。这一趟的进程由本脚本自己起，两件事互不相干。
# ─────────────────────────────────────────────────────────────────────────────
provision_host_units() {
  if ! beta_systemd_user_ok; then
    beta_say '这台机器上没有可用的 systemd --user —— 不铺 H 腿的单元。'
    beta_say '后果要知道：控制台与注册中心**不会**在重启后自动回来（issue #45），得靠人重跑本脚本。'
    beta_say '（开发机上跑用例时这是正常的：那里本来就不该往 ~/.config/systemd 里装东西。）'
    return 0
  fi

  mkdir -p "$BETA_OPS_DIR"
  chmod 700 "$BETA_OPS_DIR"
  mkdir -p "$BETA_SYSTEMD_USER_DIR"

  # **只有覆盖控制台的那一趟才重写 console.env。**否则注册中心单元开机跑的
  # `--only links --only registry`（它没有尾参）会把控制台单元的 --wake-sign 一并抹掉——
  # 每次重启静默降级一次，而降级的方向恰恰是「看起来还开着」。
  if host_wants console; then
    write_console_env
  fi

  local before="$BETA_SYNC_CHANGED" src dst base unit_dst gen path_env
  path_env="$(host_unit_path_env)"
  gen="$BETA_OPS_DIR/.render-host.$$"
  beta_assert_inside_root "$gen"
  for base in "$BETA_REGISTRY_UNIT" "$BETA_CONSOLE_UNIT"; do
    src="$BETA_OPS_SRC_DIR/$base.in"
    [ -f "$src" ] || beta_die "缺仓库模板 $src —— demo/env/beta/ops/ 是单元的真源"
    dst="$BETA_OPS_DIR/$base"
    beta_assert_inside_root "$dst"
    # 占位符全是路径 / 单元名，用 | 作分隔符不会撞上。
    sed -e "s|@REPO_DIR@|$(beta_unit_path "$REPO_DIR")|g" \
      -e "s|@OPS_DIR@|$(beta_unit_path "$BETA_OPS_DIR")|g" \
      -e "s|@BETA_ROOT@|$(beta_unit_path "$BETA_ROOT")|g" \
      -e "s|@UNIT_PATH_ENV@|$path_env|g" \
      -e "s|@REGISTRY_UNIT@|$BETA_REGISTRY_UNIT|g" \
      "$src" >"$gen"
    beta_write_if_changed "$gen" "$dst" 644 "单元模板 $base"
  done
  rm -f "$gen"

  for base in "$BETA_REGISTRY_UNIT" "$BETA_CONSOLE_UNIT"; do
    unit_dst="$BETA_SYSTEMD_USER_DIR/$base"
    beta_assert_unit_file "$unit_dst"
    if [ -f "$unit_dst" ] && cmp -s "$BETA_OPS_DIR/$base" "$unit_dst"; then
      beta_ok "$base 已装且内容一致，不动"
      continue
    fi
    cp "$BETA_OPS_DIR/$base" "$unit_dst"
    chmod 644 "$unit_dst"
    BETA_SYNC_CHANGED=$((BETA_SYNC_CHANGED + 1))
    beta_warn "$base 已装进 ${BETA_SYSTEMD_USER_DIR}（内容有更新）"
  done

  if [ "$BETA_SYNC_CHANGED" -gt "$before" ]; then
    systemctl --user daemon-reload
    beta_ok 'systemd --user 已 daemon-reload（H 腿单元有更新）'
  fi

  for base in "$BETA_REGISTRY_UNIT" "$BETA_CONSOLE_UNIT"; do
    if [ "$(systemctl --user is-enabled "$base" 2>/dev/null || true)" = 'enabled' ]; then
      beta_ok "$base 已是开机自启"
      continue
    fi
    systemctl --user enable "$base" >/dev/null 2>&1 \
      || beta_die "systemctl --user enable $base 失败 —— 没有它，H 一重启这一块就没了"
    beta_ok "$base 已设为开机自启"
  done
  beta_say '开机后由 systemd 起，靠的是 loginctl enable-linger <用户名>（要 root 跑一次）。'
  beta_say '没开 linger 的话，最后一个登录会话退出时这两个单元会跟着一起消失。'
  return 0
}

# 单元里那一行 PATH。**按本脚本自己解析到的那个 bun 派生**：systemd --user 的 PATH 极小，
# 而 bun 通常在 ~/.bun/bin —— 缺了它的症状是开机后单元 failed、日志里一句「bun 跑不起来」
# （issue #40 那条守卫抓的是同一个形状，只是那次发生在非交互 SSH 上）。
host_unit_path_env() {
  local bun_path bun_dir
  bun_path="$(command -v bun 2>/dev/null || true)"
  if [ -n "$bun_path" ]; then
    bun_dir="$(cd "$(dirname "$bun_path")" && pwd)"
  else
    # 这一趟没解析到 bun（起进程时会当场报错）。仍然给出最常见的那个位置，
    # 免得单元里留下一行连默认安装都够不着的 PATH。
    bun_dir="$HOME/.bun/bin"
  fi
  printf '%s:/usr/local/bin:/usr/bin:/bin' "$(beta_unit_path "$bun_dir")"
}

# 控制台单元的启动参数。**这一趟的尾参就是下一次开机的尾参**：`--wake-sign` 这类策略
# 开关走透传（issue #38），写死在单元里就是第二处真源。
#
# 撤销的方向要说出来：不带尾参跑一次 host 腿 = 把它们撤掉，而「签名唤醒被静默关掉」
# 恰恰是唯一一个让人以为还开着的方向。
write_console_env() {
  local dst gen args old
  dst="$BETA_OPS_DIR/console.env"
  gen="$BETA_OPS_DIR/.render-console-env.$$"
  beta_assert_inside_root "$dst"
  beta_assert_inside_root "$gen"

  args=''
  local one
  for one in ${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"}; do
    # 带空白的参数用一行 KEY=值 表达不出来（systemd 对 $VAR 做的是分词，不是 shell 解析）。
    # 与其写出一个悄悄被切开的参数，不如当场说清楚它没被持久化。
    case "$one" in
      *[[:space:]]*)
        beta_warn "尾参 ${one} 里有空白，无法写进 ${dst} 的一行 —— 单元不会带上它。
要让它活过重启，手改 $dst 的 CONSOLE_EXTRA_ARGS（那一行由本脚本重写，改完别再不带尾参跑 host 腿）。"
        continue
        ;;
    esac
    args="$args $one"
  done
  args="${args# }"

  old="$(beta_conf_get "$dst" CONSOLE_EXTRA_ARGS)"
  if [ -n "$old" ] && [ -z "$args" ]; then
    beta_warn "这一趟没给尾参，${BETA_CONSOLE_UNIT} 里原先带着的「${old}」会被撤掉。
要保留就重跑一次并带上：demo/env/beta/beta-up.sh --role host -- ${old}"
  fi

  {
    printf '# 阡陌内测 · 控制台单元的启动参数。由 demo/env/beta/beta-up.sh 写。\n'
    printf '#\n'
    printf '# **这一趟 beta-up.sh --role host 的尾参就是下一次开机的尾参。**手改这里会被\n'
    printf '# 下一次 host 腿覆盖；要长期带上某个开关，就带着它跑 host 腿。\n'
    printf '#\n'
    printf '# 单元里对它的引用不带花括号，因为 systemd 只对那种写法做分词（带花括号会把\n'
    printf '# 整串当成一个参数）。所以这里一个参数一个空格，且参数里不能有空白。\n'
    printf 'CONSOLE_EXTRA_ARGS=%s\n' "$args"
  } >"$gen"
  chmod 600 "$gen"
  beta_write_if_changed "$gen" "$dst" 600 '控制台单元的启动参数 console.env'
  rm -f "$gen"
}

# 链路那三个单元 + 拉取脚本，从仓库 ops/ 派生到 <root>/ops/，再装进 systemd --user。
# H 腿那两个（控制台与注册中心）走 provision_host_units，不在这里。
render_ops_files() {
  local src dst gen
  gen="$BETA_OPS_DIR/.render.$$"
  beta_assert_inside_root "$gen"
  for src in "$BETA_OPS_SRC_DIR/qianmo-tunnel@.service.in" \
    "$BETA_OPS_SRC_DIR/qianmo-mirror@.service.in" \
    "$BETA_OPS_SRC_DIR/qianmo-mirror@.timer.in"; do
    [ -f "$src" ] || beta_die "缺仓库模板 $src —— demo/env/beta/ops/ 是链路的真源"
    dst="$BETA_OPS_DIR/$(basename "$src" .in)"
    beta_assert_inside_root "$dst"
    # 占位符只有两个，且都是路径 / 数字，用 | 作分隔符不会撞上。
    sed -e "s|@OPS_DIR@|$(beta_unit_path "$BETA_OPS_DIR")|g" \
      -e "s|@MIRROR_INTERVAL_MIN@|$BETA_MIRROR_INTERVAL_MIN|g" \
      "$src" >"$gen"
    beta_write_if_changed "$gen" "$dst" 644 "单元模板 $(basename "$dst")"
  done
  rm -f "$gen"

  src="$BETA_OPS_SRC_DIR/mirror-pull.sh"
  [ -f "$src" ] || beta_die "缺仓库脚本 $src"
  dst="$BETA_OPS_DIR/mirror-pull.sh"
  beta_assert_inside_root "$dst"
  # 原样拷：它自己从 $0 推内测根，没有要替换的东西。
  beta_write_if_changed "$src" "$dst" 700 '镜像拉取脚本 mirror-pull.sh'

  # 装进 systemd --user。~/.config 不在内测根里，所以走另一套逐路径复核。
  local base unit_dst
  for base in 'qianmo-tunnel@.service' 'qianmo-mirror@.service' 'qianmo-mirror@.timer'; do
    unit_dst="$BETA_SYSTEMD_USER_DIR/$base"
    beta_assert_unit_file "$unit_dst"
    if [ -f "$unit_dst" ] && cmp -s "$BETA_OPS_DIR/$base" "$unit_dst"; then
      beta_ok "$base 已装且内容一致，不动"
      continue
    fi
    # 记下「文件变了但可能有实例在跑」——末尾要说出来，systemd 自己不会说。
    note_stale_instances "$base"
    cp "$BETA_OPS_DIR/$base" "$unit_dst"
    chmod 644 "$unit_dst"
    BETA_SYNC_CHANGED=$((BETA_SYNC_CHANGED + 1))
    beta_warn "$base 已装进 ${BETA_SYSTEMD_USER_DIR}（内容有更新）"
  done
}

# 单元文件被改写时，把此刻正在跑的实例记下来。**不重起它们**：那是运维窗口的动作。
note_stale_instances() {
  local base="$1" prefix suffix i node unit
  case "$base" in
    'qianmo-tunnel@.service') prefix='qianmo-tunnel'; suffix='.service' ;;
    'qianmo-mirror@.timer') prefix='qianmo-mirror'; suffix='.timer' ;;
    # mirror@.service 是 oneshot，由 timer 触发：它没有「正在跑的旧定义」这个问题，
    # 下一次触发就用新的了。
    *) return 0 ;;
  esac
  i=0
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    node="${BETA_SSH_NODE[$i]}"
    unit="$(beta_unit_instance "$prefix" "$node" "$suffix")"
    if [ "$(systemctl --user is-active "$unit" 2>/dev/null || true)" = 'active' ]; then
      BETA_UNITS_STALE="$BETA_UNITS_STALE $unit"
    fi
    i=$((i + 1))
  done
}

# 每节点一份 0600 的连通定义。**它是 peers.conf 那条坐标行的派生物**，手改会被覆盖：
# 两处各存一份「这个节点在哪」，迟早会分叉，而分叉的症状是隧道连 A、镜像拉 B。
write_tunnel_env() {
  local i="$1" node="${BETA_SSH_NODE[$1]}" dst gen
  dst="$BETA_OPS_DIR/tunnel-$node.env"
  gen="$BETA_OPS_DIR/.render-env.$$"
  beta_assert_inside_root "$dst"
  beta_assert_inside_root "$gen"
  {
    printf '# 阡陌内测 · 节点 %s 的连通定义（隧道与审计镜像共用这一份）。\n' "$node"
    printf '#\n'
    printf '# **由 demo/env/beta/beta-up.sh 从 peers.conf 的 node 坐标行派生，手改会被覆盖。**\n'
    printf '# 要改就改 %s。\n' "$BETA_PEERS_FILE"
    printf '#\n'
    printf '# 机器地址与 SSH 用户不进仓库（beta-env.md 文首）：本文件 0600，只在 H 上。\n'
    printf '# 私钥本身永不离开 H，这里只有路径。\n'
    printf 'NODE_SSH_USER=%s\n' "${BETA_SSH_USER[$i]}"
    printf 'NODE_SSH_HOST=%s\n' "${BETA_SSH_HOST[$i]}"
    printf 'NODE_SSH_PORT=%s\n' "${BETA_SSH_PORT[$i]}"
    printf 'NODE_SSH_KEY=%s\n' "${BETA_SSH_KEYFILE[$i]}"
    printf 'LOCAL_PORT=%s\n' "${BETA_SSH_LOCAL[$i]}"
    printf 'REMOTE_PORT=%s\n' "${BETA_SSH_REMOTE[$i]}"
    if [ -n "${BETA_SSH_TRAIL[$i]}" ]; then
      printf '# 审计镜像（单向、只读、节点 → H）。key 在节点侧带强制命令，只读得到这一个文件。\n'
      printf 'REMOTE_TRAIL=%s\n' "${BETA_SSH_TRAIL[$i]}"
    fi
    printf '# -L 之外的 ssh 参数（审计见证的反向转发，坐标行的 witness-port=）；空 = 没有。\n'
    # 值里有空格，**必须带引号**：这份文件有两个读者——systemd 的 EnvironmentFile（引号会被
    # 剥掉，单元里不带花括号的 $TUNNEL_EXTRA_ARGS 再按空白拆成两个参数），以及 mirror-pull.sh
    # 的 `. "$env_file"`。后者见到不带引号的 `TUNNEL_EXTRA_ARGS=-R 127.0.0.1:…` 会把第二个词
    # 当命令执行（exit 127），镜像拉取从此每次失败——2026-09-26 在 H 上撞到过。
    printf 'TUNNEL_EXTRA_ARGS="%s"\n' "$(beta_tunnel_extra_args "$i")"
  } >"$gen"
  chmod 600 "$gen"
  beta_write_if_changed "$gen" "$dst" 600 "连通定义 tunnel-$node.env"
  rm -f "$gen"
}

# enable + start，且**只在状态不对时才动**。已经 active 的一律不重起。
ensure_unit() {
  local unit="$1" what="$2" enabled active
  enabled="$(systemctl --user is-enabled "$unit" 2>/dev/null || true)"
  active="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
  if [ "$enabled" != 'enabled' ]; then
    systemctl --user enable "$unit" >/dev/null 2>&1 \
      || beta_die "${what}：systemctl --user enable $unit 失败"
    beta_ok "$what 已设为开机自启（${unit}）"
  fi
  if [ "$active" = 'active' ]; then
    beta_ok "$what 已在运行，不重起（${unit}）"
    return 0
  fi
  systemctl --user start "$unit" \
    || beta_die "${what}：systemctl --user start $unit 失败（journalctl --user -u $unit 看原因）"
  beta_ok "$what 已启动（${unit}）"
}

# 隧道就绪。**判据是真读一次对端应答，不是 TCP 连得上。**
#
# `ssh -L` 的本地口由 ssh 客户端自己 LISTEN：节点侧没人监听时它照样 accept 然后立刻关，
# 所以 beta_tcp_open 在这里恒为真（common.sh 里那个函数会直接 die，就是为了挡住这个）。
wait_tunnel_live() {
  local node="$1" port="$2" i=0
  while [ "$i" -lt "$READY_TIMEOUT_S" ]; do
    if beta_endpoint_live 127.0.0.1 "$port"; then
      beta_ok "隧道 $node 通到底：127.0.0.1:$port 上收到了节点的应答"
      return 0
    fi
    sleep 2
    i=$((i + 2))
  done
  beta_die "隧道 $node 在 ${READY_TIMEOUT_S}s 内没有让 127.0.0.1:$port 回出任何应答。
注意 TCP 层可能是「通」的 —— ssh 自己在这个口上 LISTEN，节点侧死掉时它 accept 完立刻关，
于是任何 TCP 探测都是绿的。分诊顺序：
  systemctl --user status $(beta_unit_instance 'qianmo-tunnel' "$node" '.service')
  journalctl --user -u $(beta_unit_instance 'qianmo-tunnel' "$node" '.service') -n 50
  出现 administratively prohibited = 节点 authorized_keys 的 permitopen 与 remote-port 对不上；
  出现 open failed: connect failed = 隧道没问题，是节点上的常驻没在跑。"
}

# ─────────────────────────────────────────────────────────────────────────────
# 注册中心落盘表 / 活表与 peers.conf 的一致性（改端点之前必须先挪开旧表）
#
# 病根见 common.sh「注册中心落盘表与 peers.conf 的一致性」那一节：p81-registry.ts 的
# announce() 在 heartbeat 成功时整条跳过 --register，于是**改了 peers.conf 也不生效**。
# 这件事以前只能靠人记得，现在由脚本自己查、自己挪开。
# ─────────────────────────────────────────────────────────────────────────────
assert_registry_matches_peers() {
  local state="$BETA_REGISTRY_STATE"
  local disk_bad=0 live_bad=0 i addr want got backup

  if [ -f "$state" ]; then
    local pairs saddr sep
    pairs="$BETA_RUN_DIR/registry-state-pairs.$$"
    beta_state_pairs "$state" >"$pairs"
    while read -r saddr sep || [ -n "$saddr" ]; do
      [ -n "$saddr" ] || continue
      want="$(beta_peer_addr_endpoint "$saddr")" || continue
      if [ "$want" != "$sep" ]; then
        beta_warn "落盘表里 $saddr → ${sep}，而 peers.conf 说是 $want"
        disk_bad=1
      fi
    done <"$pairs"
    rm -f "$pairs"
  fi

  if beta_running "$BETA_REGISTRY_PROC"; then
    local want_key got_key
    i=0
    while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
      addr="${BETA_PEER_ADDR[$i]}"
      got="$(beta_live_endpoint "$addr")"
      if [ -n "$got" ] && [ "$got" != "${BETA_PEER_EP[$i]}" ]; then
        beta_warn "在跑的注册中心把 $addr 解析成 ${got}，而 peers.conf 说是 ${BETA_PEER_EP[$i]}"
        live_bad=1
      fi
      # 公钥同一个道理：在跑的那一份是用**当初**那张命令行起的（可能根本没带公钥），
      # 幂等起停不会重起它，于是这一趟算出来的公钥永远进不了名册。只在这一趟确实有
      # 公钥要发布时才比——没有来源的节点照旧不带，不因此重起。
      want_key="${BETA_PEER_KEY[$i]:-}"
      if [ -n "$got" ] && [ -n "$want_key" ]; then
        got_key="$(beta_live_public_key "$addr")"
        if [ "$got_key" != "$want_key" ]; then
          beta_warn "在跑的注册中心里 $addr 的公钥是 ${got_key:-（没有）}，而这一趟要发布的是 ${want_key}"
          live_bad=1
        fi
      fi
      i=$((i + 1))
    done
  fi

  if [ "$disk_bad" = '0' ] && [ "$live_bad" = '0' ]; then
    beta_ok '注册表与 peers.conf 一致（落盘表与活表都查过）'
    return 0
  fi

  if [ "$disk_bad" = '1' ]; then
    backup="$state.stale-$(beta_stamp)"
    beta_assert_inside_root "$state"
    beta_assert_inside_root "$backup"
    mv "$state" "$backup"
    beta_warn "落盘的注册表与 peers.conf 不一致，**已挪开**（未删除）：
  $state
→ $backup
为什么必须挪：注册中心重启时会从落盘表 restore，租约 90 s 内的条目带着旧端点原样回来，
于是 announce() 里那句 \`if (registry.heartbeat(address) !== null) continue\` 把整条
--register 跳过 —— 改了 peers.conf 也不生效，症状是「smoke 全红而 peers.conf 明明是对的」。"
  fi

  if [ "$live_bad" = '1' ]; then
    beta_warn '在跑的注册中心，它的表在**内存**里 —— 挪开落盘表管不着它，必须重起才能换上新端点 / 公钥。'
    beta_stop_one "$BETA_REGISTRY_PROC"
    rm -f "$BETA_RUN_DIR/registry-ready.json"
    beta_warn '已停止注册中心，下面会用 peers.conf 的端点重新起一份。
**这是本脚本唯一一个会被重起的组件，且只在真的检出不一致时发生。**'
  fi
  return 0
}

# beta_peer_addr_endpoint <地址> —— peers.conf 说这个地址的端点是什么；表里没有就返回 1。
beta_peer_addr_endpoint() {
  local want="$1" i=0
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    if [ "${BETA_PEER_ADDR[$i]}" = "$want" ]; then
      printf '%s' "${BETA_PEER_EP[$i]}"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

# ── 节点腿的尾参记录（issue #111）───────────────────────────────────────────
#
# 控制台那半边靠 `ops/console.env` + systemd 单元记住自己的尾参，节点这半边一直没有
# 对应物：拓扑类参数由本脚本按 `--role`/`--node` 推导，所以每次都对；而 `--` 之后的
# 东西**只存在于当初那一次命令行里**。于是「停机 → 换产物 → 起机」这个最常做的动作
# 会静默改变节点的策略面 —— 2026-08-26 在 cornna-p3 上，beta-2 起来之后 argv 少了一个
# `--trust <节点>=<公钥>`，其余一字不差。
#
# **丢掉的不是显示项，是策略。**掉了 `--trust` 之后节点照常启动、照常在名册上在线、
# 拨号照常 426 —— 所有存活判据全绿，只有真去发一个签名唤醒任务时才会失败。同一条透传
# 约定上还挂着 `--require-signed-tasks` / `--trust-ca` / `--cert` / `--chat-url`，每一个
# 丢了都是同一种「看着正常、实际降级」。
#
# 所以节点腿的默认方向与控制台腿**相反**，这是有意的：
#
#   · 控制台：这一趟的尾参就是下一次开机的尾参；不给 = 撤掉（WARN 一句）。
#     它撑得住这个默认，因为开机是 systemd 读 console.env，人不会为一次重启重跑本脚本。
#   · 节点：不给 `--` = **沿用上一次记下的那一份**，并把沿用了什么打出来；
#     给了 `--` = 以这一趟为准并重写记录；给一个**空的** `--` = 明确清空。
#     人每次换产物都要重跑本脚本，「不给就撤掉」在这里等于把 issue #111 变成默认行为。
#
# 记录一行一个参数，不是 `KEY=值` 一整行 —— 那是 console.env 为了迁就 systemd 的分词
# 才有的形状（也是它对含空白的尾参只能 WARN 的原因）。这份记录的读写两边都是本脚本，
# 没有理由继承那个限制。
beta_node_passthrough_file() {
  printf '%s/%s.passthrough' "${BETA_STATE_DIR}" "${BETA_NODE}"
}

# 这一趟节点腿真正要用的尾参，写进 PASS_THROUGH，并把记录更新到与它一致。
resolve_node_passthrough() {
  local dst gen one
  dst="$(beta_node_passthrough_file)"
  beta_assert_inside_root "${dst}"

  if [ "${PASS_THROUGH_GIVEN}" = '0' ]; then
    if [ ! -f "${dst}" ]; then return 0; fi
    # `read -r` 不吃反斜杠，`IFS=` 不吃前后空白：一行原样就是一个参数。
    # `#` 开头的是文件头注释 —— 代价写在 `resolve_node_passthrough` 的写入侧：
    # 一个以 `#` 开头的尾参存不进来，那里会当场 WARN 而不是悄悄写坏这份记录。
    while IFS= read -r one; do
      [ -n "${one}" ] || continue
      case "${one}" in '#'*) continue ;; esac
      PASS_THROUGH+=("${one}")
    done <"${dst}"
    if [ "${#PASS_THROUGH[@]}" -gt 0 ]; then
      beta_ok "沿用上一次记下的尾参（${dst}）：
  ${PASS_THROUGH[*]}
要换成别的就带 \`-- <参数>\` 重跑；要清空就带一个空的 \`--\`。"
    fi
    return 0
  fi

  if [ "${#PASS_THROUGH[@]}" -eq 0 ]; then
    if [ -s "${dst}" ]; then
      beta_warn "给了一个空的 \`--\`，${BETA_NODE} 记下的尾参会被清空：
  $(tr '\n' ' ' <"${dst}")"
    fi
    rm -f "${dst}"
    return 0
  fi

  gen="${BETA_STATE_DIR}/.render-passthrough.$$"
  beta_assert_inside_root "${gen}"
  {
    printf '# 阡陌内测 · 节点 %s 上一次的尾参，一行一个。由 demo/env/beta/beta-up.sh 写。\n' "${BETA_NODE}"
    printf '#\n'
    printf '# 不给 `--` 跑节点腿时，本脚本从这里读回来 —— 换产物不该顺手改掉策略面。\n'
    printf '# 手改这里会被下一次带 `--` 的节点腿覆盖；要清空就带一个空的 `--` 跑一次。\n'
    for one in "${PASS_THROUGH[@]}"; do
      # 文件头是 `#` 开头的注释行，所以一个以 `#` 开头的尾参在这份记录里表达不了。
      # 与 console.env 对含空白尾参的处置同一条纪律：与其写出一个下次会被读丢的
      # 参数，不如当场说清楚它没被记下来。真实的 CLI 参数不长这样，但静默是不行的。
      case "${one}" in
        '#'*)
          beta_warn "尾参 ${one} 以 # 开头，写不进 ${dst}（那是注释行的形状）—— 这一趟的进程带着它，但活不过下一次不带 \`--\` 的重起。"
          continue
          ;;
      esac
      printf '%s\n' "${one}"
    done
  } >"${gen}"
  chmod 600 "${gen}"
  beta_write_if_changed "${gen}" "${dst}" 600 "节点 ${BETA_NODE} 的尾参记录"
  rm -f "${gen}"
}

# ─────────────────────────────────────────────────────────────────────────────
# node 腿：该机那一个常驻节点
# ─────────────────────────────────────────────────────────────────────────────
run_node() {
  if [ "$NODE_GIVEN" = '0' ]; then
    # 四台机器上都用默认值 = 四个同名节点，而症状是注册表里互相覆盖、审计链张冠李戴。
    # 不硬拦（本机自验时默认值很方便），但要说一声。
    beta_warn "没给 --node，用默认节点名 $BETA_NODE —— 四台机器上必须各不相同"
  fi
  # PSK 由 H 生成后分发（§8.3）。**本机不生成**，理由见 common.sh 文件头第②条。
  beta_load_psk "$BETA_PSK_FILE" "本机节点的传输层 PSK"
  # 尾参在这里定下来，早于任何一处用到 PASS_THROUGH 的地方（issue #111）。
  resolve_node_passthrough
  # 从记录里读回来的那一份**再过一次那道门**：命令行给的那一份在解析期已经过了，
  # 而这一份是刚刚才进来的。
  assert_no_token_values_in_passthrough

  local config_dir="$BETA_NODES_DIR/$BETA_NODE/config"
  local ws_root="$BETA_WORKSPACE_DIR/$BETA_NODE"

  beta_head "① 工作区（节点 ${BETA_NODE}）"
  local agent
  for agent in $BETA_AGENTS; do
    seed_workspace "$ws_root/$agent" "$BETA_NODE/$agent"
  done

  beta_head "② 常驻节点 $BETA_NODE"
  # 模型凭据必须在**起 resident 之前**进环境：ACP 子进程继承的是 resident 起来那一刻
  # 的环境（`defaultSpawnAcp` 传 `{...process.env}`），事后在别的 shell 里 export 到不了
  # 它。这一步缺失就是 issue #13——链路整条走通、回执 accepted、审计链新增，而 agent
  # 那一轮是 `Not logged in · Please run /login`。
  local model_env_running=0
  if beta_running "$BETA_NODE"; then model_env_running=1; fi
  beta_load_model_env
  if [ "$BETA_MODEL_ENV_STATUS" = 'loaded' ]; then
    beta_ok "模型凭据$(beta_model_env_line)"
    if [ "$model_env_running" = '1' ]; then
      beta_warn "$BETA_NODE 在本次执行之前就已经在跑 —— 本脚本是幂等的，不会重起它，
所以**刚注入的这份模型凭据没有进到那个进程里**。环境变量只在进程起来的那一刻传递一次。
要让它生效：demo/env/beta/beta-down.sh $BETA_NODE 之后再跑本脚本。"
    fi
  else
    beta_warn "模型凭据$(beta_model_env_line) —— 本节点被唤醒后，agent 那一轮会以
\`Not logged in · Please run /login\`（authentication_failed，usage 全 0）收场，而投递、
回执与审计链**全部照常成功**（issue #13 就是这个形状）。链路自检不需要凭据，要跑真轮次
就放一份 0600 的 KEY=VALUE 文件到上面那个路径再重起本节点。"
  fi

  local args
  # P12.4 的真实内测舰队仍处在 §9.2 阶段 ①：这两个参数成对出现，不是永久遗留。
  # 代码默认已经是 SIGNED_TASK_POLICY，但 S-1~S-4 证据与「连续 7 天若强制会被拒的
  # 消息计数为 0」的观察窗口满足前，舰队保持 §9.3 的 --open-policy 逃生策略，并用
  # --audit-signed-tasks 审计每一条若强制会被拒的消息。
  #
  # **两个开关都不许省成默认值**（issue #10）：2026-08-23 实查发现线上四台的
  # `/proc/<pid>/cmdline` 里一个都没有——它们是更早一版脚本起的，跑在阶段① 靠的是
  # 「产物早于 P12.4 翻默认」而不是配置。省掉这两行等于让安全姿态由构建日期决定，
  # 而后果（trusts:[] + 强制策略 = 每条 task.request/wake 被拒）要到第一次真用时
  # 才出现。**滚新产物之前，先确认在跑的进程是本脚本这一版起的。**
  # `demo/env/resident-task-policy.test.ts` 钉住这两行不会被悄悄删掉。
  args=(
    bun "$BETA_OCC" resident
    --node "$BETA_NODE"
    --team "$BETA_TEAM"
    --port "$BETA_NODE_PORT"
    --hostname "$BETA_NODE_BIND"
    --open-policy
    --audit-signed-tasks
    # 没有它，agent 连自己的工作区都写不了：无人值守那一轮跑在 dontAsk 下（不提示、
    # 未预批准即拒绝），而常驻对每一次授权请求都答 cancelled。2026-08-28 在 p11 上
    # 的形状是模型回「当前权限模式拒绝文件写入」，而工作区目录可写、节点 .err 里
    # 一条文件系统错误都没有——查权限位查不出任何东西。
    #
    # **写进这里而不是留给命令行**，与上面那两个任务策略开关同一条理由（issue #10）：
    # 省掉它，这台节点能不能干活就由「跑的是哪一版产物」决定。
    --allow-workspace-edits
    --timings "$BETA_STATE_DIR/$BETA_NODE-timings.jsonl"
  )
  for agent in $BETA_AGENTS; do
    args+=(--agent "$agent=$ws_root/$agent")
  done
  # 备份面要 URL 与写 token 同时在。写 token 走环境变量、不走命令行——命令行上的
  # 凭据就是这台机器每一份进程列表里的凭据（resident 自己也是这么要求的）。
  if [ -n "$BETA_BACKUP_URL" ]; then
    if [ -n "${QIANMO_BACKUP_WRITE_TOKEN:-}" ]; then
      case "$BETA_BACKUP_URL" in
        https://*) ;;
        # 写 token 在 Authorization: Bearer 头里，明文 HTTP 等于每小时把它广播一次（§2.7）。
        *) beta_die "QIANMO_BETA_BACKUP_URL 必须是 https:// —— 收到 $BETA_BACKUP_URL" ;;
      esac
      args+=(--backup-url "$BETA_BACKUP_URL" --backup-interval-ms "$BETA_BACKUP_INTERVAL_MS")
      beta_ok "备份面已开：${BETA_BACKUP_URL}（间隔 ${BETA_BACKUP_INTERVAL_MS} ms）"
    else
      beta_die "给了 QIANMO_BETA_BACKUP_URL 却没有写 token —— 放一份到 ${BETA_BACKUP_WRITE_FILE}（0600）。
**归档 token 永不下发到节点机**（§2.7）：那等于让任何一台被拿下的 VPS 读走全部快照。"
    fi
  else
    beta_say '提示 : 未设 QIANMO_BETA_BACKUP_URL，本节点不写备份快照（H 上的备份服务也还没有入口，见 README）'
  fi

  # 尾参透传（见文件头）。追加在最后：`--trust <节点>=<公钥>` 就是从这里进来的。
  args+=(${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"})
  # 审计见证：尾参里有 --witness-url 才读写 token（见 common.sh 的 beta_prepare_witness）。
  beta_prepare_witness
  # 紧挨着起进程：resident 与它的 ACP 子进程从本 shell 继承 oom_score_adj。
  beta_raise_oom_score
  # 起之前先问端口空不空（2026-09-26 p1）：pid 文件说本节点没在跑、端口上却已经有人在听，
  # 新进程起来只会 EADDRINUSE 退出——而它退出之前那一两秒，下面的就绪探测会被旧进程的应答
  # 骗成绿，退出的新进程还往配置根的 lifecycle.json 里留一条误导的 priorLife。不起它。
  if ! beta_running "$BETA_NODE"; then
    local occupants _occupant
    occupants="$(beta_port_occupants "$BETA_NODE_PORT")"
    if [ -n "$occupants" ]; then
      beta_say "端口 ${BETA_NODE_PORT} 已经有人在听，而 run/${BETA_NODE}.pid 说 ${BETA_NODE} 没在跑："
      while read -r _occupant; do beta_describe_pid "$_occupant"; done <<<"$occupants"
      beta_die "端口 ${BETA_NODE_PORT} 被占着，不起 ${BETA_NODE}：新进程只会 EADDRINUSE 退出，而就绪探测会把旧进程的应答当成它的。
先 demo/env/beta/beta-down.sh ${BETA_NODE} —— pid 文件对不上时它按命令行把本节点的旧进程认出来停掉；
认不出的它只报不杀，那就要人核对上面的命令行再处置。"
    fi
  fi
  beta_start_process "$BETA_NODE" "$config_dir" "${args[@]}"

  beta_head '③ 就绪探测'
  # 就绪的定义不是「端口上有人应答」，而是「**刚起的那个 pid** 在这个端口上应答」。
  # 2026-09-26 p1：新进程 EADDRINUSE 退出，同一端口上的旧进程照样应答，旧判据打出
  # 「OK : beta-1 在 127.0.0.1:38625 上监听」——唯一的线索是末尾「节点身份」那一行是空的。
  # 所以三件事都要成立：
  #   ① 那个 pid 还活着（死了当场失败，摊开它的 stderr —— 上面那种现场里写着 EADDRINUSE）；
  #   ② 它的启动行（logs/<节点>.out 首行，beta_start_process 刚截断过）说的是这个节点、带公钥；
  #   ③ 端口有应答，且本机查得到的监听者里有这个 pid（ss / lsof / /proc）。查不到监听者时
  #      退回「①②成立 + 端口有应答」，并明说没核对 —— 起之前已确认端口空着，那一格才站得住。
  # 它仍然**证不了 PSK 对不对**：握手只有从 H 拨过来才算数（beta-smoke.sh 的 host 腿）。
  # 这正是 §9.1 那条——本机一切正常、名册上也在线，而 H 拨过来是超时。
  local probe_host="$BETA_NODE_BIND"
  if [ "$probe_host" = '0.0.0.0' ]; then probe_host='127.0.0.1'; fi
  local node_pid node_key='' holders='' foreign='' unverified=0 i=0 listening=0 held _holder
  node_pid="$(cat "$(beta_pidfile "$BETA_NODE")")"
  while [ "$i" -lt "$READY_TIMEOUT_S" ]; do
    if ! beta_running "$BETA_NODE"; then
      if [ -n "$foreign" ]; then
        beta_say "端口 ${BETA_NODE_PORT} 上应答的不是 ${BETA_NODE}（pid ${node_pid}），而是："
        while read -r _holder; do beta_describe_pid "$_holder"; done <<<"$foreign"
      fi
      beta_dump_if_dead "$BETA_NODE"
    fi
    node_key="$(beta_node_banner_key "$BETA_NODE" || true)"
    if [ -n "$node_key" ] && beta_tcp_open "$probe_host" "$BETA_NODE_PORT"; then
      held=0
      holders="$(beta_port_holders "$BETA_NODE_PORT")" || held=1
      if [ "$held" = '1' ]; then
        unverified=1
        listening=1
        break
      fi
      case "
${holders}
" in
        *"
${node_pid}
"*)
          listening=1
          break
          ;;
      esac
      foreign="$holders"
    fi
    sleep 2
    i=$((i + 2))
  done
  if [ "$listening" != '1' ]; then
    if [ -n "$foreign" ]; then
      beta_say "端口 ${BETA_NODE_PORT} 上应答的不是 ${BETA_NODE}（pid ${node_pid}），而是："
      while read -r _holder; do beta_describe_pid "$_holder"; done <<<"$foreign"
      beta_die "${BETA_NODE}（pid ${node_pid}）在 ${READY_TIMEOUT_S}s 内没有成为 ${probe_host}:${BETA_NODE_PORT} 的监听者 —— 应答来自上面那个进程，不是它（见 $(beta_logfile "$BETA_NODE" err)）"
    fi
    if [ -z "$node_key" ]; then
      beta_die "${BETA_NODE}（pid ${node_pid}）在 ${READY_TIMEOUT_S}s 内没有打出启动行（$(beta_logfile "$BETA_NODE" out) 首行应是带 \"node\":\"${BETA_NODE}\" 与 publicKey 的 JSON；见 $(beta_logfile "$BETA_NODE" err)）"
    fi
    beta_die "$BETA_NODE 在 ${READY_TIMEOUT_S}s 内没有在 ${probe_host}:${BETA_NODE_PORT} 上监听（见 $(beta_logfile "$BETA_NODE" err)）"
  fi
  if [ "$unverified" = '1' ]; then
    beta_warn "本机没有 ss / lsof / /proc 可查 ${BETA_NODE_PORT} 的监听者，没核对应答是不是 pid ${node_pid} 发出的；
只核对了：它活着、启动行是 ${BETA_NODE}、端口有应答（这一趟新起进程时，起之前已确认端口空着）。"
  fi
  beta_ok "$BETA_NODE 在 ${probe_host}:${BETA_NODE_PORT} 上监听（pid ${node_pid}，公钥 ${node_key}）"

  beta_head "节点腿就绪，耗时 $(beta_elapsed "$STARTED_AT")"
  beta_say "节点     : ${BETA_NODE}（agent：${BETA_AGENTS}）"
  beta_say "模型凭据 : $(beta_model_env_line)"
  beta_say "           ↑ 这一行只说**文件**注进来没有。够不够用由节点自己说：无凭据时"
  beta_say "             resident 会在 $(beta_logfile "$BETA_NODE" err) 写一条 [resident] 告警。"
  beta_say "配置根   : $config_dir"
  beta_say "审计链   : $(beta_node_trail "$BETA_NODE")   ← **权威副本，H 上那份是只读镜像**"
  beta_say "入站端点 : ws://<本机对外地址>:$BETA_NODE_PORT   ← 把它填进 H 的 peers.conf"
  beta_say "节点身份 : $(head -1 "$(beta_logfile "$BETA_NODE" out)" 2>/dev/null || true)"
  beta_say "公钥     : ${node_key}"
  beta_say "           ↑ 在 H 的 peers.conf 里写成该节点 node 坐标行的 public-key=${node_key}"
  beta_say "             注册中心据此把它发布进名册；控制台带 --anchors 时只从名册取节点公钥。"
  beta_say "             跑在 H 自己身上的节点不用写，H 腿直接读本机身份文件。"
  beta_say ''
  beta_say '下一步   : demo/env/beta/beta-smoke.sh --role node（本机自检）'
  beta_say '           在 H 上把上面那条入站端点填进 peers.conf，再跑 H 腿的 beta-smoke.sh'
}

# 每个 agent 一个真 git 工作区（§4.1 的 workspaces/<node>/<agent>/）。
# 幂等：已存在的不重建——重建等于把那个 agent 的工作成果扔掉。
seed_workspace() {
  local dir="$1" what="$2"
  if [ -d "$dir/.git" ]; then
    beta_ok "$what 工作区已存在：$dir"
    return 0
  fi
  mkdir -p "$dir"
  git -C "$dir" init -q
  {
    printf '# %s\n\n' "$what"
    printf '阡陌内测环境的 agent 工作区，由 demo/env/beta/beta-up.sh 生成。\n'
    printf '常驻节点以它为该 agent 的 cwd。\n'
  } >"$dir/NOTES.md"
  git -C "$dir" add NOTES.md
  # 提交身份走 -c，不依赖跑这条命令的人配过 git 全局身份（全新 VPS 上常常没配）。
  git -C "$dir" -c user.name='Qianmo Beta' -c user.email='beta@example.invalid' \
    commit -q -m 'chore(beta): 内测工作区初始提交'
  beta_ok "$what 工作区已建：$dir"
}

case "$ROLE" in
  host) run_host ;;
  node) run_node ;;
esac
