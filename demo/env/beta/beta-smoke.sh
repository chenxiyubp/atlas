#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P11.1 落地包① —— 内测环境自检：拓扑真的能用吗。
#
#   demo/env/beta/beta-smoke.sh --role host   # H 上跑（默认）：四条判据全在这里
#   demo/env/beta/beta-smoke.sh --role node   # 节点机上跑：只证本机那一半
#
# ── H 腿的四条判据，逐条对应 beta-env.md §10 包① 的 DoD ① ────────────────────
# （另有一节 ⓪ 链路，只在 peers.conf 里有 node 坐标行时才有内容——它不属于 DoD①，
#   是隧道形态引进来的新失败面：隧道断了，上面四条会以「拨不通」的形式一起红，
#   而那时候人会去查节点，其实节点好好的。⓪ 先答「H 到节点这一段通不通」。）
#   ① 注册中心 /v0/health 200；
#   ② 地址表里每一条**按名解析 + 真拨通**（解析只查表会把「表里有一条陈旧记录」
#      当成拓扑就绪，所以必须真握手一次）；
#      随后发一条不带 capability 的 `task.request` 并等 ack：这是 §9.2 阶段 ① 的
#      观察样本，`--audit-signed-tasks` 据此记下强制策略会拒的数量；
#   ③ 控制台 /v0/health 200；
#   ④ 每个节点的审计链各自 `intact`。
#
# ── ① 与 ③ 是控制台/注册中心**唯一**的存活判据（issue #64）─────────────────
# `systemctl --user is-active qianmo-console.service` 在两个方向上都会骗人：它常年
# 报 inactive 而进程活着（beta-up.sh 只 enable 不 start），也会在进程死后继续报
# active（`Type=oneshot` + `RemainAfterExit=yes`）。所以这两个单元的状态不进判据，
# 只在①/③ 旁边由 host_unit_note 解释一句「为什么你查到的那个状态是错的」。
# **⓪ 里那两条单元判据不在此列，照旧成立**：隧道单元是 `Type=exec`（systemd 直接管着
# 那个 ssh 进程），镜像那条查的是 `.timer`（定时器的 active 说的就是「它还在计时」）。
# 会骗人的是 `Type=oneshot` + `RemainAfterExit=yes` 那种，H 腿这两个正是。
#
# ── 为什么是「一个地址跑一次 probe」而不是一次 probe 带四个 --expect ──────────
# 两个理由，第二个是硬的：
#   · 拨不通时要说出**哪一个**拨不通。一次跑四条只有一个退出码，那句「四条里有一条
#     不通」会让人从头查四台机器。
#   · **PSK 是每节点一把**（§8.2），而 `QIANMO_TRANSPORT_PSK` 是每进程一把、没有
#     per-peer 的表。所以一次 probe 进程**在结构上**只能跟共用同一把 PSK 的对端握手；
#     带四个 --expect 跑一次，必然有三条报握手失败——那不是拓扑坏了，是探测方式错了。
#     每个地址一个进程、各带各的 PSK（从 H 的 secrets/peers/<node>.psk 取），才是对的。
#
# ── 节点腿证不了什么（如实写）────────────────────────────────────────────────
# 节点机上没有注册中心（它永不出 H 的回环，§9.2），所以「按名解析」在节点机上问不了；
# 本机对自己的端口拨号也只证明「在监听」，**证不了 PSK 对不对**——握手只有从 H 拨过来
# 才算数。这正是 §9.1 那条最会骗人的形状：本机一切正常、名册上也在线，而 H 拨过来超时。
#
# 退出码即结论。§9.1 的一期处置是让 H 上的定时任务每 5 min 跑一次 `--role host`，
# 任一失败就把控制台 --label 改成「<node> 疑似不可达 · 排查中」。

set -euo pipefail

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ROLE='host'
NODE_GIVEN=0
# 「链文件还不存在」与「链验不过」是两回事，默认都算 FAIL（DoD① 的原话是「四条审计链
# 各自 intact」，零条链不满足它）。但一个**刚起、还没有任何流量**的环境本来就一条链都
# 没有——审计链是第一条记录到达时才创建的。所以给一个显式开关，让那种场景可以只 WARN。
# §9.1 那个每 5 min 的巡检问的是「拨不拨得通」，用它跑就该带上这个参数，否则会因为一个
# 当天没被用过的节点把控制台 label 改成「疑似不可达」——那是一次假警报。
ALLOW_MISSING_TRAILS=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --role)   ROLE="${2:-}"; shift 2 ;;
    --role=*) ROLE="${1#--role=}"; shift ;;
    --node)   BETA_NODE="${2:-}"; NODE_GIVEN=1; shift 2 ;;
    --node=*) BETA_NODE="${1#--node=}"; NODE_GIVEN=1; shift ;;
    # --port 只对 --role node 有意义（本机那个节点在哪个端口上）。与 beta-up.sh 的
    # 同名参数对齐：两个脚本对同一台机器要问同一个问题，参数名不一致会让人写错。
    --port)   BETA_NODE_PORT="${2:-}"; shift 2 ;;
    --port=*) BETA_NODE_PORT="${1#--port=}"; shift ;;
    --allow-missing-trails) ALLOW_MISSING_TRAILS=1; shift ;;
    -h|--help)
      beta_say '用法：beta-smoke.sh [--role host|node] [--node <名字>] [--port <端口>] [--allow-missing-trails]'
      exit 0
      ;;
    *) beta_die "未知参数 $1" ;;
  esac
