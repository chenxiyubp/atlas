// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  type BirthContractFailure,
  type BirthContractResult,
  REQUIRED_RUNTIME,
  type SandboxBirthObservation,
  type SandboxMountObservation,
  WORKSPACE_MOUNT,
} from './contracts.js'

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function boolean(value: unknown): boolean {
  return value === true
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(v => typeof v === 'string') : []
}

function keys(value: unknown): string[] {
  return Object.keys(record(value) ?? {})
}

function mounts(value: unknown): SandboxMountObservation[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(candidate => {
    const mount = record(candidate)
    if (mount === undefined) return []
    return [
      {
        type: string(mount.Type),
        destination: string(mount.Destination),
        writable: boolean(mount.RW),
      },
    ]
  })
}

export function parseDockerInspect(value: unknown): SandboxBirthObservation {
  const candidate = Array.isArray(value) ? value[0] : value
  const inspected = record(candidate)
  const config = record(inspected?.Config)
  const host = record(inspected?.HostConfig)
  return {
    runtime: string(host?.Runtime),
    user: string(config?.User),
    init: boolean(host?.Init),
    readOnlyRootFilesystem: boolean(host?.ReadonlyRootfs),
    securityOptions: strings(host?.SecurityOpt),
    nanoCpus: number(host?.NanoCpus),
    memoryBytes: number(host?.Memory),
    pidsLimit: number(host?.PidsLimit),
    temporaryFilesystems: keys(host?.Tmpfs),
    mounts: mounts(inspected?.Mounts),
  }
}

function isRootUser(user: string): boolean {
  const normalized = user.trim().toLowerCase()
  return normalized === '' || normalized === '0' || normalized === 'root'
}

export function verifyBirthContract(
  observation: SandboxBirthObservation,
): BirthContractResult {
  const failures: BirthContractFailure[] = []
  if (observation.runtime !== REQUIRED_RUNTIME)
    failures.push('runtime_not_runsc')
  if (isRootUser(observation.user)) failures.push('root_user')
  if (!observation.init) failures.push('init_disabled')
  if (!observation.readOnlyRootFilesystem)
    failures.push('root_filesystem_writable')
  if (!observation.securityOptions.includes('no-new-privileges'))
    failures.push('no_new_privileges_missing')
  if (observation.nanoCpus <= 0) failures.push('cpu_limit_missing')
  if (observation.memoryBytes <= 0) failures.push('memory_limit_missing')
  if (observation.pidsLimit <= 0) failures.push('pids_limit_missing')
  if (!observation.temporaryFilesystems.includes('/tmp'))
    failures.push('temporary_filesystem_missing')
  if (observation.temporaryFilesystems.some(path => path !== '/tmp'))
    failures.push('unexpected_writable_tmpfs')

  const workspace = observation.mounts.find(
    mount => mount.type === 'bind' && mount.destination === WORKSPACE_MOUNT,
  )
  if (workspace?.writable !== true) failures.push('workspace_mount_missing')
  if (
    observation.mounts.some(
      mount =>
        mount.writable &&
        !(
          (mount.type === 'bind' && mount.destination === WORKSPACE_MOUNT) ||
          (mount.type === 'tmpfs' && mount.destination === '/tmp')
        ),
    )
  ) {
    failures.push('unexpected_writable_mount')
  }
  if (observation.mounts.some(mount => mount.destination.endsWith('.sock'))) {
    failures.push('host_control_socket_mounted')
  }

  return { ok: failures.length === 0, failures }
}
