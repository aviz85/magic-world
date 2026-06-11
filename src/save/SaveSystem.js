/**
 * SaveSystem — localStorage persistence for Magic World.
 *
 * Persists: blocks (BuildSystem), terrain heightfield (Terrain), player
 * position/yaw/pitch (PlayerController) and sky.timeOfDay under the key
 * `magic-world-save-v1`.
 *
 * Controls (binding contract):
 *   K        → save  + toast "World saved ✨"
 *   L        → load  + toast
 *   Shift+N  → new world: clear save + location.reload() (no confirm)
 *
 * Autosave every 60s (small "Autosaved" toast). Autoload is DEFERRED to the
 * first update() call so every system is guaranteed to exist. Any corrupt or
 * incompatible save is cleared and the world starts fresh — a bad payload can
 * never wedge the game.
 *
 * Robustness:
 *  - Every save first rotates the previous snapshot into a `.bak` slot; a
 *    corrupt main save falls back to the backup before giving up.
 *  - QuotaExceeded on write drops the backup and retries once.
 *  - Loaded player transforms are clamped into world bounds; block lists are
 *    sanitized entry-by-entry before reaching BuildSystem.deserialize.
 *  - Manual saves are throttled (400 ms) against key-repeat storage thrash.
 *  - Autosave is change-aware: it only serializes when the world mutated
 *    (block/terrain/prefab/time events) or the player actually moved — an
 *    idle session never pays the periodic JSON.stringify hitch.
 *  - Flush-save on pagehide / tab-hidden, so closing the tab between
 *    autosaves loses nothing (quiet — no toast).
 */

const SAVE_KEY = 'magic-world-save-v1';
const BACKUP_KEY = 'magic-world-save-v1.bak';
const SAVE_VERSION = 1;
const AUTOSAVE_INTERVAL = 60; // seconds
const MANUAL_SAVE_THROTTLE_MS = 400;

