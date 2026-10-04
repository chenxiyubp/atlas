import { afterEach, describe, expect, test } from 'bun:test'
import {
  _resetPromptCacheKeySupportForTesting,
  getOpenAIPromptCacheKey,
  getOpenAIPromptCacheKeyScope,
  isOfficialOpenAIBaseURL,
  isPromptCacheKeyRejection,
  markPromptCacheKeyRejected,
  resolveOpenAIPromptCacheKey,
  resolveOpenAIVerbosity,
  shouldSendOpenAIPromptCacheKey,
} from '../openaiShared.js'

describe('resolveOpenAIVerbosity', () => {
  afterEach(() => {
    delete process.env.OPENAI_VERBOSITY
  })

  test('defaults eligible official and ChatGPT GPT routes to low', () => {
    expect(
      resolveOpenAIVerbosity('gpt-5.6-sol', {
        baseURL: undefined,
        isChatGPTAuth: false,
      }),
    ).toBe('low')
    expect(
      resolveOpenAIVerbosity('gpt-5.6-terra', {
        baseURL: 'https://compatible.example/v1',
        isChatGPTAuth: true,
      }),
    ).toBe('low')
  })

  test('honors low, medium, and high overrides on eligible routes', () => {
    for (const value of ['low', 'medium', 'high'] as const) {
      process.env.OPENAI_VERBOSITY = value
      expect(
        resolveOpenAIVerbosity('gpt-5.6-sol', {
          baseURL: 'https://api.openai.com/v1',
          isChatGPTAuth: false,
        }),
      ).toBe(value)
    }
  })

  test('off, zero, and false omit the field', () => {
    for (const value of ['off', '0', 'false']) {
      process.env.OPENAI_VERBOSITY = value
      expect(
        resolveOpenAIVerbosity('gpt-5.6-sol', {
          baseURL: undefined,
          isChatGPTAuth: false,
        }),
      ).toBeUndefined()
    }
  })

  test('never sends verbosity to compatible endpoints or non-GPT models', () => {
    process.env.OPENAI_VERBOSITY = 'high'
    expect(
      resolveOpenAIVerbosity('gpt-5.6-sol', {
        baseURL: 'https://compatible.example/v1',
        isChatGPTAuth: false,
      }),
    ).toBe('high')
    expect(
      resolveOpenAIVerbosity('deepseek-reasoner', {
        baseURL: undefined,
        isChatGPTAuth: false,
      }),
    ).toBeUndefined()
  })

  test('omits verbosity for compatible endpoints without an override', () => {
    delete process.env.OPENAI_VERBOSITY
    expect(
      resolveOpenAIVerbosity('gpt-5.6-sol', {
        baseURL: 'https://compatible.example/v1',
        isChatGPTAuth: false,
      }),
    ).toBeUndefined()
  })
})

describe('isOfficialOpenAIBaseURL', () => {
  test('treats the SDK default endpoint as official OpenAI', () => {
    expect(isOfficialOpenAIBaseURL(undefined)).toBe(true)
    expect(isOfficialOpenAIBaseURL('')).toBe(true)
  })

  test('accepts global and regional official OpenAI endpoints', () => {
    expect(isOfficialOpenAIBaseURL('https://api.openai.com/v1')).toBe(true)
    expect(isOfficialOpenAIBaseURL('https://eu.api.openai.com/v1')).toBe(true)
    expect(isOfficialOpenAIBaseURL('https://api.openai.com:443/v1')).toBe(true)
  })

  test('rejects OpenAI-compatible and spoofed endpoints', () => {
    expect(isOfficialOpenAIBaseURL('https://api.deepseek.com/v1')).toBe(false)
    expect(isOfficialOpenAIBaseURL('http://api.openai.com/v1')).toBe(false)
    expect(isOfficialOpenAIBaseURL('https://api.openai.com.evil.test/v1')).toBe(
      false,
    )
    expect(isOfficialOpenAIBaseURL('https://api.openai.com:8443/v1')).toBe(
      false,
    )
    expect(isOfficialOpenAIBaseURL('not-a-url')).toBe(false)
  })
})

