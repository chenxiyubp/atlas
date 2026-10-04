// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A resident node's inactivity watchdog must not leave a transcript claiming a
 * user cancelled the turn (issue #39).
 *
 * The failure this pins was not that the turn failed — `timings.jsonl` had
 * that right, as `turn_failed: ResidentInactivityError`. It was that the
 * *other* record, the one an investigator opens first, said `[Request
 * interrupted by user]` on a machine nobody was sitting at, and reading it
 * ended the investigation. So the assertions here are about the two records
 * agreeing, and about the one downstream consumer that counts the string.
 *
 * No `mock.module` anywhere: every module under test is importable as-is.
 */
import { describe, expect, test } from 'bun:test'
import {
  createUserInterruptionMessage,
  INACTIVITY_ABORT_MESSAGE,
  INACTIVITY_ABORT_MESSAGE_FOR_TOOL_USE,
  interruptionReasonFromAbort,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  isUserInterruptionText,
  RESIDENT_INACTIVITY_ABORT_REASON,
  SYNTHETIC_MESSAGES,
} from '../messages.js'
import { extractFirstPromptFromHead } from '../session/sessionStoragePortable.js'
import { SKIP_FIRST_PROMPT_PATTERN } from '../sessionStorage/entries.js'

/** The text a transcript entry would carry, as the query loop writes it. */
function markerFor(reason: unknown, toolUse = false): string {
  const message = createUserInterruptionMessage({
    toolUse,
    reason: interruptionReasonFromAbort(reason),
  })
  const content = message.message.content as { text: string }[]
  return content[0]!.text
}

describe('an abort nobody performed', () => {
  test('the watchdog reason produces its own marker, not the user one', () => {
    expect(markerFor(RESIDENT_INACTIVITY_ABORT_REASON)).toBe(
      INACTIVITY_ABORT_MESSAGE,
    )
    expect(markerFor(RESIDENT_INACTIVITY_ABORT_REASON, true)).toBe(
      INACTIVITY_ABORT_MESSAGE_FOR_TOOL_USE,
    )
  })

  test('every other abort keeps the user wording, byte for byte', () => {
    // Ctrl+C aborts with no reason at all; a third-party ACP client may abort
    // with anything. Neither is evidence that no user was involved, so both
    // must land on the string that has always been there.
    for (const reason of [undefined, 'interrupt', 'anything else', {}, 42]) {
      expect(markerFor(reason)).toBe(INTERRUPT_MESSAGE)
      expect(markerFor(reason, true)).toBe(INTERRUPT_MESSAGE_FOR_TOOL_USE)
    }
  })

  test('the base constant is untouched', () => {
    // The value itself is a user-visible surface with consumers outside this
    // repo's control. The fix adds a string; it does not edit this one.
    expect(INTERRUPT_MESSAGE).toBe('[Request interrupted by user]')
    expect(INTERRUPT_MESSAGE_FOR_TOOL_USE).toBe(
      '[Request interrupted by user for tool use]',
    )
  })
})

describe('what /insights counts as a user interruption', () => {
  test('the watchdog marker is not one', () => {
    // `extractToolStats` in src/commands/insights.ts asks exactly this
    // predicate, in both of the places that used to inline the literal. An
    // unattended node's "user interruptions" count has to stay zero.
    expect(
      isUserInterruptionText(markerFor(RESIDENT_INACTIVITY_ABORT_REASON)),
    ).toBe(false)
    expect(
      isUserInterruptionText(markerFor(RESIDENT_INACTIVITY_ABORT_REASON, true)),
    ).toBe(false)
  })

  test('a real user interruption still is', () => {
    expect(isUserInterruptionText(markerFor(undefined))).toBe(true)
    expect(isUserInterruptionText(markerFor(undefined, true))).toBe(true)
    // Counted inside a larger block too, which is how transcripts carry it.
    expect(isUserInterruptionText(`prefix ${INTERRUPT_MESSAGE} suffix`)).toBe(
      true,
    )
  })
})

describe('the synthetic-marker surfaces that already knew about interrupts', () => {
  test('both new markers are synthetic messages', () => {
    expect(SYNTHETIC_MESSAGES.has(INACTIVITY_ABORT_MESSAGE)).toBe(true)
    expect(SYNTHETIC_MESSAGES.has(INACTIVITY_ABORT_MESSAGE_FOR_TOOL_USE)).toBe(
      true,
    )
  })

  test('the first-prompt skip pattern skips them', () => {
    // Otherwise the marker becomes the session's title in `--resume`.
    expect(SKIP_FIRST_PROMPT_PATTERN.test(INACTIVITY_ABORT_MESSAGE)).toBe(true)
    expect(
      SKIP_FIRST_PROMPT_PATTERN.test(INACTIVITY_ABORT_MESSAGE_FOR_TOOL_USE),
    ).toBe(true)
    expect(SKIP_FIRST_PROMPT_PATTERN.test(INTERRUPT_MESSAGE)).toBe(true)
    expect(SKIP_FIRST_PROMPT_PATTERN.test('a real prompt')).toBe(false)
  })

  test('the portable head-scanner skips them too', () => {
    // Second copy of the same pattern, in the module the VS Code extension
    // shares. The two drifting apart is exactly what this asserts against.
    const head = [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: INACTIVITY_ABORT_MESSAGE },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'the real first prompt' },
      }),
      '',
    ].join('\n')
    expect(extractFirstPromptFromHead(head)).toBe('the real first prompt')
  })
})
