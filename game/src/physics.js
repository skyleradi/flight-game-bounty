// The flight model. Everything here is arithmetic on the state aircraft.js creates: no rendering,
// no DOM, so the same numbers drive the model you see and the autopilot the screenshots use.
//
// The model is a light single-engine monoplane, flown with the keyboard and mouse, tuned for the
// feel the bounty asks for: throttle and turn discipline pay, energy has to be managed, and a
// stall or a hard landing is a consequence of what the pilot did rather than a script.
//
// The wind is real here rather than cosmetic. It is a vector in world space, and the aircraft's
// airspeed is the component of its ground velocity along the nose; so a headwind raises the
// airspeed at the same ground speed, a tailwind drops it, a crosswind weathervanes the nose and
// has to be held off with the rudder, and a gusting crosswind is what actually breaks landing
// gear. Flaps trade drag for lift, which is the only way to fly the storm round's short strip.

import * as THREE from '../vendor/three.module.min.js';
import { AIRCRAFT, RUNWAY, STEP, windVector } from './config.js';

const DEG = Math.PI / 180;

/**
 * The pilot's input for one step, 0 to 1 where it is an axis and -1 to 1 where it is a direction.
 * `mouseDeltaX/Y` are pixel deltas the arrow keys stand in for, so the same path serves both.
 */
export function emptyControls() {
  return {
    pitch: 0,
    roll: 0,
    yaw: 0,
    throttle: 0,
    brake: false,
    flaps: 0,
    mouseDeltaX: 0,
    mouseDeltaY: 0,
  };
}

/**
 * How much control authority the airframe has at this airspeed: 0 below the stall, rising to 1 at
 * cruise and stiffening above it. This one curve is what makes the aircraft feel heavy at the top
 * of the envelope and sloppy near the bottom.
 */
function authority(speed) {
  if (speed <= AIRCRAFT.stall) return Math.max(0, speed / AIRCRAFT.stall) * 0.35;
  if (speed >= AIRCRAFT.cruise) {
    const over = speed - AIRCRAFT.cruise;
    return Math.max(0.45, 1 - over * AIRCRAFT.stiffening);
  }
  return 0.35 + 0.65 * ((speed - AIRCRAFT.stall) / (AIRCRAFT.cruise - AIRCRAFT.stall));
}

/** The stall speed with `flaps` notches out: the wing keeps flying a little slower. */
export function stallSpeed(state) {
  return AIRCRAFT.stall * (1 - AIRCRAFT.flapStallRelief * (state.flaps ?? 0));
}

/**
 * Ground height at a world position, from the terrain sampler the world holds. The flight model
 * never loads the mesh: it asks the same heightfield the renderer used, so wheels touch the land
 * the player sees.
 */
export function groundAt(state, x, z) {
  const sampler = state.terrain;
  if (!sampler) return 0;
  return sampler(x, z);
}

/** Distance down and across the runway from its centre, in the runway's own frame. */
export function runwayFrame(x, z) {
  const dx = x - RUNWAY.x;
  const dz = z - RUNWAY.z;
  const along = dx * Math.sin(-RUNWAY.heading) + dz * Math.cos(-RUNWAY.heading);
  const across = dx * Math.cos(-RUNWAY.heading) - dz * Math.sin(-RUNWAY.heading);
  return { along, across };
}

/** True while the position is over the runway slab, where the wheels have asphalt to roll on. */
export function overRunway(x, z) {
  const { along, across } = runwayFrame(x, z);
  return Math.abs(along) <= RUNWAY.length * 0.5 + 30 && Math.abs(across) <= RUNWAY.width * 0.5 + 12;
}

/** How far down the strip a position is, 0 at the threshold and 1 at the far end. */
export function runwayProgress(x, z) {
  const { along } = runwayFrame(x, z);
  return (along + RUNWAY.length * 0.5) / RUNWAY.length;
}

/**
 * The turbulence offset for this step: a smooth pseudo-random gust on each axis, scaled by the
 * round's turbulence figure. Deterministic in the sortie clock, so a replay is a replay.
 */
function gust(state, t, seedPhase) {
  const s = state.turbulence ?? 0;
  if (s <= 0) return { x: 0, y: 0, z: 0, roll: 0 };
  const w = (f, p) => Math.sin(t * f + p) * 0.6 + Math.sin(t * f * 2.37 + p * 1.7) * 0.4;
  return {
    x: w(1.7, seedPhase) * s * 2.6,
    y: w(2.3, seedPhase + 1.2) * s * 1.9,
    z: w(1.3, seedPhase + 2.4) * s * 2.6,
    roll: w(1.9, seedPhase + 3.1) * s * 0.16,
  };
}

