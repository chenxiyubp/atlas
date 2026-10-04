// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The certificate column — key-distribution.md §10.1, and nothing beyond it.
 *
 * ## Read-only, and structurally so
 *
 * §10.2 decided the console does **not** sign or rotate, and the argument was
 * not workload: a CA whose private key sits behind an HTTP face has given up
 * the offline root that two of §3.3's three benefits rest on, and a console
 * with no account system (`console.md` §8.1) could not attribute the signing
 * to a person anyway. So there is no button here. What there is instead is
 * §10.2's compromise: the row of a certificate that is running out shows the
 * `qm ca issue` command line for an operator to copy, and does not run it —
 * the same trade `console.md` §4.4 makes for a button that would always fail.
 *
 * ## Everything on this page is public material
 *
 * Status verdicts, `fingerprint256`, `notAfter`, the revocation list's two
 * clocks, and each CA root's subject and `notAfter`. No private key, of any of the three kinds §10.3 names, can reach
 * this file — `ConsoleCertificate` has no field one could arrive in.
 *
 * The fingerprint is shown **whole**, unlike the public-key column next to it
 * which shows a hash of its input. That is not an inconsistency: the whole
 * point of `fingerprint256` is that it is the value an operator compares
 * against the runbook by eye, and a truncated one cannot be compared.
 *
 * ## The revocation bar is the most important thing here
 *
 * §10.1 says so in as many words, and §6.4 is why: a stale revocation list
 * silently fails the whole network closed to its `--trust` entries. Without a
 * conspicuous line saying when the list expires, an operator sees only "some
 * nodes suddenly cannot connect" and has no thread to pull.
 */

import { bar, chip, tag, toned, type Tone } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatClock, formatDateTime, formatShortDuration } from './format.js'
import type {
  CertificateStatus,
  ConsoleCaRoot,
  ConsoleCertificate,
  ConsoleFailure,
  ConsoleRevocationList,
} from '../deps.js'

/**
 * One word per status, and the word is the *state*, never a sentence.
 *
 * `未发布` and `签名不符` are deliberately different words for what a coarser
 * design would call "no usable certificate": they call for opposite actions,
 * and one of them means somebody put a forgery in a registry that has no
 * authentication (§5.2).
 *
 * The three expiry words name their threshold rather than grading urgency
 * with adverbs: `将到期` is §6.2's 21-day line, `7 天内到期` its 7-day line,
 * `已过期` the point past which peers refuse the certificate.
 */
const STATUS_WORD: Readonly<Record<CertificateStatus, string>> = {
  valid: '有效',
  expiring: '将到期',
  'expiring-urgent': '7 天内到期',
  expired: '已过期',
  revoked: '已吊销',
  absent: '未发布',
  'bad-signature': '签名不符',
}

/**
 * §6.2's yellow and red. `critical` rather than `bad` for red, because the
 * stylesheet gives `bad` the same colour as `warn`; the two expiry tiers past
 * the 7-day line are the ones that must not read like the 21-day one.
 */
const STATUS_TONE: Readonly<Record<CertificateStatus, Tone>> = {
  valid: 'ok',
  expiring: 'warn',
  'expiring-urgent': 'critical',
  expired: 'critical',
  revoked: 'bad',
  absent: 'muted',
  'bad-signature': 'bad',
}

/** A certificate table keyed by node, for the roster to look rows up in. */
export function certificateIndex(
  certificates: readonly ConsoleCertificate[] | null,
): ReadonlyMap<string, ConsoleCertificate> {
  const index = new Map<string, ConsoleCertificate>()
  for (const one of certificates ?? []) index.set(one.node, one)
  return index
}

/**
 * The certificate facts for one node card: state, fingerprint, expiry.
 *
 * Returns `''` for a node the port said nothing about — a card with no line is
 * how "this deployment has no certificate story" reads, and it reads correctly.
 * A node the port *did* report as `absent` gets the word, because that is a
 * verdict rather than a silence.
 */
