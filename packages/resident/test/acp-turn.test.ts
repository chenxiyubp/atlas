// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, mock, test } from 'bun:test'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { ProtocolErrorCode } from '@qianmo/protocol'
import {
  AcpResidentTurnPort,
  RESIDENT_INACTIVITY_CANCEL_META,
  parseTurnStepDedupKey,
  turnFailureKind,
  turnStepDedupKey,
} from '../src/acp-turn.js'
import { ResidentInactivityError } from '../src/inactivity.js'
import {
  ResidentTimingRecorder,
  type ResidentTimingEvent,
} from '../src/timings.js'

const INPUT = {
  sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  messageId: '11111111-2222-4333-8444-555555555555',
  prompt: 'mailbox prompt',
}

function chunk(text: string, sessionId = INPUT.sessionId): SessionNotification {
  return {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    },
  }
}

describe('ACP resident turn port', () => {
  test('checks deterministic input status through the resident extension', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: true })),
      prompt: mock(async () => ({ userMessageId: null })),
    }
    const port = new AcpResidentTurnPort(connection)

    await expect(port.isAccepted(INPUT)).resolves.toBe(true)
    expect(connection.extMethod).toHaveBeenCalledWith('qianmo/input-status', {
      sessionId: INPUT.sessionId,
      messageId: INPUT.messageId,
    })
  })

  test('read-flip callback runs on input-accepted, before prompt completes', async () => {
    let releasePrompt!: () => void
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(
        () =>
          new Promise<{ userMessageId: null }>(resolve => {
            releasePrompt = () => resolve({ userMessageId: null })
          }),
      ),
    }
    const port = new AcpResidentTurnPort(connection)
    const accepted = mock(async () => {})

    const executing = port.execute(INPUT, accepted)
    await port.handleInputAccepted({ messageId: INPUT.messageId })

    expect(accepted).toHaveBeenCalledTimes(1)
    expect(connection.prompt).toHaveBeenCalledWith({
      sessionId: INPUT.sessionId,
      messageId: INPUT.messageId,
      prompt: [{ type: 'text', text: INPUT.prompt }],
    })
    releasePrompt()
    await executing
  })

  test('uses the prompt response message id when notification delivery races it', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({ userMessageId: INPUT.messageId })),
    }
    const port = new AcpResidentTurnPort(connection)
    const accepted = mock(async () => {})

    await port.execute(INPUT, accepted)

    expect(accepted).toHaveBeenCalledTimes(1)
  })

  test('aggregates the turn body from the structured agent message chunks', async () => {
    let releasePrompt!: () => void
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(
        () =>
          new Promise<{ userMessageId: string; stopReason: string }>(
            resolve => {
              releasePrompt = () =>
                resolve({
                  userMessageId: INPUT.messageId,
                  stopReason: 'end_turn',
                })
            },
          ),
      ),
    }
    const port = new AcpResidentTurnPort(connection)

    const executing = port.execute(INPUT, async () => {})
    // Thoughts are not the answer, and another session is not this task.
    port.handleSessionUpdate(chunk('the '))
    port.handleSessionUpdate({
      sessionId: INPUT.sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'thinking out loud' },
      },
    })
    port.handleSessionUpdate(chunk('stolen body', 'another-session'))
    port.handleSessionUpdate(chunk('answer'))
    releasePrompt()

    await expect(executing).resolves.toEqual({
      outcome: 'completed',
      content: 'the answer',
    })
  })

  test('a body cannot leak from one turn into the next', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({
        userMessageId: INPUT.messageId,
        stopReason: 'end_turn',
      })),
    }
    const port = new AcpResidentTurnPort(connection)

    const first = port.execute(INPUT, async () => {})
    port.handleSessionUpdate(chunk('first'))
    await first
    // Late chunk for a settled turn: dropped, not carried forward.
    port.handleSessionUpdate(chunk('late'))

    const second = port.execute(
      { ...INPUT, messageId: '22222222-3333-4444-8555-666666666666' },
      async () => {},
    )
    port.handleSessionUpdate(chunk('second'))

    await expect(second).resolves.toEqual({
      outcome: 'completed',
      content: 'second',
    })
  })

  test('a cancelled turn is a failed result, not an empty completed one', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({
        userMessageId: INPUT.messageId,
        stopReason: 'cancelled',
      })),
    }
    const port = new AcpResidentTurnPort(connection)

    await expect(port.execute(INPUT, async () => {})).resolves.toEqual({
      outcome: 'failed',
      code: ProtocolErrorCode.E_TASK_FAILED,
      reason: 'ACP turn was cancelled',
    })
  })

  test('refusals and ceiling stops are failures too, not truncated successes', async () => {
    for (const stopReason of ['refusal', 'max_tokens', 'max_turn_requests']) {
      const connection = {
        extMethod: mock(async () => ({ accepted: false })),
        prompt: mock(async () => ({
          userMessageId: INPUT.messageId,
          stopReason,
        })),
      }
      const port = new AcpResidentTurnPort(connection)

      const result = await port.execute(INPUT, async () => {})

      expect(result.outcome).toBe('failed')
      if (result.outcome !== 'failed') throw new Error('unreachable')
      expect(result.code).toBe(ProtocolErrorCode.E_TASK_FAILED)
      expect(result.reason.length).toBeGreaterThan(0)
    }
  })

  test('an unfamiliar stop reason is not invented into a failure', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({
        userMessageId: INPUT.messageId,
        stopReason: 'something_this_build_has_never_heard_of',
      })),
    }
    const port = new AcpResidentTurnPort(connection)

    await expect(port.execute(INPUT, async () => {})).resolves.toEqual({
      outcome: 'completed',
      content: '',
    })
  })

  test('an inactivity cancel says it was the watchdog, not a user', async () => {
    // Issue #39: `session/cancel` carries only a session id, so without this
    // `_meta` the agent on the other end wrote "[Request interrupted by user]"
    // into the transcript of an unattended node — contradicting the
    // `turn_failed: ResidentInactivityError` in the same task's timings.
    const timers: (() => void)[] = []
    const connection = {
      cancel: mock(async () => {}),
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(() => new Promise<{ userMessageId: null }>(() => {})),
    }
    const port = new AcpResidentTurnPort(connection, {
      inactivity: {
        timeoutMs: 1_000,
        schedule: (_delayMs, callback) => {
          timers.push(callback)
          return { cancel: () => {} }
        },
      },
    })

    const executing = port.execute(INPUT, async () => {})
    expect(timers.length).toBe(1)
    timers[0]!()
    await expect(executing).rejects.toBeInstanceOf(Error)

    expect(connection.cancel).toHaveBeenCalledWith({
      sessionId: INPUT.sessionId,
      _meta: RESIDENT_INACTIVITY_CANCEL_META,
    })
    expect(RESIDENT_INACTIVITY_CANCEL_META).toEqual({
      qianmo: { cancelReason: 'inactivity' },
    })
  })

  test('a 401 reported by the child renames the inactivity failure', async () => {
    // Issue #37 ②, end to end through the port: the ACP child sees the model
    // endpoint refuse this node's key (`qianmo/upstream-status`), the turn
    // then produces nothing, and the failure that reaches the sender has to
    // name the credential instead of describing a slow model.
    const timers: (() => void)[] = []
    const connection = {
      cancel: mock(async () => {}),
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(() => new Promise<{ userMessageId: null }>(() => {})),
    }
    const port = new AcpResidentTurnPort(connection, {
      inactivity: {
        timeoutMs: 120_000,
        schedule: (_delayMs, callback) => {
          timers.push(callback)
          return { cancel: () => {} }
        },
      },
    })

    const executing = port.execute(INPUT, async () => {})
    port.handleUpstreamStatus({
      status: 401,
      detail: '{"error":"Invalid API key"}',
    })
    timers[0]!()

    const error = await executing.then(
      () => undefined,
      (reason: unknown) => reason,
    )
    expect(error).toBeInstanceOf(ResidentInactivityError)
    const failure = error as ResidentInactivityError
    expect(failure.isCredentialFailure).toBe(true)
    expect(failure.message).toContain('HTTP 401')
    expect(failure.message).toContain('credential')
    expect(failure.message).toContain('Invalid API key')
  })

  test('a malformed upstream-status notification is ignored', async () => {
    const port = new AcpResidentTurnPort({
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({ userMessageId: null })),
    })
    for (const params of [
      {},
      { status: '401' },
      { status: null },
      { detail: 'no status at all' },
    ]) {
      port.handleUpstreamStatus(params as Record<string, unknown>)
    }
    expect(port.upstreamHealth.last).toBeUndefined()
  })

  test('unknown acceptance notifications cannot flip a mailbox entry', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({ userMessageId: null })),
    }
    const port = new AcpResidentTurnPort(connection)

    await expect(
      port.handleInputAccepted({ messageId: 'unknown' }),
    ).resolves.toBeUndefined()
  })
})

