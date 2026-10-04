#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 构建产物运行期冒烟：让主入口真的走完模块初始化，一直走到网络层。
 *
 * 为什么光有 check-bundle-integrity.ts 不够
 *
 * 那边是静态检查：文件在不在、裸 import 对不对、懒初始化包装函数有没有绑定。
 * 它抓得住已知形态，抓不住下一种。v2.46.1 的产物就是静态检查全绿、构建退出码
 * 为 0、`--version` 也能跑，而 `-p` 与交互入口一启动就崩（经过见那个文件的
 * 「懒初始化包装函数必须有绑定」一节）。不依赖「先猜到坏法」的判据只有一个：
 * 真跑一次，而且跑的是会加载整张启动 chunk 图的那条路径。
 *
 * 怎么跑
 *
 * 对每个入口（`cli-node.js` 是 occ 身份，`cli-qianmo.js` 是阡陌身份）用当前
 * 这个 Bun 执行一次 `-p`。provider 指向本进程起的假 Anthropic 端点，它对任何
 * 请求都立刻回 400（不可重试），CLI 随即以 API 错误退出。runtime farm 关掉，
 * 跑的就是被检查的这份 dist，不是它在配置目录里的副本。
 *
 * 判定（全部满足才算过）
 *
 * ① 假 provider 收到了 `POST /v1/messages`：入口走完了全部模块初始化，真的发出
 *    了模型请求。只断言「没有 ReferenceError」不够 —— 换一种死法就漏了。
 * ② 输出里没有模块初始化失败的签名（ReferenceError / is not defined /
 *    before initialization …）。这一条覆盖请求之后才加载的错误渲染路径。
 * ③ 进程在时限内自己退出。
 * ④ 代理陷阱一次连接都没收到；到达假 provider 的凭据只有本脚本发的假 key。
 *
 * 隔离：不发真实网络请求、不读真实凭据
 *
 * - 子进程环境从白名单起步（PATH、locale、Windows 起进程必需的几项），父进程里
 *   的 `*_API_KEY`、token、云凭据一个都不往下传。HOME、XDG_*、TMPDIR 全指到
 *   临时目录，`~/.occ`、`~/.qianmo`、`~/.claude` 因此都是空的新目录。
 * - HTTP(S)_PROXY / ALL_PROXY 指向本进程的一个 TCP 陷阱，NO_PROXY 只放行
 *   127.0.0.1 / localhost（假 provider 在那儿）：任何遵守代理设置的出网都会撞进
 *   陷阱并判红。不遵守代理设置的出网（裸 socket、DNS）这里看不见，由
 *   `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 等开关把遥测、自动更新、错误上报
 *   整类关掉。
 * - macOS 上 PATH 最前面放一个假 `security`：钥匙串读取全部落在替身上（记下参数
 *   后返回「未找到」），碰不到真的登录钥匙串。
 *
 * 用法：
 *   bun scripts/check-bundle-smoke.ts          # 检查当前 dist/
 *   bun scripts/check-bundle-smoke.ts ./dist   # 指定目录
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

/** 被冒烟的入口：两个身份各一个，同一份 chunk 图。 */
const SMOKE_ENTRIES = ['cli-node.js', 'cli-qianmo.js'] as const

const PROMPT = 'bundle smoke: reply with anything'
const FAKE_API_KEY = 'sk-ant-bundle-smoke-not-a-real-key'
const PROVIDER_ERROR_MESSAGE = 'bundle smoke fake provider: request rejected'
const ENTRY_TIMEOUT_MS = 60_000

/** 子进程只继承这些；其余一律不传（凭据就藏在「其余」里）。 */
const INHERITED_ENV = [
  'PATH',
  'Path',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  // Windows 上没有这几项连子进程都起不来
  'SystemRoot',
  'SYSTEMROOT',
  'ComSpec',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
]

/** 模块初始化失败的签名 —— 出现在任何输出里都判红。 */
const MODULE_INIT_FAILURE_RE =
  /\b(?:ReferenceError|SyntaxError)\b|\bis not defined\b|\bbefore initialization\b|\bis not a function\b|\bCannot find (?:module|package)\b|\bdoes not provide an export named\b/

interface ProviderRequest {
  method: string
  path: string
  /** 请求里出现的凭据头（x-api-key / authorization），没有就是空数组。 */
  credentials: string[]
}

interface EntryResult {
  entry: string
  ok: boolean
  reasons: string[]
  exitCode: number | null
  durationMs: number
  providerRequests: ProviderRequest[]
  trapped: string[]
  keychainCalls: number
  output: string
}

function startFakeProvider(requests: ProviderRequest[]) {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        credentials: ['x-api-key', 'authorization']
          .map(header => request.headers.get(header))
          .filter((value): value is string => value !== null),
      })
      // 400 invalid_request_error：Anthropic SDK 与 CLI 的重试层都不重试它。
      return Response.json(
        {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: PROVIDER_ERROR_MESSAGE,
          },
        },
        { status: 400 },
      )
    },
  })
}

/** 代理陷阱：记下每条连接的首行（`CONNECT host:443 HTTP/1.1` 之类）就断开。 */
async function startProxyTrap(trapped: string[]) {
  const server = createServer(socket => {
    const index = trapped.push('(连接后未发送数据)') - 1
    socket.on('error', () => {})
    socket.once('data', chunk => {
      trapped[index] = chunk.toString('latin1').split('\r\n')[0] ?? ''
      socket.destroy()
    })
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('代理陷阱没有拿到 TCP 端口')
  }
  return { server, port: address.port }
}

/** macOS：PATH 最前面放一个假 `security`，钥匙串读取全落在它身上。 */
function writeKeychainStub(binDir: string, logFile: string): void {
  mkdirSync(binDir, { recursive: true })
  const stub = join(binDir, 'security')
  writeFileSync(
    stub,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${logFile}'`,
      // 44 = errSecItemNotFound，`security find-generic-password` 找不到条目时的退出码
      'exit 44',
      '',
    ].join('\n'),
  )
  chmodSync(stub, 0o755)
}

