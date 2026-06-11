# Building Design Spec — Blocks & Prefabs

Binding within `docs/CONTRACTS.md` (`src/build/Blocks.js`, `src/build/Prefabs.js`, `BuildSystem.placePrefab`).
All coords are voxel cells, size 1, block center at `(x+0.5, y+0.5, z+0.5)`.

## 1. The 8 Block Types (`BLOCKS` array, in this exact order = slots 1–8)

| # | id        | name      | color      | emissive   | emissiveIntensity | transparent | opacity | roughness | metalness |
|---|-----------|-----------|------------|------------|-------------------|-------------|---------|-----------|-----------|
| 1 | `stone`   | Stone     | `0x8a8f98` | `0x000000` | 0.0               | false       | 1.0     | 0.95      | 0.05      |
| 2 | `wood`    | Wood      | `0x8b5a2b` | `0x000000` | 0.0               | false       | 1.0     | 0.85      | 0.0       |
| 3 | `marble`  | Marble    | `0xf2eee4` | `0x000000` | 0.0               | false       | 1.0     | 0.35      | 0.0       |
| 4 | `gold`    | Gold      | `0xffc94d` | `0x000000` | 0.0               | false       | 1.0     | 0.25      | 0.85      |
| 5 | `crystal` | Crystal   | `0x7df3ff` | `0x22e0ff` | 0.9               | true        | 0.6     | 0.1       | 0.0       |
| 6 | `leaf`    | Leaf      | `0x3fae4a` | `0x000000` | 0.0               | false       | 1.0     | 0.9       | 0.0       |
| 7 | `lava`    | Lava      | `0xff5a1f` | `0xff6a00` | 1.4               | false       | 1.0     | 0.7       | 0.0       |
| 8 | `glass`   | Glass     | `0xbfe8ff` | `0x000000` | 0.0               | true        | 0.35    | 0.05      | 0.0       |

All materials: `MeshStandardMaterial`, `flatShading: true`. Transparent mats: `depthWrite: false`, `side: THREE.FrontSide`.
Ghost preview: clone of selected material at `opacity 0.45`, `transparent: true`, `emissive 0x66ddff`, `emissiveIntensity 0.35`.

## 2. Prefabs (`getPrefab(name)` — relative integer coords, y ≥ 0, generated with loops)

### tower — 9 tall round keep, crystal beacon. Target 105 blocks (valid range 98–115).
```
    ◆          y=10  crystal tip (1)
   ◆◆◆         y=9   crystal cluster (+ shape, 5)
  █ █ █ █      y=8   stone crenellations (every 2nd ring cell)
  █████████    y=2..7 stone ring wall
  █████████    y=1   stone ring, gold at the 4 cardinal cells
  █████████    y=0   stone ring + wood door gap (2 cells at +z)
```
Footprint: ring of cells where `1.7 ≤ sqrt(dx²+dz²) ≤ 2.6` around center (2,·,2) → 12 cells/ring, 5×5 bound.
Layers y=0..7: stone ring (skip 2 door cells at y=0..1, z=+2 face). y=1: 4 cardinal cells `gold`. y=8: every
2nd ring cell `stone` (6 merlons). y=9: `crystal` plus-shape at center; y=10: 1 `crystal`. Composition: stone ~88, gold 4, crystal 6, air gaps for door.

### bridge — 14-long arc, 3 wide, railed. Target 64 blocks (range 58–72).
```
        ▄▄████▄▄          deck arc (side view)
   ▄▄███        ███▄▄     y(x) = round(2.2 · sin(π·x/13)), x = 0..13 → rises 0→2→0
   posts: █ every 3rd x on both rails, crystal lamp on top of end posts
```
Deck: x=0..13, z=0..2, `stone`, at height y(x). Rails: z=0 and z=2 edges, `wood` post at y(x)+1 for x % 3 == 0
(10 posts). Lamps: `crystal` at y(x)+2 on the 4 corner posts (x=0 and x=12 rows). Composition: stone 42, wood 10, crystal 4, gold 8 (gold block replacing stone deck center cells x=6..7, z=1 — the "keystone" pair, plus 6 trim cells x ∈ {0,13} all z).

