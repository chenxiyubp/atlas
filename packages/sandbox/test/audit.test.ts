// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSandboxAudit } from '../src/audit.js'
import type { SandboxAuditInput } from '../src/contracts.js'

let directory: string
let path: string
let audit: FileSandboxAudit

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-sandbox-audit-'))
  path = join(directory, 'events.ndjson')
  audit = new FileSandboxAudit(path)
})

afterEach(() => {
  audit.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('durable sandbox audit', () => {
  test('appends a queryable event with private file mode', () => {
    const event = audit.append({
      kind: 'filesystem.write_denied',
      at: 1_000,
      sandboxName: 'sandbox-1',
      target: 'outside_workspace',
      exitCode: 1,
    })
    expect(event.eventId).not.toBe('')
    expect(audit.query()).toEqual({ events: [event], integrityIssues: [] })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
  })

  test('rejects command, path, stderr, token and arbitrary detail fields', () => {
    for (const extra of [
      { command: 'sensitive' },
      { hostPath: '/sensitive' },
      { stderr: 'sensitive' },
      { token: 'sensitive' },
      { detail: 'sensitive' },
    ]) {
      expect(() =>
        audit.append({
          kind: 'runtime.attested',
          at: 1,
          sandboxName: 'sandbox-1',
          ...extra,
        } as unknown as SandboxAuditInput),
      ).toThrow(/unexpected audit fields/)
    }
    expect(audit.query().events).toEqual([])
  })

  test('rejects an unknown runtime event kind', () => {
    expect(() =>
      audit.append({
        kind: 'runtime.claimed',
        at: 1,
        sandboxName: 'sandbox-1',
      } as unknown as SandboxAuditInput),
    ).toThrow(/unknown sandbox audit event type/)
  })

  test('a successful write cannot masquerade as a denial', () => {
    expect(() =>
      audit.append({
        kind: 'filesystem.write_denied',
        at: 1,
        sandboxName: 'sandbox-1',
        target: 'outside_workspace',
        exitCode: 0,
      }),
    ).toThrow(/successful write/)
  })

  test('a read-only host denial requires host-integrity evidence', () => {
    expect(() =>
      audit.append({
        kind: 'filesystem.write_denied',
        at: 1,
        sandboxName: 'sandbox-1',
        target: 'readonly_host_reference',
        exitCode: 1,
      } as unknown as SandboxAuditInput),
    ).toThrow(/unexpected audit fields|unchanged host evidence/)
  })

  test('exit 137 plus an actual timeout is required', () => {
    expect(() =>
      audit.append({
        kind: 'execution.timeout_enforced',
        at: 1,
        sandboxName: 'sandbox-1',
        exitCode: 137,
        timeoutSeconds: 0,
      }),
    ).toThrow(/timeoutSeconds/)
  })

  test('resource events require a positive kernel-counter delta', () => {
    expect(() =>
      audit.append({
        kind: 'resource.cpu_throttled',
        at: 1,
        sandboxName: 'sandbox-1',
        nrThrottledBefore: 5,
        nrThrottledAfter: 5,
      }),
    ).toThrow(/positive counter delta/)
    expect(() =>
      audit.append({
        kind: 'resource.memory_oom_killed',
        at: 1,
        sandboxName: 'sandbox-1',
        oomKillBefore: 2,
        oomKillAfter: 2,
      }),
    ).toThrow(/positive oom_kill delta/)
  })

  test('a missing file is an empty audit', () => {
    expect(audit.query()).toEqual({ events: [], integrityIssues: [] })
  })
})

describe('visible corruption', () => {
  test('reports a torn tail without losing preceding events', () => {
    const event = audit.append({
      kind: 'runtime.attested',
      at: 1,
      sandboxName: 'sandbox-1',
    })
    audit.close()
    appendFileSync(path, '{"eventId":"partial')
    expect(audit.query()).toEqual({
      events: [event],
      integrityIssues: [{ line: 2, kind: 'torn_tail' }],
    })
  })

  test('reports middle corruption and keeps later events visible', () => {
    const one = audit.append({
      kind: 'runtime.attested',
      at: 1,
      sandboxName: 'sandbox-1',
    })
    const two = audit.append({
      kind: 'execution.timeout_enforced',
      at: 2,
      sandboxName: 'sandbox-1',
      exitCode: 137,
      timeoutSeconds: 1,
    })
    audit.close()
    writeFileSync(
      path,
      `${JSON.stringify(one)}\nnot-json\n${JSON.stringify(two)}\n`,
    )
    expect(audit.query()).toEqual({
      events: [one, two],
      integrityIssues: [{ line: 2, kind: 'corrupt_line' }],
    })
  })
})
