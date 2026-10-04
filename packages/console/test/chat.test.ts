// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat face: the two view functions, the page, and every route behind them.
 *
 * **Zero `mock.module`** — `ChatPort` is an interface for exactly this reason,
 * so the whole surface is driven by a hand-written fake (root CLAUDE.md,
 * "Mock 卫生"). The stream is exercised against the real `ReadableStream` the
 * handler returns, not a stub of it: teardown is the part of an SSE route that
 * actually goes wrong.
 */

import { describe, expect, test } from 'bun:test'
import type { ConsoleTokens } from '../src/auth.js'
import type {
  ChatPort,
  ChatSendInput,
  ChatSession,
  ChatTarget,
  ChatTranscript,
  ChatTurn,
  ChatUpdate,
  ConsoleDeps,
  ConsoleFailure,
  ConsoleResult,
  LimitsSnapshot,
  RegistryPort,
  AuditPort,
} from '../src/deps.js'
import { createConsoleHandler } from '../src/http.js'
import {
  MAX_CHAT_TEXT_LENGTH,
  renderChatSessions,
  renderChatThread,
} from '../src/view/chat.js'
import { renderChatPage } from '../src/view/chatPage.js'

const VIEW = 'view-token-000000000001'
const ADMIN = 'admin-token-00000000001'
const TOKENS: ConsoleTokens = { view: VIEW, admin: ADMIN }

const NOW = 1_700_000_000_000
const TARGET = 'qianmo://node-b/reviewer'

const LIMITS: LimitsSnapshot = {
  protocol: {
    maxMessageBytes: 262_144,
    maxHops: 8,
    defaultTtlMs: 30_000,
    defaultTaskTtlMs: 600_000,
    ratePerMinute: 60,
  },
  runtime: { capacity: 20, windowMs: 1_000 },
  registryTtlMs: 90_000,
}

function ok<T>(value: T): ConsoleResult<T> {
  return { ok: true, value }
}

function bad(
  code: ConsoleFailure['code'],
  message: string,
): ConsoleResult<never> {
  return { ok: false, failure: { code, message } }
}

const SESSION: ChatSession = {
  id: 'session-1',
  target: TARGET,
  node: 'node-b',
  agent: 'reviewer',
  createdAt: NOW - 60_000,
  updatedAt: NOW - 1_000,
  turnCount: 2,
  preview: '好的，我看过了',
}

const ASK: ChatTurn = {
  id: 'turn-1',
  sessionId: SESSION.id,
  author: 'operator',
  at: NOW - 5_000,
  text: '看一下 packages/router 的速率表',
  state: 'read',
  taskId: 'abcdef0123456789',
  traceId: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
  receipt: 'accepted',
  receiptMs: 42,
  readMs: 1_200,
}

const ANSWER: ChatTurn = {
  id: 'turn-2',
  sessionId: SESSION.id,
  author: 'agent',
  at: NOW - 1_000,
  text: '好的，我看过了',
  state: 'done',
  taskId: 'abcdef0123456789',
  elapsedMs: 4_100,
}

const NOTICE: ChatTurn = {
  id: 'turn-notice',
  sessionId: SESSION.id,
  author: 'agent',
  at: NOW - 3_000,
  text: '读了 packages/router/src/rate.ts',
  state: 'done',
  variant: 'notice',
  severity: 'info',
  detail: '命中 3 处',
}

const TARGETS: readonly ChatTarget[] = [
  {
    address: TARGET,
    node: 'node-b',
    agent: 'reviewer',
    endpoint: 'ws://127.0.0.1:38612',
    status: 'online',
    dialable: true,
  },
  {
    address: 'qianmo://node-c/stranger',
    node: 'node-c',
    agent: 'stranger',
    endpoint: 'ws://10.0.0.9:38611',
    status: 'online',
    dialable: false,
  },
]

