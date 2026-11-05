import { createServer } from 'node:net'

/**
 * Test-only. Ports from a range of our own per test worker, below the OS's range for outgoing
 * connections — asking the OS for "any free port" let parallel test files (or outgoing sockets)
 * end up on the same port now and then, which hung connection tests.
 */
const worker = Number(process.env.VITEST_POOL_ID ?? 1) % 30
let next = 0

export async function freePort(host = '127.0.0.1'): Promise<number> {
  for (;;) {
    const port = 10000 + worker * 700 + (next++ % 700)
    const free = await new Promise<boolean>((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(false))
      srv.listen(port, host, () => srv.close(() => resolve(true)))
    })
    if (free) return port
  }
}
