// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `occ console` 的参数面与四个端口的生产实现。
 *
 * **零 `mock.module`**：注册中心那一半跑的是真的 `startRegistryServer(0)`
 * （绑随机端口，测完 stop），审计那一半写的是真的审计链文件。仓库对内联
 * `mock.module` 是零容忍棘轮，而这里也确实不需要——两个依赖都能便宜地起真的，
 * 假的那一份反倒测不出「地址有没有正确地百分号编码进单个 path segment」这类
 * 只有真服务端才会计较的事。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditSource, AuditTrail, readTrail } from '@qianmo/audit'
import {
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
} from '@qianmo/capability'
import {
  AuditWitnessScheduler,
  FileWitnessAnchorStore,
  remoteWitnessAnchorReader,
  remoteWitnessAnchorWriter,
  startWitnessService,
} from '@qianmo/witness'
import { LIMITS, MAX_SEGMENT_LENGTH } from '@qianmo/protocol'
import {
  DEFAULT_TTL_MS,
  startRegistryServer,
  type RegistryServerHandle,
} from '@qianmo/registry'
import { RUNTIME_RATE } from '@qianmo/router'
import { auditTrailPath } from '../../../services/qianmo/auditTrail.js'
import {
  CONSOLE_HELP_TEXT,
  DEFAULT_CONSOLE_CHAT_FROM,
  DEFAULT_CONSOLE_HOSTNAME,
  DEFAULT_CONSOLE_PORT,
  DEFAULT_CONSOLE_REGISTRY_URL,
  MAX_CONSOLE_LABEL_LENGTH,
  MAX_CONSOLE_SERVER_ID_LENGTH,
  DEFAULT_CONSOLE_NODE,
  assertConsoleRuntime,
  consoleChatStorePath,
  consoleServerNotesPath,
  isConsoleHelpRequest,
  parseConsoleArgs,
  transportPskEnvVarForNode,
} from '../consoleArgs.js'
import {
  ADMIN_TOKEN_ENV_VAR,
  VIEW_TOKEN_ENV_VAR,
} from '../consoleTokenSources.js'
import {
  DEFAULT_AUDIT_LIMIT,
  consoleLimits,
  createAuditPort,
  createRegistryPort,
} from '../consolePorts.js'

