<!-- Copyright 2026 Qianmo AgentNest Team -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# audio-capture 原生模块 —— 源码、契约与构建

## 0. 这是什么，为什么仓库里必须有它的源码

`vendor/audio-capture/<arch>-<platform>/audio-capture.node` 是六个预编译的
N-API 原生模块（macOS/Linux/Windows × arm64/x64），随构建产物一并分发，供
`src/services/voice.ts` 的语音录制/播放能力调用。它们是基座快照导入时就带着的
二进制，**上游仓库本身也只有这六个 `.node`，没有源码、构建脚本或 LICENSE**
（2026-08-15 核实，见 `NOTICE`「五、第三方组件」与 `docs/dev/license-chain-m0.md`
D-4 的上游溯源核查表）。

本仓库 2026-08-29 转为 **AGPL-3.0-or-later**（双许可，见根 `NOTICE`「一、许可」）。
在 MIT 下，「许可待确认」是一个可以挂着的状态；**在 AGPL 下挂不住**——copyleft
要求向用户提供 Corresponding Source。转制时，这六个二进制随 `dist/vendor/` 分发、
源码却不在任何人手上；这正是 `docs/dev/license-chain-m0.md` **D-9**
（「`vendor/audio-capture/` 在 copyleft 下不能再"待确认"」）记录的问题。

本文档描述的 `packages/audio-capture-napi/native/`（Rust crate，package name
`audio-capture`）就是补齐的源码，本文档与 `scripts/build-audio-capture.sh`
是配套的构建说明。六个二进制现已全部换绑为由该源码构建的产物并完成 AGPL
标注，D-9 已收口；`arm64-win32` 仍缺真实 Windows on ARM 运行时加载证据，
详见 §3.1。

## 1. 装载层怎么找到它、以及它对外的契约

TypeScript 侧的装载/降级逻辑在 `packages/audio-capture-napi/src/index.ts`：
它按 `${process.arch}-${process.platform}` 拼出目录名（`arm64-darwin` /
`x64-darwin` / `arm64-linux` / `x64-linux` / `arm64-win32` / `x64-win32`），
在 `vendor/audio-capture/<那个目录>/audio-capture.node` 找二进制，`require`
失败（含文件不存在）时**全部导出函数优雅降级**——`isNativeAudioAvailable()`
返回 `false`，其余函数变成安全的空操作或默认值，调用方不需要另外判空。

原生模块必须实现的类型契约（抄自 `packages/audio-capture-napi/src/index.ts`
第 31-45 行的 `AudioCaptureNapi`），一共八个函数：

```ts
type AudioCaptureNapi = {
  startRecording(onData: (data: Buffer) => void, onEnd: () => void): boolean
  stopRecording(): void
  isRecording(): boolean
  startPlayback(sampleRate: number, channels: number): boolean
  writePlaybackData(data: Buffer): void
  stopPlayback(): void
  isPlaying(): boolean
  microphoneAuthorizationStatus?(): number
}
```

| 函数 | 契约 |
| --- | --- |
| `startRecording(onData, onEnd)` | 开始录音；每采集到一段数据回调 `onData(buffer)`；录音因故结束（设备拔出、权限被收回等）时回调一次 `onEnd()`；返回 `true` 表示成功启动。 |
| `stopRecording()` | 停止录音，释放采集设备。 |
| `isRecording()` | 当前是否正在录音。 |
| `startPlayback(sampleRate, channels)` | 按给定采样率/声道数打开播放流，返回 `true` 表示成功。 |
| `writePlaybackData(data)` | 向正在播放的流写入一段 PCM 数据。 |
| `stopPlayback()` | 停止播放，释放播放设备。 |
| `isPlaying()` | 当前是否正在播放。 |
| `microphoneAuthorizationStatus()` | **可选导出**（`index.ts` 用 `mod.microphoneAuthorizationStatus?.()`，缺失时降级返回 `0`）。返回麦克风授权状态：`0`=notDetermined，`1`=restricted，`2`=denied，`3`=authorized。macOS 返回真实 TCC 状态；Linux 没有系统级麦克风权限 API，**恒返回 `3`**；Windows 读注册表，键不存在或允许时返回 `3`，明确拒绝时返回 `2`。 |

## 2. 录音格式

固定为 **16000 Hz / 16-bit signed little-endian / 单声道（mono）**。证据：

- `src/services/voice.ts:40-41`：
  ```ts
  const RECORDING_SAMPLE_RATE = 16000
  const RECORDING_CHANNELS = 1
  ```
  这两个常量驱动的调用点会把采样率/声道数作为字符串参数传给外部录音管线
  （SoX 路径），三处用法在该文件的第 83/85、417/423、479/481 行。
