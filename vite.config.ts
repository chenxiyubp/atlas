import { defineConfig, type Plugin } from 'vite'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'
import { getMacroDefines } from './scripts/defines'
import featureFlagsPlugin from './scripts/vite-plugin-feature-flags'
import importMetaRequirePlugin from './scripts/vite-plugin-import-meta-require'

const projectRoot = dirname(fileURLToPath(import.meta.url))

const acknowledgedBuildWarnings = [
  'src/utils/sandbox/sandbox-adapter.ts',
  'packages/builtin-tools/src/tools/ToolSearchTool/prompt.ts',
  'src/utils/claudemd.ts',
  'src/services/SessionMemory/sessionMemoryUtils.ts',
  'src/commands/logout/logout.tsx',
  'src/utils/sessionStorage.ts',
  'src/utils/swarm/backends/registry.ts',
  'src/utils/toolSearch.ts',
  'src/utils/hooks.ts',
  'src/services/skillLearning/sessionObserver.ts',
  'src/utils/settings/changeDetector.ts',
]

function isAcknowledgedBuildWarning(warning: {
  code?: string
  id?: string
  message?: string
}): boolean {
  if (warning.code === 'EVAL' && warning.id?.includes('@protobufjs+inquire')) {
    return true
  }

  return (
    warning.code === 'INEFFECTIVE_DYNAMIC_IMPORT' &&
    acknowledgedBuildWarnings.some(id => warning.message?.includes(id))
  )
}

/**
 * Plugin to import .md files as raw strings (Bun's text loader behavior).
 */
function rawAssetPlugin(extensions: string[]): Plugin {
  return {
    name: 'raw-asset',
    enforce: 'pre',
    resolveId(id, importer) {
      if (extensions.some(ext => id.endsWith(ext))) {
        // Resolve to actual file path
        return this.resolve(id, importer, { skipSelf: true })
      }
      return null
    },
    load(id) {
      if (extensions.some(ext => id.endsWith(ext))) {
        const content = readFileSync(id, 'utf-8')
        return `export default ${JSON.stringify(content)}`
      }
      return null
    },
  }
}

export default defineConfig({
  // CLI tool — no browser features needed
  appType: 'custom',

  // Tell Vite this is a Node.js build, not browser.
  // Prevents externalization of Node.js builtins (fs, path, etc.)
  ssr: {
    target: 'node',
    noExternal: true,
    // Packages with runtime require.resolve() or WASM binaries can't be
    // inlined into the bundle — they must be resolved from node_modules
    // at runtime.  doubaoime-asr uses opus-encdec which does
    // require.resolve('opus-encdec/dist/libopus-encoder.wasm.js').
    //
    // 'ws' is here for a different reason: it must stay a *bare* import so
    // the runtime picks the implementation.  Bun ships a native WebSocket
    // client behind `import ... from 'ws'`; the pure-JS ws on npm does not
    // survive Bun's node compat layer — it fails at the upgrade handshake
    // with `Unexpected server response: 101` and destroys the socket before
    // a single frame goes out (Node runs that same code fine, so this only
    // bites the Bun entry points).  Left to the resolver, rolldown decides
    // per platform: Linux builds externalise it, macOS builds inline it —
    // i.e. whether a release can open a WebSocket at all depended on which
    // machine produced it.  `bun run check:bundle` asserts both halves of
    // this (no inlined copy, bare import still present).
    external: ['doubaoime-asr', 'opus-encdec', 'ws'],
  },

  build: {
    emptyOutDir: true,
    outDir: 'dist',
    target: 'es2020',
    copyPublicDir: false,
    sourcemap: false,
    minify: true,

    // SSR build mode — uses Rollup with Node.js target
    ssr: true,

    rollupOptions: {
      input: resolve(projectRoot, 'src/entrypoints/cli.tsx'),

      output: {
        format: 'es',
        // Code splitting: Bun/JSC parses the entire single-file bundle eagerly,
        // consuming ~1 GB RSS for a 17 MB output (vs ~220 MB on Node/V8 which
        // lazy-parses). Splitting into chunks allows Bun to load modules on demand,
        // bringing RSS down to ~300 MB.
        entryFileNames: 'cli.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
      },

      plugins: [
        rawAssetPlugin(['.md', '.txt', '.html', '.css']),
        featureFlagsPlugin(),
        importMetaRequirePlugin(),
      ],

      onwarn(warning, defaultHandler) {
        if (isAcknowledgedBuildWarning(warning)) return
        defaultHandler(warning)
      },
    },

    cssCodeSplit: false,
  },

  // Compile-time constant replacement (MACRO.* defines)
  define: {
    ...getMacroDefines(),
    // React production mode — eliminates _debugStack Error objects
    // (6,889 objects × ~1.7KB = 12MB in development builds)
    'process.env.NODE_ENV': JSON.stringify('production'),
  },

  resolve: {
    alias: {
      // src/* path alias (mirrors tsconfig paths)
      'src/': resolve(projectRoot, 'src/'),
    },
    // Ensure workspace packages share a single copy of these
    dedupe: ['react', 'react-reconciler', 'react-compiler-runtime'],
    // Resolve .js imports to .ts files (Bun does this automatically)
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
  },
})
