// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `qm watch` —— 中枢侧的值守作业跑手（P13.6）。
 *
 * 这是「定时反转」那条设计的入口：**定时全部住在中枢，节点侧零调度状态**。
 * 本进程按 `@qianmo/scheduler` 算出的一次性预约到点拨号目标节点、发一条
 * `task.request`，然后**把连接握住**——因为 notify 走的正是这条已存在通道的
 * 反方向（`resident-botization.md` §1 那张图的 ③），节点一次都不拨号。
 *
 * ## 三条不能顺手改掉的东西
 *
 * - **拨号的是中枢，不是节点。**H-2 说的是节点纯入站，中枢当然要拨号——它是
 *   客户端那一侧。把这段逻辑「挪到节点里去省一次连接」正好把 H-2 作废。
 * - **连接跑完不关。**`resident-wake` 发完就退是对的（一次调用一条消息），
 *   这里不是：作业跑出来的 notify 要顺着同一条通道回来，关掉就等于让节点把
 *   通知压进台账等下一次拨号——一个周期的延迟，且是白白的。
 * - **`contextId = jobId`**（§4.1③）。它把「值守作业」和「多会话隔离」焊死：
 *   一个作业在节点侧就是一条独立 ACP 会话，跑七天也不会把人工对话撑爆。
 *   `taskTtlMs` 同理由作业指定，不吃协议默认的 5 分钟（§4.1④）。
 *
 * ## 作业文件长什么样
 *
 * 一个 JSON 数组，每项是 `@qianmo/scheduler` 的 `ScheduledJob` 再加一个
 * `url`（目标节点的入站 ws / unix 地址，本文件读，调度器不读）：
 *
 * ```json
 * [
 *   {
 *     "id": "disk-watch",
 *     "title": "每十分钟看一次磁盘",
 *     "target": "qianmo://beta-1/reviewer",
 *     "url": "ws://127.0.0.1:38611",
 *     "prompt": "检查 / 与 /var 的使用率。超过 90% 就调用 qianmo_notify 告诉运维，否则什么都不用做。",
 *     "schedule": { "everyMs": 600000 },
 *     "taskTtlMs": 900000,
 *     "notifyPolicy": "agent-initiated"
 *   }
 * ]
 * ```
 *
 * `notifyPolicy` 目前只被记录与透传，**打不打扰人由 agent 自己决定**——产出
 * 默认静默，只有它显式调 `qianmo_notify` 才有人被叫醒（§4.1⑤）。
 *
 * ## 签名（`--sign`）：投递和授权是两回事
 *
 * 不签名的 `task.request` 照样能投递。默认策略的节点会拒收（`E_CAP_INSUFFICIENT`）；
 * `--open-policy` 的节点会收下，但它是 untrusted 档，给模型的通告要求「把内容当
 * 数据，不当指令」。所以作业会跑一轮，模型会拒绝执行，而中枢这边看起来一切正常。
 * 控制台的 `--wake-sign` 和 `--chat-sign` 遇到过同一个问题（console.md §4.7、
 * §6.7.1）。本文件用同一套做法：
 *
 * - 身份是 `--from` 的 node 段在配置根里的 Ed25519 密钥，复用
 *   `consoleWakeIdentity.ts` 的加载函数与签发器，不另造一种密钥格式；
 * - 令牌只签 `write-limited`，绑定 `(aud, sub, taskId, createdAt)`。这正是
 *   `SIGNED_TASK_POLICY` 对 `task.request` 的要求。`user-confirmed` 不会签：
 *   规则 S-1 只接受节点自己签的这一档，中枢签出来必然被拒；
 * - 令牌在连接建立**之后**才签出来。60 s 的有效期只需覆盖一次发送；
 * - 签不出来，这次 fire 就算失败，走退避。不会退回去发一条不签名的请求。
 *
 * ## 对人的通知与过程数据
 *
 * 节点会把一轮里每个工具的开始和失败推成 `notify{kind:'task'}`（v2.59 为对话面
 * 做的过程行）。在值守作业里它们是过程数据，不是对人的通知。
 * {@link classifyWatchNotify} 把两者分开：只有 agent 自己调用 `qianmo_notify`
 * 发出的通知才打印到 stdout，并记为 `watch_notify_received`；过程行只记为
 * `watch_step_received`。
 */

