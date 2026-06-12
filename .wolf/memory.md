# Memory

> Chronological action log. Hooks and AI append to this file automatically.
> Old sessions are consolidated by the daemon weekly.

## Session: 2026-06-12 10:01

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|
| 10:10 | Deep graphics audit: read main/Sky/Terrain/Water/Vegetation/AssetFactory + QA screenshots; produced prioritized graphics improvement plan (bloom, tree assets, instanced grass, water fresnel/foam) | src/world/*, src/core/AssetFactory.js | report delivered | ~25k |
| 10:49 | Edited src/main.js | 5→6 lines | ~106 |
| 10:49 | Edited src/main.js | 2→3 lines | ~31 |
| 10:50 | Edited src/main.js | added 4 condition(s) | ~553 |
| 10:50 | Session end: 3 writes across 1 files (main.js) | 10 reads | ~31371 tok |
| 10:50 | Session end: 3 writes across 1 files (main.js) | 10 reads | ~31371 tok |
| 10:53 | Created src/world/Water.js | — | ~5081 |
| 10:54 | Edited src/core/AssetFactory.js | 7→3 lines | ~34 |

## Session: 2026-06-12 14:15

| Time | Action | File(s) | Outcome | ~Tokens |
|------|--------|---------|---------|--------|
| 14:43 | Edited src/core/AssetFactory.js | 3→7 lines | ~81 |
| 14:45 | Created src/creatures/Unicorns.js | — | ~3261 |
| 14:45 | Edited src/main.js | added 1 import(s) | ~26 |
| 14:45 | Edited src/main.js | 1→2 lines | ~14 |
| 14:48 | Fixed GrowTree (restored unitCone/unitIco in AssetFactory) + added Unicorns herd system | src/core/AssetFactory.js, src/creatures/Unicorns.js, src/main.js | verified headless: spawnTree OK, 3 unicorns in scene, 0 errors | ~25k |
| 14:49 | Session end: 4 writes across 3 files (AssetFactory.js, Unicorns.js, main.js) | 3 reads | ~11619 tok |
| 14:57 | Edited index.html | expanded (+27 lines) | ~364 |
| 14:57 | Edited src/main.js | 3→3 lines | ~19 |
| 14:58 | Edited src/main.js | added error handling | ~461 |
| 15:03 | Edited src/world/Water.js | expanded (+7 lines) | ~133 |
| 15:03 | Edited src/world/Water.js | 4→5 lines | ~59 |
| 15:03 | Edited src/world/Water.js | expanded (+16 lines) | ~238 |
| 15:03 | Edited src/world/Water.js | added 3 condition(s) | ~333 |
| 15:06 | Loading veil gated on compileAsync+warmup frames; underwater blue tint (fog override + veil, DoubleSide water) | index.html, src/main.js, src/world/Water.js | verified headless: __gameReady fires, veil removed, fog 0.048/#3776a0 underwater, restores on surfacing | ~30k |
| 15:06 | Session end: 11 writes across 5 files (AssetFactory.js, Unicorns.js, main.js, index.html, Water.js) | 7 reads | ~18509 tok |
| 15:08 | Session end: 11 writes across 5 files (AssetFactory.js, Unicorns.js, main.js, index.html, Water.js) | 7 reads | ~18509 tok |
| 15:11 | Edited src/core/AssetFactory.js | modified standardMat() | ~308 |
| 15:11 | Session end: 12 writes across 5 files (AssetFactory.js, Unicorns.js, main.js, index.html, Water.js) | 10 reads | ~37456 tok |
| 15:12 | Edited src/core/AssetFactory.js | added 2 condition(s) | ~274 |
| 15:12 | Edited src/world/Terrain.js | 6→9 lines | ~202 |
| 15:12 | Edited src/main.js | expanded (+8 lines) | ~62 |
| 15:12 | Edited src/world/Terrain.js | modified geometry() | ~127 |
| 15:12 | Edited src/core/AssetFactory.js | modified getGrainTexture() | ~865 |
| 15:12 | Edited src/world/Sky.js | expanded (+6 lines) | ~186 |
| 15:12 | Edited src/main.js | expanded (+28 lines) | ~433 |
| 15:12 | Edited src/core/AssetFactory.js | inline fix | ~25 |
| 15:12 | Edited src/core/AssetFactory.js | 4→5 lines | ~40 |
| 15:12 | Edited src/world/Terrain.js | expanded (+17 lines) | ~439 |
| 15:12 | Edited src/world/Sky.js | expanded (+7 lines) | ~110 |
| 15:12 | Edited src/main.js | modified applyPixelRatio() | ~104 |
| 15:12 | Edited src/main.js | 5→5 lines | ~36 |
| 15:12 | Edited src/world/Terrain.js | 7→8 lines | ~130 |
| 15:12 | Edited src/world/Sky.js | added 1 condition(s) | ~350 |
| 15:12 | Edited src/main.js | modified for() | ~92 |
| 15:12 | Added procedural 64px bark-streak + rock-speckle grain textures (grainCache, getGrainTexture) and grain-aware material cache key; applied as .map on tree trunk + rock mats | src/core/AssetFactory.js | done, node --check passed | ~1200 |
| 15:12 | Created src/creatures/Butterflies.js | — | ~3603 |
| 15:12 | Edited src/world/Terrain.js | 2→3 lines | ~50 |
| 15:13 | Edited src/world/Sky.js | expanded (+10 lines) | ~149 |
| 15:13 | Created Butterflies system (8 daytime pastel butterflies, flap/glide, day/night fade, 50m gate) | src/creatures/Butterflies.js | created, syntax OK, awaiting integration in main.js | ~3300 |
| 15:13 | Edited src/world/Sky.js | added error handling | ~518 |
| 15:13 | Created src/world/Grass.js | — | ~2932 |
| 15:13 | Edited src/world/Sky.js | added 2 condition(s) | ~208 |
| 15:13 | Added postprocessing stack (EffectComposer: RenderPass + EffectPass Bloom/CA/Vignette, HalfFloat HDR, ctx.fx.composer; adaptive res + warm-up render through composer) | package.json, src/main.js | success | ~3500 |
| 15:13 | Created Grass system: instanced wind-swaying meadow blades (1 draw call, GPU sway) | src/world/Grass.js | created, pending SYSTEM_ORDER registration | ~2600 |
| 15:16 | Terrain visual upgrade: replaced 1-ring cavity hack with baked 8-tap two-ring vertex AO (~2.1m diag + ~3.0m axial, max 25% darkening), widened modify() recolor halo to +2 ring, doc header updated; headless QA: 0 errors | src/world/Terrain.js | ok | ~9k |
| 15:10 | Added PMREM sky-driven env map to Sky (proxy gradient scene, 5s/sunI-delta rebake, RT disposal, graceful degrade, scene.environmentIntensity=0.5); verified headless: bake at t=0 + rebake at t=5.05, no errors | src/world/Sky.js | success | ~9k |
| 15:22 | Edited src/main.js | added 1 import(s) | ~38 |
| 15:22 | Edited src/main.js | added 1 import(s) | ~40 |
| 15:23 | Edited src/main.js | 2→3 lines | ~22 |
| 15:23 | Edited src/main.js | 2→3 lines | ~21 |
| 15:23 | Edited src/build/BuildSystem.js | modified placePrefab() | ~250 |
| 15:23 | Edited src/build/BuildSystem.js | modified for() | ~88 |
| 15:23 | Edited src/build/BuildSystem.js | 3→4 lines | ~48 |
| 15:23 | Edited src/build/BuildSystem.js | added 3 condition(s) | ~376 |
| 15:24 | Edited src/build/BuildSystem.js | added 13 condition(s) | ~957 |
| 15:25 | Integration pass: registered Grass + Butterflies in SYSTEM_ORDER (imports + entries after vegetation/wisps); verified composer pipeline, Vite 200s on all changed modules, no console errors post-reload | src/main.js | ok | ~2k |
| 15:24 | Edited src/magic/spells/Conjure.js | modified language() | ~345 |
| 15:24 | Edited src/magic/spells/Conjure.js | 3→5 lines | ~32 |
| 15:24 | Edited src/magic/spells/Conjure.js | modified constructor() | ~73 |
| 15:25 | Created scripts/qa-tmp-wf.mjs | — | ~835 |
| 15:26 | Edited src/magic/spells/Conjure.js | added 11 condition(s) | ~1863 |
| 15:26 | Edited src/magic/spells/Conjure.js | added 1 condition(s) | ~427 |
| 15:27 | Edited scripts/qa-tmp-wf.mjs | "networkidle0" → "domcontentloaded" | ~20 |
| 15:29 | Created scripts/qa-tmp-wf.mjs | — | ~768 |
| 15:29 | Edited src/magic/spells/Conjure.js | added 1 condition(s) | ~172 |
| 15:29 | Edited src/magic/spells/Conjure.js | 4→7 lines | ~60 |
| 15:32 | Conjure level-up: cast on existing structure upgrades it (bigger + finer materials) up to L5, then refused; upscaleBlueprint + shell extraction + removeCells in BuildSystem | src/build/BuildSystem.js, src/magic/spells/Conjure.js | verified headless: 113→141→335→389→810 blocks, h11→26, cast 6 cancelled | ~28k |
