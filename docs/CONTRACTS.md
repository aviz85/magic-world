# Magic World — Module Contracts (MASTER, BINDING)

Every module is built by an independent agent. **This document is the binding interface contract.**
`src/main.js` is already written and imports every module exactly as specified here — if your module
deviates from its contract, the game breaks. Implement EXACTLY the exports, class names, constructor
signatures, methods, properties and events listed for your module. Internals are yours to design —
be creative and polished WITHIN the contract.

## Global rules (all modules)

- Plain JavaScript ES modules. No TypeScript syntax. No JSX.
- Import ONLY: `three` (as `import * as THREE from 'three'`) and the relative modules explicitly
  listed as "may import" for your module. Nothing else. No CDN URLs, no other npm packages.
- three.js is **r184**: use `BufferGeometry`, `material.color`, `renderer.outputColorSpace`,
  `THREE.SRGBColorSpace`. There is NO `THREE.Geometry`, no `Face3`, no `vertexColors: THREE.VertexColors`
  (use `vertexColors: true`). Lights' `intensity` is in physical-ish units; values 0.5–3 are typical.
- Default export is a single class named exactly as specified.
- `constructor(ctx)` — store `this.ctx = ctx`. You may access `ctx.systems.<name>` for systems that
  appear EARLIER in the construction order (see main.js order below) inside the constructor.
  Systems later in the order may only be accessed inside `update()` / event handlers (all systems
  exist before the first frame).
- `update(dt, elapsed)` — called every frame if the contract lists it. `dt` is seconds (clamped ≤ 0.05),
  `elapsed` is total seconds. Avoid allocating new objects (Vector3 etc.) per frame in hot loops —
  reuse scratch vectors stored on `this`.
- Performance budget: the whole game must run 60fps on an integrated GPU. Prefer merged/instanced
  geometry for anything repeated > 20 times. Keep draw calls reasonable.
- Visual style: low-poly, vibrant magical fantasy. Saturated emissive accents (cyan, violet, pink,
  gold) against natural greens/blues. Flat-shaded look is welcome (`flatShading: true`).
- Never call `document.querySelector('#ui')` except UI modules (HUD, Menus, Minimap). UI DOM goes
  inside `#ui`; set `pointer-events: auto` on interactive elements only.
- After writing your file, syntax-check it:
  `node --check --input-type=module < src/<your-file>.js`

## Construction order (main.js — already written, do not edit)

```
events  = new EventBus()
input   = new Input(domElement, events)
systems (in order): sky, terrain, water, islands, vegetation, fireflies, particles,
                    player, build, spells, wisps, golems, audio, hud, menus, minimap, save
```

## The `ctx` object

```js
ctx = {
  scene,        // THREE.Scene
  camera,       // THREE.PerspectiveCamera (fov 70, near 0.1, far 1200)
  renderer,     // THREE.WebGLRenderer (shadows enabled, ACES tone mapping, sRGB)
  domElement,   // renderer canvas
  events,       // EventBus instance
  input,        // Input instance
  systems: {},  // name -> system instance (per order above)
  config: {
    worldSize: 240,     // terrain spans x,z in [-120, +120]
    terrainRes: 160,    // heightfield grid resolution (160x160 vertices)
    heightScale: 18,
    waterLevel: 1.2,    // world y of water surface
    gravity: 24,        // m/s^2, positive down
    daySeconds: 600,    // full day/night cycle length
  },
  time: { elapsed: 0, dt: 0 },
}
```

## Events catalog (names are binding)

