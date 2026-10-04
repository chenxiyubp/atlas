// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  CapabilityLevel,
  MessageType,
  createMessage,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  NodeCapabilities,
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  type NodeKeyPair,
} from '../src/index.js'
import type { CapabilityPolicy } from '../src/policy.js'

export const NODE_A = 'node-a'
export const NODE_B = 'node-b'
export const NODE_C = 'node-c'
export const PLANNER = `qianmo://${NODE_A}/planner`
export const REVIEWER = `qianmo://${NODE_B}/reviewer`

export const NOW = 1_800_000_000_000

/** One well-formed task request, optionally carrying a token. */
export function taskMessage(
  overrides: Partial<{
    from: string
    to: string
    type: MessageType
    taskId: string
    payload: unknown
    cap: string
    createdAt: number
  }> = {},
): QianmoMessage {
  return createMessage({
    from: overrides.from ?? PLANNER,
    to: overrides.to ?? REVIEWER,
    type: overrides.type ?? MessageType.TaskRequest,
    payload: overrides.payload ?? { ask: 'review the diff' },
    taskId: overrides.taskId ?? 'task-1',
    createdAt: overrides.createdAt ?? NOW,
    ...(overrides.cap === undefined ? {} : { cap: overrides.cap }),
  })
}

export interface Party {
  readonly node: string
  readonly keys: NodeKeyPair
}

/** A node with a key pair, published or not as the test likes. */
export function party(node: string): Party {
  return { node, keys: generateNodeKeyPair() }
}

/**
 * A verifier for `node`, trusting exactly the parties handed to it.
 *
 * `trusts` fills the key directory **and**, by default, the issuer-trust list —
 * which is how `resident.ts` wires a real node (`residentTrustedIssuers`: the
 * `--trust` entries plus its own name). `trustedIssuers` overrides the second
 * half alone, so a test can build the case the two axes come apart in: a node
 * that can check an issuer's signature and was never told to honour it.
 */
export function gateFor(
  node: string,
  options: {
    readonly trusts?: readonly Party[]
    readonly policy?: CapabilityPolicy
    readonly keys?: NodeKeyPair
    readonly trustedIssuers?: readonly string[]
  } = {},
): NodeCapabilities {
  const directory = new StaticPublicKeyDirectory(
    (options.trusts ?? []).map(peer => [peer.node, peer.keys.publicKey]),
  )
  return new NodeCapabilities({
    node,
    directory,
    trustedIssuers: options.trustedIssuers ?? [
      ...(options.trusts ?? []).map(peer => peer.node),
      node,
    ],
    ...(options.policy === undefined ? {} : { policy: options.policy }),
    ...(options.keys === undefined ? {} : { keys: options.keys }),
  })
}

/** A token the issuer signs for a handler on `aud`. */
export function tokenFor(
  issuer: Party,
  input: {
    readonly sub: string
    readonly aud: string
    readonly act?: CapabilityLevel
    readonly taskId?: string
    readonly nbf?: number
    readonly exp?: number
    readonly nonce?: string
  },
): string {
  const gate = new NodeCapabilities({
    node: issuer.node,
    directory: new StaticPublicKeyDirectory(),
    keys: issuer.keys,
  })
  return gate.issue({
    sub: input.sub,
    aud: input.aud,
    act: input.act ?? CapabilityLevel.WriteLimited,
    taskId: input.taskId ?? 'task-1',
    nbf: input.nbf ?? NOW - 1_000,
    exp: input.exp ?? NOW + 60_000,
    ...(input.nonce === undefined ? {} : { nonce: input.nonce }),
  })
}