describe('occ console argument parsing', () => {
  test('runs on the loopback demo ports with no arguments at all', () => {
    expect(parseConsoleArgs([], 'qianmo')).toEqual({
      port: DEFAULT_CONSOLE_PORT,
      hostname: DEFAULT_CONSOLE_HOSTNAME,
      registryUrl: DEFAULT_CONSOLE_REGISTRY_URL,
      auditTargets: [{ node: DEFAULT_CONSOLE_NODE, path: auditTrailPath() }],
      auditMirrors: [],
      wakeTargets: [],
      label: `${DEFAULT_CONSOLE_HOSTNAME}:${DEFAULT_CONSOLE_PORT}`,
      // 聊天面默认关着：没有 --chat-url 就没有可拨的端点，`/chat` 整页不存在。
      chatTargets: [],
      chatFrom: DEFAULT_CONSOLE_CHAT_FROM,
      chatStorePath: consoleChatStorePath(),
      // 归属面同理：没有 --node-server 就整块不显示，而不是显示一列空白。
      nodeServers: [],
      serverNotesPath: consoleServerNotesPath(),
    })
  })

  test('derives the transcript path from the config root, never from $HOME', () => {
    // CLAUDE.md §1.1②：身份相关路径只能从 `paths.ts` 派生，否则 OCC_CONFIG_DIR
    // 对它无效——演示拓扑给每个进程一个配置根，转录也必须跟着分家。
    const path = consoleChatStorePath()
    expect(path.endsWith('/qianmo/console/chat.ndjson')).toBe(true)
    expect(parseConsoleArgs([], 'qianmo').chatStorePath).toBe(path)
  })

  test('keeps 38613 clear of the three ports demo-env.md §2.4 assigns', () => {
    // 38610 注册中心 / 38611 节点 A / 38612 节点 B —— 控制台要能和整套演示
    // 拓扑同时起在一台机器上。
    expect([38_610, 38_611, 38_612]).not.toContain(DEFAULT_CONSOLE_PORT)
  })

  test('accepts every option in both --x value and --x=value form', () => {
    const split = parseConsoleArgs(
      [
        '--port',
        '39000',
        '--hostname',
        '0.0.0.0',
        '--registry',
        'http://10.0.0.2:38610',
        '--audit',
        '/tmp/qianmo/trail.ndjson',
        '--anchors',
        '/tmp/qianmo/witness',
        '--trust',
        'node-a=11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        '--registry-token-file',
        '/tmp/qianmo/registry-token',
        '--wake-url',
        'ws://10.0.0.3:38611',
        '--label',
        'node-a 控制台',
        '--view-token',
        'view-token-long-enough',
        '--admin-token',
        'admin-token-long-enough',
        '--chat-url',
        'ws://10.0.0.3:38611',
        '--chat-url',
        'ws://10.0.0.4:38612',
        '--chat-from',
        'qianmo://ops/alice',
        '--chat-store',
        '/tmp/qianmo/chat.ndjson',
        '--node-server',
        'node-a=p11',
        '--server-notes',
        '/tmp/qianmo/server-notes.ndjson',
      ],
      'qianmo',
    )
    const joined = parseConsoleArgs(
      [
        '--port=39000',
        '--hostname=0.0.0.0',
        '--registry=http://10.0.0.2:38610',
        '--audit=/tmp/qianmo/trail.ndjson',
        '--anchors=/tmp/qianmo/witness',
        '--trust=node-a=11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        '--registry-token-file=/tmp/qianmo/registry-token',
        '--wake-url=ws://10.0.0.3:38611',
        '--label=node-a 控制台',
        '--view-token=view-token-long-enough',
        '--admin-token=admin-token-long-enough',
        '--chat-url=ws://10.0.0.3:38611',
        '--chat-url=ws://10.0.0.4:38612',
        '--chat-from=qianmo://ops/alice',
        '--chat-store=/tmp/qianmo/chat.ndjson',
        '--node-server=node-a=p11',
        '--server-notes=/tmp/qianmo/server-notes.ndjson',
      ],
      'qianmo',
    )

    expect(split).toEqual(joined)
    expect(split).toEqual({
      port: 39_000,
      hostname: '0.0.0.0',
      registryUrl: 'http://10.0.0.2:38610',
      auditTargets: [
        { node: DEFAULT_CONSOLE_NODE, path: '/tmp/qianmo/trail.ndjson' },
      ],
      auditMirrors: [],
      anchors: { kind: 'path', value: '/tmp/qianmo/witness' },
      trusted: [['node-a', '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo']],
      registryTokenFile: '/tmp/qianmo/registry-token',
      wakeTargets: [
        {
          node: DEFAULT_CONSOLE_NODE,
          url: 'ws://10.0.0.3:38611/',
          legacy: true,
        },
      ],
      label: 'node-a 控制台',
      viewToken: 'view-token-long-enough',
      adminToken: 'admin-token-long-enough',
      chatTargets: [
        {
          node: DEFAULT_CONSOLE_NODE,
          url: 'ws://10.0.0.3:38611/',
          legacy: true,
        },
        {
          node: DEFAULT_CONSOLE_NODE,
          url: 'ws://10.0.0.4:38612/',
          legacy: true,
        },
      ],
      chatFrom: 'qianmo://ops/alice',
      chatStorePath: '/tmp/qianmo/chat.ndjson',
      nodeServers: [{ node: 'node-a', server: 'p11' }],
      serverNotesPath: '/tmp/qianmo/server-notes.ndjson',
    })
  })

  test('takes --chat-url more than once and folds a repeat', () => {
    // 同一个端点给两次是复制粘贴，不是「建两条链路」。
    expect(
      parseConsoleArgs(
        [
          '--chat-url=ws://127.0.0.1:38611',
          '--chat-url=ws://127.0.0.1:38611/',
          '--chat-url=ws://127.0.0.1:38612',
        ],
        'qianmo',
      ).chatTargets,
    ).toEqual([
      {
        node: DEFAULT_CONSOLE_NODE,
        url: 'ws://127.0.0.1:38611/',
        legacy: true,
      },
      {
        node: DEFAULT_CONSOLE_NODE,
        url: 'ws://127.0.0.1:38612/',
        legacy: true,
      },
    ])
  })

  test('takes named chat targets and keeps them bound to their node', () => {
    expect(
      parseConsoleArgs(
        [
          '--chat-url=beta-1=ws://127.0.0.1:38631',
          '--chat-url=beta-2=ws://127.0.0.1:38632',
          // 同一条给两遍仍然是复制粘贴。
          '--chat-url=beta-2=ws://127.0.0.1:38632/',
        ],
        'qianmo',
      ).chatTargets,
    ).toEqual([
      { node: 'beta-1', url: 'ws://127.0.0.1:38631/', legacy: false },
      { node: 'beta-2', url: 'ws://127.0.0.1:38632/', legacy: false },
    ])
  })

  test('refuses to mix legacy chat URLs with named ones', () => {
    // 两种形式的 PSK 来源不同（共享的一把 vs 每节点一把），混着给意味着这台
    // 控制台一半绑了节点一半没绑——没有哪种读法是对的。
    expect(() =>
      parseConsoleArgs(
        [
          '--chat-url=ws://127.0.0.1:38611',
          '--chat-url=beta-1=ws://127.0.0.1:38631',
        ],
        'qianmo',
      ),
    ).toThrow('--chat-url cannot mix legacy URLs with named values')
    expect(() =>
      parseConsoleArgs(
        [
          '--chat-url=beta-1=ws://127.0.0.1:38631',
          '--chat-url=ws://127.0.0.1:38611',
        ],
        'qianmo',
      ),
    ).toThrow('--chat-url cannot mix legacy URLs with named values')
  })

  test('one node has one chat endpoint, and one endpoint has one node', () => {
    expect(() =>
      parseConsoleArgs(
        [
          '--chat-url=beta-1=ws://127.0.0.1:38631',
          '--chat-url=beta-1=ws://127.0.0.1:38632',
        ],
        'qianmo',
      ),
    ).toThrow('--chat-url repeats node beta-1')
    // 反过来也不行：PSK 按节点取，一个端点挂两个名字就没有唯一的钥匙。
    expect(() =>
      parseConsoleArgs(
        [
          '--chat-url=beta-1=ws://127.0.0.1:38631',
          '--chat-url=beta-2=ws://127.0.0.1:38631',
        ],
        'qianmo',
      ),
    ).toThrow(
      '--chat-url gives ws://127.0.0.1:38631/ to both beta-1 and beta-2',
    )
  })

  test('rejects a chat endpoint that is not ws or wss', () => {
    expect(() =>
      parseConsoleArgs(['--chat-url=http://127.0.0.1:38611'], 'qianmo'),
    ).toThrow('--chat-url must use ws or wss')
    expect(() =>
      parseConsoleArgs(['--chat-url=beta-1=http://127.0.0.1:38631'], 'qianmo'),
    ).toThrow('--chat-url must use ws or wss')
    expect(() =>
      parseConsoleArgs(['--chat-store=relative/chat.ndjson'], 'qianmo'),
    ).toThrow('--chat-store must be an absolute path')
    expect(() => parseConsoleArgs(['--chat-from=  '], 'qianmo')).toThrow(
      '--chat-from must not be empty',
    )
  })

  test('strips the trailing slash so /v0/agents never doubles up', () => {
    expect(
      parseConsoleArgs(['--registry=http://127.0.0.1:38610/'], 'qianmo')
        .registryUrl,
    ).toBe('http://127.0.0.1:38610')
  })

  test('defaults the header label to the address it is bound to', () => {
    expect(
      parseConsoleArgs(['--port=39001', '--hostname=127.0.0.5'], 'qianmo')
        .label,
    ).toBe('127.0.0.5:39001')
  })

  test('requires the Qianmo identity', () => {
    expect(() => parseConsoleArgs([], 'occ')).toThrow('OCC_IDENTITY=qianmo')
  })

  test('takes the whole legal port range and nothing outside it', () => {
    expect(parseConsoleArgs(['--port=0'], 'qianmo').port).toBe(0)
    expect(parseConsoleArgs(['--port=65535'], 'qianmo').port).toBe(65_535)
    for (const bad of ['-1', '65536', '1.5', 'abc', '']) {
      expect(() => parseConsoleArgs([`--port=${bad}`], 'qianmo')).toThrow(
        '--port',
      )
    }
  })

  test('rejects protocols that the two URL options cannot mean', () => {
    expect(() =>
      parseConsoleArgs(['--registry=ws://127.0.0.1:38610'], 'qianmo'),
    ).toThrow('--registry must use http or https')
    expect(() =>
      parseConsoleArgs(['--wake-url=http://127.0.0.1:38611'], 'qianmo'),
    ).toThrow('--wake-url must use ws or wss')
    expect(() => parseConsoleArgs(['--registry=not-a-url'], 'qianmo')).toThrow()
  })

  test('insists the trail path is absolute', () => {
    expect(() =>
      parseConsoleArgs(['--audit=relative/trail.ndjson'], 'qianmo'),
    ).toThrow('--audit must be an absolute path')
  })

  test('accepts independent named audit sources and explicit mirror metadata', () => {
    expect(
      parseConsoleArgs(
        [
          '--audit=beta-1=/var/lib/qianmo/beta-1/trail.ndjson',
          '--audit=beta_2=/var/lib/qianmo/beta-2/trail.ndjson',
          '--audit-mirror=beta_2=5',
        ],
        'qianmo',
      ),
    ).toMatchObject({
      auditTargets: [
        { node: 'beta-1', path: '/var/lib/qianmo/beta-1/trail.ndjson' },
        { node: 'beta_2', path: '/var/lib/qianmo/beta-2/trail.ndjson' },
      ],
      auditMirrors: [{ node: 'beta_2', maxLagMinutes: 5 }],
    })
  })

  test('splits named audit paths once while preserving legacy paths with =', () => {
    expect(
      parseConsoleArgs(['--audit=/tmp/a=b'], 'qianmo').auditTargets,
    ).toEqual([{ node: DEFAULT_CONSOLE_NODE, path: '/tmp/a=b' }])
    expect(
      parseConsoleArgs(['--audit=beta-1=/tmp/a=b'], 'qianmo').auditTargets,
    ).toEqual([{ node: 'beta-1', path: '/tmp/a=b' }])
  })

  test('rejects ambiguous or malformed named audit inputs', () => {
    for (const args of [
      ['--audit==/tmp/trail.ndjson'],
      ['--audit=beta-1='],
      ['--audit=beta-1=relative/trail.ndjson'],
      ['--audit=beta-1=/tmp/a', '--audit=beta-1=/tmp/b'],
      ['--audit=/tmp/a', '--audit=beta-2=/tmp/b'],
      ['--audit-mirror=beta-2=5'],
      ['--audit=beta-2=/tmp/a', '--audit-mirror=beta-2=0'],
    ]) {
      expect(() => parseConsoleArgs(args, 'qianmo')).toThrow('--audit')
    }
  })

  test('rejects duplicate resolved audit paths across distinct nodes', () => {
    for (const args of [
      ['--audit=beta-1=/tmp/trail', '--audit=beta-2=/tmp/trail'],
      ['--audit=beta-1=/tmp/a/../trail', '--audit=beta-2=/tmp/trail'],
    ]) {
      expect(() => parseConsoleArgs(args, 'qianmo')).toThrow(
        '--audit repeats path',
      )
    }
  })

  test('keeps legacy wake URL while accepting named wake allowlists', () => {
    expect(
      parseConsoleArgs(['--wake-url=ws://127.0.0.1:38611'], 'qianmo')
        .wakeTargets,
    ).toEqual([
      {
        node: DEFAULT_CONSOLE_NODE,
        url: 'ws://127.0.0.1:38611/',
        legacy: true,
      },
    ])
    expect(
      parseConsoleArgs(
        [
          '--wake-url=beta-1=ws://127.0.0.1:38611',
          '--wake-url=beta_1=ws://127.0.0.1:38612',
        ],
        'qianmo',
      ).wakeTargets,
    ).toEqual([
      { node: 'beta-1', url: 'ws://127.0.0.1:38611/', legacy: false },
      { node: 'beta_1', url: 'ws://127.0.0.1:38612/', legacy: false },
    ])
  })

  test('splits named wake URLs once while preserving legacy URLs with =', () => {
    expect(
      parseConsoleArgs(['--wake-url=ws://host/path?token=a=b'], 'qianmo')
        .wakeTargets,
    ).toEqual([
      {
        node: DEFAULT_CONSOLE_NODE,
        url: 'ws://host/path?token=a=b',
        legacy: true,
      },
    ])
    expect(
      parseConsoleArgs(['--wake-url=beta-1=ws://host/path?token=a=b'], 'qianmo')
        .wakeTargets,
    ).toEqual([
      {
        node: 'beta-1',
        url: 'ws://host/path?token=a=b',
        legacy: false,
      },
    ])
  })

  test('rejects duplicate, mixed, and malformed named wake URLs', () => {
    for (const args of [
      [
        '--wake-url=beta-1=ws://127.0.0.1:38611',
        '--wake-url=beta-1=ws://127.0.0.1:38612',
      ],
      [
        '--wake-url=ws://127.0.0.1:38611',
        '--wake-url=beta-2=ws://127.0.0.1:38612',
      ],
      ['--wake-url==ws://127.0.0.1:38611'],
      ['--wake-url=beta-2='],
      ['--wake-url=beta-2=http://127.0.0.1:38611'],
    ]) {
      expect(() => parseConsoleArgs(args, 'qianmo')).toThrow('--wake-url')
    }
  })

  test('derives a one-to-one portable PSK variable for each wake node', () => {
    expect(transportPskEnvVarForNode('beta-1')).toBe(
      'QIANMO_TRANSPORT_PSK_NODE_626574612D31',
    )
    expect(transportPskEnvVarForNode('node-a')).toBe(
      'QIANMO_TRANSPORT_PSK_NODE_6E6F64652D61',
    )
    expect(transportPskEnvVarForNode('node-b')).toBe(
      'QIANMO_TRANSPORT_PSK_NODE_6E6F64652D62',
    )
    expect(
      new Set(
        ['beta-1', 'beta_1', 'beta1', 'b-1'].map(node =>
          transportPskEnvVarForNode(node),
        ),
      ).size,
    ).toBe(4)
  })

  test('uses the protocol grammar for every named console node', () => {
    const valid = 'a' + 'b'.repeat(MAX_SEGMENT_LENGTH - 2) + '9'
    expect(valid).toHaveLength(MAX_SEGMENT_LENGTH)
    expect(
      parseConsoleArgs([`--audit=${valid}=/tmp/trail`], 'qianmo').auditTargets,
    ).toEqual([{ node: valid, path: '/tmp/trail' }])

    for (const node of [
      'Beta-1',
      'beta.1',
      'a' + 'b'.repeat(MAX_SEGMENT_LENGTH),
    ]) {
      expect(() =>
        parseConsoleArgs([`--audit=${node}=/tmp/trail`], 'qianmo'),
      ).toThrow('protocol segment')
      expect(() =>
        parseConsoleArgs([`--wake-url=${node}=ws://127.0.0.1:38611`], 'qianmo'),
      ).toThrow('protocol segment')
    }
  })

  test('accepts only an absolute anchor directory or HTTP(S) endpoint', () => {
    const trust = '--trust=node-a=11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'
    expect(
      parseConsoleArgs(['--anchors=/tmp/qianmo/witness', trust], 'qianmo'),
    ).toMatchObject({ anchors: { kind: 'path', value: '/tmp/qianmo/witness' } })
    expect(
      parseConsoleArgs(
        ['--anchors=https://witness.example/v0', trust],
        'qianmo',
      ),
    ).toMatchObject({
      anchors: { kind: 'url', value: 'https://witness.example/v0' },
    })
    expect(() =>
      parseConsoleArgs(['--anchors=relative/witness', trust], 'qianmo'),
    ).toThrow('absolute path or http(s) URL')
  })

  test('--anchors needs a key source established on this side (K-11 F-3)', () => {
    expect(() =>
      parseConsoleArgs(['--anchors=/tmp/qianmo/witness'], 'qianmo'),
    ).toThrow('--anchors needs --trust <node>=<publicKey> or --trust-ca')
    expect(
      parseConsoleArgs(
        ['--anchors=/tmp/qianmo/witness', '--trust-ca=/etc/qianmo/ca.pem'],
        'qianmo',
      ),
    ).toMatchObject({ trustCa: '/etc/qianmo/ca.pem' })
  })

  test('--trust folds a repeat and refuses two keys for one node', () => {
    const other = 'hgyY0il_MGCjP0JzlnLWG1PPOt7-09PGcvMg3AIbQR8'
    expect(
      parseConsoleArgs(
        [
          '--trust',
          'node-a=11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
          '--trust=node-a=11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
          '--trust',
          `node-b=${other}`,
        ],
        'qianmo',
      ).trusted,
    ).toEqual([
      ['node-a', '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo'],
      ['node-b', other],
    ])
    expect(() =>
      parseConsoleArgs(
        [
          '--trust',
          'node-a=11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
          '--trust',
          `node-a=${other}`,
        ],
        'qianmo',
      ),
    ).toThrow('--trust gives node node-a two different keys')
    expect(() =>
      parseConsoleArgs(['--trust', 'node-a=nope'], 'qianmo'),
    ).toThrow('valid Ed25519 key')
  })

  test('--registry-token-file must be absolute, and neither new key appears unless given', () => {
    expect(() =>
      parseConsoleArgs(['--registry-token-file', 'token'], 'qianmo'),
    ).toThrow('--registry-token-file must be an absolute path')
    const plain = parseConsoleArgs([], 'qianmo')
    expect('trusted' in plain).toBe(false)
    expect('registryTokenFile' in plain).toBe(false)
  })

  test('rejects blank and oversized labels and blank tokens', () => {
    expect(() => parseConsoleArgs(['--label=   '], 'qianmo')).toThrow(
      '--label must not be empty',
    )
    expect(() =>
      parseConsoleArgs(
        [`--label=${'x'.repeat(MAX_CONSOLE_LABEL_LENGTH + 1)}`],
        'qianmo',
      ),
    ).toThrow('--label must be at most')
    expect(() => parseConsoleArgs(['--view-token=  '], 'qianmo')).toThrow(
      '--view-token must not be empty',
    )
  })

  test('names an unknown option rather than ignoring it', () => {
    expect(() => parseConsoleArgs(['--registy=x'], 'qianmo')).toThrow(
      'unknown console option --registy=x',
    )
    // 走到这一支的人多半是拼错了选项名，所以顺手指一下那张表在哪。
    expect(() => parseConsoleArgs(['--registy=x'], 'qianmo')).toThrow(
      'console --help',
    )
    expect(() => parseConsoleArgs(['--port'], 'qianmo')).toThrow(
      '--port requires a value',
    )
  })

  test('refuses to run off Bun', () => {
    expect(() => assertConsoleRuntime(false)).toThrow('Bun runtime')
    expect(() => assertConsoleRuntime(true)).not.toThrow()
  })

  test('takes the two token files in both forms and keeps them absolute', () => {
    // 值本身由 `consoleTokenSources.ts` 读（那一步碰磁盘，所以不在纯解析里）；
    // 这里只钉住路径进得来、且和 `--audit` 同一条绝对路径规矩。
    const split = parseConsoleArgs(
      [
        '--view-token-file',
        '/run/qianmo/view.token',
        '--admin-token-file',
        '/run/qianmo/admin.token',
      ],
      'qianmo',
    )
    expect(split).toEqual(
      parseConsoleArgs(
        [
          '--view-token-file=/run/qianmo/view.token',
          '--admin-token-file=/run/qianmo/admin.token',
        ],
        'qianmo',
      ),
    )
    expect(split.viewTokenFile).toBe('/run/qianmo/view.token')
    expect(split.adminTokenFile).toBe('/run/qianmo/admin.token')
    // 命令行那一支没给就不该被凭空造出来。
    expect(split.viewToken).toBeUndefined()
    expect(split.adminToken).toBeUndefined()

    for (const flag of ['--view-token-file', '--admin-token-file']) {
      expect(() =>
        parseConsoleArgs([`${flag}=relative/token`], 'qianmo'),
      ).toThrow(`${flag} must be an absolute path`)
      expect(() => parseConsoleArgs([flag], 'qianmo')).toThrow(
        `${flag} requires a value`,
      )
    }
  })

  test('does not let --view-token-file fall into the --view-token branch', () => {
    // 两条分支的前缀长得几乎一样（`--view-token` / `--view-token-file`），一次
    // 顺序或写法上的疏忽就会让文件路径被当成 token 本身收下——那是把「明文不进
    // 命令行」这件事整个反过来。
    const config = parseConsoleArgs(
      ['--view-token-file=/run/qianmo/view.token'],
      'qianmo',
    )
    expect(config.viewToken).toBeUndefined()
    expect(config.viewTokenFile).toBe('/run/qianmo/view.token')
    expect(
      parseConsoleArgs(['--admin-token-file=/run/qianmo/a.token'], 'qianmo')
        .adminToken,
    ).toBeUndefined()
  })
})

