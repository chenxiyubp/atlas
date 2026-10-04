// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SessionNotification } from '@agentclientprotocol/sdk'
import { ProtocolErrorCode } from '@qianmo/protocol'
import type {
  ResidentTurnInput,
  ResidentTurnPort,
  ResidentTurnResult,
} from './contracts.js'
import {
  ResidentInactivityWatchdog,
  ResidentUpstreamHealth,
  type ResidentInactivityOptions,
} from './inactivity.js'
import type { ResidentTimingRecorder } from './timings.js'

/**
 * ACP stop reasons that are **not** a completed answer.
 *
 * Only `end_turn` means "the agent said what it had to say". The rest end the
 * turn with a body that is empty or cut short, and reporting those as
 * `outcome: 'completed'` would hand the requesting node a well-formed success
 * envelope it has no way to tell apart from a real one. Anything unknown is
 * left alone: a stop reason this build has never heard of is not evidence of
 * failure, and inventing one would be worse than the silence.
 */
const FAILED_STOP_REASONS = new Map<string, string>([
  ['cancelled', 'ACP turn was cancelled'],
  ['refusal', 'ACP turn ended in a refusal'],
  ['max_tokens', 'ACP turn hit the token ceiling before finishing'],
  ['max_turn_requests', 'ACP turn hit the request ceiling before finishing'],
])

/**
 * The reasons a turn fails with when the agent reports a model error, spelled
 * here and nowhere else.
 *
 * `task.result{failed}` has one error code for every execution failure
 * (`E_TASK_FAILED`) and one free-text `reason`. A new protocol code would make
 * every older peer refuse the whole result (rule N-1, `@qianmo/protocol`
 * errors.ts), so the kind of failure travels as the start of `reason` instead,
 * and {@link turnFailureKind} is the only code that reads it back — the same
 * arrangement as {@link turnStepDedupKey}.
 */
const MODEL_EMPTY_RESPONSE_REASON =
  'Model returned only empty responses; retries exhausted'
const MODEL_ERROR_REASON = 'Model request failed'

/** How much of the agent's error text a reason carries. */
const MAX_MODEL_ERROR_DETAIL = 300

/**
 * The code the agent reports for an empty model response that outlasted its
 * retries: `EmptyModelResponseError.code` in `@ant/model-provider`, carried in
 * `_meta.claudeCode.error.code` (`src/services/acp/agent/promptFlow.ts`). This
 * package is a leaf and cannot import either; the two spellings are held
 * together by `tests/integration/qianmo-empty-model-response.test.ts`.
 */
const EMPTY_RESPONSE_ERROR_CODE = 'empty_response'

/**
 * What kind of failure a `task.result` reason records, when it is one this
 * package wrote for a model error; `undefined` for every other reason.
 */
export function turnFailureKind(
  reason: string,
): 'model_empty_response' | 'model_error' | undefined {
  if (reason.startsWith(MODEL_EMPTY_RESPONSE_REASON)) {
    return 'model_empty_response'
  }
  if (reason.startsWith(MODEL_ERROR_REASON)) return 'model_error'
  return undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * The model error the agent reported for a turn, if it reported one.
 *
 * ACP has no error stop reason, so an errored turn still arrives as `end_turn`
 * and says what went wrong in `_meta.claudeCode.error`. Read as a failure
 * whenever that is an object: a malformed message must not turn a failure the
 * agent did report back into a completion.
 */
function reportedModelError(
  meta: unknown,
):
  | { readonly kind: 'model_empty_response' | 'model_error'; reason: string }
  | undefined {
  const error = recordOf(recordOf(recordOf(meta)?.claudeCode)?.error)
  if (error === undefined) return undefined
  const empty = error.code === EMPTY_RESPONSE_ERROR_CODE
  const prefix = empty ? MODEL_EMPTY_RESPONSE_REASON : MODEL_ERROR_REASON
  const detail =
    typeof error.message === 'string'
      ? error.message
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, MAX_MODEL_ERROR_DETAIL)
      : ''
  return {
    kind: empty ? 'model_empty_response' : 'model_error',
    reason: detail === '' ? prefix : `${prefix}: ${detail}`,
  }
}

/**
 * The `_meta` a watchdog cancel carries, so the agent on the other end can
 * record the turn as aborted by a machine rather than interrupted by a user.
 *
 * The base agent reads exactly this shape (`src/services/acp/agent/AcpAgent.ts`)
 * and writes `[Request aborted by the resident watchdog: …]` into the
 * transcript instead of `[Request interrupted by user]`. Before it existed,
 * every unattended timeout left a session record claiming a human had
 * cancelled it — while `timings.jsonl` recorded the truth two files away
 * (issue #39).
 */
