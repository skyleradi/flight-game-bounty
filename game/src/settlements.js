// The inhabited layer: towns, a road network, factories, a harbour and the sea they sit on.
//
// The valley the campaign flies through is not wilderness. A fictional alpine region of this size
// has roads along the floor, a few settlements where the ground is flat enough to build on, a works
// with stacks that can be seen for twenty kilometres, and — where the land runs out — a coast with
// a harbour. Those are the landmarks a pilot actually navigates by, and their absence is a large
// part of why procedural terrain reads as an empty heightfield rather than a place.
//
// Everything here is:
//   * **Built from the terrain**, not placed by hand. Every building sits on `terrain.heightAt`, so
//     a town can never float over a hill or sink into one, and re-generating the world re-sites it.
//   * **Deterministic.** One seeded RNG, so the same seed gives the same towns. A screenshot is
//     reproducible and a pilot can learn the landmarks.
//   * **Merged where it is dense.** A hundred houses are one draw call: `mergeGeometries` bakes the
//     lot into a single buffer with the colours carried per-vertex. Individually drawn houses would
//     cost a hundred state changes a frame to say nothing an atlas does not.
//
// The flat-ground test is the important one. Buildings on a 25-degree slope look wrong in a way no
// amount of detail fixes, so each candidate site samples the terrain at its own corners and is
// rejected if the fall across the footprint is more than a couple of metres.

import * as THREE from '../vendor/three.module.min.js';
import { WORLD, RUNWAY, PALETTE } from './config.js';
import { coastAt } from './sea.js';

/** Deterministic RNG, same shape as the other modules', so nothing here depends on frame order. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Clamps to 0..1. Local because this module has no shared math import and does not need one. */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A box's eight corners as a merged-ready geometry, translated into world space. */
function box(w, h, d, x, y, z, rot = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.rotateY(rot);
  g.translate(x, y + h * 0.5, z);
  return g;
}

/** A pitched roof: a triangular prism, the shape half the buildings here need. */
function roof(w, h, d, x, y, z, rot = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(-w * 0.5, 0);
  shape.lineTo(w * 0.5, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d * 0.5);
  if (rot) g.rotateY(rot);
  g.translate(x, y, z);
  return g;
}

/** Paints a geometry one flat colour, so a merged mesh can carry many. */
function paint(geometry, hex) {
  const c = new THREE.Color(hex);
  const n = geometry.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geometry;
}

