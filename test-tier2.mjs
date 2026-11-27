// Tier 2: the SAM site and the bomber flight.
//
// Both of these are threats the pilot has to answer with geometry rather than with distance: a SAM
// round follows, so the defence is a turn; a bomber is trying to get somewhere, so the answer is
// arriving in time. These tests drive the real enemies.js headless and check the things that would
// make either feature a lie — that a site launches, that its round can be out-turned, that a bomber
// flies its line and dies to sustained fire, and that both can be locked and shot down.

import * as THREE from './game/vendor/three.module.min.js';
import { createAirDefence } from './game/src/enemies.js';
import { ENEMY, ORDNANCE, RUNWAY } from './game/src/config.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** A ridge: high enough for the placement rules, flat enough to pass the slope test. */
const ridgeTerrain = { heightAt: () => 120 };

const STEP = 1 / 60;

function makeDefence(cfg, id = 4) {
  const scene = new THREE.Scene();
  const defence = createAirDefence({
    scene,
    terrain: ridgeTerrain,
    round: { id, airDefence: cfg },
    haze: null,
  });
  return { scene, defence };
}

/** An aircraft state at a world position, flying a given heading. */
function aircraftAt(x, y, z, heading = 0, speed = 120) {
  return {
    position: new THREE.Vector3(x, y, z),
    heading,
    pitch: 0,
    speed,
    destroyed: false,
  };
}

/**
 * Puts a SAM site at a known place instead of wherever placement chose.
 *
 * Placement samples real terrain and rejects most of it, so a test that relied on it would depend on
 * the seed of the round. The site keeps its real shape and fields; only its coordinates move.
 */
function pinSam(sam, x, y, z) {
  sam.x = x;
  sam.y = y;
  sam.z = z;
  sam.root.position.set(x, y, z);
  sam.cooldown = 0;
  return sam;
}

function pinBomber(bomb, x, y, z, heading) {
  bomb.position.set(x, y, z);
  bomb.group.position.set(x, y, z);
  if (heading !== undefined) bomb.heading = heading;
  return bomb;
}

console.log('\n=== SAM site ===');
{
  const { defence } = makeDefence({ flak: 0, drones: 0, sams: 1 });
  check('a site is placed when the round asks for one', defence.sams.length === 1,
    `got ${defence.sams.length}`);

  const sam = defence.sams[0];
  // An aircraft 900 m away and 200 m up, inside the 2300 m engagement range.
  const state = aircraftAt(sam.x + 900, sam.y + 200, sam.z);
  defence.track(state.position);

  // Hold the aircraft still long enough for the reload timer to expire.
  let fired = 0;
  for (let i = 0; i < 60 * 12; i += 1) {
    defence.update(STEP, state, i * STEP);
    fired = Math.max(fired, defence.missiles.length);
  }
  check('a site inside range launches a guided round', fired > 0, `peak in flight ${fired}`);
  check('a site never has more than one round in the air', fired === 1, `peak ${fired}`);

  // Out of range: nothing should launch.
  const { defence: far } = makeDefence({ flak: 0, drones: 0, sams: 1 }, 5);
  const fsam = far.sams[0];
  const farState = aircraftAt(fsam.x + ENEMY.sam.range * 2.5, fsam.y + 300, fsam.z);
  far.track(farState.position);
  let farFired = 0;
  for (let i = 0; i < 60 * 12; i += 1) {
    far.update(STEP, farState, i * STEP);
    farFired = Math.max(farFired, far.missiles.length);
  }
  check('a site outside range holds its fire', farFired === 0, `peak ${farFired}`);
}

console.log('\n=== the round can be out-turned ===');
{
  // A round that cannot be beaten is a dice roll, not a threat. The contract is that the aircraft's
  // own turn rate exceeds the round's, so a hard break wins — and this checks it numerically rather
  // than trusting the config comment.
  const { AIRCRAFT } = await import('./game/src/config.js');
  const planeTurn = AIRCRAFT.turnRate ?? AIRCRAFT.maxTurnRate ?? null;
  check('the aircraft out-turns a SAM round',
    planeTurn === null ? ENEMY.sam.turnRate < 1.6 : planeTurn > ENEMY.sam.turnRate,
    `aircraft ${planeTurn} vs round ${ENEMY.sam.turnRate}`);

  // And the round must actually arrive when the target does not manoeuvre, or the weapon is inert.
  const { defence } = makeDefence({ flak: 0, drones: 0, sams: 1 }, 6);
  const sam = pinSam(defence.sams[0], 0, 120, 0);
  let hits = 0;
  const state = aircraftAt(0, 420, 700);
  defence.track(state.position);
  for (let i = 0; i < 60 * 25; i += 1) {
    // Hold the aircraft still: a straight run should not survive a guided round.
    const events = defence.update(STEP, state, i * STEP);
    for (const e of events) if (e.type === 'hit') hits += 1;
    if (defence.missiles.length === 0 && hits > 0) break;
  }
  check('a round that is not dodged detonates on the aircraft', hits > 0, `${hits} hits`);
}