describe('occ console --chat-sign', () => {
  test('两个签名开关互不牵连', () => {
    // 唤醒是「醒过来看一眼收件箱」，对话是「按这段文字去干活」——合成一个开关就是
    // 让打开前者的人顺手把后者也交出去。这条用例钉的就是它们没有被合并。
    const chatOnly = parseConsoleArgs(['--chat-sign'], 'qianmo')
    expect(chatOnly.signChats).toBe(true)
    expect(chatOnly.signWakes).toBeUndefined()

    const wakeOnly = parseConsoleArgs(['--wake-sign'], 'qianmo')
    expect(wakeOnly.signWakes).toBe(true)
    expect(wakeOnly.signChats).toBeUndefined()

    const both = parseConsoleArgs(['--wake-sign', '--chat-sign'], 'qianmo')
    expect(both.signWakes).toBe(true)
    expect(both.signChats).toBe(true)
  })
})

describe('occ console --node-server (服务器归属)', () => {
  test('takes one mapping per flag and keeps the order they were written', () => {
    const config = parseConsoleArgs(
      [
        '--node-server=beta-1=p11',
        '--node-server',
        'beta-2=p11',
        '--node-server=beta-3=p2',
      ],
      'qianmo',
    )
    expect(config.nodeServers).toEqual([
      { node: 'beta-1', server: 'p11' },
      { node: 'beta-2', server: 'p11' },
      { node: 'beta-3', server: 'p2' },
    ])
  })

  test('takes the four shapes a real machine name comes in', () => {
    // 协议段不许带点号也不许带冒号，而运维给机器起的名字一半是 IPv4、一部分是
    // IPv6、还有带大写的云主机名。复用 isValidSegment 等于让这些一个都配不上。
    // 这四种取值与写入侧 `beta_assert_server_id` 的注释举的是同一批。
    for (const server of ['p11', '203.0.113.7', '2001:db8::5', 'ECS114873']) {
      expect(
        parseConsoleArgs([`--node-server=beta-1=${server}`], 'qianmo')
          .nodeServers,
      ).toEqual([{ node: 'beta-1', server }])
    }
  })

  test('is absent by default, so a console with no mapping shows none', () => {
    expect(parseConsoleArgs([], 'qianmo').nodeServers).toEqual([])
  })

  test('refuses a value that is not <node>=<server>', () => {
    expect(() => parseConsoleArgs(['--node-server=p11'], 'qianmo')).toThrow(
      '--node-server must be <node>=<value>',
    )
    // 等号在第一个字符上等于没有 node 段。
    expect(() => parseConsoleArgs(['--node-server==p11'], 'qianmo')).toThrow(
      '--node-server must be <node>=<value>',
    )
    expect(() => parseConsoleArgs(['--node-server=beta-1='], 'qianmo')).toThrow(
      '--node-server value must not be empty',
    )
  })

  test('refuses anything outside the charset the writer side enforces', () => {
    // 判据与 `demo/env/beta/common.sh` 的 beta_assert_server_id 逐字对齐：一边
    // 放行一边拒收的症状是「peers.conf 明明写了，控制台就是不显示」。
    for (const bad of ['p 11', 'p11\tx', '香港一号', 'a/b', 'a,b', 'p11#1']) {
      expect(() =>
        parseConsoleArgs([`--node-server=beta-1=${bad}`], 'qianmo'),
      ).toThrow('letters, digits, . _ : or -')
    }
  })

  test('refuses a server id past the ceiling, and takes the one at it', () => {
    const atCeiling = 'a'.repeat(MAX_CONSOLE_SERVER_ID_LENGTH)
    expect(
      parseConsoleArgs([`--node-server=beta-1=${atCeiling}`], 'qianmo')
        .nodeServers[0]?.server,
    ).toBe(atCeiling)
    expect(() =>
      parseConsoleArgs(
        [
          `--node-server=beta-1=${'a'.repeat(MAX_CONSOLE_SERVER_ID_LENGTH + 1)}`,
        ],
        'qianmo',
      ),
    ).toThrow(`at most ${MAX_CONSOLE_SERVER_ID_LENGTH} characters`)
  })

  test('refuses the same node twice, whichever machine it names', () => {
    // 两条冲突的记录会让名册显示一条、备注面显示另一条，而那种不一致比一条
    // 启动错误难查得多。
    expect(() =>
      parseConsoleArgs(
        ['--node-server=beta-1=p11', '--node-server=beta-1=p2'],
        'qianmo',
      ),
    ).toThrow('--node-server repeats node beta-1')
  })

  test('holds the node half to the protocol segment rules', () => {
    expect(() =>
      parseConsoleArgs(['--node-server=Beta_1=p11'], 'qianmo'),
    ).toThrow('--node-server node must be a lowercase protocol segment')
  })

  test('derives the note path from the config root, never from $HOME', () => {
    // CLAUDE.md §1.1②，与转录同一条：OCC_CONFIG_DIR 必须对它有效。
    const path = consoleServerNotesPath()
    expect(path.endsWith('/qianmo/console/server-notes.ndjson')).toBe(true)
    expect(parseConsoleArgs([], 'qianmo').serverNotesPath).toBe(path)
    expect(() =>
      parseConsoleArgs(['--server-notes=relative/notes.ndjson'], 'qianmo'),
    ).toThrow('--server-notes must be an absolute path')
  })
})

