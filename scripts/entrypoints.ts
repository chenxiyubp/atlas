/**
 * The generated `bin` entrypoints, shared by both builders.
 *
 * `build.ts` (Bun) and `scripts/post-build.ts` (Vite) each emit
 * `dist/cli-bun.js`, `dist/cli-node.js` and `dist/cli-qianmo.js`. They used to
 * write the same one-line `import "./cli.js"` independently, which was harmless
 * while the line was trivial. It stopped being trivial: an entrypoint now has
 * to enter
 * the runtime farm before a single chunk is imported (see
 * src/services/autoUpdate/runtimeFarm.ts), and a builder that missed that
 * would silently produce a bundle whose sessions still break when
 * `install -g` replaces the package directory. One source, no drift.
 */
import { chmodSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  IDENTITY_ENV_VAR,
  NODE_IDENTITY_MODE,
} from '../src/constants/identity.ts'

/**
 * The runtime-farm bootstrap, built separately from the main bundle.
 *
 * It has to run *before* the first chunk is imported (a process cannot re-root
 * its own module resolution afterwards), so it cannot live in the chunk graph
 * it is about to redirect. A standalone, self-contained file — node builtins
 * only, ~7KB — keeps the entrypoint's dependency on it to one static import
 * that resolves next to itself, whichever tree it is running from.
 */
const RUNTIME_FARM_SOURCE = 'src/services/autoUpdate/runtimeFarm.ts'
const RUNTIME_FARM_OUTPUT = 'runtime-farm.js'

async function buildRuntimeFarmBootstrap(outdir: string): Promise<void> {
  const built = await Bun.build({
    entrypoints: [RUNTIME_FARM_SOURCE],
    target: 'node',
    format: 'esm',
    minify: true,
  })
  if (!built.success || !built.outputs[0]) {
    throw new Error(`runtime-farm bootstrap build failed: ${built.logs}`)
  }
  await writeFile(
    join(outdir, RUNTIME_FARM_OUTPUT),
    await built.outputs[0].text(),
  )
}

/**
 * An entrypoint hands control to the farm, which imports the real `cli.js`
 * from wherever it ended up. The version is stamped in here rather than read
 * from package.json at startup: it names the farm directory, and a file read
 * on the startup path would cost more than the two stats the whole mechanism
 * is budgeted at.
 */
function entrypointSource(shebang: string, version: string): string {
  return [
    shebang,
    `import { enterRuntimeFarm } from './${RUNTIME_FARM_OUTPUT}'`,
    `await enterRuntimeFarm(import.meta.url, ${JSON.stringify(version)})`,
    '',
  ].join('\n')
}

/**
 * The Qianmo node's own entrypoint: same farm handoff, with the identity
 * pinned in the file.
 *
 * WHY A THIRD FILE RATHER THAN A THIRD `bin` NAME ON AN EXISTING ONE
 *
 * `qm` cannot learn it is `qm` from argv. Bun resolves a symlinked entry
 * before it fills `process.argv[1]`, so a `bin` symlink arrives as the target
 * path; a Windows `.cmd` shim passes the `.js` path for the same net effect;
 * and a bundled-mode child gets a CLI argument in that slot. Every one of
 * those silently drops the node back to occ's config root — the exact failure
 * the three-way isolation exists to prevent. A file whose *contents* say which
 * identity it is has no such gap: it does not matter how it was reached.
 *
 * Bun shebang, not node: `console` and `resident` assert the Bun runtime, so a
 * node-shebang `qm` would install fine and then refuse to start.
 *
 * TWO THINGS HERE ARE LOAD-BEARING AND LOOK LIKE STYLE
 *
 * 1. `await import(...)`, NOT a static import. ESM hoists static imports and
 *    evaluates them before any statement in this module body, so the farm —
 *    which resolves the config root through the identity — would initialise
 *    BEFORE the assignment and farm into the wrong tree. The dynamic import is
 *    what orders the two.
 * 2. `??=`, NOT `=`. An explicit `OCC_IDENTITY=occ qm …` must still mean occ;
 *    the entrypoint supplies a default, it does not overrule the caller.
 */
function identityPinnedEntrypointSource(
  shebang: string,
  version: string,
  identity: string,
): string {
  return [
    shebang,
    `process.env.${IDENTITY_ENV_VAR} ??= ${JSON.stringify(identity)}`,
    `const { enterRuntimeFarm } = await import('./${RUNTIME_FARM_OUTPUT}')`,
    `await enterRuntimeFarm(import.meta.url, ${JSON.stringify(version)})`,
    '',
  ].join('\n')
}

/**
 * Write the three executable entrypoints, and nothing else.
 *
 * Split out from {@link writeEntrypoints} so it can be exercised directly:
 * this half is pure string-formatting plus three writes, while the other half
 * runs `Bun.build`, and an in-process `Bun.build` is not hermetic under
 * `bun test` — it shares the runner's module registry and has been observed
 * parsing one module's bytes under another module's path. Testing what the
 * entrypoints SAY must not require bundling the bootstrap they hand off to.
 *
 * 0o755 on every one of them: a `bin` target the package manager links into
 * PATH and cannot execute is indistinguishable from a failed install.
 */
export async function writeEntrypointFiles(
  outdir: string,
  version: string,
): Promise<void> {
  const cliBun = join(outdir, 'cli-bun.js')
  const cliNode = join(outdir, 'cli-node.js')
  const cliQianmo = join(outdir, 'cli-qianmo.js')
  await writeFile(cliBun, entrypointSource('#!/usr/bin/env bun', version))
  await writeFile(cliNode, entrypointSource('#!/usr/bin/env node', version))
  await writeFile(
    cliQianmo,
    identityPinnedEntrypointSource(
      '#!/usr/bin/env bun',
      version,
      NODE_IDENTITY_MODE,
    ),
  )
  chmodSync(cliBun, 0o755)
  chmodSync(cliNode, 0o755)
  chmodSync(cliQianmo, 0o755)
}

/** Emit `runtime-farm.js` plus all three executable entrypoints into `outdir`. */
export async function writeEntrypoints(outdir: string): Promise<string> {
  const { version } = JSON.parse(await readFile('package.json', 'utf-8')) as {
    version: string
  }
  await buildRuntimeFarmBootstrap(outdir)
  await writeEntrypointFiles(outdir, version)
  return version
}
