// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * demo 脚本共用的命令行与输出小工具。
 *
 * 单独成文件而不是塞进 `ac1-common.ts`：后者会 import 基座的会话构造函数，
 * 把一大片模块图拖进任何只想读一个 `--flag` 的进程。AC-2 那组脚本要测的是
 * 唤醒转发的耗时，多加载几十个模块就是往测量里掺底噪。
 */

/** 取 `--name value` 形式的命令行参数。 */
export function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

/** 取整数参数，缺省回落到 `fallback`。 */
export function intArg(name: string, fallback: number): number {
  const raw = arg(name)
  if (raw === undefined) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) ? n : fallback
}

/** 统一的 JSON 输出，便于 shell 侧消费（不引 jq 依赖）。 */
export function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}
