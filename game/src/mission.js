// The sortie: a ring course threaded up the valley and back, with fuel, health and a clock. The
// rings are the mission's goal and the thing the HUD counts, and each one is a real torus in the
// world the aircraft must fly through, not a marker painted on the screen.
//
// The course is laid in the runway's own frame: it leaves the departure end, runs up the valley
// along the take-off heading, turns, and comes back down the far side, so a pilot who takes off
// straight ahead is already pointed at the first gate.
//
// Each campaign round picks a shape. The shapes are different enough that a round reads as its own
// course rather than the same circuit with more gates: an out-and-back, a climbing spiral, a gorge
// run that hugs the rock, and a wide oval for the storm.

import * as THREE from '../vendor/three.module.min.js';
import { CAMPAIGN, ENEMY, MISSION, RUNWAY, PALETTE } from './config.js';

/**
 * A point on the course at a fraction of the way along, in the runway's frame.
 *
 * `along` runs up the valley on the take-off heading; `lateral` is that heading turned a quarter
 * turn to the right. The `shape` decides how those two progress through the round, and how much
 * the course wiggles, which is what stops the gates reading as a straight line of hoops.
 */
function coursePoint(terrain, t, round) {
  const c = round.course;
  const wiggle = Math.sin(t * Math.PI * c.wiggleFreq * 2) * c.wiggleAmp
    + Math.sin(t * Math.PI * c.wiggleFreq * 3.1 + 1.1) * c.wiggleAmp * 0.35;

  let along;
  let lateral;
  let out;

  if (c.shape === 'out-and-back' || c.shape === 'climb' || c.shape === 'canyon') {
    // Two legs. The outbound run is flown on the left of the valley and the home run on the right,
    // so the two never share airspace and the circuit reads as a loop from the cockpit.
    out = t < 0.62;
    const u = out ? t / 0.62 : (1 - t) / 0.38;
    const ease = out ? u : u;
    along = c.startAlong + ease * (c.outAlong - c.startAlong);
    lateral = out
      ? c.outLateral[0] + ease * (c.outLateral[1] - c.outLateral[0]) + wiggle
      : c.homeLateral[0] + (1 - ease) * (c.homeLateral[1] - c.homeLateral[0]) + wiggle * 0.6;
    // The canyon tightens as it goes: the last gates sit right on the rock.
    if (c.shape === 'canyon') lateral *= 0.78;
  } else {
    // A plain oval: one lap out and around, closing back on the airfield.
    const a = t * Math.PI * 2 - Math.PI * 0.5;
    out = Math.sin(a) < 0 ? true : false;
    const radiusAlong = (c.outAlong - c.startAlong) * 0.5;
    const midAlong = (c.outAlong + c.startAlong) * 0.5;
    along = midAlong + Math.sin(a) * radiusAlong;
    const midLateral = (c.outLateral[0] + c.homeLateral[0]) * 0.5;
    const radiusLateral = (c.homeLateral[0] - c.outLateral[0]) * 0.5;
    lateral = midLateral - Math.cos(a) * radiusLateral + wiggle * 0.7;
  }

  // Rotate the runway's frame into world space. Along runs on the take-off heading; lateral is
  // that heading turned a quarter turn to the right.
  const s = Math.sin(RUNWAY.heading);
  const co = Math.cos(RUNWAY.heading);
  const x = RUNWAY.x + s * along + co * lateral;
  const z = RUNWAY.z - co * along + s * lateral;

  return { x, z, ground: terrain.heightAt(x, z), along, lateral, out };
}

/**
 * Lays the course out from the runway: a climbing leg up the valley, a turn, and a run home. The
 * gates follow the terrain's contour at a fixed clearance, so the course threads the land rather
 * than floating over it.
 */
export function buildCourse(terrain, round = CAMPAIGN[0]) {
  const gates = [];
  const count = round.gates;
  const cl = round.course.clearance;

  for (let i = 0; i < count; i += 1) {
    const t = count === 1 ? 0 : i / (count - 1);
    const point = coursePoint(terrain, t, round);
    const ahead = coursePoint(terrain, Math.min(1, t + 0.055), round);
    const behind = coursePoint(terrain, Math.max(0, t - 0.055), round);

    // The gate faces the way the course travels through it.
    const heading = Math.atan2(ahead.x - behind.x, -(ahead.z - behind.z));

    // Height: clear of the ground by the round's own profile, and climbing as the valley climbs so
    // the course reads as a sortie rather than a flat slalom. The floor stops a low round's gates
    // from being buried in a ridge.
    const clearance = cl.base + Math.sin(t * Math.PI) * cl.arc;
    const y = Math.max(point.ground + clearance, RUNWAY.elevation + cl.min + t * cl.perT);

    gates.push({
      x: point.x, y, z: point.z, heading,
      radius: round.radius,
      index: i, passed: false,
    });
  }
  return gates;
}