describe('occ console --help', () => {
  test('answers --help and -h wherever they appear on the line', () => {
    // 「敲到一半发现忘了选项名」是人真会做的事，所以位置不限。
    expect(isConsoleHelpRequest(['--help'])).toBe(true)
    expect(isConsoleHelpRequest(['-h'])).toBe(true)
    expect(isConsoleHelpRequest(['--port', '39000', '--help'])).toBe(true)
    expect(isConsoleHelpRequest([])).toBe(false)
    expect(isConsoleHelpRequest(['--port=39000'])).toBe(false)
    // 当成某个选项的值写进去的不算——那是一个值，不是一次请求。
    expect(isConsoleHelpRequest(['--label=--help'])).toBe(false)
  })

  test('documents every option the parser actually dispatches on', () => {
    // 反漂移：选项名的唯一出处是解析器的分派链，帮助文本是它的投影。新增一个
    // 选项却忘了写进帮助，这条会红——而不是等到内测用户问「还有别的参数吗」。
    const source = readFileSync(
      new URL('../consoleArgs.ts', import.meta.url),
      'utf8',
    )
    const dispatched = [...source.matchAll(/arg === '(--[a-z-]+)'/g)].map(
      match => match[1] as string,
    )
    // 分派链的形状变了（比如改成表驱动）也要在这里被发现，否则这条测试会安静
    // 地变成一个零断言的空转。
    expect(dispatched.length).toBeGreaterThanOrEqual(13)
    for (const option of new Set(dispatched)) {
      expect(CONSOLE_HELP_TEXT).toContain(option)
    }
  })

  test('spells out the three token entrances and which one wins', () => {
    expect(CONSOLE_HELP_TEXT).toContain('--view-token-file')
    expect(CONSOLE_HELP_TEXT).toContain('--admin-token-file')
    expect(CONSOLE_HELP_TEXT).toContain(VIEW_TOKEN_ENV_VAR)
    expect(CONSOLE_HELP_TEXT).toContain(ADMIN_TOKEN_ENV_VAR)
    // 命令行入口留着，但必须在这里带着它的代价一起出现。
    expect(CONSOLE_HELP_TEXT).toContain('process list')
    expect(CONSOLE_HELP_TEXT).toContain('/proc/<pid>/cmdline')
    expect(CONSOLE_HELP_TEXT).toContain('chmod 600')
    // 优先级是定案，不是建议：文件 1、环境变量 2、命令行 3。
    expect(CONSOLE_HELP_TEXT.indexOf('1. --view-token-file')).toBeLessThan(
      CONSOLE_HELP_TEXT.indexOf(`2. $${VIEW_TOKEN_ENV_VAR}`),
    )
    expect(CONSOLE_HELP_TEXT.indexOf(`2. $${VIEW_TOKEN_ENV_VAR}`)).toBeLessThan(
      CONSOLE_HELP_TEXT.indexOf('3. --view-token <token>'),
    )
  })

  test('names the identity the console refuses to run without', () => {
    // 问「这个命令怎么用」的人恰恰是还没配好身份的那个人。
    expect(CONSOLE_HELP_TEXT).toContain('OCC_IDENTITY')
    expect(CONSOLE_HELP_TEXT).toContain('qianmo')
    expect(CONSOLE_HELP_TEXT).toContain('docs/dev/console.md')
    expect(CONSOLE_HELP_TEXT.endsWith('\n')).toBe(true)
  })
})

