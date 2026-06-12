import * as THREE from 'three';
import { canvasTexture } from '../core/AssetFactory.js';

/**
 * Butterflies — 8 pastel butterflies that flutter over the meadows by day.
 *
 * Daytime mirror of the Wisps: they wake when the sun is up
 * (sky.getSunIntensity() > 0.3) and shrink away to nothing at dusk.
 * Each butterfly is a tiny group with TWO plane-mesh wings hinged at the
 * body axis; wings flap by rotating around that axis — fast (~12 Hz) while
 * fluttering, slow + raised in a dihedral during 1–2 s glides. Wing art is
 * a shared canvas texture (one per palette variant: peach/pink, cyan,
 * lavender) on MeshBasicMaterial, DoubleSide + alphaTest so there's no
 * transparency sorting cost.
 *
 * Motion: an anchor drifts toward a wander goal 0.5–2.5 m above the
 * terrain, with layered sinusoidal bob for the erratic flutter feel.
 * Goals are gently pulled back toward within 25 m of world center so the
 * flock stays near the player's usual stomping grounds.
 *
 * Budget: 8 groups × 2 planes (8 tris total each), 3 materials, 3 small
 * canvas textures, zero lights. All motion math is skipped beyond 50 m
 * from the camera (distance-squared gate) and the whole system early-outs
 * at night. No per-frame allocations — scratch vectors only.
 */

const BUTTERFLY_COUNT = 8;
const GOLDEN_ANGLE = 2.399963;

const ALT_MIN = 0.5;            // m above terrain
const ALT_MAX = 2.5;
const DRIFT_SPEED = 1.1;        // m/s anchor drift toward goal
const GOAL_RADIUS = 14;         // m — wander goal pick radius
const HOME_RADIUS = 25;         // m — stay roughly this close to world center
const ACTIVE_MAX_DIST_SQ = 50 * 50; // skip motion math beyond this (camera)
const SUN_WAKE = 0.3;           // sky.getSunIntensity() threshold

const FLAP_HZ = 12;             // wingbeats per second while fluttering
const GLIDE_HZ = 2.2;           // lazy wing waggle while gliding

// Pastel wing palettes: [inner glow, outer wash, spot accent]
const PALETTES = [
  ['#ffd9c2', '#ff9ad5', '#ff5fa8'], // peach / pink
  ['#d8fbff', '#7fe7ff', '#2fb8e6'], // cyan
  ['#efe2ff', '#c88bff', '#9b6ff2'], // lavender
];

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

