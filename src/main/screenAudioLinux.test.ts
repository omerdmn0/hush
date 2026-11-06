import { describe, expect, it } from 'vitest'
import { audioApps, LinuxScreenAudio, linkPairs, playingStreams, SOURCE_NAME, type Run } from './screenAudioLinux'

const node = (id: number, props: Record<string, unknown>) => ({ id, type: 'PipeWire:Interface:Node', info: { props } })
const port = (id: number, nodeId: number, direction: string, channel: string) => ({
  id,
  type: 'PipeWire:Interface:Port',
  info: { direction, props: { 'node.id': nodeId, 'audio.channel': channel } }
})
const stream = (id: number, extra: Record<string, unknown>) => node(id, { 'media.class': 'Stream/Output/Audio', ...extra })

// Shaped like real `pw-dump` output from PipeWire 1.6.
const DUMP = [
  stream(76, { 'node.name': 'Firefox', 'application.name': 'Firefox', 'application.process.binary': 'firefox', 'application.process.id': 4162 }),
  stream(77, { 'node.name': 'Firefox', 'application.name': 'Firefox', 'application.process.binary': 'firefox', 'application.process.id': 4162 }),
  stream(80, { 'node.name': 'Chromium', 'application.name': 'Chromium', 'application.process.binary': 'hush', 'application.process.id': 999 }),
  stream(94, { 'node.name': 'pw-play', 'application.name': 'pw-play' }), // no binary or pid
  node(60, { 'media.class': 'Audio/Sink', 'node.name': 'headset' }),
  node(83, { 'media.class': 'Audio/Source/Virtual', 'node.name': SOURCE_NAME }),
  port(84, 83, 'input', 'FL'),
  port(85, 83, 'input', 'FR'),
  port(86, 83, 'output', 'FL'),
  port(96, 76, 'output', 'FL'),
  port(98, 76, 'output', 'FR'),
  port(99, 94, 'output', 'MONO'),
  { id: 200, type: 'PipeWire:Interface:Link', info: { props: { 'link.output.port': 96, 'link.input.port': 84 } } }
]

describe('choosing what to share', () => {
  it('lists playing apps once each and never Hush itself', () => {
    const streams = playingStreams(DUMP, new Set([999]))
    expect(streams.map((s) => s.node)).toEqual([76, 77, 94])
    expect(audioApps(streams)).toEqual([
      { key: 'firefox', name: 'Firefox' },
      { key: 'pw-play', name: 'pw-play' }
    ])
  })

  it('links channel to channel, and a mono stream to both', () => {
    expect(linkPairs(DUMP, 76, 83)).toEqual([
      [96, 84],
      [98, 85]
    ])
    expect(linkPairs(DUMP, 94, 83)).toEqual([
      [99, 84],
      [99, 85]
    ])
  })
})

describe('LinuxScreenAudio', () => {
  function fake(dump: unknown[] = DUMP): { calls: string[][]; run: Run } {
    const calls: string[][] = []
    const run: Run = async (cmd, args) => {
      calls.push([cmd, ...args])
      if (cmd === 'pw-dump' && args.length === 0) return JSON.stringify(dump)
      if (cmd === 'pactl' && args[0] === 'load-module') return '536870916\n'
      if (cmd === 'pactl' && args[0] === 'list') return `12\tmodule-null-sink\tmedia.class=Audio/Source/Virtual sink_name=${SOURCE_NAME}\n13\tmodule-other\tx\n`
      return ''
    }
    return { calls, run }
  }
  const links = (calls: string[][]): string[] => calls.filter((c) => c[0] === 'pw-link').map((c) => `${c[1]}>${c[2]}`)

  it('shares everything except Hush, skipping links that exist, then removes all of it', async () => {
    const { calls, run } = fake()
    const a = new LinuxScreenAudio(run, () => new Set([999]))
    await a.start('all')
    await a.stop()
    expect(calls).toContainEqual(['pactl', 'unload-module', '12']) // crash leftover
    expect(links(calls)).toEqual(['98>85', '99>84', '99>85']) // 96>84 was already there
    expect(calls[calls.length - 1]).toEqual(['pactl', 'unload-module', '536870916'])
  })

  it('shares one chosen app only', async () => {
    const { calls, run } = fake()
    const a = new LinuxScreenAudio(run, () => new Set())
    await a.start('pw-play')
    await a.stop()
    expect(links(calls)).toEqual(['99>84', '99>85'])
  })

  it('explains itself on plain PulseAudio or without the tools', async () => {
    const pulse: Run = async () => 'Server Name: pulseaudio'
    expect(await new LinuxScreenAudio(pulse, () => new Set()).problem()).toMatch(/PipeWire/)
    const missing: Run = async () => {
      throw new Error('ENOENT')
    }
    expect(await new LinuxScreenAudio(missing, () => new Set()).problem()).toMatch(/not found/)
  })
})
