#!/usr/bin/env bun
// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Repo-wide floor for the two-line Qianmo copyright header.
 *
 * This repository is dual-licensed: Qianmo's own code is AGPL-3.0-or-later
 * (root LICENSE), the code imported from the open-claude-code base is MIT
 * (root LICENSE.base). The authoritative test for which layer a file belongs
 * to is its *path* — whether it exists in the zero-modification base snapshot
 * tree `base-snapshot/*` (CLAUDE.md §2.5, NOTICE 一、许可). The header is a
 * *marker* of that verdict, never the verdict itself: "carries the header ⇒
 * Qianmo-owned" holds, the converse does not, and 87 files prove it.
 *
 * Charter §5.5 originally decided NOT to add a CI assertion for the header
 * ("漏加由 PR 评审兜"). That decision was taken when the rule covered 15
 * files; it now covers 647 across the whole tree, roughly 43×, and on
 * 2026-08-30 the PR-review backstop missed 66 of them in a single batch. Not
 * a fluke — the decision expired once its coverage grew two orders of
 * magnitude. Charter v2.18 reverses it; this script is that reversal.
 *
 * Three directions, all hard zero, no budget file:
 *
 *   1. Missing — a Qianmo-owned file (tracked, absent from the snapshot tree)
 *      that is not exempt and does not carry both lines in its first 5 lines.
 *   2. Misapplied — any file carrying the AGPL SPDX line that *is* in the
 *      snapshot tree, i.e. an AGPL claim stamped onto imported MIT code. This
 *      is the only machine self-check NOTICE 一、许可 has for the converse it
 *      explicitly disclaims, so it is not the optional half.
 *   3. Stamped exemption — a file on EXEMPT_PATHS that has *acquired* the
 *      mark it is exempt precisely for not carrying. Those five are exempt
 *      because adding the header would be WRONG, not because they cannot hold
 *      a comment, so the exemption has to be two-sided. Without it they sit in
 *      a blind spot: outside the snapshot tree (direction 2 skips them) and
 *      on the exempt list (direction 1 skips them), so stamping AGPL onto
 *      LICENSE.base — the verbatim upstream MIT text — passed silently, with
 *      the only symptom a quiet 87 → 86 in a count nobody watches.
 *      EXEMPT_EXTENSIONS is deliberately NOT covered by this: .json / .jpg
 *      are "cannot carry", not "must not carry".
 *
 * A ratchet would be the wrong instrument, same as in check-macro-guards.ts:
 * there is no legitimate instance to grandfather. A file either belongs to
 * the AGPL layer and says so, or it is on the exempt list with a written
 * reason. A budget number would only record how far behind we are.
 *
 * Fail-closed by construction: exemptions are a DENY list of extensions and
 * paths, never an ALLOW list of "extensions that must carry a header". The
 * candidate command that used to live in scripts/sbom.ts took the allow-list
 * shape (`.ts|.tsx|.md|.sh|Makefile`) and silently dropped 20 files — .rs,
 * .in, .toml, .yml, .service. It yields no false negative today only because
 * those 20 happen to be headered; under that shape tomorrow's unheadered .rs
 * is skipped in silence, under this one it goes red.
 *
 * The enumeration is `git ls-files` — the index, not the working tree. That
 * is the NOTICE 一、许可 criterion verbatim, and it is also the right domain:
 * an untracked file has not entered the repository yet, while pulling in
 * `--others --exclude-standard` would turn every scratch file a developer
 * leaves lying around into a red precheck — exactly the pressure that
 * corrupts an exemption table. `git add` is early enough; staged files are in
 * `ls-files`, so a new file is seen by precheck, by the pre-commit hook path
 * and by CI, all before it can be pushed. (The residual local blind spot for
 * never-staged files is documented in CONTRIBUTING, not patched here: two
 * enumeration modes would be two criteria, and local and CI would disagree
 * by design — the exact shape this repo keeps getting burned by.)
 *
 * Paths come back NUL-separated (`-z`) and are never trimmed. `-z` supersedes
 * `core.quotePath=false`: it also survives a path containing a newline, and —
 * the reason it matters here — trimming would silently rewrite a path with a
 * leading or trailing space into one that does not exist, and a path that
 * cannot be opened is a path that cannot be judged.
 *
 * The window is the first 5 lines, not lines 1–2: 45 of the 647 headers sit
 * on lines 2–3 behind a shebang. Matching is a plain substring, so all three
 * comment syntaxes in the tree work with no per-extension table — `//` (543
 * files), `#` (49), `<!-- -->` (55). Keeping it a substring is deliberate on
 * two counts: a syntax table turns three forms (and the fourth someone adds
 * later) into a list that must be maintained, and — more importantly — the
 * criterion written into NOTICE 一、许可 IS the plain substring
 * (`head -5 | grep -qa …`). A gate stricter than the document it enforces
 * would eventually disagree with it about the counts, and "the same fact in
 * two places" is what this repo has repeatedly paid for. The one addition is
 * that the two marks must land on DIFFERENT lines, which costs nothing (all
 * 647 already satisfy it) and rules out smuggling both into one string
 * literal. Measured: of the 4171 files in the snapshot tree, 0 mention the
 * SPDX string in their first 5 lines, so the false-positive surface of the
 * substring rule is presently empty.
 *
 * Division of labour with packages/activator/test/surface-invariant.test.ts —
 * DELIBERATE, not drift; do not "unify" them:
 *   · that test asserts a STRONGER per-package invariant — exactly lines 1–2,
 *     exactly the `//` form, only the non-recursive .ts under activator/src;
 *   · this script is the repo-wide FLOOR — first 5 lines, any comment syntax,
 *     path verdict plus an exemption list.
 * Collapsing the floor onto the stricter rule would reject the 104 headered
 * files that legitimately use `#` or `<!-- -->`; collapsing the stricter rule
 * onto the floor would give up the invariant activator's packaging relies on.
 *
 * The snapshot tag is REQUIRED and PINNED. sbom.ts's baseSnapshotVerdict()
 * degrades to "归属未核实" when the tag is missing, which is right for a
 * generator and wrong for a gate: a shallow or --no-tags checkout is
 * precisely where the answer is least reliable, so passing there is the worst
 * available default. No tag ⇒ exit 1 with the fetch command.
 *
 * Same file also borrows a habit from surface-invariant.test.ts's
 * `test('the scan has files to scan')`: an enumeration that comes back empty
 * (or implausibly small) is refused rather than reported as zero violations.
 * A gate that examines nothing passes everything.
 *
 * Usage:
 *   bun run scripts/check-license-headers.ts
 *   bun run scripts/check-license-headers.ts --report
 */

