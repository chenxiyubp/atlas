#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P11.1 落地包④ —— 把一份新产物装到本机的部署树上。**只换产物，不起进程。**
#
#   demo/env/beta/beta-deploy.sh --tree <部署树> --payload <payload.tgz> --only dist,demo
#   demo/env/beta/beta-deploy.sh --tree <部署树> --from <构建树>
#
# ── 两种模式，按部署树的形状选 ───────────────────────────────────────────────
#
# 部署树在各台机器上**不是一个形状**：有的只有 `dist/` 与 `demo/`，有的是一整棵源码
# 检出（`node_modules`、`src`、`packages`…，而 `node_modules` 不在任何 payload 里）。
#
#   · `--only dist,demo` —— 只换点名的顶层条目，其余一律不动，备份落在树里
#     （`dist.bak-<戳>`）。**树里还压着别的东西时必须用它。**
#   · 不给 `--only` 就是整棵换，备份是树的兄弟（`<树名>.bak-<戳>`）。
#     整棵换之前会先比一次：源头覆盖不住树里现有的顶层条目就**拒绝**，
#     免得拿一个只含 dist+demo 的 payload 把一整棵检出换走。
#
# 起进程仍然是 beta-up.sh 的事：这里只做「换产物」这一件，装完自己不拉起任何东西。
# 分开的理由与 beta-down/beta-up 分开是同一条 —— 换产物与起进程失败的处置不一样，
# 混在一个脚本里，一次「装好了但起不来」会分不清该回滚哪一半。
#
# ── 为什么这个脚本必须在仓库里 ───────────────────────────────────────────────
#
# 2026-08-26 之前，舰队的部署靠的是**只存在于各台机器上**的 `node-deploy.sh` /
# `h-deploy.sh`。它们不在版本管理里，于是没人 review，也无法交接 —— 而它们带着一个
# 会停机的缺陷（见下）。这与 issue #38 的病根是同一个：部署动作写在部署机上，
# 不可重复、不可评审。
#
# ── 那个会停机的缺陷：备份从不清理 ───────────────────────────────────────────
#
# 旧脚本每次部署都 `mv` 一份完整的树做备份（每份 ~1.6 GB），**从不清理**。
# 2026-08-26 一天四次重新部署之后 workbench-iap 上累到 8 份、约 13 GB，30 GB 的盘
# 100% 满。失败的形状很难看：`mv` 已经成功、`cp` 中途没空间，于是部署树变成一棵
# 半截树，**控制台与注册中心一起下线**；而 `console.out` 里的 `sourceCommit` 还是
# 新的，光看 banner 会以为部署成功了。
#
# 所以这里的顺序是**先清后装**，而不是装完再清：
#
#   ① 先确认没有进程正跑在这棵树上（这一步自己不动任何东西，所以拒绝时现场干净）；
#   ② 再把超出 --keep 的旧备份删掉 —— 空间要在开始拷贝**之前**就腾出来；
#   ③ 然后看剩余空间够不够装一份新的，不够就当场退出、**一个字节都不动**；
#   ④ 才开始 备份 → 装；⑤ 最后校验。
#
# 顺序反过来（先装后清）在盘快满时必然失败，而那正是唯一需要它工作的时候。
# 而 ① 排在最前面，是因为**它拒绝得越早，现场越干净**。
#
# ── 校验：装完要能证明装对了 ─────────────────────────────────────────────────
#
# 装完检查 `dist/cli-node.js` 与 `demo/env/beta/beta-up.sh` 在不在，并把产物里编译
# 进去的 SOURCE_COMMIT 打出来（issue #70：那是产物里唯一能自证来源的东西，`grep`
# 得到，不必把它跑起来）。装了一棵半截树却报成功，是这个脚本最该挡住的事。

set -euo pipefail

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

TREE=''
PAYLOAD=''
FROM=''
KEEP=1
ONLY=''

