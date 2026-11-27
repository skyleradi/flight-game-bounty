// Things to hit.
//
// A flight game with an empty sky has no tension: every gate is reachable in a straight line and
// the only way to lose is to fly into the ground, which the pilot can see coming from a mile away.
// Obstacles put something between the gates that has to be flown around, and — because they are
// solid — they turn a careless line into damage.
//
// Three kinds, chosen because they belong to the landscape the campaign already establishes:
//
//  - **Rock spires**: the same eroded rock the terrain is made of, standing as pillars in the
//    valley. They read at distance and they cast a shadow, so a low pass has a warning.
//  - **Radio masts**: lattice towers with a red obstruction light, which is what actually gets
//    planted on a ridge in a valley like this. Thin, so they are easy to miss until too late.
//  - **Wind turbines**: on the exposed ridges. The blades turn, which gives the whole world a
//    sense of air moving even when the aircraft is flying straight.
//
// Every obstacle exposes a collision volume as a vertical cylinder (or a sphere for the turbine's
// rotor) so the hit test is a distance, not a mesh intersection: at 130 m/s the aircraft moves two
// metres a frame and a triangle test would tunnel straight through a mast.

import * as THREE from '../vendor/three.module.min.js';
import { RUNWAY, PALETTE } from './config.js';
import { runwayFrame } from './physics.js';

/**
 * A cheap deterministic RNG, seeded so the same valley always grows the same obstacles: a course
 * the player learns has to be the same course on the next run, or practice means nothing.
 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** A rock spire: a tapered, twisted column of stacked rings, flat-shaded like the cliffs. */
function buildSpire(radius, height, rng) {
  const rings = 9;
  const seg = 7;
  const positions = [];
  const indices = [];

  // Each ring's radius is jittered and its centre offset, so the column leans and bulges like
  // weathered rock instead of extruding as a clean prism.
  const lean = (rng() - 0.5) * 0.22;
  const centres = [];
  for (let r = 0; r < rings; r += 1) {
    const t = r / (rings - 1);
    // Taper hard at the top, and pinch once near the middle so the spire has a shoulder.
    const taper = 1 - Math.pow(t, 1.45) * 0.78;
    const shoulder = 1 - Math.exp(-Math.pow((t - 0.55) / 0.16, 2)) * 0.16;
    centres.push({
      y: t * height,
      rad: radius * taper * shoulder * (0.86 + rng() * 0.28),
      x: lean * t * height * 0.5 + (rng() - 0.5) * radius * 0.16,
      z: (rng() - 0.5) * radius * 0.16,
    });
  }

  for (let r = 0; r < rings; r += 1) {
    const c = centres[r];
    for (let i = 0; i < seg; i += 1) {
      const a = (i / seg) * Math.PI * 2;
      // A twist per ring, so the facets do not line up into vertical stripes.
      const twist = r * 0.13;
      positions.push(
        c.x + Math.cos(a + twist) * c.rad,
        c.y,
        c.z + Math.sin(a + twist) * c.rad,
      );
    }
  }
  for (let r = 0; r < rings - 1; r += 1) {
    for (let i = 0; i < seg; i += 1) {
      const j = (i + 1) % seg;
      const a = r * seg + i;
      const b = r * seg + j;
      const c = (r + 1) * seg + i;
      const d = (r + 1) * seg + j;
      indices.push(a, c, b, b, c, d);
    }
  }
  const top = centres[rings - 1];
  const tipIndex = positions.length / 3;
  positions.push(top.x, top.y + radius * 0.5, top.z);
  const base = (rings - 1) * seg;
  for (let i = 0; i < seg; i += 1) {
    indices.push(base + i, tipIndex, base + ((i + 1) % seg));
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A lattice radio mast: three legs and cross-bracing, plus a lit head. */
function buildMast(height, rng) {
  const group = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({
    color: 0x9aa3ac, roughness: 0.55, metalness: 0.75,
  });
  const red = new THREE.MeshStandardMaterial({
    color: 0xc0392b, roughness: 0.6, metalness: 0.35,
  });

  // Three tapered legs, converging as they rise, which is what makes a mast read as a mast.
  const legs = 3;
  const baseRadius = 2.1;
  const legGeo = new THREE.CylinderGeometry(0.10, 0.16, height, 5);
  for (let i = 0; i < legs; i += 1) {
    const a = (i / legs) * Math.PI * 2;
    const leg = new THREE.Mesh(legGeo, steel);
    leg.position.set(
      Math.cos(a) * baseRadius * 0.5,
      height * 0.5,
      Math.sin(a) * baseRadius * 0.5,
    );
    // Lean the leg inward so the three meet near the top.
    leg.rotation.z = -Math.cos(a) * Math.atan2(baseRadius * 0.42, height);
    leg.rotation.x = Math.sin(a) * Math.atan2(baseRadius * 0.42, height);
    leg.castShadow = true;
    group.add(leg);
  }

  // Cross-braces: a helix of thin bars, which is what actually gives a lattice its look.
  const braceGeo = new THREE.CylinderGeometry(0.055, 0.055, baseRadius * 1.6, 4);
  for (let r = 1; r <= 7; r += 1) {
    const y = (r / 8) * height;
    const shrink = 1 - (y / height) * 0.72;
    for (let i = 0; i < 3; i += 1) {
      const angle = (i / 3) * Math.PI * 2 + r * 0.55;
      const radius = baseRadius * 0.5 * shrink;
      const brace = new THREE.Mesh(braceGeo, steel);
      brace.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
      brace.rotation.set(0, -angle, Math.PI / 2 - 0.22);
      group.add(brace);
    }
  }

  // The head: a small platform and the obstruction light nothing is allowed to leave unlit.
  const head = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.4, 2.4), steel);
  head.position.y = height;
  group.add(head);
  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.34, 8, 6),
    new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff3020, emissiveIntensity: 6 }),
  );
  beacon.position.y = height + 0.55;
  group.add(beacon);
  group.userData.beacon = beacon;

  // A dish, because a mast with nothing on it is just a pylon.
  const dish = new THREE.Mesh(new THREE.SphereGeometry(1.0, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.4), steel);
  dish.rotation.set(Math.PI * 0.62, rng() * Math.PI, 0);
  dish.position.set(0.9, height * 0.72, 0);
  dish.scale.set(1, 0.55, 1);
  group.add(dish);

  return group;
}

