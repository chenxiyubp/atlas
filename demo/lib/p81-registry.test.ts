// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `p81-registry.ts` 的 `--public-key <节点>=<公钥>`：真进程、真端口、真 HTTP v0。
 *
 * 本体一被 import 就解析 argv、起服务、写 ready 文件，所以这里不 import 它，而是像 beta-up
 * 那样把它当子进程起，再从名册（`GET /v0/agents`）读回来。登记逻辑本身由
 * `p81-announce-core.test.ts` 用真 `InMemoryRegistry` 钉着；这里钉的是命令行那一层：
 * 公钥按节点给、挂到该节点每一条登记上、升级前留在落盘表里的无公钥条目被补上、写错当场退出。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..')
const ENTRY = join(REPOSITORY_ROOT, 'demo/lib/p81-registry.ts')
const KEY_1 = 'Inyg1lW5K3Tsc1VrzZ5-ifdAyfXrFzzBirnDnVsVsvQ'

const dirs: string[] = []
const children: ReturnType<typeof Bun.spawn>[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await child.exited
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { force: true, recursive: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-p81-registry-'))
  dirs.push(dir)
  return dir
}

interface Running {
  readonly child: ReturnType<typeof Bun.spawn>
  readonly url: string
}

async function start(dir: string, args: readonly string[]): Promise<Running> {
  const ready = join(dir, 'ready.json')
  rmSync(ready, { force: true })
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      ENTRY,
      '--ready',
      ready,
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      ...args,
    ],
    { cwd: REPOSITORY_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  children.push(child)
  for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt++) {
    await Bun.sleep(25)
  }
  const { url } = JSON.parse(readFileSync(ready, 'utf8')) as { url: string }
  return { child, url }
}

async function stop(running: Running): Promise<string> {
  running.child.kill('SIGTERM')
  await running.child.exited
  return await new Response(running.child.stderr as ReadableStream).text()
}

async function roster(url: string): Promise<Map<string, string | undefined>> {
  const response = await fetch(`${url}/v0/agents`)
  const body = (await response.json()) as {
    agents: { address: string; publicKey?: string }[]
  }
  return new Map(body.agents.map(agent => [agent.address, agent.publicKey]))
}

const REGISTER = [
  '--register',
  'qianmo://beta-1/planner=ws://127.0.0.1:38631',
  '--register',
  'qianmo://beta-1/reviewer=ws://127.0.0.1:38631',
  '--register',
  'qianmo://beta-4/planner=ws://127.0.0.1:38625',
]

describe('p81-registry --public-key', () => {
  test('按节点给一次，挂到该节点的每一条登记上；没给的节点照旧不带', async () => {
    const running = await start(scratch(), [
      ...REGISTER,
      '--public-key',
      `beta-1=${KEY_1}`,
    ])
    const listed = await roster(running.url)
    expect(listed.get('qianmo://beta-1/planner')).toBe(KEY_1)
    expect(listed.get('qianmo://beta-1/reviewer')).toBe(KEY_1)
    expect(listed.has('qianmo://beta-4/planner')).toBe(true)
    expect(listed.get('qianmo://beta-4/planner')).toBeUndefined()
  }, 15_000)

  test('升级：落盘表里还活着的无公钥条目，重起时被补上公钥，并且出声', async () => {
    const dir = scratch()
    const state = join(dir, 'registry-agents.json')
    // 先按旧形态（不带公钥）跑一轮，留下落盘表——现场升级前的样子。
    const before = await start(dir, [...REGISTER, '--state', state])
    expect((await roster(before.url)).get('qianmo://beta-1/planner')).toBe(
      undefined,
    )
    await stop(before)

    // 90 s 租约之内重起：表从落盘恢复，条目还活着。旧逻辑在这里只做心跳，公钥永远进不来。
    const after = await start(dir, [
      ...REGISTER,
      '--state',
      state,
      '--public-key',
      `beta-1=${KEY_1}`,
    ])
    const listed = await roster(after.url)
    expect(listed.get('qianmo://beta-1/planner')).toBe(KEY_1)
    expect(listed.get('qianmo://beta-1/reviewer')).toBe(KEY_1)
    expect(await stop(after)).toContain(
      `registry 公钥已更新：qianmo://beta-1/planner （无） → ${KEY_1}`,
    )
  }, 15_000)

  test.each([
    ['节点名笔误（没有任何 --register 属于它）', `beta-9=${KEY_1}`, 'beta-9'],
    ['形状不对', 'beta-1=not-a-key', 'not-a-key'],
  ])(
    '写错当场退出：%s',
    async (_label, value, mentioned) => {
      const dir = scratch()
      const child = Bun.spawn(
        [
          process.execPath,
          'run',
          ENTRY,
          '--ready',
          join(dir, 'ready.json'),
          '--port',
          '0',
          ...REGISTER,
          '--public-key',
          value,
        ],
        { cwd: REPOSITORY_ROOT, stdout: 'pipe', stderr: 'pipe' },
      )
      children.push(child)
      const exited = await Promise.race([
        child.exited,
        Bun.sleep(4_000).then(() => 'still running' as const),
      ])
      expect(exited).not.toBe('still running')
      expect(exited).not.toBe(0)
      const stderr = await new Response(child.stderr as ReadableStream).text()
      expect(stderr).toContain(mentioned)
      // 起不来就不该写 ready：beta-up 等的正是这个文件。
      expect(existsSync(join(dir, 'ready.json'))).toBe(false)
    },
    15_000,
  )
})

