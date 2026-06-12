import * as THREE from 'three';
import EventBus from './core/EventBus.js';
import Input from './core/Input.js';
import Sky from './world/Sky.js';
import Terrain from './world/Terrain.js';
import Water from './world/Water.js';
import FloatingIslands from './world/FloatingIslands.js';
import Vegetation from './world/Vegetation.js';
import Fireflies from './world/Fireflies.js';
import Particles from './fx/Particles.js';
import PlayerController from './player/PlayerController.js';
import BuildSystem from './build/BuildSystem.js';
import SpellManager from './magic/SpellManager.js';
import Wisps from './creatures/Wisps.js';
import Golems from './creatures/Golem.js';
import Unicorns from './creatures/Unicorns.js';
import AudioEngine from './audio/AudioEngine.js';
import HUD from './ui/HUD.js';
import Menus from './ui/Menus.js';
import Minimap from './ui/Minimap.js';
import SaveSystem from './save/SaveSystem.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false; // throttled to every other frame in the loop (sun moves slowly)
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.getElementById('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1200);

const events = new EventBus();
const input = new Input(renderer.domElement, events);

const ctx = {
  scene,
  camera,
  renderer,
  domElement: renderer.domElement,
  events,
  input,
  systems: {},
  config: {
    worldSize: 240,
    terrainRes: 160,
    heightScale: 18,
    waterLevel: 1.2,
    gravity: 24,
    daySeconds: 600,
  },
  time: { elapsed: 0, dt: 0 },
  perf: { pixelRatio: Math.min(window.devicePixelRatio, 2), emaMs: 16 },
};

const SYSTEM_ORDER = [
  ['sky', Sky],
  ['terrain', Terrain],
  ['water', Water],
  ['islands', FloatingIslands],
  ['vegetation', Vegetation],
  ['fireflies', Fireflies],
  ['particles', Particles],
  ['player', PlayerController],
  ['build', BuildSystem],
  ['spells', SpellManager],
  ['wisps', Wisps],
  ['golems', Golems],
  ['unicorns', Unicorns],
  ['audio', AudioEngine],
  ['hud', HUD],
  ['menus', Menus],
  ['minimap', Minimap],
  ['save', SaveSystem],
];

for (const [name, SystemClass] of SYSTEM_ORDER) {
  try {
    ctx.systems[name] = new SystemClass(ctx);
  } catch (err) {
    console.error(`[magic-world] failed to construct system "${name}"`, err);
    window.__gameErrors?.push(`construct ${name}: ${err.message}`);
  }
}

// Adaptive resolution: the game is fill-rate bound, so step pixelRatio in 0.25
// increments based on an EMA of frame time. Hysteresis: at most one step per 2s.
const PERF = {
  scaleMin: 1.0,
  scaleMax: Math.min(window.devicePixelRatio, 2),
  stepDownMs: 22, // EMA above this → lower resolution
  stepUpMs: 12,   // EMA below this (and headroom) → raise resolution
  intervalMs: 2000,
};
let lastScaleCheck = performance.now();

function applyPixelRatio(ratio) {
  ctx.perf.pixelRatio = ratio;
  renderer.setPixelRatio(ratio);
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  applyPixelRatio(ctx.perf.pixelRatio); // respect the adaptive ratio, not the hardcoded cap
});

let last = performance.now();
let frame = 0;
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const rawMs = now - last;
  const dt = Math.min(rawMs / 1000, 0.05);
  last = now;
  ctx.time.dt = dt;
  ctx.time.elapsed += dt;

  // smooth frame time (EMA, alpha 0.05 ≈ ~1s memory at 60fps)
  ctx.perf.emaMs += (rawMs - ctx.perf.emaMs) * 0.05;
  if (now - lastScaleCheck >= PERF.intervalMs) {
    lastScaleCheck = now;
    const { emaMs, pixelRatio } = ctx.perf;
    let next = pixelRatio;
    if (emaMs > PERF.stepDownMs && pixelRatio > PERF.scaleMin) {
      next = Math.max(PERF.scaleMin, pixelRatio - 0.25);
    } else if (emaMs < PERF.stepUpMs && pixelRatio < PERF.scaleMax) {
      next = Math.min(PERF.scaleMax, pixelRatio + 0.25);
    }
    if (next !== pixelRatio) {
      applyPixelRatio(next);
      console.info(`[magic-world] adaptive resolution: pixelRatio ${pixelRatio} -> ${next} (ema ${emaMs.toFixed(1)}ms)`);
    }
  }

  // half-rate shadow updates — the sun moves slowly, every other frame is imperceptible
  frame++;
  renderer.shadowMap.needsUpdate = (frame & 1) === 0;
  for (const [name] of SYSTEM_ORDER) {
    const system = ctx.systems[name];
    if (!system || !system.update) continue;
    try {
      system.update(dt, ctx.time.elapsed);
    } catch (err) {
      console.error(`[magic-world] update error in "${name}"`, err);
      window.__gameErrors?.push(`update ${name}: ${err.message}`);
      system.update = null; // disable the broken system instead of spamming every frame
    }
  }
  renderer.render(scene, camera);
});

// expose for QA / debugging
window.__game = ctx;
