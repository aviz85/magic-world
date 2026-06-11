/**
 * EventBus — tiny, robust synchronous pub/sub for Magic World.
 *
 * Design notes (performance-first — emit() runs in hot per-frame paths):
 * - Listeners are stored in plain arrays inside a Map keyed by event name.
 * - emit() iterates by index over the live array with a length snapshot:
 *   listeners added DURING an emit are not called for that emit; listeners
 *   removed during an emit are skipped safely (compaction is deferred).
 * - Removal during dispatch marks slots as null and compacts after the
 *   dispatch finishes — no array copying per emit, zero allocations on the
 *   hot path when nothing changes.
 * - Every listener call is wrapped in try/catch so one faulty system can
 *   never kill the frame; failures go to console.error with context.
 */
export default class EventBus {
  constructor() {
    /** @type {Map<string, Array<Function|null>>} event name → listener list */
    this._listeners = new Map();
    /** Depth counter: > 0 while emit() is dispatching (re-entrancy safe). */
    this._emitting = 0;
    /** Event names whose listener arrays need null-compaction post-emit. */
    this._dirty = new Set();
  }

  /**
   * Subscribe `fn` to `name`.
   * @param {string} name
   * @param {Function} fn  receives the emit payload
   * @returns {Function} unsubscribe — call it to remove this listener
   */
  on(name, fn) {
    if (typeof fn !== 'function') {
      console.error(`[EventBus] on("${name}"): listener is not a function`, fn);
      return () => {};
    }
    let list = this._listeners.get(name);
    if (!list) {
      list = [];
      this._listeners.set(name, list);
    }
    list.push(fn);
    let active = true; // make the unsubscriber idempotent
    return () => {
      if (!active) return;
      active = false;
      this.off(name, fn);
    };
  }

  /**
   * Subscribe `fn` to `name` for a single emission, then auto-remove.
   * @param {string} name
   * @param {Function} fn
   * @returns {Function} unsubscribe (works even before the event fires)
   */
  once(name, fn) {
    if (typeof fn !== 'function') {
      console.error(`[EventBus] once("${name}"): listener is not a function`, fn);
      return () => {};
    }
    const bus = this;
    const wrapper = function (payload) {
      bus.off(name, wrapper);
      fn(payload);
    };
    wrapper._origin = fn; // let off(name, fn) also remove the once-wrapper
    return this.on(name, wrapper);
  }

  /**
   * Remove a listener. Matches both direct subscriptions and once() wrappers
   * registered with the same original function.
   * @param {string} name
   * @param {Function} fn
   */
  off(name, fn) {
    const list = this._listeners.get(name);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const l = list[i];
      if (l !== null && (l === fn || l._origin === fn)) {
        if (this._emitting > 0) {
          // Mid-dispatch: null the slot, compact later. Keeps emit's index
          // iteration stable without copying the array.
          list[i] = null;
          this._dirty.add(name);
        } else {
          list.splice(i, 1);
        }
        break; // remove a single registration per off() call
      }
    }
    if (this._emitting === 0 && list.length === 0) {
      this._listeners.delete(name);
    }
  }

  /**
   * Synchronously dispatch `payload` to all listeners of `name`.
   * Each listener runs inside its own try/catch — one bad listener cannot
   * prevent the others from running or break the frame.
   * @param {string} name
   * @param {*} [payload]
   */
  emit(name, payload) {
    const list = this._listeners.get(name);
    if (!list || list.length === 0) return;

    this._emitting++;
    // Snapshot length: listeners added during this emit fire next time.
    const len = list.length;
    for (let i = 0; i < len; i++) {
      const fn = list[i];
      if (fn === null) continue; // removed mid-dispatch
      try {
        fn(payload);
      } catch (err) {
        console.error(`[EventBus] listener error for "${name}"`, err);
      }
    }
    this._emitting--;

    if (this._emitting === 0 && this._dirty.size > 0) {
      this._compact();
    }
  }

  /**
   * Remove all listeners for `name`, or every listener on the bus when
   * called with no arguments. Safe to call mid-dispatch.
   * @param {string} [name]
   */
  clear(name) {
    if (name === undefined) {
      if (this._emitting > 0) {
        for (const [key, list] of this._listeners) {
          for (let i = 0; i < list.length; i++) list[i] = null;
          this._dirty.add(key);
        }
      } else {
        this._listeners.clear();
        this._dirty.clear();
      }
      return;
    }
    const list = this._listeners.get(name);
    if (!list) return;
    if (this._emitting > 0) {
      for (let i = 0; i < list.length; i++) list[i] = null;
      this._dirty.add(name);
    } else {
      this._listeners.delete(name);
    }
  }

  /**
   * Number of live listeners for an event (diagnostics / tests).
   * @param {string} name
   * @returns {number}
   */
  listenerCount(name) {
    const list = this._listeners.get(name);
    if (!list) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i] !== null) n++;
    }
    return n;
  }

  /** Compact null slots left by removals that happened during dispatch. */
  _compact() {
    for (const name of this._dirty) {
      const list = this._listeners.get(name);
      if (!list) continue;
      let w = 0;
      for (let r = 0; r < list.length; r++) {
        const fn = list[r];
        if (fn !== null) list[w++] = fn;
      }
      list.length = w;
      if (w === 0) this._listeners.delete(name);
    }
    this._dirty.clear();
  }
}
