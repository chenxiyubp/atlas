// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * P0.7 ③ —— 把「Dormice daemon 只绑回环」做成 CI 可断言的不变式。
 *
 * 为什么断言的是脚本行为，而不是"探测端口"
 * ----------------------------------------
 * CI runner 上没有 Dormice daemon，也够不到部署环境，任何探测式断言在这里都
 * 只能恒绿——而恒绿的断言等于没有断言。所以本文件断言的是**判定逻辑本身**：
 * 用固定的监听表快照喂给真正会在服务器上运行的 `check-daemon-bind.sh`，把
 * 绿灯与红灯两个方向都钉死。快照喂入不是为测试开的后门，而是脚本本就支持的
 * 离线复核入口（DORMICE_LISTEN_SNAPSHOT）。
 *
 * 为什么不把判定逻辑在 TS 里重写一遍
 * ----------------------------------
 * 那会让同一条规则存在两份（违反「指针不复制」），而且测的是副本、跑的是原件，
 * 副本绿了不代表原件对。这里直接执行仓库里那个 .sh 文件，测的就是会上线的那份。
 *
 * 关于"仓库内 Dormice 端点配置必须指向回环"这条静态断言
 * ------------------------------------------------------
 * 见文件末尾那组测试的注释：**当前仓库尚无任何 Dormice 集成代码或配置**
 * （`git grep -i dormice -- src packages scripts .github` 零命中，只有
 * docs/dev/*.md 在描述它），所以那条扫描今天扫到的对象为零、恒绿。它的价值是
 * 在 P1.3 接入 Dormice 时自动生效，其判定逻辑的红灯方向由 fixture 负向自测保证。
 */

import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OPS_DIR = join(import.meta.dir, '..')
const CHECK_SCRIPT = join(OPS_DIR, 'check-daemon-bind.sh')
const HARDEN_SCRIPT = join(OPS_DIR, 'harden-dormice-host.sh')
const REPO_ROOT = join(OPS_DIR, '..', '..')

/** Windows 上没有 bash；这些用例只在类 Unix 上有意义。 */
const onUnix = process.platform !== 'win32'

interface RunResult {
  status: number
  stdout: string
  stderr: string
}

