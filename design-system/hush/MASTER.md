# Hush — Design System (MASTER) · v2 "Neon"

> Global source of truth for every Hush screen. A file in `pages/<page>.md`, if present,
> overrides this one for that page only.
> v2 replaces v1 "Lantern" (archived in `archive/MASTER-v1-lantern.md`) after the user asked for a
> cyberpunk colour scheme and structure. Approved 2026-11-05. **Dark only** — the light theme was
> removed at the user's request (it did not suit the style; the skill also marks light mode as
> not recommended for Cyberpunk UI).

Generated with the ui-ux-pro-max workflow. Style match: **Cyberpunk UI** (neon on dark, terminal/HUD,
angular shapes, scanlines, subtle glitch; accessibility risk: low) with HUD/FUI details (1px lines,
corner brackets, mono data labels). Single dark theme; there is no theme setting.
Fonts from the skill's *Cyberpunk* pairing (Orbitron + JetBrains Mono), with Exo 2 added for long
message text because the pairing's mono-only body hurts reading in a chat app.
Icons: **lucide-react** (project requirement).

---

## 1. Identity

- **Name:** Hush
- **Concept:** "a private channel in a neon city" — two people on a quiet encrypted link.
  Magenta = you, cyan = them / the system, green = live link, amber = queued.
- **App icon:** angular magenta speech bubble with a crescent moon cut out and a cyan
  "chromatic offset" ghost behind it, on a chamfered near-black tile. `design-system/hush/icon.svg`.
- **Voice:** terse, technical labels in UI chrome (`// LINK`, `QUEUED`, `NODE 100.x.x.x`);
  plain sentences for anything that explains or warns. Never jargon in error messages.
- Not to resemble: Discord (blurple, flat rows), or any specific game's UI (e.g. yellow-dominant schemes).

## 2. Colour tokens

Ratios are WCAG 2.x contrast. Text ≥ 4.5:1; UI graphics (input borders, status marks, focus ring) ≥ 3:1.
Decorative edges (bubble/panel outlines, grid) are exempt but must never be the only cue.

### Surfaces

| Token | Role | Value |
|---|---|---|
| `--bg-sidebar` | Sidebar, settings nav | `#08070D` |
| `--bg-app` | Chat / main pane | `#0D0B14` |
| `--surface` | Panels, cards, composer | `#15121F` |
| `--surface-elevated` | Dialogs, popovers, toasts | `#1C1828` |
| `--sunken` | Input fields | `#0A0910` |
| `--hover` | Hover fill | `#1A1626` |
| `--pressed` | Pressed fill, switch track | `#241E33` |
| `--edge` | Panel outline (decorative) | `#2A2440` |
| `--border-strong` | Input / control outlines (≥ 3:1) | `#6E6491` (3.4 on surface) |
| `--grid` | Background grid lines | `rgba(0,229,255,.045)` |
| `--scanlines` | Static scanline overlay opacity | `.35` |
| `--scrim` | Behind dialogs / lightbox | `rgba(4,3,10,.78)` |

### Text

| Token | Role | Value |
|---|---|---|
| `--text` | Primary text | `#ECEAF4` (16.4 on bg-app) |
| `--text-muted` | Secondary text, timestamps, labels, placeholders | `#9C95B8` (6.9 on bg-app, 6.1 in bubbles) |

### Signal colours

| Token | Role | Value |
|---|---|---|
| `--cyan` | Primary actions, focus ring, links, "them" | `#00E5FF` (12.7 on bg) |
| `--on-cyan` | Text on cyan | `#04030A` (13.4) |
| `--cyan-hover` | Primary hover | `#7DF3FF` (15.8 w/ on-cyan) |
| `--cyan-subtle` | Selected nav, highlight fill | `#0B2830` (text 13.0) |
| `--magenta` | "You": own-message edge, your labels, brand | `#FF2E88` (5.6 on bg) |
| `--magenta-subtle` | Magenta tint fill | `#2B0D1F` (text 15.0) |
| `--ring` | Focus ring (2px, 2px offset) | `#00E5FF` |
| `--glow` | Neon glow (dark only) | `0 0 16px rgba(0,229,255,.45)` |

### Bubbles

| Token | Role | Value |
|---|---|---|
| `--bubble-mine` | My messages (right) | `#24101F` (text 15.1) |
| `--edge-mine` | Outline of my bubbles | `#7A1A49` |
| `--bubble-theirs` | Their messages (left) | `#0C1C24` (text 14.6) |
| `--edge-theirs` | Outline of their bubbles | `#0B5560` |

