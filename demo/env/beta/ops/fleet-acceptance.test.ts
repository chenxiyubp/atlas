// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `fleet-acceptance.sh` —— 真机腿的起法（issue #113）。
 *
 * 在它之前这是一份口头知识：`grep -rn "QIANMO_ACCEPTANCE_PSK_"` 在 `*.md` /
 * `*.sh` 上是空的，唯一提到那些变量名的是 `fleetConfigFromEnv()` 自己的实现。
 * 于是换个人接手时最省事的做法是自己现编一条命令行，而**少接一把 PSK 的表现
 * 不是报错** —— 是那个节点的场景整片 skip 或红，两者都容易被读成「环境问题」。
 *
 * 所以这里钉的是那两件会静默出错的事：
 *
 *   ① 少一把就**当场退出**，且退出信息里点名是哪个节点、哪台机器；
 *   ② **任何一条输出里都不出现 PSK 的值** —— 通过时打的是 sha256 前 8 位。
 *
 * 手法：PATH 上放一个假 `ssh`（按目标机名回不同的值）与一个假 `bun`（把最终
 * 命令行与它看到的那几个 PSK 变量录下来），于是整条壳跑得完，而一个真连接都
 * 不建、一次真套件都不跑。
 */

import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const HERE = resolve(import.meta.dir)
const LAUNCHER = join(HERE, 'fleet-acceptance.sh')
const DRIVER = resolve(
  HERE,
  '..',
  '..',
  '..',
  'lib',
  'acceptance',
  'fleet',
  'driver.ts',
)

/** 四把各不相同 —— 相同的话「没串台」就证不出来了。 */
const PSK_OF: Readonly<Record<string, string>> = {
  'cornna-p2': 'psk-value-for-beta-1-not-a-real-secret',
  'cornna-p3': 'psk-value-for-beta-2-not-a-real-secret',
  'cornna-p7': 'psk-value-for-beta-3-not-a-real-secret',
  'cornna-p11': 'psk-value-for-beta-4-not-a-real-secret',
}

const made: string[] = []

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Place {
  readonly bin: string
  readonly runLog: string
}

/**
 * 桩**整份文件只写一次**，用例里落的是指向它的软链（issue #102 / #56）。
 *
 * macOS 对**每个新写出来的可执行 inode** 收一次首次执行策略扫描
 * （Gatekeeper / `syspolicyd`）：机器空闲时约 70–100 ms，机器一忙实测涨到
 * 1.8–2.5 s 且**没有上限**；指向已执行过 inode 的软链稳定在 4.5 ms 上下。
 * 单条用例的预算是 **5 s**（Bun 1.3.13 不读 `bunfig` 的 `[test] timeout`），
 * 于是「每条用例现写两个桩」在本机几乎看不出来，一到跑满的 `verify` 上就
 * 超时——本文件写完第一版当天就撞上了：`不带 --` 那条 5400 ms 红，
 * 而它的中位数只有几百毫秒。
 *
 * 所以桩的内容不许带每用例的东西：假 `bun` 的日志路径改从环境变量读（原先
 * 是把路径拼进脚本里，那会让每个 `place()` 都产生一个新 inode），假 `ssh`
 * 只随 `missing` 集合分出两三种，按内容折成同一个 inode。
 */
const SCAN_ONCE_DIR = mkdtempSync(join(tmpdir(), 'qm-fleet-acceptance-bin-'))
const scanOnce = new Map<string, string>()

afterAll(() => {
  rmSync(SCAN_ONCE_DIR, { recursive: true, force: true })
})

