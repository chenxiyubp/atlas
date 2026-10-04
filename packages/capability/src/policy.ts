// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The three permission levels, applied to inbound messages (charter C-5).
 *
 * ## What a level is, and what it is not
 *
 * The level a message carries is a **ceiling** on what that message may cause
 * this node to do. It is never added to what the local agent already has —
 * rule S-3, and the reason it can be stated so flatly is that there is no code
 * path from here into the base's permission state at all. `authorization.test.ts`
 * asserts that as a scan rather than as a promise, because "we did not call
 * that API" is exactly the sort of claim that quietly stops being true.
 *
 * ## The default is {@link SIGNED_TASK_POLICY} (P12.4, key-distribution.md §9.2 ②)
 *
 * Work has to be authorized. A `task.request` or a `wake` arriving with no
 * capability token is refused, and the refusal is `E_CAP_INSUFFICIENT` on the
 * level rather than on the absence — the two questions stay apart (`gate.ts`).
 *
 * **The reason this is only now the default is worth keeping**, because it is
 * the whole argument for the machinery that made the switch possible. Until
 * P12.1–P12.3 there was no key distribution: `AgentRecord.publicKey` existed
 * and was validated, but nothing published it, and `--trust <node>=<publicKey>`
 * was an O(N²) hand-copy. Demanding signatures before there is a way to learn
 * keys does not make a network safer, it makes it silent — `policy.ts` said
 * exactly that, and {@link OPEN_POLICY} existed for exactly that. The CA, the
 * certificate directory and the registry's `certificate` field are what
 * removed the reason, so the default followed.
 *
 * What did **not** change is the part that was never optional: any token that
 * is presented has always been fully verified, a forged one refused, and a
 * remote `user-confirmed` refused by S-1 whatever it is signed with. Only
 * *requiring* one was ever in question.
 *
 * ## {@link OPEN_POLICY} is now the escape hatch, and it stays one
 *
 * `--open-policy` on a resident node, and the rollback it performs is free in
 * a way that is structural rather than lucky: `OPEN_POLICY` does not *skip*
 * verification, it only stops *requiring* a token. So a message that carries a
 * valid token is admitted identically under both policies, and a forged one is
 * refused identically under both. **Neither direction of the switch changes
 * the fate of a signed message** — the only thing that moves is whether an
 * unsigned `task.request` is refused, which is the entire point of switching
 * and the entire cost of rolling back (§9.3).
 *
 * That is why the hatch survives into §9.2 phase ③ rather than being removed
 * with the switch: a rollback that costs nothing is worth keeping available.
 */

import {
  CapabilityLevel,
  MessageType,
  levelAtLeast,
  type QianmoMessage,
} from '@qianmo/protocol'

/** Decides what a message must present before this node acts on it. */
export interface CapabilityPolicy {
  requiredLevel(message: QianmoMessage): CapabilityLevel
}

/** Build a policy from a per-type table; unlisted types require `read`. */
export function capabilityPolicy(
  levels: Partial<Record<MessageType, CapabilityLevel>>,
): CapabilityPolicy {
  return {
    requiredLevel(message: QianmoMessage): CapabilityLevel {
      return levels[message.type] ?? CapabilityLevel.Read
    },
  }
}

/**
 * Everything may arrive unsigned. The M0 default, and now the `--open-policy`
 * escape hatch — see the module header for what remains enforced under it,
 * which is everything except the requirement to present a token at all.
 */
export const OPEN_POLICY: CapabilityPolicy = capabilityPolicy({})

/**
 * Work has to be authorized: a `task.request` or a `wake` opens a turn that can
 * change the workspace, so both need `write-limited`. Replies stay at `read` —
 * an answer to a task this node itself asked for authorizes nothing.
 *
 * **The default since P12.4.** See the module header for why it was not, and
 * for what rolling back to {@link OPEN_POLICY} does and does not cost.
 */
export const SIGNED_TASK_POLICY: CapabilityPolicy = capabilityPolicy({
  [MessageType.TaskRequest]: CapabilityLevel.WriteLimited,
  [MessageType.Wake]: CapabilityLevel.WriteLimited,
})

/** True when `level` clears what `policy` demands of `message`. */
export function satisfies(
  policy: CapabilityPolicy,
  message: QianmoMessage,
  level: CapabilityLevel,
): boolean {
  return levelAtLeast(level, policy.requiredLevel(message))
}
