import * as THREE from 'three';

// ---------------------------------------------------------------------------
// LightOrb 💡 — a floating mote of warm light.
//
// Contract (docs/CONTRACTS.md + docs/design/magic.md §3):
//   - Emissive sphere + PointLight at hitPoint + (0, 2.5, 0), or 6 m ahead
//     when nothing was hit.
//   - Gentle bob, 40 s life with a 3 s fade-out, then a tiny white pop.
//   - Max 6 live orbs — casting a 7th pops the oldest (same white pop).
//   - Alt-cast: the orb follows the player, hovering above the shoulder.
// ---------------------------------------------------------------------------

const ORB_LIFE = 40; // seconds
const FADE_TIME = 3; // final seconds spent fading out
const MAX_ORBS = 6;

const BIRTH_TIME = 0.25; // scale-in duration
const BOB_AMP = 0.18; // metres
const BOB_HZ = 0.5;
const BREATHE_HZ = 0.3;
const LIGHT_BASE = 2.3; // breathes 2.0 – 2.6
const LIGHT_AMP = 0.3;
const MOTE_PERIOD = 0.5; // falling sparkle cadence

const CORE_COLOR = 0xfff2cc; // warm white core
const HALO_COLOR = 0x99eeff; // cool cyan aura
const LIGHT_COLOR = 0xffeedd;

// Easing helpers (local, no libs — per design doc)
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const easeInQuad = (t) => t * t;

// Module-level scratch (shared across all orbs — never allocated per frame)
const _target = new THREE.Vector3();
const _motePos = new THREE.Vector3();
const _DOWN = new THREE.Vector3(0, -1, 0);
const _UP = new THREE.Vector3(0, 1, 0);
// Reusable falling-mote stream options — mutated in place, used synchronously.
const _moteOpts = {
  position: _motePos, direction: _DOWN, color: 0xaaddff,
  count: 2, speed: 0.4, life: 1, size: 0.1,
};

// Shared geometry — one allocation for the whole class, all orbs reuse it.
let _coreGeo = null;
let _haloGeo = null;
function getGeometries() {
  if (!_coreGeo) {
    _coreGeo = new THREE.SphereGeometry(0.18, 16, 12);
    _haloGeo = new THREE.SphereGeometry(0.18, 12, 8);
  }
  return { core: _coreGeo, halo: _haloGeo };
}

// ---------------------------------------------------------------------------

