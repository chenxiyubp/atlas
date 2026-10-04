// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 真机腿两条纪律的 CI 护栏（issue #65）。
 *
 * 这两条都是「改坏了要到下一次真跑才发现」的那种，而真跑一轮要一小时、还得
 * 有人手动起隧道 —— 所以它们必须落在分片里：
 *
 * ① **附着来的内测节点不许被停 / 重启 / 硬杀 / 往配置根里写。** 这是整条腿
 *    「不碰生产」的全部保证，实现上收敛在 `requireDisposable` 一处。有人把
 *    那一处删掉，或者给附着句柄补上一个 `disposable` 字段，一次真跑就会打断
 *    内测使用者并在那条节点的审计链上留下计划外记录。
 * ② **能力随配置消失。** 没有可承载一次性进程的机器时，`spawn-node` 那几项
 *    必须**不在** `capabilities` 里 —— 否则场景会通过能力差集检查然后在别处
 *    炸掉，那正是 issue #61 的形状。
 *
 * 全程零网络：`startNode({attach:true})` 只拼一个句柄，`requireDisposable`
 * 在任何 ssh 之前就抛。
 */

import { describe, expect, it } from 'bun:test'
import { FleetDriver, fleetConfigFromEnv } from '../fleet/driver.js'
import { getDialTimeoutScale, setDialTimeoutScale } from '../local/dial.js'
import { runScenario } from '../runner.js'
import type {
  AcceptanceDriver,
  NodeHandle,
  NodeSpec,
  Scenario,
  ScenarioContext,
} from '../types.js'

const SPEC: NodeSpec = {
  name: 'beta-1',
  agents: { main: '/tmp/never-used' },
  auth: { mode: 'psk', psk: 'qianmo-acceptance-psk-0000000000' },
  policy: 'open',
  attach: true,
}

function driverWith(spawnable: boolean): FleetDriver {
  return new FleetDriver({
    hosts: [
      {
        ssh: 'never-dialed',
        node: 'beta-1',
        tunnelPort: 38_631,
        endpoint: 'ws://127.0.0.1:38631',
        configRoot: '/home/nobody/qianmo-beta/nodes/beta-1/config',
        occPath: '/home/nobody/atlas-beta/dist/cli-node.js',
      },
    ],
    spawnMachines: spawnable
      ? [{ ssh: 'never-dialed', label: 'fake', repoRel: 'atlas-beta' }]
      : [],
    psk: {},
  })
}

/** `startNode` 的附着分支是同步拼装的，不发任何 ssh。 */
async function attachedHandle(driver: FleetDriver): Promise<NodeHandle> {
  return await driver.startNode(undefined as unknown as ScenarioContext, SPEC)
}

describe('FleetDriver 对附着来的内测节点', () => {
  it('停 / 重启 / 硬杀都拒绝，且说清拒绝的是哪一件事', async () => {
    const driver = driverWith(true)
    const node = await attachedHandle(driver)

    await expect(driver.stopNode(node)).rejects.toThrow('不停')
    await expect(
      driver.restartNode(
        undefined as unknown as ScenarioContext,
        node,
        undefined,
      ),
    ).rejects.toThrow('不重启')
    await expect(driver.killNode(node)).rejects.toThrow('不硬杀')
  })

  it('往生产配置根里写 / 改权限位都拒绝', async () => {
    const driver = driverWith(true)
    const node = await attachedHandle(driver)
    await expect(
      driver.writeNodeFile(node, 'qianmo/audit/trail.ndjson', 'x'),
    ).rejects.toThrow('不写配置根')
    await expect(driver.setNodePathMode(node, 'teams', '500')).rejects.toThrow(
      '不改权限位',
    )
  })

  it('附着句柄的 hostEndpoint 是节点自己那台机器上的地址，不是隧道口', async () => {
    const node = await attachedHandle(driverWith(true))
    expect(node.endpoint).toBe('ws://127.0.0.1:38631')
    expect(node.hostEndpoint).toBe('ws://127.0.0.1:38625')
  })
})

/**
 * 落机在不在，决定这五项在不在。`local-ca-fixture` 也在里面：签发链跑在
 * `execHost({ forNodeSpawn: true })` 上，而那个执行位要的正是一台落机。
 */
const SPAWN_BOUND_CAPABILITIES = [
  'spawn-node',
  'spawn-console',
  'restart-node',
  'run-launcher',
  'local-ca-fixture',
] as const

