// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Making one ACP session's workspace the process-wide active one.
 *
 * The agent runtime keeps a single set of "current session" globals — session
 * id, session project dir, original cwd, the transcript writer's file latch,
 * and a family of caches memoised "for this conversation". A REPL process has
 * exactly one conversation for its whole life, so those globals ARE the
 * session and nobody ever had to re-establish them.
 *
 * An ACP process does not. `session/new` may be called once per workspace —
 * a Qianmo resident node opens one session per `--agent`, each in its own
 * directory — and then turns arrive for those sessions in any order. Before
 * this function existed each of those globals was written at a different
 * moment and never re-established, so a multi-session process described a
 * mixture of workspaces (issue #44):
 *
 *   • `originalCwd` was written by `createSession` and by nothing else, so the
 *     LAST session created owned the permission working-directory set
 *     (`allWorkingDirectories()`), the memory dir and the transcript project
 *     dir — for every session, including the ones in other directories.
 *   • the system-prompt section cache is keyed by section name alone, so the
 *     FIRST session to run a turn owned `env_info_simple`: every later session
 *     was told, in its own system prompt, that it was working in the first
 *     session's directory. That is the wrong cwd the node reported.
 *   • the transcript writer latches its file path on first write and only
 *     `resetSessionFilePointer()` unlatches it — which no ACP path called, so
 *     every session's transcript appended to the first session's file.
 *
 * Hence one function, called from every entry point that makes a session
 * current (`createSession`, `getOrCreateSession`, `prompt`), that
 * re-establishes all of it together. A new call site that switches sessions
 * without going through here re-opens the same class of bug.
 */
import {
  getSessionId,
  setOriginalCwd,
  switchSession,
} from '../../../bootstrap/state.js'
import { clearSystemPromptSections } from '../../../constants/systemPromptSections.js'
import { resetWorkspaceScopedContext } from '../../../context.js'
import type { SessionId } from '../../../types/ids.js'
import { getProjectDir } from '../../../utils/session/sessionStoragePortable.js'
import {
  clearSessionMetadata,
  resetSessionFilePointer,
} from '../../../utils/sessionStorage.js'

/**
 * The project directory a session's transcript belongs in, derived from the
 * session's OWN cwd.
 *
 * `switchSession(id, null)` means "derive the path from originalCwd at read
 * time", which is only the same answer when the process has one workspace.
 * Pinning it per session makes a session's transcript independent of whatever
 * else the process is serving.
 */
export function projectDirForSessionCwd(cwd: string): string {
  // NFC to match setOriginalCwd(), so a pinned dir and a derived one are the
  // same string for the same directory.
  return getProjectDir(cwd.normalize('NFC'))
}

/**
 * Point every process-global "current session" at `session`.
 *
 * Idempotent, and cheap when the session is already active: the caches are
 * only dropped when the active session actually changes, so consecutive turns
 * in one session keep the prompt cache they have always had.
 */
export function activateAcpSessionWorkspace(session: {
  sessionId: string
  cwd: string
  projectDir: string | null
}): void {
  const changed = getSessionId() !== session.sessionId

  switchSession(session.sessionId as SessionId, session.projectDir)
  setOriginalCwd(session.cwd)

  if (!changed) return

  // The transcript file path is latched on first write; unlatch it so the
  // next write derives it from the session we just switched to.
  //
  // Not awaited, and this function is deliberately synchronous: the body of
  // `resetSessionFilePointer` only nulls the latch — it is `async` for the
  // convenience of its callers, not because it waits for anything. Awaiting
  // it would put a microtask boundary between "this turn is running" and the
  // first line of the turn, which the prompt-queueing invariants are written
  // against.
  void resetSessionFilePointer()
  // The metadata cache behind it (title, tag, last prompt) belongs to the
  // session that just went inactive. `reAppendSessionMetadata` writes it to
  // whatever file is current, so leaving it would copy one agent's most
  // recent prompt into another agent's transcript.
  clearSessionMetadata()
  // Sections memoised per conversation — `env_info_simple` (which names the
  // working directory) and `memory` among them.
  clearSystemPromptSections()
  // CLAUDE.md, git state and the directory listing: memoised with no key at
  // all, so they describe whichever workspace asked first.
  resetWorkspaceScopedContext()
}

// ── The lock that makes the above safe under a concurrent client ──
//
// `activateAcpSessionWorkspace` re-establishes the process-wide workspace at
// the START of an operation and nothing re-establishes it again until the
// next one begins. That is sufficient exactly as long as operations do not
// overlap, which is what issue #52 records: two prompts in flight at once and
// the second one's activation lands in the middle of the first one's turn.
//
// ACP is JSON-RPC over stdio and a client is free to have several requests
// outstanding. The Qianmo resident never does — `NodeTurnGate` serialises at
// the node — but a general client (Zed's agent panel runs several threads,
// and `session/new` for a new thread is sent while an older thread is still
// streaming) has no reason to know it must.
//
// Two ways out. Move every global into session scope, or let only one of
// these operations own the process at a time. The first is not a bigger
// version of the same change, it is a different program: `createSession`
// alone `process.chdir()`s, calls `resetSettingsCache()` and re-applies
// settings env; a turn additionally writes the prompt id, the beta-header
// latches, the cached CLAUDE.md, the cost accumulators and the transcript
// writer's file latch. Enumerating that surface is open-ended, and each item
// missed is another silent cross-session bug of exactly the shape #44 was.
//
// So: one at a time. The cost is head-of-line blocking — `session/new` issued
// while a long turn streams waits for it — and that is the right trade against
// corrupting the running turn, which is what happens today. Concurrency WITHIN
// a session was already serialised by `session.promptRunning` + the pending
// queue, so this only extends an invariant the agent already had.
//
// The worst case of that cost is a turn parked on `session/request_permission`
// with nobody answering: it holds the lock for as long as the person takes.
// `session/cancel` is deliberately NOT gated, so the way out of it is the way
// out of any stuck turn — cancel it — and the client never has to wait on the
// lock to ask for that.
//
// Deadlock is avoided by placing the lock at the protocol entry points only —
// `newSession`, `loadSession`, `resumeSession`, `forkSession` and `prompt`,
// none of which calls another — and NOT on the internal `createSession` /
// `getOrCreateSession` helpers, which do call each other. A new entry point
// that reaches `activateAcpSessionWorkspace` must take the lock; a new
// internal helper must not.

type WorkspaceTurnWaiter = () => void

let workspaceTurnActive = false
const workspaceTurnWaiters: WorkspaceTurnWaiter[] = []

/**
 * Run `work` as the only operation owning the process-wide workspace.
 *
 * FIFO, and free of a scheduling hop when uncontended: an operation that
 * finds the lock open calls `work()` synchronously, so the single-session
 * case — every resident node, every ACP client that sends one request at a
 * time — runs exactly the interleaving it ran before this existed.
 */
export function runInAcpWorkspaceTurn<T>(work: () => Promise<T>): Promise<T> {
  if (!workspaceTurnActive) {
    workspaceTurnActive = true
    return startWorkspaceTurn(work)
  }
  return new Promise<T>((resolve, reject) => {
    workspaceTurnWaiters.push(() => {
      startWorkspaceTurn(work).then(resolve, reject)
    })
  })
}

/** True while some operation holds the workspace lock. Test seam. */
export function isAcpWorkspaceTurnActive(): boolean {
  return workspaceTurnActive
}

function startWorkspaceTurn<T>(work: () => Promise<T>): Promise<T> {
  let running: Promise<T>
  try {
    running = work()
  } catch (err) {
    // A synchronous throw out of `work` still ends this operation's turn.
    releaseWorkspaceTurn()
    return Promise.reject(err)
  }
  return running.then(
    value => {
      releaseWorkspaceTurn()
      return value
    },
    err => {
      releaseWorkspaceTurn()
      throw err
    },
  )
}

function releaseWorkspaceTurn(): void {
  const next = workspaceTurnWaiters.shift()
  if (next) {
    // Ownership passes straight to the next waiter — `workspaceTurnActive`
    // deliberately stays true so an arrival in between cannot jump the queue.
    next()
    return
  }
  workspaceTurnActive = false
}
