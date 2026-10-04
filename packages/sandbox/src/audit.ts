// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BirthContractFailure,
  SandboxAuditEvent,
  SandboxAuditInput,
  SandboxAuditIntegrityIssue,
  SandboxAuditQueryResult,
} from './contracts.js'

const DIRECTORY_MODE = 0o700
const FILE_MODE = 0o600
const FAILURE_CODES: ReadonlySet<BirthContractFailure> = new Set([
  'runtime_not_runsc',
  'root_user',
  'init_disabled',
  'root_filesystem_writable',
  'no_new_privileges_missing',
  'cpu_limit_missing',
  'memory_limit_missing',
  'pids_limit_missing',
  'temporary_filesystem_missing',
  'unexpected_writable_tmpfs',
  'workspace_mount_missing',
  'unexpected_writable_mount',
  'host_control_socket_mounted',
])

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0)
    throw new RangeError(`${field} must be a positive integer`)
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0)
    throw new RangeError(`${field} must be a non-negative integer`)
}

function assertExactKeys(
  input: SandboxAuditInput,
  expected: readonly string[],
): void {
  const actual = Object.keys(input).sort()
  const allowed = [...expected].sort()
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    throw new Error(`unexpected audit fields for ${input.kind}`)
  }
}

function validateInput(input: SandboxAuditInput): void {
  if (!Number.isFinite(input.at) || input.at < 0)
    throw new RangeError('at must be a non-negative finite number')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.sandboxName))
    throw new Error('sandboxName is invalid')

  switch (input.kind) {
    case 'runtime.attested':
      assertExactKeys(input, ['kind', 'at', 'sandboxName'])
      return
    case 'runtime.noncompliant':
      assertExactKeys(input, ['kind', 'at', 'sandboxName', 'failures'])
      if (
        input.failures.length === 0 ||
        input.failures.some(failure => !FAILURE_CODES.has(failure))
      ) {
        throw new Error('runtime.noncompliant requires known failures')
      }
      return
    case 'filesystem.write_denied':
      if (input.target === 'outside_workspace') {
        assertExactKeys(input, [
          'kind',
          'at',
          'sandboxName',
          'target',
          'exitCode',
        ])
      } else if (input.target === 'readonly_host_reference') {
        assertExactKeys(input, [
          'kind',
          'at',
          'sandboxName',
          'target',
          'exitCode',
          'hostUnchanged',
        ])
        if (input.hostUnchanged !== true)
          throw new Error(
            'read-only host denial requires unchanged host evidence',
          )
      } else {
        throw new Error('filesystem denial target is invalid')
      }
      if (!Number.isInteger(input.exitCode) || input.exitCode === 0)
        throw new Error('a successful write cannot be audited as denied')
      return
    case 'execution.timeout_enforced':
      assertExactKeys(input, [
        'kind',
        'at',
        'sandboxName',
        'exitCode',
        'timeoutSeconds',
      ])
      if (input.exitCode !== 137)
        throw new Error('timeout enforcement requires exit code 137')
      positiveInteger(input.timeoutSeconds, 'timeoutSeconds')
      return
    case 'resource.cpu_throttled':
      assertExactKeys(input, [
        'kind',
        'at',
        'sandboxName',
        'nrThrottledBefore',
        'nrThrottledAfter',
      ])
      nonNegativeInteger(input.nrThrottledBefore, 'nrThrottledBefore')
      nonNegativeInteger(input.nrThrottledAfter, 'nrThrottledAfter')
      if (input.nrThrottledAfter <= input.nrThrottledBefore)
        throw new Error('CPU throttling requires a positive counter delta')
      return
    case 'resource.memory_oom_killed':
      assertExactKeys(input, [
        'kind',
        'at',
        'sandboxName',
        'oomKillBefore',
        'oomKillAfter',
      ])
      nonNegativeInteger(input.oomKillBefore, 'oomKillBefore')
      nonNegativeInteger(input.oomKillAfter, 'oomKillAfter')
      if (input.oomKillAfter <= input.oomKillBefore)
        throw new Error('memory enforcement requires a positive oom_kill delta')
      return
    default:
      throw new Error('unknown sandbox audit event type')
  }
}

function isEvent(value: unknown): value is SandboxAuditEvent {
  const event = record(value)
  if (
    typeof event?.eventId !== 'string' ||
    typeof event.at !== 'number' ||
    typeof event.sandboxName !== 'string' ||
    typeof event.kind !== 'string'
  ) {
    return false
  }
  try {
    const { eventId: _eventId, ...input } = event
    validateInput(input as SandboxAuditInput)
    return true
  } catch {
    return false
  }
}

export class FileSandboxAudit {
  readonly #path: string
  #fd: number | null = null

  constructor(path: string) {
    if (path.trim() === '') throw new Error('audit path must not be empty')
    this.#path = path
  }

  get path(): string {
    return this.#path
  }

  #handle(): number {
    if (this.#fd === null) {
      const directory = dirname(this.#path)
      mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE })
      chmodSync(directory, DIRECTORY_MODE)
      this.#fd = openSync(
        this.#path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          (constants.O_NOFOLLOW ?? 0),
        FILE_MODE,
      )
      chmodSync(this.#path, FILE_MODE)
    }
    return this.#fd
  }

  append(input: SandboxAuditInput): SandboxAuditEvent {
    validateInput(input)
    const event: SandboxAuditEvent = { ...input, eventId: randomUUID() }
    const fd = this.#handle()
    writeSync(fd, `${JSON.stringify(event)}\n`)
    fsyncSync(fd)
    return event
  }

  query(): SandboxAuditQueryResult {
    let raw: string
    try {
      raw = readFileSync(this.#path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { events: [], integrityIssues: [] }
      throw error
    }

    const lines = raw.split('\n')
    const tail = lines.pop()
    const events: SandboxAuditEvent[] = []
    const integrityIssues: SandboxAuditIntegrityIssue[] = []
    for (const [index, line] of lines.entries()) {
      if (line === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (isEvent(parsed)) events.push(parsed)
        else integrityIssues.push({ line: index + 1, kind: 'corrupt_line' })
      } catch {
        integrityIssues.push({ line: index + 1, kind: 'corrupt_line' })
      }
    }
    if (tail !== undefined && tail !== '') {
      integrityIssues.push({ line: lines.length + 1, kind: 'torn_tail' })
    }
    return { events, integrityIssues }
  }

  close(): void {
    if (this.#fd !== null) {
      closeSync(this.#fd)
      this.#fd = null
    }
  }
}
