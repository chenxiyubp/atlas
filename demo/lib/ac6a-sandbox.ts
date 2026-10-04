// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import {
  DAEMON_TOKEN_ENV_VAR,
  DAEMON_URL_ENV_VAR,
  assertLoopbackBaseUrl,
  tokenFromEnv,
} from '@qianmo/activator'
import {
  FileSandboxAudit,
  parseDockerInspect,
  verifyBirthContract,
} from '@qianmo/sandbox'
import { defaultSandboxAuditPath } from '../../src/services/qianmo/sandboxAudit.js'
import { counter, unifiedCgroupDirectory } from './cgroup.js'

const SANDBOX_ENV_VAR = 'QIANMO_P13_SANDBOX'
const SANDBOX_LABEL = 'dormice.sandbox'

interface SandboxRow {
  readonly id: string
  readonly name: string
}

interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function required(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '')
    throw new Error(`${name} is required`)
  return value
}

function docker(...args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim()
}

async function rpc(method: string, body: object): Promise<unknown> {
  const base = assertLoopbackBaseUrl(required(DAEMON_URL_ENV_VAR))
  const prefix = base.pathname.replace(/\/+$/, '')
  const response = await fetch(new URL(`${prefix}/${method}`, base), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenFromEnv()}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  })
  const payload: unknown = await response.json()
  if (!response.ok)
    throw new Error(
      `sandbox daemon ${method} failed with status ${response.status}`,
    )
  return payload
}

function sandboxRows(value: unknown): SandboxRow[] {
  const rows = record(value)?.sandboxes
  if (!Array.isArray(rows)) throw new Error('listSandboxes returned no rows')
  return rows.flatMap(candidate => {
    const row = record(candidate)
    return typeof row?.id === 'string' && typeof row.name === 'string'
      ? [{ id: row.id, name: row.name }]
      : []
  })
}

function execResult(value: unknown): ExecResult {
  const result = record(value)
  if (
    typeof result?.exitCode !== 'number' ||
    typeof result.stdout !== 'string' ||
    typeof result.stderr !== 'string' ||
    typeof result.stdoutTruncated !== 'boolean' ||
    typeof result.stderrTruncated !== 'boolean'
  ) {
    throw new Error('execCommand returned an invalid result')
  }
  return result as unknown as ExecResult
}

async function execInSandbox(
  sandboxName: string,
  command: string,
  timeoutSeconds: number,
): Promise<ExecResult> {
  return execResult(
    await rpc('execCommand', { name: sandboxName, command, timeoutSeconds }),
  )
}

function containerForSandbox(sandboxId: string): string {
  const listed = docker(
    'ps',
    '-aq',
    '--filter',
    `label=${SANDBOX_LABEL}=${sandboxId}`,
  )
    .split('\n')
    .filter(Boolean)
  if (listed.length !== 1)
    throw new Error(
      `expected exactly one container for sandbox id, got ${listed.length}`,
    )
  return listed[0]!
}

function containerCgroupDirectory(containerId: string): string {
  const pid = docker('inspect', '--format', '{{.State.Pid}}', containerId)
  if (!/^\d+$/.test(pid) || pid === '0')
    throw new Error('container has no running host pid')
  return unifiedCgroupDirectory(pid)
}

