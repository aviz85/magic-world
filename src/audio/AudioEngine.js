/**
 * AudioEngine — pure WebAudio synth for Magic World.
 *
 * - Lazy AudioContext: created/resumed on first pointer-lock or mousedown.
 * - Master GainNode at 0.30; `KeyM` toggles mute (0.1s ramp).
 * - Ambient bed: two detuned saws (55 / 55.8 Hz) → lowpass → breathing LFO,
 *   plus a faint 220 Hz triangle "air" layer. Night darkens the filter and
 *   sprinkles bandpass-noise cricket chirps (sky polled ~1/s).
 * - Per-event SFX palette per docs/design/creatures-fx.md, all synthesized
 *   (envelopes via linearRamp / exponentialRamp). No assets, no THREE.Audio.
 * - Warm mix: master → highshelf (−4 dB @ 4.2 kHz, tames synth fizz) →
 *   DynamicsCompressor glue (soft 4:1) → destination, so stacked SFX swell
 *   instead of clipping. Per-trigger ±10% gain / ±0.2% pitch humanization,
 *   plus subtle random stereo placement (±0.3 pan) on non-sub SFX — subs and
 *   the ambient bed stay centered so the low end never wobbles.
 * - Rate limit: token bucket per SFX type — 10/s sustained (per contract),
 *   plus a 30 ms same-type minimum gap so explosion block-removal storms
 *   roll musically instead of stacking into one wall of sound.
 *
 * No per-frame allocations: update() only ticks two timers and an occasional
 * (≤1/s) night poll; all SFX nodes are transient WebAudio nodes that the
 * browser reclaims after `stop()`.
 */
// Rate limiting (per SFX type): token bucket honoring the contract's "max ~10
// of the same type per second", plus a tiny same-type gap for storm sanity.
const RATE_BURST = 10;     // bucket capacity
const RATE_REFILL = 10;    // tokens regained per second
const RATE_MIN_GAP = 0.03; // seconds between two triggers of the same type
// Global guard ON TOP of per-type buckets: many *different* types firing in
// the same instant (explosion + 30 block:removes + casts) still cap out at a
// sane overall density instead of multiplying per-type allowances.
const GLOBAL_BURST = 18;   // overall bucket capacity
const GLOBAL_REFILL = 30;  // overall tokens per second

export default class AudioEngine {
  constructor(ctx) {
    this.ctx = ctx;

    this.ac = null;          // AudioContext (lazy)
    this.master = null;      // master GainNode (0.30)
    this.muted = false;
    this.masterLevel = 0.30;

    // Ambient graph handles (built with the context)
    this.ambient = null;     // { droneFilter, droneGain, lfoDepth, airGain }
    this.noiseBuffer = null; // 2s shared white-noise buffer

    // Day/night state
    this._isNight = false;
    this._nightPollTimer = 0;   // poll sky.isNight() ~1/s
    this._cricketTimer = 0;     // countdown to next chirp burst

    // SFX rate limiting: type -> { tokens, last, lastFire } + a global bucket
    this._rate = new Map();
    this._globalTokens = GLOBAL_BURST;
    this._globalLast = 0;

    // Tiny deterministic-ish jitter source for cricket spacing etc.
    this._rng = Math.random;

    this._bindEvents();
  }

  // ------------------------------------------------------------ wiring

  _bindEvents() {
    const ev = this.ctx.events;

    // Lazy context creation / resume
    ev.on('input:lockchange', ({ locked }) => { if (locked) this._ensureContext(); });
    ev.on('input:mousedown', () => this._ensureContext());

    // Mute toggle
    ev.on('input:keydown', ({ code }) => {
      if (code === 'KeyM') this.setMuted(!this.muted);
    });

    // SFX palette
    ev.on('spell:cast', ({ id }) => this._spellCastSfx(id));
    ev.on('fx:explosion', () => this._sfx('explosion', () => this._sfxExplosion()));
    ev.on('block:place', () => this._sfx('block:place', () => this._sfxBlockPlace()));
    ev.on('block:remove', () => this._sfx('block:remove', () => this._sfxBlockRemove()));
    ev.on('prefab:place', () => this._sfx('prefab:place', () => this._sfxPrefabPlace()));
    ev.on('player:teleport', () => this._sfx('player:teleport', () => this._sfxTeleportShimmer()));
    ev.on('mana:insufficient', () => this._sfx('mana:insufficient', () => this._sfxManaFail()));
    ev.on('golem:spawn', () => this._sfx('golem:spawn', () => this._sfxGolemRumble()));
    // time:warp flavor is covered by the timewarp spell:cast variant.
  }

