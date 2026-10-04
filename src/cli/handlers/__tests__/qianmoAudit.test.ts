// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import { StaticPublicKeyDirectory } from '@qianmo/capability'
import { RouterEventType, type RouterAuditEvent } from '@qianmo/router'
import { ActivatorEventType } from '@qianmo/activator'
import { NegotiationEventType } from '@qianmo/negotiation'
import { TunnelEventType } from '@qianmo/tunnel'
import { BackupEventType } from '@qianmo/backup'
import { CapacityEventType } from '@qianmo/capacity'
import {
  AuditWitnessScheduler,
  FileWitnessAnchorStore,
  remoteWitnessAnchorReader,
  remoteWitnessAnchorWriter,
  startWitnessService,
} from '@qianmo/witness'
import {
  QIANMO_AUDIT_HELP_TEXT,
  isQianmoAuditHelpRequest,
  parseQianmoAuditArgs,
  runQianmoAudit,
} from '../qianmoAudit.js'
import {
  activatorTrailSink,
  auditTrailPath,
  backupTrailSink,
  capacityTrailSink,
  negotiationTrailSink,
  routerTrailSink,
  tunnelTrailSink,
} from '../../../services/qianmo/auditTrail.js'
import { loadOrCreateNodeKeys } from '../../../services/qianmo/nodeIdentity.js'

let root: string
let previousConfigDir: string | undefined
const WITNESS_NODE = 'node-a'
const WITNESS_WRITE_TOKEN = 'witness-write-token-for-cli-test'
const WITNESS_READ_TOKEN = 'witness-read-token-for-cli-test'

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write
  let captured = ''
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    captured +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }) as unknown as typeof process.stdout.write
  try {
    await run()
  } finally {
    process.stdout.write = original
  }
  return captured
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'qianmo-audit-cli-'))
  // `CLAUDE_CONFIG_DIR`, not `OCC_CONFIG_DIR`: tests/preload.ts deletes the
  // latter, and occConfigDir() memoizes on both.
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
})

afterEach(() => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  rmSync(root, { recursive: true, force: true })
})

describe('audit CLI arguments', () => {
  test('the trail path comes from the config root, not from $HOME', () => {
    // CLAUDE.md §1.1②: every path is derived, and the audit trail in
    // particular must land under the Qianmo identity's own root.
    expect(auditTrailPath().startsWith(join(root, 'config'))).toBe(true)
    expect(parseQianmoAuditArgs(['--verify']).path).toBe(auditTrailPath())
  })

  test('a query with no criteria is refused rather than dumping the file', () => {
    // The trail grows forever; printing all of it by default is the least
    // useful thing this command could do.
    expect(() => parseQianmoAuditArgs([])).toThrow('at least one of')
  })

  test('--verify alone is a valid query', () => {
    expect(parseQianmoAuditArgs(['--verify']).verify).toBe(true)
  })

  test('--witness is an absolute path or HTTP(S) URL and requires --verify', () => {
    expect(
      parseQianmoAuditArgs(['--verify', '--witness=/tmp/qianmo-witness']),
    ).toMatchObject({ witness: { kind: 'path', value: '/tmp/qianmo-witness' } })
    expect(() =>
      parseQianmoAuditArgs(['--verify', '--witness=relative/witness']),
    ).toThrow('absolute path or http(s) URL')
    expect(() =>
      parseQianmoAuditArgs(['--witness=/tmp/qianmo-witness']),
    ).toThrow('--witness requires --verify')
  })

  test('timestamps accept both ISO and epoch milliseconds', () => {
    const iso = parseQianmoAuditArgs(['--from', '2026-08-14T00:00:00.000Z'])
    expect(iso.from).toBe(Date.parse('2026-08-14T00:00:00.000Z'))
    expect(parseQianmoAuditArgs(['--from', '1800000000000']).from).toBe(
      1_800_000_000_000,
    )
    expect(() => parseQianmoAuditArgs(['--from', 'yesterday'])).toThrow(
      'ISO timestamp',
    )
  })

  test('an unknown flag is refused, not ignored', () => {
    expect(() => parseQianmoAuditArgs(['--trace', 'x', '--all'])).toThrow(
      'unknown audit option',
    )
  })

  test('--limit must be a positive integer', () => {
    expect(parseQianmoAuditArgs(['--verify', '--limit', '5']).limit).toBe(5)
    expect(() => parseQianmoAuditArgs(['--verify', '--limit', '0'])).toThrow(
      'positive integer',
    )
  })
})

