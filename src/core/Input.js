/**
 * Input — pointer-lock + keyboard/mouse state for Magic World.
 *
 * Contract (docs/CONTRACTS.md):
 *   - constructor(domElement, events)
 *   - Properties: `keys` (Set of event.code currently held), `pointerLocked` (bool)
 *   - Methods: pressed(code), consumeMouseDelta() -> {x, y}, requestPointerLock()
 *   - Click on domElement requests pointer lock. Mouse deltas tracked only while locked.
 *   - Emits: input:keydown {code, event}, input:keyup {code},
 *            input:mousedown {button} (only while locked, buttons 0 & 2),
 *            input:wheel {deltaY}, input:lockchange {locked}
 *   - Context menu suppressed; keys cleared on window blur and on lock loss.
 *
 * Performance notes:
 *   - consumeMouseDelta() returns a reused scratch object — callers must read
 *     x/y immediately (or copy) and must NOT hold a reference across frames.
 *     This is the only per-frame path; mousemove only accumulates numbers.
 *   - Event emissions allocate small fresh payload literals. They fire at DOM
 *     input rate (not per frame), so this is cheap — and it means listeners
 *     can safely retain or defer payloads without aliasing surprises.
 */
export default class Input {
  /**
   * @param {HTMLElement} domElement renderer canvas — pointer-lock target
   * @param {import('./EventBus.js').default} events shared event bus
   */
  constructor(domElement, events) {
    this.domElement = domElement;
    this.events = events;

    /** @type {Set<string>} `event.code`s currently held down */
    this.keys = new Set();

    /** @type {boolean} true while the pointer is locked to our canvas */
    this.pointerLocked = false;

    // Accumulated mouse movement since the last consumeMouseDelta() call.
    this._dx = 0;
    this._dy = 0;

    // Reused scratch object for the per-frame consumeMouseDelta() hot path.
    this._deltaOut = { x: 0, y: 0 };

    // Keys whose browser defaults fight the game while we're locked
    // (page scroll, quick-find, tab-focus walk...).
    this._preventWhileLocked = new Set([
      'Space', 'Tab', 'Slash', 'Quote',
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    ]);

    // Bind handlers once so add/removeEventListener stay symmetric.
    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onPointerLockChange = this._onPointerLockChange.bind(this);
    this._onPointerLockError = this._onPointerLockError.bind(this);
    this._onBlur = this._onBlur.bind(this);
    this._onVisibility = this._onVisibility.bind(this);

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('wheel', this._onWheel, { passive: false });
    window.addEventListener('contextmenu', this._onContextMenu);
    window.addEventListener('blur', this._onBlur);
    document.addEventListener('visibilitychange', this._onVisibility);
    document.addEventListener('pointerlockchange', this._onPointerLockChange);
    document.addEventListener('pointerlockerror', this._onPointerLockError);

    // Clicking the canvas enters the world.
    domElement.addEventListener('click', this._onClick);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** @param {string} code KeyboardEvent.code, e.g. 'KeyW' @returns {boolean} */
  pressed(code) {
    return this.keys.has(code);
  }

  /**
   * Mouse movement accumulated since the previous call, then reset.
   * Returns a REUSED object — read immediately, do not retain.
   * @returns {{x: number, y: number}}
   */
  consumeMouseDelta() {
    const out = this._deltaOut;
    out.x = this._dx;
    out.y = this._dy;
    this._dx = 0;
    this._dy = 0;
    return out;
  }

  /** Ask the browser to lock the pointer to the game canvas. */
  requestPointerLock() {
    if (this.pointerLocked) return;
    try {
      const p = this.domElement.requestPointerLock();
      // Newer browsers return a promise; swallow rejections (e.g. the
      // "too soon after exiting lock" security timer) — the user just clicks again.
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (err) {
      // Some browsers throw synchronously instead — same story, non-fatal.
    }
  }

  /** Detach every listener (useful for hot-reload / teardown in dev). */
  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('wheel', this._onWheel);
    window.removeEventListener('contextmenu', this._onContextMenu);
    window.removeEventListener('blur', this._onBlur);
    document.removeEventListener('visibilitychange', this._onVisibility);
    document.removeEventListener('pointerlockchange', this._onPointerLockChange);
    document.removeEventListener('pointerlockerror', this._onPointerLockError);
    this.domElement.removeEventListener('click', this._onClick);
    this._releaseAllKeys();
  }

  // ── Internal handlers ─────────────────────────────────────────────────────

  _onClick() {
    this.requestPointerLock();
  }

  _onKeyDown(event) {
    const code = event.code;
    if (!code) return;

    if (this.pointerLocked && this._preventWhileLocked.has(code)) {
      event.preventDefault();
    }

    // OS key auto-repeat would re-fire toggles (fly, mute, mode...) — only
    // the first physical press emits. `keys` membership is the held state.
    if (event.repeat || this.keys.has(code)) return;

    this.keys.add(code);
    this.events.emit('input:keydown', { code, event });
  }

  _onKeyUp(event) {
    const code = event.code;
    if (!code || !this.keys.has(code)) return;
    this.keys.delete(code);
    this.events.emit('input:keyup', { code });
  }

  _onMouseDown(event) {
    if (!this.pointerLocked) return;
    const button = event.button;
    if (button !== 0 && button !== 2) return;
    event.preventDefault();
    this.events.emit('input:mousedown', { button });
  }

  _onMouseMove(event) {
    if (!this.pointerLocked) return;
    // movementX/Y can spike to absurd values on lock transitions in some
    // browsers — clamp so one bad sample can't whip the camera around.
    const mx = event.movementX || 0;
    const my = event.movementY || 0;
    if (mx > 500 || mx < -500 || my > 500 || my < -500) return;
    this._dx += mx;
    this._dy += my;
  }

  _onWheel(event) {
    if (!this.pointerLocked) return;
    event.preventDefault(); // no page zoom/scroll while playing
    this.events.emit('input:wheel', { deltaY: event.deltaY });
  }

  _onContextMenu(event) {
    event.preventDefault(); // right-click is a game action, always
  }

  _onPointerLockChange() {
    const locked = document.pointerLockElement === this.domElement;
    if (locked === this.pointerLocked) return;
    this.pointerLocked = locked;
    if (!locked) this._releaseAllKeys(); // Esc-unlock: no stuck WASD
    this.events.emit('input:lockchange', { locked });
  }

  _onPointerLockError() {
    // Lock denied (user gesture timing, iframe policy...). Treat as unlocked;
    // the menus overlay stays up and the next click retries naturally.
    if (this.pointerLocked) {
      this.pointerLocked = false;
      this._releaseAllKeys();
      this.events.emit('input:lockchange', { locked: false });
    }
  }

  _onBlur() {
    this._releaseAllKeys();
  }

  _onVisibility() {
    if (document.hidden) this._releaseAllKeys();
  }

  /** Clear held keys, emitting input:keyup for each so systems stay consistent. */
  _releaseAllKeys() {
    if (this.keys.size === 0) {
      this._dx = 0;
      this._dy = 0;
      return;
    }
    // Snapshot before emitting — a listener reacting to input:keyup must not
    // be able to mutate the Set we're iterating.
    const held = [...this.keys];
    this.keys.clear();
    for (const code of held) {
      this.events.emit('input:keyup', { code });
    }
    this._dx = 0;
    this._dy = 0;
  }
}
