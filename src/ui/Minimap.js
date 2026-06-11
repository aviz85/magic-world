/**
 * Minimap — top-right 170×170 canvas minimap for Magic World.
 *
 * Layers:
 *  - Base layer (expensive, throttled): terrain heightfield rendered to a small
 *    res×res ImageData with the binding height palette + a soft NW hillshade,
 *    scaled up onto an offscreen base canvas, finished with a vignette and a
 *    faint cyan inner edge. Redrawn on `terrain:modify` (throttled ≥ 0.5s) and
 *    on a 3s heartbeat.
 *  - Overlay layer (cheap, every frame): pulsing violet portal dots (from
 *    `portal:set`), gray golem dots (read defensively from ctx.systems.golems),
 *    and the player as a white arrow rotated by yaw with a pre-rendered facing
 *    cone and a gentle pulsing locator ring. A small "N" compass marker sits on
 *    the throttled base layer.
 *
 * No per-frame allocations: all scratch state (ImageData, canvases, band table,
 * portal list) is created once and reused.
 */

const MAP_SIZE = 170; // CSS pixels
const MODIFY_THROTTLE = 0.5; // seconds between dirty-triggered base redraws
const PERIODIC_REDRAW = 3; // seconds between heartbeat base redraws

export default class Minimap {
  constructor(ctx) {
    this.ctx = ctx;

    // --- timing / dirty state ---------------------------------------------
    this._baseDirty = true;
    this._lastBaseDraw = -Infinity;
    this._nextPeriodic = 0;

    // --- overlay state (reused, never reallocated per frame) ---------------
    this._portals = []; // [{x, z}] — replaced wholesale on portal:set (rare)
    this._golemListKey = null; // cached property name on the golems system

    // --- world → map mapping -----------------------------------------------
    const cfg = ctx.config || {};
    this._worldSize = cfg.worldSize || 240;
    this._waterLevel = typeof cfg.waterLevel === 'number' ? cfg.waterLevel : 1.2;

    // Binding palette (docs/design/ui.md §8). Thresholds in world y.
    // Each band: [maxY, r, g, b, hillshadeWeight]
    const wl = this._waterLevel;
    this._bands = [
      [wl - 2, 0x16, 0x33, 0x5f, 0.35], // deep water
      [wl, 0x2a, 0x6f, 0x97, 0.35], // shallow water
      [wl + 1.2, 0xe3, 0xd3, 0xa3, 0.8], // sand
      [8, 0x4f, 0x9d, 0x4f, 1.0], // grass
      [12, 0x3c, 0x7a, 0x46, 1.0], // high grass / moss
      [16, 0x7a, 0x6f, 0x8a, 1.0], // violet-tinted rock
      [Infinity, 0xf0, 0xf4, 0xff, 0.7], // snow
    ];

    // --- DOM ----------------------------------------------------------------
    this._buildDom();

    // --- offscreen buffers --------------------------------------------------
    this._dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.round(MAP_SIZE * this._dpr);
    this._px = px;

    // base = palette terrain + vignette, composited at display resolution
    this._baseCanvas = document.createElement('canvas');
    this._baseCanvas.width = px;
    this._baseCanvas.height = px;
    this._baseCtx = this._baseCanvas.getContext('2d');

    // sample = raw res×res heightfield pixels (created lazily once res known)
    this._sampleCanvas = null;
    this._sampleCtx = null;
    this._img = null; // ImageData(res, res)
    this._imgRes = 0;

    // display context — work in CSS px via a fixed DPR transform
    this._d = this.canvas.getContext('2d');

    // pre-rendered facing-cone sprite (radial gradient — built once, drawn
    // rotated with the player every frame at zero allocation cost)
    this._cone = this._makeConeSprite();

    // --- events -------------------------------------------------------------
    const events = ctx.events;
    if (events && events.on) {
      events.on('terrain:modify', () => {
        this._baseDirty = true;
      });
      events.on('portal:set', (payload) => {
        this._portals = (payload && payload.portals) || [];
      });
    }

    // Terrain is earlier in the construction order — safe to paint right away.
    this._redrawBase();
  }