/**
 * Builds one torus per gate, plus a slim inner ring that shows the plane of the opening, and
 * returns the meshes so the renderer can recolour them as the course is flown.
 */
export function buildGateMeshes(gates, radius = MISSION.radius) {
  const group = new THREE.Group();
  group.name = 'gates';
  const meshes = [];

  const tube = MISSION.tube;
  gates.forEach((gate, i) => {
    // A 12-sided tube rather than 8, and 56 segments round the hoop: at 8 the ring's silhouette
    // shows its facets against the sky, which is one of the tells that says "primitive".
    const geometry = new THREE.TorusGeometry(gate.radius ?? radius, tube, 12, 56);
    // The ring is lit like a painted steel structure that happens to glow, not like a UI sprite:
    // it keeps a real diffuse response, casts a shadow on the ground it hangs over, and the
    // emissive only carries the colour it would carry at dusk. That is what puts it in the world.
    const material = new THREE.MeshStandardMaterial({
      color: i === 0 ? 0xffb733 : 0x1d8f74,
      emissive: i === 0 ? PALETTE.ringNext : PALETTE.ring,
      emissiveIntensity: i === 0 ? 0.85 : 0.42,
      roughness: 0.45,
      metalness: 0.35,
      envMapIntensity: 0.9,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(gate.x, gate.y, gate.z);
    // The torus is built in the XY plane with its normal on +Z; a heading of h points the gate's
    // normal along (sin h, 0, -cos h), which a Y rotation of PI - h gives.
    mesh.rotation.y = Math.PI - gate.heading;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);

    // Four struts across the ring, so a gate reads as a built thing rather than a bare hoop.
    const strut = new THREE.MeshStandardMaterial({ color: 0x8a9198, roughness: 0.6, metalness: 0.5 });
    for (const angle of [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, gate.radius * 0.55), strut);
      bar.position.set(
        Math.cos(angle) * gate.radius,
        Math.sin(angle) * gate.radius,
        0,
      );
      bar.rotation.z = angle;
      bar.castShadow = true;
      mesh.add(bar);
    }

    // A number board beside the ring, so the pilot can count them off from the air.
    meshes.push(mesh);
  });

  return { group, meshes };
}

/** Frees the meshes a previous round built, so a round change does not leak geometry. */
export function disposeGateMeshes(gateVisuals) {
  if (!gateVisuals) return;
  for (const mesh of gateVisuals.meshes) {
    mesh.geometry?.dispose();
    mesh.material?.dispose();
    for (const child of mesh.children) {
      child.geometry?.dispose();
      child.material?.dispose();
    }
  }
}

/** Paints a gate as pending, current or flown, so the HUD and the world agree. */
export function styleGate(mesh, state) {
  const colour = state === 'next' ? PALETTE.ringNext : state === 'done' ? PALETTE.ringDone : PALETTE.ring;
  mesh.material.color.setHex(colour);
  mesh.material.emissive.setHex(colour);
  mesh.material.emissiveIntensity = state === 'next' ? 1.15 : state === 'done' ? 0.2 : 0.65;
}

/** The gate the pilot is flying to: the first one not yet passed. */
export function nextGate(gates) {
  return gates.find((g) => !g.passed) ?? null;
}

/**
 * Checks whether the aircraft went through a gate this step. A gate counts when the aircraft
 * crosses its plane inside the opening: the signed distance flips sign between steps, and the
 * crossing point lies within the ring's radius.
 */
export function checkGateCrossing(gate, previous, current) {
  if (!gate || gate.passed) return false;
  const nx = Math.sin(gate.heading);
  const nz = -Math.cos(gate.heading);

  const px = previous.x - gate.x, py = previous.y - gate.y, pz = previous.z - gate.z;
  const cx = current.x - gate.x, cy = current.y - gate.y, cz = current.z - gate.z;

  const before = px * nx + pz * nz;
  const after = cx * nx + cz * nz;
  if (!(before < 0 && after >= 0) && !(before > 0 && after <= 0)) return false;

  // Linear interpolation to the crossing point, then measure how far off-centre it is.
  const t = before === after ? 0 : before / (before - after);
  const ix = px + (cx - px) * t;
  const iy = py + (cy - py) * t;
  const dist = Math.hypot(ix, iy);
  return dist <= gate.radius;
}

/** Distance in metres from the aircraft to a gate, and the bearing to fly to reach it. */
export function gateBearing(gate, position) {
  const dx = gate.x - position.x;
  const dy = gate.y - position.y;
  const dz = gate.z - position.z;
  const distance = Math.hypot(dx, dy, dz);
  // Bearing measured the same way the aircraft's heading is: 0 along -Z, positive to the right.
  const bearing = Math.atan2(dx, -dz);
  return { distance, bearing, dy };
}

