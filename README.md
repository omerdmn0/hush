# Hush

Private chat for two people — text, images and voice calls — directly between your two computers
over [Tailscale](https://tailscale.com). No servers, no accounts with us, no cloud: messages,
pictures and call audio go only between the two computers, and history is stored only on them.

Runs on **Windows** and **Linux**.

---

## Setup (both people do this once)

You need: two computers, both with Tailscale (free) and Hush installed. Allow about 15 minutes.

### 1. Install Tailscale

Tailscale creates a private, encrypted network between your devices. Hush uses it to reach the
other computer directly, wherever you both are.

**Windows**
1. Download Tailscale from <https://tailscale.com/download/windows> and install it.
2. Click the Tailscale icon in the taskbar (bottom-right, near the clock) → **Log in**, and sign in
   (Google, Microsoft, GitHub, … — the free *Personal* plan is enough).

**Linux**
- Ubuntu / Debian / Fedora and most others:
  ```sh
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up
  ```
- Arch / CachyOS / Manjaro:
  ```sh
  sudo pacman -S tailscale
  sudo systemctl enable --now tailscaled
  sudo tailscale up
  ```
`tailscale up` prints a link — open it and sign in.

### 2. Put both computers on the same Tailscale network

The easiest way: **one** of you owns the network and invites the other.

1. The owner opens the Tailscale admin console: <https://login.tailscale.com/admin/users>.
2. **Invite users** → enter the other person's email → send.
3. The other person accepts the invite and signs in to Tailscale on their computer with that account.

Both computers now appear under **Machines** in the admin console.

### 3. Find each other's Tailscale IP

Each computer has an address starting with **100.** (for example `100.101.42.7`). You can find
yours in any of these places:

- **In Hush:** Settings → Connection → *Your Tailscale IP* → **Copy**.
- **Windows:** Tailscale taskbar icon → your device name shows the IP; click it to copy.
- **Linux:** run `tailscale ip -4`.
- **Admin console:** <https://login.tailscale.com/admin/machines>.

Send your IP to the other person (any way you like — it's not secret, it only works inside your
Tailscale network).

### 4. Install Hush

Download the files from this repository's **Releases** page (the person who owns the repository
can add the other as a collaborator, or simply send them the file).

**Windows — `Hush-Setup-x.y.z.exe`**
1. Run it. Hush installs for your user only (no administrator rights needed) and starts.
2. Windows may show *“Windows protected your PC”* because the app isn't code-signed (signing
   costs money). Click **More info → Run anyway**.
