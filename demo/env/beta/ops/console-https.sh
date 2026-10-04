#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌内测 · 控制台 HTTPS：证书（Let's Encrypt，DNS-01，Cloudflare，lego）+ TLS 前置单元。
#
#   console-https.sh install --domain <域名> [--listen 0.0.0.0:38443]
#                            [--upstream http://127.0.0.1:38621] [--lego <lego 可执行文件>]
#   console-https.sh issue [--staging]   # 签（或到期前续）；--staging 用独立目录，不碰正式证书
#   console-https.sh renew               # 给 timer 用；未到期 lego 什么都不做，换了证书就重启前置
#   console-https.sh deployed            # lego 的部署钩子（内部用）：前置在跑就重启它
#
# ── 为什么是这个形状 ─────────────────────────────────────────────────────────
# 控制台只听回环（beta-env.md §2.5），对外那一层 TLS 由 console-tls-front.ts 做。这台机器的
# 443 与 nginx 属于机器主人的另一套业务，不归本仓库管，所以前置听一个非 443 端口，证书
# 走 DNS-01（HTTP-01 要 80、TLS-ALPN-01 要 443，两个都不是我们的）。
#
# `install` 把前置程序与本脚本**拷进** <内测根>/ops/，单元只引用那两份拷贝——与
# mirror-pull.sh 同一个做法：单元不随交付树的版本漂移，换产物不用顺手重装它们。
#
# ── DNS 凭据 ────────────────────────────────────────────────────────────────
# <内测根>/secrets/cf-dns.env，**0600**，一行 `CF_DNS_API_TOKEN=<token>`。权限宽了就拒绝，
# 不是警告。它只在 lego 那一个进程的环境里出现：在一个子 shell 里 `set -a; .` 之后立刻
# `exec lego`——不进任何 argv、不落第二个文件、本脚本自己一个字节都不打印。
# 那枚 token 能改整个 zone，lego 只会建、删 `_acme-challenge.<域名>` 那一条 TXT；
# 「只动这一条」是 lego 的行为，不是 token 的边界，这一点要写进运维单页。
#
# ── 为什么要有 --staging ─────────────────────────────────────────────────────
# 正式环境按域名限速。第一次在一台新机器上跑 DNS-01，先对 staging 走通整条链（建 TXT →
# 传播 → 验证 → 删 TXT），再签正式的；staging 的账户与证书放在另一个目录，互不污染。

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# 装好的那一份在 <内测根>/ops/ 下，从自己的位置推根；仓库里那一份按环境变量找。
if [ -f "$HERE/../.qianmo-beta-env" ]; then
  BETA_ROOT="$(cd "$HERE/.." && pwd)"
else
  BETA_ROOT="${QIANMO_BETA_ROOT:-$HOME/qianmo-beta}"
fi
MARKER="$BETA_ROOT/.qianmo-beta-env"
MARKER_MAGIC='qianmo-beta-env/v1'
OPS_DIR="$BETA_ROOT/ops"
SECRET_DIR="$BETA_ROOT/secrets"
TOKEN_FILE="$SECRET_DIR/cf-dns.env"
CONF="$OPS_DIR/console-https.env"
LEGO_DIR="$BETA_ROOT/tls/lego"
LEGO_STAGING_DIR="$BETA_ROOT/tls/lego-staging"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
FRONT_UNIT='qianmo-tls-front.service'
CERT_UNIT='qianmo-console-cert.service'
CERT_TIMER='qianmo-console-cert.timer'
ACCOUNT_ID='qianmo-console'

say() { printf '%s\n' "$*"; }
die() {
  printf '[console-https] %s\n' "$*" >&2
  exit 1
}

require_marker() {
  [ -f "$MARKER" ] || die "$BETA_ROOT 不是内测环境（缺 ${MARKER}）"
  head -1 "$MARKER" | grep -qF "$MARKER_MAGIC" \
    || die "$MARKER 的首行不是 ${MARKER_MAGIC}，拒绝操作"
}

# 八进制权限位，GNU 与 BSD stat 各一种写法。
file_mode() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"
}

