// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The trail, and one reconstructed chain out of it.
 *
 * Two rules from the packages this renders carry into the markup, and both are
 * the kind of thing a tidier-looking rewrite quietly undoes:
 *
 * 1. **Refusals are the content, not the noise.** `query.ts` never filters on
 *    outcome, because a chain showing only what worked answers "what
 *    happened?" with "the parts that happened". So `refused` and `dropped` are
 *    never greyed down, and the chain states both counts first.
 * 2. **Integrity is a headline.** A broken hash chain and a mismatching
 *    off-host anchor are distinct findings, both stated on the section header
 *    and in one-line result strips. An unconfigured or stale witness never
 *    inherits the green state from an intact local chain.
 *
 * ## Two filters stay out, five fold away
 *
 * The filter bar used to be eight controls in a row, seven of which are empty
 * on every screenshot anybody has ever taken of this page. What is left in the
 * open is the pair an operator actually reaches for — the outcome and the time
 * window, both as segmented radio groups — and the rest lives behind a native
 * `<details>`.
 *
 * **The time window is a server-side concept for a reason.** The form is a
 * plain `method="get"` and has to keep working with script disabled, and a
 * radio cannot compute `now - 24h`. So the segment submits `window=24h` and
 * `parseAuditFilter` turns it into a `from`; an explicit `from`/`to` pair out
 * of the advanced panel wins over it, which is what the 自定义 segment means.
 *
 * ## The chain is a path, not a second table
 *
 * `renderChain` draws hops left to right — `node ──kind──● node` — because the
 * one question that brings somebody to a reconstructed chain is *where did it
 * stop*, and a stack of table rows answers that with reading rather than with
 * looking. The outcome is the mark at the end of each segment: a filled disc
 * for 通过, a hollow ring for 拒绝, a dashed segment for 丢弃. Flex boxes and
 * hairlines; no icon font, no pictograph.
 *
 * ## Why the filter form is outside `#audit-results`
 *
 * The poller refreshes `#audit-rail` and `#audit-results` and leaves the form
 * alone. A five-second timer that replaces the form is a five-second timer that
 * eats whatever the operator was typing into the trace box.
 */

import { AuditSource, traceIdSegment } from '@qianmo/audit'
import type { AuditRecord, MessageChain } from '@qianmo/audit'
import {
  absent,
  chevron,
  chip,
  failureBar,
  hint,
  icon,
  railSep,
  scroll,
  sectionHead,
  tag,
  toned,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatDateTime, formatDuration, toDatetimeLocal } from './format.js'
import type { AuditFilter, AuditPage, ConsoleFailure } from '../deps.js'

/** How many characters of an id are enough to tell two of them apart. */
const ID_PREFIX = 8

/** Default and ceiling for the tail size, stated in the label beside the box. */
const LIMIT_DEFAULT = 200
const LIMIT_MAX = 500

const OUTCOME_LABEL: Readonly<Record<string, string | undefined>> = {
  ok: '通过',
  refused: '拒绝',
  dropped: '丢弃',
}

const OUTCOME_TONE: Readonly<Record<string, Tone | undefined>> = {
  ok: 'ok',
  refused: 'bad',
  dropped: 'warn',
}

/**
 * The three windows the segmented control offers, widest last.
 *
 * The order is load-bearing twice over: the segment renders in it, and the
 * empty state's 把时间放宽一档 button steps one place along it.
 */
export const AUDIT_WINDOWS: readonly (readonly [string, string, number])[] = [
  ['1h', '最近 1h', 3_600_000],
  ['24h', '最近 24h', 86_400_000],
  ['7d', '最近 7d', 604_800_000],
]

/** Chinese name for each of the 12 layers; unknown values print raw. */
const SOURCE_LABEL: Readonly<Record<string, string | undefined>> = {
  transport: '传输',
  router: '路由',
  capability: '能力',
  activator: '唤醒',
  adapter: '适配',
  resident: '常驻',
  negotiation: '协商',
  tunnel: '隧道',
  backup: '备份',
  diagnosis: '诊断',
  registry: '注册',
  capacity: '容量',
}

function sourceText(source: string): string {
  return SOURCE_LABEL[source] ?? source
}

