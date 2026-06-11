# Magic World — Spell VFX Choreography (implementation spec)

Binding companion to `docs/CONTRACTS.md`. All effects use ONLY `particles.burst/stream/flash`, spell-owned meshes/PointLights, and contract events. Budget: particle pool ≥2000 — per-cast totals below never exceed 300; `flash` pool is 4 concurrent, so every flash here is ≤0.4s. Easing functions (implement as local helpers, no libs): `easeOutCubic t=>1-(1-t)**3`, `easeOutBack t=>1+2.70158*(t-1)**3+1.70158*(t-1)**2`, `easeInQuad t=>t*t`, `easeOutExpo t=>t===1?1:1-2**(-10*t)`. "POWER" recipe used throughout: (1) anticipation flash ≤0.1s, (2) overshoot scale via easeOutBack, (3) light intensity spike then exponential decay, (4) two-tone particles (hot core color + cooler halo color).

## 1. Fireball 🔥 (mana 15, cd 0.6)
- **Muzzle (t=0):** `flash(origin+dir*1.2, 0xffcc66, 3, 0.12)` + `burst{count:12, color:0xffaa33, speed:4, life:0.3, size:0.2, spread:0.4}` at muzzle. Sphere (r=0.28, `MeshBasicMaterial 0xff5500`) spawns at scale 0.1, scales to 1.0 over 0.08s easeOutBack (overshoots to ~1.15). Attached PointLight `0xff7733`, intensity 2.5, distance 9.
- **Flight:** speed 38 m/s, gravity 4. Every 0.03s: `stream{direction:-velocity.normalized, color:0xff8833, count:5, speed:2, life:0.45, size:0.22}`; every 0.09s one ember `stream{color:0xffdd55, count:2, speed:1, life:0.7, size:0.12}`. Sphere scale pulses ±8% at 14 Hz (sin). Light intensity flickers 2.2–2.8 (random per frame).
- **Impact — frame-by-frame beats** (`hit` = first frame within 0.5m of terrain/hitPoint):
  - **t=0ms:** hide sphere, kill its light. `flash(hit, 0xffffff, 6, 0.08)` — white snap frame.
  - **t=0ms (same frame):** core `burst{count:50, color:0xffdd33, speed:11, life:0.55, size:0.4, gravity:2, spread:1}`.
  - **t=30ms (next ~2 frames):** halo `burst{count:70, color:0xff6622, speed:7, life:0.9, size:0.45, gravity:5, spread:1}` + `flash(hit+ (0,1,0), 0xff7733, 5, 0.35)` (decays inside Particles).
  - **t=60ms:** emit `fx:explosion{position:hit, radius:3.5, color:0xff6622}`; `terrain.modify(x, z, -0.4, 2.5)`.
  - **t=100ms:** smoke `burst{count:30, color:0x554433, speed:2.5, life:1.6, size:0.6, gravity:-1.5(rises), spread:1}`.
  - **t=300ms:** lingering embers `burst{count:14, color:0xffaa44, speed:1.2, life:1.2, size:0.14, gravity:3}`. Effect returns false at t=1.6s.
- Power feel = the 80ms white→orange two-stage flash + 120-particle two-tone burst + terrain scar.

## 2. GrowTree 🌳 (mana 12, cd 0.8)
- Cast: `flash(hitPoint, 0x66ff88, 2.5, 0.3)`; ground ring `burst{count:24, color:0x44dd66, speed:3, life:0.8, size:0.25, gravity:-2, spread:1}` (rises). Tree grows via `vegetation.spawnTree` (its own 1.5s overshoot grow).
- While tree grows (effect lives 1.5s): every 0.15s `stream{position:hit+(0,h,0) climbing h:0→3, direction:(0,1,0), color:0xff88dd, count:4, speed:1.5, life:0.9, size:0.18}` — pink sparkle spiral up the trunk. At t=1.5s canopy pop: `burst{count:20, color:0x88ffcc, speed:2, life:0.7, size:0.2}` at hit+(0,3,0).
- Alt-cast: 5 trees at radius 2.5, staggered 0.18s apart (clockwise), each with the small ring burst — sequential pops read as a wave.

