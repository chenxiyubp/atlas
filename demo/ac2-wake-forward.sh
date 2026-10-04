#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 AgentNest —— P2.5 DoD ①「跨节点唤醒转发闭环」一键复现（连续 10 次）。
#
#   bash demo/ac2-wake-forward.sh
#
# 判据出处：docs/dev/roadmap.md 的 P2.5 任务包 DoD ①、docs/dev/charter.md §4 AC-2。
# 组件出处：packages/activator/（activator 与 keepalive 的两张面孔）。
#
# 这个脚本证什么
#   目标节点处于**休眠态**（沙箱 frozen）时向它投递一条消息，由宿主侧 activator
#   接住 → 唤醒 → 探测 ready → 转发，消息完整到达沙箱内的节点且不丢；连续 10 次，
#   最后打印 N/10，并给出每一次的分阶段耗时（接住 → 发起唤醒 → ready → 首字节转发）。
#
# 它不证什么
#   - 不证 ack / task.result 的语义（那是 P2.1 最后一跳与 P1.1 协议的判据）；
#   - 不证 keepalive 防冻结（DoD ②，已在真机单独验过）；
#   - 不证 destroy 不可达（DoD ③，CI 里的断言）与崩溃恢复（DoD ④，本地真测）。
#
# ── 跑之前需要三样东西 ────────────────────────────────────────────────────────
#
# 1) 一个真实沙箱，里面跑着目标节点。**本脚本不会、也不能替你把它拉起来**：
#    activator 的能力面只有 acquireSandbox / listSandboxes 两个动作，没有 exec，
#    这正是 AC-6(c) 依赖的那条边界。请先在沙箱里跑：
#
#        QIANMO_TRANSPORT_PSK=<与宿主同一把> \
#        bun run "$(demo_entry ac2-target)" --inbox /tmp/ac2-inbox.jsonl --port 38622
#        （先 `. demo/lib/entry.sh`）
#
#    然后让沙箱空转到被冻结（实测：沙箱内再忙也照冻，见 selection-m0.md E3）。
#
# 2) 下面这些环境变量。**缺一个就退出，不静默跳过**；凭据只走环境变量，
#    本脚本与 demo/lib/ac2-*.ts 里没有任何凭据字面量（CI 有断言看着）：
#
#        QIANMO_SANDBOX_DAEMON_URL    沙箱 daemon 的**回环**基址（非回环会被代码拒绝）
#        QIANMO_SANDBOX_DAEMON_TOKEN  daemon 的 bearer —— 不回显、不落盘、不进日志
#        QIANMO_TRANSPORT_PSK         传输层预共享密钥（两跳共用，与沙箱内那份一致）
#        QIANMO_AC2_SANDBOX           目标沙箱在 daemon 里的 name（不是 id）
#        QIANMO_AC2_TARGET_URL        沙箱内节点的监听地址，**从宿主看过去**
#                                     （形如 ws://<容器地址>:38622）
#
#    可选：QIANMO_AC2_NODE（默认 node-b）、QIANMO_AC2_AGENT（默认 reviewer）、
#          AC2_ROUNDS（默认 10）、AC2_FREEZE_WAIT_S（默认 300）、
#          AC2_ROUND_TIMEOUT_S（默认 120）、AC2_HOST（activator 入站绑定，默认回环）
#
# 3) bun 在 PATH 上，且仓库依赖已装好（bun install）。
#
# ── 时间预算 ─────────────────────────────────────────────────────────────────
#   每一轮都要先等沙箱重新冻结，这一段由 daemon 的 freezeAfterSeconds 决定，
#   通常是分钟级。10 轮跑满可能要一小时以上，属正常。中途 Ctrl-C 会清理干净。
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"

ROUNDS="${AC2_ROUNDS:-10}"
FREEZE_WAIT_S="${AC2_FREEZE_WAIT_S:-300}"
ROUND_TIMEOUT_S="${AC2_ROUND_TIMEOUT_S:-120}"
# activator 的唤醒预算：AC-2 给 ack 的线是 60 s，留 5 s 给两跳传输本身。
READY_TIMEOUT_S="${AC2_READY_TIMEOUT_S:-55}"
FORWARD_TIMEOUT_S="${AC2_FORWARD_TIMEOUT_S:-15}"

# 发送方的等待必须盖得住 activator 的全部预算，否则每一次慢唤醒都会先在发送方
# 这边超时，而 activator 还没落定这一轮 —— 于是分阶段耗时永远查不到，
# 失败原因也就永远只剩一句「没排空」。这里宁可自动抬高，也不留这个坑。
MIN_ROUND_S=$((READY_TIMEOUT_S + FORWARD_TIMEOUT_S + 10))
if [ "$ROUND_TIMEOUT_S" -lt "$MIN_ROUND_S" ]; then
  say_later="单轮上限 ${ROUND_TIMEOUT_S}s 盖不住 activator 的 ${READY_TIMEOUT_S}+${FORWARD_TIMEOUT_S}s 预算，已抬到 ${MIN_ROUND_S}s"
  ROUND_TIMEOUT_S="$MIN_ROUND_S"
