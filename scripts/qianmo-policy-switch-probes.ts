#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The five gauges `key-distribution.md` §9.1 puts in front of the
 * `SIGNED_TASK_POLICY` default switch — S-1 … S-5, each producing a
 * machine-readable report of its own.
 *
 * ## Three verdicts, and the third one is the point
 *
 * `pass` / `fail` / **`not-collected`**. The third exists because §9.1 asks
 * for things a single run on one developer machine structurally cannot
 * establish — fourteen consecutive days of hourly sampling across a real
 * fleet, a revocation drill performed by a person on deployed nodes — and the
 * one failure mode this whole file exists to avoid is a green report that was
 * never measured. `retro-m0.md` §2.1 counts four occasions in M0 where "判据
 * 写对了但喂给判据的观测是假的"; a probe that quietly downgrades "I could not
 * measure this" into "this passed" is that mistake with a script wrapped
 * around it.
 *
 * So: **nothing is inferred, nothing is simulated into a `pass`.** Where a
 * criterion has a mechanism this process *can* exercise for real (S-2's
 * resolution engine, S-4's revocation path, S-5's page), the mechanism is run
 * and reported under `detail`, and the criterion itself still says
 * `not-collected` when what §9.1 asked for is fleet evidence. The two facts
 * are kept apart on purpose: "the mechanism works" and "the fleet has been
 * observed doing it for fourteen days" are different claims, and only the
 * second one is a reason to switch a default.
 *
 * ## Exit code
 *
 * `0` iff every criterion is `pass`. A `not-collected` is not a pass — the
 * gate §9.1 describes is not met until somebody has collected it. Today, on a
 * machine with no fleet attached, this script exits `1`, and that is the
 * correct answer rather than a defect.
 *
 * ## Usage
 *
 *   bun run qianmo:policy-probes                       # what can be run locally
 *   bun run qianmo:policy-probes --out /tmp/s.json     # also write the report
 *
 *   # S-1, against a live registry:
 *   bun run qianmo:policy-probes \
 *     --registry http://127.0.0.1:38610 \
 *     --trust-ca /etc/qianmo/ca.pem \
 *     --history /var/lib/qianmo/s1-history.ndjson
 *
 *   # the criteria whose evidence a person produces:
 *   bun run qianmo:policy-probes --s3-results /path/s3.json --s4-report /path/s4.json
 */

import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateNodeKeyPair, signBytes } from '@qianmo/capability'
import { renderRoster, type ConsoleCertificate } from '@qianmo/console'
import { parseNodeCertificateBinding } from '@qianmo/protocol'
import { InMemoryRegistry, startRegistryServer } from '@qianmo/registry'
import {
  CLOSE_UNAUTHORIZED,
  TransportClient,
  TransportEventType,
  startTransportServer,
} from '@qianmo/transport'
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
import { verifyRevocationList } from '../src/services/qianmo/ca/revocationList.js'
import { CertificateDirectory } from '../src/services/qianmo/certificateDirectory.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** §9.1's own numbers, quoted rather than re-decided here. */
const REQUIRED_CONTINUITY_DAYS = 14
/** §9.1 S-1: "每小时抽样零缺失" — a gap wider than this breaks continuity. */
const MAX_SAMPLE_GAP_MS = 90 * 60 * 1000

type Verdict = 'pass' | 'fail' | 'not-collected'

interface CriterionReport {
  readonly id: string
  readonly title: string
  readonly verdict: Verdict
  /** Why, in one line. Always present — a verdict with no reason is a rumour. */
  readonly reason: string
  /** What this run could actually measure, whatever the verdict. */
  readonly detail?: Readonly<Record<string, unknown>>
}

interface ProbeReport {
  readonly generatedAt: string
  readonly criteria: readonly CriterionReport[]
  readonly allPass: boolean
  readonly notCollected: readonly string[]
  readonly failed: readonly string[]
}

interface Args {
  readonly registry?: string
  readonly trustCa?: string
  readonly history?: string
  readonly s3Results?: string
  readonly s4Report?: string
  readonly out?: string
  readonly nodes: number
}

