// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The socket the sandbox talks to, and the allowlist behind it.
 *
 * Same three-layer discipline P2.5 gave the sandbox supervisor, for the same
 * reason — AC-6(c) is a claim about what an agent *cannot* do, and a claim like
 * that is only as good as the narrowest layer:
 *
 * 1. **Type layer** — the sandbox side holds a {@link SnapshotWriter}, which
 *    declares `create` and nothing else. Removing a snapshot is not a call you
 *    can write.
 * 2. **Runtime layer** — every request is matched against
 *    {@link BACKUP_SURFACE}. A method or path that is not on it is refused
 *    before anything is read, and the refusal is audited. This is the layer
 *    that catches a caller who has stopped using our client and is speaking
 *    HTTP by hand — which is exactly what an agent with a shell would do.
 * 3. **Shape layer** — {@link assertBackupSurfaceIsSafe} runs on this module's
 *    own allowlist at import time, so a future edit that adds `DELETE
 *    /snapshot/:id` cannot even be loaded.
 *
 * ## Two credentials, and why they are not one with a flag
 *
 * The write token creates snapshots; the archive token reads them. They are
 * separate strings compared separately, because the property being defended is
 * "the side that can be compromised cannot read the backups of the side that
 * cannot". A single token with a scope field would put that property one
 * boolean away from being wrong.
 *
 * Requests are compared with a length-independent equality check for the same
 * reason the transport handshake does: a timing side channel on a bearer token
 * is a cheap thing to avoid and an expensive thing to discover.
 */

import { timingSafeEqual } from 'node:crypto'
import { BackupEventType, type SnapshotWriter } from './contracts.js'
import type { BackupAuditLog, FileSnapshotStore } from './store.js'
import { isSnapshotId } from './store.js'

/** The three things this service can do. There is no fourth. */
export enum BackupOp {
  CreateSnapshot = 'createSnapshot',
  ListSnapshots = 'listSnapshots',
  ReadSnapshot = 'readSnapshot',
}

/** Which credential a route belongs to. */
export type BackupAudience = 'writer' | 'archive'

export interface BackupRoute {
  readonly method: 'POST' | 'GET'
  /** Path, with `:id` standing for a snapshot id. */
  readonly path: string
  readonly audience: BackupAudience
  readonly rationale: string
}

/** Words that mark an operation as one this service must never offer. */
export const DESTRUCTIVE_WORDS: readonly string[] = Object.freeze([
  'delete',
  'remove',
  'destroy',
  'purge',
  'prune',
  'expire',
  'rotate',
  'overwrite',
  'replace',
  'truncate',
  'wipe',
])

/** HTTP methods a route may use: the two that cannot remove anything. */
export const ALLOWED_METHODS: readonly string[] = Object.freeze(['GET', 'POST'])

/** The allowlist. Adding an entry is a security change. */
export const BACKUP_SURFACE: ReadonlyMap<BackupOp, BackupRoute> = new Map<
  BackupOp,
  BackupRoute
>([
  [
    BackupOp.CreateSnapshot,
    {
      method: 'POST',
      path: '/snapshot',
      audience: 'writer',
      rationale:
        'creates one new immutable object; cannot name an existing one, so it cannot replace one',
    },
  ],
  [
    BackupOp.ListSnapshots,
    {
      method: 'GET',
      path: '/snapshots',
      audience: 'archive',
      rationale: 'read-only; the restoring side needs to find the newest',
    },
  ],
  [
    BackupOp.ReadSnapshot,
    {
      method: 'GET',
      path: '/snapshot/:id',
      audience: 'archive',
      rationale: 'read-only; the bytes a restore puts back',
    },
  ],
])

/**
 * Refuse to load a surface that could remove or overwrite a snapshot.
 *
 * Takes the surface as a parameter so its red direction is testable — a check
 * that can only ever be handed the good value is a check nobody has watched
 * fail.
 */
