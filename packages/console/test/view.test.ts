// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The view layer, tested as what it is: pure functions from data to strings.
 *
 * That is the whole reason the console renders on the server. There is no
 * browser here, no DOM, no jsdom, no build step — a roster with a hostile
 * address in it is a function call, and "did the escape hold" is an assertion
 * about a string. The parts that a browser *would* be needed for are kept in
 * `client.ts` and deliberately kept small.
 *
 * The suite is organised around what can actually go wrong:
 *
 * - **Escaping**, with real payloads rather than a lone `<b>`. Element content,
 *   attribute position, and the two breakouts that a naive escaper misses
 *   (`" onload=` and `</textarea>`).
 * - **Health boundaries**, because `live`/`stale`/`expired` is the one piece of
 *   judgement in the view and an off-by-one there is a node that looks fine
 *   until it vanishes.
 * - **Failure and empty states**, because those are the states a first-time
 *   user is guaranteed to hit and the states nobody demos.
 * - **The two claims the page makes about itself**: the integrity strip is
 *   loud, and the two rate limits never merge into one number.
 */

import { describe, expect, test } from 'bun:test'
import { AuditSource, type AuditRecord, type MessageChain } from '@qianmo/audit'
import { CONSOLE_CLIENT_JS } from '../src/assets/client.js'
import { CONSOLE_CSS } from '../src/assets/css.js'
import { renderRoster } from '../src/view/agents.js'
import {
  MAX_SERVER_NOTE_LENGTH,
  renderServers,
  serverCards,
} from '../src/view/servers.js'
import {
  renderAudit,
  renderAuditSources,
  renderChain,
} from '../src/view/audit.js'
import { attr, escapeHtml } from '../src/view/escape.js'
import {
  agentHealth,
  formatBytes,
  formatDuration,
  formatInstant,
  formatShortDuration,
  publicKeyFingerprint,
} from '../src/view/format.js'
import { renderLimits } from '../src/view/limits.js'
import { renderPage } from '../src/view/page.js'
import type {
  AuditFilter,
  AuditPage,
  ConsoleAgent,
  ConsoleFailure,
  LimitsSnapshot,
  NodeServer,
  ServerNote,
} from '../src/deps.js'

const NOW = 1_760_000_000_000
const TTL = 300_000

function agent(over: Partial<ConsoleAgent> = {}): ConsoleAgent {
  return {
    address: 'qianmo://node-a/reviewer',
    endpoint: 'node-a.internal:7421',
    capabilities: ['code-review', 'summarize'],
    status: 'online',
    registeredAt: NOW - 600_000,
    lastHeartbeatAt: NOW - 10_000,
    expiresAt: NOW + TTL - 10_000,
    ...over,
  }
}

function record(over: Partial<AuditRecord> = {}): AuditRecord {
  return {
    seq: 1,
    at: NOW - 5_000,
    source: AuditSource.Router,
    kind: 'forward',
    outcome: 'ok',
    prev: '0'.repeat(64),
    ...over,
  }
}

function page(over: Partial<AuditPage> = {}): AuditPage {
  const merged = {
    records: [record()],
    intact: true,
    issueCount: 0,
    total: 1,
    witness: { tampered: false, stale: false },
    ...over,
  }
  // `chain` is derived from the rest unless a case states it, so a fixture
  // cannot accidentally claim a broken chain that is also `intact`.
  // `total` and not `records.length`: the chain state is a fact about the
  // whole file, and a filter that matched nothing does not make a 40-record
  // trail an empty one.
  return {
    chain: !merged.intact ? 'broken' : merged.total === 0 ? 'empty' : 'intact',
    ...merged,
  }
}

const LIMITS: LimitsSnapshot = {
  protocol: {
    maxMessageBytes: 256 * 1024,
    maxHops: 8,
    defaultTtlMs: 30_000,
    defaultTaskTtlMs: 300_000,
    ratePerMinute: 600,
  },
  runtime: { capacity: 20, windowMs: 60_000 },
  registryTtlMs: TTL,
}

const NO_FILTER: AuditFilter = {}

/** Payloads that a peer on the network could plausibly put in an address. */
const ATTACKS = {
  script: '<script>alert(1)</script>',
  handler: '" onload="alert(1)',
  textarea: '</textarea><img src=x onerror=alert(1)>',
  singleQuote: "' onmouseover='alert(1)",
  backtick: '`onload=alert(1)',
  entity: 'a&b',
  closeTag: '</style><script>alert(1)</script>',
} as const

/**
 * The precise property, rather than a substring hunt.
 *
 * Looking for `onerror=` is the wrong assertion: it appears, harmlessly, inside
 * `&lt;img src=x onerror=alert(1)&gt;`, which is text. What must never appear
 * is the **raw payload**, byte for byte — if the exact attack string survives
 * anywhere in the output then some `"` or `<` was not encoded, and that is the
 * only way one of these becomes markup.
 */
function expectInert(html: string): void {
  for (const payload of Object.values(ATTACKS)) {
    // `entity` is a legitimate string, not an attack.
    if (payload === ATTACKS.entity) continue
    // A bare backtick is inert in element content — it is a quote character
    // only inside an *unquoted* attribute value, which is why `attr` escapes it
    // and `escapeHtml` deliberately does not. Its attribute-position behaviour
    // is asserted directly in the escape suite.
    if (payload === ATTACKS.backtick) continue
    expect(html).not.toContain(payload)
  }
  expect(html).not.toContain('<script>alert')
  expect(html).not.toContain('<img')
}

/**
 * The document with its favicon link removed.
 *
 * The `<link rel="icon">` in the head is the one element on these pages that is
 * not markup the view layer wrote from data — it is a self-contained `data:`
 * URI, no host, no request. The "loads nothing" assertions are about *hosts*,
 * so they run against the document with that one line lifted out rather than
 * being weakened to allow a `<link>` anywhere.
 */
function withoutFavicon(markup: string): string {
  const stripped = markup.replace(/<link rel="icon"[^>]*>\n?/, '')
  expect(stripped).not.toBe(markup)
  return stripped
}

/**
 * The declarations of one CSS rule, by the selector that opens it.
 *
 * Design decisions that a redesign is supposed to keep — the rail is a real
 * column, a section label is 12px of unbold mono — are only worth writing down
 * if they can be checked, and the place they live is the stylesheet.
 */
function ruleOf(selector: string): string {
  const at = CONSOLE_CSS.indexOf(`\n${selector} {`)
  expect(at).toBeGreaterThan(-1)
  const start = CONSOLE_CSS.indexOf('{', at)
  return CONSOLE_CSS.slice(start, CONSOLE_CSS.indexOf('}', start))
}

// ---------------------------------------------------------------------------

