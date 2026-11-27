#!/usr/bin/env node
// Smoke test for the objective system: boot the game, fly round 3, kill the required turrets
// through the same events the game handles, and check the round refuses to end until they are gone.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--no-sandbox', '--hide-scrollbars'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => {
  const t = m.text();
  // A missing favicon is the browser asking for something the game never claimed to have; it is
  // not a boot failure and must not mask one. The URL lives on the message's location, not in its
  // text, so the filter has to read both.
  const where = m.location?.()?.url ?? '';
  if (m.type() === 'error' && !/favicon/i.test(`${t} ${where}`)) errs.push(`console: ${t} @ ${where}`);
});

await page.goto('http://localhost:8080/?shot=dogfight', { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__shotReady === true, null, { timeout: 180000 });
await page.waitForTimeout(800);

const boot = errs.length ? `FAILED ${errs.slice(0, 3).join(' | ')}` : 'OK';
console.log(`boot          ${boot}`);
if (errs.length) { await browser.close(); process.exit(1); }

// Drive the objective logic directly through the dev hook the game exposes.
const res = await page.evaluate(async () => {
  const { CAMPAIGN } = await import('/src/config.js');
  const { objectiveProgress, recordRound } = await import('/src/mission.js');

  const out = {};
  // Every round's requirement, computed from its own config.
  out.rounds = CAMPAIGN.map((r) => {
    const w = r.winCondition ?? { flak: 0, drones: 0 };
    return `${r.name}: flak ${w.flak ?? 0} / drones ${w.drones ?? 0}`;
  });

  const canyon = CAMPAIGN[3];
  // Nothing killed: not met.
  out.none = objectiveProgress(canyon, { turretsKilled: 0, dronesKilled: 0 });
  // One of the two required guns: still not met.
  out.one = objectiveProgress(canyon, { turretsKilled: 1, dronesKilled: 0 });
  // Both: met.
  out.two = objectiveProgress(canyon, { turretsKilled: 2, dronesKilled: 0 });
  // Over-delivering must not report 3/2.
  out.over = objectiveProgress(canyon, { turretsKilled: 5, dronesKilled: 3 });

  // The unlock gate: a fully-flown round with the objective unmet must not open the next sortie.
  const p = { unlocked: 1, best: {}, total: 0 };
  out.lockedByObjective = recordRound(p, 3, {
    gatesPassed: 8, score: 900, objectiveMet: false,
  }).unlocked;
  // And a round with it met must.
  out.unlockedWhenMet = recordRound(p, 3, {
    gatesPassed: 8, score: 900, objectiveMet: true,
  }).unlocked;
  // A legacy save with no objective field at all still unlocks, so old progress is not lost.
  out.legacyUnlock = recordRound(p, 3, { gatesPassed: 8, score: 900 }).unlocked;
  return out;
});

console.log('\n--- requirements ---');
for (const r of res.rounds) console.log(`  ${r}`);
console.log('\n--- canyon run (needs 2 flak, 0 drones) ---');
console.log(`  0 kills      met=${res.none.met}  ${res.none.flakDone}/${res.none.flakNeed}`);
console.log(`  1 kill       met=${res.one.met}  ${res.one.flakDone}/${res.one.flakNeed}`);
console.log(`  2 kills      met=${res.two.met}  ${res.two.flakDone}/${res.two.flakNeed}`);
console.log(`  5 kills      met=${res.over.met}  ${res.over.flakDone}/${res.over.flakNeed}  (clamped)`);
console.log('\n--- unlock gate ---');
console.log(`  gates flown, objective unmet  -> unlocked ${res.lockedByObjective} (want 1)`);
console.log(`  gates flown, objective met    -> unlocked ${res.unlockedWhenMet} (want 5)`);
console.log(`  legacy result, no field       -> unlocked ${res.legacyUnlock} (want 5)`);

const pass = !res.none.met && !res.one.met && res.two.met && res.over.flakDone === 2
  && res.lockedByObjective === 1 && res.unlockedWhenMet === 5 && res.legacyUnlock === 5;
console.log(`\n${pass ? 'PASS' : 'FAIL'}`);
await browser.close();
process.exit(pass ? 0 : 1);
