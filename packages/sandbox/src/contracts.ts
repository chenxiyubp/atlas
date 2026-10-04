// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

export const REQUIRED_RUNTIME = 'runsc' as const
export const WORKSPACE_MOUNT = '/home/user' as const

export interface SandboxMountObservation {
  readonly type: string
  readonly destination: string
  readonly writable: boolean
}

export interface SandboxBirthObservation {
  readonly runtime: string
  readonly user: string
  readonly init: boolean
  readonly readOnlyRootFilesystem: boolean
  readonly securityOptions: readonly string[]
  readonly nanoCpus: number
  readonly memoryBytes: number
  readonly pidsLimit: number
  readonly temporaryFilesystems: readonly string[]
  readonly mounts: readonly SandboxMountObservation[]
}

export type BirthContractFailure =
  | 'runtime_not_runsc'
  | 'root_user'
  | 'init_disabled'
  | 'root_filesystem_writable'
  | 'no_new_privileges_missing'
  | 'cpu_limit_missing'
  | 'memory_limit_missing'
  | 'pids_limit_missing'
  | 'temporary_filesystem_missing'
  | 'unexpected_writable_tmpfs'
  | 'workspace_mount_missing'
  | 'unexpected_writable_mount'
  | 'host_control_socket_mounted'

export interface BirthContractResult {
  readonly ok: boolean
  readonly failures: readonly BirthContractFailure[]
}

export type SandboxWriteTarget = 'outside_workspace' | 'readonly_host_reference'

export type SandboxAuditInput =
  | {
      readonly kind: 'runtime.attested'
      readonly at: number
      readonly sandboxName: string
    }
  | {
      readonly kind: 'runtime.noncompliant'
      readonly at: number
      readonly sandboxName: string
      readonly failures: readonly BirthContractFailure[]
    }
  | {
      readonly kind: 'filesystem.write_denied'
      readonly at: number
      readonly sandboxName: string
      readonly target: 'outside_workspace'
      readonly exitCode: number
    }
  | {
      readonly kind: 'filesystem.write_denied'
      readonly at: number
      readonly sandboxName: string
      readonly target: 'readonly_host_reference'
      readonly exitCode: number
      readonly hostUnchanged: true
    }
  | {
      readonly kind: 'execution.timeout_enforced'
      readonly at: number
      readonly sandboxName: string
      readonly exitCode: 137
      readonly timeoutSeconds: number
    }
  | {
      readonly kind: 'resource.cpu_throttled'
      readonly at: number
      readonly sandboxName: string
      readonly nrThrottledBefore: number
      readonly nrThrottledAfter: number
    }
  | {
      readonly kind: 'resource.memory_oom_killed'
      readonly at: number
      readonly sandboxName: string
      readonly oomKillBefore: number
      readonly oomKillAfter: number
    }

export type SandboxAuditEvent = SandboxAuditInput & {
  readonly eventId: string
}

export interface SandboxAuditIntegrityIssue {
  readonly line: number
  readonly kind: 'corrupt_line' | 'torn_tail'
}

export interface SandboxAuditQueryResult {
  readonly events: readonly SandboxAuditEvent[]
  readonly integrityIssues: readonly SandboxAuditIntegrityIssue[]
}
