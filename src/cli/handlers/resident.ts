// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { invokedBinName } from '../../constants/brand.js'
import { sourceCommit } from '../../constants/buildProvenance.js'
import { IDENTITY_MODE, type IdentityMode } from '../../constants/identity.js'
import { QianmoResident } from '../../services/qianmo/resident.js'
import {
  DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
  ResidentActivityReporter,
} from '@qianmo/resident/activity'
import type { ResidentTimingEvent } from '@qianmo/resident/timings'
import {
  ResidentUpstreamHealth,
  type ResidentPriorLife,
} from '@qianmo/resident'
import { assertTeamName, isReservedDeviceName } from '@qianmo/adapter/names'
import {
  DEFAULT_SNAPSHOT_INTERVAL_MS,
  remoteSnapshotWriter,
} from '@qianmo/backup'
import {
  DEFAULT_WITNESS_ANCHOR_INTERVAL_MS,
  AuditWitnessScheduler,
  remoteWitnessAnchorWriter,
} from '@qianmo/witness'
import {
  capabilityShadowTrailSink,
  certificateDirectoryTrailSink,
  certificateDirectoryErrorTrailSink,
  openAuditTrail,
  residentNotifyTrailSink,
  routerTrailSink,
  transportTrailSink,
} from '../../services/qianmo/auditTrail.js'
import {
  NodeCapabilities,
  OPEN_POLICY,
  SIGNED_TASK_POLICY,
  StaticPublicKeyDirectory,
  type NodeKeyPair,
  type PublicKeyDirectory,
  type ShadowRefusalSink,
} from '@qianmo/capability'
import type { TLSOptions } from 'bun'
import { isValidSegment } from '@qianmo/protocol'
import {
  PSK_ENV_VAR,
  mutualTlsServerOptions,
  pskFromEnv,
  type ListenerIdentity,
} from '@qianmo/transport'
import {
  CERTIFICATE_CREDENTIAL_SOURCE,
  CertificateDirectory,
  assertOwnCertificateMatchesIdentity,
  type CertificateDirectoryAuditSink,
  type CertificateDirectoryErrorSink,
} from '../../services/qianmo/certificateDirectory.js'
import {
  loadOrCreateNodeKeys,
  parseTrustedKey,
} from '../../services/qianmo/nodeIdentity.js'
import {
  anchoredValidity,
  readTrustAnchors,
} from '../../services/qianmo/trustAnchors.js'
import { residentOptionValue } from './residentArgs.js'
import {
  probeResidentModel,
  resolveResidentModelProbeTarget,
  warnRefusedModelCredentials,
  warnUnavailableModelCredentialProbe,
  type ResidentModelProbeInputs,
  type ResidentModelProbeVerdict,
} from './residentModelProbe.js'

export const MAX_PENDING_TIMING_EVENTS = 1_024

/**
 * The write-only backup credential's only entrance.
 *
 * Hoisted rather than inlined at its one use site because the help text names
 * it too, and an environment variable whose name is spelled twice is an
 * environment variable that can be spelled two ways.
 */
const BACKUP_TOKEN_ENV_VAR = 'QIANMO_BACKUP_WRITE_TOKEN'

/** The node-side credential can append anchors but cannot rewrite history. */
const WITNESS_TOKEN_ENV_VAR = 'QIANMO_WITNESS_WRITE_TOKEN'

interface ResidentNdjsonWriter<T> {
  write(record: T): void
  close(): Promise<void>
}

/**
 * 一条内存采样。P7.3 的**进程内**通道，与 `demo/lib/p73-sample.ts` 的外部
 * `/proc` 通道互为对照：外部那条看得见 RSS 与 cgroup，看不见 JS 堆；这条相反。
 *
 * **`heapSize` 来自 `bun:jsc`，不是 `process.memoryUsage().heapUsed`。**
 * `docs/zh/memory-peak-analysis.md`「测量方法上的五个坑」第 1 条：Bun 1.3.13 下
 * `heapUsed` 是**冻结常量**——分配 5 万个字符串前后都报 ~212 KB。用它采 24 h，
 * 得到的是一条完美的平线和一个完全错误的结论。这一条钉在这里，别再改回去。
 *
 * 同一份文档第 4 条补了另一半：`heapSize` **不计大字符串的 backing store**，
 * 所以 `rss` 必须同时采——两条线一起看才知道涨的是对象还是字节。
 *
 * **读这些样本前先看 `docs/dev/baseline-m0.md` §2.3 ④**：`heapSize` 与 `objectCount`
 * 是**滞后**指标（实测分配 30 万个对象之后它们纹丝不动，而 `rss` 已经涨了 59 MB），
 * 单点持平说明不了任何事，要按多点斜率读。
 */
interface ResidentMemSample {
  /** Epoch ms。 */
  readonly at: number
  /** 常驻进程的 RSS，字节。JS 堆之外的一切都只在这条线上。 */
  readonly rss: number
  /** `heapStats().heapSize`，字节。 */
  readonly heapSize: number
  /** `heapStats().heapCapacity`，字节。 */
  readonly heapCapacity: number
  /** `heapStats().objectCount`。 */
  readonly objectCount: number
  /** `process.uptime()`，秒。用来把采样对齐到「跑了多久」而不是墙上时刻。 */
  readonly uptime: number
}

function createNdjsonWriter<T>(
  path: string,
  onError: (error: unknown) => void,
  overflowMessage: string,
): ResidentNdjsonWriter<T> {
  let queue: string[] = []
  let pending = 0
  let writing: Promise<void> | null = null
  let closed = false
  let overflowReported = false

  const drain = (): void => {
    if (writing !== null || queue.length === 0) return
    const batch = queue
    queue = []
    writing = appendFile(path, batch.join(''))
      .catch(onError)
      .finally(() => {
        pending -= batch.length
        writing = null
        drain()
      })
  }

  return {
    write(record): void {
      if (closed) return
      if (pending >= MAX_PENDING_TIMING_EVENTS) {
        if (!overflowReported) {
          overflowReported = true
          onError(new Error(overflowMessage))
        }
        return
      }
      queue.push(`${JSON.stringify(record)}\n`)
      pending++
      queueMicrotask(drain)
    },
    async close(): Promise<void> {
      closed = true
      drain()
      while (pending > 0) {
        const current = writing
        if (current !== null) await current
        else drain()
      }
    },
  }
}

export function createResidentTimingWriter(
  path: string,
  onError: (error: unknown) => void,
): ResidentNdjsonWriter<ResidentTimingEvent> {
  return createNdjsonWriter(
    path,
    onError,
    'resident timing writer queue overflow',
  )
}

/**
 * 内存采样的落盘 writer —— 与 `--timings` 同一形状：同一个 1024 队列上限、同一条
 * 「只报一次」的溢出警告、同一个 close 语义。
 *
 * 上限对内存采样这条路径其实绰绰有余（默认 60 s 一条），保留它不是为了防溢出，
 * 而是为了让**溢出这件事仍然可见**：一条溢出警告意味着这个数据集缺了不知道多少条，
 * P7.3 的判据据此把整份数据判为不可用（`demo/lib/p73-report-core.ts`）。
 */
export function createResidentMemWriter(
  path: string,
  onError: (error: unknown) => void,
): ResidentNdjsonWriter<ResidentMemSample> {
  return createNdjsonWriter(
    path,
    onError,
    'resident memory writer queue overflow',
  )
}

/**
 * `bun:jsc` 只在**运行期**解析，绝不进静态模块图。
 *
 * 这个文件被 `src/entrypoints/cli.tsx` 动态 import，所以它在 vite 的打包图里；
 * 而 `vite.config.ts` 的 `ssr.noExternal: true` 要求 rollup 把一切内联，一个
 * `bun:` specifier 它解析不了。写成不可静态折叠的形式，rollup 就只会原样留着它。
 * 常驻模式本来就断言了 Bun 运行时（`assertResidentRuntime`），所以真到用的时候
 * 模块一定在。
 */
const JSC_MODULE = ['bun', 'jsc'].join(':')

interface HeapStatsSnapshot {
  readonly heapSize: number
  readonly heapCapacity: number
  readonly objectCount: number
}

async function loadHeapStats(): Promise<() => HeapStatsSnapshot> {
  const loaded: unknown = await import(JSC_MODULE)
  const heapStats = (loaded as { heapStats?: unknown }).heapStats
  if (typeof heapStats !== 'function') {
    throw new Error('bun:jsc did not export heapStats')
  }
  return heapStats as () => HeapStatsSnapshot
}

/** `--mem-sample` 的默认采样间隔：与 P7.3 的 24 h 长跑节拍一致。 */
export const DEFAULT_RESIDENT_MEM_INTERVAL_MS = 60_000
/**
 * How often the certificate directory re-reads the registry.
 *
 * One hour is §6.4's own number for the revocation list, and the same poll
 * carries the certificates, so there is one clock rather than two. It bounds
 * the window in which a revoked node is still accepted — the design accepts
 * that hour explicitly (§11 T-C) in exchange for not asking anyone to do a
 * weekly chore.
 */
export const DEFAULT_REGISTRY_POLL_INTERVAL_MS = 3_600_000

