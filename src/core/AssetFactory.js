// src/core/AssetFactory.js — deterministic seeded low-poly mesh factories.
//
// Named-export utility module (no default class) per docs/CONTRACTS.md.
// Consumed by: Vegetation, FloatingIslands, GrowTree spell, Golem, Wisps.
//
// Performance notes (60fps on integrated GPU):
//  - All base geometries are UNIT primitives created once and shared by every
//    mesh instance; per-seed variation comes from mesh scale/rotation, never
//    from new BufferGeometry allocations (except rocks, whose vertex jitter
//    genuinely needs unique geometry — there are only ~30-40 of them, built
//    once at startup).
//  - Materials are cached by a composite key, so 150 trees share a handful of
//    materials and the renderer can sort/batch them.
//  - Nothing here allocates per frame; factories are construction-time only.
//
// Animation hooks: every group gets `userData` describing its glow parts so
// owners (Vegetation etc.) can pulse emissives without traversing:
//   group.userData.glow = [{ material, base }]  // base = resting emissiveIntensity
// Materials are shared, so pulsing a material pulses all instances of that
// color in sync — intentional (one uniform update instead of hundreds).

import * as THREE from 'three';

/* ------------------------------------------------------------------ */
/* Seeded PRNG (deterministic per seed)                                */
/* ------------------------------------------------------------------ */

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

/** rng helper: float in [min, max) */
function range(rng, min, max) {
  return min + rng() * (max - min);
}

/** rng helper: integer in [min, max] inclusive */
function rangeInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

/* ------------------------------------------------------------------ */
/* Shared unit geometries (created lazily, cached forever)             */
/* ------------------------------------------------------------------ */

const geoCache = new Map();

function getGeo(key, build) {
  let g = geoCache.get(key);
  if (!g) {
    g = build();
    geoCache.set(key, g);
  }
  return g;
}

const unitTrunk = () =>
  getGeo('trunk', () => new THREE.CylinderGeometry(0.72, 1, 1, 6, 1));
const unitCone = () =>
  getGeo('cone', () => new THREE.ConeGeometry(1, 1, 7, 1));
const unitIco = () =>
  getGeo('ico', () => new THREE.IcosahedronGeometry(1, 0));
const unitOcta = () =>
  getGeo('octa', () => new THREE.OctahedronGeometry(1, 0));
const unitStem = () =>
  getGeo('stem', () => new THREE.CylinderGeometry(0.78, 1, 1, 7, 1));
const unitCap = () =>
  getGeo('cap', () =>
    new THREE.SphereGeometry(1, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.52));
const unitSpot = () =>
  getGeo('spot', () => new THREE.IcosahedronGeometry(1, 0));

/* ------------------------------------------------------------------ */
/* Shared materials (cached by key)                                    */
/* ------------------------------------------------------------------ */

const matCache = new Map();

/**
 * Cached flat-shaded MeshStandardMaterial. Same params -> same instance,
 * so repeated assets share materials (fewer state changes, sync pulses).
 */
