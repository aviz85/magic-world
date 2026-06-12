import * as THREE from 'three';

/**
 * Unicorns 🦄 — a small herd of 3 low-poly unicorns that roam the island.
 *
 * Each unicorn: flat-shaded box body + neck/head, 4 swinging legs, a pastel
 * mane/tail and a golden emissive horn. Behavior is a tiny state machine —
 * WANDER (walk toward a goal point on land) ⇄ GRAZE (head dips, tail swishes).
 * If the player comes within 4 m they startle and trot off to a new goal.
 * Near the camera the horn sheds a soft sparkle stream (skipped beyond 45 m).
 *
 * Contract (matches Wisps/Golems): default export class, constructor(ctx),
 * update(dt, elapsed). Terrain-following via systems.terrain.getHeight; goals
 * never land below ctx.config.waterLevel. No per-frame allocations — all
 * vector math goes through scratch objects.
 *
 * Blast interactions (never lethal): getHitTargets() exposes live body refs
 * so Fireball can detonate on contact, and fx:explosion sends nearby unicorns
 * FLYING — a tumbling ballistic LAUNCHED state with leg-flailing, a bounce,
 * a dust-and-sparkle landing, then an indignant trot away.
 */

const COUNT = 3;
const GOAL_RADIUS = 26;        // m — wander goal pick radius around island center
const WALK_SPEED = 1.6;        // m/s
const TROT_SPEED = 3.4;        // m/s when startled
const TURN_RATE = 2.6;         // rad/s yaw easing
const STARTLE_DIST = 4;        // m — player proximity that spooks them
const GOAL_REACHED = 1.2;      // m
const SPARKLE_INTERVAL = 0.45; // s between horn sparkles per unicorn
const SPARKLE_MAX_DIST_SQ = 45 * 45;

// Blast knockback (fx:explosion) — magical, indignant, never lethal.
const BLAST_REACH = 2.0;       // × blast radius — knockback reaches past the fire
const LAUNCH_GRAVITY = 20;     // m/s² — a touch floatier than the player's 24
const BOUNCE_SPEED = 4;        // |vy| above this on touchdown → one bounce

const BODY_TINTS = [0xfff6fa, 0xf2f6ff, 0xfffdf0]; // blush / ice / cream whites
const MANE_COLORS = [0xff9ad5, 0xc88bff, 0x7fe7ff]; // pink, violet, cyan
const HORN_COLOR = 0xffd66e;

// Tiny seeded PRNG so the herd behaves the same shape every session.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Shared unit geometries (one of each across the whole herd).
let geoBox = null;
let geoHorn = null;
let geoEar = null;
function sharedGeos() {
  if (!geoBox) {
    geoBox = new THREE.BoxGeometry(1, 1, 1);
    geoHorn = new THREE.ConeGeometry(0.06, 0.42, 5);
    geoEar = new THREE.ConeGeometry(0.07, 0.18, 4);
  }
  return { geoBox, geoHorn, geoEar };
}

function flatMat(color, emissive = 0x000000, emissiveIntensity = 0) {
  return new THREE.MeshStandardMaterial({
    color, emissive, emissiveIntensity, roughness: 0.85, flatShading: true,
  });
}

export default class Unicorns {
  constructor(ctx) {
    this.ctx = ctx;
    this._rng = mulberry32(771204);

    this._group = new THREE.Group();
    this._group.name = 'unicorns';
    ctx.scene.add(this._group);

    // Scratch objects — reused every frame, no allocations in update().
    this._v = new THREE.Vector3();
    this._sparkleOpts = {
      position: new THREE.Vector3(),
      color: 0xffffff,
      count: 3, speed: 0.7, life: 0.8, size: 0.14, gravity: 0.6, spread: 0.5,
    };

    this._herd = [];
    // Live body refs for projectile collision (Fireball reads these).
    this._hitTargets = [];
    for (let i = 0; i < COUNT; i++) {
      const u = this._buildUnicorn(i);
      this._herd.push(u);
      this._hitTargets.push({ position: u.root.position, r: 1.1, yOff: 1.0 });
    }

    // Blast reactions — explosions toss the herd, never hurt it.
    this._dustOpts = {
      position: new THREE.Vector3(), color: 0xcbb89a,
      count: 22, speed: 3, life: 0.7, size: 0.26, gravity: 5, spread: 1.4,
    };
    ctx.events.on('fx:explosion', (e) => this._blastToss(e));
  }

