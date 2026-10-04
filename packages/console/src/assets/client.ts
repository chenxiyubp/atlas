// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The entire client, as one string. Roughly 200 lines, no framework, no build.
 *
 * ## What it is allowed to do
 *
 * Three things, and the list is short on purpose:
 *
 * 1. **Poll for server-rendered fragments and put them on the page.** The
 *    fragments come out of `view/*.ts`, which escaped everything on the way
 *    out, so `innerHTML` here is putting back exactly what the server decided
 *    to emit. That is the *only* thing that is ever assigned to `innerHTML`.
 * 2. **Submit forms with `fetch`.** Bodies are JSON; every response message,
 *    including every error string, reaches the page through `textContent`.
 * 3. **Carry the token in an `Authorization` header.** Never in a query string,
 *    never rendered into the document.
 * 4. **Send the console header on every request.** See below.
 *
 * The dividing line worth stating out loud: **nothing derived from the URL, a
 * form field, or a JSON response body is ever concatenated into HTML.** The
 * server renders HTML; the client renders text. When those two rules are kept
 * apart there is no place for an injected string to become markup.
 *
 * ## The routes it expects
 *
 * These are the seams with the HTTP side. Written here in one table so a
 * mismatch is a one-line fix rather than a hunt:
 *
 * | call                                    | expects                     |
 * |-----------------------------------------|-----------------------------|
 * | `GET /fragments/roster`                 | `text/html`, `renderRoster` |
 * | `GET /fragments/audit?<filter>`         | `text/html`, `renderAudit`  |
 * | `GET /fragments/chain/<traceId>`        | `text/html`, `renderChain`  |
 * | `POST /v0/agents`                       | JSON                        |
 * | `POST /v0/agents/<address>/heartbeat`   | JSON                        |
 * | `DELETE /v0/agents/<address>`           | 204 or JSON                 |
 * | `POST /v0/wake`                         | JSON                        |
 * | `PUT /v0/servers/<server>/note`         | JSON                        |
 *
 * A non-HTML content type on the three fragment routes is treated as an error
 * rather than rendered — if the HTTP side ever answers those with JSON, the
 * page says so instead of pasting a JSON blob into the document.
 *
 * ## Why the audit refresh is a region swap
 *
 * Replacing the whole audit fragment every five seconds would replace the
 * filter form with it, eating whatever the operator was halfway through typing.
 * So the poller lifts `#audit-rail` (the `512 · 断裂 2` digits) and
 * `#audit-results` out of the fetched HTML through a detached `<template>`
 * (which parses but does not execute) and swaps only those two.
 *
 * ## The token arrives two ways
 *
 * `#token=` and `?token=`. The fragment never reaches the server and is the one
 * to prefer, but `occ console` prints its banner link with the query form, so a
 * client that only reads the fragment leaves anybody who followed that link
 * unauthenticated from the first poll onward. Either way it is stored and
 * scrubbed out of the address bar immediately.
 *
 * There is now a third way in that this script never sees: the login page sets
 * an `HttpOnly` cookie, which the browser attaches by itself and no script can
 * read. That is why every request below carries `CONSOLE_HEADER` whether or not
 * there is a token in `localStorage` — the server requires it of any cookie-
 * authenticated request that is not a plain document read, and a header a
 * cross-origin page cannot set is what makes an ambient credential safe
 * (`auth.ts`). Requests already carrying a `Bearer` pay one header for nothing,
 * which is cheaper than a rule with an exception in it.
 *
 * The token box stays, and so does `localStorage`: a `Bearer` still overrides
 * the cookie, which is what makes "look at this console as the other role for a
 * minute" possible without logging out.
 */

import { PERSONAL_CREDENTIAL_PREFIX } from '../accounts.js'
import { CONSOLE_HEADER, CONSOLE_HEADER_VALUE } from '../auth.js'

/**
 * What is spliced into the two token functions of both page scripts.
 *
 * Empty strings reproduce the scripts byte for byte as they were before
 * accounts (`test/legacyParity.test.ts` pins both). With accounts on, a
 * personal credential never reaches `localStorage` (`tenancy-m1.md` §3.3):
 * `writeToken` — the only function here that calls `setItem` — refuses a
 * value with the credential's prefix before it touches storage, whether it
 * came from `#token=`, `?token=` or the paste box, and `readToken` drops one
 * that is somehow already there. The legacy tokens keep the old behaviour for
 * as long as migration lasts.
 */
