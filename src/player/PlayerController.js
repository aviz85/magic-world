import * as THREE from 'three';

/**
 * PlayerController — first-person movement for Magic World.
 *
 * Contract (docs/CONTRACTS.md):
 *  - Properties: position (feet), velocity, yaw, pitch, flying, onGround.
 *  - Eye height 1.7, camera.rotation.order = 'YXZ', sensitivity 0.0023, pitch ±1.55.
 *  - WASD 8 m/s (×1.8 sprint, ×1.6 fly), Space jump vy≈9, gravity = ctx.config.gravity.
 *  - F toggles fly (Space up / KeyC down). Water buoyancy below config.waterLevel.
 *  - Ground = max(terrain.getHeight, build.getSupportHeight) — build accessed in update only.
 *  - teleport(vec3) zeroes velocity + emits 'player:teleport' { from, to }.
 *  - World bounds |x|,|z| ≤ worldSize/2 - 2.
 *
 * Game-feel (docs/design/vision.md §4):
 *  - Exp-smoothed accel (λ≈12 ground / 10 decel / 60% air / 6 fly).
 *  - Coyote time 0.1 s + 0.12 s jump buffer; jump-cut (release Space → shorter hop).
 *  - Sprint FOV kick 70 → 76. Head-bob 0.035 m @ 2.2 Hz (scaled by speed/8, never in air/fly/swim)
 *    + figure-8 lateral sway (0.02 m at half frequency) for an embodied gait.
 *  - Landing dip 0.08–0.2 m scaled by impact, easeOutCubic recovery over 0.25 s + ring dust puff
 *    at the feet; small take-off puff on jump.
 *  - Water-entry splash burst at the surface on real plunges (> 3 m/s).
 *  - Strafe lean: ≤ 0.022 rad smoothed camera roll into lateral motion.
 *  - Screen shake ONLY for fx:explosion within 12 m (0.05 rad falloff-by-distance, 0.3 s, easeOutQuad decay).
 */

const EYE_HEIGHT = 1.7;
const WALK_SPEED = 8;
const SPRINT_MULT = 1.8;
const FLY_MULT = 1.6;
const SWIM_MULT = 0.55;
const JUMP_SPEED = 9;
const SENSITIVITY = 0.0023;
const PITCH_LIMIT = 1.55;
const COYOTE_TIME = 0.1; // grace window after stepping off a ledge
const JUMP_BUFFER = 0.12; // press Space slightly early → jump still fires on landing
const LEAN_MAX = 0.022; // rad of camera roll when strafing (subtle "carve" feel)

