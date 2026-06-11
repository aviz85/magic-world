import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm } from './Noise.js';
import { canvasTexture, makeTreeMesh, makeCrystalMesh, makeRockMesh } from '../core/AssetFactory.js';

/**
 * FloatingIslands — 7 bobbing, slowly drifting sky islands.
 *
 * Per docs/design/world.md:
 * - Fixed placements (all ≥ 30 from the spawn column at the origin).
 * - Each island: flattened icosahedral grass cap (vertex-colored grass core,
 *   sandy rim) over an inverted jagged rock cone, plus 2 hanging rock chunks.
 * - Islands 0,1,3,5 → 2 trees (one natural, one magical).
 *   Islands 2,4,6 → 1 cyan crystal cluster.
 * - Islands 1 and 5 → 60-point particle waterfall falling 20 units, recycled.
 * - Bob ±1.5 with per-island period 9–14 s (phase = index × 0.9),
 *   drift rotation 0.02 rad/s, plus a very slow positional sway and tilt.
 *
 * Geometry is merged per island (one draw call per island body, single shared
 * vertex-colored material). update() performs zero allocations.
 */

const ISLAND_DEFS = [
  { x: 62, z: -48, y: 44, r: 9 },
  { x: -74, z: 35, y: 52, r: 11 },
  { x: 28, z: 86, y: 38, r: 7 },
  { x: -45, z: -88, y: 60, r: 8 },
  { x: 95, z: 22, y: 48, r: 6 },
  { x: -15, z: 60, y: 66, r: 10 },
  { x: 70, z: 70, y: 56, r: 7 },
];

const TREE_ISLANDS = new Set([0, 1, 3, 5]);
const CRYSTAL_ISLANDS = new Set([2, 4, 6]);
const WATERFALL_ISLANDS = new Set([1, 5]);

const TOP_FLATTEN = 0.38; // dome y-scale: flattened icosphere cap
const WATERFALL_DROP = 20;
const WATERFALL_COUNT = 60;
const BOB_AMP = 1.5;
const SPIN_SPEED = 0.02; // rad/s

// --- color palette (design doc) ---
const COL_GRASS = new THREE.Color('#5dbb63');
const COL_GRASS_DEEP = new THREE.Color('#3e9a52');
const COL_SAND = new THREE.Color('#e8d49a');
const COL_ROCK = new THREE.Color('#6f6a7d');
const COL_ROCK_DARK = new THREE.Color('#4d4859');