export function certificateLine(
  certificate: ConsoleCertificate | undefined,
  now: number,
): string {
  if (certificate === undefined) return ''
  const tone = STATUS_TONE[certificate.status]
  const parts = [
    `<span class="ct-w">${toned(tone, `证书 ${STATUS_WORD[certificate.status]}`)}</span>`,
  ]
  if (
    certificate.notAfter !== undefined &&
    Number.isFinite(certificate.notAfter)
  ) {
    const remaining = certificate.notAfter - now
    parts.push(
      remaining > 0
        ? `<span class="ct-left">剩余 ${escapeHtml(formatShortDuration(remaining))}</span>`
        : `<span class="ct-left">到期 ${escapeHtml(formatClock(certificate.notAfter))}</span>`,
    )
  }
  if (certificate.fingerprint256 !== undefined) {
    parts.push(chip(certificate.fingerprint256, certificate.fingerprint256))
  }
  return (
    `<div class="cert note" data-cert-status="${attr(certificate.status)}">` +
    parts.join('<span class="sep">·</span>') +
    `</div>`
  )
}

/**
 * §10.2's compromise, for the rows that need it: the command, not the button.
 *
 * Only for the states an issue would actually fix. Offering it next to a
 * revoked certificate would be advice to re-issue for a key somebody just
 * revoked, which is the one case where the console must not nudge.
 */
export function reissueCommand(
  certificate: ConsoleCertificate | undefined,
  binName: string,
): string {
  if (certificate === undefined) return ''
  if (
    certificate.status !== 'expiring' &&
    certificate.status !== 'expiring-urgent' &&
    certificate.status !== 'expired' &&
    certificate.status !== 'absent'
  ) {
    return ''
  }
  const command = `${binName} ca issue ${certificate.node}`
  return (
    `<code class="mono cmd" data-copy="${attr(command)}">` +
    `${escapeHtml(command)}</code>`
  )
}

/**
 * The page-header line for the revocation list (§10.1's last row).
 *
 * Three states and they are three, not two: never published, fresh, stale.
 * `null` is not "stale with an old date" — §6.4 gives them the same
 * fail-closed behaviour and completely different causes, and this line is the
 * only place an operator can tell which one they are in.
 */
export function renderRevocationBar(
  revocationList: ConsoleRevocationList | null,
  failure: ConsoleFailure | null,
  now: number,
): string {
  if (failure !== null) {
    return bar('warn', `吊销清单未读到 · ${failure.message}`)
  }
  if (revocationList === null) {
    return bar('warn', '吊销清单未发布 · 全网按 --trust 收敛')
  }
  const stale = now >= revocationList.nextUpdate
  const line =
    `吊销清单 ${revocationList.revokedCount} 条` +
    ` · 签发 ${formatClock(revocationList.issuedAt)}` +
    (stale
      ? ` · 已过期 ${formatClock(revocationList.nextUpdate)} · 全网按 --trust 收敛`
      : ` · 剩余 ${formatShortDuration(revocationList.nextUpdate - now)}`)
  return bar(stale ? 'bad' : 'muted', line)
}

/**
 * A strip is a banner, and a banner has no green: a root in date reads as the
 * quiet `muted`, the way a fresh revocation list does. The other three tiers
 * are the leaf's, colour for colour.
 */
const ROOT_TONE: Readonly<Record<ConsoleCaRoot['status'], Tone>> = {
  valid: 'muted',
  expiring: 'warn',
  'expiring-urgent': 'critical',
  expired: 'critical',
}

/**
 * One header strip per root in the trust file — §6.2's CA-root reminder.
 *
 * Every root gets its line, in date or not: during a rotation overlap the file
 * holds two, and "which one is running out" is the question. The tiers and
 * their words are the certificate column's; only the expired strip says what
 * follows from it, because that consequence — every certificate the root
 * signed stops working with it — is not visible anywhere else on the page.
 */
export function renderRootBars(
  roots: readonly ConsoleCaRoot[],
  now: number,
): string {
  return roots
    .map(root => {
      const head = `CA 根 ${root.subject} · ${STATUS_WORD[root.status]}`
      const tail =
        root.status === 'expired'
          ? ` ${formatDateTime(root.notAfter)} · 所签证书一并失效`
          : ` · 剩余 ${formatShortDuration(root.notAfter - now)}`
      return bar(ROOT_TONE[root.status], head + tail)
    })
    .join('')
}

/** The count tag for the roster header: how many nodes need a certificate look. */
export function certificateTally(
  certificates: readonly ConsoleCertificate[] | null,
): string {
  if (certificates === null || certificates.length === 0) return ''
  let attention = 0
  for (const one of certificates) {
    if (one.status !== 'valid') attention += 1
  }
  return attention === 0
    ? tag(`${certificates.length} 张证书有效`, 'ok')
    : tag(`${attention} 张证书需注意`, 'warn')
}
