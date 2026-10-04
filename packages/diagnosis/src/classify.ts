// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The classifier: an ordered set of rules over structured evidence.
 *
 * ## Why rules and not a model
 *
 * Three reasons, in order of how much they matter here:
 *
 * 1. **A diagnosis has to be auditable.** AC-7's second beat is an operator
 *    reading "this task died of X". "The classifier felt it was X" is not a
 *    thing anyone can check, and every one of these five causes has a fact
 *    behind it that either exists or does not.
 * 2. **Model neutrality (AC-5).** A classifier that needed a provider would put
 *    a model call on the failure path — the one path most likely to be running
 *    while the provider is the thing that failed.
 * 3. **It is deterministic**, so the same failure gets the same name twice, and
 *    a wrong answer is a bug with a location rather than a tuning problem.
 *
 * ## Order is the design
 *
 * Structured evidence first, text second. The reason is the 137 problem
 * (`observation.ts`): a killed process looks identical whoever killed it, so a
 * text-first classifier picks between timeout and OOM by vocabulary — which is
 * to say, by accident. `timeoutEnforced` and `oomKillDelta` are facts recorded
 * by whoever did the killing, and they are consulted before anything is read.
 *
 * When both structured signals fire — we killed it on the deadline *and* the
 * kernel's OOM counter moved — the answer is OOM, and the timeout is kept in
 * `alternatives`. A task that hit its ceiling and was still running when the
 * clock ran out is a memory problem first: raising the deadline changes
 * nothing, raising the ceiling might.
 */

import { FailureCause, SUGGESTED_ACTIONS } from './taxonomy.js'
import {
  killedBySignal,
  textOf,
  type FailureObservation,
} from './observation.js'

/** How much the classifier is standing behind the name it gave. */
export type DiagnosisConfidence = 'high' | 'medium' | 'low'

/** One named cause, the evidence for it, and what to do. */
export interface Diagnosis {
  readonly cause: FailureCause
  readonly confidence: DiagnosisConfidence
  /**
   * Why this name and not another, in the order the rules found it. Each entry
   * names the field it came from, so a reader can go check.
   */
  readonly evidence: readonly string[]
  readonly suggestedAction: string
  /** Causes that also had evidence, strongest first. Usually empty. */
  readonly alternatives: readonly FailureCause[]
}

/** Text patterns per cause. Corroboration, never the first thing consulted. */
const PATTERNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [FailureCause.OutOfMemory]: [
    'out of memory',
    'javascript heap out of memory',
    'cannot allocate memory',
    'memoryerror',
    'std::bad_alloc',
    'oom-killer',
    'oomkilled',
    'killed process',
  ],
  [FailureCause.DiskFull]: [
    'enospc',
    'no space left on device',
    'disk quota exceeded',
    'edquot',
    'write error: no space',
  ],
  [FailureCause.QuotaExhausted]: [
    'rate limit',
    'rate_limit',
    'quota exceeded',
    'insufficient_quota',
    'insufficient quota',
    'credit balance is too low',
    'billing hard limit',
    'usage limit reached',
    'too many requests',
  ],
  [FailureCause.MissingDependency]: [
    'command not found',
    // Deliberately **not** a bare "no such file or directory": ENOENT is what
    // a task gets for opening any missing file, and a rule that broad would
    // call every missing input a missing dependency.
    'cannot find module',
    'modulenotfounderror',
    'no module named',
    'executable file not found',
    'is not recognized as an internal or external command',
    'not found in path',
  ],
  [FailureCause.Timeout]: [
    'timed out',
    'timeout exceeded',
    'deadline exceeded',
    'etimedout',
  ],
})

function matched(text: string, cause: FailureCause): string | null {
  for (const pattern of PATTERNS[cause] ?? []) {
    if (text.includes(pattern)) return pattern
  }
  return null
}

interface Finding {
  readonly cause: FailureCause
  readonly confidence: DiagnosisConfidence
  readonly evidence: readonly string[]
}

const CONFIDENCE_RANK: Readonly<Record<DiagnosisConfidence, number>> =
  Object.freeze({ high: 2, medium: 1, low: 0 })

/**
 * Name the cause of one failure.
 *
 * Never throws and never returns "failed": the worst case is
 * {@link FailureCause.Unknown} with the evidence that was available, which is
 * the answer AC-7 asks us not to dress up as something else.
 */
