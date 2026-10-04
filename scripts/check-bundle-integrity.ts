#!/usr/bin/env bun
/**
 * 构建产物完整性检查脚本
 *
 * 检查 Bun.build({ splitting: true }) 输出的 dist/ 目录中是否存在：
 * 1. 引用了不存在的 chunk 文件（断链）
 * 2. 通过 __require() 或 import() 引用的第三方模块（非 Node.js 内置），在生产环境中会找不到
 * 3. 缺失的静态 import 依赖（跨 chunk 引用目标不存在）
 * 4. npm 那份纯 JS 的 `ws` 被内联进 chunk（在 Bun 下握手必失败），
 *    或者反过来 —— 裸 `import ... from "ws"` 从产物里消失了
 * 5. 调用了本 chunk 既未声明、也未 import 的懒初始化包装函数
 *    （`init_*()` / `require_*()`，运行期必抛 ReferenceError）
 *
 * 这些都是静态检查；让主入口真的跑完模块初始化的运行期冒烟在
 * scripts/check-bundle-smoke.ts，`bun run check:bundle` 两个一起跑。
 *
 * 用法：
 *   bun scripts/check-bundle-integrity.ts          # 检查当前 dist/
 *   bun scripts/check-bundle-integrity.ts ./dist    # 指定目录
 */

