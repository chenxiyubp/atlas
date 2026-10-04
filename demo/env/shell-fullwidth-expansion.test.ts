// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `demo/env` 下的 shell 里，**变量后面紧跟非 ASCII 字符时必须写花括号**。
 *
 * 为什么这条值得一个用例：`"$name（…）"` 是中文项目里最自然的写法，而 macOS 自带的
 * `/bin/bash` 是 3.2.57——它在 UTF-8 locale 下按**字节**切变量名，于是全角标点的首
 * 字节被算进名字里，`set -u` 当场报错：
 *
 * ```
 * $ /bin/bash -c 'set -u; v=hello; echo "$v，尾部"'
 * /bin/bash: v<ef>: unbound variable
 * $ /bin/bash -c 'set -u; v=hello; echo "${v}，尾部"'
 * hello，尾部
 * ```
 *
 * Linux + bash 5 没有这个问题，所以 CI 与节点上跑不出来——**只在开发者的 macOS 上
 * 炸**，而报错信息（`v<乱码>: unbound variable`）完全指不到病因。issue #49 一次性
 * 清掉了当时的 81 处；这条用例守的是**回潮**：新写的一行只要漏了花括号，就在这里
 * 变红，而不是等到某个开发者在 macOS 上跑 `demo/env` 时才发现。
 *
 * 判据比 issue 里那条正则宽：不是枚举全角标点，而是「`$var` 后面跟任何非 ASCII 字
 * 符」。枚举字符集会漏掉没被想到的那个（`—`、`·`、`《》`…），而 bash 3.2 的字节切
 * 分对**所有**多字节字符一视同仁。
 */

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..')
const ENV_ROOT = join(REPOSITORY_ROOT, 'demo', 'env')

/**
 * 不带花括号的变量引用，后面紧跟一个非 ASCII 字符。
 *
 * `\$[A-Za-z_][A-Za-z0-9_]*` 只匹配 `$name` 这一种形状：`${name}` 因为花括号不在
 * 名字首字符集里而不会命中，`$1` / `$@` / `$#` 这些特殊参数同理（它们后面跟多字节
 * 字符不会有歧义——名字就一个字符，bash 不会继续吃）。
 */
const UNBRACED_BEFORE_NON_ASCII = /\$[A-Za-z_][A-Za-z0-9_]*[^\p{ASCII}]/u

function shellScripts(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      found.push(...shellScripts(full))
    } else if (entry.endsWith('.sh')) {
      found.push(full)
    }
  }
  return found.sort()
}

/** `<相对路径>:<行号>: <整行>`，让红色输出直接可定位。 */
function offendingLines(file: string): string[] {
  const where = relative(REPOSITORY_ROOT, file)
  const hits: string[] = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (UNBRACED_BEFORE_NON_ASCII.test(line)) {
        hits.push(`${where}:${index + 1}: ${line.trim()}`)
      }
    })
  return hits
}

describe('demo/env 的 shell 在 bash 3.2 下不会把多字节字符吃进变量名', () => {
  test('判据本身是活的：已知的坏写法必须被它抓到', () => {
    // 少了这条，正则写坏成永不匹配时下面那条会静默常绿。
    expect(
      UNBRACED_BEFORE_NON_ASCII.test('beta_say "已停止 $name（pid $pid）"'),
    ).toBe(true)
    // 加了花括号的、以及 ASCII 上下文里的，都不该被抓。
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是 shell 的 ${var}，不是 JS 模板占位
      UNBRACED_BEFORE_NON_ASCII.test('beta_say "已停止 ${name}（pid ${pid}）"'),
    ).toBe(false)
    expect(
      UNBRACED_BEFORE_NON_ASCII.test('printf "%s\\n" "$name (pid $pid)"'),
    ).toBe(false)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 同上，${#name} 是 shell 的取长度
    expect(UNBRACED_BEFORE_NON_ASCII.test('echo "已停止 ${#name} 个"')).toBe(
      false,
    )
  })

  test('demo/env 下的每个 .sh 都给变量加了花括号，一处不剩', () => {
    const scripts = shellScripts(ENV_ROOT)
    // 目录被挪走 / 后缀约定变了的话，这条用例会静默失去意义。
    expect(scripts.length).toBeGreaterThan(5)

    const hits = scripts.flatMap(offendingLines)
    expect(
      hits,
      `变量后面紧跟非 ASCII 字符时要写 \${var}——macOS 自带 bash 3.2 会把首字节算进变量名，\`set -u\` 下报 unbound variable（issue #49）：\n${hits.join('\n')}`,
    ).toEqual([])
  })
})