/** Merges a list of geometries that all carry position/normal/color into one buffer. */
function merge(list) {
  const geos = list.filter(Boolean);
  if (!geos.length) return null;
  let total = 0;
  let indexTotal = 0;
  for (const g of geos) {
    total += g.attributes.position.count;
    indexTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(total * 3);
  const nrm = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const idx = new Uint32Array(indexTotal);
  let vOff = 0;
  let iOff = 0;
  for (const g of geos) {
    const p = g.attributes.position;
    pos.set(p.array, vOff * 3);
    nrm.set(g.attributes.normal.array, vOff * 3);
    col.set(g.attributes.color.array, vOff * 3);
    if (g.index) {
      for (let i = 0; i < g.index.count; i += 1) idx[iOff + i] = g.index.array[i] + vOff;
      iOff += g.index.count;
    } else {
      for (let i = 0; i < p.count; i += 1) idx[iOff + i] = vOff + i;
      iOff += p.count;
    }
    vOff += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  for (const g of geos) g.dispose();
  return out;
}

/**
 * How flat is the ground under a footprint? Returns the height range across the four corners plus
 * the centre. A building wants a low number; a site with a ridge through it is rejected outright.
 */
function flatness(heightAt, x, z, w, d) {
  const hs = [
    heightAt(x - w * 0.5, z - d * 0.5), heightAt(x + w * 0.5, z - d * 0.5),
    heightAt(x - w * 0.5, z + d * 0.5), heightAt(x + w * 0.5, z + d * 0.5),
    heightAt(x, z),
  ];
  return Math.max(...hs) - Math.min(...hs);
}

/** The distance from a point to the runway centreline, used to keep towns off the approach. */
function runwayOffset(x, z) {
  const dx = x - RUNWAY.x;
  const dz = z - RUNWAY.z;
  const ux = Math.sin(RUNWAY.heading);
  const uz = -Math.cos(RUNWAY.heading);
  const along = dx * ux + dz * uz;
  const lateral = dx * -uz + dz * ux;
  return { along: Math.abs(along), lateral: Math.abs(lateral) };
}

/** Wall colours drawn from a small, believable set: rendered plaster, timber, brick, slate. */
const WALLS = ['#c9bda8', '#b7a894', '#d4c8b2', '#a89a86', '#bfae94', '#8f8474', '#d8cfbc'];
const ROOFS = ['#7a3f34', '#8a4a3c', '#5c5148', '#6b5f52', '#4f4a44', '#8f5a44'];
const SLABS = ['#8d8b86', '#9a9791', '#7e7c78'];

/**
 * The colours a lit window can be. Almost all tungsten (a warm sodium-adjacent yellow), a few
 * fluorescent (a colder green-white, which is what a shop or a works office actually looks like
 * from the air), and one television-blue in the mix so a settlement does not read as monochrome.
 */
const LAMPS = ['#ffd89a', '#ffcf82', '#ffe8bc', '#d6ecff', '#b9d8ff', '#ffc26e'];

/**
 * A town: rows of houses along a street, a couple of larger blocks, a church with a tower.
 *
 * Laid out on a grid aligned to the valley floor rather than scattered, because scattered buildings
 * read as debris. The street itself is drawn later by the road builder, so the houses here are
 * placed along the same axis it will follow.
 */
function planTown(rng, heightAt, centre, { cols, rows, spacing, angle }) {
  const houses = [];
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      // Two rows of houses face a street running between them; larger gaps become plots.
      const lx = (c - (cols - 1) / 2) * spacing;
      const lz = (r - (rows - 1) / 2) * spacing * 1.25;
      const x = centre.x + lx * ca - lz * sa;
      const z = centre.z + lx * sa + lz * ca;
      const w = 9 + rng() * 7;
      const d = 8 + rng() * 6;
      if (flatness(heightAt, x, z, w, d) > 3.2) continue;
      const { along, lateral } = runwayOffset(x, z);
      if (along < 1400 && lateral < 220) continue;
      houses.push({
        x, z, w, d,
        y: heightAt(x, z),
        rot: angle + (rng() - 0.5) * 0.09,
        storeys: rng() < 0.22 ? 2 : 1,
        wall: WALLS[Math.floor(rng() * WALLS.length)],
        roof: ROOFS[Math.floor(rng() * ROOFS.length)],
        pitch: 2.6 + rng() * 2.2,
        // Whether this house has its lights on, and which colour each of its rooms burns. Rolled
        // once at plan time so the pattern is stable: a town whose windows shuffle every frame
        // would flicker like a broken sign. Roughly a quarter of houses are dark — an occupied
        // valley at night, not a Christmas display.
        lit: rng() < 0.74,
        warm: [
          LAMPS[Math.floor(rng() * LAMPS.length)],
          rng() < 0.22 ? null : LAMPS[Math.floor(rng() * LAMPS.length)],
          rng() < 0.4 ? null : LAMPS[Math.floor(rng() * LAMPS.length)],
        ],
      });
    }
  }
  return houses;
}

