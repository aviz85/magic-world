import * as THREE from 'three';
import { BLOCKS, getBlockMaterial, BLOCK_GEOMETRY } from './Blocks.js';
import { getPrefab } from './Prefabs.js';

// ---------------------------------------------------------------------------
// BuildSystem — voxel place/remove with ghost preview, pop animations,
// staggered prefab rise, explosion destruction, column support queries.
//
// Grid: cell size 1, world-aligned. Integer cell (x,y,z) → block center at
// (x+0.5, y+0.5, z+0.5). Blocks stored in a Map keyed "x|y|z".
// ---------------------------------------------------------------------------

const RAY_MAX_DIST = 8;
const POP_DURATION = 0.15; // single block place pop
const RISE_DURATION = 0.3; // per-block prefab rise tween
const PLAYER_HALF_W = 0.42;
const PLAYER_HEIGHT = 1.8;

// easings (per docs/design/building.md)
function easeOutCubic(t) {
  const u = 1 - t;
  return 1 - u * u * u;
}
function easeOutBack(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const u = t - 1;
  return 1 + c3 * u * u * u + c1 * u * u;
}

function cellKey(x, y, z) {
  return x + '|' + y + '|' + z;
}
function colKey(x, z) {
  return x + '|' + z;
}

export default class BuildSystem {
  constructor(ctx) {
    this.ctx = ctx;

    // --- voxel storage -----------------------------------------------------
    // key "x|y|z" → { type, mesh, x, y, z }
    this.blocks = new Map();
    // column index for fast support queries: "x|z" → array of integer y cells
    this.columns = new Map();

    // --- state -------------------------------------------------------------
    this.mode = 'magic'; // default mode per contract
    this.selected = 0; // index into BLOCKS (0..7)

    // active tweens: { mesh, kind:'pop'|'rise', age, delay, dur, targetY }
    this.anims = [];

    // current frame targets (reused, no per-frame allocations)
    this._place = { x: 0, y: 0, z: 0, has: false, valid: false };
    this._remove = { x: 0, y: 0, z: 0, has: false };

    // --- scratch -----------------------------------------------------------
    this._raycaster = new THREE.Raycaster();
    this._raycaster.far = RAY_MAX_DIST;
    this._center = new THREE.Vector2(0, 0);
    this._normal = new THREE.Vector3();
    this._point = new THREE.Vector3();
    this._hits = [];
    this._rayTargets = [];
    this._meshList = [];
    this._meshListDirty = true;
    this._removeScratch = [];
    this._vDown = new THREE.Vector3(0, -1, 0);
    this._landPuffBudget = 0; // per-frame cap on prefab landing puffs

    // --- group -------------------------------------------------------------
    this.group = new THREE.Group();
    this.group.name = 'build-blocks';
    ctx.scene.add(this.group);

    // --- ghost preview -----------------------------------------------------
    this._ghostMaterials = new Map(); // block id → translucent preview material
    this._ghostInvalidMaterial = new THREE.MeshStandardMaterial({
      color: 0xff4455,
      emissive: 0xff2233,
      emissiveIntensity: 0.45,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      flatShading: true,
    });
    this.ghost = new THREE.Mesh(BLOCK_GEOMETRY, this._ghostMaterial(BLOCKS[0].id));
    this.ghost.scale.setScalar(1.02); // avoid z-fighting with neighbours
    this.ghost.visible = false;
    this.ghost.castShadow = false;
    this.ghost.receiveShadow = false;
    this.ghost.renderOrder = 2;
    ctx.scene.add(this.ghost);

    // soft glowing edge frame on the ghost — reads "magical blueprint"
    this._ghostEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(BLOCK_GEOMETRY),
      new THREE.LineBasicMaterial({ color: 0x9ff3ff, transparent: true, opacity: 0.85 })
    );
    this.ghost.add(this._ghostEdges);

    // --- events ------------------------------------------------------------
    const events = ctx.events;
    events.on('mode:change', ({ mode }) => {
      this.mode = mode;
      if (mode !== 'build') {
        this.ghost.visible = false;
        this._place.has = false;
        this._remove.has = false;
      } else {
        // re-announce selection so the HUD can sync its hotbar instantly
        events.emit('build:select', { index: this.selected, def: BLOCKS[this.selected] });
      }
    });

    events.on('input:mousedown', ({ button }) => {
      if (this.mode !== 'build' || !this.ctx.input.pointerLocked) return;
      if (button === 0) {
        if (this._place.has && this._place.valid) {
          this.placeBlock(this._place.x, this._place.y, this._place.z, BLOCKS[this.selected].id);
        }
      } else if (button === 2) {
        if (this._remove.has) {
          this.removeBlock(this._remove.x, this._remove.y, this._remove.z);
        }
      }
    });

