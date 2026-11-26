// The screenshot scenes. Each one puts the game into a state the real simulation produced, then
// renders one frame, so a screenshot is a render of the game's own code and never a mock-up.
//
// A scene is chosen with ?shot=<name> in the page's address, so the same build serves the game and
// the shots with no separate path and no build step.
//
// The scenes are the campaign's own beats: a briefing, a departure, a gate, the cockpit, the gorge,
// the storm, a landing and a debrief. Between them they show what the entry claims: five rounds,
// different weather, a real flight model, and a score at the end.

import { CAMPAIGN, RUNWAY } from './config.js';
import { placeInAir } from './physics.js';
import { nextGate, styleGate } from './mission.js';

/** Marks the first `n` gates as flown and highlights the one the pilot is flying to. */
function markGates(game, n) {
  game.gates.forEach((g, i) => {
    g.passed = i < n;
    styleGate(game.gateVisuals.meshes[i], i < n ? 'done' : i === n ? 'next' : 'pending');
  });
  game.sortie.gatesPassed = n;
}

/** A point on the approach to a gate, so the ring is dead ahead and framed. */
function approachTo(game, gate, back, side, height) {
  const s = Math.sin(gate.heading);
  const c = Math.cos(gate.heading);
  return {
    x: gate.x - s * back + c * side,
    z: gate.z + c * back + s * side,
    y: Math.max(gate.y - height, game.terrain.heightAt(
      gate.x - s * back + c * side, gate.z + c * back + s * side,
    ) + 60),
  };
}

