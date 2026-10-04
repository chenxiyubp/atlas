#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 AgentNest —— AC-1「进程重启后凭持久化会话恢复上下文并续答」一键复现。
#
#   bash demo/ac1-restart.sh
#
# 判据出处：docs/dev/charter.md §4 AC-1。核验结论与口径：
#   docs/dev/session-persistence-review.md
#
# 本脚本做什么
#   1. `kill -9` 三个崩溃点（写事件中 / 快照中 / 工具执行中）后的一致性
#   2. 半写行（字节级截断）在读取侧的容错
#   3. `session_id` 在 `--resume <id>` 与 `--continue` 两个入口下的一致性
#   4. 「从进程启动到可接收新消息 ≤ 10 s」—— 两个历史规模点位 × 两个入口，
#      用来证明成本不随历史线性劣化（这正是把恢复入口钉死在 `--resume` 的理由）
#   5. 「不重放历史即可续答」—— **需要真实模型 API 凭据，无凭据时明确跳过**
#
# 隔离与安全
#   全程用 mktemp 出来的临时配置根（`OCC_CONFIG_DIR`），不读写用户真实的
#   `~/.occ` / `~/.qianmo`，不读取任何凭据，不发起任何模型 API 调用。
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"

# 历史规模点位（可用环境变量覆盖）
SMALL_SESSIONS="${AC1_SMALL_SESSIONS:-5}"
SMALL_TARGET_MSGS="${AC1_SMALL_TARGET_MSGS:-200}"
LARGE_SESSIONS="${AC1_LARGE_SESSIONS:-1000}"
LARGE_TARGET_MSGS="${AC1_LARGE_TARGET_MSGS:-3000}"
MSGS_PER_SESSION="${AC1_MSGS_PER_SESSION:-40}"
BUDGET_S="${AC1_BUDGET_S:-10}"

PASS=0
FAIL=0
SKIP=0
WARN=0