import { readdir, readFile } from 'fs/promises'
import { dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'

// ─── 从 package.json 读取 dependencies 作为白名单 ────────────────
const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(
  await readFile(join(__dirname, '..', 'package.json'), 'utf-8'),
)
const PKG_DEPS = new Set(Object.keys(pkg.dependencies ?? {}))

// ─── Node.js 内置模块白名单 ────────────────────────────────────────
const NODE_BUILTINS = new Set([
  'assert',
  'async_hooks',
  'buffer',
  'child_process',
  'cluster',
  'console',
  'constants',
  'crypto',
  'dgram',
  'diagnostics_channel',
  'dns',
  'domain',
  'events',
  'fs',
  'fs/promises',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'os',
  'path',
  'perf_hooks',
  'process',
  'punycode',
  'querystring',
  'readline',
  'repl',
  'stream',
  'string_decoder',
  'sys',
  'timers',
  'tls',
  'tty',
  'url',
  'util',
  'v8',
  'vm',
  'worker_threads',
  'zlib',
  'node:test',
])

// Node 18+ 内置但不在传统列表中的模块
const NODE_18_PLUS_BUILTINS = new Set(['undici'])

// Bun 专用模块（仅在 Bun 运行时可用，Node.js 环境会失败）
const BUN_MODULES = new Set(['bun', 'bun:ffi', 'bun:test', 'bun:sqlite'])

// macOS JXA / native 框架（通过 ObjC.import，非真正的 require）
const NATIVE_FRAMEWORKS = new Set([
  'AppKit',
  'CoreGraphics',
  'Foundation',
  'UIKit',
])

// ─── `ws` 必须留在包外 ─────────────────────────────────────────────
// Bun 自带原生 WebSocket 客户端，裸 `import ... from "ws"` 在 Bun 下会解析
// 到它；而 npm 上那份**纯 JS** 的 ws 跑在 Bun 的 node 兼容层上是坏的 ——
// 升级握手处直接抛 `Unexpected server response: 101`、随即 destroy socket，
// 一帧都发不出去（实测：只把内联了 ws 的那个 chunk 换成裸 import，
// `POST /v0/wake` 就从 30 s 超时变成 0.2 s 返回 200）。
//
// 这条检查存在的理由是「结果会随构建机漂移」：同一份 lock、同一份
// vite.config 下，rolldown 在 Linux 上把 ws 留作 external、在 macOS 上把它
// 内联，于是产物能不能建立连接取决于它在谁的机器上构建。逃生阀在
// vite.config.ts 的 `ssr.external`。
//
// 判别串取自 ws 自己的错误码表（lib/receiver.js 的 `WS_ERR_*`）和几条
// 只有 ws 才有的错误文案。**刻意不用** WebSocket 协议的 magic GUID
// `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`：那是协议本身的常量，任何 WS
// 实现都带着它 —— 当前产物里 undici 内置的 WebSocket 就同样命中，拿它
// 当判据等于在 undici 合法入包的那天误杀。
const WS_PACKAGE_MARKERS = [
  'WS_ERR_UNEXPECTED_RSV_1',
  'WS_ERR_INVALID_OPCODE',
  'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH',
  'Invalid Sec-WebSocket-Accept header',
  'Invalid Sec-WebSocket-Extensions header',
  'WebSocket was closed before the connection was established',
  'Opening handshake has timed out',
]
// 单串命中可能是巧合（别的实现抄了同一句文案）；要求同一个文件里凑齐
// 若干条才判定「整个 ws 包被内联了」。
const WS_MARKER_THRESHOLD = 3

// external 之后 rolldown 发出的形态：`import X from"ws"` / `import"ws"` /
// `export ... from"ws"`；`__require("ws")` 那条由上面的第三方 require 检查
// 放行（ws 在 dependencies 里），这里一并认作「留在包外」。
const WS_BARE_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*|require\(\s*)["']ws["']/

// ─── 懒初始化包装函数必须有绑定 ────────────────────────────────────
// rolldown 把需要懒初始化的 ESM 模块包进 `__esmMin`，得到 `init_<模块名>()`；
// CommonJS 模块包进 `__commonJSMin`，得到 `require_<模块名>()`。这些调用是打包
// 器合成的，不是源码写的；跨 chunk 用到时，调用方 chunk 必须把包装函数 import
// 进来。
//
// rolldown 1.0.2–1.1.1 有个回归（rolldown/rolldown#9502、#9515，1.1.2 由 #9717
// 修复）：经命名空间 barrel 转出的包装模块，调用留下了、import 却丢了。本仓库
// 在 a386e4dc（vite 8.0.16 / rolldown 1.0.3）撞上它：zod 的
// `v4/classic/external.js` 经 `import { z } from 'zod'` 读取，main 与 REPL 两个
// chunk 各调用了一次谁都没定义的 `init_external()`，`-p` 与交互入口一启动就
// ReferenceError —— 构建退出码照样是 0，这里原有的四项检查也全绿。
//
// 判据：chunk 里以调用形式出现的 `init_*` / `require_*`，要么在本 chunk 里声明，
// 要么出现在本 chunk 的 import 绑定里。压缩产物中正常绑定的包装函数都已被改名，
// 还保留原名的只可能是自由变量；未压缩产物（Bun 构建）逐个核对绑定。正则只做
// 粗筛，候选再交给 TypeScript 解析器按 AST 复核 —— 字符串、模板、正则字面量里
// 的同形文本（产物里真有 `init_function_start` 这类埋点名）不算。
const WRAPPER_CALL_RE = /(?<![\w$.])((?:init|require)_[\w$]+)\s*\(/g
// `var init_x = …` / `init_x=e(()=>…)` / `function init_x(`
const WRAPPER_DECLARATION_RE =
  /(?<![\w$.])((?:init|require)_[\w$]+)\s*=(?![=>])|\bfunction\s*\*?\s*((?:init|require)_[\w$]+)\s*\(/g
// `import { a as init_x, init_y } from "./chunk.js"`（也认 `import X, { … }`）
const IMPORT_BINDINGS_RE =
  /\bimport\s*(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']/g

// ─── 模式 ──────────────────────────────────────────────────────────
// 匹配 import { ... } from "./chunk-xxxxx.js" 或 import"./chunk-xxxxx.js"
const STATIC_IMPORT_RE = /(?:from\s+|import\s+)"(\.\/[^"]+\.js)"/g
// 匹配 __require("xxx")
const REQUIRE_RE = /__require\("([^"]+)"\)/g
// 匹配动态 import("xxx")，排除 ./chunk-xxx.js 的内部引用
const DYNAMIC_IMPORT_RE = /import\("([^"]+)"\)/g
// 匹配 nodeRequire("xxx")（createRequire 创建的 require 别名）
const NODE_REQUIRE_RE = /nodeRequire\("([^"]+)"\)/g

