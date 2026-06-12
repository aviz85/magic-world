# Cerebrum

> OpenWolf's learning memory. Updated automatically as the AI learns from interactions.
> Do not edit manually unless correcting an error.
> Last updated: 2026-06-11

## User Preferences

<!-- How the user likes things done. Code style, tools, patterns, communication. -->

## Key Learnings

- **Project:** magic-world
- Headless QA: main.js clamps dt to 0.05s, so in-game `elapsed` grows much slower than wall time under swiftshader (~3x). Poll `__game.time.elapsed`, don't sleep wall-clock. Also use `waitUntil:'load'` — Vite HMR traffic (other agents editing) keeps `networkidle0` from ever settling.
- Sky owns scene.environment (PMREM bake of a gradient proxy scene sharing domeUniforms) + scene.environmentIntensity (0.5). Other systems must not overwrite scene.environment.
- Terrain vertex colors are recomputed per-vertex in `_writeVertexColor` from `heightData` taps; any tap-radius increase (e.g. baked AO reads 2 verts out) requires widening the `modify()` recolor halo passed to `_refreshRegion` to match, or sculpt edges keep stale shading.
- Minimap reads only `terrain.heightData` + `terrain.res` (renders its own palette) — terrain color changes never affect it.
- Headless QA vs the running Vite dev server: `networkidle0` never settles under HMR churn; use `waitUntil: 'load'` + a fixed delay instead.

## Do-Not-Repeat
- (2026-06-12) Headless QA: the puppeteer user-data-dir persists localStorage, so SaveSystem auto-loads the previous run's world — call build.clearAll() (or clear localStorage) before any block-placement test, or casts silently no-op on occupied cells.

<!-- Mistakes made and corrected. Each entry prevents the same mistake recurring. -->
<!-- Format: [YYYY-MM-DD] Description of what went wrong and what to do instead. -->

## Decision Log

<!-- Significant technical decisions with rationale. Why X was chosen over Y. -->
