// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat face: a session rail, a transcript, a composer.
 *
 * ## Why it is a second page rather than a sixth section
 *
 * The ledger page is a stack of sections that scrolls as one
 * document. A conversation is the opposite shape: two panes that scroll
 * independently, a composer pinned to the bottom of one of them, and a
 * viewport that never scrolls as a whole. Bolting that onto the ledger would
 * have cost the ledger its scroll model. So `/chat` is its own document, built
 * out of the same tokens (`assets/css.ts`) and the same escape discipline
 * (`escape.ts`) — the shell is shared, the body is not.
 *
 * ## The transcript is one column, not two facing ones
 *
 * Every turn starts at the same left edge: a round avatar in a 34px track, the
 * author and the time above, the text in a soft-cornered block beside it. The
 * two authors are told apart by the block's tint — accent for the operator,
 * surface for the agent — and never by which side of the pane they sit on.
 *
 * The alignment flip is the part deliberately not taken. A transcript here is
 * full of addresses, ids and code, and a right-aligned half turns every one of
 * those into a ragged left edge to hunt for. Both facts about a turn — who said
 * it, where it starts — are worth one signal each, and the flip spends the more
 * expensive one on the fact the tint already carries.
 *
 * (An earlier revision of this page used a hairline rule and no fill at all.
 * The tint and the avatar arrived with the Organic design system; the single
 * left edge is the part that survived unchanged, and is the part that matters.)
 *
 * What sits under an operator turn is the part a bubble UI has nowhere to put:
 * the delivery pills. `已投递 · 回执 accepted · 42ms`, then `已读 1.2s` when
 * the agent takes the message into its input, then the reply. Those three are
 * distinct network events — a message can be receipted and never read, or read
 * and never answered — and a chat window that collapses them into one grey
 * tick is a chat window that cannot tell you which half is broken.
 *
 * ## Names come from the address
 *
 * A session's title is the `agent` segment of its target address, and the
 * group it sits under is that same address. Nothing here invents a display
 * name, and nothing here keeps a second copy of one: rename the agent in the
 * registry and the page renames itself.
 */

import type {
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ConsoleFailure,
} from '../deps.js'
import {
  address,
  chevron,
  failureBar,
  hint,
  icon,
  state,
  tag,
  type Tone,
} from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { renderRichText } from './richText.js'
import { formatClock, formatRelative, formatShortDuration } from './format.js'

/** How much of the last turn the session rail shows. */
const PREVIEW_LENGTH = 46

/**
 * How much of a notice's summary the line shows.
 *
 * `NotifyPayload.summary` is documented as one line for a human, but the
 * protocol gives it **no ceiling of its own** — the only bound is
 * `LIMITS.maxMessageBytes`, 256 KiB. `.notice-line` is a flex row, so a peer
 * that puts 100 KB on one line would push the timestamp off screen and take
 * the transcript column's width with it. A peer that ignores "one line" gets
 * clipped; the answer beside it is what the pane is for.
 */
const NOTICE_LENGTH = 160

/** Longest message the composer accepts, in characters. */
export const MAX_CHAT_TEXT_LENGTH = 8_000

/**
 * Ids of the two regions the poller and the stream swap.
 *
 * Not exported: they are a contract with `assets/chatClient.ts`, which is a
 * string constant in this same package rather than an importer, so an export
 * here would be a public symbol nothing can consume.
 */
const CHAT_SESSIONS_MOUNT = 'chat-sessions'
const CHAT_THREAD_MOUNT = 'chat-thread'

