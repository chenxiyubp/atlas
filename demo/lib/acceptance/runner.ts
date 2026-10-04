// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌端到端验收套件 —— 执行器。
 *
 * 职责只有一件：**把每个场景放进一个互不影响的盒子里跑，然后如实记账。**
 *
 * 「互不影响」是这套件唯一不能妥协的性质，它由四条共同保证：
 *
 *   ① 每个场景一个专属临时目录（`workdir`）与一套自己分配的端口；
 *   ② 每个场景一份 `cleanup` 栈，**在 `finally` 里逆序执行**——超时、抛异常、
 *      甚至场景自己 `process.exit` 之外的任何路径都会跑到；
 *   ③ 每个场景一个 `AbortSignal` + 硬超时。超时记 `error` 而不是 `fail`：
 *      「套件没等到」和「系统答错了」是两件事；
 *   ④ 场景抛出的异常**不向上传播**，只变成一条 `error` 结果。一条炸了不能
 *      让后面的不跑——那正是负责人要的「无干预跑完全部场景」。
 *
 * 不做的事：**场景层不重试**（重试会把 flake 藏起来）、不并发（真进程 + 端口 +
 * 文件系统状态，并发只会制造无法归因的红）、不因为 `knownIssue` 改判定。
 *
 * 「场景层」那三个字是 issue #96 ③ 之后补的，别把它读成矛盾：`FleetDriver` 在
 * **传输层**（一条 SSH 根本没接上，rc=255，远端命令一行都没执行到）会退避重发
 * 几次。两件事的方向相反 —— 场景层重试藏的是「被测系统这次答错了」，传输层重试
 * 问的是「套件到底问到没有」，而没问到本来就不该记成一条关于被测系统的结论。
 * 重发打满仍不通照样是一条 `error`、照样把整轮判红，只是多带一个
 * `errorKind: 'transport'` 让读报告的人分得开。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { instrumentDriver } from './driverProbe.js'
import { summarize } from './report-core.js'
import { isTransportError } from './transport.js'
import { setDialTimeoutScale } from './local/dial.js'
import type {
  AcceptanceDriver,
  Evidence,
  Outcome,
  Scenario,
  ScenarioContext,
  ScenarioResult,
  SuiteRun,
  TestedProvenance,
} from './types.js'

/** 单场景默认超时。真进程起停 + 一次模型轮次，60 s 够，且不至于挂死一夜。 */
export const DEFAULT_SCENARIO_TIMEOUT_MS = 60_000

/**
 * 真机腿的超时倍率。
 *
 * **场景里的毫秒数是按本地腿写的**：那边起一个常驻是 3~6 s，读一次审计链是
 * 一次 `readFileSync`。真机腿上同样两件事分别是 25~35 s（一次性目录 + 远端
 * 轮询 banner + 建隧道 + 就绪拨号）和一次 SSH 往返（经 IAP 的那台约 1 s），
 * 于是 `waitForMailbox` 这类轮询循环每一拍都要付一次往返。
 *
 * 用同一套毫秒数的后果实测过：`handshake/unknown-signer`（默认 60 s）在真机
 * 腿上光起节点就用掉一半预算，最后记成 `error`。**而 `error` 与 `fail` 在这
 * 套件里是两种含义完全相反的结果** —— 一条本来会绿的场景变成「套件自己炸了」，
 * 报告上既不能算覆盖也不指向任何产品问题。
 *
 * 倍率而不是「真机腿统一给一个大数」：场景之间的相对预算是作者定的（有的
 * 本来就要等两轮模型），统一压平会让本该快的那些在挂死时也拖满。
 *
 * **作用面不止场景预算。**它同时经 `ScenarioContext.timeoutScale` 交到驱动
 * 手上，驱动内部那几个「等它就绪」的墙钟等待也乘它 —— 早先没有那条通路，于是
 * `FleetDriver` 里几个裸的 `Date.now() + 60_000` 会先于场景预算炸掉，把一条
 * 只是慢了一步的场景记成 `error`（issue #85 ②）。
 */
export const FLEET_TIMEOUT_SCALE = 4

