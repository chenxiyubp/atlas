// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 驱动调用计数器的回归护栏。
 *
 * 守两件事：**它真的在数**（issue #61 那次假绿就是没人在数），以及
 * **它一个字节都不改变驱动的行为** —— 一个会吞异常或改返回值的计数器会把
 * 「套件自己炸了」伪装成别的东西，那比不数更糟。
 */

import { describe, expect, test } from 'bun:test'
import { instrumentDriver } from '../driverProbe.js'
import { stripMinifiedSourceFrame } from '../checks.js'
import type {
  AcceptanceDriver,
  DriverCapability,
  ExecResult,
  NodeHandle,
} from '../types.js'

/** 一个够用的假驱动：带 `#private` 字段，因为那正是 Proxy 最容易写坏的地方。 */
class FakeDriver {
  readonly target = 'local' as const
  readonly capabilities: ReadonlySet<DriverCapability> = new Set([
    'raw-dial',
  ] as const)
  readonly #secret = 'only-reachable-through-a-correct-receiver'

  async execNode(
    _node: NodeHandle,
    argv: readonly string[],
  ): Promise<ExecResult> {
    return { code: 0, stdout: `${this.#secret}:${argv.join(' ')}`, stderr: '' }
  }

  async stopNode(): Promise<void> {
    throw new Error('故意抛')
  }
}

function fake(): AcceptanceDriver {
  return new FakeDriver() as unknown as AcceptanceDriver
}

describe('instrumentDriver', () => {
  test('按调用顺序记下方法名，含重复', async () => {
    const probe = instrumentDriver(fake())
    expect(probe.calls()).toEqual([])
    const node = {} as NodeHandle
    await probe.driver.execNode(node, ['audit', '--verify'])
    await probe.driver.execNode(node, ['--version'])
    expect(probe.calls()).toEqual(['execNode', 'execNode'])
  })

  // `#private` 字段的查找落在 receiver 上：`Reflect.get` 的第三个参数传成代理
  // 而不是 target，这里会当场 TypeError。两个真驱动都用私有字段存配置。
  test('返回值原样透传，私有字段照常可达', async () => {
    const probe = instrumentDriver(fake())
    const result = await probe.driver.execNode({} as NodeHandle, ['x'])
    expect(result.stdout).toBe('only-reachable-through-a-correct-receiver:x')
    expect(result.code).toBe(0)
  })

  test('异常照抛，不被计数器吞掉', async () => {
    const probe = instrumentDriver(fake())
    await expect(probe.driver.stopNode({} as NodeHandle)).rejects.toThrow(
      '故意抛',
    )
    expect(probe.calls()).toEqual(['stopNode'])
  })

  test('读属性不算一次调用', () => {
    const probe = instrumentDriver(fake())
    expect(probe.driver.target).toBe('local')
    expect(probe.driver.capabilities.has('raw-dial')).toBe(true)
    expect(probe.calls()).toEqual([])
  })
})

describe('stripMinifiedSourceFrame', () => {
  test('删掉长的源码帧行（真机上实测每行 1028 字符）', () => {
    const noise = `1 | ${'x'.repeat(1_024)}`
    const output = `${noise}\nerror: resident takes either --open-policy`
    const cleaned = stripMinifiedSourceFrame(output)
    expect(cleaned).not.toContain('xxxx')
    expect(cleaned).toContain('error: resident takes either --open-policy')
  })

  // 失败方向必须是「留了噪声」，不能是「吃掉了证据」。
  test('普通输出一字不动，长行但不是源码帧的也留着', () => {
    const plain = 'error: 一切正常\n  at somewhere\n'
    expect(stripMinifiedSourceFrame(plain)).toBe(plain)
    const longButNotAFrame = `error: ${'y'.repeat(1_000)}`
    expect(stripMinifiedSourceFrame(longButNotAFrame)).toBe(longButNotAFrame)
    // 本地腿跑的是源码入口，源码帧是真源码、远在 400 门槛之下 —— 一行不删。
    const shortFrame = '12 | const a = 1'
    expect(stripMinifiedSourceFrame(shortFrame)).toBe(shortFrame)
  })
})
