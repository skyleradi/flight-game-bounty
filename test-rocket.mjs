// Tier 1 D: the rocket pod.
//
// The pod is the one weapon the pilot has to fly for: the nose has to be held inside a narrow cone
// for long enough for the seeker to settle, and only then does the release do anything. These tests
// drive the real enemies.js module headless — three.js builds scene graphs and does vector maths
// fine in Node as long as nothing asks for a WebGL context.

import * as THREE from './game/vendor/three.module.min.js';
import { createAirDefence } from './game/src/enemies.js';
import { ORDNANCE, ENEMY, RUNWAY } from './game/src/config.js';

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

/**
 * A terrain that behaves like the real ridges without booting the world generator.
 *
 * `placeTurrets` skips anything below 90 m — a gun in a valley cannot see the sky — and rejects
 * slopes steeper than 0.55. A flat terrain at zero would therefore place no turrets at all, and
 * every test below would pass by having nothing to shoot. Returning a constant 120 m satisfies both
 * checks: high enough to be a ridge, and flat enough to be a shoulder rather than a cliff.
 */
const ridgeTerrain = { heightAt: () => 120 };

/**
 * A defence with turrets and no interceptors.
 *
 * `flak` is what actually places the guns; a round with none has an empty turret list and nothing
 * to lock, which would make every test below pass for the wrong reason.
 */
function makeDefence(flak = 2, id = 3) {
  const scene = new THREE.Scene();
  const defence = createAirDefence({
    scene,
    terrain: ridgeTerrain,
    round: { id, airDefence: { flak, drones: 0 } },
    haze: null,
  });
  return { scene, defence };
}

/**
 * Puts a turret directly down the nose at `distance`, and returns it.
 *
 * Heading 0 is straight down -Z: the heading basis is `sin(h)` on X and `-cos(h)` on Z, so at h = 0
 * forward is (0, 0, -1). A turret aimed at `t.y + 27`, with `t.y` being the ground minus one, means
 * the airframe has to sit at y = 26 for the seeker to see it dead ahead rather than slightly below.
 */
function aimTurret(turret, distance, x = 0) {
  turret.x = x;
  turret.z = -distance;
  turret.alive = true;
  turret.hp = ENEMY.turretHealth;
  if (turret.head) turret.head.visible = true;
  if (turret.root) turret.root.visible = true;
  return turret;
}

/**
 * The airframe, sitting exactly on the turret's aim point.
 *
 * A turret is aimed at `t.y + 27`, and `t.y` is the ridge height minus one, so a gun on a 120 m
 * ridge is shot at from 146 m. Placing the aircraft anywhere else would put the target slightly
 * below or above the nose and the eight-degree cone would do the rest of the work — including
 * rejecting a target the test believes is dead ahead.
 */
function aircraftAt(z = 0) {
  return {
    position: new THREE.Vector3(0, 146, z),
    heading: 0,
    pitch: 0,
    speed: 90,
    destroyed: false,
  };
}

function controls(launch = false) {
  return {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: false, flaps: 0,
    boost: false, fire: false, launch, mouseDeltaX: 0, mouseDeltaY: 0,
  };
}

const DT = 1 / 60;

/** Holds the nose on the target for `seconds`, returning the final readout. */
function hold(defence, state, seconds) {
  const steps = Math.ceil(seconds / DT);
  for (let i = 0; i < steps; i += 1) defence.update(DT, state, i * DT, controls(false));
  return defence.ordnanceStatus();
}

console.log('\n=== rocket pod ===\n');

// --- The seeker's initial state.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  aimTurret(defence.turrets[0], 800);
  defence.track(state.position);

  defence.update(DT, state, 0, controls(false));
  const read = defence.ordnanceStatus();
  check('no solution on the first step', read.locked === false, `locked=${read.locked}`);
  check('full pod before any launch', read.remaining === ORDNANCE.count, `remaining=${read.remaining}`);
  check('nothing on the rail', defence.rockets.length === 0);
  check('pod is not empty', read.empty === false);
  defence.dispose();
}