/** Builds the merged mesh for a list of houses, plus the church if the town is big enough. */
function buildTownGeometry(houses, { church = false, glow = null } = {}) {
  const parts = [];
  for (const h of houses) {
    const storeyH = 3.1;
    const bodyH = storeyH * h.storeys;
    parts.push(paint(box(h.w, bodyH, h.d, h.x, h.y, h.z, h.rot), h.wall));
    // A plinth: buildings meet the ground on a stone course, which is also what hides the small
    // height error between the footprint centre and its corners.
    parts.push(paint(box(h.w + 0.5, 0.7, h.d + 0.5, h.x, h.y - 0.35, h.z, h.rot), '#6f6a62'));
    parts.push(paint(roof(h.w + 1.0, h.pitch, h.d + 1.0, h.x, h.y + bodyH, h.z, h.rot), h.roof));
    // Windows: one thin dark band per storey on the two long faces. At flying distance this reads
    // as a facade and costs six boxes.
    for (let s = 0; s < h.storeys; s += 1) {
      const y = h.y + s * storeyH + 1.55;
      parts.push(paint(box(h.w * 0.86, 1.05, 0.18, h.x, y, h.z + h.d * 0.5, h.rot), '#3a3f45'));
      parts.push(paint(box(h.w * 0.86, 1.05, 0.18, h.x, y, h.z - h.d * 0.5, h.rot), '#3a3f45'));
      // Lit windows. These are a second geometry with a material that ignores lighting entirely, so
      // they burn at 2 a.m. and vanish at noon when the group's opacity is faded out. A slab that
      // passes through the house is the trick: only the few centimetres protruding past each facade
      // survive the depth test, so one box lights both long walls of a storey.
      if (glow && h.lit) {
        const n = h.w > 12 ? 3 : 2;
        const pitch = (h.w * 0.72) / n;
        const ca = Math.cos(h.rot);
        const sa = Math.sin(h.rot);
        for (let k = 0; k < n; k += 1) {
          // Not every room is occupied: a house with all its windows lit reads as a light box.
          if (h.warm[k % h.warm.length] === null) continue;
          const lx = (k - (n - 1) / 2) * pitch;
          const wx = h.x + lx * ca;
          const wz = h.z - lx * sa;
          glow.push(paint(box(1.55, 0.86, h.d + 0.14, wx, y, wz, h.rot), h.warm[k % h.warm.length]));
        }
      }
    }
  }
  if (church) {
    const h = houses[Math.floor(houses.length / 2)];
    if (h) {
      const naveW = 13;
      const naveD = 26;
      const naveH = 9.5;
      parts.push(paint(box(naveW, naveH, naveD, h.x, h.y, h.z, h.rot), '#d9d3c4'));
      parts.push(paint(roof(naveW + 1.2, 5.2, naveD + 1.2, h.x, h.y + naveH, h.z, h.rot), '#55504a'));
      // The tower: square, tall, with a spire. This is the thing the pilot actually sees from
      // three kilometres out, so it is deliberately out of scale with the houses.
      const tx = h.x + Math.cos(h.rot) * 12;
      const tz = h.z + Math.sin(h.rot) * 12;
      const ty = h.y;
      parts.push(paint(box(6.4, 22, 6.4, tx, ty, tz, h.rot), '#e2dccd'));
      parts.push(paint(box(7.2, 1.1, 7.2, tx, ty + 22, tz, h.rot), '#55504a'));
      const spire = new THREE.ConeGeometry(4.6, 12, 4);
      spire.rotateY(h.rot + Math.PI * 0.25);
      spire.translate(tx, ty + 28.6, tz);
      parts.push(paint(spire, '#4a453f'));
    }
  }
  return merge(parts);
}

/**
 * The works: a factory with a sawtooth roof, two chimneys, cooling towers and a yard of tanks.
 *
 * Placed where the ground is flattest and away from the runway, because a 60 m chimney inside the
 * approach is a crash waiting for a player who has not learned the map yet.
 */
