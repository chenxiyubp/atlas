// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 边界类 ⑤：异常退出——整台常驻节点那一层（`protocol.md` §8.3）。
 *
 * `abnormal-exit.test.ts` 在组件层回答「崩了之后系统还欠谁一个答复」；这里把同一个
 * 问题放到一台真的常驻节点上：真 `QianmoResident`、真 ACP 子进程（仓库里那份 stub
 * agent，`src/services/qianmo/__tests__/fixtures/`）、真握手、真回执。组件层测不出
 * 这一类，因为失效出在拆机顺序上，只有零件装齐了才有顺序。
 *
 * | §8.3 的行 | 这里怎么测 |
 * |---|---|
 * | 接收方在 `delivered` 后崩溃（拆机那一半） | 回复已上线、回执未归时停机：等回执回来再拆，不给 `onError` 一条没发生过的故障 |
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MessageType,
  createMessage,
  type QianmoMessage,
} from '@qianmo/protocol'
import { TransportClient } from '@qianmo/transport'
import { QianmoResident } from '../../src/services/qianmo/resident.js'

const PSK = 'boundary-resident-psk-not-a-real-secret'
const ACP_FIXTURE = join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'services',
  'qianmo',
  '__tests__',
  'fixtures',
  'resident-acp-agent.runner.ts',
)

const children: ChildProcess[] = []
const clients: TransportClient[] = []
let root: string | undefined
let previousConfigDir: string | undefined
let activeResident: QianmoResident | undefined
let activeRun: Promise<void> | undefined

afterEach(async () => {
  activeResident?.stop()
  await activeRun
  activeResident = undefined
  activeRun = undefined
  for (const client of clients.splice(0)) await client.close()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  }
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 8_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

describe('⑤ 异常退出 —— 接收方在回复上线、回执未归时停机', () => {
  test('等回执回来再拆传输，不把一条已送达的回复报成故障', async () => {
    // 修复 9b8cbf58 之前：`#settleTask` 在首个 await 之前就把任务移出两张表，
    // `#failActiveTasks` 扫不到它，`transport.stop()` 随即把这条回复的回执等待拒绝成
    // 「transport server closed before receipt」——回复早已送达，被取消的只是确认，
    // `onError` 收到的是一条没发生过的故障。原先唯一钉住它的是一条整合用例里的
    // 断言，靠对端答得快慢掷硬币：CI 慢机上偶发红，本机 20 轮打不红。这里把回执
    // 扣在对端手里，让那个窗口必然出现。
    root = mkdtempSync(join(tmpdir(), 'qianmo-boundary-resident-'))
    previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
    const socket = join(root, 'resident.sock')
    const ready: string[] = []
    const errors: unknown[] = []
    const resident = new QianmoResident({
      node: 'node-b',
      team: 'nest',
      agents: [{ agent: 'reviewer', cwd: join(root, 'workspace') }],
      pollIntervalMs: 20,
      psk: PSK,
      listen: { unix: socket },
      spawnAcp: () => {
        const child = spawn(process.execPath, [ACP_FIXTURE], {
          stdio: ['pipe', 'pipe', 'inherit'],
        })
        children.push(child)
        return child
      },
      onReady: address => {
        if (address.unix !== undefined) ready.push(address.unix)
      },
      onError: error => errors.push(error),
    })
    activeResident = resident
    const running = resident.run()
    activeRun = running
    await waitUntil(() => ready.length === 1)

    // 对端的回执要等它的入站处理返回才发出：把处理扣住，就造出了「回复已上线、
    // 回执还在路上」。
    let releaseReceipt = (): void => {}
    const receiptHeld = new Promise<void>(resolve => {
      releaseReceipt = resolve
    })
    const results: QianmoMessage[] = []
    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      // 节点拆掉之后不再重拨：这条用例关心的只有拆机那一侧。
      backoff: { giveUpAfterMs: 0 },
      onMessage: async message => {
        if (message.type !== MessageType.TaskResult) return
        results.push(message)
        await receiptHeld
      },
    })
    clients.push(client)
    await client.connect(3_000)
    client.send(
      createMessage({
        from: 'qianmo://node-a/planner',
        to: 'qianmo://node-b/reviewer',
        type: MessageType.TaskRequest,
        payload: { ask: 'work' },
      }),
    )
    await waitUntil(() => results.length === 1)

    resident.stop()
    // 给拆机留足时间走到拆传输那一步——修复前，回执等待就是在这段时间里被拒掉的。
    await new Promise(resolve => setTimeout(resolve, 300))
    releaseReceipt()
    await running

    expect(
      errors.map(String).filter(line => line.includes('before receipt')),
    ).toEqual([])
    expect(errors).toEqual([])
  }, 20_000)
})
