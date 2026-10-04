// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Does the memory sidecar push a watch turn into auto-compact? (design §4.4,
 * roadmap P13.7 DoD.)
 *
 * hermes' finding was that a tool surface of 50+ definitions silently added
 * 20–30k tokens to every prompt, and nobody noticed until compaction started
 * firing on turns that had barely done anything. The equivalent risk here is
 * three additions landing on the same turn: the injected memory block, the
 * queued batch it arrived with, and the resident tool schema.
 *
 * So this file measures the ceiling of all three against the base's own
 * auto-compact threshold and asserts there is real headroom. It deliberately
 * measures **ceilings, not samples** — a test that used a small store would
 * pass on the day it was written and say nothing about the node three months
 * later with a full memory directory.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { LIMITS } from '@qianmo/protocol'
import { INJECTION_BUDGET } from '@qianmo/recall'
import {
  estimateMaxTurnGrowth,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} from '../../compact/autoCompact.js'
import { zodToJsonSchema } from '../../../utils/text/zodToJsonSchema.js'
import { MAX_MAILBOX_MESSAGE_TEXT_BYTES } from '../../../utils/agents/teammateMailbox.js'
import { getEmptyToolPermissionContext } from '@open-claude-code/tool-runtime/Tool.js'
import { residentToolSurface } from '../notifyTool.js'

/**
 * Characters per token, worst case.
 *
 * CJK runs at roughly one token per character and Latin text at roughly four,
 * so `1` is the pessimistic end and the only honest choice for a ceiling: a
 * budget argued on Latin averages would be wrong for exactly the prompts this
 * project produces. `@qianmo/recall` picks its character budget on the same
 * reasoning.
 */
const CHARS_PER_TOKEN = 1

const MODEL = 'claude-sonnet-4-6'

/**
 * Pin the context window for the whole file.
 *
 * The base resolves a model's window through `~/.occ/settings.json`, so
 * unpinned this file measures against whatever `modelSettings.sonnet.
 * contextTokens` the developer happens to have set — 1M on a machine that
 * raised it, 200k on a fresh checkout. That is a 5.8x difference in the
 * budget being asserted, and it is how this file passed for its whole life
 * while failing under `HOME=$(mktemp -d)`. The env override short-circuits
 * at the top of the resolution chain, which is the only thing that outranks
 * settings; 200k is the real Sonnet window a resident node runs on.
 */
let savedMaxContextTokens: string | undefined

beforeAll(() => {
  savedMaxContextTokens = process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '200000'
})

afterAll(() => {
  if (savedMaxContextTokens === undefined)
    delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  else process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = savedMaxContextTokens
})

/**
 * What the tool surface costs the prompt: the name, the JSON schema the model
 * actually receives, and the rendered description.
 *
 * The schema goes through the base's own `zodToJsonSchema` rather than being
 * counted off the zod object, because the JSON form is what crosses the wire —
 * counting the source form would understate it by the part that matters.
 */
async function toolSurfaceChars(): Promise<number> {
  const surface = residentToolSurface({
    sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    announce: async () => ({ status: 'sent' }),
  })
  const describeOptions = {
    isNonInteractiveSession: true,
    toolPermissionContext: getEmptyToolPermissionContext(),
    tools: [],
  }
  let total = 0
  for (const tool of surface) {
    total += tool.name.length
    total += JSON.stringify(zodToJsonSchema(tool.inputSchema)).length
    total += (
      await tool.description(
        { kind: 'watch', severity: 'info', summary: 'measured' },
        describeOptions,
      )
    ).length
  }
  return total
}

describe('resident prompt budget — the injection does not cause auto-compact', () => {
  test('one wake, at every ceiling at once, leaves most of the window unused', async () => {
    const threshold = getAutoCompactThreshold(MODEL)
    // Exact, not a `> 100_000` band: a fuzzy bound would let the pin above
    // lapse without anything going red, which is the original bug.
    expect(threshold).toBe(167_000)

    // The three things P13.7 adds to or keeps on a watch turn.
    const injection = INJECTION_BUDGET.maxChars
    const batch = MAX_MAILBOX_MESSAGE_TEXT_BYTES
    const tools = await toolSurfaceChars()

    const worstCaseTokens = Math.ceil(
      (injection + batch + tools) / CHARS_PER_TOKEN,
    )

    // The line the runtime actually compares against. `src/query.ts` runs a
    // predictive compaction before the API call and fires when the prompt
    // exceeds `getEffectiveContextWindowSize(model) - estimateMaxTurnGrowth(
    // model)` — 145_000 here, 13% tighter than the 167_000 threshold the DoD
    // names, so clearing it means the turn survives the stricter of the two
    // gates rather than only the one the DoD spells out.
    //
    // It replaces a `threshold / 4` bound invented in this file: no DoD text
    // asks for a fraction, and that one was unreachable by construction —
    // `batch + tools` is 66_736 on its own against a 41_750 bound, so it failed
    // even with the injection at zero characters. The only way to satisfy it
    // was to shrink MAX_MAILBOX_MESSAGE_TEXT_BYTES, the axis of the blob
    // offload design, which is exactly where a future edit should not be aimed.
    //
    // Both numbers are only stable because the window is pinned at the top of
    // the file; unpinned, this compared against the developer's settings.json.
    expect(worstCaseTokens).toBeLessThan(
      getEffectiveContextWindowSize(MODEL) - estimateMaxTurnGrowth(MODEL),
    )
  })

  test('the injection is bounded by a constant, not by how much the node remembers', () => {
    // The regression that would actually hurt: making the block grow with the
    // store. A node that has been watching for a month would then assemble a
    // prompt nobody sized for, and it would happen gradually enough that no
    // single change looks responsible.
    expect(INJECTION_BUDGET.maxChars).toBeLessThanOrEqual(20_000)
    expect(INJECTION_BUDGET.maxEntries).toBeLessThanOrEqual(50)
  })

  test('the queue cannot multiply the injection within one turn', () => {
    // `maxQueuedTurns` bounds how many turns wait, not how many batches land
    // in one prompt: `selectResidentSnapshot` makes a network batch a batch of
    // one, so a queue of 32 is 32 separate turns, each with one injection —
    // never one turn carrying 32 of them.
    expect(LIMITS.maxQueuedTurns).toBe(32)

    const perTurn = INJECTION_BUDGET.maxChars + MAX_MAILBOX_MESSAGE_TEXT_BYTES
    const ifTheQueueEverCollapsedIntoOnePrompt = perTurn * LIMITS.maxQueuedTurns

    // Stated as the thing that must not happen rather than left implicit: if
    // some future change did fold the queue into a single prompt, it would
    // blow the window several times over, and this line says so out loud.
    expect(ifTheQueueEverCollapsedIntoOnePrompt).toBeGreaterThan(
      getAutoCompactThreshold(MODEL),
    )
  })

  test('the resident tool surface stays one tool, so it cannot become the hermes problem', async () => {
    const surface = residentToolSurface({
      sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      announce: async () => ({ status: 'sent' }),
    })
    expect(surface).toHaveLength(1)
    // 50+ tools was hermes' 20–30k token surprise. One tool is ~1% of that.
    const chars = await toolSurfaceChars()
    // Non-vacuous by construction: the schema and description are really in
    // there, so a future tool that ships a large one moves this number.
    expect(chars).toBeGreaterThan(200)
    expect(chars).toBeLessThan(8_000)
  })
})
