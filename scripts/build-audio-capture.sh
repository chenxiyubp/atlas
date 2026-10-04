#!/usr/bin/env bash
# Copyright 2026 Qianmo AgentNest Team
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# 构建 `vendor/audio-capture/` 下六个平台三元组的 audio-capture.node。
#
# 背景：`vendor/audio-capture/` 随产物分发六个预编译原生模块，转 AGPL 之后
# copyleft 要求随分发提供 Corresponding Source（见 docs/dev/license-chain-m0.md
# D-9）。源码现在写在 packages/audio-capture-napi/native/（Rust crate，
# package name = audio-capture，crate-type = cdylib），本脚本负责把它编译成
# 六个平台各自的产物、并按需装进 vendor/ 对应目录。
#
# **这是一个带外的开发者工具，不接进 bun run precheck / verify / CI**——
# 理由与用法细节见 docs/dev/audio-capture-native.md。CI runner 上没有 Rust
# 工具链，接进阻塞门禁只会让门禁全红；这个原生模块本身是可选能力
# （packages/audio-capture-napi/src/index.ts 在模块缺失时全部函数优雅降级）。
#
# **--install 有一道校验闸门**：写进 vendor/ 之前，凡是本机能原生加载的产物
# （构建 triple 与宿主 OS/架构一致）都会先过 verify_artifact——用 bun 加载
# 一份临时拷贝、核对八个导出函数齐全、且 microphoneAuthorizationStatus()
# 落在 0..3。不过就拒绝安装、非零码退出、且不碰 vendor/。交叉构建出来的产物
# （例如在 macOS 上构建的 Linux/Windows 产物）本机跑不了这个探针，默认同样
# 拒绝安装；确认要装就必须显式加 --allow-unverified-install，并会在 stderr
# 打一行醒目警告——那份 .node 还没有在任何机器上验证过，需要到目标平台自己
# 核实一遍。理由：packages/audio-capture-napi/src/index.ts 的 loadModule()
# 会把 require() 的异常整个吞掉、逐个候选路径试完就 return null，装进去一个
# 加载不了的 .node，表现不是报错，是语音功能静默消失，且没有任何诊断信息
# 指向这次 install。
#
# **Linux 交叉构建需要 ALSA 开发头文件**：cpal 在 Linux 上必然经 alsa-sys
# 链接系统 ALSA（libasound.so + alsa.pc），而 cross 的官方
# x86_64-unknown-linux-gnu / aarch64-unknown-linux-gnu 镜像不带
# libasound2-dev，不装会在 alsa-sys 的 build script 阶段报
# "The system library `alsa` required by crate `alsa-sys` was not found."
# （已实测复现）。本脚本用 `scripts/audio-capture-cross.toml`（CROSS_CONFIG
# 环境变量指向它）在两个 Linux target 的 pre-build 阶段装
# libasound2-dev——**已实测**：cross 默认只在 Cargo.toml 所在目录（即
# packages/audio-capture-napi/native/ 本身）找 Cross.toml，不会向上翻到
# 仓库根，所以这份配置必须靠显式 CROSS_CONFIG 才会生效，脚本在调用
# `cross build` 前会自动导出它，不需要手动设置。`--check` 会核对这份配置
# 是否存在、是否覆盖了对应 target，缺了不报 READY。
#
# **所有 cargo / cross 调用必须先 cd 进 packages/audio-capture-napi/native/，
# 光给 --manifest-path 不够。**cargo 的 `.cargo/config.toml` 和 rustup 的
# `rust-toolchain.toml` 都是**从当前工作目录逐级向上**查找的，--manifest-path
# 不参与这个查找。已实测两条：把 rustflags 写进 crate 的 .cargo/config.toml，
# 在 crate 目录里 `cargo build -v` 的 rustc 命令行上能看到那个 flag，退到上级
# 目录改用 `--manifest-path <绝对路径>` 跑同一条命令就完全看不到；`rustc
# --version` 同理——在仓库根拿到的是宿主默认版本，进到 crate 目录才是
# rust-toolchain.toml 钉的那一版（本机实测 1.82.0 → 1.85.0，而 1.82 根本
# 构建不出这个 crate，见下面 --check 一节关于 coreaudio-sys 的说明）。
#
# 漏掉 cd 的后果不是构建失败，是**静默产出错的二进制**：
# packages/audio-capture-napi/native/.cargo/config.toml 给
# x86_64-pc-windows-msvc 和 aarch64-pc-windows-msvc 打开了 +crt-static，
# 漏掉它就会得到一份动态链接 CRT、依赖 vcruntime140.dll 的 .node。那个 DLL
# 来自 Visual C++ 可再发行组件包，既不随 Windows 出厂、也不随 Node.js 安装
# 程序分发；目标机上缺它时 packages/audio-capture-napi/src/index.ts 的
# loadModule() 会把 require() 的异常整个吞掉，表现是语音功能静默消失、不留
# 任何线索（第一次 CI 构建出来的产物就带着它，已实测复现）。
#
# 所以：本脚本自己执行时一律套 `( cd "${NATIVE_DIR}" && ... )`，而**打印给人
# 照抄的命令也一律带上那个 cd、并且不再写 --manifest-path**——带着
# --manifest-path 的写法会让人以为不需要 cd，而它恰恰救不了上面两件事。
# （已实测 `cargo metadata` 在「cd 后不带 --manifest-path」与「cd 后带
# --manifest-path」两种形式下解析出完全相同的 workspace_root 与包，去掉它
# 对构建本身没有任何影响。）
#
# 用法：
#   scripts/build-audio-capture.sh                          构建当前平台
#   scripts/build-audio-capture.sh --target <triple>         构建指定 triple（可重复）
#   scripts/build-audio-capture.sh --all                     构建全部六个 triple
#   scripts/build-audio-capture.sh --install                 构建后把产物装进 vendor/（过校验闸门）
#   scripts/build-audio-capture.sh --allow-unverified-install 配合 --install，放行本机验证不了的产物
#   scripts/build-audio-capture.sh --check                    只检查各 triple 就绪度，不构建
#
# 选项可组合，例如 `--all --install` 或 `--target x86_64-unknown-linux-gnu --install`。
#
# bash 3.2 兼容（macOS 自带 bash 就是 3.2）：不用 declare -A、不用 ${var,,}，
# 且所有变量展开一律写 ${var} 花括号形式——本仓库踩过 `$var` 紧跟全角标点被
# 3.2 解析成变量名一部分、报 "unbound variable" 的坑（demo/env 下的既有约定）。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
NATIVE_DIR="${REPO_ROOT}/packages/audio-capture-napi/native"
MANIFEST="${NATIVE_DIR}/Cargo.toml"
VENDOR_ROOT="${REPO_ROOT}/vendor/audio-capture"