## 3. LightOrb 💡 (mana 10, cd 0.5)
- Orb: sphere r=0.18 `0xfff2cc` emissive + PointLight `0xffeedd`, intensity 1.8, distance 14. Birth: scale 0.01→1 over 0.25s easeOutBack + `burst{count:16, color:0x99eeff, speed:2.5, life:0.6, size:0.15}`.
- Idle: bob ±0.18m at 0.5 Hz; light intensity breathes 1.6–2.0 at 0.3 Hz; every 0.5s `stream{direction:(0,-1,0), color:0xaaddff, count:2, speed:0.4, life:1, size:0.1}` falling motes.
- Death (40s, last 3s): fade emissive+light to 0 easeInQuad, then pop `burst{count:10, color:0xffffff, speed:3, life:0.4, size:0.12}`. Oldest-evicted orb uses the same pop.

## 4. Terraform ⛰️ (mana 4, cd 0.15)
- Raise: `burst{count:18, color:0x9c7b54, speed:2, life:0.7, size:0.35, gravity:-3(lifts), spread:1}` + 6 gray chips `burst{count:6, color:0x888888, speed:4, life:0.5, size:0.2, gravity:8}`. Lower (alt): same but dust color `0x6b5a43`, gravity 6 (falls inward feel). No flash — rapid-fire spell, keep it cheap (≤24 particles/cast at 6.6 casts/s).