  // ==========================================================================
  // DOM
  // ==========================================================================

  _buildDom() {
    const ui = document.querySelector('#ui') || document.body;

    const style = document.createElement('style');
    style.textContent = [
      '.mw-minimap{',
      'position:absolute;top:20px;right:20px;',
      `width:${MAP_SIZE}px;height:${MAP_SIZE}px;`,
      'border-radius:12px;overflow:hidden;',
      'border:1px solid rgba(127,231,255,0.4);',
      'box-shadow:0 6px 18px rgba(0,0,0,0.35),0 0 12px rgba(127,231,255,0.28),inset 0 0 10px rgba(127,231,255,0.1);',
      'background:rgba(14,16,34,0.55);',
      'pointer-events:none;user-select:none;z-index:10;',
      '}',
      '.mw-minimap canvas{',
      'display:block;width:100%;height:100%;border-radius:12px;',
      '}',
    ].join('');
    ui.appendChild(style);
    this._style = style;

    this.root = document.createElement('div');
    this.root.className = 'mw-minimap';

    this.canvas = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(MAP_SIZE * dpr);
    this.canvas.height = Math.round(MAP_SIZE * dpr);

    this.root.appendChild(this.canvas);
    ui.appendChild(this.root);
  }

  // ==========================================================================
  // Base layer (throttled)
  // ==========================================================================

  _redrawBase() {
    const terrain = this.ctx.systems && this.ctx.systems.terrain;
    const b = this._baseCtx;
    const px = this._px;

    if (terrain && terrain.heightData && terrain.heightData.length) {
      const hd = terrain.heightData;
      const res = terrain.res || Math.round(Math.sqrt(hd.length));
      this._ensureSampleBuffers(res);

      const data = this._img.data;
      const bands = this._bands;
      const nBands = bands.length;

      // Fill the res×res ImageData: palette by height + NW hillshade.
      let p = 0;
      for (let iz = 0; iz < res; iz++) {
        const rowBase = iz * res;
        const upBase = iz > 0 ? (iz - 1) * res : rowBase;
        for (let ix = 0; ix < res; ix++) {
          const h = hd[rowBase + ix];

          // band lookup (7 entries — linear scan is the fastest option here)
          let bi = 0;
          while (bi < nBands - 1 && h >= bands[bi][0]) bi++;
          const band = bands[bi];

          // hillshade: light from the NW — combine the W and N slopes for
          // crisper, less streaky relief than a single diagonal sample
          const hw = hd[rowBase + (ix > 0 ? ix - 1 : ix)];
          const hn = hd[upBase + ix];
          let shade = 1 + (h - hw + (h - hn)) * 0.085 * band[4];
          if (shade < 0.7) shade = 0.7;
          else if (shade > 1.3) shade = 1.3;

          let r = band[1] * shade;
          let g = band[2] * shade;
          let bch = band[3] * shade;
          if (r > 255) r = 255;
          if (g > 255) g = 255;
          if (bch > 255) bch = 255;

          data[p] = r;
          data[p + 1] = g;
          data[p + 2] = bch;
          data[p + 3] = 255;
          p += 4;
        }
      }

      this._sampleCtx.putImageData(this._img, 0, 0);

      // Scale up with smoothing for a soft, painterly look.
      b.imageSmoothingEnabled = true;
      b.imageSmoothingQuality = 'high';
      b.clearRect(0, 0, px, px);
      b.drawImage(this._sampleCanvas, 0, 0, res, res, 0, 0, px, px);
    } else {
      // Terrain missing (failed construct / not ready) — calm deep-water fill.
      b.fillStyle = '#16335f';
      b.fillRect(0, 0, px, px);
    }

    this._paintVignette(b, px);

    this._baseDirty = false;
  }

