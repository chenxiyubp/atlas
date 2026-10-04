// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  LIMITS,
  MessageType,
  isNotifyPayload,
  type NotifyPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import { NotifyBudget } from '@qianmo/router'
import { FileDeliveryLedger } from '../src/delivery-ledger.js'
import {
  NOTIFY_EVENT_SCHEMA_VERSION,
  ResidentNotifier,
  ResidentNotifyEventType,
  type NotifyChannel,
  type ResidentNotifyEvent,
} from '../src/notify.js'

const FROM = 'qianmo://node-a/watcher'
const TO = 'qianmo://hub/console'
const PEER = 'hub'
const CONTEXT = 'job-disk-space'

let directory: string
let ledger: FileDeliveryLedger
let events: ResidentNotifyEvent[]
let errors: unknown[]

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-resident-notify-'))
  ledger = new FileDeliveryLedger(join(directory, 'notifies.ndjson'))
  events = []
  errors = []
})

afterEach(() => {
  ledger.close()
  rmSync(directory, { recursive: true, force: true })
})

/**
 * A channel that records instead of transmitting.
 *
 * Real enough to be honest — it answers `supports` from a declared list and
 * its `sendAndWait` resolves or rejects on demand — and it is constructed by
 * the test rather than mocked into the module graph, which is what keeps this
 * package at zero `mock.module`.
 */
class RecordingChannel implements NotifyChannel {
  readonly sent: QianmoMessage[] = []
  holds = 0
  releases = 0
  failNext = 0
  #supports: boolean

  constructor(options: { supportsNotify?: boolean } = {}) {
    this.#supports = options.supportsNotify ?? true
  }

  supports(type: MessageType): boolean {
    return this.#supports && type === MessageType.Notify
  }

  async sendAndWait(message: QianmoMessage): Promise<unknown> {
    this.sent.push(message)
    if (this.failNext > 0) {
      this.failNext -= 1
      throw new Error('no receipt')
    }
    return { status: 'accepted' }
  }

  hold(): () => void {
    this.holds += 1
    return () => {
      this.releases += 1
    }
  }
}

function payloadOf(overrides: Partial<NotifyPayload> = {}): NotifyPayload {
  return {
    kind: 'watch',
    severity: 'warn',
    summary: 'disk is at 91%',
    observedAt: 1_700_000_000_000,
    ...overrides,
  }
}

function notifierWith(
  options: {
    now?: () => number
    budget?: NotifyBudget
    ledger?: FileDeliveryLedger
  } = {},
): ResidentNotifier {
  return new ResidentNotifier({
    node: 'node-a',
    ledger: options.ledger ?? ledger,
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.now === undefined ? {} : { now: options.now }),
    audit: event => {
      events.push(event)
    },
    onError: error => {
      errors.push(error)
    },
  })
}

async function announce(
  notifier: ResidentNotifier,
  channel: NotifyChannel | undefined,
  overrides: Partial<NotifyPayload> = {},
) {
  return await notifier.announce({
    from: FROM,
    to: TO,
    peerNode: PEER,
    contextId: CONTEXT,
    payload: payloadOf(overrides),
    ...(channel === undefined ? {} : { channel }),
  })
}

/** Wait for the fire-and-forget sends the notifier starts. */
async function quiesce(notifier: ResidentNotifier): Promise<void> {
  await notifier.settle()
}

function notifyPayloadOf(message: QianmoMessage): NotifyPayload {
  expect(isNotifyPayload(message.payload)).toBe(true)
  return message.payload as NotifyPayload
}

