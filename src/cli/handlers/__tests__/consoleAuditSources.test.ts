// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The console's audit sources, driven from argv the way `runConsole` builds
 * them: `parseConsoleArgs` → `consoleAuditSources` → `AuditPort.read`.
 *
 * Two findings are pinned here, each with the control that shows the attack
 * or the false alarm is real:
 *
 * - **K-11 F-3.** Witness anchors used to be verified with the `publicKey` on
 *   the node's registry row. Whoever can write that row swaps in their own
 *   key and adds a self-signed anchor over a rewritten trail; the genuine
 *   anchor then fails its signature check and is dropped, and the page reads
 *   完整. Keys now come only from `--trust` or from a certificate the CA root
 *   verifies.
 * - **Mirror lag.** A mirror is pulled every few minutes, the witness is
 *   anchored every minute, so the witness routinely holds anchors past the
 *   end of the copy. Comparing those read as a truncation — 锚点不符 — on a
 *   healthy node. A mirror source now compares only what it holds.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import type { AuditPage, ConsoleResult } from '@qianmo/console'
import {
  InMemoryRegistry,
  startRegistryServer,
  type RegistryServerHandle,
} from '@qianmo/registry'
import {
  AuditWitnessScheduler,
  FileWitnessAnchorStore,
  verifyAuditWitness,
  type WitnessAnchorWriter,
} from '@qianmo/witness'
import {
  initCa,
  issueCertificate,
  refreshRevocationList,
} from '../../../services/qianmo/ca/operations.js'
import {
  opensslVersion,
  runOpenssl,
} from '../../../services/qianmo/ca/openssl.js'
import { popMessage } from '../../../services/qianmo/ca/pop.js'
import { parseConsoleArgs } from '../consoleArgs.js'
import { consoleAuditSources } from '../consoleAuditSources.js'

const NODE = 'beta-2'
const ADDRESS = `qianmo://${NODE}/planner`

let directory: string
let trailPath: string
let anchorRoot: string
let store: FileWitnessAnchorStore
let server: RegistryServerHandle
let node: NodeKeyPair
let attacker: NodeKeyPair

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-console-audit-sources-'))
  trailPath = join(directory, 'node', 'trail.ndjson')
  anchorRoot = join(directory, 'witness')
  store = new FileWitnessAnchorStore({ root: anchorRoot })
  server = startRegistryServer(0, { registry: new InMemoryRegistry() })
  node = generateNodeKeyPair()
  attacker = generateNodeKeyPair()
})

afterEach(async () => {
  await server.stop()
  rmSync(directory, { recursive: true, force: true })
})

function append(path: string, count: number, from = 1): void {
  const trail = new AuditTrail(path)
  for (let index = 0; index < count; index++) {
    const n = from + index
    trail.append({
      at: 1_000 + n,
      source: AuditSource.Resident,
      kind: `event-${String(n)}`,
      outcome: n === 2 ? 'refused' : 'ok',
      node: NODE,
    })
  }
  trail.close()
}

/** The witness host's side of one period: the node signs, the host stores. */
const localWriter: WitnessAnchorWriter = {
  async append(anchor) {
    await store.create({ anchor, receivedAt: Date.now() })
  },
}

async function anchor(path: string, keys: NodeKeyPair): Promise<void> {
  await new AuditWitnessScheduler({
    node: NODE,
    trailPath: path,
    keys,
    writer: localWriter,
  }).tick()
}

/** Rewrite the trail without its refused record, then extend it by two. */
function rewriteDroppingTheRefusal(path: string): void {
  const kept = readTrail(path).records.filter(r => r.outcome !== 'refused')
  rmSync(path)
  const trail = new AuditTrail(path)
  for (const record of kept) {
    const { seq: _seq, prev: _prev, ...input } = record
    trail.append(input)
  }
  trail.close()
  append(path, 2, 100)
}

async function publishRow(fields: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${server.url}/v0/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      address: ADDRESS,
      endpoint: 'ws://127.0.0.1:38632',
      ...fields,
    }),
  })
  if (response.status >= 300) {
    throw new Error(`setup: registry answered ${String(response.status)}`)
  }
}

