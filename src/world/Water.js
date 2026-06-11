import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm } from './Noise.js';

// ---------------------------------------------------------------------------
// Water — translucent animated magical water plane.
//
// Contract (docs/CONTRACTS.md):
//   - Plane at y = config.waterLevel, size >= worldSize * 1.5.
//   - Gentle vertex waves + slowly scrolling sparkle.
//   - transparent: true, opacity ~0.75, magical teal-blue, emissive at night.
//   - Excluded from raycasts (mesh.raycast = noop).
//
// Design (docs/design/world.md):
//   - PlaneGeometry(380, 380, 64, 64) at y = 1.2.
//   - Color #2aa3a8 day -> #1b5e8a night; opacity 0.75, roughness 0.15.
//   - Night emissive #0d4a52 @ 0.35 (0 by day).
//   - Waves: 0.12*sin(x*0.18 + t*1.1) + 0.09*sin(z*0.23 - t*0.9)
//            + 0.05*sin((x+z)*0.31 + t*1.7)
//   - Sparkle: 128px seamless canvas noise, uv scroll (0.008, 0.005)/s, ~20%.
// ---------------------------------------------------------------------------

const SEGMENTS = 64;
const SPARKLE_SIZE = 128;
const SPARKLE_REPEAT = 22;
const SCROLL_U = 0.008; // tiles / second
const SCROLL_V = 0.005;

// Wave constants (amplitude, spatial frequency, temporal frequency).
// A 4th counter-diagonal ripple breaks the interference pattern's symmetry so
// the surface reads dreamy instead of mechanical. Still fully analytic.
const A1 = 0.12, F1 = 0.18, T1 = 1.1;
const A2 = 0.09, F2 = 0.23, T2 = -0.9;
const A3 = 0.05, F3 = 0.31, T3 = 1.7;
const A4 = 0.035, F4 = 0.47, T4 = -1.35;
// 5th wave: a long, slow ocean swell rolling diagonally across the whole
// plane — broad undulation that makes the sea feel vast and dreamlike.
const A5 = 0.055, F5 = 0.045, T5 = 0.32;
const SW_X = 0.62, SW_Z = 0.78; // swell travel direction
// 6th wave: fine fast chop riding on top — tiny glittering texture that makes
// the surface feel liquid up close without disturbing the dreamy swell.
const A6 = 0.022, F6 = 0.85, T6 = 2.3;
const CH_X = 0.93, CH_Z = -0.37; // chop travel direction (crosses the swell)
// Pre-multiplied slope coefficients for analytic normals (d/dx of A*sin(F*x)).
const D1 = A1 * F1;
const D2 = A2 * F2;
const D3 = A3 * F3;
const D4 = A4 * F4;
const D5 = A5 * F5;
const D6 = A6 * F6;
// Slow swell envelope — the whole sea breathes over ~90 s.
const SWELL_W = 0.07;
const SWELL_AMP = 0.18; // envelope ranges 0.82 .. 1.18

const COLOR_DAY = new THREE.Color('#2aa3a8');
const COLOR_DAY_B = new THREE.Color('#35b0d2'); // azure twin — daylight hue drifts between the two
const COLOR_NIGHT = new THREE.Color('#1b5e8a');
const EMISSIVE_NIGHT = new THREE.Color('#0e5560');
const SKY_TINT = 0.2; // how much of the fog/horizon color bleeds into the water

export default class Water {
  constructor(ctx) {
    this.ctx = ctx;
    this.sky = ctx.systems.sky || null; // sky constructs before water

    const size = Math.max(ctx.config.worldSize * 1.5, 380);

    // --- Geometry -----------------------------------------------------------
    // Rotate the geometry itself into the XZ plane so the position attribute's
    // y component is straight-up world height — keeps the per-frame wave loop
    // and analytic normals trivially simple.
    const geometry = new THREE.PlaneGeometry(size, size, SEGMENTS, SEGMENTS);
    geometry.rotateX(-Math.PI / 2);

    const posAttr = geometry.getAttribute('position');
    const nrmAttr = geometry.getAttribute('normal');
    posAttr.setUsage(THREE.DynamicDrawUsage);
    nrmAttr.setUsage(THREE.DynamicDrawUsage);

    // Cache the immutable x/z lattice once so the hot loop only reads two
    // flat Float32Arrays and writes y + normal — zero per-frame allocation.
    const count = posAttr.count;
    this._count = count;
    this._pos = posAttr.array;
    this._nrm = nrmAttr.array;
    this._xs = new Float32Array(count);
    this._zs = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this._xs[i] = this._pos[i * 3];
      this._zs[i] = this._pos[i * 3 + 2];
    }
    this._posAttr = posAttr;
    this._nrmAttr = nrmAttr;