describe('a notification leaves on a channel the peer already opened', () => {
  test('the envelope is a notify, stamped with this node as its first hop', async () => {
    const channel = new RecordingChannel()
    const notifier = notifierWith()

    const outcome = await announce(notifier, channel)
    await quiesce(notifier)

    expect(outcome.status).toBe('sent')
    expect(channel.sent).toHaveLength(1)
    const message = channel.sent[0] as QianmoMessage
    expect(message.type).toBe(MessageType.Notify)
    expect(message.from).toBe(FROM)
    expect(message.to).toBe(TO)
    expect(message.contextId).toBe(CONTEXT)
    // §6.3: the origin stamps itself before the envelope reaches a transport,
    // so the audit chain has a head even though this path skips
    // `NodeRouter.outbound()`.
    expect(message.hops).toEqual(['node-a'])
    expect(notifyPayloadOf(message).summary).toBe('disk is at 91%')
    // §2.4④: a notify's task deadline is its delivery deadline, so a
    // notification that missed its window is not still "alive" on paper.
    expect(message.taskTtlMs).toBe(message.deliverTtlMs)
    expect(message.deliverTtlMs).toBe(LIMITS.defaultNotifyTtlMs)
  })

  test('the channel is held for the send and released after it', async () => {
    const channel = new RecordingChannel()
    const notifier = notifierWith()

    await announce(notifier, channel)
    await quiesce(notifier)

    expect(channel.holds).toBe(1)
    expect(channel.releases).toBe(1)
  })

  test('a receipted notification is discharged, so nothing is owed', async () => {
    const channel = new RecordingChannel()
    const notifier = notifierWith()

    await announce(notifier, channel)
    await quiesce(notifier)

    expect(notifier.outstanding(PEER)).toHaveLength(0)
  })
})

describe('the hub being away is survivable (design §4.1, P13.5 semantics)', () => {
  test('with no channel the notification is recorded, not lost', async () => {
    const notifier = notifierWith()

    const outcome = await announce(notifier, undefined)

    expect(outcome.status).toBe('queued')
    expect(notifier.outstanding(PEER)).toHaveLength(1)
    expect(
      events.filter(event => event.type === ResidentNotifyEventType.Held),
    ).toHaveLength(1)
  })

  test('the backlog drains in the order it was made, and only once', async () => {
    const notifier = notifierWith()
    await announce(notifier, undefined, { summary: 'first' })
    await announce(notifier, undefined, { summary: 'second' })
    await announce(notifier, undefined, { summary: 'third' })

    const channel = new RecordingChannel()
    notifier.drain(channel, PEER)
    await quiesce(notifier)

    expect(channel.sent.map(m => notifyPayloadOf(m).summary)).toEqual([
      'first',
      'second',
      'third',
    ])

    // Contact again: everything was receipted, so there is nothing left to
    // hand over. A second drain that resent the batch would be the failure
    // "按序排空且不重复" names.
    notifier.drain(channel, PEER)
    await quiesce(notifier)
    expect(channel.sent).toHaveLength(3)
  })

  test('a backlog survives the process that made it', async () => {
    const notifier = notifierWith()
    await announce(notifier, undefined, { summary: 'seen before the crash' })
    ledger.close()

    // A new ledger over the same file is what a restart actually looks like.
    const reopened = new FileDeliveryLedger(join(directory, 'notifies.ndjson'))
    const revived = notifierWith({ ledger: reopened })
    const channel = new RecordingChannel()
    try {
      revived.drain(channel, PEER)
      await quiesce(revived)
      expect(channel.sent).toHaveLength(1)
      expect(notifyPayloadOf(channel.sent[0] as QianmoMessage).summary).toBe(
        'seen before the crash',
      )
    } finally {
      reopened.close()
    }
  })

  test('nothing goes to a peer that has not come back', async () => {
    const notifier = notifierWith()
    await announce(notifier, undefined)

    // Another peer's contact must not discharge this one's obligation, and —
    // the point of H-2 — no contact at all sends nothing at all.
    const other = new RecordingChannel()
    notifier.drain(other, 'some-other-node')
    await quiesce(notifier)

    expect(other.sent).toHaveLength(0)
    expect(notifier.outstanding(PEER)).toHaveLength(1)
  })
})

