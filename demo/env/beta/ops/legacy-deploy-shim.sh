#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 装到各台机器上，顶替旧的 `node-deploy.sh` / `h-deploy.sh`。
#
# **它进仓库的理由和 beta-deploy.sh 一样**：被它顶掉的那两个脚本只存在于机器上，
# 没人 review、无法交接，而它们带着一个把控制台弄下线过的缺陷。一个「机器上的
# 脚本」换成另一个「机器上的脚本」等于没治，所以这份壳也在仓库里，
# 并且和 `ops/mirror-pull.sh` 一样在旁边配了用例。
#
# 它装到机器上时**覆盖同名的旧脚本**，原件留成 `*.superseded-20260826` 仅供查阅。
# 被顶掉的那版每次部署都留一份备份、**从不清理**：2026-08-26 一天四次
# 部署之后 workbench-iap 累到 8 份约 13 GB，30 GB 的盘 100% 满 —— `mv` 已成功、
# `cp` 中途没空间，控制台与注册中心一起下线，只剩一棵 589 MB 的半截树。
#
# 本文件现在只做一件事：把仓库脚本从部署树里**拷出来**再跑。
# 必须拷出来 —— 那个脚本自己就住在 demo/ 底下，从要被换掉的树里启动会把自己换掉，
# 所以它带着一条守卫，见到自己在 --tree 之下会直接拒绝。
set -euo pipefail
TREE="${QM_TREE:-$HOME/atlas-beta}"
OUT="$HOME/qm-deploy"
SRC="$TREE/demo/env/beta"

# 优先用树里那一份（跟着产物走，永远是最新的）；树里还没有就退回 $HOME/qm-deploy
# 里预置的那一份 —— 换脚本的那一天，树里当然还没有它，总不能因此没法部署。
FROM_TREE=1
if [ ! -f "$SRC/beta-deploy.sh" ]; then
  FROM_TREE=0
  if [ ! -f "$OUT/beta-deploy.sh" ]; then
    echo "树里与 $OUT 里都没有 beta-deploy.sh —— 先把 demo/env/beta/{beta-deploy.sh,common.sh} 放一份到 ${OUT}。" >&2
    exit 1
  fi
fi
if [ "$#" -eq 0 ]; then
  cat >&2 <<'USAGE'
用法（**在树外面跑** —— 先 cd 到家目录，别在 --tree 里面）：

  节点机（树里还压着源码检出，只换产物）：
    ./node-deploy.sh --tree "$HOME/atlas-beta" --payload <payload.tgz> --only dist,demo --keep 2

  H（整棵从构建树拷）：
    ./h-deploy.sh --tree "$HOME/atlas-beta" --from "$HOME/atlas-build" --keep 2

它不起进程。树上有进程跑着会**拒绝**换 —— 先 ~/atlas-beta/demo/env/beta/beta-down.sh <节点> 停掉，
换完再用同一个目录下的 beta-up.sh 起回来。注意起机时要把停机前 argv 里 `--` 之后的透传参数原样带回去
（issue #111：beta-up.sh 不记得它们）。
USAGE
  exit 1
fi

mkdir -p "$OUT"
if [ "$FROM_TREE" = 1 ]; then
  cp "$SRC/beta-deploy.sh" "$SRC/common.sh" "$OUT/"
  echo "已把 beta-deploy.sh 从树里拷到 ${OUT}（树马上要被换，脚本不能在树里跑）"
else
  echo "树里还没有 beta-deploy.sh，用 $OUT 里预置的那一份"
fi
exec bash "$OUT/beta-deploy.sh" "$@"