export default class SaveSystem {
  constructor(ctx) {
    this.ctx = ctx;

    // --- timers / state (plain numbers & bools — nothing allocated per frame)
    this.autosaveTimer = 0;
    this.pendingAutoload = false;
    this.started = false;
    this.saving = false; // re-entrancy guard (key spam during a heavy save)
    this.storageOk = true; // false when localStorage is unavailable — mutes autosave
    this._lastManualSave = -Infinity; // key-repeat throttle for manual KeyK saves

    // Check for an existing save NOW (cheap key probe), but defer the actual
    // restore to the first update() — all systems exist by then.
    try {
      this.pendingAutoload = window.localStorage.getItem(SAVE_KEY) !== null;
    } catch (err) {
      // localStorage can throw in privacy modes — degrade to a fresh world.
      console.warn('[SaveSystem] localStorage unavailable, saves disabled', err);
      this.pendingAutoload = false;
      this.storageOk = false;
    }

    // --- change tracking (autosave only serializes when something changed)
    this._dirty = false;
    this._hasSnapshot = false; // becomes true after the first successful save/load
    this._savedX = 0; this._savedY = 0; this._savedZ = 0; this._savedYaw = 0;
    const markDirty = () => { this._dirty = true; };
    ctx.events.on('block:place', markDirty);
    ctx.events.on('block:remove', markDirty);
    ctx.events.on('prefab:place', markDirty);
    ctx.events.on('terrain:modify', markDirty);
    ctx.events.on('time:warp', markDirty);

    // --- input
    ctx.events.on('input:keydown', (payload) => this.onKeyDown(payload));

    // --- flush on tab hide/close so progress between autosaves can't be lost
    const flush = () => {
      if (!this.started || !this.storageOk) return;
      if (!this._dirty && !this.hasPlayerMoved()) return;
      this.save({ auto: true, silent: true });
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  // ----------------------------------------------------------------- input

  onKeyDown({ code, event }) {
    if (code === 'KeyK') {
      this.save();
    } else if (code === 'KeyL') {
      this.load();
    } else if (code === 'KeyN' && this.isShiftHeld(event)) {
      this.newWorld();
    }
  }

  isShiftHeld(event) {
    if (event && event.shiftKey) return true;
    const input = this.ctx.input;
    return !!(input && (input.pressed('ShiftLeft') || input.pressed('ShiftRight')));
  }

  // ----------------------------------------------------------------- frame

  update(dt /* , elapsed */) {
    // Deferred autoload: runs exactly once, on the very first frame, when the
    // full system graph is alive.
    if (!this.started) {
      this.started = true;
      if (this.pendingAutoload) {
        this.pendingAutoload = false;
        this.autoload();
      }
    }

    // Autosave cadence — a single float accumulator, zero allocations.
    // Skipped entirely when storage is known-dead so we never toast-spam.
    if (this.storageOk) {
      this.autosaveTimer += dt;
      if (this.autosaveTimer >= AUTOSAVE_INTERVAL) {
        this.autosaveTimer = 0;
        // Change-aware: skip the serialize entirely when nothing happened —
        // no world mutations and the player hasn't really moved.
        if (this._dirty || this.hasPlayerMoved()) {
          this.save({ auto: true });
        }
      }
    }
  }

  // ------------------------------------------------------------------ save

  /**
   * Snapshot the world to localStorage.
   * @param {{ auto?: boolean }} [opts] auto = quiet autosave toast.
   * @returns {boolean} success
   */
  save({ auto = false, silent = false } = {}) {
    if (this.saving) return false;
    if (!auto) {
      // KeyK held down = key-repeat → don't serialize the world 30×/s.
      const now = Date.now();
      if (now - this._lastManualSave < MANUAL_SAVE_THROTTLE_MS) return false;
      this._lastManualSave = now;
    }
    this.saving = true;
    try {
      const payload = this.buildPayload();
      this.writeSave(JSON.stringify(payload));
      this.ctx.events.emit('game:save', {});
      if (!silent) this.toast(auto ? 'Autosaved' : 'World saved ✨', auto ? 1.4 : 2.5);
      this.storageOk = true; // storage works — (re-)arm autosave
      this._dirty = false;
      this.recordPlayerSnapshot();
      return true;
    } catch (err) {
      // QuotaExceededError, serialization failure, privacy mode…
      console.error('[SaveSystem] save failed', err);
      // Manual saves get a toast; failed autosaves stay quiet (console only)
      // and stop recurring until a manual save proves storage works again.
      if (auto) {
        this.storageOk = false;
      } else {
        this.toast('Save failed — storage unavailable', 3);
      }
      return false;
    } finally {
      this.saving = false;
    }
  }

  /**
   * Write the snapshot, rotating the previous good save into the backup slot.
   * On quota pressure: drop the backup and retry once (rethrow on 2nd failure
   * so save()'s catch handles toasts/flags).
   */
  writeSave(json) {
    const ls = window.localStorage;
    try {
      const prev = ls.getItem(SAVE_KEY);
      if (prev !== null) ls.setItem(BACKUP_KEY, prev);
    } catch (err) {
      // Backup rotation is best-effort — never let it block the real save.
    }
    try {
      ls.setItem(SAVE_KEY, json);
    } catch (err) {
      try { ls.removeItem(BACKUP_KEY); } catch (e2) { /* ignore */ }
      ls.setItem(SAVE_KEY, json); // retry once with the backup's space freed
    }
  }

  buildPayload() {
    const { systems } = this.ctx;
    const player = systems.player;
    const sky = systems.sky;

    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      blocks: systems.build ? systems.build.serialize() : [],
      terrain: systems.terrain ? systems.terrain.serialize() : null,
      player: player
        ? {
            x: player.position.x,
            y: player.position.y,
            z: player.position.z,
            yaw: player.yaw,
            pitch: player.pitch,
          }
        : null,
      timeOfDay: sky ? sky.timeOfDay : 0.35,
    };
  }

  // ------------------------------------------------------------------ load

  /**
   * Manual load (KeyL). Reads, validates and applies the snapshot.
   * @returns {boolean} success
   */
  load() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(SAVE_KEY);
    } catch (err) {
      console.error('[SaveSystem] localStorage read failed', err);
    }
    if (raw === null) {
      this.toast('No saved world found', 2.5);
      return false;
    }

