// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P7.1 —— 混沌注入跑批。
 *
 *   QIANMO_TRANSPORT_PSK=... bun run demo/lib/chaos-inject.ts --minutes 60
 *
 * 起一套**真的**本地网络：节点 B 的 transport server + 路由层闸门 + 落盘审计 +
 * 备份存储，节点 A 稳定地发任务，外加一个被监督的子进程。然后按固定节拍随机挑一类
 * 注入，看它还能不能继续干活。
 *
 * ## 随机是有种子的
 *
 * 每次跑批打印 `seed`，`--seed <n>` 能原样重放。一条随机跑出来的红色如果第二天
 * 复现不了，它就只是一条传闻——种子是把传闻变成缺陷报告的那一步。
 *
 * ## 四类注入，与确定性用例一一对应
 *
 * `tests/boundary/chaos-recovery.test.ts` 里有它们各自的确定性版本。分工是：那边
 * 防已知失效回归（每次提交都跑），这边找没想到的组合（一小时跑一次）。
 *
 * ## 判据的重心不在「没崩」
 *
 * 什么都不干的一小时同样没有未捕获异常。所以每次注入之后都记「系统又成功处理了
 * 多少条」，一次让系统悄悄停摆的注入必须判红；同时每一条被捕获的失败都要能对上
 * 已知边界，对不上的一条就判不通过。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import { FileSnapshotStore } from '@qianmo/backup'
