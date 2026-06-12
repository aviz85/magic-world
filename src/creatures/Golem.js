import * as THREE from 'three';

/**
 * Golems — stone golem manager for Magic World.
 *
 * Contract (docs/CONTRACTS.md):
 *   - default export class `Golems`, constructor(ctx), update(dt, elapsed)
 *   - `count` property (live golems), `spawn(position)` → false when full (max 5)
 *   - spawn rises from the ground with a dust burst + emits 'golem:spawn'
 *   - follow-player AI (walk when > 7 m, stop at 3.5 m), walk speed 3.5 m/s
 *   - leg/arm swing walk cycle, idle sway + occasional head turns
 *   - feet glued to terrain (+ build support as a bonus), castShadow on parts
 *
 * Art direction (docs/design/creatures-fx.md): box-built ~2.2 m stone bodies,
 * flat-shaded gray with per-golem tint jitter, cyan rune eyes + chest rune.
 */

const MAX_GOLEMS = 5;
const WALK_SPEED = 3.5;
const FOLLOW_START = 7.0;   // start walking when farther than this
const FOLLOW_STOP = 3.5;    // stop walking when closer than this
const RISE_TIME = 1.2;      // spawn rise duration (s)
const RISE_DEPTH = 2.2;     // how far below ground the golem starts
const RUNE_COLOR = 0x7fe7ff;
const DUST_COLOR = 0x9c8f7a;
const STONE_COLOR = 0x8a8f99;

// ---- shared geometry (built once, reused by every golem part) -------------
const GEO = {
  pelvis: new THREE.BoxGeometry(0.7, 0.35, 0.5),
  torso: new THREE.BoxGeometry(0.9, 0.8, 0.6),
  head: new THREE.BoxGeometry(0.5, 0.45, 0.45),
  arm: new THREE.BoxGeometry(0.28, 0.7, 0.28),
  fist: new THREE.BoxGeometry(0.34, 0.34, 0.34),
  leg: new THREE.BoxGeometry(0.3, 0.9, 0.32),
  eye: new THREE.BoxGeometry(0.09, 0.06, 0.02),
  rune: new THREE.BoxGeometry(0.14, 0.14, 0.02),
  shard: new THREE.BoxGeometry(0.16, 0.24, 0.16),
};

// One glowing rune material shared by all golems. toneMapped:false makes the
// cyan punch through ACES tone mapping like a real ember of magic.
const RUNE_MATERIAL = new THREE.MeshBasicMaterial({ color: RUNE_COLOR, toneMapped: false });

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const smoothstep = (t) => t * t * (3 - 2 * t);

export default class Golems {
  constructor(ctx) {
    this.ctx = ctx;
    this.golems = [];           // internal list (minimap reads positions defensively)
    this.root = new THREE.Group();
    this.root.name = 'golems';
    ctx.scene.add(this.root);

    // scratch objects — never allocate in the per-frame hot loop
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._color = new THREE.Color();
  }

  /** Number of live golems. */
  get count() {
    return this.golems.length;
  }

  /** Alias so other modules can iterate the herd defensively. */
  get list() {
    return this.golems;
  }

  /**
   * Projectile collision contract (see Fireball._gatherTargets):
   * array of { position, r, yOff } live refs. Golems are broad stone bodies —
   * a fireball detonates against them; the blast doesn't move them (stone).
   */
  getHitTargets() {
    const arr = this._hitArr || (this._hitArr = []);
    arr.length = 0;
    for (let i = 0; i < this.golems.length; i++) {
      const t = this.golems[i].hitTarget;
      if (t) arr.push(t);
    }
    return arr;
  }

