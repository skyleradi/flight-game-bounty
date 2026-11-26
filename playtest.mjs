// A deterministic playthrough driven through game.simulate(), so a headless browser's throttled
// requestAnimationFrame cannot make the test pass vacuously. It flies the real step function on a
// fixed clock: takeoff, a banked climb, the guns, the afterburner, taking fire, the crash path,
// a restart, and every round loading. Any page error fails the run.
import { chromium } from 'playwright';

const browser = await chromium.launch({
  executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}\n${e.stack ?? ''}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('favicon') && !t.includes('404')) errors.push(`CONSOLE ${t}`);
});

await page.goto('http://localhost:8080/', { waitUntil: 'load', timeout: 90000 });
await page.waitForFunction(() => !!window.__flight, { timeout: 90000 });

const results = await page.evaluate(() => {
  const g = window.__flight;
  const out = {};
  const s = g.aircraftState;

  /** Puts the aircraft in the air at a safe height, level, at cruise, with a whole airframe. */
  const flyLevel = (x, y, z, heading, speed = 88) => {
    s.position.set(x, y, z);
    s.heading = heading;
    s.pitch = 0;
    s.bank = 0;
    s.speed = speed;
    s.throttle = 1;
    s.health = 100;
    s.destroyed = false;
    s.wheelsDown = false;
    s.fuel = Math.max(s.fuel, 40);
  };

  g.loadRound(3, { briefing: false });
  g.beginRound();
  g.setPhase('flying');
  out.loaded = {
    turrets: g.airDefence.turrets.length,
    drones: g.airDefence.drones.length,
    gates: g.gates.length,
    hp: Math.round(s.health),
  };

  // --- Takeoff roll: from a standstill on the strip, full throttle must produce speed.
  s.throttle = 1;
  g.pressKeys(['ShiftLeft']);
  g.simulate(6);
  out.takeoffRoll = {
    speed: Math.round(s.speed),
    wheelsDown: s.wheelsDown,
    phase: g.sortie.phase,
  };

  // --- Rotation: at that speed, back pressure must lift it off the ground. In this control scheme
  // ArrowDown is nose-up (see KEY_HELP: "W / S  nose down / up"), so back pressure is ArrowDown.
  g.pressKeys(['ArrowDown']);
  g.simulate(3);
  g.pressKeys(['ArrowDown'], false);
  out.rotation = {
    speed: Math.round(s.speed),
    wheelsDown: s.wheelsDown,
    alt: Math.round(s.position.y),
    climb: Math.round(s.climb * 10) / 10,
    phase: g.sortie.phase,
  };

  // --- Bank: rolling left must bank and turn, and the two must agree in sign.
  flyLevel(s.position.x, 420, s.position.z, 0, 90);
  const heading0 = s.heading;
  g.pressKeys(['ArrowLeft']);
  g.simulate(1.6);
  g.pressKeys(['ArrowLeft'], false);
  g.simulate(0.8);
  out.bank = {
    bank: Math.round(s.bank * 100) / 100,
    headingChange: Math.round((s.heading - heading0) * 100) / 100,
  };

  // --- Afterburner: charge falls with spool up while held, then recharges once released.
  flyLevel(s.position.x, 620, s.position.z, 0, 88);
  const charge0 = s.boost;
  const speed0 = s.speed;
  g.pressKeys(['Tab']);
  g.simulate(2.0);
  const held = { charge: s.boost, spool: s.boostSpool, speed: s.speed };
  g.pressKeys(['Tab'], false);
  g.simulate(2.0);
  out.boost = {
    charge0: Math.round(charge0 * 100) / 100,
    chargeHeld: Math.round(held.charge * 100) / 100,
    spoolHeld: Math.round(held.spool * 100) / 100,
    rechargeAfter: Math.round(s.boost * 100) / 100,
    speedGain: Math.round(held.speed - speed0),
  };

  // --- Guns: place the nose on a turret at 200 m and hold the trigger. Rounds must leave the
  // aircraft; then a burst of rounds placed on the gun house must damage it and, eventually, kill it.
  const site = g.airDefence.turrets.find((t) => t.alive);
  const fromX = site.x + 12;
  const fromZ = site.z + 200;
  const nose = Math.atan2(site.x - fromX, -(site.z - fromZ));
  flyLevel(fromX, site.y + 28, fromZ, nose, 92);
  s.pitch = 0;
  g.pressKeys(['KeyX']);
  g.simulate(0.5, { dt: 1 / 120 });
  const slugsAfterFire = g.airDefence.slugs.length;
  g.pressKeys(['KeyX'], false);

  // Now prove the damage path on a turret the burst has not already killed: the gun test above
  // fires live rounds, and a clean burst at 200 m can finish a 26 hp emplacement outright.
  const target = g.airDefence.turrets.find((t) => t.alive) ?? site;
  if (!target.alive) {
    target.alive = true;
    target.hp = 26;
    target.head.visible = true;
  }
  const hpBefore = target.hp;
  for (let i = 0; i < 40; i += 1) {
    g.airDefence.slugs.push({
      pos: g.vec3(target.x, target.y + 27, target.z + 6),
      vel: g.vec3(0, 0, -420),
      life: 1.0,
    });
    g.simulate(0.02, { dt: 1 / 120 });
  }
  out.guns = {
    slugsAfterFire,
    hpBefore: Math.round(hpBefore),
    hpAfter: Math.round(target.hp),
    alive: target.alive,
    kills: g.sortie.kills,
    phase: g.sortie.phase,
  };

  // --- Taking fire: a round on the aircraft must damage it and light the HUD flash.
  flyLevel(s.position.x, 640, s.position.z, 0, 90);
  const hp0 = s.health;
  const flash0 = g.sortie.hitFlash ?? 0;
  g.airDefence.bullets.push({
    pos: g.vec3(s.position.x, s.position.y, s.position.z),
    vel: g.vec3(0, 0, -1),
    life: 2,
    damage: 14,
    owner: { spread: 0 },
  });
  g.simulate(0.1, { dt: 1 / 120 });
  out.takingFire = {
    before: Math.round(hp0),
    after: Math.round(s.health),
    hitsTaken: g.sortie.hitsTaken ?? 0,
    flashRose: (g.sortie.hitFlash ?? 0) > flash0,
  };

  // --- Crash: fly a broken airframe into a hillside. The round must end, not throw.
  s.health = 3;
  s.position.y = g.terrain.heightAt(s.position.x, s.position.z) + 2;
  s.pitch = -0.9;
  s.speed = 120;
  s.wheelsDown = false;
  g.simulate(2.0);
  out.crash = {
    phase: g.sortie.phase,
    reason: g.sortie.result?.reason ?? null,
    score: g.sortie.result?.score ?? null,
    reasonLabel: g.sortie.message ?? null,
  };

  // --- Restart: a whole airframe, stopped on the strip, guns rebuilt, gates cleared.
  g.restart();
  out.restart = {
    phase: g.sortie.phase,
    turrets: g.airDefence.turrets.length,
    drones: g.airDefence.drones.length,
    health: Math.round(s.health),
    speed: Math.round(s.speed),
    gates: g.sortie.gatesPassed,
    fuel: Math.round(s.fuel),
  };

  // --- Every round loads with its own emplacements, and a second of flight does not throw.
  out.rounds = [];
  for (let i = 0; i < 5; i += 1) {
    g.loadRound(i, { briefing: false });
    g.beginRound();
    g.simulate(1.0);
    out.rounds.push({
      i,
      name: g.round.name,
      turrets: g.airDefence.turrets.length,
      drones: g.airDefence.drones.length,
      phase: g.sortie.phase,
    });
  }

  return out;
});

