/**
 * Unit tests for H5 (LLM call throttle), H6 (message watermark dedup),
 * and H7 (circuit breaker) improvements.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resetSkillLearningConfig,
  setSkillLearningConfigForTest,
} from '../config.js'
import {
  llmObserverBackend,
  resetCircuitBreaker,
  setLlmObserverQueryForTest,
} from '../llmObserverBackend.js'
import {
  resetRuntimeLLMBookkeeping,
  resetRuntimeObserverForTest,
  runSkillLearningPostSampling,
} from '../runtimeObserver.js'
import type { REPLHookContext } from '../../../utils/hooks/postSamplingHooks.js'
import {
  setActiveObserverBackend,
  getActiveObserverBackend,
  registerObserverBackend,
  type ObserverBackend,
} from '../observerBackend.js'
import type { StoredSkillObservation } from '../observationStore.js'
import type { AssistantMessage } from '../../../types/message.js'
import type { queryHaiku } from '../../api/claude.js'

let root: string
let previousCwd: string
const originalEnv = { ...process.env }
const originalBackendName = getActiveObserverBackend().name
type LlmObserverQuery = typeof queryHaiku

function haikuResponse(text: string): AssistantMessage {
  return {
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  } as unknown as AssistantMessage
}

function unavailableObserverQuery(): Promise<AssistantMessage> {
  return Promise.reject(new Error('No assistant message found'))
}

/**
 * Deny-by-default seam installed for every test in this file. Reaching the real
 * `queryHaiku` here would go through `withVCR`, which records a live API
 * response into `fixtures/` on a cache miss. A test that means to exercise the
 * query path installs its own stub; one that forgets fails loudly instead of
 * silently going online (the error is not in `isExpectedObserverUnavailable`'s
 * set, so it propagates out of `analyze()` rather than falling back).
 */
function forbiddenObserverQuery(): never {
  throw new Error(
    'llm observer query was not stubbed — call setLlmObserverQueryForTest() first',
  )
}

function makeCtx(
  messages: Array<{ uuid: string; content: string }>,
): REPLHookContext {
  return {
    querySource: 'repl_main_thread',
    messages: messages.map(({ uuid, content }) => ({
      type: 'user' as const,
      uuid: uuid as any,
      message: { role: 'user' as const, content },
    })),
    systemPrompt: [] as any,
    userContext: {},
    systemContext: {},
    toolUseContext: { agentId: undefined } as any,
  }
}

function make5Msgs(prefix: string): Array<{ uuid: string; content: string }> {
  return Array.from({ length: 5 }, (_, i) => ({
    uuid: `${prefix}-${i}`,
    content: '不要 mock，用 testing-library',
  }))
}

function makeObs(count: number): StoredSkillObservation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `o${i}`,
    timestamp: new Date().toISOString(),
    event: 'user_message' as const,
    sessionId: 's1',
    projectId: 'p1',
    projectName: 'project',
    cwd: '/tmp',
    messageText: 'test message',
  }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'skill-throttle-test-'))
  previousCwd = process.cwd()
  process.chdir(root)
  process.env = { ...originalEnv }
  process.env.CLAUDE_SKILL_LEARNING_HOME = join(root, 'learning-home')
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  process.env.SKILL_LEARNING_ENABLED = '1'
  resetRuntimeObserverForTest()
  resetCircuitBreaker()
  setActiveObserverBackend(originalBackendName)
  setLlmObserverQueryForTest(forbiddenObserverQuery)
})

afterEach(() => {
  process.chdir(previousCwd)
  process.env = { ...originalEnv }
  resetSkillLearningConfig()
  rmSync(root, { recursive: true, force: true })
  resetRuntimeObserverForTest()
  resetCircuitBreaker()
  setActiveObserverBackend(originalBackendName)
  setLlmObserverQueryForTest()
})

