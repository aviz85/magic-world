# Magic World — UI / HUD / Menus / Minimap Design Spec

Binding visual spec for `src/ui/HUD.js`, `src/ui/Menus.js`, `src/ui/Minimap.js`. Fits CONTRACTS.md exactly (DOM inside `#ui`, own `<style>` tags, `pointer-events: auto` only on interactive elements).

## 1. Fantasy-Glass Visual Language (shared tokens)

- **Panel background:** `rgba(14, 16, 34, 0.55)`
- **Panel backdrop blur:** `backdrop-filter: blur(8px)` (Menus overlay backdrop: `blur(12px)`)
- **Panel border:** `1px solid rgba(127, 231, 255, 0.35)` (cyan glass edge)
- **Panel glow:** `box-shadow: 0 0 12px rgba(127, 231, 255, 0.25), inset 0 0 8px rgba(127, 231, 255, 0.08)`
- **Corner radius:** panels 10px; pills/badges 999px; hotbar slots 8px
- **Text primary:** `rgba(255, 255, 255, 0.92)`; secondary `rgba(255, 255, 255, 0.55)`
- **Accent cyan:** `#7fe7ff` · **Accent violet:** `#b48cff` · **Accent pink:** `#ff8ad8` · **Accent gold:** `#ffd86b` · **Danger red:** `#ff5566`
- **Font stack:** `font-family: 'Georgia', 'Palatino', ui-serif, serif` for title/headers; `font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif` for body/labels. No webfonts.
- **Base sizes:** body 13px; labels 11px; tips 11px; toasts 14px; mode badge 13px; title 64px.
- **All transitions:** `ease-out` 150ms unless stated otherwise. Selected/highlight states use `cubic-bezier(0.34, 1.56, 0.64, 1)` (back-out pop) at 200ms.

## 2. Crosshair (center)

- Dot: 4×4px circle, `rgba(255,255,255,0.9)`, `box-shadow: 0 0 4px rgba(127,231,255,0.8)`.
- Ring: 18×18px, `1.5px solid rgba(255,255,255,0.35)`, centered on dot. No animation.

## 3. Mana Bar (bottom-left)

- Container: 220×18px, position `left: 20px; bottom: 20px`, panel style above, radius 9px, padding 2px.
- Fill: full-height rounded bar, **gradient** `linear-gradient(90deg, #7fe7ff 0%, #9d7bff 60%, #d36bff 100%)`, `box-shadow: 0 0 8px rgba(157,123,255,0.6)`.
- Animate width via `transform: scaleX()` with `transform-origin: left`, `transition: transform 120ms linear` (update each frame from `spells.getState().mana / manaMax` — no innerHTML rebuilds).
- Label "Mana" 11px, `letter-spacing: 1px`, uppercase, secondary text color, positioned 4px above the bar.
- `mana:insufficient` → flash: bar border + glow switch to `#ff5566` (`box-shadow: 0 0 14px rgba(255,85,102,0.8)`) for 350ms, plus a 2-cycle shake `translateX(±3px)` 300ms total, easing `ease-in-out`.

## 4. Hotbar (bottom-center)

- 9 slots, single row, centered, `bottom: 20px`. Slot: 52×52px, gap 6px, panel background, radius 8px, border `1px solid rgba(127,231,255,0.25)`.
- Slot contents: icon (spell emoji or block color swatch) 24px centered; slot number top-left 9px secondary; label below icon 9px, truncated with `text-overflow: ellipsis`.
- **Magic mode:** 9 spell slots from `spells.getState()`. **Build mode:** slots 1–8 show block defs — swatch is a 24×24px rounded square (4px radius) filled with the block's `color` hex (emissive blocks add `box-shadow: 0 0 6px <color>`); slot 9 rendered empty at `opacity: 0.25`.
- **Selected slot:** border `2px solid #ffd86b`, `box-shadow: 0 0 14px rgba(255,216,107,0.55)`, `transform: translateY(-4px) scale(1.08)` with the back-out pop easing.
- **Cooldown:** overlay `rgba(10,10,25,0.65)` filling from bottom, height = `cooldownLeft / cooldown * 100%`; icon at `filter: grayscale(0.8); opacity: 0.5` while cooling. Update per frame via `style.height` only.
- **Mode badge** (centered, 8px above hotbar): pill, 13px text, panel style; "✨ Magic" with cyan border / "🧱 Build" with gold border (`rgba(255,216,107,0.45)`). Cross-fade 150ms on `mode:change`.

