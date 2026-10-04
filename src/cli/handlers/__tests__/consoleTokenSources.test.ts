// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台两枚 token 的三个入口：文件、环境变量、命令行。
 *
 * **零 `mock.module`**：这一份代码要证明的事全都是文件系统上的真事——尾部换行
 * 有没有被去掉、0644 会不会被拒、拿不到的文件报的是哪一句。假的 `fs` 只能证明
 * 我们照着自己的想象写了一遍。临时目录用完就删，`chmod` 也是真的。
 *
 * 环境变量那一支同理不碰 `process.env`：`resolveConsoleTokenSource` 的第三个参数
 * 就是给这个用的，于是用例之间不会互相污染，也不会把污染留给同进程后面的文件。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseConsoleArgs } from '../consoleArgs.js'
import {
  ADMIN_TOKEN_ENV_VAR,
  VIEW_TOKEN_ENV_VAR,
  readConsoleTokenFile,
  resolveConsoleTokenSource,
  TOKEN_FILE_FORBIDDEN_MODE_BITS,
} from '../consoleTokenSources.js'

/** 真机上那两个文件的形状：48 个 hex 字符加一个换行（`printf '%s\n'`）。 */
const FILE_TOKEN = 'a'.repeat(48)
const OTHER_TOKEN = 'b'.repeat(48)
const THIRD_TOKEN = 'c'.repeat(48)

/** Windows 的 mode 位不是 POSIX 权限，那里的访问控制是 ACL。 */
const posix = process.platform !== 'win32'

let directory: string

function tokenFile(name: string, content: string, mode = 0o600): string {
  const path = join(directory, name)
  writeFileSync(path, content)
  chmodSync(path, mode)
  return path
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-console-token-'))
})
afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('console token file', () => {
  test('strips the trailing newline printf leaves behind', () => {
    const path = tokenFile('trailing.token', `${FILE_TOKEN}\n`)
    expect(readConsoleTokenFile(path, 'view')).toBe(FILE_TOKEN)
    expect(
      readConsoleTokenFile(
        tokenFile('crlf.token', `${FILE_TOKEN}\r\n`),
        'admin',
      ),
    ).toBe(FILE_TOKEN)
  })

  test.skipIf(!posix)('refuses a file group or other can read', () => {
    // 一个对 0644 闭眼的「安全入口」只是把明文从 `ps` 挪到了 `ls -l`。
    for (const mode of [0o644, 0o640, 0o604, 0o666]) {
      const path = tokenFile(`mode-${mode.toString(8)}.token`, FILE_TOKEN, mode)
      expect(() => readConsoleTokenFile(path, 'view')).toThrow(
        'readable beyond its owner',
      )
      // 报错必须把实际的 mode 说出来，否则人只能靠猜去 `ls -l`。
      expect(() => readConsoleTokenFile(path, 'view')).toThrow(
        mode.toString(8).padStart(4, '0'),
      )
    }
  })

  test.skipIf(!posix)(
    'accepts 0600 and 0400, and does not fuss over 0700',
    () => {
      // owner 的执行位不泄露任何东西；拦它只会让人在 umask 古怪的机器上莫名起不来。
      for (const mode of [0o600, 0o400, 0o700]) {
        const path = tokenFile(
          `ok-${mode.toString(8)}.token`,
          `${FILE_TOKEN}\n`,
          mode,
        )
        expect(readConsoleTokenFile(path, 'admin')).toBe(FILE_TOKEN)
      }
      expect(TOKEN_FILE_FORBIDDEN_MODE_BITS).toBe(0o077)
    },
  )

  test('names the flag and the path when the file is not there', () => {
    const missing = join(directory, 'absent.token')
    expect(() => readConsoleTokenFile(missing, 'view')).toThrow(
      '--view-token-file',
    )
    expect(() => readConsoleTokenFile(missing, 'view')).toThrow(missing)
    expect(() => readConsoleTokenFile(missing, 'view')).toThrow(
      'cannot be read',
    )
    // 角色名跟着调用方走，报错里不会说成另一枚。
    expect(() => readConsoleTokenFile(missing, 'admin')).toThrow(
      '--admin-token-file',
    )
  })

  test('rejects a directory and an empty file rather than yielding ""', () => {
    // 空 token 会被 `resolveTokens` 判成「没给」，于是一个写坏的文件在环回上会
    // 静默变成「自动生成一枚」，人却以为自己钉住了凭据。
    expect(() => readConsoleTokenFile(directory, 'view')).toThrow()
    expect(() =>
      readConsoleTokenFile(tokenFile('empty.token', ''), 'view'),
    ).toThrow('is empty')
    expect(() =>
      readConsoleTokenFile(tokenFile('blank.token', '  \n\n'), 'admin'),
    ).toThrow('is empty')
  })
})

