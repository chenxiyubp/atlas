import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startMcpConfigWatcher } from '../configWatcher.js'

const stops: Array<() => void> = []
const dirs: string[] = []

afterEach(async () => {
  while (stops.length) stops.pop()!()
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-watch-'))
  dirs.push(dir)
  return dir
}

/**
 * Per-test budget for the three positive cases. They wait on real
 * watchFile events (1 s stat poll + 250 ms debounce ≈ 1.3 s on an idle
 * machine). Bun 1.3.13 ignores `[test] timeout` in bunfig.toml (verified:
 * a 6 s test fails at 5.03 s with it set to 10000; `--timeout` on the CLI
 * is honored), so the intended 10 s never applied — set it explicitly here.
 */
const POSITIVE_CASE_TIMEOUT_MS = 15_000

/**
 * watchFile only reports *changes relative to its first stat*, and on Linux
 * that first stat lands asynchronously after `watchFile()` returns. A
 * mutation that races ahead of it becomes the baseline and is never
 * reported — the file looks "always modified / always deleted / always
 * present". That is exactly what made these cases flake on CI (2026-08-15
 * run 31904161135, 08-16 runs 31939084748 / 31939787564) and fail 8/15 on
 * a Debian 13 x86_64 box, while passing 15/15 there once the mutation
 * waits one poll interval. Wait past one poll before touching the file.
 */
function settleWatcherBaseline(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 1500))
}

/** The negative assertion must observe two stat ticks plus the debounce. */
function settleForNoChange(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 2600))
}

function changeSignal(): {
  readonly fired: () => void
  readonly observed: Promise<void>
} {
  let fired: () => void = () => {}
  const observed = new Promise<void>(resolve => {
    fired = resolve
  })
  return { fired, observed }
}

describe('startMcpConfigWatcher', () => {
  test(
    'fires when a watched file is modified',
    async () => {
      const dir = await makeDir()
      const file = join(dir, '.mcp.json')
      await writeFile(file, '{"mcpServers":{}}')

      const changed = changeSignal()
      stops.push(startMcpConfigWatcher([file], changed.fired))
      await settleWatcherBaseline()

      await writeFile(file, '{"mcpServers":{"a":{"command":"x"}}}')
      await changed.observed
    },
    POSITIVE_CASE_TIMEOUT_MS,
  )

  test(
    'fires when a watched file is deleted — the case that leaked processes',
    async () => {
      const dir = await makeDir()
      const file = join(dir, '.mcp.json')
      await writeFile(file, '{"mcpServers":{"a":{"command":"x"}}}')

      const changed = changeSignal()
      stops.push(startMcpConfigWatcher([file], changed.fired))
      await settleWatcherBaseline()

      await unlink(file)
      await changed.observed
    },
    POSITIVE_CASE_TIMEOUT_MS,
  )

  test(
    'fires when a watched file appears for the first time',
    async () => {
      // Watching a not-yet-existing path is why this uses watchFile rather than
      // a directory watcher: `.mcp.json` usually does not exist at startup.
      const dir = await makeDir()
      const file = join(dir, '.mcp.json')

      const changed = changeSignal()
      stops.push(startMcpConfigWatcher([file], changed.fired))
      await settleWatcherBaseline()

      await writeFile(file, '{"mcpServers":{}}')
      await changed.observed
    },
    POSITIVE_CASE_TIMEOUT_MS,
  )

  test('stop() silences the watcher', async () => {
    const dir = await makeDir()
    const file = join(dir, '.mcp.json')
    await writeFile(file, '{}')

    let fired = 0
    const stop = startMcpConfigWatcher([file], () => void fired++)
    stop()
    stop() // idempotent

    await writeFile(file, '{"mcpServers":{"a":{"command":"x"}}}')
    await settleForNoChange()

    expect(fired).toBe(0)
  })
})