/** A wind turbine: tapering tower, nacelle, three blades, and its own rotation handle. */
function buildTurbine(height) {
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({
    color: 0xf2f4f6, roughness: 0.42, metalness: 0.18,
  });

  // The tower is a lathe: wide at the base, narrow at the nacelle.
  const profile = [];
  const stations = 8;
  for (let i = 0; i <= stations; i += 1) {
    const t = i / stations;
    profile.push(new THREE.Vector2(3.0 - t * 2.15, t * height));
  }
  const tower = new THREE.Mesh(new THREE.LatheGeometry(profile, 12), shell);
  tower.castShadow = true;
  tower.receiveShadow = true;
  group.add(tower);

  const nacelle = new THREE.Mesh(new THREE.CapsuleGeometry(1.15, 3.4, 4, 8), shell);
  nacelle.rotation.z = Math.PI / 2;
  nacelle.position.set(0, height + 0.2, 0);
  nacelle.castShadow = true;
  group.add(nacelle);

  // The rotor: three blades and a hub, hung off a pivot so the animation only turns this group.
  const rotor = new THREE.Group();
  rotor.position.set(-1.6, height + 0.2, 0);
  const bladeGeo = new THREE.BoxGeometry(0.30, 17, 1.5);
  bladeGeo.translate(0, 8.5, 0);
  for (let i = 0; i < 3; i += 1) {
    const blade = new THREE.Mesh(bladeGeo, shell);
    blade.rotation.x = (i * Math.PI * 2) / 3;
    blade.castShadow = true;
    rotor.add(blade);
  }
  const hub = new THREE.Mesh(new THREE.SphereGeometry(1.0, 10, 8), shell);
  rotor.add(hub);
  group.add(rotor);
  group.userData.rotor = rotor;

  return group;
}

