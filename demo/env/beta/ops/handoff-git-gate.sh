#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 阡陌接力（P17.4）· git over SSH 的闸门：一把钥匙只能对一个根目录下的已有裸仓做 fetch / push。
#
#   handoff-git-gate.sh <根目录>                                            # sshd 经 command= 调用
#   handoff-git-gate.sh authorized-key --root <根目录> --pubkey <公钥文件>   # 打印 authorized_keys 那一行
#
# ── 放在哪（handoff-p17-plan.md D-2 与 P17.4「SSH 闸门」）──────────────────────
# 代码与会话走同一条数据面：git over SSH，由发起方拨出。两处各装一行：
#   中枢上：用户本机的一把**专用**钥匙（`qm handoff sync` / `now` / `pull`），根目录是中枢的接力裸仓目录。
#   节点上：中枢的一把**新**钥匙（中枢往节点推影子提交、取回 qianmo/<task>），根目录是节点工作仓所在目录。
# 节点上那把只读审计链的钥匙（`command="cat -- <链>"`，见 mirror-pull.sh 文件头）不动、不放宽。
#
# 钥匙必须**专用**：sshd 用 authorized_keys 里第一条匹配的那一行。这把钥匙若也是平时登录用的
# 那把，登录从此也被闸门拦下；客户端侧要 `ssh -i <专用钥匙> -o IdentitiesOnly=yes`，否则 ssh 先试到
# 的可能是另一把不受闸门约束的钥匙。
#
# 闸门**不建仓**：裸仓由 `qm handoff init` 经用户自己的（不带闸门的）SSH 登录 `git init --bare`
# 建好，仓不存在就拒绝。这把钥匙因此只能往已经登记过的仓里写。
#
# ── 客户端实际发来什么（2026-10-03 实测：git 2.54.0 / Apple Git-157，GIT_SSH_COMMAND 指到一个
#    记录 argv 的桩，ls-remote / fetch / clone / push / archive --remote 各跑一遍）──────────
#   ssh://hub/srv/r/a.git              → git-upload-pack '/srv/r/a.git'
#   ssh://hub/~/r/a.git、hub:~/r/a.git  → git-upload-pack '~/r/a.git'
#   hub:r/a.git                        → git-upload-pack 'r/a.git'        （相对路径）
#   ssh://hub/srv/r/a.git/             → git-upload-pack '/srv/r/a.git/'  （URL 末尾的 / 原样带来）
#   git push                           → git-receive-pack '<路径>'
#   --upload-pack 'git upload-pack'    → git upload-pack '<路径>'         （空格形式；receive 同理）
#   git archive --remote               → git-upload-archive '<路径>'      （拒绝）
# 路径**总是**包在一对单引号里；路径里的 ' 与 ! 被编成 '\'' 与 '\!'（git 的 sq_quote），~user/ 原样
# 透传。整条命令是 ssh 的最后一个参数。协议 v2 时 fetch / ls-remote / clone 另带
# `-o SendEnv=GIT_PROTOCOL`（环境里 GIT_PROTOCOL=version=2），push 不带。只实测了 git 本身。
#
# ── 判定（任何一步不过：stderr 一行原因，退出码 3）──────────────────────────────
# ① SSH_ORIGINAL_COMMAND 非空。真 sshd（OpenSSH 10.3）实测：不带命令、`ssh host ''`、`ssh -tt`
#    都**不设**这个变量（`restrict` 也不给 pty）；sftp 与默认走 SFTP 的 scp 给的是 sshd_config 里
#    Subsystem 的值（如 internal-sftp），`scp -O` 给 `scp -t <路径>`——这些与 git-upload-archive、
#    sh -c 一样落到下一条。
# ② 整条恰好是 `<动词> '<路径>'`：动词只认 git-upload-pack、git upload-pack、git-receive-pack、
#    git receive-pack，后面恰好一个空格，再是一对单引号。不解析、不 eval——只剥掉首尾那对引号。
# ③ 路径只许 [A-Za-z0-9._~/-]。这一条一次挡掉 shell 元字符（; $ ` | & < > 空格 引号 反斜杠）、
#    换行与一切控制字符、非 ASCII，以及 git 的 '\'' / '\!' 转义。NUL 到不了这里：环境变量是
#    C 字符串，最多到达截断后的前半截，而那一截过不了 ②。**项目名因此也只能用这套字符**，
#    `qm handoff init` 那边要按同一套校验。
# ④ 不许以 - 开头（会被 git 当成选项）；~ 只许作开头的 ~/（~user/ 拒绝）；有 .. 段就拒绝——
#    不先解析再看落在哪，见到就拒。
# ⑤ ~/ 与相对路径都按 $HOME 展开（sshd 在登录目录里起 command=，git 自己解析相对路径也是相对
#    那里）；末尾一个 / 去掉；请求的名字必须是 <至少一个字符>.git。
# ⑥ 规范化：用 `cd -P` + `pwd -P` 求物理路径，根目录同样求一次，所以根目录本身是软链、
#    或者路径经过 macOS 的 /var → /private/var 都比得对。不用 realpath(1)：cd -P / pwd -P 是 bash
#    内建，不依赖外部命令在各平台上的版本与选项差异；这里本来就要求目录存在，cd -P 就够了。
# ⑦ 规范化之后必须严格在根目录**之下**（/srv/repos-evil 不算 /srv/repos 之下）。不存在、进不去、
#    软链逃逸、绝对路径越界给**同一句**话，免得这把钥匙变成「根目录外某个目录在不在」的探针。
# ⑧ 规范化之后名字仍是 <…>.git，且是裸仓：HEAD、objects/、refs/ 都在，core.bare=true，并且
#    **没有 .git 子项**——不带 --strict 的 git-upload-pack 进仓时先试 <路径>/.git（实测：裸仓里
#    放一个 .git，广告出来的是里面那个仓的引用）。
# 判定之前先清掉 GIT_PROTOCOL 以外的 GIT_* 环境变量（sshd 若 AcceptEnv 放得太宽，
# GIT_CONFIG_PARAMETERS、GIT_TRACE 一类就能改掉 git 的行为）；通过后 `exec git-<服务> <规范化路径>`：
# argv 直接交给内核，不经过任何 shell。
#
# 退出码：3 = 拒绝这次请求；2 = 闸门自身的配置或用法错（根目录不对、参数不对）。放行时退出码
# 是 git-upload-pack / git-receive-pack 自己的。
#
# 闸门不管引用级的规矩（能推哪些 ref）——那归 receive-pack 的钩子或调用方。
# 选项行只有 `restrict` 与 `command=`：`restrict` 关掉端口转发、代理转发、X11、pty 与 ~/.ssh/rc
# （OpenSSH 7.2 起有。本机 OpenSSH 10.3 实测：服务端 AllowTcpForwarding yes 时 -L / -W / -R 照样被
# 这一行拒掉，-tt 要不到 pty；代理转发、X11、rc 没有实测。更老的 sshd 不认这个词时整行作废，
# 是关着的那一边——按 OpenSSH 的选项解析规则推断，未实测）。sshd_config 的
# AcceptEnv 只该放 LANG LC_* GIT_PROTOCOL：BASH_ENV、LD_PRELOAD 这类在闸门第一行之前就生效了，
# 脚本里拦不住。