    try {
      const data = this.parseAndValidate(raw);
      this.applyPayload(data);
      this.ctx.events.emit('game:load', {});
      this.toast('World loaded 🌍', 2.5);
      return true;
    } catch (err) {
      // Corrupt save: clear it, then try the previous good snapshot.
      console.error('[SaveSystem] corrupt save — clearing', err);
      this.clearSave();
      if (this.restoreFromBackup()) {
        this.toast('Save was corrupted — restored previous snapshot 🛟', 3.5);
        return true;
      }
      this.toast('Save was corrupted — starting fresh', 3.5);
      return false;
    }
  }

  /** Silent variant used by the deferred constructor autoload. */
  autoload() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(SAVE_KEY);
    } catch (err) {
      console.error('[SaveSystem] localStorage read failed', err);
      return;
    }
    if (raw === null) return;

    try {
      const data = this.parseAndValidate(raw);
      this.applyPayload(data);
      this.ctx.events.emit('game:load', {});
      this.toast('Welcome back ✨ world restored', 3);
    } catch (err) {
      console.error('[SaveSystem] corrupt save on autoload — clearing', err);
      this.clearSave();
      if (this.restoreFromBackup()) {
        this.toast('Restored previous snapshot 🛟', 3.5);
        return;
      }
      // Fresh world simply continues — nothing was applied, or what was
      // applied is overwritten by the next manual interaction. Stay quiet
      // beyond a gentle note so a brand-new session doesn't feel broken.
      this.toast('Old save was corrupted — fresh world', 3.5);
    }
  }

  /**
   * Last-resort load from the backup slot. On success, promotes the backup
   * back into the main slot. A corrupt backup is removed. Quiet (no toasts) —
   * callers own the messaging.
   */
  restoreFromBackup() {
    let raw = null;
    try {
      raw = window.localStorage.getItem(BACKUP_KEY);
    } catch (err) {
      return false;
    }
    if (raw === null) return false;
    try {
      const data = this.parseAndValidate(raw);
      this.applyPayload(data);
      try { window.localStorage.setItem(SAVE_KEY, raw); } catch (e2) { /* best-effort */ }
      this.ctx.events.emit('game:load', {});
      return true;
    } catch (err) {
      console.error('[SaveSystem] backup also corrupt — removing', err);
      try { window.localStorage.removeItem(BACKUP_KEY); } catch (e2) { /* ignore */ }
      return false;
    }
  }

  /**
   * Parse JSON and shape-check the payload. Throws on anything suspicious so
   * callers funnel into the corrupt-save path.
   */
  parseAndValidate(raw) {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('payload is not an object');
    if (data.version !== SAVE_VERSION) throw new Error(`unsupported save version ${data.version}`);
    if (data.blocks != null && !Array.isArray(data.blocks)) throw new Error('blocks is not an array');
    if (data.player != null) {
      const p = data.player;
      if (
        !isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z) ||
        !isFiniteNumber(p.yaw) || !isFiniteNumber(p.pitch)
      ) {
        throw new Error('player transform is not finite');
      }
    }
    if (data.timeOfDay != null && !isFiniteNumber(data.timeOfDay)) {
      throw new Error('timeOfDay is not finite');
    }
    return data;
  }

  /** Apply a validated payload to the live systems. Order matters: terrain
   *  first (player ground + minimap depend on it), then blocks, then player. */
  applyPayload(data) {
    const { systems } = this.ctx;

    if (data.terrain && systems.terrain && typeof systems.terrain.deserialize === 'function') {
      systems.terrain.deserialize(data.terrain);
    }

    if (Array.isArray(data.blocks) && systems.build && typeof systems.build.deserialize === 'function') {
      // Drop malformed entries so a single bad block can't wedge BuildSystem.
      systems.build.deserialize(data.blocks.filter(isValidBlockEntry));
    }

    if (data.player && systems.player) {
      const player = systems.player;
      // Clamp into world bounds — a save edited (or written by an older
      // build) can never spawn the player in the void.
      const bounds = this.ctx.config.worldSize / 2 - 2;
      player.position.set(
        clamp(data.player.x, -bounds, bounds),
        clamp(data.player.y, -20, 400),
        clamp(data.player.z, -bounds, bounds),
      );
      player.yaw = data.player.yaw;
      player.pitch = clamp(data.player.pitch, -1.55, 1.55);
      if (player.velocity && typeof player.velocity.set === 'function') {
        player.velocity.set(0, 0, 0);
      }
    }

    if (isFiniteNumber(data.timeOfDay) && systems.sky) {
      // Wrap into [0, 1) defensively — old saves should never push the sky
      // into an out-of-range phase.
      systems.sky.timeOfDay = ((data.timeOfDay % 1) + 1) % 1;
    }

    // World now mirrors storage — autosave can idle until something changes.
    this._dirty = false;
    this.recordPlayerSnapshot();
  }

  // ------------------------------------------------------------- new world

  /** Shift+N — wipe the save (and its backup) and hard-reload fresh. */
  newWorld() {
    this.clearSave();
    try {
      window.localStorage.removeItem(BACKUP_KEY);
    } catch (err) {
      // ignore — reload proceeds regardless
    }
    window.location.reload();
  }

  /** Clears only the MAIN slot — the backup survives for corruption recovery. */
  clearSave() {
    try {
      window.localStorage.removeItem(SAVE_KEY);
    } catch (err) {
      console.error('[SaveSystem] failed to clear save', err);
    }
  }

  // ---------------------------------------------------------------- helpers

  /** Remember where the player was at the last save/load (plain numbers). */
  recordPlayerSnapshot() {
    const player = this.ctx.systems.player;
    if (!player || !player.position) return;
    this._savedX = player.position.x;
    this._savedY = player.position.y;
    this._savedZ = player.position.z;
    this._savedYaw = player.yaw || 0;
    this._hasSnapshot = true;
  }

  /** True when the player drifted meaningfully from the last snapshot. */
  hasPlayerMoved() {
    if (!this._hasSnapshot) return true; // no baseline yet → save once
    const player = this.ctx.systems.player;
    if (!player || !player.position) return false;
    const dx = player.position.x - this._savedX;
    const dy = player.position.y - this._savedY;
    const dz = player.position.z - this._savedZ;
    if (dx * dx + dy * dy + dz * dz > 1) return true; // > 1 m
    return Math.abs((player.yaw || 0) - this._savedYaw) > 0.25; // looked around
  }

  toast(text, duration = 2.5) {
    this.ctx.events.emit('ui:message', { text, duration });
  }
}

// ---------------------------------------------------------- module helpers

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

function isValidBlockEntry(b) {
  return (
    !!b &&
    isFiniteNumber(b.x) && isFiniteNumber(b.y) && isFiniteNumber(b.z) &&
    typeof b.type === 'string'
  );
}
