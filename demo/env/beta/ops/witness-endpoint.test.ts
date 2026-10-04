// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `witness-endpoint.sh`：install 生成两枚不同的 0600 token 且不回显、重跑不换 token、
 * 单元不留占位符；run 真的起一个端点（经 `demo_entry` 落到源文件入口），用写 token
 * 追加一个签名锚点、用读 token 读回来。systemctl 用环境变量关掉。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { generateNodeKeyPair } from '@qianmo/capability'
import { signWitnessAnchor } from '@qianmo/witness'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const SCRIPT = resolve(import.meta.dir, 'witness-endpoint.sh')
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function fixture(): {
  home: string
  root: string
  env: Record<string, string>
} {
  const home = mkdtempSync(join(tmpdir(), 'witness-sh-'))
  dirs.push(home)
  const root = join(home, 'qianmo-beta')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  return {
    home,
    root,
    env: {
      HOME: home,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      QIANMO_BETA_ROOT: root,
      XDG_CONFIG_HOME: join(home, '.config'),
      QIANMO_WITNESS_NO_SYSTEMCTL: '1',
    },
  }
}

function sh(env: Record<string, string>, args: readonly string[]) {
  const result = Bun.spawnSync(['bash', SCRIPT, ...args], { env })
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(''),
  })
  const port = probe.port as number
  await probe.stop(true)
  return port
}

describe('install', () => {
  test('两枚 token：0600、64 hex、互不相同、不回显；重跑不换', () => {
    const f = fixture()
    const first = sh(f.env, ['install', '--key', 'beta-1=AAAA'])
    expect(first.stderr).toBe('')
    expect(first.code).toBe(0)
    const write = join(f.root, 'secrets', 'witness-write-token')
    const read = join(f.root, 'secrets', 'witness-read-token')
    for (const file of [write, read]) {
      expect(statSync(file).mode & 0o777).toBe(0o600)
      expect(readFileSync(file, 'utf8')).toMatch(/^[0-9a-f]{64}$/)
    }
    const writeValue = readFileSync(write, 'utf8')
    const readValue = readFileSync(read, 'utf8')
    expect(writeValue).not.toBe(readValue)
    expect(first.stdout).not.toContain(writeValue)
    expect(first.stdout).not.toContain(readValue)

    const again = sh(f.env, [
      'install',
      '--key',
      'beta-1=AAAA',
      '--key',
      'beta-5=BBBB',
    ])
    expect(again.code).toBe(0)
    expect(readFileSync(write, 'utf8')).toBe(writeValue)
    expect(readFileSync(join(f.root, 'ops', 'witness.env'), 'utf8')).toContain(
      'WITNESS_KEYS="beta-1=AAAA beta-5=BBBB"\n',
    )
  })

  test('单元不留占位符，ExecStart 指向交付树里的本脚本', () => {
    const f = fixture()
    expect(sh(f.env, ['install', '--key', 'beta-1=AAAA']).code).toBe(0)
    const unit = readFileSync(
      join(f.home, '.config', 'systemd', 'user', 'qianmo-witness.service'),
      'utf8',
    )
    expect(unit).not.toMatch(/@[A-Z_]+@/)
    expect(unit).toContain('demo/env/beta/ops/witness-endpoint.sh run')
    expect(unit).toContain('Environment=QIANMO_BETA_ROOT=%h/qianmo-beta')
  })

  test.each([
    [['install']],
    [['install', '--key', 'beta-1']],
    [['install', '--key', 'beta-1=AAAA', '--port', 'x']],
  ])('参数不对就拒绝：%j', args => {
    const f = fixture()
    expect(sh(f.env, args).code).not.toBe(0)
  })
})

