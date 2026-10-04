// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  MessageType,
  createMessage,
  formatAddress,
  parseAddress,
} from '@qianmo/protocol'
import { TransportClient, type TransportEndpoint } from '@qianmo/transport'

export const RESIDENT_ACTIVITY_AGENT = 'resident-activity'
export const DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR = 1.1

export interface ResidentActivityPayload {
  readonly active: boolean
}

export function isResidentActivityPayload(
  value: unknown,
): value is ResidentActivityPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const record = value as Record<string, unknown>
  return Object.keys(record).length === 1 && typeof record.active === 'boolean'
}

/**
 * The node's idle/active telemetry link to the host that keeps its sandbox
 * from being frozen.
 *
 * ## Why this dial is **not** signed (key-distribution.md §7.1.1)
 *
 * Every other outbound `TransportClient` in this tree gained a `signing`
 * identity in P12.4. This one deliberately did not, and the reason is that
 * there is no second node to check a signature against:
 * `startResidentActivityServer` (`@qianmo/activator`) is a per-node listener
 * on the **host** side, and it authenticates by requiring that the dialer,
 * the sender address and the destination address all be this very node
 * (`context.peerNode !== options.node` is a refusal there). It has no
 * Ed25519 identity of its own — to counter-sign a ready frame under this
 * node's segment it would have to hold this node's *private* key, which is
 * precisely the thing `nodeIdentity.ts` exists to keep on one machine.
 *
 * §7.1.1's guarantee is a statement about two distinct node identities; here
 * there is one, so the mutual half cannot be constructed rather than merely
 * being unimplemented. `TransportClient` says the same thing from its side by
 * refusing `signing` without a `peerNode`, and there is no honest `peerNode`
 * to give it. The link is loopback or a unix socket in every deployed shape,
 * and its whole payload is one boolean.
 */
export class ResidentActivityReporter {
  readonly #client: TransportClient
  readonly #node: string
  readonly #to: string
  readonly #onError: ((error: unknown) => void) | undefined
  #reported: boolean | null = null

  constructor(options: {
    readonly node: string
    readonly endpoint: TransportEndpoint
    readonly psk: string
    readonly reconnectTimeJumpFactor?: number
    readonly onError?: (error: unknown) => void
  }) {
    this.#node = options.node
    this.#onError = options.onError
    this.#to = formatAddress({
      node: options.node,
      agent: RESIDENT_ACTIVITY_AGENT,
    })
    this.#client = new TransportClient({
      endpoint: options.endpoint,
      node: options.node,
      psk: options.psk,
      backoff: {
        timeJumpFactor:
          options.reconnectTimeJumpFactor ??
          DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
      },
      // The host stops keeping the sandbox alive the moment this link drops,
      // and it only starts again when it hears "busy" — which this side only
      // says on a busy↔idle edge. Without re-asserting on reconnect, a link
      // that blips mid-turn leaves the sandbox unprotected until the base's
      // 30 s heartbeat happens to come round.
      onReady: () => {
        this.#reassert()
      },
    })
  }

  #reassert(): void {
    const state = this.#reported
    if (state !== true) return
    void this.report(state).catch(error => {
      this.#onError?.(error)
    })
  }

  async connect(): Promise<void> {
    await this.#client.connect()
  }

  async report(active: boolean): Promise<void> {
    this.#reported = active
    await this.#client.sendAndWait(
      createMessage({
        from: formatAddress({
          node: this.#node,
          agent: RESIDENT_ACTIVITY_AGENT,
        }),
        to: this.#to,
        type: MessageType.Ping,
        payload: { active },
      }),
    )
  }

  async close(): Promise<void> {
    await this.#client.close()
  }
}

export function isResidentActivityMessage(message: {
  readonly to: string
  readonly type: MessageType
  readonly payload: unknown
}): message is typeof message & { readonly payload: ResidentActivityPayload } {
  return (
    parseAddress(message.to)?.agent === RESIDENT_ACTIVITY_AGENT &&
    message.type === MessageType.Ping &&
    isResidentActivityPayload(message.payload)
  )
}
