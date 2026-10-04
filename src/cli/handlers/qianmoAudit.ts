// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `occ audit` — the query CLI P7.2 asks for.
 *
 *   occ audit --trace <traceparent-or-segment>
 *   occ audit --agent qianmo://node-a/planner --from 2026-08-14T00:00:00Z
 *   occ audit --verify
 *
 * Three shapes on purpose, because they are the three questions people actually
 * bring: *what happened to this task*, *what has this agent been doing*, and
 * *is this trail still intact*.
 *
 * ## What it never prints
 *
 * Message payloads. The trail does not carry them (records hold ids, codes and
 * counts), and this command adds nothing — a support engineer pasting a chain
 * into a ticket should not have to redact it first.
 */

import {
  formatChain,
  queryTrail,
  readTrail,
  reconstructChain,
  type AuditRecord,
} from '@qianmo/audit'
import { verifyAuditWitness, type WitnessEvidence } from '@qianmo/witness'
import { invokedBinName } from '../../constants/brand.js'
import { auditTrailPath } from '../../services/qianmo/auditTrail.js'
import {
  parseAuditWitnessSource,
  readAuditWitnessAnchors,
  WITNESS_READ_TOKEN_ENV_VAR,
  witnessNodeOf,
  type AuditWitnessSource,
} from '../../services/qianmo/auditWitness.js'
import { readNodePublicKey } from '../../services/qianmo/nodeIdentity.js'
import { residentOptionValue } from './residentArgs.js'

/**
 * Records printed when `--limit` is not given, counted from the tail.
 *
 * Hoisted out of the parser so the help text can quote it instead of carrying
 * a second copy of the number.
 */
const DEFAULT_AUDIT_LIMIT = 200

/** Parsed flags. Not exported: nothing outside this file needs the shape. */
interface QianmoAuditConfig {
  readonly path: string
  readonly trace?: string
  readonly agent?: string
  readonly task?: string
  readonly from?: number
  readonly to?: number
  readonly json: boolean
  readonly verify: boolean
  readonly witness?: AuditWitnessSource
  readonly limit: number
}

/** Injected only by handler tests; production uses the host source loader. */
interface QianmoAuditRuntimeOptions {
  readonly readWitnessAnchors?: (
    source: AuditWitnessSource,
    node: string,
  ) => Promise<readonly WitnessEvidence[]>
}

/** Accepts an ISO timestamp or raw epoch ms — both turn up in tickets. */
function parseInstant(raw: string, flag: string): number {
  if (/^\d+$/.test(raw)) return Number(raw)
  const parsed = Date.parse(raw)
  if (Number.isNaN(parsed)) {
    throw new Error(`${flag} must be an ISO timestamp or epoch milliseconds`)
  }
  return parsed
}

/**
 * `--help` / `-h` 出现在任何位置都算请求帮助。
 *
 * 位置不限，是因为「敲到一半发现忘了选项名」正是人会做的事：
 * `occ audit --verify --help` 必须答帮助，而不是先解析出一个查询再抛。判定用
 * **全等**，所以 `--trace=--help` 这种把它当值的写法不会被当成请求。
 *
 * 为什么不落回 commander：`audit` 的子命令注册
 * （`cli/program/commands/qianmo.tsx`）**刻意不复制选项表**（那个文件的顶部注释
 * 写着这条），落回去只会打印一行描述加一个空的选项列表。选项的唯一出处是本文件
 * 的解析器，帮助文本因此也在这里。
 */
export function isQianmoAuditHelpRequest(args: readonly string[]): boolean {
  return args.some(arg => arg === '--help' || arg === '-h')
}

/**
 * `occ audit --help` 打印的全文。
 *
 * 这条命令没有一份对应的选项表文档，所以这里是唯一的自助入口。两件不看源码就
 * 会踩的事必须写在这里：**至少要给一个查询条件**（否则报错而不是打印整条链），
 * 以及 `--verify` 在链断或锚点不符时**退出码 1**——那正是它能进 cron 的原因。
 */
