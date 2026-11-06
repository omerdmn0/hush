import type { CallEndReason, CallSignal } from '../../../shared/protocol'
import type { CallDirection, CallRecord } from '../../../shared/types'
import {
  candidateAllowed,
  ENDED_VISIBLE_MS,
  endedText,
  offersScreen,
  outcomeFor,
  RECONNECT_GRACE_MS,
  RING_TIMEOUT_MS,
  yieldToIncoming,
  withStereoScreenAudio,
  type EndedBy
} from './callLogic'
import { Ringer } from './ringtone'

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended'

export interface CallView {
  phase: CallPhase
  /** Outgoing: the other app confirmed it is ringing. */
  ringing: boolean
  /** When audio connected (for the timer). */
  connectedAt: number | null
  muted: boolean
  /** Shown while phase === 'ended'. */
  endedText: string | null
  /** We're sharing our screen. */
  sharing: { audio: boolean } | null
  /** They're sharing theirs (see CallController.remoteScreen). */
  peerSharing: { audio: boolean } | null
  /** This call can carry a shared screen (both apps support it). */
  canShare: boolean
}

const IDLE: CallView = { phase: 'idle', ringing: false, connectedAt: null, muted: false, endedText: null, sharing: null, peerSharing: null, canShare: false }

/** What's being shared; `stop` releases the capture. */
export interface ScreenCapture {
  stream: MediaStream
  stop: () => void
}

export interface CallDeps {
  send: (signal: CallSignal) => Promise<boolean>
  peerName: () => string
  micId: () => string
  speakerId: () => string
  /** Dev pairing mode: allow any network interface for media. */
  anyNetwork: () => boolean
  /** Saves a call-history entry. */
  logCall: (record: CallRecord) => void
  /** Their Hush can receive a shared screen. */
  peerCanShare: () => boolean
}

/**
 * One voice call at a time: WebRTC audio, signaling relayed through the main process.
 * No STUN/TURN servers — on Tailscale both computers can reach each other directly.
 */
export class CallController {
  private view: CallView = IDLE
  private listeners = new Set<(v: CallView) => void>()
  private callId: string | null = null
  private pc: RTCPeerConnection | null = null
  private local: MediaStream | null = null
  private remoteOffer: string | null = null
  private pendingIce: RTCIceCandidateInit[] = []
  private ringTimer: ReturnType<typeof setTimeout> | undefined
  private graceTimer: ReturnType<typeof setTimeout> | undefined
  private endedTimer: ReturnType<typeof setTimeout> | undefined
  /** History entry for the current call; null until an invitation was actually sent/received. */
  private record: CallRecord | null = null
  private readonly ringer = new Ringer()
  readonly audio: HTMLAudioElement
  private screen: ScreenCapture | null = null
  /** Their shared screen (and its audio); only meaningful while view.peerSharing is set. */
  remoteScreen: MediaStream | null = null

  constructor(private readonly deps: CallDeps) {
    this.audio = new Audio()
    this.audio.autoplay = true
  }

  // ---------- state ----------

  get state(): CallView {
    return this.view
  }

