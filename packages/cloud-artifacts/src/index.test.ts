// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import worker from './index.js'

function fixture() {
  const objects = new Map<string, ArrayBuffer>()
  const writes: string[] = []
  const env: Env = {
    TOKEN: 'test-upload-token',
    MAX_BYTES: '10',
    DEFAULT_TTL_DAYS: '7',
    PUBLIC_URL: 'https://artifacts.example',
    BUCKET: {
      head: async () => null,
      get: async key => {
        const body = objects.get(key)
        return body === undefined
          ? null
          : ({
              body: new Response(body).body,
              writeHttpMetadata() {},
            } as unknown as R2ObjectBody)
      },
      put: async (key, value) => {
        writes.push(key)
        objects.set(key, value as ArrayBuffer)
        return {} as R2Object
      },
      delete: async keys => {
        for (const key of typeof keys === 'string' ? [keys] : keys) {
          objects.delete(key)
        }
      },
    },
  }
  const upload = (body: BodyInit, query = '') =>
    worker.fetch(
      new Request(`https://artifacts.example/upload${query}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.TOKEN}`,
          'content-type': 'text/html',
        },
        body,
      }),
      env,
    )
  return { env, objects, writes, upload }
}

describe('artifact upload boundaries', () => {
  test('an oversized replacement keeps the previously published page', async () => {
    const { upload, objects } = fixture()
    await upload('old', '?hash=report')
    const response = await upload('too large a page', '?hash=report&ttl=30')
    expect(response.status).toBe(413)
    expect(new TextDecoder().decode(objects.get('7d/report.html'))).toBe('old')
  })

  test('a storage failure keeps the previously published page', async () => {
    const { upload, objects, env } = fixture()
    await upload('old', '?hash=report')
    env.BUCKET.put = async () => {
      throw new Error('storage unavailable')
    }
    await expect(upload('new', '?hash=report&ttl=30')).rejects.toThrow(
      'storage unavailable',
    )
    expect(new TextDecoder().decode(objects.get('7d/report.html'))).toBe('old')
  })

  test('a successful replacement moves TTL only after the new page is stored', async () => {
    const { upload, objects } = fixture()
    await upload('old', '?hash=report')
    expect((await upload('new', '?hash=report&ttl=30')).status).toBe(200)
    expect(objects.has('7d/report.html')).toBe(false)
    expect(new TextDecoder().decode(objects.get('30d/report.html'))).toBe('new')
    expect((await upload('updated', '?hash=report&ttl=30')).status).toBe(200)
    expect(new TextDecoder().decode(objects.get('30d/report.html'))).toBe(
      'updated',
    )
  })

  test('accepts the exact byte limit and preserves the public response', async () => {
    const { upload, objects } = fixture()
    const response = await upload('0123456789', '?hash=report&ttl=30')
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result.id).toBe('report')
    expect(result.url).toBe('https://artifacts.example/30d/report.html')
    expect(Number.isFinite(Date.parse(result.expiresAt))).toBe(true)
    expect(new TextDecoder().decode(objects.get('30d/report.html'))).toBe(
      '0123456789',
    )
  })

  test('rejects unauthenticated uploads before storing anything', async () => {
    const { env, writes } = fixture()
    const response = await worker.fetch(
      new Request('https://artifacts.example/upload', {
        method: 'POST',
        body: 'page',
      }),
      env,
    )
    expect(response.status).toBe(401)
    expect(writes).toEqual([])
  })

  test('stops and cancels a chunked upload as soon as its byte limit is crossed', async () => {
    const { upload, writes } = fixture()
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1
          if (pulls > 2) throw new Error('oversized body was still consumed')
          controller.enqueue(new Uint8Array(6))
        },
        cancel() {
          cancelled = true
        },
      },
      { highWaterMark: 0 },
    )
    const response = await upload(body)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'payload_too_large' })
    expect(pulls).toBe(2)
    expect(cancelled).toBe(true)
    expect(writes).toEqual([])
  })
})
