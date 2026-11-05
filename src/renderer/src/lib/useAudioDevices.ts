import { useCallback, useEffect, useState } from 'react'

export interface AudioDevice {
  id: string
  label: string
}

/** Microphones and speakers, kept up to date when devices are plugged in or out. */
export function useAudioDevices(): { mics: AudioDevice[]; speakers: AudioDevice[]; refresh: () => void } {
  const [mics, setMics] = useState<AudioDevice[]>([])
  const [speakers, setSpeakers] = useState<AudioDevice[]>([])

  const refresh = useCallback(() => {
    void navigator.mediaDevices.enumerateDevices().then((all) => {
      // Labels are empty until microphone permission has been granted once.
      const pick = (kind: MediaDeviceKind, fallback: string): AudioDevice[] =>
        all
          .filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications' && d.deviceId !== '')
          .map((d, i) => ({ id: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))
      setMics(pick('audioinput', 'Microphone'))
      setSpeakers(pick('audiooutput', 'Speaker'))
    })
  }, [])

  useEffect(() => {
    refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])

  return { mics, speakers, refresh }
}