// Paint one wing (hinge at the left edge, tip at the right) — two soft
// lobes, pastel gradient, a darker rim and a little accent spot.
function drawWing(c, size, palette) {
  const [inner, outer, spot] = palette;
  c.clearRect(0, 0, size, size);

  const g = c.createLinearGradient(0, 0, size, 0);
  g.addColorStop(0, inner);
  g.addColorStop(1, outer);
  c.fillStyle = g;
  c.strokeStyle = spot;
  c.lineWidth = size * 0.045;

  // Fore-lobe (upper) — fat ellipse leaning up-and-out from the hinge.
  c.save();
  c.translate(size * 0.08, size * 0.42);
  c.rotate(-0.35);
  c.beginPath();
  c.ellipse(size * 0.34, 0, size * 0.36, size * 0.26, 0, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.restore();

  // Hind-lobe (lower) — smaller, tucked behind.
  c.save();
  c.translate(size * 0.06, size * 0.66);
  c.rotate(0.3);
  c.beginPath();
  c.ellipse(size * 0.26, 0, size * 0.27, size * 0.19, 0, 0, Math.PI * 2);
  c.fill();
  c.stroke();
  c.restore();

  // Accent spot on the fore-lobe.
  c.fillStyle = spot;
  c.beginPath();
  c.ellipse(size * 0.52, size * 0.3, size * 0.08, size * 0.06, -0.35, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.9)';
  c.beginPath();
  c.ellipse(size * 0.52, size * 0.3, size * 0.035, size * 0.026, -0.35, 0, Math.PI * 2);
  c.fill();
}

export default class Butterflies {
  constructor(ctx) {
    this.ctx = ctx;

    this._rng = mulberry32(48121);

    this._group = new THREE.Group();
    this._group.name = 'butterflies';
    ctx.scene.add(this._group);

    // ---- Shared wing assets: 3 textures, 3 materials, 2 geometries -------
    this._materials = PALETTES.map((palette) => {
      const tex = canvasTexture(64, (c, size) => drawWing(c, size, palette));
      return new THREE.MeshBasicMaterial({
        map: tex,
        side: THREE.DoubleSide,
        alphaTest: 0.4,
        fog: true,
      });
    });

    // Wings lie flat in the XZ plane, hinged on the body axis (local Z =
    // forward). Rotating a wing mesh around Z lifts its tip in Y — the flap.
    const W = 0.30; // wing span (one side), m
    const L = 0.26; // wing chord, m
    const leftGeo = new THREE.PlaneGeometry(W, L);
    leftGeo.translate(W / 2, 0, 0);   // hinge at x=0, wing extends +X
    leftGeo.rotateX(-Math.PI / 2);    // lay flat
    const rightGeo = new THREE.PlaneGeometry(W, L);
    rightGeo.scale(-1, 1, 1);         // mirror texture so spots match
    rightGeo.translate(-W / 2, 0, 0); // wing extends -X
    rightGeo.rotateX(-Math.PI / 2);
    this._leftGeo = leftGeo;
    this._rightGeo = rightGeo;

    // ---- Build the flock ---------------------------------------------------
    const rand = this._rng;
    this.butterflies = [];
    for (let i = 0; i < BUTTERFLY_COUNT; i++) {
      const mat = this._materials[i % PALETTES.length];
      const phase = i * GOLDEN_ANGLE;

      const holder = new THREE.Group();
      const wingL = new THREE.Mesh(leftGeo, mat);
      const wingR = new THREE.Mesh(rightGeo, mat);
      holder.add(wingL);
      holder.add(wingR);
      holder.visible = false; // woken by the first daytime update

      // Scatter anchors in a loose ring inside the home radius.
      const ang = phase + rand() * 0.9;
      const r = 4 + rand() * (HOME_RADIUS - 6);
      const anchor = new THREE.Vector3(Math.cos(ang) * r, 3, Math.sin(ang) * r);

      const b = {
        holder,
        wingL,
        wingR,
        phase,
        anchor,
        goal: anchor.clone(),
        goalTimer: rand() * 3,        // stagger first repicks
        yaw: rand() * Math.PI * 2,    // smoothed heading
        glide: 0,                     // >0 → gliding, counts down
        glideBlend: 0,                // 0 flutter ↔ 1 glide (smoothed)
        flapPhase: rand() * Math.PI * 2,
        size: 0.85 + rand() * 0.35,   // personality scale
      };
      this.butterflies.push(b);
      this._group.add(holder);
    }

    this._dayBlend = 0; // 0 hidden ↔ 1 fully out (smoothed on sun)

    // ---- Scratch objects (no per-frame allocs) -----------------------------
    this._vGoalDelta = new THREE.Vector3();
    this._vPos = new THREE.Vector3();
    this._halfWorld = ctx.config.worldSize / 2 - 4;
  }

  // ---------------------------------------------------------------------------

  _pickGoal(b) {
    const rand = this._rng;
    const goal = b.goal;
    const anchor = b.anchor;

    const ang = rand() * Math.PI * 2;
    const r = 3 + rand() * (GOAL_RADIUS - 3);
    goal.set(anchor.x + Math.cos(ang) * r, 0, anchor.z + Math.sin(ang) * r);

    // Gentle homing: if the goal strays past the home radius, pull it back
    // toward world center so the flock loiters near the player's area.
    const flat = Math.sqrt(goal.x * goal.x + goal.z * goal.z);
    if (flat > HOME_RADIUS) {
      const pull = HOME_RADIUS / flat;
      // halfway between "stay put" and "snap to the rim" — soft attraction
      goal.x *= 0.5 + 0.5 * pull;
      goal.z *= 0.5 + 0.5 * pull;
    }

    const hw = this._halfWorld;
    if (goal.x > hw) goal.x = hw;
    else if (goal.x < -hw) goal.x = -hw;
    if (goal.z > hw) goal.z = hw;
    else if (goal.z < -hw) goal.z = -hw;

    const terrain = this.ctx.systems.terrain;
    const h = terrain ? terrain.getHeight(goal.x, goal.z) : 0;
    const floor = Math.max(h, this.ctx.config.waterLevel);
    goal.y = floor + ALT_MIN + this._rng() * (ALT_MAX - ALT_MIN);
    b.goalTimer = 3 + rand() * 4;

    // Occasionally settle into a 1–2 s glide on the way there.
    if (rand() < 0.35) b.glide = 1 + rand();
  }

  // ---------------------------------------------------------------------------

  update(dt, elapsed) {
    const sys = this.ctx.systems;
    const terrain = sys.terrain;
    const sky = sys.sky;
    if (!terrain) return;

    // ---- Day/night gate: fade in by day, shrink to nothing at night --------
    const sun = sky && sky.getSunIntensity ? sky.getSunIntensity() : 1;
    const dayTarget = sun > SUN_WAKE ? 1 : 0;
    this._dayBlend += (dayTarget - this._dayBlend) * Math.min(1, dt * 1.5);
    const day = this._dayBlend;
    if (day < 0.02) {
      if (this._group.visible) this._group.visible = false;
      return;
    }
    this._group.visible = true;

    const camPos = this.ctx.camera.position;
    const dGoal = this._vGoalDelta;
    const pos = this._vPos;

    for (let i = 0; i < this.butterflies.length; i++) {
      const b = this.butterflies[i];
      const anchor = b.anchor;
      const phase = b.phase;

      // Day fade applies even when far — cheap, keeps scale consistent.
      const s = b.size * day;
      b.holder.scale.set(s, s, s);
      b.holder.visible = true;

      // ---- Camera distance gate: freeze far butterflies mid-pose ----------
      const cdx = anchor.x - camPos.x;
      const cdy = anchor.y - camPos.y;
      const cdz = anchor.z - camPos.z;
      if (cdx * cdx + cdy * cdy + cdz * cdz > ACTIVE_MAX_DIST_SQ) continue;

      // ---- Wander goal ------------------------------------------------------
      b.goalTimer -= dt;
      if (b.goalTimer <= 0) this._pickGoal(b);

      dGoal.subVectors(b.goal, anchor);
      const goalDist = dGoal.length();
      if (goalDist > 0.2) {
        // Glides carry a touch more speed — wings set, riding the air.
        const speed = DRIFT_SPEED * (1 + 0.3 * b.glideBlend);
        const step = Math.min(goalDist, speed * dt);
        anchor.addScaledVector(dGoal, step / goalDist);
      } else if (b.goalTimer > 0.6) {
        b.goalTimer = 0.2 + this._rng() * 0.4; // arrived — flit off again soon
      }

      // ---- Glide state ------------------------------------------------------
      if (b.glide > 0) b.glide = Math.max(0, b.glide - dt);
      b.glideBlend += ((b.glide > 0 ? 1 : 0) - b.glideBlend) * Math.min(1, dt * 4);

      // ---- Erratic flutter bob on top of the anchor --------------------------
      // Bob amplitude eases off while gliding (smooth sail vs jittery flit).
      const bobAmp = 1 - 0.7 * b.glideBlend;
      pos.set(
        anchor.x + Math.sin(elapsed * 1.9 + phase) * 0.35 * bobAmp,
        anchor.y +
          (Math.sin(elapsed * 3.7 + phase * 2) * 0.22 +
            Math.sin(elapsed * 7.3 + phase * 5) * 0.1) *
            bobAmp,
        anchor.z + Math.cos(elapsed * 1.6 + phase) * 0.35 * bobAmp,
      );

      // ---- Altitude clamp: 0.5–2.5 m above ground (or water) ----------------
      const ground = terrain.getHeight(pos.x, pos.z);
      const floorBase =
        ground > -50
          ? Math.max(ground, this.ctx.config.waterLevel)
          : this.ctx.config.waterLevel;
      const lo = floorBase + ALT_MIN;
      const hi = floorBase + ALT_MAX;
      if (pos.y < lo) {
        pos.y = lo;
        if (anchor.y < lo) anchor.y += (lo + 0.3 - anchor.y) * Math.min(1, dt * 2);
      } else if (pos.y > hi) {
        pos.y = hi;
        if (anchor.y > hi) anchor.y += (hi - 0.3 - anchor.y) * Math.min(1, dt * 2);
      }

      b.holder.position.copy(pos);

      // ---- Heading: smooth shortest-arc turn toward travel direction --------
      if (goalDist > 0.2) {
        const targetYaw = Math.atan2(dGoal.x, dGoal.z);
        let dYaw = targetYaw - b.yaw;
        if (dYaw > Math.PI) dYaw -= Math.PI * 2;
        else if (dYaw < -Math.PI) dYaw += Math.PI * 2;
        b.yaw += dYaw * Math.min(1, dt * 3);
      }
      b.holder.rotation.y = b.yaw;
      // Slight nose-down pitch while gliding, level while fluttering.
      b.holder.rotation.x = 0.25 * b.glideBlend;

      // ---- Wing flap: rotate each wing around the body (Z) axis --------------
      // Flutter: big fast strokes at ~12 Hz. Glide: wings held in a raised
      // dihedral with a slow shallow waggle.
      const hz = FLAP_HZ + (GLIDE_HZ - FLAP_HZ) * b.glideBlend;
      b.flapPhase += dt * hz * Math.PI * 2;
      if (b.flapPhase > Math.PI * 2000) b.flapPhase -= Math.PI * 2000; // keep sin precise
      const amp = 1.0 * (1 - b.glideBlend) + 0.18 * b.glideBlend;
      const dihedral = 0.55 * b.glideBlend; // raised-V wing set while sailing
      const flap = Math.sin(b.flapPhase + phase) * amp + dihedral;
      b.wingL.rotation.z = flap;
      b.wingR.rotation.z = -flap;
    }
  }
}
