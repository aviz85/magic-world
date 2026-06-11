import * as THREE from 'three';

/**
 * GrowTree 🌳 — nature magic.
 *
 * Main cast : one magical tree erupts from the ground at hitPoint
 *             (vegetation.spawnTree handles the 1.5s overshoot grow) while a
 *             pink sparkle spiral climbs the trunk; finishes with a canopy pop.
 * Alt cast  : a clockwise ring of 5 smaller trees around hitPoint, staggered
 *             0.18s apart so the pops read as a wave.
 * Cancelled : no ground hit → toast + castInfo.cancelled = true (no mana).
 *
 * Color language (binding): nature = green 0x44dd66 / pink 0xff88dd.
 * Budget: main ≈ 84 particles over 1.5s, alt ≈ 150 staggered over 2.4s,
 * 1 flash per cast — far under the shared pools.
 */

const TWO_PI = Math.PI * 2;
const GROW_TIME = 1.5;        // matches vegetation.spawnTree's grow animation
const RING_RADIUS = 2.5;
const RING_COUNT = 5;
const RING_STAGGER = 0.18;
const SPIRAL_INTERVAL = 0.15;
const SPIRAL_HEIGHT = 3;

const COL_GREEN = 0x44dd66;
const COL_GREEN_FLASH = 0x66ff88;
const COL_PINK = 0xff88dd;
const COL_MINT = 0x88ffcc;

export default class GrowTree {
  static id = 'growtree';
  static label = 'Grow Tree';
  static icon = '🌳';
  static manaCost = 12;
  static cooldown = 0.8;

  constructor(ctx) {
    this.ctx = ctx;
    // Scratch vectors — reused across every emit inside effect updates so the
    // per-frame hot path allocates nothing. Particles copies positions on call.
    this._pos = new THREE.Vector3();
    this._dir = new THREE.Vector3(0, 1, 0);

    // Reusable particle option bags (mutated in place, used synchronously) —
    // the timer-driven emits inside effect updates allocate nothing.
    this._spiralOpts = {
      position: this._pos, direction: this._dir, color: COL_PINK,
      count: 9, speed: 2.1, life: 1.0, size: 0.24,
    };
    this._popOpts = {
      position: this._pos, color: COL_MINT,
      count: 64, speed: 3.2, life: 0.9, size: 0.26, gravity: 1, spread: 1,
    };
    this._beatOpts = {
      position: this._pos, color: COL_GREEN,
      count: 54, speed: 3.8, life: 0.95, size: 0.3, gravity: -2, spread: 1,
    };
    // Falling-leaf drizzle after the canopy pop — green confetti sifting down.
    this._drizzleOpts = {
      position: this._pos, color: COL_GREEN,
      count: 38, speed: 1.4, life: 1.8, size: 0.21, gravity: 2, spread: 1.4,
    };
    // Pink petal puff fired WITH the canopy pop — two-tone firework.
    this._petalOpts = {
      position: this._pos, color: COL_PINK,
      count: 26, speed: 2.2, life: 1.2, size: 0.22, gravity: 1.5, spread: 1.1,
    };
  }

  cast(castInfo) {
    const { hitPoint, alt } = castInfo;
    if (!hitPoint) {
      castInfo.cancelled = true;
      this.ctx.events.emit('ui:message', { text: 'Aim at the ground 🌱', duration: 2 });
      return null;
    }
    return alt ? this._castRing(hitPoint, castInfo) : this._castSingle(hitPoint);
  }

  // ---------------------------------------------------------------- single

  _castSingle(hitPoint) {
    const { particles, vegetation } = this.ctx.systems;
    const origin = hitPoint.clone(); // own the position; castInfo may be reused

    this._plantTree(origin, 0.9 + Math.random() * 0.45);
    this._groundBeat(origin, 1);

    const pos = this._pos;
    const dir = this._dir;
    let t = 0;
    let spiralTimer = 0;
    let angle = Math.random() * TWO_PI;
    let popped = false;

    return {
      update: (dt) => {
        t += dt;

        // Pink sparkle spiral climbing the trunk while the tree grows.
        spiralTimer += dt;
        while (spiralTimer >= SPIRAL_INTERVAL && t < GROW_TIME) {
          spiralTimer -= SPIRAL_INTERVAL;
          const h = (t / GROW_TIME) * SPIRAL_HEIGHT;
          angle += 1.9; // winds around the trunk as it climbs
          const r = 0.42 + 0.1 * Math.sin(angle * 0.5);
          dir.set(0, 1, 0);
          // Arm 1
          pos.set(
            origin.x + Math.cos(angle) * r,
            origin.y + h,
            origin.z + Math.sin(angle) * r
          );
          particles.stream(this._spiralOpts);
          // Arm 2 — mirrored 180° so the climb reads as a double helix of life.
          pos.set(
            origin.x - Math.cos(angle) * r,
            origin.y + h,
            origin.z - Math.sin(angle) * r
          );
          particles.stream(this._spiralOpts);
        }

        // Canopy pop — synced with the grow overshoot landing: a mint
        // firework + soft green flash right where the crown lands.
        if (!popped && t >= GROW_TIME) {
          popped = true;
          pos.set(origin.x, origin.y + SPIRAL_HEIGHT, origin.z);
          const popOpts = this._popOpts;
          popOpts.count = 64;
          popOpts.size = 0.26;
          particles.burst(popOpts);
          particles.flash(pos, COL_MINT, 4.5, 0.4);
          // Two-tone firework: pink petals burst with the mint.
          particles.burst(this._petalOpts);
          // Leaf confetti sifts back down through the new canopy.
          pos.y += 0.3;
          particles.burst(this._drizzleOpts);
        }

        return t < GROW_TIME + 0.1; // one frame of slack so the pop always fires
      },
    };
  }