- `src/hooks/useVoice.ts:968` 的注释直接把格式写进了变量名旁边：
  ```ts
  const SLICE_TARGET_BYTES = 32_000 // ~1s at 16kHz/16-bit/mono
  ```
  32000 字节 ≈ 1 秒——反推正是 16000 采样/秒 × 2 字节/采样 × 1 声道。
- `src/hooks/useVoice.ts:208-219` 的 `computeLevel()` 按 16-bit signed
  little-endian 解码每个采样（`samples = chunk.length >> 1` 即「每采样 2
  字节」，第 209 行；`(chunk[i] | (chunk[i+1] << 8)) << 16 >> 16` 做符号扩展的
  小端解码，第 214 行），用于波形电平可视化——这段代码在解释「native 模块吐出来
  的 buffer 应该按什么格式解码」这件事上，是比注释更硬的证据。

`startRecording` 的 `onData` 回调吐出的 `Buffer` 必须是这个格式；`startPlayback`
接受任意 `sampleRate`/`channels`（调用方决定，不固定为 16kHz/mono）。

## 3. 源码位置与构建

源码：`packages/audio-capture-napi/native/`（Rust crate，`Cargo.toml` 里
`name = "audio-capture"`、`edition = "2021"`、`[lib] crate-type = ["cdylib"]`）。
构建产物文件名按平台而不同：

| 平台 | 构建产物文件名 |
| --- | --- |
| macOS (darwin) | `libaudio_capture.dylib` |
| Linux | `libaudio_capture.so` |
| Windows (win32) | `audio_capture.dll` |

六个 vendor 目标目录与 Rust target triple 的映射：

| `vendor/audio-capture/<dir>/` | Rust target triple |
| --- | --- |
| `arm64-darwin` | `aarch64-apple-darwin` |
| `x64-darwin` | `x86_64-apple-darwin` |
| `arm64-linux` | `aarch64-unknown-linux-gnu` |
| `x64-linux` | `x86_64-unknown-linux-gnu` |
| `arm64-win32` | `aarch64-pc-windows-msvc` |
| `x64-win32` | `x86_64-pc-windows-msvc` |

用 `scripts/build-audio-capture.sh` 构建（用法见脚本内 `--help`，或直接读脚本头部
注释）。它是一个**带外的开发者工具**（见下一节），不产生任何自动化副作用：不带
`--install` 时只在 `packages/audio-capture-napi/native/target/<triple>/release/`
下产出文件，带 `--install` 才会复制进 `vendor/audio-capture/`。

```
scripts/build-audio-capture.sh                              # 构建当前平台
scripts/build-audio-capture.sh --target <triple>             # 构建指定 triple（可重复）
scripts/build-audio-capture.sh --all                         # 构建全部六个 triple
scripts/build-audio-capture.sh --install                     # 构建完把产物装进 vendor/（过校验闸门）
scripts/build-audio-capture.sh --allow-unverified-install     # 配合 --install，放行本机验证不了的产物
scripts/build-audio-capture.sh --check                       # 只检查就绪度，不构建
```

**`--install` 不是无条件 `cp`，中间有一道校验闸门（`verify_artifact`）**：装进
`vendor/` 之前，脚本把产物复制到一份临时文件、用 `bun` 加载、核对 §1 表格里
的八个导出函数齐全，并断言 `microphoneAuthorizationStatus()` 返回值落在
`0..3`。任何一项不过，`--install` 就**拒绝安装、非零码退出、不碰 `vendor/`**。

这道闸门只能验证**本机能原生加载**的产物——构建 triple 与宿主 OS/架构一致
的那个（例如在 macOS arm64 上构建的 `aarch64-apple-darwin`）。跨平台/跨架构
交叉构建出来的产物（例如在 macOS 上用 `cross` 构建的 Linux 产物）本机加载
不了，不是产物坏了，是宿主运行不了那种二进制——这种情况 `--install` 默认
同样拒绝安装；确认要装，必须显式加 `--allow-unverified-install`，脚本会在
stderr 打一行醒目警告，提示这份 `.node` 还没有在任何机器上验证过，需要到
目标平台自己核实一遍。

为什么要这道闸门：`packages/audio-capture-napi/src/index.ts` 的
`loadModule()` 把 `require()` 的异常整个吞掉（逐个候选路径 `catch {}` 试下
一个，全部失败才 `return null`），上层 `isNativeAudioAvailable()` 只回
`false`。所以装进去一个加载不了的 `.node`，表现不是报错，是语音功能**静默
消失**，且没有任何诊断信息指向是这次 install 弄坏的（虽然 `vendor/*.node`
都被 git 跟踪、可以 `git checkout --` 恢复，但这要人先意识到问题出在这次
install）。安装成功后脚本会打印一行回退指引：
`如需回退：git checkout -- vendor/audio-capture/<dir>/audio-capture.node`。