describe('getOpenAIPromptCacheKey', () => {
  test('returns a session key for the SDK default and official endpoint', () => {
    expect(getOpenAIPromptCacheKey(undefined, 'session-1')).toBe(
      'occ:session-1',
    )
    expect(
      getOpenAIPromptCacheKey('https://api.openai.com/v1', 'session-2'),
    ).toBe('occ:session-2')
  })

  test('compatible endpoints get a key too, until one rejects it', () => {
    expect(
      getOpenAIPromptCacheKey('https://api.deepseek.com/v1', 'session-1'),
    ).toBe('occ:session-1')

    markPromptCacheKeyRejected()
    try {
      expect(
        getOpenAIPromptCacheKey('https://api.deepseek.com/v1', 'session-1'),
      ).toBeUndefined()
      // OpenAI's own endpoint documents the field — one strict gateway must
      // not switch it off there.
      expect(
        getOpenAIPromptCacheKey('https://api.openai.com/v1', 'session-1'),
      ).toBe('occ:session-1')
    } finally {
      _resetPromptCacheKeySupportForTesting()
    }
  })
})

describe('shouldSendOpenAIPromptCacheKey', () => {
  afterEach(() => {
    delete process.env.OPENAI_PROMPT_CACHE_KEY
    _resetPromptCacheKeySupportForTesting()
  })

  test('Chat Completions sends the key by default, on any base URL', () => {
    // It used to be official-OpenAI-only, which left the single largest cache
    // lever opt-in for the population that needs it most: OpenAI behind a chat
    // gateway. Endpoints that cannot take the field say so, once.
    expect(shouldSendOpenAIPromptCacheKey(undefined, 'chat')).toBe(true)
    expect(
      shouldSendOpenAIPromptCacheKey('https://api.deepseek.com/v1', 'chat'),
    ).toBe(true)
    // No protocol given behaves like chat.
    expect(shouldSendOpenAIPromptCacheKey('https://api.deepseek.com/v1')).toBe(
      true,
    )
  })

  test('a rejection suppresses the key for compatible endpoints only', () => {
    markPromptCacheKeyRejected()
    try {
      expect(
        shouldSendOpenAIPromptCacheKey('https://gateway.internal/v1', 'chat'),
      ).toBe(false)
      expect(
        shouldSendOpenAIPromptCacheKey('https://api.openai.com/v1', 'chat'),
      ).toBe(true)
      // A chat-line rejection says nothing about the Responses protocol.
      expect(
        shouldSendOpenAIPromptCacheKey(
          'https://gateway.internal/v1',
          'responses',
        ),
      ).toBe(true)
      // The explicit override still wins over the latch.
      process.env.OPENAI_PROMPT_CACHE_KEY = '1'
      expect(
        shouldSendOpenAIPromptCacheKey('https://gateway.internal/v1', 'chat'),
      ).toBe(true)
    } finally {
      _resetPromptCacheKeySupportForTesting()
    }
  })

  test('classifies only genuine prompt_cache_key rejections', () => {
    expect(
      isPromptCacheKeyRejection(
        new Error("400 Unknown parameter: 'prompt_cache_key'."),
      ),
    ).toBe(true)
    expect(
      isPromptCacheKeyRejection(
        new Error('Extra inputs are not permitted: prompt_cache_key'),
      ),
    ).toBe(true)
    // An unrelated 400 must still fail the turn.
    expect(
      isPromptCacheKeyRejection(new Error("400 Unknown parameter: 'tools'.")),
    ).toBe(false)
    expect(isPromptCacheKeyRejection(new Error('rate limited'))).toBe(false)
  })

  test('the Responses protocol gets a key until that protocol rejects it', () => {
    // Measured against a live gateway (5 turns, identical prefix): omitting
    // the key dropped the cumulative hit rate from 75.8% to 18.3%, per-turn
    // 95/0/0/0/0. Compatible implementations still vary, so a recognized
    // rejection disables only their Responses lane.
    expect(
      shouldSendOpenAIPromptCacheKey(
        'https://gateway.internal/v1',
        'responses',
      ),
    ).toBe(true)
    markPromptCacheKeyRejected('responses')
    expect(
      getOpenAIPromptCacheKey(
        'https://gateway.internal/v1',
        'sess',
        'responses',
      ),
    ).toBeUndefined()
    expect(
      getOpenAIPromptCacheKey('https://gateway.internal/v1', 'sess', 'chat'),
    ).toBe('occ:sess')
    expect(
      getOpenAIPromptCacheKey('https://api.openai.com/v1', 'sess', 'responses'),
    ).toBe('occ:sess')
  })

  test('OPENAI_PROMPT_CACHE_KEY=1 opts a gateway in', () => {
    // The common "OpenAI behind LiteLLM/one-api/OpenRouter" setup: the gateway
    // forwards the key, and without it a multi-turn session is free to land on
    // a different cache node each turn.
    process.env.OPENAI_PROMPT_CACHE_KEY = '1'
    expect(shouldSendOpenAIPromptCacheKey('https://gateway.internal/v1')).toBe(
      true,
    )
    expect(getOpenAIPromptCacheKey('https://gateway.internal/v1', 'sess')).toBe(
      'occ:sess',
    )
  })

  test('OPENAI_PROMPT_CACHE_KEY=0 forces it off, including on /responses', () => {
    // Escape hatch for a gateway that passes unknown keys through to an
    // upstream that rejects them.
    process.env.OPENAI_PROMPT_CACHE_KEY = '0'
    expect(shouldSendOpenAIPromptCacheKey(undefined)).toBe(false)
    expect(
      shouldSendOpenAIPromptCacheKey(
        'https://gateway.internal/v1',
        'responses',
      ),
    ).toBe(false)
    expect(getOpenAIPromptCacheKey(undefined, 'sess')).toBeUndefined()
  })

  test('an unparseable value falls back to the default decision', () => {
    process.env.OPENAI_PROMPT_CACHE_KEY = 'maybe'
    expect(shouldSendOpenAIPromptCacheKey(undefined)).toBe(true)
    expect(shouldSendOpenAIPromptCacheKey('https://api.deepseek.com/v1')).toBe(
      true,
    )
  })

  test('accepts the same spellings as isEnvTruthy/isEnvDefinedFalsy', () => {
    for (const value of ['1', 'true', 'YES', ' on ']) {
      process.env.OPENAI_PROMPT_CACHE_KEY = value
      expect(shouldSendOpenAIPromptCacheKey('https://compat.example/v1')).toBe(
        true,
      )
    }
    for (const value of ['0', 'false', 'NO', ' off ']) {
      process.env.OPENAI_PROMPT_CACHE_KEY = value
      expect(shouldSendOpenAIPromptCacheKey(undefined)).toBe(false)
    }
  })
})

