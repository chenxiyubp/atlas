// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import type { WakePort } from '@qianmo/console'
import { parseConsoleArgs, transportPskEnvVarForNode } from '../consoleArgs.js'
import { wireConsoleWake } from '../console.js'

const GLOBAL_PSK = 'global-psk-that-must-not-enable-named-targets'
const NAMED_A_PSK = 'named-a-psk-that-is-long-enough-to-be-usable'
const LEAKABLE_PSK = 'do-not-print-this-pre-shared-key'

function wakePort(): WakePort {
  return {
    async send() {
      return {
        ok: false,
        failure: { code: 'unsupported', message: 'not needed in wiring tests' },
      }
    },
  }
}

describe('console wake wiring', () => {
  test('named targets read only their own PSK variable, never the global PSK', () => {
    const queried: Array<string | undefined> = []
    const created: Array<{ readonly url: string; readonly psk: string }> = []
    const node = 'beta-1'
    const nodeVariable = transportPskEnvVarForNode(node)
    const wiring = wireConsoleWake(
      parseConsoleArgs([`--wake-url=${node}=ws://127.0.0.1:38611`], 'qianmo'),
      {
        pskFromEnv(variable) {
          queried.push(variable)
          return variable === undefined ? GLOBAL_PSK : NAMED_A_PSK
        },
        createWakePort(options) {
          created.push(options)
          return wakePort()
        },
      },
    )

    expect(queried).toEqual([nodeVariable])
    expect(created).toEqual([
      { url: 'ws://127.0.0.1:38611/', psk: NAMED_A_PSK },
    ])
    expect(wiring.targets?.[0]?.wake).toBeDefined()
  })

  test('a missing named PSK stays unavailable even when a global PSK is inherited', () => {
    const queried: Array<string | undefined> = []
    const created: Array<{ readonly url: string; readonly psk: string }> = []
    const nodeA = 'beta-1'
    const nodeB = 'beta-2'
    const variableA = transportPskEnvVarForNode(nodeA)
    const variableB = transportPskEnvVarForNode(nodeB)
    const wiring = wireConsoleWake(
      parseConsoleArgs(
        [
          `--wake-url=${nodeA}=ws://127.0.0.1:38611`,
          `--wake-url=${nodeB}=ws://127.0.0.1:38612`,
        ],
        'qianmo',
      ),
      {
        pskFromEnv(variable) {
          queried.push(variable)
          if (variable === variableA) return NAMED_A_PSK
          if (variable === undefined) return GLOBAL_PSK
          throw new Error(`missing ${variable}: ${LEAKABLE_PSK}`)
        },
        createWakePort(options) {
          created.push(options)
          return wakePort()
        },
      },
    )

    expect(queried).toEqual([variableA, variableB])
    expect(created).toEqual([
      { url: 'ws://127.0.0.1:38611/', psk: NAMED_A_PSK },
    ])
    expect(wiring.targets?.[0]?.wake).toBeDefined()
    expect(wiring.targets?.[1]).toMatchObject({
      node: nodeB,
      unavailableReason: 'PSK unavailable',
    })
    expect(wiring.targets?.[1]?.wake).toBeUndefined()

    // `status` is copied unchanged into the startup banner; errors become the
    // per-target reason the page can surface. Neither may disclose a key.
    for (const output of [
      wiring.status,
      wiring.targets?.[1]?.unavailableReason ?? '',
    ]) {
      expect(output).not.toContain(GLOBAL_PSK)
      expect(output).not.toContain(NAMED_A_PSK)
      expect(output).not.toContain(LEAKABLE_PSK)
    }
  })

  test('a legacy single target reads only the global PSK', () => {
    const queried: Array<string | undefined> = []
    const created: Array<{ readonly url: string; readonly psk: string }> = []
    const wiring = wireConsoleWake(
      parseConsoleArgs(['--wake-url=ws://127.0.0.1:38611'], 'qianmo'),
      {
        pskFromEnv(variable) {
          queried.push(variable)
          return GLOBAL_PSK
        },
        createWakePort(options) {
          created.push(options)
          return wakePort()
        },
      },
    )

    expect(queried).toEqual([undefined])
    expect(created).toEqual([{ url: 'ws://127.0.0.1:38611/', psk: GLOBAL_PSK }])
    expect(wiring.legacy?.url).toBe('ws://127.0.0.1:38611/')
    expect(wiring.targets).toBeUndefined()
  })
})
