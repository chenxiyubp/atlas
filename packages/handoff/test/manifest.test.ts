// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { LIMITS } from '@qianmo/protocol'
import {
  FIELD_MAX_BYTES,
  type HandoffManifest,
  HandoffValidationError,
  MANIFEST_MAX_BYTES,
  RESULT_MAX_BYTES,
  decodeResultContent,
  encodeResultContent,
  isIsoInstant,
  isValidBranchName,
  parseManifest,
  parseQianmoRef,
  sessionRef,
  taskBranch,
  taskRef,
  validateManifest,
  validateResult,
  wipRef,
} from '../src/manifest.js'

const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = 'c'.repeat(40)
const SESSION = '0199a3b2-7c1d-7e2f-9a3b-4c5d6e7f8a9b'

function manifest(overrides: Record<string, unknown> = {}): HandoffManifest {
  return {
    kind: 'handoff',
    project: 'atlas',
    device: 'cornna-mbp',
    branch: 'feat/p17-handoff-core',
    wip: SHA_A,
    tree: SHA_B,
    tool: 'qmcode',
    sessionId: SESSION,
    sessionRef: `refs/qianmo/sessions/cornna-mbp/${SESSION}`,
    sessionCommit: SHA_C,
    cwd: '/Users/cornna/project/atlas',
    brief: { goal: '把接力核心包写完', done: '清单校验', remaining: '台账' },
    deadline: '2026-11-20T02:00:00Z',
    ...overrides,
  } as HandoffManifest
}

function errorsOf(value: unknown): readonly string[] {
  const result = validateManifest(value)
  return result.ok ? [] : result.errors
}

