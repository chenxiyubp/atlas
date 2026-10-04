#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * AC-5 编程任务用例（roadmap P1.4）——「同一条任务，换 provider 重跑，只改配置」。
 *
 * 做的事：
 *   1. 从**配置文件**（默认 `tests/integration/fixtures/qianmo-providers.json`）
 *      经基座自己的注册中心（`loadProviders` + `switchProvider`）解析出一条
 *      provider，得到 `CLAUDE_CODE_USE_OPENAI` / `OPENAI_BASE_URL` / `OPENAI_MODEL`。
 *   2. 在临时目录里新建一个 git 仓库，写入**任务自带的测试**（`test/slugify.test.ts`）
 *      与一个会抛异常的桩实现（`src/slugify.ts`），并提交。
 *   3. 用 `-p`（headless）跑 occ，让它把桩实现补完。
 *   4. 校验 `test/` 未被改动（sha256 前后一致），然后在临时仓库里跑 `bun test`，
 *      **以任务自带断言的退出码作为通过判据**。
 *
 * 两次运行之间**唯一**的差别是 `--provider` 选中的那一条配置：任务仓库内容、提示词、
 * occ 调用参数、脚本本身都由同一份代码生成，脚本会打印它们的 sha256 供比对。
 *
 * 凭据只从环境变量取（配置文件里存的是**变量名**，不是密钥）。缺失即退出并说明。
 *
 * 用法：
 *   bun run scripts/qianmo-provider-task.ts --provider qianmo-deepseek
 *   bun run scripts/qianmo-provider-task.ts --provider qianmo-alt
 * 可选：
 *   --providers-file <path>   换一份 providers.json
 *   --keep                    保留临时仓库（默认保留，便于取证；--clean 删除）
 *   --json                    只在 stdout 打印结果 JSON
 */

import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..')

// ── 任务夹具：内联在脚本里，两次运行按同一份字符串生成 ──────────────────────

/** 任务自带的断言。跑完之后会校验它没有被改动过。 */
const TASK_TEST_FILE = `import { describe, expect, test } from 'bun:test'
import { slugify } from '../src/slugify.ts'

describe('slugify', () => {
  test('lowercases and hyphenates words', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  test('collapses runs of non-alphanumeric characters into one hyphen', () => {
    expect(slugify('Qianmo  --  AgentNest!!')).toBe('qianmo-agentnest')
  })

  test('trims leading and trailing separators', () => {
    expect(slugify('  ///Edge Case///  ')).toBe('edge-case')
  })

  test('keeps digits', () => {
    expect(slugify('Release 2.38.3')).toBe('release-2-38-3')
  })

  test('returns an empty string when nothing survives', () => {
    expect(slugify('***')).toBe('')
  })
})
`

/** 待补完的桩。原样跑 \`bun test\` 必然全红。 */
const TASK_STUB_FILE = `/**
 * Turn a human title into a URL slug.
 *
 * NOT IMPLEMENTED — implementing this is the task.
 */
export function slugify(input: string): string {
  throw new Error(\`slugify is not implemented yet (input: \${input})\`)
}
`

const TASK_README = `# slug-task

\`src/slugify.ts\` is a stub. \`test/slugify.test.ts\` defines the required
behaviour and must not be edited. Make \`bun test\` pass.
`

const TASK_PROMPT = [
  'This repository has a failing test suite.',
  'Implement the `slugify` function in src/slugify.ts so that `bun test` passes.',
  '',
  'Rules:',
  '- The tests in test/ define the required behaviour. Do NOT modify anything under test/.',
  '- Change only src/slugify.ts.',
  '- Run `bun test` yourself and keep working until it passes.',
].join('\n')

// ── 参数 ────────────────────────────────────────────────────────────────────

interface Args {
  providerId: string
  providersFile: string
  keep: boolean
  jsonOnly: boolean
}