function outcomeText(outcome: string): string {
  return OUTCOME_LABEL[outcome] ?? outcome
}

function outcomeCell(outcome: string): string {
  return tag(outcomeText(outcome), OUTCOME_TONE[outcome] ?? 'muted')
}

function shortId(value: string): string {
  return value.length <= ID_PREFIX ? value : `${value.slice(0, ID_PREFIX)}…`
}

/**
 * `detail` is a free-form map written by whichever layer logged the line, so
 * both keys and values are attacker-shaped. Rendered as escaped `k=v` text.
 */
function detailLine(
  detail: Readonly<Record<string, string | number | boolean>> | undefined,
): string {
  if (detail === undefined) return ''
  const entries = Object.entries(detail)
  if (entries.length === 0) return ''
  const text = entries
    .map(
      ([key, value]) =>
        `${escapeHtml(key)}=<span class="dv">${escapeHtml(String(value))}</span>`,
    )
    .join(' · ')
  return `<div class="detail">${text}</div>`
}

/** Clickable. Full segment in `data-trace`, eight characters on screen. */
function traceCell(traceId: string | undefined, auditNode?: string): string {
  const segment = traceIdSegment(traceId)
  if (segment === null || segment === '') return absent()
  const node =
    auditNode === undefined ? '' : ` data-audit-node="${attr(auditNode)}"`
  return (
    `<button type="button" class="linkish" data-action="chain" ` +
    `data-trace="${attr(segment)}"${node} title="${attr(segment)}">` +
    `${escapeHtml(shortId(segment))}</button>`
  )
}

function partiesCell(record: AuditRecord): string {
  const node = record.node
  const peer = record.peer
  if (node === undefined && peer === undefined) return absent()
  const left = node === undefined ? '?' : node
  if (peer === undefined) return `<span class="mono">${escapeHtml(left)}</span>`
  return (
    `<span class="mono">${escapeHtml(left)}</span>` +
    `<span class="arrow">→</span>` +
    `<span class="mono">${escapeHtml(peer)}</span>`
  )
}

function recordRow(record: AuditRecord, auditNode?: string): string {
  return (
    `<tr data-outcome="${attr(record.outcome)}">` +
    `<td class="when mono">${escapeHtml(formatDateTime(record.at))}</td>` +
    `<td class="src">${escapeHtml(sourceText(record.source))}</td>` +
    `<td class="kind"><span class="mono">${escapeHtml(record.kind)}</span>` +
    `${detailLine(record.detail)}</td>` +
    `<td class="result">${outcomeCell(record.outcome)}</td>` +
    `<td>${traceCell(record.traceId, auditNode)}</td>` +
    `<td class="parties">${partiesCell(record)}</td>` +
    `<td class="mono">${
      record.code === undefined ? absent() : escapeHtml(record.code)
    }</td>` +
    `</tr>`
  )
}

const RECORD_HEADERS = ['时间', '来源', 'kind', '结果', 'trace', '节点', 'code']