async function readThrough(
  argv: readonly string[],
  caCertificatePem?: string,
): Promise<ConsoleResult<AuditPage>> {
  const config = parseConsoleArgs(
    ['--registry', server.url, '--anchors', anchorRoot, ...argv],
    'qianmo',
  )
  const [source] = consoleAuditSources(config, caCertificatePem)
  if (source === undefined) throw new Error('setup: no audit source')
  return await source.audit.read({})
}

/**
 * The F-3 attack, carried out in full against a real registry: the genuine
 * anchor at seq 4 is on the witness, the trail is rewritten without its
 * refused record, the attacker signs an anchor over the rewritten head, and
 * the registry row for the node now carries the attacker's key.
 */
async function stageTheAttack(): Promise<void> {
  append(trailPath, 4)
  await anchor(trailPath, node)
  rewriteDroppingTheRefusal(trailPath)
  await anchor(trailPath, attacker)
  await publishRow({ publicKey: attacker.publicKey })
}

describe('K-11 F-3: a key swapped in the registry cannot vouch for a rewritten trail', () => {
  test('control: verified with the registry row key, the rewrite reads as intact and witnessed', async () => {
    await stageTheAttack()
    const listed = (await (await fetch(`${server.url}/v0/agents`)).json()) as {
      agents: { publicKey?: string }[]
    }
    const registryKey = listed.agents[0]?.publicKey
    expect(registryKey).toBe(attacker.publicKey)
    expect(readTrail(trailPath).intact).toBe(true)
    // What the console concluded before the fix: nothing to see.
    expect(
      verifyAuditWitness({
        trailPath,
        anchors: await store.list(NODE),
        publicKey: registryKey as string,
      }),
    ).toMatchObject({ tampered: false, stale: false })
  })

  test('with --trust the genuine anchor is checked and the page reads 锚点不符', async () => {
    await stageTheAttack()
    const page = await readThrough([
      '--audit',
      `${NODE}=${trailPath}`,
      '--trust',
      `${NODE}=${node.publicKey}`,
    ])
    expect(page).toMatchObject({
      ok: true,
      value: { intact: true, witness: { tampered: true, stale: false } },
    })
  })

  test('a node with no established key is a failure, never a verdict from the registry', async () => {
    await stageTheAttack()
    const other = generateNodeKeyPair()
    const page = await readThrough([
      '--audit',
      `${NODE}=${trailPath}`,
      '--trust',
      `beta-9=${other.publicKey}`,
    ])
    expect(page).toMatchObject({
      ok: false,
      failure: { code: 'not_found' },
    })
    if (page.ok) throw new Error('expected a failure')
    expect(page.failure.message).toContain('没有节点 beta-2 的可信公钥')
  })

  test('--anchors with neither --trust nor --trust-ca refuses to start', () => {
    expect(() =>
      parseConsoleArgs(
        ['--anchors', anchorRoot, '--audit', `${NODE}=${trailPath}`],
        'qianmo',
      ),
    ).toThrow('--anchors needs --trust <node>=<publicKey> or --trust-ca')
  })
})

const OPENSSL = opensslVersion()
const withOpenssl = OPENSSL === null ? test.skip : test