describe('a repeat is visible, never silent', () => {
  test('a second attempt is marked redelivered and takes a fresh taskId', async () => {
    const channel = new RecordingChannel()
    channel.failNext = 1
    const notifier = notifierWith()

    await announce(notifier, channel)
    await quiesce(notifier)
    expect(channel.sent).toHaveLength(1)
    expect(notifyPayloadOf(channel.sent[0] as QianmoMessage).redelivered).toBe(
      undefined,
    )

    notifier.drain(channel, PEER)
    await quiesce(notifier)

    expect(channel.sent).toHaveLength(2)
    const repeat = channel.sent[1] as QianmoMessage
    expect(notifyPayloadOf(repeat).redelivered).toBe(true)
    // The load-bearing half, and the one a reader will be tempted to "fix":
    // `notify` is not a reply type, so `LoopGuard` records `(to, taskId)` for
    // it. Reusing the first attempt's taskId inside the delivery window would
    // be refused as `E_LOOP` — the redelivery would be cut by the loop
    // detector rather than by anything about the notification.
    expect(repeat.taskId).not.toBe((channel.sent[0] as QianmoMessage).taskId)
    expect(repeat.msgId).not.toBe((channel.sent[0] as QianmoMessage).msgId)
  })

  test('a dedupKey suppresses a repeat that is still undelivered', async () => {
    const notifier = notifierWith()
    const first = await announce(notifier, undefined, { dedupKey: 'disk:root' })
    const second = await announce(notifier, undefined, {
      dedupKey: 'disk:root',
      summary: 'disk is at 92%',
    })

    expect(first.status).toBe('queued')
    expect(second.status).toBe('duplicate')
    expect(notifier.outstanding(PEER)).toHaveLength(1)
    expect(
      events.filter(event => event.type === ResidentNotifyEventType.Suppressed),
    ).toHaveLength(1)
  })

  test('a different dedupKey is a different notification', async () => {
    const notifier = notifierWith()
    await announce(notifier, undefined, { dedupKey: 'disk:root' })
    const other = await announce(notifier, undefined, { dedupKey: 'disk:var' })

    expect(other.status).toBe('queued')
    expect(notifier.outstanding(PEER)).toHaveLength(2)
  })
})

describe('the outbound budget is a sliding window, not a bucket (§2.5, §14.7)', () => {
  test('the ceiling holds inside one minute', async () => {
    let clock = 1_000_000
    const budget = new NotifyBudget({ perMinute: 3, windowMs: 60_000 })
    const notifier = notifierWith({ budget, now: () => clock })
    const channel = new RecordingChannel()

    for (let index = 0; index < 3; index += 1) {
      const outcome = await announce(notifier, channel, {
        summary: `n${index}`,
      })
      expect(outcome.status).toBe('sent')
    }
    await quiesce(notifier)

    const fourth = await announce(notifier, channel, { summary: 'n3' })
    expect(fourth.status).toBe('queued')
    expect(channel.sent).toHaveLength(3)
    // The refusal names when a slot opens, so the caller has something better
    // to do than spin.
    expect(
      fourth.status === 'queued' ? fourth.retryAfterMs : undefined,
    ).toBeGreaterThan(0)
  })

  test('an hour of quiet does not release a batch of two windows', async () => {
    // The one behaviour that separates the two mechanisms end to end. A token
    // bucket of capacity C refilling at C per minute is full after an hour: it
    // admits C at once and another C over the following minute, i.e. 2C inside
    // one minute. A window admits C per window, always.
    let clock = 1_000_000
    const budget = new NotifyBudget({ perMinute: 3, windowMs: 60_000 })
    const notifier = notifierWith({ budget, now: () => clock })
    const channel = new RecordingChannel()

    for (let index = 0; index < 3; index += 1) {
      await announce(notifier, channel, { summary: `early-${index}` })
    }
    await quiesce(notifier)
    expect(channel.sent).toHaveLength(3)

    // An hour of silence. The window is empty again — but only for one
    // window's worth.
    clock += 3_600_000
    for (let index = 0; index < 3; index += 1) {
      const outcome = await announce(notifier, channel, {
        summary: `late-${index}`,
      })
      expect(outcome.status).toBe('sent')
    }
    await quiesce(notifier)
    expect(channel.sent).toHaveLength(6)

    // One millisecond later, still inside the same minute: a bucket would have
    // refilled by now and let this through. The window does not.
    clock += 1
    const overflow = await announce(notifier, channel, {
      summary: 'one too many',
    })
    expect(overflow.status).toBe('queued')
    expect(channel.sent).toHaveLength(6)

    // And it is held, not dropped: the moment the window opens, contact from
    // the peer hands it over.
    clock += 60_000
    notifier.drain(channel, PEER)
    await quiesce(notifier)
    expect(channel.sent).toHaveLength(7)
    expect(notifyPayloadOf(channel.sent[6] as QianmoMessage).summary).toBe(
      'one too many',
    )
  })

  test('a shut window stops the drain rather than stepping over it', async () => {
    // Order is the property at risk. Skipping the refused entry and trying the
    // next one would let a later notification overtake an earlier one for no
    // reason the reader of the two could ever reconstruct.
    let clock = 1_000_000
    const budget = new NotifyBudget({ perMinute: 1, windowMs: 60_000 })
    const notifier = notifierWith({ budget, now: () => clock })

    await announce(notifier, undefined, { summary: 'first' })
    await announce(notifier, undefined, { summary: 'second' })

    const channel = new RecordingChannel()
    notifier.drain(channel, PEER)
    await quiesce(notifier)

    expect(channel.sent.map(m => notifyPayloadOf(m).summary)).toEqual(['first'])

    clock += 60_000
    notifier.drain(channel, PEER)
    await quiesce(notifier)
    expect(channel.sent.map(m => notifyPayloadOf(m).summary)).toEqual([
      'first',
      'second',
    ])
  })

  test('the default ceiling is the protocol number, not a copy of it', () => {
    const notifier = notifierWith()
    expect(notifier.remaining(1_000_000)).toBe(LIMITS.notifyRatePerMinute)
  })
})