function recordTable(
  records: readonly AuditRecord[],
  auditNode?: string,
): string {
  const head = RECORD_HEADERS.map(
    h => `<th scope="col">${escapeHtml(h)}</th>`,
  ).join('')
  const body = records.map(record => recordRow(record, auditNode)).join('')
  return scroll(
    `<table class="trail"><caption class="sr-only">审计记录</caption>` +
      `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
  )
}

function option(value: string, label: string, selected: string | undefined) {
  const mark = selected === value ? ' selected' : ''
  return `<option value="${attr(value)}"${mark}>${escapeHtml(label)}</option>`
}

/** A `<select>` in its chevron wrapper — the chevron is markup, not `url()`. */
function select(
  name: string,
  label: string,
  options: string,
  id: string,
): string {
  return (
    `<div class="field"><label for="${attr(id)}">${escapeHtml(label)}</label>` +
    `<span class="sel"><select class="input" id="${attr(id)}" ` +
    `name="${attr(name)}">${options}</select>${chevron()}</span></div>`
  )
}

function textField(
  name: string,
  label: string,
  value: string | undefined,
  placeholder: string,
  id: string,
): string {
  return (
    `<div class="field"><label for="${attr(id)}">${escapeHtml(label)}</label>` +
    `<input class="input" type="text" id="${attr(id)}" name="${attr(name)}" ` +
    `value="${attr(value ?? '')}" placeholder="${attr(placeholder)}" ` +
    `autocomplete="off" spellcheck="false"></div>`
  )
}

function timeField(
  name: string,
  label: string,
  at: number | undefined,
  id: string,
) {
  const value = at === undefined ? '' : toDatetimeLocal(at)
  return (
    `<div class="field"><label for="${attr(id)}">${escapeHtml(label)}</label>` +
    `<input class="input" type="datetime-local" id="${attr(id)}" ` +
    `name="${attr(name)}" value="${attr(value)}"></div>`
  )
}

/** One segmented radio group. Native radios, so the GET form still works. */
function segment(
  name: string,
  choices: readonly (readonly [string, string])[],
  current: string,
): string {
  return (
    `<div class="seg">` +
    choices
      .map(
        ([value, label]) =>
          `<label class="seg-opt"><input type="radio" name="${attr(name)}" ` +
          `value="${attr(value)}"${value === current ? ' checked' : ''}>` +
          `${escapeHtml(label)}</label>`,
      )
      .join('') +
    `</div>`
  )
}

/**
 * The filter bar. A plain `GET` form with no `action`, so it works with script
 * disabled and so the resulting URL is shareable — "here is the query that
 * shows the incident" is the most useful thing an operator can paste into a
 * ticket.
 *
 * `agents` is the roster snapshot, when the caller has one: the node filter is
 * then a picker of addresses that exist rather than a box to retype one into.
 * The standalone fragment route has no roster to hand and falls back to the
 * text box, which is why the poller deliberately never replaces this form.
 */
function filterForm(
  filter: AuditFilter,
  agentOptions: string | undefined,
): string {
  const sources = Object.values(AuditSource)
    .map(value => option(value, sourceText(value), filter.source))
    .join('')

  const outcomes: readonly (readonly [string, string])[] = [
    ['', '全部'],
    ['ok', '通过'],
    ['refused', '拒绝'],
    ['dropped', '丢弃'],
  ]
  const windows: readonly (readonly [string, string])[] = [
    ...AUDIT_WINDOWS.map(([value, label]) => [value, label] as const),
    ['', '自定义'],
  ]

  const nodeField =
    agentOptions === undefined || agentOptions === ''
      ? textField(
          'agent',
          '智能体',
          filter.agent,
          'qianmo://node/agent',
          'f-agent',
        )
      : select(
          'agent',
          '智能体 · 取自名册',
          option('', '全部', filter.agent === undefined ? '' : filter.agent) +
            agentOptions,
          'f-agent',
        )

  const advanced =
    select(
      'source',
      '来源 · 12 个可选',
      option('', '全部', filter.source === undefined ? '' : filter.source) +
        sources,
      'f-source',
    ) +
    nodeField +
    `<div class="field"><label for="f-limit">条数 · 默认 ${LIMIT_DEFAULT} · 上限 ${LIMIT_MAX}</label>` +
    `<input class="input" type="number" id="f-limit" name="limit" min="1" ` +
    `max="${LIMIT_MAX}" value="${attr(
      String(filter.limit ?? LIMIT_DEFAULT),
    )}"></div>` +
    textField(
      'traceId',
      'traceId',
      filter.traceId,
      'traceparent 或 trace 段',
      'f-trace',
    ) +
    textField('taskId', 'taskId', filter.taskId, 'task id', 'f-task') +
    timeField('from', '起 · 自定义时间用', filter.from, 'f-from') +
    timeField('to', '止 · 自定义时间用', filter.to, 'f-to') +
    `<div class="field"><span>&nbsp;</span>` +
    `<a class="btn btn-secondary" href="?">清空全部筛选</a></div>`

  return (
    `<form id="audit-filter" method="get">` +
    `<div class="rowx" style="gap:var(--space-6);align-items:flex-end">` +
    `<div class="field"><span>结果</span>` +
    segment('outcome', outcomes, filter.outcome ?? '') +
    `</div>` +
    `<div class="field"><span>时间</span>` +
    segment('window', windows, filter.window ?? '') +
    `</div>` +
    `<button type="submit" class="btn btn-primary" style="margin-left:auto">` +
    icon('refresh-cw', { small: true }) +
    `刷新</button>` +
    `</div>` +
    `<details class="adv"><summary>${chevron()}高级筛选 · 来源 智能体 trace task 条数</summary>` +
    `<div class="adv-body">${advanced}</div></details>` +
    `</form>`
  )
}