export function classifyFailure(observation: FailureObservation): Diagnosis {
  const text = textOf(observation)
  const findings: Finding[] = []

  // --- structured evidence, in the order that resolves the 137 ambiguity ---

  if (observation.oomKillDelta !== undefined && observation.oomKillDelta > 0) {
    findings.push({
      cause: FailureCause.OutOfMemory,
      confidence: 'high',
      evidence: [
        `oomKillDelta=${observation.oomKillDelta} — the kernel's OOM counter moved while this task ran`,
      ],
    })
  }
  if (observation.timeoutEnforced === true) {
    findings.push({
      cause: FailureCause.Timeout,
      confidence: 'high',
      evidence: [
        'timeoutEnforced=true — our own supervisor sent the kill when the deadline passed',
        ...(observation.timeoutMs === undefined
          ? []
          : [`timeoutMs=${observation.timeoutMs}`]),
      ],
    })
  }
  if (observation.httpStatus === 429) {
    findings.push({
      cause: FailureCause.QuotaExhausted,
      confidence: 'high',
      evidence: [
        `httpStatus=429 from ${observation.service ?? 'an upstream service'}`,
      ],
    })
  }
  if (observation.exitCode === 127) {
    findings.push({
      cause: FailureCause.MissingDependency,
      confidence: 'high',
      evidence: [
        'exitCode=127 — the shell could not find the program it was asked to run',
      ],
    })
  }

  // --- corroboration from captured output ---

  for (const cause of [
    FailureCause.DiskFull,
    FailureCause.OutOfMemory,
    FailureCause.QuotaExhausted,
    FailureCause.MissingDependency,
  ]) {
    const hit = matched(text, cause)
    if (hit !== null) {
      findings.push({
        cause,
        // Text alone is medium: a task can print the word "quota" while dying
        // of something else entirely.
        confidence: 'medium',
        evidence: [`captured output contains ${JSON.stringify(hit)}`],
      })
    }
  }

  // Killed by SIGKILL, and our own supervisor says it was not the one that sent
  // it. Something outside this system reclaimed the process, and on a Linux
  // host that is overwhelmingly the OOM killer — measured, and the reason this
  // rule exists: a Bun process that exhausts memory dies by SIGKILL having
  // written **nothing at all**, so the text rules above have nothing to read.
  //
  // Medium, not high: an operator's `kill -9` looks identical. The high-confidence
  // answer for this case is `oomKillDelta`, which a host with cgroup v2 can read
  // and a developer laptop cannot.
  if (
    observation.timeoutEnforced === false &&
    killedBySignal(observation, 'SIGKILL') &&
    (observation.oomKillDelta ?? 0) === 0
  ) {
    findings.push({
      cause: FailureCause.OutOfMemory,
      confidence: 'medium',
      evidence: [
        'killed by SIGKILL while timeoutEnforced=false — our supervisor did not send it, so something outside did',
      ],
    })
  }

  // A deadline that elapsed, with the process killed, and nobody claiming to
  // have enforced it: still a timeout, but the weakest kind of finding, because
  // "it ran past its deadline and died" is also what an OOM near the deadline
  // looks like.
  if (
    observation.timeoutEnforced !== true &&
    observation.timeoutMs !== undefined &&
    observation.durationMs !== undefined &&
    observation.durationMs >= observation.timeoutMs &&
    killedBySignal(observation, 'SIGKILL')
  ) {
    findings.push({
      cause: FailureCause.Timeout,
      confidence: 'low',
      evidence: [
        `durationMs=${observation.durationMs} reached timeoutMs=${observation.timeoutMs} and the process was killed`,
      ],
    })
  }
  const timeoutText = matched(text, FailureCause.Timeout)
  if (timeoutText !== null) {
    findings.push({
      cause: FailureCause.Timeout,
      confidence: 'medium',
      evidence: [`captured output contains ${JSON.stringify(timeoutText)}`],
    })
  }

  if (findings.length === 0) {
    return {
      cause: FailureCause.Unknown,
      confidence: 'low',
      evidence: describeNothing(observation),
      suggestedAction: SUGGESTED_ACTIONS[FailureCause.Unknown],
      alternatives: [],
    }
  }

  // Best finding wins; ties keep the earlier one, which is why the structured
  // rules run first. Everything else that had evidence is reported as an
  // alternative rather than dropped — a diagnosis that hides its second-best
  // guess is one nobody can argue with.
  const ranked = [...findings].sort(
    (a, b) => CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence],
  )
  const best = ranked[0] as Finding
  const evidence = findings
    .filter(finding => finding.cause === best.cause)
    .flatMap(finding => finding.evidence)
  const alternatives = [
    ...new Set(
      ranked.filter(finding => finding.cause !== best.cause).map(f => f.cause),
    ),
  ]
  return {
    cause: best.cause,
    confidence: best.confidence,
    evidence,
    suggestedAction: SUGGESTED_ACTIONS[best.cause],
    alternatives,
  }
}

/** What we can say about a failure that matched nothing. */
function describeNothing(observation: FailureObservation): readonly string[] {
  const notes: string[] = []
  if (observation.exitCode !== undefined && observation.exitCode !== null) {
    notes.push(`exitCode=${observation.exitCode}`)
  }
  if (observation.signal !== undefined && observation.signal !== null) {
    notes.push(`signal=${observation.signal}`)
  }
  if ((observation.stderr ?? '').trim() === '') {
    notes.push('stderr was empty')
  }
  if (notes.length === 0) notes.push('no usable evidence was captured')
  return notes
}
