/**
 * Prefabs.js — procedural building blueprints for Magic World.
 *
 * Named exports (binding contract):
 *   PREFAB_NAMES — ['tower', 'bridge', 'cottage', 'gate', 'spire']
 *   getPrefab(name) → { name, blocks: [{ x, y, z, type }] }
 *
 * Coords are RELATIVE integer voxel cells (y >= 0 is up from the prefab
 * origin). `type` is always one of the 8 ids defined in Blocks.js.
 * Every blueprint is generated with loops, deduped by cell, and sorted
 * bottom-up by (y, x+z) so BuildSystem's staggered rise animation reads
 * as a wave growing out of the ground.
 *
 * Block counts (contract bound: 60–200 blocks each):
 *   tower 113 · bridge 86 · cottage ~180 · gate 84 · spire 102
 *
 * Blueprints are deterministic; each is generated once and cached.
 * getPrefab returns fresh block objects so callers may mutate freely.
 */

export const PREFAB_NAMES = ['tower', 'bridge', 'cottage', 'gate', 'spire'];

const MIN_BLOCKS = 60;
const MAX_BLOCKS = 200;

const VALID_TYPES = new Set([
  'stone', 'wood', 'marble', 'gold', 'crystal', 'leaf', 'lava', 'glass',
]);

/* ------------------------------------------------------------------ */
/* Builder helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Tiny blueprint accumulator: dedupes by cell (first write wins) so no
 * two blocks ever share a coordinate within a prefab.
 */
function createBuilder() {
  const blocks = [];
  const used = new Set();
  return {
    blocks,
    add(x, y, z, type) {
      const xi = x | 0;
      const yi = y | 0;
      const zi = z | 0;
      const key = xi + '|' + yi + '|' + zi;
      if (used.has(key)) return;
      used.add(key);
      blocks.push({ x: xi, y: yi, z: zi, type });
    },
  };
}

/**
 * Sort bottom-up (y, then x+z diagonal, then x/z for full determinism),
 * sanity-check the contract invariants, and wrap as a blueprint.
 */
function finalize(name, builder) {
  const blocks = builder.blocks;
  blocks.sort(
    (a, b) =>
      a.y - b.y ||
      (a.x + a.z) - (b.x + b.z) ||
      a.x - b.x ||
      a.z - b.z
  );
  if (blocks.length < MIN_BLOCKS || blocks.length > MAX_BLOCKS) {
    console.warn(
      `[Prefabs] "${name}" has ${blocks.length} blocks ` +
        `(contract range is ${MIN_BLOCKS}-${MAX_BLOCKS})`
    );
  }
  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i];
    if (!VALID_TYPES.has(blk.type)) {
      console.warn(`[Prefabs] "${name}" block ${i} has invalid type "${blk.type}" — using stone`);
      blk.type = 'stone';
    }
    if (blk.y < 0) {
      console.warn(`[Prefabs] "${name}" block ${i} has y < 0 — clamping to 0`);
      blk.y = 0;
    }
  }
  return { name, blocks };
}

/* ------------------------------------------------------------------ */
/* tower — 9-tall round stone keep with a crystal beacon (113 blocks)  */
/* ------------------------------------------------------------------ */

/**
 * Footprint: the 12 cells of a 5×5 grid whose center distance is in
 * [1.7, 2.6] — a chunky circle around center (2, ·, 2). Sorted by angle
 * so "every 2nd cell" crenellations alternate cleanly around the rim.
 */
function towerRingCells() {
  const cells = [];
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      const r = Math.hypot(dx, dz);
      if (r >= 1.7 && r <= 2.6) {
        cells.push({ dx, dz, angle: Math.atan2(dz, dx) });
      }
    }
  }
  cells.sort((a, b) => a.angle - b.angle);
  return cells;
}

