// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The capability surface — the one file that decides what this component is
 * physically able to ask the sandbox daemon to do.
 *
 * ## The daemon's real wire shape (verified on the host, 2026-08-12)
 *
 * The supervisor is **not** REST. It is a "method name is the path segment" RPC:
 *
 * ```
 * POST {endpoint}/{methodName}
 * authorization: Bearer <token>
 * content-type: application/json
 * <JSON parameter object>
 * ```
 *
 * Source: the vendor SDK's `private async rpc(method, body)`, which does
 * `fetch(`${endpoint}/${method}`, { method: 'POST', … })`. Confirmed live:
 * `POST http://127.0.0.1:3676/listSandboxes` with a bearer and `{}` answered
 * HTTP 200.
 *
 * There are 31 such methods and **they all live on this one endpoint**, behind
 * this one bearer, including `destroySandbox`. There is no `/v1/` prefix, no
 * path parameter, no GET, and — the assumption that most needed correcting —
 * **no `touch` method at all**. An earlier version of this file routed `touch`,
 * `acquire` and `status` at invented REST paths; all three were wrong.
 *
 * ## Why this is a code artifact and not a config knob
 *
 * The daemon's credential has **no privilege tiers**: the bearer that lists
 * sandboxes is the bearer that destroys them (selection-m0.md §4). AC-6(c) —
 * "the agent cannot destroy its own sandbox" — therefore rests on exactly two
 * things: the daemon binding to loopback only (P0.7), and this component never
 * handing a destructive verb to that bearer. Learning that `destroySandbox` is
 * *one path segment away from the calls we do make* makes the allowlist more
 * load-bearing than it was under the invented REST shape, not less.
 *
 * Three layers, each of which alone would be defeated by a determined caller,
 * and which together are not:
 *
 * 1. **Type layer** — `SandboxDaemon` in `daemon.ts` declares `acquire` and
 *    `status`. There is no destructive member to call, so reaching one requires
 *    deliberately casting away the type.
 * 2. **Runtime layer** — every request is resolved through {@link resolveRoute}
 *    against {@link DAEMON_CAPABILITY_SURFACE}. An op that is not in the map is
 *    refused before any request is built, and the refusal is audited. This is
 *    the layer that catches the cast from layer 1. It is also the layer that
 *    builds the request **body**: a caller supplies a sandbox name and nothing
 *    else, so it cannot smuggle `policy`, `template` or `metadata` into an
 *    `acquireSandbox` call.
 * 3. **Shape layer** — {@link assertSurfaceIsSafe} runs on this module's own
 *    surface at import time, so a future edit that adds a destructive route to
 *    the allowlist cannot even be loaded. Under the real wire shape it gained a
 *    tooth: a route's path must be **exactly** `/` + its op name. Combined with
 *    the destructive-word scan on op names, that closes the "innocent name,
 *    dangerous path" hole by construction rather than by vocabulary — there is
 *    no name under which `destroySandbox` can be reached.
 *
 * The denylist below is **not** the mechanism. Security comes from the
 * allowlist; the denylist exists only so a refusal can say *why* in the audit
 * record, and so layer 3 has recognizable words to look for. It does not, and
 * cannot, enumerate every dangerous real method — `execCommand`, `writeFile`
 * and `updatePolicy` are all destructive enough in context and none of them
 * contains a scary word. They are refused for the reason that actually holds:
 * they are not on the allowlist.
 */

import { ActivatorEventType, type AuditLog } from './audit.js'

/**
 * Every operation this component is allowed to perform. There are two.
 *
 * The values are the daemon's real method names, verbatim, because the method
 * name *is* the path segment. That identity is enforced by
 * {@link assertSurfaceIsSafe}.
 */
export enum DaemonOp {
  /**
   * The daemon's documented single entry point, and — measured — the operation
   * that refreshes the idle clock.
   *
   * Vendor documentation: "idempotent — the same name always comes back to the
   * same sandbox, whatever state it was in". Measured on the host: a sandbox's
   * `lastActiveAt` moved from `2026-08-12T13:17:51.529Z` to
   * `2026-08-12T13:17:57.613Z` across a single `acquireSandbox` call issued
   * 6.1 s later — the idle clock was reset to *now*, not merely left alone. A
   * `frozen` sandbox transitions to `active`.
   *
   * So the wake verb and the keep-alive verb are **the same call**. See
   * `keepalive.ts` for what that costs us in type-level narrowing.
   */
  AcquireSandbox = 'acquireSandbox',
  /**
   * Read every sandbox's lifecycle row. Read-only, and the only way to read
   * state: the API has **no** by-id or by-name lookup, so a status read is a
   * list plus a client-side filter.
   */
  ListSandboxes = 'listSandboxes',
}

