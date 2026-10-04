// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 一个名字，两处拼写，一条测试把它们钉在一起。
 *
 * `packages/resident/src/acp-turn.ts` 要认出「这一步是通知工具自己」才能不给它
 * 一行过程（那一行的内容会紧跟在它下面出现，说两遍）。它拿得到的只有工具报上来的
 * title，而这个包是叶子，**不能 import `src/`**——`@qianmo/resident` 里出现一条指
 * 向宿主的边，就是把依赖方向反过来。
 *
 * 于是那边写了一份字面量。**重复本身不是问题，无人看守的重复才是**：改了宿主这个
 * 常量而没改那边，症状是那一行裸工具名悄悄回来——没有报错、没有告警，只有转录里
 * 多一行。这个文件能同时 import 两边，所以让它来看守。
 *
 * 反过来失败的方向是安全的：认不出来只会多一行冗余，不会少一行真过程。
 */

import { describe, expect, test } from 'bun:test'
import { SELF_REPORTING_TOOL_TITLE } from '@qianmo/resident'
import { QIANMO_NOTIFY_TOOL_NAME } from '../notifyTool.js'

describe('通知工具的名字', () => {
  test('常驻侧那份字面量与宿主这个常量必须一致', () => {
    expect(SELF_REPORTING_TOOL_TITLE).toBe(QIANMO_NOTIFY_TOOL_NAME)
  })
})