    // Waves displace at most (A1+A2+A3+A4)·(1+SWELL_AMP) ≈ 0.35; pad the
    // bounding sphere once so culling never clips a crest, never recompute it.
    geometry.computeBoundingSphere();
    geometry.boundingSphere.radius += 1;

    // --- Sparkle texture ----------------------------------------------------
    this.sparkleMap = this._makeSparkleTexture();

    // --- Material -----------------------------------------------------------
    this.material = new THREE.MeshStandardMaterial({
      color: COLOR_DAY.clone(),
      map: this.sparkleMap,          // ~20% luminance shimmer over the base
      emissive: EMISSIVE_NIGHT.clone(),
      emissiveMap: this.sparkleMap,  // night glow inherits the caustic pattern
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0.75,
      roughness: 0.15,
      metalness: 0.0,
      depthWrite: false,             // friendlier transparency sorting
    });

    // --- Mesh ---------------------------------------------------------------
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'water';
    this.mesh.position.y = ctx.config.waterLevel;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1; // draw after opaque world for clean blending
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    // Contract: water must never block build/spell raycasts.
    this.mesh.raycast = () => {};

    ctx.scene.add(this.mesh);

    // Sparkle web rotates almost imperceptibly around its center — kills any
    // residual conveyor-belt feel from the uv scroll.
    this.sparkleMap.center.set(0.5, 0.5);