# cross(1) 的 pre-build 配置（装 libasound2-dev，见脚本头部注释）。放在
# scripts/ 下、不叫裸的 Cross.toml，是为了不让人误以为它会被裸 `cross`
# 命令自动发现——它只在本脚本显式导出 CROSS_CONFIG 时才生效（已实测，见
# scripts/audio-capture-cross.toml 自己的头部注释）。
CROSS_CONFIG_FILE="${SCRIPT_DIR}/audio-capture-cross.toml"

# 六个受支持的 triple，与 packages/audio-capture-napi/src/index.ts 里
# `${process.arch}-${process.platform}` 取值一一对应。
ALL_TRIPLES="aarch64-apple-darwin x86_64-apple-darwin aarch64-unknown-linux-gnu x86_64-unknown-linux-gnu aarch64-pc-windows-msvc x86_64-pc-windows-msvc"

# verify_artifact 核对的八个导出函数名，抄自
# packages/audio-capture-napi/src/index.ts 的 AudioCaptureNapi 类型
# （第 31-45 行）。JS 装载层把 microphoneAuthorizationStatus 当可选
# （`mod.microphoneAuthorizationStatus?.()`），但一份新构建出来的产物应当
# 八个都实现，所以这里全部按必需校验。
REQUIRED_EXPORTS="startRecording stopRecording isRecording startPlayback writePlaybackData stopPlayback isPlaying microphoneAuthorizationStatus"

usage() {
  cat <<'EOF'
用法: scripts/build-audio-capture.sh [--target <triple>]... [--all] [--install] [--allow-unverified-install] [--check]

  --target <triple>            构建指定 Rust target triple（可重复出现多次）
  --all                        构建全部六个受支持的 triple
  --install                    构建成功后，把产物复制进 vendor/audio-capture/<arch>-<platform>/audio-capture.node
                                （安装前必须过 verify_artifact 校验闸门，见脚本头部注释）
  --allow-unverified-install   配合 --install：本机原生跑不了的产物（跨平台/跨架构交叉构建）
                                默认拒绝安装，加这个标志才放行，会打印醒目警告
  --check                      只检查六个 triple 的工具链就绪度，不实际构建（退出码恒为 0）
  -h, --help                   显示本帮助

不带任何 target 相关参数时，构建当前平台（用 uname -s / uname -m 推导 triple）。

受支持的 triple:
  aarch64-apple-darwin        -> vendor/audio-capture/arm64-darwin/
  x86_64-apple-darwin         -> vendor/audio-capture/x64-darwin/
  aarch64-unknown-linux-gnu   -> vendor/audio-capture/arm64-linux/
  x86_64-unknown-linux-gnu    -> vendor/audio-capture/x64-linux/
  aarch64-pc-windows-msvc     -> vendor/audio-capture/arm64-win32/
  x86_64-pc-windows-msvc      -> vendor/audio-capture/x64-win32/
EOF
}