function buildWorks(heightAt, x, z, angle) {
  const parts = [];
  const y = heightAt(x, z);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const at = (lx, lz) => ({ x: x + lx * ca - lz * sa, z: z + lx * sa + lz * ca });

  // The main shed: long, low, sawtooth roof.
  const shed = at(0, 0);
  parts.push(paint(box(90, 13, 34, shed.x, y, shed.z, angle), '#8b8579'));
  for (let i = 0; i < 7; i += 1) {
    const p = at(-38 + i * 12.6, 0);
    parts.push(paint(roof(12.4, 3.6, 35, p.x, y + 13, p.z, angle + Math.PI * 0.5), '#6a645b'));
  }
  // Chimneys. Height is the point: they are the landmark.
  const stacks = [];
  for (const [lx, lz, h] of [[44, -12, 62], [44, 6, 48]]) {
    const p = at(lx, lz);
    const stack = new THREE.CylinderGeometry(3.1, 4.3, h, 12);
    stack.translate(p.x, y + h * 0.5, p.z);
    parts.push(paint(stack, '#b9b0a2'));
    const band = new THREE.CylinderGeometry(3.3, 3.3, 3.2, 12);
    band.translate(p.x, y + h - 8, p.z);
    parts.push(paint(band, '#8c4a3a'));
    // The stack head, recorded for the night layer: an obstruction light goes on top of it.
    stacks.push({ x: p.x, y: y + h, z: p.z });
  }
  // Cooling towers, hyperbolic in profile, which is two stacked cylinders here.
  for (const lx of [-46, -78]) {
    const p = at(lx, 18);
    const base = new THREE.CylinderGeometry(9.5, 13.5, 30, 14);
    base.translate(p.x, y + 15, p.z);
    parts.push(paint(base, '#a8a29a'));
    const lip = new THREE.CylinderGeometry(11.2, 9.5, 4, 14);
    lip.translate(p.x, y + 32, p.z);
    parts.push(paint(lip, '#b4aea6'));
  }
  // Storage tanks and a pipe rack.
  for (let i = 0; i < 5; i += 1) {
    const p = at(20 + i * 12, 30);
    const tank = new THREE.CylinderGeometry(5.2, 5.2, 9, 12);
    tank.translate(p.x, y + 4.5, p.z);
    parts.push(paint(tank, '#c3bcae'));
  }
  const rack = at(0, 26);
  parts.push(paint(box(76, 1.0, 2.2, rack.x, y + 8, rack.z, angle), '#7d766a'));
  for (let i = 0; i < 9; i += 1) {
    const p = at(-36 + i * 9, 26);
    parts.push(paint(box(0.8, 8, 0.8, p.x, y, p.z, angle), '#7d766a'));
  }
  return { geometry: merge(parts), x, z, y, stacks };
}

/**
 * The harbour: a breakwater, quay walls, cranes and a row of sheds where the land meets the sea.
 *
 * The sea plane already exists at y = 6; this builds the land side of it, which is what makes the
 * water read as a coast rather than a flooded plain.
 */
function buildHarbour(heightAt, x, z, angle) {
  const parts = [];
  // The quay deck sits at the land's own height, but never below the waterline + 3 m: a quay that
  // is awash is not a quay.
  const groundY = heightAt(x, z);
  const y = Math.max(9.4, groundY);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  // `lx` runs along the shore and `-lz` runs seaward when `angle` is PI/2 (the coast's own axis).
  // The breakwater is built at negative `lz` for exactly that reason: it has to reach out over the
  // water, not back into the car park.
  const at = (lx, lz) => ({ x: x + lx * ca - lz * sa, z: z + lx * sa + lz * ca });

  // Quay: a long concrete edge.
  const q = at(0, 0);
  parts.push(paint(box(150, 4.2, 16, q.x, y, q.z, angle), '#9c9890'));
  // Breakwater: a rubble arm running out into the water, built from stacked blocks.
  for (let i = 0; i < 26; i += 1) {
    const p = at(74 + i * 5.4, -6 - i * 1.6);
    const h = 2.4 + (i % 3) * 0.9;
    parts.push(paint(box(7, h, 6.4, p.x, y - 1.2 + (i % 2) * 0.4, p.z, angle + 0.06 * Math.sin(i)), '#7f7b74'));
  }
  // Cranes: a portal frame with a boom. Four of them, because a harbour with none is a car park.
  for (let i = 0; i < 4; i += 1) {
    const p = at(-52 + i * 26, 4);
    const legY = y + 2;
    parts.push(paint(box(1.5, 16, 1.5, p.x - 4, legY, p.z, angle), '#c98a2e'));
    parts.push(paint(box(1.5, 16, 1.5, p.x + 4, legY, p.z, angle), '#c98a2e'));
    parts.push(paint(box(11, 1.6, 2.0, p.x, legY + 16, p.z, angle), '#c98a2e'));
    // Boom, reaching out over the water.
    const boom = at(-52 + i * 26, -12);
    parts.push(paint(box(2.2, 1.4, 30, p.x, legY + 17, p.z, angle), '#d99a3c'));
    parts.push(paint(box(1.2, 9, 1.2, boom.x, legY + 9, boom.z, angle), '#8f8a80'));
  }
  // Transit sheds.
  for (let i = 0; i < 3; i += 1) {
    const p = at(-46 + i * 44, 22);
    parts.push(paint(box(38, 9, 20, p.x, y + 2, p.z, angle), '#b0aaa0'));
    parts.push(paint(roof(39, 3.4, 21, p.x, y + 11, p.z, angle), '#6f6a62'));
  }
  return { geometry: merge(parts), x, z, y };
}