/**
 * The only HTTP method a route may use.
 *
 * One entry, not two, because the real API has exactly one: every method is a
 * POST to `/{methodName}`. A route declaring anything else is not "a stricter
 * verb", it is evidence that somebody has invented a shape the daemon does not
 * have — which is precisely the mistake this file is a correction of.
 */
export const ALLOWED_METHODS: readonly string[] = Object.freeze(['POST'])

/**
 * Every key a route is allowed to put in a request body.
 *
 * `acquireSandbox` also accepts `policy`, `template` and `metadata`. `policy`
 * carries `freezeAfterSeconds` / `stopAfterSeconds` / `archiveAfterSeconds` —
 * i.e. a caller who could reach it could disable the very thresholds
 * `keepalive.ts` refuses to let anyone disable. Keeping the body to `name`
 * means the wake call cannot become a policy edit by accident or by cast.
 */
export const ALLOWED_BODY_KEYS: readonly string[] = Object.freeze(['name'])

/**
 * Words that mark an operation as destructive.
 *
 * Classification aid only — see the module header. Anything not on the
 * allowlist is refused whether or not it matches one of these.
 */
export const DESTRUCTIVE_WORDS: readonly string[] = Object.freeze([
  'destroy',
  'delete',
  'remove',
  'revoke',
  'rebuild',
  'purge',
  'prune',
  'terminate',
  'kill',
  'wipe',
  'shutdown',
])

/** One entry of the allowlist. */
export interface DaemonRoute {
  readonly method: 'POST'
  /**
   * Path relative to the daemon's base URL. Must be `/` + the op name: the
   * daemon routes on the method name, so anything else is a lie about where
   * the request goes.
   */
  readonly path: string
  /**
   * The JSON parameter object, built here rather than passed in. The sandbox
   * name is the only thing a caller contributes.
   */
  readonly body: (sandboxName: string) => Record<string, unknown>
  /** Why this op is safe to expose, in one line. */
  readonly rationale: string
}

/**
 * The allowlist. Adding a third entry is a security change and should be
 * reviewed as one; {@link assertSurfaceIsSafe} refuses the obvious mistakes.
 */
export const DAEMON_CAPABILITY_SURFACE: ReadonlyMap<DaemonOp, DaemonRoute> =
  new Map<DaemonOp, DaemonRoute>([
    [
      DaemonOp.AcquireSandbox,
      {
        method: 'POST',
        path: '/acquireSandbox',
        body: name => ({ name }),
        rationale:
          'idempotent; refreshes the idle clock and moves state towards active, never towards gone',
      },
    ],
    [
      DaemonOp.ListSandboxes,
      {
        method: 'POST',
        path: '/listSandboxes',
        body: () => ({}),
        rationale: 'read-only; POST only because the whole API is POST',
      },
    ],
  ])

/** Why a call was refused. */
export type DenialReason =
  /** The op names a destructive action. */
  | 'destructive-op'
  /** The op is simply not on the allowlist. */
  | 'unknown-op'

/**
 * Thrown instead of performing an out-of-surface call.
 *
 * Carries the audited reason so a caller that swallows the error still cannot
 * make the refusal look like a success.
 */
export class CapabilityDeniedError extends Error {
  readonly op: string
  readonly reason: DenialReason

  constructor(op: string, reason: DenialReason) {
    super(
      `capability denied: "${op}" is outside the activator's daemon surface (${reason}); ` +
        `allowed: ${[...DAEMON_CAPABILITY_SURFACE.keys()].join(', ')}`,
    )
    this.name = 'CapabilityDeniedError'
    this.op = op
    this.reason = reason
  }
}

