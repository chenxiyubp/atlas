// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The part of `settings.json` a profile owns, and its hash (§2.4, §2.6).
 *
 * Owned: `modelType`; `env` keys in the node whitelist; the five
 * `modelSettings` slots. The hash is over a canonical form of exactly that,
 * with every credential replaced by its fingerprint, so `onDiskHash`,
 * `appliedHash` and `loadedHash` can travel to the hub without carrying a key.
 *
 * Pure functions over parsed JSON — no file access here.
 */

import { createHash } from 'node:crypto'
import { secretFingerprint } from '@qianmo/providers'
import {
  MODEL_SETTINGS_SLOTS,
  type ModelSettingsSlot,
} from '../../../utils/model/modelTier.js'
import { isManagedEnvKey, SECRET_ENV_KEYS } from './whitelist.js'

type SlotSettings = { effort?: string; contextTokens?: number }

export type ManagedView = {
  modelType: string | null
  env: Record<string, string>
  modelSettings: Partial<Record<ModelSettingsSlot, SlotSettings>>
  /** Set when settings.json exists but is not a JSON object. */
  unreadable?: string
}

/** What activation writes: every managed env key named, `undefined` = delete. */
export type SettingsPatch = {
  modelType: string
  env: Record<string, string | undefined>
  modelSettings: Record<ModelSettingsSlot, SlotSettings | undefined>
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The owned slice of a settings object. Unowned keys never enter it. */
export function managedViewOf(settings: unknown): ManagedView {
  const view: ManagedView = { modelType: null, env: {}, modelSettings: {} }
  if (!isRecord(settings)) return view
  if (typeof settings.modelType === 'string')
    view.modelType = settings.modelType
  if (isRecord(settings.env)) {
    for (const [key, value] of Object.entries(settings.env)) {
      if (isManagedEnvKey(key) && typeof value === 'string')
        view.env[key] = value
    }
  }
  if (isRecord(settings.modelSettings)) {
    for (const slot of MODEL_SETTINGS_SLOTS) {
      const raw = settings.modelSettings[slot]
      if (!isRecord(raw)) continue
      const entry: SlotSettings = {}
      if (typeof raw.effort === 'string') entry.effort = raw.effort
      if (typeof raw.contextTokens === 'number')
        entry.contextTokens = raw.contextTokens
      if (entry.effort !== undefined || entry.contextTokens !== undefined) {
        view.modelSettings[slot] = entry
      }
    }
  }
  return view
}

/** A file that exists but does not parse: its bytes stand in for the view. */
export function unreadableView(content: string): ManagedView {
  return {
    modelType: null,
    env: {},
    modelSettings: {},
    unreadable: sha256(content),
  }
}

/** The value as it enters a hash: credentials by fingerprint, never raw. */
function hashableValue(key: string, value: string): string {
  return SECRET_ENV_KEYS.includes(key) ? secretFingerprint(value) : value
}

function canonical(view: ManagedView): string {
  const env = Object.fromEntries(
    Object.keys(view.env)
      .sort()
      .map(key => [key, hashableValue(key, view.env[key] as string)]),
  )
  const modelSettings = Object.fromEntries(
    MODEL_SETTINGS_SLOTS.filter(
      slot => view.modelSettings[slot] !== undefined,
    ).map(slot => {
      const entry = view.modelSettings[slot] as SlotSettings
      return [
        slot,
        {
          ...(entry.contextTokens !== undefined
            ? { contextTokens: entry.contextTokens }
            : {}),
          ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
        },
      ]
    }),
  )
  return JSON.stringify({
    v: 1,
    modelType: view.modelType,
    env,
    modelSettings,
    ...(view.unreadable !== undefined ? { unreadable: view.unreadable } : {}),
  })
}

export function hashManagedView(view: ManagedView): string {
  return `sha256:${sha256(canonical(view))}`
}

/**
 * Per-key hashes, so a later difference can be reported by key NAME (§2.4
 * `local-edit` → 「查看差异（只列键名）」) without keeping any value.
 */
export function keyHashesOf(view: ManagedView): Record<string, string> {
  const hashes: Record<string, string> = {
    modelType: sha256(JSON.stringify(view.modelType)),
  }
  for (const [key, value] of Object.entries(view.env)) {
    hashes[`env.${key}`] = sha256(hashableValue(key, value))
  }
  for (const slot of MODEL_SETTINGS_SLOTS) {
    const entry = view.modelSettings[slot]
    if (entry !== undefined) {
      hashes[`modelSettings.${slot}`] = sha256(
        JSON.stringify([entry.effort ?? null, entry.contextTokens ?? null]),
      )
    }
  }
  return hashes
}

/** Names whose hashes differ between two key-hash maps. */
export function diffKeyHashes(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...names].filter(name => before[name] !== after[name]).sort()
}

/** Hash of one env value, as recorded for compat keys we wrote. */
export function envValueHash(key: string, value: string): string {
  return sha256(hashableValue(key, value))
}

/**
 * The managed view after `patch` lands — the same merge rule as
 * `updateSettingsForSource` (undefined deletes, values overwrite, whole-slot
 * rewrite for `modelSettings` because every slot and both axes are named).
 */
export function applyPatchToView(
  view: ManagedView,
  patch: SettingsPatch,
): ManagedView {
  const env = { ...view.env }
  for (const [key, value] of Object.entries(patch.env)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  const modelSettings: ManagedView['modelSettings'] = { ...view.modelSettings }
  for (const slot of MODEL_SETTINGS_SLOTS) {
    const entry = patch.modelSettings[slot]
    if (entry === undefined) {
      delete modelSettings[slot]
      continue
    }
    const next: SlotSettings = {}
    if (entry.effort !== undefined) next.effort = entry.effort
    if (entry.contextTokens !== undefined)
      next.contextTokens = entry.contextTokens
    if (next.effort === undefined && next.contextTokens === undefined) {
      delete modelSettings[slot]
    } else {
      modelSettings[slot] = next
    }
  }
  return { modelType: patch.modelType, env, modelSettings }
}
