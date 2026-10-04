// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { parseConsoleArgs, transportPskEnvVarForNode } from '../consoleArgs.js'
import { wireConsoleChat } from '../console.js'
import type { ConsoleChatHub } from '../consoleChat.js'
import type { RegistryPort } from '@qianmo/console'

const GLOBAL_PSK = 'global-psk-that-must-not-enable-named-targets'
const NAMED_A_PSK = 'named-a-psk-that-is-long-enough-to-be-usable'
const NAMED_B_PSK = 'named-b-psk-that-is-long-enough-to-be-usable'
const STORE = '/tmp/qianmo-chat-wiring-not-written.ndjson'

function registryPort(): RegistryPort {
  return {
    async list() {
      return { ok: true, value: [] }
    },
  } as unknown as RegistryPort
}

/** A hub that is never driven — these tests only inspect what was wired. */
function chatHub(): ConsoleChatHub {
  return {
    async close() {},
  } as unknown as ConsoleChatHub
}

const IDENTITY_PUBLIC_KEY = 'console-public-key-from-the-stubbed-identity'

function wire(
  args: readonly string[],
  keys: Readonly<Record<string, string>>,
  options: { readonly globalPsk?: string } = {},
) {
  const queried: Array<string | undefined> = []
  const created: Array<{
    readonly url: string
    readonly psk: string
    readonly node?: string
  }> = []
  const identityFor: string[] = []
  let signed: unknown
  const wiring = wireConsoleChat(
    parseConsoleArgs([...args, `--chat-store=${STORE}`], 'qianmo'),
    registryPort(),
    {
      pskFromEnv(variable) {
        queried.push(variable)
        if (variable === undefined) {
          const global = options.globalPsk
          if (global === undefined) throw new Error('psk missing')
          return global
        }
        const value = keys[variable]
        if (value === undefined) throw new Error('psk missing')
        return value
      },
      createChatPort(portOptions) {
        for (const endpoint of portOptions.endpoints) created.push(endpoint)
        signed = portOptions.issueCapability
        return chatHub()
      },
      loadIdentity(chatFrom) {
        identityFor.push(chatFrom)
        return {
          node: 'console',
          publicKey: IDENTITY_PUBLIC_KEY,
          issue: () => 'a-token',
        }
      },
    },
  )
  return { wiring, queried, created, identityFor, signed }
}

describe('console chat wiring', () => {
  test('named targets read their own PSK variable, never the global one', () => {
    const variable = transportPskEnvVarForNode('beta-4')
    const { wiring, queried, created } = wire(
      ['--chat-url=beta-4=ws://127.0.0.1:38625'],
      { [variable]: NAMED_A_PSK },
      { globalPsk: GLOBAL_PSK },
    )

    expect(queried).toEqual([variable])
    expect(created).toEqual([
      { url: 'ws://127.0.0.1:38625/', psk: NAMED_A_PSK, node: 'beta-4' },
    ])
    expect(wiring.hub).toBeDefined()
    expect(wiring.status).toBe(
      'enabled as qianmo://console/operator -> beta-4 -> ws://127.0.0.1:38625/',
    )
  })

  test('one node without a key does not take the others down with it', () => {
    // 这正是 p11 上会发生的事：四个节点各一把，某一台还没分发到。
    const variableA = transportPskEnvVarForNode('beta-1')
    const variableB = transportPskEnvVarForNode('beta-2')
    const { wiring, created } = wire(
      [
        '--chat-url=beta-1=ws://127.0.0.1:38631',
        '--chat-url=beta-2=ws://127.0.0.1:38632',
      ],
      { [variableB]: NAMED_B_PSK },
    )

    expect(created).toEqual([
      { url: 'ws://127.0.0.1:38632/', psk: NAMED_B_PSK, node: 'beta-2' },
    ])
    expect(wiring.hub).toBeDefined()
    // 逐节点写清楚，而不是一句「有的没起来」。
    expect(wiring.status).toContain('beta-1 disabled (PSK unavailable)')
    expect(wiring.status).toContain('beta-2 -> ws://127.0.0.1:38632/')
    // 秘密边界：钥匙本身与它的读取失败原因都不进 banner。
    expect(wiring.status).not.toContain(variableA)
  })

  test('every node missing a key is the same as having no chat face', () => {
    const { wiring, created } = wire(
      ['--chat-url=beta-1=ws://127.0.0.1:38631'],
      {},
      { globalPsk: GLOBAL_PSK },
    )

    expect(created).toEqual([])
    expect(wiring.hub).toBeUndefined()
    expect(wiring.status).toBe('disabled (beta-1 disabled (PSK unavailable))')
  })

  test('a legacy bare URL still reads the shared PSK and binds no node', () => {
    const { wiring, queried, created } = wire(
      ['--chat-url=ws://127.0.0.1:38611'],
      {},
      { globalPsk: GLOBAL_PSK },
    )

    expect(queried).toEqual([undefined])
    expect(created).toEqual([{ url: 'ws://127.0.0.1:38611/', psk: GLOBAL_PSK }])
    expect(wiring.hub).toBeDefined()
  })

  test('没有 --chat-sign 就不读身份，也不给端口装签发器', () => {
    const variable = transportPskEnvVarForNode('beta-4')
    const { wiring, identityFor, signed } = wire(
      ['--chat-url=beta-4=ws://127.0.0.1:38625'],
      { [variable]: NAMED_A_PSK },
    )

    // 一个从不签名的控制台不该在配置根里留下一把没人用的私钥——首次读身份就是
    // 首次创建它，所以「没开开关就不读」是一条会落盘的差别，不是风格。
    expect(identityFor).toEqual([])
    expect(signed).toBeUndefined()
    expect(wiring.status).not.toContain('signed')
  })

  test('--chat-sign 装上签发器，并把这件事写进 banner', () => {
    const variable = transportPskEnvVarForNode('beta-4')
    const { wiring, identityFor, signed } = wire(
      ['--chat-url=beta-4=ws://127.0.0.1:38625', '--chat-sign'],
      { [variable]: NAMED_A_PSK },
    )

    // 身份名跟着 `--chat-from` 走：控制台在对面的审计链里只该有一个身份。
    expect(identityFor).toEqual(['qianmo://console/operator'])
    expect(typeof signed).toBe('function')
    expect(wiring.status).toBe(
      'enabled as qianmo://console/operator (signed) -> beta-4 -> ws://127.0.0.1:38625/',
    )
    // 公开材料也不进 banner：这一行是给运维看「开没开」，不是给它抄公钥的地方，
    // 抄公钥有 --print-wake-identity。
    expect(wiring.status).not.toContain(IDENTITY_PUBLIC_KEY)
  })

  test('一条端点都拨不通时，即使给了 --chat-sign 也不读身份', () => {
    // 读身份就是首次创建它。最终没有对话面的控制台不该留下一把没人用的私钥，
    // 所以这一步排在「有没有可用端点」之后，而不是排在参数解析之后。
    const { wiring, identityFor } = wire(
      ['--chat-url=beta-1=ws://127.0.0.1:38631', '--chat-sign'],
      {},
    )

    expect(wiring.hub).toBeUndefined()
    expect(identityFor).toEqual([])
  })

  test('no --chat-url is the one disabled reason that predates PSK lookup', () => {
    const { wiring, queried } = wire([], {}, { globalPsk: GLOBAL_PSK })

    expect(queried).toEqual([])
    expect(wiring.status).toBe('disabled (no --chat-url)')
  })
})