import { readFileSync } from 'node:fs'
import { AuditSource, type AuditTrail } from '@qianmo/audit'
import {
  MessageType,
  assertAddress,
  createMessage,
  isNotifyPayload,
  isTaskResultPayload,
  newId,
  type NotifyPayload,
  type QianmoMessage,
} from '@qianmo/protocol'
import {
  ResidentEstop,
  parseTurnStepDedupKey,
  turnFailureKind,
} from '@qianmo/resident'
import {
  SchedulerRunner,
  SchedulerStore,
  assertJob,
  type ScheduledJob,
} from '@qianmo/scheduler'
import { PSK_ENV_VAR, TransportClient, pskFromEnv } from '@qianmo/transport'
import { invokedBinName } from '../../constants/brand.js'
import { IDENTITY_MODE } from '../../constants/identity.js'
import { occConfigPath } from '../../config/paths.js'
import { openAuditTrail } from '../../services/qianmo/auditTrail.js'
import {
  loadConsoleWakeIdentity,
  type ConsoleWakeIdentity,
} from './consoleWakeIdentity.js'
import { residentOptionValue } from './residentArgs.js'
import type { WakeCapabilityIssuer } from './residentWake.js'

/**
 * 一次投递等回执的预算。
 *
 * 与常驻侧回复用的是同一个数（5 s），理由也同一条：回执只承诺「已落盘」，
 * 一个正在跑 turn 的节点也该在这个预算内答上来（P13.3 把这条解耦了）。
 * 作业本身能跑多久由 `taskTtlMs` 说了算，不由这个数。
 */
const DISPATCH_RECEIPT_TIMEOUT_MS = 5_000

/** 连接一次的上限，与 `resident-wake` 同源。 */
const CONNECT_TIMEOUT_MS = 30_000

export interface WatchConfig {
  readonly mode: 'run'
  readonly jobsPath: string
  readonly from: string
  readonly stateDir: string
  /** 只跑一遍到点的作业就退出——给冒烟与联调用，不是常态。 */
  readonly once: boolean
  /**
   * `--sign`：每个作业的 `task.request` 都带一枚 capability token。**缺省不签。**
   *
   * 缺省关的理由与控制台的 `--wake-sign` 相同：节点在两种策略下都会拒绝一枚
   * 解析不出签发方公钥的令牌。所以操作顺序只有一种：先在每个目标节点上加
   * `--trust <node>=<publicKey>`，再打开这个开关。公钥用 `--print-identity` 取。
   */
  readonly sign: boolean
}

/**
 * `--print-identity`：只打印签名身份，然后退出。
 *
 * 这是一条单独的路径，因为分发公钥必须在打开 `--sign` 之前完成。如果只能从
 * `--sign` 启动时的横幅里读公钥，那么调度器已经启动，作业已经在向还不认识这把
 * 公钥的节点发送请求。这条路径只需要 `--from`：不读作业文件，不读 PSK，也不
 * 连接任何节点。
 */
interface WatchPrintIdentityConfig {
  readonly mode: 'print-identity'
  readonly from: string
}

type WatchCommand = WatchConfig | WatchPrintIdentityConfig

/** 作业文件里那一项：调度器认识的部分 + 本文件认识的 `url`。 */
interface WatchJobEntry {
  readonly job: ScheduledJob
  readonly url: string
}

