// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const savedConfigDir = process.env.OCC_CONFIG_DIR
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'qianmo-sandbox-host-audit-'))
  process.env.OCC_CONFIG_DIR = directory
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  rmSync(directory, { recursive: true, force: true })
})

describe('sandbox audit host wiring', () => {
  test('derives the audit path from the identity-scoped config root', async () => {
    const { defaultSandboxAuditPath } = await import('../sandboxAudit.js')
    expect(defaultSandboxAuditPath()).toBe(
      join(directory, 'sandbox', 'audit.ndjson'),
    )
  })
})