  // ---------------------------------------------------- context / master

  _ensureContext() {
    if (this.ac) {
      if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ac = new AC();
    if (this.ac.state === 'suspended') this.ac.resume().catch(() => {});

    this.master = this.ac.createGain();
    this.master.gain.value = this.muted ? 0 : this.masterLevel;

    // Warmth chain: gentle high-shelf cut rounds off synthetic fizz, a small
    // low-shelf lift gives the mix body, then a soft glue compressor keeps
    // stacked SFX (explosions + storms) from clipping — the mix swells
    // instead of crunching.
    const shelf = this.ac.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 4200;
    shelf.gain.value = -4;
    const body = this.ac.createBiquadFilter();
    body.type = 'lowshelf';
    body.frequency.value = 220;
    body.gain.value = 1.5;
    const comp = this.ac.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 14;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    this.master.connect(shelf);
    shelf.connect(body);
    body.connect(comp);
    comp.connect(this.ac.destination);
    this._warmth = { shelf, body, comp };

    this._buildNoiseBuffer();
    this._buildAmbientBed();
  }

  _buildNoiseBuffer() {
    const sr = this.ac.sampleRate;
    const len = Math.floor(sr * 2);
    const buf = this.ac.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
  }

  /** White-noise source reading from the shared buffer at a random offset. */
  _noiseSource(loop = false) {
    const src = this.ac.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = loop;
    src.loopStart = 0;
    src.loopEnd = this.noiseBuffer.duration;
    return src;
  }

  // ------------------------------------------------------------ ambient

  _buildAmbientBed() {
    const ac = this.ac;
    const now = ac.currentTime;

    // Beating drone: 55 Hz + 55.8 Hz saws → lowpass 320 Hz → gain 0.10
    const droneFilter = ac.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 320;
    droneFilter.Q.value = 0.7;

    const droneGain = ac.createGain();
    droneGain.gain.value = 0;
    droneGain.gain.setValueAtTime(0, now);
    droneGain.gain.linearRampToValueAtTime(0.10, now + 4); // gentle fade-in

    droneFilter.connect(droneGain);
    droneGain.connect(this.master);

    for (const freq of [55, 55.8]) {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.connect(droneFilter);
      osc.start(now);
    }

    // Breathing LFO: sine 0.07 Hz, depth ±0.035 on the drone gain
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoDepth = ac.createGain();
    lfoDepth.gain.value = 0.035;
    lfo.connect(lfoDepth);
    lfoDepth.connect(droneGain.gain);
    lfo.start(now);

    // Air layer: triangle 220 Hz → lowpass 500 Hz → gain 0.015
    const airFilter = ac.createBiquadFilter();
    airFilter.type = 'lowpass';
    airFilter.frequency.value = 500;
    const airGain = ac.createGain();
    airGain.gain.value = 0;
    airGain.gain.setValueAtTime(0, now);
    airGain.gain.linearRampToValueAtTime(0.015, now + 6);
    const air = ac.createOscillator();
    air.type = 'triangle';
    air.frequency.value = 220;
    air.connect(airFilter);
    airFilter.connect(airGain);
    airGain.connect(this.master);
    air.start(now);

    this.ambient = { droneFilter, droneGain, lfoDepth, airGain };
  }

  /** Crossfade ambient bed toward day/night character over ~3s. */
  _setNightAmbience(night) {
    if (!this.ambient) return;
    const t = this.ac.currentTime;
    const TC = 1.0; // setTargetAtTime time-constant → ~3s to settle
    this.ambient.droneFilter.frequency.setTargetAtTime(night ? 210 : 320, t, TC);
    this.ambient.droneGain.gain.cancelScheduledValues(t);
    this.ambient.droneGain.gain.setTargetAtTime(night ? 0.08 : 0.10, t, TC);
  }

  /** One burst of 3–5 cricket chirps spaced ~70 ms, panned to one side. */
  _cricketBurst() {
    const ac = this.ac;
    const base = ac.currentTime + 0.02;
    const chirps = 3 + ((this._rng() * 3) | 0); // 3–5 per burst
    const burstFreq = 4000 + this._rng() * 700; // each cricket has its own voice
    const side = this._sfxOut(); // whole burst sits in one spot in the field
    for (let i = 0; i < chirps; i++) {
      const t = base + i * (0.06 + this._rng() * 0.02);
      const src = this._noiseSource();
      const bp = ac.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = burstFreq + (this._rng() - 0.5) * 200;
      bp.Q.value = 12;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.035 + this._rng() * 0.025, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.065);
      src.connect(bp);
      bp.connect(g);
      g.connect(side);
      src.start(t, this._rng() * 1.5);
      src.stop(t + 0.09);
    }
  }