| Event | Payload | Emitted by → consumed by |
|---|---|---|
| `input:keydown` | `{ code, event }` | Input → many |
| `input:keyup` | `{ code }` | Input → many |
| `input:mousedown` | `{ button }` (only while pointer-locked) | Input → build, spells, audio |
| `input:wheel` | `{ deltaY }` | Input → build, spells |
| `input:lockchange` | `{ locked }` | Input → menus, audio |
| `mode:change` | `{ mode }` — `'magic'` or `'build'` | spells → build, hud |
| `spell:select` | `{ index, id, label, icon }` | spells → hud |
| `spell:cast` | `{ id, position }` (position may be null) | spells → audio, hud |
| `mana:insufficient` | `{ id }` | spells → hud, audio |
| `build:select` | `{ index, def }` | build → hud |
| `block:place` | `{ type, position: {x,y,z} }` | build → audio |
| `block:remove` | `{ type, position: {x,y,z} }` | build → audio |
| `prefab:place` | `{ name, origin }` | build → audio, hud |
| `fx:explosion` | `{ position: Vector3, radius, color }` | spells → build, audio, particles-owner(spell) |
| `player:teleport` | `{ from: Vector3, to: Vector3 }` | spells/player → audio, particles |
| `portal:set` | `{ portals: [{x,z}] }` (current portal list, 0–2 entries) | Portal spell → minimap |
| `terrain:modify` | `{ x, z, radius }` | terrain → minimap |
| `time:warp` | `{ hours }` | TimeWarp spell → audio |
| `golem:spawn` | `{ position }` | golems → audio |
| `ui:message` | `{ text, duration }` (duration seconds, default 2.5) | anyone → hud (toast) |
| `game:save` / `game:load` | `{}` | save → hud (toast via ui:message is fine too) |

## Controls (binding — HUD/Menus must document them)

- Click canvas → pointer lock. `Esc` → unlock (browser default).
- `WASD` move, mouse look, `Space` jump, `Shift` sprint, `F` toggle fly (fly: `Space` up, `C` down).
- `B` toggle Magic/Build mode. `1`–`9` select spell (magic) or block (build, 1–8). Wheel cycles selection.
- Magic mode: left-click cast, right-click alt-cast.
- Build mode: left-click place block, right-click remove block.
- `M` mute audio. `K` save, `L` load, `Shift+N` new world (clear save + reload). `H` show help (unlocks pointer).

---

# Module contracts

## src/core/EventBus.js — class `EventBus`
- `constructor()` (no args)
- `on(name, fn)` → returns an unsubscribe function. `off(name, fn)`. `once(name, fn)`.
- `emit(name, payload)` — synchronous; isolate listener errors (try/catch each listener,
  `console.error` on failure) so one bad listener can't kill the frame.

## src/core/Input.js — class `Input`
- `constructor(domElement, events)`
- Properties: `keys` (Set of `event.code` currently held), `pointerLocked` (bool).
- Methods: `pressed(code)` → bool; `consumeMouseDelta()` → `{x, y}` accumulated since last call, then resets;
  `requestPointerLock()`.
- Behavior: click on `domElement` requests pointer lock. Track `mousemove` deltas only while locked.
  Emit the `input:*` events from the catalog. `input:mousedown` ONLY while locked (buttons 0 and 2).
  Suppress the context menu. Clear `keys` on window blur and on lock loss.

## src/core/AssetFactory.js — utility module (NO default class — named exports)
May be imported by: Vegetation, FloatingIslands, GrowTree spell, Golem, Wisps.
- `export function canvasTexture(size, drawFn)` → `THREE.CanvasTexture` (drawFn receives `(ctx2d, size)`); set `colorSpace = THREE.SRGBColorSpace`.
- `export function makeTreeMesh({ scale = 1, magical = false } = {})` → `THREE.Group`. Low-poly tree:
  cylinder trunk + 1–3 cone/icosahedron canopies. `magical: true` → pink/violet/cyan canopy with slight
  emissive. Group origin at trunk base. castShadow on parts. Vary shape using the optional `seed` param
  (`makeTreeMesh({scale, magical, seed})`, seed number → deterministic variation).
- `export function makeCrystalMesh({ color = 0x7fe7ff, scale = 1, seed = 0 } = {})` → Group of 2–4 tilted
  elongated octahedrons, emissive, slight transparency.
- `export function makeMushroomMesh({ scale = 1, seed = 0 } = {})` → Group, glowing-spotted cap.
- `export function makeRockMesh({ scale = 1, seed = 0 } = {})` → Mesh, flat-shaded dodeca/icosahedron, gray.
All factories must be deterministic per seed (use a tiny internal seeded PRNG, e.g. mulberry32).

