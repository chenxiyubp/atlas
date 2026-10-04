// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Everything the console reads or acts on, expressed as ports.
 *
 * The console package is a leaf: it never imports the host's `src/`, never
 * opens the audit file itself and never talks to a socket on its own. The CLI
 * handler that starts it (`occ console`) is the only place that knows where the
 * registry lives, which trail file to read and how to send a wake — it injects
 * those here. That keeps this package testable with plain objects and keeps the
 * host's dependency direction pointing inward, the same rule the tool-runtime
 * facades follow (root CLAUDE.md, "Host facade 模式").
 *
 * Every port returns data or a typed failure. None of them throw for an
 * expected condition — a console that 500s because the registry is down is
 * worse than one that renders "注册中心不可达" next to the rest of the page.
 */

import type { AuditRecord, MessageChain } from '@qianmo/audit'

/** One agent as the registry reports it (registry HTTP v0 `AgentBody`). */
export interface ConsoleAgent {
  readonly address: string
  readonly endpoint: string
  readonly capabilities: readonly string[]
  /** Absent until the node publishes one; never a private key. */
  readonly publicKey?: string
  readonly status: string
  readonly registeredAt: number
  readonly lastHeartbeatAt: number
  readonly expiresAt: number
}

/**
 * Uniform failure shape for every port. `code` is for tests, not for users.
 *
 * `unreachable` and `refused` are the pair worth being careful with, because
 * collapsing them is a bug that costs an operator an afternoon: `unreachable`
 * means the far side was never reached, and it points at tunnels, ports and
 * routes; `refused` means it was reached, understood the request and declined
 * it, and it points at that node's policy and its audit trail. A node that
 * refuses a wake for want of a capability token is `refused` — reporting it as
 * `unreachable` sent people to check a network that was working (issue #29).
 *
 * `rejected` is the third of the family and it is about **this** side: a rule
 * here would not let the request leave.
 */
export interface ConsoleFailure {
  readonly code:
    | 'unreachable'
    | 'refused'
    | 'rejected'
    | 'not_found'
    | 'unsupported'
    | 'invalid'
  readonly message: string
}

export type ConsoleResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ConsoleFailure }

/** Registration input accepted from the page — the reason the console exists. */
export interface RegisterAgentInput {
  readonly address: string
  readonly endpoint: string
  readonly capabilities?: readonly string[]
  readonly publicKey?: string
  readonly status?: string
}

/**
 * The registry face. Backed by HTTP v0 in production, by a fake in tests.
 * `list` is the only call the read-only view makes.
 */
export interface RegistryPort {
  list(): Promise<ConsoleResult<readonly ConsoleAgent[]>>
  register(input: RegisterAgentInput): Promise<ConsoleResult<ConsoleAgent>>
  deregister(address: string): Promise<ConsoleResult<void>>
  heartbeat(address: string): Promise<ConsoleResult<ConsoleAgent>>
}

/**
 * Where a trail stands, in the four states that call for four different next
 * actions.
 *
 * `intact` alone could not carry this. Three of these read `records: []` on
 * the wire and the console used to render all three as the green 完整:
 *
 * - `intact` — records are there and the hash chain holds end to end;
 * - `empty` — the chain file is there and holds no records. A node that has
 *   done no protocol work yet, which is a **normal** state and must not be
 *   reported as a finding;
 * - `absent` — there is no chain file. The node never wrote one, or the copy
 *   that was meant to arrive never did. Not a finding about integrity, but
 *   emphatically not health either: it is the state in which the audit
 *   surface would stay silent through anything;
 * - `broken` — records are there and the chain does not verify.
 */
export type AuditChainState = 'intact' | 'empty' | 'absent' | 'broken'

