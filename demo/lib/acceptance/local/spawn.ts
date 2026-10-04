// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 本地驱动 —— 从**源码**起一个真的 `qm` 进程。
 *
 * 为什么不走 `dist/cli-node.js`（`demo/env/*` 那套的做法）：那要求先跑一次
 * `demo/env/bootstrap.sh` 里的 vite 构建。验收套件的硬要求是「不许有手工
 * 步骤」，而一条「请先构建」就是手工步骤；把构建塞进套件又要在每次跑之前
 * 付几分钟。
 *
 * 所以这里复刻 `scripts/dev.ts` 的做法：把 `MACRO.*` defines 与 feature 列表
 * 用 `-d` / `--feature` 注进去，直接跑 `src/entrypoints/cli.tsx`。**defines 与
 * feature 列表从 `scripts/defines.ts` 取，与 dev / build 同源** —— 自己抄一份
 * 常量就会在下次改默认 feature 列表时静默漂移，而漂移的表现是「套件测的那个
 * 二进制和发出去的不是一个」。
 *
 * 与 `dev.ts` 的唯一区别：那边 `spawnSync` + `stdio: inherit`（人在看），
 * 这里 `spawn` + 全 pipe（机器在看，stdout 的 banner 与 stderr 的告警都是
 * 断言对象）。
 */

import { join } from 'node:path'
import {
  getMacroDefines,
  resolveBuildFeatures,
} from '../../../../scripts/defines.js'

/** 仓库根：本文件在 `<root>/demo/lib/acceptance/local/`。 */
export const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

const CLI_ENTRY = join(REPO_ROOT, 'src/entrypoints/cli.tsx')

let cachedPrefix: readonly string[] | undefined

/**
 * `bun run -d… --feature… src/entrypoints/cli.tsx` 的前缀。
 *
 * 算一次缓存起来：`resolveBuildFeatures()` 会读 env 并遍历默认表，一个场景
 * 起三四个进程时重复算纯属浪费，而它在一次运行内不会变。
 */
export function cliPrefix(): readonly string[] {
  if (cachedPrefix !== undefined) return cachedPrefix
  const defines = {
    ...getMacroDefines(),
    'process.env.NODE_ENV': JSON.stringify('production'),
  }
  const defineArgs = Object.entries(defines).flatMap(([k, v]) => [
    '-d',
    `${k}:${String(v)}`,
  ])
  const featureArgs = [...resolveBuildFeatures()].flatMap(name => [
    '--feature',
    name,
  ])
  cachedPrefix = ['bun', 'run', ...defineArgs, ...featureArgs, CLI_ENTRY]
  return cachedPrefix
}

export interface SpawnedProcess {
  readonly pid: number
  stdout(): string
  stderr(): string
  alive(): boolean
  /** 先 TERM，宽限后 KILL。幂等。 */
  stop(graceMs?: number): Promise<void>
  /** 进程退出码（还活着时是 undefined）。 */
  exitCode(): number | undefined
}

export interface SpawnOptions {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd?: string
}

/**
 * 起一个 `qm` 子进程并把两条流实时抽干。
 *
 * **必须实时抽干**，不能等进程结束再 `new Response(p.stdout).text()`：常驻
 * 节点是长跑进程，等它结束就是等到超时；而管道写满之后子进程会阻塞在
 * `write` 上，表现为「节点起来了但什么都不干」。
 */
export function spawnCli(options: SpawnOptions): SpawnedProcess {
  const proc = Bun.spawn([...cliPrefix(), ...options.argv], {
    cwd: options.cwd ?? REPO_ROOT,
    env: { ...process.env, ...options.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })

  let out = ''
  let err = ''
  void drain(proc.stdout, chunk => {
    out += chunk
  })
  void drain(proc.stderr, chunk => {
    err += chunk
  })

  let stopped = false
  return {
    pid: proc.pid,
    stdout: () => out,
    stderr: () => err,
    alive: () => proc.exitCode === null && proc.signalCode === null,
    exitCode: () => proc.exitCode ?? undefined,
    stop: async (graceMs = 3_000) => {
      if (stopped) return
      stopped = true
      if (proc.exitCode !== null || proc.signalCode !== null) return
      proc.kill('SIGTERM')
      const died = await Promise.race([
        proc.exited.then(() => true),
        new Promise<boolean>(resolve =>
          setTimeout(() => resolve(false), graceMs),
        ),
      ])
      if (!died) {
        proc.kill('SIGKILL')
        await proc.exited
      }
    },
  }
}

async function drain(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): Promise<void> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) onChunk(decoder.decode(value, { stream: true }))
    }
  } catch {
    // 进程被 kill 时流会以异常收场，那不是观察结果，吞掉即可。
  }
}

/** 跑一条**会结束**的 `qm` 子命令，收集全部输出。 */
export async function runCli(
  options: SpawnOptions & { readonly timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = spawnCli(options)
  const timeoutMs = options.timeoutMs ?? 30_000
  const finished = await Promise.race([
    (async () => {
      while (proc.alive()) await sleep(20)
      return true
    })(),
    new Promise<boolean>(resolve =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ])
  if (!finished) {
    await proc.stop()
    return {
      code: -1,
      stdout: proc.stdout(),
      stderr: `${proc.stderr()}\n[acceptance] 子命令超时 ${timeoutMs}ms`,
    }
  }
  // 退出之后再让抽流循环跑一拍，否则最后一段输出可能还没进缓冲区。
  await sleep(30)
  return {
    code: proc.exitCode() ?? -1,
    stdout: proc.stdout(),
    stderr: proc.stderr(),
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 轮询等一个条件成立。
 *
 * 超时抛，且**把最后一次观察到的现场带在异常里** —— 「等 X 超时」这条消息
 * 本身没有排查价值，有价值的是超时那一刻 stderr 里是什么。
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: {
    readonly timeoutMs: number
    readonly stepMs?: number
    readonly what: string
    readonly diagnose?: () => string
    readonly signal?: AbortSignal
  },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs
  const step = options.stepMs ?? 50
  for (;;) {
    if (await predicate()) return
    if (options.signal?.aborted === true) {
      throw new Error(
        `等待 ${options.what} 时被中止；现场:\n${options.diagnose?.() ?? ''}`,
      )
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `等待 ${options.what} 超时（${options.timeoutMs}ms）；现场:\n${options.diagnose?.() ?? '(无)'}`,
      )
    }
    await sleep(step)
  }
}
