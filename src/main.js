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

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let last = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  ctx.time.dt = dt;
  ctx.time.elapsed += dt;
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