# ---------------------------------------------------------------------------
# triple <-> vendor 目录 / 产物文件名 / 平台族 / 架构 的映射
# ---------------------------------------------------------------------------

triple_platform_dir() {
  case "${1}" in
    aarch64-apple-darwin) echo "arm64-darwin" ;;
    x86_64-apple-darwin) echo "x64-darwin" ;;
    aarch64-unknown-linux-gnu) echo "arm64-linux" ;;
    x86_64-unknown-linux-gnu) echo "x64-linux" ;;
    aarch64-pc-windows-msvc) echo "arm64-win32" ;;
    x86_64-pc-windows-msvc) echo "x64-win32" ;;
    *) return 1 ;;
  esac
}

triple_artifact_name() {
  case "${1}" in
    *apple-darwin) echo "libaudio_capture.dylib" ;;
    *linux*) echo "libaudio_capture.so" ;;
    *windows*) echo "audio_capture.dll" ;;
    *) return 1 ;;
  esac
}

triple_family() {
  case "${1}" in
    *apple-darwin) echo "darwin" ;;
    *linux*) echo "linux" ;;
    *windows*) echo "windows" ;;
    *) return 1 ;;
  esac
}

triple_arch() {
  case "${1}" in
    aarch64-*) echo "aarch64" ;;
    x86_64-*) echo "x86_64" ;;
    *) return 1 ;;
  esac
}

is_known_triple() {
  local triple="${1}"
  local t
  for t in ${ALL_TRIPLES}; do
    if [ "${t}" = "${triple}" ]; then
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# 宿主环境探测
# ---------------------------------------------------------------------------

detect_host_os() {
  local os_name
  os_name="$(uname -s)"
  case "${os_name}" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

detect_host_arch() {
  local arch_name
  arch_name="$(uname -m)"
  case "${arch_name}" in
    arm64|aarch64) echo "aarch64" ;;
    x86_64|amd64) echo "x86_64" ;;
    *) return 1 ;;
  esac
}

detect_host_triple() {
  local os_name arch_component
  arch_component="$(detect_host_arch)" || {
    echo "错误：未识别的架构 $(uname -m)，请改用 --target 显式指定 triple" >&2
    return 1
  }
  os_name="$(uname -s)"

  case "${os_name}" in
    Darwin) echo "${arch_component}-apple-darwin" ;;
    Linux) echo "${arch_component}-unknown-linux-gnu" ;;
    MINGW*|MSYS*|CYGWIN*) echo "${arch_component}-pc-windows-msvc" ;;
    *)
      echo "错误：未识别的操作系统 ${os_name}，请改用 --target 显式指定 triple" >&2
      return 1
      ;;
  esac
}

# 本机能不能原生跑起这个 triple 的产物（OS 与架构都与宿主一致）。
# 用来判断 verify_artifact 能不能真的 require() 加载它——跨平台/跨架构的
# 交叉构建产物在本机永远加载不了，不是产物坏了，是宿主运行不了那种二进制。
can_run_natively() {
  local triple="${1}"
  local family host_os triple_arch_val host_arch_val
  family="$(triple_family "${triple}")" || return 1
  host_os="$(detect_host_os)"
  if [ "${family}" != "${host_os}" ]; then
    return 1
  fi
  triple_arch_val="$(triple_arch "${triple}")" || return 1
  host_arch_val="$(detect_host_arch)" || return 1
  [ "${triple_arch_val}" = "${host_arch_val}" ]
}

crate_present() {
  [ -f "${MANIFEST}" ]
}

is_target_installed() {
  local triple="${1}"
  rustup target list --installed 2>/dev/null | grep -Fxq "${triple}"
}

has_cross() {
  command -v cross >/dev/null 2>&1
}

docker_running() {
  docker info >/dev/null 2>&1
}

# cross 构建 Linux target 时是否具备 ALSA 的 pre-build 配置：文件存在，且
# 里面有该 triple 的 [target.<triple>] 段落。缺任何一个都不能报 READY——
# 光有 cross+Docker 不够，装不上 libasound2-dev 照样在 alsa-sys 阶段炸。
cross_config_covers_target() {
  local triple="${1}"
  [ -f "${CROSS_CONFIG_FILE}" ] || return 1
  grep -q "^\[target\.${triple}\]" "${CROSS_CONFIG_FILE}" 2>/dev/null
}

