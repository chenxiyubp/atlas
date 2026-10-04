// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The servers section: which machine each node runs on, and what the operator
 * wrote about that machine.
 *
 * ## Why this is its own section rather than a column in the roster
 *
 * A note belongs to a *machine*, and a machine carries several nodes. Folding
 * the editor into the roster would put the same textarea on every card of a
 * group and leave the reader to work out that the three of them are one field.
 * The roster keeps the half that is per-node — the attribution line on each
 * card, rendered by `agents.ts` — and this section keeps the half that is
 * per-machine.
 *
 * ## The list comes from the startup flags, never from the page
 *
 * Every server rendered here is one the console was started with
 * (`ConsoleDeps.nodeServers`). A note whose server is not on that list is not
 * shown and cannot be written — the same allowlist discipline the wake face
 * uses, and for the same reason: an operator with an admin token must not be
 * able to grow the console's idea of the fleet by typing into it. So a note
 * left behind by an older `--node-server` line simply stops appearing; it is
 * still in the file, and it comes back if the flag comes back.
 *
 * ## The note is hostile input like everything else
 *
 * It is typed by an operator, which is not the same as being trusted: it
 * arrives back through a JSON route, sits in a file any local process can
 * write, and is rendered into a page that holds the admin token. It goes
 * through `escapeHtml` like every other value on this page — `escape.ts` has no
 * exception list, and "the admin typed it" is exactly the kind of exception
 * that turns into a stored XSS two refactors later.
 *
 * ## This section is not polled
 *
 * The five-second poller replaces the roster and the trail. It deliberately
 * leaves this section alone: the textarea holds text somebody is halfway
 * through typing, and a swap would eat it. Saving therefore updates one status
 * line through `textContent` rather than re-fetching a fragment.
 */

import { absent, bar, chip, failureBar, sectionHead } from './bits.js'
import { attr, escapeHtml } from './escape.js'
import { formatClock, formatRelative } from './format.js'
import type { ConsoleFailure, NodeServer, ServerNote } from '../deps.js'

/**
 * Longest note this console accepts.
 *
 * The same order of magnitude as `MAX_CONSOLE_LABEL_LENGTH`, and for the same
 * reason: this is a line of operator context ("香港节点 · 只跑演示"), not a
 * runbook. A ceiling also means the file cannot be grown without bound by
 * whoever holds the admin token.
 */
export const MAX_SERVER_NOTE_LENGTH = 500

export const SERVERS_HEADING_ID = 'h-servers'

/** One machine, the nodes it carries, and its note. */
export interface ServerCard {
  readonly server: string
  /** Node segments, in the order `--node-server` gave them. */
  readonly nodes: readonly string[]
  /** `null` when nobody has written one. */
  readonly note: ServerNote | null
}

export interface ServersModel {
  readonly cards: readonly ServerCard[]
  /** A failed note read. The machines still render; only the notes are missing. */
  readonly failure: ConsoleFailure | null
  /** False for a view token: the textarea stays, read-only, with the reason. */
  readonly editable: boolean
  /** False when this console has no note store wired at all. */
  readonly notesEnabled: boolean
  readonly now: number
}

/**
 * Group the node→server pairs into one card per machine.
 *
 * First-seen order, matching the roster's own rule: the order is the order the
 * operator wrote the flags, and it is stable across restarts, while sorting
 * would move a card under the cursor the day a machine is renamed.
 */
export function serverCards(
  nodeServers: readonly NodeServer[],
  notes: readonly ServerNote[],
): readonly ServerCard[] {
  const byServer = new Map<string, string[]>()
  for (const entry of nodeServers) {
    const bucket = byServer.get(entry.server)
    if (bucket === undefined) byServer.set(entry.server, [entry.node])
    else bucket.push(entry.node)
  }
  const noteOf = new Map(notes.map(note => [note.server, note]))
  return [...byServer].map(([server, nodes]) => ({
    server,
    nodes,
    note: noteOf.get(server) ?? null,
  }))
}

/** When this note was last written, or the em dash when there is none. */
function updatedLine(note: ServerNote | null, now: number): string {
  if (note === null) return `<span class="absent">未填写</span>`
  return (
    `更新于 <span class="mono">${escapeHtml(formatClock(note.updatedAt))}</span> ` +
    `<span class="absent">${escapeHtml(formatRelative(note.updatedAt, now))}</span>`
  )
}