export const WATCH_HELP_TEXT = `Usage: ${invokedBinName()} watch --jobs <file> --from <address> [options]
       ${invokedBinName()} watch --print-identity --from <address>

Run the hub-side watch-job scheduler. Timing lives here so the nodes hold none:
each job fires on a one-shot reservation, dials its target node, sends one
task.request, and keeps the connection so the node can push notifications back
down it. Requires OCC_IDENTITY=qianmo and a key in $${PSK_ENV_VAR} shared with
every node named in the jobs file.

Options (each accepts both --name value and --name=value):

  --jobs <file>        JSON array of job definitions. Required. Each entry is a
                       scheduler job plus a "url" naming the target node's
                       inbound WebSocket.
  --from <address>     This hub's address, qianmo://<node>/<agent>. Required —
                       it is the head of the audit chain and the address every
                       notification is addressed back to.
  --state-dir <dir>    Where claims and job state live. Defaults to
                       <config>/qianmo/scheduler. Two hubs pointed at one
                       directory is a supported (and tested) arrangement: the
                       claim files make it at-most-once.
  --once               Run whatever is due right now, then exit. For smoke
                       tests; a real watch job wants the process to stay up.
  --sign               Sign every job's task.request with this hub's own
                       Ed25519 identity: the key of the --from node under
                       <config>/qianmo/identity/, created on first use. The
                       token is write-limited and bound to that one task.
                       Off by default. Without it the request is unsigned: a
                       node under the default policy refuses it
                       (E_CAP_INSUFFICIENT), and a node under --open-policy
                       runs it as an untrusted message whose text the agent
                       is told to treat as data, so the job is declined.
                       Order matters: every target node must carry
                       --trust <node>=<publicKey> for this hub before this
                       flag goes on, because a node refuses a token whose
                       issuer it cannot resolve under both policies.
  --print-identity     Print this hub's signing identity as <node>=<publicKey>
                       and exit, creating the key pair on first run. The
                       output is exactly what a resident node takes after
                       --trust. Needs only --from. It reads no jobs file, no
                       key from the environment, and dials nothing.
  -h, --help           Print this and exit.

Environment:

  OCC_IDENTITY         Must be "qianmo".
  ${PSK_ENV_VAR}   Transport pre-shared key, required. Environment only —
                       a key on a command line is a key in every process
                       listing on this machine.

Notifications:

  Only a notification the agent sends itself with qianmo_notify is printed
  here as [notify] and recorded as watch_notify_received. The steps a node
  reports while a job runs (one per tool start or failure) are process data:
  they are recorded as watch_step_received and not printed. A finished job is
  recorded as watch_result_received.

Emergency stop:

  touch <config>/qianmo/scheduler/ESTOP stops new fires and nothing else.
  Anything already dispatched keeps running: the node owes a task.result to
  whoever is waiting, and killing it in flight turns a slow answer into a lost
  one. Remove the file to resume; the schedule picks up with nothing to
  restart.`

export function isWatchHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

export function parseWatchArgs(
  args: readonly string[],
  identity: string = IDENTITY_MODE,
): WatchCommand {
  let jobsPath: string | undefined
  let from: string | undefined
  let stateDir: string | undefined
  let once = false
  let sign = false
  let printIdentity = false

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--jobs' || arg?.startsWith('--jobs=')) {
      const parsed = residentOptionValue(args, index, '--jobs')
      jobsPath = parsed.value
      index = parsed.next
    } else if (arg === '--from' || arg?.startsWith('--from=')) {
      const parsed = residentOptionValue(args, index, '--from')
      assertAddress(parsed.value, '--from')
      from = parsed.value
      index = parsed.next
    } else if (arg === '--state-dir' || arg?.startsWith('--state-dir=')) {
      const parsed = residentOptionValue(args, index, '--state-dir')
      stateDir = parsed.value
      index = parsed.next
    } else if (arg === '--once') {
      once = true
    } else if (arg === '--sign') {
      sign = true
    } else if (arg === '--print-identity') {
      printIdentity = true
    } else {
      throw new Error(
        `unknown watch option ${String(arg)}` +
          ` (run \`${invokedBinName()} watch --help\` for the list)`,
      )
    }
  }

  if (identity !== 'qianmo') {
    throw new Error('watch requires OCC_IDENTITY=qianmo')
  }
  if (printIdentity) {
    // 这条路径只用 `--from`。带上会让调度器启动的选项就报错，而不是悄悄忽略：
    // 运维以为自己启动了值守，实际上它只打印了一行公钥就退出了。
    if (jobsPath !== undefined || stateDir !== undefined || once || sign) {
      throw new Error(
        '--print-identity takes only --from: it prints the key and exits, and runs no jobs',
      )
    }
    if (from === undefined) throw new Error('--print-identity requires --from')
    return { mode: 'print-identity', from }
  }
  if (jobsPath === undefined) throw new Error('watch requires --jobs')
  if (from === undefined) throw new Error('watch requires --from')

  return {
    mode: 'run',
    jobsPath,
    from,
    stateDir: stateDir ?? occConfigPath('qianmo', 'scheduler'),
    once,
    sign,
  }
}

