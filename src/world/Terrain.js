import * as THREE from 'three';
import { createNoise2D, fbm } from './Noise.js';

// ---------------------------------------------------------------------------
// Terrain — fbm island heightfield (160x160 verts over 240x240 world units).
//
// Shape recipe (docs/design/world.md):
//   warp   = sample coords bent by low-freq fbm (domain warp → curving valleys)
//   base   = fbm(seed 1337, 5 octaves, scale 1/55, warped) * heightScale(18)
//   ridge  = +0.35 * heightScale * (1 - |fbm(wx*1.7+900, wz*1.7+900, 3 oct, 1/28)|)
//   coast  = radial falloff, radius bent by two octave-bands of angular noise
//            → headlands, inlets and a genuinely ragged shoreline
//   island = (base + ridge) * coastFalloff - 11 * rimDrop  → rims sink underwater
//            (+ a hard outer shelf that guarantees rim depth past 90% radius)
//   coves  = three gaussian bays + one inland lagoon that carve the silhouette
//   spawn  = guaranteed dry plateau (y ≥ waterLevel + 1) within radius 25
//
// Vertex-colored, flat-shaded, height/slope banded: sand → grass → violet rock
// → snow. Band boundaries are dithered by a precomputed noise field so they
// meander instead of tracing contour lines; the sea floor fades from deep teal
// into pale shallows; wet sand darkens the waterline; a macro hue field drifts
// the meadows between lush green and sun-warmed gold in broad painterly sweeps;
// fey-meadow teal patches and persistent scorch marks from spells layer on top.
// ---------------------------------------------------------------------------

const SEED = 1337;
const HEIGHT_MIN = -8;
const HEIGHT_MAX = 20;
const MODIFY_MAX = 26; // sculpting may pile a little above generated max

const COVES = [
  { x: 78, z: 30, depth: 5, sigma: 14 },
  { x: -65, z: -72, depth: 5, sigma: 14 },
  { x: -14, z: 84, depth: 4.5, sigma: 16 },
  { x: 44, z: 50, depth: 7, sigma: 10 }, // inland lagoon — a small magical lake
];

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

// Deterministic per-vertex jitter hash (cheap, no PRNG state needed).
function vertexHash(ix, iz) {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453123;
  return s - Math.floor(s);
}

