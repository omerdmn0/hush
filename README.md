# Hush

Private chat for two people, peer-to-peer over Tailscale. No servers, no accounts, no cloud —
messages live only on your two computers.

> **Status:** stage f — text, images, voice calls with call history, notifications and tray.
> Packaging for Windows and Linux follows in the next stage. A full setup guide for
> both users (installing Tailscale, finding each other's IP) will be added once the app is complete.

## Development

Requires Node.js 22+ (developed on Node 26) on Linux or Windows.

```sh
npm install        # native modules ship prebuilt — nothing to compile
npm run dev        # start the app with hot reload
npm test           # unit tests (vitest)
npm run typecheck  # TypeScript, main + renderer
npm run build      # production build into out/
npm start          # run the production build
```

### Try it on one computer

```sh
npm run pair
```

Builds the app and opens two copies, **a** and **b**, connected over `127.0.0.1` instead of
Tailscale. Each has its own data folder (`~/.config/Hush-dev-a` / `-b` on Linux), so you can chat
between the two windows, quit one to see offline/queued behaviour, and restart it to see history
persist. These overrides only work in development builds, never in an installed app.

To try calls without a microphone, run the pair with a fake audio device (it plays a beep):

```sh
HUSH_FAKE_MEDIA=1 npm run pair
```

### How it works

- Each app listens on its own Tailscale IP, port **47821**, and only accepts the configured peer IP.
  Both apps also dial each other; if both connections succeed, both keep the same one.
- Messages are JSON frames identified by UUID and numbered per author (1, 2, 3…). Delivery and
  read receipts only move a message's status forward, so repeats are harmless.
- **Offline queue and sync:** a message written while the other person is offline is stored as
  *queued*. On every connection both apps exchange one `sync` frame ("I have your messages up to
  N, and have read up to R"); each then sends whatever the other is missing. Nothing is lost or
  duplicated, and read receipts made offline catch up too. Both apps must run the same protocol
  version (currently 5) — Hush shows an error if they don't.
- **Images** (PNG, JPEG, GIF, WebP, up to 25 MB) are added by drag-and-drop, paste or the file
  picker. The message carries a small preview; the receiver then pulls the full file in chunks,
  resuming after interruptions and checking its SHA-256 before showing it. Files are stored in the
  app data folder under `images/`, named by message id, and shown to the UI only through the
  private `hush-img://` scheme.
- **Voice calls** use WebRTC audio. Call setup travels over the same link; the audio then goes
  directly between the two computers, encrypted by WebRTC (DTLS-SRTP) and by Tailscale. Hush uses
  no STUN/TURN servers and only offers/accepts network paths on Tailscale addresses (100.x).
  Microphone and speaker are chosen in Settings → Audio. Each computer keeps its own call history,
  shown in the chat ("You called Mira · 04:12", "Missed call from Mira" with Call back).
- **Runs in the tray:** closing the window keeps Hush running so messages and calls still arrive.
  Use the power button next to Settings (or Ctrl+Q, or the tray menu's *Quit Hush*) to quit
  completely. Launching Hush again while it runs brings its window back — on Linux desktops
  without a tray (e.g. GNOME without the AppIndicator extension) that is how you reopen it.
- **Notifications** appear for new messages (bursts are combined), incoming and missed calls,
  only while Hush isn't focused, and can be turned off in Settings or the tray menu. The unread
  count shows in the window title, tray icon and tooltip.
- **Avatars** are cropped to a 256 px square and sent to the other person on every connection.
- History and settings are stored in `hush.db` (SQLite) in the app's data folder and never leave
  the two computers.

## Project layout

```
design-system/hush/MASTER.md   design system (source of truth for every screen)
mockup/                        approved static mockup (open index.html in a browser)
src/main/                      Electron main process: window, IPC, database (db.ts),
                               peer connection (link.ts), chat logic (chat.ts)
src/preload/                   the only bridge between UI and main process (window.hush)
src/shared/                    types, wire protocol and helpers used by both sides
scripts/pair.mjs               two local instances for testing
src/renderer/                  React UI (Tailwind + shadcn/ui, lucide icons)
resources/                     app icon
```
