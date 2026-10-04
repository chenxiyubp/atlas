/**
 * Prompt-flow methods for AcpAgent, attached to the prototype via
 * Object.assign. Kept in a sibling module to keep AcpAgent.ts under the
 * 500-line budget. The barrel (./index.ts) imports this module for its
 * side effect so the prototype is populated before any instance is built.
 *
 * Methods attached: prompt, setSessionConfigOption.
 */
import { randomUUID } from 'node:crypto'
import type {
  PromptRequest,
  PromptResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
} from '@agentclientprotocol/sdk'
import { forwardSessionUpdates } from '../bridge.js'
import type { ToolUseCache } from '../bridge.js'
import { promptToQueryInput } from '../promptConversion.js'
import { sanitizeTitle } from '../utils.js'
import { AcpAgent } from './AcpAgent.js'
import type { AcpSession } from './sessionTypes.js'
import { flattenConfigOptionValues } from './configOptions.js'
import { popNextPendingPrompt } from './promptQueue.js'
import {
  activateAcpSessionWorkspace,
  runInAcpWorkspaceTurn,
} from './sessionWorkspace.js'
import {
  getConnection,
  readClientCapabilities,
  syncSessionConfigState,
} from './internalAccessors.js'

// ── prompt ───────────────────────────────────────────────────────

