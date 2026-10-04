// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `console-https.sh` 的契约：装出来的单元没有残留占位符、DNS 凭据只进 lego 的环境
 * 而不进 argv、权限不对就拒绝、staging 与正式证书分目录、续期带部署钩子。
 *
 * 跑的是仓库里那一份真脚本；lego 用一个桩代替（记下它收到的 argv，以及环境里的
 * token 是否正确），systemctl 用环境变量关掉——测试机上的 systemd --user 是真的，
 * 不能让用例往里 enable 东西。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, 'console-https.sh')
const TOKEN = 'cf-token-for-test-3b9a17'
const DOMAIN = 'qianmo.example'
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

interface Fixture {
  readonly home: string
  readonly root: string
  readonly out: string
  readonly lego: string
}

function fixture(
  options: { marker?: boolean; tokenMode?: number | null } = {},
): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'console-https-'))
  dirs.push(home)
  const root = join(home, 'qianmo-beta')
  const out = join(home, 'stub-out')
  mkdirSync(join(root, 'secrets'), { recursive: true })
  mkdirSync(out)
  if (options.marker !== false) {
    writeFileSync(join(root, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  }
  const tokenMode = options.tokenMode === undefined ? 0o600 : options.tokenMode
  if (tokenMode !== null) {
    const file = join(root, 'secrets', 'cf-dns.env')
    writeFileSync(file, `CF_DNS_API_TOKEN=${TOKEN}\n`)
    chmodSync(file, tokenMode)
  }
  const lego = join(home, 'lego')
  writeFileSync(
    lego,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$@" > '${out}/argv.txt'`,
      `if [ "\${CF_DNS_API_TOKEN:-}" = '${TOKEN}' ]; then echo yes; else echo no; fi > '${out}/token-in-env.txt'`,
      '',
    ].join('\n'),
  )
  chmodSync(lego, 0o755)
  return { home, root, out, lego }
}

