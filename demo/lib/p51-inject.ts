// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P5.1 —— 五类故障的**真实注入器**。
 *
 * 判据要「注入 5 类故障各 10 次、人工标注 50 条样本、分类准确率 ≥ 80%」，所以这里
 * 的每一条样本都必须是**真的失败**，不是编出来的日志：
 *
 * | 类 | 怎么真出来 |
 * |---|---|
 * | 超时 | 起一个 `sleep`，到点由本进程 `SIGKILL`，并记下「是我们杀的」 |
 * | OOM | 另起进程把堆撑爆：node 会自己喊 "heap out of memory"，**bun 则一个字都不写、直接被系统 SIGKILL** —— 后一半正是判据里最难的那一半 |
 * | 缺依赖 | 执行一个确实不存在的程序，以及 import 一个确实不存在的模块 |
 * | 磁盘满 | Linux 写 `/dev/full`（内核真给 ENOSPC）；macOS 用 `hdiutil` 建一个 1 MiB 卷写满它 |
 * | 额度耗尽 | 本地起一个真 HTTP 服务返回 429 与供应商风格的正文，注入的命令真的去请求它 |
 *
 * **注入器不告诉分类器答案**：`inject()` 返回 `{ label, observation }`，标注只进
 * 报告，分类只看 observation。这一点是这份证据能不能算数的全部——一个能看见标签的
 * 分类器当然 100%。
 *
 * 拿不到真实条件时（例如 macOS 上没有 `/dev/full`、又建不了磁盘映像），该类**如实
 * 记为 skipped**，报告里分类数与准确率都不把它算进去。少一类的报告是不完整的证据，
 * 假装注入过的报告是错的证据。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FailureCause, type FailureObservation } from '@qianmo/diagnosis'

export interface InjectedSample {
  /** 人工标注：这一条**实际上**是哪一类故障。 */
  readonly label: FailureCause
  /** 分类器能看到的全部东西。 */
  readonly observation: FailureObservation
  /** 这条样本是怎么造出来的，写进报告供复核。 */
  readonly how: string
}

export interface SkippedCategory {
  readonly label: FailureCause
  readonly reason: string
}

interface RunOutcome {
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly durationMs: number
}