  /** Projectile collision contract: array of { position, r, yOff } live refs. */
  getHitTargets() {
    return this._hitTargets;
  }

  // ---------------------------------------------------------------- build

  _buildUnicorn(index) {
    const { geoBox, geoHorn, geoEar } = sharedGeos();
    const bodyMat = flatMat(BODY_TINTS[index % BODY_TINTS.length]);
    const maneColor = MANE_COLORS[index % MANE_COLORS.length];
    const maneMat = flatMat(maneColor, maneColor, 0.25);
    const hornMat = flatMat(HORN_COLOR, HORN_COLOR, 0.8);

    const root = new THREE.Group();

    // Body — origin at ground level, body box floats on the legs.
    const body = new THREE.Mesh(geoBox, bodyMat);
    body.scale.set(0.55, 0.55, 1.1);
    body.position.y = 0.95;
    body.castShadow = true;
    root.add(body);

    // Neck + head, hung on a pivot so grazing dips the whole head assembly.
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 1.15, 0.5);
    root.add(headPivot);

    const neck = new THREE.Mesh(geoBox, bodyMat);
    neck.scale.set(0.22, 0.55, 0.24);
    neck.position.set(0, 0.2, 0.08);
    neck.rotation.x = 0.45;
    neck.castShadow = true;
    headPivot.add(neck);

    const head = new THREE.Mesh(geoBox, bodyMat);
    head.scale.set(0.26, 0.26, 0.5);
    head.position.set(0, 0.48, 0.3);
    head.castShadow = true;
    headPivot.add(head);

    const horn = new THREE.Mesh(geoHorn, hornMat);
    horn.position.set(0, 0.68, 0.38);
    horn.rotation.x = 0.5;
    headPivot.add(horn);

    for (const side of [-1, 1]) {
      const ear = new THREE.Mesh(geoEar, bodyMat);
      ear.position.set(side * 0.1, 0.66, 0.18);
      ear.rotation.z = -side * 0.25;
      headPivot.add(ear);
    }

    // Mane — three glowing chips down the neck.
    for (let i = 0; i < 3; i++) {
      const chip = new THREE.Mesh(geoBox, maneMat);
      chip.scale.set(0.1, 0.18, 0.14);
      chip.position.set(0, 0.34 - i * 0.16, -0.07 + i * 0.04);
      headPivot.add(chip);
    }

