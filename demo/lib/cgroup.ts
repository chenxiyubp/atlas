// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * cgroup v2 的两个读取原语，从 `ac6a-sandbox.ts` 原样搬出来。
 *
 * 搬出来的唯一理由是**第二个调用方**：P7.3 的长驻内存采样器要读同一批文件
 * （`memory.current` / `memory.peak` / `memory.events`），而它手里只有一个 pid，
 * 没有沙箱、没有 daemon、也不该为了读一行 `/proc/<pid>/cgroup` 去 import 一整套
 * Docker 与 activator 的模块图。
 *
 * **搬移时不改行为**，包括那句写着 "P1.3 resource probe" 的错误消息——它在 P7.3
 * 的路径上不会露面（采样器把 cgroup 当作可缺失通道，读不到就降级并如实标注），
 * 而改掉它会让 P1.3 的现场记录对不上代码。
 *
 * 与原版**唯一的接缝差异**：`unifiedCgroupDirectory` 收的是 pid 而不是容器 id。
 * 「容器 id → 宿主 pid」那一跳是 `docker inspect`，只有 P1.3 需要它，留在
 * `ac6a-sandbox.ts` 的调用点上；这边只做「pid → 统一层级目录」，两个调用方都用得上。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 某个进程所在的 cgroup v2 统一层级目录。非 cgroup v2 直接抛。 */
export function unifiedCgroupDirectory(pid: string): string {
  const unified = readFileSync(`/proc/${pid}/cgroup`, 'utf8')
    .split('\n')
    .find(line => line.startsWith('0::'))
  if (unified === undefined)
    throw new Error('P1.3 resource probe requires cgroup v2')
  return join('/sys/fs/cgroup', unified.slice(3))
}

/** 从 `key value` 形式的 cgroup 文件（`cpu.stat` / `memory.events`）取一个计数。 */
export function counter(path: string, key: string): number {
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find(candidate => candidate.startsWith(`${key} `))
  const value = line?.split(/\s+/)[1]
  if (value === undefined || !/^\d+$/.test(value))
    throw new Error(`missing ${key} counter`)
  return Number(value)
}
