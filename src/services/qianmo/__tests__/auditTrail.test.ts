// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the transport is allowed to write onto the durable trail.
 *
 * Two properties, and the second one is the reason the first is not simply
 * "record every handshake":
 *
 * 1. a refused handshake that named a credential — above all a channel
 *    identity conflict — survives the process that refused it, with the
 *    channel id and the undelivered count that make it attributable;
 * 2. a refusal an unauthenticated stranger can produce with arbitrary bytes
 *    either never reaches the file, or reaches it at a bounded rate. The trail
 *    is `fsync`-per-record on a path anyone can dial; an unmetered whitelist
 *    would be a free way to fill the node's disk.
 *
 * The exclusion tests are therefore not decoration. They are the half that
 * would silently stop holding the first time somebody "tidied" the whitelist.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import { MessageType, createMessage, createTaskResult } from '@qianmo/protocol'
import {
  HandshakeRejection,
  TransportClient,
  TransportEventType,
  startTransportServer,
  type TransportEvent,
  type TransportEventSink,
  type TransportServerHandle,
} from '@qianmo/transport'
import { transportTrailSink } from '../auditTrail.js'

const NODE = 'node-b'
const PSK = 'handshake-audit-psk-not-a-real-secret'
const T0 = 1_760_000_000_000
/** 32 hex characters, the only shape a channel id is allowed to have. */
const SHARED_CHANNEL = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-handshake-audit-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  readonly sink: TransportEventSink
  readonly path: string
  records(): ReturnType<typeof readTrail>['records']
}

function harness(): Harness {
  const path = join(workspace(), 'audit', 'trail.ndjson')
  const trail = new AuditTrail(path)
  cleanups.push(() => trail.close())
  return {
    sink: transportTrailSink(trail, NODE),
    path,
    records() {
      return readTrail(path).records
    },
  }
}

function rejection(
  detail: Readonly<Record<string, string | number | boolean>>,
  at = T0,
): TransportEvent {
  return { type: TransportEventType.AuthRejected, at, detail }
}

