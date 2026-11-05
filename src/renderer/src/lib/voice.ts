import { MAX_VOICE_MS, VOICE_PEAKS } from '../../../shared/protocol'
import { getMic } from './call'

export interface VoiceNote {
  bytes: Uint8Array
  durationMs: number
  peaks: Uint8Array
}

export interface VoiceRecording {
  /** performance.now() when recording started. */
  startedAt: number
  /** Stops and returns the note (null if it was too short to be meant). */
  stop(): Promise<VoiceNote | null>
  /** Stops and throws it away. */
  cancel(): void
}

/** Shorter than this counts as an accidental click. */
const MIN_MS = 500

/** Records a voice note (WebM/Opus) from the chosen microphone; stops by itself at 5 minutes. */
export async function recordVoice(micId: string, onLimit: () => void): Promise<VoiceRecording> {
  const stream = await getMic(micId)
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
  const rec = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 })
  const parts: Blob[] = []
  rec.ondataavailable = (e) => e.data.size > 0 && parts.push(e.data)
  const startedAt = performance.now()
  rec.start(1000)
  const limit = setTimeout(onLimit, MAX_VOICE_MS)

  let stopping: Promise<void> | null = null
  const stopRecorder = (): Promise<void> =>
    (stopping ??= new Promise<void>((resolve) => {
      clearTimeout(limit)
      rec.onstop = () => resolve()
      if (rec.state === 'inactive') resolve()
      else rec.stop()
    }).finally(() => stream.getTracks().forEach((t) => t.stop())))

  return {
    startedAt,
    async stop() {
      const durationMs = Math.min(MAX_VOICE_MS, Math.round(performance.now() - startedAt))
      await stopRecorder()
      if (durationMs < MIN_MS || parts.length === 0) return null
      const bytes = new Uint8Array(await new Blob(parts, { type: 'audio/webm' }).arrayBuffer())
      return { bytes, durationMs, peaks: await waveform(bytes) }
    },
    cancel() {
      void stopRecorder()
    }
  }
}

/** Loudness in VOICE_PEAKS bars (0–255), for drawing the note. Empty if it can't be decoded. */
export async function waveform(bytes: Uint8Array, bars = VOICE_PEAKS): Promise<Uint8Array> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 48_000)
    const audio = await ctx.decodeAudioData(bytes.slice().buffer)
    const data = audio.getChannelData(0)
    const step = Math.max(1, Math.floor(data.length / bars))
    const raw: number[] = []
    for (let i = 0; i < bars; i++) {
      let peak = 0
      for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) peak = Math.max(peak, Math.abs(data[j]))
      raw.push(peak)
    }
    const max = Math.max(...raw)
    return Uint8Array.from(raw, (v) => (max > 0 ? Math.round((v / max) * 255) : 0))
  } catch {
    return new Uint8Array(0)
  }
}

/** "0:42" */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