## 5. Blink ⚡ (mana 8, cd 0.4)
- Pre-flash at origin: `flash(playerPos+(0,1,0), 0xaa66ff, 4, 0.15)` + implosion `burst{count:25, color:0xbb88ff, speed:-5(spawn at r=1 moving inward — emulate with speed 5, spread 1, life 0.25)}` … implement as `burst{count:25, color:0xbb88ff, speed:5, life:0.25, size:0.2}`.
- Teleport same frame via `player.teleport` (Particles' `player:teleport` listener adds paired bursts). At destination: `flash(dest+(0,1,0), 0xddbbff, 5, 0.25)` + `burst{count:35, color:0x9955ff, speed:6, life:0.6, size:0.3, gravity:-1}` + vertical streak `stream{direction:(0,1,0), color:0xeeccff, count:8, speed:9, life:0.5, size:0.25}`. Total <80 particles; reads as crack-of-light.

## 6. Portal 🌀 (mana 25, cd 1)
- Torus: radius 1.2, tube 0.09, `MeshStandardMaterial` emissive `0x8833ff` (portal A) / `0x33ccff` (portal B), emissiveIntensity pulsing 1.2–2.4 at 0.8 Hz; rotation.z += 0.6·dt.
- Spawn: scale (1,0.01,1)→1 over 0.5s easeOutBack + `flash(center, 0x9944ff, 4, 0.35)` + `burst{count:40, color:0xaa66ff, speed:4, life:0.8, size:0.25}`.
- Idle (each portal, every 0.12s): `stream{position:rim point (angle += 2.4/step), direction:tangent, color:0xcc88ff|0x88ddff, count:2, speed:1.2, life:0.7, size:0.15}` — orbiting swirl, ~17 particles/s/portal.
- **Traversal — frame-by-frame beats** (player feet within 1.3 of center A, cooldown clear):
  - **t=0ms:** entry suck: `burst{count:30, color:0xaa66ff, speed:7, life:0.3, size:0.2}` at A + `flash(A, 0xbb77ff, 5, 0.2)`. Entry torus emissiveIntensity snaps to 4 (decay back over 0.6s easeOutExpo).
  - **t=0ms (same frame):** `player.teleport(B + outward*1.5)` — instant, no fade-to-black (keeps 60fps feel; the flash IS the transition).
  - **t=16ms (frame 2):** at B: `flash(B, 0x66ddff, 6, 0.3)` + expanding ring `burst{count:45, color:0x88eeff, speed:8, life:0.5, size:0.3, gravity:0, spread:1}` + `burst{count:20, color:0xffffff, speed:3, life:0.35, size:0.15}` white core.
  - **t=120ms:** B torus emissiveIntensity 4→pulse-normal over 0.6s. Re-entry cooldown 2s starts.
  - Audio gets `player:teleport` automatically. Two flashes 16ms apart on two colors = "pulled through" reading.

## 7. SummonGolem 🗿 (mana 40, cd 2)
- Pre-beat: `flash(hit, 0xffaa44, 3, 0.3)` + ground crack dust `burst{count:40, color:0x776655, speed:3, life:1, size:0.4, gravity:-2}` ring. 0.25s later (effect timer) golem rises (`golems.spawn` handles rise) + second `burst{count:25, color:0x998877, speed:5, life:0.8, size:0.35, gravity:7}` debris + `flash(hit+(0,1.5,0), 0xff8855, 4, 0.3)` as rune eyes ignite. Two-stage = weight.

## 8. TimeWarp 🌙 (mana 20, cd 1.5)
- Over 1.2s effect (sky.advance in steps, easeInOut distribution: step_i ∝ sin(π·t/1.2)): every 0.1s `stream{position:player+(0,3,0)+circle(r=2, angle+=0.9), direction:(0,1,0.3 rotated), color: forward? 0xffcc66 : 0x6688ff, count:5, speed:2.5, life:1, size:0.3}` — 60 particles spiraling overhead, sun-gold forward / moon-blue backward. `flash(player+(0,4,0), same color, 2.5, 0.4)` at t=0 and t=1.0s. Halo only — the real spectacle is the sky itself moving.

## 9. Conjure 🏰 (mana 35, cd 2.5)
- Cast: `flash(hit+(0,4,0), 0xffd700, 3.5, 0.4)`. Over 2s (matches `placePrefab` stagger): every 0.1s `burst{position:hit+(rand±3, 6, rand±3), count:8, color: alternate 0xffd700 / 0xfff0aa, speed:1, life:1.4, size:0.2, gravity:2.5}` — golden rain, ~160 particles total, drifting down onto rising blocks. Final beat t=2s: `burst{count:30, color:0xffe066, speed:5, life:0.8, size:0.25, gravity:-0.5}` + `flash(hit+(0,3,0), 0xffd700, 4, 0.3)` — completion fanfare synced with `prefab:place` chord swell.

## Particle budget summary (worst case per cast)
| Spell | Particles | Flashes | Lights owned |
|---|---|---|---|
| Fireball | 164 + trail (~165/s flight) | 3 (staggered) | 1 (projectile) |
| GrowTree | 44 (alt: 120 staggered) | 1 | 0 |
| LightOrb | 26 + 4/s idle | 0 | 1 per orb (max 6) |
| Terraform | 24 | 0 | 0 |
| Blink | 68 | 2 | 0 |
| Portal | 40 spawn + 17/s/portal idle; traversal 95 | 1 / 2 | 0 (emissive only) |
| SummonGolem | 65 | 2 | 0 |
| TimeWarp | 60 over 1.2s | 2 | 0 |
| Conjure | 190 over 2s | 2 | 0 |

Worst concurrent realistic load (fireball impact + 2 portals + 3 orbs idle) ≈ 420 live particles — well under the 2000 pool.

## Global polish rules
- Never exceed 2 concurrent `flash` calls per spell beat (pool of 4 is shared with other casters).
- All spell-created meshes/lights: remove from scene + `material.dispose()` only if material is unique (fireball sphere shares one cached material per spell class — create once in constructor).
- All timed sequences run inside the returned effect's `update(dt)` via an accumulated `this.t` — no `setTimeout`.
- Color language (consistency contract): fire=orange/gold `0xff6622/0xffdd33`, nature=green/pink `0x44dd66/0xff88dd`, arcane/teleport=violet `0x9955ff`, portal B/water=cyan `0x33ccff–0x88eeff`, divine/conjure=gold `0xffd700`, time=gold-vs-blue.
