// Copyright 2026 Qianmo AgentNest Team
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The signed handshake, at the level of the functions that decide it
 * (key-distribution.md §7.1 / §7.1.1). The end-to-end half is in
 * `signed-handshake.test.ts`; this file pins the verdicts.
 *
 * Zero mocks: every signature here is a real Ed25519 signature over real
 * bytes, because the only interesting failures are the ones where the bytes
 * differ by something a mock would have papered over.
 */

import { describe, expect, test } from 'bun:test'
import {
  StaticPublicKeyDirectory,
  generateNodeKeyPair,
  signBytes,
  verifyBytes,
} from '@qianmo/capability'
import {
  HANDSHAKE_CREDENTIAL_PROOF_DOMAIN,
  HANDSHAKE_SIGNATURE_DOMAIN,
  HandshakeRejection,
  ReadyRejection,
  authCredentialProofInput,
  authSigningInput,
  computeMac,
  newNonce,
  readyCredentialProofInput,
  readySigningInput,
  signReady,
  verifyAuthAttempt,
  verifyReady,
  type AuthAttempt,
  type HandshakeIdentity,
  type HandshakeCredentialDirectory,
} from '../src/index.js'
import { TEST_PSK, WRONG_PSK } from './helpers.js'

const CHANNEL_ID = 'a'.repeat(32)

const dialerKeys = generateNodeKeyPair()
const listenerKeys = generateNodeKeyPair()
const impostorKeys = generateNodeKeyPair()

function directory(): StaticPublicKeyDirectory {
  return new StaticPublicKeyDirectory([
    ['node-a', dialerKeys.publicKey],
    ['node-b', listenerKeys.publicKey],
  ])
}

function listenerIdentity(required = false) {
  return {
    node: 'node-b',
    keys: listenerKeys,
    directory: directory(),
    required,
  }
}

function signedAttempt(
  serverNonce: string,
  overrides: Partial<AuthAttempt> = {},
  signWith = dialerKeys,
): AuthAttempt {
  const clientNonce = overrides.clientNonce ?? newNonce()
  const node = overrides.node ?? 'node-a'
  const channelId = overrides.channelId ?? CHANNEL_ID
  return {
    node,
    nonce: overrides.nonce ?? serverNonce,
    clientNonce,
    channelId,
    mac:
      overrides.mac ??
      computeMac(TEST_PSK, serverNonce, clientNonce, node, channelId),
    sig:
      'sig' in overrides
        ? overrides.sig
        : signBytes(
            signWith,
            authSigningInput(serverNonce, clientNonce, node, channelId),
          ),
  }
}

describe('signing input', () => {
  test('carries the domain prefix and the tuple the MAC covers', () => {
    const input = authSigningInput('sn', 'cn', 'node-a', CHANNEL_ID)
    expect(input).toBe(
      `${HANDSHAKE_SIGNATURE_DOMAIN}\n${JSON.stringify([1, 'sn', 'cn', 'node-a', CHANNEL_ID])}`,
    )
  })

  test('the two directions can never be confused for one another', () => {
    // Six fields against five: a dialer's signature is not a well-formed
    // listener signature over *any* tuple, whatever the node segments are.
    const auth = authSigningInput('sn', 'cn', 'node-a', CHANNEL_ID)
    const ready = readySigningInput('sn', 'cn', 'node-a', CHANNEL_ID, 'node-b')
    expect(ready).not.toBe(auth)
    expect(
      verifyBytes(dialerKeys.publicKey, ready, signBytes(dialerKeys, auth)),
    ).toBe(false)
  })

  test('a node name containing a separator cannot forge another tuple', () => {
    // Why the tuple is a JSON array rather than a concatenation: the two
    // spellings below would collide under any separator-joined encoding.
    expect(authSigningInput('sn', 'cn', 'a","b', CHANNEL_ID)).not.toBe(
      authSigningInput('sn', 'cn","b', 'a', CHANNEL_ID),
    )
  })

  test('credential proof has its own domain and cannot alter legacy bytes', () => {
    const legacyAuth = authSigningInput('sn', 'cn', 'node-a', CHANNEL_ID)
    const legacyReady = readySigningInput(
      'sn',
      'cn',
      'node-a',
      CHANNEL_ID,
      'node-b',
    )
    const authProof = authCredentialProofInput(
      'sn',
      'cn',
      'node-a',
      CHANNEL_ID,
      'f1',
      'certificate',
      'f1',
    )
    const readyProof = readyCredentialProofInput(
      'sn',
      'cn',
      'node-a',
      CHANNEL_ID,
      'node-b',
      'f1',
      'certificate',
      'f1',
    )
    expect(legacyAuth).toBe(
      `${HANDSHAKE_SIGNATURE_DOMAIN}\n${JSON.stringify([1, 'sn', 'cn', 'node-a', CHANNEL_ID])}`,
    )
    expect(legacyReady).toBe(
      `${HANDSHAKE_SIGNATURE_DOMAIN}\n${JSON.stringify([1, 'sn', 'cn', 'node-a', CHANNEL_ID, 'node-b'])}`,
    )
    expect(authProof.startsWith(`${HANDSHAKE_CREDENTIAL_PROOF_DOMAIN}\n`)).toBe(
      true,
    )
    expect(readyProof).not.toBe(authProof)
  })
})

