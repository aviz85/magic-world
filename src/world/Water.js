import * as THREE from 'three';
import { mulberry32, createNoise2D, fbm } from './Noise.js';

// ---------------------------------------------------------------------------
// Water — translucent animated magical water plane.
//
// Contract (docs/CONTRACTS.md):
//   - Plane at y = config.waterLevel, size >= worldSize * 1.5.
//   - Gentle vertex waves + slowly scrolling sparkle.
//   - transparent: true, opacity ~0.75, magical teal-blue, emissive at night.
//   - Excluded from raycasts (mesh.raycast = noop).
//
// Design (docs/design/world.md):
//   - PlaneGeometry(380, 380, 64, 64) at y = 1.2.
//   - Color #2aa3a8 day -> #1b5e8a night; opacity 0.75, roughness 0.15.
//   - Night emissive #0d4a52 @ 0.35 (0 by day).
//   - Waves: 0.12*sin(x*0.18 + t*1.1) + 0.09*sin(z*0.23 - t*0.9)
//            + 0.05*sin((x+z)*0.31 + t*1.7)
//   - Sparkle: 128px seamless canvas noise, uv scroll (0.008, 0.005)/s, ~20%.
//
// Implementation: the 6-wave sum + analytic normals now run ON THE GPU.
// material.onBeforeCompile injects the exact same closed-form math the old
// CPU loop evaluated per vertex per frame into the standard vertex shader,
// driven by a single uTime uniform — the CPU's only per-frame work is cheap
// uniform/material updates (tint, sparkle scroll, emissive, opacity).
// The fragment injection adds two painterly touches:
//   - Shoreline foam: water depth (waterLevel − terrainHeight) is baked into
//     an aDepth vertex attribute at construction; shallow fragments blend
//     toward a soft foam white (#eafaf4 — never pure #ffffff) with a gentle
//     lapping + sparkle shimmer, so a bright ribbon hugs every coast.
//   - Fresnel: grazing views get a touch more opacity and sheen, top-down
//     views stay dreamily translucent around the 0.75 baseline.
// ---------------------------------------------------------------------------

const SEGMENTS = 64;
const SPARKLE_SIZE = 128;
const SPARKLE_REPEAT = 22;
const SCROLL_U = 0.008; // tiles / second
const SCROLL_V = 0.005;

// Wave constants (amplitude, spatial frequency, temporal frequency).
// A 4th counter-diagonal ripple breaks the interference pattern's symmetry so
// the surface reads dreamy instead of mechanical. Still fully analytic.
const A1 = 0.12, F1 = 0.18, T1 = 1.1;
const A2 = 0.09, F2 = 0.23, T2 = -0.9;
const A3 = 0.05, F3 = 0.31, T3 = 1.7;
const A4 = 0.035, F4 = 0.47, T4 = -1.35;
// 5th wave: a long, slow ocean swell rolling diagonally across the whole
// plane — broad undulation that makes the sea feel vast and dreamlike.
const A5 = 0.055, F5 = 0.045, T5 = 0.32;
const SW_X = 0.62, SW_Z = 0.78; // swell travel direction
// 6th wave: fine fast chop riding on top — tiny glittering texture that makes
// the surface feel liquid up close without disturbing the dreamy swell.
const A6 = 0.022, F6 = 0.85, T6 = 2.3;
const CH_X = 0.93, CH_Z = -0.37; // chop travel direction (crosses the swell)
// Pre-multiplied slope coefficients for analytic normals (d/dx of A*sin(F*x)).
const D1 = A1 * F1;
const D2 = A2 * F2;
const D3 = A3 * F3;
const D4 = A4 * F4;
const D5 = A5 * F5;
const D6 = A6 * F6;
// Slow swell envelope — the whole sea breathes over ~90 s.
const SWELL_W = 0.07;
const SWELL_AMP = 0.18; // envelope ranges 0.82 .. 1.18

// Foam: depth below which the shore ribbon appears, in world units. ~0.9
// gives a band a couple of metres wide on the gentle sand shelves — readable
// from the floating islands (the "diorama" view) without wrapping the whole
// lagoon in white.
const FOAM_DEPTH = 0.9;
const FOAM_COLOR = new THREE.Color('#eafaf4'); // soft sea-foam, never #ffffff

