#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P8.1 —— 真机腿：**沙箱内**把常驻节点拉起来。
#
#   # 在沙箱里（不是宿主上）：
#   QIANMO_TRANSPORT_PSK=<与宿主同一把> \
#   QIANMO_REMOTE_ACTIVITY_URL=ws://<宿主地址>:<activity 端口> \
#   demo/env/remote/prepare-sandbox.sh --node node-b --agent reviewer --port 38622
#
# ⚠️ **本脚本未在真机验证**（同 prepare-host.sh，原因见 README.md）。它把
# `demo/p41-task-result.sh` / `demo/p31-resident-wake.sh` 头注里对「沙箱内那半边」的
# 要求写成了可执行步骤，但没有在真沙箱里跑过。
#
# 为什么这一步必须在沙箱里手动做：activator 的能力面只有 acquire / list 两个动作，
# **没有 exec**——这不是偷懒，正是 AC-6(c) 依赖的那条边界（见 packages/activator）。
# 宿主永远不能替沙箱把进程拉起来。
#
# 起来之后，把下面两件事告诉宿主：
#   ① 沙箱在 daemon 里的 name  → QIANMO_AC2_SANDBOX
#   ② 本进程的监听地址（宿主视角，容器地址不是回环）→ QIANMO_AC2_TARGET_URL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${QIANMO_REPO_DIR:-$(cd "$SCRIPT_DIR/../../.." && pwd)}"

NODE='node-b'
AGENT='reviewer'
PORT='38622'
WORKSPACE=''
SKIP_BUILD=0
FOREGROUND=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --node) NODE="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --workspace) WORKSPACE="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    -h|--help) sed -n '4,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'prepare-sandbox: 未知参数 %s\n' "$1" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
head1() { printf '\n=== %s ===\n' "$*"; }
die()  { printf 'FAIL : %s\n' "$*" >&2; exit 1; }

[ -n "${QIANMO_TRANSPORT_PSK:-}" ] || die '缺 QIANMO_TRANSPORT_PSK（必须与宿主那把逐字相同）'

# 长度也要在这里判：短 PSK 过得了上面的「非空」，却会在 §4 起常驻时被
# `assertUsablePsk` 抛 WeakSecretError 打死——那已经是 `bun install` + `bun run build`
# 之后的事了，真机实测（2026-08-16，burn-vm-01 沙箱内）白等约 70 s 才看到一段栈。
# 前置检查存在的意义就是别让这种错拖到那么后面。
# 数值不在本文件里另写一份：从 `assertUsablePsk` 的出处现读（CLAUDE.md §1.1⑧）。
PSK_MIN="$(awk -F'[= ]+' '/^export const PSK_MIN_LENGTH/ { print $(NF); exit }' \
  "$REPO_DIR/packages/transport/src/handshake.ts" 2>/dev/null || true)"
case "$PSK_MIN" in
  '' | *[!0-9]*) : ;;  # 读不出来就不判，不拿猜的数拦人
  *)
    if [ "${#QIANMO_TRANSPORT_PSK}" -lt "$PSK_MIN" ]; then
      die "QIANMO_TRANSPORT_PSK 只有 ${#QIANMO_TRANSPORT_PSK} 个字符，至少要 ${PSK_MIN}（出处：packages/transport/src/handshake.ts 的 PSK_MIN_LENGTH）"
    fi
    ;;
esac

# 沙箱里的状态一律放沙箱本地目录，不去猜宿主挂了什么进来。
SANDBOX_ROOT="${QIANMO_SANDBOX_DEMO_ROOT:-$HOME/.qianmo-demo-sandbox}"
CONFIG_DIR="$SANDBOX_ROOT/config"
STATE_DIR="$SANDBOX_ROOT/state"
[ -n "$WORKSPACE" ] || WORKSPACE="$SANDBOX_ROOT/workspace"