export const QIANMO_AUDIT_HELP_TEXT = `Usage: ${invokedBinName()} audit [options]

Query this node's audit trail: what happened to one task, what an agent has
been up to, and whether the chain is still intact. Message payloads are never
printed -- the trail does not carry them, and this command adds nothing.

At least one of --trace / --agent / --task / --from / --to is required, or
--verify on its own. Printing the whole trail by default would be the least
useful thing this command could do with a file that only grows.

Options (each accepts both --name value and --name=value):

  --trace <trace id>       Reconstruct one task's chain from a traceparent or
                           a bare trace-id segment, refused records included.
  --agent <address>        Records for one qianmo://<node>/<agent>.
  --task <task id>         Records for one task.
  --from <time>            Lower time bound, an ISO timestamp or epoch
                           milliseconds; both turn up in tickets.
  --to <time>              Upper time bound, same two forms.
  --limit <n>              Keep at most this many records, counted from the
                           tail. A positive integer, default ${DEFAULT_AUDIT_LIMIT}; it does not
                           apply to --trace or --verify.
  --json                   Print JSON instead of one line per record.
  --verify                 Report the chain's integrity and exit 1 when it is
                           broken or its witness disagrees, so the check can
                           live in a cron job. Valid on its own.
  --witness <path|url>     Witness anchor directory (absolute) or HTTP(S)
                           endpoint. Requires --verify.
  --path <file>            Trail file to read.
                           Default <config root>/qianmo/audit/trail.ndjson.
  -h, --help               Print this and exit.

Integrity is reported even when it was not asked for: a warning goes to stderr
whenever the trail has issues. Reading a chain out of a file somebody has
edited, and not saying so, is the one failure this command must not have.

Environment:

  OCC_CONFIG_DIR           Config root the default trail path is derived from.
  OCC_IDENTITY             Selects which identity owns that config root, so it
                           also selects which trail the default path names.
                           Unlike the other Qianmo commands this one does not
                           require "qianmo".
  ${WITNESS_READ_TOKEN_ENV_VAR}
                           Read-only token for a remote --witness endpoint.
`

export function parseQianmoAuditArgs(
  args: readonly string[],
): QianmoAuditConfig {
  let path = auditTrailPath()
  let trace: string | undefined
  let agent: string | undefined
  let task: string | undefined
  let from: number | undefined
  let to: number | undefined
  let json = false
  let verify = false
  let witness: AuditWitnessSource | undefined
  let limit = DEFAULT_AUDIT_LIMIT

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--path' || arg?.startsWith('--path=')) {
      const parsed = residentOptionValue(args, index, '--path')
      path = parsed.value
      index = parsed.next
    } else if (arg === '--trace' || arg?.startsWith('--trace=')) {
      const parsed = residentOptionValue(args, index, '--trace')
      trace = parsed.value
      index = parsed.next
    } else if (arg === '--agent' || arg?.startsWith('--agent=')) {
      const parsed = residentOptionValue(args, index, '--agent')
      agent = parsed.value
      index = parsed.next
    } else if (arg === '--task' || arg?.startsWith('--task=')) {
      const parsed = residentOptionValue(args, index, '--task')
      task = parsed.value
      index = parsed.next
    } else if (arg === '--from' || arg?.startsWith('--from=')) {
      const parsed = residentOptionValue(args, index, '--from')
      from = parseInstant(parsed.value, '--from')
      index = parsed.next
    } else if (arg === '--to' || arg?.startsWith('--to=')) {
      const parsed = residentOptionValue(args, index, '--to')
      to = parseInstant(parsed.value, '--to')
      index = parsed.next
    } else if (arg === '--limit' || arg?.startsWith('--limit=')) {
      const parsed = residentOptionValue(args, index, '--limit')
      const value = Number(parsed.value)
      if (!Number.isInteger(value) || value < 1) {
        throw new Error('--limit must be a positive integer')
      }
      limit = value
      index = parsed.next
    } else if (arg === '--json') {
      json = true
    } else if (arg === '--verify') {
      verify = true
    } else if (arg === '--witness' || arg?.startsWith('--witness=')) {
      const parsed = residentOptionValue(args, index, '--witness')
      witness = parseAuditWitnessSource(parsed.value, '--witness')
      index = parsed.next
    } else {
      // 指一下帮助：走到这一支的人多半是拼错了选项名，而在 `--help` 存在之前
      // 他没有任何地方可以去查那张表。
      throw new Error(
        `unknown audit option ${String(arg)}` +
          ` (run \`${invokedBinName()} audit --help\` for the list)`,
      )
    }
  }

  if (witness !== undefined && !verify) {
    throw new Error('--witness requires --verify')
  }
  if (
    !verify &&
    trace === undefined &&
    agent === undefined &&
    task === undefined &&
    from === undefined &&
    to === undefined
  ) {
    // Printing the whole trail by default would be the least useful thing this
    // command could do with a file that grows forever.
    throw new Error(
      'audit needs at least one of --trace / --agent / --task / --from / --to, or --verify',
    )
  }
  return {
    path,
    ...(trace === undefined ? {} : { trace }),
    ...(agent === undefined ? {} : { agent }),
    ...(task === undefined ? {} : { task }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    json,
    verify,
    ...(witness === undefined ? {} : { witness }),
    limit,
  }
}

