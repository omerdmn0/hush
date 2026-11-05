// Development-only sample conversation (Ctrl+Shift+D in `npm run dev`).
// Lets the UI shell be checked against the approved mockup before networking exists.
import type { ChatMessage } from '../../../shared/types'

const svg = (body: string, w: number, h: number): string =>
  'data:image/svg+xml;charset=utf-8,' +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${body}</svg>`)

const LAKE = svg(
  '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#140A2A"/><stop offset=".55" stop-color="#7A1F6A"/><stop offset="1" stop-color="#FF2E88"/></linearGradient><linearGradient id="w" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3A0F3A"/><stop offset="1" stop-color="#05040A"/></linearGradient></defs><rect width="400" height="180" fill="url(#s)"/><circle cx="250" cy="168" r="30" fill="#FFC23D"/><path d="M0 150 L70 120 L130 145 L200 110 L280 150 L340 125 L400 150 L400 180 L0 180Z" fill="#1E0B2A"/><rect y="180" width="400" height="120" fill="url(#w)"/><g fill="#FFC23D" opacity=".6"><rect x="220" y="190" width="60" height="3"/><rect x="232" y="202" width="36" height="3"/><rect x="240" y="214" width="20" height="3"/></g>',
  400,
  300
)
const CITY = svg(
  '<defs><linearGradient id="c" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05040A"/><stop offset="1" stop-color="#0B2A3A"/></linearGradient></defs><rect width="300" height="400" fill="url(#c)"/><g fill="#120F1E"><rect x="10" y="150" width="60" height="250"/><rect x="80" y="90" width="50" height="310"/><rect x="140" y="190" width="70" height="210"/><rect x="220" y="120" width="70" height="280"/></g><g fill="#00E5FF" opacity=".8"><rect x="90" y="110" width="6" height="4"/><rect x="104" y="130" width="6" height="4"/><rect x="232" y="150" width="6" height="4"/><rect x="30" y="200" width="6" height="4"/></g><g fill="#FF2E88" opacity=".85"><rect x="116" y="150" width="6" height="4"/><rect x="160" y="230" width="6" height="4"/><rect x="266" y="140" width="6" height="4"/></g><rect x="150" y="210" width="50" height="14" fill="#FF2E88"/>',
  300,
  400
)

export const DEMO_PEER = { name: 'Mira', ip: '100.101.42.7' }

export function demoMessages(now: number = Date.now()): ChatMessage[] {
  const d = new Date(now)
  const day = (offset: number, h: number, m: number): number =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate() - offset, h, m).getTime()
  let i = 0
  const m = (from: ChatMessage['from'], sentAt: number, text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
    id: `demo-${++i}`,
    from,
    text,
    sentAt,
    status: from === 'me' ? 'read' : 'delivered',
    ...extra
  })
  return [
    m('peer', day(2, 21, 4), 'Found the photos from the lake trip, sending a few'),
    m('peer', day(2, 21, 4), '', { image: { src: LAKE, width: 400, height: 300, alt: 'Sunset over a lake' } }),
    m('peer', day(2, 21, 5), '', { image: { src: CITY, width: 300, height: 400, alt: 'City skyline at night' } }),
    m('me', day(2, 21, 12), 'These are so good. The city one should be a wallpaper'),
    m('me', day(2, 21, 12), 'Do you have the one from the boat too?'),
    m('peer', day(1, 8, 30), 'Morning. Did the Tailscale setup work on your laptop?'),
    m('me', day(1, 8, 41), 'Yes, finally. Both our IPs start with 100.'),
    m('me', day(1, 8, 41), 'Want to try a voice call tonight?'),
    m('peer', day(1, 8, 43), 'After 9 works for me 🌙'),
    m('peer', day(0, 13, 10), 'Heading out, back later'),
    m('me', day(0, 13, 15), "I'll send the settings mockup tonight", { status: 'queued' }),
    m('me', day(0, 13, 15), "Ping me when you're back", { status: 'queued' })
  ]
}
