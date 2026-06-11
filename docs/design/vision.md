# Magic World — Art Direction & Game Feel (BINDING design spec)

Companion to `docs/CONTRACTS.md` (the technical contract — it always wins on conflict).
Identity in one line: **a flat-shaded storybook island at golden hour, where magic is neon candy against natural pastels.**
All meshes `flatShading: true` unless noted. Renderer is ACES + sRGB (already set) — the hex values below are authored FOR that pipeline; do not "compensate" them.

## 1. Master color palette (hex, exact)

### Natural world
| Use | Hex | Notes |
|---|---|---|
| Deep water | `#1a6f8f` | Water plane base color |
| Water surface / emissive night tint | `#35d0c5` | opacity 0.75, emissiveIntensity 0.25 at night, 0.0 by day |
| Sand (terrain vertex color, y < waterLevel+1.2) | `#e8d6a0` | |
| Lush grass (low slopes) | `#5dbb63` | dominant terrain color |
| Deep grass / forest floor | `#3a9152` | blend toward this above y=8 |
| Mossy-violet rock (slope > 0.55 or y > 12) | `#7a6a8f` | the signature "magic seeps into stone" tint |
| Snow caps (y > 16) | `#f4f6ff` | |
| Tree trunk | `#7a5230` | |
| Natural canopy (3-way mix per tree) | `#4caf50` / `#3e8e41` / `#6cc24a` | |
| Rock props | `#8d8d96` | |

### Magic accents (saturated, emissive — never use on natural surfaces)
| Use | Hex | emissiveIntensity |
|---|---|---|
| Arcane cyan (crystals, crystal block, water sparkle, mana bar start) | `#7fe7ff` | 0.9 |
| Spell violet (blink, portals, mana bar end) | `#a96bff` | 1.0 |
| Fairy pink (magical canopies, mushroom spots) | `#ff7ad9` | 0.7 |
| Sun gold (conjure sparkles, gold block, fireball core) | `#ffc24b` | 1.0 |
| Fire orange (explosions, lava) | `#ff6622` | 1.2 |
| Wisp white-green | `#c8ffe8` | 0.8 |

### UI (HUD/Menus)
Panel bg `rgba(12, 16, 34, 0.55)`; border glow `#7fe7ff` at 35% alpha, 1px + 8px blur; text `#f2f5ff`; mana gradient `#7fe7ff → #a96bff`; danger flash `#ff4d6d`; toast bg `rgba(20, 12, 40, 0.7)`. Font stack: `'Segoe UI', system-ui, sans-serif`; border-radius 10px on all panels.

## 2. Lighting & fog per time of day (`sky.timeOfDay` keyframes — lerp between)

Fog is `THREE.FogExp2`. Sun = DirectionalLight, Hemi = HemisphereLight(skyColor, groundColor), Moon = DirectionalLight.

| t | Phase | Sky top → horizon | Sun color / intensity | Hemi sky/ground / intensity | Fog color / density |
|---|---|---|---|---|---|
| 0.00 | Midnight | `#0b1033` → `#1a2150` | — (moon `#8aa3ff` @ 0.35) | `#27306b` / `#101225` @ 0.45 | `#141a3d` / 0.0045 |
| 0.25 | Dawn | `#3c4d8f` → `#ff9e6b` | `#ffb27a` @ 1.1 | `#7e8fd0` / `#4a4060` @ 0.7 | `#e8a37c` / 0.0035 |
| 0.50 | Noon | `#3ec5f0` → `#bfeaf7` | `#fff3d6` @ 2.4 | `#9fd9f5` / `#6a8f5e` @ 1.0 | `#cfeaf2` / 0.0022 |
| 0.75 | Dusk | `#2e3a7a` → `#ff7e4d` | `#ff8a4d` @ 1.0 | `#6f6aa8` / `#3d3450` @ 0.65 | `#d77a55` / 0.0035 |
| 0.90 | Night | `#0d1238` → `#23295e` | — (moon @ 0.35) | `#2b3470` / `#121428` @ 0.45 | `#161c42` / 0.0045 |

