/**
 * Message copy shared across the messages modules: interruption / rejection
 * strings, the synthetic-message markers and the synthetic model name.
 */

export const INTERRUPT_MESSAGE = '[Request interrupted by user]'
export const INTERRUPT_MESSAGE_FOR_TOOL_USE =
  '[Request interrupted by user for tool use]'

/**
 * The abort marker for a turn nobody cancelled.
 *
 * A resident node runs unattended, and its inactivity watchdog
 * (`@qianmo/resident`'s `ResidentInactivityWatchdog`) ends a silent turn by
 * travelling the same abort path a Ctrl+C does. Reusing {@link
 * INTERRUPT_MESSAGE} for it wrote "[Request interrupted by user]" into the
 * transcript of a machine no user was sitting at — and that is the record
 * people read first: `timings.jsonl` said `turn_failed:
 * ResidentInactivityError` while the transcript said a human cancelled it, so
 * the infrastructure failure was read as a deliberate one and the
 * investigation stopped (issue #39).
 *
 * Deliberately a **new** string rather than a change to INTERRUPT_MESSAGE:
 * that one is a user-visible surface of the base CLI, matched by the
 * first-prompt skip patterns in `utils/sessionStorage/entries.ts` and
 * `utils/session/sessionStoragePortable.ts`, counted by `/insights`, and
 * rendered specially by the REPL. Those patterns were widened to cover both
 * spellings; the `/insights` counter deliberately was not, because
 * "user interruptions" on an unattended node must stay zero.
 */
export const INACTIVITY_ABORT_MESSAGE =
  '[Request aborted by the resident watchdog: no agent activity]'
export const INACTIVITY_ABORT_MESSAGE_FOR_TOOL_USE =
  '[Request aborted by the resident watchdog: no agent activity for tool use]'

/** Shared prefix of the two user-interrupt markers above. */
const USER_INTERRUPT_MARKER_PREFIX = '[Request interrupted by user'

/**
 * Whether a transcript text block is the marker a **person** cancelled a turn.
 *
 * The one caller that has to get this right is `/insights`, which reports a
 * "user interruptions" count. It used to test `content.includes('[Request
 * interrupted by user')` inline, in two places; with a second abort marker in
 * circulation the literal has to be spelled once, next to the strings it
 * matches, or the next marker silently starts being counted as a human.
 */
export function isUserInterruptionText(text: string): boolean {
  return text.includes(USER_INTERRUPT_MARKER_PREFIX)
}

export const CANCEL_MESSAGE =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed."
export const REJECT_MESSAGE =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."
export const REJECT_MESSAGE_WITH_REASON_PREFIX =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n"
export const SUBAGENT_REJECT_MESSAGE =
  'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.'
export const SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX =
  'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\n'
export const PLAN_REJECTION_PREFIX =
  'The agent proposed a plan that was rejected by the user. The user chose to stay in plan mode rather than proceed with implementation.\n\nRejected plan:\n'

/**
 * Shared guidance for permission denials, instructing the model on appropriate workarounds.
 */
export const DENIAL_WORKAROUND_GUIDANCE =
  `IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, ` +
  `e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, ` +
  `e.g. do not use your ability to run tests to execute non-test actions. ` +
  `You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. ` +
  `If you believe this capability is essential to complete the user's request, STOP and explain to the user ` +
  `what you were trying to do and why you need this permission. Let the user decide how to proceed.`

export const NO_RESPONSE_REQUESTED = 'No response requested.'

// Synthetic tool_result content inserted by ensureToolResultPairing when a
// tool_use block has no matching tool_result. Exported so HFI submission can
// reject any payload containing it — placeholder satisfies pairing structurally
// but the content is fake, which poisons training data if submitted.
export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]'

export const SYNTHETIC_MODEL = '<synthetic>'

export const SYNTHETIC_MESSAGES = new Set([
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  INACTIVITY_ABORT_MESSAGE,
  INACTIVITY_ABORT_MESSAGE_FOR_TOOL_USE,
  CANCEL_MESSAGE,
  REJECT_MESSAGE,
  NO_RESPONSE_REQUESTED,
])
