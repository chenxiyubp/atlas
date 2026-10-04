// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { resolve } from 'path'

const RUNNER = resolve(__dirname, 'residentModelCredential.runner.ts')

/**
 * Runs the credential probe in its own bun process, for the two reasons the
 * neighbouring `apiKeyStorage` / `mirroredCredentialSinks` pairs give:
 *
 * 1. The assertions are about the real `src/utils/auth/auth.ts`. `mock.module`
 *    is process-global and last-write-wins, so a stub installed by any other
 *    file in the shard would silently become the thing under test.
 * 2. `CLAUDE_CODE_SIMPLE=1` has to be in the environment from process start,
 *    and setting it here would leak bare mode into every later file in the
 *    shard.
 */
describe('resident model-credential probe (isolated)', () => {
  test('runs against the real auth chain, in bare mode', async () => {
    const proc = Bun.spawn(['bun', 'test', '--timeout', '60000', RUNNER], {
      cwd: resolve(__dirname, '..', '..', '..', '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        // Bare mode: ANTHROPIC_API_KEY and the --settings apiKeyHelper are the
        // only sources the auth stack will look at. That is what makes "no
        // credential" mean the same thing on a logged-in laptop and on a CI
        // runner.
        CLAUDE_CODE_SIMPLE: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const code = await proc.exited
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `resident credential subprocess failed (exit ${code}).\n\n` +
          `${stderr}\n${stdout}`.slice(-6000),
      )
    }
    expect(code).toBe(0)
  }, 120_000)
})
