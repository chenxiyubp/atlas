// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/activator` — one component with two faces, both host-side, both
 * acting on a sandboxed node's behalf against the sandbox daemon.
 *
 * **The activator face** (`activator.ts`) catches a request for a sleeping
 * node, wakes it, waits for it to actually be ready, and forwards. Nothing
 * else provides this: the kernel's accept queue buffers a connection only on
 * the machine the service lives on, and the sandbox daemon listens on loopback
 * and offers no cross-machine equivalent (E1).
 *
 * **The keepalive face** (`keepalive.ts`) beats against the daemon API on a
 * period strictly under the sandbox's freeze threshold. It has to be external
 * and it has to reach the API, because work done *inside* the sandbox is
 * invisible to the idle judgement: a 100 %-CPU process was frozen at 110 s and
 * made no progress for the following 411 s (E3). And it must not be replaced by
 * `stopAfterSeconds: null`, which trades a recoverable failure for a permanent
 * silent one — {@link assertResidencyPolicy} refuses that configuration.
 *
 * **Why one package.** Both faces hold the same credential, and that credential
 * has no privilege tiers: the bearer that wakes a sandbox is the bearer that
 * destroys it, on the same endpoint, one path segment away. One component means
 * one capability surface (`capability.ts`) — `acquireSandbox`, `listSandboxes`,
 * and nothing else, unreachable rather than merely unconfigured. AC-6(c) rests
 * on that surface staying this small.
 *
 * **The wire shape here was verified on the host on 2026-08-12**, after a first
 * version of this package was written against an assumed REST API that turned
 * out not to exist. What was corrected: the daemon is a `POST /{methodName}`
 * RPC, there is no `touch` method, `acquireSandbox` is both the wake verb and
 * the keep-alive verb, sandboxes are addressed by name, states are
 * `active` / `frozen` / `stopped`, and a status read is `listSandboxes` plus a
 * filter. `keepalive.ts` records what the missing `touch` cost us in type-level
 * safety; the numbers behind each of these live next to the code that relies on
 * them.
 *
 * **What the tests here do and do not show.** The daemon is an external system,
 * modelled as a port with a local stand-in (`test/stub-daemon.ts`). The stub
 * now speaks the daemon's real wire shape, but it is still a stand-in: every
 * line of scheduling, retry, allowlist, journal and recovery logic is exercised
 * for real against it, over a real socket, and none of it is evidence about how
 * the real daemon behaves.
 *
 * Of P2.5's four acceptance criteria:
 *
 * - **DoD ①** — ten consecutive catch/wake/forward round trips against a
 *   genuinely dormant node, with stage timings. All three ports now have an
 *   implementation — {@link SandboxDaemon} over the real RPC
 *   ({@link HttpSandboxDaemon}), and {@link ReadyProbe} / {@link ForwardTarget}
 *   over one transport hop each ({@link TransportLinks}) — and
 *   {@link startActivatorNode} wires them to an inbound listener, so the whole
 *   chain runs end to end. `test/chain.test.ts` runs it over real sockets
 *   against the stub supervisor. **The ten round trips against a genuinely
 *   frozen sandbox are still not claimed here**: they need the Linux host, and
 *   `demo/ac2-wake-forward.sh` is the script that performs them there.
 * - **DoD ②** — a busy in-sandbox process surviving several multiples of the
 *   freeze threshold with the heartbeat on, and being frozen with it off.
 *   **Measured on the host** on 2026-08-12, both halves; the numbers are in
 *   `keepalive.ts`. Nothing in this package re-proves it.
 * - **DoD ③** (`capability.test.ts`, `destroy-unreachable.test.ts`,
 *   `surface-invariant.test.ts`) and **DoD ④** (`crash-recovery.test.ts`, real
 *   child process, real SIGKILL) are covered here.
 */

export {
  DEFAULT_RESIDENT_KEEPALIVE_TIME_JUMP_FACTOR,
  ResidentActivityController,
  startResidentActivityServer,
} from './activity.js'

export {
  Activator,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_READY_POLL_INTERVAL_MS,
  DEFAULT_READY_TIMEOUT_MS,
  type ActivationOutcome,
  type ActivationRequest,
  type ActivatorOptions,
  type FailureSink,
  type ForwardTarget,
  type ReadyProbe,
  type RecoveryReport,
} from './activator.js'

export {
  ActivatorEventType,
  AuditLog,
  DEFAULT_AUDIT_CAPACITY,
  type AuditEvent,
  type AuditSink,
} from './audit.js'

export {
  ALLOWED_BODY_KEYS,
  ALLOWED_METHODS,
  CapabilityDeniedError,
  DAEMON_CAPABILITY_SURFACE,
  DESTRUCTIVE_WORDS,
  DaemonOp,
  assertSurfaceIsSafe,
  capabilitySurface,
  resolveRoute,
  type DaemonRoute,
  type DenialReason,
  type ResolvedRequest,
} from './capability.js'

export {
  DEFAULT_GRACE_MS,
  DEFAULT_MIN_JUMP_GAP_MS,
  DEFAULT_TIME_JUMP_FACTOR,
  TimeJumpGate,
  systemClock,
  timerScheduler,
  type CancelTimer,
  type Clock,
  type Scheduler,
  type TimeJumpGateOptions,
  type TimeJumpObservation,
} from './clock.js'

export {
  DAEMON_TOKEN_ENV_VAR,
  DAEMON_URL_ENV_VAR,
  DEFAULT_DAEMON_TIMEOUT_MS,
  DaemonRequestError,
  HttpSandboxDaemon,
  SandboxNotFoundError,
  assertLoopbackBaseUrl,
  assertSandboxName,
  tokenFromEnv,
  type DaemonResponse,
  type FetchLike,
  type HttpSandboxDaemonOptions,
  type SandboxDaemon,
  type SandboxState,
  type SandboxStatus,
} from './daemon.js'

export {
  FileRequestJournal,
  MemoryRequestJournal,
  defaultJournalPath,
  type AcceptedRecord,
  type JournalRecord,
  type RequestJournal,
  type TerminalRecord,
} from './journal.js'

export {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  DEFAULT_PERIOD_RATIO,
  KeepaliveLoop,
  MAX_PERIOD_RATIO,
  MIN_RETRY_DELAY_MS,
  ResidencyPolicyError,
  assertResidencyPolicy,
  keepalivePeriodMs,
  type KeepaliveBeat,
  type KeepaliveDegraded,
  type KeepaliveOptions,
  type KeepalivePort,
  type ResidencyPolicy,
} from './keepalive.js'

export {
  DEFAULT_FORWARD_TIMEOUT_MS,
  DEFAULT_LINK_CONNECT_TIMEOUT_MS,
  StaticTargetDirectory,
  TransportLinks,
  UnknownTargetError,
  type LinkReplyHandler,
  type TargetDirectory,
  type TargetSite,
  type TransportLinksOptions,
} from './link.js'

export {
  DEFAULT_TASK_ROUTE_CAPACITY,
  TaskRouteError,
  TaskRouteRegistry,
  type TaskRouteRegistryOptions,
} from './routes.js'

export {
  DEFAULT_FAILURE_CAPACITY,
  startActivatorNode,
  type ActivatorListenOptions,
  type ActivatorNodeHandle,
  type ActivatorNodeOptions,
} from './node.js'

export {
  DEFAULT_TIMING_CAPACITY,
  StageTimeline,
  TimingRecorder,
  durationsOf,
  statsOf,
  type ActivationOutcomeKind,
  type StageDurations,
  type StageStats,
  type StageTimings,
  type TimingReport,
} from './stages.js'