# 本机（原生 Linux 宿主，不走 cross）是否已经装了 ALSA 开发头文件。
# 没有 pkg-config 时保守判否——不能确认就不报 READY。
host_has_alsa_dev() {
  command -v pkg-config >/dev/null 2>&1 && pkg-config --exists alsa 2>/dev/null
}

# crate 目录下"实际生效"的 rustc 版本——如果
# packages/audio-capture-napi/native/rust-toolchain.toml 存在，rustup 会在
# 那个目录下自动切到它钉的版本，跟宿主默认 rustc 可能不是同一个版本。
# --check 报的必须是这个，不是宿主默认：本机默认 1.82.0 构建不出这个 crate
# （coreaudio-sys 要 edition2024，需要 Rust >= 1.85），但 crate 目录下会被
# rust-toolchain.toml 自动切到 1.85.0，构建其实是通的——两者不是同一个数字。
crate_has_toolchain_pin() {
  [ -f "${NATIVE_DIR}/rust-toolchain.toml" ] || [ -f "${NATIVE_DIR}/rust-toolchain" ]
}

crate_effective_rustc_version() {
  if [ -d "${NATIVE_DIR}" ] && command -v rustc >/dev/null 2>&1; then
    ( cd "${NATIVE_DIR}" && rustc --version ) 2>/dev/null
  fi
}

# ---------------------------------------------------------------------------
# 就绪度判定。**不要**通过 `status="$(check_triple_readiness ...)"` 调用——
# 命令替换会 fork 子 shell，函数内对全局变量的赋值不会带回父 shell（本脚本
# 开发时实测踩过：READY_REASON 曾经就是这么被吞掉的，--check 的说明列全空）。
# 正确用法：直接调用 `check_triple_readiness "${triple}"`，再读两个全局：
#   READY_STATUS  状态码之一：
#                   READY        本机可以直接构建
#                   NEEDS_TARGET 缺 rustup target，装上就能构建
#                   NEEDS_ALSA   （仅原生 Linux 宿主）缺 libasound2-dev
#                   NEEDS_CROSS  需要 cross + Docker
#                   NEEDS_ALSA_CONFIG cross/Docker 都齐了，但 ALSA 的
#                                pre-build 配置缺失或没覆盖该 target
#                   NEEDS_REMOTE 本机没有可行路径，需要目标平台机器或 CI
#   READY_REASON  人类可读的理由 / 下一步命令
#
# 注意：READY 只代表「工具链能不能跑起构建命令」，不代表这次依赖解析一定
# 会成功——首次构建（没有 Cargo.lock）时依赖会被解析到最新兼容版本，可能
# 拉到要求更新 Rust 工具链的传递依赖。已实测的例子见 --check 输出与
# docs/dev/audio-capture-native.md §3.1（coreaudio-sys 最新版要求 Cargo 的
# edition2024 feature，需要 Rust >= 1.85）。
# ---------------------------------------------------------------------------

READY_STATUS=""
READY_REASON=""