function run(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs?: number; readonly cwd?: string } = {},
): Promise<RunOutcome & { readonly killedByUs: boolean }> {
  return new Promise(resolve => {
    const startedAt = Date.now()
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: string[] = []
    const stderr: string[] = []
    let killedByUs = false
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    const timer =
      options.timeoutMs === undefined
        ? null
        : setTimeout(() => {
            killedByUs = true
            child.kill('SIGKILL')
          }, options.timeoutMs)
    const finish = (exitCode: number | null, signal: string | null): void => {
      if (timer !== null) clearTimeout(timer)
      resolve({
        exitCode,
        signal,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
        durationMs: Date.now() - startedAt,
        killedByUs,
      })
    }
    child.on('error', error => {
      stderr.push(error.message)
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** 超时：真的跑过头，真的被我们杀掉。 */
async function injectTimeout(index: number): Promise<InjectedSample> {
  const timeoutMs = 120 + index * 5
  const outcome = await run('sleep', ['5'], { timeoutMs })
  return {
    label: FailureCause.Timeout,
    how: `sleep 5 killed by our supervisor after ${timeoutMs}ms`,
    observation: {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
      durationMs: outcome.durationMs,
      timeoutMs,
      timeoutEnforced: outcome.killedByUs,
    },
  }
}

/**
 * cgroup v2 的 `oom_kill` 计数（Linux 才有）。
 *
 * 真机上宿主读得到它，笔记本上读不到——读不到就**不编**，让样本如实缺这条证据。
 */
async function readOomKillDelta(): Promise<{ oomKillDelta?: number }> {
  if (process.platform !== 'linux') return {}
  try {
    const text = await Bun.file('/sys/fs/cgroup/memory.events').text()
    const line = text.split('\n').find(row => row.startsWith('oom_kill '))
    const value = Number(line?.split(' ')[1] ?? '')
    return Number.isFinite(value) && value > 0 ? { oomKillDelta: value } : {}
  } catch {
    return {}
  }
}

/** OOM：真的把堆撑爆，让运行时自己喊出来。 */
export async function injectOom(runtime: string): Promise<InjectedSample> {
  const script =
    'const held = []; for (;;) { held.push(new Array(1e6).fill(Math.random())) }'
  const outcome = await run(
    runtime,
    runtime === 'node'
      ? ['--max-old-space-size=32', '-e', script]
      : ['-e', script],
    { timeoutMs: 60_000 },
  )
  return {
    label: FailureCause.OutOfMemory,
    how: `${runtime} allocating until the heap gave out`,
    observation: {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
      durationMs: outcome.durationMs,
      // 这一条是**事实**而不是提示：注入器给了 60 s 的期限，而这些进程远在它之前
      // 就死了，所以「不是我们杀的」。Bun 撑爆内存时被系统 SIGKILL 且**一个字都
      // 不写**，文本规则无从下手——分辨它的只有这条结构化事实。
      timeoutEnforced: outcome.killedByUs,
      ...(await readOomKillDelta()),
    },
  }
}

/** 缺依赖：真的去执行一个不存在的程序 / import 一个不存在的模块。 */
async function injectMissingDependency(index: number): Promise<InjectedSample> {
  if (index % 2 === 0) {
    const name = `qianmo-not-installed-${index}`
    // 经 shell 执行才拿得到 127 与 "command not found"，直接 spawn 只会 ENOENT。
    const outcome = await run('sh', ['-c', name], { timeoutMs: 10_000 })
    return {
      label: FailureCause.MissingDependency,
      how: `sh -c ${name}`,
      observation: {
        exitCode: outcome.exitCode,
        signal: outcome.signal,
        stderr: outcome.stderr,
        stdout: outcome.stdout,
        durationMs: outcome.durationMs,
      },
    }
  }
  const outcome = await run(
    'node',
    ['-e', `require('qianmo-missing-module-${index}')`],
    { timeoutMs: 10_000 },
  )
  return {
    label: FailureCause.MissingDependency,
    how: `node require of a module that is not installed`,
    observation: {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
      durationMs: outcome.durationMs,
    },
  }
}

/** 磁盘满：Linux 用 `/dev/full`，macOS 用一个 1 MiB 的真卷。 */
export interface DiskFullFacility {
  readonly available: boolean
  readonly reason?: string
  /** 一个写下去一定 ENOSPC 的路径。 */
  readonly targetPath?: string
  readonly cleanup?: () => Promise<void>
}

export async function openDiskFullFacility(): Promise<DiskFullFacility> {
  if (process.platform === 'linux') {
    return { available: true, targetPath: '/dev/full' }
  }
  if (process.platform === 'darwin') {
    const root = mkdtempSync(join(tmpdir(), 'qianmo-p51-dmg-'))
    const image = join(root, 'small.dmg')
    const volume = `qianmo-p51-${process.pid}`
    const created = await run('hdiutil', [
      'create',
      '-size',
      '1m',
      '-fs',
      'HFS+',
      '-volname',
      volume,
      '-quiet',
      image,
    ])
    if (created.exitCode !== 0) {
      rmSync(root, { recursive: true, force: true })
      return {
        available: false,
        reason: `hdiutil create failed: ${created.stderr.trim()}`,
      }
    }
    const attached = await run('hdiutil', [
      'attach',
      image,
      '-nobrowse',
      '-quiet',
    ])
    if (attached.exitCode !== 0) {
      rmSync(root, { recursive: true, force: true })
      return {
        available: false,
        reason: `hdiutil attach failed: ${attached.stderr.trim()}`,
      }
    }
    const mount = `/Volumes/${volume}`
    return {
      available: true,
      targetPath: join(mount, 'fill'),
      cleanup: async () => {
        await run('hdiutil', ['detach', mount, '-quiet'])
        rmSync(root, { recursive: true, force: true })
      },
    }
  }
  return {
    available: false,
    reason: `no known way to produce a real ENOSPC on ${process.platform}`,
  }
}

async function injectDiskFull(
  facility: DiskFullFacility,
  scratch: string,
  index: number,
): Promise<InjectedSample> {
  // 写一个比可用空间大的块：Linux 的 /dev/full 立刻 ENOSPC，macOS 的 1 MiB 卷
  // 写到满为止。两条路径给出的都是内核的错误，不是我们编的字符串。
  const script = join(scratch, `fill-${index}.mjs`)
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'\n` +
      `const block = Buffer.alloc(4 * 1024 * 1024, 1)\n` +
      `writeFileSync(${JSON.stringify(facility.targetPath ?? '')}, block)\n`,
  )
  const outcome = await run('node', [script], { timeoutMs: 20_000 })
  return {
    label: FailureCause.DiskFull,
    how: `writing 4 MiB to ${facility.targetPath ?? 'unknown'}`,
    observation: {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
      durationMs: outcome.durationMs,
    },
  }
}

/** 额度耗尽：真的去请求一个真的返回 429 的本地服务。 */
async function injectQuotaExhausted(
  baseUrl: string,
  scratch: string,
  index: number,
): Promise<InjectedSample> {
  const script = join(scratch, `quota-${index}.mjs`)
  writeFileSync(
    script,
    `const response = await fetch(${JSON.stringify(baseUrl)})\n` +
      `const body = await response.text()\n` +
      `if (!response.ok) {\n` +
      `  process.stderr.write('provider call failed: ' + response.status + ' ' + body + '\\n')\n` +
      `  process.exit(1)\n` +
      `}\n`,
  )
  const outcome = await run('node', [script], { timeoutMs: 20_000 })
  return {
    label: FailureCause.QuotaExhausted,
    how: `HTTP call to a stub provider that answers 429`,
    observation: {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
      durationMs: outcome.durationMs,
      httpStatus: 429,
      service: 'stub-provider',
    },
  }
}

export interface InjectionRun {
  readonly samples: readonly InjectedSample[]
  readonly skipped: readonly SkippedCategory[]
}

/**
 * 造 `perCategory × 5` 条真实样本。
 *
 * 拿不到真实条件的类别记在 `skipped` 里，不产样本——报告据此如实缩小分母。
 */
export async function injectFailures(perCategory = 10): Promise<InjectionRun> {
  const scratch = mkdtempSync(join(tmpdir(), 'qianmo-p51-'))
  const samples: InjectedSample[] = []
  const skipped: SkippedCategory[] = []
  const quota = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () =>
      new Response(
        JSON.stringify({
          error: {
            type: 'rate_limit_error',
            message:
              'Rate limit exceeded: your quota for this minute is used up',
          },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      ),
  })
  const quotaUrl = `http://${quota.hostname}:${quota.port}/v1/messages`
  const disk = await openDiskFullFacility()

  try {
    for (let index = 0; index < perCategory; index += 1) {
      samples.push(await injectTimeout(index))
      samples.push(await injectOom(index % 2 === 0 ? 'node' : 'bun'))
      samples.push(await injectMissingDependency(index))
      samples.push(await injectQuotaExhausted(quotaUrl, scratch, index))
      if (disk.available) {
        samples.push(await injectDiskFull(disk, scratch, index))
      }
    }
    if (!disk.available) {
      skipped.push({
        label: FailureCause.DiskFull,
        reason: disk.reason ?? 'no facility',
      })
    }
    return { samples, skipped }
  } finally {
    await disk.cleanup?.()
    await quota.stop(true)
    rmSync(scratch, { recursive: true, force: true })
  }
}