describe('audit --verify says which of the two empties it found', () => {
  test('a trail that is not there is absent, and not intact', async () => {
    const previousExitCode = process.exitCode
    try {
      const path = join(root, 'never-written.ndjson')
      const summary = JSON.parse(
        await captureStdout(() => runQianmoAudit(['--verify', '--path', path])),
      )
      expect(summary).toMatchObject({
        records: 0,
        chain: 'absent',
        intact: false,
      })
      // 退出码不动：一条还没建立的链不是一个发现，判成失败会让每台新节点上的
      // 定时任务从第一分钟起报警。
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = previousExitCode
    }
  })

  test('a trail that exists and holds nothing is empty, and intact', async () => {
    const previousExitCode = process.exitCode
    try {
      const path = join(root, 'quiet.ndjson')
      new AuditTrail(path).ensure()
      const summary = JSON.parse(
        await captureStdout(() => runQianmoAudit(['--verify', '--path', path])),
      )
      expect(summary).toMatchObject({
        records: 0,
        chain: 'empty',
        intact: true,
      })
      expect(process.exitCode).toBe(0)
    } finally {
      process.exitCode = previousExitCode
    }
  })
})

describe('audit --verify witness verdict', () => {
  test('keeps a rewritten chain at exit 0 without a witness and exits 1 with it', async () => {
    const path = join(root, 'rewritten.ndjson')
    const trail = new AuditTrail(path)
    for (let index = 0; index < 4; index++) {
      trail.append({
        at: Date.now() + index,
        source: AuditSource.Resident,
        kind: `event-${index + 1}`,
        outcome: index === 1 ? 'refused' : 'ok',
        node: WITNESS_NODE,
      })
    }
    trail.close()

    // This is deliberately the real append-only endpoint, not a fetch stub:
    // the CLI must prove it can compare against evidence outside the trail.
    const keys = loadOrCreateNodeKeys(WITNESS_NODE)
    const service = startWitnessService({
      store: new FileWitnessAnchorStore({ root: join(root, 'witness') }),
      publicKeys: new StaticPublicKeyDirectory([
        [WITNESS_NODE, keys.publicKey],
      ]),
      writeToken: WITNESS_WRITE_TOKEN,
      readToken: WITNESS_READ_TOKEN,
    })
    const scheduler = new AuditWitnessScheduler({
      node: WITNESS_NODE,
      trailPath: path,
      keys,
      writer: remoteWitnessAnchorWriter({
        url: service.url as string,
        token: WITNESS_WRITE_TOKEN,
      }),
    })

    const previousReadToken = process.env.QIANMO_WITNESS_READ_TOKEN
    const previousExitCode = process.exitCode
    try {
      await scheduler.tick()
      const rewritten = join(root, 'rewritten-self-consistent.ndjson')
      const attacked = new AuditTrail(rewritten)
      for (const record of readTrail(path).records.filter(
        record => record.outcome !== 'refused',
      )) {
        const { seq: _seq, prev: _prev, ...input } = record
        attacked.append(input)
      }
      attacked.close()
      writeFileSync(path, readFileSync(rewritten, 'utf8'))
      expect(readTrail(path).intact).toBe(true)

      const local = await captureStdout(() =>
        runQianmoAudit(['--verify', '--path', path]),
      )
      expect(process.exitCode).toBe(0)
      expect(JSON.parse(local)).not.toHaveProperty('witness')

      process.env.QIANMO_WITNESS_READ_TOKEN = WITNESS_READ_TOKEN
      const witnessed = await captureStdout(() =>
        runQianmoAudit([
          '--verify',
          '--path',
          path,
          '--witness',
          service.url as string,
        ]),
      )
      expect(process.exitCode).toBe(1)
      expect(JSON.parse(witnessed)).toMatchObject({
        witness: { tampered: true },
      })
    } finally {
      if (previousReadToken === undefined) {
        delete process.env.QIANMO_WITNESS_READ_TOKEN
      } else {
        process.env.QIANMO_WITNESS_READ_TOKEN = previousReadToken
      }
      process.exitCode = previousExitCode ?? 0
      await service.stop()
    }
  })

  test('an idle trail whose head is anchored is not stale, however old the receipt', async () => {
    const path = join(root, 'idle.ndjson')
    const trail = new AuditTrail(path)
    trail.append({
      at: Date.now(),
      source: AuditSource.Resident,
      kind: 'event',
      outcome: 'ok',
      node: WITNESS_NODE,
    })
    trail.close()
    const keys = loadOrCreateNodeKeys(WITNESS_NODE)
    const store = join(root, 'witness-idle')
    const service = startWitnessService({
      store: new FileWitnessAnchorStore({ root: store }),
      publicKeys: new StaticPublicKeyDirectory([
        [WITNESS_NODE, keys.publicKey],
      ]),
      writeToken: WITNESS_WRITE_TOKEN,
      readToken: WITNESS_READ_TOKEN,
      now: () => Date.now() - 3_600_000,
    })
    const previousExitCode = process.exitCode
    try {
      await new AuditWitnessScheduler({
        node: WITNESS_NODE,
        trailPath: path,
        keys,
        writer: remoteWitnessAnchorWriter({
          url: service.url as string,
          token: WITNESS_WRITE_TOKEN,
        }),
      }).tick()
      const output = await captureStdout(() =>
        runQianmoAudit(['--verify', '--path', path, '--witness', store]),
      )
      expect(process.exitCode).toBe(0)
      expect(JSON.parse(output)).toMatchObject({
        witness: {
          tampered: false,
          stale: false,
          coveredThrough: 1,
          issues: [],
        },
      })
    } finally {
      process.exitCode = previousExitCode ?? 0
      await service.stop()
    }
  })

  test('propagates a remote witness reader deadline instead of waiting forever', async () => {
    const path = join(root, 'witness-timeout.ndjson')
    const trail = new AuditTrail(path)
    trail.append({
      at: Date.now(),
      source: AuditSource.Resident,
      kind: 'event',
      outcome: 'ok',
      node: WITNESS_NODE,
    })
    trail.close()
    loadOrCreateNodeKeys(WITNESS_NODE)
    let aborted = false
    const reader = remoteWitnessAnchorReader({
      url: 'http://witness.test',
      token: WITNESS_READ_TOKEN,
      timeoutMs: 10,
      fetchImpl: ((_input, init) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true
          },
          { once: true },
        )
        return new Promise<Response>(() => {})
      }) as typeof fetch,
    })
    await expect(
      runQianmoAudit(
        ['--verify', '--path', path, '--witness', 'http://witness.test/'],
        { readWitnessAnchors: async () => await reader.list(WITNESS_NODE) },
      ),
    ).rejects.toThrow('timed out after 10 ms')
    expect(aborted).toBe(true)
  })
})