// Underwater veil: when the camera dips below the surface the world should
// read "submerged in a lagoon", not transparent air. Water.update runs after
// Sky.update (SYSTEM_ORDER), so overriding fog here wins for the frame.
const UNDERWATER_COLOR = new THREE.Color('#1d6f9b');       // sunlit shallows
const UNDERWATER_COLOR_NIGHT = new THREE.Color('#0a2e4d'); // moonlit depths
const UNDERWATER_FOG_DENSITY = 0.05;

const COLOR_DAY = new THREE.Color('#2aa3a8');
const COLOR_DAY_B = new THREE.Color('#35b0d2'); // azure twin — daylight hue drifts between the two
const COLOR_NIGHT = new THREE.Color('#1b5e8a');
const EMISSIVE_NIGHT = new THREE.Color('#0e5560');
const SKY_TINT = 0.2; // how much of the fog/horizon color bleeds into the water

// JS number -> GLSL float literal (guarantees a decimal point so 18 -> "18.0").
const glf = (n) => {
  const s = String(n);
  return /[.e]/.test(s) ? s : `${s}.0`;
};

export default class Water {
  constructor(ctx) {
    this.ctx = ctx;
    this.sky = ctx.systems.sky || null; // sky constructs before water

    const size = Math.max(ctx.config.worldSize * 1.5, 380);

    // --- Geometry -----------------------------------------------------------
    // Rotate the geometry itself into the XZ plane so the position attribute's
    // y component is straight-up world height — keeps the vertex shader's wave
    // math and analytic normals trivially simple (position.x/z ARE world x/z,
    // since the mesh only translates in y).
    const geometry = new THREE.PlaneGeometry(size, size, SEGMENTS, SEGMENTS);
    geometry.rotateX(-Math.PI / 2);

    // --- Shore depth attribute ----------------------------------------------
    // Terrain constructs before water (SYSTEM_ORDER), so we can bake water
    // depth (waterLevel − terrainHeight) into a vertex attribute once and let
    // the fragment shader find the coastline for free. getHeight() returns
    // −100 outside the world bounds, so the open-sea ring reads "very deep"
    // and never foams. If terrain is somehow missing, everything is deep.
    const terrain = ctx.systems.terrain || null;
    const posArr = geometry.getAttribute('position').array;
    const depths = new Float32Array(geometry.getAttribute('position').count);
    for (let i = 0; i < depths.length; i++) {
      const h = terrain && terrain.getHeight
        ? terrain.getHeight(posArr[i * 3], posArr[i * 3 + 2])
        : -100;
      depths[i] = ctx.config.waterLevel - h;
    }
    geometry.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));

    // Waves displace at most (A1+A2+A3+A4)·(1+SWELL_AMP)+A5+A6 ≈ 0.43; pad
    // the bounding sphere once so culling never clips a crest. (The GPU moves
    // the verts, so the CPU-side geometry stays flat forever — this padding
    // is the only thing keeping the frustum test honest.)
    geometry.computeBoundingSphere();
    geometry.boundingSphere.radius += 1;

    // --- Sparkle texture ----------------------------------------------------
    this.sparkleMap = this._makeSparkleTexture();

    // --- Material -----------------------------------------------------------
    this.material = new THREE.MeshStandardMaterial({
      color: COLOR_DAY.clone(),
      map: this.sparkleMap,          // ~20% luminance shimmer over the base
      emissive: EMISSIVE_NIGHT.clone(),
      emissiveMap: this.sparkleMap,  // night glow inherits the caustic pattern
      emissiveIntensity: 0,
      transparent: true,
      opacity: 0.75,
      roughness: 0.15,
      metalness: 0.0,
      depthWrite: false,             // friendlier transparency sorting
      side: THREE.DoubleSide,        // surface must read from below (underwater)
    });

    // Single shared time uniform — created here so update() can write it even
    // before the renderer compiles the program on the first visible frame.
    this._uTime = { value: 0 };
    this.material.onBeforeCompile = (shader) => this._injectWaveShader(shader);
    // three caches programs by material type; without a custom key our
    // injected chunks could be skipped in favor of a cached vanilla standard
    // program (or leak into other MeshStandardMaterials). Pin it.
    this.material.customProgramCacheKey = () => 'magic-world-water';

    // --- Mesh ---------------------------------------------------------------
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = 'water';
    this.mesh.position.y = ctx.config.waterLevel;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1; // draw after opaque world for clean blending
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();

    // --- Underwater veil ------------------------------------------------------
    // Fullscreen tint that fades in when the camera submerges. The fog override
    // colors the world; this veil guarantees the blue wash even where fog
    // can't reach (sky dome, near geometry). Driven per-frame, no transitions.
    this._uwFade = 0;
    this._uwTint = new THREE.Color();
    this._veil = document.createElement('div');
    this._veil.id = 'mw-underwater';
    Object.assign(this._veil.style, {
      position: 'fixed', inset: '0', zIndex: '3', pointerEvents: 'none',
      background:
        'radial-gradient(ellipse at 50% 30%, rgba(46,140,190,0.30) 0%, rgba(13,58,92,0.55) 100%)',
      opacity: '0',
    });
    document.body.appendChild(this._veil);

    // Contract: water must never block build/spell raycasts.
    this.mesh.raycast = () => {};

    ctx.scene.add(this.mesh);

    // Sparkle web rotates almost imperceptibly around its center — kills any
    // residual conveyor-belt feel from the uv scroll.
    this.sparkleMap.center.set(0.5, 0.5);

    // Scratch state (reused every frame — no per-frame allocations).
    this._nightFactor = -1; // force first-frame material refresh
    this._tint = new THREE.Color();
    this._emissiveTint = new THREE.Color();
  }

  // GPU waves + foam + fresnel, injected into the standard shader. The vertex
  // math is the EXACT 6-sine sum (and its closed-form derivatives) the old
  // CPU loop evaluated — same constants, same breathing envelope, same
  // analytic normal — just evaluated per vertex on the GPU instead of 65×65
  // times per frame in JS.
  _injectWaveShader(shader) {
    shader.uniforms.uTime = this._uTime;
    shader.uniforms.uFoamColor = { value: FOAM_COLOR };

    // --- Vertex: displacement + analytic normal -----------------------------
    shader.vertexShader = `
      uniform float uTime;
      attribute float aDepth;
      varying float vDepth;
    ` + shader.vertexShader
      // beginnormal_vertex runs before begin_vertex in the standard shader,
      // so we compute the whole wave here: the analytic normal replaces
      // objectNormal, and the height (wvY) carries over to begin_vertex —
      // both chunks share main()'s scope.
      .replace('#include <beginnormal_vertex>', `
        float wvX = position.x;
        float wvZ = position.z;
        float wvA1 = wvX * ${glf(F1)} + uTime * ${glf(T1)};
        float wvA2 = wvZ * ${glf(F2)} + uTime * ${glf(T2)};
        float wvA3 = (wvX + wvZ) * ${glf(F3)} + uTime * ${glf(T3)};
        float wvA4 = (wvX - wvZ) * ${glf(F4)} + uTime * ${glf(T4)};
        float wvA5 = (wvX * ${glf(SW_X)} + wvZ * ${glf(SW_Z)}) * ${glf(F5)} + uTime * ${glf(T5)};
        float wvA6 = (wvX * ${glf(CH_X)} + wvZ * ${glf(CH_Z)}) * ${glf(F6)} + uTime * ${glf(T6)};
        // Breathing swell: scales heights AND slopes linearly, so the
        // analytic normals stay exact for free.
        float wvEnv = 1.0 + ${glf(SWELL_AMP)} * sin(uTime * ${glf(SWELL_W)});
        float wvY =
          (${glf(A1)} * sin(wvA1) + ${glf(A2)} * sin(wvA2) +
           ${glf(A3)} * sin(wvA3) + ${glf(A4)} * sin(wvA4)) * wvEnv +
          ${glf(A5)} * sin(wvA5) + // the long swell rolls outside the breathing envelope
          ${glf(A6)} * sin(wvA6);  // fine chop glitter on top
        // Closed-form derivatives — exact normals, no finite differences.
        float wvC3 = ${glf(D3)} * cos(wvA3);
        float wvC4 = ${glf(D4)} * cos(wvA4);
        float wvC5 = ${glf(D5)} * cos(wvA5);
        float wvC6 = ${glf(D6)} * cos(wvA6);
        float wvDx = (${glf(D1)} * cos(wvA1) + wvC3 + wvC4) * wvEnv + wvC5 * ${glf(SW_X)} + wvC6 * ${glf(CH_X)};
        float wvDz = (${glf(D2)} * cos(wvA2) + wvC3 - wvC4) * wvEnv + wvC5 * ${glf(SW_Z)} + wvC6 * ${glf(CH_Z)};
        float wvInv = inversesqrt(wvDx * wvDx + wvDz * wvDz + 1.0);
        vec3 objectNormal = vec3(-wvDx * wvInv, wvInv, -wvDz * wvInv);
        vDepth = aDepth;
      `)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position.x, position.y + wvY, position.z);
      `);

    // --- Fragment: shoreline foam + fresnel ----------------------------------
    shader.fragmentShader = `
      uniform float uTime;
      uniform vec3 uFoamColor;
      varying float vDepth;
    ` + shader.fragmentShader
      .replace('#include <map_fragment>', `
        #include <map_fragment>
        #ifdef USE_MAP
        // Shoreline foam — a soft ribbon where the water is shallow. The band
        // laps in and out with a slow traveling sine, and the caustic sparkle
        // map (scrolled on its own course so it never locks to the surface
        // shimmer) breaks it into painterly flecks rather than a hard stripe.
        float foamShore = 1.0 - smoothstep(0.0, ${glf(FOAM_DEPTH)}, max(vDepth, 0.0));
        float foamLap = 0.72 + 0.28 * sin(vDepth * 7.0 - uTime * 1.5);
        float foamFleck = smoothstep(0.55, 0.95,
          texture2D(map, vMapUv * 0.7 + vec2(uTime * 0.021, uTime * -0.017)).g);
        float foam = foamShore * foamLap * (0.6 + 0.4 * foamFleck);
        // Blend capped at 0.85 so the crest stays #eafaf4-toned, never pure
        // white; foam also reads more solid than open water.
        diffuseColor.rgb = mix(diffuseColor.rgb, uFoamColor, foam * 0.85);
        diffuseColor.a = mix(diffuseColor.a, 0.92, foam);
        #endif
      `)
      .replace('#include <opaque_fragment>', `
        // Fresnel — grazing views firm up (a touch more opacity + a faint
        // foam-toned sheen), top-down views stay dreamily translucent. Kept
        // subtle: ~0.70 looking straight down, capped at 0.93 at the horizon,
        // around the 0.75 breathing baseline — glassy, never mirror-like.
        float fresCos = clamp(dot(normalize(vViewPosition), normalize(vNormal)), 0.0, 1.0);
        float fres = pow(1.0 - fresCos, 3.0);
        diffuseColor.a = clamp(diffuseColor.a - 0.05 + fres * 0.24, 0.0, 0.93);
        outgoingLight += fres * 0.08 * uFoamColor;
        #include <opaque_fragment>
      `);
  }

  // Seamlessly tiling caustic-noise texture: soft fbm "light web" plus a
  // scattering of hard bright glint pixels. Built once at init.
  _makeSparkleTexture() {
    const size = SPARKLE_SIZE;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    const img = g.createImageData(size, size);
    const data = img.data;

    const noise = createNoise2D(20260611);
    const opts = { octaves: 3, lacunarity: 2.1, gain: 0.55, scale: 1 / 17 };
    const sample = (x, y) => fbm(noise, x, y, opts);

    // Standard 4-corner cross-blend makes any noise tile seamlessly.
    for (let y = 0; y < size; y++) {
      const wy = y / size;
      for (let x = 0; x < size; x++) {
        const wx = x / size;
        const v =
          sample(x, y) * (1 - wx) * (1 - wy) +
          sample(x - size, y) * wx * (1 - wy) +
          sample(x, y - size) * (1 - wx) * wy +
          sample(x - size, y - size) * wx * wy;

        // Ridge the noise into thin bright filaments (caustic look), then
        // keep the whole field within ~±20% of white so map-multiply only
        // shimmers the base color instead of darkening it.
        const ridge = 1 - Math.abs(v);            // [0,1], peaks at v == 0
        const lum = Math.round(204 + Math.pow(ridge, 3) * 51); // 204..255
        const i = (y * size + x) * 4;
        data[i] = lum;
        data[i + 1] = lum;
        data[i + 2] = lum;
        data[i + 3] = 255;
      }
    }

    // Hard glints — tiny full-white sparks, wrapped so tiling stays seamless.
    const rand = mulberry32(9001);
    for (let s = 0; s < 130; s++) {
      const sx = Math.floor(rand() * size);
      const sy = Math.floor(rand() * size);
      const put = (px, py) => {
        const i = (((py + size) % size) * size + ((px + size) % size)) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      };
      put(sx, sy);
      if (rand() < 0.45) put(sx + 1, sy); // a few 2px glints read brighter
    }

    g.putImageData(img, 0, 0);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(SPARKLE_REPEAT, SPARKLE_REPEAT);
    return texture;
  }

  update(dt, elapsed) {
    // --- Waves ---------------------------------------------------------------
    // The 6-sine displacement and its analytic normals live in the vertex
    // shader now (see _injectWaveShader) — the whole animation costs one
    // uniform write per frame.
    this._uTime.value = elapsed;

    // --- Scrolling sparkle ---------------------------------------------------
    // The scroll meanders slightly instead of marching in a straight line, so
    // the caustic web never reads as a conveyor belt.
    const off = this.sparkleMap.offset;
    off.x = (elapsed * SCROLL_U + 0.012 * Math.sin(elapsed * 0.05)) % 1;
    off.y = (elapsed * SCROLL_V + 0.012 * Math.cos(elapsed * 0.041)) % 1;

    // --- Day / night tint, kissed by the sky ---------------------------------
    const sky = this.sky || (this.sky = this.ctx.systems.sky || null);
    const sun = sky && sky.getSunIntensity ? sky.getSunIntensity() : 1;
    const target = 1 - Math.max(0, Math.min(1, sun));
    // Ease toward the target so time-warps don't pop the water color.
    let night = this._nightFactor;
    if (night < 0) night = target;
    night += (target - night) * Math.min(1, dt * 2.5);
    this._nightFactor = night;

    // Daylight hue drifts dreamily between lagoon teal and clear azure over
    // ~2.5 min, then ramps toward deep night blue and finally bleeds a little
    // of the live fog/horizon color in — dawn turns the water rose-gold,
    // dusk ember, night indigo.
    const hueDrift = 0.5 + 0.5 * Math.sin(elapsed * 0.042);
    const col = this._tint.lerpColors(COLOR_DAY, COLOR_DAY_B, hueDrift);
    col.lerp(COLOR_NIGHT, night);
    const fog = this.ctx.scene.fog;
    if (fog && fog.color) col.lerp(fog.color, SKY_TINT);
    this.material.color.copy(col);

    // Night glow: moonlit teal shimmer with a slow ~7 s pulse, its color
    // kissed by the sky so aurora nights tint the sea.
    if (fog && fog.color) {
      this.material.emissive.copy(this._emissiveTint.copy(EMISSIVE_NIGHT).lerp(fog.color, 0.25));
    }
    this.material.emissiveIntensity = night * (0.38 + 0.07 * Math.sin(elapsed * 0.9));

    // Glassier surface after dark — moon and crystal glints sharpen.
    this.material.roughness = 0.15 - 0.07 * night;

    // Barely-there opacity breathing (0.73–0.77) keeps the surface dreamlike.
    this.material.opacity = 0.75 + 0.02 * Math.sin(elapsed * 0.23);

    // --- Underwater veil -------------------------------------------------------
    // Camera below the surface → push the world into lagoon blue: dense blue
    // fog (overrides Sky's per-frame write — we run after it) + screen tint.
    const cam = this.ctx.camera;
    const submerged = cam && cam.position.y < this.ctx.config.waterLevel;
    let fade = this._uwFade;
    fade += ((submerged ? 1 : 0) - fade) * Math.min(1, dt * 8); // ~0.3 s ease
    if (fade < 0.001) fade = 0;
    this._uwFade = fade;

    if (fade > 0 && fog && fog.color) {
      const uw = this._uwTint.lerpColors(UNDERWATER_COLOR, UNDERWATER_COLOR_NIGHT, night);
      fog.color.lerp(uw, fade);
      fog.density += (UNDERWATER_FOG_DENSITY - fog.density) * fade;
    }
    // One style write per frame, skipped entirely while fully surfaced.
    const veilOpacity = (fade * 100 | 0) / 100;
    if (veilOpacity !== this._veilOpacity) {
      this._veilOpacity = veilOpacity;
      this._veil.style.opacity = String(veilOpacity);
    }
  }
}
