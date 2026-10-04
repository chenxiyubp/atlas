// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 单元模板的 ExecStart 直接执行的仓库脚本，必须带可执行位。
 *
 * 各脚本自己的用例都是 `bash <脚本>` 起的，缺可执行位时照样全绿；而 systemd 是直接
 * exec 那个路径的，缺了就是 `Permission denied`（2026-09-26 在 H 上撞到过：
 * watch-hub.sh 以 100644 进了提交，部署之后才发现）。这里按模板里真实出现的路径逐个查，
 * 看的是 git 索引里的模式——部署载荷由 clone 打包，工作区里手动 chmod 过的不算数。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const OPS = import.meta.dir
const REPO = resolve(OPS, '../../../..')

function execTargets(): string[] {
  const found = new Set<string>()
  for (const name of readdirSync(OPS)) {
    if (!name.endsWith('.in')) continue
    for (const line of readFileSync(join(OPS, name), 'utf8').split('\n')) {
      if (!line.startsWith('ExecStart=')) continue
      const hit = line.match(/@REPO_DIR@\/(demo\/env\/beta\/[^\s]+\.sh)/)
      if (hit?.[1]) found.add(hit[1])
      const ops = line.match(/@OPS_DIR@\/([^\s/]+\.sh)/)
      // @OPS_DIR@ 下的脚本由各自的 install 从仓库 ops/ 拷过去，源头同样要带可执行位
      if (ops?.[1]) found.add(`demo/env/beta/ops/${ops[1]}`)
    }
  }
  return [...found].sort()
}

function indexMode(path: string): string {
  const out = Bun.spawnSync(['git', 'ls-files', '-s', '--', path], {
    cwd: REPO,
  })
  return out.stdout.toString().trim().split(/\s+/)[0] ?? ''
}

describe('单元直接执行的脚本', () => {
  const targets = execTargets()

  test('模板里至少找得到这几条（防止正则悄悄什么都不匹配）', () => {
    expect(targets).toContain('demo/env/beta/ops/watch-hub.sh')
    expect(targets).toContain('demo/env/beta/ops/witness-endpoint.sh')
    expect(targets).toContain('demo/env/beta/beta-up.sh')
  })

  test.each(execTargets())('%s 在 git 索引里是 100755', path => {
    expect(indexMode(path)).toBe('100755')
  })
})
