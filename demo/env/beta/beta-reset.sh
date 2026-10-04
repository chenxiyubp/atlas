#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P11.1 落地包① —— 把本机的内测环境退回「可以重新起机」的干净运行态。
#
#   demo/env/beta/beta-reset.sh                  # 停机 + 清 run/
#   demo/env/beta/beta-reset.sh --purge-logs     # 再清 logs/
#   demo/env/beta/beta-reset.sh --purge-state    # 再清 state/（**会带走 timings**，见下）
#   demo/env/beta/beta-reset.sh --archive-config # 把配置根改名归档（§6 L2 的第②步）
#   demo/env/beta/beta-reset.sh --purge-links    # 再删链路与 H 腿的生成物（ops/ 与五个单元文件）
#
# ── 它敢动东西的全部依据（三重守卫，与 demo/env/reset.sh 同形）────────────────
# 动作**只发生在 QIANMO_BETA_ROOT 下面**，而且必须同时满足三条，缺一条就退出：
#   ① 根目录通过 common.sh 的 beta_guard_root（不是 /、家目录、仓库根，也不在任何真实
#      配置根 ~/.occ / ~/.qianmo / ~/.claude 里面，也不是演示环境根）；
#   ② 根目录下有标记文件 .qianmo-beta-env，**且首行是 qianmo-beta-env/v1**；
#   ③ 要动的每一个路径都在根目录之内（逐个复核，不信任变量拼接的结果）。
#
# ── 为什么它和演示环境的 reset.sh 不一样（这是本包唯一一处有意的形状偏离）─────
# `demo/env/reset.sh` 默认就 `rm -rf` 掉 nodes/ 与 state/，因为演示环境活 87 s、里面
# 没有任何要留的东西。内测环境里那两个目录装着**明文规定不许清的数据**：
#   · 审计链（配置根里）——「内测全程不清」（§5）、「只能挪走，不能撤销」（§6.4）；
#   · timings（state/）——「内测全程保留」，它是 P7.3 基线与容量判断的**唯一输入**，
#     删了这一列数据只能重来一次内测（§5 最后一行）。
# 所以这里的默认动作只清 run/（pid 与 ready 文件，重建它们零代价），其余一律要显式参数；
# 配置根更是**只改名不删**——那正是 §6 L2 第②步「改名成 config.bad-<ISO> ← 不删！审计链
# 在里面」的动作。**回滚配置根不是撤销历史，只是把历史挪到旁边。**
#
# ── 为什么没有 --rotate-secrets ─────────────────────────────────────────────
# 演示环境有那个参数，内测环境**故意没有**。PSK 是每节点一把、由 H 生成后分发（§8.3）：
# 在节点机上本地重新生成一把，得到的是一个 H 永远拨不通的节点。换 PSK 是 §8.4 的七步
# 流程（H 生成 → 停该节点 → 写进该机 → 起 → 更新 H 副本 → 从 H 真拨一次 → 若它是唤醒
# 目标则控制台也要带新 PSK 重起），而且只能在升级窗口做——那不是一个脚本参数。

set -euo pipefail

# shellcheck source=demo/env/beta/common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/common.sh"

PURGE_LOGS=0
PURGE_STATE=0
ARCHIVE_CONFIG=0
PURGE_LINKS=0
for option in "$@"; do
  case "$option" in
    --purge-logs) PURGE_LOGS=1 ;;
    --purge-state) PURGE_STATE=1 ;;
    --archive-config) ARCHIVE_CONFIG=1 ;;
    --purge-links) PURGE_LINKS=1 ;;
    -h|--help)
      beta_say '用法：beta-reset.sh [--purge-logs] [--purge-state] [--archive-config] [--purge-links]'
      beta_say '默认只停机 + 清 run/。理由见本文件头。'
      exit 0
      ;;
    *) beta_die "未知参数 $option" ;;
  esac
done

STARTED_AT="$(beta_now)"
# 守卫①②。**缺标记文件时在这里就退出，一个路径都不会被碰。**
beta_require_marker

# 守卫③：逐个复核「这个路径确实在根目录里面」。守卫写在删除动作旁边，而不是只写在
# 脚本开头——中间任何一次变量赋值出错，这里都还能拦住。
purge() {
  local target="$1"
  beta_assert_inside_root "$target"
  [ -e "$target" ] || return 0
  rm -rf "$target"
  beta_say "已清除 $target"
}

# 配置根不删，改名。审计链在里面（见文件头）。
archive_config() {
  local target="$1" stamp="$2" dest
  beta_assert_inside_root "$target"
  [ -d "$target" ] || return 0
  dest="$target.bad-$stamp"
  beta_assert_inside_root "$dest"
  mv "$target" "$dest"
  beta_warn "已归档（**未删除**）$target → $dest"
}

beta_head '① 停机'
"$QIANMO_BETA_ENV_DIR/beta-down.sh"

beta_head '② 清除运行态'
purge "$BETA_RUN_DIR"

if [ "$PURGE_LOGS" = '1' ]; then
  beta_head '· 清除日志'
  # 日志保留 14 天是 §5 的策略，由宿主侧工具（落地包③）按天切 + gzip 来管；
  # 这里整块清掉是「重来一次」的动作，不是保留策略，别拿它当轮转用。
  purge "$BETA_LOG_DIR"
