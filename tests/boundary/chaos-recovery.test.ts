// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 边界库 v2：四类混沌注入的**确定性对应物**（P7.1）。
 *
 * `demo/chaos-inject.sh` 会在一小时里随机地杀进程、断网、打满磁盘、拨动时钟。
 * 那种跑法能发现我们没想到的组合，但它**不适合进 CI**：一小时太长，随机太吵，
 * 而一条随机跑出来的红色第二天未必复现。
 *
 * 所以每一类注入在这里都有一条**确定性**的对应用例：同一个失效，去掉随机与等待。
 * 两者的分工是清楚的——
 *
 * | | 混沌跑批 | 这个文件 |
 * |---|---|---|
 * | 找**没想到**的组合 | ✅ | ✗ |
 * | 防止**已知**的失效回归 | ✗（跑一小时才碰一次） | ✅（每次提交） |
 *
 * 判据也不同：混沌那边看「有没有未捕获异常、失败能不能对上已知边界」，这边看
 * 「这一次具体的失效，行为是不是我们说好的那个」。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import {
  MessageType,
  TimeJumpGate,
  createMessage,
  deliveryExpiresAt,
} from '@qianmo/protocol'
import { NodeRouter } from '@qianmo/router'
import {
  ReconnectSchedule,
  TransportClient,
  startTransportServer,
  type TransportServerHandle,
} from '@qianmo/transport'
import { FileSnapshotStore } from '@qianmo/backup'

const PSK = 'chaos-boundary-psk-not-a-real-secret'
const PLANNER = 'qianmo://node-a/planner'
const REVIEWER = 'qianmo://node-b/reviewer'
const NOW = 1_800_000_000_000

const servers: TransportServerHandle[] = []
const clients: TransportClient[] = []
const children: ChildProcess[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  for (const server of servers.splice(0)) await server.stop()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function workspace(prefix = 'qianmo-chaos-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

function request(taskId: string) {
  return createMessage({
    from: PLANNER,
    to: REVIEWER,
    type: MessageType.TaskRequest,
    payload: { ask: 'work' },
    taskId,
    // Pinned to the same instant the fake clocks use. An envelope stamped with
    // the real wall clock while the router runs on a fixed one is an envelope
    // whose deadline has already passed — the loop table would prune its own
    // entry between two calls and the test would prove nothing.
    createdAt: NOW,
  })
}

describe('注入 ① 随机杀进程', () => {
  test('子进程被 SIGKILL：父进程拿到退出信号，不是一个未捕获异常', async () => {
    // 混沌跑批杀的是常驻节点的 ACP 子进程。这里只验最底下那条性质：被杀这件事
    // 必须以**可处理的事件**到达父进程。它以异常形式冒出来的话，上面所有的重启
    // 逻辑都没机会跑。
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore',
      },
    )
    children.push(child)
    const exit = new Promise<{ code: number | null; signal: string | null }>(
      resolve => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
      },
    )
    child.kill('SIGKILL')
    const result = await exit
    expect(result.signal).toBe('SIGKILL')
    expect(result.code).toBeNull()
  })

  test('审计的续链让「被杀之后重启」看起来不像篡改', () => {
    // 进程被杀之后新起的那个如果从头开始写链，完整性检查每次重启都会报红；
    // 一个天天喊狼来了的检查没人会读。
    const dir = workspace()
    const path = join(dir, 'trail.ndjson')
    const before = new AuditTrail(path)
    before.append({
      at: NOW,
      source: AuditSource.Router,
      kind: 'rate_limited',
      outcome: 'refused',
    })
    // 没有 close()：模拟被 SIGKILL 的进程，句柄没来得及收。
    const after = new AuditTrail(path)
    after.append({
      at: NOW + 1,
      source: AuditSource.Router,
      kind: 'loop_detected',
      outcome: 'refused',
    })
    after.close()

    const result = readTrail(path)
    expect(result.intact).toBe(true)
    expect(result.records.map(record => record.seq)).toEqual([1, 2])
  })
})

describe('注入 ② 断网', () => {
  test('服务端消失期间发出的消息不算送达，回来之后才落地', async () => {
    const dir = workspace()
    const socket = join(dir, 'node.sock')
    const received: string[] = []
    let server = startTransportServer({
      psk: PSK,
      unix: socket,
      onMessage: message => {
        received.push(message.taskId)
      },
    })
    servers.push(server)

    const client = new TransportClient({
      endpoint: { unix: socket },
      node: 'node-a',
      psk: PSK,
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 10, maxDelayMs: 30, jitterRatio: 0 },
    })
    clients.push(client)
    await client.connect(3_000)
    await client.sendAndWait(request('before-cut'), 3_000)

    await server.stop()
    servers.splice(servers.indexOf(server), 1)
    const deadline = Date.now() + 2_000
    while (client.isReady() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    client.send(request('during-cut'))
    expect(received).toEqual(['before-cut'])

    server = startTransportServer({
      psk: PSK,
      unix: socket,
      onMessage: message => {
        received.push(message.taskId)
      },
    })
    servers.push(server)
    await client.waitForDrain(5_000)
    expect(received).toEqual(['before-cut', 'during-cut'])
  }, 15_000)

  test('重连预算是有限的：断得够久就放弃，而不是永远重试', () => {
    // 无限重试会让一个已经搬走的对端把这条链路永远挂在这里。
    const schedule = new ReconnectSchedule({
      baseDelayMs: 10,
      maxDelayMs: 20,
      jitterRatio: 0,
      giveUpAfterMs: 100,
      // High enough that the loop below never trips the freeze detector: a
      // budget reset here would be the gate working, not the give-up path.
      timeJumpFactor: 1_000,
    })
    let decision = schedule.next(NOW)
    let elapsed = 0
    let attempts = 0
    while (decision.action === 'retry' && attempts < 50) {
      elapsed += decision.delayMs
      attempts += 1
      decision = schedule.next(NOW + elapsed)
    }
    expect(decision.action).toBe('give-up')
    expect(attempts).toBeLessThan(50)
  })
})

