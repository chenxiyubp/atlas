// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Verify a local audit trail against anchors held by the second location. */

import { digestOf, readTrail } from '@qianmo/audit'
import type { WitnessAnchor, WitnessEvidence } from './anchor.js'
import {
  verifyWitnessAnchor,
  witnessAnchorOf,
  witnessReceivedAtOf,
} from './anchor.js'
import { DEFAULT_WITNESS_ANCHOR_INTERVAL_MS } from './sender.js'

/** Design §4.3: after two periods without evidence, raise an alert. */
export const DEFAULT_WITNESS_STALE_AFTER_MS =
  2 * DEFAULT_WITNESS_ANCHOR_INTERVAL_MS

export type WitnessVerificationIssue =
  | { readonly kind: 'bad_signature'; readonly seq: number }
  | {
      readonly kind: 'head_mismatch'
      readonly seq: number
      readonly expected: string
      readonly actual: string | null
    }
  | {
      readonly kind: 'unwitnessed_tail'
      readonly from: number
      readonly to: number
      readonly count: number
    }
  | {
      /**
       * Only with {@link VerifyWitnessOptions.prefix}: valid anchors at
       * sequence numbers past the end of this copy, left uncompared. `from`
       * and `to` are the lowest and highest such anchor seq.
       */
      readonly kind: 'uncovered'
      readonly from: number
      readonly to: number
      readonly count: number
    }
  | {
      readonly kind: 'stale'
      readonly ageMs: number | null
      readonly thresholdMs: number
    }

export interface WitnessVerification {
  /** At least one valid, published prefix hash disagrees with the local chain. */
  readonly tampered: boolean
  /**
   * No valid anchor at all, or the trail runs past the newest anchor while the
   * witness has accepted nothing within the threshold. A trail whose head is
   * already anchored is never stale, however old that receipt: design §4.3.
   */
  readonly stale: boolean
  readonly coveredThrough: number | null
  readonly issues: readonly WitnessVerificationIssue[]
}

export interface VerifyWitnessOptions {
  readonly trailPath: string
  /** Bare anchors remain comparable, but only receipts count as fresh. */
  readonly anchors: readonly WitnessEvidence[]
  readonly publicKey: string
  readonly now?: () => number
  readonly staleAfterMs?: number
  /**
   * The trail is a copy of a prefix of the node's chain — an audit mirror
   * pulled on a timer — rather than the chain itself.
   *
   * Off (the default), an anchor past the end of the trail is a mismatch:
   * the witness holds a statement about a record this chain no longer has,
   * which on the node's own file is exactly what truncation looks like.
   * On, the same anchor only means the copy has not caught up yet: it is left
   * uncompared and reported as `uncovered`, never as tampering. Anchors
   * inside the copy are compared exactly as before, so a rewrite of anything
   * the copy does hold is still `tampered`.
   */
  readonly prefix?: boolean
}

export interface WitnessStaleness {
  /** No valid receipt, or the newest one is older than the threshold. */
  readonly stale: boolean
  readonly ageMs: number | null
  readonly thresholdMs: number
  /** Signatures that passed and therefore count as prefix evidence. */
  readonly validAnchors: readonly WitnessAnchor[]
  readonly issues: readonly Extract<
    WitnessVerificationIssue,
    { readonly kind: 'bad_signature' | 'stale' }
  >[]
}

export interface CheckWitnessStalenessOptions {
  readonly anchors: readonly WitnessEvidence[]
  readonly publicKey: string
  readonly now?: () => number
  readonly staleAfterMs?: number
}

/**
 * The witness-host check from design §4.4: it needs only evidence it stores,
 * so an operator can schedule it without reading a compromised node's disk.
 *
 * It can only say that no new anchor has arrived. A sender does not resend an
 * unchanged head, so an idle node and a silenced one look the same here; only
 * {@link verifyAuditWitness}, which also reads the trail, can tell them apart.
 */