function buildTower() {
  const b = createBuilder();
  const cx = 2;
  const cz = 2;
  const ring = towerRingCells(); // 12 cells per ring

  // Ring wall, y = 0..7. Door: 2-wide × 2-tall gap on the +z face.
  // y=1: gold at the 4 cardinal cells (the door cardinal's gold moves up
  // to y=2 as a lintel accent above the doorway). y=4..5: glowing crystal
  // arrow-slit windows on the cardinals — the keep reads lit-from-within
  // at night and the silhouette gets vertical accent lines.
  for (let y = 0; y <= 7; y++) {
    for (let i = 0; i < ring.length; i++) {
      const { dx, dz } = ring[i];
      if (y <= 1 && dz === 2 && (dx === 0 || dx === 1)) continue; // door gap
      let type = 'stone';
      const cardinal =
        (dx === 0 && Math.abs(dz) === 2) || (dz === 0 && Math.abs(dx) === 2);
      if (y === 1 && cardinal && dz !== 2) type = 'gold';
      else if (y === 2 && dx === 0 && dz === 2) type = 'gold'; // door lintel
      else if ((y === 4 || y === 5) && cardinal) type = 'crystal'; // window slits
      b.add(cx + dx, y, cz + dz, type);
    }
  }

  // Marble battlement floor at y=7 (the 9 interior cells) — players can
  // blink up and actually stand between the merlons.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) b.add(cx + dx, 7, cz + dz, 'marble');
  }

  // Crenellations at y=8: every 2nd ring cell -> 6 merlons.
  for (let i = 0; i < ring.length; i += 2) {
    b.add(cx + ring[i].dx, 8, cz + ring[i].dz, 'stone');
  }

  // Crystal beacon: plus-shaped cluster at y=9, single tip at y=10.
  b.add(cx, 9, cz, 'crystal');
  b.add(cx + 1, 9, cz, 'crystal');
  b.add(cx - 1, 9, cz, 'crystal');
  b.add(cx, 9, cz + 1, 'crystal');
  b.add(cx, 9, cz - 1, 'crystal');
  b.add(cx, 10, cz, 'crystal');

  // Composition: stone 86 (80 wall + 6 merlons), gold 4, crystal 14, marble 9 = 113.
  return finalize('tower', b);
}

/* ------------------------------------------------------------------ */
/* bridge — 14-long stone arc, 3 wide, parapets, lanterns (86 blocks)  */
/* ------------------------------------------------------------------ */

function buildBridge() {
  const b = createBuilder();
  const LEN = 14; // x = 0..13, z = 0..2
  const archY = (x) => Math.round(2.2 * Math.sin((Math.PI * x) / (LEN - 1)));

  for (let x = 0; x < LEN; x++) {
    const y = archY(x); // deck rises 0 -> 2 -> 0

    // Deck: stone, with gold trim rows at both ends and a gold keystone
    // pair at the crown (x = 6..7, center lane).
    for (let z = 0; z <= 2; z++) {
      const trim = x === 0 || x === LEN - 1;
      const keystone = (x === 6 || x === 7) && z === 1;
      b.add(x, y, z, trim || keystone ? 'gold' : 'stone');
    }

    // Continuous wood parapet on both edges — steps with the arch, so the
    // side silhouette reads as a clean double curve instead of lone posts.
    b.add(x, y + 1, 0, 'wood');
    b.add(x, y + 1, 2, 'wood');

    // Crystal lanterns over both entries and flanking the crown keystones.
    if (x === 0 || x === 6 || x === 7 || x === LEN - 1) {
      b.add(x, y + 2, 0, 'crystal');
      b.add(x, y + 2, 2, 'crystal');
    }

    // Stone support legs under the high section of the arc (center lane).
    if (x === 4 || x === 6 || x === 7 || x === 9) {
      for (let sy = 0; sy < y; sy++) b.add(x, sy, 1, 'stone');
    }
  }

  // Composition: stone 42 (34 deck + 8 legs), wood 28, crystal 8, gold 8 = 86.
  return finalize('bridge', b);
}

/* ------------------------------------------------------------------ */
/* cottage — 7×6, marble walls, stepped roof, chimney, hearth (~180)   */
/* ------------------------------------------------------------------ */