describe('console limits snapshot', () => {
  test('quotes the three owning packages instead of copying numbers', () => {
    expect(consoleLimits()).toEqual({
      protocol: {
        maxMessageBytes: LIMITS.maxMessageBytes,
        maxHops: LIMITS.maxHops,
        defaultTtlMs: LIMITS.defaultTtlMs,
        defaultTaskTtlMs: LIMITS.defaultTaskTtlMs,
        ratePerMinute: LIMITS.ratePerMinute,
      },
      runtime: {
        capacity: RUNTIME_RATE.capacity,
        windowMs: RUNTIME_RATE.windowMs,
      },
      registryTtlMs: DEFAULT_TTL_MS,
    })
  })

  test('keeps the two rate limits in two columns (charter AC-3)', () => {
    const limits = consoleLimits()
    // 协议速率与运行时速率**不得混为一谈**（packages/router/src/rate.ts）。
    expect(limits.protocol.ratePerMinute).not.toBe(limits.runtime.capacity)
  })
})

describe('console audit port', () => {
  let directory: string

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), 'qianmo-console-audit-'))
  })
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true })
  })

  test('a missing trail is an empty page, and says the chain is not there', async () => {
    const port = createAuditPort({ path: join(directory, 'absent.ndjson') })
    const page = await port.read({})

    // 读不到链不是失败——不该渲染成红色的「读取失败」；但它也不是完整：
    // 「节点还没做过协议工作」与「链根本没送到」是两件事（issue #9②）。
    expect(page).toEqual({
      ok: true,
      value: {
        records: [],
        chain: 'absent',
        intact: false,
        issueCount: 0,
        total: 0,
      },
    })
  })

  test('a trail that exists and holds nothing is an intact empty chain', async () => {
    const path = join(directory, 'quiet.ndjson')
    // 节点起来了、还没做过协议工作——`openAuditTrail` 会先把文件建出来。
    new AuditTrail(path).ensure()

    expect(await createAuditPort({ path }).read({})).toEqual({
      ok: true,
      value: {
        records: [],
        chain: 'empty',
        intact: true,
        issueCount: 0,
        total: 0,
      },
    })
  })

  test('answers a chain query on a missing trail with null, not a failure', async () => {
    const port = createAuditPort({ path: join(directory, 'absent.ndjson') })
    expect(await port.chain('0af7651916cd43dd8448eb211c80319c')).toEqual({
      ok: true,
      value: null,
    })
  })

  test('filters, tails and reports the pre-filter total', async () => {
    const path = join(directory, 'trail.ndjson')
    const trail = new AuditTrail(path)
    const traceId = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
    for (let index = 0; index < 5; index++) {
      trail.append({
        at: 1_700_000_000_000 + index,
        source: AuditSource.Transport,
        kind: 'message_accepted',
        outcome: 'ok',
        node: 'node-a',
        traceId,
        msgId: `msg-${index}`,
      })
    }
    trail.append({
      at: 1_700_000_000_010,
      source: AuditSource.Router,
      kind: 'runtime_throttled',
      outcome: 'refused',
      node: 'node-a',
      traceId,
    })
    trail.close()

    const port = createAuditPort({ path })

    const all = await port.read({})
    expect(all.ok).toBe(true)
    if (!all.ok) throw new Error('unreachable')
    expect(all.value.total).toBe(6)
    expect(all.value.intact).toBe(true)
    expect(all.value.issueCount).toBe(0)
    expect(all.value.records).toHaveLength(6)

    // limit 取的是**尾部**，和 `occ audit --limit` 同一语义。
    const tail = await port.read({ limit: 2 })
    if (!tail.ok) throw new Error('unreachable')
    expect(tail.value.records.map(record => record.seq)).toEqual([5, 6])
    // total 是过滤前的总数，页面据此说「共 6 条中的 2 条」。
    expect(tail.value.total).toBe(6)

    const refused = await port.read({ outcome: 'refused' })
    if (!refused.ok) throw new Error('unreachable')
    expect(refused.value.records).toHaveLength(1)
    expect(refused.value.records[0]?.kind).toBe('runtime_throttled')
    expect(refused.value.total).toBe(6)

    const bySource = await port.read({ source: AuditSource.Transport })
    if (!bySource.ok) throw new Error('unreachable')
    expect(bySource.value.records).toHaveLength(5)
  })

  test('reconstructs a chain including what was refused', async () => {
    const port = createAuditPort({ path: join(directory, 'trail.ndjson') })
    const chain = await port.chain('0af7651916cd43dd8448eb211c80319c')
    if (!chain.ok) throw new Error('unreachable')
    expect(chain.value?.records).toHaveLength(6)
    expect(chain.value?.refused).toBe(1)
  })

  test('says so when a filter names something that does not exist', async () => {
    const port = createAuditPort({ path: join(directory, 'trail.ndjson') })
    // 拼错的 source 静默匹配到零条，会被读成「这段时间什么都没发生」。
    expect(await port.read({ source: 'transprot' })).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
    expect(await port.read({ outcome: 'okay' })).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
    expect(await port.read({ from: Number.NaN })).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
    expect(await port.chain('   ')).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
  })

  test('surfaces a broken hash chain instead of swallowing it', async () => {
    const path = join(directory, 'tampered.ndjson')
    const trail = new AuditTrail(path)
    trail.append({
      at: 1_700_000_000_000,
      source: AuditSource.Registry,
      kind: 'registered',
      outcome: 'ok',
      node: 'node-a',
    })
    trail.close()
    writeFileSync(path, '{"seq":1,"at":1,"source":"registry"}\n')

    const page = await createAuditPort({ path }).read({})
    if (!page.ok) throw new Error('unreachable')
    expect(page.value.intact).toBe(false)
    expect(page.value.issueCount).toBeGreaterThan(0)
  })

  test('detects a self-consistent rewritten chain through the real witness endpoint', async () => {
    const path = join(directory, 'witness-rewritten.ndjson')
    const node = 'node-witness'
    const keys = generateNodeKeyPair()
    const trail = new AuditTrail(path)
    for (let index = 0; index < 4; index++) {
      trail.append({
        at: Date.now() + index,
        source: AuditSource.Resident,
        kind: `event-${index + 1}`,
        outcome: index === 1 ? 'refused' : 'ok',
        node,
      })
    }
    trail.close()

    const service = startWitnessService({
      store: new FileWitnessAnchorStore({
        root: join(directory, 'witness-endpoint'),
      }),
      publicKeys: new StaticPublicKeyDirectory([[node, keys.publicKey]]),
      writeToken: 'console-witness-write-token',
      readToken: 'console-witness-read-token',
    })
    try {
      const scheduler = new AuditWitnessScheduler({
        node,
        trailPath: path,
        keys,
        writer: remoteWitnessAnchorWriter({
          url: service.url as string,
          token: 'console-witness-write-token',
        }),
      })
      await scheduler.tick()

      const rewritten = join(directory, 'witness-rewritten-next.ndjson')
      const attacked = new AuditTrail(rewritten)
      for (const record of readTrail(path).records.filter(
        record => record.outcome !== 'refused',
      )) {
        const { seq: _seq, prev: _prev, ...input } = record
        attacked.append(input)
      }
      attacked.close()
      writeFileSync(path, readFileSync(rewritten, 'utf8'))
      expect(readTrail(path).intact).toBe(true)

      const page = await createAuditPort({
        path,
        witness: { kind: 'url', value: service.url as string },
        witnessReadToken: 'console-witness-read-token',
        publicKeyOf: async requestedNode =>
          requestedNode === node
            ? { ok: true, value: keys.publicKey }
            : {
                ok: false,
                failure: { code: 'not_found', message: '节点不在名册' },
              },
      }).read({})
      expect(page).toMatchObject({
        ok: true,
        value: {
          intact: true,
          witness: { tampered: true, stale: false },
        },
      })
    } finally {
      await service.stop()
    }
  })

  test('an idle anchored trail stays verified; a new record with a silent witness does not', async () => {
    const path = join(directory, 'witness-idle.ndjson')
    const node = 'node-witness-idle'
    const keys = generateNodeKeyPair()
    const append = (kind: string) => {
      const trail = new AuditTrail(path)
      trail.append({
        at: Date.now(),
        source: AuditSource.Resident,
        kind,
        outcome: 'ok',
        node,
      })
      trail.close()
    }
    append('event-1')
    append('event-2')

    // The witness accepted the head an hour ago and has heard nothing since:
    // exactly what an idle node looks like from the witness side.
    const service = startWitnessService({
      store: new FileWitnessAnchorStore({
        root: join(directory, 'witness-idle-endpoint'),
      }),
      publicKeys: new StaticPublicKeyDirectory([[node, keys.publicKey]]),
      writeToken: 'console-witness-write-token',
      readToken: 'console-witness-read-token',
      now: () => Date.now() - 3_600_000,
    })
    try {
      await new AuditWitnessScheduler({
        node,
        trailPath: path,
        keys,
        writer: remoteWitnessAnchorWriter({
          url: service.url as string,
          token: 'console-witness-write-token',
        }),
      }).tick()
      const port = createAuditPort({
        path,
        witness: { kind: 'url', value: service.url as string },
        witnessReadToken: 'console-witness-read-token',
        publicKeyOf: async () => ({ ok: true, value: keys.publicKey }),
      })

      expect(await port.read({})).toMatchObject({
        ok: true,
        value: { witness: { tampered: false, stale: false } },
      })
      append('event-3')
      expect(await port.read({})).toMatchObject({
        ok: true,
        value: { witness: { tampered: false, stale: true } },
      })
    } finally {
      await service.stop()
    }
  })

  test('returns a typed failure when a configured witness endpoint is unreachable', async () => {
    const path = join(directory, 'witness-unreachable.ndjson')
    const trail = new AuditTrail(path)
    trail.append({
      at: Date.now(),
      source: AuditSource.Resident,
      kind: 'event',
      outcome: 'ok',
      node: 'node-witness',
    })
    trail.close()
    const keys = generateNodeKeyPair()

    const result = await createAuditPort({
      path,
      witness: { kind: 'url', value: 'http://127.0.0.1:1/' },
      witnessReadToken: 'console-witness-read-token',
      publicKeyOf: async () => ({ ok: true, value: keys.publicKey }),
    }).read({})
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    if (result.ok) throw new Error('expected witness endpoint failure')
    expect(result.failure.message).toStartWith('见证端点不可达')
  })

  test('returns the existing unavailable result when its remote witness reader times out', async () => {
    const path = join(directory, 'witness-timeout.ndjson')
    const trail = new AuditTrail(path)
    trail.append({
      at: Date.now(),
      source: AuditSource.Resident,
      kind: 'event',
      outcome: 'ok',
      node: 'node-witness-timeout',
    })
    trail.close()
    const keys = generateNodeKeyPair()
    let aborted = false
    const reader = remoteWitnessAnchorReader({
      url: 'http://witness.test',
      token: 'console-witness-read-token',
      timeoutMs: 10,
      fetchImpl: ((_input, init) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborted = true
          },
          { once: true },
        )
        return new Promise<Response>(() => {})
      }) as typeof fetch,
    })

    const result = await createAuditPort({
      path,
      witness: { kind: 'url', value: 'http://witness.test/' },
      publicKeyOf: async () => ({ ok: true, value: keys.publicKey }),
      witnessReader: reader.list,
    }).read({})
    expect(aborted).toBe(true)
    expect(result).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    if (result.ok) throw new Error('expected witness timeout failure')
    expect(result.failure.message).toContain('timed out after 10 ms')
  })

  test('defaults the tail to the same 200 as occ audit', () => {
    expect(DEFAULT_AUDIT_LIMIT).toBe(200)
  })
})