describe('credential-bound signatures', () => {
  const credentialDirectory: HandshakeCredentialDirectory = {
    publicKeyOf(node) {
      return directory().publicKeyOf(node)
    },
    handshakeCredentialOf(node, selector) {
      if (
        node === 'node-a' &&
        (selector === 'dialer-f1' || selector === 'dialer-f2')
      ) {
        return {
          publicKey: dialerKeys.publicKey,
          source: 'certificate',
          id: selector,
        }
      }
      if (
        node === 'node-b' &&
        (selector === 'listener-f1' || selector === 'listener-f2')
      ) {
        return {
          publicKey: listenerKeys.publicKey,
          source: 'certificate',
          id: selector,
        }
      }
      return null
    },
  }

  test('Auth migration matrix preserves legacy sig and enforces the second proof', () => {
    const nonce = newNonce()
    const clientNonce = newNonce()
    const credential = 'dialer-f1'
    const legacySig = signBytes(
      dialerKeys,
      authSigningInput(nonce, clientNonce, 'node-a', CHANNEL_ID),
    )
    const legacyAttempt: AuthAttempt = {
      node: 'node-a',
      nonce,
      clientNonce,
      channelId: CHANNEL_ID,
      mac: computeMac(TEST_PSK, nonce, clientNonce, 'node-a', CHANNEL_ID),
      sig: legacySig,
    }
    const attempt: AuthAttempt = {
      ...legacyAttempt,
      credential,
      credentialProof: signBytes(
        dialerKeys,
        authCredentialProofInput(
          nonce,
          clientNonce,
          'node-a',
          CHANNEL_ID,
          credential,
          'certificate',
          credential,
        ),
      ),
    }
    const identity: HandshakeIdentity = {
      keys: listenerKeys,
      directory: credentialDirectory,
      required: true,
      credentialProofRequired: true,
    }
    expect(verifyAuthAttempt(TEST_PSK, identity, nonce, attempt)).toEqual({
      ok: true,
      node: 'node-a',
      channelId: CHANNEL_ID,
      authentication: 'credential_signature',
      credential: { source: 'certificate', id: credential },
      signingPublicKey: dialerKeys.publicKey,
    })
    // A pre-extension verifier checks the actual sig from the new frame over
    // the base tuple. Unknown extension fields are irrelevant to that check.
    expect(
      verifyBytes(
        dialerKeys.publicKey,
        authSigningInput(nonce, clientNonce, 'node-a', CHANNEL_ID),
        attempt.sig ?? '',
      ),
    ).toBe(true)
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        { ...identity, credentialProofRequired: false },
        nonce,
        legacyAttempt,
      ),
    ).toMatchObject({ ok: true, authentication: 'signature' })
    expect(verifyAuthAttempt(TEST_PSK, identity, nonce, legacyAttempt)).toEqual(
      {
        ok: false,
        rejection: HandshakeRejection.CredentialRequired,
      },
    )
    const { credentialProof: _removed, ...half } = attempt
    expect(verifyAuthAttempt(TEST_PSK, identity, nonce, half)).toEqual({
      ok: false,
      rejection: HandshakeRejection.CredentialRequired,
    })
    const { credential: _removedSelector, ...otherHalf } = attempt
    expect(verifyAuthAttempt(TEST_PSK, identity, nonce, otherHalf)).toEqual({
      ok: false,
      rejection: HandshakeRejection.CredentialRequired,
    })
    expect(
      verifyAuthAttempt(TEST_PSK, identity, nonce, {
        ...attempt,
        credential: 'dialer-f2',
      }),
    ).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadCredentialProof,
    })
    expect(
      verifyAuthAttempt(TEST_PSK, identity, nonce, {
        ...attempt,
        credentialProof: signBytes(
          impostorKeys,
          authCredentialProofInput(
            nonce,
            clientNonce,
            'node-a',
            CHANNEL_ID,
            credential,
            'certificate',
            credential,
          ),
        ),
      }),
    ).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadCredentialProof,
    })
  })

  test('verifies the peer claim but returns the local effective credential', () => {
    const nonce = newNonce()
    const clientNonce = newNonce()
    const selector = 'dialer-certificate-f1'
    const overrideDirectory: HandshakeCredentialDirectory = {
      publicKeyOf: node => (node === 'node-a' ? dialerKeys.publicKey : null),
      handshakeCredentialOf(node, claimedSelector) {
        if (node !== 'node-a' || claimedSelector !== selector) return null
        return {
          publicKey: dialerKeys.publicKey,
          source: 'explicit',
          id: 'node-a',
          proofCredential: { source: 'certificate', id: selector },
        }
      },
    }
    const identity: HandshakeIdentity = {
      keys: listenerKeys,
      credentialProofRequired: true,
      directory: overrideDirectory,
    }
    const attempt: AuthAttempt = {
      node: 'node-a',
      nonce,
      clientNonce,
      channelId: CHANNEL_ID,
      mac: computeMac(TEST_PSK, nonce, clientNonce, 'node-a', CHANNEL_ID),
      sig: signBytes(
        dialerKeys,
        authSigningInput(nonce, clientNonce, 'node-a', CHANNEL_ID),
      ),
      credential: selector,
      credentialProof: signBytes(
        dialerKeys,
        authCredentialProofInput(
          nonce,
          clientNonce,
          'node-a',
          CHANNEL_ID,
          selector,
          'certificate',
          selector,
        ),
      ),
    }

    expect(verifyAuthAttempt(TEST_PSK, identity, nonce, attempt)).toEqual({
      ok: true,
      node: 'node-a',
      channelId: CHANNEL_ID,
      authentication: 'credential_signature',
      credential: { source: 'explicit', id: 'node-a' },
      signingPublicKey: dialerKeys.publicKey,
    })
    expect(
      verifyAuthAttempt(TEST_PSK, identity, nonce, {
        ...attempt,
        credentialProof: signBytes(
          dialerKeys,
          authCredentialProofInput(
            nonce,
            clientNonce,
            'node-a',
            CHANNEL_ID,
            selector,
            'explicit',
            'node-a',
          ),
        ),
      }),
    ).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadCredentialProof,
    })
  })

  test('Ready migration matrix preserves legacy sig and enforces the second proof', () => {
    const tuple = {
      serverNonce: 'sn',
      clientNonce: 'cn',
      node: 'node-a',
      channelId: CHANNEL_ID,
    }
    const listener = {
      node: 'node-b',
      keys: listenerKeys,
      directory: credentialDirectory,
      credential: {
        selector: 'listener-f1',
        source: 'certificate',
        id: 'listener-f1',
      },
    }
    const frame = signReady(
      listener,
      tuple.serverNonce,
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    const dialer: HandshakeIdentity = {
      keys: dialerKeys,
      directory: credentialDirectory,
      required: true,
      credentialProofRequired: true,
    }
    expect(verifyReady('node-b', dialer, tuple, frame)).toEqual({
      ok: true,
      authentication: 'credential_signature',
      credential: { source: 'certificate', id: 'listener-f1' },
    })
    expect(
      verifyBytes(
        listenerKeys.publicKey,
        readySigningInput(
          tuple.serverNonce,
          tuple.clientNonce,
          tuple.node,
          tuple.channelId,
          'node-b',
        ),
        frame.sig,
      ),
    ).toBe(true)
    const legacyFrame = { node: frame.node, sig: frame.sig }
    expect(
      verifyReady(
        'node-b',
        { ...dialer, credentialProofRequired: false },
        tuple,
        legacyFrame,
      ),
    ).toEqual({ ok: true, authentication: 'signature' })
    expect(verifyReady('node-b', dialer, tuple, legacyFrame)).toEqual({
      ok: false,
      rejection: ReadyRejection.CredentialRequired,
    })
    const { credentialProof: _removedProof, ...readyHalf } = frame
    expect(verifyReady('node-b', dialer, tuple, readyHalf)).toEqual({
      ok: false,
      rejection: ReadyRejection.CredentialRequired,
    })
    const { credential: _removedSelector, ...otherReadyHalf } = frame
    expect(verifyReady('node-b', dialer, tuple, otherReadyHalf)).toEqual({
      ok: false,
      rejection: ReadyRejection.CredentialRequired,
    })
    expect(
      verifyReady('node-b', dialer, tuple, {
        ...frame,
        credential: 'listener-f2',
      }),
    ).toEqual({
      ok: false,
      rejection: ReadyRejection.BadCredentialProof,
    })
    expect(
      verifyReady('node-b', dialer, tuple, {
        ...frame,
        credentialProof: signBytes(
          impostorKeys,
          readyCredentialProofInput(
            tuple.serverNonce,
            tuple.clientNonce,
            tuple.node,
            tuple.channelId,
            'node-b',
            'listener-f1',
            'certificate',
            'listener-f1',
          ),
        ),
      }),
    ).toEqual({
      ok: false,
      rejection: ReadyRejection.BadCredentialProof,
    })
  })
})

