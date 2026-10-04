// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The certificate column — key-distribution.md §10.1, and §9.1's **S-5**.
 *
 * S-5 is the one criterion of the five whose evidence is "目视 + 一条页面用例".
 * This file is that用例: the four things §10.1 asks the page to show, plus the
 * copy discipline every string on this console is held to (`view.test.ts`'s
 * `copy discipline` block states the rules; a new column is exactly where they
 * quietly stop being followed).
 */

import { describe, expect, test } from 'bun:test'
import { renderRoster } from '../src/view/agents.js'
import {
  certificateTally,
  reissueCommand,
  renderRevocationBar,
  renderRootBars,
} from '../src/view/certificates.js'
import type {
  ConsoleAgent,
  ConsoleCaRoot,
  ConsoleCertificate,
  ConsoleRevocationList,
} from '../src/deps.js'

const NOW = 1_760_000_000_000
const TTL = 300_000
const DAY = 24 * 60 * 60 * 1000

function agent(over: Partial<ConsoleAgent> = {}): ConsoleAgent {
  return {
    address: 'qianmo://node-a/reviewer',
    endpoint: 'node-a.internal:7421',
    capabilities: [],
    status: 'online',
    registeredAt: NOW - 600_000,
    lastHeartbeatAt: NOW - 10_000,
    expiresAt: NOW + TTL - 10_000,
    ...over,
  }
}

function certificate(
  over: Partial<ConsoleCertificate> = {},
): ConsoleCertificate {
  return {
    node: 'node-a',
    status: 'valid',
    fingerprint256: 'AB:CD:EF:01:23:45',
    notAfter: NOW + 62 * DAY,
    ...over,
  }
}

const FRESH_RL: ConsoleRevocationList = {
  issuedAt: NOW - DAY,
  nextUpdate: NOW + 29 * DAY,
  revokedCount: 0,
}

function roster(
  certificates: readonly ConsoleCertificate[] | null,
  revocationList: ConsoleRevocationList | null = FRESH_RL,
  roots: readonly ConsoleCaRoot[] = [],
): string {
  return renderRoster([agent()], null, NOW, TTL, {
    snapshot: certificates === null ? null : { certificates, revocationList },
    failure: null,
    roots,
    binName: 'qm',
  })
}

function caRoot(over: Partial<ConsoleCaRoot> = {}): ConsoleCaRoot {
  return {
    subject: 'CN=qianmo-ca',
    status: 'valid',
    notAfter: NOW + 3000 * DAY,
    ...over,
  }
}

/** The root strips on a page: `[tone, visible text]`, in page order. */
function rootStrips(html: string): (readonly [string, string])[] {
  return [...html.matchAll(/<p class="bar bar-(\w+)">(CA 根 [^<]*)<\/p>/g)].map(
    match => [match[1] ?? '', match[2] ?? ''] as const,
  )
}

/** Visible text only — same extraction `view.test.ts`'s copy block uses. */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, ' ')
}

describe('the certificate column shows §10.1’s four things', () => {
  test('state, expiry and fingerprint ride on the node card', () => {
    const html = roster([certificate()])
    expect(html).toContain('data-cert-status="valid"')
    expect(html).toContain('证书 有效')
    expect(html).toContain('AB:CD:EF:01:23:45')
    expect(html).toContain('剩余 62d')
  })

  test('the fingerprint is shown whole, unlike the public key beside it', () => {
    // A truncated fingerprint cannot be compared against a runbook by eye,
    // which is the only thing it is for.
    const long = 'F1:E2:D3:C4:B5:A6:97:88:79:6A:5B:4C:3D:2E:1F:00:11:22:33:44'
    expect(roster([certificate({ fingerprint256: long })])).toContain(long)
  })

  test('the revocation list’s two clocks are in the page header', () => {
    const html = roster([certificate()])
    expect(html).toContain('吊销清单 0 条')
    expect(html).toContain('剩余 29d')
  })

  test('a stale list gets the red strip §6.4 needs it to have', () => {
    const html = roster([certificate()], {
      issuedAt: NOW - 40 * DAY,
      nextUpdate: NOW - DAY,
      revokedCount: 2,
    })
    expect(html).toContain('bar-bad')
    expect(html).toContain('已过期')
    expect(html).toContain('全网按 --trust 收敛')
  })

  test('never published and stale are two different lines', () => {
    // §6.4 gives them one fail-closed behaviour and two causes; this line is
    // the only place an operator can tell which one they are in.
    const never = renderRevocationBar(null, null, NOW)
    const stale = renderRevocationBar(
      { issuedAt: NOW - 40 * DAY, nextUpdate: NOW - DAY, revokedCount: 0 },
      null,
      NOW,
    )
    expect(never).toContain('吊销清单未发布')
    expect(stale).toContain('已过期')
    expect(never).not.toBe(stale)
  })
})