/**
 * Advances the aircraft one fixed step. `controls` is the pilot's input, `dt` the step; returns a
 * list of events the caller turns into sound and HUD messages.
 */
export function stepAircraft(state, controls, dt = STEP) {
  const events = [];
  if (state.destroyed) return events;

  const stalling = stallSpeed(state);

  // --- Throttle: the lever moves toward what the pilot asks and never snaps there.
  state.throttle = Math.min(1, Math.max(0, state.throttle + controls.throttle * dt * 0.85));

  const fuelLeft = state.fuel > 0;
  const thrust = fuelLeft ? AIRCRAFT.maxThrust * state.throttle : 0;

  // --- Flaps: the pilot selects them, and they move over about a second.
  const wantFlaps = Math.max(0, Math.min(2, controls.flaps ?? 0));
  state.flaps = state.flaps ?? 0;
  const flapDelta = wantFlaps - state.flaps;
  if (Math.abs(flapDelta) > 0.001) {
    state.flaps += Math.sign(flapDelta) * Math.min(Math.abs(flapDelta), dt * 1.6);
  }

  // --- The air the aircraft is flying through: the round's wind plus this step's gust.
  const base = state.wind ?? windVector(RUNWAY.heading * 0 + 270, 0);
  const g = gust(state, state.time ?? 0, 0.7);
  const airX = base.x + g.x;
  const airZ = base.z + g.z;

  // --- Energy. Drag rises with the square of the airspeed and flaps add to it; gravity takes its
  // cut of any climb. The climb angle here is the nose's, which is what the pilot commands.
  const climbSin = Math.sin(state.pitch);
  const gravity = 9.81 * AIRCRAFT.climbCost * climbSin;
  const drag = (AIRCRAFT.drag + AIRCRAFT.flapDrag * state.flaps * 0.0013) * state.speed * state.speed;
  let accel = thrust - drag - gravity;

  // The wind's component along the nose changes the airspeed the wing sees without changing the
  // ground track, which is what makes a headwind leg and a tailwind leg fly differently.
  const noseX = Math.sin(state.heading) * Math.cos(state.pitch);
  const noseZ = -Math.cos(state.heading) * Math.cos(state.pitch);
  const headwind = -(airX * noseX + airZ * noseZ);
  // The wing flies on the airspeed, so a headwind is free lift and a tailwind is a tax.
  const airspeed = Math.max(0, state.speed + headwind);

  // Ground friction and brakes while the wheels are down.
  if (state.wheelsDown) {
    accel -= controls.brake ? 7.5 : 1.1;
    if (state.speed + accel * dt < 0) accel = -state.speed / dt;
  }

  state.speed = Math.max(0, Math.min(AIRCRAFT.vne, state.speed + accel * dt));
  state.airspeed = airspeed;

  // --- Control authority falls away with airspeed, so the aircraft must be flown to be steered.
  const auth = authority(airspeed);
  const airborne = !state.wheelsDown;
  const pitchAuth = airborne ? auth : auth * 0.12;
  const rollAuth = airborne ? auth : 0.0;

  const mousePitch = -controls.mouseDeltaY * 0.0022;
  const mouseRoll = controls.mouseDeltaX * 0.0026;

  // --- Pitch: the stick, plus the wing's own tendency to drop its nose when it stops flying.
  let pitchRate = (controls.pitch + mousePitch) * AIRCRAFT.pitchRate * pitchAuth;
  if (airspeed < stalling && airborne) {
    pitchRate -= 0.9 * (1 - airspeed / stalling);
    events.push({ type: 'stall' });
  }
  state.pitch = Math.max(-1.15, Math.min(1.15, state.pitch + pitchRate * dt));

  // --- Roll and bank. The ailerons roll; the wing's dihedral rolls back toward level slowly, and
  // turbulence rocks the wings on top of that.
  let rollRate = (controls.roll + mouseRoll) * AIRCRAFT.rollRate * rollAuth;
  if (airborne) rollRate -= state.bank * 0.55;
  rollRate += g.roll;
  state.bank = Math.max(-1.35, Math.min(1.35, state.bank + rollRate * dt));

  // --- Turn: a banked wing turns the aircraft, and the turn is coordinated with the rudder.
  if (airborne) {
    // Turn rate scales with airspeed, so a headwind leg turns a little tighter than a tailwind one.
    const turnRate = Math.sin(state.bank) * AIRCRAFT.coordination * (airspeed / AIRCRAFT.cruise);
    state.heading += turnRate * dt;
    state.heading += controls.yaw * AIRCRAFT.yawRate * auth * dt;
    // A crosswind weathervanes the nose away from the wind: this is what the rudder is for.
    state.heading += (airX * Math.cos(state.heading) + airZ * Math.sin(state.heading)) * 0.0009 * dt;
  } else if (state.speed > 1) {
    const steer = Math.min(1, state.speed / 18);
    state.heading += (controls.yaw + controls.roll) * 0.62 * steer * dt;
  }

  // --- Vertical: the nose's climb angle sets the vertical speed, and a slow aircraft sinks.
  let climb = Math.sin(state.pitch) * state.speed;
  // Flaps carry the aircraft when the wing is slow, which is why they are the short-field tool.
  if (airborne && state.flaps > 0 && airspeed < AIRCRAFT.cruise) {
    climb += AIRCRAFT.flapSupport * state.flaps * 0.5 * (1 - airspeed / AIRCRAFT.cruise) * 0.35;
  }
  if (airspeed < stalling && airborne) {
    const lift = airspeed / stalling;
    climb = climb * lift - (1 - lift) * 14;
  }
  if (!airborne) climb = 0;
  // A gust rolls the airframe bodily: the vertical component is felt as a bump.
  climb += g.y;
  state.climb = climb;

  // --- Integrate the position along the nose's heading and pitch. This is ground velocity: the
  // airspeed above is what the wing flies on, but the aircraft goes where its ground track takes
  // it, which is the difference between a crab and a slip.
  const forwardX = Math.sin(state.heading) * Math.cos(state.pitch);
  const forwardZ = -Math.cos(state.heading) * Math.cos(state.pitch);
  state.position.x += forwardX * state.speed * dt;
  state.position.z += forwardZ * state.speed * dt;
  state.position.y += climb * dt;

  // --- Fuel burn: the throttle costs fuel, and idle still costs a little.
  if (fuelLeft) {
    const burn = AIRCRAFT.fuelBurn * (AIRCRAFT.idleBurn + (1 - AIRCRAFT.idleBurn) * state.throttle);
    const before = state.fuel;
    state.fuel = Math.max(0, state.fuel - burn * dt);
    if (before > 0 && state.fuel <= 0) events.push({ type: 'flameout' });
  }

  // --- Ground: the wheels touch when the aircraft's belly meets the land or the runway.
  const ground = Math.max(groundAt(state, state.position.x, state.position.z),
    overRunway(state.position.x, state.position.z) ? RUNWAY.elevation : -Infinity);
  const wheelHeight = 1.42;

  if (state.position.y - wheelHeight <= ground + 0.02) {
    if (!state.wheelsDown) {
      // Touchdown. Two things break an aeroplane here: sinking onto the ground too fast, and
      // touching down with a drift on. The drift is the crosswind's doing, and the pilot's job is
      // to take it out with the rudder before the wheels touch.
      const sink = -climb;
      const banked = Math.abs(state.bank);
      const fast = Math.max(0, state.speed - AIRCRAFT.cruise * 0.75);
      // Drift is the difference between where the nose points and where the aircraft is going.
      const velocityAngle = Math.atan2(
        forwardX * state.speed - airX * 0.0,
        -(forwardZ * state.speed - airZ * 0.0),
      );
      let drift = Math.abs(((velocityAngle - state.heading + Math.PI) % (Math.PI * 2)) - Math.PI);
      if (drift > Math.PI) drift = Math.PI * 2 - drift;
      // Sideways travel over the runway is what the tyre actually feels.
      const sideSlip = Math.abs(Math.sin(state.heading)) * 0 + drift * state.speed * 0.05;
      const crosswind = Math.abs(airX * Math.cos(state.heading) + airZ * Math.sin(state.heading));
      const windDamage = crosswind > AIRCRAFT.crosswindLimit
        ? (crosswind - AIRCRAFT.crosswindLimit) * 1.7
        : 0;

      const damage = Math.max(0, sink - 3.2) * 3.4 + banked * 16 + fast * 0.42
        + sideSlip * 2.2 + windDamage;
      if (damage > 2) {
        state.health = Math.max(0, state.health - damage);
        events.push({ type: 'touchdown', sink, damage, drift, crosswind });
        if (state.health <= 0) {
          state.destroyed = true;
          events.push({ type: 'crash', reason: 'hard landing' });
          return events;
        }
      } else {
        events.push({ type: 'touchdown', sink, damage: 0, drift, crosswind });
      }
    }
    state.position.y = ground + wheelHeight;
    state.pitch = Math.max(0, state.pitch);
    state.bank *= 0.5;
    state.wheelsDown = true;
    state.sinceTakeoff = 0;
    // On the ground the crosswind keeps pushing the aircraft sideways until it is slow.
    if (state.speed > 2) {
      const push = (airX * Math.cos(state.heading) + airZ * Math.sin(state.heading)) * 0.02 * dt;
      state.position.x += Math.cos(state.heading) * push;
      state.position.z += Math.sin(state.heading) * push;
    }
    if (state.speed < 0.4) state.speed = 0;
  } else {
    state.wheelsDown = false;
    state.sinceTakeoff += dt;
  }

  // --- Flying into terrain: the aircraft's own body meeting a hillside.
  if (state.position.y - 0.9 <= ground) {
    if (state.wheelsDown && state.speed < 26) {
      state.position.y = ground + wheelHeight;
    } else {
      state.destroyed = true;
      events.push({ type: 'crash', reason: 'terrain' });
      return events;
    }
  }

  // --- Ceiling: a soft lid keeps the aircraft inside the heightfield the world has.
  if (state.position.y > 3100) {
    state.position.y = 3100;
    state.pitch = Math.min(state.pitch, 0);
  }

  state.time = (state.time ?? 0) + dt;
  return events;
}

