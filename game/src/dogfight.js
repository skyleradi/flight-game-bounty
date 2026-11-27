// The interceptor's brain.
//
// The old drone was a proportional-navigation missile with a gun: it turned toward a lead point and
// flew at it until it died. That is a threat, but it is not an opponent — it never overshoots,
// never disengages, never comes back, and never surprises you. Flying against four of them feels
// like flying against one of them, four times.
//
// This is a small state machine instead: patrol, pursue, attack, extend, evade. What makes it read
// as a pilot is the transitions. It breaks off when it is about to overshoot rather than sitting on
// your tail. It extends when it has bled too much energy turning. It jinks when it is hit. And it
// rejoins, so the fight has a rhythm instead of a single long chase.
//
// Two constraints keep it fair rather than punishing:
//
//   * It turns slower than the aircraft, so turning inside one is still the answer.
//   * It only fires once its gun has been on the target for `settleTime`, so a snapshot misses.
//     That punish-window is the whole reason a hard turn can beat a shot that was "aimed".
//
// Everything is deterministic per drone (own RNG, seeded from the round), so a replay of the same
// sortie produces the same fight.

import * as THREE from '../vendor/three.module.min.js';

/** Wraps an angle into (-PI, PI]. */
function wrapAngle(a) {
  return ((a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const V = {
  fwd: new THREE.Vector3(),
  to: new THREE.Vector3(),
  aim: new THREE.Vector3(),
  probe: new THREE.Vector3(),
  side: new THREE.Vector3(),
};

/**
 * A shared per-round squad book. Keeping the "how many may attack at once" count here means the
 * drones coordinate without messaging each other: a drone asks the book whether it may press an
 * attack, and the book refuses when the fight is already busy. That is what stops three
 * interceptors from stacking into one laser-accurate gun.
 */
export function createSquad(count) {
  return {
    /** Drones currently allowed to press an attack. */
    attackers: 0,
    /** At most this many press at once: one for a pair, two for a flight. */
    maxAttackers: count <= 1 ? 1 : count === 2 ? 1 : 2,
  };
}

/**
 * One interceptor's brain.
 *
 * `cfg` is `ENEMY.drone`; `ace` promotes one drone per round to a better pilot (faster decision
 * making, tighter gun, more patience), which gives the flight a leader worth fearing.
 */
export function createDogfight({ seed, ace = false, skill = 1 }) {
  const rng = makeRng(seed);
  return {
    state: 'patrol',
    /** Seconds left in the current state, so transitions are timed rather than instantaneous. */
    timer: 0.6 + rng() * 0.8,
    /** How long the nose has been inside the firing cone. */
    trackTime: 0,
    /** How long since this drone last had a firing solution, used to avoid re-pressing instantly. */
    cooldown: 0.8 + rng() * 1.6,
    /** A per-drone bias, so two drones in the same state do not fly the same line. */
    bias: (rng() * 2 - 1) * 0.22,
    /** Offset in the formation, radians, so the wingman does not sit in the leader's jetwash. */
    formation: (rng() * 2 - 1) * 0.5,
    ace,
    skill,
    /** Set once the drone has been hit, so it jinks for a moment. */
    hitFlash: 0,
    /** Where it was last shot from, for the evade break. */
    threatDir: new THREE.Vector3(),
    /** Rolling accumulator for the visual bank. */
    bankTarget: 0,
  };
}

/** True if a spot is safely above the ground there plus a margin. */
function clearOfGround(terrain, x, y, z, margin) {
  return y > terrain.heightAt(x, z) + margin;
}

/**
 * Steps one interceptor.
 *
 * Returns `{ fire, dir, speed, state }`. The caller applies the position integration and the visual
 * transform; this function only decides where to point and whether to shoot.
 */
export function stepDogfight(d, g, dt) {
  const cfg = g.cfg;
  const terrain = g.terrain;
  const rng = g.rng;

  // The brain is created by the caller, one per drone, so its state survives between frames. The
  // guard is here rather than `??=` because a missing brain means an init bug, not a lazy default:
  // silently creating a fresh one every frame would reset `trackTime` each step and the gun would
  // never fire, which is a bug that looks like a balance problem.
  if (!d.brain) throw new Error('stepDogfight: drone has no brain; initialise it before the loop');

  const dx = g.aircraftPos.x - d.position.x;
  const dy = g.aircraftPos.y - d.position.y;
  const dz = g.aircraftPos.z - d.position.z;
  const dist = Math.hypot(dx, dy, dz);

  // Closing rate: positive when the gap is shrinking. This is what decides an overshoot, and an
  // overshoot is the moment a pursuit has to become an extension.
  V.to.set(dx, dy, dz).normalize();
  V.fwd.set(
    Math.sin(d.heading) * Math.cos(d.pitch),
    Math.sin(d.pitch),
    -Math.cos(d.heading) * Math.cos(d.pitch),
  );
  const closing = -d.velocity.dot(V.to);
  const angleOff = Math.acos(THREE.MathUtils.clamp(V.fwd.dot(V.to), -1, 1));

  const hurt = d.hp < cfg.health * 0.4;
  // The state clock. Without this decrement every state is permanent: `patrol` never expires so the
  // drone never turns in, and an `extend` reached through the overshoot check below becomes sticky
  // so it flies away for the rest of the sortie. It was accidentally dropped in a refactor and the
  // symptom was zero transitions and zero shots, which reads like a balance problem and is not.
  d.brain.timer -= dt;
  if (d.brain.hitFlash > 0) d.brain.hitFlash -= dt;
  d.brain.cooldown -= dt;

  // --- Transitions. Ordered by urgency: a hit overrides everything, then an overshoot, then the
  // state's own expiry, then the geometry.
  //
  // Note what is NOT here: no squad bookkeeping. `squad.attackers` is recomputed from the live
  // drones at the end of each frame by the caller, so leaving `attack` by any route — timer,
  // overshoot, being hit, being shot down — cannot leak a slot. The first version incremented and
  // decremented it here, and every exit path that did not go through the timer leaked one; after a
  // couple of minutes every slot was gone and no interceptor ever pressed an attack again.
  if (d.brain.hitFlash > 0 && d.brain.state !== 'evade' && dist < cfg.range * 1.8) {
    // Just took a hit: break and jink rather than flying straight through the guns that hit it.
    //
    // This deliberately does NOT wait for `timer <= 0`. The first version did, and because an
    // attack runs for 5-8 seconds while `hitFlash` only lasts 0.9, a drone shot in the middle of an
    // attack run never broke off at all — it absorbed the hit and kept firing. Being hit interrupts
    // whatever the drone was doing; that is the whole point of shooting at it.
    d.brain.state = 'evade';
    d.brain.timer = 1.1 + rng() * 1.2;
    d.brain.trackTime = 0;
  }

  // An overshoot is when it is close and still closing fast. Sitting there would put it in front of
  // the aircraft's guns, which is exactly where a real pilot refuses to be.
  const overshoot = dist < 220 && closing > 34;
  if (overshoot && d.brain.state !== 'extend' && d.brain.state !== 'evade') {
    d.brain.state = 'extend';
    d.brain.timer = 1.4 + rng() * 1.6;
    d.brain.trackTime = 0;
  }

  if (d.brain.timer <= 0) {
    switch (d.brain.state) {
      case 'patrol':
        // Close enough to fight: turn in.
        if (dist < cfg.engageRange) {
          d.brain.state = 'pursue';
          d.brain.timer = 0.9 + rng() * 0.7;
        } else {
          d.brain.timer = 0.7 + rng() * 0.7;
        }
        break;
      case 'pursue':
        // Only press the attack if the squad book has a slot free.
        if (dist < cfg.range * 1.1 && angleOff < 0.75 && g.squad.attackers < g.squad.maxAttackers) {
          d.brain.state = 'attack';
          d.brain.timer = 5.5 + rng() * 3;
        } else {
          d.brain.timer = 0.5 + rng() * 0.6;
        }
        break;
      case 'attack':
        // Out of the attack: either it lost the nose, or it ran out of time and has to reset.
        // The slot itself is released by `releaseSlot` below, so this path does not touch it.
        d.brain.state = angleOff > 0.9 ? 'pursue' : 'extend';
        d.brain.timer = d.brain.state === 'extend' ? 1.2 + rng() * 1.4 : 0.5 + rng() * 0.5;
        d.brain.trackTime = 0;
        break;
      case 'extend':
        // Coming back in. A cheaper turn back means the fight keeps a rhythm instead of stalling.
        d.brain.state = 'pursue';
        d.brain.timer = 0.7 + rng() * 0.8;
        break;
      case 'evade':
        // A damaged interceptor does not come straight back: it extends to break contact and only
        // rejoins once it has room. A healthy one re-presses immediately. That is the difference
        // between a wounded opponent and a fresh one, and it is visible from the cockpit.
        if (hurt) {
          d.brain.state = 'extend';
          d.brain.timer = 1.8 + rng() * 1.6;
        } else {
          d.brain.state = 'pursue';
          d.brain.timer = 0.45 + rng() * 0.5;
        }
        break;
      default:
        d.brain.state = 'patrol';
        d.brain.timer = 1;
    }
  }

  // --- Steering. Each state produces a point to aim the nose at, then a capped turn is applied.
  const lead = cfg.lead * (d.brain.ace ? 1.05 : 0.8);
  const tof = dist / Math.max(1, d.speedNow ?? cfg.speed);
  V.aim.set(
    g.aircraftPos.x + g.aircraftVel.x * tof * lead,
    g.aircraftPos.y + g.aircraftVel.y * tof * lead,
    g.aircraftPos.z + g.aircraftVel.z * tof * lead,
  );

  let wantHeading;
  let wantPitch;
  let wantSpeed = cfg.speed;

  if (d.brain.state === 'patrol') {
    // Fly to a point that cuts the aircraft off rather than trailing it.
    wantHeading = Math.atan2(V.aim.x - d.position.x, -(V.aim.z - d.position.z));
    wantPitch = THREE.MathUtils.clamp(
      Math.atan2(V.aim.y - d.position.y, Math.hypot(V.aim.x - d.position.x, V.aim.z - d.position.z)),
      -0.4, 0.5,
    );
    wantSpeed = cfg.speed * 0.92;
  } else if (d.brain.state === 'extend') {
    // Fly away on a weaving line, which is what an extension looks like from outside and what
    // forces the pilot to choose between chasing and giving up the angle.
    const away = Math.atan2(-dx, dz);
    wantHeading = away + Math.sin(g.time * 1.9 + d.brain.formation * 5) * 0.55;
    wantPitch = 0.16;
    wantSpeed = cfg.speed * 1.12;
  } else if (d.brain.state === 'evade') {
    // A hard, descending jink: break toward the ground and turn, which is hard to track.
    const side = d.brain.formation >= 0 ? 1 : -1;
    wantHeading = Math.atan2(-dx, dz) + side * 1.25;
    wantPitch = -0.24;
    wantSpeed = cfg.speed * 1.06;
  } else if (d.brain.state === 'attack') {
    wantHeading = Math.atan2(V.aim.x - d.position.x, -(V.aim.z - d.position.z));
    wantPitch = Math.atan2(
      V.aim.y - d.position.y,
      Math.hypot(V.aim.x - d.position.x, V.aim.z - d.position.z),
    );
    // Match, don't overrun: hold a little slower than the target so the solution stays valid.
    wantSpeed = Math.min(cfg.speed, g.aircraftSpeed * 0.98 + 4);
  } else {
    // pursue
    wantHeading = Math.atan2(V.aim.x - d.position.x, -(V.aim.z - d.position.z));
    wantPitch = THREE.MathUtils.clamp(
      Math.atan2(V.aim.y - d.position.y, Math.hypot(V.aim.x - d.position.x, V.aim.z - d.position.z)),
      -0.5, 0.55,
    );
    wantSpeed = cfg.speed;
  }

  // --- Terrain avoidance, ahead of the turn rather than after it. Probe where the nose will be in
  // ~2.2 s and pull up, then a second probe sideways to pick the cheaper side of a ridge. Without
  // this the interceptors fly into mountains while chasing, which reads as broken rather than hard.
  V.probe.copy(V.fwd).multiplyScalar(Math.max(120, (d.speedNow ?? cfg.speed) * 2.2));
  const px = d.position.x + V.probe.x;
  const pz = d.position.z + V.probe.z;
  const py = d.position.y + V.probe.y;
  const groundAhead = terrain.heightAt(px, pz);
  let pullUp = 0;
  if (py < groundAhead + 90) {
    pullUp = THREE.MathUtils.clamp((groundAhead + 90 - py) / 120, 0.15, 1.0);
    // Which side is lower? Cheaper to go around a ridge than over it.
    const leftGround = terrain.heightAt(
      d.position.x + Math.cos(d.heading) * 110,
      d.position.z + Math.sin(d.heading) * 110,
    );
    const rightGround = terrain.heightAt(
      d.position.x - Math.cos(d.heading) * 110,
      d.position.z - Math.sin(d.heading) * 110,
    );
    if (Math.min(leftGround, rightGround) < groundAhead - 40) {
      wantHeading += leftGround < rightGround ? 0.55 : -0.55;
    }
  }
  // Hard floor: whatever the state wanted, never point it at the ground this close.
  const groundHere = terrain.heightAt(d.position.x, d.position.z);
  if (d.position.y < groundHere + 150) pullUp = Math.max(pullUp, 0.35);

  wantPitch = THREE.MathUtils.lerp(wantPitch, Math.max(wantPitch, 0.28), pullUp);

  // --- Apply the turn, capped. The cap is below the aircraft's own turn rate, so a hard break
  // still wins the angle; that is the fight's whole contract with the player.
  const turnRate = cfg.turn * (d.brain.ace ? 1.12 : 0.94) * d.brain.skill;
  let turn = wrapAngle(wantHeading - d.heading);
  const maxTurn = turnRate * dt;
  const applied = THREE.MathUtils.clamp(turn, -maxTurn, maxTurn);
  d.heading += applied;

  const pitchRate = 1.35 * d.brain.skill;
  const wantPitchClamped = THREE.MathUtils.clamp(wantPitch, -0.62, 0.66);
  const dPitch = THREE.MathUtils.clamp(wantPitchClamped - d.pitch, -pitchRate * dt, pitchRate * dt);
  d.pitch += dPitch;

  // Bank into the turn: this is purely visual, but a drone that turns flat looks like a turret in
  // the air. The target is the turn rate, so a hard turn shows a hard bank.
  const bankFromTurn = THREE.MathUtils.clamp((applied / Math.max(1e-4, dt)) * 0.62, -1.05, 1.05);
  d.brain.bankTarget = THREE.MathUtils.lerp(d.brain.bankTarget, bankFromTurn, 0.12);
  d.bank = THREE.MathUtils.lerp(d.bank, d.brain.bankTarget, 0.14);

  // Speed bleeds in a hard turn, which is what makes an extension eventually necessary.
  const turnBleed = 1 - Math.abs(applied / Math.max(1e-4, dt)) * 0.09;
  d.speedNow = THREE.MathUtils.lerp(
    d.speedNow ?? cfg.speed,
    Math.max(cfg.speed * 0.62, wantSpeed * turnBleed),
    0.05,
  );

  // --- The gun. It only fires once the nose has been inside the cone for `settleTime`, so a
  // snapshot misses and a sustained track hits. `angleOff` is recomputed after the turn, so the
  // shot reflects where the nose actually is now rather than where the brain wanted it.
  V.fwd.set(
    Math.sin(d.heading) * Math.cos(d.pitch),
    Math.sin(d.pitch),
    -Math.cos(d.heading) * Math.cos(d.pitch),
  );
  const noseNow = V.fwd.dot(V.to);

  const gunRange = cfg.range * (d.brain.ace ? 1.08 : 1);
  const cone = d.brain.ace ? 0.982 : 0.975;
  let fire = false;
  if (d.brain.state === 'attack' && dist < gunRange && noseNow > cone && d.brain.cooldown <= 0) {
    d.brain.trackTime += dt;
    if (d.brain.trackTime >= cfg.settleTime) fire = true;
  } else {
    d.brain.trackTime = Math.max(0, d.brain.trackTime - dt * 2.5);
  }

  // Firing in bursts, not a stream: a burst is readable and survivable, a stream is a wall.
  if (fire) {
    d.brain.burst = (d.brain.burst ?? 0) + 1;
    d.brain.cooldown = 0.09;
    if (d.brain.burst >= cfg.burst) {
      d.brain.burst = 0;
      d.brain.cooldown = 1.25 + rng() * 1.5;
      d.brain.trackTime = 0;
    }
  }

  return { fire, dist, closing, angleOff, state: d.brain.state };
}