export default class FloatingIslands {
  constructor(ctx) {
    this.ctx = ctx;
    this.noise = createNoise2D(8181);

    this.root = new THREE.Group();
    this.root.name = 'floating-islands';
    ctx.scene.add(this.root);

    // One shared material for every island body — vertex colors do the work.
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true,
      flatShading: true,
      roughness: 0.95,
      metalness: 0.0,
    });

    this.waterfallMaterial = new THREE.PointsMaterial({
      color: 0x9fdcff,
      size: 0.55,
      map: this._makeDropletTexture(),
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    // Shared glow sprites — one soft radial texture, three tinted materials.
    // All sprites per material animate together (single opacity write/frame).
    const glowTex = this._makeGlowSpriteTexture();
    this.underGlowMaterial = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0x7fc8ff, // anti-gravity shimmer under each island
      transparent: true,
      opacity: 0.12,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.crystalGlowMaterial = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0x8ff0ff, // crystal aura, blooms at night
      transparent: true,
      opacity: 0.15,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mistMaterial = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xcfeaff, // spray haze where the waterfall dissolves
      transparent: true,
      opacity: 0.2,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // Fairy motes — tiny glints lazily orbiting each island. Two shared
    // materials (gold / cyan) so the whole flock fades with one write each.
    this.moteGoldMaterial = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffe2a0,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.moteCyanMaterial = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0x9af2ff,
      transparent: true,
      opacity: 0.3,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    /** @type {Array<object>} per-island animation records */
    this.islands = [];
    /** @type {Array<object>} waterfall particle records */
    this.waterfalls = [];

    for (let i = 0; i < ISLAND_DEFS.length; i++) {
      this._buildIsland(i, ISLAND_DEFS[i]);
    }
  }

  // ------------------------------------------------------------------ build

  _buildIsland(index, def) {
    const seed = 9090 + index * 131;
    const rng = mulberry32(seed);

    const group = new THREE.Group();
    group.position.set(def.x, def.y, def.z);
    this.root.add(group);

    // Body: grass cap + inverted rock cone merged into a single mesh.
    const body = new THREE.Mesh(this._buildIslandGeometry(def.r, seed), this.bodyMaterial);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    // Two jagged rock chunks clinging to the underside.
    const depth = def.r * 1.2;
    for (let k = 0; k < 2; k++) {
      const rock = makeRockMesh({ scale: 0.7 + def.r * 0.12 + rng() * 0.5, seed: seed + 31 + k * 7 });
      const a = rng() * Math.PI * 2;
      const rad = def.r * (0.3 + rng() * 0.3);
      rock.position.set(
        Math.cos(a) * rad,
        -depth * (0.25 + rng() * 0.4),
        Math.sin(a) * rad
      );
      rock.rotation.set(rng() * Math.PI, rng() * Math.PI, rng() * Math.PI);
      group.add(rock);
    }

    // Soft anti-gravity glow hugging the rocky keel — reads strongest at
    // night, when the islands look like lanterns hanging in the dark.
    const underGlow = new THREE.Sprite(this.underGlowMaterial);
    underGlow.position.y = -depth * 0.85;
    underGlow.scale.set(def.r * 2.4, def.r * 1.7, 1);
    group.add(underGlow);

    // Decor on the grass cap.
    if (TREE_ISLANDS.has(index)) {
      for (let k = 0; k < 2; k++) {
        const a = rng() * Math.PI * 2;
        const rad = def.r * (0.2 + rng() * 0.35);
        const tree = makeTreeMesh({
          scale: 0.75 + rng() * 0.5,
          magical: k === 1, // 50% magical per design doc
          seed: seed + 53 + k * 17,
        });
        tree.position.set(
          Math.cos(a) * rad,
          this._domeHeight(def.r, rad) - 0.22,
          Math.sin(a) * rad
        );
        tree.rotation.y = rng() * Math.PI * 2;
        group.add(tree);
      }
    }
    if (CRYSTAL_ISLANDS.has(index)) {
      const a = rng() * Math.PI * 2;
      const rad = def.r * (0.1 + rng() * 0.25);
      const crystal = makeCrystalMesh({
        color: 0x7fe7ff,
        scale: 0.85 + rng() * 0.45,
        seed: seed + 97,
      });
      crystal.position.set(
        Math.cos(a) * rad,
        this._domeHeight(def.r, rad) - 0.15,
        Math.sin(a) * rad
      );
      crystal.rotation.y = rng() * Math.PI * 2;
      group.add(crystal);

      // Crystal aura — a breathing halo that blooms after dark.
      const aura = new THREE.Sprite(this.crystalGlowMaterial);
      aura.position.copy(crystal.position);
      aura.position.y += 1.2;
      const as = 2.6 + rng() * 1.2;
      aura.scale.set(as, as, 1);
      group.add(aura);
    }

    if (WATERFALL_ISLANDS.has(index)) {
      this._buildWaterfall(group, def, rng);
    }

    // Three fairy motes per island — slow elliptical orbits around the rim.
    const motes = [];
    for (let k = 0; k < 3; k++) {
      const sprite = new THREE.Sprite((index + k) % 3 === 0 ? this.moteGoldMaterial : this.moteCyanMaterial);
      const sc = 0.5 + rng() * 0.45;
      sprite.scale.set(sc, sc, 1);
      group.add(sprite);
      motes.push({
        sprite,
        radius: def.r * (1.15 + rng() * 0.5),
        speed: (0.16 + rng() * 0.22) * (rng() < 0.5 ? 1 : -1),
        phase: rng() * Math.PI * 2,
        height: 0.6 + rng() * 2.4,
        bobAmp: 0.5 + rng() * 0.8,
        bobW: 0.45 + rng() * 0.8,
      });
    }

    // Animation record — everything update() needs, precomputed.
    this.islands.push({
      motes,
      group,
      baseX: def.x,
      baseY: def.y,
      baseZ: def.z,
      bobW: (Math.PI * 2) / (9 + index * 0.8), // period 9–13.8 s
      phase: index * 0.9,
      spin: SPIN_SPEED * (index % 2 === 0 ? 1 : -1),
      driftW: (Math.PI * 2) / (38 + index * 6),
      driftAmp: 1.2 + (index % 3) * 0.5,
      driftPhase: rng() * Math.PI * 2,
      tiltPhase: rng() * Math.PI * 2,
      tiltW: 0.07 + rng() * 0.07, // per-island tilt rhythm
    });
  }

  /**
   * Grass cap (flattened, noise-roughened hemisphere) + inverted jagged cone,
   * merged into one non-indexed vertex-colored BufferGeometry.
   */
  _buildIslandGeometry(R, seed) {
    const ox = seed * 0.137; // deterministic per-island noise offset
    const oz = seed * -0.073;
    const scratch = new THREE.Color();

    // ---- top cap ----
    const cap = new THREE.SphereGeometry(R, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    {
      const pos = cap.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        // Position-based noise keeps seam vertices welded.
        const n = fbm(this.noise, x + ox, z + oz, { octaves: 3, scale: 0.32 });
        const f = 1 + 0.2 * n;
        pos.setXYZ(i, x * f, y * TOP_FLATTEN * (1 + 0.1 * n), z * f);

        // Color: sandy rim at the equator → lush grass toward the crown.
        const t = y / R; // 0 at rim, 1 at pole (pre-flatten y)
        if (t < 0.3) {
          scratch.copy(COL_SAND).lerp(COL_GRASS, smoothstep(t, 0.06, 0.3));
        } else {
          scratch.copy(COL_GRASS).lerp(COL_GRASS_DEEP, 0.5 + 0.5 * n);
        }
        colors[i * 3] = scratch.r;
        colors[i * 3 + 1] = scratch.g;
        colors[i * 3 + 2] = scratch.b;
      }
      cap.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    // ---- rocky underside: inverted open cone, tucked under the rim ----
    const depth = R * 1.2;
    const cone = new THREE.ConeGeometry(R * 1.04, depth, 12, 4, true);
    cone.rotateX(Math.PI);                  // tip down
    cone.translate(0, 0.4 - depth / 2, 0);  // base ring at y=0.4 (inside the cap)
    {
      const pos = cone.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = pos.getY(i);
        const z = pos.getZ(i);
        const depthT = THREE.MathUtils.clamp(-y / depth, 0, 1); // 0 rim → 1 tip
        const n = fbm(this.noise, x * 1.4 + ox + 300, z * 1.4 + oz - 300, { octaves: 3, scale: 0.45 });
        const f = 1 + 0.28 * n * (0.35 + 0.65 * depthT);
        pos.setXYZ(i, x * f, y * (1 + 0.12 * n * depthT), z * f);

        scratch.copy(COL_ROCK).lerp(COL_ROCK_DARK, depthT * 0.8 + 0.15 * n);
        colors[i * 3] = scratch.r;
        colors[i * 3 + 1] = scratch.g;
        colors[i * 3 + 2] = scratch.b;
      }
      cone.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }

    const merged = mergeNonIndexed([cap, cone]);
    cap.dispose();
    cone.dispose();
    merged.computeVertexNormals();
    return merged;
  }

  /** Approximate local-space top-surface height at distance `rad` from center. */
  _domeHeight(R, rad) {
    const r = Math.min(rad, R * 0.98);
    return TOP_FLATTEN * Math.sqrt(Math.max(R * R - r * r, 0));
  }

  _buildWaterfall(group, def, rng) {
    const a = rng() * Math.PI * 2;
    const rimR = def.r * 0.88;

    const positions = new Float32Array(WATERFALL_COUNT * 3);
    const speeds = new Float32Array(WATERFALL_COUNT);
    const baseX = new Float32Array(WATERFALL_COUNT); // stream jitter at the lip
    const baseZ = new Float32Array(WATERFALL_COUNT);
    const swayPhase = new Float32Array(WATERFALL_COUNT);
    for (let i = 0; i < WATERFALL_COUNT; i++) {
      baseX[i] = (rng() - 0.5) * 1.1;                 // x jitter — narrow stream
      baseZ[i] = (rng() - 0.5) * 1.1;
      swayPhase[i] = rng() * Math.PI * 2;
      positions[i * 3] = baseX[i];
      positions[i * 3 + 1] = -rng() * WATERFALL_DROP; // staggered along the drop
      positions[i * 3 + 2] = baseZ[i];
      speeds[i] = 4 + rng() * 3.5;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, this.waterfallMaterial);
    points.position.set(
      Math.cos(a) * rimR,
      this._domeHeight(def.r, rimR) * 0.5,
      Math.sin(a) * rimR
    );
    points.frustumCulled = false; // positions animate past the static bounds
    group.add(points);

    // Spray haze where the stream dissolves into the wind.
    const mist = new THREE.Sprite(this.mistMaterial);
    mist.position.y = -WATERFALL_DROP + 0.6;
    mist.scale.set(3.4, 2.2, 1);
    points.add(mist);

    this.waterfalls.push({
      positions,
      speeds,
      baseX,
      baseZ,
      swayPhase,
      mist,
      mistPhase: rng() * Math.PI * 2,
      attr: geometry.attributes.position,
    });
  }

  _makeDropletTexture() {
    return canvasTexture(32, (c, size) => {
      const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.4, 'rgba(190,230,255,0.7)');
      g.addColorStop(1, 'rgba(160,220,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, size, size);
    });
  }

  /** Very soft radial falloff shared by every glow/mist sprite. */
  _makeGlowSpriteTexture() {
    return canvasTexture(64, (c, size) => {
      const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      g.addColorStop(0, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.32)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.08)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, size, size);
    });
  }

  // ----------------------------------------------------------------- update

  update(dt, elapsed) {
    // Night factor drives every glow — islands become floating lanterns.
    const sky = this.ctx.systems.sky;
    const night = sky && sky.getSunIntensity
      ? 1 - Math.max(0, Math.min(1, sky.getSunIntensity()))
      : 0;
    this.underGlowMaterial.opacity =
      0.07 + 0.26 * night + 0.04 * Math.sin(elapsed * 0.6);
    this.crystalGlowMaterial.opacity =
      (0.12 + 0.5 * night) * (0.78 + 0.22 * Math.sin(elapsed * 1.7));
    // Fairy motes barely register by day, glitter after dark; the two tints
    // shimmer out of phase so the flock never pulses in lockstep.
    this.moteGoldMaterial.opacity =
      (0.10 + 0.55 * night) * (0.75 + 0.25 * Math.sin(elapsed * 1.3));
    this.moteCyanMaterial.opacity =
      (0.10 + 0.55 * night) * (0.75 + 0.25 * Math.sin(elapsed * 1.1 + 2.1));
    // Waterfalls catch a faint glassy shimmer.
    this.waterfallMaterial.opacity = 0.46 + 0.09 * Math.sin(elapsed * 1.35);

    const islands = this.islands;
    for (let i = 0; i < islands.length; i++) {
      const isle = islands[i];
      const g = isle.group;
      // Bob ±1.5: main swell plus a faster secondary harmonic so the motion
      // feels buoyant rather than metronomic.
      g.position.y = isle.baseY +
        (Math.sin(elapsed * isle.bobW + isle.phase) * 0.85 +
         Math.sin(elapsed * isle.bobW * 2.6 + isle.phase * 1.7) * 0.15) * BOB_AMP;
      // Very slow circular sway around the home position.
      const d = elapsed * isle.driftW + isle.driftPhase;
      g.position.x = isle.baseX + Math.sin(d) * isle.driftAmp;
      g.position.z = isle.baseZ + Math.cos(d * 0.83) * isle.driftAmp;
      // Slow spin + a breath of tilt so they feel weightless, not parked.
      g.rotation.y += isle.spin * dt;
      g.rotation.x = Math.sin(elapsed * isle.tiltW + isle.tiltPhase) * 0.022;
      g.rotation.z = Math.cos(elapsed * isle.tiltW * 0.82 + isle.tiltPhase) * 0.022;
      // Fairy motes trace slow ellipses around the rim, bobbing as they go.
      const motes = isle.motes;
      for (let k = 0; k < motes.length; k++) {
        const m = motes[k];
        const a = elapsed * m.speed + m.phase;
        m.sprite.position.set(
          Math.cos(a) * m.radius,
          m.height + Math.sin(elapsed * m.bobW + m.phase) * m.bobAmp,
          Math.sin(a) * m.radius
        );
      }
    }

    const falls = this.waterfalls;
    for (let w = 0; w < falls.length; w++) {
      const wf = falls[w];
      const pos = wf.positions;
      const speeds = wf.speeds;
      const bx = wf.baseX;
      const bz = wf.baseZ;
      const ph = wf.swayPhase;
      for (let i = 0; i < WATERFALL_COUNT; i++) {
        let y = pos[i * 3 + 1] - speeds[i] * dt;
        if (y < -WATERFALL_DROP) y += WATERFALL_DROP;
        pos[i * 3 + 1] = y;
        // Stream widens and sways as it falls — spray caught by the wind.
        const t = -y / WATERFALL_DROP; // 0 at the lip → 1 at the bottom
        const sway = 0.06 + 0.5 * t * t;
        const flare = 1 + t * 0.9;
        pos[i * 3] = bx[i] * flare + Math.sin(elapsed * 1.4 + ph[i]) * sway;
        pos[i * 3 + 2] = bz[i] * flare + Math.cos(elapsed * 1.1 + ph[i]) * sway;
      }
      wf.attr.needsUpdate = true;
      // Mist puff breathes where the stream dissolves.
      const ms = 3.1 + 0.6 * Math.sin(elapsed * 0.8 + wf.mistPhase);
      wf.mist.scale.set(ms, ms * 0.62, 1);
    }
  }
}

// --------------------------------------------------------------------- util

function smoothstep(x, edge0, edge1) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Merge indexed/non-indexed geometries (position+color) into one non-indexed geometry. */
function mergeNonIndexed(geometries) {
  const parts = geometries.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const p of parts) total += p.attributes.position.count;

  const positions = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  let offset = 0;
  for (const p of parts) {
    positions.set(p.attributes.position.array, offset * 3);
    colors.set(p.attributes.color.array, offset * 3);
    offset += p.attributes.position.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return merged;
}
