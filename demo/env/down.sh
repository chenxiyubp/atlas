#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P8.1 —— 停掉本地演示拓扑。**只停进程，不删任何数据。**
#
#   demo/env/down.sh
#
# 停机顺序与 up.sh 相反：先两个节点、后注册中心——反过来的话，节点在最后几秒会对着
# 一个已经没了的注册中心重试，日志里凭空多出一段谁都不需要解释的报错。
#
# 想连数据一起回到种子态，用 demo/env/reset.sh。

set -euo pipefail

# shellcheck source=demo/env/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

demo_require_marker

demo_head '停止节点'
demo_stop_one "$DEMO_NODE_B"
demo_stop_one "$DEMO_NODE_A"

demo_head '停止注册中心'
demo_stop_one registry
rm -f "$DEMO_RUN_DIR/registry-ready.json"

demo_head '已停机'
demo_say "数据仍在 : $DEMO_ROOT"
demo_say '再次启动 : demo/env/up.sh'