function isolatedEnv(options: {
  home: string
  tmp: string
  binDir: string | null
  providerUrl: string
  proxyUrl: string
}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of INHERITED_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  if (options.binDir) {
    const pathKey =
      env.PATH !== undefined || env.Path === undefined ? 'PATH' : 'Path'
    env[pathKey] = [options.binDir, env[pathKey]]
      .filter(Boolean)
      .join(delimiter)
  }
  const { home, tmp, providerUrl, proxyUrl } = options
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    // 唯一的凭据：假 key，只对假 provider 有意义
    ANTHROPIC_API_KEY: FAKE_API_KEY,
    ANTHROPIC_BASE_URL: providerUrl,
    CLAUDE_CODE_MAX_RETRIES: '0',
    // 遥测、自动更新、错误上报整类关掉
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_ERROR_REPORTING: '1',
    // 官方插件市场的后台 reconcile 会 `git clone` github.com。它与本冒烟要抓的
    // 初始化失败无关，却和进程退出抢时序：provider 回得快就退在它前面（绿），
    // 机器慢或 provider 回得慢就撞进陷阱（红）——Rosetta 容器与延迟 6 s 的
    // provider 上都稳定复现。关掉这一项，判据④只剩「未预期的出网」。
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    // 跑被检查的这份 dist，而不是它在配置目录里的副本
    OCC_DISABLE_RUNTIME_FARM: '1',
    // 其余出网一律撞进陷阱
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    all_proxy: proxyUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  }
}

