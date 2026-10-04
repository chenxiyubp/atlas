// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The whole stylesheet, as one string, inlined into the document.
 *
 * ## Why a string and not a file
 *
 * There is no web build in this repository — `vite.config.ts` bundles the CLI,
 * and `src/components/**` is Ink, which is terminal output that happens to be
 * written in JSX. Adding a second front-end pipeline to serve one operator page
 * would cost more than the page. So: a constant, inlined by `renderPage`, no
 * asset route, no cache-busting, no `<link>`.
 *
 * That is also a security property. The page loads **nothing** from anywhere —
 * no CDN, no web font, no remote image — so there is no third party that can
 * change what an operator sees, and the CSP in the document head can be tight
 * enough to say so.
 *
 * ## Where the token set comes from
 *
 * The palette is the **Organic** design system: a cream ground (`#f5ead8`), a
 * sand surface (`#ebddc5`), warm charcoal ink, terracotta as the accent and
 * sage as the second accent, each with a nine-step ramp generated on one shared
 * lightness scale. Radii are large (8 / 16 / 28px, and small controls go full
 * pill), spacing is a six-step scale, and elevation is two soft ink-tinted
 * shadows plus one for the dialog.
 *
 * Three consequences of adopting it wholesale are worth stating, because each
 * replaced a rule the previous (shadcn-derived) sheet held:
 *
 * **① Cards are a surface, not a bordered box.** `--color-surface` sits a step
 * off `--color-bg`, so a card is legible without a hairline around it. What is
 * still bordered is the *input well* — Organic gives `.input` the same surface
 * colour as `.card`, and on a data-entry page an input that matches the card it
 * sits on disappears. So `.card .input` drops back to `--color-bg`.
 *
 * **② The dark scheme is a token flip, not a second sheet.** Every component
 * class below is written once. The dark block redefines the same custom
 * properties with the ramps' semantic direction reversed — light: 100 is a pale
 * fill and 900 is dark text; dark: 100 is a dark fill and 900 is pale text — so
 * `.tag-accent` ("background 100, text 800") keeps working byte for byte. There
 * is exactly one thing that flip cannot express, and it is why `--color-scrim`
 * exists: the dialog backdrop used to borrow `--color-neutral-900`, which after
 * the flip is the *lightest* step and would wash the screen with light instead
 * of dimming it.
 *
 * **③ Colour still states a fact; shape carries it too.** The four roster
 * states are four different *shapes* — filled disc, hollow terracotta ring,
 * neutral bar, hollow neutral ring — so the roster is readable without colour
 * vision. `--color-accent` is additionally spent on the primary action and on
 * the focus ring, which is the one deliberate exception, unchanged from the
 * previous sheet.
 *
 * ## Fonts, and why there is no `@font-face`
 *
 * Organic's own reference sheet opens with an `@import` of two Google fonts.
 * That line cannot come across: the console's CSP is `default-src 'none'` with
 * `font-src 'none'`, and a render-blocking request to a third party is exactly
 * what the inline-everything rule exists to prevent. The interface language is
 * Chinese, so the loss is smaller than it sounds — neither display face carries
 * CJK glyphs, which means the wordmark and nearly all body copy were already
 * falling through to the system stack. What changes is the Latin: headings buy
 * their hierarchy back with weight, size and letter-spacing instead of a display
 * face (`--font-heading-weight: 600`, the one deliberate deviation from
 * Organic's own `400`).
 *
 * ## No `url()`, anywhere
 *
 * Every icon on the page is an inline `<svg>` emitted by the view layer, and
 * that includes the `<select>` chevrons, which are absolutely positioned inside
 * a `.sel` wrapper rather than painted as a background image. `bun test` pins
 * this: a `url(` in here is either a remote fetch the CSP will refuse or a data
 * URI, and both are ways for the sheet to stop being one self-contained string.
 */

export const CONSOLE_CSS = `
:root {
  color-scheme: light dark;

  --color-bg: #f5ead8;
  --color-surface: #ebddc5;
  --color-text: #201e1d;
  --color-accent: #c67139;
  --color-accent-2: #7a8a5e;
  --color-divider: color-mix(in srgb, #201e1d 16%, transparent);

  --color-neutral-100: #f9f4ed;
  --color-neutral-200: #eee7db;
  --color-neutral-300: #dcd3c4;
  --color-neutral-400: #c0b6a5;
  --color-neutral-500: #a19786;
  --color-neutral-600: #82796a;
  --color-neutral-700: #645c50;
  --color-neutral-800: #474238;
  --color-neutral-900: #2e2b25;

  --color-accent-100: #fff2eb;
  --color-accent-200: #ffe1d0;
  --color-accent-300: #ffc6a5;
  --color-accent-400: #f6a06b;
  --color-accent-500: #d67f48;
  --color-accent-600: #b2622d;
  --color-accent-700: #8c491a;
  --color-accent-800: #643312;
  --color-accent-900: #402310;

  --color-accent-2-100: #f0fae1;
  --color-accent-2-200: #e1eecc;
  --color-accent-2-300: #ccdbb2;
  --color-accent-2-400: #aebf92;
  --color-accent-2-500: #8fa073;
  --color-accent-2-600: #728157;
  --color-accent-2-700: #56633f;
  --color-accent-2-800: #3d472b;
  --color-accent-2-900: #272e1b;

  --color-critical: #7e1d3f;

  /* Dialog scrim. Not a ramp step: the ramps flip direction in dark, and a
     backdrop that flips with them stops being a backdrop. */
  --color-scrim: #2e2b25;

  --color-muted: color-mix(in srgb, var(--color-text) 55%, transparent);
  --color-quiet: color-mix(in srgb, var(--color-text) 70%, transparent);

  --font-body: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
  --font-heading: var(--font-body);
  --font-heading-weight: 600;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  --space-1: 4.4px;
  --space-2: 8.8px;
  --space-3: 13.2px;
  --space-4: 17.6px;
  --space-6: 26.4px;
  --space-8: 35.2px;

  --radius-sm: 8px;
  --radius-md: 16px;
  --radius-lg: 28px;

  --shadow-sm: 0 1px 2px color-mix(in srgb, #2e2b25 14%, transparent);
  --shadow-md: 0 3px 10px color-mix(in srgb, #2e2b25 16%, transparent);
  --shadow-lg: 0 12px 32px color-mix(in srgb, #2e2b25 22%, transparent);
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #201e1d;
    --color-surface: #2e2b25;
    --color-text: #f5ead8;
    --color-accent: #f6a06b;
    --color-accent-2: #aebf92;
    --color-divider: color-mix(in srgb, #f5ead8 18%, transparent);

    --color-neutral-100: #2a2723;
    --color-neutral-200: #383430;
    --color-neutral-300: #4a453d;
    --color-neutral-400: #625c51;
    --color-neutral-500: #7d7568;
    --color-neutral-600: #9a9184;
    --color-neutral-700: #b8b0a2;
    --color-neutral-800: #d5cec1;
    --color-neutral-900: #ece6da;

    --color-accent-100: #3a2113;
    --color-accent-200: #5b3115;
    --color-accent-300: #8c491a;
    --color-accent-400: #b2622d;
    --color-accent-500: #d67f48;
    --color-accent-600: #ffb888;
    --color-accent-700: #ffcfae;
    --color-accent-800: #ffe4d2;
    --color-accent-900: #fff2eb;

    --color-accent-2-100: #1e2415;
    --color-accent-2-200: #2e3a1f;
    --color-accent-2-300: #46562e;
    --color-accent-2-400: #63783f;
    --color-accent-2-500: #8fa073;
    --color-accent-2-600: #b8cc95;
    --color-accent-2-700: #d2e2b4;
    --color-accent-2-800: #e6f0d2;
    --color-accent-2-900: #f3f9e6;

    --color-critical: #ff9db9;

    --color-scrim: #050403;

    --shadow-sm: 0 0 0 1px color-mix(in srgb, #f5ead8 10%, transparent);
    --shadow-md: 0 0 0 1px color-mix(in srgb, #f5ead8 11%, transparent), 0 3px 12px color-mix(in srgb, #050403 45%, transparent);
    --shadow-lg: 0 0 0 1px color-mix(in srgb, #f5ead8 13%, transparent), 0 16px 40px color-mix(in srgb, #050403 55%, transparent);
  }
}

/* ---- base ---- */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; height: 100%; }
body {
  margin: 0;
  min-height: 100%;
  background: var(--color-bg);
  color: var(--color-text);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.55;
  font-variant-numeric: tabular-nums;
  overflow-wrap: break-word;
  -webkit-font-smoothing: antialiased;
  /* The page defaults to unselectable, matching the reference product's
     desktop-app feel — but code/pre/kbd/input/textarea/.mono stay selectable.
     Most copyable values here (addresses, trace ids) carry .mono rather than
     being wrapped in <code>, so the exemption covers the class too. */
  user-select: none;
}
code, pre, kbd, samp, input, textarea, select, .mono, .addr, .bubble { user-select: text; }
h1, h2, h3, h4 {
  font-family: var(--font-heading);
  font-weight: var(--font-heading-weight);
  line-height: 1.15;
  letter-spacing: -0.012em;
  margin: 0;
}
h1 { font-size: 28px; }
h2 { font-size: 24px; }
h3 { font-size: 21px; }
h4 { font-size: 17px; }
p { margin: 0; }
a { color: var(--color-accent); text-underline-offset: 3px; }
::selection { background: color-mix(in srgb, var(--color-accent) 30%, transparent); }

.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
.mono, code { font-family: var(--font-mono); }
.absent { color: var(--color-muted); }
.note { font-size: 12.5px; color: var(--color-muted); }
.kicker {
  font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
  color: var(--color-accent);
}
.flabel {
  font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
  color: color-mix(in srgb, var(--color-text) 52%, transparent);
}
.stack { display: flex; flex-direction: column; gap: var(--space-3); }
.rowx { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.divider { height: 1px; background: var(--color-divider); border-radius: 999px; }
.spacer { flex: 1 1 auto; }
.i { width: 18px; height: 18px; flex: none; }
.i-sm { width: 14px; height: 14px; flex: none; }
svg { display: block; }

/* ---- focus: the accent ring, never a hardcoded brand hex ---- */
:focus { outline: none; }
a:focus-visible, button:focus-visible, input:focus-visible,
select:focus-visible, textarea:focus-visible, summary:focus-visible,
[tabindex]:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* ---- shell: a sand panel on the left, the ledger on the right ---- */
.shell {
  display: grid; grid-template-columns: 264px minmax(0, 1fr);
  gap: var(--space-4); padding: var(--space-4);
  width: min(1320px, 100%); margin-inline: auto;
  align-items: stretch; min-height: 100vh;
}
.side {
  background: var(--color-surface);
  border-radius: calc(var(--radius-lg) * 1.15);
  padding: var(--space-4);
  display: flex; flex-direction: column; gap: var(--space-6);
  min-width: 0;
  /* Sticky and exactly one viewport tall. Stretching it to the document — the
     way the design mock shows it — works at the mock's height and leaves the
     nav two screens above the operator on a real ledger. Fixing the height to
     the viewport keeps the left column a full panel at every scroll position
     and keeps the nav where it can be reached. */
  position: sticky; top: var(--space-4);
  height: calc(100vh - var(--space-8));
  overflow-y: auto;
}
.main {
  display: flex; flex-direction: column; gap: calc(var(--space-8) * 1.2);
  padding: var(--space-2) var(--space-2) var(--space-8);
  min-width: 0;
}

/* ---- brand ---- */
.brand { display: flex; flex-direction: column; gap: 1px; }
.brand-en {
  font-size: 11px; letter-spacing: .2em; text-transform: uppercase;
  color: var(--color-accent-700); font-weight: 600;
}
.brand-cn {
  font-family: var(--font-heading); font-size: 29px; font-weight: 700;
  line-height: 1.1; letter-spacing: .02em;
  color: var(--color-text); text-decoration: none;
}
a.brand-cn:hover { color: var(--color-accent-700); }

/* ---- nav ---- */
.nav-list { display: flex; flex-direction: column; gap: var(--space-1); }
.nav-item {
  display: flex; align-items: center; gap: var(--space-2);
  padding: 9px var(--space-3); border-radius: 999px;
  font-size: 14px; color: var(--color-text); text-decoration: none;
  transition: background-color 150ms ease, color 150ms ease;
}
.nav-item:hover { background: color-mix(in srgb, var(--color-text) 7%, transparent); }
.nav-item[aria-current="page"] { background: var(--color-accent); color: var(--color-bg); }
.nav-item .cnt { margin-left: auto; font-size: 11px; opacity: .75; }

/* ---- sidebar foot ---- */
.side-foot { margin-top: auto; display: flex; flex-direction: column; gap: var(--space-3); }
/* Two short lines that wrap, not one line that ellipses: at 430px the instance
   label used to run off the panel and take the controls with it. */
.inst { font-size: 11.5px; line-height: 1.45; color: color-mix(in srgb, var(--color-text) 60%, transparent); }
.inst b {
  display: block; font-weight: 700; font-size: 12px;
  color: color-mix(in srgb, var(--color-text) 84%, transparent);
  overflow-wrap: anywhere;
}
.fblock {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-2); font-size: 13px; flex-wrap: wrap;
}
.fblock form { margin: 0; }

/* ---- the refresh switch: a pure-CSS pill ---- */
.sw { display: inline-flex; align-items: center; gap: var(--space-2); cursor: pointer; font-size: 13px; }
.sw input { position: absolute; opacity: 0; width: 0; height: 0; }
.sw .trk {
  width: 36px; height: 20px; border-radius: 999px; flex: none; position: relative;
  background: var(--color-neutral-400); transition: background-color 150ms ease;
}
.sw .trk::after {
  content: ""; position: absolute; top: 2px; left: 2px;
  width: 16px; height: 16px; border-radius: 50%;
  background: var(--color-bg); transition: transform 150ms ease;
}
.sw input:checked + .trk { background: var(--color-accent-2-600); }
.sw input:checked + .trk::after { transform: translateX(16px); }
.sw input:focus-visible + .trk { outline: 2px solid var(--color-accent); outline-offset: 2px; }
#refresh-state, #token-state, #stream-state { font-size: 11px; color: var(--color-muted); }

/* ---- sections ---- */
.sec { display: flex; flex-direction: column; gap: var(--space-4); scroll-margin-top: var(--space-4); }
.sec-head {
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: var(--space-4); flex-wrap: wrap;
}
.sec-head h2, .sec-head h3 { margin: 0; }
.cards { display: grid; gap: var(--space-3); }
.g4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }

/* ---- cards ---- */
.card {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-3); background: var(--color-surface);
  border-radius: calc(var(--radius-lg) * 1.15);
  min-width: 0;
}
.card-kicker { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-accent); }
.card-meta { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: color-mix(in srgb, var(--color-text) 50%, transparent); }
.elev-sm { box-shadow: var(--shadow-sm); }
.elev-md { box-shadow: var(--shadow-md); }
.elev-lg { box-shadow: var(--shadow-lg); }

.stat { gap: var(--space-2); padding: var(--space-4) var(--space-4) var(--space-3); }
.stat-top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-2); }
.stat-num {
  font-family: var(--font-heading); font-weight: 700;
  font-size: 34px; line-height: 1.05; letter-spacing: -.02em;
}
.stat-num .u { font-size: 16px; margin-left: 4px; opacity: .72; }
.blob {
  width: 38px; height: 38px; border-radius: 50%; flex: none;
  display: grid; place-items: center;
  background: var(--color-accent-100); color: var(--color-accent-700);
}
.blob-2 { background: var(--color-accent-2-100); color: var(--color-accent-2-800); }
.blob-n { background: var(--color-neutral-200); color: var(--color-neutral-700); }

/* ---- tags ---- */
.tag, .chip {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; letter-spacing: .02em; padding: 3px 10px;
  border-radius: 999px; white-space: nowrap;
  background: var(--color-neutral-100); color: var(--color-neutral-800);
}
.tag-accent { background: var(--color-accent-100); color: var(--color-accent-800); }
.tag-accent-2 { background: var(--color-accent-2-100); color: var(--color-accent-2-800); }
.tag-critical { background: color-mix(in srgb, var(--color-critical) 14%, var(--color-bg)); color: var(--color-critical); }
.tag-neutral { background: var(--color-neutral-100); color: var(--color-neutral-800); }
.chips, .tags { display: inline-flex; flex-wrap: wrap; gap: 4px; max-width: 100%; }
.chips .chip, .tags .chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; }

/* ---- tone: colour states a fact ---- */
.tone-ok { color: var(--color-accent-2-800); }
.tone-warn { color: var(--color-accent-800); }
.tone-bad { color: var(--color-accent-800); }
.tone-critical { color: var(--color-critical); font-weight: 700; }
.tone-muted { color: var(--color-muted); }
.total { color: var(--color-text); font-weight: 600; }
.ttl { color: var(--color-muted); }
.sep { color: var(--color-neutral-500); }

/* ---- status: four states, four shapes ---- */
.state { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; white-space: nowrap; max-width: 100%; }
.dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: var(--color-neutral-500); }
.state:has(.dot-ok) { color: var(--color-accent-2-800); }
.dot-ok { background: var(--color-accent-2-600); }
.state:has(.dot-warn) { color: var(--color-accent-800); }
.dot-warn { background: transparent; border: 3px solid var(--color-accent-600); }
.state:has(.dot-bad) { color: var(--color-neutral-700); }
.dot-bad { background: transparent; border: 2px solid var(--color-neutral-500); }
.state:has(.dot-critical) { color: var(--color-critical); }
.dot-critical { background: var(--color-critical); }
.state:has(.dot-muted) { color: var(--color-neutral-700); }
.dot-muted { width: 13px; height: 4px; border-radius: 999px; background: var(--color-neutral-600); }

/* ---- the address, with its agent segment as a pill ---- */
.addr {
  font-family: var(--font-mono); font-size: 12.5px;
  color: color-mix(in srgb, var(--color-text) 52%, transparent);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0; max-width: 100%;
}
.addr b {
  font-weight: 700; color: var(--color-accent-800);
  background: var(--color-accent-100); border-radius: 999px; padding: 1px 8px;
}

/* ---- the lease meter ---- */
.lease { display: flex; align-items: center; gap: var(--space-2); }
.lease-trk {
  width: 88px; height: 8px; border-radius: 999px; flex: none;
  background: var(--color-neutral-300); overflow: hidden;
}
/* display:block is load-bearing: the track is blockified by its flex parent,
   the fill is not, and without this the width is ignored outright. */
.lease-fill { display: block; height: 100%; border-radius: 999px; background: var(--color-accent-2-500); }
.lease-stale { background: var(--color-accent-500); }
.lease-dead { background: var(--color-neutral-400); }
.lease-left { font-family: var(--font-mono); font-size: 11.5px; white-space: nowrap; color: var(--color-muted); }
.lease-left.gone { color: var(--color-accent-800); }

/* ---- roster: one card per node, one disclosure row per agent ---- */
.grp { gap: var(--space-2); padding: var(--space-3) var(--space-4); }
.grp-head {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: 0 var(--space-2) var(--space-2);
  border-bottom: 1px solid var(--color-divider);
}
.grp-name { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: 18px; }
.grp-tail { margin-left: auto; display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
/* ---- certificate line, under the node header (key-distribution.md §10.1) ---- */
.grp-cert {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: var(--space-2) var(--space-2) 0;
}
.cert { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; }
.ct-w { font-weight: 600; }
.ct-left { font-family: var(--font-mono); font-size: 11.5px; white-space: nowrap; color: var(--color-muted); }
/* The copyable "qm ca issue" line (§10.2: the command, never the button). It
   wraps rather than scrolls — an operator selects it with the mouse, and a
   horizontally scrolled command is one that gets copied half. */
.cmd {
  font-size: 11.5px; color: var(--color-muted);
  overflow-wrap: anywhere; user-select: all;
  padding: 2px 6px; border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
}
.row > summary {
  list-style: none; cursor: pointer;
  display: grid; grid-template-columns: minmax(0, 1fr) 116px 186px 82px 26px;
  align-items: center; gap: var(--space-3);
  padding: 9px var(--space-2); border-radius: 999px;
  transition: background-color 150ms ease;
}
.row > summary::-webkit-details-marker { display: none; }
.row > summary::marker { content: ""; }
.row > summary:hover, .row[open] > summary { background: color-mix(in srgb, var(--color-text) 5%, transparent); }
.chev { color: var(--color-accent-700); transition: transform 150ms ease; }
details[open] > summary .chev { transform: rotate(180deg); }
.row-panel {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: var(--space-4); padding: var(--space-4);
  margin: var(--space-1) var(--space-2) var(--space-2);
  background: var(--color-neutral-100); border-radius: var(--radius-lg);
}
.kv { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.kv .k { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--color-muted); }
.kv .v { font-size: 13px; overflow-wrap: anywhere; }
.row-acts {
  grid-column: 1 / -1; display: flex; align-items: center; gap: var(--space-2);
  flex-wrap: wrap; padding-top: var(--space-2); border-top: 1px solid var(--color-divider);
}

/* ---- disclosure: the advanced half of three forms ---- */
.adv { margin-top: var(--space-1); }
.adv > summary {
  list-style: none; cursor: pointer;
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 13px; color: var(--color-accent-700);
  padding: 5px 13px; border-radius: 999px;
  transition: background-color 150ms ease;
}
.adv > summary::-webkit-details-marker { display: none; }
.adv > summary::marker { content: ""; }
.adv > summary:hover { background: color-mix(in srgb, var(--color-accent) 10%, transparent); }
.adv-body {
  margin-top: var(--space-3); padding: var(--space-4);
  background: var(--color-neutral-100); border-radius: var(--radius-lg);
  display: grid; gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}

/* ---- forms ---- */
.field { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.field > label, .field > span {
  display: block; font-size: 12px; color: var(--color-quiet);
}
.field-wide { grid-column: 1 / -1; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-4); }
/* The wake form's two columns are not equal: the target picker has a known
   width and the prompt should take everything left over. A class rather than an
   inline style because an inline style outranks the collapse rule below, and a
   prompt box that stays in a 40px column at 430px is a prompt box nobody can
   type in. */
.wake-grid { grid-template-columns: minmax(0, 320px) minmax(0, 1fr); }
fieldset { border: 0; margin: 0; padding: 0; }
fieldset[disabled] { opacity: .55; }
.req { font-style: normal; color: var(--color-accent-700); margin-left: 2px; }

.input {
  width: 100%; min-height: 36px; padding: 6px 14px;
  font: inherit; font-family: var(--font-body); font-size: 14px;
  color: var(--color-text); caret-color: var(--color-accent);
  background: var(--color-surface);
  border: 1px solid var(--color-divider); border-radius: 999px;
  min-width: 0;
}
/* Organic gives inputs the card's own surface colour. On a data-entry page an
   input well that matches the card it sits on is an input well nobody sees. */
.card .input, .adv-body .input, .composer .input { background: var(--color-bg); }
.input:hover { border-color: color-mix(in srgb, var(--color-text) 45%, transparent); }
.input:focus-visible { border-color: var(--color-accent); outline-offset: 0; }
.input[readonly] { color: var(--color-muted); }
textarea.input { border-radius: var(--radius-lg); padding: 10px 14px; line-height: 1.55; resize: vertical; min-height: 76px; }

.sel { position: relative; display: block; }
.sel > select { appearance: none; -webkit-appearance: none; padding-right: 36px; }
.sel > .chev { position: absolute; right: 13px; top: 50%; transform: translateY(-50%); pointer-events: none; }

.hintline {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 12px; color: color-mix(in srgb, var(--color-text) 58%, transparent);
  min-width: 0;
}
.hintline .mono { overflow: hidden; text-overflow: ellipsis; }

.chk {
  display: inline-flex; align-items: center; gap: 8px; cursor: pointer;
  font-size: 13.5px; padding: 5px 13px; border-radius: 999px; position: relative;
  border: 1px solid var(--color-divider);
  transition: background-color 150ms ease, border-color 150ms ease;
}
.chk input { position: absolute; opacity: 0; width: 0; height: 0; }
.chk .bx {
  width: 15px; height: 15px; border-radius: var(--radius-sm); flex: none;
  display: grid; place-items: center; color: transparent;
  border: 1.5px solid var(--color-divider);
  transition: background-color 150ms ease, border-color 150ms ease;
}
.chk:hover { background: color-mix(in srgb, var(--color-text) 6%, transparent); }
.chk:has(input:checked) { background: var(--color-accent-2-100); border-color: var(--color-accent-2-400); }
.chk:has(input:checked) .bx { background: var(--color-accent-2-600); border-color: var(--color-accent-2-600); color: var(--color-bg); }
.chk:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: 2px; }

.seg {
  display: inline-flex; overflow: hidden; flex-wrap: wrap;
  border: 1px solid var(--color-divider); border-radius: 999px;
}
.seg-opt {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 7px 13px; font-size: 13px; cursor: pointer;
  transition: background-color 150ms ease, color 150ms ease;
}
.seg-opt input { position: absolute; opacity: 0; width: 0; height: 0; pointer-events: none; }
.seg-opt + .seg-opt { border-left: 1px solid var(--color-divider); }
.seg-opt:has(input:checked) { background: var(--color-accent); color: var(--color-bg); }
.seg-opt:not(:has(input:checked)):hover { background: color-mix(in srgb, var(--color-text) 7%, transparent); }
.seg-opt:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: -2px; }

/* ---- buttons ---- */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  cursor: pointer; text-decoration: none;
  font: inherit; font-family: var(--font-body); font-size: 14px; line-height: 1.2;
  color: var(--color-text); background: transparent;
  border: 1px solid transparent; padding: var(--space-2) calc(var(--space-3) * 1.2);
  border-radius: 999px;
  transition: background-color 150ms ease, color 150ms ease, border-color 150ms ease;
}
.btn:disabled, .btn[disabled] { opacity: .45; cursor: not-allowed; }
.btn-primary { background: var(--color-accent); color: var(--color-bg); }
.btn-primary:hover { background: var(--color-accent-600); }
.btn-primary:active { background: var(--color-accent-700); }
.btn-secondary { border-color: var(--color-divider); }
.btn-secondary:hover { background: color-mix(in srgb, var(--color-text) 7%, transparent); }
.btn-secondary:active { background: color-mix(in srgb, var(--color-text) 14%, transparent); }
.btn-ghost { color: var(--color-accent-700); padding-inline: var(--space-3); }
.btn-ghost:hover { background: color-mix(in srgb, var(--color-accent) 10%, transparent); }
/* The one irreversible action. Terracotta's deep step, not a pure red, and
   never the resting state of anything — it is only ever the confirm button of
   a dialog, or a ghost link inside an expanded row. */
.btn-danger { background: var(--color-accent-700); color: var(--color-bg); border-color: transparent; }
.btn-danger:hover { background: var(--color-accent-800); }
.btn-ghost.btn-danger { background: transparent; color: var(--color-accent-700); }
.btn-ghost.btn-danger:hover { background: color-mix(in srgb, var(--color-accent) 12%, transparent); }
.btn-small { font-size: 12.5px; padding: 5px 12px; }
.btn-block { width: 100%; }
.btn-icon { width: 38px; height: 38px; padding: 0; flex: none; }
.linkish {
  font: inherit; font-family: var(--font-mono); font-size: 12px;
  background: none; border: 0; padding: 0; cursor: pointer;
  color: var(--color-accent-700); text-decoration: underline; text-underline-offset: 3px;
  transition: opacity 150ms ease;
}
.linkish:hover { opacity: .75; }

/* ---- strips: a fact and a number ---- */
.bar {
  display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px;
  margin: 0; padding: 10px var(--space-4); border-radius: var(--radius-lg);
  font-size: 13px; background: var(--color-neutral-100); color: var(--color-neutral-800);
}
.bar-bad { background: var(--color-accent-100); color: var(--color-accent-800); }
.bar-warn { background: var(--color-accent-100); color: var(--color-accent-800); }
.bar-critical { background: color-mix(in srgb, var(--color-critical) 14%, var(--color-bg)); color: var(--color-critical); }
.bar-muted { background: var(--color-neutral-100); color: var(--color-neutral-700); }
.bar-code { font-family: var(--font-mono); font-size: 11px; opacity: .75; }
.bar .n { font-variant-numeric: tabular-nums; }
.hint { font-size: 13.5px; color: var(--color-muted); padding: var(--space-3) var(--space-2); }
.status { font-size: 12px; min-height: 1.25em; color: var(--color-muted); }
.status[data-tone='ok'] { color: var(--color-accent-2-800); }
.status[data-tone='bad'] { color: var(--color-accent-800); }
.jump { color: var(--color-accent-700); }

/* ---- the trail table ---- */
.scroll { overflow-x: auto; }
.trail { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.trail th {
  text-align: left; font-size: 10px; letter-spacing: .08em; text-transform: uppercase;
  color: color-mix(in srgb, var(--color-text) 58%, transparent);
  padding: var(--space-2); border-bottom: 1px solid var(--color-divider);
  font-weight: 400; white-space: nowrap;
}
.trail td {
  padding: var(--space-2); vertical-align: middle;
  border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);
}
.trail tbody tr:last-child td { border-bottom: 0; }
.trail tbody tr:hover { background: color-mix(in srgb, var(--color-text) 4%, transparent); }
.trail td.when { white-space: nowrap; font-family: var(--font-mono); font-size: 12px; }
.trail td.src, .trail td.result { white-space: nowrap; }
/* break-word, not anywhere: wake_dispatch split as wake_dispat / ch reads as
   two events. A long kind widens the column instead. */
.trail td.kind { overflow-wrap: break-word; }
.detail { margin-top: 4px; font-size: 11px; color: var(--color-muted); }
.detail .dv { color: var(--color-text); }
.arrow { color: var(--color-muted); padding: 0 4px; }
.fp { color: var(--color-muted); }

/* ---- limits ---- */
.limits { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-6); }
.col-name { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-accent); margin: 0; }
.col-src { font-size: 12.5px; color: var(--color-muted); margin: 0 0 var(--space-3); font-family: var(--font-mono); }
.dl { margin: 0; }
.lim-row {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--space-3); padding: 8px 0; font-size: 13.5px;
  border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent);
}
.lim-row:last-child { border-bottom: 0; }
.lim-row dt { color: var(--color-quiet); }
.lim-row dd { margin: 0; font-family: var(--font-mono); font-size: 13px; }
.strip {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px;
  margin-top: var(--space-4); padding-top: var(--space-3);
  border-top: 1px solid var(--color-divider); font-size: 13px;
}
.strip .k { color: var(--color-muted); font-size: 11px; }
.strip .num { font-family: var(--font-mono); }

/* ---- the reconstructed chain, as a path rather than a second table ---- */
.chain-panel {
  padding: var(--space-4) var(--space-6);
  background: var(--color-surface); border-radius: calc(var(--radius-lg) * 1.15);
  box-shadow: var(--shadow-sm);
}
.chain-panel[hidden] { display: none; }
.chain-head { display: flex; align-items: baseline; gap: var(--space-2); flex-wrap: wrap; }
.chain-title { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--color-accent); margin: 0; }
.chain-count { font-size: 12px; color: var(--color-muted); display: flex; gap: 8px; }
.hops {
  list-style: none; margin: var(--space-4) 0 0; padding: 0;
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: var(--space-1) 0;
}
.hop { display: flex; align-items: center; gap: 8px; }
.hop-node {
  font-size: 12px; padding: 2px 10px; border-radius: 999px; white-space: nowrap;
  background: var(--color-neutral-100); color: var(--color-neutral-800);
  max-width: 176px; overflow: hidden; text-overflow: ellipsis;
}
.hop-link { display: flex; flex-direction: column; align-items: center; gap: 3px; }
.hop-kind { font-size: 11px; color: var(--color-muted); white-space: nowrap; }
.hop-line { display: block; width: 56px; border-top: 2px solid var(--color-accent-2-400); border-radius: 999px; }
.hop[data-outcome='dropped'] .hop-line { border-top-style: dashed; border-top-color: var(--color-neutral-400); }
.hop[data-outcome='refused'] .hop-line { border-top-color: var(--color-accent-500); }
.hop-mark { display: block; flex: 0 0 auto; }
.mark-ok { width: 8px; height: 8px; border-radius: 50%; background: var(--color-accent-2-600); }
.mark-refused { width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--color-accent-600); }
.mark-dropped { width: 12px; height: 0; border-top: 2px dashed var(--color-neutral-500); }
.mark-muted { width: 8px; height: 8px; border-radius: 50%; background: var(--color-neutral-500); }
.hop-code { font-size: 11px; color: var(--color-accent-800); white-space: nowrap; }
.hop[data-outcome='dropped'] .hop-code { color: var(--color-muted); }
.chain-meta { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px; margin-top: var(--space-3); font-size: 11px; color: var(--color-muted); }
.chain-meta .k { min-width: 32px; }
.chain-foot { margin-top: var(--space-3); font-size: 11px; color: var(--color-muted); }

/* ---- empty states: copy on the left, a blob in the right-hand air ---- */
.empty {
  display: grid; grid-template-columns: minmax(0, 1fr) 240px;
  align-items: center; gap: var(--space-6);
  padding: calc(var(--space-8) * 1.1) var(--space-6) calc(var(--space-8) * 1.1) var(--space-4);
}
.empty-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: 24px; line-height: 1.15; margin: 0; }
.empty-note { font-size: 14px; color: color-mix(in srgb, var(--color-text) 62%, transparent); max-width: 46ch; margin: 0; }
.empty-art { justify-self: end; }
.legend { display: flex; gap: var(--space-4); flex-wrap: wrap; font-size: 12.5px; color: var(--color-muted); }

/* ---- the confirm dialog ---- */
.dialog-backdrop {
  position: fixed; inset: 0; z-index: 40;
  display: grid; place-items: center; padding: var(--space-4);
  background: color-mix(in srgb, var(--color-scrim) 55%, transparent);
}
.dialog-backdrop[hidden] { display: none; }
.dialog {
  width: min(460px, 100%); display: flex; flex-direction: column; gap: var(--space-3);
  padding: var(--space-6); border-radius: calc(var(--radius-lg) * 1.15);
  background: var(--color-surface); box-shadow: var(--shadow-lg);
  max-height: 90vh; overflow-y: auto;
}
.dlg-top { display: flex; align-items: center; gap: var(--space-3); }
.dlg-icon {
  width: 44px; height: 44px; border-radius: 50%; flex: none;
  display: grid; place-items: center;
  background: var(--color-accent-200); color: var(--color-accent-800);
}
.dlg-icon-2 { background: var(--color-accent-2-200); color: var(--color-accent-2-800); }
.dialog-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: 20px; }
.dialog-body { font-size: 14px; display: flex; flex-direction: column; gap: var(--space-3); }
.recap {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--color-neutral-100); border-radius: var(--radius-lg); font-size: 13px;
}
.recap-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.recap-row .k { font-size: 11px; color: var(--color-muted); flex: none; }
.quote {
  font-size: 13px; line-height: 1.5; margin: 0;
  color: color-mix(in srgb, var(--color-text) 78%, transparent);
  max-height: 4.5em; overflow: hidden; white-space: pre-wrap;
}
.dialog-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }

/* ---- /chat ---- */
.chat-main { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; padding: var(--space-2); }
.chat-head {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  padding: var(--space-2) var(--space-3) var(--space-3);
  border-bottom: 1px solid var(--color-divider);
}
.chat-name { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: 22px; }
.chat-tail { margin-left: auto; display: flex; align-items: center; gap: var(--space-3); }
.thread-mount { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.thread { display: flex; flex-direction: column; gap: var(--space-6); padding: var(--space-4) var(--space-3); }
.chat-none { font-size: 13px; color: var(--color-muted); padding: var(--space-2); }

/* The session rail. It is the one part of the panel allowed to scroll: pinning
   the identity block to the bottom matters more than seeing every session, and
   without this the whole panel scrolls and 退出 leaves the screen. */
.chat-rail-mount { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
.chat-new { display: flex; flex-direction: column; gap: var(--space-2); }
.chat-groups { display: flex; flex-direction: column; gap: var(--space-4); }
.chat-group { display: flex; flex-direction: column; gap: var(--space-1); }
.chat-group-name { display: flex; align-items: center; gap: 7px; font-size: 12px; padding: 0 var(--space-2); }
.chat-group-node { font-size: 11px; padding: 0 var(--space-2); color: var(--color-muted); margin: 0; }
.chat-item {
  display: block; width: 100%; text-align: left; border: 0; background: none;
  cursor: pointer; padding: 9px var(--space-3); border-radius: var(--radius-lg);
  color: inherit; font: inherit; font-family: var(--font-body);
  transition: background-color 150ms ease;
}
.chat-item:hover { background: color-mix(in srgb, var(--color-text) 6%, transparent); }
.chat-item-active { background: var(--color-accent-100); outline: 1px solid var(--color-accent-300); outline-offset: -1px; }
.chat-item-line {
  font-size: 13px; line-height: 1.35; overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.chat-item-meta { display: block; font-size: 11px; margin-top: 3px; color: color-mix(in srgb, var(--color-text) 52%, transparent); }

/* A turn: a round avatar in a 34px track, then the head, bubble and marks. */
.turn { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: var(--space-3); max-width: 800px; }
.turn-av {
  width: 34px; height: 34px; border-radius: 50%; flex: none;
  display: grid; place-items: center; font-size: 12px; font-weight: 600;
  background: var(--color-accent-2-200); color: var(--color-accent-2-800);
}
.turn-operator .turn-av { background: var(--color-accent-200); color: var(--color-accent-800); }
.turn-head { display: flex; align-items: baseline; gap: var(--space-2); margin-bottom: var(--space-2); }
.turn-who { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size: 14px; }
.turn-when { font-size: 11.5px; font-family: var(--font-mono); color: color-mix(in srgb, var(--color-text) 48%, transparent); }
.bubble {
  background: var(--color-surface); border-radius: calc(var(--radius-lg) * 1.15);
  padding: var(--space-3) var(--space-4); font-size: 14.5px; line-height: 1.6;
}
.turn-operator .bubble { background: var(--color-accent-100); }
.turn-failed .bubble { background: var(--color-accent-100); outline: 1px solid var(--color-accent-300); outline-offset: -1px; }
.turn-p { margin: 0; white-space: pre-wrap; }
.turn-p + .turn-p { margin-top: var(--space-2); }
.turn-empty { margin: 0; color: var(--color-muted); }
/* The closed markdown subset (view/richText.ts). Code scrolls inside its own
   box so a long command never makes the page scroll sideways. */
.turn-code {
  margin: var(--space-2) 0 0; padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--color-text) 5%, transparent);
  border-radius: var(--radius-md); overflow-x: auto;
  font-family: var(--font-mono); font-size: 12.5px; line-height: 1.55;
}
.turn-code > code { white-space: pre; }
.bubble code.mono {
  padding: 1px 5px; border-radius: 5px; font-size: 0.9em;
  background: color-mix(in srgb, var(--color-text) 7%, transparent);
}
.turn-list { margin: var(--space-2) 0 0; padding-left: 1.15em; }
.turn-list > li { margin: 0; }
.turn-list > li + li { margin-top: 3px; }
.turn-p + .turn-code, .turn-p + .turn-list { margin-top: var(--space-2); }
.turn-marks { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }

/* A notice: the same left edge, a dot instead of an avatar, and no bubble.
   Flat rather than boxed on purpose — a card per tool call stops the column
   reading as a conversation (view/chat.ts on renderNotice). */
.turn-notice { align-items: start; }
.turn-av-notice { background: none; width: 34px; height: 22px; }
.notice-line { display: flex; align-items: baseline; gap: var(--space-2); min-height: 22px; }
.notice-text { font-size: 13px; color: color-mix(in srgb, var(--color-text) 66%, transparent); }
.notice-detail { margin-top: 2px; }
.notice-detail > summary { font-size: 12px; color: var(--color-muted); cursor: pointer; list-style: none; display: flex; align-items: center; gap: 4px; }
.notice-detail > summary::-webkit-details-marker { display: none; }
/* 还在跑：一个静止的陶土色点。**刻意不做脉动** —— 这份样式表的动效纪律是
   「只有 ≤200ms 的 transition，一个关键帧动画都没有」（view.test.ts 钉着，
   而它是按整份样式表做字面查找的——连这行注释也不能写出那个 at-rule 的名字），
   而一个会呼吸的点是装饰，不是这条尾巴要说的那件事：说话的是「还在跑」四个字
   和旁边那个一直在涨的秒数。 */
.tail-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-accent-500); }
.turn-tail .notice-text { color: color-mix(in srgb, var(--color-text) 52%, transparent); }
.notice-detail-body { margin: var(--space-2) 0 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; color: color-mix(in srgb, var(--color-text) 72%, transparent); }

/* The delivery chain: three facts and the links between them. */
.chain { display: inline-flex; align-items: center; gap: 0; }
.chain .lnk { width: 14px; height: 3px; border-radius: 999px; background: var(--color-neutral-300); flex: none; }
.chain .lnk.done { background: var(--color-accent-2-400); }

/* The composer never scrolls and is never replaced — it holds half-typed text. */
.composer {
  flex: 0 0 auto;
  background: var(--color-surface); border-radius: calc(var(--radius-lg) * 1.15);
  padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3);
  box-shadow: var(--shadow-sm);
}
.composer:focus-within { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.composer textarea {
  background: transparent; border: 0; padding: 0; width: 100%;
  min-height: 54px; max-height: 220px;
  font: inherit; font-family: var(--font-body); font-size: 14.5px; line-height: 1.6;
  resize: none; color: var(--color-text); caret-color: var(--color-accent);
}
.composer textarea:focus-visible { outline: none; }
.composer-foot { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.composer-foot .sel { display: inline-block; }
.composer-foot .sel > select { width: auto; min-width: 230px; max-width: 100%; }
.send { margin-left: auto; }

/* ---- /login: one panel, and two blobs in the air behind it ---- */
.stage {
  position: relative; overflow: hidden; min-height: 100vh;
  display: grid; place-items: center; padding: var(--space-8);
}
.deco-a { position: absolute; left: -120px; top: -90px; pointer-events: none; }
.deco-b { position: absolute; right: -140px; bottom: -120px; pointer-events: none; }
.panel {
  position: relative; width: min(460px, 100%); margin: auto;
  padding: var(--space-8); border-radius: calc(var(--radius-lg) * 1.4);
  display: flex; flex-direction: column; gap: var(--space-4);
}
.panel .brand-cn { font-size: 40px; line-height: 1.05; }
.panel .brand-en { font-size: 12px; }
.tokline {
  display: flex; flex-direction: column; gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  background: var(--color-neutral-100); border-radius: var(--radius-lg);
}
.tokrow { display: flex; align-items: center; gap: var(--space-2); font-size: 12.5px; color: var(--color-quiet); }
.tokrow .tag { flex: none; }
.foot { font-size: 11.5px; color: color-mix(in srgb, var(--color-text) 50%, transparent); }

/* ---- narrow ---- */
@media (max-width: 1000px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .side { position: static; height: auto; }
  .g4 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .row > summary { grid-template-columns: minmax(0, 1fr) auto; row-gap: var(--space-2); }
  .row-panel, .form-grid, .limits, .adv-body { grid-template-columns: minmax(0, 1fr); }
  .empty { grid-template-columns: minmax(0, 1fr); }
  .empty-art { justify-self: start; }
}
@media (max-width: 620px) {
  .shell { padding: var(--space-2); gap: var(--space-2); }
  .main, .chat-main { padding: var(--space-1); }
  .g4 { grid-template-columns: minmax(0, 1fr); }
  .turn { grid-template-columns: minmax(0, 1fr); }
  .turn-av { display: none; }
  .empty { padding: var(--space-6) var(--space-2); }
  .stage { padding: var(--space-4); }
  .panel { padding: var(--space-6); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; }
}
`