    events.on('input:keydown', ({ code }) => {
      if (this.mode !== 'build' || !this.ctx.input.pointerLocked) return;
      if (code.startsWith('Digit')) {
        const n = code.charCodeAt(5) - 49; // '1' → 0
        if (n >= 0 && n < BLOCKS.length) this._select(n);
      }
    });

    events.on('input:wheel', ({ deltaY }) => {
      if (this.mode !== 'build' || !this.ctx.input.pointerLocked) return;
      const dir = deltaY > 0 ? 1 : -1;
      this._select((this.selected + dir + BLOCKS.length) % BLOCKS.length);
    });

    events.on('fx:explosion', ({ position, radius }) => {
      this._explode(position, radius);
    });
  }

  // -------------------------------------------------------------------------
  // selection
  // -------------------------------------------------------------------------

  _select(index) {
    if (index === this.selected) return;
    this.selected = index;
    this.ghost.material = this._ghostMaterial(BLOCKS[index].id);
    this.ctx.events.emit('build:select', { index, def: BLOCKS[index] });
  }

  _ghostMaterial(id) {
    let mat = this._ghostMaterials.get(id);
    if (!mat) {
      mat = getBlockMaterial(id).clone();
      mat.transparent = true;
      mat.opacity = 0.45;
      mat.emissive = new THREE.Color(0x66ddff);
      mat.emissiveIntensity = 0.35;
      mat.depthWrite = false;
      this._ghostMaterials.set(id, mat);
    }
    return mat;
  }

  // -------------------------------------------------------------------------
  // public API (contract)
  // -------------------------------------------------------------------------

  getBlockAt(x, y, z) {
    const entry = this.blocks.get(cellKey(x, y, z));
    if (!entry) return null;
    return BLOCKS.find((b) => b.id === entry.type) || null;
  }

  /**
   * Top y of the highest block whose column contains world point (x,z) and
   * whose top is ≤ fromY + 0.5; -Infinity if none. O(column height).
   */
  getSupportHeight(x, z, fromY) {
    const col = this.columns.get(colKey(Math.floor(x), Math.floor(z)));
    if (!col) return -Infinity;
    let best = -Infinity;
    const limit = fromY + 0.5;
    for (let i = 0; i < col.length; i++) {
      const top = col[i] + 1;
      if (top <= limit && top > best) best = top;
    }
    return best;
  }

  placeBlock(x, y, z, type, { animate = true, silent = false } = {}) {
    const key = cellKey(x, y, z);
    if (this.blocks.has(key)) return false;
    const def = BLOCKS.find((b) => b.id === type);
    if (!def) return false;

    const mesh = new THREE.Mesh(BLOCK_GEOMETRY, getBlockMaterial(type));
    mesh.position.set(x + 0.5, y + 0.5, z + 0.5);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.cellX = x;
    mesh.userData.cellY = y;
    mesh.userData.cellZ = z;
    mesh.userData.isBlock = true;
    this.group.add(mesh);
    mesh.updateMatrixWorld(); // raycastable this frame, before the next render pass

    this.blocks.set(key, { type, mesh, x, y, z });
    this._columnAdd(x, y, z);
    this._meshListDirty = true;

    if (animate) {
      // single-block pop: scale 0.4 → 1.0 easeOutBack over 0.15s
      mesh.scale.setScalar(0.4);
      this.anims.push({ mesh, kind: 'pop', age: 0, delay: 0, dur: POP_DURATION, targetY: y + 0.5 });
    } else {
      this._freeze(mesh);
    }

    if (!silent) {
      // place juice: a quick sparkle in the block's own color, plus a real
      // light flash for emissive blocks (crystal/lava feel alive on arrival).
      // Event-driven path, not a hot loop — the fresh Vector3 is fine.
      const particles = this.ctx.systems.particles;
      if (particles && animate) {
        const center = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
        particles.burst({
          position: center,
          color: def.color,
          count: 10,
          speed: 2.6,
          life: 0.45,
          size: 0.16,
          gravity: 2,
        });
        if (def.emissiveIntensity > 0 && particles.flash) {
          particles.flash(center, def.emissive || def.color, 2, 0.2);
        }
      }
      this.ctx.events.emit('block:place', { type, position: { x, y, z } });
    }
    return true;
  }

  removeBlock(x, y, z) {
    const key = cellKey(x, y, z);
    const entry = this.blocks.get(key);
    if (!entry) return false;

    this.blocks.delete(key);
    this._columnRemove(x, y, z);
    this._detachMesh(entry.mesh);
    this._meshListDirty = true;

    // crumble feedback: a chunky puff in the block's own color + a dimmer
    // slow-falling dust layer so the break feels weighty, and a brief light
    // flash when an emissive block (crystal/lava) shatters.
    const particles = this.ctx.systems.particles;
    if (particles) {
      const def = BLOCKS.find((b) => b.id === entry.type);
      // fresh vector: never hand the shared scratch to another system that may
      // keep the reference (event-driven path, not a hot loop — alloc is fine)
      const center = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
      particles.burst({
        position: center,
        color: def ? def.color : 0xaaaaaa,
        count: 14,
        speed: 3.5,
        life: 0.6,
        size: 0.22,
        gravity: 9,
      });
      particles.burst({
        position: center,
        color: 0x8d8576,
        count: 6,
        speed: 1.4,
        life: 0.9,
        size: 0.3,
        gravity: 4,
      });
      if (def && def.emissiveIntensity > 0 && particles.flash) {
        particles.flash(center, def.emissive || def.color, 2.5, 0.18);
      }
    }

    this.ctx.events.emit('block:remove', { type: entry.type, position: { x, y, z } });
    return true;
  }

  /**
   * Place a prefab at origin (Vector3, snapped to grid). Blocks land solid
   * immediately, then animate in as a bottom-up staggered wave over ~1.5s.
   */
  placePrefab(name, origin) {
    const prefab = getPrefab(name);
    if (!prefab) return false;

    const ox = Math.floor(origin.x);
    const oy = Math.round(origin.y);
    const oz = Math.floor(origin.z);

    // bottom-up wave: sort by (y, then x+z)
    const sorted = prefab.blocks.slice().sort((a, b) => (a.y - b.y) || ((a.x + a.z) - (b.x + b.z)));

    // per-block delay: y * 0.10 + orderWithinLayer * 0.006, max ≤ 1.2s
    const delays = new Array(sorted.length);
    let maxDelay = 0;
    let layerY = -1;
    let orderInLayer = 0;
    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i];
      if (b.y !== layerY) {
        layerY = b.y;
        orderInLayer = 0;
      }
      const d = b.y * 0.1 + orderInLayer * 0.006;
      delays[i] = d;
      if (d > maxDelay) maxDelay = d;
      orderInLayer++;
    }
    const scale = maxDelay > 1.2 ? 1.2 / maxDelay : 1;

    let placed = 0;
    for (let i = 0; i < sorted.length; i++) {
      const b = sorted[i];
      const x = ox + b.x;
      const y = oy + b.y;
      const z = oz + b.z;
      const key = cellKey(x, y, z);
      if (this.blocks.has(key)) continue; // never stack into occupied cells

      const def = BLOCKS.find((d) => d.id === b.type);
      if (!def) continue;

      const mesh = new THREE.Mesh(BLOCK_GEOMETRY, getBlockMaterial(b.type));
      mesh.position.set(x + 0.5, y + 0.5 - 0.6, z + 0.5);
      mesh.scale.setScalar(0.01);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.cellX = x;
      mesh.userData.cellY = y;
      mesh.userData.cellZ = z;
      mesh.userData.isBlock = true;
      this.group.add(mesh);
      mesh.updateMatrixWorld(); // raycastable this frame, before the next render pass

      this.blocks.set(key, { type: b.type, mesh, x, y, z });
      this._columnAdd(x, y, z); // collidable immediately
      placed++;

      this.anims.push({
        mesh,
        kind: 'rise',
        age: 0,
        delay: delays[i] * scale,
        dur: RISE_DURATION,
        targetY: y + 0.5,
      });
    }
    this._meshListDirty = true;

    if (placed > 0) {
      this.ctx.events.emit('prefab:place', { name, origin: { x: ox, y: oy, z: oz } });
    }
    return placed > 0;
  }

  /** Array of live block meshes (for spell raycasts). Reused, rebuilt lazily. */
  getMeshes() {
    if (this._meshListDirty) {
      this._meshList.length = 0;
      for (const entry of this.blocks.values()) this._meshList.push(entry.mesh);
      this._meshListDirty = false;
    }
    return this._meshList;
  }

  serialize() {
    const out = [];
    for (const entry of this.blocks.values()) {
      out.push({ x: entry.x, y: entry.y, z: entry.z, type: entry.type });
    }
    return out;
  }

  deserialize(arr) {
    this.clearAll();
    if (!Array.isArray(arr)) return;
    for (let i = 0; i < arr.length; i++) {
      const b = arr[i];
      if (!b || !Number.isFinite(b.x) || !Number.isFinite(b.y) || !Number.isFinite(b.z)) continue;
      this.placeBlock(b.x | 0, b.y | 0, b.z | 0, b.type, { animate: false, silent: true });
    }
  }

  clearAll() {
    for (const entry of this.blocks.values()) this._detachMesh(entry.mesh);
    this.blocks.clear();
    this.columns.clear();
    this.anims.length = 0;
    this._meshList.length = 0;
    this._meshListDirty = false;
    this._place.has = false;
    this._remove.has = false;
  }

  // -------------------------------------------------------------------------
  // per-frame
  // -------------------------------------------------------------------------

  update(dt, elapsed) {
    this._updateAnims(dt);

    if (this.mode !== 'build' || !this.ctx.input.pointerLocked) {
      if (this.ghost.visible) this.ghost.visible = false;
      this._place.has = false;
      this._remove.has = false;
      return;
    }

    this._updateTargeting();

    // ghost pulse — gentle breathing opacity + size shimmer
    if (this.ghost.visible) {
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 5.5);
      const mat = this.ghost.material;
      mat.opacity = (this._place.valid ? 0.34 : 0.3) + 0.14 * pulse;
      this._ghostEdges.material.opacity = 0.55 + 0.4 * pulse;
      const s = 1.02 + 0.015 * pulse;
      this.ghost.scale.setScalar(s);
    }
  }

  _updateTargeting() {
    const terrain = this.ctx.systems.terrain;
    const targets = this._rayTargets;
    targets.length = 0;
    if (terrain && terrain.mesh) targets.push(terrain.mesh);
    const meshes = this.getMeshes();
    for (let i = 0; i < meshes.length; i++) targets.push(meshes[i]);

    this._raycaster.setFromCamera(this._center, this.ctx.camera);
    this._hits.length = 0;
    this._raycaster.intersectObjects(targets, false, this._hits);

    this._place.has = false;
    this._remove.has = false;

    const hit = this._hits.length > 0 ? this._hits[0] : null;
    if (!hit || !hit.face) {
      this.ghost.visible = false;
      return;
    }

    // world-space face normal (terrain mesh is rotated; transformDirection handles it)
    this._normal.copy(hit.face.normal).transformDirection(hit.object.matrixWorld);

    // remove target = the hit block itself
    const ud = hit.object.userData;
    if (ud.isBlock) {
      this._remove.x = ud.cellX;
      this._remove.y = ud.cellY;
      this._remove.z = ud.cellZ;
      this._remove.has = true;
    }

    // place target = cell adjacent on the hit face
    this._point.copy(hit.point).addScaledVector(this._normal, 0.5);
    const px = Math.floor(this._point.x);
    const py = Math.floor(this._point.y);
    const pz = Math.floor(this._point.z);

    this._place.x = px;
    this._place.y = py;
    this._place.z = pz;
    this._place.has = true;
    this._place.valid =
      !this.blocks.has(cellKey(px, py, pz)) && !this._intersectsPlayer(px, py, pz);

    this.ghost.visible = true;
    this.ghost.position.set(px + 0.5, py + 0.5, pz + 0.5);
    const wantMat = this._place.valid ? this._ghostMaterial(BLOCKS[this.selected].id) : this._ghostInvalidMaterial;
    if (this.ghost.material !== wantMat) {
      this.ghost.material = wantMat;
      // edge frame follows validity: cyan blueprint ↔ warning red
      this._ghostEdges.material.color.setHex(this._place.valid ? 0x9ff3ff : 0xff5566);
    }
  }

  _intersectsPlayer(cx, cy, cz) {
    const player = this.ctx.systems.player;
    if (!player || !player.position) return false;
    const p = player.position; // feet
    return (
      cx + 1 > p.x - PLAYER_HALF_W &&
      cx < p.x + PLAYER_HALF_W &&
      cz + 1 > p.z - PLAYER_HALF_W &&
      cz < p.z + PLAYER_HALF_W &&
      cy + 1 > p.y &&
      cy < p.y + PLAYER_HEIGHT
    );
  }

  _updateAnims(dt) {
    this._landPuffBudget = 2;
    const anims = this.anims;
    for (let i = anims.length - 1; i >= 0; i--) {
      const a = anims[i];
      const mesh = a.mesh;

      // block was destroyed mid-animation (explosion) — drop the tween
      if (mesh.parent === null) {
        anims[i] = anims[anims.length - 1];
        anims.pop();
        continue;
      }

      a.age += dt;
      const t = (a.age - a.delay) / a.dur;

      if (t <= 0) {
        // waiting its stagger turn — keep tiny & sunken so the wave reads bottom-up
        if (a.kind === 'rise') {
          mesh.scale.setScalar(0.01);
          mesh.position.y = a.targetY - 0.6;
        }
        continue;
      }

      if (t >= 1) {
        mesh.scale.setScalar(1);
        mesh.position.y = a.targetY;
        this._freeze(mesh);
        // prefab blocks "thud" into place with a tiny dust puff — budgeted
        // (≤2/frame) and camera-near only so big builds stay cheap
        if (a.kind === 'rise' && this._landPuffBudget > 0) {
          const particles = this.ctx.systems.particles;
          if (particles && particles.stream) {
            const cam = this.ctx.camera.position;
            const dx = mesh.position.x - cam.x;
            const dy = mesh.position.y - cam.y;
            const dz = mesh.position.z - cam.z;
            if (dx * dx + dy * dy + dz * dz < 1600) {
              this._landPuffBudget--;
              particles.stream({
                position: mesh.position,
                direction: this._vDown,
                color: 0xcfc7b2,
                count: 3,
                speed: 1.2,
                life: 0.4,
                size: 0.18,
              });
            }
          }
        }
        anims[i] = anims[anims.length - 1];
        anims.pop();
        continue;
      }

      const back = easeOutBack(t);
      if (a.kind === 'rise') {
        // position eases with outCubic, scale overshoots with outBack
        mesh.position.y = a.targetY - 0.6 * (1 - easeOutCubic(t));
        const s = Math.max(0.01, 0.01 + 0.99 * back);
        mesh.scale.setScalar(s);
      } else {
        // pop: 0.4 → 1.0 with overshoot
        mesh.scale.setScalar(0.4 + 0.6 * back);
      }
    }
  }

  // -------------------------------------------------------------------------
  // explosion destruction
  // -------------------------------------------------------------------------

  _explode(position, radius) {
    if (this.blocks.size === 0) return;
    const r2 = radius * radius;
    const doomed = this._removeScratch;
    doomed.length = 0;

    for (const entry of this.blocks.values()) {
      const dx = entry.x + 0.5 - position.x;
      const dy = entry.y + 0.5 - position.y;
      const dz = entry.z + 0.5 - position.z;
      if (dx * dx + dy * dy + dz * dz <= r2) doomed.push(entry);
    }
    if (doomed.length === 0) return;

    const particles = this.ctx.systems.particles;
    const events = this.ctx.events;

    for (let i = 0; i < doomed.length; i++) {
      const entry = doomed[i];
      this.blocks.delete(cellKey(entry.x, entry.y, entry.z));
      this._columnRemove(entry.x, entry.y, entry.z);
      this._detachMesh(entry.mesh);
      events.emit('block:remove', {
        type: entry.type,
        position: { x: entry.x, y: entry.y, z: entry.z },
      });

      // debris for a handful of blocks only — explosions stay cheap
      if (particles && i < 10) {
        const def = BLOCKS.find((b) => b.id === entry.type);
        // fresh vector per burst — the scratch would be re-mutated next iteration
        particles.burst({
          position: new THREE.Vector3(entry.x + 0.5, entry.y + 0.5, entry.z + 0.5),
          color: def ? def.color : 0x999999,
          count: 8,
          speed: 5,
          life: 0.7,
          size: 0.2,
          gravity: 10,
        });
      }
    }
    doomed.length = 0;
    this._meshListDirty = true;
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  _columnAdd(x, y, z) {
    const key = colKey(x, z);
    let col = this.columns.get(key);
    if (!col) {
      col = [];
      this.columns.set(key, col);
    }
    col.push(y);
  }

  _columnRemove(x, y, z) {
    const key = colKey(x, z);
    const col = this.columns.get(key);
    if (!col) return;
    const idx = col.indexOf(y);
    if (idx !== -1) {
      col[idx] = col[col.length - 1];
      col.pop();
    }
    if (col.length === 0) this.columns.delete(key);
  }

  /** static blocks skip per-frame matrix recomputation */
  _freeze(mesh) {
    mesh.updateMatrix();
    mesh.updateMatrixWorld(); // bake final transform so raycasts stay correct
    mesh.matrixAutoUpdate = false;
  }

  _detachMesh(mesh) {
    this.group.remove(mesh);
    // geometry + materials are shared/cached — never dispose them here
  }
}