## src/world/Noise.js — utility module (named exports)
May be imported by: Terrain, FloatingIslands, Vegetation, Water.
- `export function mulberry32(seed)` → `() => float [0,1)`.
- `export function createNoise2D(seed = 1337)` → `(x, y) => float in [-1, 1]`. Proper gradient/simplex-style
  smooth noise (NOT white noise): permutation-table gradient noise with smooth interpolation.
- `export function fbm(noise2D, x, y, { octaves = 4, lacunarity = 2, gain = 0.5, scale = 1 } = {})` → float ~[-1,1].

## src/world/Sky.js — class `Sky`
- `constructor(ctx)`, `update(dt, elapsed)`.
- Owns: sky dome (large sphere or shader gradient — inside-facing), sun `THREE.DirectionalLight`
  (castShadow, shadow camera ~140 units wide, follows `ctx.camera` position so shadows work everywhere),
  ambient/hemisphere light, moon light (dim, bluish), stars (Points, visible at night), `ctx.scene.fog`
  (FogExp2 or Fog — color animated with time of day).
- Properties: `timeOfDay` float 0..1 (0 = midnight, 0.5 = noon). Start at `0.35`. Advances so a full
  cycle takes `ctx.config.daySeconds` seconds.
- Methods: `advance(hours)` — shift timeOfDay by hours/24 (wrap); `isNight()` → bool (roughly timeOfDay < 0.22 || > 0.78);
  `getSunIntensity()` → 0..1.
- Day/night must visibly change: sky color (deep indigo night → warm dawn → bright cyan day → orange dusk),
  fog color matches horizon, stars fade in at night, sun/moon positions orbit.

## src/world/Terrain.js — class `Terrain`
May import: `./Noise.js`.
- `constructor(ctx)` — generate an island heightfield: `res = ctx.config.terrainRes` (160) vertices per side
  spanning `worldSize` (240) so x,z ∈ [-120, 120]. Use fbm noise × `heightScale`, multiplied by a radial
  island falloff so all edges drop below water (y < waterLevel - 2 at the rim). Heights roughly in [-8, +20].
  **Spawn guarantee:** within radius 25 of origin, height must be ≥ `waterLevel + 1` (blend/flatten if needed).
- Mesh: single `PlaneGeometry`-based mesh rotated to XZ, `receiveShadow = true`, **vertex colors** by
  height & slope: sand near water → lush green → mossy/violet-tinted rock → snow caps. `flatShading: true` looks great.
- Properties: `mesh` (the THREE.Mesh — others raycast against it), `heightData` (Float32Array, row-major,
  `heightData[iz * res + ix]`), `res`, `size`.
- Methods:
  - `getHeight(x, z)` → bilinear-interpolated terrain height at world coords; return `-100` outside bounds.
  - `modify(x, z, delta, radius)` — smooth-falloff brush add/subtract height, update geometry positions +
    vertex colors + `computeVertexNormals()`, then `events.emit('terrain:modify', { x, z, radius })`.
  - `serialize()` → plain object (encode heightData as regular Array or base64 — your call);
    `deserialize(data)` → restore + rebuild mesh.

## src/world/Water.js — class `Water`
May import: `./Noise.js`.
- `constructor(ctx)`, `update(dt, elapsed)`.
- Plane at `y = config.waterLevel`, size ≥ worldSize × 1.5. Animated: gentle vertex waves (sin combos in
  update or onBeforeCompile) + slowly scrolling normal-ish sparkle. Translucent
  (`transparent: true, opacity ~0.75`), magical teal-blue, subtle emissive at night is welcome.
  Must not be raycast-blocking for build/spells (set `mesh.raycast = () => {}` OR keep it out of the
  raycast target lists — spells/build only raycast terrain.mesh + blocks anyway).

## src/world/FloatingIslands.js — class `FloatingIslands`
May import: `./Noise.js`, `../core/AssetFactory.js`.
- `constructor(ctx)`, `update(dt, elapsed)`.
- 6–9 floating islands at y ≈ 35–70, scattered over the map (keep clear of a 30-radius cylinder above spawn).
  Each: inverted rocky cone/rough chunk + grassy top + 1–3 trees/crystals (AssetFactory), slow bob
  (±1.5, different phases) and very slow drift/rotation. A faint waterfall of particles or a hanging
  vine/chain on some is a nice touch (cheap Points are fine). castShadow on, but keep poly counts low.