const BASE_FOV = 70;
const SPRINT_FOV = 76;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export default class PlayerController {
  constructor(ctx) {
    this.ctx = ctx;

    const terrain = ctx.systems.terrain;
    const spawnY = terrain ? terrain.getHeight(0, 0) + 2 : ctx.config.waterLevel + 4;

    // --- Contract properties ---------------------------------------------
    this.position = new THREE.Vector3(0, spawnY, 8); // feet
    this.velocity = new THREE.Vector3(0, 0, 0);
    this.yaw = 0; // facing -Z, toward the island heart
    this.pitch = 0;
    this.flying = false;
    this.onGround = false;

    // --- Internal state ----------------------------------------------------
    this.inWater = false;
    this.bounds = ctx.config.worldSize / 2 - 2;
    this.coyoteTimer = 0;
    this.jumpBufferTimer = 0;
    this._wasInWater = false;

    // Juice state
    this.fov = BASE_FOV;
    this.bobPhase = 0;
    this.bobOffset = 0;
    this.swayOffset = 0; // lateral figure-8 head sway while walking
    this.landDipTimer = 0; // counts down from 0.25
    this.landDipDuration = 0.25;
    this.landDipDepth = 0.12; // scaled by impact speed at landing time
    this.lean = 0; // smoothed strafe roll
    this.shakeTimer = 0;
    this.shakeDuration = 0.3;
    this.shakeAmp = 0;

    // Scratch objects — reused every frame, never allocated in update()
    this._wishDir = new THREE.Vector3();
    this._scratch = new THREE.Vector3();

    // Reusable particle-call payloads (landing dust / water splash) — these
    // share _fxPos, which is set immediately before each burst() call.
    this._fxPos = new THREE.Vector3();
    this._landBurst = {
      position: this._fxPos, color: 0xb8a98c, count: 10, speed: 2.5,
      life: 0.55, size: 0.3, gravity: 9, spread: 1.4, ring: 0.75,
    };
    this._splashBurst = {
      position: this._fxPos, color: 0x6fd8e8, count: 16, speed: 3.2,
      life: 0.7, size: 0.28, gravity: 7, spread: 1.6, ring: 0.55,
    };

    // Camera setup
    ctx.camera.rotation.order = 'YXZ';
    ctx.camera.fov = BASE_FOV;
    ctx.camera.updateProjectionMatrix();
    this._applyCamera(0);

    // --- Events ------------------------------------------------------------
    ctx.events.on('input:keydown', ({ code }) => {
      if (code === 'KeyF') this._toggleFly();
      else if (code === 'Space') this.jumpBufferTimer = JUMP_BUFFER;
    });

    ctx.events.on('fx:explosion', ({ position }) => {
      if (!position) return;
      const dist = this.position.distanceTo(position);
      if (dist >= 12) return;
      const amp = 0.05 * (1 - dist / 12);
      if (amp > this.shakeAmp || this.shakeTimer <= 0) {
        this.shakeAmp = amp;
        this.shakeTimer = this.shakeDuration;
      }
    });
  }

  // -------------------------------------------------------------------------

  _toggleFly() {
    this.flying = !this.flying;
    if (this.flying) {
      this.onGround = false;
      // gentle lift-off nudge so toggling fly feels like a release, not a freeze
      if (this.velocity.y < 2.5) this.velocity.y = 2.5;
      this.ctx.events.emit('ui:message', { text: '🕊️ Flight on — Space ↑ · C ↓', duration: 2 });
    } else {
      this.ctx.events.emit('ui:message', { text: 'Flight off', duration: 1.5 });
    }
  }

  /** Move feet to `positionVec3`, zero velocity, emit player:teleport {from, to}. */
  teleport(positionVec3) {
    const from = this.position.clone(); // not a hot path — allocation is fine here
    this.position.copy(positionVec3);
    this._clampToBounds();
    this.velocity.set(0, 0, 0);
    this.onGround = false;
    this.coyoteTimer = 0;
    this.lean = 0;
    this.swayOffset = 0;
    const to = this.position.clone();
    this.ctx.events.emit('player:teleport', { from, to });
    this._applyCamera(0);
  }

  // -------------------------------------------------------------------------

  update(dt, elapsed) {
    const { input, config, systems } = this.ctx;

    // ---- Mouse look (only while pointer-locked) ---------------------------
    if (input.pointerLocked) {
      const d = input.consumeMouseDelta();
      this.yaw -= d.x * SENSITIVITY;
      this.pitch -= d.y * SENSITIVITY;
      if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
      else if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;
      // keep yaw wrapped to ±π — hours of spinning must never erode the
      // float precision feeding sin/cos (and the lean/sway math) below
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    } else {
      input.consumeMouseDelta(); // drop stale deltas so unlock→lock doesn't snap the view
    }

    // ---- Ground query (terrain + block support; build is later in order) --
    const terrain = systems.terrain;
    const build = systems.build;
    const terrainH = terrain ? terrain.getHeight(this.position.x, this.position.z) : -100;
    let ground = terrainH;
    if (build && build.getSupportHeight) {
      const support = build.getSupportHeight(this.position.x, this.position.z, this.position.y);
      if (support > ground) ground = support;
    }

    this.inWater = !this.flying && this.position.y < config.waterLevel - 0.05;

    // Water-entry splash (micro-effect): teal burst at the surface on a real plunge
    if (this.inWater && !this._wasInWater && this.velocity.y < -3 && systems.particles) {
      this._fxPos.set(this.position.x, config.waterLevel + 0.05, this.position.z);
      this._splashBurst.count = this.velocity.y < -8 ? 26 : 14;
      this._splashBurst.speed = 3.2;
      systems.particles.burst(this._splashBurst);
    }
    // Water-exit droplets: a smaller, gentler shed when bursting up out of
    // the surface — entry/exit symmetry sells the volume of the water
    if (!this.inWater && this._wasInWater && this.velocity.y > 2.5 && systems.particles) {
      this._fxPos.set(this.position.x, config.waterLevel + 0.05, this.position.z);
      this._splashBurst.count = 8;
      this._splashBurst.speed = 2.2;
      systems.particles.burst(this._splashBurst);
    }
    this._wasInWater = this.inWater;

    // ---- Movement intent --------------------------------------------------
    const fwd =
      (input.pressed('KeyW') ? 1 : 0) - (input.pressed('KeyS') ? 1 : 0);
    const strafe =
      (input.pressed('KeyD') ? 1 : 0) - (input.pressed('KeyA') ? 1 : 0);
    const hasInput = fwd !== 0 || strafe !== 0;
    const sprinting =
      (input.pressed('ShiftLeft') || input.pressed('ShiftRight')) && hasInput;

    let speed = WALK_SPEED;
    if (sprinting) speed *= SPRINT_MULT;
    if (this.flying) speed *= FLY_MULT;
    else if (this.inWater) speed *= SWIM_MULT;

    // Wish direction in world space, rotated by yaw (XZ plane only)
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    const wish = this._wishDir;
    // camera forward (yaw only) = (-sinY, 0, -cosY); right = (cosY, 0, -sinY)
    wish.set(-sinY * fwd + cosY * strafe, 0, -cosY * fwd - sinY * strafe);
    if (hasInput) wish.normalize();

    // ---- Horizontal velocity: exponential smoothing toward wish * speed ---
    let lambda;
    if (this.flying) lambda = 6; // floaty-but-controlled
    else if (this.inWater) lambda = 4; // water resistance
    else if (!this.onGround) lambda = 12 * 0.6; // 60% air control
    else lambda = hasInput ? 12 : 10; // snappy start, softer stop
    const blend = 1 - Math.exp(-lambda * dt);

    this.velocity.x += (wish.x * speed - this.velocity.x) * blend;
    this.velocity.z += (wish.z * speed - this.velocity.z) * blend;

    // ---- Vertical motion --------------------------------------------------
    const space = input.pressed('Space');
    if (this.jumpBufferTimer > 0) this.jumpBufferTimer -= dt;

    if (this.flying) {
      const vert = (space ? 1 : 0) - (input.pressed('KeyC') ? 1 : 0);
      const targetVy = vert * speed;
      this.velocity.y += (targetVy - this.velocity.y) * (1 - Math.exp(-6 * dt));
    } else if (this.inWater) {
      // Buoyancy: weak gravity, heavy drag, Space swims up
      if (space) {
        this.velocity.y += (4.5 - this.velocity.y) * (1 - Math.exp(-8 * dt));
      } else {
        this.velocity.y -= config.gravity * 0.22 * dt;
        this.velocity.y *= Math.exp(-2.5 * dt); // water drag
      }
      if (this.velocity.y < -3) this.velocity.y = -3; // terminal sink speed
    } else {
      this.velocity.y -= config.gravity * dt;
      // Jump-cut: releasing Space while still rising shortens the hop —
      // tap = quick bounce, hold = full arc. Holding behaves exactly as before.
      if (!space && this.velocity.y > 3) {
        this.velocity.y -= config.gravity * 0.85 * dt;
      }
      // Coyote-time + buffered jump: grace window after walking off an edge,
      // plus a press registered just before touchdown still fires.
      if ((space || this.jumpBufferTimer > 0) && (this.onGround || this.coyoteTimer > 0)) {
        this.velocity.y = JUMP_SPEED;
        this.onGround = false;
        this.coyoteTimer = 0;
        this.jumpBufferTimer = 0;
        // Take-off micro-puff: a faint dust kick at the feet sells the push-off
        if (systems.particles) {
          this._fxPos.set(this.position.x, this.position.y + 0.1, this.position.z);
          this._landBurst.count = 6;
          this._landBurst.speed = 1.6;
          systems.particles.burst(this._landBurst);
        }
      }
    }

    // ---- Integrate --------------------------------------------------------
    const fallSpeed = -this.velocity.y; // captured before landing zeroes it
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    this._clampToBounds();

    // Re-query ground at the new XZ so we land on what's actually under us
    const newTerrainH = terrain
      ? terrain.getHeight(this.position.x, this.position.z)
      : -100;
    ground = newTerrainH;
    if (build && build.getSupportHeight) {
      const support = build.getSupportHeight(
        this.position.x,
        this.position.z,
        this.position.y + Math.max(0, -this.velocity.y * dt) + 0.01,
      );
      if (support > ground) ground = support;
    }

    // ---- Ground collision / landing ---------------------------------------
    const wasOnGround = this.onGround;
    if (this.position.y <= ground) {
      this.position.y = ground;
      if (this.velocity.y < 0) this.velocity.y = 0;
      if (!this.flying) {
        this.onGround = true;
        this.coyoteTimer = COYOTE_TIME;
        // Landing dip — only on real falls (> 4 m/s), per the comfort budget.
        // Depth scales with impact speed (0.08 m soft step → 0.2 m hard slam).
        if (!wasOnGround && fallSpeed > 4 && !this.inWater) {
          this.landDipTimer = this.landDipDuration;
          this.landDipDepth = Math.min(0.08 + (fallSpeed - 4) * 0.012, 0.2);
          // Landing micro-effect: a dust puff at the feet, sized by impact
          const particles = systems.particles;
          if (particles) {
            this._fxPos.set(this.position.x, this.position.y + 0.15, this.position.z);
            this._landBurst.count = fallSpeed > 9 ? 16 : 8;
            this._landBurst.speed = Math.min(1.8 + fallSpeed * 0.14, 4.5);
            particles.burst(this._landBurst);
          }
        }
      }
    } else if (this.position.y - ground > 0.001) {
      if (this.onGround) this.coyoteTimer = COYOTE_TIME; // just stepped off
      this.onGround = false;
    }
    if (this.coyoteTimer > 0 && !this.onGround) this.coyoteTimer -= dt;

    // Swimming must never sink below the terrain floor
    if (this.inWater && this.position.y < newTerrainH) {
      this.position.y = newTerrainH;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }

    // ---- Juice: FOV kick, head-bob, landing dip, explosion shake ----------
    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);

    // FOV kick on sprint/fast flight — and on hard free-falls (island dives),
    // where the widening reads as wind rushing past
    const wantKick =
      ((sprinting || this.flying) && hSpeed > WALK_SPEED * 0.9) ||
      (!this.flying && !this.onGround && !this.inWater && this.velocity.y < -16);
    const targetFov = wantKick ? SPRINT_FOV : BASE_FOV;
    if (Math.abs(this.fov - targetFov) > 0.01) {
      const fovLambda = targetFov > this.fov ? 13 : 11; // in ~0.25s, out ~0.3s
      this.fov += (targetFov - this.fov) * (1 - Math.exp(-fovLambda * dt));
      this.ctx.camera.fov = this.fov;
      this.ctx.camera.updateProjectionMatrix();
    }

    if (this.onGround && !this.flying && !this.inWater && hSpeed > 0.5) {
      const speedScale = Math.min(hSpeed / WALK_SPEED, 1.6);
      this.bobPhase += dt * Math.PI * 2 * 2.2 * speedScale;
      // wrap at 4π (sway runs at half frequency) so the phase never loses
      // float precision over a long session
      if (this.bobPhase > Math.PI * 4) this.bobPhase -= Math.PI * 4;
      const bobAmp = Math.min(speedScale, 1);
      this.bobOffset = Math.sin(this.bobPhase) * 0.035 * bobAmp;
      // figure-8 gait: lateral sway at half the vertical frequency — the
      // classic walk-cycle lissajous that makes footfalls feel embodied
      this.swayOffset = Math.sin(this.bobPhase * 0.5) * 0.02 * bobAmp;
    } else {
      // ease the bob back to neutral so stopping never pops the camera
      this.bobOffset *= Math.exp(-10 * dt);
      this.swayOffset *= Math.exp(-10 * dt);
    }

    let dipOffset = 0;
    if (this.landDipTimer > 0) {
      this.landDipTimer -= dt;
      const p = Math.min(
        Math.max(1 - this.landDipTimer / this.landDipDuration, 0),
        1,
      );
      dipOffset = -this.landDipDepth * (1 - easeOutCubic(p));
    }

    // Strafe lean: a touch of camera roll into lateral motion ("carving").
    // rightward velocity = v · right, right(yaw) = (cosY, 0, -sinY)
    const latVel = this.velocity.x * cosY - this.velocity.z * sinY;
    let targetLean = (-latVel / WALK_SPEED) * LEAN_MAX;
    if (targetLean > LEAN_MAX) targetLean = LEAN_MAX;
    else if (targetLean < -LEAN_MAX) targetLean = -LEAN_MAX;
    this.lean += (targetLean - this.lean) * (1 - Math.exp(-7 * dt));

    let shakeX = 0;
    let shakeY = 0;
    if (this.shakeTimer > 0) {
      this.shakeTimer -= dt;
      const t = Math.max(this.shakeTimer / this.shakeDuration, 0);
      const amp = this.shakeAmp * t * t; // easeOutQuad decay
      shakeX = Math.sin(elapsed * 47.0) * amp;
      shakeY = Math.cos(elapsed * 38.5) * amp;
      if (this.shakeTimer <= 0) this.shakeAmp = 0;
    }

    // ---- Camera ------------------------------------------------------------
    this._applyCamera(this.bobOffset + dipOffset, shakeX, shakeY, this.lean, this.swayOffset);
  }

  // -------------------------------------------------------------------------

  _applyCamera(eyeOffset, shakeX = 0, shakeY = 0, roll = 0, sway = 0) {
    const cam = this.ctx.camera;
    // sway slides the eye along the camera-right axis: right(yaw) = (cos, 0, -sin)
    const swayX = Math.cos(this.yaw) * sway;
    const swayZ = -Math.sin(this.yaw) * sway;
    cam.position.set(
      this.position.x + swayX,
      this.position.y + EYE_HEIGHT + eyeOffset,
      this.position.z + swayZ,
    );
    cam.rotation.set(this.pitch + shakeX, this.yaw + shakeY, roll);
  }

  _clampToBounds() {
    const b = this.bounds;
    if (this.position.x > b) {
      this.position.x = b;
      if (this.velocity.x > 0) this.velocity.x = 0;
    } else if (this.position.x < -b) {
      this.position.x = -b;
      if (this.velocity.x < 0) this.velocity.x = 0;
    }
    if (this.position.z > b) {
      this.position.z = b;
      if (this.velocity.z > 0) this.velocity.z = 0;
    } else if (this.position.z < -b) {
      this.position.z = -b;
      if (this.velocity.z < 0) this.velocity.z = 0;
    }
  }
}