set -euo pipefail

# 下面的字符类与 ${#} 都按字节算，不随登录用户的 locale 变。
LC_ALL=C
export LC_ALL
unset CDPATH

GATE_NAME='handoff-git-gate'

deny() {
  printf '[%s] 拒绝：%s\n' "$GATE_NAME" "$1" >&2
  exit 3
}

die_config() {
  printf '[%s] %s\n' "$GATE_NAME" "$1" >&2
  exit 2
}

usage() {
  sed -n '5,8p' "$0" | sed 's/^# \{0,1\}//'
}

# 目录的物理路径；不存在、不是目录或进不去时失败。
canon_dir() (
  cd -P -- "$1" 2>/dev/null && pwd -P
)

is_bare_repo() {
  local dir="$1" bare
  if [ ! -f "$dir/HEAD" ] || [ ! -d "$dir/objects" ] || [ ! -d "$dir/refs" ]; then
    return 1
  fi
  if [ -e "$dir/.git" ] || [ -L "$dir/.git" ]; then
    return 1
  fi
  # --file 只读这一份文件（不跟 include），与 $HOME 是不是某个仓库无关。
  bare="$(git config --file "$dir/config" --bool core.bare 2>/dev/null)" || return 1
  [ "$bare" = true ]
}

serve() {
  local root="$1" root_canon cmd svc rest path rel abs base canon v
  # 在跑任何 git 命令之前：裸仓检查里那条 `git config` 也吃这些变量（GIT_TRACE=<文件> 就能让它
  # 往任意文件追加）。
  for v in "${!GIT_@}"; do
    [ "$v" = GIT_PROTOCOL ] || unset "$v"
  done
  root_canon="$(canon_dir "$root")" || die_config "根目录不存在或进不去：$root"
  [ "$root_canon" != / ] || die_config '根目录不能是 /'

  # ①
  cmd="${SSH_ORIGINAL_COMMAND-}"
  [ -n "$cmd" ] \
    || deny "没有命令（交互登录或空命令）；这把钥匙只能跑 git-upload-pack / git-receive-pack"
  [ "${#cmd}" -le 4096 ] || deny '命令超过 4096 字节'

  # ②
  case "$cmd" in
    'git-upload-pack '*) svc=upload-pack; rest="${cmd#'git-upload-pack '}" ;;
    'git upload-pack '*) svc=upload-pack; rest="${cmd#'git upload-pack '}" ;;
    'git-receive-pack '*) svc=receive-pack; rest="${cmd#'git-receive-pack '}" ;;
    'git receive-pack '*) svc=receive-pack; rest="${cmd#'git receive-pack '}" ;;
    *) deny "只放行 git-upload-pack '<路径>' 与 git-receive-pack '<路径>'" ;;
  esac
  case "$rest" in
    \'*\') path="${rest#\'}"; path="${path%\'}" ;;
    *) deny '路径必须恰好包在一对单引号里（git 客户端就是这么发的）' ;;
  esac

  # ③ ④（从这里往后，path 只含白名单字符，可以原样写进拒绝原因）
  [ -n "$path" ] || deny '路径是空的'
  case "$path" in
    *[!A-Za-z0-9._~/-]*) deny '路径里有不允许的字符（只许 A-Z a-z 0-9 . _ ~ / -）' ;;
  esac
  case "$path" in -*) deny "路径不能以 - 开头：$path" ;; esac
  case "/$path/" in */../*) deny "路径里不许有 .. 段：$path" ;; esac

  # ⑤（这里的 ~ 是客户端发来的字面字符，不是要 shell 展开的那个）
  case "$path" in
    /*) abs="$path" ;;
    *)
      case "$path" in
        \~/*) rel="${path#\~/}" ;;
        \~*) deny "只认 ~/，不认 ~<用户>/：$path" ;;
        *) rel="$path" ;;
      esac
      case "${HOME-}" in
        /*) abs="$HOME/$rel" ;;
        *) deny "相对路径与 ~/ 要按 \$HOME 展开，而 \$HOME 不是绝对路径：$path" ;;
      esac
      ;;
  esac
  abs="${abs%/}"
  base="${abs##*/}"
  case "$base" in ?*.git) ;; *) deny "仓的名字必须是 <名字>.git：$path" ;; esac

  # ⑥ ⑦
  canon="$(canon_dir "$abs")" \
    || deny "根目录下没有这个仓：${path}（不存在，或解析后在根目录之外；闸门不建仓）"
  case "$canon" in
    "$root_canon"/?*) ;;
    *) deny "根目录下没有这个仓：${path}（不存在，或解析后在根目录之外；闸门不建仓）" ;;
  esac

  # ⑧
  case "${canon##*/}" in ?*.git) ;; *) deny "解析之后不是 <名字>.git：$path" ;; esac
  is_bare_repo "$canon" || deny "不是裸仓：$path"

  exec "git-$svc" "$canon"
}

