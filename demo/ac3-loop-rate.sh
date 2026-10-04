#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P4.2 / AC-3 一键复现：防循环与两层限流。
#
# 四个场景各起一对全新节点，跑在真 transport（unix socket）上：
#   ① A→B→A 回环在首次回访同一处理者地址 + 同一任务标识时被切断，
#      发送方收到 error(E_LOOP)，并留下 1 条带完整消息链的 loop_detected 审计事件；
#   ② 反向用例：同一节点因不同目标地址被再次经过，正常投递、不判环；
#   ③ 运行时层令牌桶：第 21 条被本地拒（E_RUNTIME_THROTTLED，不上线），换目标即放行；
#   ④ 协议层入站预算：按 LIMITS.ratePerMinute 在接收节点拒（E_RATE_LIMITED），
#      发送方换多个 agent 名字也不多拿配额（这一层按发送节点计）。判据带着突发
#      用时算「顶」（桶是连续补充的），慢机器上不判红、也不放宽。
#
# 不需要沙箱、不需要 daemon，只需要一把 PSK（与其他 demo 同一注入口）。
# 报告是一行 JSON，退出码即结论。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"

if [ -z "${QIANMO_TRANSPORT_PSK:-}" ]; then
  printf 'ac3-loop-rate: missing required environment variable QIANMO_TRANSPORT_PSK\n' >&2
  exit 2
fi

command -v bun >/dev/null 2>&1 || {
  printf 'ac3-loop-rate: bun is not in PATH\n' >&2
  exit 2
}

cd "$REPO_DIR"
bun run "$(demo_entry ac3-loop-rate)"
