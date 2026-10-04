// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { expect, spyOn, test } from 'bun:test'
import * as ink from '@anthropic/ink'
import { showInvalidConfigDialog } from '../InvalidConfigDialog.js'
import { ConfigParseError } from '../../utils/runtime/errors.js'

test('a render failure rejects the invalid-config dialog instead of hanging', async () => {
  const failure = new Error('terminal renderer unavailable')
  const renderer = spyOn(ink, 'wrappedRender').mockRejectedValue(failure)
  try {
    const result = await Promise.race([
      showInvalidConfigDialog({
        error: new ConfigParseError('invalid config', '/tmp/unused.json', {}),
      }).then(
        () => 'resolved',
        error => error,
      ),
      Bun.sleep(100).then(() => 'hung'),
    ])
    expect(result).toBe(failure)
  } finally {
    renderer.mockRestore()
  }
})