function nodesCell(nodes: readonly string[]): string {
  if (nodes.length === 0) return absent()
  return `<span class="tags">${nodes.map(node => chip(node)).join('')}</span>`
}

/**
 * The editor, in the one of three shapes this credential and this console
 * allow.
 *
 * The box is always rendered. A missing textarea would make "you may not edit
 * this" and "this console has no notes" look identical to a reader, and both
 * of them look like the section is broken.
 */
function noteEditor(
  card: ServerCard,
  index: number,
  model: ServersModel,
): string {
  const id = `srv-note-${index}`
  const value = escapeHtml(card.note?.note ?? '')
  const mode = !model.notesEnabled
    ? ' disabled'
    : model.editable
      ? ''
      : ' readonly'
  const box =
    `<div class="field field-wide">` +
    `<label for="${attr(id)}">备注</label>` +
    `<textarea class="input" id="${attr(id)}" name="note" rows="3" ` +
    `maxlength="${attr(String(MAX_SERVER_NOTE_LENGTH))}" ` +
    `placeholder="这台机器是做什么的" spellcheck="false"${mode}>${value}</textarea>` +
    `</div>`

  // The reason, where the button would have been. An operator who cannot find
  // the save button assumes the console is broken (`page.ts`, the wake form).
  const action = !model.notesEnabled
    ? `<span class="note">未配置备注存储 · 备注不会保存</span>`
    : model.editable
      ? `<button type="button" class="btn btn-secondary btn-small" ` +
        `data-action="server-note" data-server="${attr(card.server)}">保存</button>`
      : `<span class="note">只读令牌不能改备注</span>`

  return (
    box +
    `<div class="row-acts">${action}` +
    `<span class="note" data-role="note-status">` +
    updatedLine(card.note, model.now) +
    `</span></div>`
  )
}

function serverCardHtml(
  card: ServerCard,
  index: number,
  model: ServersModel,
): string {
  return (
    `<div class="card elev-sm grp srv" data-server="${attr(card.server)}">` +
    `<div class="grp-head">` +
    `<span class="grp-name">${escapeHtml(card.server)}</span>` +
    `<div class="grp-tail"><span class="note">${escapeHtml(
      String(card.nodes.length),
    )} 个节点</span></div>` +
    `</div>` +
    `<div class="grp-cert">${nodesCell(card.nodes)}</div>` +
    `<div class="row-panel">${noteEditor(card, index, model)}</div>` +
    `</div>`
  )
}

/**
 * Render the whole section: the header and one card per machine.
 *
 * An empty `cards` list is not a state this renders an empty box for — the host
 * omits the section entirely when no `--node-server` was given, because a
 * server section with nothing in it says "attribution is broken" rather than
 * "attribution was not configured". The empty branch here exists only for a
 * direct package caller and says which flag is missing.
 */
export function renderServers(model: ServersModel): string {
  const body: string[] = []
  if (model.failure !== null) {
    body.push(failureBar(model.failure, '备注'))
    body.push(bar('muted', '以下服务器仍取自启动参数'))
  }
  if (model.cards.length === 0) {
    body.push(
      `<p class="hint">未配置服务器归属 · 启动时用 --node-server 指定</p>`,
    )
    return (
      sectionHead('Servers', '服务器', { headingId: SERVERS_HEADING_ID }) +
      `<div class="pane">${body.join('')}</div>`
    )
  }

  const noted = model.cards.filter(card => card.note !== null).length
  const tail =
    `<div class="rowx note">` +
    `<span class="total">${escapeHtml(String(model.cards.length))}</span>` +
    `<span class="sep">·</span>` +
    `<span>已备注 ${escapeHtml(String(noted))}</span>` +
    `</div>`

  body.push(
    `<div class="stack">` +
      model.cards
        .map((card, index) => serverCardHtml(card, index, model))
        .join('') +
      `</div>`,
  )

  return (
    sectionHead('Servers', '服务器', {
      headingId: SERVERS_HEADING_ID,
      tail,
    }) + `<div class="pane">${body.join('')}</div>`
  )
}
