// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/chat` page's client. Same three permissions as `client.ts`, no more.
 *
 * 1. Fetch server-rendered fragments and put them on the page. `innerHTML` is
 *    assigned exactly two things, both of them markup the view layer escaped on
 *    the way out (`view/chat.ts`).
 * 2. `POST` JSON. Every response string — including every error — reaches the
 *    page through `textContent`.
 * 3. Carry the token in an `Authorization` header, and the console header on
 *    every request — with a cookie session that header is what the server
 *    requires, and a cross-origin page cannot set it (`auth.ts`, `client.ts`).
 *
 * ## Switching sessions is a swap, not a navigation
 *
 * Opening a conversation replaces the sessions rail and the thread fragment
 * and rewrites the address bar with `history.replaceState`, instead of
 * navigating to `/chat?session=<id>`: a top-level navigation carries no
 * `Authorization` header, and by the time a session could be switched the
 * token has already been scrubbed out of the address bar, so navigating
 * there would 401 on arrival. See `openSession` for the mechanics. The server
 * renders the whole page only on first entry, or whenever a link naming
 * `?session=` is opened directly.
 *
 * ## The stream, and what happens when it is not there
 *
 * `GET /v0/chat/stream` is an `EventSource`. `EventSource` cannot send headers,
 * so the token rides on the query string — the second position `auth.ts`
 * already accepts, and the reason it accepts it. Every event is a bare
 * `{sessionId, revision}`; the page answers it by refetching the fragments,
 * which keeps "the server renders HTML, the client renders text" true on the
 * streaming face too.
 *
 * When the stream cannot be opened — no `EventSource`, a proxy that buffers, a
 * server that dropped it — the page falls back to polling the same two
 * fragments every two seconds and says so in the sidebar. The fallback is not a
 * degraded mode nobody tests: it is the only path when the browser is old, and
 * `?stream=off` forces it for exactly that reason.
 */

import { CONSOLE_HEADER, CONSOLE_HEADER_VALUE } from '../auth.js'
import { PERSONAL_GUARDS, type TokenGuards } from './client.js'

