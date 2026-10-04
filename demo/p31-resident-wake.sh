#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P3.1 gVisor benchmark. The resident process must already be running inside the
# target sandbox with --timings pointing to QIANMO_P31_RESIDENT_TIMINGS_PATH and
# --activity-url pointing to the host-reachable activity listener below.

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
  QIANMO_P31_ACTIVITY_PORT
  QIANMO_P31_FREEZE_AFTER_SECONDS
  QIANMO_P31_STOP_AFTER_SECONDS
  QIANMO_P31_RESIDENT_TIMINGS_PATH
)
for name in "${required[@]}"; do
  eval "value=\${$name:-}"
  if [ -z "$value" ]; then
    printf 'p31-resident-wake: missing required environment variable %s\n' "$name" >&2
    exit 2
  fi
done

command -v bun >/dev/null 2>&1 || {
  printf 'p31-resident-wake: bun is not in PATH\n' >&2
  exit 2
}
command -v docker >/dev/null 2>&1 || {
  printf 'p31-resident-wake: docker is not in PATH\n' >&2
  exit 2
}

ROUNDS="${P31_ROUNDS:-10}"
FREEZE_WAIT_S="${P31_FREEZE_WAIT_S:-300}"
ROUND_TIMEOUT_S="${P31_ROUND_TIMEOUT_S:-120}"
LATENCY_LIMIT_MS="${P31_LATENCY_LIMIT_MS:-60000}"
ACTIVITY_HOST="${QIANMO_P31_ACTIVITY_HOST:-0.0.0.0}"
KEEPALIVE_TIME_JUMP_FACTOR="${P31_KEEPALIVE_TIME_JUMP_FACTOR:-2}"
RESIDENT_RECONNECT_FACTOR="${P31_RESIDENT_RECONNECT_FACTOR:-2}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/p31-resident.XXXXXX")"
READY="$WORK/activator-ready.json"
ACTIVATOR_TIMINGS="$WORK/activator-timings.jsonl"
RESIDENT_TIMINGS="$WORK/resident-timings.jsonl"
PREFLIGHT_RESIDENT_TIMINGS="$WORK/resident-preflight.jsonl"
AUDIT="$WORK/audit.jsonl"
ACTIVATOR_PID=''
TIMING_WATCHER_PID=''

