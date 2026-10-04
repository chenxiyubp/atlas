// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { QianmoMessage } from '@qianmo/protocol'
import { ReceiptStatus, startTransportServer } from '@qianmo/transport'
import {
  RESIDENT_WAKE_HELP_TEXT,
  executeResidentWake,
  isResidentWakeHelpRequest,
  parseResidentWakeArgs,
  type ResidentWakeConfig,
} from '../residentWake.js'

const PSK = 'resident-wake-test-not-a-real-secret'

const BASE = [
  '--url=ws://host.internal:7330',
  '--from=qianmo://node-a/operator',
  '--to=qianmo://node-b/reviewer',
  '--prompt=check scheduled work',
] as const

describe('resident wake CLI configuration', () => {
  test('parses an immediate manual wake with explicit network identities', () => {
    expect(parseResidentWakeArgs(BASE, 'qianmo')).toEqual({
      url: 'ws://host.internal:7330/',
      from: 'qianmo://node-a/operator',
      to: 'qianmo://node-b/reviewer',
      prompt: 'check scheduled work',
      afterMs: 0,
      timeoutMs: 90_000,
      deliverTtlMs: 90_000,
    })
  })

  test('parses a delayed wake without changing its delivery budget', () => {
    expect(
      parseResidentWakeArgs(
        [...BASE, '--after-ms=60000', '--deliver-ttl-ms=120000'],
        'qianmo',
      ),
    ).toMatchObject({ afterMs: 60_000, deliverTtlMs: 120_000 })
  })

  test('requires Qianmo identity and valid WebSocket and address inputs', () => {
    expect(() => parseResidentWakeArgs(BASE, 'occ')).toThrow(
      'OCC_IDENTITY=qianmo',
    )
    expect(() =>
      parseResidentWakeArgs(
        BASE.map(arg =>
          arg.startsWith('--url=') ? '--url=http://host.internal' : arg,
        ),
        'qianmo',
      ),
    ).toThrow('must use ws or wss')
    expect(() =>
      parseResidentWakeArgs(
        BASE.map(arg => (arg.startsWith('--to=') ? '--to=reviewer' : arg)),
        'qianmo',
      ),
    ).toThrow('not a qianmo:// address')
  })

  test('bounds timer, timeout and delivery values', () => {
    expect(() =>
      parseResidentWakeArgs([...BASE, '--after-ms=-1'], 'qianmo'),
    ).toThrow('--after-ms')
    expect(() =>
      parseResidentWakeArgs([...BASE, '--timeout-ms=0'], 'qianmo'),
    ).toThrow('--timeout-ms')
    expect(() =>
      parseResidentWakeArgs([...BASE, '--deliver-ttl-ms=0'], 'qianmo'),
    ).toThrow('--deliver-ttl-ms')
  })

  test('delivers manual and timer wakes over authenticated transport', async () => {
    const received: QianmoMessage[] = []
    const server = startTransportServer({
      psk: PSK,
      port: 0,
      hostname: '127.0.0.1',
      onMessage: message => {
        received.push(message)
      },
    })
    const config: ResidentWakeConfig = {
      url: server.url!,
      from: 'qianmo://node-a/operator',
      to: 'qianmo://node-b/reviewer',
      prompt: 'run scheduled check',
      afterMs: 0,
      timeoutMs: 2_000,
      deliverTtlMs: 2_000,
    }

    try {
      const manual = await executeResidentWake(config, PSK)
      const timerStartedAt = Date.now()
      const timer = await executeResidentWake({ ...config, afterMs: 20 }, PSK)

      expect(manual.receipt).toBe(ReceiptStatus.Accepted)
      expect(timer.receipt).toBe(ReceiptStatus.Accepted)
      expect(received).toHaveLength(2)
      expect(received.map(message => message.payload)).toEqual([
        { trigger: 'manual', prompt: 'run scheduled check' },
        { trigger: 'timer', prompt: 'run scheduled check' },
      ])
      expect(received[1]!.createdAt).toBeGreaterThanOrEqual(timerStartedAt + 15)
    } finally {
      await server.stop()
    }
  })
})

