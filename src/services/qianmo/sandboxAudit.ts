// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { occConfigPath } from '../../config/paths.js'

export function defaultSandboxAuditPath(): string {
  return occConfigPath('sandbox', 'audit.ndjson')
}