class FakeChat implements ChatPort {
  targetsResult: ConsoleResult<readonly ChatTarget[]> = ok(TARGETS)
  sessionsResult: ConsoleResult<readonly ChatSession[]> = ok([SESSION])
  transcriptResult: ConsoleResult<ChatTranscript> = ok({
    session: SESSION,
    turns: [ASK, ANSWER],
  })
  openResult: ConsoleResult<ChatSession> = ok(SESSION)
  sendResult: ConsoleResult<ChatTurn> = ok(ASK)
  readonly opened: string[] = []
  readonly sent: ChatSendInput[] = []
  readonly asked: string[] = []
  readonly listeners = new Set<(update: ChatUpdate) => void>()

  targets(): Promise<ConsoleResult<readonly ChatTarget[]>> {
    return Promise.resolve(this.targetsResult)
  }

  sessions(): Promise<ConsoleResult<readonly ChatSession[]>> {
    return Promise.resolve(this.sessionsResult)
  }

  open(target: string): Promise<ConsoleResult<ChatSession>> {
    this.opened.push(target)
    return Promise.resolve(this.openResult)
  }

  transcript(sessionId: string): Promise<ConsoleResult<ChatTranscript>> {
    this.asked.push(sessionId)
    return Promise.resolve(this.transcriptResult)
  }

  send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>> {
    this.sent.push(input)
    return Promise.resolve(this.sendResult)
  }

  subscribe(listener: (update: ChatUpdate) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(update: ChatUpdate): void {
    for (const listener of this.listeners) listener(update)
  }
}

class SilentRegistry implements RegistryPort {
  list(): Promise<ConsoleResult<readonly never[]>> {
    return Promise.resolve(ok([]))
  }

  register(): Promise<ConsoleResult<never>> {
    return Promise.resolve(bad('unsupported', 'not used here'))
  }

  deregister(): Promise<ConsoleResult<void>> {
    return Promise.resolve(bad('unsupported', 'not used here'))
  }

  heartbeat(): Promise<ConsoleResult<never>> {
    return Promise.resolve(bad('unsupported', 'not used here'))
  }
}

class SilentAudit implements AuditPort {
  read(): Promise<ConsoleResult<never>> {
    return Promise.resolve(bad('unsupported', 'not used here'))
  }