function truncate(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`
}

/** A value pill: a task id, a trace segment. Monospaced, never toned. */
function idTag(label: string, value: string, shown: string): string {
  return (
    `<span class="tag tag-neutral mono" title="${attr(value)}">` +
    `${escapeHtml(label)} ${escapeHtml(shown)}</span>`
  )
}

/**
 * A latency, in the unit it was actually measured in.
 *
 * {@link formatShortDuration} floors to whole seconds, so every receipt on a
 * loopback link reads `0s` — which is the one number that makes the pill
 * useless. Under a second this prints milliseconds; above it, the same compact
 * spelling the lease column uses.
 */
function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return formatShortDuration(ms)
  return ms < 1_000 ? `${Math.round(ms)}ms` : formatShortDuration(ms)
}

/** Short form of a W3C trace id, enough to find the chain on the ledger page. */
function shortTrace(traceId: string): string {
  const hex = traceId.includes('-') ? (traceId.split('-')[1] ?? '') : traceId
  return hex.slice(0, 8)
}

/**
 * The delivery chain under an operator turn.
 *
 * Three separate network events, drawn as three tags with a connecting segment
 * between them — the segment fills once the step it leads to has happened. A
 * message can be receipted and never read, or read and never answered, and a
 * chat window that collapses those into one grey tick is a chat window that
 * cannot tell you which half is broken (`console.md` §6.4). The chain shape is
 * what makes "it stopped here" a thing you see rather than a thing you read.
 */
function deliveryChain(turn: ChatTurn): string {
  const receipted = turn.receipt !== undefined
  const read = turn.readMs !== undefined
  const receiptMs =
    turn.receiptMs === undefined ? '' : ` · ${formatLatency(turn.receiptMs)}`
  const steps: readonly (readonly [string, boolean])[] = [
    ['已发出', true],
    [
      turn.state === 'pending' && !receipted
        ? '待投递'
        : `已投递 · 回执 ${turn.receipt ?? '—'}${receiptMs}`,
      receipted,
    ],
    [read ? `已读 · ${formatLatency(turn.readMs ?? 0)}` : '已读', read],
  ]
  const cells = steps.map(([text, done], index) => {
    const mark = done
      ? `<span class="tag tag-accent-2">${icon('check', {
          small: true,
        })}${escapeHtml(text)}</span>`
      : `<span class="tag tag-neutral">${escapeHtml(text)}</span>`
    const link =
      index === 0 ? '' : `<span class="lnk${done ? ' done' : ''}"></span>`
    return link + mark
  })
  return `<span class="chain">${cells.join('')}</span>`
}

/**
 * The marks under one turn, in the order the events happened.
 *
 * Every one of them is a fact the transport or the agent reported; none of
 * them is derived from another. `已投递` without `已读` is the interesting
 * case, not a rendering gap.
 */
function turnMarks(turn: ChatTurn): string {
  const marks: string[] = []
  if (turn.author === 'operator') {
    marks.push(deliveryChain(turn))
  } else if (turn.elapsedMs !== undefined) {
    marks.push(tag(`用时 ${formatLatency(turn.elapsedMs)}`))
  }
  if (turn.state === 'failed') {
    marks.push(
      tag(turn.code === undefined ? '失败' : `失败 · ${turn.code}`, 'bad'),
    )
  }
  if (turn.taskId !== undefined) {
    marks.push(idTag('task', turn.taskId, turn.taskId.slice(0, 8)))
  }
  if (turn.traceId !== undefined) {
    marks.push(idTag('链', turn.traceId, shortTrace(turn.traceId)))
  }
  return marks.length === 0
    ? ''
    : `<div class="turn-marks">${marks.join('')}</div>`
}

/**
 * The text of one turn.
 *
 * A closed subset of markdown — fences, inline code, lists, bold — rendered by
 * `richText.ts`, whose module note carries the reasoning. The short version,
 * because this is where someone will look first: **the whole string is escaped
 * before any structure is decided**, so no branch in there can emit a tag it
 * did not spell out itself. Links, images and raw HTML stay out.
 *
 * This replaced a flat「一律 `<p>`，没有 markdown」rule. That rule was right
 * about the danger and wrong about the remedy: an answer full of paths and
 * commands rendered as one grey wall is a wall nobody reads, and an operator
 * who cannot tell a command from prose eventually runs the prose.
 */
function turnText(text: string): string {
  return renderRichText(text)
}

const AUTHOR_CLASS: Readonly<Record<ChatTurn['author'], string>> = {
  operator: 'turn-operator',
  agent: 'turn-agent',
}

/**
 * The two characters inside a turn's avatar.
 *
 * The operator is 你; an agent is two characters taken from the name the
 * address already gave it. Nothing here invents an initial or a colour per
 * agent — one conversation has exactly two participants, and the avatar is a
 * position marker rather than an identity.
 *
 * A name ending in a digit keeps that digit: `beta-1` reads as `b1`, not `be`,
 * because the digit is the part that tells two agents on one node apart and the
 * letters before it are the part they share.
 */
function avatarText(who: string): string {
  if (who.length <= 2) return who
  const tail = who.slice(-1)
  if (tail >= '0' && tail <= '9') return who.slice(0, 1) + tail
  return who.slice(0, 2)
}

/**
 * A notice is a hairline row, not a bubble.
 *
 * It is the one visual rule this page borrows wholesale from a mature agent
 * surface: **flat, not boxed** — a turn-inside-a-turn is what a card would make
 * of it, and a transcript where every tool call is a card stops reading as a
 * conversation. So a notice keeps the same left edge as everything else, drops
 * the avatar to a dot, and gives up the `.bubble` fill entirely.
 *
 * Severity picks a colour and **nothing else**. It is not a filter: a notice
 * that got filtered out and a step that never happened look identical on this
 * page, and only one of those two is a thing the operator can act on.
 *
 * `detail` folds. The summary is one line by contract (protocol §14.2); the
 * detail is whatever the node had room for, and a transcript that pushes the
 * answer off screen to show a stack trace has its priorities backwards.
 */
const NOTICE_TONE: Readonly<Record<string, Tone>> = {
  info: 'muted',
  warn: 'warn',
  error: 'bad',
}

function renderNotice(turn: ChatTurn): string {
  const tone = NOTICE_TONE[turn.severity ?? 'info'] ?? 'muted'
  const detail =
    turn.detail === undefined
      ? ''
      : `<details class="notice-detail">` +
        `<summary>${chevron()}详情</summary>` +
        `<p class="notice-detail-body">${escapeHtml(turn.detail)}</p>` +
        `</details>`
  return (
    `<article class="turn turn-notice">` +
    `<span class="turn-av turn-av-notice" aria-hidden="true">` +
    `<span class="dot dot-${tone}"></span></span>` +
    `<div class="turn-body">` +
    `<div class="notice-line">` +
    `<span class="notice-text">${escapeHtml(
      truncate(turn.text, NOTICE_LENGTH),
    )}</span>` +
    `<time class="turn-when">${escapeHtml(formatClock(turn.at))}</time>` +
    `</div>` +
    detail +
    `</div></article>`
  )
}

function renderTurn(turn: ChatTurn, agent: string): string {
  if (turn.variant === 'notice') return renderNotice(turn)
  const who = turn.author === 'operator' ? '你' : agent
  const failed = turn.state === 'failed' ? ' turn-failed' : ''
  return (
    `<article class="turn ${AUTHOR_CLASS[turn.author]}${failed}">` +
    `<span class="turn-av" aria-hidden="true">${escapeHtml(
      avatarText(who),
    )}</span>` +
    `<div class="turn-body">` +
    `<header class="turn-head">` +
    `<span class="turn-who">${escapeHtml(who)}</span>` +
    `<time class="turn-when">${escapeHtml(formatClock(turn.at))}</time>` +
    `</header>` +
    `<div class="bubble">${turnText(turn.text)}</div>` +
    turnMarks(turn) +
    `</div></article>`
  )
}

/**
 * The dot beside the target in the thread header and on the composer.
 *
 * `不在名册` and `名册不可达` are deliberately two different answers. The first
 * says the registry replied and this address was not in it — somebody
 * deregistered the agent, and the next send will fail. The second says nobody
 * asked, so this page knows nothing about the target's state; the send may well
 * work. Collapsing them into one grey dot is how an operator ends up
 * restarting a node that was never down.
 */
function targetState(
  target: ChatTarget | null,
  registryDown: boolean,
): { readonly tone: Tone; readonly text: string } {
  if (registryDown) return { tone: 'muted', text: '名册不可达' }
  if (target === null) return { tone: 'muted', text: '不在名册' }
  if (!target.dialable) return { tone: 'bad', text: '端点不在允许名单' }
  if (target.status === 'online') return { tone: 'ok', text: '在线' }
  return { tone: 'warn', text: target.status }
}

/**
 * The nothing-open state.
 *
 * It keeps the sentence the previous version had — it is the string an
 * operator's eye lands on before anything else — and adds the two things that
 * turn a status into a next action: where the list of agents is, and a blob to
 * stop a 700px-tall empty pane reading as a broken page.
 */
const NOTHING_OPEN =
  `<div class="empty">` +
  `<div class="stack" style="gap:var(--space-4)">` +
  `<h4 class="empty-title">选择一个智能体开始对话</h4>` +
  `<p class="empty-note">还没有打开会话 · 在左边选一个智能体开始 · ` +
  `或者开一条新会话把任务交给别的节点</p>` +
  `</div>` +
  `<svg class="empty-art" width="200" height="200" viewBox="0 0 200 200" ` +
  `fill="none" aria-hidden="true">` +
  `<circle cx="108" cy="92" r="70" fill="var(--color-accent-200)"/>` +
  `<circle cx="54" cy="140" r="28" fill="var(--color-accent-2-200)"/>` +
  `<circle cx="150" cy="150" r="16" fill="var(--color-accent-2-300)"/>` +
  `<g stroke="var(--color-accent-800)" stroke-width="5.5" ` +
  `stroke-linecap="round" stroke-linejoin="round" fill="var(--color-bg)">` +
  `<path d="M78 68h44a10 10 0 0 1 10 10v26a10 10 0 0 1-10 10H96l-18 14V78a10 10 0 0 1 10-10z"/>` +
  `</g></svg></div>`

/**
 * The tail that says a turn is still running.
 *
 * **What makes it honest is where it reads the answer from.** It does not ask
 * a timer or a client-side flag; it reads the transcript. Operator turns stop
 * at `read` and never reach `done` — the answer is a *new* turn, not a state on
 * the old one — so "the last thing that is not a notice is the operator's, and
 * it did not fail" is exactly "nothing has answered yet".
 *
 * Notices are skipped when looking for that last turn, and skipping them is the
 * point: a turn that is producing steps is the most running a turn ever looks,
 * and a tail that vanished the moment the first tool started would disappear
 * precisely when the operator most wants it.
 *
 * The elapsed number is measured from the operator's turn against the render
 * clock. It goes up on its own only because the fragment is re-rendered — this
 * page has no ticking clock, and giving it one would mean a timer running for
 * every open tab to animate a number nobody is waiting on to the second.
 */
function runningTail(turns: readonly ChatTurn[], now: number): string {
  let last: ChatTurn | undefined
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]
    if (turn === undefined || turn.variant === 'notice') continue
    last = turn
    break
  }
  if (last === undefined) return ''
  if (last.author !== 'operator' || last.state === 'failed') return ''
  const elapsed = Math.max(0, now - last.at)
  return (
    `<div class="turn turn-tail">` +
    `<span class="turn-av turn-av-notice" aria-hidden="true">` +
    `<span class="tail-dot"></span></span>` +
    `<div class="turn-body"><div class="notice-line">` +
    `<span class="notice-text">还在跑</span>` +
    `<span class="turn-when">${escapeHtml(formatLatency(elapsed))}</span>` +
    `</div></div></div>`
  )
}

export interface ChatThreadModel {
  readonly transcript: ChatTranscript | null
  readonly failure: ConsoleFailure | null
  /** The registry's current view of this session's target, when it has one. */
  readonly target: ChatTarget | null
  /** True when the roster lookup itself failed, which is not "absent". */
  readonly registryDown?: boolean
  readonly now: number
}

/**
 * The transcript pane: a header naming the target, then the turns.
 *
 * The root carries `data-target` / `data-state` / `data-tone` because the
 * composer's chips have to show the same two facts and the composer is *not*
 * re-rendered on a poll — it holds half-typed text. The client copies those
 * attributes across with `textContent` rather than the server rendering the
 * same strings into two places that can then disagree.
 */
export function renderChatThread(model: ChatThreadModel): string {
  if (model.failure !== null) {
    return (
      `<div class="thread" id="${CHAT_THREAD_MOUNT}">` +
      failureBar(model.failure, '会话') +
      `</div>`
    )
  }
  if (model.transcript === null) {
    return (
      `<div class="thread thread-empty" id="${CHAT_THREAD_MOUNT}" ` +
      `data-target="" data-state="选一条会话" data-tone="muted">` +
      NOTHING_OPEN +
      `</div>`
    )
  }

  const { session, turns } = model.transcript
  const status = targetState(model.target, model.registryDown === true)
  const body =
    turns.length === 0
      ? hint('这条会话还没有内容 · 在下面写第一句')
      : turns.map(turn => renderTurn(turn, session.agent)).join('') +
        runningTail(turns, model.now)

  return (
    `<div class="thread" id="${CHAT_THREAD_MOUNT}" ` +
    `data-target="${attr(session.target)}" ` +
    `data-state="${attr(status.text)}" data-tone="${attr(status.tone)}" ` +
    `data-session="${attr(session.id)}">` +
    `<header class="chat-head">` +
    `<h1 class="chat-name">${escapeHtml(session.agent)}</h1>` +
    address(session.target) +
    `<div class="chat-tail">` +
    state(status.tone, status.text) +
    tag(`${session.turnCount} 轮`) +
    `</div></header>` +
    `<div class="transcript">${body}</div>` +
    `</div>`
  )
}

export interface ChatSessionsModel {
  readonly sessions: readonly ChatSession[]
  readonly targets: readonly ChatTarget[]
  readonly failure: ConsoleFailure | null
  readonly activeId: string | null
  readonly now: number
}

/** Sessions under one target, newest activity first. */
interface SessionGroup {
  readonly target: string
  readonly agent: string
  readonly node: string
  readonly sessions: readonly ChatSession[]
}

/**
 * Group by target address.
 *
 * Sorted by each group's most recent activity rather than alphabetically: the
 * rail is a list of conversations, and the one that just answered is the one
 * being looked for.
 */
function groupSessions(
  sessions: readonly ChatSession[],
): readonly SessionGroup[] {
  const byTarget = new Map<string, ChatSession[]>()
  for (const session of sessions) {
    const bucket = byTarget.get(session.target)
    if (bucket === undefined) byTarget.set(session.target, [session])
    else bucket.push(session)
  }
  const groups: SessionGroup[] = []
  for (const [target, bucket] of byTarget) {
    const ordered = [...bucket].sort((a, b) => b.updatedAt - a.updatedAt)
    const head = ordered[0]
    if (head === undefined) continue
    groups.push({
      target,
      agent: head.agent,
      node: head.node,
      sessions: ordered,
    })
  }
  return groups.sort(
    (a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0),
  )
}

function sessionItem(
  session: ChatSession,
  active: boolean,
  now: number,
): string {
  const cls = active ? 'chat-item chat-item-active' : 'chat-item'
  const preview =
    session.preview === ''
      ? '还没有内容'
      : truncate(session.preview, PREVIEW_LENGTH)
  return (
    `<button type="button" class="${cls}" data-action="chat-open" ` +
    `data-session="${attr(session.id)}"${active ? ' aria-current="true"' : ''}>` +
    `<span class="chat-item-line">${escapeHtml(preview)}</span>` +
    `<span class="chat-item-meta">${escapeHtml(
      formatRelative(session.updatedAt, now),
    )} · ${escapeHtml(String(session.turnCount))} 轮</span>` +
    `</button>`
  )
}

/**
 * The session rail.
 *
 * The target picker sits at the top rather than beside the composer: opening a
 * conversation and continuing one are different actions, and a picker next to
 * the send button is a picker somebody eventually sends into by accident.
 */
export function renderChatSessions(model: ChatSessionsModel): string {
  const options = model.targets
    .map(target => {
      const suffix = target.dialable ? '' : '（不可拨号）'
      return `<option value="${attr(target.address)}"${
        target.dialable ? '' : ' disabled'
      }>${escapeHtml(target.agent)} · ${escapeHtml(target.node)}${escapeHtml(
        suffix,
      )}</option>`
    })
    .join('')

  const picker =
    model.targets.length === 0
      ? `<p class="chat-none">注册中心里没有可聊的智能体</p>`
      : `<div class="chat-new">` +
        `<label class="sr-only" for="chat-target">目标</label>` +
        `<span class="sel"><select class="input" id="chat-target">` +
        `${options}</select>${chevron()}</span>` +
        `<button type="button" class="btn btn-primary btn-block" ` +
        `data-action="chat-new">` +
        icon('plus', { small: true }) +
        `开一条新会话</button></div>`

  const body =
    model.failure !== null
      ? failureBar(model.failure, '会话列表')
      : model.sessions.length === 0
        ? `<p class="chat-none">还没有会话</p>`
        : groupSessions(model.sessions)
            .map(
              group =>
                `<div class="chat-group">` +
                `<p class="chat-group-name">` +
                state(groupTone(model.targets, group.target), group.agent) +
                `</p>` +
                `<p class="chat-group-node mono">${escapeHtml(group.node)}</p>` +
                group.sessions
                  .map(session =>
                    sessionItem(
                      session,
                      session.id === model.activeId,
                      model.now,
                    ),
                  )
                  .join('') +
                `</div>`,
            )
            .join('')

  return (
    `<div class="chat-rail" id="${CHAT_SESSIONS_MOUNT}">${picker}` +
    `<div class="chat-groups">${body}</div></div>`
  )
}

/** The dot beside a group name, from the same verdict the thread header uses. */
function groupTone(targets: readonly ChatTarget[], value: string): Tone {
  const found = targets.find(target => target.address === value)
  return targetState(found ?? null, false).tone
}
