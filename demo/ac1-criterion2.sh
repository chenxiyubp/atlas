#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# AC-1 判据②「不重放历史即可续答」—— 现场留档版。
#
# demo/ac1-restart.sh 第 5 节恒 SKIP（脚本刻意不读凭据、不发真调用）。本脚本
# 补上那一段：同等隔离卫生（mktemp 临时 OCC_CONFIG_DIR，绝不碰真实 ~/.occ），
# 但**发真调用**。
#
# 现场（照 docs/dev/acceptance-m0.md §4.3 与 roadmap P1.2 行的口径）：
#   ① 起一个会话，两轮对话把一个**本次运行才生成的**常量名与数值放进上下文
#   ② 第三轮任务进行中 `kill -9`
#   ③ `occ --resume <session_id>` 追问「继续刚才那步」（命令行**不重发历史**）
#   ④ 断言回答里引用了那个常量名与数值
#   ⑤ session_id 前后一致
#
# 环境要求：OPENAI_API_KEY 已在环境里（值不打印、不落盘）。
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"
OUT="${AC1C2_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/ac1-crit2-out.XXXXXX")}"
mkdir -p "$OUT"

# 网关 / 模型可按环境覆盖；默认与 tests/integration/fixtures/ac5-config-a.json 同源。
AC1C2_BASE_URL="${AC1C2_BASE_URL:-https://api.cornna.xyz/v1}"
AC1C2_MODEL="${AC1C2_MODEL:-deepseek-v4-pro}"
AC1C2_COMPAT="${AC1C2_COMPAT:-deepseek}"