function buildCottage() {
  const b = createBuilder();
  const W = 7; // x = 0..6
  const D = 6; // z = 0..5

  // y=0: full wood floor slab (42).
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < D; z++) b.add(x, 0, z, 'wood');
  }

  // y=1..3: perimeter walls — wood corner posts, marble panels,
  // glass windows at eye level (y=2), 2-tall door gap on the z=0 face.
  for (let y = 1; y <= 3; y++) {
    for (let x = 0; x < W; x++) {
      for (let z = 0; z < D; z++) {
        const edgeX = x === 0 || x === W - 1;
        const edgeZ = z === 0 || z === D - 1;
        if (!edgeX && !edgeZ) continue; // interior stays open
        if (x === 3 && z === 0 && y <= 2) continue; // door gap
        let type = 'marble';
        if (edgeX && edgeZ) {
          type = 'wood'; // corner posts
        } else if (y === 3 && x === 3 && z === 0) {
          type = 'gold'; // gleaming lintel over the doorway
        } else if (y === 2) {
          if (edgeZ && (x === 1 || x === 5)) type = 'glass'; // front/back panes
          else if (edgeX && (z === 2 || z === 3)) type = 'glass'; // side panes
        }
        b.add(x, y, z, type);
      }
    }
  }

  // Glowing lava hearth tucked inside.
  b.add(3, 1, 3, 'lava');

  // Stone chimney (added BEFORE the roof — first write wins, so it pierces
  // the roof slabs) with a lava ember glowing above the roofline at y=7.
  for (let y = 1; y <= 6; y++) b.add(5, y, 4, 'stone');
  b.add(5, 7, 4, 'lava');

  // Stepped solid wood roof — a proper pitched-pyramid silhouette:
  // y=4 full 7×6 slab, y=5 inset 5×4 slab, y=6 3×2 ridge cap.
  for (let x = 0; x < W; x++) {
    for (let z = 0; z < D; z++) b.add(x, 4, z, 'wood');
  }
  for (let x = 1; x <= 5; x++) {
    for (let z = 1; z <= 4; z++) b.add(x, 5, z, 'wood');
  }
  for (let x = 2; x <= 4; x++) {
    for (let z = 2; z <= 3; z++) b.add(x, 6, z, 'wood');
  }

  // Composition: wood 120, marble 43, glass 8, lava 2, gold 1, stone 6 ≈ 180
  // (chimney steals 2 roof cells via dedupe).
  return finalize('cottage', b);
}

/* ------------------------------------------------------------------ */
/* gate — twin 2×2 pillars + corbelled lintel + finials (84 blocks)    */
/* ------------------------------------------------------------------ */

function buildGate() {
  const b = createBuilder();

  // Pillars: 2×2 stone columns at x ∈ {0,1} and {8,9}, z ∈ {0,1},
  // y = 0..5, with a gold band ringing each pillar at y=3.
  for (let px = 0; px <= 8; px += 8) {
    for (let x = px; x <= px + 1; x++) {
      for (let z = 0; z <= 1; z++) {
        for (let y = 0; y <= 5; y++) {
          b.add(x, y, z, y === 3 ? 'gold' : 'stone');
        }
      }
    }
  }

  // Lintel: y = 6..7 spanning x = 0..9. The y=6 underside is corbelled —
  // cells beside the keystone are dropped so the crystal keystone hangs
  // at the center of the opening. Gold caps both ends.
  for (let y = 6; y <= 7; y++) {
    for (let x = 0; x <= 9; x++) {
      for (let z = 0; z <= 1; z++) {
        if (y === 6 && (x === 2 || x === 3 || x === 6 || x === 7)) continue;
        let type = 'marble';
        if (x === 0 || x === 9) type = 'gold';
        else if (y === 6 && (x === 4 || x === 5)) type = 'crystal';
        b.add(x, y, z, type);
      }
    }
  }

  // Crystal finials crown the four corners of the lintel — glowing
  // beacons that frame the gate against the sky.
  b.add(0, 8, 0, 'crystal');
  b.add(0, 8, 1, 'crystal');
  b.add(9, 8, 0, 'crystal');
  b.add(9, 8, 1, 'crystal');

  // Composition: stone 40, gold 16, marble 20, crystal 8 = 84.
  // Opening: 6 wide × 6 tall.
  return finalize('gate', b);
}

