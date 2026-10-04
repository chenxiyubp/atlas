#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# harden-dormice-host.sh —— 幂等的宿主防火墙加固：禁止沙箱容器访问宿主上的
# Dormice daemon 控制端口。
#
# 为什么需要它
# ------------
# AC-6(c)（智能体逃不出沙箱边界、删不掉自己的备份）目前只靠一件事成立：
# daemon 绑在回环地址。而 daemon 的 API key 无权限分级——销毁沙箱与执行命令
# 用的是同一把 bearer。一旦 daemon 因为任何原因换成通配地址监听，沙箱里的
# 智能体立刻拿到销毁自己宿主的能力。单点依赖不是"已经安全"，是"还没出事"。
# 本脚本把它变成纵深防御：即使绑定地址被改坏，容器仍在网络层被挡住。
#
# 反直觉的关键事实（2026-08-12 真机实测得出，不要凭直觉改回去）
# --------------------------------------------------------------
# **容器访问宿主本机端口的流量走 INPUT 链，不走 FORWARD，因此也不走
# DOCKER-USER。** 只往 DOCKER-USER 加规则对这个威胁完全无效。
#
# 实测证据链（从 docker0 网段的沙箱容器探测宿主 daemon 端口，用连接三态区分
# ECONNREFUSED「端口无监听、内核回 RST」与 TIMEOUT「被 DROP 静默丢弃」）：
#
#   加固前                  : ECONNREFUSED  （daemon 绑回环，容器够不到）
#   仅加 DOCKER-USER 规则   : ECONNREFUSED  （不变 —— 实证该链对此威胁无效）
#   再加 INPUT 规则         : TIMEOUT       （实证 INPUT 上那条才是生效项）
#
# 全程宿主的 80 端口保持 REACHABLE，说明加固精准、无误伤。
#
# 所以本脚本**两条都加**：INPUT 是真正生效的那条，DOCKER-USER 是纵深冗余
# （挡的是另一类路径：经 FORWARD 转发到别处的容器流量），不是可省略的装饰。
#
# 幂等性
# ------
# 每条规则都是"先把同规则全部删掉，再插到链首"。重复执行不会累积重复规则，
# 也不会因为链首被别的规则占了而失效（DOCKER-USER 与 INPUT 里都可能有先到的
# ACCEPT 规则，插在它们后面等于没插）。
#
# 持久化
# ------
# 配套 dormice-harden.service（同目录）。docker 重启会 flush 并重建
# DOCKER-USER 链，所以必须把本脚本绑在 docker.service 的生命周期上自动重加，
# 不能只跑一次。
#
# 不含任何主机名 / IP 地址 / 用户名 / 凭据
# ---------------------------------------
# 端口与网卡名走环境变量并带默认值；网段一律用**网卡名**（-i）匹配而不是写
# 网段字面量，这样脚本里连一个 RFC1918 地址都不需要出现。适用于任何一台按同样
# 方式部署的宿主，与具体机器无关。
#
# 用法
# ----
#   sudo ./harden-dormice-host.sh              # 应用加固（需 root）
#   ./harden-dormice-host.sh --dry-run         # 只打印将要执行的命令（不需 root）
#   ./harden-dormice-host.sh --help
#
# 环境变量
#   DORMICE_DAEMON_PORT   要保护的 daemon 控制端口，默认 3676
#   DORMICE_DOCKER_IF     沙箱容器所在网桥的网卡名，默认 docker0
#   DORMICE_IPTABLES_BIN  iptables 可执行文件，默认 iptables（v4；见下方 IPv6 说明）
#   DORMICE_RULE_COMMENT  写进规则的 comment，置空则不加 -m comment
#
# 退出码
#   0 加固成功（或 --dry-run 打印完毕）
#   1 参数错误 / 非 root / iptables 不可用 / 规则写入失败
#
# 已知边界
#   仅处理 IPv4。Docker 默认不给 docker0 分配 IPv6，若宿主开启了 IPv6 容器网络，
#   需以 DORMICE_IPTABLES_BIN=ip6tables 再跑一次（规则形态相同）。

set -euo pipefail

DORMICE_DAEMON_PORT="${DORMICE_DAEMON_PORT:-3676}"
DORMICE_DOCKER_IF="${DORMICE_DOCKER_IF:-docker0}"
DORMICE_IPTABLES_BIN="${DORMICE_IPTABLES_BIN:-iptables}"
DORMICE_RULE_COMMENT="${DORMICE_RULE_COMMENT:-qianmo-p0.7 block sandbox to host dormice daemon}"

DRY_RUN=0

