import * as THREE from 'three';

/**
 * Particles — pooled GPU-billboard particle engine for Magic World.
 *
 * Design:
 *  - One additive THREE.Points with a fixed pool of POOL_SIZE particles (≥ 2000 per contract).
 *  - Particle motion is computed ENTIRELY in the vertex shader from immutable per-particle
 *    attributes (origin, velocity, birth time, life, gravity). The CPU only writes attribute
 *    ranges at emission time — zero per-frame CPU particle work, zero per-frame allocations.
 *  - Per-particle fade: opacity ∝ (1 − age/life)², with a hot white core and a soft twinkle.
 *  - flash(): a small pool of 4 reusable PointLights that fade out linearly over duration.
 *
 * GRAVITY CONVENTION (binding, documented per contract):
 *  POSITIVE gravity = the particle FALLS DOWN with that acceleration (m/s²).
 *  NEGATIVE gravity = the particle drifts UP (embers, rising sparks).
 *  e.g. gravity: 8 → heavy dust dropping fast; gravity: -1 → fire motes floating upward.
 */

const POOL_SIZE = 2400;
const LIGHT_POOL_SIZE = 4;
const MAX_POINT_PX = 220.0;

/**
 * Palette presets (frozen) — the canonical particle recipes from the design spec.
 * Internal only (contract: this module exports EXACTLY the default class).
 */
const PRESETS = Object.freeze({
  fireballTrail: Object.freeze({ color: 0xff8833, count: 5, speed: 2.5, life: 0.45, size: 0.22, gravity: -1 }),
  fireballBoom: Object.freeze({ color: 0xffaa33, count: 60, speed: 9, life: 1.0, size: 0.45, gravity: 7 }),
  fireballBoomGold: Object.freeze({ color: 0xffd966, count: 30, speed: 5, life: 1.4, size: 0.3, gravity: 7 }),
  leafSparkle: Object.freeze({ color: 0x66ee77, count: 24, speed: 3.5, life: 1.1, size: 0.25, gravity: 2 }),
  leafSparklePink: Object.freeze({ color: 0xff9ad5, count: 12, speed: 3.5, life: 1.1, size: 0.25, gravity: 2 }),
  dust: Object.freeze({ color: 0x9c8f7a, count: 22, speed: 2.2, life: 0.9, size: 0.38, gravity: 8 }),
  blinkViolet: Object.freeze({ color: 0xaa66ff, count: 30, speed: 6, life: 0.7, size: 0.3, gravity: 0 }),
  portalSwirl: Object.freeze({ color: 0xc88bff, count: 4, speed: 1.2, life: 1.0, size: 0.2, gravity: -2 }),
  conjureGold: Object.freeze({ color: 0xffd966, count: 12, speed: 1.5, life: 1.3, size: 0.28, gravity: 6 }),
  orbPop: Object.freeze({ color: 0xfff2cc, count: 16, speed: 4, life: 0.6, size: 0.22, gravity: 3 }),
  teleportShimmer: Object.freeze({ color: 0x7fe7ff, count: 20, speed: 5, life: 0.6, size: 0.25, gravity: 0 }),
  teleportSparkle: Object.freeze({ color: 0xffffff, count: 10, speed: 7.5, life: 0.4, size: 0.18, gravity: -1.5 }),
  landingDust: Object.freeze({ color: 0xb8a98c, count: 10, speed: 2.5, life: 0.55, size: 0.3, gravity: 9 }),
  waterSplash: Object.freeze({ color: 0x6fd8e8, count: 16, speed: 3.2, life: 0.7, size: 0.28, gravity: 7 }),
});

const VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uScale;

  attribute vec3 aVelocity;
  attribute vec3 aColor;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;
  attribute float aGravity;

  varying vec3 vColor;
  varying float vFade;
  varying float vSeed;

  void main() {
    float t = uTime - aBirth;
    float live = step(0.0001, aLife) * step(0.0, t) * (1.0 - step(aLife, t));

    float k = clamp(t / max(aLife, 0.0001), 0.0, 1.0);
    float fade = 1.0 - k;
    vFade = fade * fade; // opacity ∝ (1 − age/life)² per spec
    vColor = aColor;
    vSeed = fract(aBirth * 0.731) * 6.2831 + aSize * 39.0;

    // gravity convention: positive = falls down
    vec3 pos = position + aVelocity * t;
    pos.y -= 0.5 * aGravity * t * t;

    // organic micro-drift: tiny pseudo-random horizontal curl (phase from birth
    // time + size) so sparks wander like embers instead of flying dead-straight
    float ph = aBirth * 13.7 + aSize * 51.0;
    pos.x += sin(t * 3.7 + ph) * 0.1 * t;
    pos.z += cos(t * 3.1 + ph * 1.3) * 0.1 * t;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    // grow-in pop over the first ~6% of life (no hard pop-in), then gently
    // shrink with age
    float grow = 0.45 + 0.55 * smoothstep(0.0, 0.06, k);
    float sizeWorld = aSize * grow * (0.65 + 0.35 * fade);
    float px = live * sizeWorld * uScale / max(-mv.z, 0.2);
    gl_PointSize = min(px, ${MAX_POINT_PX.toFixed(1)});
    gl_Position = projectionMatrix * mv;

    // park dead particles outside clip space (cheaper than CPU compaction)
    if (live < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  // NOTE: three prepends "precision highp float;" — do not redeclare mediump here,
  // sin(uTime * 17.0) needs highp once elapsed grows past a few minutes.
  uniform float uTime;

  varying vec3 vColor;
  varying float vFade;
  varying float vSeed;

  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = length(uv) * 2.0;
    if (d > 1.0) discard;

    float halo = smoothstep(1.0, 0.05, d);
    float core = smoothstep(0.45, 0.0, d);
    float twinkle = 0.86 + 0.14 * sin(uTime * 17.0 + vSeed);

    float a = vFade * twinkle * (halo * 0.7 + core * 0.9);
    if (a < 0.004) discard;

    // hot white-leaning core for that juicy magical sparkle
    vec3 col = vColor + vec3(0.85, 0.8, 0.7) * core * 0.6;
    gl_FragColor = vec4(col, a);

    // vColor is linear-working-space (THREE.Color.set converts hex); run the
    // r184 output pipeline so particles match the scene's ACES + sRGB grading.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export default class Particles {
  constructor(ctx) {
    this.ctx = ctx;

    this._elapsed = 0;
    this._cursor = 0; // ring-buffer write head into the pool

    // ---- geometry & attribute pool -------------------------------------
    const geometry = new THREE.BufferGeometry();
    this._origins = new Float32Array(POOL_SIZE * 3);
    this._velocities = new Float32Array(POOL_SIZE * 3);
    this._colors = new Float32Array(POOL_SIZE * 3);
    this._births = new Float32Array(POOL_SIZE);
    this._lives = new Float32Array(POOL_SIZE); // 0 = dead slot
    this._sizes = new Float32Array(POOL_SIZE);
    this._gravities = new Float32Array(POOL_SIZE);
    this._births.fill(-1e9);

    this._attrOrigin = new THREE.BufferAttribute(this._origins, 3);
    this._attrVelocity = new THREE.BufferAttribute(this._velocities, 3);
    this._attrColor = new THREE.BufferAttribute(this._colors, 3);
    this._attrBirth = new THREE.BufferAttribute(this._births, 1);
    this._attrLife = new THREE.BufferAttribute(this._lives, 1);
    this._attrSize = new THREE.BufferAttribute(this._sizes, 1);
    this._attrGravity = new THREE.BufferAttribute(this._gravities, 1);

    this._attrOrigin.setUsage(THREE.DynamicDrawUsage);
    this._attrVelocity.setUsage(THREE.DynamicDrawUsage);
    this._attrColor.setUsage(THREE.DynamicDrawUsage);
    this._attrBirth.setUsage(THREE.DynamicDrawUsage);
    this._attrLife.setUsage(THREE.DynamicDrawUsage);
    this._attrSize.setUsage(THREE.DynamicDrawUsage);
    this._attrGravity.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('position', this._attrOrigin);
    geometry.setAttribute('aVelocity', this._attrVelocity);
    geometry.setAttribute('aColor', this._attrColor);
    geometry.setAttribute('aBirth', this._attrBirth);
    geometry.setAttribute('aLife', this._attrLife);
    geometry.setAttribute('aSize', this._attrSize);
    geometry.setAttribute('aGravity', this._attrGravity);
    // generous static bounds — positions are GPU-computed, so skip real culling math
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 20, 0), 4000);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uScale: { value: 600 },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10; // draw after opaques & water for clean additive glow
    ctx.scene.add(this.points);

    // ---- pooled flash lights -------------------------------------------
    this._lights = [];
    for (let i = 0; i < LIGHT_POOL_SIZE; i++) {
      const light = new THREE.PointLight(0xffffff, 0, 14, 2);
      light.visible = false;
      ctx.scene.add(light);
      this._lights.push({
        light,
        age: 0,
        duration: 0,
        base: 0,
        active: false,
        startedAt: -1,
      });
    }

    // ---- scratch (no per-frame / per-call allocations) ------------------
    this._scratchColor = new THREE.Color();
    this._scratchDir = new THREE.Vector3();

    // Reusable teleport burst payloads — `position` is patched per event so
    // frequent Blink/Portal hops never allocate options objects.
    const tp = PRESETS.teleportShimmer;
    const ts = PRESETS.teleportSparkle;
    this._tpShimmer = {
      position: null, color: tp.color, count: tp.count, speed: tp.speed,
      life: tp.life, size: tp.size, gravity: tp.gravity, spread: 1.6, ring: 0.65,
    };
    this._tpSparkle = {
      position: null, color: ts.color, count: ts.count, speed: ts.speed,
      life: ts.life, size: ts.size, gravity: ts.gravity, spread: 0.5, ring: 0,
    };
    // arrival-only rising ember column — lingers a beat after the pop so the
    // destination keeps glowing while the camera settles
    this._tpRise = {
      position: null, color: 0xbfa3ff, count: 9, speed: 1.6,
      life: 1.1, size: 0.2, gravity: -2.5, spread: 0.9, ring: 0.35,
    };

    // ---- events ----------------------------------------------------------
    ctx.events.on('player:teleport', (payload) => this._onTeleport(payload));
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Radial burst of sparks from a point.
   * GRAVITY: positive = falls down (m/s²), negative = rises. See header.
   * `spread` widens the spawn shell & directional chaos (1 = tight point burst).
   * `ring` (0..1, optional) flattens the sphere toward a horizontal disc:
   *   0 = full sphere (default), ~0.7 = pancake ring (landing dust, splashes).
   */
  burst({
    position,
    color = 0xffaa33,
    count = 30,
    speed = 6,
    life = 1,
    size = 0.35,
    gravity = -4,
    spread = 1,
    ring = 0,
  } = {}) {
    if (!position) return;
    const col = this._scratchColor.set(color);
    const px = position.x, py = position.y, pz = position.z;

    const n = Math.min(count | 0, POOL_SIZE);
    const start = this._cursor;
    for (let i = 0; i < n; i++) {
      const slot = (start + i) % POOL_SIZE;

      // random direction on the unit sphere (no allocation)
      const theta = Math.random() * Math.PI * 2;
      const cosPhi = Math.random() * 2 - 1;
      const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi));
      let dx = sinPhi * Math.cos(theta);
      let dy = cosPhi;
      let dz = sinPhi * Math.sin(theta);

      if (ring > 0) {
        // squash vertical component → directions hug the XZ plane (disc/ring)
        dy *= 1 - ring;
        const inv = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
        dx *= inv; dy *= inv; dz *= inv;
      }

      const shell = Math.random() * 0.22 * spread;
      const v = speed * (0.45 + 0.55 * Math.random());

      this._writeParticle(
        slot,
        px + dx * shell, py + dy * shell, pz + dz * shell,
        dx * v, dy * v + speed * 0.12, dz * v, // slight upward kiss for juice
        col,
        life * (0.7 + 0.45 * Math.random()),
        size * (0.7 + 0.6 * Math.random()),
        gravity * (0.8 + 0.4 * Math.random()), // weight variance → arcs splay apart
        i, // every ~5th particle goes hot-white for sparkle variance
      );
    }
    this._cursor = (start + n) % POOL_SIZE;
    this._markDirty(start, n);
  }

  /**
   * Small directional puff — used for trails (fireball, wisps, portals).
   * Same gravity convention as burst (positive = falls).
   */
  stream({
    position,
    direction,
    color = 0xffffff,
    count = 6,
    speed = 3,
    life = 0.6,
    size = 0.25,
    gravity = 0,
  } = {}) {
    if (!position) return;
    const col = this._scratchColor.set(color);
    const dir = this._scratchDir;
    if (direction) {
      dir.set(direction.x, direction.y, direction.z);
      if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0);
      dir.normalize();
    } else {
      dir.set(0, 1, 0);
    }
    const px = position.x, py = position.y, pz = position.z;

    const n = Math.min(count | 0, POOL_SIZE);
    const start = this._cursor;
    for (let i = 0; i < n; i++) {
      const slot = (start + i) % POOL_SIZE;

      // jitter around the cone axis
      const jx = (Math.random() - 0.5) * 0.55;
      const jy = (Math.random() - 0.5) * 0.55;
      const jz = (Math.random() - 0.5) * 0.55;
      const v = speed * (0.6 + 0.4 * Math.random());

      this._writeParticle(
        slot,
        px + (Math.random() - 0.5) * 0.12,
        py + (Math.random() - 0.5) * 0.12,
        pz + (Math.random() - 0.5) * 0.12,
        (dir.x + jx) * v, (dir.y + jy) * v, (dir.z + jz) * v,
        col,
        life * (0.75 + 0.4 * Math.random()),
        size * (0.75 + 0.5 * Math.random()),
        gravity * (0.8 + 0.4 * Math.random()),
        i + 2,
      );
    }
    this._cursor = (start + n) % POOL_SIZE;
    this._markDirty(start, n);
  }

  /**
   * Temporary PointLight from a pool of 4 (reuses the oldest when full).
   * Intensity fades linearly to zero over `duration` seconds.
   */
  flash(position, color = 0xffffff, intensity = 4, duration = 0.25) {
    if (!position) return;

    let pick = null;
    let oldest = null;
    for (let i = 0; i < this._lights.length; i++) {
      const f = this._lights[i];
      if (!f.active) { pick = f; break; }
      if (oldest === null || f.startedAt < oldest.startedAt) oldest = f;
    }
    if (!pick) pick = oldest;

    pick.active = true;
    pick.age = 0;
    pick.duration = Math.max(duration, 0.016);
    pick.base = intensity;
    pick.startedAt = this._elapsed;
    pick.light.color.set(color);
    pick.light.position.set(position.x, position.y, position.z);
    pick.light.intensity = intensity;
    pick.light.visible = true;
  }

  update(dt, elapsed) {
    this._elapsed = elapsed;
    this.material.uniforms.uTime.value = elapsed;

    // perspective-correct point sizing: px = worldSize * uScale / depth
    const h = this.ctx.renderer.domElement.height;
    const fovRad = this.ctx.camera.fov * 0.017453292519943295;
    this.material.uniforms.uScale.value = h / (2 * Math.tan(fovRad * 0.5));

    // fade pooled flash lights (linear per spec)
    for (let i = 0; i < this._lights.length; i++) {
      const f = this._lights[i];
      if (!f.active) continue;
      f.age += dt;
      if (f.age >= f.duration) {
        f.active = false;
        f.light.visible = false;
        f.light.intensity = 0;
      } else {
        f.light.intensity = f.base * (1 - f.age / f.duration);
      }
    }
  }

  // =========================================================================
  // Internals
  // =========================================================================

  _onTeleport(payload) {
    if (!payload) return;
    if (payload.from) {
      // departure: cyan ring halo + tight white sparkle core + dim flash
      this._tpShimmer.position = payload.from;
      this._tpSparkle.position = payload.from;
      this.burst(this._tpShimmer);
      this.burst(this._tpSparkle);
      this.flash(payload.from, 0x7fe7ff, 1.6, 0.2);
    }
    if (payload.to) {
      // arrival: same two-layer pop + a lingering violet ember rise, brighter flash
      this._tpShimmer.position = payload.to;
      this._tpSparkle.position = payload.to;
      this._tpRise.position = payload.to;
      this.burst(this._tpShimmer);
      this.burst(this._tpSparkle);
      this.burst(this._tpRise);
      this.flash(payload.to, 0x7fe7ff, 3, 0.3);
    }
    this._tpShimmer.position = null; // don't pin Vector3s past the event
    this._tpSparkle.position = null;
    this._tpRise.position = null;
  }

  /** Write one particle into the pool slot. `sparkleIdx % 5 === 0` → white-hot tint. */
  _writeParticle(slot, ox, oy, oz, vx, vy, vz, col, life, size, gravity, sparkleIdx) {
    const i3 = slot * 3;
    this._origins[i3] = ox;
    this._origins[i3 + 1] = oy;
    this._origins[i3 + 2] = oz;
    this._velocities[i3] = vx;
    this._velocities[i3 + 1] = vy;
    this._velocities[i3 + 2] = vz;

    if (sparkleIdx % 5 === 0) {
      // bright near-white sparkle variant
      this._colors[i3] = col.r * 0.35 + 0.65;
      this._colors[i3 + 1] = col.g * 0.35 + 0.65;
      this._colors[i3 + 2] = col.b * 0.35 + 0.65;
    } else {
      const tone = 0.8 + 0.2 * Math.random();
      this._colors[i3] = col.r * tone;
      this._colors[i3 + 1] = col.g * tone;
      this._colors[i3 + 2] = col.b * tone;
    }

    this._births[slot] = this._elapsed;
    this._lives[slot] = life;
    this._sizes[slot] = size;
    this._gravities[slot] = gravity;
  }

  /**
   * Flag the freshly written ring range for partial GPU upload.
   * three r184's WebGLAttributes applies update ranges with bufferSubData and
   * clears them after upload, so accumulating per-emission ranges is safe.
   */
  _markDirty(start, count) {
    if (count <= 0) return;
    if (start + count <= POOL_SIZE) {
      this._addRange(start, count);
    } else {
      const first = POOL_SIZE - start;
      this._addRange(start, first);
      this._addRange(0, count - first);
    }
  }

  _addRange(start, count) {
    this._attrOrigin.addUpdateRange(start * 3, count * 3);
    this._attrVelocity.addUpdateRange(start * 3, count * 3);
    this._attrColor.addUpdateRange(start * 3, count * 3);
    this._attrBirth.addUpdateRange(start, count);
    this._attrLife.addUpdateRange(start, count);
    this._attrSize.addUpdateRange(start, count);
    this._attrGravity.addUpdateRange(start, count);
    this._attrOrigin.needsUpdate = true;
    this._attrVelocity.needsUpdate = true;
    this._attrColor.needsUpdate = true;
    this._attrBirth.needsUpdate = true;
    this._attrLife.needsUpdate = true;
    this._attrSize.needsUpdate = true;
    this._attrGravity.needsUpdate = true;
  }
}
