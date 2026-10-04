// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 阡陌 P11.4 —— 审计见证端点长驻启动器的可测部分（入口在 `witness-endpoint.ts`）。
 *
 * `@qianmo/witness` 只导出库函数 `startWitnessService()`，此前没有任何长驻入口——与
 * 备份服务同一种缺口（beta-up.sh「④ 备份服务」）。这里补的就是那个入口，**不加任何
 * 能力**：端点本体、只追加的存储、两枚 token 的分工全部是包里现成的，这个文件只做
 * 「从命令行与文件里把它们拼起来」。
 *
 * 三条规矩，都来自 audit-witness.md 与 beta-env.md §8.3，不是这里新定的：
 *
 *  1. **两枚 token 只从文件读**，文件必须 0600。命令行上的密钥就是这台机器每一份
 *     进程列表里的密钥。写 token 发给节点，读 token 永不离开见证机。
 *  2. **只听回环。**内测形态下节点经 H → 节点那条 SSH 会话的 `-R` 反向转发够到这里
 *     （那条会话由 H 发起，节点上不放任何指向 H 的凭据，§8.3 的单向信任因此不破）。
 *     要让它听一个公网地址，先改设计，不是改参数。
 *  3. **节点公钥由命令行一次给全**，来源是各节点首行横幅里的 `publicKey`，与入站的
 *     锚点无关——不做首次信任（`StaticPublicKeyDirectory` 的构造函数也拒绝同名两把钥匙）。
 */

import { statSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { StaticPublicKeyDirectory } from '@qianmo/capability'
import {
  FileWitnessAnchorStore,
  startWitnessService,
  type WitnessServiceHandle,
} from '@qianmo/witness'

/** 端口约定：beta-env.md §2.6 之外的第一个空位，隧道模板里 `-R` 用同一个数。 */
export const DEFAULT_WITNESS_PORT = 38640

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])
const NODE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/

export interface WitnessEndpointConfig {
  readonly store: string
  readonly host: string
  readonly port: number
  readonly writeTokenFile: string
  readonly readTokenFile: string
  readonly keys: readonly (readonly [string, string])[]
  readonly ready?: string
}

function valueAfter(argv: readonly string[], index: number): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${argv[index]} 后面缺一个值`)
  }
  return value
}

function absolute(path: string, flag: string): string {
  if (!isAbsolute(path)) throw new Error(`${flag} 必须是绝对路径：${path}`)
  return path
}

export function parseWitnessEndpointArgs(
  argv: readonly string[],
): WitnessEndpointConfig {
  let store: string | undefined
  let host = '127.0.0.1'
  let port = DEFAULT_WITNESS_PORT
  let writeTokenFile: string | undefined
  let readTokenFile: string | undefined
  let ready: string | undefined
  const keys: [string, string][] = []
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    switch (flag) {
      case '--store':
        store = absolute(valueAfter(argv, i++), flag)
        break
      case '--host':
        host = valueAfter(argv, i++)
        break
      case '--port': {
        const raw = valueAfter(argv, i++)
        if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65_535) {
          throw new Error(`--port 不是端口号：${raw}`)
        }
        port = Number(raw)
        break
      }
      case '--write-token-file':
        writeTokenFile = absolute(valueAfter(argv, i++), flag)
        break
      case '--read-token-file':
        readTokenFile = absolute(valueAfter(argv, i++), flag)
        break
      case '--ready':
        ready = absolute(valueAfter(argv, i++), flag)
        break
      case '--key': {
        const raw = valueAfter(argv, i++)
        const cut = raw.indexOf('=')
        const node = cut > 0 ? raw.slice(0, cut) : ''
        const key = cut > 0 ? raw.slice(cut + 1) : ''
        if (!NODE_NAME.test(node) || key === '') {
          throw new Error(`--key 要写成 <节点>=<公钥>：${raw}`)
        }
        keys.push([node, key])
        break
      }
      default:
        throw new Error(
          `不认识的参数：${flag}（--store --host --port --write-token-file --read-token-file --key --ready）`,
        )
    }
  }
  if (store === undefined) throw new Error('缺 --store <绝对路径>')
  if (writeTokenFile === undefined) throw new Error('缺 --write-token-file')
  if (readTokenFile === undefined) throw new Error('缺 --read-token-file')
  if (keys.length === 0) {
    throw new Error(
      '至少要一条 --key <节点>=<公钥>：没有公钥的见证端点一个锚点都收不下',
    )
  }
  if (!LOOPBACK.has(host)) {
    throw new Error(
      `--host 只能是回环地址，收到 ${host}：节点经 SSH 反向转发够到这里，不走公网`,
    )
  }
  return {
    store,
    host,
    port,
    writeTokenFile,
    readTokenFile,
    keys,
    ...(ready === undefined ? {} : { ready }),
  }
}

/** 读一枚 token：普通文件、只有属主可读、去掉首尾空白后非空。 */
export function readSecretFile(path: string, what: string): string {
  let mode: number
  try {
    const stat = statSync(path)
    if (!stat.isFile()) throw new Error('not a file')
    mode = stat.mode
  } catch {
    throw new Error(`读不到${what}：${path}`)
  }
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${what}权限过宽（${(mode & 0o777).toString(8)}），要 600：${path}`,
    )
  }
  const value = readFileSync(path, 'utf8').trim()
  if (value === '') throw new Error(`${what}是空的：${path}`)
  return value
}

export function startWitnessEndpoint(
  config: WitnessEndpointConfig,
): WitnessServiceHandle {
  return startWitnessService({
    store: new FileWitnessAnchorStore({ root: config.store }),
    publicKeys: new StaticPublicKeyDirectory(config.keys),
    writeToken: readSecretFile(config.writeTokenFile, '见证写 token '),
    readToken: readSecretFile(config.readTokenFile, '见证读 token '),
    hostname: config.host,
    port: config.port,
  })
}
