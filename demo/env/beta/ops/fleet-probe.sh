#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · H 上的可用性与唤醒探针（M1「可用性 ≥ 99%、唤醒 P95 < 30 s」的量具）。
#
#   fleet-probe.sh minute      # 每分钟：每个节点端点真读一次应答（426）+ 注册中心 / 控制台 health
#   fleet-probe.sh handshake   # 每 5 分钟：每个节点按名解析 + 真 PSK 握手（p81-probe，不发任务）
#   fleet-probe.sh wake        # 每 10 分钟：按轮转表唤醒一个节点（控制台 POST /v0/wake）
#   fleet-probe.sh install     # 渲染并 enable 三个 timer（**不 start**：开始计时是一个有意的动作）
#
# ── 它量的是什么，不量什么 ───────────────────────────────────────────────────
# **可用性**：一个节点在某一分钟「可用」= 从 H 对它的端点真读到一行 HTTP 应答
# （beta_endpoint_live；隧道口的 TCP 探测是假绿，§9.8）。握手那一档每 5 分钟补一次
# 「名册有、端口在、PSK 对」。控制台与注册中心各自 /v0/health。
#
# **唤醒**：控制台 `POST /v0/wake` 发起 → 节点回执（本脚本记这一段，以及 msgId / taskId）；
# 发起 → 首个内容由节点的 `--timings`（first_content）按 msgId 关联出来，离线算。
# **这不是 baseline-m0 §3 的「沙箱冻结 → unpause → 就绪」链路**：内测舰队上没有沙箱冻结，
# 这里测的是常驻节点空闲态的唤醒。两个数不能直接比，也不能写成 AC-2 口径的唤醒。
#
# 唤醒走控制台而不是 resident-wake：那才是用户真实走的路；且控制台带 --wake-sign 时
# 唤醒是 verified-capability 档，不会在节点链上留 capability_shadow_refusal——否则探针
# 自己就会让 key-distribution §9.2 ① 的「连续 7 天计数为 0」永远不成立。握手那一档
# 也因此**不带 --task**：一条未签名的 task.request 就是一条 shadow refusal。
#
# ── 纪律 ────────────────────────────────────────────────────────────────────
# · 内存护栏：MemAvailable 低于 PROBE_MIN_AVAILABLE_MB（默认 150）就只记一行 skipped 退出。
#   H 同时是负责人的代理出口，量具不能成为压垮它的那一个进程。
# · 凭据：每节点 PSK 从 secrets/peers/<节点>.psk 进环境；控制台 admin token 经 curl -K -
#   从 stdin 进，不上命令行、不落文件、不打印。
# · 数据：<根>/state/fleet-probe/<类>-<节点>.ndjson（目录 0700、文件 0600），一行一个样本：
#   {"t":"<ISO>","node":"…","probe":"…","ok":true|false,"ms":<int>,"detail":"…"}
#   失败的样本照记，不剔除——P95 按 nearest-rank 算，失败按 +∞ 留在样本里。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=demo/env/beta/common.sh
. "$HERE/../common.sh"

PROBE_DIR="$BETA_STATE_DIR/fleet-probe"
PROBE_CONF="$BETA_OPS_DIR/fleet-probe.env"
PROBE_MIN_AVAILABLE_MB="${PROBE_MIN_AVAILABLE_MB:-150}"
BETA_MEMINFO_PATH="${BETA_MEMINFO_PATH:-/proc/meminfo}"
CONSOLE_URL="http://${BETA_HOST_BIND}:${BETA_CONSOLE_PORT}"

now_ms() { perl -MTime::HiRes=time -e 'printf "%d", time() * 1000'; }
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# 一行样本。detail 只留可打印 ASCII 且去掉引号与反斜杠——它进的是 JSON 字符串。
record() {
  local file="$1" node="$2" probe="$3" ok="$4" ms="$5" detail="${6:-}"
  detail="$(printf '%s' "$detail" | LC_ALL=C tr -cd '[:print:]' | tr -d '"\\' | cut -c1-200)"
  mkdir -p "$PROBE_DIR"
  chmod 700 "$PROBE_DIR"
  (umask 077 && printf '{"t":"%s","node":"%s","probe":"%s","ok":%s,"ms":%s,"detail":"%s"}\n' \
    "$(iso_now)" "$node" "$probe" "$ok" "$ms" "$detail" >>"$PROBE_DIR/$file")
}

