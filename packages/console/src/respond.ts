// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The handful of response shapes every route on this console answers with.
 *
 * Lifted out of `http.ts` unchanged when the account routes arrived
 * (`accountsHttp.ts`): the two files have to answer in the same voice — the
 * same headers on a document, the same `{ error: { code, message } }` body on
 * a refusal — and a second copy of these helpers would be a second place for
 * the voice to drift. `test/legacyParity.test.ts` pins that the move changed
 * no byte.
 */

import type { ConsoleFailure } from './deps.js'

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const

/**
 * Headers for anything a browser renders.
 *
 * `no-referrer` matters here rather than being boilerplate: the page URL can
 * carry the token (`?token=…`), and a default `Referer` would hand it to
 * whatever the operator clicks next.
 */
export const DOCUMENT_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
} as const

/** Error vocabulary of this surface. `code` is for clients, not for users. */
type ConsoleErrorCode =
  | ConsoleFailure['code']
  | 'unauthorized'
  | 'forbidden'
  | 'method_not_allowed'
  | 'internal'
  | 'unavailable'
  | 'limit'

export function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  })
}

export function fail(
  status: number,
  code: ConsoleErrorCode,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ error: { code, message } }, status, headers)
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      ...DOCUMENT_HEADERS,
    },
  })
}

export function notFound(message: string): Response {
  return fail(404, 'not_found', message)
}

export function methodNotAllowed(allowed: readonly string[]): Response {
  return fail(405, 'method_not_allowed', `允许的方法：${allowed.join(', ')}`, {
    allow: allowed.join(', '),
  })
}

/** A redirect that carries no body. `303` so a POST becomes a GET. */
export function seeOther(
  location: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  })
}

/**
 * Biggest form body this will read.
 *
 * The forms here have two short fields. Anything larger is not a submission,
 * and refusing it by `Content-Length` costs nothing while reading it costs
 * whatever the sender decided.
 */
const MAX_FORM_BODY_BYTES = 4096

/** A urlencoded form body, or `null` when this is not one. */
export async function readForm(
  request: Request,
): Promise<URLSearchParams | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_FORM_BODY_BYTES) return null
  const type = request.headers.get('content-type') ?? ''
  if (!type.includes('application/x-www-form-urlencoded')) return null
  try {
    const text = await request.text()
    if (text.length > MAX_FORM_BODY_BYTES) return null
    return new URLSearchParams(text)
  } catch {
    return null
  }
}

/** A JSON object body, or `null` for anything else (arrays and scalars included). */
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await request.json()
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}
