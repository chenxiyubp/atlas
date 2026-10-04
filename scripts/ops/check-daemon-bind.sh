#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-daemon-bind.sh —— 绑定不变式自检：断言 Dormice daemon 只监听回环地址。
#
# 为什么需要它
# ------------
# AC-6(c) 的成立目前压在一句话上：daemon 绑在回环。这句话没有任何机制保证——
# 改一行配置、换一个版本的默认值、或者为了"临时调试"加个 --host 参数，它就悄悄
# 不成立了，而且不会有任何报错。本脚本把"靠人记"变成"可执行的断言"：
# 退出码 0 = 不变式成立，非 0 = 不变式被破坏。
#
# 与 harden-dormice-host.sh 的关系是两层防御，不是重复：那个脚本在网络层挡住
# 沙箱，本脚本盯的是绑定地址本身。两层任一失守，另一层仍在。
#
# 判定规则
# --------
# 取本机所有 TCP LISTEN 项，只看端口等于 DORMICE_DAEMON_PORT 的那些：
#   - 全部是回环地址（127.0.0.0/8、::1、::ffff:127.x）        -> 0，不变式成立
#   - 存在任何非回环监听（0.0.0.0、*、::、以及任何具体网卡地址）-> 1，不变式被破坏
#   - 该端口上没有任何监听（daemon 没跑）                      -> 0，不判定并说明
#
# 「daemon 没跑」为什么算 0 而不算失败：本脚本断言的是"不存在非回环监听"这一
# 安全性质，没有监听时该性质成立。把它判成失败会让脚本在维护窗口里刷红，红得
# 太廉价的断言最后一定被人 `|| true` 掉。
#
# 不含任何主机名 / IP 地址 / 用户名 / 凭据
# ---------------------------------------
# 端口走环境变量并带默认值；脚本里出现的地址字面量只有回环与通配符这两类判定
# 常量本身，不指向任何具体机器。
#
# 用法
# ----
#   ./check-daemon-bind.sh                     # 探测本机
#   DORMICE_DAEMON_PORT=3676 ./check-daemon-bind.sh
#   DORMICE_LISTEN_SNAPSHOT=<file> ./check-daemon-bind.sh   # 离线判定，见下
#
# 环境变量
#   DORMICE_DAEMON_PORT      daemon 控制端口，默认 3676
#   DORMICE_LISTEN_SNAPSHOT  监听表快照文件。设置后**不做任何实时探测**，改从该
#                            文件读取，格式为 `ss -Hltn` 的输出（第 4 列是
#                            本地 地址:端口）。用途有二：① 把现场监听表带回来
#                            离线复核；② CI 上没有 daemon、也不该去探测端口，
#                            测试用固定快照喂给本脚本，从而把绿灯与红灯两个方向
#                            都断言住（见 __tests__/daemon-bind-invariant.test.ts）。
#
# 退出码
#   0 不变式成立（含"daemon 未监听，不判定"）
#   1 不变式被破坏：存在非回环监听
#   2 无法判定：既没有 ss 也没有 lsof，或快照文件不可读，或参数错误

set -euo pipefail

DORMICE_DAEMON_PORT="${DORMICE_DAEMON_PORT:-3676}"
DORMICE_LISTEN_SNAPSHOT="${DORMICE_LISTEN_SNAPSHOT:-}"

usage() {
  cat <<'EOF'
check-daemon-bind.sh —— 断言 Dormice daemon 只监听回环地址。

用法: check-daemon-bind.sh [--help]

环境变量:
  DORMICE_DAEMON_PORT      daemon 控制端口，默认 3676
  DORMICE_LISTEN_SNAPSHOT  监听表快照文件（`ss -Hltn` 格式），设置后不做实时探测

退出码: 0 成立（含未监听）/ 1 被破坏 / 2 无法判定
EOF
}

case "${1:-}" in
  '') ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    printf 'check-daemon-bind: 未知参数: %s\n' "$1" >&2
    usage >&2
    exit 2
    ;;
