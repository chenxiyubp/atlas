// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  MessageType,
  ProtocolErrorCode,
  createAck,
  createMessage,
  createTaskResult,
  peerSupportsType,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  ReceiptStatus,
  type SuccessfulReceiptStatus,
  type TransportChannel,
} from '@qianmo/transport'
import { ActivatorEventType, AuditLog } from '../src/audit.js'
import { TaskRouteError, TaskRouteRegistry } from '../src/routes.js'
import { ManualClock, ManualScheduler, makeMessage } from './helpers.js'

class RecordingChannel implements TransportChannel {
  readonly id: string
  readonly peerNode = 'node-a'
  readonly sent: QianmoMessage[] = []
  holds = 0
  /** Undeclared, i.e. the legacy floor — what these routes have always spoken. */
  readonly peerSupportedTypes = undefined

  constructor(id: string) {
    this.id = id
  }

  get pending(): number {
    return 0
  }

  supports(type: MessageType): boolean {
    return peerSupportsType(this.peerSupportedTypes, type)
  }

  isReady(): boolean {
    return true
  }

  isClosed(): boolean {
    return false
  }

  send(message: QianmoMessage): void {
    this.sent.push(message)
  }

  async sendAndWait(message: QianmoMessage): Promise<SuccessfulReceiptStatus> {
    this.send(message)
    return ReceiptStatus.Accepted
  }

  waitForDrain(): Promise<void> {
    return Promise.resolve()
  }

  hold(): () => void {
    this.holds += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds -= 1
    }
  }
}

function setup(capacity = 4) {
  const clock = new ManualClock(10_000)
  const scheduler = new ManualScheduler()
  const audit = new AuditLog()
  const routes = new TaskRouteRegistry({ audit, clock, scheduler, capacity })
  return { clock, scheduler, audit, routes }
}

describe('TaskRouteRegistry', () => {
  test('keeps the route for ack and releases it after task.result', () => {
    const { routes, scheduler } = setup()
    const channel = new RecordingChannel('channel-a')
    const request = makeMessage({ taskId: 'task-1', createdAt: 10_000 })
    routes.register(request, 'sandbox-b', channel)

    expect(channel.holds).toBe(1)
    expect(scheduler.size).toBe(1)
    routes.forward(createAck(request, request.to, 10_100), 'sandbox-b')
    expect(routes.size).toBe(1)
    expect(channel.holds).toBe(1)

    routes.forward(
      createTaskResult(
        request,
        request.to,
        { outcome: 'completed', content: 'done' },
        10_200,
      ),
      'sandbox-b',
    )
    expect(channel.sent.map(message => message.type)).toEqual([
      MessageType.Ack,
      MessageType.TaskResult,
    ])
    expect(routes.size).toBe(0)
    expect(channel.holds).toBe(0)
    expect(scheduler.size).toBe(0)
  })

  test('rejects replies from another sandbox or with non-reversed addresses', () => {
    const { routes, audit } = setup()
    const channel = new RecordingChannel('channel-a')
    const request = makeMessage({ taskId: 'task-2', createdAt: 10_000 })
    routes.register(request, 'sandbox-b', channel)
    const result = createTaskResult(
      request,
      request.to,
      { outcome: 'completed', content: 'done' },
      10_200,
    )

    expect(() => routes.forward(result, 'sandbox-c')).toThrow(TaskRouteError)
    const forged = createMessage({
      ...result,
      type: MessageType.TaskResult,
      from: 'qianmo://node-c/other',
      payload: result.payload,
    })
    expect(() => routes.forward(forged, 'sandbox-b')).toThrow(TaskRouteError)
    expect(channel.sent).toEqual([])
    expect(routes.size).toBe(1)
    expect(audit.count(ActivatorEventType.TaskReplyRejected)).toBe(2)
    routes.close()
  })

  test('bounds route ownership and expires unanswered tasks', () => {
    const { clock, scheduler, audit, routes } = setup(1)
    const firstChannel = new RecordingChannel('channel-a')
    const secondChannel = new RecordingChannel('channel-b')
    const first = makeMessage({ taskId: 'task-3', createdAt: 10_000 })
    const second = makeMessage({ taskId: 'task-4', createdAt: 10_000 })
    routes.register(first, 'sandbox-b', firstChannel)

    try {
      routes.register(second, 'sandbox-b', secondChannel)
      throw new Error('expected route capacity rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(TaskRouteError)
      expect((error as TaskRouteError).code).toBe(
        ProtocolErrorCode.E_RATE_LIMITED,
      )
    }

    clock.advance(first.taskTtlMs)
    expect(scheduler.fireNext()).toBe(true)
    expect(routes.size).toBe(0)
    expect(firstChannel.holds).toBe(0)
    expect(audit.count(ActivatorEventType.TaskRouteExpired)).toBe(1)
  })

  test('a deadline past the timer ceiling waits, it does not fire at once', () => {
    const { clock, scheduler, audit, routes } = setup()
    const channel = new RecordingChannel('channel-a')
    // `setTimeout` collapses anything past 2^31-1 ms to 1 ms, so an unclamped
    // arm would tear this route down immediately — rejecting the very ack the
    // long deadline was asking to wait for.
    const request = makeMessage({
      taskId: 'task-long',
      createdAt: 10_000,
      taskTtlMs: 5_000_000_000,
    })
    routes.register(request, 'sandbox-b', channel)
    expect(scheduler.delays).toEqual([2_147_483_647])

    clock.advance(2_147_483_647)
    expect(scheduler.fireNext()).toBe(true)
    expect(routes.size).toBe(1)
    expect(channel.holds).toBe(1)
    expect(audit.count(ActivatorEventType.TaskRouteExpired)).toBe(0)

    clock.advance(request.taskTtlMs)
    expect(scheduler.fireNext()).toBe(true)
    expect(routes.size).toBe(0)
    expect(channel.holds).toBe(0)
    expect(audit.count(ActivatorEventType.TaskRouteExpired)).toBe(1)
  })
})