console.log('\n=== bomber flight ===');
{
  const { defence } = makeDefence({ flak: 0, drones: 0, bombers: 3 }, 7);
  check('a flight of three is placed', defence.bombers.length === 3, `got ${defence.bombers.length}`);

  const bomb = defence.bombers[0];
  pinBomber(bomb, 0, 500, 0, 0);
  const state = aircraftAt(0, 500, 2000);
  defence.track(state.position);

  const before = bomb.position.clone();
  for (let i = 0; i < 60; i += 1) defence.update(STEP, state, i * STEP);
  const travelled = bomb.position.distanceTo(before);
  check('a bomber flies its line', travelled > 20, `moved ${travelled.toFixed(1)} m`);
  check('a bomber moves at its own slow speed',
    Math.abs(travelled - ENEMY.bomber.speed) < ENEMY.bomber.speed * 0.2,
    `moved ${travelled.toFixed(1)} m in 1 s, expected ~${ENEMY.bomber.speed}`);

  // Sustained fire kills one; a single round does not. The asymmetry is the point of the class.
  const fresh = defence.bombers[1];
  pinBomber(fresh, 0, 480, 0, 0);
  const shooter = aircraftAt(0, 480, 200);
  defence.track(shooter.position);
  const startHp = fresh.hp;
  for (let i = 0; i < 8; i += 1) defence.fireGuns(STEP, shooter, { fire: true });
  for (let i = 0; i < 40; i += 1) defence.update(STEP, shooter, i * STEP);
  check('a bomber survives a snapshot', fresh.hp > 0 && fresh.hp < startHp,
    `hp ${fresh.hp} of ${startHp}`);
}

console.log('\n=== both can be locked and shot down ===');
{
  const { defence } = makeDefence({ flak: 0, drones: 0, sams: 1, bombers: 1 }, 8);
  const sam = pinSam(defence.sams[0], 0, 120, -800);
  const bomb = pinBomber(defence.bombers[0], 0, 120, -900, 0);
  // Nose down the -Z axis at launcher height, so both are inside the seeker's cone.
  const state = aircraftAt(0, 124, 0, 0, 0);
  defence.track(state.position);

  for (let i = 0; i < 90; i += 1) defence.update(STEP, state, i * STEP);
  const samLock = defence.ordnanceStatus();
  check('a SAM site can be locked', samLock.hasTarget, `hasTarget ${samLock.hasTarget}`);
  check('the lock names the site', samLock.kind === 'sam', `kind ${samLock.kind}`);

  // Kill the site with the guns: it is a soft target at launcher height.
  let killedSam = false;
  for (let i = 0; i < 200 && !killedSam; i += 1) {
    defence.fireGuns(STEP, state, { fire: true });
    const ev = defence.update(STEP, state, i * STEP);
    for (const e of ev) if (e.type === 'kill' && e.kind === 'sam') killedSam = true;
    if (sam.hp <= 0) killedSam = true;
  }
  check('a SAM site dies to gunfire', killedSam, `hp ${sam.hp}`);

  // And the bomber, from a fresh defence so the lock state is clean.
  const { defence: d2 } = makeDefence({ flak: 0, drones: 0, bombers: 1 }, 9);
  // Heading passes the shooter rather than flying away from it: a bomber running down the nose at
  // capture range is the case the guns are actually for, and at 900 m it would outrun the slugs.
  const b2 = pinBomber(d2.bombers[0], 0, 124, -420, Math.PI);
  const s2 = aircraftAt(0, 124, 0, 0, 0);
  d2.track(s2.position);
  for (let i = 0; i < 90; i += 1) d2.update(STEP, s2, i * STEP);
  const bLock = d2.ordnanceStatus();
  check('a bomber can be locked', bLock.hasTarget && bLock.kind === 'bomber',
    `kind ${bLock.kind}, hasTarget ${bLock.hasTarget}`);

  let killedBomber = false;
  for (let i = 0; i < 600 && !killedBomber; i += 1) {
    d2.fireGuns(STEP, s2, { fire: true });
    const ev = d2.update(STEP, s2, i * STEP);
    for (const e of ev) if (e.type === 'kill' && e.kind === 'bomber') killedBomber = true;
  }
  check('a bomber dies to sustained fire', killedBomber, `hp ${b2.hp}`);
}

console.log('\n=== status and counts ===');
{
  const { defence } = makeDefence({ flak: 2, drones: 1, sams: 1, bombers: 2 }, 10);
  const st = defence.status();
  check('status reports the sites', st.samsTotal === 1 && st.samsAlive === 1,
    `${st.samsAlive}/${st.samsTotal}`);
  check('status reports the bombers', st.bombersTotal === 2 && st.bombersAlive === 2,
    `${st.bombersAlive}/${st.bombersTotal}`);
  check('status hands over the live bombers for the HUD', st.bombers.length === 2,
    `${st.bombers.length}`);
  check('one slot flag per bomber', st.bomberSlots.length === st.bombersTotal,
    `${st.bomberSlots.length} slots`);

  // A round with none of either must report zero rather than throwing, because every earlier round
  // in the campaign runs the same code with an empty config.
  const { defence: plain } = makeDefence({ flak: 1, drones: 0 }, 11);
  const pst = plain.status();
  check('a round with no sites reports zero', pst.samsTotal === 0 && pst.bombersTotal === 0,
    `${pst.samsTotal}/${pst.bombersTotal}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