### 3.1 六条 triple 逐条：构建与验证现状

以下是**实测结论**，不是从文档推断；两批产物的时间与来源不同，分开记：
darwin/Linux 四个 triple 是 2026-08-29 在本机真跑
`scripts/build-audio-capture.sh`（当时 Docker 已用 colima 起来、`native/` 已带
`rust-toolchain.toml` 钉 Rust 1.85.0），Windows 两个 triple 是 2026-08-30 由
GitHub Actions 的 `windows-latest` 工作流构建：

- **`aarch64-apple-darwin` / `x86_64-apple-darwin`**：`--check` 均报
  `READY`。此前一轮实测卡在 `coreaudio-sys` 要求 Cargo 的 `edition2024`
  feature（需要 Rust ≥ 1.85）、而宿主默认 `cargo 1.82.0` 不支持——这个坑
  现在由 `packages/audio-capture-napi/native/rust-toolchain.toml`
  （`channel = "1.85.0"`）钉死解决：脚本的 `build_one_triple` 始终先
  `cd "${NATIVE_DIR}"` 再跑 `cargo build`，rustup 的 toolchain-file 解析靠
  cwd 向上找，cwd 落在 `native/` 里就能找到这份钉版本文件，自动换到
  1.85.0，不需要本机默认 toolchain 也是 1.85。两个 darwin 产物均已在目标架构上
  真加载验证（见 §5 的验证清单）。
- **`aarch64-unknown-linux-gnu` / `x86_64-unknown-linux-gnu`**：**两个都已
  实测真跑通**，产物结构校验通过。本机是 macOS，走的是 `cross`
  （`cross 0.2.5` + Docker/colima）。这条路有一个必须踩过才知道的坑：
  **cpal 在 Linux 上必然经 `alsa-sys` 链接系统 ALSA**（`libasound.so` +
  `alsa.pc`），而 `cross` 官方 `x86_64-unknown-linux-gnu` /
  `aarch64-unknown-linux-gnu` 镜像**不带** `libasound2-dev`，第一次真跑会在
  `alsa-sys` 的 build script 阶段报：
  ```
  The system library `alsa` required by crate `alsa-sys` was not found.
  The file `alsa.pc` needs to be installed and the PKG_CONFIG_PATH environment
  variable must contain its parent directory.
  ```
  修法是 `scripts/audio-capture-cross.toml`（细节见 §3.3），脚本会在调用
  `cross build` 前自动 `export CROSS_CONFIG=<该文件路径>`，不需要手动设置。
  修好之后两个 triple 的真实构建输出（节选，`CROSS_CONFIG` 已生效、
  pre-build 装好 `libasound2-dev` 后进入正常编译）：
  ```
  #5 [2/2] RUN eval "dpkg --add-architecture $CROSS_DEB_ARCH
  apt-get update && apt-get install --assume-yes libasound2-dev:$CROSS_DEB_ARCH"
  ...
  Setting up libasound2-dev:amd64 (1.2.2-2.1ubuntu2.5) ...
     Compiling alsa-sys v0.3.1
     Compiling cpal v0.15.3
     Compiling audio-capture v0.1.0 (.../native)
     Compiling alsa v0.9.1
      Finished `release` profile [optimized] target(s) in 18.59s
  ```
  产物结构校验（本机是 macOS，加载不了 Linux `.so`，只能验结构，不能像
  §5 那样真的 `require()` 它）：
  ```
  $ file target/x86_64-unknown-linux-gnu/release/libaudio_capture.so
  ELF 64-bit LSB shared object, x86-64, version 1 (SYSV), dynamically linked, ...

  $ nm -D target/x86_64-unknown-linux-gnu/release/libaudio_capture.so | grep napi_register_module_v1
  0000000000040640 T napi_register_module_v1

  $ file target/aarch64-unknown-linux-gnu/release/libaudio_capture.so
  ELF 64-bit LSB shared object, ARM aarch64, version 1 (SYSV), dynamically linked, ...

  $ nm -D target/aarch64-unknown-linux-gnu/release/libaudio_capture.so | grep napi_register_module_v1
  000000000003a5e0 T napi_register_module_v1
  ```
  两个架构都对、`napi_register_module_v1` 都在——N-API 模块的入口符号存在，
  说明 napi-rs 的宏正确生成了模块注册代码，是结构层面能过的最强信号；本轮
  四个 darwin/Linux 产物已另在目标架构上完成真加载验证。