// ---------------------------------------------------------------------------
// H5: LLM throttle — minimum observation count gate
// ---------------------------------------------------------------------------
describe('H5: LLM call throttle', () => {
  test('fewer than 5 observations routes to heuristic — LLM backend not called', async () => {
    let llmCallCount = 0
    const trackingBackend: ObserverBackend = {
      name: 'tracking-under5',
      analyze() {
        llmCallCount++
        return []
      },
    }
    registerObserverBackend(trackingBackend)
    setActiveObserverBackend('tracking-under5')

    // 3 messages → 3 observations, below the threshold of 5.
    await runSkillLearningPostSampling(
      makeCtx([
        { uuid: 'u5a', content: '不要 mock，用 testing-library' },
        { uuid: 'u5b', content: '不要 mock，用 testing-library' },
        { uuid: 'u5c', content: '不要 mock，用 testing-library' },
      ]),
    )

    expect(llmCallCount).toBe(0)
  })

  test('session cap: more calls than cap reaches heuristic fallback', async () => {
    // Cap at 1 call, cooldown 0ms.
    setSkillLearningConfigForTest({
      llm: { maxCallsPerSession: 1, cooldownMs: 0 },
    })

    let llmCallCount = 0
    const trackingBackend: ObserverBackend = {
      name: 'tracking-cap',
      analyze() {
        llmCallCount++
        return []
      },
    }
    registerObserverBackend(trackingBackend)
    setActiveObserverBackend('tracking-cap')

    // First call with 5 messages — reaches LLM.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('cap1')))
    expect(llmCallCount).toBe(1)

    // Second call with 5 different messages — cap hit, must NOT reach LLM.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('cap2')))
    expect(llmCallCount).toBe(1)
  })

  test('cooldown gate: second call within cooldown window skips LLM', async () => {
    // Very long cooldown — second call is always within window.
    setSkillLearningConfigForTest({
      llm: { cooldownMs: 999_999_000, maxCallsPerSession: 100 },
    })

    let llmCallCount = 0
    const trackingBackend: ObserverBackend = {
      name: 'tracking-cooldown',
      analyze() {
        llmCallCount++
        return []
      },
    }
    registerObserverBackend(trackingBackend)
    setActiveObserverBackend('tracking-cooldown')

    await runSkillLearningPostSampling(makeCtx(make5Msgs('cd1')))
    expect(llmCallCount).toBe(1)

    // Second call — still within 999999 second cooldown.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('cd2')))
    expect(llmCallCount).toBe(1)
  })

  test('resetRuntimeLLMBookkeeping resets session counter and timestamps', async () => {
    setSkillLearningConfigForTest({
      llm: { maxCallsPerSession: 1, cooldownMs: 0 },
    })

    let llmCallCount = 0
    const trackingBackend: ObserverBackend = {
      name: 'tracking-reset',
      analyze() {
        llmCallCount++
        return []
      },
    }
    registerObserverBackend(trackingBackend)
    setActiveObserverBackend('tracking-reset')

    // First call reaches LLM; cap = 1, so second call is blocked.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('rr1')))
    await runSkillLearningPostSampling(makeCtx(make5Msgs('rr2')))
    expect(llmCallCount).toBe(1)

    // After reset the counter clears — next call reaches LLM again.
    resetRuntimeLLMBookkeeping()
    await runSkillLearningPostSampling(makeCtx(make5Msgs('rr3')))
    expect(llmCallCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// H6: Message watermark dedup
// ---------------------------------------------------------------------------
describe('H6: message watermark dedup', () => {
  test('same message uuids are not re-processed in a subsequent call', async () => {
    // Use a backend that counts observations to detect dedup.
    let totalObservations = 0
    const countingBackend: ObserverBackend = {
      name: 'counting-dedup',
      analyze(observations) {
        totalObservations += observations.length
        return []
      },
    }
    registerObserverBackend(countingBackend)
    setActiveObserverBackend('counting-dedup')
    setSkillLearningConfigForTest({
      llm: { cooldownMs: 0, maxCallsPerSession: 100 },
    })

    const messages = make5Msgs('ded')

    // First call: 5 new message observations.
    await runSkillLearningPostSampling(makeCtx(messages))
    const afterFirst = totalObservations

    // Second call with SAME messages: all uuids already seen → 0 new
    // observations from messages. The early `if (observations.length === 0) return`
    // fires and the backend is never called.
    await runSkillLearningPostSampling(makeCtx(messages))
    const afterSecond = totalObservations

    expect(afterSecond).toBe(afterFirst)
  })

  test('different message uuids are always processed', async () => {
    let totalObservations = 0
    const countingBackend: ObserverBackend = {
      name: 'counting-dedup-new',
      analyze(observations) {
        totalObservations += observations.length
        return []
      },
    }
    registerObserverBackend(countingBackend)
    setActiveObserverBackend('counting-dedup-new')
    setSkillLearningConfigForTest({
      llm: { cooldownMs: 0, maxCallsPerSession: 100 },
    })

    await runSkillLearningPostSampling(makeCtx(make5Msgs('new1')))
    const afterFirst = totalObservations

    // Different uuids — all 5 new messages pass dedup.
    await runSkillLearningPostSampling(makeCtx(make5Msgs('new2')))
    expect(totalObservations).toBeGreaterThan(afterFirst)
  })

  test('resetRuntimeLLMBookkeeping clears dedup set — same uuids reprocessed', async () => {
    let totalObservations = 0
    const countingBackend: ObserverBackend = {
      name: 'counting-dedup-clr',
      analyze(observations) {
        totalObservations += observations.length
        return []
      },
    }
    registerObserverBackend(countingBackend)
    setActiveObserverBackend('counting-dedup-clr')
    setSkillLearningConfigForTest({
      llm: { cooldownMs: 0, maxCallsPerSession: 100 },
    })

    const messages = make5Msgs('clr')
    await runSkillLearningPostSampling(makeCtx(messages))
    const afterFirst = totalObservations

    // After reset, dedup set is cleared — same messages are reprocessed.
    resetRuntimeLLMBookkeeping()
    await runSkillLearningPostSampling(makeCtx(messages))
    expect(totalObservations).toBeGreaterThan(afterFirst)
  })
})

// ---------------------------------------------------------------------------
// H7: Circuit breaker (tests the llmObserverBackend state machine directly)
// ---------------------------------------------------------------------------
describe('H7: circuit breaker', () => {
  test('circuit opens after expected observer failures and skips later queries', async () => {
    resetCircuitBreaker()
    let calls = 0
    const query: LlmObserverQuery = async () => {
      calls++
      return await unavailableObserverQuery()
    }
    setLlmObserverQueryForTest(query)

    setSkillLearningConfigForTest({
      llm: { failureThreshold: 3, circuitCooldownMs: 60_000, timeoutMs: 50 },
    })

    const obs = makeObs(5)

    await llmObserverBackend.analyze(obs)
    await llmObserverBackend.analyze(obs)
    await llmObserverBackend.analyze(obs)
    expect(calls).toBe(3)

    await llmObserverBackend.analyze(obs)
    expect(calls).toBe(3)

    resetCircuitBreaker()
    const result = await llmObserverBackend.analyze(obs)
    expect(Array.isArray(result)).toBe(true)
    expect(calls).toBe(4)
  })

  test('circuit breaker env vars are respected', async () => {
    resetCircuitBreaker()
    let calls = 0
    const query: LlmObserverQuery = async () => {
      calls++
      return await unavailableObserverQuery()
    }
    setLlmObserverQueryForTest(query)

    setSkillLearningConfigForTest({
      llm: { failureThreshold: 1, circuitCooldownMs: 60_000, timeoutMs: 50 },
    })

    const obs = makeObs(5)

    await llmObserverBackend.analyze(obs)
    expect(calls).toBe(1)

    await llmObserverBackend.analyze(obs)
    expect(calls).toBe(1)

    resetCircuitBreaker()
    const result = await llmObserverBackend.analyze(obs)
    expect(Array.isArray(result)).toBe(true)
    expect(calls).toBe(2)
  })

  test('empty observations short-circuit ahead of the query in either circuit state', async () => {
    resetCircuitBreaker()
    setSkillLearningConfigForTest({
      llm: { failureThreshold: 1, circuitCooldownMs: 60_000, timeoutMs: 50 },
    })

    let calls = 0
    setLlmObserverQueryForTest(async () => {
      calls++
      return await unavailableObserverQuery()
    })

    // Circuit CLOSED: an empty batch must cost nothing. This is the assertion
    // that has teeth — drop the `observations.length === 0` guard and the call
    // falls through to the query, so `calls` becomes 1.
    expect(await llmObserverBackend.analyze([])).toEqual([])
    expect(calls).toBe(0)

    // Drive the circuit open (threshold 1): one failure, then a skipped query.
    await llmObserverBackend.analyze(makeObs(5))
    expect(calls).toBe(1)
    await llmObserverBackend.analyze(makeObs(5))
    expect(calls).toBe(1)

    // Circuit OPEN: an empty batch still returns [] and still costs nothing —
    // it never reaches the circuit check, let alone the heuristic fallback.
    expect(await llmObserverBackend.analyze([])).toEqual([])
    expect(calls).toBe(1)
  })

  test('resetCircuitBreaker clears the failure counter, not just the open deadline', async () => {
    setSkillLearningConfigForTest({
      llm: { failureThreshold: 3, circuitCooldownMs: 60_000, timeoutMs: 50 },
    })

    let calls = 0
    setLlmObserverQueryForTest(async () => {
      calls++
      return await unavailableObserverQuery()
    })
    resetCircuitBreaker()

    const obs = makeObs(5)

    // Two failures — one short of the threshold, so the circuit is still closed
    // but the counter is primed at 2.
    await llmObserverBackend.analyze(obs)
    await llmObserverBackend.analyze(obs)
    expect(calls).toBe(2)

    resetCircuitBreaker()

    // If reset only cleared `circuitOpenUntil` and left the counter at 2, the
    // next two failures would hit the threshold and open the circuit, so the
    // fourth call would be skipped and `calls` would stall at 3.
    await llmObserverBackend.analyze(obs)
    await llmObserverBackend.analyze(obs)
    expect(calls).toBe(4)

    // And a fifth call still gets through, proving the circuit is genuinely
    // closed rather than merely not-yet-open.
    await llmObserverBackend.analyze(obs)
    expect(calls).toBe(5)
  })

  test('the shipped backend resolves its query through the seam, never queryHaiku', async () => {
    // The environment a bypass would record in: ambient credentials, a
    // writable fixture root, VCR forced on and in record mode. `withVCR` only
    // ever sees this if `analyze` calls the real `queryHaiku`.
    process.env.ANTHROPIC_API_KEY = 'ambient-test-credential'
    process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = join(root, 'fixtures-root')
    process.env.FORCE_VCR = '1'
    process.env.USER_TYPE = 'ant'
    process.env.VCR_RECORD = '1'

    let calls = 0
    let sawSystemPrompt = false
    setLlmObserverQueryForTest(async ({ systemPrompt }) => {
      calls++
      sawSystemPrompt = systemPrompt.length > 0
      return haikuResponse('[]')
    })

    await llmObserverBackend.analyze(makeObs(5))

    // The module-level singleton — not a test-only copy of it — routed through
    // the seam. Capture `queryHaiku` at construction time instead of reading
    // the binding per call and this drops to 0.
    expect(calls).toBe(1)
    expect(sawSystemPrompt).toBe(true)
  })

  test('unexpected VCR or infrastructure errors propagate instead of falling back', async () => {
    const fixtureFailure = new Error('Anthropic API fixture missing: corrupt')
    setLlmObserverQueryForTest(async () => {
      throw fixtureFailure
    })

    await expect(llmObserverBackend.analyze(makeObs(5))).rejects.toBe(
      fixtureFailure,
    )
  })
})