check_triple_readiness() {
  local triple="${1}"
  local host_os family
  host_os="$(detect_host_os)"
  family="$(triple_family "${triple}")"

  case "${family}" in
    darwin)
      if [ "${host_os}" = "darwin" ]; then
        if is_target_installed "${triple}"; then
          READY_STATUS="READY"
          READY_REASON="就绪：\`cd ${NATIVE_DIR} && cargo build --release --target ${triple}\`（cd 不能省：rust-toolchain.toml 与 .cargo/config.toml 都按当前工作目录查找，--manifest-path 替代不了）"
        else
          READY_STATUS="NEEDS_TARGET"
          READY_REASON="缺 rustup target：先运行 \`rustup target add ${triple}\`。macOS 自带的 clang/ld 原生支持 arm64/x86_64 两个 darwin 架构互相交叉编译，装完 target 无需额外工具链即可直接构建。"
        fi
      else
        READY_STATUS="NEEDS_REMOTE"
        READY_REASON="本机不是 macOS，交叉编译到 Apple 平台一般需要 osxcross（本脚本不处理）。请改到 macOS 机器或 CI（如 GitHub Actions macos-latest）上运行本脚本，或手动构建：\`cd ${NATIVE_DIR} && cargo build --release --target ${triple}\`（cd 不能省，--manifest-path 替代不了：rust-toolchain.toml 与 .cargo/config.toml 都按当前工作目录查找）。"
      fi
      ;;
    linux)
      if [ "${host_os}" = "linux" ]; then
        if ! is_target_installed "${triple}"; then
          READY_STATUS="NEEDS_TARGET"
          READY_REASON="缺 rustup target：先运行 \`rustup target add ${triple}\`；若目标架构与本机不同，还需要一套交叉链接器（例如 Debian/Ubuntu 上的 gcc-aarch64-linux-gnu / gcc-x86-64-linux-gnu），或改用下面的 cross 路径。"
        elif ! host_has_alsa_dev; then
          READY_STATUS="NEEDS_ALSA"
          READY_REASON="rustup target 已装，但本机没有 ALSA 开发头文件（pkg-config 找不到 alsa.pc）：cpal 在 Linux 上经 alsa-sys 链接系统 ALSA，装了才能过 build script。Debian/Ubuntu 上 \`sudo apt-get install libasound2-dev\`，Fedora 上 \`sudo dnf install alsa-lib-devel\`。"
        else
          READY_STATUS="READY"
          READY_REASON="就绪：\`cd ${NATIVE_DIR} && cargo build --release --target ${triple}\`（cd 不能省：rust-toolchain.toml 与 .cargo/config.toml 都按当前工作目录查找。同宿主 OS，跨架构部分视本机是否装有对应交叉链接器而定；若链接失败，退回下面的 cross 路径）"
        fi
      else
        if ! has_cross; then
          READY_STATUS="NEEDS_CROSS"
          READY_REASON="需要 cross：先 \`cargo install cross --git https://github.com/cross-rs/cross\`，并确保 Docker 守护进程在跑（docker info 能成功）。装好后用 \`cd ${NATIVE_DIR} && CROSS_CONFIG=${CROSS_CONFIG_FILE} cross build --release --target ${triple}\`。另一条路：改到 Linux 机器或 CI（如 GitHub Actions ubuntu-latest）上直接用 cargo 构建。"
        elif ! docker_running; then
          READY_STATUS="NEEDS_CROSS"
          READY_REASON="cross 已安装，但 Docker 守护进程没有在跑（docker info 失败）：先启动 Docker，再用 \`cd ${NATIVE_DIR} && CROSS_CONFIG=${CROSS_CONFIG_FILE} cross build --release --target ${triple}\`。另一条路：改到 Linux 机器或 CI（如 GitHub Actions ubuntu-latest）上直接用 cargo 构建。"
        elif ! cross_config_covers_target "${triple}"; then
          READY_STATUS="NEEDS_ALSA_CONFIG"
          READY_REASON="cross 与 Docker 都就绪，但 ${CROSS_CONFIG_FILE} 里缺 [target.${triple}] 的 pre-build 段落——cross 官方镜像不带 libasound2-dev，cpal 在 Linux 上经 alsa-sys 需要它，缺了会在 alsa-sys 的 build script 阶段报「The system library \`alsa\` required by crate \`alsa-sys\` was not found.」（已实测复现）。补上该 target 的 pre-build 配置，或改到 Linux 机器/CI 上进到 ${NATIVE_DIR} 直接 cargo build（那边通常已装 ALSA）。"
        else
          READY_STATUS="READY"
          READY_REASON="就绪：\`cd ${NATIVE_DIR} && CROSS_CONFIG=${CROSS_CONFIG_FILE} cross build --release --target ${triple}\`（cross 会在 Docker 容器里完成交叉编译，pre-build 阶段装好 libasound2-dev，不需要本机装 rustup target）"
        fi
      fi
      ;;
    windows)
      if [ "${host_os}" = "windows" ]; then
        if is_target_installed "${triple}"; then
          READY_STATUS="READY"
          READY_REASON="就绪：\`cd ${NATIVE_DIR} && cargo build --release --target ${triple}\`——「cd」是必须的，不能换成 --manifest-path：+crt-static 写在 ${NATIVE_DIR}/.cargo/config.toml 里，而 cargo 只按当前工作目录向上找这个文件，漏掉就会产出依赖 vcruntime140.dll 的 .node，目标机缺该 DLL 时语音功能静默消失"
        else
          READY_STATUS="NEEDS_TARGET"
          READY_REASON="缺 rustup target：先运行 \`rustup target add ${triple}\`，并确认已装 Visual Studio Build Tools（link.exe + Windows SDK）。"
        fi
      else
        READY_STATUS="NEEDS_REMOTE"
        READY_REASON="windows-msvc 需要真实的 MSVC 工具链（link.exe + Windows SDK）。cross 的官方镜像面向 *-gnu，通常不含 MSVC 授权文件，走 cross 大概率跑不通。可行路径：在 Windows 机器或 CI（如 GitHub Actions windows-latest）上运行 \`cd ${NATIVE_DIR} && cargo build --release --target ${triple}\`——「cd」是必须的，不能换成 --manifest-path：+crt-static 写在 ${NATIVE_DIR}/.cargo/config.toml 里，而 cargo 只按当前工作目录向上找这个文件，漏掉就会产出依赖 vcruntime140.dll 的 .node，目标机缺该 DLL 时语音功能静默消失。"
      fi
      ;;
  esac
}

