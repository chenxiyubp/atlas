// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs `computeEffectiveProviderState()` in its own process, as §2.4 requires
 * (it rewrites process.env), and prints one marked JSON line. The spawning
 * test controls the config root and strips provider keys from the env first.
 * An optional first argument evaluates a model the session switched to.
 */

import { computeEffectiveProviderState } from '../../node.js'

// Optional argv[2]: a model id the session switched to.
const model = process.argv[2]
const state = computeEffectiveProviderState(
  model === undefined ? {} : { model },
)
process.stdout.write(`QIANMO_EFFECTIVE ${JSON.stringify(state)}\n`)