- **`aarch64-pc-windows-msvc` / `x86_64-pc-windows-msvc`**：在本机 `--check`
  仍报 `NEEDS_REMOTE`，因为这两个 triple 需要真实的 MSVC 工具链（`link.exe` +
  Windows SDK），`cross` 的官方镜像面向 `*-gnu` target、不带 MSVC 授权文件，
  在非 Windows 宿主上走 `cross` 大概率跑不通。实际构建已由仅
  `workflow_dispatch` 的 GitHub Actions `windows-latest` 工作流完成：
  `x86_64-pc-windows-msvc` 已在同一 runner 上用 Node `require()` 验证，八个导出
  均为函数且 `microphoneAuthorizationStatus()` 返回 `3`；
  `aarch64-pc-windows-msvc` 的 `cargo build --release`、`cargo clippy --release
  -- -D warnings` 和结构性核对均已通过，但 x86_64 runner 无法加载或执行
  aarch64 DLL，工作流已显式跳过运行时验证，仍需真实 Windows on ARM 机器补做。
  Windows 产物的静态 CRT 判据见 §3.2。

一句话总结：**六个 triple 的产物现在都已由该源码构建并换入 `vendor/`；其中
四个 darwin/Linux 和 `x86_64-pc-windows-msvc` 有运行时加载证据，
`aarch64-pc-windows-msvc` 已通过构建、Clippy 和结构性核对但尚无运行时证据，
仍需 Windows on ARM 验证。**`--check` 在这台 macOS 开发机上对 Windows 仍报
`NEEDS_REMOTE`，这只表示当前宿主没有 MSVC 构建路径，不表示 Windows 产物尚未
构建。

`--check` 的表格前面会打印几行环境信息，其中 rustc 版本**分两行报**，不要
只看一行就下结论：

```
宿主默认 rustc：rustc 1.82.0 (f6e511eec 2024-10-15)
crate 生效工具链：rustc 1.85.0 (4d91de4e4 2025-02-17)（由 packages/audio-capture-napi/native/rust-toolchain.toml 钉定，与宿主默认可能不同）
```

**这两行不是同一个数字，且这是故意的、已实测的行为**：宿主默认
`1.82.0` 恰好就是构建不出这个 crate 的版本（`coreaudio-sys` 要
`edition2024`，需要 Rust ≥ 1.85）——如果 `--check` 只报这一行然后一整屏
`READY`，那就是在用"构建不出这个 crate 的版本号"给"这个 crate 能构建"的
结论背书，自相矛盾。第二行取的是**在 `packages/audio-capture-napi/native/`
目录下实际生效**的 rustc（`cd` 进那个目录后 `rustc --version`——rustup 的
toolchain-file 解析靠 cwd 向上找，这个目录里的 `rust-toolchain.toml` 会被
自动应用），这才是构建命令真正用的版本。**若 `rust-toolchain.toml`（或
无扩展名的 `rust-toolchain`）不存在**，第二行会退化成
「crate 未钉定工具链……用的就是宿主默认版本」，此时构建用的就是宿主默认，
两行说的是一回事（已实测：临时移走该文件重跑 `--check`，确认退化文案按预期
出现，验完已原样移回、校验和一致，不影响该文件真正的所有者）。

`--check` 还会打印 `scripts/audio-capture-cross.toml`（§3.3）是否存在、以及
`packages/audio-capture-napi/native/Cargo.lock` 是否存在。**Cargo.lock 不
存在时会显式警告**：依赖会在下一次构建时全新解析，可能拉到要求更新 Rust
版本的传递依赖（`edition2024` 就是实测过的例子），所以 `READY` 只代表
`rustup target`／`cross`＋`Cross` 配置都齐了、构建命令能跑起来，不代表这次
依赖解析一定能通过——不要看到一整行 `READY` 就当成"构建保证成功"。

### 3.2 Windows MSVC：静态链接 CRT

`x86_64-pc-windows-msvc` 和 `aarch64-pc-windows-msvc` 两个目标必须静态链接
MSVC CRT。默认的动态 CRT 会让产物依赖 `vcruntime140.dll`；这个 DLL 不随
Windows 系统提供，也不随 Node.js 安装程序分发。目标机缺少它时，
`require('audio-capture.node')` 会失败，而
`packages/audio-capture-napi/src/index.ts` 的 `loadModule()` 会吞掉该
`require` 错误并静默降级，故障表现是语音模式无声消失，而不是抛出报错。

