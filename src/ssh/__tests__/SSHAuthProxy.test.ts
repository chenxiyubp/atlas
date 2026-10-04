// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, mock, test } from 'bun:test'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { debugMock } from '../../../tests/mocks/debug'
import { createAuthProxy } from '../SSHAuthProxy'

mock.module('src/utils/telemetry/debug.ts', debugMock)

test.skipIf(process.platform === 'win32')(
  'credential socket is private from creation and cleaned up on stop',
  async () => {
    const info = await createAuthProxy()
    const directory = dirname(info.localAddress)
    try {
      expect(statSync(info.localAddress).isSocket()).toBe(true)
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      expect(info.authEnv.ANTHROPIC_AUTH_SOCKET).toBe(info.localAddress)
    } finally {
      info.proxy.stop()
    }
    expect(existsSync(info.localAddress)).toBe(false)
    expect(existsSync(directory)).toBe(false)
    info.proxy.stop()
  },
)
