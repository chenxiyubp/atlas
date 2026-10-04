// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where a running artifact learns which source it was built from.
 *
 * Issue #70: a fleet node's deployment tree has no `.git`, its 684 `dist/`
 * chunks carry no marker, and the only version string in the entrypoint is the
 * base's `"2.46.0"` — identical on every commit of this fork. So nothing on a
 * deployed machine could answer "which commit is this". The build now injects
 * `MACRO.SOURCE_COMMIT` (scripts/defines.ts); this module is how runtime code
 * reads it back.
 */

/**
 * The value reported when the build could not establish a commit — a clean
 * tarball, a `.git`-less container, an unborn branch — and also what an
 * unbundled run (tests, a direct `bun src/…`) sees, since MACRO substitution
 * only happens under the bundler or `bun -d`.
 *
 * Deliberately a word and not `''`/`undefined`: every consumer is reporting
 * provenance to a human or to a report, and an empty field there reads as
 * "nobody filled it in" rather than "the build genuinely does not know".
 * Kept byte-identical to UNKNOWN_SOURCE_COMMIT in scripts/defines.ts.
 *
 * Module-private on purpose: the only thing outside needs is the string, and
 * an export nothing imports is what the dead-code ratchet exists to catch.
 */
const UNKNOWN_SOURCE_COMMIT = 'unknown'

/**
 * The commit this artifact was built from: a 40-char SHA, that SHA with a
 * `-dirty` suffix, or {@link UNKNOWN_SOURCE_COMMIT}.
 *
 * **Read through `try`, not `typeof MACRO !== 'undefined'`.** The bundler
 * substitutes the member expression `MACRO.SOURCE_COMMIT` and leaves a bare
 * `MACRO` alone, so the `typeof` guard compiles into a test that is *false* in
 * every shipped bundle — the two existing users of that idiom
 * (`transcriptWriter.ts`, `doctorDiagnostic.ts`) therefore report `'unknown'`
 * in production even though the define landed right next to them. Catching the
 * ReferenceError is the form that works on both sides: substituted, the `try`
 * body is a string literal; unsubstituted, `MACRO` is simply not a global.
 */
export function sourceCommit(): string {
  try {
    return MACRO.SOURCE_COMMIT || UNKNOWN_SOURCE_COMMIT
  } catch {
    return UNKNOWN_SOURCE_COMMIT
  }
}

/**
 * The version this artifact was built as, or `undefined` when the define was
 * never substituted (tests, a direct `bun src/…`).
 *
 * Read through `try` for the reason spelled out on {@link sourceCommit}: the
 * `typeof MACRO !== 'undefined'` spelling compiles into a test on a bare
 * `MACRO` identifier that the bundler leaves alone, so it answers "not
 * substituted" in a bundle where the substitution plainly happened. Three
 * call sites wrote it that way (transcript entries, `doctor`, the Sentry
 * release tag) and were saved only by an accident of load order —
 * `entrypoints/cli.tsx` used to install a `globalThis.MACRO` fallback, so
 * everything loaded *after* the entry body found the guard true. Anything
 * pulled into the entry's static import graph would not have been, and the
 * fallback itself is gone since issue #81. `scripts/check-macro-guards.ts`
 * fails the build on that spelling.
 *
 * `undefined` rather than `'unknown'`: the callers disagree about what a
 * missing version should look like — a transcript field wants the word, a
 * Sentry release tag wants no tag at all — and that is a display decision each
 * of them already makes.
 */
export function buildVersion(): string | undefined {
  try {
    return MACRO.VERSION || undefined
  } catch {
    return undefined
  }
}

/**
 * ISO-8601 timestamp of when this artifact was built, or `undefined` outside a
 * bundled run. Same `try` contract as {@link buildVersion}.
 */
export function buildTime(): string | undefined {
  try {
    return MACRO.BUILD_TIME || undefined
  } catch {
    return undefined
  }
}