配置位于 `packages/audio-capture-napi/native/.cargo/config.toml`，按 target
分别设置 `target-feature=+crt-static`。不能写成 `[build] rustflags = ...`：
`[build]` 的 rustflags 会作用到所有目标，可能波及已经构建并验证过的
macOS/Linux 产物；按 target 写只对这两个 Windows MSVC triple 生效。

**`RUSTFLAGS` 环境变量会把这份配置整条丢弃。**cargo 取 rustflags 的四个来源是
**互斥**的，按顺序检查、命中第一个就不再看后面的：`CARGO_ENCODED_RUSTFLAGS` >
`RUSTFLAGS` > `target.<triple>.rustflags` / `target.<cfg>.rustflags` >
`build.rustflags`。所以开发者 shell 里只要设了 `RUSTFLAGS`（哪怕内容与本文无关，例如 `-C target-cpu=native`），
`.cargo/config.toml` 里这两条 `target-feature=+crt-static` 就**整条不生效**，产物
静默退回动态 CRT、重新带上 `vcruntime140.dll`。工作流本身是干净的（
`.github/workflows/build-audio-capture-windows.yml` 没有 `env:` 块、没有
`RUSTFLAGS` / `CARGO_ENCODED_RUSTFLAGS`），但本机构建前值得自查一遍。

**别用 `echo $RUSTFLAGS` 自查。**`RUSTFLAGS=`（设了但内容为空）同样会命中上面那条
优先级、把 `target.<triple>.rustflags` 整条丢弃，而 `echo $RUSTFLAGS` 在「未设」与
「设为空」两种情况下都打印空行——恰好分不开这两者，后者会静默退回动态 CRT。要用能
区分的形式：

```
env | grep -E '^(CARGO_ENCODED_)?RUSTFLAGS='
```

未设时没有输出，设为空时打印 `RUSTFLAGS=`，两者可分；它同时覆盖优先级更高的
`CARGO_ENCODED_RUSTFLAGS`，读的也正是 cargo 会看到的那份环境（没 export 的 shell
变量 cargo 本来就取不到）。只用 shell 内建也行：`printf '%s\n' "${RUSTFLAGS+set}"`
未设时打印空行，设了（含设为空）时打印 `set`。

无论在哪构建，最终判据都是下面那条依赖面核对。

**静态链接 CRT 对一个被 Node `dlopen` 的 N-API 插件为什么是安全的**（写清楚是因为
下一个给这个 crate 加 C 依赖的人需要知道这里有前提）。`/MT` 最经典的翻车方式是
**跨 CRT 堆不匹配**：插件用自己那份 CRT 的 `malloc` 分配、宿主用另一份 CRT 的
`free` 释放（或反过来），两份 CRT 各有各的堆，行为未定义。这条在这里**结构上不
成立**：

- **Rust 在 Windows MSVC 上的 system allocator 不走 CRT 的 `malloc`**，走的是
  `HeapAlloc(GetProcessHeap(), …)`。**判据是 Rust std 源码**：
  `library/std/src/sys/alloc/windows.rs` 中 `unsafe impl GlobalAlloc for System`
  的 `alloc` / `alloc_zeroed` / `dealloc` / `realloc` 经 `windows_link::link!` 直接
  绑到 `kernel32.dll` 的 `GetProcessHeap` / `HeapAlloc` / `HeapFree` /
  `HeapReAlloc`，整条路径上不出现 CRT 的 `malloc`。
  **导入表只是与该结论一致的观察，证不了它**：新旧两个 Windows 产物确实都从
  `kernel32.dll` 导入那四个符号，但 `/MT` 下 CRT 是静态链进产物的，它自己的
  `malloc` 本来就不会出现在导入表里；而现代 UCRT 的 `malloc` 自身也是
  `HeapAlloc(GetProcessHeap(), …)`。于是「导入表里有这四个符号」与「Rust 用
  System allocator」「CRT 的 `malloc` 也在用同一个进程堆」两种假设都相容——它是
  必要条件，不是判据。
  进程堆是**进程级**的，不随 CRT 副本分裂，所以插件分配的内存换哪份 CRT 都能释放。
- **本 crate 不跨边界交换 CRT 对象**：cpal 与 `windows` crate 都是纯 FFI（WASAPI /
  COM），传的是句柄、COM 接口指针与由调用方分配的缓冲区，没有 `FILE*`、没有
  `malloc` 出来再交给对方 `free` 的指针。**反向同样不发生**：插件也不把别处（宿主
  或另一份 CRT）分配出来的指针交给自己这份静态 CRT 的 `free` / `realloc` 去释放。
  堆不匹配是对称的，两个方向都堵上才算数，只说一向不够。N-API 侧的内存由 Node
  自己的分配器管，插件只通过 napi 函数访问。

