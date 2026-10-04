#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P8.1 —— 起本地演示拓扑：一台机器上的两个逻辑节点 + 一个注册中心。
#
#   demo/env/up.sh
#
#   注册中心 :  http://127.0.0.1:38610          （@qianmo/registry，HTTP v0）
#   节点 A   :  ws://127.0.0.1:38611            （occ resident，qianmo://node-a/planner）
#   节点 B   :  ws://127.0.0.1:38612            （occ resident，qianmo://node-b/reviewer）
#
# 「两个逻辑节点」是**两个真进程、两个配置根、两条审计链、两把节点身份**，只是共用
# 一台机器。要摊到两台机器上，改 common.sh 里的 DEMO_HOST / 端口，把对端的 endpoint
# 换成对端地址即可——脚本没有任何「同机」假设，除了默认值绑在回环上。
#
# 全部状态在 DEMO_ROOT 下（默认 <repo>/.demo-env）。**不碰用户真实的 ~/.occ / ~/.qianmo。**
# 停机用 down.sh，回到种子态用 reset.sh。

set -euo pipefail

# shellcheck source=demo/env/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

READY_TIMEOUT_S="${QIANMO_DEMO_READY_TIMEOUT_S:-60}"

STARTED_AT="$(demo_now)"
demo_require_marker
demo_require_occ
demo_export_common
[ -n "${QIANMO_TRANSPORT_PSK:-}" ] || demo_die "缺 QIANMO_TRANSPORT_PSK，且 $DEMO_PSK_FILE 不存在 —— 先跑 demo/env/seed.sh"

cd "$REPO_DIR"
mkdir -p "$DEMO_RUN_DIR" "$DEMO_LOG_DIR" "$DEMO_STATE_DIR"

REGISTRY_READY="$DEMO_RUN_DIR/registry-ready.json"

# demo_start <名字> <环境:配置根> -- <命令...>
# 起一个后台进程，pid 落 run/，stdout/stderr 落 logs/。
start_process() {
  local name="$1" config_dir="$2"
  shift 2
  if demo_running "$name"; then
    demo_ok "$name 已在运行（pid $(cat "$(demo_pidfile "$name")")）"
    return 0
  fi
  local out err
  out="$(demo_logfile "$name" out)"
  err="$(demo_logfile "$name" err)"
  # 每个进程一个配置根：审计链、节点身份、会话表都按配置根分家（见 common.sh 头注）。
  OCC_CONFIG_DIR="$config_dir" nohup "$@" >"$out" 2>"$err" &
  local pid=$!
  printf '%s\n' "$pid" >"$(demo_pidfile "$name")"
  demo_ok "$name 已启动（pid ${pid}，日志 ${out}）"
}

# 进程死了就把它的错误摊开来，不要只说一句「没起来」。
dump_if_dead() {
  local name="$1"
  demo_running "$name" && return 0
  demo_say "--- $name stderr 末尾 ---"
  tail -20 "$(demo_logfile "$name" err)" 2>/dev/null || true
  demo_say "--- $name stdout 末尾 ---"
  tail -20 "$(demo_logfile "$name" out)" 2>/dev/null || true
  demo_die "$name 未能保持运行"
}

demo_head '① 注册中心'
rm -f "$REGISTRY_READY"
start_process registry "$DEMO_CONFIG_REGISTRY" \
  bun run "$(demo_entry p81-registry)" \
  --ready "$REGISTRY_READY" \
  --port "$DEMO_REGISTRY_PORT" \
  --host "$DEMO_HOST" \
  --state "$DEMO_STATE_DIR/registry-agents.json" \
  --register "${DEMO_ADDR_A}=${DEMO_ENDPOINT_A}" \
  --register "${DEMO_ADDR_B}=${DEMO_ENDPOINT_B}"

i=0
while [ ! -s "$REGISTRY_READY" ] && [ "$i" -lt 30 ]; do
  sleep 1
  i=$((i + 1))
  dump_if_dead registry
done
[ -s "$REGISTRY_READY" ] || demo_die '注册中心 30 s 内没有写出 ready 文件'
demo_ok "注册中心就绪：$DEMO_REGISTRY_URL"