export interface ResidentCliConfig {
  readonly node: string
  readonly team: string
  readonly agents: readonly { agent: string; cwd: string }[]
  /**
   * `--allow-workspace-edits`：把 ACP 会话的权限模式从 `dontAsk` 放宽到
   * `acceptEdits`，也就是**只**自动放行工作目录之内的编辑。
   *
   * 缺省不给。放宽是显式动作，不该由「跑的是哪一版产物」决定——issue #10 记的是
   * 同一个教训的另一半（任务策略两个开关也不许省成默认值）。
   */
  readonly allowWorkspaceEdits?: boolean
  readonly port?: number
  readonly hostname?: string
  readonly unix?: string
  readonly activityUrl?: string
  readonly activityReconnectFactor?: number
  readonly timings?: string
  /** P7.3 内存基线的落盘路径（NDJSON）。 */
  readonly memSample?: string
  /** 采样间隔，仅在 `memSample` 存在时有意义。 */
  readonly memIntervalMs?: number
  /** `<node>=<publicKey>` pairs this node will accept capabilities from. */
  readonly trusted: readonly (readonly [string, string])[]
  /**
   * Path to the CA root certificate(s) (key-distribution.md §8.1's
   * `--trust-ca`, §8.2 phase ①). When given, peer keys are resolved through a
   * `CertificateDirectory` instead of only `StaticPublicKeyDirectory`;
   * `--trust` entries continue to work and take priority on conflict. The
   * file may hold several roots during a rotation overlap (§3.3); the
   * directory and the TLS layer both use all of them.
   */
  readonly trustCa?: string
  /** Path to this node's own certificate (§4.1's `<node>.tls.crt`). */
  readonly cert?: string
  /** Path to this node's own TLS private key (§4.1's `<node>.tls.key`). */
  readonly key?: string
  /**
   * Base URL of the registry's HTTP v0 API, polled for peer certificates and
   * the revocation list (§5.1 / §6.4). Requires `--trust-ca`: without a CA
   * root there is nothing to check a published certificate against, and a
   * directory that polls but believes nothing is a network call pretending to
   * be a feature.
   */
  readonly registryUrl?: string
  /**
   * Sign this node's half of every handshake and check a peer's when it signs
   * one (§7.1 / §7.1.1, §8.2 phase ①).
   *
   * Off by default, and that default is the whole of "this package only makes
   * it possible to turn on": with it off the node behaves exactly as it did
   * before, pre-shared key and all.
   */
  readonly signHandshake?: boolean
  /**
   * Refuse a peer that does not sign (§8.2 phase ③). Implies
   * {@link ResidentCliConfig.signHandshake} — this is the switch that retires
   * the pre-shared key on this node, and there is no other.
   */
  readonly requireSignedHandshake?: boolean
  /**
   * Require `write-limited` for work, rather than admitting unsigned tasks.
   *
   * **Default `true` since P12.4** (key-distribution.md §9.2 ②).
   * `--open-policy` is the escape hatch that sets it back to `false`;
   * `--require-signed-tasks` still works and now merely restates the default.
   */
  readonly requireSignedTasks: boolean
  /**
   * Observation mode (§9.2 phase ①): record what the enforcing policy would
   * have refused, and refuse nothing.
   *
   * A separate switch from {@link ResidentCliConfig.requireSignedTasks} on
   * purpose, and the separation is the feature — "拿指令进来" and "把数据发出去"
   * are two decisions here too. One knob doing both could not be used to cost
   * the switch without also making it.
   */
  readonly auditSignedTasks: boolean
  /**
   * Present only when the task policy was *chosen* on the command line, by
   * either `--require-signed-tasks` or `--open-policy`.
   *
   * Absent means {@link ResidentCliConfig.requireSignedTasks} came from the
   * default, and the default has moved once already (P12.4 flipped it from
   * `false` to `true`). A command line that names neither switch therefore
   * describes a *security posture that changes with the build date* — which
   * is what {@link warnUnselectedTaskPolicy} exists to say out loud, once,
   * on stderr. It is deliberately not a third value of the policy itself:
   * the gate has two states, and only the provenance is a third question.
   */
  readonly taskPolicySelected?: boolean
  /** Base URL of the host-side backup service (P4.4). */
  readonly backupUrl?: string
  /** Gap between scheduled workspace snapshots. */
  readonly backupIntervalMs?: number
  /** Base URL of the host-side append-only witness endpoint (P11.4). */
  readonly witnessUrl?: string
  /** Gap between witness anchors; defaults to the §4.2 60 s design value. */
  readonly witnessIntervalMs?: number
}

