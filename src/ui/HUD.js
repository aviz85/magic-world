/**
 * Magic World — HUD
 *
 * Fantasy-glass heads-up display living inside `#ui`:
 *   - Crosshair (dot + ring)
 *   - Mana bar (bottom-left, cyan→violet gradient, scaleX-animated, red flash + shake on `mana:insufficient`)
 *   - 9-slot hotbar (bottom-center): spell icons in MAGIC mode (with radial conic cooldown sweeps and a
 *     ready-flash when a cooldown completes), block swatches in BUILD mode (slots 1–8).
 *     Selected slot highlighted with a gold back-out pop.
 *   - Mode badge above the hotbar ("✨ Magic" / "🧱 Build", cross-fading on `mode:change`)
 *   - Toast stack (top-center) fed by `ui:message`
 *   - Tips line (bottom-right)
 *
 * Performance notes:
 *   - All structural DOM is built once (and rebuilt only on `mode:change`). Per-frame writes are limited
 *     to the mana bar `transform` and the cooldown overlays' `--cd` sweep angle — each quantized and
 *     cached so the style is only touched when the visible value actually changes.
 *   - No per-frame allocations beyond the (contract-sanctioned) `spells.getState()` call and an occasional
 *     short string when a quantized value crosses a step.
 */

const SLOT_COUNT = 9;

// Fallback block palette (matches the binding Blocks.js roster) — used until/unless the
// live BuildSystem exposes its defs or `build:select` events deliver the real ones.
const FALLBACK_BLOCKS = [
  { id: 'stone', name: 'Stone', color: '#8d8d97', glow: false },
  { id: 'wood', name: 'Wood', color: '#9a6a35', glow: false },
  { id: 'marble', name: 'Marble', color: '#eceae2', glow: false },
  { id: 'gold', name: 'Gold', color: '#ffd24a', glow: true },
  { id: 'crystal', name: 'Crystal', color: '#7fe7ff', glow: true },
  { id: 'leaf', name: 'Leaf', color: '#58b558', glow: false },
  { id: 'lava', name: 'Lava', color: '#ff6622', glow: true },
  { id: 'glass', name: 'Glass', color: '#cfeaff', glow: false },
];

