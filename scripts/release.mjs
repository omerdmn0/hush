// Signs and publishes Hush releases. Run on the release computer, never on GitHub:
//   npm run release:keygen          creates the signing key (once) and writes the public half
//   npm run release:publish v1.2.3  signs the draft release CI built, then publishes it
//   node scripts/release.mjs sign <folder> <version>   only writes the signature file
import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { RELEASE_FILE, sha512File, signRelease } from '../src/main/releaseManifest.ts'

const KEY_FILE = process.env.HUSH_SIGNING_KEY || join(homedir(), '.config', 'hush-release', 'signing-key.json')
const PUBLIC_KEY_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'updateKey.ts')
const SCRYPT = { N: 2 ** 17, r: 8, p: 1, maxmem: 2 ** 28 }
const INSTALLER = /\.(exe|AppImage|deb)$/
const EXPECTED_ASSETS = ['latest.yml', 'latest-linux.yml']

function fail(message) {
  console.error(message)
  process.exit(1)
}

async function askPassphrase(prompt) {
  if (process.env.HUSH_SIGNING_PASSPHRASE) return process.env.HUSH_SIGNING_PASSPHRASE
  if (!process.stdin.isTTY) fail('Run this in a terminal: it needs to ask for the passphrase.')
  process.stdout.write(prompt)
  const hidden = new Writable({ write: (_chunk, _encoding, done) => done() })
  const rl = createInterface({ input: process.stdin, output: hidden, terminal: true })
  const answer = await rl.question('')
  rl.close()
  process.stdout.write('\n')
  return answer
}

const publicKeyText = (key) => createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64')

async function keygen() {
  if (existsSync(KEY_FILE)) fail(`${KEY_FILE} already exists. Replacing it would make every installed Hush refuse new updates.`)
  const passphrase = await askPassphrase('New passphrase for the signing key: ')
  if (passphrase.length < 12) fail('Use at least 12 characters.')
  if (passphrase !== (await askPassphrase('Repeat it: '))) fail('The passphrases differ.')

  const { privateKey } = generateKeyPairSync('ed25519')
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32, SCRYPT), iv)
  const data = Buffer.concat([cipher.update(privateKey.export({ format: 'der', type: 'pkcs8' })), cipher.final()])
  const sealed = { salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }

  mkdirSync(dirname(KEY_FILE), { recursive: true, mode: 0o700 })
  writeFileSync(KEY_FILE, JSON.stringify(sealed, null, 2) + '\n', { mode: 0o600 })
  writeFileSync(
    PUBLIC_KEY_SOURCE,
    `// Public half of the release signing key (base64 SPKI). Written by \`npm run release:keygen\`.\nexport const UPDATE_PUBLIC_KEY = '${publicKeyText(privateKey)}'\n`
  )
  console.log(`Signing key: ${KEY_FILE}\nPublic key written to src/main/updateKey.ts: commit it.`)
  console.log('Back the key file and passphrase up somewhere safe, away from GitHub. Without them, new updates can’t be signed.')
}

async function loadKey() {
  if (!existsSync(KEY_FILE)) fail(`No signing key at ${KEY_FILE}. Run npm run release:keygen first.`)
  const sealed = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
  const field = (name) => Buffer.from(sealed[name], 'base64')
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(await askPassphrase('Signing key passphrase: '), field('salt'), 32, SCRYPT), field('iv'))
  decipher.setAuthTag(field('tag'))
  try {
    const der = Buffer.concat([decipher.update(field('data')), decipher.final()])
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    if (!readFileSync(PUBLIC_KEY_SOURCE, 'utf8').includes(publicKeyText(key))) fail('This key doesn’t match src/main/updateKey.ts, so installed copies would refuse the release.')
    return key
  } catch {
    fail('Wrong passphrase.')
  }
}

async function sign(folder, version, key) {
  const installers = readdirSync(folder).filter((name) => INSTALLER.test(name))
  if (installers.length === 0) fail(`No installers in ${folder}.`)
  const files = {}
  for (const name of installers) files[name] = await sha512File(join(folder, name))
  writeFileSync(join(folder, RELEASE_FILE), signRelease(version, files, key))
  console.log(`Signed ${installers.join(', ')} as version ${version}.`)
}

async function publish(tag) {
  if (!/^v\d+\.\d+\.\d+/.test(tag ?? '')) fail('Usage: npm run release:publish v1.2.3')
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' })
  const release = JSON.parse(gh('release', 'view', tag, '--json', 'isDraft,assets'))
  if (!release.isDraft) fail(`${tag} is already published.`)
  const names = release.assets.map((a) => a.name)
  const missing = EXPECTED_ASSETS.filter((name) => !names.includes(name))
  if (missing.length > 0 || !names.some((n) => n.endsWith('.exe')) || !names.some((n) => n.endsWith('.AppImage'))) {
    fail(`The draft is incomplete (it has: ${names.join(', ')}).`)
  }
  const key = await loadKey()
  const folder = mkdtempSync(join(tmpdir(), 'hush-release-'))
  try {
    gh('release', 'download', tag, '--dir', folder)
    await sign(folder, tag.slice(1), key)
    gh('release', 'upload', tag, join(folder, RELEASE_FILE), '--clobber')
    gh('release', 'edit', tag, '--draft=false', '--latest')
    console.log(`Published ${tag}.`)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

const [command, a, b] = process.argv.slice(2)
if (command === 'keygen') await keygen()
else if (command === 'publish') await publish(a)
else if (command === 'sign' && a && b) await sign(a, b, await loadKey())
else fail('Usage: release.mjs keygen | publish <tag> | sign <folder> <version>')
