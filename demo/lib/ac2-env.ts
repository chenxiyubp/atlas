// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P2.5 —— AC-2 唤醒转发脚本的配置读取口。
 *
 * **这里是这组脚本唯一读取部署信息的地方，而且只从环境变量读。**
 * 沙箱 daemon 的 bearer、传输层 PSK、沙箱名、容器地址——一个都不在仓库里，
 * 缺哪个就报哪个的名字然后退出，绝不静默跳过：静默跳过的核验脚本会给出
 * 「没报错 = 通过」的错觉，而那正是判据要防的东西。
 *
 * 三个变量名不是本文件自己起的，取自会用到它们的包，避免同一个事实两处定义：
 *   - daemon URL / bearer ← `@qianmo/activator`
 *   - 传输层 PSK          ← `@qianmo/transport`
 */

import { DAEMON_TOKEN_ENV_VAR, DAEMON_URL_ENV_VAR } from '@qianmo/activator'
import { PSK_ENV_VAR } from '@qianmo/transport'

/** 目标沙箱在 daemon 里的 **name**（不是 id，见 `daemon.ts` 的说明）。 */
export const SANDBOX_ENV_VAR = 'QIANMO_AC2_SANDBOX'

/** 目标节点段名，即地址 `qianmo://<node>/<agent>` 里的 `<node>`。 */
export const NODE_ENV_VAR = 'QIANMO_AC2_NODE'

/** 目标智能体名，即地址里的 `<agent>`。 */
export const AGENT_ENV_VAR = 'QIANMO_AC2_AGENT'

/** 沙箱内那个节点的监听地址，**从宿主看过去**（容器地址，不是回环）。 */
export const TARGET_URL_ENV_VAR = 'QIANMO_AC2_TARGET_URL'

/** 发送方拨向 activator 的地址。由 activator 进程启动时写出。 */
export const ACTIVATOR_URL_ENV_VAR = 'QIANMO_AC2_ACTIVATOR_URL'

/** 缺变量时的统一报错：说清楚缺的是谁、它是干什么的。 */
export class MissingConfigError extends Error {
  constructor(variable: string, what: string) {
    super(
      `${variable} 未设置（${what}）——本脚本只从环境变量取，不读文件、不猜默认值`,
    )
    this.name = 'MissingConfigError'
  }
}

function required(variable: string, what: string): string {
  const value = process.env[variable]
  if (value === undefined || value.trim() === '') {
    throw new MissingConfigError(variable, what)
  }
  return value
}

/** daemon 基址。回环校验由 `assertLoopbackBaseUrl` 在构造客户端时做。 */
export function daemonUrl(): string {
  return required(DAEMON_URL_ENV_VAR, '沙箱 daemon 的回环基址')
}

/**
 * daemon bearer。
 *
 * 只在这里读、只往下传给 `HttpSandboxDaemon` 的 `token` getter，
 * 不落盘、不进日志、不进任何 JSON 输出。
 */
export function daemonToken(): string {
  return required(DAEMON_TOKEN_ENV_VAR, '沙箱 daemon 的 bearer')
}

/** 两跳传输共用的 PSK。 */
export function psk(): string {
  return required(PSK_ENV_VAR, '传输层预共享密钥')
}

export function sandboxName(): string {
  return required(SANDBOX_ENV_VAR, '目标沙箱在 daemon 中的 name')
}

export function targetNode(): string {
  return process.env[NODE_ENV_VAR] ?? 'node-b'
}

export function targetAgent(): string {
  return process.env[AGENT_ENV_VAR] ?? 'reviewer'
}

/** 目标智能体的完整阡陌地址。 */
export function targetAddress(): string {
  return `qianmo://${targetNode()}/${targetAgent()}`
}

export function targetUrl(): string {
  return required(TARGET_URL_ENV_VAR, '沙箱内节点的监听地址（宿主视角）')
}

export function activatorUrl(): string {
  return required(ACTIVATOR_URL_ENV_VAR, 'activator 的入站监听地址')
}