export interface TokenGuards {
  readonly read: string
  readonly write: string
}

const NO_GUARDS: TokenGuards = { read: '', write: '' }

export const PERSONAL_GUARDS: TokenGuards = {
  read:
    `\n    try { if ((window.localStorage.getItem(TOKEN_KEY) || '')` +
    `.indexOf('${PERSONAL_CREDENTIAL_PREFIX}') === 0) ` +
    `window.localStorage.removeItem(TOKEN_KEY); } catch (e) { /* none held */ }`,
  write:
    `\n    if (value && String(value).indexOf('${PERSONAL_CREDENTIAL_PREFIX}') === 0) {` +
    `\n      say(byId('token-state'), '个人凭据请在登录页填写', 'warn');` +
    `\n      return;` +
    `\n    }`,
}

function clientScript(guards: TokenGuards): string {
  return `
(function () {
  'use strict';

  var ROUTES = {
    roster: '/fragments/roster',
    audit: '/fragments/audit',
    // Markup, not JSON: /v0/audit/chain/ answers with the data and loadHtml
    // rejects anything that is not text/html.
    chain: '/fragments/chain/',
    agents: '/v0/agents',
    wake: '/v0/wake',
    servers: '/v0/servers'
  };
  var TOKEN_KEY = 'qianmo.console.token';
  var memoryToken = '';
  var refreshTimer = null;
  // What the open confirm dialog will do when its confirm button is pressed.
  var pending = null;

  function byId(id) { return document.getElementById(id); }

  function setText(id, value) {
    var el = byId(id);
    if (el) el.textContent = value;
  }

  function message(err) {
    return err && err.message ? String(err.message) : String(err);
  }

  function say(el, value, tone) {
    if (!el) return;
    el.textContent = value;
    el.setAttribute('data-tone', tone || 'muted');
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function stamp(d) {
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' +
      pad(d.getSeconds());
  }

  /* ---------------- confirm dialogs ---------------- */

  // Two irreversible actions, two dialogs, both rendered by the server and
  // filled in here with textContent. They live outside the polled roster
  // fragment on purpose: a dialog inside it would be replaced out from under
  // whoever is reading it, five seconds after it opened.
  function closeDialogs() {
    pending = null;
    var boxes = document.querySelectorAll('.dialog-backdrop');
    for (var i = 0; i < boxes.length; i++) boxes[i].hidden = true;
  }

  function openDialog(id, run) {
    var box = byId(id);
    if (!box) { run(); return; }
    pending = run;
    box.hidden = false;
    var confirm = box.querySelector('.dialog-actions .btn-primary, .dialog-actions .btn-danger');
    if (confirm) confirm.focus();
  }

  /* ---------------- token ---------------- */

  function readToken() {${guards.read}
    try { return window.localStorage.getItem(TOKEN_KEY) || ''; }
    catch (e) { return memoryToken; }
  }

  function writeToken(value) {${guards.write}
    memoryToken = value;
    try {
      if (value) window.localStorage.setItem(TOKEN_KEY, value);
      else window.localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* private mode: the in-memory copy is all we get */ }
    paintToken();
  }

  // Says nothing when there is no local token, because there may still be a
  // cookie session and this script cannot see it (HttpOnly). The sidebar's
  // role chip is the server-rendered answer to "who am I"; this line only ever
  // reports the localStorage copy.
  function paintToken() {
    var has = readToken() !== '';
    say(byId('token-state'), has ? '令牌已存' : '', has ? 'ok' : 'muted');
    paintCrossPageLink();
  }

  // The chat page is a second document, so reaching it is a top-level
  // navigation - and a navigation carries no Authorization header. So the link
  // gets the token in its query string, the same position the CLI banner uses
  // and the same one the destination scrubs out of the address bar on arrival.
  // Left alone when there is no token, which is now the ordinary case rather
  // than a broken one: a cookie session has nothing to sign the link with and
  // needs nothing, because the browser attaches the cookie to the navigation
  // (auth.ts). The unsigned link is therefore either authenticated by cookie or
  // an honest trip to the login page.
  function paintCrossPageLink() {
    var link = byId('to-chat');
    if (!link) return;
    var token = readToken();
    link.setAttribute('href', token ? '/chat?token=' + encodeURIComponent(token) : '/chat');
  }

  // A token handed over in the URL is stored and then wiped from the address
  // bar: it must not sit in history, in a screenshot of the URL bar, or in
  // whatever the operator pastes into a chat window next.
  //
  // Both spellings are read. The fragment (#token=) is the safer one - it never
  // reaches the server - but the banner "occ console" prints links with
  // ?token=, which is also what auth.ts accepts on the request, so a page
  // opened from that banner has to seed itself too or the first poll 401s.
  function seedTokenFromUrl() {
    var found = '';
    var hash = window.location.hash || '';
    if (hash.length > 1 && hash.indexOf('token=') !== -1) {
      found = new URLSearchParams(hash.slice(1)).get('token') || '';
    }
    var search = window.location.search || '';
    if (!found && search.indexOf('token=') !== -1) {
      found = new URLSearchParams(search).get('token') || '';
    }
    if (!found) return;
    writeToken(found);
    try {
      var rest = new URLSearchParams(search);
      rest.delete('token');
      var query = rest.toString();
      history.replaceState(null, '', window.location.pathname + (query ? '?' + query : ''));
    } catch (e) { window.location.hash = ''; }
  }

  // The console header rides on everything, token or no token: with a cookie
  // session it is what the server requires (a cross-origin page cannot set it
  // without a preflight this server never answers), and with a Bearer it is one
  // ignored header. A conditional here would be a rule with an exception.
  function authHeaders(extra) {
    var headers = extra || {};
    var token = readToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    headers['${CONSOLE_HEADER}'] = '${CONSOLE_HEADER_VALUE}';
    return headers;
  }

  /* ---------------- transport ---------------- */

  function loadHtml(url) {
    return fetch(url, {
      headers: authHeaders(),
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var type = res.headers.get('content-type') || '';
      if (type.indexOf('text/html') === -1) {
        throw new Error('响应非 HTML · ' + type);
      }
      return res.text();
    });
  }

  function sendJson(method, url, body) {
    var init = {
      method: method,
      credentials: 'same-origin',
      headers: authHeaders(body === undefined ? {} : { 'Content-Type': 'application/json' })
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    return fetch(url, init).then(function (res) {
      if (res.status === 204) return null;
      return res.text().then(function (raw) {
        var data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (e) { data = null; }
        if (!res.ok) {
          // http.ts answers { error: { code, message } }. Reaching for
          // data.error directly puts "[object Object]" on the page, which is
          // the one message an operator can do nothing with.
          var err = data && data.error;
          var detail = (err && err.message) || (data && data.message) ||
            (typeof err === 'string' ? err : '');
          throw new Error(detail ? String(detail) : 'HTTP ' + res.status);
        }
        return data;
      });
    });
  }

  /* ---------------- fragments ---------------- */

  // The fetched HTML is parsed in a detached template: inert, no script
  // execution, nothing touches the live document until a node is adopted.
  function swapRegions(html, ids) {
    var tpl = document.createElement('template');
    tpl.innerHTML = html;
    var swapped = 0;
    for (var i = 0; i < ids.length; i++) {
      var next = tpl.content.querySelector('#' + ids[i]);
      var current = byId(ids[i]);
      if (next && current) { current.replaceWith(next); swapped += 1; }
    }
    return swapped;
  }

  function refreshRoster() {
    return loadHtml(ROUTES.roster).then(function (html) {
      var mount = byId('roster');
      if (mount) mount.innerHTML = html;
    });
  }

  function refreshAudit() {
    var mount = byId('audit');
    if (!mount) return Promise.resolve();
    var query = mount.getAttribute('data-query') || '';
    return loadHtml(ROUTES.audit + (query ? '?' + query : '')).then(function (html) {
      // The header digits change with every poll and the results below them
      // do too; the filter form between them must not, so only those two swap.
      // The audit-rail id is what the header region has always been called and
      // stays that way — it is a selector, not a description.
      if (swapRegions(html, ['audit-rail', 'audit-results']) === 0) {
        mount.innerHTML = html;
      }
    });
  }

  function tick() {
    var state = byId('refresh-state');
    return Promise.all([refreshRoster(), refreshAudit()]).then(function () {
      say(state, '更新于 ' + stamp(new Date()), 'muted');
    }).catch(function (err) {
      say(state, '刷新失败 · ' + message(err), 'bad');
    });
  }

  function schedule() {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
    var toggle = byId('auto-refresh');
    var picker = byId('refresh-interval');
    var on = toggle ? toggle.checked : false;
    var ms = picker ? parseInt(picker.value, 10) : 5000;
    if (!on || !(ms > 0)) { say(byId('refresh-state'), '已暂停', 'muted'); return; }
    refreshTimer = setInterval(function () {
      // A background tab polling every five seconds is a background tab
      // holding a socket open for nobody to look at.
      if (!document.hidden) tick();
    }, ms);
    // The interval is already shown by the select beside this; repeating it
    // here would just be a second copy of the same number.
    say(byId('refresh-state'), '', 'muted');
  }

  /* ---------------- forms ---------------- */

  function fieldValue(form, name) {
    var el = form.elements[name];
    return el && typeof el.value === 'string' ? el.value.trim() : '';
  }

  // Capabilities are four checkboxes sharing one name, so the value is every
  // ticked box rather than one string to split. The server still accepts the
  // comma-separated form an older client would have sent.
  function checkedValues(form, name) {
    var out = [];
    var nodes = form.querySelectorAll('input[name="' + name + '"]:checked');
    for (var i = 0; i < nodes.length; i++) out.push(nodes[i].value);
    return out;
  }

  function onRegister(form) {
    var status = byId('register-status');
    var address = fieldValue(form, 'address');
    var endpoint = fieldValue(form, 'endpoint');
    if (!address || !endpoint) {
      say(status, '地址与端点必填', 'bad');
      return;
    }
    var body = {
      address: address,
      endpoint: endpoint,
      capabilities: checkedValues(form, 'capabilities'),
      status: fieldValue(form, 'status') || 'online'
    };
    var key = fieldValue(form, 'publicKey');
    if (key) body.publicKey = key;
    say(status, '注册中…', 'muted');
    sendJson('POST', ROUTES.agents, body).then(function () {
      say(status, '已注册 ' + address, 'ok');
      form.reset();
      return refreshRoster();
    }).catch(function (err) {
      say(status, '注册失败 · ' + message(err), 'bad');
    });
  }

  // The 回调 field is gone from the form: the console can only ever wake the
  // one URL it was started with, so url is left out of the body entirely and
  // the server falls back to the pinned one.
  function onWake(form) {
    var status = byId('wake-status');
    var body = {
      from: fieldValue(form, 'from'),
      to: fieldValue(form, 'to'),
      prompt: fieldValue(form, 'prompt')
    };
    var node = fieldValue(form, 'node');
    if (node) body.node = node;
    var after = fieldValue(form, 'afterMs');
    if (after) body.afterMs = Number(after);
    if (!body.from || !body.to || !body.prompt) {
      say(status, '发起方 目标与提示词必填', 'bad');
      return;
    }
    setText('confirm-wake-to', body.to);
    setText('confirm-wake-from', body.from);
    setText('confirm-wake-after', (body.afterMs || 0) + ' ms');
    setText('confirm-wake-prompt', body.prompt);
    openDialog('confirm-wake', function () { doWake(body); });
  }

  function doWake(body) {
    var status = byId('wake-status');
    say(status, '唤醒中…', 'muted');
    sendJson('POST', ROUTES.wake, body).then(function (data) {
      var receipt = data && data.receipt ? String(data.receipt) : '';
      var task = data && data.taskId ? String(data.taskId) : '';
      // The button says 唤醒, so the result says 已唤醒. An operator should not
      // have to work out whether 已发送 is the same event they asked for.
      say(status, '已唤醒 · task ' + task + (receipt ? ' · 回执 ' + receipt : ''), 'ok');
    }).catch(function (err) {
      say(status, '唤醒失败 · ' + message(err), 'bad');
    });
  }

  function onAgentAction(action, address) {
    var status = byId('register-status');
    if (action === 'heartbeat') {
      say(status, '心跳 ' + address + '…', 'muted');
      sendJson('POST', ROUTES.agents + '/' + encodeURIComponent(address) + '/heartbeat')
        .then(function () {
          say(status, '已心跳 ' + address, 'ok');
          return refreshRoster();
        })
        .catch(function (err) { say(status, '心跳失败 · ' + message(err), 'bad'); });
      return;
    }
    if (action === 'deregister') {
      setText('confirm-deregister-addr', address);
      openDialog('confirm-deregister', function () { doDeregister(address); });
    }
  }

  function doDeregister(address) {
    var status = byId('register-status');
    say(status, '注销 ' + address + '…', 'muted');
    sendJson('DELETE', ROUTES.agents + '/' + encodeURIComponent(address))
      .then(function () {
        say(status, '已注销 ' + address, 'ok');
        return refreshRoster();
      })
      .catch(function (err) { say(status, '注销失败 · ' + message(err), 'bad'); });
  }

  // The servers section is the one block the poller never replaces, because it
  // holds a textarea somebody may be mid-sentence in. So a save reports itself
  // in place, through the status line beside the button, and nothing on the
  // page is re-fetched afterwards.
  function onServerNote(el) {
    var card = el.closest('[data-server]');
    var server = el.getAttribute('data-server') || '';
    if (!card || !server) return;
    var box = card.querySelector('textarea[name="note"]');
    var status = card.querySelector('[data-role="note-status"]');
    if (!box) return;
    say(status, '保存中…', 'muted');
    sendJson('PUT', ROUTES.servers + '/' + encodeURIComponent(server) + '/note',
      { note: box.value })
      .then(function () { say(status, '已保存 ' + stamp(new Date()), 'ok'); })
      .catch(function (err) { say(status, '保存失败 · ' + message(err), 'bad'); });
  }

  function openChain(trace, node) {
    var panel = byId('chain');
    if (!panel || !trace) return;
    var path = ROUTES.chain + encodeURIComponent(trace);
    if (node) path += '?node=' + encodeURIComponent(node);
    loadHtml(path).then(function (html) {
      panel.innerHTML = html;
      panel.hidden = false;
      panel.scrollIntoView({ block: 'nearest' });
    }).catch(function (err) {
      // textContent, never innerHTML: this string can carry a server message.
      panel.textContent = '消息链加载失败 · ' + message(err);
      panel.hidden = false;
    });
  }

  /* ---------------- wiring ---------------- */

  document.addEventListener('click', function (event) {
    var origin = event.target;
    if (!origin || !origin.closest) return;
    var el = origin.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'heartbeat' || action === 'deregister') {
      event.preventDefault();
      onAgentAction(action, el.getAttribute('data-address') || '');
    } else if (action === 'server-note') {
      event.preventDefault();
      onServerNote(el);
    } else if (action === 'chain') {
      event.preventDefault();
      openChain(
        el.getAttribute('data-trace') || '',
        el.getAttribute('data-audit-node') || ''
      );
    } else if (action === 'chain-close') {
      event.preventDefault();
      var panel = byId('chain');
      if (panel) { panel.hidden = true; panel.textContent = ''; }
    } else if (action === 'token-save') {
      event.preventDefault();
      var input = byId('token');
      if (input) { writeToken(input.value.trim()); input.value = ''; }
    } else if (action === 'token-clear') {
      event.preventDefault();
      writeToken('');
    } else if (action === 'confirm-cancel') {
      event.preventDefault();
      closeDialogs();
    } else if (action === 'confirm-deregister' || action === 'confirm-wake') {
      event.preventDefault();
      var run = pending;
      closeDialogs();
      if (run) run();
    }
  });

  // Escape closes an open dialog. A confirmation nobody can back out of with
  // the key every dialog on the machine uses is a confirmation people click
  // through to make it go away.
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && pending) {
      event.preventDefault();
      closeDialogs();
    }
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.id) return;
    // Not prevented: the native POST is what clears the cookie, and it works
    // with this script disabled. All that is added is dropping the
    // localStorage copy - leaving it behind would mean the next visit sends a
    // Bearer for a token the operator just walked away from.
    if (form.id === 'logout-form') { writeToken(''); return; }
    if (form.id === 'register-form') { event.preventDefault(); onRegister(form); return; }
    if (form.id === 'wake-form') { event.preventDefault(); onWake(form); return; }
    if (form.id === 'audit-filter') {
      // Let the native GET through, but drop the empty boxes so the resulting
      // URL is the shortest thing that reproduces this view.
      var controls = form.querySelectorAll('input, select');
      for (var i = 0; i < controls.length; i++) {
        if (controls[i].value === '') controls[i].disabled = true;
      }
    }
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && refreshTimer) tick();
  });

  function start() {
    seedTokenFromUrl();
    paintToken();
    var toggle = byId('auto-refresh');
    var picker = byId('refresh-interval');
    if (toggle) toggle.addEventListener('change', schedule);
    if (picker) picker.addEventListener('change', schedule);
    schedule();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`
}

/** The script as it has always been: what a console without accounts serves. */
export const CONSOLE_CLIENT_JS = clientScript(NO_GUARDS)

/**
 * The same script for a console with accounts: identical but for the two
 * guards that keep a personal credential out of `localStorage`.
 */
export const CONSOLE_CLIENT_JS_ACCOUNTS = clientScript(PERSONAL_GUARDS)
