import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WindowsScreenAudio, type HelperCommand } from './screenAudioWindows'

// A stand-in for the real helper, which only runs on Windows. Tests the contract around it.
const dir = mkdtempSync(join(tmpdir(), 'hush-helper-'))
const script = (name: string, code: string): ((pid: number) => HelperCommand) => {
  const file = join(dir, name)
  writeFileSync(file, code)
  return (pid) => ({ file: process.execPath, args: [file, String(pid)] })
}

describe('WindowsScreenAudio', () => {
  it('passes on audio after "ready", and the helper exits when stopped', async () => {
    const got: Buffer[] = []
    const cmd = script(
      'ok.js',
      `process.stderr.write('ready\\n'); const t=setInterval(()=>process.stdout.write(Buffer.from(process.argv[2])),10); process.stdin.on('end',()=>{clearInterval(t);process.exit(0)}); process.stdin.resume()`
    )
    const a = new WindowsScreenAudio(cmd, (b) => got.push(b))
    await a.start(4242)
    await new Promise((r) => setTimeout(r, 120))
    expect(Buffer.concat(got).toString()).toContain('4242') // told which process to leave out
    a.stop()
  })

  it('reports why it could not start', async () => {
    const a = new WindowsScreenAudio(script('bad.js', `process.stderr.write('error: activating process loopback (0x80070005)\\n'); process.exit(1)`), () => {})
    await expect(a.start(1)).rejects.toThrow(/activating process loopback/)
    const missing = new WindowsScreenAudio(() => ({ file: join(dir, 'nope.exe'), args: [] }), () => {})
    await expect(missing.start(1)).rejects.toThrow()
    rmSync(dir, { recursive: true, force: true })
  })
})