describe('turn progress', () => {
  const NETWORK_INPUT = { ...INPUT, networkMsgId: 'msg-1' }

  function toolCall(
    toolCallId: string,
    fields: Record<string, unknown> = {},
  ): SessionNotification {
    return {
      sessionId: INPUT.sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId,
        title: 'packages/router/src/rate.ts',
        ...fields,
      },
    } as unknown as SessionNotification
  }

  function toolUpdate(
    toolCallId: string,
    fields: Record<string, unknown> = {},
  ): SessionNotification {
    return {
      sessionId: INPUT.sessionId,
      update: { sessionUpdate: 'tool_call_update', toolCallId, ...fields },
    } as unknown as SessionNotification
  }

  async function runningPort(steps: unknown[]) {
    let releasePrompt!: () => void
    const connection = {
      extMethod: mock(async () => ({ accepted: true })),
      prompt: mock(
        () =>
          new Promise<{ userMessageId: null }>(resolve => {
            releasePrompt = () => resolve({ userMessageId: null })
          }),
      ),
    }
    const port = new AcpResidentTurnPort(connection, {
      onProgress: progress => {
        steps.push(progress)
      },
    })
    const executing = port.execute(NETWORK_INPUT, async () => {})
    // 让 execute 跑到把这一轮登记进 #active 那一步。
    await Promise.resolve()
    return {
      port,
      finish: async () => {
        releasePrompt()
        await executing
      },
    }
  }

  test('a tool is announced when it starts, not when it succeeds', async () => {
    const steps: unknown[] = []
    const { port, finish } = await runningPort(steps)

    port.handleSessionUpdate(toolCall('t1', { kind: 'read' }))
    // 成功收尾不再占一条：下一个工具的开始已经说明上一个结束了。
    port.handleSessionUpdate(toolUpdate('t1', { status: 'completed' }))

    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({
      sessionId: INPUT.sessionId,
      networkMsgId: 'msg-1',
      severity: 'info',
      summary: '读：packages/router/src/rate.ts',
      dedupKey: 'msg-1:t1:start',
    })
    await finish()
  })

  test('通知工具自己不占一行——它的产出就是那一行', async () => {
    // 2026-08-28 p11 上的形状：一行裸工具名 `qianmo_notify`，紧接着就是它产出的
    // 那句话。两行说同一件事，而前一行是没信息的那行。
    const steps: Array<{ summary: string }> = []
    const { port, finish } = await runningPort(steps as unknown[])

    port.handleSessionUpdate(
      toolCall('t1', { kind: 'other', title: 'qianmo_notify' }),
    )
    port.handleSessionUpdate(toolCall('t2', { kind: 'edit' }))

    expect(steps.map(step => step.summary)).toEqual([
      '改：packages/router/src/rate.ts',
    ])
    await finish()
  })

  test('跳过的那一次不白占本轮的过程额度', async () => {
    // 跳过发生在预算检查之后、扣减之前。所以连着 30 次通知工具调用一分额度都不花，
    // 第 31 个真工具照样报得出来——否则一个话多的 agent 能把 24 条额度全耗在几行
    // 根本不会出现的过程上。
    const steps: Array<{ summary: string }> = []
    const { port, finish } = await runningPort(steps as unknown[])

    for (let index = 0; index < 30; index += 1) {
      port.handleSessionUpdate(
        toolCall(`n${index}`, { kind: 'other', title: 'qianmo_notify' }),
      )
    }
    port.handleSessionUpdate(toolCall('real', { kind: 'edit' }))

    expect(steps.map(step => step.summary)).toEqual([
      '改：packages/router/src/rate.ts',
    ])
    await finish()
  })

  test('a failure gets its own line, and only one', async () => {
    const steps: Array<{ severity: string; dedupKey: string }> = []
    const { port, finish } = await runningPort(steps)

    port.handleSessionUpdate(toolCall('t1', { kind: 'execute' }))
    port.handleSessionUpdate(toolUpdate('t1', { status: 'failed' }))
    port.handleSessionUpdate(toolUpdate('t1', { status: 'failed' }))

    expect(steps).toHaveLength(2)
    expect(steps[1]).toMatchObject({
      severity: 'warn',
      dedupKey: 'msg-1:t1:failed',
    })
    await finish()
  })

  test('every step key a turn raises parses back, and nothing else does', async () => {
    // `qm watch` uses this parse to keep steps out of a person's view (§4.1⑤).
    // So the keys must come from the port, not from a hand-written string:
    // if the builder drifts, a hand-written key would still parse.
    const steps: Array<{ dedupKey: string }> = []
    const { port, finish } = await runningPort(steps)
    port.handleSessionUpdate(toolCall('call:with:colons', { kind: 'execute' }))
    port.handleSessionUpdate(
      toolUpdate('call:with:colons', { status: 'failed' }),
    )
    await finish()

    expect(steps.map(step => parseTurnStepDedupKey(step.dedupKey))).toEqual([
      {
        networkMsgId: 'msg-1',
        toolCallId: 'call:with:colons',
        phase: 'start',
      },
      {
        networkMsgId: 'msg-1',
        toolCallId: 'call:with:colons',
        phase: 'failed',
      },
    ])
    expect(turnStepDedupKey('m', 't', 'start')).toBe('m:t:start')
    for (const key of ['/', 'disk:/', 'm::start', ':t:start', 'm:t:done']) {
      expect(parseTurnStepDedupKey(key)).toBeUndefined()
    }
  })

  test('file paths the tool named ride along, bounded', async () => {
    const steps: Array<{ detail?: string }> = []
    const { port, finish } = await runningPort(steps)

    port.handleSessionUpdate(
      toolCall('t1', {
        kind: 'edit',
        locations: Array.from({ length: 12 }, (_unused, index) => ({
          path: `src/f${index}.ts`,
        })),
      }),
    )

    expect(steps[0]?.detail?.split('\n')).toHaveLength(8)
    expect(steps[0]?.detail).toContain('src/f0.ts')
    await finish()
  })

  test('a tool that named no files carries no detail', async () => {
    const steps: Array<{ detail?: string }> = []
    const { port, finish } = await runningPort(steps)
    port.handleSessionUpdate(toolCall('t1'))
    expect(steps[0]?.detail).toBeUndefined()
    await finish()
  })

  test('a turn stops reporting at the cap rather than queueing past it', async () => {
    const steps: unknown[] = []
    const { port, finish } = await runningPort(steps)

    for (let index = 0; index < 40; index += 1) {
      port.handleSessionUpdate(toolCall(`t${index}`))
    }

    // 上限是硬停，不是排队：一条在回复之后才到的过程，描述的是明明已经跑完的活。
    expect(steps).toHaveLength(24)
    await finish()
  })

  test('a tool kind inherited from Object.prototype is not a verb', async () => {
    // 对象字面量查表会走到原型上：`kind: "constructor"` 会取回一个函数，然后被
    // 字符串化进 notify 的 summary、渲染进操作者的转录。
    const steps: Array<{ summary: string }> = []
    const { port, finish } = await runningPort(steps)
    for (const kind of [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
    ]) {
      port.handleSessionUpdate(toolCall(`t-${kind}`, { kind }))
    }
    for (const step of steps) {
      expect(step.summary).toBe('packages/router/src/rate.ts')
    }
    await finish()
  })

  test('a chatty turn cannot starve the failures', async () => {
    // 一个计数器的算术是反的：24 条 start 花光预算之后，第 27 个工具的失败——
    // 整轮里唯一需要人动手的那一条——恰好是被丢掉的那条。
    const steps: Array<{ severity: string }> = []
    const { port, finish } = await runningPort(steps)

    for (let index = 0; index < 30; index += 1) {
      port.handleSessionUpdate(toolCall(`t${index}`))
    }
    port.handleSessionUpdate(toolUpdate('t27', { status: 'failed' }))

    expect(steps.filter(step => step.severity === 'info')).toHaveLength(24)
    expect(steps.filter(step => step.severity === 'warn')).toHaveLength(1)
    await finish()
  })

  test('a turn nobody asked for over the network raises no steps', async () => {
    const steps: unknown[] = []
    let releasePrompt!: () => void
    const connection = {
      extMethod: mock(async () => ({ accepted: true })),
      prompt: mock(
        () =>
          new Promise<{ userMessageId: null }>(resolve => {
            releasePrompt = () => resolve({ userMessageId: null })
          }),
      ),
    }
    const port = new AcpResidentTurnPort(connection, {
      onProgress: progress => {
        steps.push(progress)
      },
    })
    // 本地信箱来的一轮没有 networkMsgId——没有对端，也就没有人该收到这些。
    const executing = port.execute(INPUT, async () => {})
    await Promise.resolve()
    port.handleSessionUpdate(toolCall('t1'))
    expect(steps).toHaveLength(0)
    releasePrompt()
    await executing
  })

  test('without a consumer the port raises nothing at all', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: true })),
      prompt: mock(async () => ({ userMessageId: null })),
    }
    const port = new AcpResidentTurnPort(connection)
    // 不该抛：缺省就是「这个端口不报过程」。
    expect(() => port.handleSessionUpdate(toolCall('t1'))).not.toThrow()
  })
})