import { closeSync, openSync, readSync } from 'node:fs'
import { extname, join } from 'node:path'

const PROJECT_ROOT = join(import.meta.dir, '..')

const COPYRIGHT_LINE = 'Copyright 2026 Qianmo AgentNest Team'
const SPDX_LINE = 'SPDX-License-Identifier: AGPL-3.0-or-later'

/** Lines of a file the header may appear in. See the shebang note above. */
const HEADER_WINDOW_LINES = 5

/** How many offending paths to print before collapsing to a count. */
const SAMPLE_SIZE = 20

/**
 * 判据快照标签，**钉死**，不取 `git tag --list --sort=-v:refname` 的最新。
 *
 * 取最新那种写法有一个静默的失效形态：下次上游同步打出 `base-snapshot/v2.5x.0`
 * 而它**还没推到远端**时，开发机拿新标签、CI 拿旧标签，两边对「哪些文件属于
 * 基座」给出不同答案，而两边都是绿的——门禁自己换了判据却不吭声。
 *
 * 钉死之后，忘记更新这个常量的后果是**响亮且正确的失败**：门禁拿旧快照比对，
 * 把上游新文件判成阡陌自有而变红。那是一次要人来看的红，比两边静默分歧好。
 *
 * 它因此是同步回写清单上的一项。真源是 `BASE.md`「上游同步记录」里的 pin；
 * 清单本身见 `docs/dev/upstream-sync-drill.md` §7.1 第 5 条（那条列的三处
 * 「不在任何门禁视野里」的 pin 陈述——`NOTICE` 中英两块与 `README.md`——
 * 这个常量是第四处，区别是它**在**门禁视野里，改漏了会红）。
 */
const EXPECTED_SNAPSHOT_TAG = 'base-snapshot/v2.46.0'

/**
 * 枚举下限。今天是 4770 / 4171；这两个数只需要「远低于今天、远高于零」。
 *
 * 防的是「扫了个寂寞」：改名、改参数、换 cwd 都可能让 `git ls-files` 或
 * `ls-tree` 返回空集或残集，而空集的分析结果天然是零违规、退出 0。同样的护栏
 * 在 `packages/activator/test/surface-invariant.test.ts` 里叫
 * `test('the scan has files to scan')`。这类失效不是缓慢漂移，是数量级塌陷，
 * 所以下限取整不必精确，也不必随仓库增长维护。
 */