const STYLE_TEXT = `
.mw-hud, .mw-hud * { box-sizing: border-box; margin: 0; padding: 0; user-select: none; }
.mw-hud {
  position: fixed; inset: 0; pointer-events: none; z-index: 10;
  font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif;
  color: rgba(255, 255, 255, 0.92);
  --panel-bg: linear-gradient(180deg, rgba(22, 26, 52, 0.62), rgba(10, 12, 28, 0.52));
  --edge: rgba(127, 231, 255, 0.35);
  --glow: 0 0 12px rgba(127, 231, 255, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.10),
          inset 0 0 8px rgba(127, 231, 255, 0.08);
  --gold: #ffd86b;
  --red: #ff5566;
  --txt2: rgba(255, 255, 255, 0.55);
}

/* ---------- Crosshair ---------- */
.mw-crosshair {
  position: absolute; left: 50%; top: 50%; width: 0; height: 0;
}
.mw-crosshair .dot {
  position: absolute; left: -2px; top: -2px; width: 4px; height: 4px; border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 0 4px rgba(127, 231, 255, 0.8);
}
.mw-crosshair .ring {
  position: absolute; left: -9px; top: -9px; width: 18px; height: 18px; border-radius: 50%;
  border: 1.5px solid rgba(255, 255, 255, 0.35);
}

/* ---------- Mana bar ---------- */
.mw-mana {
  position: absolute; left: 20px; bottom: 20px; width: 220px;
}
.mw-mana .mana-label {
  font-size: 11px; letter-spacing: 1px; text-transform: uppercase;
  color: var(--txt2); margin-bottom: 4px;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
}
.mw-mana .mana-shell {
  width: 220px; height: 18px; padding: 2px; border-radius: 9px;
  background: var(--panel-bg);
  border: 1px solid var(--edge);
  box-shadow: var(--glow);
  backdrop-filter: blur(10px) saturate(1.35);
  -webkit-backdrop-filter: blur(10px) saturate(1.35);
  transition: border-color 150ms ease-out, box-shadow 150ms ease-out;
  overflow: hidden;
}
.mw-mana .mana-fill {
  position: relative; overflow: hidden;
  width: 100%; height: 100%; border-radius: 7px;
  background: linear-gradient(90deg, #7fe7ff 0%, #9d7bff 60%, #d36bff 100%);
  box-shadow: 0 0 8px rgba(157, 123, 255, 0.6);
  transform-origin: left center;
  transform: scaleX(1);
  transition: transform 120ms linear;
  will-change: transform;
}
.mw-mana .mana-fill::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(115deg, transparent 25%, rgba(255, 255, 255, 0.35) 50%, transparent 75%);
  transform: translateX(-100%);
  animation: mw-mana-sheen 3.4s ease-in-out infinite;
}
@keyframes mw-mana-sheen {
  0%, 55% { transform: translateX(-100%); }
  90%, 100% { transform: translateX(100%); }
}
.mw-mana.low .mana-fill { animation: mw-mana-low 0.85s ease-in-out infinite alternate; }
@keyframes mw-mana-low {
  from { filter: saturate(1) brightness(1); }
  to   { filter: saturate(1.7) brightness(1.35); }
}
.mw-mana.flash .mana-shell {
  border-color: var(--red);
  box-shadow: 0 0 14px rgba(255, 85, 102, 0.8);
}
.mw-mana.flash { animation: mw-mana-shake 300ms ease-in-out; }
@keyframes mw-mana-shake {
  0% { transform: translateX(0); }
  20% { transform: translateX(-3px); }
  45% { transform: translateX(3px); }
  70% { transform: translateX(-3px); }
  100% { transform: translateX(0); }
}

/* ---------- Mode badge ---------- */
.mw-badge {
  position: absolute; left: 50%; bottom: 86px; transform: translateX(-50%);
  padding: 5px 18px; border-radius: 999px;
  background: var(--panel-bg);
  border: 1px solid var(--edge);
  box-shadow: var(--glow);
  backdrop-filter: blur(10px) saturate(1.35);
  -webkit-backdrop-filter: blur(10px) saturate(1.35);
  font-size: 13px; font-weight: 600; letter-spacing: 0.6px; white-space: nowrap;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
  transition: opacity 150ms ease-out, border-color 150ms ease-out, box-shadow 150ms ease-out;
}
.mw-badge.build {
  border-color: rgba(255, 216, 107, 0.45);
  box-shadow: 0 0 12px rgba(255, 216, 107, 0.25), inset 0 0 8px rgba(255, 216, 107, 0.08);
}
.mw-badge.fading { opacity: 0; }

/* ---------- Hotbar ---------- */
.mw-hotbar {
  position: absolute; left: 50%; bottom: 20px; transform: translateX(-50%);
  display: flex; gap: 6px;
}
.mw-slot {
  position: relative; width: 52px; height: 52px; border-radius: 8px;
  background: var(--panel-bg);
  border: 1px solid rgba(127, 231, 255, 0.25);
  box-shadow: var(--glow);
  backdrop-filter: blur(10px) saturate(1.35);
  -webkit-backdrop-filter: blur(10px) saturate(1.35);
  overflow: hidden;
  transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1),
              border-color 200ms cubic-bezier(0.34, 1.56, 0.64, 1),
              box-shadow 200ms cubic-bezier(0.34, 1.56, 0.64, 1),
              opacity 150ms ease-out;
}
.mw-slot.selected {
  border: 2px solid var(--gold);
  box-shadow: 0 0 14px rgba(255, 216, 107, 0.55);
  transform: translateY(-4px) scale(1.08);
}
.mw-slot.empty { opacity: 0.25; }
.mw-slot .num {
  position: absolute; top: 3px; left: 5px; font-size: 9px;
  color: var(--txt2); z-index: 3; pointer-events: none;
}
.mw-slot .icon {
  position: absolute; left: 0; right: 0; top: 7px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  font-size: 24px; line-height: 1; z-index: 2;
  transition: filter 150ms ease-out, opacity 150ms ease-out;
}
.mw-slot .icon .swatch {
  width: 24px; height: 24px; border-radius: 4px; display: block;
  border: 1px solid rgba(255, 255, 255, 0.25);
}
.mw-slot .label {
  position: absolute; left: 3px; right: 3px; bottom: 4px;
  font-size: 9.5px; font-weight: 500; text-align: center;
  color: rgba(255, 255, 255, 0.72);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  z-index: 2;
}
.mw-slot.selected .label { color: #ffe9b0; }
.mw-slot .cd {
  position: absolute; inset: 0; z-index: 1;
  background: conic-gradient(rgba(8, 10, 26, 0.78) calc(var(--cd, 0) * 1%), rgba(8, 10, 26, 0) 0);
  opacity: 0;
  transition: opacity 150ms ease-out;
}
.mw-slot.cooling .cd { opacity: 1; }
.mw-slot.cooling .icon { filter: grayscale(0.8); opacity: 0.5; }
.mw-slot.ready-pop .icon { animation: mw-ready-pop 450ms cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes mw-ready-pop {
  0%   { transform: scale(0.82); filter: brightness(2.4) drop-shadow(0 0 10px rgba(127, 231, 255, 0.9)); }
  100% { transform: scale(1); filter: none; }
}
.mw-slot.cast-pop { animation: mw-cast-pop 250ms cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes mw-cast-pop {
  0% { transform: scale(1); }
  40% { transform: scale(1.16); }
  100% { transform: scale(1); }
}
.mw-slot.selected.cast-pop { animation: mw-cast-pop-sel 250ms cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes mw-cast-pop-sel {
  0% { transform: translateY(-4px) scale(1.08); }
  40% { transform: translateY(-6px) scale(1.22); }
  100% { transform: translateY(-4px) scale(1.08); }
}

/* ---------- Toasts ---------- */
.mw-toasts {
  position: absolute; top: 24px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center;
  z-index: 20;
}
.mw-toast {
  padding: 8px 20px; border-radius: 999px; margin-bottom: 8px;
  max-width: 420px; font-size: 14px; text-align: center;
  background: var(--panel-bg);
  border: 1px solid var(--edge);
  box-shadow: var(--glow);
  backdrop-filter: blur(10px) saturate(1.35);
  -webkit-backdrop-filter: blur(10px) saturate(1.35);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  animation: mw-toast-in 200ms ease-out;
  transition: opacity 300ms ease-in, transform 300ms ease-in;
  opacity: 1;
}
.mw-toast.leaving { opacity: 0; transform: translateY(-8px); }
@keyframes mw-toast-in {
  from { opacity: 0; transform: translateY(-12px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ---------- Tips ---------- */
.mw-tips {
  position: absolute; right: 20px; bottom: 20px;
  font-size: 11px; color: rgba(255, 255, 255, 0.4);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  white-space: nowrap;
}
`;

