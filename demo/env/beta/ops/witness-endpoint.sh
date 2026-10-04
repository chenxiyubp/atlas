#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · 审计见证端点（P11.4，audit-witness.md §4）。
#
#   witness-endpoint.sh install --key <节点>=<公钥> [--key …] [--port 38640]   # 见证机上：token、参数、单元
#   witness-endpoint.sh start | stop | status                                  # 见证机上没有常驻 systemd --user 时（无 linger）
#   witness-endpoint.sh run                                                    # 前台跑；单元与 start 都经它
#   witness-endpoint.sh link-install --user <u> --host <h> --key <私钥> [--ssh-port 22] [--port 38640]   # H 上：到见证机的 ssh -L
#
# ── 两种形态 ────────────────────────────────────────────────────────────────
# 端点永远只听**它所在机器**的回环（默认 127.0.0.1:38640）。节点够到它，靠的是 H 发起的
# 那条隧道会话里的 `-R 127.0.0.1:38640:127.0.0.1:38640`（peers.conf 坐标行的 witness-port=）：
# 节点把锚点写到自己的回环口，SSH 把它送到 H 的回环 38640。节点侧 authorized_keys 那一行用
# `permitlisten="127.0.0.1:38640"` 把反向转发钉死在这一个口上。
#
#   ① 见证在 H 上：H 回环 38640 就是端点本身。只在 H 上**没有**任何节点时成立。
#   ② 见证在另一台机器 W 上：**H 自己也跑着节点时必须用这一种**——见证方与被见证方必须处在
#      不同失陷域（audit-witness.md §4.1），见证和它见证的节点不能在同一台机器上。W 上的端点
#      同样只听回环；H 上多一条 `ssh -N -L 127.0.0.1:38640:127.0.0.1:38640 W`
#      （`link-install` 装的 qianmo-witness-link.service），节点的 `-R` 落在 H 的 38640 上，
#      再被这条 `-L` 接到 W。W 的 authorized_keys 里那一行只放行这一个口：
#        restrict,port-forwarding,permitopen="127.0.0.1:38640",permitlisten="127.0.0.1:1",command="/bin/false" <H 的公钥>
#      （`port-forwarding` 同时打开 -R，`permitlisten` 把它钉在一个非 root 绑不上的口上，
#      beta-env.md §9.10。）会话仍由 H 发起：W 与节点上都不放任何指向 H 的凭据。
#      H 被拿下时，攻击者经这条链路能做的只有「追加锚点」——删不掉、也改不了已有的任何一条。
#
# 见证机没有 linger（无 sudo 的 VPS 通常如此）时，systemd --user 单元活不过最后一次登出，
# 用 `start`：nohup 起 `run`，pid 记在 <根>/run/witness.pid，并把 oom_score_adj 调到 1000
# （`QIANMO_WITNESS_OOM_SCORE_ADJ`，可给 off）——见证机是别人的机器，内存打满时先杀它。
# 端点挂了节点不受影响：发送方 fail-open，只在 stderr 报一句写不进去。
#
# ── 两枚 token ──────────────────────────────────────────────────────────────
# install 首次运行时各生成一枚（64 hex，0600，两枚必须不同），**不回显**：
#   <根>/secrets/witness-write-token   发给每个节点（节点那边落 secrets/witness-write-token）
#   <根>/secrets/witness-read-token    只给做验证的一方：见证机自己（`occ audit --verify --witness`）；
#                                      形态②下还要给 H 上的控制台（`--anchors http://127.0.0.1:38640`，
#                                      beta-up.sh 从 H 的 secrets/witness-read-token 读进环境）
# 已经在的不重生成：换 token 是一次有计划的动作，不是重跑 install 的副作用。
#
# ── 节点公钥 ────────────────────────────────────────────────────────────────
# `--key <节点>=<公钥>` 一次给全，来源是节点 logs/<节点>.out 首行横幅里的 publicKey。
# 加一个节点 = 带着**全部** --key 重跑 install，再重起端点。不做首次信任。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$HERE/../../../.." && pwd)"
BETA_ROOT="${QIANMO_BETA_ROOT:-$HOME/qianmo-beta}"
MARKER="$BETA_ROOT/.qianmo-beta-env"
MARKER_MAGIC='qianmo-beta-env/v1'
OPS_DIR="$BETA_ROOT/ops"
SECRET_DIR="$BETA_ROOT/secrets"
RUN_DIR="$BETA_ROOT/run"
LOG_DIR="$BETA_ROOT/logs"
CONF="$OPS_DIR/witness.env"
LINK_CONF="$OPS_DIR/witness-link.env"
STORE="$BETA_ROOT/witness/store"
WRITE_TOKEN_FILE="$SECRET_DIR/witness-write-token"
READ_TOKEN_FILE="$SECRET_DIR/witness-read-token"
READY_FILE="$RUN_DIR/witness-ready.json"
PID_FILE="$RUN_DIR/witness.pid"
UNIT='qianmo-witness.service'
LINK_UNIT='qianmo-witness-link.service'
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
OOM_SCORE_ADJ="${QIANMO_WITNESS_OOM_SCORE_ADJ:-1000}"
OOM_ADJ_PATH="${QIANMO_WITNESS_OOM_ADJ_PATH:-/proc/self/oom_score_adj}"