  chain(): Promise<ConsoleResult<null>> {
    return Promise.resolve(ok(null))
  }
}

function depsWith(chat?: ChatPort): ConsoleDeps {
  return {
    registry: new SilentRegistry() as unknown as RegistryPort,
    audit: new SilentAudit() as unknown as AuditPort,
    limits: LIMITS,
    now: () => NOW,
    label: '测试台',
    ...(chat === undefined ? {} : { chat }),
  }
}

function get(path: string, token = ADMIN): Request {
  return new Request(`http://127.0.0.1${path}`, {
    headers: { authorization: `Bearer ${token}` },
  })
}

function post(path: string, body: unknown, token = ADMIN): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

describe('chat transcript view', () => {
  test('renders each turn once, with the author label taken from the address', () => {
    const html = renderChatThread({
      transcript: { session: SESSION, turns: [ASK, ANSWER] },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    expect(html).toContain('看一下 packages/router 的速率表')
    expect(html).toContain('好的，我看过了')
    // 名字来自地址的 agent 段，不是另存的一份显示名。
    expect(html).toContain('>reviewer<')
    expect(html).toContain('>你<')
    expect(html).toContain('turn-operator')
    expect(html).toContain('turn-agent')
  })

  test('a notice is a hairline row, not a bubble', () => {
    const html = renderChatThread({
      transcript: { session: SESSION, turns: [ASK, NOTICE, ANSWER] },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    expect(html).toContain('读了 packages/router/src/rate.ts')
    expect(html).toContain('turn-notice')
    // 过程行没有 bubble、没有作者名、没有投递状态链——它不是这台控制台发出去
    // 的一轮，是对面推过来的一条既成事实。
    const notice = html.slice(
      html.indexOf('turn-notice'),
      html.indexOf('turn-agent', html.indexOf('turn-notice')),
    )
    expect(notice).not.toContain('bubble')
    expect(notice).not.toContain('turn-who')
    expect(notice).not.toContain('chain')
    // detail 折起来，不把回复顶下去。
    expect(notice).toContain('notice-detail')
    expect(notice).toContain('命中 3 处')
  })

  test('the tail says a turn is still running, and reads that off the transcript', () => {
    // 操作者那一轮停在 `read` 就不再前进——回答是**新的一轮**，不是旧那一轮的
    // 一个状态。所以「最后一条非过程行是操作者的」正好就是「还没人答」。
    const html = renderChatThread({
      transcript: { session: SESSION, turns: [ASK, NOTICE] },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    expect(html).toContain('turn-tail')
    expect(html).toContain('还在跑')
    // 过程行不算「答了」：一轮正在产出过程时，是它最像在跑的时候。
    expect(html.indexOf('turn-tail')).toBeGreaterThan(
      html.indexOf('turn-notice'),
    )
  })

  test('the tail is gone once an answer or a failure lands', () => {
    const answered = renderChatThread({
      transcript: { session: SESSION, turns: [ASK, NOTICE, ANSWER] },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    expect(answered).not.toContain('turn-tail')

    const failed = renderChatThread({
      transcript: {
        session: SESSION,
        turns: [{ ...ASK, state: 'failed' }],
      },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    expect(failed).not.toContain('turn-tail')
  })

  test('severity picks a colour and nothing else — no notice is filtered out', () => {
    const turns: readonly ChatTurn[] = [
      { ...NOTICE, id: 'n-info', severity: 'info' },
      { ...NOTICE, id: 'n-warn', severity: 'warn', text: '重试第 2 次' },
      { ...NOTICE, id: 'n-error', severity: 'error', text: '工具退出码 1' },
    ]
    const html = renderChatThread({
      transcript: { session: SESSION, turns },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    // 三条都在。被过滤掉的一条过程，和从来没发生过的一步，在页面上长得一模一样。
    expect(html).toContain('重试第 2 次')
    expect(html).toContain('工具退出码 1')
    expect(html).toContain('dot-muted')
    expect(html).toContain('dot-warn')
    expect(html).toContain('dot-bad')
  })

  test('a notice escapes on the way out like every other remote string', () => {
    const html = renderChatThread({
      transcript: {
        session: SESSION,
        turns: [
          {
            ...NOTICE,
            text: '<script>alert(1)</script>',
            detail: '<img src=x onerror=alert(2)>',
          },
        ],
      },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    // 判据是尖括号被转义，不是「页面里不出现 onerror 这几个字母」——转义之后
    // 它就是一段谁也执行不了的文本，而按字面禁词判会把一条正确的实现判成红的。
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;')
  })

  test('shows delivery, read and elapsed as three separate pills', () => {
    const html = renderChatThread({
      transcript: { session: SESSION, turns: [ASK, ANSWER] },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    // 「投递了」「被读了」「答完了」是三个不同的网络事件，不能塌成一个勾。
    expect(html).toContain('已投递 · 回执 accepted')
    expect(html).toContain('已读')
    expect(html).toContain('用时')
    expect(html).toContain('task abcdef01')
    expect(html).toContain('链 0af76519')
  })

  test('tells "not in the roster" apart from "the roster is unreachable"', () => {
    const absent = renderChatThread({
      transcript: { session: SESSION, turns: [] },
      failure: null,
      target: null,
      now: NOW,
    })
    expect(absent).toContain('不在名册')

    const down = renderChatThread({
      transcript: { session: SESSION, turns: [] },
      failure: null,
      target: null,
      registryDown: true,
      now: NOW,
    })
    expect(down).toContain('名册不可达')
    expect(down).not.toContain('不在名册')
  })

  test('marks a target whose endpoint is off the allow list', () => {
    const html = renderChatThread({
      transcript: { session: SESSION, turns: [] },
      failure: null,
      target: TARGETS[1] ?? null,
      now: NOW,
    })
    expect(html).toContain('端点不在允许名单')
  })

  test('escapes agent output rather than trusting it', () => {
    const hostile: ChatTurn = {
      ...ANSWER,
      text: '<img src=x onerror="alert(1)">',
    }
    const html = renderChatThread({
      transcript: { session: SESSION, turns: [hostile] },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
  })

  test('carries the composer facts as data attributes, not as a second render', () => {
    const html = renderChatThread({
      transcript: { session: SESSION, turns: [] },
      failure: null,
      target: TARGETS[0] ?? null,
      now: NOW,
    })
    expect(html).toContain(`data-target="${TARGET}"`)
    expect(html).toContain('data-state="在线"')
    expect(html).toContain('data-tone="ok"')
    expect(html).toContain(`data-session="${SESSION.id}"`)
  })

  test('renders a port failure as a strip, not as an empty transcript', () => {
    const html = renderChatThread({
      transcript: null,
      failure: { code: 'not_found', message: '这条会话不在本控制台的记录里' },
      target: null,
      now: NOW,
    })
    expect(html).toContain('会话未找到')
    expect(html).not.toContain('data-session=')
  })

  test('says what to do when nothing is open', () => {
    const html = renderChatThread({
      transcript: null,
      failure: null,
      target: null,
      now: NOW,
    })
    expect(html).toContain('还没有打开会话')
  })
})

describe('chat session rail', () => {
  test('groups by target and marks the open one', () => {
    const other: ChatSession = {
      ...SESSION,
      id: 'session-2',
      updatedAt: NOW - 30_000,
      preview: '另一个话题',
    }
    const html = renderChatSessions({
      sessions: [SESSION, other],
      targets: TARGETS,
      failure: null,
      activeId: 'session-2',
      now: NOW,
    })
    // 同一个目标下两条会话 = 一个分组、两行。
    expect(html.match(/chat-group-name/g)).toHaveLength(1)
    expect(html.match(/data-action="chat-open"/g)).toHaveLength(2)
    expect(html).toContain('chat-item-active')
    expect(html).toContain('aria-current="true"')
    expect(html).toContain('另一个话题')
  })

  test('offers only dialable targets as choosable', () => {
    const html = renderChatSessions({
      sessions: [],
      targets: TARGETS,
      failure: null,
      activeId: null,
      now: NOW,
    })
    expect(html).toContain(`<option value="${TARGET}"`)
    expect(html).toContain('（不可拨号）')
    expect(html).toContain('disabled>stranger')
  })

  test('says the roster is empty rather than showing an empty picker', () => {
    const html = renderChatSessions({
      sessions: [],
      targets: [],
      failure: null,
      activeId: null,
      now: NOW,
    })
    expect(html).toContain('注册中心里没有可聊的智能体')
    expect(html).not.toContain('data-action="chat-new"')
  })

  test('shows a session-list failure without losing the picker', () => {
    const html = renderChatSessions({
      sessions: [],
      targets: TARGETS,
      failure: { code: 'unreachable', message: '读不出来' },
      activeId: null,
      now: NOW,
    })
    expect(html).toContain('会话列表不可达')
    expect(html).toContain('data-action="chat-new"')
  })
})

describe('chat page document', () => {
  test('inlines everything and declares the strict policy', () => {
    const html = renderChatPage({
      label: '测试台',
      now: NOW,
      role: 'admin',
      sessions: renderChatSessions({
        sessions: [SESSION],
        targets: TARGETS,
        failure: null,
        activeId: SESSION.id,
        now: NOW,
      }),
      thread: renderChatThread({
        transcript: { session: SESSION, turns: [ASK, ANSWER] },
        failure: null,
        target: TARGETS[0] ?? null,
        now: NOW,
      }),
      composerEnabled: true,
    })
    // 只有 favicon 那一行 <link>：它是自包含的 data: URI，不是一个 host。
    const stripped = html.replace(/<link rel="icon"[^>]*>\n?/, '')
    expect(stripped).not.toBe(html)
    expect(stripped).not.toContain('<link')
    expect(stripped).not.toContain('src=')
    expect(html).toContain('default-src &#39;none&#39;')
    // 流式面靠 connect-src，缺了它 EventSource 会被浏览器直接拒掉。
    expect(html).toContain('connect-src &#39;self&#39;')
    expect(html).toContain(`maxlength="${MAX_CHAT_TEXT_LENGTH}"`)
    expect(html).toContain('type="submit"')
    expect(html).not.toContain('aria-label="发送" disabled')
  })

  test('disables the composer, with the sentence, when no session is open', () => {
    const html = renderChatPage({
      label: '测试台',
      now: NOW,
      role: 'admin',
      sessions: '',
      thread: '',
      composerEnabled: false,
    })
    // 文案纪律：可见文案不出现句读，原来那句里的逗号是违例。
    expect(html).toContain('先选一条会话 · 再发消息')
    expect(html).toContain('Shift Enter 换行" disabled')
    expect(html).toContain('aria-label="发送" disabled')
    // 和唤醒面不同：那里的缺席是配置状态，点了也没用；这里是「旁边点一下就好」
    // 的临时状态，控件留着并由客户端就地启用（不导航，否则凭据会丢）。
    expect(html).not.toContain('<fieldset disabled')
  })

  test('leaves the two cross-page links for the client to sign', () => {
    const html = renderChatPage({
      label: '测试台',
      now: NOW,
      role: 'admin',
      sessions: '',
      thread: '',
      composerEnabled: false,
    })
    // 顶层导航带不了 Authorization 头，凭据又刻意不放 cookie，所以这个 href
    // 由客户端在渲染后补上 ?token=。服务端渲染的是没带 token 的那一版。
    expect(html).toContain('id="to-console" href="/"')
  })
})

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

describe('chat routes', () => {
  test('the whole chat face is admin-only, reads included', async () => {
    const chat = new FakeChat()
    const handler = createConsoleHandler(depsWith(chat), TOKENS)
    for (const path of [
      '/chat',
      '/v0/chat/targets',
      '/v0/chat/sessions',
      '/v0/chat/sessions/session-1',
      '/v0/chat/stream',
      '/fragments/chat/sessions',
      '/fragments/chat/thread/session-1',
    ]) {
      const anonymous = await handler(new Request(`http://127.0.0.1${path}`))
      expect(anonymous.status).toBe(401)
      const viewer = await handler(get(path, VIEW))
      expect(viewer.status).toBe(403)
    }
    // 端口没被读到过：403 在任何一次调用之前。
    expect(chat.asked).toHaveLength(0)
  })

  test('gates the ledger page nav link on role, not merely on whether chat is wired', async () => {
    const chat = new FakeChat()
    const wired = createConsoleHandler(depsWith(chat), TOKENS)
    const unwired = createConsoleHandler(depsWith(), TOKENS)

    // A view token must not be able to tell a chat-enabled console apart
    // from one with no channel at all — a visible link that 403s on click
    // would leak exactly the fact the admin-only routes are built to hide.
    // (The inlined client script references `byId('to-chat')` on every page
    // regardless, so the assertion checks for the anchor markup itself, not
    // the bare id string.)
    const viewerPage = await (await wired(get('/', VIEW))).text()
    expect(viewerPage).not.toContain('id="to-chat"')
    expect(viewerPage).not.toContain('>对话<')

    const adminPage = await (await wired(get('/', ADMIN))).text()
    expect(adminPage).toContain('id="to-chat"')

    // Admin alone is not enough either: with no channel wired there is
    // nothing behind the link, so it stays hidden even for admin.
    const adminNoChat = await (await unwired(get('/', ADMIN))).text()
    expect(adminNoChat).not.toContain('id="to-chat"')
  })

  test('hides the page and explains the API when there is no chat channel', async () => {
    const handler = createConsoleHandler(depsWith(), TOKENS)
    expect((await handler(get('/chat'))).status).toBe(404)

    const api = await handler(get('/v0/chat/sessions'))
    expect(api.status).toBe(501)
    expect(await api.json()).toMatchObject({
      error: { code: 'unsupported' },
    })
    // 仍然先过 admin 门：匿名调用者不能靠 401/501 的差别探测哪台开了聊天。
    expect(
      (await handler(new Request('http://127.0.0.1/v0/chat/sessions'))).status,
    ).toBe(401)
  })

  test('serves the page for the session named in the query string', async () => {
    const chat = new FakeChat()
    const handler = createConsoleHandler(depsWith(chat), TOKENS)
    const response = await handler(get(`/chat?session=${SESSION.id}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const html = await response.text()
    expect(html).toContain('好的，我看过了')
    expect(html).toContain('type="submit"')
    expect(chat.asked).toEqual([SESSION.id])
  })

  test('leaves the composer off when the named session will not load', async () => {
    const chat = new FakeChat()
    chat.transcriptResult = bad('not_found', '这条会话不在本控制台的记录里')
    const handler = createConsoleHandler(depsWith(chat), TOKENS)
    const html = await (await handler(get('/chat?session=ghost'))).text()

    // 书签里的旧 session id 不该在一条失败横幅底下放一个能按的发送钮。
    expect(html).toContain('先选一条会话 · 再发消息')
    expect(html).toContain('aria-label="发送" disabled')
  })

  test('opens a session and sends a message through the port', async () => {
    const chat = new FakeChat()
    const handler = createConsoleHandler(depsWith(chat), TOKENS)

    const opened = await handler(post('/v0/chat/sessions', { target: TARGET }))
    expect(opened.status).toBe(200)
    expect(chat.opened).toEqual([TARGET])

    const sent = await handler(
      post(`/v0/chat/sessions/${SESSION.id}/messages`, { text: '你好' }),
    )
    expect(sent.status).toBe(200)
    expect(chat.sent).toEqual([{ sessionId: SESSION.id, text: '你好' }])
    expect(await sent.json()).toMatchObject({ id: ASK.id, state: 'read' })
  })

  test('refuses a message over the ceiling before it reaches the network', async () => {
    const chat = new FakeChat()
    const handler = createConsoleHandler(depsWith(chat), TOKENS)
    const response = await handler(
      post(`/v0/chat/sessions/${SESSION.id}/messages`, {
        text: 'x'.repeat(MAX_CHAT_TEXT_LENGTH + 1),
      }),
    )
    expect(response.status).toBe(400)
    expect(chat.sent).toHaveLength(0)
  })

  test('turns a port failure into the status that describes it', async () => {
    const chat = new FakeChat()
    chat.sendResult = bad('rejected', '控制台只向 ws://127.0.0.1:38612/ 发消息')
    const handler = createConsoleHandler(depsWith(chat), TOKENS)
    const response = await handler(
      post(`/v0/chat/sessions/${SESSION.id}/messages`, { text: '你好' }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'rejected' },
    })
  })

  test('answers the two fragments with markup the poller can adopt', async () => {
    const chat = new FakeChat()
    const handler = createConsoleHandler(depsWith(chat), TOKENS)

    const rail = await handler(
      get(`/fragments/chat/sessions?active=${SESSION.id}`),
    )
    expect(rail.headers.get('content-type')).toContain('text/html')
    expect(await rail.text()).toContain('id="chat-sessions"')

    const thread = await handler(get(`/fragments/chat/thread/${SESSION.id}`))
    expect(await thread.text()).toContain('id="chat-thread"')
  })

  test('rejects the verbs each chat route does not take', async () => {
    const chat = new FakeChat()
    const handler = createConsoleHandler(depsWith(chat), TOKENS)
    const del = await handler(
      new Request(`http://127.0.0.1/v0/chat/sessions/${SESSION.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${ADMIN}` },
      }),
    )
    expect(del.status).toBe(405)
    expect(del.headers.get('allow')).toBe('GET')
  })

  test('streams events and lets go of the subscription when the peer leaves', async () => {
    const chat = new FakeChat()
    const handler = createConsoleHandler(depsWith(chat), TOKENS)
    const response = await handler(get('/v0/chat/stream'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const body = response.body
    if (body === null) throw new Error('stream has no body')
    const reader = body.getReader()
    const decoder = new TextDecoder()

    const first = await reader.read()
    expect(decoder.decode(first.value)).toContain(': open')
    expect(chat.listeners.size).toBe(1)

    chat.emit({ sessionId: SESSION.id, revision: 7 })
    const event = await reader.read()
    const text = decoder.decode(event.value)
    expect(text).toContain('event: chat')
    expect(text).toContain('"revision":7')
    // 推送里**只有** id 与 revision：正文永远走服务端渲染那一条路。
    expect(text).not.toContain('好的，我看过了')

    await reader.cancel()
    expect(chat.listeners.size).toBe(0)
  })
})
