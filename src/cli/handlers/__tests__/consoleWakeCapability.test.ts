// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台出向面的 capability token（issue #14）。
 *
 * 每条用例都把令牌喂给**节点侧真正的那个门** —— `NodeCapabilities.check`，不是一个
 * 手写的等价物。这不是形式：`aud` / `sub` / `taskId` 三项绑定的具体取值（尤其
 * `sub` 用的是完整地址而不是 agent 段）只在 `gate.ts` 里定义，一个照着注释重写的
 * 断言只能证明注释自洽。
 *
 * 消息也是真发出去再收回来的：起一个 `startTransportServer`，让
 * `executeResidentWake` 走完 `createMessage → NodeRouter.outbound → 握手 → 投递`
 * 整条路，再对收到的那个信封验令牌。中途任何一步把 `cap` 弄丢或改写，这里都会红。
 */

import { describe, expect, test } from 'bun:test'
import {
  NodeCapabilities,
  OPEN_POLICY,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  CapabilityLevel,
  MessageType,
  NOTICE_TRUST_VERIFIED_CAPABILITY,
  ProtocolErrorCode,
  TRUST_UNTRUSTED,
  parseCapabilityToken,
  type QianmoMessage,
} from '@qianmo/protocol'
import { ReceiptStatus, startTransportServer } from '@qianmo/transport'
import { wireConsoleWake } from '../console.js'
import { parseConsoleArgs } from '../consoleArgs.js'
import { createWakePort } from '../consolePorts.js'
import {
  CONSOLE_WAKE_CAPABILITY_BACKDATE_MS,
  CONSOLE_WAKE_CAPABILITY_TTL_MS,
  consoleWakeIdentityNode,
  createConsoleWakeIssuer,
  type ConsoleWakeIdentity,
} from '../consoleWakeIdentity.js'
import { executeResidentWake } from '../residentWake.js'

const PSK = 'console-wake-capability-test-not-a-real-secret'
const CONSOLE_NODE = 'console'
const TARGET_NODE = 'beta-1'
const TARGET = `qianmo://${TARGET_NODE}/beta-1`
const FROM = `qianmo://${CONSOLE_NODE}/operator`

/** One wake, actually sent, with whatever signing the caller asked for. */
async function sendWake(options: {
  readonly keys?: NodeKeyPair
  readonly ttlMs?: number
}): Promise<QianmoMessage> {
  const received: QianmoMessage[] = []
  const server = startTransportServer({
    psk: PSK,
    port: 0,
    hostname: '127.0.0.1',
    onMessage: message => {
      received.push(message)
    },
  })
  try {
    const result = await executeResidentWake(
      {
        url: server.url as string,
        from: FROM,
        to: TARGET,
        prompt: 'run the nightly check',
        afterMs: 0,
        timeoutMs: 2_000,
        deliverTtlMs: 2_000,
        ...(options.keys === undefined
          ? {}
          : {
              issueCapability: createConsoleWakeIssuer(
                CONSOLE_NODE,
                options.keys,
                options.ttlMs ?? CONSOLE_WAKE_CAPABILITY_TTL_MS,
              ),
            }),
      },
      PSK,
    )
    expect(result.receipt).toBe(ReceiptStatus.Accepted)
  } finally {
    await server.stop()
  }
  const message = received[0]
  if (message === undefined) throw new Error('no wake reached the server')
  return message
}

/**
 * A node gate wired the way `resident.ts` wires one: the `--trust` entries fill
 * both the key directory and the issuer-trust list (`residentTrustedIssuers`).
 *
 * `trustedIssuers` can be overridden to pull the two apart — the case where a
 * node can *verify* an issuer's signature but was never told to *honour* it,
 * which has no command line today and is exactly the tier's negative case.
 */
