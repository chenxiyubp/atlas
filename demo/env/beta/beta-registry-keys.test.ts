// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * H 腿把节点公钥交给注册中心（2026-09-26 D9b）。
 *
 * 现场：控制台带 `--anchors` 后，审计页对三个节点全报「名册没有节点 beta-X 的公钥」——
 * 控制台只从名册取节点公钥，而 beta 脚本登记的条目从来不带公钥。手工逐条 POST 补上之后，
 * 条目一旦因租约过期被 p81-registry 重新登记，公钥又丢了。
 *
 * 这里钉 H 腿那一半（p81-registry 自己那一半在 demo/lib/p81-registry.test.ts）：
 *
 * ① 坐标行的 `public-key=` → 注册中心命令行上一条 `--public-key <节点>=<公钥>`（按节点一条）；
 * ② 跑在 H 自己身上的节点（没有坐标行、端点是回环）→ 公钥从本机身份文件读，私钥一个字节都
 *    不出现在输出里；
 * ③ 都没有 → 与今天完全一样（不带），并 WARN 一句；
 * ④ `public-key=` 形状不对当场带行号拒绝；
 * ⑤ 在跑的注册中心还是旧命令行（名册上没挂这把公钥）→ 与端点不一致同一个处置：重起它。
 *
 * 以及同一份公钥的另一个去处与注册中心写 token（K-11 F-3、P15.8）：
 *
 * ⑥ 控制台带 `--anchors` → 每个有公钥的节点一条 `--trust <节点>=<公钥>`（不经注册中心）；
 *    不带 `--anchors` 不加；一把都没有且尾参里也没有 `--trust` / `--trust-ca` → 起之前拒绝；
 * ⑦ `secrets/registry-write-token` 在 → 注册中心 `--write-token-file`、控制台
 *    `--registry-token-file`，两边同一个路径、token 值不上命令行；不在 → 两边都不带，WARN。
 *
 * 做法同 beta-up-args：临时「仓库」里的 common.sh 末尾把 beta_start_process 换成只记账的桩，
 * 断言的是真参数解析的产物，不起真注册中心。
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

const KEY_1 = 'Inyg1lW5K3Tsc1VrzZ5-ifdAyfXrFzzBirnDnVsVsvQ'
const KEY_4 = '4eaCEVKxAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
/** 身份文件里的私钥。它出现在任何一行输出里都是事故。 */
const PRIVATE_4 = 'PRIVATE-KEY-MATERIAL-must-never-be-printed'

/** 同 beta-up-args：只记底层命令行；注册中心那一趟把 ready 文件写出来，放行等待循环。 */
const RECORDER = `
beta_start_process() {
  local name="$1"
  shift 2
  {
    printf '=== %s\\n' "$name"
    printf '%s\\n' "$@"
  } >>"$BETA_ARGV_LOG"
  local a prev='' ready=''
  for a in "$@"; do
    if [ "$prev" = '--ready' ]; then ready="$a"; fi
    prev="$a"
  done
  if [ -n "$ready" ]; then
    printf '{}\\n' >"$ready"
    return 0
  fi
  exit 0
}
`

/** 一个「正在跑的旧注册中心」：按地址答一条登记，端点对、但没挂公钥。 */
const STALE_REGISTRY = `
const [port, endpoint] = process.argv.slice(2)
Bun.serve({
  port: Number(port),
  hostname: '127.0.0.1',
  fetch(request) {
    const path = new URL(request.url).pathname
    const address = decodeURIComponent(path.slice('/v0/agents/'.length))
    return Response.json({ address, endpoint, capabilities: ['task.request'], status: 'online' })
  },
})
`

/**
 * 「这台机器上 systemd --user 用不了」钉死成一个桩（beta-up-args 同一条理由：Linux runner
 * 上 /usr/bin/systemctl 是真的）。整个文件只写一次、先跑一次（macOS 首执行扫描，issue #56）。
 */
