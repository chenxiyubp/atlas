// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from 'bun:test'
import {
  parseDockerInspect,
  verifyBirthContract,
} from '../src/birth-contract.js'
import type { SandboxBirthObservation } from '../src/contracts.js'

function valid(
  overrides: Partial<SandboxBirthObservation> = {},
): SandboxBirthObservation {
  return {
    runtime: 'runsc',
    user: 'user',
    init: true,
    readOnlyRootFilesystem: true,
    securityOptions: ['no-new-privileges'],
    nanoCpus: 1,
    memoryBytes: 1,
    pidsLimit: 1,
    temporaryFilesystems: ['/tmp'],
    mounts: [{ type: 'bind', destination: '/home/user', writable: true }],
    ...overrides,
  }
}

describe('sandbox birth contract', () => {
  test('accepts runsc with a non-root user and bounded workspace mount', () => {
    expect(verifyBirthContract(valid())).toEqual({ ok: true, failures: [] })
  })

  test.each(['runc', '', 'default'])('%s is not gVisor evidence', runtime => {
    expect(verifyBirthContract(valid({ runtime })).failures).toContain(
      'runtime_not_runsc',
    )
  })

  test.each(['', '0', 'root'])('%p is a root identity', user => {
    expect(verifyBirthContract(valid({ user })).failures).toContain('root_user')
  })

  test('requires init, no-new-privileges and every resource controller', () => {
    expect(
      verifyBirthContract(
        valid({
          init: false,
          readOnlyRootFilesystem: false,
          securityOptions: [],
          nanoCpus: 0,
          memoryBytes: 0,
          pidsLimit: 0,
          temporaryFilesystems: [],
        }),
      ).failures,
    ).toEqual([
      'init_disabled',
      'root_filesystem_writable',
      'no_new_privileges_missing',
      'cpu_limit_missing',
      'memory_limit_missing',
      'pids_limit_missing',
      'temporary_filesystem_missing',
    ])
  })

  test('rejects a second writable host bind', () => {
    const result = verifyBirthContract(
      valid({
        mounts: [
          { type: 'bind', destination: '/home/user', writable: true },
          { type: 'bind', destination: '/host-control', writable: true },
        ],
      }),
    )
    expect(result.failures).toContain('unexpected_writable_mount')
  })

  test('allows /tmp tmpfs and additional read-only host references', () => {
    const result = verifyBirthContract(
      valid({
        mounts: [
          { type: 'bind', destination: '/home/user', writable: true },
          { type: 'tmpfs', destination: '/tmp', writable: true },
          { type: 'bind', destination: '/reference', writable: false },
        ],
      }),
    )
    expect(result.ok).toBe(true)
  })

  test('rejects host control sockets even when mounted read-only', () => {
    const result = verifyBirthContract(
      valid({
        mounts: [
          { type: 'bind', destination: '/home/user', writable: true },
          {
            type: 'bind',
            destination: '/var/run/docker.sock',
            writable: false,
          },
        ],
      }),
    )
    expect(result.failures).toContain('host_control_socket_mounted')
  })
})

describe('Docker inspect parser', () => {
  test('narrows only the fields the contract consumes', () => {
    const observation = parseDockerInspect([
      {
        Config: { User: 'user', Env: ['SECRET=not-consumed'] },
        HostConfig: {
          Runtime: 'runsc',
          Init: true,
          ReadonlyRootfs: true,
          SecurityOpt: ['no-new-privileges'],
          NanoCpus: 2_000_000_000,
          Memory: 2_147_483_648,
          PidsLimit: 512,
          Tmpfs: { '/tmp': 'rw,noexec,nosuid' },
        },
        Mounts: [
          {
            Type: 'bind',
            Source: '/not-retained',
            Destination: '/home/user',
            RW: true,
          },
          { Type: 'tmpfs', Destination: '/tmp', RW: true },
        ],
      },
    ])
    expect(observation).toEqual({
      runtime: 'runsc',
      user: 'user',
      init: true,
      readOnlyRootFilesystem: true,
      securityOptions: ['no-new-privileges'],
      nanoCpus: 2_000_000_000,
      memoryBytes: 2_147_483_648,
      pidsLimit: 512,
      temporaryFilesystems: ['/tmp'],
      mounts: [
        { type: 'bind', destination: '/home/user', writable: true },
        { type: 'tmpfs', destination: '/tmp', writable: true },
      ],
    })
    expect(JSON.stringify(observation)).not.toContain('SECRET')
    expect(JSON.stringify(observation)).not.toContain('not-retained')
  })

  test('malformed input becomes a failing observation, never an exception', () => {
    expect(verifyBirthContract(parseDockerInspect(null)).ok).toBe(false)
  })
})
