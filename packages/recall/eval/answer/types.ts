// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The contracts of the answer-layer executor (`docs/dev/memory-m1.md` §4,
 * P16.3): what a model call looks like to the executor, and what an arm is.
 *
 * Nothing here knows about a vendor, a wire format or a network. The live
 * transport (in `scripts/`) turns an {@link AnswerRequest} into the same
 * request the AC-4 leg builds; the replay transport answers it from a fixture.
 * The executor cannot tell the two apart, which is what lets a replayed run be
 * checked against hand computation.
 */

import type { FileMemoryStore } from '@qianmo/memory'
import type { RecallRequest, RecallResult } from '../../src/recall.js'

/** M0 = the deterministic `recall()`; M1 = the hybrid retriever of P16.6. */
export type Arm = 'm0' | 'm1'

export const ARMS: readonly Arm[] = ['m0', 'm1']

export type ToolCall = {
  readonly id: string
  readonly name: string
  readonly input: unknown
}

/**
 * One turn of a conversation that starts fresh for every question: a user
 * message, and — only for the second round after a rejection — the model's
 * own turn and the rejection fed back as the tool result.
 */
export type Turn =
  | { readonly role: 'user'; readonly text: string }
  | {
      readonly role: 'assistant'
      /** Reasoning text; fed back so a reasoning model's echo contract holds. */
      readonly thinking: string
      readonly text: string
      readonly toolCalls: readonly ToolCall[]
    }
  | {
      readonly role: 'tool'
      readonly toolCallId: string
      readonly content: string
    }

export type AnswerRequest = {
  /** Unique per call and round; the replay fixture is keyed by it. */
  readonly callKey: string
  /** The system prompt blocks: `buildRecallSystemPrompt(result)`. */
  readonly system: readonly string[]
  readonly turns: readonly Turn[]
}

/** As reported by the provider's `usage` field. */
export type TokenUsage = {
  readonly input: number
  readonly output: number
}

export type AnswerResponse = {
  /** The model id the response reported, or `null` when it reported none. */
  readonly model: string | null
  readonly thinking: string
  readonly text: string
  readonly toolCalls: readonly ToolCall[]
  readonly stopReason: string | null
  /** `null` when the provider sent no usage; the ledger then charges in full. */
  readonly usage: TokenUsage | null
}

export interface AnswerTransport {
  /** The provider id of the AC-5 fixture — never a host name. */
  readonly providerId: string
  /** The model the request asks for (the fixture's `defaultModel`). */
  readonly requestedModel: string
  /** The request's `max_tokens`: the output side of every reservation. */
  readonly maxOutputTokens: number
  /**
   * A number of input tokens the request cannot exceed. The ledger reserves
   * it before the call, so it must be an upper bound, not an estimate.
   */
  inputUpperBound(request: AnswerRequest): number
  send(request: AnswerRequest): Promise<AnswerResponse>
}

/**
 * An arm's retrieval: given the store and the request `recall()` would get,
 * the result whose injection goes into the system prompt. M0 is `recall`
 * itself; M1 is P16.6's `recallHybrid`, wired in `semantic.ts`.
 */
export type ArmRetriever = (
  store: FileMemoryStore,
  request: RecallRequest,
) => RecallResult | Promise<RecallResult>
