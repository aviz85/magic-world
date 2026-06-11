import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Portal 🌀 — two linked glowing torus gates with swirling rim particles.
//
// First cast (needs a hitPoint) opens portal A (violet). Second cast opens
// portal B (cyan) and links them. Casting again replaces the OLDEST portal.
// Alt-cast dispels both. Walking into one gate hurls you out of the other
// (1.5 m out along its facing normal) with a two-flash "pulled through"
// beat and a 2 s re-entry cooldown. Emits `portal:set { portals: [{x,z}] }`
// on every change so the minimap stays honest.
//
// The persistent effect object is returned exactly ONCE per "portal session";
// it keeps itself alive while any portal (live or collapsing) exists.
// ---------------------------------------------------------------------------

const TWO_PI = Math.PI * 2;

// Easing helpers (per docs/design/magic.md)
const easeOutBack = (t) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2;
const easeInQuad = (t) => t * t;

const RADIUS = 1.2;
const TUBE = 0.09;
const CENTER_LIFT = RADIUS + TUBE + 0.04; // ring bottom kisses the ground
const TRIGGER_DIST_SQ = 1.3 * 1.3;        // feet-region within 1.3 of center
const REENTRY_COOLDOWN = 2;
const SPAWN_TIME = 0.5;
const DIE_TIME = 0.35;
const SWIRL_INTERVAL = 0.12;

// Color slots alternate: A violet, B cyan — replacing the oldest keeps the
// live pair always two-toned.
const RING_COLORS = [0x8833ff, 0x33ccff];
const SWIRL_COLORS = [0xcc88ff, 0x88ddff];
const DISC_COLORS = [0x6622cc, 0x1f8fcc];

const UP = new THREE.Vector3(0, 1, 0);

export default class Portal {
  static id = 'portal';
  static label = 'Portal';
  static icon = '🌀';
  static manaCost = 25;
  static cooldown = 1;

