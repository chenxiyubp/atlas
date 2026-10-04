// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `@qianmo/providers` — the one model-service catalog (R-1).
 *
 * Types, presets, the retirement table, validators, the closed compat key set,
 * key fingerprints and the sixth-action protocol schema v1. Pure data and
 * pure functions: no `src` imports, no file I/O, no network. The console and
 * the node both import this package; neither keeps a vendor list of its own.
 *
 * Compiling a profile into `settings.json` lives on the `src` side
 * (`src/services/qianmo/providers/`), because it reuses the base's
 * `ALL_PROFILE_ENV_KEYS` and activation patch builders, which a package
 * cannot import.
 */

export {
  checkCompatValue,
  COMPAT_KEYS,
  type CompatKey,
  isCompatKey,
  isForbiddenEnvKey,
  PROFILE_SETTABLE_COMPAT_KEYS,
} from './compatKeys.js'
export {
  clampEffortDown,
  clampSharedEffortDown,
  compiledEffortLevel,
  isEffortLevel,
  sortEffortLevels,
  UNSPECIFIED_EFFORT_LEVEL,
} from './effort.js'
export {
  isProviderErrorCode,
  PROVIDER_ERROR_CODES,
  type ProviderErrorCode,
  type ProviderIssue,
} from './errors.js'
export {
  isSecretFingerprint,
  secretFingerprint,
  shortFingerprint,
} from './fingerprint.js'
export {
  type KeyHint,
  listedPresets,
  PRESET_GROUPS,
  PRESETS,
  type Preset,
  type PresetGroup,
  type PresetSite,
  presetById,
  type TemplateVar,
} from './presets.js'
export {
  type AppliedRecord,
  type ApplyRequest,
  type EffectiveState,
  errorResponse,
  type LastCommitResult,
  type ModelsRequest,
  PROBE_MODES,
  type ParsedRequest,
  type ParseRequestOptions,
  type PendingSummary,
  type ProbeMode,
  type ProbeRequest,
  PROTOCOL_LIMITS,
  PROTOCOL_VERSION,
  PROVIDER_OPS,
  type ProviderNodeState,
  type ProviderOp,
  type ProviderRequest,
  type ProviderResponse,
  parseProviderRequest,
  type ResidentSummary,
  SENTINEL_COMMAND,
  SESSION_POLICIES,
  type SessionPolicy,
  type StatusRequest,
} from './protocol.js'
export {
  modelRetirementStatus,
  RETIREMENTS,
  RETIRING_WINDOW_DAYS,
  type Retirement,
  type RetirementStatus,
  retirementOf,
  retirementStatusAt,
} from './retirements.js'
export {
  isKeyId,
  isProfileId,
  parseSecretSlotKey,
  type SecretRef,
  secretSlotKey,
} from './secretRef.js'
export {
  AUTH_SCHEMES,
  type AuthScheme,
  type CompatEnv,
  EFFORT_LEVELS,
  EFFORT_SENDS,
  type EffortLevel,
  type EffortSend,
  type Evaluated,
  type HttpProbe,
  KEY_SELECTIONS,
  type KeyRef,
  type KeySelection,
  LANES,
  type Lane,
  MAX_KEYS_PER_PROFILE,
  MODEL_ROLES,
  MODEL_TIERS,
  type ModelCapabilities,
  type ModelEffort,
  type ModelRole,
  type ModelTier,
  type NodeCapabilities,
  PLANS,
  type Plan,
  type ProbeSpec,
  type ProfileCore,
  type ProviderModel,
  type ProviderProfile,
  type Terms,
  type WireKey,
  type WireProfile,
} from './types.js'
export {
  checkBaseUrl,
  checkModelEffort,
  keyMatchesHint,
  parseProviderProfile,
  parseWireProfile,
  primaryKey,
  type ProviderWarning,
  resolveBaseUrl,
  type Validated,
  type ValidateOptions,
} from './validate.js'