describe('handshake refusals on the durable trail', () => {
  test('a channel identity conflict lands with the channel and its backlog', () => {
    const trail = harness()
    trail.sink(
      rejection({
        rejection: HandshakeRejection.ChannelIdentityMismatch,
        node: 'node-c',
        channelId: 'ch-retained-01',
        pending: 3,
        closeCode: 4004,
      }),
    )

    const records = trail.records()
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record?.source).toBe(AuditSource.Transport)
    // The layer's own event name, unchanged — same rule `message_rejected`
    // rides in on.
    expect(record?.kind).toBe('auth_rejected')
    expect(record?.outcome).toBe('refused')
    expect(record?.node).toBe(NODE)
    // The name the other end *claimed*; the handshake is what failed.
    expect(record?.peer).toBe('node-c')
    expect(record?.code).toBe('channel_identity_mismatch')
    expect(record?.at).toBe(T0)
    // The two fields PR #4 added to the in-memory event, now on disk.
    expect(record?.detail?.['channelId']).toBe('ch-retained-01')
    expect(record?.detail?.['pending']).toBe(3)
    expect(record?.detail?.['closeCode']).toBe(4004)
    // Nothing was suppressed, so the field is absent rather than zero.
    expect(record?.detail?.['suppressed']).toBeUndefined()
  })

  test('every whitelisted refusal names a credential that did not pass', () => {
    const trail = harness()
    const whitelisted = [
      HandshakeRejection.ChannelIdentityMismatch,
      HandshakeRejection.BadCredentialProof,
      HandshakeRejection.UnknownSigner,
      HandshakeRejection.BadSignature,
      HandshakeRejection.CredentialRequired,
    ]
    for (const [index, name] of whitelisted.entries()) {
      trail.sink(
        rejection({ rejection: name, node: `peer-${index}`, closeCode: 4003 }),
      )
    }
    expect(trail.records().map(record => record.code)).toEqual(whitelisted)
  })

  test('a refusal a stranger can buy with arbitrary bytes writes nothing', () => {
    const trail = harness()
    // Every one of these is reachable before any proof is checked, or is this
    // node's own state restated per connection. Recording them would turn the
    // trail into a write-amplification channel open to anyone who can dial.
    for (const name of [
      HandshakeRejection.MalformedFrame,
      HandshakeRejection.UnexpectedFrame,
      HandshakeRejection.BadNode,
      HandshakeRejection.BadChannel,
      HandshakeRejection.NonceMismatch,
      HandshakeRejection.BadMac,
      HandshakeRejection.SignatureRequired,
      'certificate_expired',
      'channel_capacity',
      // The dialer's half of a handshake, which answers a different question.
      'ready_bad_signature',
      'ready_wrong_node',
    ]) {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        trail.sink(
          rejection(
            { rejection: name, node: `scanner-${attempt}`, closeCode: 4003 },
            T0 + attempt * 10_000,
          ),
        )
      }
    }
    expect(trail.records()).toHaveLength(0)
  })

  test('handshake events that are not refusals write nothing', () => {
    const trail = harness()
    for (const type of [
      TransportEventType.ConnectionOpened,
      TransportEventType.ConnectionClosed,
      TransportEventType.AuthAccepted,
      TransportEventType.ChannelRotated,
      TransportEventType.ChannelReclaimed,
      TransportEventType.ReconnectScheduled,
      TransportEventType.ReconnectGaveUp,
      TransportEventType.TimeJumpDetected,
      TransportEventType.SinkFailed,
    ]) {
      trail.sink({
        type,
        at: T0,
        // Deliberately carrying a whitelisted string: the gate is the event
        // type first, so a detail field can never smuggle a record in.
        detail: {
          node: 'node-c',
          rejection: HandshakeRejection.ChannelIdentityMismatch,
        },
      })
    }
    expect(trail.records()).toHaveLength(0)
  })

  test('a refusal with no named cause writes nothing', () => {
    const trail = harness()
    // The dialing client records `{ code }` alone when it is shown the door.
    trail.sink(rejection({ code: 4003 }))
    expect(trail.records()).toHaveLength(0)
  })

  test('a flood from one source costs one record per window', () => {
    const trail = harness()
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      trail.sink(
        rejection(
          {
            rejection: HandshakeRejection.UnknownSigner,
            node: 'scanner',
            closeCode: 4003,
          },
          // A full second apart, so 2000 of them span half an hour and the
          // ceiling is the meter rather than the clock.
          T0 + attempt * 1_000,
        ),
      )
    }
    // 2000 attempts over ~33 minutes, at most one record per 60 s window.
    expect(trail.records().length).toBeGreaterThan(0)
    expect(trail.records().length).toBeLessThanOrEqual(34)

    // One more, a window later: the tally the meter was still holding rides
    // out on it. Nothing is counted away — every one of the 2001 attempts is
    // either a record of its own or part of a `suppressed` count on one.
    trail.sink(
      rejection(
        {
          rejection: HandshakeRejection.UnknownSigner,
          node: 'scanner',
          closeCode: 4003,
        },
        T0 + 2_000 * 1_000 + 120_000,
      ),
    )
    const counted = trail
      .records()
      .reduce(
        (sum, record) => sum + 1 + Number(record.detail?.['suppressed'] ?? 0),
        0,
      )
    expect(counted).toBe(2_001)
  })

  test('distinct sources each get a line until the tier is full', () => {
    const trail = harness()
    for (let peer = 0; peer < 40; peer += 1) {
      trail.sink(
        rejection({
          rejection: HandshakeRejection.BadSignature,
          node: `peer-${peer}`,
          closeCode: 4003,
        }),
      )
    }
    const records = trail.records()
    // Four slots in the unproven tier, and the other 36 are counted.
    expect(records).toHaveLength(4)
    expect(records.map(record => record.peer)).toEqual([
      'peer-0',
      'peer-1',
      'peer-2',
      'peer-3',
    ])

    // The tally rides out on the next record this tier writes.
    trail.sink(
      rejection(
        {
          rejection: HandshakeRejection.BadSignature,
          node: 'peer-late',
          closeCode: 4003,
        },
        T0 + 120_000,
      ),
    )
    const after = trail.records()
    expect(after).toHaveLength(5)
    expect(after[4]?.detail?.['suppressed']).toBe(36)
  })

  test('a flood of cheap refusals cannot crowd out an identity conflict', () => {
    const trail = harness()
    for (let attempt = 0; attempt < 500; attempt += 1) {
      trail.sink(
        rejection({
          rejection: HandshakeRejection.UnknownSigner,
          node: `scanner-${attempt}`,
          closeCode: 4003,
        }),
      )
    }
    trail.sink(
      rejection({
        rejection: HandshakeRejection.ChannelIdentityMismatch,
        node: 'node-c',
        channelId: 'ch-retained-01',
        pending: 2,
        closeCode: 4004,
      }),
    )
    const conflicts = trail
      .records()
      .filter(record => record.code === 'channel_identity_mismatch')
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.detail?.['pending']).toBe(2)
  })

  test('message-level records are untouched by any of this', () => {
    const trail = harness()
    trail.sink({
      type: TransportEventType.MessageRejected,
      at: T0,
      detail: { node: 'node-a', msgId: 'm-1', code: 'E_UNDELIVERABLE' },
    })
    trail.sink({
      type: TransportEventType.MessageAccepted,
      at: T0 + 1,
      detail: { node: 'node-a', msgId: 'm-2' },
    })
    trail.sink({
      type: TransportEventType.MessageDuplicate,
      at: T0 + 2,
      detail: { node: 'node-a', msgId: 'm-2' },
    })
    expect(
      trail.records().map(record => [record.kind, record.outcome]),
    ).toEqual([
      ['message_rejected', 'refused'],
      ['message_accepted', 'ok'],
      ['message_duplicate', 'dropped'],
    ])
  })
})

