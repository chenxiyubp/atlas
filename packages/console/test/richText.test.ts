// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import { renderRichText } from '../src/view/richText.js'

/**
 * Everything a hostile answer might try. The assertion is always the same
 * shape: **no tag this file did not spell out itself**, which in practice
 * means no `<` survives except the ones opening a tag from the fixed literal
 * set. Checking for banned words (`onerror`, `javascript:`) instead would pass
 * a broken renderer and fail a correct one — after the escape those are inert
 * characters, and they are allowed to appear as text.
 */
const ALLOWED_TAGS = /<(\/?)(p|b|code|pre|ul|li)(\s[^<>]*)?>/g

function strayMarkup(html: string): string {
  return html.replace(ALLOWED_TAGS, '')
}

describe('the transcript markdown subset', () => {
  test('plain text is a paragraph and keeps its own newlines', () => {
    const html = renderRichText('第一行\n第二行')
    expect(html).toBe('<p class="turn-p">第一行\n第二行</p>')
  })

  test('a blank line starts a new paragraph', () => {
    const html = renderRichText('一\n\n二')
    expect(html).toBe('<p class="turn-p">一</p><p class="turn-p">二</p>')
  })

  test('empty input says so rather than rendering nothing', () => {
    expect(renderRichText('   ')).toContain('turn-empty')
  })

  test('a fence becomes a code block and its info string is dropped', () => {
    const html = renderRichText('看这个：\n```ts\nconst a = 1\n```')
    expect(html).toContain(
      '<pre class="turn-code"><code>const a = 1</code></pre>',
    )
    // 语言标记不渲染、也不进 class：那是一个由远端文本拼出来的属性值。
    expect(html).not.toContain('language-')
    expect(html).not.toContain('>ts')
  })

  test('an unclosed fence takes the rest and stays inert', () => {
    const html = renderRichText('```\n<script>alert(1)</script>')
    expect(html).toContain('turn-code')
    expect(html).toContain('&lt;script&gt;')
    expect(strayMarkup(html)).not.toContain('<')
  })

  test('inline code and bold render, and code wins inside its span', () => {
    const html = renderRichText('跑 `bun test **x**` 然后看 **结果**')
    expect(html).toContain('<code class="mono">bun test **x**</code>')
    expect(html).toContain('<b>结果</b>')
  })

  test('an unpaired backtick or asterisk pair stays literal', () => {
    const html = renderRichText('一个 ` 反引号，以及 ** 没闭合')
    expect(html).not.toContain('<code')
    expect(html).not.toContain('<b>')
    expect(html).toContain('`')
  })

  test('a code span stops at the end of its line', () => {
    // 段落是 join('\n') 来的，所以一个落单的反引号能和三行之后的那个配上对，
    // 把中间的散文整段变成代码——那正是「未配对反引号保持字面」要防的那件事，
    // 只是从配对成功的那条分支进来的。
    const html = renderRichText('看 `a\n然后是 `b`')
    expect(html).not.toContain('<code class="mono">a\n然后是 </code>')
    expect(html).toContain('<code class="mono">b</code>')
  })

  test('a dash list becomes a list', () => {
    const html = renderRichText('结论：\n- 一\n- 二')
    expect(html).toContain('<ul class="turn-list"><li>一</li><li>二</li></ul>')
  })

  // -------------------------------------------------------------------------
  // 语料：每一条都曾是某个渲染器的真实缺口
  // -------------------------------------------------------------------------

  const CORPUS: readonly [string, string][] = [
    ['裸标签', '<script>alert(1)</script>'],
    ['属性事件', '<img src=x onerror=alert(1)>'],
    ['伪协议链接', '[点我](javascript:alert(1))'],
    ['自动链接', 'https://example.com/?a=1&b=2'],
    ['尖括号自动链接', '<https://example.com>'],
    ['围栏里套围栏', '```\n```\n<b>x</b>\n```\n```'],
    ['围栏里的标签', '```html\n<iframe src=x></iframe>\n```'],
    ['行内代码里的标签', '`<svg onload=alert(1)>`'],
    ['粗体里的标签', '**<script>x</script>**'],
    ['列表里的标签', '- <script>x</script>'],
    ['CDATA 收尾', ']]><script>x</script>'],
    ['注释', '<!-- --><script>x</script>'],
    ['双重转义', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['属性引号', '" onmouseover="alert(1)'],
    ['单引号', "' onfocus='alert(1)"],
    ['反斜杠转义', '\\<script\\>'],
    ['零宽字符', '<scr​ipt>alert(1)</scr​ipt>'],
    ['大写标签', '<SCRIPT>alert(1)</SCRIPT>'],
    ['图片语法', '![x](https://example.com/x.png)'],
    ['HTML 实体做的尖括号', '&#60;script&#62;alert(1)&#60;/script&#62;'],
  ]

  for (const [name, payload] of CORPUS) {
    test(`语料：${name} 不产生任何标记`, () => {
      const html = renderRichText(payload)
      const stray = strayMarkup(html)
      // 判据只有一条：除了本文件自己写死的那几个标签，没有任何标记逃出来。
      // **不按字面禁词判**（`onerror` / `javascript:` / `src=`）——转义之后它们
      // 就是普通字符，而且本来就该原样显示；按禁词判会放过坏实现、判错好实现。
      // 「不许造出可点目标」由同一条判据覆盖：`<a>` 与 `<img>` 不在白名单里，
      // 真出现了就会留在 stray 里。
      expect(stray).not.toContain('<')
      expect(stray).not.toContain('>')
    })
  }

  test('the escape runs before any structure is decided', () => {
    // 这条是那条纪律本身的用例：如果哪天有人把解析挪到转义之前，
    // 「围栏标记藏在被转义的字符里」这一类输入就会先被解析出结构。
    const html = renderRichText('&lt;/code&gt;&lt;script&gt;x&lt;/script&gt;')
    expect(html).toContain('&amp;lt;')
    expect(strayMarkup(html)).not.toContain('<')
  })
})