describe('install 在见证机上（那里没跑过 beta-up.sh）', () => {
  test('内测根还不存在：建目录（0700）与标记（0600），再照常装', () => {
    const f = fixture()
    const fresh = join(f.home, 'witness-only')
    const env = { ...f.env, QIANMO_BETA_ROOT: fresh }
    const result = sh(env, ['install', '--key', 'beta-1=AAAA'])
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(statSync(fresh).mode & 0o777).toBe(0o700)
    const marker = join(fresh, '.qianmo-beta-env')
    expect(statSync(marker).mode & 0o777).toBe(0o600)
    expect(readFileSync(marker, 'utf8').split('\n')[0]).toBe(
      'qianmo-beta-env/v1',
    )
  })

  test('目录在、标记不在：拒绝收编', () => {
    const f = fixture()
    const stray = join(f.home, 'stray')
    mkdirSync(stray)
    const result = sh({ ...f.env, QIANMO_BETA_ROOT: stray }, [
      'install',
      '--key',
      'beta-1=AAAA',
    ])
    expect(result.code).not.toBe(0)
    expect(existsSync(join(stray, 'secrets'))).toBe(false)
  })
})

describe('start / status / stop（见证机没有 linger）', () => {
  test('nohup 起、pid 文件、不带 token 回 401；oom_score_adj 写 1000；stop 之后不在了', async () => {
    const f = fixture()
    const port = await freePort()
    const oom = join(f.home, 'oom_score_adj')
    writeFileSync(oom, '0\n')
    const env = { ...f.env, QIANMO_WITNESS_OOM_ADJ_PATH: oom }
    expect(
      sh(env, ['install', '--key', 'beta-1=AAAA', '--port', String(port)]).code,
    ).toBe(0)
    const started = sh(env, ['start'])
    try {
      expect(started.code).toBe(0)
      expect(started.stdout).toContain('401')
      const pidFile = join(f.root, 'run', 'witness.pid')
      expect(statSync(pidFile).mode & 0o777).toBe(0o600)
      expect(readFileSync(oom, 'utf8').trim()).toBe('1000')
      const again = sh(env, ['start'])
      expect(again.code).toBe(0)
      expect(again.stdout).toContain('已在跑')
      const status = sh(env, ['status'])
      expect(status.code).toBe(0)
      expect(status.stdout).toContain('401')
    } finally {
      const stopped = sh(env, ['stop'])
      expect(stopped.code).toBe(0)
    }
    expect(existsSync(join(f.root, 'run', 'witness.pid'))).toBe(false)
    expect(sh(env, ['status']).code).not.toBe(0)
    const gone = await fetch(`http://127.0.0.1:${port}/v0/anchor`).then(
      r => r.status,
      () => 0,
    )
    expect(gone).toBe(0)
  })
})