/**
 * The night layer: window glow, street lamps along the roads, harbour floodlights and the red
 * obstruction lamps on the chimneys.
 *
 * Everything here is `MeshBasicMaterial` — it ignores the scene lights entirely, which is the whole
 * point: at 2 a.m. a window is not lit by the moon, it is lit by a bulb inside it. The group's
 * opacity is driven by the day cycle, so the same geometry is invisible at noon and burning at
 * midnight without rebuilding anything.
 *
 * The glow geometry is built *inside* the building pass (see `buildTownGeometry`), because a lit
 * window has to be punched into the exact facade the wall was drawn on. What comes back here is a
 * list of already-positioned boxes, which is merged into one buffer so a whole town's windows cost
 * one draw call.
 */
function buildNightLights(nightTowns, heightAt) {
  const group = new THREE.Group();
  group.name = 'night-lights';

  const warmMat = new THREE.MeshBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: true, toneMapped: false,
  });
  const lampMat = new THREE.MeshBasicMaterial({
    color: 0xffd190, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: true, toneMapped: false,
  });
  const redMat = new THREE.MeshBasicMaterial({
    color: 0xff4030, transparent: true, opacity: 0, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: true, toneMapped: false,
  });

  // --- Street lamps: pairs down each town's main street, on a 46 m pitch. A lamp is a short post
  // and a glowing head; the post is ordinary geometry so it is only built once, while the head
  // shares the one emissive material so all of them fade together.
  const postParts = [];
  const headParts = [];
  for (const t of nightTowns) {
    const n = 9;
    const angle = t.streetAngle ?? 0;
    const ca = Math.cos(angle);
    const sa = Math.sin(angle);
    for (let i = 0; i < n; i += 1) {
      const along = (i - (n - 1) / 2) * 46;
      for (const side of [-1, 1]) {
        // Lamps sit on the kerb, 15 m either side of the centre line.
        const lx = along * ca - side * 15 * sa;
        const lz = along * sa + side * 15 * ca;
        const x = t.x + lx;
        const z = t.z + lz;
        const y = heightAt(x, z);
        if (Math.abs(y - t.h) > 14) continue; // off the flat: no lamp hanging over a ravine
        postParts.push(paint(box(0.42, 7.2, 0.42, x, y + 3.6, z, 0), '#5d5a54'));
        headParts.push(paint(box(1.5, 0.42, 1.5, x, y + 7.4, z, 0), '#ffe0a8'));
      }
    }
  }
  if (postParts.length) {
    const posts = new THREE.Mesh(merge(postParts), new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.9, metalness: 0.1,
    }));
    posts.name = 'lamp-posts';
    posts.castShadow = false;
    group.add(posts);
  }
  if (headParts.length) {
    const heads = new THREE.Mesh(merge(headParts), lampMat);
    heads.name = 'lamp-heads';
    group.add(heads);
  }

  // --- Yard and quay floodlights: the high lamps that light a works yard or a harbour apron. Same
  // material as the street lamps but a much bigger head, because a floodlight seen from the air is
  // a bright core with a halo, not a dot.
  const yardParts = [];
  for (const t of nightTowns) {
    for (const p of t.yard ?? []) {
      yardParts.push(paint(box(3.0, 3.0, 3.0, p.x, p.y, p.z, 0), '#ffe4b0'));
    }
  }
  if (yardParts.length) {
    const yard = new THREE.Mesh(merge(yardParts), lampMat);
    yard.name = 'yard-lights';
    group.add(yard);
  }

  // --- Chimney obstruction lamps: one red light on each stack of the works. These are the lights a
  // pilot actually uses, so they get their own material and a slow pulse applied in `update`.
  const redParts = [];
  for (const t of nightTowns) {
    for (const s of t.stacks ?? []) {
      redParts.push(paint(box(2.4, 2.4, 2.4, s.x, s.y + 1.0, s.z, 0), '#ff4030'));
    }
  }
  let redLights = null;
  if (redParts.length) {
    redLights = new THREE.Mesh(merge(redParts), redMat);
    redLights.name = 'stack-lights';
    group.add(redLights);
  }

  return {
    group,
    warmMat,
    lampMat,
    redMat,
    /**
     * Fades the whole night layer in or out. `level` is the day cycle's light level: 1 at noon, 0 at
     * midnight. The layer starts burning at dusk (0.45) and is at full strength by the time the sun
     * is properly down, so a settlement lights up gradually rather than snapping on.
     *
     * The window glow is held back a little relative to the street lamps: people turn their lights
     * on as it gets dark, but a street lamp comes on at a threshold, which is the small detail that
     * makes dusk read as dusk.
     */
    setNight(level, time = 0) {
      const dark = 1 - clamp01(level);
      // Windows and lamps ramp over the bottom half of the light range.
      const lit = clamp01((dark - 0.35) / 0.5);
      const lampLit = clamp01((dark - 0.18) / 0.34);
      warmMat.opacity = lit * 0.95;
      lampMat.opacity = lampLit;
      // Obstruction lights pulse: a slow 2-second breath, the way a real one does, and only at
      // night. They are dimmed by the same lamp curve so they do not appear at noon.
      redMat.opacity = lampLit * (0.55 + 0.45 * Math.sin(time * 2.1));
      group.visible = dark > 0.16;
    },
  };
}

