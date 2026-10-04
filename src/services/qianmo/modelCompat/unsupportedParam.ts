// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "This endpoint rejects that optional field": recognise it, drop the field,
 * send again — once per field (P18.5, hermes #12; design
 * `providers-console-m1.md` §5.6 row 12, §5.7 "「参数不受支持」文案表").
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/auxiliary_client.py:4275-4306` `_is_unsupported_parameter_error`
 *     — the error names the parameter AND says it is unsupported / unknown /
 *     unrecognised / invalid; the marker list below;
 *   - `agent/auxiliary_client.py:9459-9465` — on such an error the call is
 *     repeated once without the field.
 * Only the wording and the rule are taken; the code is ours.
 *
 * Before P18.5 the chat lane had this for exactly one field, inline
 * (`prompt_cache_key`, `openai/index.ts` `createChatStreamWithCacheKeyFallback`),
 * and the Responses lane had it for `reasoning.summary` with its own detector
 * (`responsesAdapter.ts` `isReasoningSummaryRejection`). Both now go through
 * this module — each keeps the detector or marker list it had, so neither
 * changes behaviour — and new fields join by adding one entry.
 *
 * Exactly-once: the re-send happens inside the lane's `create`, when the HTTP
 * request itself was refused — nothing has been streamed, nothing shown. It is
 * the same position the `prompt_cache_key` fallback always had.
 */
import { errorMessageTexts } from './errorMessages.js'

/** hermes `auxiliary_client.py:4297-4306`. */
const UNSUPPORTED_PARAMETER_MARKERS: readonly string[] = [
  'unsupported parameter',
  'unsupported_parameter',
  'not supported',
  'does not support',
  'unknown parameter',
  'unrecognized request argument',
  'unrecognized parameter',
  'invalid parameter',
]

/**
 * `text` names `param` and carries one of `markers` (case-insensitive). The
 * default markers are hermes's; a caller with an established list of its own
 * passes it so its behaviour stays exactly what it was.
 */
export function isUnsupportedParameterText(
  text: string,
  param: string,
  markers: readonly string[] = UNSUPPORTED_PARAMETER_MARKERS,
): boolean {
  const lower = text.toLowerCase()
  const name = param.trim().toLowerCase()
  if (!name || !lower.includes(name)) return false
  return markers.some(marker => lower.includes(marker))
}

/** {@link isUnsupportedParameterText} over every message an error carries. */
export function isUnsupportedParameterError(
  error: unknown,
  param: string,
): boolean {
  return errorMessageTexts(error).some(text =>
    isUnsupportedParameterText(text, param),
  )
}

type DroppableParameter = {
  /** Top-level request-body key to drop. */
  key: string
  /** Whether `error` is the endpoint refusing this key. */
  isRejection: (error: unknown) => boolean
  /** Called once, when the key is dropped (latch it, log it). */
  onDropped?: () => void
}

/**
 * Send `body`; if the endpoint refuses one of `droppable`'s keys that the body
 * carries, drop that key and send again. Each key is dropped at most once;
 * any other failure, an abort, or a second refusal of the same key surfaces.
 */
export async function sendDroppingRejectedParameters<
  Body extends object,
  Result,
>(params: {
  body: Body
  send: (body: Body) => Promise<Result>
  signal: AbortSignal
  droppable: readonly DroppableParameter[]
}): Promise<Result> {
  let body = params.body
  const dropped = new Set<string>()
  while (true) {
    try {
      return await params.send(body)
    } catch (error) {
      if (params.signal.aborted) throw error
      const rejected = params.droppable.find(
        candidate =>
          !dropped.has(candidate.key) &&
          candidate.key in body &&
          candidate.isRejection(error),
      )
      if (!rejected) throw error
      dropped.add(rejected.key)
      rejected.onDropped?.()
      const { [rejected.key]: _dropped, ...rest } = body as Record<
        string,
        unknown
      >
      body = rest as Body
    }
  }
}

/**
 * `temperature` refused by an endpoint `samplingParams.ts` did not foresee
 * (hermes `auxiliary_client.py:9459-9465`): dropped and re-sent once. Not
 * latched — hermes does not remember it either, and the next request may be
 * to a model that takes it.
 */
export const TEMPERATURE_DROPPABLE: DroppableParameter = {
  key: 'temperature',
  isRejection: error => isUnsupportedParameterError(error, 'temperature'),
}