describe('a turn the agent reports as a model error', () => {
  const EMPTY_TEXT =
    'API Error [OpenAI]: Model returned an empty response (finish_reason=stop) · code=empty_response · category=server_error · retryable=yes'

  function erroredConnection(error: unknown) {
    return {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({
        userMessageId: INPUT.messageId,
        // ACP has no error stop reason; the agent keeps end_turn and says what
        // went wrong under `_meta`.
        stopReason: 'end_turn',
        _meta: { claudeCode: { error } },
      })),
    }
  }

  test('empty responses that outlasted the retries fail the turn, and say so', async () => {
    const events: ResidentTimingEvent[] = []
    const port = new AcpResidentTurnPort(
      erroredConnection({
        category: 'server_error',
        code: 'empty_response',
        message: EMPTY_TEXT,
      }),
      { timings: new ResidentTimingRecorder(event => events.push(event)) },
    )

    const result = await port.execute(INPUT, async () => {})

    expect(result.outcome).toBe('failed')
    if (result.outcome !== 'failed') throw new Error('unreachable')
    expect(result.code).toBe(ProtocolErrorCode.E_TASK_FAILED)
    expect(result.reason).toMatch(/^Model returned only empty responses/)
    expect(result.reason).toContain('finish_reason=stop')
    // What `qm watch` reads back to tell this failure from every other one.
    expect(turnFailureKind(result.reason)).toBe('model_empty_response')
    expect(events.map(event => [event.stage, event.error])).toEqual([
      ['turn_failed', 'model_empty_response'],
    ])
  })

  test('any other model error — an HTTP 400, say — is a failure, not a completion', async () => {
    const events: ResidentTimingEvent[] = []
    const port = new AcpResidentTurnPort(
      erroredConnection({
        category: 'invalid_request',
        message:
          'API Error [OpenAI]: 400 bad request · status=400 · category=invalid_request · retryable=no',
      }),
      { timings: new ResidentTimingRecorder(event => events.push(event)) },
    )

    const result = await port.execute(INPUT, async () => {})

    expect(result.outcome).toBe('failed')
    if (result.outcome !== 'failed') throw new Error('unreachable')
    expect(result.reason).toMatch(/^Model request failed/)
    expect(result.reason).toContain('status=400')
    expect(turnFailureKind(result.reason)).toBe('model_error')
    expect(events.map(event => [event.stage, event.error])).toEqual([
      ['turn_failed', 'model_error'],
    ])
  })

  test('the reason stays one bounded line whatever the agent sent', async () => {
    const port = new AcpResidentTurnPort(
      erroredConnection({
        category: 'server_error',
        message: `first line\n${'x'.repeat(4_000)}`,
      }),
    )

    const result = await port.execute(INPUT, async () => {})

    if (result.outcome !== 'failed') throw new Error('expected a failure')
    expect(result.reason).not.toContain('\n')
    expect(result.reason.length).toBeLessThanOrEqual(400)
  })

  test('an error with no usable message still fails with a reason', async () => {
    const port = new AcpResidentTurnPort(erroredConnection({}))

    const result = await port.execute(INPUT, async () => {})

    if (result.outcome !== 'failed') throw new Error('expected a failure')
    expect(result.reason).toMatch(/^Model request failed/)
  })

  test('only the reasons written for model errors are classified', () => {
    for (const reason of [
      'ACP turn was cancelled',
      'ACP turn ended in a refusal',
      'ACP turn hit the token ceiling before finishing',
      'ACP turn hit the request ceiling before finishing',
      'Internal error',
      '',
    ]) {
      expect(turnFailureKind(reason)).toBeUndefined()
    }
  })

  test('unrelated _meta leaves a clean end_turn completed', async () => {
    const connection = {
      extMethod: mock(async () => ({ accepted: false })),
      prompt: mock(async () => ({
        userMessageId: INPUT.messageId,
        stopReason: 'end_turn',
        _meta: { claudeCode: { usage: { totalTokens: 3 } } },
      })),
    }
    const port = new AcpResidentTurnPort(connection)

    await expect(port.execute(INPUT, async () => {})).resolves.toEqual({
      outcome: 'completed',
      content: '',
    })
  })
})
