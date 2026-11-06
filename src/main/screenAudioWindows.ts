import { spawn, type ChildProcess } from 'node:child_process'

/**
 * Screen audio on Windows, through the helper program (native/windows). WORK IN PROGRESS: it has
 * not run on a real Windows PC yet. Electron's own capture can't leave Hush out, so the other
 * person would hear their voice back; the helper asks Windows for everything except Hush.
 *
 * The helper writes raw audio (s16le, stereo, 48 kHz) to stdout and exits when its stdin closes.
 */

/** Waits this long for the helper to report that it's capturing. */
const START_TIMEOUT_MS = 6000

export interface HelperCommand {
  file: string
  args: string[]
  env?: NodeJS.ProcessEnv
}

export class WindowsScreenAudio {
  private child: ChildProcess | null = null

  constructor(
    private readonly command: (excludePid: number) => HelperCommand,
    private readonly onPcm: (pcm: Buffer) => void
  ) {}

  /** Resolves once audio is being captured; rejects with the reason if it can't be. */
  start(excludePid: number): Promise<void> {
    this.stop()
    const { file, args, env } = this.command(excludePid)
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
    this.child = child
    child.stdout.on('data', (pcm: Buffer) => this.onPcm(pcm))
    child.stdin.on('error', () => {}) // it may already have exited
    return new Promise((resolve, reject) => {
      let log = ''
      const timer = setTimeout(() => {
        this.stop()
        reject(new Error('The audio helper didn’t start'))
      }, START_TIMEOUT_MS)
      const done = (error?: Error): void => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      child.stderr.on('data', (d: Buffer) => {
        log += d.toString()
        if (/^ready$/m.test(log)) done()
      })
      child.on('error', (e) => done(e))
      child.on('exit', () => {
        if (this.child === child) this.child = null
        done(new Error(log.match(/error: (.*)/)?.[1] ?? 'The audio helper stopped'))
      })
    })
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (!child) return
    child.stdin?.end()
    setTimeout(() => child.kill(), 1000).unref()
  }
}
