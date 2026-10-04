#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P8.2 全量验收走查驱动 —— 把「不需要人的那部分」一次跑完，并留下可机器核对的证据。
#
#   demo/walkthrough.sh --out <dir> [--with-ac7] [--with-chaos <minutes>] [--skip-slow] [--only <ids>]
#
# 默认跑的是**本机腿**（不需要真机、不需要凭据）：
#   ac3    AC-3      demo/ac3-loop-rate.sh          十条 check
#   ac6b   AC-6(b)(c) demo/ac6b-restore.sh          十一条 check
#   ac8    AC-8      bun test tests/boundary        确定性边界库
#   ac1    AC-1      demo/ac1-restart.sh            **只覆盖脚本部分**；判据②在脚本内恒 SKIP，本驱动如实记
# 可选加跑：
#   --with-ac7        make -C demo p61-accept（SEED=6101 MINUTES=10 CHUNKS=20，3 轮 × 10 min）
#   --with-chaos <N>  demo/chaos-inject.sh --minutes <N>
# 有凭据时自动追加（**只探测变量存在与否，不打印值、不落盘**）：
#   ac4    AC-4      bun test tests/integration/qianmo-memory-recall.test.ts
#   ac5    AC-5      bun test tests/integration/provider-adapter-consistency.test.ts
#   ac5e2e AC-5      p1.4-provider-verification.md §3.2 的「命令行逐字相同、只改配置文件」两跑
#
# 证据形态（三样，缺一不可）
#   ① transcript：每一项都跑在 `script -q` 下，落一份**完整终端 transcript**。
#      它替代的是「录屏文件」这一交付形态：同样是逐行不可裁剪的现场输出，且带 sha256 可核。
#      它**不替代**：真人念出的口头限定（诚实边界）、镜头对准某一行的强调、以及真机/凭据本身。
#   ② 报告 JSON：各 demo 自己 emit 的那一行 JSON（判据的机器形态），单独抽出存盘。
#   ③ summary.json / SUMMARY.md：每项 pass/fail/skip + 依据行 + transcript sha256 + 起止时间 + 退出码。
#
# 产物目录默认 `~/qianmo-acceptance/<UTC 时间戳>/`，目录 0700、文件 0600，**在仓库外**
# （按项目惯例验收产物不进仓库，仓库里只留 sha256 与关键数字）。
#
# 各子命令需要的 PSK / backup token 由本脚本**每次现生成临时值**注入，用完即弃，
# 不复用 `demo/env/`（那是 P8.1 的演示拓扑，两回事），也不落盘。
#
# 退出码：全部项 pass 为 0；有 fail 为 1；用法错误为 2。skip 不影响退出码。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOL_VERSION='0.1.0'

# 走查顺序：快项在前，慢项在后，最长的混沌跑批垫底。
ALL_IDS='ac3 ac6b ac8 ac1 ac4 ac5 ac5e2e ac1c2 ac7 chaos'
DEFAULT_IDS='ac3 ac6b ac8 ac1'
SLOW_IDS='ac1 ac7 chaos'
CRED_IDS='ac4 ac5 ac5e2e ac1c2'

OUT=''
WITH_AC7=0
CHAOS_MINUTES=0
SKIP_SLOW=0
ONLY=''

die() {
  printf 'walkthrough: %s\n' "$*" >&2
  exit 2
}

usage() {
  sed -n '3,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------- 参数

while [ $# -gt 0 ]; do
  case "$1" in
    --out)
      [ $# -ge 2 ] || die '--out 需要一个目录'
      OUT="$2"
      shift 2
      ;;
    --with-ac7)
      WITH_AC7=1
      shift
      ;;
    --with-chaos)
      [ $# -ge 2 ] || die '--with-chaos 需要分钟数'
      case "$2" in
        '' | *[!0-9]*) die "--with-chaos 需要正整数分钟，收到 '$2'" ;;
      esac
      [ "$2" -gt 0 ] || die '--with-chaos 需要正整数分钟'
      CHAOS_MINUTES="$2"
      shift 2
      ;;
    --skip-slow)
      SKIP_SLOW=1
      shift
      ;;
    --only)
      [ $# -ge 2 ] || die '--only 需要逗号分隔的项目 id'
      ONLY="$2"
      shift 2
      ;;
    --list)
      printf '%s\n' $ALL_IDS
      exit 0
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "未知参数 '$1'（--help 看用法）" ;;
  esac
done

# ---------------------------------------------------------------- 步骤元数据

# 每个 id 对应的 AC 编号、一句话标签、以及要敲的命令。
step_ac() {
  case "$1" in
    ac1) printf 'AC-1' ;;
    ac3) printf 'AC-3' ;;
    ac6b) printf 'AC-6(b)(c)' ;;
    ac8) printf 'AC-8' ;;
    ac7) printf 'AC-7' ;;
    chaos) printf 'AC-8' ;;
    ac4) printf 'AC-4' ;;
    ac5 | ac5e2e) printf 'AC-5' ;;
    ac1c2) printf 'AC-1' ;;
  esac
}

