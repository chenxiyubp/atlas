// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `fleet-probe.sh` 的样本契约：活端点记 ok、死端点照样记一条 false（失败不剔除）、
 * 内存护栏只记 skipped 不探、唤醒经控制台带 admin token 且 token 不落进任何样本、
 * 轮转表的 `-` 格不唤醒、install 只渲染不留占位符。
 *
 * 节点、注册中心、控制台都用回环上的假服务代替（节点那个对普通 GET 回 426，与真
 * 常驻一致）；握手那一档要真 resident，这里只测「缺 PSK 文件」那一支。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
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

const SCRIPT = resolve(import.meta.dir, 'fleet-probe.sh')
const ADMIN = 'a'.repeat(48)
const dirs: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
let nodePort = 0
let deadPort = 0
let registryPort = 0
let consolePort = 0
let wakeAuth: string[] = []

beforeAll(async () => {
  const node = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('upgrade required', { status: 426 }),
  })
  const registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => Response.json({ status: 'ok' }),
  })
  const consoleServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => {
      const url = new URL(request.url)
      if (url.pathname === '/v0/health') return Response.json({ status: 'ok' })
      if (url.pathname === '/v0/wake' && request.method === 'POST') {
        wakeAuth.push(request.headers.get('authorization') ?? '')
        const body = (await request.json()) as { to: string; node: string }
        if (!body.to.startsWith(`qianmo://${body.node}/`)) {
          return new Response('bad', { status: 400 })
        }
        return Response.json({ msgId: 'm-1', taskId: 't-1', receipt: 'r' })
      }
      return new Response('nf', { status: 404 })
    },
  })
  servers.push(node, registry, consoleServer)
  nodePort = node.port as number
  registryPort = registry.port as number
  consolePort = consoleServer.port as number
  const gone = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response(''),
  })
  deadPort = gone.port as number
  await gone.stop(true)
})

