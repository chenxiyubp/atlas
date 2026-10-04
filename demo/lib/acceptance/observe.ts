// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 观测层 —— 场景读取节点状态的**唯一**入口。
 *
 * 这里的每个函数都只经 {@link AcceptanceDriver.readNodeFile} /
 * `listNodeDir` / `execNode` 去取数据，一次 `node:fs` 都不用。这不是风格洁癖：
 * 一旦某个场景直接读了本地文件系统，它就只能在本地腿上跑，而「两个目标共用
 * 同一套场景」这条硬要求当场作废，且**作废得悄无声息**——真机腿上它会以
 * 「文件不存在」的形式失败，读起来像被测系统坏了。
 *
 * 所有函数对「读不到」都返回空值而不是抛：**「链不存在」本身就是一种观察**，
 * 而且是审计维度里要断言的那一种。
 */

import type { AcceptanceDriver, NodeHandle, ScenarioContext } from './types.js'

/** 审计链在配置根下的相对路径。 */
export const TRAIL_PATH = 'qianmo/audit/trail.ndjson'
/** ACP 会话表。 */
export const SESSIONS_PATH = 'resident/sessions.json'
/** 生命周期戳（上一条命是怎么结束的）。 */
export const LIFECYCLE_PATH = 'resident/lifecycle.json'
/** 节点身份（Ed25519 密钥对）。 */
export function identityPath(node: string): string {
  return `qianmo/identity/${node}.json`
}
/** 时间线文件；与 `local/driver.ts` 的 `TIMINGS_FILE` 必须同名。 */
export const TIMINGS_PATH = 'acceptance-timings.jsonl'

async function ndjson(
  driver: AcceptanceDriver,
  node: NodeHandle,
  relPath: string,
): Promise<readonly Record<string, unknown>[]> {
  const text = await driver.readNodeFile(node, relPath)
  if (text === undefined) return []
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) {
        out.push(parsed as Record<string, unknown>)
      }
    } catch {
      // 追加写到一半的半行是正常的：进程还在跑，下一轮再读。
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 时间线
// ---------------------------------------------------------------------------

export interface TimingEvent {
  readonly stage: string
  readonly agent?: string
  readonly sessionId?: string
  readonly networkMsgId?: string
  readonly error?: string
}

export async function readTimings(
  driver: AcceptanceDriver,
  node: NodeHandle,
): Promise<readonly TimingEvent[]> {
  return (await ndjson(driver, node, TIMINGS_PATH)) as unknown as TimingEvent[]
}

/**
 * 等某个 agent 的一轮走到终态（`turn_completed` / `turn_failed`）。
 *
 * **不要用固定 sleep 代替它。** 一轮真任务在这台机上要几秒到几十秒不等
 * （取决于基座在假上游上打了几个来回），固定等待要么白等要么等不够，
 * 而「等不够」的表现是断言读到一个还没写完的 transcript。
 */
export async function waitForTurn(
  ctx: ScenarioContext,
  node: NodeHandle,
  agent: string,
  timeoutMs = 120_000,
): Promise<TimingEvent | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const events = await readTimings(ctx.driver, node)
    const done = events.find(
      e =>
        e.agent === agent &&
        (e.stage === 'turn_completed' || e.stage === 'turn_failed'),
    )
    if (done !== undefined) return done
    if (ctx.signal.aborted || Date.now() >= deadline) return undefined
    await delay(250)
  }
}

/** 等某个 stage 出现（`detected` / `admitted` / `read` …）。 */
export async function waitForStage(
  ctx: ScenarioContext,
  node: NodeHandle,
  stage: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await readTimings(ctx.driver, node)).some(e => e.stage === stage)) {
      return true
    }
    if (ctx.signal.aborted || Date.now() >= deadline) return false
    await delay(200)
  }
}

// ---------------------------------------------------------------------------
// 审计链
// ---------------------------------------------------------------------------

export interface AuditRecordLike {
  readonly seq: number
  readonly at: number
  readonly source: string
  readonly kind: string
  readonly outcome: string
  readonly code?: string
  readonly prev: string
  readonly detail?: Record<string, string | number | boolean>
}

export async function readTrail(
  driver: AcceptanceDriver,
  node: NodeHandle,
): Promise<readonly AuditRecordLike[]> {
  return (await ndjson(
    driver,
    node,
    TRAIL_PATH,
  )) as unknown as AuditRecordLike[]
}