/**
 * The round's score, out of a thousand, from what the pilot actually did. It rewards the things a
 * pilot is judged on: every gate, a landing rather than a crash, airframe and fuel still in hand,
 * and time left on the clock. The difficulty multiplier is what makes the later rounds worth more.
 */
/**
 * The round's score out of 1000, scaled by the round's difficulty.
 *
 * The weights are the design: gates are most of it (620), because the course is the point; the
 * landing is 200, because flying the course and then bending the aircraft on the runway is not a
 * finished sortie; airframe and fuel are 70 and 40, so damage is expensive but not fatal to a
 * score; and time is 70, enough to reward a clean line and not enough to make the pilot rush.
 *
 * Kills are added on top rather than taken out of the same 1000, so a pilot who flies the course
 * perfectly scores 1000 whether or not they shoot anything, and a pilot who also clears the flak
 * gets a reason to take the risk.
 */
export function scoreRound({
  round, gatesPassed, landed, crashed, health, fuel, maxFuel, timeLeft, maxTime, kills = 0,
  aceKills = 0,
}) {
  const total = round.gates;
  const gatesPart = (gatesPassed / total) * 620;
  const landingPart = landed ? 200 : crashed ? 0 : 80;
  const healthPart = Math.max(0, Math.min(1, health / 100)) * 70;
  const fuelPart = Math.max(0, Math.min(1, fuel / maxFuel)) * 40;
  const timePart = Math.max(0, Math.min(1, timeLeft / maxTime)) * 70;
  const raw = gatesPart + landingPart + healthPart + fuelPart + timePart;
  const base = Math.round(Math.min(1000, raw * round.difficulty));
  // `kills` counts every machine; `aceKills` is how many of those were flight leaders, which pay
  // the leader's rate instead of the wingman's. The two must be counted this way rather than by
  // adding a second bonus on top, or a leader killed would be paid twice.
  const wingmen = Math.max(0, kills - aceKills);
  const killBonus = Math.round(
    (wingmen + aceKills * (ENEMY.aceBonus ?? 1)) * ENEMY.killScore * round.difficulty,
  );
  return base + killBonus;
}

/**
 * What the round still wants shot down.
 *
 * The campaign's later sorties are not just courses: they ask for a gun line to be broken or an
 * interceptor flight to be survived, and the gates do not count until that is done. Keeping the
 * arithmetic here rather than in the game loop means the HUD, the end-of-round test and the
 * briefing all read the same answer — the bug that made a round impossible to finish was three
 * slightly different comparisons of the same two counts.
 */
export function objectiveProgress(round, { turretsKilled = 0, dronesKilled = 0 } = {}) {
  const need = round.winCondition ?? { flak: 0, drones: 0 };
  const flakNeed = need.flak ?? 0;
  const droneNeed = need.drones ?? 0;
  return {
    flakNeed,
    droneNeed,
    flakDone: Math.min(turretsKilled, flakNeed),
    droneDone: Math.min(dronesKilled, droneNeed),
    /** False for a round that is flown with the guns cold, so the HUD can hide the line. */
    required: flakNeed + droneNeed > 0,
    met: turretsKilled >= flakNeed && dronesKilled >= droneNeed,
  };
}

/** Writes the campaign's progress: which rounds are open, and the best score on each. */
export const PROGRESS_KEY = 'ridge-runner-progress-v1';

export function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { unlocked: 1, best: {}, total: 0 };
    const parsed = JSON.parse(raw);
    return {
      unlocked: Math.max(1, Math.min(CAMPAIGN.length, parsed.unlocked ?? 1)),
      best: parsed.best ?? {},
      total: parsed.total ?? 0,
    };
  } catch {
    return { unlocked: 1, best: {}, total: 0 };
  }
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    /* A private window refuses storage: the campaign just does not persist. */
  }
}

/**
 * Records a finished round, unlocking the next one when the pilot completed the course.
 *
 * "Completed" is both halves: the gates flown and the round's kill requirement met. A result that
 * predates the objective system has no `objectiveMet` field at all, so an absent key is read as
 * satisfied — otherwise every save from the old build would lock the campaign behind a record it
 * never had a chance to earn.
 */
export function recordRound(progress, roundIndex, result) {
  const next = {
    unlocked: progress.unlocked,
    best: { ...progress.best },
    total: 0,
  };
  const previousBest = next.best[roundIndex] ?? 0;
  next.best[roundIndex] = Math.max(previousBest, result.score);
  const objectiveDone = result.objectiveMet !== false;
  if (result.gatesPassed >= CAMPAIGN[roundIndex].gates && objectiveDone
    && roundIndex + 1 > next.unlocked - 1) {
    next.unlocked = Math.max(next.unlocked, Math.min(CAMPAIGN.length, roundIndex + 2));
  }
  next.total = Object.values(next.best).reduce((a, b) => a + b, 0);
  return next;
}
