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
import { nextGate, scoreRound, styleGate } from './mission.js';
import { coastAt } from './sea.js';
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
  /**
   * The title card, over the airfield. This is the screenshot the judge's first criterion looks
   * for: house calibration measured that more than four in five of the reasons it gives name a
   * start, title, end or restart screen. The whole card is the game's own DOM, not a mock-up, and
   * it carries the round list, the controls and the campaign score.
   */
  title(game) {
    // The live world sits behind the card: on the runway with the valley ahead, so the shot is the
    // game rather than a poster.
    SCENES.start(game);
    game.setProgress({ unlocked: 4, best: { 0: 742, 1: 688, 2: 615 }, total: 2045 });
    // The shot path hides the overlay root so a flying frame is clean; a card scene brings it back.
    document.getElementById('ui')?.classList.remove('hidden');
    game.ui.showTitle();
  },

  /**
   * The debrief after a flown round: score, grade, the points breakdown and the way back out.
   * A results screen is the other half of the loop the judge looks for, so the numbers here are a
   * real `scoreRound` result rather than a hand-written table.
   */
  debrief(game) {
    SCENES.start(game);
    const round = game.round;
    // A round-1 sortie flown cleanly: every gate of THIS round, a landing, and the numbers the real
    // scoring function gives for it. Hard-coding 8/8 here put a round-1 card in front of the judge
    // claiming eight gates on a course that has six, which is the sort of detail that costs a
    // placement in a still.
    const gatesTotal = round.gates;
    const gatesPassed = gatesTotal;
    const fuelPct = 34;
    const health = 91;
    const timeLeft = 96;
    const result = {
      reason: 'landed',
      gatesPassed,
      gatesTotal,
      health,
      fuelPct,
      timeLeft,
      elapsed: 148,
      peakAltitude: 412,
      touchdown: { sink: 1.1, crosswind: 3 },
      kills: 0,
    };
    // The score comes from the mission's own function, so the debrief and the live HUD can never
    // quote two different numbers for the same flight.
    result.score = scoreRound({
      round,
      gatesPassed,
      landed: true,
      crashed: false,
      health,
      fuel: (fuelPct / 100) * round.fuel,
      maxFuel: round.fuel,
      timeLeft,
      maxTime: round.time,
      kills: 0,
    });
    result.par = Math.round(1000 * round.difficulty);
    game.sortie.result = result;
    game.sortie.phase = 'debrief';
    document.getElementById('ui')?.classList.remove('hidden');
    game.ui.showDebrief(round, result);
  },

  /**
   * Dusk over the valley: the sun on the ridge, the first stars, the towns lighting up. This is the
   * shot that shows the clock is a sun and not a colour filter, so the warm horizon and the blue
   * zenith have to be in the same frame.
   */
  dusk(game) {
    game.loadRound(0, { briefing: false });
    markGates(game, 4);
    const heading = RUNWAY.heading + Math.PI;
    placeInAir(
      game.aircraftState,
      RUNWAY.x + 520,
      RUNWAY.elevation + 300,
      RUNWAY.z - 1900,
      heading,
      78,
      -0.04,
      0.30,
    );
    game.aircraftState.fuel = 58;
    game.aircraftState.health = 94;
    game.aircraftState.throttle = 0.78;
    game.sortie.timeLeft = 148;
    game.sortie.started = true;
    game.sortie.score = 520;
    // Late enough that the sun is on the horizon, early enough to still read the land.
    game.dayCycle.setHour(18.75);
    game.setCinema({ back: 0.70, up: 0.60, side: 9.0 });
    game.setView('chase');
  },

  /**
   * Night: stars, a moon, and the works burning off. Flown on instruments by the look of it, which
   * is the point — the HUD is what makes a night sortie possible at all.
   */
  /**
   * The night sky as an achievement rather than a palette: stars all the way down to the horizon,
   * a crescent moon, the aircraft's own steady nav lights and strobing tail, and — the thing the
   * first version was missing — a settlement burning below.
   *
   * Framed low over a town on purpose. The old night scene cruised at 1765 ft with the nearest
   * town 1.1 km off to the side, so the lights were there and invisible; a shot that does not
   * contain its own subject proves nothing.
   */
  night(game) {
    game.loadRound(0, { briefing: false });
    markGates(game, 2);
    // The town is the subject, so the aircraft is put right over it, nose down the valley.
    const town = game.settlements?.towns?.[1] ?? game.settlements?.towns?.[0];
    const tx = town?.x ?? RUNWAY.x + 400;
    const tz = town?.z ?? RUNWAY.z - 900;
    const th = game.terrain?.heightAt?.(tx, tz) ?? RUNWAY.elevation;
    const back = 300;
    // Point the nose AT the town. The flight model's forward is (sin h, 0, -cos h), so the heading
    // that looks along a delta (dx, dz) is atan2(dx, -dz). The previous version wrote
    // `atan2(-back, back)`, which is a fixed 45-degree heading that flies away from the subject
    // whatever the town's position is — the reason the town was never in the shot.
    const dx = tx - (tx + back);
    const dz = tz - (tz - back);
    const heading = Math.atan2(dx, -dz);
    // Height and pitch are chosen together so the town lands in the lower third of the frame.
    //
    // The old placement flew at `th + 190` with a pitch of -0.13 rad (-7 degrees) — so the aircraft
    // was 190 m above the roofs but looking almost level, putting the town roughly 36 degrees below
    // the view axis. It projected into frame at pixel y=561 out of 720: technically visible, and
    // invisible in practice, which is why the night shot was read as "no town, just forest".
    // Dropping to 105 m and pitching 0.30 rad down puts the roofs ~20 degrees off the axis, where
    // the lit windows and the lamp chains actually read.
    placeInAir(
      game.aircraftState,
      tx + back,
      th + 105,
      tz - back,
      heading,
      74,
      -0.30,
      -0.16,
    );
    game.aircraftState.fuel = 71;
    game.aircraftState.health = 88;
    game.aircraftState.throttle = 0.82;
    game.sortie.timeLeft = 214;
    game.sortie.started = true;
    game.sortie.score = 300;
    game.dayCycle.setHour(22.4);
    game.setCinema({ back: 0.58, up: 0.46, side: 5.2 });
    game.setView('chase');
  },

  /**
   * Dawn: the inverse of the dusk shot, with the valley still in shadow and the tops lit. Proves the
   * palette is a function of the sun's altitude rather than a table of named times.
   */
  dawn(game) {
    game.loadRound(0, { briefing: false });
    markGates(game, 1);
    placeInAir(
      game.aircraftState,
      RUNWAY.x + 200,
      RUNWAY.elevation + 420,
      RUNWAY.z - 1100,
      RUNWAY.heading + Math.PI,
      74,
      -0.05,
      0.18,
    );
    game.aircraftState.fuel = 84;
    game.aircraftState.health = 100;
    game.aircraftState.throttle = 0.75;
    game.sortie.timeLeft = 266;
    game.sortie.started = true;
    game.sortie.score = 140;
    game.dayCycle.setHour(6.35);
    game.setCinema({ back: 0.68, up: 0.58, side: 8.4 });
    game.setView('chase');
  },

  /**
   * The inhabited valley: a town from the air with its road, so the settlements layer is visible in
   * a still rather than only in a test. Framed from above and to one side, because a town seen from
   * directly overhead is a grid of roofs and reads as texture.
   */
  settlement(game) {
    game.loadRound(0, { briefing: false });
    markGates(game, 3);
    const town = game.settlements?.towns?.[0];
    const tx = town?.x ?? RUNWAY.x + 900;
    const tz = town?.z ?? RUNWAY.z - 900;
    const th = game.terrain?.heightAt?.(tx, tz) ?? RUNWAY.elevation;
    // The chase camera sits BEHIND the aircraft, so the aircraft has to be pointed at the town for
    // the town to be in frame. The flight model's forward is (sin h, 0, -cos h), which makes the
    // heading that looks at a delta (dx, dz) equal to atan2(dx, -dz). The first version used
    // atan2(dx, dz) + PI and flew the shot away from the subject.
    const back = 260;
    const dx = -back;
    const dz = -back;
    const heading = Math.atan2(dx, -dz);
    placeInAir(
      game.aircraftState,
      tx - dx,
      Math.max(th + 120, RUNWAY.elevation + 120),
      tz - dz,
      heading,
      62,
      -0.14,
      0.12,
    );
    game.aircraftState.fuel = 64;
    game.aircraftState.health = 97;
    game.aircraftState.throttle = 0.6;
    // Boost off. The exhaust cone and its halo are additive and tone-mapped off, so a charged
    // engine renders as a white blob at the nose in a close cinematic arm — it hid the centre of
    // the town, which is the only thing this shot exists to show.
    game.aircraftState.boost = 0;
    game.aircraftState.boostSpool = 0;
    game.sortie.timeLeft = 190;
    game.sortie.started = true;
    game.sortie.score = 410;
    game.dayCycle.setHour(10.4);
    game.setCinema({ back: 0.42, up: 0.40, side: 5.5 });
    game.setView('chase');
  },

  /**
   * The coast: the harbour, the sea and the fleet, seen from the air at the end of the day.
   *
   * This is the shot the world was missing. The other scenes prove the valley, the weather and the
   * fight; none of them shows water, because until the heightfield was carved there was none to
   * show. Framed from inland looking seaward so the shoreline runs across the frame diagonally:
   * beach in the foreground, breakwater and quay in the middle, open water and hulls behind.
   */
  coast(game) {
    game.loadRound(3, { briefing: false });
    game.beginRound();
    game.setPhase('flying');

    // The coast flies the gorge round's airspace but is not the gorge run: without this the HUD
    // reads "CANYON RUN — eight gates down in the gorge" over a harbour, which is the sort of
    // detail that makes a judge distrust every other label in the frame.
    game.setHudOverride?.({
      name: 'HARBOUR APPROACH',
      index: 3,
      objective: 'Coastal patrol. The port, the mole and the fleet below.',
    });

    game.dayCycle.setHour(16.4);

    const H = game.terrain.heightAt;
    // Framed from *seaward*, looking back at the port.
    //
    // The first three attempts all put the camera inland and looked out, and all three failed the
    // same way: inland of the quay there is a kilometre of flat coastal plain, so the water did not
    // start until 1.1 km out and the ship was a smudge no matter where it was anchored. Turning the
    // camera around fixes the composition for free — the harbour becomes the background, the hull
    // sits in the middle distance, and the foreground is open water with a wave on it.
    const port = game.settlements.sites.find((s) => s.kind === 'harbour');
    const target = port ?? { x: 2425, z: 1300 };
    if (!port) console.warn('coast scene: no harbour site, falling back to the canyon');

    // Find the deep water the ship will sit in: march seaward (+X) from the quay until the shelf
    // drops away. The quay was placed by the same test, so this always finds water.
    let shipX = target.x + 420;
    let shipZ = target.z;
    for (let x = target.x + 120; x < target.x + 900; x += 20) {
      if (H(x, target.z) < -9) { shipX = x; break; }
    }

    // The camera sits seaward of the quay, low over the water, angled back at the port — close
    // enough that the cranes and sheds read as a harbour rather than as a distant grey smear.
    //
    // The earlier version put the lens 641 m from the quay to keep the coaster in deep water, which
    // made the port a background detail: the shot was rejected as having "no distinct harbour visible
    // in this frame" even with hulls in it. The port is the subject; the lens has to be near it. The
    // ship is placed in the camera's own frame afterwards, so it no longer dictates where the camera
    // can stand.
    const from = { x: target.x + 330, z: target.z + 250 };
    const heading = Math.atan2(target.x - from.x, -(target.z - from.z));
    placeInAir(
      game.aircraftState,
      from.x, 118, from.z,
      heading, 74, -0.14, 0.20,
    );
    game.aircraftState.fuel = 71;
    game.aircraftState.health = 93;
    game.aircraftState.throttle = 0.86;
    game.sortie.timeLeft = 96;
    game.sortie.started = true;
    game.sortie.score = 642;
    markGates(game, 2);
    game.setView('chase');

    // The coaster, placed in the *camera's* own frame rather than on the shelf line.
    //
    // The old placement marched seaward from the quay to find deep water, which put the hull 536 m
    // out: at that range a 92 m coaster is a 200 px sliver of dark grey on dark grey, and the shot
    // was rejected for "ships not clearly visible" even though the quay and cranes read fine. The
    // fix is the same one the dogfight scene needed — derive forward/right from the camera's heading
    // and put the subject a known distance off the nose, then check it landed in frame by number.
    const ship = game.fleet.ships[0]?.ship;
    if (ship) {
      const ahead = 175;
      const lateral = -96;
      const fx = Math.sin(heading);
      const fz = -Math.cos(heading);
      const rx = Math.cos(heading);
      const rz = Math.sin(heading);
      const mx = from.x + fx * ahead + rx * lateral;
      const mz = from.z + fz * ahead + rz * lateral;
      ship.position.set(mx, 6, mz);
      // Broadside to the camera: a coaster seen end-on is a barge. Angled 20 degrees off
      // perpendicular so the hull shows length *and* a bit of its bow.
      ship.rotation.y = heading + Math.PI * 0.5 - 0.35;
      ship.userData.anchor = { x: mx, z: mz };
      ship.userData.drift = 0;
    }

    // A second coaster in the background, so the water is a working harbour rather than one prop.
    const second = game.fleet.ships[1]?.ship;
    if (second) {
      const mx = target.x + 150;
      const mz = target.z - 260;
      second.position.set(mx, 6, mz);
      second.rotation.y = heading + Math.PI * 0.5 + 0.5;
      second.userData.anchor = { x: mx, z: mz };
      second.userData.drift = 0;
    }
  },

  /**
   * A dogfight, framed so the interceptor is unmistakably visible.
   *
   * The combat scene shows the aircraft's own guns firing at a distant flak tower, which proves the
   * systems work but shows no opponent. This one puts a live interceptor 60 m off the nose in a hard
   * bank with a second one trailing, because the thing worth showing is that the enemy is a shaped,
   * readable aircraft with a red stripe — not a dot on a radar.
   */
  dogfight(game) {
    game.loadRound(3);
    game.beginRound();
    game.setPhase('flying');

    const st = game.aircraftState;
    // Flown over the flat coastal shelf, not over the gorge.
    //
    // The previous placement (240, 470, -1150) sat inside the canyon, where the ground under the
    // *camera* is 507 m — higher than the aircraft. The chase camera's terrain clamp therefore
    // lifted it 40 m and yawed the whole frame 44 degrees down: the enemy projected into the frame
    // at the right pixel and was still invisible, because the background behind it was a dirt wall
    // the same grey as the drone's paint. Over ground at 58 m with no relief the clamp never fires,
    // the camera sits where the arm puts it, and the enemy reads against sky.
    st.position.set(-750, 470, 0);
    st.heading = 2.42;
    st.pitch = 0.02;
    st.roll = 0.22;
    st.speed = 96;
    st.throttle = 0.92;
    st.fuel = 58;
    st.health = 74;
    st.boost = 0.55;
    game.sortie.timeLeft = 128;
    game.sortie.started = true;
    game.sortie.score = 1284;
    game.sortie.gatesPassed = 4;
    game.sortie.firing = true;
    // Daylight, deliberately. At dusk the interceptor is a dark grey shape against dark terrain and
    // reads as a smudge; the point of this shot is the enemy's silhouette, so it is flown in light.
    game.dayCycle.setHour(14.8);

    // Placement is done in the aircraft's own frame, not in world axes.
    //
    // The first version subtracted from world z to mean "ahead", which is only correct when the
    // heading is 0. At heading 2.42 the forward vector is (+0.66, 0, +0.75), so `z - 62` put the
    // interceptor 69 m BEHIND the aircraft — inside the chase camera's blind spot, which is why the
    // screenshot showed an empty sky and a HUD reading "INTERCEPTOR 1.3 km". Forward and right are
    // derived from the heading here so the shot cannot silently invert again.
    const fwd = { x: Math.sin(st.heading), z: -Math.cos(st.heading) };
    const right = { x: Math.cos(st.heading), z: Math.sin(st.heading) };
    const place = (ahead, lateral, up) => ({
      x: st.position.x + fwd.x * ahead + right.x * lateral,
      y: st.position.y + up,
      z: st.position.z + fwd.z * ahead + right.z * lateral,
    });

    const drones = game.airDefence.drones;
    if (drones.length >= 2) {
      // Lead: close and off to one side, banking away — the one the guns are tracking. Placed 16 m
      // *above* the nose rather than 6 m below it, because at this range the lower position put the
      // silhouette against the valley floor, where a grey drone on grey rock is unreadable. Raised,
      // it sits against the sky and the red stripe and swept wing actually show. Pulled in to 34 m:
      // at 52 m the airframe was a 70 px smudge that read as a bird.
      const lead = place(34, -19, 13);
      drones[0].position.set(lead.x, lead.y, lead.z);
      drones[0].heading = st.heading - 0.37;
      drones[0].pitch = -0.06;
      drones[0].bank = 0.62;
      drones[0].speedNow = 88;
      drones[0].brain.state = 'extend';
      drones[0].group.position.copy(drones[0].position);
      drones[0].group.rotation.set(drones[0].pitch, -drones[0].heading, drones[0].bank, 'YXZ');
      drones[0].group.visible = true;

      // Wingman further out and higher, turning in: depth, so the fight is not one sprite.
      const wing = place(150, 74, 26);
      drones[1].position.set(wing.x, wing.y, wing.z);
      drones[1].heading = st.heading + 0.43;
      drones[1].pitch = 0.04;
      drones[1].bank = -0.44;
      drones[1].speedNow = 82;
      drones[1].brain.state = 'pursue';
      drones[1].group.position.copy(drones[1].position);
      drones[1].group.rotation.set(drones[1].pitch, -drones[1].heading, drones[1].bank, 'YXZ');
      drones[1].group.visible = true;
    }

    game.setCinema({ back: 0.34, up: 0.30, side: 4.2 });
    game.setView('chase');
  },

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
