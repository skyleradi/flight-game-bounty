// The game itself: the scene, the loop, the two cameras and the campaign's rules. It reads the
// controls, steps the flight model, moves the model, updates the HUD and picks the frame's camera.
//
// The campaign is five sorties. A sortie runs in three phases:
//
//   briefing  the round's name, weather and objective, held still behind a card
//   flying    the live simulation: take off, thread the gates, land again
//   debrief   the score, what earned it, and what unlocks next
//
// The phase lives on the game rather than in the DOM so a screenshot scene can put the game into
// any of the three and render a single deterministic frame of it.

import * as THREE from '../vendor/three.module.min.js';
import {
  AIRCRAFT, CAMPAIGN, ENEMY, MISSION, PALETTE, RUNWAY, STEP, WORLD, windVector, campaignPar,
} from './config.js';
import { buildTerrain, buildWater, buildForest } from './terrain.js';
import { buildObstacles, checkCollision, collisionDamage } from './obstacles.js';
import { buildAirfield, buildApproachMarkers } from './airfield.js';
import { buildAircraft, createAircraftState } from './aircraft.js';
import { createAirDefence } from './enemies.js';
import { buildCockpit, EYE_HEIGHT, EYE_Z } from './cockpit.js';
import { emptyControls, placeInAir, resetToRunway, stepAircraft, overRunway, runwayProgress } from './physics.js';
import {
  buildCourse, buildGateMeshes, checkGateCrossing, disposeGateMeshes, gateBearing, loadProgress,
  nextGate, recordRound, saveProgress, scoreRound, styleGate,
} from './mission.js';
import { createHud } from './hud.js';
import { createInput, KEY_HELP } from './input.js';
import {
  applyFog, buildClouds, buildEnvironment, buildLights, buildRain, buildSky, buildSun,
  installAtmosphericHaze, rethemeLights,
} from './sky.js';

const MPS_TO_KNOTS = 1.94384;
const M_TO_FEET = 3.28084;