describe('console registry port', () => {
  let server: RegistryServerHandle

  beforeAll(() => {
    server = startRegistryServer(0)
  })
  afterAll(async () => {
    await server.stop()
  })

  const address = 'qianmo://node-b/reviewer'

  test('drives the real HTTP v0 surface through all four calls', async () => {
    const port = createRegistryPort({ baseUrl: server.url })

    expect(await port.list()).toEqual({ ok: true, value: [] })

    const registered = await port.register({
      address,
      endpoint: 'ws://127.0.0.1:38612',
      capabilities: ['review'],
    })
    if (!registered.ok) throw new Error(registered.failure.message)
    expect(registered.value.address).toBe(address)
    expect(registered.value.capabilities).toEqual(['review'])
    expect(registered.value.expiresAt).toBeGreaterThan(0)
    // 私钥永远不出现在这条路径上；公钥没发布时字段就该缺席。
    expect(registered.value.publicKey).toBeUndefined()

    const listed = await port.list()
    if (!listed.ok) throw new Error('unreachable')
    expect(listed.value.map(agent => agent.address)).toEqual([address])

    // 地址里的 `://` 与 `/` 必须百分号编码进**单个** path segment，否则服务端
    // split 出来的段数对不上，这一条会静默变成另一条路由。
    const beat = await port.heartbeat(address)
    if (!beat.ok) throw new Error(beat.failure.message)
    expect(beat.value.lastHeartbeatAt).toBeGreaterThanOrEqual(
      registered.value.registeredAt,
    )

    expect(await port.deregister(address)).toEqual({
      ok: true,
      value: undefined,
    })
    expect(await port.list()).toEqual({ ok: true, value: [] })
  })

  test('carries the write token on writes only, against a registry that requires it (P15.8)', async () => {
    const writeToken = 'console-registry-write-token'
    const gated = startRegistryServer(0, { writeToken })
    try {
      const seen: { method: string; authorization: string | null }[] = []
      const recording: Parameters<typeof createRegistryPort>[0]['fetch'] = (
        input,
        init,
      ) => {
        seen.push({
          method: init.method ?? 'GET',
          authorization: new Headers(init.headers).get('authorization'),
        })
        return fetch(input, init)
      }

      const without = createRegistryPort({ baseUrl: gated.url })
      const refused = await without.register({
        address,
        endpoint: 'ws://127.0.0.1:38612',
      })
      expect(refused).toMatchObject({ ok: false, failure: { code: 'refused' } })
      if (refused.ok) throw new Error('unreachable')
      expect(refused.failure.message).toContain('write token')
      expect(await without.list()).toEqual({ ok: true, value: [] })

      const port = createRegistryPort({
        baseUrl: gated.url,
        writeToken,
        fetch: recording,
      })
      const registered = await port.register({
        address,
        endpoint: 'ws://127.0.0.1:38612',
      })
      expect(registered.ok).toBe(true)
      expect((await port.heartbeat(address)).ok).toBe(true)
      expect((await port.list()).ok).toBe(true)
      expect(await port.deregister(address)).toEqual({
        ok: true,
        value: undefined,
      })

      expect(seen).toEqual([
        { method: 'POST', authorization: `Bearer ${writeToken}` },
        { method: 'POST', authorization: `Bearer ${writeToken}` },
        { method: 'GET', authorization: null },
        { method: 'DELETE', authorization: `Bearer ${writeToken}` },
      ])
    } finally {
      await gated.stop()
    }
  })

  test('maps the registry own error codes onto port failures', async () => {
    const port = createRegistryPort({ baseUrl: server.url })

    expect(await port.heartbeat('qianmo://node-z/ghost')).toMatchObject({
      ok: false,
      failure: { code: 'not_found' },
    })
    expect(await port.deregister('qianmo://node-z/ghost')).toMatchObject({
      ok: false,
      failure: { code: 'not_found' },
    })
    expect(
      await port.register({ address: 'not-an-address', endpoint: 'nope' }),
    ).toMatchObject({ ok: false, failure: { code: 'invalid' } })
  })

  test('refuses an empty address locally rather than hitting the collection route', async () => {
    const port = createRegistryPort({ baseUrl: server.url })
    // `DELETE /v0/agents/` 会退化成集合路由——删到的不是调用方想删的东西。
    expect(await port.deregister('   ')).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
    expect(await port.heartbeat('')).toMatchObject({
      ok: false,
      failure: { code: 'invalid' },
    })
  })

  test('turns an unreachable registry into a failure, never a throw', async () => {
    // 真的关掉一个真的服务端，拿到真的 ECONNREFUSED。
    const doomed = startRegistryServer(0)
    const baseUrl = doomed.url
    await doomed.stop()

    const port = createRegistryPort({ baseUrl, timeoutMs: 1_000 })
    const listed = await port.list()

    // 面板要在注册中心挂掉时照常打开——这是它存在的一半理由。
    expect(listed).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    if (listed.ok) throw new Error('unreachable')
    expect(listed.failure.message).toContain(baseUrl)

    expect(await port.register({ address, endpoint: 'ws://x' })).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(await port.heartbeat(address)).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
    expect(await port.deregister(address)).toMatchObject({
      ok: false,
      failure: { code: 'unreachable' },
    })
  })

  test('gives up on a registry that accepts and then never answers', async () => {
    // 不回包（而不是拒连）是 fetch 默认会永远等下去的那一种挂法。
    const stalled = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Promise<Response>(() => {}),
    })
    try {
      const port = createRegistryPort({
        baseUrl: `http://127.0.0.1:${stalled.port}`,
        timeoutMs: 150,
      })
      expect(await port.list()).toMatchObject({
        ok: false,
        failure: { code: 'unreachable' },
      })
    } finally {
      await stalled.stop(true)
    }
  })

  test('does not mistake a malformed body for a roster', async () => {
    const shaped = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => Response.json({ nope: true }),
    })
    try {
      const port = createRegistryPort({
        baseUrl: `http://127.0.0.1:${shaped.port}`,
      })
      expect(await port.list()).toMatchObject({
        ok: false,
        failure: { code: 'invalid' },
      })
    } finally {
      await shaped.stop(true)
    }
  })

  test('drops a roster row that has no address instead of showing a ghost', async () => {
    const partial = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        Response.json({
          agents: [
            { endpoint: 'ws://x', status: 'online' },
            {
              address,
              endpoint: 'ws://127.0.0.1:38612',
              status: 'online',
              capabilities: ['review', 7],
              registeredAt: 1,
              lastHeartbeatAt: 2,
              expiresAt: 3,
            },
          ],
        }),
    })
    try {
      const port = createRegistryPort({
        baseUrl: `http://127.0.0.1:${partial.port}`,
      })
      const listed = await port.list()
      if (!listed.ok) throw new Error('unreachable')
      expect(listed.value).toHaveLength(1)
      expect(listed.value[0]?.address).toBe(address)
      // 非字符串的能力项被丢掉，而不是把整行判废。
      expect(listed.value[0]?.capabilities).toEqual(['review'])
    } finally {
      await partial.stop(true)
    }
  })
})

/**
 * §10.1 的证书栏，在参数面上的那一半。
 *
 * 「给了才有」是一个刻意的取舍而不是省事：没有 CA 根就没有 F-2 那一次判定，
 * 一栏全是「未知」会让「这个部署还没上证书」和「证书全坏了」长得一样。
 */
describe('console --trust-ca (证书栏)', () => {
  test('不给就没有，给了必须是绝对路径', () => {
    expect(parseConsoleArgs([], 'qianmo').trustCa).toBeUndefined()
    expect(
      parseConsoleArgs(['--trust-ca', '/etc/qianmo/ca.pem'], 'qianmo').trustCa,
    ).toBe('/etc/qianmo/ca.pem')
    expect(() => parseConsoleArgs(['--trust-ca', 'ca.pem'], 'qianmo')).toThrow(
      'absolute path',
    )
  })

  test('帮助里说清它是只读的公开材料', () => {
    expect(CONSOLE_HELP_TEXT).toContain('--trust-ca')
    expect(CONSOLE_HELP_TEXT).toContain('verifies, never signs')
  })
})
