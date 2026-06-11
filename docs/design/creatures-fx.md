# Creatures, Particles & Audio — Design Spec (implementation-ready)

Conforms to `docs/CONTRACTS.md`. All hex values are linear `0x` colors fed to three.js materials; sizes in world meters; durations in seconds.

## Wisps (`src/creatures/Wisps.js`)

- **Count:** 12. Each wisp = 1 billboard sprite (additive `PointsMaterial`-style canvas sprite, radial gradient white core → tint → transparent), base size **0.55** world units, plus an inner core sprite at size **0.22**, opacity 0.9.
- **Palette (cycle per index `i % 4`):** `0x7fe7ff` cyan, `0xc88bff` violet, `0xff9ad5` pink, `0xffe9a0` gold. Core is always `0xffffff`.
- **PointLights:** only wisps 0, 4, 8 carry a `PointLight(tint, 1.2, 9, 2)`.
- **Motion character — "curious lantern":** position = anchor + sinusoidal wander. Anchor drifts at **1.4 m/s** toward current goal. Wander offsets: `x += sin(elapsed*0.9 + phase)*1.1`, `y += sin(elapsed*1.7 + phase*2)*0.45`, `z += cos(elapsed*0.7 + phase)*1.1`. Phase = `i * 2.399` (golden angle). Altitude clamp: terrainHeight + **1.0 .. 5.0**.
- **Goals:** re-pick every **6–11 s** (seeded rand): random point within 28 m. At night (`sky.isNight()`), 60% chance goal = nearest crystal cluster + random 3 m offset. If player within **10 m**, goal = player position, but maintain min distance **2.5 m** (push out along the player→wisp vector when closer).
- **Pulse:** sprite scale ×`(1 + 0.18*sin(elapsed*3.1 + phase))`; light intensity 1.2 ± 0.4 on the same sine.
- **Trail:** every **0.22 s** per wisp (stagger by phase), call `particles.stream({ position, direction: (0,-0.3,0), color: tint, count: 2, speed: 0.6, life: 0.7, size: 0.16 })`. Skip trail entirely when wisp is > 45 m from camera.

## Golems (`src/creatures/Golem.js`, class `Golems`)

Total height **2.2 m**, all parts `MeshStandardMaterial({ color: 0x8a8f99, roughness: 0.95, metalness: 0.05, flatShading: true })` with per-golem tint jitter ±`0x0a0a0a`.

| Part | Geometry (w×h×d) | Local position (y from feet) |
|---|---|---|
| Pelvis (root) | Box 0.7×0.35×0.5 | y 1.05 |
| Torso | Box 0.9×0.8×0.6 | y 1.6 |
| Head | Box 0.5×0.45×0.45 | y 2.15 (pivot at neck y 1.95) |
| Upper arm ×2 | Box 0.28×0.7×0.28 | shoulder pivot (±0.62, 1.85, 0) |
| Fist ×2 | Box 0.34×0.34×0.34 | arm tip |
| Leg ×2 | Box 0.3×0.9×0.32 | hip pivot (±0.24, 1.0, 0) |

- **Rune eyes:** 2 boxes 0.09×0.06×0.02 on head front, material `MeshBasicMaterial({ color: 0x7fe7ff })` — emissive cyan glow color **`0x7fe7ff`**. Pulse: scale ×`(1 + 0.25*sin(elapsed*2.4 + golemSeed))`. Add 1 chest rune (box 0.14×0.14×0.02, same material) at torso center front.
- **Walk cycle (speed 3.5 m/s):** legs swing `rotation.x = sin(walkPhase) * 0.55` rad, opposite phases; arms counter-swing at **0.35** rad amplitude, opposite to same-side leg. `walkPhase += dt * 7.0` while moving. Torso bobs `y += |sin(walkPhase)| * 0.06`; torso roll `rotation.z = sin(walkPhase) * 0.04`.
- **Idle:** sway `rotation.z = sin(elapsed*0.8 + seed)*0.025`; head turn: every 4–7 s, lerp head `rotation.y` to random ±0.6 rad over 0.6 s (smoothstep), hold, return.
- **Spawn rise:** golem starts 2.2 m below ground, rises over **1.2 s** with easeOutCubic; `particles.burst({ color: 0x9c8f7a, count: 40, speed: 4, life: 1.2, size: 0.4, gravity: 9 })` at the feet on start; emit `golem:spawn`.
- **Turning:** lerp body `rotation.y` toward heading at rate `min(1, dt*6)`. Feet snap to `terrain.getHeight(x,z)` every frame, smoothed with `y += (target-y)*min(1, dt*10)`.

## Particle palette presets (`src/fx/Particles.js`)

Implement as a frozen exported-internal map; spells pass these exact values:

| Preset | color | count | speed | life | size | gravity |
|---|---|---|---|---|---|---|
| `fireballTrail` | `0xff8833` | 5 | 2.5 | 0.45 | 0.22 | −1 (rises) |
| `fireballBoom` | `0xffaa33` core + second burst `0xffd966` | 60 + 30 | 9 / 5 | 1.0 / 1.4 | 0.45 / 0.3 | 7 |
| `leafSparkle` (GrowTree) | `0x66ee77` + `0xff9ad5` | 24 + 12 | 3.5 | 1.1 | 0.25 | 2 |
| `dust` (Terraform/golem step) | `0x9c8f7a` | 22 | 2.2 | 0.9 | 0.38 | 8 |
| `blinkViolet` | `0xaa66ff` | 30 | 6 | 0.7 | 0.3 | 0 |
| `portalSwirl` | `0xc88bff` | 4/frame ambient | 1.2 | 1.0 | 0.2 | −2 |
| `conjureGold` | `0xffd966` | 12 every 0.1 s for 2 s | 1.5 | 1.3 | 0.28 | 6 |
| `orbPop` | `0xfff2cc` | 16 | 4 | 0.6 | 0.22 | 3 |
| `teleportShimmer` | `0x7fe7ff` | 20 | 5 | 0.6 | 0.25 | 0 |

Gravity convention (per contract): **positive = falls down** at that m/s². Pool 2400 particles, one additive `THREE.Points`, per-particle fade = `opacity ∝ (1 − age/life)²` baked into size/alpha attribute. `flash()` pool: 4 PointLights, default intensity 4, distance 14, decay 2, fade out linearly over `duration`.

## Audio palette (`src/audio/AudioEngine.js`) — all WebAudio-synthesized

Master gain **0.30**. Per-SFX gains given below are pre-master. All envelopes: attack via `linearRampToValueAtTime`, decay via `exponentialRampToValueAtTime` to 0.0001.

### Ambient bed
- **Day:** 2 sawtooth oscillators at **55 Hz** and **55.8 Hz** (beating drone) → lowpass **320 Hz**, Q 0.7 → gain 0.10. LFO (sine **0.07 Hz**, depth ±0.035) on that gain — "breathing". Plus one triangle osc at **220 Hz** through lowpass 500 Hz at gain 0.015 for air.
- **Night:** lowpass drops to **210 Hz** over 3 s; drone gain to 0.08. Crickets: every **1.4–3.8 s** (rand), a burst of 4 chirps spaced 70 ms — each chirp = bandpass-filtered white noise (center **4200 Hz**, Q 12), gain 0.05, attack 5 ms, decay 60 ms. Poll `sky.isNight()` once per second; crossfade states over 3 s.

### SFX table (duration = full envelope)

| Event | Synthesis | Pitch contour | Dur | Gain |
|---|---|---|---|---|
| fireball cast | white noise → bandpass Q 1.5 | filter freq 2400→300 Hz exp | 0.35 | 0.5 |
| explosion | noise → lowpass 900→150 Hz + sine sub 60→35 Hz | both exp down | 0.6 | 0.8 |
| growtree | 3 sines: 523, 659, 784 Hz (C5-E5-G5), staggered 80 ms | flat, each decays | 0.7 | 0.35 |
| lightorb | sine 880 Hz + sine 1760 Hz at 0.3× (bell) | flat, exp decay | 0.9 | 0.4 |
| terraform | sine 90→55 Hz | exp down | 0.18 | 0.6 |
| blink | sine 300→1400 Hz | exp up | 0.25 | 0.45 |
| portal cast | sine 200→900 Hz + detuned +7 Hz partner | exp up | 0.5 | 0.45 |
| golem cast / golem:spawn | sine 45 Hz + noise→lowpass 120 Hz | flat sub, slow 0.9 s decay | 1.0 | 0.7 |
| timewarp | sawtooth 1200→180 Hz → lowpass 800 Hz | exp down (reversed feel: 0.4 s attack) | 1.2 | 0.4 |
| conjure | 4 triangles: 392, 494, 587, 784 Hz, staggered 90 ms | ascending arp | 0.8 | 0.4 |
| block:place | noise → highpass 1800 Hz tick | n/a | 0.07 | 0.5 |
| block:remove | sine 220→140 Hz pop | exp down | 0.12 | 0.45 |
| prefab:place | triad 261+329+392 Hz triangles | 0.3 s attack swell, 1 s decay | 1.3 | 0.45 |
| player:teleport | 3 sines 600→1200, 800→1600, 1000→2000 Hz, 60 ms apart | exp up each | 0.4 | 0.4 |
| mana:insufficient | 2 square notes 180 Hz then 140 Hz, 110 ms apart | flat | 0.3 | 0.35 |

Rate limit: per event name, max 10 triggers/s (drop extras silently). Mute (`KeyM`): ramp master gain to 0 over 0.1 s, back to 0.30 on unmute.
