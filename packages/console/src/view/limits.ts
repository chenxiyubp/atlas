// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The ceilings, in two columns that never become one.
 *
 * `packages/router/src/rate.ts` opens by saying the two rate limits are
 * verified independently and **must not be mixed** in code or in documents, and
 * explains why the runtime ceiling is deliberately not in `LIMITS`: a runtime
 * knob parked next to the protocol numbers gets quoted as a protocol guarantee
 * by the next reader. A dashboard is a document, and a screenshot travels
 * further than a paragraph.
 *
 * ## How that rule survives without a paragraph saying so
 *
 * It used to be enforced by a note under the table. Notes are the first thing a
 * redesign deletes, so it is carried by structure instead, three ways at once:
 *
 * - two columns, never one table;
 * - each column names the package the number came from;
 * - **the counting unit is part of the key**, not a footnote — `速率（节点 ×
 *   节点）` against `速率（发送方 × 地址）`. Two rows that read differently
 *   cannot be skimmed as the same row, which is the whole failure mode.
 *
 * The registry lease is a third thing again — not a rate — so it sits under a
 * rule of its own rather than in whichever column had space.
 */

import { attr, escapeHtml } from './escape.js'
import { formatBytes, formatDuration } from './format.js'
import type { LimitsSnapshot } from '../deps.js'

interface Entry {
  readonly key: string
  readonly value: string
}

function definitionList(entries: readonly Entry[]): string {
  const rows = entries
    .map(
      entry =>
        `<div class="lim-row"><dt>${escapeHtml(entry.key)}</dt>` +
        `<dd class="num">${escapeHtml(entry.value)}</dd></div>`,
    )
    .join('')
  return `<dl class="dl">${rows}</dl>`
}

/** Render the limits fragment (the inner HTML of `#limits`). */
export function renderLimits(limits: LimitsSnapshot): string {
  const protocol = definitionList([
    { key: '消息上限', value: formatBytes(limits.protocol.maxMessageBytes) },
    { key: '跳数', value: String(limits.protocol.maxHops) },
    { key: '投递期限', value: formatDuration(limits.protocol.defaultTtlMs) },
    {
      key: '任务期限',
      value: formatDuration(limits.protocol.defaultTaskTtlMs),
    },
    {
      key: '速率（节点 × 节点）',
      value: `${limits.protocol.ratePerMinute} / 分钟`,
    },
  ])

  const runtime = definitionList([
    { key: '容量', value: String(limits.runtime.capacity) },
    { key: '窗口', value: formatDuration(limits.runtime.windowMs) },
    {
      key: '速率（发送方 × 地址）',
      value: `${limits.runtime.capacity} / ${formatDuration(
        limits.runtime.windowMs,
      )}`,
    },
  ])

  return (
    // `data-rate`/`data-ttl-ms` echo two of the numbers already computed
    // above, so the overview stat cards in page.ts can read them off the
    // markup instead of `renderLimits` growing a second return shape.
    `<div class="limits-frag" data-rate="${attr(
      String(limits.protocol.ratePerMinute),
    )}" data-ttl-ms="${attr(String(limits.registryTtlMs))}">` +
    `<div class="limits">` +
    `<section class="col" id="limits-protocol">` +
    `<h3 class="col-name">协议</h3>` +
    `<p class="col-src"><code class="mono">@qianmo/protocol</code> LIMITS</p>` +
    protocol +
    `</section>` +
    `<section class="col" id="limits-runtime">` +
    `<h3 class="col-name">运行时</h3>` +
    `<p class="col-src"><code class="mono">@qianmo/router</code> RUNTIME_RATE` +
    `</p>` +
    runtime +
    `</section>` +
    `</div>` +
    `<div class="strip" id="limits-registry">` +
    `<span class="k">注册租约</span>` +
    `<span class="num">${escapeHtml(formatDuration(limits.registryTtlMs))}` +
    `</span></div>` +
    `</div>`
  )
}
