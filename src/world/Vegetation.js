import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm } from './Noise.js';
import {
  makeTreeMesh,
  makeMushroomMesh,
  makeCrystalMesh,
  makeRockMesh,
} from '../core/AssetFactory.js';

const TWO_PI = Math.PI * 2;

// easeOutBack — overshoot ≈ 1.1 at t ≈ 0.7, settles at 1.
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

/**
 * Vegetation — seeded scatter of trees, glowing mushrooms, crystal clusters and
 * rocks across the island, plus `spawnTree()` used by the GrowTree spell.
 *
 * Performance strategy: the initial scatter (~230 props, each a multi-mesh
 * Group from AssetFactory) is baked into a handful of merged static meshes —
 * one per unique material "look" — so the whole forest costs ~10 draw calls
 * instead of ~700. Materials are canonicalized (deduped by their visual
 * properties), which also lets the mushroom-spot and crystal materials pulse
 * as a group with zero per-object cost. Spell-grown trees stay as live Groups
 * so they can animate.
 */
export default class Vegetation {
  constructor(ctx) {
    this.ctx = ctx;

    this.group = new THREE.Group();
    this.group.name = 'vegetation';
    ctx.scene.add(this.group);

    // Live (animated) trees spawned by the GrowTree spell.
    this.growing = []; // { obj, t, duration }
    this._spawnCount = 0;

    // Exposed for curious systems (Wisps drift toward crystals at night).
    this.crystalPositions = [];

    // Emissive pulse registries — canonical materials, pulsed in update().
    this._mushroomGlow = []; // { mat, base }
    this._crystalGlow = []; // { mat, base }
    this._crystalLights = []; // real THREE.PointLight (2–3 total)

    // Merge machinery (constructor-only; freed after build).
    this._matCache = new Map(); // key -> canonical material
    this._buckets = new Map(); // key -> { material, items: [{ geometry, matrix }] }

    const terrain = ctx.systems.terrain;
    if (terrain && typeof terrain.getHeight === 'function') {
      this._scatter(terrain);
    }
    this._buildMergedMeshes();

    // Free constructor-only state.
    this._buckets = null;
    this._matCache = null;
  }

  // ------------------------------------------------------------------ scatter