**残留风险，别当成"静态 CRT 一律安全"**：两份 CRT 各有各的 `errno`、各有各的 stdio
缓冲、各有各的 locale——只要不跨边界读写这些状态就没事，而现在确实不跨。**将来若
引入一个会返回 `malloc` 指针（或 `FILE*`）给调用方的 C 依赖，上面第二条前提就
失效了，而且是静默失效**：编译照过、加载照过，崩在释放的那一刻。到那时要么把该
依赖也静态链进同一份 CRT 并保证分配/释放在同一侧，要么放弃 `crt-static` 改为随产物
分发 VC++ 运行时。

**依赖面核对：读 PE 导入表，不要用 `strings`。**Windows 新构建产物的**装载期导入**
必须与原产物完全一致，共 **7 项**，且不得出现 `vcruntime140.dll`：

```
advapi32.dll
api-ms-win-core-synch-l1-2-0.dll
bcryptprimitives.dll
kernel32.dll
ntdll.dll
ole32.dll
oleaut32.dll
```

**延迟导入应为 0 项。**可复现的检查命令（两个架构要用不同的 objdump，x86_64 那个
在 macOS 上由 `brew install mingw-w64` 提供）：

```
# x64-win32
x86_64-w64-mingw32-objdump -p <path>/audio-capture.node | grep 'DLL Name:'
# arm64-win32
objdump -p <path>/audio-capture.node | grep 'DLL Name:'
# 延迟导入：Delay Import Directory 一行的 RVA/size 应为全 0
x86_64-w64-mingw32-objdump -p <path>/audio-capture.node | grep 'Delay Import'
```

**为什么不用 `strings`（这里曾经数错过一项）**：`strings -a <file> | grep -oiE
'[A-Za-z0-9_.-]+\.dll'` 是启发式，只能**过度包含**——它分不出装载期导入、延迟导入和
"碰巧作为字符串出现在二进制里"的名字。用它比对会多出 **`dbghelp.dll`**，把 7 项数成
8 项；而 `dbghelp.dll` **不在任何一个产物的导入表里**，它是 Rust std 的 backtrace 在
panic 时才用 `LoadLibrary` 现加载的符号化目标。**结论不受影响**（新旧产物逐项相等、
`vcruntime140.dll` 确已消除），受影响的是方法与那个数字。若因手边没有 objdump 而
仍要用 `strings` 法，除 `dbghelp.dll` 外还必须排除 crate 自身的模块名——**自建产物是
`audio_capture.dll`、原厂产物是 `audio_capture_napi.dll`**（都是构建产物重命名为
`audio-capture.node` 之前的原名，不是外部依赖，两个名字不同所以两边都要排）。

### 3.3 `scripts/audio-capture-cross.toml`：Linux 交叉构建的 ALSA pre-build 配置

这份文件放在 `scripts/` 下（不是仓库根，也不是
`packages/audio-capture-napi/native/`），文件名故意不叫裸的 `Cross.toml`。
理由都是**实测出来的**，不是猜的：

- **`cross` 默认不会去仓库根找 `Cross.toml`**。实测：在仓库根放一份带
  `pre-build` 的 `Cross.toml`，`cd` 到 `native/` 后不设 `CROSS_CONFIG` 直接
  跑 `cross build`，pre-build 完全没有执行，直接进入正常编译并复现了缺
  ALSA 的报错——`cross` 认的是 Cargo.toml 所在目录（即 `native/` 本身），
  不会向上翻到仓库根。
- **`packages/audio-capture-napi/native/` 不归这个构建脚本管**——那个目录
  由 Rust 那半边的 worker 独立维护，不该被构建脚本这边的配置文件混进去。
- **`CROSS_CONFIG` 环境变量指向任意路径都生效，与文件实际位置无关**。
  实测：把 `CROSS_CONFIG` 指向 `scripts/` 下一份写着
  `pre-build = ["echo MARKER && exit 17"]` 的文件，`cross build` 真的在
  Docker buildx 里执行了这条 pre-build 命令（能在构建日志里看到
  `MARKER` 输出）并按 `exit 17` 失败退出——证明 `CROSS_CONFIG` 是显式覆盖，
  不依赖文件跟 Cargo.toml 的相对位置关系。
- **不叫裸 `Cross.toml`（哪怕放在仓库根）**，是为了不让人误以为"随便在这个
  仓库跑裸 `cross build` 就会自动应用这份配置"——它只在
  `scripts/build-audio-capture.sh` 显式导出 `CROSS_CONFIG` 时才生效。

