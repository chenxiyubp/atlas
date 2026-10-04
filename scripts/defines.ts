import { spawnSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const pkgPath = resolve(repoRoot, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))

/** occ's own issue tracker. Kept in sync with PRODUCT_URL in src/constants/product.ts. */
const ISSUES_URL = 'https://github.com/sweetcornna/open-claude-code/issues'

/**
 * What MACRO.SOURCE_COMMIT says when the build could not establish one.
 *
 * Mirrored by UNKNOWN_SOURCE_COMMIT in src/constants/buildProvenance.ts — the
 * two ends of the same define. Spelled here rather than imported from there
 * because this file feeds Vite's `define` and must not drag `src/` into the
 * build config's module graph.
 */
const UNKNOWN_SOURCE_COMMIT = 'unknown'

/**
 * How a build with no usable git metadata can still be told what it is.
 *
 * The fleet's own deployment path needs it: `demo/env/bootstrap.sh` runs
 * `bun run build` inside `~/atlas-beta/`, and that tree arrives as a plain
 * directory copy — no `.git`, so git has nothing to answer with and the
 * artifact would report `unknown` on exactly the machines issue #70 is about.
 *
 * Consulted only when git cannot answer, never as an override: where the tree
 * *is* the repository, the repository is the truth and an exported variable
 * left over from an earlier shell must not be able to relabel it.
 */
const SOURCE_COMMIT_ENV_VAR = 'OCC_SOURCE_COMMIT'

/**
 * `git <args>` run in `cwd`, or `null` if git could not answer.
 *
 * Never throws and never inherits stdio: a build inside a clean tarball, a
 * Docker layer without git installed, or an unborn branch must still produce a
 * bundle. Every one of those cases funnels into `null`, which the caller turns
 * into the explicit "unknown" marker rather than a silent empty string.
 */