/**
 * Whether a credential-bearing frame is judged as one — and the whole of this
 * block is the difference between the two questions that decision could be
 * asking. "Can this verifier read credentials at all" is safe to answer with
 * a downgrade; "did this particular credential resolve" is not, and the tests
 * below are here so the second one cannot be substituted for the first by a
 * later edit that looks like a simplification.
 */
describe('credential claims against a verifier that has no view on them', () => {
  const nonce = 'phase-one-server-nonce'
  const clientNonce = 'phase-one-client-nonce'
  const selector = 'dialer-f1'
  const tuple = {
    serverNonce: nonce,
    clientNonce,
    node: 'node-a',
    channelId: CHANNEL_ID,
  }

  /** What a CA-loaded dialer puts on the wire: legacy `sig` *and* the pair. */
  const credentialAttempt: AuthAttempt = {
    node: 'node-a',
    nonce,
    clientNonce,
    channelId: CHANNEL_ID,
    mac: computeMac(TEST_PSK, nonce, clientNonce, 'node-a', CHANNEL_ID),
    sig: signBytes(
      dialerKeys,
      authSigningInput(nonce, clientNonce, 'node-a', CHANNEL_ID),
    ),
    credential: selector,
    credentialProof: signBytes(
      dialerKeys,
      authCredentialProofInput(
        nonce,
        clientNonce,
        'node-a',
        CHANNEL_ID,
        selector,
        'certificate',
        selector,
      ),
    ),
  }

  /** The listener's half of the same frame shape. */
  const credentialReady = signReady(
    {
      node: 'node-b',
      keys: listenerKeys,
      directory: directory(),
      credential: {
        selector: 'listener-f1',
        source: 'certificate',
        id: 'listener-f1',
      },
    },
    tuple.serverNonce,
    tuple.clientNonce,
    tuple.node,
    tuple.channelId,
  )

  /**
   * A verifier that *does* understand credentials and refuses this one —
   * a revoked certificate, or a selector it has never heard of — while the
   * bare key stays reachable through `publicKeyOf`, because an explicit
   * `--trust` row still pins it. That combination is not hypothetical: §6.4
   * records it as a hard edge of revocation, and it is exactly the state in
   * which a fallback would become a bypass.
   */
  const revoking: HandshakeCredentialDirectory = {
    publicKeyOf(node) {
      return directory().publicKeyOf(node)
    },
    handshakeCredentialOf() {
      return null
    },
  }

  test('a `--trust`-only listener reads it as the signed frame it also is', () => {
    // §8.2 phase ① is defined as the two loading mechanisms coexisting. This
    // listener holds no view on credentials at all, and it is holding the key
    // that checks `sig` — so the frame carries, for it, precisely what a
    // legacy signed frame carries. Refusing it would mean the first node to
    // gain a certificate loses every peer that has not gained one yet.
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        { keys: listenerKeys, directory: directory() },
        nonce,
        credentialAttempt,
      ),
    ).toEqual({
      ok: true,
      node: 'node-a',
      channelId: CHANNEL_ID,
      // Recorded as `signature`, never `credential_signature`: nothing here
      // checked a credential, so nothing may claim one (§7.1's three-way
      // recording rule).
      authentication: 'signature',
      signingPublicKey: dialerKeys.publicKey,
    })
  })

  test('a listener that does understand them refuses one it cannot resolve', () => {
    // Same frame, same key, opposite verdict — and this is the pair that has
    // to stay a pair. Falling back here would hand a revoked certificate
    // holder a way back in: offer a credential that does not resolve, and be
    // re-admitted on the bare key that is still pinned. "Send garbage" must
    // not be a downgrade primitive.
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        { keys: listenerKeys, directory: revoking },
        nonce,
        credentialAttempt,
      ),
    ).toEqual({ ok: false, rejection: HandshakeRejection.UnknownSigner })
  })

  test('`credentialProofRequired` vetoes the fallback, globally and per peer', () => {
    // Policy that evaporates when the directory turns out to be the wrong
    // shape is not policy. A verifier that demands the exact proof and cannot
    // check one refuses; it does not quietly accept a weaker thing.
    for (const policy of [
      { credentialProofRequired: true },
      { credentialProofRequiredPeers: new Set(['node-a']) },
    ]) {
      expect(
        verifyAuthAttempt(
          TEST_PSK,
          { keys: listenerKeys, directory: directory(), ...policy },
          nonce,
          credentialAttempt,
        ),
      ).toEqual({ ok: false, rejection: HandshakeRejection.UnknownSigner })
    }
    // A pin on some *other* peer leaves this one on the coexistence path.
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        {
          keys: listenerKeys,
          directory: directory(),
          credentialProofRequiredPeers: new Set(['node-z']),
        },
        nonce,
        credentialAttempt,
      ),
    ).toMatchObject({ ok: true, authentication: 'signature' })
  })

  test('the dialer half of the decision is the same three answers', () => {
    // `verifyReady` must not diverge from `verifyAuthAttempt` here: a fleet
    // upgraded one node at a time meets both directions of this case.
    expect(
      verifyReady(
        'node-b',
        { keys: dialerKeys, directory: directory() },
        tuple,
        credentialReady,
      ),
    ).toEqual({ ok: true, authentication: 'signature' })
    expect(
      verifyReady(
        'node-b',
        { keys: dialerKeys, directory: revoking },
        tuple,
        credentialReady,
      ),
    ).toEqual({ ok: false, rejection: ReadyRejection.UnknownSigner })
    expect(
      verifyReady(
        'node-b',
        {
          keys: dialerKeys,
          directory: directory(),
          credentialProofRequired: true,
        },
        tuple,
        credentialReady,
      ),
    ).toEqual({ ok: false, rejection: ReadyRejection.UnknownSigner })
  })
})