class OrbEffect {
  /**
   * @param {object} ctx     — game context
   * @param {THREE.Vector3} position — world spawn position (copied)
   * @param {boolean} follow — alt-cast: hover above the player's shoulder
   */
  constructor(ctx, position, follow) {
    this.ctx = ctx;
    this.follow = follow;
    this.age = 0;
    this.moteTimer = MOTE_PERIOD * 0.5;
    this.done = false;
    this.bobPhase = Math.random() * Math.PI * 2;

    // Anchor: the orb bobs around this point (follow mode retargets it).
    this.anchor = position.clone();

    const { core, halo } = getGeometries();

    // Core — bright, warm, opaque-ish glow heart.
    this.coreMat = new THREE.MeshBasicMaterial({
      color: CORE_COLOR,
      transparent: true,
      opacity: 1,
    });
    this.mesh = new THREE.Mesh(core, this.coreMat);

    // Halo — additive cyan shell, slightly larger, reads as bloom on any GPU.
    this.haloMat = new THREE.MeshBasicMaterial({
      color: HALO_COLOR,
      transparent: true,
      opacity: 0.32,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.halo = new THREE.Mesh(halo, this.haloMat);
    this.halo.scale.setScalar(2.1);
    this.mesh.add(this.halo);

    this.light = new THREE.PointLight(LIGHT_COLOR, LIGHT_BASE, 17, 2);
    this.mesh.add(this.light);

    this.mesh.position.copy(this.anchor);
    this.mesh.scale.setScalar(0.01);
    ctx.scene.add(this.mesh);

    // Birth beat — cool cyan bloom + a warm snap of light so each summon
    // visibly kisses the surroundings, plus a tight white core snap and a
    // rising sparkle column so the orb's arrival reads as a tiny sunrise.
    const particles = ctx.systems.particles;
    if (particles) {
      particles.flash(this.anchor, LIGHT_COLOR, 5.5, 0.4);
      particles.burst({
        position: this.anchor,
        color: HALO_COLOR,
        count: 56,
        speed: 3.6,
        life: 0.85,
        size: 0.21,
      });
      particles.burst({
        position: this.anchor,
        color: 0xffffff,
        count: 22,
        speed: 1.8,
        life: 0.45,
        size: 0.14,
      });
      _motePos.copy(this.anchor);
      _motePos.y -= 0.4;
      particles.stream({
        position: _motePos,
        direction: _UP,
        color: CORE_COLOR,
        count: 14,
        speed: 3.8,
        life: 0.65,
        size: 0.19,
      });
    }
  }

  /** Force-evict: white pop + tiny flash, immediate cleanup. */
  pop() {
    if (this.done) return;
    const particles = this.ctx.systems.particles;
    if (particles) {
      particles.flash(this.mesh.position, 0xffffff, 4.5, 0.2);
      particles.burst({
        position: this.mesh.position,
        color: 0xffffff,
        count: 42,
        speed: 4.5,
        life: 0.5,
        size: 0.15,
      });
      // Glitter rains gently out of the dying light.
      particles.burst({
        position: this.mesh.position,
        color: HALO_COLOR,
        count: 26,
        speed: 1.4,
        life: 1.3,
        size: 0.13,
        gravity: 2.5,
        spread: 1,
      });
    }
    this.dispose();
  }

  dispose() {
    if (this.done) return;
    this.done = true;
    this.ctx.scene.remove(this.mesh);
    this.coreMat.dispose();
    this.haloMat.dispose();
    this.light.dispose();
  }

  /** @returns {boolean} true while alive (SpellManager effect protocol). */
  update(dt) {
    if (this.done) return false;

    this.age += dt;
    if (this.age >= ORB_LIFE) {
      this.pop();
      return false;
    }

    const t = this.age;
    const pos = this.mesh.position;

    // --- Follow mode: glide to a point above the player's shoulder ---------
    if (this.follow) {
      const player = this.ctx.systems.player;
      if (player && player.position) {
        const yaw = player.yaw || 0;
        // right = (cos yaw, 0, -sin yaw); forward = (-sin yaw, 0, -cos yaw)
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);
        const fx = -Math.sin(yaw);
        const fz = -Math.cos(yaw);
        _target.set(
          player.position.x + rx * 0.6 - fx * 0.25,
          player.position.y + 2.25, // above the shoulder
          player.position.z + rz * 0.6 - fz * 0.25
        );
        // Springy lag — the orb trails the player like a loyal familiar.
        const k = Math.min(1, dt * 4.5);
        this.anchor.lerp(_target, k);
      }
    }

    // --- Bob + birth scale ---------------------------------------------------
    const bob = Math.sin(t * Math.PI * 2 * BOB_HZ + this.bobPhase) * BOB_AMP;
    pos.set(this.anchor.x, this.anchor.y + bob, this.anchor.z);

    let scale = 1;
    if (t < BIRTH_TIME) {
      scale = Math.max(0.01, easeOutBack(t / BIRTH_TIME));
    }

    // --- Breathe + fade ------------------------------------------------------
    const breathe = LIGHT_BASE + Math.sin(t * Math.PI * 2 * BREATHE_HZ) * LIGHT_AMP;
    let fade = 1;
    const remaining = ORB_LIFE - t;
    if (remaining < FADE_TIME) {
      fade = easeInQuad(remaining / FADE_TIME);
    }

    this.mesh.scale.setScalar(scale * (0.85 + 0.15 * fade));
    this.light.intensity = breathe * fade;
    this.coreMat.opacity = fade;
    this.haloMat.opacity = 0.32 * fade;
    // Gentle halo shimmer — keeps the orb feeling alive without extra cost.
    this.halo.scale.setScalar(2.1 + Math.sin(t * 3.1 + this.bobPhase) * 0.18);

    // --- Falling motes -------------------------------------------------------
    this.moteTimer -= dt;
    if (this.moteTimer <= 0 && fade > 0.25) {
      this.moteTimer += MOTE_PERIOD;
      const particles = this.ctx.systems.particles;
      if (particles) {
        _motePos.copy(pos);
        _motePos.y -= 0.12;
        particles.stream(_moteOpts);
      }
    }

    return true;
  }
}

// ---------------------------------------------------------------------------

export default class LightOrb {
  static id = 'lightorb';
  static label = 'Light Orb';
  static icon = '💡';
  static manaCost = 10;
  static cooldown = 0.5;

  constructor(ctx) {
    this.ctx = ctx;
    /** @type {OrbEffect[]} live orbs, oldest first */
    this.orbs = [];
    this._spawnPos = new THREE.Vector3();
  }

  /**
   * @param {{ origin: THREE.Vector3, direction: THREE.Vector3,
   *           hitPoint: THREE.Vector3|null, alt: boolean }} castInfo
   * @returns {OrbEffect|null}
   */
  cast(castInfo) {
    // Where the orb is born.
    if (castInfo.alt) {
      // Familiar mode — spawn right at the shoulder so it never lerps across the map.
      const player = this.ctx.systems.player;
      if (player && player.position) {
        this._spawnPos.set(
          player.position.x,
          player.position.y + 2.25,
          player.position.z
        );
      } else {
        this._spawnPos.copy(castInfo.origin).addScaledVector(castInfo.direction, 1.5);
      }
    } else if (castInfo.hitPoint) {
      this._spawnPos.copy(castInfo.hitPoint);
      this._spawnPos.y += 2.5;
    } else {
      this._spawnPos.copy(castInfo.origin).addScaledVector(castInfo.direction, 6);
    }

    // Prune any orbs that already finished on their own.
    let live = 0;
    for (let i = 0; i < this.orbs.length; i++) {
      if (!this.orbs[i].done) this.orbs[live++] = this.orbs[i];
    }
    this.orbs.length = live;

    // Room for one more — evict the oldest with a sparkle pop.
    while (this.orbs.length >= MAX_ORBS) {
      const oldest = this.orbs.shift();
      oldest.pop(); // its manager-side update() will return false next frame
    }

    const orb = new OrbEffect(this.ctx, this._spawnPos, !!castInfo.alt);
    this.orbs.push(orb);
    return orb; // SpellManager drives orb.update(dt)
  }
}