export function parseResidentArgs(
  args: readonly string[],
  identity: IdentityMode = IDENTITY_MODE,
): ResidentCliConfig {
  let node: string | undefined
  let team: string | undefined
  let port: number | undefined
  let hostname: string | undefined
  let unix: string | undefined
  let activityUrl: string | undefined
  let activityReconnectFactor: number | undefined
  let timings: string | undefined
  let memSample: string | undefined
  let memIntervalMs: number | undefined
  // The switch, in one place. `--require-signed-tasks` and `--open-policy`
  // both write here; giving both is refused below rather than resolved, since
  // an invocation that asks for opposite policies has no honest winner.
  let requireSignedTasks = true
  let openPolicy = false
  let allowWorkspaceEdits = false
  let enforceRequested = false
  let auditSignedTasks = false
  let backupUrl: string | undefined
  let backupIntervalMs: number | undefined
  let trustCa: string | undefined
  let cert: string | undefined
  let key: string | undefined
  let registryUrl: string | undefined
  let signHandshake = false
  let requireSignedHandshake = false
  let witnessUrl: string | undefined
  let witnessIntervalMs: number | undefined
  const trusted: Array<readonly [string, string]> = []
  const agents: Array<{ agent: string; cwd: string }> = []

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--node' || arg?.startsWith('--node=')) {
      const parsed = residentOptionValue(args, index, '--node')
      node = parsed.value
      index = parsed.next
    } else if (arg === '--team' || arg?.startsWith('--team=')) {
      const parsed = residentOptionValue(args, index, '--team')
      team = parsed.value
      index = parsed.next
    } else if (arg === '--agent' || arg?.startsWith('--agent=')) {
      const parsed = residentOptionValue(args, index, '--agent')
      const separator = parsed.value.indexOf('=')
      if (separator <= 0) {
        throw new Error('--agent must be <name>=<absolute-cwd>')
      }
      const agent = parsed.value.slice(0, separator)
      const cwd = parsed.value.slice(separator + 1)
      if (!isValidSegment(agent) || isReservedDeviceName(agent)) {
        throw new Error(`invalid resident agent ${JSON.stringify(agent)}`)
      }
      if (!isAbsolute(cwd))
        throw new Error('resident agent cwd must be absolute')
      agents.push({ agent, cwd: resolve(cwd) })
      index = parsed.next
    } else if (arg === '--port' || arg?.startsWith('--port=')) {
      const parsed = residentOptionValue(args, index, '--port')
      const number = Number(parsed.value)
      if (!Number.isInteger(number) || number < 0 || number > 65_535) {
        throw new Error('--port must be an integer from 0 to 65535')
      }
      port = number
      index = parsed.next
    } else if (arg === '--hostname' || arg?.startsWith('--hostname=')) {
      const parsed = residentOptionValue(args, index, '--hostname')
      if (parsed.value.trim() === '')
        throw new Error('--hostname must not be empty')
      hostname = parsed.value
      index = parsed.next
    } else if (arg === '--unix' || arg?.startsWith('--unix=')) {
      const parsed = residentOptionValue(args, index, '--unix')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--unix must be an absolute path')
      }
      unix = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--activity-url' || arg?.startsWith('--activity-url=')) {
      const parsed = residentOptionValue(args, index, '--activity-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new Error('--activity-url must use ws or wss')
      }
      activityUrl = url.toString()
      index = parsed.next
    } else if (
      arg === '--activity-reconnect-factor' ||
      arg?.startsWith('--activity-reconnect-factor=')
    ) {
      const parsed = residentOptionValue(
        args,
        index,
        '--activity-reconnect-factor',
      )
      const factor = Number(parsed.value)
      if (!Number.isFinite(factor) || factor <= 1) {
        throw new Error('--activity-reconnect-factor must be greater than 1')
      }
      activityReconnectFactor = factor
      index = parsed.next
    } else if (arg === '--trust' || arg?.startsWith('--trust=')) {
      const parsed = residentOptionValue(args, index, '--trust')
      trusted.push(parseTrustedKey(parsed.value))
      index = parsed.next
    } else if (arg === '--trust-ca' || arg?.startsWith('--trust-ca=')) {
      const parsed = residentOptionValue(args, index, '--trust-ca')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--trust-ca must be an absolute path')
      }
      trustCa = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--cert' || arg?.startsWith('--cert=')) {
      const parsed = residentOptionValue(args, index, '--cert')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--cert must be an absolute path')
      }
      cert = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--key' || arg?.startsWith('--key=')) {
      const parsed = residentOptionValue(args, index, '--key')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--key must be an absolute path')
      }
      key = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--registry-url' || arg?.startsWith('--registry-url=')) {
      const parsed = residentOptionValue(args, index, '--registry-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('--registry-url must use http or https')
      }
      registryUrl = url.toString()
      index = parsed.next
    } else if (arg === '--sign-handshake') {
      signHandshake = true
    } else if (arg === '--require-signed-handshake') {
      requireSignedHandshake = true
    } else if (arg === '--require-signed-tasks') {
      enforceRequested = true
      requireSignedTasks = true
    } else if (arg === '--open-policy') {
      openPolicy = true
      requireSignedTasks = false
    } else if (arg === '--audit-signed-tasks') {
      auditSignedTasks = true
    } else if (arg === '--allow-workspace-edits') {
      allowWorkspaceEdits = true
    } else if (arg === '--backup-url' || arg?.startsWith('--backup-url=')) {
      const parsed = residentOptionValue(args, index, '--backup-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('--backup-url must use http or https')
      }
      backupUrl = url.toString()
      index = parsed.next
    } else if (
      arg === '--backup-interval-ms' ||
      arg?.startsWith('--backup-interval-ms=')
    ) {
      const parsed = residentOptionValue(args, index, '--backup-interval-ms')
      const interval = Number(parsed.value)
      if (!Number.isInteger(interval) || interval < 1_000) {
        throw new Error('--backup-interval-ms must be an integer >= 1000')
      }
      backupIntervalMs = interval
      index = parsed.next
    } else if (arg === '--witness-url' || arg?.startsWith('--witness-url=')) {
      const parsed = residentOptionValue(args, index, '--witness-url')
      const url = new URL(parsed.value)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('--witness-url must use http or https')
      }
      witnessUrl = url.toString()
      index = parsed.next
    } else if (
      arg === '--witness-interval-ms' ||
      arg?.startsWith('--witness-interval-ms=')
    ) {
      const parsed = residentOptionValue(args, index, '--witness-interval-ms')
      const interval = Number(parsed.value)
      if (!Number.isInteger(interval) || interval < 1_000) {
        throw new Error('--witness-interval-ms must be an integer >= 1000')
      }
      witnessIntervalMs = interval
      index = parsed.next
    } else if (arg === '--timings' || arg?.startsWith('--timings=')) {
      const parsed = residentOptionValue(args, index, '--timings')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--timings must be an absolute path')
      }
      timings = resolve(parsed.value)
      index = parsed.next
    } else if (arg === '--mem-sample' || arg?.startsWith('--mem-sample=')) {
      const parsed = residentOptionValue(args, index, '--mem-sample')
      if (!isAbsolute(parsed.value)) {
        throw new Error('--mem-sample must be an absolute path')
      }
      memSample = resolve(parsed.value)
      index = parsed.next
    } else if (
      arg === '--mem-interval-ms' ||
      arg?.startsWith('--mem-interval-ms=')
    ) {
      const parsed = residentOptionValue(args, index, '--mem-interval-ms')
      const interval = Number(parsed.value)
      if (!Number.isInteger(interval) || interval < 1_000) {
        throw new Error('--mem-interval-ms must be an integer >= 1000')
      }
      memIntervalMs = interval
      index = parsed.next
    } else {
      // 指一下帮助：走到这一支的人多半是拼错了选项名，而在 `--help` 存在之前
      // 他没有任何地方可以去查那张表。
      throw new Error(
        `unknown resident option ${String(arg)}` +
          ` (run \`${invokedBinName()} resident --help\` for the list)`,
      )
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('resident mode requires OCC_IDENTITY=qianmo')
  }
  if (!isValidSegment(node) || isReservedDeviceName(node)) {
    throw new Error('resident --node must be a valid non-reserved segment')
  }
  if (team === undefined) throw new Error('resident --team is required')
  assertTeamName(team)
  if (agents.length === 0)
    throw new Error('resident requires at least one --agent')
  if (new Set(agents.map(agent => agent.agent)).size !== agents.length) {
    throw new Error('resident agent names must be unique')
  }
  // Repeating `--trust` for one node with two *different* keys is refused;
  // repeating it with the same key is not. A node publishes exactly one key,
  // so the second spelling is a contradiction rather than an update, while an
  // exact repeat is just a list assembled from two places that agree.
  //
  // `StaticPublicKeyDirectory` refuses the same thing, and this check is not
  // redundant with it. It names the flag and the count, and it runs before the
  // directory is chosen — under `--trust-ca` these same entries go to
  // `CertificateDirectory`, which would swallow the conflict just as quietly.
  //
  // Left silent the diagnosis points at the wrong file entirely: every check
  // before the signature still passes, so each token that should have worked
  // comes back `capability signature does not verify`, and the search starts
  // in the Ed25519 path instead of in the command line. The acceptance suite
  // lost a round to exactly this, with six red rows to show for it.
  const trustedKeysByNode = new Map<string, Set<string>>()
  for (const [trustedNode, publicKey] of trusted) {
    const keys = trustedKeysByNode.get(trustedNode)
    if (keys === undefined)
      trustedKeysByNode.set(trustedNode, new Set([publicKey]))
    else keys.add(publicKey)
  }
  for (const [trustedNode, keys] of trustedKeysByNode) {
    if (keys.size === 1) continue
    const count = trusted.filter(([name]) => name === trustedNode).length
    throw new Error(
      `--trust was given ${count} times for node ${trustedNode} with` +
        ` ${keys.size} different public keys; a node publishes exactly one` +
        ' key, so keep the right entry and drop the rest',
    )
  }
  if (port !== undefined && unix !== undefined) {
    throw new Error('resident takes either --port or --unix, not both')
  }
  if (port === undefined && unix === undefined) {
    throw new Error('resident requires --port or --unix')
  }
  if (port !== undefined && hostname === undefined) {
    throw new Error('resident TCP listen requires explicit --hostname')
  }
  if (unix !== undefined && hostname !== undefined) {
    throw new Error('--hostname is only valid with --port')
  }
  if (activityReconnectFactor !== undefined && activityUrl === undefined) {
    throw new Error('--activity-reconnect-factor requires --activity-url')
  }
  if (backupIntervalMs !== undefined && backupUrl === undefined) {
    throw new Error('--backup-interval-ms requires --backup-url')
  }
  if (witnessIntervalMs !== undefined && witnessUrl === undefined) {
    throw new Error('--witness-interval-ms requires --witness-url')
  }
  if (memIntervalMs !== undefined && memSample === undefined) {
    throw new Error('--mem-interval-ms requires --mem-sample')
  }
  // A certificate names a public key; a key backs one. Either alone is
  // almost certainly a copy-paste mistake, not a deliberate configuration —
  // same reasoning as pairing `--activity-reconnect-factor` with
  // `--activity-url`.
  if (cert !== undefined && key === undefined) {
    throw new Error('--cert requires --key')
  }
  if (key !== undefined && cert === undefined) {
    throw new Error('--key requires --cert')
  }
  if (registryUrl !== undefined && trustCa === undefined) {
    throw new Error('--registry-url requires --trust-ca')
  }
  if (openPolicy && enforceRequested) {
    // Not resolved by precedence: whichever way it were resolved, half the
    // people who wrote this line would get the opposite of what they meant,
    // and the one they get wrong is a security posture.
    throw new Error(
      'resident takes either --open-policy or --require-signed-tasks, not both',
    )
  }
  return {
    node,
    team,
    agents,
    ...(allowWorkspaceEdits ? { allowWorkspaceEdits } : {}),
    ...(port === undefined ? {} : { port }),
    ...(hostname === undefined ? {} : { hostname }),
    ...(unix === undefined ? {} : { unix }),
    ...(activityUrl === undefined
      ? {}
      : {
          activityUrl,
          activityReconnectFactor:
            activityReconnectFactor ??
            DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
        }),
    ...(timings === undefined ? {} : { timings }),
    ...(memSample === undefined
      ? {}
      : {
          memSample,
          memIntervalMs: memIntervalMs ?? DEFAULT_RESIDENT_MEM_INTERVAL_MS,
        }),
    trusted,
    ...(trustCa === undefined ? {} : { trustCa }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    ...(registryUrl === undefined ? {} : { registryUrl }),
    // `--require-signed-handshake` implies the other: refusing unsigned peers
    // while sending an unsigned frame yourself is a configuration nobody means
    // to write, and it would fail only against the peers that had upgraded.
    ...(signHandshake || requireSignedHandshake ? { signHandshake: true } : {}),
    ...(requireSignedHandshake ? { requireSignedHandshake: true } : {}),
    requireSignedTasks,
    auditSignedTasks,
    // Provenance, not policy: only set when one of the two switches was
    // actually typed. See the field's doc comment.
    ...(enforceRequested || openPolicy ? { taskPolicySelected: true } : {}),
    ...(backupUrl === undefined ? {} : { backupUrl }),
    ...(backupIntervalMs === undefined ? {} : { backupIntervalMs }),
    ...(witnessUrl === undefined ? {} : { witnessUrl }),
    ...(witnessIntervalMs === undefined ? {} : { witnessIntervalMs }),
  }
}

export function assertResidentRuntime(
  bunAvailable: boolean = typeof Bun !== 'undefined',
): void {
  if (!bunAvailable) {
    throw new Error('resident mode requires the Bun runtime')
  }
}

/**
 * Open this process's config gate (issue #37 ①, follow-up).
 *
 * `qm resident` is one of the **fast paths** in `entrypoints/cli.tsx`: it is
 * dispatched before `main.tsx` bootstraps anything, so unlike an ordinary
 * subcommand it never passes the `enableConfigs()` the rest of the CLI relies
 * on. Every read of a config file therefore threw `Config accessed before
 * allowed.` — and because this handler's two startup credential checks are the
 * only things here that read one, and both of them catch, the whole credential
 * diagnosis layer was dead code in the shipped binary while every unit test
 * stayed green (they inject their inputs and never reach these calls).
 *
 * Why here rather than in the dispatch table next to the seven sibling
 * branches that each call `enableConfigs()` inline: this is a property of the
 * handler, not of the layer. None of the other `qm` subcommands (`audit`,
 * `console`, `resident-wake`, `ca`, `cert`, `watch`) touches config or auth at
 * all, and the comment on the `--daemon-worker` fast path in that same file
 * states the rule this follows — that layer stays lean, and "if a worker kind
 * needs configs/auth … it calls them inside its run() fn". `cli/handlers/
 * import.ts` already does exactly this, for the same reason.
 *
 * Never fatal. `enableConfigs()` validates the global config file and throws on
 * a corrupt one; taking a node down over that would make a *diagnostic* into an
 * admission decision, which is the rule this file follows everywhere else. A
 * node that comes up without the gate open still works — it simply cannot check
 * its own credential, and {@link warnUnavailableModelCredentialProbe} then says
 * so instead of leaving `<node>.err` empty.
 */
