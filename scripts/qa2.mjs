// Functional smoke test: exercise build/spell/creature systems in-engine, then screenshot.
import puppeteer from 'puppeteer-core';

const URL = process.env.QA_URL || 'http://localhost:5199';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--user-data-dir=/tmp/magic-world-qa-profile'],
  defaultViewport: { width: 1440, height: 810 },
});
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 6000));

const result = await page.evaluate(async () => {
  const g = window.__game;
  const out = { steps: [], errors: [] };
  const step = (name, fn) => {
    try { fn(); out.steps.push(name + ': ok'); }
    catch (e) { out.steps.push(name + ': FAIL ' + e.message); out.errors.push(name + ': ' + e.message); }
  };
  // fake pointer lock so gameplay systems are active
  const canvas = document.querySelector('#app canvas');
  Object.defineProperty(document, 'pointerLockElement', { get: () => canvas, configurable: true });
  document.dispatchEvent(new Event('pointerlockchange'));

  const T = g.systems.terrain;
  const h = (x, z) => T.getHeight(x, z);

  step('conjure tower prefab', () => {
    const v = new (Object.getPrototypeOf(g.camera.position).constructor)(10, h(10, -6), -6);
    g.systems.build.placePrefab('tower', v);
  });
  step('place blocks', () => {
    for (let i = 0; i < 4; i++) g.systems.build.placeBlock(2 + i, Math.ceil(h(2 + i, 2)), 2, 'crystal', { animate: true });
  });
  step('summon golem', () => {
    const v = new (Object.getPrototypeOf(g.camera.position).constructor)(-5, h(-5, 0), 0);
    g.systems.golems.spawn(v);
  });
  step('grow trees', () => {
    const V = Object.getPrototypeOf(g.camera.position).constructor;
    g.systems.vegetation.spawnTree(new V(-3, h(-3, -8), -8), { magical: true, animate: true });
    g.systems.vegetation.spawnTree(new V(4, h(4, -10), -10), { magical: true, animate: true, scale: 1.3 });
  });
  step('particles burst', () => {
    const V = Object.getPrototypeOf(g.camera.position).constructor;
    g.systems.particles.burst({ position: new V(0, h(0, -5) + 3, -5), color: 0xff66ff, count: 80, speed: 8, life: 2 });
  });
  step('terraform', () => T.modify(15, 10, 2.0, 6));
  step('save/load roundtrip', () => { g.systems.save.save(); g.systems.save.load(); });
  // aim the camera at the action
  step('aim camera', () => {
    g.systems.player.position.set(-2, h(-2, 14) + 0.2, 14);
    g.systems.player.yaw = -0.35; g.systems.player.pitch = -0.08;
  });
  return out;
});

await new Promise((r) => setTimeout(r, 2500)); // let animations play
await page.screenshot({ path: '/tmp/magic-world-action.png' });
const finalErrors = await page.evaluate(() => window.__gameErrors || []);
console.log(JSON.stringify({ result, finalErrors, consoleErrors }, null, 2));
await browser.close();
