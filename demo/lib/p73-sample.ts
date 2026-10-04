// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P7.3 —— 长驻内存的**外部**采样器。
 *
 *   bun run demo/lib/p73-sample.ts \
 *     --resident-pid 40321 --out /srv/p73/mem-external.ndjson \
 *     --interval-ms 60000 --minutes 1440
 *
 * ## 为什么要有「外部」这一条通道
 *
 * `occ resident --mem-sample` 已经在进程内采 `rss` 与 `bun:jsc` 的堆指标。那条线
 * 看得见 JS 堆，看不见两样东西：
 *
 * 1. **ACP 子进程**。常驻节点是父子两个进程，子进程的内存不在父进程的任何计数里。
 *    只看父进程的 24 h 曲线，一个把内存全泄在子进程里的节点长得完全正常。
 * 2. **内核视角的水位线**。`VmHWM` 是**历史峰值**，进程内采样只能看到采样那一刻；
 *    cgroup 的 `memory.peak` 与 `memory.events` 的 `oom_kill` 同理——一次发生在
 *    两次采样之间的逼近，进程内通道读不到，内核记得。
 *
 * 反过来这条通道读不到 JS 堆。两条一起看才完整，这也是报告 §8 那条缺口的由来：
 * ACP 子进程的 JS 堆**两条通道都拿不到**，M0 内只有它的 RSS。
 *
 * ## 通道降级是要写下来的
 *
 * Linux 上走 `/proc/<pid>/status`（`VmRSS` / `VmHWM`）+ `smaps_rollup`（`Pss`），
 * 加 cgroup v2 的 `memory.current` / `memory.peak` / `memory.events`。macOS 上这些
 * 全都没有，退到 `ps -o rss=`。
 *
 * **退化时每条记录都带 `channel: 'ps'`，绝不静默假装采到了。**一份不标注通道的
 * 数据集，事后没人能分辨「这台机器没有 cgroup」和「这台机器的 cgroup 一直是 0」。
 * `p73-report-core.ts` 据此把带降级通道的数据集判为「仅供仪器校准」。
 *
 * ## 它不碰被测进程
 *
 * 只读 `/proc` 与 `ps`。**不发信号、不触发 GC、不注入任何东西。**24 h 长跑要观测的
 * 是不干预时的行为；一个替被测进程清堆的采样器，测到的是它自己的节拍。
 *
 * ## 可重启续采
 *
 * 与 `p31-copy-resident-timings.ts` 同一个思路：**按已写字节偏移继续**。输出文件
 * 以追加方式打开，启动时记下已有字节数并在收尾摘要里报出来，中途被 SIGTERM 打断
 * 后重新起一次，两段数据在同一个文件里首尾相接，不覆盖也不重来。
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { arg, emit, intArg } from './cli-args.js'
import { counter, unifiedCgroupDirectory } from './cgroup.js'

/** 采样通道。`proc` 是完整的那条，`ps` 是明确标注的降级。 */
type Channel = 'proc' | 'ps'

type Role = 'resident' | 'acp'

interface CgroupReading {
  readonly current: number
  readonly peak?: number
  readonly oomKill: number
}

interface Sample {
  readonly at: number
  readonly pid: number
  readonly role: Role
  readonly channel: Channel
  /** 字节。`proc` 通道来自 `VmRSS`，`ps` 通道来自 `ps -o rss=`（KiB×1024）。 */
  readonly rss: number
  /** `VmHWM`，字节。进程生命周期内的 RSS 历史峰值，`ps` 通道没有。 */
  readonly vmHwm?: number
  /** `smaps_rollup` 的 `Pss`，字节。父子共享页在这条线上只算一份。 */
  readonly pss?: number
  readonly cgroup?: CgroupReading
}

function requiredPath(name: string): string {
  const value = arg(name)
  if (value === undefined || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(
      `--${name} must be an absolute path without control characters`,
    )
  }
  return value
}

/** `/proc/<pid>/status` 与 `smaps_rollup` 的 `Key:   N kB` 行。 */
function kilobytesField(text: string, key: string): number | undefined {
  const line = text
    .split('\n')
    .find(candidate => candidate.startsWith(`${key}:`))
  const value = line?.match(/(\d+)\s*kB/)?.[1]
  return value === undefined ? undefined : Number(value) * 1024
}

function readNumberFile(path: string): number | undefined {
  const raw = readFileSync(path, 'utf8').trim()
  return /^\d+$/.test(raw) ? Number(raw) : undefined
}