import { MessageType, createMessage } from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import {
  TransportClient,
  pskFromEnv,
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'
import { emit, intArg } from './cli-args.js'
import {
  INJECTION_KINDS,
  buildChaosReport,
  type CapturedFailure,
  type InjectionKind,
  type InjectionRecord,
} from './chaos-report-core.js'
import { openDiskFullFacility, type DiskFullFacility } from './p51-inject.js'

const PSK = pskFromEnv()
const PLANNER = 'qianmo://node-a/planner'
const REVIEWER = 'qianmo://node-b/reviewer'

const minutes = intArg('minutes', 60)
const intervalSeconds = intArg('interval-seconds', 20)
const seed = intArg('seed', Date.now() % 2_147_483_647)

/**
 * A seeded PRNG (xorshift32) rather than `Math.random`.
 *
 * The point of the seed is on the module header: a red run nobody can replay is
 * a rumour. Same seed, same sequence of injections.
 */
function makeRandom(initial: number): () => number {
  let state = initial === 0 ? 1 : initial
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

/**
 * The known boundaries a captured failure may map onto.
 *
 * Written as substrings of what the system actually says when each boundary is
 * hit. A failure that matches none of them is the interesting one, and the
 * report refuses to pass while any exist.
 */
const KNOWN_BOUNDARIES: readonly {
  readonly name: string
  readonly match: string
}[] = Object.freeze([
  { name: 'transport receipt rejected', match: 'rejected' },
  { name: 'peer unreachable during a cut', match: 'ECONNREFUSED' },
  { name: 'peer unreachable during a cut', match: 'connect' },
  { name: 'peer unreachable during a cut', match: 'ENOENT' },
  { name: 'client closed while draining', match: 'closed' },
  { name: 'send timed out during a cut', match: 'timed out' },
  { name: 'send timed out during a cut', match: 'timeout' },
  { name: 'disk full', match: 'ENOSPC' },
  { name: 'disk full', match: 'no space left' },
  { name: 'loop detected', match: 'E_LOOP' },
  { name: 'rate limited', match: 'E_RATE_LIMITED' },
  { name: 'delivery deadline passed', match: 'E_TTL_EXPIRED' },
])

function classify(summary: string): string | null {
  const lowered = summary.toLowerCase()
  for (const boundary of KNOWN_BOUNDARIES) {
    if (lowered.includes(boundary.match.toLowerCase())) return boundary.name
  }
  return null
}

const root = mkdtempSync(join(tmpdir(), 'qianmo-chaos-'))
const socket = join(root, 'node-b.sock')
const trailPath = join(root, 'audit', 'trail.ndjson')
const trail = new AuditTrail(trailPath)
const store = new FileSnapshotStore({ root: join(root, 'backups') })

const failures: CapturedFailure[] = []
const injections: InjectionRecord[] = []
const skipped: { kind: InjectionKind; reason: string }[] = []
let uncaught = 0
let delivered = 0
let stopping = false

process.on('uncaughtException', error => {
  uncaught += 1
  process.stderr.write(`uncaught: ${String(error)}\n`)
})
process.on('unhandledRejection', reason => {
  uncaught += 1
  process.stderr.write(`unhandled rejection: ${String(reason)}\n`)
})

function capture(error: unknown): void {
  const summary = error instanceof Error ? error.message : String(error)
  failures.push({ at: Date.now(), summary, boundary: classify(summary) })
}

/** Injected clock, so `clock-drift` is a real jump rather than a sleep. */
let clockSkewMs = 0
const now = (): number => Date.now() + clockSkewMs

/** Node B. Restarted whole by the `cut-network` injection. */
function startNodeB(): TransportServerHandle {
  const router = new NodeRouter({
    node: 'node-b',
    now,
    auditSink: event => {
      try {
        trail.append({
          at: event.at,
          source: AuditSource.Router,
          kind: event.type,
          outcome: 'refused',
        })
      } catch (error) {
        capture(error)
      }
    },
  })
  return startTransportServer({
    psk: PSK,
    unix: socket,
    onMessage: message => {
      const verdict = router.inbound(message)
      if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.reason}`)
      delivered += 1
    },
  })
}

/** The supervised child, standing in for the resident's ACP process. */
function startWorker(): ChildProcess {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => process.stdout.write("."), 500)'],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  )
  child.once('exit', () => {
    // The supervisor's whole job: a killed worker comes back. If this stopped
    // happening the run would keep passing the "no exceptions" check while the
    // node quietly had no worker.
    if (!stopping) worker = startWorker()
  })
  return child
}

let server = startNodeB()
let worker = startWorker()
let client = new TransportClient({
  endpoint: { unix: socket },
  node: 'node-a',
  psk: PSK,
  keepAliveIntervalMs: 0,
  backoff: { baseDelayMs: 50, maxDelayMs: 500, jitterRatio: 0.1 },
})

let sent = 0
async function sendOne(): Promise<void> {
  sent += 1
  try {
    await client.sendAndWait(
      createMessage({
        from: PLANNER,
        to: REVIEWER,
        type: MessageType.TaskRequest,
        payload: { round: sent },
        taskId: `chaos-${sent}`,
      }),
      5_000,
    )
  } catch (error) {
    capture(error)
  }
}

async function untilProgress(from: number, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (delivered > from) return Date.now() - (deadline - budgetMs)
    await sendOne()
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return -1
}

const disk: DiskFullFacility = await openDiskFullFacility()
if (!disk.available) {
  skipped.push({
    kind: 'fill-disk',
    reason: disk.reason ?? 'no way to produce a real ENOSPC here',
  })
}

/**
 * Actually fill something, then write to it.
 *
 * The first version of this injection appended one 200-byte audit record to a
 * freshly created 1 MiB volume — which succeeded, every time. An injection that
 * injects nothing is worse than no injection at all: it turns a green report
 * into a false one. So this function insists on **observing** a failure, and
 * records one when the write unexpectedly goes through.
 *
 * The two platforms need different mechanics and it is not worth hiding that:
 *
 * - **Linux**: `/dev/full` returns ENOSPC on any write, no filling needed. It
 *   must not be *read*, though — a read returns zeros forever, which would take
 *   the harness out of memory rather than out of disk.
 * - **macOS**: a 1 MiB disk image, filled with a 4 MiB block first, then a real
 *   snapshot write into a store rooted on it.
 */
async function fillDisk(): Promise<void> {
  const target = disk.targetPath
  if (target === undefined) return
  let observed = false

  if (target === '/dev/full') {
    try {
      writeFileSync(target, Buffer.alloc(4096, 1))
    } catch (error) {
      observed = true
      capture(error)
    }
  } else {
    try {
      writeFileSync(target, Buffer.alloc(4 * 1024 * 1024, 1))
    } catch (error) {
      observed = true
      capture(error)
    }
    // A real component on the full filesystem, not a synthetic write: the
    // backup path is the one that meets a full disk first in practice.
    try {
      await new FileSnapshotStore({ root: join(dirname(target), 'snapshots') })
        .writer()
        .create({
          workspace: root,
          reason: 'scheduled',
          archive: new Uint8Array(256 * 1024),
        })
    } catch (error) {
      observed = true
      capture(error)
    }
  }

  if (!observed) {
    // Unmapped on purpose: this is the harness admitting it did nothing, and
    // the report refuses to pass while any unmapped failure exists.
    failures.push({
      at: Date.now(),
      summary: 'fill-disk injected nothing: the write succeeded',
      boundary: null,
    })
  }
}

async function inject(kind: InjectionKind): Promise<void> {
  const before = delivered
  const at = Date.now()
  switch (kind) {
    case 'kill-worker': {
      worker.kill('SIGKILL')
      break
    }
    case 'cut-network': {
      await server.stop()
      await new Promise(resolve => setTimeout(resolve, 200))
      server = startNodeB()
      break
    }
    case 'fill-disk': {
      await fillDisk()
      break
    }
    case 'clock-drift': {
      // Forward by two minutes: past every gate threshold in the tree, which is
      // the case E4 says a thawing node lives through.
      clockSkewMs += 120_000
      break
    }
  }
  const recoveredInMs = await untilProgress(before, 10_000)
  injections.push({
    kind,
    at,
    progressAfter: delivered - before,
    recoveredInMs,
  })
}

const random = makeRandom(seed)
const endAt = Date.now() + minutes * 60_000
const kinds = INJECTION_KINDS.filter(
  kind => kind !== 'fill-disk' || disk.available,
)

process.stderr.write(
  `chaos: seed=${seed} minutes=${minutes} interval=${intervalSeconds}s kinds=${kinds.join(',')}\n`,
)

try {
  await client.connect(5_000)
  // Prove the system works before breaking it: a run that was broken from the
  // start would otherwise report "no progress" as if chaos had caused it.
  await sendOne()
  if (delivered === 0)
    throw new Error('chaos harness could not deliver a first message')

  // A steady trickle of real traffic underneath the injections.
  const traffic = setInterval(() => {
    void sendOne()
  }, 500)
  traffic.unref?.()

  // A periodic snapshot, so the backup path is under chaos too.
  const snapshots = setInterval(() => {
    void store
      .writer()
      .create({
        workspace: root,
        reason: 'scheduled',
        archive: new Uint8Array([1, 2, 3]),
      })
      .catch(capture)
  }, 5_000)
  snapshots.unref?.()

  // Cover every kind once before going random. Leaving coverage to chance
  // means a short run can miss a kind entirely — which the report correctly
  // fails on, and which would make the length of the run, rather than the
  // system, the thing being tested.
  const queue = [...kinds]
  for (let index = queue.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    const held = queue[index] as InjectionKind
    queue[index] = queue[swap] as InjectionKind
    queue[swap] = held
  }

  while (Date.now() < endAt) {
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1_000))
    if (Date.now() >= endAt) break
    const kind =
      queue.shift() ??
      (kinds[Math.floor(random() * kinds.length)] as InjectionKind)
    await inject(kind)
  }

  clearInterval(traffic)
  clearInterval(snapshots)
} finally {
  stopping = true
  await client.close()
  await server.stop()
  worker.kill('SIGKILL')
  trail.close()
  await disk.cleanup?.()
}

const report = buildChaosReport({
  durationMs: minutes * 60_000,
  seed,
  injections,
  skipped,
  failures,
  uncaught,
  delivered,
  trailIntact: readTrail(trailPath).intact,
})
// The trail itself is kept when the run fails: a chaos report that says
// "something unmapped happened" is only useful next to the lines that happened.
if (report.pass) {
  rmSync(root, { recursive: true, force: true })
} else {
  writeFileSync(
    join(root, 'chaos-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  )
  process.stderr.write(`chaos: evidence kept in ${root}\n`)
}
emit({ ...report })
process.exitCode = report.pass ? 0 : 1