describe('capability discovery (§2.7)', () => {
  test('a peer that does not implement notify is told nothing, and nothing waits', async () => {
    const channel = new RecordingChannel({ supportsNotify: false })
    const notifier = notifierWith()

    const outcome = await announce(notifier, channel)

    expect(outcome.status).toBe('unsupported')
    expect(channel.sent).toHaveLength(0)
    // Nothing queued: an older peer will refuse every attempt identically, so
    // holding it would burn the ceiling proving the same thing three times.
    expect(notifier.outstanding(PEER)).toHaveLength(0)
  })

  test('a backlog is retired when the peer that comes back is too old', async () => {
    const notifier = notifierWith()
    await announce(notifier, undefined)
    expect(notifier.outstanding(PEER)).toHaveLength(1)

    const legacy = new RecordingChannel({ supportsNotify: false })
    notifier.drain(legacy, PEER)

    expect(legacy.sent).toHaveLength(0)
    expect(notifier.outstanding(PEER)).toHaveLength(0)
    expect(
      events.filter(event => event.type === ResidentNotifyEventType.Abandoned),
    ).toHaveLength(1)
  })
})

describe('the audit line is the evidence a watch job produces', () => {
  test('every line carries the schema version (hermes B9)', async () => {
    const channel = new RecordingChannel()
    const notifier = notifierWith()

    await announce(notifier, channel)
    await quiesce(notifier)

    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.detail.schemaVersion).toBe(NOTIFY_EVENT_SCHEMA_VERSION)
    }
  })

  test('a send and its receipt are two lines, both correlated', async () => {
    const channel = new RecordingChannel()
    const notifier = notifierWith()

    await announce(notifier, channel)
    await quiesce(notifier)

    const sent = events.find(
      event => event.type === ResidentNotifyEventType.Sent,
    )
    const delivered = events.find(
      event => event.type === ResidentNotifyEventType.Delivered,
    )
    expect(sent).toBeDefined()
    expect(delivered).toBeDefined()
    expect(sent?.detail.taskId).toBe(delivered?.detail.taskId as string)
    expect(sent?.detail.attempt).toBe(1)
    expect(sent?.detail.redelivered).toBe(false)
    expect(sent?.detail.kind).toBe('watch')
    expect(sent?.detail.severity).toBe('warn')
  })

  test('an audit sink that throws changes nothing about the send (B8)', async () => {
    const channel = new RecordingChannel()
    const notifier = new ResidentNotifier({
      node: 'node-a',
      ledger,
      audit: () => {
        throw new Error('sink is broken')
      },
      onError: error => {
        errors.push(error)
      },
    })

    const outcome = await announce(notifier, channel)
    await quiesce(notifier)

    expect(outcome.status).toBe('sent')
    expect(channel.sent).toHaveLength(1)
    expect(errors.length).toBeGreaterThan(0)
  })
})