    // Scratch state (reused every frame — no per-frame allocations).
    this._nightFactor = -1; // force first-frame material refresh
    this._tint = new THREE.Color();
    this._emissiveTint = new THREE.Color();
  }

  // Seamlessly tiling caustic-noise texture: soft fbm "light web" plus a
  // scattering of hard bright glint pixels. Built once at init.
  _makeSparkleTexture() {
    const size = SPARKLE_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    const img = g.createImageData(size, size);
    const data = img.data;

    const noise = createNoise2D(20260611);
    const opts = { octaves: 3, lacunarity: 2.1, gain: 0.55, scale: 1 / 17 };
    const sample = (x, y) => fbm(noise, x, y, opts);

    // Standard 4-corner cross-blend makes any noise tile seamlessly.
    for (let y = 0; y < size; y++) {
      const wy = y / size;
      for (let x = 0; x < size; x++) {
        const wx = x / size;
        const v =
          sample(x, y) * (1 - wx) * (1 - wy) +
          sample(x - size, y) * wx * (1 - wy) +
          sample(x, y - size) * (1 - wx) * wy +
          sample(x - size, y - size) * wx * wy;

        // Ridge the noise into thin bright filaments (caustic look), then
        // keep the whole field within ~±20% of white so map-multiply only
        // shimmers the base color instead of darkening it.
        const ridge = 1 - Math.abs(v);            // [0,1], peaks at v == 0
        const lum = Math.round(204 + Math.pow(ridge, 3) * 51); // 204..255
        const i = (y * size + x) * 4;
        data[i] = lum;
        data[i + 1] = lum;
        data[i + 2] = lum;
        data[i + 3] = 255;
      }
    }

    // Hard glints — tiny full-white sparks, wrapped so tiling stays seamless.
    const rand = mulberry32(9001);
    for (let s = 0; s < 130; s++) {
      const sx = Math.floor(rand() * size);
      const sy = Math.floor(rand() * size);
      const put = (px, py) => {
        const i = (((py + size) % size) * size + ((px + size) % size)) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      };
      put(sx, sy);
      if (rand() < 0.45) put(sx + 1, sy); // a few 2px glints read brighter
    }

    g.putImageData(img, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(SPARKLE_REPEAT, SPARKLE_REPEAT);
    return texture;
  }

  update(dt, elapsed) {
    // --- Vertex waves with analytic normals --------------------------------
    // Derivatives of the wave sum are known in closed form, so we skip
    // computeVertexNormals() entirely — exact normals, a fraction of the cost.
    const pos = this._pos;
    const nrm = this._nrm;
    const xs = this._xs;
    const zs = this._zs;
    const count = this._count;
    const p1 = elapsed * T1;
    const p2 = elapsed * T2;
    const p3 = elapsed * T3;
    const p4 = elapsed * T4;
    const p5 = elapsed * T5;
    const p6 = elapsed * T6;
    // Breathing swell: scales heights AND slopes linearly, so the analytic
    // normals stay exact for free.
    const env = 1 + SWELL_AMP * Math.sin(elapsed * SWELL_W);

    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const x = xs[i];
      const z = zs[i];
      const a1 = x * F1 + p1;
      const a2 = z * F2 + p2;
      const a3 = (x + z) * F3 + p3;
      const a4 = (x - z) * F4 + p4;
      const a5 = (x * SW_X + z * SW_Z) * F5 + p5;
      const a6 = (x * CH_X + z * CH_Z) * F6 + p6;

      const s4 = Math.sin(a4);
      pos[j + 1] =
        (A1 * Math.sin(a1) + A2 * Math.sin(a2) + A3 * Math.sin(a3) + A4 * s4) * env +
        A5 * Math.sin(a5) + // the long swell rolls outside the breathing envelope
        A6 * Math.sin(a6);  // fine chop glitter on top

      const c3 = D3 * Math.cos(a3);
      const c4 = D4 * Math.cos(a4);
      const c5 = D5 * Math.cos(a5);
      const c6 = D6 * Math.cos(a6);
      const dx = (D1 * Math.cos(a1) + c3 + c4) * env + c5 * SW_X + c6 * CH_X;
      const dz = (D2 * Math.cos(a2) + c3 - c4) * env + c5 * SW_Z + c6 * CH_Z;
      const inv = 1 / Math.sqrt(dx * dx + dz * dz + 1);
      nrm[j] = -dx * inv;
      nrm[j + 1] = inv;
      nrm[j + 2] = -dz * inv;
    }
    this._posAttr.needsUpdate = true;
    this._nrmAttr.needsUpdate = true;

    // --- Scrolling sparkle ---------------------------------------------------
    // The scroll meanders slightly instead of marching in a straight line, so
    // the caustic web never reads as a conveyor belt.
    const off = this.sparkleMap.offset;
    off.x = (elapsed * SCROLL_U + 0.012 * Math.sin(elapsed * 0.05)) % 1;
    off.y = (elapsed * SCROLL_V + 0.012 * Math.cos(elapsed * 0.041)) % 1;

    // --- Day / night tint, kissed by the sky ---------------------------------
    const sky = this.sky || (this.sky = this.ctx.systems.sky || null);
    const sun = sky && sky.getSunIntensity ? sky.getSunIntensity() : 1;
    const target = 1 - Math.max(0, Math.min(1, sun));
    // Ease toward the target so time-warps don't pop the water color.
    let night = this._nightFactor;
    if (night < 0) night = target;
    night += (target - night) * Math.min(1, dt * 2.5);
    this._nightFactor = night;

    // Daylight hue drifts dreamily between lagoon teal and clear azure over
    // ~2.5 min, then ramps toward deep night blue and finally bleeds a little
    // of the live fog/horizon color in — dawn turns the water rose-gold,
    // dusk ember, night indigo.
    const hueDrift = 0.5 + 0.5 * Math.sin(elapsed * 0.042);
    const col = this._tint.lerpColors(COLOR_DAY, COLOR_DAY_B, hueDrift);
    col.lerp(COLOR_NIGHT, night);
    const fog = this.ctx.scene.fog;
    if (fog && fog.color) col.lerp(fog.color, SKY_TINT);
    this.material.color.copy(col);

    // Night glow: moonlit teal shimmer with a slow ~7 s pulse, its color
    // kissed by the sky so aurora nights tint the sea.
    if (fog && fog.color) {
      this.material.emissive.copy(this._emissiveTint.copy(EMISSIVE_NIGHT).lerp(fog.color, 0.25));
    }
    this.material.emissiveIntensity = night * (0.38 + 0.07 * Math.sin(elapsed * 0.9));

    // Glassier surface after dark — moon and crystal glints sharpen.
    this.material.roughness = 0.15 - 0.07 * night;

    // Barely-there opacity breathing (0.73–0.77) keeps the surface dreamlike.
    this.material.opacity = 0.75 + 0.02 * Math.sin(elapsed * 0.23);
  }
}