done
case "$ROLE" in
  host|node) ;;
  *) beta_die "--role 只能是 host 或 node，收到 $ROLE" ;;
esac

STARTED_AT="$(beta_now)"
beta_require_marker
beta_require_occ
beta_export_common
cd "$REPO_DIR"

FAIL=0
FAILED_ITEMS=''
TRAIL_INTACT=0
TRAIL_MISSING=0
fail_item() {
  FAIL=1
  FAILED_ITEMS="$FAILED_ITEMS
  · $1"
  beta_say "FAIL : $1"
}

# 探测方向：H 自己在网络上不是一个注册进注册中心的节点，这两个值只是握手时的自称，
# 与控制台 --chat-from 的默认值对齐（qianmo://console/operator）。
SMOKE_FROM_NODE="${QIANMO_BETA_SMOKE_FROM_NODE:-console}"
SMOKE_FROM_AGENT="${QIANMO_BETA_SMOKE_FROM_AGENT:-operator}"

# verify_trail <节点名> <路径> <权威|镜像>
# 一个配置根一条链。两个节点共用配置根会让这一步必然报断链——那是拓扑搭错，
# 不是有人改了审计文件（理由见 common.sh 头注）。
verify_trail() {
  local node="$1" path="$2" kind="$3"
  beta_say "--- ${node}（${kind}：${path}）---"
  if bun "$BETA_OCC" audit --path "$path" --verify; then
    beta_ok "$node 审计链 intact"
    TRAIL_INTACT=$((TRAIL_INTACT + 1))
  else
    fail_item "$node 审计链有问题（${kind}：${path}）"
  fi
}

# 链文件不存在时说什么。见文件头顶上 ALLOW_MISSING_TRAILS 那段注释。
trail_missing() {
  local node="$1" where="$2"
  TRAIL_MISSING=$((TRAIL_MISSING + 1))
  if [ "$ALLOW_MISSING_TRAILS" = '1' ]; then
    beta_warn "$node 还没有审计链（${where}）—— 它在第一条审计记录到达时才创建；按 --allow-missing-trails 不判 FAIL"
  else
    fail_item "$node 在 H 上既没有权威链也没有镜像链（找过 ${where}）"
  fi
}

# 一个节点的链在哪：权威副本永远是节点本机那一份；H 上只有镜像时就验镜像，
# 但要在输出里说清楚——一条延迟 5 分钟的链和一条实时链看起来一模一样（§4.3）。
verify_node_trail_on_host() {
  local node="$1" authoritative mirror
  authoritative="$(beta_node_trail "$node")"
  mirror="$(beta_mirror_trail "$node")"
  if [ -f "$authoritative" ]; then
    verify_trail "$node" "$authoritative" '权威'
  elif [ -f "$mirror" ]; then
    verify_trail "$node" "$mirror" '镜像 · 滞后未知'
  else
    trail_missing "$node" "$authoritative 与 $mirror"
  fi
}