else
  say_later=''
fi

PASS=0
FAIL=0

say()  { printf '%s\n' "$*"; }
head1() { printf '\n=== %s ===\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$*"; }

# 从单行 JSON 里取一个标量字段（够用即可，不引 jq 依赖）
jget() {
  sed -n "s/.*\"$2\":\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" "$1" | head -1
}

command -v bun >/dev/null 2>&1 || { say 'bun 不在 PATH 上，先装 bun'; exit 2; }

# ---------------------------------------------------------------------------
head1 '0. 配置自检'

MISSING=''
for var in QIANMO_SANDBOX_DAEMON_URL QIANMO_SANDBOX_DAEMON_TOKEN \
           QIANMO_TRANSPORT_PSK QIANMO_AC2_SANDBOX QIANMO_AC2_TARGET_URL; do
  eval "value=\${$var:-}"
  [ -n "$value" ] || MISSING="$MISSING $var"
done
if [ -n "$MISSING" ]; then
  say "缺少必需的环境变量：$MISSING"
  say '这些是部署信息与凭据，一律从环境注入，仓库里不存也不猜默认值。'
  say '（判据要的是「跑过并且证明了什么」，静默跳过会给出「没报错=通过」的错觉。）'
  exit 2
fi

# 凭据只报「已设置」，绝不回显。
say "daemon 基址   : $QIANMO_SANDBOX_DAEMON_URL"
say "daemon bearer : 已设置（不回显）"
say "传输 PSK      : 已设置（不回显）"
say "目标沙箱      : $QIANMO_AC2_SANDBOX"
say "目标节点      : ${QIANMO_AC2_NODE:-node-b} / ${QIANMO_AC2_AGENT:-reviewer}"
say "目标监听      : $QIANMO_AC2_TARGET_URL"
say "轮数          : $ROUNDS   每轮等冻结上限 ${FREEZE_WAIT_S}s   单轮上限 ${ROUND_TIMEOUT_S}s"
say "预算          : 唤醒 ${READY_TIMEOUT_S}s + 转发 ${FORWARD_TIMEOUT_S}s（activator 侧）"
[ -z "$say_later" ] || say "注意          : $say_later"
say "bun           : $(bun --version)"
say "平台          : $(uname -srm)"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ac2-wake.XXXXXX")"
READY="$WORK/activator-ready.json"
TIMINGS="$WORK/timings.jsonl"
AUDIT="$WORK/audit.jsonl"
say "现场目录      : $WORK"

ACTIVATOR_PID=''
cleanup() {
  if [ -n "$ACTIVATOR_PID" ] && kill -0 "$ACTIVATOR_PID" 2>/dev/null; then
    kill -TERM "$ACTIVATOR_PID" 2>/dev/null
    wait "$ACTIVATOR_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
head1 '1. 先看一眼沙箱在不在'

bun run "$(demo_entry ac2-state)" >"$WORK/state-0.json" 2>"$WORK/state-0.err"
rc=$?
say "  $(cat "$WORK/state-0.json" 2>/dev/null)"
if [ "$rc" != '0' ] || [ ! -s "$WORK/state-0.json" ]; then
  say "  读不到沙箱状态。原始错误："
  sed 's/^/    /' "$WORK/state-0.err"
  say '  常见原因：daemon 基址不对 / bearer 不对 / 沙箱名写成了 id（daemon 只认 name）。'
  exit 2
fi
state0="$(jget "$WORK/state-0.json" state)"
if [ "$state0" = 'unreadable' ]; then
  say "  daemon 答了，但这个 name 不在它的列表里 —— 先确认 QIANMO_AC2_SANDBOX。"
  exit 2
fi

# ---------------------------------------------------------------------------
head1 '2. 拉起宿主侧 activator'

bun run "$(demo_entry ac2-activator)" --ready "$READY" --timings "$TIMINGS" \
  --audit "$AUDIT" \
  --ready-timeout-ms "$((READY_TIMEOUT_S * 1000))" \
  --forward-timeout-ms "$((FORWARD_TIMEOUT_S * 1000))" \
  ${AC2_HOST:+--host "$AC2_HOST"} \
  >"$WORK/activator.log" 2>&1 &
ACTIVATOR_PID=$!

i=0
while [ ! -s "$READY" ] && [ "$i" -lt 300 ]; do
  kill -0 "$ACTIVATOR_PID" 2>/dev/null || break
  i=$((i + 1)); sleep 0.1
done
if [ ! -s "$READY" ]; then
  say '  activator 没起来。它的输出：'
  sed 's/^/    /' "$WORK/activator.log"
  exit 2
fi
say "  $(cat "$READY")"
ACTIVATOR_URL="$(jget "$READY" url)"
export QIANMO_AC2_ACTIVATOR_URL="$ACTIVATOR_URL"
# 变量一律用 ${} 括起来：紧跟全角标点时，macOS 自带的 bash 3.2 会把多字节
# 字节当成变量名的一部分，报一个查不出所以然的 "unbound variable"。
say "  入站地址：${ACTIVATOR_URL}（pid ${ACTIVATOR_PID}）"

# ---------------------------------------------------------------------------
head1 "3. 连续 $ROUNDS 轮唤醒转发"

round=1
while [ "$round" -le "$ROUNDS" ]; do
  printf '\n--- 第 %s/%s 轮 ---\n' "$round" "$ROUNDS"

  if ! kill -0 "$ACTIVATOR_PID" 2>/dev/null; then
    bad "第 $round 轮：activator 进程已经不在了（见 $WORK/activator.log）"
    break
  fi

  # ① 前提：目标必须真的在休眠态。醒着的目标测不出这条判据，所以不凑数。
  say "  等待沙箱进入 frozen（上限 ${FREEZE_WAIT_S}s）……"
  bun run "$(demo_entry ac2-state)" --wait-for frozen --timeout-s "$FREEZE_WAIT_S" \
    >"$WORK/state-$round.json" 2>&1
  frozen_rc=$?
  say "  $(cat "$WORK/state-$round.json")"
  if [ "$frozen_rc" != '0' ]; then
    bad "第 $round 轮：目标在 ${FREEZE_WAIT_S}s 内没有进入休眠态，这一轮不成立"
    say '        （不是「唤醒失败」，是前提没满足；把 AC2_FREEZE_WAIT_S 调到大于'
    say '          daemon 策略里的 freezeAfterSeconds 再跑）'
    round=$((round + 1))
    continue
  fi

  # ② 投递：一轮一个进程、一条消息，避免复用连接把第二次之后的唤醒省掉。
  bun run "$(demo_entry ac2-send)" --round "$round" \
    --timeout-ms "$((ROUND_TIMEOUT_S * 1000))" \
    --deliver-ttl-ms "$((ROUND_TIMEOUT_S * 1000))" \
    >"$WORK/send-$round.json" 2>"$WORK/send-$round.err"
  send_rc=$?
  say "  发送方：$(cat "$WORK/send-$round.json" 2>/dev/null)"
  msgid="$(jget "$WORK/send-$round.json" msgId)"

  # ③ 分阶段耗时：从 activator 侧的埋点取，那才是四个阶段真正发生的地方。
  #    发送方先于 activator 放弃时，这一行会查不到——再等一下重查一次，
  #    因为「查不到」和「没走到那一步」是两回事，混起来会误导排查。
  if [ -n "$msgid" ]; then
    bun run "$(demo_entry ac2-report)" --timings "$TIMINGS" --msg-id "$msgid" \
      >"$WORK/stages-$round.json" 2>&1
    if grep -q '"found":false' "$WORK/stages-$round.json" 2>/dev/null; then
      sleep 3
      bun run "$(demo_entry ac2-report)" --timings "$TIMINGS" --msg-id "$msgid" \
        >"$WORK/stages-$round.json" 2>&1
    fi
    say "  分阶段：$(cat "$WORK/stages-$round.json")"
    grep -q '"found":false' "$WORK/stages-$round.json" 2>/dev/null &&
      say '          （activator 还没给这一轮落定结论——多半是发送方的等待比它的唤醒预算短）'
  else
    say '  分阶段：（发送方没拿到 msgId，无从对账）'
  fi

  if [ "$send_rc" = '0' ]; then
    ok "第 $round 轮：休眠 → 唤醒 → ready → 转发，回执 accepted"
  else
    bad "第 $round 轮：未确认送达"
    say '        定位顺序：'
    say "          a) 发送方结论      $WORK/send-$round.json（verdict / error）"
    say "          b) 分阶段耗时      $WORK/stages-$round.json"
    say '             —— 缺 acceptToWakeMs：没接住（路由/直接被拒）'
    say '             —— 缺 wakeToReadyMs：唤醒发出了，目标始终不应答'
    say '             —— 缺 readyToForwardMs：ready 了但转发没拿到回执'
    say "          c) activator 审计  ${AUDIT}（link.probe-failed / request.failed）"
    say "          d) activator 日志  $WORK/activator.log"
  fi

  round=$((round + 1))
done

# ---------------------------------------------------------------------------
head1 '4. 汇总'

bun run "$(demo_entry ac2-report)" --timings "$TIMINGS" >"$WORK/report.json" 2>&1
say "  $(cat "$WORK/report.json")"
say ''
say "  唤醒转发 ${PASS}/${ROUNDS}"
say "  现场保留在：${WORK}（自行删除；里面没有凭据，但有部署地址）"
[ "$FAIL" -eq 0 ] || exit 1