    // Tail — pivoted at the rump so it can swish.
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 1.05, -0.58);
    root.add(tailPivot);
    const tail = new THREE.Mesh(geoBox, maneMat);
    tail.scale.set(0.12, 0.5, 0.12);
    tail.position.y = -0.22;
    tailPivot.add(tail);

    // Legs — pivots at the hips, boxes hang down; sin-swing while walking.
    const legs = [];
    const legGeoScale = new THREE.Vector3(0.13, 0.75, 0.13);
    for (const fz of [0.38, -0.38]) {
      for (const sx of [-0.18, 0.18]) {
        const pivot = new THREE.Group();
        pivot.position.set(sx, 0.78, fz);
        const leg = new THREE.Mesh(geoBox, bodyMat);
        leg.scale.copy(legGeoScale);
        leg.position.y = -0.38;
        leg.castShadow = true;
        pivot.add(leg);
        root.add(pivot);
        legs.push(pivot);
      }
    }

    // Spawn scattered around the island center on land.
    const a = this._rng() * Math.PI * 2;
    const r = 8 + this._rng() * 12;
    root.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
    this._group.add(root);

    return {
      root, headPivot, tailPivot, legs,
      hornMat,
      state: 'wander',          // 'wander' | 'graze' | 'startled' | 'launched'
      goal: new THREE.Vector3(root.position.x, 0, root.position.z),
      stateTimer: 1 + this._rng() * 3,
      yaw: this._rng() * Math.PI * 2,
      gait: this._rng() * Math.PI * 2,   // leg-swing phase
      sparkleTimer: this._rng() * SPARKLE_INTERVAL,
      maneColor,
      vel: new THREE.Vector3(), // ballistic velocity while launched
      spinX: 0,                 // tumble rates while airborne
      spinZ: 0,
      bounced: false,
    };
  }

  /** fx:explosion handler — toss every unicorn inside the blast's reach. */
  _blastToss({ position, radius }) {
    const reach = (radius || 3.5) * BLAST_REACH;
    for (let i = 0; i < this._herd.length; i++) {
      const u = this._herd[i];
      const pos = u.root.position;
      const dx = pos.x - position.x;
      const dy = (pos.y + 1) - position.y;
      const dz = pos.z - position.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d > reach) continue;

      const falloff = 1 - d / reach; // 1 at ground zero → 0 at the rim
      // Horizontal direction away from the blast (random if right on top).
      let nx = dx, nz = dz;
      const hl = Math.hypot(nx, nz);
      if (hl < 0.01) {
        const a = this._rng() * Math.PI * 2;
        nx = Math.cos(a); nz = Math.sin(a);
      } else {
        nx /= hl; nz /= hl;
      }
      u.vel.set(
        nx * (5 + 7 * falloff),
        7 + 8 * falloff,        // always clears the ground — the fun part
        nz * (5 + 7 * falloff)
      );
      u.state = 'launched';
      u.stateTimer = 5; // safety net — landing normally ends the state sooner
      u.bounced = false;
      // Guaranteed-visible tumble: magnitude 3-8 rad/s, random direction.
      u.spinX = (this._rng() < 0.5 ? -1 : 1) * (3 + this._rng() * 5);
      u.spinZ = (this._rng() - 0.5) * 5;

      // Indignant sparkle pop off the horn as they go airborne.
      const particles = this.ctx.systems.particles;
      if (particles) {
        this._sparkleOpts.position.set(pos.x, pos.y + 1.8, pos.z);
        this._sparkleOpts.color = u.maneColor;
        particles.burst(this._sparkleOpts);
      }
    }
  }

  _pickGoal(u) {
    const terrain = this.ctx.systems.terrain;
    const waterLevel = this.ctx.config.waterLevel;
    // Up to 8 tries to find a land goal; otherwise stay put this round.
    for (let i = 0; i < 8; i++) {
      const a = this._rng() * Math.PI * 2;
      const r = this._rng() * GOAL_RADIUS;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = terrain ? terrain.getHeight(x, z) : 0;
      if (h > waterLevel + 0.3) {
        u.goal.set(x, h, z);
        return;
      }
    }
    u.goal.copy(u.root.position);
  }

  // ---------------------------------------------------------------- update

  update(dt, elapsed) {
    const sys = this.ctx.systems;
    const terrain = sys.terrain;
    const player = sys.player;
    const particles = sys.particles;
    if (!terrain) return;

    const camPos = this.ctx.camera.position;

    for (let i = 0; i < this._herd.length; i++) {
      const u = this._herd[i];
      const pos = u.root.position;
      u.stateTimer -= dt;

      // ---- airborne (blast-tossed) — ballistic tumble owns the whole frame
      if (u.state === 'launched') {
        this._updateLaunched(u, i, dt, elapsed, camPos);
        continue;
      }

      // ---- startle check ---------------------------------------------------
      if (player && player.position && u.state !== 'startled') {
        const pdx = player.position.x - pos.x;
        const pdz = player.position.z - pos.z;
        if (pdx * pdx + pdz * pdz < STARTLE_DIST * STARTLE_DIST) {
          u.state = 'startled';
          u.stateTimer = 2.5;
          // Flee directly away from the player.
          const fa = Math.atan2(-pdz, -pdx);
          const fr = 10 + this._rng() * 8;
          const gx = pos.x + Math.cos(fa) * fr;
          const gz = pos.z + Math.sin(fa) * fr;
          const gh = terrain.getHeight(gx, gz);
          if (gh > this.ctx.config.waterLevel + 0.3) u.goal.set(gx, gh, gz);
          else this._pickGoal(u);
        }
      }

      // ---- state machine -----------------------------------------------------
      let speed = 0;
      if (u.state === 'graze') {
        if (u.stateTimer <= 0) {
          u.state = 'wander';
          u.stateTimer = 6 + this._rng() * 8;
          this._pickGoal(u);
        }
      } else {
        speed = u.state === 'startled' ? TROT_SPEED : WALK_SPEED;
        const dx = u.goal.x - pos.x;
        const dz = u.goal.z - pos.z;
        const distSq = dx * dx + dz * dz;
        if (distSq < GOAL_REACHED * GOAL_REACHED || u.stateTimer <= 0) {
          u.state = 'graze';
          u.stateTimer = 3 + this._rng() * 5;
          speed = 0;
        } else {
          // Ease yaw toward the goal, walk forward along facing.
          const targetYaw = Math.atan2(dx, dz);
          let dy = targetYaw - u.yaw;
          while (dy > Math.PI) dy -= Math.PI * 2;
          while (dy < -Math.PI) dy += Math.PI * 2;
          const maxTurn = TURN_RATE * dt;
          u.yaw += THREE.MathUtils.clamp(dy, -maxTurn, maxTurn);
          pos.x += Math.sin(u.yaw) * speed * dt;
          pos.z += Math.cos(u.yaw) * speed * dt;
        }
      }

      // ---- terrain following + pose ------------------------------------------
      pos.y = terrain.getHeight(pos.x, pos.z);
      u.root.rotation.y = u.yaw;

      // Legs: diagonal pairs swing in anti-phase while moving, settle when not.
      const moving = speed > 0;
      if (moving) u.gait += dt * (u.state === 'startled' ? 11 : 6.5);
      const swing = moving ? Math.sin(u.gait) * 0.55 : 0;
      u.legs[0].rotation.x = THREE.MathUtils.lerp(u.legs[0].rotation.x, swing, 0.3);
      u.legs[3].rotation.x = THREE.MathUtils.lerp(u.legs[3].rotation.x, swing, 0.3);
      u.legs[1].rotation.x = THREE.MathUtils.lerp(u.legs[1].rotation.x, -swing, 0.3);
      u.legs[2].rotation.x = THREE.MathUtils.lerp(u.legs[2].rotation.x, -swing, 0.3);

      // Head: dip to the grass while grazing, gentle bob while walking.
      const headTarget =
        u.state === 'graze' ? 0.9 + Math.sin(elapsed * 1.1 + i) * 0.06
        : moving ? Math.sin(u.gait * 0.5) * 0.08
        : 0;
      u.headPivot.rotation.x = THREE.MathUtils.lerp(
        u.headPivot.rotation.x, headTarget, 0.08
      );

      // Tail swish — always alive, faster when startled.
      u.tailPivot.rotation.z =
        Math.sin(elapsed * (u.state === 'startled' ? 9 : 2.2) + i * 2) * 0.35;

      // Horn glow breathes slowly.
      u.hornMat.emissiveIntensity = 0.65 + Math.sin(elapsed * 1.7 + i * 1.3) * 0.25;

      // ---- horn sparkle trail (camera-gated) -----------------------------------
      this._hornSparkle(u, pos, camPos, SPARKLE_INTERVAL, dt);
    }
  }

  /** Camera-gated horn sparkle, shared by the ground and airborne paths. */
  _hornSparkle(u, pos, camPos, interval, dt) {
    const particles = this.ctx.systems.particles;
    if (!particles) return;
    u.sparkleTimer -= dt;
    if (u.sparkleTimer > 0) return;
    u.sparkleTimer = interval;
    const cdx = pos.x - camPos.x;
    const cdy = pos.y - camPos.y;
    const cdz = pos.z - camPos.z;
    if (cdx * cdx + cdy * cdy + cdz * cdz >= SPARKLE_MAX_DIST_SQ) return;
    // World-space horn tip (approx): above the head along facing.
    const opts = this._sparkleOpts;
    opts.position.set(
      pos.x + Math.sin(u.yaw) * 0.75,
      pos.y + 1.95,
      pos.z + Math.cos(u.yaw) * 0.75
    );
    opts.color = u.maneColor;
    particles.stream(opts);
  }

  /** Ballistic tumble after a blast: integrate, flail, bounce once, land. */
  _updateLaunched(u, i, dt, elapsed, camPos) {
    const terrain = this.ctx.systems.terrain;
    const particles = this.ctx.systems.particles;
    const pos = u.root.position;

    u.vel.y -= LAUNCH_GRAVITY * dt;
    pos.x += u.vel.x * dt;
    pos.y += u.vel.y * dt;
    pos.z += u.vel.z * dt;

    // Tumble + panicked leg flailing + flaring horn.
    u.root.rotation.x += u.spinX * dt;
    u.root.rotation.z += u.spinZ * dt;
    u.gait += dt * 16;
    const swing = Math.sin(u.gait) * 0.8;
    u.legs[0].rotation.x = swing;
    u.legs[3].rotation.x = swing;
    u.legs[1].rotation.x = -swing;
    u.legs[2].rotation.x = -swing;
    u.tailPivot.rotation.z = Math.sin(elapsed * 13 + i) * 0.6;
    u.hornMat.emissiveIntensity = 1.1;

    // The sparkle trail traces the arc — 3× the idle emit rate.
    this._hornSparkle(u, pos, camPos, SPARKLE_INTERVAL / 3, dt);

    const ground = Math.max(
      terrain.getHeight(pos.x, pos.z),
      this.ctx.config.waterLevel - 0.3 // belly-flops onto water, doesn't sink
    );

    if (pos.y <= ground) {
      pos.y = ground;
      if (u.vel.y > 0.5) {
        // Smacked sideways into a rising slope while still ascending — thud
        // against it (kill most horizontal speed) instead of tunneling through.
        u.vel.x *= 0.2;
        u.vel.z *= 0.2;
        this._dustPuff(pos);
        return; // still ascending — landing happens on the way down
      } else if (!u.bounced && -u.vel.y > BOUNCE_SPEED) {
        // One soft bounce sells the weight without turning them into balls.
        u.bounced = true;
        u.vel.y *= -0.35;
        u.vel.x *= 0.55;
        u.vel.z *= 0.55;
        u.spinX *= 0.5;
        u.spinZ *= 0.5;
        this._dustPuff(pos);
        return;
      }
      // Touchdown: shake it off, trot away indignantly, rejoin herd life.
      u.vel.set(0, 0, 0);
      u.root.rotation.x = 0;
      u.root.rotation.z = 0;
      u.state = 'startled';
      u.stateTimer = 2.5;
      this._pickGoal(u);
      this._dustPuff(pos);
      if (particles) {
        this._sparkleOpts.position.set(pos.x, pos.y + 1.5, pos.z);
        this._sparkleOpts.color = u.maneColor;
        particles.burst(this._sparkleOpts);
      }
    } else if (u.stateTimer <= 0 || pos.y < -40) {
      // Safety net (tossed over the void / numeric weirdness): snap home.
      u.vel.set(0, 0, 0);
      u.root.rotation.x = 0;
      u.root.rotation.z = 0;
      pos.y = Math.max(ground, this.ctx.config.waterLevel + 0.2);
      u.state = 'wander';
      u.stateTimer = 4;
      this._pickGoal(u);
    }
  }

  _dustPuff(pos) {
    const particles = this.ctx.systems.particles;
    if (!particles) return;
    this._dustOpts.position.set(pos.x, pos.y + 0.3, pos.z);
    particles.burst(this._dustOpts);
  }
}
