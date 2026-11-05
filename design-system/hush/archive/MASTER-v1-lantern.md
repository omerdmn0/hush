# Hush — Design System (MASTER)

> Global source of truth for every Hush screen. A file in `pages/<page>.md`, if present,
> overrides this one for that page only. Approved 2026-11-05.

Generated with the ui-ux-pro-max workflow (product match: *Chat & Messaging App* →
Minimalism + micro-interactions, sender/receiver bubble contrast). The database palette
(messenger blue/indigo) was replaced with an original palette to stay clearly distinct
from Discord. Icons use **lucide-react** per project requirement (the skill's default is Phosphor).

---

## 1. Identity

- **Name:** Hush
- **Concept:** "a lantern lit in a quiet room" — warm near-black neutrals, one honey-amber accent.
- **App icon:** rounded speech bubble with a crescent moon cut into it, honey on warm charcoal.
  Source: `design-system/hush/icon.svg`. Must stay legible at 16px (tray).
- **Voice:** short, calm, plain. Sentence case everywhere. No exclamation marks in system text.

## 2. Colour tokens

All values are hex. Ratios are WCAG 2.x contrast against the background noted.
Text needs ≥ 4.5:1; UI graphics (icons, borders of inputs, status dots, focus ring) need ≥ 3:1.

### Surfaces

| Token | Role | Dark (default) | Light |
|---|---|---|---|
| `--bg-sidebar` | Sidebar background | `#13110F` | `#F0EAE2` |
| `--bg-app` | Chat / main pane background | `#1A1714` | `#FAF7F2` |
| `--surface` | Raised: composer, cards, inputs | `#24201C` | `#FFFFFF` |
| `--surface-elevated` | Popovers, dialogs, menus | `#2C2723` | `#FFFFFF` (+ shadow) |
| `--hover` | Hover fill (rows, ghost buttons) | `#221E1A` | `#E7E0D6` |
| `--pressed` | Pressed / active fill | `#2A2521` | `#DED6CB` |
| `--border` | Decorative dividers | `#3A342E` | `#E3DCD3` |
| `--border-strong` | Input outlines, control edges (≥ 3:1) | `#7D7369` (3.5 on surface) | `#8F8478` (3.7 on surface) |
| `--scrim` | Behind dialogs / lightbox | `rgba(10,8,6,.72)` | `rgba(31,27,23,.45)` |

### Text

| Token | Role | Dark | Light |
|---|---|---|---|
| `--text` | Primary text | `#F3EDE6` (15.4 on bg-app) | `#1F1B17` (16.0 on bg-app) |
| `--text-muted` | Secondary text, timestamps, placeholders, pending label | `#A89E93` (6.8 on bg-app, 5.0 on bubble-mine) | `#6B6158` (5.7 on bg-app, 4.9 on bubble-mine) |

> Change from the first draft: timestamps use `--text-muted` instead of a separate dimmer
> grey (`#8C8278`), because they sit inside bubbles and the dimmer grey fell below 4.5:1 there.

### Accent

| Token | Role | Dark | Light |
|---|---|---|---|
| `--accent` | Primary buttons, active toggles, read ticks | `#F2B45A` | `#A35F0B` |
| `--on-accent` | Text/icons on accent | `#1A1714` (9.7) | `#FFFFFF` (5.0) |
| `--accent-hover` | Primary button hover | `#F5C27A` (11.0 w/ on-accent) | `#8C510A` (6.4 w/ on-accent) |
| `--accent-subtle` | Selected nav item, highlight fill | `#33291B` | `#F6E7D0` |
| `--accent-text` | Links, accent-coloured text on bg | `#F2B45A` (9.7) | `#A35F0B` (4.7) |
| `--ring` | Focus ring (2px, 2px offset) | `#F2B45A` (9.7) | `#A35F0B` (4.7 on bg, 5.0 on white) |

### Bubbles

| Token | Role | Dark | Light |
|---|---|---|---|
| `--bubble-mine` | My messages (right) | `#3A2E1F` (text 11.4) | `#F8E4C6` (text 13.8) |
| `--bubble-theirs` | Their messages (left) | `#26221E` (text 13.6) | `#FFFFFF` + 1px `--border` (text 17.1) |

### Status & semantic

| Token | Role | Dark | Light |
|---|---|---|---|
| `--online` | Online dot (filled) | `#4CC38A` (8.5 on sidebar) | `#16804D` (4.2 on sidebar) |
| `--offline` | Offline ring (hollow) | `#7A7068` (3.9 on sidebar) | `#8F8478` (3.1 on sidebar) |
| `--success` | Delivered notice, live call indicator | `#4CC38A` (8.1 on bg) | `#16704A` (5.7 on bg) |
| `--danger` | Hang up, destructive button fill | `#C7372F` | `#C7372F` |
| `--on-danger` | Text on danger | `#FFFFFF` (5.2) | `#FFFFFF` (5.2) |
| `--danger-hover` | Destructive hover | `#A82D26` (6.8) | `#A82D26` (6.8) |
| `--danger-text` | Inline error text | `#F47067` (6.3 on bg) | `#B42D25` (5.9 on bg) |
| `--callbar` | In-call bar background | `#15231B` (text 14.0, success 7.4) | `#E2F2E8` (text 14.8, success 5.3) |

### Shadows

| Token | Dark | Light |
|---|---|---|
| `--shadow-sm` | none (use `--border`) | `0 1px 2px rgba(31,27,23,.06)` |
| `--shadow-lg` | `0 12px 32px rgba(0,0,0,.45)` | `0 12px 32px rgba(31,27,23,.14)` |

Rules:
- Components use tokens only — never raw hex or Tailwind palette classes (`bg-amber-400`).
- Implement as shadcn/ui CSS variables in `:root` (dark is the default) with a `.light` override,
  exposed to Tailwind through `@theme inline`.
- Status is never colour-only: online = filled dot, offline = hollow ring, always with a text label.

## 3. Typography

- **Font:** Plus Jakarta Sans (variable, 400–700), bundled locally via `@fontsource-variable/plus-jakarta-sans`
  (latin + latin-ext subsets, so Turkish characters render). **No runtime requests to Google Fonts.**
- Fallback stack: `"Plus Jakarta Sans Variable", "Segoe UI", "Noto Sans", system-ui, sans-serif`.

| Style | Size / line-height | Weight | Use |
|---|---|---|---|
| Title | 20 / 28 | 600 | Settings page titles |
| Heading | 18 / 26 | 600 | Chat header name, dialog titles |
| Body | 16 / 24 | 400 | Message text |
| UI | 14 / 20 | 500 | Buttons, labels, sidebar |
| Small | 12 / 16 | 500 | Timestamps, helper text, badges (minimum size) |

## 4. Spacing, size & shape

- Spacing scale (4px base): `4, 8, 12, 16, 24, 32, 48`.
- Hit targets: ≥ 32px for desktop pointer controls, ≥ 40px for primary actions (send, call, hang up); 8px+ gap between adjacent targets.
- Radii: controls `8px`, bubbles `14px` (sender-side corner `4px` on the last bubble in a group), panels/dialogs `12px`, avatars round.
- Layout: sidebar `240px` fixed · main pane flexible · chat column max-width `760px` centred · call bar `56px` · composer min `56px`, grows to 8 lines.
- Window minimum: `880 × 560`.

## 5. Motion

| Token | Value | Use |
|---|---|---|
| `--dur-micro` | 150ms | Hover, press, toggle |
| `--dur-enter` | 200ms | Message appear, popover/dialog open |
| `--dur-exit` | 140ms | Close / dismiss (≈ 70% of enter) |
| `--ease` | `cubic-bezier(.2,.8,.2,1)` | All |

- New message: fade + 4px rise. Typing dots: 1.2s loop. Call live dot: soft pulse.
- `prefers-reduced-motion: reduce` → no translate/pulse/loops; state changes are instant opacity only.
- Never animate width/height; use transform and opacity.

## 6. Components & patterns

### Messages
- Bubbles: mine right (`--bubble-mine`), theirs left (`--bubble-theirs`). Max width 68% of the column.
- Grouping: consecutive messages from the same sender within **5 minutes** form a group; avatar + name only on the first bubble of their group; 2px between bubbles in a group, 16px between groups.
- Date separators: centred pill — "Today", "Yesterday", weekday for the last 7 days, otherwise "5 Nov 2026".
- Timestamp inside each bubble, bottom-right, `Small` / `--text-muted`. Full date/time in a tooltip.
- Delivery status (my messages, last bubble of a group and any non-read bubble), icon + accessible label:
  - **Pending** — `clock` icon + "Waiting for {name} to come online" (shown under the latest pending bubble only).
  - **Sent** — `check` · **Delivered** — `check-check` muted · **Read** — `check-check` accent.
- Queue delivered: inline system notice in the timeline ("3 queued messages delivered", `circle-check`, `--success`) + a toast if the window is unfocused.
- Images: thumbnail in a bubble, max 320×320, aspect preserved, space reserved before load (no layout shift); click / Enter opens a lightbox (Esc closes, focus returns to the thumbnail). Upload states: progress overlay, failed + Retry.
- Typing indicator: three dots in a "theirs" bubble + visually-hidden "{name} is typing".

### Sidebar
- Top: wordmark. Peer card: 64px avatar with status badge, name, status text ("Online" / "Offline · last seen 2h ago"), Call button.
- Bottom: my avatar, name, mute toggle, settings button.

### Call bar
- 56px, `--callbar`, above the chat. Left: live dot + "In call with {name}" + timer (`mm:ss`, tabular numbers). Right: mute toggle (`aria-pressed`), mic selector, hang up (`--danger`).
- Incoming call: dialog with avatar, "{name} is calling", Decline (danger) / Accept (success-coloured accent), ringtone; Esc = decline.

### Forms (settings)
- Visible label above every field, helper text below, error text below the field in `--danger-text` with `circle-alert` icon; `aria-invalid` + `aria-describedby`.
- Toggles and selects save immediately; text fields save on blur/Enter and show an inline "Saved" check.

### Required states for every component
default · hover · focus-visible · pressed · disabled · loading (skeleton for > 300ms loads, inline spinner in buttons) · empty (message + action) · error (inline, near the cause, with Retry).

## 7. Accessibility

- WCAG 2.2 AA contrast as listed above; re-verify any new pair.
- Full keyboard operation; tab order = visual order. `Enter` sends, `Shift+Enter` newline, `Esc` closes popovers/dialogs, focus trapped in dialogs and restored on close.
- Visible `:focus-visible` ring on every interactive element (`2px --ring`, `2px` offset). Never remove outlines without replacement.
- Icon-only buttons have `aria-label`; decorative icons `aria-hidden="true"`.
- One polite live region (`role="status"`) for "{name} is typing", new messages while focused elsewhere, and queue-delivered notices. No competing live regions.
- Message list: `role="log"`, virtualized for long histories (render only visible rows).
- Respect `prefers-reduced-motion`.

## 8. Anti-patterns (do not)

- Discord's palette (blurple `#5865F2`, cool blue-greys), its fonts, logo, or flat-row message layout.
- Emoji as UI icons; mixing icon sets.
- Colour-only status; placeholder-only labels; errors only at the top of a form.
- Spinners for > 1s loads; layout shift when images load.
- Raw hex in components; one-off durations.

## 9. Pre-delivery checklist

- [ ] Tokens only, both themes checked
- [ ] Every interactive element: hover, focus-visible, pressed, disabled
- [ ] Loading, empty, error states present
- [ ] Icon buttons labelled, decorative icons hidden
- [ ] Keyboard-only walkthrough passes
- [ ] Contrast pairs verified
- [ ] Reduced motion respected
- [ ] `cursor: pointer` on clickable elements
