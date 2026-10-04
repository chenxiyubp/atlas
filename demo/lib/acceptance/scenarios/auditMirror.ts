// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 审计镜像 —— `qm console --audit-mirror` 那一面。
 *
 * **这一维只覆盖得了一半，另一半在报告里以 skip 出现，那是故意的。**
 *
 * 「审计镜像」是两件事拼起来的：
 *
 *   ① **搬运**：把源节点的 `trail.ndjson` 定期拉到控制台所在的机器上。
 *      那是 systemd timer + 隧道 + rsync 的活，本地腿一台机器、没有隧道、
 *      也没有单元文件，**造不出来**。`audit/mirror-pull-not-constructible`
 *      如实记 skip，不拿一次 `cp` 冒充它 —— 冒充出来的绿色恰好会掩盖那条
 *      链路上唯一会坏的东西（拉取停了而没人知道）。
 *
 *   ② **申报**：控制台把一个审计源标成「这是镜像，最大滞后 N 分钟」，并在
 *      读取面上把它与权威源分开。这一半完全在进程内，本地腿测得动，
 *      而且它正是 ① 坏掉时唯一的可见面 —— 所以更该测。
 *
 * 两条容易读反的事实：
 *
 *   · **镜像与权威的区别只由 `--audit-mirror` 决定，与路径无关**（帮助文本里
 *     写着 "paths never imply"）。角色是部署事实，不是文件属性。
 *   · 但**同一次启动里同一个路径只许出现一次**：两条 `--audit` 指向同一个文件
 *     会在解析期报 `--audit repeats path <路径>`。所以「同一个文件同时是镜像
 *     又是权威」这种写法造不出来 —— 本套件先按那个形状写过一版，控制台当场
 *     拒绝启动。两条规则合起来才是完整的：角色可以任配，文件不能重复申报。
 *
 * 「源端无链」在读取面上是可分辨的：缺席的镜像给 `chain:'absent'`，存在但没有
 * 记录的源给 `chain:'empty'` —— 与 `qm audit --verify` 的四态同一套词汇，
 * 不是控制台另造的一份。
 */

import { Checks, stripMinifiedSourceFrame } from '../checks.js'
import { http } from '../local/console.js'
import { TRAIL_PATH } from '../observe.js'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { sendEnvelope } from '../local/send.js'
import type { Scenario } from '../types.js'
import {
  ADDRESS,
  SENDER,
  SENDER_NODE,
  newParty,
  startNodeTrusting,
} from './fixtures.js'

interface AuditSourceRow {
  readonly node?: string
  readonly kind?: string
  readonly maxLagMinutes?: number
  readonly page?: Record<string, unknown> | null
  readonly failure?: Record<string, unknown> | null
}

function sourcesOf(
  json: Record<string, unknown> | undefined,
): AuditSourceRow[] {
  const audits = json?.audits
  return Array.isArray(audits) ? (audits as AuditSourceRow[]) : []
}

