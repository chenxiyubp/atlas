// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A real HTTP server on loopback that stands in for the sandbox daemon.
 *
 * **Read this before reading any assertion in this package.** The sandbox
 * supervisor is an *external system*, not the unit under test. Nothing here
 * reproduces its real behaviour and nothing in these tests is evidence about
 * it. What the stub buys is that everything on *our* side of the port — the
 * capability allowlist, the heartbeat schedule, the retry-sooner-on-failure
 * rule, the wake coalescing, the journal, the recovery pass — runs for real,
 * over a real socket, with real JSON and real HTTP status codes, instead of
 * being asserted against a hand-written double of our own code.
 *
 * ## It does reproduce the *wire shape*, which was verified on the host
 *
 * `POST {endpoint}/{methodName}` with a bearer and a JSON parameter object;
 * method names taken verbatim from the real API; sandboxes addressed by `name`;
 * states drawn from `active` / `frozen` / `stopped`; `listSandboxes` answering
 * `{ sandboxes: [ … ] }` and `acquireSandbox` answering
 * `{ status, created, sandbox }`. That is deliberate: the first version of this
 * package was written against an invented REST shape, and a stub that agrees
 * with the invention is exactly the thing that lets an invention survive.
 *
 * It is deliberately *more* permissive than the thing it stands in for. In
 * particular it **implements `destroySandbox`**, at the same endpoint and
 * behind the same bearer as everything else — which is where the real one lives
 * too — records hits on it, and will happily serve one to any client that asks.
 * That is the control for DoD ③: a test can prove the route is live and
 * reachable, and then prove that our component cannot reach it. A stub without
 * a destroy route would make the "cannot destroy" assertion vacuous.
 */

import type { SandboxState } from '../src/daemon.js'

/** Requests the stub has served, by real method name. */
export interface StubHits {
  acquireSandbox: number
  listSandboxes: number
  /** Must stay at zero for every request that went through our component. */
  destroySandbox: number
  /** Requests rejected for a bad or missing bearer. */
  unauthorized: number
  /** Anything the stub does not route. */
  unknown: number
}

export interface StubDaemonOptions {
  /** Bearer the stub demands. Fake, fixed, and obviously not a real secret. */
  readonly token?: string
  /**
   * Sandboxes that already exist when the stub starts.
   *
   * Explicit rather than lazily conjured, because the real API distinguishes
   * "this name has a row" from "this name has none" and so does our client:
   * `listSandboxes` cannot invent a row for a name nobody created, and
   * `HttpSandboxDaemon.status` turns a missing row into a
   * `SandboxNotFoundError`. Leaving this empty is how a test reaches that path.
   */
  readonly sandboxes?: readonly string[]
  /** Lifecycle state the seeded sandboxes start in. */
  readonly initialState?: SandboxState
  /**
   * How many probes after an `acquireSandbox` still report not-ready.
   *
   * Models the shape E2 measured — unpause returns long before the working set
   * is warm — without claiming any particular duration.
   */
  readonly readyAfterProbes?: number
}

/** A running stub, plus the levers a test needs. */
export interface StubDaemon {
  readonly url: string
  readonly port: number
  readonly hits: StubHits
  /** Fail the next `n` acquires with 503, then recover. */
  failAcquires(n: number): void
  /** Current lifecycle state of a sandbox, or `undefined` if it has no row. */
  stateOf(sandboxName: string): SandboxState | undefined
  setState(sandboxName: string, state: SandboxState): void
  /** True once the sandbox is active and its probe budget is spent. */
  isReady(sandboxName: string): boolean
  stop(): Promise<void>
}

/** Obviously fake, fixed, and long enough to look like a bearer. */
export const STUB_TOKEN = 'stub-daemon-token-not-a-real-secret'

/**
 * Start the stub on an OS-assigned loopback port.
 *
 * Port 0 so parallel work never collides, and `127.0.0.1` rather than a
 * wildcard bind so the stub is unreachable from anywhere but this machine —
 * the same invariant P0.7 puts on the real daemon.
 */
