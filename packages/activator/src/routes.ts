// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  MessageType,
  ProtocolErrorCode,
  taskExpiresAt,
  type QianmoMessage,
} from '@qianmo/protocol'
import type { TransportChannel } from '@qianmo/transport'
import { ActivatorEventType, type AuditLog } from './audit.js'
import {
  type CancelTimer,
  type Clock,
  type Scheduler,
  systemClock,
  timerScheduler,
} from './clock.js'

export const DEFAULT_TASK_ROUTE_CAPACITY = 1_000

/** Largest delay `setTimeout` takes before silently collapsing it to 1 ms. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

export class TaskRouteError extends Error {
  readonly code: ProtocolErrorCode

  constructor(code: ProtocolErrorCode, message: string) {
    super(message)
    this.name = 'TaskRouteError'
    this.code = code
  }
}

interface TaskRoute {
  readonly request: QianmoMessage
  readonly sandboxName: string
  readonly channel: TransportChannel
  readonly releaseChannel: () => void
  readonly cancelExpiry: CancelTimer
}

export interface TaskRouteRegistryOptions {
  readonly audit: AuditLog
  readonly clock?: Clock
  readonly scheduler?: Scheduler
  readonly capacity?: number
}

/** Owns the authenticated return route from request acceptance to task terminal. */
export class TaskRouteRegistry {
  readonly #routes = new Map<string, TaskRoute>()
  readonly #audit: AuditLog
  readonly #clock: Clock
  readonly #scheduler: Scheduler
  readonly #capacity: number

  constructor(options: TaskRouteRegistryOptions) {
    this.#audit = options.audit
    this.#clock = options.clock ?? systemClock
    this.#scheduler = options.scheduler ?? timerScheduler
    this.#capacity = options.capacity ?? DEFAULT_TASK_ROUTE_CAPACITY
  }

  get size(): number {
    return this.#routes.size
  }

  register(
    request: QianmoMessage,
    sandboxName: string,
    channel: TransportChannel,
  ): void {
    if (request.type !== MessageType.TaskRequest) {
      throw new TaskRouteError(
        ProtocolErrorCode.E_BAD_TYPE,
        `cannot register a return route for ${request.type}`,
      )
    }
    if (taskExpiresAt(request) <= this.#clock.now()) {
      throw new TaskRouteError(
        ProtocolErrorCode.E_TASK_TIMEOUT,
        `task ${request.taskId} expired before route registration`,
      )
    }
    const existing = this.#routes.get(request.taskId)
    if (existing !== undefined) {
      if (
        existing.request.msgId === request.msgId &&
        existing.channel.id === channel.id &&
        existing.sandboxName === sandboxName
      ) {
        return
      }
      throw new TaskRouteError(
        ProtocolErrorCode.E_BAD_ENVELOPE,
        `task ${request.taskId} already belongs to another return route`,
      )
    }
    if (this.#routes.size >= this.#capacity) {
      throw new TaskRouteError(
        ProtocolErrorCode.E_RATE_LIMITED,
        `task route table reached its configured maximum ${this.#capacity}`,
      )
    }

    const releaseChannel = channel.hold()
    const cancelExpiry = this.#scheduleExpiry(request, () => {
      const current = this.#routes.get(request.taskId)
      if (current?.request.msgId !== request.msgId) return
      this.#routes.delete(request.taskId)
      current.releaseChannel()
      this.#audit.record(
        ActivatorEventType.TaskRouteExpired,
        this.#clock.now(),
        {
          taskId: request.taskId,
          msgId: request.msgId,
          channelId: channel.id,
        },
      )
    })
    this.#routes.set(request.taskId, {
      request,
      sandboxName,
      channel,
      releaseChannel,
      cancelExpiry,
    })
    this.#audit.record(
      ActivatorEventType.TaskRouteRegistered,
      this.#clock.now(),
      {
        taskId: request.taskId,
        msgId: request.msgId,
        channelId: channel.id,
        sandboxName,
      },
    )
  }

  /**
   * Arm the task deadline, re-arming across the platform's timer ceiling.
   *
   * `taskTtlMs` is only required to be positive (`validate.ts`), so a peer can
   * ask for a deadline past `setTimeout`'s 32-bit limit. A timer armed beyond
   * it does not fire late — Node and Bun both **clamp it to 1 ms**, which would
   * tear the return route down almost immediately and reject the very ack the
   * longer deadline was asking to wait for. So the wait is split into legal
   * chunks and only the real clock decides when the task is over.
   */
  #scheduleExpiry(request: QianmoMessage, expire: () => void): () => void {
    let cancel: () => void = () => {}
    const arm = (): void => {
      const remaining = taskExpiresAt(request) - this.#clock.now()
      cancel = this.#scheduler.after(
        Math.min(Math.max(0, remaining), MAX_TIMER_DELAY_MS),
        () => {
          if (this.#clock.now() < taskExpiresAt(request)) {
            arm()
            return
          }
          expire()
        },
      )
    }
    arm()
    return () => cancel()
  }

  forward(reply: QianmoMessage, sandboxName?: string): void {
    const route = this.#routes.get(reply.taskId)
    if (route === undefined) {
      throw this.#reject(reply, 'no active return route')
    }
    if (sandboxName !== undefined && route.sandboxName !== sandboxName) {
      throw this.#reject(reply, 'reply arrived from the wrong sandbox route')
    }
    if (reply.to !== route.request.from || reply.from !== route.request.to) {
      throw this.#reject(reply, 'reply addresses do not reverse the request')
    }
    if (
      reply.type !== MessageType.Ack &&
      reply.type !== MessageType.TaskResult &&
      reply.type !== MessageType.Error
    ) {
      throw this.#reject(
        reply,
        `message type ${reply.type} is not a task reply`,
      )
    }

    route.channel.send(reply)
    this.#audit.record(
      ActivatorEventType.TaskReplyForwarded,
      this.#clock.now(),
      {
        taskId: reply.taskId,
        msgId: reply.msgId,
        type: reply.type,
        channelId: route.channel.id,
      },
    )
    if (reply.type !== MessageType.Ack) this.#remove(reply.taskId)
  }

  remove(taskId: string): void {
    this.#remove(taskId)
  }

  close(): void {
    for (const taskId of [...this.#routes.keys()]) this.#remove(taskId)
  }

  #remove(taskId: string): void {
    const route = this.#routes.get(taskId)
    if (route === undefined) return
    this.#routes.delete(taskId)
    route.cancelExpiry()
    route.releaseChannel()
  }

  #reject(reply: QianmoMessage, reason: string): TaskRouteError {
    this.#audit.record(
      ActivatorEventType.TaskReplyRejected,
      this.#clock.now(),
      {
        taskId: reply.taskId,
        msgId: reply.msgId,
        type: reply.type,
        reason,
      },
    )
    return new TaskRouteError(ProtocolErrorCode.E_BAD_ENVELOPE, reason)
  }
}