/** 起不来的那一种：等它自己退出，拿回退出码与 stderr；ready 文件必须不存在。 */
async function refusedToStart(
  dir: string,
  args: readonly string[],
): Promise<{
  readonly code: number | 'still running'
  readonly stderr: string
}> {
  const child = Bun.spawn(
    [
      process.execPath,
      'run',
      ENTRY,
      '--ready',
      join(dir, 'ready.json'),
      '--port',
      '0',
      ...REGISTER,
      ...args,
    ],
    { cwd: REPOSITORY_ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  children.push(child)
  const code = await Promise.race([
    child.exited,
    Bun.sleep(4_000).then(() => 'still running' as const),
  ])
  const stderr =
    code === 'still running'
      ? ''
      : await new Response(child.stderr as ReadableStream).text()
  expect(existsSync(join(dir, 'ready.json'))).toBe(false)
  return { code, stderr }
}

const TOKEN = 'p81-registry-write-token-not-a-secret'

function tokenFile(dir: string, mode: number): string {
  const path = join(dir, 'registry-write-token')
  writeFileSync(path, `${TOKEN}\n`)
  chmodSync(path, mode)
  return path
}

async function write(
  url: string,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<number> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return response.status
}

describe('p81-registry --write-token-file（P15.8）', () => {
  test('写不带 token 一律 401、名册不变；带 token 放行；--register 那批照常续租', async () => {
    const dir = scratch()
    const running = await start(dir, [
      ...REGISTER,
      '--write-token-file',
      tokenFile(dir, 0o600),
    ])
    const before = await roster(running.url)
    expect([...before.keys()].sort()).toEqual([
      'qianmo://beta-1/planner',
      'qianmo://beta-1/reviewer',
      'qianmo://beta-4/planner',
    ])
    const intruder = {
      address: 'qianmo://beta-9/intruder',
      endpoint: 'ws://203.0.113.9:1',
    }
    const planner = `/v0/agents/${encodeURIComponent('qianmo://beta-1/planner')}`

    expect(await write(running.url, 'POST', '/v0/agents', intruder)).toBe(401)
    expect(await write(running.url, 'DELETE', planner)).toBe(401)
    expect(await write(running.url, 'POST', `${planner}/heartbeat`)).toBe(401)
    expect(
      await write(running.url, 'PUT', '/v0/revocation-list', {
        payload: 'eA',
        signature: 'eA',
      }),
    ).toBe(401)
    expect(await roster(running.url)).toEqual(before)
    expect((await fetch(`${running.url}/v0/revocation-list`)).status).toBe(404)

    expect(
      await write(running.url, 'POST', '/v0/agents', intruder, TOKEN),
    ).toBe(201)
    expect((await roster(running.url)).has(intruder.address)).toBe(true)
    const ready = JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8'))
    expect(ready.writeAuth).toBe(true)
    // token 本身不进 ready 文件、不进 stdout。
    expect(readFileSync(join(dir, 'ready.json'), 'utf8')).not.toContain(TOKEN)
    await stop(running)
    const out = await new Response(
      running.child.stdout as ReadableStream,
    ).text()
    expect(out).toContain('写操作要 token')
    expect(out).not.toContain(TOKEN)
  }, 15_000)

  test.each([
    0o644, 0o640,
  ])('token 文件权限 %o：拒绝启动，不写 ready', async mode => {
    if (process.platform === 'win32') return
    const dir = scratch()
    const refused = await refusedToStart(dir, [
      '--write-token-file',
      tokenFile(dir, mode),
    ])
    expect(refused.code).not.toBe('still running')
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('readable beyond its owner')
    expect(refused.stderr).not.toContain(TOKEN)
  }, 15_000)

  test('不给这个参数：写照旧零鉴权（与加它之前一致）', async () => {
    const running = await start(scratch(), REGISTER)
    expect(
      await write(running.url, 'POST', '/v0/agents', {
        address: 'qianmo://beta-9/open',
        endpoint: 'ws://203.0.113.9:1',
      }),
    ).toBe(201)
  }, 15_000)
})

describe('p81-registry --state 也落吊销清单', () => {
  test('发布过的吊销清单在重启后照样对外发布', async () => {
    const dir = scratch()
    const state = join(dir, 'registry-agents.json')
    const list = { payload: 'cGF5bG9hZA', signature: 'c2ln' }
    const first = await start(dir, [...REGISTER, '--state', state])
    expect(await write(first.url, 'PUT', '/v0/revocation-list', list)).toBe(200)
    await stop(first)
    expect(existsSync(join(dir, 'registry-revocation-list.json'))).toBe(true)

    const second = await start(dir, [...REGISTER, '--state', state])
    const served = await fetch(`${second.url}/v0/revocation-list`)
    expect(served.status).toBe(200)
    expect(await served.json()).toEqual(list)
  }, 15_000)

  test('落盘的吊销清单读不出来：拒绝启动并说明补法，文件原样留着', async () => {
    const dir = scratch()
    const state = join(dir, 'registry-agents.json')
    const stored = join(dir, 'registry-revocation-list.json')
    writeFileSync(stored, '{"payload":"cGF5bG9h')
    const refused = await refusedToStart(dir, ['--state', state])
    expect(refused.code).not.toBe('still running')
    expect(refused.code).not.toBe(0)
    expect(refused.stderr).toContain('不会以空清单启动')
    expect(refused.stderr).toContain(stored)
    expect(readFileSync(stored, 'utf8')).toBe('{"payload":"cGF5bG9h')
  }, 15_000)
})