function run(
  f: Fixture,
  args: readonly string[],
  script = SCRIPT,
): { code: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(['bash', script, ...args], {
    env: {
      HOME: f.home,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      QIANMO_BETA_ROOT: f.root,
      XDG_CONFIG_HOME: join(f.home, '.config'),
      QIANMO_CONSOLE_HTTPS_NO_SYSTEMCTL: '1',
    },
  })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

function install(f: Fixture): void {
  const result = run(f, ['install', '--domain', DOMAIN, '--lego', f.lego])
  expect(result.stderr).toBe('')
  expect(result.code).toBe(0)
}

describe('install', () => {
  test('写出 0600 的参数文件、拷两份程序、渲染三个单元且不留占位符', () => {
    const f = fixture()
    install(f)
    const conf = join(f.root, 'ops', 'console-https.env')
    expect(statSync(conf).mode & 0o777).toBe(0o600)
    const text = readFileSync(conf, 'utf8')
    expect(text).toContain(`CONSOLE_HTTPS_DOMAIN=${DOMAIN}\n`)
    expect(text).toContain('CONSOLE_HTTPS_LISTEN=0.0.0.0:38443\n')
    expect(text).toContain('CONSOLE_HTTPS_UPSTREAM=http://127.0.0.1:38621\n')
    expect(text).toContain(
      `CONSOLE_HTTPS_KEY=${join(f.root, 'tls/lego/certificates', `${DOMAIN}.key`)}\n`,
    )
    expect(existsSync(join(f.root, 'ops', 'console-tls-front.ts'))).toBe(true)
    expect(statSync(join(f.root, 'ops', 'console-https.sh')).mode & 0o777).toBe(
      0o700,
    )
    for (const unit of [
      'qianmo-tls-front.service',
      'qianmo-console-cert.service',
      'qianmo-console-cert.timer',
    ]) {
      const installed = readFileSync(
        join(f.home, '.config', 'systemd', 'user', unit),
        'utf8',
      )
      expect(installed).not.toMatch(/@[A-Z_]+@/)
    }
    const front = readFileSync(
      join(f.home, '.config', 'systemd', 'user', 'qianmo-tls-front.service'),
      'utf8',
    )
    // 家目录下的路径写成 %h/…，与 beta-up.sh 装的那几个单元同一个约定。
    expect(front).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是 systemd 的 ${VAR} 引用，不是 JS 模板占位
      '%h/qianmo-beta/ops/console-tls-front.ts --listen ${CONSOLE_HTTPS_LISTEN}',
    )
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上，systemd 从 EnvironmentFile 展开
    expect(front).toContain('--upstream ${CONSOLE_HTTPS_UPSTREAM}')
    expect(front).toContain(
      'EnvironmentFile=%h/qianmo-beta/ops/console-https.env',
    )
  })

  test('从装好的那一份跑 install 当场拒绝，参数文件原样不动（它旁边没有 *.in 模板）', () => {
    const f = fixture()
    install(f)
    const conf = join(f.root, 'ops', 'console-https.env')
    const before = readFileSync(conf, 'utf8')
    const result = run(
      f,
      ['install', '--domain', DOMAIN, '--upstream', 'http://127.0.0.1:1'],
      join(f.root, 'ops', 'console-https.sh'),
    )
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('要从仓库')
    expect(readFileSync(conf, 'utf8')).toBe(before)
  })

  test('从仓库那一份重跑 install 会改写参数文件（换上游就是这么换的）', () => {
    const f = fixture()
    install(f)
    const result = run(f, [
      'install',
      '--domain',
      DOMAIN,
      '--upstream',
      'http://127.0.0.1:38622',
      '--lego',
      f.lego,
    ])
    expect(result.code).toBe(0)
    expect(
      readFileSync(join(f.root, 'ops', 'console-https.env'), 'utf8'),
    ).toContain('CONSOLE_HTTPS_UPSTREAM=http://127.0.0.1:38622\n')
  })

  test('不是内测根（没有标记文件）就拒绝', () => {
    const f = fixture({ marker: false })
    const result = run(f, ['install', '--domain', DOMAIN, '--lego', f.lego])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('不是内测环境')
  })

  test('域名里有 shell 或 sed 会误读的字符就拒绝', () => {
    const f = fixture()
    const result = run(f, ['install', '--domain', 'a|b.example'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('不该有的字符')
  })
})

describe('issue / renew：DNS 凭据只进 lego 的环境', () => {
  test('token 文件不是 0600 就拒绝，lego 一次都不调', () => {
    const f = fixture({ tokenMode: 0o644 })
    install(f)
    const result = run(f, ['issue', '--staging'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('要 600')
    expect(existsSync(join(f.out, 'argv.txt'))).toBe(false)
  })

  test('没有 token 文件就拒绝', () => {
    const f = fixture({ tokenMode: null })
    install(f)
    const result = run(f, ['issue', '--staging'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('缺 DNS 凭据')
  })

  test('--staging：独立目录、staging 服务器、没有部署钩子；token 在环境里、不在 argv 里', () => {
    const f = fixture()
    install(f)
    const result = run(f, ['issue', '--staging'])
    expect(result.code).toBe(0)
    const argv = readFileSync(join(f.out, 'argv.txt'), 'utf8').split('\n')
    expect(argv[0]).toBe('run')
    expect(argv).toContain('--server')
    expect(argv).toContain('letsencrypt-staging')
    expect(argv).toContain(join(f.root, 'tls', 'lego-staging'))
    expect(argv).toContain('cloudflare')
    // 本机递归解析器会负缓存 lego 预查时的 NXDOMAIN（见脚本里 run_lego 的注释）。
    expect(argv).toContain('--dns.propagation.disable-rns')
    expect(argv).toContain(DOMAIN)
    expect(argv).not.toContain('--deploy-hook')
    expect(argv.join('\n')).not.toContain(TOKEN)
    expect(readFileSync(join(f.out, 'token-in-env.txt'), 'utf8').trim()).toBe(
      'yes',
    )
    expect(statSync(join(f.root, 'tls', 'lego-staging')).mode & 0o777).toBe(
      0o700,
    )
    // 本脚本自己的输出里也没有它。
    expect(result.stdout + result.stderr).not.toContain(TOKEN)
  })

  test('renew（从装好的那一份跑，根从自己的位置推）：正式目录 + 部署钩子', () => {
    const f = fixture()
    install(f)
    const installed = join(f.root, 'ops', 'console-https.sh')
    const result = Bun.spawnSync(['bash', installed, 'renew'], {
      env: {
        HOME: f.home,
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        QIANMO_CONSOLE_HTTPS_NO_SYSTEMCTL: '1',
      },
    })
    expect(result.exitCode).toBe(0)
    const argv = readFileSync(join(f.out, 'argv.txt'), 'utf8').split('\n')
    expect(argv).toContain(join(f.root, 'tls', 'lego'))
    expect(argv).toContain('--deploy-hook')
    expect(argv).toContain(`${installed} deployed`)
    expect(argv).not.toContain('--server')
    expect(argv.join('\n')).not.toContain(TOKEN)
  })
})
