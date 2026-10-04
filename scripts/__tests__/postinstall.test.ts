import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { zipSync } from 'fflate'

type BuildTarget = {
  arch: string
  platform: string
  libc?: string
}

type PostinstallModule = {
  DEFAULT_RELEASE_BASE: string
  RELEASE_BASE: string
  RG_ARCHIVE_SHA256: Record<string, string>
  getBinaryPath(buildTarget?: BuildTarget): string
  getPlatformMapping(buildTarget?: BuildTarget): { target: string; ext: string }
  hasExplicitTargetRequest(
    argv?: readonly string[],
    env?: Record<string, string | undefined>,
  ): boolean
  parseTargetSpec(spec: string): BuildTarget
  resolveTargets(
    argv?: readonly string[],
    env?: Record<string, string | undefined>,
  ): BuildTarget[]
  extractTarGz(
    buffer: Buffer,
    binaryPath: string,
    extractedBinary: string,
  ): Promise<void>
  extractZip(
    buffer: Buffer,
    binaryPath: string,
    extractedBinary: string,
  ): Promise<void>
  isExpectedArchiveEntry(entryName: string, expectedBinary: string): boolean
  verifyArchiveChecksum(
    buffer: Buffer,
    expectedSha256: string,
    assetName: string,
  ): void
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const postinstall = require('../postinstall.cjs') as PostinstallModule

function tarArchive(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    header.write(entry.name, 0, 100, 'utf-8')
    header.write(`${entry.data.length.toString(8).padStart(11, '0')}\0`, 124)
    header[156] = '0'.charCodeAt(0)
    chunks.push(header, entry.data)
    const padding = (512 - (entry.data.length % 512)) % 512
    if (padding > 0) chunks.push(Buffer.alloc(padding))
  }
  chunks.push(Buffer.alloc(1024))
  return Buffer.concat(chunks)
}