# 单元里的路径：家目录下的写成 %h/…，与 beta-up.sh 的 beta_unit_path 同一个约定。
unit_path() {
  case "$1" in
    "$HOME"/*) printf '%%h/%s' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

systemd_user_ok() {
  [ "${QIANMO_CONSOLE_HTTPS_NO_SYSTEMCTL:-0}" = '1' ] && return 1
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user show-environment >/dev/null 2>&1
}

load_conf() {
  [ -f "$CONF" ] || die "缺 $CONF —— 先跑 console-https.sh install --domain <域名>"
  # shellcheck disable=SC1090
  . "$CONF"
  : "${CONSOLE_HTTPS_DOMAIN:?}" "${CONSOLE_HTTPS_LEGO:?}"
}

check_token_file() {
  [ -e "$TOKEN_FILE" ] || die "缺 DNS 凭据 ${TOKEN_FILE}（0600，一行 CF_DNS_API_TOKEN=…）"
  [ -f "$TOKEN_FILE" ] && [ ! -L "$TOKEN_FILE" ] || die "$TOKEN_FILE 不是普通文件"
  [ "$(file_mode "$TOKEN_FILE")" = '600' ] \
    || die "$TOKEN_FILE 权限是 $(file_mode "$TOKEN_FILE")，要 600"
}

# lego run：签或续。第一个参数是数据目录，其余原样追加。
#
# `--dns.propagation.disable-rns`：只查权威 NS，不查本机的递归解析器。2026-09-26 在 H
# 上实测：lego 在建 TXT **之前**先查过一次 `_acme-challenge.<域名>`，本机 systemd-resolved
# 于是缓存了那个 NXDOMAIN（负缓存时长跟 zone 的 SOA 走），此后两分钟的传播检查一直读到
# 缓存、以超时失败——记录其实早就在权威 NS 上了。权威那一格照查，所以「记录真的发布了」
# 这件事仍然被验证；去掉的只是一个会被本机缓存骗到的旁证。
run_lego() {
  local dir="$1"
  shift
  check_token_file
  [ -x "$CONSOLE_HTTPS_LEGO" ] || die "lego 不可执行：$CONSOLE_HTTPS_LEGO"
  mkdir -p "$dir"
  chmod 700 "$BETA_ROOT/tls" "$dir"
  (
    set -a
    # shellcheck disable=SC1090
    . "$TOKEN_FILE"
    set +a
    [ -n "${CF_DNS_API_TOKEN:-}" ] || die "$TOKEN_FILE 里没有 CF_DNS_API_TOKEN"
    exec "$CONSOLE_HTTPS_LEGO" run --accept-tos --account-id "$ACCOUNT_ID" \
      --dns cloudflare --dns.propagation.disable-rns \
      --domains "$CONSOLE_HTTPS_DOMAIN" --path "$dir" \
      --log.format text "$@"
  )
}

render() {
  local src="$1" dst="$2" bun_path
  bun_path="$(command -v bun 2>/dev/null || printf '%s' "$HOME/.bun/bin/bun")"
  sed -e "s|@OPS_DIR@|$(unit_path "$OPS_DIR")|g" \
    -e "s|@BUN@|$(unit_path "$bun_path")|g" \
    "$src" >"$dst"
  if grep -q '@[A-Z_]*@' "$dst"; then die "模板里有没替换掉的占位符：$src"; fi
}

cmd_install() {
  local domain='' listen='0.0.0.0:38443' upstream='http://127.0.0.1:38621'
  local lego="$HOME/.local/lego/lego"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --domain) domain="${2:?}"; shift 2 ;;
      --listen) listen="${2:?}"; shift 2 ;;
      --upstream) upstream="${2:?}"; shift 2 ;;
      --lego) lego="${2:?}"; shift 2 ;;
      *) die "install 不认识的参数：$1" ;;
    esac
  done
  [ -n "$domain" ] || die 'install 要 --domain <域名>'
  case "$domain" in *[!A-Za-z0-9.-]*) die "域名里有不该有的字符：$domain" ;; esac
  case "$listen$upstream$lego" in *[[:space:]]*) die '参数里不能有空白（systemd 按空白分词）' ;; esac
  require_marker
  # install 要读 *.in 模板，而装好的那一份旁边只有渲染过的单元。从那里跑它会在
  # 拷贝自己时撞上「同一个文件」、在参数文件改写之前就退出——2026-09-26 在 H 上
  # 这样让前置对着旧上游多跑了半分钟。所以当场拒绝，而不是半途失败。
  if [ "$HERE" = "$OPS_DIR" ]; then
    die "install 要从仓库（交付树）里那一份跑：demo/env/beta/ops/console-https.sh install …"
  fi
  mkdir -p "$OPS_DIR" "$UNIT_DIR"

  cp "$HERE/console-tls-front.ts" "$OPS_DIR/console-tls-front.ts"
  chmod 644 "$OPS_DIR/console-tls-front.ts"
  cp "$HERE/console-https.sh" "$OPS_DIR/console-https.sh"
  chmod 700 "$OPS_DIR/console-https.sh"

  {
    printf '# 阡陌内测 · 控制台 HTTPS 的参数。由 console-https.sh install 写，前置与续期单元读。\n'
    printf 'CONSOLE_HTTPS_DOMAIN=%s\n' "$domain"
    printf 'CONSOLE_HTTPS_LISTEN=%s\n' "$listen"
    printf 'CONSOLE_HTTPS_UPSTREAM=%s\n' "$upstream"
    printf 'CONSOLE_HTTPS_CERT=%s\n' "$LEGO_DIR/certificates/$domain.crt"
    printf 'CONSOLE_HTTPS_KEY=%s\n' "$LEGO_DIR/certificates/$domain.key"
    printf 'CONSOLE_HTTPS_LEGO=%s\n' "$lego"
  } >"$CONF"
  chmod 600 "$CONF"

  local unit
  for unit in "$FRONT_UNIT" "$CERT_UNIT" "$CERT_TIMER"; do
    render "$HERE/$unit.in" "$OPS_DIR/$unit"
    cp "$OPS_DIR/$unit" "$UNIT_DIR/$unit"
    chmod 644 "$UNIT_DIR/$unit"
  done
  say "已装：${CONF}、$OPS_DIR/{console-tls-front.ts,console-https.sh}、$UNIT_DIR/{$FRONT_UNIT,$CERT_UNIT,$CERT_TIMER}"

  if systemd_user_ok; then
    systemctl --user daemon-reload
    systemctl --user enable "$CERT_TIMER" "$FRONT_UNIT" >/dev/null
    systemctl --user start "$CERT_TIMER"
    if [ "$(systemctl --user is-active "$FRONT_UNIT" 2>/dev/null || true)" = 'active' ]; then
      say "已 enable：${CERT_TIMER}、${FRONT_UNIT}。前置**正在跑旧参数**——要生效：systemctl --user restart $FRONT_UNIT"
    else
      say "已 enable：${CERT_TIMER}（已启动）、${FRONT_UNIT}（**没有启动**——证书在了再 systemctl --user start ${FRONT_UNIT}）"
    fi
  else
    say '这台机器上没有可用的 systemd --user：单元文件已写好，没有 enable'
  fi
}

cmd_issue() {
  load_conf
  require_marker
  if [ "${1:-}" = '--staging' ]; then
    run_lego "$LEGO_STAGING_DIR" --server letsencrypt-staging
  elif [ "$#" -eq 0 ]; then
    run_lego "$LEGO_DIR" --deploy-hook "$OPS_DIR/console-https.sh deployed"
  else
    die "issue 只认 --staging：$1"
  fi
}

cmd_renew() {
  load_conf
  require_marker
  run_lego "$LEGO_DIR" --deploy-hook "$OPS_DIR/console-https.sh deployed"
}

# 证书换了：前置只在启动时读证书，在跑就重启它；没在跑就什么都不做（第一次签发时
# 前置还没起，不该被钩子顺手拉起来）。
cmd_deployed() {
  if systemd_user_ok; then
    systemctl --user try-restart "$FRONT_UNIT"
    say "证书已更新；${FRONT_UNIT} 若在跑已重启"
  else
    say '证书已更新；这台机器上没有 systemd --user，前置要手动重启'
  fi
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  issue) shift; cmd_issue "$@" ;;
  renew) shift; cmd_renew "$@" ;;
  deployed) shift; cmd_deployed "$@" ;;
  -h|--help|'') sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "不认识的子命令：$1" ;;
esac
