// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SSH 连接复用 —— 每台机器只做**一次**真握手（issue #100）。
 *
 * ## 它修的是「数量」，不是「判据」
 *
 * 真机腿一轮 105 条场景 × 每条十几到二十几次 SSH ≈ **两千次连接建立**，其中一
 * 台还要经 gcloud IAP 的 ProxyCommand。`Connection closed by <ip> port 22` 发生
 * 在 TCP + 认证握手阶段，远端命令一行都没执行到 —— 单次失败率哪怕只有 0.05%，
 * 两千次里出一次就是必然，而且**每轮出在不同的调用点**（第一轮 `#freePortOn`，
 * 第二轮 `execHost.exec`），所以「再给那一处补一次重试」永远追不上。
 *
 * 于是这里改的是传输层配置：`ControlMaster` 让一台机器只做一次真握手，之后每
 * 条命令在已经建好的会话上开一条 channel（不再有 TCP、不再有认证）。两千次连接
 * 建立 → 五次。
 *
 * **断言什么、判定什么一个字不动。**真的链路断了照样红；这个模块不吞任何东西，
 * 它只是不再为同一台机器重复做两千次握手。为什么不能改成「给非幂等命令加重试」
 * 见 {@link FleetDriver.#once} 的头注：34 个调用点里 11 个非幂等，重发一条
 * `qm ca` 会往审计链里多写一条记录 —— 比一条 `error` 糟。
 *
 * ## 四件必须做对的事
 *
 * ① **`ControlPath` 不能超 macOS 的 unix socket 上限**（`sun_path` 104 字节）。
 *    所以用 `%C`（OpenSSH 对 `%l%h%p%r` 的 SHA-1 摘要，**展开成 40 个十六进制
 *    字符**）而不是 `%r@%h:%p` —— 后者的长度跟着主机名与用户名走，`workbench-iap`
 *    这种目标很容易顶到上限，而超限时 ssh 的报错难懂到没法诊断。目录本身也必须
 *    短：`os.tmpdir()` 在 macOS 上是 `/var/folders/…/T/`（约 49 字节），剩不下
 *    多少余量，所以这里**显式用 `/tmp`**（见 {@link CONTROL_DIR_BASE}）。
 *    最终形态 `/tmp/qm-ssh-XXXXXX/<40 hex>` = 59 字节。算得出来还不够 ——
 *    {@link SshMultiplex.controlPath} 每次都自己核一遍，超了如实报错。
 *
 * ② **一轮一个目录，`mkdtemp` 现开。**两轮并行跑（同一台 runner 上同时跑两条腿）
 *    因此不会互相踩：目录名带 6 位随机，socket 名是 `%C`，两级都不重。
 *
 * ③ **两条长命隧道显式退出复用**（{@link TUNNEL_NO_MUX_ARGS}）。`ssh -N -R` 与
 *    `ssh -N -L` 是跑一整轮的进程；它们共享 master 会让「杀掉隧道进程」与「转发
 *    真的撤掉」脱钩 —— master 还活着，转发就还在，而那是一个会静默留下端口占用
 *    的坑。
 *
 * ④ **收尾逐台 `ssh -O exit`，立刻拆、不等超时。**那些 socket 背后是**到生产机
 *    的活会话**，跑完还挂着几条不可接受。见 {@link SshMultiplex.dispose}。收尾
 *    挂在四条路径上：入口的 `finally`（含场景抛异常、超时、判定失败）、
 *    `SIGINT`/`SIGTERM` 处理器、`process.on('exit')` 的同步版，以及「拆的时候
 *    恰好正在建」那个窗口（{@link SshMultiplex.#open} 末尾）。
 *
 *    **`SIGKILL` 接不住，那条改不了** —— 内核直杀，进程收不到任何通知。改得了
 *    的是「接不住之后留下的东西活多久」：master 现在带
 *    {@link MASTER_IDLE_PERSIST_S} 的 `ControlPersist`，于是那几条闲置会话在
 *    有界时间内自己过期、socket 一并 unlink，而不是活到那台机器重启。选值的
 *    推算与实测写在那个常量上。**它不改正常路径**：六条收尾照旧显式
 *    `-O exit`，一秒都不等。手工收残局的法子不变：对 `/tmp/qm-ssh-*` 里的每个
 *    socket 发一次 `ssh -O exit -o ControlPath=<那个目录>/%C <目标>`，再把目录
 *    删掉。它们**不会**变成假绿：master 与被测系统无关，留着只是浪费一条会话。
 *
 * ## 建不起来时如实红，不许静默退回
 *
 * master 起不来时
{
  @link
  SshMultiplex.ensure
}
回一条`failed`
，调用方据此**不发
 * 那条远端命令**、原样返回一次 rc=255 的传输层失败。两个理由：
 *
 *   · 「看起来在复用其实没有」是这类改动最难发现的失败形态 —— 静默退回等于让
 *     这个改动的效果无法验证；
 *   · 对非幂等调用点（`#once`）来说，「命令确定没跑」是**比原先更安全**的结局：
 *     原先一次握手抖动也可能发生在命令送出之后。
 *
 * 失败**不缓存**：`#read` / `#diag` 那层的退避重发会连 master 一起再试一次，而
 * 「建一次 master」本身不带任何远端副作用（`-N` 不跑远端命令），重试它是安全的。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { SSH_TRANSPORT_EXIT_CODE } from '../transport.js'

/**
 * macOS 的 `sockaddr_un.sun_path` 容量（Linux 是 108）。取小的那个。
 *
 * 超限的表现不是一句「路径太长」，而是 ssh 以各种难懂的方式失败，所以宁可自己
 * 先算一遍。
 */
export const UNIX_SOCKET_PATH_MAX = 104

/**
 * 复用套接字的落点。**显式 `/tmp` 而不是 `os.tmpdir()`** —— 理由是长度，见文件头
 * ①。`mkdtemp` 建出来的目录是 0700，`/tmp` 是全局可写这件事因此不构成问题。
 */
export const CONTROL_DIR_BASE = '/tmp'

/** 目录名前缀，`mkdtemp` 再补 6 位随机 —— 两轮并行跑靠它不撞。 */
export const CONTROL_DIR_PREFIX = 'qm-ssh-'

/** `ControlPath` 里那个占位符：OpenSSH 把它展开成 `%l%h%p%r` 的摘要。 */
export const CONTROL_PATH_TOKEN = '%C'

/**
 * `%C` 展开后的字节数 —— SHA-1 的十六进制形态，40 个字符。
 *
 * 实测（OpenSSH_10.3p1）：
 * `ssh -G -o ControlPath=/tmp/qm-ssh-Ab3Xy9/%C <host>` 回
 * `controlpath /tmp/qm-ssh-Ab3Xy9/9cef8d88…fc0`，40 位。
 */
export const CONTROL_PATH_TOKEN_BYTES = 40

/** 建 master 的预算。正常握手 1–5 s，经 IAP 的那台十几秒。 */
export const MASTER_OPEN_TIMEOUT_MS = 45_000

/**
 * master 空闲这么久之后自己过期 —— **`SIGKILL` 之后那条唯一还管用的收尾**
 * （issue #91 ② 的兄弟条目）。
 *
 * ## 它兜的是哪一种漏
 *
 * 正常收尾一共六条路径（`finally`、判定失败、场景抛异常、超时、
 * `SIGINT`/`SIGTERM`、`process.on('exit')`），全部走显式 `ssh -O exit`，
 * **立刻拆、不等超时**。唯独 `SIGKILL` 接不住 —— 内核直杀，进程收不到任何
 * 通知，那是改不了的。改得了的是「接不住之后留下的东西活多久」：不配
 * `ControlPersist` 时 master 是条 `ssh -N`，没人再来拆它就一直挂着；配上
 * 之后它在有界时间内自己过期，socket 也一并 unlink（实测见下）。
 *
 * ## 选值：比「一轮里同一台机器两次命令之间最长间隔」宽
 *
 * 空闲计时器由**每条命令**重置（实测：`ControlPersist=2` 的 master 每 2 s
 * 发一条命令，8 s 后仍在跑）。所以要问的正是那个间隔的上界：
 *
 *   · 场景是**顺序**跑的，每条的墙钟上界 = `scenario.timeoutMs ?? 60 s` ×
 *     `FLEET_TIMEOUT_SCALE`(4)；
 *   · 一次性进程的落机按场景轮转（`FleetDriver.#machineFor`），四台
 *     （`DEFAULT_SPAWN_MACHINES`）轮着来，于是一台机器会被连着若干条
 *     场景跳过；
 *   · 按真实场景表（115 条）+ 四台落机把这个上界算出来是 **56 min**；实测
 *     一轮 30–100 min，所以那个上界比实测整轮还宽。
 *   · 附着来的那台（`cornna-p11` / beta-4）更极端：整轮只被来源探针和一条
 *     `attach-node` 场景碰到，间隔可以接近整轮墙钟（实测 30–100 min）。
 *
 * 取 **2 h**：压过 56 min 的硬上界（2.1×），也压过实测最长的一整轮（1.2×），
 * 而 `SIGKILL` 之后残留的会话最多活 2 h 而不是活到重启。护栏把这个关系钉在
 * `fleetSshMux.test.ts` 里 —— 场景表长了、倍率大了，那条断言会先红。
 *
 * ## 万一还是被跨过去了：那是**降级**，不是红
 *
 * 对 OpenSSH_10.3p1 实测过三种残局，全部 rc=0：
 *
 *   · socket 已被 unlink（正常过期）→ `Control socket … does not exist` →
 *     照常新建一条连接；
 *   · socket 还在但 master 被 SIGKILL 了 → `connect(): Connection refused`
 *     → 同样退回新建连接（那句话只落 stderr，不参与判定：
 *     `isTransportFailure` 只看 rc === 255）；
 *   · 卡在到期那一瞬间发命令 ×10 → 0 次失败。
 *
 * 也就是说选短了的代价是**这台机器往后每条命令各付一次握手**（退回 #100
 * 之前），不是一次假的传输层失败。选长了的代价才是真的：`SIGKILL` 之后到
 * 生产机的闲置会话多活那么久。两边都不想要，所以上面那个数是算出来的。
 */
export const MASTER_IDLE_PERSIST_S = 7_200

/** 等 master socket 出现的轮询间隔。 */
const MASTER_POLL_INTERVAL_MS = 100

/** 从 master 那条进程收多少 stderr 进报告 —— 只为给人看，不参与判定。 */
const MASTER_STDERR_CAP = 4_000

/**
 * 两条长命隧道（`-N -R` / `-N -L`）必须带的参数。
 *
 * `ControlPath=none` 而不是只 `ControlMaster=no`：后者只说「不要当 master」，
 * 有 `ControlPath` 时它照样会去复用已有的 master。两条一起写才是「这条连接与
 * 复用完全无关」。见文件头 ③。
 */
export const TUNNEL_NO_MUX_ARGS: readonly string[] = [
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
]

/** master 建起来了（或本来就关着复用）：这些参数拼进命令行。 */
export interface MuxReady {
  readonly kind: 'ready'
  /** 复用关着时是空表 —— 于是命令行与改造前逐字节相同。 */
  readonly args: readonly string[]
}

/** master 建不起来。**远端命令一行都不许发。** */
export interface MuxFailed {
  readonly kind: 'failed'
  readonly code: number
  readonly stderr: string
}

export type MuxOutcome = MuxReady | MuxFailed

export interface SshMultiplexOptions {
  /** `ssh` 可执行文件 —— 与 `FleetConfig.sshBin` 同一个注入点。 */
  readonly sshBin: string
  /** 额外 SSH 参数，与命令连接用的是同一份。 */
  readonly sshArgs: readonly string[]
  /** 关掉就退回「每条命令自己建一次连接」，命令行与改造前逐字节相同。 */
  readonly enabled: boolean
}

/** 复用关着时的那个恒定答案 —— 空参数表。 */
const MUX_OFF: MuxReady = { kind: 'ready', args: [] }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 在后台把一条流收进字符串，随时可取快照。
 *
 * 不能用「读到 EOF 再取」：master 是条长命进程，它的 stderr 永远不 EOF，等它
 * 等于挂死在建连接这一步。
 */
function accumulate(stream: ReadableStream<Uint8Array>): () => string {
  const chunks: string[] = []
  void (async () => {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value !== undefined) {
          chunks.push(decoder.decode(value, { stream: true }))
        }
      }
    } catch {
      // 进程被 kill 时流以异常收场，那不是观察结果。
    }
  })()
  return () => chunks.join('').slice(0, MASTER_STDERR_CAP)
}

