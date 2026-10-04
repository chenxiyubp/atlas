#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P7.1 / AC-8 混沌注入跑批：随机杀进程 / 断网 / 打满磁盘 / 拨动时钟，看系统还能不能干活。
#
#   QIANMO_TRANSPORT_PSK=... ./demo/chaos-inject.sh --minutes 60
#   QIANMO_TRANSPORT_PSK=... ./demo/chaos-inject.sh --minutes 2 --interval-seconds 5   # 冒烟
#   QIANMO_TRANSPORT_PSK=... ./demo/chaos-inject.sh --seed 12345                       # 重放
#
# 判据（`demo/lib/chaos-report-core.ts`）：
#   ① 未捕获异常为 0；
#   ② 四类注入都真的注入过（造不出来的如实记 skipped 并判不通过）；
#   ③ **每次注入之后系统还在干活**——什么都不干的一小时同样没有异常；
#   ④ 每一条被捕获的失败都能对上已知边界，对不上的一条就判不通过；
#   ⑤ 跑完之后审计链完好。
#
# 跑批失败时**保留证据目录**（含审计文件与报告），路径打在 stderr 上。
# 不需要沙箱与 daemon；磁盘注入在 Linux 上用 /dev/full，在 macOS 上用 hdiutil 建的 1 MiB 卷。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"

if [ -z "${QIANMO_TRANSPORT_PSK:-}" ]; then
  printf 'chaos-inject: missing required environment variable QIANMO_TRANSPORT_PSK\n' >&2
  exit 2
fi

command -v bun >/dev/null 2>&1 || {
  printf 'chaos-inject: bun is not in PATH\n' >&2
  exit 2
}

cd "$REPO_DIR"
bun run "$(demo_entry chaos-inject)" "$@"