/** What a trail read yields, integrity verdict included. */
export interface AuditPage {
  readonly records: readonly AuditRecord[]
  /**
   * Where the chain stands. The field `intact` cannot answer on its own —
   * see {@link AuditChainState}.
   */
  readonly chain: AuditChainState
  /**
   * True only when there is a chain and nothing is wrong with it, so `empty`
   * qualifies and `absent` does not. Retained beside {@link AuditPage.chain}
   * because "is anything wrong" is still the one question most callers ask,
   * and because a caller that never learned about the four states must not
   * keep reading a missing file as a healthy one.
   */
  readonly intact: boolean
  /** How many issues the reader found, whatever their kind. */
  readonly issueCount: number
  /** Total records in the trail before filtering, for "showing N of M". */
  readonly total: number
  /**
   * Off-host witness verdict, absent only when this console has no anchor
   * source configured. A stale witness is distinct from a chain mismatch: it
   * means records past the newest anchor have no evidence and the witness has
   * heard nothing within its window (or there is no valid anchor at all), not
   * that a rewrite was found. An idle trail whose head is anchored is not
   * stale, so a quiet node keeps its verified state.
   *
   * `uncovered` appears only on a mirror source, and only when the witness
   * already holds anchors past the end of the copy: the mirror has not
   * caught up, which is neither a mismatch nor an absence of evidence. It
   * never appears together with `stale`.
   */
  readonly witness?: {
    readonly tampered: boolean
    readonly stale: boolean
    readonly uncovered?: true
  }
}

/** Filter accepted by the audit view; every field is optional and ANDed. */
export interface AuditFilter {
  readonly source?: string
  readonly outcome?: string
  readonly traceId?: string
  readonly taskId?: string
  readonly agent?: string
  readonly from?: number
  readonly to?: number
  /**
   * A relative time window (`1h` / `24h` / `7d`), as the filter form's
   * segmented control submits it.
   *
   * **Not a port concern**: `parseAuditFilter` resolves it into `from` before
   * any port ever sees the filter, and every {@link AuditPort} keeps reading
   * `from`/`to` alone. It survives on the shape for two consumers on the view
   * side — the segment has to know which of its four options is checked, and
   * the poller has to replay the *window* rather than the instant it happened
   * to resolve to five seconds ago. An explicit `from`/`to` out of the advanced
   * panel wins, which is what the 自定义 option means.
   */
  readonly window?: string
  /** Tail size. The port clamps it; the view never asks for the whole file. */
  readonly limit?: number
}

export interface AuditPort {
  read(filter: AuditFilter): Promise<ConsoleResult<AuditPage>>
  chain(traceId: string): Promise<ConsoleResult<MessageChain | null>>
}

/** One independently read audit source, supplied by the host CLI. */
export interface ConsoleAuditSource {
  /** Stable CLI node name, never inferred from the path. */
  readonly node: string
  readonly audit: AuditPort
  /** Explicit deployment metadata; mirror status is never path-derived. */
  readonly kind: 'authoritative' | 'mirror'
  /** Required when kind is mirror; measured timer interval in minutes. */
  readonly maxLagMinutes?: number
}

/** A wake request as the page can express it. */
export interface WakeInput {
  /** Named wake allowlist selector. Required only for multi-target consoles. */
  readonly node?: string
  readonly from: string
  readonly to: string
  readonly prompt: string
  readonly url: string
  readonly afterMs?: number
}

export interface WakeOutcome {
  readonly msgId: string
  readonly taskId: string
  readonly receipt: string
}

/**
 * Optional: absent when the console runs without a transport PSK, in which
 * case the page shows the wake form disabled with the reason, rather than
 * offering a button that always fails.
 */
export interface WakePort {
  send(input: WakeInput): Promise<ConsoleResult<WakeOutcome>>
}

/** A fixed, named outbound wake target and its independently wired port. */
export interface WakeTarget {
  readonly node: string
  readonly url: string
  /** Missing only when that node's own PSK was absent or unusable. */
  readonly wake?: WakePort
  /** Operator-facing local-degradation reason; never contains a PSK. */
  readonly unavailableReason?: string
}

// ---------------------------------------------------------------------------
// ChatPort —— 与常驻 agent 对话（P12）
// ---------------------------------------------------------------------------