/**
 * 一轮跑里的全部 SSH 复用 master。
 *
 * 生命周期与一次 `FleetDriver` 相同：第一次用到某台机器时现建，一轮结束
 * {@link SshMultiplex.dispose} 逐台拆。
 */
export class SshMultiplex {
  readonly #sshBin: string
  readonly #sshArgs: readonly string[]
  readonly #enabled: boolean
  /** 现开的复用目录，懒建 —— 关着复用时一个目录都不会出现。 */
  #dir: string | undefined
  /** 目标 → 「这台的 master 起没起来」。**只缓存成功**，见文件头。 */
  readonly #pending = new Map<string, Promise<MuxOutcome>>()
  /** 已经起来的 master 进程，拆的时候两条路都走（`-O exit` + kill）。 */
  readonly #masters = new Map<string, Bun.Subprocess>()
  /**
   * 拆过了没有。
   *
   * 挡的是一个很窄但真实的窗口：Ctrl-C 恰好落在「某台机器的 master 正在建」
   * 的那一瞬间 —— 拆的时候它还不在 {@link SshMultiplex.#masters} 里，建完之后
   * 又没有人再来拆它，于是一条到生产机的会话就留在那儿了。见
   * {@link SshMultiplex.#open} 末尾。
   */
  #closed = false

