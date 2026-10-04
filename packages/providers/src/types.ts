// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The shapes of a model service, as the hub stores it and as the node receives
 * it (docs/dev/providers-console-m1.md §3.1, §3.2).
 *
 * Pure types. Every closed vocabulary below is also exported as a runtime
 * tuple, because the validator has to reject values TypeScript never saw: the
 * node parses JSON from stdin, and the hub imports JSON files a person edited.
 */

/** Which wire a profile speaks. Explicit, never guessed from a model name. */
export const LANES = [
  'anthropic',
  'openai-chat',
  'openai-responses',
  'gemini',
  'grok',
] as const
export type Lane = (typeof LANES)[number]

/** Billing shape. `plan` triggers the terms notice (§4.3). */
export const PLANS = ['paygo', 'plan', 'local', 'custom'] as const
export type Plan = (typeof PLANS)[number]

/** Bearer → `ANTHROPIC_AUTH_TOKEN`; `x-api-key` → `ANTHROPIC_API_KEY`. */
export const AUTH_SCHEMES = ['bearer', 'x-api-key'] as const
export type AuthScheme = (typeof AUTH_SCHEMES)[number]

/** The four family aliases a model can be pinned to. */
export const MODEL_TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export const MODEL_ROLES = ['main', 'fast', 'extra'] as const
export type ModelRole = (typeof MODEL_ROLES)[number]

/** Lowest first. The order is the whole point: clamping only moves down it. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type EffortLevel = (typeof EFFORT_LEVELS)[number]

/** §3.4: whether this model's effort is forced on, forced off, or left to the node. */
export const EFFORT_SENDS = ['always', 'never', 'auto'] as const
export type EffortSend = (typeof EFFORT_SENDS)[number]

/**
 * How a multi-key profile picks its key (P18.18). v1 validates the value and
 * otherwise behaves as `fill_first` with one key: the primary key is the only
 * one compiled and delivered.
 */
export const KEY_SELECTIONS = [
  'fill_first',
  'round_robin',
  'least_used',
] as const
export type KeySelection = (typeof KEY_SELECTIONS)[number]

/** Upper bound on keys per profile. */
export const MAX_KEYS_PER_PROFILE = 8

/**
 * Capability overrides for one model.
 *
 * `family` writes nothing and lets the base decide. `explicit` writes the
 * whole `_SUPPORTED_CAPABILITIES` list: the base reads "list present but item
 * missing" as false (`modelSupportOverrides.ts`), so it is all six or none.
 * The profile carries only the three thinking bits; the three effort bits are
 * derived from {@link ModelEffort} so there is exactly one place that says
 * whether effort goes on the wire.
 */
export type ModelCapabilities =
  | { mode: 'family' }
  | {
      mode: 'explicit'
      thinking: boolean
      adaptive_thinking: boolean
      interleaved_thinking: boolean
    }

export type ModelEffort = {
  send: EffortSend
  /** Requested level; clamped down into `levels` at compile time. */
  level?: EffortLevel
  /** Levels this model accepts. Required for `always`. */
  levels?: readonly EffortLevel[]
}

/** §3.2. */
export type ProviderModel = {
  /** Sent on the wire as-is. Never carries the client-only `[1m]` marker. */
  id: string
  role: ModelRole
  tiers: readonly ModelTier[]
  capabilities: ModelCapabilities
  effort: ModelEffort
  contextTokens?: number
  maxOutputTokens?: number
  /** ISO time. Filled from the retirement table; past it the compiler refuses. */
  retireAt?: string
}

/**
 * One key a profile holds, as the hub records it — never the value.
 *
 * `fingerprint` and `setAt` are hub bookkeeping (P18.6); the node only ever
 * sees `id` plus either the value or a fingerprint to keep.
 */
export type KeyRef = {
  /** `[a-z0-9-]{1,32}`, unique within the profile. */
  id: string
  label?: string
  /** Higher wins. Absent counts as 0. Ties keep list order. */
  priority?: number
  fingerprint?: string
  setAt?: string
}

export type Terms = {
  restricted: boolean
  note: string
  url: string
}

/** `false` until a real-key smoke test (§8.4) records evidence. */
export type Evaluated = false | { at: string; by: string; evidence: string }

/** One HTTP request a node can make to check a key or list models (§5.5). */
export type HttpProbe = {
  method: 'GET' | 'POST'
  /** Joined onto the ORIGIN of the resolved base URL, not onto its path. */
  path: string
  body?: Record<string, unknown>
  /** True when the request is documented to cost nothing. */
  free: boolean
}

export type ProbeSpec = {
  auth: HttpProbe | null
  models: HttpProbe | null
}

/**
 * Closed compat env (§3.6). Keys outside {@link COMPAT_KEYS} are refused
 * wherever a profile is parsed.
 */
export type CompatEnv = Partial<Record<string, string>>

/** Fields a stored profile and a delivered profile share. */
export type ProfileCore = {
  /** `[a-z0-9-]{1,48}`. */
  id: string
  revision: number
  lane: Lane
  /** May hold `{Name}` placeholders resolved from `templateValues`. */
  baseUrl: string
  templateValues?: Record<string, string>
  models: readonly ProviderModel[]
  compat?: CompatEnv
  effortLock?: EffortLevel | null
  keySelection?: KeySelection
}

/** §3.1 — what the hub keeps (no key values anywhere). */
export type ProviderProfile = ProfileCore & {
  name: string
  presetId: string | null
  plan: Plan
  site: string | null
  auth: { scheme: AuthScheme }
  keys: readonly KeyRef[]
  probe?: ProbeSpec
  terms?: Terms
  evaluated: Evaluated
}

/**
 * A key on the wire: the value (only in `apply`/`probe`), or keep-by-
 * fingerprint. `priority` travels with it so a P18.18 node sees the same
 * order the hub does; a v1 node receives exactly one key.
 */
export type WireKey =
  | { id: string; value: string; priority?: number }
  | { id: string; keep: string; priority?: number }

/** The profile inside a sixth-action request (§2.5). */
export type WireProfile = ProfileCore & {
  auth: { scheme: AuthScheme; keys: readonly WireKey[] }
}

/**
 * What the node's code can do (§2.4 `capabilities`). The compiler consults it:
 * a setting the running code cannot honour is refused, not written and then
 * silently ignored.
 */
export type NodeCapabilities = {
  protocol: 1
  /** P18.5: chat lane's effort gate reads the explicit override. */
  chatEffortHonorsOverride: boolean
  /** P18.8: replay filtered by target endpoint; cross-vendor `keep` allowed. */
  replayFilter: boolean
  /** P18.18: more than one key per delivered profile. */
  multiKey: boolean
}
