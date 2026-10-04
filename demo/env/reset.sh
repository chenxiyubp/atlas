#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P8.1 —— 一键重置：停机 → 清运行态 → 重新铺种子。
#
#   demo/env/reset.sh                 # 保留演示密钥（PSK / 备份凭据）
#   demo/env/reset.sh --rotate-secrets  # 连密钥一起换新
#
# ── 它敢删东西的全部依据 ────────────────────────────────────────────────────
# 删除**只发生在 DEMO_ROOT 下面**，而且必须同时满足三条，缺一条就退出：
#   ① DEMO_ROOT 通过 common.sh 的 demo_guard_root（不是 /、家目录、仓库根，
#      也不在任何真实配置根 ~/.occ / ~/.qianmo / ~/.claude 里面）；
#   ② DEMO_ROOT 下有标记文件 .qianmo-demo-env，且首行是我们写的那一行；
#   ③ 要删的每一个路径都在 DEMO_ROOT 之内（逐个复核，不信任变量拼接的结果）。
#
# 「重置」重置到哪：节点的配置根（身份、审计链、会话表）、工作区、运行态与日志全部
# 重来；演示密钥默认保留——换 PSK 相当于把还连着的对端全部踢下线，那是另一件事，
# 要做就显式 --rotate-secrets。

set -euo pipefail

# shellcheck source=demo/env/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

ROTATE_SECRETS=0
for option in "$@"; do
  case "$option" in
    --rotate-secrets) ROTATE_SECRETS=1 ;;
    -h|--help)
      demo_say '用法：reset.sh [--rotate-secrets]'
      exit 0
      ;;
    *) demo_die "未知参数 $option" ;;
  esac
done

STARTED_AT="$(demo_now)"
demo_require_marker

# 逐个复核「这个路径确实在 DEMO_ROOT 里面」。守卫写在删除动作旁边，而不是只写在
# 脚本开头——中间任何一次变量赋值出错，这里都还能拦住。
purge() {
  local target="$1"
  case "$target" in
    "$DEMO_ROOT"/*) ;;
    *) demo_die "拒绝删除 DEMO_ROOT 之外的路径：$target" ;;
  esac
  case "$target" in
    *..*) demo_die "路径里有 ..，拒绝：$target" ;;
  esac
  [ -e "$target" ] || return 0
  rm -rf "$target"
  demo_say "已清除 $target"
}

demo_head '① 停机'
"$QIANMO_DEMO_ENV_DIR/down.sh"

demo_head '② 清除运行态与节点状态'
purge "$DEMO_RUN_DIR"
purge "$DEMO_LOG_DIR"
purge "$DEMO_STATE_DIR"
purge "$DEMO_NODES_DIR"
purge "$DEMO_WORKSPACE_DIR"
if [ "$ROTATE_SECRETS" = '1' ]; then
  purge "$DEMO_SECRET_DIR"
  demo_warn '演示密钥已清除，下一步会生成新的——已经拿着旧 PSK 的对端需要重新取'
else
  demo_say "保留 ${DEMO_SECRET_DIR}（要换用 --rotate-secrets）"
fi

demo_head '③ 重新铺种子'
"$QIANMO_DEMO_ENV_DIR/seed.sh"

demo_head "重置完成，耗时 $(demo_elapsed "$STARTED_AT")"
demo_say '下一步 : demo/env/up.sh'