### Status & semantic

| Token | Role | Value |
|---|---|---|
| `--online` | Online mark, live call, success | `#3DFF8E` (15.2 on sidebar) |
| `--offline` | Offline mark (hollow) | `#7A7398` (4.2 on surface) |
| `--queued` | Pending / queued messages | `#FFC23D` (12.1 on bg) |
| `--danger-text` | Inline error text | `#FF3B4E` (5.6 on bg) |
| `--danger` | Destructive fill (hazard stripes A) | `#E0243A` (white 4.7) |
| `--danger-2` | Hazard stripes B / hover | `#C81E33` (white 5.6) |
| `--on-danger` | Text on danger | `#FFFFFF` |
| `--callbar` | In-call strip | `#06170F` (text 15.5, online 14.0) |

Rules:
- Components use tokens only. Implement as shadcn/ui CSS variables on `:root` (dark only, `color-scheme: dark`) exposed via `@theme inline`.
- Colour is never the only cue: online = filled square + "ONLINE", offline = hollow square + "OFFLINE",
  queued = clock + "QUEUED", destructive = hazard stripes + icon + label.

## 3. Typography

All bundled locally with `@fontsource-variable/*` — **no runtime requests to Google Fonts.**

| Role | Font | Subsets | Use |
|---|---|---|
| Display | **Orbitron** (600–800) | latin only | Wordmark, screen and section headings — **fixed English UI strings only**, never names or user text (no Turkish glyphs) |
| Body | **Exo 2** (400–700) | latin + latin-ext | Message text, names, descriptions, form values |
| Data | **JetBrains Mono** (400–700) | latin + latin-ext | Timestamps, IPs, status tags, labels, buttons, hints |

| Style | Font | Size / line-height | Weight | Case |
|---|---|---|
| Wordmark | Orbitron | 18 / 24, tracking .24em | 800 | UPPER |
| Title | Orbitron | 18 / 26, tracking .12em | 700 | UPPER |
| Name / heading | Exo 2 | 18 / 26 | 600 | Normal |
| Body (messages) | Exo 2 | 16 / 24 | 400 | Normal |
| UI | Exo 2 | 14 / 20 | 500 | Normal |
| Label / button | JetBrains Mono | 13 / 16, tracking .06em | 600 | UPPER |
| Data / small | JetBrains Mono | 12 / 16, tracking .04em | 500 | as data (min size) |

- Glow / chromatic text-shadow only on Orbitron display text.

## 4. Shape, spacing & structure

- Spacing scale (4px base): `4, 8, 12, 16, 24, 32, 48`.
- **Chamfers, not rounds.** Containers (panels, bubbles, call bar, composer, dialogs, avatars) use 45° cut corners via `clip-path`; the outline is drawn as a 1px edge layer (outer = edge colour, inner `::before` inset 1px = fill).
  - Panel: cut top-left + bottom-right, `12px`.
  - Bubble: cut on the sender-side bottom corner, `10px` (mine bottom-right, theirs bottom-left).
  - Avatar: chamfered square, cut top-right + bottom-left, `25%` of size.
- **Interactive controls are never clipped** (clip-path would hide focus rings): buttons, inputs, switches use `2px` radius rectangles.
  Elements focusable *inside* a clipped container use an inset focus ring (`outline-offset:-3px`).
- HUD details: `// LABEL` section headers in mono, 1px neon hairlines fading out (`linear-gradient(90deg, cyan, transparent)`), corner brackets on the peer avatar and lightbox frame.
- Background: 32px grid in `--grid` on the chat pane; static scanline overlay.
- Layout: sidebar `240px` · chat column max `760px` · call bar `56px` · composer min `56px` (grows to 8 lines) · window min `880 × 560`.
- Hit targets ≥ 32px; primary actions ≥ 40px; 8px+ between adjacent targets.

## 5. Motion

| Token | Value | Use |
|---|---|---|
| `--dur-micro` | 120ms | Hover, press, toggle |
| `--dur-enter` | 180ms | Message appear, dialogs |
| `--dur-exit` | 120ms | Dismiss |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | All |

