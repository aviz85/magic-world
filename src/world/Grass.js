import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Grass — instanced wind-swaying meadow blades.
//
// One InstancedMesh (~2000 blades), each blade a 2-triangle cross (two
// perpendicular tapering triangles, 6 verts, non-indexed) on a cheap
// MeshLambertMaterial. Per-instance color tint samples a 3-green meadow
// palette via setColorAt. All normals point straight up so blades inherit
// the meadow's lighting instead of flat-shaded facet darkness — the one
// deliberate deviation from flatShading:true, standard grass-card trick
// (a 0.05-wide blade has no facet to read anyway).
//
// Placement (construction only, seeded mulberry32 — same world every
// session): ~40 poisson-ish patch centers (rejection-sampled, min 12 m
// apart) restricted to the meadow band — terrain height in
// (waterLevel + 0.4, ~60% of HEIGHT_MAX) and gentle slopes — then ~50
// blades scattered per patch with the same validity check.
//
// Wind: material.onBeforeCompile injects a single uTime uniform into the
// Lambert vertex shader (same pattern + customProgramCacheKey discipline as
// Water). Bend ∝ y² within the unit blade (root anchored), phase derived
// from instanceMatrix translation, applied in local space pre-instancing so
// taller blades sway proportionally. update() writes one uniform.
//
// Budget: 1 draw call, ~12k verts, zero per-frame CPU beyond the uniform,
// zero per-frame allocations. Correct boundingSphere set from actual
// instance spread (+ tip/sway padding) so frustum culling stays honest.
// Excluded from raycasts (build/spell rays must never hit grass).
// ---------------------------------------------------------------------------

const BLADE_COUNT = 2000;       // capacity; actual count = blades placed
const PATCH_COUNT = 40;
const BLADES_PER_PATCH = Math.ceil(BLADE_COUNT / PATCH_COUNT);
const PATCH_MIN_DIST = 12;      // m between patch centers (poisson-ish)
const PATCH_RADIUS = 7;         // m blade scatter radius around a center

const MIN_HEIGHT_ABOVE_WATER = 0.4;   // meadow starts here above waterLevel
const MAX_BAND_HEIGHT = 12;           // ~60% of Terrain HEIGHT_MAX (20) — below the rocky band
const MAX_SLOPE = 0.55;               // terrain rock blend starts ~0.48; stay on gentle ground
const SLOPE_EPS = 0.8;                // m finite-difference step for slope probe

// Meadow palette — greens drifting toward teal, matching the terrain's
// grass/fey-meadow bands. Each blade lerps between two neighbors for variety.
const PALETTE = [
  new THREE.Color('#4fae5c'), // meadow green
  new THREE.Color('#3c9d6a'), // deep green-teal
  new THREE.Color('#6cc98a'), // light spring green
];