usage() {
  beta_say '用法：beta-deploy.sh --tree <部署树> (--payload <tgz> | --from <构建树>) [--keep N]'
  beta_say ''
  beta_say '  --tree <目录>     部署树（装到这里）。必须是绝对路径。'
  beta_say '  --payload <tgz>   从 tar 包装（tar 里应含 dist/ 与 demo/）。'
  beta_say '  --from <目录>     从一棵构建树装（整棵拷过去）。'
  beta_say '  --keep N          保留几份旧备份，默认 1。0 = 装完不留备份。'
  beta_say '  --only a,b        只换这几个顶层条目（如 dist,demo），树里其余东西一律不动。'
  beta_say '                    备份落在树内（<名字>.bak-<戳>）。部署树里还装着别的东西'
  beta_say '                    （源码检出、node_modules）时**必须**用它 —— 整棵换会把它们换掉。'
  beta_say ''
  beta_say '先清后装：空间在开始拷贝之前腾出来，不够就一个字节都不动。'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tree)    TREE="${2:-}"; shift 2 ;;
    --payload) PAYLOAD="${2:-}"; shift 2 ;;
    --from)    FROM="${2:-}"; shift 2 ;;
    --keep)    KEEP="${2:-}"; shift 2 ;;
    --only)    ONLY="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) beta_say "未知参数：$1"; beta_say ''; usage; exit 1 ;;
  esac
done

