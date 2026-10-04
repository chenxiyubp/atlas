#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P8.1 —— 演示环境自检：拓扑真的能用吗。
#
#   demo/env/smoke.sh              # 解析 + 拨号 + 审计链
#   demo/env/smoke.sh --with-task  # 再加一条真消息，等 ack
#   demo/env/smoke.sh --with-ac3   # 再跑一遍 AC-3 的一键复现（本地腿，最快的那个 AC）
#
# 三步各自证什么：
#   ① 按名解析 + 真拨号（demo/lib/p81-probe.ts）—— 注册中心、两个节点、PSK 都对；
#   ② 每个节点的审计链完好（`occ audit --verify`，按配置根各查各的）；
#   ③ `--with-task`：目标节点把消息收进输入并回 ack。
#      **它不等 task.result** —— 结果要跑一个真 ACP turn，那需要模型凭据；
#      演示环境的自检不该把「没配凭据」报成「拓扑坏了」。
#
# 退出码即结论。

set -euo pipefail

# shellcheck source=demo/env/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

WITH_TASK=0
WITH_AC3=0
for option in "$@"; do
  case "$option" in
    --with-task) WITH_TASK=1 ;;
    --with-ac3) WITH_AC3=1 ;;
    -h|--help)
      demo_say '用法：smoke.sh [--with-task] [--with-ac3]'
      exit 0
      ;;
    *) demo_die "未知参数 $option" ;;
  esac
done

STARTED_AT="$(demo_now)"
demo_require_marker
demo_require_occ
demo_export_common
[ -n "${QIANMO_TRANSPORT_PSK:-}" ] || demo_die '缺 QIANMO_TRANSPORT_PSK —— 先跑 demo/env/seed.sh'
cd "$REPO_DIR"

FAIL=0

demo_head '① 按名解析 + 拨号'
probe_args=(
  --registry "$DEMO_REGISTRY_URL"
  --expect "$DEMO_ADDR_A"
  --expect "$DEMO_ADDR_B"
  --from-node "$DEMO_NODE_A"
  --from-agent "$DEMO_AGENT_A"
)
if [ "$WITH_TASK" = '1' ]; then
  probe_args+=(--task "$DEMO_ADDR_B")
fi
if bun run "$(demo_entry p81-probe)" "${probe_args[@]}"; then
  demo_ok 'probe 通过'
else
  demo_say 'probe 未通过（上面那行 JSON 里 pass=false）'
  FAIL=1
fi

demo_head '② 审计链'
# 一个配置根一条链。两个节点共用配置根会让这一步必然报断链——那是拓扑搭错，
# 不是有人改了审计文件（理由见 demo/env/common.sh 头注）。
verify_trail() {
  local node="$1" config_dir="$2"
  demo_say "--- $node ---"
  if OCC_CONFIG_DIR="$config_dir" bun "$DEMO_OCC" audit --verify; then
    demo_ok "$node 审计链完好"
  else
    demo_say "$node 审计链有问题"
    FAIL=1
  fi
}
verify_trail "$DEMO_NODE_A" "$DEMO_CONFIG_A"
verify_trail "$DEMO_NODE_B" "$DEMO_CONFIG_B"

if [ "$WITH_AC3" = '1' ]; then
  demo_head '③ AC-3 一键复现'
  # ac3 自带一对全新节点（它不用本拓扑），跑它是为了证明这台机器上「阡陌的代码本身」
  # 是好的——与拓扑是否搭对相互独立，两边都绿才说明环境完整。
  if "$REPO_DIR/demo/ac3-loop-rate.sh"; then
    demo_ok 'AC-3 通过'
  else
    demo_say 'AC-3 未通过'
    FAIL=1
  fi
fi

demo_head "自检结束，耗时 $(demo_elapsed "$STARTED_AT")"
if [ "$FAIL" = '0' ]; then
  demo_say '结论 : PASS'
  exit 0
fi
demo_say '结论 : FAIL（见上）'
exit 1