/**
 * 读出（首次运行时创建）中枢的签名身份。
 *
 * 直接复用控制台那一套（`consoleWakeIdentity.ts`），不是另写一份：
 *
 * - **密钥**是 `loadOrCreateNodeKeys(<--from 的 node 段>)`，落在
 *   `<config>/qianmo/identity/<node>.json`，路径由 `paths.ts` 派生。
 *   0700/0600，`wx` 创建，永不覆盖；
 * - **签发器**钉死 `write-limited`，令牌绑定 `(aud, sub, taskId, createdAt)`，
 *   有效期 60 s，`nbf` 往前挪 30 s 吸收时钟差。中枢签不出 `user-confirmed`
 *   （规则 S-1）。
 *
 * 身份名跟 `--from` 走，理由和控制台跟 `--chat-from` 走一样：这个名字就是节点
 * 审计链里的 `iss`，也是节点收到的通知要回复的地址。同一个名字在对方审计链里
 * 应该只对应一个身份。所以同一个配置根上的 `qm console` 和 `qm watch` 如果用同一个
 * node 名，就共用同一把密钥。
 */
export function loadWatchSigningIdentity(from: string): ConsoleWakeIdentity {
  return loadConsoleWakeIdentity(from)
}

/**
 * 启动时关于签名要说的话：签了打一行到 stdout，没签打一段告警到 stderr。
 *
 * 不签名时必须告警，因为这种失败从中枢一侧看不出来：`watch_fire` 照记、回执照收，
 * 节点照跑一轮，只是模型会拒绝执行作业。告警里写清两种策略下的后果和修复步骤。
 */
export function watchSigningNotice(
  identity: Pick<ConsoleWakeIdentity, 'node' | 'publicKey'> | undefined,
  from: string,
): { readonly stdout?: string; readonly stderr?: string } {
  if (identity !== undefined) {
    return {
      stdout: `[watch] signing task requests as ${identity.node}=${identity.publicKey} (write-limited)`,
    }
  }
  return {
    stderr:
      '[watch] warning: task requests are NOT signed (no --sign). A node under the ' +
      'default policy refuses them with E_CAP_INSUFFICIENT; a node under ' +
      '--open-policy runs them as untrusted messages, and the agent is told to ' +
      'treat their text as data, so it will not carry out the job. To sign: run ' +
      `\`${invokedBinName()} watch --print-identity --from ${from}\`, add ` +
      '--trust <node>=<publicKey> to every target node, then restart this with --sign.',
  }
}

/**
 * 一次 fire 发出的那条 `task.request`。
 *
 * `taskId` 与 `createdAt` 在这里生成，不交给 `createMessage` 的默认值。原因和
 * `executeResidentWake`、控制台对话面相同：令牌只绑定一个 `taskId`，所以这个值
 * 必须在信封构造之前就存在。同一个 `createdAt` 同时交给令牌和信封，令牌的有效
 * 窗口就是从它所在的信封算起的。
 *
 * `issue` 抛异常会直接传出去。调用方把这次 fire 记为失败，不会改发一条不签名
 * 的请求。
 */
export function buildWatchRequest(input: {
  readonly from: string
  readonly job: ScheduledJob
  readonly issue?: WakeCapabilityIssuer
  readonly now?: () => number
}): QianmoMessage {
  const target = assertAddress(input.job.target, 'job target')
  const taskId = newId()
  const createdAt = (input.now ?? Date.now)()
  const cap = input.issue?.({
    aud: target.node,
    // `sub` 是完整的地址，节点验签时拿它和 `message.to` 比较。
    sub: input.job.target,
    taskId,
    createdAt,
  })
  return createMessage({
    from: input.from,
    to: input.job.target,
    type: MessageType.TaskRequest,
    // §4.1③：一个作业 = 一条 contextId = 节点侧一条独立会话。
    contextId: input.job.id,
    // §4.1④：截止时间由作业说了算，不吃 LIMITS.defaultTaskTtlMs。
    taskTtlMs: input.job.taskTtlMs,
    payload: { ask: input.job.prompt },
    taskId,
    createdAt,
    ...(cap === undefined ? {} : { cap }),
  })
}