/** Echo of what is being filtered on, so the table is never ambiguous. */
function activeChips(filter: AuditFilter): string {
  const chips: string[] = []
  const push = (key: string, value: string | undefined) => {
    if (value !== undefined && value !== '') chips.push(chip(`${key} ${value}`))
  }
  push('source', filter.source)
  push('outcome', filter.outcome)
  push('window', filter.window)
  push('trace', filter.traceId)
  push('task', filter.taskId)
  push('node', filter.agent)
  if (filter.window === undefined && filter.from !== undefined) {
    push('from', formatDateTime(filter.from))
  }
  if (filter.window === undefined && filter.to !== undefined) {
    push('to', formatDateTime(filter.to))
  }
  if (chips.length === 0) return ''
  return `<p class="chips">${chips.join('')}</p>`
}

const INTEGRITY_LEAD = '审计链断裂'
const WITNESS_MISMATCH_LEAD = '锚点不符'
/**
 * A mirror that has not caught up with the witness: the anchors past the end
 * of the copy were not compared, and everything the copy does hold matched.
 * Neutral on purpose — it is the expected state of a mirror between pulls,
 * and reading it as either 锚点不符 or 完整 would be wrong in one direction.
 */
const WITNESS_UNCOVERED_LEAD = '未覆盖'
/**
 * The chain file is not there.
 *
 * Stated as a finding rather than as an empty result, and it is the one
 * distinction this section used to lose: a node with nothing to report and a
 * node whose trail never arrived both render zero records, and the second one
 * is the state in which this whole page would stay quiet through anything.
 * The words are `未建立`, not `读取失败` — nothing failed, there is simply no
 * chain here yet, and an operator's next step is to find out which end owes
 * one.
 */
const ABSENT_LEAD = '审计链未建立'

/**
 * The second statement of a broken chain: one line, at the top of the results.
 *
 * The first statement is `断裂 N` on the section header. This one exists
 * because that digit is two characters and a number, and an operator who has
 * never seen it before needs the noun spelled out once. It is a strip, not a
 * banner: the fact and the count, nothing about what a hash chain is.
 */
function integrityAlert(
  page: AuditPage | null,
  id = 'audit-integrity',
): string {
  if (page === null) return ''
  // A missing chain gets no strip. It is already stated twice — the rail says
  // 未建立 and the body leads with the noun — and `断裂 N` needs the strip only
  // because what sits under *it* is a table rather than a sentence.
  if (page.chain === 'absent') return ''
  if (!page.intact) {
    const count = Number.isFinite(page.issueCount) ? page.issueCount : 0
    return (
      `<p class="bar bar-bad" id="${attr(id)}" role="alert">` +
      `<span>${escapeHtml(INTEGRITY_LEAD)} · ` +
      `<span class="n">${escapeHtml(String(count))}</span> 处</span></p>`
    )
  }
  if (page.witness?.tampered === true) {
    return (
      `<p class="bar bar-critical" id="${attr(id)}" role="alert">` +
      `<span>${escapeHtml(WITNESS_MISMATCH_LEAD)}</span></p>`
    )
  }
  return ''
}

function integrityStatus(page: AuditPage): string {
  // Before the integrity verdict, because a file that is not there has no
  // chain to have a verdict about — and `完整` is what it used to read.
  if (page.chain === 'absent') return toned('warn', '未建立')
  if (!page.intact) {
    const issues = Number.isFinite(page.issueCount) ? page.issueCount : 0
    return toned('bad', `断裂 ${issues}`)
  }
  if (page.witness?.tampered === true) {
    return toned('critical', WITNESS_MISMATCH_LEAD)
  }
  if (page.witness === undefined || page.witness.stale) {
    return toned('muted', '未见证')
  }
  if (page.witness.uncovered === true) {
    return toned('muted', WITNESS_UNCOVERED_LEAD)
  }
  return toned('ok', '完整')
}