describe('K-11 F-3 with --trust-ca: only a CA-verified certificate supplies the key', () => {
  function issue(
    caDir: string,
    keys: NodeKeyPair,
  ): { readonly certificatePem: string } {
    const tlsKeyPath = join(directory, `${String(Math.random())}.tls.key`)
    writeFileSync(
      tlsKeyPath,
      runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
      { mode: 0o600 },
    )
    const csrPem = runOpenssl([
      'req',
      '-new',
      '-key',
      tlsKeyPath,
      '-subj',
      `/CN=${NODE}`,
    ])
    return issueCertificate({
      directory: caDir,
      node: NODE,
      publicKey: keys.publicKey,
      csrPem,
      popSignature: signBytes(keys, popMessage(NODE, csrPem)),
      hosts: ['127.0.0.1'],
    })
  }

  async function publishFreshRl(caDir: string): Promise<void> {
    const result = refreshRevocationList({
      directory: caDir,
      revoke: [],
      now: Date.now() - 60_000,
      validMs: 30 * 24 * 60 * 60 * 1000,
    })
    const response = await fetch(`${server.url}/v0/revocation-list`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: readFileSync(result.path, 'utf8'),
    })
    if (response.status !== 200) throw new Error('setup: RL not published')
  }

  withOpenssl(
    'a certificate from another CA binding the attacker key is not trusted',
    async () => {
      const realCa = join(directory, 'ca-real')
      const rogueCa = join(directory, 'ca-rogue')
      initCa({ directory: realCa })
      initCa({ directory: rogueCa })
      append(trailPath, 4)
      await anchor(trailPath, node)
      rewriteDroppingTheRefusal(trailPath)
      await anchor(trailPath, attacker)
      await publishRow({
        publicKey: attacker.publicKey,
        certificate: issue(rogueCa, attacker).certificatePem,
      })
      await publishFreshRl(realCa)

      const page = await readThrough(
        [
          '--audit',
          `${NODE}=${trailPath}`,
          '--trust-ca',
          join(realCa, 'ca.crt'),
        ],
        readFileSync(join(realCa, 'ca.crt'), 'utf8'),
      )
      expect(page).toMatchObject({ ok: false, failure: { code: 'not_found' } })
    },
    60_000,
  )

  withOpenssl(
    'a certificate from the configured CA supplies the genuine key, and the rewrite is caught',
    async () => {
      const realCa = join(directory, 'ca-real')
      initCa({ directory: realCa })
      append(trailPath, 4)
      await anchor(trailPath, node)
      rewriteDroppingTheRefusal(trailPath)
      await publishRow({
        publicKey: node.publicKey,
        certificate: issue(realCa, node).certificatePem,
      })
      await publishFreshRl(realCa)

      const page = await readThrough(
        [
          '--audit',
          `${NODE}=${trailPath}`,
          '--trust-ca',
          join(realCa, 'ca.crt'),
        ],
        readFileSync(join(realCa, 'ca.crt'), 'utf8'),
      )
      expect(page).toMatchObject({
        ok: true,
        value: { witness: { tampered: true } },
      })
    },
    60_000,
  )
})

describe('mirror lag: only the range the mirror holds is compared', () => {
  /** The node's chain has anchors at 5 and 8; the mirror was pulled at 6. */
  async function stageLaggingMirror(): Promise<string> {
    append(trailPath, 5)
    await anchor(trailPath, node)
    append(trailPath, 3, 6)
    await anchor(trailPath, node)
    const mirror = join(directory, 'mirror', 'trail.ndjson')
    mkdirSync(join(directory, 'mirror'), { recursive: true })
    const lines = readFileSync(trailPath, 'utf8').split('\n').filter(Boolean)
    writeFileSync(mirror, `${lines.slice(0, 6).join('\n')}\n`)
    return mirror
  }

  const trust = () => ['--trust', `${NODE}=${node.publicKey}`]

  test('a mirror behind the newest anchor reads 未覆盖, not 锚点不符', async () => {
    const mirror = await stageLaggingMirror()
    const page = await readThrough([
      '--audit',
      `${NODE}=${mirror}`,
      '--audit-mirror',
      `${NODE}=5`,
      ...trust(),
    ])
    expect(page).toMatchObject({
      ok: true,
      value: {
        intact: true,
        witness: { tampered: false, stale: false, uncovered: true },
      },
    })
  })

  test('control: the same copy read as an authoritative trail is a mismatch', async () => {
    const mirror = await stageLaggingMirror()
    const page = await readThrough(['--audit', `${NODE}=${mirror}`, ...trust()])
    expect(page).toMatchObject({
      ok: true,
      value: { witness: { tampered: true } },
    })
  })

  test('a rewrite inside the range the mirror holds is still 锚点不符', async () => {
    const mirror = await stageLaggingMirror()
    rewriteDroppingTheRefusal(mirror)
    const page = await readThrough([
      '--audit',
      `${NODE}=${mirror}`,
      '--audit-mirror',
      `${NODE}=5`,
      ...trust(),
    ])
    expect(page).toMatchObject({
      ok: true,
      value: { witness: { tampered: true } },
    })
  })

  test('a mirror that has caught up reads as the authoritative trail does', async () => {
    await stageLaggingMirror()
    const page = await readThrough([
      '--audit',
      `${NODE}=${trailPath}`,
      '--audit-mirror',
      `${NODE}=5`,
      ...trust(),
    ])
    expect(page).toMatchObject({
      ok: true,
      value: { witness: { tampered: false, stale: false } },
    })
    if (!page.ok) throw new Error('unreachable')
    expect(page.value.witness?.uncovered).toBeUndefined()
  })
})