function runBash(args: string[], env: Record<string, string> = {}): RunResult {
  const result = spawnSync('bash', args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** 把一份 `ss -Hltn` 格式的监听表写进临时目录，返回文件路径与清理函数。 */
function withSnapshot(lines: string[]): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-bind-'))
  const path = join(dir, 'listeners.txt')
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8')
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function checkWithSnapshot(
  lines: string[],
  env: Record<string, string> = {},
): RunResult {
  const snapshot = withSnapshot(lines)
  try {
    return runBash([CHECK_SCRIPT], {
      DORMICE_LISTEN_SNAPSHOT: snapshot.path,
      ...env,
    })
  } finally {
    snapshot.cleanup()
  }
}

// `ss -Hltn` 的列序：State Recv-Q Send-Q Local-Address:Port Peer-Address:Port
const listen = (local: string) => `LISTEN 0 4096 ${local} 0.0.0.0:*`

describe.skipIf(!onUnix)('两个运维脚本的语法', () => {
  // 仓库里没有 shellcheck 门禁，`bash -n` 至少保证这两个文件在被 systemd
  // 拉起之前不会因为语法错误在生产上炸开。
  test.each([
    ['check-daemon-bind.sh', CHECK_SCRIPT],
    ['harden-dormice-host.sh', HARDEN_SCRIPT],
  ])('%s 通过 bash -n', (_name, script) => {
    const result = runBash(['-n', script])
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})

describe.skipIf(!onUnix)('check-daemon-bind.sh 的绑定不变式判定', () => {
  test('只有回环监听时绿灯（退出 0）', () => {
    const result = checkWithSnapshot([
      listen('127.0.0.1:3676'),
      listen('0.0.0.0:80'), // 别的服务对外监听与本不变式无关，不许误杀
    ])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('不变式成立')
  })

  test('IPv6 回环同样算成立', () => {
    const result = checkWithSnapshot([listen('[::1]:3676')])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('不变式成立')
  })

  // ↓↓↓ 负向自测：这三条证明断言会在被破坏时真的变红，而不是恒绿。
  test('通配监听 0.0.0.0 时红灯（退出 1）', () => {
    const result = checkWithSnapshot([listen('0.0.0.0:3676')])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('不变式被破坏')
    expect(result.stderr).toContain('0.0.0.0:3676')
  })

  test('IPv6 通配监听 [::] 时红灯', () => {
    const result = checkWithSnapshot([listen('[::]:3676')])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('不变式被破坏')
  })

  test('绑到具体网卡地址（非回环）时红灯', () => {
    // 这才是最容易被误当成"没对外"的情形：绑的不是 0.0.0.0，但沙箱够得到。
    const result = checkWithSnapshot([listen('192.0.2.10:3676')])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('不变式被破坏')
  })

  test('daemon 未监听该端口时不判定（退出 0 并说明）', () => {
    const result = checkWithSnapshot([listen('0.0.0.0:80')])
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('没有任何监听')
  })

  test('端口取自 DORMICE_DAEMON_PORT：同一份快照两种结论', () => {
    const snapshotLines = [listen('0.0.0.0:39999')]

    const otherPort = checkWithSnapshot(snapshotLines)
    expect(otherPort.status).toBe(0) // 默认端口上没有监听 -> 不判定

    const thatPort = checkWithSnapshot(snapshotLines, {
      DORMICE_DAEMON_PORT: '39999',
    })
    expect(thatPort.status).toBe(1) // 换成那个端口 -> 立刻红
  })

  test('端口不是数字时报无法判定（退出 2），不冒充成立', () => {
    const result = checkWithSnapshot([listen('127.0.0.1:3676')], {
      DORMICE_DAEMON_PORT: 'not-a-port',
    })
    expect(result.status).toBe(2)
  })

  test('快照文件不可读时报无法判定（退出 2）', () => {
    const result = runBash([CHECK_SCRIPT], {
      DORMICE_LISTEN_SNAPSHOT: join(tmpdir(), 'qianmo-does-not-exist-3676'),
    })
    expect(result.status).toBe(2)
  })
})

describe.skipIf(!onUnix)('harden-dormice-host.sh 的加固计划', () => {
  // 真机实测的结论是"两条链都要有"：INPUT 是唯一生效的那条（容器→宿主本机
  // 端口走 INPUT，不走 FORWARD/DOCKER-USER），DOCKER-USER 是纵深冗余。谁哪天
  // 觉得 DOCKER-USER 那条"反正没用"删掉、或觉得 INPUT 那条"太粗暴"删掉，这里变红。
  const plan = () => runBash([HARDEN_SCRIPT, '--dry-run'])

  test('--dry-run 不需要 root 也不改任何规则', () => {
    const result = plan()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--dry-run')
  })

  test('两条链都在计划里：INPUT（生效）+ DOCKER-USER（纵深）', () => {
    const { stdout } = plan()
    expect(stdout).toContain('-I INPUT 1')
    expect(stdout).toContain('-I DOCKER-USER 1')
  })

  test('幂等：每条链都是先删同规则再插链首', () => {
    const { stdout } = plan()
    for (const chain of ['INPUT', 'DOCKER-USER']) {
      const del = stdout.indexOf(`-D ${chain} `)
      const ins = stdout.indexOf(`-I ${chain} 1`)
      expect(del).toBeGreaterThanOrEqual(0)
      expect(ins).toBeGreaterThanOrEqual(0)
      expect(del).toBeLessThan(ins)
    }
  })

  test('端口与网卡取自环境变量', () => {
    const { stdout } = runBash([HARDEN_SCRIPT, '--dry-run'], {
      DORMICE_DAEMON_PORT: '4242',
      DORMICE_DOCKER_IF: 'br-qianmo',
    })
    expect(stdout).toContain('--dport 4242')
    expect(stdout).toContain('-i br-qianmo')
    expect(stdout).not.toContain('--dport 3676')
  })

  test('未知参数报错退出，不静默按默认值加固', () => {
    const result = runBash([HARDEN_SCRIPT, '--wat'])
    expect(result.status).toBe(1)
  })
})

/**
 * 判定一段文本里有没有"指向非回环地址的端点声明"。
 *
 * 只看**像端点声明**的行（含地址字面量，且同一行还有端口或 host/bind/listen/
 * url/proxy_pass 这类键），避免把散文里出现的数字串当成配置。回环
 * （127.0.0.0/8、::1）放行——它正是我们要求的那个值。
 */
function findNonLoopbackEndpoints(
  content: string,
): { line: number; text: string; address: string }[] {
  const ipv4 = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g
  const endpointish = /(:\d{2,5}\b)|(host|bind|listen|addr|url|proxy_pass)/i
  const findings: { line: number; text: string; address: string }[] = []

  content.split('\n').forEach((text, index) => {
    if (!endpointish.test(text)) return
    for (const match of text.matchAll(ipv4)) {
      const address = match[0]
      if (address.startsWith('127.')) continue
      findings.push({ line: index + 1, text: text.trim(), address })
    }
    // IPv6 通配监听写法：`[::]:port` / `:::port`
    if (/\[::\]:\d{2,5}|(?:^|\s):::\d{2,5}/.test(text)) {
      findings.push({ line: index + 1, text: text.trim(), address: '[::]' })
    }
  })

  return findings
}

/** 判定一段文本里有没有主机名 / 具体地址 / 凭据这类不该入库的东西。 */
function findOperationalSecrets(
  content: string,
): { line: number; reason: string }[] {
  const rules: { reason: string; pattern: RegExp }[] = [
    // 允许的地址字面量只有两类判定常量：回环，以及作为"违规示例"的通配符。
    {
      reason: 'IPv4 地址字面量（回环与 0.0.0.0 除外）',
      pattern: /\b(?!127\.|0\.0\.0\.0\b)\d{1,3}(?:\.\d{1,3}){3}\b/,
    },
    { reason: '外部 URL', pattern: /\bhttps?:\/\/\S/i },
    {
      reason: '主机名',
      pattern: /\b[a-z0-9][a-z0-9-]*\.(com|net|org|io|cn|dev|internal)\b/i,
    },
    {
      reason: '疑似凭据',
      pattern:
        /(bearer\s+[\w.~+/=-]{12,}|api[_-]?key\s*[=:]|password\s*[=:]|secret\s*[=:]|-----BEGIN)/i,
    },
  ]

  const findings: { line: number; reason: string }[] = []
  content.split('\n').forEach((text, index) => {
    for (const rule of rules) {
      if (rule.pattern.test(text)) {
        findings.push({ line: index + 1, reason: rule.reason })
      }
    }
  })
  return findings
}

describe('入库的运维产物不含主机名 / 地址 / 凭据', () => {
  // P0.7 DoD 的硬要求。这条不是恒绿的：负向自测在下面。
  const artifacts = [
    'harden-dormice-host.sh',
    'check-daemon-bind.sh',
    'dormice-harden.service',
    'README.md',
  ]

  test.each(artifacts)('%s 干净', name => {
    const content = readFileSync(join(OPS_DIR, name), 'utf8')
    expect(findOperationalSecrets(content)).toEqual([])
  })

  test('负向自测：混入地址 / 主机名 / 凭据的样例必须被抓住', () => {
    const dirty = [
      'ExecStart=/usr/local/sbin/harden.sh --peer 198.51.100.7',
      'Documentation=https://ops.example.internal/runbook',
      'Environment=DORMICE_API_KEY=Bearer abcd1234efgh5678',
    ].join('\n')

    const findings = findOperationalSecrets(dirty)
    const reasons = findings.map(f => f.reason)
    expect(reasons).toContain('IPv4 地址字面量（回环与 0.0.0.0 除外）')
    expect(reasons).toContain('外部 URL')
    expect(reasons).toContain('疑似凭据')
    expect(findings.length).toBeGreaterThanOrEqual(3)
  })
})

describe('仓库内的 Dormice 端点配置必须指向回环', () => {
  /**
   * 前向守卫。今天扫到的文件数为零——仓库还没有任何 Dormice 集成代码或配置，
   * 只有 docs/dev/*.md 在描述它（文档要能写出 `0.0.0.0` 这个反例，所以不扫
   * 文档；scripts/ops 自身由上一组的"不含地址"断言覆盖）。
   *
   * 恒绿的断言等于没有断言，所以这条的红灯方向由紧随其后的 fixture 负向自测
   * 保证：判定函数一旦遇到非回环端点就会给出 finding。P1.3 接入 Dormice 后，
   * 这条扫描不需要任何改动就会自动开始有对象可扫。
   */
  const dormiceFiles = (): string[] => {
    const result = spawnSync(
      'git',
      [
        'grep',
        '-lI',
        '-i',
        '-e',
        'dormice',
        '--',
        'src',
        'packages',
        'scripts',
        '.github',
        ':!scripts/ops',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    // git grep: 0 有命中 / 1 无命中 / 其它才是真错误
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`git grep 失败: ${result.stderr}`)
    }
    return result.stdout.split('\n').filter(Boolean)
  }

  test('凡提到 Dormice 的代码/配置文件，端点都不得指向非回环地址', () => {
    const offenders: string[] = []
    for (const file of dormiceFiles()) {
      const content = readFileSync(join(REPO_ROOT, file), 'utf8')
      for (const finding of findNonLoopbackEndpoints(content)) {
        offenders.push(`${file}:${finding.line} -> ${finding.address}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('负向自测：非回环端点配置必须被抓住', () => {
    const dirty = [
      'export const DAEMON_URL = "http://0.0.0.0:3676"',
      'daemon_host = 203.0.113.9',
      'listen [::]:3676;',
    ].join('\n')

    const findings = findNonLoopbackEndpoints(dirty)
    expect(findings.map(f => f.address)).toEqual([
      '0.0.0.0',
      '203.0.113.9',
      '[::]',
    ])
  })

  test('正向对照：回环端点配置不报', () => {
    const clean = [
      'export const DAEMON_URL = "http://127.0.0.1:3676"',
      'daemon_host = 127.0.0.1',
    ].join('\n')
    expect(findNonLoopbackEndpoints(clean)).toEqual([])
  })
})