/**
 * `newId()` 生成的就是这个形状。本进程发出的每条请求都用它作 `msgId`
 * （`createMessage` 的缺省值）。
 */
const HUB_MSG_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 一条 `notify` 是给人的通知，还是一轮里的过程行。
 *
 * 过程行由节点在每个工具开始或失败时自动发出（`@qianmo/resident` 的
 * `turnStepDedupKey`），不是 agent 的决定。§4.1⑤ 规定只有 agent 显式调用
 * `qianmo_notify` 才打扰人，所以过程行在这里归为 `step`。
 *
 * 判据要同时满足三条，任何一条不成立都按给人的通知处理：
 *
 * 1. `kind === 'task'`。过程行固定是这个 kind，所以 agent 发的 `kind=watch`
 *    告警无论如何都不会被归为过程行；
 * 2. `dedupKey` 能被 {@link parseTurnStepDedupKey} 解析。格式只定义在常驻
 *    包里那一处；
 * 3. 解析出的 message id 是本进程格式的 id。过程行的 key 以触发这一轮的那条
 *    请求的 `msgId` 开头，而那条请求就是本进程发的。
 *
 * 出错时偏向多打一行，而不是漏掉一条告警：agent 自己选的 `dedupKey`
 * （例如 `disk:/`）不满足第 2、3 条，所以仍然会给人看。
 */
export function classifyWatchNotify(
  payload: NotifyPayload,
): 'notification' | 'step' {
  if (payload.kind !== 'task' || payload.dedupKey === undefined) {
    return 'notification'
  }
  const step = parseTurnStepDedupKey(payload.dedupKey)
  if (step === undefined || !HUB_MSG_ID_PATTERN.test(step.networkMsgId)) {
    return 'notification'
  }
  return 'step'
}

/**
 * 读作业文件。
 *
 * 校验一律在这里，而不是等到 fire 的时候——一个作业写一次要跑一周，缺陷若只在
 * fire 路径上暴露，就会每个周期无人值守地重犯一次，而且是往一条设计成静默的
 * 通道里犯。文件读进来的这一刻是最后一次有人在看。
 */
export function parseWatchJobs(source: string): readonly WatchJobEntry[] {
  const parsed: unknown = JSON.parse(source)
  if (!Array.isArray(parsed)) {
    throw new TypeError('jobs file must be a JSON array')
  }
  const seen = new Set<string>()
  return parsed.map((raw, index) => {
    const job = assertJob(raw)
    if (seen.has(job.id)) {
      // 两条同 id 的作业会共用同一把 dedupKey，于是「同一时刻的两个作业」被
      // CAS 判成同一次预约，其中一条永远不跑——而且一声不吭。
      throw new Error(`jobs file has two jobs with id ${job.id}`)
    }
    seen.add(job.id)
    const url = (raw as Record<string, unknown>).url
    if (typeof url !== 'string' || url.trim() === '') {
      throw new TypeError(`job ${job.id} (index ${index}) needs a "url"`)
    }
    return { job, url }
  })
}

/** 一个目标节点的长连接，跑完不关。 */
interface NodeLink {
  readonly client: TransportClient
  connected: Promise<void> | null
}

function detailOf(
  entries: Readonly<Record<string, string | number | boolean | undefined>>,
): Record<string, string | number | boolean> {
  const detail: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (value !== undefined) detail[key] = value
  }
  return detail
}

/**
 * 把一次 notify 落到审计链，是给人的通知时还要打到 stdout。
 *
 * stdout 不是调试输出。控制台的通知页还没做（见 §5 遗留），所以 `qm watch` 的
 * stdout 目前是值守场景唯一的人机界面，**只有给人的通知才能出现在这里**。过程行
 * 只进审计链，记为另一个 kind（`watch_step_received`），这样
 * `watch_notify_received` 的条数就等于「打扰了人几次」（console.md §10.2）。
 */