PASS=0
FAIL=0
say()  { printf '%s\n' "$*"; }
head1() { printf '\n=== %s ===\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf 'PASS: %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL: %s\n' "$*"; }

umask 077

# ── 隔离：临时配置根，绝不碰用户真实 ~/.occ ────────────────────────────────
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ac1-crit2.XXXXXX")"
export OCC_CONFIG_DIR="$WORK/config"
export CLAUDE_CONFIG_DIR="$WORK/config"   # occConfigDir() 顺序 OCC_ > CLAUDE_ > ~/.occ，两个都设
PROJECT="$WORK/project"
mkdir -p "$OCC_CONFIG_DIR" "$PROJECT"
cd "$PROJECT" || exit 2   # 会话按 cwd 归档，occ 全程跑在这个临时项目目录里

say "仓库     : $REPO_DIR"
say "工作目录 : $WORK"
say "配置根   : $OCC_CONFIG_DIR   (临时，绝不碰用户真实配置根)"
say "项目 cwd : $PROJECT"
say "产物目录 : $OUT"
say "bun      : $(bun --version)"
say "平台     : $(uname -srm)"
say "HEAD     : $(git -C "$REPO_DIR" rev-parse --short HEAD) ($(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD))"

[ -n "${OPENAI_API_KEY:-}" ] || { bad 'OPENAI_API_KEY 未设置，本现场需要真凭据'; exit 2; }
say "凭据     : OPENAI_API_KEY 已存在（只探测存在与否，不回显值）"

# ── provider：走基座自己的注册中心，配置文件放进临时配置根 ─────────────────
head1 '0. provider 解析（基座 providerRegistry，配置文件路径）'
cat >"$OCC_CONFIG_DIR/providers.json" <<JSON
[
  {
    "id": "qianmo-ac1",
    "kind": "openai-compat",
    "baseUrl": "$AC1C2_BASE_URL",
    "apiKeyEnv": "OPENAI_API_KEY",
    "defaultModel": "$AC1C2_MODEL",
    "compatRule": "$AC1C2_COMPAT"
  }
]
JSON
say "  写入 $OCC_CONFIG_DIR/providers.json（密钥只存**变量名**，不存值）"

# 让基座的 loadProviders + switchProvider 从上面那份配置解析出环境。
PROV_ENV="$WORK/prov.env"
# bun -e 的相对 import 以 [eval] 伪文件所在目录解析，不是 cwd —— 必须用绝对路径。
QM_REPO="$REPO_DIR" bun -e '
const R = process.env.QM_REPO
const { loadProvidersWithDiagnostic } = await import(R + "/src/services/providerRegistry/loader.js")
const { switchProvider } = await import(R + "/src/services/providerRegistry/switcher.js")
const loaded = loadProvidersWithDiagnostic()
if (loaded.error) { console.error("providers.json 解析失败: " + loaded.error); process.exit(2) }
const s = switchProvider("qianmo-ac1", loaded.providers)
for (const [k, v] of Object.entries(s.env)) process.stdout.write(k + "=" + v + "\n")
' >"$PROV_ENV" 2>"$WORK/prov.err"
if [ ! -s "$PROV_ENV" ]; then
  bad "provider 解析失败：$(cat "$WORK/prov.err")"
  exit 2
fi
say '  switchProvider 产出的环境（密钥不在其中，由 OPENAI_API_KEY 变量提供）：'
sed 's/^/    /' "$PROV_ENV"
# shellcheck disable=SC1090
set -a; . "$PROV_ENV"; set +a
unset ANTHROPIC_API_KEY   # 两条路径并存只会制造歧义

# ── 本次运行才存在的独特细节 ──────────────────────────────────────────────
# 名字与数值都由 CSPRNG 现生成：训练语料里不可能有，模型也猜不到。
SUFFIX="$(od -An -tx1 -N 3 /dev/urandom | tr -d ' \n' | tr 'a-f' 'A-F')"
VALUE="$(( 4000 + RANDOM % 5000 ))"
CONST_NAME="QM_LATCH_${SUFFIX}"
say ''
say "本次现场的独特细节（每次运行现生成）：常量名 ${CONST_NAME}，数值 ${VALUE}"

SID="$(bun -e 'process.stdout.write(crypto.randomUUID())')"
say "预置 session_id：${SID}"

# 直跑源码必须自己注 `MACRO.*` defines：那是转译期替换，缺了 `-d` 第一次读就
# ReferenceError。取值从 scripts/defines.ts 来，与 dev / build 同源——手抄一份
# 就是 issue #81 那个坑（抄来的空 ISSUES_EXPLAINER 让 system prompt 只说了半句）。
OCC_DEFINES=()
while IFS= read -r define_arg; do
  OCC_DEFINES+=("$define_arg")
done < <(bun -e "const {macroDefineArgs} = await import('$REPO_DIR/scripts/defines.ts'); for (const a of macroDefineArgs()) console.log(a)")
OCC=("bun" "run" "${OCC_DEFINES[@]}" "$REPO_DIR/src/entrypoints/cli.tsx")
COMMON=("--dangerously-skip-permissions" "--output-format" "json")

jget() { sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" "$1" | head -1; }

T1="记住这条只存在于本次对话里的项目约定，不要写文件、不要用任何工具，只回一句「记住了」：本项目的重试闸门常量叫 ${CONST_NAME}。"
T2="补充同一条约定，同样不要用任何工具，只回一句「记住了」：${CONST_NAME} 的取值是 ${VALUE}（单位毫秒）。它只在本次对话里存在，任何文档和代码里都没有。"
T3="现在开始第三步：请用中文写一段 600 字以上的详细说明，讲清楚这个重试闸门常量在一个常驻智能体节点里应该怎么用、为什么取这个数量级、以及边界情况怎么处理。不要用任何工具，直接写。"
T4="继续刚才那步。不要重新读任何文件、不要用任何工具，也不要让我重发历史——直接回答：刚才那个重试闸门常量的**名字**和**数值**分别是什么？把名字和数值原样写出来。"

# ── 第 1 / 2 轮：把独特细节放进上下文 ─────────────────────────────────────
head1 '1. 建立会话：两轮对话把独特细节放进上下文'
say "  [turn 1] occ --session-id ${SID} -p <约定：常量名>"
t0=$(date +%s)
"${OCC[@]}" --session-id "$SID" -p "$T1" "${COMMON[@]}" >"$WORK/t1.json" 2>"$WORK/t1.err"
rc1=$?
t1s=$(( $(date +%s) - t0 ))
sid1="$(jget "$WORK/t1.json" session_id)"
say "  [turn 1] 退出码 ${rc1}，用时 ${t1s}s，session_id=${sid1}"
say "  [turn 1] 回答：$(jget "$WORK/t1.json" result | head -c 200)"
[ "$rc1" = '0' ] && ok "turn 1 成功" || { bad "turn 1 失败（退出码 ${rc1}）：$(tail -3 "$WORK/t1.err")"; }
[ "$sid1" = "$SID" ] && ok "turn 1 的 session_id 就是预置的那串（${sid1}）" \
  || bad "turn 1 的 session_id 不是预置值（期望 ${SID}，实得 ${sid1}）"

say "  [turn 2] occ --resume ${SID} -p <约定：数值>"
t0=$(date +%s)
"${OCC[@]}" --resume "$SID" -p "$T2" "${COMMON[@]}" >"$WORK/t2.json" 2>"$WORK/t2.err"
rc2=$?
t2s=$(( $(date +%s) - t0 ))
sid2="$(jget "$WORK/t2.json" session_id)"
say "  [turn 2] 退出码 ${rc2}，用时 ${t2s}s，session_id=${sid2}"
say "  [turn 2] 回答：$(jget "$WORK/t2.json" result | head -c 200)"
[ "$rc2" = '0' ] && ok "turn 2 成功" || bad "turn 2 失败（退出码 ${rc2}）：$(tail -3 "$WORK/t2.err")"
[ "$sid2" = "$SID" ] && ok "turn 2 的 session_id 仍是同一串（${sid2}）" \
  || bad "turn 2 的 session_id 变了（${sid2}）"

# 会话文件位置（用基座自己的 getProjectDir 口径，不自己拼 sanitize 规则）
PROJDIR="$(cd "$PROJECT" && bun run "$(demo_entry ac1-project-dir)" 2>/dev/null)"
JSONL="$PROJDIR/$SID.jsonl"
say "  会话文件：$JSONL"
if [ -f "$JSONL" ]; then
  say "  崩溃前落盘 $(wc -l <"$JSONL" | tr -d ' ') 行 / $(wc -c <"$JSONL" | tr -d ' ') 字节"
  ok "会话已持久化到磁盘"
else
  bad "找不到会话文件，后面的 --resume 无从谈起"
fi
before_lines=$(wc -l <"$JSONL" 2>/dev/null | tr -d ' ')

# ── 第 3 轮：任务进行中 kill -9 ───────────────────────────────────────────
head1 '2. 第三轮任务进行中 kill -9（外部信号）'
say "  [turn 3] occ --resume ${SID} -p <600 字长文任务> &"
t0=$(date +%s)
"${OCC[@]}" --resume "$SID" -p "$T3" "${COMMON[@]}" >"$WORK/t3.json" 2>"$WORK/t3.err" &
victim=$!
say "  子进程 pid=${victim}"

# 等到它**确实在干活**：会话文件长出了新行（第三轮的 user 消息已落盘）
i=0
grew=0
while [ "$i" -lt 600 ]; do
  now_lines=$(wc -l <"$JSONL" 2>/dev/null | tr -d ' ')
  if [ -n "$now_lines" ] && [ "$now_lines" -gt "$before_lines" ]; then grew=1; break; fi
  kill -0 "$victim" 2>/dev/null || break
  i=$((i + 1)); sleep 0.1
done
waited=$(( $(date +%s) - t0 ))
if [ "$grew" = '1' ]; then
  ok "第三轮已开工（会话文件从 ${before_lines} 行长到 $(wc -l <"$JSONL" | tr -d ' ') 行，用时 ${waited}s）"
else
  bad "等了 ${waited}s 第三轮仍未落盘，kill 的不是「进行中」的进程"
fi
# 再给它一点时间真正进入模型流式输出，然后外部 kill -9 整棵进程树
sleep 2
if kill -0 "$victim" 2>/dev/null; then
  kids="$(pgrep -P "$victim" 2>/dev/null | tr '\n' ' ')"
  say "  外部 kill -9 ${victim} ${kids}"
  # shellcheck disable=SC2086
  [ -n "$kids" ] && kill -9 $kids 2>/dev/null
  kill -9 "$victim" 2>/dev/null
  wait "$victim" 2>/dev/null
  rc3=$?
else
  wait "$victim" 2>/dev/null
  rc3=$?
  say "  子进程在 kill 之前就退出了（退出码 ${rc3}）"
fi
t3s=$(( $(date +%s) - t0 ))
say "  [turn 3] 退出码 ${rc3}（137 = 128+SIGKILL），从启动到被杀 ${t3s}s"
[ "$rc3" = '137' ] && ok "第三轮进程确实是被 SIGKILL 杀掉的" \
  || bad "第三轮进程不是被 SIGKILL 杀掉的（退出码 ${rc3}）—— 现场不成立"
say "  崩溃后磁盘上 $(wc -l <"$JSONL" | tr -d ' ') 行 / $(wc -c <"$JSONL" | tr -d ' ') 字节"
# 确认没有任何 occ 进程残留
sleep 1
if pgrep -f "$SID" >/dev/null 2>&1; then
  say "  WARN: 仍有引用该 session 的进程残留"
else
  ok "无进程残留 —— 下一步是彻头彻尾的冷启动"
fi

# ── 第 4 轮：--resume 追问，命令行不含任何历史 ─────────────────────────────
head1 '3. 冷启动 --resume 追问（命令行不重发历史）'
say '  即将执行的命令行逐字如下（除追问句外不含任何历史内容）：'
say "    bun run <MACRO defines> src/entrypoints/cli.tsx --resume ${SID} -p '${T4}' --dangerously-skip-permissions --output-format json"
say "  追问句里既没有出现常量名，也没有出现数值 —— 自检："
case "$T4" in
  *"$CONST_NAME"*) bad '追问句里出现了常量名，用例无效' ;;
  *) ok "追问句不含常量名 ${CONST_NAME}" ;;
