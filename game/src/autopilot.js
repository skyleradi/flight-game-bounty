// The autopilot. It is a real controller on the same controls the pilot uses, so engaging it does
// not bend the flight model: it reads the aircraft state, decides what a careful pilot would do
// with the stick, the rudder and the throttle, and hands those numbers back to `stepAircraft`.
// Nothing here writes to the state directly.
//
// Three modes, chosen because they are the three things a pilot actually wants help with:
//
//   hold      wings level on a heading, altitude held. The "let go and look out of the window" mode.
//   course    fly the next gate, then the one after it. Track-following, not a rail: it banks into
//             the turn, leads the turn, and manages speed so it arrives with energy to spare.
//   approach  line up on the runway, descend on a glideslope, flare, and roll out. This is the one
//             that has to be honest, because a landing the autopilot cannot fly is a landing the
//             pilot cannot fly either.
//
// The controller is proportional with a rate damper rather than a PID with an integral term: an
// integrator that winds up during a long turn overshoots the next one, and the aircraft has no
// trim wheel to unwind it with.

import { AIRCRAFT, RUNWAY } from './config.js';
import { emptyControls, overRunway, runwayFrame } from './physics.js';

const DEG = Math.PI / 180;

/** Wraps an angle to (-PI, PI]. Every heading error in this file goes through it. */
export function wrapAngle(a) {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
}

/** Clamps to [-1, 1], the range every control axis lives in. */
function clamp1(x) {
  return Math.max(-1, Math.min(1, x));
}

/**
 * The glideslope the approach flies: three degrees, which is what a real light aircraft flies and
 * what the runway's approach lights are set for. Above the runway it flattens into the flare.
 */
const GLIDE = 3 * DEG;