function nodeGate(options: {
  readonly trusted: readonly (readonly [string, string])[]
  readonly enforcing: boolean
  readonly trustedIssuers?: readonly string[]
}): NodeCapabilities {
  return new NodeCapabilities({
    node: TARGET_NODE,
    directory: new StaticPublicKeyDirectory(options.trusted),
    policy: options.enforcing ? SIGNED_TASK_POLICY : OPEN_POLICY,
    trustedIssuers:
      options.trustedIssuers ?? options.trusted.map(([node]) => node),
  })
}

describe('console wake capability tokens', () => {
  test('a token the console signs clears an enforcing node that trusts it', async () => {
    const keys = generateNodeKeyPair()
    const message = await sendWake({ keys })

    expect(message.type).toBe(MessageType.Wake)
    expect(typeof message.cap).toBe('string')

    const decision = nodeGate({
      trusted: [[CONSOLE_NODE, keys.publicKey]],
      enforcing: true,
    }).check(message, message.createdAt)

    expect(decision).toEqual({
      ok: true,
      level: CapabilityLevel.WriteLimited,
      issuer: CONSOLE_NODE,
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
    })
  })

  test('a signed wake from an issuer this node never named stays untrusted', async () => {
    // issue #28's second negative. The key is in the directory, so the
    // signature verifies and the enforcing policy admits the wake — every
    // layer says yes. What the node was never told is that `console` may
    // *direct* it, so the tier stays at the floor and the agent is handed the
    // untrusted notice. "Verifiable" and "authorized" are two questions.
    const keys = generateNodeKeyPair()
    const message = await sendWake({ keys })

    expect(
      nodeGate({
        trusted: [[CONSOLE_NODE, keys.publicKey]],
        enforcing: true,
        trustedIssuers: [],
      }).check(message, message.createdAt),
    ).toEqual({
      ok: true,
      level: CapabilityLevel.WriteLimited,
      issuer: CONSOLE_NODE,
      trust: TRUST_UNTRUSTED,
    })
  })

  test('binds aud, sub and taskId to the envelope it rides in', async () => {
    const keys = generateNodeKeyPair()
    const message = await sendWake({ keys })
    const parts = parseCapabilityToken(message.cap)
    if (parts === null) throw new Error('the wake carried no parsable token')

    // `sub` is the **whole** address, because `gate.ts` passes `message.to` as
    // the handler. An agent-segment-only subject would be refused, and this is
    // the assertion that keeps that from being rediscovered in production.
    expect(parts.claims).toMatchObject({
      iss: CONSOLE_NODE,
      aud: TARGET_NODE,
      sub: TARGET,
      taskId: message.taskId,
      act: CapabilityLevel.WriteLimited,
    })
    expect(parts.claims.sub).not.toBe('beta-1')
  })

  test('a third node refuses a token minted for someone else', async () => {
    const keys = generateNodeKeyPair()
    const message = await sendWake({ keys })

    // Same token, same trusted key, different verifier: the replay-to-a-third
    // -node case `aud` exists for.
    const elsewhere = new NodeCapabilities({
      node: 'beta-2',
      directory: new StaticPublicKeyDirectory([[CONSOLE_NODE, keys.publicKey]]),
      policy: SIGNED_TASK_POLICY,
    })

    expect(elsewhere.check(message, message.createdAt)).toMatchObject({
      ok: false,
      code: ProtocolErrorCode.E_CAP_INVALID,
      reason: `capability audience ${TARGET_NODE} is not this node beta-2`,
    })
  })

  test('a token is refused once its window has passed', async () => {
    const keys = generateNodeKeyPair()
    const message = await sendWake({ keys })
    const gate = nodeGate({
      trusted: [[CONSOLE_NODE, keys.publicKey]],
      enforcing: true,
    })

    expect(
      gate.check(message, message.createdAt + CONSOLE_WAKE_CAPABILITY_TTL_MS),
    ).toMatchObject({
      ok: false,
      code: ProtocolErrorCode.E_CAP_INVALID,
      reason: 'capability has expired',
    })
    // …and refused before the backdated `nbf`, so the allowance is a window and
    // not an open lower bound.
    expect(
      gate.check(
        message,
        message.createdAt - CONSOLE_WAKE_CAPABILITY_BACKDATE_MS - 1,
      ),
    ).toMatchObject({ ok: false, reason: 'capability is not yet valid' })
  })

  test('the window covers the connect cap that is spent before the socket opens', async () => {
    const keys = generateNodeKeyPair()
    const message = await sendWake({ keys })
    const parts = parseCapabilityToken(message.cap)
    if (parts === null) throw new Error('the wake carried no parsable token')

    // The token is minted before `TransportClient.connect`, and connecting is
    // capped at 30 s in `residentWake.ts`. A lifetime at or under that cap
    // turns a slow TCP connect into `capability has expired` — a network fault
    // reported as an authorization fault.
    expect(parts.claims.exp - message.createdAt).toBeGreaterThan(30_000)
    // And it stays short enough that a captured token is worthless quickly.
    expect(parts.claims.exp - message.createdAt).toBeLessThanOrEqual(120_000)
  })
})