# ---------------------------------------------------------------------------
# --check 模式
# ---------------------------------------------------------------------------

run_check() {
  echo "宿主环境：$(detect_host_os) / $(uname -m)"
  if command -v rustc >/dev/null 2>&1; then
    echo "宿主默认 rustc：$(rustc --version)"
  else
    echo "宿主默认 rustc：未安装"
  fi
  if crate_has_toolchain_pin; then
    local crate_rustc
    crate_rustc="$(crate_effective_rustc_version)"
    if [ -n "${crate_rustc}" ]; then
      echo "crate 生效工具链：${crate_rustc}（由 packages/audio-capture-napi/native/rust-toolchain.toml 钉定，与宿主默认可能不同）"
    else
      echo "crate 生效工具链：无法探测（未装 rustc，或 native/ 目录不存在）"
    fi
  else
    echo "crate 未钉定工具链（没有 rust-toolchain.toml/rust-toolchain）——用的就是宿主默认版本，见下方 Cargo.lock 相关警告。"
  fi
  if [ -f "${CROSS_CONFIG_FILE}" ]; then
    echo "cross ALSA 配置：${CROSS_CONFIG_FILE}（存在）"
  else
    echo "cross ALSA 配置：${CROSS_CONFIG_FILE}（不存在——两个 Linux triple 会报 NEEDS_ALSA_CONFIG）"
  fi
  echo ""
  echo "native crate: ${MANIFEST}"
  if crate_present; then
    echo "  存在。"
    if [ -f "${NATIVE_DIR}/Cargo.lock" ]; then
      echo "  Cargo.lock 存在——依赖版本已锁定，下面的 READY 相对可信。"
    else
      echo "  警告：Cargo.lock 不存在。下面任何一个 triple 的第一次构建都会把依赖"
      echo "  全新解析到「当前兼容范围内的最新版本」，可能因此拉到要求更新 Rust"
      echo "  工具链的传递依赖——已实测的例子：coreaudio-sys 的最新兼容版本要求"
      echo "  Cargo 的 edition2024 feature（需要 Rust >= 1.85），本机 rustc 版本较旧时"
      echo "  会在解析/下载阶段直接失败。下面标 READY 只代表 rustup target 已装、"
      echo "  构建命令能跑起来，不代表这次依赖解析一定能通过。"
    fi
  else
    echo "  缺失。packages/audio-capture-napi/native/ 是入库的 Rust crate，正常检出里一定有；"
    echo "  跑到这里通常意味着检出不完整或该目录被误删。恢复：在仓库根执行"
    echo "  \`git checkout -- packages/audio-capture-napi/native\`，或重新 clone 本仓库。"
    echo "  下面的就绪度只反映工具链本身，crate 恢复前无法实际构建 / --install。"
  fi
  echo ""
  printf '%-30s %-14s %-13s %s\n' "TRIPLE" "VENDOR 目录" "状态" "说明"
  printf '%-30s %-14s %-13s %s\n' "------" "----------" "----" "----"

  local triple platform_dir
  for triple in ${ALL_TRIPLES}; do
    platform_dir="$(triple_platform_dir "${triple}")"
    check_triple_readiness "${triple}"
    printf '%-30s %-14s %-13s %s\n' "${triple}" "${platform_dir}" "${READY_STATUS}" "${READY_REASON}"
  done
  return 0
}

# ---------------------------------------------------------------------------
# 产物校验闸门：写进 vendor/ 之前必须过这一关。
#
# 把产物复制到一个临时的 .node 文件（require() 靠后缀认原生模块），用 bun
# 加载，核对 REQUIRED_EXPORTS 八个导出全部是函数，再调用
# microphoneAuthorizationStatus() 断言返回值落在 0..3。全程不改 vendor/，
# 探针文件用完即删。只有本机能原生加载该 triple 的产物才应该调用本函数
# （调用前请先用 can_run_natively 判断）。
# ---------------------------------------------------------------------------