head1 '1. 前置检查'
command -v bun >/dev/null 2>&1 || die 'bun 不在 PATH 上。装法见 docs/dev/demo-env.md §2（沙箱镜像里通常要自己装）'
say "bun  : $(bun --version)"
BUN_PIN="$(awk '$1 == "bun" { print $2 }' "$REPO_DIR/.tool-versions" 2>/dev/null || true)"
if [ -n "$BUN_PIN" ] && [ "$(bun --version)" != "$BUN_PIN" ]; then
  say "WARN : bun 与 .tool-versions 的 $BUN_PIN 不一致 —— 跨架构沙箱里这很常见，记录进验收报告"
fi
[ -d "$REPO_DIR/packages/resident" ] || die "$REPO_DIR 看起来不是阡陌仓库"

head1 '2. 依赖与构建'
cd "$REPO_DIR"
bun install --frozen-lockfile
if [ "$SKIP_BUILD" = '1' ]; then
  say '按 --skip-build 跳过构建'
else
  bun run build
fi
OCC="$REPO_DIR/dist/cli-node.js"
[ -f "$OCC" ] || die "缺 $OCC"

head1 '3. 目录'
mkdir -p "$CONFIG_DIR" "$STATE_DIR" "$WORKSPACE"
chmod 700 "$SANDBOX_ROOT" "$CONFIG_DIR"
say "配置根 : $CONFIG_DIR"
say "工作区 : $WORKSPACE"

head1 '4. 启动常驻节点'
TIMINGS="$STATE_DIR/resident-timings.jsonl"
# `--open-policy` 与 demo/env/up.sh 同一条理由（key-distribution.md §9.3）：
# 默认自 P12.4 起是 SIGNED_TASK_POLICY，而演示链路的发送方不出示 capability
# 令牌。要在这条沙箱腿上验强制策略，去掉这一行并让发送方带令牌，两件事一起做。
# `--audit-signed-tasks` 与逃生开关成对，维持 §9.2 阶段 ① 的开放运行态时，仍把
# 每条若强制策略会拒绝的消息写入审计，供观察窗口取数。
set -- resident \
  --node "$NODE" \
  --team "${QIANMO_DEMO_TEAM:-atlas}" \
  --agent "${AGENT}=${WORKSPACE}" \
  --port "$PORT" \
  --hostname "${QIANMO_REMOTE_BIND:-0.0.0.0}" \
  --open-policy \
  --audit-signed-tasks \
  --timings "$TIMINGS"
# activity 上报是「沙箱内有活干 → 宿主别让我冻上」这条链路的沙箱半边（P3.1）。
# 没给就不接，节点照样能跑，只是不会自己保活。
if [ -n "${QIANMO_REMOTE_ACTIVITY_URL:-}" ]; then
  set -- "$@" --activity-url "$QIANMO_REMOTE_ACTIVITY_URL"
else
  say 'WARN : 未给 QIANMO_REMOTE_ACTIVITY_URL —— 不上报活动，沙箱会照常冻结'
fi

say "命令 : occ $*"
if [ "$FOREGROUND" = '1' ]; then
  exec env OCC_CONFIG_DIR="$CONFIG_DIR" OCC_IDENTITY=qianmo bun "$OCC" "$@"
fi

OUT="$STATE_DIR/resident.out"
ERR="$STATE_DIR/resident.err"
OCC_CONFIG_DIR="$CONFIG_DIR" OCC_IDENTITY=qianmo nohup bun "$OCC" "$@" >"$OUT" 2>"$ERR" &
PID=$!
printf '%s\n' "$PID" >"$STATE_DIR/resident.pid"
sleep 3
kill -0 "$PID" 2>/dev/null || { tail -20 "$ERR" >&2; die '常驻节点未能保持运行'; }

head1 '就绪'
say "pid     : $PID"
say "stdout  : $OUT （首行含本节点公钥，P4.3 的 --trust 要用）"
say "timings : $TIMINGS （p31/p41 的独立核验从这里取）"
say ''
say '回宿主设置：'
say "  QIANMO_AC2_TARGET_URL=ws://<本沙箱在宿主视角的地址>:${PORT}"
say '  QIANMO_AC2_SANDBOX=<本沙箱在 daemon 里的 name>'
say "  QIANMO_AC2_NODE=${NODE}  QIANMO_AC2_AGENT=${AGENT}"
