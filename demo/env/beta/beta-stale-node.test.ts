// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * pid 文件对不上真进程时的停机与就绪（2026-09-26 舰队部署 D7，p1 上的 beta-1）。
 *
 * 现场两步连在一起：
 *
 * ① 旧树留下的 `run/beta-1.pid` 写着 3012737，真在跑的是 2701919。只认 pid 文件的
 *    `beta-down.sh beta-1` 报「beta-1 本来就没在跑」，旧进程照跑、继续占着 38625。
 * ② 紧接着的 `beta-up.sh` 起了新进程，新进程 EADDRINUSE 退出；就绪探测只看「127.0.0.1:38625
 *    有没有应答」，旧进程答了，于是打出「OK : beta-1 在 127.0.0.1:38625 上监听」。唯一的线索
 *    是末尾「节点身份」那一行是空的。
 *
 * 所以这里钉两组：
 *
 * - `beta-down.sh <节点>`：pid 文件陈旧时按命令行（resident + --node + 本内测根）认出旧进程
 *   并按原流程停掉；认不出而端口被占时只报不杀、退非零；H 上切链路的名字不被 38625 上
 *   那个本机节点连累。
 * - `beta-up.sh --role node`：端口已被占时不起新进程；应答不是刚起的 pid 发出的不算就绪；
 *   新进程退出时当场失败并摊开它的 stderr；正向对照照旧报就绪，且带出 pid 与公钥。
 *
 * 做法：真 `/bin/bash` 跑真脚本；「常驻节点」是 `bun` 跑的一段脚本（**不拷任何系统二进制**：
 * macOS 上拷到系统卷以外执行的平台二进制会被内核 SIGKILL，0831a66b 修过一次）。测试自己
 * 起的那些进程经 `sh -c '… &'` 脱离本进程——被停掉之后由 init 收尸，`kill -0` 才答得准；
 * 留成本进程的子进程，它在 `spawnSync` 期间死掉就是一个没人收的僵尸，`kill -0` 永远为真。
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const BETA_DIR = join(REPOSITORY_ROOT, 'demo/env/beta')
const PUBLIC_KEY = 'Inyg1lW5K3Tsc1VrzZ5-ifdAyfXrFzzBirnDnVsVsvQ'

/**
 * 假的常驻节点：先打启动行（与 resident.ts 同形：在监听**之前**打），等一会儿再监听。
 *
 * - `listen`：自己监听（正向对照，也是「旧进程」）；
 * - `die`：打完启动行、等完就带一行 stderr 退出（新进程起不住的那一类）；
 * - `child`：让一个**别的** pid 在这个端口上监听，自己挂着不走（应答不是它发的）。
 *
 * 等待时长取环境变量：真 resident 从启动行到监听要一两秒，超过 beta_start_process 的
 * 1 s 宽限——那正是 p1 上旧判据被骗的时间窗。
 */
const FAKE_RESIDENT = `
const args = process.argv.slice(2)
const value = flag => { const i = args.lastIndexOf(flag); return i < 0 ? undefined : args[i + 1] }
const node = value('--node')
const port = Number(value('--port'))
const hostname = value('--hostname') ?? '127.0.0.1'
const mode = process.env.FAKE_RESIDENT_MODE ?? 'listen'
process.stdout.write(JSON.stringify({ node, sourceCommit: 'fake', publicKey: process.env.FAKE_RESIDENT_KEY ?? '${PUBLIC_KEY}' }) + '\\n')
await Bun.sleep(Number(process.env.FAKE_RESIDENT_DELAY_MS ?? '0'))
if (mode === 'die') {
  process.stderr.write('fake resident: boom-before-listen\\n')
  process.exit(1)
}
if (mode === 'child') {
  const child = Bun.spawn([process.execPath, process.env.FAKE_LISTENER, String(port), hostname], { stdio: ['ignore', 'ignore', 'ignore'] })
  require('node:fs').writeFileSync(process.env.FAKE_RESIDENT_CHILD_PID_FILE, String(child.pid))
  setInterval(() => {}, 60_000)
} else {
  try {
    Bun.serve({ port, hostname, fetch: () => new Response('expected a websocket upgrade', { status: 426 }) })
  } catch (error) {
    process.stderr.write('fake resident: ' + String(error && error.code) + ' ' + String(error && error.message) + '\\n')
    process.exit(1)
  }
}
`

/** 一个跟阡陌毫无关系的监听者：argv 里没有 resident，也没有 --node。 */
const FAKE_LISTENER = `
const [port, hostname] = process.argv.slice(2)
Bun.serve({ port: Number(port), hostname, fetch: () => new Response('not qianmo', { status: 200 }) })
`