describe('the wake port itself', () => {
  test('createWakePort forwards its issuer all the way onto the wire', async () => {
    // The wiring test above proves the issuer reaches `createWakePort`; this one
    // proves `createWakePort` does not drop it on the floor. Without it the two
    // halves could each pass while the `cap` field never leaves this process.
    const keys = generateNodeKeyPair()
    const received: QianmoMessage[] = []
    const server = startTransportServer({
      psk: PSK,
      port: 0,
      hostname: '127.0.0.1',
      onMessage: message => {
        received.push(message)
      },
    })
    try {
      const port = createWakePort({
        url: server.url as string,
        psk: PSK,
        capability: createConsoleWakeIssuer(CONSOLE_NODE, keys),
        timeoutMs: 2_000,
      })
      const result = await port.send({
        from: FROM,
        to: TARGET,
        prompt: 'run the nightly check',
        url: '',
      })
      expect(result.ok).toBe(true)
    } finally {
      await server.stop()
    }

    const message = received[0]
    if (message === undefined) throw new Error('no wake reached the server')
    expect(
      nodeGate({
        trusted: [[CONSOLE_NODE, keys.publicKey]],
        enforcing: true,
      }).check(message, message.createdAt),
    ).toEqual({
      ok: true,
      level: CapabilityLevel.WriteLimited,
      issuer: CONSOLE_NODE,
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
    })
  })

  test('without an issuer the port sends exactly what it always sent', async () => {
    const received: QianmoMessage[] = []
    const server = startTransportServer({
      psk: PSK,
      port: 0,
      hostname: '127.0.0.1',
      onMessage: message => {
        received.push(message)
      },
    })
    try {
      const port = createWakePort({
        url: server.url as string,
        psk: PSK,
        timeoutMs: 2_000,
      })
      expect(
        (
          await port.send({
            from: FROM,
            to: TARGET,
            prompt: 'run the nightly check',
            url: '',
          })
        ).ok,
      ).toBe(true)
    } finally {
      await server.stop()
    }
    expect(received[0]?.cap).toBeUndefined()
  })
})