describe('the router sink', () => {
  test('a refusal reaches the trail with its chain keys intact', () => {
    const path = join(root, 'trail.ndjson')
    const trail = new AuditTrail(path)
    const sink = routerTrailSink(trail, 'node-b')
    const event: RouterAuditEvent = {
      type: RouterEventType.LoopDetected,
      at: 1_800_000_000_000,
      detail: {
        traceId: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        taskId: 'task-1',
        msgId: 'msg-1',
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        code: 'E_LOOP',
        hops: 'node-a -> node-b',
      },
    }
    sink(event)
    trail.close()

    const { records, intact } = readTrail(path)
    expect(intact).toBe(true)
    const record = records[0]
    expect(record?.source).toBe(AuditSource.Router)
    // The layer's own event name goes through unchanged — an operator holding a
    // log line should not have to translate it.
    expect(record?.kind).toBe('loop_detected')
    expect(record?.outcome).toBe('refused')
    expect(record?.taskId).toBe('task-1')
    expect(record?.peer).toBe('qianmo://node-a/planner')
    expect(record?.code).toBe('E_LOOP')
    expect(record?.node).toBe('node-b')
  })

  test('a capability denial is filed under the capability layer', () => {
    const path = join(root, 'trail.ndjson')
    const trail = new AuditTrail(path)
    routerTrailSink(
      trail,
      'node-b',
    )({
      type: RouterEventType.CapabilityDenied,
      at: 1,
      detail: { code: 'E_CAP_INSUFFICIENT', taskId: 't' },
    })
    trail.close()
    expect(readTrail(path).records[0]?.source).toBe(AuditSource.Capability)
  })

  test('a trail that cannot be written does not take the node down', () => {
    // Losing the node because its logbook is full would be strictly worse than
    // losing the line.
    const trail = new AuditTrail(join(root, 'nested', 'trail.ndjson'))
    trail.close()
    const sink = routerTrailSink(trail, 'node-b')
    rmSync(root, { recursive: true, force: true })
    expect(() =>
      sink({
        type: RouterEventType.RateLimited,
        at: 1,
        detail: { code: 'E_RATE_LIMITED' },
      }),
    ).not.toThrow()
  })
})