  constructor(ctx) {
    this.ctx = ctx;

    this.portals = [];        // live gates, oldest first (max 2)
    this.dying = [];          // collapsing gates being animated out
    this.effectAlive = false; // the persistent effect has been handed out
    this.travelCooldown = 0;  // re-entry lockout (seconds)
    this.nextColor = 0;       // alternating color slot
    this.pendingExit = null;  // arrival beat fired one frame after teleport
    this.timeAcc = 0;         // local clock for pulsing

    // Shared geometry (created once, never disposed)
    this.ringGeometry = new THREE.TorusGeometry(RADIUS, TUBE, 10, 40);
    this.discGeometry = new THREE.CircleGeometry(RADIUS - TUBE, 30);

    // Material templates — cloned per gate so two gates (and dying ghosts)
    // can pulse independently. Clones are disposed on collapse.
    this.ringTemplates = RING_COLORS.map((c, i) => new THREE.MeshStandardMaterial({
      color: 0x150826,
      emissive: c,
      emissiveIntensity: 1.8,
      roughness: 0.35,
      metalness: 0.1,
      flatShading: true,
    }));
    this.discTemplates = DISC_COLORS.map((c) => new THREE.MeshBasicMaterial({
      color: c,
      transparent: true,
      opacity: 0.3,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));

    // Scratch objects — reused every frame, never allocated in hot loops.
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._right = new THREE.Vector3();

    // Reusable rim-swirl stream options (mutated per emit, used synchronously)
    // — the steady-state portal loop allocates nothing.
    this._swirlOpts = {
      position: this._v1, direction: this._v2, color: 0xffffff,
      count: 3, speed: 1.3, life: 0.75, size: 0.16,
    };
  }

  // -------------------------------------------------------------------------
  // Casting
  // -------------------------------------------------------------------------
  cast(castInfo) {
    const events = this.ctx.events;

    if (castInfo.alt) {
      // Alt-cast: dispel both gates. Free — no mana for housekeeping.
      castInfo.cancelled = true;
      if (this.portals.length === 0) {
        events.emit('ui:message', { text: 'No portals to dispel' });
        return null;
      }
      this._clearAll();
      events.emit('ui:message', { text: 'Portals dispelled' });
      return null;
    }

    if (!castInfo.hitPoint) {
      castInfo.cancelled = true;
      events.emit('ui:message', { text: 'Aim at the ground to open a portal' });
      return null;
    }

    // Replace-oldest when both slots are full.
    if (this.portals.length >= 2) {
      this._collapse(this.portals.shift(), true);
    }

    const gate = this._spawnGate(castInfo);
    this.portals.push(gate);
    this._emitSet();

    // Grace so the caster isn't instantly yanked through a gate opened at
    // their feet the moment it links.
    this.travelCooldown = Math.max(this.travelCooldown, 0.8);

    events.emit('ui:message', {
      text: this.portals.length === 2
        ? 'Portals linked ✨ Step through!'
        : 'Portal opened — cast again to link',
    });

    if (!this.effectAlive) {
      this.effectAlive = true;
      // Persistent effect: SpellManager calls update(dt) every frame; we stay
      // alive while anything portal-ish exists in the world.
      return { update: (dt) => this._update(dt) };
    }
    return null; // mana/cooldown still apply (cancelled not set)
  }

  // -------------------------------------------------------------------------
  // Gate construction / destruction
  // -------------------------------------------------------------------------
  _spawnGate(castInfo) {
    const colorIdx = this.nextColor;
    this.nextColor = 1 - this.nextColor;

    const center = castInfo.hitPoint.clone();
    center.y += CENTER_LIFT;

    // Face back toward the caster (horizontal); fallback +Z.
    const normal = new THREE.Vector3(-castInfo.direction.x, 0, -castInfo.direction.z);
    if (normal.lengthSq() < 1e-6) normal.set(0, 0, 1);
    normal.normalize();

    const ringMat = this.ringTemplates[colorIdx].clone();
    const discMat = this.discTemplates[colorIdx].clone();

    const group = new THREE.Group();
    group.position.copy(center);
    group.rotation.y = Math.atan2(normal.x, normal.z); // torus normal (+Z) → `normal`
    group.scale.set(1, 0.01, 1);

    const ring = new THREE.Mesh(this.ringGeometry, ringMat);
    ring.castShadow = true;
    group.add(ring);

    const disc = new THREE.Mesh(this.discGeometry, discMat);
    disc.position.z = 0.01;
    group.add(disc);

    this.ctx.scene.add(group);

    // Spawn flourish — white core snap inside a colored bloom, reality tearing
    // open, plus a pillar of light shooting skyward to announce the gate.
    const particles = this.ctx.systems.particles;
    if (particles) {
      particles.flash(center, RING_COLORS[colorIdx], 6.5, 0.45);
      particles.burst({
        position: center,
        color: SWIRL_COLORS[colorIdx],
        count: 85,
        speed: 5,
        life: 0.95,
        size: 0.29,
      });
      particles.burst({
        position: center,
        color: 0xffffff,
        count: 26,
        speed: 2.8,
        life: 0.4,
        size: 0.16,
      });
      this._v3.set(0, 1, 0);
      particles.stream({
        position: center,
        direction: this._v3,
        color: SWIRL_COLORS[colorIdx],
        count: 16,
        speed: 11,
        life: 0.7,
        size: 0.3,
      });
    }

    return {
      group,
      ring,
      disc,
      ringMat,
      discMat,
      center,
      normal,
      colorIdx,
      swirlColor: SWIRL_COLORS[colorIdx],
      spawnT: 0,
      dieT: 0,
      surgeT: 0, // post-traversal emissive surge timer (counts down from 0.6)
      swirlTimer: Math.random() * SWIRL_INTERVAL,
      swirlAngle: Math.random() * TWO_PI,
      pulsePhase: Math.random() * TWO_PI,
    };
  }

  _collapse(gate, withBurst) {
    gate.dieT = 0;
    this.dying.push(gate);
    if (withBurst) {
      const particles = this.ctx.systems.particles;
      if (particles) {
        particles.flash(gate.center, gate.swirlColor, 4, 0.3);
        particles.burst({
          position: gate.center,
          color: gate.swirlColor,
          count: 50,
          speed: 7,
          life: 0.6,
          size: 0.24,
        });
      }
    }
  }

  _clearAll() {
    for (let i = 0; i < this.portals.length; i++) this._collapse(this.portals[i], true);
    this.portals.length = 0;
    this.pendingExit = null;
    this._emitSet();
  }

  _dispose(gate) {
    this.ctx.scene.remove(gate.group);
    gate.ringMat.dispose();
    gate.discMat.dispose();
  }

  _emitSet() {
    this.ctx.events.emit('portal:set', {
      portals: this.portals.map((p) => ({ x: p.center.x, z: p.center.z })),
    });
  }

  // -------------------------------------------------------------------------
  // Persistent effect update — returns false only when nothing remains.
  // -------------------------------------------------------------------------
  _update(dt) {
    this.timeAcc += dt;
    if (this.travelCooldown > 0) this.travelCooldown -= dt;

    // 1) Arrival beat queued by last frame's traversal (frame 2 of the
    //    "pulled through" reading — two flashes, two colors, 16ms apart).
    if (this.pendingExit) {
      const gate = this.pendingExit;
      this.pendingExit = null;
      const particles = this.ctx.systems.particles;
      const gateAlive = this.dying.indexOf(gate) === -1;
      if (particles && gateAlive) {
        particles.flash(gate.center, 0x66ddff, 8.5, 0.38);
        particles.burst({
          position: gate.center,
          color: 0x88eeff,
          count: 80,
          speed: 10,
          life: 0.6,
          size: 0.34,
          gravity: 0,
          spread: 1,
        });
        particles.burst({
          position: gate.center,
          color: 0xffffff,
          count: 40,
          speed: 4,
          life: 0.4,
          size: 0.17,
        });
      }
      if (gateAlive) gate.surgeT = 0.6;
    }

    // 2) Animate live gates
    for (let i = 0; i < this.portals.length; i++) {
      this._animateGate(this.portals[i], dt);
    }

    // 3) Traversal
    if (this.portals.length === 2 && this.travelCooldown <= 0) {
      this._checkTraversal();
    }

    // 4) Animate + reap collapsing gates
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const gate = this.dying[i];
      gate.dieT += dt;
      const k = Math.min(gate.dieT / DIE_TIME, 1);
      const shrink = 1 - easeInQuad(k);
      gate.group.scale.set(
        Math.max(0.01, shrink),
        Math.max(0.01, shrink * shrink),
        Math.max(0.01, shrink),
      );
      gate.ring.rotation.z += 4 * dt; // spin up as it implodes
      gate.ringMat.emissiveIntensity = 2.4 * shrink + 0.2;
      gate.discMat.opacity = 0.3 * shrink;
      if (k >= 1) {
        this._dispose(gate);
        this.dying.splice(i, 1);
      }
    }

    // 5) Alive while anything remains; otherwise release the effect slot so a
    //    future first-cast can hand out a fresh one.
    if (this.portals.length === 0 && this.dying.length === 0) {
      this.effectAlive = false;
      return false;
    }
    return true;
  }

