// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 场景共用的夹具。
 *
 * **每个场景起自己的节点，不共享。** 三条硬理由：
 *
 * ① 审计链是一个配置根一条，共享节点等于把十几条场景的记录搅进一条链，
 *    「这条握手拒绝是谁造成的」当场不可归因；
 * ② 握手拒绝有**速率闸门**（`HANDSHAKE_AUDIT_CAPACITY`：credentialed 8、
 *    unproven 4，每 60 s），共享节点会让后面的场景观测不到自己那条记录，
 *    而表现是「审计链里没有」——一次假红；
 * ③ nonce 表与 dedup 表都在进程内存里，共享节点会让重放类场景互相污染。
 *
 * 代价是每条场景要付一次约 3~6 秒的节点启动。这个代价买的是**归因**，值。
 */

import { join } from 'node:path'
import { generateNodeKeyPair, type NodeKeyPair } from '@qianmo/capability'
import { ACCEPTANCE_PSK } from '../local/driver.js'
import { newIssuer, trustArg, type Issuer } from '../local/send.js'
import type { NodeHandle, NodeSpec, ScenarioContext } from '../types.js'

export const NODE = 'accnode'
/** 与 `local/driver.ts` 传给 `--team` 的值必须一致（信箱路径按它分目录）。 */
export const TEAM = 'acceptance'
export const AGENT = 'main'
export const ADDRESS = `qianmo://${NODE}/${AGENT}`
export const SENDER_NODE = 'ctl'
export const SENDER = `qianmo://${SENDER_NODE}/op`

/**
 * 对端节点的一套身份材料：签发能力 token 用它，签握手也用它。
 *
 * **两者必须是同一把密钥**，这不是省事。`--trust <node>=<publicKey>` 落进
 * `StaticPublicKeyDirectory`，那是一张 `Map<节点名, 公钥>` —— **一个节点只有
 * 一个公钥**，而且构造函数是 last-write-wins、既不去重也不报冲突。给同一个
 * 节点名传两条 `--trust`（一条签发者、一条握手签名者），后一条会静默盖掉前
 * 一条，随后每一个「本该通过」的 token 都撞在 `capability signature does not
 * verify` 上 —— 而所有**签名之前**的校验（aud/sub/taskId/时钟/规则 S-1）照常
 * 通过，于是红的只有正向那几条，看起来极像产品缺陷。这套件自己踩过一次。
 *
 * `peerNode` 仍单独留着：冻结四元组那几条要拿一个**不同的节点名**再拨一次。
 */
export interface Party {
  readonly issuer: Issuer
  readonly peerNode: string
  readonly peerKeys: NodeKeyPair
}

export function newParty(peerNode = SENDER_NODE): Party {
  const issuer = newIssuer(SENDER_NODE)
  return {
    issuer,
    peerNode,
    peerKeys: peerNode === SENDER_NODE ? issuer.keys : generateNodeKeyPair(),
  }
}

export interface NodeFixtureOptions {
  readonly policy?: 'open' | 'signed-task'
  /** 额外的 agent（名字 → 目录名，目录建在场景 workdir 下）。 */
  readonly agents?: readonly string[]
  readonly trust?: readonly string[]
  readonly signHandshake?: boolean
  readonly requireSignedHandshake?: boolean
  readonly env?: Readonly<Record<string, string>>
  readonly extraArgs?: readonly string[]
  readonly name?: string
  /**
   * 目标机上一个**已经装好东西**的配置根（见 {@link NodeSpec.configRoot}）。
   *
   * 只有证书那两条 `--cert` 场景用它：它们的证书必须在起节点之前就绑好这个
   * 根里的 Ed25519（K-2）。别的场景一律不给 —— 让驱动自己开一个一次性根，
   * 那样审计链才是「这一条场景一条链」。
   */
  readonly configRoot?: string
  /**
   * 只要一台活着的节点 —— 与 `attach-node` 能力配对（见 {@link NodeSpec.attach}）。
   *
   * 声明 `attach-node` 的场景**必须**置上它，否则真机腿会给它起一个一次性节点，
   * 而那条腿正是靠这几条场景去碰部署好的那台内测节点的。
   */
  readonly attach?: boolean
}

export function nodeSpec(
  ctx: ScenarioContext,
  options: NodeFixtureOptions = {},
): NodeSpec {
  const names = options.agents ?? [AGENT]
  const agents: Record<string, string> = {}
  for (const name of names) {
    agents[name] = join(ctx.workdir, `ws-${name}`)
  }
  return {
    name: options.name ?? NODE,
    agents,
    auth:
      options.requireSignedHandshake === true
        ? { mode: 'credential_signature', keyDir: '' }
        : options.signHandshake === true
          ? { mode: 'signature', keyDir: '' }
          : { mode: 'psk', psk: ACCEPTANCE_PSK },
    policy: options.policy ?? 'signed-task',
    ...(options.configRoot === undefined
      ? {}
      : { configRoot: options.configRoot }),
    ...(options.trust === undefined ? {} : { trust: options.trust }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.extraArgs === undefined
      ? {}
      : { extraArgs: options.extraArgs }),
    ...(options.attach === undefined ? {} : { attach: options.attach }),
  }
}

/** 起一个「认识 `party` 这个签发者」的节点。 */
export async function startNodeTrusting(
  ctx: ScenarioContext,
  party: Party,
  options: NodeFixtureOptions = {},
): Promise<NodeHandle> {
  // 同名只许出现一次（见 Party 的注释）：`party.peerNode` 与签发者同名时
  // 只发一条，不同名时才是两条真正不同的登记。
  const trust = [
    trustArg(party.issuer),
    ...(party.peerNode === party.issuer.node
      ? []
      : [`${party.peerNode}=${party.peerKeys.publicKey}`]),
    ...(options.trust ?? []),
  ]
  return await ctx.driver.startNode(ctx, nodeSpec(ctx, { ...options, trust }))
}

/**
 * 让常驻的 ACP 子进程去打一个可控假上游所需要的整套环境变量。
 *
 * 走 OpenAI 兼容那条线而不是 Anthropic 线：`OPENAI_BASE_URL` 是**一个** env 键
 * 就能改道的，而 Anthropic 线还要照顾 OAuth / keychain 那一堆来源，测试里
 * 钉不干净。`OPENAI_MODEL` 必须给 —— 不给会解析成字面量 `claude-*`，假上游
 * 收到的模型名对不上，排查时会以为是链路坏了。
 */
export function upstreamEnv(baseUrl: string): Record<string, string> {
  return {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_API_KEY: 'sk-qianmo-acceptance-stub',
    OPENAI_BASE_URL: baseUrl,
    OPENAI_MODEL: 'qianmo-acceptance-stub',
  }
}

/** 新任务 id —— 能力 token 与信封必须共用同一个。 */
export function newTaskId(): string {
  return crypto.randomUUID()
}
