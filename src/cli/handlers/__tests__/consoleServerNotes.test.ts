// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 服务器备注的落盘面。
 *
 * **零 `mock.module`**：这里写的是真的文件，读的是真的文件。假的 fs 测不出这套
 * 用例真正在意的两件事——落盘的权限位，以及一行坏字节之后 store 还起不起得来。
 * 仓库对内联 `mock.module` 是零容忍棘轮，而这里也确实不需要。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ServerNotesStore } from '../consoleServerNotes.js'
import { createServerNotesPort } from '../consolePorts.js'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qianmo-server-notes-'))
  roots.push(dir)
  return dir
}

/** A path two levels below a directory that does not exist yet. */
function freshPath(): string {
  return join(tempDir(), 'qianmo', 'console', 'server-notes.ndjson')
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('ServerNotesStore', () => {
  test('replays what it wrote, across a restart', () => {
    const path = freshPath()
    const writer = new ServerNotesStore(path)
    writer.append({ server: 'p11', note: '香港 · 只跑演示', updatedAt: 10 })

    // A second instance is the restart: nothing is shared but the file.
    expect(new ServerNotesStore(path).load()).toEqual([
      { server: 'p11', note: '香港 · 只跑演示', updatedAt: 10 },
    ])
  })

  test('keeps the last write for a server and the first-seen order', () => {
    const path = freshPath()
    const store = new ServerNotesStore(path)
    store.append({ server: 'p11', note: '一', updatedAt: 1 })
    store.append({ server: 'p2', note: '二', updatedAt: 2 })
    store.append({ server: 'p11', note: '三', updatedAt: 3 })

    // Append-only: all three lines are still on disk, and the reader is what
    // collapses them. That is the property that makes a partial write cost one
    // line rather than the file.
    expect(readFileSync(path, 'utf8').trimEnd().split('\n')).toHaveLength(3)
    expect(new ServerNotesStore(path).load()).toEqual([
      { server: 'p11', note: '三', updatedAt: 3 },
      { server: 'p2', note: '二', updatedAt: 2 },
    ])
  })

  test('replays an empty note, because that is how one is cleared', () => {
    // 丢掉空串等于重启后把操作者删掉的那段文字复活。
    const path = freshPath()
    const store = new ServerNotesStore(path)
    store.append({ server: 'p11', note: '写了点什么', updatedAt: 1 })
    store.append({ server: 'p11', note: '', updatedAt: 2 })
    expect(new ServerNotesStore(path).load()).toEqual([
      { server: 'p11', note: '', updatedAt: 2 },
    ])
  })

  test('writes 0600, and its directory 0700', () => {
    const path = freshPath()
    new ServerNotesStore(path).append({
      server: 'p11',
      note: 'x',
      updatedAt: 1,
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
  })

  test('is empty when the file is not there yet', () => {
    // 从没被备注过的控制台是普通的首次运行状态，不是错误。
    expect(new ServerNotesStore(freshPath()).load()).toEqual([])
  })

  test('survives a half line, a non-JSON line and a foreign record', () => {
    const path = freshPath()
    const store = new ServerNotesStore(path)
    store.append({ server: 'p11', note: '第一条', updatedAt: 1 })
    writeFileSync(
      path,
      readFileSync(path, 'utf8') +
        '{"kind":"note","note":{"server":"p2"\n' + // 断电断在一半
        'not json at all\n' +
        '{"kind":"turn","turn":{}}\n' + // 别的记录种类
        '{"kind":"note","note":{"server":"p3","note":42,"updatedAt":1}}\n' + // 类型不对
        '{"kind":"note","note":{"server":"p9","note":"末尾这条","updatedAt":9}}\n',
      { mode: 0o600 },
    )
    // 一行坏字节该损失那一条，而不是让整个控制台打不开备注面。
    expect(new ServerNotesStore(path).load()).toEqual([
      { server: 'p11', note: '第一条', updatedAt: 1 },
      { server: 'p9', note: '末尾这条', updatedAt: 9 },
    ])
  })
})

describe('createServerNotesPort', () => {
  test('lists what the file already held when the console started', async () => {
    const path = freshPath()
    new ServerNotesStore(path).append({
      server: 'p11',
      note: '重启前写的',
      updatedAt: 7,
    })
    const port = createServerNotesPort({ store: new ServerNotesStore(path) })
    expect(await port.list()).toEqual({
      ok: true,
      value: [{ server: 'p11', note: '重启前写的', updatedAt: 7 }],
    })
  })

  test('stamps a write and makes it visible to the next list', async () => {
    const path = freshPath()
    const port = createServerNotesPort({
      store: new ServerNotesStore(path),
      now: () => 4242,
    })
    const written = await port.set('p11', '新写的')
    expect(written).toEqual({
      ok: true,
      value: { server: 'p11', note: '新写的', updatedAt: 4242 },
    })
    expect(await port.list()).toEqual({
      ok: true,
      value: [{ server: 'p11', note: '新写的', updatedAt: 4242 }],
    })
    // 同一进程内的内存副本不算数：真正的判据是磁盘上那一行。
    expect(new ServerNotesStore(path).load()).toEqual([
      { server: 'p11', note: '新写的', updatedAt: 4242 },
    ])
  })

  test('reports a write it could not do, and does not pretend it worked', async () => {
    // 目录位置上放一个文件，mkdir 就会 ENOTDIR。这是「盘满 / 目录不可写」那一类
    // 故障的可复现替身。
    const dir = tempDir()
    const blocker = join(dir, 'blocked')
    writeFileSync(blocker, 'not a directory\n')
    const port = createServerNotesPort({
      store: new ServerNotesStore(join(blocker, 'server-notes.ndjson')),
    })
    const result = await port.set('p11', '写不进去')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    // 503 那一档：请求本身没问题，是这台机器写不进去（`http.ts` 的 statusFor）。
    expect(result.failure.code).toBe('unreachable')
    // 内存副本必须还是空的，否则页面会显示一条重启后就消失的备注。
    expect(await port.list()).toEqual({ ok: true, value: [] })
  })
})