// --- The lock takes time, and completes at lockTime.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  aimTurret(defence.turrets[0], 800);
  defence.track(state.position);

  defence.update(DT, state, 0, controls(false));
  const early = defence.ordnanceStatus();
  check('target acquired inside the cone', early.hasTarget === true, `hasTarget=${early.hasTarget}`);
  check('but no solution yet', early.locked === false);

  hold(defence, state, ORDNANCE.lockTime + 0.1);
  const held = defence.ordnanceStatus();
  check('solution after holding the nose', held.locked === true, `progress=${held.progress}`);
  check('progress reaches 1', Math.abs(held.progress - 1) < 0.02, `progress=${held.progress}`);
  defence.dispose();
}

// --- A launch spends a round, puts a rocket in the air, and spends the lock.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  aimTurret(defence.turrets[0], 800);
  defence.track(state.position);

  hold(defence, state, ORDNANCE.lockTime + 0.1);
  check('locked before the release', defence.ordnanceStatus().locked === true);

  defence.update(DT, state, 5, controls(true));
  const after = defence.ordnanceStatus();
  check('a rocket is on the rail', defence.rockets.length === 1, `n=${defence.rockets.length}`);
  check('ammunition decrements', after.remaining === ORDNANCE.count - 1, `remaining=${after.remaining}`);
  check('the launch spends the lock', after.locked === false);
  defence.dispose();
}

// --- An unlocked release does nothing: the pod cannot be sprayed.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  aimTurret(defence.turrets[0], 800);
  defence.track(state.position);

  defence.update(DT, state, 0, controls(true));
  check('an unlocked release fires nothing', defence.rockets.length === 0);
  check('ammunition untouched', defence.ordnanceStatus().remaining === ORDNANCE.count);
  defence.dispose();
}

// --- The rocket flies, guides, and kills what it was launched at.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  const turret = aimTurret(defence.turrets[0], 900);
  defence.track(state.position);

  hold(defence, state, ORDNANCE.lockTime + 0.1);
  defence.update(DT, state, 3, controls(true));
  check('rocket launched for the kill test', defence.rockets.length === 1);

  let kill = null;
  let t = 3;
  for (let i = 0; i < 900 && defence.rockets.length > 0; i += 1) {
    t += DT;
    for (const e of defence.update(DT, state, t, controls(false))) {
      if (e.type === 'kill') kill = e;
    }
  }

  check('the rocket leaves the world', defence.rockets.length === 0, `n=${defence.rockets.length}`);
  check('the turret is dead', turret.alive === false, `hp=${turret.hp}`);
  check('the kill is reported', kill !== null && kill.kind === 'turret',
    kill ? `kind=${kill.kind}` : 'no kill event');
  defence.dispose();
}

// --- Ammunition does not come back when a round is spent.
//
// This is the bug the counter exists to prevent: deriving `remaining` from the live rocket list
// would refill the pod every time a round connected or expired.
{
  const { defence } = makeDefence(4, 11);
  const state = aircraftAt();
  // High hit points so every turret survives the whole test: the launch count then measures
  // ammunition, not the supply of targets.
  for (let i = 0; i < 4 && i < defence.turrets.length; i += 1) {
    aimTurret(defence.turrets[i], 800, i * 40);
    defence.turrets[i].hp = 1e6;
  }
  defence.track(state.position);

  // Count launches by what left the pod, not by what is still in the air: rounds impact and expire
  // during the test, so the live list is a snapshot rather than a tally.
  let lastRemaining = ORDNANCE.count;
  for (let shot = 0; shot < ORDNANCE.count + 3; shot += 1) {
    hold(defence, state, ORDNANCE.lockTime + 0.1);
    defence.update(DT, state, shot, controls(true));
    lastRemaining = defence.ordnanceStatus().remaining;
  }

  const read = defence.ordnanceStatus();
  const launches = ORDNANCE.count - read.remaining;
  check('the pod fires exactly its complement', launches === ORDNANCE.count,
    `launches=${launches}, remaining=${read.remaining}`);
  check('remaining never goes negative', read.remaining === 0, `remaining=${read.remaining}`);
  check('the pod reads empty', read.empty === true);
  defence.dispose();
}

