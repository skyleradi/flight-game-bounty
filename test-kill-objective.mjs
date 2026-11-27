#!/usr/bin/env node
// End-to-end test of the kill objective through the real game loop.
//
// Boots round 4 (CANYON RUN, which needs two rim guns down), then:
//   1. flies the aircraft straight at a live turret and holds the trigger until it dies;
//   2. checks the round still refuses to end with only one of two guns down;
//   3. kills the second and checks the requirement clears;
//   4. checks a landing with the requirement unmet is refused, and with it met is accepted.
//
// Nothing here calls the objective helper directly — the point is that the loop, the event
// handler, the HUD payload and the end-of-round test all agree.
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
  const round = g.round;

  log.push(`round: ${round.name}, needs ${round.winCondition.flak} flak`);

  // Put the pilot in the air, alive, with time and fuel to work with.
  s.fuel = round.fuel;
  s.health = 100;
  s.destroyed = false;
  s.wheelsDown = false;
  g.sortie.started = true;

  // Aim at a live turret and hold the trigger. The aircraft is teleported nose-on a few hundred
  // metres from the gun each pass, which is what a strafing run looks like from the gun's side.
  const strafe = (target) => {
    let fired = 0;
    for (let pass = 0; pass < 40 && target.alive; pass += 1) {
      // Nose-on, 320 m out and level with the gun house.
      const gunY = target.y + 27;
      const back = 320;
      s.position.set(target.x, gunY, target.z + back);
      s.heading = Math.PI;      // heading 0 is -Z, so PI points at +Z... set explicitly below
      // Point the machine at the gun: heading is measured so that forward is (sin, -cos).
      s.heading = Math.atan2(target.x - s.position.x, -(target.z - s.position.z));
      s.speed = 90;
      s.airspeed = 90;
      s.pitch = Math.atan2(gunY - s.position.y, Math.hypot(target.x - s.position.x, target.z - s.position.z));
      s.bank = 0;
      s.climb = 0;
      s.health = 100;
      g.pressKeys(['KeyX'], true);
      for (let i = 0; i < 240 && target.alive; i += 1) {
        g.simulate(1 / 60);
        fired += 1;
        // Keep the nose on the gun while the rounds fly.
        s.position.set(target.x, gunY, target.z + back);
        s.heading = Math.atan2(target.x - s.position.x, -(target.z - s.position.z));
        s.pitch = 0;
        s.health = 100;
        if (g.sortie.finished) break;
      }
      g.pressKeys(['KeyX'], false);
    }
    return { alive: target.alive, fired };
  };

  const turrets = g.airDefence.turrets.filter((t) => t.alive);
  log.push(`live turrets at start: ${turrets.length}`);
  if (turrets.length < 2) return { error: 'round does not have two turrets to shoot', log };

  // --- Pass 1: kill exactly one gun.
  const r1 = strafe(turrets[0]);
  log.push(`pass 1: fired ${r1.fired} steps, target alive=${r1.alive}`);
  log.push(`  kills=${g.sortie.kills} turrets=${g.sortie.turretsKilled} objectiveMet=${g.sortie.objectiveMet}`);
  const afterOne = { kills: g.sortie.kills, turretsKilled: g.sortie.turretsKilled,
    objectiveMet: g.sortie.objectiveMet, finished: g.sortie.finished };

  // --- Interlude: a landing with the requirement unmet must be refused.
  // Fly the remaining gates with a shortcut: mark them passed, then let the round test run.
  for (const gate of g.gates) gate.passed = true;
  g.sortie.gatesPassed = round.gates;
  g.sortie.landed = true;
  g.sortie.wheelsDown = true;
  s.wheelsDown = true;
  s.speed = 0;
  s.destroyed = false;
  s.fuel = round.fuel * 0.5;
  // Park on the runway so every landing test is satisfied except the objective.
  const { RUNWAY } = await import('/src/config.js');
  s.position.set(RUNWAY.x, 60, RUNWAY.z);
  s.pitch = 0; s.bank = 0; s.climb = 0;
  g.simulate(1);
  const refused = { finished: g.sortie.finished, phase: g.sortie.phase, objectiveMet: g.sortie.objectiveMet };
  log.push(`landing with objective unmet: finished=${refused.finished} phase=${refused.phase} (want finished=false)`);

  // --- Pass 2: kill the second gun, and the requirement clears.
  g.sortie.landed = false;
  s.wheelsDown = false;
  g.sortie.started = true;
  const second = g.airDefence.turrets.find((t) => t.alive);
  const r2 = strafe(second);
  log.push(`pass 2: fired ${r2.fired} steps, target alive=${r2.alive}`);
  log.push(`  kills=${g.sortie.kills} turrets=${g.sortie.turretsKilled} objectiveMet=${g.sortie.objectiveMet}`);

  // --- And now the same landing is accepted.
  g.sortie.gatesPassed = round.gates;
  g.sortie.landed = true;
  g.sortie.wheelsDown = true;
  s.wheelsDown = true;
  s.speed = 0;
  s.position.set(RUNWAY.x, 60, RUNWAY.z);
  s.pitch = 0; s.bank = 0; s.climb = 0; s.health = 100;
  g.simulate(1);
  const accepted = { finished: g.sortie.finished, phase: g.sortie.phase, reason: g.sortie.result?.reason };
  log.push(`landing with objective met: finished=${accepted.finished} reason=${accepted.reason} (want finished=true, landed)`);

  return { log, afterOne, refused, accepted, round: { name: round.name, need: round.winCondition } };
});

if (out.error) {
  console.log(out.log.join('\n'));
  console.log(`\nFAIL: ${out.error}`);
  await browser.close();
  process.exit(1);
}

console.log(out.log.join('\n'));

const pass = out.afterOne.turretsKilled === 1
  && out.afterOne.objectiveMet === false
  && out.refused.finished === false
  && out.accepted.finished === true
  && out.accepted.reason === 'landed';

console.log(`\nerrors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);
console.log(pass ? 'PASS' : 'FAIL');
await browser.close();
process.exit(pass ? 0 : 1);
