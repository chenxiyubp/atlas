// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What this node's model-call layer can do, as reported to the console in
 * `status.capabilities` (design `providers-console-m1.md` §2.4).
 *
 * One function, one object, so P18.7's `qm provider status` reads every flag
 * from here instead of hard-coding them, and P18.8 adds `replayFilter` in the
 * same place. Each flag is backed by the module that implements it; the
 * constant there is pinned by a behavioural test.
 */
import { CHAT_EFFORT_HONORS_OVERRIDE } from './chatEffort.js'

export type ModelCompatCapabilities = {
  /**
   * The chat lane's `reasoning_effort` gate is `modelSupportsEffort()`, so an
   * explicit effort override reaches the wire (P18.5 Q-1). Before P18.5 the
   * gate was `isChatGPTCodexReasoningModel`, and the console must reject
   * `effort.send = always` on `openai-chat` for a node that does not report
   * this (design §3.4).
   */
  chatEffortHonorsOverride: boolean
}

export function getModelCompatCapabilities(): ModelCompatCapabilities {
  return { chatEffortHonorsOverride: CHAT_EFFORT_HONORS_OVERRIDE }
}
