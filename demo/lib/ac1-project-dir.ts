// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * 打印当前 cwd 对应的会话存储目录（基座 `getProjectDir` 的口径）。
 * shell 侧要定位某个会话文件时用它，不要自己拼 sanitize 规则。
 */
import { getOriginalCwd } from '../../src/bootstrap/state.js'
import { getProjectDir } from '../../src/utils/sessionStorage/paths.js'

process.stdout.write(getProjectDir(getOriginalCwd()))
