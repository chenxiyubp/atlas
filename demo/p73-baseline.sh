#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P7.3 消息吞吐阶梯：八档 1/5/10/25/50/100/200/400 msg/s，三个配置各跑一遍。
#
#   QIANMO_TRANSPORT_PSK=... ./demo/p73-baseline.sh --tier T3 --minutes 45
#   QIANMO_TRANSPORT_PSK=... ./demo/p73-baseline.sh --tier T1 --tier-seconds 20 --minutes 10   # 校准
#   QIANMO_TRANSPORT_PSK=... ./demo/p73-baseline.sh --tier T2 --senders 3                      # 多身份
#
# 判据（`demo/lib/p73-report-core.ts`）—— **它们是观测，不是门禁**（章程 N-12）：
#   ① 有档位可读；
#   ② 每一档都判出了结论（没有延迟样本的档判 unclassified，那是缺数据不是「没超限」）；
#   ③ 发送端计数与盘上审计计数对得上（T1 无审计，单来源，报告里标明）；
#   ④ 内存采样连续（断档标成区间，不无声跳过）；
#   ⑤ 采样通道没降级（macOS 的 ps 兜底只算仪器校准）；
#   ⑥ 没有 writer 队列溢出警告（有一条就整份不可用）。
#
# 档间静默默认 65 s，**别调短**：它要同时泄空去重表（> LIMITS.defaultTtlMs）与填满入站
# 预算的令牌桶（≥ 60 s）。只满足第一个的话，撞过预算的档位会压低它之后每一档的天花板，
# 表上会长得像「系统在高档位更差」。理由写在 demo/lib/p73-throughput.ts 的 cooldownSeconds。
#
# 红了的处置是**写进 `docs/dev/baseline-m0.md` §7「发现但不修」**，不是去改被测代码。
#
# **数据产物默认保留**（与 `chaos-inject.sh` 相反）：原始数据就是这个任务包的交付物，
# 跑完即删等于跑了个寂寞。目录 0700、文件 0600，路径打在 stdout 上。
#
# 内存采样是**另一条腿**，本脚本不起它——它要挂在一个真的常驻进程上：
#   occ resident ... --mem-sample /srv/p73/mem-inproc.ndjson --mem-interval-ms 60000
#   bun run "$(demo_entry p73-sample)" --resident-pid <pid> --out /srv/p73/mem-external.ndjson
#   （先 `. demo/lib/entry.sh`；投出去的树上没有 node_modules，直接跑 demo/lib/*.ts 会解析不出 @qianmo/*）
# 两份采样文件之后用 --mem-file / --resident-log 一起折进本脚本的报告。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"

if [ -z "${QIANMO_TRANSPORT_PSK:-}" ]; then
  printf 'p73-baseline: missing required environment variable QIANMO_TRANSPORT_PSK\n' >&2
  exit 2
fi

command -v bun >/dev/null 2>&1 || {
  printf 'p73-baseline: bun is not in PATH\n' >&2
  exit 2
}

WORK="${P73_WORK_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/p73-baseline.XXXXXX")}"
mkdir -p "$WORK"
chmod 700 "$WORK"
printf 'P7.3 现场目录（默认保留）：%s\n' "$WORK"

cd "$REPO_DIR"
exec bun run "$(demo_entry p73-throughput)" --out "$WORK/tiers.ndjson" "$@"