describe('link-install（H 上，见证在另一台机器）', () => {
  const hasKeygen = Bun.which('ssh-keygen') !== null

  function keyed(f: ReturnType<typeof fixture>, knownHost?: string) {
    const key = join(f.home, 'link-key')
    Bun.spawnSync([
      'ssh-keygen',
      '-q',
      '-t',
      'ed25519',
      '-N',
      '',
      '-C',
      'link@h',
      '-f',
      key,
    ])
    mkdirSync(join(f.home, '.ssh'), { recursive: true })
    if (knownHost !== undefined) {
      const hostKey = readFileSync(`${key}.pub`, 'utf8').split(' ').slice(0, 2)
      writeFileSync(
        join(f.home, '.ssh', 'known_hosts'),
        `${knownHost} ${hostKey.join(' ')}\n`,
      )
    }
    return key
  }

  test.skipIf(!hasKeygen)(
    'env 0600、单元不留占位符且变量带花括号、打印只放行一个口的 authorized_keys 行',
    () => {
      const f = fixture()
      const key = keyed(f, 'witness.example')
      const result = sh(f.env, [
        'link-install',
        '--user',
        'u',
        '--host',
        'witness.example',
        '--key',
        key,
      ])
      expect(result.stderr).toBe('')
      expect(result.code).toBe(0)
      const conf = join(f.root, 'ops', 'witness-link.env')
      expect(statSync(conf).mode & 0o777).toBe(0o600)
      expect(readFileSync(conf, 'utf8')).toContain('WITNESS_LOCAL_PORT=38640\n')
      const unit = readFileSync(
        join(
          f.home,
          '.config',
          'systemd',
          'user',
          'qianmo-witness-link.service',
        ),
        'utf8',
      )
      expect(unit).not.toMatch(/@[A-Z_]+@/)
      const exec = unit.split('\n').find(l => l.startsWith('ExecStart=')) ?? ''
      expect(exec).toContain('StrictHostKeyChecking=yes')
      expect(exec).toContain(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: systemd 的变量引用，不是 JS 模板占位
        '-L 127.0.0.1:${WITNESS_LOCAL_PORT}:127.0.0.1:${WITNESS_REMOTE_PORT}',
      )
      expect(exec).not.toMatch(/\$[A-Z]/)
      const line = result.stdout
        .split('\n')
        .find(l => l.startsWith('restrict,'))
      expect(line).toContain('permitopen="127.0.0.1:38640"')
      expect(line).toContain('permitlisten="127.0.0.1:1"')
      expect(line).toContain('command="/bin/false"')
      expect(line).toContain(readFileSync(`${key}.pub`, 'utf8').trim())
    },
  )

  test.skipIf(!hasKeygen)(
    'known_hosts 里没有见证机：拒绝（不做首次信任）',
    () => {
      const f = fixture()
      const key = keyed(f)
      const result = sh(f.env, [
        'link-install',
        '--user',
        'u',
        '--host',
        'witness.example',
        '--key',
        key,
      ])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('known_hosts')
    },
  )

  test.skipIf(!hasKeygen)('私钥权限过宽：拒绝', () => {
    const f = fixture()
    const key = keyed(f, 'witness.example')
    Bun.spawnSync(['chmod', '644', key])
    const result = sh(f.env, [
      'link-install',
      '--user',
      'u',
      '--host',
      'witness.example',
      '--key',
      key,
    ])
    expect(result.code).not.toBe(0)
  })
})

describe('run', () => {
  test('真起一个端点（两把公钥）：写 token 追加签名锚点，读 token 读回', async () => {
    const f = fixture()
    const keys = generateNodeKeyPair()
    const other = generateNodeKeyPair()
    const port = await freePort()
    expect(
      sh(f.env, [
        'install',
        '--key',
        `beta-1=${keys.publicKey}`,
        '--key',
        `beta-5=${other.publicKey}`,
        '--port',
        String(port),
      ]).code,
    ).toBe(0)
    const child = Bun.spawn(['bash', SCRIPT, 'run'], {
      env: f.env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    try {
      const ready = join(f.root, 'run', 'witness-ready.json')
      for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(50)
      expect(existsSync(ready)).toBe(true)
      const base = `http://127.0.0.1:${port}`
      const writeToken = readFileSync(
        join(f.root, 'secrets', 'witness-write-token'),
        'utf8',
      )
      const readToken = readFileSync(
        join(f.root, 'secrets', 'witness-read-token'),
        'utf8',
      )
      const anchor = signWitnessAnchor(
        { v: 1, node: 'beta-1', seq: 1, head: 'd'.repeat(64), count: 1, at: 1 },
        keys,
      )
      const created = await fetch(`${base}/v0/anchor`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${writeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(anchor),
      })
      expect(created.status).toBe(201)
      const listed = await fetch(`${base}/v0/anchor?node=beta-1`, {
        headers: { authorization: `Bearer ${readToken}` },
      })
      expect(listed.status).toBe(200)
      expect(JSON.stringify(await listed.json())).toContain('d'.repeat(64))
      expect(statSync(join(f.root, 'witness', 'store')).mode & 0o777).toBe(
        0o700,
      )
    } finally {
      child.kill()
      await child.exited
    }
  })
})
