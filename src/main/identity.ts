import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomInt, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto'

/**
 * This install's long-term identity (Ed25519) and the other person's pinned key.
 * Keys are exchanged as base64url-encoded raw 32-byte public keys.
 */
export class Identity {
  readonly publicKey: string
  private readonly privateKey: KeyObject

  constructor(privatePkcs8: string) {
    this.privateKey = createPrivateKey({ key: Buffer.from(privatePkcs8, 'base64'), format: 'der', type: 'pkcs8' })
    this.publicKey = createPublicKey(this.privateKey).export({ format: 'jwk' }).x as string
  }

  /** A fresh identity; returns the private key to store. */
  static generate(): string {
    const { privateKey } = generateKeyPairSync('ed25519')
    return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
  }

  /** Proof for one connection: our signature over the other side's nonce and both keys. */
  authSignature(peerNonce: string, peerKey: string): string {
    return sign(null, authTranscript(peerNonce, this.publicKey, peerKey), this.privateKey).toString('base64url')
  }
}

/** The signed message: the verifier's nonce, then signer key, then verifier key. */
function authTranscript(verifierNonce: string, signerKey: string, verifierKey: string): Buffer {
  return Buffer.from(`hush-auth-v1|${verifierNonce}|${signerKey}|${verifierKey}`)
}

/** Checks the other side's `auth` signature against the key we pinned at pairing. */
export function verifyAuth(sig: string, myNonce: string, peerKey: string, myKey: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: peerKey }, format: 'jwk' })
    return verify(null, authTranscript(myNonce, peerKey, myKey), key, Buffer.from(sig, 'base64url'))
  } catch {
    return false
  }
}

export const newNonce = (): string => randomBytes(32).toString('base64url')

/** Short, human-comparable fingerprint of a public key: "3F2A 9C10 7B44 E01D". */
export function fingerprint(key: string): string {
  const hex = Buffer.from(key, 'base64url').subarray(0, 8).toString('hex').toUpperCase()
  return hex.match(/.{4}/g)!.join(' ')
}

// ---------- pairing codes ----------

/** No 0/O, 1/I/L: easy to read aloud and type. 31 symbols × 8 ≈ 40 bits. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const CODE_LENGTH = 8

export function newPairingCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return code
}

/** "k7p4-qx9m " → "K7P4QX9M". */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '')
}

export const formatCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`

/**
 * Proof that the person who typed `code` saw it on the owner's screen, bound to both keys
 * so it can't be replayed for a different device.
 */
export function pairingProof(code: string, ownerKey: string, typerKey: string): string {
  return createHmac('sha256', normalizeCode(code)).update(`hush-pair-v1|${ownerKey}|${typerKey}`).digest('base64url')
}

export function proofMatches(mac: string, code: string, ownerKey: string, typerKey: string): boolean {
  const expected = Buffer.from(pairingProof(code, ownerKey, typerKey), 'base64url')
  const got = Buffer.from(mac, 'base64url')
  return got.length === expected.length && timingSafeEqual(got, expected)
}