demo_head '② 两个常驻节点'
start_resident() {
  local name="$1" node="$2" agent="$3" port="$4" config_dir="$5"
  start_process "$name" "$config_dir" \
    bun "$DEMO_OCC" resident \
    --node "$node" \
    --team "$DEMO_TEAM" \
    --agent "${agent}=${DEMO_WORKSPACE_DIR}/${node}" \
    --port "$port" \
    --hostname "$DEMO_HOST" \
    --open-policy \
    --audit-signed-tasks \
    --timings "$DEMO_STATE_DIR/${node}-timings.jsonl"
}
# `--open-policy` 是显式的逃生开关，不是遗留写法（key-distribution.md §9.3）：
# P12.4 把默认切成了 SIGNED_TASK_POLICY，而**这套演示拓扑里没有任何一处签发
# capability 令牌**（demo/lib 里一处都没有），所以强制策略下 ac2 / ac3 / p41 的
# task.request 会被 E_CAP_INSUFFICIENT 全部拒掉。那正是 §9.1 的 S-3 目前不成立的
# 原因，也是探针脚本对 S-3 如实报「未采集」时写出的那条已知阻塞项。
#
# `--audit-signed-tasks` 与它成对：策略退回开放，同时把「切回去会拒掉多少条」
# 逐条记进审计链（§9.2 阶段 ①）——演示环境因此正好是那个计数最该被看的地方。
start_resident "$DEMO_NODE_A" "$DEMO_NODE_A" "$DEMO_AGENT_A" "$DEMO_PORT_A" "$DEMO_CONFIG_A"
start_resident "$DEMO_NODE_B" "$DEMO_NODE_B" "$DEMO_AGENT_B" "$DEMO_PORT_B" "$DEMO_CONFIG_B"

demo_head '③ 就绪探测'
# 就绪的定义不是「进程还在」，而是「按名解析得到，并且拨得通」——后者才是拓扑成立。
# 探测器本身就是 P8.2 每次开演前该跑的那一条（demo/lib/p81-probe.ts）。
PROBE_OUT="$DEMO_STATE_DIR/probe.json"
i=0
probe_ok=0
while [ "$i" -lt "$READY_TIMEOUT_S" ]; do
  dump_if_dead "$DEMO_NODE_A"
  dump_if_dead "$DEMO_NODE_B"
  if bun run "$(demo_entry p81-probe)" \
    --registry "$DEMO_REGISTRY_URL" \
    --expect "$DEMO_ADDR_A" \
    --expect "$DEMO_ADDR_B" \
    --from-node "$DEMO_NODE_A" \
    --from-agent "$DEMO_AGENT_A" >"$PROBE_OUT" 2>/dev/null; then
    probe_ok=1
    break
  fi
  sleep 2
  i=$((i + 2))
done
cat "$PROBE_OUT" 2>/dev/null || true
[ "$probe_ok" = '1' ] || demo_die "拓扑在 ${READY_TIMEOUT_S}s 内未就绪（详见上面的 probe 输出与 ${DEMO_LOG_DIR}）"

# 拓扑快照：谁在哪、公钥是什么。P4.3 的 --trust 要的就是这些公钥。
{
  printf '{"schema":"qianmo.p81.topology.v1"'
  printf ',"registry":"%s"' "$DEMO_REGISTRY_URL"
  printf ',"nodes":[{"node":"%s","address":"%s","endpoint":"%s","configDir":"%s"}' \
    "$DEMO_NODE_A" "$DEMO_ADDR_A" "$DEMO_ENDPOINT_A" "$DEMO_CONFIG_A"
  printf ',{"node":"%s","address":"%s","endpoint":"%s","configDir":"%s"}]}\n' \
    "$DEMO_NODE_B" "$DEMO_ADDR_B" "$DEMO_ENDPOINT_B" "$DEMO_CONFIG_B"
} >"$DEMO_STATE_DIR/topology.json"

demo_head "拓扑就绪，耗时 $(demo_elapsed "$STARTED_AT")"
demo_say "注册中心 : $DEMO_REGISTRY_URL"
demo_say "节点 A   : $DEMO_ADDR_A → $DEMO_ENDPOINT_A"
demo_say "节点 B   : $DEMO_ADDR_B → $DEMO_ENDPOINT_B"
demo_say "节点公钥 : $(grep -h publicKey "$(demo_logfile "$DEMO_NODE_A" out)" "$(demo_logfile "$DEMO_NODE_B" out)" | tr '\n' ' ')"
demo_say ''
demo_say '下一步   : demo/env/smoke.sh（自检） / demo/env/down.sh（停机）'