/**
 * 聊天面的端口。
 *
 * 这个包**不知道回程是怎么回来的**：它不知道有传输层、不知道有 PSK、不知道一条
 * 回复是 `task.result` 还是别的什么。它只知道四件事——有哪些能聊的对象、有哪些
 * 会话、一条会话里有哪些轮次、以及「有新东西了」这个通知。host 侧
 * (`src/cli/handlers/consoleChat.ts`) 负责把它接到真的网络上。
 *
 * 这条边界不是形式主义：回程的实现（同一条已认证连接上的 ack + task.result）
 * 是协议层的决定，将来换成别的形状时，这个包一行都不用改，而它的用例也不需要
 * 起一个 WebSocket 服务端。
 */

/** 一个可以聊天的对象：注册中心里的一条记录，且它的端点在允许拨号的名单里。 */
export interface ChatTarget {
  /** `qianmo://<node>/<agent>`。 */
  readonly address: string
  readonly node: string
  /** 地址的 agent 段——**会话标题用的就是它**，不另起一套显示名。 */
  readonly agent: string
  /** 注册中心给的端点。 */
  readonly endpoint: string
  /** 注册中心报的状态字符串（`online` / `dormant` / …）。 */
  readonly status: string
  /**
   * 这个控制台**愿意**拨它吗。
   *
   * 注册中心自己没有任何鉴权（console.md §8.2），所以「注册中心说端点在这里」
   * 不等于「控制台就该往那里发一条带 PSK 握手的消息」。允许拨号的端点由启动参数
   * 钉死，不在名单里的对象照样列出来，但标成不可达并说明原因——藏起来只会让人
   * 以为控制台坏了。
   */
  readonly dialable: boolean
}

/** 一轮是谁说的。只有两种，没有「系统」这一档。 */
export type ChatAuthor = 'operator' | 'agent'

/**
 * 这一条是一句话，还是一条过程。
 *
 * **`message`** 是转录本来就有的那种：操作者问的一句，或 agent 答的一句。
 * **`notice`** 是任务跑到一半时节点推过来的一条 `notify`——工具开始/结束、
 * 计划更新。两者同处一个有序表而不是分成两条流，因为页面要回答的问题是
 * 「这一轮里先后发生了什么」，而两条各自有序的流合并起来才是那个答案，
 * 合并的时机越晚越容易错。
 *
 * 字段可选且缺省为 `message`：存量 NDJSON 里没有它，重放必须原样成立。
 * **刻意不叫 `kind`**——`consoleChatStore.ts` 的落盘信封已经用那个词区分
 * 「这行是会话还是轮次」，同一个文件里两个 `kind` 指两件事是给未来的读者
 * 埋雷。
 */
export type ChatTurnVariant = 'message' | 'notice'

/**
 * 一条过程行的分量，原样取自 `notify` 的 `severity`（协议 §14.2）。
 *
 * 页面只拿它选颜色，**不拿它过滤**：一条被过滤掉的过程行，和一条从来没发生
 * 过的过程，在页面上长得一模一样。
 */
export type ChatNoticeSeverity = 'info' | 'warn' | 'error'

/**
 * 一轮的处置。**是一条链，不是一个枚举里的平行项**：
 * `pending`（交给传输层了）→ `delivered`（有回执了）→ `read`（对方 ack 了，
 * 也就是消息真的进了它的输入）→ `done`（拿到终态回复）。`failed` 是任何一步的
 * 出口。agent 的那一轮只会是 `done` 或 `failed`。
 */
export type ChatTurnState = 'pending' | 'delivered' | 'read' | 'done' | 'failed'

/**
 * 转录里的一轮。
 *
 * 字段是**平的**，因为页面上那几个小 pill（「已投递 · 回执 accepted」「已读
 * 42ms」）是视图从这些数字算出来的，不是端口拼好的字符串。端口拼字符串等于把
 * 文案纪律搬到 host 侧，而那边没有视图层的用例看着它。
 */
