import type { AudioApp } from '../shared/types'

/**
 * Screen audio on Linux, through PipeWire. Electron can't capture system audio here, and the
 * Wayland screen-share portal carries video only, so Hush does it with PipeWire's own tools:
 *
 *   1. one temporary virtual source ("Hush-screen-audio"), which Hush records like a microphone;
 *   2. links from the chosen apps' outputs into it. A link is added next to the app's normal
 *      output, so you keep hearing everything as usual.
 *
 * Hush's own processes are never linked, so the call doesn't echo back to the other person.
 * No extra software or native code: `pactl`, `pw-dump` and `pw-link` come with PipeWire.
 */

export const SOURCE_NAME = 'hush_screen_audio'
/** No spaces: the module's argument parser cuts a description off at the first one. */
export const SOURCE_LABEL = 'Hush-screen-audio'
/** New streams (a video starting, a new tab) are picked up this often. */
const SYNC_MS = 1500

/** Runs a command and resolves with its stdout (rejects if it fails). */
export type Run = (cmd: string, args: string[]) => Promise<string>

interface DumpObject {
  id: number
  type: string
  info?: { direction?: string; props?: Record<string, unknown> }
}

export interface AudioStream {
  node: number
  key: string
  name: string
  pid: number | null
}

/** Streams currently playing, leaving out Hush itself. */
export function playingStreams(dump: DumpObject[], ownPids: ReadonlySet<number>): AudioStream[] {
  const out: AudioStream[] = []
  for (const o of dump) {
    const p = o.info?.props
    if (o.type !== 'PipeWire:Interface:Node' || p?.['media.class'] !== 'Stream/Output/Audio') continue
    const pid = typeof p['application.process.id'] === 'number' ? p['application.process.id'] : null
    if (pid !== null && ownPids.has(pid)) continue
    const name = String(p['application.name'] ?? p['node.name'] ?? 'Unknown app')
    // Not every app reports its binary (pw-play doesn't), so fall back to its name.
    out.push({ node: o.id, key: String(p['application.process.binary'] ?? name), name, pid })
  }
  return out
}

/** The apps to offer, one entry each however many streams they have open. */
export function audioApps(streams: readonly AudioStream[]): AudioApp[] {
  const byKey = new Map<string, AudioApp>()
  for (const s of streams) if (!byKey.has(s.key)) byKey.set(s.key, { key: s.key, name: s.name })
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function ports(dump: DumpObject[], node: number, direction: 'input' | 'output'): Map<string, number> {
  const out = new Map<string, number>()
  for (const o of dump) {
    const p = o.info?.props
    if (o.type === 'PipeWire:Interface:Port' && p?.['node.id'] === node && o.info?.direction === direction) out.set(String(p['audio.channel'] ?? 'MONO'), o.id)
  }
  return out
}

function sourceNode(dump: DumpObject[]): number | null {
  return dump.find((o) => o.type === 'PipeWire:Interface:Node' && o.info?.props?.['node.name'] === SOURCE_NAME)?.id ?? null
}

/** Port pairs to link `stream` into the virtual source. A mono stream goes to both channels. */
export function linkPairs(dump: DumpObject[], stream: number, source: number): [number, number][] {
  const from = ports(dump, stream, 'output')
  const to = ports(dump, source, 'input')
  const pairs: [number, number][] = []
  for (const [channel, port] of from) {
    if (to.has(channel)) pairs.push([port, to.get(channel)!])
    else if (from.size === 1) for (const target of to.values()) pairs.push([port, target])
  }
  return pairs
}

const existingLinks = (dump: DumpObject[]): Set<string> => {
  const out = new Set<string>()
  for (const o of dump) {
    const p = o.info?.props
    if (o.type === 'PipeWire:Interface:Link') out.add(`${String(p?.['link.output.port'])}:${String(p?.['link.input.port'])}`)
  }
  return out
}

export class LinuxScreenAudio {
  private module: string | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private target = 'all'

  constructor(
    private readonly run: Run,
    private readonly ownPids: () => Set<number>
  ) {}

  private async dump(): Promise<DumpObject[]> {
    return JSON.parse(await this.run('pw-dump', [])) as DumpObject[]
  }

  /** Null if it works here, otherwise why not. */
  async problem(): Promise<string | null> {
    try {
      if (!/PipeWire/i.test(await this.run('pactl', ['info']))) return 'Screen audio needs PipeWire, and this computer uses PulseAudio.'
      await this.run('pw-link', ['--version'])
      await this.run('pw-dump', ['--version'])
      return null
    } catch {
      return 'Screen audio needs PipeWire (pactl, pw-dump and pw-link were not found).'
    }
  }

  async apps(): Promise<AudioApp[]> {
    return audioApps(playingStreams(await this.dump(), this.ownPids()))
  }

  /** Removes a virtual source left behind by a crash. */
  async removeLeftovers(): Promise<void> {
    const list = await this.run('pactl', ['list', 'short', 'modules'])
    for (const line of list.split('\n')) {
      if (line.includes(`sink_name=${SOURCE_NAME}`)) await this.run('pactl', ['unload-module', line.split(/\s+/)[0]])
    }
  }

  async start(target: string): Promise<void> {
    await this.stop()
    await this.removeLeftovers()
    this.target = target
    const out = await this.run('pactl', [
      'load-module',
      'module-null-sink',
      'media.class=Audio/Source/Virtual',
      `sink_name=${SOURCE_NAME}`,
      'channel_map=front-left,front-right',
      `sink_properties=device.description=${SOURCE_LABEL}`
    ])
    this.module = out.trim()
    await this.sync()
    this.timer = setInterval(() => void this.sync().catch(() => {}), SYNC_MS)
  }

  /** Links whatever should be shared and isn't yet. */
  async sync(): Promise<void> {
    const dump = await this.dump()
    const source = sourceNode(dump)
    if (source === null) return
    const linked = existingLinks(dump)
    for (const s of playingStreams(dump, this.ownPids())) {
      if (this.target !== 'all' && s.key !== this.target) continue
      for (const [from, to] of linkPairs(dump, s.node, source)) {
        if (!linked.has(`${from}:${to}`)) await this.run('pw-link', [String(from), String(to)]).catch(() => {}) // the stream may just have ended
      }
    }
  }

  /** Unloading the module removes the source and all its links. */
  async stop(): Promise<void> {
    clearInterval(this.timer)
    const module = this.module
    this.module = null
    if (module) await this.run('pactl', ['unload-module', module]).catch(() => {})
  }
}