describe('FleetDriver 的能力随配置消失', () => {
  it('没有可承载一次性进程的机器时，五项一次性能力都不声明', () => {
    const caps = driverWith(false).capabilities
    for (const cap of SPAWN_BOUND_CAPABILITIES) {
      expect(caps.has(cap)).toBe(false)
    }
    // 附着与拨号不受影响 —— 那正是「数据面至少还有一条」的底线。
    expect(caps.has('attach-node')).toBe(true)
    expect(caps.has('raw-dial')).toBe(true)
  })

  it('有机器时五项都声明', () => {
    const caps = driverWith(true).capabilities
    for (const cap of SPAWN_BOUND_CAPABILITIES) {
      expect(caps.has(cap)).toBe(true)
    }
    // `mutate-node-env` 刻意仍然不声明：本轮没有场景验证过它。
    expect(caps.has('mutate-node-env')).toBe(false)
  })

  it('每一项缺席的能力都带着一句为什么 —— 只印「缺少能力: X」读的人分不出「做不到」和「忘了写」', () => {
    const driver = driverWith(false)
    for (const cap of SPAWN_BOUND_CAPABILITIES) {
      expect(driver.capabilityGaps.get(cap)).toBeString()
    }
  })
})

describe('一次性节点的配置根', () => {
  it('`NodeSpec.configRoot` 只对自己起的节点有意义，附着分支照旧给生产根', async () => {
    const node = await driverWith(true).startNode(
      undefined as unknown as ScenarioContext,
      { ...SPEC, configRoot: '/tmp/never-used-config' },
    )
    // 附着分支不起进程，configRoot 换掉它没有任何意义 —— 那会让审计链、身份、
    // 会话表全部指向一个空目录，而现场看起来像内测节点被清空了。
    expect(node.configRoot).toBe('/home/nobody/qianmo-beta/nodes/beta-1/config')
  })
})

describe('超时倍率', () => {
  const hang: Scenario = {
    id: 'handshake/never-returns',
    dimension: 'handshake',
    title: '永不返回，用来观察超时预算',
    expected: '不会走到这里',
    requires: ['raw-dial'],
    timeoutMs: 50,
    run: async () => await new Promise(() => {}),
  }
  // 只要一个「什么都不缺」的驱动：这条场景在超时之前不碰它。
  const anyDriver = {
    target: 'local',
    capabilities: new Set(['raw-dial']),
  } as unknown as AcceptanceDriver

  it('场景自报的毫秒数也乘倍率，且超时记 error 不记 fail', async () => {
    const scaled = await runScenario(hang, anyDriver, 1_000, false, 4)
    expect(scaled.outcome).toBe('error')
    // 200 = 50 × 4。写死这个数是刻意的：倍率被谁「优化」成只作用于默认值时，
    // 这一行会红 —— 而真跑里那种退化的表现只是「又有几条 error」。
    expect(scaled.actual).toContain('200ms')
  })

  it('倍率缺省是 1', async () => {
    const plain = await runScenario(hang, anyDriver, 1_000, false)
    expect(plain.outcome).toBe('error')
    expect(plain.actual).toContain('50ms')
  })

  /**
   * 驱动内部那几个墙钟等待（`DISPOSABLE_READY_BUDGET_MS`、
   * `REVERSE_TUNNEL_READY_BUDGET_MS`）乘的就是 `ctx.timeoutScale`，而它们只在
   * 起一次性进程时走到 —— 那要四台 VPS 加隧道，进不了分片。能钉在这里的是
   * 它们依赖的那条通路：**runner 把同一个倍率交给了 ctx**。
   *
   * 这条通路断掉的表现，正是这次要修的那个形状：场景预算放大了、驱动内部没
   * 放大，于是驱动先炸，一条只是慢了一步的场景记成 `error`（issue #85 ②）。
   */
  it('runner 把同一个倍率交到 ctx 上 —— 驱动内部的硬等待靠它', async () => {
    const seen: number[] = []
    const peek: Scenario = {
      id: 'handshake/peek-scale',
      dimension: 'handshake',
      title: '读一下 ctx.timeoutScale',
      expected: '拿到 runner 那个倍率',
      requires: ['raw-dial'],
      run: async ctx => {
        seen.push(ctx.timeoutScale)
        return { ok: true, actual: '读到了', evidence: [] }
      },
    }

    await runScenario(peek, anyDriver, 1_000, false, 4)
    await runScenario(peek, anyDriver, 1_000, false)
    // 4 = 显式给的（真机腿默认，或 --timeout-scale 压过它之后的值）；
    // 1 = 缺省。两个都写死：倍率被谁改成只作用于场景预算时这里会红。
    expect(seen).toEqual([4, 1])
  })
})