describe('prefix-scoped prompt_cache_key', () => {
  const SYSTEM = { role: 'system', content: 'You are an agent. cwd=/repo' }
  const TOOLS = [
    { type: 'function', function: { name: 'Bash', parameters: {} } },
    { type: 'function', function: { name: 'Read', parameters: {} } },
  ]
  const base = {
    baseURL: 'https://gateway.internal/v1',
    wireProtocol: 'responses' as const,
    model: 'gpt-5.6-sol',
    messages: [SYSTEM, { role: 'user', content: 'hi' }],
    tools: TOOLS,
  }

  afterEach(() => {
    delete process.env.OPENAI_PROMPT_CACHE_KEY
    delete process.env.OPENAI_PROMPT_CACHE_KEY_SCOPE
    _resetPromptCacheKeySupportForTesting()
  })

  test('two different sessions sharing a prefix share one key', () => {
    // The whole point. Measured against a live gateway, four byte-identical
    // single-turn requests of 39167 input tokens each: with the session key
    // both fresh sessions cached 0; with this key both cached 38400.
    const a = resolveOpenAIPromptCacheKey({ ...base, sessionId: 'session-a' })
    const b = resolveOpenAIPromptCacheKey({ ...base, sessionId: 'session-b' })
    expect(a).toBe(b as string)
    expect(a).toMatch(/^occ:p:[0-9a-f]{16}$/)
  })

  test('stays stable as the conversation grows', () => {
    const turn1 = resolveOpenAIPromptCacheKey({ ...base, sessionId: 's' })
    const turn2 = resolveOpenAIPromptCacheKey({
      ...base,
      sessionId: 's',
      messages: [
        SYSTEM,
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'and again' },
      ],
    })
    expect(turn2).toBe(turn1 as string)
  })

  test('tracks the parts that actually change the cached prefix', () => {
    const key = resolveOpenAIPromptCacheKey({ ...base, sessionId: 's' })
    expect(
      resolveOpenAIPromptCacheKey({
        ...base,
        sessionId: 's',
        model: 'gpt-5.6-terra',
      }),
    ).not.toBe(key as string)
    expect(
      resolveOpenAIPromptCacheKey({
        ...base,
        sessionId: 's',
        messages: [{ role: 'system', content: 'different prompt' }],
      }),
    ).not.toBe(key as string)
    expect(
      resolveOpenAIPromptCacheKey({
        ...base,
        sessionId: 's',
        tools: [TOOLS[0]],
      }),
    ).not.toBe(key as string)
  })

  test('developer-role system text counts, user turns never do', () => {
    const asDeveloper = resolveOpenAIPromptCacheKey({
      ...base,
      sessionId: 's',
      messages: [{ role: 'developer', content: SYSTEM.content }],
    })
    const asSystem = resolveOpenAIPromptCacheKey({
      ...base,
      sessionId: 's',
      messages: [SYSTEM],
    })
    expect(asDeveloper).toBe(asSystem as string)
    // A different user turn must not move the key — a key that changes every
    // turn is exactly what defeats routing.
    expect(
      resolveOpenAIPromptCacheKey({
        ...base,
        sessionId: 's',
        messages: [SYSTEM, { role: 'user', content: 'completely different' }],
      }),
    ).toBe(
      resolveOpenAIPromptCacheKey({
        ...base,
        sessionId: 's',
        messages: [SYSTEM, { role: 'user', content: 'hi' }],
      }) as string,
    )
  })

  test('flattens structured system content the same as a plain string', () => {
    expect(
      resolveOpenAIPromptCacheKey({
        ...base,
        sessionId: 's',
        messages: [
          { role: 'system', content: [{ type: 'text', text: SYSTEM.content }] },
        ],
      }),
    ).toBe(
      resolveOpenAIPromptCacheKey({
        ...base,
        sessionId: 's',
        messages: [SYSTEM],
      }) as string,
    )
  })

  test('OPENAI_PROMPT_CACHE_KEY_SCOPE=session restores the session key', () => {
    process.env.OPENAI_PROMPT_CACHE_KEY_SCOPE = 'session'
    expect(getOpenAIPromptCacheKeyScope()).toBe('session')
    expect(resolveOpenAIPromptCacheKey({ ...base, sessionId: 'abc' })).toBe(
      'occ:abc',
    )
    process.env.OPENAI_PROMPT_CACHE_KEY_SCOPE = 'prefix'
    expect(getOpenAIPromptCacheKeyScope()).toBe('prefix')
    // Anything unrecognized keeps the measured default.
    process.env.OPENAI_PROMPT_CACHE_KEY_SCOPE = 'wat'
    expect(getOpenAIPromptCacheKeyScope()).toBe('prefix')
  })

  test('falls back to the session key when there is no prefix to route to', () => {
    expect(
      resolveOpenAIPromptCacheKey({
        ...base,
        sessionId: 'abc',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      }),
    ).toBe('occ:abc')
  })

  test('suppression still wins over any scope', () => {
    markPromptCacheKeyRejected('responses')
    expect(
      resolveOpenAIPromptCacheKey({ ...base, sessionId: 'abc' }),
    ).toBeUndefined()
    _resetPromptCacheKeySupportForTesting()
    process.env.OPENAI_PROMPT_CACHE_KEY = '0'
    expect(
      resolveOpenAIPromptCacheKey({ ...base, sessionId: 'abc' }),
    ).toBeUndefined()
  })
})
