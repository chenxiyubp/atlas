// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Record and replay of model calls, so an answer-layer run can be re-scored
 * without a network (P16.3 DoD: 「录制回放 fixture（不联网）下指标与手算一致」).
 *
 * A fixture maps each call key to the digest of the request that was sent and
 * the response that came back. Replay looks the call up by key and refuses
 * when the request it is asked to send is not the one that was recorded: a
 * changed corpus, prompt or retrieval would otherwise be scored against
 * answers to a different question.
 *
 * The digest covers what the executor controls — system prompt and turns —
 * not the wire body, which is the live transport's business.
 *
 * A fixture of a run with the M1 arm also carries the embedding vectors that
 * run used (`embeddings`, see `semantic.ts`). The digest check covers them
 * indirectly: a different vector changes the M1 block, and with it the
 * request.
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import type { RecordedVectors } from './semantic.js'
import type { AnswerRequest, AnswerResponse, AnswerTransport } from './types.js'

export const FIXTURE_SCHEMA = 'qianmo-recall-answer-fixture/v1'

export type Exchange = {
  readonly provider: string
  readonly requestSha256: string
  readonly response: AnswerResponse
}

type ReplayFixture = {
  readonly schema: typeof FIXTURE_SCHEMA
  readonly exchanges: Readonly<Record<string, Exchange>>
  /** The M1 arm's vectors; absent in a fixture of an M0-only run. */
  readonly embeddings?: RecordedVectors
}

function isRecordedVectors(value: unknown): value is RecordedVectors {
  if (typeof value !== 'object' || value === null) return false
  const { embedder, vectors } = value as Record<string, unknown>
  if (typeof embedder !== 'object' || embedder === null) return false
  const { id, model, dimensions } = embedder as Record<string, unknown>
  return (
    typeof id === 'string' &&
    typeof model === 'string' &&
    Number.isSafeInteger(dimensions) &&
    typeof vectors === 'object' &&
    vectors !== null
  )
}

/** Recorded or replayed call keys that do not match the fixture. */
class ReplayMismatch extends Error {
  constructor(
    readonly callKey: string,
    reason: string,
  ) {
    super(`replay: ${callKey}: ${reason}`)
    this.name = 'ReplayMismatch'
  }
}

function requestDigest(request: AnswerRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ system: request.system, turns: request.turns }))
    .digest('hex')
}

export function readFixture(path: string): ReplayFixture {
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as ReplayFixture
  if (
    fixture.schema !== FIXTURE_SCHEMA ||
    typeof fixture.exchanges !== 'object' ||
    (fixture.embeddings !== undefined && !isRecordedVectors(fixture.embeddings))
  ) {
    throw new Error(`replay: ${path} is not a ${FIXTURE_SCHEMA} file`)
  }
  return fixture
}

export function writeFixture(path: string, fixture: ReplayFixture): void {
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`)
}

/**
 * Answers from a fixture, for one provider. Never touches the network; the
 * input bound is the recorded usage, or the digest-checked request's size.
 */
export function replayTransport(
  fixture: ReplayFixture,
  provider: {
    readonly providerId: string
    readonly requestedModel: string
    readonly maxOutputTokens: number
  },
): AnswerTransport {
  const lookup = (request: AnswerRequest): Exchange => {
    const exchange = fixture.exchanges[request.callKey]
    if (exchange === undefined) {
      throw new ReplayMismatch(request.callKey, 'not in the fixture')
    }
    if (exchange.provider !== provider.providerId) {
      throw new ReplayMismatch(request.callKey, 'recorded for another provider')
    }
    if (exchange.requestSha256 !== requestDigest(request)) {
      throw new ReplayMismatch(
        request.callKey,
        'the request differs from the recorded one',
      )
    }
    return exchange
  }
  return {
    ...provider,
    inputUpperBound: request =>
      lookup(request).response.usage?.input ??
      Buffer.byteLength(JSON.stringify(request), 'utf8'),
    send: async request => lookup(request).response,
  }
}

/**
 * Wraps a transport and records every exchange into `sink`. Write the sink
 * out with {@link writeFixture} once the run is over.
 */
export function recordingTransport(
  inner: AnswerTransport,
  sink: Record<string, Exchange>,
): AnswerTransport {
  return {
    providerId: inner.providerId,
    requestedModel: inner.requestedModel,
    maxOutputTokens: inner.maxOutputTokens,
    inputUpperBound: request => inner.inputUpperBound(request),
    send: async request => {
      const response = await inner.send(request)
      sink[request.callKey] = {
        provider: inner.providerId,
        requestSha256: requestDigest(request),
        response,
      }
      return response
    },
  }
}
