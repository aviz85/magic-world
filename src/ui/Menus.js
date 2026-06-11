/**
 * Menus — title / help overlay for Magic World.
 *
 * Shown whenever the pointer is NOT locked (start screen + Esc/H help screen).
 * Pure DOM inside #ui with its own <style> tag. Clicking anywhere on the
 * overlay re-requests pointer lock. `H` while locked exits pointer lock so
 * the overlay doubles as the in-game help screen.
 *
 * Zero per-frame JS work: all motion is CSS animation, and update() only
 * runs a single cheap class toggle when visibility actually changes.
 */

// Fallback roster used only if ctx.systems.spells.getState() is unavailable.
const FALLBACK_SPELLS = [
  { icon: '🔥', label: 'Fireball' },
  { icon: '🌳', label: 'Grow Tree' },
  { icon: '💡', label: 'Light Orb' },
  { icon: '⛰️', label: 'Terraform' },
  { icon: '⚡', label: 'Blink' },
  { icon: '🌀', label: 'Portal' },
  { icon: '🗿', label: 'Golem' },
  { icon: '🌙', label: 'Time Warp' },
  { icon: '🏰', label: 'Conjure' },
];

const CONTROLS_LEFT = [
  ['WASD', 'Move'],
  ['Mouse', 'Look'],
  ['Space', 'Jump / Fly up'],
  ['Shift', 'Sprint'],
  ['F', 'Toggle fly (C — down)'],
  ['B', 'Magic / Build mode'],
];

const CONTROLS_RIGHT = [
  ['Left click', 'Cast / Place'],
  ['Right click', 'Alt-cast / Remove'],
  ['1–9 / Wheel', 'Select'],
  ['M', 'Mute · H — Help'],
  ['K', 'Save · L — Load'],
  ['Shift+N', 'New world'],
];