function standardMat({
  color,
  emissive = 0x000000,
  emissiveIntensity = 0,
  roughness = 0.9,
  metalness = 0,
  transparent = false,
  opacity = 1,
} = {}) {
  const key =
    `${color}|${emissive}|${emissiveIntensity}|${roughness}|` +
    `${metalness}|${transparent ? 1 : 0}|${transparent ? opacity : 1}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      emissive,
      emissiveIntensity,
      roughness,
      metalness,
      transparent,
      opacity,
      flatShading: true,
    });
    m.userData.baseEmissiveIntensity = emissiveIntensity;
    matCache.set(key, m);
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* canvasTexture                                                       */
/* ------------------------------------------------------------------ */

/**
 * Build a THREE.CanvasTexture of `size`×`size` px. `drawFn(ctx2d, size)`
 * paints it. Color space is sRGB per the global render setup.
 */
export function canvasTexture(size, drawFn) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx2d = canvas.getContext('2d');
  drawFn(ctx2d, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* makeTreeMesh                                                        */
/* ------------------------------------------------------------------ */

const TRUNK_COLOR = 0x7a5230;
const NATURAL_CANOPY = [0x3f9b4f, 0x2f8a45];
const MAGICAL_CANOPY = [0xe87fd0, 0x9b6ff2, 0x7fe7ff];

/**
 * Low-poly tree. Group origin at trunk base (place at terrain height).
 * Natural: 1-3 stacked cones in deep greens. Magical: 1-3 icosahedron
 * canopies in pink/violet/cyan with a soft emissive (intensity 0.35).
 * Deterministic per `seed`.
 */
export function makeTreeMesh({ scale = 1, magical = false, seed = 0 } = {}) {
  const rng = mulberry32((seed * 2654435761 + 1) >>> 0);
  const group = new THREE.Group();
  const glow = [];

  // Trunk: r 0.18-0.28, h 1.4-2.4 (world design doc).
  const trunkR = range(rng, 0.18, 0.28);
  const trunkH = range(rng, 1.4, 2.4);
  const trunkMat = standardMat({ color: TRUNK_COLOR, roughness: 0.95 });
  const trunk = new THREE.Mesh(unitTrunk(), trunkMat);
  trunk.scale.set(trunkR, trunkH, trunkR);
  trunk.position.y = trunkH * 0.5;
  trunk.rotation.y = rng() * Math.PI * 2;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  group.add(trunk);

  const layers = rangeInt(rng, 1, 3);
  const palette = magical ? MAGICAL_CANOPY : NATURAL_CANOPY;
  // Magical trees commit to one hue per seed; naturals alternate greens.
  const magicalColor = palette[rangeInt(rng, 0, palette.length - 1)];

  let y = trunkH * (magical ? 0.92 : 0.82);
  let radius = range(rng, 0.95, 1.35);

  for (let i = 0; i < layers; i++) {
    let mesh;
    if (magical) {
      const mat = standardMat({
        color: magicalColor,
        emissive: magicalColor,
        emissiveIntensity: 0.35,
        roughness: 0.55,
      });
      mesh = new THREE.Mesh(unitIco(), mat);
      const r = radius * range(rng, 0.85, 1.05);
      mesh.scale.set(r, r * range(rng, 1.05, 1.35), r);
      mesh.position.set(
        range(rng, -0.12, 0.12),
        y + r * 0.7,
        range(rng, -0.12, 0.12)
      );
      mesh.rotation.set(
        range(rng, -0.3, 0.3),
        rng() * Math.PI * 2,
        range(rng, -0.3, 0.3)
      );
      glow.push({ material: mat, base: 0.35 });
      y += r * 1.05;
    } else {
      const color = NATURAL_CANOPY[(rangeInt(rng, 0, 1) + i) % 2];
      const mat = standardMat({ color, roughness: 0.85 });
      mesh = new THREE.Mesh(unitCone(), mat);
      const r = radius;
      const h = r * range(rng, 1.5, 2.1);
      mesh.scale.set(r, h, r);
      mesh.position.set(
        range(rng, -0.08, 0.08),
        y + h * 0.5,
        range(rng, -0.08, 0.08)
      );
      mesh.rotation.y = rng() * Math.PI * 2;
      y += h * 0.55;
    }
    mesh.castShadow = true;
    group.add(mesh);
    radius *= range(rng, 0.62, 0.74); // taper upward layers
  }

  // Whole-tree character: slight lean + facing.
  group.rotation.y = rng() * Math.PI * 2;
  group.rotation.z = range(rng, -0.05, 0.05);
  group.scale.setScalar(scale);

  group.userData.kind = 'tree';
  group.userData.magical = magical;
  group.userData.seed = seed;
  group.userData.glow = glow;
  return group;
}

/* ------------------------------------------------------------------ */
/* makeCrystalMesh                                                     */
/* ------------------------------------------------------------------ */

/**
 * Cluster of 2-4 tilted elongated octahedron shards. Emissive (0.8),
 * slightly transparent (0.85). Origin at cluster base. Deterministic
 * per `seed`. Owners pulse via userData.glow (±20%, period ~3.5s).
 */
export function makeCrystalMesh({ color = 0x7fe7ff, scale = 1, seed = 0 } = {}) {
  const rng = mulberry32((seed * 1103515245 + 7) >>> 0);
  const group = new THREE.Group();

  const mat = standardMat({
    color,
    emissive: color,
    emissiveIntensity: 0.8,
    roughness: 0.2,
    metalness: 0.1,
    transparent: true,
    opacity: 0.85,
  });

  const count = rangeInt(rng, 2, 4);
  const maxTilt = THREE.MathUtils.degToRad(25);

  for (let i = 0; i < count; i++) {
    // Elongated shard: height 0.8-1.8, width ~28-40% of height.
    const h = range(rng, 0.8, 1.8);
    const w = h * range(rng, 0.28, 0.4);
    const shard = new THREE.Mesh(unitOcta(), mat);
    shard.scale.set(w, h * 0.5, w); // octahedron spans -1..1 in y -> total h
    const angle = (i / count) * Math.PI * 2 + rng() * 1.2;
    const dist = i === 0 ? 0 : range(rng, 0.18, 0.45);
    shard.position.set(
      Math.cos(angle) * dist,
      h * 0.42, // sink the lower tip slightly into the ground
      Math.sin(angle) * dist
    );
    const tilt = rng() * maxTilt;
    shard.rotation.set(
      Math.cos(angle + Math.PI / 2) * tilt,
      rng() * Math.PI * 2,
      Math.sin(angle + Math.PI / 2) * tilt
    );
    shard.castShadow = true;
    group.add(shard);
  }

  group.rotation.y = rng() * Math.PI * 2;
  group.scale.setScalar(scale);

  group.userData.kind = 'crystal';
  group.userData.seed = seed;
  group.userData.glow = [{ material: mat, base: 0.8 }];
  return group;
}

/* ------------------------------------------------------------------ */
/* makeMushroomMesh                                                    */
/* ------------------------------------------------------------------ */

const STEM_COLOR = 0xe8e0d0;
const CAP_COLOR = 0xd8506a;
const SPOT_COLOR = 0xaef7e0;

/**
 * Glowing-spotted mushroom. Pale stem (h ≈ 0.5), rosy half-sphere cap
 * (r ≈ 0.4) studded with 5-7 emissive mint spots (intensity 1.2).
 * Origin at stem base. Deterministic per `seed`.
 */
export function makeMushroomMesh({ scale = 1, seed = 0 } = {}) {
  const rng = mulberry32((seed * 22695477 + 3) >>> 0);
  const group = new THREE.Group();

  const stemH = 0.5 * range(rng, 0.85, 1.2);
  const stemR = stemH * range(rng, 0.28, 0.36);
  const stemMat = standardMat({ color: STEM_COLOR, roughness: 0.9 });
  const stem = new THREE.Mesh(unitStem(), stemMat);
  stem.scale.set(stemR, stemH, stemR);
  stem.position.y = stemH * 0.5;
  stem.castShadow = true;
  group.add(stem);

  const capR = 0.4 * range(rng, 0.85, 1.15);
  const capMat = standardMat({
    color: CAP_COLOR,
    emissive: CAP_COLOR,
    emissiveIntensity: 0.12,
    roughness: 0.6,
  });
  const cap = new THREE.Mesh(unitCap(), capMat);
  cap.scale.set(capR, capR * range(rng, 0.72, 0.9), capR);
  cap.position.y = stemH * 0.92;
  cap.rotation.y = rng() * Math.PI * 2;
  cap.castShadow = true;
  group.add(cap);

  // Glowing spots embedded on the cap dome surface.
  const spotMat = standardMat({
    color: SPOT_COLOR,
    emissive: SPOT_COLOR,
    emissiveIntensity: 1.2,
    roughness: 0.4,
  });
  const spots = rangeInt(rng, 5, 7);
  for (let i = 0; i < spots; i++) {
    const spot = new THREE.Mesh(unitSpot(), spotMat);
    const sr = capR * range(rng, 0.08, 0.14);
    spot.scale.set(sr, sr * 0.5, sr); // flattened against the dome
    // Spherical coords on the upper dome, biased away from the apex rim.
    const theta = rng() * Math.PI * 2;
    const phi = range(rng, 0.25, 1.15); // 0 = apex
    const r = capR * 0.97;
    spot.position.set(
      Math.sin(phi) * Math.cos(theta) * r,
      cap.position.y + Math.cos(phi) * r * cap.scale.y / capR,
      Math.sin(phi) * Math.sin(theta) * r
    );
    // Orient the flattened blob outward along the dome normal.
    spot.lookAt(0, cap.position.y, 0);
    spot.rotateX(Math.PI / 2);
    group.add(spot);
  }

  group.rotation.y = rng() * Math.PI * 2;
  group.scale.setScalar(scale);

  group.userData.kind = 'mushroom';
  group.userData.seed = seed;
  // Pulse target: spots (±15% emissive, period ~2.8s — owner animates).
  group.userData.glow = [{ material: spotMat, base: 1.2 }];
  return group;
}

/* ------------------------------------------------------------------ */
/* makeRockMesh                                                        */
/* ------------------------------------------------------------------ */

const ROCK_COLORS = [0x6f6a7d, 0x7d7889, 0x666172];

/**
 * Single flat-shaded boulder: dodecahedron (or icosahedron) with seeded
 * vertex jitter, violet-tinted gray, squashed for a settled look.
 * Returns a THREE.Mesh (per contract). Origin near the rock base.
 * Unique geometry per call (cheap: only built at startup, ~30-40 total).
 */
export function makeRockMesh({ scale = 1, seed = 0 } = {}) {
  const rng = mulberry32((seed * 747796405 + 11) >>> 0);

  const geom = rng() < 0.5
    ? new THREE.DodecahedronGeometry(0.55, 0)
    : new THREE.IcosahedronGeometry(0.55, 0);

  // Jitter vertices for a craggy silhouette. Indexed-free poly geometries in
  // r184 duplicate vertices per face, so jitter by *position hash* to keep
  // shared corners welded (no cracks).
  const pos = geom.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    // Deterministic hash of the (quantized) vertex position + seed.
    const hx = Math.round(v.x * 1000), hy = Math.round(v.y * 1000), hz = Math.round(v.z * 1000);
    const h = mulberry32((hx * 73856093) ^ (hy * 19349663) ^ (hz * 83492791) ^ (seed * 2654435761));
    const bump = 0.78 + h() * 0.5; // radial scale 0.78-1.28
    v.multiplyScalar(bump);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  // Squash vertically so it reads as a settled boulder.
  const squash = range(rng, 0.6, 0.85);
  for (let i = 0; i < pos.count; i++) {
    pos.setY(i, pos.getY(i) * squash);
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals(); // flatShading uses face normals anyway, but keep clean

  const mat = standardMat({
    color: ROCK_COLORS[rangeInt(rng, 0, ROCK_COLORS.length - 1)],
    roughness: 0.95,
  });

  const rock = new THREE.Mesh(geom, mat);
  rock.rotation.set(rng() * Math.PI * 2, rng() * Math.PI * 2, rng() * Math.PI * 2);
  rock.position.y = 0.32 * squash * scale; // sit roughly on the origin plane
  rock.scale.setScalar(scale);
  rock.castShadow = true;
  rock.receiveShadow = true;

  rock.userData.kind = 'rock';
  rock.userData.seed = seed;
  return rock;
}
