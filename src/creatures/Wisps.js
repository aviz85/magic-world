import * as THREE from 'three';
import { canvasTexture } from '../core/AssetFactory.js';

/**
 * Wisps — 12 curious glowing lanterns that wander the island.
 *
 * Each wisp is two additive billboard sprites (soft tinted halo + hot white
 * core) hovering 1–5 m above the terrain. Motion = a slow-drifting anchor
 * chasing a goal point, plus layered sinusoidal wander ("curious lantern").
 * At night they gravitate toward crystal clusters; when the player comes
 * within 10 m they do a happy greeting hop, then circle the player's head
 * like fireflies (each with its own direction), shimmering excitedly while
 * keeping a shy 2.5 m bubble. Wisps
 * 0, 4 and 8 carry a real PointLight; the rest glow for free via additive
 * blending. Sparse particle trails, skipped beyond 45 m from the camera.
 *
 * No per-frame allocations: all vector math goes through scratch objects.
 */

const WISP_COUNT = 12;
const PALETTE = [0x7fe7ff, 0xc88bff, 0xff9ad5, 0xffe9a0]; // cyan, violet, pink, gold
const GOLDEN_ANGLE = 2.399963;

const DRIFT_SPEED = 1.4;        // m/s anchor drift toward goal
const PLAYER_NOTICE_DIST = 10;  // m — start following the player
const PLAYER_SHY_DIST = 2.5;    // m — never come closer than this
const ALT_MIN = 1.0;            // m above terrain
const ALT_MAX = 5.0;
const TRAIL_INTERVAL = 0.22;    // s between trail puffs per wisp
const TRAIL_MAX_DIST_SQ = 45 * 45;
const GOAL_RADIUS = 28;         // m — wander goal pick radius

// Tiny seeded PRNG so the flock behaves the same shape every session.
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

export default class Wisps {
  constructor(ctx) {
    this.ctx = ctx;

    this._rng = mulberry32(91173);

    this._group = new THREE.Group();
    this._group.name = 'wisps';
    ctx.scene.add(this._group);

    // ---- Shared sprite assets (1 texture, 5 materials total) -------------
    const glowTex = canvasTexture(64, (c, size) => {
      const half = size / 2;
      const g = c.createRadialGradient(half, half, 0, half, half, half);
      g.addColorStop(0.0, 'rgba(255,255,255,1)');
      g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.55, 'rgba(255,255,255,0.28)');
      g.addColorStop(1.0, 'rgba(255,255,255,0)');
      c.fillStyle = g;
      c.fillRect(0, 0, size, size);
    });

