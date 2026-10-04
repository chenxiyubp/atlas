// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `secrets/model-env` 的注入（issue #13）。
 *
 * 病根不是「凭据配错了」，是**从来没有人读过那个文件**：四台节点机上它 0600 躺着，
 * 起法脚本的 argv 里没有任何加载动作，于是 resident 与它拉起的 ACP 子进程的环境里
 * 一个模型相关的键都没有。链路整条走通（信封送达、`receipt: accepted`、审计链新增
 * `message_accepted`、ACP 子进程开出真实 agent turn），只有最后一步失败——而那一步的
 * 失败**只在 transcript 里**，起法脚本、横幅、日志一个字都不说。
 *
 * 所以这里钉四件事：
 *
 * ① 注入真的发生了，且**传到了子进程**（环境变量只在进程起来那一刻传一次）；
 * ② `set -a` 不外泄——它的作用域是整个 shell，漏关一次，之后每个局部变量都会被导出；
 * ③ 四种文件形状分开处理，「缺文件」与「文件在但是空的」不报成同一句话；
 * ④ **凭据值永不出现在任何输出里**。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPOSITORY_ROOT = resolve(import.meta.dir, '..', '..', '..')
const COMMON = join(REPOSITORY_ROOT, 'demo/env/beta/common.sh')
const BETA_UP = join(REPOSITORY_ROOT, 'demo/env/beta/beta-up.sh')

/** 假凭据。真值一律不进仓库，而这一串正好用来断言「它没有被打印出来」。 */
const FAKE_KEY = 'fake-for-test-never-print-this'

const roots: string[] = []

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'qianmo-beta-model-env-'))
  roots.push(value)
  mkdirSync(join(value, 'secrets'), { recursive: true })
  return value
}

function modelEnvPath(value: string): string {
  return join(value, 'secrets', 'model-env')
}

function writeModelEnv(value: string, body: string): string {
  const file = modelEnvPath(value)
  writeFileSync(file, body)
  chmodSync(file, 0o600)
  return file
}