export interface RunOptions {
  readonly driver: AcceptanceDriver
  readonly scenarios: readonly Scenario[]
  /** 只跑 id 前缀命中这些的（`--only handshake/ capability/psk`）。 */
  readonly only?: readonly string[]
  readonly timeoutMs?: number
  /**
   * 全部超时（默认值、场景自报的、以及驱动内部的墙钟等待）乘这个系数。
   * 见 {@link FLEET_TIMEOUT_SCALE} 与 `ScenarioContext.timeoutScale`。
   */
  readonly timeoutScale?: number
  /** **跑套件那台机器**的检出提交。 */
  readonly commit?: string
  /**
   * 被测端自报的来源 commit（issue #70 ③）。
   *
   * 由入口在场景循环之前采一次（`driver.testedProvenance?.()`）再传进来，而不
   * 是让 runner 自己去问：入口本来就要把它写进 NDJSON 的**首行**（被打断的一
   * 轮只剩那一行），采集因此必须发生在 runner 开跑之前。传值而不是传驱动，也
   * 让这一层继续是纯的。
   */
  readonly testedProvenance?: TestedProvenance
  /** 每条结果出来就回调一次，供实时打印。 */
  onResult?(result: ScenarioResult): void
  /** 保留临时目录（排查用）。 */
  readonly keepWorkdir?: boolean
}

/** 分配一个空闲 TCP 端口：绑 0 让内核选，记下来再放掉。 */
export async function freePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close()
        reject(new Error('freePort: 拿不到端口号'))
        return
      }
      const { port } = addr
      srv.close(() => resolve(port))
    })
  })
}

function errorEvidence(err: unknown): Evidence[] {
  if (err instanceof Error) {
    const out: Evidence[] = [
      { label: 'error', value: `${err.name}: ${err.message}` },
    ]
    if (typeof err.stack === 'string')
      out.push({ label: 'stack', value: err.stack })
    const cause = (err as { cause?: unknown }).cause
    if (cause !== undefined) {
      out.push({ label: 'cause', value: String(cause) })
    }
    return out
  }
  return [{ label: 'error', value: String(err) }]
}

/**
 * 跑一个场景。
 *
 * 永不抛。任何异常都变成 `error` 结果并带上栈原文 —— 排查一条 `error` 全靠
 * 那段栈，摘要化就等于让人回来重跑一遍。
 */