async function enableResidentConfigAccess(
  warn: (message: string) => void = message => {
    process.stderr.write(`${message}\n`)
  },
): Promise<boolean> {
  try {
    const { enableConfigs } = await import('../../utils/config/config.js')
    enableConfigs()
    return true
  } catch (error) {
    warn(
      `[resident] could not open this node's config store: ${formatResidentError(error)}\n` +
        '[resident] startup continues, but this node cannot read its own stored login, so the ' +
        'credential checks below are answering from the environment alone and may be wrong. ' +
        "The global config file under this node's OCC_CONFIG_DIR is where to look.",
    )
    return false
  }
}

/**
 * `--help` / `-h` 出现在任何位置都算请求帮助。
 *
 * 位置不限，是因为「敲到一半发现忘了选项名」正是人会做的事：
 * `qm resident --port 7321 --help` 必须答帮助，而不是先解析出一个配置再抛。
 * 判定用**全等**，所以 `--team=--help` 这种把它当值的写法不会被当成请求。
 *
 * 为什么不落回 commander：`resident` 的子命令注册
 * （`cli/program/commands/qianmo.tsx`）**刻意不复制选项表**（那个文件的顶部注释
 * 写着这条），落回去只会打印一行描述加一个空的选项列表。选项的唯一出处是本文件
 * 的解析器，帮助文本因此也在这里——两份会漂移的选项表比一份不好看的要糟得多。
 */
export function isResidentHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

/**
 * `occ resident --help` 打印的全文。
 *
 * 常驻节点没有一份对应的选项表文档（`console.md` §3 只管控制台），所以这里是
 * 内测用户手上**唯一**的自助入口：凡是不看源码就会配错的事——三组互斥/依赖关系
 * （`--port` 与 `--unix`、`--hostname` 只跟 `--port`、三个 `*-ms` 各自依赖谁）、
 * 路径必须绝对、以及两枚密钥只走环境变量——都必须在这里说全。
 *
 * 默认值一律插值，不抄数字：它们的出处是各自的常量（CLAUDE.md §1.1⑧）。
 */
export const RESIDENT_HELP_TEXT = `Usage: ${invokedBinName()} resident [options]

Run a Qianmo resident agent node: an inbound-only endpoint that accepts wake
and task messages over the transport and runs them in its agents' workspaces.
Requires OCC_IDENTITY=qianmo, the Bun runtime, and a transport key in
$${PSK_ENV_VAR}.

Options (each accepts both --name value and --name=value):

Identity and workspaces, all required:

  --node <segment>         This node's name, one address segment; it becomes
                           the <node> half of qianmo://<node>/<agent>.
                           Reserved device names are refused.
  --team <name>            The team this node belongs to.
  --agent <name>=<abs cwd>
                           An agent this node serves and the absolute working
                           directory it runs in. Repeatable, one agent per
                           flag; at least one is required and two agents may
                           not share a name.

Listener, exactly one of --port and --unix:

  --port <0-65535>         Listen on TCP. Requires --hostname; 0 lets the
                           kernel pick the port.
  --unix <abs path>        Listen on a Unix socket instead of TCP.
  --hostname <host>        Address to bind, only valid with --port. Never
                           guessed: which interface a node answers on has to
                           be an explicit choice.

Authorization:

  --trust <node>=<publicKey>
                           Accept capability tokens issued by <node>, and
                           treat what they authorize as authorized here.
                           Repeatable, one peer per flag. There is no
                           trust-on-first-use, so an issuer never named here
                           is refused. This node's own key is always trusted,
                           and its public half is the first line this command
                           prints. Still works with --trust-ca given (§8.2
                           phase ①) and always wins on conflict.
                           Naming an issuer here is what lets a message it
                           signed reach the agent labelled as authorized work
                           rather than as untrusted relayed text (issue #28,
                           key-distribution.md §10.5). --trust-ca is
                           deliberately not a second source for that: a CA
                           says who a subject is, not that this operator
                           authorized it to direct this node.
  --trust-ca <abs path>    PEM root certificate of the offline CA
                           (key-distribution.md §5.1, produced by
                           \`${invokedBinName()} ca init\`). Peer keys are then
                           resolved through a certificate directory instead
                           of only --trust: a certificate not issued by a
                           root in this file, expired, or on the revocation
                           list is refused for that peer. An RL that has never
                           been fetched or has gone stale degrades to exactly
                           the --trust entries above, not to full-open or a
                           dead node (§6.4).
                           During a root rotation the file holds the old and
                           the new root one after another (§3.3); both are
                           used, for peer certificates and for TLS alike.
                           Anything in the file that is not a well-formed
                           self-signed Ed25519 root refuses startup.
  --cert <abs path>        This node's own certificate. Checked at startup
                           against this node's own identity key — a
                           certificate naming a different node or a
                           different key is refused before the node ever
                           opens a listener (K-2). Requires --key.
  --key <abs path>         This node's own TLS private key
                           (\`${invokedBinName()} cert request\` writes one).
                           Requires --cert.
                           With --cert, --key and --trust-ca all present and
                           a TCP listener, mTLS is switched on: the three TLS
                           settings that only work together are applied
                           together (F-10). Missing any of the three, this
                           listener serves plaintext ws:// and says so on
                           stderr rather than looking configured.
  --registry-url <url>     Base URL of the registry's HTTP v0 API, polled
                           every ${DEFAULT_REGISTRY_POLL_INTERVAL_MS / 60_000} minutes for peer certificates and the
                           revocation list. Requires --trust-ca: without a
                           root there is nothing to check a published
                           certificate against. Without this flag the
                           certificate directory has no network source and
                           answers from --trust alone.
  --sign-handshake         Sign this node's half of every handshake with its
                           Ed25519 identity, and check a peer's when it signs
                           one (§7.1.1: both directions, so a redirected
                           endpoint cannot answer for the node it redirected).
                           Peers that do not sign still connect on the
                           pre-shared key — that coexistence is what lets a
                           fleet be upgraded one node at a time.
  --require-signed-handshake
                           Refuse peers that do not sign. Implies
                           --sign-handshake. This is the switch that retires
                           the pre-shared key on this node, and there is no
                           other; turn it on only once every peer signs.
  --require-signed-tasks   Refuse task requests that present no capability
                           token. This is the default; the flag restates it
                           and is kept because existing command lines carry
                           it. Naming neither this nor --open-policy is
                           allowed but warned about once on stderr: the
                           default has moved before, so a command line that
                           states no policy has a security posture that
                           changes with the build date.
  --open-policy            Admit task requests that present no capability
                           token — the escape hatch out of the default
                           (key-distribution.md §9.3). Rolling back costs
                           nothing beyond the posture: a token that IS
                           presented is verified in full either way, so no
                           signed message changes its fate in either
                           direction. Cannot be combined with
                           --require-signed-tasks.
  --allow-workspace-edits  Let a turn edit files inside its own working
                           directory without asking. Off by default, and the
                           default is the reason this flag exists: an
                           unattended turn runs with permissionMode dontAsk —
                           don't prompt, deny if not pre-approved — and this
                           node answers every permission request as
                           cancelled, so without this an agent cannot
                           create a file in its own workspace. What it
                           relaxes is only edits under the working directory
                           (config files and sensitive paths stay blocked,
                           and this node's own hardline list is checked
                           first). Everything else that needs authorization
                           is still refused. Settings-file allow rules are
                           NOT an alternative — an ACP session builds an
                           empty permission context, so they never reach it.
  --audit-signed-tasks     Observation mode: record every message that
                           --require-signed-tasks would have refused, and
                           refuse nothing. Nothing about what this node
                           accepts changes; what appears is one audit line
                           per message, so "what would enforcing cost" is a
                           number before it is an outage. A no-op when
                           --require-signed-tasks is already in force, since
                           the two policies then agree on everything.

Backup:

  --backup-url <url>       Base URL of the host-side backup service, http or
                           https. Also requires $${BACKUP_TOKEN_ENV_VAR}.
  --backup-interval-ms <ms>
                           Gap between scheduled workspace snapshots, an
                           integer >= 1000. Requires --backup-url.
                           Default ${DEFAULT_SNAPSHOT_INTERVAL_MS}.

Audit witness:

  --witness-url <url>      Base URL of the append-only witness endpoint, http
                           or https. Also requires $${WITNESS_TOKEN_ENV_VAR}.
  --witness-interval-ms <ms>
                           Gap between signed audit anchors, an integer >=
                           1000. Requires --witness-url. Default
                           ${DEFAULT_WITNESS_ANCHOR_INTERVAL_MS}.

Activity reporting:

  --activity-url <ws url>  Report this node's idle and active spells to a
                           watcher over ws or wss.
  --activity-reconnect-factor <number>
                           Reconnect backoff growth factor, greater than 1.
                           Requires --activity-url.
                           Default ${DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR}.

Measurement:

  --timings <abs path>     Append per-message timings to an NDJSON file.
  --mem-sample <abs path>  Append heap and RSS samples to an NDJSON file.
  --mem-interval-ms <ms>   Sampling gap, an integer >= 1000.
                           Requires --mem-sample.
                           Default ${DEFAULT_RESIDENT_MEM_INTERVAL_MS}.

  -h, --help               Print this and exit.

Every path above must be absolute. A resident node outlives the shell that
started it, so a relative path means something different to whoever restarts
it from another directory.

Environment:

  OCC_IDENTITY             Must be "qianmo". A resident node is part of the
                           Qianmo node identity, it does not run under plain
                           occ.
  ${PSK_ENV_VAR}     Transport pre-shared key, required — still, even
                           with --require-signed-handshake, because this node
                           also dials out. Environment only, never a
                           command-line option: a key on a command line is a
                           key in every process listing on this machine.
  ${BACKUP_TOKEN_ENV_VAR}
                           Write-only backup credential, required whenever
                           --backup-url is given. Environment only, for the
                           same reason.
  ${WITNESS_TOKEN_ENV_VAR}
                           Write-only witness credential, required whenever
                           --witness-url is given. Environment only: it may
                           add evidence but must never appear in a process
                           listing.
  OCC_CONFIG_DIR           Config root the node identity, the audit trail and
                           the session table are derived from.
`

