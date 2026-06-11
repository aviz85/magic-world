import * as THREE from 'three';

/**
 * Fireflies — ~380 additive glowing motes drifting above the terrain in a
 * band around the player. One single THREE.Points draw call.
 *
 * - Soft round sprite: 32px canvas radial gradient #ffe9a8 → transparent.
 * - Per-particle sin-drift (phase offsets), amplitude ≈ 1.2, hover 0.5–4
 *   above terrain (never below the water surface).
 * - The band (radius 40) recenters on the player every 4 s: motes that fell
 *   too far behind are respawned ahead and fade back in, so the swarm
 *   follows the player without visible pops.
 * - Brightness: material opacity lerps 0.25 (day) ↔ 0.9 (night) over ~3 s
 *   driven by ctx.systems.sky.getSunIntensity(); per-particle twinkle lives
 *   in the vertex color attribute so it costs nothing extra.
 *
 * No per-frame allocations: all particle state lives in preallocated typed
 * arrays, player lookup reuses a scratch Vector3.
 */

const COUNT = 380;
const BAND_RADIUS = 40; // recenter band around the player
const INNER_RADIUS = 4; // don't spawn right inside the camera
const RECENTER_INTERVAL = 4; // seconds
const RESAMPLE_PER_FRAME = 16; // round-robin terrain re-sampling budget
const DAY_OPACITY = 0.18;
const NIGHT_OPACITY = 0.95;
const OPACITY_TAU = 1.0; // exp time constant → ~3 s to settle
const FADE_IN_TIME = 1.4; // seconds for a respawned mote to reappear

