// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The ACP hop a notification takes from the agent to the resident host.
 *
 * ## Why there is a hop at all
 *
 * The agent runs in the `occ --acp` child; the transport channel the hub
 * opened is held by the resident host *process*. So the tool cannot send a
 * `notify` itself — it can only ask the process that owns the channel to. This
 * module is the contract for that ask, and it is deliberately the narrowest
 * one that works: four fields in, one verdict out, no envelope, no address, no
 * peer. **The agent does not get to choose who is notified** — the host
 * resolves that from the task the running turn belongs to. An agent that could
 * name its own recipient would be an agent that could use the node's
 * credentials to message arbitrary peers.
 *
 * ## Why it is a request and not a notification
 *
 * `qianmo/input-accepted` and `qianmo/session-activity` are one-way; this one
 * is not, and the difference matters. A refusal — the sliding window is
 * closed, the peer is too old for the type, the hub is away — is information
 * the *model* needs, because the model's next move depends on it (say it once
 * and stop, versus repeat it into the void). A fire-and-forget notification
 * would make every outcome look identical from inside the turn.
 *
 * ## Why the types live in `src/` rather than in `@qianmo/resident`
 *
 * Both ends of this hop are base modules: the tool runs inside the ACP child
 * and the handler sits in `src/services/qianmo/resident.ts`. Putting the
 * contract in the package would make the child's bundle pull in the whole
 * resident host — the ACP SDK, the transport, the ledgers — for four field
 * names. The protocol-level shapes it *does* need (`NOTIFY_KINDS`,
 * `NOTIFY_SEVERITIES`) still come from `@qianmo/protocol`, which is the only
 * place they are allowed to be spelled.
 */

/** ACP ext method: agent → resident host, "please announce this". */
export const ACP_NOTIFY_METHOD = 'qianmo/notify'

/** What the `qianmo_notify` tool asks the host for. */
export interface QianmoNotifyRequest {
  /**
   * Which ACP session is asking.
   *
   * Load-bearing, not bookkeeping: it is how the host finds the running turn,
   * and through it the task, the hub address and the channel to answer on.
   * A request the host cannot attribute to a running turn is refused rather
   * than guessed at.
   */
  readonly sessionId: string
  readonly kind: string
  readonly severity: string
  readonly summary: string
  readonly detail?: string
  readonly dedupKey?: string
}

/**
 * What the host answers.
 *
 * Every branch is reported honestly, including the ones that mean "not yet":
 * the tool turns this into text the model reads, and a `queued` that
 * presented itself as `sent` would teach the model that its notifications
 * always land.
 */
export interface QianmoNotifyVerdict {
  readonly status: 'sent' | 'queued' | 'unsupported' | 'duplicate' | 'rejected'
  readonly detail?: string
  /** Set only when the sliding window is what held it back. */
  readonly retryAfterMs?: number
}

const VERDICT_STATUSES: ReadonlySet<string> = new Set([
  'sent',
  'queued',
  'unsupported',
  'duplicate',
  'rejected',
])

/**
 * Read a verdict off the wire.
 *
 * An unrecognized answer becomes `rejected` rather than an exception: the two
 * ends of this hop are one process pair that upgrades together, so a shape
 * mismatch means something is genuinely wrong — but the failure a *turn*
 * should see for that is "your notification did not go out", not a thrown
 * error that ends the turn.
 */
export function parseNotifyVerdict(
  value: Record<string, unknown> | null | undefined,
): QianmoNotifyVerdict {
  const status = value?.['status']
  if (typeof status !== 'string' || !VERDICT_STATUSES.has(status)) {
    return {
      status: 'rejected',
      detail: 'the resident host returned an unrecognized notify verdict',
    }
  }
  const detail = value?.['detail']
  const retryAfterMs = value?.['retryAfterMs']
  return {
    status: status as QianmoNotifyVerdict['status'],
    ...(typeof detail === 'string' ? { detail } : {}),
    ...(typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)
      ? { retryAfterMs }
      : {}),
  }
}