interface Finding {
  type:
    | 'broken-chunk-ref'
    | 'third-party-require'
    | 'third-party-import'
    | 'third-party-node-require'
    | 'bun-runtime-only'
    | 'unbound-wrapper-call'
  severity: 'error' | 'warning'
  file: string
  line: number
  module: string
  snippet: string
}

/** 本 chunk 里能引用到的包装函数名：import 进来的本地名 + 本 chunk 声明的。 */
function collectBoundWrapperNames(content: string): Set<string> {
  const bound = new Set<string>()
  for (const m of content.matchAll(IMPORT_BINDINGS_RE)) {
    for (const specifier of m[1].split(',')) {
      const local = specifier
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim()
      if (local) bound.add(local)
    }
  }
  for (const m of content.matchAll(WRAPPER_DECLARATION_RE)) {
    const name = m[1] ?? m[2]
    if (name) bound.add(name)
  }
  return bound
}

/**
 * 正则粗筛出的候选按 AST 复核：只保留确实以标识符形式被调用、且全文件没有
 * 任何同名声明的那些。只在有候选时才加载 TypeScript，干净产物不付解析成本。
 */
async function confirmUnboundWrapperCalls(
  content: string,
  candidates: ReadonlySet<string>,
): Promise<Set<string>> {
  const { default: ts } = await import('typescript')
  const source = ts.createSourceFile(
    'chunk.js',
    content,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  )
  const called = new Set<string>()
  const declared = new Set<string>()
  // 显式栈而不是递归：压缩产物里的逗号表达式链可以很深。
  const pending: import('typescript').Node[] = [source]
  while (pending.length > 0) {
    const node = pending.pop()!
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      candidates.has(node.expression.text)
    ) {
      called.add(node.expression.text)
    }
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isImportSpecifier(node) ||
        ts.isImportClause(node) ||
        ts.isNamespaceImport(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      declared.add(node.name.text)
    }
    ts.forEachChild(node, child => {
      pending.push(child)
    })
  }
  return new Set([...called].filter(name => !declared.has(name)))
}

async function listJavaScriptFiles(root: string): Promise<string[]> {
  const files: string[] = []
  const pending = ['']

  while (pending.length > 0) {
    const directory = pending.pop()!
    const entries = await readdir(join(root, directory), {
      withFileTypes: true,
    })
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(path.split(sep).join('/'))
      }
    }
  }

  return files.sort()
}