const STUB_HOME = mkdtempSync(join(tmpdir(), 'qianmo-beta-registry-keys-bin-'))
const NO_SYSTEMD_BIN = join(STUB_HOME, 'bin')
mkdirSync(NO_SYSTEMD_BIN, { recursive: true })
writeFileSync(join(NO_SYSTEMD_BIN, 'systemctl'), '#!/bin/bash\nexit 1\n')
chmodSync(join(NO_SYSTEMD_BIN, 'systemctl'), 0o755)
Bun.spawnSync([join(NO_SYSTEMD_BIN, 'systemctl'), '--version'], {
  stdout: 'ignore',
  stderr: 'ignore',
})
const STALE_REGISTRY_SCRIPT = join(STUB_HOME, 'stale-registry.js')
writeFileSync(STALE_REGISTRY_SCRIPT, STALE_REGISTRY)

afterAll(() => {
  rmSync(STUB_HOME, { force: true, recursive: true })
})

const scratches: string[] = []
const strays: number[] = []

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已经被 beta-up 停掉了——⑤ 要的就是这个。
    }
  }
  for (const value of scratches.splice(0)) {
    rmSync(value, { force: true, recursive: true })
  }
})

interface Place {
  readonly repo: string
  readonly root: string
  readonly argvLog: string
}

function place(): Place {
  const base = mkdtempSync(join(tmpdir(), 'qianmo-beta-registry-keys-'))
  scratches.push(base)
  const repo = join(base, 'repo')
  const beta = join(repo, 'demo/env/beta')
  mkdirSync(beta, { recursive: true })
  copyFileSync(join(BETA_DIR, 'beta-up.sh'), join(beta, 'beta-up.sh'))
  writeFileSync(
    join(beta, 'common.sh'),
    readFileSync(join(BETA_DIR, 'common.sh'), 'utf8') + RECORDER,
  )
  mkdirSync(join(repo, 'demo/lib'), { recursive: true })
  copyFileSync(
    join(REPOSITORY_ROOT, 'demo/lib/entry.sh'),
    join(repo, 'demo/lib/entry.sh'),
  )
  mkdirSync(join(repo, 'dist/demo'), { recursive: true })
  writeFileSync(join(repo, 'dist/demo/p81-registry.js'), '// stub\n')
  writeFileSync(join(repo, 'dist/cli-node.js'), '// stub\n')
  const root = join(base, 'beta-root')
  mkdirSync(join(root, 'secrets'), { recursive: true })
  return { repo, root, argvLog: join(base, 'argv.log') }
}

function writePeers(at: Place, lines: readonly string[]): void {
  writeFileSync(join(at.root, 'peers.conf'), `${lines.join('\n')}\n`)
  chmodSync(join(at.root, 'peers.conf'), 0o600)
}

interface ShellResult {
  readonly exitCode: number
  readonly out: string
}

function runHost(
  at: Place,
  env: Readonly<Record<string, string>> = {},
  // 默认只起注册中心：坐标行会让链路那一步真的去建 SSH 隧道。⑥⑦ 另点名控制台。
  only: readonly string[] = ['--only', 'registry'],
): ShellResult {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      join(at.repo, 'demo/env/beta/beta-up.sh'),
      '--role',
      'host',
      ...only,
    ],
    {
      cwd: at.repo,
      env: {
        ...process.env,
        PATH: `${NO_SYSTEMD_BIN}:${dirname(process.execPath)}:/usr/bin:/bin`,
        QIANMO_BETA_ROOT: at.root,
        BETA_ARGV_LOG: at.argvLog,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return {
    exitCode: child.exitCode,
    out: `${child.stdout.toString()}${child.stderr.toString()}`,
  }
}

/** 桩记下来的某一段底层命令行；没起那个进程就是 undefined。 */
function blockArgs(at: Place, name: string): string[] | undefined {
  if (!existsSync(at.argvLog)) return undefined
  const lines = readFileSync(at.argvLog, 'utf8').split('\n')
  const start = lines.indexOf(`=== ${name}`)
  if (start < 0) return undefined
  const block = lines.slice(start + 1)
  const end = block.findIndex(line => line.startsWith('=== '))
  return (end < 0 ? block : block.slice(0, end)).filter(line => line !== '')
}

/** 某一段命令行里某个开关的全部取值。 */
function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1] ?? ''] : []))
}