  _makeConeSprite() {
    // Soft white view-cone, apex at bottom-center, fanning upward.
    const w = 40;
    const h = 20;
    this._coneW = w;
    this._coneH = h;
    const dpr = this._dpr;
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    const grad = g.createRadialGradient(w / 2, h, 1.5, w / 2, h, h - 0.5);
    grad.addColorStop(0, 'rgba(255,255,255,0.28)');
    grad.addColorStop(0.7, 'rgba(210,240,255,0.12)');
    grad.addColorStop(1, 'rgba(210,240,255,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(w / 2, h);
    g.arc(w / 2, h, h - 0.5, -Math.PI / 2 - 0.62, -Math.PI / 2 + 0.62);
    g.closePath();
    g.fill();
    return c;
  }

  _ensureSampleBuffers(res) {
    if (this._imgRes === res) return;
    this._sampleCanvas = document.createElement('canvas');
    this._sampleCanvas.width = res;
    this._sampleCanvas.height = res;
    this._sampleCtx = this._sampleCanvas.getContext('2d');
    this._img = this._sampleCtx.createImageData(res, res);
    this._imgRes = res;
  }

  _paintVignette(b, px) {
    // Soft darkened edges so overlays pop, plus a faint cyan inner edge.
    const half = px / 2;
    const grad = b.createRadialGradient(half, half, half * 0.55, half, half, half * 1.05);
    grad.addColorStop(0, 'rgba(6,8,20,0)');
    grad.addColorStop(1, 'rgba(6,8,20,0.5)');
    b.fillStyle = grad;
    b.fillRect(0, 0, px, px);

    b.strokeStyle = 'rgba(127,231,255,0.18)';
    b.lineWidth = Math.max(1, this._dpr);
    b.strokeRect(b.lineWidth / 2, b.lineWidth / 2, px - b.lineWidth, px - b.lineWidth);

    // compass: north (-z) is up
    b.font = `600 ${Math.round(9 * this._dpr)}px ui-sans-serif, -apple-system, sans-serif`;
    b.textAlign = 'center';
    b.textBaseline = 'top';
    b.shadowColor = 'rgba(0,0,0,0.85)';
    b.shadowBlur = 3 * this._dpr;
    b.fillStyle = 'rgba(255,255,255,0.8)';
    b.fillText('N', px / 2, 4 * this._dpr);
    b.shadowBlur = 0;
  }

  // ==========================================================================
  // Per-frame
  // ==========================================================================

  update(dt, elapsed) {
    // --- base layer scheduling ---------------------------------------------
    if (
      (this._baseDirty && elapsed - this._lastBaseDraw >= MODIFY_THROTTLE) ||
      elapsed >= this._nextPeriodic
    ) {
      this._redrawBase();
      this._lastBaseDraw = elapsed;
      this._nextPeriodic = elapsed + PERIODIC_REDRAW;
    }

    // --- composite ----------------------------------------------------------
    const d = this._d;
    const dpr = this._dpr;
    d.setTransform(dpr, 0, 0, dpr, 0, 0);
    d.drawImage(this._baseCanvas, 0, 0, MAP_SIZE, MAP_SIZE);

    this._drawPortals(d, elapsed);
    this._drawGolems(d);
    this._drawPlayer(d, elapsed);
  }

  /** world (x,z) → map CSS px. Returns false when far outside the map. */
  _mapX(x) {
    return (x / this._worldSize + 0.5) * MAP_SIZE;
  }

  _mapZ(z) {
    return (z / this._worldSize + 0.5) * MAP_SIZE;
  }

  // --- portals: pulsing violet dots with a soft glow -------------------------

  _drawPortals(d, elapsed) {
    const portals = this._portals;
    if (!portals || portals.length === 0) return;
    d.save();
    d.shadowColor = '#b48cff';
    d.fillStyle = '#b48cff';
    for (let i = 0; i < portals.length; i++) {
      const p = portals[i];
      if (!p) continue;
      const mx = this._mapX(p.x);
      const mz = this._mapZ(p.z);
      if (mx < -4 || mx > MAP_SIZE + 4 || mz < -4 || mz > MAP_SIZE + 4) continue;
      // gentle linked-portal pulse (phase-offset so the pair alternates)
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 3 + i * Math.PI);
      d.shadowBlur = 3 + pulse * 4;
      d.beginPath();
      d.arc(mx, mz, 2.2 + pulse * 0.9, 0, Math.PI * 2);
      d.fill();
    }
    d.restore();
  }