  _scatter(terrain) {
    const rng = mulberry32(7777);
    const noise = createNoise2D(1337);
    const half = this.ctx.config.worldSize / 2 - 4;
    const minH = this.ctx.config.waterLevel + 0.6; // 1.8

    const height = (x, z) => terrain.getHeight(x, z);
    const slope = (x, z) => {
      const e = 1.5;
      const dx = (height(x + e, z) - height(x - e, z)) / (2 * e);
      const dz = (height(x, z + e) - height(x, z - e)) / (2 * e);
      return Math.sqrt(dx * dx + dz * dz);
    };
    // Fey-meadow mask — mirrors the terrain tint patches (~12% of grass).
    const isFey = (x, z) =>
      fbm(noise, x * 0.04 + 500, z * 0.04 + 500, { octaves: 3 }) > 0.45;

    // ---- Trees: 150 (25% magical), grass bands only, min spacing 3.
    //      ~2/3 of trees clump into groves (gaussian-ish falloff around seeded
    //      centers) leaving sunlit clearings between them; the rest scatter as
    //      lone wanderers. Density still ×2 inside fey patches, magical biased
    //      70% into fey.
    const groves = [];
    for (let attempts = 0; groves.length < 9 && attempts < 4000; attempts++) {
      const x = (rng() * 2 - 1) * half;
      const z = (rng() * 2 - 1) * half;
      const y = height(x, z);
      if (y < 2.8 || y > 9.5) continue;
      if (slope(x, z) >= 0.4) continue;
      let clear = true;
      for (let i = 0; i < groves.length; i++) {
        const dx = groves[i].x - x;
        const dz = groves[i].z - z;
        if (dx * dx + dz * dz < 26 * 26) {
          clear = false;
          break;
        }
      }
      if (clear) {
        groves.push({
          x,
          z,
          r: 7 + rng() * 6,
          // per-grove character: elder groves of tall trees, dwarf thickets…
          scaleMul: 0.8 + rng() * 0.55,
          // …and the occasional enchanted grove, glowing almost entirely magical
          enchanted: rng() < 0.22,
        });
      }
    }

    const trees = [];
    const SPACING_SQ = 9;
    for (let attempts = 0; trees.length < 150 && attempts < 20000; attempts++) {
      let x, z, g = null, edge = 0;
      if (groves.length && rng() < 0.65) {
        // grove member — sqrt(rng) keeps area density even, edges feather out
        g = groves[Math.floor(rng() * groves.length)];
        const ang = rng() * TWO_PI;
        const rad = g.r * Math.sqrt(rng());
        x = g.x + Math.cos(ang) * rad;
        z = g.z + Math.sin(ang) * rad;
        edge = rad / g.r; // 0 = heart of the grove, 1 = treeline
        if (x < -half || x > half || z < -half || z > half) continue;
      } else {
        x = (rng() * 2 - 1) * half;
        z = (rng() * 2 - 1) * half;
      }
      const y = height(x, z);
      if (y < 2.2 || y > 11) continue;
      if (slope(x, z) >= 0.5) continue;
      const fey = isFey(x, z);
      if (!fey && !g && rng() < 0.5) continue; // ×2 density in fey patches
      let clear = true;
      for (let i = 0; i < trees.length; i++) {
        const dx = trees[i].x - x;
        const dz = trees[i].z - z;
        if (dx * dx + dz * dz < SPACING_SQ) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      // enchanted groves come up almost entirely magical
      const magical = !!(g && g.enchanted && rng() < 0.8);
      trees.push({ x, y, z, fey, magical, grove: g, edge });
    }

    // Top up the magical share to ~25%, preferring fey patches (70/30 split).
    let preMagical = 0;
    for (let i = 0; i < trees.length; i++) if (trees[i].magical) preMagical++;
    const magicalTarget = Math.max(0, Math.round(trees.length * 0.25) - preMagical);
    const feyIdx = [];
    const plainIdx = [];
    for (let i = 0; i < trees.length; i++) {
      if (trees[i].magical) continue;
      (trees[i].fey ? feyIdx : plainIdx).push(i);
    }
    shuffle(feyIdx, rng);
    shuffle(plainIdx, rng);
    let wantFey = Math.min(Math.round(magicalTarget * 0.7), feyIdx.length);
    let assigned = 0;
    while (assigned < magicalTarget && (feyIdx.length || plainIdx.length)) {
      const pool = wantFey > 0 && feyIdx.length ? feyIdx : plainIdx.length ? plainIdx : feyIdx;
      if (!pool.length) break;
      trees[pool.pop()].magical = true;
      if (pool === feyIdx) wantFey--;
      assigned++;
    }

    for (let i = 0; i < trees.length; i++) {
      const t = trees[i];
      // wider size spread; grove character scales whole stands together and
      // trees shrink toward the treeline (tall hearts, feathered edges);
      // fey-meadow trees grow a touch grander
      let scale = 0.7 + rng() * 0.75;
      if (t.grove) scale *= t.grove.scaleMul * (1 - 0.25 * t.edge);
      if (t.fey) scale *= 1.12;
      if (scale < 0.45) scale = 0.45;
      const tree = makeTreeMesh({
        scale,
        magical: t.magical,
        seed: Math.floor(rng() * 1e9),
      });
      // slight random lean breaks the "planted on a grid" stiffness
      this._bake(tree, t.x, t.y, t.z, rng() * TWO_PI, null,
        (rng() - 0.5) * 0.09, (rng() - 0.5) * 0.09);
    }

    // ---- Mushrooms: 40 total, y 2.2–9, biased toward fey meadows.
    //      ~40% of clusters arrange as fairy rings (5–7 caps around a circle);
    //      the rest are loose huddles of 2–4 — about a third of which nestle
    //      against a tree trunk, the way real fungi keep to the rootline.
    let shrooms = 0;
    for (let attempts = 0; shrooms < 40 && attempts < 9000; attempts++) {
      let cx, cz;
      if (trees.length && rng() < 0.3) {
        const tr = trees[Math.floor(rng() * trees.length)];
        const a = rng() * TWO_PI;
        const d = 0.9 + rng() * 0.9;
        cx = tr.x + Math.cos(a) * d;
        cz = tr.z + Math.sin(a) * d;
      } else {
        cx = (rng() * 2 - 1) * half;
        cz = (rng() * 2 - 1) * half;
      }
      const cy = height(cx, cz);
      if (cy < 2.2 || cy > 9) continue;
      if (slope(cx, cz) >= 0.6) continue;
      if (!isFey(cx, cz) && rng() < 0.45) continue; // fey patches sprout more
      const ring = rng() < 0.4;
      const n = ring ? 5 + Math.floor(rng() * 3) : 2 + Math.floor(rng() * 3);
      const ringRad = 1.7 + rng() * 0.9;
      const ringPhase = rng() * TWO_PI;
      for (let i = 0; i < n && shrooms < 40; i++) {
        let ang, rad;
        if (ring) {
          // evenly around the circle, lightly jittered — reads as a fairy ring
          ang = ringPhase + (i / n) * TWO_PI + (rng() - 0.5) * 0.35;
          rad = ringRad + (rng() - 0.5) * 0.4;
        } else {
          ang = rng() * TWO_PI;
          rad = rng() * 2.5;
        }
        const x = cx + Math.cos(ang) * rad;
        const z = cz + Math.sin(ang) * rad;
        const y = height(x, z);
        if (y < minH) continue;
        const scale = ring ? 0.55 + rng() * 0.4 : 0.7 + rng() * 0.6;
        const m = makeMushroomMesh({ scale, seed: Math.floor(rng() * 1e9) });
        this._bake(m, x, y, z, rng() * TWO_PI, this._mushroomGlow);
        shrooms++;
      }
    }

    // ---- Crystal clusters: 12 in the rocky bands (relax band if scarce).
    //      2 violet clusters; 3 carry a REAL PointLight, the rest fake it.
    const crystalSpots = [];
    for (let pass = 0; pass < 2 && crystalSpots.length < 12; pass++) {
      const lo = pass === 0 ? 9 : 2.2;
      const hi = pass === 0 ? 16 : 16;
      for (let attempts = 0; crystalSpots.length < 12 && attempts < 6000; attempts++) {
        const x = (rng() * 2 - 1) * half;
        const z = (rng() * 2 - 1) * half;
        const y = height(x, z);
        if (y < lo || y > hi) continue;
        if (slope(x, z) >= 0.7) continue;
        let clear = true;
        for (let i = 0; i < crystalSpots.length; i++) {
          const dx = crystalSpots[i].x - x;
          const dz = crystalSpots[i].z - z;
          if (dx * dx + dz * dz < 64) {
            clear = false;
            break;
          }
        }
        if (clear) crystalSpots.push({ x, y, z });
      }
    }
    for (let i = 0; i < crystalSpots.length; i++) {
      const s = crystalSpots[i];
      // palette: mostly glacier cyan, two violet, one rare rose-pink
      const color = (i === 3 || i === 8) ? 0xc08ff7 : i === 5 ? 0xff9fd6 : 0x7fe7ff;
      const cluster = makeCrystalMesh({
        color,
        scale: 0.7 + rng() * 0.9,
        seed: Math.floor(rng() * 1e9),
      });
      this._bake(cluster, s.x, s.y, s.z, rng() * TWO_PI, this._crystalGlow);
      this.crystalPositions.push(new THREE.Vector3(s.x, s.y + 0.8, s.z));

      // shard satellites — splinters of the same vein scattered around the
      // mother cluster (same color → same canonical material → free to draw)
      const shards = 2 + (i % 2);
      for (let k = 0; k < shards; k++) {
        const ang = rng() * TWO_PI;
        const rad = 1.6 + rng() * 1.7;
        const px = s.x + Math.cos(ang) * rad;
        const pz = s.z + Math.sin(ang) * rad;
        const py = height(px, pz);
        if (py < minH) continue;
        const shard = makeCrystalMesh({
          color,
          scale: 0.22 + rng() * 0.22,
          seed: Math.floor(rng() * 1e9),
        });
        this._bake(shard, px, py, pz, rng() * TWO_PI, this._crystalGlow);
      }

      if (i % 4 === 0 && this._crystalLights.length < 3) {
        const light = new THREE.PointLight(color, 2.2, 14, 2);
        light.position.set(s.x, s.y + 1.4, s.z);
        light.castShadow = false; // real glow, cheap glow
        this.group.add(light);
        this._crystalLights.push(light);
      }
    }

    // ---- Rocks: 30, anywhere above the waterline; biased toward slopes and
    //      cliff feet (where fallen stone belongs). ~1/3 get a smaller
    //      companion stone tucked beside them.
    let rocks = 0;
    for (let attempts = 0; rocks < 30 && attempts < 7000; attempts++) {
      const x = (rng() * 2 - 1) * half;
      const z = (rng() * 2 - 1) * half;
      const y = height(x, z);
      if (y < minH) continue;
      const s = slope(x, z);
      if (s >= 0.9) continue;
      if (s < 0.18 && rng() < 0.55) continue; // prefer broken ground
      const scale = 0.6 + rng() * 1.2;
      const rock = makeRockMesh({ scale, seed: Math.floor(rng() * 1e9) });
      this._bake(rock, x, y - 0.1, z, rng() * TWO_PI, null);
      rocks++;
      if (rocks < 30 && rng() < 0.35) {
        const ang = rng() * TWO_PI;
        const rad = scale * (0.9 + rng() * 0.6);
        const px = x + Math.cos(ang) * rad;
        const pz = z + Math.sin(ang) * rad;
        const py = height(px, pz);
        if (py >= minH) {
          const pebble = makeRockMesh({ scale: scale * (0.35 + rng() * 0.3), seed: Math.floor(rng() * 1e9) });
          this._bake(pebble, px, py - 0.05, pz, rng() * TWO_PI, null);
          rocks++;
        }
      }
    }
  }

  // ------------------------------------------------------------------ merging

  /**
   * Position a factory-made object, then file every sub-mesh (geometry +
   * world matrix) into per-material buckets for merging. Non-mesh children
   * (Points, Sprites) and multi-material meshes are kept as-is, re-parented
   * to the vegetation group with their world transform baked in.
   * `tiltX`/`tiltZ` add a small organic lean (radians) around the base.
   */
  _bake(obj, x, y, z, rotY, glowSink, tiltX = 0, tiltZ = 0) {
    // Factories may return a bare Mesh (e.g. makeRockMesh). Wrap it so the
    // traverse below sees it as a child AND its factory-set base offset
    // (rock.position.y) survives the placement transform.
    let root = obj;
    if (obj.isMesh) {
      root = new THREE.Group();
      root.add(obj);
    }
    root.position.set(x, y, z);
    root.rotation.set(tiltX, rotY, tiltZ);
    root.updateMatrixWorld(true);

    const loose = [];
    root.traverse((child) => {
      if (child === root) return;
      if (child.isMesh && !Array.isArray(child.material) && child.geometry && child.geometry.isBufferGeometry) {
        const { key, material } = this._canonicalMaterial(child.material, glowSink);
        let bucket = this._buckets.get(key);
        if (!bucket) {
          bucket = { material, items: [] };
          this._buckets.set(key, bucket);
        }
        bucket.items.push({ geometry: child.geometry, matrix: child.matrixWorld.clone() });
      } else if (child.isPoints || child.isSprite || (child.isMesh && Array.isArray(child.material))) {
        loose.push(child);
      }
    });

    // Preserve exotic children (rare) without keeping the whole group alive.
    for (let i = 0; i < loose.length; i++) {
      const child = loose[i];
      const clone = child.clone();
      clone.matrixAutoUpdate = false;
      clone.matrix.copy(child.matrixWorld);
      this.group.add(clone);
    }
  }

  /** Dedupe materials by visual fingerprint so buckets (= draw calls) stay few. */
  _canonicalMaterial(mat, glowSink) {
    const key =
      mat.type +
      '|' + (mat.color ? mat.color.getHex() : 0) +
      '|' + (mat.emissive ? mat.emissive.getHex() : 0) +
      '|' + (mat.emissiveIntensity !== undefined ? mat.emissiveIntensity : 0) +
      '|' + (mat.flatShading ? 1 : 0) +
      '|' + (mat.transparent ? 1 : 0) +
      '|' + (mat.opacity !== undefined ? mat.opacity : 1) +
      '|' + (mat.roughness !== undefined ? mat.roughness : '') +
      '|' + (mat.metalness !== undefined ? mat.metalness : '') +
      '|' + (mat.map ? mat.map.uuid : '') +
      '|' + (mat.side !== undefined ? mat.side : 0) +
      '|' + (mat.vertexColors ? 1 : 0);

    let canonical = this._matCache.get(key);
    if (!canonical) {
      canonical = mat;
      this._matCache.set(key, canonical);
      if (
        glowSink &&
        canonical.emissive &&
        canonical.emissiveIntensity > 0.01 &&
        canonical.emissive.getHex() !== 0
      ) {
        glowSink.push({ mat: canonical, base: canonical.emissiveIntensity });
      }
    }
    return { key, material: canonical };
  }

  /** Concatenate every bucket into one static mesh per material. */
  _buildMergedMeshes() {
    if (!this._buckets) return;
    for (const bucket of this._buckets.values()) {
      const geometry = mergeBakedGeometries(bucket.items);
      if (!geometry) continue;
      const mesh = new THREE.Mesh(geometry, bucket.material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
    }
  }

  // ---------------------------------------------------------------- spawnTree

  /**
   * Add a tree at `position` (used by the GrowTree spell). When `animate` is
   * true the tree sprouts from scale 0.01 to full size over ~1.5s with a
   * juicy easeOutBack overshoot. Returns the tree Group.
   */
  spawnTree(position, { scale = 1, magical = true, animate = true } = {}) {
    const n = this._spawnCount++;
    const seed = ((n + 1) * 2654435761 + 97531) >>> 0;

    const tree = makeTreeMesh({ scale, magical, seed });

    const terrain = this.ctx.systems.terrain;
    let y = position.y;
    if (terrain && typeof terrain.getHeight === 'function') {
      const h = terrain.getHeight(position.x, position.z);
      if (h > -50) y = h;
    }
    tree.position.set(position.x, y, position.z);
    tree.rotation.y = (seed % 6283) * 0.001;
    tree.traverse((child) => {
      if (child.isMesh) child.castShadow = true;
    });
    this.group.add(tree);

    if (animate) {
      // makeTreeMesh bakes the requested `scale` into group.scale — capture it
      // as the grow target so the animation lands on the requested size.
      // baseRZ preserves the factory's natural lean so the sprout wobble
      // settles back onto it instead of snapping the tree upright.
      const target = tree.scale.x || 1;
      tree.scale.setScalar(0.01);
      this.growing.push({
        obj: tree,
        t: 0,
        duration: 1.35 + (seed % 1000) * 0.0004, // ~1.35–1.75s, varies per tree
        target,
        baseRZ: tree.rotation.z,
        baseRY: tree.rotation.y,
        baseRX: tree.rotation.x,
        wobblePhase: (seed % 628) * 0.01,
      });
    }
    return tree;
  }

  // ------------------------------------------------------------------- update

  update(dt, elapsed) {
    // Grow animations (swap-pop removal, no allocation).
    // Sprout feel: a fat little nub bulges out of the soil, then height
    // shoots up with an overshoot while the girth fills in a beat later —
    // squash-and-stretch. The whole shoot untwists as it rises and sways on
    // two axes; both wobbles decay quadratically and land on the natural lean.
    for (let i = this.growing.length - 1; i >= 0; i--) {
      const g = this.growing[i];
      g.t += dt;
      const t = g.t / g.duration;
      if (t >= 1) {
        g.obj.scale.setScalar(g.target);
        g.obj.rotation.set(g.baseRX, g.baseRY, g.baseRZ);
        const last = this.growing.length - 1;
        if (i !== last) this.growing[i] = this.growing[last];
        this.growing.pop();
      } else {
        const ty = t * 1.15 >= 1 ? 1 : t * 1.15;             // height leads
        const txr = t < 0.22 ? 0 : (t - 0.22) / 0.78;        // girth lags
        let sy = easeOutBack(ty) * g.target;
        // emergence bulge: a plump seedling nub that hands off smoothly to
        // the lagged easeOutBack as the trunk fills out (max of two curves)
        const bulge = 0.34 * Math.sin(Math.min(t * 2.4, 1) * Math.PI);
        const fill = easeOutBack(txr);
        let sx = (fill > bulge ? fill : bulge) * g.target;
        if (sy < 0.01) sy = 0.01;
        if (sx < 0.01) sx = 0.01;
        g.obj.scale.set(sx, sy, sx);
        const decay = (1 - t) * (1 - t);
        g.obj.rotation.z = g.baseRZ + Math.sin(t * 17 + g.wobblePhase) * 0.085 * decay;
        g.obj.rotation.x = g.baseRX + Math.sin(t * 23 + g.wobblePhase * 1.7) * 0.055 * decay;
        g.obj.rotation.y = g.baseRY + decay * decay * 1.9; // sprout untwists
      }
    }

    // Mushroom spots breathe (±15%, period 2.8s).
    if (this._mushroomGlow.length) {
      const pulse = 1 + 0.15 * Math.sin(elapsed * (TWO_PI / 2.8));
      for (let i = 0; i < this._mushroomGlow.length; i++) {
        const e = this._mushroomGlow[i];
        e.mat.emissiveIntensity = e.base * pulse;
      }
    }

    // Crystals shimmer (±20%, period 3.5s), real lights pulse with offsets.
    const cPhase = elapsed * (TWO_PI / 3.5);
    if (this._crystalGlow.length) {
      const pulse = 1 + 0.2 * Math.sin(cPhase + 1.3);
      for (let i = 0; i < this._crystalGlow.length; i++) {
        const e = this._crystalGlow[i];
        e.mat.emissiveIntensity = e.base * pulse;
      }
    }
    for (let i = 0; i < this._crystalLights.length; i++) {
      this._crystalLights[i].intensity = 2.2 * (1 + 0.2 * Math.sin(cPhase + i * 2.1));
    }
  }
}

// --------------------------------------------------------------------- helpers

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

/**
 * Merge `{ geometry, matrix }` entries into one BufferGeometry. Geometries are
 * de-indexed, transformed to world space, and concatenated attribute-by-
 * attribute (only attributes present on ALL entries with a matching itemSize
 * survive — position/normal always, uv/color when consistent).
 */
function mergeBakedGeometries(items) {
  if (!items.length) return null;

  const geoms = [];
  for (let i = 0; i < items.length; i++) {
    const src = items[i].geometry;
    const g = src.index ? src.toNonIndexed() : src.clone();
    if (!g.attributes.normal) g.computeVertexNormals();
    g.applyMatrix4(items[i].matrix);
    geoms.push(g);
  }

  const merged = new THREE.BufferGeometry();
  const candidates = ['position', 'normal', 'uv', 'color'];
  for (let a = 0; a < candidates.length; a++) {
    const name = candidates[a];
    const first = geoms[0].attributes[name];
    if (!first) continue;
    const itemSize = first.itemSize;
    let total = 0;
    let ok = true;
    for (let i = 0; i < geoms.length; i++) {
      const attr = geoms[i].attributes[name];
      if (!attr || attr.itemSize !== itemSize) {
        ok = false;
        break;
      }
      total += attr.count;
    }
    if (!ok) continue;

    const out = new Float32Array(total * itemSize);
    let offset = 0;
    for (let i = 0; i < geoms.length; i++) {
      const attr = geoms[i].attributes[name];
      const len = attr.count * itemSize;
      if (attr.array.length === len) {
        out.set(attr.array, offset);
      } else {
        for (let v = 0; v < attr.count; v++) {
          for (let c = 0; c < itemSize; c++) {
            out[offset + v * itemSize + c] = attr.array[v * attr.itemSize + c];
          }
        }
      }
      offset += len;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
  }

  for (let i = 0; i < geoms.length; i++) geoms[i].dispose();

  if (!merged.attributes.position) return null;
  merged.computeBoundingSphere();
  return merged;
}
