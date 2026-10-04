// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 审计链维度。
 *
 * **`qm audit --verify` 的输出是 JSON，不是一句 `chain:intact`。** 判据落在
 * `chain` 字段上，它有且只有四个取值：`absent` / `empty` / `intact` / `broken`。
 * 退出码**分辨不了前三个**（都是 0），只有 `broken` 是 1 —— 这是故意的：一条
 * 还没建立的链不是一个「发现」，把它算成失败会让每台新节点上的定时任务从第
 * 一分钟起就报警，而那正是 issue #9① 里 mirror 单元每五分钟 fail 的形状。
 *
 * 所以「链不存在 vs 链为空」（issue #9②）这条**必须断言 `chain` 字段**，
 * 断言退出码会得到一个永远绿的用例。
 *
 * 另有一条**已知的检测边界**要钉住而不是回避：整条链被重新计算过（每条记录
 * 的 `prev` 都自洽地改了一遍）时，本地 `--verify` 检测不到。要抓那种要靠
 * `--witness` 的离机锚点。把这条写成一条会通过的场景，是为了让将来有人改动
 * 这个边界时套件立刻出声。
 */

import { Checks } from '../checks.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { sendEnvelope } from '../local/send.js'
import { auditVerify, readTrail, TRAIL_PATH } from '../observe.js'
import type { Scenario, ScenarioContext, NodeHandle } from '../types.js'
import {
  ADDRESS,
  SENDER,
  SENDER_NODE,
  newParty,
  startNodeTrusting,
} from './fixtures.js'

/** 让节点写几条审计记录出来（发几条会被拒的消息就够）。 */
async function seedTrail(
  ctx: ScenarioContext,
  node: NodeHandle,
  rounds = 3,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await sendEnvelope({
      url: node.endpoint,
      psk: ACCEPTANCE_PSK,
      fromNode: SENDER_NODE,
      from: SENDER,
      to: ADDRESS,
      payload: { trigger: 'manual', prompt: `audit seed ${i}` },
      settleMs: 800,
    })
  }
}

