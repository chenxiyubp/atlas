#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 真机腿（`--target fleet`）的起法。**它进仓库的理由和 `legacy-deploy-shim.sh`
# 一样**：在它之前，「这一轮真机验收是怎么跑起来的」是一份口头知识 ——
#
#   $ grep -rn "QIANMO_ACCEPTANCE_PSK_" --include='*.md' --include='*.sh' .
#   （空）
#
# 唯一提到那几个变量名的是 `demo/lib/acceptance/fleet/driver.ts` 里
# `fleetConfigFromEnv()` 自己的实现。于是要跑这条腿，得先知道 PSK 在各机的
# `~/qianmo-beta/secrets/transport-psk`（0600）、知道节点名到变量名的映射是
# `beta-1` → `BETA_1`、知道控制台机默认是 `workbench-iap`。
#
# **后果不是「跑不起来」，而是跑出来的结果无人能复核**：换个人接手时最省事的
# 做法是自己现编一条命令行，而 PSK 少接一把的表现不是报错 —— 是那个节点的场景
# 整片 skip 或红，两者都容易被读成「环境问题」。这与 issue #38 / PR #112 是同一
# 个病根（一个关键动作只存在于执行者那一次的命令行里），#112 把部署那半边收进了
# 仓库，这份壳补上验收这半边。
#
# 职责只有三件，一件都不多：
#   ① 从各机现取 PSK 进环境；
#   ② 校验四把都取到了 —— 少一把当场退出，不让 runner 带着空 PSK 跑；
#   ③ exec 那个 runner，尾参原样透传。
#
# **值不打印、不落盘。**出错信息里只出现变量名与节点名，永远不出现 PSK 本身；
# 校验通过时打的是 sha256 前 8 位，那是「四把各不相同、且与上次同一把」这个
# 判断需要的最小信息量。
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SELF_DIR}/../../../.." && pwd)"

# 真源是 `fleetConfigFromEnv()`；这里只留入口。四台的 SSH 目标与节点名跟着
# `DEFAULT_FLEET_HOSTS` 走，改那张表时这一行要跟着改（用例钉住两边一致）。
FLEET_PAIRS="${QIANMO_ACCEPTANCE_FLEET_PAIRS:-cornna-p2=beta-1 cornna-p3=beta-2 cornna-p7=beta-3 cornna-p11=beta-4}"
# PSK 在各机的位置由 `beta-up.sh` 的部署形状定（`common.sh` 的 BETA_SECRET_DIR）。
PSK_REMOTE_PATH="${QIANMO_ACCEPTANCE_PSK_REMOTE_PATH:-qianmo-beta/secrets/transport-psk}"
SSH_BIN="${QIANMO_ACCEPTANCE_SSH_BIN:-ssh}"

die() { printf '%s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<'USAGE'
用法：

  demo/env/beta/ops/fleet-acceptance.sh [-- <透传给 qianmo-acceptance.ts 的参数>...]

例：
  demo/env/beta/ops/fleet-acceptance.sh -- --out /tmp/fleet-run
  demo/env/beta/ops/fleet-acceptance.sh -- --only handshake/psk-ok --timeout-scale 3

拨号地址：默认 ws://127.0.0.1:3863x —— 那四个口在**控制台机 H 的回环上**。
从别处跑就先把隧道起起来：

  ssh -N -L 38631:127.0.0.1:38631 -L 38632:127.0.0.1:38632 \
         -L 38633:127.0.0.1:38633 -L 38634:127.0.0.1:38634 workbench-iap

或者设 QIANMO_ACCEPTANCE_DIAL_HOST / QIANMO_ACCEPTANCE_ENDPOINT_<节点>。

环境变量（都不必设，设了才覆盖）：
  QIANMO_ACCEPTANCE_FLEET_PAIRS       `<ssh 目标>=<节点名>` 空格分隔，缺省即舰队四台
  QIANMO_ACCEPTANCE_PSK_REMOTE_PATH   PSK 相对家目录的位置
  QIANMO_ACCEPTANCE_SSH_BIN           ssh 可执行文件
  QIANMO_ACCEPTANCE_PSK_<节点>        直接给某一把，给了就不去那台机器取
USAGE
}

PASS_THROUGH=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; PASS_THROUGH=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "未知参数 $1 —— 透传给套件的参数放在 -- 后面。" ;;
  esac
done

# 节点名 → 变量名后缀，与 driver.ts 的 `envSuffix()` 同一条规则。
suffix_of() { printf '%s' "$1" | tr 'a-z-' 'A-Z_'; }

fetched=0
reused=0
printf '取 PSK（%s）\n' "$PSK_REMOTE_PATH" >&2
for pair in $FLEET_PAIRS; do
  case "$pair" in
    *=*) ;;
    *) die "QIANMO_ACCEPTANCE_FLEET_PAIRS 里的每一项都要写成 <ssh 目标>=<节点名>，收到：${pair}" ;;
  esac
  host="${pair%%=*}"
  node="${pair#*=}"
  var="QIANMO_ACCEPTANCE_PSK_$(suffix_of "$node")"

  # 已经在环境里的那一把不覆盖：显式给出的优先，也让离线复跑不必有 SSH。
  # 间接展开而不是 `eval`：`$var` 是从 `FLEET_PAIRS` 里的节点名推出来的，那串
  # 由运维给，`eval` 会让一个手滑的节点名变成一条可执行的命令。`${!var}` 是
  # bash 3.2 就有的写法，做的是同一件事而没有那条路。
  existing="${!var:-}"
  if [ -n "$existing" ]; then
    reused=$((reused + 1))
  else
    # `|| true` 会把 ssh 的失败吞掉，所以不写 —— 取不到就让下面那句校验去说，
    # 它给的是变量名和机器名，比一句 ssh 的 stderr 更接近要做的动作。
    if ! value="$("$SSH_BIN" "$host" "cat \"\$HOME/${PSK_REMOTE_PATH}\"" 2>/dev/null)"; then
      value=''
    fi
    # 值只在这一行之间存在：不 echo、不写文件、不进 set -x（下面显式关掉）。
    value="$(printf '%s' "$value" | tr -d '\r\n')"
    if [ -n "$value" ]; then
      export "$var=$value"
      fetched=$((fetched + 1))
    fi
    unset value
  fi

  have="${!var:-}"
  [ -n "$have" ] || die "取不到 ${node} 的 PSK（${host}:\$HOME/${PSK_REMOTE_PATH}）。
它没有默认值也没有兜底：带着空 PSK 跑，那台节点的场景会整片 skip 或红，
而两者都容易被读成「环境问题」。先确认 ssh ${host} 通、且那个文件在（0600）。
只想跑其中几台就缩 QIANMO_ACCEPTANCE_FLEET_PAIRS，别让缺失的那把静默通过。"

  # 指纹而不是值：够判断「四把各不相同、且与上次同一把」，不够拿去用。
  printf '  %-8s %-14s sha256:%s\n' "$node" "$host" \
    "$(printf '%s' "$have" | shasum -a 256 | cut -c1-8)" >&2
  unset have existing
done
printf '四把都在（现取 %d，沿用环境里的 %d）\n' "$fetched" "$reused" >&2

cd "$REPO_DIR"
exec bun run scripts/qianmo-acceptance.ts --target fleet \
  ${PASS_THROUGH[@]+"${PASS_THROUGH[@]}"}
