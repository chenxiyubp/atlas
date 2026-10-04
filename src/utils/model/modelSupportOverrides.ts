import { getAPIProvider, isThirdPartyModelCatalog } from './providers.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'xhigh_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

const ANTHROPIC_TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

const OPENAI_TIERS = [
  {
    modelEnvVar: 'OPENAI_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'OPENAI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'OPENAI_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'OPENAI_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'OPENAI_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'OPENAI_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'OPENAI_DEFAULT_FABLE_MODEL',
    capabilitiesEnvVar: 'OPENAI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

// qianmo P18.5 (Q-2): the Gemini and Grok lanes read their own prefix. Before
// this they fell through to ANTHROPIC_TIERS, so the GEMINI_/GROK_ capability
// keys that PROFILE_ENV_KEYS manages (providerProfiles/envKeys.ts) were
// written by /provider and read by nothing. The Anthropic list stays behind
// them as the fallback those lanes have always had.
const GEMINI_TIERS = [
  {
    modelEnvVar: 'GEMINI_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'GEMINI_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'GEMINI_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'GEMINI_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'GEMINI_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'GEMINI_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'GEMINI_DEFAULT_FABLE_MODEL',
    capabilitiesEnvVar: 'GEMINI_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

const GROK_TIERS = [
  {
    modelEnvVar: 'GROK_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'GROK_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'GROK_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'GROK_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'GROK_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'GROK_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'GROK_DEFAULT_FABLE_MODEL',
    capabilitiesEnvVar: 'GROK_DEFAULT_FABLE_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

/**
 * Check whether a 3p model capability override is set for a model that matches one of
 * the pinned ANTHROPIC_DEFAULT_*_MODEL or OPENAI_DEFAULT_*_MODEL env vars.
 */
export function get3PModelCapabilityOverride(
  model: string,
  capability: ModelCapabilityOverride,
): boolean | undefined {
  if (!isThirdPartyModelCatalog()) {
    return undefined
  }
  const m = model.toLowerCase()
  // Choose the appropriate tier list based on provider. A DeepSeek session
  // answers 'firstParty' (Anthropic wire) while its pins live under either
  // prefix — the wire mirrors OPENAI_* onto ANTHROPIC_* — so it reads both
  // rather than silently losing the user's capability overrides.
  const tiers =
    getAPIProvider() === 'openai'
      ? OPENAI_TIERS
      : getAPIProvider() === 'firstParty'
        ? [...ANTHROPIC_TIERS, ...OPENAI_TIERS]
        : getAPIProvider() === 'gemini'
          ? [...GEMINI_TIERS, ...ANTHROPIC_TIERS]
          : getAPIProvider() === 'grok'
            ? [...GROK_TIERS, ...ANTHROPIC_TIERS]
            : ANTHROPIC_TIERS
  for (const tier of tiers) {
    const pinned = process.env[tier.modelEnvVar]
    const capabilities = process.env[tier.capabilitiesEnvVar]
    if (!pinned || capabilities === undefined) continue
    if (m !== pinned.toLowerCase()) continue
    return capabilities
      .toLowerCase()
      .split(',')
      .map(s => s.trim())
      .includes(capability)
  }
  return undefined
}