export function assertBackupSurfaceIsSafe(
  surface: ReadonlyMap<string, BackupRoute>,
): void {
  let writerRoutes = 0
  for (const [op, route] of surface) {
    const haystack = `${op} ${route.path}`.toLowerCase()
    for (const word of DESTRUCTIVE_WORDS) {
      if (haystack.includes(word)) {
        throw new Error(
          `backup surface is unsafe: "${op}" (${route.path}) contains destructive word "${word}"`,
        )
      }
    }
    if (!ALLOWED_METHODS.includes(route.method)) {
      throw new Error(
        `backup surface is unsafe: "${op}" uses method "${route.method}"; allowed: ${ALLOWED_METHODS.join(', ')}`,
      )
    }
    if (route.audience === 'writer') {
      writerRoutes += 1
      if (route.method !== 'POST' || route.path !== '/snapshot') {
        throw new Error(
          `backup surface is unsafe: the writer audience may only reach POST /snapshot, not ${route.method} ${route.path}`,
        )
      }
    }
  }
  if (writerRoutes !== 1) {
    throw new Error(
      `backup surface is unsafe: the writer audience must have exactly one route, found ${writerRoutes}`,
    )
  }
}

assertBackupSurfaceIsSafe(BACKUP_SURFACE)

/** Constant-time bearer comparison. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

function bearerOf(request: Request): string {
  const header = request.headers.get('authorization') ?? ''
  return header.startsWith('Bearer ') ? header.slice('Bearer '.length) : ''
}

export interface BackupServiceOptions {
  readonly store: FileSnapshotStore
  /** Handed to the sandbox. Creates snapshots; reads nothing. */
  readonly writeToken: string
  /** Kept on the host. Reads snapshots; creates nothing. */
  readonly archiveToken: string
  readonly port?: number
  readonly hostname?: string
  readonly unix?: string
  readonly now?: () => number
}

export interface BackupServiceHandle {
  readonly url?: string
  readonly port?: number
  readonly unix?: string
  readonly audit: BackupAuditLog
  stop(): Promise<void>
}

const MIN_TOKEN_LENGTH = 16

/**
 * Serve the backup surface.
 *
 * `Bun.serve`, like the registry's HTTP face — this is a host-local service on
 * a socket or a loopback port, not a public endpoint, and charter N-3 keeps TLS
 * termination out of M0.
 */