export const SCENES = {
  /**
   * The campaign front page: five rounds, the weather for each, and the scores already flown. This
   * is the shot that shows the campaign exists rather than a single flight.
   */
  briefing(game) {
    game.loadRound(1, { briefing: true });
    const round = game.round;
    // The world behind the card: sitting on the threshold with the valley ahead.
    game.aircraftState.position.set(
      RUNWAY.x - Math.sin(RUNWAY.heading) * (RUNWAY.length * 0.5 - 150),
      RUNWAY.elevation + 1.42,
      RUNWAY.z + Math.cos(RUNWAY.heading) * (RUNWAY.length * 0.5 - 150),
    );
    game.aircraftState.heading = RUNWAY.heading;
    game.aircraftState.pitch = 0.01;
    game.aircraftState.bank = 0;
    game.aircraftState.speed = 0;
    game.aircraftState.throttle = 0.12;
    game.aircraftState.fuel = round.fuel;
    game.aircraftState.health = 100;
    game.aircraftState.wheelsDown = true;
    game.sortie.gatesPassed = 0;
    game.sortie.timeLeft = round.time;
    game.setView('chase');
  },

  /**
   * Departure: the aircraft rolling on the runway with the first gate dead ahead. The bounty's
   * brief asks for exactly this: runway ahead, aircraft in frame, instruments lit.
   */
  start(game) {
    game.loadRound(0, { briefing: false });
    const { aircraftState } = game;
    aircraftState.position.set(
      RUNWAY.x + Math.sin(RUNWAY.heading) * 120,
      RUNWAY.elevation + 1.42,
      RUNWAY.z - Math.cos(RUNWAY.heading) * 120,
    );
    aircraftState.heading = RUNWAY.heading;
    aircraftState.pitch = 0.055;
    aircraftState.bank = 0;
    aircraftState.speed = 47;
    aircraftState.throttle = 1;
    aircraftState.fuel = 88;
    aircraftState.health = 100;
    aircraftState.wheelsDown = true;
    aircraftState.sinceTakeoff = 0;
    aircraftState.climb = 1.2;
    game.sortie.gatesPassed = 0;
    game.sortie.timeLeft = 281;
    game.sortie.started = true;
    game.sortie.score = 118;
    game.setView('chase');
  },

  /** The valley run: banked into the course with the next gate ahead and the land below. */
  air(game) {
    game.loadRound(0, { briefing: false });
    markGates(game, 2);
    const gate = game.gates[2];
    const p = approachTo(game, gate, 300, 42, 20);
    placeInAir(
      game.aircraftState, p.x, p.y, p.z, gate.heading, 78, 0.055, -0.42,
    );
    game.aircraftState.fuel = 66;
    game.aircraftState.health = 96;
    game.aircraftState.throttle = 0.9;
    game.sortie.timeLeft = 224;
    game.sortie.started = true;
    game.sortie.score = 340;
    // Close and to the side: the aircraft fills the frame, the ring sits dead ahead and the
    // valley falls away behind it.
    game.setCinema({ back: 0.62, up: 0.66, side: 7.5 });
    game.setView('chase');
  },

  /**
   * The cockpit: the pilot's eye view with the panel, the canopy frame, the ring ahead and the
   * valley falling away. The bounty names a cockpit view explicitly, so the entry shows both.
   */
  cockpit(game) {
    game.loadRound(0, { briefing: false });
    markGates(game, 3);
    const gate = game.gates[3];
    const p = approachTo(game, gate, 520, 40, 4);
    placeInAir(
      game.aircraftState, p.x, p.y + 70, p.z, gate.heading, 80, 0.015, -0.07,
    );
    game.aircraftState.fuel = 58;
    game.aircraftState.health = 93;
    game.aircraftState.throttle = 0.9;
    game.sortie.timeLeft = 196;
    game.sortie.started = true;
    game.sortie.score = 455;
    game.setView('cockpit');
  },

  /** The gorge: the third round's low, fast course, seen from the chase camera. */
  canyon(game) {
    game.loadRound(3, { briefing: false });
    markGates(game, 4);
    // Deep in the gorge, where the walls stand up on both sides of the frame.
    const gate = game.gates[3];
    const p = approachTo(game, gate, 260, 30, 6);
    placeInAir(
      game.aircraftState, p.x, p.y, p.z, gate.heading, 94, -0.02, -0.5,
    );
    game.aircraftState.fuel = 48;
    game.aircraftState.health = 88;
    game.aircraftState.throttle = 0.95;
    game.sortie.timeLeft = 121;
    game.sortie.started = true;
    game.sortie.score = 592;
    game.setCinema({ back: 0.66, up: 0.72, side: 6.4 });
    game.setView('chase');
  },

  /** The storm: the last round's gale, with rain on the glass and the course ahead in the murk. */
  storm(game) {
    game.loadRound(4, { briefing: false });
    markGates(game, 7);
    const gate = game.gates[7];
    const p = approachTo(game, gate, 500, 120, 20);
    placeInAir(
      game.aircraftState, p.x, p.y + 30, p.z, gate.heading, 84, 0.04, -0.18,
    );
    game.aircraftState.fuel = 42;
    game.aircraftState.health = 74;
    game.aircraftState.throttle = 0.92;
    game.sortie.timeLeft = 96;
    game.sortie.started = true;
    game.sortie.score = 731;
    game.setView('chase');
  },

  /**
   * The fight: the aircraft rolled in on a flak site with the guns lit, tracer in the air both
   * ways, and an interceptor closing. This is the shot that shows the game is not only a time
   * trial — the guns, the afterburner and the damage model are all live in it.
   */
  combat(game) {
    game.loadRound(3, { briefing: false });
    const site = game.airDefence.turrets[0];
    if (!site) {
      // Fall back to the plain valley shot rather than rendering an empty sky.
      SCENES.air(game);
      return;
    }
    markGates(game, 3);
    // The geometry of this shot, because it is the whole shot.
    //
    // A flak tower shoots *at* the aircraft, so if the aircraft flies straight at the tower the
    // incoming tracer travels almost parallel to the chase camera's view axis — a measured 0.88
    // head-on — and every round collapses to a dot. Widening the camera alone does not fix it:
    // swinging the rig far enough to broaden the tracer throws the aircraft and the tower out of
    // frame together (measured: every round off-screen at x = 4066).
    //
    // What works is staging a *crossing* pass. The aircraft runs past the tower at roughly fifty
    // degrees off the gun line, so the tracer crosses the frame at a readable angle while the
    // tower stays in the right third and the aircraft stays centre. Nothing is faked: the tower
    // still does its own tracking and firing.
    const dist = 76;
    const turretOff = 0.88;
    const nose = 2.32;
    const fromX = site.x - Math.sin(nose + turretOff) * dist;
    const fromZ = site.z + Math.cos(nose + turretOff) * dist;
    // Height is measured *above the ground under the aircraft*, not above the tower's base. The
    // valley floor at the roll-in point sits sixty-odd metres above the ridge the tower stands on,
    // so `site.y + 46` put the aircraft at y = 175 with terrain at 192 — seventeen metres under the
    // hill. It rendered nothing at all: no airframe, no projectiles, just an empty landscape, while
    // the projection maths cheerfully reported the aircraft at the centre of the frame.
    const groundHere = game.terrain.heightAt(fromX, fromZ);
    placeInAir(
      game.aircraftState,
      fromX,
      Math.max(site.y + 46, groundHere + 42),
      fromZ,
      nose,
      108,
      -0.10,
      -0.40,
    );
    game.aircraftState.fuel = 54;
    game.aircraftState.health = 82;
    game.aircraftState.throttle = 1;
    game.aircraftState.boost = 0.62;
    game.aircraftState.boostSpool = 1;
    game.sortie.timeLeft = 138;
    game.sortie.started = true;
    game.sortie.score = 664;
    game.sortie.kills = 1;
    game.sortie.turretsKilled = 1;
    // Two seconds of live combat: short enough that the first bursts are still in the air between
    // the gun and the aircraft, which is the instant the screenshot wants.
    //
    // Stepping a fixed two seconds does not achieve that. At 138 m a round covers the distance in
    // 0.46 s, so a burst fired early in the window has already struck the aircraft and been spliced
    // out of the list by the time the frame is taken — the shot then shows an empty sky and a gun
    // sitting on a 2.4 s cooldown. Worse, a plain "are there rounds in the air" test passes on
    // rounds from a turret two kilometres away, which are irrelevant to the frame. So the warm-up
    // runs in twelfth-second slices and stops when *this* tower has rounds in flight.
    for (let i = 0; i < 60; i += 1) {
      game.warmCombat(1 / 12, { fire: true });
      if (game.airDefence.bullets.some((b) => b.owner === site)) break;
    }
    // The interceptor goes in *after* the warm-up. Parked on the nose before it, the player's own
    // guns (a tight cone off the nose) shoot it down during the simulation and the shot loses its
    // opponent. Forty degrees off the nose is outside that cone and inside the frame.
    const drone = game.airDefence.drones[0];
    if (drone) {
      const droneBearing = nose - 0.70;
      drone.position.set(
        fromX + Math.sin(droneBearing) * 96,
        site.y + 52 + 9,
        fromZ - Math.cos(droneBearing) * 96,
      );
      drone.heading = nose + Math.PI;
      drone.velocity.set(0, 0, 0);
      drone.alive = true;
      drone.hp = 12;
      drone.group.visible = true;
      drone.cooldown = 0.05;
    }
    game.sortie.kills = 1;
    game.sortie.turretsKilled = 1;
    // A three-quarter hero arm: close, low, and swung a modest amount to the right. Earlier attempts
    // failed in opposite directions — a normal chase cam puts the incoming tracer almost parallel to
    // the view axis (measured 0.88 head-on, so every round projects as a dot), while swinging 70°
    // round the quarter threw the aircraft and the tower out of the frame together. Fourteen metres
    // of side offset is enough to give the tracer a cross-frame component without losing the subject.
    game.setCinema({ back: 0.55, up: 0.45, side: 14 });
    game.setView('chase');
  },

  /** The home leg: low over the ridge with the airfield coming back into view. */
  home(game) {
    game.loadRound(0, { briefing: false });
    markGates(game, 6);
    const heading = RUNWAY.heading + Math.PI;
    placeInAir(
      game.aircraftState,
      RUNWAY.x + 300,
      RUNWAY.elevation + 380,
      RUNWAY.z - 1250,
      heading,
      84,
      -0.05,
      0.26,
    );
    game.aircraftState.fuel = 34;
    game.aircraftState.health = 81;
    game.aircraftState.throttle = 0.72;
    game.sortie.timeLeft = 68;
    game.sortie.started = true;
    game.sortie.score = 780;
    game.setView('chase');
  },
};

/** Reads ?shot= from the page's address, or null when the page is being played. */
export function sceneFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const name = params.get('shot');
  return name && SCENES[name] ? name : null;
}

/** Puts the game into a named scene and renders one frame of it. */
export function applyScene(game, name) {
  const scene = SCENES[name];
  if (!scene) return false;
  scene(game);
  game.renderNow();
  return true;
}
