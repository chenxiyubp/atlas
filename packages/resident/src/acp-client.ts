// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
} from '@agentclientprotocol/sdk'
import type {
  Client,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  Stream,
} from '@agentclientprotocol/sdk'
import type { ResidentSessionConnection } from './sessions.js'
import {
  ACP_INPUT_ACCEPTED_METHOD,
  ACP_SESSION_ACTIVITY_METHOD,
  ACP_UPSTREAM_STATUS_METHOD,
  type AcpPromptConnection,
} from './acp-turn.js'

export type ResidentActivitySink = (active: boolean) => void | Promise<void>

/**
 * 无人值守那一轮的权限姿态。
 *
 * `dontAsk`（默认，也是这个包一直以来的姿态）的语义是**不提示、未预批准即拒绝**，
 * 而这个包的 {@link ResidentClient.requestPermission} 又硬钉成 `cancelled`。两者合
 * 起来：没有任何东西被放行，包括 agent 在**自己工作区里**建一个文件——2026-08-28
 * 在内测环境上撞到的正是这一条，模型回话说「当前权限模式拒绝文件写入」，而工作区
 * 目录可写、节点日志里一条文件系统错误都没有。
 *
 * `acceptEdits` 只放宽一件事：**工作目录之内**的编辑（基座
 * `filesystem.ts` 的 `pathInAllowedWorkingPath` 门控，配置文件与敏感路径仍由
 * `checkPathSafetyForAutoEdit` 挡在前面，本包 `guard.ts` 的硬名单又排在那之前）。
 * 其余需要授权的工具照样落到 `requestPermission` → `cancelled`，也就是照样拒绝。
 *
 * **为什么走「模式」而不是「预批准规则」**：ACP 会话的权限上下文是
 * `getEmptyToolPermissionContext()` 建的，settings.json 里的 allow 规则根本不进
 * 这条路——实测把规则写进节点配置根，写文件依然被拒。模式则经 `_meta` 传进去，
 * 是这条路上真正生效的那一个旋钮。
 */
export type ResidentPermissionMode = 'dontAsk' | 'acceptEdits'

export interface ResidentAcpClientOptions {
  readonly stream: Stream
  /** 缺省 `dontAsk`——放宽是显式动作，不是默认。 */
  readonly permissionMode?: ResidentPermissionMode
  readonly onInputAccepted: (params: Record<string, unknown>) => Promise<void>
  readonly onActivity?: ResidentActivitySink
  readonly onSessionUpdate?: (
    params: SessionNotification,
  ) => void | Promise<void>
  /**
   * The agent's model endpoint answered with an HTTP status (failures only).
   *
   * The host cannot observe the agent's upstream traffic, so this is the only
   * way a refused credential becomes visible out here before the inactivity
   * watchdog has to explain a silence it did not cause (issue #37).
   */
  readonly onUpstreamStatus?: (params: Record<string, unknown>) => void
  /**
   * Handle an ACP ext **request** from the agent, agent → host.
   *
   * The three `qianmo/*` hooks above are one-way; this one carries an answer
   * back, which is what `qianmo_notify` needs — the model's next move depends
   * on whether the notification actually left. Kept as one open-ended hook
   * rather than a second named callback because the method name is a base
   * concern (`src/services/qianmo/notifyWire.ts`) and this package has no
   * business learning it: a package that names the host's methods is a package
   * that has to be edited every time the host grows one.
   *
   * Returning `undefined` means "not mine" and produces a method-not-found on
   * the wire, which is the honest answer for a method this host does not
   * implement.
   */
  readonly onExtMethod?: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | undefined>
}

class ResidentClient implements Client {
  readonly #onInputAccepted: (params: Record<string, unknown>) => Promise<void>
  readonly #onActivity: ResidentActivitySink | undefined
  readonly #onSessionUpdate:
    | ((params: SessionNotification) => void | Promise<void>)
    | undefined
  readonly #onUpstreamStatus:
    | ((params: Record<string, unknown>) => void)
    | undefined
  readonly #onExtMethod:
    | ((
        method: string,
        params: Record<string, unknown>,
      ) => Promise<Record<string, unknown> | undefined>)
    | undefined