/**
 * Where an obstacle may stand: clear of the runway and its approach, on ground flat enough to
 * build, and never inside a gate's ring.
 *
 * `gates` is the course; passing it lets the placement refuse any spot the player must fly
 * through, which is the difference between an obstacle course and a wall across the finish line.
 */
function isClear(x, z, y, minClearance, gates) {
  // The runway and both of its extended centrelines: an obstacle in the approach or departure path
  // is not a challenge, it is a scripted crash.
  //
  // This used to compute the frame inline with `dx * sin(h) + dz * cos(h)` for "along", which is
  // not the runway frame at all: at a point 1.2 km down the centreline it reported 442 m of lateral
  // offset, so nothing was ever excluded except the exact centre point. Two rock spires ended up
  // standing on the strip. runwayFrame() is the one definition of this geometry; use it.
  const { along, across } = runwayFrame(x, z);
  const onCentre = Math.abs(across) < RUNWAY.width * 1.2;
  // Cover the whole strip plus a generous run-out in BOTH directions, because the approach can be
  // flown from either end depending on which way the terrain lets an aircraft in.
  const inApproach = Math.abs(along) < RUNWAY.length * 1.4;
  if (onCentre && inApproach) return false;

  // Nothing within a gate's ring plus a margin: the player is aiming there at speed.
  for (const gate of gates) {
    const d = Math.hypot(x - gate.x, z - gate.z);
    if (d < gate.radius * 3.2 + 40) return false;
    // Nor directly under a gate, where a spire would block the low line under it.
    if (d < gate.radius * 2.0 && y > gate.y - 80) return false;
  }
  return minClearance === undefined || minClearance > 0;
}

/**
 * Builds every obstacle for a round, returning the group plus a flat list of collision volumes.
 *
 * The list is what the flight model tests against, and each entry is deliberately simple: a
 * cylinder is `{x, z, y0, y1, r}` and a sphere (the turbine rotor) is `{x, y, z, r, sphere: true}`.
 * The caller treats a hit as damage, so the shape only has to be right to within a metre.
 */
/**
 * Test whether the aircraft's path this step passed through an obstacle.
 *
 * The test is swept, not positional. At 130 m/s the aircraft covers more than two metres in a
 * frame, so a test against its current position alone would let it pass straight through a mast
 * between two frames — the classic tunnelling bug, and one that only shows up at exactly the speed
 * the player will be flying when they hit something.
 *
 * A cylinder collider is reduced to a 2D circle test in the XZ plane with the closest point on the
 * segment, then the aircraft's height at that same parameter decides whether it was inside the
 * obstacle's vertical span. That is exact for the shape and costs a handful of multiplies.
 *
 * Returns `{ collider, t }` for the first hit along the path, or null.
 */
export function checkCollision(colliders, from, to, bodyRadius = 2.4) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const segLenSq = dx * dx + dy * dy + dz * dz;
  if (segLenSq < 1e-8) return null;

  let best = null;
  for (const c of colliders) {
    if (c.sphere) {
      // Point-to-segment distance in 3D.
      const fx = from.x - c.x;
      const fy = from.y - c.y;
      const fz = from.z - c.z;
      let t = -(fx * dx + fy * dy + fz * dz) / segLenSq;
      t = Math.max(0, Math.min(1, t));
      const px = fx + dx * t;
      const py = fy + dy * t;
      const pz = fz + dz * t;
      const distSq = px * px + py * py + pz * pz;
      const rr = c.r + bodyRadius;
      if (distSq < rr * rr && (!best || t < best.t)) best = { collider: c, t };
      continue;
    }

    // Cylinder: closest approach in the horizontal plane.
    const fx = from.x - c.x;
    const fz = from.z - c.z;
    const flatLenSq = dx * dx + dz * dz;
    let t;
    if (flatLenSq < 1e-8) {
      // Straight up or down: the whole step is at one spot horizontally.
      if (fx * fx + fz * fz > (c.r + bodyRadius) ** 2) continue;
      t = 0;
    } else {
      t = -(fx * dx + fz * dz) / flatLenSq;
      t = Math.max(0, Math.min(1, t));
    }
    const px = fx + dx * t;
    const pz = fz + dz * t;
    const rr = c.r + bodyRadius;
    if (px * px + pz * pz > rr * rr) continue;

    // Inside the circle horizontally — check the vertical span at the same parameter.
    const y = from.y + dy * t;
    if (y + 1.0 < c.y0 || y - 1.0 > c.y1) continue;
    if (!best || t < best.t) best = { collider: c, t };
  }
  return best;
}

