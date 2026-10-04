// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P6.3 —— MCP 兼容子集核验：occ 作为 **MCP 客户端**，对着两个**第三方现成
 * server** 跑发现、调用与降级。
 *
 * ## 两个对端是谁
 *
 * - `@modelcontextprotocol/server-filesystem`（根 package.json 精确 pin）
 * - `@modelcontextprotocol/server-memory`（同上）
 *
 * 两个都不是我们写的，也不是我们改的：它们从 npm 装进 `node_modules`，以
 * `<bun> <dist/index.js>` 直接 spawn。本文件里唯一属于我们的"server"是
 * `fixtures/mcp-crash-server.ts`，它是**故障夹具**而不是交付物——没有哪个
 * 行为正常的 server 能按测试的要求在指定时刻自杀或装死，D3 与超时两条用例
 * 需要那样一个对端。区分见夹具文件顶部注释。
 *
 * ## 核验停在哪
 *
 * 停在 occ 的工具发现层与 `Tool.call` 的真实执行层：真进程、真 stdio、真
 * 落盘。**不接模型**——"模型能不能挑对工具"是 P1.4 已经证过的事，在这里重
 * 复一遍只会把一个确定性用例变成一个要付 token 的抽卡用例。
 *
 * ## 零 mock
 *
 * 本文件没有任何 `mock.module`。跨文件 mock 污染是 tests/integration 分片
 * 单进程模式下最贵的故障，而这里被测的恰好是"真的能不能连上真的进程"，
 * 任何替身都会把结论掏空。
 *
 * ## 脚手架纪律
 *
 * 分片内所有测试文件共用一个进程，所以：三个临时目录、`OCC_CONFIG_DIR`、
 * `MCP_TIMEOUT`、`originalCwd`、`unhandledRejection` 监听器全部 beforeAll
 * 设置、afterAll 成对还原；每个连上的 server 都进 `liveConnections`，
 * afterAll 逐个 `cleanup()`（`connectToServer` 按 name+config JSON memoize
 * 并挂在全局清理表上，不清就会跨用例串味 + 泄漏子进程）。
 *
 * 时序断言遵守 a8b06a9 的教训：正向结论一律等真实事件/Promise，只有"某事
 * 不该发生"这类反向结论才睡一个固定窗口。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Tool } from '../../src/Tool.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../src/services/mcp/types.js'

// `getMcpToolsCommandsAndResources` 的模块图在加载期就读 `MACRO`（版本号进
// User-Agent），所以 define 必须先于第一次 import 存在。写法照抄
// src/entrypoints/__tests__/mcp.test.ts。
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

const { connectToServer, getMcpToolsCommandsAndResources } = await import(
  '../../src/services/mcp/client.js'
)
const { getOriginalCwd, setOriginalCwd } = await import(
  '../../src/bootstrap/state/session.js'
)
const { createAssistantMessage } = await import('../../src/utils/messages.js')

/** bunfig 的默认 timeout 是 10s，spawn 一个真 server 就能吃掉大半。 */
const CASE_TIMEOUT_MS = 60_000

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// 一律 `process.execPath` + dist 绝对路径：node_modules/.bin 下的 shebang
// 软链在不同安装布局下指向不同解释器，spawn 失败时的报错还会伪装成协议错误。
const FS_SERVER_ENTRY = join(
  REPO_ROOT,
  'node_modules/@modelcontextprotocol/server-filesystem/dist/index.js',
)
const MEMORY_SERVER_ENTRY = join(
  REPO_ROOT,
  'node_modules/@modelcontextprotocol/server-memory/dist/index.js',
)
const CRASH_FIXTURE_ENTRY = join(
  REPO_ROOT,
  'tests/integration/fixtures/mcp-crash-server.ts',
)

type Attempt = { client: MCPServerConnection; tools: Tool[] }