async function main() {
  const distDir = resolve(process.argv[2] || './dist')

  console.log(`\n🔍 检查构建产物完整性: ${distDir}\n`)

  // 1. 列出根入口和 Vite/Bun 生成的嵌套 chunk 文件。
  let files: string[]
  try {
    files = await listJavaScriptFiles(distDir)
  } catch {
    console.error(`❌ 无法读取目录: ${distDir}`)
    console.error('   请先运行 bun run build')
    process.exit(1)
  }

  const fileSet = new Set(files)
  console.log(`📦 找到 ${files.length} 个 JS 文件\n`)

  const findings: Finding[] = []
  // 见文件顶部 `ws` 一节：既要拦「被内联」，也要拦「裸 import 消失」。
  const wsInlinedIn: { file: string; markers: string[] }[] = []
  const wsBareImportIn: string[] = []

  // 2. 逐文件扫描
  for (const file of files) {
    const filePath = join(distDir, file)
    const content = await readFile(filePath, 'utf-8')
    const lines = content.split('\n')

    const wsMarkers = WS_PACKAGE_MARKERS.filter(marker =>
      content.includes(marker),
    )
    if (wsMarkers.length >= WS_MARKER_THRESHOLD) {
      wsInlinedIn.push({ file, markers: wsMarkers })
    }
    if (WS_BARE_IMPORT_RE.test(content)) wsBareImportIn.push(file)

    // 见文件顶部「懒初始化包装函数必须有绑定」一节。
    const boundWrappers = collectBoundWrapperNames(content)
    const unboundWrapperCalls: Omit<Finding, 'type' | 'severity'>[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const lineNum = i + 1

      for (const m of line.matchAll(WRAPPER_CALL_RE)) {
        const name = m[1]
        if (boundWrappers.has(name)) continue
        const start = Math.max(0, (m.index ?? 0) - 60)
        unboundWrapperCalls.push({
          file,
          line: lineNum,
          module: name,
          snippet: line.slice(start, start + 120).trim(),
        })
      }

      // 2a. 检查静态 chunk 引用是否断链。引用相对于当前 chunk，
      // 不能相对于 dist 根解析：Vite 的绝大多数边都位于 dist/chunks/。
      const staticImportMatches = line.matchAll(STATIC_IMPORT_RE)
      for (const m of staticImportMatches) {
        const ref = m[1]
        const target = relative(distDir, resolve(dirname(filePath), ref))
          .split(sep)
          .join('/')
        if (!fileSet.has(target)) {
          findings.push({
            type: 'broken-chunk-ref',
            severity: 'error',
            file,
            line: lineNum,
            module: ref,
            snippet: line.trim().slice(0, 120),
          })
        }
      }

      // 2b. 检查 __require 中的第三方模块
      const requireMatches = line.matchAll(REQUIRE_RE)
      for (const m of requireMatches) {
        const mod = m[1]
        // 跳过 ObjC.import（JXA 语法，不是真正的 require）
        if (NATIVE_FRAMEWORKS.has(mod)) continue
        if (
          NODE_BUILTINS.has(mod) ||
          NODE_18_PLUS_BUILTINS.has(mod) ||
          PKG_DEPS.has(mod) ||
          mod.startsWith('node:')
        )
          continue
        if (BUN_MODULES.has(mod)) {
          findings.push({
            type: 'bun-runtime-only',
            severity: 'warning',
            file,
            line: lineNum,
            module: mod,
            snippet: line.trim().slice(0, 120),
          })
          continue
        }
        // 第三方模块 — 在生产环境（全局 npm install）中找不到
        findings.push({
          type: 'third-party-require',
          severity: 'error',
          file,
          line: lineNum,
          module: mod,
          snippet: line.trim().slice(0, 120),
        })
      }

      // 2c. 检查动态 import() 中的第三方模块
      const dynImportMatches = line.matchAll(DYNAMIC_IMPORT_RE)
      for (const m of dynImportMatches) {
        const mod = m[1]
        // 跳过内部 chunk 引用和相对路径
        if (mod.startsWith('./') || mod.startsWith('../')) continue
        // 跳过 ObjC.import
        if (NATIVE_FRAMEWORKS.has(mod)) continue
        if (
          NODE_BUILTINS.has(mod) ||
          NODE_18_PLUS_BUILTINS.has(mod) ||
          PKG_DEPS.has(mod) ||
          mod.startsWith('node:')
        )
          continue
        if (BUN_MODULES.has(mod)) {
          // bun:test 等只在 Bun 运行时可用，Node.js 运行时会失败
          findings.push({
            type: 'bun-runtime-only',
            severity: 'warning',
            file,
            line: lineNum,
            module: mod,
            snippet: line.trim().slice(0, 120),
          })
          continue
        }
        // 第三方动态 import
        findings.push({
          type: 'third-party-import',
          severity: 'error',
          file,
          line: lineNum,
          module: mod,
          snippet: line.trim().slice(0, 120),
        })
      }

      // 2d. 检查 nodeRequire("xxx") 中的第三方模块（createRequire 别名）
      const nodeRequireMatches = line.matchAll(NODE_REQUIRE_RE)
      for (const m of nodeRequireMatches) {
        const mod = m[1]
        if (NATIVE_FRAMEWORKS.has(mod)) continue
        if (
          NODE_BUILTINS.has(mod) ||
          NODE_18_PLUS_BUILTINS.has(mod) ||
          PKG_DEPS.has(mod) ||
          mod.startsWith('node:')
        )
          continue
        if (BUN_MODULES.has(mod)) {
          findings.push({
            type: 'bun-runtime-only',
            severity: 'warning',
            file,
            line: lineNum,
            module: mod,
            snippet: line.trim().slice(0, 120),
          })
          continue
        }
        findings.push({
          type: 'third-party-node-require',
          severity: 'error',
          file,
          line: lineNum,
          module: mod,
          snippet: line.trim().slice(0, 120),
        })
      }
    }

    // 2e. 未绑定的包装函数调用：正则候选交给 AST 复核后才算数
    if (unboundWrapperCalls.length > 0) {
      const confirmed = await confirmUnboundWrapperCalls(
        content,
        new Set(unboundWrapperCalls.map(f => f.module)),
      )
      for (const call of unboundWrapperCalls) {
        if (!confirmed.has(call.module)) continue
        findings.push({
          type: 'unbound-wrapper-call',
          severity: 'error',
          ...call,
        })
      }
    }
  }

  // 3. 汇总报告
  const errors = findings.filter(f => f.severity === 'error')
  const warnings = findings.filter(f => f.severity === 'warning')

  // 按 type 分组
  const unboundWrapperCalls = errors.filter(
    f => f.type === 'unbound-wrapper-call',
  )
  const brokenRefs = errors.filter(f => f.type === 'broken-chunk-ref')
  const thirdPartyRequires = errors.filter(
    f => f.type === 'third-party-require',
  )
  const thirdPartyImports = errors.filter(f => f.type === 'third-party-import')
  const thirdPartyNodeRequires = errors.filter(
    f => f.type === 'third-party-node-require',
  )
  const bunRuntimeOnly = warnings.filter(f => f.type === 'bun-runtime-only')

  if (unboundWrapperCalls.length > 0) {
    console.log(
      '❌ 调用了本 chunk 既未声明、也未 import 的懒初始化包装函数（运行期必抛 ReferenceError）:',
    )
    for (const f of unboundWrapperCalls) {
      console.log(`   ${f.file}:${f.line} → ${f.module}()`)
      console.log(`     …${f.snippet}…`)
    }
    console.log(
      `   这类调用是打包器合成的（rolldown 的 __esmMin / __commonJSMin 包装），不是源码写的，
   构建退出码照样是 0。先看 rolldown 版本是否落在已知回归区间（rolldown#9502：
   1.0.2–1.1.1，1.1.2 修复），再对照 vite.config.ts 的分包配置。`,
    )
    console.log()
  }

  if (brokenRefs.length > 0) {
    console.log('❌ 断裂的 chunk 引用（引用了不存在的文件）:')
    for (const f of brokenRefs) {
      console.log(`   ${f.file}:${f.line} → ${f.module}`)
    }
    console.log()
  }

  if (thirdPartyRequires.length > 0) {
    console.log('❌ 通过 __require() 引用的第三方模块（生产环境会找不到）:')
    const grouped = groupByModule(thirdPartyRequires)
    for (const [mod, items] of grouped) {
      console.log(`   "${mod}" — 出现 ${items.length} 次:`)
      for (const f of items.slice(0, 5)) {
        console.log(`     ${f.file}:${f.line}`)
      }
      if (items.length > 5) console.log(`     ... 还有 ${items.length - 5} 处`)
    }
    console.log()
  }

  if (thirdPartyImports.length > 0) {
    console.log('❌ 通过 import() 动态引用的第三方模块（生产环境会找不到）:')
    const grouped = groupByModule(thirdPartyImports)
    for (const [mod, items] of grouped) {
      console.log(`   "${mod}" — 出现 ${items.length} 次:`)
      for (const f of items.slice(0, 5)) {
        console.log(`     ${f.file}:${f.line}`)
      }
      if (items.length > 5) console.log(`     ... 还有 ${items.length - 5} 处`)
    }
    console.log()
  }

  if (thirdPartyNodeRequires.length > 0) {
    console.log(
      '❌ 通过 nodeRequire() 引用的第三方模块（绕过打包，生产环境会找不到）:',
    )
    const grouped = groupByModule(thirdPartyNodeRequires)
    for (const [mod, items] of grouped) {
      console.log(`   "${mod}" — 出现 ${items.length} 次:`)
      for (const f of items.slice(0, 5)) {
        console.log(`     ${f.file}:${f.line}`)
      }
      if (items.length > 5) console.log(`     ... 还有 ${items.length - 5} 处`)
    }
    console.log()
  }

  // 3a. `ws` 外部化状态 —— 两个方向各报各的，说清后果和改法
  let wsErrors = 0
  if (wsInlinedIn.length > 0) {
    wsErrors += wsInlinedIn.length
    console.log('❌ npm 的纯 JS `ws` 包被内联进了产物：')
    for (const { file, markers } of wsInlinedIn) {
      console.log(
        `   ${file} — 命中 ${markers.length}/${WS_PACKAGE_MARKERS.length} 条 ws 独有特征：${markers.slice(0, 3).join(', ')}${markers.length > 3 ? ' …' : ''}`,
      )
    }
    console.log(
      `   后果：这份产物在 Bun 下**每一次 WebSocket 握手都会失败** —— 纯 JS 的 ws
   跑在 Bun 的 node 兼容层上会在升级握手处抛 "Unexpected server response: 101"
   并立刻 destroy socket，节点唤醒表现为 30 s 超时而不是报错。
   改法：确认 vite.config.ts 的 \`ssr.external\` 里有 'ws'（Bun 自带原生 ws，
   必须由运行时解析，不能打进包里）。`,
    )
    console.log()
  }
  if (wsBareImportIn.length === 0) {
    wsErrors += 1
    console.log('❌ 产物里找不到裸 `import ... from "ws"`：')
    console.log(
      `   要么 'ws' 被从 vite.config.ts 的 \`ssr.external\` 里摘掉了（那样它会被
   内联，见上一条），要么源码不再 import 'ws'。前者会让产物在 Bun 下无法
   建立任何 WebSocket 连接；后者是真的删依赖，那就把这条检查一起改掉。`,
    )
    console.log()
  }

  if (bunRuntimeOnly.length > 0) {
    console.log('⚠️  Bun 运行时专用模块（Node.js 环境会失败）:')
    const grouped = groupByModule(bunRuntimeOnly)
    for (const [mod, items] of grouped) {
      console.log(`   "${mod}" — 出现 ${items.length} 次`)
    }
    console.log()
  }

  // 4. 总结
  const errorCount = errors.length + wsErrors
  console.log('─'.repeat(50))
  if (errorCount === 0 && warnings.length === 0) {
    console.log('✅ 构建产物完整性检查通过，未发现问题。')
    console.log(
      `   'ws' 保持 external（裸 import 出现在 ${wsBareImportIn.length} 个文件里，无内联副本）。`,
    )
  } else {
    console.log(`📊 总计: ${errorCount} 个错误, ${warnings.length} 个警告`)
    if (errorCount > 0) {
      console.log(
        `\n💡 修复建议:
   - 第三方模块问题：在 build.ts 中通过 external 选项排除，或确保它们被正确打包到 chunk 中
   - 断链问题：检查 build 时是否有文件被意外删除或构建不完整
   - 未绑定的 init_*/require_* 调用：打包器缺陷，升级到已修复的 rolldown / vite，别在源码里补同名函数
   - Bun 专用模块：确保运行时使用 bun 而非 node`,
      )
    }
  }

  process.exit(errorCount > 0 ? 1 : 0)
}

function groupByModule(items: Finding[]): Map<string, Finding[]> {
  const map = new Map<string, Finding[]>()
  for (const item of items) {
    const list = map.get(item.module) || []
    list.push(item)
    map.set(item.module, list)
  }
  // 按出现次数降序
  return new Map([...map.entries()].sort((a, b) => b[1].length - a[1].length))
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(2)
})
