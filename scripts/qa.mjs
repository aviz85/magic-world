// Headless QA: load the game, collect errors, screenshot title + in-game.
import puppeteer from 'puppeteer-core';

const URL = process.env.QA_URL || 'http://localhost:5199';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--window-size=1440,810',
    '--user-data-dir=/tmp/magic-world-qa-profile',
  ],
  defaultViewport: { width: 1440, height: 810 },
});

const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + String(e).slice(0, 300)));

await page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 });
await new Promise((r) => setTimeout(r, 7000)); // let the world generate + a few frames render

const state = await page.evaluate(() => ({
  gameErrors: window.__gameErrors || ['__gameErrors missing'],
  systems: Object.keys(window.__game?.systems || {}),
  sceneChildren: window.__game?.scene?.children?.length ?? -1,
  drawCalls: window.__game?.renderer?.info?.render?.calls ?? -1,
  triangles: window.__game?.renderer?.info?.render?.triangles ?? -1,
  playerPos: window.__game?.systems?.player?.position
    ? { ...['x', 'y', 'z'].reduce((o, k) => ((o[k] = +window.__game.systems.player.position[k].toFixed(1)), o), {}) }
    : null,
  timeOfDay: window.__game?.systems?.sky?.timeOfDay ?? null,
  spellCount: window.__game?.systems?.spells?.getState?.().spells?.length ?? -1,
  mana: window.__game?.systems?.spells?.getState?.().mana ?? -1,
}));

await page.screenshot({ path: '/tmp/magic-world-title.png' });

// Simulate entering the game: fake pointer lock so the HUD/world is visible without a user gesture.
await page.evaluate(() => {
  const canvas = document.querySelector('#app canvas');
  Object.defineProperty(document, 'pointerLockElement', { get: () => canvas, configurable: true });
  document.dispatchEvent(new Event('pointerlockchange'));
});
await new Promise((r) => setTimeout(r, 1200));

// Cast a fireball + place a glance at the world: look slightly down, then screenshot.
const state2 = await page.evaluate(() => {
  const game = window.__game;
  try {
    if (game?.systems?.player) game.systems.player.pitch = -0.15;
  } catch {}
  return { locked: game?.input?.pointerLocked ?? 'unknown' };
});
await new Promise((r) => setTimeout(r, 1500));
await page.screenshot({ path: '/tmp/magic-world-ingame.png' });

const finalErrors = await page.evaluate(() => window.__gameErrors || []);

console.log(JSON.stringify({ state, state2, consoleErrors: consoleErrors.slice(0, 20), finalErrors }, null, 2));
await browser.close();