describe('the seven states stay seven', () => {
  test.each([
    ['valid', '证书 有效'],
    ['expiring', '证书 将到期'],
    ['expiring-urgent', '证书 7 天内到期'],
    ['expired', '证书 已过期'],
    ['revoked', '证书 已吊销'],
    ['absent', '证书 未发布'],
    ['bad-signature', '证书 签名不符'],
  ] as const)('%s renders its own word', (status, word) => {
    expect(roster([certificate({ status })])).toContain(word)
  })

  test('a forgery and an absence do not read the same', () => {
    // Opposite next actions: one is "this node has not been issued one", the
    // other is "somebody put something in a zero-auth registry" (§5.2 T-B).
    const forged = roster([certificate({ status: 'bad-signature' })])
    const missing = roster([certificate({ status: 'absent' })])
    expect(forged).toContain('证书 签名不符')
    expect(missing).toContain('证书 未发布')
    // `未发布` on its own also belongs to the public-key cell one row down —
    // the assertion has to name the certificate's word, not the string.
    expect(forged).not.toContain('证书 未发布')
  })
})

/**
 * §6.2: yellow under 21 days, red under 7, expired on its own. The port turns
 * the clock into a state (`certificatePort.test.ts` walks one certificate
 * through all four with a `ManualClock`); what is pinned here is that each
 * state reads as its own tier — word, colour, and the time beside it.
 */
describe('§6.2 expiry tiers on the card', () => {
  function card(status: ConsoleCertificate['status'], notAfter: number) {
    const html = roster([certificate({ status, notAfter })])
    const line = /<div class="cert note"[\s\S]*?<\/div>/.exec(html)?.[0] ?? ''
    return { html, line }
  }

  test('valid: green, with the days left', () => {
    const { line } = card('valid', NOW + 62 * DAY)
    expect(line).toContain('data-cert-status="valid"')
    expect(line).toContain('tone-ok')
    expect(line).toContain('剩余 62d')
  })

  test('under 21 days: yellow, 将到期', () => {
    const { html, line } = card('expiring', NOW + 12 * DAY)
    expect(line).toContain('data-cert-status="expiring"')
    expect(line).toContain('<span class="tone-warn">证书 将到期</span>')
    expect(line).toContain('剩余 12d')
    expect(html).toContain('qm ca issue node-a')
  })

  test('under 7 days: red, 7 天内到期', () => {
    const { html, line } = card('expiring-urgent', NOW + 5 * DAY)
    expect(line).toContain('data-cert-status="expiring-urgent"')
    expect(line).toContain('<span class="tone-critical">证书 7 天内到期</span>')
    expect(line).toContain('剩余 5d')
    expect(line).not.toContain('tone-warn')
    expect(html).toContain('qm ca issue node-a')
  })

  test('expired: red too, but its own word and the instant it ended', () => {
    const { html, line } = card('expired', NOW - DAY)
    expect(line).toContain('data-cert-status="expired"')
    expect(line).toContain('<span class="tone-critical">证书 已过期</span>')
    // Not a countdown any more: the time beside it is when it ran out.
    expect(line).toContain('到期 ')
    expect(line).not.toContain('剩余')
    expect(line).not.toContain('7 天内到期')
    expect(html).toContain('qm ca issue node-a')
  })
})

describe('§10.2: the command, never the button', () => {
  test('an expiring certificate offers a command line to copy', () => {
    const html = roster([certificate({ status: 'expiring' })])
    expect(html).toContain('qm ca issue node-a')
    // Not a form, not a button, not a route.
    expect(html).not.toContain('data-action="issue"')
    expect(html).not.toContain('<form')
  })

  test('a revoked certificate is not offered a re-issue', () => {
    // The one case where nudging would be wrong: somebody revoked that key
    // on purpose.
    expect(reissueCommand(certificate({ status: 'revoked' }), 'qm')).toBe('')
    expect(reissueCommand(certificate({ status: 'valid' }), 'qm')).toBe('')
    expect(reissueCommand(undefined, 'qm')).toBe('')
  })
})

describe('absent port removes the column rather than filling it', () => {
  test('no certificate half means no certificate markup at all', () => {
    const plain = renderRoster([agent()], null, NOW, TTL)
    expect(plain).not.toContain('data-cert-status')
    expect(plain).not.toContain('吊销清单')
    expect(plain).not.toContain('证书')
  })

  test('a node the port said nothing about gets no line either', () => {
    const html = roster([certificate({ node: 'node-z' })])
    expect(html).not.toContain('data-cert-status')
    // The header strip is still there: the revocation list is a fact about
    // the whole network, not about any one card.
    expect(html).toContain('吊销清单')
  })

  test('a failed certificate read is a strip, never an exception', () => {
    const html = renderRoster([agent()], null, NOW, TTL, {
      snapshot: null,
      failure: { code: 'unreachable', message: '连接被拒绝' },
      roots: [caRoot({ status: 'expiring-urgent', notAfter: NOW + 5 * DAY })],
      binName: 'qm',
    })
    expect(html).toContain('吊销清单未读到 · 连接被拒绝')
    // The roots are the console's own file, not a registry answer: an
    // unreachable registry does not take the root's reminder with it.
    expect(rootStrips(html)).toEqual([
      ['critical', 'CA 根 CN=qianmo-ca · 7 天内到期 · 剩余 5d'],
    ])
  })
})

