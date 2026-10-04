// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import type { UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../../../../types/message.js'

// Two ACP turns in flight at once (issue #52).
//
// #44 made every turn re-establish its session's workspace before it runs,
// which is enough while turns do not overlap — the Qianmo resident serialises
// at the node with `NodeTurnGate`, so it never overlaps them. A general ACP
// client has no such rule: ACP is JSON-RPC over stdio, several requests may be
// outstanding, and Zed's agent panel runs several threads at once. Under that
// client the re-establishment done by the second turn lands in the MIDDLE of
// the first, and the first turn finishes its work in the second one's
// workspace.
//
// So these tests do not check that a turn starts correctly. They check what
// the turn sees at every point it yields — the directory it would tell the
// model about, the file its transcript goes to — and that those answers stay
// its own from the first line of the turn to the last, while another turn for
// another workspace is running against the same process.
//
// Same discipline as workspaceIsolation.test.ts next door: no mock.module
// anywhere (Bun's is process-global and would leak into the shard), real temp
// workspaces, real CLAUDE_CONFIG_DIR, real transcript writes.

const {
  activateAcpSessionWorkspace,
  isAcpWorkspaceTurnActive,
  projectDirForSessionCwd,
  runInAcpWorkspaceTurn,
} = await import('../sessionWorkspace.js')
const { getOriginalCwd, resetStateForTests, setCwdState } = await import(
  '../../../../bootstrap/state.js'
)
const {
  clearSessionMessagesCache,
  flushSessionStorage,
  getTranscriptPath,
  recordTranscript,
  resetProjectForTesting,
} = await import('../../../../utils/sessionStorage.js')
const { computeSimpleEnvInfo } = await import(
  '../../../../constants/prompts.js'
)
const { resolveSystemPromptSections, systemPromptSection } = await import(
  '../../../../constants/systemPromptSections.js'
)

/** A session as the agent holds it: an id and the workspace it belongs to. */
type Agent = { sessionId: string; cwd: string }

/** What a turn can see about "which workspace am I in" at one instant. */
type Observation = {
  originalCwd: string
  environmentBlock: string
  transcriptPath: string
}

let configDir: string
let workspaces: string
let alpha: Agent
let beta: Agent
let originalConfigDir: string | undefined
let originalTestPersistence: string | undefined

function makeWorkspace(name: string): string {
  const dir = join(workspaces, name)
  mkdirSync(dir, { recursive: true })
  return realpathSync(dir)
}

function userMessage(uuid: string, text: string): Message {
  return {
    type: 'user',
    uuid: uuid as UUID,
    message: { role: 'user', content: text },
  } as unknown as Message
}

/** The env block the model is handed, through the cache the prompt uses. */
async function environmentBlockForTurn(): Promise<string> {
  const [envInfo] = await resolveSystemPromptSections([
    systemPromptSection('env_info_simple', () =>
      computeSimpleEnvInfo('claude-opus-5', undefined, {
        includeProductInfo: false,
      }),
    ),
  ])
  return envInfo ?? ''
}

async function observe(): Promise<Observation> {
  return {
    originalCwd: getOriginalCwd(),
    environmentBlock: await environmentBlockForTurn(),
    transcriptPath: getTranscriptPath(),
  }
}

/**
 * One turn, shaped like the real one.
 *
 * `AcpAgent.prompt` takes the workspace lock, activates the session's
 * workspace, hands the input to the query engine and then sits in
 * `forwardSessionUpdates` for as long as the model streams — a stretch of
 * many suspension points, every one of which is a chance for another request
 * to run. `steps` stands in for that stretch: the turn looks around after each
 * yield and reports what it saw.
 */
function runTurn(
  agent: Agent,
  task: string,
  steps: number,
): Promise<Observation[]> {
  return runInAcpWorkspaceTurn(async () => {
    activateAcpSessionWorkspace({
      sessionId: agent.sessionId,
      cwd: agent.cwd,
      projectDir: projectDirForSessionCwd(agent.cwd),
    })
    setCwdState(agent.cwd)

    const seen: Observation[] = [await observe()]
    for (let step = 0; step < steps; step++) {
      await Promise.resolve()
      seen.push(await observe())
    }

    await recordTranscript([userMessage(agent.sessionId, task)])
    await flushSessionStorage()
    seen.push(await observe())
    return seen
  })
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-acp-concurrent-'))
  workspaces = mkdtempSync(join(tmpdir(), 'occ-acp-concurrent-ws-'))

  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  // Project.shouldSkipPersistence() short-circuits every write under
  // NODE_ENV=test unless this opt-in is set; without it the transcript
  // assertions would compare two files that were never written.
  originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

  resetProjectForTesting()
  clearSessionMessagesCache()

  alpha = {
    sessionId: '33333333-3333-4333-8333-333333333333',
    cwd: makeWorkspace('alpha'),
  }
  beta = {
    sessionId: '44444444-4444-4444-8444-444444444444',
    cwd: makeWorkspace('beta'),
  }
})

