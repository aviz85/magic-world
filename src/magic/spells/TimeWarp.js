import * as THREE from 'three';

/**
 * TimeWarp 🌙 — bends the day/night cycle ±6 hours over ~1.2 seconds.
 *
 * Main cast  → time surges FORWARD  (+6h), sun-gold spiral overhead.
 * Alt cast   → time REWINDS         (−6h), moon-blue spiral overhead.
 *
 * The real spectacle is the sky itself sweeping — the spell only crowns the
 * player with a swirling halo of particles and two soft flashes. Per the VFX
 * spec: ~60 particles over 1.2s, flashes at t=0 and t=1.0s, and
 * `sky.advance()` is fed in small eased steps (step ∝ sin(π·t/T)) every frame
 * so the transition reads as a smooth rush of hours, never a snap.
 */

const WARP_HOURS = 6; // magnitude of the time shift per cast
const DURATION = 1.2; // seconds — total effect length
const SPIRAL_PERIOD = 0.1; // seconds between spiral ticks (12 ticks × 2 arms × 7 ≈ 168 particles)
const ANGLE_STEP = 0.9; // radians the spiral advances per puff
const SPIRAL_RADIUS = 2; // metres — halo radius around the player's head
const COLOR_FORWARD = 0xffcc66; // sun-gold
const COLOR_BACKWARD = 0x6688ff; // moon-blue

export default class TimeWarp {
  static id = 'timewarp';
  static label = 'Time Warp';
  static icon = '🌙';
  static manaCost = 20;
  static cooldown = 1.5;

  constructor(ctx) {
    this.ctx = ctx;
    // Scratch objects — reused across frames/casts (cooldown 1.5s > effect
    // 1.2s, so at most one effect is ever alive per spell instance).
    this._pos = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._flashPos = new THREE.Vector3();
    // Reusable particles.stream options — mutated per puff, never reallocated.
    this._streamOpts = {
      position: this._pos,
      direction: this._dir,
      color: COLOR_FORWARD,
      count: 9,
      speed: 2.8,
      life: 1.05,
      size: 0.34,
    };
    // Ground ripple at cast — time radiating outward from the caster's feet.
    this._rippleOpts = {
      position: this._flashPos,
      color: COLOR_FORWARD,
      count: 36,
      speed: 8,
      life: 0.5,
      size: 0.22,
      gravity: 10,
      spread: 1.7,
    };
  }

  cast(castInfo) {
    const { systems, events } = this.ctx;
    const sky = systems.sky;
    const player = systems.player;
    const particles = systems.particles;
    if (!sky || !player) {
      // Abort without effect — flag it so the manager doesn't deduct mana.
      if (castInfo) castInfo.cancelled = true;
      return null;
    }

    const backward = !!(castInfo && castInfo.alt);
    const hours = backward ? -WARP_HOURS : WARP_HOURS;
    const color = backward ? COLOR_BACKWARD : COLOR_FORWARD;

    events.emit('time:warp', { hours });
    events.emit('ui:message', {
      text: backward ? '🌙 Time rewinds…' : '☀️ Time surges forward…',
      duration: 2,
    });

    // Opening beat — halo flash above the player's head + a ripple of
    // sky-colored sparks racing outward from the feet: time visibly radiates.
    if (particles) {
      this._flashPos.copy(player.position);
      this._flashPos.y += 4;
      particles.flash(this._flashPos, color, 5, 0.5);
      this._flashPos.copy(player.position);
      this._flashPos.y += 0.2;
      this._rippleOpts.color = color;
      particles.burst(this._rippleOpts);
    }

    // --- Effect state (closed over; spell-level scratch vectors reused) ---
    let t = 0; // elapsed effect time
    let advanced = 0; // hours fed to sky.advance so far
    let puffTimer = 0; // accumulator for spiral emission
    let angle = backward ? Math.PI : 0; // spiral phase (rewind starts opposed)
    let secondFlash = false;
    const spin = backward ? -1 : 1; // rewind spirals the other way
    const pos = this._pos;
    const dir = this._dir;
    const flashPos = this._flashPos;
    const streamOpts = this._streamOpts;
    streamOpts.color = color;

    return {
      update: (dt) => {
        const prevT = t;
        t = Math.min(t + dt, DURATION);

        // --- Sky advance, eased: rate ∝ sin(π·t/T). Integrating the rate
        // analytically per-frame keeps the sum exact regardless of dt:
        //   advancedTarget(t) = hours · (1 − cos(π·t/T)) / 2
        // → slow-in, fast middle, slow-out; final frame lands on `hours` exactly.
        const target = hours * (1 - Math.cos((Math.PI * t) / DURATION)) * 0.5;
        const step = target - advanced;
        if (step !== 0) {
          sky.advance(step);
          advanced = target;
        }

        // --- Swirling halo: a climbing two-armed spiral of motes overhead.
        if (particles) {
          puffTimer += t - prevT;
          while (puffTimer >= SPIRAL_PERIOD) {
            puffTimer -= SPIRAL_PERIOD;
            angle += ANGLE_STEP * spin;

            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            const climb = (t / DURATION) * 1.2; // halo drifts upward as time flows

            // Arm 1
            pos.copy(player.position);
            pos.x += cos * SPIRAL_RADIUS;
            pos.z += sin * SPIRAL_RADIUS;
            pos.y += 3 + climb;
            // Mostly up, with a tangential lean so the column visibly twists.
            dir.set(-sin * 0.3 * spin, 1, cos * 0.3 * spin).normalize();
            particles.stream(streamOpts);

            // Arm 2 — mirrored 180° so the halo reads as a true double helix.
            pos.copy(player.position);
            pos.x -= cos * SPIRAL_RADIUS;
            pos.z -= sin * SPIRAL_RADIUS;
            pos.y += 3 + climb;
            dir.set(sin * 0.3 * spin, 1, -cos * 0.3 * spin).normalize();
            particles.stream(streamOpts);
          }

          // Closing beat — second flash at t = 1.0s as the sky settles,
          // crowned by a soft burst where the helix converges overhead.
          if (!secondFlash && t >= 1.0) {
            secondFlash = true;
            flashPos.copy(player.position);
            flashPos.y += 4;
            particles.flash(flashPos, color, 5, 0.5);
            flashPos.y += 0.5;
            particles.burst({
              position: flashPos,
              color,
              count: 30,
              speed: 3,
              life: 0.8,
              size: 0.26,
              gravity: -1,
              spread: 1,
            });
          }
        }

        return t < DURATION; // falsy when finished — nothing to clean up
      },
    };
  }
}