async function prompt(
  this: AcpAgent,
  params: PromptRequest,
): Promise<PromptResponse> {
  const session = this.sessions.get(params.sessionId)
  if (!session) {
    throw new Error(`Session ${params.sessionId} not found`)
  }

  // Per message-id.mdx RFD: if the client supplied a `messageId` on the
  // PromptRequest, echo it back as `userMessageId` to confirm receipt.
  // We do not self-generate when omitted — the spec makes that optional and
  // staying quiet avoids surfacing IDs the client didn't ask to track.
  const userMessageId = params.messageId ?? undefined

  // Extract text/image content from the prompt
  const promptInput = promptToQueryInput(params.prompt)

  // Per prompt-turn.mdx, `prompt` is a required ContentBlock[] and an
  // effectively-empty prompt is malformed input — reject it with an
  // invalid_params error rather than fabricating a successful end_turn.
  if (!promptInput.trim()) {
    throw new Error('Prompt content is empty')
  }

  const promptCancelGeneration = session.cancelGeneration

  // Handle prompt queuing — if a prompt is already running, queue this one
  if (session.promptRunning) {
    const promptUuid = randomUUID()
    const cancelled = await new Promise<boolean>(resolve => {
      session.pendingQueue.push(promptUuid)
      session.pendingMessages.set(promptUuid, { resolve })
    })
    if (cancelled) {
      return { stopReason: 'cancelled' }
    }
  }

  if (session.cancelGeneration !== promptCancelGeneration) {
    return { stopReason: 'cancelled' }
  }

  // Reset cancellation only when this prompt is about to run. Queued prompts
  // must not clear the cancellation state for the active prompt.
  session.cancelled = false
  session.promptRunning = true

  try {
    // One operation owns the process-wide workspace at a time (issue #52).
    // The lock is taken HERE and not at the top of `prompt`: a second prompt
    // for the SAME session must keep waiting on `pendingQueue` above, where
    // `cancel()` can still resolve it, rather than sitting in the workspace
    // queue where nothing would wake it.
    return await runInAcpWorkspaceTurn(async (): Promise<PromptResponse> => {
      // A cancel may have arrived while this turn waited for the lock. Check
      // before touching anything: `session.cancelled` was cleared above, so
      // any `true` here was written after that by `cancel()`.
      if (session.cancelled) {
        return { stopReason: 'cancelled' }
      }
      // Reset the query engine's abort controller for a fresh query.
      // After a previous interrupt(), the internal controller is stuck in
      // aborted state — without this, submitMessage() fails immediately.
      session.queryEngine.resetAbortController()
      // Re-establish the whole of this session's workspace before the turn
      // runs: session id AND cwd AND the per-conversation caches. Switching the
      // session id alone was not enough — the turn still inherited the working
      // directory, CLAUDE.md and transcript file of whichever session happened
      // to touch them first (issue #44).
      activateAcpSessionWorkspace({
        sessionId: params.sessionId,
        cwd: session.cwd,
        projectDir: session.projectDir,
      })

      const sdkMessages = session.queryEngine.submitMessage(promptInput, {
        uuid: userMessageId,
      })

      const { stopReason, usage, error } = await forwardSessionUpdates(
        params.sessionId,
        sdkMessages,
        getConnection(this),
        session.queryEngine.getAbortSignal(),
        session.toolUseCache,
        readClientCapabilities(this),
        session.cwd,
        () => session.cancelled,
      )

      // If the session was cancelled during processing, return cancelled
      if (session.cancelled) {
        return { stopReason: 'cancelled' }
      }

      // Emit a session_info_update so Clients learn the session's display
      // title / last-activity timestamp via the stable v1 session/update
      // channel. The title is derived from the first user prompt.
      await emitSessionInfoUpdate(this, params.sessionId, promptInput)

      // A turn that ended in an error keeps its ACP stop reason (the protocol
      // has no error value, and editors key off the ones it has) and says what
      // went wrong in `_meta.claudeCode.error`. Without it an errored turn and
      // a completed one were the same `end_turn` to a client — a resident node
      // recorded a gateway 400 as a successful run.
      const turnError =
        error === undefined
          ? undefined
          : { ...error, ...turnErrorCode(session) }
      if (turnError !== undefined) {
        console.error(
          `[ACP] turn ended in an error: category=${turnError.category}` +
            `${turnError.code === undefined ? '' : ` code=${turnError.code}`}` +
            ` ${turnError.message}`,
        )
      }

      // Per session-usage.mdx RFD and the bundled SDK schema, PromptResponse
      // carries an optional `usage` field at the root with cumulative token
      // totals for the session. The field is UNSTABLE in v1 but is implemented
      // by all major ACP clients. We additionally mirror the same payload into
      // `_meta.claudeCode.usage` for consumers that read the vendor namespace.
      // thoughtTokens are reported as 0 until the bridge tracks them, but are
      // included in totalTokens so totals match the sum of components.
      const thoughtTokens = 0
      const usagePayload =
        usage === undefined
          ? undefined
          : {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cachedReadTokens: usage.cachedReadTokens,
              cachedWriteTokens: usage.cachedWriteTokens,
              thoughtTokens,
              totalTokens:
                usage.inputTokens +
                usage.outputTokens +
                usage.cachedReadTokens +
                usage.cachedWriteTokens +
                thoughtTokens,
            }
      const claudeCode = {
        ...(usagePayload === undefined ? {} : { usage: usagePayload }),
        ...(turnError === undefined ? {} : { error: turnError }),
      }
      return {
        stopReason,
        ...(usagePayload === undefined ? {} : { usage: usagePayload }),
        ...(userMessageId ? { userMessageId } : {}),
        ...(Object.keys(claudeCode).length === 0
          ? {}
          : { _meta: { claudeCode } }),
      }
    })
  } catch (err: unknown) {
    // Treat AbortError / cancellation-shaped errors as a turn cancellation
    // regardless of the session.cancelled flag, to close the race window
    // between interrupt() firing and cancel() setting the flag. Per
    // prompt-turn.mdx the Agent MUST return `cancelled` for aborts.
    const isAbort =
      err instanceof Error &&
      (err.name === 'AbortError' ||
        /abort|cancelled|interrupt/i.test(err.message))
    if (session.cancelled || isAbort) {
      return { stopReason: 'cancelled' }
    }

    // The ACP SDK answers an escaped error with `-32603 Internal error` and
    // keeps only its message, so the stack survives only if it is written
    // here (stderr; a resident node's `.err`).
    console.error('[ACP] prompt failed:', err)

    // Check for process death errors
    if (
      err instanceof Error &&
      (err.message.includes('terminated') ||
        err.message.includes('process exited'))
    ) {
      await this.teardownSession(params.sessionId)
      throw new Error(
        'The Claude Agent process exited unexpectedly. Please start a new session.',
      )
    }

    throw err
  } finally {
    // Resolve next pending prompt if any
    const nextPrompt = popNextPendingPrompt(session)
    if (nextPrompt) {
      session.promptRunning = true
      nextPrompt.resolve(false)
    } else {
      session.promptRunning = false
    }
  }
}

/**
 * The machine-readable code of the API error that ended the turn, when it has
 * one — `empty_response` for an empty model response that outlasted its
 * retries. Read from the diagnostics the provider layer stored on the error
 * message (`errorDetails`, JSON), not parsed out of the display text.
 *
 * The message looked at is the one QueryEngine's own `is_error` verdict is
 * taken from: the last assistant-or-user message.
 */