step_label() {
  case "$1" in
    ac1) printf '进程重启后凭持久化会话恢复（脚本部分；判据②脚本内恒 SKIP）' ;;
    ac3) printf '消息循环即时切断 + 两层限流各自生效' ;;
    ac6b) printf '删库可恢复 / 备份删不掉（本机腿，挂载边界不在此列）' ;;
    ac8) printf '通信边界确定性回归库' ;;
    ac7) printf '数模场景端到端连续演示 3 轮 × 10 min' ;;
    chaos) printf "混沌注入跑批 ${CHAOS_MINUTES} min" ;;
    ac4) printf '项目记忆跨会话检索唤醒（真调用）' ;;
    ac5) printf '模型中立：适配器一致性三项 × 两条 provider' ;;
    ac5e2e) printf '模型中立：命令行逐字相同、只改配置文件的两跑' ;;
    ac1c2) printf '判据②：不重放历史即可续答（真调用现场，kill -9 后 --resume 追问）' ;;
  esac
}

step_command() {
  case "$1" in
    ac1) printf 'bash demo/ac1-restart.sh' ;;
    ac3) printf 'bash demo/ac3-loop-rate.sh' ;;
    ac6b) printf 'bash demo/ac6b-restore.sh' ;;
    ac8) printf 'bun test tests/boundary' ;;
    ac7) printf 'make -C demo p61-accept SEED=6101 MINUTES=10 CHUNKS=20' ;;
    chaos) printf './demo/chaos-inject.sh --minutes %s' "$CHAOS_MINUTES" ;;
    ac4) printf 'bun test tests/integration/qianmo-memory-recall.test.ts' ;;
    ac5) printf 'bun test tests/integration/provider-adapter-consistency.test.ts' ;;
    ac5e2e) printf 'bun run scripts/qianmo-provider-task.ts --provider qianmo-ac5 --providers-file <tmp>（配置 A / 配置 B 各一次）' ;;
    ac1c2) printf 'bash demo/ac1-criterion2.sh' ;;
  esac
}

# 写进 runner 的真实命令体。**不含任何凭据字面量**：PSK / token 走环境变量继承。
step_body() {
  case "$1" in
    ac1) printf 'bash demo/ac1-restart.sh\n' ;;
    ac3) printf 'bash demo/ac3-loop-rate.sh\n' ;;
    ac6b) printf 'bash demo/ac6b-restore.sh\n' ;;
    ac8) printf 'bun test tests/boundary\n' ;;
    ac7) printf 'make -C demo p61-accept SEED=6101 MINUTES=10 CHUNKS=20\n' ;;
    chaos) printf './demo/chaos-inject.sh --minutes %s\n' "$CHAOS_MINUTES" ;;
    ac4) printf 'bun test tests/integration/qianmo-memory-recall.test.ts\n' ;;
    ac5) printf 'bun test tests/integration/provider-adapter-consistency.test.ts\n' ;;
    ac5e2e)
      # §3.2 的「命令行逐字相同、只改配置文件」形态：两条 bun run 逐字相同。
      printf "cp tests/integration/fixtures/ac5-config-a.json '%s'\n" "$WORK/ac5-providers.json"
      printf "bun run scripts/qianmo-provider-task.ts --provider qianmo-ac5 --providers-file '%s'\n" "$WORK/ac5-providers.json"
      printf "cp tests/integration/fixtures/ac5-config-b.json '%s'\n" "$WORK/ac5-providers.json"
      printf "bun run scripts/qianmo-provider-task.ts --provider qianmo-ac5 --providers-file '%s'\n" "$WORK/ac5-providers.json"
      ;;
    ac1c2) printf "AC1C2_OUT='%s' bash demo/ac1-criterion2.sh\n" "$OUT/ac1c2-artifacts" ;;
  esac
}

in_list() {
  local needle="$1" item
  shift
  for item in $*; do
    if [ "$item" = "$needle" ]; then return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- 前置检查

command -v bun >/dev/null 2>&1 || die 'bun 不在 PATH 上'
command -v script >/dev/null 2>&1 || die 'script(1) 不在 PATH 上 —— transcript 靠它'
command -v git >/dev/null 2>&1 || die 'git 不在 PATH 上'

if command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | awk '{print $1}'; }
else
  die '既没有 shasum 也没有 sha256sum —— 证据摘要算不出来'
fi

# 凭据只探测存在与否。**不读值、不打印、不落盘。**
HAVE_CREDS=0
if [ -n "${OPENAI_API_KEY:-}" ] && [ -n "${OPENAI_BASE_URL:-}" ]; then
  HAVE_CREDS=1