afterAll(async () => {
  for (const server of servers) await server.stop(true)
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function fixture(options: { memAvailableKb?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fleet-probe-'))
  dirs.push(home)
  const root = join(home, 'qianmo-beta')
  mkdirSync(join(root, 'secrets', 'peers'), { recursive: true })
  mkdirSync(join(root, 'ops'), { recursive: true })
  writeFileSync(join(root, '.qianmo-beta-env'), 'qianmo-beta-env/v1\n')
  writeFileSync(
    join(root, 'peers.conf'),
    [
      `qianmo://beta-1/reviewer  ws://127.0.0.1:${nodePort}`,
      `qianmo://beta-2/reviewer  ws://127.0.0.1:${deadPort}`,
      '',
    ].join('\n'),
  )
  writeFileSync(join(root, 'secrets', 'console-admin-token'), `${ADMIN}\n`, {
    mode: 0o600,
  })
  const meminfo = join(home, 'meminfo')
  writeFileSync(
    meminfo,
    `MemTotal: 990000 kB\nMemAvailable: ${options.memAvailableKb ?? 500000} kB\n`,
  )
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    QIANMO_BETA_ROOT: root,
    QIANMO_BETA_REGISTRY_PORT: String(registryPort),
    QIANMO_BETA_CONSOLE_PORT: String(consolePort),
    BETA_MEMINFO_PATH: meminfo,
    XDG_CONFIG_HOME: join(home, '.config'),
    QIANMO_PROBE_NO_SYSTEMCTL: '1',
  }
  return { home, root, env }
}

/**
 * 必须是异步 spawn：假节点 / 注册中心 / 控制台跑在本测试进程里，`spawnSync` 会把
 * 事件循环卡住，子进程拨过来时没人应答。
 */
async function probe(env: Record<string, string>, ...args: string[]) {
  const child = Bun.spawn(['bash', SCRIPT, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

function samples(root: string, file: string): Record<string, unknown>[] {
  const path = join(root, 'state', 'fleet-probe', file)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('minute', () => {
  test('活端点 ok、死端点照记一条 false；注册中心与控制台各一条 health', async () => {
    const f = fixture()
    const result = await probe(f.env, 'minute')
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    const live = samples(f.root, 'avail-beta-1.ndjson')
    const dead = samples(f.root, 'avail-beta-2.ndjson')
    expect(live).toHaveLength(1)
    expect(live[0]?.ok).toBe(true)
    expect(live[0]?.probe).toBe('endpoint')
    expect(dead[0]?.ok).toBe(false)
    const health = samples(f.root, 'health.ndjson')
    expect(health.map(s => [s.node, s.ok])).toEqual([
      ['registry', true],
      ['console', true],
    ])
    const dir = join(f.root, 'state', 'fleet-probe')
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'avail-beta-1.ndjson')).mode & 0o777).toBe(0o600)
  })

  test('内存低于护栏：只记一条 skipped，不探任何东西', async () => {
    const f = fixture({ memAvailableKb: 100 * 1024 })
    expect((await probe(f.env, 'minute')).code).toBe(0)
    expect(samples(f.root, 'avail-beta-1.ndjson')).toEqual([])
    const health = samples(f.root, 'health.ndjson')
    expect(health).toHaveLength(1)
    expect(String(health[0]?.detail)).toContain('skipped:low-mem')
  })
})

describe('handshake', () => {
  test('缺该节点的 PSK 文件：记一条 false，不拿空 PSK 去拨', async () => {
    const f = fixture()
    expect((await probe(f.env, 'handshake')).code).toBe(0)
    const rows = samples(f.root, 'handshake-beta-1.ndjson')
    expect(rows[0]?.ok).toBe(false)
    expect(rows[0]?.detail).toBe('no-psk-file')
  })
})

describe('wake', () => {
  test('经控制台 POST /v0/wake，带 admin token；token 不落进样本', async () => {
    const f = fixture()
    wakeAuth = []
    const installed = await probe(
      f.env,
      'install',
      '--rotation',
      'beta-1',
      '--agent',
      'reviewer',
    )
    expect(installed.code).toBe(0)
    const result = await probe(f.env, 'wake')
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(wakeAuth).toEqual([`Bearer ${ADMIN}`])
    const rows = samples(f.root, 'wake-beta-1.ndjson')
    expect(rows[0]?.ok).toBe(true)
    expect(rows[0]?.detail).toBe('msgId=m-1')
    const all = readFileSync(
      join(f.root, 'state', 'fleet-probe', 'wake-beta-1.ndjson'),
      'utf8',
    )
    expect(all).not.toContain(ADMIN)
    expect(result.stdout + result.stderr).not.toContain(ADMIN)
  })

  test('轮转表的 - 格：这一轮不唤醒', async () => {
    const f = fixture()
    wakeAuth = []
    expect((await probe(f.env, 'install', '--rotation', '-')).code).toBe(0)
    expect((await probe(f.env, 'wake')).code).toBe(0)
    expect(wakeAuth).toEqual([])
  })
})

describe('install', () => {
  test('一个模板服务 + 三个 timer，不留占位符', async () => {
    const f = fixture()
    expect((await probe(f.env, 'install', '--rotation', 'beta-1 -')).code).toBe(
      0,
    )
    const unitDir = join(f.home, '.config', 'systemd', 'user')
    for (const unit of [
      'qianmo-probe@.service',
      'qianmo-probe-minute.timer',
      'qianmo-probe-handshake.timer',
      'qianmo-probe-wake.timer',
    ]) {
      const text = readFileSync(join(unitDir, unit), 'utf8')
      expect(text).not.toMatch(/@[A-Z_]+@/)
    }
    expect(
      readFileSync(join(f.root, 'ops', 'fleet-probe.env'), 'utf8'),
    ).toContain('PROBE_WAKE_ROTATION="beta-1 -"')
  })
})
