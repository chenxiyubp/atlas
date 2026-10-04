#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# `demo_entry <入口名>` —— demo/lib 下某个入口**这台机器上跑得起来的那一份**。
#
# 只做这一件事，所以它谁都不依赖：`demo/env/` 与 `demo/env/beta/` 各有自己的
# common.sh，而 `demo/*.sh` 那批 AC 演示脚本一个 common 都不 source。把这段逻辑抄进
# 十一个脚本会立刻违反「同一个事实只允许存在于一个地方」，所以它自己成一个文件。
#
# ── 它挡的是什么 ──────────────────────────────────────────────────────────
#
# 舰队的投递载荷是 `dist` + `demo` 两块 —— 没有 `node_modules`，也没有 `packages/`。
# 而 `p81-registry.ts` / `p81-probe.ts` 这类入口 import 的是 `@qianmo/*` **workspace
# 包**，于是在投出去的树上它们是「文件在、跑不起来」：
#
#     error: Cannot find module '@qianmo/protocol' from '…/demo/lib/p81-probe.ts'
#
# 2026-08-27 在 p11 上部署时这个坑连响两次。第二次尤其坏：冒烟的八条地址拨号探针全崩，
# 而崩溃回溯的最后一行是 `Bun v1.3.13 (Linux x64)`，冒烟脚本把它当作失败原因原样报了
# 出来 ——「解析、拨号或 task.request 失败 —— Bun v1.3.13 (Linux x64)」。读起来像八个
# 节点全拨不通，实际是探针自己没起来，那一刻名册 8 条全在线。**一个报不出真话的自检
# 比没有自检更坏。**
#
# ── 怎么解决 ──────────────────────────────────────────────────────────────
#
# 构建期把这些入口打成自包含单文件落进 `dist/demo/`（`scripts/demoBundles.ts`，名单在
# 那里，与本文件是一对）。dist 本来就随载荷走，所以投出去的树自带一份跑得起来的。
#
# **先用构建产物，取不到才回落到源文件。**开发检出上没跑过构建也照常工作，只是走源文件
# 那条路（那里 node_modules 在，解析得出来）。两条路的真源都是 `demo/lib/*.ts`。

# 仓库根：本文件在 demo/lib/ 下，所以是 ../..。调用方可以先设好 REPO_DIR，设了就用它
# ——那批脚本自己算过一次，两处算出不同的根会是最难查的一类。
demo_entry() {
  local name="$1" root bundled source_file
  root="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
  bundled="$root/dist/demo/$name.js"
  source_file="$root/demo/lib/$name.ts"
  if [ -f "$bundled" ]; then printf '%s' "$bundled"; return 0; fi
  if [ -f "$source_file" ]; then printf '%s' "$source_file"; return 0; fi
  printf 'FAIL : 找不到 demo 入口 %s：%s 与 %s 都不存在\n' \
    "$name" "$bundled" "$source_file" >&2
  return 1
}