function recordNotify(
  trail: AuditTrail,
  node: string,
  message: QianmoMessage,
): void {
  const payload = message.payload
  if (!isNotifyPayload(payload)) return
  const toPerson = classifyWatchNotify(payload) === 'notification'
  if (toPerson) {
    const line = `[notify] ${new Date(payload.observedAt).toISOString()} ${payload.severity} ${message.contextId ?? '-'} ${payload.summary}`
    process.stdout.write(`${line}\n`)
    if (payload.detail !== undefined) {
      process.stdout.write(`         ${payload.detail}\n`)
    }
  }
  try {
    trail.append({
      at: Date.now(),
      source: AuditSource.Scheduler,
      kind: toPerson ? 'watch_notify_received' : 'watch_step_received',
      outcome: 'ok',
      node,
      peer: message.from,
      taskId: message.taskId,
      msgId: message.msgId,
      traceId: message.traceId,
      detail: detailOf({
        contextId: message.contextId,
        kind: payload.kind,
        severity: payload.severity,
        summary: payload.summary,
        redelivered: payload.redelivered === true,
        causeTaskId: payload.causeTaskId,
      }),
    })
  } catch {
    // 与其他几个 sink 同一条纪律：日志本写不动不该把值守作业停掉。
  }
}

/**
 * 一个作业跑完了：节点回的 `task.result`，或它拒收时回的 `error`。
 *
 * 只写审计链，不打 stdout。§4.1⑤ 说结果「进审计链」，但不会通知人。正文不写
 * 进审计链，只记字节数：审计链按条 fsync，也不是存放模型输出的地方。节点那一侧
 * 的会话记录里有全文。
 *
 * 失败的结果多记一个 `failure`：节点把模型错误写成可识别的 `reason`，这里用
 * {@link turnFailureKind} 读回来。`model_empty_response` 是模型连续空应答、重试
 * 用完；`model_error` 是其他模型错误（如网关 4xx）。认不出的失败不写这个字段。
 * 协议帧没有为此加字段：`task.result` 的错误码对所有执行失败都是 `E_TASK_FAILED`。
 */
function recordResult(
  trail: AuditTrail,
  node: string,
  message: QianmoMessage,
): void {
  const payload = message.payload
  let detail: Record<string, string | number | boolean>
  let code: string | undefined
  if (message.type === MessageType.TaskResult && isTaskResultPayload(payload)) {
    code = payload.outcome === 'failed' ? payload.code : undefined
    detail = detailOf({
      contextId: message.contextId,
      result: payload.outcome,
      contentBytes:
        payload.outcome === 'completed'
          ? Buffer.byteLength(payload.content, 'utf8')
          : undefined,
      reason: payload.outcome === 'failed' ? payload.reason : undefined,
      failure:
        payload.outcome === 'failed'
          ? turnFailureKind(payload.reason)
          : undefined,
      redelivered: payload.redelivered === true,
    })
  } else if (message.type === MessageType.Error) {
    const record =
      typeof payload === 'object' && payload !== null
        ? (payload as Record<string, unknown>)
        : {}
    code = typeof record['code'] === 'string' ? record['code'] : undefined
    detail = detailOf({
      contextId: message.contextId,
      result: 'error',
      reason:
        typeof record['reason'] === 'string' ? record['reason'] : undefined,
    })
  } else {
    return
  }
  try {
    trail.append({
      at: Date.now(),
      source: AuditSource.Scheduler,
      kind: 'watch_result_received',
      outcome: 'ok',
      node,
      peer: message.from,
      taskId: message.taskId,
      msgId: message.msgId,
      traceId: message.traceId,
      ...(code === undefined ? {} : { code }),
      detail,
    })
  } catch {
    // 同上。
  }
}