const MIN_TRACKED_FILES = 1000
const MIN_SNAPSHOT_FILES = 1000

/** 增量读文件头的块大小。见 readHeadWindow 的注释。 */
const READ_CHUNK_BYTES = 4096

/**
 * 扩展名豁免：这些格式**带不了**注释头。
 *
 * `.jpg` / `.png` / `.pdf` / `.docx` —— 二进制或纯数据格式，语法上就没有注释，
 * 无处安放这两行。
 *
 * `.json` 是**两种理由合成一条**（判定结果相同，理由必须分开记）：
 *   ① JSON 语法本身不含注释（28 个，其中 20 个是 `package.json`）——同上，
 *      加进去就是语法错误；
 *   ② `tsconfig.json` 虽然 TypeScript 按 JSONC 解析、确实接受 `//` 注释，
 *      技术上加得进去（20 个），但它们是**工具配置而非源文件**，版权头声明的是
 *      作品的许可归属，一份编译器配置不是作品。
 *
 * 这张表**不**参与「盖章」那一向的判定：它说的是「带不了」，不是「不该带」。
 * 一个 `.json` 里出现那两行是语法错误，不是许可上的虚假陈述，不归这道门禁管。
 */
const EXEMPT_EXTENSIONS = new Set(['.jpg', '.png', '.pdf', '.docx', '.json'])

/**
 * 具名豁免文件里，哪些标识**出现即判红**。
 *
 * `both` —— 版权行与 SPDX 行都不许出现。
 * `spdx` —— 只禁 SPDX 行；该文件按其自身性质**本就该**有一行阡陌版权声明。
 */
type ForbiddenMarks = 'both' | 'spdx'

/**
 * 具名豁免：形态上带得了头，但**加了才是错的**——所以这五条是**双向**的，
 * 既不要求它们带头，也禁止它们带头。逐条讲清「为什么这是对的」，不是「为什么
 * 放它一马」；每一条都要在 `NOTICE` 一、许可里有对应说明。
 */
const EXEMPT_PATHS = new Map<string, ForbiddenMarks>([
  // 基座溯源的唯一真源。仓库规矩（CLAUDE.md §2.4 / §0）是只有「导入」与
  // 「上游同步」两类事件才许改它，功能性提交一律不得触碰——补头恰恰是一次
  // 功能性提交里的顺手改动，正是那条规矩点名要挡的形态。
  // 换句话说：让门禁去逼人改 BASE.md，等于让两条约定互相打架；而反过来，
  // 谁在功能 PR 里给它加了那两行，也照样是碰了它。
  ['BASE.md', 'both'],

  // 上游 MIT 许可正文的**逐字保留件**。给它加许可头会构成虚假陈述：文件正文
  // 说的是「MIT，版权归上游」，加上去的行会说「AGPL，版权归阡陌」——两行都不
  // 许出现，版权行单独出现同样是在替上游的作品署我方的名。
  // 它按路径判据落在快照之外（快照里没有这个文件名），但它承载的是基座那一层
  // 的许可——这是「快照外 ≠ 可以盖 AGPL 头」的唯一一个真实例子，也正是这条
  // 双向豁免要挡住的那个盲区。
  ['LICENSE.base', 'both'],

  // 许可声明文件本体。**只禁 SPDX 行**：它第 2 行就是
  // `Copyright 2026 Qianmo AgentNest Team`，那是这份 NOTICE 自己的版权声明、
  // 是它该有的东西，不是漏贴上去的文件头。而那行 SPDX 标识符在它正文里被当作
  // **被引用的字符串**讲解（第 20 行讲判据时），「前 5 行」这个窗口限定正是
  // 为它而设：换成全文匹配，NOTICE 会把自己认成一个带头文件，而它是那条规则
  // 的**说明书**、不是它的实例。
  ['NOTICE', 'spdx'],

  // 生成件。它头两行就是 Cargo 自己写的注释，第二行明写
  // "It is not intended for manual editing" —— 人工加的行会在下一次
  // `cargo build` 重写这个文件时被抹掉，于是门禁会周期性地红，而每次的
  // 「修法」都是把同一行再加一遍。要求一个生成器去声明许可是没有对手的要求。
  ['packages/audio-capture-napi/native/Cargo.lock', 'both'],

  // 工具配置文件而非源文件，与 `tsconfig.json` 同一条理由：`.gitignore` 是
  // 一张路径匹配表，它不是作品，给它声明许可没有可主张的对象。
  ['packages/audio-capture-napi/native/.gitignore', 'both'],
])

