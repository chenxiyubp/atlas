#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P4.4 / AC-6(b)(c) 一键复现：删库可恢复，备份删不掉。
#
#   (b) 造一个真 git 工作区（已提交 / 已暂存 / 未暂存 / 未跟踪 / 可执行位五种状态），
#       用**只写凭据**经 HTTP 面存快照，`rm -rf` 整个工作区，再由宿主侧凭据取回并
#       解包，比对 `git status --porcelain` 与 `HEAD`，并检查耗时在 10 min 预算内；
#   (c) 拿只写凭据去 DELETE / PUT / PATCH 快照，以及去列表、去读取——逐一被拒且留痕，
#       快照仍在。
#
# 工作区**由脚本自己在临时目录里新建**，不接受外部路径：一个会对操作员给的路径执行
# `rm -rf` 的演示脚本，本身就是事故。
#
# 需要 git 与 tar；不需要沙箱与 daemon。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"

required=(
  QIANMO_BACKUP_WRITE_TOKEN
  QIANMO_BACKUP_ARCHIVE_TOKEN
)
for name in "${required[@]}"; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf 'ac6b-restore: missing required environment variable %s\n' "$name" >&2
    exit 2
  fi
done

for tool in bun git tar; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'ac6b-restore: %s is not in PATH\n' "$tool" >&2
    exit 2
  }
done

cd "$REPO_DIR"
bun run "$(demo_entry ac6b-restore)"
