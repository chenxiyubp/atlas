#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The N×N identity-resolution matrix — the machine-readable gauge
 * `key-distribution.md` §9.1 names as **S-2**: "每个节点都能为每个其他节点解析
 * 出公钥，连续 14 天". §9.1 is explicit that S-2 is a two-step measurement:
 * "每节点导出自己的 `PublicKeyDirectory` 快照，脚本做矩阵比对" — each node
 * exports *its own* view, and a script compares the N exports against each
 * other. This file is that script; it does not itself run on N machines.
 *
 * ## Two modes
 *
 * **`--snapshot <node>=<path.json>` (repeatable, ≥2), `--ground-truth <path>`**
 * The real S-2 shape: each `<path.json>` is one node's exported
 * `CertificateDirectory.snapshot()` (`{ "<peer>": "<publicKey>", ... }`,
 * written however the operator likes — a cron job piping `qm`'s own export
 * hook is the expected source once one exists). `--ground-truth` is a
 * `{ "<node>": "<publicKey>" }` map of what each node's key actually is —
 * from the CA's own certificates, not from any one node's opinion, so a
 * bug that makes every node agree on the *same wrong* key still gets caught.
 * Cell `[i][j]` is `true` iff node `i`'s snapshot names node `j`'s key and it
 * matches ground truth.
 *
 * **No `--snapshot` at all (self-test, the default)**: nothing in this
 * repository runs on N machines yet, so this mode proves the comparison
 * engine and `CertificateDirectory` itself work by *simulating* N nodes in
 * one process: a real offline CA (`ca/operations.ts`, P12.1), a real
 * `@qianmo/registry` HTTP server, N real issued certificates, and N
 * independent `CertificateDirectory` instances — one per simulated node,
 * each given a slightly different clock so a clock-skew class of bug would
 * show up as a real matrix gap rather than being hidden by every instance
 * sharing one `Date.now()`. This is the mode `bun run qianmo:nxn-matrix`
 * runs, and the mode the DoD's "机器可判读" report comes from today.
 *
 * ## Usage
 *
 *   bun run qianmo:nxn-matrix                        # self-test, N=5
 *   bun run qianmo:nxn-matrix --nodes 8               # self-test, N=8
 *   bun run qianmo:nxn-matrix --out /tmp/matrix.json  # also write the report
 *
 *   bun run qianmo:nxn-matrix \
 *     --snapshot node-a=/exports/node-a.json \
 *     --snapshot node-b=/exports/node-b.json \
 *     --ground-truth /exports/ground-truth.json
 *
 * Exit code 0 iff every cell resolves; 1 otherwise — the shape a cron job
 * checks without parsing the JSON.
 */

import {
  generateNodeKeyPair,
  signBytes,
  type NodeKeyPair,
} from '@qianmo/capability'
import {
  InMemoryRegistry,
  startRegistryServer,
  type RegistryServerHandle,
} from '@qianmo/registry'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initCa,
  issueCertificate,
  refreshRevocationList,
} from '../src/services/qianmo/ca/operations.js'
import {
  opensslVersion,
  runOpenssl,
} from '../src/services/qianmo/ca/openssl.js'
import { popMessage } from '../src/services/qianmo/ca/pop.js'
import { CertificateDirectory } from '../src/services/qianmo/certificateDirectory.js'

const DEFAULT_SELF_TEST_NODE_COUNT = 5

const HELP_TEXT = `Usage:
  bun run qianmo:nxn-matrix                        # self-test, N=${String(DEFAULT_SELF_TEST_NODE_COUNT)}
  bun run qianmo:nxn-matrix --nodes 8               # self-test, N=8
  bun run qianmo:nxn-matrix --out /tmp/matrix.json  # also write the report

  bun run qianmo:nxn-matrix \\
    --snapshot node-a=/exports/node-a.json \\
    --snapshot node-b=/exports/node-b.json \\
    --ground-truth /exports/ground-truth.json

See the module header for what each mode does. Exit code 0 iff every pair
in the matrix resolved; 1 otherwise.
`