/** Resets the aircraft to a takeoff roll at the runway's threshold, pointed down the strip. */
export function resetToRunway(state) {
  // The threshold is the end the departure rolls from: half a length BEHIND the strip's centre
  // along the take-off heading, so the whole runway is ahead of the wheels.
  state.position.set(
    RUNWAY.x - Math.sin(RUNWAY.heading) * (RUNWAY.length * 0.5 - 90),
    RUNWAY.elevation + 1.42,
    RUNWAY.z + Math.cos(RUNWAY.heading) * (RUNWAY.length * 0.5 - 90),
  );
  state.heading = RUNWAY.heading;
  state.pitch = 0;
  state.bank = 0;
  state.speed = 0;
  state.airspeed = 0;
  state.climb = 0;
  state.throttle = 0;
  state.flaps = 0;
  state.fuel = AIRCRAFT.fuel;
  state.health = AIRCRAFT.health;
  state.onGround = true;
  state.wheelsDown = true;
  state.sinceTakeoff = 0;
  state.destroyed = false;
  state.time = 0;
}

/** Puts the aircraft in the air at a position and heading, for the screenshot scenes. */
export function placeInAir(state, x, y, z, heading, speed, pitch = 0, bank = 0) {
  state.position.set(x, y, z);
  state.heading = heading;
  state.pitch = pitch;
  state.bank = bank;
  state.speed = speed;
  state.airspeed = speed;
  state.throttle = 0.82;
  state.wheelsDown = false;
  state.destroyed = false;
  state.sinceTakeoff = 30;
  state.climb = Math.sin(pitch) * speed;
}

/**
 * A dead-reckoning autopilot, for the screenshot scenes and for the demonstration reel: it flies
 * the aircraft toward a gate, holding a sensible speed. It is not used by the game loop.
 */
export function autopilotToward(state, gate, dt) {
  const controls = emptyControls();
  const dx = gate.x - state.position.x;
  const dy = gate.y - state.position.y;
  const dz = gate.z - state.position.z;
  const bearing = Math.atan2(dx, -dz);
  let turn = ((bearing - state.heading + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  if (turn > Math.PI) turn -= Math.PI * 2;

  controls.roll = Math.max(-1, Math.min(1, turn * 2.6));
  const wantClimb = Math.atan2(dy, Math.hypot(dx, dz));
  controls.pitch = Math.max(-1, Math.min(1, (wantClimb - state.pitch) * 4.2));
  const wantSpeed = AIRCRAFT.cruise + 6;
  controls.throttle = state.speed < wantSpeed ? 1 : -0.4;
  controls.yaw = Math.max(-0.5, Math.min(0.5, turn * 0.7));
  return stepAircraft(state, controls, dt);
}
