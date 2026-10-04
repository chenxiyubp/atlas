// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The host-side, append-only filesystem store for witness anchors. */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isValidSegment } from '@qianmo/protocol'
import {
  isWitnessAnchor,
  isWitnessAnchorReceipt,
  isWitnessEvidence,
  witnessAnchorOf,
  type WitnessAnchorReceipt,
  type WitnessEvidence,
} from './anchor.js'

function anchorDirectory(root: string, node: string): string {
  return join(root, node)
}

function anchorPath(root: string, node: string, seq: number): string {
  return join(anchorDirectory(root, node), `${String(seq)}.json`)
}

/** An existing `(node, seq)` is evidence, not a slot that can be replaced. */
export class WitnessAnchorExistsError extends Error {
  /**
   * The head already stored at this `(node, seq)`, or null when that object
   * cannot be read back. It lets a sender that resent the same head after a
   * restart recognise its own earlier acceptance; see design §4.1.
   */
  readonly head: string | null

  constructor(node: string, seq: number, head: string | null = null) {
    super(`witness anchor already exists for ${node} at seq ${seq}`)
    this.name = 'WitnessAnchorExistsError'
    this.head = head
  }
}

export interface FileWitnessAnchorStoreOptions {
  /** Directory owned by the host-side witness endpoint. */
  readonly root: string
}

/**
 * Stores exactly one receipt for each `(node, seq)`, created with `wx`.
 *
 * There is intentionally no update or removal method. Retention, when it is
 * needed, is an operator-run action outside the inbound witness surface.
 */
export class FileWitnessAnchorStore {
  readonly root: string

  constructor(options: FileWitnessAnchorStoreOptions) {
    if (options.root.trim() === '') {
      throw new Error('witness store root must not be empty')
    }
    this.root = options.root
  }

  async create(receipt: WitnessAnchorReceipt): Promise<void> {
    if (!isWitnessAnchorReceipt(receipt)) {
      throw new Error('refusing an invalid witness anchor receipt')
    }
    const anchor = receipt.anchor
    const directory = anchorDirectory(this.root, anchor.node)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      await writeFile(
        anchorPath(this.root, anchor.node, anchor.seq),
        `${JSON.stringify(receipt)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new WitnessAnchorExistsError(
          anchor.node,
          anchor.seq,
          await this.#storedHead(anchor.node, anchor.seq),
        )
      }
      throw error
    }
  }

  /** Read back one existing object; a torn or foreign one confirms nothing. */
  async #storedHead(node: string, seq: number): Promise<string | null> {
    try {
      const parsed: unknown = JSON.parse(
        await readFile(anchorPath(this.root, node, seq), 'utf8'),
      )
      if (!isWitnessEvidence(parsed)) return null
      const stored = witnessAnchorOf(parsed)
      return stored.node === node && stored.seq === seq ? stored.head : null
    } catch {
      return null
    }
  }

  async list(node: string): Promise<readonly WitnessEvidence[]> {
    if (!isValidSegment(node)) return []
    let names: string[]
    try {
      names = await readdir(anchorDirectory(this.root, node))
    } catch {
      return []
    }
    const evidence: WitnessEvidence[] = []
    for (const name of names.sort((a, b) => Number(a) - Number(b))) {
      if (!name.endsWith('.json')) continue
      try {
        const parsed: unknown = JSON.parse(
          await readFile(join(anchorDirectory(this.root, node), name), 'utf8'),
        )
        if (isWitnessAnchorReceipt(parsed) && parsed.anchor.node === node) {
          evidence.push(parsed)
        } else if (isWitnessAnchor(parsed) && parsed.node === node) {
          // Pre-receipt files remain useful for signature and prefix checks,
          // but callers treat them as stale because they lack host time.
          evidence.push(parsed)
        }
      } catch {
        // One torn or hand-edited object must not hide older evidence.
      }
    }
    return evidence.sort((a, b) => {
      const left = witnessAnchorOf(a)
      const right = witnessAnchorOf(b)
      return left.seq - right.seq || left.at - right.at
    })
  }
}