interface MatrixReport {
  readonly generatedAt: string
  readonly mode: 'self-test' | 'snapshots'
  readonly nodes: readonly string[]
  /** `matrix[i][j]`: whether node `i` resolved node `j`'s key correctly. */
  readonly matrix: Record<string, Record<string, boolean>>
  readonly allResolved: boolean
  readonly missing: readonly { readonly from: string; readonly to: string }[]
}

function parseArgs(argv: readonly string[]): {
  readonly snapshots: readonly [string, string][]
  readonly groundTruthPath: string | undefined
  readonly nodeCount: number
  readonly outPath: string | undefined
} {
  const snapshots: [string, string][] = []
  let groundTruthPath: string | undefined
  let nodeCount = DEFAULT_SELF_TEST_NODE_COUNT
  let outPath: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--snapshot') {
      const value = argv[++i]
      const split = value?.indexOf('=') ?? -1
      if (value === undefined || split <= 0) {
        throw new Error('--snapshot takes <node>=<path.json>')
      }
      snapshots.push([value.slice(0, split), value.slice(split + 1)])
    } else if (arg === '--ground-truth') {
      groundTruthPath = argv[++i]
      if (groundTruthPath === undefined)
        throw new Error('--ground-truth needs a path')
    } else if (arg === '--nodes') {
      const value = Number(argv[++i])
      if (!Number.isInteger(value) || value < 2) {
        throw new Error('--nodes must be an integer >= 2')
      }
      nodeCount = value
    } else if (arg === '--out') {
      outPath = argv[++i]
      if (outPath === undefined) throw new Error('--out needs a path')
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP_TEXT)
      process.exit(0)
    } else {
      throw new Error(`unknown option ${String(arg)}`)
    }
  }
  return { snapshots, groundTruthPath, nodeCount, outPath }
}