describe('verifyAuthAttempt — which proof is taken', () => {
  test('no signing material: the MAC decides, and `sig` is not read', () => {
    const nonce = newNonce()
    // A signature by a total stranger, on a listener with no directory: it is
    // not merely unchecked, there is nothing here that could check it, and the
    // MAC is still what the frame lives or dies by.
    const attempt = signedAttempt(nonce, {}, impostorKeys)
    expect(verifyAuthAttempt(TEST_PSK, undefined, nonce, attempt)).toEqual({
      ok: true,
      node: 'node-a',
      channelId: CHANNEL_ID,
      authentication: 'psk',
    })
    expect(verifyAuthAttempt(WRONG_PSK, undefined, nonce, attempt)).toEqual({
      ok: false,
      rejection: HandshakeRejection.BadMac,
    })
  })

  test('signing material and a signature: the signature decides, not the MAC', () => {
    const nonce = newNonce()
    const attempt = signedAttempt(nonce, { mac: 'f'.repeat(64) })
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, attempt),
    ).toEqual({
      ok: true,
      node: 'node-a',
      channelId: CHANNEL_ID,
      authentication: 'signature',
      signingPublicKey: dialerKeys.publicKey,
    })
  })

  test('signing material, no signature: the MAC still decides (§8.2 phase ①)', () => {
    const nonce = newNonce()
    const attempt = signedAttempt(nonce, { sig: undefined })
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, attempt),
    ).toEqual({
      ok: true,
      node: 'node-a',
      channelId: CHANNEL_ID,
      authentication: 'psk',
    })
  })

  test('signing material with `required`: an unsigned frame is refused', () => {
    const nonce = newNonce()
    const attempt = signedAttempt(nonce, { sig: undefined })
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(true), nonce, attempt),
    ).toEqual({ ok: false, rejection: HandshakeRejection.SignatureRequired })
  })

  test('a stripped auth is PSK-only unless this upgraded peer is pinned', () => {
    const nonce = newNonce()
    const signed = signedAttempt(nonce)
    // The MAC still covers the same tuple, so an on-path field deletion needs
    // no key and no recomputation. Optional mode must report the fallback;
    // deployment policy, not a false cryptographic claim, is what rejects it.
    const stripped = { ...signed, sig: undefined }
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, stripped),
    ).toMatchObject({ ok: true, authentication: 'psk' })
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        { ...listenerIdentity(), requiredPeers: new Set(['node-a']) },
        nonce,
        stripped,
      ),
    ).toEqual({ ok: false, rejection: HandshakeRejection.SignatureRequired })
  })
})