内容形如：

```toml
[target.x86_64-unknown-linux-gnu]
pre-build = [
  "dpkg --add-architecture $CROSS_DEB_ARCH",
  "apt-get update && apt-get install --assume-yes libasound2-dev:$CROSS_DEB_ARCH",
]

[target.aarch64-unknown-linux-gnu]
pre-build = [ ... 同上 ... ]
```

`--check` 会核对这份文件是否存在、且是否包含对应 triple 的
`[target.<triple>]` 段落（`cross_config_covers_target`）；`cross`/`Docker`
就绪但这份配置缺失或没覆盖该 target 时，报 `NEEDS_ALSA_CONFIG` 而不是
`READY`——单看 "cross 装了、Docker 在跑" 不足以判定就绪，还差这一步。
原生 Linux 宿主（不走 `cross`）对应的检查是 `host_has_alsa_dev()`
（`pkg-config --exists alsa`），缺了报 `NEEDS_ALSA`。

## 4. 纪律：构建脚本不进 precheck / verify / 常规 CI

**`scripts/build-audio-capture.sh` 不接进 `bun run precheck`、
`bun run verify`，也不接进 `.github/workflows/ci.yml`。** 它是一个纯带外的
开发者工具，需要手动调用；Windows 两个 MSVC triple 另由仅
`workflow_dispatch` 的 `build-audio-capture-windows.yml` 构建。理由：

- 常规 CI 的阻塞门禁没有为这项构建配置 Rust 工具链，若把构建脚本接进去会让
  整条门禁**全红**，而这与「这个原生模块是否正常」毫无关系；
- 这个原生模块是**可选能力**：`packages/audio-capture-napi/src/index.ts`
  在模块加载失败（含文件不存在、平台不支持、`require` 抛错）时，全部导出
  函数都优雅降级（`isNativeAudioAvailable()` 返回 `false`，其余变成安全的
  空操作/默认值），不影响其余功能；
- `vendor/audio-capture/` 下的六个二进制此前是随基座快照带来的既有产物；本轮已
  全部替换为该源码构建的产物并完成标注切换。今后重新构建/替换它们仍是一个
  **审慎的、需要人工确认的动作**，不应该被任何自动化门禁在无人看管的情况下
  悄悄触发。

需要构建时手动运行 `scripts/build-audio-capture.sh`；`package.json` 的
`scripts` 字段**不会**加任何指向它的入口（加了会让人以为它进了常规构建链）。

### 4.1 维护须知：改这个脚本时留意 `set -e` 在条件上下文里会被整体抑制

脚本顶部 `set -euo pipefail`，但 `build_one_triple` 是被主流程
`if ! build_one_triple ...; then FAILED+=(...); fi` 这样的条件语句调用的
——POSIX/bash 语义下，`errexit` 对 `if`/`while`/`until` 的条件、`!` 取反、
`&&`/`||` 的操作数**整体不生效**，包括递归调用到的整个函数体。这不是
"该函数容易出 bug"的猜测，是**实测踩过的真事故**：`cross build` 因为缺
ALSA 失败后，脚本没有中断执行，直接落到了"产物不在预期位置"的兜底分支，
打出一条完全指错方向的诊断（把读者指向 `CARGO_TARGET_DIR` 配置，而真因
是 `alsa-sys` 编译失败，就在几行之上的输出里）。

`verify_artifact` 同理——它是被 `if ! verify_artifact ...; then` 调用的，
函数体内同样不能指望 `set -e` 自动中断。

**处理方式**：`build_one_triple` 里的构建命令、`mkdir`/`cp`，以及
`verify_artifact` 里的 `mktemp`/`cp`，全部改成显式捕获退出码再分支，
不依赖 `set -e`：

```bash
local build_rc=0
( cd ... && cargo build ... ) || build_rc="${?}"
if [ "${build_rc}" -ne 0 ]; then
  echo "构建失败（退出码 ${build_rc}），见上方输出。" >&2
  return 1
fi
# 只有构建真的成功，才轮到"产物不在预期位置"这条推测性诊断
```

**日后再往这两个函数里加命令，凡是"失败了就不该继续、且失败信息要準确"
的地方，都要用这个模式，不要假设 `set -e` 会替你把关。** 反过来，凡是
预期本来就可能失败、只是想问"是不是"的地方（`is_target_installed`、
`has_cross`、`docker_running`、`cross_config_covers_target` 这类判定函数），
继续用 `if predicate; then` 的写法——那是正确用法，不是同一个坑。

## 5. 怎么验证一个新构建出来的 `.node` 是好的

