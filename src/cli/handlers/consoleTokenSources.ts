// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 控制台两枚 token 的**出处**：文件、环境变量、命令行，按这个顺序。
 *
 * ## 为什么会有这个文件
 *
 * `--view-token` / `--admin-token` 曾经是仅有的入口，而命令行上的密钥就是这台
 * 机器每一份进程列表里的密钥——Linux 的 `/proc/<pid>/cmdline` 默认全局可读，所以
 * 一台有第二个账号（或一批容器）的宿主上，任何本地用户 `ps -eo args` 一眼就是
 * 控制台的 admin。这条纪律 `console.md` §4.4 与 `packages/console/src/auth.ts`
 * 都写着，PSK 也一直是照它办的（`QIANMO_TRANSPORT_PSK`，只有环境变量入口），
 * 只有 token 没有对应物。这个文件把那两个入口补上。
 *
 * ## 优先级：文件 > 环境变量 > 命令行
 *
 * 排序的依据是「这一份密钥能被什么保护」，不是「哪个写起来更显式」：
 *
 * - **文件**是三者里唯一能被文件系统权限保护的——它不进任何进程的 `argv`，也不
 *   进子进程继承的 `environ`。所以它排第一，并且我们真的去查它的 mode：一个对
 *   0644 闭眼的「安全入口」只是把明文从 `ps` 挪到了 `ls -l`。
 * - **环境变量**在 Linux 上是 `/proc/<pid>/environ`，而那个文件**只有属主可读**
 *   （`cmdline` 不是），所以它挡得住同机的其他账号，挡不住同一个账号里被 export
 *   过去的子进程。排第二。
 * - **命令行**留着只是为了不打断既有脚本与 `console.md` §3 的选项表，它排最后，
 *   并且启动横幅会把「这一枚来自命令行，且出现在进程列表里」明写出来——静默地
 *   让高优先级入口盖掉低的，才是那种事后没人查得清的配置事故。
 *
 * ## 不在这里的东西
 *
 * 「多长算够」「两枚必须不同」「非环回必须显式给」是 `resolveTokens` 的三条策略，
 * 住在 `packages/console/src/auth.ts`，这里一个字都不抄。本文件只回答「这一枚
 * 从哪儿来、拿到的是什么」，拿到之后交给那条策略判。
 */

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs'

/** 只读凭据的环境变量入口，命名照 `QIANMO_TRANSPORT_PSK` 的族。 */
export const VIEW_TOKEN_ENV_VAR = 'QIANMO_CONSOLE_VIEW_TOKEN'

/** 读写凭据的环境变量入口。 */
export const ADMIN_TOKEN_ENV_VAR = 'QIANMO_CONSOLE_ADMIN_TOKEN'

/** 两枚 token 的角色名，同时也是选项名与错误文案里的那一段。 */
type ConsoleTokenRole = 'view' | 'admin'

/** 一枚 token 实际来自哪个入口。 */
type ConsoleTokenOrigin = 'file' | 'env' | 'flag'

/** 解析出来的一枚 token，连同它的出处。 */
interface ConsoleTokenSource {
  readonly value: string
  readonly origin: ConsoleTokenOrigin
  /**
   * 一行给人看的出处，进启动横幅。
   *
   * **永远不含 token 本身**——横幅只回显自动生成的那一枚（`console.ts`），显式
   * 提供的已经在操作者手里，再打进终端记录与 CI 日志只是白白多一份泄露面。
   */
  readonly detail: string
}

/**
 * 权限位里只要有一个落在这个掩码上，就拒绝启动。
 *
 * 即 group 与 other 的读/写/执行全部要为 0：`0600` 过，`0400` 过，`0640` 不过，
 * `0644` 不过。owner 的执行位（`0700`）不拦——它不泄露任何东西，而拦下来只会让
 * 人在一台 umask 古怪的机器上莫名其妙起不来。
 */
export const TOKEN_FILE_FORBIDDEN_MODE_BITS = 0o077

