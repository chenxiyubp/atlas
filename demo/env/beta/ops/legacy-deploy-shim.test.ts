// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `legacy-deploy-shim.sh` —— 顶替机器上那两个旧部署脚本的壳。
 *
 * 它只做一件事：把 `beta-deploy.sh` 从部署树里**拷出来**再跑。必须拷出来 ——
 * 那个脚本自己就住在 `demo/` 底下，从要被换掉的树里启动会把自己换掉，
 * 所以它带着一条守卫，见到自己在 `--tree` 之下会直接拒绝。
 *
 * 钉三条路径：树里有（跟着产物走）、树里还没有（退回机器上预置的那一份，
 * 换脚本那天必然走这条）、两处都没有（说人话而不是崩）。
 */

import { afterAll, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const HERE = resolve(import.meta.dir)
const BETA = resolve(HERE, '..')
const SHIM = join(HERE, 'legacy-deploy-shim.sh')
const made: string[] = []

afterAll(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** 一个假 HOME，外加一棵可装的构建树。 */
function sandbox(): { readonly home: string; readonly src: string } {
  const home = mkdtempSync(join(tmpdir(), 'qm-shim-'))
  made.push(home)
  const src = join(home, 'build')
  mkdirSync(join(src, 'dist'), { recursive: true })
  mkdirSync(join(src, 'demo', 'env', 'beta'), { recursive: true })
  writeFileSync(
    join(src, 'dist', 'cli-node.js'),
    'function s(){try{return`0123456789abcdef0123456789abcdef01234567`}catch{}}\n',
  )
  writeFileSync(join(src, 'demo', 'env', 'beta', 'beta-up.sh'), '#!/bin/sh\n')
  const shim = join(home, 'node-deploy.sh')
  cpSync(SHIM, shim)
  chmodSync(shim, 0o755)
  return { home, src }
}

/** 把仓库里的 beta-deploy.sh + common.sh 放到 dir 下。 */
function placeDeployScript(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const f of ['beta-deploy.sh', 'common.sh']) {
    cpSync(join(BETA, f), join(dir, f))
  }
}

function run(
  home: string,
  args: readonly string[],
): { code: number; out: string } {
  const r = Bun.spawnSync(['bash', join(home, 'node-deploy.sh'), ...args], {
    cwd: tmpdir(),
    env: { ...process.env, HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: r.exitCode ?? -1,
    out: `${r.stdout.toString()}${r.stderr.toString()}`,
  }
}

describe('legacy-deploy-shim.sh', () => {
  test('两处都没有 beta-deploy.sh 时说人话，而不是 unbound variable', () => {
    const { home, src } = sandbox()
    const r = run(home, ['--tree', join(home, 'atlas-beta'), '--from', src])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('都没有 beta-deploy.sh')
    // 这条壳第一次跑就栽在「$变量紧跟全角句号」上 —— C locale 下 set -u 会把
    // 那句人话整个换成 unbound variable。这里连同那一类坑一起钉住。
    expect(r.out).not.toContain('unbound variable')
  })

  test('树里还没有时，退回机器上预置的那一份', () => {
    const { home, src } = sandbox()
    placeDeployScript(join(home, 'qm-deploy'))
    const r = run(home, ['--tree', join(home, 'atlas-beta'), '--from', src])
    expect(r.code).toBe(0)
    expect(r.out).toContain('预置的那一份')
    expect(r.out).toContain('0123456789abcdef0123456789abcdef01234567')
  })

  test('树里有就用树里那一份，并先拷出来再跑', () => {
    const { home, src } = sandbox()
    placeDeployScript(join(home, 'qm-deploy'))
    // 让构建树自己带上部署脚本 —— 装完之后树里就有了。
    placeDeployScript(join(src, 'demo', 'env', 'beta'))
    expect(
      run(home, ['--tree', join(home, 'atlas-beta'), '--from', src]).code,
    ).toBe(0)

    const again = run(home, ['--tree', join(home, 'atlas-beta'), '--from', src])
    expect(again.code).toBe(0)
    expect(again.out).toContain('从树里拷')
  })

  test('不给参数就打用法，并且提醒 issue #111 那件事', () => {
    const { home } = sandbox()
    placeDeployScript(join(home, 'qm-deploy'))
    const r = run(home, [])
    expect(r.code).not.toBe(0)
    expect(r.out).toContain('--only dist,demo')
    expect(r.out).toContain('透传参数')
  })
})