export interface ChatTurn {
  readonly id: string
  readonly sessionId: string
  readonly author: ChatAuthor
  /** epoch 毫秒。 */
  readonly at: number
  readonly text: string
  readonly state: ChatTurnState
  /** 请求与回复的关联键（protocol C-1）。 */
  readonly taskId?: string
  /** 审计关联用，页面据此跳到消息链面板。 */
  readonly traceId?: string
  /** 传输层回执状态字符串。 */
  readonly receipt?: string
  /** 从发出到拿到回执的毫秒数。 */
  readonly receiptMs?: number
  /** 从发出到对方 ack 的毫秒数。 */
  readonly readMs?: number
  /** 从发出到终态回复的毫秒数（记在 agent 那一轮上）。 */
  readonly elapsedMs?: number
  /** 失败时的协议错误码，例如 `E_TASK_TIMEOUT`。 */
  readonly code?: string
  /** 缺省为 `message`；`notice` 是任务跑到一半推过来的一条过程。 */
  readonly variant?: ChatTurnVariant
  /** 只有 `notice` 有：这条过程的分量。 */
  readonly severity?: ChatNoticeSeverity
  /** 只有 `notice` 有：`notify` 的 `detail`，页面折起来给愿意看的人。 */
  readonly detail?: string
  /**
   * 只有 `notice` 有：这条是对面重发的。
   *
   * 协议 §14.4 要求重发**看得见**，不能悄悄变成第二条不同的过程。刻意不塞进
   * `code`——那一格是失败时的协议错误码，而重发既不是失败也不是错误码。
   */
  readonly redelivered?: true
}

/** 一条会话的抬头。列表只需要这些，不需要把转录整篇读出来。 */
export interface ChatSession {
  readonly id: string
  /** 目标地址。 */
  readonly target: string
  readonly node: string
  readonly agent: string
  readonly createdAt: number
  readonly updatedAt: number
  readonly turnCount: number
  /** 最后一轮的原文，视图自己截断。 */
  readonly preview: string
}

export interface ChatTranscript {
  readonly session: ChatSession
  readonly turns: readonly ChatTurn[]
}

export interface ChatSendInput {
  readonly sessionId: string
  readonly text: string
}

/**
 * 「这条会话有新东西了」。
 *
 * **故意不带内容**：订阅者拿到它以后回头去取服务端渲染好的片段，于是「服务端
 * 渲染 HTML、客户端只写 textContent」这条规矩在流式面上也成立（`assets/client.ts`
 * 的模块注释）。带内容的推送等于开一条新的、没人守着的注入面。
 */
export interface ChatUpdate {
  readonly sessionId: string
  /** 单调递增，客户端据此判断自己有没有漏掉一次。 */
  readonly revision: number
}

/**
 * 可选：没有配置聊天通道时整个聊天面消失（不是灰掉）。
 *
 * 和唤醒面不同的取舍：唤醒是主页上的一块，藏起来会让人以为面板坏了，所以渲染成
 * 禁用并说明原因；聊天是**另一个页面**，一个打开就说「这里什么都没有」的页面
 * 不如不给入口。stdout 的 `chat` 那一行会说明是哪种情况。
 */
export interface ChatPort {
  /** 能聊的对象。注册中心挂了就是一个失败值，不抛。 */
  targets(): Promise<ConsoleResult<readonly ChatTarget[]>>
  sessions(): Promise<ConsoleResult<readonly ChatSession[]>>
  /** 开一条新会话。同一个目标可以有多条——它们是不同的话题，不是重复。 */
  open(target: string): Promise<ConsoleResult<ChatSession>>
  transcript(sessionId: string): Promise<ConsoleResult<ChatTranscript>>
  /**
   * 发一句话。
   *
   * 返回的是**操作者那一轮**，不是 agent 的回复：回复要等一个真的模型轮次跑完，
   * 而这是在一个 HTTP 请求里。回复通过 {@link ChatPort.subscribe} 到达。
   */
  send(input: ChatSendInput): Promise<ConsoleResult<ChatTurn>>
  /** 订阅新消息，返回退订函数。 */
  subscribe(listener: (update: ChatUpdate) => void): () => void
}

// ---------------------------------------------------------------------------
// CertificatePort —— 证书栏（key-distribution.md §10.1，P12.4）
// ---------------------------------------------------------------------------

