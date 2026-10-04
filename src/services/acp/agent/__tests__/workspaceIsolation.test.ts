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

// Workspace isolation between ACP sessions (issue #44).
//
// A resident node runs ONE agent process and opens one ACP session per
// `--agent <name>=<abs cwd>`. The workspaces are supposed to be separate; what
// actually happened on beta-2 and beta-4 was that a turn addressed to the
// second agent ran with the first agent's working directory in its system
// prompt, and every session's transcript appended to one file under a third
// directory's name.
//
// So these tests are written against effects, not accessors: what the model is
// told its directory is, which file the transcript lands in, and which paths
// the permission layer will hand a tool without asking. All three are derived
// from process-global state, which is exactly why they could disagree with the
// session that asked.
//
// No mock.module anywhere: every module below loads cleanly on its own, and
// Bun's mock.module is process-global — mocking here would leak into every
// other file in the shard. Isolation comes from CLAUDE_CONFIG_DIR + real temp
// workspaces instead.

const { activateAcpSessionWorkspace, projectDirForSessionCwd } = await import(
  '../sessionWorkspace.js'
)
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
const { getEmptyToolPermissionContext } = await import('../../../../Tool.js')
const { pathInAllowedWorkingPath } = await import(
  '../../../../utils/permissions/filesystem.js'
)

/** A resident node's `--agent <name>=<cwd>` entry, once it has a session. */
type Agent = { sessionId: string; cwd: string }

let configDir: string
let workspaces: string
let nodeAgent: Agent
let opsAgent: Agent
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

/**
 * Everything `AcpAgent` does to start serving a session, minus the model.
 *
 * `createSession` pins the project dir from the session's own cwd and calls
 * `activateAcpSessionWorkspace`; `QueryEngine.submitMessage` then sets the
 * shell cwd from the same session's config. Reproduced here in that order so
 * the assertions below see the state a real turn would.
 */
function runTurnFor(agent: Agent): void {
  activateAcpSessionWorkspace({
    sessionId: agent.sessionId,
    cwd: agent.cwd,
    projectDir: projectDirForSessionCwd(agent.cwd),
  })
  setCwdState(agent.cwd)
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

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'occ-acp-isolation-'))
  workspaces = mkdtempSync(join(tmpdir(), 'occ-acp-workspaces-'))

  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  // Project.shouldSkipPersistence() short-circuits every write under
  // NODE_ENV=test unless this opt-in is set; without it the transcript
  // assertions below would compare two files that were never written.
  originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

  resetProjectForTesting()
  clearSessionMessagesCache()

  // The reported shape exactly: a node named beta-2 whose FIRST --agent is the
  // node agent (workspace `.../beta-2`) and whose second is `ops`. The bug only
  // showed on the non-first agent.
  nodeAgent = {
    sessionId: '11111111-1111-4111-8111-111111111111',
    cwd: makeWorkspace('beta-2'),
  }
  opsAgent = {
    sessionId: '22222222-2222-4222-8222-222222222222',
    cwd: makeWorkspace('ops'),
  }
})

afterEach(async () => {
  await flushSessionStorage()
  clearSessionMessagesCache()
  resetProjectForTesting()
  // runTurnFor() moved the process-global session (cwd, originalCwd, id,
  // project dir) into a workspace deleted below; left there, every later file
  // in this process resolves getCwd() into it. See tests/mocks/state.ts.
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
  // Leave no Project singleton pointing into a deleted temp tree for whichever
  // file bun loads next in this process.
  resetProjectForTesting()
  clearSessionMessagesCache()
})

describe('ACP session workspace isolation', () => {
  test('a turn for the second agent runs in the second agent’s workspace', async () => {
    // Both sessions are opened before any turn arrives — that is what
    // ResidentSessionManager.start() does for every --agent.
    runTurnFor(nodeAgent)
    const nodeEnv = await environmentBlockForTurn()
    expect(nodeEnv).toContain(nodeAgent.cwd)

    // Now the task addressed to `qianmo://beta-2/ops`.
    runTurnFor(opsAgent)
    const opsEnv = await environmentBlockForTurn()

    expect(getOriginalCwd()).toBe(opsAgent.cwd)
    expect(opsEnv).toContain(opsAgent.cwd)
    // The whole of the report: the ops turn was told it was working in the
    // node agent's directory.
    expect(opsEnv).not.toContain(`directory: ${nodeAgent.cwd}`)
  })

  test('going back to the first agent restores its workspace', async () => {
    runTurnFor(opsAgent)
    runTurnFor(nodeAgent)

    expect(getOriginalCwd()).toBe(nodeAgent.cwd)
    expect(await environmentBlockForTurn()).toContain(nodeAgent.cwd)
  })

  test('two agents do not share a transcript file', async () => {
    runTurnFor(nodeAgent)
    const nodeTranscript = getTranscriptPath()
    await recordTranscript([
      userMessage('aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', 'node agent task'),
    ])
    await flushSessionStorage()

    runTurnFor(opsAgent)
    const opsTranscript = getTranscriptPath()
    await recordTranscript([
      userMessage('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', 'ops agent task'),
    ])
    await flushSessionStorage()

    expect(opsTranscript).not.toBe(nodeTranscript)

    // Each transcript lives under its OWN workspace's project directory —
    // the reported file sat under a directory named for a workspace neither
    // session was running in.
    expect(
      nodeTranscript.startsWith(projectDirForSessionCwd(nodeAgent.cwd)),
    ).toBe(true)
    expect(
      opsTranscript.startsWith(projectDirForSessionCwd(opsAgent.cwd)),
    ).toBe(true)

    // And the turns really are separated on disk, not merely addressed to
    // different paths. The reads are load-bearing: the writer latches its file
    // on first write, so before this was fixed the ops turn appended to the
    // node session's file and this second file did not exist at all.
    const nodeContent = await readFile(nodeTranscript, 'utf8')
    const opsContent = await readFile(opsTranscript, 'utf8')
    expect(nodeContent).toContain('node agent task')
    expect(nodeContent).not.toContain('ops agent task')
    expect(opsContent).toContain('ops agent task')
    expect(opsContent).not.toContain('node agent task')
  })

  test('one agent cannot reach into the other agent’s workspace', () => {
    const context = getEmptyToolPermissionContext()
    const nodeFile = join(nodeAgent.cwd, 'notes.md')
    const opsFile = join(opsAgent.cwd, 'runbook.md')

    runTurnFor(opsAgent)
    // A resident node is unattended: nothing will answer a permission prompt,
    // so "inside an allowed working path" is the whole of what a tool gets for
    // free. It must be the asking session's workspace and only that.
    expect(pathInAllowedWorkingPath(opsFile, context)).toBe(true)
    expect(pathInAllowedWorkingPath(nodeFile, context)).toBe(false)

    runTurnFor(nodeAgent)
    expect(pathInAllowedWorkingPath(nodeFile, context)).toBe(true)
    expect(pathInAllowedWorkingPath(opsFile, context)).toBe(false)
  })
})
