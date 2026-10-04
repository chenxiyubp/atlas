#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P4.1 / AC-2 一键复现：跨节点任务消息端到端。
#
# 每一轮都从「目标沙箱确认为 frozen」开始，然后节点 A 发一条 task.request，
# 在同一条已认证连接上等 ack 与 task.result。judgement 三条：
#   成功率 10/10、ack P95 ≤ 60 s、result 每轮 ≤ 5 min。
#
# 前提：常驻 occ 已经跑在目标沙箱里（--port 与 QIANMO_AC2_TARGET_URL 对应），
# 且它的 activity 上报指向本脚本起的 activity 端口。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"

required=(
  QIANMO_SANDBOX_DAEMON_URL
  QIANMO_SANDBOX_DAEMON_TOKEN
  QIANMO_TRANSPORT_PSK
  QIANMO_AC2_SANDBOX
  QIANMO_AC2_TARGET_URL
  QIANMO_P41_ACTIVITY_PORT
  QIANMO_P41_FREEZE_AFTER_SECONDS
  QIANMO_P41_STOP_AFTER_SECONDS
)
for name in "${required[@]}"; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf 'p41-task-result: missing required environment variable %s\n' "$name" >&2
    exit 2
  fi
done

command -v bun >/dev/null 2>&1 || {
  printf 'p41-task-result: bun is not in PATH\n' >&2
  exit 2
}

ROUNDS="${P41_ROUNDS:-10}"
FREEZE_WAIT_S="${P41_FREEZE_WAIT_S:-300}"
ACK_LIMIT_MS="${P41_ACK_LIMIT_MS:-60000}"
RESULT_LIMIT_MS="${P41_RESULT_LIMIT_MS:-300000}"
FORWARD_TIMEOUT_MS="${P41_FORWARD_TIMEOUT_MS:-90000}"
KEEPALIVE_TIME_JUMP_FACTOR="${P41_KEEPALIVE_TIME_JUMP_FACTOR:-1.5}"
ACTIVITY_HOST="${QIANMO_P41_ACTIVITY_HOST:-0.0.0.0}"

WORK="${P41_WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/p41-task.XXXXXX")}"
mkdir -p "$WORK"
chmod 700 "$WORK"
READY="$WORK/activator-ready.json"
ACTIVATOR_TIMINGS="$WORK/activator-timings.jsonl"
AUDIT="$WORK/audit.jsonl"
ROUNDS_FILE="$WORK/rounds.jsonl"
REGISTRY_READY="$WORK/registry-ready.json"
: >"$ROUNDS_FILE"
ACTIVATOR_PID=''
REGISTRY_PID=''