  // ------------------------------------------------------------------ ring

  _castRing(hitPoint, castInfo) {
    const { particles, terrain } = this.ctx.systems;
    const waterLevel = this.ctx.config.waterLevel;

    // Precompute the 5 plantings (clockwise from a random start) at cast time —
    // the effect update then only ticks timers, no allocation.
    const startAngle = Math.random() * TWO_PI;
    const plantings = [];
    for (let i = 0; i < RING_COUNT; i++) {
      const a = startAngle - (i / RING_COUNT) * TWO_PI; // negative = clockwise
      const x = hitPoint.x + Math.cos(a) * RING_RADIUS;
      const z = hitPoint.z + Math.sin(a) * RING_RADIUS;
      const y = terrain.getHeight(x, z);
      // Skip spots off the island or underwater — the wave just hops over them.
      if (y < waterLevel + 0.25 || y <= -99) continue;
      plantings.push({
        position: new THREE.Vector3(x, y, z),
        delay: i * RING_STAGGER,
        scale: 0.5 + Math.random() * 0.2,
        spawned: false,
        popped: false,
      });
    }

    if (plantings.length === 0) {
      // Whole ring landed in water/void — no tree grew, so abort without
      // spending mana (contract: cancelled casts set castInfo.cancelled).
      // A tiny fizzle flash gives feedback without counting as the spell.
      castInfo.cancelled = true;
      this.ctx.events.emit('ui:message', { text: 'No soil for roots here…', duration: 2 });
      this._pos.copy(hitPoint);
      particles.flash(this._pos, COL_GREEN_FLASH, 1.5, 0.15);
      return null;
    }

    // Opening flash at the center of the ring.
    this._pos.copy(hitPoint);
    particles.flash(this._pos, COL_GREEN_FLASH, 3.5, 0.35);

    const pos = this._pos;
    const total = (plantings.length - 1) * RING_STAGGER + GROW_TIME + 0.1;
    let t = 0;

    return {
      update: (dt) => {
        t += dt;
        for (let i = 0; i < plantings.length; i++) {
          const p = plantings[i];
          const local = t - p.delay;
          if (local < 0) continue;

          if (!p.spawned) {
            p.spawned = true;
            this._plantTree(p.position, p.scale);
            this._groundBeat(p.position, 0.7); // small ring burst per sapling
          }

          // Mini canopy pop per sapling — the staggered chain reads as a wave
          // of small mint fireworks, each with its own soft flash.
          if (!p.popped && local >= GROW_TIME) {
            p.popped = true;
            pos.set(
              p.position.x,
              p.position.y + SPIRAL_HEIGHT * p.scale + 0.4,
              p.position.z
            );
            const popOpts = this._popOpts;
            popOpts.count = 34;
            popOpts.size = 0.22;
            this.ctx.systems.particles.burst(popOpts);
            this.ctx.systems.particles.flash(pos, COL_MINT, 3, 0.3);
          }
        }
        return t < total;
      },
    };
  }

  // --------------------------------------------------------------- helpers

  /** Spawn a growing magical tree via the vegetation system. */
  _plantTree(position, scale) {
    this.ctx.systems.vegetation.spawnTree(position, {
      magical: true,
      animate: true,
      scale,
    });
  }

  /**
   * Cast beat at the roots: green flash + rising ring of leaf-light.
   * `strength` scales count/intensity (1 = main cast, 0.7 = ring sapling).
   */
  _groundBeat(position, strength) {
    const { particles } = this.ctx.systems;
    const pos = this._pos.copy(position);
    pos.y += 0.1;
    if (strength >= 1) {
      // Single big flash for the main cast (alt-cast flashes once at center).
      particles.flash(pos, COL_GREEN_FLASH, 4, 0.4);
    }
    const beat = this._beatOpts;
    beat.count = Math.round(44 * strength);
    particles.burst(beat); // rises (gravity -2) — leaves lifted by the surge
  }
}
