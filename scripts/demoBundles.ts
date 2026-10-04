#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 把 `demo/lib/` 下**被 shell 脚本直接调起**的那几个入口打成自包含单文件，落进
 * `dist/demo/`。
 *
 * 为什么必须打包，而不是直接投 `.ts` 源文件：舰队的投递载荷是 `dist` + `demo` 两块
 * （没有 `node_modules`，也没有 `packages/`），而这几个入口 import 的是 `@qianmo/*`
 * **workspace 包**。于是投出去的树上，它们全都是「文件在、跑不起来」——
 *
 *     error: Cannot find module '@qianmo/protocol' from '…/demo/lib/p81-probe.ts'
 *
 * 这不是理论问题：2026-08-27 在 p11 上部署时，注册中心起不来（`@qianmo/registry`），
 * 冒烟的八条地址拨号探针**全崩**，而崩溃回溯的尾巴恰好是 `Bun v1.3.13 (Linux x64)`
 * ——冒烟脚本把那一行当作失败原因原样报了出来，读起来像「节点拨不通」，实际是探针
 * 自己没跑起来。一个报不出真话的自检比没有自检更坏。
 *
 * 真源仍然是 `demo/lib/*.ts`。这里只产出**构建产物**；`demo_entry`（demo/lib/entry.sh）
 * 优先用 `dist/demo/` 里的那份，取不到才回落到源文件，所以未构建的开发检出照常工作。
 *
 * 名单是「shell 脚本会调起的入口」，不是「demo/lib 下的全部文件」。
 *
 * **判据不写在注释里，写成用例**（`scripts/__tests__/demoBundles.test.ts`）：它扫出仓库
 * 里每一处 `demo_entry <名字>` 调用，断言每个名字要么在本表、要么在下面的排除名单里。
 *
 * 表里有两个入口**只在注释里**出现：`ac2-target` 与 `p73-sample`。它们是教人手敲的命令
 * （`p73-sample` 那条写着 `--out /srv/p73/...`，就是给舰队机器上的人用的），照着在投出去的
 * 树上敲会撞同一个错，所以产物也要有它们。用例的正则不区分代码与注释，所以这两个照样
 * 被扫到、照样受覆盖检查约束 —— 这正是想要的：**注释里教的命令也得跑得起来**。
 *
 * 这条是踩出来的。本文件第一版把判据写成一句注释里的 grep：
 *
 *     grep -rn 'demo/lib/[a-z0-9-]*\.ts' demo --include='*.sh'
 *
 * 那句话是**错的**——`demo/ac1-restart.sh`、`ac2-wake-forward.sh`、`p31-resident-wake.sh`、
 * `p41-task-result.sh` 四个脚本先 `LIB="$REPO_DIR/demo/lib"` 再 `bun run "$LIB/xxx.ts"`，
 * 那条 grep 一个都找不到，于是首版漏了 **14** 个入口。注释里的判据没人执行，写错了不会
 * 有任何反馈；而漏一条的症状不是构建失败，是那个脚本在**投出去的机器上**才崩，且崩在
 * Bun 的模块解析层，错误信息与脚本自己想报的事情毫无关系。
 *
 * 所以消费侧 `demo_entry`（`demo/lib/entry.sh`）现在是**唯一**的调用形式：只有经过它
 * 才拿得到一条跑得起来的路径，因此扫它就扫得全，换个变量名也逃不掉。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 被 shell 直接调起的入口。加一条前先确认它真的被某个 .sh 调用。 */
export const DEMO_ENTRYPOINTS = [
  'ac1-project-dir',
  'ac2-activator',
  'ac2-report',
  'ac2-send',
  'ac2-state',
  'ac2-target',
  'ac3-loop-rate',
  'ac6a-sandbox',
  'ac6b-restore',
  'chaos-inject',
  'p31-copy-resident-timings',
  'p31-report',
  'p31-send',
  'p41-registry',
  'p41-report',
  'p41-send',
  'p51-diagnosis',
  'p61-seed',
  'p73-sample',
  'p81-probe',
  'p81-registry',
  'witness-endpoint',
] as const