export const RESIDENT_INACTIVITY_CANCEL_META: Record<string, unknown> = {
  qianmo: { cancelReason: 'inactivity' },
}

export const ACP_INPUT_ACCEPTED_METHOD = 'qianmo/input-accepted'
export const ACP_INPUT_STATUS_METHOD = 'qianmo/input-status'
export const ACP_SESSION_ACTIVITY_METHOD = 'qianmo/session-activity'
/**
 * Agent → host: the model endpoint answered a request with this HTTP status.
 *
 * One-way and failure-only. The host cannot see the agent's upstream traffic,
 * and without this the only thing a refused credential produces out here is
 * silence — which the watchdog then reports as "no activity", pointing every
 * reader at the model instead of the key (issue #37).
 */
export const ACP_UPSTREAM_STATUS_METHOD = 'qianmo/upstream-status'

export interface AcpPromptConnection {
  /**
   * Ask the agent to end the turn running in `sessionId` (ACP `session/cancel`).
   *
   * Optional because the only caller is the inactivity watchdog, and a
   * connection that cannot cancel still serves every other path — the watchdog
   * degrades to "fail the turn, let the old prompt wind down on its own",
   * which is what every other mid-flight failure already does.
   */
  cancel?(params: {
    readonly sessionId: string
    /**
     * ACP `_meta`, carrying **why**. `session/cancel` has no reason field of
     * its own, so the one piece of information that separates "a person
     * pressed Ctrl+C" from "this node's watchdog gave up" travels here — see
     * {@link RESIDENT_INACTIVITY_CANCEL_META}. An agent that ignores `_meta`
     * (as ACP allows) still cancels; it just records the turn the old way.
     */
    readonly _meta?: Record<string, unknown>
  }): Promise<void>
  extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>
  prompt(params: {
    readonly sessionId: string
    readonly messageId: string
    readonly prompt: readonly [{ readonly type: 'text'; readonly text: string }]
  }): Promise<{
    readonly userMessageId?: string | null
    readonly stopReason?: string
    /** Carries `claudeCode.error` when the turn ended in a model error. */
    readonly _meta?: Record<string, unknown> | null
  }>
}

/**
 * One step of a turn, on its way to whoever asked for the turn.
 *
 * The port raises these; **wiring them to the network is the host's job** —
 * this package knows nothing about envelopes, channels or peers, and the one
 * message type that can carry a step (`notify`) is addressed from facts only
 * the host holds (who sent the task, on which channel).
 */
export interface ResidentTurnProgress {
  readonly sessionId: string
  /** The network message whose turn this step belongs to. */
  readonly networkMsgId: string
  /** One line, already human-readable. */
  readonly summary: string
  readonly severity: 'info' | 'warn' | 'error'
  /** Sender-side idempotency key, stable across a redelivery of the same step. */
  readonly dedupKey: string
  /** File paths the tool named, when it named any. Folded away by the reader. */
  readonly detail?: string
}

/**
 * How many steps one turn may report.
 *
 * **A cap rather than a time window**, and the difference matters. The ceiling
 * that actually protects the person is `LIMITS.notifyRatePerMinute` downstream,
 * and it does not drop what it refuses — it *queues* it. So a turn that fires
 * a hundred steps does not flood the console; it makes the console show the
 * fortieth step two minutes after the answer already arrived. Stale progress is
 * worse than absent progress: it describes work that visibly finished.
 *
 * A sliding window would need a timer inside this class to flush what it held,
 * and this class is constructed by a dozen unit tests that have no business
 * growing one (see the constructor). A hard cap needs no clock at all.
 *
 * 24 is chosen against the budget, not against taste: at one step per tool a
 * turn under this cap cannot on its own exhaust a minute's worth of the human
 * budget, even when two sessions run at once.
 */
const MAX_PROGRESS_PER_TURN = 24

/**
 * Failures get their own budget, and it is not the one above.
 *
 * With a single counter the arithmetic runs the wrong way: a turn that starts
 * 24 tools spends the whole budget on `开始跑…` lines, and the failure of tool
 * 27 — the one line in the whole turn that the operator actually has to act on
 * — is the one that gets dropped. A separate, smaller reserve means the
 * informative half survives a chatty turn.
 */
const MAX_FAILURES_PER_TURN = 8