  /**
   * Summon a golem at `position` (Vector3 or {x,y,z}-like). It claws its way
   * up out of the earth over ~1.2 s in a plume of dust.
   * Returns false when the herd is full (max 5), true on success.
   */
  spawn(position) {
    if (this.golems.length >= MAX_GOLEMS) return false;

    const cfg = this.ctx.config;
    const half = cfg.worldSize / 2 - 2;
    const x = THREE.MathUtils.clamp(position.x, -half, half);
    const z = THREE.MathUtils.clamp(position.z, -half, half);
    const terrain = this.ctx.systems.terrain;
    const groundY = terrain ? terrain.getHeight(x, z) : (position.y || 0);

    const seed = Math.random() * Math.PI * 2;
    const golem = this._buildGolem(seed);
    golem.groundY = groundY;
    golem.group.position.set(x, groundY - RISE_DEPTH, z);
    golem.group.rotation.y = Math.random() * Math.PI * 2;
    golem.position = golem.group.position; // convenient public handle
    golem.hitTarget = { position: golem.group.position, r: 1.35, yOff: 1.3 };
    this.root.add(golem.group);
    this.golems.push(golem);

    // Eruption dust at the feet (design-spec preset).
    const particles = this.ctx.systems.particles;
    if (particles && particles.burst) {
      this._v1.set(x, groundY + 0.15, z);
      particles.burst({
        position: this._v1,
        color: DUST_COLOR,
        count: 40,
        speed: 4,
        life: 1.2,
        size: 0.4,
        gravity: 9,
      });
    }

    this.ctx.events.emit('golem:spawn', { position: new THREE.Vector3(x, groundY, z) });
    return true;
  }

  // ---- construction --------------------------------------------------------

  _buildGolem(seed) {
    // Per-golem stone tint jitter (±0x0a per channel around 0x8a8f99).
    const j = () => (Math.random() * 2 - 1) * (10 / 255);
    this._color.setHex(STONE_COLOR);
    this._color.r = THREE.MathUtils.clamp(this._color.r + j(), 0, 1);
    this._color.g = THREE.MathUtils.clamp(this._color.g + j(), 0, 1);
    this._color.b = THREE.MathUtils.clamp(this._color.b + j(), 0, 1);
    const stone = new THREE.MeshStandardMaterial({
      color: this._color.getHex(),
      roughness: 0.95,
      metalness: 0.05,
      flatShading: true,
    });

    const part = (geo, x, y, z, parent) => {
      const m = new THREE.Mesh(geo, stone);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };

    const group = new THREE.Group();

    // Body group pivots at the pelvis (y 1.05 from feet) so bob/roll feel right.
    const body = new THREE.Group();
    body.position.y = 1.05;
    group.add(body);

    part(GEO.pelvis, 0, 0, 0, body);            // pelvis @ y1.05
    const torso = part(GEO.torso, 0, 0.55, 0, body); // torso @ y1.6
    torso.rotation.y = (Math.random() - 0.5) * 0.06; // slightly off-square stonework

    // Chest rune (front of torso).
    const chestRune = new THREE.Mesh(GEO.rune, RUNE_MATERIAL);
    chestRune.position.set(0, 0.55, 0.31);
    body.add(chestRune);

    // Head pivots at the neck (y 1.95), head center at y 2.15.
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0.9, 0);
    body.add(headPivot);
    part(GEO.head, 0, 0.2, 0, headPivot);

    // Rune eyes on the head front.
    const eyeL = new THREE.Mesh(GEO.eye, RUNE_MATERIAL);
    eyeL.position.set(-0.12, 0.24, 0.235);
    const eyeR = new THREE.Mesh(GEO.eye, RUNE_MATERIAL);
    eyeR.position.set(0.12, 0.24, 0.235);
    headPivot.add(eyeL, eyeR);

    // Arms: shoulder pivots at (±0.62, 1.85, 0) → body-local y 0.8.
    const armL = new THREE.Group();
    armL.position.set(-0.62, 0.8, 0);
    body.add(armL);
    part(GEO.arm, 0, -0.35, 0, armL);
    part(GEO.fist, 0, -0.87, 0, armL);

    const armR = new THREE.Group();
    armR.position.set(0.62, 0.8, 0);
    body.add(armR);
    part(GEO.arm, 0, -0.35, 0, armR);
    part(GEO.fist, 0, -0.87, 0, armR);