describe('postinstall ripgrep integrity', () => {
  test('pins a SHA-256 for every supported release asset', () => {
    expect(Object.keys(postinstall.RG_ARCHIVE_SHA256)).toHaveLength(7)
    for (const digest of Object.values(postinstall.RG_ARCHIVE_SHA256)) {
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(
      postinstall.RG_ARCHIVE_SHA256[
        'ripgrep-v15.0.1-aarch64-unknown-linux-gnu.tar.gz'
      ],
    ).toBe('301eaf7e580272acb9e370d7b9f4ed9ba0b0fa8c3479e7282a895bbfe0f1076c')
  })

  test('rejects a downloaded archive whose SHA-256 does not match', () => {
    const archive = Buffer.from('downloaded bytes')
    const expected = createHash('sha256').update(archive).digest('hex')
    expect(() =>
      postinstall.verifyArchiveChecksum(archive, expected, 'asset.tar.gz'),
    ).not.toThrow()
    expect(() =>
      postinstall.verifyArchiveChecksum(
        Buffer.from('tampered bytes'),
        expected,
        'asset.tar.gz',
      ),
    ).toThrow(/SHA-256 mismatch/)
  })

  test('has no automatic third-party mirror fallback', async () => {
    const source = await readFile(
      join(import.meta.dir, '..', 'postinstall.cjs'),
      'utf-8',
    )
    expect(postinstall.DEFAULT_RELEASE_BASE).toMatch(
      /^https:\/\/github\.com\/microsoft\/ripgrep-prebuilt\//,
    )
    expect(postinstall.RELEASE_BASE).not.toContain('ghproxy')
    expect(source).not.toContain('ghproxy.net')
  })
})

describe('postinstall ripgrep archive extraction', () => {
  test('ZIP extraction writes only the single expected binary entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'postinstall-zip-'))
    try {
      const binaryPath = join(dir, 'rg.exe')
      const archive = Buffer.from(
        zipSync({
          'ripgrep/rg.exe': new TextEncoder().encode('trusted binary'),
          'ripgrep/ignored.dll': new TextEncoder().encode('ignored'),
        }),
      )

      await postinstall.extractZip(archive, binaryPath, 'rg.exe')

      expect(await readFile(binaryPath, 'utf-8')).toBe('trusted binary')
      expect(existsSync(join(dir, 'ignored.dll'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('TAR.GZ extraction writes only the single expected regular file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'postinstall-tar-'))
    try {
      const binaryPath = join(dir, 'rg')
      const archive = gzipSync(
        tarArchive([
          { name: 'ripgrep/rg', data: Buffer.from('trusted binary') },
          { name: 'ripgrep/README.md', data: Buffer.from('ignored') },
        ]),
      )

      await postinstall.extractTarGz(archive, binaryPath, 'rg')

      expect(await readFile(binaryPath, 'utf-8')).toBe('trusted binary')
      expect(existsSync(join(dir, 'README.md'))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects traversal and duplicate binary entries', async () => {
    expect(postinstall.isExpectedArchiveEntry('../rg', 'rg')).toBe(false)
    const dir = await mkdtemp(join(tmpdir(), 'postinstall-duplicate-'))
    try {
      const archive = Buffer.from(
        zipSync({
          'a/rg.exe': new TextEncoder().encode('first'),
          'b/rg.exe': new TextEncoder().encode('second'),
        }),
      )
      await expect(
        postinstall.extractZip(archive, join(dir, 'rg.exe'), 'rg.exe'),
      ).rejects.toThrow(/Multiple rg\.exe entries/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

/**
 * 目标由「谁来跑」决定曾经是个真问题：macOS 上出的 dist 只带 arm64，x86_64 节点拿到
 * 的产物里没有可执行的 rg，每次换产物都要手工把对的架构捞回去（issue #46）。下面钉
 * 的是那一层选择——下载与校验本身不在这条线上，由上面几个用例守着。
 */
describe('postinstall ripgrep target selection', () => {
  test('每个可命名的目标都能解析出一个有 SHA-256 的资产', () => {
    const specs = [
      'arm64-darwin',
      'x64-darwin',
      'x64-win32',
      'arm64-win32',
      'x64-linux',
      'arm64-linux-musl',
      'arm64-linux-gnu',
    ]
    const assets = specs.map(spec => {
      const { target, ext } = postinstall.getPlatformMapping(
        postinstall.parseTargetSpec(spec),
      )
      return `ripgrep-v15.0.1-${target}.${ext}`
    })
    // 七个 spec 打到七个不同的资产上，且每一个都在校验表里——漏一个就等于下载一份
    // 没人核对过字节的二进制。
    expect(new Set(assets).size).toBe(specs.length)
    for (const asset of assets) {
      expect(postinstall.RG_ARCHIVE_SHA256[asset]).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  test('vendor 子目录用的是运行期那把钥匙：<arch>-<platform>', () => {
    // src/utils/filesystem/ripgrep.ts 在运行期拼的就是 `${process.arch}-${process.platform}`，
    // 所以几个目标能并排放着，各机器各取各的。
    expect(
      postinstall.getBinaryPath({ arch: 'x64', platform: 'linux' }),
    ).toMatch(/[/\\]ripgrep[/\\]x64-linux[/\\]rg$/)
    expect(
      postinstall.getBinaryPath({ arch: 'arm64', platform: 'win32' }),
    ).toMatch(/[/\\]ripgrep[/\\]arm64-win32[/\\]rg\.exe$/)
  })

  test('跨目标的 linux 默认 musl，不去探测构建机的 libc', () => {
    // 探测只回答「这台机器是什么」，而跨架构下那与产物无关。musl 是 static-pie，
    // 不会把构建机的 glibc 下限带给节点。
    expect(
      postinstall.getPlatformMapping({ arch: 'arm64', platform: 'linux' })
        .target,
    ).toBe('aarch64-unknown-linux-musl')
    expect(
      postinstall.getPlatformMapping({
        arch: 'arm64',
        platform: 'linux',
        libc: 'gnu',
      }).target,
    ).toBe('aarch64-unknown-linux-gnu')
    // x86_64 只发了 musl 一种，显式要 gnu 必须说清楚而不是静默给别的。
    expect(() =>
      postinstall.getPlatformMapping({
        arch: 'x64',
        platform: 'linux',
        libc: 'gnu',
      }),
    ).toThrow(/No x86_64 linux-gnu/)
  })

  test('--target 与 RIPGREP_TARGETS 都认，重复的只算一次', () => {
    expect(
      postinstall.resolveTargets(
        [
          '--target',
          'x64-linux',
          '--target=arm64-linux',
          '--target',
          'x64-linux',
        ],
        {},
      ),
    ).toEqual([
      { arch: 'x64', platform: 'linux', libc: undefined },
      { arch: 'arm64', platform: 'linux', libc: undefined },
    ])
    expect(
      postinstall.resolveTargets([], {
        RIPGREP_TARGETS: 'x86_64-linux, aarch64-darwin',
      }),
    ).toEqual([
      { arch: 'x64', platform: 'linux', libc: undefined },
      { arch: 'arm64', platform: 'darwin', libc: undefined },
    ])
    // 没点名时就是本机，与改造前一模一样。
    expect(postinstall.resolveTargets([], {})).toEqual([
      { arch: process.arch, platform: process.platform, libc: undefined },
    ])
  })

  test('拼错的目标在任何下载发生之前就整体拒绝', () => {
    expect(() => postinstall.parseTargetSpec('x64-freebsd')).toThrow(
      /unknown platform/,
    )
    expect(() => postinstall.parseTargetSpec('ia64-linux')).toThrow(
      /unknown arch/,
    )
    expect(() => postinstall.parseTargetSpec('x64-darwin-musl')).toThrow(
      /libc suffix only means something on linux/,
    )
    expect(() => postinstall.parseTargetSpec('linux')).toThrow(
      /<arch>-<platform>/,
    )
    expect(() => postinstall.resolveTargets(['--target'], {})).toThrow(
      /--target needs a value/,
    )
  })

  test('「点没点名目标」是退出码的判据', () => {
    // 生命周期钩子从不传这些，所以它照旧退 0、装不坏安装；而构建前那趟备货
    // 失败必须响——静默成功正是缺架构的 dist 铺到节点上的那条路。
    expect(postinstall.hasExplicitTargetRequest([], {})).toBe(false)
    expect(postinstall.hasExplicitTargetRequest(['--force'], {})).toBe(false)
    expect(
      postinstall.hasExplicitTargetRequest([], { RIPGREP_TARGETS: '' }),
    ).toBe(false)
    expect(
      postinstall.hasExplicitTargetRequest(['--target', 'x64-linux'], {}),
    ).toBe(true)
    expect(
      postinstall.hasExplicitTargetRequest(['--target=x64-linux'], {}),
    ).toBe(true)
    expect(
      postinstall.hasExplicitTargetRequest([], {
        RIPGREP_TARGETS: 'x64-linux',
      }),
    ).toBe(true)
  })
})