/**
 * File paths carried with one step.
 *
 * Bounded because a single edit tool can name a hundred files and the summary
 * beside it is one line: the point of the list is "which corner of the tree is
 * this touching", and the first few answer that as well as all of them do.
 */
const MAX_LOCATIONS_PER_STEP = 8

/**
 * ACP tool kinds rendered as a verb. Anything unlisted keeps the bare title.
 *
 * A `Map`, not an object literal, because the key comes off the wire: an
 * object-literal lookup reaches `Object.prototype`, so a tool declaring
 * `kind: "constructor"` (or `toString`, `valueOf`) would hand back a function
 * instead of `undefined` — and that function would be stringified into a
 * `notify` summary and rendered in the operator's transcript.
 * `Readonly<Record<string, string>>` is a compile-time claim; it does nothing
 * to the runtime lookup.
 */
const TOOL_KIND_VERBS = new Map<string, string>([
  ['read', '读'],
  ['edit', '改'],
  ['delete', '删'],
  ['move', '移动'],
  ['search', '搜'],
  ['execute', '执行'],
  ['fetch', '取'],
])

/**
 * The one tool that must not spend a progress row on itself.
 *
 * Its whole purpose is to put a line in the operator's transcript. Reporting
 * the call *and* delivering what the call produced says the same thing twice,
 * and the tool-call half is the useless one: it arrives as a bare tool name
 * (its `kind` is not one this file has a verb for, so the fallback prints the
 * title verbatim) immediately above the sentence the agent actually wrote.
 * 2026-08-28 on p11 that read:
 *
 *     qianmo_notify
 *     hello.txt 未能创建
 *
 * Matching on the title is the only handle available here — the step carries
 * no tool identity beyond it. That is worth stating because it looks fragile:
 * if the agent ever reports a different title for this tool, the row comes
 * back, which is the safe direction to fail (a redundant row, never a missing
 * one). The spelling is pinned against the host's constant by
 * `src/services/qianmo/__tests__/notifyToolName.test.ts` — this package is a
 * leaf and cannot import `src/`, so the two copies are held together by a test
 * rather than by an import.
 */
export const SELF_REPORTING_TOOL_TITLE = 'qianmo_notify'

/** The two moments a tool call is reported in; see {@link turnStepDedupKey}. */
export type TurnStepPhase = 'start' | 'failed'

/** A step's `dedupKey`, taken apart. */
export interface TurnStepKey {
  /** The network message whose turn raised the step. */
  readonly networkMsgId: string
  readonly toolCallId: string
  readonly phase: TurnStepPhase
}

/**
 * The `dedupKey` every step carries, spelled here and nowhere else.
 *
 * It is also the only thing a receiver can use to tell a step from a message
 * the agent sent itself with `qianmo_notify`. Both arrive as `notify`, and a
 * step is always `kind: 'task'`, which the agent may choose too. The protocol
 * has no field for "raised by the node", and cannot get one cheaply:
 * `isNotifyPayload` accepts only the fields it knows, so older receivers
 * would reject a payload with a new field. `qm watch` needs the distinction
 * because a watch job stays silent unless the agent itself decides a person
 * must hear about it (`resident-botization.md` §4.1⑤). Steps are process data
 * there. So the shape of this key is the marker, and
 * {@link parseTurnStepDedupKey} is the only code that reads it.
 */
export function turnStepDedupKey(
  networkMsgId: string,
  toolCallId: string,
  phase: TurnStepPhase,
): string {
  return `${networkMsgId}:${toolCallId}:${phase}`
}

/**
 * Take a {@link turnStepDedupKey} apart, or `undefined` when `key` does not
 * have that shape.
 *
 * The first colon ends the message id and the last colon starts the phase,
 * so a tool call id that contains colons still parses. A message id that
 * contains a colon does not parse correctly. The reader that uses this
 * (`qm watch`) mints its own message ids, which never contain one.
 */
export function parseTurnStepDedupKey(key: string): TurnStepKey | undefined {
  const first = key.indexOf(':')
  const last = key.lastIndexOf(':')
  if (first <= 0 || last <= first + 1) return undefined
  const phase = key.slice(last + 1)
  if (phase !== 'start' && phase !== 'failed') return undefined
  return {
    networkMsgId: key.slice(0, first),
    toolCallId: key.slice(first + 1, last),
    phase,
  }
}

function progressText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