  _animateGate(gate, dt) {
    // Grow-in: scale (1, 0.01, 1) → (1, 1, 1) over 0.5s with overshoot.
    if (gate.spawnT < SPAWN_TIME) {
      gate.spawnT += dt;
      const t = Math.min(gate.spawnT / SPAWN_TIME, 1);
      gate.group.scale.y = Math.max(0.01, easeOutBack(t));
      if (t >= 1) gate.group.scale.y = 1;
    }

    // Slow ring rotation + counter-rotating energy film.
    gate.ring.rotation.z += 0.6 * dt;
    gate.disc.rotation.z -= 1.1 * dt;

    // Emissive pulse 1.3–2.9 @ 0.8 Hz, with a surge spike after traversal.
    const pulse = 2.1 + 0.8 * Math.sin(this.timeAcc * 0.8 * TWO_PI + gate.pulsePhase);
    if (gate.surgeT > 0) {
      gate.surgeT -= dt;
      const k = Math.max(gate.surgeT / 0.6, 0);
      gate.ringMat.emissiveIntensity = pulse + (5.2 - pulse) * easeInQuad(k);
    } else {
      gate.ringMat.emissiveIntensity = pulse;
    }
    gate.discMat.opacity = 0.22 + 0.1 * Math.sin(this.timeAcc * 1.7 + gate.pulsePhase);

    // Orbiting rim swirl (~17 particles/s/portal).
    if (gate.spawnT >= SPAWN_TIME * 0.6) {
      gate.swirlTimer += dt;
      const particles = this.ctx.systems.particles;
      while (gate.swirlTimer >= SWIRL_INTERVAL) {
        gate.swirlTimer -= SWIRL_INTERVAL;
        gate.swirlAngle += 2.4;
        if (!particles) continue;
        // Portal plane is spanned by `right` (horizontal) and world-up.
        this._right.crossVectors(UP, gate.normal).normalize();
        const ca = Math.cos(gate.swirlAngle);
        const sa = Math.sin(gate.swirlAngle);
        this._v1.copy(gate.center)
          .addScaledVector(this._right, ca * RADIUS)
          .addScaledVector(UP, sa * RADIUS);
        // Tangent along the rim — particles chase each other around the ring.
        this._v2.copy(this._right).multiplyScalar(-sa).addScaledVector(UP, ca);
        this._swirlOpts.color = gate.swirlColor;
        particles.stream(this._swirlOpts);
      }
    }
  }

