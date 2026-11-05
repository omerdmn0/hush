# Hush

Private chat for two people, peer-to-peer over Tailscale. No servers, no accounts, no cloud —
messages live only on your two computers.

> **Status:** stage a (project setup + UI shell). Networking, history, images and calls are not
> wired up yet. A full setup guide for both users (installing Tailscale, finding each other's IP)
> will be added once the app is feature-complete.

## Development

Requires Node.js 22+ (developed on Node 26) on Linux or Windows.

```sh
npm install        # also rebuilds native modules for Electron
npm run dev        # start the app with hot reload
npm test           # unit tests (vitest)
npm run typecheck  # TypeScript, main + renderer
npm run build      # production build into out/
npm start          # run the production build
```

### Preview shortcuts (dev mode only)

| Keys | Effect |
|---|---|
| `Ctrl+Shift+D` | Toggle a sample conversation with "Mira" |
| `Ctrl+Shift+O` | Sample peer goes online/offline (queued messages deliver, typing indicator) |
| `Ctrl+Shift+C` | Toggle the in-call bar |

## Project layout

```
design-system/hush/MASTER.md   design system (source of truth for every screen)
mockup/                        approved static mockup (open index.html in a browser)
src/main/                      Electron main process (window, IPC, later: network + database)
src/preload/                   the only bridge between UI and main process (window.hush)
src/shared/                    types and helpers used by both sides
src/renderer/                  React UI (Tailwind + shadcn/ui, lucide icons)
resources/                     app icon
```