/** 注册中心那一段底层命令行里全部 `--public-key` 的取值。 */
function publicKeyArgs(at: Place): string[] {
  return flagValues(blockArgs(at, 'registry') ?? [], '--public-key')
}

describe('beta-up.sh --role host 把节点公钥交给注册中心', () => {
  test('① 坐标行的 public-key= → 按节点一条 --public-key（两条地址也只一条）', () => {
    const at = place()
    writePeers(at, [
      `node beta-1 user=ops host=203.0.113.7 local-port=38631 public-key=${KEY_1}`,
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
      'qianmo://beta-1/reviewer ws://127.0.0.1:38631',
    ])
    const run = runHost(at)
    expect({ exit: run.exitCode, out: run.out }).toEqual({
      exit: 0,
      out: run.out,
    })
    expect(publicKeyArgs(at)).toEqual([`beta-1=${KEY_1}`])
    expect(run.out).toContain(`名册公钥：beta-1 → ${KEY_1}`)
  })

  test('② H 自己身上的节点：公钥从本机身份文件读，私钥不出现在任何输出里', () => {
    const at = place()
    const identity = join(
      at.root,
      'nodes/beta-4/config/qianmo/identity/beta-4.json',
    )
    mkdirSync(dirname(identity), { recursive: true })
    // 与 nodeIdentity.ts 同形：JSON.stringify(doc, null, 2)。
    writeFileSync(
      identity,
      `${JSON.stringify(
        {
          version: 1,
          node: 'beta-4',
          publicKey: KEY_4,
          privateKey: PRIVATE_4,
          createdAt: 1,
        },
        null,
        2,
      )}\n`,
    )
    chmodSync(identity, 0o600)
    writePeers(at, ['qianmo://beta-4/planner ws://127.0.0.1:38625'])

    const run = runHost(at)

    expect(run.exitCode).toBe(0)
    expect(publicKeyArgs(at)).toEqual([`beta-4=${KEY_4}`])
    expect(run.out).toContain('本机身份文件')
    expect(run.out).not.toContain(PRIVATE_4)
    expect(readFileSync(at.argvLog, 'utf8')).not.toContain(PRIVATE_4)
  })

  test('③ 没有来源：照旧不带公钥（与今天一致），并 WARN 说清补法', () => {
    const at = place()
    writePeers(at, [
      'node beta-1 user=ops host=203.0.113.7 local-port=38631',
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
      'qianmo://beta-5/ops ws://198.51.100.9:38625',
    ])
    const run = runHost(at)
    expect(run.exitCode).toBe(0)
    expect(publicKeyArgs(at)).toEqual([])
    expect(run.out).toContain('名册不带 beta-1 的公钥')
    expect(run.out).toContain('public-key=')
    // 直连的远端节点没有写公钥的地方——如实说，不给一个做不到的补法。
    expect(run.out).toContain('名册不带 beta-5 的公钥')
    expect(run.out).toContain('直连节点目前没有写公钥的地方')
  })

  test('④ public-key= 形状不对：带行号拒绝，不起注册中心', () => {
    const at = place()
    writePeers(at, [
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
      'node beta-1 user=ops host=203.0.113.7 local-port=38631 public-key=abc',
    ])
    const run = runHost(at)
    expect(run.exitCode).not.toBe(0)
    expect(run.out).toContain('第 2 行')
    expect(run.out).toContain('public-key 不是 43 位')
    expect(existsSync(at.argvLog)).toBe(false)
  })

  test('⑤ 在跑的注册中心没挂这把公钥：重起它，新命令行带上 --public-key', async () => {
    const at = place()
    writePeers(at, [
      `node beta-1 user=ops host=203.0.113.7 local-port=38631 public-key=${KEY_1}`,
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
    ])
    const probe = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { data() {} },
    })
    const port = probe.port
    probe.stop(true)
    // 脱离本进程起（见 beta-stale-node.test.ts 文件头：被停掉之后要有人收尸）。
    const spawned = Bun.spawnSync(
      [
        '/bin/sh',
        '-c',
        'nohup "$@" >/dev/null 2>&1 & echo $!',
        'detach',
        process.execPath,
        STALE_REGISTRY_SCRIPT,
        String(port),
        'ws://127.0.0.1:38631',
      ],
      { stdout: 'pipe' },
    )
    const stale = Number(spawned.stdout.toString().trim())
    strays.push(stale)
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        await fetch(`http://127.0.0.1:${port}/v0/agents/x`)
        break
      } catch {
        await Bun.sleep(50)
      }
    }
    mkdirSync(join(at.root, 'run'), { recursive: true })
    writeFileSync(join(at.root, 'run', 'registry.pid'), `${stale}\n`)

    const run = runHost(at, { QIANMO_BETA_REGISTRY_PORT: String(port) })

    expect(run.exitCode).toBe(0)
    expect(run.out).toContain('的公钥是 （没有），而这一趟要发布的是')
    expect(run.out).toContain(`已停止 registry (pid ${stale})`)
    expect(publicKeyArgs(at)).toEqual([`beta-1=${KEY_1}`])
    let gone = false
    try {
      process.kill(stale, 0)
    } catch {
      gone = true
    }
    expect(gone).toBe(true)
  }, 30_000)
})