  constructor(options: ResidentAcpClientOptions) {
    this.#onInputAccepted = options.onInputAccepted
    this.#onActivity = options.onActivity
    this.#onSessionUpdate = options.onSessionUpdate
    this.#onUpstreamStatus = options.onUpstreamStatus
    this.#onExtMethod = options.onExtMethod
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const answer = await this.#onExtMethod?.(method, params)
    if (answer === undefined) {
      throw new Error(`resident host does not implement ${method}`)
    }
    return answer
  }

  async requestPermission(
    _params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    return { outcome: { outcome: 'cancelled' } }
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    await this.#onSessionUpdate?.(params)
  }

  async extNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === ACP_INPUT_ACCEPTED_METHOD) {
      await this.#onInputAccepted(params)
      return
    }
    if (method === ACP_SESSION_ACTIVITY_METHOD) {
      if (typeof params.active === 'boolean') {
        await this.#onActivity?.(params.active)
      }
      return
    }
    if (method === ACP_UPSTREAM_STATUS_METHOD) {
      this.#onUpstreamStatus?.(params)
    }
  }
}

export class ResidentAcpConnection
  implements ResidentSessionConnection, AcpPromptConnection
{
  readonly #connection: ClientSideConnection
  readonly #permissionMode: ResidentPermissionMode

  constructor(options: ResidentAcpClientOptions) {
    const client = new ResidentClient(options)
    this.#permissionMode = options.permissionMode ?? 'dontAsk'
    this.#connection = new ClientSideConnection(() => client, options.stream)
  }

  get closed(): Promise<void> {
    return this.#connection.closed
  }

  async initialize(): Promise<void> {
    await this.#connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'qianmo-resident', version: '0' },
      _meta: { qianmo: { resident: true } },
    })
  }

  async newSession(input: { agent: string; cwd: string }): Promise<string> {
    const result = await this.#connection.newSession({
      cwd: input.cwd,
      mcpServers: [],
      _meta: {
        permissionMode: this.#permissionMode,
        qianmo: { resident: true, agent: input.agent },
      },
    })
    return result.sessionId
  }

  async resumeSession(input: {
    agent: string
    cwd: string
    sessionId: string
  }): Promise<void> {
    await this.#connection.unstable_resumeSession({
      sessionId: input.sessionId,
      cwd: input.cwd,
      mcpServers: [],
      _meta: {
        permissionMode: this.#permissionMode,
        qianmo: { resident: true, agent: input.agent },
      },
    })
  }

  /**
   * ACP `session/cancel`. Used by the inactivity watchdog and nothing else.
   *
   * A notification, so it returns as soon as it is written: the agent ends the
   * turn on its own schedule and the outstanding `prompt` settles with
   * `stopReason: 'cancelled'`. The watchdog does not wait for that — it has
   * already failed the turn — which is why {@link AcpPromptConnection.cancel}
   * is best effort by contract.
   */
  async cancel(params: {
    sessionId: string
    _meta?: Record<string, unknown>
  }): Promise<void> {
    await this.#connection.cancel({
      sessionId: params.sessionId,
      // Forwarded verbatim. ACP reserves `_meta` for exactly this — one side
      // telling the other something the schema has no field for — and here it
      // carries the difference between "a person cancelled" and "this node's
      // watchdog gave up", which is what the agent writes into the transcript.
      ...(params._meta === undefined ? {} : { _meta: params._meta }),
    })
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return await this.#connection.extMethod(method, params)
  }

  async prompt(params: {
    sessionId: string
    messageId: string
    prompt: readonly [{ type: 'text'; text: string }]
  }): Promise<{
    readonly userMessageId?: string | null
    readonly stopReason?: string
    readonly _meta?: Record<string, unknown> | null
  }> {
    return await this.#connection.prompt({
      sessionId: params.sessionId,
      messageId: params.messageId,
      prompt: [...params.prompt],
    })
  }
}

export function createResidentAcpStream(
  writableToAgent: WritableStream<Uint8Array>,
  readableFromAgent: ReadableStream<Uint8Array>,
): Stream {
  return ndJsonStream(writableToAgent, readableFromAgent)
}