const STYLE = `
#mw-menu {
  position: absolute;
  inset: 0;
  z-index: 100;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  padding: 24px;
  box-sizing: border-box;
  background:
    radial-gradient(ellipse at center, transparent 40%, rgba(0, 0, 0, 0.55) 100%),
    rgba(8, 9, 22, 0.72);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  pointer-events: auto;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  opacity: 0;
  visibility: hidden;
  transition: opacity 250ms ease-out, visibility 0s linear 250ms;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.92);
  font-family: ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif;
  text-align: center;
}
#mw-menu.mw-visible {
  opacity: 1;
  visibility: visible;
  transition: opacity 250ms ease-out, visibility 0s linear 0s;
}

/* ---- floating motes (pure CSS, paused while hidden) ---- */
.mw-mote {
  position: absolute;
  bottom: -3vh;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  pointer-events: none;
  opacity: 0;
  animation: mw-rise linear infinite;
  animation-play-state: paused;
  will-change: transform, opacity;
}
#mw-menu.mw-visible .mw-mote { animation-play-state: running; }
@keyframes mw-rise {
  0%   { transform: translate3d(0, 0, 0) scale(0.6); opacity: 0; }
  12%  { opacity: var(--mote-a, 0.7); }
  80%  { opacity: var(--mote-a, 0.7); }
  100% { transform: translate3d(var(--mote-x, 30px), -108vh, 0) scale(1.1); opacity: 0; }
}

/* ---- staggered entrance (restarts every time the overlay becomes visible) ---- */
#mw-menu .mw-enter { will-change: transform, opacity; }
#mw-menu.mw-visible .mw-enter {
  animation: mw-enter 600ms cubic-bezier(0.22, 1, 0.36, 1) both;
  animation-delay: var(--d, 0ms);
}
@keyframes mw-enter {
  from { opacity: 0; transform: translateY(16px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ---- title block ---- */
.mw-title {
  margin: 0;
  font-family: 'Georgia', 'Palatino', ui-serif, serif;
  font-size: 64px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: 2px;
  color: #fff;
}
.mw-title-text {
  display: inline-block;
  background: linear-gradient(180deg, #ffffff 18%, #cdeeff 52%, #c9a8ff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: mw-title-pulse 3s ease-in-out infinite alternate;
}
@keyframes mw-title-pulse {
  from { filter: drop-shadow(0 0 14px rgba(127, 231, 255, 0.55)) drop-shadow(0 4px 28px rgba(180, 140, 255, 0.35)); }
  to   { filter: drop-shadow(0 0 26px rgba(127, 231, 255, 0.9)) drop-shadow(0 4px 42px rgba(180, 140, 255, 0.6)); }
}
.mw-title-spark {
  display: inline-block;
  font-size: 0.72em;
  vertical-align: 0.1em;
  filter: drop-shadow(0 0 14px rgba(255, 216, 107, 0.8));
  animation: mw-spark-twinkle 2.2s ease-in-out infinite alternate;
}
@keyframes mw-spark-twinkle {
  from { opacity: 0.7; transform: scale(0.92) rotate(-4deg); }
  to   { opacity: 1; transform: scale(1.08) rotate(4deg); }
}
.mw-subtitle {
  margin: 0;
  font-size: 16px;
  color: rgba(255, 255, 255, 0.55);
  letter-spacing: 0.5px;
  text-shadow: 0 1px 4px rgba(0, 0, 0, 0.6);
}
.mw-cta {
  margin: 4px 0 6px;
  padding: 10px 30px;
  border-radius: 999px;
  border: 1px solid rgba(255, 216, 107, 0.45);
  background: rgba(255, 216, 107, 0.08);
  box-shadow: 0 0 18px rgba(255, 216, 107, 0.18), inset 0 1px 0 rgba(255, 255, 255, 0.1),
              inset 0 0 12px rgba(255, 216, 107, 0.07);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 1px;
  color: #ffd86b;
  text-shadow: 0 0 12px rgba(255, 216, 107, 0.55), 0 1px 3px rgba(0, 0, 0, 0.7);
  transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 200ms ease-out,
              background 200ms ease-out;
}
#mw-menu.mw-visible .mw-cta {
  animation: mw-enter 600ms cubic-bezier(0.22, 1, 0.36, 1) var(--d, 0ms) both,
             mw-cta-pulse 1.7s ease-in-out 900ms infinite alternate;
}
.mw-cta:hover {
  transform: scale(1.05);
  background: rgba(255, 216, 107, 0.14);
  box-shadow: 0 0 26px rgba(255, 216, 107, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.12),
              inset 0 0 14px rgba(255, 216, 107, 0.1);
}
@keyframes mw-cta-pulse {
  from { box-shadow: 0 0 14px rgba(255, 216, 107, 0.14), inset 0 1px 0 rgba(255, 255, 255, 0.1),
                     inset 0 0 12px rgba(255, 216, 107, 0.06); }
  to   { box-shadow: 0 0 26px rgba(255, 216, 107, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.1),
                     inset 0 0 14px rgba(255, 216, 107, 0.12); }
}

/* ---- panels (fantasy-glass) ---- */
.mw-panel {
  background: linear-gradient(180deg, rgba(22, 26, 52, 0.62), rgba(10, 12, 28, 0.52));
  backdrop-filter: blur(10px) saturate(1.35);
  -webkit-backdrop-filter: blur(10px) saturate(1.35);
  border: 1px solid rgba(127, 231, 255, 0.35);
  border-radius: 10px;
  box-shadow: 0 0 12px rgba(127, 231, 255, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.1),
              inset 0 0 8px rgba(127, 231, 255, 0.08);
}

/* ---- controls panel ---- */
.mw-controls {
  display: flex;
  padding: 20px 28px;
  max-width: 760px;
  text-align: left;
}
.mw-col + .mw-col {
  margin-left: 30px;
  padding-left: 30px;
  border-left: 1px solid rgba(127, 231, 255, 0.16);
}
.mw-col {
  display: flex;
  flex-direction: column;
  font-size: 13px;
  line-height: 1.9;
  white-space: nowrap;
}
.mw-row { color: rgba(255, 255, 255, 0.55); }
.mw-key {
  color: #7fe7ff;
  font-weight: 600;
  text-shadow: 0 0 6px rgba(127, 231, 255, 0.4);
}
.mw-controls-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 2px;
  color: rgba(255, 255, 255, 0.55);
  margin-bottom: 6px;
}

/* ---- spell strip ---- */
.mw-spells {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  max-width: 760px;
}
.mw-spell {
  width: 64px;
  height: 72px;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: transform 200ms cubic-bezier(0.34, 1.56, 0.64, 1),
              box-shadow 200ms ease-out,
              border-color 200ms ease-out;
}
.mw-spell:hover {
  transform: translateY(-4px) scale(1.08);
  border-color: rgba(255, 216, 107, 0.7);
  box-shadow: 0 0 14px rgba(255, 216, 107, 0.45), inset 0 0 8px rgba(255, 216, 107, 0.12);
}
.mw-spell-icon {
  font-size: 26px;
  line-height: 1;
  filter: drop-shadow(0 0 6px rgba(127, 231, 255, 0.45));
}
.mw-spell-label {
  font-size: 10px;
  color: rgba(255, 255, 255, 0.55);
  letter-spacing: 0.3px;
  max-width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mw-spell-num {
  position: absolute;
  top: 3px;
  left: 6px;
  font-size: 9px;
  color: rgba(255, 255, 255, 0.35);
}
.mw-spell-cost {
  position: absolute;
  top: 3px;
  right: 5px;
  font-size: 9px;
  font-weight: 600;
  color: #7fe7ff;
  text-shadow: 0 0 5px rgba(127, 231, 255, 0.55);
}
.mw-spell { position: relative; }

/* ---- footer hint ---- */
.mw-hint {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.4);
  letter-spacing: 0.5px;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
}

/* small screens: keep everything on screen */
@media (max-height: 760px) {
  #mw-menu { gap: 12px; }
  .mw-title { font-size: 48px; }
  .mw-controls { padding: 14px 22px; }
  .mw-col { line-height: 1.65; }
}
@media (max-height: 600px) {
  .mw-title { font-size: 36px; }
  .mw-spell { width: 56px; height: 62px; }
  .mw-spell-icon { font-size: 22px; }
}
`;