esac

case "$DORMICE_DAEMON_PORT" in
  '' | *[!0-9]*)
    printf 'check-daemon-bind: DORMICE_DAEMON_PORT 必须是数字，实际为 %s\n' \
      "'${DORMICE_DAEMON_PORT}'" >&2
    exit 2
    ;;
esac

# 输出一行一个「地址:端口」。三个来源产出同一种规格，判定逻辑只写一次。
collect_listen_entries() {
  if [ -n "$DORMICE_LISTEN_SNAPSHOT" ]; then
    if [ ! -r "$DORMICE_LISTEN_SNAPSHOT" ]; then
      printf 'check-daemon-bind: 快照文件不可读: %s\n' "$DORMICE_LISTEN_SNAPSHOT" >&2
      return 2
    fi
    awk 'NF >= 4 { print $4 }' "$DORMICE_LISTEN_SNAPSHOT"
    return 0
  fi

  if command -v ss >/dev/null 2>&1; then
    # -H 去表头、-l 只看 LISTEN、-t TCP、-n 不解析名字（也就不会有 DNS 往返）。
    ss -Hltn | awk 'NF >= 4 { print $4 }'
    return 0
  fi

  if command -v lsof >/dev/null 2>&1; then
    # macOS 等没有 ss 的系统。-Fn 输出机器可读字段，`n` 行即 地址:端口。
    lsof -nP -iTCP -sTCP:LISTEN -Fn 2>/dev/null | sed -n 's/^n//p'
    return 0
  fi

  printf 'check-daemon-bind: 既找不到 ss 也找不到 lsof，无法读取监听表\n' >&2
  return 2
}

# 回环判定。方括号是 IPv6 在 `addr:port` 里的包裹形式，先剥掉。
is_loopback_addr() {
  local addr="$1"
  addr="${addr#[}"
  addr="${addr%]}"
  case "$addr" in
    127.*) return 0 ;;                # 127.0.0.0/8 整段都是回环
    ::1) return 0 ;;                  # IPv6 回环
    ::ffff:127.*) return 0 ;;         # IPv4-mapped 回环
    localhost) return 0 ;;            # lsof 在极少数配置下会给出名字
    *) return 1 ;;                    # 0.0.0.0 / * / :: / 任何具体网卡地址
  esac
}

set +e
entries="$(collect_listen_entries)"
collect_status=$?
set -e
if [ "$collect_status" -ne 0 ]; then
  exit 2
fi

violations=''
loopback_hits=0
violation_count=0

while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  # 端口是最后一个冒号之后的部分；地址是之前的部分（对 [::1]:PORT 同样成立）。
  port="${entry##*:}"
  addr="${entry%:*}"
  [ "$port" = "$DORMICE_DAEMON_PORT" ] || continue

  if is_loopback_addr "$addr"; then
    loopback_hits=$((loopback_hits + 1))
  else
    violation_count=$((violation_count + 1))
    violations="${violations}  ${entry}
"
  fi
done <<EOF
$entries
EOF

if [ "$violation_count" -gt 0 ]; then
  printf 'check-daemon-bind: 不变式被破坏 —— 端口 %s 上存在 %s 处非回环监听：\n' \
    "$DORMICE_DAEMON_PORT" "$violation_count" >&2
  printf '%s' "$violations" >&2
  printf 'check-daemon-bind: 沙箱内的智能体可能因此直接够到 daemon 控制面（其凭据无权限分级）。\n' >&2
  exit 1
fi

if [ "$loopback_hits" -gt 0 ]; then
  printf 'check-daemon-bind: 不变式成立 —— 端口 %s 上 %s 处监听全部为回环地址\n' \
    "$DORMICE_DAEMON_PORT" "$loopback_hits"
  exit 0
fi

printf 'check-daemon-bind: 端口 %s 上没有任何监听（daemon 未运行），不判定\n' \
  "$DORMICE_DAEMON_PORT"
exit 0