usage() {
  cat <<'EOF'
harden-dormice-host.sh —— 幂等的宿主防火墙加固：禁止沙箱容器访问宿主上的
Dormice daemon 控制端口。规则同时挂 INPUT（真正生效）与 DOCKER-USER（纵深
冗余）；理由与实测证据链见本文件头部注释。

用法: harden-dormice-host.sh [--dry-run] [--help]
  --dry-run   只打印将要执行的 iptables 命令，不改任何规则，不需要 root

环境变量:
  DORMICE_DAEMON_PORT   要保护的 daemon 控制端口，默认 3676
  DORMICE_DOCKER_IF     沙箱容器所在网桥的网卡名，默认 docker0
  DORMICE_IPTABLES_BIN  iptables 可执行文件，默认 iptables
  DORMICE_RULE_COMMENT  写进规则的 comment，置空则不加 -m comment
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      printf 'harden-dormice-host: 未知参数: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

log() { printf 'harden-dormice-host: %s\n' "$*"; }
die() {
  printf 'harden-dormice-host: %s\n' "$*" >&2
  exit 1
}

case "$DORMICE_DAEMON_PORT" in
  '' | *[!0-9]*) die "DORMICE_DAEMON_PORT 必须是数字，实际为 '${DORMICE_DAEMON_PORT}'" ;;
esac

# 规则本体。两条链用完全相同的匹配条件，差别只在挂哪条链上。
rule_args=(-i "$DORMICE_DOCKER_IF" -p tcp --dport "$DORMICE_DAEMON_PORT")
if [ -n "$DORMICE_RULE_COMMENT" ]; then
  rule_args+=(-m comment --comment "$DORMICE_RULE_COMMENT")
fi
rule_args+=(-j DROP)

# ensure_rule <chain> —— 幂等地把规则放到 <chain> 的链首。
#
# 先删后插而不是"不存在才插"：只判存在会在规则已被别人挪到链尾、或前面已有
# ACCEPT 抢先命中时留下一条永远不生效的规则。删除循环带上限，避免 iptables -D
# 因权限等原因静默失败时死循环。
ensure_rule() {
  local chain="$1"
  local removed

  if [ "$DRY_RUN" -eq 1 ]; then
    # 用 %q 逐个转义，打印出来的命令可以直接复制执行（comment 里有空格）。
    local quoted=''
    local arg
    for arg in "${rule_args[@]}"; do
      quoted="${quoted} $(printf '%q' "$arg")"
    done
    printf '+ %s -D %s%s   # 先删同规则（幂等，重复执行不累积）\n' \
      "$DORMICE_IPTABLES_BIN" "$chain" "$quoted"
    printf '+ %s -I %s 1%s   # 再插链首（不能插链尾：前面的 ACCEPT 会先命中）\n' \
      "$DORMICE_IPTABLES_BIN" "$chain" "$quoted"
    return 0
  fi

  removed=0
  while [ "$removed" -lt 20 ] && "$DORMICE_IPTABLES_BIN" -C "$chain" "${rule_args[@]}" >/dev/null 2>&1; do
    "$DORMICE_IPTABLES_BIN" -D "$chain" "${rule_args[@]}" ||
      die "无法从 $chain 删除既有规则（iptables -D 失败）"
    removed=$((removed + 1))
  done
  if [ "$removed" -ge 20 ]; then
    die "$chain 上同规则删除超过 20 次仍存在，疑似 iptables -D 未真正生效，已中止"
  fi

  "$DORMICE_IPTABLES_BIN" -I "$chain" 1 "${rule_args[@]}" ||
    die "无法向 $chain 插入规则（iptables -I 失败）"

  if [ "$removed" -gt 0 ]; then
    log "$chain: 已清理 $removed 条同规则并重新插入链首"
  else
    log "$chain: 规则已插入链首"
  fi
}

if [ "$DRY_RUN" -eq 0 ]; then
  [ "$(id -u)" -eq 0 ] || die '需要 root 权限（改 iptables）。请用 sudo 执行，或加 --dry-run 预览。'
  command -v "$DORMICE_IPTABLES_BIN" >/dev/null 2>&1 ||
    die "找不到 $DORMICE_IPTABLES_BIN"
fi

log "保护端口 ${DORMICE_DAEMON_PORT}，来源网卡 ${DORMICE_DOCKER_IF}"

# ① INPUT —— 真正生效的那条。容器 → 宿主本机端口的流量只经过这里。
ensure_rule INPUT

# ② DOCKER-USER —— 纵深冗余。对"容器 → 宿主本机端口"无效（已实测），保留是因为
#    它覆盖另一类路径：经 FORWARD 的容器间 / 容器出站流量。docker 重启会重建这条
#    链并清空其中的规则，所以配套的 systemd unit 必须绑 docker 的生命周期。
if [ "$DRY_RUN" -eq 1 ]; then
  ensure_rule DOCKER-USER
elif "$DORMICE_IPTABLES_BIN" -S DOCKER-USER >/dev/null 2>&1; then
  ensure_rule DOCKER-USER
else
  log '跳过 DOCKER-USER：该链不存在（docker 未运行？）。INPUT 上的规则已生效，纵深层缺失。'
fi

if [ "$DRY_RUN" -eq 1 ]; then
  log '--dry-run：以上命令未执行'
  exit 0
fi

log '当前生效的相关规则：'
for chain in INPUT DOCKER-USER; do
  "$DORMICE_IPTABLES_BIN" -S "$chain" 2>/dev/null |
    grep -- "--dport ${DORMICE_DAEMON_PORT}" |
    sed "s/^/  [${chain}] /" || true
done

log '加固完成。验证方式见同目录 README.md（从沙箱内探测应为 TIMEOUT 而非 ECONNREFUSED）。'
