// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  CapabilityLevel,
  createMessage,
  MessageType,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
} from '@qianmo/protocol'
import {
  generateNodeKeyPair,
  StaticPublicKeyDirectory,
  type ShadowRefusal,
  type ShadowRefusalSink,
} from '@qianmo/capability'
import {
  DEFAULT_RESIDENT_MEM_INTERVAL_MS,
  MAX_PENDING_TIMING_EVENTS,
  RESIDENT_HELP_TEXT,
  assertResidentRuntime,
  createResidentCapabilities,
  createResidentMemWriter,
  createResidentTimingWriter,
  formatResidentError,
  isResidentHelpRequest,
  parseResidentArgs,
  residentPriorLifeLine,
  residentTrustedIssuers,
  warnMissingModelCredentials,
  warnUnselectedTaskPolicy,
} from '../resident.js'

const BASE = [
  '--node',
  'node-b',
  '--team',
  'atlas',
  '--agent',
  'reviewer=/workspace',
  '--port',
  '7321',
  '--hostname',
  '127.0.0.1',
] as const

describe('resident CLI configuration', () => {
  test('fails closed outside the Bun runtime', () => {
    expect(() => assertResidentRuntime(false)).toThrow(
      'requires the Bun runtime',
    )
    expect(() => assertResidentRuntime(true)).not.toThrow()
  })

  test('requires the Qianmo identity and preserves explicit exposure choices', () => {
    expect(parseResidentArgs(BASE, 'qianmo')).toEqual({
      node: 'node-b',
      team: 'atlas',
      agents: [{ agent: 'reviewer', cwd: '/workspace' }],
      port: 7321,
      hostname: '127.0.0.1',
      // Capability defaults: trust nobody but itself, and admit unsigned work
      // (P4.3 — `packages/capability/src/policy.ts` says why the M0 default is
      // permissive about *requiring* a token while still verifying every one
      // that is presented).
      trusted: [],
      // The default since P12.4 (key-distribution.md §9.2 ②). It used to be
      // `false`, and the comment here used to explain why — that reason
      // (M0 had no key distribution) is what P12.1~P12.3 removed.
      requireSignedTasks: true,
      // Observation mode is off unless asked for, and it is a *second*
      // switch rather than a mode of the first (§9.2 phase ①).
      auditSignedTasks: false,
    })
    expect(() => parseResidentArgs(BASE, 'occ')).toThrow('OCC_IDENTITY=qianmo')
  })

  test('never guesses a TCP hostname or listener', () => {
    expect(() =>
      parseResidentArgs(
        BASE.filter(arg => arg !== '--hostname' && arg !== '127.0.0.1'),
        'qianmo',
      ),
    ).toThrow('explicit --hostname')
    expect(() => parseResidentArgs(BASE.slice(0, 6), 'qianmo')).toThrow(
      'requires --port or --unix',
    )
  })

  test('requires absolute cwd and unique safe agent names', () => {
    expect(() =>
      parseResidentArgs(
        BASE.map(arg =>
          arg === 'reviewer=/workspace' ? 'reviewer=relative' : arg,
        ),
        'qianmo',
      ),
    ).toThrow('cwd must be absolute')
    expect(() =>
      parseResidentArgs([...BASE, '--agent', 'reviewer=/other'], 'qianmo'),
    ).toThrow('unique')
  })

  test('accepts explicit host activity and timing endpoints', () => {
    expect(
      parseResidentArgs(
        [...BASE, '--activity-url=ws://host.internal:7331'],
        'qianmo',
      ),
    ).toMatchObject({
      activityUrl: 'ws://host.internal:7331/',
      activityReconnectFactor: 1.1,
    })
    expect(
      parseResidentArgs(
        [
          ...BASE,
          '--activity-url=ws://host.internal:7331',
          '--activity-reconnect-factor=1.1',
          '--timings=/tmp/resident-timings.jsonl',
        ],
        'qianmo',
      ),
    ).toMatchObject({
      activityUrl: 'ws://host.internal:7331/',
      activityReconnectFactor: 1.1,
      timings: '/tmp/resident-timings.jsonl',
    })
    expect(() =>
      parseResidentArgs(
        [...BASE, '--activity-url=http://host.internal'],
        'qianmo',
      ),
    ).toThrow('must use ws or wss')
    expect(() =>
      parseResidentArgs([...BASE, '--timings=relative.jsonl'], 'qianmo'),
    ).toThrow('absolute path')
    expect(() =>
      parseResidentArgs([...BASE, '--activity-reconnect-factor=1.1'], 'qianmo'),
    ).toThrow('requires --activity-url')
    expect(() =>
      parseResidentArgs(
        [
          ...BASE,
          '--activity-url=ws://host.internal:7331',
          '--activity-reconnect-factor=1',
        ],
        'qianmo',
      ),
    ).toThrow('greater than 1')
  })

  test('accepts an absolute unix socket without TCP options', () => {
    expect(
      parseResidentArgs(
        [
          '--node=node-b',
          '--team=atlas',
          '--agent=reviewer=/workspace',
          '--unix=/tmp/qianmo-resident.sock',
        ],
        'qianmo',
      ),
    ).toMatchObject({ unix: '/tmp/qianmo-resident.sock' })
  })

  test('takes a memory sampling path and defaults its interval (P7.3)', () => {
    expect(
      parseResidentArgs([...BASE, '--mem-sample=/abs/mem.ndjson'], 'qianmo'),
    ).toMatchObject({
      memSample: '/abs/mem.ndjson',
      memIntervalMs: DEFAULT_RESIDENT_MEM_INTERVAL_MS,
    })
    expect(
      parseResidentArgs(
        [
          ...BASE,
          '--mem-sample',
          '/abs/mem.ndjson',
          '--mem-interval-ms',
          '5000',
        ],
        'qianmo',
      ),
    ).toMatchObject({ memSample: '/abs/mem.ndjson', memIntervalMs: 5_000 })
  })

  test('refuses memory sampling options that would silently lose evidence', () => {
    // Same shape as `--timings`: a relative path would land somewhere that
    // depends on the resident's cwd, which is not where the operator looked.
    expect(() =>
      parseResidentArgs([...BASE, '--mem-sample=relative.ndjson'], 'qianmo'),
    ).toThrow('absolute path')
    // An interval with no path samples into nowhere.
    expect(() =>
      parseResidentArgs([...BASE, '--mem-interval-ms=5000'], 'qianmo'),
    ).toThrow('requires --mem-sample')
    // Sub-second sampling of a 24 h run is a way to fill a disk, not a baseline.
    expect(() =>
      parseResidentArgs(
        [...BASE, '--mem-sample=/abs/mem.ndjson', '--mem-interval-ms=500'],
        'qianmo',
      ),
    ).toThrow('integer >= 1000')
  })

  test('bounds memory samples on the same queue and reports overflow once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-mem-overflow-'))
    const path = join(directory, 'mem.ndjson')
    const errors: unknown[] = []
    const writer = createResidentMemWriter(path, error => errors.push(error))
    try {
      for (let at = 0; at < MAX_PENDING_TIMING_EVENTS + 10; at++) {
        writer.write({
          at,
          rss: 1,
          heapSize: 1,
          heapCapacity: 1,
          objectCount: 1,
          uptime: 1,
        })
      }

      await writer.close()

      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(
        MAX_PENDING_TIMING_EVENTS,
      )
      // Its own message, so a reader of the log knows which writer overflowed.
      expect(errors.map(String)).toEqual([
        'Error: resident memory writer queue overflow',
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('flushes timing evidence in order on close', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-timing-writer-'))
    const path = join(directory, 'timings.jsonl')
    const errors: unknown[] = []
    const writer = createResidentTimingWriter(path, error => errors.push(error))
    try {
      writer.write({
        stage: 'acp_ready',
        at: 1,
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      })
      writer.write({
        stage: 'acp_ready',
        at: 2,
        sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      })

      await writer.close()

      expect(
        readFileSync(path, 'utf8')
          .trim()
          .split('\n')
          .map(line => JSON.parse(line).at),
      ).toEqual([1, 2])
      expect(errors).toEqual([])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('bounds timing evidence queued in one turn and reports overflow once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-timing-overflow-'))
    const path = join(directory, 'timings.jsonl')
    const errors: unknown[] = []
    const writer = createResidentTimingWriter(path, error => errors.push(error))
    try {
      for (let at = 0; at < MAX_PENDING_TIMING_EVENTS + 10; at++) {
        writer.write({
          stage: 'acp_ready',
          at,
          sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        })
      }

      await writer.close()

      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(
        MAX_PENDING_TIMING_EVENTS,
      )
      expect(errors.map(String)).toEqual([
        'Error: resident timing writer queue overflow',
      ])
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('--allow-workspace-edits', () => {
  test('缺省不给，因为放宽姿态不该由默认值决定', () => {
    // 与任务策略两个开关同一条理由（issue #10）：省掉它，这台节点能不能干活就由
    // 「跑的是哪一版产物」决定，而故障要等到第一次真用时才出现。
    expect(
      parseResidentArgs(BASE, 'qianmo').allowWorkspaceEdits,
    ).toBeUndefined()
  })

  test('给了才有，且只影响这一个字段', () => {
    const config = parseResidentArgs(
      [...BASE, '--allow-workspace-edits'],
      'qianmo',
    )

    expect(config.allowWorkspaceEdits).toBe(true)
    // 它是权限姿态，不是任务策略——两者互不牵连。
    expect(config.taskPolicySelected).toBeUndefined()
  })
})

describe('capability flags (P4.3)', () => {
  const KEY = 'A'.repeat(43)
  const unsignedTask = createMessage({
    from: 'qianmo://node-a/planner',
    to: 'qianmo://node-b/reviewer',
    type: MessageType.TaskRequest,
    payload: { ask: 'review the diff' },
    taskId: 'task-1',
    createdAt: Date.now(),
  })

  test('--trust takes <node>=<publicKey> and refuses anything else', () => {
    const parsed = parseResidentArgs(
      [...BASE, '--trust', `node-a=${KEY}`],
      'qianmo',
    )
    expect(parsed.trusted).toEqual([['node-a', KEY]])
    expect(() =>
      parseResidentArgs([...BASE, '--trust', 'node-a'], 'qianmo'),
    ).toThrow('<node>=<publicKey>')
    expect(() =>
      parseResidentArgs([...BASE, '--trust', 'node-a=short'], 'qianmo'),
    ).toThrow('not a valid Ed25519 key')
  })

  test('--trust refuses two different keys for one node, and names it', () => {
    // The failure this replaces did not look like a command-line mistake:
    // last-write-wins left every check *before* the signature passing, so
    // correctly minted tokens came back `capability signature does not
    // verify` and the search went into the Ed25519 path (issue #53).
    const other = generateNodeKeyPair().publicKey
    let thrown: unknown
    try {
      parseResidentArgs(
        [...BASE, '--trust', `node-a=${KEY}`, '--trust', `node-a=${other}`],
        'qianmo',
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(Error)
    const message = thrown instanceof Error ? thrown.message : ''
    // The three facts an operator needs: which flag, which node, how many.
    expect(message).toContain('--trust')
    expect(message).toContain('node-a')
    expect(message).toContain('2 times')
    // A third conflicting entry is counted, not just the pair that tripped it.
    expect(() =>
      parseResidentArgs(
        [
          ...BASE,
          '--trust',
          `node-a=${KEY}`,
          '--trust',
          `node-a=${other}`,
          '--trust',
          `node-a=${KEY}`,
        ],
        'qianmo',
      ),
    ).toThrow('3 times')
    // A different node with a different key is not a conflict at all.
    expect(
      parseResidentArgs(
        [...BASE, '--trust', `node-a=${KEY}`, '--trust', `node-c=${other}`],
        'qianmo',
      ).trusted,
    ).toEqual([
      ['node-a', KEY],
      ['node-c', other],
    ])
  })

  test('--trust twice with the same key is idempotent, not a conflict', () => {
    // Two places agreeing is a list stitched together, not a contradiction —
    // refusing it would push deduplication onto every caller for no gain.
    const parsed = parseResidentArgs(
      [...BASE, '--trust', `node-a=${KEY}`, '--trust', `node-a=${KEY}`],
      'qianmo',
    )
    expect(parsed.trusted).toEqual([
      ['node-a', KEY],
      ['node-a', KEY],
    ])
    // And the directory built from them answers with that one key.
    expect(
      new StaticPublicKeyDirectory(parsed.trusted).publicKeyOf('node-a'),
    ).toBe(KEY)
  })

  test('signed tasks are required by default; --open-policy is the way out', () => {
    // 这条原本钉的是**旧默认**（P4.3 时 `OPEN_POLICY`，因为当时没有密钥分发）。
    // P12.1~P12.3 把分发建起来之后，`policy.ts` 的收敛条件成立，默认于 P12.4
    // 翻面（key-distribution.md §9.2 ②）。断言的两半都还在，只是方向对调，
    // 外加逃生开关那一半。
    expect(parseResidentArgs(BASE, 'qianmo').requireSignedTasks).toBe(true)
    expect(
      parseResidentArgs([...BASE, '--require-signed-tasks'], 'qianmo')
        .requireSignedTasks,
    ).toBe(true)
    expect(
      parseResidentArgs([...BASE, '--open-policy'], 'qianmo')
        .requireSignedTasks,
    ).toBe(false)
  })

  test('the policy provenance is recorded separately from the policy', () => {
    // 姿态与「谁选的姿态」是两个问题：默认值翻过一次（P12.4），所以「命令行上
    // 一个开关都没有」本身是要说出来的事实，而不是与 requireSignedTasks 同义。
    expect(parseResidentArgs(BASE, 'qianmo').taskPolicySelected).toBeUndefined()
    expect(
      parseResidentArgs([...BASE, '--open-policy'], 'qianmo')
        .taskPolicySelected,
    ).toBe(true)
    expect(
      parseResidentArgs([...BASE, '--require-signed-tasks'], 'qianmo')
        .taskPolicySelected,
    ).toBe(true)
  })

  test('an unselected task policy is announced once, on stderr', () => {
    const warnings: string[] = []
    warnUnselectedTaskPolicy(parseResidentArgs(BASE, 'qianmo'), message => {
      warnings.push(message)
    })

    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('no task policy was given')
    expect(warnings[0]).toContain('--require-signed-tasks')
    // 后果那一句才是这条告警有用的部分：默认强制 + 谁都不信任 = 每一条对端
    // task.request / wake 都会被拒。
    expect(warnings[1]).toContain('no peer is trusted yet')
  })

  test('the consequence line is dropped once there is something to trust', () => {
    const warnings: string[] = []
    warnUnselectedTaskPolicy(
      parseResidentArgs(
        [...BASE, '--trust', `node-a=${generateNodeKeyPair().publicKey}`],
        'qianmo',
      ),
      message => {
        warnings.push(message)
      },
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no task policy was given')
  })

  test('the announcement names whichever default is in force', () => {
    // 今天解析器不可能产生「没选 + 开放策略」这一格（默认是强制的），但默认值
    // 已经翻过一次；这条钉住的是「告警说的是当时那个默认」，而不是抄死一句
    // 「本节点要求签名」。
    const warnings: string[] = []
    warnUnselectedTaskPolicy(
      {
        ...parseResidentArgs(BASE, 'qianmo'),
        requireSignedTasks: false,
      },
      message => {
        warnings.push(message)
      },
    )

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('--open-policy')
    expect(warnings[0]).toContain(
      'unsigned task requests and wakes are admitted',
    )
  })

  test('an explicitly selected task policy says nothing at all', () => {
    // 显式配置过的情况一个字都不能出：对已经选过的人刷屏，正是让告警被忽略的
    // 那种噪音，而这条告警的全部价值在于它极少出现。
    for (const argv of [
      [...BASE, '--open-policy'],
      [...BASE, '--require-signed-tasks'],
      [...BASE, '--open-policy', '--audit-signed-tasks'],
    ]) {
      const warnings: string[] = []
      warnUnselectedTaskPolicy(parseResidentArgs(argv, 'qianmo'), message => {
        warnings.push(message)
      })
      expect(warnings).toEqual([])
    }
  })

  test('a node with no model credential says so once, on stderr', () => {
    // issue #13：四台节点带着一份 0600 的 secrets/model-env 跑了五天，而那份文件
    // 从来没有被任何进程读过。每一层都报成功（信封送达、receipt accepted、审计链
    // 新增、ACP 子进程开出真实 turn），只有 transcript 里那一轮是
    // authentication_failed。节点自己一个字都没说，因为没有人问过。
    const warnings: string[] = []
    warnMissingModelCredentials(false, message => {
      warnings.push(message)
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no model credential is visible to this node')
    // 后果那一句是这条告警有用的部分：它要说清「别的层全绿也不代表这一层是好的」。
    expect(warnings[0]).toContain('Not logged in · Please run /login')
    // 时机那一句同样不能省：ACP 子进程继承的是 resident 起来那一刻的环境，
    // 事后在别的 shell 里登录一次到不了它——不说，人就会去登录然后以为修好了。
    expect(warnings[0]).toContain('before the resident')
    // 一条能自查的下一步，而不是让人去猜检查了哪些键。
    expect(warnings[0]).toContain('auth status')
  })

  test('a node that has a credential says nothing at all', () => {
    // 与任务策略那条同样的纪律：配好的情况一个字都不出。两条告警都靠「极少出现」
    // 换取被人读到，其中一条开始刷屏，另一条也一起被跳过。
    const warnings: string[] = []
    warnMissingModelCredentials(true, message => {
      warnings.push(message)
    })
    expect(warnings).toEqual([])
  })

  test('the two directions of the switch cannot be asked for at once', () => {
    // 不按优先级裁决：无论怎么裁，写下这一行的人里有一半会拿到相反的结果，
    // 而拿错的那一半错在安全姿态上。
    expect(() =>
      parseResidentArgs(
        [...BASE, '--open-policy', '--require-signed-tasks'],
        'qianmo',
      ),
    ).toThrow('not both')
  })

  test('open audit mode admits unsigned tasks and records one shadow refusal', () => {
    const shadowRefusals: ShadowRefusal[] = []
    const observing = createResidentCapabilities(
      parseResidentArgs(
        [...BASE, '--open-policy', '--audit-signed-tasks'],
        'qianmo',
      ),
      new StaticPublicKeyDirectory(),
      generateNodeKeyPair(),
      refusal => shadowRefusals.push(refusal),
    )

    expect(observing.check(unsignedTask, Date.now())).toEqual({
      ok: true,
      level: CapabilityLevel.Read,
      trust: TRUST_UNTRUSTED,
    })
    expect(shadowRefusals).toHaveLength(1)
    expect(shadowRefusals[0]?.code).toBe(ProtocolErrorCode.E_CAP_INSUFFICIENT)
  })

  test('open audit mode fails fast when its shadow refusal sink is missing', () => {
    expect(() =>
      createResidentCapabilities(
        parseResidentArgs(
          [...BASE, '--open-policy', '--audit-signed-tasks'],
          'qianmo',
        ),
        new StaticPublicKeyDirectory(),
        generateNodeKeyPair(),
        undefined as unknown as ShadowRefusalSink,
      ),
    ).toThrow('--audit-signed-tasks requires a shadow refusal sink')
  })

  test('default and explicit signed policy refuse without shadow records', () => {
    const enforcingRefusals: ShadowRefusal[] = []
    for (const config of [
      parseResidentArgs(BASE, 'qianmo'),
      parseResidentArgs([...BASE, '--require-signed-tasks'], 'qianmo'),
    ]) {
      const enforcing = createResidentCapabilities(
        config,
        new StaticPublicKeyDirectory(),
        generateNodeKeyPair(),
        refusal => enforcingRefusals.push(refusal),
      )
      const verdict = enforcing.check(unsignedTask, Date.now())

      expect(verdict.ok).toBe(false)
      if (!verdict.ok) {
        expect(verdict.code).toBe(ProtocolErrorCode.E_CAP_INSUFFICIENT)
      }
    }
    expect(enforcingRefusals).toEqual([])
  })

  test('the issuer-trust list is the --trust names plus this node (issue #28)', () => {
    const peer = generateNodeKeyPair()
    const other = generateNodeKeyPair()
    const config = parseResidentArgs(
      [
        ...BASE,
        '--trust',
        `console=${peer.publicKey}`,
        '--trust',
        `node-a=${other.publicKey}`,
      ],
      'qianmo',
    )

    // Its own name is in there because rule S-1 accepts `user-confirmed` only
    // from this node's own key; leaving it out would make the strongest level
    // the one level that could never be trusted.
    expect([...residentTrustedIssuers(config)].sort()).toEqual([
      'console',
      'node-a',
      'node-b',
    ])
  })

  test('--trust-ca alone names nobody: a CA authenticates, it does not authorize', () => {
    // Fail-closed, and a deliberate gap rather than an oversight — see
    // key-distribution.md §10.5. Widening this to "everyone the CA signed"
    // would make every CA-signed identity an authority over every node.
    const config = parseResidentArgs(
      [...BASE, '--trust-ca', join(tmpdir(), 'qianmo-ca-not-read.pem')],
      'qianmo',
    )

    expect([...residentTrustedIssuers(config)]).toEqual(['node-b'])
  })

  test('open policy without audit ignores a supplied shadow refusal sink', () => {
    const shadowRefusals: ShadowRefusal[] = []
    const open = createResidentCapabilities(
      parseResidentArgs([...BASE, '--open-policy'], 'qianmo'),
      new StaticPublicKeyDirectory(),
      generateNodeKeyPair(),
      refusal => shadowRefusals.push(refusal),
    )

    // issue #28's first negative, at the unit level: an unsigned task admitted
    // by the escape hatch carries nothing anybody verified, so it stays at the
    // floor. `--open-policy` widens what is *admitted*, never what is trusted.
    expect(open.check(unsignedTask, Date.now())).toEqual({
      ok: true,
      level: CapabilityLevel.Read,
      trust: TRUST_UNTRUSTED,
    })
    expect(shadowRefusals).toEqual([])
  })
})

describe('the prior-life line (P13.5)', () => {
  test('names the verdict, and only killed carries a record', () => {
    // 真进程的三条命在 resident.integration.test.ts 的 P13.5 组里；这里只钉形状。
    // killed 只带哨兵记录里原有的三格，phase / node 不重复，也不推算死因。
    const record = {
      phase: 'running',
      pid: 4242,
      startedAt: 1_000,
      updatedAt: 31_000,
      node: 'node-b',
    } as const
    const line = (prior: Parameters<typeof residentPriorLifeLine>[1]) =>
      JSON.parse(residentPriorLifeLine('node-b', prior)) as unknown

    expect(line({ outcome: 'killed', record })).toEqual({
      node: 'node-b',
      priorLife: 'killed',
      prior: { pid: 4242, startedAt: 1_000, updatedAt: 31_000 },
    })
    expect(
      line({ outcome: 'clean', record: { ...record, phase: 'stopped' } }),
    ).toEqual({ node: 'node-b', priorLife: 'clean' })
    expect(line({ outcome: 'unknown' })).toEqual({
      node: 'node-b',
      priorLife: 'unknown',
    })
  })
})

describe('backup flags (P4.4)', () => {
  test('--backup-url must be http(s), and the interval needs it', () => {
    expect(
      parseResidentArgs(
        [...BASE, '--backup-url', 'http://127.0.0.1:7999'],
        'qianmo',
      ).backupUrl,
    ).toBe('http://127.0.0.1:7999/')
    expect(() =>
      parseResidentArgs([...BASE, '--backup-url', 'ws://x'], 'qianmo'),
    ).toThrow('must use http or https')
    expect(() =>
      parseResidentArgs([...BASE, '--backup-interval-ms', '60000'], 'qianmo'),
    ).toThrow('requires --backup-url')
  })

  test('a sub-second snapshot interval is refused', () => {
    // Archiving a workspace every 100 ms is not a backup policy, it is a way
    // to keep the disk busy.
    expect(() =>
      parseResidentArgs(
        [
          ...BASE,
          '--backup-url',
          'http://127.0.0.1:1',
          '--backup-interval-ms',
          '100',
        ],
        'qianmo',
      ),
    ).toThrow('>= 1000')
  })
})

describe('audit witness flags (P11.4)', () => {
  test('--witness-url must be http(s), and the interval needs it', () => {
    const parsed = parseResidentArgs(
      [
        ...BASE,
        '--witness-url=http://127.0.0.1:7998',
        '--witness-interval-ms',
        '60000',
      ],
      'qianmo',
    )
    expect(parsed.witnessUrl).toBe('http://127.0.0.1:7998/')
    expect(parsed.witnessIntervalMs).toBe(60_000)
    expect(() =>
      parseResidentArgs([...BASE, '--witness-url', 'ws://x'], 'qianmo'),
    ).toThrow('must use http or https')
    expect(() =>
      parseResidentArgs([...BASE, '--witness-interval-ms', '60000'], 'qianmo'),
    ).toThrow('requires --witness-url')
  })

  test('a sub-second witness interval is refused', () => {
    expect(() =>
      parseResidentArgs(
        [
          ...BASE,
          '--witness-url',
          'http://127.0.0.1:1',
          '--witness-interval-ms',
          '100',
        ],
        'qianmo',
      ),
    ).toThrow('>= 1000')
  })
})

describe('empty option values', () => {
  // `--port=` used to reach `Number('')`, which is 0 — a valid request for an
  // ephemeral port. The node came up on a port the operator never chose and
  // could not read off the command they typed. Every numeric flag here shares
  // the shape, so the guard lives in residentOptionValue and these cases pin
  // both spellings of the empty value.
  test('--port= is refused rather than parsed as port 0', () => {
    expect(() => parseResidentArgs([...BASE, '--port='], 'qianmo')).toThrow(
      '--port requires a value',
    )
  })

  test('an empty value after a space is refused too', () => {
    expect(() => parseResidentArgs([...BASE, '--port', ''], 'qianmo')).toThrow(
      '--port requires a value',
    )
  })

  test('a real port still parses', () => {
    const config = parseResidentArgs(
      [...BASE, '--port=38620', '--hostname=127.0.0.1'],
      'qianmo',
    )
    expect(config.port).toBe(38620)
  })

  test('--team= is refused (the guard is not numeric-only)', () => {
    expect(() =>
      parseResidentArgs(
        ['--node', 'node-a', '--team=', '--agent', 'planner=/tmp/x'],
        'qianmo',
      ),
    ).toThrow('--team requires a value')
  })
})

describe('resident --help', () => {
  test('observation mode is a second switch, not a mode of the first (§9.2 ①)', () => {
    // 「拿指令进来」和「把数据发出去」是两件事，这条也一样：能不能用它把切换的
    // 代价量出来，取决于它**不是**强制开关的一档。
    // 观察模式与逃生开关一起给才是 §9.2 阶段 ① 的形态：策略退回开放，同时把
    // 「切回去会拒掉多少条」记下来。
    const observing = parseResidentArgs(
      [...BASE, '--open-policy', '--audit-signed-tasks'],
      'qianmo',
    )
    expect(observing.auditSignedTasks).toBe(true)
    expect(observing.requireSignedTasks).toBe(false)

    const enforcing = parseResidentArgs(
      [...BASE, '--require-signed-tasks'],
      'qianmo',
    )
    expect(enforcing.requireSignedTasks).toBe(true)
    expect(enforcing.auditSignedTasks).toBe(false)

    const both = parseResidentArgs(
      [...BASE, '--require-signed-tasks', '--audit-signed-tasks'],
      'qianmo',
    )
    expect(both.requireSignedTasks).toBe(true)
    expect(both.auditSignedTasks).toBe(true)
  })

  test('answers --help and -h wherever they appear on the line', () => {
    // 「敲到一半发现忘了选项名」是人真会做的事，所以位置不限。
    expect(isResidentHelpRequest(['--help'])).toBe(true)
    expect(isResidentHelpRequest(['-h'])).toBe(true)
    expect(isResidentHelpRequest([...BASE, '--help'])).toBe(true)
    expect(isResidentHelpRequest(BASE)).toBe(false)
    expect(isResidentHelpRequest([])).toBe(false)
    // 当成某个选项的值写进去的不算——那是一个值，不是一次请求。
    expect(isResidentHelpRequest(['--team=--help'])).toBe(false)
  })

  test('documents every option the parser actually dispatches on', () => {
    // 反漂移：选项名的唯一出处是解析器的分派链，帮助文本是它的投影。新增一个
    // 选项却忘了写进帮助，这条会红——而不是等到内测用户问「还有别的参数吗」。
    const source = readFileSync(
      new URL('../resident.ts', import.meta.url),
      'utf8',
    )
    const dispatched = [...source.matchAll(/arg === '(--[a-z-]+)'/g)].map(
      match => match[1] as string,
    )
    // 分派链的形状变了（比如改成表驱动）也要在这里被发现，否则这条测试会安静
    // 地变成一个零断言的空转。15 个解析选项加 `--help` 自己那一次全等比较。
    expect(dispatched.length).toBeGreaterThanOrEqual(16)
    for (const option of new Set(dispatched)) {
      expect(RESIDENT_HELP_TEXT).toContain(option)
    }
  })

  test('spells out the three constraints the parser enforces after the loop', () => {
    // 这三条不是「选项存在与否」，而是「怎么组合才起得来」，撞上去只会拿到一条
    // 单句错误；帮助是唯一能一次说全的地方。
    expect(RESIDENT_HELP_TEXT).toContain('exactly one of --port and --unix')
    expect(RESIDENT_HELP_TEXT).toContain('only valid with --port')
    expect(RESIDENT_HELP_TEXT).toContain('Every path above must be absolute')
    expect(RESIDENT_HELP_TEXT).toContain('Requires --backup-url')
    expect(RESIDENT_HELP_TEXT).toContain('Requires --witness-url')
    expect(RESIDENT_HELP_TEXT).toContain('Requires --activity-url')
    expect(RESIDENT_HELP_TEXT).toContain('Requires --mem-sample')
  })

  test('names the identity and the write credentials it refuses to run without', () => {
    // 问「这个命令怎么用」的人恰恰是还没配好身份与密钥的那个人。
    expect(RESIDENT_HELP_TEXT).toContain('OCC_IDENTITY')
    expect(RESIDENT_HELP_TEXT).toContain('qianmo')
    expect(RESIDENT_HELP_TEXT).toContain('QIANMO_TRANSPORT_PSK')
    // 写凭据都只走环境变量，而帮助必须把「为什么不给命令行选项」一起说。
    expect(RESIDENT_HELP_TEXT).toContain('QIANMO_BACKUP_WRITE_TOKEN')
    expect(RESIDENT_HELP_TEXT).toContain('QIANMO_WITNESS_WRITE_TOKEN')
    expect(RESIDENT_HELP_TEXT).toContain('process listing')
    expect(RESIDENT_HELP_TEXT.endsWith('\n')).toBe(true)
  })

  test('quotes the defaults instead of copying the numbers', () => {
    // 默认值的出处是各自的常量；帮助里出现的必须是插值的结果。
    expect(RESIDENT_HELP_TEXT).toContain(
      `Default ${DEFAULT_RESIDENT_MEM_INTERVAL_MS}`,
    )
  })

  test('the unknown-option error points at the help', () => {
    // 走到那一支的人多半是拼错了选项名，所以顺手指一下那张表在哪。
    expect(() => parseResidentArgs([...BASE, '--noed=x'], 'qianmo')).toThrow(
      'unknown resident option --noed=x',
    )
    expect(() => parseResidentArgs([...BASE, '--noed=x'], 'qianmo')).toThrow(
      'resident --help',
    )
  })
})

describe('formatResidentError (#30)', () => {
  // Bun's own console.error(Error)/Bun.inspect(Error) renders a source
  // "code frame" — the offending line(s) plus a `^` caret, read off disk at
  // the throw site. Against a real dist/chunks/*.js that "line" is the
  // whole minified chunk squashed onto one line (~1KB+), which is exactly
  // what made <node>.err stop being reliably empty. These two tests throw
  // from real files on disk (mirroring the bundled case with a single
  // absurdly long line, and the dev case with ordinary short lines) so
  // Bun's actual frame-rendering path runs, not a hand-rolled stand-in.

  test('an absurdly long source line is not printed', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-error-long-'))
    try {
      // A stand-in for a minified dist chunk: one line, ~1.3KB, that throws.
      const filler = 'x'.repeat(1300)
      const path = join(directory, 'chunk.js')
      writeFileSync(
        path,
        `const filler = "${filler}"; throw new Error("boom from bundled chunk");`,
      )

      let caught: unknown
      try {
        await import(pathToFileURL(path).href)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)

      const formatted = formatResidentError(caught)
      // The minified "source line" never made it into the formatted error…
      for (const line of formatted.split('\n')) {
        expect(line.length).toBeLessThanOrEqual(400)
      }
      expect(formatted).not.toContain(filler)
      // …but the message and a stack frame pointing at the real file did.
      expect(formatted).toContain('boom from bundled chunk')
      expect(formatted).toContain('chunk.js')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test('a normal-length source line still prints its code frame', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'resident-error-short-'))
    try {
      // A stand-in for un-bundled `bun run dev` source: ordinary short lines.
      const path = join(directory, 'helper.js')
      writeFileSync(
        path,
        [
          'function helper() {',
          "  throw new Error('boom from dev source');",
          '}',
          'helper();',
          '',
        ].join('\n'),
      )

      let caught: unknown
      try {
        await import(pathToFileURL(path).href)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)

      const formatted = formatResidentError(caught)
      // Dev mode's short line is exactly what #30 says must not be nuked —
      // this asserts the code frame (the actual source text plus the `^`
      // caret) is still there, not just the message.
      expect(formatted).toBe(Bun.inspect(caught))
      expect(formatted).toContain("throw new Error('boom from dev source')")
      expect(formatted).toContain('^')
      expect(formatted).toContain('boom from dev source')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