**本机能原生加载的产物，`--install` 已经自动做了这三件事**（§3 的
`verify_artifact` 闸门），不过是拒绝安装、非零码退出，不需要另外手动跑一遍。
下面这份清单在两种情况下仍然有用：①用 `--allow-unverified-install` 装的
跨平台/跨架构产物——闸门在本机跳过了，需要到目标平台自己跑一遍；②想在
`--install` 之外单独确认某个 `.node` 文件是否可用（比如排查线上问题、核对
一份别人发来的产物）。至少做这三件事：

1. **加载探针**：确认 `require()` 不抛错。最简单的方式是让
   `packages/audio-capture-napi/src/index.ts` 的 `isNativeAudioAvailable()`
   返回 `true`——它内部就是 `loadModule() !== null`，`loadModule()` 会依次
   尝试 `AUDIO_CAPTURE_NODE_PATH`、`getVendorRoot()` 推导路径、以及几个相对
   路径兜底（见该文件第 50-102 行）。装好之后跑一次会经过语音路径的
   `bun test` 或手动 `node -e "require('<path>/audio-capture.node')"`（Bun
   同理，注意是 CJS `require`，`.node` 不是 ESM）都能验证这一步。
2. **八个函数名齐全**：本文档 §1 表格里的全部八个都应该实现。TS 侧的
   `AudioCaptureNapi` 类型只把 `microphoneAuthorizationStatus` 标成可选
   （`mod.microphoneAuthorizationStatus?.()`），那是给"更旧/更窄的历史
   产物"留的兼容写法——**一份新构建出来的模块不应该缺它**，`verify_artifact`
   就是把全部八个都按必需校验的（`REQUIRED_EXPORTS`）。用 `Object.keys()`
   或逐个 `typeof mod.xxx === 'function'` 断言即可——**`startRecording` /
   `stopRecording` / `isRecording` / `startPlayback` / `writePlaybackData`
   / `stopPlayback` / `isPlaying` 这七个在 JS 侧完全没有 `?.()` 保护**，缺
   一个都会在实际调用时才炸，而不是加载时就报错。
3. **`microphoneAuthorizationStatus()` 返回值落在 `0..3`**：调用一次，
   断言返回值是 `0`、`1`、`2`、`3` 之一（Linux 上应该恒为 `3`）。这个函数
   最容易被移植错——它是 macOS TCC 状态、Linux 常量、Windows 注册表读取
   三套完全不同的实现，任何一个平台返回了超出 `0..3` 的值或者抛了异常，
   都说明对应平台的实现有问题。

三步都过，再考虑真正跑一次端到端录音/播放（真实设备、真实音频数据）——
那已经超出「产物是否装对了」的范围，属于功能验收，不在本文档讨论。

**`arm64-win32` 不属于上面第①类，它是另一种处境**：两个 Windows 产物都没走
这个脚本（`--install` 复制的是 cargo 刚在本机构建出来的那个路径，装不了从别处
取回的文件），而是从 GitHub Actions 工作流 run 下载 artifact、核对后直接复制进
`vendor/audio-capture/{x64-win32,arm64-win32}/audio-capture.node`。其中
`x64-win32` 已在构建它的 runner 上完成加载验证；`arm64-win32` 至今没有在任何
机器上被加载或执行过（runner 是 x86_64，结构上加载不了 aarch64 DLL，工作流对此
打印显式跳过理由而不是假装通过），欠一次真实 Windows on ARM 上的加载验证。

**跨平台产物在构建机上做不到"加载探针"时的退化验证**：比如在 macOS 上用
`cross` 交叉构建出的 Linux `.so`，本机运行不了，`require()` 会直接报
"不是本平台的可执行格式"，不代表产物坏了。这种情况只能验**结构**，不能
验行为：

```bash
file target/<triple>/release/libaudio_capture.so
# 期望：ELF 64-bit LSB shared object，架构（x86-64 / ARM aarch64）与 triple 相符

nm -D target/<triple>/release/libaudio_capture.so | grep napi_register_module_v1
# 或 llvm-nm --dynamic 同一个文件——期望能看到这一行，是 N-API 模块的入口符号
```

`napi_register_module_v1` 存在只说明 napi-rs 的宏正确生成了模块注册代码，
**不等于**§5 上面三步的验证结果——结构符号不能替代目标平台的加载/导出面/
`microphoneAuthorizationStatus()` 校验。当前六个产物中，五个已有运行时加载证据；
`arm64-win32` 仍需在 Windows on ARM 上补这一层验证。`--check` §3.1 有两个
Linux triple 的真实 `file`/`nm -D` 输出可以对照。
