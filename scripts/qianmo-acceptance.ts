#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌端到端验收套件 —— 可执行入口。
 *
 * ```
 * bun run scripts/qianmo-acceptance.ts [--target local|fleet] [--only <前缀>…]
 *                                      [--out <目录>] [--timeout-ms <n>]
 *                                      [--timeout-scale <n>]
 *                                      [--list] [--keep-workdir]
 * ```
 *
 * 输出两份：
 *   · `<out>/results.ndjson` —— 机器可读，**边跑边写**：首行 `kind:"start"`、
 *     一条结果一行、跑完追加末行 `kind:"summary"`。被打断的一轮因此仍然留下
 *     前面那些结果，代价是那份文件**没有末行**——「跑完了没有」怎么读见
 *     `report-core.ts` 里 `ndjsonStartLine` 的头注（issue #85）；
 *   · `<out>/SUMMARY.txt` + stdout —— 人可读汇总表，红的行带证据原文。
 *     这一份只有跑完才有，它本来就是全轮汇总。
 *
 * **两个 commit，别读串了**（issue #70）：`commit` 是**跑套件那台机器**的检出，
 * `testedCommit` / `testedUnits` 是**被测端自己报上来的**。`--target fleet` 时
 * 被测的是远端节点上的产物，两者可以毫无关系；拿不到时那一栏写「未知」，**不会**
 * 回退成本地 HEAD。`--target local` 上后两个键根本不出现 —— 那条腿被测的就是这
 * 棵检出。
 *
 * 退出码：0 = 无 fail 无 error **且至少有一条场景真正调用过驱动**（skip 不影响）；
 * 1 = 有红，或者这一轮一条都没碰过被测目标；2 = 用法错。
 *
 * 最后那半句是 issue #61 的产物：真机腿曾经在驱动零调用的情况下报出
 * `pass=11 fail=0 skip=104` 与 exit 0。全绿与没跑必须给出不同的退出码。
 *
 * ## 为什么是一条独立入口，而不是一个 `.test.ts`
 *
 * `scripts/test-shards.sh` 那 62 个分片是**单元测试**的执行体：一个 `bun test`
 * 进程跑完一整个目录，靠目录隔离 mock 状态。这套件与它在三处不相容：
 *
 * ① **它要起真进程。** 每条场景 fork 一个 `qm resident`（外加它自己的 ACP
 *    子进程），跑满一遍要**十几分钟**。塞进分片会把一次 CI 从几分钟拖到半
 *    小时以上，而分片的设计前提正是「每格都快」。
 * ② **它要占 TCP 端口与真文件系统。** 分片之间是并行安全的纯内存单元测试，
 *    往里塞一个抢端口的成员，失败会以「别的分片偶发红」的形态出现 —— 那正是
 *    这仓库花了 55 次连红才治好的病。
 * ③ **它的红是产品结论，不是构建结论。** 已知缺陷（如 #44）就该红着，而分片
 *    是合并门禁：一条永远红的门禁等于没有门禁，两轮之后就会被人加豁免。
 *
 * 判定层与场景表的**纯逻辑**另有单测，落在 `demo/lib/acceptance/__tests__/`，
 * 由 `demo/lib` 那一格分片带跑 —— 于是「判定规则被改松了」「场景表里有重复
 * id」这类退化仍然有 CI 护栏。
 *
 * ## 但「不进分片」不等于「不进 CI」
 *
 * 上面三条反对的是**混进单元测试分片**，不是不接线。本地腿现在有自己的 job：
 * `.github/workflows/ci.yml` 的 `acceptance-local`，与 `ci` 并行，跑的就是这条
 * 命令。理由很直接 —— PR #63 加的那道防假绿自保护（全绿但零驱动调用要 exit 1）
 * 此前**只在有人手动跑时才响**，而它挡的正是「没人看的时候悄悄变成假绿」。
 *
 * 真机腿进不了 GitHub CI（四台 VPS + SSH 隧道 + 生产 PSK），也不该进：把那套
 * 凭据放进 CI 是拿一条验收腿去换一个长期泄密面。它仍然是手动跑的。
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  ndjsonScenarioLine,
  ndjsonStartLine,
  ndjsonSummaryLine,
  renderSummary,
  testedCommitStamp,
} from '../demo/lib/acceptance/report-core.js'
import { ALL_SCENARIOS } from '../demo/lib/acceptance/registry.js'
import {
  checkScenarioTable,
  DEFAULT_SCENARIO_TIMEOUT_MS,
  FLEET_TIMEOUT_SCALE,
  runSuite,
  selectScenarios,
} from '../demo/lib/acceptance/runner.js'
import { LocalDriver } from '../demo/lib/acceptance/local/driver.js'
import {
  FleetDriver,
  fleetConfigFromEnv,
} from '../demo/lib/acceptance/fleet/driver.js'
import type {
  AcceptanceDriver,
  ScenarioResult,
  TestedProvenance,
} from '../demo/lib/acceptance/types.js'

