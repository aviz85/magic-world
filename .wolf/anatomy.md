# anatomy.md

> Auto-maintained by OpenWolf. Last scanned: 2026-06-12T13:03:37.346Z
> Files: 55 tracked | Anatomy hits: 0 | Misses: 0

## ./

- `.gitignore` — Git ignore rules (~48 tok)
- `CLAUDE.md` — OpenWolf (~57 tok)
- `index.html` — Magic World ✨ (~527 tok)
- `package-lock.json` — npm lock file (~11359 tok)
- `package.json` — Node.js package manifest (~91 tok)

## .claude/

- `settings.json` (~441 tok)

## .claude/rules/

- `openwolf.md` (~313 tok)

## docs/

- `CONTRACTS.md` — Magic World — Module Contracts (MASTER, BINDING) (~7413 tok)

## docs/design/

- `building.md` — Building Design Spec — Blocks & Prefabs (~1684 tok)
- `creatures-fx.md` — Creatures, Particles & Audio — Design Spec (implementation-ready) (~1766 tok)
- `magic.md` — Magic World — Spell VFX Choreography (implementation spec) (~2266 tok)
- `ui.md` — Magic World — UI / HUD / Menus / Minimap Design Spec (~1770 tok)
- `vision.md` — Magic World — Art Direction & Game Feel (BINDING design spec) (~1672 tok)
- `world.md` — World Generation Design — Magic World (~1583 tok)

## scripts/

- `qa-tmp-wf.mjs` — Temp QA pass 2: full-frame renderer stats, 404 source, elevated terrain shot. (~768 tok)
- `qa-tmp-wf2.mjs` — Temp QA pass 3: precise per-visual-frame stats averaged over rAF ticks. (~526 tok)
- `qa.mjs` — Headless QA: load the game, collect errors, screenshot title + in-game. (~760 tok)
- `qa2.mjs` — Functional smoke test: exercise build/spell/creature systems in-engine, then screenshot. (~840 tok)

## src/

- `main.js` — renderer: applyPixelRatio, boot (~2478 tok)
- `style.css` — Styles: 2 rules (~98 tok)

## src/audio/

- `AudioEngine.js` — AudioEngine — pure WebAudio synth for Magic World. (~6102 tok)

## src/build/

- `BuildSystem.js` — Top y of the highest block whose column contains world point (x,z) and (~7668 tok)

## src/core/

- `AssetFactory.js` — rng helper: float in [min, max) (~5274 tok)
- `EventBus.js` — EventBus — tiny, robust synchronous pub/sub for Magic World. (~1629 tok)
- `Input.js` — Input — pointer-lock + keyboard/mouse state for Magic World. (~2415 tok)

## src/creatures/

- `Butterflies.js` — Butterflies — 8 pastel butterflies that flutter over the meadows by day. (~3603 tok)
- `Golem.js` — Golems — stone golem manager for Magic World. (~5089 tok)
- `Unicorns.js` — Unicorns 🦄 — a small herd of 3 low-poly unicorns that roam the island. (~5038 tok)
- `Unicorns.js` — Unicorns 🦄 — herd of 3 low-poly unicorns: wander/graze/startle state machine, glowing horn, sparkle trail. (~3200 tok)
- `Wisps.js` — Wisps — 12 curious glowing lanterns that wander the island. (~4046 tok)

## src/fx/

- `Particles.js` — Particles — pooled GPU-billboard particle engine for Magic World. (~5251 tok)

## src/magic/

- `SpellManager.js` — SpellManager — the arcane conductor. (~3127 tok)

## src/magic/spells/

- `Blink.js` — Blink ⚡ — short-range arcane teleport. (~1706 tok)
- `Conjure.js` — Conjure 🏰 — divine architecture. (~3195 tok)
- `Fireball.js` — Live creature bodies the ball can slam into mid-flight. Creature systems (~4479 tok)
- `GrowTree.js` — GrowTree 🌳 — nature magic. (~2563 tok)
- `LightOrb.js` — LightOrb 💡 — a floating mote of warm light. (~2786 tok)
- `Portal.js` — Portal 🌀 — two linked glowing torus gates with swirling rim particles. (~4416 tok)
- `SummonGolem.js` — SummonGolem 🗿 — id `golem` (~1688 tok)
- `Terraform.js` — Terraform ⛰️ — sculpt the land like wet clay. (~1794 tok)
- `TimeWarp.js` — TimeWarp 🌙 — bends the day/night cycle ±6 hours over ~1.2 seconds. (~1805 tok)

## src/player/

- `PlayerController.js` — PlayerController — first-person movement for Magic World. (~5080 tok)

## src/save/

- `SaveSystem.js` — SaveSystem — localStorage persistence for Magic World. (~4454 tok)

## src/ui/

- `HUD.js` — Magic World — HUD (~6740 tok)
- `Menus.js` — Menus — title / help overlay for Magic World. (~4591 tok)
- `Minimap.js` — Minimap — top-right 170×170 canvas minimap for Magic World. (~4244 tok)

## src/world/

- `Fireflies.js` — Fireflies — ~380 additive glowing motes drifting above the terrain in a (~3219 tok)
- `FloatingIslands.js` — FloatingIslands — 7 bobbing, slowly drifting sky islands. (~5286 tok)
- `Grass.js` — Grass — one InstancedMesh of ~2000 wind-swaying 2-triangle cross blades; seeded patch placement in the meadow band, GPU sway via onBeforeCompile uTime, 1 draw call. (~2600 tok)
- `Grass.js` — --------------------------------------------------------------------------- (~2932 tok)
- `Noise.js` — Noise.js — seeded PRNG + 2D gradient noise + fractal Brownian motion. (~1523 tok)
- `Sky.js` — Sky — full day/night cycle + PMREM sky-driven scene.environment (rebake every ~5s or sunI delta >0.15, intensity 0.5). (~8910 tok)
- `Terrain.js` — --------------------------------------------------------------------------- (~6497 tok)
- `Vegetation.js` — Vegetation — seeded scatter of trees, glowing mushrooms, crystal clusters and (~6617 tok)
- `Water.js` — --------------------------------------------------------------------------- (~5733 tok)
