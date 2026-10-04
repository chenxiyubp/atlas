// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 场景总表 —— 验收矩阵的唯一出处。
 *
 * **一套场景，两个驱动。** 本地腿与真机腿跑的是**同一个数组**，靠
 * {@link Scenario.requires} 与驱动能力表做差集来决定哪些跳过。任何「真机腿
 * 专用的场景文件」都是这条设计的破坏，出现了就说明该往驱动接口里加能力，
 * 而不是往这里加第二张表。
 *
 * 顺序 = 维度顺序。同维度内先正向后反向：一份报告从上往下读应当是
 * 「这条链路是通的，然后每一种拒绝各自成立」。
 */

import { abortAttributionScenarios } from './scenarios/abortAttribution.js'
import { auditScenarios } from './scenarios/audit.js'
import { auditMirrorScenarios } from './scenarios/auditMirror.js'
import { capabilityScenarios } from './scenarios/capability.js'
import { certificateScenarios } from './scenarios/certificate.js'
import { consoleScenarios } from './scenarios/console.js'
import { deliveryScenarios } from './scenarios/delivery.js'
import {
  credentialChannelScenarios,
  handshakeScenarios,
} from './scenarios/handshake.js'
import { launcherScenarios } from './scenarios/launcher.js'
import { limitsScenarios } from './scenarios/limits.js'
import { modelCredentialScenarios } from './scenarios/modelCredential.js'
import { multiAgentScenarios } from './scenarios/multiAgent.js'
import { policyScenarios } from './scenarios/policy.js'
import { recoveryScenarios } from './scenarios/recovery.js'
import { trustScenarios } from './scenarios/trust.js'
import { wakeScenarios } from './scenarios/wake.js'
import type { Scenario } from './types.js'

export const ALL_SCENARIOS: readonly Scenario[] = [
  ...handshakeScenarios,
  ...credentialChannelScenarios,
  ...policyScenarios,
  ...capabilityScenarios,
  ...trustScenarios,
  ...deliveryScenarios,
  ...modelCredentialScenarios,
  ...abortAttributionScenarios,
  ...multiAgentScenarios,
  ...auditScenarios,
  ...auditMirrorScenarios,
  ...wakeScenarios,
  ...recoveryScenarios,
  ...launcherScenarios,
  ...limitsScenarios,
  ...consoleScenarios,
  ...certificateScenarios,
]