cleanup() {
  if [ -n "$TIMING_WATCHER_PID" ] && kill -0 "$TIMING_WATCHER_PID" 2>/dev/null; then
    kill -TERM "$TIMING_WATCHER_PID" 2>/dev/null || true
    wait "$TIMING_WATCHER_PID" 2>/dev/null || true
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

printf 'P3.1 现场目录：%s\n' "$WORK"
printf '凭据：均已注入，不回显\n'
printf '目标：%s，轮数：%s，P95 上限：%sms\n' "$QIANMO_AC2_SANDBOX" "$ROUNDS" "$LATENCY_LIMIT_MS"
printf 'A/B factor：resident reconnect=%s，host keepalive=%s\n' "$RESIDENT_RECONNECT_FACTOR" "$KEEPALIVE_TIME_JUMP_FACTOR"

bun run "$(demo_entry p31-copy-resident-timings)" \
  --container-path "$QIANMO_P31_RESIDENT_TIMINGS_PATH" \
  --output "$PREFLIGHT_RESIDENT_TIMINGS" >"$WORK/preflight-copy.json"
: >"$RESIDENT_TIMINGS"

bun run "$(demo_entry ac2-activator)" \
  --ready "$READY" \
  --timings "$ACTIVATOR_TIMINGS" \
  --audit "$AUDIT" \
  --ready-timeout-ms 55000 \
  --forward-timeout-ms 15000 \
  --activity-port "$QIANMO_P31_ACTIVITY_PORT" \
  --activity-host "$ACTIVITY_HOST" \
  --freeze-after-seconds "$QIANMO_P31_FREEZE_AFTER_SECONDS" \
  --stop-after-seconds "$QIANMO_P31_STOP_AFTER_SECONDS" \
  --keepalive-time-jump-factor "$KEEPALIVE_TIME_JUMP_FACTOR" \
  ${P31_ACTIVATOR_HOST:+--host "$P31_ACTIVATOR_HOST"} \
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
ACTUAL_KEEPALIVE_FACTOR="$(jget "$READY" keepaliveTimeJumpFactor)"
printf 'activator ready; activity port=%s\n' "$(jget "$READY" activityPort)"

bun run "$(demo_entry p31-copy-resident-timings)" \
  --container-path "$QIANMO_P31_RESIDENT_TIMINGS_PATH" \
  --output "$PREFLIGHT_RESIDENT_TIMINGS" >/dev/null
if ! bun run "$(demo_entry p31-report)" \
  --activator-timings "$ACTIVATOR_TIMINGS" \
  --resident-timings "$PREFLIGHT_RESIDENT_TIMINGS" \
  --rounds "$ROUNDS" \
  --latency-limit-ms "$LATENCY_LIMIT_MS" \
  --expected-resident-reconnect-factor "$RESIDENT_RECONNECT_FACTOR" \
  --expected-keepalive-time-jump-factor "$KEEPALIVE_TIME_JUMP_FACTOR" \
  --keepalive-time-jump-factor "$ACTUAL_KEEPALIVE_FACTOR" \
  --check-factors yes >"$WORK/factor-preflight.json"; then
  printf 'factor preflight failed: %s\n' "$(cat "$WORK/factor-preflight.json")" >&2
  exit 2
fi

bun run "$(demo_entry p31-copy-resident-timings)" \
  --container-path "$QIANMO_P31_RESIDENT_TIMINGS_PATH" \
  --output "$RESIDENT_TIMINGS" \
  --interval-ms 1000 >"$WORK/timing-watcher.log" 2>&1 &
TIMING_WATCHER_PID=$!

pass=0
for round in $(seq 1 "$ROUNDS"); do
  printf '\n[%s/%s] waiting for frozen\n' "$round" "$ROUNDS"
  if ! bun run "$(demo_entry ac2-state)" --wait-for frozen --timeout-s "$FREEZE_WAIT_S" \
    >"$WORK/state-$round.json"; then
    printf 'round %s: sandbox did not reach frozen\n' "$round" >&2
    continue
  fi

  if ! bun run "$(demo_entry p31-send)" --round "$round" \
    --timeout-ms "$((ROUND_TIMEOUT_S * 1000))" \
    --deliver-ttl-ms "$((ROUND_TIMEOUT_S * 1000))" \
    >"$WORK/send-$round.json"; then
    printf 'round %s: delivery failed\n' "$round" >&2
    continue
  fi
  msgid="$(jget "$WORK/send-$round.json" msgId)"

  responsive=0
  if bun run "$(demo_entry p31-report)" \
    --activator-timings "$ACTIVATOR_TIMINGS" \
    --resident-timings "$RESIDENT_TIMINGS" \
    --rounds "$ROUNDS" \
    --latency-limit-ms "$LATENCY_LIMIT_MS" \
    --expected-resident-reconnect-factor "$RESIDENT_RECONNECT_FACTOR" \
    --expected-keepalive-time-jump-factor "$KEEPALIVE_TIME_JUMP_FACTOR" \
    --keepalive-time-jump-factor "$ACTUAL_KEEPALIVE_FACTOR" \
    --msg-id "$msgid" \
    --wait-ms "$((ROUND_TIMEOUT_S * 1000))" \
    --poll-ms 500 >"$WORK/round-$round.json" 2>/dev/null; then
    responsive=1
  fi
  if [ "$responsive" = 1 ]; then
    pass=$((pass + 1))
    printf 'round %s: responsive\n' "$round"
  else
    printf 'round %s: no complete resident response\n' "$round" >&2
  fi
done

if [ -n "$TIMING_WATCHER_PID" ] && kill -0 "$TIMING_WATCHER_PID" 2>/dev/null; then
  kill -TERM "$TIMING_WATCHER_PID" 2>/dev/null || true
  wait "$TIMING_WATCHER_PID" 2>/dev/null || true
fi
TIMING_WATCHER_PID=''

set +e
bun run "$(demo_entry p31-report)" \
  --activator-timings "$ACTIVATOR_TIMINGS" \
  --resident-timings "$RESIDENT_TIMINGS" \
  --rounds "$ROUNDS" \
  --latency-limit-ms "$LATENCY_LIMIT_MS" \
  --expected-resident-reconnect-factor "$RESIDENT_RECONNECT_FACTOR" \
  --expected-keepalive-time-jump-factor "$KEEPALIVE_TIME_JUMP_FACTOR" \
  --keepalive-time-jump-factor "$ACTUAL_KEEPALIVE_FACTOR" \
  >"$WORK/report.json"
report_rc=$?
set -e
printf '\nresponsive rounds: %s/%s\n' "$pass" "$ROUNDS"
printf 'report: %s\n' "$WORK/report.json"
cat "$WORK/report.json"
exit "$report_rc"