/**
 * No chain file at all — a different body from the empty one, on purpose.
 *
 * The empty state invites a wake, because there a wake would produce the first
 * record. Here it would not: nothing this page offers can make a file appear,
 * and offering the button anyway would send an operator to press it and
 * conclude the console is broken when the trail stays blank. So this one only
 * names the two ends that could owe the file — the node that writes it and the
 * mirror that carries it — and stops there. Which of the two it is cannot be
 * decided from this side.
 *
 * No filter legend either: a filter cannot be the cause of a missing file, and
 * repeating it here would suggest it might be.
 */
function absentState(): string {
  return (
    `<div class="empty">` +
    `<div class="stack" style="gap:var(--space-4)">` +
    `<h4 class="empty-title">${escapeHtml(ABSENT_LEAD)}</h4>` +
    `<p class="empty-note">这个来源还没有链文件 · ` +
    `节点尚未写入或镜像尚未送达</p>` +
    `</div></div>`
  )
}

/**
 * The empty state: what is true, and the two things worth doing about it.
 *
 * Not `无匹配记录`. An operator looking at a blank trail is either at the start
 * of a network's life — nothing has been sent yet — or one segment too narrow,
 * and both of those have a next action. The legend under the buttons repeats
 * the filter that produced the emptiness, because the commonest cause of an
 * empty trail is a filter somebody forgot they set.
 *
 * It is reached only when the chain file **exists**: a missing one is
 * {@link absentState}, and the whole point of separating them is that this
 * body's invitation is a lie in that case.
 */
function emptyState(filter: AuditFilter): string {
  const current = filter.window ?? ''
  const index = AUDIT_WINDOWS.findIndex(([value]) => value === current)
  const wider = index >= 0 ? AUDIT_WINDOWS[index + 1] : undefined
  const widen =
    wider === undefined
      ? ''
      : `<a class="btn btn-ghost" href="?window=${attr(wider[0])}">把时间放宽一档</a>`

  const windowLabel =
    AUDIT_WINDOWS.find(([value]) => value === current)?.[1] ?? '自定义'
  const outcomeLabel =
    filter.outcome === undefined || filter.outcome === ''
      ? '全部'
      : outcomeText(filter.outcome)

  return (
    `<div class="empty">` +
    `<div class="stack" style="gap:var(--space-4)">` +
    `<h4 class="empty-title">这条链还没有记录</h4>` +
    `<p class="empty-note">网络已经连通 · 只是还没有业务消息流过 · ` +
    `唤醒一个智能体就会在这里看到第一条投递轨迹</p>` +
    `<div class="rowx">` +
    `<a class="btn btn-primary" href="#wake-section">` +
    icon('zap', { small: true }) +
    `去唤醒一个智能体</a>${widen}</div>` +
    `<div class="legend">` +
    `<span>当前筛选 · 结果 ${escapeHtml(outcomeLabel)}</span>` +
    `<span>时间 · ${escapeHtml(windowLabel)}</span>` +
    `<span class="mono">limit ${escapeHtml(
      String(filter.limit ?? LIMIT_DEFAULT),
    )}</span></div>` +
    `</div>` +
    `<svg class="empty-art" width="220" height="220" viewBox="0 0 200 200" ` +
    `fill="none" aria-hidden="true">` +
    `<circle cx="104" cy="96" r="74" fill="var(--color-accent-2-200)"/>` +
    `<circle cx="52" cy="142" r="30" fill="var(--color-accent-200)"/>` +
    `<circle cx="152" cy="44" r="18" fill="var(--color-accent-300)"/>` +
    `<circle cx="104" cy="96" r="44" fill="var(--color-bg)"/>` +
    `<g stroke="var(--color-accent-2-700)" stroke-width="5.5" ` +
    `stroke-linecap="round" stroke-linejoin="round" fill="none">` +
    `<path d="M84 96h10l6-14 8 28 6-14h10"/></g></svg>` +
    `</div>`
  )
}

const TRAIL_HEADING_ID = 'h-trail'