  subscribe(fn: (v: CallView) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private set(patch: Partial<CallView>): void {
    this.view = { ...this.view, ...patch }
    for (const fn of this.listeners) fn(this.view)
  }

  get busy(): boolean {
    return this.view.phase !== 'idle' && this.view.phase !== 'ended'
  }

  // ---------- user actions ----------

  // Every await below re-checks `current(id)`: while we wait, the call can be cancelled or —
  // if both pressed Call at once — replaced by the other side's call (see onInvite).

  async start(): Promise<void> {
    if (this.busy) return
    this.reset()
    const id = crypto.randomUUID()
    this.callId = id
    this.set({ ...IDLE, phase: 'outgoing' })
    if (!(await this.openMic(id))) {
      if (this.current(id)) this.finish('mic', 'system', false)
      return
    }
    const pc = this.createPc(id)
    // Screen video + audio slots are negotiated now and switched on later with replaceTrack, so
    // sharing never renegotiates mid-call. An older Hush would mishandle them, so ask first.
    if (this.deps.peerCanShare()) {
      const shared = new MediaStream() // one stream, so picture and sound stay in sync
      pc.addTransceiver('video', { direction: 'sendrecv', streams: [shared] })
      pc.addTransceiver('audio', { direction: 'sendrecv', streams: [shared] })
      this.set({ canShare: true })
    }
    const offer = await pc.createOffer()
    if (!this.current(id)) return
    await pc.setLocalDescription(offer)
    if (!this.current(id)) return
    const sent = await this.deps.send({ t: 'call', id, sdp: offer.sdp ?? '' })
    if (!this.current(id)) return
    if (!sent) return this.finish('offline', 'system', false)
    this.newRecord(id, 'out')
    this.ringer.start('ringback', this.deps.speakerId())
    this.ringTimer = setTimeout(() => this.endCall('timeout'), RING_TIMEOUT_MS)
  }

  async accept(): Promise<void> {
    const id = this.callId
    if (this.view.phase !== 'incoming' || !id || !this.remoteOffer) return
    this.ringer.stop()
    clearTimeout(this.ringTimer)
    const offer = this.remoteOffer
    this.set({ phase: 'connecting' })
    if (!(await this.openMic(id))) {
      if (!this.current(id)) return
      void this.deps.send({ t: 'call-end', id, reason: 'failed' })
      return this.finish('mic', 'system', false)
    }
    const pc = this.createPc(id)
    await pc.setRemoteDescription({ type: 'offer', sdp: withStereoScreenAudio(offer) })
    if (!this.current(id)) return
    if (offersScreen(offer)) {
      const shared = new MediaStream()
      for (const t of pc.getTransceivers().slice(1)) {
        t.direction = 'sendrecv'
        t.sender.setStreams(shared)
      }
      this.set({ canShare: true })
    }
    await this.flushIce()
    const answer = await pc.createAnswer()
    if (!this.current(id)) return
    await pc.setLocalDescription(answer)
    if (this.current(id)) void this.deps.send({ t: 'call-answer', id, sdp: answer.sdp ?? '' })
  }

  decline(): void {
    if (this.view.phase === 'incoming') this.endCall('declined')
  }

  hangUp(): void {
    if (!this.busy) return
    this.endCall(this.view.phase === 'outgoing' ? 'cancelled' : 'hangup')
  }

  toggleMute(): void {
    const muted = !this.view.muted
    this.local?.getAudioTracks().forEach((t) => (t.enabled = !muted))
    this.set({ muted })
  }

  /** Switch microphone mid-call without renegotiating. */
  async switchMic(deviceId: string): Promise<void> {
    if (!this.local || !this.pc) return
    const next = await getMic(deviceId).catch(() => null)
    if (!next) return
    const track = next.getAudioTracks()[0]
    track.enabled = !this.view.muted
    const sender = this.pc.getSenders().find((s) => s.track?.kind === 'audio')
    await sender?.replaceTrack(track)
    this.local.getTracks().forEach((t) => t.stop())
    this.local = next
  }

  /** Starts sending a captured screen (and its audio, if any) in the slots made at call start. */
  async startShare(capture: ScreenCapture): Promise<void> {
    const id = this.callId
    const [, video, audio] = this.pc?.getTransceivers() ?? []
    if (!id || !video || !audio || this.view.phase !== 'active' || this.screen) return capture.stop()
    const videoTrack = capture.stream.getVideoTracks()[0]
    const audioTrack = capture.stream.getAudioTracks()[0] ?? null
    this.screen = capture
    videoTrack.onended = () => void this.stopShare() // "Stop sharing" in the system's own UI
    videoTrack.contentHint = 'detail'
    await video.sender.replaceTrack(videoTrack)
    await limit(video.sender, 8_000_000, 30)
    if (audioTrack) {
      audioTrack.contentHint = 'music'
      await audio.sender.replaceTrack(audioTrack)
      await limit(audio.sender, 128_000)
    }
    this.set({ sharing: { audio: !!audioTrack } })
    void this.deps.send({ t: 'call-share', id, on: true, audio: !!audioTrack })
  }

  async stopShare(): Promise<void> {
    const capture = this.screen
    if (!capture) return
    this.screen = null
    const [, video, audio] = this.pc?.getTransceivers() ?? []
    await Promise.all([video?.sender.replaceTrack(null), audio?.sender.replaceTrack(null)])
    capture.stop()
    this.set({ sharing: null })
    if (this.callId) void this.deps.send({ t: 'call-share', id: this.callId, on: false, audio: false })
  }

  async setSpeaker(deviceId: string): Promise<void> {
    await (this.audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(deviceId).catch(() => {})
  }

  /** The link to the other app dropped. Unanswered calls can't continue; live audio may. */
  peerWentOffline(): void {
    if (this.view.phase === 'outgoing' || this.view.phase === 'incoming') this.finish('lost', 'system', false)
  }

  // ---------- signaling from the other app ----------

  async onSignal(s: CallSignal): Promise<void> {
    if (s.t === 'call') return this.onInvite(s.id, s.sdp)
    if (s.id !== this.callId) return
    switch (s.t) {
      case 'call-ringing':
        if (this.view.phase === 'outgoing') this.set({ ringing: true })
        break
      case 'call-answer':
        if (this.view.phase !== 'outgoing' || !this.pc) return
        this.ringer.stop()
        clearTimeout(this.ringTimer)
        this.set({ phase: 'connecting' })
        await this.pc.setRemoteDescription({ type: 'answer', sdp: withStereoScreenAudio(s.sdp) })
        await this.flushIce()
        break
      case 'call-ice': {
        if (!candidateAllowed(s.candidate, this.deps.anyNetwork())) return
        const init: RTCIceCandidateInit = { candidate: s.candidate, sdpMid: s.mid, sdpMLineIndex: s.line }
        if (this.pc?.remoteDescription) await this.pc.addIceCandidate(init).catch(() => {})
        else this.pendingIce.push(init)
        break
      }
      case 'call-end':
        this.finish(s.reason, 'peer', true)
        break
      case 'call-share':
        this.set({ peerSharing: s.on ? { audio: s.audio } : null })
        break
    }
  }

  private async onInvite(id: string, sdp: string): Promise<void> {
    const phase = this.view.phase
    if (phase === 'outgoing' && this.callId && !this.view.ringing && yieldToIncoming(this.callId, id)) {
      // We both called at once: drop ours and take theirs, answering straight away.
      this.teardown()
      this.callId = id
      this.remoteOffer = sdp
      this.newRecord(id, 'in')
      this.set({ phase: 'incoming', canShare: false })
      void this.deps.send({ t: 'call-ringing', id })
      return this.accept()
    }
    if (phase === 'outgoing' && this.callId && yieldToIncoming(id, this.callId)) return // they will yield to ours
    if (this.busy) {
      void this.deps.send({ t: 'call-end', id, reason: 'busy' })
      return
    }
    this.reset()
    this.callId = id
    this.remoteOffer = sdp
    this.newRecord(id, 'in')
    this.set({ ...IDLE, phase: 'incoming' })
    void this.deps.send({ t: 'call-ringing', id })
    this.ringer.start('incoming', this.deps.speakerId())
    this.ringTimer = setTimeout(() => this.finish('timeout', 'peer', false), RING_TIMEOUT_MS + 5_000)
  }

  // ---------- internals ----------

  private newRecord(id: string, direction: CallDirection): void {
    this.record = { id, direction, startedAt: Date.now(), connectedAt: null, endedAt: null, outcome: 'ongoing' }
  }

  /** True while `id` is still the call this controller is handling. */
  private current(id: string): boolean {
    return this.callId === id
  }

  /** Opens the microphone for call `id`; a stream that arrives after the call changed is discarded. */
  private async openMic(id: string): Promise<boolean> {
    const stream = await getMic(this.deps.micId()).catch(() => null)
    if (!stream) return false
    if (!this.current(id)) {
      stream.getTracks().forEach((t) => t.stop())
      return false
    }
    this.local = stream
    return true
  }

  private createPc(id: string): RTCPeerConnection {
    // No iceServers: on Tailscale both machines are directly reachable; no third party involved.
    const pc = new RTCPeerConnection({ iceServers: [] })
    this.pc = pc
    this.local?.getTracks().forEach((t) => pc.addTrack(t, this.local!))
    pc.onicecandidate = (e) => {
      if (!e.candidate || !candidateAllowed(e.candidate.candidate, this.deps.anyNetwork())) return
      void this.deps.send({ t: 'call-ice', id, candidate: e.candidate.candidate, mid: e.candidate.sdpMid, line: e.candidate.sdpMLineIndex })
    }
    pc.ontrack = (e) => {
      // The first slot is the voice; the others carry the shared screen.
      if (pc.getTransceivers().indexOf(e.transceiver) > 0) {
        this.remoteScreen ??= new MediaStream()
        this.remoteScreen.addTrack(e.track)
        return
      }
      this.audio.srcObject = e.streams[0] ?? new MediaStream([e.track])
      void this.setSpeaker(this.deps.speakerId())
      void this.audio.play().catch(() => {})
    }
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return
      switch (pc.connectionState) {
        case 'connected':
          clearTimeout(this.graceTimer)
          if (this.view.phase !== 'active') {
            const now = Date.now()
            this.set({ phase: 'active', connectedAt: now })
            if (this.record) {
              this.record = { ...this.record, connectedAt: now }
              this.deps.logCall(this.record)
            }
          }
          break
        case 'disconnected':
          clearTimeout(this.graceTimer)
          this.graceTimer = setTimeout(() => pc.connectionState !== 'connected' && this.endCall('failed', 'lost'), RECONNECT_GRACE_MS)
          break
        case 'failed':
          this.endCall('failed')
          break
      }
    }
    return pc
  }

  private async flushIce(): Promise<void> {
    const pending = this.pendingIce.splice(0)
    for (const c of pending) await this.pc?.addIceCandidate(c).catch(() => {})
  }

  /** Ends the call from our side: tells the other app, then cleans up. */
  private endCall(reason: CallEndReason, shown: CallEndReason | 'lost' = reason): void {
    const id = this.callId
    if (id) void this.deps.send({ t: 'call-end', id, reason })
    this.finish(shown, 'me', true)
  }

  private finish(reason: Parameters<typeof endedText>[0], by: EndedBy, withDuration: boolean): void {
    const duration = withDuration && this.view.connectedAt ? Date.now() - this.view.connectedAt : null
    if (this.record) {
      const r = this.record
      this.deps.logCall({ ...r, endedAt: Date.now(), outcome: outcomeFor(r.direction, reason, r.connectedAt !== null) })
      this.record = null
    }
    this.teardown()
    this.callId = null
    this.set({ ...IDLE, phase: 'ended', endedText: endedText(reason, by, this.deps.peerName(), duration) })
    this.endedTimer = setTimeout(() => this.set(IDLE), ENDED_VISIBLE_MS)
  }

  private teardown(): void {
    this.ringer.stop()
    clearTimeout(this.ringTimer)
    clearTimeout(this.graceTimer)
    this.screen?.stop()
    this.screen = null
    this.remoteScreen = null
    this.pc?.close()
    this.pc = null
    this.local?.getTracks().forEach((t) => t.stop())
    this.local = null
    this.audio.srcObject = null
    this.remoteOffer = null
    this.pendingIce = []
  }

  private reset(): void {
    clearTimeout(this.endedTimer)
    this.teardown()
  }

  /** For automated tests in dev pairing mode only. */
  debug(): { pc: RTCPeerConnection | null; local: MediaStream | null } {
    return { pc: this.pc, local: this.local }
  }

  dispose(): void {
    this.reset()
    this.listeners.clear()
  }
}

async function limit(sender: RTCRtpSender, maxBitrate: number, maxFramerate?: number): Promise<void> {
  const p = sender.getParameters()
  const encoding = p.encodings?.[0]
  if (!encoding) return
  encoding.maxBitrate = maxBitrate
  if (maxFramerate) encoding.maxFramerate = maxFramerate
  await sender.setParameters(p).catch(() => {})
}

export function getMic(deviceId: string): Promise<MediaStream> {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  const want = deviceId ? { ...base, deviceId: { exact: deviceId } } : base
  // A remembered microphone that was unplugged falls back to the default one.
  return navigator.mediaDevices
    .getUserMedia({ audio: want, video: false })
    .catch((e: unknown) => (deviceId && (e as Error).name === 'OverconstrainedError' ? navigator.mediaDevices.getUserMedia({ audio: base }) : Promise.reject(e)))
}