export const auditMirrorScenarios: readonly Scenario[] = [
  {
    id: 'audit/mirror-and-authoritative-are-distinguishable',
    dimension: 'audit',
    title: '同一次读取里，镜像源与权威源可分辨且带出滞后上限',
    expected:
      "GET /v0/audit 的每个源各带 kind；被 --audit-mirror 点名的那个是 'mirror' 且带 maxLagMinutes，另一个是 'authoritative' 且不带",
    requires: ['spawn-console', 'spawn-node', 'raw-dial', 'read-node-files'],
    timeoutMs: 180_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const slot = await ctx.driver.consoleSlot(ctx)
      // 一条**真**审计链：起一个节点、发一条会被拒的消息，让它写几行出来。
      const node = await startNodeTrusting(ctx, newParty(), {
        policy: 'signed-task',
      })
      await sendEnvelope({
        url: node.endpoint,
        psk: ACCEPTANCE_PSK,
        fromNode: SENDER_NODE,
        from: SENDER,
        to: ADDRESS,
        payload: { trigger: 'manual', prompt: 'mirror seed' },
        settleMs: 800,
      })
      // 两条路径都必须落在**控制台那台机器**上：`--audit <节点>=<路径>` 是
      // 控制台自己去读的。节点与控制台同机由驱动保证（真机腿把一个场景里的
      // 一次性进程钉在同一台机器上），所以节点配置根这条路径它读得到。
      const trail = `${node.configRoot}/${TRAIL_PATH}`
      // 镜像源就是源端那条链在本机的一份副本 —— 这正是镜像**是什么**。
      // 注意这里没有在测「副本是怎么来的」（那是搬运，见本文件末尾那条 skip），
      // 测的是控制台拿到一份副本之后怎么申报它。
      const mirrored = await slot.writeFile(
        'mirrored-trail.ndjson',
        (await ctx.driver.readNodeFile(node, TRAIL_PATH)) ?? '',
      )

      const console_ = await slot.start({
        registryUrl: registry.hostUrl,
        extraArgs: [
          '--audit',
          `remote=${mirrored}`,
          '--audit',
          `local=${trail}`,
          '--audit-mirror',
          'remote=45',
        ],
      })
      const probe = await http(`${console_.url}/v0/audit`, {
        token: console_.viewToken,
      })
      const sources = sourcesOf(probe.json)
      const mirror = sources.find(source => source.node === 'remote')
      const authoritative = sources.find(source => source.node === 'local')

      return (
        new Checks()
          .note('审计链路径', trail)
          .note('/v0/audit', probe.body.slice(0, 2_000))
          .eq(probe.status, 200, '状态码')
          .eq(sources.length, 2, '申报的审计源个数')
          .eq(mirror?.kind, 'mirror', 'remote 源的 kind')
          .eq(mirror?.maxLagMinutes, 45, 'remote 源的 maxLagMinutes')
          .eq(authoritative?.kind, 'authoritative', 'local 源的 kind')
          .eq(
            authoritative?.maxLagMinutes,
            undefined,
            'local 源的 maxLagMinutes（权威源没有滞后一说）',
          )
          // 两个源都真的被读到了 —— 一个源坏掉时另一个照样出现，是这一面
          // 存在的理由。
          .expect(
            mirror?.page !== undefined && authoritative?.page !== undefined,
            '两个源都各自给出了读取结果',
            sources.map(source => `${source.node}/${source.kind}`).join(', '),
          )
          .expect(
            ((mirror?.page as { total?: number } | undefined)?.total ?? 0) > 0,
            '镜像源里真的有记录（证明读到的是那条链，不是一个空壳）',
            JSON.stringify(mirror?.page ?? null).slice(0, 300),
          )
          .done('镜像与权威在读取面上可分辨')
      )
    },
  },

  {
    id: 'audit/mirror-of-absent-trail',
    dimension: 'audit',
    title: '源端还没有链时，镜像源读出来是什么（而不是把控制台带崩）',
    expected:
      '镜像指向一个不存在的文件时，/v0/audit 仍是 200，该源自己带出空结果或 failure，另一个源不受影响',
    requires: ['spawn-console'],
    timeoutMs: 180_000,
    async run(ctx) {
      const registry = await ctx.driver.startRegistry(ctx)
      const slot = await ctx.driver.consoleSlot(ctx)
      // 两条路径都在**控制台那台机器**上：一个存在但空，一个从来没有过。
      const present = await slot.writeFile('present-trail.ndjson', '')
      const missing = `${slot.workdir}/never-synced/trail.ndjson`

      const console_ = await slot.start({
        registryUrl: registry.hostUrl,
        extraArgs: [
          '--audit',
          `remote=${missing}`,
          '--audit',
          `local=${present}`,
          '--audit-mirror',
          'remote=15',
        ],
      })
      const all = await http(`${console_.url}/v0/audit`, {
        token: console_.viewToken,
      })
      const one = await http(`${console_.url}/v0/audit?node=remote`, {
        token: console_.viewToken,
      })
      const sources = sourcesOf(all.json)
      const mirror = sources.find(source => source.node === 'remote')
      const local = sources.find(source => source.node === 'local')

      return (
        new Checks()
          .note('缺席的镜像路径', missing)
          .note('/v0/audit', all.body.slice(0, 2_000))
          .note(
            '/v0/audit?node=remote',
            `${one.status} ${one.body.slice(0, 800)}`,
          )
          // 控制台起得来是这条的第一半：一个还没同步过的镜像不该让它拒绝启动。
          .eq(all.status, 200, '合并读取的状态码')
          .eq(sources.length, 2, '申报的审计源个数')
          .eq(mirror?.kind, 'mirror', 'remote 源仍然申报为 mirror')
          // 「链不存在」与「链为空」在控制台这一面照样可分辨，用的是
          // `qm audit --verify` 的同一套词汇（issue #9② 的判据）。
          .eq(
            (mirror?.page as { chain?: string } | undefined)?.chain,
            'absent',
            '缺席镜像源的 chain',
          )
          .eq(
            (local?.page as { chain?: string } | undefined)?.chain,
            'empty',
            '存在但零记录的权威源的 chain',
          )
          .expect(
            mirror?.page !== undefined || mirror?.failure !== undefined,
            '缺席的镜像源自己给出了一个结果，而不是让整次读取失败',
            `page=${JSON.stringify(mirror?.page ?? null).slice(0, 200)} failure=${JSON.stringify(mirror?.failure ?? null).slice(0, 200)}`,
          )
          // 另一个源不受牵连 —— 一台机器上的一条链断了不该让整面看不见。
          .expect(
            local?.failure === undefined || local?.failure === null,
            '权威源不受缺席镜像的牵连',
            JSON.stringify(local ?? null).slice(0, 300),
          )
          .eq(one.status, 200, '单独读镜像源的状态码')
          .done('缺席的镜像被隔离在它自己那一行里')
      )
    },
  },

  {
    id: 'audit/mirror-must-name-a-configured-source',
    dimension: 'audit',
    title:
      '审计源申报的两条解析期规则：镜像必须点名已配的源、同一路径不许申报两次',
    expected:
      "非零退出 + '--audit-mirror names unknown audit node <名字>'；两条 --audit 指同一路径 → '--audit repeats path <路径>'",
    requires: ['exec-node-cli'],
    timeoutMs: 240_000,
    async run(ctx) {
      // 两条都是**解析期**规则，所以这里不会有控制台真的起来、也不会 bind
      // 那个口；经驱动跑是为了让真机腿问的是那台机器上部署的那个二进制。
      const host = await ctx.driver.execHost(ctx)
      const trail = await host.writeFile('trail.ndjson', '')
      const result = await host.exec(
        [
          'console',
          '--port',
          String(await host.freePort()),
          '--hostname',
          '127.0.0.1',
          '--audit',
          `local=${trail}`,
          '--audit-mirror',
          'remote=30',
        ],
        { timeoutMs: 100_000 },
      )
      const output = stripMinifiedSourceFrame(
        `${result.stdout}\n${result.stderr}`,
      )
      // 第二条规则：同一个路径不许被申报两次。这条挡掉的是「让同一个文件既
      // 当镜像又当权威」的写法 —— 本套件先按那个形状写过一版并撞在这里。
      const duplicate = await host.exec(
        [
          'console',
          '--port',
          String(await host.freePort()),
          '--hostname',
          '127.0.0.1',
          '--audit',
          `local=${trail}`,
          '--audit',
          `remote=${trail}`,
        ],
        {
          env: { OCC_CONFIG_DIR: await host.mkdir('console-config-2') },
          timeoutMs: 100_000,
        },
      )
      const duplicateOutput = stripMinifiedSourceFrame(
        `${duplicate.stdout}\n${duplicate.stderr}`,
      )
      return new Checks()
        .note('执行位置', host.describe)
        .note('输出', output.slice(0, 1_500))
        .note('重复路径的输出', duplicateOutput.slice(0, 1_500))
        .expect(result.code !== 0, '点名未知源时退出码非零', result.code)
        .contains(
          output,
          '--audit-mirror names unknown audit node remote',
          '错误输出',
        )
        .expect(duplicate.code !== 0, '重复路径时退出码非零', duplicate.code)
        .contains(
          duplicateOutput,
          `--audit repeats path ${trail}`,
          '重复路径的错误输出',
        )
        .done('两条申报规则都在解析期生效')
    },
  },

  {
    id: 'audit/mirror-pull-not-constructible',
    dimension: 'audit',
    title: '镜像的「搬运」那一半：真机腿真断言，本地腿如实记 skip',
    expected:
      '定时器新鲜、拉取服务退出 0、镜像 mtime 在申报的滞后上限内，且**镜像内容是权威副本的前缀**',
    // 从 `exec-node-cli` 改成 `mirror-transport`（issue #62）：这条场景此前
    // `run()` 连 `ctx` 都不收、无条件 skip 并给出一段**只对本地腿成立**的理由。
    // 于是在真机腿上 —— 三个前提明明都满足、链路当时也是健康的 —— 它照样跳过。
    // 本地腿的那个 skip 是对的，错的是「不管哪条腿都 skip」。
    requires: ['mirror-transport'],
    timeoutMs: 180_000,
    async run(ctx) {
      const checks = new Checks()
        .note(
          '为什么不用一次 cp 代替',
          '拉取链路上唯一会坏的东西是「它停了而没人知道」。一次 cp 一定成功，于是那样的场景会永远绿，而绿的那一刻恰好证明不了任何事。宁可空着，也不要一条测不到目标的绿 —— 所以本地腿仍然 skip，真机腿才断言。',
        )
        .note(
          '本地腿已经覆盖的那一半',
          'audit/mirror-and-authoritative-are-distinguishable 与 audit/mirror-of-absent-trail —— 申报与读取这一半是进程内的，测得动，而且它正是搬运停掉时唯一的可见面。',
        )
      const report = await ctx.driver.inspectMirrorTransport?.()
      if (report === undefined) {
        return checks.skip(
          '驱动没有 mirror-transport 能力（能力差集本该先拦下）',
        )
      }
      checks.note('控制台主机', report.consoleHost)
      if (report.failure !== undefined) {
        return checks
          .expect(false, '能读到搬运现场', report.failure)
          .done('读不到搬运现场')
      }
      checks.note(
        '控制台健康',
        `port=${report.consolePort ?? '(探不到)'} GET /v0/health = ${report.consoleHealthStatus ?? '(没问到)'}`,
      )
      const declared = report.units.filter(u => u.mirrorPath !== undefined)
      if (declared.length === 0) {
        // 「一个都没申报」曾经分不出「这套部署没配镜像」与「控制台此刻没在跑」，
        // 于是一台挂掉的控制台会让这条退化成 skip —— 报告上看起来像「没配」。
        // `/v0/health` 把两者分开了：它公开、零鉴权，200 就是活着。
        if (report.consoleHealthStatus === 200) {
          return checks
            .note('采到的现场', JSON.stringify(report.units).slice(0, 1_500))
            .skip(
              `${report.consoleHost} 上的控制台活着（/v0/health 200）但命令行里一条 --audit 申报都没有：这套部署没配审计镜像，没有搬运可验。`,
            )
        }
        return checks
          .note('采到的现场', JSON.stringify(report.units).slice(0, 1_500))
          .expect(
            false,
            `${report.consoleHost} 上的控制台在跑（否则镜像链路根本无从谈起）`,
            `/v0/health = ${report.consoleHealthStatus ?? '(端口都没探到)'}；一条 --audit 申报都没有`,
          )
          .done('控制台没在跑')
      }

      for (const unit of report.units) {
        const lag = unit.maxLagMinutes ?? 5
        // 宽限 120 s 不是"松一点"：定时器是 OnUnitActiveSec=<lag> +
        // AccuracySec=30s，所以「距上次触发」的正常上界本来就是 lag+30s；
        // 再加上这一轮采集自己花掉的时间。不给宽限的版本会周期性假红。
        const bound = lag * 60 + 120
        const since =
          unit.observedAtSec === undefined || unit.lastTriggerSec === undefined
            ? undefined
            : unit.observedAtSec - unit.lastTriggerSec
        const stale =
          unit.observedAtSec === undefined || unit.mirrorMtimeSec === undefined
            ? undefined
            : unit.observedAtSec - unit.mirrorMtimeSec
        checks
          .note(`${unit.node} · 现场`, unit.raw.slice(0, 800))
          // 下界 -60 不是凑数：钟与 systemctl 在同一趟里取，正常只可能差几秒。
          // 更负的值意味着控制台机器的钟往回跳过 —— 那本身就该红，而不是
          // 「距今是负的所以 ≤ 上限、通过」。少了下界，这条断言在最需要它的
          // 方向（时间戳看起来来自未来）上是瞎的。
          .expect(
            since !== undefined && since <= bound && since >= -60,
            `${unit.node}: 定时器上次触发距今落在 [-60s, ${bound}s]`,
            `${since ?? '(取不到)'}s · ${unit.lastTriggerAt ?? '-'}`,
          )
          .eq(unit.serviceExitCode, 0, `${unit.node}: 拉取服务退出码`)
          .eq(unit.serviceResult, 'success', `${unit.node}: 拉取服务 Result`)
          .expect(
            stale !== undefined && stale <= bound && stale >= -60,
            `${unit.node}: 镜像 mtime 距今落在 [-60s, ${bound}s]（申报的滞后上限 ${lag} min）`,
            `${stale ?? '(取不到)'}s`,
          )
          .expect(
            unit.authoritativeBytes !== undefined &&
              unit.mirrorBytes !== undefined &&
              unit.authoritativeBytes >= unit.mirrorBytes,
            `${unit.node}: 权威副本不短于镜像（链只追加）`,
            `authoritative=${unit.authoritativeBytes ?? '-'} mirror=${unit.mirrorBytes ?? '-'}`,
          )
          // ── 承重的一条 ──────────────────────────────────────────────
          // 前面几条只证明「它跑过」，这一条才证明「它搬对了」。
          //
          // 比的是**前缀**而不是整份哈希：审计链只追加，两次采样之间源端完全
          // 可能又写了几条，那时整份哈希本来就该不同、而搬运仍然是对的。写成
          // 整份相等会得到一条按节点活跃度随机变红的场景 —— 那种红没人会查，
          // 两轮之后就会被改成「已知偶发」。
          .expect(
            unit.mirrorHash !== undefined &&
              unit.authoritativePrefixHash === unit.mirrorHash,
            `${unit.node}: 镜像内容 == 权威副本的前 ${unit.mirrorBytes ?? '?'} 字节`,
            `mirror=${unit.mirrorHash ?? '-'} authoritative-prefix=${unit.authoritativePrefixHash ?? '-'}`,
          )
          .note(
            `${unit.node} · 整份哈希是否也相等（留痕，不是断言）`,
            unit.authoritativeHash === unit.mirrorHash
              ? '相等 —— 采样期间源端没有再写'
              : `不等：authoritative=${unit.authoritativeHash ?? '-'} —— 源端在两次采样之间又写了，前缀相等即为正常`,
          )
      }
      return checks.done(
        `${report.units.length} 条链的搬运都在申报的滞后上限内，且内容与权威副本前缀一致`,
      )
    },
  },
]