const USAGE = `阡陌端到端验收套件

  bun run scripts/qianmo-acceptance.ts [选项]

选项
  --target local|fleet   验收目标，默认 local
  --only <前缀>          只跑 id 以此开头的场景，可重复（如 --only handshake/ --only audit/）
  --out <目录>           产物目录，默认 ~/qianmo-acceptance/<UTC 时间戳>
  --timeout-ms <n>       单场景默认超时，默认 ${DEFAULT_SCENARIO_TIMEOUT_MS}
                         （--target fleet 时全部超时另乘 ${FLEET_TIMEOUT_SCALE}，见 runner.ts）
  --timeout-scale <n>    全部超时（默认值、场景自报的、驱动内部的等待）乘这个正数，
                         慢机器用；显式给了就压过 --target fleet 的默认 ${FLEET_TIMEOUT_SCALE}
  --keep-workdir         保留每个场景的临时目录，便于排查
  --list                 只列出场景表，不执行
  -h, --help             本页

退出码：0 全绿且真的碰过目标（skip 不影响）· 1 有 fail/error 或本轮零触达 · 2 用法错
`

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function value(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function values(name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}`) {
      const next = process.argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) out.push(next)
    }
  }
  return out
}

/**
 * 这一轮的真机驱动 —— 只为收尾（issue #100）。
 *
 * SSH 复用的 master 是**到生产机的活会话**，一轮结束必须逐台 `ssh -O exit`
 * 拆掉，不能靠 `ControlPersist` 超时。它比任何单条场景活得都长，所以拆它的地方
 * 只能在这一层：`finally`（含场景抛异常、超时、判定失败）、信号处理器
 * （Ctrl-C）、以及 `process.on('exit')` 那条最后防线。
 *
 * 本地腿上它恒为 undefined，那条腿因此逐字节不变。
 */
let fleetDriver: FleetDriver | undefined

async function main(): Promise<number> {
  if (flag('help') || process.argv.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }

  // 场景表自检先跑：两条同 id 会让 NDJSON 的主键失效，而那种错在一次
  // 十几分钟的真跑之后才发现太晚。
  const problems = checkScenarioTable(ALL_SCENARIOS)
  if (problems.length > 0) {
    process.stderr.write(`场景表有问题:\n${problems.join('\n')}\n`)
    return 2
  }

  if (flag('list')) {
    for (const scenario of ALL_SCENARIOS) {
      process.stdout.write(
        `${scenario.id}\t${scenario.dimension}\t${scenario.title}` +
          `${scenario.knownIssue === undefined ? '' : `\t[${scenario.knownIssue}]`}\n`,
      )
    }
    process.stdout.write(`\n共 ${ALL_SCENARIOS.length} 条场景\n`)
    return 0
  }

  const target = value('target') ?? 'local'
  let driver: AcceptanceDriver
  if (target === 'local') {
    driver = new LocalDriver()
  } else if (target === 'fleet') {
    fleetDriver = new FleetDriver(fleetConfigFromEnv())
    driver = fleetDriver
    // Ctrl-C 与 `kill` 也要拆 master：被打断的那一轮同样在生产机上留着会话。
    // **不在这里写 NDJSON 末行** —— 那一行的含义是「这一轮完整」，见文件头。
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void (async () => {
          await fleetDriver?.dispose()
          process.exit(signal === 'SIGINT' ? 130 : 143)
        })()
      })
    }
    // 最后防线：`process.exit()` 与正常退出都会走到它，而那时候 `await` 不管用。
    // 正常路径已经在 `finally` 里拆过了，到这里是空转。
    process.once('exit', () => {
      fleetDriver?.disposeSync()
    })
    process.stderr.write(
      '注意：真机腿的拨号走 H 上的隧道口 38631–38634。' +
        '不在 H 上跑就先把 `ssh -N -L 3863x:127.0.0.1:3863x <H>` 起起来，' +
        '或用 QIANMO_ACCEPTANCE_DIAL_HOST / QIANMO_ACCEPTANCE_ENDPOINT_<节点> 改道。\n',
    )
  } else {
    process.stderr.write(`未知 --target ${target}\n${USAGE}`)
    return 2
  }

  const outDir =
    value('out') ??
    join(
      homedir(),
      'qianmo-acceptance',
      new Date().toISOString().replaceAll(':', '-').replace(/\..*$/, 'Z'),
    )
  mkdirSync(outDir, { recursive: true, mode: 0o700 })

  const only = values('only')
  const timeoutRaw = value('timeout-ms')
  const timeoutMs =
    timeoutRaw === undefined ? undefined : Number.parseInt(timeoutRaw, 10)

  // 倍率而不是「慢机器统一给一个大数」：87/115 条场景自报了 30 s–300 s 的预算，
  // 那是作者定的**相对**关系（有的本来就要等两轮模型）。`--timeout-ms` 只动
  // 剩下那 28 条走默认值的，压不动自报的那些；统一压平又会让本该快的在挂死时
  // 也拖满。理由与 `FLEET_TIMEOUT_SCALE` 逐字相同，只是慢的原因换成了「共享
  // runner」而不是「每步多一次 SSH 往返」。
  //
  // 为什么这条旋钮必须有：场景里的毫秒数按开发机写，而超时记的是 `error` 而
  // 不是 `fail` —— 一条本来会绿的场景在慢机器上变成「套件自己炸了」，既不算
  // 覆盖也不指向任何产品问题。CI 上那是纯噪声，且是会被当作「套件不稳」而
  // 加豁免的那种噪声。
  const scaleRaw = value('timeout-scale')
  const scaleOverride =
    scaleRaw === undefined ? undefined : Number.parseFloat(scaleRaw)
  if (
    scaleOverride !== undefined &&
    (!Number.isFinite(scaleOverride) || scaleOverride <= 0)
  ) {
    process.stderr.write(`--timeout-scale 要一个正数，收到 ${scaleRaw}\n`)
    return 2
  }
  // 显式给的压过 fleet 默认：真机腿在更慢的机器上跑时得能再放大一档。
  const timeoutScale =
    scaleOverride ?? (target === 'fleet' ? FLEET_TIMEOUT_SCALE : undefined)

  // 这是**跑套件那台机器**的检出提交 —— 只回答「套件是哪一版」。
  // `target=fleet` 时被测的是远端节点上的产物，与它可以毫无关系；那个问题的
  // 答案在下面的 `testedProvenance` 里，两个值分别记（issue #70）。
  const commit = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'])
    .stdout.toString()
    .trim()

  // 被测端自报的来源 commit。**在场景循环之前采**，因为它要进 NDJSON 的首行 ——
  // 一轮被打断的跑只剩那一行，而「刚才测的是哪一版」正是那时候最想知道的。
  //
  // 本地驱动**不实现**这个探针，于是 `target=local` 上它恒为 undefined，产物
  // 与汇总表逐字节不变：那条腿被测的就是这棵检出，`commit` 已经答完了。
  //
  // 探针抛了也不能让整轮跑不起来，更不能悄悄回退成上面那个 `commit` —— 回退
  // 正是这条缺陷本身。抛出的原文原样记成一条「问不到」的观察，报告里那一栏
  // 因此写「未知」。
  let testedProvenance: TestedProvenance | undefined
  try {
    testedProvenance = await driver.testedProvenance?.()
  } catch (err) {
    testedProvenance = {
      units: [
        {
          unit: `${target} 被测端`,
          detail: `采集来源 commit 时抛出：${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    }
  }

  process.stdout.write(
    `阡陌端到端验收套件 · target=${target} · 场景 ${
      only.length === 0 ? ALL_SCENARIOS.length : `匹配 ${only.join(' ')}`
    } · 产物 ${outDir}\n`,
  )
  // 开跑就把「被测的是哪一版」打出来，而不是只写进两小时后的汇总表：这一行
  // 存在的意义是让操作者在**等待开始之前**发现「舰队上还是上一版」，那时候
  // 改主意只花一秒钟。
  if (testedProvenance !== undefined) {
    process.stdout.write(
      `被测端 ${testedCommitStamp(testedProvenance)} · 套件 ${commit}\n` +
        testedProvenance.units
          .map(u => `  ${u.unit}: ${u.commit ?? `未知（${u.detail}）`}\n`)
          .join(''),
    )
  }
  process.stdout.write('\n')

  const mark: Record<ScenarioResult['outcome'], string> = {
    pass: 'PASS',
    fail: 'FAIL',
    skip: 'SKIP',
    error: ' ERR',
  }

  // ------------------------------------------------------------------------
  // 产物是**流式**落盘的：开跑写首行，每出一条结果追加一行，跑完追加末行。
  //
  // 以前这里是「跑完之后 `writeFileSync` 一次」。真机腿一轮两个多小时，中途
  // 被打断（后台任务上限、工具超时、Ctrl-C、机器掉线）就等于整轮零产物 ——
  // 前面那几十条结果只存在于终端 log 里。这不是假设：补 CA 覆盖那一轮跑到
  // 第 84/115 条被杀，NDJSON 全丢，只能按维度切 4 段重跑（issue #85）。
  //
  // append 而不是「每次重写整份」：结果里带着证据原文，重写 115 次是 O(n²)
  // 的写放大，而且**被杀在重写中途会把已有的结果也毁掉** —— 那比不写还糟。
  //
  // 首行的作用见 `ndjsonStartLine` 的头注：被打断的文件没有末行，而「缺末行」
  // 不能是唯一信号，否则只是把「零产物」换成了另一种静默。
  // ------------------------------------------------------------------------
  const ndjsonPath = join(outDir, 'results.ndjson')
  const startedAt = new Date().toISOString()
  writeFileSync(
    ndjsonPath,
    `${ndjsonStartLine({
      target: driver.target,
      startedAt,
      commit,
      ...(testedProvenance === undefined ? {} : { testedProvenance }),
      planned: selectScenarios(ALL_SCENARIOS, only).length,
    })}\n`,
    { mode: 0o600 },
  )

  const run = await runSuite({
    driver,
    scenarios: ALL_SCENARIOS,
    ...(only.length === 0 ? {} : { only }),
    ...(timeoutMs === undefined || Number.isNaN(timeoutMs)
      ? {}
      : { timeoutMs }),
    // 真机腿每一步都多一次 SSH 往返，场景里那些毫秒数是按本地腿写的。
    // 见 `FLEET_TIMEOUT_SCALE` 的注释：不放大的话红的会是 `error`（套件自己
    // 炸了），而不是那条场景本来要说的话。`--timeout-scale` 压过它。
    ...(timeoutScale === undefined ? {} : { timeoutScale }),
    keepWorkdir: flag('keep-workdir'),
    commit,
    ...(testedProvenance === undefined ? {} : { testedProvenance }),
    onResult: result => {
      // 落盘先于打印：终端那一行是给人看进度的，产物那一行是这一轮唯一
      // 会留下来的东西，被打断时先保住后者。
      appendFileSync(ndjsonPath, `${ndjsonScenarioLine(result)}\n`)
      process.stdout.write(
        `${mark[result.outcome]}  ${result.id}  (${(result.durationMs / 1000).toFixed(1)}s)` +
          `${result.knownIssue === undefined ? '' : `  [${result.knownIssue}]`}\n`,
      )
    },
  })

  const summaryPath = join(outDir, 'SUMMARY.txt')
  const summary = renderSummary(run)
  // 末行只有跑完了才落地 —— 它的存在就是「这一轮完整」的判据，别把它挪到
  // 任何可能在半路执行的地方（`finally`、信号处理器）。
  appendFileSync(ndjsonPath, `${ndjsonSummaryLine(run)}\n`)
  writeFileSync(summaryPath, summary, { mode: 0o600 })

  process.stdout.write(`\n${summary}\n`)
  process.stdout.write(`机器可读: ${ndjsonPath}\n人可读:   ${summaryPath}\n`)
  return run.pass ? 0 : 1
}

try {
  process.exitCode = await main()
} finally {
  // 收尾与「这一轮判成什么」无关，所以它在 `finally` 里而不是 `main` 末尾：
  // 场景抛异常、超时、判定失败，每一条路径都要把到生产机的会话拆干净。
  await fleetDriver?.dispose()
}