fi

# ---------------------------------------------------------------- 选项 → 选中项

SELECTED=''
if [ -n "$ONLY" ]; then
  for id in $(printf '%s' "$ONLY" | tr ',' ' '); do
    in_list "$id" "$ALL_IDS" || die "--only 里的 '$id' 不是已知项（--list 看全集）"
    SELECTED="$SELECTED $id"
  done
else
  SELECTED="$DEFAULT_IDS"
  if [ "$WITH_AC7" -eq 1 ]; then SELECTED="$SELECTED ac7"; fi
  if [ "$CHAOS_MINUTES" -gt 0 ]; then SELECTED="$SELECTED chaos"; fi
  if [ "$HAVE_CREDS" -eq 1 ]; then SELECTED="$SELECTED $CRED_IDS"; fi
fi

# 按 ALL_IDS 的规范顺序重排，并去重。
ORDERED=''
for id in $ALL_IDS; do
  if in_list "$id" "$SELECTED"; then
    ORDERED="$ORDERED $id"
  fi
done
SELECTED="$ORDERED"
[ -n "$(printf '%s' "$SELECTED" | tr -d ' ')" ] || die '没有选中任何项'

# 慢项在 --skip-slow 下不跑，但**如实记为 skip**，不从表里消失。
skip_reason() {
  local id="$1"
  if [ "$SKIP_SLOW" -eq 1 ] && in_list "$id" "$SLOW_IDS"; then
    printf '--skip-slow：本项属慢项（%s），本次未跑' "$(printf '%s' "$SLOW_IDS" | tr ' ' '/')"
    return 0
  fi
  if in_list "$id" "$CRED_IDS" && [ "$HAVE_CREDS" -eq 0 ]; then
    printf '无 provider 凭据（OPENAI_API_KEY / OPENAI_BASE_URL 未设），本项未跑'
    return 0
  fi
  if [ "$id" = 'ac7' ] && [ "$WITH_AC7" -eq 0 ] && [ -z "$ONLY" ]; then
    printf '未加 --with-ac7'
    return 0
  fi
  if [ "$id" = 'chaos' ] && [ "$CHAOS_MINUTES" -eq 0 ]; then
    printf '未加 --with-chaos <minutes>'
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------- 产物目录

umask 077 # 目录 0700、文件 0600，本进程与所有子进程一致

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
if [ -z "$OUT" ]; then
  OUT="${HOME}/qianmo-acceptance/${STAMP}"
fi
mkdir -p "$OUT"
chmod 700 "$OUT"
OUT="$(cd "$OUT" && pwd)"

case "$OUT" in
  "$REPO_DIR" | "$REPO_DIR"/*)
    die "产物目录不能落在仓库内（$OUT）—— 验收产物不进仓库"
    ;;
esac

WORK="$(mktemp -d "${TMPDIR:-/tmp}/qianmo-walkthrough.XXXXXX")"
chmod 700 "$WORK"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT INT TERM

# 临时秘密：每次现生成，只进环境变量，不进 runner 文件、不进产物目录。
gen_secret() {
  # 32 字节 CSPRNG → 64 hex（PSK 下限 16 字符，token 下限 16 字符，这里远超）
  od -An -tx1 -N 32 /dev/urandom | tr -d ' \n'
}
QIANMO_TRANSPORT_PSK="$(gen_secret)"
QIANMO_BACKUP_WRITE_TOKEN="$(gen_secret)"
QIANMO_BACKUP_ARCHIVE_TOKEN="$(gen_secret)"
export QIANMO_TRANSPORT_PSK QIANMO_BACKUP_WRITE_TOKEN QIANMO_BACKUP_ARCHIVE_TOKEN
export QIANMO_P61_KEEP_ARTIFACTS=1

# ---------------------------------------------------------------- 环境快照

GIT_HEAD="$(git -C "$REPO_DIR" rev-parse HEAD)"
GIT_SHORT="$(git -C "$REPO_DIR" rev-parse --short HEAD)"
GIT_BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"
GIT_DIRTY='false'
if [ -n "$(git -C "$REPO_DIR" status --porcelain)" ]; then GIT_DIRTY='true'; fi
UNAME_ALL="$(uname -a)"
OS_NAME="$(uname -s)"
BUN_VERSION="$(bun --version 2>/dev/null || printf 'n/a')"
NODE_VERSION="$(node --version 2>/dev/null || printf 'n/a')"
MAKE_VERSION="$(make --version 2>/dev/null | head -1 || printf 'n/a')"
OS_VERSION='n/a'
if [ "$OS_NAME" = 'Darwin' ] && command -v sw_vers >/dev/null 2>&1; then
  OS_VERSION="$(sw_vers -productName) $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
fi

# ---------------------------------------------------------------- 小工具

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now_s() { date +%s; }

# JSON 字符串转义：反斜杠、双引号、控制字符（后者直接丢，证据行里不该有）。
json_escape() {
  printf '%s' "$1" | tr -d '\000-\010\013\014\016-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# 从 transcript 里洗出可 grep 的文本。transcript 是 pty 录的，所以要处理三样：
#   ① 裸 CR（进度条覆写）→ 换行，否则锚定的 grep 会被前一段进度粘住；
#   ② ANSI 转义序列（pty 下 bun/biome 都会上色）；
#   ③ 其余控制字符。
ESC=$(printf '\033')
clean_text() {
  tr '\r' '\n' <"$1" | sed "s/${ESC}\[[0-9;?]*[a-zA-Z]//g" | tr -d '\000-\010\013\014\016-\037'
}

# 取一行 JSON 里某个标量字段（不引 jq 依赖；只用于本脚本已知形状的报告）。
json_scalar() {
  sed -n "s/.*\"$2\": *\"\{0,1\}\([^,\"}]*\)\"\{0,1\}.*/\1/p" "$1" | head -1
}