  // --- golems: 4px gray dots (defensive read of the golems system) ----------

  _resolveGolemList(golems) {
    // Cache whichever array-valued property the Golems system exposes.
    if (this._golemListKey && Array.isArray(golems[this._golemListKey])) {
      return golems[this._golemListKey];
    }
    const candidates = ['golems', 'list', 'units', 'entities', 'active', 'all', 'members', 'pool'];
    for (let i = 0; i < candidates.length; i++) {
      const v = golems[candidates[i]];
      if (Array.isArray(v) && v.length > 0) {
        this._golemListKey = candidates[i];
        return v;
      }
    }
    return null;
  }

  _golemPosition(g) {
    if (!g) return null;
    if (g.position && typeof g.position.x === 'number') return g.position;
    if (g.mesh && g.mesh.position) return g.mesh.position;
    if (g.group && g.group.position) return g.group.position;
    if (g.root && g.root.position) return g.root.position;
    return null;
  }

  _drawGolems(d) {
    const golems = this.ctx.systems && this.ctx.systems.golems;
    if (!golems || !golems.count) return;
    const list = this._resolveGolemList(golems);
    if (!list) return;

    d.fillStyle = '#9a9a9a';
    d.strokeStyle = 'rgba(0,0,0,0.45)';
    d.lineWidth = 1;
    for (let i = 0; i < list.length; i++) {
      const pos = this._golemPosition(list[i]);
      if (!pos) continue;
      const mx = this._mapX(pos.x);
      const mz = this._mapZ(pos.z);
      if (mx < -3 || mx > MAP_SIZE + 3 || mz < -3 || mz > MAP_SIZE + 3) continue;
      d.beginPath();
      d.arc(mx, mz, 2, 0, Math.PI * 2);
      d.fill();
      d.stroke();
    }
  }

  // --- player: white arrow rotated by yaw + pulsing locator ring ------------

  _drawPlayer(d, elapsed) {
    const player = this.ctx.systems && this.ctx.systems.player;
    if (!player || !player.position) return;

    let mx = this._mapX(player.position.x);
    let mz = this._mapZ(player.position.z);
    // keep the marker visible even if the player somehow leaves bounds
    if (mx < 4) mx = 4;
    else if (mx > MAP_SIZE - 4) mx = MAP_SIZE - 4;
    if (mz < 4) mz = 4;
    else if (mz > MAP_SIZE - 4) mz = MAP_SIZE - 4;

    const yaw = player.yaw || 0;
    // forward in world XZ: (-sin yaw, -cos yaw); canvas rotation so that the
    // up-pointing arrow aligns with the facing direction (north = -Z = up).
    const angle = Math.atan2(-Math.sin(yaw), Math.cos(yaw));

    d.save();
    d.translate(mx, mz);

    // pulsing locator ring — subtle, juicy
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 2.6);
    d.strokeStyle = 'rgba(127,231,255,' + (0.16 + 0.18 * pulse).toFixed(3) + ')';
    d.lineWidth = 1.2;
    d.beginPath();
    d.arc(0, 0, 6.5 + pulse * 1.5, 0, Math.PI * 2);
    d.stroke();

    d.rotate(angle);

    // facing cone (pre-rendered sprite, points up = facing direction)
    d.drawImage(this._cone, -this._coneW / 2, -this._coneH, this._coneW, this._coneH);

    // 8px-long white arrow with a 1px dark outline
    d.beginPath();
    d.moveTo(0, -5); // tip
    d.lineTo(3.4, 3); // back right
    d.lineTo(0, 1.4); // tail notch
    d.lineTo(-3.4, 3); // back left
    d.closePath();
    d.lineWidth = 1;
    d.strokeStyle = 'rgba(0,0,0,0.5)';
    d.stroke();
    d.fillStyle = '#ffffff';
    d.fill();

    d.restore();
  }
}