export async function runScenario(
  scenario: Scenario,
  driver: AcceptanceDriver,
  defaultTimeoutMs: number,
  keepWorkdir: boolean,
  timeoutScale = 1,
): Promise<ScenarioResult> {
  // 拨号那一层的墙钟同乘 —— **设在这里而不是外层循环**，因为 `runScenario`
  // 是所有路径（含单测直接调）的唯一入口，设在别处就会有路径漏掉。
  // 理由见 `local/dial.ts` 的 {@link dialTimeoutScale}。
  setDialTimeoutScale(timeoutScale)

  const base = {
    id: scenario.id,
    dimension: scenario.dimension,
    title: scenario.title,
    target: driver.target,
    expected: scenario.expected,
    knownIssue: scenario.knownIssue,
    requires: scenario.requires,
  } as const

  // 能力差集先算：驱动做不到的事，如实 skip，不要跑一半再假装成功。
  const missing = scenario.requires.filter(c => !driver.capabilities.has(c))
  if (missing.length > 0) {
    return {
      ...base,
      outcome: 'skip',
      durationMs: 0,
      actual: '未执行',
      evidence: [],
      skipReason: `驱动 ${driver.target} 缺少能力: ${missing
        .map(c => {
          const why = driver.capabilityGaps?.get(c)
          return why === undefined ? c : `${c}（${why}）`
        })
        .join('; ')}`,
      driverCalls: [],
    }
  }

  // 场景**只能**经这个代理拿到驱动 —— 「它有没有碰过目标」是自动采集的事实，
  // 不是场景自己申报的。理由见 driverProbe.ts 的头注（issue #61）。
  const probe = instrumentDriver(driver)

  const started = Date.now()
  const cleanups: Array<() => void | Promise<void>> = []
  const logs: string[] = []
  const controller = new AbortController()
  const timeoutMs = Math.round(
    (scenario.timeoutMs ?? defaultTimeoutMs) * timeoutScale,
  )

  let workdir: string
  try {
    workdir = await mkdtemp(join(tmpdir(), 'qm-acc-'))
  } catch (err) {
    return {
      ...base,
      outcome: 'error',
      durationMs: Date.now() - started,
      actual: '无法创建场景临时目录',
      evidence: errorEvidence(err),
      driverCalls: probe.calls(),
    }
  }

  const ctx: ScenarioContext = {
    driver: probe.driver,
    workdir,
    allocPort: freePort,
    cleanup: fn => {
      cleanups.push(fn)
    },
    log: line => {
      logs.push(line)
    },
    signal: controller.signal,
    // 驱动内部的硬等待要乘的就是这个数 —— 见 `ScenarioContext.timeoutScale`。
    // 传的是**倍率**而不是算好的 `timeoutMs`：驱动那些等待各有各的基准（起一个
    // 一次性常驻 vs. 拨一次 health），它们要的是「这台机器慢几倍」，不是「这条
    // 场景还剩多少预算」。
    timeoutScale,
  }

  let outcome: Outcome
  let actual: string
  let evidence: readonly Evidence[]
  let skipReason: string | undefined
  // 「套件够不着目标机」与「被测系统答错了」是两件事（issue #96 ③）。runner
  // 不做分类，只把驱动抛出来的那个标记原样记下 —— 判定的算法一个字不动。
  let errorKind: 'transport' | undefined

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`场景超时（${timeoutMs}ms）`))
      }, timeoutMs)
    })
    const result = await Promise.race([scenario.run(ctx), timeout])
    if (result.skip !== undefined) {
      outcome = 'skip'
      skipReason = result.skip
      actual = '场景自行跳过'
      evidence = result.evidence
    } else {
      outcome = result.ok ? 'pass' : 'fail'
      actual = result.actual
      evidence = result.evidence
    }
  } catch (err) {
    outcome = 'error'
    actual = err instanceof Error ? err.message : String(err)
    evidence = errorEvidence(err)
    if (isTransportError(err)) errorKind = 'transport'
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    controller.abort()
    // 逆序：后登记的资源依赖先登记的（进程依赖目录），先拆后者。
    for (const fn of cleanups.reverse()) {
      try {
        await fn()
      } catch (err) {
        logs.push(
          `cleanup 失败: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
    if (!keepWorkdir) {
      await rm(workdir, { recursive: true, force: true }).catch(() => {})
    }
  }

  const withLogs =
    logs.length === 0
      ? evidence
      : [...evidence, { label: 'log', value: logs.join('\n') }]

  return {
    ...base,
    outcome,
    durationMs: Date.now() - started,
    actual,
    evidence: withLogs,
    // 只在真是那一类时才出现这个键：本地腿从不抛 TransportFailure，那条腿的
    // NDJSON 因此逐字节不变。
    ...(errorKind === undefined ? {} : { errorKind }),
    skipReason,
    driverCalls: probe.calls(),
  }
}

/** 按 id 前缀过滤。空 filter = 全跑。 */
export function selectScenarios(
  scenarios: readonly Scenario[],
  only: readonly string[] | undefined,
): readonly Scenario[] {
  if (only === undefined || only.length === 0) return scenarios
  return scenarios.filter(s => only.some(p => s.id.startsWith(p)))
}

/** 顺序跑完全部场景，返回一轮汇总。 */
export async function runSuite(options: RunOptions): Promise<SuiteRun> {
  const startedAt = new Date().toISOString()
  const selected = selectScenarios(options.scenarios, options.only)
  const results: ScenarioResult[] = []

  for (const scenario of selected) {
    const result = await runScenario(
      scenario,
      options.driver,
      options.timeoutMs ?? DEFAULT_SCENARIO_TIMEOUT_MS,
      options.keepWorkdir === true,
      options.timeoutScale ?? 1,
    )
    results.push(result)
    options.onResult?.(result)
  }

  return summarize(results, {
    target: options.driver.target,
    startedAt,
    finishedAt: new Date().toISOString(),
    commit: options.commit,
    testedProvenance: options.testedProvenance,
  })
}

/**
 * 场景表自检：id 必须唯一、必须有 `dimension` 前缀一致的命名。
 *
 * 单独成函数是为了能在单测分片里跑到 —— 场景表本身写坏（两条同 id）会让
 * NDJSON 的主键失效，而那种错在一次 60 分钟的真跑里才发现太晚了。
 */
export function checkScenarioTable(
  scenarios: readonly Scenario[],
): readonly string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const s of scenarios) {
    if (seen.has(s.id)) problems.push(`重复 id: ${s.id}`)
    seen.add(s.id)
    if (!s.id.startsWith(`${s.dimension}/`)) {
      problems.push(`id 与维度不一致: ${s.id} (dimension=${s.dimension})`)
    }
    if (s.expected.trim() === '') problems.push(`缺少 expected: ${s.id}`)
    if (s.requires.length === 0) problems.push(`未声明 requires: ${s.id}`)
  }
  return problems
}