esac
case "$T4" in
  *"$VALUE"*) bad '追问句里出现了数值，用例无效' ;;
  *) ok "追问句不含数值 ${VALUE}" ;;
esac

t0=$(date +%s)
"${OCC[@]}" --resume "$SID" -p "$T4" "${COMMON[@]}" >"$WORK/t4.json" 2>"$WORK/t4.err"
rc4=$?
t4s=$(( $(date +%s) - t0 ))
sid4="$(jget "$WORK/t4.json" session_id)"
say "  [turn 4] 退出码 ${rc4}，端到端 ${t4s}s，session_id=${sid4}"
ANSWER="$(bun -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8"))
process.stdout.write(String(j.result ?? ""))' "$WORK/t4.json" 2>/dev/null)"
say '  ---------------- 重启后的回答全文 ----------------'
printf '%s\n' "$ANSWER"
say '  --------------------------------------------------'

[ "$rc4" = '0' ] && ok "turn 4 成功" || bad "turn 4 失败（退出码 ${rc4}）：$(tail -5 "$WORK/t4.err")"
[ "$sid4" = "$SID" ] && ok "重启后 session_id 与重启前同一串（${sid4}）" \
  || bad "重启后 session_id 变了（期望 ${SID}，实得 ${sid4}）"

CITES_NAME=false
CITES_VALUE=false
case "$ANSWER" in
  *"$CONST_NAME"*) CITES_NAME=true; ok "回答里引用了只存在于崩溃前上下文的常量名 ${CONST_NAME}" ;;
  *) bad "回答里没有出现常量名 ${CONST_NAME}" ;;