/**
 * Both directory implementations this command can build are mutable in the
 * same way `--trust`'s "this node's own key is always trusted" line needs
 * (`directory.put(config.node, keys.publicKey)` below) — a small local
 * interface rather than importing `StaticPublicKeyDirectory`'s and
 * `CertificateDirectory`'s concrete types side by side at every call site.
 */
interface MutablePublicKeyDirectory extends PublicKeyDirectory {
  put(node: string, publicKey: string): void
}

/**
 * `--trust-ca` replaces `StaticPublicKeyDirectory` with a
 * `CertificateDirectory`; `--trust` entries are handed to either one the same
 * way and, per §8.2 phase ①, always win on conflict with a CA-derived key —
 * `CertificateDirectory` enforces that itself, so there is nothing extra to
 * do here for that *precedence* half of the coexistence rule.
 *
 * The other half is the sink: §8.2 says the conflict is recorded, "不是静默
 * 覆盖". `onAudit` is where that lands, and it is optional here only because
 * the two static callers that build a directory to inspect it (tests) have no
 * trail to write to — the running node always passes one.
 */
export function buildPublicKeyDirectory(
  config: ResidentCliConfig,
  onAudit?: CertificateDirectoryAuditSink,
  onError?: CertificateDirectoryErrorSink,
): MutablePublicKeyDirectory {
  if (config.trustCa === undefined) {
    return new StaticPublicKeyDirectory(config.trusted)
  }
  return new CertificateDirectory({
    // The parsed-and-reserialized roots, not the raw file: the same bytes
    // `buildListenerTls` hands the TLS layer, so the two cannot disagree.
    caCertificatePem: readTrustAnchors(config.trustCa).pem,
    trusted: config.trusted,
    ...(config.registryUrl === undefined
      ? {}
      : { registryUrl: config.registryUrl }),
    ...(onAudit === undefined ? {} : { onAudit }),
    ...(onError === undefined ? {} : { onError }),
  })
}

/**
 * The subjects whose capability tokens this node treats as *authorization*
 * and not merely as *identification* (issue #28).
 *
 * Two sources, and both are a human writing a name down:
 *
 * - **every `--trust <node>=<publicKey>` entry.** That flag is already the
 *   statement "capabilities signed by this subject are honoured here": under
 *   the enforcing default, a peer named there can mint itself a
 *   `write-limited` token for any task and this node will run the work. The
 *   tier does not widen that — it only stops the notice from telling the agent
 *   the opposite of what the gate just decided.
 * - **this node's own name.** Rule S-1 accepts `user-confirmed` only from this
 *   node's own key, so leaving itself out would make the *strongest* level the
 *   one level that could never be trusted.
 *
 * **`--trust-ca` is deliberately not a source.** A CA answers "is this subject
 * who it says it is", which every subject it ever signed passes; this list
 * answers "did this operator authorize that subject to direct this node's
 * agent", which is not a question a CA was ever asked. Under `--trust-ca`
 * alone the tier therefore stays `untrusted` — fail-closed, and a real gap
 * once `--trust` retires (key-distribution.md §8.3). It is recorded there
 * rather than closed here by widening the list, because widening it would make
 * every CA-signed identity on the network an authority over every node.
 */
export function residentTrustedIssuers(
  config: ResidentCliConfig,
): readonly string[] {
  return [...config.trusted.map(([node]) => node), config.node]
}

/**
 * Build the resident's real capability gate from its parsed policy switches.
 *
 * `NodeCapabilities` intentionally defaults to the enforcing policy. The
 * resident must therefore always pass its selected policy, including the
 * explicit `--open-policy` escape hatch.
 */
export function createResidentCapabilities(
  config: ResidentCliConfig,
  directory: PublicKeyDirectory,
  keys: NodeKeyPair,
  onShadowRefusal: ShadowRefusalSink,
): NodeCapabilities {
  if (config.auditSignedTasks && onShadowRefusal === undefined) {
    throw new Error('--audit-signed-tasks requires a shadow refusal sink')
  }

  return new NodeCapabilities({
    node: config.node,
    directory,
    keys,
    policy: config.requireSignedTasks ? SIGNED_TASK_POLICY : OPEN_POLICY,
    trustedIssuers: residentTrustedIssuers(config),
    // §9.2 phase ①. Both halves or neither — this factory refuses the
    // half-configuration, and it is the only place that supplies them.
    ...(config.auditSignedTasks
      ? {
          shadowPolicy: SIGNED_TASK_POLICY,
          onShadowRefusal,
        }
      : {}),
  })
}

/**
 * Say, once at startup, that nobody chose this node's task policy.
 *
 * The startup banner already carries `requireSignedTasks` as a boolean, and
 * that turned out not to be enough: on the beta fleet the banner line sat in
 * `<node>.out` for four days without being read, while the four nodes were in
 * open policy purely because they were running a build from before P12.4
 * flipped the default. Their argv named neither switch, so the next routine
 * deploy would have silently started refusing every task request — and the
 * failure would have surfaced at first real use, looking like a broken
 * feature rather than a changed posture.
 *
 * Two things this deliberately is not:
 *
 * - **Not a warning about the enforcing policy itself.** Enforcing is the
 *   right default. What is worth a line on stderr is that the choice was
 *   made by a default whose value has already moved once.
 * - **Not printed when either switch was given.** A command line that says
 *   `--open-policy` (the beta fleet's `beta-up.sh`) or `--require-signed-tasks`
 *   has made the choice; warning there is the noise that gets warnings
 *   ignored.
 *
 * stderr rather than stdout on purpose: the banner owns stdout, and on these
 * nodes `<node>.err` is normally zero bytes, so anything in it stands out.
 */
export function warnUnselectedTaskPolicy(
  config: ResidentCliConfig,
  warn: (message: string) => void = message => {
    process.stderr.write(`${message}\n`)
  },
): void {
  if (config.taskPolicySelected === true) return
  const selected = config.requireSignedTasks
    ? '--require-signed-tasks (task requests and wakes must present a capability token)'
    : '--open-policy (unsigned task requests and wakes are admitted)'
  warn(
    `[resident] no task policy was given on the command line; this node took the built-in default: ${selected}. ` +
      'That default has moved before (P12.4 flipped it), so a command line naming neither switch ' +
      'lets a routine redeploy change this node security posture. ' +
      'Pass --open-policy or --require-signed-tasks to state the choice.',
  )
  if (
    config.requireSignedTasks &&
    config.trusted.length === 0 &&
    config.trustCa === undefined
  ) {
    warn(
      '[resident] and no peer is trusted yet (no --trust, no --trust-ca): under the enforcing default ' +
        'every inbound task.request and wake from a peer is refused — unsigned for lack of a token, ' +
        'signed for an unknown issuer (there is no trust-on-first-use).',
    )
  }
}

/**
 * The credential probe, loaded on first use.
 *
 * `require` on purpose, not a static import. This handler currently reaches
 * nothing in `src/utils/auth` / `src/utils/settings` / `src/utils/config`, and
 * `auth.ts` sits on top of all three (plus the keychain and axios) — a static
 * edge would put that whole subgraph into the module graph the `check:cycles`
 * ratchet measures, for one boolean read once at startup. The runtime cost is
 * identical either way, since the answer is needed immediately. Typed
 * structurally so not even a type-only import is required. Same technique, and
 * the same reason, as `services/search/sourceCredentials.ts`.
 */
type ModelCredentialProbe = {
  hasAnyModelCredential: () => boolean
}

let modelCredentialProbe: ModelCredentialProbe | undefined

function loadModelCredentialProbe(): ModelCredentialProbe {
  if (!modelCredentialProbe) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    modelCredentialProbe =
      require('../../utils/auth/auth.js') as ModelCredentialProbe
  }
  return modelCredentialProbe
}

/**
 * Whether this node can reach a model at all.
 *
 * Delegates to the credential-axis rule in `auth.ts` — the same one
 * `occ auth status` reports as `loggedIn` — rather than enumerating provider
 * environment variables here. A second, private list of credential keys is how
 * the node's answer and `auth status`'s answer start disagreeing, and the one
 * that disagrees is always the one nobody runs.
 *
 * Failure to answer is treated as "no credential": the auth stack throws only
 * from the CI / `NODE_ENV=test` branch, and only when nothing is configured.
 */
export function nodeHasModelCredential(): boolean {
  try {
    return loadModelCredentialProbe().hasAnyModelCredential()
  } catch {
    return false
  }
}