### cottage — 7(x) × 6(z) × 5(y). Target 128 blocks (range 115–140).
```
     ▲▲▲          y=4..5  wood roof, pyramid steps (inset 1 per level)
    ███████       y=1..3  marble walls, wood corner posts, glass windows
   █████████      y=0     wood floor slab 7×6
```
y=0: full 7×6 `wood` floor (42). y=1..3: perimeter walls — `wood` at the 4 corners every level, `marble`
elsewhere; door = 2-cell gap (x=3, z=0, y=1..2); windows = `glass` replacing marble at y=2 for x ∈ {1,5} on
both z faces and z ∈ {2,3} on both x faces (8 panes). y=4: roof ring inset 1 (5×4 perimeter) `wood`;
y=5: 3×2 solid `wood` cap. Composition: wood ~74, marble ~44, glass 8, plus 1 `lava` block as hearth at (3,1,3) interior.

### gate — twin pillars + arch, 8 tall, gold trim. Target 74 blocks (range 68–82).
```
   ██████████      y=7   full lintel span, gold ends
   ██████████      y=6   lintel, crystal keystone center
   ██      ██      y=0..5 pillars 2×2, gold band at y=3
```
Pillars: 2×2 `stone` columns at x ∈ {0,1} and x ∈ {8,9}, z ∈ {0,1}, y=0..5 (48). y=3 ring of each pillar
`gold` (8). Lintel: y=6..7, x=0..9, z=0..1 minus inner underside corners → `marble` (~36 → trim to fit range);
keystone: (4..5, 6, 0..1) `crystal` (4); lintel ends x ∈ {0,9} `gold` (8). Opening is 6 wide × 6 tall.

### spire — tapering crystal-and-marble spike, 12 tall. Target 92 blocks (range 84–100).
```
      ◆        y=11      crystal tip
      ◆        y=9..10   1×1 crystal
     ◆◆◆       y=6..8    3×3 hollow ring: marble, crystal corners
    █████      y=3..5    4×4 hollow ring, marble, gold corners at y=3
   ███████     y=0..2    5×5 hollow ring, stone, lava core column (1×1, y=0..2) glowing inside
```
Rings are perimeter-only (hollow). Counts: 5×5 ring ×3 = 48 stone, lava core 3; 4×4 ring ×3 = 36 marble
(4 corner cells at y=3 → gold); 3×3 ring ×3 = 24 (corners `crystal` = 12, edges `marble` = 12) — drop y=8
edge cells to land at target; 1×1 crystal ×3. Read as: stone 48, marble ~30, gold 4, crystal ~15, lava 3.

## 3. Staggered Rise Animation (`placePrefab`, total ≈ 1.5 s)

- Sort blocks by `(y, then x+z)` ascending; place all meshes immediately but animate in.
- Per-block delay: `delay = y * 0.10 + (orderWithinLayer * 0.006)`, clamped so `maxDelay ≤ 1.2 s`
  (if exceeded, rescale all delays by `1.2 / maxDelay`). Last block finishes ≈ 1.5 s.
- Per-block tween, duration **0.30 s**, driven in `update(dt)` (no libraries):
  - Position: start at `targetY - 0.6`, ease to target with **easeOutCubic** `1 - (1-t)³`.
  - Scale: 0.01 → 1.0 with **easeOutBack** `1 + 2.70158·(t-1)³ + 1.70158·(t-1)²` (overshoot peaks ~1.10 at t≈0.7).
- Feel: a bottom-up wave, one voxel layer ≈ every 0.10 s — reads as the structure "growing" out of the
  ground; the per-cell 0.006 s jitter makes each layer ripple instead of popping as a slab.
- Emit `prefab:place {name, origin}` once, at call time (not after the animation). Each block placed
  `silent: true` (no per-block `block:place` audio spam); blocks are solid/collidable immediately.
- Single-block place pop (`placeBlock`, 0.15 s): scale 0.4 → 1.0, same easeOutBack, no y offset.

## 4. Implementation notes

- Validate counts in dev: `getPrefab(n).blocks.length` must be 60–200 (contract) — targets above all comply.
- No two blocks share a cell within a prefab; generator must dedupe by `"x|y|z"` key before returning.
- Prefab block `type` strings must be exactly the 8 ids in §1.