describe('the other four layers', () => {
  test('each layer files under its own source, with its own event name', () => {
    const path = join(root, 'trail.ndjson')
    const trail = new AuditTrail(path)
    activatorTrailSink(
      trail,
      'node-b',
    )({
      type: ActivatorEventType.RequestForwarded,
      at: 1,
      detail: { sandboxName: 'sbx-1', msgId: 'm-1' },
    })
    negotiationTrailSink(
      trail,
      'node-b',
    )({
      type: NegotiationEventType.Offered,
      at: 2,
      detail: { offerId: 'o-1', borrower: 'qianmo://node-a/planner' },
    })
    tunnelTrailSink(
      trail,
      'node-b',
    )({
      type: TunnelEventType.Opened,
      at: 3,
      detail: { offerId: 'o-1', borrower: 'qianmo://node-a/planner' },
    })
    backupTrailSink(
      trail,
      'node-b',
    )({
      type: BackupEventType.SnapshotCreated,
      at: 4,
      detail: { id: 's-1', workspace: '/workspace' },
    })
    trail.close()

    const { records, intact } = readTrail(path)
    expect(intact).toBe(true)
    expect(records.map(record => record.source)).toEqual([
      AuditSource.Activator,
      AuditSource.Negotiation,
      AuditSource.Tunnel,
      AuditSource.Backup,
    ])
    expect(records.map(record => record.kind)).toEqual([
      'request.forwarded',
      'negotiation.offered',
      'tunnel.opened',
      'backup.snapshot-created',
    ])
    expect(records.every(record => record.outcome === 'ok')).toBe(true)
  })

  test('refusals and lapses are told apart', () => {
    // A route that ran out of time was refused by nobody. Calling it a refusal
    // sends the reader looking for a decision that was never made.
    const path = join(root, 'trail.ndjson')
    const trail = new AuditTrail(path)
    const sink = activatorTrailSink(trail, 'node-b')
    sink({
      type: ActivatorEventType.RequestRefused,
      at: 1,
      detail: { code: 'E_UNKNOWN_AGENT' },
    })
    sink({
      type: ActivatorEventType.TaskRouteExpired,
      at: 2,
      detail: { taskId: 't-1' },
    })
    backupTrailSink(
      trail,
      'node-b',
    )({
      type: BackupEventType.MutationDenied,
      at: 3,
      detail: { method: 'DELETE' },
    })
    trail.close()
    expect(readTrail(path).records.map(record => record.outcome)).toEqual([
      'refused',
      'dropped',
      'refused',
    ])
  })

  test('a capacity decision reaches the trail with its lead time intact', () => {
    const path = join(root, 'trail.ndjson')
    const trail = new AuditTrail(path)
    const sink = capacityTrailSink(trail, 'node-b')
    sink({
      type: CapacityEventType.Predicted,
      at: 1_800_000_000_000,
      detail: { windowId: 'cumcm-2026', leadMs: 24_300_000, observed: 30 },
    })
    sink({
      type: CapacityEventType.Suppressed,
      at: 1_800_000_900_000,
      detail: { reason: 'covered-by-calendar', leadMs: 0, observed: 90 },
    })
    trail.close()

    const { records, intact } = readTrail(path)
    expect(intact).toBe(true)
    expect(records.map(record => record.source)).toEqual([
      AuditSource.Capacity,
      AuditSource.Capacity,
    ])
    expect(records.map(record => record.kind)).toEqual([
      'capacity.scale-up-predicted',
      'capacity.scale-up-suppressed',
    ])
    // `dropped`, not `refused`: nobody turned the second one down, a rule held
    // it back. P6.2's DoD is answered by `leadMs` surviving the translation.
    expect(records.map(record => record.outcome)).toEqual(['ok', 'dropped'])
    expect(records[0]?.detail?.['leadMs']).toBe(24_300_000)
  })

  test('the peer is read from whatever each layer calls it', () => {
    const path = join(root, 'trail.ndjson')
    const trail = new AuditTrail(path)
    negotiationTrailSink(
      trail,
      'node-b',
    )({
      type: NegotiationEventType.Leased,
      at: 1,
      detail: { borrower: 'qianmo://node-a/planner' },
    })
    activatorTrailSink(
      trail,
      'node-b',
    )({
      type: ActivatorEventType.WakeStarted,
      at: 2,
      detail: { sandboxName: 'sbx-9' },
    })
    trail.close()
    const records = readTrail(path).records
    expect(records[0]?.peer).toBe('qianmo://node-a/planner')
    // Not a guess: the activator's peer is the sandbox it is waking.
    expect(records[1]?.peer).toBe('sbx-9')
  })
})