[ -n "$TREE" ] || { beta_say '缺 --tree'; usage; exit 1; }
case "$TREE" in
  /*) ;;
  *) beta_die "--tree 必须是绝对路径：$TREE" ;;
esac
case "$TREE" in
  *..*) beta_die "--tree 里有 ..，拒绝：$TREE" ;;
esac
# 部署树必须在家目录下。这个脚本会 rm -rf 备份、mv 整棵树 —— 拼错一个变量就是一次
# 事故，所以路径形状在动手之前先卡死（与 common.sh 的 beta_assert_inside_root 同理）。
[ "$TREE" != "$HOME" ] || beta_die '--tree 不能是家目录本身'
case "$TREE" in
  "$HOME"/*) ;;
  *) beta_die "--tree 必须在 \$HOME 之下：$TREE" ;;
esac

if [ -n "$PAYLOAD" ] && [ -n "$FROM" ]; then
  beta_die '--payload 与 --from 只能给一个'
fi
if [ -z "$PAYLOAD" ] && [ -z "$FROM" ]; then
  beta_say '要么 --payload 要么 --from'; usage; exit 1
fi
[ -z "$PAYLOAD" ] || [ -f "$PAYLOAD" ] || beta_die "payload 不存在：$PAYLOAD"
[ -z "$FROM" ] || [ -d "$FROM" ] || beta_die "构建树不存在：$FROM"

case "$KEEP" in
  ''|*[!0-9]*) beta_die "--keep 要一个非负整数，收到：$KEEP" ;;
esac

# ── 两条「别站在自己要拆的那块地板上」守卫 ─────────────────────────────────
#
# `beta-deploy.sh` 自己就住在部署树里（demo/env/beta/ 下）。从被换掉的那棵树里启动
# 它，脚本读到一半文件就没了 —— 而且 `atlas-build.sh` 那个「从自己要删的目录里启动」
# 的坑（2026-08-26，两台机一起 CLONE_FAILED）就是这个形状。
#
# **三处路径都要走同一套解析再比**，否则守卫看着在、其实不触发：
#
#   · `pwd -P` 而不是 `$PWD` —— 后者是继承来的环境变量，父进程给什么就是什么。
#     用 `Bun.spawnSync({cwd})` 这类换了目录却没同步该变量的调用方启动时，
#     它会对着一个陈旧路径做判断。
#   · 两边都要 `-P`（解析软链）—— macOS 上 `/tmp` 是 `/private/tmp` 的软链，
#     一边解析一边不解析，前缀比较永远不成立。仓库里 `beta-retain.ts` 与
#     `scripts/defines.ts` 的 `isSamePath` 早就为同一件事绕过 realpath。
#   · 错误消息里的变量要加花括号 —— 紧跟其后的是全角「）」，C locale 下 bash 会
#     把它那几个高位字节当成变量名，`set -u` 报 unbound variable 而不是这句人话。
#     ssh 过去的非交互 shell 常常正是 C locale：**这条会在真机上炸，本地却未必。**
#
# 三条都在 beta-deploy.test.ts 里钉着，那条用例特意在 C locale + spawnSync 的 cwd 下跑。
resolve_dir() {
  # 目录存在就物理解析；不存在（比如首次部署的 --tree）就解析父目录再拼回来。
  if [ -d "$1" ]; then
    (cd "$1" && pwd -P)
  else
    printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd -P)" "$(basename "$1")"
  fi
}
TREE_REAL="$(resolve_dir "$TREE")"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
case "$SELF_DIR/" in
  "$TREE_REAL"/*) beta_die "不要从 --tree 内部启动本脚本（${SELF_DIR} 在 ${TREE_REAL} 之下）——它会把脚本自己换掉。换一棵检出来跑。" ;;
esac
CWD_REAL="$(pwd -P)"
case "$CWD_REAL/" in
  "$TREE_REAL"/*) beta_die "当前目录在 --tree 之下（${CWD_REAL}）——换产物会把 cwd 抽掉。先 cd 到别处。" ;;
esac

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# 同一秒里跑两次部署，时间戳会撞上 —— 而 `mv 树 已存在的目录` 是把树**塞进那个
# 目录里**，不是覆盖。结果是备份里套着备份、下一次清理算错份数。旧脚本也有这个
# 坑（同样是秒级时间戳），只是没人在一秒内部署过两次。加个后缀直到不撞。
unique_path() {
  _u="$1"
  if [ -e "$_u" ]; then
    _n=2
    while [ -e "$_u-$_n" ]; do _n=$((_n + 1)); done
    _u="$_u-$_n"
  fi
  printf '%s\n' "$_u"
}

# 把 <dir>/<prefix>* 清到只剩 keep 份。两种模式共用：整棵换时备份是树的兄弟
# （<树名>.bak-<戳>），--only 时备份在树里（<条目名>.bak-<戳>）。
prune_backups() {
  _dir="$1"; _prefix="$2"; _keep="$3"
  _existing=''
  while IFS= read -r _line; do
    [ -n "$_line" ] && _existing="$_existing$_line"$'\n'
  done <<EOF
$(ls -d "$_dir/$_prefix"* 2>/dev/null | sort || true)
EOF
  _count=0
  [ -z "$_existing" ] || _count="$(printf '%s' "$_existing" | grep -c '^' || true)"
  if [ "$_count" -le "$_keep" ]; then
    beta_say "  $_prefix* 现有 $_count 份，无需清理"
    return 0
  fi
  _drop=$((_count - _keep))
  printf '%s' "$_existing" | head -n "$_drop" | while IFS= read -r _old; do
    [ -n "$_old" ] || continue
    case "$_old" in
      "$_dir/$_prefix"*) ;;
      *) beta_die "拒绝删除不像备份的路径：$_old" ;;
    esac
    beta_say "  删 $(basename "$_old")"
    rm -rf "$_old"
  done
  beta_ok "  $_prefix* 清掉 $_drop 份，剩 $_keep 份"
}

# 源头（构建树或 tar 包）的顶层条目名。整棵换之前要拿它跟树里现有的比。
source_entries() {
  if [ -n "$FROM" ]; then
    ls -A "$FROM"
  else
    tar tzf "$PAYLOAD" | sed -e 's|^\./||' -e 's|/.*||' | grep -v '^$' | sort -u
  fi
}

# --only 的条目表：逗号分隔转成一行一个。
ONLY_LIST=''
if [ -n "$ONLY" ]; then
  ONLY_LIST="$(printf '%s' "$ONLY" | tr ',' '\n' | grep -v '^$' || true)"
  [ -n "$ONLY_LIST" ] || beta_die "--only 给了个空表：$ONLY"
  while IFS= read -r n; do
    case "$n" in
      */*|.|..|.*) beta_die "--only 只收顶层条目名，不收路径也不收点开头：$n" ;;
    esac
  done <<EOF