interface ShellResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** 在真 `/bin/bash` 里 source common.sh 后跑一段脚本。 */
function runShell(value: string, lines: readonly string[]): ShellResult {
  const child = Bun.spawnSync(
    [
      '/bin/bash',
      '-c',
      ['set -euo pipefail', '. "$1"', ...lines].join('\n'),
      'beta-model-env-test',
      COMMON,
    ],
    {
      cwd: REPOSITORY_ROOT,
      env: {
        ...process.env,
        PATH: '/usr/bin:/bin',
        QIANMO_BETA_ROOT: value,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  return {
    exitCode: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

/** `beta_load_model_env` 之后的三个状态变量 + 那一行姿态。 */
function loadStatus(value: string): ShellResult {
  return runShell(value, [
    'beta_load_model_env',
    'printf "status=%s\\ncount=%s\\nclasses=%s\\nline=%s\\n" \\',
    '  "$BETA_MODEL_ENV_STATUS" "$BETA_MODEL_ENV_COUNT" \\',
    '  "$BETA_MODEL_ENV_CLASSES" "$(beta_model_env_line)"',
  ])
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    // 负向用例里有一个 0000 的文件，删得动它得先把权限放回来。
    try {
      chmodSync(modelEnvPath(value), 0o600)
    } catch {
      // 那个用例没跑到，或者文件本来就不在——两种都不影响下面这一步。
    }
    rmSync(value, { force: true, recursive: true })
  }
})

describe('beta model-env injection', () => {
  test('reports "absent" and starts anyway when there is no file', () => {
    const value = root()
    const result = loadStatus(value)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('status=absent')
    expect(result.stdout).toContain('count=0')
    expect(result.stdout).toContain('line=未加载')
    // 缺凭据不是错误：传输、审计、握手、备份都不需要模型凭据，节点仍然该起来。
    expect(result.stderr).toBe('')
  })

  test('injects the file into the environment of a child process', () => {
    const value = root()
    writeModelEnv(
      value,
      [
        '# 注释行不算键',
        '',
        'CLAUDE_CODE_USE_OPENAI=1',
        'OPENAI_BASE_URL=https://example.invalid/v1',
        `export OPENAI_API_KEY=${FAKE_KEY}`,
        '',
      ].join('\n'),
    )
    const result = runShell(value, [
      'beta_load_model_env',
      'printf "status=%s count=%s classes=%s\\n" \\',
      '  "$BETA_MODEL_ENV_STATUS" "$BETA_MODEL_ENV_COUNT" "$BETA_MODEL_ENV_CLASSES"',
      // resident 之后的每一层（nohup 的 resident、它 spawn 的 ACP 子进程）拿到的都是
      // 这一份。用一个真子进程验，而不是验「脚本里写了 export」——两者不是一回事。
      'AFTER_LOAD=must-not-be-exported',
      // printenv 而不是 `${VAR-default}`：后者在这个位置只是为了取默认值，却会让
      // biome 的 noTemplateCurlyInString 把这行当成写错的模板串。
      '/bin/bash -c \'printf "child key=%s use=%s base=%s after=%s\\n" \\',
      '  "$(printenv OPENAI_API_KEY || echo unset)" \\',
      '  "$(printenv CLAUDE_CODE_USE_OPENAI || echo unset)" \\',
      '  "$(printenv OPENAI_BASE_URL || echo unset)" \\',
      '  "$(printenv AFTER_LOAD || echo unset)"\'',
    ])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('status=loaded count=3 classes=openai')
    expect(result.stdout).toContain(
      `child key=${FAKE_KEY} use=1 base=https://example.invalid/v1 after=unset`,
    )
  })

  test('restores allexport instead of leaking `set -a` to the rest of the script', () => {
    const value = root()
    writeModelEnv(value, `OPENAI_API_KEY=${FAKE_KEY}\n`)
    // 调用方进来时 allexport 是关的（beta-up.sh 就是这样）→ 出去也必须是关的。
    const off = runShell(value, [
      'beta_load_model_env',
      'case "$-" in *a*) printf "allexport=on\\n" ;; *) printf "allexport=off\\n" ;; esac',
    ])
    expect(off.exitCode).toBe(0)
    expect(off.stdout).toContain('allexport=off')

    // 反方向同样要成立：本函数只负责还原，不负责替调用方决定这个开关。
    const on = runShell(value, [
      'set -a',
      'beta_load_model_env',
      'case "$-" in *a*) printf "allexport=on\\n" ;; *) printf "allexport=off\\n" ;; esac',
      'set +a',
    ])
    expect(on.exitCode).toBe(0)
    expect(on.stdout).toContain('allexport=on')
  })

  test('never prints the credential itself, on either the good or the bad path', () => {
    const value = root()
    writeModelEnv(
      value,
      [
        'CLAUDE_CODE_USE_OPENAI=1',
        `OPENAI_API_KEY=${FAKE_KEY}`,
        `ANTHROPIC_AUTH_TOKEN=${FAKE_KEY}-2`,
        '',
      ].join('\n'),
    )
    const good = loadStatus(value)
    expect(good.exitCode).toBe(0)
    expect(good.stdout + good.stderr).not.toContain(FAKE_KEY)
    // 报到类为止：够分辨「我以为配的是 openai，怎么报了 anthropic」，不够泄漏任何东西。
    expect(good.stdout).toContain('classes=anthropic openai')

    // 值不出现，键名也不出现——一把贴错位置的密钥会长在键名上。
    writeModelEnv(value, `ANTHROPIC_API_KEY_${FAKE_KEY}=1\n`)
    const weird = loadStatus(value)
    expect(weird.stdout + weird.stderr).not.toContain(FAKE_KEY)
  })

  test('keeps "no file" and "file with nothing in it" as two different failures', () => {
    const value = root()
    writeModelEnv(value, '# 只有注释\n\n   \n')
    const empty = loadStatus(value)
    // 文件在 = 有人配过。静默当作「没打算配」会让人去查错的那一头。
    expect(empty.exitCode).toBe(1)
    expect(empty.stderr).toContain('一个 KEY=VALUE 都没有')
    expect(empty.stderr).toContain('这与「没有这个文件」不是一件事')

    rmSync(modelEnvPath(value))
    const absent = loadStatus(value)
    expect(absent.exitCode).toBe(0)
    expect(absent.stdout).toContain('status=absent')
  })

  test('refuses to start on a broken symlink, a directory, or an unreadable file', () => {
    const broken = root()
    symlinkSync(join(broken, 'secrets', 'nowhere'), modelEnvPath(broken))
    const brokenResult = loadStatus(broken)
    expect(brokenResult.exitCode).toBe(1)
    expect(brokenResult.stderr).toContain('断掉的软链')

    const directory = root()
    mkdirSync(modelEnvPath(directory))
    const directoryResult = loadStatus(directory)
    expect(directoryResult.exitCode).toBe(1)
    expect(directoryResult.stderr).toContain('不是普通文件')

    // root 对 0000 照样读得动，那台机器上这条判据不成立——跳过而不是假装验过。
    if (process.getuid?.() !== 0) {
      const unreadable = root()
      writeModelEnv(unreadable, `OPENAI_API_KEY=${FAKE_KEY}\n`)
      chmodSync(modelEnvPath(unreadable), 0o000)
      const unreadableResult = loadStatus(unreadable)
      expect(unreadableResult.exitCode).toBe(1)
      expect(unreadableResult.stderr).toContain('读不掉')
    }
  })

  test('classifies provider families by key name only', () => {
    const value = root()
    writeModelEnv(
      value,
      [
        'ANTHROPIC_BASE_URL=https://example.invalid',
        'DEEPSEEK_TEMPERATURE=0',
        'OPENCODE_API_KEY=x',
        'GEMINI_API_KEY=x',
        'XAI_API_KEY=x',
        'CLAUDE_CODE_USE_BEDROCK=1',
        'CLAUDE_CODE_USE_VERTEX=1',
        'SOMETHING_ELSE=1',
        '',
      ].join('\n'),
    )
    const result = loadStatus(value)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(
      'classes=anthropic deepseek opencode gemini grok bedrock vertex 其他',
    )
  })
})

describe('beta-up.sh injects before it starts the resident', () => {
  const script = readFileSync(BETA_UP, 'utf8')
  const code = script
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n')

  test('the node leg loads model-env ahead of beta_start_process', () => {
    const load = code.indexOf('beta_load_model_env')
    const start = code.indexOf('beta_start_process "$BETA_NODE"')
    expect(load).toBeGreaterThan(-1)
    expect(start).toBeGreaterThan(-1)
    // 顺序就是全部：环境变量只在进程起来的那一刻传递一次，事后注入到不了它。
    expect(load).toBeLessThan(start)
  })

  test('both outcomes are reported on the node banner', () => {
    expect(code).toContain('beta_model_env_line')
    expect(code).toContain('BETA_MODEL_ENV_STATUS')
  })

  test('the host leg never gets model credentials', () => {
    // 控制台不跑 agent 轮次。给 H 一份凭据只是多一处可被读走的副本，
    // 而 H 正是那台同时装着 admin token、四把 PSK 和 SSH 私钥的机器。
    const host = code.slice(
      code.indexOf('run_host() {'),
      code.indexOf('run_node() {'),
    )
    expect(host.length).toBeGreaterThan(0)
    expect(host).not.toContain('beta_load_model_env')
  })
})
