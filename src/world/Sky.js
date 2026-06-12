import * as THREE from 'three';

/**
 * Sky — full day/night cycle for Magic World.
 *
 * Owns:
 *  - Inside-facing sky dome (ShaderMaterial, 3-stop vertical gradient + sun glow)
 *  - Sun: shadow-casting DirectionalLight (follows the camera) + emissive disc + glow sprite
 *  - Moon: dim bluish DirectionalLight + emissive disc + halo sprite
 *  - Stars: 1300-point shader Points (incl. a tilted Milky-Way ribbon) with
 *    per-star size/color and ~78 twinklers
 *  - Hemisphere light + animated THREE.FogExp2 on ctx.scene
 *  - Sky-driven environment map: a PMREM bake of a tiny gradient proxy scene
 *    feeds scene.environment so MeshStandardMaterials (water, crystals,
 *    unicorn horns) pick up real sky reflections. Rebaked only every
 *    ~ENV_REFRESH_SECONDS or when sun intensity jumps by ENV_SUN_DELTA —
 *    never per frame. Budget: 6 tiny cube faces + mip chain a few times a
 *    minute; previous render target disposed on each refresh (no VRAM leak).
 *
 * timeOfDay: 0 = midnight, 0.25 = dawn, 0.5 = noon, 0.75 = dusk. Starts at 0.35.
 * A full cycle takes ctx.config.daySeconds seconds.
 */

// ---------------------------------------------------------------------------
// Phase keyframes — a dense 10-stop ring so the cycle drifts through deep
// night, violet pre-dawn, rose dawn, golden morning, cyan noon, amber
// afternoon, ember dusk and indigo blue-hour instead of 4 hard stops.
// A virtual wrap key at t=1 returns to midnight. Colors pre-built at load.
// ---------------------------------------------------------------------------
const PHASES = [
  { t: 0.0,  horizon: 0x1a1f4d, mid: 0x0e1238, zenith: 0x060a24, fog: 0x141a3e, sun: 0xffd9a0, sunI: 0.0 },  // midnight
  { t: 0.1,  horizon: 0x232456, mid: 0x12143e, zenith: 0x070b28, fog: 0x191d44, sun: 0xffd9a0, sunI: 0.0 },  // deep night
  { t: 0.19, horizon: 0x4a3a78, mid: 0x252058, zenith: 0x0d1030, fog: 0x37315e, sun: 0xffc890, sunI: 0.0 },  // violet pre-dawn
  { t: 0.25, horizon: 0xffa066, mid: 0xe573b8, zenith: 0x3a4a8c, fog: 0xd98b78, sun: 0xffd9a0, sunI: 1.2 },  // rose dawn
  { t: 0.285, horizon: 0xffc488, mid: 0xb693d6, zenith: 0x3f66ae, fog: 0xe0a98c, sun: 0xffe0a8, sunI: 1.6 }, // peach blush
  { t: 0.32, horizon: 0xffd9a0, mid: 0x9fc4ec, zenith: 0x3f7ec4, fog: 0xc9d2e8, sun: 0xffe9b8, sunI: 2.0 },  // golden morning
  { t: 0.5,  horizon: 0xbfeaff, mid: 0x6ec5f2, zenith: 0x2f93dd, fog: 0xa8d8ef, sun: 0xfff4d6, sunI: 2.6 },  // cyan noon
  { t: 0.66, horizon: 0xffe2ae, mid: 0x8cb4e4, zenith: 0x3a76b8, fog: 0xc4cfdd, sun: 0xffe2a8, sunI: 2.1 },  // amber afternoon
  { t: 0.7,  horizon: 0xffce82, mid: 0x97a0d8, zenith: 0x3a64ac, fog: 0xd6b08e, sun: 0xffd089, sunI: 1.8 },  // honey hour
  { t: 0.75, horizon: 0xff6e44, mid: 0xc257a4, zenith: 0x2e2a66, fog: 0xcf7a62, sun: 0xffb070, sunI: 1.0 },  // ember dusk
  { t: 0.82, horizon: 0x6a4486, mid: 0x33295f, zenith: 0x121538, fog: 0x4a3a64, sun: 0xff9e78, sunI: 0.0 },  // blue hour
  { t: 0.92, horizon: 0x1e2252, mid: 0x10133c, zenith: 0x070b26, fog: 0x161a40, sun: 0xffd9a0, sunI: 0.0 },  // night
].map((p) => ({
  t: p.t,
  horizon: new THREE.Color(p.horizon),
  mid: new THREE.Color(p.mid),
  zenith: new THREE.Color(p.zenith),
  fog: new THREE.Color(p.fog),
  sun: new THREE.Color(p.sun),
  sunI: p.sunI,
}));