/** 每个连上的 server 都要进这里，afterAll 逐个关掉。 */
const liveConnections = new Set<{ cleanup: () => Promise<void> }>()

const savedEnv = new Map<string, string | undefined>()
function overrideEnv(key: string, value: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key])
  process.env[key] = value
}

let configDir = ''
let sandboxDir = ''
let memoryDir = ''
let cliOnlyDir = ''
let memoryFile = ''
let cliOnlyFile = ''
let savedOriginalCwd = ''

const unhandledRejections: unknown[] = []
const collectUnhandledRejection = (reason: unknown): void => {
  unhandledRejections.push(reason)
}

function stdioConfig(
  args: string[],
  extra: {
    env?: Record<string, string>
    request_timeout_ms?: number
  } = {},
): ScopedMcpServerConfig {
  return {
    type: 'stdio',
    command: process.execPath,
    args,
    scope: 'local',
    ...extra,
  }
}

let fsConfig: ScopedMcpServerConfig
let memoryConfig: ScopedMcpServerConfig
let crashConfig: ScopedMcpServerConfig

/**
 * 走生产入口做一次发现。第二参直接吃 config record，所以整套用例不落盘任何
 * `.mcp.json`，也就不会碰到开发机上真实的 MCP 配置。
 */
async function discover(
  configs: Record<string, ScopedMcpServerConfig>,
): Promise<Attempt[]> {
  const attempts: Attempt[] = []
  await getMcpToolsCommandsAndResources(({ client, tools }) => {
    attempts.push({ client, tools })
    if (client.type === 'connected') liveConnections.add(client)
  }, configs)
  return attempts
}

function attemptFor(attempts: Attempt[], name: string): Attempt {
  const attempt = attempts.find(a => a.client.name === name)
  if (!attempt) {
    throw new Error(
      `no connection attempt reported for "${name}" (got: ${attempts
        .map(a => a.client.name)
        .join(', ')})`,
    )
  }
  return attempt
}

function toolNamed(tools: Tool[], name: string): Tool {
  const tool = tools.find(t => t.name === name)
  if (!tool) {
    throw new Error(
      `tool "${name}" not found (got: ${tools.map(t => t.name).join(', ')})`,
    )
  }
  return tool
}

/**
 * MCP 工具从不查这个回调（权限在 `checkPermissions` 里走 passthrough），所以
 * 它被调用本身就是回归信号——让它炸，而不是悄悄放行。
 */
const canUseToolMustNotBeCalled = (() => {
  throw new Error('canUseTool was called: MCP tools must not consult it')
}) as unknown as Parameters<Tool['call']>[2]

function toolCallContext(): Parameters<Tool['call']>[1] {
  return {
    abortController: new AbortController(),
    setAppState: () => {},
  } as unknown as Parameters<Tool['call']>[1]
}

/**
 * 把一次 MCP 调用的结果压成文本。
 *
 * 两种形状都要接：占多数的是 content block 数组；但只要 server 回了
 * `structuredContent`，occ 的 `transformMCPResult` 就**优先用它**，把整个
 * 结构 `jsonStringify` 成一个字符串交出来，content 数组根本不看
 * （src/services/mcp/client.ts）。这两台 server 的工具几乎都声明了
 * outputSchema，所以走的都是后一条路——见实测记录里的互操作条目。
 */
function contentText(data: unknown): string {
  if (typeof data === 'string') return data
  if (!Array.isArray(data)) return JSON.stringify(data)
  return data
    .map(block =>
      block !== null && typeof block === 'object' && 'text' in block
        ? String((block as { text: unknown }).text)
        : JSON.stringify(block),
    )
    .join('\n')
}

/**
 * 从上面那条 structuredContent 路径里取回某个字段的原文。逐字节比对必须拿
 * 到字段本身，拿 JSON 串比对等于顺带断言了序列化写法。
 */