export const auditScenarios: readonly Scenario[] = [
  {
    id: 'audit/verify-intact',
    dimension: 'audit',
    title: '正常跑过一阵之后：chain=intact、exit 0、无 issue',
    expected: "chain='intact'、intact=true、issues 为空、退出码 0",
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      await seedTrail(ctx, node)
      const verify = await auditVerify(ctx.driver, node)
      return new Checks()
        .note('verify 输出', verify.stdout)
        .eq(verify.report?.chain, 'intact', 'chain')
        .eq(verify.report?.intact, true, 'intact')
        .eq(verify.report?.issues.length, 0, 'issues 条数')
        .eq(verify.exitCode, 0, '退出码')
        .expect(
          (verify.report?.records ?? 0) > 0,
          '链里有记录',
          verify.report?.records,
        )
        .done('完整链被判为 intact')
    },
  },

  {
    id: 'audit/absent-vs-empty',
    dimension: 'audit',
    title: '「链不存在」与「链为空」可区分（issue #9②）',
    expected:
      "不存在 → chain='absent'/intact=false；存在但零记录 → chain='empty'/intact=true；两者退出码都是 0",
    requires: ['spawn-node', 'exec-node-cli'],
    timeoutMs: 90_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), { policy: 'open' })
      // 两条路径都必须落在**跑 `qm audit --verify` 的那台机器**上：`execNode`
      // 在真机腿上是一次 ssh，runner 侧的临时目录在那边根本不存在，指过去
      // 得到的是「absent」——那正好是这条场景的一半期望，于是它会**因为错误的
      // 理由变绿**。经 `writeNodeFile` 就没有这个歧义。
      const missing = `${node.configRoot}/no-such-trail.ndjson`
      const emptyPath = await ctx.driver.writeNodeFile(
        node,
        'empty-trail.ndjson',
        '',
      )

      const absent = await auditVerify(ctx.driver, node, missing)
      const empty = await auditVerify(ctx.driver, node, emptyPath)
      return (
        new Checks()
          .note('absent 输出', absent.stdout)
          .note('empty 输出', empty.stdout)
          .eq(absent.report?.chain, 'absent', '不存在时的 chain')
          .eq(absent.report?.intact, false, '不存在时的 intact')
          .eq(empty.report?.chain, 'empty', '为空时的 chain')
          .eq(empty.report?.intact, true, '为空时的 intact')
          .expect(
            absent.report?.chain !== empty.report?.chain,
            '两种状态在输出里可区分',
            `${absent.report?.chain} vs ${empty.report?.chain}`,
          )
          // 退出码故意都是 0 —— 断言它，免得有人「顺手」把 absent 改成 1，
          // 那会让每台新节点的定时任务从第一分钟起报警。
          .eq(absent.exitCode, 0, '不存在时的退出码')
          .eq(empty.exitCode, 0, '为空时的退出码')
          .done('两种空状态可区分')
      )
    },
  },

  {
    id: 'audit/tamper-detected',
    dimension: 'audit',
    title: '改一行就断链，且断点被定位',
    expected:
      "chain='broken'、退出码 1、issues 里有 broken_chain 并带行号与 seq",
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'read-node-files'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      await seedTrail(ctx, node, 4)
      await ctx.driver.stopNode(node)

      // 直接改盘上的那一行。读写都经驱动 —— 真机腿上的一次性节点在另一台
      // 机器上，`node:fs` 在那里写的是 runner 自己的一条不存在的路径，而
      // 「链没被改动」和「链被改动了但改在别处」在断言里长得完全一样。
      const trailText = await ctx.driver.readNodeFile(node, TRAIL_PATH)
      const lines = (trailText ?? '').split('\n').filter(l => l !== '')
      if (lines.length < 3) {
        return new Checks()
          .note('链内容', lines.join('\n'))
          .skip(`链里只有 ${lines.length} 条记录，不够做「改中间一行」的实验`)
      }
      const targetIndex = 1
      const target = JSON.parse(lines[targetIndex] as string) as Record<
        string,
        unknown
      >
      const before = JSON.stringify(target)
      target.outcome = target.outcome === 'ok' ? 'refused' : 'ok'
      lines[targetIndex] = JSON.stringify(target)
      await ctx.driver.writeNodeFile(node, TRAIL_PATH, `${lines.join('\n')}\n`)

      const verify = await auditVerify(ctx.driver, node)
      const broken =
        verify.report?.issues.filter(i => i.kind === 'broken_chain') ?? []
      return (
        new Checks()
          .note('被改的那条（改前）', before)
          .note('被改的那条（改后）', lines[targetIndex] ?? '')
          .note('verify 输出', verify.stdout)
          .eq(verify.report?.chain, 'broken', 'chain')
          .eq(verify.report?.intact, false, 'intact')
          .eq(verify.exitCode, 1, '退出码')
          .expect(
            broken.length > 0,
            'issues 里有 broken_chain',
            verify.report?.issues,
          )
          .expect(
            broken.every(i => typeof i.line === 'number' && i.line > 0),
            '断点带行号',
            broken,
          )
          // 报的是**下一条**记录的 seq：被改那条自己仍然自洽，坏掉的是它的
          // 后继（后继的 prev 对不上了）。这条注释省下一次「为什么 seq 差一」。
          .expect(
            broken.some(i => i.seq === (target.seq as number) + 1),
            '报的 seq 是被改记录的后继',
            `改的是 seq=${String(target.seq)}，报的是 ${broken.map(i => i.seq).join(',')}`,
          )
          .done('篡改被检出并定位')
      )
    },
  },

  {
    id: 'audit/torn-tail-detected',
    dimension: 'audit',
    title: '写到一半的尾行被识别为 torn_tail（而不是当成篡改）',
    expected: "issues 里出现 kind='torn_tail'，chain='broken'、退出码 1",
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'read-node-files'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      await seedTrail(ctx, node, 3)
      await ctx.driver.stopNode(node)

      const text = (await ctx.driver.readNodeFile(node, TRAIL_PATH)) ?? ''
      // 砍掉最后一条记录的后半截，模拟一次写到一半的崩溃。
      const cut = text.slice(0, Math.max(1, text.length - 40))
      await ctx.driver.writeNodeFile(node, TRAIL_PATH, cut)

      const verify = await auditVerify(ctx.driver, node)
      return new Checks()
        .note('verify 输出', verify.stdout)
        .eq(verify.report?.chain, 'broken', 'chain')
        .eq(verify.exitCode, 1, '退出码')
        .expect(
          verify.report?.issues.some(i => i.kind === 'torn_tail') === true,
          'issues 里有 torn_tail（残尾不是篡改，但仍然让 verify 失败）',
          verify.report?.issues,
        )
        .done('残尾被识别')
    },
  },

  {
    id: 'audit/full-rewrite-not-detected-locally',
    dimension: 'audit',
    title: '整条链重算后本地检测不到（已知边界，要靠离机见证）',
    expected:
      "重链之后 chain 回到 'intact'、退出码 0 —— 这是设计上的边界，不是回归",
    requires: ['spawn-node', 'raw-dial', 'exec-node-cli', 'read-node-files'],
    timeoutMs: 120_000,
    async run(ctx) {
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      await seedTrail(ctx, node, 3)
      await ctx.driver.stopNode(node)

      const records = (await readTrail(ctx.driver, node)).map(r => ({ ...r }))
      if (records.length < 2) {
        return new Checks().skip(
          `链里只有 ${records.length} 条，不够做重链实验`,
        )
      }
      // 改一条记录，然后把它之后的每条 prev 重新算一遍 —— 攻击者能做的事。
      const { createHash } = await import('node:crypto')
      const canonical = (r: Record<string, unknown>): string =>
        JSON.stringify([
          r.seq,
          r.at,
          r.source,
          r.kind,
          r.traceId ?? null,
          r.taskId ?? null,
          r.msgId ?? null,
          r.node ?? null,
          r.peer ?? null,
          r.outcome,
          r.code ?? null,
          r.detail ?? null,
          r.prev,
        ])
      const digest = (r: Record<string, unknown>): string =>
        createHash('sha256').update(canonical(r), 'utf8').digest('hex')

      const mutable = records as unknown as Record<string, unknown>[]
      const first = mutable[0]
      if (first === undefined) return new Checks().skip('链是空的')
      first.outcome = first.outcome === 'ok' ? 'refused' : 'ok'
      for (let i = 1; i < mutable.length; i += 1) {
        const prev = mutable[i - 1]
        const cur = mutable[i]
        if (prev === undefined || cur === undefined) continue
        cur.prev = digest(prev)
      }
      await ctx.driver.writeNodeFile(
        node,
        TRAIL_PATH,
        `${mutable.map(r => JSON.stringify(r)).join('\n')}\n`,
      )

      const verify = await auditVerify(ctx.driver, node)
      return new Checks()
        .note('verify 输出', verify.stdout)
        .note(
          '为什么这条是绿的',
          '本地校验只能证明「链自洽」，不能证明「链没被整体重写」。要抓这种得用 --witness 的离机锚点。这条场景钉住的是这个边界本身。',
        )
        .eq(verify.report?.chain, 'intact', 'chain（重链后本地看不出来）')
        .eq(verify.exitCode, 0, '退出码')
        .done('本地校验的检测边界与设计一致')
    },
  },

  {
    id: 'audit/records-refusals-with-code',
    dimension: 'audit',
    title: '每一次拒绝都在链里留一条带 code 的记录',
    expected: "能力层拒绝落 source='capability'、outcome='refused'、code 非空",
    requires: ['spawn-node', 'raw-dial', 'read-node-files'],
    timeoutMs: 120_000,
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
        payload: { trigger: 'manual', prompt: 'audit refusal probe' },
      })
      const records = await readTrail(ctx.driver, node)
      const refusals = records.filter(r => r.outcome === 'refused')
      return new Checks()
        .note(
          '链内容',
          records
            .map(
              r =>
                `#${r.seq} ${r.source}/${r.kind} ${r.outcome} ${r.code ?? ''}`,
            )
            .join('\n'),
        )
        .expect(refusals.length > 0, '链里有 refused 记录', refusals.length)
        .expect(
          refusals.some(r => r.source === 'capability' && r.code !== undefined),
          '能力层的拒绝带 code',
          refusals.map(r => `${r.source}:${r.code ?? '-'}`),
        )
        .expect(
          records.every((r, i) => r.seq === i + 1),
          'seq 从 1 起连续',
          records.map(r => r.seq),
        )
        .done('拒绝可审计')
    },
  },
]