/**
 * 审计链里记下来的握手拒绝理由。
 *
 * 两件必须一起知道的事：
 *
 * ① **wire 上分辨不了。** 十二种握手失败在线上全塌缩成
 *    `4003 / 'unauthorized'`（见 `local/dial.ts` 文件头），审计链是唯一还留着
 *    具体理由的地方。
 *
 * ② **审计链也只记其中五种。** `auditTrail.ts` 的 `HANDSHAKE_AUDITED` 只收
 *    {@link AUDITED_HANDSHAKE_REJECTIONS} 那五个。**错 PSK（`bad_mac`）、
 *    `unexpected_frame`、`malformed_frame`、`signature_required` 都不进链**——
 *    一次错 PSK 的拨号在节点上不留任何可见痕迹。这不是本套件的疏漏，是系统
 *    当前的可观测边界，由 `handshake/rejection-attributable` 场景钉住。
 *
 * 理由落在记录的 `code` 字段而不是 `detail.rejection`：`appendHandshakeRefusal`
 * 特意把它提上去，因为那才是运维会 grep 的字段。
 */
export const AUDITED_HANDSHAKE_REJECTIONS: readonly string[] = [
  'channel_identity_mismatch',
  'bad_credential_proof',
  'unknown_signer',
  'bad_signature',
  'credential_required',
]

export async function handshakeRejections(
  driver: AcceptanceDriver,
  node: NodeHandle,
): Promise<readonly string[]> {
  return (await readTrail(driver, node))
    .filter(r => r.source === 'transport' && r.kind === 'auth_rejected')
    .map(r => String(r.code ?? ''))
}

/** 等审计链里出现某条握手拒绝（写盘晚于 socket 关闭，必须等）。 */
export async function waitForRejection(
  ctx: ScenarioContext,
  node: NodeHandle,
  rejection: string,
  timeoutMs = 10_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if ((await handshakeRejections(ctx.driver, node)).includes(rejection)) {
      return true
    }
    if (ctx.signal.aborted || Date.now() >= deadline) return false
    await delay(150)
  }
}

/** `qm audit --verify` 的 JSON 输出。 */
export interface VerifyReport {
  readonly path: string
  readonly records: number
  readonly chain: 'intact' | 'empty' | 'absent' | 'broken'
  readonly intact: boolean
  readonly issues: readonly { line: number; kind: string; seq?: number }[]
}

export interface VerifyResult {
  readonly exitCode: number
  readonly report?: VerifyReport
  readonly stdout: string
  readonly stderr: string
}

export async function auditVerify(
  driver: AcceptanceDriver,
  node: NodeHandle,
  path?: string,
): Promise<VerifyResult> {
  const argv = [
    'audit',
    '--verify',
    ...(path === undefined ? [] : ['--path', path]),
  ]
  const result = await driver.execNode(node, argv)
  let report: VerifyReport | undefined
  try {
    report = JSON.parse(result.stdout) as VerifyReport
  } catch {
    report = undefined
  }
  return {
    exitCode: result.code,
    report,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

// ---------------------------------------------------------------------------
// 会话与 transcript
// ---------------------------------------------------------------------------

/** 每个 agent 的 ACP session id（键是 `<agent>:<context>`）。 */
export async function sessionIdsByAgent(
  driver: AcceptanceDriver,
  node: NodeHandle,
): Promise<Readonly<Record<string, string>>> {
  const raw = await driver.readNodeFile(node, SESSIONS_PATH)
  if (raw === undefined) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const agent = key.split(':')[0]
    const sessionId = (value as { sessionId?: unknown } | null)?.sessionId
    if (agent !== undefined && typeof sessionId === 'string') {
      out[agent] = sessionId
    }
  }
  return out
}

export interface TranscriptFile {
  /** `projects/` 下的目录名。 */
  readonly projectDir: string
  readonly sessionId: string
  /** 文件里出现过的全部 `cwd` 值（正常应当只有一个）。 */
  readonly cwds: readonly string[]
  readonly lines: number
}

export async function readTranscripts(
  driver: AcceptanceDriver,
  node: NodeHandle,
): Promise<readonly TranscriptFile[]> {
  const dirs = await driver.listNodeDir(node, 'projects')
  if (dirs === undefined) return []
  const out: TranscriptFile[] = []
  for (const dir of dirs) {
    const files = await driver.listNodeDir(node, `projects/${dir}`)
    if (files === undefined) continue
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const text = await driver.readNodeFile(node, `projects/${dir}/${file}`)
      if (text === undefined) continue
      const cwds: string[] = []
      let lines = 0
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        lines += 1
        try {
          const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
          if (typeof cwd === 'string' && !cwds.includes(cwd)) cwds.push(cwd)
        } catch {
          // 半行，同上。
        }
      }
      out.push({
        projectDir: dir,
        sessionId: file.replace(/\.jsonl$/, ''),
        cwds,
        lines,
      })
    }
  }
  return out
}

/**
 * transcript 里出现过的全部中止标记。
 *
 * 用来区分「用户中断」与「常驻看门狗超时」——issue #39 的判据落点。
 */
