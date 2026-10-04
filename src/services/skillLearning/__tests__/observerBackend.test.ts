import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getActiveObserverBackend,
  listObserverBackends,
  registerObserverBackend,
  resolveDefaultObserverBackend,
  setActiveObserverBackend,
  analyzeWithActiveBackend,
  type ObserverBackend,
} from '../observerBackend.js'
import { analyzeObservations } from '../sessionObserver.js'
import { setLlmObserverQueryForTest } from '../llmObserverBackend.js'
import type { StoredSkillObservation } from '../observationStore.js'
import type { AssistantMessage } from '../../../types/message.js'

function obs(partial: Partial<StoredSkillObservation>): StoredSkillObservation {
  return {
    id: partial.id ?? crypto.randomUUID(),
    timestamp: '2026-04-16T00:00:00.000Z',
    event: partial.event ?? 'user_message',
    sessionId: 's1',
    projectId: 'p1',
    projectName: 'project',
    cwd: process.cwd(),
    ...partial,
  }
}

const originalBackendName = getActiveObserverBackend().name

let observerQueryCalls = 0

/**
 * The 'llm' backend registered in the default registry is the shipped
 * singleton, whose query seam points at the real `queryHaiku`. Two tests below
 * route through it, and one of them (`analyzeObservations` on an async backend)
 * throws before awaiting, leaving the call in flight. Without this stub that
 * in-flight call is a real API request, and `withVCR` records the response into
 * `fixtures/` on a cache miss.
 */
function stubbedObserverQuery(): Promise<AssistantMessage> {
  observerQueryCalls++
  return Promise.resolve({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '[]' }] },
  } as unknown as AssistantMessage)
}

beforeEach(() => {
  observerQueryCalls = 0
  setLlmObserverQueryForTest(stubbedObserverQuery)
})

afterEach(() => {
  setActiveObserverBackend(originalBackendName)
  setLlmObserverQueryForTest()
})

describe('observerBackend', () => {
  test('registers heuristic and llm backends by default', () => {
    const names = listObserverBackends()
    expect(names).toContain('heuristic')
    expect(names).toContain('llm')
  })

  test('resolveDefaultObserverBackend honours SKILL_LEARNING_OBSERVER_BACKEND env', () => {
    // Adversarial probe for the env switch — if this regresses, the LLM
    // backend would be silently unreachable in production even with the env
    // variable set, which was the original AC2 gap.
    const original = process.env.SKILL_LEARNING_OBSERVER_BACKEND
    try {
      process.env.SKILL_LEARNING_OBSERVER_BACKEND = 'llm'
      resolveDefaultObserverBackend()
      expect(getActiveObserverBackend().name).toBe('llm')

      // Unknown backend names must not crash; the current active stays.
      process.env.SKILL_LEARNING_OBSERVER_BACKEND = 'nonexistent'
      resolveDefaultObserverBackend()
      expect(getActiveObserverBackend().name).toBe('llm')

      // Clearing the env leaves whatever was active — explicit opt-out is
      // setActiveObserverBackend, not clearing the env.
      delete process.env.SKILL_LEARNING_OBSERVER_BACKEND
      resolveDefaultObserverBackend()
      expect(getActiveObserverBackend().name).toBe('llm')
    } finally {
      if (original === undefined) {
        delete process.env.SKILL_LEARNING_OBSERVER_BACKEND
      } else {
        process.env.SKILL_LEARNING_OBSERVER_BACKEND = original
      }
    }
  })

  test('heuristic backend preserves existing correction detection', async () => {
    setActiveObserverBackend('heuristic')
    const candidates = await analyzeWithActiveBackend([
      obs({ messageText: '不要直接 mock，用 testing-library' }),
    ])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.action).toContain('testing-library')
  })

  test('llm backend short-circuits to [] on empty observations', async () => {
    // The backend only queries Haiku when there are observations to analyse.
    // `[]` alone proves nothing — the heuristic fallback also returns `[]` for
    // an empty batch — so the load-bearing assertion is the call count.
    setActiveObserverBackend('llm')
    const candidates = await analyzeWithActiveBackend([])
    expect(candidates).toEqual([])
    expect(observerQueryCalls).toBe(0)
  })

  test('analyzeObservations routes to active backend (sync path throws for async backends)', () => {
    // Heuristic backend is sync — analyzeObservations works directly.
    const previousCount = analyzeObservations([
      obs({ messageText: '不要直接 mock，用 testing-library' }),
    ]).length
    expect(previousCount).toBe(1)

    // The LLM backend is now a real async implementation (queryHaiku). The
    // sync `analyzeObservations` helper refuses to return a pending Promise
    // and throws with a clear instruction to use `analyzeWithActiveBackend`
    // instead — prove the routing reached the async backend by catching
    // that exact error.
    setActiveObserverBackend('llm')
    expect(() =>
      analyzeObservations([
        obs({ messageText: '不要直接 mock，用 testing-library' }),
      ]),
    ).toThrow(/Promise/)
  })

  test('custom backends can be registered and switched', async () => {
    const custom: ObserverBackend = {
      name: 'custom-test',
      analyze() {
        return [
          {
            trigger: 'custom trigger',
            action: 'custom action',
            confidence: 0.9,
            domain: 'project',
            source: 'session-observation',
            scope: 'project',
            evidence: ['custom evidence'],
          },
        ]
      },
    }
    registerObserverBackend(custom)
    setActiveObserverBackend('custom-test')

    const candidates = await analyzeWithActiveBackend([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.trigger).toBe('custom trigger')
  })

  test('switching to an unknown backend throws', () => {
    expect(() => setActiveObserverBackend('does-not-exist')).toThrow()
  })
})
