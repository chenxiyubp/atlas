// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { isValidSegment, parseAddress } from '@qianmo/protocol'
import {
  type TransportServerHandle,
  startTransportServer,
} from '@qianmo/transport'
import { isResidentActivityMessage } from '@qianmo/resident/activity'
import type { KeepaliveLoop } from './keepalive.js'

export const DEFAULT_RESIDENT_KEEPALIVE_TIME_JUMP_FACTOR = 1.5

export class ResidentActivityController {
  readonly #keepalive: KeepaliveLoop
  #active = false

  constructor(keepalive: KeepaliveLoop) {
    this.#keepalive = keepalive
  }

  get active(): boolean {
    return this.#active
  }

  update(active: boolean): void {
    if (active === this.#active) return
    this.#active = active
    if (active) this.#keepalive.start()
    else this.#keepalive.stop()
  }

  stop(): void {
    this.#active = false
    this.#keepalive.stop()
  }
}

export function startResidentActivityServer(options: {
  readonly node: string
  readonly psk: string
  readonly listen: {
    readonly port?: number
    readonly hostname?: string
    readonly unix?: string
  }
  readonly controller: ResidentActivityController
}): TransportServerHandle {
  if (!isValidSegment(options.node)) {
    throw new Error(
      `invalid resident activity node ${JSON.stringify(options.node)}`,
    )
  }
  const server = startTransportServer({
    psk: options.psk,
    ...(options.listen.port === undefined ? {} : { port: options.listen.port }),
    ...(options.listen.hostname === undefined
      ? {}
      : { hostname: options.listen.hostname }),
    ...(options.listen.unix === undefined ? {} : { unix: options.listen.unix }),
    onMessage: (message, context) => {
      if (!isResidentActivityMessage(message)) {
        throw new Error(
          'resident activity listener accepts only activity pings',
        )
      }
      const destination = parseAddress(message.to)
      const sender = parseAddress(message.from)
      if (
        context.peerNode !== options.node ||
        destination?.node !== options.node ||
        sender?.node !== options.node
      ) {
        throw new Error(
          'resident activity identity does not match the target node',
        )
      }
      options.controller.update(message.payload.active)
    },
    onPeerDisconnect: (peerNode, remaining) => {
      if (peerNode === options.node && remaining === 0)
        options.controller.stop()
    },
  })
  return {
    ...(server.unix === undefined ? {} : { unix: server.unix }),
    ...(server.port === undefined ? {} : { port: server.port }),
    ...(server.url === undefined ? {} : { url: server.url }),
    events: server.events,
    dedup: server.dedup,
    get connections() {
      return server.connections
    },
    get channels() {
      return server.channels
    },
    closePeers: peerNodes => server.closePeers(peerNodes),
    closePeerCredentials: credentials =>
      server.closePeerCredentials(credentials),
    stop: async () => {
      options.controller.stop()
      await server.stop()
    },
  }
}