export interface LicenseHeaderInputs {
  /** `git ls-files -z` 的仓库相对 POSIX 路径。 */
  tracked: readonly string[]
  /** 基座快照那棵树里的仓库相对 POSIX 路径。 */
  snapshot: ReadonlySet<string>
  /** 路径 → 文件开头的文本；缺席 = 读不到。 */
  prefixes: ReadonlyMap<string, string>
  /**
   * 读不到**且不是 ENOENT** 的路径（权限、断链、稀疏检出……）。
   *
   * 与「工作树里已不在」分开传，否则同一个文件会被报两次、而且第二次报的
   * 理由是错的：调用方已经因为读失败把它判红了，这里再说一句「文件不在了」
   * 只会让人去找一个其实躺在原地的文件。
   */
  unreadable?: ReadonlySet<string>
}

export interface StampedExemption {
  path: string
  /** 实际出现的标识，用于报错时说清是哪一行。 */
  marks: readonly string[]
}

export interface LicenseHeaderResult {
  trackedCount: number
  snapshotCount: number
  /** 跟踪文件减去快照树 = 阡陌自有。 */
  ownedCount: number
  /** 全仓前 5 行两行俱全（且分处两行）的文件数（观察值，含误贴的那些）。 */
  headeredCount: number
  /** 阡陌自有且无头的全部文件，含已豁免的。 */
  ownedWithoutHeader: readonly string[]
  /** 正向违规：阡陌自有、未豁免、无头。 */
  missingHeader: readonly string[]
  /** 因扩展名放行的无头文件。 */
  exemptByExtension: readonly string[]
  /** 因具名路径放行的无头文件。 */
  exemptByPath: readonly string[]
  /** 反向违规：带头却在快照树里。 */
  misappliedHeader: readonly string[]
  /** 第三向违规：具名豁免文件被盖了它本不该有的章。 */
  stampedExemptions: readonly StampedExemption[]
  /** ENOENT：已跟踪但工作树里不在。跳过，只报不判。 */
  missingFromWorktree: readonly string[]
}

function headerWindowLines(prefix: string): string[] {
  return prefix.split('\n').slice(0, HEADER_WINDOW_LINES)
}

/**
 * 前 5 行里两行俱全，且**分处不同的两行**。
 *
 * 子串匹配、不限注释语法、不限行号——与 `NOTICE` 一、许可成文的判据同形。
 * 「不同的两行」是唯一的加严：它挡掉把两个标识拼进同一个字符串字面量那种
 * 规避，而当前 647 个带头文件全部满足，不产生任何存量差异。
 */
export function hasQianmoHeader(prefix: string): boolean {
  const lines = headerWindowLines(prefix)
  const copyrightAt: number[] = []
  const spdxAt: number[] = []
  lines.forEach((line, index) => {
    if (line.includes(COPYRIGHT_LINE)) copyrightAt.push(index)
    if (line.includes(SPDX_LINE)) spdxAt.push(index)
  })
  return copyrightAt.some(i => spdxAt.some(j => j !== i))
}

/** 反向判据只认 SPDX 那一行：误贴的形态是「盖了 AGPL 章」。 */
export function carriesAgplSpdxLine(prefix: string): boolean {
  return headerWindowLines(prefix).some(line => line.includes(SPDX_LINE))
}

/** 具名豁免文件的前 5 行里，出现了哪些**本不该出现**的标识。 */
export function forbiddenMarksIn(
  prefix: string,
  forbidden: ForbiddenMarks,
): string[] {
  const lines = headerWindowLines(prefix)
  const found: string[] = []
  if (
    forbidden === 'both' &&
    lines.some(line => line.includes(COPYRIGHT_LINE))
  ) {
    found.push(COPYRIGHT_LINE)
  }
  if (lines.some(line => line.includes(SPDX_LINE))) found.push(SPDX_LINE)
  return found
}

export function isExemptByExtension(path: string): boolean {
  return EXEMPT_EXTENSIONS.has(extname(path).toLowerCase())
}

export function isExemptByPath(path: string): boolean {
  return EXEMPT_PATHS.has(path)
}

/**
 * 枚举本身可信吗。空集或数量级塌陷时给出理由，调用方据此红退——包括
 * `--report` 模式：一份「扫了个寂寞」的报数会被逐字引进 `NOTICE`，比没有报数糟。
 */
