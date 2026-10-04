// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ActivationOutcome, StageStats } from '@qianmo/activator'
import { durationsOf, statsOf } from '@qianmo/activator'
import type { ResidentTimingEvent } from '@qianmo/resident/timings'

export interface P31Sample {
  readonly msgId: string
  readonly status: 'responsive' | 'incomplete' | 'failed'
  readonly acceptedAt: number
  readonly wakeStartedAt?: number
  readonly readyAt?: number
  readonly detectedAt?: number
  readonly admittedAt?: number
  readonly readAt?: number
  readonly firstContentAt?: number
  readonly turnCompletedAt?: number
  readonly transportReceiptedAt?: number
  readonly acceptToWakeMs?: number
  readonly wakeToReadyMs?: number
  readonly readyToDetectedMs?: number
  readonly acceptToReadMs?: number
  readonly acceptToFirstContentMs?: number
  readonly acceptToTurnCompleteMs?: number
  readonly reason?: string
}

export interface P31FactorCheck {
  readonly expectedResidentReconnect: number
  readonly actualResidentReconnect: number | null
  readonly expectedHostKeepalive: number
  readonly actualHostKeepalive: number
  readonly pass: boolean
}

export interface P31Report {
  readonly expectedRounds: number
  readonly samples: number
  readonly responsive: number
  readonly incomplete: number
  readonly failed: number
  readonly latencyLimitMs: number
  readonly acceptToRead: StageStats
  readonly acceptToFirstContent: StageStats
  readonly acceptToTurnComplete: StageStats
  readonly pass: boolean
  readonly entries: readonly P31Sample[]
}

export function checkP31Factors(
  residentEvents: readonly ResidentTimingEvent[],
  expectedResidentReconnect: number,
  actualHostKeepalive: number,
  expectedHostKeepalive: number,
): P31FactorCheck {
  const latestReady = residentEvents
    .filter(event => event.stage === 'acp_ready')
    .sort((left, right) => right.at - left.at)[0]
  const actualResidentReconnect = latestReady?.activityReconnectFactor ?? null
  return {
    expectedResidentReconnect,
    actualResidentReconnect,
    expectedHostKeepalive,
    actualHostKeepalive,
    pass:
      actualResidentReconnect === expectedResidentReconnect &&
      actualHostKeepalive === expectedHostKeepalive,
  }
}

function firstAt(
  events: readonly ResidentTimingEvent[],
  stage: ResidentTimingEvent['stage'],
): number | undefined {
  return events.find(event => event.stage === stage)?.at
}

export function buildP31Report(
  outcomes: readonly ActivationOutcome[],
  residentEvents: readonly ResidentTimingEvent[],
  options: { readonly expectedRounds: number; readonly latencyLimitMs: number },
): P31Report {
  const entries: P31Sample[] = outcomes.flatMap(outcome => {
    if (outcome.status === 'refused') return []
    const timing = outcome.timings
    const events = residentEvents.filter(
      event => event.networkMsgId === timing.msgId,
    )
    const detectedAt = firstAt(events, 'detected')
    const admittedAt = firstAt(events, 'admitted')
    const readAt = firstAt(events, 'read')
    const firstContentAt = firstAt(events, 'first_content')
    const turnCompletedAt = firstAt(events, 'turn_completed')
    const turnFailed = events.find(event => event.stage === 'turn_failed')
    const activationDurations = durationsOf(timing)
    const responsive =
      outcome.status === 'forwarded' &&
      readAt !== undefined &&
      firstContentAt !== undefined &&
      turnCompletedAt !== undefined &&
      turnFailed === undefined
    const failed = outcome.status === 'failed' || turnFailed !== undefined
    return [
      {
        msgId: timing.msgId,
        status: responsive ? 'responsive' : failed ? 'failed' : 'incomplete',
        acceptedAt: timing.acceptedAt,
        ...(timing.wakeStartedAt === undefined
          ? {}
          : { wakeStartedAt: timing.wakeStartedAt }),
        ...(timing.readyAt === undefined ? {} : { readyAt: timing.readyAt }),
        ...(detectedAt === undefined ? {} : { detectedAt }),
        ...(admittedAt === undefined ? {} : { admittedAt }),
        ...(readAt === undefined ? {} : { readAt }),
        ...(firstContentAt === undefined ? {} : { firstContentAt }),
        ...(turnCompletedAt === undefined ? {} : { turnCompletedAt }),
        ...(timing.forwardedAt === undefined
          ? {}
          : { transportReceiptedAt: timing.forwardedAt }),
        ...(activationDurations.acceptToWakeMs === undefined
          ? {}
          : { acceptToWakeMs: activationDurations.acceptToWakeMs }),
        ...(activationDurations.wakeToReadyMs === undefined
          ? {}
          : { wakeToReadyMs: activationDurations.wakeToReadyMs }),
        ...(timing.readyAt === undefined || detectedAt === undefined
          ? {}
          : { readyToDetectedMs: detectedAt - timing.readyAt }),
        ...(readAt === undefined
          ? {}
          : { acceptToReadMs: readAt - timing.acceptedAt }),
        ...(firstContentAt === undefined
          ? {}
          : {
              acceptToFirstContentMs: firstContentAt - timing.acceptedAt,
            }),
        ...(turnCompletedAt === undefined
          ? {}
          : {
              acceptToTurnCompleteMs: turnCompletedAt - timing.acceptedAt,
            }),
        ...(outcome.status === 'failed'
          ? { reason: outcome.reason }
          : turnFailed?.error === undefined
            ? {}
            : { reason: turnFailed.error }),
      },
    ]
  })

  const pick = (key: keyof P31Sample): number[] =>
    entries.flatMap(entry => {
      const value = entry[key]
      return typeof value === 'number' ? [value] : []
    })
  const acceptToRead = statsOf(pick('acceptToReadMs'))
  const acceptToFirstContent = statsOf(pick('acceptToFirstContentMs'))
  const acceptToTurnComplete = statsOf(pick('acceptToTurnCompleteMs'))
  const responsive = entries.filter(
    entry => entry.status === 'responsive',
  ).length
  const incomplete = entries.filter(
    entry => entry.status === 'incomplete',
  ).length
  const failed = entries.filter(entry => entry.status === 'failed').length

  return {
    expectedRounds: options.expectedRounds,
    samples: entries.length,
    responsive,
    incomplete,
    failed,
    latencyLimitMs: options.latencyLimitMs,
    acceptToRead,
    acceptToFirstContent,
    acceptToTurnComplete,
    pass:
      entries.length === options.expectedRounds &&
      responsive === options.expectedRounds &&
      acceptToFirstContent.count === options.expectedRounds &&
      acceptToFirstContent.p95Ms <= options.latencyLimitMs,
    entries,
  }
}