const FIXTURES = mkdtempSync(join(tmpdir(), 'qianmo-beta-stale-node-bin-'))
const RESIDENT_SCRIPT = join(FIXTURES, 'fake-resident.js')
const LISTENER_SCRIPT = join(FIXTURES, 'fake-listener.js')
writeFileSync(RESIDENT_SCRIPT, FAKE_RESIDENT)
writeFileSync(LISTENER_SCRIPT, FAKE_LISTENER)

/** lsof 在 macOS 上住 /usr/sbin；ss 在有些发行版上也在 sbin。 */
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

const scratches: string[] = []
const strays: number[] = []

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经被被测脚本停掉了——多数用例要的正是这个。
    }
  }
  for (const value of scratches.splice(0)) {
    rmSync(value, { force: true, recursive: true })
  }
})

afterAll(() => {
  rmSync(FIXTURES, { force: true, recursive: true })
})

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

function result(child: ReturnType<typeof Bun.spawnSync>): ShellResult {
  return {
    exitCode: child.exitCode,
    stdout: child.stdout?.toString() ?? '',
    stderr: child.stderr?.toString() ?? '',
  }
}

/** 一个带标记文件的内测根（beta-down 没有它就拒绝动手）。 */
function betaRoot(base: string): string {
  const root = join(base, 'beta-root')
  mkdirSync(join(root, 'run'), { recursive: true })
  mkdirSync(join(root, 'logs'), { recursive: true })
  writeFileSync(join(root, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  return root
}

function scratchDir(): string {
  const base = mkdtempSync(join(tmpdir(), 'qianmo-beta-stale-node-'))
  scratches.push(base)
  return base
}

async function freePort(): Promise<number> {
  const probe = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {} },
  })
  const port = probe.port
  probe.stop(true)
  return port
}

