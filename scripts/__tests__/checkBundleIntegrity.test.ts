import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, '..', 'check-bundle-integrity.ts')
let root: string | null = null

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

async function createDist(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'occ-bundle-integrity-'))
  for (const [path, content] of Object.entries(files)) {
    const filePath = join(root, path)
    await mkdir(join(filePath, '..'), { recursive: true })
    await writeFile(filePath, content)
  }
  return root
}

function runCheck(distDir: string) {
  return spawnSync('bun', [scriptPath, distDir], {
    encoding: 'utf8',
  })
}

// `ws` must stay external, so every fixture that is supposed to *pass* has to
// carry the bare import a real bundle carries — see the `ws` block in
// check-bundle-integrity.ts for why the check exists.
const WS_BARE_IMPORT = 'import WebSocket from "ws"\n'

describe('check-bundle-integrity nested chunks', () => {
  test('accepts valid imports between nested Vite chunks', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': 'import "./shared.js"\n',
      'chunks/shared.js': `export const value = 1\n${WS_BARE_IMPORT}`,
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('找到 3 个 JS 文件')
  })

  test('rejects a missing import from a nested chunk', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': 'import "./missing.js"\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('chunks/entry.js:1 → ./missing.js')
  })

  test('scans nested chunks for unresolved runtime dependencies', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': '__require("missing-production-package")\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('missing-production-package')
    expect(result.stdout).toContain('chunks/entry.js:1')
  })
})

describe('check-bundle-integrity lazy-init wrapper bindings', () => {
  // v2.46.1 的真实形态（rolldown 1.0.3，rolldown#9502）：zod 的 external.js
  // 在 v4 chunk 里定义成 `Bm`、没导出，main chunk 却以原名调用它。
  test('rejects a chunk that calls an init wrapper it never imports', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/main.js"\n',
      'chunks/v4.js': `var Bm=e(()=>{config()}),Wm=e(()=>{Bm()});export{Wm as t}\n${WS_BARE_IMPORT}`,
      'chunks/main.js':
        'import{t as x}from"./v4.js";x();I(),init_external(),Mr();\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('既未声明、也未 import 的懒初始化包装函数')
    expect(result.stdout).toContain('chunks/main.js:1 → init_external()')
  })

  test('also rejects an unbound CommonJS require_* wrapper call', async () => {
    const distDir = await createDist({
      'cli.js': `require_lodash();\n${WS_BARE_IMPORT}`,
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('cli.js:1 → require_lodash()')
  })

  // 未压缩产物（Bun 构建）保留原名：声明过或 import 进来的都合法。
  test('accepts wrappers that are declared locally or imported', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/shared.js': [
        'var init_shared = __esm(() => {});',
        'function init_other() {}',
        'var require_cjs = __commonJS(() => {});',
        'export { init_shared, init_other, require_cjs };',
        WS_BARE_IMPORT,
      ].join('\n'),
      'chunks/entry.js': [
        'import { init_shared, init_other as init_renamed, require_cjs } from "./shared.js";',
        'init_shared();',
        'init_renamed();',
        'require_cjs();',
      ].join('\n'),
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('懒初始化包装函数')
  })

  // 产物里真有 `init_function_start` 这类埋点名；字符串、模板、注释、属性访问
  // 里的同形文本都不是调用。正则会把前三种当候选，交给 AST 复核后排除。
  test('ignores look-alikes inside strings, templates, comments and member calls', async () => {
    const distDir = await createDist({
      'cli.js': [
        'const doc = "call init_database() first";',
        'const tpl = `run init_template() now`;',
        '// init_comment() is not code',
        'const re = /init_regex\\(/;',
        'profiler.init_member();',
        WS_BARE_IMPORT,
      ].join('\n'),
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('懒初始化包装函数')
  })
})

describe('check-bundle-integrity ws externalisation', () => {
  // npm 的纯 JS ws 混进产物 = 这份产物在 Bun 下每次握手都失败。样本用
  // ws 自己的错误码表，和真产物里出现的是同一批串。
  const INLINED_WS =
    'const codes={WS_ERR_UNEXPECTED_RSV_1:1002,WS_ERR_INVALID_OPCODE:1002,' +
    'WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH:1009};' +
    'throw new Error("Invalid Sec-WebSocket-Accept header")\n'

  test('rejects a bundle that inlined the npm ws package', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': INLINED_WS,
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('npm 的纯 JS `ws` 包被内联进了产物')
    expect(result.stdout).toContain('chunks/entry.js')
  })

  test('rejects a bundle where the bare ws import disappeared', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js': 'export const value = 1\n',
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('产物里找不到裸 `import ... from "ws"`')
  })

  // 那个 GUID 是 WebSocket 协议本身的 magic string —— undici 内置的
  // WebSocket 实现同样带着它。拿它当判据会在 undici 合法入包时误杀，
  // 所以判据只认 ws 自己的错误码表。
  test('does not fire on another WebSocket implementation', async () => {
    const distDir = await createDist({
      'cli.js': 'import "./chunks/entry.js"\n',
      'chunks/entry.js':
        'const uid="258EAFA5-E914-47DA-95CA-C5AB0DC85B11";' +
        'function createFastMessageEvent(){}' +
        'const sentCloseFrameState=0;' +
        'const h="Sec-WebSocket-Extensions";' +
        `export{uid,h,createFastMessageEvent,sentCloseFrameState}\n${WS_BARE_IMPORT}`,
    })

    const result = runCheck(distDir)

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('被内联进了产物')
  })
})