export class AcpResidentTurnPort implements ResidentTurnPort {
  #connection: AcpPromptConnection
  readonly #accepted = new Map<string, () => Promise<void>>()
  readonly #active = new Map<
    string,
    {
      readonly input: ResidentTurnInput
      readonly content: string[]
      firstContent: boolean
      /** Tool starts reported; stops at {@link MAX_PROGRESS_PER_TURN}. */
      progressCount: number
      /** Tool failures reported; stops at {@link MAX_FAILURES_PER_TURN}. */
      failureCount: number
      /** Tool calls already announced, so an update never repeats a start. */
      readonly announcedTools: Set<string>
    }
  >()
  readonly #onProgress: ((progress: ResidentTurnProgress) => void) | undefined
  readonly #timings: ResidentTimingRecorder | undefined
  readonly #now: () => number
  readonly #inactivity: ResidentInactivityWatchdog | undefined
  readonly #upstreamHealth: ResidentUpstreamHealth

  constructor(
    connection: AcpPromptConnection,
    options: {
      readonly timings?: ResidentTimingRecorder
      readonly now?: () => number
      /**
       * Turn on the inactivity watchdog (design §3.B10). **Off when absent**,
       * on purpose: this port is constructed by a dozen unit tests that have no
       * business growing a timer, and the production host passes it explicitly.
       */
      readonly inactivity?: ResidentInactivityOptions
      /**
       * Where upstream statuses are remembered. Injectable so a test can pin
       * the clock the staleness window is measured against; the port makes its
       * own when the caller does not care.
       */
      readonly upstreamHealth?: ResidentUpstreamHealth
      /**
       * Where a turn's steps go. **Absent means the port reports none**, which
       * is what every unit test and every non-networked caller wants: raising
       * steps nobody consumes would only cost the work of formatting them.
       */
      readonly onProgress?: (progress: ResidentTurnProgress) => void
    } = {},
  ) {
    this.#connection = connection
    this.#onProgress = options.onProgress
    this.#timings = options.timings
    this.#now = options.now ?? Date.now
    this.#upstreamHealth =
      options.upstreamHealth ?? new ResidentUpstreamHealth()
    this.#inactivity =
      options.inactivity === undefined
        ? undefined
        : new ResidentInactivityWatchdog({
            upstreamHealth: this.#upstreamHealth,
            ...options.inactivity,
            // Wired here rather than by the caller because "how to stop an ACP
            // turn" is knowledge this port has and the watchdog deliberately
            // does not.
            onExpired: turn => {
              void this.#connection.cancel?.({
                sessionId: turn.sessionId,
                _meta: RESIDENT_INACTIVITY_CANCEL_META,
              })
            },
          })
  }

  /** The inactivity budget in force, or `0` when the watchdog is off. */
  get inactivityMs(): number {
    return this.#inactivity?.timeoutMs ?? 0
  }

  /** What this node last heard from its model endpoint. Observation only. */
  get upstreamHealth(): ResidentUpstreamHealth {
    return this.#upstreamHealth
  }

  /**
   * Record one upstream HTTP status reported by the ACP child.
   *
   * Called from the `qianmo/upstream-status` notification handler and from the
   * host's own startup credential probe — the two are the same fact arriving
   * from different directions, so they share one memory rather than producing
   * two answers that can disagree.
   */
  handleUpstreamStatus(params: Record<string, unknown>): void {
    const status = params.status
    if (typeof status !== 'number') return
    const detail = params.detail
    this.#upstreamHealth.record(
      status,
      typeof detail === 'string' && detail.length > 0 ? detail : undefined,
    )
  }

  /**
   * The turn running in `sessionId` right now, or `undefined`.
   *
   * The one consumer is outbound `notify`: an agent asking to announce
   * something has to be attributed to the task that is paying for its turn, or
   * the host has no address to send to and no `contextId` to group by. Asking
   * *per session* rather than "whatever is running" matters even though the
   * node gate is currently global — invariant #15 says a correctness claim
   * must not lean on the gate's granularity, and this is one of those claims.
   *
   * Read-only by construction: the entry disappears in `execute`'s `finally`,
   * so a notification arriving after its turn ended finds nothing and is
   * refused rather than charged to whichever task happens to be next.
   */
  activeTurn(sessionId: string): ResidentTurnInput | undefined {
    return this.#active.get(sessionId)?.input
  }

  replaceConnection(connection: AcpPromptConnection): void {
    this.#connection = connection
  }

  async isAccepted(input: ResidentTurnInput): Promise<boolean> {
    const result = await this.#connection.extMethod(ACP_INPUT_STATUS_METHOD, {
      sessionId: input.sessionId,
      messageId: input.messageId,
    })
    return result.accepted === true
  }

  async execute(
    input: ResidentTurnInput,
    onAccepted: () => Promise<void>,
  ): Promise<ResidentTurnResult> {
    let admission: Promise<void> | null = null
    const accept = (): Promise<void> => {
      admission ??= onAccepted()
      return admission
    }
    this.#accepted.set(input.messageId, accept)
    const active = {
      input,
      content: [],
      firstContent: false,
      progressCount: 0,
      failureCount: 0,
      announcedTools: new Set<string>(),
    }
    this.#active.set(input.sessionId, active)
    try {
      const ask = async () =>
        await this.#connection.prompt({
          sessionId: input.sessionId,
          messageId: input.messageId,
          prompt: [{ type: 'text', text: input.prompt }],
        })
      // Guarded, not raced by hand: a rejection from the watchdog travels the
      // same path an ACP transport error already does, so it reaches the
      // sender as a `task.result{failed}` carrying the watchdog's reason
      // rather than a bare timeout.
      const response =
        this.#inactivity === undefined
          ? await ask()
          : await this.#inactivity.guard(
              { sessionId: input.sessionId, messageId: input.messageId },
              ask,
            )
      if (response.userMessageId === input.messageId) await accept()
      else if (admission !== null) await admission
      const failure = FAILED_STOP_REASONS.get(response.stopReason ?? '')
      const modelError =
        failure === undefined ? reportedModelError(response._meta) : undefined
      if (failure !== undefined || modelError !== undefined) {
        this.#timings?.record({
          stage: 'turn_failed',
          at: this.#now(),
          sessionId: input.sessionId,
          inputMessageId: input.messageId,
          ...(input.networkMsgId === undefined
            ? {}
            : { networkMsgId: input.networkMsgId }),
          ...(input.agent === undefined ? {} : { agent: input.agent }),
          error:
            modelError === undefined
              ? (response.stopReason ?? 'unknown')
              : modelError.kind,
        })
        return {
          outcome: 'failed',
          code: ProtocolErrorCode.E_TASK_FAILED,
          reason: failure ?? modelError?.reason ?? MODEL_ERROR_REASON,
        }
      }
      this.#timings?.record({
        stage: 'turn_completed',
        at: this.#now(),
        sessionId: input.sessionId,
        inputMessageId: input.messageId,
        ...(input.networkMsgId === undefined
          ? {}
          : { networkMsgId: input.networkMsgId }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
      })
      return { outcome: 'completed', content: active.content.join('') }
    } catch (error) {
      this.#timings?.record({
        stage: 'turn_failed',
        at: this.#now(),
        sessionId: input.sessionId,
        inputMessageId: input.messageId,
        ...(input.networkMsgId === undefined
          ? {}
          : { networkMsgId: input.networkMsgId }),
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        error: error instanceof Error ? error.name : 'unknown',
      })
      throw error
    } finally {
      this.#accepted.delete(input.messageId)
      if (this.#active.get(input.sessionId) === active) {
        this.#active.delete(input.sessionId)
      }
    }
  }

  handleSessionUpdate(params: SessionNotification): void {
    // Every update counts as a sign of life, including ones for a session this
    // port is not currently running a turn for (a no-op on the watchdog) and
    // including `agent_thought_chunk` — a model thinking out loud is exactly
    // the long-running turn B10 must not kill.
    this.#inactivity?.touch(params.sessionId)
    const active = this.#active.get(params.sessionId)
    if (active === undefined) return
    const kind = params.update.sessionUpdate
    if (kind === 'agent_message_chunk') {
      const content = params.update.content
      if (content.type === 'text') active.content.push(content.text)
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.#reportToolStep(active, params.update as Record<string, unknown>)
      return
    }
    if (kind !== 'agent_message_chunk' && kind !== 'agent_thought_chunk') {
      return
    }
    if (active.firstContent) return
    active.firstContent = true
    const input = active.input
    this.#timings?.record({
      stage: 'first_content',
      at: this.#now(),
      sessionId: input.sessionId,
      inputMessageId: input.messageId,
      ...(input.networkMsgId === undefined
        ? {}
        : { networkMsgId: input.networkMsgId }),
      ...(input.agent === undefined ? {} : { agent: input.agent }),
    })
  }

  /**
   * Turn one tool-call update into at most one step.
   *
   * **A tool is announced when it starts, and again only if it fails.** The
   * successful end of a tool needs no line of its own — the next tool's start
   * already says the previous one finished, and spending a second message on
   * "…and it worked" halves how many tools fit under the cap.
   *
   * `agent_thought_chunk` and `agent_message_chunk` are deliberately not steps:
   * they arrive per token, and the one message type that can carry a step is
   * metered as an interruption of a person (`notify.ts`). Progress here is
   * discrete by construction, never streamed.
   */
  #reportToolStep(
    active: {
      readonly input: ResidentTurnInput
      progressCount: number
      failureCount: number
      readonly announcedTools: Set<string>
    },
    update: Record<string, unknown>,
  ): void {
    const onProgress = this.#onProgress
    const networkMsgId = active.input.networkMsgId
    // No consumer, or a turn nobody asked for over the network (local mail):
    // there is no peer this step belongs to, so there is nothing to raise.
    if (onProgress === undefined || networkMsgId === undefined) return

    const toolCallId = progressText(update['toolCallId'])
    if (toolCallId === undefined) return
    const status = progressText(update['status'])
    const failed = status === 'failed'
    const started = !active.announcedTools.has(toolCallId)
    if (!started && !failed) return
    // A failure re-announces once; a second `failed` update for the same call
    // does not. The key carries the phase so the two are distinct records.
    const phase: TurnStepPhase = failed ? 'failed' : 'start'
    const dedupKey = turnStepDedupKey(networkMsgId, toolCallId, phase)
    if (failed && active.announcedTools.has(`${toolCallId}#failed`)) return

    // Silently stop rather than queue: see MAX_PROGRESS_PER_TURN on why a step
    // delivered after the answer is worse than one never sent. The two budgets
    // are separate so a chatty turn cannot starve the failures.
    if (failed) {
      if (active.failureCount >= MAX_FAILURES_PER_TURN) return
    } else if (active.progressCount >= MAX_PROGRESS_PER_TURN) {
      return
    }
    const title = progressText(update['title'])
    // 通知工具自己不占一行——它的产出就是一行，见 SELF_REPORTING_TOOL_TITLE。
    // 位置是刻意的：在预算**检查**之后、预算**扣减**之前。于是被跳过的调用一分额度
    // 都不花，后面真正的工具不会因为它而少报一条——一轮里连着调二十次通知工具，也
    // 不该把 MAX_PROGRESS_PER_TURN 耗在几行根本不会出现的过程上。
    if (title === SELF_REPORTING_TOOL_TITLE) return
    const verb = TOOL_KIND_VERBS.get(String(update['kind']))
    const summary =
      title === undefined
        ? failed
          ? '一个工具失败了'
          : '开始跑一个工具'
        : verb === undefined
          ? title
          : `${verb}：${title}`

    // 工具报了它碰哪些文件就带上，报了才带——**不去猜**，也不去正则解析模型
    // 说了什么。带上的是路径本身，不是一个宣称有结构的东西：`notify` 的载荷
    // 只有字符串，把「改了哪些文件」硬编成一种格式，等于在没有协议支持的地方
    // 私自定义一个，而下一个读它的人无从知道那是约定还是巧合。
    const locations = Array.isArray(update['locations'])
      ? (update['locations'] as unknown[])
          .map(one =>
            typeof one === 'object' && one !== null
              ? progressText((one as Record<string, unknown>)['path'])
              : undefined,
          )
          .filter((one): one is string => one !== undefined)
          .slice(0, MAX_LOCATIONS_PER_STEP)
      : []

    if (failed) active.failureCount += 1
    else active.progressCount += 1
    active.announcedTools.add(toolCallId)
    if (failed) active.announcedTools.add(`${toolCallId}#failed`)
    onProgress({
      sessionId: active.input.sessionId,
      networkMsgId,
      summary: failed ? `${summary} — 失败` : summary,
      severity: failed ? 'warn' : 'info',
      dedupKey,
      ...(locations.length === 0 ? {} : { detail: locations.join('\n') }),
    })
  }

  async handleInputAccepted(params: Record<string, unknown>): Promise<void> {
    // Admission is itself a sign of life, and it is the step most likely to be
    // slow on a loaded agent. Touching an unarmed session is a no-op, so an
    // unrecognized notification still flips nothing — the invariant that
    // `#accepted` below enforces is untouched.
    if (typeof params.sessionId === 'string') {
      this.#inactivity?.touch(params.sessionId)
    }
    const messageId = params.messageId
    if (typeof messageId !== 'string') return
    await this.#accepted.get(messageId)?.()
  }
}