export default class HUD {
  constructor(ctx) {
    this.ctx = ctx;

    this.mode = 'magic';
    this.selectedMagic = 0;
    this.selectedBuild = 0;
    this.blockDefs = FALLBACK_BLOCKS.slice();

    // per-frame caches (avoid touching the DOM when nothing visible changed)
    this._lastMana = -1;
    this._lowMana = false;
    this._flashTimer = 0;
    this._syncTimer = 0;

    this._buildDom();
    this._harvestBlockDefs();
    this._bindEvents();

    // spells is constructed before hud → safe to read in constructor
    try {
      const spells = this.ctx.systems.spells;
      if (spells && typeof spells.getState === 'function') {
        const state = spells.getState();
        this.mode = state.mode === 'build' ? 'build' : 'magic';
        this.selectedMagic = state.selected | 0;
      }
    } catch (err) {
      console.error('[HUD] initial spell state unavailable', err);
    }
    this._renderHotbar();
    this._renderBadge(false);
  }

  /* ================================================================ DOM */

  _buildDom() {
    const ui = document.querySelector('#ui');

    this.style = document.createElement('style');
    this.style.textContent = STYLE_TEXT;
    document.head.appendChild(this.style);

    this.root = document.createElement('div');
    this.root.className = 'mw-hud';

    // crosshair
    const cross = document.createElement('div');
    cross.className = 'mw-crosshair';
    const ring = document.createElement('div');
    ring.className = 'ring';
    const dot = document.createElement('div');
    dot.className = 'dot';
    cross.appendChild(ring);
    cross.appendChild(dot);
    this.root.appendChild(cross);

    // mana bar
    this.manaWrap = document.createElement('div');
    this.manaWrap.className = 'mw-mana';
    const manaLabel = document.createElement('div');
    manaLabel.className = 'mana-label';
    manaLabel.textContent = 'Mana';
    const manaShell = document.createElement('div');
    manaShell.className = 'mana-shell';
    this.manaFill = document.createElement('div');
    this.manaFill.className = 'mana-fill';
    manaShell.appendChild(this.manaFill);
    this.manaWrap.appendChild(manaLabel);
    this.manaWrap.appendChild(manaShell);
    this.root.appendChild(this.manaWrap);

    // mode badge
    this.badge = document.createElement('div');
    this.badge.className = 'mw-badge';
    this.root.appendChild(this.badge);

    // hotbar — 9 slots, structural DOM built once, refs cached
    this.hotbar = document.createElement('div');
    this.hotbar.className = 'mw-hotbar';
    this.slots = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const el = document.createElement('div');
      el.className = 'mw-slot';

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1);
      el.appendChild(num);

