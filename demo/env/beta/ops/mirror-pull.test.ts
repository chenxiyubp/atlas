// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `mirror-pull.sh` 的退出码契约（issue #9①）。
 *
 * 内测环境四条 `qianmo-mirror@*.service` 每 5 分钟失败一次、稳定失败了数天，根因是
 * 脚本拿 `cat` 去读一个**尚未被创建**的链文件并以 exit 1 收场——把合法的初始态当成
 * 了拉取失败。失败得太吵，结果就是没人再看这四个单元的状态。
 *
 * 这套用例钉的是**分开之后没有把真失败一起吞掉**：那会把一个吵闹的盲区换成一个安静
 * 的盲区，比原样更糟。所以每一格都断言退出码 + 镜像文件的最终状态。
 *
 * 跑的是仓库里那一份真脚本（在临时内测根的 `ops/` 下软链过去，因为脚本从**自己的
 * 位置**推内测根），远端那一半用 PATH 上的 `ssh` 桩按 `STUB_MODE` 演各种回答。
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
const SCRIPT = join(REPOSITORY_ROOT, 'demo/env/beta/ops/mirror-pull.sh')
const NODE = 'beta-1'
const REMOTE_TRAIL =
  '/home/cornna/qianmo-beta/nodes/beta-1/config/qianmo/audit/trail.ndjson'
const roots: string[] = []

/**
 * `ssh` 桩。真脚本发过去的命令一概不看——生产上那把 key 带强制命令，客户端发什么
 * 都会被忽略，桩子照着这个事实演。
 */
const SSH_STUB = `#!/bin/bash
case "\${STUB_MODE:?}" in
  ok)
    printf '{"seq":1}\\n{"seq":2}\\n'
    ;;
  empty)
    ;;
  torn-tail)
    printf '{"seq":1}\\n{"seq":2'
    ;;
  truncated-transfer)
    printf '{"seq":1}\\n{"seq'
    printf 'client_loop: send disconnect: Broken pipe\\n' >&2
    exit 255
    ;;
  missing)
    printf '/usr/bin/cat: %s: No such file or directory\\n' "${REMOTE_TRAIL}" >&2
    exit 1
    ;;
  denied)
    printf '/usr/bin/cat: %s: Permission denied\\n' "${REMOTE_TRAIL}" >&2
    exit 1
    ;;
  is-directory)
    printf '/usr/bin/cat: %s: Is a directory\\n' "${REMOTE_TRAIL}" >&2
    exit 1
    ;;
  unreachable)
    printf 'ssh: connect to host 10.0.0.1 port 22: Connection refused\\n' >&2
    exit 255
    ;;
  *)
    printf 'unknown STUB_MODE\\n' >&2
    exit 42
    ;;
esac
`

/**
 * 脚本副本与 ssh 桩**整个文件只建一次**，每个用例只拿一个新的数据根。
 *
 * 不是洁癖：macOS 上**第一次执行一个新写出的文件**要付约 0.7 s 的扫描代价（实测，
 * 同一个 inode 第二次起就是 16 ms）。每个用例各拷一份脚本会让这套用例逐个逼近
 * 5 s 的单测预算，而那个超时与被测行为毫无关系。用例根里放的是**软链**——脚本按
 * `dirname "$0"` 推内测根，软链的路径就是它看到的路径，所以指向哪里不影响判定。
 */
const SHARED = mkdtempSync(join(tmpdir(), 'qianmo-mirror-pull-shared-'))
const SHARED_SCRIPT = join(SHARED, 'mirror-pull.sh')
const SHARED_BIN = join(SHARED, 'bin')
copyFileSync(SCRIPT, SHARED_SCRIPT)
chmodSync(SHARED_SCRIPT, 0o755)
mkdirSync(SHARED_BIN, { recursive: true })
writeFileSync(join(SHARED_BIN, 'ssh'), SSH_STUB)
chmodSync(join(SHARED_BIN, 'ssh'), 0o755)
// 那笔首执行开销在**模块作用域**付掉——这里没有任何用例的超时在跑。只建一次还不够：
// 文件里第一条走到这两个文件的用例仍要独自扛它，而它没有上界（issue #56 实测：6 路
// 「写新脚本再 exec 一次」的负载下，同一次扫描 p50 2273 ms、最坏 4278 ms，对着 5 000 ms
// 的单测预算）。两次调用都是**空转**：脚本第一行就是 `${1:?}`，桩第一行就是
// `${STUB_MODE:?}`，都在做任何事之前退出，退出码不看。
for (const executable of [SHARED_SCRIPT, join(SHARED_BIN, 'ssh')]) {
  Bun.spawnSync([executable], { stdout: 'ignore', stderr: 'ignore' })
}

function betaRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qianmo-mirror-pull-'))
  roots.push(root)
  const ops = join(root, 'ops')
  mkdirSync(ops, { recursive: true })
  // 真脚本，不是复刻的一份：它从 `dirname $0/..` 推内测根，所以必须落在 ops/ 下。
  symlinkSync(SHARED_SCRIPT, join(ops, 'mirror-pull.sh'))
  writeFileSync(
    join(ops, `tunnel-${NODE}.env`),
    [
      'NODE_SSH_USER=cornna',
      'NODE_SSH_HOST=10.0.0.1',
      'NODE_SSH_PORT=22',
      `NODE_SSH_KEY=${join(ops, 'fake-key')}`,
      `REMOTE_TRAIL=${REMOTE_TRAIL}`,
      '',
    ].join('\n'),
  )
  return root
}