3. If Windows Firewall asks about Hush, allow it on **Private networks**. (Hush also connects
   outwards, so it usually works even if you don't.)

**Linux — `.deb` (Ubuntu, Debian, Mint, Pop!_OS, …)**
```sh
sudo apt install ./hush_x.y.z_amd64.deb
```
Then start **Hush** from your applications menu.

**Linux — `.AppImage` (any distribution)**
```sh
chmod +x Hush-x.y.z-x86_64.AppImage
./Hush-x.y.z-x86_64.AppImage
```
AppImages need FUSE 2. If it says *“AppImages require FUSE to run”*, install it
(`sudo apt install libfuse2t64` on Ubuntu 24.04+, `sudo apt install libfuse2` on older Ubuntu/Debian,
`sudo pacman -S fuse2` on Arch) — or run it with `--appimage-extract-and-run`. On Ubuntu 24.04+
the `.deb` is the smoother choice.

### 5. Connect and pair

1. Open Hush. Click **Open connection settings**.
2. Paste the **other person's** Tailscale IP into *Their Tailscale IP* and press Enter.
3. Set your **display name** (and an avatar if you like) under Profile.
4. When both of you have done this, Hush shows **Pair with …**: each screen shows a code like
   `K7P4-QX9M`. **Read your codes to each other in person or on a phone call** (not by message),
   and each of you types the code shown on the *other* screen. Codes last 10 minutes; after 5
   wrong tries a new one appears.
5. Once both codes are accepted the status turns **ONLINE · LINK VERIFIED**. Say hi.

Pairing happens once. From then on, Hush checks on every connection that it's really talking to
the computer you paired with, and refuses anything else at that address — even another device on
your Tailscale network. If one of you reinstalls Hush, you'll see *Identity changed*: confirm
with each other, then **Pair again**.

---

## Using Hush

- **Messages** show ✓ sent, ✓✓ delivered and cyan ✓✓ read. Typing shows *“… is typing”*.
- **Offline?** Write anyway — messages are queued (amber clock, *“Waiting for … to come online”*)
  and delivered automatically the next time you're both online. History syncs both ways, with
  nothing lost or duplicated.
- **Images:** drag them onto the chat, paste them (Ctrl+V), or use the 🖼 button. Click an image
  to see it full size. PNG, JPEG, GIF and WebP up to 25 MB.
- **Voice calls:** the phone button in the sidebar or header. Mute, switch microphone and hang up
  from the call bar. Missed calls appear in the chat with a **Call back** button.
- **Closing the window keeps Hush running in the tray**, so messages and calls still reach you.
  To quit completely, use the **power button** next to Settings, **Ctrl+Q**, or the tray menu's
  *Quit Hush*. Starting Hush again brings the window back (that's also how you reopen it on Linux
  desktops without a tray, such as GNOME without the AppIndicator extension).
- **Notifications** appear for messages and calls while Hush isn't focused. By default they only
  say *“New message from …”*; Settings → Notifications can show the text, or turn them off.
- **Settings → Audio** picks your microphone and speaker, with a microphone test.
- **Starts with your computer:** the installed app starts quietly in the tray when you log in, so
  messages and calls reach you after a restart (Settings → Startup to turn it off).

---

## Troubleshooting

| What you see | What to do |
|---|---|
| **“Tailscale isn't running”** | Start Tailscale and make sure you're logged in, then press *Retry*. |
| **“Waiting for …” / OFFLINE** | Both computers need Hush running and Tailscale connected. Check each person entered the *other's* IP (not their own). Test the network with `tailscale ping 100.x.y.z`. Settings → Connection → **Retry now** reconnects immediately. |
| **Pair with … / codes** | See *Connect and pair* above. Wrong code? Check you're typing the code from the *other* screen. |
| **“Identity changed”** | The computer at that address isn't the one you paired with. Ask the other person if they reinstalled; only then press *Pair again*. |
| **“The other Hush is too old”** | One of you runs a version from before protocol 6. Install the latest release. |
| **“Port 47821 is already in use”** | Another copy of Hush (or another program) uses the port. Quit it and press Retry. |
| **Call says “Couldn't connect audio”** | Both need Tailscale connected (calls only use Tailscale addresses). Check Windows Firewall allowed Hush. Try again after `tailscale ping` works. |
| **“Can't use your microphone”** | Check the microphone is plugged in and allowed for apps (Windows: Settings → Privacy → Microphone). Pick it in Settings → Audio and use *Test microphone*. |
| **Image stuck on “Couldn't download”** | The sender's copy may be missing; press **Retry** while you're both online. |
| **No tray icon on Linux** | Your desktop has no tray (e.g. GNOME). Install the *AppIndicator* extension, or just start Hush again to bring the window back. |

---

## Privacy

- **What travels:** messages, images, profile pictures and call setup go over one encrypted
  connection between your two computers inside your Tailscale network (WireGuard). Call audio goes
  directly between the computers, encrypted by WebRTC *and* Tailscale. Hush uses no servers —
  no relay, no STUN/TURN, no analytics, no update checks. Hush only accepts connections from the
  one IP you entered.
- **What Tailscale sees:** Tailscale's coordination server knows your devices exist and helps
  them find each other; it cannot read your traffic.
- **Where things are stored** (only on your computer):
  - Windows: `%APPDATA%\Hush` — Linux: `~/.config/Hush`
  - `hush.db` (messages, call history, settings), `images/` (pictures), `avatar-*.img`
- **Uninstalling** keeps that folder; delete it to remove your history.

---

## For the maintainer

### Publishing a release

1. Set the new version in `package.json` (e.g. `"version": "0.2.0"`), commit and push.
2. Tag and push:
   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```
3. GitHub Actions (`.github/workflows/release.yml`) typechecks, runs the tests, builds the Windows
   installer and the Linux AppImage + `.deb`, and creates a **Release** with the three files.
   The tag must match the version in `package.json`.

To test a build without publishing, use **Actions → Release → Run workflow**; the files appear as
downloadable artifacts of that run. Builds use the free GitHub Actions minutes of the private repo
(a full build takes roughly 15–25 minutes of quota; Windows minutes count double).

From protocol **6** on, versions stay compatible: one of you can update first and you keep
chatting; features the other app doesn't have yet are skipped, and Hush shows *“… has Hush x.y —
update for new features”*. Only apps older than protocol 6 are refused.

### Development

Requires Node.js 22+ on Linux or Windows.

```sh
npm install --ignore-scripts   # native modules ship prebuilt — nothing to compile
npm run dev                    # start with hot reload
npm test                       # unit + integration tests (vitest)
npm run typecheck              # TypeScript, main + renderer
npm run dist:linux             # build AppImage + .deb into release/
npm run dist:win               # build the Windows installer (on Windows)
```

**Two copies on one computer** (no Tailscale needed):

```sh
npm run pair                       # two linked windows over 127.0.0.1
HUSH_FAKE_MEDIA=1 npm run pair     # …with a fake microphone for testing calls
```

These development overrides are ignored in installed builds.

### How it works

- Each app listens on its own Tailscale IP, port **47821**, and only accepts the configured peer IP.
  Both apps also dial each other; if both connections succeed, both keep the same one.
- Identity: each install has an Ed25519 key. Pairing pins the other's key after both people typed
  each other's one-time code (an HMAC over both keys, so only someone who saw the screen can
  produce it). Every connection then proves the pinned key by signing the other side's nonce.
- Edits, deletions and reactions are events in the same per-author sequence as messages, so the
  offline queue and sync carry them too.
- Messages are JSON frames identified by UUID and numbered per author (1, 2, 3…). On every
  connection both apps exchange one `sync` frame (“I have your messages up to N and have read up
  to R”) and send whatever the other is missing — that's the offline queue and history sync.
  Receipts only move a status forward, so repeats are harmless.
- Images carry an inline preview; the receiver pulls the full file in resumable chunks and checks
  its SHA-256. Files live under `images/`, shown to the UI only via the private `hush-img://` scheme.
- Calls use WebRTC audio with signaling over the same link, restricted to Tailscale addresses.

### Project layout

```
design-system/hush/MASTER.md   design system (source of truth for every screen)
mockup/                        approved static mockup (open index.html in a browser)
src/main/                      Electron main: window, tray, notifications, IPC, database (db.ts),
                               peer connection (link.ts), chat + sync (chat.ts), images (transfers.ts)
src/preload/                   the only bridge between UI and main process (window.hush)
src/shared/                    types, wire protocol and helpers used by both sides
src/renderer/                  React UI (Tailwind + shadcn/ui, lucide icons), calls (lib/call.ts)
resources/, build/             app, tray and installer icons
electron-builder.yml           packaging; .github/workflows/release.yml builds releases
scripts/pair.mjs               two local instances for testing
```