export function startBackupService(
  options: BackupServiceOptions,
): BackupServiceHandle {
  if (
    options.writeToken.length < MIN_TOKEN_LENGTH ||
    options.archiveToken.length < MIN_TOKEN_LENGTH
  ) {
    throw new Error(
      `backup tokens must be at least ${MIN_TOKEN_LENGTH} characters`,
    )
  }
  if (options.writeToken === options.archiveToken) {
    // One string for both faces would make the two-credential design a comment.
    throw new Error('the write token and the archive token must differ')
  }
  const store = options.store
  const audit = store.audit
  const now = options.now ?? Date.now

  const deny = (
    type: BackupEventType,
    status: number,
    detail: Readonly<Record<string, string | number | boolean>>,
  ): Response => {
    audit.record(type, now(), detail)
    return new Response(JSON.stringify({ error: type }), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    const path = url.pathname

    // Anything that is not one of the two safe verbs is a mutation attempt as
    // far as this service is concerned, and is recorded as one. AC-6(c) wants
    // the attempt on the record, not merely the failure.
    if (!ALLOWED_METHODS.includes(method)) {
      return deny(BackupEventType.MutationDenied, 405, { method, path })
    }

    const token = bearerOf(request)
    const isWriter = tokenMatches(token, options.writeToken)
    const isArchive = tokenMatches(token, options.archiveToken)
    if (!isWriter && !isArchive) {
      return deny(BackupEventType.AccessDenied, 401, { method, path })
    }

    if (method === 'POST' && path === '/snapshot') {
      if (!isWriter) {
        return deny(BackupEventType.AccessDenied, 403, { method, path })
      }
      const workspace = url.searchParams.get('workspace') ?? ''
      const reason = url.searchParams.get('reason') ?? 'manual'
      const label = url.searchParams.get('label')
      if (workspace === '') {
        return new Response(
          JSON.stringify({ error: 'workspace is required' }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        )
      }
      if (
        reason !== 'scheduled' &&
        reason !== 'pre-task' &&
        reason !== 'manual'
      ) {
        return new Response(JSON.stringify({ error: 'unknown reason' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      const archive = new Uint8Array(await request.arrayBuffer())
      try {
        const meta = await store.writer().create({
          workspace,
          reason,
          archive,
          ...(label === null ? {} : { label }),
        })
        return new Response(JSON.stringify(meta), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        })
      } catch (error) {
        return new Response(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        )
      }
    }

    if (method === 'GET' && path === '/snapshots') {
      // The write credential is deliberately not enough to read this: an agent
      // that cannot list backups cannot go looking for the one worth attacking.
      if (!isArchive) {
        return deny(BackupEventType.ReadDenied, 403, { method, path })
      }
      const workspace = url.searchParams.get('workspace')
      const metas = await store.list(workspace ?? undefined)
      return new Response(JSON.stringify(metas), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    if (method === 'GET' && path.startsWith('/snapshot/')) {
      if (!isArchive) {
        return deny(BackupEventType.ReadDenied, 403, { method, path })
      }
      const id = path.slice('/snapshot/'.length)
      if (!isSnapshotId(id)) {
        return new Response(JSON.stringify({ error: 'bad snapshot id' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      const bytes = await store.read(id)
      if (bytes === null) {
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })
      }
      // `Uint8Array` is a legal response body at runtime; the DOM lib's
      // `BodyInit` predates typed arrays being one.
      return new Response(bytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'application/gzip' },
      })
    }

    return new Response(JSON.stringify({ error: 'no such route' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }

  const server = Bun.serve({
    ...(options.unix === undefined
      ? {
          port: options.port ?? 0,
          hostname: options.hostname ?? '127.0.0.1',
        }
      : { unix: options.unix }),
    fetch: handle,
  })

  return {
    ...(options.unix === undefined
      ? { url: `http://${server.hostname}:${server.port}`, port: server.port }
      : { unix: options.unix }),
    audit,
    stop: async (): Promise<void> => {
      await server.stop(true)
    },
  }
}

/** The write-only client the sandbox side holds. */
export interface RemoteWriterOptions {
  /** Base URL of the service, or a unix socket path. */
  readonly url?: string
  readonly unix?: string
  readonly token: string
  readonly fetchImpl?: typeof fetch
}

/**
 * A {@link SnapshotWriter} over the socket.
 *
 * Note what is absent and cannot be added by a caller: this object has one
 * method. Its `fetch` is closed over, so there is no field to reach in and
 * point at a different path either.
 */
export function remoteSnapshotWriter(
  options: RemoteWriterOptions,
): SnapshotWriter {
  const base = options.url ?? 'http://localhost'
  const call = options.fetchImpl ?? fetch
  return {
    async create(request) {
      const url = new URL('/snapshot', base)
      url.searchParams.set('workspace', request.workspace)
      url.searchParams.set('reason', request.reason)
      if (request.label !== undefined) {
        url.searchParams.set('label', request.label)
      }
      const response = await call(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/gzip',
        },
        // `Uint8Array` is a legal fetch body at runtime; the DOM typing wants a
        // `BufferSource`, and this is one.
        body: request.archive as unknown as BodyInit,
        ...(options.unix === undefined ? {} : { unix: options.unix }),
      } as RequestInit)
      if (!response.ok) {
        throw new Error(
          `backup service refused the snapshot: ${response.status}`,
        )
      }
      return (await response.json()) as Awaited<
        ReturnType<SnapshotWriter['create']>
      >
    },
  }
}