# ⓪ 链路：H 到节点这一段。只对有 node 坐标行的节点有内容。
#
# 两条判据，缺一不可：
#   · 隧道单元 active —— 只证明 ssh 进程活着；
#   · **对端真的回了字节**（beta_endpoint_live）—— 这一条才证明另一头是节点。
#
# 为什么不能只看第一条，也不能用 TCP 探测代替第二条：`ssh -L` 的本地口由 ssh 自己
# LISTEN，节点侧那个端口没人监听时它照样 accept 然后立刻关。于是单元 active、TCP
# 连得上、而拨号全超时 —— 三个绿灯一个真相。common.sh 的 beta_tcp_open 对隧道口直接
# die，就是为了不让这条假绿再被写出来。
check_links() {
  if [ "$BETA_SSH_COUNT" -eq 0 ]; then
    return 0
  fi
  beta_head "⓪ 链路（$BETA_SSH_COUNT 条 SSH 隧道）"
  if ! command -v systemctl >/dev/null 2>&1; then
    fail_item "peers.conf 里有 node 坐标行，但这台机器上没有 systemctl —— 隧道不可能在跑"
    return 0
  fi
  local i=0 node port unit state trail
  while [ "$i" -lt "$BETA_SSH_COUNT" ]; do
    node="${BETA_SSH_NODE[$i]}"
    port="${BETA_SSH_LOCAL[$i]}"
    unit="$(beta_unit_instance 'qianmo-tunnel' "$node" '.service')"
    state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
    if [ "$state" != 'active' ]; then
      fail_item "$node 的隧道单元不是 active（$unit 现在是 ${state:-未知}）"
    elif beta_endpoint_live 127.0.0.1 "$port"; then
      beta_ok "$node 隧道通到底（127.0.0.1:$port 回出了节点的应答）"
    else
      fail_item "$node 的隧道单元 active，但 127.0.0.1:$port 回不出任何应答 ——
  ssh 进程活着、TCP 也连得上（那是假绿），节点侧那个端口没人在听。
  journalctl --user -u $unit -n 50"
    fi
    trail="${BETA_SSH_TRAIL[$i]}"
    if [ -n "$trail" ]; then
      unit="$(beta_unit_instance 'qianmo-mirror' "$node" '.timer')"
      state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
      if [ "$state" = 'active' ]; then
        beta_ok "$node 审计镜像 timer 在跑（${unit}）"
      else
        # 镜像停了不影响拨号，但会让下面第④步验的那条链**悄悄变旧**——而一条滞后
        # 三天的链和一条实时链在 `--verify` 眼里一模一样，都是 intact。
        fail_item "$node 的审计镜像 timer 不是 active（$unit 现在是 ${state:-未知}）—— 它的链会停在上一次拉取的时刻，而 --verify 照样报 intact"
      fi
    fi
    i=$((i + 1))
  done
}

# H 腿那两个单元的状态与现实对不上时说一句（issue #64）。
#
# **它自己从不判 FAIL。**不一致的两种形状里，「inactive 而进程活着」恰恰是本包的正常
# 形态（beta-up.sh 只 enable 不 start），判红就是把一套对的部署报成坏的；另一种
# 「active 而进程没了」已经被上面那条 /v0/health 判掉了，这里只负责解释状态为什么在
# 骗人。判死活的**只有** /v0/health —— 这一节存在的全部理由，就是让跑过
# `systemctl --user is-active` 拿到错答案的人在这里看到为什么。
host_unit_note() {
  local unit="$1" alive="$2" state note
  beta_systemd_user_ok || return 0
  [ -f "$BETA_SYSTEMD_USER_DIR/$unit" ] || return 0
  state="$(systemctl --user is-active "$unit" 2>/dev/null || true)"
  note="$(beta_unit_state_note "$unit" "$state" "$alive")"
  [ -n "$note" ] || return 0
  beta_say "注意 : $note"
}

