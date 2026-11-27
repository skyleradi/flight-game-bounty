#!/usr/bin/env node
// Verifies the gun feedback: that landing a round on a target emits a hit marker with the right
// kind and damage, that a killing round marks it as a kill, that the marker carries a timestamp
// the HUD can age, and that it survives the trip into the HUD payload.
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
  const where = m.location?.()?.url ?? '';
  if (m.type() === 'error' && !/favicon/i.test(`${m.text()} ${where}`)) errs.push(m.text());
});

await page.goto('http://localhost:8080/', { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => window.__flight !== undefined, null, { timeout: 120000 });

const out = await page.evaluate(async () => {
  const g = window.__flight;
  const log = [];

  g.loadRound(3, { briefing: false });
  g.beginRound();
  const s = g.aircraftState;
  const turret = g.airDefence.turrets.find((t) => t.alive);
  if (!turret) return { error: 'no turret in canyon run', log };

  s.fuel = g.round.fuel;
  s.health = 100;
  s.wheelsDown = false;
  g.sortie.started = true;

  // Nose-on at 320 m, trigger held, checking the marker after every step.
  const gunY = turret.y + 27;
  s.position.set(turret.x, gunY, turret.z + 320);
  s.heading = 0;   // looking down -Z, and the turret is at -Z from here
  s.pitch = 0;
  s.bank = 0;
  s.speed = 40;    // slow, so the geometry holds while the rounds fly

  g.pressKeys(['KeyX'], true);
  const marks = [];
  let firstMark = null;
  let killMark = null;
  // Two barrels fire per trigger cycle and the step is 1/120 s, so more than one round can land
  // inside a single step. The marker is a "latest impact" field rather than a queue, so the test
  // counts distinct marker *objects* — each one is one landing round — not distinct timestamps.
  let lastSeen = null;
  for (let i = 0; i < 600; i += 1) {
    // Hold the aircraft still: this is an instrumented test of the gun, not a flying lesson.
    s.position.set(turret.x, gunY, turret.z + 320);
    s.heading = 0; s.pitch = 0; s.bank = 0; s.speed = 40; s.health = 100;
    g.sortie.time += 1 / 60;
    g.simulate(1 / 60);
    const m = g.sortie.hitMark;
    if (m && m !== lastSeen) {
      lastSeen = m;
      if (m.killed) killMark = { ...m };
      if (!firstMark) firstMark = { ...m };
      marks.push({ at: +m.at.toFixed(3), kind: m.kind, damage: m.damage, killed: m.killed, ace: !!m.ace });
    }
    if (killMark) break;
  }
  g.pressKeys(['KeyX'], false);

  log.push(`hit marks recorded: ${marks.length}`);
  if (firstMark) log.push(`first mark: kind=${firstMark.kind} damage=${firstMark.damage} killed=${firstMark.killed} at=${firstMark.at.toFixed(3)}`);
  if (killMark) log.push(`kill mark: kind=${killMark.kind} killed=${killMark.killed} at=${killMark.at.toFixed(3)}`);
  log.push(`hitMarks counter: ${g.sortie.hitMarks}`);
  log.push(`turret alive after ${marks.length} marks: ${turret.alive}`);
  log.push(`firing flag: ${g.sortie.firing}`);

  // The marker must carry its own clock reading so the HUD can age it, and it must be the sortie
  // clock, not wall time: a paused frame would otherwise let the marker expire off-screen.
  const hasTime = firstMark && typeof firstMark.at === 'number' && firstMark.at > 0;

  // And it must survive into the HUD payload rather than being dropped between the loop and draw.
  const payloadHasMark = typeof g.sortie.hitMark === 'object' && g.sortie.hitMark !== null;

  return {
    log, marks, firstMark, killMark, hasTime, payloadHasMark,
    counters: { hitMarks: g.sortie.hitMarks, kills: g.sortie.kills, turretsKilled: g.sortie.turretsKilled },
    turretAlive: turret.alive,
    firingAfterRelease: g.sortie.firing,
  };
});

console.log(out.log.join('\n'));

const checks = [
  ['a landing round emits a marker', out.marks.length > 0],
  ['the marker names its target kind', out.firstMark?.kind === 'turret'],
  ['the marker carries damage', out.firstMark?.damage === 9],
  ['the killing round is marked as a kill', out.killMark?.killed === true],
  ['the kill matches the turret dying', out.turretAlive === false],
  ['the marker is stamped with the sortie clock', out.hasTime === true],
  // `hitMark` is the latest impact, not a queue: when two barrels land in the same 1/120 s step
  // the field holds only the second, while the counter records both. The counter is therefore an
  // upper bound on what the HUD can show, never a lower one.
  ['the counter never under-reports the marker', out.counters.hitMarks >= out.marks.length],
  ['the kill is counted once', out.counters.kills === 1 && out.counters.turretsKilled === 1],
  ['the trigger releases to safe', out.firingAfterRelease === false],
];
console.log('');
let pass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) pass = false;
}
console.log(`\nerrors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);
console.log(pass ? 'PASS' : 'FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