// Tiny seeded PRNG (same pattern as Wisps) — deterministic meadow layout.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default class Grass {
  constructor(ctx) {
    this.ctx = ctx;

    const rng = mulberry32(48271);
    const terrain = ctx.systems.terrain || null;
    const waterLevel = ctx.config.waterLevel;
    const half = ctx.config.worldSize * 0.5;

    // --- Blade geometry: unit-height 2-triangle cross -----------------------
    // Two perpendicular tapering triangles sharing a tip at y=1; instance
    // scale stretches it to final size. Normals all up (see header).
    const HW = 0.05; // half-width at the root
    const positions = new Float32Array([
      -HW, 0, 0,   HW, 0, 0,   0, 1, 0,   // triangle facing ±z
      0, 0, -HW,   0, 0, HW,   0, 1, 0,   // triangle facing ±x
    ]);
    const normals = new Float32Array(18);
    for (let i = 0; i < 6; i++) normals[i * 3 + 1] = 1; // (0,1,0) × 6
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

    // --- Material ------------------------------------------------------------
    this.material = new THREE.MeshLambertMaterial({
      color: 0xffffff,        // tint lives in instanceColor
      side: THREE.DoubleSide,
    });
    this._uTime = { value: 0 };
    this.material.onBeforeCompile = (shader) => this._injectWindShader(shader);
    // Pin the program so the injected chunks never collide with cached
    // vanilla Lambert programs (same discipline as Water).
    this.material.customProgramCacheKey = () => 'magic-world-grass';

    // --- Placement -----------------------------------------------------------
    // Validity probe: meadow height band + gentle slope (finite differences).
    const getH = (x, z) =>
      terrain && terrain.getHeight ? terrain.getHeight(x, z) : -100;
    const valid = (x, z) => {
      const h = getH(x, z);
      if (h < waterLevel + MIN_HEIGHT_ABOVE_WATER || h > MAX_BAND_HEIGHT) return false;
      const dhdx = (getH(x + SLOPE_EPS, z) - getH(x - SLOPE_EPS, z)) / (2 * SLOPE_EPS);
      const dhdz = (getH(x, z + SLOPE_EPS) - getH(x, z - SLOPE_EPS)) / (2 * SLOPE_EPS);
      return Math.sqrt(dhdx * dhdx + dhdz * dhdz) <= MAX_SLOPE;
    };

    // Poisson-ish patch centers: rejection-sample valid spots, keep min dist.
    const centers = [];
    for (let attempt = 0; attempt < 1200 && centers.length < PATCH_COUNT; attempt++) {
      const ang = rng() * Math.PI * 2;
      const rad = Math.sqrt(rng()) * half * 0.85; // uniform over the disc
      const x = Math.cos(ang) * rad;
      const z = Math.sin(ang) * rad;
      if (!valid(x, z)) continue;
      let ok = true;
      for (let i = 0; i < centers.length; i++) {
        const dx = centers[i].x - x;
        const dz = centers[i].z - z;
        if (dx * dx + dz * dz < PATCH_MIN_DIST * PATCH_MIN_DIST) { ok = false; break; }
      }
      if (ok) centers.push({ x, z });
    }

    this.mesh = new THREE.InstancedMesh(geometry, this.material, BLADE_COUNT);
    this.mesh.name = 'grass';

    // Scatter blades around each center; bounds tracked for the sphere.
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const tint = new THREE.Color();
    let placed = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const c of centers) {
      for (let b = 0; b < BLADES_PER_PATCH && placed < BLADE_COUNT; b++) {
        const ang = rng() * Math.PI * 2;
        const rad = Math.sqrt(rng()) * PATCH_RADIUS;
        const x = c.x + Math.cos(ang) * rad;
        const z = c.z + Math.sin(ang) * rad;
        if (!valid(x, z)) continue;
        const y = getH(x, z) - 0.03; // sink the root a hair into the soil

        const height = 0.55 + rng() * 0.65; // 0.55–1.2 m
        const width = 0.8 + rng() * 0.6;    // root width variance
        q.setFromAxisAngle(up, rng() * Math.PI * 2);
        m.compose(pos.set(x, y, z), q, scl.set(width, height, width));
        this.mesh.setMatrixAt(placed, m);

        // Lerp between two palette neighbors, slight brightness wobble.
        const pi = (rng() * PALETTE.length) | 0;
        tint.lerpColors(PALETTE[pi], PALETTE[(pi + 1) % PALETTE.length], rng());
        tint.multiplyScalar(0.9 + rng() * 0.2);
        this.mesh.setColorAt(placed, tint);

        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        placed++;
      }
    }

    this.mesh.count = placed;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    // Frustum culling uses geometry.boundingSphere (mesh matrix is identity),
    // which knows nothing about instances — set it to the real spread, padded
    // for blade tips (max ~1.2 m) and wind sway.
    if (placed > 0) {
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
      const r = Math.sqrt(
        (maxX - cx) ** 2 + (maxY - cy) ** 2 + (maxZ - cz) ** 2
      ) + 1.6;
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), r);
    } else {
      this.mesh.visible = false; // degenerate world — nothing to draw
      geometry.boundingSphere = new THREE.Sphere();
    }

    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    // Contract pattern (see Water): grass must never block build/spell rays.
    this.mesh.raycast = () => {};

    ctx.scene.add(this.mesh);
  }

  // Wind sway injected into the Lambert vertex shader. Runs in blade-local
  // space (before instanceMatrix in project_vertex), so instance scale also
  // scales the sway — taller blades bend further, roots stay planted.
  _injectWindShader(shader) {
    shader.uniforms.uTime = this._uTime;

    shader.vertexShader = `
      uniform float uTime;
    ` + shader.vertexShader
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
        // Phase from instance world position — neighbors drift slightly out
        // of step, so gusts roll across a patch instead of strobing it.
        vec2 gPos = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
        float gPhase = gPos.x * 0.31 + gPos.y * 0.27;
        // Slow primary wave + faster flutter, both inside a ~27 s gust
        // envelope so the meadow breathes instead of metronoming.
        float gSway = sin(uTime * 1.7 + gPhase)
                    + 0.35 * sin(uTime * 3.9 + gPhase * 1.7);
        gSway *= 0.75 + 0.25 * sin(uTime * 0.23 + gPhase * 0.05);
        // Bend ∝ y² in the unit blade: tip travels, root stays anchored.
        float gBend = transformed.y * transformed.y;
        transformed.x += gSway * 0.13 * gBend;
        transformed.z += gSway * 0.07 * gBend;
        #endif
      `);
  }

  update(dt, elapsed) {
    // The entire animation is one uniform write; the GPU does the rest.
    this._uTime.value = elapsed;
  }
}