describe('verifyAuthAttempt — the signature itself', () => {
  test('a signature by another key over the same tuple is refused', () => {
    const nonce = newNonce()
    const attempt = signedAttempt(nonce, {}, impostorKeys)
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, attempt),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadSignature })
  })

  test('`node` is authority: a valid signature cannot be moved onto another name', () => {
    // The whole of DoD 4. `node-a` signs its own tuple, then the frame claims
    // to be `node-b` — which is what a PSK holder gets away with today.
    const nonce = newNonce()
    const clientNonce = newNonce()
    const attempt: AuthAttempt = {
      node: 'node-b',
      nonce,
      clientNonce,
      channelId: CHANNEL_ID,
      mac: computeMac(TEST_PSK, nonce, clientNonce, 'node-b', CHANNEL_ID),
      sig: signBytes(
        dialerKeys,
        authSigningInput(nonce, clientNonce, 'node-a', CHANNEL_ID),
      ),
    }
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, attempt),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadSignature })
    // And the MAC alone would have let it through — that is the difference the
    // signature buys.
    expect(verifyAuthAttempt(TEST_PSK, undefined, nonce, attempt)).toEqual({
      ok: true,
      node: 'node-b',
      channelId: CHANNEL_ID,
      authentication: 'psk',
    })
  })

  test('a node with no published key is refused, distinctly, in the record', () => {
    const nonce = newNonce()
    const identity: HandshakeIdentity = {
      keys: listenerKeys,
      directory: new StaticPublicKeyDirectory(),
    }
    expect(
      verifyAuthAttempt(TEST_PSK, identity, nonce, signedAttempt(nonce)),
    ).toEqual({ ok: false, rejection: HandshakeRejection.UnknownSigner })
  })

  test('a signature made for another channel or nonce does not travel', () => {
    const nonce = newNonce()
    const other = newNonce()
    const clientNonce = newNonce()
    const replayed: AuthAttempt = {
      node: 'node-a',
      nonce,
      clientNonce,
      channelId: CHANNEL_ID,
      mac: computeMac(TEST_PSK, nonce, clientNonce, 'node-a', CHANNEL_ID),
      sig: signBytes(
        dialerKeys,
        authSigningInput(other, clientNonce, 'node-a', CHANNEL_ID),
      ),
    }
    expect(
      verifyAuthAttempt(TEST_PSK, listenerIdentity(), nonce, replayed),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadSignature })
  })

  test('the cheap structural checks still run first, signed or not', () => {
    const nonce = newNonce()
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        listenerIdentity(),
        nonce,
        signedAttempt(nonce, { node: 'not a segment' }),
      ),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadNode })
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        listenerIdentity(),
        nonce,
        signedAttempt(nonce, { channelId: 'short' }),
      ),
    ).toEqual({ ok: false, rejection: HandshakeRejection.BadChannel })
    expect(
      verifyAuthAttempt(
        TEST_PSK,
        listenerIdentity(),
        nonce,
        signedAttempt(nonce, { nonce: newNonce() }),
      ),
    ).toEqual({ ok: false, rejection: HandshakeRejection.NonceMismatch })
  })
})