say()  { printf '%s\n' "$*"; }
head1() { printf '\n=== %s ===\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$*"; }
skip() { SKIP=$((SKIP + 1)); printf 'SKIPPED: %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf 'WARN: %s\n' "$*"; }

# 从单行 JSON 里取一个标量字段（够用即可，不引 jq 依赖）
jget() {
  sed -n "s/.*\"$2\":\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" "$1" | head -1
}

command -v bun >/dev/null 2>&1 || { say 'bun 不在 PATH 上，先装 bun'; exit 2; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ac1-restart.XXXXXX")"
export OCC_CONFIG_DIR="$WORK/config"
PROJECT="$WORK/project"
mkdir -p "$OCC_CONFIG_DIR" "$PROJECT"
cd "$PROJECT" || exit 2

say "工作目录 : $WORK"
say "配置根   : $OCC_CONFIG_DIR   (临时，绝不碰用户真实配置根)"
say "bun      : $(bun --version)"
say "平台     : $(uname -srm)"

# ---------------------------------------------------------------------------
head1 '1. kill -9 三个崩溃点的一致性'

run_crash_point() {
  point="$1"; session="$2"; note="$WORK/$point.json"; out="$WORK/$point.verify.json"
  if [ "$point" = 'tool' ]; then
    # 工具执行中：状态静止，用**外部** kill -9
    bun run "$(demo_entry ac1-crash-writer)" --point tool --session "$session" --out "$note" >/dev/null 2>&1 &
    child=$!
    i=0
    while [ ! -s "$note" ] && [ "$i" -lt 300 ]; do i=$((i + 1)); sleep 0.1; done
    victim="$(jget "$note" pid)"
    if [ -z "$victim" ]; then bad "${point}: 子进程未就绪"; return; fi
    say "  外部 kill -9 ${victim}"
    kill -9 "$victim" 2>/dev/null
    wait "$child" 2>/dev/null
    rc=137
  else
    # 写事件中 / 快照中：崩溃点在「已入队、未 drain」的 100 ms 窗口内，
    # 由被测进程在同一 tick 内自投 SIGKILL（语义等同外部 kill -9）
    # 套一层 bash -c：SIGKILL 的 "Killed: 9" 通知由**内层** shell 打印，
    # 一并被下面的重定向吃掉，输出干净；退出码照样是 137。
    # 末尾的 `; exit $?` 是必要的：只有一条简单命令时 bash -c 会直接 exec 掉
    # 自己，通知就又回到外层 shell 手里了。
    bash -c '"$0" run "$1" --point "$2" --session "$3" --out "$4"; exit $?' \
      "$(command -v bun)" "$(demo_entry ac1-crash-writer)" "$point" "$session" "$note" \
      >/dev/null 2>&1
    rc=$?
  fi
  say "  崩溃点 ${point}: 退出码 ${rc}（137 = 128+SIGKILL）"
  bun run "$(demo_entry ac1-verify)" --session "$session" >"$out" 2>/dev/null
  say "  $(cat "$out")"
  got_sid="$(jget "$out" sessionId)"
  malformed="$(jget "$out" malformedLines)"
  dangling="$(jget "$out" danglingToolUse)"
  count="$(jget "$out" messageCount)"
  [ "$rc" = '137' ] || bad "${point}: 进程不是被 SIGKILL 杀掉的（退出码 ${rc}）"
  [ "$got_sid" = "$session" ] && ok "${point}: session_id 一致（${got_sid}）" \
    || bad "${point}: session_id 不一致（期望 ${session}，实得 ${got_sid}）"
  [ "$malformed" = '0' ] && ok "${point}: 磁盘上无损坏行" \
    || bad "${point}: 出现 ${malformed} 条损坏行"
  [ "$dangling" = '0' ] && ok "${point}: 无悬空 tool_use（未配对的 tool_use 会被模型 API 拒绝）" \
    || bad "${point}: ${dangling} 个 tool_use 无配对结果"
  [ -n "$count" ] && [ "$count" -gt 0 ] && ok "${point}: 崩溃前已落盘的 ${count} 条消息可读回" \
    || bad "${point}: 读回 0 条消息"
}

run_crash_point write    'aa000000-0000-4000-8000-000000000001'
run_crash_point snapshot 'aa000000-0000-4000-8000-000000000002'
run_crash_point tool     'aa000000-0000-4000-8000-000000000003'

# ---------------------------------------------------------------------------
head1 '2. 半写行容错（字节级截断）'
# kill -9 本身不一定能撕开一行（append 由内核整体完成），但断电 / 满盘 / NFS
# 都会。这里人为把最后一行截半，验证读取侧的容错确实在
# （src/utils/text/json.ts:129-175「skip malformed lines」）。
TRUNC_SESSION='aa000000-0000-4000-8000-000000000001'
TRUNC_FILE="$(bun run "$(demo_entry ac1-project-dir)")/$TRUNC_SESSION.jsonl"
if [ -f "$TRUNC_FILE" ]; then
  before_bytes=$(wc -c <"$TRUNC_FILE" | tr -d ' ')
  cut_to=$((before_bytes - 200))
  bun -e "require('fs').truncateSync(process.argv[1], Number(process.argv[2]))" "$TRUNC_FILE" "$cut_to"
  bun run "$(demo_entry ac1-verify)" --session "$TRUNC_SESSION" >"$WORK/trunc.verify.json" 2>/dev/null
  say "  $(cat "$WORK/trunc.verify.json")"
  m="$(jget "$WORK/trunc.verify.json" malformedLines)"
  c="$(jget "$WORK/trunc.verify.json" messageCount)"
  s="$(jget "$WORK/trunc.verify.json" sessionId)"
  [ "$m" -ge 1 ] && ok "截断确实造出了半写行（${m} 条）" || bad "没造出半写行，本用例无效"
  [ "$c" -ge 1 ] && ok "半写行不影响其余消息读回（${c} 条）" || bad "半写行导致整个会话读不出来"
  [ "$s" = "$TRUNC_SESSION" ] && ok "半写行下 session_id 仍一致" || bad "半写行下 session_id 丢失"
else
  bad "找不到用于截断的会话文件：$TRUNC_FILE"
fi

# ---------------------------------------------------------------------------
head1 '3 & 4. session_id 一致性 + 启动预算（两个历史规模点位 × 两个入口）'

TARGET='bb000000-0000-4000-8000-00000000000f'

# 结果放全局变量，不走 stdout —— stdout 要留给人看的日志
MEASURED_WALL=''
MEASURED_LOAD=''

measure() { # $1=entry $2=label；--session 由 session_arg 提供
  entry="$1"; label="$2"; out="$WORK/m-$label-$entry.json"
  TIMEFORMAT='%3R'
  MEASURED_WALL=$( { time bun run "$(demo_entry ac1-measure)" --entry "$entry" \
      ${session_arg} >"$out" 2>/dev/null; } 2>&1 )
  MEASURED_LOAD="$(jget "$out" loadMs)"
  say "  [$label] --${entry}  wall=${MEASURED_WALL}s  $(cat "$out")"
}

scale_point() { # $1=label $2=sessions $3=target-msgs
  label="$1"
  rm -rf "${OCC_CONFIG_DIR:?}/projects"
  say "  生成历史：会话文件 $2 个（各 $MSGS_PER_SESSION 条）+ 目标会话 $3 条"
  bun run "$(demo_entry ac1-gen-history)" --sessions "$2" --msgs "$MSGS_PER_SESSION" \
    --target "$TARGET" --target-msgs "$3" >"$WORK/gen-$label.json" 2>/dev/null
  say "  $(cat "$WORK/gen-$label.json")"

  session_arg="--session $TARGET"
  measure resume "$label"
  r_wall="$MEASURED_WALL"; r_load="$MEASURED_LOAD"
  session_arg=''
  measure continue "$label"
  c_wall="$MEASURED_WALL"; c_load="$MEASURED_LOAD"

  r_sid="$(jget "$WORK/m-$label-resume.json" sessionId)"
  c_sid="$(jget "$WORK/m-$label-continue.json" sessionId)"
  [ "$r_sid" = "$TARGET" ] && ok "[$label] --resume 保持 session_id（${r_sid}）" \
    || bad "[$label] --resume 的 session_id 变了（${r_sid}）"
  [ "$c_sid" = "$TARGET" ] && ok "[$label] --continue 保持 session_id（${c_sid}）" \
    || bad "[$label] --continue 的 session_id 变了（${c_sid}）"

  budget_ok=$(bun -e "process.stdout.write(String(Number(process.argv[1]) <= Number(process.argv[2])))" "$r_wall" "$BUDGET_S")
  [ "$budget_ok" = 'true' ] && ok "[$label] --resume 冷启动到会话就绪 ${r_wall}s ≤ ${BUDGET_S}s" \
    || bad "[$label] --resume 冷启动 ${r_wall}s 超过 ${BUDGET_S}s"
  eval "WALL_R_$label=$r_wall"
  eval "WALL_C_$label=$c_wall"
  eval "LOAD_R_$label=$r_load"
  eval "LOAD_C_$label=$c_load"
}

scale_point small "$SMALL_SESSIONS" "$SMALL_TARGET_MSGS"
scale_point large "$LARGE_SESSIONS" "$LARGE_TARGET_MSGS"

head1 '4b. 两个入口的历史敏感度对比'
say "  冷启动总墙钟（含 bun 启动 + 模块加载 ~0.4 s 的公共底噪）"
say "    --resume  : small=${WALL_R_small}s  large=${WALL_R_large}s"
say "    --continue: small=${WALL_C_small}s  large=${WALL_C_large}s"
say "  纯加载耗时（进程内计时，剔掉公共底噪 —— 这一项才是随历史增长的部分）"
say "    --resume  : small=${LOAD_R_small}ms  large=${LOAD_R_large}ms"
say "    --continue: small=${LOAD_C_small}ms  large=${LOAD_C_large}ms"
verdict=$(bun -e '
const [rs, rl, cs, cl] = process.argv.slice(1).map(Number)
const g = (a, b) => (a > 0 ? Number((b / a).toFixed(2)) : null)
process.stdout.write(JSON.stringify({
  resumeLoadGrowth: g(rs, rl),
  continueLoadGrowth: g(cs, cl),
  continueGrowsFaster: (cl - cs) > (rl - rs),
}))' "$LOAD_R_small" "$LOAD_R_large" "$LOAD_C_small" "$LOAD_C_large")
say "  $verdict"
case "$verdict" in
  *'"continueGrowsFaster":true'*) ok '历史放大后 --continue 的加载成本涨得比 --resume 快（与钉死 --resume 的理由一致）' ;;
  *) bad '历史放大后 --continue 没有涨得更快 —— 与钉死 --resume 的理由不符，需复核' ;;
esac

# ---------------------------------------------------------------------------
head1 '4c. 已知缺口：时间戳并列时 --resume 会丢掉尾部消息'
# `insertMessageChain` 在展开之后无条件覆盖时间戳（transcriptWriter.ts:866-879），
# 同一片写出的条目共用一个毫秒；`--resume` 的锚点用 `>` 比较取最大时间戳、
# 并列时保留**先出现**的那条（logAssembly.ts:27-42 + :487），于是尾部并列的
# 那几条被甩在锚点之后、进不了会话链。`--continue` 的锚点限定在链尾
# （logAssembly.ts:384-388 的 leafUuids 过滤），不受影响。
tie_report() { # $1=label
  rc="$(jget "$WORK/m-$1-resume.json" messageCount)"
  cc="$(jget "$WORK/m-$1-continue.json" messageCount)"
  say "  [$1] --resume 读回 ${rc} 条，--continue 读回 ${cc} 条"
  if [ "$rc" -lt "$cc" ]; then
    warn "[$1] --resume 比 --continue 少 $((cc - rc)) 条（时间戳并列丢尾部；见 review 文档「后续动作」第 1 条）"
  else
    ok "[$1] 两个入口读回的消息条数一致"
  fi
}
tie_report small
tie_report large

# ---------------------------------------------------------------------------
head1 '5. 不重放历史即可续答（AC-1 第二条判据）'
skip "needs model credentials —— 该判据要求重启后直接追问「继续刚才那步」，"
say  '        并检查回答里引用了只有重启前上下文才知道的项目细节。这必须真调模型 API。'
say  '        需要什么：一个可用的模型供应商凭据（`occ` 已登录，或供应商 API key），'
say  '        以及一次真实的多轮任务现场。本脚本刻意不读取任何凭据、不发起任何模型调用。'

# ---------------------------------------------------------------------------
head1 '结果'
say "PASS=$PASS  FAIL=$FAIL  WARN=$WARN  SKIPPED=$SKIP"
say "现场保留在：${WORK}（自行删除）"
[ "$FAIL" -eq 0 ] || exit 1