export function checkEnumerationSanity(
  trackedCount: number,
  snapshotCount: number,
): string[] {
  const reasons: string[] = []
  if (trackedCount < MIN_TRACKED_FILES) {
    reasons.push(
      `git ls-files 只给出 ${trackedCount} 个跟踪文件（下限 ${MIN_TRACKED_FILES}）`,
    )
  }
  if (snapshotCount < MIN_SNAPSHOT_FILES) {
    reasons.push(
      `快照树 ${EXPECTED_SNAPSHOT_TAG} 只给出 ${snapshotCount} 个文件（下限 ${MIN_SNAPSHOT_FILES}）`,
    )
  }
  return reasons
}

/**
 * 纯函数形态的全部判定，便于单测直接喂内存数据。
 * 归属只看路径是否在 `snapshot` 里；文件头只作为标记参与三个方向的计数。
 */
export function analyzeLicenseHeaders(
  inputs: LicenseHeaderInputs,
): LicenseHeaderResult {
  const ownedWithoutHeader: string[] = []
  const missingHeader: string[] = []
  const exemptByExtension: string[] = []
  const exemptByPath: string[] = []
  const misappliedHeader: string[] = []
  const stampedExemptions: StampedExemption[] = []
  const missingFromWorktree: string[] = []
  let ownedCount = 0
  let headeredCount = 0

  for (const path of inputs.tracked) {
    const prefix = inputs.prefixes.get(path)
    const owned = !inputs.snapshot.has(path)
    if (owned) ownedCount++

    if (prefix === undefined) {
      // 读失败已由调用方单独判红，不要在这里再算一次「文件不在了」。
      if (inputs.unreadable?.has(path) !== true) missingFromWorktree.push(path)
      continue
    }
    const headered = hasQianmoHeader(prefix)
    if (headered) headeredCount++

    // 第三向先判：具名豁免是双向的，这些文件既不必带头、也不许带。
    const forbidden = EXEMPT_PATHS.get(path)
    if (forbidden !== undefined) {
      const marks = forbiddenMarksIn(prefix, forbidden)
      if (marks.length > 0) stampedExemptions.push({ path, marks })
      if (owned) {
        ownedWithoutHeader.push(path)
        exemptByPath.push(path)
      }
      continue
    }

    if (!owned) {
      // 反向：基座导入件被盖了 AGPL 章。
      if (carriesAgplSpdxLine(prefix)) misappliedHeader.push(path)
      continue
    }
    if (headered) continue

    ownedWithoutHeader.push(path)
    if (isExemptByExtension(path)) {
      exemptByExtension.push(path)
    } else {
      missingHeader.push(path)
    }
  }

  return {
    trackedCount: inputs.tracked.length,
    snapshotCount: inputs.snapshot.size,
    ownedCount,
    headeredCount,
    ownedWithoutHeader,
    missingHeader,
    exemptByExtension,
    exemptByPath,
    misappliedHeader,
    stampedExemptions,
    missingFromWorktree,
  }
}

/** 跑一条 git；非零退出或 git 不可用时返回 null。照 scripts/sbom.ts。 */
function runGit(args: string[], repoRoot: string): string | null {
  try {
    const proc = Bun.spawnSync(['git', ...args], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (proc.exitCode !== 0) return null
    return proc.stdout.toString()
  } catch {
    return null
  }
}

/**
 * NUL 分隔的路径列表。**不 trim**：路径里的前导/尾随空格是路径的一部分，
 * 修掉它等于把一个存在的文件换成一个不存在的文件名。
 */
function splitNul(out: string): string[] {
  return out.split('\0').filter(path => path !== '')
}

/** 钉死的那个快照标签那棵树；标签取不到 / 不是 git 检出时返回 null。 */
export function resolveSnapshotTree(
  repoRoot: string = PROJECT_ROOT,
): string[] | null {
  const out = runGit(
    ['ls-tree', '-r', '-z', '--name-only', EXPECTED_SNAPSHOT_TAG],
    repoRoot,
  )
  return out === null ? null : splitNul(out)
}

/** 索引里的全部路径；不是 git 检出时返回 null。 */
export function resolveTrackedFiles(
  repoRoot: string = PROJECT_ROOT,
): string[] | null {
  const out = runGit(['ls-files', '-z'], repoRoot)
  return out === null ? null : splitNul(out)
}

/** 本地存在的、排在钉死标签之后的快照标签（仅用于诊断，不参与判定）。 */
function newerSnapshotTags(repoRoot: string): string[] {
  const out = runGit(
    ['tag', '--list', 'base-snapshot/*', '--sort=-v:refname'],
    repoRoot,
  )
  if (out === null) return []
  const tags = out
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const pinnedAt = tags.indexOf(EXPECTED_SNAPSHOT_TAG)
  return pinnedAt === -1 ? [] : tags.slice(0, pinnedAt)
}

type ReadOutcome =
  | { kind: 'ok'; text: string }
  | { kind: 'missing' }
  | { kind: 'error'; code: string }

function errnoOf(error: unknown): string {
  if (error !== null && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code)
  }
  return 'UNKNOWN'
}