describe('verifyReady — the listener proves itself back (§7.1.1)', () => {
  const tuple = {
    serverNonce: 'sn',
    clientNonce: 'cn',
    node: 'node-a',
    channelId: CHANNEL_ID,
  }
  const dialerIdentity = (required = false): HandshakeIdentity => ({
    keys: dialerKeys,
    directory: directory(),
    required,
  })

  test('accepts the listener it dialled', () => {
    const frame = signReady(
      listenerIdentity(),
      tuple.serverNonce,
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    expect(verifyReady('node-b', dialerIdentity(), tuple, frame)).toEqual({
      ok: true,
      authentication: 'signature',
    })
  })

  test('an endpoint that answers as somebody else is refused (T-B′)', () => {
    // The redirect case: a node inside the network, holding a valid
    // certificate, answering a dial meant for `node-b`. It signs perfectly —
    // as itself — and that is exactly why it fails.
    const frame = signReady(
      { node: 'node-c', keys: impostorKeys, directory: directory() },
      tuple.serverNonce,
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    expect(verifyReady('node-b', dialerIdentity(), tuple, frame)).toEqual({
      ok: false,
      rejection: ReadyRejection.WrongNode,
    })
  })

  test('claiming the dialled name without the key is refused', () => {
    const frame = signReady(
      { node: 'node-b', keys: impostorKeys, directory: directory() },
      tuple.serverNonce,
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    expect(verifyReady('node-b', dialerIdentity(), tuple, frame)).toEqual({
      ok: false,
      rejection: ReadyRejection.BadSignature,
    })
  })

  test('a signature over a different tuple does not carry over', () => {
    const frame = signReady(
      listenerIdentity(),
      'another-nonce',
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    expect(verifyReady('node-b', dialerIdentity(), tuple, frame)).toEqual({
      ok: false,
      rejection: ReadyRejection.BadSignature,
    })
  })

  test('an unsigned ready is opportunistic PSK and is refused with `required`', () => {
    expect(verifyReady('node-b', dialerIdentity(), tuple, {})).toEqual({
      ok: true,
      authentication: 'psk',
    })
    expect(verifyReady('node-b', dialerIdentity(true), tuple, {})).toEqual({
      ok: false,
      rejection: ReadyRejection.Unsigned,
    })
    // Half a declaration is not a declaration: a `node` with no signature is
    // the unsigned case, not a weaker signed one.
    expect(
      verifyReady('node-b', dialerIdentity(true), tuple, { node: 'node-b' }),
    ).toEqual({ ok: false, rejection: ReadyRejection.Unsigned })
  })

  test('a stripped ready is PSK-only unless this upgraded peer is pinned', () => {
    // Deleting both optional fields leaves the auth MAC untouched; this is the
    // opposite direction of the auth-frame stripping test above.
    const stripped = {}
    expect(verifyReady('node-b', dialerIdentity(), tuple, stripped)).toEqual({
      ok: true,
      authentication: 'psk',
    })
    expect(
      verifyReady(
        'node-b',
        { ...dialerIdentity(), requiredPeers: new Set(['node-b']) },
        tuple,
        stripped,
      ),
    ).toEqual({ ok: false, rejection: ReadyRejection.Unsigned })
  })

  test('a listener whose key is not published yet is refused', () => {
    const frame = signReady(
      listenerIdentity(),
      tuple.serverNonce,
      tuple.clientNonce,
      tuple.node,
      tuple.channelId,
    )
    const empty: HandshakeIdentity = {
      keys: dialerKeys,
      directory: new StaticPublicKeyDirectory(),
    }
    expect(verifyReady('node-b', empty, tuple, frame)).toEqual({
      ok: false,
      rejection: ReadyRejection.UnknownSigner,
    })
  })
})