function readJsonMap(path: string): Record<string, string> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON object`)
  }
  const record = parsed as Record<string, unknown>
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(record)) {
    if (typeof value !== 'string') {
      throw new Error(`${path}: value for ${key} is not a string`)
    }
    out[key] = value
  }
  return out
}

/** Mode: compare pre-exported per-node snapshots against ground truth. */
function runFromSnapshots(
  snapshotPaths: readonly [string, string][],
  groundTruthPath: string,
): MatrixReport {
  const nodes = snapshotPaths.map(([node]) => node)
  const snapshots = new Map(
    snapshotPaths.map(([node, path]) => [node, readJsonMap(path)] as const),
  )
  const groundTruth = readJsonMap(groundTruthPath)
  return buildReport(
    'snapshots',
    nodes,
    (from, to) => snapshots.get(from)?.[to],
    groundTruth,
  )
}

/** Mode: simulate N nodes end to end and derive the matrix from real refreshes. */
async function runSelfTest(nodeCount: number): Promise<MatrixReport> {
  const openssl = opensslVersion()
  if (openssl === null) {
    throw new Error(
      'no usable openssl on PATH — the self-test mode issues real ' +
        'certificates and cannot run without it (point $QIANMO_OPENSSL_BIN ' +
        'at one, or supply --snapshot/--ground-truth instead)',
    )
  }

  const root = mkdtempSync(join(tmpdir(), 'qianmo-nxn-matrix-'))
  let server: RegistryServerHandle | undefined
  try {
    const caDir = join(root, 'ca')
    initCa({ directory: caDir })
    const caCertificatePem = readFileSync(join(caDir, 'ca.crt'), 'utf8')

    const registry = new InMemoryRegistry()
    server = startRegistryServer(0, { registry })

    const nodeNames = Array.from(
      { length: nodeCount },
      (_, i) => `node-${String.fromCharCode(97 + i)}`,
    )
    const groundTruth: Record<string, string> = {}
    for (const node of nodeNames) {
      const keys = issueAndRegister(caDir, node, registry, root)
      groundTruth[node] = keys.publicKey
    }

    // A fresh, empty-revocations RL, published the way `qm ca refresh-rl`
    // would. Without this every `CertificateDirectory` below fails closed to
    // its own single `--trust` entry (§6.4) and the matrix would report every
    // cross-node cell as unresolved — a true fact about an RL-less network,
    // but not the thing this gauge exists to measure.
    const rl = refreshRevocationList({
      directory: caDir,
      validMs: 30 * 24 * 60 * 60 * 1000,
    })
    const signedRl: unknown = JSON.parse(readFileSync(rl.path, 'utf8'))
    const published = await fetch(`${server.url}/v0/revocation-list`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signedRl),
    })
    if (published.status !== 200) {
      throw new Error(
        `self-test setup: publishing the RL failed ${published.status}`,
      )
    }

    // One CertificateDirectory per simulated node, each with its own clock —
    // a shared `Date.now()` across all N would hide a whole class of
    // "one node's clock is wrong" bug that a real N-machine network can have
    // and a single shared instance structurally cannot exhibit.
    const directories = new Map<string, CertificateDirectory>()
    for (const [index, node] of nodeNames.entries()) {
      const skewMs = index * 17 // deliberately different per simulated node
      const directory = new CertificateDirectory({
        caCertificatePem,
        registryUrl: server.url,
        trusted: [[node, groundTruth[node] as string]],
        now: () => Date.now() + skewMs,
      })
      await directory.refresh()
      directories.set(node, directory)
    }

    return buildReport(
      'self-test',
      nodeNames,
      (from, to) => directories.get(from)?.publicKeyOf(to) ?? undefined,
      groundTruth,
    )
  } finally {
    await server?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

function issueAndRegister(
  caDir: string,
  node: string,
  registry: InMemoryRegistry,
  root: string,
): NodeKeyPair {
  const keys = generateNodeKeyPair()
  const tlsKeyPath = join(root, `${node}.tls.key`)
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
    `/CN=${node}`,
  ])
  const issued = issueCertificate({
    directory: caDir,
    node,
    publicKey: keys.publicKey,
    csrPem,
    popSignature: signBytes(keys, popMessage(node, csrPem)),
    hosts: [`${node}.example.com`],
  })
  const result = registry.register(
    `qianmo://${node}/agent`,
    `wss://${node}.example.com/agent`,
    {
      publicKey: keys.publicKey,
      certificate: issued.certificatePem,
    },
  )
  if (!result.ok) {
    throw new Error(
      `self-test setup: registering ${node} failed: ${result.message}`,
    )
  }
  return keys
}

function buildReport(
  mode: MatrixReport['mode'],
  nodes: readonly string[],
  resolve: (from: string, to: string) => string | undefined,
  groundTruth: Readonly<Record<string, string>>,
): MatrixReport {
  const matrix: Record<string, Record<string, boolean>> = {}
  const missing: { from: string; to: string }[] = []
  for (const from of nodes) {
    matrix[from] = {}
    for (const to of nodes) {
      if (from === to) continue
      const expected = groundTruth[to]
      const resolved = resolve(from, to)
      const ok = expected !== undefined && resolved === expected
      matrix[from][to] = ok
      if (!ok) missing.push({ from, to })
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    mode,
    nodes,
    matrix,
    allResolved: missing.length === 0,
    missing,
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const report: MatrixReport =
    args.snapshots.length > 0
      ? (() => {
          if (args.groundTruthPath === undefined) {
            throw new Error('--snapshot requires --ground-truth')
          }
          if (args.snapshots.length < 2) {
            throw new Error(
              '--snapshot needs at least two nodes to form a matrix',
            )
          }
          return runFromSnapshots(args.snapshots, args.groundTruthPath)
        })()
      : await runSelfTest(args.nodeCount)

  const rendered = `${JSON.stringify(report, null, 2)}\n`
  process.stdout.write(rendered)
  if (args.outPath !== undefined) writeFileSync(args.outPath, rendered)

  if (!report.allResolved) {
    process.stderr.write(
      `S-2 gauge: ${String(report.missing.length)} of ${String(
        report.nodes.length * (report.nodes.length - 1),
      )} pairs failed to resolve.\n`,
    )
    process.exitCode = 1
  }
}

await main()