/**
 * 文件开头的前 5 行，**按换行增量读**到第 5 个换行或文件结束为止。
 *
 * 早先这里是一个 64 KiB 的固定上限。实测当前没有任何跟踪文件的首行超过它，
 * 所以那个常数今天不出错——但它是个任意数，超过之后会静默把文件当成「无头」，
 * 而「去掉它」比「留着解释它」便宜。二进制文件里 0x0A 出现得很密（约每 256
 * 字节一个），所以 .jpg / .pdf 那批也在头一两个块内就停下，全仓一趟仍是
 * 零点几秒。
 *
 * 三种结果分开报，是因为它们该有三种处理：
 *   · ok      —— 参与判定；
 *   · missing —— ENOENT。文件已从工作树消失（`rm` 而未 `git rm`、重构删文件、
 *                切分支切一半），而 precheck 恰恰在这些时刻跑。一个不存在的
 *                文件不可能「缺头」，让它变红是拿开发者的正常中间态开刀；
 *   · error   —— 权限不足、断链、稀疏检出……这些**不是**「文件不在了」，
 *                门禁在这些情况下无从判断，静默跳过就是个洞，所以红。
 */
function readHeadWindow(absolute: string): ReadOutcome {
  let fd: number
  try {
    fd = openSync(absolute, 'r')
  } catch (error) {
    const code = errnoOf(error)
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'error', code }
  }
  try {
    const decoder = new TextDecoder('utf-8', { fatal: false })
    const chunk = new Uint8Array(READ_CHUNK_BYTES)
    let text = ''
    let newlines = 0
    let position = 0
    while (newlines < HEADER_WINDOW_LINES) {
      const read = readSync(fd, chunk, 0, READ_CHUNK_BYTES, position)
      if (read === 0) break
      position += read
      const piece = decoder.decode(chunk.subarray(0, read), { stream: true })
      text += piece
      for (const character of piece) {
        if (character === '\n') newlines++
      }
    }
    return { kind: 'ok', text }
  } catch (error) {
    return { kind: 'error', code: errnoOf(error) }
  } finally {
    closeSync(fd)
  }
}

function printSample(paths: readonly string[]): void {
  for (const path of paths.slice(0, SAMPLE_SIZE)) console.error(`  ${path}`)
  if (paths.length > SAMPLE_SIZE) {
    console.error(`  … and ${paths.length - SAMPLE_SIZE} more`)
  }
}

