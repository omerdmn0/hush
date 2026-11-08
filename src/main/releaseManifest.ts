import { createHash, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'
import { createReadStream } from 'node:fs'

// The proof that a release came from whoever holds the signing key, which never leaves the
// release computer. GitHub's own hash only proves the file matches the release next to it.
// Also imported by scripts/release.mjs, so it has to stay runnable by plain Node.

/** Uploaded next to the installers of every release. */
export const RELEASE_FILE = 'hush-release.json'

export async function sha512File(path: string): Promise<string> {
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** The contents of RELEASE_FILE. `files` maps each installer's name to its SHA-512. */
export function signRelease(version: string, files: Record<string, string>, privateKey: KeyObject): string {
  const manifest = JSON.stringify({ version, files })
  return JSON.stringify({ manifest, signature: sign(null, Buffer.from(manifest), privateKey).toString('base64') }, null, 2) + '\n'
}

/**
 * True only if RELEASE_FILE is signed by `publicKey` (base64 SPKI) and lists exactly this
 * installer for exactly this version, so an old signed release can't be passed off as new.
 */
export function releaseAllows(published: string, publicKey: string, version: string, sha512: string): boolean {
  try {
    const { manifest, signature } = JSON.parse(published) as { manifest: string; signature: string }
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
    if (!verify(null, Buffer.from(manifest), key, Buffer.from(signature, 'base64'))) return false
    const signed = JSON.parse(manifest) as { version: string; files: Record<string, string> }
    return signed.version === version && Object.values(signed.files).includes(sha512)
  } catch {
    return false
  }
}