describe('a real takeover attempt, refused and recorded', () => {
  test('the listener writes the conflict its own ring used to keep', async () => {
    const dir = workspace()
    const path = join(dir, 'audit', 'trail.ndjson')
    const trail = new AuditTrail(path)
    cleanups.push(() => trail.close())
    const socket = join(dir, 'listener.sock')

    // The listener answers the first envelope on the same channel, and that
    // reply is what stays unreceipted — a retained channel with a backlog is
    // exactly the state a takeover attempt is worth recording against.
    const server: TransportServerHandle = startTransportServer({
      psk: PSK,
      unix: socket,
      events: transportTrailSink(trail, NODE),
      onMessage: (message, context) => {
        if (message.type !== MessageType.TaskRequest) return
        context.channel.send(
          createTaskResult(message, `qianmo://${NODE}/reviewer`, {
            outcome: 'completed',
            content: 'ok',
          }),
        )
      },
    })
    cleanups.push(() => server.stop())

    const owner = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      channelId: SHARED_CHANNEL,
      keepAliveIntervalMs: 0,
      backoff: { giveUpAfterMs: 0 },
      // Never returns, so the reply is never receipted and the listener's
      // channel keeps it pending.
      onMessage: () => new Promise<void>(() => {}),
    })
    cleanups.push(() => owner.close())
    await owner.connect(3_000)
    await owner.sendAndWait(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: `qianmo://${NODE}/reviewer`,
        type: MessageType.TaskRequest,
        taskId: 'task-takeover',
        payload: { step: 1 },
      }),
      3_000,
    )
    // Let the listener's reply reach the owner and stay unreceipted.
    await Bun.sleep(50)

    // A second node with the *same* PSK reaching for the same channel id.
    const impostor = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-c',
      psk: PSK,
      channelId: SHARED_CHANNEL,
      keepAliveIntervalMs: 0,
      backoff: { giveUpAfterMs: 0 },
    })
    cleanups.push(() => impostor.close())
    await expect(impostor.connect(3_000)).rejects.toThrow()

    trail.close()
    const conflicts = readTrail(path).records.filter(
      record => record.code === 'channel_identity_mismatch',
    )
    expect(conflicts).toHaveLength(1)
    const conflict = conflicts[0]
    expect(conflict?.source).toBe(AuditSource.Transport)
    expect(conflict?.kind).toBe('auth_rejected')
    expect(conflict?.outcome).toBe('refused')
    expect(conflict?.node).toBe(NODE)
    expect(conflict?.peer).toBe('node-c')
    expect(conflict?.detail?.['channelId']).toBe(SHARED_CHANNEL)
    expect(conflict?.detail?.['closeCode']).toBe(4004)
    // The undelivered reply the impostor was reaching for.
    expect(Number(conflict?.detail?.['pending'])).toBeGreaterThan(0)
  })
})
