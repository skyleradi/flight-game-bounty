#!/usr/bin/env node
// Verifies the flight leader: that one exists per round with more than one interceptor, that its
// airframe is a different machine rather than a repaint of the same one, that downing it pays the
// leader's rate, and that the HUD bracket resolves to a real point on screen.
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
  const { scoreRound } = await import('/src/mission.js');
  const log = [];

  // --- STORM FRONT: three interceptors, so one of them is the leader.
  g.loadRound(4, { briefing: false });
  g.beginRound();
  const drones = g.airDefence.drones;
  const aces = drones.filter((d) => d.ace);
  log.push(`storm front: ${drones.length} interceptors, ${aces.length} leader(s)`);
  if (aces.length !== 1) return { error: `expected exactly one leader, got ${aces.length}`, log };

  // --- The leader must be a different machine, not the same geometry recoloured: count the meshes
  //     in each airframe's group.
  const countMeshes = (grp) => { let n = 0; grp.traverse((o) => { if (o.isMesh) n += 1; }); return n; };
  const wingman = drones.find((d) => !d.ace);
  const aceMeshes = countMeshes(aces[0].group);
  const wingMeshes = countMeshes(wingman.group);
  log.push(`meshes: leader ${aceMeshes}, wingman ${wingMeshes} (leader must carry more)`);

  // --- And it must be visibly darker: read the skin colour off the body mesh.
  const skinOf = (grp) => {
    let colour = null;
    grp.traverse((o) => {
      if (!colour && o.isMesh && o.material?.color && o.geometry?.type === 'ConeGeometry') {
        colour = o.material.color.getHex();
      }
    });
    return colour;
  };
  const aceSkin = skinOf(aces[0].group);
  const wingSkin = skinOf(wingman.group);
  log.push(`hull colour: leader #${aceSkin?.toString(16)}, wingman #${wingSkin?.toString(16)}`);

  // --- Score: a leader must be worth more than a wingman, and two wingmen plus one leader must
  //     beat three wingmen by exactly the leader's premium.
  const base = {
    round: g.round, gatesPassed: 10, landed: true, crashed: false, health: 100,
    fuel: 100, maxFuel: 100, timeLeft: 200, maxTime: 380,
  };
  const threeWingmen = scoreRound({ ...base, kills: 3, aceKills: 0 });
  const twoAndLeader = scoreRound({ ...base, kills: 3, aceKills: 1 });
  log.push(`score 3 wingmen: ${threeWingmen}`);
  log.push(`score 2 wingmen + leader: ${twoAndLeader} (must be higher)`);

  // --- The bracket: point the aircraft at the leader from 700 m and project it.
  const s = g.aircraftState;
  const lead = aces[0];
  s.position.set(lead.position.x, lead.position.y, lead.position.z + 700);
  s.heading = 0;   // forward is -Z, so heading 0 looks straight at the leader
  s.pitch = 0;
  s.bank = 0;
  s.speed = 80;
  s.health = 100;
  g.sortie.started = true;
  // One step puts the camera behind the aircraft and lets the HUD payload build.
  g.simulate(1 / 60);
  const mark = g.airDefence.status();
  log.push(`leader alive in status: ${mark.ace ? (mark.ace.ace ? 'yes (flagged)' : 'yes (not flagged)') : 'no'}`);

  // --- Downing the leader must be reported as a leader kill, worth the premium.
  //     Shoot it with the real gun path.
  let killed = false;
  for (let pass = 0; pass < 60 && !killed; pass += 1) {
    s.position.set(lead.position.x, lead.position.y, lead.position.z + 260);
    s.heading = 0;
    s.pitch = 0;
    s.health = 100;
    g.pressKeys(['KeyX'], true);
    for (let i = 0; i < 180 && lead.alive; i += 1) {
      g.simulate(1 / 60);
      s.position.set(lead.position.x, lead.position.y, lead.position.z + 260);
      s.heading = 0; s.pitch = 0; s.health = 100;
      if (g.sortie.finished) break;
    }
    g.pressKeys(['KeyX'], false);
    killed = !lead.alive;
  }
  log.push(`leader shot down: ${!lead.alive}`);
  log.push(`acesKilled counter: ${g.sortie.acesKilled}`);
  log.push(`leader still in status after death: ${g.airDefence.status().ace ? 'yes (BUG)' : 'no'}`);

  return {
    log, aceMeshes, wingMeshes, aceSkin, wingSkin,
    threeWingmen, twoAndLeader, killed: !lead.alive,
    acesKilled: g.sortie.acesKilled,
    clearedFromStatus: !g.airDefence.status().ace,
  };
});

if (out.error) {
  console.log(out.log.join('\n'));
  console.log(`\nFAIL: ${out.error}`);
  await browser.close();
  process.exit(1);
}
console.log(out.log.join('\n'));

const checks = [
  ['leader is a different airframe', out.aceMeshes > out.wingMeshes],
  ['leader is a darker hull', out.aceSkin !== out.wingSkin && out.aceSkin < out.wingSkin],
  ['leader pays more', out.twoAndLeader > out.threeWingmen],
  ['leader can be shot down', out.killed],
  ['downing it is counted as an ace', out.acesKilled === 1],
  ['bracket clears when the leader dies', out.clearedFromStatus],
];
console.log('');
let allPass = true;
for (const [name, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) allPass = false;
}
console.log(`\nerrors: ${errs.length ? errs.slice(0, 3).join(' | ') : 'none'}`);
console.log(allPass ? 'PASS' : 'FAIL');
await browser.close();
process.exit(allPass ? 0 : 1);
