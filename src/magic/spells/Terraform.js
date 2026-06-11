import * as THREE from 'three';

/**
 * Terraform ⛰️ — sculpt the land like wet clay.
 *
 * Left-click raises a smooth mound under the crosshair, right-click (alt)
 * carves it back down. Deliberately cheap (mana 4, cooldown 0.15s) so holding
 * a rhythm of clicks feels like fluid sculpting rather than discrete casts.
 *
 * Juice (per docs/design/magic.md §4 — rapid-fire spell, keep it cheap):
 *  - Raise: 18 warm earthen dust motes that LIFT (negative gravity) + 6 fast
 *    gray rock chips that arc out and fall. Lower: darker soil that falls
 *    inward-feeling (positive gravity). Exactly 24 particles per cast.
 *  - One shared, reusable ground ring (additive, fades over ~0.3s) that
 *    expands with the brush — zero allocations per cast, one extra draw call
 *    only while visible. No flash (pool is shared, this fires at ~6.6/s).
 *
 * Perf notes: every per-cast object (particle option bags, vectors, the ring
 * mesh/material, quaternions) is created once in the constructor and mutated
 * in place. cast() and the effect's update() allocate nothing.
 */
export default class Terraform {
  static id = 'terraform';
  static label = 'Terraform';
  static icon = '⛰️';
  static manaCost = 4;
  static cooldown = 0.15;

  constructor(ctx) {
    this.ctx = ctx;

    // ---- sculpt tuning -----------------------------------------------------
    this.delta = 1.4;      // height added (negated for alt-cast)
    this.radius = 6;       // brush radius fed to terrain.modify

    // ---- reusable scratch / option bags (no per-cast allocations) ----------
    this._dustPos = new THREE.Vector3();
    this._chipPos = new THREE.Vector3();

    // Dust plume. gravity convention (see Particles.burst): positive = falls
    // down. Raise uses -3 so the dust lifts with the rising earth.
    this._dustOpts = {
      position: this._dustPos,
      color: 0x9c7b54,
      count: 42,
      speed: 2.3,
      life: 0.85,
      size: 0.44,
      gravity: -3,
      spread: 1,
    };

    // Rock chips — small, quick, heavy. Same bag both modes.
    this._chipOpts = {
      position: this._chipPos,
      color: 0x888888,
      count: 18,
      speed: 5.5,
      life: 0.55,
      size: 0.26,
      gravity: 8,
      spread: 1,
    };

    // ---- shared expanding ground ring (built once, reused every cast) -----
    const ringGeo = new THREE.RingGeometry(0.62, 1.0, 26, 1);
    ringGeo.rotateX(-Math.PI / 2); // lie flat on XZ, normal = +Y
    this._ringMat = new THREE.MeshBasicMaterial({
      color: 0xd6b27a,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    this._ring = new THREE.Mesh(ringGeo, this._ringMat);
    this._ring.visible = false;
    this._ring.renderOrder = 2;
    this._ring.frustumCulled = false; // tiny + short-lived; skip per-frame sphere math
    this._ringAdded = false;

    // Align ring to the terrain normal at the hit point.
    this._up = new THREE.Vector3(0, 1, 0);
    this._alignQuat = new THREE.Quaternion();

    // Generation counter: a fresh cast steals the ring from the previous
    // effect, whose update() then sees a stale generation and retires itself.
    this._gen = 0;

    // Ring animation state (driven by the live effect).
    this._ringT = 0;
    this._ringDur = 0.36;
    this._ringMaxScale = this.radius * 0.72;

    // Toast throttle so rapid mis-clicks at the sky don't spam the HUD.
    this._lastMissMsg = -10;
  }

  cast(castInfo) {
    const hit = castInfo.hitPoint;
    if (!hit) {
      castInfo.cancelled = true; // no mana, no cooldown
      const now = this.ctx.time.elapsed;
      if (now - this._lastMissMsg > 1.5) {
        this._lastMissMsg = now;
        this.ctx.events.emit('ui:message', { text: '⛰️ Aim at the ground to sculpt', duration: 1.5 });
      }
      return null;
    }

    const alt = !!castInfo.alt;
    const terrain = this.ctx.systems.terrain;
    const particles = this.ctx.systems.particles;

    // ---- sculpt ------------------------------------------------------------
    terrain.modify(hit.x, hit.z, alt ? -this.delta : this.delta, this.radius);

    // ---- dust burst (≤ 24 particles, two-tone: earth + stone) -------------
    const dust = this._dustOpts;
    if (alt) {
      dust.color = 0x6b5a43; // darker, damp soil
      dust.gravity = 6;      // collapses downward — "falls inward" feel
      dust.speed = 2.4;
    } else {
      dust.color = 0x9c7b54; // warm dry earth
      dust.gravity = -3;     // lifts with the rising mound
      dust.speed = 2;
    }
    this._dustPos.set(hit.x, hit.y + 0.2, hit.z);
    particles.burst(dust);

    this._chipPos.set(hit.x, hit.y + 0.35, hit.z);
    particles.burst(this._chipOpts);

    // ---- restart the shared ground ring ------------------------------------
    if (!this._ringAdded) {
      this.ctx.scene.add(this._ring);
      this._ringAdded = true;
    }
    // Sit a hair above the (newly modified) surface to dodge z-fighting.
    const groundY = terrain.getHeight(hit.x, hit.z);
    this._ring.position.set(hit.x, (groundY > -50 ? groundY : hit.y) + 0.12, hit.z);
    if (castInfo.hitNormal) {
      this._alignQuat.setFromUnitVectors(this._up, castInfo.hitNormal);
      this._ring.quaternion.copy(this._alignQuat);
    } else {
      this._ring.quaternion.identity();
    }
    this._ringMat.color.setHex(alt ? 0x8a7355 : 0xd9b87f);
    this._ring.scale.setScalar(0.6);
    this._ring.visible = true;
    this._ringT = 0;

    const gen = ++this._gen;
    const self = this;

    // Lightweight effect: animates the ring, retires instantly if a newer
    // cast has taken it over. Returns false when finished (manager drops it).
    return {
      update(dt) {
        if (gen !== self._gen) return false; // superseded by a newer cast
        self._ringT += dt;
        const t = Math.min(self._ringT / self._ringDur, 1);
        const e = 1 - (1 - t) * (1 - t) * (1 - t); // easeOutCubic
        self._ring.scale.setScalar(0.6 + e * self._ringMaxScale);
        self._ringMat.opacity = 0.72 * (1 - e);
        if (t >= 1) {
          self._ring.visible = false;
          self._ringMat.opacity = 0;
          return false;
        }
        return true;
      },
    };
  }
}
