import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Fireball 🔥 — glowing projectile + light + trail, slight arc, spectacular
// two-stage impact (white snap → orange bloom), fx:explosion + terrain scorch.
//
// Choreography follows docs/design/magic.md §1 beat-for-beat.
// Performance notes:
//  - Sphere geometry + material are created ONCE per spell class and shared.
//  - Meshes/PointLights are pooled and recycled across casts (no dispose churn).
//  - All hot-loop math uses scratch vectors / reusable param objects on `this`.
// ---------------------------------------------------------------------------

const SPEED = 38;          // m/s initial speed
const GRAVITY = 4;         // m/s^2 downward arc (gentle — it's magic)
const MAX_LIFE = 4;        // s before mid-air detonation
const HIT_DIST = 0.3;      // collision skin vs terrain (sphere r = 0.28)
const IMPACT_END = 1.6;    // s of post-impact effect life
const SUBSTEPS = 3;        // anti-tunneling at 38 m/s

// easing helpers (local, per spec — no libs)
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;

export default class Fireball {
  static id = 'fireball';
  static label = 'Fireball';
  static icon = '🔥';
  static manaCost = 15;
  static cooldown = 0.6;

  constructor(ctx) {
    this.ctx = ctx;

    // -- shared render resources (created once, never disposed mid-game) ----
    this._geometry = new THREE.SphereGeometry(0.28, 12, 10);
    // toneMapped: false → the ball stays a saturated hot orange instead of
    // being dulled by the renderer's ACES tone mapping (it must read as emissive).
    this._material = new THREE.MeshBasicMaterial({ color: 0xff5500, toneMapped: false });

    // -- mesh/light pools (recycled across casts) ---------------------------
    this._meshPool = [];
    this._lightPool = [];

    // -- scratch objects (NEVER allocate in update loops) -------------------
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();

    // -- reusable particle param objects (mutated, used synchronously) ------
    this._trailParams = {
      position: new THREE.Vector3(), direction: new THREE.Vector3(),
      color: 0xff8833, count: 9, speed: 2.4, life: 0.55, size: 0.28,
    };
    this._emberParams = {
      position: new THREE.Vector3(), direction: new THREE.Vector3(),
      color: 0xffdd55, count: 2, speed: 1, life: 0.7, size: 0.12,
    };
    this._burstParams = {
      position: new THREE.Vector3(),
      color: 0xffaa33, count: 12, speed: 4, life: 0.3, size: 0.2,
      gravity: 0, spread: 0.4,
    };

    // -- shared impact shockwave ring (built once, restarted per impact) ----
    // A flat additive ring that races outward along the ground — the visual
    // "thump" that sells the explosion's scale. Generation counter: a newer
    // impact steals the ring, the older effect simply stops ticking it.
    const ringGeo = new THREE.RingGeometry(0.55, 1.0, 28, 1);
    ringGeo.rotateX(-Math.PI / 2);
    this._ringMat = new THREE.MeshBasicMaterial({
      color: 0xffaa44, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    this._ring = new THREE.Mesh(ringGeo, this._ringMat);
    this._ring.visible = false;
    this._ring.renderOrder = 2;
    this._ring.frustumCulled = false;
    this._ringAdded = false;
    this._ringGen = 0;
    this._ringT = 0;
    this._ringDur = 0.55;
    this._ringMaxScale = 6.2;

    // scratch for distance-scaled camera shake (no per-impact allocations)
    this._shakeVec = new THREE.Vector3();
  }

  /** Impact punch: camera shake scaled by proximity to the blast. */
  _kick(pos, base) {
    const spells = this.ctx.systems.spells;
    if (!spells || typeof spells.addShake !== 'function') return;
    const player = this.ctx.systems.player;
    let falloff = 0.5;
    if (player && player.position) {
      const d = this._shakeVec.copy(pos).sub(player.position).length();
      falloff = Math.max(0, 1 - d / 32); // full punch up close, fades by 32m
    }
    if (falloff > 0.02) spells.addShake(base * falloff);
  }

  /** Restart the shared shockwave ring at `pos`; returns the new generation. */
  _startRing(pos) {
    if (!this._ringAdded) {
      this.ctx.scene.add(this._ring);
      this._ringAdded = true;
    }
    this._ring.position.set(pos.x, pos.y + 0.15, pos.z);
    this._ring.scale.setScalar(0.4);
    this._ringMat.opacity = 0.85;
    this._ring.visible = true;
    this._ringT = 0;
    return ++this._ringGen;
  }

  /** Advance the ring animation (called only by the generation that owns it). */
  _tickRing(dt) {
    this._ringT += dt;
    const t = Math.min(this._ringT / this._ringDur, 1);
    const e = 1 - (1 - t) * (1 - t) * (1 - t); // easeOutCubic
    this._ring.scale.setScalar(0.4 + e * this._ringMaxScale);
    this._ringMat.opacity = 0.85 * (1 - e);
    if (t >= 1) {
      this._ring.visible = false;
      this._ringMat.opacity = 0;
    }
  }

  // -------------------------------------------------------------- pooling --
  _acquireMesh() {
    const mesh = this._meshPool.pop() ||
      new THREE.Mesh(this._geometry, this._material);
    mesh.visible = true;
    return mesh;
  }

  _acquireLight() {
    let light = this._lightPool.pop();
    if (!light) {
      light = new THREE.PointLight(0xff7733, 3.2, 12);
      light.castShadow = false; // a flying shadow-caster would wreck the budget
    }
    light.visible = true;
    light.intensity = 3.2;
    return light;
  }

  _release(mesh, light) {
    const scene = this.ctx.scene;
    if (mesh) {
      scene.remove(mesh);
      mesh.visible = false;
      this._meshPool.push(mesh);
    }
    if (light) {
      scene.remove(light);
      light.visible = false;
      this._lightPool.push(light);
    }
  }

  // helper: one radial burst via the reusable params object
  _burst(particles, pos, color, count, speed, life, size, gravity, spread) {
    const p = this._burstParams;
    p.position.copy(pos);
    p.color = color; p.count = count; p.speed = speed;
    p.life = life; p.size = size; p.gravity = gravity; p.spread = spread;
    particles.burst(p);
  }

  // ----------------------------------------------------------------- cast --
  cast(castInfo) {
    const { ctx } = this;
    const particles = ctx.systems.particles;
    const terrain = ctx.systems.terrain;
    if (!particles || !terrain) { castInfo.cancelled = true; return null; }

    const origin = castInfo.origin;
    const dir = this._v1.copy(castInfo.direction).normalize();

    // Spawn at the muzzle: 1.2m in front of the eye, slightly below center
    // so the ball reads as thrown from the hand, not the forehead.
    const muzzle = this._v2.copy(origin).addScaledVector(dir, 1.2);
    muzzle.y -= 0.15;

    // -- muzzle beat (t = 0): hot snap so the cast itself feels explosive ----
    particles.flash(muzzle, 0xffcc66, 6.5, 0.13);
    this._burst(particles, muzzle, 0xffaa33, 36, 6, 0.35, 0.26, 0, 0.5);
    this._burst(particles, muzzle, 0xffffff, 10, 2.5, 0.2, 0.15, 0, 0.4);

    // -- projectile ----------------------------------------------------------
    const mesh = this._acquireMesh();
    mesh.position.copy(muzzle);
    mesh.scale.setScalar(0.1);
    const light = this._acquireLight();
    light.position.copy(muzzle);
    ctx.scene.add(mesh);
    ctx.scene.add(light);

    const spell = this;
    const halfWorld = ctx.config.worldSize * 0.75; // generous out-of-bounds

    // Effect state — one small object per cast (cast-time allocation is fine;
    // everything inside update() reuses spell scratch objects).
    const fx = {
      mesh,
      light,
      velocity: new THREE.Vector3().copy(dir).multiplyScalar(SPEED),
      hitPoint: castInfo.hitPoint ? castInfo.hitPoint.clone() : null,
      t: 0,             // flight clock
      spawnT: 0,        // birth pop clock
      trailT: 0,
      emberT: 0,
      phase: 0,         // 0 = flying, 1 = impact sequence, 2 = done
      impactT: 0,
      impactPos: new THREE.Vector3(),
      grounded: false,  // did we strike near terrain (controls the scorch)
      beat: 0,          // next impact beat index
      ringGen: 0,       // shockwave-ring ownership (0 = none)

      update(dt) {
        if (this.phase === 2) return false;
        if (this.phase === 1) return this._updateImpact(dt);
        return this._updateFlight(dt);
      },

      // ---------------------------------------------------------- flight --
      _updateFlight(dt) {
        this.t += dt;

        // birth pop: 0.1 → 1 over 0.08s with easeOutBack overshoot (~1.15)
        if (this.spawnT < 0.08) {
          this.spawnT += dt;
          const k = Math.min(this.spawnT / 0.08, 1);
          this.mesh.scale.setScalar(0.1 + 0.9 * easeOutBack(k));
        }

        // integrate with substeps so 38 m/s can't tunnel through a ridge
        const sub = dt / SUBSTEPS;
        for (let i = 0; i < SUBSTEPS; i++) {
          this.velocity.y -= GRAVITY * sub;
          this.mesh.position.addScaledVector(this.velocity, sub);

          const p = this.mesh.position;

          // terrain strike
          const h = terrain.getHeight(p.x, p.z);
          if (h > -99 && p.y - h <= HIT_DIST) {
            spell._v3.set(p.x, h + 0.12, p.z);
            this._beginImpact(spell._v3, true);
            return true;
          }
          // aimed-target strike (covers blocks the manager raycast found)
          if (this.hitPoint && p.distanceToSquared(this.hitPoint) < 0.25) {
            const groundH = terrain.getHeight(this.hitPoint.x, this.hitPoint.z);
            this._beginImpact(this.hitPoint, this.hitPoint.y - groundH < 1.0);
            return true;
          }
        }

        const p = this.mesh.position;

        // fizzle silently when far out of the world
        if (p.y < -60 || Math.abs(p.x) > halfWorld || Math.abs(p.z) > halfWorld) {
          spell._release(this.mesh, this.light);
          this.phase = 2;
          return false;
        }

        // mid-air detonation at max life (still spectacular, no scorch)
        if (this.t >= MAX_LIFE) {
          this._beginImpact(p, false);
          return true;
        }

        // living-flame pulse: ±8% at 14 Hz on top of the birth scale
        if (this.spawnT >= 0.08) {
          this.mesh.scale.setScalar(1 + 0.08 * Math.sin(this.t * 14 * Math.PI * 2));
        }

        // light follows + flickers 2.8–3.7 (hot, alive)
        this.light.position.copy(p);
        this.light.intensity = 2.8 + Math.random() * 0.9;

        // trail: flame puffs every 0.03s, golden embers every 0.09s
        this.trailT += dt;
        this.emberT += dt;
        if (this.trailT >= 0.03) {
          this.trailT -= 0.03;
          const tp = spell._trailParams;
          tp.position.copy(p);
          tp.direction.copy(this.velocity).multiplyScalar(-1).normalize();
          particles.stream(tp);
        }
        if (this.emberT >= 0.09) {
          this.emberT -= 0.09;
          const ep = spell._emberParams;
          ep.position.copy(p);
          ep.direction.copy(this.velocity).multiplyScalar(-1).normalize();
          ep.direction.y += 0.5; // embers drift upward off the tail
          particles.stream(ep);
        }

        return true;
      },

      // ---------------------------------------------------------- impact --
      _beginImpact(pos, grounded) {
        this.impactPos.copy(pos);
        this.grounded = grounded;
        this.phase = 1;
        this.impactT = 0;
        this.beat = 1; // beat 0 fires immediately below

        // t = 0ms: hide the ball, kill its light, white snap frame + hot core
        // + the camera kick — the impact must be FELT, not just seen.
        spell._release(this.mesh, this.light);
        this.mesh = null;
        this.light = null;
        particles.flash(this.impactPos, 0xffffff, 11, 0.1);
        spell._burst(particles, this.impactPos, 0xffdd33, 110, 15, 0.6, 0.52, 2, 1);
        spell._kick(this.impactPos, 0.55);
        if (this.grounded) this.ringGen = spell._startRing(this.impactPos);
      },

      _updateImpact(dt) {
        this.impactT += dt;
        const t = this.impactT;
        const pos = this.impactPos;

        // shockwave ring races outward while we own it
        if (this.ringGen !== 0 && this.ringGen === spell._ringGen) {
          spell._tickRing(dt);
        }

        // t = 30ms: orange halo bloom + lingering orange flash
        if (this.beat === 1 && t >= 0.03) {
          this.beat = 2;
          spell._burst(particles, pos, 0xff6622, 140, 9.5, 1.0, 0.58, 5, 1);
          spell._v3.copy(pos);
          spell._v3.y += 1;
          particles.flash(spell._v3, 0xff7733, 8.5, 0.5);
        }
        // t = 60ms: the world reacts — explosion event + terrain scorch dip
        // + a ground-hugging shockwave of fast sparks racing outward
        if (this.beat === 2 && t >= 0.06) {
          this.beat = 3;
          ctx.events.emit('fx:explosion', {
            position: pos.clone(), radius: 3.5, color: 0xff6622,
          });
          if (this.grounded) {
            terrain.modify(pos.x, pos.z, -0.4, 2.5);
            spell._burst(particles, pos, 0xffcc88, 60, 19, 0.32, 0.32, 14, 1.6);
          }
        }
        // t = 100ms: roaring fire column punches straight up out of the crater
        // + the smoke starts to rise around it.
        if (this.beat === 3 && t >= 0.1) {
          this.beat = 4;
          spell._burst(particles, pos, 0xff8833, 36, 7, 0.7, 0.42, -9, 0.25);
          spell._burst(particles, pos, 0x554433, 50, 2.5, 1.8, 0.65, -1.5, 1);
        }
        // t = 300ms: lingering embers raining back down through the smoke
        if (this.beat === 4 && t >= 0.3) {
          this.beat = 5;
          spell._burst(particles, pos, 0xffaa44, 44, 1.7, 1.7, 0.18, 3, 1);
        }

        if (t >= IMPACT_END) {
          this.phase = 2;
          return false;
        }
        return true;
      },
    };

    return fx;
  }
}
