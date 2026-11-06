import type { ScreenCapture } from './call'

export interface ShareChoice {
  /** null: the system asks which screen to share. */
  sourceId: string | null
  /** null: no sound; 'all': everything except Hush; otherwise an app's key. */
  audioTarget: string | null
}

const SAMPLE_RATE = 48_000
const BYTES_PER_FRAME = 4 // s16, stereo

/** Screen audio from Linux: the virtual source, recorded as-is (it's music, not speech). */
async function fromVirtualSource(label: string): Promise<MediaStream> {
  for (let tries = 0; tries < 30; tries++) {
    const device = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && d.label === label)
    if (device) {
      return navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: device.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2,
          sampleRate: SAMPLE_RATE
        }
      })
    }
    await new Promise((r) => setTimeout(r, 100)) // it takes a moment to appear
  }
  throw new Error('The virtual audio device didn’t appear')
}

// Chromium's way to make an audio track from raw samples; not in TypeScript's DOM types yet.
interface TrackGenerator extends MediaStreamTrack {
  writable: WritableStream<AudioData>
}
declare const MediaStreamTrackGenerator: new (init: { kind: 'audio' }) => TrackGenerator

/** Screen audio from Windows: raw samples from the helper, turned into a track. */
function fromRawAudio(): { track: MediaStreamTrack; stop: () => void } {
  const track = new MediaStreamTrackGenerator({ kind: 'audio' })
  const writer = track.writable.getWriter()
  let written = 0
  let carry = new Uint8Array(0) // pipes can split a sample in two
  const off = window.hush.onScreenPcm((pcm) => {
    const bytes = new Uint8Array(carry.length + pcm.length)
    bytes.set(carry)
    bytes.set(pcm, carry.length)
    const frames = Math.floor(bytes.length / BYTES_PER_FRAME)
    carry = bytes.slice(frames * BYTES_PER_FRAME)
    if (frames === 0) return
    const data = new AudioData({
      format: 's16',
      sampleRate: SAMPLE_RATE,
      numberOfChannels: 2,
      numberOfFrames: frames,
      timestamp: Math.round((written / SAMPLE_RATE) * 1_000_000),
      data: bytes.slice(0, frames * BYTES_PER_FRAME)
    })
    written += frames
    void writer.write(data).catch(() => {})
  })
  return {
    track,
    stop: () => {
      off()
      track.stop()
    }
  }
}

/**
 * Captures the chosen screen, plus its audio if asked. Failing to get the sound doesn't stop the
 * share: the picture still goes out, and `audioError` says why it's silent.
 */
export async function captureScreen(choice: ShareChoice): Promise<ScreenCapture & { audioError: string | null }> {
  await window.hush.shareChoose(choice.sourceId)
  const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30, max: 30 } }, audio: false })
  const stream = new MediaStream(display.getVideoTracks())
  const stops: (() => void)[] = [() => display.getTracks().forEach((t) => t.stop())]
  let audioError: string | null = null

  if (choice.audioTarget !== null) {
    const started = await window.hush.screenAudioStart(choice.audioTarget)
    stops.push(() => window.hush.screenAudioStop())
    try {
      if (!started.ok) throw new Error(started.error)
      if ('deviceLabel' in started) {
        const audio = await fromVirtualSource(started.deviceLabel)
        stream.addTrack(audio.getAudioTracks()[0])
        stops.push(() => audio.getTracks().forEach((t) => t.stop()))
      } else {
        const raw = fromRawAudio()
        stream.addTrack(raw.track)
        stops.push(raw.stop)
      }
    } catch (e) {
      audioError = (e as Error).message
      window.hush.screenAudioStop()
    }
  }
  return { stream, audioError, stop: () => stops.forEach((s) => s()) }
}
