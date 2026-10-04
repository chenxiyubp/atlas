#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# P5.1 / AC-7 环节 2 一键复现：五类故障的原因级诊断准确率。
#
# 注入器造的是**真的失败**——超时真被杀、OOM 真把堆撑爆、缺依赖真去执行不存在的程序、
# 磁盘满真写到写不进去（Linux 用 /dev/full，macOS 用 1 MiB 的真卷）、额度耗尽真去请求
# 一个真返回 429 的本地服务。标注只进报告，分类器只看观测。
#
# 判据：5 类各 10 次、共 50 条、准确率 ≥ 80%，且每类不得低于 50%、不得出现 unknown、
# 每条判定都要带依据。报告是一行 JSON，退出码即结论。
#
# 不需要沙箱、不需要 daemon、不需要模型凭据。OOM 那一类会真的吃内存，别在紧张的机器上跑。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# demo/lib 入口解析（`demo_entry`）：投出去的树上没有 node_modules，源文件里的
# @qianmo/* 解析不出来，要用构建产物。理由见 demo/lib/entry.sh。
# shellcheck source=demo/lib/entry.sh
. "$REPO_DIR/demo/lib/entry.sh"

for tool in bun node sh; do
  command -v "$tool" >/dev/null 2>&1 || {
    printf 'p51-diagnosis: %s is not in PATH\n' "$tool" >&2
    exit 2
  }
done

cd "$REPO_DIR"
bun run "$(demo_entry p51-diagnosis)" "$@"