function readCgroup(pid: number): CgroupReading | undefined {
  try {
    const directory = unifiedCgroupDirectory(String(pid))
    const current = readNumberFile(join(directory, 'memory.current'))
    if (current === undefined) return undefined
    // `memory.peak` 是较新内核才有的；缺它不该让整个 cgroup 通道失效。
    let peak: number | undefined
    try {
      peak = readNumberFile(join(directory, 'memory.peak'))
    } catch {
      peak = undefined
    }
    return {
      current,
      ...(peak === undefined ? {} : { peak }),
      oomKill: counter(join(directory, 'memory.events'), 'oom_kill'),
    }
  } catch {
    return undefined
  }
}

/** `ps` 兜底：KiB。拿不到就返回 undefined，由调用方决定怎么记。 */
function psResidentBytes(pid: number): number | undefined {
  try {
    const raw = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
    return /^\d+$/.test(raw) ? Number(raw) * 1024 : undefined
  } catch {
    return undefined
  }
}

function sampleOne(pid: number, role: Role, at: number): Sample | undefined {
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8')
    const rss = kilobytesField(status, 'VmRSS')
    if (rss === undefined) throw new Error('VmRSS missing')
    const vmHwm = kilobytesField(status, 'VmHWM')
    let pss: number | undefined
    try {
      pss = kilobytesField(
        readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8'),
        'Pss',
      )
    } catch {
      pss = undefined
    }
    const cgroup = readCgroup(pid)
    return {
      at,
      pid,
      role,
      channel: 'proc',
      rss,
      ...(vmHwm === undefined ? {} : { vmHwm }),
      ...(pss === undefined ? {} : { pss }),
      ...(cgroup === undefined ? {} : { cgroup }),
    }
  } catch {
    // /proc 不可用（macOS，或进程已退出）。降级，并**把降级写进记录里**。
    const rss = psResidentBytes(pid)
    return rss === undefined ? undefined : { at, pid, role, channel: 'ps', rss }
  }
}

/** ACP 子进程：常驻进程的直接子进程。每轮重找，因为它会重启换 pid。 */
function acpChildren(residentPid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(residentPid)], {
      encoding: 'utf8',
    })
      .split('\n')
      .map(line => line.trim())
      .filter(line => /^\d+$/.test(line))
      .map(Number)
  } catch {
    // pgrep 在「一个子进程都没有」时以 1 退出，这不是错误。
    return []
  }
}

const residentPid = intArg('resident-pid', 0)
if (!Number.isInteger(residentPid) || residentPid <= 0) {
  throw new Error('--resident-pid must be a positive integer')
}
const out = requiredPath('out')
const intervalMs = intArg('interval-ms', 60_000)
if (intervalMs < 250) {
  throw new Error('--interval-ms must be at least 250')
}
const minutes = intArg('minutes', 1_440)
if (minutes <= 0) throw new Error('--minutes must be positive')

// 续采的锚点：已有多少字节。新文件就是 0。
const resumeBytes = existsSync(out) ? statSync(out).size : 0
const handle = openSync(out, 'a', 0o600)
chmodSync(out, 0o600)

let written = 0
let bytes = 0
let missed = 0
const channels = new Set<Channel>()
let stopping = false
let wake: (() => void) | null = null

const stop = (): void => {
  stopping = true
  wake?.()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

/** 可被 SIGTERM 立刻打断的等待——60 s 的间隔不该让收尾等 60 s。 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      wake = null
      resolve()
    }, ms)
    wake = () => {
      clearTimeout(timer)
      wake = null
      resolve()
    }
  })
}

function record(sample: Sample): void {
  const line = `${JSON.stringify(sample)}\n`
  writeSync(handle, line)
  written += 1
  bytes += Buffer.byteLength(line)
  channels.add(sample.channel)
}

function round(): void {
  const at = Date.now()
  const resident = sampleOne(residentPid, 'resident', at)
  if (resident === undefined) missed += 1
  else record(resident)
  for (const child of acpChildren(residentPid)) {
    const sample = sampleOne(child, 'acp', at)
    if (sample === undefined) missed += 1
    else record(sample)
  }
}

const endAt = Date.now() + minutes * 60_000
process.stderr.write(
  `p73-sample: pid=${residentPid} interval=${intervalMs}ms minutes=${minutes} resume=${resumeBytes}B\n`,
)

try {
  round()
  while (!stopping && Date.now() < endAt) {
    await sleep(intervalMs)
    if (stopping) break
    round()
  }
} finally {
  closeSync(handle)
}

emit({
  out,
  residentPid,
  intervalMs,
  minutes,
  samples: written,
  bytesWritten: bytes,
  resumeBytes,
  // 采不到的轮次单独计数：一条也没漏和漏了三条，在曲线上长得不一样。
  missed,
  channels: [...channels].sort(),
  degraded: channels.has('ps'),
  stoppedEarly: stopping,
})
