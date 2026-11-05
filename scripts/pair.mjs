// Runs two copies of Hush ("a" and "b") on this machine, linked over 127.0.0.1,
// so the chat can be tested without a second computer or Tailscale.
// Usage: npm run pair   (builds first). Data lives in separate "Hush-dev-a/b" folders.
import { spawn } from 'node:child_process'
import electron from 'electron'

const instances = [
  { profile: 'a', port: '47831', peerPort: '47832' },
  { profile: 'b', port: '47832', peerPort: '47831' }
]

const children = instances.map(({ profile, port, peerPort }) =>
  spawn(electron, ['.'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      HUSH_PROFILE: profile,
      HUSH_BIND: '127.0.0.1',
      HUSH_PEER: '127.0.0.1',
      HUSH_PORT: port,
      HUSH_PEER_PORT: peerPort
    }
  })
)

const stop = () => children.forEach((c) => c.kill())
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
let alive = children.length
children.forEach((c) => c.on('exit', () => --alive === 0 && process.exit(0)))
