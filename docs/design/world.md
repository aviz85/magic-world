# World Generation Design — Magic World

Binding companion to `docs/CONTRACTS.md`. All values below are implementation targets; where CONTRACTS.md gives a range, this file picks the exact value.

## Terrain — island shape (src/world/Terrain.js)

- Seed: `1337` (default `createNoise2D(1337)`); placement PRNG `mulberry32(4242)`.
- Heightfield: `res = 160`, span 240 (x,z ∈ [-120, 120]).
- Base: `h = fbm(noise, x, z, { octaves: 5, lacunarity: 2.0, gain: 0.5, scale: 1/55 }) * heightScale (18)`.
- Ridge accent: add `0.35 * heightScale * (1 - |fbm(x*1.7+900, z*1.7+900, {octaves:3, scale:1/28})|)` — gives soft ridgelines, low-poly facets read well with `flatShading: true`.
- Radial falloff: `d = sqrt(x²+z²)/120`; `falloff = 1 - smoothstep(0.55, 0.98, d)`; final `y = h * falloff - 9 * smoothstep(0.80, 1.0, d)` so the rim sits at y ≤ waterLevel − 2 (≤ −0.8).
- Clamp final heights to [-8, +20].
- Spawn plateau: for `r = sqrt(x²+z²) < 25`, blend toward `max(y, waterLevel + 1.6)` with weight `1 - smoothstep(15, 25, r)` (guarantees y ≥ 2.2 near origin, smooth ring).
- Two coves: subtract a gaussian dip (depth 5, sigma 14) centered at `(78, 30)` and `(-65, -72)` — boat-bay silhouettes, breaks the blob shape.

## Height-band vertex colors (by final y; lerp across each ±0.5 band edge; slope > 0.55 forces rock color)

| Band | y range | Hex |
|---|---|---|
| Underwater sand | y < 0.6 | `#c8b87a` |
| Beach sand | 0.6–2.2 | `#e8d49a` |
| Lush grass | 2.2–7.5 | `#5dbb63` |
| Deep grass | 7.5–11 | `#3e9a52` |
| Mossy rock | 11–14.5 | `#8a7f95` (violet-tinted gray) |
| Bare rock | 14.5–17 | `#6f6a7d` |
| Snow | y > 17 | `#f4f7ff` |

- Magical tint: where `fbm(x*0.04+500, z*0.04+500) > 0.45` AND band is grass, lerp 35% toward `#7fd8c9` (fey-meadow patches, ~12% of grass area).
- Scorch (after Fireball `terrain.modify`): recolor modified verts in radius toward `#4a3f38` at 50% strength.

## Sky (src/world/Sky.js)

Dome: inside-facing `SphereGeometry(900, 24, 16)`, 3-stop vertical gradient (shader or vertex colors), stops at dome y-factor 0 / 0.45 / 1. Lerp between keyframes by `timeOfDay` with `smoothstep` over each transition (transition width 0.06 of the cycle).

| Phase | timeOfDay | Horizon | Mid | Zenith | Fog color | Sun light |
|---|---|---|---|---|---|---|
| Night | 0.00 | `#1a1f4d` | `#0e1238` | `#060a24` | `#141a3e` | 0.0 (moon `#a8c4ff` @ 0.35) |
| Dawn | 0.25 | `#ff9e6b` | `#c96fa8` | `#3a4a8c` | `#d98b78` | `#ffd9a0` @ 1.2 |
| Day | 0.50 | `#bfeaff` | `#6ec5f2` | `#3a9ad9` | `#a8d8ef` | `#fff4d6` @ 2.6 |
| Dusk | 0.75 | `#ff7e4d` | `#b85a9e` | `#2e2a66` | `#cf7a62` | `#ffb070` @ 1.0 |

- Fog: `THREE.FogExp2`, density 0.0028 day / 0.0042 night, color lerped per table.
- Hemisphere light: sky `#bcd8ff` / ground `#3e5a3e`, intensity 0.25 night → 0.9 noon.
- Stars: 900 points, sizes 0.8–2.2 (random), colors 80% `#ffffff`, 15% `#cfe2ff`, 5% `#ffd9c4`; opacity 0 by day → 1 at night, fade over 8% of cycle; 25 of them twinkle (sin pulse, period 1.5–4 s).
- Moon: emissive sphere r=7 at orbit radius 600, opposite the sun; color `#e8efff`, emissiveIntensity 1.5; soft halo sprite (canvas radial gradient, 28 units, opacity 0.35).
- Sun disc: emissive sphere r=10, `#ffe9b0`, orbit radius 600 in the x–y plane tilted 18° toward z.