/** 起一个脱离本进程的进程，返回它的 pid（见文件头：为什么要脱离）。 */
function spawnDetached(
  argv: readonly string[],
  env: Readonly<Record<string, string>> = {},
): number {
  const child = Bun.spawnSync(
    [
      '/bin/sh',
      '-c',
      'nohup "$@" >/dev/null 2>&1 & echo $!',
      'detach',
      ...argv,
    ],
    { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' },
  )
  const pid = Number(child.stdout.toString().trim())
  expect(Number.isInteger(pid) && pid > 0).toBe(true)
  strays.push(pid)
  return pid
}

async function waitListening(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`)
      return
    } catch {
      await Bun.sleep(50)
    }
  }
  throw new Error(`nothing listening on ${port}`)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 一个确定已经不在的 pid：`sh` 打完自己的 pid 就退了，spawnSync 顺手收了它。 */
function deadPid(): number {
  const child = Bun.spawnSync(['/bin/sh', '-c', 'echo $$'], { stdout: 'pipe' })
  return Number(child.stdout.toString().trim())
}

/** 本内测根下节点 `node` 的常驻命令行（beta-up 起它时的形状：--agent 指向本根的工作区）。 */
function residentArgv(root: string, node: string, port: number): string[] {
  return [
    process.execPath,
    RESIDENT_SCRIPT,
    'resident',
    '--node',
    node,
    '--team',
    'atlas',
    '--port',
    String(port),
    '--hostname',
    '127.0.0.1',
    '--agent',
    `planner=${root}/workspaces/${node}/planner`,
  ]
}

function runDown(
  root: string,
  port: number,
  args: readonly string[],
): ShellResult {
  return result(
    Bun.spawnSync(['/bin/bash', join(BETA_DIR, 'beta-down.sh'), ...args], {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        PATH: SYSTEM_PATH,
        QIANMO_BETA_ROOT: root,
        QIANMO_BETA_NODE_PORT: String(port),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  )
}

describe('beta-down.sh <节点>：pid 文件对不上时按命令行再认一遍', () => {
  test('pid 文件陈旧：认出本节点真正在跑的旧进程，按原流程停掉（p1 的现场）', async () => {
    const root = betaRoot(scratchDir())
    const port = await freePort()
    const old = spawnDetached(residentArgv(root, 'beta-1', port))
    await waitListening(port)
    const pidFile = join(root, 'run', 'beta-1.pid')
    writeFileSync(pidFile, `${deadPid()}\n`)

    const down = runDown(root, port, ['beta-1'])

    expect({ exit: down.exitCode, stderr: down.stderr }).toEqual({
      exit: 0,
      stderr: '',
    })
    // 修之前这里打的就是这一句，而旧进程照跑。
    expect(down.stdout).not.toContain('本来就没在跑')
    expect(down.stdout).toContain('按命令行认出 beta-1 真正在跑的是')
    expect(down.stdout).toContain(`已停止 beta-1 (pid ${old})`)
    expect(alive(old)).toBe(false)
    expect(existsSync(pidFile)).toBe(false)
  }, 15_000)

  test('认不出的监听者：只报不杀，退非零', async () => {
    const root = betaRoot(scratchDir())
    const port = await freePort()
    const stranger = spawnDetached([
      process.execPath,
      LISTENER_SCRIPT,
      String(port),
      '127.0.0.1',
    ])
    await waitListening(port)
    writeFileSync(join(root, 'run', 'beta-1.pid'), `${deadPid()}\n`)

    const down = runDown(root, port, ['beta-1'])

    expect(down.exitCode).not.toBe(0)
    expect(down.stdout).toContain(`端口 ${port} 被占着`)
    expect(down.stdout).toContain(`pid ${stranger}`)
    expect(down.stdout).toContain('本脚本不动它们')
    expect(down.stderr).toContain('beta-1')
    // 关键在这一条：端口只用来报不一致，不用来挑人杀。
    expect(alive(stranger)).toBe(true)
  }, 15_000)

  test('同名节点但属于别的内测根：命令行过不了「本内测根」那一条，照样不杀', async () => {
    const root = betaRoot(scratchDir())
    const port = await freePort()
    const elsewhere = spawnDetached(
      residentArgv(join(scratchDir(), 'another-root'), 'beta-1', port),
    )
    await waitListening(port)
    writeFileSync(join(root, 'run', 'beta-1.pid'), `${deadPid()}\n`)

    const down = runDown(root, port, ['beta-1'])

    expect(down.exitCode).not.toBe(0)
    expect(down.stdout).toContain(`pid ${elsewhere}`)
    expect(alive(elsewhere)).toBe(true)
  }, 15_000)

  test('H 上切一个只铺了链路的名字：38625 上是本机那个节点，不连累它，也不报不一致', async () => {
    const root = betaRoot(scratchDir())
    const port = await freePort()
    // H 自己身上跑着 beta-4；beta-1 在别的机器上，H 的 run/ 里本来就没有它的 pid 文件。
    const local = spawnDetached(residentArgv(root, 'beta-4', port))
    await waitListening(port)

    const down = runDown(root, port, ['beta-1'])

    expect(down.exitCode).toBe(0)
    expect(down.stdout).toContain('beta-1 本来就没在跑')
    expect(alive(local)).toBe(true)
  }, 15_000)

  test('pid 文件陈旧、端口上是本内测根的另一个节点：说清楚是谁，不算不一致', async () => {
    const root = betaRoot(scratchDir())
    const port = await freePort()
    const other = spawnDetached(residentArgv(root, 'beta-4', port))
    await waitListening(port)
    writeFileSync(join(root, 'run', 'beta-1.pid'), `${deadPid()}\n`)

    const down = runDown(root, port, ['beta-1'])

    expect(down.exitCode).toBe(0)
    expect(down.stdout).toContain(`是本内测根的节点 beta-4（pid ${other}）`)
    expect(alive(other)).toBe(true)
  }, 15_000)
})

/** 一棵临时「仓库」：真的 beta-up.sh / common.sh，dist/cli-node.js 是上面那个假常驻。 */
function nodeRepo(base: string): string {
  const repo = join(base, 'repo')
  const beta = join(repo, 'demo/env/beta')
  mkdirSync(beta, { recursive: true })
  for (const name of ['beta-up.sh', 'common.sh', 'beta-down.sh']) {
    copyFileSync(join(BETA_DIR, name), join(beta, name))
  }
  mkdirSync(join(repo, 'demo/lib'), { recursive: true })
  copyFileSync(
    join(REPOSITORY_ROOT, 'demo/lib/entry.sh'),
    join(repo, 'demo/lib/entry.sh'),
  )
  mkdirSync(join(repo, 'dist'), { recursive: true })
  copyFileSync(RESIDENT_SCRIPT, join(repo, 'dist/cli-node.js'))
  return repo
}

interface NodeLeg {
  readonly repo: string
  readonly root: string
  readonly port: number
  readonly childPidFile: string
}

async function nodeLeg(): Promise<NodeLeg> {
  const base = scratchDir()
  const root = betaRoot(base)
  mkdirSync(join(root, 'secrets'), { recursive: true })
  writeFileSync(join(root, 'secrets', 'transport-psk'), 'psk-for-test\n')
  chmodSync(join(root, 'secrets', 'transport-psk'), 0o600)
  return {
    repo: nodeRepo(base),
    root,
    port: await freePort(),
    childPidFile: join(base, 'child.pid'),
  }
}

function runUp(
  leg: NodeLeg,
  env: Readonly<Record<string, string>>,
): ShellResult {
  const run = result(
    Bun.spawnSync(
      [
        '/bin/bash',
        join(leg.repo, 'demo/env/beta/beta-up.sh'),
        '--role',
        'node',
        '--node',
        'beta-1',
        '--agent',
        'planner',
      ],
      {
        cwd: leg.repo,
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${SYSTEM_PATH}`,
          QIANMO_BETA_ROOT: leg.root,
          QIANMO_BETA_NODE_PORT: String(leg.port),
          QIANMO_BETA_NODE_BIND: '127.0.0.1',
          QIANMO_BETA_READY_TIMEOUT_S: '4',
          QIANMO_BETA_OOM_SCORE_ADJ: 'off',
          FAKE_LISTENER: LISTENER_SCRIPT,
          FAKE_RESIDENT_CHILD_PID_FILE: leg.childPidFile,
          ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    ),
  )
  // 不论成败，本趟起过的进程都要收掉。
  const pidFile = join(leg.root, 'run', 'beta-1.pid')
  if (existsSync(pidFile)) strays.push(Number(readFileSync(pidFile, 'utf8')))
  if (existsSync(leg.childPidFile)) {
    strays.push(Number(readFileSync(leg.childPidFile, 'utf8')))
  }
  return run
}

