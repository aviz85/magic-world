import * as THREE from 'three';
import Fireball from './spells/Fireball.js';
import GrowTree from './spells/GrowTree.js';
import LightOrb from './spells/LightOrb.js';
import Terraform from './spells/Terraform.js';
import Blink from './spells/Blink.js';
import Portal from './spells/Portal.js';
import SummonGolem from './spells/SummonGolem.js';
import TimeWarp from './spells/TimeWarp.js';
import Conjure from './spells/Conjure.js';

/**
 * SpellManager — the arcane conductor.
 *
 * Owns: spell roster (keys 1–9), mana pool + regen, per-spell cooldowns,
 * the Magic/Build mode toggle (B), selection (number keys + wheel),
 * camera-center raycast castInfo construction, and the active-effect loop.
 *
 * Contract notes (binding):
 *  - Cast succeeds (mana deducted, cooldown started, `spell:cast` emitted)
 *    unless the spell sets `castInfo.cancelled = true` before returning —
 *    that is the refund rule: cancelled casts cost nothing and start no cooldown.
 *  - A truthy return from `spell.cast()` is an effect object `{ update(dt) => bool }`;
 *    it is ticked every frame until it returns falsy (it cleans itself up).
 *  - `getState()` is read by the HUD every frame, so the returned object and its
 *    `spells` array are cached and mutated in place — zero per-frame allocations.
 */

const SPELL_CLASSES = [
  Fireball,
  GrowTree,
  LightOrb,
  Terraform,
  Blink,
  Portal,
  SummonGolem,
  TimeWarp,
  Conjure,
];

const MANA_MAX = 100;
const MANA_REGEN = 7; // per second
const CAST_RAY_MAX = 60; // meters

export default class SpellManager {
  constructor(ctx) {
    this.ctx = ctx;

    // ---- mana ----
    this.mana = MANA_MAX;
    this.manaMax = MANA_MAX;

    // ---- mode & selection ----
    this.mode = 'magic';
    this.selected = 0;

    // ---- roster ----
    // Instantiate each spell defensively: one broken spell file must not
    // take the other eight down with it.
    this.spells = [];
    this.cooldownLeft = new Float32Array(SPELL_CLASSES.length);
    for (let i = 0; i < SPELL_CLASSES.length; i++) {
      const SpellClass = SPELL_CLASSES[i];
      let instance = null;
      try {
        instance = new SpellClass(ctx);
      } catch (err) {
        console.error(`[SpellManager] failed to construct spell "${SpellClass?.id ?? i}"`, err);
      }
      this.spells.push(instance);
    }

    // ---- active effects (swap-remove list, no per-frame allocation) ----
    this.effects = [];

    // ---- cached HUD state (mutated in place every getState call) ----
    this._state = {
      mode: this.mode,
      mana: this.mana,
      manaMax: this.manaMax,
      selected: this.selected,
      spells: SPELL_CLASSES.map((S, i) => ({
        id: S.id ?? `spell${i + 1}`,
        label: S.label ?? `Spell ${i + 1}`,
        icon: S.icon ?? '✨',
        manaCost: S.manaCost ?? 0,
        cooldownLeft: 0,
        cooldown: S.cooldown ?? 0,
      })),
    };

    // ---- scratch objects (reused across casts/frames) ----
    this._raycaster = new THREE.Raycaster();
    this._raycaster.far = CAST_RAY_MAX;
    this._dir = new THREE.Vector3();
    this._origin = new THREE.Vector3();
    this._announced = false;

    // ---- impact camera shake (internal juice channel for spells) ----------
    // Spells call ctx.systems.spells.addShake(amount) on heavy beats. The
    // offset is applied AFTER the player controller has positioned the camera
    // this frame (spells update later in the system order) and is implicitly
    // reset next frame when the controller rewrites the camera transform —
    // zero cleanup, zero allocations.
    this._shake = 0;
    this._shakeSeed = 0;

    // ---- input wiring ----
    const events = ctx.events;
    events.on('input:keydown', (p) => this._onKeyDown(p));
    events.on('input:wheel', (p) => this._onWheel(p));
    events.on('input:mousedown', (p) => this._onMouseDown(p));
  }

  // ------------------------------------------------------------------ input

  _onKeyDown({ code }) {
    if (code === 'KeyB') {
      this.mode = this.mode === 'magic' ? 'build' : 'magic';
      this.ctx.events.emit('mode:change', { mode: this.mode });
      return;
    }
    if (this.mode !== 'magic') return;
    // Digit1..Digit9 → slot 0..8
    if (code.length === 6 && code.startsWith('Digit')) {
      const n = code.charCodeAt(5) - 49; // '1' → 0
      if (n >= 0 && n < this.spells.length) this._select(n);
    }
  }

  _onWheel({ deltaY }) {
    if (this.mode !== 'magic') return;
    if (!this.ctx.input.pointerLocked) return;
    const len = this.spells.length;
    const step = deltaY > 0 ? 1 : -1;
    this._select((this.selected + step + len) % len);
  }

  _select(index) {
    if (index === this.selected && this._announced) return;
    this.selected = index;
    this._emitSelect();
  }

  _emitSelect() {
    const S = SPELL_CLASSES[this.selected];
    this._announced = true;
    this.ctx.events.emit('spell:select', {
      index: this.selected,
      id: S.id,
      label: S.label,
      icon: S.icon,
    });
  }

  _onMouseDown({ button }) {
    // Input only emits this while pointer-locked, but stay defensive.
    if (this.mode !== 'magic') return;
    if (button !== 0 && button !== 2) return;
    this._tryCast(button === 2);
  }

  // ------------------------------------------------------------------- cast