run_host() {
  beta_load_peers
  if [ "$BETA_PEER_COUNT" -eq 0 ]; then
    beta_die "$BETA_PEERS_FILE 里一条地址都没有 —— 先按里面的注释填表"
  fi

  check_links

  beta_head '① 注册中心'
  local status
  status="$(beta_http_status "$BETA_REGISTRY_URL/v0/health")"
  if [ "$status" = '200' ]; then
    beta_ok "注册中心 /v0/health 200（${BETA_REGISTRY_URL}）"
    host_unit_note "$BETA_REGISTRY_UNIT" 1
  else
    fail_item "注册中心 /v0/health 回 ${status}（${BETA_REGISTRY_URL}）"
    host_unit_note "$BETA_REGISTRY_UNIT" 0
  fi

  beta_head "② 按名解析 + 真拨通（$BETA_PEER_COUNT 条地址）"
  local i=0 addr node psk_file out ok_addr=0 ok_eps=' ' ok_ep_count=0
  out="$BETA_RUN_DIR/smoke-probe.json"
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    addr="${BETA_PEER_ADDR[$i]}"
    node="${BETA_PEER_NODE[$i]}"
    psk_file="$(beta_peer_psk_file "$node")"
    if [ ! -s "$psk_file" ]; then
      # 缺 PSK 与拨不通是两回事，报错要分开——前者是 H 上的运维副本没铺全（§8.3），
      # 后者才是节点或网络的问题。
      fail_item "$addr 未探测：H 上缺 $node 的 PSK 副本（${psk_file}）"
      i=$((i + 1))
      continue
    fi
    if QIANMO_TRANSPORT_PSK="$(cat "$psk_file")" \
      bun run "$(demo_entry p81-probe)" \
      --registry "$BETA_REGISTRY_URL" \
      --expect "$addr" \
      --task "$addr" \
      --from-node "$SMOKE_FROM_NODE" \
      --from-agent "$SMOKE_FROM_AGENT" >"$out" 2>&1; then
      beta_ok "$addr 解析 + 拨通 + task.request 收到 ack"
      ok_addr=$((ok_addr + 1))
      local ep="${BETA_PEER_EP[$i]}"
      case "$ok_eps" in
        *" $ep "*) ;;
        *) ok_eps="$ok_eps$ep "; ok_ep_count=$((ok_ep_count + 1)) ;;
      esac
    else
      # 把那一行 JSON 原样打出来：resolved / dialed / error 三个字段就是分诊表
      # （resolved:false = 注册中心那边的事；dialed:false = 节点或 PSK 那边的事）。
      fail_item "$addr 解析、拨号或 task.request 失败 —— $(tail -1 "$out" 2>/dev/null || true)"
    fi
    i=$((i + 1))
  done
  beta_say "小计 : 地址 $ok_addr/$BETA_PEER_COUNT 通，去重后端点 $ok_ep_count 个拨通"

  beta_head '③ 控制台'
  # 探控制台**实际**绑上的地址。它可能被尾参挪走过（`-- --hostname 0.0.0.0 --port 80`），
  # 而那一趟的尾参就落在 ops/console.env —— 与开机单元读的是同一行，所以这里读它
  # 等于问「systemd 下次会把控制台起在哪」。拿默认值探等于报一个假红（common.sh 的
  # beta_console_url_from_args 有实测记录）。
  local console_url console_extra
  local -a console_extra_args=()
  console_extra="$(beta_conf_get "$BETA_OPS_DIR/console.env" CONSOLE_EXTRA_ARGS)"
  # 这一行要按空白还原成参数表。**用 read -ra 而不是不加引号的展开**：后者除了分词还会
  # 做文件名通配，于是一个带 `*` / `?` / `[...]` 的尾参（不含空白，写得进 console.env）
  # 会在 beta-smoke.sh 的当前目录里意外匹配上文件，参数表当场变形，喂给下面那个按位置
  # 记状态的扫描器就会解出一个错的地址——而这个脚本存在的意义正是「别报错地址」。
  read -ra console_extra_args <<<"$console_extra"
  console_url="$(beta_console_url_from_args ${console_extra_args[@]+"${console_extra_args[@]}"})"
  status="$(beta_http_status "$console_url/v0/health")"
  if [ "$status" = '200' ]; then
    beta_ok "控制台 /v0/health 200（${console_url}）"
    host_unit_note "$BETA_CONSOLE_UNIT" 1
  else
    fail_item "控制台 /v0/health 回 ${status}（${console_url}）"
    host_unit_note "$BETA_CONSOLE_UNIT" 0
  fi

  beta_head '④ 审计链'
  local n total=0
  for n in $(beta_peer_nodes); do
    verify_node_trail_on_host "$n"
    total=$((total + 1))
  done
  # 这一行就是 DoD① 里「四条审计链各自 intact」那一条的量具，别只看退出码。
  beta_say "小计 : 审计链 $TRAIL_INTACT/$total intact，$TRAIL_MISSING 条尚未创建"
}

run_node() {
  if [ "$NODE_GIVEN" = '0' ]; then
    beta_warn "没给 --node，按默认节点名 $BETA_NODE 检查"
  fi

  beta_head "① 进程与端口（节点 ${BETA_NODE}）"
  if beta_running "$BETA_NODE"; then
    beta_ok "$BETA_NODE 在跑（pid $(cat "$(beta_pidfile "$BETA_NODE")")）"
  else
    fail_item "$BETA_NODE 没在跑（$(beta_pidfile "$BETA_NODE")）"
  fi
  local probe_host="$BETA_NODE_BIND"
  if [ "$probe_host" = '0.0.0.0' ]; then probe_host='127.0.0.1'; fi
  if beta_tcp_open "$probe_host" "$BETA_NODE_PORT"; then
    beta_ok "${probe_host}:${BETA_NODE_PORT} 收连接"
  else
    fail_item "${probe_host}:${BETA_NODE_PORT} 不收连接"
  fi

  beta_head "② 审计链（权威副本）"
  local trail
  trail="$(beta_node_trail "$BETA_NODE")"
  if [ -f "$trail" ]; then
    verify_trail "$BETA_NODE" "$trail" '权威'
  else
    trail_missing "$BETA_NODE" "$trail"
  fi

  beta_say ''
  beta_warn '节点腿证不了两件事：按名解析（注册中心永不出 H 的回环）与 PSK 是否对得上
（本机对自己拨号不做真握手判定）。这两条只有 H 上的 --role host 说了算 —— 见本文件头。'
}

case "$ROLE" in
  host) run_host ;;
  node) run_node ;;
esac

beta_head "自检结束，耗时 $(beta_elapsed "$STARTED_AT")"
if [ "$FAIL" = '0' ]; then
  beta_say '结论 : PASS'
  exit 0
fi
beta_say "结论 : FAIL —— 具体是这几项：$FAILED_ITEMS"
exit 1