export async function runWatch(args: readonly string[]): Promise<void> {
  if (isWatchHelpRequest(args)) {
    process.stdout.write(`${WATCH_HELP_TEXT}\n`)
    return
  }
  const command = parseWatchArgs(args)
  // 排在 PSK 与作业文件之前：这条路径就是给「还没配好」的那一刻用的。
  if (command.mode === 'print-identity') {
    const identity = loadWatchSigningIdentity(command.from)
    process.stdout.write(`${identity.node}=${identity.publicKey}\n`)
    return
  }
  const config = command
  const psk = pskFromEnv()
  const entries = parseWatchJobs(readFileSync(config.jobsPath, 'utf8'))
  const hub = assertAddress(config.from, '--from')
  // 只在要签名时才读身份（首次运行会创建）。不签名的中枢不该在配置根里留下
  // 一把用不到的私钥。读不出来就让启动失败：运维明确要求了签名，照常启动却不签，
  // 正是这条路径上最难发现的失败。
  const identity = config.sign
    ? loadWatchSigningIdentity(config.from)
    : undefined
  const trail = openAuditTrail()

  const urls = new Map(entries.map(entry => [entry.job.id, entry.url]))
  const links = new Map<string, NodeLink>()

  const linkTo = async (url: string): Promise<TransportClient> => {
    let link = links.get(url)
    if (link === undefined) {
      const client = new TransportClient({
        endpoint: { url },
        node: hub.node,
        psk,
        // 声明全量类型，否则节点按能力发现（§2.7）会认定这个中枢不收 notify，
        // 一条都不发——而这正是本进程存在的理由。
        supportedTypes: [...Object.values(MessageType)],
        onMessage: message => {
          if (message.type === MessageType.Notify) {
            recordNotify(trail, hub.node, message)
          } else if (
            message.type === MessageType.TaskResult ||
            message.type === MessageType.Error
          ) {
            recordResult(trail, hub.node, message)
          }
        },
      })
      link = { client, connected: null }
      links.set(url, link)
    }
    link.connected ??= link.client.connect(CONNECT_TIMEOUT_MS)
    try {
      await link.connected
    } catch (error) {
      // 下一次 fire 重新拨；`connected` 清空是为了不把一次失败缓存成永久失败。
      link.connected = null
      throw error
    }
    return link.client
  }

  const store = new SchedulerStore(config.stateDir, {
    onError: error => {
      process.stderr.write(`[watch] store: ${String(error)}\n`)
    },
  })
  const estop = new ResidentEstop({
    path: occConfigPath('qianmo', 'scheduler', 'ESTOP'),
    onError: error => {
      process.stderr.write(`[watch] estop: ${String(error)}\n`)
    },
  })

  const runner = new SchedulerRunner({
    store,
    jobs: entries.map(entry => entry.job),
    paused: () => estop.engaged(),
    onError: error => {
      process.stderr.write(`[watch] ${String(error)}\n`)
    },
    dispatch: async fire => {
      const url = urls.get(fire.job.id)
      if (url === undefined) throw new Error(`job ${fire.job.id} has no url`)
      const client = await linkTo(url)
      // 令牌在连接建立之后才签：`linkTo` 最长可能等 30 s，放在它之前签，
      // 慢连接就会把 60 s 的有效期用掉一半。
      const message = buildWatchRequest({
        from: config.from,
        job: fire.job,
        ...(identity === undefined ? {} : { issue: identity.issue }),
      })
      trail.append({
        at: Date.now(),
        source: AuditSource.Scheduler,
        kind: 'watch_fire',
        outcome: 'ok',
        node: hub.node,
        peer: fire.job.target,
        taskId: message.taskId,
        msgId: message.msgId,
        traceId: message.traceId,
        detail: detailOf({
          jobId: fire.job.id,
          dedupKey: fire.dedupKey,
          fireAtMs: fire.fireAtMs,
          attempt: fire.attempt,
          notifyPolicy: fire.job.notifyPolicy,
          signed: message.cap !== undefined,
        }),
      })
      await client.sendAndWait(message, DISPATCH_RECEIPT_TIMEOUT_MS)
    },
  })

  process.stdout.write(
    `[watch] ${entries.length} job(s) from ${config.jobsPath}, state in ${config.stateDir}\n`,
  )
  const signing = watchSigningNotice(identity, config.from)
  if (signing.stdout !== undefined) process.stdout.write(`${signing.stdout}\n`)
  if (signing.stderr !== undefined) process.stderr.write(`${signing.stderr}\n`)

  if (config.once) {
    await runner.runDue(Date.now())
    for (const link of links.values()) await link.client.close()
    return
  }

  runner.start()
  const stop = (): void => {
    runner.stop()
    void (async () => {
      for (const link of links.values()) await link.client.close()
    })()
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  // 一直跑下去。停手由上面两个信号负责——值守作业的常态就是这个进程不退。
  await new Promise<void>(() => {})
}
