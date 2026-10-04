// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 账号库与会话表的文件面：`@qianmo/console` 的 `LedgerPort` 的生产实现。
 *
 * **这里只搬字节。**解析、验链、「坏一行就整本停用」全在包里
 * （`packages/console/src/ledger.ts`、`accounts.ts`），那样每一条 fail-closed
 * 规矩都能用一个普通对象测到；这一层只守三件文件纪律，和 `@qianmo/audit` 的
 * 审计链同一套（`packages/audit/src/trail.ts`）：
 *
 * - 目录 0700、文件 0600，打开时都再 chmod 一次——文件可能是别人先建的；
 * - 写用 `O_APPEND | O_NOFOLLOW`，每行一次 `fsync`：账里最要紧的恰恰是出事前
 *   写下的那一行（一条吊销）；
 * - 读也带 `O_NOFOLLOW`：配置根里一个指向别处的符号链接，不该让控制台把别的
 *   文件当成账号库读进来。
 *
 * **路径不在这里拼**：它从 `consoleArgs.ts` 来，派生自 `occConfigPath()`
 * （CLAUDE.md §1.1②），`OCC_CONFIG_DIR` 因此对它同样有效。
 */

import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { LedgerPort } from '@qianmo/console'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600

export class FileLedger implements LedgerPort {
  readonly path: string
  #fd: number | null = null

  constructor(path: string) {
    if (path.trim() === '') throw new Error('ledger path must not be empty')
    this.path = path
  }

  read(): string | null {
    let fd: number
    try {
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    try {
      return readFileSync(fd, 'utf8')
    } finally {
      closeSync(fd)
    }
  }

  append(line: string): void {
    if (this.#fd === null) {
      const directory = dirname(this.path)
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
      chmodSync(directory, DIRECTORY_MODE)
      this.#fd = openSync(
        this.path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      chmodSync(this.path, FILE_MODE)
    }
    writeSync(this.#fd, line)
    fsyncSync(this.#fd)
  }

  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd)
      this.#fd = null
    }
  }
}