  constructor(options: SshMultiplexOptions) {
    this.#sshBin = options.sshBin
    this.#sshArgs = options.sshArgs
    this.#enabled = options.enabled
  }

  /** 这一轮到底开没开复用 —— 报告与护栏用得上。 */
  get enabled(): boolean {
    return this.#enabled
  }

  /** 已经建起 master 的目标，按建起来的顺序。 */
  establishedTargets(): readonly string[] {
    return [...this.#masters.keys()]
  }

  /**
   * `ControlPath` 的字面值（带 `%C`），必要时现开目录。
   *
   * 长度自己核一遍：展开后是 `<目录>/<40 hex>`，必须真的短于
   * {@link UNIX_SOCKET_PATH_MAX}。算得出来不等于对，所以这条断言留在运行期。
   */
  controlPath(): string {
    const dir = (this.#dir ??= mkdtempSync(
      join(CONTROL_DIR_BASE, CONTROL_DIR_PREFIX),
    ))
    const expanded =
      new TextEncoder().encode(dir).length + 1 + CONTROL_PATH_TOKEN_BYTES
    if (expanded >= UNIX_SOCKET_PATH_MAX) {
      throw new Error(
        `SSH 复用套接字路径太长：${dir}/${CONTROL_PATH_TOKEN} 展开后 ` +
          `${String(expanded)} 字节，而 unix socket 上限是 ` +
          `${String(UNIX_SOCKET_PATH_MAX)}（macOS）。` +
          '换一个更短的 TMPDIR，或用 QIANMO_ACCEPTANCE_SSH_MULTIPLEX=0 关掉复用',
      )
    }
    return join(dir, CONTROL_PATH_TOKEN)
  }

