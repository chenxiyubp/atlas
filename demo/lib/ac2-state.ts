// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P2.5 —— 读沙箱状态，并可等到它进入某个状态。
 *
 *   bun run demo/lib/ac2-state.ts
 *   bun run demo/lib/ac2-state.ts --wait-for frozen --timeout-s 240
 *
 * 走的是 `@qianmo/activator` 的只读能力（`listSandboxes` + 客户端过滤），
 * **不是**另写一个 daemon 客户端：这个进程和 activator 握着同一把 bearer，
 * 而那把 bearer 能唤醒也能销毁。绕过白名单自己 fetch，AC-6(c) 当场就不成立了。
 *
 * 「等到 frozen」是 DoD ① 的前提而不是装饰：目标不在休眠态时投递，
 * 测的是「消息能不能送到一个醒着的节点」，那不是这条判据要证的东西。
 */

import {
  AuditLog,
  HttpSandboxDaemon,
  type SandboxState,
} from '@qianmo/activator'
import { arg, emit, intArg } from './cli-args.js'
import { daemonToken, daemonUrl, sandboxName } from './ac2-env.js'

const sandbox = sandboxName()
const daemon = new HttpSandboxDaemon({
  baseUrl: daemonUrl(),
  token: daemonToken,
  audit: new AuditLog(),
})

const waitFor = arg('wait-for')
const timeoutS = intArg('timeout-s', 240)
const stepMs = intArg('step-ms', 2_000)

const startedAt = Date.now()
let state: SandboxState | 'unreadable' = 'unreadable'
let error = ''

for (;;) {
  try {
    state = (await daemon.status(sandbox)).state
    error = ''
  } catch (failure) {
    state = 'unreadable'
    error = failure instanceof Error ? failure.message : String(failure)
  }
  const elapsedS = Math.round((Date.now() - startedAt) / 1000)
  if (waitFor === undefined || state === waitFor) break
  if (elapsedS >= timeoutS) break
  await new Promise(resolve => setTimeout(resolve, stepMs))
}

const elapsedS = Math.round((Date.now() - startedAt) / 1000)
const reached = waitFor === undefined || state === waitFor
emit({ sandbox, state, waitFor: waitFor ?? null, reached, elapsedS, error })
process.exit(reached ? 0 : 1)