  _tryCast(alt) {
    const i = this.selected;
    const spell = this.spells[i];
    if (!spell) return;
    const S = SPELL_CLASSES[i];

    if (this.cooldownLeft[i] > 0) return; // still channeling the last one

    const manaCost = S.manaCost ?? 0;
    if (this.mana < manaCost) {
      this.ctx.events.emit('mana:insufficient', { id: S.id });
      return;
    }

    const castInfo = this._buildCastInfo(alt);

    let effect = null;
    try {
      effect = spell.cast(castInfo);
    } catch (err) {
      console.error(`[SpellManager] cast error in "${S.id}"`, err);
      return; // treat a throwing spell as a fizzle — no mana lost
    }

    // Refund rule: a spell that aborts sets castInfo.cancelled = true.
    // Cancelled casts cost nothing and start no cooldown.
    if (castInfo.cancelled) return;

    this.mana -= manaCost;
    this.cooldownLeft[i] = S.cooldown ?? 0;
    if (effect) this.effects.push(effect);

    this.ctx.events.emit('spell:cast', { id: S.id, position: castInfo.hitPoint });
  }

  /**
   * Raycast from the camera center against terrain + placed blocks
   * (max 60m) and assemble the castInfo handed to the spell.
   * origin/direction are fresh clones — spells may keep them.
   */
  _buildCastInfo(alt) {
    const camera = this.ctx.camera;
    camera.getWorldPosition(this._origin);
    camera.getWorldDirection(this._dir);

    this._raycaster.ray.origin.copy(this._origin);
    this._raycaster.ray.direction.copy(this._dir);

    let hitPoint = null;
    let hitNormal = null;
    let hitObject = null;

    const targets = this._collectRayTargets();
    if (targets.length > 0) {
      const hits = this._raycaster.intersectObjects(targets, false);
      if (hits.length > 0) {
        const hit = hits[0];
        hitPoint = hit.point.clone();
        hitObject = hit.object;
        if (hit.face) {
          hitNormal = hit.face.normal.clone();
          // bring the normal into world space (blocks may be transformed)
          hitNormal.transformDirection(hit.object.matrixWorld);
        }
      }
    }

    return {
      origin: this._origin.clone(),
      direction: this._dir.clone(),
      hitPoint,
      hitNormal,
      hitObject,
      alt,
      cancelled: false,
    };
  }

  _collectRayTargets() {
    // Casting is rare (user clicks) — a small per-cast array is fine and keeps
    // us decoupled from BuildSystem internals.
    const systems = this.ctx.systems;
    const targets = [];
    const terrainMesh = systems.terrain?.mesh;
    if (terrainMesh) targets.push(terrainMesh);
    const build = systems.build;
    if (build && typeof build.getMeshes === 'function') {
      const meshes = build.getMeshes();
      for (let i = 0; i < meshes.length; i++) targets.push(meshes[i]);
    }
    return targets;
  }

  // ------------------------------------------------------------------ frame

  update(dt /*, elapsed */) {
    // Announce initial mode/selection once everything (HUD included) exists.
    if (!this._announced) {
      this.ctx.events.emit('mode:change', { mode: this.mode });
      this._emitSelect();
    }

    // Mana regen — a calm, steady 7/s.
    if (this.mana < this.manaMax) {
      this.mana = Math.min(this.manaMax, this.mana + MANA_REGEN * dt);
    }

    // Cooldowns tick down.
    const cds = this.cooldownLeft;
    for (let i = 0; i < cds.length; i++) {
      if (cds[i] > 0) cds[i] = Math.max(0, cds[i] - dt);
    }

    // Tick active effects; swap-remove finished ones (no allocation).
    const effects = this.effects;
    for (let i = effects.length - 1; i >= 0; i--) {
      let alive = false;
      try {
        alive = effects[i].update(dt);
      } catch (err) {
        console.error('[SpellManager] effect update error', err);
        alive = false;
      }
      if (!alive) {
        effects[i] = effects[effects.length - 1];
        effects.pop();
      }
    }

    // Impact camera shake — decaying band-limited jitter applied on top of
    // the player-controlled camera transform (rewritten by the controller
    // next frame, so this self-cleans). Cheap trig noise, no allocations.
    if (this._shake > 0.001) {
      this._shakeSeed += dt * 31; // fast pseudo-random phase walk
      const s = this._shake;
      const cam = this.ctx.camera;
      const k = this._shakeSeed;
      cam.position.x += Math.sin(k * 1.7) * Math.sin(k * 3.1) * s * 0.12;
      cam.position.y += Math.sin(k * 2.3) * Math.cos(k * 1.3) * s * 0.10;
      cam.position.z += Math.cos(k * 1.9) * Math.sin(k * 2.7) * s * 0.12;
      cam.rotation.z += Math.sin(k * 4.1) * s * 0.006;
      // Exponential decay (~0.25s half-life) — punchy attack, smooth tail.
      this._shake *= Math.max(0, 1 - dt * 5.5);
      if (this._shake < 0.001) this._shake = 0;
    }
  }

  /**
   * Internal juice API used by the spells (not part of the public contract):
   * kick the camera with `amount` (≈0.2 subtle … 1 cataclysmic). Stacks are
   * clamped so chained explosions can't fling the view around.
   */
  addShake(amount) {
    this._shake = Math.min(1.2, this._shake + amount);
  }

  // -------------------------------------------------------------------- HUD

  /**
   * Read by the HUD every frame. Returns a cached object mutated in place —
   * do not hold references to previous values across frames.
   */
  getState() {
    const s = this._state;
    s.mode = this.mode;
    s.mana = this.mana;
    s.manaMax = this.manaMax;
    s.selected = this.selected;
    const cds = this.cooldownLeft;
    const list = s.spells;
    for (let i = 0; i < list.length; i++) {
      list[i].cooldownLeft = cds[i];
    }
    return s;
  }
}