describe('resident wake --help', () => {
  test('answers --help and -h wherever they appear on the line', () => {
    // 「敲到一半发现忘了选项名」是人真会做的事，所以位置不限。
    expect(isResidentWakeHelpRequest(['--help'])).toBe(true)
    expect(isResidentWakeHelpRequest(['-h'])).toBe(true)
    expect(isResidentWakeHelpRequest([...BASE, '--help'])).toBe(true)
    expect(isResidentWakeHelpRequest(BASE)).toBe(false)
    expect(isResidentWakeHelpRequest([])).toBe(false)
    // 当成某个选项的值写进去的不算——那是一个值，不是一次请求。
    expect(isResidentWakeHelpRequest(['--prompt=--help'])).toBe(false)
  })

  test('documents every option the parser actually dispatches on', () => {
    // 反漂移：选项名的唯一出处是解析器的分派链，帮助文本是它的投影。新增一个
    // 选项却忘了写进帮助，这条会红——而不是等到内测用户问「还有别的参数吗」。
    const source = readFileSync(
      new URL('../residentWake.ts', import.meta.url),
      'utf8',
    )
    const dispatched = [...source.matchAll(/arg === '(--[a-z-]+)'/g)].map(
      match => match[1] as string,
    )
    // 分派链的形状变了（比如改成表驱动）也要在这里被发现，否则这条测试会安静
    // 地变成一个零断言的空转。7 个解析选项加 `--help` 自己那一次全等比较。
    expect(dispatched.length).toBeGreaterThanOrEqual(8)
    for (const option of new Set(dispatched)) {
      expect(RESIDENT_WAKE_HELP_TEXT).toContain(option)
    }
  })

  test('lists all four required options in one place', () => {
    // 缺项的报错是一条一条来的（先 --url，再 --from…），靠反复撞错误把四个凑
    // 出来是四次往返；帮助必须一次说全。
    const required = RESIDENT_WAKE_HELP_TEXT.slice(
      RESIDENT_WAKE_HELP_TEXT.indexOf('Required'),
      RESIDENT_WAKE_HELP_TEXT.indexOf('Optional:'),
    )
    for (const flag of ['--url', '--from', '--to', '--prompt']) {
      expect(required).toContain(flag)
    }
  })

  test('quotes the defaults and the connect cap instead of copying numbers', () => {
    const { timeoutMs, deliverTtlMs, afterMs } = parseResidentWakeArgs(
      BASE,
      'qianmo',
    )
    expect(RESIDENT_WAKE_HELP_TEXT).toContain(`Default ${timeoutMs}`)
    expect(RESIDENT_WAKE_HELP_TEXT).toContain(`Default ${deliverTtlMs}`)
    expect(RESIDENT_WAKE_HELP_TEXT).toContain(`Default ${afterMs}`)
    // 连接那一步与 --timeout-ms 是两个预算，帮助里不能只说一个。
    expect(RESIDENT_WAKE_HELP_TEXT).toContain('capped')
  })

  test('names the identity and the key it refuses to run without', () => {
    // 问「这个命令怎么用」的人恰恰是还没配好身份与 PSK 的那个人。
    expect(RESIDENT_WAKE_HELP_TEXT).toContain('OCC_IDENTITY')
    expect(RESIDENT_WAKE_HELP_TEXT).toContain('qianmo')
    expect(RESIDENT_WAKE_HELP_TEXT).toContain('QIANMO_TRANSPORT_PSK')
    expect(RESIDENT_WAKE_HELP_TEXT).toContain('process listing')
    expect(RESIDENT_WAKE_HELP_TEXT.endsWith('\n')).toBe(true)
  })

  test('the unknown-option error points at the help', () => {
    // 走到那一支的人多半是拼错了选项名，所以顺手指一下那张表在哪。
    expect(() =>
      parseResidentWakeArgs([...BASE, '--promt=x'], 'qianmo'),
    ).toThrow('unknown resident wake option --promt=x')
    expect(() =>
      parseResidentWakeArgs([...BASE, '--promt=x'], 'qianmo'),
    ).toThrow('resident-wake --help')
  })
})