/**
 * Roads: a floor road along the valley and spurs to the towns.
 *
 * Drawn as a ribbon that follows the terrain, built by sampling the heightfield along a polyline and
 * laying a quad strip slightly above it. Not a texture on the ground: the terrain has no UVs to
 * speak of, and a ribbon can be given a centre line and a shoulder, which is what makes a road read
 * as a road from the air.
 */
function buildRoads(terrain, seeds, heightAt) {
  const parts = [];
  const { size } = WORLD;

  const ribbon = (points, width, hex) => {
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.5) continue;
      const nx = -dz / len;
      const nz = dx / len;
      const hw = width * 0.5;
      // Four corners, each lifted onto the ground and given a small clearance so the ribbon never
      // z-fights the heightfield it is lying on.
      const corners = [
        { x: a.x + nx * hw, z: a.z + nz * hw },
        { x: a.x - nx * hw, z: a.z - nz * hw },
        { x: b.x - nx * hw, z: b.z - nz * hw },
        { x: b.x + nx * hw, z: b.z + nz * hw },
      ].map((c) => ({ ...c, y: heightAt(c.x, c.z) + 0.6 }));
      const pos = [];
      for (const c of corners) pos.push(c.x, c.y, c.z);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.computeVertexNormals();
      parts.push(paint(g, hex));
    }
  };

  // The trunk road: a wandering line along the valley floor from the airfield to the coast.
  const trunk = [];
  const rng = makeRng(9041);
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const x = -size * 0.44 + t * size * 0.88;
    const z = RUNWAY.z + Math.sin(t * 6.2) * 700 + (rng() - 0.5) * 90;
    trunk.push({ x, z });
  }
  ribbon(trunk, 11, '#4d4a45');
  ribbon(trunk, 1.6, '#c8b060'); // centre line

  // Spurs from the trunk to each town, drawn as a gentle curve so they do not look like rulers.
  for (const s of seeds) {
    const spur = [];
    const startX = s.x;
    const startZ = RUNWAY.z + Math.sin(((s.x + size * 0.44) / (size * 0.88)) * 6.2) * 700;
    for (let t = 0; t <= 1.0001; t += 0.08) {
      const x = startX + (s.x - startX) * 0 + Math.sin(t * Math.PI) * 40;
      const z = startZ + (s.z - startZ) * t;
      spur.push({ x: x + (1 - t) * 0 + (s.x - x) * t, z });
    }
    ribbon(spur, 8, '#57534c');
  }

  return merge(parts);
}