      const cd = document.createElement('div');
      cd.className = 'cd';
      el.appendChild(cd);

      const icon = document.createElement('div');
      icon.className = 'icon';
      el.appendChild(icon);

      const label = document.createElement('div');
      label.className = 'label';
      el.appendChild(label);

      this.hotbar.appendChild(el);
      this.slots.push({ el, icon, label, cd, lastCd: -1, cooling: false, selected: false });
    }
    this.root.appendChild(this.hotbar);

    // toasts
    this.toastStack = document.createElement('div');
    this.toastStack.className = 'mw-toasts';
    this.root.appendChild(this.toastStack);

    // tips
    const tips = document.createElement('div');
    tips.className = 'mw-tips';
    tips.textContent = 'B: build/magic · F: fly · H: help · K/L: save/load';
    this.root.appendChild(tips);

    if (ui) ui.appendChild(this.root);
    else document.body.appendChild(this.root);
  }

  /* ============================================================= events */

  _bindEvents() {
    const ev = this.ctx.events;

    ev.on('mode:change', ({ mode }) => {
      if (mode !== this.mode) this._setMode(mode);
    });

    ev.on('spell:select', ({ index }) => {
      this.selectedMagic = index | 0;
      if (this.mode === 'magic') this._applySelection(this.selectedMagic);
    });

    ev.on('build:select', ({ index, def }) => {
      const i = index | 0;
      this.selectedBuild = i;
      if (def && i >= 0 && i < this.blockDefs.length) {
        const norm = this._normalizeBlockDef(def, i);
        if (norm) {
          this.blockDefs[i] = norm;
          if (this.mode === 'build') this._renderBlockSlot(i);
        }
      }
      if (this.mode === 'build') this._applySelection(this.selectedBuild);
    });

    ev.on('ui:message', (payload) => {
      if (!payload || !payload.text) return;
      this._toast(payload.text, payload.duration);
    });

    ev.on('mana:insufficient', () => this._flashMana());

    // juice: pop the slot of the spell that just fired
    ev.on('spell:cast', ({ id }) => {
      if (this.mode !== 'magic' || !this._spellIds) return;
      const i = this._spellIds.indexOf(id);
      if (i < 0) return;
      const slot = this.slots[i];
      slot.el.classList.remove('cast-pop');
      // restart the keyframe animation
      void slot.el.offsetWidth;
      slot.el.classList.add('cast-pop');
    });

    ev.on('prefab:place', ({ name }) => {
      if (name) this._toast('\u{1F3F0} ' + name.charAt(0).toUpperCase() + name.slice(1) + ' conjured!', 2.5);
    });
  }

  /* ============================================================ hotbar */

  _setMode(mode) {
    this.mode = mode === 'build' ? 'build' : 'magic';
    this._renderHotbar();
    this._renderBadge(true);
  }

  _renderBadge(crossFade) {
    const apply = () => {
      this.badge.textContent = this.mode === 'build' ? '\u{1F9F1} Build' : '✨ Magic';
      this.badge.classList.toggle('build', this.mode === 'build');
      this.badge.classList.remove('fading');
    };
    if (crossFade) {
      this.badge.classList.add('fading');
      setTimeout(apply, 150);
    } else {
      apply();
    }
  }

  _renderHotbar() {
    if (this.mode === 'magic') this._renderMagicHotbar();
    else this._renderBuildHotbar();
  }

  _renderMagicHotbar() {
    let spellList = null;
    try {
      const spells = this.ctx.systems.spells;
      if (spells && typeof spells.getState === 'function') spellList = spells.getState().spells;
    } catch (err) {
      console.error('[HUD] getState failed', err);
    }
    this._spellIds = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this.slots[i];
      const s = spellList && spellList[i];
      slot.el.classList.remove('empty');
      if (s) {
        slot.icon.textContent = s.icon || '✨';
        slot.label.textContent = s.label || s.id || '';
        this._spellIds.push(s.id);
      } else {
        slot.icon.textContent = '';
        slot.label.textContent = '';
        slot.el.classList.add('empty');
        this._spellIds.push(null);
      }
      this._resetSlotCooldown(slot);
    }
    this._applySelection(this.selectedMagic);
  }

  _renderBuildHotbar() {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const slot = this.slots[i];
      this._resetSlotCooldown(slot);
      if (i < this.blockDefs.length) {
        this._renderBlockSlot(i);
        slot.el.classList.remove('empty');
      } else {
        // slot 9 is empty in build mode
        slot.icon.textContent = '';
        slot.label.textContent = '';
        slot.el.classList.add('empty');
      }
    }
    this._applySelection(this.selectedBuild);
  }

  _renderBlockSlot(i) {
    const def = this.blockDefs[i];
    const slot = this.slots[i];
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = def.color;
    if (def.glow) swatch.style.boxShadow = '0 0 6px ' + def.color;
    slot.icon.textContent = '';
    slot.icon.appendChild(swatch);
    slot.label.textContent = def.name;
  }

  _resetSlotCooldown(slot) {
    if (slot.lastCd !== 0) {
      slot.cd.style.setProperty('--cd', '0');
      slot.lastCd = 0;
    }
    if (slot.cooling) {
      slot.el.classList.remove('cooling');
      slot.cooling = false;
    }
    slot.el.classList.remove('ready-pop');
  }

  _applySelection(index) {
    for (let i = 0; i < SLOT_COUNT; i++) {
      const want = i === index;
      const slot = this.slots[i];
      if (slot.selected !== want) {
        slot.el.classList.toggle('selected', want);
        slot.selected = want;
      }
    }
  }

  /* ============================================================ blocks */

  _harvestBlockDefs() {
    // BuildSystem is earlier in construction order; try (defensively) to read its real palette.
    try {
      const build = this.ctx.systems.build;
      if (!build) return;
      const candidates = [build.blocks, build.BLOCKS, build.blockDefs, build.defs, build.palette];
      for (const list of candidates) {
        if (Array.isArray(list) && list.length >= 8) {
          const normed = [];
          for (let i = 0; i < 8; i++) {
            const n = this._normalizeBlockDef(list[i], i);
            if (!n) return; // shape mismatch — keep fallback
            normed.push(n);
          }
          this.blockDefs = normed;
          return;
        }
      }
    } catch (err) {
      console.error('[HUD] block palette read failed', err);
    }
  }

  _normalizeBlockDef(def, i) {
    if (!def) return null;
    const fallback = FALLBACK_BLOCKS[Math.min(i, FALLBACK_BLOCKS.length - 1)];
    let color = def.color;
    if (typeof color === 'number') color = '#' + color.toString(16).padStart(6, '0');
    else if (color && typeof color.getHexString === 'function') color = '#' + color.getHexString();
    if (typeof color !== 'string') color = fallback.color;
    const emissive = typeof def.emissive === 'number' ? def.emissive : 0;
    return {
      id: def.id || fallback.id,
      name: def.name || def.label || fallback.name,
      color,
      glow: emissive !== 0 || !!def.glow,
    };
  }

  /* ============================================================= toasts */

  _toast(text, duration) {
    const dur = typeof duration === 'number' && duration > 0 ? duration : 2.5;
    const el = document.createElement('div');
    el.className = 'mw-toast';
    el.textContent = text;

    // newest on top
    this.toastStack.insertBefore(el, this.toastStack.firstChild);

    // max 4 visible — drop oldest immediately
    while (this.toastStack.children.length > 4) {
      this.toastStack.removeChild(this.toastStack.lastChild);
    }

    const exitDelay = Math.max(0, dur - 0.3) * 1000;
    setTimeout(() => el.classList.add('leaving'), exitDelay);
    setTimeout(() => {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, dur * 1000 + 80);
  }

  /* ========================================================= mana flash */

  _flashMana() {
    this.manaWrap.classList.remove('flash');
    void this.manaWrap.offsetWidth; // restart shake animation
    this.manaWrap.classList.add('flash');
    this._flashTimer = 0.35;
  }

  /* ============================================================= update */

  update(dt) {
    const spells = this.ctx.systems.spells;
    if (!spells || typeof spells.getState !== 'function') return;

    let state;
    try {
      state = spells.getState();
    } catch (err) {
      return;
    }
    if (!state) return;

    // --- mana bar (quantized to 0.5% steps so the style is only written on visible change)
    const max = state.manaMax > 0 ? state.manaMax : 100;
    let ratio = state.mana / max;
    if (ratio < 0) ratio = 0;
    else if (ratio > 1) ratio = 1;
    const q = Math.round(ratio * 200) / 200;
    if (q !== this._lastMana) {
      this._lastMana = q;
      this.manaFill.style.transform = 'scaleX(' + q + ')';
    }

    // --- low-mana pulse (class toggled only when crossing the threshold)
    const low = ratio < 0.18;
    if (low !== this._lowMana) {
      this._lowMana = low;
      this.manaWrap.classList.toggle('low', low);
    }

    // --- red-flash timeout (no setTimeout churn for the border state)
    if (this._flashTimer > 0) {
      this._flashTimer -= dt;
      if (this._flashTimer <= 0) this.manaWrap.classList.remove('flash');
    }

    // --- mode drift safety net (events are the primary channel)
    if (state.mode && state.mode !== this.mode) this._setMode(state.mode);

    // --- selection drift sync, throttled to 4 Hz (event-driven normally)
    this._syncTimer += dt;
    if (this._syncTimer >= 0.25) {
      this._syncTimer = 0;
      if (this.mode === 'magic' && typeof state.selected === 'number' && state.selected !== this.selectedMagic) {
        this.selectedMagic = state.selected;
        this._applySelection(this.selectedMagic);
      }
    }

    // --- cooldown overlays (magic mode only) — height writes quantized to whole percent
    if (this.mode === 'magic' && state.spells) {
      const list = state.spells;
      const n = list.length < SLOT_COUNT ? list.length : SLOT_COUNT;
      for (let i = 0; i < n; i++) {
        const s = list[i];
        const slot = this.slots[i];
        let frac = 0;
        if (s && s.cooldown > 0 && s.cooldownLeft > 0) {
          frac = s.cooldownLeft / s.cooldown;
          if (frac > 1) frac = 1;
        }
        const pct = (frac * 100) | 0;
        if (pct !== slot.lastCd) {
          slot.lastCd = pct;
          slot.cd.style.setProperty('--cd', String(pct));
        }
        const cooling = frac > 0.02;
        if (cooling !== slot.cooling) {
          slot.cooling = cooling;
          slot.el.classList.toggle('cooling', cooling);
          if (!cooling) {
            // cooldown just finished — flash the icon back to readiness
            slot.el.classList.remove('ready-pop');
            void slot.el.offsetWidth;
            slot.el.classList.add('ready-pop');
          }
        }
      }
    }
  }
}