  /**
   * 确保到 `target` 的 master 在跑，回一份「命令连接该带什么参数」。
   *
   * 建不起来回 `failed` —— 调用方**不许**退回非复用模式把命令发出去，见文件头。
   */
  async ensure(target: string): Promise<MuxOutcome> {
    if (!this.#enabled) return MUX_OFF
    // 拆过之后不再建新的 —— 收尾是终态。走到这儿说明有人在收尾之后还想发命令，
    // 那件事本身该被看见，而不是靠悄悄再建一条会话把它盖住。
    if (this.#closed) {
      return this.#failed(target, '这一轮已经收尾了，不再建复用连接。')
    }
    let pending = this.#pending.get(target)
    if (pending === undefined) {
      pending = this.#open(target)
      this.#pending.set(target, pending)
    }
    const outcome = await pending
    // 失败不缓存：上层的退避重发要能连 master 一起再试一次。建 master 不跑任何
    // 远端命令（`-N`），重试它没有副作用。
    if (outcome.kind === 'failed') this.#pending.delete(target)
    return outcome
  }

  /**
   * 一轮结束逐台拆 master。
   *
   * **不等 `ControlPersist` 超时**：那些 socket 背后是到生产机的活会话，跑完还
   * 挂着几条不可接受（issue #100 ③）。那个超时是 `SIGKILL` 的兜底
   * （{@link MASTER_IDLE_PERSIST_S}），这条路径上一秒都不该等它。
   *
   * 两条路都走 —— `ssh -O exit` 是正道；`kill` 补上「socket 已经没了但进程还在」
   * 那种残局。后者在 `ControlPersist` 之后**多半是空转**（我们 spawn 的那条父
   * 进程早已 `daemon(1,1)` 退出，真 master 是另一个 pid），留着不花钱，而它接
   * 得住的是「socket 还没建出来就被拆」这一种。
   */
  async dispose(): Promise<void> {
    const dir = this.#dir
    if (dir !== undefined) {
      for (const [target, child] of this.#masters) {
        const proc = Bun.spawn([this.#sshBin, ...this.#exitArgv(dir, target)], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await proc.exited
        child.kill()
      }
    }
    this.#reset()
  }

  /**
   * 同上，但同步 —— 只给 `process.on('exit')` 那条最后防线用。
   *
   * 那个钩子里 `await` 不管用，而「跑完/被打断之后还挂着到生产机的会话」是这条
   * 改动最不能留的尾巴。正常路径（`finally` 与信号处理器）走
   * {@link SshMultiplex.dispose}，这条到那时已经是空转。
   */
  disposeSync(): void {
    const dir = this.#dir
    if (dir !== undefined) {
      for (const [target, child] of this.#masters) {
        Bun.spawnSync([this.#sshBin, ...this.#exitArgv(dir, target)], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        })
        child.kill()
      }
    }
    this.#reset()
  }

  /**
   * `ssh -O exit` 的参数。
   *
   * **`sshArgs` 必须一起带上。**`%C` 是 `%l%h%p%r` 的摘要，而 `-F` / `-p` /
   * `-l` 这类参数正好会改动其中三项 —— 少带一个，这条 `-O exit` 算出来的就是
   * 另一个 socket 名，于是它对着一个不存在的路径报「没有这个 master」，而真的
   * 那条会话原封不动地留在生产机上。`#check` 同理。
   */
  #exitArgv(dir: string, target: string): readonly string[] {
    return [
      '-O',
      'exit',
      '-o',
      `ControlPath=${join(dir, CONTROL_PATH_TOKEN)}`,
      ...this.#sshArgs,
      target,
    ]
  }

  #reset(): void {
    this.#closed = true
    this.#masters.clear()
    this.#pending.clear()
    if (this.#dir !== undefined) {
      rmSync(this.#dir, { recursive: true, force: true })
      this.#dir = undefined
    }
  }

  /**
   * 建一条到 `target` 的 master。
   *
   * **不用 `-f`**（那是这个 idiom 的常见写法）：`-f` 回 0 只说明 fork 成功了，
   * 那不是「master 起来了」的判据。真判据是 `ssh -O check` —— 问 socket，不问
   * 进程。
   *
   * ## 父进程退出是**正常**结局（`ControlPersist` 之后）
   *
   * 带 {@link MASTER_IDLE_PERSIST_S} 之后 ssh 会在 socket 建好之后立刻
   * `daemon(1,1)`，我们 spawn 的那条**父进程随即退出**，真正的 master 是它 fork
   * 出来的另一个 pid（实测 OpenSSH_10.3p1：`-O check` 回
   * `Master running (pid=…)`，而 spawn 出来的那条已经 `exited`）。
   *
   * 所以「进程退出了 = 建不起来」这条判断**不成立**了，而且退出与 socket 出现
   * 恰好是同一瞬间 —— 一看见退出就判失败，会把绝大多数**成功**的 master 判成
   * 失败。这里改成：看见退出先**再问一次 socket**，socket 在就是成功。
   *
   * 它的 stderr 仍然读得到（`daemon(1, 1)` 的 `noclose` 保留 fd，管道的写端还在
   * daemon 手里），所以「起不来时说了什么」这条没丢。丢掉的只有「用句柄 kill
   * 它」—— 那本来也只是 `-O exit` 之外的兜底，而现在多了一层有界过期。
   */
  async #open(target: string): Promise<MuxOutcome> {
    let path: string
    try {
      path = this.controlPath()
    } catch (err) {
      return this.#failed(
        target,
        err instanceof Error ? err.message : String(err),
      )
    }
    const child = Bun.spawn(
      [
        this.#sshBin,
        '-M',
        '-N',
        '-o',
        'BatchMode=yes',
        '-o',
        `ControlPath=${path}`,
        // 一轮两小时，中间会有长时间不发命令的段落。keepalive 让 master 别被
        // NAT / IAP 悄悄回收成一条死 socket。
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=6',
        // `SIGKILL` 之后那条唯一还管用的收尾 —— 正常路径照旧显式 `-O exit`，
        // 一秒都不等。选值的推算与实测见 {@link MASTER_IDLE_PERSIST_S}。
        '-o',
        `ControlPersist=${String(MASTER_IDLE_PERSIST_S)}`,
        ...this.#sshArgs,
        target,
      ],
      { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    )
    const stderrOf = accumulate(child.stderr)
    void accumulate(child.stdout)
    let exited = false
    void child.exited.then(() => {
      exited = true
    })
    const deadline = Date.now() + MASTER_OPEN_TIMEOUT_MS
    for (;;) {
      if (await this.#check(target, path)) {
        return this.#adopt(target, path, child)
      }
      if (exited) {
        // **父进程退出不等于建不起来**：`ControlPersist` 之后 ssh 会在 socket
        // 建好的那一刻 `daemon(1,1)`，父进程退出与 socket 出现是同一瞬间。
        // 所以这里再问一次 socket —— 上一次 `#check` 只是抢在了 fork 前面。
        if (await this.#check(target, path)) {
          return this.#adopt(target, path, child)
        }
        return this.#failed(target, `master 进程退出了。原文: ${stderrOf()}`)
      }
      if (Date.now() >= deadline) {
        child.kill('SIGKILL')
        return this.#failed(
          target,
          `等了 ${String(MASTER_OPEN_TIMEOUT_MS)}ms，master socket 还没出现。` +
            `原文: ${stderrOf()}`,
        )
      }
      await sleep(MASTER_POLL_INTERVAL_MS)
    }
  }

  /**
   * socket 已经在了：把这条 master 收进账，回「命令连接该带什么参数」。
   *
   * 唯一的例外是「拆的时候它恰好正在建」—— 那时收尾已经跑过、不会再有人来拆
   * 它，所以这里当场收掉，否则一条到生产机的会话会一直挂着。`ControlPersist`
   * 兜的是 `SIGKILL`，不是这个窗口：这个窗口收得干净，就不该留给超时。
   */
  #adopt(target: string, path: string, child: Bun.Subprocess): MuxOutcome {
    if (this.#closed) {
      Bun.spawnSync(
        [
          this.#sshBin,
          '-O',
          'exit',
          '-o',
          `ControlPath=${path}`,
          ...this.#sshArgs,
          target,
        ],
        { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      )
      child.kill()
      return this.#failed(target, '这一轮已经收尾了，不再建复用连接。')
    }
    this.#masters.set(target, child)
    return {
      kind: 'ready',
      args: ['-o', 'ControlMaster=no', '-o', `ControlPath=${path}`],
    }
  }

  /** master 到底在不在 —— 问 socket，不是问进程。纯本地，不发网络包。 */
  async #check(target: string, path: string): Promise<boolean> {
    const proc = Bun.spawn(
      [
        this.#sshBin,
        '-O',
        'check',
        '-o',
        `ControlPath=${path}`,
        // 与 `#exitArgv` 同一条理由：少带一个 `sshArgs`，`%C` 就是另一个名字。
        ...this.#sshArgs,
        target,
      ],
      { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    )
    return (await proc.exited) === 0
  }

  /**
   * 一次「master 建不起来」。
   *
   * rc 钉成 {@link SSH_TRANSPORT_EXIT_CODE}：这**就是**一次没走到远端的失败，
   * 上层那套分类（`#read` 退避重发、`#once` 一次定音、汇总表点名
   * `errorKind='transport'`）原封不动地适用，不需要为它新开一类。
   */
  #failed(target: string, detail: string): MuxFailed {
    return {
      kind: 'failed',
      code: SSH_TRANSPORT_EXIT_CODE,
      stderr:
        `到 ${target} 的 SSH 复用 master 建不起来，${detail}\n` +
        '[acceptance] 这一条**没有**退回「每次新建连接」—— 静默退回会让复用' +
        '是否真的生效变得无法验证，而远端命令一行都没发出去。' +
        '要临时退回请设 QIANMO_ACCEPTANCE_SSH_MULTIPLEX=0',
    }
  }
}