/**
 * 一个节点证书的处置。§10.1 的六个取值，其中 `expiring(<n>d)` 按 §6.2 的两道
 * 门限拆成两个：`expiring`（< 21 天，黄）与 `expiring-urgent`（< 7 天，红）。
 *
 * **不能折成「好/坏」两档**：`absent`（还没发布）与 `bad-signature`（发布了但
 * 不是本 CA 签的）指向完全相反的下一步动作——前者是「这个节点还没走过签发
 * 流程」，后者是「有人往零鉴权的注册中心里塞了东西」（§5.2 T-B）。同理
 * `expired` 与 `revoked`：一个是运维忘了续签，一个是这把钥匙被主动作废了。
 * `expiring-urgent` 与 `expired` 也是两件事：前者还来得及，后者这个节点已经被
 * 对端拒绝。
 */
export type CertificateStatus =
  | 'valid'
  | 'expiring'
  | 'expiring-urgent'
  | 'expired'
  | 'revoked'
  | 'absent'
  | 'bad-signature'

/**
 * 一个节点的证书，**全是公开材料**。
 *
 * 没有任何私钥字段，也不可能有：§10.3 那条硬规矩说控制台进程不得读 CA 私钥、
 * 节点身份私钥、节点 TLS 私钥，本接口是那条规矩在类型上的形状。指纹是核对用的
 * 同一种量具（运维核对 CA 根时用的就是 `fingerprint256`），所以它可以整串给出
 * 而不像公钥那样只给哈希前缀。
 */
export interface ConsoleCertificate {
  /** 节点段，不是地址——一个节点一张证书，与它有几个 agent 无关。 */
  readonly node: string
  readonly status: CertificateStatus
  /** 证书指纹；`absent` 时没有。 */
  readonly fingerprint256?: string
  /** `notAfter`，epoch 毫秒。 */
  readonly notAfter?: number
}

/**
 * 吊销清单的抬头。**不含 `revoked` 明细**：页面要回答的是「RL 什么时候过期」，
 * 而逐条吊销记录属于运维手上的那份 runbook，不属于一个零鉴权网络里人人能开的
 * 页面。
 */
export interface ConsoleRevocationList {
  readonly issuedAt: number
  readonly nextUpdate: number
  readonly revokedCount: number
}

export interface CertificateSnapshot {
  readonly certificates: readonly ConsoleCertificate[]
  /**
   * `null` = 一份都没发布过。
   *
   * 与「发布过但过期了」**必须分开**：§6.4 的两行给它们的是同一个 fail-closed
   * 行为但完全不同的成因，而页面是运维唯一能看出是哪一种的地方。
   */
  readonly revocationList: ConsoleRevocationList | null
}

/**
 * `--trust-ca` 文件里的一张 CA 根，§6.2 表里「CA 根」那一行的提醒。
 *
 * 到期分档与节点证书**同一组**（`valid` / `expiring` / `expiring-urgent` /
 * `expired`，门限也是同两道）：根过期时它签的每张证书在 TLS 层和证书目录里一并
 * 失效，这件事对运维的紧迫程度不低于任何一张叶证书。`subject` 足以区分两张根：
 * 信任文件拒绝两张同名的根。
 */
export interface ConsoleCaRoot {
  readonly subject: string
  /** 根自己的 `notAfter`，epoch 毫秒。 */
  readonly notAfter: number
  readonly status: Extract<
    CertificateStatus,
    'valid' | 'expiring' | 'expiring-urgent' | 'expired'
  >
}

/**
 * 可选：没有配 CA 根就整条证书栏不出现（不是显示一排「未知」）。
 *
 * 与唤醒面的取舍不同：唤醒是主页上的一块功能，藏起来会让人以为面板坏了；证书栏
 * 是一列**事实**，一列全是「未知」的事实不是降级，是噪声——而且它会让「这个部署
 * 还没上证书」和「证书全坏了」在页面上长得一样。
 */