function classify(op: string): DenialReason {
  const lowered = op.toLowerCase()
  return DESTRUCTIVE_WORDS.some(word => lowered.includes(word))
    ? 'destructive-op'
    : 'unknown-op'
}

/** A resolved request: everything `daemon.ts` needs to put on the wire. */
export interface ResolvedRequest {
  readonly method: string
  readonly path: string
  readonly body: Record<string, unknown>
}

/**
 * The single gate between this component and the daemon's RPC surface.
 *
 * `op` is typed `string`, not `DaemonOp`, on purpose: the whole point is to be
 * the layer that still holds when someone has cast past the enum. Typing the
 * parameter narrowly would let the compiler argue the check is dead code.
 *
 * @throws CapabilityDeniedError for anything not on the allowlist, always after
 * recording {@link ActivatorEventType.CapabilityDenied}.
 */
export function resolveRoute(
  op: string,
  sandboxName: string,
  audit: AuditLog,
  now: number,
): ResolvedRequest {
  const route = DAEMON_CAPABILITY_SURFACE.get(op as DaemonOp)
  if (route === undefined) {
    const reason = classify(op)
    // Audited before the throw, so no `catch` anywhere upstream can erase the
    // record of the attempt.
    audit.record(ActivatorEventType.CapabilityDenied, now, {
      op,
      reason,
      sandboxName,
    })
    throw new CapabilityDeniedError(op, reason)
  }
  return {
    method: route.method,
    path: route.path,
    body: route.body(sandboxName),
  }
}

/** The ops this component can perform, for anyone who wants to assert on it. */
export function capabilitySurface(): readonly string[] {
  return [...DAEMON_CAPABILITY_SURFACE.keys()]
}

/**
 * Refuse to load a surface that could destroy anything.
 *
 * Called on this module's own allowlist at the bottom of the file, so a commit
 * that widens the surface the wrong way fails at import — which means it fails
 * in every test, in typecheck's sibling `bun test`, and in CI, rather than
 * failing in production on the one call that matters.
 *
 * Takes the surface as a parameter so the negative direction is testable: a
 * check that can only ever be fed the good value is a check nobody has seen
 * go red.
 */
export function assertSurfaceIsSafe(
  surface: ReadonlyMap<
    string,
    {
      method: string
      path: string
      body: (sandboxName: string) => Record<string, unknown>
    }
  >,
): void {
  // A fixed probe name: rendering the body is the only way to see what a route
  // actually sends, since bodies are built by a function.
  const probe = 'probe'
  for (const [op, route] of surface) {
    const lowered = op.toLowerCase()
    for (const word of DESTRUCTIVE_WORDS) {
      if (lowered.includes(word)) {
        throw new Error(
          `activator capability surface is unsafe: op "${op}" contains destructive word "${word}"`,
        )
      }
    }
    if (!ALLOWED_METHODS.includes(route.method)) {
      throw new Error(
        `activator capability surface is unsafe: op "${op}" uses method "${route.method}"; ` +
          `allowed: ${ALLOWED_METHODS.join(', ')}`,
      )
    }
    const rendered = route.path.toLowerCase()
    for (const word of DESTRUCTIVE_WORDS) {
      if (rendered.includes(word)) {
        throw new Error(
          `activator capability surface is unsafe: op "${op}" routes to "${route.path}", ` +
            `which contains destructive word "${word}"`,
        )
      }
    }
    // The daemon routes on the method name, so the path and the op must be the
    // same string. This is what makes the destructive-word scan above complete
    // rather than a vocabulary test: an op cannot reach a method it is not
    // named after, so there is no innocent name that lands on `destroySandbox`.
    if (route.path !== `/${op}`) {
      throw new Error(
        `activator capability surface is unsafe: op "${op}" routes to "${route.path}", ` +
          `but the daemon routes on the method name, so it must route to "/${op}"`,
      )
    }
    for (const key of Object.keys(route.body(probe))) {
      if (!ALLOWED_BODY_KEYS.includes(key)) {
        throw new Error(
          `activator capability surface is unsafe: op "${op}" sends body key "${key}"; ` +
            `allowed: ${ALLOWED_BODY_KEYS.join(', ')}`,
        )
      }
    }
  }
}

assertSurfaceIsSafe(DAEMON_CAPABILITY_SURFACE)