/**
 * **故意不打包的入口，以及为什么** —— 这份名单是结论，不是遗漏。
 *
 * `p61-scenario` 与 `p73-throughput`（连同只被前者 spawn 的 `p61-worker`）都
 * `import '../../src/services/qianmo/auditTrail.js'`。那个模块是把每一种审计 sink 的
 * 类型汇到一处的枢纽，其中 `@qianmo/resident` 一路通向整个 CLI —— 打出来的两个产物
 * 各 **5.4 MB**（其余九个全在 261 KB 以下），并且里面含一句 `gaxios` 的
 * `await import("node-fetch")`。
 *
 * 那不是一段够不着的死代码：原文是 `hasWindow ? window.fetch : await import("node-fetch")`，
 * 而 Bun 上没有 `window`，所以真走到 `#getFetch()` 就会去 import 一个载荷里根本没有的
 * 包。`check:bundle` 正是为这类东西设的，它拦下了这两个产物 —— 那次拦截是对的，不该
 * 靠放宽门禁绕过去。
 *
 * 代价说清楚：`demo/p61-e2e.sh` 与 `demo/p73-baseline.sh` 在**投出去的树上**仍然跑不
 * 起来（`demo_entry` 会回落到源文件，而那里解析不出 `@qianmo/*`）—— 这是本次改动**之前
 * 就有的**状态，没有变好也没有变坏。要让它们也跑得起来，得先把 `auditTrail.ts` 的
 * 依赖图从 host 侧摘开，那是另一件事。真把它们加回上面那张表时，`p61-scenario` 里
 * `join(import.meta.dir, 'p61-worker.ts')` 那处也要一并改成「先产物后源文件」，否则
 * 产物旁边只有 `.js`，worker 会找不到。
 *
 * `ac1-*` 那四个（`ac1-restart.sh` 用的）是同一个病、更重一档：各 **24 MB**，同样带着
 * 那句 `import("node-fetch")`。它们经 `src/` 摸到会话与历史那一整片。`ac1-project-dir`
 * 不在此列——它只算路径，177 KB 以下，打得干净。
 *
 * 代价同上：`demo/ac1-restart.sh`、`demo/p61-e2e.sh`、`demo/p73-baseline.sh` 在投出去的
 * 树上仍跑不起来（`demo_entry` 回落到源文件，那里解析不出 `@qianmo/*`）——这是本次改动
 * **之前就有的**状态。
 */
export const DEMO_ENTRYPOINTS_EXCLUDED = [
  'ac1-crash-writer',
  'ac1-gen-history',
  'ac1-measure',
  'ac1-verify',
  'p61-scenario',
  'p61-worker',
  'p73-throughput',
] as const

export async function writeDemoBundles(outdir: string): Promise<number> {
  // 排除名单不是注释，是不变式。把某一条从下面那段说明里搬回打包表而没读那段说明，
  // 症状会是「构建通过、产物 5.4 MB、check:bundle 在几步之后才红」——在这里当场说。
  const readded = DEMO_ENTRYPOINTS.filter(name =>
    (DEMO_ENTRYPOINTS_EXCLUDED as readonly string[]).includes(name),
  )
  if (readded.length > 0) {
    throw new Error(
      `${readded.join('、')} 同时在打包表与排除名单里。` +
        '要把它加回来，先读 DEMO_ENTRYPOINTS_EXCLUDED 上面那段（auditTrail.ts 的依赖图、' +
        'node-fetch、以及 p61-worker 的路径要一起改），再把它从排除名单里删掉。',
    )
  }
  const dest = join(outdir, 'demo')
  const result = await Bun.build({
    entrypoints: DEMO_ENTRYPOINTS.map(name => `demo/lib/${name}.ts`),
    outdir: dest,
    // **root 必须钉死。**不给它，Bun 从入口集合推公共祖先——3 个入口时推出 `demo/lib`
    // （产物落 `dist/demo/<name>.js`），12 个时推出仓库根（产物落
    // `dist/demo/demo/lib/<name>.js`）。同一份代码，加一条入口就换一种布局，而消费侧
    // `demo_entry` 只认前一种：它会安静地回落到源文件，于是这一整个修复在部署树上等于
    // 没做。加一条入口不该改变已有入口的落位。
    root: 'demo/lib',
    target: 'bun',
  })
  if (!result.success) {
    // 逐条抛出来。静默产出一个缺文件的 dist/demo/ 会把问题推迟到部署现场。
    throw new AggregateError(result.logs, `demo 入口打包失败（${dest}）`)
  }
  // 落位当场核一遍。打包「成功」而文件不在 demo_entry 要找的那个路径上，是这段代码
  // 唯一会**静默**失效的方式（上面那条 root 注释就是它的由来）。
  const missing = DEMO_ENTRYPOINTS.filter(
    name => !existsSync(join(dest, `${name}.js`)),
  )
  if (missing.length > 0) {
    throw new Error(
      `demo 入口打包后不在预期位置：${missing.map(n => join(dest, `${n}.js`)).join('、')}` +
        '（demo/lib/entry.sh 的 demo_entry 只找这个路径）',
    )
  }
  return result.outputs.length
}