export function startStubDaemon(options: StubDaemonOptions = {}): StubDaemon {
  const token = options.token ?? STUB_TOKEN
  const initialState: SandboxState = options.initialState ?? 'frozen'
  const readyAfterProbes = options.readyAfterProbes ?? 0

  const hits: StubHits = {
    acquireSandbox: 0,
    listSandboxes: 0,
    destroySandbox: 0,
    unauthorized: 0,
    unknown: 0,
  }
  const states = new Map<string, SandboxState>()
  for (const name of options.sandboxes ?? []) states.set(name, initialState)
  const probesLeft = new Map<string, number>()
  let acquireFailures = 0

  const stateOf = (name: string): SandboxState | undefined => states.get(name)

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  /** One `listSandboxes` row, shaped like the ones observed on the host. */
  const row = (name: string, state: SandboxState) => ({
    id: `sbx-${name}`,
    name,
    state,
    nodeId: 'stub-node',
    endpoint: 'http://127.0.0.1:0',
    policy: {
      freezeAfterSeconds: 60,
      stopAfterSeconds: 600,
      archiveAfterSeconds: 86_400,
    },
    template: 'stub',
    metadata: {},
    createdAt: '2026-08-12T00:00:00.000Z',
    lastActiveAt: '2026-08-12T00:00:00.000Z',
  })

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request: Request): Promise<Response> {
      if (request.headers.get('authorization') !== `Bearer ${token}`) {
        hits.unauthorized += 1
        return json({ error: 'unauthorized' }, 401)
      }
      const { pathname } = new URL(request.url)
      // The whole API is `POST /{methodName}`: one segment, no prefix.
      const method = pathname.replace(/^\/+/, '')
      let params: Record<string, unknown> = {}
      try {
        params = (await request.json()) as Record<string, unknown>
      } catch {
        params = {}
      }
      const name = typeof params.name === 'string' ? params.name : ''

      if (method === 'acquireSandbox' && request.method === 'POST') {
        hits.acquireSandbox += 1
        if (acquireFailures > 0) {
          acquireFailures -= 1
          return json({ error: 'daemon busy' }, 503)
        }
        // The real one is idempotent and creates on an unknown name; `created`
        // is how it says which of the two happened.
        const created = !states.has(name)
        states.set(name, 'active')
        probesLeft.set(name, readyAfterProbes)
        return json({
          status: 'ready',
          created,
          sandbox: row(name, 'active'),
        })
      }

      if (method === 'listSandboxes' && request.method === 'POST') {
        hits.listSandboxes += 1
        return json({
          sandboxes: [...states].map(([id, state]) => row(id, state)),
        })
      }

      // The destructive route. Live, functional, served over the same bearer
      // and the same endpoint as the two above, and never reached through
      // @qianmo/activator — that is the point of it being here.
      if (method === 'destroySandbox' && request.method === 'POST') {
        hits.destroySandbox += 1
        states.set(name, 'stopped')
        return json({ destroyed: true, sandbox: row(name, 'stopped') })
      }

      hits.unknown += 1
      return json(
        { error: `unknown method: ${request.method} ${pathname}` },
        404,
      )
    },
  })

  return {
    // Bun types `port` as optional because unix-socket servers have none; this
    // one always binds TCP.
    port: server.port as number,
    url: `http://127.0.0.1:${server.port}`,
    hits,
    failAcquires(n: number): void {
      acquireFailures = n
    },
    stateOf,
    setState(name: string, state: SandboxState): void {
      states.set(name, state)
    },
    isReady(name: string): boolean {
      if (stateOf(name) !== 'active') return false
      const left = probesLeft.get(name) ?? 0
      if (left > 0) {
        probesLeft.set(name, left - 1)
        return false
      }
      return true
    },
    stop: async (): Promise<void> => {
      await server.stop(true)
    },
  }
}
