// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CLI 与鉴权策略之间的那一道缝。
 *
 * 策略本身（「环回可以自动生成、非环回必须显式给、两个 token 都要够长且不同」）
 * 是 `packages/console/src/auth.ts` 的，也在那个包自己的用例里测过。这里测的是
 * **另一件事**：把 `parseConsoleArgs` 真正解析出来的配置喂给那条策略，会不会
 * 得到我们想要的结果——零参数起的控制台确实落在「自动生成」那一支，
 * `--hostname 0.0.0.0` 确实起不来，而 CLI 自己那个 generator 确实过得了包这一侧
 * 的长度下限。这三件事没有一件是包内单测能看见的。
 *
 * 这个文件单独放，是因为它必须在运行期 import `@qianmo/console`；参数面与端口
 * 的用例在 `consoleArgs.test.ts`，那边刻意不碰这个包，所以那些用例的成败与控制台
 * 包当下能不能加载无关。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIN_TOKEN_LENGTH,
  isLoopbackHostname,
  resolveTokens,
} from '@qianmo/console'
import { newConsoleToken, runConsole } from '../console.js'
import { CONSOLE_HELP_TEXT, parseConsoleArgs } from '../consoleArgs.js'
import {
  ADMIN_TOKEN_ENV_VAR,
  VIEW_TOKEN_ENV_VAR,
  resolveConsoleTokenSource,
} from '../consoleTokenSources.js'

function tokensFor(
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): ReturnType<typeof resolveTokens> {
  const config = parseConsoleArgs(args, 'qianmo')
  // 与 `runConsole` 同一条链路：三个入口先收敛成一枚，再交给包里那条策略。
  const view = resolveConsoleTokenSource('view', config, env)
  const admin = resolveConsoleTokenSource('admin', config, env)
  return resolveTokens({
    ...(view === undefined ? {} : { view: view.value }),
    ...(admin === undefined ? {} : { admin: admin.value }),
    hostname: config.hostname,
    generate: newConsoleToken,
  })
}

const FILE_VIEW_TOKEN = 'f'.repeat(48)
const FILE_ADMIN_TOKEN = 'e'.repeat(48)

