// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuditSource,
  AuditTrail,
  readTrail,
  type AuditRecord,
} from '@qianmo/audit'
import {
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
} from '@qianmo/capability'
import {
  DESTRUCTIVE_WORDS,
  AuditWitnessScheduler,
  FileWitnessAnchorStore,
  WitnessOp,
  assertWitnessSurfaceIsSafe,
  canonicalizeWitnessAnchor,
  checkWitnessStaleness,
  formatWitnessVerification,
  remoteWitnessAnchorReader,
  remoteWitnessAnchorWriter,
  signWitnessAnchor,
  startWitnessService,
  verifyAuditWitness,
  verifyWitnessAnchor,
  witnessAnchorOf,
  type WitnessRoute,
} from '../index.js'

const NODE = 'node-a'
const WRITE_TOKEN = 'witness-write-token-not-a-real-secret'
const READ_TOKEN = 'witness-read-token-not-a-real-secret'

const temporaryDirectories: string[] = []
const services: Array<{ stop(): Promise<void> }> = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qianmo-witness-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function appendStory(path: string, count: number): void {
  const trail = new AuditTrail(path)
  for (let index = 0; index < count; index++) {
    const seq = trail.written + 1
    trail.append({
      at: 1_000 + seq,
      source: AuditSource.Resident,
      kind: seq === 3 ? 'rate_limit' : `event-${seq}`,
      outcome: seq === 3 ? 'refused' : seq === 4 ? 'dropped' : 'ok',
      node: NODE,
    })
  }
  trail.close()
}

function rewriteTrail(
  sourcePath: string,
  targetPath: string,
  change: (records: readonly AuditRecord[]) => readonly AuditRecord[],
): void {
  const rewritten = new AuditTrail(targetPath)
  for (const record of change(readTrail(sourcePath).records)) {
    const { seq: _seq, prev: _prev, ...input } = record
    rewritten.append(input)
  }
  rewritten.close()
}

function signedAnchor(keys: ReturnType<typeof generateNodeKeyPair>) {
  return signWitnessAnchor(
    {
      v: 1,
      node: NODE,
      seq: 1,
      head: 'c'.repeat(64),
      count: 1,
      at: 1,
    },
    keys,
  )
}

function countingFetch(counter: { posts: number }): typeof fetch {
  return ((input, init) => {
    counter.posts += 1
    return fetch(input, init)
  }) as typeof fetch
}

function answering(status: number, body: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), { status }),
    )) as unknown as typeof fetch
}

function hangingFetch(onAbort: () => void): typeof fetch {
  return ((_input, init) => {
    init?.signal?.addEventListener('abort', onAbort, { once: true })
    return new Promise<Response>(() => {})
  }) as typeof fetch
}

describe('the signed anchor format', () => {
  test('signs the fixed §4.3 field order with the existing node key', () => {
    const keys = generateNodeKeyPair()
    const anchor = signWitnessAnchor(
      {
        v: 1,
        node: NODE,
        seq: 7,
        head: 'a'.repeat(64),
        count: 7,
        at: 123,
      },
      keys,
    )
    expect(canonicalizeWitnessAnchor(anchor)).toBe(
      '[1,"node-a",7,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",7,123]',
    )
    expect(verifyWitnessAnchor(anchor, keys.publicKey)).toBe(true)
    expect(verifyWitnessAnchor({ ...anchor, count: 8 }, keys.publicKey)).toBe(
      false,
    )
  })
})