// Float32Array <-> base64 (browser btoa/atob; chunked to dodge arg limits).
function f32ToBase64(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToF32(str) {
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

export default class Terrain {
  constructor(ctx) {
    this.ctx = ctx;

    const cfg = ctx.config;
    this.res = cfg.terrainRes;        // 160 vertices per side
    this.size = cfg.worldSize;        // 240 world units
    this.heightScale = cfg.heightScale;
    this.waterLevel = cfg.waterLevel;
    this.half = this.size / 2;
    this.step = this.size / (this.res - 1);

    const count = this.res * this.res;
    this.heightData = new Float32Array(count); // row-major: heightData[iz * res + ix]
    this._scorch = new Float32Array(count);    // 0..1 burn mask, persists across recolors
    this._fey = new Float32Array(count);       // 0..1 fey-meadow tint weight (precomputed)
    this._warp = new Float32Array(count);      // ±~1 band-boundary dither (precomputed)
    this._macro = new Float32Array(count);     // 0..1 macro hue drift (lush ↔ golden)
    this._bloom = new Float32Array(count);     // 0..1 wildflower-blush patches

    this._noise = createNoise2D(SEED);

    // --- palette (THREE.Color converts sRGB hex → working/linear space) ---
    this._bandAbyss = new THREE.Color(0x5e8a78);  // deep sea-floor teal
    this._bandUnder = new THREE.Color(0xc8b87a);  // underwater sand
    this._bandWet = new THREE.Color(0xb29a63);    // wet sand at the waterline
    this._bandBeach = new THREE.Color(0xe8d49a);  // beach sand
    this._bandLush = new THREE.Color(0x5dbb63);   // lush grass
    this._bandDeep = new THREE.Color(0x3e9a52);   // deep grass
    this._bandGold = new THREE.Color(0xa9c168);   // sun-warmed meadow gold
    this._bandMossy = new THREE.Color(0x8a7f95);  // violet-tinted mossy rock
    this._bandBare = new THREE.Color(0x6f6a7d);   // bare rock
    this._bandSnow = new THREE.Color(0xf4f7ff);   // snow caps
    this._feyColor = new THREE.Color(0x7fd8c9);   // fey-meadow teal
    this._bloomColor = new THREE.Color(0xe3a0c4); // wildflower blush
    this._shallowTint = new THREE.Color(0x8fe0c8);// turquoise lagoon glints
    this._scorchColor = new THREE.Color(0x4a3f38);// burnt earth

    // scratch objects — reused everywhere, zero allocations in hot paths
    this._cA = new THREE.Color();
    this._cB = new THREE.Color();

    this._generate();
    this._buildMesh();

    ctx.scene.add(this.mesh);
  }

  // ------------------------------------------------------------------ height

  _sampleIslandHeight(x, z) {
    const noise = this._noise;
    const hs = this.heightScale;

    // two-stage domain warp — a broad swirl bends the coords that feed the
    // detail warp, so valleys curve and ridgelines snake in nested arcs
    // instead of running straight (warp-of-warp = far more organic interiors)
    const qx = x + 26 * fbm(noise, x * 0.008 + 57, z * 0.008 + 57, { octaves: 2, scale: 1 });
    const qz = z + 26 * fbm(noise, x * 0.008 + 183, z * 0.008 + 183, { octaves: 2, scale: 1 });
    const wx = x + 13 * fbm(noise, qx * 0.016 + 310, qz * 0.016 + 310, { octaves: 2, scale: 1 });
    const wz = z + 13 * fbm(noise, qx * 0.016 + 740, qz * 0.016 + 740, { octaves: 2, scale: 1 });

    // rolling fbm base (sampled through the warp)
    let h = fbm(noise, wx, wz, { octaves: 5, lacunarity: 2.0, gain: 0.5, scale: 1 / 55 }) * hs;

    // ridge accent — soft ridgelines that read beautifully flat-shaded.
    // A low-frequency mask fades the ridges in and out across the island so
    // some regions roll as smooth meadow while others crest into spines.
    const r = fbm(noise, wx * 1.7 + 900, wz * 1.7 + 900, { octaves: 3, scale: 1 / 28 });
    const ridgeMask = 0.25 + 0.75 * smoothstep(-0.3, 0.45,
      fbm(noise, x * 0.012 + 1500, z * 0.012 + 1500, { octaves: 2, scale: 1 }));
    h += 0.35 * hs * (1 - Math.abs(r)) * ridgeMask;

    // radial island falloff with a noisy radius: the coastline gets headlands
    // and inlets instead of a circular blob. Two octave-bands of angular noise
    // (broad peninsulas + fine raggedness) are sampled on the unit direction,
    // continuous around the full circle. The hard outer shelf below guarantees
    // the rim sinks below waterLevel - 2 no matter what the noise does.
    const dist = Math.sqrt(x * x + z * z);
    let d = dist / this.half;
    if (dist > 1e-5) {
      const inv = 2.4 / dist;
      const coast = fbm(noise, x * inv + 47.3, z * inv - 91.7, { octaves: 3, scale: 1 });
      const fine = fbm(noise, x * inv * 2.3 + 19.7, z * inv * 2.3 + 63.1, { octaves: 2, scale: 1 });
      const ultra = fbm(noise, x * inv * 4.7 + 77.7, z * inv * 4.7 - 31.9, { octaves: 2, scale: 1 });
      d /= 1 + 0.15 * coast + 0.055 * fine + 0.025 * ultra;
    }
    let y = h * (1 - smoothstep(0.55, 0.98, d)) - 11 * smoothstep(0.78, 1.0, d);

    // coves — gaussian bays (and one inland lagoon) that break the silhouette
    for (let i = 0; i < COVES.length; i++) {
      const c = COVES[i];
      const dx = x - c.x;
      const dz = z - c.z;
      y -= c.depth * Math.exp(-(dx * dx + dz * dz) / (2 * c.sigma * c.sigma));
    }

    // hard outer shelf — past 90% of the world radius everything blends down
    // to -7, so the rim contract (y < waterLevel - 2) holds for any noise.
    const edge = smoothstep(0.9, 1.0, dist / this.half);
    if (edge > 0) y = lerp(y, -7, edge);

    y = clamp(y, HEIGHT_MIN, HEIGHT_MAX);

    // spawn plateau: blend toward dry ground near the origin…
    const w = 1 - smoothstep(15, 25, dist);
    if (w > 0) {
      const target = Math.max(y, this.waterLevel + 1.6);
      y = lerp(y, target, w);
    }

    // …and a hard (but spatially continuous) floor so the contract holds:
    // y ≥ waterLevel + 1 everywhere within radius 25 of the origin. The
    // plateau extends to r=28 because getHeight() bilinearly interpolates —
    // cells straddling r=25 must not blend toward lower vertices outside it.
    const wl = this.waterLevel;
    const floor = dist <= 28
      ? lerp(wl + 1.7, wl + 1.05, smoothstep(12, 25, dist))
      : lerp(wl + 1.05, -12, smoothstep(28, 39, dist));
    if (y < floor) y = floor;

    return y;
  }

  _generate() {
    const res = this.res;
    const noise = this._noise;
    for (let iz = 0; iz < res; iz++) {
      const z = -this.half + iz * this.step;
      for (let ix = 0; ix < res; ix++) {
        const x = -this.half + ix * this.step;
        const i = iz * res + ix;
        this.heightData[i] = this._sampleIslandHeight(x, z);

        // fey-meadow mask: low-frequency fbm, soft-edged threshold around 0.45
        const f = fbm(noise, x * 0.04 + 500, z * 0.04 + 500, { octaves: 3, scale: 1 });
        this._fey[i] = smoothstep(0.42, 0.52, f);

        // band dither: meanders the height-band boundaries so color
        // transitions wander organically instead of tracing contours.
        // Two octave-bands: a broad ±~1.1 meander plus a fine ±~0.35 fizz
        // that lets single facets flicker across a boundary — band edges
        // read as feathered brush strokes rather than smooth ribbons.
        this._warp[i] =
          1.1 * fbm(noise, x * 0.09 + 1200, z * 0.09 + 1200, { octaves: 2, scale: 1 }) +
          0.35 * fbm(noise, x * 0.31 + 4400, z * 0.31 + 4400, { octaves: 2, scale: 1 });

        // macro hue field: very-low-frequency drift between lush wet green
        // and sun-dried gold — the meadows read as broad painterly sweeps
        const m = fbm(noise, x * 0.022 + 2100, z * 0.022 + 2100, { octaves: 3, scale: 1 });
        this._macro[i] = smoothstep(-0.35, 0.55, m);

        // wildflower blush: mid-frequency patches where the meadow flushes
        // soft pink — small enough to feel scattered, big enough to read
        const b = fbm(noise, x * 0.06 + 3300, z * 0.06 + 3300, { octaves: 2, scale: 1 });
        this._bloom[i] = smoothstep(0.3, 0.55, b);
      }
    }
  }

  // ------------------------------------------------------------------- mesh

  _buildMesh() {
    const res = this.res;
    const geometry = new THREE.PlaneGeometry(this.size, this.size, res - 1, res - 1);
    geometry.rotateX(-Math.PI / 2);
    // After rotateX(-PI/2) vertex index i = iz * res + ix maps to
    // x = -half + ix*step, z = -half + iz*step — same row-major order as heightData.

    const count = res * res;
    const colors = new Float32Array(count * 3);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
    geometry.attributes.color.setUsage(THREE.DynamicDrawUsage);

    this.geometry = geometry;
    this._refreshRegion(0, res - 1, 0, res - 1);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0.0,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'terrain';
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = true;
  }

  // Rewrite positions + colors for a vertex-index rectangle (inclusive bounds).
  _refreshRegion(ix0, ix1, iz0, iz1) {
    const res = this.res;
    ix0 = Math.max(0, ix0);
    iz0 = Math.max(0, iz0);
    ix1 = Math.min(res - 1, ix1);
    iz1 = Math.min(res - 1, iz1);

    const pos = this.geometry.attributes.position.array;
    const col = this.geometry.attributes.color.array;

    for (let iz = iz0; iz <= iz1; iz++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const i = iz * res + ix;
        const i3 = i * 3;
        pos[i3] = -this.half + ix * this.step;
        pos[i3 + 1] = this.heightData[i];
        pos[i3 + 2] = -this.half + iz * this.step;
        this._writeVertexColor(ix, iz, i, col);
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
  }

  _writeVertexColor(ix, iz, i, out) {
    const res = this.res;
    const hd = this.heightData;
    const y = hd[i];
    const c = this._cA;

    // neighbor taps — feed both slope (rock blending) and cavity (a cheap
    // ambient-occlusion stand-in: dips shade darker, crests catch light)
    const xm = Math.max(ix - 1, 0);
    const xp = Math.min(ix + 1, res - 1);
    const zm = Math.max(iz - 1, 0);
    const zp = Math.min(iz + 1, res - 1);
    const hxm = hd[iz * res + xm];
    const hxp = hd[iz * res + xp];
    const hzm = hd[zm * res + ix];
    const hzp = hd[zp * res + ix];
    const dhdx = (hxp - hxm) / ((xp - xm) * this.step);
    const dhdz = (hzp - hzm) / ((zp - zm) * this.step);
    const slope = Math.sqrt(dhdx * dhdx + dhdz * dhdz);
    const cav = (hxm + hxp + hzm + hzp) * 0.25 - y; // >0 in hollows, <0 on crests

    // height bands — boundaries dithered by the precomputed noise field and
    // blended across wide, overlapping smoothsteps for painterly gradients
    const yb = y + this._warp[i];
    c.copy(this._bandAbyss);                            // sea floor fades up…
    c.lerp(this._bandUnder, smoothstep(-5.5, -0.4, yb)); // …into pale shallows
    c.lerp(this._bandBeach, smoothstep(-0.1, 1.4, yb)); // ~0.65 ± 0.75
    c.lerp(this._bandLush, smoothstep(1.5, 3.2, yb));   // ~2.35 ± 0.85
    c.lerp(this._bandDeep, smoothstep(6.1, 8.9, yb));   // ~7.5  ± 1.4
    c.lerp(this._bandMossy, smoothstep(9.8, 12.2, yb)); // ~11   ± 1.2
    c.lerp(this._bandBare, smoothstep(13.4, 15.6, yb)); // ~14.5 ± 1.1
    c.lerp(this._bandSnow, smoothstep(16.1, 18.0, yb)); // ~17   ± 0.95

    // wet sand — a dark, damp ring hugging the waterline (uses true height
    // so the tide-line stays crisp even where bands are dithered)
    const wl = this.waterLevel;
    const wet = smoothstep(wl - 1.4, wl - 0.3, y) * (1 - smoothstep(wl + 0.15, wl + 1.0, y));
    if (wet > 0) c.lerp(this._bandWet, 0.55 * wet);

    // submerged shallows pick up turquoise lagoon glints where the macro
    // field runs lush — sea-floor color shifts instead of one flat ramp
    const sub = 1 - smoothstep(wl - 0.4, wl + 0.2, y);
    if (sub > 0) c.lerp(this._shallowTint, 0.22 * sub * (1 - this._macro[i]));

    // steep faces read as rock regardless of band (soft onset → mossy cliffs
    // shade in gradually instead of snapping at a slope threshold)
    const rockW = smoothstep(0.48, 0.95, slope);

    // meadow tints — grass bands only, fading off rocky faces
    const grassW = smoothstep(1.5, 3.2, yb) * (1 - smoothstep(9.8, 12.2, yb)) * (1 - rockW);
    if (grassW > 0) {
      // macro hue drift: lush wet green ↔ sun-warmed gold in broad sweeps
      const macro = this._macro[i];
      if (macro > 0) c.lerp(this._bandGold, 0.45 * macro * grassW);
      // fey-meadow teal patches layer on top of whatever hue the meadow took
      const fey = this._fey[i];
      if (fey > 0) c.lerp(this._feyColor, 0.35 * fey * grassW);
      // wildflower blush — only on gentle ground where flowers would take
      const bloom = this._bloom[i];
      if (bloom > 0) {
        c.lerp(this._bloomColor, 0.28 * bloom * grassW * (1 - smoothstep(0.22, 0.45, slope)));
      }
    }

    if (rockW > 0) {
      const rock = this._cB.copy(this._bandMossy).lerp(this._bandBare, smoothstep(8, 15, yb));
      c.lerp(rock, rockW);
    }

    // scorch marks (fireball craters) — persists through recolors
    const burn = this._scorch[i];
    if (burn > 0) c.lerp(this._scorchColor, 0.5 * burn);

    // cavity shading: hollows sink into shadow, crests catch the light —
    // gives the flat-shaded facets painterly depth for free
    const shade =
      1 - 0.2 * smoothstep(0, 1.1, cav) + 0.12 * smoothstep(0, 1.1, -cav);

    // subtle deterministic per-vertex variation — keeps big facets lively
    const jitter = shade * (1 + (vertexHash(ix, iz) - 0.5) * 0.07);
    const i3 = i * 3;
    out[i3] = Math.min(1, c.r * jitter);
    out[i3 + 1] = Math.min(1, c.g * jitter);
    out[i3 + 2] = Math.min(1, c.b * jitter);
  }

  // ------------------------------------------------------------------ query

  /**
   * Bilinear-interpolated terrain height at world (x, z).
   * Returns -100 outside the world bounds.
   */
  getHeight(x, z) {
    if (x < -this.half || x > this.half || z < -this.half || z > this.half) return -100;

    const res = this.res;
    const hd = this.heightData;
    const fx = (x + this.half) / this.step;
    const fz = (z + this.half) / this.step;

    let ix = Math.floor(fx);
    let iz = Math.floor(fz);
    if (ix > res - 2) ix = res - 2;
    if (iz > res - 2) iz = res - 2;
    if (ix < 0) ix = 0;
    if (iz < 0) iz = 0;

    const tx = clamp(fx - ix, 0, 1);
    const tz = clamp(fz - iz, 0, 1);

    const i = iz * res + ix;
    const h00 = hd[i];
    const h10 = hd[i + 1];
    const h01 = hd[i + res];
    const h11 = hd[i + res + 1];

    const top = h00 + (h10 - h00) * tx;
    const bottom = h01 + (h11 - h01) * tx;
    return top + (bottom - top) * tz;
  }

  // ----------------------------------------------------------------- modify

  /**
   * Smooth-falloff sculpting brush. Adds `delta` height at (x, z), feathered
   * with a cosine bell out to `radius`. Refreshes geometry, recolors the
   * touched verts (small downward brushes also scorch — fireball craters),
   * recomputes normals, and emits 'terrain:modify'.
   */
  modify(x, z, delta, radius) {
    if (!(radius > 0) || !Number.isFinite(delta) || delta === 0) return;

    const res = this.res;
    const ix0 = Math.max(0, Math.floor((x - radius + this.half) / this.step));
    const ix1 = Math.min(res - 1, Math.ceil((x + radius + this.half) / this.step));
    const iz0 = Math.max(0, Math.floor((z - radius + this.half) / this.step));
    const iz1 = Math.min(res - 1, Math.ceil((z + radius + this.half) / this.step));
    if (ix0 > ix1 || iz0 > iz1) return;

    // Small destructive brushes are spell blasts → scorch the ground.
    const scorching = delta < 0 && radius <= 3.2;
    let touched = false;

    for (let iz = iz0; iz <= iz1; iz++) {
      const wz = -this.half + iz * this.step;
      const dz = wz - z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = -this.half + ix * this.step;
        const dx = wx - x;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d >= radius) continue;

        const w = 0.5 + 0.5 * Math.cos((Math.PI * d) / radius); // smooth bell
        const i = iz * res + ix;
        this.heightData[i] = clamp(this.heightData[i] + delta * w, HEIGHT_MIN, MODIFY_MAX);
        if (scorching) this._scorch[i] = Math.min(1, this._scorch[i] + w * 0.85);
        touched = true;
      }
    }

    if (!touched) return;

    // +1 ring so slope-driven colors at the brush edge stay correct
    this._refreshRegion(ix0 - 1, ix1 + 1, iz0 - 1, iz1 + 1);
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();

    this.ctx.events.emit('terrain:modify', { x, z, radius });
  }

  // ------------------------------------------------------------ persistence

  serialize() {
    return {
      version: 1,
      res: this.res,
      size: this.size,
      heights: f32ToBase64(this.heightData),
      scorch: f32ToBase64(this._scorch),
    };
  }

  deserialize(data) {
    if (!data || !data.heights) return;

    const count = this.res * this.res;
    let heights = null;
    try {
      if (typeof data.heights === 'string') {
        heights = base64ToF32(data.heights);
      } else if (Array.isArray(data.heights)) {
        heights = Float32Array.from(data.heights);
      }
    } catch (err) {
      console.error('[Terrain] failed to decode saved heights', err);
      return;
    }
    if (!heights || heights.length !== count) {
      console.warn('[Terrain] saved heightfield resolution mismatch — keeping current terrain');
      return;
    }

    this.heightData.set(heights);

    this._scorch.fill(0);
    try {
      if (typeof data.scorch === 'string') {
        const scorch = base64ToF32(data.scorch);
        if (scorch.length === count) this._scorch.set(scorch);
      } else if (Array.isArray(data.scorch) && data.scorch.length === count) {
        this._scorch.set(data.scorch);
      }
    } catch (err) {
      // scorch is cosmetic — a fresh mask is fine
    }

    this._refreshRegion(0, this.res - 1, 0, this.res - 1);
    this.geometry.computeVertexNormals();
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }
}