## src/world/Vegetation.js — class `Vegetation`
May import: `./Noise.js`, `../core/AssetFactory.js`.
- `constructor(ctx)` — scatter across the island (use `ctx.systems.terrain.getHeight`): ~120–180 trees
  (mix of natural + ~25% magical), ~40 glowing mushrooms, ~12 crystal clusters (2–3 of them get a real
  `PointLight`, the rest fake it with emissive), ~30 rocks. Only place where height > waterLevel + 0.6
  and slope is sane. Deterministic placement (seeded PRNG from Noise.mulberry32).
- `update(dt, elapsed)` — animate growing trees; subtle crystal pulse is welcome.
- Methods: `spawnTree(position, { scale = 1, magical = true, animate = true } = {})` — adds a tree;
  when `animate`, grow from scale 0.01 to target over ~1.5s with an overshoot ease. Used by GrowTree spell.

## src/world/Fireflies.js — class `Fireflies`
- `constructor(ctx)`, `update(dt, elapsed)`.
- ~250 glowing motes (single `THREE.Points`, additive blending, soft round sprite via canvas texture).
  Drift smoothly (per-particle phase offsets), hover 0.5–4 above terrain near the player region
  (recenter band around player every few seconds is fine). Opacity scales up at night
  (read `ctx.systems.sky`), dim but visible by day.

## src/fx/Particles.js — class `Particles`
- `constructor(ctx)`, `update(dt, elapsed)`.
- Pooled CPU particle system (one or few `THREE.Points` with additive blending; pool ≥ 2000).
- Methods:
  - `burst({ position, color = 0xffaa33, count = 30, speed = 6, life = 1, size = 0.35, gravity = -4, spread = 1 })`
    — radial burst. `gravity` negative pulls down... define: positive value = falls down with that accel. Document in code.
  - `stream({ position, direction, color, count = 6, speed = 3, life = 0.6, size = 0.25 })` — small directional puff (used for trails).
  - `flash(position, color = 0xffffff, intensity = 4, duration = 0.25)` — temporary PointLight from a small
    pool (max 4 concurrent; reuse oldest).
- Listens: nothing required (spells call methods directly). Also listens `player:teleport` → small bursts at from/to.

## src/player/PlayerController.js — class `PlayerController`
- `constructor(ctx)`, `update(dt, elapsed)`.
- First-person. Properties: `position` (THREE.Vector3, **feet**), `velocity` (Vector3), `yaw`, `pitch`,
  `flying` (bool), `onGround` (bool). Eye height 1.7 — set `ctx.camera` position/rotation every frame from
  yaw/pitch (`camera.rotation.order = 'YXZ'`).
- Spawn at `(0, terrain.getHeight(0,0) + 2, 8)` (terrain is earlier in order — OK in constructor).
- Movement: WASD relative to yaw at 8 m/s (×1.8 sprint with Shift), accel/decel smoothing, `Space` jump
  (initial vy ≈ 9) when `onGround`, gravity `config.gravity`. `F` toggles `flying` (listen `input:keydown`):
  flying = no gravity, `Space` up / `KeyC` down, speed ×1.6, smooth damping.
