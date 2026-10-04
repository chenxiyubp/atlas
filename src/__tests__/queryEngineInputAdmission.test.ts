// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QueryEngine } from '../QueryEngine.js'
import {
  resetStateForTests,
  setOriginalCwd,
  switchSession,
} from '../bootstrap/state.js'
import { getDefaultAppState } from '../state/AppStateStore.js'
import { FileStateCache } from '../utils/fileStateCache.js'
import {
  clearSessionMessagesCache,
  resetProjectForTesting,
  setSessionFileForTesting,
} from '../utils/sessionStorage.js'
import { asSessionId } from '../types/ids.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }
}

const MESSAGE_ID = '11111111-2222-4333-8444-555555555555'
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

let tempDir: string
let transcriptPath: string
let previousPersistence: string | undefined
let previousApiKey: string | undefined

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'query-engine-admission-'))
  transcriptPath = join(tempDir, 'session.jsonl')
  await mkdir(join(tempDir, 'project'), { recursive: true })
  previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  previousApiKey = process.env.ANTHROPIC_API_KEY
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  process.env.ANTHROPIC_API_KEY = 'test-query-engine-admission'
  resetStateForTests()
  setOriginalCwd(join(tempDir, 'project'))
  switchSession(asSessionId(SESSION_ID))
  resetProjectForTesting()
  setSessionFileForTesting(transcriptPath)
  clearSessionMessagesCache()
})

afterEach(async () => {
  resetProjectForTesting()
  clearSessionMessagesCache()
  resetStateForTests()
  if (previousPersistence === undefined) {
    delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  } else {
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
  }
  if (previousApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY
  } else {
    process.env.ANTHROPIC_API_KEY = previousApiKey
  }
  await rm(tempDir, { recursive: true, force: true })
})

describe('QueryEngine input admission', () => {
  test('runs the callback only after the client UUID is durable', async () => {
    let appState = getDefaultAppState()
    let persistedAtCallback = false
    const engine = new QueryEngine({
      cwd: join(tempDir, 'project'),
      tools: [],
      commands: [],
      mcpClients: [],
      agents: [],
      canUseTool: async (_tool, input) => ({
        behavior: 'allow',
        updatedInput: input,
      }),
      getAppState: () => appState,
      setAppState: updater => {
        appState = updater(appState)
      },
      readFileCache: new FileStateCache(10, 1024 * 1024),
      onInputAccepted: async ({ uuid }) => {
        const transcript = await readFile(transcriptPath, 'utf8')
        persistedAtCallback =
          uuid === MESSAGE_ID && transcript.includes(MESSAGE_ID)
      },
    })

    const iterator = engine.submitMessage('accepted input', {
      uuid: MESSAGE_ID,
    })
    await iterator.next()

    expect(persistedAtCallback).toBe(true)
    await iterator.return()
  })
})