# ---------------------------------------------------------------- 跑一项

RECORDS="$WORK/records"
mkdir -p "$RECORDS"
RECORD_N=0
N_PASS=0
N_FAIL=0
N_SKIP=0

# 把一条记录写成 JSON 片段。
record() {
  RECORD_N=$((RECORD_N + 1))
  cat >"$RECORDS/$(printf '%03d' "$RECORD_N").json"
}

run_with_script() {
  # $1 transcript 路径，$2 runner 路径。stdin 必须给 /dev/null：
  # 非交互环境下 BSD script 对 socket stdin 会 tcgetattr 失败。
  case "$OS_NAME" in
    Darwin) script -q -F "$1" /usr/bin/env bash "$2" </dev/null ;;
    *) script -q -e -f -c "bash '$2'" "$1" </dev/null ;;
  esac
}

# 报告 JSON 的 checks 计数（"checks":{...} 里 true / false 各几个）。
checks_counts() {
  local seg
  seg="$(sed -n 's/.*"checks":{\([^}]*\)}.*/\1/p' "$1" | head -1)"
  if [ -z "$seg" ]; then
    printf '0 0'
    return
  fi
  local t f
  t="$(printf '%s' "$seg" | tr ',' '\n' | grep -c ':true' || true)"
  f="$(printf '%s' "$seg" | tr ',' '\n' | grep -c ':false' || true)"
  printf '%s %s' "$t" "$f"
}

# 每一项的「依据行」：从报告 JSON 或 transcript 里抠出走查时要念的那几个数。
collect_evidence() {
  local id="$1" report="$2" text="$3"
  case "$id" in
    ac3)
      [ -s "$report" ] || return 0
      printf 'pass=%s\n' "$(json_scalar "$report" pass)"
      printf 'hopCountAtCut=%s maxHops=%s\n' \
        "$(json_scalar "$report" hopCountAtCut)" "$(json_scalar "$report" maxHops)"
      printf 'senderAgents=%s\n' "$(json_scalar "$report" senderAgents)"
      ;;
    ac6b)
      [ -s "$report" ] || return 0
      printf 'pass=%s\n' "$(json_scalar "$report" pass)"
      printf 'elapsedMs=%s statusLines=%s\n' \
        "$(json_scalar "$report" elapsedMs)" "$(json_scalar "$report" statusLines)"
      ;;
    chaos)
      [ -s "$report" ] || return 0
      printf 'pass=%s seed=%s\n' "$(json_scalar "$report" pass)" "$(json_scalar "$report" seed)"
      printf 'delivered=%s\n' "$(json_scalar "$report" delivered)"
      sed -n 's/.*"byKind":\[\(.*\)\],"unmapped".*/byKind=\1/p' "$report" | head -1
      if grep -o '"unmapped":\[\]' "$report" >/dev/null 2>&1; then printf 'unmapped=0\n'; fi
      ;;
    ac7)
      grep -E '^\{' "$text" | while IFS= read -r line; do
        printf 'pass=%s ac7Eligible=%s durationMs=%s\n' \
          "$(printf '%s' "$line" | sed -n 's/.*"pass":\([a-z]*\).*/\1/p')" \
          "$(printf '%s' "$line" | sed -n 's/.*"ac7Eligible":\([a-z]*\).*/\1/p')" \
          "$(printf '%s' "$line" | sed -n 's/.*"durationMs":\([0-9]*\).*/\1/p')"
      done
      grep -o '"resultDigest":"[0-9a-f]\{12\}' "$text" | sed 's/"resultDigest":"/resultDigest=/' | sort -u
      ;;
    ac1)
      grep -E '^(PASS|FAIL|WARN|SKIPPED)=' "$text" | tail -1 || true
      grep -E '冷启动到会话就绪' "$text" || true
      grep -cE '^WARN: ' "$text" | sed 's/^/WARN 行数=/' || true
      ;;
    ac8 | ac4 | ac5)
      grep -E '^ *[0-9]+ (pass|fail|skip)' "$text" || true
      grep -E '^Ran [0-9]+ tests' "$text" || true
      ;;
    ac5e2e)
      grep -E '"passed":|退出码|5 pass' "$text" | tail -6 || true
      ;;
    ac1c2)
      grep -E '^PASS=|"pass":|引用了' "$text" | tail -4 || true
      ;;
  esac
}

