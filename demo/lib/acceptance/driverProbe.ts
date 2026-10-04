// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 驱动调用计数器 —— 「这条腿到底有没有碰过目标」的常设护栏。
 *
 * ## 它存在的理由是一次真实的假绿（issue #61）
 *
 * 真机腿曾经报 `pass=11 fail=0 skip=104` + exit 0 + 「判定: PASS」，而
 * {@link FleetDriver} 从头到尾**被调用了 0 次** —— 那 11 条绿全部跑在 runner
 * （开发机）上：场景声明了 `exec-node-cli`，通过了能力差集检查，然后调本地的
 * `runCli()` 起了一个本机进程。`requires` 是装饰性的，没有任何东西检查它。
 *
 * **一条报 PASS 却什么都没做的验收腿，比没有这条腿更危险**，因为它对外的全部
 * 信号就是那个 exit 0。所以这里把当时那个「用计数 Proxy 包住驱动重跑一遍」的
 * 一次性排查手法**做成套件的常设部件**：每个场景跑完都记下它调用过哪些驱动
 * 方法，写进 NDJSON；一轮里一条都没有，{@link summarize} 就判这轮不通过。
 *
 * ## 为什么是 Proxy 而不是手写一层包装类
 *
 * 手写包装类每加一个驱动方法就要跟着加一行，而**漏掉的那一行恰好是不被计数的
 * 那个方法** —— 计数器自己长出一个盲区，比没有计数器更糟。Proxy 对
 * {@link AcceptanceDriver} 将来长出的任何方法都自动生效。
 *
 * `Reflect.get(target, prop, target)` 里第三个参数**必须是 target 而不是
 * receiver**：两个驱动都用 `#private` 字段存配置，receiver 传成代理会让私有
 * 字段查找落在代理上并当场抛 `TypeError`。
 */

import type { AcceptanceDriver } from './types.js'

export interface DriverProbe {
  /** 交给场景用的驱动。行为与原驱动一致，只是每次方法调用都记一笔。 */
  readonly driver: AcceptanceDriver
  /** 至此调用过的驱动方法名，按调用顺序，含重复。 */
  calls(): readonly string[]
}

/** 包一层计数。**不改变任何行为**，包括抛出的异常与返回值。 */
export function instrumentDriver(driver: AcceptanceDriver): DriverProbe {
  const calls: string[] = []
  const proxy = new Proxy(driver, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      const name = String(prop)
      const fn = value as (...args: unknown[]) => unknown
      return (...args: unknown[]): unknown => {
        calls.push(name)
        return fn.apply(target, args)
      }
    },
  })
  return {
    driver: proxy as unknown as AcceptanceDriver,
    calls: () => [...calls],
  }
}
