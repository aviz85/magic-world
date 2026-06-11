/**
 * Noise.js — seeded PRNG + 2D gradient noise + fractal Brownian motion.
 *
 * Used by Terrain, FloatingIslands, Vegetation and Water to sculpt the island.
 * Everything here is deterministic per seed and allocation-free per call:
 * `createNoise2D` builds its permutation/gradient tables once, and the
 * returned sampler touches only locals + typed arrays. Safe to call
 * hundreds of thousands of times during world-gen and in per-frame code.
 */

/**
 * mulberry32 — tiny, high-quality 32-bit seeded PRNG.
 * Returns a function producing floats in [0, 1).
 *
 * @param {number} seed - any number; truncated to uint32.
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Gradient table — 16 unit vectors around the circle. More directions than
// classic Perlin's 8 → fewer axis-aligned artifacts, nicer organic ridges.
// Stored flat as [x0, y0, x1, y1, ...] in a Float32Array for cache locality.
// ---------------------------------------------------------------------------
const GRAD_COUNT = 16;
const GRADS = new Float32Array(GRAD_COUNT * 2);
for (let i = 0; i < GRAD_COUNT; i++) {
  const angle = (i / GRAD_COUNT) * Math.PI * 2;
  GRADS[i * 2] = Math.cos(angle);
  GRADS[i * 2 + 1] = Math.sin(angle);
}

// Perlin-style 2D noise with unit gradients has a theoretical max amplitude
// of sqrt(2)/2 ≈ 0.7071; scale results back up so output genuinely spans
// [-1, 1] (matters for terrain height bands & threshold masks).
const NORMALIZE_2D = Math.SQRT2;

/**
 * createNoise2D — classic permutation-table gradient ("Perlin") noise.
 *
 * Smooth, band-limited, organic. NOT white noise: values vary continuously,
 * zero at integer lattice points' mean, C2-continuous thanks to the quintic
 * fade curve (6t^5 - 15t^4 + 10t^3).
 *
 * @param {number} [seed=1337]
 * @returns {(x: number, y: number) => number} sampler returning floats in [-1, 1].
 */
export function createNoise2D(seed = 1337) {
  // Build a seeded permutation of 0..255, doubled to avoid wrap masking
  // on the second lookup. Fisher–Yates with mulberry32 keeps it deterministic.
  const rand = mulberry32(seed);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];

  /**
   * Sample the noise field at (x, y). Allocation-free.
   */
  return function noise2D(x, y) {
    // Lattice cell coords (floor that also works for negatives).
    let xi = Math.floor(x);
    let yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    xi &= 255;
    yi &= 255;

    // Quintic fade — C2 continuity, no visible lattice creases.
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);

    // Hash the four cell corners through the permutation table.
    const aa = perm[perm[xi] + yi] & (GRAD_COUNT - 1);
    const ba = perm[perm[xi + 1] + yi] & (GRAD_COUNT - 1);
    const ab = perm[perm[xi] + yi + 1] & (GRAD_COUNT - 1);
    const bb = perm[perm[xi + 1] + yi + 1] & (GRAD_COUNT - 1);

    // Dot products of corner gradients with distance vectors.
    const g00 = GRADS[aa * 2] * xf + GRADS[aa * 2 + 1] * yf;
    const g10 = GRADS[ba * 2] * (xf - 1) + GRADS[ba * 2 + 1] * yf;
    const g01 = GRADS[ab * 2] * xf + GRADS[ab * 2 + 1] * (yf - 1);
    const g11 = GRADS[bb * 2] * (xf - 1) + GRADS[bb * 2 + 1] * (yf - 1);

    // Bilinear blend along the faded axes.
    const nx0 = g00 + u * (g10 - g00);
    const nx1 = g01 + u * (g11 - g01);
    let value = (nx0 + v * (nx1 - nx0)) * NORMALIZE_2D;

    // Guard against the rare >1 overshoot from normalization rounding.
    if (value > 1) value = 1;
    else if (value < -1) value = -1;
    return value;
  };
}

/**
 * fbm — fractal Brownian motion: layered octaves of gradient noise.
 *
 * Each octave doubles (× lacunarity) the frequency and halves (× gain) the
 * amplitude, then the sum is renormalized so output stays ~[-1, 1]
 * regardless of octave count.
 *
 * @param {(x: number, y: number) => number} noise2D - sampler from createNoise2D.
 * @param {number} x
 * @param {number} y
 * @param {object} [opts]
 * @param {number} [opts.octaves=4]    layers of detail.
 * @param {number} [opts.lacunarity=2] frequency multiplier per octave.
 * @param {number} [opts.gain=0.5]     amplitude multiplier per octave.
 * @param {number} [opts.scale=1]      base coordinate scale (e.g. 1/55 for broad hills).
 * @returns {number} float in ~[-1, 1].
 */
export function fbm(noise2D, x, y, { octaves = 4, lacunarity = 2, gain = 0.5, scale = 1 } = {}) {
  let frequency = scale;
  let amplitude = 1;
  let sum = 0;
  let totalAmplitude = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2D(x * frequency, y * frequency) * amplitude;
    totalAmplitude += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }
  return totalAmplitude > 0 ? sum / totalAmplitude : 0;
}