run_step() {
  local id="$1" ac label cmd runner transcript stdout_f report_f
  ac="$(step_ac "$id")"
  label="$(step_label "$id")"
  cmd="$(step_command "$id")"
  transcript="$OUT/${id}.transcript.log"
  stdout_f="$OUT/${id}.stdout.txt"
  report_f="$OUT/${id}-report.json"
  runner="$WORK/${id}-runner.sh"

  local reason
  if reason="$(skip_reason "$id")"; then
    N_SKIP=$((N_SKIP + 1))
    printf '[skip] %-6s %s —— %s\n' "$id" "$ac" "$reason"
    record <<EOF
{
  "id": "$id",
  "ac": "$ac",
  "label": "$(json_escape "$label")",
  "status": "skip",
  "command": "$(json_escape "$cmd")",
  "reason": "$(json_escape "$reason")"
}
EOF
    return 0
  fi

  {
    printf '#!/usr/bin/env bash\n'
    printf '# 由 demo/walkthrough.sh 生成；PSK/token 走环境变量继承，本文件不含任何秘密。\n'
    printf "cd '%s'\n" "$REPO_DIR"
    printf 'printf "=== %%s ===\\n" "%s / %s"\n' "$ac" "$id"
    printf 'printf "HEAD=%%s branch=%%s\\n" "%s" "%s"\n' "$GIT_SHORT" "$GIT_BRANCH"
    printf 'printf "开始 %%s\\n" "$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)"\n'
    printf 'step() {\n'
    printf '  set -e\n'
    step_body "$id" | sed 's/^/  /'
    printf '}\n'
    # stderr 直通 pty（保持与 stdout 的真实交错），stdout 另抄一份供抽报告 JSON。
    printf "{ step 2>&3 | tee '%s'; rc=\${PIPESTATUS[0]}; } 3>&2\n" "$stdout_f"
    printf 'printf "结束 %%s 退出码 %%s\\n" "$(date -u +%%Y-%%m-%%dT%%H:%%M:%%SZ)" "$rc"\n'
    printf "printf '%%s\\\\n' \"\$rc\" > '%s'\n" "$WORK/${id}.rc"
    printf 'exit "$rc"\n'
  } >"$runner"

  local started started_s finished finished_s rc marker
  started="$(now_iso)"
  started_s="$(now_s)"
  CURRENT_ID="$id" # 中止信号处理器靠它知道是哪一项跑到一半
  printf '[run ] %-6s %s %s …\n' "$id" "$ac" "$label"
  marker="$WORK/${id}.marker"
  : >"$marker"
  rm -f "$WORK/${id}.rc"
  run_with_script "$transcript" "$runner" || true
  finished="$(now_iso)"
  finished_s="$(now_s)"
  if [ -f "$WORK/${id}.rc" ]; then
    rc="$(cat "$WORK/${id}.rc")"
  else
    rc='127' # runner 没跑到写 rc 那一步
  fi

  # 报告 JSON：认 `"checks":{` 而不是「以 `{` 开头」。
  # 理由是实测踩到的：p61 每轮先由 p61-seed 打一行数据集 JSON，只按行首 `{` 抓会把
  # 三条种子行也当成报告，一轮变两条。判据的机器形态一定带 checks，这个特征更准。
  local clean="$WORK/${id}.clean.txt" jsonl="$OUT/${id}-report.jsonl" njson=0
  clean_text "$transcript" >"$clean"
  if [ -s "$stdout_f" ]; then
    grep -E '^\{.*"checks": *\{' "$stdout_f" >"$jsonl" 2>/dev/null || true
  else
    grep -E '^\{.*"checks": *\{' "$clean" >"$jsonl" 2>/dev/null || true
  fi
  if [ -s "$jsonl" ]; then
    njson="$(wc -l <"$jsonl" | tr -d ' ')"
    if [ "$njson" = '1' ]; then
      cp "$jsonl" "$report_f"
      rm -f "$jsonl"
    fi
  else
    rm -f "$jsonl"
  fi

  # AC-7：p61 每轮把 report.json 留在自己的运行目录里，一并抄回来。
  # **按 mtime 从旧到新**排，那才是三轮的先后；`mkdtemp` 的随机后缀字典序与轮次无关
  # （第一版按字典序排，实测把第 3 轮标成了 run-1）。
  if [ "$id" = 'ac7' ]; then
    local n=0 d dirs
    dirs="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -type d -name 'qianmo-p61-*' -newer "$marker" 2>/dev/null || true)"
    if [ -n "$dirs" ]; then
      for d in $(printf '%s\n' "$dirs" | xargs ls -dtr 2>/dev/null || true); do
        [ -f "$d/report.json" ] || continue
        n=$((n + 1))
        cp "$d/report.json" "$OUT/ac7-run-${n}.report.json"
      done
    fi
  fi

  local checks_t=0 checks_f=0 counts=''
  if [ -f "$report_f" ]; then
    counts="$(checks_counts "$report_f")"
    checks_t="${counts%% *}"
    checks_f="${counts##* }"
  fi

  local status
  if [ "$rc" = '0' ]; then
    status='pass'
    N_PASS=$((N_PASS + 1))
  else
    status='fail'
    N_FAIL=$((N_FAIL + 1))
  fi
  printf '[%-4s] %-6s %s 退出码 %s，用时 %s s\n' "$status" "$id" "$ac" "$rc" "$((finished_s - started_s))"

  # 依据行
  local ev_file="$WORK/${id}.evidence.txt"
  collect_evidence "$id" "$report_f" "$clean" >"$ev_file" 2>/dev/null || true
  local ev_json='' line first=1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [ "$first" -eq 1 ]; then
      first=0
    else
      ev_json="$ev_json,"
    fi
    ev_json="$ev_json
      \"$(json_escape "$line")\""
  done <"$ev_file"

  local note=''
  case "$id" in
    ac1) note='脚本第 5 节（判据②「不重放历史即可续答」）恒 SKIP：脚本刻意不读凭据、不发模型调用。本项只覆盖脚本部分。' ;;
    ac6b) note='本机腿只测凭据面与动词面；沙箱挂载边界不在本项覆盖内（AC-6(a) 与真机挂载另计）。' ;;
    ac7) note='逻辑双节点、脚本化授权、WebSocket+PSK 非 TLS、单向隧道、worker 与 runner 共用算法 —— 五条诚实边界不变。' ;;
    ac5e2e) note='两次运行命令行逐字相同，唯一变化是 --providers-file 指向的那份配置内容（A/B 两行不同）。' ;;
  esac

  local report_rel='' report_sha=''
  if [ -f "$report_f" ]; then
    report_rel="$(basename "$report_f")"
    report_sha="$(sha256_of "$report_f")"
  elif [ -f "$jsonl" ]; then
    report_rel="$(basename "$jsonl")"
    report_sha="$(sha256_of "$jsonl")"
  fi

  record <<EOF
{
  "id": "$id",
  "ac": "$ac",
  "label": "$(json_escape "$label")",
  "status": "$status",
  "command": "$(json_escape "$cmd")",
  "exitCode": $rc,
  "startedAt": "$started",
  "finishedAt": "$finished",
  "durationS": $((finished_s - started_s)),
  "transcript": {
    "file": "$(basename "$transcript")",
    "bytes": $(wc -c <"$transcript" | tr -d ' '),
    "sha256": "$(sha256_of "$transcript")"
  },
  "report": {
    "file": "$(json_escape "$report_rel")",
    "sha256": "$report_sha",
    "jsonLines": $njson
  },
  "checks": { "true": $checks_t, "false": $checks_f },
  "evidence": [$ev_json
  ],
  "note": "$(json_escape "$note")"
}
EOF
  CURRENT_ID=''
}

