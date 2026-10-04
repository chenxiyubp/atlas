#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 —— 把当前检出打成一个能送上机的源码包，并把源 commit 一起封进去。
#
#   demo/env/pack.sh [--output <tarball>]
#
# 它是 `demo/env/bootstrap.sh` 的**源端对半**：pack 在开发机上打包，bootstrap 在
# 机器上装依赖、构建。两条命令之间隔着一次 scp，而**源 commit 只在这一侧知道**。
#
# ── 为什么需要它（issue #70）────────────────────────────────────────────────
# 产物里的 `MACRO.SOURCE_COMMIT` 是 `scripts/defines.ts` 问 git 拿的，而部署树
# `~/atlas-beta/` 上没有 git 可问——送代码那一步排除了 `.git`（仓库根下还压着
# `.claude` 与含凭据的 `.occ`，裸同步是事故，见 docs/dev/demo-env.md §7.1）。
# 于是每台节点构建出来的产物都报 `sourceCommit=unknown`：一台机器上跑着的常驻节点
# 答不出自己是哪一版，验收报告里那一行也就没有意义。
#
# 这里在包里放一个 `.source-commit`，bootstrap 构建前读回来交给 defines.ts。
#
# ── 为什么用 `git archive` 而不是 `tar --exclude=…` ─────────────────────────
# ① 排除表是「记得写」才生效的，漏一条就可能把 `.occ` 里的凭据发出去；`git archive`
#    只出**跟踪文件**，`node_modules` / `dist` / `.claude` / `.occ` 天然不在其中。
# ② 它出的字节由 commit 决定：同一个 commit 打两次一样。排除表做不到这一点。
# ③ macOS 的 bsdtar 会给每个文件配一份 `._*` AppleDouble 分叉——线上那棵 `~/atlas-beta`
#    里积了 5588 个。`git archive` 不写扩展属性，包里干净。
#
# ── 脏树一律拒绝，没有 --allow-dirty ────────────────────────────────────────
# `git archive HEAD` 打的是 **HEAD 的字节**，不是工作树的字节。所以脏树上无论把戳写成
# 什么，它标的那个 commit 和包里的内容都还是对得上的——真正对不上的是操作者的预期：
# 他以为送出去的是眼前这棵树。给一个 `--allow-dirty` 只会把这个误解固化成一个选项。
# 要送未提交的改动，就先提交。

set -euo pipefail

# shellcheck source=demo/env/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

OUTPUT=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output)   OUTPUT="${2:-}"; shift 2 ;;
    --output=*) OUTPUT="${1#--output=}"; shift ;;
    -h|--help)
      demo_say '用法：pack.sh [--output <tarball>]'
      demo_say '默认输出 /tmp/atlas-src-<sha 前 12 位>.tar.gz'
      exit 0
      ;;
    *) demo_die "未知参数 $1" ;;
  esac
done

STARTED_AT="$(demo_now)"
cd "$REPO_DIR"

command -v git >/dev/null 2>&1 || demo_die 'git 不在 PATH 上'
# 判据借 common.sh 那个（realpath 比较 + HEAD 必须解析得出来），不在这里另写一份：
# 两边一旦分叉，就会出现「pack 认这是仓库、bootstrap 不认」这类各自成立的矛盾结论。
demo_tree_is_own_git_repo || demo_die \
  "${REPO_DIR} 不是一个 git 仓库的顶层（git 认的是 $(git rev-parse --show-toplevel 2>/dev/null || printf '<无>')）—— 打包必须在源端检出里跑"

# 脏树在这里就停。放行等于让「包里那个 SHA」与「操作者以为送出去的东西」分叉。
DIRTY_COUNT="$(git status --porcelain | wc -l | tr -d ' ')"
if [ "$DIRTY_COUNT" != '0' ]; then
  demo_say "工作树有 ${DIRTY_COUNT} 处未提交改动，前几条："
  git status --porcelain | head -n 10
  demo_die '打包只出 HEAD 的字节 —— 先提交，再打包'
fi

HEAD_SHA="$(git rev-parse HEAD)"
OUTPUT="${OUTPUT:-/tmp/atlas-src-${HEAD_SHA:0:12}.tar.gz}"

demo_head "打包 ${HEAD_SHA}"
demo_say "输出 : ${OUTPUT}"

# `--add-virtual-file` 把戳直接写进归档，不落地到工作树——落地的话，下一次
# `git status` 就多一个未跟踪文件，而上面那道脏树守卫会因为自己刚造的垃圾而拒绝下一次打包。
#
# 戳文件的形状（40 位小写十六进制）与 `demo_source_commit` 的校验、
# `scripts/defines.ts` 注进产物的值三处一致。
git archive --format=tar "--add-virtual-file=.source-commit:${HEAD_SHA}" HEAD \
  | gzip -n > "$OUTPUT"

BYTES="$(wc -c < "$OUTPUT" | tr -d ' ')"
demo_ok "已打包 $(( BYTES / 1024 / 1024 )) MiB（${BYTES} 字节）"
demo_ok "源 commit ${HEAD_SHA} 已封进包内的 .source-commit"
demo_say "耗时 : $(demo_elapsed "$STARTED_AT")"
demo_say ''
demo_say '上机（对每台机器）：'
demo_say "  scp ${OUTPUT} <host>:/tmp/"
demo_say "  ssh <host> 'mkdir -p ~/atlas-beta.next && tar -xzf /tmp/$(basename "$OUTPUT") -C ~/atlas-beta.next'"
demo_say '  # 换上去之后在新树里跑 demo/env/bootstrap.sh —— 它会读 .source-commit'