const HELP_TEXT = `Usage:
  bun run qianmo:policy-probes [options]

Options:
  --registry <url>       Registry HTTP v0 base URL. Required for S-1.
  --trust-ca <path>      PEM CA root. Required for S-1.
  --history <path>       NDJSON of previous S-1 samples; this run appends one.
                         Without it S-1 can never satisfy §9.1's 14-day
                         continuity, because one run is one sample.
  --s3-results <path>    JSON produced by running the acceptance scripts under
                         SIGNED_TASK_POLICY. See the S-3 section for the shape.
  --s4-report <path>     JSON attesting the revocation drill on real nodes.
  --nodes <n>            Simulated node count for S-2's engine check. Default 5.
  --out <path>           Also write the report here.
  -h, --help             Print this and exit.

Exit code 0 iff every criterion passes; a not-collected criterion is not a
pass. See the module header for why that is deliberate.
`

function parseArgs(argv: readonly string[]): Args {
  let registry: string | undefined
  let trustCa: string | undefined
  let history: string | undefined
  let s3Results: string | undefined
  let s4Report: string | undefined
  let out: string | undefined
  let nodes = 5

  const value = (index: number, flag: string): string => {
    const raw = argv[index]
    if (raw === undefined) throw new Error(`${flag} needs a value`)
    return raw
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--registry') registry = value(++i, arg)
    else if (arg === '--trust-ca') trustCa = value(++i, arg)
    else if (arg === '--history') history = value(++i, arg)
    else if (arg === '--s3-results') s3Results = value(++i, arg)
    else if (arg === '--s4-report') s4Report = value(++i, arg)
    else if (arg === '--out') out = value(++i, arg)
    else if (arg === '--nodes') {
      const parsed = Number(value(++i, arg))
      if (!Number.isInteger(parsed) || parsed < 2) {
        throw new Error('--nodes must be an integer >= 2')
      }
      nodes = parsed
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write(HELP_TEXT)
      process.exit(0)
    } else throw new Error(`unknown option ${String(arg)}`)
  }
  return {
    ...(registry === undefined ? {} : { registry }),
    ...(trustCa === undefined ? {} : { trustCa }),
    ...(history === undefined ? {} : { history }),
    ...(s3Results === undefined ? {} : { s3Results }),
    ...(s4Report === undefined ? {} : { s4Report }),
    ...(out === undefined ? {} : { out }),
    nodes,
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ---------------------------------------------------------------------------
// S-1 — every leased node publishes a CA-verified certificate, 14 days running
// ---------------------------------------------------------------------------

interface S1Sample {
  readonly at: number
  readonly total: number
  readonly verified: number
  readonly problems: readonly { node: string; reason: string }[]
}

/**
 * Continuity out of a sample history.
 *
 * §9.1 asks for fourteen days at hourly sampling with zero misses, which is
 * three separate facts: the window is long enough, no sample inside it had a
 * problem, and there is no hole where sampling stopped. A history that skipped
 * a week and resumed is not fourteen days of evidence, and only the third
 * check notices.
 */
function continuityOf(
  samples: readonly S1Sample[],
  now: number,
): {
  readonly spanDays: number
  readonly samples: number
  readonly cleanSamples: number
  readonly widestGapMs: number
  readonly met: boolean
} {
  if (samples.length === 0) {
    return {
      spanDays: 0,
      samples: 0,
      cleanSamples: 0,
      widestGapMs: 0,
      met: false,
    }
  }
  const ordered = [...samples].sort((a, b) => a.at - b.at)
  const first = ordered[0] as S1Sample
  const last = ordered[ordered.length - 1] as S1Sample
  let widestGapMs = now - last.at
  for (let i = 1; i < ordered.length; i++) {
    const gap = (ordered[i] as S1Sample).at - (ordered[i - 1] as S1Sample).at
    if (gap > widestGapMs) widestGapMs = gap
  }
  const cleanSamples = ordered.filter(
    sample => sample.total > 0 && sample.problems.length === 0,
  ).length
  const spanDays = (now - first.at) / DAY_MS
  return {
    spanDays: Math.round(spanDays * 100) / 100,
    samples: ordered.length,
    cleanSamples,
    widestGapMs,
    met:
      spanDays >= REQUIRED_CONTINUITY_DAYS &&
      cleanSamples === ordered.length &&
      widestGapMs <= MAX_SAMPLE_GAP_MS,
  }
}

async function probeS1(args: Args, now: number): Promise<CriterionReport> {
  const title =
    '注册表内 100% 在租节点发布了通过 CA 校验的证书，连续 14 天每小时抽样零缺失'
  if (args.registry === undefined || args.trustCa === undefined) {
    return {
      id: 'S-1',
      title,
      verdict: 'not-collected',
      reason:
        '未采集：需要 --registry 与 --trust-ca 才能对一张真实的注册表做 CA 校验',
    }
  }

  const caCertificate = new X509Certificate(readFileSync(args.trustCa, 'utf8'))
  let agents: unknown
  try {
    const response = await fetch(
      `${args.registry.replace(/\/+$/, '')}/v0/agents`,
      {
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
    agents = ((await response.json()) as Record<string, unknown>)['agents']
  } catch (error) {
    return {
      id: 'S-1',
      title,
      verdict: 'not-collected',
      reason: `未采集：注册中心读不到（${error instanceof Error ? error.message : String(error)}）`,
    }
  }
  if (!Array.isArray(agents)) {
    return {
      id: 'S-1',
      title,
      verdict: 'fail',
      reason: '注册中心返回的不是 agents 列表',
    }
  }

  // The RL is part of S-1's judgement: §9.1's own column says "有效期 + RL".
  let revokedFingerprints = new Set<string>()
  let revocationListFresh = false
  try {
    const response = await fetch(
      `${args.registry.replace(/\/+$/, '')}/v0/revocation-list`,
      { signal: AbortSignal.timeout(10_000) },
    )
    if (response.ok) {
      const caJwk = caCertificate.publicKey.export({ format: 'jwk' })
      const verified =
        typeof caJwk.x === 'string'
          ? verifyRevocationList(caJwk.x, await response.json())
          : null
      if (verified !== null) {
        revokedFingerprints = new Set(
          verified.revoked.map(entry => entry.fingerprint256),
        )
        revocationListFresh = now < verified.nextUpdate
      }
    }
  } catch {
    // Absent or unreadable — recorded below, not thrown.
  }

  const problems: { node: string; reason: string }[] = []
  const seen = new Set<string>()
  for (const raw of agents) {
    if (!isRecord(raw)) continue
    const address = typeof raw['address'] === 'string' ? raw['address'] : ''
    const node = /^[a-z][a-z0-9+.-]*:\/\/([^/]+)\//i.exec(address)?.[1]
    if (node === undefined || seen.has(node)) continue
    seen.add(node)
    const pem = raw['certificate']
    if (typeof pem !== 'string' || pem.length === 0) {
      problems.push({ node, reason: 'no certificate published' })
      continue
    }
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(pem)
    } catch {
      problems.push({ node, reason: 'certificate does not parse' })
      continue
    }
    if (!certificate.verify(caCertificate.publicKey)) {
      problems.push({ node, reason: 'not signed by this CA (F-2)' })
      continue
    }
    const binding = parseNodeCertificateBinding(certificate.subjectAltName)
    if (binding === null) {
      problems.push({ node, reason: 'SANs do not carry a §4.2 binding' })
      continue
    }
    if (binding.node !== node) {
      problems.push({ node, reason: `certificate names ${binding.node}` })
      continue
    }
    if (now >= Date.parse(certificate.validTo)) {
      problems.push({ node, reason: 'expired' })
      continue
    }
    if (revokedFingerprints.has(certificate.fingerprint256)) {
      problems.push({ node, reason: 'on the revocation list' })
    }
  }

  const sample: S1Sample = {
    at: now,
    total: seen.size,
    verified: seen.size - problems.length,
    problems,
  }

  let history: S1Sample[] = []
  if (args.history !== undefined) {
    try {
      history = readFileSync(args.history, 'utf8')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line) as S1Sample)
    } catch {
      history = []
    }
    // Append this run's sample: a probe that does not accumulate can never
    // answer a question about fourteen days.
    Bun.write(
      args.history,
      `${history.map(s => JSON.stringify(s)).join('\n')}${history.length === 0 ? '' : '\n'}${JSON.stringify(sample)}\n`,
    )
  }
  const continuity = continuityOf([...history, sample], now)
  const detail = { sample, continuity, revocationListFresh }

  if (problems.length > 0) {
    return {
      id: 'S-1',
      title,
      verdict: 'fail',
      reason: `${String(problems.length)} 个节点的证书通不过 CA 校验或已失效`,
      detail,
    }
  }
  if (seen.size === 0) {
    return {
      id: 'S-1',
      title,
      verdict: 'fail',
      reason: '注册表是空的：0 个在租节点不构成 100%',
      detail,
    }
  }
  if (!continuity.met) {
    return {
      id: 'S-1',
      title,
      verdict: 'not-collected',
      reason: `本次抽样全绿，但连续性未达 ${String(REQUIRED_CONTINUITY_DAYS)} 天（已积累 ${String(continuity.spanDays)} 天 / ${String(continuity.samples)} 次抽样）`,
      detail,
    }
  }
  return {
    id: 'S-1',
    title,
    verdict: 'pass',
    reason: `${String(seen.size)} 个在租节点全部通过，连续 ${String(continuity.spanDays)} 天零缺失`,
    detail,
  }
}

// ---------------------------------------------------------------------------
// S-2 — the N×N resolution matrix
// ---------------------------------------------------------------------------

/**
 * S-2 already has a gauge: `scripts/qianmo-nxn-resolution-matrix.ts` (P12.2).
 * It is run as a subprocess rather than re-implemented here — one matrix
 * engine, one place it can be wrong.
 *
 * Its self-test mode simulates N nodes in one process, which proves the
 * engine and `CertificateDirectory` work. It does **not** prove what §9.1
 * asks, which is that N *deployed* nodes each resolved every other one for
 * fourteen days. So a green self-test is reported as `not-collected` with the
 * engine result attached, and only `--snapshot`/`--ground-truth` against real
 * per-node exports can produce a `pass`.
 */
function probeS2(args: Args): CriterionReport {
  const title =
    'N×N 解析矩阵全绿：每个节点都能为每个其他节点解析出公钥，连续 14 天'
  if (opensslVersion() === null) {
    return {
      id: 'S-2',
      title,
      verdict: 'not-collected',
      reason: '未采集：本机没有可用的 openssl，量具的自检模式跑不了',
    }
  }
  const script = join(import.meta.dir, 'qianmo-nxn-resolution-matrix.ts')
  const run = Bun.spawnSync(
    ['bun', 'run', script, '--nodes', String(args.nodes)],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  let matrix: unknown
  try {
    matrix = JSON.parse(run.stdout.toString())
  } catch {
    return {
      id: 'S-2',
      title,
      verdict: 'fail',
      reason: '量具没有产出可解析的报告',
      detail: { stderr: run.stderr.toString().slice(0, 2_000) },
    }
  }
  const allResolved =
    isRecord(matrix) && matrix['allResolved'] === true && run.exitCode === 0
  if (!allResolved) {
    return {
      id: 'S-2',
      title,
      verdict: 'fail',
      reason: '量具的自检矩阵有未解析的格子——解析引擎本身就不成立',
      detail: { selfTest: matrix },
    }
  }
  return {
    id: 'S-2',
    title,
    verdict: 'not-collected',
    reason:
      '未采集：自检模式证明的是解析引擎，不是舰队。要 pass 需要真实的每节点快照' +
      '（qianmo:nxn-matrix --snapshot <node>=<path> --ground-truth <path>）连续 14 天',
    detail: { selfTest: matrix },
  }
}

// ---------------------------------------------------------------------------
// S-3 — the acceptance scripts, run under SIGNED_TASK_POLICY
// ---------------------------------------------------------------------------

/** The four §9.1 names, verbatim. */
const S3_SCRIPTS = [
  'demo/env/smoke.sh',
  'demo/ac3-loop-rate.sh',
  'make -C demo p61-smoke',
  'demo/env/beta/beta-smoke.sh',
] as const

/**
 * S-3 is not run from here, and that is a deliberate boundary rather than a
 * shortcut: the four scripts bring up a whole demo topology (including the
 * real beta fleet's smoke path) and own their own lifecycle. What this probe
 * does is *check the evidence they produce*, in the shape:
 *
 *   { "policy": "SIGNED_TASK_POLICY", "at": <epoch ms>,
 *     "results": [ { "script": "demo/env/smoke.sh", "ok": true } ] }
 *
 * The `policy` field is checked, not assumed. A run under `--open-policy`
 * proves nothing about S-3 and is exactly the run somebody would produce by
 * accident.
 */
function probeS3(args: Args): CriterionReport {
  const title = '在 SIGNED_TASK_POLICY 下跑通现有验收脚本'
  if (args.s3Results === undefined) {
    return {
      id: 'S-3',
      title,
      verdict: 'not-collected',
      reason:
        '未采集：需要 --s3-results。真实内测舰队当前按 §9.2 阶段 ① 以 --open-policy + ' +
        '--audit-signed-tasks 运行；beta-smoke.sh 会发不带 capability 的 task.request，强制策略下' +
        '会被 E_CAP_INSUFFICIENT 拒。S-1~S-4 与 7 天观察窗口满足后，补齐发送方 capability 并在 ' +
        'SIGNED_TASK_POLICY 下重跑这四条脚本；现在不把阶段①结果冒充为 S-3',
      detail: { requiredScripts: S3_SCRIPTS },
    }
  }
  let evidence: unknown
  try {
    evidence = readJson(args.s3Results)
  } catch (error) {
    return {
      id: 'S-3',
      title,
      verdict: 'fail',
      reason: `--s3-results 读不了：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!isRecord(evidence) || evidence['policy'] !== 'SIGNED_TASK_POLICY') {
    return {
      id: 'S-3',
      title,
      verdict: 'fail',
      reason:
        '证据没有声明 policy 为 SIGNED_TASK_POLICY——在开放策略下跑通不构成 S-3',
      detail: { requiredScripts: S3_SCRIPTS },
    }
  }
  const results = evidence['results']
  const passed = new Set(
    (Array.isArray(results) ? results : [])
      .filter(one => isRecord(one) && one['ok'] === true)
      .map(one => String((one as Record<string, unknown>)['script'])),
  )
  const missing = S3_SCRIPTS.filter(script => !passed.has(script))
  return missing.length === 0
    ? {
        id: 'S-3',
        title,
        verdict: 'pass',
        reason: '四条验收脚本在强制策略下全部通过',
        detail: { evidence },
      }
    : {
        id: 'S-3',
        title,
        verdict: 'fail',
        reason: `缺少通过记录：${missing.join('、')}`,
        detail: { evidence, missing },
      }
}

// ---------------------------------------------------------------------------
// S-4 — the revocation drill
// ---------------------------------------------------------------------------

/**
 * The mechanism half, run for real: an offline CA, a live registry, an issued
 * certificate, a `CertificateDirectory` that resolves it — and then a signed
 * revocation list that makes the very same directory stop resolving it on the
 * next refresh.
 *
 * This is not a simulation of the drill; it is the drill's machinery, executed.
 * What it cannot be is §9.1's S-4, which asks for a revocation performed on
 * deployed nodes and evidenced from the audit trail — so a green mechanism
 * does not become a `pass`, it becomes a `detail` on a `not-collected`.
 */
async function revocationDrill(): Promise<Record<string, unknown>> {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-s4-drill-'))
  const caDir = join(root, 'ca')
  let registryServer:
    | Awaited<ReturnType<typeof startRegistryServer>>
    | undefined
  let transport: ReturnType<typeof startTransportServer> | undefined
  const clients: TransportClient[] = []
  try {
    initCa({ directory: caDir })
    const caCertificatePem = readFileSync(join(caDir, 'ca.crt'), 'utf8')
    const registry = new InMemoryRegistry()
    registryServer = startRegistryServer(0, { registry })

    const announce = (
      node: string,
      keys: ReturnType<typeof generateNodeKeyPair>,
      certificate: string,
    ) => {
      const registered = registry.register(
        `qianmo://${node}/agent`,
        `wss://${node}.example.com/agent`,
        { publicKey: keys.publicKey, certificate },
      )
      if (!registered.ok) throw new Error(`drill setup: ${registered.message}`)
    }

    const issueNode = (node: string) => {
      const keys = generateNodeKeyPair()
      const keyPath = join(root, `${node}.tls.key`)
      writeFileSync(
        keyPath,
        runOpenssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout']),
        { mode: 0o600 },
      )
      const csrPem = runOpenssl([
        'req',
        '-new',
        '-key',
        keyPath,
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
      announce(node, keys, issued.certificatePem)
      return { keys, issued }
    }

    const dialerNode = 'node-drill'
    const listenerNode = 'node-drill-listener'
    const dialer = issueNode(dialerNode)
    const listener = issueNode(listenerNode)

    const publish = async (
      revoke: readonly { node: string; fingerprint256: string }[],
    ) => {
      const rl = refreshRevocationList({
        directory: caDir,
        revoke: [...revoke],
        now: Date.now(),
        validMs: 30 * DAY_MS,
      })
      const response = await fetch(
        `${registryServer?.url ?? ''}/v0/revocation-list`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: readFileSync(rl.path, 'utf8'),
        },
      )
      if (response.status !== 200) {
        throw new Error(
          `drill setup: publishing RL failed ${String(response.status)}`,
        )
      }
    }

    const directory = new CertificateDirectory({
      caCertificatePem,
      registryUrl: registryServer.url,
    })
    await publish([])
    await directory.refresh()

    const socketPath = join(root, 'transport.sock')
    directory.setRefreshSink(({ permanentlyInvalidatedCredentials }) => {
      transport?.closePeerCredentials(permanentlyInvalidatedCredentials)
    })
    transport = startTransportServer({
      unix: socketPath,
      psk: 's4-probe-psk-not-a-production-secret',
      onMessage: () => {},
      signing: {
        node: listenerNode,
        keys: listener.keys,
        directory,
        required: true,
        credentialProofRequired: true,
        credential: {
          selector: listener.issued.fingerprint256,
          source: 'certificate',
          id: listener.issued.fingerprint256,
        },
      },
    })
    const client = new TransportClient({
      endpoint: { unix: socketPath },
      node: dialerNode,
      peerNode: listenerNode,
      psk: 's4-probe-psk-not-a-production-secret',
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 10, maxDelayMs: 20, giveUpAfterMs: 100 },
      signing: {
        keys: dialer.keys,
        directory,
        required: true,
        credentialProofRequired: true,
        credential: {
          selector: dialer.issued.fingerprint256,
          source: 'certificate',
          id: dialer.issued.fingerprint256,
        },
      },
    })
    clients.push(client)
    await client.connect(5_000)
    const beforeRevocation = directory.publicKeyOf(dialerNode)
    const connectionsBeforeRevocation = transport.connections

    // The registry is a zero-auth discovery courier. A brief empty snapshot
    // may make *future* handshakes unavailable, but is neither a revocation
    // statement nor grounds to permanently close a connection authenticated
    // before the omission.
    registry.clear()
    const temporaryAbsence = await directory.refresh()
    const connectionsAfterTemporaryAbsence = transport.connections
    const clientClosedAfterTemporaryAbsence = client.isClosed()
    announce(dialerNode, dialer.keys, dialer.issued.certificatePem)
    announce(listenerNode, listener.keys, listener.issued.certificatePem)
    await directory.refresh()
    const directoryRestored =
      directory.publicKeyOf(dialerNode) === dialer.keys.publicKey &&
      directory.publicKeyOf(listenerNode) === listener.keys.publicKey

    await publish([
      { node: dialerNode, fingerprint256: dialer.issued.fingerprint256 },
    ])
    await directory.refresh()

    const deadline = Date.now() + 3_000
    while (
      (transport.connections !== 0 || !client.isClosed()) &&
      Date.now() < deadline
    ) {
      await new Promise<void>(resolve => setTimeout(resolve, 10))
    }
    const connectionsAfterRevocation = transport.connections
    const channelsAfterRevocation = transport.channels
    const closeCodes = client.events
      .byType(TransportEventType.ConnectionClosed)
      .map(event => event.detail['code'])
    const closedWithUnauthorized = closeCodes.includes(CLOSE_UNAUTHORIZED)

    const returning = new TransportClient({
      endpoint: { unix: socketPath },
      node: dialerNode,
      peerNode: listenerNode,
      psk: 's4-probe-psk-not-a-production-secret',
      keepAliveIntervalMs: 0,
      backoff: { baseDelayMs: 10, maxDelayMs: 20, giveUpAfterMs: 100 },
      signing: {
        keys: dialer.keys,
        directory,
        required: true,
        credentialProofRequired: true,
        credential: {
          selector: dialer.issued.fingerprint256,
          source: 'certificate',
          id: dialer.issued.fingerprint256,
        },
      },
    })
    clients.push(returning)
    let reconnectRejected = false
    try {
      await returning.connect(5_000)
    } catch (error) {
      reconnectRejected = /4003/.test(
        error instanceof Error ? error.message : String(error),
      )
    }
    const afterRevocation = directory.publicKeyOf(dialerNode)

    return {
      resolvedBeforeRevocation: beforeRevocation === dialer.keys.publicKey,
      resolvedAfterRevocation: afterRevocation !== null,
      fingerprint256: dialer.issued.fingerprint256,
      connectionsBeforeRevocation,
      missingInvalidated: temporaryAbsence.directoryRemoved,
      temporaryAbsencePermanentlyInvalidated:
        temporaryAbsence.permanentlyInvalidated,
      connectionsAfterTemporaryAbsence,
      clientClosedAfterTemporaryAbsence,
      directoryRestored,
      connectionsAfterRevocation,
      channelsAfterRevocation,
      closedWithUnauthorized,
      reconnectRejected,
      ok:
        beforeRevocation === dialer.keys.publicKey &&
        afterRevocation === null &&
        connectionsBeforeRevocation === 1 &&
        temporaryAbsence.permanentlyInvalidated.length === 0 &&
        connectionsAfterTemporaryAbsence === 1 &&
        !clientClosedAfterTemporaryAbsence &&
        directoryRestored &&
        connectionsAfterRevocation === 0 &&
        channelsAfterRevocation === 0 &&
        closedWithUnauthorized &&
        reconnectRejected,
    }
  } finally {
    for (const client of clients) await client.close()
    await transport?.stop()
    await registryServer?.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

async function probeS4(args: Args): Promise<CriterionReport> {
  const title = '真实吊销演练：吊销一个测试节点的证书，全网 ≤ 1 h 拒绝它'
  let mechanism: Record<string, unknown> | undefined
  if (opensslVersion() !== null) {
    try {
      mechanism = await revocationDrill()
    } catch (error) {
      return {
        id: 'S-4',
        title,
        verdict: 'fail',
        reason: `吊销机制本身跑不通：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (mechanism['ok'] !== true) {
      return {
        id: 'S-4',
        title,
        verdict: 'fail',
        reason: '吊销机制不成立：吊销后目录仍能解析出该节点的公钥',
        detail: { mechanism },
      }
    }
  }

  if (args.s4Report === undefined) {
    return {
      id: 'S-4',
      title,
      verdict: 'not-collected',
      reason:
        mechanism === undefined
          ? '未采集：本机没有 OpenSSL，无法就地运行吊销机制；§9.1 要的是在部署节点上' +
            '由人执行一次并从审计链取证，需要 --s4-report'
          : '未采集：机制已就地跑通（见 detail.mechanism），但 §9.1 要的是在部署节点上' +
            '由人执行一次并从审计链取证，需要 --s4-report',
      ...(mechanism === undefined ? {} : { detail: { mechanism } }),
    }
  }
  let evidence: unknown
  try {
    evidence = readJson(args.s4Report)
  } catch (error) {
    return {
      id: 'S-4',
      title,
      verdict: 'fail',
      reason: `--s4-report 读不了：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const ok =
    isRecord(evidence) &&
    evidence['drilledAt'] !== undefined &&
    evidence['revokedNode'] !== undefined &&
    evidence['refusedWithinMs'] !== undefined &&
    Number(evidence['refusedWithinMs']) <= 60 * 60 * 1000 &&
    evidence['connectionsClosed'] === true
  return ok
    ? {
        id: 'S-4',
        title,
        verdict: 'pass',
        reason: '演练已执行，全网在 1 h 内拒绝该节点并断开活连接',
        detail: { evidence, ...(mechanism === undefined ? {} : { mechanism }) },
      }
    : {
        id: 'S-4',
        title,
        verdict: 'fail',
        reason:
          '演练证据不完整：需要 drilledAt / revokedNode / refusedWithinMs ≤ 3600000 / connectionsClosed=true',
        detail: { evidence, ...(mechanism === undefined ? {} : { mechanism }) },
      }
}

// ---------------------------------------------------------------------------
// S-5 — the console's certificate column
// ---------------------------------------------------------------------------

/**
 * The machine half of S-5's "目视 + 一条页面用例".
 *
 * Renders the real roster fragment with a certificate half attached and looks
 * for §10.1's four things. Rendering rather than grepping the source: what
 * §10.1 asks is that an operator can *see* these, and a constant that exists
 * but never reaches the markup would pass a source scan.
 */
function probeS5(now: number): CriterionReport {
  const title =
    '控制台上有证书栏：谁的证书快到期 / 谁在 RL 上 / RL 什么时候过期'
  const certificates: ConsoleCertificate[] = [
    {
      node: 'node-a',
      // 10 days: inside §6.2's 21-day (yellow) tier and outside the 7-day
      // (red) one, which is a status of its own (`expiring-urgent`).
      status: 'expiring',
      fingerprint256: 'AB:CD:EF:01',
      notAfter: now + 10 * DAY_MS,
    },
    { node: 'node-b', status: 'revoked', fingerprint256: 'FE:DC:BA:98' },
  ]
  const html = renderRoster(
    [
      {
        address: 'qianmo://node-a/reviewer',
        endpoint: 'node-a.internal:7421',
        capabilities: [],
        status: 'online',
        registeredAt: now - 600_000,
        lastHeartbeatAt: now - 10_000,
        expiresAt: now + 290_000,
      },
      {
        address: 'qianmo://node-b/reviewer',
        endpoint: 'node-b.internal:7421',
        capabilities: [],
        status: 'online',
        registeredAt: now - 600_000,
        lastHeartbeatAt: now - 10_000,
        expiresAt: now + 290_000,
      },
    ],
    null,
    now,
    300_000,
    {
      snapshot: {
        certificates,
        revocationList: {
          issuedAt: now - DAY_MS,
          nextUpdate: now + 29 * DAY_MS,
          revokedCount: 1,
        },
      },
      failure: null,
      roots: [],
      binName: 'qm',
    },
  )

  const wanted: Readonly<Record<string, string>> = {
    expiringState: '证书 将到期',
    revokedState: '证书 已吊销',
    fingerprint: 'AB:CD:EF:01',
    remaining: '剩余 10d',
    revocationListHeader: '吊销清单 1 条',
    revocationListNextUpdate: '剩余 29d',
    reissueCommand: 'qm ca issue node-a',
  }
  const missing = Object.entries(wanted)
    .filter(([, needle]) => !html.includes(needle))
    .map(([key]) => key)

  return missing.length === 0
    ? {
        id: 'S-5',
        title,
        verdict: 'pass',
        reason: '证书栏渲染出 §10.1 的四件事，并带 §10.2 那条可复制的命令',
        detail: { checked: Object.keys(wanted) },
      }
    : {
        id: 'S-5',
        title,
        verdict: 'fail',
        reason: `证书栏缺少：${missing.join('、')}`,
        detail: { missing },
      }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const now = Date.now()
  const criteria: CriterionReport[] = [
    await probeS1(args, now),
    probeS2(args),
    probeS3(args),
    await probeS4(args),
    probeS5(now),
  ]
  const report: ProbeReport = {
    generatedAt: new Date(now).toISOString(),
    criteria,
    allPass: criteria.every(one => one.verdict === 'pass'),
    notCollected: criteria
      .filter(one => one.verdict === 'not-collected')
      .map(one => one.id),
    failed: criteria.filter(one => one.verdict === 'fail').map(one => one.id),
  }
  const rendered = `${JSON.stringify(report, null, 2)}\n`
  process.stdout.write(rendered)
  if (args.out !== undefined) writeFileSync(args.out, rendered)

  if (!report.allPass) {
    process.stderr.write(
      `§9.1 gate not met: ${String(report.failed.length)} failed, ` +
        `${String(report.notCollected.length)} not collected.\n`,
    )
    process.exitCode = 1
  }
}

await main()