/** 旧判据打的那一行的前缀。修之前 p1 上打出来的就是它。 */
const READY_LINE = 'OK   : beta-1 在 127.0.0.1:'

describe('beta-up.sh --role node：就绪必须是刚起的那个 pid 在应答', () => {
  test('端口已被本节点的旧进程占着：不起新进程，指向 beta-down（p1 的现场）', async () => {
    const leg = await nodeLeg()
    const old = spawnDetached(residentArgv(leg.root, 'beta-1', leg.port))
    await waitListening(leg.port)
    writeFileSync(join(leg.root, 'run', 'beta-1.pid'), `${deadPid()}\n`)

    // 新进程要 1.5 s 才去监听：比 1 s 的起后宽限长，旧判据正是在这个窗里被骗的。
    const up = runUp(leg, { FAKE_RESIDENT_DELAY_MS: '1500' })
    const said = `${up.stdout}${up.stderr}`

    expect(up.exitCode).not.toBe(0)
    expect(said).not.toContain(READY_LINE)
    expect(said).toContain(`pid ${old}`)
    expect(said).toContain('beta-down.sh beta-1')
    // 注定 EADDRINUSE 的新进程根本没被起：日志都没有。
    expect(existsSync(join(leg.root, 'logs', 'beta-1.out'))).toBe(false)
    expect(alive(old)).toBe(true)
  }, 30_000)

  test('应答来自别的 pid：不算就绪，超时时把应答者报出来', async () => {
    const leg = await nodeLeg()

    const up = runUp(leg, { FAKE_RESIDENT_MODE: 'child' })
    const said = `${up.stdout}${up.stderr}`

    expect(up.exitCode).not.toBe(0)
    expect(said).not.toContain(READY_LINE)
    expect(said).toContain('应答的不是 beta-1')
    const child = Number(readFileSync(leg.childPidFile, 'utf8'))
    expect(said).toContain(`pid ${child}`)
  }, 30_000)

  test('新进程在监听之前退出：当场失败，摊开它的 stderr', async () => {
    const leg = await nodeLeg()

    const up = runUp(leg, {
      FAKE_RESIDENT_MODE: 'die',
      FAKE_RESIDENT_DELAY_MS: '1500',
    })
    const said = `${up.stdout}${up.stderr}`

    expect(up.exitCode).not.toBe(0)
    expect(said).not.toContain(READY_LINE)
    expect(said).toContain('boom-before-listen')
    expect(said).toContain('beta-1 未能保持运行')
  }, 30_000)

  test('正向对照：刚起的 pid 自己在听，照旧报就绪，并带出 pid 与公钥', async () => {
    const leg = await nodeLeg()

    const up = runUp(leg, { FAKE_RESIDENT_DELAY_MS: '300' })

    expect({ exit: up.exitCode, stderr: up.stderr }).toEqual({
      exit: 0,
      stderr: up.stderr,
    })
    const pid = Number(
      readFileSync(join(leg.root, 'run', 'beta-1.pid'), 'utf8'),
    )
    expect(alive(pid)).toBe(true)
    expect(up.stdout).toContain(
      `${READY_LINE}${leg.port} 上监听（pid ${pid}，公钥 ${PUBLIC_KEY}）`,
    )
    // 末尾那两行：p1 上「节点身份」是空的；现在它与「公钥」都必须有内容。
    expect(up.stdout).toMatch(/节点身份 : \{"node":"beta-1"/)
    expect(up.stdout).toContain(`公钥     : ${PUBLIC_KEY}`)
  }, 30_000)
})