/** One line per record, for the non-chain queries. */
function formatRecord(record: AuditRecord): string {
  const mark =
    record.outcome === 'ok' ? ' ' : record.outcome === 'refused' ? '✗' : '·'
  return (
    `${mark} #${String(record.seq).padStart(4, '0')} ` +
    `${new Date(record.at).toISOString()} ${record.source}/${record.kind}` +
    `${record.code === undefined ? '' : ` [${record.code}]`}` +
    `${record.taskId === undefined ? '' : ` task=${record.taskId}`}`
  )
}

export async function runQianmoAudit(
  args: readonly string[],
  runtime: QianmoAuditRuntimeOptions = {},
): Promise<void> {
  // 帮助排在最前面，在任何解析与磁盘读取之前：问「这个命令怎么用」的人恰恰是
  // 还不知道要给哪个查询条件的那个人，而不给条件正是这个解析器会抛的第一件事。
  if (isQianmoAuditHelpRequest(args)) {
    process.stdout.write(QIANMO_AUDIT_HELP_TEXT)
    return
  }
  const config = parseQianmoAuditArgs(args)
  const { records, issues, intact, present } = readTrail(config.path)

  if (config.verify) {
    const witness =
      config.witness === undefined
        ? undefined
        : await verifyConfiguredWitness(
            config.path,
            records,
            config.witness,
            runtime.readWitnessAnchors,
          )
    // 与控制台同一套四态（`AuditChainState`）：`records: 0` 有两种成因，而
    // `intact` 表达不了它们的差别——「还没做过协议工作」和「链根本不在这里」
    // 在一条 `intact: true` 上长得一模一样。
    const chain = !present
      ? 'absent'
      : !intact
        ? 'broken'
        : records.length === 0
          ? 'empty'
          : 'intact'
    const summary = {
      path: config.path,
      records: records.length,
      chain,
      // 同一个判据，两张面上不能各写一份：有链且没毛病才算完整——空链算，
      // 缺文件不算。
      intact: chain === 'intact' || chain === 'empty',
      issues,
      ...(witness === undefined ? {} : { witness }),
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
    // A broken chain is a finding, and a command that reported it with exit 0
    // would be a command nobody could put in a cron job.
    //
    // 退出码只由「发现了问题」驱动，因此**不看** `chain`：一条还没建立的链
    // 不是一个发现，把它算成失败会让每台新节点上的定时任务从第一分钟起就
    // 报警——那正是 issue #9① 里 mirror 单元每 5 分钟 fail 一次的形状。
    process.exitCode = intact && witness?.tampered !== true ? 0 : 1
    return
  }

  // Integrity is reported even when it was not asked for: reading a chain out
  // of a trail somebody has edited, and not saying so, is the one failure this
  // command must not have.
  if (!intact) {
    process.stderr.write(
      `warning: this trail has ${issues.length} integrity issue(s); run with --verify\n`,
    )
  }

  if (config.trace !== undefined) {
    const chain = reconstructChain(records, config.trace)
    if (chain === null) {
      process.stderr.write(`no records for trace ${config.trace}\n`)
      process.exitCode = 1
      return
    }
    process.stdout.write(
      config.json
        ? `${JSON.stringify(chain, null, 2)}\n`
        : `${formatChain(chain)}\n`,
    )
    return
  }

  const matched = queryTrail(records, {
    ...(config.agent === undefined ? {} : { agent: config.agent }),
    ...(config.task === undefined ? {} : { taskId: config.task }),
    ...(config.from === undefined ? {} : { from: config.from }),
    ...(config.to === undefined ? {} : { to: config.to }),
  }).slice(-config.limit)

  if (config.json) {
    process.stdout.write(`${JSON.stringify(matched, null, 2)}\n`)
    return
  }
  if (matched.length === 0) {
    process.stdout.write('no records matched\n')
    return
  }
  process.stdout.write(`${matched.map(formatRecord).join('\n')}\n`)
}

/** Verify only with an identity already established outside the anchor source. */
async function verifyConfiguredWitness(
  trailPath: string,
  records: readonly AuditRecord[],
  source: AuditWitnessSource,
  readAnchors = readAuditWitnessAnchors,
) {
  const node = witnessNodeOf(records)
  if (node === null) {
    throw new Error(
      'cannot verify an empty audit trail without a node identity',
    )
  }
  const publicKey = readNodePublicKey(node)
  if (publicKey === null) {
    throw new Error(
      `no established public key for node ${node}; verify from that node's config root`,
    )
  }
  return verifyAuditWitness({
    trailPath,
    anchors: await readAnchors(source, node),
    publicKey,
  })
}