export default class Fireflies {
  constructor(ctx) {
    this.ctx = ctx;

    const cfg = ctx.config;
    this.waterLevel = cfg.waterLevel;
    this.halfWorld = cfg.worldSize / 2 - 2;

    // ---- per-particle state (flat typed arrays, allocated once) ----
    this.baseX = new Float32Array(COUNT); // anchor position (wanders w/ wind)
    this.baseZ = new Float32Array(COUNT);
    this.groundY = new Float32Array(COUNT); // cached terrain height at anchor
    this.hover = new Float32Array(COUNT); // base hover height above ground
    this.ampX = new Float32Array(COUNT); // sin-drift amplitudes
    this.ampY = new Float32Array(COUNT);
    this.ampZ = new Float32Array(COUNT);
    this.phaseX = new Float32Array(COUNT);
    this.phaseY = new Float32Array(COUNT);
    this.phaseZ = new Float32Array(COUNT);
    this.freqX = new Float32Array(COUNT);
    this.freqY = new Float32Array(COUNT);
    this.freqZ = new Float32Array(COUNT);
    this.windX = new Float32Array(COUNT); // slow individual wander velocity
    this.windZ = new Float32Array(COUNT);
    this.twinklePhase = new Float32Array(COUNT);
    this.twinkleFreq = new Float32Array(COUNT);
    this.fade = new Float32Array(COUNT); // 0→1 after a respawn
    this.bright = new Float32Array(COUNT); // per-mote brightness (a few beacons flare)
    this.tintR = new Float32Array(COUNT); // per-mote color (mostly warm gold,
    this.tintG = new Float32Array(COUNT); // cyan / violet / spring-green accents)
    this.tintB = new Float32Array(COUNT);

    // ---- geometry + material ----
    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(positions, 3);
    this.colAttr = new THREE.BufferAttribute(colors, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.posAttr);
    geometry.setAttribute('color', this.colAttr);

    this.material = new THREE.PointsMaterial({
      size: 0.35,
      map: this._makeSprite(),
      transparent: true,
      opacity: DAY_OPACITY,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.frustumCulled = false; // band always hugs the camera
    this.points.renderOrder = 5; // draw after opaque world + water
    ctx.scene.add(this.points);

    // ---- runtime scratch / timers ----
    this._playerPos = new THREE.Vector3();
    this._recenterTimer = RECENTER_INTERVAL * Math.random();
    this._resampleCursor = 0;
    this._opacity = DAY_OPACITY;

    // initial scatter around spawn (player starts near origin)
    for (let i = 0; i < COUNT; i++) {
      this._initParticle(i);
      this._respawn(i, 0, 8, true);
    }
    this._writePositions(0);
  }

  // ----------------------------------------------------------------------

  _makeSprite() {
    const size = 32;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    const grad = g.createRadialGradient(
      size / 2, size / 2, 0,
      size / 2, size / 2, size / 2
    );
    grad.addColorStop(0.0, 'rgba(255, 233, 168, 1.0)');
    grad.addColorStop(0.25, 'rgba(255, 226, 150, 0.85)');
    grad.addColorStop(0.55, 'rgba(255, 210, 120, 0.32)');
    grad.addColorStop(1.0, 'rgba(255, 200, 100, 0.0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  /** One-time randomization of motion personality + tint for particle i. */
  _initParticle(i) {
    this.ampX[i] = 0.7 + Math.random() * 0.5; // ≈ 1.2 average amplitude
    this.ampZ[i] = 0.7 + Math.random() * 0.5;
    this.ampY[i] = 0.35 + Math.random() * 0.45;
    this.phaseX[i] = Math.random() * Math.PI * 2;
    this.phaseY[i] = Math.random() * Math.PI * 2;
    this.phaseZ[i] = Math.random() * Math.PI * 2;
    this.freqX[i] = 0.45 + Math.random() * 0.3; // around the 0.6 design value
    this.freqY[i] = 0.5 + Math.random() * 0.4;
    this.freqZ[i] = 0.45 + Math.random() * 0.3;
    this.windX[i] = (Math.random() - 0.5) * 0.3;
    this.windZ[i] = (Math.random() - 0.5) * 0.3;
    this.twinklePhase[i] = Math.random() * Math.PI * 2;
    this.twinkleFreq[i] = 1.6 + Math.random() * 2.6;
    // ~8% are beacons — slower, brighter pulses that anchor the swarm.
    if (Math.random() < 0.08) {
      this.bright[i] = 1.6;
      this.twinkleFreq[i] = 0.7 + Math.random() * 0.8;
    } else {
      this.bright[i] = 0.8 + Math.random() * 0.35;
    }

    // tint: 72% warm gold, 14% fey cyan, 8% violet-pink, 6% spring green
    const r = Math.random();
    if (r < 0.72) {
      this.tintR[i] = 1.0; this.tintG[i] = 0.92; this.tintB[i] = 0.62;
    } else if (r < 0.86) {
      this.tintR[i] = 0.55; this.tintG[i] = 1.0; this.tintB[i] = 0.95;
    } else if (r < 0.94) {
      this.tintR[i] = 0.85; this.tintG[i] = 0.55; this.tintB[i] = 1.0;
    } else {
      this.tintR[i] = 0.68; this.tintG[i] = 1.0; this.tintB[i] = 0.58;
    }
  }

  /** Terrain height under (x, z), floored at the water surface. */
  _groundAt(x, z) {
    const terrain = this.ctx.systems.terrain;
    let h = terrain ? terrain.getHeight(x, z) : 0;
    if (h < -50) h = this.waterLevel; // -100 sentinel = outside bounds
    return Math.max(h, this.waterLevel);
  }

  /** Place particle i somewhere in the annulus around (cx, cz). */
  _respawn(i, cx, cz, immediate) {
    const ang = Math.random() * Math.PI * 2;
    // sqrt for uniform area distribution inside the band
    const rad = INNER_RADIUS +
      (BAND_RADIUS - INNER_RADIUS - 2) * Math.sqrt(Math.random());
    let x = cx + Math.cos(ang) * rad;
    let z = cz + Math.sin(ang) * rad;
    const lim = this.halfWorld;
    if (x > lim) x = lim; else if (x < -lim) x = -lim;
    if (z > lim) z = lim; else if (z < -lim) z = -lim;
    this.baseX[i] = x;
    this.baseZ[i] = z;
    this.groundY[i] = this._groundAt(x, z);
    this.hover[i] = 1.0 + Math.random() * 2.2; // keeps 0.5–4 with ±ampY sway
    this.fade[i] = immediate ? 0.3 + Math.random() * 0.7 : 0;
  }

  /** Write current positions + colors for all particles at time t. */
  _writePositions(t) {
    const pos = this.posAttr.array;
    const col = this.colAttr.array;
    for (let i = 0; i < COUNT; i++) {
      const j = i * 3;
      const y = this.groundY[i] + this.hover[i] +
        this.ampY[i] * Math.sin(t * this.freqY[i] + this.phaseY[i]);
      pos[j] = this.baseX[i] +
        this.ampX[i] * Math.sin(t * this.freqX[i] + this.phaseX[i]);
      pos[j + 1] = Math.max(y, this.groundY[i] + 0.5);
      pos[j + 2] = this.baseZ[i] +
        this.ampZ[i] * Math.sin(t * this.freqZ[i] + this.phaseZ[i]);

      // twinkle: soft asymmetric pulse, squared so peaks sparkle
      let tw = 0.62 + 0.38 * Math.sin(t * this.twinkleFreq[i] + this.twinklePhase[i]);
      tw *= tw;
      const b = tw * this.fade[i] * this.bright[i];
      col[j] = this.tintR[i] * b;
      col[j + 1] = this.tintG[i] * b;
      col[j + 2] = this.tintB[i] * b;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
  }

  // ----------------------------------------------------------------------

  update(dt, elapsed) {
    const systems = this.ctx.systems;

    // --- follow target: player feet if available, else camera ---
    const player = systems.player;
    if (player && player.position) {
      this._playerPos.copy(player.position);
    } else {
      this._playerPos.copy(this.ctx.camera.position);
    }
    const px = this._playerPos.x;
    const pz = this._playerPos.z;

    // --- slow individual wander + fade-in after respawn ---
    const fadeStep = dt / FADE_IN_TIME;
    const lim = this.halfWorld;
    for (let i = 0; i < COUNT; i++) {
      let x = this.baseX[i] + this.windX[i] * dt;
      let z = this.baseZ[i] + this.windZ[i] * dt;
      if (x > lim) x = lim; else if (x < -lim) x = -lim;
      if (z > lim) z = lim; else if (z < -lim) z = -lim;
      this.baseX[i] = x;
      this.baseZ[i] = z;
      let f = this.fade[i] + fadeStep;
      this.fade[i] = f > 1 ? 1 : f;
    }

    // --- round-robin terrain re-sampling (wander + terrain.modify safe) ---
    const terrain = systems.terrain;
    if (terrain) {
      let cursor = this._resampleCursor;
      for (let n = 0; n < RESAMPLE_PER_FRAME; n++) {
        const i = cursor;
        const target = this._groundAt(this.baseX[i], this.baseZ[i]);
        // ease toward the new ground height so cliff edges don't snap
        this.groundY[i] += (target - this.groundY[i]) * 0.5;
        cursor = (cursor + 1) % COUNT;
      }
      this._resampleCursor = cursor;
    }

    // --- recenter the band around the player every few seconds ---
    this._recenterTimer -= dt;
    if (this._recenterTimer <= 0) {
      this._recenterTimer = RECENTER_INTERVAL;
      const r2 = BAND_RADIUS * BAND_RADIUS;
      for (let i = 0; i < COUNT; i++) {
        const dx = this.baseX[i] - px;
        const dz = this.baseZ[i] - pz;
        if (dx * dx + dz * dz > r2) this._respawn(i, px, pz, false);
      }
    }

    // --- day/night brightness (0.25 day → 0.9 night, ~3 s settle) ---
    const sky = systems.sky;
    const sun = sky && sky.getSunIntensity ? sky.getSunIntensity() : 1;
    const night = 1 - Math.min(Math.max(sun, 0), 1);
    const targetOpacity = DAY_OPACITY + (NIGHT_OPACITY - DAY_OPACITY) * night;
    const k = 1 - Math.exp(-dt / OPACITY_TAU);
    this._opacity += (targetOpacity - this._opacity) * k;
    this.material.opacity = this._opacity;
    // a touch larger at night so the glow reads from farther away
    this.material.size = 0.32 + 0.16 * night;

    this._writePositions(elapsed);
  }
}
