// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  AuditLog,
  DaemonOp,
  HttpSandboxDaemon,
  assertSandboxName,
} from '@qianmo/activator'
import { parseDockerInspect, verifyBirthContract } from '@qianmo/sandbox'
import { arg, emit, intArg } from './cli-args.js'
import { daemonToken, daemonUrl, sandboxName } from './ac2-env.js'

const SANDBOX_LABEL = 'dormice.sandbox'

function requiredPath(name: string): string {
  const value = arg(name)
  if (value === undefined || !isAbsolute(value) || /[\0\r\n]/.test(value)) {
    throw new Error(
      `--${name} must be an absolute path without control characters`,
    )
  }
  return value
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const sandbox = assertSandboxName(sandboxName())
const containerPath = requiredPath('container-path')
const output = requiredPath('output')
const daemon = new HttpSandboxDaemon({
  baseUrl: daemonUrl(),
  token: daemonToken,
  audit: new AuditLog(),
})
const response = await daemon.send(DaemonOp.ListSandboxes, sandbox)
if (!response.ok) {
  throw new Error(`listSandboxes failed with status ${response.status}`)
}
const rows = record(response.body)?.sandboxes
if (!Array.isArray(rows)) throw new Error('listSandboxes returned no rows')
const row = rows.map(record).find(candidate => candidate?.name === sandbox)
const sandboxId = row?.id
if (typeof sandboxId !== 'string' || sandboxId.trim() === '') {
  throw new Error('named sandbox has no id in the daemon ledger')
}
const containers = execFileSync(
  'docker',
  ['ps', '-aq', '--filter', `label=${SANDBOX_LABEL}=${sandboxId}`],
  { encoding: 'utf8' },
)
  .split('\n')
  .filter(Boolean)
if (containers.length !== 1) {
  throw new Error(
    `expected one container for the named sandbox, got ${containers.length}`,
  )
}
const inspect: unknown = JSON.parse(
  execFileSync('docker', ['inspect', containers[0]!], { encoding: 'utf8' }),
)
const contract = verifyBirthContract(parseDockerInspect(inspect))
if (!contract.ok) {
  throw new Error(
    `sandbox birth contract failed: ${contract.failures.join(', ')}`,
  )
}

const intervalMs = intArg('interval-ms', 0)
const container = containers[0]!
let sourcePrefix = Buffer.alloc(0)

function copy(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'p31-timings-'))
  const temporary = join(directory, 'resident.jsonl')
  try {
    execFileSync('docker', ['cp', `${container}:${containerPath}`, temporary], {
      stdio: 'pipe',
    })
    const raw = readFileSync(temporary)
    const generationChanged =
      copiedBytes > raw.length ||
      (copiedBytes > 0 &&
        !raw.subarray(0, sourcePrefix.length).equals(sourcePrefix))
    const start = generationChanged ? 0 : copiedBytes
    if (raw.length > start) appendFileSync(output, raw.subarray(start))
    copiedBytes = raw.length
    sourcePrefix = raw.subarray(0, Math.min(raw.length, 256))
    return true
  } catch {
    return false
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

let copiedBytes = 0
writeFileSync(output, '')

if (intervalMs <= 0) {
  const copied = copy()
  emit({ copied })
  if (!copied) process.exit(1)
} else {
  if (intervalMs < 250) {
    throw new Error('--interval-ms must be at least 250')
  }
  let stopping = false
  const stop = (): void => {
    stopping = true
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  while (!stopping) {
    copy()
    await Bun.sleep(intervalMs)
  }
  copy()
}