function turnErrorCode(session: AcpSession): { code?: string } {
  const last = session.queryEngine
    .getMessages()
    .findLast(m => m.type === 'assistant' || m.type === 'user')
  if (
    last?.type !== 'assistant' ||
    last.isApiErrorMessage !== true ||
    typeof last.errorDetails !== 'string'
  ) {
    return {}
  }
  try {
    const code = (JSON.parse(last.errorDetails) as { code?: unknown }).code
    return typeof code === 'string' ? { code } : {}
  } catch {
    return {}
  }
}

// ── setSessionConfigOption ───────────────────────────────────────

async function setSessionConfigOption(
  this: AcpAgent,
  params: SetSessionConfigOptionRequest,
): Promise<SetSessionConfigOptionResponse> {
  const session = this.sessions.get(params.sessionId)
  if (!session) {
    throw new Error('Session not found')
  }
  if (typeof params.value !== 'string') {
    throw new Error(
      `Invalid value for config option ${params.configId}: ${String(params.value)}`,
    )
  }

  const option = session.configOptions.find(o => o.id === params.configId)
  if (!option) {
    throw new Error(`Unknown config option: ${params.configId}`)
  }

  // Per session-config-options.mdx: value MUST be one of the values listed
  // in the option's options array. Reject unknown values with an error
  // rather than silently persisting them. Only `select` options carry an
  // options array; `boolean` options have no enumerated values.
  if (option.type === 'select') {
    const validValues = flattenConfigOptionValues(
      (option as { options?: unknown }).options,
    )
    if (!validValues.includes(params.value)) {
      throw new Error(
        `Invalid value '${params.value}' for config option ${params.configId}; must be one of: ${validValues.join(', ')}`,
      )
    }
  }

  const value = params.value

  if (params.configId === 'mode') {
    this.applySessionMode(params.sessionId, value)
    await getConnection(this).sessionUpdate({
      sessionId: params.sessionId,
      update: {
        sessionUpdate: 'current_mode_update',
        currentModeId: value,
      },
    })
  } else if (params.configId === 'model') {
    session.queryEngine.setModel(value)
  }

  syncSessionConfigState(this, session, params.configId, value)

  session.configOptions = session.configOptions.map(o =>
    o.id === params.configId && typeof o.currentValue === 'string'
      ? { ...o, currentValue: value }
      : o,
  )

  return { configOptions: session.configOptions }
}

// ── Private-field accessors ──────────────────────────────────────
//
// getConnection / readClientCapabilities / syncSessionConfigState are
// imported from ./internalAccessors.js (shared with sessionLifecycle.ts and
// createSessionMethod.ts). The session_info_update helper below is local to
// this module because it is only called from prompt().

/**
 * Emit a session_info_update notification carrying a derived session title
 * (truncated first user prompt) and the current last-activity timestamp.
 * Sent once per session — subsequent turns reuse the same title.
 *
 * This logic was originally the private `AcpAgent.maybeEmitSessionInfoUpdate`
 * method on the shell class. It is only called from the prompt flow, so it
 * lives here to avoid the `noUnusedPrivateClassMembers` false positive that
 * cast-based access would otherwise trigger on the shell.
 */
async function emitSessionInfoUpdate(
  agent: AcpAgent,
  sessionId: string,
  firstPrompt: string,
): Promise<void> {
  const session = agent.sessions.get(sessionId)
  if (!session) return
  // sessionInfoTitleSent is tracked via toolUseCache to avoid reshaping
  // AcpSession; use a dedicated per-session flag instead.
  const cache = session.toolUseCache as ToolUseCache & {
    __sessionInfoTitleSent?: boolean
  }
  if (cache.__sessionInfoTitleSent) return
  cache.__sessionInfoTitleSent = true
  const title = sanitizeTitle(firstPrompt).slice(0, 100)
  try {
    await getConnection(agent).sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'session_info_update',
        ...(title ? { title } : {}),
        updatedAt: new Date().toISOString(),
      },
    })
  } catch (err) {
    console.error('[ACP] Failed to send session_info_update:', err)
  }
}

// ── Prototype attachment ─────────────────────────────────────────

Object.assign(AcpAgent.prototype, {
  prompt,
  setSessionConfigOption,
})