verify_artifact() {
  local built_path="${1}"

  if ! command -v bun >/dev/null 2>&1; then
    echo "  校验失败：本机没有 bun，无法加载产物做导出面检查。" >&2
    return 1
  fi

  local probe_dir tmp_node tmp_script
  # 显式捕获——verify_artifact 同样是从被抑制 set -e 的上下文里调用的，
  # mktemp/cp 失败不查退出码会把探针搭在一个不存在的目录上，之后的错误
  # 信息会指向"bun 找不到文件"而不是真因。
  probe_dir="$(mktemp -d)" || {
    echo "  校验失败：mktemp -d 失败，无法创建临时目录。" >&2
    return 1
  }
  tmp_node="${probe_dir}/probe-audio-capture.node"
  tmp_script="${probe_dir}/probe.cjs"
  if ! cp "${built_path}" "${tmp_node}"; then
    echo "  校验失败：cp ${built_path} 到临时目录失败。" >&2
    rm -rf "${probe_dir}"
    return 1
  fi

  cat > "${tmp_script}" <<'PROBE_EOF'
const path = process.argv[2]
const REQUIRED = [
  'startRecording',
  'stopRecording',
  'isRecording',
  'startPlayback',
  'writePlaybackData',
  'stopPlayback',
  'isPlaying',
  'microphoneAuthorizationStatus',
]

let mod
try {
  mod = require(path)
} catch (err) {
  console.error(`LOAD_FAILED: ${err && err.message ? err.message : String(err)}`)
  process.exit(1)
}

const missing = REQUIRED.filter((name) => typeof mod[name] !== 'function')
if (missing.length > 0) {
  console.error(`MISSING_EXPORTS: ${missing.join(', ')}`)
  process.exit(1)
}

let status
try {
  status = mod.microphoneAuthorizationStatus()
} catch (err) {
  console.error(`MIC_STATUS_THREW: ${err && err.message ? err.message : String(err)}`)
  process.exit(1)
}

if (!(Number.isInteger(status) && status >= 0 && status <= 3)) {
  console.error(`MIC_STATUS_OUT_OF_RANGE: ${String(status)}`)
  process.exit(1)
}

console.log(`OK exports=8/8 microphoneAuthorizationStatus=${String(status)}`)
process.exit(0)
PROBE_EOF

  local probe_output probe_exit
  probe_exit=0
  probe_output="$(bun "${tmp_script}" "${tmp_node}" 2>&1)" || probe_exit=1

  rm -rf "${probe_dir}"

  if [ "${probe_exit}" -eq 0 ]; then
    echo "  校验通过：${probe_output}"
    return 0
  else
    echo "  校验失败：${probe_output}" >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# 构建 + 安装
# ---------------------------------------------------------------------------

build_one_triple() {
  local triple="${1}"
  local do_install="${2}"
  local allow_unverified="${3}"
  check_triple_readiness "${triple}"

  echo "=== ${triple} ==="

  if [ "${READY_STATUS}" != "READY" ]; then
    echo "  跳过（不就绪）：${READY_REASON}" >&2
    return 1
  fi

  local family host_os
  family="$(triple_family "${triple}")"
  host_os="$(detect_host_os)"

  local artifact
  artifact="$(triple_artifact_name "${triple}")"
  local built_path="${NATIVE_DIR}/target/${triple}/release/${artifact}"

  # 显式捕获退出码、不要依赖 set -e：build_one_triple 是被
  # `if ! build_one_triple ...; then` 这种条件上下文调用的，POSIX 语义下
  # errexit 在条件上下文里对整个被调函数体都不生效，构建命令失败不会自动
  # 中断执行——曾经真的踩过：cross build 因为缺 ALSA 失败后，脚本没有中断，
  # 直接落到了下面「产物不存在」的分支，打出一条完全指错方向的诊断（把读者
  # 指向 CARGO_TARGET_DIR，而真因是 alsa-sys 编译失败，几行前的报错才是真相）。
  local build_rc=0
  if [ "${family}" = "linux" ] && [ "${host_os}" != "linux" ]; then
    echo "  cd ${NATIVE_DIR} && CROSS_CONFIG=${CROSS_CONFIG_FILE} cross build --release --target ${triple}"
    ( cd "${NATIVE_DIR}" && CROSS_CONFIG="${CROSS_CONFIG_FILE}" cross build --release --target "${triple}" ) || build_rc="${?}"
  else
    echo "  cd ${NATIVE_DIR} && cargo build --release --target ${triple}"
    ( cd "${NATIVE_DIR}" && cargo build --release --target "${triple}" ) || build_rc="${?}"
  fi

  if [ "${build_rc}" -ne 0 ]; then
    echo "  构建失败（退出码 ${build_rc}），见上方 cargo/cross 的输出——真因在那几行里，不在下面。" >&2
    return 1
  fi

  # 只有构建命令真的成功退出，才轮到「产物不在预期位置」这条推测性诊断。
  if [ ! -f "${built_path}" ]; then
    echo "  构建命令退出成功，但没有在预期位置找到产物：${built_path}" >&2
    echo "  （如果 Cargo.toml 自定义了 target-dir 或 CARGO_TARGET_DIR 被覆盖，这里的默认路径假设就不成立，需要手动核对）" >&2
    return 1
  fi
  echo "  产物：${built_path}"

  if [ "${do_install}" = "1" ]; then
    local platform_dir dest_dir dest_path
    platform_dir="$(triple_platform_dir "${triple}")"
    dest_dir="${VENDOR_ROOT}/${platform_dir}"
    dest_path="${dest_dir}/audio-capture.node"

    if can_run_natively "${triple}"; then
      echo "  校验产物（本机可原生加载该 triple）..."
      if ! verify_artifact "${built_path}"; then
        echo "  拒绝安装：产物未通过校验，见上方错误。未写入 ${dest_path}。" >&2
        return 1
      fi
    else
      if [ "${allow_unverified}" != "1" ]; then
        echo "  拒绝安装：${triple} 的产物在本机（${host_os}/$(uname -m)）无法原生加载，跳过了校验闸门。" >&2
        echo "  确认要在未验证的情况下安装，重新加 --allow-unverified-install；装上之后请务必到目标平台上手动核实一遍。" >&2
        return 1
      fi
      echo "  警告：跳过校验闸门——${triple} 的产物无法在本机原生加载，--allow-unverified-install 已放行。" >&2
      echo "  这份 audio-capture.node 还没有在任何机器上验证过八个导出与麦克风授权状态，装进 vendor/ 之后请到目标平台核实。" >&2
    fi

    # 同理显式捕获——这两条也在被 set -e 抑制的函数体里，cp/mkdir 失败
    # 不会自动中断，不查退出码就会打出「已装入」这种假成功。
    if ! mkdir -p "${dest_dir}"; then
      echo "  安装失败：mkdir -p ${dest_dir} 出错。" >&2
      return 1
    fi
    if ! cp "${built_path}" "${dest_path}"; then
      echo "  安装失败：cp 到 ${dest_path} 出错。" >&2
      return 1
    fi
    echo "  已装入：${dest_path}"
    echo "  如需回退：git checkout -- vendor/audio-capture/${platform_dir}/audio-capture.node"
  fi

  return 0
}

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------

DO_ALL=0
DO_INSTALL=0
DO_CHECK=0
ALLOW_UNVERIFIED_INSTALL=0
TARGETS=()

while [ "${#}" -gt 0 ]; do
  case "${1}" in
    --target)
      if [ "${#}" -lt 2 ]; then
        echo "错误：--target 需要一个 triple 参数" >&2
        exit 1
      fi
      TARGETS+=("${2}")
      shift 2
      ;;
    --target=*)
      TARGETS+=("${1#--target=}")
      shift
      ;;
    --all)
      DO_ALL=1
      shift
      ;;
    --install)
      DO_INSTALL=1
      shift
      ;;
    --allow-unverified-install)
      ALLOW_UNVERIFIED_INSTALL=1
      shift
      ;;
    --check)
      DO_CHECK=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "错误：未知参数 ${1}" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "${DO_CHECK}" = "1" ]; then
  run_check
  exit 0