# ---------------------------------------------------------------- 汇总产物

# summary.json 与 SUMMARY.md 都由这里写。**必须定义在主循环之前**——中止信号
# 处理器要调它，而 bash 是自上而下执行的，定义晚一行就等于信号来时没有它。
write_reports() {
  RUN_FINISHED="$(now_iso)"
  RUN_FINISHED_S="$(now_s)"

  # ---------------------------------------------------------------- summary.json

  {
    printf '{\n'
    printf '  "tool": "demo/walkthrough.sh",\n'
    printf '  "toolVersion": "%s",\n' "$TOOL_VERSION"
    printf '  "startedAt": "%s",\n' "$RUN_STARTED"
    printf '  "finishedAt": "%s",\n' "$RUN_FINISHED"
    printf '  "durationS": %s,\n' "$((RUN_FINISHED_S - RUN_STARTED_S))"
    printf '  "outDir": "%s",\n' "$(json_escape "$OUT")"
    printf '  "repo": {\n'
    printf '    "head": "%s",\n' "$GIT_HEAD"
    printf '    "headShort": "%s",\n' "$GIT_SHORT"
    printf '    "branch": "%s",\n' "$(json_escape "$GIT_BRANCH")"
    printf '    "dirty": %s\n' "$GIT_DIRTY"
    printf '  },\n'
    printf '  "machine": {\n'
    printf '    "uname": "%s",\n' "$(json_escape "$UNAME_ALL")"
    printf '    "os": "%s",\n' "$(json_escape "$OS_VERSION")"
    printf '    "bun": "%s",\n' "$(json_escape "$BUN_VERSION")"
    printf '    "node": "%s",\n' "$(json_escape "$NODE_VERSION")"
    printf '    "make": "%s"\n' "$(json_escape "$MAKE_VERSION")"
    printf '  },\n'
    printf '  "credentials": { "openaiApiKey": %s, "openaiBaseUrl": %s },\n' \
      "$([ -n "${OPENAI_API_KEY:-}" ] && printf 'true' || printf 'false')" \
      "$([ -n "${OPENAI_BASE_URL:-}" ] && printf 'true' || printf 'false')"
    printf '  "options": { "withAc7": %s, "chaosMinutes": %s, "skipSlow": %s, "only": "%s" },\n' \
      "$([ "$WITH_AC7" -eq 1 ] && printf 'true' || printf 'false')" \
      "$CHAOS_MINUTES" \
      "$([ "$SKIP_SLOW" -eq 1 ] && printf 'true' || printf 'false')" \
      "$(json_escape "$ONLY")"
    printf '  "totals": { "pass": %s, "fail": %s, "skip": %s, "interrupted": %s },\n' \
      "$N_PASS" "$N_FAIL" "$N_SKIP" "$N_INT"
    printf '  "items": [\n'
    first=1
    for f in "$RECORDS"/*.json; do
      [ -f "$f" ] || continue
      if [ "$first" -eq 1 ]; then first=0; else printf ',\n'; fi
      sed 's/^/    /' "$f"
    done
    printf '\n  ]\n'
    printf '}\n'
  } >"$OUT/summary.json"

  # ---------------------------------------------------------------- SUMMARY.md

  {
    printf '# 阡陌 M0 验收走查 —— 本机腿自动走查记录\n\n'
    printf '| 项 | 内容 |\n|---|---|\n'
    printf '| 驱动 | `demo/walkthrough.sh` v%s |\n' "$TOOL_VERSION"
    printf '| 起 / 止（UTC） | %s / %s（%s s） |\n' "$RUN_STARTED" "$RUN_FINISHED" "$((RUN_FINISHED_S - RUN_STARTED_S))"
    printf '| HEAD | `%s`（`%s`，分支 `%s`，工作树%s） |\n' "$GIT_SHORT" "$GIT_HEAD" "$GIT_BRANCH" \
      "$([ "$GIT_DIRTY" = 'true' ] && printf '有改动' || printf '干净')"
    printf '| 机器 | %s |\n' "$UNAME_ALL"
    printf '| 运行时 | bun %s / node %s / %s |\n' "$BUN_VERSION" "$NODE_VERSION" "$MAKE_VERSION"
    printf '| 凭据 | OPENAI_API_KEY %s，OPENAI_BASE_URL %s（只探测存在与否） |\n' \
      "$([ -n "${OPENAI_API_KEY:-}" ] && printf '在' || printf '不在')" \
      "$([ -n "${OPENAI_BASE_URL:-}" ] && printf '在' || printf '不在')"
    printf '| 汇总 | pass %s / fail %s / skip %s / interrupted %s |\n\n' "$N_PASS" "$N_FAIL" "$N_SKIP" "$N_INT"
    printf '## 逐项\n\n'
    printf '| id | AC | 判定 | 退出码 | 用时 | checks | transcript sha256 |\n'
    printf '|---|---|---|---|---|---|---|\n'
    for f in "$RECORDS"/*.json; do
      [ -f "$f" ] || continue
      id="$(json_scalar "$f" id)"
      ac="$(json_scalar "$f" ac)"
      st="$(json_scalar "$f" status)"
      rc="$(json_scalar "$f" exitCode)"
      du="$(json_scalar "$f" durationS)"
      sha="$(sed -n 's/.*"sha256": "\([0-9a-f]*\)".*/\1/p' "$f" | head -1)"
      ct="$(sed -n 's/.*"true": \([0-9]*\).*/\1/p' "$f" | head -1)"
      cf="$(sed -n 's/.*"false": \([0-9]*\).*/\1/p' "$f" | head -1)"
      printf '| `%s` | %s | **%s** | %s | %s s | %s true / %s false | `%s` |\n' \
        "$id" "$ac" "$st" "${rc:--}" "${du:--}" "${ct:-0}" "${cf:-0}" "${sha:--}"
    done
    printf '\n## transcript 替代了什么、不替代什么\n\n'
    printf -- '- **替代**：录屏文件这一交付形态。每一项的完整终端输出逐行留在 `<id>.transcript.log` 里，'
    printf '带 sha256，可离线核对，且比录屏更可核（录屏没法 grep）。\n'
    printf -- '- **不替代**：真人在镜头前念出的口头限定（各 AC 的诚实边界）、对准某一行的强调、'
    printf '以及真机（AC-2 / AC-6(a)）与凭据（AC-1 判据② / AC-4 / AC-5）这两类本来就不在本机腿内的东西。\n'
    printf -- '- 真人录屏仍可在答辩前补拍，但**判定不再依赖它**。\n\n'
    printf '## 依据行（走查时要念的那几个数）\n\n'
    for f in "$RECORDS"/*.json; do
      [ -f "$f" ] || continue
      id="$(json_scalar "$f" id)"
      printf '### `%s`\n\n' "$id"
      sed -n '/"evidence": \[/,/^  \]/p' "$f" | sed -n 's/^ *"\(.*\)",\{0,1\}$/- `\1`/p' || true
      note="$(sed -n 's/.*"note": "\(.*\)"$/\1/p' "$f" | head -1)"
      if [ -n "$note" ]; then printf '\n> %s\n' "$note"; fi
      printf '\n'
    done
  } >"$OUT/SUMMARY.md"

  chmod 600 "$OUT"/* 2>/dev/null || true
  chmod 700 "$OUT"
}

# ---------------------------------------------------------------- 被打断时也要留下报告

# 一次 `--with-ac7 --with-chaos 60` 是九十多分钟的现场。若外部把进程 TERM 掉（CI 超时、
# 会话管理器的后台任务上限、操作员 Ctrl-C），默认行为是 WORK 连同已完成项的记录一起被
# 清掉，只剩一堆散落的 transcript ——**这正是本驱动第一次实跑时踩到的**。
# 所以信号处理器做三件事：把在跑的那项记为 interrupted、照常写出 summary、再清 WORK。
CURRENT_ID=''
N_INT=0

on_signal() {
  trap - INT TERM EXIT
  printf '\n收到中止信号：把已完成的项落成报告后退出。\n' >&2
  if [ -n "$CURRENT_ID" ]; then
    N_INT=$((N_INT + 1))
    local t="$OUT/${CURRENT_ID}.transcript.log" tsha='' tbytes=0
    if [ -f "$t" ]; then
      tsha="$(sha256_of "$t")"
      tbytes="$(wc -c <"$t" | tr -d ' ')"
    fi
    record <<EOF
{
  "id": "$CURRENT_ID",
  "ac": "$(step_ac "$CURRENT_ID")",
  "label": "$(json_escape "$(step_label "$CURRENT_ID")")",
  "status": "interrupted",
  "command": "$(json_escape "$(step_command "$CURRENT_ID")")",
  "transcript": { "file": "${CURRENT_ID}.transcript.log", "bytes": $tbytes, "sha256": "$tsha" },
  "note": "本项被外部信号中止，transcript 是残篇，**不得据此判 PASS 或 FAIL**；要判定必须重跑本项"
}
EOF
  fi
  write_reports
  printf '（部分）产物  %s\n' "$OUT" >&2
  rm -rf "$WORK"
  exit 130
}

# ---------------------------------------------------------------- 主流程

RUN_STARTED="$(now_iso)"
RUN_STARTED_S="$(now_s)"
trap on_signal INT TERM

printf '阡陌 P8.2 走查驱动 v%s\n' "$TOOL_VERSION"
printf '产物目录  %s\n' "$OUT"
printf 'HEAD      %s (%s) %s\n' "$GIT_SHORT" "$GIT_BRANCH" "$([ "$GIT_DIRTY" = 'true' ] && printf '工作树有改动' || printf '工作树干净')"
printf '机器      %s\n' "$UNAME_ALL"
printf '选中项    %s\n' "$SELECTED"
if [ "$HAVE_CREDS" -eq 0 ]; then
  printf 'AC-4/AC-5 跳过：无凭据，`source <凭据文件> && demo/walkthrough.sh --only ac4,ac5,ac5e2e` 即可补齐。\n'
else
  printf 'AC-4/AC-5：检测到 OPENAI_API_KEY 与 OPENAI_BASE_URL（只探测存在与否，不读值）。\n'
fi
printf '\n'

for id in $SELECTED; do
  run_step "$id"
done


write_reports

printf '\n汇总  pass %s / fail %s / skip %s\n' "$N_PASS" "$N_FAIL" "$N_SKIP"
printf '      本次没有被中止的项（interrupted %s）\n' "$N_INT"
printf '产物  %s\n' "$OUT"
printf '      summary.json / SUMMARY.md / <id>.transcript.log / <id>-report.json\n'
[ "$N_FAIL" -eq 0 ] || exit 1
exit 0