- Stars: 1200 points, opacity 0 by day, fade to 0.9 over t ∈ [0.78, 0.84] (mirror at dawn).
- Game starts at t = 0.35 (contract) — late golden morning: warm, optimistic, fog density ~0.0028.
- Night is **never** pitch black: hemi floor 0.45 keeps silhouettes readable; magic emissives carry the scene.

## 3. The 5 signature magical moments (must-deliver)

1. **First nightfall (~t 0.78, ≈90s into a fresh session).** As the sun dips, within 8s: fireflies ramp to full opacity, crystals visibly pulse (emissive 0.9 → 1.3, sine, 2.5s period), water gains teal glow, wisps drift toward crystals. The island should feel MORE alive at night, not less.
2. **Fireball impact.** 60-particle burst `#ff6622 → #ffc24b`, flash intensity 4 / 0.25s, 3.5-radius block destruction, scorch dip — total impact reads in under 0.4s. The benchmark for "spells feel powerful."
3. **Conjure a spire at dusk.** Blocks rise bottom-up over 1.5s with stagger + golden sparkle rain (`#ffc24b`, ~2s) while the sky burns orange. Prefab placement must feel like a miracle, not a paste.
4. **Portal hop.** Step in → violet burst both ends, shimmer SFX, instant relocation. Torus rotates 0.4 rad/s, emissive pulses 0.8↔1.4 over 1.8s. Linked portals across the island = the player's first "I built infrastructure with magic" moment.
5. **Floating-island pilgrimage.** Toggle fly, ascend through fog into clear air, land on a bobbing island (±1.5 bob) with its own crystal. From up there the whole island reads as a diorama — fog density must allow ~200m visibility at noon (hence 0.0022).

## 4. Movement & game-feel (within PlayerController contract)

- **Acceleration:** reach 8 m/s in 0.18s (exp smoothing, λ ≈ 12/s); decel to rest in 0.22s (λ ≈ 10/s). Snappy start, slightly softer stop. Air control at 60% of ground accel.
- **Sprint (×1.8):** lerp camera FOV 70 → 76 over 0.25s on sprint start, back over 0.3s (easeOutQuad). Fly mode: same FOV kick, damping λ ≈ 6/s for floaty-but-controlled drift.
- **Jump:** vy 9, gravity 24 (contract) → ~0.75s airtime, ~1.7m apex. On landing from fall > 4 m/s: camera dips 0.12m, recovers over 0.25s (easeOutCubic). No screen shake on landing.
- **Camera:** sensitivity 0.0023 (contract). Head-bob while walking: vertical sine amplitude 0.035m at 2.2 Hz (scale with speed/8, zero when flying/swimming). Subtle — readable, never nauseating.
- **Screen shake budget:** ONLY `fx:explosion` within 12m of camera: amplitude 0.05 rad falloff-by-distance, duration 0.3s, decay easeOutQuad. Nothing else shakes.

## 5. Juice rules (all systems)

- **Easings (canonical names):** UI/HUD transitions `easeOutCubic` 0.18s; selections/highlights `easeOutBack` 0.25s (overshoot 1.7); spawns/grows `easeOutBack` (tree grow 1.5s per contract); fades `easeInOutQuad`.
- **Block place:** scale pop 0.7 → 1.05 → 1.0 over 0.15s. Remove: shrink to 0 in 0.1s + 8-particle puff in block color.
- **Every spell cast** pairs ≥3 channels: particles + light flash + SFX. A cast with fewer than 3 is a bug.
- **Hotbar selection:** selected slot scales 1.12, border `#7fe7ff`, transition 0.15s. Cooldown overlay: vertical fill, `rgba(0,0,0,0.55)`.
- **Toasts:** slide down 12px + fade in 0.2s, hold per duration, fade out 0.35s. Max 3 stacked.
- **Idle world motion:** nothing is ever fully static — water waves, island bob, crystal pulse, firefly drift, wisp wander. Target: any random screenshot contains ≥2 moving elements.

## 6. Hard don'ts

- No pure black (`#000000`) anywhere — darkest value is `#0b1033`.
- No desaturated "realism" grays on magic elements; magic is always one of the 6 accent hexes.
- No motion that exceeds the shake/bob budgets above; comfort beats spectacle.
- No new post-processing passes — the look lives in palette + emissives + fog + ACES, at 60fps on integrated GPUs.