function structuredField(raw: string, field: string): string {
  const parsed: unknown = JSON.parse(raw)
  const value =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)[field]
      : undefined
  if (typeof value !== 'string') {
    throw new Error(
      `structuredContent 里没有字符串字段 "${field}"：${raw.slice(0, 200)}`,
    )
  }
  return value
}

async function callTool(
  tool: Tool,
  args: Record<string, unknown>,
): Promise<string> {
  const result = await tool.call(
    args as never,
    toolCallContext(),
    canUseToolMustNotBeCalled,
    createAssistantMessage({ content: [] }),
  )
  return contentText(result.data)
}

/**
 * 服务端的业务错误可能以 `isError` 结果回来，也可能被 SDK 抬成异常。判"被
 * 拒绝了"时两条路都算数。
 */
async function callToolCapturingError(
  tool: Tool,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    return await callTool(tool, args)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'qianmo-p63-config-'))
  // realpath：macOS 的 /var/folders 是到 /private/var/folders 的软链，而
  // filesystem server 对命令行目录和 roots 都做 realpath 归一化，不先解开
  // 的话"允许目录"断言会比对到两个不同写法的同一个目录。
  sandboxDir = await realpath(await mkdtemp(join(tmpdir(), 'qianmo-p63-fs-')))
  memoryDir = await realpath(await mkdtemp(join(tmpdir(), 'qianmo-p63-mem-')))
  cliOnlyDir = await realpath(await mkdtemp(join(tmpdir(), 'qianmo-p63-cli-')))
  memoryFile = join(memoryDir, 'memory.jsonl')
  cliOnlyFile = join(cliOnlyDir, 'cli-only.txt')
  await writeFile(cliOnlyFile, 'only reachable via the command-line dir\n')

  overrideEnv('OCC_CONFIG_DIR', configDir)
  // 连接超时的兜底默认是 30s。用例里有两条故意连不上的 server，等 30s 会把
  // 整个分片拖垮，也会让"走的是快路还是兜底"无法分辨。
  overrideEnv('MCP_TIMEOUT', '5000')

  // occ 无条件通告 roots 能力，并用 `file://getOriginalCwd()` 回答
  // `roots/list`（src/services/mcp/client.ts 的 roots/list handler）。把它对
  // 齐到沙箱，两条通道才说的是同一个目录——第 ③ 条用例专门钉这件事。
  savedOriginalCwd = getOriginalCwd()
  setOriginalCwd(sandboxDir)

  process.on('unhandledRejection', collectUnhandledRejection)

  fsConfig = stdioConfig([FS_SERVER_ENTRY, sandboxDir])
  memoryConfig = stdioConfig([MEMORY_SERVER_ENTRY], {
    // 不覆盖就往 node_modules 里写：memory server 的默认库路径是它自己的
    // dist 目录。
    env: { MEMORY_FILE_PATH: memoryFile },
  })
  crashConfig = stdioConfig([CRASH_FIXTURE_ENTRY])
})

afterAll(async () => {
  for (const connection of liveConnections) {
    await connection.cleanup()
  }
  liveConnections.clear()

  process.off('unhandledRejection', collectUnhandledRejection)

  setOriginalCwd(savedOriginalCwd)
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv.clear()

  for (const dir of [configDir, sandboxDir, memoryDir, cliOnlyDir]) {
    if (dir) await rm(dir, { recursive: true, force: true })
  }
})