// --- A lock is dropped when its target dies before the shot.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  const turret = aimTurret(defence.turrets[0], 800);
  defence.track(state.position);

  hold(defence, state, ORDNANCE.lockTime * 0.5);
  check('lock in progress', defence.ordnanceStatus().progress > 0);

  turret.alive = false;
  turret.head.visible = false;
  defence.update(DT, state, 5, controls(false));
  const after = defence.ordnanceStatus();
  check('the lock drops with its target', after.hasTarget === false, `hasTarget=${after.hasTarget}`);
  check('no solution on a dead target', after.locked === false);

  defence.update(DT, state, 5.1, controls(true));
  check('a release on a dead target fires nothing', defence.rockets.length === 0);
  defence.dispose();
}

// --- The seeker ignores what is behind the aircraft.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  const turret = defence.turrets[0];
  aimTurret(turret, 800);
  turret.z = 800; // over the shoulder
  defence.track(state.position);

  defence.update(DT, state, 0, controls(false));
  check('nothing behind the aircraft is a target', defence.ordnanceStatus().hasTarget === false);
  defence.dispose();
}

// --- The seeker ignores what is out of range.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  aimTurret(defence.turrets[0], ORDNANCE.lockRange + 400);
  defence.track(state.position);

  defence.update(DT, state, 0, controls(false));
  check('nothing out of range is a target', defence.ordnanceStatus().hasTarget === false);
  defence.dispose();
}

// --- A wide angle off the nose is not a lock.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  // 400 m ahead and 250 m to the side: about 32 degrees, well outside the eight-degree cone.
  aimTurret(defence.turrets[0], 400, 250);
  defence.track(state.position);

  defence.update(DT, state, 0, controls(false));
  check('a target off the nose is not locked', defence.ordnanceStatus().hasTarget === false);
  defence.dispose();
}

// --- An empty pod cannot launch, even with a perfect lock.
{
  const { defence } = makeDefence();
  const state = aircraftAt();
  const t0 = aimTurret(defence.turrets[0], 800);
  t0.hp = 1e6;
  defence.track(state.position);

  for (let shot = 0; shot < ORDNANCE.count; shot += 1) {
    hold(defence, state, ORDNANCE.lockTime + 0.1);
    defence.update(DT, state, shot, controls(true));
  }
  check('pod spent', defence.ordnanceStatus().remaining === 0, `remaining=${defence.ordnanceStatus().remaining}`);

  // Ammunition is the thing that must not move: the live rocket list can only shrink as rounds
  // impact, so comparing its length before and after would be measuring the wrong quantity.
  hold(defence, state, ORDNANCE.lockTime + 0.1);
  defence.update(DT, state, 99, controls(true));
  check('an empty pod launches nothing', defence.ordnanceStatus().remaining === 0,
    `remaining=${defence.ordnanceStatus().remaining}`);
  defence.dispose();
}

// --- The aircraft's own speed is added to the launch.
{
  const { defence } = makeDefence();
  const slow = aircraftAt();
  aimTurret(defence.turrets[0], 800);
  defence.track(slow.position);
  hold(defence, slow, ORDNANCE.lockTime + 0.1);
  defence.update(DT, slow, 1, controls(true));
  const slowSpeed = defence.rockets[0].vel.length();

  const { defence: fast } = makeDefence();
  const quick = aircraftAt();
  quick.speed = 220;
  aimTurret(fast.turrets[0], 800);
  fast.track(quick.position);
  hold(fast, quick, ORDNANCE.lockTime + 0.1);
  fast.update(DT, quick, 1, controls(true));
  const fastSpeed = fast.rockets[0].vel.length();

  check('a faster aircraft throws a faster rocket', fastSpeed > slowSpeed + 50,
    `slow=${slowSpeed.toFixed(1)}, fast=${fastSpeed.toFixed(1)}`);
  defence.dispose();
  fast.dispose();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