/**
 * The header line: how much trail there is, how much of it is on screen, and
 * whether the hash chain still verifies.
 *
 * `显示 N` appears only when a filter is actually hiding something. Printing
 * `512 · 显示 512` every time trains the eye to skip the line that is supposed
 * to be carrying `断裂 2`.
 */
function trailHead(page: AuditPage | null): string {
  const common = { id: 'audit-rail', headingId: TRAIL_HEADING_ID }
  if (page === null) return sectionHead('Trail', '消息链', common)

  const parts = [`<span class="total">${escapeHtml(String(page.total))}</span>`]
  const shown = page.records.length
  if (shown !== page.total) parts.push(`显示 ${shown}`)
  const issues = Number.isFinite(page.issueCount) ? page.issueCount : 0
  parts.push(integrityStatus(page))
  return sectionHead('Trail', '消息链', {
    ...common,
    tail: `<div class="rowx note">${parts.join(railSep())}</div>`,
    // Echoed for the overview 消息链 stat card in page.ts.
    stats: {
      total: page.total,
      issues,
      intact: page.intact,
      witness:
        page.witness === undefined
          ? 'unwitnessed'
          : page.witness.tampered
            ? 'tampered'
            : page.witness.stale
              ? 'stale'
              : page.witness.uncovered === true
                ? 'uncovered'
                : 'verified',
      // Emitted here too, not only by the multi-source view: without it the
      // overview card falls back to reading `intact` alone and a missing
      // chain arrives there as 断裂 0 — a count of findings nobody made.
      'audit-state': auditStateOf(page),
    },
  })
}

/** Render the audit fragment: the header, then the form and the results. */
export function renderAudit(
  page: AuditPage | null,
  failure: ConsoleFailure | null,
  filter: AuditFilter,
  agentOptions?: string,
): string {
  const results: string[] = []
  if (failure !== null) results.push(failureBar(failure, '审计日志'))

  if (page === null) {
    if (failure === null) results.push(hint('未读取审计日志'))
  } else {
    results.push(integrityAlert(page))
    results.push(activeChips(filter))
    results.push(
      page.chain === 'absent'
        ? absentState()
        : page.records.length === 0
          ? emptyState(filter)
          : recordTable(page.records),
    )
  }

  return (
    trailHead(page) +
    `<div class="pane">` +
    `<div class="card elev-sm">` +
    filterForm(filter, agentOptions) +
    `<div id="audit-results">${results.join('')}</div>` +
    `</div></div>`
  )
}

/** One independently rendered source in the multi-chain console view. */
export interface AuditSourceRender {
  readonly node: string
  readonly kind: 'authoritative' | 'mirror'
  readonly maxLagMinutes?: number
  readonly page: AuditPage | null
  readonly failure: ConsoleFailure | null
}

type AggregateAuditState =
  | 'verified'
  | 'unavailable'
  | 'broken'
  | 'tampered'
  | 'absent'
  | 'stale'
  | 'unwitnessed'
  | 'uncovered'

/**
 * One page's state, in the vocabulary the stat card reads.
 *
 * `absent` comes first because a missing file has no chain, and every verdict
 * below it would be a statement about a chain that is not there — `verified`
 * most of all, which is what this used to answer.
 */
function auditStateOf(page: AuditPage): AggregateAuditState {
  if (page.chain === 'absent') return 'absent'
  if (page.chain === 'broken') return 'broken'
  if (page.witness?.tampered === true) return 'tampered'
  if (page.witness === undefined) return 'unwitnessed'
  if (page.witness.stale) return 'stale'
  if (page.witness.uncovered === true) return 'uncovered'
  return 'verified'
}

function aggregateAuditState(
  sources: readonly AuditSourceRender[],
): AggregateAuditState {
  if (sources.length === 0) return 'unavailable'
  const pages: AuditPage[] = []
  for (const source of sources) {
    if (source.page === null || source.failure !== null) return 'unavailable'
    pages.push(source.page)
  }
  if (pages.some(page => page.chain === 'broken')) return 'broken'
  if (pages.some(page => page.witness?.tampered === true)) {
    return 'tampered'
  }
  // After the two integrity findings and before the witness states: one
  // source with no file at all is worth more of an operator's attention than
  // an anchor that has gone stale, and it must never be summarised as 完整.
  if (pages.some(page => page.chain === 'absent')) return 'absent'
  if (pages.some(page => page.witness?.stale === true)) {
    return 'stale'
  }
  if (pages.some(page => page.witness === undefined)) {
    return 'unwitnessed'
  }
  // Last before 完整: every source has evidence and nothing disagrees, but at
  // least one mirror has not caught up with it yet.
  if (pages.some(page => page.witness?.uncovered === true)) {
    return 'uncovered'
  }
  return 'verified'
}