  // ------------------------------------------------------------- update

  update(dt /* , elapsed */) {
    if (!this.ac || this.ac.state !== 'running') return;

    // Poll day/night ~once per second
    this._nightPollTimer -= dt;
    if (this._nightPollTimer <= 0) {
      this._nightPollTimer = 1;
      const sky = this.ctx.systems.sky;
      const night = !!(sky && sky.isNight && sky.isNight());
      if (night !== this._isNight) {
        this._isNight = night;
        this._setNightAmbience(night);
        this._cricketTimer = night ? 0.8 + this._rng() * 1.5 : 0;
      }
    }

    // Sparse cricket chirps at night
    if (this._isNight && !this.muted) {
      this._cricketTimer -= dt;
      if (this._cricketTimer <= 0) {
        this._cricketTimer = 1.4 + this._rng() * 2.4; // 1.4–3.8s
        this._cricketBurst();
      }
    }
  }

  // --------------------------------------------------------------- mute

  setMuted(m) {
    this.muted = !!m;
    if (this.master) {
      const t = this.ac.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(this.muted ? 0 : this.masterLevel, t + 0.1);
    }
    this.ctx.events.emit('ui:message', { text: this.muted ? 'Muted' : 'Sound on', duration: 1.6 });
  }

  // ----------------------------------------------------- SFX dispatcher

  /**
   * Rate-limited SFX gate — token bucket per type (10/s sustained, burst 10)
   * + 30 ms same-type minimum gap. Fixes the windowed limiter's edge case
   * where 10 at the end of one window + 10 at the start of the next stacked
   * 20 sounds back-to-back. Extras drop silently.
   */
  _sfx(type, fn) {
    if (!this.ac || this.ac.state !== 'running' || this.muted) return;
    const now = this.ac.currentTime;
    let r = this._rate.get(type);
    if (!r) { r = { tokens: RATE_BURST, last: now, lastFire: -1 }; this._rate.set(type, r); }
    r.tokens = Math.min(RATE_BURST, r.tokens + (now - r.last) * RATE_REFILL);
    r.last = now;
    if (r.tokens < 1 || now - r.lastFire < RATE_MIN_GAP) return; // drop silently
    // global density cap — cross-type storms can't multiply per-type budgets
    this._globalTokens = Math.min(
      GLOBAL_BURST, this._globalTokens + (now - this._globalLast) * GLOBAL_REFILL,
    );
    this._globalLast = now;
    if (this._globalTokens < 1) return; // drop silently
    this._globalTokens -= 1;
    r.tokens -= 1;
    r.lastFire = now;
    try { fn(); } catch (err) { console.error('[AudioEngine] sfx failed:', type, err); }
  }

  _spellCastSfx(id) {
    switch (id) {
      case 'fireball': this._sfx('cast:fireball', () => this._sfxFireball()); break;
      case 'growtree': this._sfx('cast:growtree', () => this._sfxGrowTree()); break;
      case 'lightorb': this._sfx('cast:lightorb', () => this._sfxLightOrb()); break;
      case 'terraform': this._sfx('cast:terraform', () => this._sfxTerraform()); break;
      case 'blink': this._sfx('cast:blink', () => this._sfxBlink()); break;
      case 'portal': this._sfx('cast:portal', () => this._sfxPortal()); break;
      case 'golem': this._sfx('cast:golem', () => this._sfxGolemRumble()); break;
      case 'timewarp': this._sfx('cast:timewarp', () => this._sfxTimeWarp()); break;
      case 'conjure': this._sfx('cast:conjure', () => this._sfxConjure()); break;
      default: this._sfx('cast:generic', () => this._sfxBlink()); break;
    }
  }

  // -------------------------------------------------- synth primitives