describe('P6.3 MCP 兼容子集：第三方 server 的发现与调用', () => {
  test(
    '① filesystem server 的工具被发现，并带上 occ 侧的 MCP 元信息',
    async () => {
      const attempts = await discover({ fs: fsConfig })
      const { client, tools } = attemptFor(attempts, 'fs')

      expect(client.type).toBe('connected')

      const names = tools.map(t => t.name)
      expect(names).toContain('mcp__fs__read_text_file')
      expect(names).toContain('mcp__fs__write_file')
      expect(names).toContain('mcp__fs__list_directory')

      // 前缀之外的那几个（资源工具）不是这台 server 的工具，不参与断言。
      const fsTools = tools.filter(t => t.name.startsWith('mcp__fs__'))
      expect(fsTools.length).toBeGreaterThanOrEqual(3)
      for (const tool of fsTools) {
        expect(tool.isMcp).toBe(true)
        expect(tool.inputJSONSchema?.type).toBe('object')
        expect(tool.mcpInfo?.serverName).toBe('fs')
      }
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '② filesystem 写—读闭环：MCP 通道读回逐字节相等，node:fs 直读再证一次',
    async () => {
      const attempts = await discover({ fs: fsConfig })
      const { tools } = attemptFor(attempts, 'fs')

      const target = join(sandboxDir, 'p63-round-trip.txt')
      const payload = '阡陌 P6.3 round trip\nsecond line\ttab\n'

      const wrote = await callTool(toolNamed(tools, 'mcp__fs__write_file'), {
        path: target,
        content: payload,
      })
      expect(wrote).toContain('p63-round-trip.txt')

      const readBack = await callTool(
        toolNamed(tools, 'mcp__fs__read_text_file'),
        { path: target },
      )
      expect(structuredField(readBack, 'content')).toBe(payload)

      // 第二重证据：绕开整条 MCP 通道直读同一路径。只信 read_text_file 的
      // 话，一个把写入丢进内存的 server 也能让用例变绿。
      expect(await readFile(target, 'utf8')).toBe(payload)
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '③ roots 互操作：occ 通告的 roots 整体顶掉 server 命令行上的允许目录',
    async () => {
      // 这台 server 的命令行只给了 cliOnlyDir，而 occ 会在 initialize 之后
      // 回一个 roots=[file://sandboxDir]。filesystem server 的
      // `updateAllowedDirectoriesFromRoots` 是**替换**而不是合并。
      const attempts = await discover({
        fsroots: stdioConfig([FS_SERVER_ENTRY, cliOnlyDir]),
      })
      const { client, tools } = attemptFor(attempts, 'fsroots')
      expect(client.type).toBe('connected')

      const allowed = await callTool(
        toolNamed(tools, 'mcp__fsroots__list_allowed_directories'),
        {},
      )
      expect(allowed).toContain(sandboxDir)
      expect(allowed).not.toContain(cliOnlyDir)

      // 顶掉是真的顶掉：命令行上那个目录里的文件已经读不到了。
      const denied = await callToolCapturingError(
        toolNamed(tools, 'mcp__fsroots__read_text_file'),
        { path: cliOnlyFile },
      )
      expect(denied).toMatch(/access denied|allowed directories/i)

      // 而 roots 给的目录可以读。
      const reachable = join(sandboxDir, 'p63-roots-reachable.txt')
      await writeFile(reachable, 'reachable through roots\n')
      const reachableText = await callTool(
        toolNamed(tools, 'mcp__fsroots__read_text_file'),
        { path: reachable },
      )
      expect(structuredField(reachableText, 'content')).toBe(
        'reachable through roots\n',
      )
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '④ memory server 的工具被发现',
    async () => {
      const attempts = await discover({ mem: memoryConfig })
      const { client, tools } = attemptFor(attempts, 'mem')

      expect(client.type).toBe('connected')

      const names = tools.map(t => t.name)
      expect(names).toContain('mcp__mem__create_entities')
      expect(names).toContain('mcp__mem__read_graph')
      expect(names).toContain('mcp__mem__search_nodes')

      for (const tool of tools.filter(t => t.name.startsWith('mcp__mem__'))) {
        expect(tool.isMcp).toBe(true)
        expect(tool.inputJSONSchema?.type).toBe('object')
      }
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑤ memory 写—读闭环：create → read_graph 命中 → JSONL 落在我们指定的路径',
    async () => {
      const attempts = await discover({ mem: memoryConfig })
      const { tools } = attemptFor(attempts, 'mem')

      await callTool(toolNamed(tools, 'mcp__mem__create_entities'), {
        entities: [
          {
            name: 'qianmo-node-alpha',
            entityType: 'qianmo-node',
            observations: ['P6.3 conformance run'],
          },
        ],
      })

      const graph = await callTool(toolNamed(tools, 'mcp__mem__read_graph'), {})
      expect(graph).toContain('qianmo-node-alpha')
      expect(graph).toContain('P6.3 conformance run')

      const found = await callTool(toolNamed(tools, 'mcp__mem__search_nodes'), {
        query: 'qianmo-node-alpha',
      })
      expect(found).toContain('qianmo-node-alpha')

      // 落盘证据，并且落在 stdio config 的 env 指定的位置——默认路径在
      // node_modules 里，那既污染依赖目录又会让两次跑批互相看见对方的数据。
      const jsonl = await readFile(memoryFile, 'utf8')
      expect(jsonl).toContain('qianmo-node-alpha')
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑥ 两个 server 同时在线：工具前缀各归各，写入互不串扰',
    async () => {
      const attempts = await discover({ fs: fsConfig, mem: memoryConfig })
      expect(attempts).toHaveLength(2)
      for (const { client } of attempts) expect(client.type).toBe('connected')

      const fsNames = attemptFor(attempts, 'fs').tools.map(t => t.name)
      const memNames = attemptFor(attempts, 'mem').tools.map(t => t.name)
      expect(fsNames.some(n => n.startsWith('mcp__fs__'))).toBe(true)
      expect(memNames.some(n => n.startsWith('mcp__mem__'))).toBe(true)
      expect(fsNames.some(n => n.startsWith('mcp__mem__'))).toBe(false)
      expect(memNames.some(n => n.startsWith('mcp__fs__'))).toBe(false)

      const marker = 'crosstalk-marker-6c1f'
      const crossFile = join(sandboxDir, 'p63-crosstalk.txt')
      await callTool(
        toolNamed(attemptFor(attempts, 'fs').tools, 'mcp__fs__write_file'),
        { path: crossFile, content: marker },
      )
      await callTool(
        toolNamed(
          attemptFor(attempts, 'mem').tools,
          'mcp__mem__create_entities',
        ),
        {
          entities: [
            {
              name: 'crosstalk-entity',
              entityType: 'probe',
              observations: ['written while the filesystem server was live'],
            },
          ],
        },
      )

      expect(await readFile(crossFile, 'utf8')).toBe(marker)
      const jsonl = await readFile(memoryFile, 'utf8')
      expect(jsonl).toContain('crosstalk-entity')
      expect(jsonl).not.toContain(marker)

      // 反过来也查一遍：memory 的库没有落进 filesystem 的沙箱。
      const listing = await callTool(
        toolNamed(attemptFor(attempts, 'fs').tools, 'mcp__fs__list_directory'),
        { path: sandboxDir },
      )
      expect(listing).toContain('p63-crosstalk.txt')
      expect(listing).not.toContain('memory.jsonl')
    },
    CASE_TIMEOUT_MS,
  )
})

describe('P6.3 降级：server 不可用时不崩溃', () => {
  test(
    '⑦ D1 进程根本不存在：发现流程照常 resolve，坏 server 标 failed，同批健康 server 不受影响',
    async () => {
      const attempts = await discover({
        ghost: {
          type: 'stdio',
          command: join(sandboxDir, 'definitely-not-an-executable'),
          args: [],
          scope: 'local',
        },
        fs: fsConfig,
      })

      const ghost = attemptFor(attempts, 'ghost')
      expect(ghost.client.type).toBe('failed')
      expect(ghost.tools).toHaveLength(0)
      if (ghost.client.type === 'failed') {
        expect(ghost.client.error ?? '').toMatch(/ENOENT|spawn/i)
      }

      // 降级的判据不是"坏的那个坏了"，是"坏的那个没有拖垮好的那个"。
      const healthy = attemptFor(attempts, 'fs')
      expect(healthy.client.type).toBe('connected')
      expect(
        healthy.tools.some(t => t.name === 'mcp__fs__read_text_file'),
      ).toBe(true)
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑧ D2 启动即退出：走 ConnectionClosed 快路而不是超时兜底',
    async () => {
      // 真的 filesystem server，只是命令行给了一个不存在的允许目录——它自己
      // 会在 connect 之前 process.exit(1)。
      const suicideConfig = stdioConfig([
        FS_SERVER_ENTRY,
        join(sandboxDir, 'never-created-directory'),
      ])

      const startedAt = Date.now()
      const attempts = await discover({
        suicide: suicideConfig,
        fs: fsConfig,
      })
      const elapsedMs = Date.now() - startedAt

      const suicide = attemptFor(attempts, 'suicide')
      expect(suicide.client.type).toBe('failed')
      expect(suicide.tools).toHaveLength(0)
      // 具体错误文本不断言：那是 SDK 的措辞，会随版本变。要钉的是**快**——
      // MCP_TIMEOUT 兜底是 5000ms，落在 4000ms 以内就说明走的是传输层
      // ConnectionClosed，而不是等到超时。
      expect(elapsedMs).toBeLessThan(4000)

      expect(attemptFor(attempts, 'fs').client.type).toBe('connected')
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑨ D3 在飞调用时对端被杀：调用抛错但不挂死，再次调用自动重连',
    async () => {
      const attempts = await discover({ crash: crashConfig })
      const { client, tools } = attemptFor(attempts, 'crash')
      expect(client.type).toBe('connected')

      const ping = toolNamed(tools, 'mcp__crash__ping')
      expect(await callTool(ping, {})).toContain('pong')

      // `die` 不回包、直接退进程：在飞的请求必须以"连接断了"收场。
      await expect(
        callTool(toolNamed(tools, 'mcp__crash__die'), {}),
      ).rejects.toThrow(/connection closed/i)

      // 自愈：onclose 清掉了 memoize 缓存，同一个 Tool 对象再调一次，
      // ensureConnectedClient 会重新拉起进程。
      expect(await callTool(ping, {})).toContain('pong')

      // 重连出来的是一个新的连接对象，Tool 闭包里那个已经死了——把活的那个
      // 捞出来登记，否则 afterAll 关不掉它（memoize 命中，不会新起进程）。
      const healed = await connectToServer('crash', crashConfig)
      if (healed.type === 'connected') liveConnections.add(healed)

      // 反向结论（"没有漏网的 rejection"）才睡固定窗口：unhandledRejection
      // 是下一个 microtask checkpoint 之后才派发的，等的是它不出现。
      await new Promise(resolve => setTimeout(resolve, 250))
      expect(unhandledRejections).toEqual([])
    },
    CASE_TIMEOUT_MS,
  )

  test(
    '⑩ 逐 server 的 request_timeout_ms 生效：装死的工具在约定时间被掐断',
    async () => {
      // 默认工具超时是 100_000_000ms（≈27.8 小时），等于没有超时。要让一个
      // 装死的 server 可控地失败，只能逐 server 配 request_timeout_ms。
      const attempts = await discover({
        slow: stdioConfig([CRASH_FIXTURE_ENTRY], { request_timeout_ms: 3000 }),
      })
      const { client, tools } = attemptFor(attempts, 'slow')
      expect(client.type).toBe('connected')

      const startedAt = Date.now()
      await expect(
        callTool(toolNamed(tools, 'mcp__slow__hang'), {}),
      ).rejects.toThrow(/timed out/i)
      const elapsedMs = Date.now() - startedAt

      expect(elapsedMs).toBeGreaterThanOrEqual(2500)
      expect(elapsedMs).toBeLessThan(10_000)
    },
    CASE_TIMEOUT_MS,
  )
})