describe('the append-only witness endpoint', () => {
  test('rejects destructive names and a widened writer surface at import-time checks', () => {
    for (const word of DESTRUCTIVE_WORDS) {
      const unsafe = new Map<string, WitnessRoute>([
        [
          `${word}Anchor`,
          {
            method: 'POST',
            path: '/v0/anchor',
            audience: 'reader',
            rationale: 'red direction',
          },
        ],
      ])
      expect(() => assertWitnessSurfaceIsSafe(unsafe)).toThrow(
        /destructive word/,
      )
    }
    const widened = new Map<string, WitnessRoute>([
      [
        WitnessOp.CreateAnchor,
        {
          method: 'POST',
          path: '/v0/anchor',
          audience: 'writer',
          rationale: 'valid route',
        },
      ],
      [
        WitnessOp.ListAnchors,
        {
          method: 'GET',
          path: '/v0/anchor?node=',
          audience: 'writer',
          rationale: 'must be refused',
        },
      ],
    ])
    expect(() => assertWitnessSurfaceIsSafe(widened)).toThrow(
      /writer audience may only reach/,
    )
  })

  test('refuses overwrite, deletion, and non-whitelisted methods over a real Bun server', async () => {
    const directory = temporaryDirectory()
    const store = new FileWitnessAnchorStore({ root: join(directory, 'store') })
    const keys = generateNodeKeyPair()
    const service = startWitnessService({
      store,
      publicKeys: new StaticPublicKeyDirectory([[NODE, keys.publicKey]]),
      writeToken: WRITE_TOKEN,
      readToken: READ_TOKEN,
      now: () => 1_234,
    })
    services.push(service)
    const base = service.url as string
    const anchor = signWitnessAnchor(
      {
        v: 1,
        node: NODE,
        seq: 1,
        head: 'b'.repeat(64),
        count: 1,
        at: 1,
      },
      keys,
    )
    const create = await fetch(`${base}/v0/anchor`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WRITE_TOKEN}`,
        'content-type': 'application/json',
      },
      // The sender is allowed to declare only `anchor.at`; a similarly named
      // field in its body must not become the witness receipt time.
      body: JSON.stringify({ ...anchor, receivedAt: Number.MAX_SAFE_INTEGER }),
    })
    expect(create.status).toBe(201)
    expect(await create.json()).toEqual({ anchor, receivedAt: 1_234 })
    const overwrite = await fetch(`${base}/v0/anchor`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WRITE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(anchor),
    })
    expect(overwrite.status).toBe(409)
    // Still a refusal, but it names the head already held at this seq, so a
    // restarted sender can recognise its own earlier acceptance.
    expect(await overwrite.json()).toEqual({
      error: 'anchor_exists',
      head: anchor.head,
    })
    const deletion = await fetch(`${base}/v0/anchor?node=${NODE}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    })
    expect(deletion.status).toBe(405)
    const nonWhitelisted = await fetch(`${base}/v0/anchor`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${WRITE_TOKEN}` },
    })
    expect(nonWhitelisted.status).toBe(405)
    expect(await store.list(NODE)).toEqual([{ anchor, receivedAt: 1_234 }])
  })

  test('rejects untrusted signatures before receipt or persistence without consuming the sequence', async () => {
    const directory = temporaryDirectory()
    const store = new FileWitnessAnchorStore({ root: join(directory, 'store') })
    const keys = generateNodeKeyPair()
    const impostor = generateNodeKeyPair()
    let clockReads = 0
    const service = startWitnessService({
      store,
      publicKeys: new StaticPublicKeyDirectory([[NODE, keys.publicKey]]),
      writeToken: WRITE_TOKEN,
      readToken: READ_TOKEN,
      now: () => {
        clockReads += 1
        return 1_234
      },
    })
    services.push(service)
    const base = service.url as string
    const anchor = signedAnchor(keys)
    const wrongKey = signedAnchor(impostor)
    const unknownNode = signWitnessAnchor(
      { ...anchor, node: 'node-unknown' },
      impostor,
    )
    const forged = [{ ...anchor, head: 'd'.repeat(64) }, wrongKey, unknownNode]

    for (const candidate of forged) {
      const response = await fetch(`${base}/v0/anchor`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${WRITE_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(candidate),
      })
      expect(response.status).toBe(403)
      expect(await response.json()).toEqual({ error: 'anchor_untrusted' })
    }
    expect(clockReads).toBe(0)
    expect(await store.list(NODE)).toEqual([])
    expect(await store.list('node-unknown')).toEqual([])

    const legitimate = await fetch(`${base}/v0/anchor`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${WRITE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(anchor),
    })
    expect(legitimate.status).toBe(201)
    expect(await legitimate.json()).toEqual({ anchor, receivedAt: 1_234 })
    expect(clockReads).toBe(1)
  })

  test('bounds writer and reader requests even when fetch ignores abort', async () => {
    const anchor = signedAnchor(generateNodeKeyPair())
    let writerAborted = false
    const writer = remoteWitnessAnchorWriter({
      url: 'http://witness.test',
      token: WRITE_TOKEN,
      timeoutMs: 10,
      fetchImpl: hangingFetch(() => {
        writerAborted = true
      }),
    })
    await expect(writer.append(anchor)).rejects.toThrow('timed out after 10 ms')
    expect(writerAborted).toBe(true)

    let readerAborted = false
    const reader = remoteWitnessAnchorReader({
      url: 'http://witness.test',
      token: READ_TOKEN,
      timeoutMs: 10,
      fetchImpl: hangingFetch(() => {
        readerAborted = true
      }),
    })
    await expect(reader.list(NODE)).rejects.toThrow('timed out after 10 ms')
    expect(readerAborted).toBe(true)
  })

  test('does not start remote IO when cancellation wins before fetch begins', async () => {
    const anchor = signedAnchor(generateNodeKeyPair())
    let fetches = 0
    const writer = remoteWitnessAnchorWriter({
      url: 'http://witness.test',
      token: WRITE_TOKEN,
      fetchImpl: (() => {
        fetches += 1
        return Promise.resolve(new Response(null, { status: 201 }))
      }) as unknown as typeof fetch,
    })
    const controller = new AbortController()
    const pending = writer.append(anchor, controller.signal)
    controller.abort()

    await expect(pending).rejects.toHaveProperty('name', 'AbortError')
    expect(fetches).toBe(0)
  })

  test('bounds a hanging remote reader body under the same request deadline', async () => {
    let aborted = false
    const reader = remoteWitnessAnchorReader({
      url: 'http://witness.test',
      token: READ_TOKEN,
      timeoutMs: 10,
      fetchImpl: ((_input, init) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true
          },
          { once: true },
        )
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise<unknown>(() => {}),
        } as unknown as Response)
      }) as typeof fetch,
    })
    await expect(reader.list(NODE)).rejects.toThrow('timed out after 10 ms')
    expect(aborted).toBe(true)
  })

  test('a 409 resolves only when it names the same head that was sent', async () => {
    const anchor = signedAnchor(generateNodeKeyPair())
    const writerAnswering = (status: number, body: unknown) =>
      remoteWitnessAnchorWriter({
        url: 'http://witness.test',
        token: WRITE_TOKEN,
        fetchImpl: answering(status, body),
      })

    await expect(
      writerAnswering(409, {
        error: 'anchor_exists',
        head: anchor.head,
      }).append(anchor),
    ).resolves.toBeUndefined()
    await expect(
      writerAnswering(409, {
        error: 'anchor_exists',
        head: 'd'.repeat(64),
      }).append(anchor),
    ).rejects.toThrow(
      'witness service refused the anchor: 409 (seq 1 already witnessed with a different head)',
    )
    // An endpoint from before the head was reported cannot confirm anything.
    await expect(
      writerAnswering(409, { error: 'anchor_exists' }).append(anchor),
    ).rejects.toThrow('witness service refused the anchor: 409')
    await expect(
      writerAnswering(409, { error: 'other', head: anchor.head }).append(
        anchor,
      ),
    ).rejects.toThrow('witness service refused the anchor: 409')
    await expect(
      writerAnswering(403, { error: 'anchor_untrusted' }).append(anchor),
    ).rejects.toThrow('witness service refused the anchor: 403')
  })

  test('reads a legacy bare anchor so verification can conservatively mark it stale', async () => {
    const anchor = signedAnchor(generateNodeKeyPair())
    const reader = remoteWitnessAnchorReader({
      url: 'http://witness.test',
      token: READ_TOKEN,
      fetchImpl: (() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve([anchor]),
        } as unknown as Response)) as unknown as typeof fetch,
    })
    await expect(reader.list(NODE)).resolves.toEqual([anchor])
  })
})

describe('§5 witness variants', () => {
  let directory: string
  let path: string
  let baseline: string
  let store: FileWitnessAnchorStore
  let base: string
  let keys: ReturnType<typeof generateNodeKeyPair>
  let witnessNow: number

  async function publish(at: number, targetPath = path): Promise<void> {
    witnessNow = at
    const scheduler = new AuditWitnessScheduler({
      node: NODE,
      trailPath: targetPath,
      keys,
      writer: remoteWitnessAnchorWriter({ url: base, token: WRITE_TOKEN }),
      now: () => at,
    })
    await scheduler.tick()
  }

  beforeEach(async () => {
    directory = temporaryDirectory()
    path = join(directory, 'node-a', 'trail.ndjson')
    witnessNow = 0
    store = new FileWitnessAnchorStore({ root: join(directory, 'witness') })
    keys = generateNodeKeyPair()
    const service = startWitnessService({
      store,
      publicKeys: new StaticPublicKeyDirectory([[NODE, keys.publicKey]]),
      writeToken: WRITE_TOKEN,
      readToken: READ_TOKEN,
      now: () => witnessNow,
    })
    services.push(service)
    base = service.url as string

    appendStory(path, 5)
    await publish(1_000)
    appendStory(path, 3)
    await publish(2_000)
    appendStory(path, 4)
    baseline = readFileSync(path, 'utf8')
  })

  test('A: detects a full rewrite that removes a refused record and recomputes hashes', async () => {
    const attacked = join(directory, 'attacked-a.ndjson')
    rewriteTrail(path, attacked, records =>
      records.filter(record => record.outcome !== 'refused'),
    )
    expect(readTrail(attacked).intact).toBe(true)
    const anchors = await store.list(NODE)
    const result = verifyAuditWitness({
      trailPath: attacked,
      anchors,
      publicKey: keys.publicKey,
      now: () => 2_500,
      staleAfterMs: 1_000_000,
    })
    expect(result.tampered).toBe(true)
    expect(result.issues.some(issue => issue.kind === 'head_mismatch')).toBe(
      true,
    )
  })

  test('B: detects changing refused to ok without changing the record count', async () => {
    const attacked = join(directory, 'attacked-b.ndjson')
    rewriteTrail(path, attacked, records =>
      records.map(record =>
        record.outcome === 'refused'
          ? { ...record, outcome: 'ok' as const }
          : record,
      ),
    )
    expect(readTrail(attacked).records).toHaveLength(
      readTrail(path).records.length,
    )
    expect(readTrail(attacked).intact).toBe(true)
    const result = verifyAuditWitness({
      trailPath: attacked,
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 2_500,
      staleAfterMs: 1_000_000,
    })
    expect(result.tampered).toBe(true)
  })

  test('C: reports an explicit unwitnessed tail when only the anchoring window changed', async () => {
    const attacked = join(directory, 'attacked-c.ndjson')
    rewriteTrail(path, attacked, records =>
      records.map(record =>
        record.seq === 10 ? { ...record, kind: 'changed-in-window' } : record,
      ),
    )
    const result = verifyAuditWitness({
      trailPath: attacked,
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 2_500,
      staleAfterMs: 1_000_000,
    })
    expect(result.tampered).toBe(false)
    expect(result.issues).toContainEqual({
      kind: 'unwitnessed_tail',
      from: 9,
      to: 12,
      count: 4,
    })
    expect(formatWitnessVerification(result)).toContain(
      'unwitnessed_tail: seq 9..12 共 4 条尚未被任何锚点覆盖',
    )
  })

  test('D1: a compromised node key can add a new anchor but cannot repair old evidence', async () => {
    const attacked = join(directory, 'attacked-d1.ndjson')
    rewriteTrail(path, attacked, records =>
      records.filter(record => record.outcome !== 'refused'),
    )
    await publish(3_000, attacked)
    const anchors = await store.list(NODE)
    expect(anchors.map(witnessAnchorOf).map(anchor => anchor.seq)).toContain(11)
    const result = verifyAuditWitness({
      trailPath: attacked,
      anchors,
      publicKey: keys.publicKey,
      now: () => 3_100,
      staleAfterMs: 1_000_000,
    })
    expect(result.tampered).toBe(true)
    expect(result.issues.some(issue => issue.kind === 'head_mismatch')).toBe(
      true,
    )
  })

  /**
   * An audit mirror is the node's chain as of its last pull. Pulled before
   * the second anchor's records existed, it holds seq 1..6 while the witness
   * already holds anchors at 5 and 8.
   */
  function mirrorOf(records: number, source = path): string {
    const mirror = join(directory, `mirror-${String(records)}.ndjson`)
    const lines = readFileSync(source, 'utf8').split('\n').filter(Boolean)
    writeFileSync(mirror, `${lines.slice(0, records).join('\n')}\n`)
    return mirror
  }

  test('M1: a mirror behind the newest anchor is uncovered, not tampered', async () => {
    const mirror = mirrorOf(6)
    const anchors = await store.list(NODE)
    const verify = (prefix: boolean) =>
      verifyAuditWitness({
        trailPath: mirror,
        anchors,
        publicKey: keys.publicKey,
        now: () => 2_500,
        staleAfterMs: 1_000_000,
        prefix,
      })

    const asMirror = verify(true)
    expect(asMirror).toEqual({
      tampered: false,
      stale: false,
      coveredThrough: 5,
      issues: [
        { kind: 'unwitnessed_tail', from: 6, to: 6, count: 1 },
        { kind: 'uncovered', from: 8, to: 8, count: 1 },
      ],
    })
    expect(formatWitnessVerification(asMirror)).toContain(
      'uncovered: anchor seq 8..8 共 1 个在本副本末尾之后，未比对',
    )
    // The same bytes read as the node's own chain are a truncation.
    expect(verify(false).tampered).toBe(true)
  })

  test('M2: a rewrite inside what the mirror does hold is still tampered', async () => {
    const attacked = join(directory, 'attacked-m2.ndjson')
    rewriteTrail(path, attacked, records =>
      records.filter(record => record.outcome !== 'refused'),
    )
    const result = verifyAuditWitness({
      trailPath: mirrorOf(6, attacked),
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 2_500,
      staleAfterMs: 1_000_000,
      prefix: true,
    })
    expect(result.tampered).toBe(true)
    expect(result.issues).toContainEqual(
      expect.objectContaining({ kind: 'head_mismatch', seq: 5 }),
    )
  })

  test('M3: a mirror that has caught up reads exactly as the node chain does', async () => {
    const anchors = await store.list(NODE)
    const options = {
      anchors,
      publicKey: keys.publicKey,
      now: () => 2_500,
      staleAfterMs: 1_000_000,
    }
    expect(
      verifyAuditWitness({
        ...options,
        trailPath: mirrorOf(12),
        prefix: true,
      }),
    ).toEqual(verifyAuditWitness({ ...options, trailPath: path }))
  })

  test('E: reports stale when anchoring stops even though the local chain is unchanged', async () => {
    expect(readFileSync(path, 'utf8')).toBe(baseline)
    const result = verifyAuditWitness({
      trailPath: path,
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 122_001,
      staleAfterMs: 120_000,
    })
    expect(result.tampered).toBe(false)
    expect(result.stale).toBe(true)
    expect(result.issues).toContainEqual({
      kind: 'stale',
      ageMs: 120_001,
      thresholdMs: 120_000,
    })
    expect(formatWitnessVerification(result)).toContain(
      'stale: last anchor is 120001 ms old, over 120000 ms',
    )
    const witnessSide = checkWitnessStaleness({
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 122_001,
      staleAfterMs: 120_000,
    })
    expect(witnessSide.stale).toBe(true)
    expect(witnessSide.ageMs).toBe(120_001)
  })

  test('uses witness receipt time instead of a future node-declared anchor time', () => {
    const futureAnchor = signWitnessAnchor(
      {
        v: 1,
        node: NODE,
        seq: 1,
        head: 'f'.repeat(64),
        count: 1,
        at: Number.MAX_SAFE_INTEGER,
      },
      keys,
    )
    const result = checkWitnessStaleness({
      anchors: [{ anchor: futureAnchor, receivedAt: 1_000 }],
      publicKey: keys.publicKey,
      now: () => 121_001,
      staleAfterMs: 120_000,
    })
    expect(result).toMatchObject({ stale: true, ageMs: 120_001 })
  })

  test('does not let bare or bad-signature evidence extend freshness', () => {
    const anchor = signWitnessAnchor(
      {
        v: 1,
        node: NODE,
        seq: 1,
        head: 'e'.repeat(64),
        count: 1,
        at: Number.MAX_SAFE_INTEGER,
      },
      keys,
    )
    const badSignature = `${
      anchor.signature.startsWith('A') ? 'B' : 'A'
    }${anchor.signature.slice(1)}`
    const bare = checkWitnessStaleness({
      anchors: [anchor],
      publicKey: keys.publicKey,
      now: () => 121_001,
      staleAfterMs: 120_000,
    })
    expect(bare).toMatchObject({ stale: true, ageMs: null })

    const withBadReceipt = checkWitnessStaleness({
      anchors: [
        { anchor, receivedAt: 1_000 },
        { anchor: { ...anchor, signature: badSignature }, receivedAt: 121_001 },
      ],
      publicKey: keys.publicKey,
      now: () => 121_001,
      staleAfterMs: 120_000,
    })
    expect(withBadReceipt).toMatchObject({ stale: true, ageMs: 120_001 })
    expect(withBadReceipt.issues).toContainEqual({
      kind: 'bad_signature',
      seq: 1,
    })
  })

  test('a sender failure is fail-open and the next period still attempts an anchor', async () => {
    let now = 5_000
    let failures = 0
    const scheduler = new AuditWitnessScheduler({
      node: NODE,
      trailPath: path,
      keys,
      writer: {
        append: async () => {
          throw new Error('witness unavailable')
        },
      },
      now: () => now,
      onError: () => {
        failures += 1
      },
    })
    await expect(scheduler.tick()).resolves.toBeUndefined()
    await expect(scheduler.tick()).resolves.toBeUndefined()
    now += 60_000
    await expect(scheduler.tick()).resolves.toBeUndefined()
    expect(failures).toBe(2)
  })

  test('coalesces concurrent ticks into one in-flight anchor attempt', async () => {
    let release: (() => void) | undefined
    let appends = 0
    const scheduler = new AuditWitnessScheduler({
      node: NODE,
      trailPath: path,
      keys,
      writer: {
        append: async () => {
          appends += 1
          await new Promise<void>(resolve => {
            release = resolve
          })
        },
      },
      now: () => 10_000,
    })
    const first = scheduler.tick()
    const second = scheduler.tick()
    expect(appends).toBe(1)
    release?.()
    await Promise.all([first, second])
    expect(appends).toBe(1)
  })

  test('close aborts and settles an in-flight append, then permanently disables ticks', async () => {
    let appends = 0
    let aborted = false
    let errors = 0
    const scheduler = new AuditWitnessScheduler({
      node: NODE,
      trailPath: path,
      keys,
      writer: {
        append: async (_anchor, signal) => {
          appends += 1
          signal?.addEventListener(
            'abort',
            () => {
              aborted = true
            },
            { once: true },
          )
          await new Promise<void>(() => {})
        },
      },
      now: () => 10_000,
      onError: () => {
        errors += 1
      },
    })
    const pending = scheduler.tick()
    expect(appends).toBe(1)

    scheduler.close()
    scheduler.close()
    await expect(
      Promise.race([
        pending.then(() => 'settled'),
        Bun.sleep(100).then(() => 'timed-out'),
      ]),
    ).resolves.toBe('settled')
    expect(aborted).toBe(true)
    expect(errors).toBe(0)

    await expect(scheduler.tick()).resolves.toBeUndefined()
    expect(appends).toBe(1)
  })

  test('continues reporting ordinary remote timeouts before shutdown', async () => {
    const errors: unknown[] = []
    const scheduler = new AuditWitnessScheduler({
      node: NODE,
      trailPath: path,
      keys,
      writer: remoteWitnessAnchorWriter({
        url: 'http://witness.test',
        token: WRITE_TOKEN,
        timeoutMs: 10,
        fetchImpl: hangingFetch(() => {}),
      }),
      now: () => 10_000,
      onError: error => errors.push(error),
    })

    await scheduler.tick()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('timed out after 10 ms')
  })

  function scheduler(
    counter: { posts: number },
    errors: unknown[],
    now: () => number,
    trailPath = path,
  ): AuditWitnessScheduler {
    return new AuditWitnessScheduler({
      node: NODE,
      trailPath,
      keys,
      writer: remoteWitnessAnchorWriter({
        url: base,
        token: WRITE_TOKEN,
        fetchImpl: countingFetch(counter),
      }),
      now,
      onError: error => errors.push(error),
    })
  }

  async function anchoredSeqs(): Promise<readonly number[]> {
    return (await store.list(NODE)).map(witnessAnchorOf).map(a => a.seq)
  }

  test('does not resend an accepted head and anchors the next one', async () => {
    const counter = { posts: 0 }
    const errors: unknown[] = []
    let now = 10_000
    witnessNow = 10_000
    const sender = scheduler(counter, errors, () => now)

    await sender.tick()
    for (let period = 0; period < 3; period++) {
      now += 60_000
      await sender.tick()
    }
    expect(counter.posts).toBe(1)

    appendStory(path, 1)
    now += 60_000
    await sender.tick()
    expect(counter.posts).toBe(2)
    expect(errors).toEqual([])
    expect(await anchoredSeqs()).toEqual([5, 8, 12, 13])
  })

  test('after a restart, a 409 naming the same head counts as accepted', async () => {
    await publish(10_000)
    const counter = { posts: 0 }
    const errors: unknown[] = []
    let now = 20_000
    witnessNow = 20_000
    const restarted = scheduler(counter, errors, () => now)

    // The first period after a restart resends the head exactly once.
    await restarted.tick()
    expect(counter.posts).toBe(1)
    expect(errors).toEqual([])
    now += 60_000
    await restarted.tick()
    expect(counter.posts).toBe(1)
    // No second receipt, and the original reception time is untouched.
    expect(await store.list(NODE)).toContainEqual(
      expect.objectContaining({ receivedAt: 10_000 }),
    )
    expect(await anchoredSeqs()).toEqual([5, 8, 12])
  })

  test('after a restart with new records, the first period anchors the new head', async () => {
    await publish(10_000)
    appendStory(path, 2)
    const counter = { posts: 0 }
    const errors: unknown[] = []
    witnessNow = 20_000
    await scheduler(counter, errors, () => 20_000).tick()
    expect(counter.posts).toBe(1)
    expect(errors).toEqual([])
    expect(await anchoredSeqs()).toEqual([5, 8, 12, 14])
  })

  test('a 409 for a different head at the same seq stays an error every period', async () => {
    await publish(10_000)
    const attacked = join(directory, 'attacked-same-seq.ndjson')
    rewriteTrail(path, attacked, records =>
      records.map(record =>
        record.seq === 12 ? { ...record, kind: 'rewritten-head' } : record,
      ),
    )
    const counter = { posts: 0 }
    const errors: unknown[] = []
    let now = 20_000
    const sender = scheduler(counter, errors, () => now, attacked)

    await sender.tick()
    now += 60_000
    await sender.tick()
    expect(counter.posts).toBe(2)
    expect(errors.map(String)).toEqual([
      'Error: witness service refused the anchor: 409 (seq 12 already witnessed with a different head)',
      'Error: witness service refused the anchor: 409 (seq 12 already witnessed with a different head)',
    ])
    expect(await anchoredSeqs()).toEqual([5, 8, 12])
  })

  test('an anchored head is not stale however old its receipt; one new record is', async () => {
    await publish(10_000)
    const anchors = await store.list(NODE)
    const anHourLater = () => 10_000 + 3_600_000
    const idle = verifyAuditWitness({
      trailPath: path,
      anchors,
      publicKey: keys.publicKey,
      now: anHourLater,
      staleAfterMs: 120_000,
    })
    expect(idle).toEqual({
      tampered: false,
      stale: false,
      coveredThrough: 12,
      issues: [],
    })
    // The witness side alone sees the same gap and cannot tell idle from
    // silenced; only the on-read verdict above has the trail to decide.
    expect(
      checkWitnessStaleness({
        anchors,
        publicKey: keys.publicKey,
        now: anHourLater,
        staleAfterMs: 120_000,
      }).stale,
    ).toBe(true)

    appendStory(path, 1)
    const behind = verifyAuditWitness({
      trailPath: path,
      anchors,
      publicKey: keys.publicKey,
      now: anHourLater,
      staleAfterMs: 120_000,
    })
    expect(behind.stale).toBe(true)
    expect(behind.issues).toEqual([
      { kind: 'stale', ageMs: 3_600_000, thresholdMs: 120_000 },
      { kind: 'unwitnessed_tail', from: 13, to: 13, count: 1 },
    ])
  })

  test('an unwitnessed tail inside the window is not stale; no valid anchor is', async () => {
    const withinWindow = verifyAuditWitness({
      trailPath: path,
      anchors: await store.list(NODE),
      publicKey: keys.publicKey,
      now: () => 2_000 + 120_000,
      staleAfterMs: 120_000,
    })
    expect(withinWindow.stale).toBe(false)
    expect(withinWindow.issues).toEqual([
      { kind: 'unwitnessed_tail', from: 9, to: 12, count: 4 },
    ])

    const none = verifyAuditWitness({
      trailPath: path,
      anchors: [],
      publicKey: keys.publicKey,
      now: () => 2_000,
      staleAfterMs: 120_000,
    })
    expect(none).toMatchObject({ tampered: false, stale: true })
    expect(none.issues).toEqual([
      { kind: 'stale', ageMs: null, thresholdMs: 120_000 },
    ])
  })
})