function parseArgs(argv: string[]): Args {
  let providerId = ''
  let providersFile = join(
    REPO_ROOT,
    'tests',
    'integration',
    'fixtures',
    'qianmo-providers.json',
  )
  let keep = true
  let jsonOnly = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--provider') {
      providerId = argv[++i] ?? ''
    } else if (arg === '--providers-file') {
      providersFile = resolve(argv[++i] ?? '')
    } else if (arg === '--keep') {
      keep = true
    } else if (arg === '--clean') {
      keep = false
    } else if (arg === '--json') {
      jsonOnly = true
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  if (!providerId) {
    throw new Error('缺少 --provider <id>')
  }
  return { providerId, providersFile, keep, jsonOnly }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function log(jsonOnly: boolean, message: string): void {
  if (!jsonOnly) console.error(message)
}

function run(
  cmd: string[],
  cwd: string,
  env?: Record<string, string>,
): { code: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    ...(env ? { env } : {}),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const { providerId, providersFile, jsonOnly } = args

  // 1. 隔离的配置目录：把配置文件放进去，再让**基座自己的注册中心**去读。
  //    整个流程不碰用户的真实 ~/.occ。
  const workRoot = mkdtempSync(join(tmpdir(), 'qianmo-ac5-'))
  const configDir = join(workRoot, 'config')
  const taskDir = join(workRoot, 'repo')
  mkdirSync(configDir, { recursive: true })
  mkdirSync(join(taskDir, 'src'), { recursive: true })
  mkdirSync(join(taskDir, 'test'), { recursive: true })

  const providersJson = readFileSync(providersFile, 'utf-8')
  writeFileSync(join(configDir, 'providers.json'), providersJson, 'utf-8')

  // occConfigDir() 的解析顺序是 OCC_CONFIG_DIR > CLAUDE_CONFIG_DIR > ~/.occ，
  // 两个都设上才能保证外层 shell 的残留不会把注册中心指回真实配置目录。
  process.env.OCC_CONFIG_DIR = configDir
  process.env.CLAUDE_CONFIG_DIR = configDir

  // 动态 import：必须在上面两个环境变量落定之后才加载注册中心。
  const { loadProvidersWithDiagnostic } = await import(
    '../src/services/providerRegistry/loader.js'
  )
  const { switchProvider, buildShellExportBlock } = await import(
    '../src/services/providerRegistry/switcher.js'
  )

  const loaded = loadProvidersWithDiagnostic()
  if (loaded.error) {
    console.error(`[AC-5] providers.json 解析失败：${loaded.error}`)
    return 2
  }
  const switched = switchProvider(providerId, loaded.providers)
  const provider = switched.provider

  const apiKey = process.env[provider.apiKeyEnv]
  if (!apiKey) {
    console.error(
      `[AC-5] 跳过：provider "${providerId}" 需要环境变量 ${provider.apiKeyEnv}，当前未设置。` +
        ` 密钥不入库，请在 shell 里导出后重跑。`,
    )
    return 3
  }

  log(
    jsonOnly,
    `[AC-5] provider=${provider.id} kind=${provider.kind} compat=${provider.compatRule}`,
  )
  log(jsonOnly, `[AC-5] switchProvider 产出的环境（密钥用变量引用，不回显）：`)
  log(jsonOnly, buildShellExportBlock(switched))
  for (const w of switched.warnings) log(jsonOnly, `[AC-5][warn] ${w}`)

  // 2. 任务仓库
  writeFileSync(join(taskDir, 'src', 'slugify.ts'), TASK_STUB_FILE, 'utf-8')
  writeFileSync(
    join(taskDir, 'test', 'slugify.test.ts'),
    TASK_TEST_FILE,
    'utf-8',
  )
  writeFileSync(join(taskDir, 'README.md'), TASK_README, 'utf-8')
  writeFileSync(
    join(taskDir, 'package.json'),
    `${JSON.stringify({ name: 'slug-task', private: true, type: 'module' }, null, 2)}\n`,
    'utf-8',
  )

  const testFileHashBefore = sha256(TASK_TEST_FILE)

  const gitEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    GIT_AUTHOR_NAME: 'AC-5 harness',
    GIT_AUTHOR_EMAIL: 'ac5@example.invalid',
    GIT_COMMITTER_NAME: 'AC-5 harness',
    GIT_COMMITTER_EMAIL: 'ac5@example.invalid',
  }
  run(['git', 'init', '-q', '-b', 'main'], taskDir, gitEnv)
  run(['git', 'add', '-A'], taskDir, gitEnv)
  const committed = run(
    ['git', 'commit', '-q', '-m', 'chore: task fixture'],
    taskDir,
    gitEnv,
  )
  if (committed.code !== 0) {
    console.error(`[AC-5] git commit 失败：${committed.stderr}`)
    return 2
  }

  // 3. 基线：任务自带的测试此刻必须是红的，否则这条用例证明不了任何事。
  const baseline = run(['bun', 'test'], taskDir)
  if (baseline.code === 0) {
    console.error('[AC-5] 基线异常：桩实现居然让任务自带测试通过了，用例无效')
    return 2
  }
  log(
    jsonOnly,
    `[AC-5] 基线确认：桩实现下 bun test 退出码 ${baseline.code}（应为非 0）`,
  )

  // 4. 跑 occ
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...switched.env,
    OPENAI_API_KEY: apiKey,
    CLAUDE_CONFIG_DIR: configDir,
    OCC_CONFIG_DIR: configDir,
  }
  // 两条 provider 都走 OpenAI 兼容面；留着 Anthropic 凭据只会制造歧义。
  delete childEnv.ANTHROPIC_API_KEY

  const occArgv = [
    'bun',
    'run',
    join(REPO_ROOT, 'src', 'entrypoints', 'cli.tsx'),
    '-p',
    TASK_PROMPT,
    '--dangerously-skip-permissions',
    '--output-format',
    'json',
  ]

  log(jsonOnly, `[AC-5] 启动 occ（cwd=${taskDir}）……`)
  const started = Date.now()
  const occ = run(occArgv, taskDir, childEnv)
  const elapsedMs = Date.now() - started
  writeFileSync(join(workRoot, 'occ-stdout.json'), occ.stdout, 'utf-8')
  writeFileSync(join(workRoot, 'occ-stderr.log'), occ.stderr, 'utf-8')
  log(
    jsonOnly,
    `[AC-5] occ 退出码 ${occ.code}，耗时 ${(elapsedMs / 1000).toFixed(1)}s`,
  )

  // 5. 测试文件必须没被动过
  const testFileAfter = readFileSync(
    join(taskDir, 'test', 'slugify.test.ts'),
    'utf-8',
  )
  const testFileHashAfter = sha256(testFileAfter)
  const testsUntouched = testFileHashBefore === testFileHashAfter

  // 6. 任务自带断言
  const verdict = run(['bun', 'test'], taskDir)
  const changed = run(['git', 'diff', '--stat'], taskDir, gitEnv)
  const patch = run(['git', 'diff'], taskDir, gitEnv)
  writeFileSync(join(workRoot, 'model-patch.diff'), patch.stdout, 'utf-8')
  // bun test 把结果写 stderr，只看 stdout 会得到一行版本号。
  const verdictOutput = [verdict.stdout.trim(), verdict.stderr.trim()]
    .filter(Boolean)
    .join('\n')
  writeFileSync(join(workRoot, 'task-tests.log'), verdictOutput, 'utf-8')

  const passed = testsUntouched && verdict.code === 0

  const summary = {
    ac: 'AC-5',
    providerId: provider.id,
    kind: provider.kind,
    compatRule: provider.compatRule,
    model: provider.defaultModel,
    baseUrl: provider.baseUrl,
    apiKeyEnv: provider.apiKeyEnv,
    occExitCode: occ.code,
    occElapsedMs: elapsedMs,
    taskTestsExitCode: verdict.code,
    taskTestsUntouched: testsUntouched,
    passed,
    workRoot,
    hashes: {
      script: sha256(readFileSync(SCRIPT_PATH, 'utf-8')),
      prompt: sha256(TASK_PROMPT),
      taskTest: testFileHashBefore,
      taskStub: sha256(TASK_STUB_FILE),
      providersFile: sha256(providersJson),
    },
  }

  if (!jsonOnly) {
    console.error('')
    console.error('─── occ 最终输出（--output-format json）──────────────────')
    console.error(occ.stdout.trim().slice(0, 2000))
    console.error('')
    console.error('─── 模型改了哪些文件 ────────────────────────────────────')
    console.error(changed.stdout.trim() || '(无改动)')
    console.error('')
    console.error('─── 任务自带测试 ────────────────────────────────────────')
    console.error(verdictOutput)
    console.error('')
  }

  console.log(JSON.stringify(summary, null, 2))

  if (!args.keep) {
    rmSync(workRoot, { recursive: true, force: true })
  } else {
    log(jsonOnly, `[AC-5] 取证目录保留在 ${workRoot}`)
  }

  return passed ? 0 : 1
}

process.exit(await main())