export interface CertificatePort {
  read(): Promise<ConsoleResult<CertificateSnapshot>>
  /**
   * 信任文件里的根，按文件顺序，每张一条。
   *
   * 与 `read()` 分开、同步返回：根是本机启动时读进来的文件，不经注册中心。放进
   * `read()` 的快照里，注册中心一不可达，根的到期提示就跟着从页面上消失。
   */
  roots(): readonly ConsoleCaRoot[]
}

// ---------------------------------------------------------------------------
// 服务器归属与备注 —— 「这个智能体跑在哪台机器上」
// ---------------------------------------------------------------------------

/**
 * 一个节点跑在哪台服务器上，**启动时钉死的一条事实**。
 *
 * 为什么不从端点推：名册上的端点是宿主机这一侧的隧道本地口
 * （`ws://127.0.0.1:38631` 这种），四个节点落在四台机器上时它们长得一模一样，
 * 只差一个端口号。端点回答的是「这个控制台怎么拨到它」，不是「它在哪」——后者
 * 只有起控制台的那个人知道，所以它从启动参数来。
 *
 * `server` 是运维自己的叫法（`p11`、一个 IPv4 字面量、一个机房名），不是协议
 * 地址段：它要能带点号，所以它**不**走 `isValidSegment`。形状由 host 侧的
 * `consoleArgs.ts` 把关，这个包只当它是一串要转义后才能进 HTML 的字符。
 */
export interface NodeServer {
  /** 协议节点段，与名册里 `qianmo://<node>/<agent>` 的 node 同一个词。 */
  readonly node: string
  /** 那台机器的名字，运维自己起的。 */
  readonly server: string
}

/** 一台服务器的一段备注，连同它最后一次被改的时刻。 */
export interface ServerNote {
  readonly server: string
  /** 操作者写的自由文本，可以带换行；空串就是「没有备注」。 */
  readonly note: string
  /** epoch 毫秒。 */
  readonly updatedAt: number
}

/**
 * 备注的落盘面。**这个包不碰文件系统**，所以它只是一对方法。
 *
 * host 侧（`src/cli/handlers/consoleServerNotes.ts`）把它接到一个
 * append-only NDJSON 文件上，位置从 `occConfigPath()` 派生。这条边界和
 * {@link ChatPort} 是同一条：这里不知道有磁盘，用例因此是一个普通对象。
 *
 * 可选：缺了备注框渲染成只读并说明原因，而不是给一个按下去必定失败的按钮——
 * 与唤醒面同一个取舍。
 *
 * **`set` 不负责判「这台服务器存不存在」**：那是白名单的事，由 HTTP 层拿
 * {@link ConsoleDeps.nodeServers} 判定后才会走到这里。端口只管写。
 */
export interface ServerNotesPort {
  list(): Promise<ConsoleResult<readonly ServerNote[]>>
  set(server: string, note: string): Promise<ConsoleResult<ServerNote>>
}

// ---------------------------------------------------------------------------
// LedgerPort —— 账号库与会话表的落盘面（P15.3 / P15.5）
// ---------------------------------------------------------------------------

/**
 * 一本哈希链账的文件面：整篇读出来，或在末尾追加一行。
 *
 * **只搬字节，不判内容**：解析、验链、语义校验全在包内（`ledger.ts`、
 * `accounts.ts`），那样 fail-closed 的每一条规矩都能用一个普通对象测到。host
 * 侧（`src/cli/handlers/consoleAccountsStore.ts`）只负责 0600、O_APPEND、
 * 每行 fsync，路径从 `occConfigPath()` 派生。
 *
 * 与其余端口不同，这两个方法**允许抛**：它们失败只可能是 I/O 坏了，而账本对
 * 任何一次抛出的处置都是同一个——整本转为不可用并告警（`AccountBook`）。
 * 同步也是有意的：「查这枚邀请还没用过」与「写下它已用掉」必须在同一拍里完成，
 * 中间一个 `await` 就是两次并发兑换同一枚邀请的窗口。
 */
export interface LedgerPort {
  /** 文件位置，只用于横幅与告警，不是秘密。 */
  readonly path: string
  /** 整篇内容；文件不存在时 `null`。 */
  read(): string | null
  /** 追加一行（已带换行）并落盘。 */
  append(line: string): void
}