export function createAutopilot() {
  const ap = {
    /** 'off' | 'hold' | 'course' | 'approach' */
    mode: 'off',
    /** What it is doing right now, for the HUD's one-line readout. */
    phase: '',
    /** Speed the pilot asked for, in m/s. `course` and `approach` override it. */
    targetSpeed: AIRCRAFT.cruise + 6,
    /** Altitude the `hold` mode is holding, captured when it engages. */
    holdAltitude: 0,
    holdHeading: 0,
    /** Set when the controller has decided the aircraft is down and should be braked. */
    landed: false,
    /** Smoothed control outputs, so the stick moves like a hand rather than a step function. */
    out: { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, brake: false },
    /** Counts seconds in the current mode, for the flare timing and the HUD. */
    t: 0,
  };

  function capture(state) {
    ap.holdAltitude = state.position.y;
    ap.holdHeading = state.heading;
    ap.targetSpeed = Math.max(AIRCRAFT.stall * 1.6, state.speed);
    ap.landed = false;
    ap.plan = null;
    ap.t = 0;
    ap.out = { pitch: 0, roll: 0, yaw: 0, throttle: state.throttle, flaps: 0, brake: false };
  }

  /** Engages a mode. `hold` captures the current heading and altitude; the others do not. */
  function engage(mode, state) {
    if (mode === 'off') {
      ap.mode = 'off';
      ap.phase = '';
      return;
    }
    capture(state);
    ap.mode = mode;
    ap.phase = mode === 'hold' ? 'holding' : mode === 'course' ? 'course' : 'approach';
  }

  function disengage() {
    ap.mode = 'off';
    ap.phase = '';
  }

  /**
   * Heading error to a point, in the aircraft's own frame: positive means "turn right". The bearing
   * is computed from the ground track the aircraft actually has, not from its nose, so a crab in a
   * crosswind is corrected rather than flown into.
   */
  function bearingTo(state, x, z) {
    return Math.atan2(x - state.position.x, -(z - state.position.z));
  }

  /**
   * Turns toward a heading with a bank, and leads the turn: the bank is released early enough that
   * the wing's own coordination rate rolls out on the target rather than past it. Without the lead
   * the aircraft overshoots every gate by ten or fifteen degrees and then hunts.
   */
  function rollToward(state, error, aggression = 1) {
    // Rate the wing will actually turn at, at this airspeed and bank, from the flight model's own
    // coordination figure: the controller has to know it or it cannot lead the turn.
    const turnRate = AIRCRAFT.coordination * (state.speed / AIRCRAFT.cruise);
    const lead = error - Math.sign(error) * Math.min(Math.abs(error) * 0.35, turnRate * 0.55);
    const wantBank = Math.max(-1.05, Math.min(1.05, lead * 1.9));
    const bankError = wantBank - state.bank;
    return clamp1(bankError * 2.4 * aggression);
  }

  /**
   * Pitch to hold a vertical speed. The flight model maps pitch to climb through speed, so the
   * controller works in climb rate and lets the pitch fall out of it: commanding pitch directly
   * makes the aircraft porpoise as the airspeed changes underneath it.
   */
  function pitchForClimb(state, wantClimb) {
    const speed = Math.max(6, state.speed);
    const wantPitch = Math.asin(Math.max(-0.5, Math.min(0.5, wantClimb / speed)));
    const err = wantPitch - state.pitch;
    return clamp1(err * 5.2);
  }

  /** Throttle to hold an airspeed, with a deadband so the lever does not hunt. */
  function throttleForSpeed(state, want, dt) {
    const err = want - state.speed;
    if (Math.abs(err) < 0.8) return 0;
    return clamp1(err * 0.32 * (dt > 0 ? 1 : 1));
  }

  /**
   * The `hold` mode: wings level, altitude and heading captured at engage. Heading is held with the
   * rudder's fine authority over the top of the bank loop, so a crosswind does not walk the nose.
   */
  function stepHold(state, dt) {
    const headingErr = wrapAngle(ap.holdHeading - state.heading);
    const bank = rollToward(state, headingErr, 0.85);
    const climbErr = (ap.holdAltitude - state.position.y) * 0.42;
    const wantClimb = Math.max(-6, Math.min(6, climbErr));
    ap.out.pitch = pitchForClimb(state, wantClimb);
    ap.out.roll = bank;
    ap.out.yaw = clamp1(headingErr * 1.6);
    ap.out.throttle = throttleForSpeed(state, ap.targetSpeed, dt);
    ap.out.flaps = state.speed < AIRCRAFT.stall * 1.5 ? 1 : 0;
    ap.out.brake = false;
    ap.phase = 'holding';
  }

  /**
   * The `course` mode: fly the next gate. It leads the aim point by a distance that grows with the
   * closing speed, which is what makes the aircraft arrive at the ring pointing through it rather
   * than at it.
   */
  function stepCourse(state, gate, dt, allGates) {
    if (!gate) {
      // No gate left: the course is flown, so the useful thing is to line up and land.
      return stepApproach(state, dt, allGates);
    }
    const dist = Math.hypot(gate.x - state.position.x, gate.z - state.position.z);
    // Aim at a point short of the ring, so the aircraft is already straight when it gets there.
    const lead = Math.min(dist * 0.45, 320);
    const aimX = gate.x - Math.sin(gate.heading) * lead;
    const aimZ = gate.z + Math.cos(gate.heading) * lead;
    const bearing = bearingTo(state, aimX, aimZ);
    const err = wrapAngle(bearing - state.heading);

    ap.out.roll = rollToward(state, err, 1);
    ap.out.yaw = clamp1(err * 1.1);

    // Height: aim at the gate's own height, with a floor so the aircraft never descends into a
    // ridge to reach a ring. The terrain sampler is the authority, exactly as it is for the pilot.
    const ground = state.terrain ? state.terrain(state.position.x, state.position.z) : 0;
    const wantY = Math.max(gate.y, ground + 55);
    const dy = wantY - state.position.y;
    // A dive for a low gate and a climb for a high one, limited to a sane rate, and biased upward
    // when the aircraft is close to the ground.
    const wantClimb = Math.max(-14, Math.min(13, dy * 0.55 + (dy > 0 ? 1.5 : 0)));
    ap.out.pitch = pitchForClimb(state, wantClimb);

    // Speed: arrive with energy. Fast when far, on the numbers when close, and the gate's own turn
    // is what decides whether that is enough.
    const want = dist > 900 ? AIRCRAFT.cruise + 22 : AIRCRAFT.cruise + 4;
    ap.out.throttle = throttleForSpeed(state, want, dt);
    ap.out.flaps = 0;
    ap.out.brake = false;
    ap.phase = `course · ${Math.round(dist)} m`;
  }

  /**
   * APPROACH GEOMETRY, DERIVED FROM THE HEIGHTFIELD.
   *
   * The strip sits at 58 m at the bottom of a valley, and the terrain on the extended centreline
   * climbs to several hundred metres within a few kilometres. Measured against the real heightfield,
   * a textbook three-degree straight-in is 449 m BELOW the ground 4.75 km out: no constant angle
   * clears it from that side. So the approach is planned rather than assumed.
   *
   * Both runway directions are scored by the highest terrain inside a narrow corridor, and the
   * clearer one is flown. The descent profile is then built from the terrain itself:
   *
   *   required(d) = max over d' <= d of ( terrain(d') + CLEAR + (d - d') * GRADIENT )
   *
   * which is the lowest path that clears every point it is going to overfly without ever asking for
   * a descent steeper than a normal approach. It is evaluated once per sortie into a table.
   *
   * Inside the last few hundred metres the clearance tapers away, because there the aircraft is over
   * the runway itself and the only "obstacle" left is the surface it is about to touch.
   */
  const AP_CLEAR = 70;
  const AP_SPAN = 4200;
  const AP_STEP = 25;
  const AP_LAT = 60;
  /** Distance over which the terrain clearance fades out as the aircraft nears the touchdown point. */
  const AP_CLEAR_TAPER = 700;
  /**
   * The steepest descent the planned path is allowed to ask for, in radians. Fifteen degrees is the
   * outer limit for a light aircraft on a short field; anything steeper is a dive, not an approach.
   */
  const AP_MAX_GRAD = 15 * DEG;
  /**
   * How far INSIDE the strip the wheels are meant to touch, measured from the threshold at that end.
   * Aiming at the threshold itself leaves no margin: a fifty-metre float puts the wheels past the
   * end of the asphalt and into whatever is beyond it, which here is a valley floor sixty metres
   * below the strip. An inset gives the flare somewhere to float and still leaves most of the
   * runway to roll out on.
   */
  const TD_INSET = 250;

  /** The heading flown inbound: the runway's own direction, or its reciprocal. */
  function inboundHeading(dir) {
    return dir > 0 ? RUNWAY.heading : RUNWAY.heading + Math.PI;
  }

  /**
   * World point `d` metres from the touchdown point, out along the approach axis, offset `lateral`
   * metres to the left of the inbound track. `d` is 0 at touchdown and grows backwards up the final.
   */
  function approachPoint(dir, d, lateral = 0) {
    const hIn = inboundHeading(dir);
    // The threshold is the end the aircraft lands over; the touchdown point is TD_INSET inside it.
    const sT = dir > 0
      ? -RUNWAY.length * 0.5 + TD_INSET
      : RUNWAY.length * 0.5 - TD_INSET;
    const bx = RUNWAY.x + Math.sin(RUNWAY.heading) * sT;
    const bz = RUNWAY.z - Math.cos(RUNWAY.heading) * sT;
    // Outbound from the touchdown point is the reciprocal of the inbound heading.
    const ox = -Math.sin(hIn);
    const oz = Math.cos(hIn);
    const lx = Math.sin(hIn + Math.PI / 2);
    const lz = -Math.cos(hIn + Math.PI / 2);
    return { x: bx + ox * d + lx * lateral, z: bz + oz * d + lz * lateral };
  }

  /** Plans (or returns the cached plan for) this sortie's approach. */
  function planApproach(state, force = false) {
    if (ap.plan && !force) return ap.plan;
    const sampler = state.terrain;
    const height = (x, z) => (sampler ? sampler(x, z) : RUNWAY.elevation);

    const corridor = (dir) => {
      let worst = RUNWAY.elevation;
      for (let d = 0; d <= AP_SPAN; d += 50) {
        for (const lat of [-AP_LAT, 0, AP_LAT]) {
          const p = approachPoint(dir, d, lat);
          const t = height(p.x, p.z);
          if (t > worst) worst = t;
        }
      }
      return worst;
    };

    const scores = [1, -1].map((dir) => ({ dir, worst: corridor(dir) }));
    scores.sort((a, b) => a.worst - b.worst);
    const dir = scores[0].dir;

    const n = Math.floor(AP_SPAN / AP_STEP) + 1;
    const terr = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const p = approachPoint(dir, i * AP_STEP);
      terr[i] = Math.max(height(p.x, p.z), RUNWAY.elevation);
    }

    // The ceiling: the height that clears the terrain by AP_CLEAR at each distance, fading to
    // nothing over the runway itself.
    const ceiling = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const d = i * AP_STEP;
      const clear = AP_CLEAR * Math.min(1, d / AP_CLEAR_TAPER);
      ceiling[i] = Math.max(terr[i] + clear, RUNWAY.elevation);
    }

    // The path: the LOWEST line that (a) sits on the runway at d = 0 and (b) never descends inbound
    // faster than AP_MAX_GRAD. Built backwards from the far end, because the constraint that binds
    // is the descent rate, and a descent rate is a relationship between two adjacent points.
    //
    // A single fixed gradient cannot do this job here. Three degrees is too shallow: it clears the
    // ridge 3 km out only by staying 200 m high over the threshold, and no amount of floating gets
    // an aircraft down from there. A gradient steep enough to work everywhere is an unrealistic
    // dive at the far end. So the path takes whatever gradient each stretch of terrain demands, up
    // to a limit a real pilot would fly, and is flat where the terrain lets it be.
    const g = Math.tan(GLIDE);
    const maxRise = AP_STEP * Math.tan(AP_MAX_GRAD);
    const table = new Float64Array(n);
    table[n - 1] = ceiling[n - 1];
    for (let i = n - 2; i >= 0; i -= 1) {
      table[i] = Math.max(ceiling[i], table[i + 1] - maxRise);
    }
    // Where the terrain leaves room, prefer the ordinary three-degree profile: without this the
    // path would hug the ground all the way in, which is not how anyone flies an approach.
    for (let i = 1; i < n; i += 1) {
      const preferred = RUNWAY.elevation + i * AP_STEP * g;
      table[i] = Math.min(table[i], Math.max(preferred, table[0]));
    }

    ap.plan = { dir, scores, table, n, clearance: scores[0].worst };
    return ap.plan;
  }

  /** The height the approach wants to be at, `d` metres from touchdown. */
  function requiredHeight(plan, d) {
    const base = RUNWAY.elevation + Math.max(0, d) * Math.tan(GLIDE);
    if (!plan) return base;
    const x = Math.max(0, Math.min(AP_SPAN, d)) / AP_STEP;
    const i = Math.floor(x);
    const a = plan.table[Math.min(i, plan.n - 1)];
    const b = plan.table[Math.min(i + 1, plan.n - 1)];
    return Math.max(base, a + (b - a) * (x - i));
  }

  /**
   * The `approach` mode. Four legs, chosen by where the aircraft is relative to the planned final:
   *
   *   lineup   fly to the hold point up the final, at a safe transit height
   *   glide    track the centreline down the planned profile at approach speed
   *   flare    over the threshold: chop the power, raise the nose, hold it off
   *   rollout  wheels down: keep it straight, brake, until it stops
   */
  function stepApproach(state, dt, allGates) {
    const plan = planApproach(state);
    const hIn = inboundHeading(plan.dir);
    const T = approachPoint(plan.dir, 0);
    const ux = Math.sin(hIn);
    const uz = -Math.cos(hIn);
    const lx = Math.sin(hIn + Math.PI / 2);
    const lz = -Math.cos(hIn + Math.PI / 2);

    // Metres still to fly before the touchdown point: positive on approach.
    const toTouch = (T.x - state.position.x) * ux + (T.z - state.position.z) * uz;
    // Metres left or right of the inbound track.
    const lateral = (state.position.x - T.x) * lx + (state.position.z - T.z) * lz;
    const heightAgl = state.position.y - RUNWAY.elevation;

    // --- Down and stopped: the mode's work is done.
    if (state.wheelsDown && state.speed < 1.5) {
      ap.out.throttle = -1;
      ap.out.brake = true;
      ap.out.pitch = 0;
      ap.out.roll = 0;
      ap.out.yaw = clamp1(wrapAngle(hIn - state.heading) * 1.2);
      ap.out.flaps = 2;
      ap.landed = true;
      ap.phase = 'down';
      return;
    }

    // --- Rolling out: keep it on the centreline and brake.
    if (state.wheelsDown) {
      const drift = wrapAngle(hIn - state.heading);
      ap.out.yaw = clamp1(drift * 1.6);
      ap.out.roll = clamp1(-state.bank * 1.8);
      ap.out.pitch = state.pitch > 0.02 ? -0.45 : 0;
      ap.out.throttle = -1;
      ap.out.brake = true;
      ap.out.flaps = 2;
      ap.phase = 'rollout';
      return;
    }

    // --- lineup. Flown until the aircraft is established on the final: on the axis, pointed down
    // it, and inside the planned profile. Turning final from six kilometres away just flies a long
    // diagonal at the runway and arrives sideways.
    //
    // The hold point is exactly AP_SPAN out, so `established` has to accept that distance: an
    // earlier version tested `<= AP_SPAN * 0.98` and left the aircraft aiming at the point it was
    // already sitting on, which it orbited for four minutes without ever starting the descent.
    const onAxis = Math.abs(lateral) < 260;
    const established = toTouch <= AP_SPAN && toTouch > -40 && onAxis
      && Math.abs(wrapAngle(hIn - state.heading)) < 0.9;
    if (!established) {
      const hold = approachPoint(plan.dir, AP_SPAN);
      const err = wrapAngle(bearingTo(state, hold.x, hold.z) - state.heading);
      ap.out.roll = rollToward(state, err, 1);
      ap.out.yaw = clamp1(err * 1.2);
      // Transit high enough to clear everything on the way in, plus a margin.
      const transitY = plan.clearance + 260;
      const dy = transitY - state.position.y;
      ap.out.pitch = pitchForClimb(state, Math.max(-9, Math.min(9, dy * 0.4)));
      const wantSpeed = AIRCRAFT.cruise + 4;
      ap.out.throttle = throttleForSpeed(state, wantSpeed, dt);
      ap.out.flaps = 0;
      ap.out.brake = false;
      ap.phase = `lineup · ${Math.round(Math.max(0, toTouch))} m`;
      return;
    }

    // --- glide. Track: aim at a point on the centreline ahead, clamped so it never runs past the
    // touchdown point, which would make the bearing noisy.
    const lookAhead = Math.min(320, Math.max(70, toTouch));
    const aimD = Math.max(0, toTouch - lookAhead);
    const aim = approachPoint(plan.dir, aimD);
    const err = wrapAngle(bearingTo(state, aim.x, aim.z) - state.heading);

    ap.out.roll = rollToward(state, err, 1.15);
    const core = state.wind ?? { x: 0, z: 0 };
    const crossTrack = (core.x * Math.cos(state.heading) + core.z * Math.sin(state.heading)) * 0.012;
    ap.out.yaw = clamp1(err * 1.6 - crossTrack);
    ap.out.flaps = 2;
    ap.out.brake = false;

    // --- flare: over the threshold with the wheels close. Power off, raise the nose, and hold the
    // aircraft off the runway while it bleeds speed.
    //
    // The flare cannot just command a nose-up attitude: the flight model turns pitch into climb as
    // `sin(pitch) * speed`, so a fixed 0.115 rad at 36 m/s is a three-metre-per-second CLIMB, and
    // the aircraft balloons away from the runway instead of settling onto it. So the flare commands
    // a sink rate instead of an attitude — a gentle 0.6 m/s descending to touchdown — and lets the
    // pitch fall out of that. Nose-up attitude is the result, not the instruction.
    if (toTouch < 420 && heightAgl < 30) {
      // A flare trades speed for height: the nose comes up, the sink rate decays toward a gentle
      // touchdown, and the aircraft settles. The sink rate is the controlled quantity, not the
      // attitude — `climb = sin(pitch) * speed` means a commanded nose-up attitude is a commanded
      // CLIMB, and a floor on the pitch holds the aircraft off the ground forever.
      //
      // The target is a descent that reaches the ground from the current height, so the flare gets
      // firmer the closer the runway is and cannot stall in the hold-off.
      const wantSink = -Math.max(0.5, heightAgl * 0.22);
      const err = wantSink - state.climb;
      const wantPitch = Math.max(-0.10, Math.min(0.18, state.pitch + err * 0.11));
      ap.out.pitch = clamp1((wantPitch - state.pitch) * 6);
      ap.out.throttle = -1;
      ap.out.brake = false;
      ap.out.flaps = 2;
      ap.phase = 'flare';
      return;
    }

    // Vertical: chase the planned profile. The target rate is the profile's own slope, corrected by
    // the height error, so the aircraft converges on the path instead of chasing it.
    const targetY = requiredHeight(plan, toTouch);
    const dy = targetY - state.position.y;
    const slopeSink = -Math.max(1.4, state.speed * Math.tan(GLIDE));
    const wantClimb = Math.max(-12, Math.min(6, slopeSink + dy * 0.5));
    ap.out.pitch = pitchForClimb(state, wantClimb);

    // Speed on the approach: full flap, a margin over the stall, slower as the ground comes up.
    const want = AIRCRAFT.stall * 1.34 + Math.min(7, Math.max(0, heightAgl) * 0.02);
    ap.out.throttle = throttleForSpeed(state, want, dt);
    ap.phase = `glide · ${Math.round(heightAgl)} m agl`;
  }

  /**
   * One autopilot step. Returns the controls the flight model should be stepped with. The outputs
   * are smoothed toward their targets so a mode change does not snap the stick across.
   */
  function update(state, { gate = null, gates = [], dt = 1 / 120 } = {}) {
    if (ap.mode === 'off') return null;
    ap.t += dt;

    if (ap.mode === 'hold') stepHold(state, dt);
    else if (ap.mode === 'course') stepCourse(state, gate, dt, gates);
    else if (ap.mode === 'approach') stepApproach(state, dt, gates);

    const controls = emptyControls();
    controls.pitch = ap.out.pitch;
    controls.roll = ap.out.roll;
    controls.yaw = ap.out.yaw;
    controls.throttle = ap.out.throttle;
    controls.flaps = ap.out.flaps;
    controls.brake = ap.out.brake;
    controls.boost = false;
    controls.fire = false;
    controls.mouseDeltaX = 0;
    controls.mouseDeltaY = 0;
    return controls;
  }

  return {
    engage, disengage, update,
    get mode() { return ap.mode; },
    get phase() { return ap.phase; },
    get landed() { return ap.landed; },
    isOn: () => ap.mode !== 'off',
    /** The planned final, for the HUD and for the tests. Null until a plan has been made. */
    plan: () => ap.plan,
    /** Where the aircraft should be to start the final, and the heading to fly there. */
    holdPoint: (state) => {
      const plan = planApproach(state);
      const p = approachPoint(plan.dir, AP_SPAN);
      // Start ON the planned path (plus a margin), not merely above the highest hill: the profile
      // at this distance is what the aircraft has to intercept, and starting below it means the
      // first thing the mode does is climb away from the runway.
      return { ...p, heading: inboundHeading(plan.dir), height: requiredHeight(plan, AP_SPAN) + 60 };
    },
    clearance: (d, state) => requiredHeight(planApproach(state), d),
    /** Cycles off → hold → course → approach → off, for a single key. */
    cycle(state, gate) {
      if (ap.mode === 'off') engage('hold', state);
      else if (ap.mode === 'hold') engage('course', state);
      else if (ap.mode === 'course') engage('approach', state);
      else disengage();
      return ap.mode;
    },
  };
}