function chatScript(guards: TokenGuards): string {
  return `
(function () {
  'use strict';

  var ROUTES = {
    sessions: '/fragments/chat/sessions',
    thread: '/fragments/chat/thread/',
    create: '/v0/chat/sessions',
    stream: '/v0/chat/stream'
  };
  var TOKEN_KEY = 'qianmo.console.token';
  var POLL_MS = 2000;
  var memoryToken = '';
  var pollTimer = null;
  var source = null;
  var active = '';
  var busy = false;

  function byId(id) { return document.getElementById(id); }

  function message(err) {
    return err && err.message ? String(err.message) : String(err);
  }

  function say(el, value, tone) {
    if (!el) return;
    el.textContent = value;
    el.setAttribute('data-tone', tone || 'muted');
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

  // Empty rather than 无令牌 when localStorage is bare: a cookie session is
  // invisible to this script (HttpOnly), and the sidebar's role chip is the
  // server-rendered answer to who this is.
  function paintToken() {
    var has = readToken() !== '';
    say(byId('token-state'), has ? '令牌已存' : '', has ? 'ok' : 'muted');
    paintCrossPageLink();
  }

  // Going back to the ledger page is a top-level navigation, which carries no
  // Authorization header; the token therefore rides in the query string, as it
  // does on the way in. See the same function in client.ts.
  function paintCrossPageLink() {
    var link = byId('to-console');
    if (!link) return;
    var token = readToken();
    link.setAttribute('href', token ? '/?token=' + encodeURIComponent(token) : '/');
  }

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

  // Always both, token or no token: the header is what a cookie session needs
  // and is ignored on a Bearer one. See client.ts.
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

  // The composer is not inside either fragment, so the two facts it shows —
  // which agent, and whether that agent is reachable — are copied off the
  // freshly rendered thread as text, never re-derived here.
  function paintComposer() {
    var thread = byId('chat-thread');
    var target = byId('composer-target');
    var text = byId('composer-state-text');
    var dot = byId('composer-dot');
    if (!thread) return;
    if (target) target.textContent = thread.getAttribute('data-target') || '—';
    if (text) text.textContent = thread.getAttribute('data-state') || '';
    if (dot) dot.className = 'dot dot-' + (thread.getAttribute('data-tone') || 'muted');
  }

  function atBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  function refreshThread(keepScroll) {
    var mount = byId('thread-mount');
    if (!mount || !active) return Promise.resolve();
    var stick = keepScroll === false ? true : atBottom(mount);
    return loadHtml(ROUTES.thread + encodeURIComponent(active)).then(function (html) {
      mount.innerHTML = html;
      paintComposer();
      if (stick) mount.scrollTop = mount.scrollHeight;
    });
  }

  function refreshSessions() {
    var mount = byId('chat-sessions');
    if (!mount) return Promise.resolve();
    var picker = byId('chat-target');
    var chosen = picker ? picker.value : '';
    var url = ROUTES.sessions + (active ? '?active=' + encodeURIComponent(active) : '');
    return loadHtml(url).then(function (html) {
      var current = byId('chat-sessions');
      if (!current) return;
      // Parsed in a detached template — inert, no script execution — and then
      // adopted, the same swap client.ts uses for the audit regions.
      var tpl = document.createElement('template');
      tpl.innerHTML = html;
      var next = tpl.content.querySelector('#chat-sessions');
      if (!next) return;
      current.replaceWith(next);
      // Restore whatever target was picked: the rail is replaced on every
      // event, and a picker that resets itself under the cursor is a picker
      // that opens a conversation with the wrong agent.
      var picked = byId('chat-target');
      if (picked && chosen) picked.value = chosen;
    });
  }

  function refreshAll(keepScroll) {
    return Promise.all([refreshThread(keepScroll), refreshSessions()]);
  }

  /* ---------------- actions ---------------- */

  function setComposerEnabled(on) {
    var box = byId('chat-text');
    var send = byId('chat-send');
    var why = byId('composer-why');
    if (box) box.disabled = !on;
    if (send) send.disabled = !on;
    if (why) why.hidden = on;
  }

  // Switching conversations swaps the two fragments and rewrites the address
  // bar. It deliberately does NOT navigate: on a Bearer session a top-level
  // navigation to /chat?session=... carries no Authorization header, so it
  // would 401 the moment the token was scrubbed out of the URL - which is the
  // first thing this page does on arrival. A cookie session would survive the
  // navigation, but a swap that works for one credential and reloads the whole
  // document for the other is two behaviours to keep true; everything after the
  // first load goes through fetch.
  function openSession(id) {
    if (!id || id === active) return;
    active = id;
    try {
      history.replaceState(null, '', '/chat?session=' + encodeURIComponent(id));
    } catch (e) { /* the address bar is cosmetic; the state is in the variable */ }
    setComposerEnabled(true);
    say(byId('chat-status'), '', 'muted');
    refreshAll(false).then(function () {
      var box = byId('chat-text');
      if (box) box.focus();
    });
  }

  function newSession() {
    var picker = byId('chat-target');
    var status = byId('chat-status');
    var target = picker ? picker.value : '';
    if (!target) { say(status, '先选一个智能体', 'bad'); return; }
    say(status, '新建会话…', 'muted');
    sendJson('POST', ROUTES.create, { target: target }).then(function (data) {
      if (data && data.id) openSession(String(data.id));
      else say(status, '新建失败 · 服务端没有返回会话', 'bad');
    }).catch(function (err) {
      say(status, '新建失败 · ' + message(err), 'bad');
    });
  }

  function send() {
    var box = byId('chat-text');
    var status = byId('chat-status');
    if (!box || busy) return;
    var text = box.value.trim();
    if (!text) return;
    if (!active) { say(status, '先选一条会话', 'bad'); return; }
    busy = true;
    box.disabled = true;
    say(status, '发送中…', 'muted');
    sendJson('POST', ROUTES.create + '/' + encodeURIComponent(active) + '/messages',
      { text: text }
    ).then(function () {
      box.value = '';
      autosize();
      say(status, '', 'muted');
      return refreshAll(false);
    }).catch(function (err) {
      say(status, '发送失败 · ' + message(err), 'bad');
    }).then(function () {
      busy = false;
      box.disabled = false;
      box.focus();
    });
  }

  /* ---------------- stream ---------------- */

  function startPolling(reason) {
    if (pollTimer) return;
    say(byId('stream-state'), reason, 'muted');
    pollTimer = setInterval(function () {
      if (!document.hidden) refreshAll();
    }, POLL_MS);
  }

  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function startStream() {
    var params = new URLSearchParams(window.location.search);
    if (params.get('stream') === 'off' || typeof window.EventSource !== 'function') {
      startPolling('轮询中');
      return;
    }
    var token = readToken();
    // EventSource cannot carry a header; auth.ts accepts ?token= for exactly
    // this reason. Same origin, and the URL never reaches the document.
    var url = ROUTES.stream + (token ? '?token=' + encodeURIComponent(token) : '');
    try { source = new EventSource(url); }
    catch (e) { startPolling('轮询中'); return; }

    source.addEventListener('open', function () {
      stopPolling();
      say(byId('stream-state'), '实时', 'ok');
    });
    source.addEventListener('chat', function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); } catch (e) { payload = null; }
      // A session other than the open one still moves the rail: its preview
      // and its "3 分钟前" are what tell the operator to go and look.
      if (payload && payload.sessionId && payload.sessionId !== active) {
        refreshSessions();
        return;
      }
      refreshAll();
    });
    source.addEventListener('error', function () {
      // EventSource retries on its own; the poller covers the gap and is
      // stopped again by the next 'open'.
      startPolling('轮询中 · 实时连接中断');
    });
  }

  /* ---------------- composer behaviour ---------------- */

  function autosize() {
    var box = byId('chat-text');
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = Math.min(box.scrollHeight, 220) + 'px';
  }

  /* ---------------- wiring ---------------- */

  document.addEventListener('click', function (event) {
    var origin = event.target;
    if (!origin || !origin.closest) return;
    var el = origin.closest('[data-action]');
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'chat-open') {
      event.preventDefault();
      openSession(el.getAttribute('data-session') || '');
    } else if (action === 'chat-new') {
      event.preventDefault();
      newSession();
    } else if (action === 'token-save') {
      event.preventDefault();
      var input = byId('token');
      if (input) { writeToken(input.value.trim()); input.value = ''; }
    } else if (action === 'token-clear') {
      event.preventDefault();
      writeToken('');
    }
  });

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (form && form.id === 'composer') { event.preventDefault(); send(); return; }
    // Native POST, deliberately not prevented - see client.ts. Only the
    // localStorage copy is dropped here; the cookie is the server's to clear.
    if (form && form.id === 'logout-form') writeToken('');
  });

  document.addEventListener('keydown', function (event) {
    if (event.target && event.target.id === 'chat-text') {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    }
  });

  document.addEventListener('input', function (event) {
    if (event.target && event.target.id === 'chat-text') autosize();
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshAll();
  });

  function start() {
    seedTokenFromUrl();
    paintToken();
    active = new URLSearchParams(window.location.search).get('session') || '';
    paintComposer();
    autosize();
    // The server already decided this on the first render; re-asserting it here
    // keeps one rule ("a session is open") rather than two that can disagree.
    setComposerEnabled(byId('chat-thread') !== null &&
      byId('chat-thread').getAttribute('data-session') !== null);
    var mount = byId('thread-mount');
    if (mount) mount.scrollTop = mount.scrollHeight;
    var box = byId('chat-text');
    if (box && !box.disabled) box.focus();
    startStream();
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
export const CONSOLE_CHAT_JS = chatScript({ read: '', write: '' })

/** The same script with the personal-credential guards (`client.ts`). */
export const CONSOLE_CHAT_JS_ACCOUNTS = chatScript(PERSONAL_GUARDS)
