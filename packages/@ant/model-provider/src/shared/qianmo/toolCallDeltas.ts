// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Assembling streamed Chat Completions `tool_calls` deltas into tool calls
 * (P18.5, hermes #9; design `providers-console-m1.md` §5.6 row 9).
 *
 * 规则来源 NousResearch/hermes-agent（MIT，Copyright (c) 2025 Nous Research，
 * 声明见 NOTICE 五），取于 `f9b29c49b6`（2026-10-03 取用）：
 *   - `agent/chat_completion_helpers.py:4174-4194` — a call is told apart by
 *     its `index` AND the last id seen at that index: Ollama reuses index 0
 *     for a second call with a new id, which must open a new call, not append
 *     to the first; a missing `index` counts as 0;
 *   - `:4196-4213` — an integer id (Poolside) is made a string, and a later
 *     non-empty id replaces an earlier one;
 *   - `:4214-4226` — the name is assigned, never concatenated (MiniMax via
 *     NVIDIA NIM resends the full name in every chunk), and may arrive after
 *     the first delta; arguments are concatenated.
 * Only the rules are taken; the code is ours.
 *
 * What changes for the stream adapter (`openaiStreamAdapter.ts`): it used to
 * open the `tool_use` block on a call's first delta, with whatever name that
 * delta had — an empty one if the name came later (hermes-research §11.9-①C)
 * — and keyed calls by `index` alone, so Ollama's second call was appended to
 * the first and the arguments became `{"a":1}{"b":2}` (§11.9-①D). Now:
 *
 *   - a call's block opens when its first non-empty name arrives; argument
 *     fragments that came earlier are held and released right after the start;
 *   - a call whose name never arrives is opened at the end of a stream that
 *     ended properly ({@link ToolCallDeltaAssembler.flush}), with the empty
 *     name it always had — the old behaviour, now only as a last resort;
 *   - once a block is open its name and id are on the wire; a different name
 *     or id arriving later can no longer change them. hermes, which builds the
 *     call at the end, would take the later one.
 *
 * Holding a call back also holds back the moment the retry loop counts the
 * stream as visible (`streamAssembly.ts` commitment): an attempt that fails
 * while a call is still unnamed has shown nothing and may be replayed.
 */

export type ToolCallStep =
  | { type: 'start'; slot: number; id: string; name: string }
  | { type: 'arguments'; slot: number; fragment: string }

/** The fields of a Chat Completions `tool_calls[]` delta this reads. */
export type ToolCallDelta = {
  index?: number | null
  id?: string | number | null
  function?: { name?: string | null; arguments?: string | null } | null
}

type Call = {
  /** Latest non-empty id; generated at start when none ever arrived. */
  id: string
  /** Set once the block is open. */
  name: string | undefined
  /** Argument fragments received before the block opened. */
  heldArguments: string[]
}

function idOf(raw: ToolCallDelta['id']): string {
  return raw === null || raw === undefined ? '' : String(raw)
}

export class ToolCallDeltaAssembler {
  private readonly calls = new Map<number, Call>()
  private readonly slotByIndex = new Map<number, number>()
  private readonly lastIdByIndex = new Map<number, string>()

  /** @param newId mints an id for a call that never sent one. */
  constructor(private readonly newId: () => string) {}

  /** Steps for one chunk's `tool_calls`, in arrival order. */
  accept(deltas: readonly ToolCallDelta[]): ToolCallStep[] {
    const steps: ToolCallStep[] = []
    for (const delta of deltas) {
      const index = typeof delta.index === 'number' ? delta.index : 0
      const id = idOf(delta.id)
      const lastId = this.lastIdByIndex.get(index)
      let slot = this.slotByIndex.get(index)
      if (slot === undefined || (id && lastId !== undefined && id !== lastId)) {
        slot = this.calls.size
        this.slotByIndex.set(index, slot)
        this.calls.set(slot, { id: '', name: undefined, heldArguments: [] })
      }
      if (id) this.lastIdByIndex.set(index, id)

      const call = this.calls.get(slot)!
      if (id && call.name === undefined) call.id = id

      const name = delta.function?.name
      if (name && call.name === undefined) {
        steps.push(...this.start(slot, call, name))
      }

      const fragment = delta.function?.arguments
      if (fragment) {
        if (call.name === undefined) call.heldArguments.push(fragment)
        else steps.push({ type: 'arguments', slot, fragment })
      }
    }
    return steps
  }

  /**
   * Open every call still waiting for a name, with an empty name, and release
   * its held arguments. For a stream that ended properly only.
   */
  flush(): ToolCallStep[] {
    const steps: ToolCallStep[] = []
    for (const [slot, call] of this.calls) {
      if (call.name === undefined) steps.push(...this.start(slot, call, ''))
    }
    return steps
  }

  private start(slot: number, call: Call, name: string): ToolCallStep[] {
    call.name = name
    if (!call.id) call.id = this.newId()
    const steps: ToolCallStep[] = [{ type: 'start', slot, id: call.id, name }]
    for (const fragment of call.heldArguments) {
      steps.push({ type: 'arguments', slot, fragment })
    }
    call.heldArguments = []
    return steps
  }
}