const ORBIT_TILT = (18 * Math.PI) / 180; // orbital plane leans 18° toward z
const TAU = Math.PI * 2;

const FOG_DENSITY_DAY = 0.0028;
const FOG_DENSITY_NIGHT = 0.0042;

// Environment-map bake policy: refresh on a slow clock or a noticeable sun
// jump (e.g. TimeWarp), never per frame. Intensity stays modest so standard
// materials gain sky-tinted reflections without washing out the flat shading.
const ENV_REFRESH_SECONDS = 5;
const ENV_SUN_DELTA = 0.15;
const ENV_INTENSITY = 0.5;

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

const CLOUD_LIGHT = new THREE.Color(0xfff6ec);

// Soft round radial-gradient texture for the sun glow / moon halo sprites.
function makeGlowTexture(size, stops) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const c = canvas.getContext('2d');
  const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [offset, color] of stops) g.addColorStop(offset, color);
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Soft layered-puff cloud texture (deterministic, built once at load).
function makeCloudTexture(size) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size >> 1;
  const c = canvas.getContext('2d');
  let s = 24601;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 16; i++) {
    const px = size * (0.16 + rand() * 0.68);
    const py = (size >> 1) * (0.28 + rand() * 0.46);
    const pr = size * (0.07 + rand() * 0.11);
    const g = c.createRadialGradient(px, py, 0, px, py, pr);
    g.addColorStop(0, 'rgba(255,255,255,0.17)');
    g.addColorStop(0.65, 'rgba(255,255,255,0.07)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, size, size >> 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------
const DOME_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const DOME_FRAG = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uMid;
  uniform vec3 uZenith;
  uniform vec3 uSunDir;
  uniform vec3 uSunGlowColor;
  uniform float uSunGlow;
  uniform float uMoonGlow;
  uniform float uAurora;
  uniform float uTime;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, 0.0, 1.0);
    vec3 col = h < 0.45
      ? mix(uHorizon, uMid, smoothstep(0.0, 0.45, h))
      : mix(uMid, uZenith, smoothstep(0.45, 1.0, h));
    // luminous haze band hugging the horizon — gives the gradient depth
    col += uHorizon * 0.14 * pow(1.0 - h, 7.0) * step(0.0, vDir.y);
    // below the horizon: darken toward the nadir so the under-rim isn't flat
    if (vDir.y < 0.0) col = uHorizon * (1.0 + vDir.y * 0.55);
    // warm scatter around the sun: tight core + wide horizon bloom
    float d = max(dot(vDir, uSunDir), 0.0);
    col += uSunGlowColor * (pow(d, 28.0) * 0.9 + pow(d, 4.0) * 0.22) * uSunGlow;
    // cool silver scatter around the moon (opposite the sun)
    float m = max(dot(vDir, -uSunDir), 0.0);
    col += vec3(0.42, 0.52, 0.82) * (pow(m, 40.0) * 0.7 + pow(m, 6.0) * 0.10) * uMoonGlow;
    // faint antitwilight blush opposite a low sun (Belt-of-Venus feel)
    float anti = max(dot(normalize(vec3(-uSunDir.x, 0.12, -uSunDir.z)), vDir), 0.0);
    col += uSunGlowColor * pow(anti, 9.0) * 0.10 * uSunGlow * (1.0 - smoothstep(0.0, 0.5, h));
    // aurora: slow teal/violet curtains rippling across the night sky
    if (uAurora > 0.002) {
      float w1 = sin(vDir.x * 5.2 + uTime * 0.11 + sin(vDir.z * 3.6 - uTime * 0.07) * 1.7);
      float w2 = sin(vDir.z * 4.1 - uTime * 0.08 + sin(vDir.x * 2.9 + uTime * 0.05) * 1.4);
      float curtain = smoothstep(0.45, 1.0, w1 * 0.5 + 0.5)
                    + smoothstep(0.55, 1.0, w2 * 0.5 + 0.5) * 0.65;
      float bandMask = smoothstep(0.12, 0.45, h) * (1.0 - smoothstep(0.72, 1.0, h));
      vec3 auroraCol = mix(vec3(0.10, 0.85, 0.55), vec3(0.45, 0.25, 0.90),
                           0.5 + 0.5 * sin(vDir.x * 2.1 + h * 3.0 + uTime * 0.04));
      col += auroraCol * curtain * bandMask * uAurora;
    }
    // ordered dither kills gradient banding on the big smooth dome
    float dn = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
    col += (dn - 0.5) * (1.5 / 255.0);
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Minimal gradient proxy for the PMREM environment bake. Shares the dome's
// uniforms object so it always samples the live phase colors. Outputs LINEAR
// color with no tonemapping/colorspace includes — PMREMGenerator renders with
// NoToneMapping into a linear half-float target, so raw linear is correct.
const ENV_FRAG = /* glsl */ `
  uniform vec3 uHorizon;
  uniform vec3 uMid;
  uniform vec3 uZenith;
  uniform vec3 uSunDir;
  uniform vec3 uSunGlowColor;
  uniform float uSunGlow;
  varying vec3 vDir;
  void main() {
    float h = clamp(vDir.y, 0.0, 1.0);
    vec3 col = h < 0.45
      ? mix(uHorizon, uMid, smoothstep(0.0, 0.45, h))
      : mix(uMid, uZenith, smoothstep(0.45, 1.0, h));
    // below the horizon: dim grounded bounce so under-reflections aren't black
    if (vDir.y < 0.0) {
      vec3 ground = mix(uHorizon * 0.45, vec3(0.055, 0.085, 0.055), 0.55);
      col = mix(uHorizon * 0.8, ground, smoothstep(0.0, -0.35, vDir.y));
    }
    // sun blob so glossy materials catch a warm specular-ish hotspot
    float d = max(dot(vDir, uSunDir), 0.0);
    col += uSunGlowColor * (pow(d, 64.0) * 1.6 + pow(d, 6.0) * 0.25) * uSunGlow;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const STAR_VERT = /* glsl */ `
  attribute float aSize;
  attribute float aTwinkle;
  attribute float aPhase;
  uniform float uTime;
  uniform float uOpacity;
  uniform float uPixelRatio;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    vColor = color;
    float tw = aTwinkle > 0.0 ? 0.55 + 0.45 * sin(uTime * aTwinkle + aPhase) : 1.0;
    vAlpha = uOpacity * tw;
    gl_PointSize = aSize * uPixelRatio * (0.7 + 0.3 * tw);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const STAR_FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.08, d) * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export default class Sky {
  constructor(ctx) {
    this.ctx = ctx;
    this.timeOfDay = 0.35;

    // -- scratch objects (no per-frame allocations) ------------------------
    this._sunDir = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._colHorizon = new THREE.Color();
    this._colMid = new THREE.Color();
    this._colZenith = new THREE.Color();
    this._colFog = new THREE.Color();
    this._colSun = new THREE.Color();
    this._colCloud = new THREE.Color();
    this._sunKeyIntensity = 0;

    // Everything celestial lives in one group that tracks the camera, so the
    // dome / sun / moon / stars are always centered on the viewer.
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;
    ctx.scene.add(this.group);

    this._buildDome();
    this._buildLights();
    this._buildSunAndMoon();
    this._buildStars();
    this._buildMeteors();
    this._buildClouds();

    // Fog (color + density animated per frame)
    this.fog = new THREE.FogExp2(0xa8d8ef, FOG_DENSITY_DAY);
    ctx.scene.fog = this.fog;

    // Sky-driven environment map (PMREM). Any failure degrades gracefully:
    // log once, run without scene.environment.
    this._pmrem = null;
    this._envScene = null;
    this._envRT = null;
    this._envBakeTime = 0;
    this._envBakeSunI = 0;
    this._buildEnvMap();

    // Prime everything so frame 0 already looks right.
    this._apply(0);
    this._bakeEnv(0);
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------
  _buildDome() {
    const geo = new THREE.SphereGeometry(900, 24, 16);
    this.domeUniforms = {
      uHorizon: { value: new THREE.Color(0xbfeaff) },
      uMid: { value: new THREE.Color(0x6ec5f2) },
      uZenith: { value: new THREE.Color(0x3a9ad9) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunGlowColor: { value: new THREE.Color(0xfff4d6) },
      uSunGlow: { value: 0.4 },
      uMoonGlow: { value: 0.0 },
      uAurora: { value: 0.0 },
      uTime: { value: 0.0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.domeUniforms,
      vertexShader: DOME_VERT,
      fragmentShader: DOME_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.renderOrder = -10;
    this.dome.frustumCulled = false;
    this.group.add(this.dome);
  }

  _buildLights() {
    // Sun — the one shadow caster. Its shadow camera follows ctx.camera every
    // frame so shadows work everywhere on the 240-unit island.
    this.sunLight = new THREE.DirectionalLight(0xfff4d6, 2.6);
    this.sunLight.castShadow = true;
    const sh = this.sunLight.shadow;
    sh.mapSize.set(2048, 2048);
    sh.camera.left = -70;
    sh.camera.right = 70;
    sh.camera.top = 70;
    sh.camera.bottom = -70;
    sh.camera.near = 10;
    sh.camera.far = 420;
    sh.bias = -0.0004;
    sh.normalBias = 0.5;
    sh.camera.updateProjectionMatrix(); // bounds changed after construction
    this.ctx.scene.add(this.sunLight);
    this.ctx.scene.add(this.sunLight.target);

    // Moon — dim, bluish, no shadow (keeps the light count stable & cheap).
    this.moonLight = new THREE.DirectionalLight(0xa8c4ff, 0.0);
    this.ctx.scene.add(this.moonLight);
    this.ctx.scene.add(this.moonLight.target);

    // Hemisphere fill: sky #bcd8ff / ground #3e5a3e, 0.25 night -> 0.9 noon.
    this.hemiLight = new THREE.HemisphereLight(0xbcd8ff, 0x3e5a3e, 0.9);
    this.ctx.scene.add(this.hemiLight);
  }

  _buildSunAndMoon() {
    // Sun disc — emissive-looking unlit sphere riding the orbit at radius 600.
    this.sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(10, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe9b0, fog: false })
    );
    this.sunDisc.material.color.multiplyScalar(1.6); // push past 1 → glows under ACES
    this.sunDisc.frustumCulled = false;
    this.group.add(this.sunDisc);

    const sunGlowTex = makeGlowTexture(128, [
      [0.0, 'rgba(255, 236, 170, 0.95)'],
      [0.35, 'rgba(255, 200, 110, 0.35)'],
      [1.0, 'rgba(255, 180, 80, 0.0)'],
    ]);
    this.sunGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: sunGlowTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.55,
        fog: false,
      })
    );
    this.sunGlow.scale.set(70, 70, 1);
    this.group.add(this.sunGlow);

    // Moon — pale emissive sphere opposite the sun + soft halo sprite.
    this.moonDisc = new THREE.Mesh(
      new THREE.SphereGeometry(7, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xe8efff, fog: false })
    );
    this.moonDisc.material.color.multiplyScalar(1.5);
    this.moonDisc.frustumCulled = false;
    this.group.add(this.moonDisc);

    const haloTex = makeGlowTexture(128, [
      [0.0, 'rgba(220, 232, 255, 0.8)'],
      [0.4, 'rgba(180, 200, 255, 0.25)'],
      [1.0, 'rgba(150, 180, 255, 0.0)'],
    ]);
    this.moonHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: haloTex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0.35,
        fog: false,
      })
    );
    this.moonHalo.scale.set(28, 28, 1);
    this.group.add(this.moonHalo);
  }

  _buildMeteors() {
    // A tiny pool of shooting stars — rare, brief streaks on clear nights.
    const tex = makeGlowTexture(64, [
      [0.0, 'rgba(255, 255, 255, 0.95)'],
      [0.3, 'rgba(205, 225, 255, 0.45)'],
      [1.0, 'rgba(160, 190, 255, 0.0)'],
    ]);
    /** @type {Array<object>} */
    this.meteors = [];
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
        opacity: 0,
        fog: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(26, 2.4, 1); // elongated streak
      sprite.visible = false;
      this.group.add(sprite);
      this.meteors.push({
        sprite,
        t: -1, // -1 = idle, else 0..1 progress
        dur: 1,
        x0: 0, y0: 0, z0: 0,
        dx: 0, dy: 0, dz: 0,
      });
    }
  }

  _buildClouds() {
    // A ring of slow-drifting translucent cloud sprites riding inside the
    // dome. One shared material — they all tint together with the phase
    // colors, catching rose at dawn, gold at dusk, faint moonlit blue at night.
    this.cloudMaterial = new THREE.SpriteMaterial({
      map: makeCloudTexture(256),
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      fog: false,
    });
    this.cloudGroup = new THREE.Group();
    this.group.add(this.cloudGroup);

    let s = 60901;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    for (let i = 0; i < 11; i++) {
      const sprite = new THREE.Sprite(this.cloudMaterial);
      const az = rand() * TAU;
      const elev = 0.1 + rand() * 0.3;
      const r = Math.sqrt(1 - elev * elev);
      sprite.position.set(Math.cos(az) * r * 680, elev * 680, Math.sin(az) * r * 680);
      const w = 130 + rand() * 160;
      sprite.scale.set(w, w * 0.42, 1);
      sprite.renderOrder = -8; // after dome (-10) and stars (-9)
      this.cloudGroup.add(sprite);
    }
  }

  _buildEnvMap() {
    try {
      this._pmrem = new THREE.PMREMGenerator(this.ctx.renderer);
      // Tiny proxy scene: one inside-facing low-seg sphere running the
      // gradient shader. Shares this.domeUniforms, so phase colors / sun
      // direction are always current at bake time with zero extra bookkeeping.
      this._envScene = new THREE.Scene();
      const proxy = new THREE.Mesh(
        new THREE.SphereGeometry(10, 16, 10),
        new THREE.ShaderMaterial({
          uniforms: this.domeUniforms,
          vertexShader: DOME_VERT,
          fragmentShader: ENV_FRAG,
          side: THREE.BackSide,
          depthWrite: false,
        })
      );
      proxy.frustumCulled = false;
      this._envScene.add(proxy);
      this.ctx.scene.environmentIntensity = ENV_INTENSITY;
    } catch (err) {
      console.warn('[Sky] PMREM env map unavailable — continuing without it.', err);
      this._disposeEnv();
    }
  }

  /** Render the proxy scene through PMREM and swap scene.environment. */
  _bakeEnv(elapsed) {
    if (!this._pmrem) return;
    try {
      const rt = this._pmrem.fromScene(this._envScene, 0, 0.5, 40);
      const old = this._envRT;
      this._envRT = rt;
      this.ctx.scene.environment = rt.texture;
      if (old) old.dispose(); // free previous target — no VRAM leak
      this._envBakeTime = elapsed;
      this._envBakeSunI = this.getSunIntensity();
    } catch (err) {
      console.warn('[Sky] env map bake failed — disabling sky reflections.', err);
      this._disposeEnv();
    }
  }

  _disposeEnv() {
    if (this.ctx.scene.environment) this.ctx.scene.environment = null;
    if (this._envRT) { this._envRT.dispose(); this._envRT = null; }
    if (this._pmrem) { this._pmrem.dispose(); this._pmrem = null; }
    this._envScene = null;
  }

  _buildStars() {
    const COUNT = 1300;
    const TWINKLE_CHANCE = 0.06; // ~78 gentle twinklers across the field
    const BAND = 460; // stars woven into a faint tilted Milky-Way band
    const R = 820;

    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    const twinkles = new Float32Array(COUNT);
    const phases = new Float32Array(COUNT);

    const cWhite = new THREE.Color(0xffffff);
    const cBlue = new THREE.Color(0xcfe2ff);
    const cWarm = new THREE.Color(0xffd9c4);
    const cNebulaA = new THREE.Color(0xd8c8ff); // lavender band dust
    const cNebulaB = new THREE.Color(0xbfeee8); // teal band dust

    // Tiny deterministic PRNG so the sky is identical every load.
    let s = 91537;
    const rand = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };

    // Milky-Way band frame: a great circle tilted across the dome.
    const bandTilt = 0.62;
    const ctl = Math.cos(bandTilt);
    const stl = Math.sin(bandTilt);

    for (let i = 0; i < COUNT; i++) {
      let x, y, z;
      if (i < BAND) {
        // Dense ribbon hugging a tilted great circle (gaussian-ish spread).
        const a = rand() * TAU;
        const spread = (rand() + rand() - 1) * 0.16; // triangular ≈ gaussian
        const bx = Math.cos(a);
        const by = spread;
        const bz = Math.sin(a);
        // tilt the band plane around x
        x = bx;
        y = by * ctl - bz * stl;
        z = by * stl + bz * ctl;
        const inv = 1 / Math.sqrt(x * x + y * y + z * z);
        x *= inv; y *= inv; z *= inv;
        if (y < -0.1) y = -y * 0.4 - 0.06; // keep most of the ribbon visible
      } else {
        // Random direction, biased to the upper hemisphere (a few dip below
        // the horizon so the dome edge never looks clipped).
        const u = rand() * TAU;
        y = -0.08 + 1.08 * Math.pow(rand(), 0.75);
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        x = Math.cos(u) * r;
        z = Math.sin(u) * r;
      }
      positions[i * 3] = x * R;
      positions[i * 3 + 1] = y * R;
      positions[i * 3 + 2] = z * R;

      const pick = rand();
      const c = i < BAND
        ? (pick < 0.45 ? cWhite : pick < 0.75 ? cNebulaA : cNebulaB)
        : (pick < 0.78 ? cWhite : pick < 0.94 ? cBlue : cWarm);
      const dim = i < BAND ? 0.55 + rand() * 0.45 : 1.0; // band dust reads softer
      colors[i * 3] = c.r * dim;
      colors[i * 3 + 1] = c.g * dim;
      colors[i * 3 + 2] = c.b * dim;

      sizes[i] = (i < BAND ? 0.5 + rand() * 0.9 : 0.8 + rand() * 1.4) * 2.0; // px (× pixelRatio)
      twinkles[i] = rand() < TWINKLE_CHANCE ? TAU / (1.5 + rand() * 2.5) : 0; // period 1.5–4 s
      phases[i] = rand() * TAU;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geo.setAttribute('aTwinkle', new THREE.BufferAttribute(twinkles, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));

    this.starUniforms = {
      uTime: { value: 0 },
      uOpacity: { value: 0 },
      uPixelRatio: { value: this.ctx.renderer.getPixelRatio() },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.starUniforms,
      vertexShader: STAR_VERT,
      fragmentShader: STAR_FRAG,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });

    this.stars = new THREE.Points(geo, mat);
    this.stars.renderOrder = -9;
    this.stars.frustumCulled = false;
    this.group.add(this.stars);
  }

  // -------------------------------------------------------------------------
  // Public API (contract)
  // -------------------------------------------------------------------------

  /** Shift timeOfDay by `hours / 24`, wrapping into [0, 1). */
  advance(hours) {
    this.timeOfDay = (((this.timeOfDay + hours / 24) % 1) + 1) % 1;
  }

  /** True roughly between dusk and dawn. */
  isNight() {
    return this.timeOfDay < 0.22 || this.timeOfDay > 0.78;
  }

  /** Normalized sun strength 0..1 (0 = sun below horizon, 1 = high day). */
  getSunIntensity() {
    return smoothstep(-0.04, 0.3, this._sunElevation());
  }

  update(dt, elapsed) {
    this.timeOfDay = (this.timeOfDay + dt / this.ctx.config.daySeconds) % 1;
    this._apply(elapsed, dt);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** sin of the sun's elevation angle: 1 at noon, 0 at sunrise/sunset, -1 midnight. */
  _sunElevation() {
    return Math.sin((this.timeOfDay - 0.25) * TAU);
  }

  /** Interpolate phase keyframes into the scratch colors. Smoothstep-eased per segment. */
  _samplePhases() {
    const t = this.timeOfDay;
    const n = PHASES.length;
    let i = n - 1;
    for (let k = n - 1; k >= 0; k--) {
      if (t >= PHASES[k].t) {
        i = k;
        break;
      }
    }
    const a = PHASES[i];
    const b = PHASES[(i + 1) % n];
    const span = (i === n - 1 ? 1 : b.t) - a.t;
    const f = smoothstep(0, 1, clamp01((t - a.t) / span));

    this._colHorizon.lerpColors(a.horizon, b.horizon, f);
    this._colMid.lerpColors(a.mid, b.mid, f);
    this._colZenith.lerpColors(a.zenith, b.zenith, f);
    this._colFog.lerpColors(a.fog, b.fog, f);
    this._colSun.lerpColors(a.sun, b.sun, f);
    this._sunKeyIntensity = a.sunI + (b.sunI - a.sunI) * f;
  }

  _apply(elapsed, dt = 0) {
    const theta = (this.timeOfDay - 0.25) * TAU;
    const elev = Math.sin(theta);
    const sunDir = this._sunDir.set(
      Math.cos(theta),
      Math.sin(theta) * Math.cos(ORBIT_TILT),
      Math.sin(theta) * Math.sin(ORBIT_TILT)
    );

    const sunFactor = smoothstep(-0.04, 0.3, elev); // 0..1 day strength
    const moonFactor = smoothstep(0.02, 0.28, -elev); // 0..1 night strength
    const starFade = 1 - smoothstep(-0.22, -0.02, elev); // fade over ~8% of cycle

    this._samplePhases();

    // ---- celestial group rides the camera --------------------------------
    const cam = this._camPos.setFromMatrixPosition(this.ctx.camera.matrixWorld);
    this.group.position.copy(cam);

    // ---- sun & moon discs (local to group) --------------------------------
    this.sunDisc.position.copy(sunDir).multiplyScalar(600);
    this.sunGlow.position.copy(sunDir).multiplyScalar(594);
    this.moonDisc.position.copy(sunDir).multiplyScalar(-600);
    this.moonHalo.position.copy(sunDir).multiplyScalar(-596);

    this.sunDisc.visible = elev > -0.12;
    this.sunGlow.visible = this.sunDisc.visible;
    this.moonDisc.visible = elev < 0.12;
    this.moonHalo.visible = this.moonDisc.visible;

    this.sunGlow.material.opacity = 0.25 + 0.45 * smoothstep(-0.08, 0.15, elev);
    // halo breathes very slowly — the moon feels alive instead of pasted on
    this.moonHalo.material.opacity = (0.32 + 0.08 * Math.sin(elapsed * 0.45)) * moonFactor;

    // ---- lights ------------------------------------------------------------
    // Sun light hovers 180 units from the camera along the sun direction; the
    // ~140-unit ortho shadow box is therefore always centered on the player.
    this.sunLight.position.copy(sunDir).multiplyScalar(180).add(cam);
    this.sunLight.target.position.copy(cam);
    this.sunLight.color.copy(this._colSun);
    this.sunLight.intensity = this._sunKeyIntensity * smoothstep(-0.03, 0.14, elev);

    this.moonLight.position.copy(sunDir).multiplyScalar(-180).add(cam);
    this.moonLight.target.position.copy(cam);
    this.moonLight.intensity = 0.35 * moonFactor;

    this.hemiLight.intensity = 0.25 + 0.65 * sunFactor;

    // ---- dome --------------------------------------------------------------
    const u = this.domeUniforms;
    u.uHorizon.value.copy(this._colHorizon);
    u.uMid.value.copy(this._colMid);
    u.uZenith.value.copy(this._colZenith);
    u.uSunDir.value.copy(sunDir);
    u.uSunGlowColor.value.copy(this._colSun);
    // Glow swells when the sun sits near the horizon (dawn/dusk drama).
    const horizonGlow = (1 - Math.min(1, Math.abs(elev) * 2.2)) * smoothstep(-0.18, 0.0, elev);
    u.uSunGlow.value = 0.3 * sunFactor + 0.85 * horizonGlow;
    u.uMoonGlow.value = 0.55 * moonFactor;
    u.uTime.value = elapsed;
    // Aurora waxes and wanes over minutes — some nights blaze, some whisper.
    const auroraWax = 0.5 + 0.5 * Math.sin(elapsed * 0.011 + Math.sin(elapsed * 0.0047) * 2.2);
    u.uAurora.value = moonFactor * starFade * (0.025 + 0.13 * auroraWax * auroraWax);

    // ---- clouds ------------------------------------------------------------
    // The whole ring drifts imperceptibly; tint chases the live phase colors
    // so dawn paints the clouds rose and dusk sets them on fire.
    this.cloudGroup.rotation.y += dt * 0.0045;
    const cc = this._colCloud.copy(this._colMid).lerp(CLOUD_LIGHT, 0.5);
    cc.lerp(this._colSun, horizonGlow * 0.65);
    this.cloudMaterial.color.copy(cc);
    this.cloudMaterial.opacity = 0.12 + 0.38 * sunFactor + 0.28 * horizonGlow;

    // ---- shooting stars ----------------------------------------------------
    const meteors = this.meteors;
    for (let i = 0; i < meteors.length; i++) {
      const m = meteors[i];
      if (m.t < 0) {
        // Spawn only on dark sky, on average one streak every ~15 s per slot.
        if (moonFactor > 0.45 && dt > 0 && Math.random() < dt * 0.065) {
          const az = Math.random() * TAU;
          const yFrac = 0.45 + Math.random() * 0.35; // start high in the dome
          const rr = Math.sqrt(1 - yFrac * yFrac);
          m.x0 = Math.cos(az) * rr * 760;
          m.y0 = yFrac * 760;
          m.z0 = Math.sin(az) * rr * 760;
          const az2 = az + (Math.random() < 0.5 ? 1 : -1) * (0.3 + Math.random() * 0.3);
          m.dx = Math.cos(az2) * rr * 760 - m.x0;
          m.dy = -(60 + Math.random() * 90);
          m.dz = Math.sin(az2) * rr * 760 - m.z0;
          m.dur = 0.7 + Math.random() * 0.6;
          m.sprite.material.rotation = (Math.random() - 0.5) * 0.9;
          m.t = 0;
        }
      } else {
        m.t += dt / m.dur;
        if (m.t >= 1) {
          m.t = -1;
          m.sprite.visible = false;
          m.sprite.material.opacity = 0;
        } else {
          const p = m.t;
          m.sprite.visible = true;
          m.sprite.position.set(m.x0 + m.dx * p, m.y0 + m.dy * p, m.z0 + m.dz * p);
          m.sprite.material.opacity = Math.sin(p * Math.PI) * 0.8 * moonFactor;
        }
      }
    }

    // ---- stars -------------------------------------------------------------
    this.starUniforms.uTime.value = elapsed;
    this.starUniforms.uOpacity.value = starFade;
    this.stars.visible = starFade > 0.01;

    // ---- fog ---------------------------------------------------------------
    this.fog.color.copy(this._colFog);
    this.fog.density = FOG_DENSITY_NIGHT + (FOG_DENSITY_DAY - FOG_DENSITY_NIGHT) * sunFactor;

    // ---- environment map ---------------------------------------------------
    // Rebake on a slow clock, or immediately on a big sun jump (TimeWarp /
    // fast dawn). sunFactor === getSunIntensity() here. dt>0 skips frame 0,
    // which the constructor bakes explicitly.
    if (this._pmrem && dt > 0) {
      if (
        elapsed - this._envBakeTime >= ENV_REFRESH_SECONDS ||
        Math.abs(sunFactor - this._envBakeSunI) > ENV_SUN_DELTA
      ) {
        this._bakeEnv(elapsed);
      }
    }
  }
}