# authorized_keys 的 command= 由登录 shell 再 `-c` 一次：路径里只放不需要引号的字符。
shell_safe_abs() {
  local what="$1" value="$2"
  case "$value" in /*) ;; *) die_config "$what 必须是绝对路径：$value" ;; esac
  case "$value" in
    *[!A-Za-z0-9._/-]*) die_config "$what 里只许 A-Z a-z 0-9 . _ / -（它要进 command=）：$value" ;;
  esac
  case "$value/" in */../*) die_config "$what 里不许有 .. 段：$value" ;; esac
}

cmd_authorized_key() {
  local root='' pubkey='' here gate lines line type blob comment
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --root) root="${2:?--root 缺值}"; shift 2 ;;
      --pubkey) pubkey="${2:?--pubkey 缺值}"; shift 2 ;;
      *) die_config "authorized-key 不认识的参数：$1" ;;
    esac
  done
  [ -n "$root" ] && [ -n "$pubkey" ] \
    || die_config '用法：authorized-key --root <根目录> --pubkey <公钥文件>'
  shell_safe_abs '--root' "$root"
  [ -d "$root" ] || die_config "根目录不存在：${root}（先 mkdir -p 它；闸门不建目录）"

  here="$(cd "$(dirname "$0")" && pwd)"
  gate="$here/$(basename "$0")"
  shell_safe_abs '闸门路径' "$gate"

  [ -f "$pubkey" ] || die_config "公钥文件不存在：$pubkey"
  lines="$(grep -c '' "$pubkey")" || true
  [ "$lines" = 1 ] || die_config "公钥文件要恰好一行（现在 ${lines:-0} 行）：$pubkey"
  IFS= read -r line <"$pubkey" || true
  case "$line" in *[[:cntrl:]]*) die_config "公钥里有控制字符：$pubkey" ;; esac
  read -r type blob comment <<<"$line"
  case "$type" in
    ssh-ed25519 | ssh-rsa | ecdsa-sha2-nistp256 | ecdsa-sha2-nistp384 | ecdsa-sha2-nistp521) ;;
    sk-ssh-ed25519@openssh.com | sk-ecdsa-sha2-nistp256@openssh.com) ;;
    *) die_config "不像一把 OpenSSH 公钥（开头不是密钥类型；给的是私钥，或已经带了选项？）：$pubkey" ;;
  esac
  case "$blob" in
    '' | *[!A-Za-z0-9+/=]*) die_config "公钥正文不是 base64：$pubkey" ;;
  esac
  printf 'restrict,command="%s %s" %s %s%s\n' "$gate" "$root" "$type" "$blob" "${comment:+ $comment}"
}

case "${1:-}" in
  authorized-key) shift; cmd_authorized_key "$@" ;;
  -h | --help) usage ;;
  /*)
    [ "$#" -eq 1 ] || die_config "command= 里只能有一个参数（根目录），现在 $# 个"
    serve "$1"
    ;;
  '') usage >&2; exit 2 ;;
  *) die_config "根目录必须是绝对路径：$1" ;;
esac