/**
 * How much a given kind of obstacle hurts.
 *
 * A mast is a wire-frame of thin steel that gives way; a rock spire does not. The numbers are
 * tuned so a clipped mast is survivable and a head-on spire is not, which is what teaches the
 * player to respect the rock and thread the mast.
 */
export function collisionDamage(kind, speed) {
  // Speed is in m/s; the airframe is rated for 132, so this normalises to roughly 0..1.4.
  const impact = Math.min(2.2, Math.max(0.25, speed / 95));
  switch (kind) {
    case 'spire': return 62 * impact;
    case 'turbine': return 74 * impact;
    case 'rotor': return 48 * impact;
    case 'mast': return 34 * impact;
    default: return 40 * impact;
  }
}

export function buildObstacles(terrain, round, gates) {
  const group = new THREE.Group();
  group.name = 'obstacles';
  const colliders = [];
  const rng = makeRng((round.seed ?? 0) ^ 0x51ed);

  // --- Rock spires. Concentrated where the land is high and broken, which is where the valley
  // walls are, so they appear as outcrops of the terrain rather than as objects dropped on it.
  const rockMat = new THREE.MeshStandardMaterial({
    color: PALETTE.rock, roughness: 0.95, metalness: 0.0, flatShading: true,
  });
  const spireCount = 26;
  for (let i = 0; i < spireCount; i += 1) {
    // Sample around the course rather than uniformly, so the spires cluster along the route.
    const gate = gates[Math.floor(rng() * gates.length)];
    if (!gate) break;
    const a = rng() * Math.PI * 2;
    const d = 160 + rng() * 620;
    const x = gate.x + Math.cos(a) * d;
    const z = gate.z + Math.sin(a) * d;
    const y = terrain.heightAt(x, z);
    if (y < 20 || !isClear(x, z, y, 1, gates)) continue;
    // Reject steep ground: a spire needs a shoulder to stand on.
    const slope = Math.abs(terrain.heightAt(x + 18, z) - y) + Math.abs(terrain.heightAt(x, z + 18) - y);
    if (slope / 18 > 0.55) continue;

    const radius = 5 + rng() * 9;
    const height = 28 + rng() * 62;
    const spire = new THREE.Mesh(buildSpire(radius, height, rng), rockMat);
    spire.position.set(x, y - 1.5, z);
    spire.castShadow = true;
    spire.receiveShadow = true;
    group.add(spire);
    colliders.push({ x, z, y0: y - 2, y1: y + height, r: radius * 0.92, kind: 'spire' });
  }

  // --- Radio masts, on the high ground. Two or three a round: enough to matter, few enough that
  // each one is memorable.
  const mastCount = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < mastCount; i += 1) {
    let placed = false;
    for (let tries = 0; tries < 40 && !placed; tries += 1) {
      const gate = gates[Math.floor(rng() * gates.length)];
      if (!gate) break;
      const a = rng() * Math.PI * 2;
      const d = 240 + rng() * 520;
      const x = gate.x + Math.cos(a) * d;
      const z = gate.z + Math.sin(a) * d;
      const y = terrain.heightAt(x, z);
      if (y < 120 || !isClear(x, z, y, 1, gates)) continue;
      const height = 90 + rng() * 55;
      const mast = buildMast(height, rng);
      mast.position.set(x, y, z);
      group.add(mast);
      colliders.push({ x, z, y0: y, y1: y + height, r: 2.2, kind: 'mast' });
      placed = true;
    }
  }

  // --- Wind turbines on the exposed ridges, where the wind the HUD reports would actually be.
  const turbineCount = 3 + Math.floor(rng() * 3);
  const rotors = [];
  for (let i = 0; i < turbineCount; i += 1) {
    let placed = false;
    for (let tries = 0; tries < 40 && !placed; tries += 1) {
      const x = (rng() * 2 - 1) * 3200 + RUNWAY.x;
      const z = (rng() * 2 - 1) * 3200 + RUNWAY.z;
      const y = terrain.heightAt(x, z);
      if (y < 260 || !isClear(x, z, y, 1, gates)) continue;
      const slope = Math.abs(terrain.heightAt(x + 20, z) - y) + Math.abs(terrain.heightAt(x, z + 20) - y);
      if (slope / 20 > 0.32) continue;
      const height = 62 + rng() * 26;
      const turbine = buildTurbine(height);
      // Face the rotors across the prevailing wind, so the row does not look stamped.
      turbine.rotation.y = rng() * Math.PI * 2;
      turbine.position.set(x, y, z);
      group.add(turbine);
      rotors.push({ rotor: turbine.userData.rotor, rate: 0.55 + rng() * 0.5 });
      colliders.push({ x, z, y0: y, y1: y + height, r: 2.6, kind: 'turbine' });
      // The rotor itself sweeps a disc 8.5 m out from the nacelle; a sphere is close enough at
      // the speed the aircraft travels.
      colliders.push({
        x, y: y + height + 0.2, z, r: 9.0, sphere: true, kind: 'rotor',
      });
      placed = true;
    }
  }

  // --- Birds. Not solid obstacles: flocks are an atmosphere cue with a cost, so they are checked
  // separately and only damage the airframe lightly. Kept in their own list for that reason.
  const flocks = [];
  const flockCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < flockCount; i += 1) {
    const gate = gates[Math.floor(rng() * gates.length)];
    if (!gate) break;
    const x = gate.x + (rng() - 0.5) * 700;
    const z = gate.z + (rng() - 0.5) * 700;
    const y = terrain.heightAt(x, z) + 45 + rng() * 190;
    const birds = [];
    const birdGeo = new THREE.BufferGeometry();
    // A bird at this distance is a two-triangle chevron: anything more is invisible.
    const verts = new Float32Array([
      0, 0, 0, -1.6, 0.35, 0.9, -0.35, 0, 0,
      0, 0, 0, 0.35, 0, 0, 1.6, 0.35, 0.9,
    ]);
    birdGeo.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    birdGeo.computeVertexNormals();
    const birdMat = new THREE.MeshStandardMaterial({
      color: 0x22262b, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
    });
    for (let b = 0; b < 14; b += 1) {
      const bird = new THREE.Mesh(birdGeo, birdMat);
      bird.scale.setScalar(1.4 + rng() * 0.9);
      bird.position.set((rng() - 0.5) * 40, (rng() - 0.5) * 14, (rng() - 0.5) * 40);
      birds.push({ mesh: bird, phase: rng() * Math.PI * 2, speed: 0.6 + rng() * 0.5 });
      group.add(bird);
    }
    flocks.push({ x, y, z, birds, hit: false });
  }

  return {
    group,
    colliders,
    flocks,
    /** Spins the rotors and flaps the birds. Cheap: a handful of objects per round. */
    update(dt, time) {
      for (const r of rotors) r.rotor.rotation.z += dt * r.rate;
      for (const flock of flocks) {
        for (const b of flock.birds) {
          // A shallow sine on the wing root: at this size it reads as a wingbeat, not a flutter.
          b.mesh.rotation.z = Math.sin(time * 6 + b.phase) * 0.5;
          b.mesh.position.y += Math.sin(time * 1.3 + b.phase) * dt * 1.6;
        }
      }
    },
  };
}