export function checkWitnessStaleness(
  options: CheckWitnessStalenessOptions,
): WitnessStaleness {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_WITNESS_STALE_AFTER_MS
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
    throw new Error('witness stale threshold must be a non-negative integer')
  }
  const issues: Array<
    Extract<
      WitnessVerificationIssue,
      { readonly kind: 'bad_signature' | 'stale' }
    >
  > = []
  const validAnchors: WitnessAnchor[] = []
  let latestReceivedAt: number | null = null
  for (const evidence of options.anchors) {
    const anchor = witnessAnchorOf(evidence)
    if (!verifyWitnessAnchor(anchor, options.publicKey)) {
      issues.push({ kind: 'bad_signature', seq: anchor.seq })
      continue
    }
    validAnchors.push(anchor)
    const receivedAt = witnessReceivedAtOf(evidence)
    if (receivedAt !== null) {
      latestReceivedAt = Math.max(latestReceivedAt ?? receivedAt, receivedAt)
    }
  }
  const ageMs =
    latestReceivedAt === null
      ? null
      : Math.max(0, (options.now ?? Date.now)() - latestReceivedAt)
  const stale = ageMs === null || ageMs > staleAfterMs
  if (stale) {
    issues.push({ kind: 'stale', ageMs, thresholdMs: staleAfterMs })
  }
  return { stale, ageMs, thresholdMs: staleAfterMs, validAnchors, issues }
}

/**
 * Verify every signed anchor against the trail at the moment it is read.
 *
 * This is intentionally an on-read action, per design §4.4: the person who
 * consults a chain must receive its trust verdict in the same operation. A
 * scheduled stale check is supplementary and uses {@link checkWitnessStaleness}
 * with only the anchors stored on the witness host.
 */
export function verifyAuditWitness(
  options: VerifyWitnessOptions,
): WitnessVerification {
  const trail = readTrail(options.trailPath)
  const staleness = checkWitnessStaleness(options)
  const valid = staleness.validAnchors
  // Receipt age is evidence of a silent sender only where there is something
  // to send: records past the newest statement the witness holds. Without
  // them, an idle node and a stopped one leave the same harmless gap.
  const newest = valid.reduce<number | null>(
    (max, anchor) => Math.max(max ?? 0, anchor.seq),
    null,
  )
  const stale =
    staleness.stale && (newest === null || trail.records.length > newest)
  const issues: WitnessVerificationIssue[] = staleness.issues.filter(
    issue => issue.kind !== 'stale' || stale,
  )

  let tampered = false
  let coveredThrough: number | null = null
  const uncovered: number[] = []
  for (const anchor of valid) {
    if (options.prefix === true && anchor.seq > trail.records.length) {
      uncovered.push(anchor.seq)
      continue
    }
    const record = trail.records.at(anchor.seq - 1)
    const actual =
      record === undefined || record.seq !== anchor.seq
        ? null
        : digestOf(record)
    if (actual !== anchor.head) {
      tampered = true
      issues.push({
        kind: 'head_mismatch',
        seq: anchor.seq,
        expected: anchor.head,
        actual,
      })
      continue
    }
    coveredThrough = Math.max(coveredThrough ?? 0, anchor.seq)
  }

  if (!tampered && coveredThrough !== null) {
    const tail = trail.records.slice(coveredThrough)
    if (tail.length > 0) {
      issues.push({
        kind: 'unwitnessed_tail',
        from: tail[0]!.seq,
        to: tail.at(-1)!.seq,
        count: tail.length,
      })
    }
  }
  if (uncovered.length > 0) {
    issues.push({
      kind: 'uncovered',
      from: Math.min(...uncovered),
      to: Math.max(...uncovered),
      count: uncovered.length,
    })
  }
  return { tampered, stale, coveredThrough, issues }
}

/** Human-readable witness output for a future CLI, console, or alert runner. */
export function formatWitnessVerification(
  verification: WitnessVerification,
): readonly string[] {
  const lines = [
    `witness: tampered=${String(verification.tampered)} stale=${String(verification.stale)}`,
  ]
  for (const issue of verification.issues) {
    if (issue.kind === 'bad_signature') {
      lines.push(`bad_signature: anchor seq ${issue.seq} was ignored`)
    } else if (issue.kind === 'head_mismatch') {
      lines.push(
        `head_mismatch: anchor seq ${issue.seq} expected ${issue.expected}, local ${issue.actual ?? 'missing'}`,
      )
    } else if (issue.kind === 'unwitnessed_tail') {
      lines.push(
        `unwitnessed_tail: seq ${issue.from}..${issue.to} 共 ${issue.count} 条尚未被任何锚点覆盖`,
      )
    } else if (issue.kind === 'uncovered') {
      lines.push(
        `uncovered: anchor seq ${issue.from}..${issue.to} 共 ${issue.count} 个在本副本末尾之后，未比对`,
      )
    } else if (issue.ageMs === null) {
      lines.push('stale: no valid witness anchor is available')
    } else {
      lines.push(
        `stale: last anchor is ${issue.ageMs} ms old, over ${issue.thresholdMs} ms`,
      )
    }
  }
  return lines
}
