/**
 * SummonGolem 🗿 — id `golem`
 *
 * Two-stage "weight" choreography (docs/design/magic.md §7):
 *   Beat 1 (t = 0s)    — amber pre-flash on the ground + a wide ring of rising
 *                        crack-dust: the earth groans before it gives.
 *   Beat 2 (t = 0.25s) — `golems.spawn(hitPoint)` (Golems system owns the rise
 *                        animation) + heavy falling debris + a second, higher
 *                        flash as the rune eyes ignite.
 *
 * Budget: 65 particles, 2 flashes, 0 owned lights/meshes — all VFX go through
 * the pooled Particles system, so there is nothing to dispose.
 *
 * Cancellation contract: when aborting without an effect (no hitPoint, or the
 * golem cap is reached) we set `castInfo.cancelled = true` and return null so
 * SpellManager does not deduct mana.
 */
export default class SummonGolem {
  static id = 'golem';
  static label = 'Summon Golem';
  static icon = '🗿';
  static manaCost = 40;
  static cooldown = 2;

  // Choreography timing/tuning constants.
  static RISE_DELAY = 0.25;   // seconds between ground-crack beat and the rise beat
  static SLAM_DELAY = 0.5;    // third beat — the golem's weight settles, earth shudders
  static EFFECT_LIFE = 0.85;  // total effect lifetime (covers all beats + linger)
  static MAX_GOLEMS = 5;

  constructor(ctx) {
    this.ctx = ctx;
  }

  cast(castInfo) {
    const { hitPoint } = castInfo;
    const { events, systems } = this.ctx;
    const particles = systems.particles;
    const golems = systems.golems;

    // ---- Guards (abort BEFORE mana is spent) -------------------------------
    if (!hitPoint) {
      castInfo.cancelled = true;
      events.emit('ui:message', { text: 'Aim at the ground to call a golem', duration: 2.5 });
      return null;
    }
    if (!golems || golems.count >= SummonGolem.MAX_GOLEMS) {
      castInfo.cancelled = true;
      events.emit('ui:message', { text: 'The golems grow restless (max 5)', duration: 2.5 });
      return null;
    }

    // ---- Beat 1: the ground cracks ----------------------------------------
    // Per-cast allocations are fine; the effect's update() below allocates nothing.
    const summonPos = hitPoint.clone();
    const eyePos = summonPos.clone();
    eyePos.y += 1.5;

    // Amber anticipation flash hugging the ground.
    particles.flash(summonPos, 0xffaa44, 5, 0.4);
    // Crack dust: earthen ring lifting out of the fissures (negative gravity rises).
    particles.burst({
      position: summonPos,
      color: 0x776655,
      count: 70,
      speed: 3.5,
      life: 1.15,
      size: 0.45,
      gravity: -2,
      spread: 1.3,
    });
    // Hot amber motes seeping out of the fissures with the dust.
    particles.burst({
      position: summonPos,
      color: 0xffaa44,
      count: 20,
      speed: 2,
      life: 0.9,
      size: 0.2,
      gravity: -1.5,
      spread: 1.2,
    });

    // ---- Effect: waits out the pre-beat, then raises the golem -------------
    const spell = this;
    const effect = {
      t: 0,
      risen: false,
      slammed: false,
      spawnOk: false,
      update(dt) {
        this.t += dt;

        if (!this.risen && this.t >= SummonGolem.RISE_DELAY) {
          this.risen = true;
          this.spawnOk = spell._rise(summonPos, eyePos);
        }
        if (this.spawnOk && !this.slammed && this.t >= SummonGolem.SLAM_DELAY) {
          this.slammed = true;
          spell._slam(summonPos);
        }

        return this.t < SummonGolem.EFFECT_LIFE;
      },
    };
    return effect;
  }

  // ---- Beat 2: the golem rises --------------------------------------------
  _rise(summonPos, eyePos) {
    const { events, systems } = this.ctx;
    const particles = systems.particles;
    const golems = systems.golems;

    // Re-check the cap at rise time (another cast may have landed during the
    // pre-beat). spawn() also returns false when full — mana is already spent,
    // so the courteous failure is a toast, not a crash.
    const spawned = golems && golems.count < SummonGolem.MAX_GOLEMS
      ? golems.spawn(summonPos)
      : false;
    if (spawned === false) {
      events.emit('ui:message', { text: 'The golems grow restless (max 5)', duration: 2.5 });
      return false;
    }

    // Heavy debris thrown outward, slamming back down (positive gravity falls).
    particles.burst({
      position: summonPos,
      color: 0x998877,
      count: 56,
      speed: 7,
      life: 0.9,
      size: 0.4,
      gravity: 7,
      spread: 1,
    });
    // Rune eyes ignite — hot ember flash at head height + a spray of sparks.
    particles.flash(eyePos, 0xff8855, 6, 0.4);
    particles.burst({
      position: eyePos,
      color: 0xff8855,
      count: 14,
      speed: 2.5,
      life: 0.5,
      size: 0.16,
      gravity: 1,
      spread: 0.8,
    });
    return true;
  }

  // ---- Beat 3: the weight settles — ground-slam shockwave ------------------
  _slam(summonPos) {
    const particles = this.ctx.systems.particles;
    if (!particles) return;
    // Fast, low, heavy sparks racing outward along the ground + a dull amber
    // thud of light — the "it is HERE" punctuation mark.
    particles.burst({
      position: summonPos,
      color: 0xbbaa88,
      count: 48,
      speed: 13,
      life: 0.35,
      size: 0.32,
      gravity: 16,
      spread: 1.7,
    });
    // Slow dust pall rolling out after the sparks — weight lingers.
    particles.burst({
      position: summonPos,
      color: 0x887766,
      count: 24,
      speed: 2,
      life: 1.2,
      size: 0.5,
      gravity: -0.5,
      spread: 1.4,
    });
    particles.flash(summonPos, 0xcc9955, 4, 0.3);
    // The earth itself shudders under the golem's weight (internal juice
    // channel on SpellManager — guarded, internals only).
    const spells = this.ctx.systems.spells;
    if (spells && typeof spells.addShake === 'function') spells.addShake(0.45);
  }
}