/** 同样内容只写一个 inode；第一次写完当场预热，把扫描付在用例计时器之外。 */
function sharedExecutable(key: string, text: string): string {
  const hit = scanOnce.get(key)
  if (hit !== undefined) return hit
  const path = join(SCAN_ONCE_DIR, key)
  writeFileSync(path, text, { mode: 0o755 })
  // **预热必须在这里**，不能等到用例里——那时超时计时器已经在跑了。
  Bun.spawnSync([path, '--qianmo-warmup'], {
    env: {
      ...process.env,
      QM_FLEET_ACCEPTANCE_RUN_LOG: join(SCAN_ONCE_DIR, 'warmup.log'),
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  scanOnce.set(key, path)
  return path
}

/**
 * 假 ssh 只认得「取那个文件」这一种用法：认不出来就退 2，于是壳里那条
 * `cat $HOME/<路径>` 写错了会红，而不是悄悄拿到空串走下去。
 */
function fakeSsh(missing: readonly string[]): string {
  const cases = Object.entries(PSK_OF)
    .map(([host, value]) =>
      missing.includes(host)
        ? `    ${host}) exit 255 ;;`
        : `    ${host}) printf '%s\\n' '${value}'; exit 0 ;;`,
    )
    .join('\n')
  return `#!/bin/bash
# 只认得「取 PSK」这一种用法。
case "\${2:-}" in
  *transport-psk*) ;;
  *) echo "fake ssh: 没预期到的远端命令: \${2:-}" >&2; exit 2 ;;
esac
case "\${1:-}" in
${cases}
  *) echo "fake ssh: 不认识的目标 \${1:-}" >&2; exit 2 ;;
esac
`
}

/** 日志路径从环境来，不拼进脚本里 —— 拼进去等于每个 `place()` 一个新 inode。 */
const FAKE_BUN = `#!/bin/bash
out="\${QM_FLEET_ACCEPTANCE_RUN_LOG:?}"
{
  printf 'ARGV\\n'
  printf '%s\\n' "$@"
  printf 'ENV\\n'
  env | grep '^QIANMO_ACCEPTANCE_PSK_' | sort
} >"$out"
`

const SSH_MISSING_NONE: readonly string[] = []
const SSH_MISSING_P7: readonly string[] = ['cornna-p7']

/**
 * 桩在**模块作用域**全部落地并预热，一个都不留给用例去写。
 *
 * 懒到 `place()` 里再写是不够的：第一条调用它的用例仍然要独自扛那条没有上限
 * 的尾巴。本文件第一版就是那么写的，实测第一条用例 3.25 s，其余的都在一百
 * 毫秒上下 —— 在忙起来的 `verify` 上，那 3.25 s 就是 5 s 预算的大半。
 */
const STUBS = {
  sshAll: sharedExecutable('ssh_all', fakeSsh(SSH_MISSING_NONE)),
  sshNoP7: sharedExecutable('ssh_no_p7', fakeSsh(SSH_MISSING_P7)),
  bun: sharedExecutable('bun', FAKE_BUN),
} as const

function place(options: { readonly missing?: readonly string[] } = {}): Place {
  const base = mkdtempSync(join(tmpdir(), 'qm-fleet-acceptance-'))
  made.push(base)
  const bin = join(base, 'bin')
  mkdirSync(bin, { recursive: true })
  const missing = options.missing ?? SSH_MISSING_NONE
  if (missing.length > 0 && missing.join(',') !== SSH_MISSING_P7.join(',')) {
    throw new Error(
      `桩是模块作用域预建的，${missing.join(',')} 这一种还没有 —— 新增一种就往 STUBS 里加一条，别在用例里现写。`,
    )
  }
  symlinkSync(
    missing.length === 0 ? STUBS.sshAll : STUBS.sshNoP7,
    join(bin, 'ssh'),
  )
  symlinkSync(STUBS.bun, join(bin, 'bun'))
  return { bin, runLog: join(base, 'run.log') }
}

function run(
  spot: Place,
  args: readonly string[] = [],
  extraEnv: Readonly<Record<string, string>> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const child = Bun.spawnSync(['/bin/bash', LAUNCHER, ...args], {
    env: {
      PATH: `${spot.bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: process.env.HOME ?? '',
      QM_FLEET_ACCEPTANCE_RUN_LOG: spot.runLog,
      ...extraEnv,
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

function recorded(spot: Place): { argv: string[]; env: string[] } {
  if (!existsSync(spot.runLog)) return { argv: [], env: [] }
  const lines = readFileSync(spot.runLog, 'utf8').split('\n')
  const cut = lines.indexOf('ENV')
  return {
    argv: lines.slice(1, cut).filter(line => line !== ''),
    env: lines.slice(cut + 1).filter(line => line !== ''),
  }
}

describe('fleet-acceptance.sh', () => {
  test('四把 PSK 各就各位，再 exec 那个 runner', () => {
    const spot = place()
    const result = run(spot, ['--', '--only', 'handshake/psk-ok'])

    expect(result.exitCode).toBe(0)
    const { argv, env } = recorded(spot)
    expect(argv).toEqual([
      'run',
      'scripts/qianmo-acceptance.ts',
      '--target',
      'fleet',
      '--only',
      'handshake/psk-ok',
    ])
    // 节点名 → 变量名的映射（`beta-1` → `BETA_1`）与 driver.ts 的 `envSuffix()`
    // 是同一条规则，而它此前只以那个函数的形式存在。
    expect(env).toEqual([
      `QIANMO_ACCEPTANCE_PSK_BETA_1=${PSK_OF['cornna-p2']}`,
      `QIANMO_ACCEPTANCE_PSK_BETA_2=${PSK_OF['cornna-p3']}`,
      `QIANMO_ACCEPTANCE_PSK_BETA_3=${PSK_OF['cornna-p7']}`,
      `QIANMO_ACCEPTANCE_PSK_BETA_4=${PSK_OF['cornna-p11']}`,
    ])
  })

  test('少一把就当场退出，并且点名是哪个节点、哪台机器', () => {
    const spot = place({ missing: ['cornna-p7'] })
    const result = run(spot, ['--', '--only', 'handshake/psk-ok'])

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('beta-3')
    expect(result.stderr).toContain('cornna-p7')
    // **没有 exec**：带着空 PSK 跑出来的那一轮，红与 skip 都会被读成「环境问题」。
    expect(existsSync(spot.runLog)).toBe(false)
  })

  test('任何一条输出里都不出现 PSK 的值 —— 出现的是 sha256 前 8 位', () => {
    const spot = place()
    const result = run(spot, ['--', '--only', 'handshake/psk-ok'])
    const said = `${result.stdout}${result.stderr}`

    for (const value of Object.values(PSK_OF)) {
      expect(said).not.toContain(value)
    }
    for (const value of Object.values(PSK_OF)) {
      const digest = new Bun.CryptoHasher('sha256')
        .update(value)
        .digest('hex')
        .slice(0, 8)
      expect(said).toContain(`sha256:${digest}`)
    }
  })

  test('少一把的那条错误信息里也不带任何一把的值', () => {
    const spot = place({ missing: ['cornna-p7'] })
    const result = run(spot, [])
    const said = `${result.stdout}${result.stderr}`
    for (const value of Object.values(PSK_OF)) {
      expect(said).not.toContain(value)
    }
  })

  test('环境里已经有的那一把不去机器上取，也不被覆盖', () => {
    // p7 的 ssh 是坏的，而这一轮照样成功 —— 因为 beta-3 直接从环境里来。
    const spot = place({ missing: ['cornna-p7'] })
    const result = run(spot, ['--'], {
      QIANMO_ACCEPTANCE_PSK_BETA_3: 'given-on-the-command-line',
    })

    expect(result.exitCode).toBe(0)
    expect(recorded(spot).env).toContain(
      'QIANMO_ACCEPTANCE_PSK_BETA_3=given-on-the-command-line',
    )
    expect(result.stderr).toContain('沿用环境里的 1')
  })

  test('不带 `--` 也跑得起来（就是不给套件加参数）', () => {
    const spot = place()
    expect(run(spot, []).exitCode).toBe(0)
    expect(recorded(spot).argv).toEqual([
      'run',
      'scripts/qianmo-acceptance.ts',
      '--target',
      'fleet',
    ])
  })

  test('未知参数不静默吞掉 —— 透传的东西必须在 `--` 后面', () => {
    const spot = place()
    const result = run(spot, ['--only', 'handshake/psk-ok'])
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('-- 后面')
    expect(existsSync(spot.runLog)).toBe(false)
  })

  /**
   * 这条盯的是**两处真源会不会漂**：壳里那张 `<ssh 目标>=<节点名>` 的缺省表，
   * 与 `DEFAULT_FLEET_HOSTS` 是同一件事实。漂了的表现不是报错，是壳去另一台
   * 机器取 PSK、取到了、然后整条腿对着错的节点跑。
   */
  test('缺省的机器/节点对应表与 DEFAULT_FLEET_HOSTS 一致', () => {
    const shell = readFileSync(LAUNCHER, 'utf8')
    const line = /QIANMO_ACCEPTANCE_FLEET_PAIRS:-([^}]*)\}/.exec(shell)?.[1]
    expect(line).toBeDefined()
    const fromShell = (line ?? '').trim().split(/\s+/)

    const driver = readFileSync(DRIVER, 'utf8')
    const table = /DEFAULT_FLEET_HOSTS[\s\S]*?\n\]/.exec(driver)?.[0] ?? ''
    const pairs: string[] = []
    for (const block of table.split('{').slice(1)) {
      const ssh = /ssh:\s*'([^']+)'/.exec(block)?.[1]
      const node = /node:\s*'([^']+)'/.exec(block)?.[1]
      if (ssh !== undefined && node !== undefined) pairs.push(`${ssh}=${node}`)
    }
    expect(pairs.length).toBe(4)
    expect(fromShell).toEqual(pairs)
  })
})
