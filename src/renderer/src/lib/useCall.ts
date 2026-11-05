import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CallController, type CallView } from './call'

interface Options {
  peerName: string
  peerOnline: boolean
  micId: string
  speakerId: string
  devPairing: boolean
}

/** One CallController for the app, fed with signaling events and current settings. */
export function useCall(opts: Options): { view: CallView; call: CallController } {
  const latest = useRef(opts)
  latest.current = opts
  const [call] = useState(
    () =>
      new CallController({
        send: (signal) => window.hush.sendCallSignal(signal),
        peerName: () => latest.current.peerName,
        micId: () => latest.current.micId,
        speakerId: () => latest.current.speakerId,
        anyNetwork: () => latest.current.devPairing,
        logCall: (record) => window.hush.logCall(record)
      })
  )
  const view = useSyncExternalStore(
    (fn) => call.subscribe(fn),
    () => call.state
  )

  useEffect(() => window.hush.onEvent((e) => e.type === 'call' && void call.onSignal(e.signal)), [call])

  useEffect(() => {
    if (!opts.peerOnline) call.peerWentOffline()
  }, [opts.peerOnline, call])

  useEffect(() => {
    void call.setSpeaker(opts.speakerId)
  }, [opts.speakerId, call])

  // Test hook, only in dev pairing mode (never in an installed app).
  useEffect(() => {
    if (opts.devPairing) (window as unknown as { __hushCall?: CallController }).__hushCall = call
  }, [opts.devPairing, call])

  return { view, call }
}