/** Protocol/runtime ceilings, read from the packages that own them. */
export interface LimitsSnapshot {
  /** `@qianmo/protocol` LIMITS — the single source for protocol ceilings. */
  readonly protocol: {
    readonly maxMessageBytes: number
    readonly maxHops: number
    readonly defaultTtlMs: number
    readonly defaultTaskTtlMs: number
    readonly ratePerMinute: number
  }
  /**
   * `@qianmo/router` RUNTIME_RATE. Deliberately a separate column: the two
   * rate limits are structurally distinct and must not be shown as one number
   * (`packages/router/src/rate.ts` module note).
   */
  readonly runtime: {
    readonly capacity: number
    readonly windowMs: number
  }
  /**
   * `@qianmo/registry`'s default lease — the scale of last resort, not the
   * scale. The registry may run with any `ttlMs`, so the roster judges each
   * record by the lease the registry granted it (`expiresAt − lastHeartbeatAt`)
   * and the page prints that; this number stands in only for a record that
   * carries no lease, and for an empty roster. `/v0/limits` reports it as is.
   */
  readonly registryTtlMs: number
}

/** Everything a console instance needs. `wake` and `chat` are optional. */
export interface ConsoleDeps {
  readonly registry: RegistryPort
  /**
   * Legacy single-audit facade. New hosts provide {@link audits}; retaining
   * this keeps direct package consumers on the old one-source contract.
   */
  readonly audit: AuditPort
  /** Ordered audit sources. Absent means one authoritative `default` source. */
  readonly audits?: readonly ConsoleAuditSource[]
  readonly limits: LimitsSnapshot
  readonly wake?: WakePort
  /** Named wake allowlist. Absent preserves the legacy single WakePort path. */
  readonly wakeTargets?: readonly WakeTarget[]
  /** Absent removes the chat page and every `/v0/chat/*` route (§4.5). */
  readonly chat?: ChatPort
  /** Absent removes the certificate column entirely (§10.1). */
  readonly certificates?: CertificatePort
  /**
   * 每个节点跑在哪台服务器上，**启动时确定，而且这就是白名单**。
   *
   * 两件事同时由它决定：名册上一个节点显示哪台机器，以及
   * `PUT /v0/servers/<id>/note` 允许写哪些 id。客户端送来的 server id 必须先在
   * 这张表里查到才处理，查不到回 403——与 {@link ConsoleDeps.wakeTargets} 同一条
   * 纪律（`http.ts` 的 `handleWake`）：客户端不能凭一个任意字符串让服务端多出
   * 一条记录来。
   *
   * 缺席就是整个归属面消失（名册不显示归属、服务器区块不渲染、两条路由回 501），
   * 而不是显示一列空白：一列空白会让「这个部署没配归属」和「归属全丢了」长得
   * 一样。
   */
  readonly nodeServers?: readonly NodeServer[]
  /** 备注的落盘面。缺席时备注框只读并说明原因。 */
  readonly serverNotes?: ServerNotesPort
  /**
   * The CLI name the certificate column writes its copyable `qm ca issue`
   * line under. Read from the host's identity roster, never spelled here.
   */
  readonly binName?: string
  /** Injected for deterministic tests; defaults to `Date.now` at the edges. */
  readonly now?: () => number
  /** Shown in the page header so two consoles are never confused. */
  readonly label?: string
  /**
   * The wake receipt endpoint this console is pinned to, for display only.
   *
   * The wake form used to carry a `回调` text box that could only ever hold
   * this one value — `createWakePort` refuses anything else (`consolePorts.ts`)
   * — so the field was a box that existed to be left empty. It is now a read-
   * only line of small print, and this is where the line gets its value.
   * Absent renders no line rather than an empty one.
   */
  readonly wakeUrl?: string
  /**
   * The address this console speaks as, prefilled into the wake form's
   * `发起方`. Absent leaves the field editable and empty.
   */
  readonly identity?: string
}