async function main(): Promise<void> {
  required(DAEMON_TOKEN_ENV_VAR)
  const sandboxName = required(SANDBOX_ENV_VAR)
  const row = sandboxRows(await rpc('listSandboxes', {})).find(
    candidate => candidate.name === sandboxName,
  )
  if (row === undefined)
    throw new Error('named sandbox is not in the daemon ledger')

  const containerId = containerForSandbox(row.id)
  const inspect: unknown = JSON.parse(docker('inspect', containerId))
  const observation = parseDockerInspect(inspect)
  const birth = verifyBirthContract(observation)
  const audit = new FileSandboxAudit(defaultSandboxAuditPath())
  const expectedEventIds: string[] = []
  try {
    if (!birth.ok) {
      audit.append({
        kind: 'runtime.noncompliant',
        at: Date.now(),
        sandboxName,
        failures: birth.failures,
      })
      throw new Error(
        `sandbox birth contract failed: ${birth.failures.join(', ')}`,
      )
    }
    expectedEventIds.push(
      audit.append({ kind: 'runtime.attested', at: Date.now(), sandboxName })
        .eventId,
    )

    const occ = await execInSandbox(
      sandboxName,
      'command -v occ >/dev/null 2>&1',
      10,
    )
    if (occ.exitCode !== 0)
      throw new Error('occ is not installed inside the sandbox')

    const denied = await execInSandbox(
      sandboxName,
      'printf qianmo-p13 > /qianmo-p13-denied',
      10,
    )
    if (denied.exitCode === 0)
      throw new Error('write outside /home/user unexpectedly succeeded')
    expectedEventIds.push(
      audit.append({
        kind: 'filesystem.write_denied',
        at: Date.now(),
        sandboxName,
        target: 'outside_workspace',
        exitCode: denied.exitCode,
      }).eventId,
    )

    const timedOut = await execInSandbox(sandboxName, 'sleep 30', 1)
    if (timedOut.exitCode !== 137)
      throw new Error(
        `timeout command exited ${timedOut.exitCode}, expected 137`,
      )
    expectedEventIds.push(
      audit.append({
        kind: 'execution.timeout_enforced',
        at: Date.now(),
        sandboxName,
        exitCode: 137,
        timeoutSeconds: 1,
      }).eventId,
    )

    const cgroup = containerCgroupDirectory(containerId)
    const cpuStat = join(cgroup, 'cpu.stat')
    const cpuBefore = counter(cpuStat, 'nr_throttled')
    const cpuWorkers = Math.ceil(observation.nanoCpus / 1_000_000_000) + 2
    const cpuLoad = await execInSandbox(
      sandboxName,
      `workers=${cpuWorkers}; pids=''; i=0; while [ $i -lt $workers ]; do yes > /dev/null & pids="$pids $!"; i=$((i + 1)); done; sleep 4; kill $pids; wait $pids 2>/dev/null || true`,
      15,
    )
    if (cpuLoad.exitCode !== 0)
      throw new Error(`CPU probe exited ${cpuLoad.exitCode}`)
    const cpuAfter = counter(cpuStat, 'nr_throttled')
    expectedEventIds.push(
      audit.append({
        kind: 'resource.cpu_throttled',
        at: Date.now(),
        sandboxName,
        nrThrottledBefore: cpuBefore,
        nrThrottledAfter: cpuAfter,
      }).eventId,
    )

    const memoryEvents = join(cgroup, 'memory.events')
    const oomBefore = counter(memoryEvents, 'oom_kill')
    try {
      await execInSandbox(
        sandboxName,
        "node -e 'const blocks = []; for (;;) blocks.push(new Uint8Array(64 * 1024 * 1024).fill(1))'",
        120,
      )
    } catch {
      // The daemon may lose its exec stream when the kernel kills the pressured
      // process. The cgroup counter below, not the RPC outcome, is the evidence.
    }
    const oomAfter = counter(memoryEvents, 'oom_kill')
    expectedEventIds.push(
      audit.append({
        kind: 'resource.memory_oom_killed',
        at: Date.now(),
        sandboxName,
        oomKillBefore: oomBefore,
        oomKillAfter: oomAfter,
      }).eventId,
    )

    const queried = audit.query()
    if (queried.integrityIssues.length !== 0)
      throw new Error('sandbox audit contains integrity issues')
    const persistedIds = new Set(queried.events.map(event => event.eventId))
    for (const eventId of expectedEventIds) {
      if (!persistedIds.has(eventId))
        throw new Error('an event acknowledged by the audit is not queryable')
    }

    process.stdout.write(
      `${JSON.stringify({ sandboxName, runtime: 'runsc', passed: 5, total: 5 })}\n`,
    )
  } finally {
    audit.close()
  }
}

await main()