    this._haloMaterials = PALETTE.map(
      (hex) =>
        new THREE.SpriteMaterial({
          map: glowTex,
          color: hex,
          blending: THREE.AdditiveBlending,
          transparent: true,
          opacity: 0.85,
          depthWrite: false,
          fog: false,
        }),
    );
    this._coreMaterial = new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffffff,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      fog: false,
    });

    // ---- Build the flock --------------------------------------------------
    const rand = this._rng;
    const spawnSpread = 36;
    this.wisps = [];
    for (let i = 0; i < WISP_COUNT; i++) {
      const tint = PALETTE[i % 4];
      const phase = i * GOLDEN_ANGLE;

      const holder = new THREE.Group();
      const halo = new THREE.Sprite(this._haloMaterials[i % 4]);
      halo.scale.setScalar(0.55);
      const core = new THREE.Sprite(this._coreMaterial);
      core.scale.setScalar(0.22);
      holder.add(halo);
      holder.add(core);

      let light = null;
      if (i === 0 || i === 4 || i === 8) {
        light = new THREE.PointLight(tint, 1.2, 9, 2);
        light.castShadow = false;
        holder.add(light);
      }

      // Scatter anchors in a loose ring around spawn, off the player's face.
      const ang = phase + rand() * 0.8;
      const r = 10 + rand() * spawnSpread;
      const ax = Math.cos(ang) * r;
      const az = Math.sin(ang) * r;
      const anchor = new THREE.Vector3(ax, 6, az);

      const wisp = {
        holder,
        halo,
        core,
        light,
        tint,
        phase,
        anchor,
        goal: anchor.clone(),
        goalTimer: rand() * 4, // stagger first repicks
        curious: false,
        excite: 0, // 0 calm ↔ 1 excited (smoothed curiosity blend)
        bounce: 0, // greeting hop timer — fires when a wisp first notices you
        orbitDir: rand() < 0.5 ? 1 : -1, // some circle clockwise, some counter
        trailTimer: rand() * TRAIL_INTERVAL,
        baseHalo: 0.5 + rand() * 0.12, // slight size personality
      };
      this.wisps.push(wisp);
      this._group.add(holder);
    }

    // ---- Scratch objects (no per-frame allocs) ----------------------------
    this._vGoalDelta = new THREE.Vector3();
    this._vPos = new THREE.Vector3();
    this._vPush = new THREE.Vector3();
    this._vTrailDir = new THREE.Vector3(0, -0.3, 0);
    this._halfWorld = ctx.config.worldSize / 2 - 4;

    // Explosions spook the flock: wisps near a blast re-goal directly away
    // from it and shimmer with nerves (excite). Ethereal — no physics, the
    // regular anchor drift carries the ghostly retreat.
    ctx.events.on('fx:explosion', ({ position, radius }) => {
      const reach = (radius || 3.5) * 4; // skittish — react well beyond the fire
      for (let i = 0; i < this.wisps.length; i++) {
        const w = this.wisps[i];
        const hp = w.holder.position;
        const dx = hp.x - position.x;
        const dz = hp.z - position.z;
        const d = Math.hypot(dx, dz);
        if (d > reach || d < 0.001) continue;
        w.goal.set(hp.x + (dx / d) * 14, hp.y + 2 + (i % 3), hp.z + (dz / d) * 14);
        this._clampGoal(w.goal);
        w.goalTimer = 7;
        w.excite = 1;
      }
    });
  }

  // -------------------------------------------------------------------------

  _pickGoal(wisp, night) {
    const rand = this._rng;
    const sys = this.ctx.systems;
    const goal = wisp.goal;

    // At night, 60% chance: drift to the nearest crystal cluster.
    if (night && rand() < 0.6) {
      const crystals = sys.vegetation && sys.vegetation.crystalPositions;
      if (crystals && crystals.length > 0) {
        let best = null;
        let bestD = Infinity;
        const a = wisp.anchor;
        for (let i = 0; i < crystals.length; i++) {
          const c = crystals[i];
          const dx = c.x - a.x;
          const dz = c.z - a.z;
          const d = dx * dx + dz * dz;
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        if (best) {
          const ang = rand() * Math.PI * 2;
          const r = 1 + rand() * 2; // random 3 m offset around the cluster
          goal.set(
            best.x + Math.cos(ang) * r,
            best.y + 1 + rand() * 2,
            best.z + Math.sin(ang) * r,
          );
          this._clampGoal(goal);
          wisp.goalTimer = 6 + rand() * 5;
          return;
        }
      }
    }

    // Default: meander — random point within GOAL_RADIUS of the anchor.
    const ang = rand() * Math.PI * 2;
    const r = 6 + rand() * (GOAL_RADIUS - 6);
    goal.set(
      wisp.anchor.x + Math.cos(ang) * r,
      0,
      wisp.anchor.z + Math.sin(ang) * r,
    );
    this._clampGoal(goal);
    const terrain = this.ctx.systems.terrain;
    const h = terrain ? terrain.getHeight(goal.x, goal.z) : 0;
    const floor = Math.max(h, this.ctx.config.waterLevel);
    goal.y = floor + ALT_MIN + 0.5 + rand() * 3;
    wisp.goalTimer = 6 + rand() * 5;
  }

  _clampGoal(goal) {
    const hw = this._halfWorld;
    if (goal.x > hw) goal.x = hw;
    else if (goal.x < -hw) goal.x = -hw;
    if (goal.z > hw) goal.z = hw;
    else if (goal.z < -hw) goal.z = -hw;
  }

  // -------------------------------------------------------------------------

  update(dt, elapsed) {
    const sys = this.ctx.systems;
    const terrain = sys.terrain;
    const player = sys.player;
    const particles = sys.particles;
    const sky = sys.sky;
    if (!terrain || !player) return;

    const night = !!(sky && sky.isNight && sky.isNight());
    const playerPos = player.position; // feet
    const camPos = this.ctx.camera.position;

    const dGoal = this._vGoalDelta;
    const pos = this._vPos;
    const push = this._vPush;

    for (let i = 0; i < this.wisps.length; i++) {
      const w = this.wisps[i];
      const anchor = w.anchor;
      const phase = w.phase;

      // ---- Player curiosity: notice within 10 m (horizontal-ish) ---------
      const pdx = playerPos.x - anchor.x;
      const pdy = playerPos.y + 1.4 - anchor.y;
      const pdz = playerPos.z - anchor.z;
      const playerDistSq = pdx * pdx + pdy * pdy + pdz * pdz;
      const curious = playerDistSq < PLAYER_NOTICE_DIST * PLAYER_NOTICE_DIST;

      if (curious) {
        if (!w.curious) w.bounce = 1; // first noticed you — happy greeting hop!
        // Circle the player's head like a curious firefly — each wisp keeps
        // its own angle (phase) and direction, so the flock forms a loose,
        // living halo instead of a single clump.
        const orbA = elapsed * 0.85 * w.orbitDir + phase;
        w.goal.set(
          playerPos.x + Math.cos(orbA) * 3.1,
          playerPos.y + 1.9 + Math.sin(elapsed * 1.3 + phase * 2) * 0.6,
          playerPos.z + Math.sin(orbA) * 3.1,
        );
        w.curious = true;
      } else {
        if (w.curious) {
          // Player wandered off — lose interest, pick something new soon.
          w.curious = false;
          w.goalTimer = Math.min(w.goalTimer, 0.5 + this._rng() * 1.5);
        }
        w.goalTimer -= dt;
        if (w.goalTimer <= 0) this._pickGoal(w, night);
      }

      // ---- Anchor drifts toward the goal at a constant gentle pace -------
      dGoal.subVectors(w.goal, anchor);
      const goalDist = dGoal.length();
      if (goalDist > 0.25) {
        const step = Math.min(goalDist, DRIFT_SPEED * dt * (w.curious ? 1.35 : 1));
        anchor.addScaledVector(dGoal, step / goalDist);
      }

      // ---- Shy bubble: never crowd the player -----------------------------
      push.set(anchor.x - playerPos.x, 0, anchor.z - playerPos.z);
      const flatDistSq = push.x * push.x + push.z * push.z;
      if (flatDistSq < PLAYER_SHY_DIST * PLAYER_SHY_DIST) {
        const flatDist = Math.sqrt(flatDistSq);
        if (flatDist > 1e-4) {
          const need = PLAYER_SHY_DIST - flatDist;
          anchor.addScaledVector(push, (need / flatDist) * Math.min(1, dt * 6));
        } else {
          // Dead center — flee along the wisp's own phase direction.
          anchor.x += Math.cos(phase) * PLAYER_SHY_DIST * dt * 6;
          anchor.z += Math.sin(phase) * PLAYER_SHY_DIST * dt * 6;
        }
      }

      // ---- Excitement blend + greeting hop ---------------------------------
      w.excite += ((w.curious ? 1 : 0) - w.excite) * Math.min(1, dt * 3);
      let bounceY = 0;
      if (w.bounce > 0) {
        // diminishing double-hop: bob amplitude decays as the timer runs out
        bounceY = Math.sin(w.bounce * Math.PI * 3) * 0.45 * w.bounce;
        w.bounce = Math.max(0, w.bounce - dt * 1.3);
      }

      // ---- Layered sinusoidal wander on top of the anchor -----------------
      pos.set(
        anchor.x + Math.sin(elapsed * 0.9 + phase) * 1.1,
        anchor.y + Math.sin(elapsed * 1.7 + phase * 2) * 0.45 + bounceY,
        anchor.z + Math.cos(elapsed * 0.7 + phase) * 1.1,
      );

      // ---- Altitude clamp: hover 1–5 m above the ground (or water) --------
      // Effective floor = whichever is higher: terrain or the water surface
      // (terrain dips below waterLevel near the island rim — without the max,
      // hi would land underwater and the clamp would drown the wisp).
      const ground = terrain.getHeight(pos.x, pos.z);
      const floorBase =
        ground > -50
          ? Math.max(ground, this.ctx.config.waterLevel)
          : this.ctx.config.waterLevel;
      const lo = floorBase + ALT_MIN;
      const hi = floorBase + ALT_MAX;
      if (pos.y < lo) {
        pos.y = lo;
        if (anchor.y < lo) anchor.y += (lo + 0.6 - anchor.y) * Math.min(1, dt * 2);
      } else if (pos.y > hi) {
        pos.y = hi;
        if (anchor.y > hi) anchor.y += (hi - 0.6 - anchor.y) * Math.min(1, dt * 2);
      }

      w.holder.position.copy(pos);

      // ---- Breathing pulse: size + light on a shared sine ------------------
      // Excited wisps add a fast shimmer on top of the calm breath — they
      // visibly flutter when they're checking you out.
      const pulse =
        1 +
        0.18 * Math.sin(elapsed * 3.1 + phase) +
        0.14 * w.excite * Math.sin(elapsed * 9.0 + phase * 3);
      const haloS = w.baseHalo * pulse * (night ? 1.18 : 1) * (1 + 0.12 * w.excite);
      w.halo.scale.set(haloS, haloS, 1);
      const coreS = 0.22 * (0.85 + 0.15 * pulse);
      w.core.scale.set(coreS, coreS, 1);
      if (w.light) {
        w.light.intensity =
          (1.2 + 0.4 * Math.sin(elapsed * 3.1 + phase) + 0.5 * w.excite) *
          (night ? 1.25 : 0.85);
      }

      // ---- Sparse trail (denser when excited, skip when far from camera) ---
      w.trailTimer -= dt;
      if (w.trailTimer <= 0) {
        w.trailTimer += w.curious ? TRAIL_INTERVAL * 0.5 : TRAIL_INTERVAL;
        if (particles) {
          const cdx = pos.x - camPos.x;
          const cdy = pos.y - camPos.y;
          const cdz = pos.z - camPos.z;
          if (cdx * cdx + cdy * cdy + cdz * cdz < TRAIL_MAX_DIST_SQ) {
            particles.stream({
              position: pos,
              direction: this._vTrailDir,
              color: w.tint,
              count: 2,
              speed: 0.6,
              life: 0.7,
              size: 0.16,
            });
          }
        }
      }
    }

    // Halo opacity breathes up at night for the whole flock (4 materials).
    const haloOpacity = night ? 0.95 : 0.8;
    for (let m = 0; m < this._haloMaterials.length; m++) {
      const mat = this._haloMaterials[m];
      mat.opacity += (haloOpacity - mat.opacity) * Math.min(1, dt * 1.5);
    }
  }
}