  /**
   * One enveloped oscillator. freqTo (if given) sweeps exponentially over dur.
   * attack/decay shape the gain; everything self-stops.
   * Humanized: ±10% gain, ±0.2% pitch per trigger so repeats never sound stamped.
   */
  _tone({ type = 'sine', freq = 440, freqTo = 0, t = 0, dur = 0.3, gain = 0.3, attack = 0.005, out = null }) {
    const ac = this.ac;
    const start = (t || ac.currentTime) + 0.001;
    const lvl = gain * (0.9 + this._rng() * 0.2);
    const detune = 1 + (this._rng() - 0.5) * 0.004;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(1, freq * detune), start);
    if (freqTo > 0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqTo * detune), start + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(lvl, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(g);
    // keep deep subs (thumps/rumbles) dead-center; everything else gets a
    // touch of random stereo placement so repeats breathe in the field
    g.connect(out || (freq >= 150 ? this._sfxOut() : this.master));
    osc.start(start);
    osc.stop(start + dur + 0.05);
    return osc;
  }

  /**
   * Per-trigger stereo humanization: a transient StereoPanner (±0.3) into the
   * master warmth chain. Falls back to master where createStereoPanner is
   * unavailable. Transient nodes are GC'd with the sources they serve.
   */
  _sfxOut() {
    if (!this.ac.createStereoPanner) return this.master;
    const pan = this.ac.createStereoPanner();
    pan.pan.value = (this._rng() - 0.5) * 0.6;
    pan.connect(this.master);
    return pan;
  }

  /** Enveloped filtered noise. filterOpts: { type, freq, freqTo, Q }. */
  _noiseHit({ t = 0, dur = 0.3, gain = 0.4, attack = 0.005, filter = null, out = null }) {
    const ac = this.ac;
    const start = (t || ac.currentTime) + 0.001;
    const src = this._noiseSource();
    let node = src;
    if (filter) {
      const f = ac.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.frequency.setValueAtTime(filter.freq || 1000, start);
      if (filter.freqTo) f.frequency.exponentialRampToValueAtTime(filter.freqTo, start + dur);
      if (filter.Q) f.Q.value = filter.Q;
      src.connect(f);
      node = f;
    }
    const g = ac.createGain();
    const lvl = gain * (0.9 + this._rng() * 0.2); // humanize each hit
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(lvl, start + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    node.connect(g);
    // low rumbles stay centered; brighter noise hits drift in the stereo field
    const lowRumble = filter && (filter.freq || 1000) < 300;
    g.connect(out || (lowRumble ? this.master : this._sfxOut()));
    // Random start offset for variety; clamp so the (non-looping) source
    // doesn't run off the end of the 2s buffer before the envelope finishes.
    const maxOffset = Math.max(0, this.noiseBuffer.duration - (dur + 0.1));
    src.start(start, this._rng() * maxOffset);
    src.stop(start + dur + 0.05);
  }

  // ------------------------------------------------------- SFX palette
  // Values per docs/design/creatures-fx.md SFX table.

  /** Fireball cast: noise whoosh, bandpass sweeping 2400→300 Hz, 0.35s. */
  _sfxFireball() {
    this._noiseHit({
      dur: 0.35, gain: 0.5, attack: 0.02,
      filter: { type: 'bandpass', freq: 2400, freqTo: 300, Q: 1.5 },
    });
  }

  /** Explosion: lowpass noise 900→150 Hz + sub sine 60→35 Hz, 0.6s. */
  _sfxExplosion() {
    this._noiseHit({
      dur: 0.6, gain: 0.8, attack: 0.004,
      filter: { type: 'lowpass', freq: 900, freqTo: 150, Q: 0.9 },
    });
    this._tone({ type: 'sine', freq: 60, freqTo: 35, dur: 0.55, gain: 0.7, attack: 0.004 });
  }

  /** GrowTree: C5–E5–G5 chime arpeggio, 80 ms stagger. */
  _sfxGrowTree() {
    const base = this.ac.currentTime;
    const notes = [523.25, 659.25, 783.99];
    for (let i = 0; i < notes.length; i++) {
      this._tone({ type: 'sine', freq: notes[i], t: base + i * 0.08, dur: 0.55, gain: 0.35, attack: 0.008 });
    }
  }

  /** LightOrb: bell — 880 Hz sine + 1760 Hz partial at 0.3×, long decay. */
  _sfxLightOrb() {
    this._tone({ type: 'sine', freq: 880, dur: 0.9, gain: 0.4, attack: 0.004 });
    this._tone({ type: 'sine', freq: 1760, dur: 0.7, gain: 0.12, attack: 0.004 });
  }

  /** Terraform: low thump, sine 90→55 Hz, 0.18s. */
  _sfxTerraform() {
    this._tone({ type: 'sine', freq: 90, freqTo: 55, dur: 0.18, gain: 0.6, attack: 0.003 });
  }

  /** Blink: rising sine 300→1400 Hz, 0.25s. */
  _sfxBlink() {
    this._tone({ type: 'sine', freq: 300, freqTo: 1400, dur: 0.25, gain: 0.45, attack: 0.005 });
  }

  /** Portal cast: rising sine 200→900 Hz + detuned +7 Hz partner, 0.5s. */
  _sfxPortal() {
    this._tone({ type: 'sine', freq: 200, freqTo: 900, dur: 0.5, gain: 0.45, attack: 0.01 });
    this._tone({ type: 'sine', freq: 207, freqTo: 907, dur: 0.5, gain: 0.3, attack: 0.01 });
  }

  /** Golem cast / spawn: 45 Hz sub + lowpass-noise rumble, ~1s decay. */
  _sfxGolemRumble() {
    this._tone({ type: 'sine', freq: 45, dur: 1.0, gain: 0.7, attack: 0.02 });
    this._noiseHit({
      dur: 0.9, gain: 0.45, attack: 0.03,
      filter: { type: 'lowpass', freq: 120, Q: 0.8 },
    });
  }

  /** TimeWarp: sawtooth 1200→180 Hz through lowpass, slow 0.4s attack (reversed feel), 1.2s. */
  _sfxTimeWarp() {
    const ac = this.ac;
    const start = ac.currentTime + 0.001;
    const dur = 1.2;
    const osc = ac.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(1200, start);
    osc.frequency.exponentialRampToValueAtTime(180, start + dur);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 800;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, start);
    g.gain.linearRampToValueAtTime(0.4, start + 0.4); // long swell = "reversed" feel
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }

  /** Conjure: ascending triangle arpeggio G4–B4–D5–G5, 90 ms stagger. */
  _sfxConjure() {
    const base = this.ac.currentTime;
    const notes = [392, 493.88, 587.33, 783.99];
    for (let i = 0; i < notes.length; i++) {
      this._tone({ type: 'triangle', freq: notes[i], t: base + i * 0.09, dur: 0.5, gain: 0.4, attack: 0.01 });
    }
  }

  /** Block place: bright highpass-noise tick, 70 ms. */
  _sfxBlockPlace() {
    this._noiseHit({
      dur: 0.07, gain: 0.5, attack: 0.002,
      filter: { type: 'highpass', freq: 1800, Q: 0.7 },
    });
  }

  /** Block remove: lower-pitch pop, sine 220→140 Hz, 0.12s. */
  _sfxBlockRemove() {
    this._tone({ type: 'sine', freq: 220, freqTo: 140, dur: 0.12, gain: 0.45, attack: 0.003 });
  }

  /** Prefab place: C major triad swell (0.3s attack, ~1s decay). */
  _sfxPrefabPlace() {
    const ac = this.ac;
    const start = ac.currentTime + 0.001;
    const notes = [261.63, 329.63, 392];
    for (const f of notes) {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, start);
      g.gain.linearRampToValueAtTime(0.45 / notes.length, start + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, start + 1.3);
      osc.connect(g);
      g.connect(this.master);
      osc.start(start);
      osc.stop(start + 1.4);
    }
  }

  /** Teleport: shimmer — three quick rising sines, 60 ms apart. */
  _sfxTeleportShimmer() {
    const base = this.ac.currentTime;
    const sweeps = [[600, 1200], [800, 1600], [1000, 2000]];
    for (let i = 0; i < sweeps.length; i++) {
      this._tone({
        type: 'sine', freq: sweeps[i][0], freqTo: sweeps[i][1],
        t: base + i * 0.06, dur: 0.28, gain: 0.4, attack: 0.005,
      });
    }
  }

  /** Mana insufficient: dull two-tone "uh-uh" — squares 180 then 140 Hz. */
  _sfxManaFail() {
    const base = this.ac.currentTime;
    this._tone({ type: 'square', freq: 180, t: base, dur: 0.1, gain: 0.35, attack: 0.005 });
    this._tone({ type: 'square', freq: 140, t: base + 0.11, dur: 0.14, gain: 0.35, attack: 0.005 });
  }
}