## Water (src/world/Water.js)

- Plane 380×380 at y = 1.2, `PlaneGeometry(380, 380, 64, 64)`.
- Color `#2aa3a8` day, lerp to `#1b5e8a` night; `transparent: true, opacity: 0.75, roughness: 0.15, metalness: 0.0`; night emissive `#0d4a52` @ 0.35 (0 by day).
- Waves (vertex y in update): `0.12*sin(x*0.18 + t*1.1) + 0.09*sin(z*0.23 - t*0.9) + 0.05*sin((x+z)*0.31 + t*1.7)`; recompute normals every frame OR fake with normal-scroll.
- Sparkle: canvas noise texture 128px scrolling uv at (0.008, 0.005)/s, blended 20%.

## Floating islands (src/world/FloatingIslands.js)

- Count: 7. Bob amplitude ±1.5, period 9–14 s (phase = index × 0.9); drift rotation 0.02 rad/s.
- Placement (x, z, y, top-radius): (62, -48, 44, 9) · (-74, 35, 52, 11) · (28, 86, 38, 7) · (-45, -88, 60, 8) · (95, 22, 48, 6) · (-15, 60, 66, 10) · (70, 70, 56, 7). All ≥ 30 from spawn cylinder. ✔
- Shape: top = flattened icosahedron cap (grass `#5dbb63` vertex-colored, rim sand `#e8d49a`); bottom = inverted cone of rock `#6f6a7d` with 2 jagged sub-chunks (`makeRockMesh`), depth ≈ 1.2 × top-radius.
- Decor: islands 0,1,3,5 get 2 trees (`makeTreeMesh`, 50% magical); islands 2,4,6 get 1 crystal cluster (`makeCrystalMesh`, color `#7fe7ff`).
- Waterfall: islands 1 and 5 only — 60-point Points stream falling 20 units, color `#9fdcff`, additive, opacity 0.5, recycle at bottom.

## Vegetation (src/world/Vegetation.js)

- Seeded `mulberry32(7777)`; rejection-sample positions; accept only `getHeight > 1.8` (waterLevel+0.6) and local slope < 0.5; min spacing 3 between trees.
- Counts: 150 trees (112 natural, 38 magical = 25%), 40 mushrooms, 12 crystal clusters (3 with real `PointLight`: color `#7fe7ff`, intensity 2.2, distance 14), 30 rocks.
- Distribution rules: trees only in grass bands (y 2.2–11), density ×2 where the fey-meadow tint mask is active; magical trees biased into fey patches (70% of them there). Mushrooms in y 2.2–9, clustered in groups of 2–4 within radius 2.5. Crystals in y 9–16 (rocky bands). Rocks anywhere y > 1.8.
- Tree look (`makeTreeMesh`): trunk cylinder r 0.18–0.28 × h 1.4–2.4, color `#7a5230`; natural canopy 1–3 cones `#3f9b4f`/`#2f8a45`; magical canopy icosahedrons in `#e87fd0` / `#9b6ff2` / `#7fe7ff` (pick per seed), emissiveIntensity 0.35. Scale jitter 0.8–1.4.
- Mushroom: stem `#e8e0d0` h 0.5, cap sphere-half r 0.4 `#d8506a`, 5–7 spots `#aef7e0` emissiveIntensity 1.2; faint pulse ±15% emissive, period 2.8 s.
- Crystal: 2–4 octahedrons h 0.8–1.8, tilt ≤ 25°, `#7fe7ff` (2 clusters use `#c08ff7`), opacity 0.85, emissiveIntensity 0.8, pulse ±20% period 3.5 s.
- `spawnTree` grow animation: 1.5 s, back-out overshoot ease (`1 + 2.7*(t-1)^3 + 1.7*(t-1)^2`, i.e. easeOutBack, overshoot ≈ 1.1).

## Fireflies (src/world/Fireflies.js)

- 250 points, sprite = 32px canvas radial gradient `#ffe9a8` → transparent; size 0.35; additive blending.
- Drift: per-particle `sin(t*0.6 + phase)` offsets, amplitude 1.2; hover 0.5–4 above `getHeight`; recenter band (radius 40 around player) every 4 s.
- Opacity: 0.9 night / 0.25 day, lerped with sun intensity over 3 s.
