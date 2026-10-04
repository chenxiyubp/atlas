// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One of two `qm memory add` writers racing each other in `memory.test.ts`.
 *
 *   bun memoryAdd.runner.ts <go-file> <name> <count>
 *
 * Prints `ready`, waits for the go file so both writers start together, then
 * runs `memory add` `<count>` times into the same partition through the real
 * command handler. The config root comes from the environment, exactly as it
 * does for `qm`.
 */

import { existsSync } from 'node:fs'
import { runQianmoMemory } from '../memory.js'

const [goFile, name, count] = process.argv.slice(2)
if (goFile === undefined || name === undefined || count === undefined) {
  throw new Error('usage: <go-file> <name> <count>')
}

process.stdout.write('ready\n')
while (!existsSync(goFile)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
}
for (let index = 0; index < Number(count); index++) {
  runQianmoMemory([
    'add',
    '--agent',
    'reviewer',
    '--context',
    'alice',
    '--title',
    `${name}-${index}`,
    '--body',
    `written by ${name}`,
  ])
  if (process.exitCode === 1) break
}