function extensionHistogram(paths: readonly string[]): [string, number][] {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const extension = extname(path).toLowerCase() || '(无扩展名)'
    counts.set(extension, (counts.get(extension) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function report(result: LicenseHeaderResult): void {
  const say = (line: string): void => console.log(`[license-headers] ${line}`)
  say('--report —— 只报数，不判定')
  say(`  判据标签：${EXPECTED_SNAPSHOT_TAG}`)
  say(`  基座快照树文件数：${result.snapshotCount}`)
  say(`  跟踪文件总数：${result.trackedCount}`)
  say(`  阡陌自有（快照外）：${result.ownedCount}`)
  say(`  带头文件（全仓，前 5 行两行俱全）：${result.headeredCount}`)
  say(`  阡陌自有无头：${result.ownedWithoutHeader.length}`)
  say(`    按扩展名豁免：${result.exemptByExtension.length}`)
  for (const [extension, count] of extensionHistogram(
    result.exemptByExtension,
  )) {
    say(`      ${extension} ${count}`)
  }
  say(`    按具名路径豁免：${result.exemptByPath.length}`)
  for (const path of [...result.exemptByPath].sort()) say(`      ${path}`)
  say(`    未豁免（＝正向违规）：${result.missingHeader.length}`)
  for (const path of result.missingHeader.slice(0, SAMPLE_SIZE)) {
    say(`      ${path}`)
  }
  say(`  反向判据反例（带头却在快照树里）：${result.misappliedHeader.length}`)
  for (const path of result.misappliedHeader.slice(0, SAMPLE_SIZE)) {
    say(`      ${path}`)
  }
  say(`  具名豁免文件被盖章：${result.stampedExemptions.length}`)
  for (const stamped of result.stampedExemptions.slice(0, SAMPLE_SIZE)) {
    say(`      ${stamped.path}`)
  }
  if (result.missingFromWorktree.length > 0) {
    say(`  已跟踪但工作树里不在：${result.missingFromWorktree.length}`)
  }
}

function failNoTag(): never {
  console.error(
    `[license-headers] FAIL：取不到基座快照标签 ${EXPECTED_SNAPSHOT_TAG}，无法判定归属。`,
  )
  console.error(
    '[license-headers] 归属判据是「文件在不在基座零改动快照那棵树里」',
  )
  console.error(
    '[license-headers] （CLAUDE.md §2.5、NOTICE 一、许可），没有标签就没有判据。',
  )
  console.error(
    '[license-headers] 这里不降级放行：浅克隆 / --no-tags 克隆恰恰是最容易漏头',
  )
  console.error(
    '[license-headers] 的环境，静默放行等于在最不可靠的地方给出最乐观的结论。',
  )
  console.error('[license-headers] 补拉标签（实测 .git 75M → 79M）：')
  console.error(
    "[license-headers]   git fetch --depth 1 origin 'refs/tags/base-snapshot/*:refs/tags/base-snapshot/*'",
  )
  console.error(
    '[license-headers] 若是上游同步后标签换了名：这个常量钉在本脚本的',
  )
  console.error(
    '[license-headers] EXPECTED_SNAPSHOT_TAG，属于同步回写清单的一项',
  )
  console.error('[license-headers] （docs/dev/upstream-sync-drill.md §7.1）。')
  process.exit(1)
}

function main(): void {
  const argv = process.argv.slice(2)
  const reportMode = argv.includes('--report')
  const unknown = argv.filter(arg => arg !== '--report')
  if (unknown.length > 0) {
    console.error(`[license-headers] 不认识的参数：${unknown.join(' ')}`)
    console.error(
      '[license-headers] 用法：bun run scripts/check-license-headers.ts [--report]',
    )
    process.exit(1)
  }

  const snapshotFiles = resolveSnapshotTree()
  if (snapshotFiles === null) failNoTag()
  const tracked = resolveTrackedFiles()
  if (tracked === null) {
    console.error(
      '[license-headers] FAIL：git ls-files 失败，这不是 git 检出？',
    )
    process.exit(1)
  }

  const sanity = checkEnumerationSanity(tracked.length, snapshotFiles.length)
  if (sanity.length > 0) {
    console.error('[license-headers] FAIL：枚举不可信，拒绝在空集上给出结论。')
    for (const reason of sanity) console.error(`  ${reason}`)
    console.error(
      '[license-headers] 一道扫不到东西的门禁会放行一切；这条红包括 --report',
    )
    console.error('[license-headers] 模式，因为一份扫空的报数会被引进 NOTICE。')
    process.exit(1)
  }

  const prefixes = new Map<string, string>()
  const readErrors: { path: string; code: string }[] = []
  for (const path of tracked) {
    const outcome = readHeadWindow(join(PROJECT_ROOT, path))
    if (outcome.kind === 'ok') prefixes.set(path, outcome.text)
    else if (outcome.kind === 'error') {
      readErrors.push({ path, code: outcome.code })
    }
  }

  const result = analyzeLicenseHeaders({
    tracked,
    snapshot: new Set(snapshotFiles),
    prefixes,
    unreadable: new Set(readErrors.map(entry => entry.path)),
  })

  const stale = newerSnapshotTags(PROJECT_ROOT)
  if (stale.length > 0) {
    console.log(
      `[license-headers] 注：本地还有更新的快照标签 ${stale.join(' / ')}，` +
        '而判据钉在 EXPECTED_SNAPSHOT_TAG；上游同步后请一并回写这个常量。',
    )
  }

  if (reportMode) {
    report(result)
    if (readErrors.length > 0) {
      console.log(`[license-headers]   读失败：${readErrors.length}`)
    }
    return
  }

  console.log(
    `[license-headers] 判据标签 ${EXPECTED_SNAPSHOT_TAG}；快照树 ${result.snapshotCount} 个文件，` +
      `跟踪 ${result.trackedCount} 个，阡陌自有 ${result.ownedCount} 个`,
  )

  let failed = false

  if (readErrors.length > 0) {
    failed = true
    console.error(
      `\n[license-headers] FAIL：${readErrors.length} 个已跟踪文件读不到（不是 ENOENT）`,
    )
    printSample(readErrors.map(e => `${e.path} [${e.code}]`))
    console.error(
      '[license-headers] 权限不足 / 断链 / 稀疏检出这类情况下门禁无从判断，',
    )
    console.error(
      '[license-headers] 静默跳过就是个洞。修好可读性再跑，别把它当噪声。',
    )
    console.error(
      '[license-headers] （文件已被删除是另一回事，那一类只报不判。）',
    )
  }

  if (result.missingHeader.length > 0) {
    failed = true
    console.error(
      `\n[license-headers] FAIL：${result.missingHeader.length} 个阡陌自有文件缺版权头（窗口＝文件前 5 行）`,
    )
    printSample(result.missingHeader)
    console.error('[license-headers] 两条出路，二选一：')
    console.error(
      '[license-headers]   ① 补头 —— 在文件前 5 行加上这两行（各占一行），',
    )
    console.error(
      '[license-headers]      注释语法随文件类型（// / # / <!-- --> 都认，shebang 之后也算）：',
    )
    console.error(`[license-headers]        ${COPYRIGHT_LINE}`)
    console.error(`[license-headers]        ${SPDX_LINE}`)
    console.error(
      '[license-headers]   ② 若这个文件本就带不了或不该带头，把它加进本脚本的',
    )
    console.error(
      '[license-headers]      EXEMPT_EXTENSIONS / EXEMPT_PATHS，并在 NOTICE 一、许可',
    )
    console.error(
      '[license-headers]      里写明理由 —— 两边必须同时改，只改这里等于把理由藏起来。',
    )
  }

  if (result.misappliedHeader.length > 0) {
    failed = true
    console.error(
      `\n[license-headers] FAIL：${result.misappliedHeader.length} 个文件带 AGPL 头，却在基座快照 ${EXPECTED_SNAPSHOT_TAG} 那棵树里`,
    )
    printSample(result.misappliedHeader)
    console.error(
      '[license-headers] 归属判据是路径（在不在快照树里），不是文件头；这些是上游',
    )
    console.error(
      '[license-headers] MIT 导入件，盖 AGPL 章是对许可归属的虚假陈述 —— 删掉那两行。',
    )
    console.error(
      '[license-headers] 若你确信归属判错了，要改的是 BASE.md 与成果边界快照，不是这道门禁。',
    )
  }

  if (result.stampedExemptions.length > 0) {
    failed = true
    console.error(
      `\n[license-headers] FAIL：${result.stampedExemptions.length} 个具名豁免文件被盖了它本不该有的章`,
    )
    for (const stamped of result.stampedExemptions.slice(0, SAMPLE_SIZE)) {
      console.error(`  ${stamped.path}`)
      for (const mark of stamped.marks) console.error(`    ← ${mark}`)
    }
    if (result.stampedExemptions.length > SAMPLE_SIZE) {
      console.error(
        `  … and ${result.stampedExemptions.length - SAMPLE_SIZE} more`,
      )
    }
    console.error(
      '[license-headers] EXEMPT_PATHS 里这几个是「**有意**不加头」，不是「带不了头」，',
    )
    console.error(
      '[license-headers] 所以豁免是双向的：不要求带，也不许带。给它们加许可声明会构成',
    )
    console.error(
      '[license-headers] 虚假陈述 —— NOTICE 一、许可对 LICENSE.base 的原话就是这个词：',
    )
    console.error(
      '[license-headers] 那里面是上游 MIT 许可正文的逐字保留件。删掉加上去的行。',
    )
  }

  if (result.missingFromWorktree.length > 0) {
    console.log(
      `[license-headers] 注：${result.missingFromWorktree.length} 个已跟踪文件在工作树里已不存在，已跳过（不参与判定）`,
    )
    printSample(result.missingFromWorktree)
  }

  if (failed) process.exit(1)

  console.log(
    `[license-headers] OK：阡陌自有缺头 0（另有 ${result.ownedWithoutHeader.length} 个在豁免表内），基座文件误贴 0，豁免文件被盖章 0`,
  )
}

if (import.meta.main) main()
