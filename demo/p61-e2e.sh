#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"

if [ -z "${QIANMO_TRANSPORT_PSK:-}" ]; then
  printf 'p61-e2e: missing required environment variable QIANMO_TRANSPORT_PSK\n' >&2
  exit 2
fi

for tool in bun node; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'p61-e2e: %s is not in PATH\n' "$tool" >&2
    exit 2
  }
done

cd "$REPO_DIR"
exec bun run "$(demo_entry p61-scenario)" "$@"
