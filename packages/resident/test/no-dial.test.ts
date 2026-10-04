// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rule H-2, as something that fails a build rather than something a reviewer
 * remembers: **a resident node never opens a connection to a peer.**
 *
 * Every answer it owes — a `task.result`, a redelivery, a `notify` — leaves on
 * the reverse direction of a channel the *peer* established. That is the
 * property the whole watch-job shape stands on: the design's alternative
 * ("give the resident a `--registry` and let it dial the hub") was rejected
 * precisely because it turns a node that is only ever reachable into a node
 * that is also a client, and the sandbox freeze semantics R-3 relies on stop
 * being expressible the moment that happens.
 *
 * ## Why a scan and not a unit test
 *
 * The unit tests next door prove the notifier does not dial. They cannot prove
 * that *nothing else* starts to: the next batch to add an outbound path would
 * add it somewhere these tests never look, and every one of them would stay
 * green. So this file reads the resident's source instead, and the allowlist
 * below is the complete, deliberate list of places a connection is opened.
 *
 * The one entry on it is not a peer link. `ResidentActivityReporter` dials the
 * process **supervising this sandbox** to report busy/idle — inside the
 * sandbox boundary, to the host that started it, carrying no task and no
 * peer's traffic. H-2 is about the network; that link is about staying awake.
 * Anything else appearing here needs the same paragraph written for it, in the
 * PR, before this list is edited.
 */

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const PACKAGE_ROOT = resolve(import.meta.dir, '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')

/**
 * Ways this repository opens an outbound link.
 *
 * Written against construction and against the raw socket, because those are
 * the two ways to get one: `TransportClient` is the only dialer
 * `@qianmo/transport` exports, and a hand-rolled `WebSocket` would be how
 * someone bypassed it.
 */
const DIAL_SHAPES: readonly RegExp[] = [
  /new\s+TransportClient\s*\(/,
  /new\s+WebSocket\s*\(/,
]

/**
 * Files allowed to match, each for a reason written in this file's header.
 * Paths are relative to the repository root.
 */
const ALLOWED: readonly string[] = ['packages/resident/src/activity.ts']

/** Every source file that is part of a running resident node. */
async function residentSources(): Promise<readonly string[]> {
  const files: string[] = []
  const glob = new Bun.Glob('src/**/*.ts')
  for await (const file of glob.scan({ cwd: PACKAGE_ROOT, absolute: true })) {
    files.push(file)
  }
  // The host half: the wiring that owns the transport server, the ledgers and
  // the notifier. A scan that stopped at the package boundary would miss the
  // one file most likely to grow a dialer.
  files.push(resolve(REPO_ROOT, 'src/services/qianmo/resident.ts'))
  files.push(resolve(REPO_ROOT, 'src/cli/handlers/resident.ts'))
  return files
}

describe('H-2 — the node never dials', () => {
  test('the scan recognizes a dial when it sees one', () => {
    // Positive control. A rule that cannot see the shape it forbids would pass
    // forever and protect nothing — the same discipline the session-key scan
    // next door follows.
    const bait = [
      'const client = new TransportClient({ endpoint, node, psk })',
      "const socket = new WebSocket('wss://hub.example/inbound')",
    ]
    for (const [index, sample] of bait.entries()) {
      expect(DIAL_SHAPES[index]?.test(sample)).toBe(true)
    }
    // And a negative control: listening is not dialing, and the rule must not
    // confuse the two or the resident's own server would trip it.
    const listening = 'const transport = startTransportServer({ psk, port })'
    expect(DIAL_SHAPES.some(shape => shape.test(listening))).toBe(false)
  })

  test('nothing in the resident opens an outbound link except the host keepalive', async () => {
    const files = await residentSources()
    expect(files.length).toBeGreaterThan(20)

    const offenders: string[] = []
    for (const file of files) {
      const relative = file.slice(REPO_ROOT.length + 1)
      const source = await Bun.file(file).text()
      if (!DIAL_SHAPES.some(shape => shape.test(source))) continue
      if (ALLOWED.includes(relative)) continue
      offenders.push(relative)
    }

    expect(offenders).toEqual([])
  })

  test('the allowlist is exact — an entry that stopped dialing must come off', async () => {
    // A stale allowlist is how a rule quietly stops covering anything: the
    // entry that once needed an exemption keeps its permission long after the
    // code that earned it is gone, and the next dialer lands in a file that is
    // already waved through.
    for (const relative of ALLOWED) {
      const source = await Bun.file(resolve(REPO_ROOT, relative)).text()
      expect(DIAL_SHAPES.some(shape => shape.test(source))).toBe(true)
    }
  })

  test('the notify path cannot dial, because it cannot reach a transport', async () => {
    // Structural rather than textual: `notify.ts` takes its channel as an
    // argument and has no import that could produce one. A future edit that
    // wanted to dial would have to add the import first, and this is what
    // stops that edit being a one-liner nobody notices in review.
    const source = await Bun.file(resolve(PACKAGE_ROOT, 'src/notify.ts')).text()
    expect(source).not.toContain('@qianmo/transport')
    expect(source).toContain('channel: NotifyChannel')
  })
})