/**
 * Say, once at startup, that no model credential is visible to this node.
 *
 * The failure this replaces took a live wake and a transcript read to see. On
 * the beta fleet every layer reported success — envelope delivered,
 * `receipt: "accepted"`, a `message_accepted` link appended to the audit
 * chain, an ACP child spawned, a real agent turn opened — and then the
 * assistant turn was `model: "<synthetic>"`, `error: "authentication_failed"`,
 * usage all zero, body "Not logged in · Please run /login". The node had been
 * up for five days in that state (issue #13). Nothing on the node said so,
 * because nothing on the node had asked.
 *
 * Timing is the whole point of doing this at startup rather than at first use:
 * the ACP child inherits this process's environment (`defaultSpawnAcp` passes
 * `{...process.env}`), so the credential must already be here *before* the
 * resident starts. A login performed afterwards in another shell never reaches
 * the child, and no later checkpoint could tell the operator anything they
 * could still act on without a restart.
 *
 * Deliberately not printed when a credential of any kind is present — not even
 * a "credential looks fine" line. This node's other startup warning
 * ({@link warnUnselectedTaskPolicy}) earns attention by being rare, and a
 * warning that also fires on healthy nodes trains people to skip both.
 *
 * stderr rather than stdout, for the same reason as the task-policy warning:
 * the banner owns stdout, and `<node>.err` is normally zero bytes.
 */
export function warnMissingModelCredentials(
  hasCredential: boolean = nodeHasModelCredential(),
  warn: (message: string) => void = message => {
    process.stderr.write(`${message}\n`)
  },
): void {
  if (hasCredential) return
  warn(
    '[resident] no model credential is visible to this node: no CLAUDE_CODE_USE_* provider selection, ' +
      'no ANTHROPIC_API_KEY, no auth token, and no stored login under this OCC_CONFIG_DIR. ' +
      'Every agent turn woken here will come back "Not logged in · Please run /login" ' +
      '(authentication_failed, zero usage) after the delivery, the receipt and the audit link all report success. ' +
      'The ACP child inherits this process environment, so the credential has to be in place before the resident ' +
      'starts — logging in elsewhere afterwards does not reach it. ' +
      `Run \`${invokedBinName()} auth status\` with this node OCC_CONFIG_DIR for the same answer in detail.`,
  )
}

/**
 * The live inputs the startup liveness probe needs, loaded on first use.
 *
 * Same `require` technique and the same reason as
 * {@link loadModelCredentialProbe} above: `providers.ts`, `model.ts` and
 * `network/http.ts` sit on top of the settings/auth/config subgraph, and a
 * static edge would drag all of it into the graph the `check:cycles` ratchet
 * measures for three reads performed once at startup.
 */
type ModelProbeEnvironment = {
  getAPIProvider: () => string
  getSmallFastModel: () => string
  getAuthHeaders: () => { headers: Record<string, string>; error?: string }
}

let modelProbeEnvironment: ModelProbeEnvironment | undefined

function loadModelProbeEnvironment(): ModelProbeEnvironment {
  if (!modelProbeEnvironment) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const providers = require('../../utils/model/providers.js') as Pick<
      ModelProbeEnvironment,
      'getAPIProvider'
    >
    const model = require('../../utils/model/model.js') as Pick<
      ModelProbeEnvironment,
      'getSmallFastModel'
    >
    const http = require('../../utils/network/http.js') as Pick<
      ModelProbeEnvironment,
      'getAuthHeaders'
    >
    /* eslint-enable @typescript-eslint/no-require-imports */
    modelProbeEnvironment = {
      getAPIProvider: providers.getAPIProvider,
      getSmallFastModel: model.getSmallFastModel,
      getAuthHeaders: http.getAuthHeaders,
    }
  }
  return modelProbeEnvironment
}

/**
 * Read this process's provider / model / auth-header resolution, once.
 *
 * Provider and model are read eagerly because every lane needs both. The auth
 * headers are **not**: they are handed over as a thunk so that only a node
 * actually speaking the Anthropic wire pays for the Anthropic credential
 * stack. See the field's own comment in `residentModelProbe.ts` for the
 * failure that shape prevents.
 */
export function residentModelProbeInputs(
  environment: ModelProbeEnvironment = loadModelProbeEnvironment(),
): ResidentModelProbeInputs {
  return {
    provider: environment.getAPIProvider(),
    model: environment.getSmallFastModel(),
    env: process.env,
    anthropicAuthHeaders: () => {
      const auth = environment.getAuthHeaders()
      return auth.error === undefined ? auth.headers : {}
    },
  }
}

/**
 * Ask this node's model endpoint whether the credential it was started with is
 * actually accepted, and say so on stderr when it is not (issue #37 ①).
 *
 * Runs **beside** startup rather than in front of it. The verdict is a
 * diagnosis, not an admission decision — a node whose endpoint is momentarily
 * unreachable must still come up and take work — so nothing here blocks the
 * listener, and the caller does not await it. The probe carries its own
 * timeout for the same reason.
 *
 * Skipped when no credential is visible at all: {@link
 * warnMissingModelCredentials} has already said so in more useful words, and
 * two warnings about one fault teach people to read neither.
 *
 * `environment` exists for one test and says so: the only step here that
 * touches the live process is {@link residentModelProbeInputs}, and it is the
 * step that threw on every real node in the first shipped version. Injecting a
 * throwing one is the only way to exercise the catch below without breaking
 * the process the test runs in.
 */