    // Mossy rubble shards on the shoulders/back — each golem reads unique.
    for (let i = 0; i < 3; i++) {
      const s = part(
        GEO.shard,
        (Math.random() - 0.5) * 0.9,
        0.95 + Math.random() * 0.15,
        -0.1 - Math.random() * 0.2,
        body
      );
      s.rotation.set(Math.random() * 0.8, Math.random() * Math.PI, Math.random() * 0.8);
      const sc = 0.6 + Math.random() * 0.8;
      s.scale.setScalar(sc);
    }

    // Legs: hip pivots at (±0.24, 1.0, 0) on the root (legs don't bob with torso).
    const legL = new THREE.Group();
    legL.position.set(-0.24, 1.0, 0);
    group.add(legL);
    part(GEO.leg, 0, -0.45, 0, legL);

    const legR = new THREE.Group();
    legR.position.set(0.24, 1.0, 0);
    group.add(legR);
    part(GEO.leg, 0, -0.45, 0, legR);

    return {
      group,
      body,
      headPivot,
      armL,
      armR,
      legL,
      legR,
      eyeL,
      eyeR,
      chestRune,
      seed,
      position: group.position,
      groundY: 0,
      riseT: 0,             // 0..1 spawn-rise progress
      rising: true,
      riseDustTimer: 0,
      walking: false,
      walkPhase: Math.random() * Math.PI * 2,
      moveBlend: 0,         // 0 idle ↔ 1 walking (animation crossfade)
      prevStepSin: 0,
      stepCooldown: 0,
      stompDip: 0,          // body squash on each footfall — sells the weight
      fidget: 0,            // 0..1 blend for the curious arm-raise gesture
      playerNear: 0,        // 0..1 — runes brighten when the player is close
      // idle head-turn state machine
      headTimer: 2 + Math.random() * 5,
      headTarget: 0,
      headYaw: 0,
      headHold: 0,
    };
  }

  // ---- per-frame ------------------------------------------------------------

  update(dt, elapsed) {
    const n = this.golems.length;
    if (n === 0) return;

    const terrain = this.ctx.systems.terrain;
    const build = this.ctx.systems.build;
    const player = this.ctx.systems.player;
    const particles = this.ctx.systems.particles;
    const camPos = this.ctx.camera.position;

    for (let i = 0; i < n; i++) {
      const g = this.golems[i];
      const pos = g.group.position;

      // ---- spawn rise -------------------------------------------------------
      if (g.rising) {
        g.riseT = Math.min(1, g.riseT + dt / RISE_TIME);
        const e = easeOutCubic(g.riseT);
        pos.y = g.groundY - RISE_DEPTH * (1 - e);
        // earthquake shudder that settles as it surfaces
        g.group.rotation.z = (1 - e) * 0.05 * Math.sin(elapsed * 42 + g.seed);
        // crumbling dirt while emerging
        g.riseDustTimer -= dt;
        if (g.riseDustTimer <= 0 && particles && particles.burst) {
          g.riseDustTimer = 0.12;
          this._v1.set(
            pos.x + (Math.random() - 0.5) * 0.9,
            g.groundY + 0.1,
            pos.z + (Math.random() - 0.5) * 0.9
          );
          particles.burst({
            position: this._v1,
            color: DUST_COLOR,
            count: 4,
            speed: 1.6,
            life: 0.7,
            size: 0.3,
            gravity: 8,
          });
        }
        this._pulseRunes(g, elapsed, 1); // runes blaze while clawing out of the earth
        if (g.riseT >= 1) {
          g.rising = false;
          g.group.rotation.z = 0;
          // settling stomp puff
          if (particles && particles.burst) {
            this._v1.set(pos.x, g.groundY + 0.1, pos.z);
            particles.burst({
              position: this._v1,
              color: DUST_COLOR,
              count: 14,
              speed: 2.2,
              life: 0.8,
              size: 0.34,
              gravity: 8,
            });
          }
        }
        continue;
      }

      // ---- follow-player AI -------------------------------------------------
      let moving = false;
      let playerDist = Infinity;
      if (player && player.position) {
        const dx = player.position.x - pos.x;
        const dz = player.position.z - pos.z;
        const dist = Math.hypot(dx, dz);
        playerDist = dist;

        // hysteresis: start chasing past 7 m, settle at 3.5 m
        if (dist > FOLLOW_START) g.walking = true;
        else if (dist < FOLLOW_STOP) g.walking = false;

        if (g.walking && dist > 1e-4) {
          moving = true;
          const heading = Math.atan2(dx, dz);
          this._turnToward(g.group, heading, dt);
          const step = Math.min(WALK_SPEED * dt, Math.max(0, dist - FOLLOW_STOP));
          pos.x += (dx / dist) * step;
          pos.z += (dz / dist) * step;
        } else if (dist < FOLLOW_START && dist > 1e-4) {
          // stopped but attentive — keep facing the player
          this._turnToward(g.group, Math.atan2(dx, dz), dt * 0.5);
        }
      }

      // gentle separation so the herd never stacks into one mega-golem
      for (let k = i + 1; k < n; k++) {
        const o = this.golems[k];
        if (o.rising) continue;
        const ox = pos.x - o.group.position.x;
        const oz = pos.z - o.group.position.z;
        const d2 = ox * ox + oz * oz;
        if (d2 > 1e-6 && d2 < 1.96) { // < 1.4 m apart
          const d = Math.sqrt(d2);
          const push = ((1.4 - d) / d) * 0.5 * Math.min(1, dt * 8);
          pos.x += ox * push;
          pos.z += oz * push;
          o.group.position.x -= ox * push;
          o.group.position.z -= oz * push;
        }
      }

      // keep inside the world rim
      const half = this.ctx.config.worldSize / 2 - 2;
      pos.x = THREE.MathUtils.clamp(pos.x, -half, half);
      pos.z = THREE.MathUtils.clamp(pos.z, -half, half);

      // ---- terrain-glued feet (build support as bonus) -----------------------
      let ground = terrain ? terrain.getHeight(pos.x, pos.z) : pos.y;
      if (build && build.getSupportHeight) {
        const sup = build.getSupportHeight(pos.x, pos.z, pos.y + 0.6);
        if (sup > ground && sup !== -Infinity) ground = sup;
      }
      pos.y += (ground - pos.y) * Math.min(1, dt * 10);

      // ---- animation ---------------------------------------------------------
      const blendTarget = moving ? 1 : 0;
      g.moveBlend += (blendTarget - g.moveBlend) * Math.min(1, dt * 6);
      const b = g.moveBlend;

      // lumbering gait — slower, wider strides than a human; reads HEAVY
      if (b > 0.001) g.walkPhase += dt * 5.6 * Math.max(0.25, b);
      const swing = Math.sin(g.walkPhase);

      // legs swing in opposite phases; arms counter-swing their same-side leg
      g.legL.rotation.x = swing * 0.65 * b;
      g.legR.rotation.x = -swing * 0.65 * b;
      g.armL.rotation.x = -swing * 0.45 * b;
      g.armR.rotation.x = swing * 0.45 * b;

      const idle = 1 - b;
      const idleSway = Math.sin(elapsed * 0.8 + g.seed);

      // curious fidget: while peering sideways, the golem slowly raises the
      // arm on the side it's looking toward — a wordless "hmm?"
      g.fidget += ((g.headHold > 0 && b < 0.3 ? 1 : 0) - g.fidget) * Math.min(1, dt * 4);
      if (g.headYaw < -0.1) g.armL.rotation.x -= 0.5 * g.fidget * idle;
      else if (g.headYaw > 0.1) g.armR.rotation.x -= 0.5 * g.fidget * idle;

      // arms flare slightly outward while striding, hang with a breath drift idle
      g.armL.rotation.z = 0.06 + 0.07 * b + idleSway * 0.02 * idle;
      g.armR.rotation.z = -0.06 - 0.07 * b - idleSway * 0.02 * idle;

      // torso: heavy double-beat bob with a footfall squash, forward lean and
      // shoulder counter-twist while striding; breathing + slow weight shift idle
      g.stompDip *= Math.max(0, 1 - Math.min(1, dt * 8));
      g.body.position.y =
        1.05 +
        Math.abs(swing) * 0.08 * b -
        g.stompDip * b +
        Math.sin(elapsed * 1.1 + g.seed) * 0.015 * idle;
      g.body.position.x = Math.sin(elapsed * 0.4 + g.seed) * 0.03 * idle;
      g.body.rotation.z = swing * 0.05 * b + idleSway * 0.025 * idle;
      g.body.rotation.x = (0.07 + Math.sin(g.walkPhase * 2) * 0.02) * b;
      g.body.rotation.y = swing * 0.1 * b;

      // ---- occasional curious head turns when stopped ------------------------
      if (b < 0.3) {
        g.headTimer -= dt;
        if (g.headTimer <= 0) {
          g.headTarget = (Math.random() * 2 - 1) * 0.6;
          g.headHold = 0.8 + Math.random() * 1.2;
          g.headTimer = 4 + Math.random() * 3;
        }
        if (g.headHold > 0) {
          g.headHold -= dt;
          if (g.headHold <= 0) g.headTarget = 0;
        }
      } else {
        g.headTarget = 0;
        g.headHold = 0;
      }
      const ht = Math.min(1, dt * 5);
      g.headYaw += (g.headTarget - g.headYaw) * smoothstep(ht);
      g.headPivot.rotation.y = g.headYaw;
      // tiny head nod while striding
      g.headPivot.rotation.x = Math.sin(g.walkPhase * 2) * 0.03 * b;

      // ---- rune glow pulse (brightens when the player stands close) ----------
      g.playerNear +=
        ((playerDist < 6 ? 1 - playerDist / 6 : 0) - g.playerNear) * Math.min(1, dt * 3);
      this._pulseRunes(g, elapsed, g.playerNear);

      // ---- footfall: stomp squash + dust --------------------------------------
      g.stepCooldown -= dt;
      if (b > 0.5 && g.stepCooldown <= 0) {
        // a foot plants when sin(walkPhase) crosses zero
        if (g.prevStepSin !== 0 && Math.sign(swing) !== Math.sign(g.prevStepSin)) {
          g.stompDip = 0.055; // the body sinks into the planted foot
          g.stepCooldown = 0.2;
          if (particles && particles.burst) {
            const camD2 =
              (pos.x - camPos.x) * (pos.x - camPos.x) +
              (pos.z - camPos.z) * (pos.z - camPos.z);
            if (camD2 < 1225) { // only within 35 m of the camera
              const side = swing > 0 ? -0.26 : 0.26;
              this._v2.set(side, 0.06, 0.18);
              g.group.localToWorld(this._v2);
              particles.burst({
                position: this._v2,
                color: DUST_COLOR,
                count: 8,
                speed: 2.0,
                life: 0.7,
                size: 0.3,
                gravity: 8,
              });
            }
          }
        }
      }
      g.prevStepSin = swing;
    }
  }

  // ---- helpers ---------------------------------------------------------------

  /** Rune glow pulse; `near` (0..1) swells eyes + chest when the player is close. */
  _pulseRunes(g, elapsed, near = 0) {
    const s = 1 + near * 0.3 + (0.25 + 0.2 * near) * Math.sin(elapsed * 2.4 + g.seed);
    g.eyeL.scale.setScalar(s);
    g.eyeR.scale.setScalar(s);
    g.chestRune.scale.setScalar(
      1 + near * 0.25 + 0.18 * Math.sin(elapsed * 2.4 + g.seed + 1.7)
    );
  }

  _turnToward(group, heading, dt) {
    let d = heading - group.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d)); // shortest arc
    group.rotation.y += d * Math.min(1, dt * 6);
  }
}
