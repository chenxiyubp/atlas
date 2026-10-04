// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { QianmoMessage } from '@qianmo/protocol'
import { parseAddress } from '@qianmo/protocol'
import type {
  AdmissionLedger,
  ResidentFormattedPrompt,
  ResidentMailboxMessage,
  ResidentMailboxPort,
  ResidentPromptScope,
  ResidentTurnInput,
  ResidentTurnPort,
  ResidentTurnResult,
} from './contracts.js'
import { NodeTurnGate } from './turn-gate.js'
import { ResidentMailboxReader } from './reader.js'
import type { ResidentSessionResolver } from './sessions.js'
import type { ResidentTimingRecorder } from './timings.js'

export interface ResidentAgentBinding {
  readonly agent: string
  /**
   * A single fixed session for this agent — the pre-multi-session shape, kept
   * for hosts (and tests) that have exactly one context. Mutually exclusive
   * with the node-level `sessions` resolver: exactly one of the two must be
   * present, because "which session does this batch belong to" has to have one
   * answer, not a fallback chain.
   */
  readonly sessionId?: string
  readonly ledger: AdmissionLedger
}

export class ResidentNodeRuntime {
  readonly #node: string
  readonly #team: string
  readonly #mailbox: ResidentMailboxPort
  readonly #turn: ResidentTurnPort
  readonly #formatPrompt: (
    messages: readonly ResidentMailboxMessage[],
    scope: ResidentPromptScope,
  ) => ResidentFormattedPrompt
  readonly #gate: NodeTurnGate
  readonly #readers = new Map<string, ResidentMailboxReader>()

  constructor(options: {
    readonly node: string
    readonly team: string
    readonly mailbox: ResidentMailboxPort
    readonly turn: ResidentTurnPort
    /**
     * Assemble the turn's user message.
     *
     * Takes the scope as well as the batch because the memory sidecar (§4.4)
     * is partitioned by `(agent, contextId)` and neither half is recoverable
     * from the messages alone — the agent is a property of which reader this
     * is, and the context is read out of the envelope by `contextId` below.
     * Handing both in here keeps the derivation in one place instead of
     * inviting the host to re-derive the context a second, subtly different
     * way.
     */
    readonly formatPrompt: (
      messages: readonly ResidentMailboxMessage[],
      scope: ResidentPromptScope,
    ) => ResidentFormattedPrompt
    readonly accepts?: (message: ResidentMailboxMessage) => boolean
    readonly selectSnapshot?: (
      messages: readonly ResidentMailboxMessage[],
    ) => readonly ResidentMailboxMessage[]
    readonly correlationId?: (
      messages: readonly ResidentMailboxMessage[],
    ) => string | undefined
    /**
     * The requester's context for this batch, in the same shape as
     * `correlationId` and read from the same place — the envelope the adapter
     * already embedded in the mailbox entry. Absent, every batch resolves to
     * `DEFAULT_CONTEXT`, which is byte for byte the behaviour that predates
     * multi-session isolation.
     */
    readonly contextId?: (
      messages: readonly ResidentMailboxMessage[],
    ) => string | undefined
    /** See {@link ResidentMailboxReaderOptions.deadlineOf}. */
    readonly deadlineOf?: (
      message: ResidentMailboxMessage,
    ) => number | undefined
    /** Session source shared by every agent. See {@link ResidentAgentBinding}. */
    readonly sessions?: ResidentSessionResolver
    readonly timings?: ResidentTimingRecorder
    readonly gate?: NodeTurnGate
    readonly agents: readonly ResidentAgentBinding[]
    readonly onRead?: (
      input: ResidentTurnInput,
      readAt: number,
    ) => void | Promise<void>
    readonly onTurnResult?: (
      input: ResidentTurnInput,
      result: ResidentTurnResult,
    ) => void | Promise<void>
    readonly onTurnError?: (
      error: unknown,
      input: ResidentTurnInput,
    ) => void | Promise<void>
    /** See {@link ResidentMailboxReaderOptions.maxRecoveries}. */
    readonly maxRecoveries?: number
    /** See {@link ResidentMailboxReaderOptions.onAbandoned}. */
    readonly onAbandoned?: (
      input: ResidentTurnInput,
      attempts: number,
      reason: string,
    ) => void | Promise<void>
    /** See {@link ResidentMailboxReaderOptions.onBreakerError}. */
    readonly onBreakerError?: (error: unknown) => void
  }) {
    this.#node = options.node
    this.#team = options.team
    this.#mailbox = options.mailbox
    this.#turn = options.turn
    this.#formatPrompt = options.formatPrompt
    this.#gate = options.gate ?? new NodeTurnGate()
    const sessions = options.sessions
    for (const binding of options.agents) {
      if (this.#readers.has(binding.agent)) {
        throw new Error(`duplicate resident agent ${binding.agent}`)
      }
      const staticSessionId = binding.sessionId
      if ((sessions === undefined) === (staticSessionId === undefined)) {
        throw new Error(
          `resident agent ${binding.agent} needs exactly one session source`,
        )
      }
      this.#readers.set(
        binding.agent,
        new ResidentMailboxReader({
          agent: binding.agent,
          team: this.#team,
          resolveSession:
            sessions === undefined
              ? () => staticSessionId as string
              : messages =>
                  sessions.sessionFor(
                    binding.agent,
                    options.contextId?.(messages),
                  ),
          ...(sessions === undefined
            ? {}
            : {
                onSessionRelease: (sessionId: string) => {
                  sessions.release(sessionId)
                },
              }),
          mailbox: this.#mailbox,
          turn: this.#turn,
          ledger: binding.ledger,
          formatPrompt: messages =>
            this.#formatPrompt(messages, {
              agent: binding.agent,
              contextId: options.contextId?.(messages),
            }),
          ...(options.accepts === undefined
            ? {}
            : { accepts: options.accepts }),
          ...(options.selectSnapshot === undefined
            ? {}
            : { selectSnapshot: options.selectSnapshot }),
          ...(options.correlationId === undefined
            ? {}
            : { correlationId: options.correlationId }),
          ...(options.deadlineOf === undefined
            ? {}
            : { deadlineOf: options.deadlineOf }),
          ...(options.timings === undefined
            ? {}
            : { timings: options.timings }),
          gate: this.#gate,
          ...(options.maxRecoveries === undefined
            ? {}
            : { maxRecoveries: options.maxRecoveries }),
          onRead: options.onRead,
          onTurnResult: options.onTurnResult,
          onTurnError: options.onTurnError,
          onAbandoned: options.onAbandoned,
          onBreakerError: options.onBreakerError,
        }),
      )
    }
  }

  /**
   * The synchronous half of {@link deliver}: can this node take the message at
   * all?
   *
   * Split out so a host can ask **before** it writes anything down. Once the
   * transport receipt stopped waiting for the turn (design §4.2(b)), the
   * address check was the one thing on that path that had to stay in front of
   * the mailbox write — otherwise a message addressed to an agent this node
   * does not host would land on disk first and be rejected afterwards, which
   * is exactly the "a refused message eats the inbox quota" shape rule L-1
   * forbids.
   */
  assertDeliverable(message: QianmoMessage): void {
    this.#readerFor(message)
  }

  async deliver(message: QianmoMessage): Promise<void> {
    await this.#readerFor(message).poll()
  }

  #readerFor(message: QianmoMessage): ResidentMailboxReader {
    const address = parseAddress(message.to)
    if (address === null || address.node !== this.#node) {
      throw new Error(`message is not addressed to resident node ${this.#node}`)
    }
    const reader = this.#readers.get(address.agent)
    if (reader === undefined) {
      throw new Error(`resident agent ${address.agent} is not configured`)
    }
    return reader
  }

  async pollAll(): Promise<void> {
    await Promise.all([...this.#readers.values()].map(reader => reader.poll()))
  }
}