function aggregateAuditLabel(
  state: AggregateAuditState,
  issues: number,
): string {
  switch (state) {
    case 'verified':
      return toned('ok', '完整')
    case 'broken':
      return toned('bad', '断裂 ' + String(issues))
    case 'tampered':
      return toned('critical', WITNESS_MISMATCH_LEAD)
    case 'unavailable':
      return toned('muted', '部分未读取')
    case 'absent':
      return toned('warn', '未建立')
    case 'stale':
    case 'unwitnessed':
      return toned('muted', '未见证')
    case 'uncovered':
      return toned('muted', WITNESS_UNCOVERED_LEAD)
  }
}

function sourceMode(source: AuditSourceRender): string {
  if (source.kind === 'authoritative') return toned('ok', '权威链')
  return toned(
    'warn',
    '镜像 · 滞后 ≤ ' + String(source.maxLagMinutes ?? 0) + ' 分钟',
  )
}

function sourceBody(source: AuditSourceRender, filter: AuditFilter): string {
  const page = source.page
  const results: string[] = []
  if (source.failure !== null)
    results.push(failureBar(source.failure, '审计日志'))
  if (page === null) {
    if (source.failure === null) results.push(hint('未读取审计日志'))
  } else {
    results.push(integrityAlert(page, 'audit-integrity-' + source.node))
    results.push(
      page.chain === 'absent'
        ? absentState()
        : page.records.length === 0
          ? emptyState(filter)
          : recordTable(page.records, source.node),
    )
  }

  const pageStatus =
    page === null ? toned('muted', '未读取') : integrityStatus(page)
  const counts =
    page === null
      ? ''
      : '<span class="note">' +
        escapeHtml(String(page.total)) +
        ' 条 · 问题 ' +
        escapeHtml(String(page.issueCount)) +
        '</span>'
  return (
    '<article class="card elev-sm audit-source" data-audit-node="' +
    attr(source.node) +
    '">' +
    '<div class="rowx audit-source-head"><h3 class="mono">' +
    escapeHtml(source.node) +
    '</h3><span class="spacer"></span>' +
    sourceMode(source) +
    pageStatus +
    '</div><div class="audit-source-meta">' +
    counts +
    '</div>' +
    results.join('') +
    '</article>'
  )
}

/**
 * All configured audit sources on one page. Each source is read and rendered
 * independently by the HTTP layer; this function only keeps their DOM scope
 * separate while preserving the one shared filter form and poller anchors.
 */
export function renderAuditSources(
  sources: readonly AuditSourceRender[],
  filter: AuditFilter,
  agentOptions?: string,
): string {
  const readable = sources.filter(
    (source): source is AuditSourceRender & { readonly page: AuditPage } =>
      source.page !== null,
  )
  const total = readable.reduce((sum, source) => sum + source.page.total, 0)
  const issues = readable.reduce(
    (sum, source) => sum + source.page.issueCount,
    0,
  )
  const state = aggregateAuditState(sources)
  const tail =
    '<div class="rowx note"><span class="total">' +
    escapeHtml(String(total)) +
    '</span>' +
    railSep() +
    escapeHtml(String(sources.length)) +
    ' 条链' +
    railSep() +
    aggregateAuditLabel(state, issues) +
    '</div>'
  const head = sectionHead('Trail', '消息链', {
    id: 'audit-rail',
    headingId: TRAIL_HEADING_ID,
    tail,
    // Only a fully readable set with verified witnesses can claim integrity.
    stats: {
      total,
      issues,
      intact: state === 'verified',
      witness: state === 'verified' ? 'verified' : state,
      'audit-state': state,
    },
  })
  return (
    head +
    '<div class="pane"><div class="card elev-sm">' +
    filterForm(filter, agentOptions) +
    '</div><div id="audit-results" class="stack" style="gap:var(--space-3)">' +
    sources.map(source => sourceBody(source, filter)).join('') +
    '</div></div>'
  )
}