else
  beta_say "保留 ${BETA_LOG_DIR}（要清用 --purge-logs）"
fi

if [ "$PURGE_STATE" = '1' ]; then
  beta_head '· 清除 state/'
  beta_warn 'state/ 里有 timings —— 它是 P7.3 基线与容量判断的唯一输入（§5），删了只能重来一次内测'
  # 尾参记录也住在 state/（issue #111）。清掉它之后，下一次不带 `--` 的节点腿会
  # 起在一个**没有 --trust 的策略面**上，而所有存活判据照旧全绿 —— 那正是 #111
  # 那个形状，只不过换了一扇门进来。所以这里点名说出来，并把该怎么补说清楚。
  _kept=''
  for _one in "$BETA_STATE_DIR"/*.passthrough; do
    [ -e "$_one" ] || continue
    _kept="$_kept
  $(basename "$_one" .passthrough)：$(tr '\n' ' ' <"$_one" | sed -e 's/#[^ ]*//g')"
  done
  if [ -n "$_kept" ]; then
    beta_warn "state/ 里还有节点腿的尾参记录，一并会被清掉（issue #111）：${_kept}
清掉之后**下一次不带 \`--\` 的节点腿会起在没有这些参数的策略面上**，而存活判据照旧全绿。
要保留就先把上面那几行抄下来，起机时用 \`-- <参数>\` 带回去。"
  fi
  unset _kept _one
  purge "$BETA_STATE_DIR"
else
  beta_say "保留 ${BETA_STATE_DIR}（含 timings 与节点腿的尾参记录；要清用 --purge-state）"
fi

if [ "$ARCHIVE_CONFIG" = '1' ]; then
  beta_head '· 归档配置根'
  STAMP="$(beta_stamp)"
  ARCHIVED=0
  # glob 没匹配到时 bash 会把模式原样留下，所以逐个 `[ -d ]` 复核。
  for dir in "$BETA_NODES_DIR"/*; do
    [ -d "$dir/config" ] || continue
    archive_config "$dir/config" "$STAMP"
    ARCHIVED=1
  done
  if [ "$ARCHIVED" = '1' ]; then
    beta_warn "在运维单页写一行：「<node> 于 $STAMP 归档了配置根，那一段审计记录在 config.bad-$STAMP 里」。
这是 §6 L2 最容易漏、后果最大的一步 —— 不留这一行，三天后查链的人会看到一段无法解释的
空白，然后开始怀疑审计机制本身。"
  else
    beta_say '没有配置根可归档'
  fi
else
  beta_say "保留全部配置根（含审计链与节点身份；要归档用 --archive-config）"
fi

if [ "$PURGE_LINKS" = '1' ]; then
  beta_head '· 清除链路生成物'
  # ①停机那一步（beta-down.sh）已经把隧道与 timer 停掉并取消自启了。H 腿那两个单元
  # 不在它的职责里（停机 ≠ 取消开机自启），所以在这里 disable —— 先 disable 再删文件，
  # 否则 default.target.wants/ 下会留一条指向已删文件的悬空符号链接。
  # 全都是**生成物**：ops/ 由 peers.conf 的 node 坐标行派生，五个单元文件由仓库
  # demo/env/beta/ops/ 派生，下一次 beta-up.sh --role host 会原样重新铺出来。
  # **不动 mirror/**：那里面是已经拉回来的审计链副本，「只能挪走、不能撤销」同样适用。
  beta_stop_host_unit "$BETA_REGISTRY_UNIT"
  beta_stop_host_unit "$BETA_CONSOLE_UNIT"
  purge "$BETA_OPS_DIR"
  for unit_file in 'qianmo-tunnel@.service' 'qianmo-mirror@.service' 'qianmo-mirror@.timer' \
    "$BETA_REGISTRY_UNIT" "$BETA_CONSOLE_UNIT"; do
    UNIT_PATH="$BETA_SYSTEMD_USER_DIR/$unit_file"
    # ~/.config 不在内测根里，guard_root 管不到它 —— 逐个复核走另一套（见 common.sh）。
    beta_assert_unit_file "$UNIT_PATH"
    if [ -f "$UNIT_PATH" ]; then
      rm -f "$UNIT_PATH"
      beta_say "已清除 $UNIT_PATH"
    fi
  done
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    systemctl --user daemon-reload
    beta_say 'systemd --user 已 daemon-reload'
  fi
  beta_say "mirror/ 一条没动（${BETA_MIRROR_DIR}）—— 那是已经拉回来的审计链副本"
else
  beta_say "保留链路生成物（${BETA_OPS_DIR} 与 systemd --user 的五个单元；要删用 --purge-links）"
fi

beta_head '③ 重铺目录骨架'
# 只补目录与标记，**不生成任何密钥**（common.sh 文件头第②条）。
beta_seed_root

beta_head "重置完成，耗时 $(beta_elapsed "$STARTED_AT")"
beta_say "密钥     : 一把没动 —— 换 PSK 是 §8.4 的七步流程，不是一个脚本参数（见本文件头）"
beta_say '下一步   : demo/env/beta/beta-up.sh --role host|node'