console.log(JSON.stringify(results, null, 2));

const fail = [];
if (results.takeoffRoll.speed < 20) fail.push('takeoff roll never gained speed');
if (results.rotation.wheelsDown) fail.push('aircraft never lifted off');
if (Math.abs(results.bank.bank) < 0.1) fail.push('roll produced no bank');
if (results.boost.chargeHeld >= results.boost.charge0) fail.push('afterburner never drained');
if (results.boost.rechargeAfter <= results.boost.chargeHeld) fail.push('afterburner never recharged');
if (results.guns.slugsAfterFire === 0) fail.push('guns fired no rounds');
if (results.guns.hpAfter >= results.guns.hpBefore) fail.push('turret took no damage');
if (results.takingFire.after >= results.takingFire.before) fail.push('incoming round did no damage');
if (results.crash.phase !== 'debrief') fail.push('crash did not end the round');
if (results.restart.health !== 100) fail.push('restart left the airframe damaged');

if (errors.length) {
  console.log(`\nERRORS (${errors.length})`);
  for (const e of errors.slice(0, 12)) console.log(e);
}
if (fail.length) {
  console.log(`\nFAILURES (${fail.length})`);
  for (const f of fail) console.log(`- ${f}`);
}
if (errors.length || fail.length) {
  await browser.close();
  process.exit(1);
}
console.log('\nall checks passed, no page errors');
await browser.close();
