// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scriptPath = join(import.meta.dir, '..', 'check-bundle-smoke.ts')
let root: string | null = null

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = null
})

/** 一份假 dist：两个被冒烟的入口用同一段脚本。 */
async function createDist(entrySource: string): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'qianmo-bundle-smoke-test-'))
  await mkdir(root, { recursive: true })
  for (const entry of ['cli-node.js', 'cli-qianmo.js']) {
    await writeFile(join(root, entry), entrySource)
  }
  return root
}

function runSmoke(distDir: string, env: Record<string, string> = {}) {
  return spawnSync('bun', [scriptPath, distDir], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 120_000,
  })
}

// 真 CLI 走完初始化后做的事，缩成一次请求：拿环境里的 key 打假 provider。
const REACHES_PROVIDER = `
const response = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', {
  method: 'POST',
  headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'content-type': 'application/json' },
  body: '{}',
})
console.log('API Error: ' + (await response.text()))
process.exit(1)
`

describe('check-bundle-smoke', () => {
  test('passes an entry that initialises and reaches the provider', async () => {
    const result = runSmoke(await createDist(REACHES_PROVIDER))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('✅ cli-node.js')
    expect(result.stdout).toContain('✅ cli-qianmo.js')
    expect(result.stdout).toContain('/v1/messages ×1')
  })

  // v2.46.1 的真实形态：chunk 求值时调用了一个谁都没定义的包装函数。
  test('fails an entry that dies during module initialisation', async () => {
    const result = runSmoke(
      await createDist('init_external()\nexport const unreachable = 1\n'),
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('❌ cli-node.js')
    expect(result.stdout).toContain('ReferenceError')
    expect(result.stdout).toContain('假 provider 没有收到 POST /v1/messages')
  })

  // 换一种死法（不带 ReferenceError 签名、干净退出）同样要红：判据是「到了网络层」。
  test('fails an entry that exits without reaching the provider', async () => {
    const result = runSmoke(await createDist('process.exit(0)\n'))

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('假 provider 没有收到 POST /v1/messages')
  })

  test('fails an entry that tries to reach the network', async () => {
    const result = runSmoke(
      await createDist(
        `await fetch('http://bundle-smoke-outbound.invalid/').catch(() => {})\n${REACHES_PROVIDER}`,
      ),
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('代理陷阱收到')
    expect(result.stdout).toContain('bundle-smoke-outbound.invalid')
  })

  // 父进程里的凭据和 HOME 一个都不能漏进被冒烟的进程。
  test('runs the entry with an allowlisted environment and a throwaway HOME', async () => {
    const parentHome = process.env.HOME ?? ''
    const distDir = await createDist(`
if (process.env.OPENAI_API_KEY || process.env.SMOKE_PARENT_SECRET) {
  console.log('leaked parent credential')
  process.exit(0)
}
if (process.env.HOME === ${JSON.stringify(parentHome)}) {
  console.log('inherited the real HOME')
  process.exit(0)
}
${REACHES_PROVIDER}`)

    const result = runSmoke(distDir, {
      OPENAI_API_KEY: 'sk-parent-openai-key',
      SMOKE_PARENT_SECRET: 'parent-secret',
    })

    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('leaked parent credential')
    expect(result.stdout).not.toContain('inherited the real HOME')
  })

  test('fails when the provider sees a credential the smoke did not issue', async () => {
    const result = runSmoke(
      await createDist(
        REACHES_PROVIDER.replace(
          'process.env.ANTHROPIC_API_KEY',
          "'sk-ant-read-from-somewhere-else'",
        ),
      ),
    )

    expect(result.status).toBe(1)
    expect(result.stdout).toContain('不是本脚本发出的凭据')
  })

  test('fails when an entry is missing from dist', async () => {
    root = await mkdtemp(join(tmpdir(), 'qianmo-bundle-smoke-test-'))

    const result = runSmoke(root)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('找不到入口')
  })
})