describe('beta-up.sh --role host 把同一份公钥以 --trust 交给控制台（K-11 F-3）', () => {
  const CONSOLE_ONLY = ['--only', 'console'] as const
  const ANCHORS = ['--', '--anchors', '/srv/witness/anchors.json'] as const

  test('⑥ 带 --anchors：有公钥的节点各一条 --trust，排在尾参之前；没公钥的节点不给', () => {
    const at = place()
    writePeers(at, [
      `node beta-1 user=ops host=203.0.113.7 local-port=38631 public-key=${KEY_1}`,
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
      'qianmo://beta-1/reviewer ws://127.0.0.1:38631',
      'qianmo://beta-5/ops ws://198.51.100.9:38625',
    ])
    const run = runHost(at, {}, [...CONSOLE_ONLY, ...ANCHORS])
    const args = blockArgs(at, 'console')
    expect({ started: args !== undefined, out: run.out }).toEqual({
      started: true,
      out: run.out,
    })
    expect(flagValues(args ?? [], '--trust')).toEqual([`beta-1=${KEY_1}`])
    expect((args ?? []).indexOf('--trust')).toBeLessThan(
      (args ?? []).indexOf('--anchors'),
    )
    expect(run.out).toContain('见证验签公钥：1 个节点经 --trust 交给控制台')
    expect(run.out).toContain('没有节点 beta-5 的可信公钥')
  })

  test('⑥ 不带 --anchors：控制台命令行与此前一样，不加 --trust', () => {
    const at = place()
    writePeers(at, [
      `node beta-1 user=ops host=203.0.113.7 local-port=38631 public-key=${KEY_1}`,
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
    ])
    const run = runHost(at, {}, [...CONSOLE_ONLY])
    const args = blockArgs(at, 'console')
    expect({ started: args !== undefined, out: run.out }).toEqual({
      started: true,
      out: run.out,
    })
    expect(args).not.toContain('--trust')
    expect(run.out).not.toContain('见证验签公钥')
  })

  test('⑥ 带 --anchors 而一把可信公钥都没有：起控制台之前拒绝，说清原因', () => {
    const at = place()
    writePeers(at, ['qianmo://beta-5/ops ws://198.51.100.9:38625'])
    const run = runHost(at, {}, [...CONSOLE_ONLY, ...ANCHORS])
    expect(run.exitCode).not.toBe(0)
    expect(run.out).toContain('控制台带 --anchors，但没有一把可信公钥')
    expect(blockArgs(at, 'console')).toBeUndefined()
  })

  test('⑥ 公钥来源只有尾参里的 --trust-ca：照起，不自己编 --trust', () => {
    const at = place()
    writePeers(at, ['qianmo://beta-5/ops ws://198.51.100.9:38625'])
    const run = runHost(at, {}, [
      ...CONSOLE_ONLY,
      ...ANCHORS,
      '--trust-ca',
      '/srv/ca/root.pem',
    ])
    const args = blockArgs(at, 'console')
    expect({ started: args !== undefined, out: run.out }).toEqual({
      started: true,
      out: run.out,
    })
    expect(args).not.toContain('--trust')
    expect(args).toContain('--trust-ca')
  })

  test('⑥ 注册中心与控制台一趟都起：公钥只算一次、只说一遍，两边拿到同一把', () => {
    const at = place()
    writePeers(at, [
      `node beta-1 user=ops host=203.0.113.7 local-port=38631 public-key=${KEY_1}`,
      'qianmo://beta-1/planner ws://127.0.0.1:38631',
    ])
    const run = runHost(at, {}, [
      '--only',
      'registry',
      ...CONSOLE_ONLY,
      ...ANCHORS,
    ])
    expect({
      console: blockArgs(at, 'console') !== undefined,
      out: run.out,
    }).toEqual({ console: true, out: run.out })
    expect(publicKeyArgs(at)).toEqual([`beta-1=${KEY_1}`])
    expect(flagValues(blockArgs(at, 'console') ?? [], '--trust')).toEqual([
      `beta-1=${KEY_1}`,
    ])
    expect(run.out.split('名册公钥：beta-1').length - 1).toBe(1)
  })
})

