# Hush

Private chat for two people, peer-to-peer over Tailscale. No servers, no accounts, no cloud —
messages live only on your two computers.

> **Status:** stage b — text chat over WebSocket with SQLite history. Offline delivery,
> images, voice calls, notifications and packaging follow in later stages. A full setup guide for
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

### How it works

- Each app listens on its own Tailscale IP, port **47821**, and only accepts the configured peer IP.
  Both apps also dial each other; if both connections succeed, both keep the same one.
- Messages are JSON frames identified by UUID; delivery and read receipts move a message's status
  forward only, so repeats are harmless.
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