afterEach(async () => {
  await flushSessionStorage()
  clearSessionMessagesCache()
  resetProjectForTesting()
  // runTurn() moved the process-global session (cwd, originalCwd, id, project
  // dir) into a workspace deleted below; left there, every later file in this
  // process resolves getCwd() into it. See tests/mocks/state.ts.
  resetStateForTests()

  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalTestPersistence === undefined)
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence

  rmSync(configDir, { recursive: true, force: true })
  rmSync(workspaces, { recursive: true, force: true })
})

afterAll(() => {
  resetProjectForTesting()
  clearSessionMessagesCache()
})

describe('concurrent ACP turns', () => {
  test('neither turn’s workspace moves while the other one runs', async () => {
    // Both dispatched before either finishes — exactly what a client with two
    // open threads does, and what `Promise.all` reproduces: the first turn is
    // entered, runs to its first suspension point, and the second is entered
    // while it is parked there.
    const [alphaSaw, betaSaw] = await Promise.all([
      runTurn(alpha, 'alpha task', 4),
      runTurn(beta, 'beta task', 4),
    ])

    // Every turn observes more than once, or this proves nothing about the
    // middle of a turn.
    expect(alphaSaw.length).toBeGreaterThan(4)
    expect(betaSaw.length).toBeGreaterThan(4)

    for (const seen of alphaSaw) {
      expect(seen.originalCwd).toBe(alpha.cwd)
      // What the model would be told, through the section cache that is keyed
      // by section name alone and therefore shared by every session.
      expect(seen.environmentBlock).toContain(alpha.cwd)
      expect(seen.environmentBlock).not.toContain(`directory: ${beta.cwd}`)
      expect(
        seen.transcriptPath.startsWith(projectDirForSessionCwd(alpha.cwd)),
      ).toBe(true)
    }

    for (const seen of betaSaw) {
      expect(seen.originalCwd).toBe(beta.cwd)
      expect(seen.environmentBlock).toContain(beta.cwd)
      expect(seen.environmentBlock).not.toContain(`directory: ${alpha.cwd}`)
      expect(
        seen.transcriptPath.startsWith(projectDirForSessionCwd(beta.cwd)),
      ).toBe(true)
    }
  })

  test('concurrent turns do not write into each other’s transcript', async () => {
    const [alphaSaw, betaSaw] = await Promise.all([
      runTurn(alpha, 'alpha task', 4),
      runTurn(beta, 'beta task', 4),
    ])
    await flushSessionStorage()

    const alphaTranscript = alphaSaw[alphaSaw.length - 1]?.transcriptPath ?? ''
    const betaTranscript = betaSaw[betaSaw.length - 1]?.transcriptPath ?? ''
    expect(alphaTranscript).not.toBe(betaTranscript)

    // The reads are the load-bearing part: the writer latches its file path on
    // first write, so a turn that ran while the latch belonged to the other
    // session appends there instead and leaves no file of its own at all.
    const alphaContent = await readFile(alphaTranscript, 'utf8')
    const betaContent = await readFile(betaTranscript, 'utf8')
    expect(alphaContent).toContain('alpha task')
    expect(alphaContent).not.toContain('beta task')
    expect(betaContent).toContain('beta task')
    expect(betaContent).not.toContain('alpha task')
  })

  test('turns run in the order they were dispatched, and the lock is released', async () => {
    const started: string[] = []
    const finished: string[] = []

    const turn = (agent: Agent, name: string) =>
      runInAcpWorkspaceTurn(async () => {
        started.push(name)
        activateAcpSessionWorkspace({
          sessionId: agent.sessionId,
          cwd: agent.cwd,
          projectDir: projectDirForSessionCwd(agent.cwd),
        })
        for (let step = 0; step < 3; step++) await Promise.resolve()
        finished.push(name)
      })

    const first = turn(alpha, 'alpha')
    // Dispatched while `alpha` is parked mid-turn: it must not have started.
    expect(started).toEqual(['alpha'])
    const second = turn(beta, 'beta')
    expect(started).toEqual(['alpha'])

    await Promise.all([first, second])
    expect(started).toEqual(['alpha', 'beta'])
    expect(finished).toEqual(['alpha', 'beta'])
    expect(isAcpWorkspaceTurnActive()).toBe(false)
  })

  test('a turn that throws releases the lock for the next one', async () => {
    const failing = runInAcpWorkspaceTurn(async () => {
      await Promise.resolve()
      throw new Error('turn blew up')
    })
    const queued = runInAcpWorkspaceTurn(async () => 'ran anyway')

    await expect(failing).rejects.toThrow('turn blew up')
    expect(await queued).toBe('ran anyway')
    expect(isAcpWorkspaceTurnActive()).toBe(false)
  })

  test('an uncontended turn starts without a scheduling hop', async () => {
    // The resident path must keep the interleaving it had before the lock
    // existed: with nothing else running, the body has to begin synchronously
    // rather than after a microtask.
    let entered = false
    const done = runInAcpWorkspaceTurn(async () => {
      entered = true
    })
    expect(entered).toBe(true)
    await done
  })
})