/**
 * Builds the whole inhabited layer and returns a group plus the sites it used, so other systems
 * (air defence placement, for one) can avoid putting a gun in the middle of a town.
 */
export function buildSettlements(terrain) {
  const group = new THREE.Group();
  group.name = 'settlements';
  const heightAt = terrain.heightAt;
  const rng = makeRng(WORLD.seed ^ 0x51e77);

  // Candidate town sites: on the valley floor, off the runway, flat enough to build on. Sampled
  // rather than hand-placed, so the towns sit in the basins the terrain actually has.
  //
  // The spread reaches the map edge because the harbour has to sit near it. The first version
  // sampled only to ±size*0.36 and then asked the harbour for `edge > size*0.36`, a test that no
  // candidate could ever pass — which is why the harbour silently never existed.
  const candidates = [];
  for (let i = 0; i < 420; i += 1) {
    const x = (rng() - 0.5) * WORLD.size * 0.92;
    const z = (rng() - 0.5) * WORLD.size * 0.92;
    const h = heightAt(x, z);
    if (h < 18 || h > 460) continue;
    const { along, lateral } = runwayOffset(x, z);
    if (along < 2600 && lateral < 900) continue;
    const flat = flatness(heightAt, x, z, 120, 120);
    if (flat > 30) continue;
    candidates.push({ x, z, h, flat });
  }
  // The flattest, lowest sites make the towns: that is where people actually build.
  candidates.sort((a, b) => (a.h + a.flat * 4) - (b.h + b.flat * 4));

  const towns = [];
  const taken = [];
  for (const c of candidates) {
    if (towns.length >= 4) break;
    if (taken.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < 900)) continue;
    taken.push(c);
    towns.push(c);
  }

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.86, metalness: 0.02, flatShading: false,
  });

  const sites = [];
  // Every lit window in the valley, already positioned in world space, waiting to be merged into
  // one additive mesh. Filled by `buildTownGeometry` as each town is built.
  const glowParts = [];
  // A parallel record of each town's street frame and chimney tops, which the night layer needs to
  // hang lamps and obstruction lights. The building pass knows where the chimneys are; nothing else
  // does, so it is recorded here rather than re-derived.
  const nightTowns = [];
  // Material per town is shared: one buffer per town keeps a town one draw call while still
  // letting each have its own houses.
  for (let i = 0; i < towns.length; i += 1) {
    const t = towns[i];
    const streetAngle = rng() * Math.PI;
    const houses = planTown(rng, heightAt, t, {
      cols: 4 + (i % 3), rows: 3 + (i % 2), spacing: 34, angle: streetAngle,
    });
    if (!houses.length) continue;
    const geo = buildTownGeometry(houses, { church: houses.length > 12, glow: glowParts });
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `town-${i}`;
    group.add(mesh);
    sites.push({ x: t.x, z: t.z, radius: 190, kind: 'town' });
    nightTowns.push({ x: t.x, z: t.z, h: t.h, streetAngle });
  }

  // The works goes on flat ground with a clear run to the valley floor, offset from the largest
  // town so the two read as a settlement and its industry rather than one sprawl.
  const worksSite = towns[0] ?? candidates[0];
  if (worksSite) {
    let wx = worksSite.x + 620;
    let wz = worksSite.z - 380;
    // If that offset lands on broken ground, walk the offset around the town until something flat
    // enough turns up. The first version tested one position and gave up, which is why the works
    // was frequently absent from the world entirely.
    let found = flatness(heightAt, wx, wz, 200, 90) < 40;
    for (let i = 0; i < 12 && !found; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      wx = worksSite.x + Math.cos(a) * 620;
      wz = worksSite.z + Math.sin(a) * 620;
      found = flatness(heightAt, wx, wz, 200, 90) < 40;
    }
    if (found) {
      const works = buildWorks(heightAt, wx, wz, rng() * Math.PI);
      if (works.geometry) {
        const mesh = new THREE.Mesh(works.geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = 'works';
        group.add(mesh);
        sites.push({ x: wx, z: wz, radius: 150, kind: 'works' });
        // The works' own chimneys, plus a pair of floodlit yard lamps on the shed corners, so the
        // factory is the thing that gives the valley floor away at night.
        nightTowns.push({
          x: wx, z: wz, h: works.y, streetAngle: 0, stacks: works.stacks,
          yard: [[-46, -18], [46, -18], [-46, 18], [46, 18]].map(([lx, lz]) => ({
            x: wx + lx, z: wz + lz, y: works.y,
          })),
        });
      }
    }
  }

  // The harbour: on the coast, which now actually exists.
  //
  // The old version looked for a low flat candidate near the map edge, which worked only because
  // there was no sea at all — it was a warehouse on dry grass with a breakwater running into a
  // meadow. The coast has a known shape now (`coastAt`), so the harbour is placed against it: walk
  // the shoreline, and take the first site that is flat, above the waterline, and has deep water a
  // few hundred metres out. That last test is what makes it a port rather than a beach with cranes.
  let harbour = null;
  {
    let best = null;
    for (let i = 0; i < 120; i += 1) {
      const z = -WORLD.size * 0.40 + (i / 119) * WORLD.size * 0.80;
      const sx = coastAt(z);
      // Inland of the waterline, far enough back for the quay and the sheds.
      for (const back of [150, 220, 300, 380]) {
        const x = sx - back;
        const h = heightAt(x, z);
        if (h < 9 || h > 52) continue;
        if (flatness(heightAt, x, z, 150, 60) > 12) continue;
        // Deep water offshore: the quay has to face something a ship can float in.
        const off = heightAt(sx + 380, z);
        if (off > -6) continue;
        if (taken.some((t) => Math.hypot(t.x - x, t.z - z) < 620)) continue;
        const score = Math.abs(h - 22) + flatness(heightAt, x, z, 150, 60) * 1.5 - off * 0.12;
        if (!best || score < best.score) best = { x, z, h, score, angle: Math.PI * 0.5 };
        break;
      }
    }
    harbour = best;
  }
  if (harbour) {
    const h = buildHarbour(heightAt, harbour.x, harbour.z, harbour.angle);
    if (h.geometry) {
      const mesh = new THREE.Mesh(h.geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'harbour';
      group.add(mesh);
      sites.push({ x: harbour.x, z: harbour.z, radius: 170, kind: 'harbour' });
    }
  }

  const roadGeo = buildRoads(terrain, towns, heightAt);
  if (roadGeo) {
    const roadMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true,
      polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const roads = new THREE.Mesh(roadGeo, roadMat);
    roads.name = 'roads';
    roads.receiveShadow = true;
    group.add(roads);
  }

  // --- The night layer, built last because it needs every town's street frame and the works'
  // chimney heads, which the passes above only now know.
  //
  // Harbour floodlights are appended here rather than in `buildHarbour`, because they are pure light
  // with no geometry behind them: a lamp on the quay is a glowing point on a pole, and the pole is
  // already part of the harbour mesh.
  if (harbour) {
    const y = Math.max(9.4, heightAt(harbour.x, harbour.z));
    const ca = Math.cos(harbour.angle);
    const sa = Math.sin(harbour.angle);
    const yard = [];
    for (let i = 0; i < 6; i += 1) {
      const lx = -58 + i * 24;
      const lz = -4;
      yard.push({ x: harbour.x + lx * ca - lz * sa, y: y + 17, z: harbour.z + lx * sa + lz * ca });
    }
    nightTowns.push({ x: harbour.x, z: harbour.z, h: y, streetAngle: harbour.angle, yard });
  }

  const night = buildNightLights(nightTowns, heightAt);
  // The window glow: already-positioned boxes from the town pass, merged into a single additive
  // mesh. Emptied list is fine — a world with no towns simply has no windows lit.
  if (glowParts.length) {
    const glow = new THREE.Mesh(merge(glowParts), night.warmMat);
    glow.name = 'window-glow';
    glow.renderOrder = 2;
    night.group.add(glow);
  }
  group.add(night.group);

  return { group, sites, towns, night };
}