/**
 * §6.2's CA-root row: the same four tiers as a node certificate, one strip
 * per root. The port turns the clock into a tier (`certificatePort.test.ts`
 * walks a root through all four with a `ManualClock`); pinned here is what
 * each tier looks like.
 */
describe('§6.2 expiry tiers for the CA root', () => {
  function strips(root: ConsoleCaRoot) {
    return rootStrips(roster([certificate()], FRESH_RL, [root]))
  }

  test('in date: a quiet strip with the time left', () => {
    expect(strips(caRoot({ notAfter: NOW + 400 * DAY }))).toEqual([
      ['muted', 'CA 根 CN=qianmo-ca · 有效 · 剩余 400d'],
    ])
  })

  test('under 21 days: yellow, 将到期', () => {
    expect(
      strips(caRoot({ status: 'expiring', notAfter: NOW + 12 * DAY })),
    ).toEqual([['warn', 'CA 根 CN=qianmo-ca · 将到期 · 剩余 12d']])
  })

  test('under 7 days: red, 7 天内到期', () => {
    expect(
      strips(caRoot({ status: 'expiring-urgent', notAfter: NOW + 5 * DAY })),
    ).toEqual([['critical', 'CA 根 CN=qianmo-ca · 7 天内到期 · 剩余 5d']])
  })

  test('expired: red, the instant it ended, and what went with it', () => {
    const [strip] = strips(caRoot({ status: 'expired', notAfter: NOW - DAY }))
    expect(strip?.[0]).toBe('critical')
    expect(strip?.[1]).toMatch(
      /^CA 根 CN=qianmo-ca · 已过期 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 所签证书一并失效$/,
    )
    expect(strip?.[1]).not.toContain('剩余')
  })

  test('two roots during an overlap: one strip each, in file order', () => {
    const html = roster([certificate()], FRESH_RL, [
      caRoot({ status: 'expiring', notAfter: NOW + 20 * DAY }),
      caRoot({ subject: 'CN=qianmo-ca-20290915', notAfter: NOW + 3650 * DAY }),
    ])
    expect(rootStrips(html)).toEqual([
      ['warn', 'CA 根 CN=qianmo-ca · 将到期 · 剩余 20d'],
      ['muted', 'CA 根 CN=qianmo-ca-20290915 · 有效 · 剩余 3650d'],
    ])
    // Under the revocation list's strip, not in place of it.
    expect(html.indexOf('吊销清单')).toBeLessThan(html.indexOf('CA 根'))
  })

  test('no roots, no strips', () => {
    expect(renderRootBars([], NOW)).toBe('')
    expect(roster([certificate()])).not.toContain('CA 根')
  })
})

describe('the column obeys the console’s copy discipline', () => {
  // One card per tier (the roster has one node, so one card per render), and
  // one root strip per tier alongside.
  const tiers = [
    ['expiring', NOW + 12 * DAY],
    ['expiring-urgent', NOW + 5 * DAY],
    ['expired', NOW - DAY],
  ] as const
  const html = tiers
    .map(([status, notAfter]) =>
      roster([certificate({ status, notAfter })], FRESH_RL, [
        caRoot({ status, notAfter }),
      ]),
    )
    .join('')

  test('all three expiry words are on the page under test', () => {
    for (const word of ['证书 将到期', '证书 7 天内到期', '证书 已过期']) {
      expect(html).toContain(word)
    }
    for (const word of ['· 将到期 ·', '· 7 天内到期 ·', '· 已过期 ']) {
      expect(html).toContain(`CA 根 CN=qianmo-ca ${word}`)
    }
  })

  test('no sentences and no comma-joined clauses', () => {
    const text = visibleText(html)
    expect(text).not.toContain('。')
    expect(text).not.toContain('，')
    expect(text).not.toContain('、')
  })

  test('no emoji and no pictographs', () => {
    expect(visibleText(html)).not.toMatch(/\p{Extended_Pictographic}/u)
  })

  test('the words are states, not explanations', () => {
    for (const banned of ['请', '建议', '可能', '注意事项']) {
      expect(visibleText(html)).not.toContain(banned)
    }
  })
})

describe('the roster header counts certificates that need a look', () => {
  test('all valid says so; anything else counts', () => {
    expect(
      certificateTally([certificate(), certificate({ node: 'node-b' })]),
    ).toContain('2 张证书有效')
    expect(
      certificateTally([
        certificate(),
        certificate({ node: 'node-b', status: 'expired' }),
      ]),
    ).toContain('1 张证书需注意')
    expect(certificateTally(null)).toBe('')
    expect(certificateTally([])).toBe('')
  })
})
