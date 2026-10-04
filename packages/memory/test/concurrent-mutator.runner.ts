// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One of two writers racing each other in `concurrency.test.ts`.
 *
 *   bun concurrent-mutator.runner.ts <root> <go-file> <revoke|invalidate> <by> <id>...
 *
 * Prints `ready`, waits for the go file (so both writers start inside the same
 * millisecond instead of one finishing before the other has loaded), applies
 * the operation to every id in order, and prints one JSON line per id saying
 * whether the store reported success. The test then reads the files back and
 * checks that no reported success was lost.
 */

import { existsSync } from 'node:fs'
import { FileMemoryStore } from '../src/index.js'

const [root, goFile, operation, by, ...ids] = process.argv.slice(2)
if (root === undefined || goFile === undefined || by === undefined) {
  throw new Error('usage: <root> <go-file> <revoke|invalidate> <by> <id>...')
}

const store = new FileMemoryStore({ root })
process.stdout.write('ready\n')
while (!existsSync(goFile)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1)
}

const results: { id: string; ok: boolean; error?: string }[] = []
for (const id of ids) {
  try {
    if (operation === 'revoke') {
      store.revoke(id, { reason: `revoked by ${by}`, by })
    } else if (operation === 'invalidate') {
      store.invalidate(id)
    } else {
      throw new Error(`unknown operation ${operation}`)
    }
    results.push({ id, ok: true })
  } catch (error) {
    results.push({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
process.stdout.write(`${JSON.stringify(results)}\n`)
