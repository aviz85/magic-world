import * as THREE from 'three';

/**
 * Blink ⚡ — short-range arcane teleport.
 *
 * Cast: teleports the player to the aimed point (if hit within 30m) or 13m
 * along the look direction, clamped above the terrain. Choreography follows
 * docs/design/magic.md §5:
 *   - origin:  violet pre-flash + tight implosion burst (the "crack")
 *   - same frame: player.teleport(dest)  (Particles adds paired bursts via
 *     its player:teleport listener)
 *   - destination: brighter flash + rising violet burst + vertical streak
 *   - short-lived effect adds a few lingering motes so the arrival shimmers
 *
 * Budget: ~68 primary particles + ~12 lingering motes, 2 flashes per cast —
 * within the spell-VFX budget table. Zero per-frame allocations: every
 * vector used in cast()/update() is a scratch member created once.
 */

const MAX_AIM_DIST = 30;     // m — teleport to hitPoint when at most this far
const FORWARD_DIST = 13;     // m — fallback blink distance along view ray
const GROUND_CLEARANCE = 0.2;
const NORMAL_NUDGE = 0.3;    // push off walls so we don't embed in block faces

const COLOR_PRE_FLASH = 0xaa66ff;
const COLOR_IMPLOSION = 0xbb88ff;
const COLOR_DEST_FLASH = 0xddbbff;
const COLOR_DEST_BURST = 0x9955ff;
const COLOR_STREAK = 0xeeccff;
const COLOR_MOTES = 0xcc99ff;

export default class Blink {
  static id = 'blink';
  static label = 'Blink';
  static icon = '⚡';
  static manaCost = 8;
  static cooldown = 0.4;

  constructor(ctx) {
    this.ctx = ctx;

    // Scratch objects — reused across casts and effect frames (no hot allocs).
    this._dest = new THREE.Vector3();
    this._fxPos = new THREE.Vector3();
    this._fxDir = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);
  }

  cast(castInfo) {
    const { systems } = this.ctx;
    const player = systems.player;
    const terrain = systems.terrain;
    const particles = systems.particles;
    if (!player || !terrain || !particles) {
      castInfo.cancelled = true;
      return null;
    }

    const dest = this._dest;
    const halfWorld = this.ctx.config.worldSize / 2 - 2;

    if (castInfo.hitPoint && castInfo.origin &&
        castInfo.hitPoint.distanceTo(castInfo.origin) <= MAX_AIM_DIST) {
      // Land standing on the aimed surface; nudge along the hit normal so a
      // shot at a block wall pops us just off the face instead of inside it.
      dest.copy(castInfo.hitPoint);
      if (castInfo.hitNormal) dest.addScaledVector(castInfo.hitNormal, NORMAL_NUDGE);
    } else {
      // No (close) hit: blink 13m along the look direction from the feet.
      dest.copy(player.position).addScaledVector(castInfo.direction, FORWARD_DIST);
    }

    // Keep inside the island bounds and above the ground.
    dest.x = THREE.MathUtils.clamp(dest.x, -halfWorld, halfWorld);
    dest.z = THREE.MathUtils.clamp(dest.z, -halfWorld, halfWorld);
    const groundY = terrain.getHeight(dest.x, dest.z) + GROUND_CLEARANCE;
    if (dest.y < groundY) dest.y = groundY;

    // ---- Departure beat: violet pre-flash + tight implosion crack ----------
    const fx = this._fxPos;
    fx.copy(player.position);
    fx.y += 1.0;
    particles.flash(fx, COLOR_PRE_FLASH, 6.5, 0.16);
    particles.burst({
      position: fx,
      color: COLOR_IMPLOSION,
      count: 50,
      speed: 7,
      life: 0.28,
      size: 0.24,
      gravity: 0,
      spread: 1,
    });
    // White-hot core snap inside the violet crack.
    particles.burst({
      position: fx,
      color: 0xffffff,
      count: 14,
      speed: 3,
      life: 0.18,
      size: 0.16,
      gravity: 0,
      spread: 0.6,
    });

    // ---- Teleport (same frame). Particles' player:teleport listener adds
    // its own paired bursts; AudioEngine plays the shimmer. ------------------
    player.teleport(dest);

    // ---- Arrival beat: brighter flash + rising burst + vertical streak -----
    fx.copy(dest);
    fx.y += 1.0;
    particles.flash(fx, COLOR_DEST_FLASH, 7.5, 0.32);
    particles.burst({
      position: fx,
      color: COLOR_DEST_BURST,
      count: 75,
      speed: 8,
      life: 0.65,
      size: 0.34,
      gravity: -1, // gentle rise — arcane energy lifts
      spread: 1,
    });
    // Ground sparks: a fast violet shockwave skitters out across the floor.
    fx.copy(dest);
    fx.y += 0.15;
    particles.burst({
      position: fx,
      color: COLOR_IMPLOSION,
      count: 30,
      speed: 12,
      life: 0.3,
      size: 0.19,
      gravity: 14,
      spread: 1.6,
    });
    this._fxDir.set(0, 1, 0);
    fx.copy(dest);
    fx.y += 0.2;
    particles.stream({
      position: fx,
      direction: this._fxDir,
      color: COLOR_STREAK,
      count: 16,
      speed: 10,
      life: 0.55,
      size: 0.28,
    });

    // Arrival kick — a short, sharp jolt sells "you were just torn through
    // space" (internal SpellManager juice channel; defensive — internals only).
    const spells = systems.spells;
    if (spells && typeof spells.addShake === 'function') spells.addShake(0.22);

    // ---- Lingering shimmer: a few slow motes drift up at the destination
    // over the next third of a second so the arrival doesn't end abruptly. ---
    const spell = this;
    const effect = {
      t: 0,
      next: 0.08,
      emitted: 0,
      dest: dest.clone(), // one small allocation per cast, not per frame
      update(dt) {
        this.t += dt;
        while (this.t >= this.next && this.emitted < 8) {
          this.emitted++;
          this.next += 0.08;
          spell._fxPos.copy(this.dest);
          spell._fxPos.y += 0.4 + this.emitted * 0.25;
          spell._fxDir.set(0, 1, 0);
          particles.stream({
            position: spell._fxPos,
            direction: spell._fxDir,
            color: COLOR_MOTES,
            count: 5,
            speed: 1.8,
            life: 0.75,
            size: 0.16,
          });
        }
        return this.t < 0.75; // done — nothing to clean up (pooled particles)
      },
    };
    return effect;
  }
}
