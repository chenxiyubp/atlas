#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P11.3 后半 —— 仅宿主操作员运行的数据保留与轮转入口。
#
#   demo/env/beta/beta-retain.sh                         # dry-run（默认）
#   demo/env/beta/beta-retain.sh --apply                 # 执行保留/轮转
#   demo/env/beta/beta-retain.sh --apply --snapshot-registry
#
# 删除与压缩不属于 @qianmo/backup 的入站能力面。这个入口只从 common.sh 派生已知的
# beta 路径，并在把路径交给 Bun helper 前复用根目录 + marker 两道守卫；helper 再逐项
# 复核真实路径、父目录与文件类型，才会碰普通文件。

set -euo pipefail

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

if [ "$#" = '1' ] && { [ "$1" = '-h' ] || [ "$1" = '--help' ]; }; then
  beta_say '用法：beta-retain.sh [--dry-run|--apply] [--snapshot-registry]'
  beta_say '默认 dry-run；只有 --apply 才会压缩、复制或删除。'
  beta_say '--snapshot-registry 仅在升级窗口前请求创建注册表快照；需与 --apply 同用才写入。'
  exit 0
fi

# 在任何可能写入之前复用内测环境既有的两层守卫。逐项目标与 symlink/真实路径复核在
# beta-retain.ts 中完成：Bash 3.2 缺少跨 macOS/Linux 一致的 lstat/UTC 日期工具。
beta_require_marker

command -v bun >/dev/null 2>&1 || beta_die '找不到 bun；宿主侧保留工具需要 Bun'

exec env \
  BETA_RETAIN_ROOT="$BETA_ROOT" \
  BETA_RETAIN_RUN_DIR="$BETA_RUN_DIR" \
  BETA_RETAIN_LOG_DIR="$BETA_LOG_DIR" \
  BETA_RETAIN_BACKUP_STORE="$BETA_BACKUP_STORE" \
  BETA_RETAIN_REGISTRY_STATE="$BETA_REGISTRY_STATE" \
  BETA_RETAIN_REGISTRY_SNAPSHOT_DIR="$BETA_REGISTRY_SNAPSHOT_DIR" \
  BETA_RETAIN_NODES_DIR="$BETA_NODES_DIR" \
  bun "$QIANMO_BETA_ENV_DIR/beta-retain.ts" "$@"