describe('escape', () => {
  test('covers the five characters that matter, and nothing else', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
    expect(escapeHtml('plain 文本 42')).toBe('plain 文本 42')
  })

  test('ampersand is escaped first, so no double-encoding loop', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;')
    expect(escapeHtml(ATTACKS.entity)).toBe('a&amp;b')
  })

  test('neutralises a script tag', () => {
    const out = escapeHtml(ATTACKS.script)
    expect(out).not.toContain('<script')
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })

  test('neutralises the attribute breakout', () => {
    expect(attr(ATTACKS.handler)).not.toContain('"')
    expect(attr(ATTACKS.singleQuote)).not.toContain("'")
  })

  test('neutralises the textarea breakout', () => {
    const out = escapeHtml(ATTACKS.textarea)
    expect(out).not.toContain('</textarea')
    expect(out).not.toContain('<img')
  })

  test('attr is strictly wider than escapeHtml: backtick too', () => {
    expect(attr(ATTACKS.backtick)).not.toContain('`')
    expect(attr(ATTACKS.backtick)).toContain('&#96;')
    // escapeHtml leaves it, which is correct for element content.
    expect(escapeHtml(ATTACKS.backtick)).toContain('`')
  })

  test('survives a non-string arriving off a socket', () => {
    const sneaky = 42 as unknown as string
    expect(escapeHtml(sneaky)).toBe('42')
    expect(() => attr(null as unknown as string)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------

describe('formatting', () => {
  test('formatInstant carries a clock and a relative gap', () => {
    const out = formatInstant(NOW - 180_000, NOW)
    expect(out).toMatch(/^\d{2}:\d{2}:\d{2}（3 分钟前）$/)
  })

  test('formatInstant names the sub-second case rather than saying "0 秒前"', () => {
    expect(formatInstant(NOW - 200, NOW)).toContain('（刚刚）')
  })

  test('formatInstant shows clock skew instead of hiding it', () => {
    expect(formatInstant(NOW + 5_000, NOW)).toContain('（5 秒后）')
  })

  test('formatInstant refuses to invent a time for a missing stamp', () => {
    expect(formatInstant(0, NOW)).toBe('—')
    expect(formatInstant(Number.NaN, NOW)).toBe('—')
  })

  test('formatDuration: the two documented examples', () => {
    expect(formatDuration(90_000)).toBe('1 分 30 秒')
    expect(formatDuration(90 * 24 * 3_600_000)).toBe('90 天')
  })

  test('formatDuration drops a zero remainder and stops at two units', () => {
    expect(formatDuration(60_000)).toBe('1 分')
    expect(formatDuration(3_600_000)).toBe('1 小时')
    expect(formatDuration(3_600_000 + 120_000)).toBe('1 小时 2 分')
    expect(formatDuration(24 * 3_600_000 + 3 * 3_600_000)).toBe('1 天 3 小时')
    expect(formatDuration(500)).toBe('500 毫秒')
    expect(formatDuration(-5_000)).toBe('0 毫秒')
  })

  test('formatBytes speaks the same binary units as LIMITS', () => {
    expect(formatBytes(256 * 1024)).toBe('256 KiB')
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1023 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5 MiB')
  })

  test('publicKeyFingerprint is a hash, not a prefix of the key', () => {
    const key = 'ed25519:AAAABBBBCCCCDDDD'
    const fp = publicKeyFingerprint(key)
    expect(fp).toHaveLength(8)
    expect(fp).toMatch(/^[0-9a-f]{8}$/)
    expect(key).not.toContain(fp)
  })
})

// ---------------------------------------------------------------------------

describe('agentHealth', () => {
  test('a fresh heartbeat inside the first half of the lease is live', () => {
    expect(agentHealth(agent(), NOW, TTL)).toBe('live')
  })

  test('exactly half a TTL is already stale — the renewal is overdue', () => {
    const half = agent({
      lastHeartbeatAt: NOW - TTL / 2,
      expiresAt: NOW + TTL / 2,
    })
    expect(agentHealth(half, NOW, TTL)).toBe('stale')
  })

  test('one millisecond before half is still live', () => {
    const nearly = agent({
      lastHeartbeatAt: NOW - (TTL / 2 - 1),
      expiresAt: NOW + TTL,
    })
    expect(agentHealth(nearly, NOW, TTL)).toBe('live')
  })

  test('an age exactly equal to the TTL is expired, not stale', () => {
    // The boundary the roster is judged on: the lease has run out to the
    // millisecond. Rounding this the other way puts a dead node in amber.
    const exact = agent({ lastHeartbeatAt: NOW - TTL, expiresAt: 0 })
    expect(agentHealth(exact, NOW, TTL)).toBe('expired')
  })

  test('a lapsed lease is expired even with a recent heartbeat', () => {
    const lapsed = agent({ lastHeartbeatAt: NOW - 1_000, expiresAt: NOW - 1 })
    expect(agentHealth(lapsed, NOW, TTL)).toBe('expired')
  })

  test('a lease expiring exactly now is expired', () => {
    expect(agentHealth(agent({ expiresAt: NOW }), NOW, TTL)).toBe('expired')
  })

  test('never heard from is stale, never live', () => {
    const silent = agent({ lastHeartbeatAt: 0, expiresAt: NOW + TTL })
    expect(agentHealth(silent, NOW, TTL)).toBe('stale')
  })

  test('a heartbeat from the future reads as just-now, not as negative age', () => {
    const skewed = agent({
      lastHeartbeatAt: NOW + 60_000,
      expiresAt: NOW + TTL,
    })
    expect(agentHealth(skewed, NOW, TTL)).toBe('live')
  })

  test('no lease on the record and a nonsense fallback leave only the lease check', () => {
    expect(agentHealth(agent({ expiresAt: 0 }), NOW, 0)).toBe('live')
    expect(agentHealth(agent({ expiresAt: NOW - 1 }), NOW, 0)).toBe('expired')
  })

  test('a lease on the record makes the fallback irrelevant', () => {
    // 10 s into a lease the registry granted for 10.001 s: past half, whatever
    // the fallback says — before C-1 a zero fallback read this as live.
    expect(agentHealth(agent({ expiresAt: NOW + 1 }), NOW, 0)).toBe('stale')
  })
})

/**
 * Validation report 2026-09-08, C-1: a registry started with a one-hour lease,
 * a console built with the 90 s package default, and every node more than 45 s
 * past its heartbeat reported 滞后, more than 90 s past it 过期 — while the
 * registry still listed and routed to it. The records carry the registry's own
 * lease (`expiresAt − lastHeartbeatAt`), and that is the only scale.
 */
describe('the registry lease is the scale (C-1)', () => {
  const HOUR = 3_600_000
  const PACKAGE_DEFAULT = 90_000

  function leased(sinceBeatMs: number, leaseMs: number): ConsoleAgent {
    const beat = NOW - sinceBeatMs
    return agent({ lastHeartbeatAt: beat, expiresAt: beat + leaseMs })
  }

  test('an hour-long lease two minutes after the heartbeat is live', () => {
    expect(agentHealth(leased(120_000, HOUR), NOW, PACKAGE_DEFAULT)).toBe(
      'live',
    )
    // Past half of the package default, still inside the first half-hour.
    expect(agentHealth(leased(45_000, HOUR), NOW, PACKAGE_DEFAULT)).toBe('live')
    expect(agentHealth(leased(HOUR / 2 - 1, HOUR), NOW, PACKAGE_DEFAULT)).toBe(
      'live',
    )
  })

  test('half of the hour is stale, not half of the default', () => {
    expect(agentHealth(leased(HOUR / 2, HOUR), NOW, PACKAGE_DEFAULT)).toBe(
      'stale',
    )
  })

  test('a lease that has run out is still expired', () => {
    // To the millisecond, and one past it.
    expect(agentHealth(leased(HOUR, HOUR), NOW, PACKAGE_DEFAULT)).toBe(
      'expired',
    )
    expect(agentHealth(leased(HOUR + 1, HOUR), NOW, PACKAGE_DEFAULT)).toBe(
      'expired',
    )
  })

  test('a lease shorter than the default goes amber at its own half', () => {
    // 2 s into a 4 s lease; judged by 90 s it would still read as live.
    expect(agentHealth(leased(2_000, 4_000), NOW, PACKAGE_DEFAULT)).toBe(
      'stale',
    )
  })

  test('the fallback is the scale only for a record that carries no lease', () => {
    const noLease = (sinceBeatMs: number) =>
      agent({ lastHeartbeatAt: NOW - sinceBeatMs, expiresAt: 0 })
    expect(agentHealth(noLease(44_999), NOW, PACKAGE_DEFAULT)).toBe('live')
    expect(agentHealth(noLease(45_000), NOW, PACKAGE_DEFAULT)).toBe('stale')
    expect(agentHealth(noLease(90_000), NOW, PACKAGE_DEFAULT)).toBe('expired')
  })

  test('the row, the bar and the header all read the hour', () => {
    const html = renderRoster(
      [leased(120_000, HOUR)],
      null,
      NOW,
      PACKAGE_DEFAULT,
    )
    expect(html).toContain('data-health="live"')
    expect(html).not.toContain('滞后')
    expect(html).not.toContain('过期')
    expect(html).toContain('租约 1 小时')
    expect(html).not.toContain('租约 1 分 30 秒')
    // 58 of 60 minutes left, and the fill is that share, not 0%.
    expect(html).toContain('>剩余 58m<')
    expect(html).toContain('style="width:97%"')
  })

  test('the header reads the most recently renewed record', () => {
    // A restart with a new TTL re-stamps every record on restore, and a
    // time-jump rebase stretches the older ones; the newest stamp is the TTL in
    // force either way.
    const older = { ...leased(30_000, 5 * HOUR), address: 'qianmo://n/a' }
    const newer = { ...leased(1_000, HOUR), address: 'qianmo://n/b' }
    for (const agents of [
      [older, newer],
      [newer, older],
    ]) {
      const html = renderRoster(agents, null, NOW, PACKAGE_DEFAULT)
      expect(html).toContain('租约 1 小时')
      expect(html).not.toContain('租约 5 小时')
    }
  })

  test('with no lease on any record the header falls back to the default', () => {
    const html = renderRoster(
      [agent({ expiresAt: 0 })],
      null,
      NOW,
      PACKAGE_DEFAULT,
    )
    expect(html).toContain('租约 1 分 30 秒')
  })
})

// ---------------------------------------------------------------------------

describe('renderRoster', () => {
  test('an empty registry names the next action instead of going blank', () => {
    const html = renderRoster([], null, NOW, TTL)
    expect(html).toContain('还没有节点 · ')
    expect(html).toContain('在下面注册第一个')
    expect(html).toContain('href="#register"')
    expect(html).not.toContain('<table')
    // One short line. The empty state is allowed a sentence; it is not allowed
    // a paragraph of encouragement.
    expect(html).not.toContain('。')
  })

  test('every branch emits the header, so the section never loses its heading', () => {
    const failure: ConsoleFailure = { code: 'unreachable', message: '超时' }
    for (const html of [
      renderRoster(null, null, NOW, TTL),
      renderRoster(null, failure, NOW, TTL),
      renderRoster([], null, NOW, TTL),
      renderRoster([agent()], null, NOW, TTL),
    ]) {
      expect(html).toContain('class="sec-head"')
      expect(html).toContain('<h2 id="h-nodes">名册</h2>')
      expect(html).toContain('<div class="pane">')
    }
  })

  test('the header carries the counts the deleted prose used to explain', () => {
    const html = renderRoster(
      [agent(), agent({ address: 'a://2' })],
      null,
      NOW,
      TTL,
    )
    expect(html).toContain('<span class="total">2</span>')
    expect(html).toContain('<span class="tone-ok">在线 2</span>')
    // Zero rows are not printed: a permanent 过期 0 makes the day it turns
    // into 过期 1 look like nothing changed.
    expect(html).not.toContain('滞后 0')
    expect(html).not.toContain('过期 0')
    expect(html).toContain('租约 5 分')
  })

  test('a null roster with no failure says so rather than pretending to be empty', () => {
    const html = renderRoster(null, null, NOW, TTL)
    expect(html).toContain('未取得注册数据')
    expect(html).not.toContain('暂无节点')
  })

  test('a failure renders a bar and does not throw', () => {
    const failure: ConsoleFailure = {
      code: 'unreachable',
      message: '连接注册中心被拒绝',
    }
    let html = ''
    expect(() => {
      html = renderRoster(null, failure, NOW, TTL)
    }).not.toThrow()
    expect(html).toContain('bar-bad')
    expect(html).toContain('unreachable')
    expect(html).toContain('连接注册中心被拒绝')
  })

  test('a failure over stale data keeps the roster and says the data is old', () => {
    const failure: ConsoleFailure = { code: 'unreachable', message: '超时' }
    const html = renderRoster([agent()], failure, NOW, TTL)
    expect(html).toContain('bar-bad')
    expect(html).toContain('最后一次成功读取')
    expect(html).toContain('<details class="row"')
  })

  test('a failure message is escaped like everything else', () => {
    const failure: ConsoleFailure = {
      code: 'rejected',
      message: ATTACKS.script,
    }
    const html = renderRoster(null, failure, NOW, TTL)
    expect(html).not.toContain('<script')
  })

  test('every hostile field is neutralised in both content and attribute position', () => {
    const html = renderRoster(
      [
        agent({
          address: ATTACKS.handler,
          endpoint: ATTACKS.script,
          capabilities: [ATTACKS.textarea],
          status: ATTACKS.closeTag,
        }),
      ],
      null,
      NOW,
      TTL,
    )
    expectInert(html)
    // The address still round-trips into the action buttons, escaped.
    expect(html).toContain('data-address="&quot; onload=&quot;alert(1)"')
  })

  test('the public key is never printed, only an 8-hex fingerprint', () => {
    const key = 'ed25519:MCowBQYDK2VwAyEA-secret-looking-material'
    const html = renderRoster([agent({ publicKey: key })], null, NOW, TTL)
    expect(html).not.toContain(key)
    expect(html).not.toContain('MCowBQYDK2VwAyEA')
    expect(html).toContain(publicKeyFingerprint(key))
  })

  test('a node with no key says so instead of leaving the cell blank', () => {
    const html = renderRoster([agent()], null, NOW, TTL)
    expect(html).toContain('未发布')
  })

  test('one card per node, one disclosure row per agent', () => {
    // Grouping is what replaced an eight-column table with a fixed width
    // budget: the node appears once in a card header instead of once a row.
    const html = renderRoster(
      [
        agent({ address: 'qianmo://node-a/one' }),
        agent({ address: 'qianmo://node-a/two' }),
        agent({ address: 'qianmo://node-b/one' }),
      ],
      null,
      NOW,
      TTL,
    )
    expect(html.match(/class="card elev-sm grp"/g)).toHaveLength(2)
    expect(html.match(/<details class="row"/g)).toHaveLength(3)
    // The agent segment of every address is a pill — the signature element.
    expect(html).toContain('qianmo://node-a/<b>one</b>')
    expect(html).toContain('<span class="grp-name">node-a</span>')
    // Native disclosure, so a row opens with the script disabled.
    expect(html).toContain('<summary>')
    expect(html).not.toContain('<table')
  })

  test('the expanded panel holds what the row no longer has room for', () => {
    const html = renderRoster([agent({ publicKey: 'k' })], null, NOW, TTL)
    const panel = html.slice(html.indexOf('<div class="row-panel">'))
    for (const key of ['能力', '端点', '公钥', '上次心跳']) {
      expect(panel).toContain(key)
    }
    // 注销 is demoted into the panel behind a ghost button; nothing on a
    // resting row can fire it.
    expect(panel).toContain('data-action="deregister"')
    expect(panel).toContain('btn-ghost btn-danger')
    const summary = html.slice(0, html.indexOf('</summary>'))
    expect(summary).not.toContain('deregister')
    expect(summary).toContain('data-action="heartbeat"')
  })

  test('the three health states each get their own tone', () => {
    const html = renderRoster(
      [
        agent({ address: 'a://1' }),
        agent({
          address: 'a://2',
          lastHeartbeatAt: NOW - TTL / 2,
          expiresAt: NOW + 10,
        }),
        agent({ address: 'a://3', expiresAt: NOW - 1 }),
      ],
      null,
      NOW,
      TTL,
    )
    expect(html).toContain('data-health="live"')
    expect(html).toContain('data-health="stale"')
    expect(html).toContain('data-health="expired"')
    // Status is a dot, not a filled badge: a column of colour blocks stops
    // meaning anything by the fourth row.
    expect(html).toContain('dot-ok')
    expect(html).toContain('dot-warn')
    expect(html).toContain('dot-bad')
    // …and the header states the same three counts as digits.
    expect(html).toContain('<span class="total">3</span>')
    expect(html).toContain('<span class="tone-ok">在线 1</span>')
    expect(html).toContain('<span class="tone-warn">滞后 1</span>')
    expect(html).toContain('<span class="tone-bad">过期 1</span>')
  })

  test('a lapsed lease is labelled, not shown as a negative countdown', () => {
    const html = renderRoster(
      [agent({ expiresAt: NOW - 90_000 })],
      null,
      NOW,
      TTL,
    )
    expect(html).toContain('过期')
    expect(html).not.toContain('-90')
  })

  test('each row offers heartbeat and deregister', () => {
    const html = renderRoster([agent()], null, NOW, TTL)
    expect(html).toContain('data-action="heartbeat"')
    expect(html).toContain('data-action="deregister"')
  })
})

// ---------------------------------------------------------------------------

/**
 * The one graphic element on the page, and therefore the one that has to be
 * pinned down. Three boundaries: under half a lease, past half, and lapsed.
 */
describe('server attribution on the roster', () => {
  const FLEET: readonly ConsoleAgent[] = [
    agent({ address: 'qianmo://node-a/reviewer' }),
    agent({ address: 'qianmo://node-b/reviewer' }),
    agent({ address: 'qianmo://node-c/reviewer' }),
    agent({ address: 'qianmo://node-d/reviewer' }),
  ]

  test('says nothing about servers when the console was not told', () => {
    // 缺参数 = 整体降级为不显示归属。不是空白栏，不是「未知」，也不是抛错。
    const html = renderRoster(FLEET, null, NOW, TTL)
    expect(html).not.toContain('服务器')
    // 名册本体照旧：四张卡片都在。
    expect(html.match(/class="card elev-sm grp"/g)).toHaveLength(4)
  })

  test('names the machine on the card, beside the endpoint it corrects', () => {
    const html = renderRoster(FLEET, null, NOW, TTL, undefined, [
      { node: 'node-a', server: 'p11' },
    ])
    expect(html).toContain('服务器 <span class="mono">p11</span>')
    // 归属必须排在端点前面：端点正是它要纠正的那个值。
    expect(html.indexOf('p11')).toBeLessThan(html.indexOf('node-a.internal'))
  })

  test('carries three of four machines without collapsing the fourth', () => {
    // 部署侧判定不出归属的节点**不传**，所以「部分节点有归属」是常态而不是边角。
    const html = renderRoster(FLEET, null, NOW, TTL, undefined, [
      { node: 'node-a', server: 'p11' },
      { node: 'node-b', server: 'p11' },
      { node: 'node-c', server: '203.0.113.7' },
    ])
    expect(html.match(/class="card elev-sm grp"/g)).toHaveLength(4)
    expect(html.match(/服务器 <span class="mono">/g)).toHaveLength(3)
    // 第四张卡片仍在，只是那一行不出现——它不能变成一个空白栏。
    expect(html).toContain('qianmo://node-d')
    const fourth = html.slice(html.indexOf('qianmo://node-d'))
    expect(fourth).not.toContain('服务器')
  })

  test('ignores a mapping for a node that is not on the roster', () => {
    const html = renderRoster(FLEET, null, NOW, TTL, undefined, [
      { node: 'node-z', server: 'ghost-box' },
    ])
    expect(html).not.toContain('ghost-box')
  })

  test('escapes a machine name, which is a startup argument not a constant', () => {
    const html = renderRoster(FLEET, null, NOW, TTL, undefined, [
      { node: 'node-a', server: ATTACKS.script },
    ])
    expectInert(html)
  })
})

describe('renderServers', () => {
  const NODE_SERVERS: readonly NodeServer[] = [
    { node: 'node-a', server: 'p11' },
    { node: 'node-b', server: 'p11' },
    { node: 'node-c', server: '203.0.113.7' },
  ]

  function model(over: Partial<Parameters<typeof renderServers>[0]> = {}) {
    return {
      cards: serverCards(NODE_SERVERS, []),
      failure: null,
      editable: true,
      notesEnabled: true,
      now: NOW,
      ...over,
    }
  }

  test('groups the nodes under the machine that carries them', () => {
    const cards = serverCards(NODE_SERVERS, [])
    expect(cards).toEqual([
      { server: 'p11', nodes: ['node-a', 'node-b'], note: null },
      { server: '203.0.113.7', nodes: ['node-c'], note: null },
    ])
    const html = renderServers(model())
    expect(html).toContain('>p11<')
    expect(html).toContain('2 个节点')
    expect(html).toContain('1 个节点')
  })

  test('puts an existing note in the box and stamps when it was written', () => {
    const note: ServerNote = {
      server: 'p11',
      note: '香港 · 只跑演示',
      updatedAt: NOW - 60_000,
    }
    const html = renderServers(
      model({ cards: serverCards(NODE_SERVERS, [note]) }),
    )
    expect(html).toContain('>香港 · 只跑演示</textarea>')
    expect(html).toContain('更新于')
    // 没写过的那台说「未填写」，而不是显示一个空的时间戳。
    expect(html).toContain('未填写')
  })

  test('escapes a note, because a textarea is not a safe place either', () => {
    // 备注是操作者写的，这不等于可信：它经 JSON 路由回来、躺在一个本机任何进程
    // 都能写的文件里，再被渲染进一张握着 admin token 的页面。
    const html = renderServers(
      model({
        cards: serverCards(NODE_SERVERS, [
          { server: 'p11', note: ATTACKS.script, updatedAt: NOW },
          { server: '203.0.113.7', note: ATTACKS.textarea, updatedAt: NOW },
        ]),
      }),
    )
    expectInert(html)
    expect(html).not.toContain('</textarea><img')
    expect(html).toContain('&lt;script&gt;')
  })

  test('gives admin a save button and view a read-only box', () => {
    const admin = renderServers(model())
    expect(admin).toContain('data-action="server-note"')
    expect(admin).toContain('data-server="p11"')
    expect(admin).not.toContain('readonly')

    const view = renderServers(model({ editable: false }))
    expect(view).not.toContain('data-action="server-note"')
    expect(view).toContain('readonly')
    // 框留着而不是消失：一个不见的框会让「你不能改」和「这里没有备注」长得一样。
    expect(view).toContain('<textarea')
    expect(view).toContain('只读令牌不能改备注')
  })

  test('disables the box and says why when there is no note store', () => {
    const html = renderServers(model({ notesEnabled: false, editable: false }))
    expect(html).toContain('<textarea')
    expect(html).toContain(' disabled>')
    expect(html).toContain('未配置备注存储 · 备注不会保存')
    expect(html).not.toContain('data-action="server-note"')
  })

  test('keeps the machines on screen when the notes could not be read', () => {
    // 机器来自启动参数，仍然是真的；读不到的只有备注。
    const html = renderServers(
      model({ failure: { code: 'unreachable', message: '备注文件读不到' } }),
    )
    expect(html).toContain('备注不可达 · 备注文件读不到')
    expect(html).toContain('>p11<')
  })

  test('caps what the box will accept at the same number the route does', () => {
    // 两个数字漂开的症状是：页面收下了，路由 400 了。
    expect(renderServers(model())).toContain(
      `maxlength="${MAX_SERVER_NOTE_LENGTH}"`,
    )
  })

  test('names the missing flag rather than showing an empty section', () => {
    const html = renderServers(model({ cards: [] }))
    expect(html).toContain('--node-server')
  })
})

describe('lease bar', () => {
  function barOf(over: Partial<ConsoleAgent>): string {
    const html = renderRoster([agent(over)], null, NOW, TTL)
    const start = html.indexOf('<span class="lease"')
    expect(start).toBeGreaterThan(-1)
    return html.slice(start, html.indexOf('</summary>', start))
  }

  test('a fresh heartbeat is a nearly full sage bar and the time it has left', () => {
    // 10s of a 300s lease: 97% of the lease is still there. The fill is the
    // *remaining* share — a 3% bar beside the words 剩余 4m50s is two facts
    // that look like they disagree.
    const cell = barOf({})
    expect(cell).toContain('<span class="lease-fill" style="width:97%">')
    expect(cell).not.toContain('lease-stale')
    expect(cell).not.toContain('lease-dead')
    expect(cell).toContain('>剩余 4m50s<')
  })

  test('past the halfway mark the bar turns amber', () => {
    const cell = barOf({
      lastHeartbeatAt: NOW - TTL / 2,
      expiresAt: NOW + TTL / 2,
    })
    expect(cell).toContain('lease-fill lease-stale')
    expect(cell).toContain('style="width:50%"')
    expect(cell).toContain('>剩余 2m30s<')
  })

  test('an expired lease is locked at full width, never past it', () => {
    // Three times the TTL: the bar is full, not 300% wide, and the remaining
    // time is zero rather than a negative countdown.
    const cell = barOf({
      lastHeartbeatAt: NOW - TTL * 3,
      expiresAt: NOW - TTL * 2,
    })
    expect(cell).toContain('lease-fill lease-dead')
    // Drained, not overfull: a node 3x past its TTL has nothing left, and the
    // empty track is the same shape every other empty lease has.
    expect(cell).toContain('style="width:0%"')
    // The word, not a zero countdown: 0s next to a full bar reads as a lease
    // that is about to lapse rather than one that already has.
    expect(cell).toContain('>租约已过期<')
    expect(cell).not.toContain('>-')
    expect(cell).not.toContain('width:-200%')
  })

  test('the bar and the status word can never disagree', () => {
    // A lapsed registry record with a fresh heartbeat: the registry's verdict
    // decides whether messages route, so both halves say expired.
    const html = renderRoster(
      [agent({ lastHeartbeatAt: NOW - 1_000, expiresAt: NOW - 1 })],
      null,
      NOW,
      TTL,
    )
    expect(html).toContain('data-health="expired"')
    expect(html).toContain('lease-fill lease-dead')
  })

  test('no scale to draw against means no bar at all', () => {
    // No lease on the record and no fallback: nothing to draw against.
    const html = renderRoster([agent({ expiresAt: 0 })], null, NOW, 0)
    expect(html).not.toContain('lease-fill')
    expect(html).toContain('<span class="lease"><span class="absent">')
  })

  test('the compact duration lines up digit for digit', () => {
    expect(formatShortDuration(290_000)).toBe('4m50s')
    expect(formatShortDuration(150_000)).toBe('2m30s')
    expect(formatShortDuration(59_000)).toBe('59s')
    expect(formatShortDuration(60_000)).toBe('1m')
    expect(formatShortDuration(3_600_000 + 120_000)).toBe('1h02m')
    expect(formatShortDuration(25 * 3_600_000)).toBe('1d1h')
    expect(formatShortDuration(-1)).toBe('0s')
  })
})

// ---------------------------------------------------------------------------

describe('renderAudit', () => {
  test('a broken chain is stated on the rail, in --dead, before anything', () => {
    const html = renderAudit(
      page({ intact: false, issueCount: 3 }),
      null,
      NO_FILTER,
    )
    expect(html).toContain('<span class="tone-bad">断裂 3</span>')
    expect(html).toContain('审计链断裂')
    expect(html).toContain('role="alert"')
    // The rail opens the fragment, so the number is above the form and the
    // table even with the script disabled.
    expect(html.indexOf('断裂 3')).toBeLessThan(html.indexOf('audit-filter'))
    expect(html.indexOf('audit-rail')).toBeLessThan(
      html.indexOf('audit-results'),
    )
    // …and there is no full-bleed banner left to dock at the top of the page.
    expect(html).not.toContain('integrity-alert')
    expect(html).not.toContain('alert-dock')
  })

  test('the alert is one line: the fact and the number', () => {
    const html = renderAudit(page({ intact: false, issueCount: 1 }), null, {})
    const start = html.indexOf('<p class="bar bar-bad" id="audit-integrity"')
    expect(start).toBeGreaterThan(-1)
    const strip = html.slice(start, html.indexOf('</p>', start))
    const text = strip.replace(/<[^>]*>/g, '')
    expect(text).toBe('审计链断裂 · 1 处')
    // No explanation on screen. A strip long enough to read is a strip long
    // enough to scan past, which defeats the only thing it is for.
    expect(text.length).toBeLessThan(16)
  })

  test('an intact trail renders no alert at all', () => {
    const html = renderAudit(page(), null, NO_FILTER)
    expect(html).not.toContain('audit-integrity')
    expect(html).toContain('<span class="tone-ok">完整</span>')
  })

  test('an intact trail without configured anchors is explicitly unwitnessed', () => {
    const html = renderAudit(page({ witness: undefined }), null, NO_FILTER)
    expect(html).toContain('<span class="tone-muted">未见证</span>')
    expect(html).not.toContain('<span class="tone-ok">完整</span>')
    expect(html).not.toContain('audit-integrity')
  })

  test('a self-consistent chain with a mismatching anchor is never shown complete', () => {
    const html = renderAudit(
      page({ witness: { tampered: true, stale: false } }),
      null,
      NO_FILTER,
    )
    expect(html).toContain('<span class="tone-critical">锚点不符</span>')
    expect(html).toContain('class="bar bar-critical"')
    expect(html).not.toContain('<span class="tone-ok">完整</span>')
  })

  test('a mirror that has not caught up with the witness reads 未覆盖, neutral', () => {
    const html = renderAudit(
      page({ witness: { tampered: false, stale: false, uncovered: true } }),
      null,
      NO_FILTER,
    )
    expect(html).toContain('<span class="tone-muted">未覆盖</span>')
    expect(html).not.toContain('锚点不符')
    expect(html).not.toContain('<span class="tone-ok">完整</span>')
    expect(html).not.toContain('audit-integrity')
    expect(html).toContain('data-witness="uncovered"')
  })

  test('the rail states the trail size and only names what is hidden', () => {
    const unfiltered = renderAudit(page(), null, NO_FILTER)
    expect(unfiltered).toContain('<span class="total">1</span>')
    expect(unfiltered).not.toContain('显示 1')

    const filtered = renderAudit(page({ total: 512 }), null, NO_FILTER)
    expect(filtered).toContain('<span class="total">512</span>')
    expect(filtered).toContain('显示 1')
  })

  test('the filter form offers all thirteen sources plus 全部', () => {
    const html = renderAudit(page(), null, NO_FILTER)
    for (const source of Object.values(AuditSource)) {
      expect(html).toContain(`value="${source}"`)
    }
    expect(Object.values(AuditSource)).toHaveLength(13)
    expect(html).toContain('全部')
  })

  test('the filter form is prefilled and every value is escaped', () => {
    const html = renderAudit(page(), null, {
      traceId: ATTACKS.handler,
      taskId: ATTACKS.singleQuote,
      agent: ATTACKS.script,
      outcome: 'refused',
      source: AuditSource.Transport,
      limit: 50,
    })
    expectInert(html)
    expect(html).toContain('value="50"')
    expect(html).toContain(`value="${AuditSource.Transport}" selected`)
    // 结果 is a segmented radio group now, not a <select>: the value is the
    // same string on the wire, the control is one click instead of two.
    expect(html).toContain('value="refused" checked')
    expect(html).toContain('<div class="seg">')
  })

  test('two filters stay out and the other five fold away', () => {
    const html = renderAudit(page(), null, NO_FILTER)
    // The pair an operator actually reaches for.
    expect(html).toContain('name="outcome"')
    expect(html).toContain('name="window"')
    // …and a native disclosure holding the rest, so it opens with no script.
    expect(html).toContain('<details class="adv">')
    for (const name of ['source', 'agent', 'traceId', 'taskId', 'limit']) {
      const at = html.indexOf(`name="${name}"`)
      expect(at).toBeGreaterThan(html.indexOf('<details class="adv">'))
    }
    // The label states the default and the ceiling rather than leaving an
    // empty box to guess at, and the ceiling is the one the server enforces.
    expect(html).toContain('条数 · 默认 200 · 上限 500')
    expect(html).toContain('max="500"')
  })

  test('the time window is submitted as a name, not as an instant', () => {
    // A radio cannot compute now - 24h, and this form has to work with script
    // disabled — so the segment submits `window=24h` and the server resolves
    // it. `1h`/`24h`/`7d`/自定义, and 自定义 is the empty value.
    const html = renderAudit(page(), null, { window: '24h' })
    expect(html).toContain('name="window" value="24h" checked')
    expect(html).toContain('name="window" value="1h"')
    expect(html).toContain('name="window" value="7d"')
    expect(html).toContain('name="window" value=""')
  })

  test('a node picker replaces the retype-the-address box when there is a roster', () => {
    const withRoster = renderAudit(
      page(),
      null,
      NO_FILTER,
      '<option value="qianmo://node-a/one">qianmo://node-a/one</option>',
    )
    expect(withRoster).toContain('<select class="input" id="f-agent"')
    expect(withRoster).toContain('qianmo://node-a/one')

    // …and falls back honestly when the caller had no roster to hand.
    const alone = renderAudit(page(), null, NO_FILTER)
    expect(alone).toContain('<input class="input" type="text" id="f-agent"')
  })

  test('the filter form lives outside the polled region', () => {
    const html = renderAudit(page(), null, NO_FILTER)
    // If the form were inside #audit-results the five-second poller would
    // replace it mid-keystroke.
    const formAt = html.indexOf('id="audit-filter"')
    const resultsAt = html.indexOf('id="audit-results"')
    expect(formAt).toBeGreaterThan(-1)
    expect(formAt).toBeLessThan(resultsAt)
  })

  test('hostile kind, code and detail are all neutralised', () => {
    const html = renderAudit(
      page({
        records: [
          record({
            kind: ATTACKS.script,
            code: ATTACKS.handler,
            node: ATTACKS.textarea,
            peer: ATTACKS.closeTag,
            traceId: ATTACKS.singleQuote,
            detail: { [ATTACKS.backtick]: ATTACKS.script, count: 3 },
          }),
        ],
      }),
      null,
      NO_FILTER,
    )
    expectInert(html)
    expect(html).toContain('count=')
  })

  test('refused and dropped rows are marked for the eye, not filtered out', () => {
    const html = renderAudit(
      page({
        records: [
          record({ seq: 1, outcome: 'ok' }),
          record({ seq: 2, outcome: 'refused', code: 'E_RATE_LIMITED' }),
          record({ seq: 3, outcome: 'dropped' }),
        ],
        total: 3,
      }),
      null,
      NO_FILTER,
    )
    expect(html).toContain(`data-outcome="refused"`)
    expect(html).toContain(`data-outcome="dropped"`)
    expect(html).toContain('E_RATE_LIMITED')
    expect(html).toContain('拒绝')
    expect(html).toContain('丢弃')
  })

  test('a trace cell is clickable and carries the full segment', () => {
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736'
    const html = renderAudit(
      page({
        records: [record({ traceId: `00-${trace}-00f067aa0ba902b7-01` })],
      }),
      null,
      NO_FILTER,
    )
    expect(html).toContain(`data-trace="${trace}"`)
    expect(html).toContain('data-action="chain"')
    // Only eight characters on screen; the rest is in the attribute.
    expect(html).toContain('>4bf92f35…<')
  })

  test('an empty result set names the next action, not the absence', () => {
    const html = renderAudit(page({ records: [], total: 40 }), null, NO_FILTER)
    expect(html).toContain('这条链还没有记录')
    expect(html).toContain('去唤醒一个智能体')
    expect(html).toContain('href="#wake-section"')
    expect(html).not.toContain('<table')
    expect(html).toContain('<span class="total">40</span>')
    expect(html).toContain('显示 0')
    // The legend repeats the filter that produced the emptiness: the
    // commonest cause of an empty trail is a filter somebody forgot.
    expect(html).toContain('当前筛选 · 结果 全部')
  })

  test('a chain that exists and is empty is intact, and says so', () => {
    // A node that has done no protocol work yet. Normal, and a page that
    // reported it as a finding would be noise, not monitoring.
    const html = renderAudit(
      page({ records: [], total: 0, chain: 'empty' }),
      null,
      NO_FILTER,
    )
    expect(html).toContain('这条链还没有记录')
    expect(html).toContain('<span class="tone-ok">完整</span>')
    expect(html).not.toContain('未建立')
    expect(html).not.toContain('audit-integrity')
  })

  test('a chain that is not there is never reported as complete', () => {
    const html = renderAudit(
      page({ records: [], total: 0, chain: 'absent', intact: false }),
      null,
      NO_FILTER,
    )
    // The state, on the rail…
    expect(html).toContain('<span class="tone-warn">未建立</span>')
    expect(html).not.toContain('<span class="tone-ok">完整</span>')
    // …spelled out once in the results…
    expect(html).toContain('审计链未建立')
    expect(html).toContain('这个来源还没有链文件')
    // …and never mistaken for a broken chain: nothing was found wrong, there
    // was nothing to look at.
    expect(html).not.toContain('审计链断裂')
    expect(html).not.toContain('断裂 0')
    // No invitation either: nothing this page offers makes a file appear.
    expect(html).not.toContain('去唤醒一个智能体')
    expect(html).not.toContain('这条链还没有记录')
  })

  test('the overview card reads absent off the rail, not off intact', () => {
    const html = renderAudit(
      page({ records: [], total: 0, chain: 'absent', intact: false }),
      null,
      NO_FILTER,
    )
    expect(html).toContain('data-audit-state="absent"')
  })

  test('an empty result under a narrow window offers the next one out', () => {
    const html = renderAudit(page({ records: [], total: 9 }), null, {
      window: '1h',
    })
    expect(html).toContain('把时间放宽一档')
    expect(html).toContain('href="?window=24h"')

    // Nothing to widen to at the far end, so no button that does nothing.
    const widest = renderAudit(page({ records: [], total: 9 }), null, {
      window: '7d',
    })
    expect(widest).not.toContain('把时间放宽一档')
  })

  test('a failure renders a bar and does not throw', () => {
    let html = ''
    expect(() => {
      html = renderAudit(null, { code: 'not_found', message: '找不到日志' }, {})
    }).not.toThrow()
    expect(html).toContain('bar-bad')
    expect(html).toContain('找不到日志')
    expect(html).toContain('not_found')
  })

  test('null page with no failure is a neutral state, not an error', () => {
    const html = renderAudit(null, null, NO_FILTER)
    expect(html).toContain('未读取审计日志')
    expect(html).not.toContain('bar-bad')
  })
})

describe('renderAuditSources', () => {
  test('keeps node DOM scope, integrity, and explicit mirror labels separate', () => {
    const html = renderAuditSources(
      [
        {
          node: 'beta-1',
          kind: 'authoritative',
          page: page({ records: [record({ traceId: 'shared' })] }),
          failure: null,
        },
        {
          node: 'beta-2',
          kind: 'mirror',
          maxLagMinutes: 5,
          page: page({
            records: [record({ traceId: 'shared' })],
            intact: false,
            issueCount: 1,
          }),
          failure: null,
        },
      ],
      NO_FILTER,
    )
    expect(html).toContain('data-audit-node="beta-1"')
    expect(html).toContain('data-audit-node="beta-2"')
    expect(html).toContain('权威链')
    expect(html).toContain('镜像 · 滞后 ≤ 5 分钟')
    expect(html).toContain('id="audit-integrity-beta-2"')
    expect(html).toContain('data-trace="shared" data-audit-node="beta-1"')
    expect(html).toContain('data-trace="shared" data-audit-node="beta-2"')
  })

  test('shows a missing source as its own empty state', () => {
    const html = renderAuditSources(
      [
        {
          node: 'beta-1',
          kind: 'authoritative',
          page: page(),
          failure: null,
        },
        {
          node: 'beta-2',
          kind: 'mirror',
          maxLagMinutes: 5,
          page: page({ records: [], total: 0 }),
          failure: null,
        },
      ],
      NO_FILTER,
    )
    expect(html).toContain('data-audit-node="beta-2"')
    expect(html).toContain('这条链还没有记录')
  })

  test('keeps a readable source intact when another source cannot be read', () => {
    const html = renderAuditSources(
      [
        {
          node: 'beta-1',
          kind: 'authoritative',
          page: page(),
          failure: null,
        },
        {
          node: 'beta-2',
          kind: 'authoritative',
          page: null,
          failure: { code: 'unreachable', message: '读取失败' },
        },
      ],
      NO_FILTER,
    )
    expect(html).toContain('data-audit-state="unavailable"')
    expect(html).toContain('<span class="tone-muted">部分未读取</span>')
    expect(html).toContain('data-audit-node="beta-1"')
    expect(html).toContain('<span class="tone-ok">完整</span>')
    expect(html).toContain('data-audit-node="beta-2"')
    expect(html).toContain('读取失败')
  })

  test('keeps the witness mismatch scoped to its source while the aggregate stays critical', () => {
    const html = renderAuditSources(
      [
        {
          node: 'beta-1',
          kind: 'authoritative',
          page: page(),
          failure: null,
        },
        {
          node: 'beta-2',
          kind: 'authoritative',
          page: page({ witness: { tampered: true, stale: false } }),
          failure: null,
        },
      ],
      NO_FILTER,
    )
    expect(html).toContain('data-audit-state="tampered"')
    expect(html).toContain('<span class="tone-critical">锚点不符</span>')
    expect(html).toContain('id="audit-integrity-beta-2"')
    expect(html).toContain('<span class="tone-ok">完整</span>')
  })
})

// ---------------------------------------------------------------------------

describe('renderChain', () => {
  const chain: MessageChain = {
    traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    records: [
      record({ seq: 1, source: AuditSource.Transport, kind: 'sent' }),
      record({
        seq: 2,
        source: AuditSource.Router,
        kind: 'rate_limited',
        outcome: 'refused',
        code: 'E_RATE_LIMITED',
      }),
      record({
        seq: 3,
        source: AuditSource.Transport,
        kind: 'dedup',
        outcome: 'dropped',
      }),
    ],
    taskIds: ['task-000000000001'],
    msgIds: ['msg-aaaaaaaaaaaa', 'msg-bbbbbbbbbbbb'],
    sources: [AuditSource.Transport, AuditSource.Router],
    refused: 1,
    dropped: 1,
    firstAt: NOW - 90_000,
    lastAt: NOW,
  }

  test('a missing chain explains itself and offers a way out', () => {
    const html = renderChain(null)
    expect(html).toContain('未找到该 trace')
    expect(html).toContain('data-action="chain-close"')
  })

  test('it is a path of hops, not a second table', () => {
    const html = renderChain(chain)
    expect(html).not.toContain('<table')
    expect(html).not.toContain('<tr')
    expect(html).toContain('<ol class="hops">')
    // Each hop is where it happened, what was attempted, how it ended.
    expect(html).toContain('<li class="hop" data-outcome="ok" data-seq="1">')
    expect(html).toContain('<span class="hop-kind mono">sent</span>')
    expect(html).toContain('<span class="hop-line"></span>')
    expect(html.match(/class="hop"/g)).toHaveLength(3)
  })

  test('the three outcomes get three different marks', () => {
    const html = renderChain(chain)
    // 通过 = filled dot, 拒绝 = hollow square, 丢弃 = dashed segment. Drawn
    // with boxes and hairlines: no icon font, no pictograph, no SVG.
    expect(html).toContain('hop-mark mark-ok')
    expect(html).toContain('hop-mark mark-refused')
    expect(html).toContain('hop-mark mark-dropped')
    expect(html).toContain('data-outcome="refused"')
    expect(html).toContain('data-outcome="dropped"')
    // The mark is not the only channel: each one names its outcome for a
    // screen reader and for a hover.
    expect(html).toContain('title="拒绝"')
    expect(html).toContain('<span class="sr-only">丢弃</span>')
  })

  test('a refusal keeps its code on the hop that caused it', () => {
    const html = renderChain(chain)
    expect(html).toContain('<span class="hop-code mono">E_RATE_LIMITED</span>')
  })

  test('records keep the order they arrived in — seq order, not clock order', () => {
    const html = renderChain(chain)
    expect(html.indexOf('data-seq="1"')).toBeLessThan(
      html.indexOf('data-seq="2"'),
    )
    expect(html.indexOf('data-seq="2"')).toBeLessThan(
      html.indexOf('data-seq="3"'),
    )
    expect(html.indexOf('>sent<')).toBeLessThan(html.indexOf('>rate_limited<'))
  })

  test('a hop with no node names the layer that logged it', () => {
    const html = renderChain(chain)
    expect(html).toContain('<span class="hop-node mono" title="传输">传输')
    expect(html).toContain('<span class="hop-node mono" title="路由">路由')
    expect(html).not.toContain('>?<')
  })

  test('the refusal counts lead, and the foot carries trace and span', () => {
    const html = renderChain(chain)
    expect(html).toContain('3 条')
    expect(html).toContain('<span class="tone-bad">拒绝 1</span>')
    expect(html).toContain('<span class="tone-warn">丢弃 1</span>')
    const foot = html.slice(html.indexOf('<p class="chain-foot'))
    expect(foot).toContain('4bf92f35…')
    expect(foot).toContain('1 分 30 秒')
  })

  test('ids are truncated on screen and complete in the tooltip', () => {
    const html = renderChain(chain)
    expect(html).toContain('title="msg-aaaaaaaaaaaa"')
    expect(html).toContain('>msg-aaaa…<')
  })

  test('a hostile traceId cannot break out of the heading', () => {
    const html = renderChain({ ...chain, traceId: ATTACKS.script })
    expect(html).not.toContain('<script>alert')
  })

  test('a hostile node name cannot break out of a hop', () => {
    const html = renderChain({
      ...chain,
      records: [record({ node: ATTACKS.handler, peer: ATTACKS.script })],
    })
    expectInert(html)
  })
})

// ---------------------------------------------------------------------------

describe('renderLimits', () => {
  const html = renderLimits(LIMITS)

  function columnOf(id: string): string {
    const start = html.indexOf(`id="${id}"`)
    expect(start).toBeGreaterThan(-1)
    const end = html.indexOf('</section>', start)
    return html.slice(start, end)
  }

  test('both ceilings are rendered from their own package', () => {
    expect(html).toContain('@qianmo/protocol')
    expect(html).toContain('LIMITS')
    expect(html).toContain('@qianmo/router')
    expect(html).toContain('RUNTIME_RATE')
  })

  test('the two rate limits live in two columns and never merge', () => {
    const protocol = columnOf('limits-protocol')
    const runtime = columnOf('limits-runtime')

    // Each column carries its own number and its own source, and neither
    // mentions the other's. `packages/router/src/rate.ts`: the two limits are
    // structurally distinct and must not be mixed — a dashboard is a document.
    expect(protocol).toContain('600 / 分钟')
    expect(protocol).toContain('@qianmo/protocol')
    expect(protocol).not.toContain('RUNTIME_RATE')
    expect(protocol).not.toContain('@qianmo/router')

    expect(runtime).toContain('20 / 1 分')
    expect(runtime).toContain('@qianmo/router')
    expect(runtime).not.toContain('LIMITS')
    expect(runtime).not.toContain('600')
  })

  test('the counting unit is part of the key, not a deletable footnote', () => {
    // The rule in packages/router/src/rate.ts survives a redesign only if it is
    // structural. A note under the table is the first thing a redesign deletes;
    // two rows that read differently cannot be skimmed as the same row.
    expect(columnOf('limits-protocol')).toContain('速率（节点 × 节点）')
    expect(columnOf('limits-runtime')).toContain('速率（发送方 × 地址）')
  })

  test('the block is key/value only — nothing to skim past', () => {
    expect(html).not.toContain('。')
    expect(html).not.toContain('dd-note')
  })

  test('protocol ceilings are shown in the units the constants are written in', () => {
    const protocol = columnOf('limits-protocol')
    expect(protocol).toContain('256 KiB')
    expect(protocol).toContain('30 秒')
    expect(protocol).toContain('5 分')
  })

  test('the registry lease is a third thing, not folded into either column', () => {
    expect(html).toContain('id="limits-registry"')
    expect(columnOf('limits-protocol')).not.toContain('注册中心租约')
    expect(columnOf('limits-runtime')).not.toContain('注册中心租约')
  })
})

// ---------------------------------------------------------------------------

describe('renderPage', () => {
  function build(over: Partial<Parameters<typeof renderPage>[0]> = {}) {
    return renderPage({
      label: 'node-a 本机',
      now: NOW,
      role: 'admin',
      roster: renderRoster([agent()], null, NOW, TTL),
      audit: renderAudit(page(), null, NO_FILTER),
      limits: renderLimits(LIMITS),
      wakeEnabled: true,
      auditFilter: NO_FILTER,
      ...over,
    })
  }

  test('leaves the servers section out when there is no attribution', () => {
    // 一个 服务器 抬头下面空着，读起来是「这个功能坏了」而不是「没配」。
    const html = build()
    expect(html).not.toContain('id="servers-section"')
    expect(html).not.toContain('id="servers"')
    expect(html).toContain('id="nodes-section"')
  })

  test('mounts the servers section under the roster when there is', () => {
    const html = build({
      servers: renderServers({
        cards: serverCards([{ node: 'node-a', server: 'p11' }], []),
        failure: null,
        editable: true,
        notesEnabled: true,
        now: NOW,
      }),
    })
    expect(html).toContain('id="servers-section"')
    expect(html).toContain('<div id="servers">')
    // 紧跟名册，因为它回答的正是名册提出的那个问题。
    expect(html.indexOf('id="nodes-section"')).toBeLessThan(
      html.indexOf('id="servers-section"'),
    )
    expect(html.indexOf('id="servers-section"')).toBeLessThan(
      html.indexOf('id="wake-section"'),
    )
  })

  test('is a complete document that follows the system theme', () => {
    const html = build()
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<meta name="color-scheme" content="light dark">')
    expect(html).toContain('prefers-color-scheme: dark')
    expect(html).toContain('color-scheme: light dark')
    expect(html).toContain('</html>')
    expect(html).toContain('lang="zh-CN"')
  })

  test('loads nothing from anywhere — no scheme appears in the document', () => {
    const html = withoutFavicon(build())
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
    expect(html).not.toContain('//cdn')
    expect(html).not.toContain('<link')
    expect(html).not.toContain('src="')
    expect(html).not.toContain('@import')
    expect(html).not.toContain('url(')
  })

  test('the one link is a self-contained data URI, not a host', () => {
    // The favicon is the single loosening of the policy this page allows.
    // `data:` is not an origin: nothing is fetched, and no third party can put
    // anything there — which is why the assertion above still holds for
    // everything else in the document.
    const html = build()
    expect(html).toContain('<link rel="icon" href="data:image/svg+xml,')
    // Percent-encoded, so even the SVG namespace is not a live scheme in the
    // document text.
    expect(html).not.toContain('http://')
  })

  test('states the same rule in a CSP the browser enforces', () => {
    const html = build()
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain('default-src &#39;none&#39;')
    expect(html).toContain('connect-src &#39;self&#39;')
    // The favicon needs exactly this and nothing else. Every *host* directive
    // is still 'none'.
    expect(html).toContain('img-src data:')
    expect(html).toContain('font-src &#39;none&#39;')
  })

  test('inlines exactly one stylesheet and one script', () => {
    const html = build()
    expect(html.split('<style>')).toHaveLength(2)
    expect(html.split('<script>')).toHaveLength(2)
    // Nothing in the script can close the tag early.
    const script = html.slice(html.indexOf('<script>'))
    expect(script.split('</script>')).toHaveLength(2)
  })

  test('carries the three fragments and their mount points', () => {
    const html = build()
    expect(html).toContain('id="roster"')
    expect(html).toContain('id="audit"')
    expect(html).toContain('id="limits"')
    expect(html).toContain('id="chain"')
    expect(html).toContain('id="register"')
    expect(html).toContain('qianmo://node-a/reviewer')
    // The dark red banner and its dock are gone: a broken chain now reads
    // `断裂 N` on the 消息链 rail.
    expect(html).not.toContain('alert-dock')
    expect(html).not.toContain('integrity-alert')
  })

  test('every section is a stacked header over its own body', () => {
    const html = build()
    const body = html.slice(html.indexOf('<main'))
    // The 140px noun rail is gone; each section names itself in a header
    // instead, with a Latin kicker over the Chinese noun.
    expect(body).not.toContain('class="rail"')
    expect(body).not.toContain('class="rail-name"')
    expect(body).not.toContain('class="pane"><div class="rail"')
    for (const name of ['总览', '名册', '注册', '消息链', '限额', '唤醒']) {
      expect(body).toContain(name)
    }
    for (const kicker of [
      'Overview',
      'Roster',
      'Register',
      'Trail',
      'Limits',
      'Wake',
    ]) {
      expect(body).toContain(`<div class="kicker">${kicker}</div>`)
    }
    expect(body.match(/class="sec-head"/g)?.length).toBe(6)
  })

  test('the sidebar carries the brand, the label and the controls — and no clock', () => {
    const html = build()
    expect(html).toContain('阡陌 console')
    expect(html).toContain('class="brand-en"')
    expect(html).toContain('class="brand-cn"')
    expect(html).toContain('node-a 本机')
    expect(html).toContain('id="auto-refresh"')
    expect(html).toContain('id="refresh-interval"')
    expect(html).toContain('value="5000" selected')
    expect(html).toContain('id="token"')
    // The clock restated the operating system's own menu bar once a second.
    // Element and interval went together — an element-only deletion leaves a
    // timer writing into a node that is not there.
    expect(html).not.toContain('id="clock"')
    const script = html.slice(html.indexOf('<script>'))
    expect(script).not.toContain("byId('clock')")
  })

  test('the shell is a sand panel and a content column, with three nav items', () => {
    const html = build()
    expect(html).toContain('class="shell"')
    expect(html).toContain('class="side"')
    expect(html).toContain('class="main"')
    expect(html).not.toContain('class="topbar"')
    // Three places, not five anchors: the ledger, the conversation, the
    // ceilings. 总览/注册/唤醒 were jumps to things within a screen of each
    // other or of the thing they act on.
    expect(html).toContain('href="#nodes-section" aria-current="page"')
    expect(html).toContain('href="#limits-section"')
    expect(html.match(/class="nav-item"/g)).toHaveLength(2)
    expect(html).toContain('账本<span class="cnt">1 节点</span>')
    const withChat = build({ chatEnabled: true })
    expect(withChat.match(/class="nav-item"/g)).toHaveLength(3)
    expect(withChat).toContain('id="to-chat"')
  })

  test('the token box is folded away rather than parked beside the logout', () => {
    const html = build()
    // Still one click from "look at this console as the other role"; no longer
    // a password field whose everyday function is to be ignored.
    expect(html).toContain('<details class="adv">')
    const summary = html.indexOf('换令牌')
    expect(summary).toBeGreaterThan(-1)
    expect(html.indexOf('id="token"')).toBeGreaterThan(summary)
    expect(html).toContain('data-action="token-save"')
    expect(html).toContain('data-action="token-clear"')
  })

  test('an overview section leads with four stat cards, summarising numbers the ledger already shows', () => {
    const html = build()
    expect(html).toContain('id="overview"')
    expect(html).toContain('class="cards g4"')
    expect(html.match(/class="card elev-sm stat"/g)).toHaveLength(4)
    // The agent count on the card is the same total the roster header carries.
    expect(html).toContain('<div class="card-kicker">智能体</div>')
    expect(html).toContain('<div class="stat-num">1</div>')
    expect(html).toContain('在线 1')
    // An intact trail reads 链完整, not a false-precision 断裂 0.
    expect(html).toContain('<div class="card-kicker">消息链</div>')
    expect(html).toContain('<span class="tag tag-accent-2">链完整</span>')
  })

  test('a broken chain marks the overview card, matching the section header', () => {
    const html = build({
      audit: renderAudit(
        page({ intact: false, issueCount: 4 }),
        null,
        NO_FILTER,
      ),
    })
    expect(html).toContain('<span class="tag tag-accent">断裂 4</span>')
  })

  test('the overview never reads a missing chain as a complete one', () => {
    const html = build({
      audit: renderAudit(
        page({ records: [], total: 0, chain: 'absent', intact: false }),
        null,
        NO_FILTER,
      ),
    })
    expect(html).toContain('<span class="tag tag-accent">未建立</span>')
    expect(html).not.toContain('<span class="tag tag-accent-2">链完整</span>')
    // And not as a broken one either: no finding was made.
    expect(html).not.toContain('断裂 0')
  })

  test('the overview repeats the unwitnessed state instead of inferring complete', () => {
    const html = build({
      audit: renderAudit(page({ witness: undefined }), null, NO_FILTER),
    })
    expect(html).toContain('<span class="tag tag-neutral">未见证</span>')
    expect(html).not.toContain('<span class="tag tag-accent-2">链完整</span>')
  })

  test('the overview never treats a partial multi-source read as complete', () => {
    const html = build({
      audit: renderAuditSources(
        [
          {
            node: 'beta-1',
            kind: 'authoritative',
            page: page(),
            failure: null,
          },
          {
            node: 'beta-2',
            kind: 'authoritative',
            page: null,
            failure: { code: 'unreachable', message: '读取失败' },
          },
        ],
        NO_FILTER,
      ),
    })
    expect(html).toContain('<span class="tag tag-neutral">部分未读取</span>')
    expect(html).not.toContain('<span class="tag tag-accent-2">链完整</span>')
  })

  test('the overview never treats a witness mismatch as complete', () => {
    const html = build({
      audit: renderAuditSources(
        [
          {
            node: 'beta-1',
            kind: 'authoritative',
            page: page(),
            failure: null,
          },
          {
            node: 'beta-2',
            kind: 'authoritative',
            page: page({ witness: { tampered: true, stale: false } }),
            failure: null,
          },
        ],
        NO_FILTER,
      ),
    })
    expect(html).toContain('<span class="tag tag-critical">锚点不符</span>')
    expect(html).not.toContain('<span class="tag tag-accent-2">链完整</span>')
  })

  test('a lagging mirror is 未覆盖 on its card and in the overview, never 锚点不符 or 链完整', () => {
    const html = build({
      audit: renderAuditSources(
        [
          {
            node: 'beta-1',
            kind: 'authoritative',
            page: page(),
            failure: null,
          },
          {
            node: 'beta-2',
            kind: 'mirror',
            maxLagMinutes: 5,
            page: page({
              witness: { tampered: false, stale: false, uncovered: true },
            }),
            failure: null,
          },
        ],
        NO_FILTER,
      ),
    })
    expect(html).toContain('data-audit-state="uncovered"')
    expect(html).toContain('<span class="tag tag-neutral">未覆盖</span>')
    expect(html).not.toContain('锚点不符')
    expect(html).not.toContain('<span class="tag tag-accent-2">链完整</span>')
  })

  test('a mismatch elsewhere still outranks a lagging mirror', () => {
    const html = build({
      audit: renderAuditSources(
        [
          {
            node: 'beta-1',
            kind: 'authoritative',
            page: page({ witness: { tampered: true, stale: false } }),
            failure: null,
          },
          {
            node: 'beta-2',
            kind: 'mirror',
            maxLagMinutes: 5,
            page: page({
              witness: { tampered: false, stale: false, uncovered: true },
            }),
            failure: null,
          },
        ],
        NO_FILTER,
      ),
    })
    expect(html).toContain('data-audit-state="tampered"')
    expect(html).toContain('<span class="tag tag-critical">锚点不符</span>')
  })

  test('the label is escaped like any other value', () => {
    const html = build({ label: ATTACKS.handler })
    expect(html).not.toContain('" onload="')
    expect(html).toContain('&quot; onload=&quot;')
  })

  test('the register form is on the page — it is the exit criterion', () => {
    const html = build()
    expect(html).toContain('id="register-form"')
    expect(html).toContain('name="address"')
    expect(html).toContain('name="endpoint"')
    expect(html).toContain('name="capabilities"')
    expect(html).toContain('name="publicKey"')
    expect(html).toContain('name="status"')
    expect(html).toContain('>注册</button>')
  })

  test('a disabled wake face explains why and offers no button to press', () => {
    const html = build({ wakeEnabled: false })
    expect(html).toContain('QIANMO_TRANSPORT_PSK')
    expect(html).toContain('<fieldset disabled')
    expect(html).not.toContain('id="wake-form"')
    expect(html).not.toContain('>唤醒</button>')
  })

  test('an enabled wake face is a real form', () => {
    const html = build({ wakeEnabled: true })
    expect(html).toContain('id="wake-form"')
    expect(html).toContain('>唤醒</button>')
    expect(html).not.toContain('QIANMO_TRANSPORT_PSK')
  })

  test('a named wake selector keeps an unavailable node visible but disabled', () => {
    const html = build({
      wakeEnabled: true,
      wakeTargets: [
        {
          node: 'beta-1',
          url: 'ws://beta-1.example.test',
          wake: {
            async send() {
              return {
                ok: false,
                failure: {
                  code: 'unreachable',
                  message: 'not reached in a view test',
                },
              }
            },
          },
        },
        {
          node: 'beta-2',
          url: 'ws://beta-2.example.test',
          unavailableReason: 'PSK unavailable',
        },
      ],
    })
    expect(html).toContain('id="wake-node" name="node"')
    expect(html).toContain('value="beta-1"')
    expect(html).toContain('beta-1 · 已配置')
    expect(html).not.toContain('value="beta-1" disabled')
    expect(html).toContain('value="beta-2" disabled')
    expect(html).toContain('beta-2 · PSK 不可用')
    expect(html).toContain('id="wake-form"')
  })

  test('the poller replays the current filter, escaped, as a query string', () => {
    const html = build({
      auditFilter: {
        source: AuditSource.Router,
        traceId: ATTACKS.handler,
        limit: 25,
        from: NOW - 3_600_000,
      },
      audit: renderAudit(page(), null, { source: AuditSource.Router }),
    })
    expect(html).toContain('data-query="')
    expect(html).toContain('source=router')
    expect(html).toContain('limit=25')
    expect(html).toContain(`from=${NOW - 3_600_000}`)
    expect(html).not.toContain('" onload="')
  })

  test('an empty filter yields an empty query rather than a stray question mark', () => {
    const html = build()
    expect(html).toContain('data-query=""')
  })

  test('the client script never builds HTML out of a response body', () => {
    const html = build()
    const script = html.slice(html.indexOf('<script>'))
    // Error text and server messages go through textContent; the only
    // innerHTML assignments take server-rendered fragments.
    expect(script).toContain('panel.textContent =')
    expect(script).toContain('el.textContent = value')
    expect(script).not.toContain('innerHTML = message')
    expect(script).not.toContain("innerHTML = '<")
  })

  test('the token rides in a header, never in a URL or the document', () => {
    const html = build()
    const script = html.slice(html.indexOf('<script>'))
    expect(script).toContain("headers['Authorization'] = 'Bearer ' + token")
    expect(script).toContain('history.replaceState')
    // The input is never seeded from storage, so a saved token is not sitting
    // in the DOM waiting to be read out of a screenshot.
    expect(script).not.toContain('input.value = readToken')
  })
})

// ---------------------------------------------------------------------------

describe('assets', () => {
  /**
   * The stylesheet and the script are TypeScript template literals, which means
   * a stray backtick or a `\\n` written as `\n` is a real hazard: the first is a
   * compile error, the second silently emits the wrong character into shipped
   * JavaScript. Parsing the emitted script is the cheap way to catch the second
   * class before it reaches a browser.
   */
  test('the emitted client script is valid JavaScript', () => {
    expect(() => new Function(CONSOLE_CLIENT_JS)).not.toThrow()
  })

  test('the note save reports in place and never re-renders the block', () => {
    // 服务器区块是唯一一块轮询不碰的：它装着人正在打的字。保存只经 say() 写
    // textContent，不动 innerHTML，也不重取 fragment——否则半句话会被吃掉。
    expect(CONSOLE_CLIENT_JS).toContain("action === 'server-note'")
    // 视图那一侧发的就是这个 data-action，两处必须是同一个字符串。
    expect(
      renderServers({
        cards: serverCards([{ node: 'node-a', server: 'p11' }], []),
        failure: null,
        editable: true,
        notesEnabled: true,
        now: NOW,
      }),
    ).toContain('data-action="server-note"')
    expect(CONSOLE_CLIENT_JS).toContain("servers: '/v0/servers'")
    expect(CONSOLE_CLIENT_JS).toContain("sendJson('PUT', ROUTES.servers")
    const handler = CONSOLE_CLIENT_JS.slice(
      CONSOLE_CLIENT_JS.indexOf('function onServerNote'),
      CONSOLE_CLIENT_JS.indexOf('function openChain'),
    )
    // 这一段确实取到了，否则下面两条是对空串断言。
    expect(handler.length).toBeGreaterThan(200)
    expect(handler).not.toContain('innerHTML')
    expect(handler).toContain('encodeURIComponent(server)')
    // 轮询只换名册与审计两块，服务器区块不在里面。
    expect(CONSOLE_CLIENT_JS).toContain(
      'Promise.all([refreshRoster(), refreshAudit()])',
    )
  })

  test('neither asset can close its own tag or reach off-origin', () => {
    for (const asset of [CONSOLE_CSS, CONSOLE_CLIENT_JS]) {
      expect(asset).not.toContain('</script')
      expect(asset).not.toContain('</style')
      expect(asset).not.toContain('http://')
      expect(asset).not.toContain('https://')
    }
    expect(CONSOLE_CSS).not.toContain('url(')
    expect(CONSOLE_CSS).not.toContain('@import')
  })

  /**
   * Colour is spent on two things that are not facts — the primary action and
   * the focus ring — and on nothing else. What this checks is that the
   * exception is a *token*: no brand hex is hardcoded anywhere, and the focus
   * machinery resolves through `var(--color-accent)`.
   */
  test('focus rings and the primary action are driven by tokens, not a hardcoded hex', () => {
    expect(CONSOLE_CSS).not.toContain('#D77757')
    expect(CONSOLE_CSS).toContain('outline: 2px solid var(--color-accent);')
    const primary = ruleOf('.btn-primary')
    expect(primary).toContain('background: var(--color-accent)')
  })

  test('the danger action is terracotta, never a pure red, and never a resting state', () => {
    // The one irreversible action. It is the confirm button of a dialog or a
    // ghost link inside an expanded row — the plain button carries no accent
    // token at all.
    const danger = ruleOf('.btn-danger')
    expect(danger).toContain('var(--color-accent-700)')
    // There is no separate destructive hue left to reach for — the whole
    // palette is the two accents plus neutral.
    expect(CONSOLE_CSS).not.toContain('--destructive')
    expect(CONSOLE_CSS).not.toContain('--warning')

    const base = ruleOf('.btn')
    expect(base).toContain('background: transparent')
    expect(base).not.toContain('--color-accent-700')

    const row = renderRoster([agent()], null, NOW, TTL)
    expect(row).toContain('class="btn btn-ghost btn-danger"')
  })

  test('every shadow is one of the three elevation tokens', () => {
    // Organic's elevation is a token set, and the dark scheme redefines all
    // three as a hairline plus ambient darkness. A literal offset/blur here is
    // a shadow that would be invisible on the dark ground.
    for (const shadow of CONSOLE_CSS.match(/box-shadow:[^;}]*/g) ?? []) {
      expect(shadow).toMatch(/box-shadow: var\(--shadow-(sm|md|lg)\)/)
    }
    expect(CONSOLE_CSS).not.toContain('text-shadow')
    expect(CONSOLE_CSS).not.toContain('gradient')
  })

  test('the type stack is the system one — the CSP forbids fetching a face', () => {
    const body = ruleOf('body')
    expect(body).toContain('var(--font-body)')
    expect(body).not.toContain('var(--font-mono)')
    expect(body).toContain('font-variant-numeric: tabular-nums')
    // Neither of Organic's display faces carries CJK, so the interface was
    // already on the system stack; headings buy their hierarchy back with
    // weight and size instead.
    expect(CONSOLE_CSS).toContain(
      '--font-body: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;',
    )
    expect(CONSOLE_CSS).toContain('--font-heading: var(--font-body);')
    expect(CONSOLE_CSS).toContain('--font-heading-weight: 600;')
    // Mono is confined to the elements the view layer tags for exactly this
    // reason: addresses, endpoints, key fingerprints, ids, protocol codes.
    expect(ruleOf('.mono, code')).toContain('var(--font-mono)')
  })

  test('body copy is 14px and no 11px-or-smaller size is load-bearing', () => {
    // The previous sheet ran 11–13px and the roster was unreadable at arm's
    // length. Everything that carries a value is now 12.5px or more; 10–11px
    // survives only on uppercase kickers and micro-labels.
    expect(ruleOf('body')).toContain('font-size: 14px')
    expect(ruleOf('.input')).toContain('font-size: 14px')
    expect(ruleOf('.btn')).toContain('font-size: 14px')
    expect(ruleOf('.trail')).toContain('font-size: 13.5px')
  })

  test('a section kicker is a small uppercase accent label, not a headline', () => {
    const kicker = ruleOf('.kicker')
    expect(kicker).toContain('font-size: 10px')
    expect(kicker).toContain('text-transform: uppercase')
    expect(kicker).toContain('color: var(--color-accent)')
  })

  test('the shell is two columns that collapse, and wide content scrolls in its own box', () => {
    expect(ruleOf('.shell')).toContain(
      'grid-template-columns: 264px minmax(0, 1fr)',
    )
    // No --rail: the noun column it sized is gone.
    expect(CONSOLE_CSS).not.toContain('--rail')
    const narrow = CONSOLE_CSS.slice(CONSOLE_CSS.indexOf('max-width: 1000px'))
    expect(narrow).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(ruleOf('.scroll')).toContain('overflow-x: auto')
  })

  test('the lease fill is display:block, or its width is ignored outright', () => {
    // The track is blockified by its flex parent; the fill is not. Without
    // this the bar renders as an empty pill on every row.
    expect(ruleOf('.lease-fill')).toContain('display: block')
  })

  test('the only motion is a transition of at most 200ms', () => {
    for (const transition of CONSOLE_CSS.match(/transition:[^;}]*/g) ?? []) {
      if (transition.includes('none')) continue
      const durations = transition.match(/(\d+)ms/g) ?? []
      expect(durations.length).toBeGreaterThan(0)
      for (const duration of durations) {
        expect(Number(duration.replace('ms', ''))).toBeLessThanOrEqual(200)
      }
    }
    expect(CONSOLE_CSS).toContain('@media (prefers-reduced-motion: reduce)')
    expect(CONSOLE_CSS).not.toContain('@keyframes')
  })

  test('the palette is the Organic ramp set, and dark is a flip of the same names', () => {
    const dark = CONSOLE_CSS.slice(
      CONSOLE_CSS.indexOf('@media (prefers-color-scheme: dark)'),
    )
    const tokens = [
      '--color-bg',
      '--color-surface',
      '--color-text',
      '--color-accent',
      '--color-accent-2',
      '--color-divider',
      '--color-scrim',
      '--shadow-sm',
      '--shadow-md',
      '--shadow-lg',
    ]
    for (const step of [100, 200, 300, 400, 500, 600, 700, 800, 900]) {
      tokens.push(`--color-neutral-${step}`)
      tokens.push(`--color-accent-${step}`)
      tokens.push(`--color-accent-2-${step}`)
    }
    for (const token of tokens) {
      // Defined in the light block…
      expect(CONSOLE_CSS).toContain(`${token}:`)
      // …and redefined in the dark one, so no colour has a single definition
      // that only happens to look right in one scheme.
      expect(dark).toContain(`${token}:`)
    }
    expect(CONSOLE_CSS).toContain('--color-bg: #f5ead8;')
    expect(CONSOLE_CSS).toContain('--color-accent: #c67139;')
    // The ramps reverse their semantic direction, which is what lets every
    // component class ("background 100, text 800") stay byte-identical.
    expect(dark).toContain('--color-bg: #201e1d;')
    expect(dark).toContain('--color-neutral-100: #2a2723;')
    expect(dark).toContain('--color-neutral-900: #ece6da;')
    // …and the accent is lifted a step so it stays legible on the dark ground.
    // The previous sheet's dark --primary was oklch(0.424 …) on an
    // oklch(0.145 …) page, which is the defect this replaces.
    expect(dark).toContain('--color-accent: #f6a06b;')
    expect(CONSOLE_CSS).toContain('color-scheme: light dark;')
  })

  test('the scrim is its own token, because the ramp flip cannot express it', () => {
    // .dialog-backdrop used to borrow --color-neutral-900, which after the
    // flip is the *lightest* step — a backdrop that washes the screen with
    // light instead of dimming it.
    const dark = CONSOLE_CSS.slice(
      CONSOLE_CSS.indexOf('@media (prefers-color-scheme: dark)'),
    )
    expect(ruleOf('.dialog-backdrop')).toContain('var(--color-scrim)')
    expect(CONSOLE_CSS).toContain('--color-scrim: #2e2b25;')
    expect(dark).toContain('--color-scrim: #050403;')
  })
})

// ---------------------------------------------------------------------------

/**
 * Wording and restraint, as gates rather than as taste.
 *
 * These four are the ones a reviewer would otherwise have to re-check by eye
 * every time somebody adds a field. Turning them into assertions is the only
 * way a copy rule survives the third person to touch the file.
 */
describe('copy discipline', () => {
  const rendered = renderPage({
    label: 'node-a',
    now: NOW,
    role: 'admin',
    roster: renderRoster([agent()], null, NOW, TTL),
    audit: renderAudit(
      page({ intact: false, issueCount: 2, total: 9 }),
      null,
      NO_FILTER,
    ),
    limits: renderLimits(LIMITS),
    wakeEnabled: true,
    auditFilter: NO_FILTER,
  })

  /** Visible text only: markup, attributes, the inline style and script out. */
  function visibleText(html: string): string {
    return html
      .replace(/<style>[\s\S]*?<\/style>/g, '')
      .replace(/<script>[\s\S]*?<\/script>/g, '')
      .replace(/<[^>]*>/g, ' ')
  }

  test('the servers block keeps the same punctuation discipline', () => {
    const html = renderServers({
      cards: serverCards(
        [{ node: 'node-a', server: 'p11' }],
        [{ server: 'p11', note: '香港', updatedAt: NOW }],
      ),
      failure: null,
      editable: false,
      notesEnabled: false,
      now: NOW,
    })
    const text = visibleText(html)
    expect(text).not.toContain('。')
    expect(text).not.toContain('，')
    expect(text).not.toContain('！')
    // 这一块确实有可见文案可查，否则上面三条是空转。
    expect(text).toContain('服务器')
    expect(text).toContain('备注')
  })

  test('the word 花名册 is gone, along with its neighbours', () => {
    for (const banned of [
      '花名册',
      '智能体花名册',
      '常驻节点',
      '审计与消息链',
    ]) {
      expect(rendered).not.toContain(banned)
    }
  })

  test('section headings are bare nouns', () => {
    const text = visibleText(rendered)
    for (const heading of ['名册', '消息链', '限额', '唤醒']) {
      expect(text).toContain(heading)
    }
  })

  test('no explanatory sentences anywhere on the page', () => {
    // A crude but unambiguous rule: nothing on screen ends a sentence, and
    // nothing on screen joins two clauses with a comma either — the page
    // separates with `·`, which cannot carry a subordinate clause after it.
    // The two states allowed a line of their own (empty, disabled) are one
    // clause each, so they pass both halves.
    const text = visibleText(rendered)
    expect(text).not.toContain('。')
    expect(text).not.toContain('，')
    expect(text).not.toContain('、')
  })

  test('an action and its result are the same word', () => {
    // 注册 → 已注册, 注销 → 已注销, 唤醒 → 已唤醒. Nothing says 提交 or 确定,
    // which name the gesture instead of the outcome.
    for (const pair of [
      ['>注册</button>', '已注册 '],
      ['data-action="deregister"', '已注销 '],
      ['>唤醒</button>', '已唤醒 · '],
    ]) {
      expect(rendered).toContain(pair[0] as string)
      expect(rendered).toContain(pair[1] as string)
    }
    expect(visibleText(rendered)).not.toContain('提交')
    expect(visibleText(rendered)).not.toContain('确定')
  })

  test('a failure names the thing, what happened to it, then the detail', () => {
    const html = renderRoster(
      null,
      { code: 'unreachable', message: '连接被拒绝' },
      NOW,
      TTL,
    )
    expect(html).toContain('注册中心不可达 · 连接被拒绝')
    expect(html).toContain('unreachable')

    const trail = renderAudit(
      null,
      { code: 'not_found', message: '文件不存在' },
      NO_FILTER,
    )
    expect(trail).toContain('审计日志未找到 · 文件不存在')
  })

  test('the empty state is an invitation, not a status', () => {
    const empty = renderRoster([], null, NOW, TTL)
    expect(empty).toContain('还没有节点 · ')
    expect(empty).toContain('在下面注册第一个')
    expect(empty).not.toContain('暂无')
  })

  test('no emoji and no pictographs', () => {
    expect(visibleText(rendered)).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  test('the missing-chain state keeps the same restraint', () => {
    // A state added later is exactly where the rules stop being kept, so it
    // is held to all three of them rather than eyeballed once.
    const text = visibleText(
      renderAudit(
        page({ records: [], total: 0, chain: 'absent', intact: false }),
        null,
        NO_FILTER,
      ),
    )
    expect(text).toContain('审计链未建立')
    expect(text).not.toContain('。')
    expect(text).not.toContain('，')
    expect(text).not.toContain('、')
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  test('no off-origin reference of any kind', () => {
    const html = withoutFavicon(rendered)
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<iframe')
  })

  test('the disabled wake face keeps its one allowed line', () => {
    const disabled = renderPage({
      label: 'node-a',
      now: NOW,
      role: 'admin',
      roster: renderRoster([], null, NOW, TTL),
      audit: renderAudit(page(), null, NO_FILTER),
      limits: renderLimits(LIMITS),
      wakeEnabled: false,
      auditFilter: NO_FILTER,
    })
    // What is unavailable, and the exact name of the thing to go and set.
    expect(disabled).toContain('唤醒不可用 · 未设置 QIANMO_TRANSPORT_PSK')
    expect(visibleText(disabled)).not.toContain('。')
  })
})