function envVarFor(role: ConsoleTokenRole): string {
  return role === 'view' ? VIEW_TOKEN_ENV_VAR : ADMIN_TOKEN_ENV_VAR
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 读一个 token 文件，顺带把它的权限查掉。
 *
 * **先 open 再 fstat 再从同一个 fd 读**，不是 `statSync` + `readFileSync`：后者
 * 查的和读的可以不是同一个 inode（中间换一个符号链接就够了），于是权限检查会
 * 变成一个只在没人攻击时才成立的检查。一个 fd 走到底就没有这条缝。
 *
 * 尾部换行会被去掉——真机上那两个文件是 `printf '%s\n'` 出来的。
 */
export function readConsoleTokenFile(
  path: string,
  role: ConsoleTokenRole,
): string {
  const flag = `--${role}-token-file`
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    throw new Error(`${flag} ${path} cannot be read: ${reasonOf(error)}`)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) {
      throw new Error(`${flag} ${path} is not a regular file`)
    }
    // Windows 上 Node 报的 mode 位与 POSIX 权限没有对应关系（目录一律 0666/0444），
    // 照着判会让这个入口在 Windows 上永远起不来。那里的访问控制是 ACL，不是 mode。
    const mode = stat.mode & 0o777
    if (
      process.platform !== 'win32' &&
      (mode & TOKEN_FILE_FORBIDDEN_MODE_BITS) !== 0
    ) {
      throw new Error(
        `${flag} ${path} is readable beyond its owner (mode ${mode
          .toString(8)
          .padStart(4, '0')}); ` +
          'run `chmod 600` on it — a token file the whole machine can read ' +
          'is the same leak as passing the token on the command line',
      )
    }
    const token = readFileSync(fd, 'utf8').trim()
    if (token === '') {
      throw new Error(`${flag} ${path} is empty`)
    }
    return token
  } finally {
    closeSync(fd)
  }
}

/** 环境变量那一支：未设置与空串都算「没给」，设了却全是空白算配错。 */
function fromEnv(
  role: ConsoleTokenRole,
  env: Record<string, string | undefined>,
): ConsoleTokenSource | undefined {
  const variable = envVarFor(role)
  const raw = env[variable]
  if (raw === undefined || raw.length === 0) return undefined
  const value = raw.trim()
  if (value === '') {
    throw new Error(`${variable} must not be blank`)
  }
  return { value, origin: 'env', detail: `$${variable}` }
}

/**
 * `parseConsoleArgs` 的产物里与 token 有关的那四个字段。
 *
 * 结构性地写一遍而不是 `Pick<ConsoleCliConfig, …>`：那个 `import type` 会在
 * `consoleArgs.ts` → 本文件（它要 {@link VIEW_TOKEN_ENV_VAR} 拼帮助文本）之外
 * 再加一条回边，而 `check:cycles` 连 type-only 的边也数。字段名由编译器对齐——
 * `ConsoleCliConfig` 改了名字，`resolveConsoleTokenSource` 的调用点就红。
 */
interface ConsoleTokenConfig {
  /** 命令行给的只读凭据。 */
  readonly viewToken?: string
  /** 命令行给的读写凭据。 */
  readonly adminToken?: string
  /** `--view-token-file` 的绝对路径。 */
  readonly viewTokenFile?: string
  /** `--admin-token-file` 的绝对路径。 */
  readonly adminTokenFile?: string
}

/**
 * 一枚 token 的最终来源，没有任何入口给出就返回 `undefined`。
 *
 * `undefined` 不等于「起不来」：环回绑定下 `resolveTokens` 会自己生成一枚，那正是
 * `occ console` 不带参数就能起的原因。判定住在那边，这里只负责报告。
 */
export function resolveConsoleTokenSource(
  role: ConsoleTokenRole,
  config: ConsoleTokenConfig,
  env: Record<string, string | undefined> = process.env,
): ConsoleTokenSource | undefined {
  const file = role === 'view' ? config.viewTokenFile : config.adminTokenFile
  if (file !== undefined) {
    return {
      value: readConsoleTokenFile(file, role),
      origin: 'file',
      detail: `--${role}-token-file ${file}`,
    }
  }
  const environment = fromEnv(role, env)
  if (environment !== undefined) return environment

  const flag = role === 'view' ? config.viewToken : config.adminToken
  if (flag !== undefined) {
    return {
      value: flag,
      origin: 'flag',
      // 横幅上就说清楚这一枚是怎么来的：它此刻正躺在 `ps -eo args` 里。
      detail: `--${role}-token (visible in the process list)`,
    }
  }
  return undefined
}