fi

if [ "${DO_ALL}" = "1" ]; then
  TARGETS=()
  for t in ${ALL_TRIPLES}; do
    TARGETS+=("${t}")
  done
fi

if [ "${#TARGETS[@]}" -eq 0 ]; then
  host_triple="$(detect_host_triple)"
  TARGETS=("${host_triple}")
  echo "未指定 --target / --all，按当前平台推导：${host_triple}"
fi

for triple in "${TARGETS[@]}"; do
  if ! is_known_triple "${triple}"; then
    echo "错误：不认识的 triple「${triple}」。受支持的六个：${ALL_TRIPLES}" >&2
    exit 1
  fi
done

if ! crate_present; then
  echo "错误：native crate 不存在（${MANIFEST}）。" >&2
  echo "packages/audio-capture-napi/native/ 是入库的 Rust crate，正常检出里一定有；缺失通常" >&2
  echo "意味着检出不完整或该目录被误删。恢复：在仓库根执行" >&2
  echo "  git checkout -- packages/audio-capture-napi/native" >&2
  echo "或重新 clone 本仓库。" >&2
  echo "可以先跑 scripts/build-audio-capture.sh --check 看工具链本身是否就绪。" >&2
  exit 1
fi

FAILED=()
for triple in "${TARGETS[@]}"; do
  if ! build_one_triple "${triple}" "${DO_INSTALL}" "${ALLOW_UNVERIFIED_INSTALL}"; then
    FAILED+=("${triple}")
  fi
done

echo ""
if [ "${#FAILED[@]}" -eq 0 ]; then
  echo "全部完成：${TARGETS[*]}"
  exit 0
else
  echo "以下 triple 未能构建/安装，详见上方各自的说明：${FAILED[*]}" >&2
  exit 1
fi
