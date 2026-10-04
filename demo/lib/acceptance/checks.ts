// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 断言累加器。
 *
 * 一条场景通常要同时成立好几件事（关闭码是 4003 **且** 审计链里记了理由
 * **且** 没有别的帧漏进来）。这个类让它们**逐条留痕**而不是短路：
 *
 *   · `expect()` 不抛，只记账。所以一条场景里三个断言全会被求值，报告里也就
 *     能看到「三条里坏了哪一条」；短路断言只会告诉你第一条坏了，第二次跑
 *     才知道第二条也坏了。
 *   · 每条断言无论成败都往证据里塞一行原文。红的时候不用回去重跑，绿的时候
 *     NDJSON 里也留着这次到底看见了什么。
 *
 * 与 `demo/lib/*-report-core.ts` 的「每条 check 单独留痕、不合并」同一条纪律。
 */

import type { Evidence, ScenarioOutcome } from './types.js'

export class Checks {
  readonly #evidence: Evidence[] = []
  readonly #failures: string[] = []
  #passed = 0

  /** 只记一行证据，不参与判定。 */
  note(label: string, value: unknown): this {
    this.#evidence.push({ label, value: render(value) })
    return this
  }

  /**
   * 一条断言。`ok` 为假就记一笔失败，但**不中断**后面的断言。
   *
   * `actual` 用变长参数收，是为了分清**没给**与**给了 `undefined`** ——
   * 早先两者都渲染成空串，于是「回执压根没来」和「回执来了但字段是空」在
   * 报告上长得一模一样。第 8 轮那条 `limits/envelope-too-large` 的现场就是
   * 三行空 `value`，谁也看不出回执到底有没有到（issue #109）。
   */
  expect(ok: boolean, description: string, ...actual: [unknown?]): this {
    if (ok) {
      this.#passed += 1
    } else {
      this.#failures.push(description)
    }
    this.#evidence.push({
      label: `${ok ? 'ok' : 'FAILED'} · ${description}`,
      value: actual.length === 0 ? '' : render(actual[0]),
    })
    return this
  }

  eq(actual: unknown, expected: unknown, what: string): this {
    return this.expect(
      Object.is(actual, expected),
      `${what} 应为 ${render(expected)}`,
      actual,
    )
  }

  contains(haystack: string | undefined, needle: string, what: string): this {
    return this.expect(
      haystack !== undefined && haystack.includes(needle),
      `${what} 应含 ${JSON.stringify(needle)}`,
      haystack ?? '(未取到)',
    )
  }

  notContains(
    haystack: string | undefined,
    needle: string,
    what: string,
  ): this {
    return this.expect(
      haystack === undefined || !haystack.includes(needle),
      `${what} 不应含 ${JSON.stringify(needle)}`,
      haystack ?? '(未取到)',
    )
  }

  get failed(): boolean {
    return this.#failures.length > 0
  }

  get passedCount(): number {
    return this.#passed
  }

  /** 收口成 runner 认的形状。 */
  done(summary?: string): ScenarioOutcome {
    const total = this.#passed + this.#failures.length
    const actual =
      this.#failures.length === 0
        ? (summary ?? `${total} 条断言全部成立`)
        : `${this.#failures.length}/${total} 条断言不成立: ${this.#failures.join('；')}`
    return { ok: this.#failures.length === 0, actual, evidence: this.#evidence }
  }

  /** 场景自行跳过（本目标上这条链路不存在等）。证据照样带出去。 */
  skip(reason: string): ScenarioOutcome {
    return { ok: false, actual: '跳过', evidence: this.#evidence, skip: reason }
  }
}

/**
 * 去掉 CLI 输出里那条**压缩后的源码帧**，别的一字不动。
 *
 * 真机腿跑的是 `dist/cli-node.js`（vite 产物），Bun 打印未捕获异常时会把出错
 * 那几行源码原样附上 —— 而那"几行"是 minify 后的 chunk，实测每行 1028 字符
 * （Bun 自己截断到这个长度），一次拒绝带出两行两千多字符的乱码，真正有用的那句
 * `error: …` 排在它们后面。
 *
 * 只删「行号 + ` | ` + 长内容」这一种形状，门槛 400 —— 本仓库的 biome 把源码限在
 * 80/120 列，所以本地腿（跑源码入口）的源码帧远在门槛之下、一行都不会被删；
 * 而被测系统自己打印的任何一行都不带 `N | ` 这个前缀。
 *
 * **删不掉的一律留着**：这个函数的失败方向必须是"留了噪声"，不能是"吃掉了
 * 证据"。就算某个源码帧里恰好含有要找的那句错误串（minify 后的 chunk 里确实
 * 可能有那个字面量），删掉它的后果也是**判红**而不是误判绿。
 *
 * 本地腿跑的是源码入口，源码帧本来就是短的，于是这个函数在本地是恒等映射。
 *
 * （产品侧那条 `dist` 上打印压缩源码的毛病本身是另一回事，套件只负责不被它
 * 淹掉。）
 */
export function stripMinifiedSourceFrame(output: string): string {
  return output
    .split('\n')
    .filter(line => !(line.length > 400 && /^\s*\d+ \| /.test(line)))
    .join('\n')
}

function render(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return '(undefined)'
  if (value === null) return '(null)'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