$ONLY_LIST
EOF
fi

BACKUP_DIR="$(dirname "$TREE")"
BACKUP_PREFIX="$(basename "$TREE").bak-"
BACKUP_PATH="$(unique_path "$BACKUP_DIR/$BACKUP_PREFIX$STAMP")"
BACKUP_NAME="$(basename "$BACKUP_PATH")"

# ── ① 树上还有活着的进程吗 ────────────────────────────────────────────────
#
# **这一条是第一次真机试跑教出来的。** 本脚本「只换产物、不起进程」，于是第一版
# 也不**停**进程 —— 结果第一次在真机上跑，就把一棵树从一个正在跑的常驻脚下换走
# 了。那台节点侥幸没死，但那是运气：产物是**代码分割**的（600+ 个 chunk，见基座
# CLAUDE.md 里 Vite 必须分割那段），chunk 是**懒加载**的 —— 换掉树之后，进程要到
# 下一次加载某个还没碰过的 chunk 时才炸，可能是几十分钟以后，现场与原因隔得要多
# 远有多远。旧的 `node-deploy.sh` 是先停再换，那一点它是对的。
#
# 放在最前面：这条守卫**自己不动任何东西**，所以它拒绝的时候现场是干净的
# （连备份都还没清）。停机顺序是 `beta-down.sh` 的事，这里不替调用方决定停谁。
#
# **用 `ps` 而不是 `pgrep -af`。** macOS 的 pgrep 收下 `-a` 但**只打印 PID**
# （实测：Linux 给 `pid cmdline`，macOS 给一列裸 PID）—— 于是「把脚本自己滤掉」
# 这一步在 macOS 上什么也没滤到，而单测正是在 macOS 上跑。`ps -eo pid=,args=`
# 两边都给 argv。
beta_head '检查是否有进程正跑在这棵树上'
# 两种拼法都要比：`$TREE` 是调用方给的，`$TREE_REAL` 是 `pwd -P` 解过符号链接
# 的。进程的 argv 里存的是**它当初被怎么拼出来的那一个**，两者在有符号链接时不
# 相等（macOS 的 /var → /private/var 就是；单测第一次跑就撞在这上面）。少比一种
# 就是「守卫在」而「守不住」。结尾那个 `/` 不能少 —— 没有它，`~/tree` 会把隔壁
# 的 `~/tree-other` 一起框进来，换 A 树被 B 树里的进程挡住，挡错比不挡更难查。
# 先确认 ps 这条路本身是通的。`2>/dev/null` 会把「这台机器的 ps 不认 -eo」咽掉，
# 于是 live 为空、守卫欢快放行 —— 那是这类守卫最坏的死法：看着在，其实从不触发。
# 进程表里至少有 ps 自己，**一行都数不出来就是它没工作**，不是「机器上没进程」。
snapshot="$(ps -eo pid=,args= 2>/dev/null || true)"
if [ -z "$snapshot" ]; then
  beta_die '数不出进程表（ps -eo pid=,args= 没有输出）—— 无法确认这棵树上有没有进程在跑。这条守卫这次不成立，不敢往下走。'
fi
live="$(printf '%s\n' "$snapshot" \
  | grep -F -e "$TREE_REAL/" -e "$TREE/" \
  | grep -v -e 'beta-deploy' -e 'ps -eo pid=' -e 'grep -F' || true)"
if [ -n "$live" ]; then
  printf '%s\n' "$live" | head -5 >&2
  beta_die "上面这些进程正跑在 $TREE_REAL 里。换产物会把它们的 chunk 抽走（产物是懒加载的代码分割，炸点会推迟到下一次加载，届时看不出与部署有关）。先跑 beta-down.sh 停掉，再来。"