async function runEntry(options: {
  distDir: string
  entry: string
  sandbox: string
  providerUrl: string
  providerRequests: ProviderRequest[]
  proxyUrl: string
  trapped: string[]
}): Promise<EntryResult> {
  const { distDir, entry, sandbox, providerUrl, proxyUrl } = options
  const root = join(sandbox, entry)
  const home = join(root, 'home')
  const tmp = join(root, 'tmp')
  const project = join(root, 'project')
  for (const dir of [home, tmp, project]) mkdirSync(dir, { recursive: true })

  const keychainLog = join(root, 'security.log')
  const binDir = process.platform === 'darwin' ? join(root, 'bin') : null
  if (binDir) writeKeychainStub(binDir, keychainLog)

  const requestsBefore = options.providerRequests.length
  const trappedBefore = options.trapped.length
  const started = Date.now()
  const child = Bun.spawn(
    [process.execPath, join(distDir, entry), '-p', PROMPT],
    {
      cwd: project,
      env: isolatedEnv({ home, tmp, binDir, providerUrl, proxyUrl }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, ENTRY_TIMEOUT_MS)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  clearTimeout(timer)
  // 陷阱的 data 回调可能比子进程退出晚一拍
  await Bun.sleep(50)

  const output = `${stdout}\n${stderr}`
  const providerRequests = options.providerRequests.slice(requestsBefore)
  const trapped = options.trapped.slice(trappedBefore)
  const keychainCalls = existsSync(keychainLog)
    ? readFileSync(keychainLog, 'utf8').split('\n').filter(Boolean).length
    : 0

  const reasons: string[] = []
  if (timedOut) {
    reasons.push(`${ENTRY_TIMEOUT_MS / 1000} s 内没有退出，已强制结束`)
  }
  const failure = output.match(MODULE_INIT_FAILURE_RE)
  if (failure) {
    reasons.push(`输出里有模块初始化失败的签名「${failure[0]}」`)
  }
  if (
    !providerRequests.some(
      request =>
        request.method === 'POST' && request.path.startsWith('/v1/messages'),
    )
  ) {
    reasons.push(
      '假 provider 没有收到 POST /v1/messages —— 入口没有走完模块初始化、到不了网络层',
    )
  }
  if (trapped.length > 0) {
    reasons.push(
      `代理陷阱收到 ${trapped.length} 次连接（冒烟期间试图访问外网）：${trapped.join(' | ')}`,
    )
  }
  const foreignCredentials = providerRequests.flatMap(request =>
    request.credentials.filter(value => !value.includes(FAKE_API_KEY)),
  )
  if (foreignCredentials.length > 0) {
    reasons.push(
      `假 provider 收到了不是本脚本发出的凭据（${foreignCredentials.length} 处）—— 隔离失效，凭据从别处读来了`,
    )
  }

  return {
    entry,
    ok: reasons.length === 0,
    reasons,
    exitCode,
    durationMs: Date.now() - started,
    providerRequests,
    trapped,
    keychainCalls,
    output,
  }
}

/** 失败时给人看的输出片段：优先带上命中签名的那几行。 */
function excerpt(output: string): string {
  const lines = output.split('\n').filter(line => line.trim() !== '')
  const hit = lines.findIndex(line => MODULE_INIT_FAILURE_RE.test(line))
  const picked =
    hit >= 0 ? lines.slice(Math.max(0, hit - 2), hit + 3) : lines.slice(-8)
  return picked.map(line => `     | ${line.slice(0, 200)}`).join('\n')
}

async function main(): Promise<number> {
  const distDir = resolve(process.argv[2] || './dist')
  console.log(`\n🔥 构建产物运行期冒烟: ${distDir}\n`)

  const missing = SMOKE_ENTRIES.filter(
    entry => !existsSync(join(distDir, entry)),
  )
  if (missing.length > 0) {
    console.error(`❌ 找不到入口：${missing.join(', ')}`)
    console.error('   请先运行 bun run build:vite')
    return 1
  }

  const providerRequests: ProviderRequest[] = []
  const trapped: string[] = []
  const provider = startFakeProvider(providerRequests)
  const trap = await startProxyTrap(trapped)
  const sandbox = mkdtempSync(join(tmpdir(), 'qianmo-bundle-smoke-'))
  const results: EntryResult[] = []
  try {
    for (const entry of SMOKE_ENTRIES) {
      results.push(
        await runEntry({
          distDir,
          entry,
          sandbox,
          providerUrl: `http://127.0.0.1:${provider.port}`,
          providerRequests,
          proxyUrl: `http://127.0.0.1:${trap.port}`,
          trapped,
        }),
      )
    }
  } finally {
    provider.stop(true)
    trap.server.close()
    rmSync(sandbox, { recursive: true, force: true })
  }

  for (const result of results) {
    const messages = result.providerRequests.filter(request =>
      request.path.startsWith('/v1/messages'),
    ).length
    const facts = `${(result.durationMs / 1000).toFixed(1)} s，退出码 ${result.exitCode}，假 provider 收到 /v1/messages ×${messages}，代理陷阱 ${result.trapped.length} 次连接${process.platform === 'darwin' ? `，钥匙串替身 ${result.keychainCalls} 次调用` : ''}`
    if (result.ok) {
      console.log(`✅ ${result.entry}：${facts}`)
      continue
    }
    console.log(`❌ ${result.entry}：${facts}`)
    for (const reason of result.reasons) console.log(`   - ${reason}`)
    console.log(excerpt(result.output))
  }

  const failed = results.filter(result => !result.ok)
  console.log('─'.repeat(50))
  if (failed.length === 0) {
    console.log(
      `✅ 运行期冒烟通过：${results.length} 个入口都走完模块初始化、到达假 provider，未试图出网。`,
    )
    return 0
  }
  console.log(
    `📊 ${failed.length}/${results.length} 个入口冒烟失败。
💡 构建退出码为 0 不代表产物能启动。先跑 bun run check:bundle 的静态部分
   （scripts/check-bundle-integrity.ts）看有没有未绑定的 init_*/require_* 调用，
   再用失败输出里的 chunk 名对照 vite.config.ts 与 rolldown 版本。`,
  )
  return 1
}

main().then(
  code => process.exit(code),
  error => {
    console.error('Fatal error:', error)
    process.exit(2)
  },
)