  _checkTraversal() {
    const player = this.ctx.systems.player;
    if (!player || !player.position) return;

    // Compare the player's mid-body point against the ring center so walking
    // through at ground level registers cleanly.
    this._v1.copy(player.position);
    this._v1.y += 1.1;

    for (let i = 0; i < this.portals.length; i++) {
      const entry = this.portals[i];
      if (entry.spawnT < SPAWN_TIME) continue;
      if (this._v1.distanceToSquared(entry.center) > TRIGGER_DIST_SQ) continue;

      const exit = this.portals[1 - i];
      if (exit.spawnT < SPAWN_TIME) continue;

      this._traverse(entry, exit);
      break;
    }
  }

  _traverse(entry, exit) {
    const particles = this.ctx.systems.particles;
    const terrain = this.ctx.systems.terrain;

    // Entry suck — same frame as the teleport; the flash IS the transition.
    if (particles) {
      particles.burst({
        position: entry.center,
        color: 0xaa66ff,
        count: 60,
        speed: 9,
        life: 0.38,
        size: 0.24,
      });
      particles.flash(entry.center, 0xbb77ff, 7.5, 0.28);
    }
    entry.surgeT = 0.6;

    // A quick jolt as space folds — internal SpellManager juice channel.
    const spellsSys = this.ctx.systems.spells;
    if (spellsSys && typeof spellsSys.addShake === 'function') spellsSys.addShake(0.3);

    // Destination: 1.5 m out along the exit gate's facing normal, feet on
    // whatever ground is there (terrain may have shifted under the gate).
    this._v2.copy(exit.center).addScaledVector(exit.normal, 1.5);
    let groundY = exit.center.y - CENTER_LIFT;
    if (terrain) {
      const h = terrain.getHeight(this._v2.x, this._v2.z);
      if (h > -99) groundY = Math.max(groundY, h);
    }
    this._v2.y = groundY + 0.1;

    this.travelCooldown = REENTRY_COOLDOWN;
    // Traversal is rare (≥2s apart) — a clone here is safe and avoids
    // aliasing if the player controller keeps the vector by reference.
    if (player_teleport(this.ctx, this._v2.clone()) === false) return;

    // Exit-side beats land next frame (frame 2) via pendingExit.
    this.pendingExit = exit;
  }
}

// player.teleport via a tiny guard so a missing/broken player system can't
// kill the effect loop. Returns false when teleport was impossible.
function player_teleport(ctx, dest) {
  const player = ctx.systems.player;
  if (!player || typeof player.teleport !== 'function') return false;
  player.teleport(dest);
  return true;
}
