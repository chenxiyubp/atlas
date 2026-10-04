#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P8.1 —— 种子数据：把演示环境铺成「随时可以起节点」的初始态。
#
#   demo/env/seed.sh
#
# 铺五样东西，全都在 DEMO_ROOT 里（默认 <repo>/.demo-env）：
#   ① 目录骨架 + 标记文件 —— 标记文件是一键重置的安全依据，没有它 reset.sh 拒绝动手；
#   ② 演示专用密钥：传输层 PSK、备份的只写/只读两把凭据（0600，不进仓库）；
#   ③ 两个节点各自的**空配置根** —— 节点身份与审计链会长在里面（首次起节点时生成）；
#   ④ 两个节点的工作区（各是一个真 git 仓库，AC-6(b) 的恢复演示要的就是这个形状）；
#   ⑤ AC-7 的数据集（`demo/lib/p61-seed.ts`，seed 6101，与 demo/Makefile 同一条命令）。
#
# **幂等**：已存在的密钥不会被换掉（换了 PSK 就等于把已经起着的节点踢下线），
# 已存在的工作区不会被重建。要回到干净种子态用 `demo/env/reset.sh`。

set -euo pipefail

# shellcheck source=demo/env/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

P61_SEED="${QIANMO_DEMO_P61_SEED:-6101}"

STARTED_AT="$(demo_now)"
demo_guard_root "$DEMO_ROOT"
cd "$REPO_DIR"

# ── ① 骨架与标记 ────────────────────────────────────────────────────────────
demo_head "① 目录骨架：$DEMO_ROOT"
mkdir -p "$DEMO_ROOT"
chmod 700 "$DEMO_ROOT"
mkdir -p "$DEMO_RUN_DIR" "$DEMO_LOG_DIR" "$DEMO_STATE_DIR" \
  "$DEMO_WORKSPACE_DIR" "$DEMO_CONFIG_A" "$DEMO_CONFIG_B" "$DEMO_CONFIG_REGISTRY"
mkdir -p "$DEMO_SECRET_DIR"
chmod 700 "$DEMO_SECRET_DIR" "$DEMO_CONFIG_A" "$DEMO_CONFIG_B" "$DEMO_CONFIG_REGISTRY"

if [ ! -f "$DEMO_MARKER" ]; then
  {
    printf '%s\n' "$DEMO_MARKER_MAGIC"
    printf 'created-at=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    printf 'repo=%s\n' "$REPO_DIR"
    printf '# 这个文件是 demo/env/reset.sh 的安全依据：没有它，reset 拒绝删除任何东西。\n'
  } >"$DEMO_MARKER"
  chmod 600 "$DEMO_MARKER"
  demo_ok "标记文件已建：$DEMO_MARKER"
else
  demo_ok "标记文件已在：$DEMO_MARKER"
fi

# ── ② 演示专用密钥 ──────────────────────────────────────────────────────────
demo_head '② 演示专用密钥'
# 它们是**本机现生成的演示凭据**，不是任何真实系统的密钥，也不进仓库
# （`.demo-env/` 已在 .gitignore 里）。脚本只写文件、不回显内容。
seed_secret() {
  local file="$1" what="$2"
  if [ -s "$file" ]; then
    demo_ok "$what 已存在，保持不动"
    return 0
  fi
  demo_random_hex 32 >"$file"
  chmod 600 "$file"
  demo_ok "$what 已生成（0600，不回显）"
}
seed_secret "$DEMO_PSK_FILE" '传输层 PSK'
seed_secret "$DEMO_BACKUP_WRITE_FILE" '备份只写凭据'
seed_secret "$DEMO_BACKUP_ARCHIVE_FILE" '备份归档凭据'

# ── ③ 节点工作区 ────────────────────────────────────────────────────────────
demo_head '③ 节点工作区'
seed_workspace() {
  local dir="$1" node="$2"
  if [ -d "$dir/.git" ]; then
    demo_ok "$node 工作区已存在：$dir"
    return 0
  fi
  mkdir -p "$dir"
  # 提交身份走 -c，不依赖跑这条命令的人配过 git 全局身份（全新机器上常常没配）。
  git -C "$dir" init -q
  {
    printf '# %s 演示工作区\n\n' "$node"
    printf '阡陌 P8.1 演示环境的节点工作区，由 demo/env/seed.sh 生成。\n'
    printf '常驻节点以它为 --agent 的 cwd；AC-6(b) 的删库恢复演示也以这类工作区为对象。\n'
  } >"$dir/NOTES.md"
  git -C "$dir" add NOTES.md
  git -C "$dir" -c user.name='Qianmo Demo' -c user.email='demo@example.invalid' \
    commit -q -m 'chore(demo): 演示工作区初始提交'
  demo_ok "$node 工作区已建：$dir"
}
seed_workspace "$DEMO_WORKSPACE_DIR/$DEMO_NODE_A" "$DEMO_NODE_A"
seed_workspace "$DEMO_WORKSPACE_DIR/$DEMO_NODE_B" "$DEMO_NODE_B"

# ── ④ AC-7 数据集 ───────────────────────────────────────────────────────────
demo_head '④ AC-7 数据集'
# 与 `make -C demo p61-reset` 是同一条命令、同一个 seed。数据集是**确定性**的：
# 同一个 seed 重新生成出来逐字节相同，所以这一步不会把仓库弄脏（已实测）。
bun run "$(demo_entry p61-seed)" --reset --seed "$P61_SEED" \
  | tee "$DEMO_STATE_DIR/seed-p61.json"
chmod 600 "$DEMO_STATE_DIR/seed-p61.json"

demo_head "seed 完成，耗时 $(demo_elapsed "$STARTED_AT")"
demo_say "演示根目录 : $DEMO_ROOT"
demo_say "节点配置根 : $DEMO_CONFIG_A"
demo_say "             $DEMO_CONFIG_B"
demo_say '下一步     : demo/env/up.sh'