describe('console token precedence', () => {
  test('file beats environment beats command line', () => {
    const path = tokenFile('precedence.token', `${FILE_TOKEN}\n`)
    const all = resolveConsoleTokenSource(
      'view',
      { viewToken: THIRD_TOKEN, viewTokenFile: path },
      { [VIEW_TOKEN_ENV_VAR]: OTHER_TOKEN },
    )
    expect(all).toEqual({
      value: FILE_TOKEN,
      origin: 'file',
      detail: `--view-token-file ${path}`,
    })

    // 文件是唯一能被文件系统权限保护的那个，所以它压过另两个；环境变量在
    // Linux 上是只有属主可读的 /proc/<pid>/environ，命令行是全局可读的 cmdline。
    expect(
      resolveConsoleTokenSource(
        'view',
        { viewToken: THIRD_TOKEN },
        { [VIEW_TOKEN_ENV_VAR]: OTHER_TOKEN },
      ),
    ).toEqual({
      value: OTHER_TOKEN,
      origin: 'env',
      detail: `$${VIEW_TOKEN_ENV_VAR}`,
    })

    expect(
      resolveConsoleTokenSource('view', { viewToken: THIRD_TOKEN }, {}),
    ).toEqual({
      value: THIRD_TOKEN,
      origin: 'flag',
      detail: '--view-token (visible in the process list)',
    })
  })

  test('keeps the two roles on their own env vars and their own files', () => {
    const viewPath = tokenFile('role-view.token', `${FILE_TOKEN}\n`)
    const adminPath = tokenFile('role-admin.token', `${OTHER_TOKEN}\n`)
    const config = { viewTokenFile: viewPath, adminTokenFile: adminPath }
    expect(resolveConsoleTokenSource('view', config)?.value).toBe(FILE_TOKEN)
    expect(resolveConsoleTokenSource('admin', config)?.value).toBe(OTHER_TOKEN)

    const env = {
      [VIEW_TOKEN_ENV_VAR]: FILE_TOKEN,
      [ADMIN_TOKEN_ENV_VAR]: OTHER_TOKEN,
    }
    expect(resolveConsoleTokenSource('view', {}, env)?.value).toBe(FILE_TOKEN)
    expect(resolveConsoleTokenSource('admin', {}, env)?.value).toBe(OTHER_TOKEN)
    expect(VIEW_TOKEN_ENV_VAR).not.toBe(ADMIN_TOKEN_ENV_VAR)
  })

  test('says nothing at all when no entrance supplies one', () => {
    // `undefined` 不是「起不来」：环回绑定下 `resolveTokens` 会自己生成一枚，
    // 那正是 `occ console` 不带参数就能起的原因。
    expect(resolveConsoleTokenSource('view', {}, {})).toBeUndefined()
    expect(resolveConsoleTokenSource('admin', {}, {})).toBeUndefined()
  })

  test('treats an unset or empty variable as absent and a blank one as a mistake', () => {
    expect(
      resolveConsoleTokenSource(
        'view',
        { viewToken: THIRD_TOKEN },
        {
          [VIEW_TOKEN_ENV_VAR]: '',
        },
      )?.origin,
    ).toBe('flag')
    // 设了却全是空白是配错，不是「不想用这个入口」——静默落到命令行那一支会让
    // 人以为自己走的是环境变量。
    expect(() =>
      resolveConsoleTokenSource('view', {}, { [VIEW_TOKEN_ENV_VAR]: '   ' }),
    ).toThrow(VIEW_TOKEN_ENV_VAR)
    // 环境变量里的尾部换行同样去掉：`export X="$(cat file)"` 之外还有人用 heredoc。
    expect(
      resolveConsoleTokenSource(
        'admin',
        {},
        {
          [ADMIN_TOKEN_ENV_VAR]: `${OTHER_TOKEN}\n`,
        },
      )?.value,
    ).toBe(OTHER_TOKEN)
  })

  test('never puts the token itself in the line the banner prints', () => {
    const path = tokenFile('banner.token', `${FILE_TOKEN}\n`)
    for (const source of [
      resolveConsoleTokenSource('view', { viewTokenFile: path }, {}),
      resolveConsoleTokenSource(
        'view',
        {},
        { [VIEW_TOKEN_ENV_VAR]: FILE_TOKEN },
      ),
      resolveConsoleTokenSource('view', { viewToken: FILE_TOKEN }, {}),
    ]) {
      expect(source?.detail).not.toContain(FILE_TOKEN)
    }
  })

  test('reads what parseConsoleArgs actually produced, not a hand-built object', () => {
    const path = tokenFile('wired.token', `${FILE_TOKEN}\n`)
    const config = parseConsoleArgs(
      [`--view-token-file=${path}`, '--view-token=ignored-because-weaker'],
      'qianmo',
    )
    expect(resolveConsoleTokenSource('view', config, {})).toEqual({
      value: FILE_TOKEN,
      origin: 'file',
      detail: `--view-token-file ${path}`,
    })
  })
})
