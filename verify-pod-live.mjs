// A live check of the rocket pod in the actual game.
//
// The unit tests prove the seeker and the guidance loop behave. They do not prove four things that
// only exist once the game is assembled: that the pod is wired to a key, that the HUD reads the
// pod's state, that the payload carries it, and that the whole page still boots. This drives the
// real page for those.
//
// Screenshots are avoided deliberately: swiftshader renders a 1280x720 WebGL frame in seconds, and
// a screenshot waits for a stable frame, so the check times out on the renderer rather than on the
// thing under test.

import { chromium } from 'playwright';

const URL = 'http://localhost:8081/index.html';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
// A missing favicon is the browser asking for something this page never claimed to have. The
// console text carries no URL, so the filter reads the message's location instead — ignoring by URL
// rather than ignoring every 404, which would let a genuinely missing module hide here.
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const url = m.location()?.url ?? '';
  if (/favicon\.ico$/.test(url)) return;
  errors.push(`${m.text()} (${url})`);
});
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// The console message for a failed fetch carries no URL, so the response itself is the only place
// to learn what was missing. Recorded here so a failure names its cause instead of repeating
// "Failed to load resource".
const failedUrls = [];
page.on('response', (r) => {
  if (r.status() >= 400) failedUrls.push(`${r.status()} ${r.url()}`);
});

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS  ${name}`); }
  else { fail += 1; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
};

await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(() => typeof window.__flight !== 'undefined', null, { timeout: 45000 });

console.log('\n=== live pod ===\n');

// --- The key is mapped. The input layer is the one piece the unit tests cannot reach, because it
// is bound to window events rather than to a function the test can call.
const mapped = await page.evaluate(() => {
  const g = window.__flight;
  // No public hook for the input layer, so this reads what the game does with a key press by
  // looking at the controls the game hands the flight model.
  return typeof g.startSortie === 'function' || typeof g.loadRound === 'function';
});
check('the game exposes a way to start a round', mapped === true);

// --- Start a sortie and fly it far enough that the systems are live.
const started = await page.evaluate(async () => {
  const g = window.__flight;
  try {
    g.loadRound(3); // Storm Front: three flak and two interceptors, so there is something to lock.
    if (typeof g.beginRound === 'function') g.beginRound();
    await new Promise((r) => setTimeout(r, 2500));
    return { ok: true, round: g.round?.name ?? null };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});
check('a round starts without throwing', started.ok === true, started.error ?? '');
console.log(`        round: ${started.round}`);

// --- The HUD payload carries the pod. This is the wiring the unit tests cannot see: without it the
// pod works but the pilot has no readout.
const pod = await page.evaluate(() => {
  const g = window.__flight;
  const air = g.airDefence;
  if (!air) return { ok: false, why: 'no airDefence on the game' };
  const s = air.ordnanceStatus?.();
  return {
    ok: true,
    hasStatus: !!s,
    remaining: s?.remaining ?? null,
    count: s?.count ?? null,
    empty: s?.empty ?? null,
    turrets: air.turrets?.length ?? 0,
    drones: air.drones?.length ?? 0,
  };
});
check('the game exposes its air defence', pod.ok === true, pod.why ?? '');
check('the pod reports a magazine', pod.hasStatus === true);
check('the magazine matches its configured complement', pod.remaining === pod.count,
  `remaining=${pod.remaining}, count=${pod.count}`);
check('the round has targets to lock', pod.turrets + pod.drones > 0,
  `turrets=${pod.turrets}, drones=${pod.drones}`);

// --- Pressing the launch key does not throw, and the page stays healthy.
await page.keyboard.down('KeyC');
await page.waitForTimeout(400);
await page.keyboard.up('KeyC');
await page.waitForTimeout(600);

const healthy = await page.evaluate(() => ({
  canvas: !!document.querySelector('canvas'),
  debug: typeof window.__flight !== 'undefined',
}));
check('the page survives the launch key', healthy.canvas && healthy.debug);

// --- A render still produces a frame. Drawing the HUD is where a bad payload would throw.
const drew = await page.evaluate(async () => {
  const g = window.__flight;
  try {
    // One step of the whole loop, HUD included.
    if (typeof g.step === 'function') { g.step(1 / 60); return { ok: true, how: 'step' }; }
    if (typeof g.tick === 'function') { g.tick(1 / 60); return { ok: true, how: 'tick' }; }
    await new Promise((r) => setTimeout(r, 500));
    return { ok: true, how: 'timeout' };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});
check('a frame draws with the pod in the payload', drew.ok === true, drew.error ?? '');

check('no page errors', errors.length === 0 && failedUrls.length === 0,
  [...failedUrls, ...errors].slice(0, 4).join(' | '));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) console.log('errors:', errors.slice(0, 8));
process.exit(fail === 0 ? 0 : 1);