- Ground = `max(terrain.getHeight(x,z), ctx.systems.build.getSupportHeight(x, z, this.position.y))`
  (access build only in update — it's later in construction order). Land when feet ≤ ground.
- Water: if feet below `config.waterLevel`: buoyancy (reduced gravity, drag, `Space` swims up); never sink
  below terrain.
- Mouse look from `input.consumeMouseDelta()`, sensitivity ~0.0023, clamp pitch ±1.55 rad. Only when pointer locked.
- Method: `teleport(positionVec3)` — move feet position, zero velocity, emit `player:teleport` {from, to}.
- Keep player inside |x|,|z| ≤ worldSize/2 - 2.

## src/build/Blocks.js — utility module (named exports)
- `export const BLOCKS` — array of exactly 8 defs:
  `{ id, name, color (hex), emissive (hex, 0x000000 if none), emissiveIntensity, transparent (bool), opacity, roughness, metalness }`
  → stone, wood, marble, gold, crystal (emissive cyan, transparent), leaf, lava (emissive orange), glass (transparent).
- `export function getBlockMaterial(id)` → cached shared `MeshStandardMaterial` per id.
- `export const BLOCK_GEOMETRY` — one shared `THREE.BoxGeometry(1,1,1)`.

## src/build/Prefabs.js — utility module (named exports)
- `export const PREFAB_NAMES = ['tower', 'bridge', 'cottage', 'gate', 'spire']`.
- `export function getPrefab(name)` → `{ name, blocks: [{ x, y, z, type }] }` with **relative** integer
  coords (y ≥ 0 = up from origin). Generate procedurally with loops. Sizes: tower ~9 tall cylinder-ish with
  crenellations & crystal top; bridge ~14 long arc with rails; cottage ~7×6×5 with wood frame, marble walls,
  leaf roof? no — wood roof, glass windows; gate: two pillars + arch ~8 tall, gold trim; spire: tapering
  crystal-and-marble spike ~12 tall. 60–200 blocks each. Block types must be valid `Blocks.js` ids.

## src/build/BuildSystem.js — class `BuildSystem`
May import: `./Blocks.js`, `./Prefabs.js`.
- `constructor(ctx)`, `update(dt, elapsed)`.
- Voxel grid, cell size 1, world-aligned (block center at `(x+0.5, y+0.5, z+0.5)` for integer cell x,y,z).
  Internal `Map` keyed `"x|y|z"` → `{ type, mesh }`. Individual meshes sharing `BLOCK_GEOMETRY` + cached
  materials; `castShadow = receiveShadow = true`.
- Active only when mode === 'build' (track via `mode:change`; default mode is 'magic').
- Ghost preview: translucent box at the target cell (place target = adjacent cell on hit face; remove
  target = the hit block, tinted red on right-click hover is optional). Raycast from camera center against
  `[terrain.mesh, ...blockMeshes]`, max distance 8. Hide ghost when no target/not in build mode.
- Input (only while pointer locked & build mode): `input:mousedown` button 0 → place selected block
  (deny if cell occupied or would intersect the player's body); button 2 → remove hit block.
  `1`–`8` / wheel → select block (`emit 'build:select'`).
- Place/remove emit `block:place` / `block:remove`. Place with a tiny scale-pop animation (0.15s).
- Listens `fx:explosion` → remove all blocks whose centers are within `radius` of `position` (emit
  `block:remove` for each, but at most one combined audio-ish event is fine — still emit per block).
- Methods: `getBlockAt(x,y,z)` → def or null; `getSupportHeight(x, z, fromY)` → top y of the highest
  block whose column contains world point (x,z) and whose top ≤ fromY + 0.5, else `-Infinity`;
  `placeBlock(x,y,z,type,{animate=true,silent=false})`; `removeBlock(x,y,z)`;
  `placePrefab(name, origin)` — origin Vector3 snapped to grid, place blocks bottom-up with staggered
  rise/pop animation over ~1.5s, emit `prefab:place`; `getMeshes()` → array of current block meshes
  (for spell raycasts); `serialize()` → `[{x,y,z,type}]`; `deserialize(arr)` (clear first); `clearAll()`.

## src/magic/SpellManager.js — class `SpellManager`
May import: every file in `./spells/`.
- `constructor(ctx)`, `update(dt, elapsed)`.
- Spell roster (this exact order = keys 1–9): Fireball, GrowTree, LightOrb, Terraform, Blink, Portal,
  SummonGolem, TimeWarp, Conjure. Instantiate each with `new SpellClass(ctx)`.
- Mana: `mana` starts 100, `manaMax = 100`, regen 7/s. Casting requires `spell.constructor.manaCost`;
  insufficient → emit `mana:insufficient`, don't cast.
- Cooldowns per spell (`static cooldown` seconds).
- Mode: `this.mode = 'magic'`; `KeyB` toggles `'magic'`/`'build'` → emit `mode:change`. Number keys
  Digit1–Digit9 select spell ONLY in magic mode (emit `spell:select`); wheel cycles in magic mode.
- Cast: on `input:mousedown` (locked, magic mode): button 0 = cast, button 2 = alt-cast (`alt: true`).
  Build `castInfo = { origin: camera worldPos clone, direction: camera forward clone, hitPoint: Vector3|null,
  hitNormal: Vector3|null, hitObject, alt }` from a raycast against `[terrain.mesh, ...build.getMeshes()]`
  (max distance 60; null hitPoint if no hit). Then `const effect = spell.cast(castInfo)`; if truthy, push to
  active effects list; each frame call `effect.update(dt)` — falsy return = finished (let it clean up itself).
  On successful cast: deduct mana, start cooldown, emit `spell:cast { id, position: hitPoint }`.
- Method: `getState()` → `{ mode, mana, manaMax, selected, spells: [{ id, label, icon, manaCost, cooldownLeft, cooldown }] }`.

## Spell files — `src/magic/spells/*.js`
Common shape for ALL spells (binding):
```js
export default class X {
  static id = '...'; static label = '...'; static icon = '...'; // emoji
  static manaCost = N; static cooldown = N;
  constructor(ctx) { this.ctx = ctx; }
  cast(castInfo) { /* return effect object {update(dt)=>bool} or null */ }
}
```
Spells may use `ctx.systems.particles` (burst/stream/flash), `ctx.events`, and the systems noted below.
Each spell must look SPECTACULAR — particles, light, sound events. Be generous with flair, stingy with allocations.

### Fireball.js — class `Fireball` — id `fireball` 🔥 — mana 15, cd 0.6
Projectile: emissive sphere + PointLight + particle trail (`particles.stream` per ~0.03s), speed ~38 m/s,
slight gravity (4), max life 4s. On hit (terrain getHeight check or proximity to hitPoint) →
`particles.burst` (big, orange→gold), `particles.flash`, emit `fx:explosion { position, radius: 3.5, color: 0xff6622 }`,
small `terrain.modify(x, z, -0.4, 2.5)` scorch dip. Cleans up its meshes/lights.

### GrowTree.js — class `GrowTree` — id `growtree` 🌳 — mana 12, cd 0.8
Requires hitPoint on terrain (null → return null + `ui:message` "Aim at the ground"). Calls
`vegetation.spawnTree(hitPoint, { magical: true, animate: true, scale: 0.9 + varied })` + green/pink sparkle burst.
Alt-cast: ring of 5 smaller trees around hitPoint.

### LightOrb.js — class `LightOrb` — id `lightorb` 💡 — mana 10, cd 0.5
Floating glowing orb (emissive sphere + PointLight, warm white/cyan) at `hitPoint + (0, 2.5, 0)` (or 6m in
front if no hit). Bobs gently, lasts 40s with fade-out. Max 6 orbs — oldest pops (small sparkle) when exceeded.
Alt-cast: orb follows the player (offset above shoulder).

### Terraform.js — class `Terraform` — id `terraform` ⛰️ — mana 4, cd 0.15
Requires hitPoint. `terrain.modify(hitPoint.x, hitPoint.z, alt ? -1.4 : +1.4, 6)` + dust burst at hitPoint
(brown/gray, low speed). Feels like sculpting (low cost/cd by design).

### Blink.js — class `Blink` — id `blink` ⚡ — mana 8, cd 0.4
Teleport: to hitPoint (stand on it) if within 30m, else 13m along direction (clamp y ≥ terrain+0.2). Use
`player.teleport(dest)`. Violet burst + flash at both ends (player:teleport listener in Particles adds more).

### Portal.js — class `Portal` — id `portal` 🌀 — mana 25, cd 1
First cast (needs hitPoint): portal A — glowing torus (vertical, ~1.2 radius) + swirl particles, standing on
ground. Second: portal B, links them. Casting again replaces the OLDER portal. Alt-cast: remove both.
Emit `portal:set { portals: [{x,z}...] }` on every change. Effect (persistent, returned once, keeps itself
alive): each update, if player feet within 1.3 of a portal center → teleport to the other (+1.5m offset
facing out), 2s re-entry cooldown, big burst both ends. Slow torus rotation + emissive pulse.

### SummonGolem.js — class `SummonGolem` — id `golem` 🗿 — mana 40, cd 2
Requires hitPoint. `ctx.systems.golems.spawn(hitPoint)` + rock-dust burst + flash. If golems.count >= 5 →
`ui:message` "The golems grow restless (max 5)" and return null (no mana spent — return null BEFORE manager
deducts? No: manager deducts only on truthy... — **manager rule: if `cast` returns `null` AND sets
`castInfo.cancelled = true`, manager refunds/doesn't deduct.** All spells: set `castInfo.cancelled = true`
when you abort without effect.)

### TimeWarp.js — class `TimeWarp` — id `timewarp` 🌙 — mana 20, cd 1.5
`sky.advance(alt ? -6 : 6)` + emit `time:warp { hours }` + a swirling sky-colored burst above the player +
`ui:message` ("Time surges forward…" / "…rewinds"). Animate the shift over ~1.2s (effect that calls
sky.advance in small steps each frame) rather than snapping.

### Conjure.js — class `Conjure` — id `conjure` 🏰 — mana 35, cd 2.5
Imports `PREFAB_NAMES` from `../../build/Prefabs.js`. Alt-cast: cycle `this.current` through PREFAB_NAMES +
`ui:message` "Conjure: <name>" (no mana — set `castInfo.cancelled = true`). Main cast: requires hitPoint →
`build.placePrefab(this.current, hitPoint)` + golden sparkle rain over the build site (~2s effect).

## src/creatures/Wisps.js — class `Wisps`
May import: `../core/AssetFactory.js`.
- `constructor(ctx)`, `update(dt, elapsed)`.
- 10–14 wisps: small additive glowing sprite/billboard + faint PointLight on 2–3 of them only. Smooth
  wandering (noise-ish sin drift) 1–5m above terrain; gentle attraction to crystal clusters at night and to
  the player when within 10m (curious, keep 2.5m distance). Soft trail via `particles.stream` sparingly.

## src/creatures/Golem.js — class `Golems` (note: plural class name, manages all golems)
May import: `../core/AssetFactory.js`.
- `constructor(ctx)`, `update(dt, elapsed)`.
- Property: `count` (number of live golems). Method: `spawn(position)` → builds a stone golem (~2.2 tall,
  boxes/rocks: torso, head with glowing rune eyes, arms, legs), rises from the ground with dust burst,
  emit `golem:spawn`. Max 5 (spawn returns false if full).
- Behavior: follow player loosely (walk toward player when > 7m, stop at 3.5m), walk speed 3.5, simple leg/arm
  swing animation while moving, idle sway + occasional head turn when stopped. Feet glued to
  `terrain.getHeight` (+ build support is a bonus, not required). castShadow.

## src/audio/AudioEngine.js — class `AudioEngine`
- `constructor(ctx)`, `update(dt, elapsed)`.
- Pure WebAudio (no assets, no THREE.Audio needed). Create `AudioContext` lazily; `resume()` on first
  `input:lockchange {locked:true}` or first `input:mousedown`. Master `GainNode` at ~0.3.
- `KeyM` toggles mute (`setMuted(m)` method + `ui:message` "Muted"/"Sound on").
- Ambient bed: 2 detuned low oscillators through a lowpass + very slow LFO (volume breathes); at night
  (poll `sky.isNight()` ~1/s) add sparse filtered-noise cricket chirps and slightly darker filter.
- SFX (short, synthesized — envelopes via `gain.linearRampToValueAtTime`/`exponentialRamp`):
  - `spell:cast` → per-spell flavor: fireball = noise whoosh w/ downward pitch; blink/portal-cast = rising
    sine sweep; growtree = soft chime arpeggio (2–3 sines); terraform = low thump; lightorb = bell (sine +
    harmonic); timewarp = long reversed-feeling sweep; conjure = ascending arpeggio; golem cast = deep rumble.
  - `fx:explosion` → noise burst through lowpass, fast decay + sub thump.
  - `block:place` → short click/knock (filtered noise tick). `block:remove` → lower-pitch pop. (Rate-limit:
    max ~10 SFX of the same type per second — explosion block-removal storms must not stack 50 sounds.)
  - `player:teleport` → shimmer (3 quick rising sines). `prefab:place` → chord swell. `golem:spawn` → rumble.
  - `mana:insufficient` → dull two-tone "uh-uh". `time:warp` covered by spell:cast variant is fine.

## src/ui/HUD.js — class `HUD`
- `constructor(ctx)`, `update(dt, elapsed)`.
- Builds DOM inside `#ui` and injects its own `<style>` tag. Look: clean fantasy-glass — dark translucent
  panels, soft glow borders, white text. Must include:
  - Crosshair (center dot + tiny ring).
  - Mana bar (bottom-left, gradient cyan→violet, animates smoothly, label "Mana"). Flash red on `mana:insufficient`.
  - Hotbar (bottom-center, 9 slots): in MAGIC mode shows spell icons+labels(+grayed while on cooldown with a
    radial/height cooldown overlay); in BUILD mode shows the 8 block colors+names in slots 1–8. Selected slot highlighted.
    Update from `ctx.systems.spells.getState()` and listen `build:select` / `spell:select` / `mode:change`.
  - Mode badge (above hotbar): "✨ Magic" / "🧱 Build".
  - Toast area (top-center): listen `ui:message` → stacked fading toasts.
  - Tips line (bottom-right, small, dim): "B: build/magic · F: fly · H: help · K/L: save/load".
- Throttle DOM writes (e.g. mana bar via transform/width style each frame is fine; rebuilding innerHTML every frame is NOT).

## src/ui/Menus.js — class `Menus`
- `constructor(ctx)`, `update(dt, elapsed)` (may be a no-op).
- Title/help overlay inside `#ui` (own `<style>`): shown when pointer is NOT locked (`input:lockchange`).
  Big glowing title "Magic World ✨", subtitle, "Click to enter the world", and a two-column controls panel
  (all controls from the catalog above), plus the 9 spells with icons. Backdrop blur + vignette.
  Clicking the overlay calls `ctx.input.requestPointerLock()` (overlay has pointer-events: auto).
- `KeyH` while locked → `document.exitPointerLock()` (overlay reappears = help screen).

## src/ui/Minimap.js — class `Minimap`
- `constructor(ctx)`, `update(dt, elapsed)`.
- Top-right 170×170 rounded canvas (2D context) inside `#ui`, subtle border glow. Draw: terrain heightmap
  coloring (sample `terrain.heightData` — water/sand/grass/rock/snow palette), redraw base layer on
  `terrain:modify` (throttle ≥ 0.5s) and every 3s. Overlays every frame (cheap): player as a white arrow
  (rotated by yaw), portals (violet dots, from `portal:set`), golems (gray dots via `ctx.systems.golems`
  — expose internal list defensively: iterate only if present).

## src/save/SaveSystem.js — class `SaveSystem`
- `constructor(ctx)`, `update(dt, elapsed)`.
- localStorage key `magic-world-save-v1`. Payload: `{ blocks: build.serialize(), terrain: terrain.serialize(),
  player: {x,y,z,yaw,pitch}, timeOfDay, version: 1 }`.
- `KeyK` → save + `ui:message` "World saved ✨". `KeyL` → load + toast. `Shift+KeyN` → confirm-less:
  `localStorage.removeItem`, `location.reload()`. Autosave every 60s (toast "Autosaved" small).
- **Autoload on start:** in constructor, if a save exists, defer load to a `queueMicrotask`/0-timeout? No —
  defer to the FIRST `update()` call (all systems exist then) and restore blocks, terrain, player position
  (`player.position.copy`, yaw/pitch), `sky.timeOfDay`. Wrap in try/catch; corrupt save → clear it, fresh world.
- `save()` / `load()` methods; emit `game:save` / `game:load`.

---

## main.js (ALREADY WRITTEN — for reference only, do not edit)

Imports every module above, builds ctx, constructs systems in the listed order, runs
`renderer.setAnimationLoop`, calls every system's `update(dt, elapsed)`, renders. Handles resize.
