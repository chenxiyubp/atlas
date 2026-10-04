#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌 P8.1 —— 真机腿：**宿主侧**就位检查（Dormice + gVisor 那台）。
#
#   demo/env/remote/prepare-host.sh            # 只检查，不改任何东西
#   demo/env/remote/prepare-host.sh --apply    # 顺带落实网络加固（要 sudo）
#
# ⚠️ **本脚本未在真机验证。**它是从 `demo/ac2-wake-forward.sh`、`demo/p41-task-result.sh`、
#    `demo/p31-resident-wake.sh`、`demo/ac6a-sandbox.sh`、`scripts/ops/` 与 roadmap /
#    selection-m0 的记载**反推**出来的检查清单，逐条都能对上出处（见 README.md 的对照表），
#    但没有在装了 Dormice 的机器上跑过一次——验收机 `workbench-host` 在本任务包实施期间
#    SSH 不可达。**第一次在真机上跑它，请按「未验证脚本」对待**：先 `--dry-run` 式地只检查，
#    看每一条的输出是否符合预期，再决定要不要 `--apply`。
#
# 它不做什么
#   - 不安装任何东西（装 Dormice / gVisor / docker 是运维动作，不该藏在演示脚本里）；
#   - 不创建、不销毁沙箱（那要 daemon 凭据，而本脚本刻意不碰凭据）；
#   - 不写任何凭据到磁盘或日志。
#
# 相关不变式与加固脚本的真源是 `scripts/ops/README.md`，本文件只调用它们，不复述结论。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OPS_DIR="$REPO_DIR/scripts/ops"

APPLY=0
for option in "$@"; do
  case "$option" in
    --apply) APPLY=1 ;;
    -h|--help) sed -n '4,20p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf 'prepare-host: 未知参数 %s\n' "$option" >&2; exit 2 ;;
  esac
done

PASS=0; FAIL=0; WARN=0
say()  { printf '%s\n' "$*"; }
head1() { printf '\n=== %s ===\n' "$*"; }
ok()   { PASS=$((PASS + 1)); printf 'OK   : %s\n' "$*"; }
bad()  { FAIL=$((FAIL + 1)); printf 'FAIL : %s\n' "$*"; }
warn() { WARN=$((WARN + 1)); printf 'WARN : %s\n' "$*"; }

# 沙箱 daemon 的端口/网卡名与 scripts/ops 同一个出处（同名环境变量、同一默认值），
# 这里不另设一套。
DORMICE_DAEMON_PORT="${DORMICE_DAEMON_PORT:-3676}"

head1 '0. 平台'
say "内核 : $(uname -srm)"
if [ "$(uname -s)" != 'Linux' ]; then
  bad '真机腿只在 Linux 上成立（沙箱是 Dormice + gVisor，macOS 上没有这套东西）'
  say '本地腿请改用 demo/env/up.sh'
  exit 1
fi
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  say "发行版 : ${PRETTY_NAME:-未知}"
fi

head1 '1. 容器运行时与 gVisor'
if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
  if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q 'runsc'; then
    ok 'docker 已登记 runsc 运行时（gVisor）'
  else
    bad 'docker 里没有 runsc 运行时 —— AC-6(a) 的沙箱边界建立在 gVisor 上'
  fi
else
  bad 'docker 不在 PATH 上'
fi
if command -v runsc >/dev/null 2>&1; then
  ok "runsc: $(runsc --version 2>/dev/null | head -1)"
else
  warn 'runsc 不在 PATH 上（若 docker 已能用 runsc 运行时，这条只是 PATH 问题）'
fi

head1 '2. cgroup v2'
# P5.1 的 oomKillDelta 这条事实需要 cgroup v2；没有它，OOM 只能给中等置信度。
if [ -r /sys/fs/cgroup/cgroup.controllers ]; then
  ok 'cgroup v2 可读（P5.1 的 OOM 判定要用）'
else
  warn '没有 /sys/fs/cgroup/cgroup.controllers —— OOM 归因会退化为中等置信'
fi

head1 '3. Dormice'
if command -v dor >/dev/null 2>&1; then
  ok 'dor CLI 在 PATH 上'
  say '--- dor doctor ---'
  # doctor 判的是「这台机器能不能**跑** daemon」，它前几条（running as root、
  # DORMICE_* 环境变量、以及依赖 base image 的四个探针）只在 daemon 自己的运行身份
  # 与环境下才成立。用普通用户、空环境跑它必定卡在 `running as root` 上并连带跳过
  # 那四个探针——那是**量具用错了**，不是宿主没就绪。
  # 2026-08-16 真机实测（burn-vm-01）：同一台机器、同一时刻，普通用户跑是
  # 11 passed / 1 failed，root + /etc/dormice/env 跑是 20 passed / 0 failed，
  # 而其时 AC-2 十轮与 AC-6(a) 五条刚刚在这台机器上全绿。
  # 所以：能 sudo 就按 daemon 的真实身份与环境跑，判据才作数；不能就降为 WARN。
  # 可读性要**以 root 的身份**判：EnvironmentFile 通常是 0600 root:root
  # （burn-vm-01 实测就是），拿当前普通用户去 `[ -r ... ]` 必然为假，
  # 于是永远走不进这个分支。这行本身就是第一次真机跑批抓出来的。
  if sudo -n test -r /etc/dormice/env 2>/dev/null; then
    if sudo -n sh -c "set -a; . /etc/dormice/env; set +a; \
      export DORMICE_ENDPOINT=\"\${DORMICE_ENDPOINT:-http://127.0.0.1:$DORMICE_DAEMON_PORT}\"; \
      dor doctor"; then
      ok 'dor doctor 通过（以 daemon 的身份与环境）'
    else
      bad 'dor doctor 未通过（以 daemon 的身份与环境）'
    fi
  elif dor doctor; then
    ok 'dor doctor 通过'
  else
    warn 'dor doctor 未通过 —— 但本次是以普通用户、无 daemon 环境跑的，多半只是卡在
       running as root / DORMICE_* 未设。要让这条判据作数，请用 sudo 并带上 daemon 的
       EnvironmentFile 复跑：sudo sh -c ". /etc/dormice/env; dor doctor"'
  fi