/**
 * 拨号那一层的墙钟也吃 `--timeout-scale`（issue #91 的同一类，第 8 轮那条）。
 *
 * ## 这条钉的是什么
 *
 * `settleMs`（握手后再收多久帧）与 `timeoutMs` 是墙钟等待，跟场景预算管的是
 * 同一件事：慢机器上每一格都要一起放大。改造前它们是**固定常数** —— 真机腿
 * 场景预算乘 4，收帧窗口还是 3 s，于是最大的那条信封（264 KB）在 aarch64 上
 * 回执还没到窗口就关了，报出来是三条关于 receipt 的断言不成立，读起来像产品坏了。
 *
 * ## 为什么钉在 `rawDial` 而不是调用点
 *
 * 24 个 `rawDial` 调用点、37 处 `settleMs` 字面量。issue #99 已经买过这条教训：
 * 三十多个调用点靠人挑一遍必漏一个。乘法只发生在 `rawDial` 里，调用点一个都不
 * 用改，也就一个都漏不掉 —— 这条用例连着钉「乘了」和「只乘一次」。
 */
describe('拨号层的墙钟也吃倍率（issue #91 的同一类）', () => {
  it('runScenario 一进来就把倍率交给拨号层 —— 所有路径的唯一入口', async () => {
    setDialTimeoutScale(1)
    const seen: number[] = []
    const scenario: Scenario = {
      id: 'launcher/records-dial-scale',
      dimension: 'launcher',
      title: '记一下拨号层此刻的倍率',
      expected: '等于本轮的 --timeout-scale',
      requires: [],
      run() {
        seen.push(getDialTimeoutScale())
        return Promise.resolve({ ok: true, actual: 'ok', evidence: [] })
      },
    }
    await runScenario(scenario, driverWith(false), 5_000, false, 4)
    await runScenario(scenario, driverWith(false), 5_000, false, 0.5)
    expect(seen).toEqual([4, 0.5])
  })

  it('倍率没给就是 1 —— 本地腿逐字节不变', async () => {
    setDialTimeoutScale(9)
    const scenario: Scenario = {
      id: 'launcher/records-dial-scale-default',
      dimension: 'launcher',
      title: '不给倍率时拨号层是多少',
      expected: '1',
      requires: [],
      run() {
        expect(getDialTimeoutScale()).toBe(1)
        return Promise.resolve({ ok: true, actual: 'ok', evidence: [] })
      },
    }
    const r = await runScenario(scenario, driverWith(false), 5_000, false)
    expect(r.outcome).toBe('pass')
  })

  it('非正数不许把等待抹成 0 —— 那会让每一次拨号立刻超时', () => {
    setDialTimeoutScale(0)
    expect(getDialTimeoutScale()).toBe(1)
    setDialTimeoutScale(-3)
    expect(getDialTimeoutScale()).toBe(1)
    setDialTimeoutScale(1)
  })
})

describe('fleetConfigFromEnv 的 SSH 目标覆盖', () => {
  // 节点搬家（或别名被重指）之后，写死的那一栏不会报错——它会安静地去问另一
  // 台机器，报告上表现为一条读不通的节点，而现场看起来像那个节点坏了。这条
  // 覆盖是运维不改代码就能纠正它的唯一入口，所以它得有护栏。
  function withEnv<T>(
    patch: Record<string, string | undefined>,
    fn: () => T,
  ): T {
    const before = new Map<string, string | undefined>()
    for (const [k, v] of Object.entries(patch)) {
      before.set(k, process.env[k])
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    try {
      return fn()
    } finally {
      for (const [k, v] of before) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  }

  it('给了就用给的，其余节点不受影响', () => {
    const config = withEnv(
      { QIANMO_ACCEPTANCE_SSH_BETA_4: 'somewhere-else' },
      () => fleetConfigFromEnv(),
    )
    const four = config.hosts.find(h => h.node === 'beta-4')
    expect(four?.ssh).toBe('somewhere-else')
    expect(config.hosts.find(h => h.node === 'beta-1')?.ssh).toBe('cornna-p2')
  })

  it('不给就是默认拓扑', () => {
    const config = withEnv({ QIANMO_ACCEPTANCE_SSH_BETA_4: undefined }, () =>
      fleetConfigFromEnv(),
    )
    expect(config.hosts.find(h => h.node === 'beta-4')?.ssh).toBe('cornna-p11')
  })

  it('覆盖 SSH 目标不动配置根与产物路径 —— 部署形状跟着机器走', () => {
    const config = withEnv(
      { QIANMO_ACCEPTANCE_SSH_BETA_4: 'somewhere-else' },
      () => fleetConfigFromEnv(),
    )
    const four = config.hosts.find(h => h.node === 'beta-4')
    expect(four?.configRoot).toBe('/root/qianmo-beta/nodes/beta-4/config')
    expect(four?.occPath).toBe('/root/atlas-beta/dist/cli-node.js')
  })
})
