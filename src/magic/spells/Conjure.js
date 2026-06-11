import * as THREE from 'three';
import { PREFAB_NAMES } from '../../build/Prefabs.js';

/**
 * Conjure 🏰 — divine architecture.
 *
 * Alt cast  : cycles the selected prefab through PREFAB_NAMES and toasts
 *             "Conjure: <name>" — costs nothing (castInfo.cancelled = true).
 * Main cast : requires hitPoint → build.placePrefab(current, hitPoint), then
 *             a 2s golden sparkle rain drifts down onto the rising blocks,
 *             ending in a completion fanfare flash synced with `prefab:place`'s
 *             chord swell.
 * Cancelled : no ground hit → toast + castInfo.cancelled = true (no mana).
 *
 * Color language (binding): divine/conjure = gold 0xffd700.
 * Budget: ~190 particles staggered over 2s, 2 flashes — well under the pools.
 */

const RAIN_DURATION = 2;       // matches placePrefab's staggered rise
const RAIN_INTERVAL = 0.1;     // one golden shower puff per tick (~160 total)
const RAIN_HEIGHT = 6;         // sparkles spawn high and sift down
const RAIN_SPREAD = 3;         // ±3 around the build site
const EFFECT_TOTAL = RAIN_DURATION + 0.15; // slack so the fanfare always fires

const COL_GOLD = 0xffd700;
const COL_GOLD_PALE = 0xfff0aa;
const COL_GOLD_WARM = 0xffe066;

export default class Conjure {
  static id = 'conjure';
  static label = 'Conjure';
  static icon = '🏰';
  static manaCost = 35;
  static cooldown = 2.5;

  constructor(ctx) {
    this.ctx = ctx;
    this._index = 0;
    this.current = PREFAB_NAMES[0];
    // Scratch vector — reused for every particles call inside the effect
    // update so the hot path allocates nothing (Particles copies positions).
    this._pos = new THREE.Vector3();
    this._down = new THREE.Vector3(0, -1, 0);
    // Reusable golden-rain option bag (mutated per puff, used synchronously).
    this._rainOpts = {
      position: this._pos, color: COL_GOLD,
      count: 14, speed: 1.1, life: 1.5, size: 0.22, gravity: 2.5, spread: 1,
    };
  }

  cast(castInfo) {
    const { hitPoint, alt } = castInfo;

    // ------------------------------------------------ alt-cast: cycle prefab
    if (alt) {
      castInfo.cancelled = true; // selection is free — never spend mana
      this._index = (this._index + 1) % PREFAB_NAMES.length;
      this.current = PREFAB_NAMES[this._index];
      this.ctx.events.emit('ui:message', {
        text: `Conjure: ${this.current} 🏰`,
        duration: 2,
      });
      return null;
    }

    // ----------------------------------------------- main cast: raise prefab
    if (!hitPoint) {
      castInfo.cancelled = true;
      this.ctx.events.emit('ui:message', {
        text: 'Aim at solid ground to conjure 🏰',
        duration: 2,
      });
      return null;
    }

    const { particles, build } = this.ctx.systems;
    const origin = hitPoint.clone(); // own the position; castInfo may be reused

    // The build itself — placePrefab handles the staggered bottom-up rise
    // (~1.5s) and emits `prefab:place` for audio/HUD.
    build.placePrefab(this.current, origin);

    // Anticipation beat: a high golden flash above the site as the sky opens,
    // plus a halo of pale gold blooming where the structure will stand and a
    // shaft of light dropping from above onto the foundation.
    const pos = this._pos;
    pos.set(origin.x, origin.y + 4, origin.z);
    particles.flash(pos, COL_GOLD, 5.5, 0.5);
    pos.set(origin.x, origin.y + 0.5, origin.z);
    particles.burst({
      position: pos, color: COL_GOLD_PALE,
      count: 34, speed: 3.4, life: 0.85, size: 0.24, gravity: -1, spread: 1.5,
    });
    pos.set(origin.x, origin.y + RAIN_HEIGHT, origin.z);
    particles.stream({
      position: pos, direction: this._down, color: COL_GOLD_WARM,
      count: 14, speed: 9, life: 0.6, size: 0.3,
    });

    // ---------------------------------------------- golden sparkle rain (2s)
    let t = 0;
    let rainTimer = 0;
    let tick = 0;        // alternates hot gold / pale gold puffs
    let fanfare = false;

    return {
      update: (dt) => {
        t += dt;

        // Golden rain: every 0.1s an 8-particle puff spawns ~6m above a random
        // point over the footprint and drifts down (gravity 2.5) onto the
        // blocks rising beneath it. ~160 particles over the full duration.
        rainTimer += dt;
        while (rainTimer >= RAIN_INTERVAL && t < RAIN_DURATION) {
          rainTimer -= RAIN_INTERVAL;
          tick++;
          pos.set(
            origin.x + (Math.random() * 2 - 1) * RAIN_SPREAD,
            origin.y + RAIN_HEIGHT,
            origin.z + (Math.random() * 2 - 1) * RAIN_SPREAD
          );
          const rain = this._rainOpts;
          rain.color = (tick & 1) ? COL_GOLD : COL_GOLD_PALE;
          particles.burst(rain); // gravity 2.5 (falls) — sifting golden dust
        }

        // Completion fanfare — synced with the last blocks popping into place
        // and the `prefab:place` chord swell from the audio engine.
        if (!fanfare && t >= RAIN_DURATION) {
          fanfare = true;
          pos.set(origin.x, origin.y + 3, origin.z);
          particles.flash(pos, COL_GOLD, 6.5, 0.4);
          particles.burst({
            position: pos,
            color: COL_GOLD_WARM,
            count: 70,
            speed: 6,
            life: 0.95,
            size: 0.29,
            gravity: -0.5, // gentle lift — embers of consecration rising
            spread: 1,
          });
          // Pale-gold star shell above the crown — the firework finisher.
          pos.y += 2;
          particles.burst({
            position: pos,
            color: COL_GOLD_PALE,
            count: 30,
            speed: 4,
            life: 1.1,
            size: 0.22,
            gravity: 2,
            spread: 1,
          });
          // Golden sparks skitter outward along the ground — the structure
          // "locks in" with a satisfying floor-level punctuation.
          pos.set(origin.x, origin.y + 0.2, origin.z);
          particles.burst({
            position: pos,
            color: COL_GOLD,
            count: 38,
            speed: 10,
            life: 0.35,
            size: 0.21,
            gravity: 14,
            spread: 1.7,
          });
          // The structure settles with weight (internal juice channel).
          const spells = this.ctx.systems.spells;
          if (spells && typeof spells.addShake === 'function') spells.addShake(0.3);
        }

        return t < EFFECT_TOTAL;
      },
    };
  }
}
