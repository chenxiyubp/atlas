// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 恢复维度。
 *
 * 「重启之后还是同一个节点吗」这个问题的答案由**配置根**决定：身份密钥、
 * 审计链、会话表全锚在它上面。所以这一维的每条场景都是「同一个配置根，换一个
 * 进程」，驱动的 `restartNode` 也因此硬性保留配置根。
 *
 * 两条**如实记录设计边界**的场景（都会通过）：
 *   · nonce 表在进程内存里，重启即清空 —— 于是一个跨重启的 token 重放**会被
 *     放行**。这不是回归，是当前设计；写成场景是为了它哪天变了有人知道。
 *   · `lifecycle.json` 是取证不是锁：SIGKILL 之后它仍写着 `running`，下次启动
 *     读到就知道上一条命是被打断的，并在 stdout 的 banner 之后单起一行报出来
 *     （`"priorLife":"killed"`）—— 但**它不门控任何东西**。
 */

import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { mint, sendEnvelope } from '../local/send.js'
import { identityPath, LIFECYCLE_PATH, readTrail } from '../observe.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  NODE,
  SENDER,
  SENDER_NODE,
  newParty,
  newTaskId,
  startNodeTrusting,
} from './fixtures.js'

export const recoveryScenarios: readonly Scenario[] = [
  {
    id: 'recovery/identity-survives-restart',
    dimension: 'recovery',
    title: '重启之后节点身份不变',
    expected: '两次启动 banner 里的 publicKey 相同，身份文件内容逐字不变',
    requires: ['spawn-node', 'restart-node', 'read-node-files'],
    timeoutMs: 150_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      const before = await ctx.driver.readNodeFile(node, identityPath(NODE))
      const bannerBefore = (await node.stdout())
        .split('\n')
        .find(l => l.includes('publicKey'))

      const restarted = await ctx.driver.restartNode(ctx, node)
      const after = await ctx.driver.readNodeFile(restarted, identityPath(NODE))
      const bannerAfter = (await restarted.stdout())
        .split('\n')
        .find(l => l.includes('publicKey'))

      const keyOf = (banner: string | undefined): string | undefined => {
        if (banner === undefined) return undefined
        return /"publicKey":"([^"]+)"/.exec(banner)?.[1]
      }
      return new Checks()
        .note('重启前 banner', bannerBefore ?? '(无)')
        .note('重启后 banner', bannerAfter ?? '(无)')
        .expect(before !== undefined, '身份文件存在', before !== undefined)
        .eq(after, before, '身份文件内容')
        .expect(
          keyOf(bannerBefore) !== undefined &&
            keyOf(bannerBefore) === keyOf(bannerAfter),
          '两次 banner 报的公钥相同',
          `${keyOf(bannerBefore) ?? '-'} vs ${keyOf(bannerAfter) ?? '-'}`,
        )
        .done('身份跨重启稳定')
    },
  },

  {
    id: 'recovery/audit-chain-continues',
    dimension: 'recovery',
    title: '重启之后审计链接着写，而不是另起一条',
    expected: 'seq 从重启前的最大值 +1 继续，且新记录的 prev 接得上',
    requires: [
      'spawn-node',
      'restart-node',
      'raw-dial',
      'read-node-files',
      'exec-node-cli',
    ],
    timeoutMs: 180_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        payload: { trigger: 'manual', prompt: 'before restart' },
      })
      const before = await readTrail(ctx.driver, node)
      const lastSeq = before.at(-1)?.seq ?? 0

      const restarted = await ctx.driver.restartNode(ctx, node)
      await sendEnvelope({
        url: restarted.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        payload: { trigger: 'manual', prompt: 'after restart' },
      })
      const after = await readTrail(ctx.driver, restarted)
      const verify = await ctx.driver.execNode(restarted, ['audit', '--verify'])

      return new Checks()
        .note(
          '重启前的 seq',
          before.map(r => r.seq),
        )
        .note(
          '重启后的 seq',
          after.map(r => r.seq),
        )
        .note('verify 输出', verify.stdout)
        .expect(lastSeq > 0, '重启前链里已有记录', lastSeq)
        .expect(
          after.length > before.length,
          '重启后链变长了（接着写，没有清空）',
          `${before.length} → ${after.length}`,
        )
        .expect(
          after.every((r, i) => r.seq === i + 1),
          'seq 全程从 1 起连续（没有第二条链插进来）',
          after.map(r => r.seq),
        )
        .contains(verify.stdout, '"chain": "intact"', 'verify 输出')
        .eq(verify.code, 0, 'verify 退出码')
        .done('审计链跨重启连续')
    },
  },

  {
    id: 'recovery/lifecycle-records-hard-kill',
    dimension: 'recovery',
    title:
      'SIGKILL 之后 lifecycle.json 仍写着 running，下一条命报出 killed（取证，不门控）',
    expected:
      "被 KILL 的进程留下 phase='running'，下一条命的 stdout 报 priorLife=killed " +
      '且带着那条命的 pid / startedAt / updatedAt；正常停止留下 ' +
      "phase='stopped'，再下一条命报 clean；全新配置根上的第一条命报 unknown",
    requires: ['spawn-node', 'restart-node', 'read-node-files'],
    timeoutMs: 240_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      const running = await ctx.driver.readNodeFile(node, LIFECYCLE_PATH)
      const firstSaid = priorLifeOf(await node.stdout())

      // SIGKILL 走驱动接口。它此前是本地驱动专有的方法、靠一次 `as unknown as
      // LocalDriver` 够到 —— 那条强转在真机腿上会变成一次 `TypeError`，而
      // `requires` 里没有任何东西拦得住（issue #65）。
      await ctx.driver.killNode(node)
      const afterKill = await ctx.driver.readNodeFile(node, LIFECYCLE_PATH)

      const restarted = await ctx.driver.restartNode(ctx, node)
      // 判定在 `run()` 开头、绑监听口之前就打出来了，驱动以拨通为就绪，
      // 所以此刻这一行必然已经落地。
      const secondSaid = priorLifeOf(await restarted.stdout())
      await ctx.driver.stopNode(restarted)
      // 停止是异步落盘的，给它一拍。
      await new Promise(resolve => setTimeout(resolve, 1_500))
      const afterStop = await ctx.driver.readNodeFile(restarted, LIFECYCLE_PATH)

      const third = await ctx.driver.restartNode(ctx, restarted)
      const thirdSaid = priorLifeOf(await third.stdout())

      const phaseOf = (raw: string | undefined): string | undefined =>
        parseObject(raw)?.phase as string | undefined
      const killedRecord = parseObject(afterKill)
      const reported = secondSaid?.prior as Record<string, unknown> | undefined
      return new Checks()
        .note('运行中', running ?? '(无)')
        .note('SIGKILL 之后', afterKill ?? '(无)')
        .note('SIGTERM 之后', afterStop ?? '(无)')
        .note('第一条命的 priorLife 行', firstSaid ?? '(无)')
        .note('KILL 之后那条命的 priorLife 行', secondSaid ?? '(无)')
        .note('正常停止之后那条命的 priorLife 行', thirdSaid ?? '(无)')
        .eq(phaseOf(running), 'running', '运行中的 phase')
        .eq(
          phaseOf(afterKill),
          'running',
          'SIGKILL 之后的 phase（没来得及改写）',
        )
        .eq(phaseOf(afterStop), 'stopped', '正常停止之后的 phase')
        .eq(firstSaid?.priorLife, 'unknown', '全新配置根上第一条命报的')
        .eq(secondSaid?.priorLife, 'killed', 'KILL 之后那条命报的')
        .expect(
          killedRecord !== undefined &&
            reported !== undefined &&
            reported.pid === killedRecord.pid &&
            reported.startedAt === killedRecord.startedAt &&
            reported.updatedAt === killedRecord.updatedAt,
          'killed 带的 pid / startedAt / updatedAt 与被杀那条命留下的记录逐项相同',
          reported,
        )
        .eq(thirdSaid?.priorLife, 'clean', '正常停止之后那条命报的')
        .done('上一条命的死法留了痕，下一条命也说出来了')
    },
  },

  {
    id: 'recovery/nonce-store-resets-on-restart',
    dimension: 'recovery',
    title: 'nonce 表随进程消失：跨重启的 token 重放会被放行（设计边界）',
    expected:
      '同一个 token 在重启前被 nonce 拒，重启后同一个 token 又能过 —— 这是当前设计，不是回归',
    requires: ['spawn-node', 'restart-node', 'raw-dial'],
    timeoutMs: 180_000,
    async run(ctx) {
      const party = newParty()
      const node = await startNodeTrusting(ctx, party, {
        policy: 'signed-task',
      })
      const taskId = newTaskId()
      // 有效期给足，跨得过一次重启。
      const cap = mint(party.issuer, {
        sub: ADDRESS,
        aud: NODE,
        taskId,
        exp: Date.now() + 600_000,
      })
      const base = {
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        cap,
        taskId,
      }
      const first = await sendEnvelope({
        ...base,
        url: node.endpoint,
        payload: { trigger: 'manual', prompt: 'one' },
      })
      const replayBefore = await sendEnvelope({
        ...base,
        url: node.endpoint,
        payload: { trigger: 'manual', prompt: 'two' },
      })

      const restarted = await ctx.driver.restartNode(ctx, node)
      const replayAfter = await sendEnvelope({
        ...base,
        url: restarted.endpoint,
        payload: { trigger: 'manual', prompt: 'three' },
      })

      return new Checks()
        .note(
          '为什么这条是绿的',
          'NonceStore 是进程内的 Map，没有持久化。重启后的放行是当前设计的直接后果；写成场景是为了它哪天变了（或该变而没变）有人立刻知道。',
        )
        .eq(first.receipt, 'accepted', '首发 receipt')
        .eq(replayBefore.errorCode, 'E_CAP_INVALID', '重启前重放的 code')
        .eq(
          replayBefore.errorReason,
          'capability nonce has already been used',
          '重启前重放的 reason',
        )
        .eq(replayAfter.receipt, 'accepted', '重启后同一个 token 的 receipt')
        .eq(replayAfter.errorCode, undefined, '重启后没有被 nonce 拒')
        .done('nonce 不跨进程（已记录的边界）')
    },
  },

  {
    id: 'recovery/foreign-identity-refused',
    dimension: 'recovery',
    title: '配置根里躺着别的节点的身份文件 → 拒绝启动，不覆盖',
    expected:
      "启动失败，错误里含 'belongs to another node; refusing to replace it'",
    requires: ['spawn-node'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      await ctx.driver.stopNode(node)
      const identity = await ctx.driver.readNodeFile(node, identityPath(NODE))
      if (identity === undefined) {
        return new Checks().skip(
          '读不到身份文件，无法构造「文件属于别人」的现场',
        )
      }
      // 把文件里的 node 字段改成另一个名字，再用原来的 --node 起 —— 这就是
      // 「配置根被别的节点用过」的现场。经驱动写：真机腿上配置根在另一台机器上。
      const parsed = JSON.parse(identity) as Record<string, unknown>
      parsed.node = 'someone-else'
      await ctx.driver.writeNodeFile(
        node,
        identityPath(NODE),
        `${JSON.stringify(parsed, null, 2)}\n`,
      )

      let error = ''
      try {
        const restarted = await ctx.driver.restartNode(ctx, node)
        error = `节点竟然起来了：${(await restarted.stderr()).slice(0, 500)}`
        return new Checks()
          .note('现场', error)
          .expect(false, '起不来（不应覆盖别人的身份文件）', error)
          .done('外来身份文件')
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      return new Checks()
        .note('启动失败原文', error)
        .contains(
          error,
          'belongs to another node; refusing to replace it',
          '启动失败原文',
        )
        .done('拒绝覆盖别人的身份文件')
    },
  },
]

/** 一段 JSON 文本里的顶层对象；读不到、解析不了、不是对象都是 `undefined`。 */
function parseObject(
  raw: string | undefined,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 节点 stdout 里报上一条命结局的那一行（`qm resident` 在 banner 之后打）。
 * 取**最后**一行：同一份输出里若有多次启动，要的是最近那次。
 */
function priorLifeOf(stdout: string): Record<string, unknown> | undefined {
  const line = stdout
    .split('\n')
    .filter(l => l.includes('"priorLife"'))
    .at(-1)
  return parseObject(line)
}