describe('validateManifest', () => {
  test('accepts the plan example and returns a fresh copy', () => {
    const input = manifest()
    const result = validateManifest(input)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual(input)
    expect(result.value).not.toBe(input)
    expect(result.value.brief).not.toBe(input.brief)
  })

  test('accepts claude-code, Windows cwd, fractional seconds, SHA-256', () => {
    const sha256 = (c: string) => c.repeat(64)
    expect(
      errorsOf(
        manifest({
          tool: 'claude-code',
          cwd: 'C:\\Users\\ymy_l\\atlas',
          deadline: '2026-11-20T02:00:00.123Z',
          wip: sha256('a'),
          tree: sha256('b'),
          sessionCommit: sha256('c'),
        }),
      ),
    ).toEqual([])
  })

  test('rejects an extra top-level field and an extra brief field', () => {
    expect(errorsOf(manifest({ taskId: 'x' }))).toContain(
      'taskId: unknown field',
    )
    expect(
      errorsOf(
        manifest({ brief: { goal: 'g', done: '', remaining: '', note: 'n' } }),
      ),
    ).toContain('brief.note: unknown field')
  })

  test('rejects a JSON __proto__ key as an unknown field', () => {
    const body = JSON.stringify(manifest()).replace(
      '{',
      '{"__proto__":{"polluted":true},',
    )
    const result = parseManifest(body)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors).toContain('__proto__: unknown field')
  })

  test('reports every missing field', () => {
    const { deadline: _d, cwd: _c, ...rest } = manifest()
    const errors = errorsOf(rest)
    expect(errors).toContain('deadline: missing')
    expect(errors).toContain('cwd: missing')
  })

  test('rejects malformed shas and mixed object formats', () => {
    expect(errorsOf(manifest({ wip: 'A'.repeat(40) }))).toContain(
      'wip: not a full object id',
    )
    expect(errorsOf(manifest({ tree: 'b'.repeat(39) }))).toContain(
      'tree: not a full object id',
    )
    expect(errorsOf(manifest({ sessionCommit: 'c'.repeat(64) }))).toContain(
      'wip/tree/sessionCommit: mixed object formats',
    )
  })

  test('rejects tools outside the enum and a wrong kind', () => {
    expect(errorsOf(manifest({ tool: 'codex' }))[0]).toStartWith('tool:')
    expect(errorsOf(manifest({ kind: 'handoff.send' }))[0]).toStartWith('kind:')
  })

  test('device: charset, ref safety, and the reserved cloud name', () => {
    for (const device of ['', 'a b', 'a/b', '../x', 'x..y', 'x.lock', '中文']) {
      expect(errorsOf(manifest({ device }))).toContain(
        'device: not a safe device name',
      )
    }
    expect(errorsOf(manifest({ device: 'cloud' }))[0]).toContain('reserved')
    expect(
      errorsOf(
        manifest({
          device: 'Cornna-MacBook-Pro.local',
          sessionRef: `refs/qianmo/sessions/Cornna-MacBook-Pro.local/${SESSION}`,
        }),
      ),
    ).toEqual([])
  })

  test('project must be a bare-repo name without .git', () => {
    for (const project of ['atlas.git', 'a/b', '..', '.hidden']) {
      expect(errorsOf(manifest({ project }))).toContain(
        'project: not a safe repository name',
      )
    }
  })

  test('sessionRef must be the session ref of this device and session', () => {
    expect(
      errorsOf(manifest({ sessionRef: `refs/qianmo/wip/cornna-mbp/main` }))[0],
    ).toStartWith('sessionRef: not refs/qianmo/sessions')
    expect(
      errorsOf(manifest({ sessionRef: `refs/heads/${SESSION}` }))[0],
    ).toStartWith('sessionRef: not refs/qianmo/sessions')
    expect(
      errorsOf(
        manifest({ sessionRef: `refs/qianmo/sessions/other/${SESSION}` }),
      ),
    ).toContain('sessionRef: does not match device and sessionId')
  })

  test('cwd must be absolute and free of control characters', () => {
    for (const cwd of ['atlas', './atlas', '~/atlas', 'C:atlas', '/a\nb']) {
      expect(errorsOf(manifest({ cwd }))).toContain(
        'cwd: must be an absolute path',
      )
    }
  })

  test('deadline must be a real ISO UTC instant', () => {
    for (const deadline of [
      '2026-11-20',
      '2026-11-20T02:00:00+08:00',
      '2026-02-30T00:00:00Z',
      '2026-11-20 02:00:00Z',
      1_790_000_000_000,
    ]) {
      expect(errorsOf(manifest({ deadline }))[0]).toStartWith('deadline:')
    }
  })

  test('brief.goal must not be empty; done and remaining may be', () => {
    expect(
      errorsOf(manifest({ brief: { goal: ' ', done: '', remaining: '' } })),
    ).toEqual(['brief.goal: must not be empty'])
  })

  test('over-long fields are rejected field by field', () => {
    const long = 'x'.repeat(FIELD_MAX_BYTES.brief + 1)
    expect(
      errorsOf(manifest({ brief: { goal: long, done: '', remaining: '' } })),
    ).toContain(`brief.goal: longer than ${FIELD_MAX_BYTES.brief} bytes`)
    // Bytes, not characters: 1366 CJK characters are 4098 UTF-8 bytes.
    const cjk = '接'.repeat(1366)
    expect(
      errorsOf(manifest({ brief: { goal: 'g', done: cjk, remaining: '' } })),
    ).toContain(`brief.done: longer than ${FIELD_MAX_BYTES.brief} bytes`)
    expect(
      errorsOf(manifest({ cwd: `/${'d'.repeat(FIELD_MAX_BYTES.cwd)}` })),
    ).toContain(`cwd: longer than ${FIELD_MAX_BYTES.cwd} bytes`)
    expect(
      errorsOf(manifest({ branch: 'b'.repeat(FIELD_MAX_BYTES.branch + 1) })),
    ).toContain('branch: not a valid branch name')
  })

  test('the whole manifest is capped well under the envelope', () => {
    expect(MANIFEST_MAX_BYTES).toBe(LIMITS.maxMessageBytes / 16)
    // Each field within its cap, but JSON escaping of control characters
    // inflates the serialized form past the overall cap.
    const escaped = '\u0001'.repeat(1300)
    const result = validateManifest(
      manifest({
        brief: { goal: escaped, done: escaped, remaining: escaped },
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toStartWith('manifest: ')
  })

  test('parseManifest refuses oversized bodies before parsing them', () => {
    const result = parseManifest(' '.repeat(MANIFEST_MAX_BYTES + 1))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors[0]).toContain('over')
    const garbage = parseManifest('{not json')
    expect(garbage.ok).toBe(false)
    if (!garbage.ok) expect(garbage.errors).toEqual(['manifest: not JSON'])
  })

  test('non-objects are rejected', () => {
    for (const value of [null, [], 'x', 1]) {
      expect(errorsOf(value)).toEqual(['manifest: must be an object'])
    }
  })
})

describe('refs', () => {
  test('builders produce the three documented shapes', () => {
    expect(wipRef('cornna-mbp', 'feat/x')).toBe(
      'refs/qianmo/wip/cornna-mbp/feat/x',
    )
    expect(sessionRef('cloud', SESSION)).toBe(
      `refs/qianmo/sessions/cloud/${SESSION}`,
    )
    expect(taskBranch('t-1')).toBe('qianmo/t-1')
    expect(taskRef('t-1')).toBe('refs/heads/qianmo/t-1')
  })

  test('builders throw on unsafe components', () => {
    expect(() => wipRef('a/b', 'main')).toThrow(TypeError)
    expect(() => wipRef('dev', 'a..b')).toThrow(TypeError)
    expect(() => sessionRef('dev', 'a/b')).toThrow(TypeError)
    expect(() => taskBranch('a.b')).toThrow(TypeError)
  })

  test('parseQianmoRef round-trips and refuses everything else', () => {
    expect(parseQianmoRef('refs/qianmo/wip/dev/feat/x')).toEqual({
      kind: 'wip',
      device: 'dev',
      branch: 'feat/x',
    })
    expect(parseQianmoRef(`refs/qianmo/sessions/dev/${SESSION}`)).toEqual({
      kind: 'session',
      device: 'dev',
      sessionId: SESSION,
    })
    expect(parseQianmoRef('refs/heads/qianmo/t-1')).toEqual({
      kind: 'task',
      taskId: 't-1',
    })
    for (const ref of [
      'refs/heads/main',
      'refs/tags/v1',
      'refs/qianmo/other/x/y',
      'refs/qianmo/wip/dev',
      'refs/qianmo/sessions/dev/a/b',
      'refs/heads/qianmo/a/b',
      'refs/qianmo/wip/dev/a..b',
      'refs/qianmo/wip/dev/x.lock',
      'refs/qianmo/wip/dev/x y',
      42,
    ]) {
      expect(parseQianmoRef(ref)).toBeNull()
    }
  })

  test('branch names follow git check-ref-format', () => {
    for (const ok of ['main', 'feat/p17-handoff-core', '接力/分支', 'v1.2']) {
      expect(isValidBranchName(ok)).toBe(true)
    }
    for (const bad of [
      '',
      '-x',
      'a..b',
      'a//b',
      '/a',
      'a/',
      'a.',
      'a@{1}',
      '@',
      'a b',
      'a~1',
      'a^',
      'a:b',
      'a?',
      'a*',
      'a[',
      'a\\b',
      '.a',
      'a/.b',
      'a.lock',
      'refs/heads/x',
    ]) {
      expect(isValidBranchName(bad)).toBe(false)
    }
  })

  test('isIsoInstant', () => {
    expect(isIsoInstant('2028-02-29T00:00:00Z')).toBe(true)
    expect(isIsoInstant('2027-02-29T00:00:00Z')).toBe(false)
    expect(isIsoInstant('2026-11-20T24:00:00Z')).toBe(false)
  })
})

describe('task.result content', () => {
  const result = {
    status: 'completed',
    branch: 'qianmo/0199a3b2-task',
    head: SHA_A,
    threadId: SESSION,
    summary: '已在 qianmo 分支提交两处修复',
  } as const

  test('encode → decode round-trips with exactly the five fields', () => {
    const content = encodeResultContent(result)
    expect(Object.keys(JSON.parse(content))).toEqual([
      'status',
      'branch',
      'head',
      'threadId',
      'summary',
    ])
    const decoded = decodeResultContent(content)
    expect(decoded).toEqual({ ok: true, value: result })
  })

  test('decode rejects extra fields, bad branches, bad status', () => {
    const extra = decodeResultContent(
      JSON.stringify({ ...result, patch: 'diff --git' }),
    )
    expect(extra.ok).toBe(false)
    if (!extra.ok) expect(extra.errors).toEqual(['patch: unknown field'])

    for (const branch of ['main', 'qianmo/a/b', 'refs/heads/qianmo/x']) {
      const r = validateResult({ ...result, branch })
      expect(r.ok).toBe(false)
    }
    expect(validateResult({ ...result, status: 'done' }).ok).toBe(false)
    expect(validateResult({ ...result, head: 'HEAD' }).ok).toBe(false)
    expect(decodeResultContent('nope')).toEqual({
      ok: false,
      errors: ['result: not JSON'],
    })
  })

  test('summary and whole-content caps', () => {
    const long = 'x'.repeat(FIELD_MAX_BYTES.summary + 1)
    expect(() => encodeResultContent({ ...result, summary: long })).toThrow(
      HandoffValidationError,
    )
    const oversized = decodeResultContent(' '.repeat(RESULT_MAX_BYTES + 1))
    expect(oversized.ok).toBe(false)
  })
})