cleanup() {
  if [ -n "$REGISTRY_PID" ] && kill -0 "$REGISTRY_PID" 2>/dev/null; then
    kill -TERM "$REGISTRY_PID" 2>/dev/null || true
    wait "$REGISTRY_PID" 2>/dev/null || true
  fi
  if [ -n "$ACTIVATOR_PID" ] && kill -0 "$ACTIVATOR_PID" 2>/dev/null; then
    kill -TERM "$ACTIVATOR_PID" 2>/dev/null || true
    wait "$ACTIVATOR_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

jget() {
  bun -e 'const fs=require("fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(value[process.argv[2]] ?? ""))' "$1" "$2"
}

printf 'P4.1 现场目录：%s\n' "$WORK"
printf '凭据：均已注入，不回显\n'
printf '目标：%s，轮数：%s，ack 上限：%sms，result 上限：%sms\n' \
  "$QIANMO_AC2_SANDBOX" "$ROUNDS" "$ACK_LIMIT_MS" "$RESULT_LIMIT_MS"

bun run "$(demo_entry ac2-activator)" \
  --ready "$READY" \
  --timings "$ACTIVATOR_TIMINGS" \
  --audit "$AUDIT" \
  --ready-timeout-ms 55000 \
  --forward-timeout-ms 15000 \
  --activity-port "$QIANMO_P41_ACTIVITY_PORT" \
  --activity-host "$ACTIVITY_HOST" \
  --freeze-after-seconds "$QIANMO_P41_FREEZE_AFTER_SECONDS" \
  --stop-after-seconds "$QIANMO_P41_STOP_AFTER_SECONDS" \
  --keepalive-time-jump-factor "$KEEPALIVE_TIME_JUMP_FACTOR" \
  ${P41_ACTIVATOR_HOST:+--host "$P41_ACTIVATOR_HOST"} \
  >"$WORK/activator.log" 2>&1 &
ACTIVATOR_PID=$!

for _ in $(seq 1 60); do
  [ -s "$READY" ] && break
  kill -0 "$ACTIVATOR_PID" 2>/dev/null || break
  sleep 0.5
done
if [ ! -s "$READY" ]; then
  printf 'activator failed to start; see %s\n' "$WORK/activator.log" >&2
  exit 2
fi
export QIANMO_AC2_ACTIVATOR_URL="$(jget "$READY" url)"
printf 'activator ready; activity port=%s\n' "$(jget "$READY" activityPort)"

# 按名解析那一跳：目标地址登记到 activator 的入站地址上，发送方只认名字。
bun run "$(demo_entry p41-registry)" \
  --ready "$REGISTRY_READY" \
  --endpoint "$QIANMO_AC2_ACTIVATOR_URL" \
  --port "${P41_REGISTRY_PORT:-0}" \
  >"$WORK/registry.log" 2>&1 &
REGISTRY_PID=$!

for _ in $(seq 1 40); do
  [ -s "$REGISTRY_READY" ] && break
  kill -0 "$REGISTRY_PID" 2>/dev/null || break
  sleep 0.5
done
if [ ! -s "$REGISTRY_READY" ]; then
  printf 'registry failed to start; see %s\n' "$WORK/registry.log" >&2
  exit 2
fi
export QIANMO_P41_REGISTRY_URL="$(jget "$REGISTRY_READY" url)"
printf 'registry ready：%s\n' "$QIANMO_P41_REGISTRY_URL"

pass=0
for round in $(seq 1 "$ROUNDS"); do
  printf '\n[%s/%s] waiting for frozen\n' "$round" "$ROUNDS"
  frozen=false
  if bun run "$(demo_entry ac2-state)" --wait-for frozen --timeout-s "$FREEZE_WAIT_S" \
    >"$WORK/state-$round.json"; then
    frozen=true
  else
    printf 'round %s: sandbox did not reach frozen\n' "$round" >&2
  fi

  set +e
  bun run "$(demo_entry p41-send)" \
    --round "$round" \
    --ack-timeout-ms "$ACK_LIMIT_MS" \
    --result-timeout-ms "$RESULT_LIMIT_MS" \
    --forward-timeout-ms "$FORWARD_TIMEOUT_MS" \
    >"$WORK/send-$round.json" 2>"$WORK/send-$round.err"
  send_rc=$?
  set -e
  if [ ! -s "$WORK/send-$round.json" ]; then
    printf '{"round":%s,"verdict":"send-crashed","msgId":"","taskId":"","sentAt":0}\n' \
      "$round" >"$WORK/send-$round.json"
  fi

  bun -e '
    const fs = require("fs")
    const record = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    record.frozenBefore = process.argv[2] === "true"
    fs.appendFileSync(process.argv[3], `${JSON.stringify(record)}\n`)
    process.stdout.write(String(record.verdict))
  ' "$WORK/send-$round.json" "$frozen" "$ROUNDS_FILE" >"$WORK/verdict-$round.txt"

  verdict="$(cat "$WORK/verdict-$round.txt")"
  if [ "$send_rc" = 0 ] && [ "$frozen" = true ]; then
    pass=$((pass + 1))
    printf 'round %s: %s (ack %sms, result %sms)\n' "$round" "$verdict" \
      "$(jget "$WORK/send-$round.json" sendToAckMs)" \
      "$(jget "$WORK/send-$round.json" sendToResultMs)"
  else
    printf 'round %s: %s\n' "$round" "$verdict" >&2
  fi
done

set +e
bun run "$(demo_entry p41-report)" \
  --rounds-file "$ROUNDS_FILE" \
  --rounds "$ROUNDS" \
  --ack-limit-ms "$ACK_LIMIT_MS" \
  --result-limit-ms "$RESULT_LIMIT_MS" \
  >"$WORK/report.json"
report_rc=$?
set -e
printf '\ncomplete rounds: %s/%s\n' "$pass" "$ROUNDS"
printf 'report: %s\n' "$WORK/report.json"
cat "$WORK/report.json"
exit "$report_rc"
