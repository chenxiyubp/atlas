// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P8.1 —— 「把 `--register` 声明的那几条落到表上」这一步的纯逻辑。
 *
 * 抽出来是为了能测：`p81-registry.ts` 本体一被 import 就会解析 argv、起服务、写
 * ready 文件，测不了。这里不碰 argv、不碰文件、不碰网络，只对一张传进来的表做事。
 *
 * ## 为什么不能「心跳成功就跳过」
 *
 * 原先这一步是 `if (registry.heartbeat(address) !== null) continue` —— 续租成功就
 * 认为这条已经对了。**它漏掉了端点会变这件事。**内测环境里节点的入站从直连改成
 * 走 H 的回环隧道口，`--register` 跟着改了，可表里那条还活着，于是每 20 秒续一次
 * 租、端点原样保留，`--register` 整条被跳过：命令行说的是新端点，名册答的是旧端点，
 * 而且**没有任何一处报错**。现场靠「先把落盘表挪开再重起」绕过去，那是在治症状。
 *
 * ## 为什么要先 deregister
 *
 * `InMemoryRegistry.register()` 对「地址还活着、端点不同」返回 `E_CONFLICT`，这条
 * 检查是为了**防劫持**（别的进程不能把一个活着的地址悄悄指到自己身上），不该为了
 * 我们放宽。而本进程正是这些地址的登记方——`--register` 就是权威声明——所以正确的
 * 表达是「先撤掉自己那条，再按新端点登记」，而不是把冲突检查改松。
 *
 * 撤了之后如果 register 仍然失败，这条地址会短暂地不在表上。这是可以接受的：下一次
 * 续租周期 `heartbeat` 会返回 null，走的就是整条重登记那一支，自己会长回来。
 *
 * ## 公钥：与端点同一个毛病，同一个治法
 *
 * 2026-09-26 的现场：控制台带 `--anchors` 时只从名册取节点公钥，而这里的登记从来不带
 * 公钥——审计页对每个节点都报「名册没有节点的公钥」。手工逐条补上之后，一次租约过期的
 * 重登记又把它抹掉：`register()` 是**整条声明**，缺省即清空。所以公钥要跟着声明走：
 *
 * - 声明了公钥，表上那条没挂（或挂着别的）→ 整条重登记，报 `rekeyed`；
 * - 没声明公钥 → 与加这个字段之前**完全一样**：续租就是心跳，表上已有的公钥（别人
 *   发布的）原样留着。
 *
 * 换钥（表上挂着**另一把**）要先撤再登记，而且要**整批先撤**：`register()` 拒绝同一节点
 * 的两条活着的登记发布两把不同的公钥（节点级公钥，protocol.md §10.1），一个节点的第一条
 * 换上新钥时，第二条还挂着旧钥，逐条来就会撞上。
 */

import { AgentStatus, type InMemoryRegistry } from '@qianmo/registry'

/** 一条登记：地址 → 该节点的入站端点（与该节点的公钥）。 */
export interface Registration {
  readonly address: string
  readonly endpoint: string
  /**
   * 该地址所属**节点**的公钥（base64url Ed25519）。不给 = 不替这条声明公钥，
   * 表上已有的原样留着——与加这个字段之前一致。
   */
  readonly publicKey?: string
}

/** 这一轮对某条地址实际做了什么。调用方据此决定要不要出声。 */
export type AnnounceOutcome =
  /** 表上已有且端点一致，续租即可。 */
  | { readonly kind: 'renewed'; readonly address: string }
  /** 表上没有（首次登记，或租约已过期），整条登记。 */
  | { readonly kind: 'registered'; readonly address: string }
  /** 表上有但端点不是声明的那个：撤掉重登记。**这一条值得打印。** */
  | {
      readonly kind: 'moved'
      readonly address: string
      readonly from: string
      readonly to: string
    }
  /**
   * 端点没变、公钥变了（含「表上那条没挂公钥」）：整条重登记。**这一条也值得打印。**
   * `from` 缺席 = 表上原来没有公钥。
   */
  | {
      readonly kind: 'rekeyed'
      readonly address: string
      readonly from?: string
      readonly to: string
    }

/**
 * 只需要这三个方法。写成 `Pick<>` 而不是另抄一个 interface：抄一份就会有第二处
 * 需要跟着 `@qianmo/registry` 漂移，而这里一个字都不该有自己的语义。
 */
export type AnnounceTarget = Pick<
  InMemoryRegistry,
  'heartbeat' | 'deregister' | 'register'
>

/**
 * 让表上的内容与 `registrations` 声明的一致，返回每条地址这一轮的处置。
 *
 * 登记失败抛错（调用方在启动时让它冒泡、在续租周期里打到 stderr）——静默失败会让
 * 名册停在一个谁都不知道的状态上，那正是这个函数存在的理由。
 */
export function announceRegistrations(
  registry: AnnounceTarget,
  registrations: readonly Registration[],
): AnnounceOutcome[] {
  const live = registrations.map(({ address }) => registry.heartbeat(address))
  // 整批先撤挂着**另一把**公钥的那几条（头注「换钥」）。没挂公钥的不撤：原地重登记
  // 就够了，还能保住它的 registeredAt。
  registrations.forEach(({ address, publicKey }, index) => {
    const held = live[index]?.publicKey
    if (publicKey !== undefined && held !== undefined && held !== publicKey) {
      registry.deregister(address)
    }
  })

  const outcomes: AnnounceOutcome[] = []
  registrations.forEach(({ address, endpoint, publicKey }, index) => {
    const current = live[index] ?? null
    const moved = current !== null && current.endpoint !== endpoint
    const rekeyed =
      current !== null &&
      !moved &&
      publicKey !== undefined &&
      current.publicKey !== publicKey
    if (current !== null && !moved && !rekeyed) {
      outcomes.push({ kind: 'renewed', address })
      return
    }
    if (moved) registry.deregister(address)
    const result = registry.register(address, endpoint, {
      capabilities: ['task.request'],
      status: AgentStatus.Online,
      ...(publicKey === undefined ? {} : { publicKey }),
    })
    if (!result.ok) {
      throw new Error(`注册失败：${address} ${result.code} ${result.message}`)
    }
    if (current === null) {
      outcomes.push({ kind: 'registered', address })
    } else if (moved) {
      outcomes.push({
        kind: 'moved',
        address,
        from: current.endpoint,
        to: endpoint,
      })
    } else if (publicKey !== undefined) {
      outcomes.push({
        kind: 'rekeyed',
        address,
        ...(current.publicKey === undefined ? {} : { from: current.publicKey }),
        to: publicKey,
      })
    }
  })
  return outcomes
}