export async function runResidentModelCredentialProbe(
  options: {
    readonly hasCredential?: boolean
    readonly inputs?: ResidentModelProbeInputs
    readonly environment?: ModelProbeEnvironment
    readonly fetchImpl?: typeof fetch
    readonly timeoutMs?: number
    readonly warn?: (message: string) => void
  } = {},
): Promise<ResidentModelProbeVerdict> {
  try {
    const hasCredential = options.hasCredential ?? nodeHasModelCredential()
    if (!hasCredential) {
      return { status: 'skipped', detail: 'no model credential is visible' }
    }
    const target = resolveResidentModelProbeTarget(
      options.inputs ?? residentModelProbeInputs(options.environment),
    )
    if ('status' in target) return target
    const verdict = await probeResidentModel(target, {
      ...(options.fetchImpl === undefined
        ? {}
        : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    })
    warnRefusedModelCredentials(
      verdict,
      ...(options.warn === undefined ? [] : ([options.warn] as const)),
    )
    return verdict
  } catch (error) {
    // A probe that cannot even be built is not a fault of the node — but it is
    // a fault, and it used to be reported as `skipped` on the theory that "a
    // caller can still see it". No caller ever looked, so for the whole of
    // PR #50's life this branch was where the check went to die quietly: every
    // real node threw here, and `<node>.err` stayed at zero bytes. It now has
    // its own status and prints one line, because a diagnostic that fails
    // silently is worth strictly less than no diagnostic at all — it also
    // convinces the operator the question was asked and answered.
    const verdict = {
      status: 'unavailable',
      detail: error instanceof Error ? error.message : String(error),
    } as const
    warnUnavailableModelCredentialProbe(
      verdict,
      ...(options.warn === undefined ? [] : ([options.warn] as const)),
    )
    return verdict
  }
}

/**
 * A rendered {@link Bun.inspect} line longer than this cannot be a normal
 * source line under this repo's own Biome width limits (80/120 columns,
 * see `CLAUDE.md`); it is what a bundled `dist/chunks/*.js` line looks like
 * — the whole minified chunk squashed onto "line 1". 400 leaves comfortable
 * headroom above both column caps while sitting far below any real chunk
 * (#30's repro line was >1KB).
 */
const RESIDENT_ERROR_MAX_LINE_LENGTH = 400

/** Hard cap on the fallback rendering, in case a non-`Error` throw itself
 * carries a huge payload (e.g. a giant string) — belt and suspenders past
 * the line-length gate below, which only looks at *line* length. */
const RESIDENT_ERROR_MAX_TOTAL_LENGTH = 2000

function hasOversizedLine(text: string): boolean {
  return text
    .split('\n')
    .some(line => line.length > RESIDENT_ERROR_MAX_LINE_LENGTH)
}

/**
 * Format an error for this node's stderr, the way `console.error('[resident
 * …]', error)` would — minus the one thing that broke `<node>.err`'s "zero
 * bytes means nothing happened" property (#30).
 *
 * `console.error`/`Bun.inspect` on an `Error` value do not just print the
 * message and stack: Bun renders a source "code frame" too — the offending
 * line(s) plus a `^` caret — read straight off disk at the throw site. That
 * is genuinely useful in `bun run dev` (unbundled TS, ordinary short lines).
 * It is actively harmful against what this binary actually ships: a
 * `dist/chunks/*.js` file is minified onto one line per chunk, so the
 * "source line" becomes upwards of a kilobyte of unreadable chunk source
 * glued in front of the real error.
 *
 * There is no flag to ask Bun for the frame conditionally, and the frame is
 * not derived from `error.stack` — confirmed by inspection: `error.stack`
 * never contains it, only `console.error`/`Bun.inspect`'s own rendering
 * does. So the judge is not "dev vs. built", which we cannot always tell
 * from here — it is the frame's own rendered width: let Bun render the frame as
 * it always has, and only fall back to a frame-free rendering (the message
 * plus stack, which is where `error.stack` already lives) when that render
 * actually produced a line too long to be real source. Ordinary short
 * source lines — dev mode's case — pass through byte-for-byte untouched.
 */
export function formatResidentError(error: unknown): string {
  const rendered = Bun.inspect(error)
  if (!hasOversizedLine(rendered)) return rendered
  const fallback =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : String(error)
  if (!hasOversizedLine(fallback)) return fallback
  return `${fallback.slice(0, RESIDENT_ERROR_MAX_TOTAL_LENGTH)}…`
}

/**
 * `--cert`/`--key` startup self-check (K-2, one of the DoD's four negative
 * cases), run before this node opens a listener.
 *
 * Three separate questions, and each of them fails in a way that would
 * otherwise surface as somebody else's outage days later: does the
 * certificate name this node's own identity key, was it signed by the CA this
 * node trusts, and is the key an EC one Bun will actually accept.
 */
export function assertOwnCertificateAndKey(
  config: ResidentCliConfig,
  ownPublicKey: string,
): void {
  let certificate: X509Certificate | undefined
  if (config.cert !== undefined) {
    const certificatePem = readFileSync(config.cert, 'utf8')
    assertOwnCertificateMatchesIdentity(
      certificatePem,
      config.node,
      ownPublicKey,
    )
    certificate = new X509Certificate(certificatePem)
    if (config.trustCa !== undefined) {
      // The check `CertificateDirectory` performs on every *peer* (F-2),
      // turned on this node's own file. A certificate from a CA this node
      // does not trust is not a subtle misconfiguration — the node would
      // present it happily and every peer would refuse it — but without this
      // it survives until the first handshake, which is the worst place to
      // find out. Any root in the file will do: during a rotation overlap
      // this node's certificate may still be the old root's (§3.3).
      if (
        anchoredValidity(readTrustAnchors(config.trustCa), certificate) === null
      ) {
        // The leading phrase is unchanged from the single-root days: the
        // acceptance scenario matches on it, including against older builds.
        throw new Error(
          '--cert was not signed by the CA in --trust-ca: no root in that ' +
            'file issued it (key-distribution.md F-2); check that the two ' +
            'files belong to the same CA generation',
        )
      }
    }
  }
  if (config.key !== undefined) {
    let privateKey: ReturnType<typeof createPrivateKey>
    try {
      privateKey = createPrivateKey(readFileSync(config.key, 'utf8'))
    } catch (error) {
      throw new Error(
        `--key does not parse as a private key: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (privateKey.asymmetricKeyType !== 'ec') {
      // F-5: Bun refuses an Ed25519 TLS leaf outright, so the node's own key
      // must be EC — same constraint `qm ca issue` enforces on the CSR.
      throw new Error(
        `--key must be an EC private key (F-5); this one is ${String(privateKey.asymmetricKeyType)}`,
      )
    }
    if (certificate !== undefined) {
      const privateSpki = createPublicKey(privateKey).export({
        type: 'spki',
        format: 'der',
      })
      const certificateSpki = certificate.publicKey.export({
        type: 'spki',
        format: 'der',
      })
      if (!Buffer.from(privateSpki).equals(Buffer.from(certificateSpki))) {
        throw new Error(
          '--cert and --key do not form a matching public/private key pair; ' +
            'refusing to open a listener with a certificate another key cannot prove',
        )
      }
    }
  }
}

/**
 * L0 materials for this node's listener, or `null` with a printed reason.
 *
 * All three files or none: `mutualTlsServerOptions` is what makes
 * `requestCert`/`rejectUnauthorized` inseparable from `ca` (F-10), and this
 * function is what makes the *files* inseparable from each other. The reason
 * is printed rather than swallowed because the failure it prevents is a node
 * that came up looking configured and is serving plaintext — the operator has
 * to be told which file is missing, on the machine where it is missing.
 */
export function buildListenerTls(
  config: ResidentCliConfig,
  warn: (message: string) => void = message => {
    process.stderr.write(`${message}\n`)
  },
): { readonly tls: TLSOptions; readonly certificateNotAfter: number } | null {
  if (config.cert === undefined || config.key === undefined) return null
  if (config.unix !== undefined) {
    // Not an error: a unix-socket node has legitimate uses for a certificate
    // (it is how the registry publishes its Ed25519 key), and the file
    // permissions on the socket are the boundary TLS would have been.
    warn(
      '[resident] --cert/--key are not used for TLS on a unix socket; the ' +
        'certificate is still checked against this node identity',
    )
    return null
  }
  if (config.trustCa === undefined) {
    warn(
      '[resident] --cert/--key given without --trust-ca: mTLS is NOT enabled ' +
        '(the CA root is one of the three settings that only work together, ' +
        'key-distribution.md F-10). This listener is serving plaintext ws://',
    )
    return null
  }
  const certificatePem = readFileSync(config.cert, 'utf8')
  return {
    tls: mutualTlsServerOptions({
      cert: certificatePem,
      key: readFileSync(config.key, 'utf8'),
      // Every root the file holds, as parsed — a malformed block refuses
      // startup here rather than being skipped by the TLS stack (§3.3).
      ca: readTrustAnchors(config.trustCa).pem,
    }),
    // Read off the certificate rather than configured separately: two places
    // to say when a certificate expires is two places that can disagree, and
    // the one that would be wrong is the one nobody looks at (§6.3).
    certificateNotAfter: Date.parse(
      new X509Certificate(certificatePem).validTo,
    ),
  }
}

/**
 * L1 material for this node's listener (§7.1 / §7.1.1), or `undefined` when
 * `--sign-handshake` was not given.
 *
 * The directory is the one the capability gate already reads — deliberately
 * the same object, not a second copy. A node that would accept a token from a
 * peer but not that peer's handshake (or the reverse) has two answers to one
 * question, and the failure shows up as "some peers work and some do not"
 * with nothing in either log naming the difference.
 */
export function buildHandshakeSigning(
  config: ResidentCliConfig,
  keys: NodeKeyPair,
  directory: PublicKeyDirectory,
): ListenerIdentity | undefined {
  if (config.signHandshake !== true) return undefined
  const credential =
    directory instanceof CertificateDirectory && config.cert !== undefined
      ? (() => {
          const id = new X509Certificate(readFileSync(config.cert, 'utf8'))
            .fingerprint256
          return {
            selector: id,
            source: CERTIFICATE_CREDENTIAL_SOURCE,
            id,
          }
        })()
      : undefined
  return {
    node: config.node,
    keys,
    directory,
    ...(credential === undefined ? {} : { credential }),
    ...(config.requireSignedHandshake === true ? { required: true } : {}),
    ...(config.requireSignedHandshake === true &&
    directory instanceof CertificateDirectory
      ? { credentialProofRequired: true }
      : {}),
  }
}

/**
 * The stdout line saying how the previous life on this config root ended
 * (design §3.B2, roadmap P13.5): `killed`, `clean` or `unknown`.
 *
 * A line of its own after the banner, not a field of it. The banner goes out
 * before the node is even constructed, and the verdict only exists once
 * `run()` has read the lifecycle sentinel — a read that must stay the first
 * thing `run()` does, because stamping this life first erases the evidence.
 * Holding the banner back until then would move it behind the startup
 * warnings, and drop it entirely whenever construction throws.
 *
 * stdout rather than stderr, for the reason `onPriorLife` is not `onError`:
 * a node that was killed last time is not failing now. `<node>.err` is kept
 * empty on a healthy node so that anything in it stands out, and a line on
 * every start would end that.
 *
 * `killed` carries the previous life's `pid`, `startedAt` and `updatedAt`
 * verbatim from the sentinel record: the pid is what `dmesg` or journald are
 * searched by, and `updatedAt` is the last time that life stamped itself
 * alive. No cause is named — the sentinel cannot tell OOM from `kill -9` from
 * a power loss. The line never names `publicKey` or `sourceCommit`: both are
 * grepped out of `<node>.out` by the demo and fleet scripts.
 */
export function residentPriorLifeLine(
  node: string,
  prior: ResidentPriorLife,
): string {
  const record = prior.outcome === 'killed' ? prior.record : undefined
  return JSON.stringify({
    node,
    priorLife: prior.outcome,
    ...(record === undefined
      ? {}
      : {
          prior: {
            pid: record.pid,
            startedAt: record.startedAt,
            updatedAt: record.updatedAt,
          },
        }),
  })
}

export async function runResident(args: readonly string[]): Promise<void> {
  // 帮助排在最前面，**在身份校验与运行时断言之前**：问「这个命令怎么用」的人
  // 恰恰是还没把 `OCC_IDENTITY=qianmo` 和 PSK 配对的那个人，让他先撞一条错误
  // 再去查源码是把唯一的自助入口挡在门外。
  if (isResidentHelpRequest(args)) {
    process.stdout.write(RESIDENT_HELP_TEXT)
    return
  }
  assertResidentRuntime()
  // Before anything reads a credential — see the function's own comment for why
  // this is the handler's job and not the dispatch table's.
  await enableResidentConfigAccess()
  const config = parseResidentArgs(args)
  const psk = pskFromEnv()
  const activity =
    config.activityUrl === undefined
      ? null
      : new ResidentActivityReporter({
          node: config.node,
          endpoint: { url: config.activityUrl },
          psk,
          ...(config.activityReconnectFactor === undefined
            ? {}
            : {
                reconnectTimeJumpFactor: config.activityReconnectFactor,
              }),
        })
  if (activity !== null) {
    void activity.connect().catch(error => {
      process.stderr.write(
        `[resident activity] ${formatResidentError(error)}\n`,
      )
    })
  }
  let timingWriteFailed = false
  const reportTimingError = (error: unknown): void => {
    if (timingWriteFailed) return
    timingWriteFailed = true
    process.stderr.write(`[resident timing] ${formatResidentError(error)}\n`)
  }
  const timingWriter =
    config.timings === undefined
      ? null
      : createResidentTimingWriter(config.timings, reportTimingError)

  // P7.3 内存基线的进程内通道。与上面的 timing writer 同一形状，同一「只报一次」。
  //
  // **不做任何 GC。**一次 `Bun.gc(true)` 会把被测对象本身改掉：24 h 长跑要观测的
  // 正是「不干预时堆怎么走」，采样器替它清一遍，测到的就是采样器的节拍而不是常驻
  // 进程的行为。GC 检查点由跑批方在需要时手动触发，不进这个包。
  let memWriteFailed = false
  const reportMemError = (error: unknown): void => {
    if (memWriteFailed) return
    memWriteFailed = true
    process.stderr.write(`[resident mem] ${formatResidentError(error)}\n`)
  }
  const memWriter =
    config.memSample === undefined
      ? null
      : createResidentMemWriter(config.memSample, reportMemError)
  let memTimer: ReturnType<typeof setInterval> | null = null
  if (memWriter !== null) {
    const heapStats = await loadHeapStats()
    const sample = (): void => {
      const stats = heapStats()
      memWriter.write({
        at: Date.now(),
        rss: process.memoryUsage.rss(),
        heapSize: stats.heapSize,
        heapCapacity: stats.heapCapacity,
        objectCount: stats.objectCount,
        uptime: process.uptime(),
      })
    }
    // 先采一条，让数据集有 t=0：24 h 曲线的第一个间隔缺了，斜率就从第二个点起算。
    sample()
    memTimer = setInterval(
      sample,
      config.memIntervalMs ?? DEFAULT_RESIDENT_MEM_INTERVAL_MS,
    )
    // 采样器不该是让进程活着的理由。
    memTimer.unref?.()
  }
  // The node's own identity, created on first run and never replaced (P4.3).
  // Its public half is printed rather than published: M0 has no key
  // distribution, so whoever registers this agent copies the key into the
  // registry by hand, and a node that quietly learned keys from its peers
  // would be a node any peer could impersonate.
  const keys = loadOrCreateNodeKeys(config.node)
  assertOwnCertificateAndKey(config, keys.publicKey)
  // The durable trail (P7.2). Opened here rather than inside the node because
  // this is the layer that owns paths, and because a trail is per *process*:
  // two residents on one machine each continue their own file.
  //
  // Ahead of the directory rather than beside the node, because the very first
  // refresh below can already produce a §8.2 conflict record, and a trail
  // opened after it would lose exactly the line that explains why this node
  // resolves a peer's key differently from the registry.
  const trail = openAuditTrail()
  const directory = buildPublicKeyDirectory(
    config,
    certificateDirectoryTrailSink(trail, config.node),
    certificateDirectoryErrorTrailSink(trail, config.node),
  )
  if (directory instanceof CertificateDirectory) {
    // Awaited, once, before anything listens: `publicKeyOf` is synchronous by
    // contract, so a directory that has not converged yet answers `null` — and
    // for the first peer to dial in that is indistinguishable from "no such
    // node". The call is bounded by the directory's own timeout and never
    // throws, so an unreachable registry costs a few seconds of startup and
    // degrades to the `--trust` entries (§6.4), which is the designed
    // fail-closed state rather than a failure to start.
    await directory.refresh()
    directory.startPolling(DEFAULT_REGISTRY_POLL_INTERVAL_MS)
  }
  // Its own key is always trusted: rule S-1 accepts `user-confirmed` only when
  // this node signed it, which means verifying its own signature.
  directory.put(config.node, keys.publicKey)
  const capability = createResidentCapabilities(
    config,
    directory,
    keys,
    capabilityShadowTrailSink(trail, config.node),
  )
  const listenerTls = buildListenerTls(config)
  const handshakeSigning = buildHandshakeSigning(config, keys, directory)
  process.stdout.write(
    `${JSON.stringify({
      node: config.node,
      // Which source this binary was built from (issue #70). The deployment
      // tree on a fleet machine has no `.git` and `MACRO.VERSION` is the
      // base's release line — identical on every commit of this fork — so
      // without this field nothing on the far end of an acceptance run can
      // say *what* it just tested. `'unknown'` when the build could not
      // establish one; that is a fact worth printing, not a hole to backfill
      // with the reader's own HEAD.
      sourceCommit: sourceCommit(),
      publicKey: keys.publicKey,
      requireSignedTasks: config.requireSignedTasks,
      auditSignedTasks: config.auditSignedTasks,
      trusts: config.trusted.map(([node]) => node),
      // Which of the three layers this node actually has up (§7.3). Reported
      // as three fields rather than one "secure: true", for the reason §7.3
      // gives: collapsed into one, "TLS is on but nothing is signed" and
      // "everything is signed over plaintext" read identically afterwards.
      mtls: listenerTls !== null,
      signedHandshake: config.signHandshake === true,
      requireSignedHandshake: config.requireSignedHandshake === true,
    })}\n`,
  )
  // After the banner, so the two are read in the order they matter: what this
  // node is, then the one thing about it nobody chose.
  warnUnselectedTaskPolicy(config)
  // And then the one thing that makes a node which passes every other check
  // still unable to do any work.
  warnMissingModelCredentials()

  // …and the same question asked of the endpoint rather than of the
  // environment (issue #37 ①). Deliberately not awaited: the verdict is a
  // diagnosis, not an admission decision, and a node must not wait on a
  // network round trip before it starts listening. A refusal lands in
  // `<node>.err` a moment later, which is where the other two startup warnings
  // already are.
  //
  // The verdict is also remembered, in the same place the ACP child's own
  // upstream statuses go: if the first task arrives while that 401 is still
  // fresh, the inactivity watchdog can name the cause instead of reporting a
  // silence (issue #37 ②). Stale verdicts fall out of the window on their own.
  const upstreamHealth = new ResidentUpstreamHealth()
  void runResidentModelCredentialProbe().then(verdict => {
    if (verdict.status === 'refused') {
      upstreamHealth.record(verdict.httpStatus, verdict.detail)
    }
  })

  // The write-only backup credential comes from the environment, never from a
  // flag: a token on a command line is a token in every process listing on the
  // machine. Same injection point discipline as the transport PSK.
  const backupToken = process.env[BACKUP_TOKEN_ENV_VAR]
  if (config.backupUrl !== undefined && (backupToken ?? '') === '') {
    throw new Error(`--backup-url requires ${BACKUP_TOKEN_ENV_VAR}`)
  }
  const backup =
    config.backupUrl === undefined
      ? undefined
      : {
          writer: remoteSnapshotWriter({
            url: config.backupUrl,
            token: backupToken as string,
          }),
          ...(config.backupIntervalMs === undefined
            ? {}
            : { intervalMs: config.backupIntervalMs }),
        }

  const witnessToken = process.env[WITNESS_TOKEN_ENV_VAR]
  if (config.witnessUrl !== undefined && (witnessToken ?? '') === '') {
    throw new Error(`--witness-url requires ${WITNESS_TOKEN_ENV_VAR}`)
  }

  const witness =
    config.witnessUrl === undefined
      ? undefined
      : new AuditWitnessScheduler({
          node: config.node,
          trailPath: trail.path,
          keys,
          writer: remoteWitnessAnchorWriter({
            url: config.witnessUrl,
            token: witnessToken as string,
          }),
          ...(config.witnessIntervalMs === undefined
            ? {}
            : { intervalMs: config.witnessIntervalMs }),
          onError: error => {
            process.stderr.write(
              `[resident witness] ${formatResidentError(error)}\n`,
            )
          },
        })

  const resident = new QianmoResident({
    node: config.node,
    team: config.team,
    agents: config.agents,
    ...(config.allowWorkspaceEdits === true
      ? { allowWorkspaceEdits: true }
      : {}),
    psk,
    upstreamHealth,
    capability,
    auditSink: routerTrailSink(trail, config.node),
    transportEvents: transportTrailSink(trail, config.node),
    // The one sink whose successes matter (P13.6): a watch job's whole output
    // is "the operator was told, and the console receipted it", and no other
    // layer records that.
    notifyAudit: residentNotifyTrailSink(trail, config.node),
    ...(backup === undefined ? {} : { backup }),
    ...(witness === undefined ? {} : { witness }),
    listen: {
      ...(config.port === undefined ? {} : { port: config.port }),
      ...(config.hostname === undefined ? {} : { hostname: config.hostname }),
      ...(config.unix === undefined ? {} : { unix: config.unix }),
    },
    ...(listenerTls === null
      ? {}
      : {
          tls: listenerTls.tls,
          certificateNotAfter: listenerTls.certificateNotAfter,
        }),
    ...(handshakeSigning === undefined ? {} : { handshakeSigning }),
    onActivity: async active => {
      try {
        await activity?.report(active)
      } catch (error) {
        process.stderr.write(
          `[resident activity] ${formatResidentError(error)}\n`,
        )
      }
    },
    ...(config.activityUrl === undefined
      ? {}
      : {
          activityReconnectFactor:
            config.activityReconnectFactor ??
            DEFAULT_RESIDENT_ACTIVITY_TIME_JUMP_FACTOR,
        }),
    ...(timingWriter === null
      ? {}
      : {
          onTiming: (event: ResidentTimingEvent) => timingWriter.write(event),
        }),
    // Printed only. Not an audit record: the trail has no kind for it, and
    // this is not the place to add one.
    onPriorLife: prior => {
      process.stdout.write(`${residentPriorLifeLine(config.node, prior)}\n`)
    },
    onError: error => {
      process.stderr.write(`[resident] ${formatResidentError(error)}\n`)
    },
  })

  if (directory instanceof CertificateDirectory) {
    directory.setRefreshSink(({ permanentlyInvalidatedCredentials }) => {
      // The initial refresh ran before a listener existed. Every later poll
      // must revoke both future handshakes (the directory) and already
      // authenticated inbound links (the resident transport) in one event.
      // A missing registry lease is only discovery churn, never a 4003 cause.
      resident.closePeerCredentials(permanentlyInvalidatedCredentials)
    })
  }

  const stop = (): void => resident.stop()
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  try {
    await resident.run()
  } finally {
    if (directory instanceof CertificateDirectory) {
      directory.setRefreshSink(undefined)
      directory.stopPolling()
    }
    if (memTimer !== null) clearInterval(memTimer)
    trail.close()
    await timingWriter?.close()
    await memWriter?.close()
    await activity?.close()
  }
}
