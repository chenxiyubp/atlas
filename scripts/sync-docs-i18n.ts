#!/usr/bin/env bun
/**
 * Keep docs.json's language trees and every page's switcher line in sync with
 * what is actually on disk.
 *
 * Translation lands page by page, so at any moment a language tree is a subset
 * of the canonical one. Two things must follow from that, and neither is
 * something a human should maintain by hand:
 *
 *   1. A language's navigation may only declare pages that exist. Mintlify
 *      publishes a nav entry whose file is missing as a 404 rather than
 *      dropping it, so an un-pruned tree ships broken links.
 *   2. A page's switcher may only link to languages where that page exists,
 *      for the same reason.
 *
 * The canonical page set and group structure come from CANONICAL_LANG, which
 * is the tree that is always complete. Run this after adding or removing any
 * translated page:
 *
 *   bun run sync:docs-i18n
 *   bun run sync:docs-i18n --check   # exit 1 if anything is out of date
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')
const CONFIG = join(PROJECT_ROOT, 'docs.json')
const MARKER = '<!-- lang-switcher -->'

/** The tree that is always complete; defines the page set and group order. */
const CANONICAL_LANG = 'zh'

/**
 * 语言表。**2026-08-26 起只剩 `zh`** —— 英文与日文译本（各 64 页）连同
 * `CHANGELOG.en/ja.md` 一并移除（三份 README 保留，见 CONTRIBUTING §13）：本项目不发布英日文档站，
 * 那 128 个文件是纯维护负担，而落后的译本比没有译本更糟。
 *
 * **这张表是唯一出处。** 只改 `docs.json` 而不改这里，下一次
 * `bun run sync:docs-i18n` 会把空的语言树原样写回去（实测：删掉 en/ja 之后
 * 跑一次 sync，docs.json 里立刻多出两个 `groups: []` 的语言，
 * 站点上就是两个空页签）。
 */
const LANGS = [{ code: 'zh', label: '中文' }] as const

type Group = { group: string; pages?: unknown[]; groups?: unknown[] }