esac
case "$ANSWER" in
  *"$VALUE"*) CITES_VALUE=true; ok "回答里引用了只存在于崩溃前上下文的数值 ${VALUE}" ;;
  *) bad "回答里没有出现数值 ${VALUE}" ;;
esac

after_lines=$(wc -l <"$JSONL" | tr -d ' ')
say "  会话文件最终 ${after_lines} 行"

# ── 产物 ──────────────────────────────────────────────────────────────────
head1 '4. 产物'
cp "$WORK/t1.json" "$OUT/turn1.result.json" 2>/dev/null
cp "$WORK/t2.json" "$OUT/turn2.result.json" 2>/dev/null
cp "$WORK/t3.json" "$OUT/turn3.result.json" 2>/dev/null
cp "$WORK/t4.json" "$OUT/turn4.result.json" 2>/dev/null
cp "$JSONL" "$OUT/session.jsonl" 2>/dev/null
printf '%s\n' "$ANSWER" >"$OUT/turn4.answer.txt"
printf '%s\n' "$T4" >"$OUT/turn4.prompt.txt"
chmod 600 "$OUT"/* 2>/dev/null

cat >"$OUT/report.json" <<EOF
{
  "ac": "AC-1",
  "criterion": "②「不重放历史即可续答」",
  "note": "demo/ac1-restart.sh 第 5 节恒 SKIP，本现场补齐并留档",
  "utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "repoHead": "$(git -C "$REPO_DIR" rev-parse HEAD)",
  "repoBranch": "$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)",
  "repoDirty": $( [ -n "$(git -C "$REPO_DIR" status --porcelain)" ] && printf 'true' || printf 'false' ),
  "provider": { "id": "qianmo-ac1", "kind": "openai-compat", "baseUrl": "$AC1C2_BASE_URL", "model": "$AC1C2_MODEL", "compatRule": "$AC1C2_COMPAT" },
  "isolation": { "occConfigDir": "$OCC_CONFIG_DIR", "touchedRealConfigRoot": false, "projectCwd": "$PROJECT" },
  "secret": { "constName": "$CONST_NAME", "constValue": $VALUE, "generatedBy": "CSPRNG at run time" },
  "sessionId": { "preset": "$SID", "turn1": "$sid1", "turn2": "$sid2", "turn4": "$sid4", "stableAcrossCrash": $( [ "$sid1" = "$SID" ] && [ "$sid4" = "$SID" ] && printf 'true' || printf 'false' ) },
  "crash": { "signal": "SIGKILL", "exitCode": $rc3, "wasExternalKill": true, "sessionLinesBefore": $before_lines, "sessionLinesAfter": $after_lines },
  "resume": { "exitCode": $rc4, "endToEndSeconds": $t4s, "historyReplayedOnCommandLine": false, "answerCitesConstName": $CITES_NAME, "answerCitesConstValue": $CITES_VALUE },
  "timings": { "turn1Seconds": $t1s, "turn2Seconds": $t2s, "turn3SecondsUntilKill": $t3s, "turn4Seconds": $t4s },
  "pass": $( [ "$FAIL" -eq 0 ] && printf 'true' || printf 'false' ),
  "counts": { "pass": $PASS, "fail": $FAIL }
}
EOF
chmod 600 "$OUT/report.json"
say "  报告：$OUT/report.json"
cat "$OUT/report.json"

head1 '结果'
say "PASS=$PASS  FAIL=$FAIL"
say "现场保留在：${WORK}"
[ "$FAIL" -eq 0 ] || exit 1
exit 0