describe('注入 ③ 磁盘打满', () => {
  test('审计写不进去时，节点照常工作', () => {
    // 因为日志本写满了就把节点停掉，是把一次可恢复的故障升级成一次彻底的。
    const dir = workspace()
    const trail = new AuditTrail(join(dir, 'audit', 'trail.ndjson'))
    trail.close()
    rmSync(dir, { recursive: true, force: true })

    const router = new NodeRouter({
      node: 'node-b',
      now: () => NOW,
      auditSink: event => {
        // 生产里这一层是 `safeAppend`；这里直接用会抛的写法，断言路由层不受影响。
        try {
          trail.append({
            at: event.at,
            source: AuditSource.Router,
            kind: event.type,
            outcome: 'refused',
          })
        } catch {
          // 见上：吞掉，让节点继续跑。
        }
      },
    })
    expect(router.inbound(request('disk-1')).ok).toBe(true)
    const looped = router.inbound(request('disk-1'))
    expect(looped.ok).toBe(false)
  })

  test('快照存不下时是明确的失败，不是半个快照', () => {
    const dir = workspace()
    const store = new FileSnapshotStore({
      root: join(dir, 'backups'),
      maxBytes: 8,
    })
    expect(
      store.writer().create({
        workspace: '/w',
        reason: 'scheduled',
        archive: new Uint8Array(64),
      }),
    ).rejects.toThrow(/ceiling/)
  })

  test('写到一半被截断的审计行是「torn tail」，不是篡改', () => {
    const dir = workspace()
    const path = join(dir, 'trail.ndjson')
    const trail = new AuditTrail(path)
    trail.append({
      at: NOW,
      source: AuditSource.Transport,
      kind: 'message_accepted',
      outcome: 'ok',
    })
    trail.close()
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"seq":2,"at":1,"sou`)

    const result = readTrail(path)
    expect(result.issues).toEqual([{ line: 2, kind: 'torn_tail' }])
    // 前面那条仍然读得出来——磁盘满不该让整本日志作废。
    expect(result.records).toHaveLength(1)
  })
})

describe('注入 ④ 时钟漂移', () => {
  test('一次跳跃之后，所有截止时间不会同时越阈', () => {
    // E4：冻结期间单调钟照常前进，所以解冻瞬间「距上次见到 X 多久」会集体越阈。
    const gate = new TimeJumpGate({ periodMs: 1_000 })
    gate.observe(NOW)
    const deadline = NOW + 5_000

    // 正常推进：到点就是到点。
    expect(gate.expired(deadline, NOW + 5_001)).toBe(true)

    // 一次远超周期的跳跃：闸门开宽限窗口，同一个截止时间不再被判死。
    const jumped = new TimeJumpGate({ periodMs: 1_000 })
    jumped.observe(NOW)
    const observation = jumped.observe(NOW + 120_000)
    expect(observation.jumped).toBe(true)
    expect(jumped.expired(deadline, NOW + 120_000)).toBe(false)
    expect(jumped.rebase(deadline, observation)).toBe(deadline + 120_000)
  })

  test('宽限窗口结束之后，判据恢复正常生效', () => {
    const gate = new TimeJumpGate({ periodMs: 1_000, graceMs: 5_000 })
    gate.observe(NOW)
    const observation = gate.observe(NOW + 120_000)
    expect(observation.jumped).toBe(true)
    expect(gate.inGrace(NOW + 120_000 + 4_999)).toBe(true)
    expect(gate.inGrace(NOW + 120_000 + 5_001)).toBe(false)
    expect(gate.expired(NOW + 1_000, NOW + 120_000 + 5_001)).toBe(true)
  })

  test('时钟往回拨不会让消息复活', () => {
    // 反向漂移比正向更阴险：它会让一条已经过期的消息看起来还有效。
    const envelope = createMessage({
      from: PLANNER,
      to: REVIEWER,
      type: MessageType.TaskRequest,
      payload: {},
      createdAt: NOW,
      deliverTtlMs: 1_000,
    })
    const router = new NodeRouter({
      node: 'node-b',
      now: () => NOW - 60_000,
      deadlineNow: () => NOW - 60_000,
    })
    // 路由层不判投递时限（那是校验层与适配器的三处判定），但它也绝不能因为
    // 时钟回拨就把同一条消息重新当成新的——判环键仍然记得它。
    expect(router.inbound(envelope).ok).toBe(true)
    expect(router.inbound(envelope).ok).toBe(false)
    expect(deliveryExpiresAt(envelope)).toBe(NOW + 1_000)
  })
})
