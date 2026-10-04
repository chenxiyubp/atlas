// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Read the value of `--name value` or `--name=value`.
 *
 * An empty value is rejected in both forms. That is not tidiness: every numeric
 * flag downstream runs `Number(value)`, and `Number('')` is `0` — so `--port=`
 * used to parse as port 0, which is a *valid* request for an ephemeral port.
 * The node would come up on a port the operator never chose and never sees in
 * the command they typed. The same hole sits under every other `Number()` here
 * (`--after-ms=`, `--backup-interval-ms=`, `--mem-interval-ms=`, the reconnect
 * factor); rejecting the empty value once closes all of them.
 */
export function residentOptionValue(
  args: readonly string[],
  index: number,
  name: string,
): { value: string; next: number } {
  const current = args[index]
  if (current?.startsWith(`${name}=`)) {
    const value = current.slice(name.length + 1)
    if (value.length === 0) throw new Error(`${name} requires a value`)
    return { value, next: index }
  }
  const next = args[index + 1]
  if (
    current !== name ||
    next === undefined ||
    next.length === 0 ||
    next.startsWith('--')
  ) {
    throw new Error(`${name} requires a value`)
  }
  return { value: next, next: index + 1 }
}