- Message appear: fade + 4px rise (no glitch on content).
- Glitch: only on the wordmark (hover) and the incoming-call title (one 300ms burst every 4s). Never on message text or anything the user must read continuously.
- Live call: waveform bars + pulsing live mark. Typing: block dots + blinking cursor.
- No flicker effects. Scanlines are static.
- `prefers-reduced-motion: reduce` → all loops, glitch and translate off; instant opacity changes only.

## 6. Components & patterns

### Messages
- Bubbles: mine right (magenta edge), theirs left (cyan edge). Max width 68% of column.
- Grouping: same sender within **5 minutes** → one group; header (`MIRA` mono label + time) and avatar only on their groups; 2px between bubbles, 16px between groups.
- Date separators: hairline — `TODAY` / `YESTERDAY` / `TUE 03.11.2026` — hairline, mono.
- Timestamp inside each bubble, bottom-right, mono 12px muted. Full date/time in a tooltip.
- Delivery status (icon + accessible label): **Queued** `clock` in `--queued` · **Sent** `check` · **Delivered** `check-check` muted · **Read** `check-check` cyan.
- Under the latest queued bubble: `QUEUED · Waiting for {name} to come online` in `--queued`.
- Queue flush: inline system line `▸ 3 QUEUED MESSAGES DELIVERED · 18:02` in `--online` + toast if unfocused.
- Images: thumbnail max 320×320, aspect preserved, space reserved before load; click/Enter opens the lightbox (bracketed frame, Esc closes, focus returns). Upload: progress overlay / failed + Retry.
- Typing: their bubble with three square cyan dots + `{name} is typing_` (blinking underscore) + visually-hidden text.

### Sidebar
- Wordmark `HUSH` + `P2P // PRIVATE` tag.
- `// LINK` peer panel: bracketed avatar, name, status tag `[■ ONLINE]` / `[□ OFFLINE] last seen 13:11`, `NODE 100.x.x.x`, CALL button.
- Footer note: shield icon + `Direct via Tailscale · no servers`.
- Self row: avatar, name, `YOU`, settings button.

### Call bar
- 56px strip, `--callbar`, green edge. `● LIVE` tag, `CALL // {name}`, mono timer `00:12:43`, waveform, mic selector, mute (`aria-pressed`), HANG UP (hazard).
- Outgoing: `CALLING {name}…` + CANCEL. Incoming: dialog `INCOMING CALL`, DECLINE (hazard) / ACCEPT (cyan); Esc = decline; ringtone.

### Forms (settings)
- Numbered modules `01 // PROFILE` … Visible label above every field, helper below, error below with `circle-alert` in `--danger-text`; `aria-invalid` + `aria-describedby`.
- Toggles/selects save immediately; text fields on blur/Enter with inline `SAVED` mark.

### Required states for every component
default · hover (edge → cyan + glow) · focus-visible · pressed · disabled · loading (skeleton > 300ms, inline spinner in buttons) · empty (message + action) · error (inline, near the cause, Retry).

## 7. Accessibility

- WCAG 2.2 AA contrast per the tables; re-verify any new pair.
- Full keyboard operation, tab order = visual order. `Enter` sends, `Shift+Enter` newline, `Esc` closes, focus trapped in dialogs and restored.
- Visible `:focus-visible` ring on every control (`2px --ring`, `2px` offset; inset inside clipped containers).
- Icon-only buttons have `aria-label`; decorative icons and HUD ornaments `aria-hidden="true"`.
- Uppercase mono labels are styled with `text-transform` (screen readers get normal text).
- One polite `role="status"` live region (typing, new messages while unfocused, queue flush).
- Message list `role="log"`, virtualized for long histories.
- Respect `prefers-reduced-motion`. Glow/scanlines never reduce text contrast below the table values.

## 8. Anti-patterns (do not)

- Discord's palette/fonts/logo/flat rows; copying a specific game's UI.
- Clip-path on focusable controls; glitch or flicker on readable content; Orbitron for user text.
- Neon text on neon fills; colour-only status; a light theme.
- Placeholder-only labels; top-of-form-only errors; spinners > 1s; layout shift on image load.
- Raw hex in components; one-off durations.

## 9. Pre-delivery checklist

- [ ] Tokens only (dark theme)
- [ ] Every control: hover, focus-visible, pressed, disabled
- [ ] Loading, empty, error states present
- [ ] Focus visible inside clipped containers
- [ ] Icon buttons labelled, ornaments hidden from AT
- [ ] Keyboard-only walkthrough passes
- [ ] Contrast pairs verified
- [ ] Reduced motion: no glitch/loops