describe('compatibility with the fleet as it runs today', () => {
  test('an unsigned wake still clears a node with open policy and no trusts', async () => {
    // The four beta nodes run `trusts: []` under `OPEN_POLICY`. This is the
    // shape every wake had before this change and the shape it still has when
    // `--wake-sign` is absent — byte for byte, no `cap` field at all.
    const message = await sendWake({})

    expect(message.cap).toBeUndefined()
    expect(
      nodeGate({ trusted: [], enforcing: false }).check(
        message,
        message.createdAt,
      ),
    ).toEqual({
      ok: true,
      level: CapabilityLevel.Read,
      trust: TRUST_UNTRUSTED,
    })
  })

  test('open policy does NOT make an unresolvable token optional', async () => {
    // Pinned deliberately, because it is the fact that decides the rollout
    // order and it reads the other way round at first glance: `OPEN_POLICY`
    // stops *requiring* a token, it never stops *checking* one. A token whose
    // issuer has no published key is `E_CAP_INVALID` under both policies, so
    // signing before the key is distributed breaks the wake face rather than
    // degrading it. Hence `--wake-sign` is opt-in and trust comes first.
    const keys = generateNodeKeyPair()
    const message = await sendWake({ keys })

    expect(
      nodeGate({ trusted: [], enforcing: false }).check(
        message,
        message.createdAt,
      ),
    ).toMatchObject({
      ok: false,
      code: ProtocolErrorCode.E_CAP_INVALID,
      reason: `no published public key for issuer ${CONSOLE_NODE}`,
    })
  })

  test('a signed wake clears an open-policy node once it trusts the console', async () => {
    // The intermediate rung of the rollout: trust distributed, policy not yet
    // flipped. Both directions of §9.3's table hold for a signed message.
    const keys = generateNodeKeyPair()
    const message = await sendWake({ keys })

    expect(
      nodeGate({
        trusted: [[CONSOLE_NODE, keys.publicKey]],
        enforcing: false,
      }).check(message, message.createdAt),
    ).toEqual({
      ok: true,
      level: CapabilityLevel.WriteLimited,
      issuer: CONSOLE_NODE,
      trust: NOTICE_TRUST_VERIFIED_CAPABILITY,
    })
  })
})

describe('console wake signing wiring', () => {
  function identity(keys: NodeKeyPair): ConsoleWakeIdentity {
    return {
      node: CONSOLE_NODE,
      publicKey: keys.publicKey,
      issue: createConsoleWakeIssuer(CONSOLE_NODE, keys),
    }
  }

  test('no --wake-sign means no issuer reaches the port and no key is read', () => {
    const created: Array<Record<string, unknown>> = []
    let loads = 0
    wireConsoleWake(
      parseConsoleArgs(
        [`--wake-url=${TARGET_NODE}=ws://127.0.0.1:38611`],
        'qianmo',
      ),
      {
        pskFromEnv: () => PSK,
        createWakePort(options) {
          created.push({ ...options })
          return {
            async send() {
              return {
                ok: false,
                failure: { code: 'unsupported', message: 'not dialled here' },
              }
            },
          }
        },
        loadIdentity() {
          loads += 1
          return identity(generateNodeKeyPair())
        },
      },
    )

    expect(loads).toBe(0)
    expect(created).toEqual([{ url: 'ws://127.0.0.1:38611/', psk: PSK }])
  })

  test('--wake-sign hands every target the same issuer and reports the key', () => {
    const keys = generateNodeKeyPair()
    const created: Array<Record<string, unknown>> = []
    const wiring = wireConsoleWake(
      parseConsoleArgs(
        [
          `--wake-url=${TARGET_NODE}=ws://127.0.0.1:38611`,
          '--wake-url=beta-2=ws://127.0.0.1:38612',
          '--wake-sign',
        ],
        'qianmo',
      ),
      {
        pskFromEnv: () => PSK,
        createWakePort(options) {
          created.push({ ...options })
          return {
            async send() {
              return {
                ok: false,
                failure: { code: 'unsupported', message: 'not dialled here' },
              }
            },
          }
        },
        loadIdentity: () => identity(keys),
      },
    )

    expect(created).toHaveLength(2)
    expect(created.every(options => options['capability'] !== undefined)).toBe(
      true,
    )
    // One console, one identity: two targets must not get two issuers, or the
    // audit trails on two nodes would name two different principals.
    expect(created[0]?.['capability']).toBe(created[1]?.['capability'] as never)
    expect(wiring.identity?.publicKey).toBe(keys.publicKey)
  })

  test('the signing identity is the node segment the console already speaks as', () => {
    expect(consoleWakeIdentityNode('qianmo://console/operator')).toBe(
      CONSOLE_NODE,
    )
    expect(consoleWakeIdentityNode('qianmo://ops-console/operator')).toBe(
      'ops-console',
    )
    expect(() => consoleWakeIdentityNode('operator')).toThrow(
      'not a qianmo:// address',
    )
  })
})