export default class Menus {
  constructor(ctx) {
    this.ctx = ctx;
    this.visible = false;
    this.root = null;

    const ui = document.querySelector('#ui');
    if (!ui) {
      console.error('[Menus] #ui container not found');
      return;
    }

    // Scoped stylesheet.
    const style = document.createElement('style');
    style.textContent = STYLE;
    ui.appendChild(style);

    // Overlay root.
    const root = document.createElement('div');
    root.id = 'mw-menu';
    root.appendChild(this._buildMotes());
    root.appendChild(this._buildTitleBlock());
    root.appendChild(this._buildControlsPanel());
    root.appendChild(this._buildSpellStrip());
    root.appendChild(this._buildHint());
    ui.appendChild(root);
    this.root = root;

    // Click anywhere → enter the world.
    root.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.input.requestPointerLock();
    });

    // Show / hide with pointer lock state.
    ctx.events.on('input:lockchange', ({ locked }) => {
      this._setVisible(!locked);
    });

    // H while locked → release pointer so the overlay (help) reappears.
    ctx.events.on('input:keydown', ({ code }) => {
      if (code === 'KeyH' && this.ctx.input.pointerLocked) {
        document.exitPointerLock();
      }
    });

    // Pointer starts unlocked → show the title screen immediately.
    this._setVisible(!ctx.input.pointerLocked);
  }

  /** Per-frame hook (contract). All overlay motion is CSS — nothing to do. */
  update(dt, elapsed) {} // eslint-disable-line no-unused-vars

  // ---------------------------------------------------------------- private

  _setVisible(visible) {
    if (!this.root || visible === this.visible) return;
    this.visible = visible;
    this.root.classList.toggle('mw-visible', visible);
  }

  _buildMotes() {
    // Deterministic, GPU-composited rising sparkles. CSS-animated;
    // animation-play-state pauses them while the overlay is hidden.
    const frag = document.createDocumentFragment();
    const colors = ['#7fe7ff', '#b48cff', '#ff8ad8', '#ffd86b'];
    let s = 7;
    const rand = () => {
      // mulberry32-lite — deterministic layout across reloads
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < 16; i++) {
      const mote = document.createElement('div');
      mote.className = 'mw-mote';
      const c = colors[i % colors.length];
      const size = 3 + rand() * 4;
      mote.style.left = `${(rand() * 96 + 2).toFixed(1)}%`;
      mote.style.width = `${size.toFixed(1)}px`;
      mote.style.height = `${size.toFixed(1)}px`;
      mote.style.background = c;
      mote.style.boxShadow = `0 0 ${(size * 2).toFixed(0)}px ${c}`;
      mote.style.setProperty('--mote-x', `${((rand() - 0.5) * 120).toFixed(0)}px`);
      mote.style.setProperty('--mote-a', (0.35 + rand() * 0.45).toFixed(2));
      mote.style.animationDuration = `${(9 + rand() * 10).toFixed(1)}s`;
      mote.style.animationDelay = `${(-rand() * 18).toFixed(1)}s`;
      frag.appendChild(mote);
    }
    return frag;
  }

  /** Tag an element for the staggered entrance animation. */
  _stagger(el, delayMs) {
    el.classList.add('mw-enter');
    el.style.setProperty('--d', delayMs + 'ms');
    return el;
  }

  _buildTitleBlock() {
    const frag = document.createDocumentFragment();

    // Gradient-filled title text + separately-animated spark (the emoji must
    // stay outside the background-clip span so it keeps its color glyph).
    const title = document.createElement('h1');
    title.className = 'mw-title';
    const titleText = document.createElement('span');
    titleText.className = 'mw-title-text';
    titleText.textContent = 'Magic World';
    const spark = document.createElement('span');
    spark.className = 'mw-title-spark';
    spark.textContent = ' ✨';
    title.appendChild(titleText);
    title.appendChild(spark);
    frag.appendChild(this._stagger(title, 0));

    const subtitle = document.createElement('p');
    subtitle.className = 'mw-subtitle';
    subtitle.textContent = 'An island of living magic awaits.';
    frag.appendChild(this._stagger(subtitle, 90));

    const cta = document.createElement('div');
    cta.className = 'mw-cta';
    cta.textContent = 'Click to enter the world';
    // entrance for the CTA is handled by its own rule (entrance + pulse combined)
    cta.style.setProperty('--d', '180ms');
    frag.appendChild(cta);

    return frag;
  }

  _buildControlsPanel() {
    const panel = document.createElement('div');
    panel.className = 'mw-panel mw-controls';
    panel.appendChild(this._buildColumn('Movement', CONTROLS_LEFT));
    panel.appendChild(this._buildColumn('Actions', CONTROLS_RIGHT));
    return this._stagger(panel, 280);
  }

  _buildColumn(heading, rows) {
    const col = document.createElement('div');
    col.className = 'mw-col';
    const head = document.createElement('div');
    head.className = 'mw-controls-head';
    head.textContent = heading;
    col.appendChild(head);
    for (const [key, desc] of rows) {
      const row = document.createElement('div');
      row.className = 'mw-row';
      const k = document.createElement('span');
      k.className = 'mw-key';
      k.textContent = key;
      row.appendChild(k);
      row.appendChild(document.createTextNode(` — ${desc}`));
      col.appendChild(row);
    }
    return col;
  }

  _buildSpellStrip() {
    const strip = document.createElement('div');
    strip.className = 'mw-spells';

    let spells = FALLBACK_SPELLS;
    try {
      const mgr = this.ctx.systems.spells;
      const state = mgr && mgr.getState && mgr.getState();
      if (state && Array.isArray(state.spells) && state.spells.length) {
        spells = state.spells;
      }
    } catch (err) {
      console.error('[Menus] could not read spell roster, using fallback', err);
    }

    spells.forEach((spell, i) => {
      const card = document.createElement('div');
      card.className = 'mw-panel mw-spell';

      const num = document.createElement('span');
      num.className = 'mw-spell-num';
      num.textContent = String(i + 1);
      card.appendChild(num);

      const icon = document.createElement('div');
      icon.className = 'mw-spell-icon';
      icon.textContent = spell.icon || '✨';
      card.appendChild(icon);

      const label = document.createElement('div');
      label.className = 'mw-spell-label';
      label.textContent = spell.label || spell.id || '';
      card.appendChild(label);

      if (typeof spell.manaCost === 'number') {
        const cost = document.createElement('span');
        cost.className = 'mw-spell-cost';
        cost.textContent = `${spell.manaCost}✧`; // ✧ mana cost
        cost.title = `${spell.manaCost} mana`;
        card.appendChild(cost);
      }

      strip.appendChild(card);
    });

    return this._stagger(strip, 380);
  }

  _buildHint() {
    const hint = document.createElement('div');
    hint.className = 'mw-hint';
    hint.textContent = 'Press H in-game to return to this screen · Esc also unlocks the pointer';
    return this._stagger(hint, 480);
  }
}