export function createGame({ canvas, hudCanvas }) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance', alpha: false,
  });
  renderer.setPixelRatio(Math.min(1.75, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // A golden-hour sun sits eight degrees up, so the land is lit at a grazing angle and most of the
  // frame is in the falloff. Real film opens up for that; so does this. The storm rounds keep
  // their own gloom because their sun intensity is low to begin with.
  renderer.toneMappingExposure = 1.3;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, 0.35, 26000);

  // --- The world. Order matters: the terrain first, because everything else sits on it, and the
  // round before the terrain, because the round decides whether a gorge is cut into it.
  let round = CAMPAIGN[0];
  const terrain = buildTerrain(round);
  scene.add(terrain.mesh);
  scene.add(buildWater());

  applyFog(scene, { ...round.sky, visibility: round.visibility });

  const sun = buildSun(round.sky);
  scene.add(sun.sprite);
  const sky = buildSky(round.sky);
  scene.add(sky);
  const lights = buildLights(sun.direction, round.sky);
  scene.add(lights);

  // The sky, baked into a reflection probe. Every metal surface in the scene — the cowling, the
  // canopy, the gate tubes — mirrors this instead of a flat grey, which is the difference between
  // painted aluminium and injection-moulded plastic.
  scene.environment = buildEnvironment(renderer, round.sky);
  scene.environmentIntensity = 0.9;

  let forest = buildForest(terrain);
  scene.add(forest);

  const airfield = buildAirfield();
  scene.add(airfield);
  scene.add(buildApproachMarkers());

  let gates = buildCourse(terrain, round);
  let gateVisuals = buildGateMeshes(gates, round.radius);
  scene.add(gateVisuals.group);

  const cloudDeck = round.course.clearance.base / 140;
  let clouds = buildClouds({
    deck: Math.min(1.25, Math.max(0.34, cloudDeck)),
    cover: 0.55 + round.rain * 0.9,
    drift: 1 + round.wind.speed * 0.06,
  });
  scene.add(clouds.group);

  let rain = buildRain(round.rain);
  if (rain) scene.add(rain.object);

  // Aerial perspective, installed once the world is built so every material it can see gets the
  // pass. Anything added after this point is patched by hand where it is created.
  const haze = installAtmosphericHaze(scene, round.sky, sun.direction);

  // Obstacles last, so the haze pass can reach them in the same sweep that covers the world.
  let obstacles = buildObstacles(terrain, round, gates);
  scene.add(obstacles.group);
  haze.patchObject(obstacles.group);

  // The air defence belongs to the round, like the obstacles: it is rebuilt when the round changes,
  // because the count of guns is part of what makes the later sorties hard.
  let airDefence = createAirDefence({ scene, terrain, round, haze });

  const aircraft = buildAircraft();
  // The model is built nose-along +Z, but the flight model's forward is (sin h, 0, -cos h). A
  // wrapper turned half a turn makes the two agree, so the aircraft flies nose-first.
  const aircraftModel = aircraft.group;
  const aircraftRoot = new THREE.Group();
  aircraftRoot.name = 'aircraftRoot';
  aircraftModel.rotation.y = Math.PI;
  aircraftRoot.add(aircraftModel);
  scene.add(aircraftRoot);

  const cockpit = buildCockpit();
  aircraftRoot.add(cockpit.group);

  const aircraftState = createAircraftState();
  aircraftState.terrain = terrain.heightAt;
  aircraftState.flaps = 0;
  aircraftState.time = 0;
  aircraftState.wind = windVector(round.wind.from, round.wind.speed);
  aircraftState.turbulence = round.turbulence;
  resetToRunway(aircraftState);

  const hud = createHud(hudCanvas);
  const input = createInput(canvas);
  let progress = loadProgress();

  // --- The sortie's own bookkeeping.
  const sortie = {
    phase: 'briefing',
    timeLeft: round.time,
    gatesPassed: 0,
    started: false,
    finished: false,
    crashed: false,
    landed: false,
    message: null,
    messageUntil: 0,
    elapsed: 0,
    time: 0,
    score: 0,
    result: null,
    fastestGate: null,
    peakAltitude: 0,
    touchdown: null,
    /** Kills, split by kind, and how much afterburner the pilot spent. */
    kills: 0,
    turretsKilled: 0,
    dronesKilled: 0,
    boostUsed: 0,
    /** Decays to zero after each hit; drives the HUD's red rim. */
    hitFlash: 0,
    /** True while the trigger is down, for the HUD's gun readout. */
    firing: false,
  };

  let view = 'chase';
  let paused = false;
  let lastControls = emptyControls();
  /**
   * An optional hero framing for the chase camera: a shorter arm, off to one side and lower, so a
   * screenshot reads as a photograph of the aircraft rather than a follow-cam. Null is the flight
   * camera the pilot actually flies behind.
   */
  let cinema = null;

  /** Rebuilds the course and the weather for a round. */
  function loadRound(index, { briefing = true } = {}) {
    const next = CAMPAIGN[Math.max(0, Math.min(CAMPAIGN.length - 1, index))];
    const terrainChanged = (next.gorge ?? null) !== (round.gorge ?? null);
    round = next;

    // The land. A round that cuts a gorge needs the heightfield rebuilt, because the walls are
    // part of the terrain itself and not a prop laid on top of it.
    if (terrainChanged) {
      scene.remove(terrain.mesh);
      terrain.mesh.geometry.dispose();
      terrain.mesh.material.dispose();
      const rebuilt = buildTerrain(round);
      terrain.mesh = rebuilt.mesh;
      terrain.heights = rebuilt.heights;
      terrain.heightAt = rebuilt.heightAt;
      scene.add(terrain.mesh);
      if (forest) {
        scene.remove(forest);
        forest = buildForest(terrain);
        scene.add(forest);
      }
      aircraftState.terrain = terrain.heightAt;
      // Rebuilt geometry means a rebuilt material, and the haze pass is baked into the material's
      // shader — a new one would otherwise render crisp and unhazed against a hazy world, which
      // reads as a cut-out pasted on the landscape.
      haze.patchObject(terrain.mesh);
      if (forest) haze.patchObject(forest);
    }

    // Course.
    scene.remove(gateVisuals.group);
    disposeGateMeshes(gateVisuals);
    gates = buildCourse(terrain, round);
    gateVisuals = buildGateMeshes(gates, round.radius);
    scene.add(gateVisuals.group);
    haze.patchObject(gateVisuals.group);

    // Obstacles belong to the round, not the world: their placement is keyed to the gate
    // positions, so a new course needs a new set or a spire ends up standing in a ring.
    scene.remove(obstacles.group);
    obstacles.group.traverse((o) => {
      if (o.isMesh) o.geometry?.dispose();
    });
    obstacles = buildObstacles(terrain, round, gates);
    scene.add(obstacles.group);
    haze.patchObject(obstacles.group);

    // Air defence: torn down and rebuilt with the round, since the number of guns is the round's.
    airDefence.dispose();
    airDefence = createAirDefence({ scene, terrain, round, haze });

    // Sky, sun, lights and haze.
    sky.userData.repaint(round.sky);
    sun.retheme(round.sky);
    rethemeLights(lights, round.sky, sun.direction);
    applyFog(scene, { ...round.sky, visibility: round.visibility });
    haze.retheme(round.sky, sun.direction);
    // The probe is repainted with the round: a golden-hour sortie reflects a warm horizon, the
    // storm reflects a grey deck. Baking is a single offscreen pass, so a round change can afford it.
    scene.environment?.dispose();
    scene.environment = buildEnvironment(renderer, round.sky);

    // Cloud and rain.
    scene.remove(clouds.group);
    clouds = buildClouds({
      deck: Math.min(1.25, Math.max(0.34, round.course.clearance.base / 140)),
      cover: 0.55 + round.rain * 0.9,
      drift: 1 + round.wind.speed * 0.06,
    });
    scene.add(clouds.group);
    haze.patchObject(clouds.group);
    if (rain) scene.remove(rain.object);
    rain = buildRain(round.rain);
    if (rain) scene.add(rain.object);

    // The aircraft's air, and its book.
    aircraftState.wind = windVector(round.wind.from, round.wind.speed);
    aircraftState.turbulence = round.turbulence;
    aircraftState.fuel = round.fuel;
    resetToRunway(aircraftState);
    aircraftState.fuel = round.fuel;

    sortie.phase = briefing ? 'briefing' : 'flying';
    sortie.timeLeft = round.time;
    sortie.gatesPassed = 0;
    sortie.started = false;
    sortie.finished = false;
    sortie.crashed = false;
    sortie.landed = false;
    sortie.message = null;
    sortie.messageUntil = 0;
    sortie.elapsed = 0;
    sortie.time = 0;
    sortie.score = 0;
    sortie.result = null;
    sortie.fastestGate = null;
    sortie.peakAltitude = 0;
    sortie.touchdown = null;
    sortie.kills = 0;
    sortie.turretsKilled = 0;
    sortie.dronesKilled = 0;
    sortie.boostUsed = 0;
    input.setFlaps(0);
    input.setCapturing(true);
    // A round always loads with the pilot's own camera; a screenshot scene sets its framing after.
    cinema = null;
    return round;
  }

  /** Starts the round that is briefed: the clock does not run until the wheels roll. */
  function beginRound() {
    sortie.phase = 'flying';
    sortie.message = null;
    sortie.messageUntil = 0;
    resetToRunway(aircraftState);
    aircraftState.fuel = round.fuel;
    input.setFlaps(0);
  }

  /** Ends the round, scores it, and records the result against the campaign. */
  function endRound(reason) {
    if (sortie.finished) return;
    sortie.finished = true;
    sortie.phase = 'debrief';

    const landedClean = reason === 'landed';
    const score = scoreRound({
      round,
      gatesPassed: sortie.gatesPassed,
      landed: landedClean,
      crashed: sortie.crashed,
      health: aircraftState.health,
      fuel: aircraftState.fuel,
      maxFuel: round.fuel,
      timeLeft: sortie.timeLeft,
      maxTime: round.time,
      kills: sortie.kills,
    });

    sortie.score = score;
    sortie.result = {
      reason,
      score,
      gatesPassed: sortie.gatesPassed,
      gatesTotal: round.gates,
      health: Math.round(aircraftState.health),
      fuelPct: Math.round((aircraftState.fuel / round.fuel) * 100),
      timeLeft: Math.max(0, Math.round(sortie.timeLeft)),
      elapsed: Math.round(sortie.elapsed),
      touchdown: sortie.touchdown,
      peakAltitude: Math.round(sortie.peakAltitude),
      par: Math.round(1000 * round.difficulty),
    };

    progress = recordRound(progress, round.id, sortie.result);
    saveProgress(progress);

    aircraftState.destroyed = reason === 'crash';
  }

  /** Restarts the current round from the threshold, keeping the same weather and course. */
  function restart() {
    resetToRunway(aircraftState);
    aircraftState.fuel = round.fuel;
    gates.forEach((g, i) => {
      g.passed = false;
      styleGate(gateVisuals.meshes[i], i === 0 ? 'next' : 'pending');
    });
    sortie.phase = 'flying';
    sortie.timeLeft = round.time;
    sortie.gatesPassed = 0;
    sortie.started = false;
    sortie.finished = false;
    sortie.crashed = false;
    sortie.landed = false;
    sortie.elapsed = 0;
    sortie.score = 0;
    sortie.result = null;
    sortie.message = null;
    sortie.messageUntil = 0;
    sortie.fastestGate = null;
    sortie.peakAltitude = 0;
    sortie.touchdown = null;
    sortie.kills = 0;
    sortie.turretsKilled = 0;
    sortie.dronesKilled = 0;
    sortie.boostUsed = 0;
    input.setFlaps(0);
    input.setCapturing(true);
  }

  function say(text, seconds = 4) {
    sortie.message = text;
    sortie.messageUntil = sortie.time + seconds;
  }

  function resize() {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    hud.resize(w, h);
  }

  // --- The two cameras. The chase camera trails the aircraft and leans into the turn; the cockpit
  // camera sits where the cockpit model's eye is, so the panel and the nose are in frame.
  const chasePos = new THREE.Vector3();
  const chaseLook = new THREE.Vector3();
  const tmpVec = new THREE.Vector3();

  function updateChaseCamera(dt, snap = false) {
    const s = aircraftState;
    cockpit.group.visible = false;
    aircraftModel.visible = true;
    // The cinematic arm pulls in close and swings round the quarter, so the frame shows the
    // aircraft three-quarter from below with the land falling away behind it.
    const arm = cinema ? cinema.back : 1;
    const lift = cinema ? cinema.up : 1;
    const side = cinema ? cinema.side : 0;
    const back = (21 + s.speed * 0.085) * arm;
    const up = (5.6 + s.speed * 0.012) * lift;

    const dirX = Math.sin(s.heading);
    const dirZ = -Math.cos(s.heading);

    const targetX = s.position.x - dirX * back + Math.cos(s.heading) * side;
    const targetZ = s.position.z - dirZ * back - Math.sin(s.heading) * side;
    const targetY = s.position.y + up - Math.sin(s.pitch) * back * 0.42;

    if (snap) {
      chasePos.set(targetX, targetY, targetZ);
    } else {
      const k = 1 - Math.exp(-dt * 7.5);
      chasePos.x += (targetX - chasePos.x) * k;
      chasePos.y += (targetY - chasePos.y) * k;
      chasePos.z += (targetZ - chasePos.z) * k;
    }

    const ground = terrain.heightAt(chasePos.x, chasePos.z) + 3.4;
    if (chasePos.y < ground) chasePos.y = ground;

    camera.position.copy(chasePos);

    const lookAheadX = s.position.x + dirX * 26;
    const lookAheadZ = s.position.z + dirZ * 26;
    const lookAheadY = s.position.y + Math.sin(s.pitch) * 26 + 1.2;
    chaseLook.set(lookAheadX, lookAheadY, lookAheadZ);
    camera.up.set(Math.sin(-s.bank * 0.32), Math.cos(s.bank * 0.32), 0);
    camera.lookAt(chaseLook);
  }

  function updateCockpitCamera() {
    const s = aircraftState;
    cockpit.group.visible = true;
    aircraftModel.visible = false;

    // The eye sits exactly where the cockpit model was built around: EYE_HEIGHT above the seat,
    // EYE_Z back from the seat's origin, which is the panel's own reference point.
    const eye = tmpVec.set(0, EYE_HEIGHT, EYE_Z);
    const matrix = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(s.pitch, s.heading, -s.bank, 'YXZ'),
    );
    eye.applyMatrix4(matrix);
    camera.position.set(
      s.position.x + eye.x,
      s.position.y + eye.y,
      s.position.z + eye.z,
    );
    camera.up.set(Math.sin(-s.bank), Math.cos(s.bank), 0);
    const forward = new THREE.Vector3(
      Math.sin(s.heading) * Math.cos(s.pitch),
      Math.sin(s.pitch),
      -Math.cos(s.heading) * Math.cos(s.pitch),
    );
    camera.lookAt(camera.position.clone().add(forward.multiplyScalar(60)));
  }

  // --- The model follows the flight model's state, one fixed step at a time.
  function syncModel(dt) {
    const s = aircraftState;
    aircraftRoot.position.copy(s.position);
    // The flight model's forward is (sin h, 0, -cos h), which is the local -Z axis under a
    // rotation of -heading. The sign matters: with +heading the whole airframe is mirrored in X
    // and the cockpit panel ends up behind the pilot's eye.
    aircraftRoot.rotation.set(s.pitch, -s.heading, -s.bank, 'YXZ');

    const rpm = 0.25 + s.throttle * 0.75;
    aircraft.propHub.rotation.z += dt * (14 + rpm * 78);
    aircraft.disc.material.opacity = Math.max(0, rpm - 0.42) * 0.3;

    const controls = lastControls;
    const aileronAngle = (controls.roll + controls.mouseDeltaX * 0.012) * 0.32;
    for (const { pivot, side } of aircraft.ailerons) pivot.rotation.x = -aileronAngle * side;
    aircraft.elevatorPivot.rotation.x = (controls.pitch + controls.mouseDeltaY * -0.01) * 0.26;
    aircraft.rudderPivot.rotation.y = (controls.yaw + controls.roll * 0.28) * 0.3;

    const blink = (sortie.time * 1.15) % 1 > 0.5;
    aircraft.navL.visible = blink;
    aircraft.navR.visible = blink;
  }

  // --- One fixed simulation step: input, physics, mission, presentation.
  function step(dt) {
    sortie.time += dt;

    if (sortie.phase !== 'flying') {
      // Not flying: the aircraft still sits in the world, but nothing advances.
      return;
    }

    const controls = input.read(lastControls);
    lastControls = { ...controls };

    if (input.consumePressed('KeyC')) {
      view = view === 'chase' ? 'cockpit' : 'chase';
      say(view === 'cockpit' ? 'Cockpit view' : 'Chase view', 1.6);
    }
    if (input.consumePressed('KeyR')) {
      restart();
      say('Round restarted', 2);
    }
    if (input.consumePressed('KeyP')) paused = !paused;
    if (paused) return;

    const previous = {
      x: aircraftState.position.x,
      y: aircraftState.position.y,
      z: aircraftState.position.z,
    };

    const events = stepAircraft(aircraftState, controls, dt);
    for (const e of events) {
      if (e.type === 'crash') {
        sortie.crashed = true;
        sortie.touchdown = e.reason === 'terrain' ? null : sortie.touchdown;
        say(`Airframe destroyed: ${e.reason}.`, 999);
        endRound('crash');
        return;
      }
      if (e.type === 'touchdown') {
        sortie.touchdown = { sink: +e.sink.toFixed(2), damage: Math.round(e.damage), crosswind: Math.round(e.crosswind) };
        if (e.damage === 0 && sortie.gatesPassed > 0) {
          sortie.landed = true;
          say('Touchdown. Bring her to a stop.', 4);
        } else if (e.damage > 0) {
          say(`Heavy touchdown: ${Math.round(e.damage)} damage.`, 5);
        }
      }
      if (e.type === 'flameout') say('Fuel exhausted: glide to the runway.', 6);
    }

    // Obstacles. Tested against the segment the aircraft just flew, not its endpoint, so a mast
    // cannot be passed through between two frames at cruise speed.
    const hit = checkCollision(obstacles.colliders, previous, aircraftState.position);
    if (hit) {
      const damage = collisionDamage(hit.collider.kind, aircraftState.speed);
      aircraftState.health = Math.max(0, aircraftState.health - damage);
      // The aircraft is stopped dead against the obstacle rather than flying on through it: pull
      // the position back to just before the contact point.
      const t = Math.max(0, hit.t - 0.02);
      aircraftState.position.x = previous.x + (aircraftState.position.x - previous.x) * t;
      aircraftState.position.y = previous.y + (aircraftState.position.y - previous.y) * t;
      aircraftState.position.z = previous.z + (aircraftState.position.z - previous.z) * t;
      aircraftState.speed *= 0.18;
      sortie.peakAltitude = Math.max(sortie.peakAltitude, aircraftState.position.y);

      const label = hit.collider.kind === 'spire' ? 'rock spire'
        : hit.collider.kind === 'mast' ? 'radio mast'
        : hit.collider.kind === 'rotor' ? 'turbine rotor'
        : 'wind turbine';
      if (aircraftState.health <= 0) {
        sortie.crashed = true;
        say(`Struck a ${label}. Airframe destroyed.`, 999);
        endRound('crash');
        return;
      }
      say(`Struck a ${label}: ${Math.round(damage)} damage.`, 4);
    }

    // --- The guns. Fired from the same controls the flight model read, at the aircraft's own
    // position and heading, so the rounds go where the nose points.
    sortie.firing = airDefence.fireGuns(dt, aircraftState, controls);
    airDefence.track(aircraftState.position);
    const combatEvents = airDefence.update(dt, aircraftState, sortie.time);
    for (const e of combatEvents) {
      if (e.type === 'hit') {
        aircraftState.health = Math.max(0, aircraftState.health - e.damage);
        sortie.hitsTaken = (sortie.hitsTaken ?? 0) + 1;
        sortie.hitFlash = Math.min(1, (sortie.hitFlash ?? 0) + 0.55);
        if (aircraftState.health <= 0) {
          sortie.crashed = true;
          say('Airframe destroyed: shot down.', 999);
          endRound('crash');
          return;
        }
        say(`Hit: ${Math.round(e.damage)} damage.`, 2.4);
      } else if (e.type === 'kill') {
        sortie.kills += 1;
        if (e.kind === 'turret') sortie.turretsKilled += 1;
        else sortie.dronesKilled += 1;
        const points = Math.round(ENEMY.killScore * round.difficulty);
        say(`${e.kind === 'turret' ? 'Flak tower' : 'Interceptor'} destroyed. +${points}`, 2.6);
      }
    }

    if (!sortie.started && aircraftState.speed > 4) sortie.started = true;
    if (sortie.started && !sortie.crashed) {
      sortie.elapsed += dt;
      sortie.timeLeft = Math.max(0, sortie.timeLeft - dt);
      if (sortie.timeLeft <= 0) {
        say(`Out of time. ${sortie.gatesPassed}/${round.gates} gates.`, 999);
        endRound('timeout');
        return;
      }
    }

    sortie.peakAltitude = Math.max(sortie.peakAltitude, aircraftState.position.y);

    // Gates: the crossing test uses the position before and after the step.
    const gate = nextGate(gates);
    if (gate && checkGateCrossing(gate, previous, aircraftState.position)) {
      gate.passed = true;
      sortie.gatesPassed += 1;
      styleGate(gateVisuals.meshes[gate.index], 'done');
      const upcoming = nextGate(gates);
      if (upcoming) styleGate(gateVisuals.meshes[upcoming.index], 'next');

      if (sortie.gatesPassed === round.gates) {
        say('Course complete. Land back at Harrow Field.', 8);
      } else {
        const clean = Math.hypot(
          aircraftState.position.y - gate.y,
          0,
        );
        if (!sortie.fastestGate || clean < sortie.fastestGate.off) {
          sortie.fastestGate = { index: gate.index, off: Math.round(clean) };
        }
        say(`Gate ${sortie.gatesPassed} of ${round.gates}`, 2.2);
      }
    }

    // The live score, so the HUD's number moves as the pilot flies rather than only at the end.
    sortie.score = scoreRound({
      round,
      gatesPassed: sortie.gatesPassed,
      landed: sortie.landed,
      crashed: false,
      health: aircraftState.health,
      fuel: aircraftState.fuel,
      maxFuel: round.fuel,
      timeLeft: sortie.timeLeft,
      maxTime: round.time,
      kills: sortie.kills,
    });

    // The round ends when the pilot is back on the runway, stopped, with the course flown.
    if (sortie.landed && sortie.gatesPassed >= round.gates && aircraftState.wheelsDown) {
      if (aircraftState.speed < 1.2 && overRunway(aircraftState.position.x, aircraftState.position.z)) {
        endRound('landed');
        return;
      }
    }

    // Rolling to a stop on the runway with the course already flown also ends it, in case the
    // touchdown was logged before the last gate.
    if (sortie.wheelsDown && aircraftState.speed < 0.5 && sortie.gatesPassed > 0
      && overRunway(aircraftState.position.x, aircraftState.position.z) && sortie.elapsed > 8) {
      if (sortie.gatesPassed >= round.gates) {
        sortie.landed = true;
        endRound('landed');
        return;
      }
    }

    for (const g of gates) {
      if (!g.passed) gateVisuals.meshes[g.index].rotation.z += dt * 0.25;
    }

    if (aircraftState.fuel <= 0 && aircraftState.wheelsDown && aircraftState.speed < 1 && sortie.started) {
      say('Out of fuel on the ground.', 999);
      endRound('fuel');
    }
  }

  let accumulator = 0;
  let lastFrame = 0;

  function frame(now) {
    const dt = Math.min(0.05, lastFrame ? (now - lastFrame) / 1000 : STEP);
    lastFrame = now;

    accumulator += dt;
    let steps = 0;
    while (accumulator >= STEP && steps < 8) {
      step(STEP);
      accumulator -= STEP;
      steps += 1;
    }

    syncModel(dt);

    if (view === 'cockpit') updateCockpitCamera();
    else updateChaseCamera(dt);

    sky.position.copy(camera.position);
    sun.sprite.position.copy(camera.position).add(
      sun.direction.clone().multiplyScalar(WORLD.size * 1.35),
    );

    clouds.update(dt, aircraftState.wind);
    obstacles.update(dt, sortie.time);
    if (rain) rain.update(dt, camera, aircraftState.wind);
    // The hit flash decays on the render clock, not the physics clock, so a paused frame still
    // fades instead of freezing a red screen.
    sortie.hitFlash = Math.max(0, (sortie.hitFlash ?? 0) - dt * 2.6);

    drawHud();
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }

  /**
   * Builds the HUD's payload from the current state, so the live loop and a shot agree.
   *
   * In the cockpit view the 3D panel carries the instrument dials, so the flat HUD is asked for its
   * compact layout: the two would otherwise draw over each other in the same part of the screen.
   */
  function drawHud(message = null) {
    const s = aircraftState;
    const gate = nextGate(gates);
    const bearing = gate ? gateBearing(gate, s.position) : null;
    const flaps = s.flaps ?? 0;
    // One status read per frame: it walks every turret and drone, so calling it twice per frame in
    // a payload literal would double that cost for no gain.
    const threats = airDefence.status();
    const payload = {
      speed: s.speed * MPS_TO_KNOTS,
      altitude: s.position.y * M_TO_FEET,
      heading: (s.heading * 180) / Math.PI,
      climb: s.climb * M_TO_FEET * 60,
      throttle: s.throttle,
      fuel: s.fuel / round.fuel,
      health: s.health / AIRCRAFT.health,
      flaps,
      pitch: s.pitch,
      bank: s.bank,
      gate: bearing,
      gatesPassed: sortie.gatesPassed,
      gatesTotal: round.gates,
      timeLeft: sortie.timeLeft,
      score: sortie.score,
      roundName: round.name,
      roundIndex: round.id,
      roundTotal: CAMPAIGN.length,
      missionLine: round.objective,
      wind: round.wind,
      cockpit: view === 'cockpit',
      message: sortie.phase === 'flying' && sortie.time < sortie.messageUntil
        ? message ?? sortie.message : null,
      stall: (s.airspeed ?? s.speed) < 27 * (1 - 0.11 * flaps) && !s.wheelsDown && !s.destroyed,

      // Combat. The afterburner charge and spool are read straight from the flight model, so the
      // meter and the thrust can never disagree.
      boost: s.boost ?? 1,
      boostSpool: s.boostSpool ?? 0,
      kills: sortie.kills,
      firing: sortie.firing,
      hitFlash: sortie.hitFlash,
      threats,
      threatBearing: threats.nearest?.bearing ?? 0,
    };
    hud.draw(payload);
    // The cockpit's glass panel shows the same numbers, so it is repainted from the same payload.
    cockpit.updateReadout?.(payload, sortie.time);
  }

  resize();
  window.addEventListener('resize', resize);
  input.setCapturing(true);

  chasePos.set(
    aircraftState.position.x - Math.sin(aircraftState.heading) * 21,
    aircraftState.position.y + 5.6,
    aircraftState.position.z + Math.cos(aircraftState.heading) * 21,
  );

  /**
   * Runs the combat simulation forward without moving the aircraft, so a screenshot can show
   * tracers, drones and a lit gun without the pilot having to fly there first.
   *
   * Damage events are discarded on purpose: the point is to compose the shot, not to wound the
   * airframe the scene then renders.
   */
  function warmCombat(seconds, { fire = false } = {}) {
    const dt = 1 / 60;
    const controls = { ...emptyControls(), fire };
    const steps = Math.round(seconds / dt);
    for (let i = 0; i < steps; i += 1) {
      sortie.time += dt;
      airDefence.track(aircraftState.position);
      if (fire) airDefence.fireGuns(dt, aircraftState, controls);
      airDefence.update(dt, aircraftState, sortie.time);
    }
    sortie.firing = fire;
    sortie.hitFlash = 0;
  }

  return {
    start() { requestAnimationFrame(frame); },
    /** Renders one frame from the current state, for the screenshot scenes. */
    renderNow() {
      syncModel(0.016);
      if (view === 'cockpit') updateCockpitCamera();
      else updateChaseCamera(0.016, true);
      sky.position.copy(camera.position);
      sun.sprite.position.copy(camera.position).add(
        sun.direction.clone().multiplyScalar(WORLD.size * 1.35),
      );
      drawHud();
      renderer.render(scene, camera);
    },
    scene, camera, renderer, terrain, aircraft, aircraftState, sortie, sun, sky, lights,
    restart, resize, hud, input, KEY_HELP, warmCombat,
    /**
     * Advances the simulation by hand, for tests and for the screenshot harness. The page's own
     * loop is driven by requestAnimationFrame, which a headless browser throttles; this runs the
     * exact same step function on a fixed clock so a test can fly a whole sortie deterministically.
     */
    simulate(seconds, { dt = STEP } = {}) {
      const n = Math.max(1, Math.round(seconds / dt));
      for (let i = 0; i < n; i += 1) {
        step(dt);
        if (sortie.finished) break;
      }
      syncModel(dt);
      drawHud();
    },
    /** Feeds the input layer a key state without a real keyboard, for tests. */
    pressKeys(codes, down = true) {
      input.setKeys?.(codes, down);
    },
    /** A vector in the game's own maths library, so tests can place rounds without importing it. */
    vec3(x, y, z) { return new THREE.Vector3(x, y, z); },
    // A getter, not a value: the air defence is rebuilt on every round change, so a captured
    // reference would keep pointing at the first round's empty emplacements.
    get airDefence() { return airDefence; },
    get gates() { return gates; },
    get obstacles() { return obstacles; },
    get gateVisuals() { return gateVisuals; },
    setCinema(c) { cinema = c; },
    get round() { return round; },
    get progress() { return progress; },
    // The screenshot scenes stand in for a pilot who has flown a few rounds, so they need to write
    // the campaign record the title card and the debrief both read.
    setProgress(p) { progress = p; },
    // Injected by main.js after both exist: a scene that shows an overlay needs the UI handle, and
    // the UI needs the game, so neither can be built with the other in hand.
    ui: null,
    get campaign() { return CAMPAIGN; },
    get campaignPar() { return campaignPar(); },
    loadRound, beginRound, endRound,
    setView(v) { view = v; },
    getView: () => view,
    setPaused(v) { paused = v; },
    isPaused: () => paused,
    setPhase(p) { sortie.phase = p; },
  };
}