/* ------------------------------------------------------------------ */
/* spire — tapering crystal-and-marble spike, 12 tall (102 blocks)     */
/* ------------------------------------------------------------------ */

function buildSpire() {
  const b = createBuilder();

  // y=0..2: 5×5 hollow stone ring (x,z = 0..4) with a glowing lava core
  // column at the center — light leaks through the upper gaps.
  for (let y = 0; y <= 2; y++) {
    for (let x = 0; x <= 4; x++) {
      for (let z = 0; z <= 4; z++) {
        if (x === 0 || x === 4 || z === 0 || z === 4) b.add(x, y, z, 'stone');
      }
    }
    b.add(2, y, 2, 'lava');
  }

  // y=3..5: 4×4 hollow marble ring (x,z = 1..4). Gold corners at y=3;
  // above that the edges thin to an alternating checker so the tier
  // visibly tapers as it rises.
  for (let y = 3; y <= 5; y++) {
    for (let x = 1; x <= 4; x++) {
      for (let z = 1; z <= 4; z++) {
        const edgeX = x === 1 || x === 4;
        const edgeZ = z === 1 || z === 4;
        if (!edgeX && !edgeZ) continue;
        const corner = edgeX && edgeZ;
        if (!corner && y >= 4 && (x + z) % 2 !== y % 2) continue; // checker taper
        b.add(x, y, z, corner && y === 3 ? 'gold' : 'marble');
      }
    }
  }

  // y=6..8: 3×3 hollow ring (x,z = 1..3) — crystal corners all the way
  // up, marble edges only on the bottom level (the rest dissolve away).
  for (let y = 6; y <= 8; y++) {
    for (let x = 1; x <= 3; x++) {
      for (let z = 1; z <= 3; z++) {
        const edgeX = x === 1 || x === 3;
        const edgeZ = z === 1 || z === 3;
        if (!edgeX && !edgeZ) continue;
        if (edgeX && edgeZ) b.add(x, y, z, 'crystal');
        else if (y === 6) b.add(x, y, z, 'marble');
      }
    }
  }

  // y=9..11: floating 1×1 crystal needle and tip.
  for (let y = 9; y <= 11; y++) b.add(2, y, 2, 'crystal');

  // Four crystal shards hover off the needle like an orbiting crown —
  // pure magic in the silhouette (voxels don't need physics).
  b.add(2, 9, 0, 'crystal');
  b.add(2, 9, 4, 'crystal');
  b.add(0, 9, 2, 'crystal');
  b.add(4, 9, 2, 'crystal');

  // Composition: stone 48, lava 3, marble 28, gold 4, crystal 19 = 102.
  return finalize('spire', b);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

const GENERATORS = {
  tower: buildTower,
  bridge: buildBridge,
  cottage: buildCottage,
  gate: buildGate,
  spire: buildSpire,
};

const blueprintCache = new Map();

/**
 * getPrefab(name) → { name, blocks: [{ x, y, z, type }] }
 *
 * Blueprints are generated lazily once and cached; each call returns
 * fresh block objects, so callers (BuildSystem.placePrefab, spells) may
 * mutate or re-sort the result without corrupting future placements.
 * Unknown names warn and fall back to the first prefab so a stray typo
 * upstream never kills a spell cast mid-frame.
 */
export function getPrefab(name) {
  let key = typeof name === 'string' ? name.toLowerCase().trim() : '';
  if (!GENERATORS[key]) {
    console.warn(`[Prefabs] unknown prefab "${name}" — falling back to "${PREFAB_NAMES[0]}"`);
    key = PREFAB_NAMES[0];
  }
  let blueprint = blueprintCache.get(key);
  if (!blueprint) {
    blueprint = GENERATORS[key]();
    blueprintCache.set(key, blueprint);
  }
  const blocks = blueprint.blocks;
  const copy = new Array(blocks.length);
  for (let i = 0; i < blocks.length; i++) {
    const blk = blocks[i];
    copy[i] = { x: blk.x, y: blk.y, z: blk.z, type: blk.type };
  }
  return { name: blueprint.name, blocks: copy };
}