function pull(
  root: string,
  mode: string,
): {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
} {
  const child = Bun.spawnSync([join(root, 'ops', 'mirror-pull.sh'), NODE], {
    cwd: REPOSITORY_ROOT,
    env: {
      ...process.env,
      PATH: `${SHARED_BIN}:/usr/bin:/bin`,
      STUB_MODE: mode,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

function mirrorDir(root: string): string {
  return join(root, 'mirror', NODE)
}

function mirror(root: string): string | undefined {
  const path = join(mirrorDir(root), 'trail.ndjson')
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/** 临时文件残留：H 上四个镜像目录各留了一个零字节的这种文件。 */
function leftovers(root: string): string[] {
  const dir = mirrorDir(root)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name !== 'trail.ndjson')
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { force: true, recursive: true })
})

afterAll(() => {
  rmSync(SHARED, { force: true, recursive: true })
})

describe('mirror-pull 的退出码契约', () => {
  test('远端链尚未创建是合法初始态，不是失败', () => {
    const root = betaRoot()
    const result = pull(root, 'missing')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('尚未创建')
    // 说清是初始态，别让读日志的人再判一次。
    expect(result.stdout).toContain('不是拉取失败')
    // 没有写出任何镜像：空文件也不写，页面上「有一份空链」与「还没有链」不是一回事。
    expect(mirror(root)).toBeUndefined()
    expect(leftovers(root)).toEqual([])
  })

  test('远端文件存在但还是空的，同样是初始态', () => {
    const root = betaRoot()
    const result = pull(root, 'empty')

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('尚未创建')
    expect(mirror(root)).toBeUndefined()
    expect(leftovers(root)).toEqual([])
  })

  test('正常拉取写出镜像并报出字节数与行数', () => {
    const root = betaRoot()
    const result = pull(root, 'ok')

    expect(result.exitCode).toBe(0)
    expect(mirror(root)).toBe('{"seq":1}\n{"seq":2}\n')
    // BSD 的 `wc` 会给数字左填空格，GNU 的不会——断言按数值判，不按字节判。
    expect(result.stdout).toMatch(/bytes=\s*20\b/)
    expect(result.stdout).toMatch(/lines=\s*2\b/)
    expect(leftovers(root)).toEqual([])
  })

  test('SSH 不通是真失败，不能被当成初始态吞掉', () => {
    const root = betaRoot()
    const result = pull(root, 'unreachable')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('SSH 本身失败')
    // 远端原话要带出来：分不清是密钥错还是端口错的话，这条告警等于没有。
    expect(result.stderr).toContain('Connection refused')
    expect(mirror(root)).toBeUndefined()
    expect(leftovers(root)).toEqual([])
  })

  test('权限被拒与「是个目录」都是真失败，而不是「还没有」', () => {
    // 两者与「文件不存在」共用退出码 1，靠远端那句话区分——这正是最容易被一并
    // 吞掉的一格。
    for (const mode of ['denied', 'is-directory']) {
      const root = betaRoot()
      const result = pull(root, mode)

      expect({ mode, exitCode: result.exitCode }).toEqual({ mode, exitCode: 1 })
      expect(result.stderr).toContain('拉取失败')
      expect(mirror(root)).toBeUndefined()
      expect(leftovers(root)).toEqual([])
    }
  })

  test('传输在中途断掉是真失败，不落盘半条记录', () => {
    const root = betaRoot()
    const result = pull(root, 'truncated-transfer')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('SSH 本身失败')
    expect(mirror(root)).toBeUndefined()
    expect(leftovers(root)).toEqual([])
  })

  test('节点侧写到一半的 torn_tail 照常镜像，只说一声', () => {
    // 与上一条只差一个退出码，结论却相反，这正是它们要分开写的原因：ssh 给 0 意味着
    // 远端命令**跑完了**，拿到的就是节点上那一份的样子。`@qianmo/audit` 的 `readTrail`
    // 明说 torn_tail 不是篡改（是一次硬重启的正常样子）——为它每 5 分钟失败一次，
    // 等于把 issue #9 那个形状原样搬到另一个格子里，而且这份数据本来就该镜像过来。
    const root = betaRoot()
    const result = pull(root, 'torn-tail')

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain('torn_tail')
    expect(mirror(root)).toBe('{"seq":1}\n{"seq":2')
    expect(leftovers(root)).toEqual([])
  })

  test('已经有镜像之后远端说没有，是链消失了，必须报失败', () => {
    const root = betaRoot()
    expect(pull(root, 'ok').exitCode).toBe(0)

    const result = pull(root, 'missing')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('消失')
    // 上一份镜像原样留着。
    expect(mirror(root)).toBe('{"seq":1}\n{"seq":2}\n')
    expect(leftovers(root)).toEqual([])
  })

  test('已经有镜像之后拉到空文件，保留旧镜像并报失败', () => {
    const root = betaRoot()
    expect(pull(root, 'ok').exitCode).toBe(0)

    const result = pull(root, 'empty')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('保留上一份')
    expect(mirror(root)).toBe('{"seq":1}\n{"seq":2}\n')
    expect(leftovers(root)).toEqual([])
  })

  test('上一代留下的临时文件会被扫掉', () => {
    const root = betaRoot()
    const dir = mirrorDir(root)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'trail.ndjson.tmp.4242'), '')

    expect(pull(root, 'missing').exitCode).toBe(0)
    expect(leftovers(root)).toEqual([])
  })

  test('缺 tunnel-<node>.env 时说清它由谁派生', () => {
    const root = betaRoot()
    rmSync(join(root, 'ops', `tunnel-${NODE}.env`))
    const result = pull(root, 'ok')

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain('peers.conf')
  })
})