describe('audit --help', () => {
  test('answers --help and -h wherever they appear on the line', () => {
    // 「敲到一半发现忘了选项名」是人真会做的事，所以位置不限。
    expect(isQianmoAuditHelpRequest(['--help'])).toBe(true)
    expect(isQianmoAuditHelpRequest(['-h'])).toBe(true)
    expect(isQianmoAuditHelpRequest(['--verify', '--help'])).toBe(true)
    expect(isQianmoAuditHelpRequest(['--verify'])).toBe(false)
    expect(isQianmoAuditHelpRequest([])).toBe(false)
    // 当成某个选项的值写进去的不算——那是一个值，不是一次请求。
    expect(isQianmoAuditHelpRequest(['--trace=--help'])).toBe(false)
  })

  test('documents every option the parser actually dispatches on', () => {
    // 反漂移：选项名的唯一出处是解析器的分派链，帮助文本是它的投影。新增一个
    // 选项却忘了写进帮助，这条会红——而不是等到内测用户问「还有别的参数吗」。
    const source = readFileSync(
      new URL('../qianmoAudit.ts', import.meta.url),
      'utf8',
    )
    const dispatched = [...source.matchAll(/arg === '(--[a-z-]+)'/g)].map(
      match => match[1] as string,
    )
    // 分派链的形状变了（比如改成表驱动）也要在这里被发现，否则这条测试会安静
    // 地变成一个零断言的空转。9 个解析选项加 `--help` 自己那一次全等比较。
    expect(dispatched.length).toBeGreaterThanOrEqual(10)
    for (const option of new Set(dispatched)) {
      expect(QIANMO_AUDIT_HELP_TEXT).toContain(option)
    }
  })

  test('says a query needs a criterion, which is the first thing people hit', () => {
    // 不给条件是这个解析器抛的第一件事（`at least one of`），所以帮助必须在
    // 选项表**之前**就把那五个加 --verify 说清楚。
    const preamble = QIANMO_AUDIT_HELP_TEXT.slice(
      0,
      QIANMO_AUDIT_HELP_TEXT.indexOf('Options ('),
    )
    for (const flag of ['--trace', '--agent', '--task', '--from', '--to']) {
      expect(preamble).toContain(flag)
    }
    expect(preamble).toContain('--verify')
  })

  test('says --verify exits 1 on a broken chain and that payloads are never printed', () => {
    // 退出码是这条命令能进 cron 的全部理由；不打 payload 是它的安全承诺。
    expect(QIANMO_AUDIT_HELP_TEXT).toContain('exit 1')
    expect(QIANMO_AUDIT_HELP_TEXT).toContain('payloads are never')
    expect(QIANMO_AUDIT_HELP_TEXT).toContain(
      '<config root>/qianmo/audit/trail.ndjson',
    )
    expect(QIANMO_AUDIT_HELP_TEXT.endsWith('\n')).toBe(true)
  })

  test('the unknown-option error points at the help', () => {
    // 走到那一支的人多半是拼错了选项名，所以顺手指一下那张表在哪。
    expect(() => parseQianmoAuditArgs(['--verfiy'])).toThrow(
      'unknown audit option --verfiy',
    )
    expect(() => parseQianmoAuditArgs(['--verfiy'])).toThrow('audit --help')
  })
})