let directory: string
let viewTokenPath: string
let adminTokenPath: string

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-console-tokens-'))
  viewTokenPath = join(directory, 'view.token')
  adminTokenPath = join(directory, 'admin.token')
  // 真机上这两个文件是 `printf '%s\n'` 出来的，尾部有换行；权限 0600。
  writeFileSync(viewTokenPath, `${FILE_VIEW_TOKEN}\n`)
  writeFileSync(adminTokenPath, `${FILE_ADMIN_TOKEN}\n`)
  chmodSync(viewTokenPath, 0o600)
  chmodSync(adminTokenPath, 0o600)
})
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('occ console token wiring', () => {
  test('the zero-argument console lands on the generating branch', () => {
    // 默认 hostname 必须是回环，否则 `occ console` 不带参数就起不来了。
    expect(isLoopbackHostname(parseConsoleArgs([], 'qianmo').hostname)).toBe(
      true,
    )
    const tokens = tokensFor([])
    expect(tokens.view).not.toBe(tokens.admin)
    expect(tokens.view.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
    expect(tokens.admin.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
  })

  test('the CLI generator clears the package floor with room to spare', () => {
    const first = newConsoleToken()
    const second = newConsoleToken()
    expect(first.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH)
    // 相同的两个 token 会被 `resolveTokens` 判成启动失败，这里先钉住不会相同。
    expect(first).not.toBe(second)
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('a non-loopback bind refuses to start without both tokens', () => {
    // `--hostname 0.0.0.0` 正是控制台被挂上公网的那条路：起不来比悄悄起来好。
    expect(() => tokensFor(['--hostname=0.0.0.0'])).toThrow('非环回')
    expect(() =>
      tokensFor(['--hostname=0.0.0.0', '--view-token=view-token-long-enough']),
    ).toThrow('admin')
    expect(() =>
      tokensFor([
        '--hostname=0.0.0.0',
        '--admin-token=admin-token-long-enough',
      ]),
    ).toThrow('view')
  })

  test('a non-loopback bind starts when both tokens are supplied', () => {
    expect(
      tokensFor([
        '--hostname=0.0.0.0',
        '--view-token=view-token-long-enough',
        '--admin-token=admin-token-long-enough',
      ]),
    ).toEqual({
      view: 'view-token-long-enough',
      admin: 'admin-token-long-enough',
    })
  })

  test('a non-loopback bind is satisfied by a file or an environment variable', () => {
    // 这是这次改动的**要点**：`resolveTokens` 的「非环回必须显式提供」一条没有
    // 改，但「显式」现在有三种给法，而两种不进 `ps -eo args`。
    expect(
      tokensFor([
        '--hostname=0.0.0.0',
        `--view-token-file=${viewTokenPath}`,
        `--admin-token-file=${adminTokenPath}`,
      ]),
    ).toEqual({ view: FILE_VIEW_TOKEN, admin: FILE_ADMIN_TOKEN })

    expect(
      tokensFor(['--hostname=0.0.0.0'], {
        [VIEW_TOKEN_ENV_VAR]: FILE_VIEW_TOKEN,
        [ADMIN_TOKEN_ENV_VAR]: FILE_ADMIN_TOKEN,
      }),
    ).toEqual({ view: FILE_VIEW_TOKEN, admin: FILE_ADMIN_TOKEN })

    // 混着给也行——一枚从文件、一枚从环境。
    expect(
      tokensFor(['--hostname=0.0.0.0', `--view-token-file=${viewTokenPath}`], {
        [ADMIN_TOKEN_ENV_VAR]: FILE_ADMIN_TOKEN,
      }),
    ).toEqual({ view: FILE_VIEW_TOKEN, admin: FILE_ADMIN_TOKEN })
  })

  test('a token that only the command line supplies still works', () => {
    // 既有脚本与 `console.md` §3 的选项表不能被这次改动打断。
    expect(
      tokensFor(
        [
          '--hostname=0.0.0.0',
          '--view-token=view-token-long-enough',
          '--admin-token=admin-token-long-enough',
        ],
        // 环境里有别的东西时也不该影响：这里两个变量都没设。
        {},
      ),
    ).toEqual({
      view: 'view-token-long-enough',
      admin: 'admin-token-long-enough',
    })
  })

  test('a short or reused explicit token is a startup failure', () => {
    expect(() =>
      tokensFor([
        '--hostname=0.0.0.0',
        '--view-token=short',
        '--admin-token=admin-token-long-enough',
      ]),
    ).toThrow(String(MIN_TOKEN_LENGTH))
    expect(() =>
      tokensFor([
        '--hostname=0.0.0.0',
        '--view-token=same-token-long-enough',
        '--admin-token=same-token-long-enough',
      ]),
    ).toThrow('必须不同')
  })
})

describe('occ console --help through the real handler', () => {
  /**
   * 把 stdout 借走一小会儿。
   *
   * 不是 `mock.module`——那是进程全局 last-write-wins 的，而这里换的是一个对象
   * 属性，`finally` 里换回来，出了这个函数就什么都没留下。
   */
  async function captureStdout(run: () => Promise<void>): Promise<string> {
    const original = process.stdout.write
    let captured = ''
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured +=
        typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      return true
    }) as unknown as typeof process.stdout.write
    try {
      await run()
    } finally {
      process.stdout.write = original
    }
    return captured
  }

  test('prints the option table instead of throwing, and binds no port', async () => {
    // 改动前这一路会走到解析器最后那个 `else`，抛 `unknown console option
    // --help`，内测用户看到的是一段带源码行号的 Bun 栈回溯——而那是他手上唯一的
    // 自助文档入口。
    const output = await captureStdout(() => runConsole(['--help']))
    expect(output).toBe(CONSOLE_HELP_TEXT)
    expect(await captureStdout(() => runConsole(['-h']))).toBe(
      CONSOLE_HELP_TEXT,
    )
    // 帮助排在身份校验之前：问「怎么用」的人恰恰是还没配好 OCC_IDENTITY 的那个。
    expect(output).not.toContain('console requires OCC_IDENTITY')
  })

  test('answers --help even when the rest of the line would not parse', async () => {
    // `occ console --registy=x --help` 是拼错选项名之后最自然的下一步。
    expect(
      await captureStdout(() => runConsole(['--registy=x', '--help'])),
    ).toBe(CONSOLE_HELP_TEXT)
  })
})