function idChips(label: string, values: readonly string[]): string {
  if (values.length === 0) return ''
  const items = values.map(value => chip(shortId(value), value)).join('')
  return (
    `<p class="chain-meta"><span class="k">${escapeHtml(label)}</span>` +
    `${items}</p>`
  )
}

/** The mark that ends a hop: what happened, drawn rather than written. */
function hopMark(outcome: string): string {
  const kind =
    outcome === 'ok'
      ? 'ok'
      : outcome === 'refused'
        ? 'refused'
        : outcome === 'dropped'
          ? 'dropped'
          : 'muted'
  return (
    `<span class="hop-mark mark-${kind}" title="${attr(
      outcomeText(outcome),
    )}"></span>` +
    `<span class="sr-only">${escapeHtml(outcomeText(outcome))}</span>`
  )
}

/**
 * One hop: where it happened, what was attempted, how it ended.
 *
 * The node name falls back to the layer that logged the line. A record without
 * `node` is not anonymous — it happened in 传输 or 路由 — and printing `?`
 * there would throw away the one thing the record does say about location.
 */
function hop(record: AuditRecord): string {
  const where = record.node ?? sourceText(record.source)
  const code =
    record.code === undefined
      ? ''
      : `<span class="hop-code mono">${escapeHtml(record.code)}</span>`
  return (
    `<li class="hop" data-outcome="${attr(record.outcome)}" ` +
    `data-seq="${attr(String(record.seq))}">` +
    `<span class="hop-node mono" title="${attr(where)}">` +
    `${escapeHtml(where)}</span>` +
    `<span class="hop-link"><span class="hop-kind mono">` +
    `${escapeHtml(record.kind)}</span><span class="hop-line"></span></span>` +
    hopMark(record.outcome) +
    code +
    `</li>`
  )
}

function chainHead(title: string): string {
  return (
    `<div class="chain-head">` +
    `<h3 class="chain-title">消息链</h3>` +
    title +
    `<span class="spacer"></span>` +
    `<button type="button" class="btn btn-ghost" data-action="chain-close">` +
    icon('x', { small: true }) +
    `关闭</button></div>`
  )
}

/**
 * One reconstructed chain, in the order `reconstructChain` handed it over.
 *
 * The order is `seq`, not `at`, and this renderer must not re-sort: two nodes'
 * clocks disagree, and a timestamp sort can put an ack above the message it
 * answers. Anything that looks out of order is a real clock skew worth seeing,
 * not a display bug worth fixing.
 */
export function renderChain(chain: MessageChain | null): string {
  if (chain === null) {
    return chainHead('') + hint('未找到该 trace')
  }

  const counts = [`${chain.records.length} 条`]
  if (chain.refused > 0) counts.push(toned('bad', `拒绝 ${chain.refused}`))
  if (chain.dropped > 0) counts.push(toned('warn', `丢弃 ${chain.dropped}`))
  const head = chainHead(
    `<span class="chain-count">${counts.join(railSep())}</span>`,
  )

  // The path. Each record is one hop; the final peer, when the last record
  // names one, closes the line so the reader can see where it was headed.
  const last = chain.records[chain.records.length - 1]
  const terminal =
    last !== undefined && last.peer !== undefined
      ? `<li class="hop"><span class="hop-node mono" title="${attr(
          last.peer,
        )}">${escapeHtml(last.peer)}</span></li>`
      : ''
  const hops = `<ol class="hops">${chain.records
    .map(hop)
    .join('')}${terminal}</ol>`

  const meta = idChips('task', chain.taskIds) + idChips('msg', chain.msgIds)

  const foot =
    `<p class="chain-foot mono">` +
    `<span title="${attr(chain.traceId)}">` +
    `${escapeHtml(shortId(chain.traceId))}</span>` +
    ` · ${escapeHtml(formatDuration(chain.lastAt - chain.firstAt))}</p>`

  return head + hops + meta + foot
}