describe('beta-up.sh --role host 的注册中心写 token（P15.8）', () => {
  const BOTH = ['--only', 'registry', '--only', 'console'] as const
  const WRITE_TOKEN = 'registry-write-token-value-for-test'

  test('⑦ secrets/registry-write-token 在：注册中心与控制台各带同一个路径，值不上命令行', () => {
    const at = place()
    writePeers(at, ['qianmo://beta-4/planner ws://127.0.0.1:38625'])
    const file = join(at.root, 'secrets', 'registry-write-token')
    writeFileSync(file, `${WRITE_TOKEN}\n`)
    chmodSync(file, 0o600)

    const run = runHost(at, {}, [...BOTH])

    expect({
      console: blockArgs(at, 'console') !== undefined,
      out: run.out,
    }).toEqual({ console: true, out: run.out })
    expect(
      flagValues(blockArgs(at, 'registry') ?? [], '--write-token-file'),
    ).toEqual([file])
    expect(
      flagValues(blockArgs(at, 'console') ?? [], '--registry-token-file'),
    ).toEqual([file])
    expect(readFileSync(at.argvLog, 'utf8')).not.toContain(WRITE_TOKEN)
    expect(run.out).not.toContain(WRITE_TOKEN)
    expect(run.out).not.toContain('注册中心写操作不鉴权')
  })

  test('⑦ 文件不在：两边都不带（与此前一样），并 WARN 说清启用步骤在哪', () => {
    const at = place()
    writePeers(at, ['qianmo://beta-4/planner ws://127.0.0.1:38625'])

    const run = runHost(at, {}, [...BOTH])

    expect({
      console: blockArgs(at, 'console') !== undefined,
      out: run.out,
    }).toEqual({ console: true, out: run.out })
    expect(blockArgs(at, 'registry')).not.toContain('--write-token-file')
    expect(blockArgs(at, 'console')).not.toContain('--registry-token-file')
    expect(run.out).toContain('注册中心写操作不鉴权')
    expect(run.out).toContain('注册中心写 token')
  })
})