function gitOutput(args: readonly string[], cwd: string): string | null {
  try {
    const result = spawnSync('git', [...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    if (result.error || result.status !== 0) return null
    return typeof result.stdout === 'string' ? result.stdout.trim() : null
  } catch {
    return null
  }
}

let cachedSourceCommit: string | undefined

/**
 * The commit this bundle was built from, with a `-dirty` suffix whenever the
 * working tree carried anything git would report.
 *
 * The suffix is not decoration. Fleet artifacts are routinely built from a
 * working tree that is ahead of (or beside) its commit, and a bare SHA on such
 * a build claims a provenance the bytes do not have — which is issue #70 in
 * miniature. Untracked files count too: an unstaged `.ts` under `src/` is
 * compiled into the bundle exactly like a tracked one.
 *
 * Conservative in two more places: if HEAD resolves but `git status` does not,
 * the result is marked dirty — "cannot tell" must never render as "clean"; and
 * the repository git finds has to *be* this tree, not an ancestor of it.
 *
 * With no usable repository the answer comes from `OCC_SOURCE_COMMIT` if the
 * operator supplied one, and otherwise is `'unknown'`.
 *
 * Memoized for the repo root because both callers (`scripts/dev.ts`,
 * `vite.config.ts`) may ask more than once per process and each miss costs two
 * subprocesses. `cwd` exists so the three states above can be exercised
 * against throwaway trees instead of only against whatever the developer's
 * checkout happens to be in — the argument-less call is the product path.
 */
export function resolveSourceCommit(cwd: string = repoRoot): string {
  if (cwd === repoRoot && cachedSourceCommit !== undefined) {
    return cachedSourceCommit
  }
  const resolved = measureSourceCommit(cwd)
  if (cwd === repoRoot) cachedSourceCommit = resolved
  return resolved
}

function measureSourceCommit(cwd: string): string {
  // One subprocess for both facts, in this order: rev-parse prints its
  // arguments' answers left to right.
  const [toplevel, head] = (
    gitOutput(['rev-parse', '--show-toplevel', 'HEAD'], cwd) ?? ''
  ).split('\n')
  // `rev-parse` walks *up* until it finds a repository. A deployment tree
  // copied into a home directory that happens to be a dotfiles repo would
  // otherwise be stamped with that repo's HEAD — a confident, wrong answer,
  // which is worse than `unknown` and is the same failure shape as the issue
  // this field exists to close. So the repository has to be this tree itself.
  if (!head || !toplevel || !isSamePath(toplevel, cwd)) {
    return sourceCommitFromEnvironment() ?? UNKNOWN_SOURCE_COMMIT
  }
  const status = gitOutput(['status', '--porcelain'], cwd)
  return status === null || status.length > 0 ? `${head}-dirty` : head
}

/** Compared through realpath: /tmp vs /private/tmp is the same tree on macOS. */
function isSamePath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function sourceCommitFromEnvironment(): string | null {
  const raw = process.env[SOURCE_COMMIT_ENV_VAR]?.trim()
  return raw ? raw : null
}

/**
 * Shared MACRO define map used by both dev.ts (runtime -d flags)
 * and build.ts (Bun.build define option).
 *
 * Each value is a JSON-stringified expression that replaces the
 * corresponding MACRO.* identifier at transpile / bundle time.
 *
 * VERSION is read from package.json to avoid version drift.
 *
 * SOURCE_COMMIT is read from git for the same reason one level down: VERSION
 * is identical on every commit of this fork (it tracks the base's release
 * line), so it answers "which upstream did this come from" and nothing about
 * *our* code. SOURCE_COMMIT is the only field in a shipped bundle that
 * identifies the source it was built from — see issue #70, where a deployed
 * fleet artifact turned out to carry no provenance marker at all.
 */
export function getMacroDefines(): Record<string, string> {
  return {
    'MACRO.VERSION': JSON.stringify(pkg.version),
    'MACRO.BUILD_TIME': JSON.stringify(new Date().toISOString()),
    'MACRO.SOURCE_COMMIT': JSON.stringify(resolveSourceCommit()),
    // Both of these are interpolated into user-facing sentences that read as
    // truncated when empty — the system prompt's "To give feedback, users
    // should ${ISSUES_EXPLAINER}" and auth.ts's "post in ${FEEDBACK_CHANNEL}".
    // They inherited Anthropic's empty defaults; occ has its own tracker.
    'MACRO.FEEDBACK_CHANNEL': JSON.stringify(`${ISSUES_URL}`),
    'MACRO.ISSUES_EXPLAINER': JSON.stringify(
      `report the issue at ${ISSUES_URL}`,
    ),
    'MACRO.NATIVE_PACKAGE_URL': JSON.stringify(''),
    'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
    'MACRO.VERSION_CHANGELOG': JSON.stringify(''),
  }
}

/**
 * {@link getMacroDefines} rendered as `bun -d` arguments.
 *
 * Every process that runs the entrypoint from source has to pass these:
 * `MACRO.*` is a transpile-time substitution, so a source run without `-d`
 * leaves the identifier undefined and the first read throws. The alternative —
 * an entrypoint that installs its own `globalThis.MACRO` when the defines are
 * missing — is what issue #81 is about: that copy carried Anthropic's empty
 * `ISSUES_EXPLAINER` long after this file grew its own, and the system prompt
 * of every source run said "To give feedback, users should " and stopped.
 *
 * So the values live here only, and callers ask for the flags rather than
 * spelling a second list.
 */
export function macroDefineArgs(): string[] {
  return Object.entries(getMacroDefines()).flatMap(([key, value]) => [
    '-d',
    `${key}:${value}`,
  ])
}

/**
 * Default feature flags enabled in both Bun.build and Vite builds.
 * Additional features can be enabled via FEATURE_<NAME>=1 env vars.
 *
 * Used by:
 *   - build.ts (Bun.build)
 *   - scripts/vite-plugin-feature-flags.ts (Vite/Rollup)
 *   - scripts/dev.ts (bun run dev)
 */
export const DEFAULT_BUILD_FEATURES = [
  'TRANSCRIPT_CLASSIFIER', // 对话分类器，用于标注会话类型
  'AGENT_TRIGGERS_REMOTE', // sessionIngress 模块级 Map 累积（非 GB 级主因）
  'CHICAGO_MCP', // Chicago MCP 集成（内部代号）
  'VOICE_MODE', // Push-to-Talk 语音输入模式
  'PROMPT_CACHE_BREAK_DETECTION', // 检测 prompt cache 是否被打破（有 10 条上限，可控）
  'TOKEN_BUDGET', // Token 预算管理与控制
  // P0: local features
  'AGENT_TRIGGERS', // 本地 Agent 触发器（工具调用时启动子代理）
  'ULTRATHINK', // 超深度思考模式，增加推理链长度
  'BUILTIN_EXPLORE_PLAN_AGENTS', // 内置 Explore/Plan 子代理类型
  'LODESTONE', // 上下文锚点，优化长对话的相关性检索
  'EXTRACT_MEMORIES', // 每次 turn 结束 fork 完整消息历史（非 GB 级主因）
  'VERIFICATION_AGENT', // 任务完成后 fork 完整消息（非 GB 级主因）
  'KAIROS_BRIEF', // Kairos 定时摘要（定时汇报当前状态）
  'AWAY_SUMMARY', // 离线摘要（用户离开后生成总结）
  'ULTRAPLAN', // 超级规划模式，深度分析后生成实施计划
  'DAEMON', // 守护进程模式，长驻 supervisor 管理后台 worker（非 GB 级主因）
  'ACP', // ACP 代理协议，支持外部 agent 接入
  'WORKFLOW_SCRIPTS', // 工作流脚本（.claude/workflows/ 中的 YAML/MD）
  'MONITOR_TOOL', // Monitor 工具，流式监控后台进程输出
  'KAIROS', // Kairos 定时任务系统核心
  'COORDINATOR_MODE', // 多 worker 编排模式（AgentSummary 泄露已在 52b61c2c 修复）
  'BG_SESSIONS', // 后台会话管理（ps/logs/attach/kill）
  'TEMPLATES', // 模板任务（new/list/reply 子命令）
  // auto 主题：跟随终端明暗自动切换。判定依据是终端**背景色**（OSC 11 轮询），
  // 不是 OS 外观设置 —— 浅色系统里的深色终端仍应解析为 dark。终端不应答 OSC 11
  // 时轮询自动停止，只留 $COLORFGBG 的初始猜测。
  'AUTO_THEME',
  // API content block types
  'CONNECTOR_TEXT', // Connector 文本块类型，扩展 API 内容格式
  // Attribution tracking
  'COMMIT_ATTRIBUTION', // Git 提交归属追踪（记录 AI 辅助贡献）
  // Server mode (claude server / claude open)
  // Skill search & learning — feature flags compiled in (so the slash
  // commands /skill-* etc. exist), but the runtime "enabled" toggle
  // defaults to OFF (see featureCheck.ts). Operators turn on via the
  // slash-command toggle or env vars (SKILL_SEARCH_ENABLED=1,
  // SKILL_LEARNING_ENABLED=1). Rationale: bounded caches added on
  // this branch (see docs/agent/sur-skill-overflow-bugs.md) close the
  // overflow risk, but Haiku-on-first-Chinese-query and disk-side
  // observation accumulation remain operator-discretion concerns.
  'EXPERIMENTAL_SKILL_SEARCH', // 技能搜索（bounded caches 已修复 overflow，内存问题已解决）
  'EXPERIMENTAL_SEARCH_EXTRA_TOOLS', // 工具搜索预取管道（TF-IDF 索引 + inter-turn 异步预取）
  // 'SKILL_LEARNING',
  // MCP protocol revision 2026-07-28 negotiation on the CLIENT side.
  // ON by default since 2026-08-02 (one release shipped with it off, as
  // planned). `connect()` probes with `server/discover` first (`mode:
  // 'auto'`): one extra round trip per connect (and one extra short-lived
  // child process on the SDK's stdio transport), opening the modern era
  // against servers that answer the probe. Era is a property of the
  // CONNECTION, not the build — consumers ask `getProtocolEra()`.
  // Rollback = re-comment the line below (sole gate: clientFactory.ts).
  'MCP_2026',
  // P3: poor mode
  'POOR', // 穷鬼模式，跳过 extract_memories/prompt_suggestion 减少消耗
  // SSH Remote
  'SSH_REMOTE', // SSH 远程连接，本地 REPL + 远端工具执行
  // Autofix PR
  'AUTOFIX_PR', // /autofix-pr 命令（fork 引入；docs/jira/AUTOFIX-PR-001.md 承诺默认开启）
  // Persistent thread goal command — auto-continuation, JSONL persistence,
  // strict completion/blocked audit. See src/services/goal.
  'GOAL',
  // Recover automatically when the API rejects an oversized prompt by
  // summarizing older turns and retrying with the compacted history.
  'REACTIVE_COMPACT',
] as const

/**
 * Resolve the compiled-in feature set from the defaults plus `FEATURE_<NAME>`
 * environment overrides.
 *
 * The value matters, and used to not: both `scripts/dev.ts` and
 * `scripts/vite-plugin-feature-flags.ts` previously tested only whether the
 * variable was *present*, so `FEATURE_PROACTIVE=0` and `FEATURE_PROACTIVE=false`
 * both switched the feature ON. Because the Vite plugin runs for release
 * builds, that could ship an experiment the operator had explicitly turned off.
 *
 * `1`/`true` enable, `0`/`false`/empty disable — and disabling works on
 * defaults too, which is the only way to drop a feature from a build without
 * editing DEFAULT_BUILD_FEATURES.
 */
export function resolveBuildFeatures(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const features = new Set<string>(DEFAULT_BUILD_FEATURES)
  for (const [key, rawValue] of Object.entries(env)) {
    if (!key.startsWith('FEATURE_')) continue
    const name = key.slice('FEATURE_'.length)
    if (!name) continue
    const value = (rawValue ?? '').trim().toLowerCase()
    if (value === '1' || value === 'true') features.add(name)
    else features.delete(name)
  }
  return features
}