## 5. Toasts (top-center)

- Stack at `top: 24px`, centered, newest on top, max 4 visible (oldest removed immediately when exceeded).
- Toast: panel style, radius 999px, padding `8px 20px`, 14px text, max-width 420px, `margin-bottom: 8px`.
- Enter: `opacity 0→1` + `translateY(-12px)→0`, 200ms `ease-out`. Exit: `opacity 1→0` + `translateY(0)→-8px`, 300ms `ease-in`, starting at `duration - 0.3s` (default duration 2.5s per contract).
- Toasts are `pointer-events: none`.

## 6. Tips Line (bottom-right)

- `right: 20px; bottom: 20px`, 11px, color `rgba(255,255,255,0.4)`, no panel background, `text-shadow: 0 1px 3px rgba(0,0,0,0.8)`.
- Copy (exact): `B: build/magic · F: fly · H: help · K/L: save/load`

## 7. Title / Help Overlay (Menus.js)

- Full-screen, shown when pointer unlocked. Backdrop: `rgba(8, 9, 22, 0.72)` + `backdrop-filter: blur(12px)` + vignette `radial-gradient(ellipse at center, transparent 40%, rgba(0,0,0,0.55) 100%)`. Entire overlay `pointer-events: auto`; click anywhere → `ctx.input.requestPointerLock()`.
- Fade in/out 250ms `ease-out` on `input:lockchange`.
- **Layout (vertical, centered, max-width 760px):**
  1. Title: `Magic World ✨` — 64px serif, color `#fff`, `text-shadow: 0 0 24px rgba(127,231,255,0.9), 0 0 60px rgba(180,140,255,0.5)`; slow pulse animation: text-shadow blur 24px↔36px, 3s `ease-in-out` infinite alternate.
  2. Subtitle (16px, secondary): `An island of living magic awaits.`
  3. Call to action (18px, `#ffd86b`, pulsing opacity 0.7↔1.0, 1.6s ease-in-out infinite alternate): `Click to enter the world`
  4. Two-column controls panel (panel style, padding 20px, columns gap 32px, rows 13px / line-height 1.9). **Exact copy:**
     - Left column: `WASD — Move` · `Mouse — Look` · `Space — Jump / Fly up` · `Shift — Sprint` · `F — Toggle fly (C — down)` · `B — Magic / Build mode`
     - Right column: `Left click — Cast / Place` · `Right click — Alt-cast / Remove` · `1–9 / Wheel — Select` · `M — Mute · H — Help` · `K — Save · L — Load` · `Shift+N — New world`
  5. Spell strip below panel: 9 mini-cards (64×72px, panel style, radius 8px), each: icon emoji 26px + label 10px. Order/labels from `spells.getState()` (Fireball 🔥, Grow Tree 🌳, Light Orb 💡, Terraform ⛰️, Blink ⚡, Portal 🌀, Golem 🗿, Time Warp 🌙, Conjure 🏰).

## 8. Minimap Palette (Minimap.js)

- Canvas 170×170px, `top: 20px; right: 20px`, radius 12px (`border-radius` + canvas clip), border `1px solid rgba(127,231,255,0.35)`, `box-shadow: 0 0 10px rgba(127,231,255,0.25)`.
- **Height palette** (sample `heightData`, thresholds in world y):
  - Deep water (y < waterLevel − 2): `#16335f`
  - Shallow water (y < waterLevel): `#2a6f97`
  - Sand (y < waterLevel + 1.2): `#e3d3a3`
  - Grass (y < 8): `#4f9d4f`
  - High grass / moss (y < 12): `#3c7a46`
  - Rock (y < 16): `#7a6f8a` (violet-tinted, matches terrain)
  - Snow (y ≥ 16): `#f0f4ff`
- Overlays (per frame): player = white arrow triangle 8px long, `#ffffff` with 1px `rgba(0,0,0,0.5)` outline, rotated by yaw; portals = 5px dots `#b48cff` with 3px glow; golems = 4px dots `#9a9a9a`.
- Base layer redraw: on `terrain:modify` throttled ≥ 0.5s, and every 3s (per contract).

## 9. Z-Order & Hygiene

- z-index inside `#ui`: HUD elements 10; toasts 20; minimap 10; Menus overlay 100.
- All HUD elements `pointer-events: none` except the Menus overlay; `user-select: none` everywhere.
- Per-frame DOM writes limited to: mana `transform`, cooldown `height`, minimap canvas. Everything else event-driven.