else
  warn 'dor CLI 不在 PATH 上 —— 无法自检 Dormice 自身'
fi
if command -v systemctl >/dev/null 2>&1; then
  active="$(systemctl is-active dormice 2>/dev/null || true)"
  enabled="$(systemctl is-enabled dormice 2>/dev/null || true)"
  say "dormice.service : active=${active:-未知} enabled=${enabled:-未知}"
  if [ "$active" = 'active' ]; then ok 'dormice 正在运行'; else bad 'dormice 未在运行'; fi
  # roadmap P0.1 遗留③记的是「active 但 disabled，重启不自起」。
  # 2026-08-16 真机实测（burn-vm-01）：已是 active + enabled，该遗留项在这台机器上已消。
  if [ "$enabled" = 'enabled' ]; then
    ok 'dormice 已设开机自起'
  else
    warn 'dormice 未设开机自起（roadmap P0.1 遗留③）：sudo systemctl enable dormice'
  fi
fi

head1 '4. 镜像'
# 两个已知事实，别在真机上重新发现一遍（依据 selection-m0 §1 / roadmap P0.1 遗留①②）：
#   ① dormice-base:20260718 是**重建件**，apt 层浮动，与原件不保证逐字节一致；
#   ② workbench:0.7.10 缺失，任何 template: workbench 的 acquire 都会失败。
for image in "${QIANMO_DORMICE_BASE_IMAGE:-dormice-base:20260718}" "${QIANMO_DORMICE_TEMPLATE_IMAGE:-workbench:0.7.10}"; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    ok "镜像在：$image"
  else
    warn "镜像缺失：${image}（若是 workbench:0.7.10，这是已知遗留项，别用该 template）"
  fi
done

head1 '5. daemon 绑定不变式'
if [ -x "$OPS_DIR/check-daemon-bind.sh" ]; then
  "$OPS_DIR/check-daemon-bind.sh"
  case "$?" in
    0) ok "daemon 只监听回环（端口 ${DORMICE_DAEMON_PORT}）" ;;
    1) bad 'daemon 绑定不变式被破坏 —— AC-6(c) 当场不成立，先修这个再谈演示' ;;
    *) warn '无法判定 daemon 绑定（多半是 daemon 没在监听）' ;;
  esac
else
  bad "找不到 $OPS_DIR/check-daemon-bind.sh"
fi

head1 '6. 网络加固'
if [ "$APPLY" = '1' ]; then
  say '按 --apply 执行 scripts/ops/harden-dormice-host.sh（需要 root）'
  if sudo "$OPS_DIR/harden-dormice-host.sh"; then
    ok '加固已应用（幂等，重复执行不累积规则）'
    say '开机自起请按 scripts/ops/README.md 安装 dormice-harden.service'
  else
    bad '加固脚本执行失败'
  fi
else
  say '只预览（要真的加就带 --apply）：'
  "$OPS_DIR/harden-dormice-host.sh" --dry-run || warn '预览失败'
fi

head1 '7. 演示要用的环境变量（只列名字，不读值）'
# 逐条出处：ac2/p31/p41 三个脚本的 required 数组、ac6a 的 required 数组。
cat <<'EOF'
  QIANMO_SANDBOX_DAEMON_URL      daemon 的回环基址（非回环会被代码拒绝）
  QIANMO_SANDBOX_DAEMON_TOKEN    daemon bearer —— 不回显、不落盘
  QIANMO_TRANSPORT_PSK           传输层 PSK，宿主与沙箱内那份必须一致
  QIANMO_AC2_SANDBOX             目标沙箱在 daemon 里的 name（不是 id）
  QIANMO_AC2_TARGET_URL          沙箱内节点的监听地址，从宿主看过去
  QIANMO_P13_SANDBOX             AC-6(a) 用的一次性沙箱
  QIANMO_P41_ACTIVITY_PORT / QIANMO_P41_FREEZE_AFTER_SECONDS / QIANMO_P41_STOP_AFTER_SECONDS
  QIANMO_P31_ACTIVITY_PORT / QIANMO_P31_FREEZE_AFTER_SECONDS / QIANMO_P31_STOP_AFTER_SECONDS /
  QIANMO_P31_RESIDENT_TIMINGS_PATH
EOF

head1 '结论'
say "PASS=$PASS FAIL=$FAIL WARN=$WARN"
if [ "$FAIL" -gt 0 ]; then
  say '宿主未就绪 —— 上面每条 FAIL 都会让真机腿的某个 AC 直接跑不起来'
  exit 1
fi
say '宿主检查通过（WARN 项请逐条确认是否可接受）'
say '下一步：在目标沙箱里跑 demo/env/remote/prepare-sandbox.sh'