fi
beta_ok '没有进程跑在这棵树上'

# ── ①· 整棵换之前先问一句：源头有没有树里现在有的东西？ ──────────────────
#
# 部署树在各台机器上并不是一个形状：有的就只有 `dist/` 与 `demo/`，有的是一整棵
# 源码检出（`node_modules`、`src`、`packages`…，而 `node_modules` 根本不在任何
# payload 里）。拿一个只含 dist+demo 的 payload 去「整棵换」后一种树，等于把
# 检出和 node_modules 一起换走 —— 备份里还在，但那台机器当场就不是原来那棵树了。
#
# 所以整棵换的前提是**源头至少覆盖树里现有的顶层条目**；覆盖不住就拒绝，并告诉
# 调用方用 `--only`。判据是「会掉什么」而不是「树长什么样」：H 那种从整棵构建树
# `--from` 拷过去的用法照旧通过，因为它什么都不掉。
#
# 和上面那条守卫一样排在动手之前：它只读不写，所以拒绝的时候现场是干净的。
if [ -z "$ONLY" ] && [ -d "$TREE" ]; then
  src_list="$(source_entries)"
  dropped=''
  for existing in "$TREE"/* "$TREE"/.[!.]*; do
    [ -e "$existing" ] || continue
    name="$(basename "$existing")"
    if ! printf '%s\n' "$src_list" | grep -Fxq "$name"; then
      dropped="$dropped $name"
    fi
  done
  if [ -n "$dropped" ]; then
    beta_die "整棵换会让树里这些东西消失（源头里没有）：$dropped
它们会留在备份里，但这棵树当场就不是原来那棵了 —— 部署树里装着源码检出或 node_modules 时尤其危险。
只想换产物就用：--only dist,demo"
  fi
  beta_ok '源头覆盖得住树里现有的顶层条目'
fi

# ── ② 先清 ────────────────────────────────────────────────────────────────
#
# 装之前腾空间，不是装完再腾。理由见文件头。
beta_head "清理旧备份（保留 $KEEP 份）"
# 这次自己还要再造一份，所以现在最多留 KEEP-1 份。
target_before=$((KEEP > 0 ? KEEP - 1 : 0))
if [ -n "$ONLY" ]; then
  # --only：备份在树里，按条目各清各的。
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    prune_backups "$TREE" "$n.bak-" "$target_before"
  done <<EOF
$ONLY_LIST
EOF
else
  prune_backups "$BACKUP_DIR" "$BACKUP_PREFIX" "$target_before"
fi

# ── ③ 再看空间 ────────────────────────────────────────────────────────────
#
# 需要的量 = 一份新树。备份是 `mv`（同一文件系统内不占额外空间），装是拷贝，
# 所以峰值大约就是「再来一棵树」。留 20% 余量。
beta_head '检查空间'
need_kb=0
if [ -n "$FROM" ] && [ -n "$ONLY" ]; then
  # 只算要换的那几个条目 —— 拿整棵构建树的体积去要空间，会在盘还够用时把人挡住。
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    [ -e "$FROM/$n" ] || beta_die "--only 要 ${n}，但构建树里没有：$FROM/$n"
    need_kb=$((need_kb + $(du -sk "$FROM/$n" | awk '{print $1}')))
  done <<EOF
$ONLY_LIST
EOF
elif [ -n "$FROM" ]; then
  need_kb="$(du -sk "$FROM" | awk '{print $1}')"
else
  # tar 包按 4 倍估解压后体积（gzip 对这类树大致 3–4 倍），宁可高估。
  payload_kb="$(du -sk "$PAYLOAD" | awk '{print $1}')"
  need_kb=$((payload_kb * 4))
fi
need_kb=$((need_kb * 120 / 100))
avail_kb="$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')"
beta_say "  需要约 $((need_kb / 1024)) MiB，可用 $((avail_kb / 1024)) MiB"
if [ "$avail_kb" -lt "$need_kb" ]; then
  beta_die "空间不够，**没有动任何东西**。腾出空间后重试（--keep 0 可以连当前备份一起不留）。"
fi
beta_ok '空间够'

# ── ④ 才动手 ──────────────────────────────────────────────────────────────
beta_head '换产物'
if [ -n "$ONLY" ]; then
  # 先把新东西备齐在一个暂存目录里，再逐个换过去 —— 暂存目录与树同一文件系统，
  # 所以换那一下是 mv，不是拷。中途失败时树里换掉的那几个是好的，没换的还是旧的，
  # 不会出现「一个条目拷了一半」的形状。
  STAGE="$(unique_path "$BACKUP_DIR/.beta-deploy-stage-$STAMP")"
  trap 'rm -rf "$STAGE"' EXIT
  mkdir -p "$STAGE"
  if [ -n "$FROM" ]; then
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      cp -a "$FROM/$n" "$STAGE/$n"
    done <<EOF
$ONLY_LIST
EOF
  else
    tar xzf "$PAYLOAD" -C "$STAGE"
  fi

  mkdir -p "$TREE"
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    [ -e "$STAGE/$n" ] || beta_die "--only 要 ${n}，但源头里没有 —— 树没动过。"
    if [ -e "$TREE/$n" ]; then
      if [ "$KEEP" -gt 0 ]; then
        nb="$(unique_path "$TREE/$n.bak-$STAMP")"
        mv "$TREE/$n" "$nb"
        beta_ok "旧 $n → $(basename "$nb")"
      else
        rm -rf "${TREE:?}/$n"
        beta_ok "旧 $n 已删（--keep 0）"
      fi
    fi
    mv "$STAGE/$n" "$TREE/$n"
    beta_ok "装好 $n"
  done <<EOF
$ONLY_LIST
EOF
  rm -rf "$STAGE"
  trap - EXIT
  beta_ok "装好了（只换了：${ONLY}）：$TREE"
else
  if [ -d "$TREE" ]; then
    if [ "$KEEP" -gt 0 ]; then
      mv "$TREE" "$BACKUP_PATH"
      beta_ok "旧树 → $BACKUP_NAME"
    else
      rm -rf "$TREE"
      beta_ok '旧树已删（--keep 0）'
    fi
  fi

  if [ -n "$FROM" ]; then
    cp -a "$FROM" "$TREE"
  else
    mkdir -p "$TREE"
    tar xzf "$PAYLOAD" -C "$TREE"
  fi
  beta_ok "装好了：$TREE"
fi

# ── ⑤ 校验 ────────────────────────────────────────────────────────────────
#
# 装了一棵半截树却报成功，是这个脚本最该挡住的事。
beta_head '校验'
missing=''
for f in dist/cli-node.js demo/env/beta/beta-up.sh; do
  [ -e "$TREE/$f" ] || missing="$missing $f"
done
if [ -n "$missing" ]; then
  if [ -n "$ONLY" ]; then
    beta_die "装完少了：$missing —— 这棵树不能用。旧的那几个条目还在树里的 *.bak-$STAMP"
  fi
  beta_die "装完少了：$missing —— 这棵树不能用，旧树还在 $BACKUP_NAME"
fi
beta_ok '关键文件都在'

# ── ripgrep 是不是这台机的架构 ────────────────────────────────────────────
#
# `dist/vendor/ripgrep/` 里按架构分目录，而**产物是在别的机器上建的**：给
# aarch64 节点建的包滚到 x86_64 机器上，rg 会原地不动地躺在那里、一跑就
# `Exec format error`。这支舰队真栽过 —— 有一份产物只带了 arm64，x86_64 那台
# 的 rg 是后来手工补进去的（见 [部署的构建] 那节）。
#
# 关键是**这一条 `--version` 真把它跑起来了**：只看文件在不在，架构不对照样"在"。
# 旧的 node-deploy.sh 这一点是对的，别在换脚本的时候把它丢了。
#
# 没有 vendor/ripgrep 整个目录 → 只提醒（有的树本来就不带）；
# 目录在、但这台机的架构缺了或跑不起来 → 当场红（那是一棵装错架构的树）。
RG_ROOT="$TREE/dist/vendor/ripgrep"
if [ -d "$RG_ROOT" ]; then
  case "$(uname -s)/$(uname -m)" in
    Linux/aarch64|Linux/arm64) RG_DIR='arm64-linux' ;;
    Linux/x86_64)              RG_DIR='x64-linux' ;;
    Darwin/arm64)              RG_DIR='arm64-darwin' ;;
    Darwin/x86_64)             RG_DIR='x64-darwin' ;;
    *)                         RG_DIR='' ;;
  esac
  if [ -z "$RG_DIR" ]; then
    beta_warn "认不出这台机的架构（$(uname -s)/$(uname -m)），跳过 ripgrep 校验"
  elif [ ! -x "$RG_ROOT/$RG_DIR/rg" ]; then
    beta_die "产物里没有这台机能用的 ripgrep（缺 ${RG_DIR}）—— 这份产物是给别的架构建的。旧树还在备份里。"
  elif ! "$RG_ROOT/$RG_DIR/rg" --version >/dev/null 2>&1; then
    beta_die "ripgrep 在（${RG_DIR}）但跑不起来 —— 架构对不上。旧树还在备份里。"
  else
    beta_ok "ripgrep 可执行（${RG_DIR}）"
  fi
else
  beta_warn '产物里没有 dist/vendor/ripgrep —— 若这台机要用搜索工具，它会在运行时才失败'
fi

# ── 产物里编译进去的 SOURCE_COMMIT（issue #70）────────────────────────────
#
# 认的是**编译后的那个形状** `` return`<40 位十六进制>` `` ——`defines.ts` 把
# SOURCE_COMMIT 替换进一个 try/catch 的返回位，产物里长这样。
#
# **不能拿「dist 里第一个 40 位十六进制」当答案。** 第一版就是那么写的，第一次
# 在真机上跑就报了一个错的：那棵 dist 里有 4 个互不相同的 40 位十六进制（chunk
# 完整性哈希之类），按字典序第一个根本不是 commit。`defines.ts` 的头注早写着这
# 件事 ——「a confident, wrong answer, which is worse than unknown」，而部署脚本
# 恰恰是最容易被人当真的地方。
#
# 所以判据是**恰好一个不同取值**：多于一个说明这个形状不再唯一（上游改了产物
# 结构），那时候要的是「读不出」而不是随便挑一个。
commits="$(grep -rhoE 'return`[0-9a-f]{40}(-dirty)?`' "$TREE/dist" 2>/dev/null \
  | sed 's/^return`//; s/`$//' | sort -u || true)"
commit_count=0
[ -z "$commits" ] || commit_count="$(printf '%s\n' "$commits" | grep -c '^')"
if [ "$commit_count" -eq 1 ]; then
  beta_ok "产物来源 commit：$commits"
elif [ "$commit_count" -eq 0 ]; then
  beta_warn '产物里读不出 SOURCE_COMMIT —— 装是装上了，但这份产物无法自证来源（issue #70）'
else
  beta_warn "产物里读出 $commit_count 个候选，不敢认（形状可能变了）：$(printf '%s' "$commits" | tr '\n' ' ')"
fi

beta_head '下一步'
beta_say "  demo/env/beta/beta-up.sh --role node --node <名字> -- <透传参数...>"
beta_say "  或 demo/env/beta/beta-up.sh --role host -- <透传参数...>"
beta_say ''
beta_say '本脚本不起进程 —— 装与起分开，一次「装好了但起不来」才分得清该回滚哪一半。'