function resolvePage(lang: string, page: string): string | null {
  for (const ext of ['mdx', 'md']) {
    const candidate = join(PROJECT_ROOT, 'docs', lang, `${page}.${ext}`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Rewrite a canonical tree for one language, dropping pages that have not
 * been translated yet and any group left empty by that pruning.
 */
function pruneForLanguage(node: unknown, lang: string): unknown | null {
  if (typeof node === 'string') {
    const page = node.replace(`docs/${CANONICAL_LANG}/`, '')
    return resolvePage(lang, page) ? `docs/${lang}/${page}` : null
  }
  if (Array.isArray(node)) {
    const kept = node
      .map(child => pruneForLanguage(child, lang))
      .filter(child => child !== null)
    return kept.length > 0 ? kept : null
  }
  if (node && typeof node === 'object') {
    const source = node as Group & Record<string, unknown>
    const out: Record<string, unknown> = {}
    let hasContent = false
    for (const [key, value] of Object.entries(source)) {
      if (key === 'pages' || key === 'groups') {
        const pruned = pruneForLanguage(value, lang)
        if (pruned === null) continue
        out[key] = pruned
        hasContent = true
      } else {
        out[key] = value
      }
    }
    return hasContent ? out : null
  }
  return null
}

/**
 * The switcher line for one page, linking only to languages that have it.
 *
 * 只剩一种语言时返回空串 —— 一行只写着「**中文**」的切换器是纯噪声，
 * 而它下面本来该有的那些链接现在会指向已经不存在的页面。
 * 返回空串会让 {@link applySwitcher} 把存量那一行整块剥掉。
 */
function switcherFor(lang: string, page: string): string {
  if (LANGS.length < 2) return ''
  const parts = LANGS.filter(
    l => l.code === lang || resolvePage(l.code, page) !== null,
  ).map(l =>
    l.code === lang
      ? `**${l.label}**`
      : `[${l.label}](/docs/${l.code}/${page})`,
  )
  return `${MARKER}\n${parts.join(' · ')}`
}

/** Insert or refresh the switcher directly below the frontmatter. */
function applySwitcher(file: string, lang: string, page: string): boolean {
  const original = readFileSync(file, 'utf8')
  const stripped = original.replace(
    new RegExp(`${MARKER}\\n[^\\n]*\\n\\n?`),
    '',
  )
  const block = switcherFor(lang, page)
  const frontmatter = /^---\n[\s\S]*?\n---\n/.exec(stripped)
  // block 为空（只剩一种语言）时是**剥掉**，不是插入一段空的 —— 否则正文前面
  // 会留下两个空行，而 markdown 里那等于凭空多一个段落间距。
  const body = frontmatter
    ? stripped.slice(frontmatter[0].length).replace(/^\n+/, '')
    : stripped.replace(/^\n+/, '')
  const head = frontmatter ? stripped.slice(0, frontmatter[0].length) : ''
  const next = block
    ? `${head}${frontmatter ? '\n' : ''}${block}\n\n${body}`
    : `${head}${body}`

  if (next === original) return false
  writeFileSync(file, next, 'utf8')
  return true
}

function collectPages(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node)
  } else if (Array.isArray(node)) {
    for (const child of node) collectPages(child, out)
  } else if (node && typeof node === 'object') {
    for (const key of ['groups', 'pages']) {
      if (key in (node as Record<string, unknown>)) {
        collectPages((node as Record<string, unknown>)[key], out)
      }
    }
  }
  return out
}

function main(): number {
  const checkOnly = process.argv.includes('--check')
  const raw = readFileSync(CONFIG, 'utf8')
  const config = JSON.parse(raw) as {
    navigation: { languages: Array<{ language: string; groups: unknown }> }
  }

  const canonical = config.navigation.languages.find(
    l => l.language === CANONICAL_LANG,
  )
  if (!canonical) {
    console.error(`[sync-docs-i18n] no '${CANONICAL_LANG}' language tree`)
    return 1
  }

  const canonicalPages = collectPages(canonical.groups).map(p =>
    p.replace(`docs/${CANONICAL_LANG}/`, ''),
  )

  // Default language: the first fully translated one, preferring the declared
  // order. A default with holes would send every reader to a 404 landing tree.
  const complete = LANGS.filter(l =>
    canonicalPages.every(p => resolvePage(l.code, p) !== null),
  ).map(l => l.code)
  const defaultLang = complete[0] ?? CANONICAL_LANG

  const languages = LANGS.map(l => {
    const groups = pruneForLanguage(canonical.groups, l.code) ?? []
    return {
      language: l.code,
      ...(l.code === defaultLang ? { default: true } : {}),
      groups,
    }
  })

  config.navigation = { languages }
  const serialized = `${JSON.stringify(config, null, 2)}\n`

  let switcherChanges = 0
  for (const page of canonicalPages) {
    for (const l of LANGS) {
      const file = resolvePage(l.code, page)
      if (file && applySwitcher(file, l.code, page)) switcherChanges++
    }
  }

  const navChanged = serialized !== raw
  if (checkOnly) {
    if (navChanged || switcherChanges > 0) {
      console.error(
        '[sync-docs-i18n] FAIL out of date — run `bun run sync:docs-i18n`',
      )
      return 1
    }
    console.log('[sync-docs-i18n] up to date')
    return 0
  }

  if (navChanged) writeFileSync(CONFIG, serialized, 'utf8')

  for (const l of LANGS) {
    const have = canonicalPages.filter(
      p => resolvePage(l.code, p) !== null,
    ).length
    const mark = l.code === defaultLang ? ' (default)' : ''
    console.log(
      `[sync-docs-i18n] ${l.code}${mark}  ${have}/${canonicalPages.length} pages`,
    )
  }
  console.log(
    `[sync-docs-i18n] nav ${navChanged ? 'updated' : 'unchanged'}, ` +
      `${switcherChanges} switcher line(s) rewritten`,
  )
  return 0
}

process.exit(main())