say() { printf '%s\n' "$*"; }
die() {
  printf '[witness-endpoint] %s\n' "$*" >&2
  exit 1
}

require_marker() {
  [ -f "$MARKER" ] || die "$BETA_ROOT 不是内测环境（缺 ${MARKER}）"
  head -1 "$MARKER" | grep -qF "$MARKER_MAGIC" \
    || die "$MARKER 的首行不是 ${MARKER_MAGIC}，拒绝操作"
}

# 见证机上没有跑过 beta-up.sh，内测根可能还不存在。**只在目录根本不存在时**建它并写标记
# （格式与 common.sh 的 beta_seed_root 相同）；目录在、标记不在，就拒绝——不收编一个来历
# 不明的目录。
seed_root() {
  case "$BETA_ROOT" in
    /*) ;;
    *) die "QIANMO_BETA_ROOT 必须是绝对路径：$BETA_ROOT" ;;
  esac
  case "$BETA_ROOT" in *..*) die "QIANMO_BETA_ROOT 里有 ..：$BETA_ROOT" ;; esac
  [ "$BETA_ROOT" != / ] && [ "$BETA_ROOT" != "$HOME" ] \
    || die "QIANMO_BETA_ROOT 不能是 $BETA_ROOT"
  if [ ! -e "$BETA_ROOT" ]; then
    mkdir -p "$BETA_ROOT"
    chmod 700 "$BETA_ROOT"
    {
      printf '%s\n' "$MARKER_MAGIC"
      printf 'created-at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      printf 'repo=%s\n' "$REPO_DIR"
      printf '# 由 witness-endpoint.sh install 建（这台机器只做见证，不跑节点）。\n'
    } >"$MARKER"
    chmod 600 "$MARKER"
    say "内测根已建（只做见证）：$BETA_ROOT"
  fi
  require_marker
}

unit_path() {
  case "$1" in
    "$HOME"/*) printf '%%h/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

systemd_user_ok() {
  [ "${QIANMO_WITNESS_NO_SYSTEMCTL:-0}" = '1' ] && return 1
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1
}

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

new_token() {
  LC_ALL=C od -An -tx1 -N 32 /dev/urandom | tr -d ' \n'
}

ensure_token() {
  local file="$1" what="$2"
  if [ -s "$file" ]; then
    say "$what 已在（不重生成，不回显）：$file"
    return 0
  fi
  (umask 077 && new_token >"$file")
  chmod 600 "$file"
  say "$what 已生成（0600，不回显）：$file"
}

port_ok() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

cmd_install() {
  local port='38640' keys='' one
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --key)
        one="${2:?--key 缺值}"
        case "$one" in
          [a-z0-9]*=?*) ;;
          *) die "--key 要写成 <节点>=<公钥>：$one" ;;
        esac
        case "$one" in *[[:space:]]*) die "--key 里不能有空白：$one" ;; esac
        keys="$keys $one"
        shift 2
        ;;
      --port) port="${2:?}"; shift 2 ;;
      *) die "install 不认识的参数：$1" ;;
    esac
  done
  [ -n "$keys" ] || die 'install 至少要一条 --key <节点>=<公钥>'
  port_ok "$port" || die "--port 不是端口号：$port"
  seed_root
  mkdir -p "$OPS_DIR" "$SECRET_DIR"
  chmod 700 "$OPS_DIR" "$SECRET_DIR"

  ensure_token "$WRITE_TOKEN_FILE" '见证写 token'
  ensure_token "$READ_TOKEN_FILE" '见证读 token'
  cmp -s "$WRITE_TOKEN_FILE" "$READ_TOKEN_FILE" \
    && die '两枚见证 token 相同——删掉其中一个重跑 install'

  {
    printf '# 阡陌内测 · 见证端点的参数。由 witness-endpoint.sh install 写，run 读。\n'
    printf 'WITNESS_PORT=%s\n' "$port"
    # 多把公钥之间是空格：不加引号，run 那边 source 时第二把会被当成命令执行。
    printf 'WITNESS_KEYS="%s"\n' "${keys# }"
  } >"$CONF"
  chmod 600 "$CONF"
  say "已写：${CONF}（节点：${keys# }）"

  local bun_path
  bun_path="$(command -v bun 2>/dev/null || printf '%s' "$HOME/.bun/bin/bun")"
  mkdir -p "$UNIT_DIR"
  sed -e "s|@REPO_DIR@|$(unit_path "$REPO_DIR")|g" \
    -e "s|@BETA_ROOT@|$(unit_path "$BETA_ROOT")|g" \
    -e "s|@BUN_DIR@|$(unit_path "$(dirname "$bun_path")")|g" \
    "$HERE/$UNIT.in" >"$OPS_DIR/$UNIT"
  if grep -q '@[A-Z_]*@' "$OPS_DIR/$UNIT"; then die "模板里有没替换掉的占位符"; fi
  cp "$OPS_DIR/$UNIT" "$UNIT_DIR/$UNIT"
  chmod 644 "$UNIT_DIR/$UNIT"
  say "单元已写：$UNIT_DIR/$UNIT"

  if systemd_user_ok; then
    systemctl --user daemon-reload
    systemctl --user enable "$UNIT" >/dev/null
    say "已 enable ${UNIT}；首次起：systemctl --user start ${UNIT}；改了参数：systemctl --user restart $UNIT"
    say '（这台机器没有 linger 时单元活不过最后一次登出——那就别 enable，改用 witness-endpoint.sh start）'
  else
    say '这台机器上没有可用的 systemd --user：单元文件已写好，没有 enable。起它用 witness-endpoint.sh start'
  fi
}

cmd_run() {
  require_marker
  [ -f "$CONF" ] || die "缺 $CONF —— 先跑 witness-endpoint.sh install"
  # shellcheck disable=SC1090
  . "$CONF"
  : "${WITNESS_PORT:?}" "${WITNESS_KEYS:?}"
  # shellcheck source=demo/lib/entry.sh
  . "$REPO_DIR/demo/lib/entry.sh"
  local args=(
    --store "$STORE"
    --host 127.0.0.1
    --port "$WITNESS_PORT"
    --write-token-file "$WRITE_TOKEN_FILE"
    --read-token-file "$READ_TOKEN_FILE"
    --ready "$READY_FILE"
  )
  local one
  for one in $WITNESS_KEYS; do args+=(--key "$one"); done
  mkdir -p "$STORE" "$RUN_DIR"
  chmod 700 "$BETA_ROOT/witness" "$STORE"
  exec bun run "$(demo_entry witness-endpoint)" "${args[@]}"
}

# pid 文件里那个进程还活着、且确实是见证端点（pid 会被复用，只看 kill -0 不够）。
running_pid() {
  local pid
  [ -s "$PID_FILE" ] || return 1
  pid="$(cat "$PID_FILE")"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  ps -o args= -p "$pid" 2>/dev/null | grep -q 'witness-endpoint' || return 1
  printf '%s' "$pid"
}

anchor_status() {
  # shellcheck disable=SC1090
  . "$CONF"
  curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:${WITNESS_PORT}/v0/anchor" 2>/dev/null || true
}

cmd_start() {
  require_marker
  [ -f "$CONF" ] || die "缺 $CONF —— 先跑 witness-endpoint.sh install"
  local pid
  if pid="$(running_pid)"; then
    say "见证端点已在跑：pid ${pid}（不重起）"
    return 0
  fi
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  chmod 700 "$RUN_DIR" "$LOG_DIR"
  rm -f "$READY_FILE"
  (
    case "$OOM_SCORE_ADJ" in
      off) ;;
      *) printf '%s\n' "$OOM_SCORE_ADJ" >"$OOM_ADJ_PATH" 2>/dev/null \
        || printf '[witness-endpoint] 写不了 %s，OOM 次序保持继承来的值\n' "$OOM_ADJ_PATH" >&2 ;;
    esac
    umask 077
    exec nohup "$HERE/witness-endpoint.sh" run >>"$LOG_DIR/witness.out" 2>>"$LOG_DIR/witness.err" </dev/null
  ) &
  pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  chmod 600 "$PID_FILE"
  for _ in $(seq 1 60); do
    [ -f "$READY_FILE" ] && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if [ ! -f "$READY_FILE" ]; then
    tail -5 "$LOG_DIR/witness.err" >&2 || true
    die "见证端点没有就绪（pid ${pid}）；日志：$LOG_DIR/witness.err"
  fi
  say "见证端点已起：pid ${pid}，/v0/anchor 不带 token → $(anchor_status)（要 401）"
}

cmd_stop() {
  local pid
  if ! pid="$(running_pid)"; then
    rm -f "$PID_FILE"
    say '见证端点没在跑'
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 40); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  rm -f "$PID_FILE" "$READY_FILE"
  say "见证端点已停：pid $pid"
}

cmd_status() {
  require_marker
  local pid code
  if ! pid="$(running_pid)"; then
    say '见证端点：没在跑'
    return 1
  fi
  code="$(anchor_status)"
  say "见证端点：pid ${pid}，/v0/anchor 不带 token → ${code}"
  [ "$code" = '401' ]
}

# H 上：到见证机的 ssh -L 单元（形态②）。
cmd_link_install() {
  local user='' host='' key='' ssh_port='22' port='38640' remote_port=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --user) user="${2:?}"; shift 2 ;;
      --host) host="${2:?}"; shift 2 ;;
      --key) key="${2:?}"; shift 2 ;;
      --ssh-port) ssh_port="${2:?}"; shift 2 ;;
      --port) port="${2:?}"; shift 2 ;;
      --remote-port) remote_port="${2:?}"; shift 2 ;;
      *) die "link-install 不认识的参数：$1" ;;
    esac
  done
  remote_port="${remote_port:-$port}"
  [ -n "$user" ] && [ -n "$host" ] && [ -n "$key" ] \
    || die 'link-install 要 --user <见证机用户> --host <见证机地址> --key <H 上的私钥>'
  case "$user$host" in *[[:space:]@/]*) die "user / host 里不能有空白、@ 或 /" ;; esac
  case "$key" in /*) ;; *) die "--key 必须是绝对路径：$key" ;; esac
  port_ok "$ssh_port" || die "--ssh-port 不是端口号：$ssh_port"
  port_ok "$port" || die "--port 不是端口号：$port"
  port_ok "$remote_port" || die "--remote-port 不是端口号：$remote_port"
  require_marker
  [ -f "$key" ] || die "私钥不存在：$key"
  [ "$(file_mode "$key")" = '600' ] || die "私钥权限是 $(file_mode "$key")，要 600：$key"
  [ -f "$key.pub" ] || die "缺公钥：$key.pub（要把它装进见证机的 authorized_keys）"
  # 主机公钥必须事先核对过再放进 known_hosts：单元用 StrictHostKeyChecking=yes，
  # 不做首次信任（第一次连上的那把主机钥匙就是被信任的那把，正是中间人要的）。
  local lookup="$host"
  [ "$ssh_port" = '22' ] || lookup="[$host]:$ssh_port"
  ssh-keygen -F "$lookup" -f "$HOME/.ssh/known_hosts" >/dev/null 2>&1 \
    || die "known_hosts 里没有 ${lookup}：先把见证机的主机公钥**核对指纹之后**加进 $HOME/.ssh/known_hosts"

  mkdir -p "$OPS_DIR" "$UNIT_DIR"
  chmod 700 "$OPS_DIR"
  {
    printf '# 阡陌内测 · H → 见证机的 ssh -L。由 witness-endpoint.sh link-install 写。\n'
    printf 'WITNESS_SSH_USER=%s\n' "$user"
    printf 'WITNESS_SSH_HOST=%s\n' "$host"
    printf 'WITNESS_SSH_PORT=%s\n' "$ssh_port"
    printf 'WITNESS_SSH_KEY=%s\n' "$key"
    printf 'WITNESS_LOCAL_PORT=%s\n' "$port"
    printf 'WITNESS_REMOTE_PORT=%s\n' "$remote_port"
  } >"$LINK_CONF"
  chmod 600 "$LINK_CONF"
  sed -e "s|@OPS_DIR@|$(unit_path "$OPS_DIR")|g" "$HERE/$LINK_UNIT.in" >"$UNIT_DIR/$LINK_UNIT"
  if grep -q '@[A-Z_]*@' "$UNIT_DIR/$LINK_UNIT"; then die "模板里有没替换掉的占位符"; fi
  chmod 644 "$UNIT_DIR/$LINK_UNIT"
  say "已写：${LINK_CONF}、$UNIT_DIR/$LINK_UNIT"
  say '见证机 authorized_keys 里要加的那一行（公钥，不是秘密）：'
  printf 'restrict,port-forwarding,permitopen="127.0.0.1:%s",permitlisten="127.0.0.1:1",command="/bin/false" %s\n' \
    "$remote_port" "$(cat "$key.pub")"
  if systemd_user_ok; then
    systemctl --user daemon-reload
    systemctl --user enable "$LINK_UNIT" >/dev/null
    say "已 enable ${LINK_UNIT}，**没有 start**。那一行装好之后：systemctl --user start $LINK_UNIT"
  fi
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  run) shift; cmd_run "$@" ;;
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  link-install) shift; cmd_link_install "$@" ;;
  -h|--help|'') sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "不认识的子命令：$1" ;;
esac
