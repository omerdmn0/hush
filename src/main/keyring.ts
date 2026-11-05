import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveKey, newDataKey, newKdfParams, unwrapKey, wrapKey, type KdfParams } from './vault'

/** The OS keychain (Electron safeStorage in the app; a fake in tests). */
export interface OsProtector {
  /** False when there is no real keychain (e.g. Linux without GNOME Keyring/KWallet). */
  available(): Promise<boolean>
  /** Human name, e.g. "Windows", "GNOME Keyring", "KWallet". */
  name(): string
  encrypt(plain: string): Promise<Buffer>
  decrypt(sealed: Buffer): Promise<string>
}

type VaultFile = { v: 1; mode: 'os'; wrapped: string } | { v: 1; mode: 'password'; wrapped: string; kdf: KdfParams }

export type KeyMode = 'new' | 'os' | 'password'

/**
 * Keeps the data key protected on disk (vault.json): wrapped by the OS keychain, or by a key
 * derived from the app password (scrypt). Never stores the data key in the clear.
 */
export class Keyring {
  private readonly file: string

  constructor(
    dir: string,
    private readonly os: OsProtector
  ) {
    this.file = join(dir, 'vault.json')
  }

  mode(): KeyMode {
    return existsSync(this.file) ? this.read().mode : 'new'
  }

  osAvailable(): Promise<boolean> {
    return this.os.available()
  }

  osName(): string {
    return this.os.name()
  }

  private read(): VaultFile {
    return JSON.parse(readFileSync(this.file, 'utf8')) as VaultFile
  }

  private write(v: VaultFile): void {
    writeFileSync(this.file + '.tmp', JSON.stringify(v))
    renameSync(this.file + '.tmp', this.file)
  }

  /** First start: a new data key protected by the keychain, or by a password if there is none. */
  async create(password?: string): Promise<Buffer> {
    const key = newDataKey()
    await this.protect(key, password)
    return key
  }

  /** (Re-)protects an existing key — after setting/removing the password, or after a restore. */
  async protect(key: Buffer, password?: string): Promise<void> {
    if (password !== undefined) {
      const kdf = newKdfParams()
      this.write({ v: 1, mode: 'password', wrapped: wrapKey(key, deriveKey(password, kdf)), kdf })
    } else {
      if (!(await this.os.available())) throw new Error('No system keychain available — an app password is required')
      this.write({ v: 1, mode: 'os', wrapped: (await this.os.encrypt(key.toString('base64'))).toString('base64') })
    }
  }

  async unlockWithKeychain(): Promise<Buffer> {
    const v = this.read()
    if (v.mode !== 'os') throw new Error('Hush is protected by an app password')
    return Buffer.from(await this.os.decrypt(Buffer.from(v.wrapped, 'base64')), 'base64')
  }

  /** Throws on a wrong password. */
  unlockWithPassword(password: string): Buffer {
    const v = this.read()
    if (v.mode !== 'password') throw new Error('Hush is not protected by an app password')
    return unwrapKey(v.wrapped, deriveKey(password, v.kdf))
  }

  /** After a restore when no keychain is available: the next start asks for a new password. */
  clear(): void {
    rmSync(this.file, { force: true })
  }
}