export async function abortMarkers(
  driver: AcceptanceDriver,
  node: NodeHandle,
): Promise<readonly string[]> {
  const dirs = (await driver.listNodeDir(node, 'projects')) ?? []
  const found: string[] = []
  for (const dir of dirs) {
    const files = (await driver.listNodeDir(node, `projects/${dir}`)) ?? []
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const text = await driver.readNodeFile(node, `projects/${dir}/${file}`)
      if (text === undefined) continue
      for (const match of text.matchAll(/\[Request [^\]]*\]/g)) {
        const marker = match[0]
        if (!found.includes(marker)) found.push(marker)
      }
    }
  }
  return found
}

/**
 * 等 transcript 里出现中止标记 —— **必须等，不能读一次就下结论。**
 *
 * `timings.jsonl` 里的 `turn_failed` 由**宿主**在发出 `session/cancel` 之后
 * 立刻写下；那条合成的中止消息则要等 ACP **子进程**把自己的 query 循环退栈、
 * 再把消息落进 transcript。两者是两个进程里的两件事，宿主那条一定先到。
 *
 * 空闲机器上这段间隔小到读一次就够，负载高时不够 —— 实测：单跑这条场景绿，
 * 跟在一整轮 83 条后面跑就红，红的形态是 `markers: []`。那是套件的竞态，不是
 * 归因坏了，所以修法是等，而不是把断言放宽。
 *
 * 到点仍为空就把空数组交回去，由调用方判红。
 */
export async function waitForAbortMarker(
  driver: AcceptanceDriver,
  node: NodeHandle,
  timeoutMs = 20_000,
  stepMs = 500,
): Promise<readonly string[]> {
  const deadline = Date.now() + timeoutMs
  let markers = await abortMarkers(driver, node)
  while (markers.length === 0 && Date.now() < deadline) {
    await delay(stepMs)
    markers = await abortMarkers(driver, node)
  }
  return markers
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// 信箱
// ---------------------------------------------------------------------------

/** 投递落到 agent 信箱的一条 —— 阡陌的 wrapper 就在 `text` 里。 */
export interface MailboxNotice {
  /** `notice.trust`：`'untrusted'` 或 `'verified-capability'`。 */
  readonly trust?: string
  /** 给模型看的那段措辞原文。 */
  readonly text?: string
  /** `envelope.trust` —— **恒为 `'untrusted'`**，不是授权信号（issue #47 ③）。 */
  readonly envelopeTrust?: string
  readonly capIss?: string
  /** 整条原文，断言不成立时当证据。 */
  readonly raw: string
}

/**
 * 读一个 agent 的信箱。
 *
 * 路径是 `<配置根>/teams/<team>/inboxes/<agent>.json`（`getTeamsDir()` 挂在
 * 配置根下），所以两个驱动都够得着 —— 这就是信任维度不去翻 agent 工作区的
 * 原因：工作区在配置根外面，翻它的场景搬不到真机腿上。
 *
 * 信箱条目的 `text` 是一段 JSON 串（`serializeWrapper` 的产物），`notice.trust`
 * 就在里面。直接断言这个字段，比在措辞里找关键词精确得多。
 */
export async function readMailbox(
  driver: AcceptanceDriver,
  node: NodeHandle,
  team: string,
  agent: string,
): Promise<readonly MailboxNotice[]> {
  const raw = await driver.readNodeFile(
    node,
    `teams/${team}/inboxes/${agent}.json`,
  )
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return [{ raw }]
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { messages?: unknown }).messages)
      ? (parsed as { messages: unknown[] }).messages
      : []
  const out: MailboxNotice[] = []
  for (const entry of entries) {
    const text = (entry as { text?: unknown }).text
    const body = typeof text === 'string' ? text : JSON.stringify(entry)
    let wrapper: Record<string, unknown> | undefined
    try {
      const candidate: unknown = JSON.parse(body)
      if (typeof candidate === 'object' && candidate !== null) {
        wrapper = candidate as Record<string, unknown>
      }
    } catch {
      wrapper = undefined
    }
    const notice = wrapper?.notice as Record<string, unknown> | undefined
    const envelope = wrapper?.envelope as Record<string, unknown> | undefined
    const origin = envelope?.origin as Record<string, unknown> | undefined
    out.push({
      trust: typeof notice?.trust === 'string' ? notice.trust : undefined,
      text: typeof notice?.text === 'string' ? notice.text : undefined,
      envelopeTrust:
        typeof envelope?.trust === 'string' ? envelope.trust : undefined,
      capIss: typeof origin?.capIss === 'string' ? origin.capIss : undefined,
      raw: body,
    })
  }
  return out
}

/** 等信箱里出现至少一条（投递是异步的，回执之后还要一拍）。 */
export async function waitForMailbox(
  ctx: ScenarioContext,
  node: NodeHandle,
  team: string,
  agent: string,
  timeoutMs = 20_000,
): Promise<readonly MailboxNotice[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entries = await readMailbox(ctx.driver, node, team, agent)
    if (entries.length > 0) return entries
    if (ctx.signal.aborted || Date.now() >= deadline) return entries
    await delay(200)
  }
}
