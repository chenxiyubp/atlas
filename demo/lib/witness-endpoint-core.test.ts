// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 见证端点启动器的参数面与「只从 0600 文件读 token」那条规矩；外加一次真端口上的
 * 写入 / 读回，证明拼起来的东西就是 `@qianmo/witness` 那个端点，没有少一层鉴权。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { generateNodeKeyPair } from '@qianmo/capability'
import { signWitnessAnchor } from '@qianmo/witness'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WITNESS_PORT,
  parseWitnessEndpointArgs,
  readSecretFile,
  startWitnessEndpoint,
} from './witness-endpoint-core.js'

const WRITE = 'w'.repeat(32)
const READ = 'r'.repeat(32)
const dirs: string[] = []

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'witness-endpoint-'))
  dirs.push(dir)
  return dir
}

function secret(
  dir: string,
  name: string,
  value: string,
  mode = 0o600,
): string {
  const path = join(dir, name)
  writeFileSync(path, `${value}\n`)
  chmodSync(path, mode)
  return path
}

const BASE = [
  '--store',
  '/srv/w/store',
  '--write-token-file',
  '/srv/w/write',
  '--read-token-file',
  '/srv/w/read',
  '--key',
  'beta-1=AAAA',
]

describe('parseWitnessEndpointArgs', () => {
  test('缺省听 127.0.0.1:38640', () => {
    const config = parseWitnessEndpointArgs(BASE)
    expect(config.host).toBe('127.0.0.1')
    expect(config.port).toBe(DEFAULT_WITNESS_PORT)
    expect(config.keys).toEqual([['beta-1', 'AAAA']])
  })

  test('--key 可重复', () => {
    const config = parseWitnessEndpointArgs([...BASE, '--key', 'beta-5=BBBB'])
    expect(config.keys.map(([node]) => node)).toEqual(['beta-1', 'beta-5'])
  })

  test.each([
    ['非回环地址', ['--host', '0.0.0.0']],
    ['相对路径的 store', ['--store', 'store']],
    ['坏端口', ['--port', '99999']],
    ['坏 --key', ['--key', 'Beta 1=AAAA']],
    ['空公钥', ['--key', 'beta-2=']],
    ['未知参数', ['--verbose']],
  ])('拒绝%s', (_label, extra) => {
    expect(() => parseWitnessEndpointArgs([...BASE, ...extra])).toThrow()
  })

  test('一条 --key 都没有就拒绝：没有公钥的端点一个锚点都收不下', () => {
    expect(() => parseWitnessEndpointArgs(BASE.slice(0, 6))).toThrow(/--key/)
  })
})

describe('readSecretFile', () => {
  test('0600 的文件读出去掉首尾空白的值', () => {
    const dir = tempDir()
    expect(readSecretFile(secret(dir, 't', WRITE), 'x')).toBe(WRITE)
  })

  test('权限过宽就拒绝，且错误里不带文件内容', () => {
    const dir = tempDir()
    const path = secret(dir, 't', WRITE, 0o644)
    expect(() => readSecretFile(path, 'x')).toThrow(/要 600/)
    try {
      readSecretFile(path, 'x')
    } catch (error) {
      expect(String(error)).not.toContain(WRITE)
    }
  })

  test('空文件与不存在的文件都拒绝', () => {
    const dir = tempDir()
    expect(() => readSecretFile(secret(dir, 'e', ''), 'x')).toThrow(/空的/)
    expect(() => readSecretFile(join(dir, 'missing'), 'x')).toThrow(/读不到/)
  })
})

describe('startWitnessEndpoint：真端口上写一次、读回来', () => {
  test('写 token 能追加，读 token 能读回，读 token 不能写', async () => {
    const dir = tempDir()
    const keys = generateNodeKeyPair()
    const service = startWitnessEndpoint({
      store: join(dir, 'store'),
      host: '127.0.0.1',
      port: 0,
      writeTokenFile: secret(dir, 'write', WRITE),
      readTokenFile: secret(dir, 'read', READ),
      keys: [['beta-1', keys.publicKey]],
    })
    try {
      const anchor = signWitnessAnchor(
        { v: 1, node: 'beta-1', seq: 1, head: 'a'.repeat(64), count: 1, at: 1 },
        keys,
      )
      const post = (token: string) =>
        fetch(`${service.url}/v0/anchor`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(anchor),
        })
      expect((await post(READ)).status).toBe(403)
      expect((await post(WRITE)).status).toBe(201)
      const list = await fetch(`${service.url}/v0/anchor?node=beta-1`, {
        headers: { authorization: `Bearer ${READ}` },
      })
      expect(list.status).toBe(200)
      expect(JSON.stringify(await list.json())).toContain('a'.repeat(64))
      const anonymous = await fetch(`${service.url}/v0/anchor?node=beta-1`)
      expect(anonymous.status).toBe(401)
    } finally {
      await service.stop()
    }
  })
})