# 内存护栏。读不到 meminfo（非 Linux）就不拦。
low_memory() {
  local kb
  [ -r "$BETA_MEMINFO_PATH" ] || return 1
  kb="$(awk '/^MemAvailable:/ {print $2}' "$BETA_MEMINFO_PATH")"
  [ -n "$kb" ] || return 1
  [ $((kb / 1024)) -lt "$PROBE_MIN_AVAILABLE_MB" ]
}

guard_memory() {
  if low_memory; then
    record health.ndjson '-' "$1" false 0 "skipped:low-mem<${PROBE_MIN_AVAILABLE_MB}MB"
    exit 0
  fi
}

# ws://host:port[/…] → "host port"
endpoint_host_port() {
  local rest="${1#*://}" hostport host port
  hostport="${rest%%/*}"
  port="${hostport##*:}"
  host="${hostport%:*}"
  host="${host#[}"
  host="${host%]}"
  printf '%s %s' "$host" "$port"
}

first_address_of() {
  local want="$1" i=0
  while [ "$i" -lt "$BETA_PEER_COUNT" ]; do
    if [ "${BETA_PEER_NODE[$i]}" = "$want" ]; then
      printf '%s' "${BETA_PEER_ADDR[$i]}"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

cmd_minute() {
  guard_memory minute
  beta_load_peers
  local node ep hp host port t0 ok
  for node in $(beta_peer_nodes); do
    ep="$(beta_peer_endpoint "$node")"
    hp="$(endpoint_host_port "$ep")"
    host="${hp% *}"
    port="${hp#* }"
    t0="$(now_ms)"
    ok=false
    if beta_endpoint_live "$host" "$port" 5; then ok=true; fi
    record "avail-$node.ndjson" "$node" endpoint "$ok" $(($(now_ms) - t0)) "$ep"
  done
  local what url code
  for what in registry console; do
    if [ "$what" = registry ]; then url="$BETA_REGISTRY_URL"; else url="$CONSOLE_URL"; fi
    t0="$(now_ms)"
    code="$(beta_http_status "$url/v0/health")"
    ok=false
    [ "$code" = '200' ] && ok=true
    record health.ndjson "$what" health "$ok" $(($(now_ms) - t0)) "http=$code"
  done
}

cmd_handshake() {
  guard_memory handshake
  beta_load_peers
  local node addr psk_file t0 ok out
  for node in $(beta_peer_nodes); do
    addr="$(first_address_of "$node")"
    psk_file="$(beta_peer_psk_file "$node")"
    t0="$(now_ms)"
    if [ ! -f "$psk_file" ]; then
      record "handshake-$node.ndjson" "$node" handshake false 0 "no-psk-file"
      continue
    fi
    ok=false
    if out="$(QIANMO_TRANSPORT_PSK="$(cat "$psk_file")" bun run "$(demo_entry p81-probe)" \
      --registry "$BETA_REGISTRY_URL" --expect "$addr" 2>&1)"; then
      ok=true
    fi
    record "handshake-$node.ndjson" "$node" handshake "$ok" $(($(now_ms) - t0)) \
      "$(printf '%s' "$out" | tail -1 | cut -c1-160)"
  done
}

# 轮转表：一格一个节点名，`-` 表示这一格不唤醒。按「当天第几个 10 分钟」取格。
wake_slot_node() {
  local rotation="$1" minutes="$2" n i=0 pick='' one
  # shellcheck disable=SC2086
  set -- $rotation
  n="$#"
  [ "$n" -gt 0 ] || return 1
  i=$(((minutes / 10) % n))
  for one in "$@"; do
    if [ "$i" -eq 0 ]; then pick="$one"; break; fi
    i=$((i - 1))
  done
  [ "$pick" != '-' ] || return 1
  printf '%s' "$pick"
}

cmd_wake() {
  guard_memory wake
  [ -f "$PROBE_CONF" ] || beta_die "缺 $PROBE_CONF —— 先跑 fleet-probe.sh install"
  # shellcheck disable=SC1090
  . "$PROBE_CONF"
  : "${PROBE_WAKE_ROTATION:?}" "${PROBE_WAKE_AGENT:?}" "${PROBE_WAKE_FROM:?}"
  local minutes node t0 body code response msg_id
  minutes=$((10#$(date -u +%H) * 60 + 10#$(date -u +%M)))
  node="$(wake_slot_node "$PROBE_WAKE_ROTATION" "$minutes")" || return 0
  [ -s "$BETA_ADMIN_TOKEN_FILE" ] || beta_die "缺控制台 admin token：$BETA_ADMIN_TOKEN_FILE"
  body="$(printf '{"node":"%s","from":"%s","to":"qianmo://%s/%s","prompt":"wake-probe %s：这是可用性探针，只回复 OK，不要调用任何工具。"}' \
    "$node" "$PROBE_WAKE_FROM" "$node" "$PROBE_WAKE_AGENT" "$(iso_now)")"
  t0="$(now_ms)"
  response="$(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$BETA_ADMIN_TOKEN_FILE")" \
    | curl -s -m 120 -K - -H 'content-type: application/json' -X POST \
      --data "$body" -w '\n%{http_code}' "$CONSOLE_URL/v0/wake" 2>/dev/null || true)"
  code="${response##*$'\n'}"
  msg_id="$(printf '%s' "$response" | sed -n 's/.*"msgId":"\([^"]*\)".*/\1/p' | head -1)"
  if [ "$code" = '200' ] && [ -n "$msg_id" ]; then
    record "wake-$node.ndjson" "$node" wake true $(($(now_ms) - t0)) "msgId=$msg_id"
  else
    record "wake-$node.ndjson" "$node" wake false $(($(now_ms) - t0)) "http=${code:-000}"
  fi
}

cmd_install() {
  local rotation='' agent='reviewer' from='qianmo://hub/console'
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --rotation) rotation="${2:?}"; shift 2 ;;
      --agent) agent="${2:?}"; shift 2 ;;
      --from) from="${2:?}"; shift 2 ;;
      *) beta_die "install 不认识的参数：$1" ;;
    esac
  done
  [ -n "$rotation" ] || beta_die 'install 要 --rotation "<节点> <节点> … -"（一格 10 分钟，- 表示空格）'
  beta_require_marker
  {
    printf '# 阡陌内测 · 探针参数。由 fleet-probe.sh install 写。\n'
    printf 'PROBE_WAKE_ROTATION="%s"\n' "$rotation"
    printf 'PROBE_WAKE_AGENT=%s\n' "$agent"
    printf 'PROBE_WAKE_FROM=%s\n' "$from"
  } >"$PROBE_CONF"
  chmod 600 "$PROBE_CONF"
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user" src dst bun_dir
  bun_dir="$(dirname "$(command -v bun 2>/dev/null || printf '%s' "$HOME/.bun/bin/bun")")"
  mkdir -p "$unit_dir"
  for src in "$HERE"/qianmo-probe@.service.in "$HERE"/qianmo-probe-*.timer.in; do
    dst="$unit_dir/$(basename "$src" .in)"
    sed -e "s|@REPO_DIR@|$(beta_unit_path "$REPO_DIR")|g" \
      -e "s|@BETA_ROOT@|$(beta_unit_path "$BETA_ROOT")|g" \
      -e "s|@BUN_DIR@|$(beta_unit_path "$bun_dir")|g" \
      "$src" >"$dst"
    grep -q '@[A-Z_]*@' "$dst" && beta_die "模板里有没替换掉的占位符：$src"
    chmod 644 "$dst"
  done
  beta_ok "已写：$PROBE_CONF 与 $unit_dir 下的 qianmo-probe@.service、qianmo-probe-{minute,handshake,wake}.timer"
  if [ "${QIANMO_PROBE_NO_SYSTEMCTL:-0}" != '1' ] && beta_systemd_user_ok; then
    systemctl --user daemon-reload
    systemctl --user enable qianmo-probe-minute.timer qianmo-probe-handshake.timer qianmo-probe-wake.timer >/dev/null
    beta_say '已 enable 三个 timer，**没有 start**。开始计时：systemctl --user start qianmo-probe-{minute,handshake,wake}.timer'
  fi
}

case "${1:-}" in
  minute) cmd_minute ;;
  handshake) cmd_handshake ;;
  wake) cmd_wake ;;
  install) shift; cmd_install "$@" ;;
  -h|--help|'') sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) beta_die "不认识的子命令：$1" ;;
esac
