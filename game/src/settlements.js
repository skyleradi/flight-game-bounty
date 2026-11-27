// The inhabited layer: fields, roads, villages, a town, farms, a works and a harbour.
//
// The valley the campaign flies through is not wilderness. A fictional alpine region of this size
// has a road along the floor, a patchwork of fields on every shelf flat enough to plough, villages
// strung along that road with their houses fronting it, farmsteads out among the fields, a works
// with stacks visible for twenty kilometres, and — where the land runs out — a coast with a harbour.
// Those are the landmarks a pilot actually navigates by, and their absence is most of why
// procedural terrain reads as an empty heightfield rather than as a place.
//
// Four rules, in order of how much they matter from the air:
//
//  1. **Fields before buildings.** From 300 m up the eye reads the patchwork before it reads the
//     houses: pasture, barley, ploughed tilth, each a different value of green and gold, separated
//     by hedgerows. Perfect towns in an unbroken green valley still look uninhabited.
//  2. **Roads follow the ground.** The trunk road is not a sine wave — it is planned by dynamic
//     programming over a cost field (low ground cheap, water and the runway expensive), so it finds
//     the valley the terrain actually has. Stations are densified to ~13 m so the ribbon lies on
//     the mesh instead of chording through the hills.
//  3. **Houses front the street.** A grid of boxes at a random angle reads as debris however good
//     each box is. Every house here is placed against a specific street edge and rotated to face
//     it, so a row of roofs lines up along a visible ribbon of asphalt.
//  4. **Nothing overlaps.** Every settlement, field and road emits a clearing circle, which the
//     forest builder reads: no tree grows through a roof or in the middle of a barley field.
//
// Everything is deterministic (one seeded RNG) and everything is merged (a whole village's walls are
// one draw call, its lit windows another).

import * as THREE from '../vendor/three.module.min.js';
import { WORLD, RUNWAY, PALETTE } from './config.js';
import { coastAt } from './sea.js';

/** Deterministic RNG, same shape as the other modules', so nothing depends on frame order. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A box whose `y` is its base, rotated by `rot` about Y and then translated into world space. */
function box(w, h, d, x, y, z, rot = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rot) g.rotateY(rot);
  g.translate(x, y + h * 0.5, z);
  return g;
}

/**
 * A pitched roof: a triangular prism.
 *
 * The ridge runs along local +Z. A house fronting a street with its long axis along local +X wants
 * the ridge along the street instead — eaves fronting, the alpine norm — so callers pass
 * `rot + PI/2` and swap width and depth. Gable-fronted houses are the same call with no swap.
 */
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

/**
 * Paints a geometry one flat colour, so a merged mesh can carry many.
 *
 * `stripe`, when given, modulates brightness per vertex along a direction in the geometry's own
 * local frame. This is how a field gets furrows: from 300 m a flat plate of one green is a paper
 * cut-out, and the two things that make it read as worked land are a value difference at the
 * boundary and corduroy inside it. Corduroy is free — it is a per-vertex multiply, no texture, no
 * extra draw call.
 */
function paint(geometry, hex, stripe = null) {
  const c = new THREE.Color(hex);
  const pos = geometry.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    let k = 1;
    if (stripe) {
      // Project onto the stripe axis, then a slow sine: ~7 m pitch, so a 200 m field carries 28
      // bands. At altitude that averages into a directional sheen rather than visible lines, which
      // is exactly what a ploughed field looks like from a cockpit.
      const along = pos.getX(i) * stripe.ax + pos.getZ(i) * stripe.az;
      k = 1 + Math.sin(along * stripe.freq + stripe.phase) * stripe.amp;
    }
    arr[i * 3] = Math.min(1, c.r * k);
    arr[i * 3 + 1] = Math.min(1, c.g * k);
    arr[i * 3 + 2] = Math.min(1, c.b * k);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geometry;
}

/** Merges geometries carrying position/normal/color into one buffer. */
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

/** Height range across a footprint. A building wants a low number; a ridge through it is rejected. */
function flatness(heightAt, x, z, w, d) {
  const hs = [
    heightAt(x - w * 0.5, z - d * 0.5), heightAt(x + w * 0.5, z - d * 0.5),
    heightAt(x - w * 0.5, z + d * 0.5), heightAt(x + w * 0.5, z + d * 0.5),
    heightAt(x, z),
  ];
  return Math.max(...hs) - Math.min(...hs);
}

/** Distance to the runway centreline, used to keep things off the approach. */
function runwayOffset(x, z) {
  const dx = x - RUNWAY.x;
  const dz = z - RUNWAY.z;
  const ux = Math.sin(RUNWAY.heading);
  const uz = -Math.cos(RUNWAY.heading);
  const along = dx * ux + dz * uz;
  const lateral = dx * -uz + dz * ux;
  return { along: Math.abs(along), lateral: Math.abs(lateral) };
}

/**
 * A ground-hugging quad grid: `segs` × `segs` cells laid over a rotated footprint, every vertex
 * lifted onto the heightfield. This is how a field is drawn.
 *
 * The winding matters and is easy to get backwards: with X to the right and Z into the screen, a
 * triangle is front-facing when (b-a)×(c-a) has a positive Y. The pair emitted here is (a,c,b) and
 * (b,c,d), which is the order that yields normals pointing up — the first version used (a,b,c) and
 * the fields rendered black, lit from below.
 */
function drape(heightAt, cx, cz, w, d, angle, lift, segs = 8) {
  const nx = segs;
  const nz = Math.max(2, Math.round(segs * (d / Math.max(1, w))));
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const pos = new Float32Array((nx + 1) * (nz + 1) * 3);
  for (let j = 0; j <= nz; j += 1) {
    for (let i = 0; i <= nx; i += 1) {
      const lx = (i / nx - 0.5) * w;
      const lz = (j / nz - 0.5) * d;
      const x = cx + lx * ca + lz * sa;
      const z = cz - lx * sa + lz * ca;
      const o = (j * (nx + 1) + i) * 3;
      pos[o] = x;
      pos[o + 1] = heightAt(x, z) + lift;
      pos[o + 2] = z;
    }
  }
  const idx = [];
  for (let j = 0; j < nz; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const a = j * (nx + 1) + i;
      const b = a + 1;
      const c = a + nx + 1;
      const dd = c + 1;
      idx.push(a, c, b, b, c, dd);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A ground-hugging ribbon along a polyline: the road, its shoulder, its centre line, and every
 * hedgerow. `lift` is metres above the heightfield, and the offset is computed from the local
 * tangent so a curve does not thicken or pinch.
 */
function drapedStrip(parts, heightAt, points, width, lift, hex) {
  const n = points.length;
  if (n < 2) return;
  const pos = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i += 1) {
    const p = points[i];
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    const nx = -dz;
    const nz = dx;
    const hw = width * 0.5;
    const x1 = p.x + nx * hw; const z1 = p.z + nz * hw;
    const x2 = p.x - nx * hw; const z2 = p.z - nz * hw;
    const o = i * 6;
    pos[o] = x1; pos[o + 1] = heightAt(x1, z1) + lift; pos[o + 2] = z1;
    pos[o + 3] = x2; pos[o + 4] = heightAt(x2, z2) + lift; pos[o + 5] = z2;
  }
  const idx = [];
  for (let i = 0; i < n - 1; i += 1) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  parts.push(paint(g, hex));
}

/** Chaikin corner cutting: turns a DP path's staircase into a road. */
function smoothPolyline(points, rounds = 2) {
  let pts = points;
  for (let r = 0; r < rounds; r += 1) {
    if (pts.length < 3) break;
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i += 1) {
      const a = pts[i];
      const b = pts[i + 1];
      out.push({ x: a.x * 0.75 + b.x * 0.25, z: a.z * 0.75 + b.z * 0.25 });
      out.push({ x: a.x * 0.25 + b.x * 0.75, z: a.z * 0.25 + b.z * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

/** Resamples a polyline at a fixed station spacing, so the ribbon drapes instead of chording. */
function resample(points, step) {
  if (points.length < 2) return points;
  const out = [{ x: points[0].x, z: points[0].z }];
  let carry = 0;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (seg < 1e-6) continue;
    let t = step - carry;
    while (t <= seg) {
      const u = t / seg;
      out.push({ x: a.x + (b.x - a.x) * u, z: a.z + (b.z - a.z) * u });
      t += step;
    }
    carry = (carry + seg) % step;
  }
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.z - tail.z) > step * 0.35) out.push({ x: last.x, z: last.z });
  return out;
}

/**
 * Plans a road across the map by dynamic programming over a cost field.
 *
 * The previous road was `z = runwayZ + sin(t·6.2)·700` — a fixed wave, chosen without ever asking
 * the terrain where the valley was. It therefore climbed ridges, crossed the gorge at a random
 * place, and either floated or was buried depending on the station. A road is the one thing in a
 * landscape that *must* follow the land, because that is why it exists.
 *
 * The DP walks columns of X and picks, for each column, the Z that minimises
 *
 *     height + lateralStepPenalty·|Δrow| + landUsePenalty
 *
 * carried forward from the previous column. `landUsePenalty` makes water and the runway
 * prohibitively expensive, so the cheapest path is a valley road by construction. The smoothing
 * penalty is what stops it from chasing every 2 m bump sideways into a zigzag.
 */
function planRoadPath(costAt, x0, x1, zMin, zMax) {
  const STEP_X = 46;
  const STEP_Z = 26;
  const nx = Math.max(1, Math.round((x1 - x0) / STEP_X));
  const nz = Math.max(1, Math.round((zMax - zMin) / STEP_Z));
  const grid = new Float64Array((nx + 1) * (nz + 1));
  for (let i = 0; i <= nx; i += 1) {
    for (let j = 0; j <= nz; j += 1) {
      grid[i * (nz + 1) + j] = costAt(x0 + i * STEP_X, zMin + j * STEP_Z);
    }
  }
  const SMOOTH = 26;
  const REACH = 4;
  let prev = new Float64Array(nz + 1);
  for (let j = 0; j <= nz; j += 1) prev[j] = grid[j];
  const back = [];
  for (let i = 1; i <= nx; i += 1) {
    const cur = new Float64Array(nz + 1).fill(Infinity);
    const b = new Int16Array(nz + 1);
    const base = i * (nz + 1);
    for (let j = 0; j <= nz; j += 1) {
      const here = grid[base + j];
      for (let k = -REACH; k <= REACH; k += 1) {
        const p = j + k;
        if (p < 0 || p > nz) continue;
        const cost = prev[p] + here + Math.abs(k) * SMOOTH;
        if (cost < cur[j]) { cur[j] = cost; b[j] = p; }
      }
    }
    back.push(b);
    prev = cur;
  }
  let bj = 0;
  for (let j = 1; j <= nz; j += 1) if (prev[j] < prev[bj]) bj = j;
  const out = new Array(nx + 1);
  for (let i = nx; i >= 0; i -= 1) {
    out[i] = { x: x0 + i * STEP_X, z: zMin + bj * STEP_Z };
    if (i > 0) bj = back[i - 1][bj];
  }
  return out;
}

/** Wall colours: rendered plaster, timber, brick, slate. */
const WALLS = ['#d3c7b2', '#c0b19c', '#dbcfb8', '#b0a28c', '#c7b69b', '#a49a8a', '#e0d7c4', '#b99f86'];
/** Roof tiles: terracotta through slate, the two things an alpine roof is made of. */
const ROOFS = ['#8c4a3a', '#96543f', '#a05a44', '#5f554b', '#6d6055', '#4f4a44', '#7a4a38'];
/** Crop colours. What makes a valley read as farmland is the *variation*, not any one green. */
const CROPS = [
  '#6f8a3e', '#5d7a35', '#8ba24a', '#9aa855', '#7d9448',
  '#b9a356', '#c9b46b', '#a89464', '#8a7452', '#7a6547',
  '#4e6b33', '#67873f',
];
/** Hedgerow green: darker than any crop, which is what makes the boundaries read as lines. */
const HEDGE = ['#33472a', '#2c3f26', '#3a5030'];
/** Lit-window colours: mostly tungsten, a few fluorescent, one television blue. */
const LAMPS = ['#ffd89a', '#ffcf82', '#ffe8bc', '#d6ecff', '#b9d8ff', '#ffc26e'];

/* ------------------------------------------------------------------------------------------- */
/* Planning                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/**
 * Places houses along a street, both sides, each rotated to front it.
 *
 * `rot` is chosen so the house's local +X runs along the street and its local +Z runs along the
 * street's left normal; the facade that faces the street is therefore the one at local -side·d/2.
 * Everything downstream — the window band, the door — reads `side` to know which wall that is.
 */
function planStreetHouses(heightAt, street, rng, opts = {}) {
  const {
    spacing = 27, setback = 8, max = 42, sides = [1, -1], gapChance = 0.17, storeys2 = 0.16,
  } = opts;
  const houses = [];
  const { x, z, dx, dz, len, halfWidth } = street;
  const rot = Math.atan2(-dz, dx);
  const nx = -dz;
  const nz = dx;
  const slots = Math.max(1, Math.floor(len / spacing));
  for (const side of sides) {
    for (let i = 0; i <= slots; i += 1) {
      if (houses.length >= max) break;
      // A gap every few plots: a garden, a yard, a lane through to the back. A perfectly continuous
      // terrace is as wrong as a scatter — real villages breathe.
      if (rng() < gapChance) continue;
      const along = (i - slots / 2) * spacing + (rng() - 0.5) * 4.5;
      const w = 8.5 + rng() * 6.5;
      const d = 7 + rng() * 4.5;
      const off = side * (halfWidth + setback + d * 0.5 + rng() * 2.4);
      const px = x + dx * along + nx * off;
      const pz = z + dz * along + nz * off;
      if (flatness(heightAt, px, pz, w, d) > 3.4) continue;
      const { along: rAlong, lateral: rLateral } = runwayOffset(px, pz);
      if (rAlong < 1500 && rLateral < 200) continue;
      houses.push({
        x: px, z: pz, w, d,
        y: heightAt(px, pz),
        rot,
        side: Math.sign(off),
        storeys: rng() < storeys2 ? 2 : 1,
        wall: WALLS[Math.floor(rng() * WALLS.length)],
        roof: ROOFS[Math.floor(rng() * ROOFS.length)],
        pitch: 2.8 + rng() * 2.0,
        // Eaves fronting the street is the alpine norm; a barn or two is gable-fronted for variety.
        gable: rng() < 0.18,
        lit: rng() < 0.76,
        warm: [LAMPS[Math.floor(rng() * LAMPS.length)],
          rng() < 0.24 ? null : LAMPS[Math.floor(rng() * LAMPS.length)],
          rng() < 0.42 ? null : LAMPS[Math.floor(rng() * LAMPS.length)]],
      });
    }
  }
  return houses;
}

/** Builds one house: plinth, body, roof, chimney, window band, door. */
function buildHouse(parts, glow, h) {
  const storeyH = 3.15;
  const bodyH = storeyH * h.storeys;
  const ca = Math.cos(h.rot);
  const sa = Math.sin(h.rot);
  // Local → world for a point in this house's own frame. `box`/`roof` rotate before translating, so
  // this must use the same convention: (lx,lz) → (lx·cos + lz·sin, -lx·sin + lz·cos).
  const at = (lx, lz) => ({ x: h.x + lx * ca + lz * sa, z: h.z - lx * sa + lz * ca });

  parts.push(paint(box(h.w + 0.5, 0.8, h.d + 0.5, h.x, h.y - 0.45, h.z, h.rot), '#75706a'));
  parts.push(paint(box(h.w, bodyH, h.d, h.x, h.y, h.z, h.rot), h.wall));

  // Roof. `roof()` puts its ridge along local +Z, so an eaves-fronting house (ridge along the
  // street, i.e. along local +X) is the same call rotated a quarter turn with width and depth
  // swapped. Gable-fronted is the unswapped call.
  if (h.gable) {
    parts.push(paint(roof(h.w + 1.1, h.pitch, h.d + 1.1, h.x, h.y + bodyH, h.z, h.rot), h.roof));
  } else {
    parts.push(paint(roof(h.d + 1.1, h.pitch, h.w + 1.1, h.x, h.y + bodyH, h.z, h.rot + Math.PI * 0.5), h.roof));
  }

  // Chimney, on the ridge, offset along the house. This is the detail that gives a village roofline
  // its silhouette — a row of plain prisms reads as tents.
  {
    const lx = (h.gable ? 0 : (h.w * 0.28)) * (h.w > 12 ? 1 : 0.6);
    const p = at(lx, 0);
    const top = h.y + bodyH + h.pitch * 0.55;
    parts.push(paint(box(1.05, h.pitch * 1.15, 1.05, p.x, top, p.z, h.rot), '#8e8579'));
    parts.push(paint(box(1.3, 0.35, 1.3, p.x, top + h.pitch * 1.15, p.z, h.rot), '#5d564e'));
  }

  // Window band per storey on the street-facing facade only: the back of a house is not lit and
  // nobody sees it from the air.
  const frontZ = -h.side * (h.d * 0.5 + 0.16);
  for (let s = 0; s < h.storeys; s += 1) {
    const y = h.y + s * storeyH + 1.55;
    const p = at(0, frontZ);
    parts.push(paint(box(h.w * 0.84, 1.1, 0.2, p.x, y, p.z, h.rot), '#33383e'));
    // Lit plates, proud of the wall by 14 cm so the depth test cannot eat them at range. They are
    // built into a separate list because they go through an additive, unlit material at night.
    if (glow && h.lit) {
      const n = h.w > 12 ? 3 : 2;
      const pitch = (h.w * 0.68) / n;
      for (let k = 0; k < n; k += 1) {
        const warm = h.warm[(k + s) % h.warm.length];
        if (!warm) continue;
        const lx = (k - (n - 1) / 2) * pitch;
        const q = at(lx, frontZ - h.side * 0.22);
        glow.push(paint(box(1.9, 1.15, 0.16, q.x, y, q.z, h.rot), warm));
      }
    }
  }

  // Door, on the ground floor, toward one end of the frontage.
  {
    const p = at(-h.w * 0.28, frontZ - h.side * 0.14);
    parts.push(paint(box(1.15, 2.15, 0.18, p.x, h.y + 0.8, p.z, h.rot), '#4a3b2c'));
  }
}

/** A church: nave, pitched roof, and a tower whose spire is the landmark seen from 3 km out. */
function buildChurch(parts, h) {
  const naveW = 13;
  const naveD = 25;
  const naveH = 9.5;
  parts.push(paint(box(naveW, naveH, naveD, h.x, h.y, h.z, h.rot), '#e3ddcf'));
  parts.push(paint(roof(naveW + 1.2, 5.2, naveD + 1.2, h.x, h.y + naveH, h.z, h.rot + Math.PI * 0.5), '#55504a'));
  const tx = h.x + Math.cos(h.rot) * (naveD * 0.5 + 3.4);
  const tz = h.z - Math.sin(h.rot) * (naveD * 0.5 + 3.4);
  parts.push(paint(box(6.4, 23, 6.4, tx, h.y, tz, h.rot), '#ebe5d8'));
  parts.push(paint(box(7.2, 1.1, 7.2, tx, h.y + 23, tz, h.rot), '#55504a'));
  const spire = new THREE.ConeGeometry(4.6, 13, 4);
  spire.rotateY(h.rot + Math.PI * 0.25);
  spire.translate(tx, h.y + 29.9, tz);
  parts.push(paint(spire, '#4a453f'));
  return { x: tx, y: h.y + 23, z: tz };
}

/** A farmstead: farmhouse, barn, silo, and a dirt yard between them. */
function planFarm(heightAt, x, z, angle) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const at = (lx, lz) => ({ x: x + lx * ca + lz * sa, z: z - lx * sa + lz * ca });
  const out = [];
  const spots = [
    { lx: 0, lz: 0, w: 13, d: 10, kind: 'house' },
    { lx: 24, lz: 6, w: 22, d: 12, kind: 'barn' },
    { lx: 24, lz: -14, w: 6.5, d: 6.5, kind: 'silo' },
  ];
  for (const s of spots) {
    const p = at(s.lx, s.lz);
    if (flatness(heightAt, p.x, p.z, s.w, s.d) > 3.0) continue;
    out.push({ ...s, x: p.x, z: p.z, y: heightAt(p.x, p.z), rot: angle, kind: s.kind });
  }
  return out;
}

/* ------------------------------------------------------------------------------------------- */
/* Builders                                                                                     */
/* ------------------------------------------------------------------------------------------- */

/** Road geometry: shoulder, asphalt, centre line. Three ribbons, one merged mesh. */
function buildRoads(heightAt, routes) {
  const parts = [];
  for (const route of routes) {
    const pts = route.points;
    if (pts.length < 2) continue;
    if (route.kind === 'track') {
      drapedStrip(parts, heightAt, pts, 4.4, 0.55, '#7d7261');
      continue;
    }
    drapedStrip(parts, heightAt, pts, route.width + 5.5, 0.45, '#6d6659');
    drapedStrip(parts, heightAt, pts, route.width, 0.7, '#3f3d3a');
    drapedStrip(parts, heightAt, pts, 0.9, 0.92, '#c8b060');
  }
  return merge(parts);
}

/**
 * Field geometry: one draped plate per plot plus a hedgerow along its boundary.
 *
 * The hedgerow is drawn as four draped strips rather than a ring of boxes. A ring of boxes at 5 m
 * spacing over 200 fields is 24 000 boxes and a quarter of a million vertices to say what 4 000
 * quads say better.
 */
function buildFields(heightAt, fields) {
  const parts = [];
  for (const f of fields) {
    // The lift is 0.9 m, not the 0.34 m of the first attempt, and that number is the whole reason
    // the fields were invisible. The terrain mesh is a triangulation with a 11.7 m quad; between two
    // of its vertices the drawn surface is a flat interpolation that can sit *above* `heightAt` at
    // the sample point. A plate lifted 34 cm therefore sinks under the triangles it is draped on and
    // never appears — the roads survived the same bug only because their lift was 70 cm. Anything
    // draped here needs more clearance than half the local relief of a terrain quad.
    const g = drape(heightAt, f.x, f.z, f.w, f.d, f.angle, 0.9, 9);
    // Furrows: a sine along the plot's own long axis, ±6% brightness. Cheap, and it is the whole
    // difference between a coloured rectangle and a worked field.
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    parts.push(paint(g, f.crop, {
      ax: ca, az: -sa, freq: 0.9, phase: f.angle * 3.1, amp: 0.06,
    }));
    if (!f.hedged) continue;
    const hw = f.w * 0.5;
    const hd = f.d * 0.5;
    const local = (lx, lz) => ({ x: f.x + lx * ca + lz * sa, z: f.z - lx * sa + lz * ca });
    const edges = [
      [local(-hw, -hd), local(hw, -hd)],
      [local(-hw, hd), local(hw, hd)],
      [local(-hw, -hd), local(-hw, hd)],
      [local(hw, -hd), local(hw, hd)],
    ];
    const hedge = HEDGE[f.hedgeIdx % HEDGE.length];
    for (const [a, b] of edges) {
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (seg < 20) continue;
      const n = Math.max(2, Math.round(seg / 26));
      const line = [];
      for (let i = 0; i <= n; i += 1) {
        const t = i / n;
        line.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
      drapedStrip(parts, heightAt, line, 2.4, 1.35, hedge);
    }
  }
  return merge(parts);
}

/** All the static buildings: every house, barn, silo and church, merged into one mesh. */
function buildStructures(houses, farms, churches) {
  const parts = [];
  const glow = [];
  for (const h of houses) buildHouse(parts, glow, h);
  for (const f of farms) {
    if (f.kind === 'silo') {
      const cyl = new THREE.CylinderGeometry(f.w * 0.5, f.w * 0.5, 14, 12);
      cyl.translate(f.x, f.y + 7, f.z);
      parts.push(paint(cyl, '#b8b2a6'));
      const cap = new THREE.SphereGeometry(f.w * 0.5, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.5);
      cap.translate(f.x, f.y + 14, f.z);
      parts.push(paint(cap, '#8e897e'));
      continue;
    }
    const bodyH = f.kind === 'barn' ? 8.5 : 6.4;
    parts.push(paint(box(f.w, bodyH, f.d, f.x, f.y, f.z, f.rot), f.kind === 'barn' ? '#8e5f47' : '#cfc3ad'));
    parts.push(paint(roof(f.d + 1.0, 3.4, f.w + 1.0, f.x, f.y + bodyH, f.z, f.rot + Math.PI * 0.5), f.kind === 'barn' ? '#4d4640' : '#7a4636'));
    // Barn door: a big dark rectangle, which is what says "barn" rather than "shed".
    if (f.kind === 'barn') {
      const ca = Math.cos(f.rot); const sa = Math.sin(f.rot);
      const p = { x: f.x + (-f.d * 0.5 - 0.12) * sa, z: f.z + (-f.d * 0.5 - 0.12) * ca };
      parts.push(paint(box(f.w * 0.55, 6.0, 0.2, p.x, f.y, p.z, f.rot), '#3a2f26'));
    }
  }
  for (const c of churches) buildChurch(parts, c);
  return { geometry: merge(parts), glow };
}

/**
 * The works: sawtooth shed, two stacks, cooling towers, tank farm, pipe rack.
 * Placed on the flattest ground within reach of the town, because a 60 m chimney is the thing a
 * pilot uses to fix position from 20 km out.
 */
function buildWorks(heightAt, x, z, angle) {
  const parts = [];
  const y = heightAt(x, z);
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const at = (lx, lz) => ({ x: x + lx * ca + lz * sa, z: z - lx * sa + lz * ca });

  const shed = at(0, 0);
  parts.push(paint(box(92, 13, 34, shed.x, y, shed.z, angle), '#8b8579'));
  for (let i = 0; i < 7; i += 1) {
    const p = at(-39 + i * 13, 0);
    parts.push(paint(roof(13.4, 3.6, 35, p.x, y + 13, p.z, angle + Math.PI * 0.5), '#6a645b'));
  }
  const stacks = [];
  for (const [lx, lz, h] of [[46, -12, 62], [46, 6, 48]]) {
    const p = at(lx, lz);
    const stack = new THREE.CylinderGeometry(3.1, 4.3, h, 12);
    stack.translate(p.x, y + h * 0.5, p.z);
    parts.push(paint(stack, '#beb5a7'));
    const band = new THREE.CylinderGeometry(3.3, 3.3, 3.2, 12);
    band.translate(p.x, y + h - 8, p.z);
    parts.push(paint(band, '#8c4a3a'));
    stacks.push({ x: p.x, y: y + h, z: p.z });
  }
  for (const lx of [-46, -78]) {
    const p = at(lx, 18);
    const base = new THREE.CylinderGeometry(9.5, 13.5, 30, 14);
    base.translate(p.x, y + 15, p.z);
    parts.push(paint(base, '#aaa49c'));
    const lip = new THREE.CylinderGeometry(11.2, 9.5, 4, 14);
    lip.translate(p.x, y + 32, p.z);
    parts.push(paint(lip, '#b6b0a8'));
  }
  for (let i = 0; i < 5; i += 1) {
    const p = at(20 + i * 12, 30);
    const tank = new THREE.CylinderGeometry(5.2, 5.2, 9, 12);
    tank.translate(p.x, y + 4.5, p.z);
    parts.push(paint(tank, '#c3bcae'));
  }
  const rack = at(0, 26);
  parts.push(paint(box(78, 1.0, 2.2, rack.x, y + 8, rack.z, angle), '#7d766a'));
  for (let i = 0; i < 9; i += 1) {
    const p = at(-36 + i * 9, 26);
    parts.push(paint(box(0.8, 8, 0.8, p.x, y, p.z, angle), '#7d766a'));
  }
  return { geometry: merge(parts), x, z, y, stacks };
}

/**
 * The harbour: quay, breakwater, portal cranes, transit sheds.
 *
 * The frame is the quay's, not the world's: local +z points out to sea, local x runs along the
 * waterline. Everything that belongs on land — apron, sheds, the container stacks — sits at
 * negative local z; the cranes stand on the seaward edge with their booms reaching over the water.
 * The first build had this inverted, so the transit sheds were built into the sea and the quay
 * itself stood four hundred metres inland on dry grass.
 */
function buildHarbour(heightAt, x, z, angle, seaLevel = 6) {
  const parts = [];
  // Deck level: a working quay stands six metres above high water, so the wall reads as a wall
  // rather than a kerb from the air.
  const deck = seaLevel + 6;
  // The wall runs from well below the sea bed up to the deck, so no daylight shows under it where
  // the sea plane cuts the terrain.
  const foot = -14;
  const wallH = deck - foot;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const at = (lx, lz) => ({ x: x + lx * ca + lz * sa, z: z - lx * sa + lz * ca });

  const q = at(0, 0);
  // The quay wall: long in local x, and deep enough to be a wall and not a ribbon. Its centre sits
  // on the waterline, so half the deck stands on land and half cantilevers over the water where
  // ships berth.
  parts.push(paint(box(210, wallH, 26, q.x, foot + wallH / 2, q.z, angle), '#9c9890'));
  // A darker fender course along the seaward face, at the waterline: without it the wall is one
  // flat grey slab and the eye cannot find where the water meets it.
  const face = at(0, 14);
  parts.push(paint(box(210, 3.2, 1.6, face.x, seaLevel + 0.6, face.z, angle), '#6b6862'));
  // Coping stone along the quay edge.
  parts.push(paint(box(212, 0.8, 2.4, face.x, deck + 0.4, face.z, angle), '#b6b1a7'));
  // Apron: the paved yard behind the quay. Landward, so the sheds stand on concrete, not on the
  // water they are meant to serve.
  const apron = at(0, -46);
  parts.push(paint(drape(heightAt, apron.x, apron.z, 210, 66, angle, 0.5, 8), '#8d8a83'));
  // Breakwater: a rubble mole running out from the north end of the quay, curving across the
  // basin mouth so the water behind it reads as enclosed harbour rather than open sea.
  for (let i = 0; i < 30; i += 1) {
    const out = 26 + i * 11;
    const p = at(100 + i * 3.2, out);
    const hh = 7.4 - i * 0.19;
    if (hh < 1.4) break;
    parts.push(paint(box(20, hh, 15, p.x, seaLevel - 2.2 + hh / 2, p.z, angle + 0.06 * Math.sin(i * 0.7)), '#8e887d'));
  }
  // Container stacks on the apron.
  for (let i = 0; i < 26; i += 1) {
    const p = at(-100 + i * 7.6, -30 - (i % 3) * 10);
    const hh = 2.4 + (i % 3) * 0.9;
    parts.push(paint(box(7, hh, 6.4, p.x, deck + hh / 2, p.z, angle + 0.06 * Math.sin(i)), '#827e77'));
  }
  // Portal cranes on the quay edge, booms out over the berth.
  for (let i = 0; i < 4; i += 1) {
    const p = at(-78 + i * 32, 2);
    const legY = deck;
    parts.push(paint(box(1.8, 19, 1.8, p.x - 5, legY + 9.5, p.z, angle), '#cc8b2c'));
    parts.push(paint(box(1.8, 19, 1.8, p.x + 5, legY + 9.5, p.z, angle), '#cc8b2c'));
    parts.push(paint(box(13, 1.8, 2.2, p.x, legY + 19, p.z, angle), '#cc8b2c'));
    // The boom is a cantilever seaward from the legs — 40 m of it, so it reaches out over a hull
    // lying alongside instead of hanging over the containers.
    const boom = at(-78 + i * 32, 2 + 20);
    parts.push(paint(box(2.4, 1.6, 40, boom.x, legY + 20, boom.z, angle), '#dc9c3e'));
    parts.push(paint(box(1.4, 11, 1.4, boom.x, legY + 14, boom.z, angle), '#8f8a80'));
    // Machine house on the landward side, so the crane is not a bare frame.
    const house = at(-78 + i * 32, -4);
    parts.push(paint(box(9, 5, 6, house.x, legY + 4, house.z, angle), '#b8862c'));
  }
  // Transit sheds, well back from the quay edge.
  for (let i = 0; i < 3; i += 1) {
    const p = at(-76 + i * 56, -58);
    parts.push(paint(box(46, 10, 24, p.x, deck + 5, p.z, angle), '#b3ada3'));
    parts.push(paint(roof(47, 3.6, 25, p.x, deck + 11.6, p.z, angle), '#6f6a62'));
  }
  return { geometry: merge(parts), x, z, y: deck };
}

/**
 * The night layer: window glow, street lamps, yard floods, chimney obstruction lights.
 *
 * All `MeshBasicMaterial`: a window at 2 a.m. is lit by a bulb inside it, not by the moon. Opacity
 * is driven by the day cycle, so the same geometry is invisible at noon and burning at midnight
 * with nothing rebuilt.
 */
function buildNightLights(streets, heightAt, yardLights, stacks) {
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

  // --- Street lamps: pairs down each street, on a 44 m pitch, set on the kerb.
  const postParts = [];
  const headParts = [];
  for (const s of streets) {
    const n = Math.max(2, Math.floor(s.len / 44));
    const nx = -s.dz;
    const nz = s.dx;
    for (let i = 0; i <= n; i += 1) {
      const along = (i - n / 2) * 44;
      for (const side of [-1, 1]) {
        const off = side * (s.halfWidth + 2.2);
        const x = s.x + s.dx * along + nx * off;
        const z = s.z + s.dz * along + nz * off;
        const y = heightAt(x, z);
        if (y < 12) continue;
        postParts.push(paint(box(0.42, 7.4, 0.42, x, y + 3.7, z, 0), '#55524d'));
        headParts.push(paint(box(1.5, 0.44, 1.5, x, y + 7.5, z, 0), '#ffe0a8'));
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

  // --- Yard and quay floodlights.
  const yardParts = [];
  for (const p of yardLights) yardParts.push(paint(box(3.4, 3.4, 3.4, p.x, p.y, p.z, 0), '#ffe4b0'));
  if (yardParts.length) {
    const yard = new THREE.Mesh(merge(yardParts), lampMat);
    yard.name = 'yard-lights';
    group.add(yard);
  }

  // --- Chimney obstruction lamps, pulsed in `setNight`.
  const redParts = [];
  for (const s of stacks) redParts.push(paint(box(2.4, 2.4, 2.4, s.x, s.y + 1.0, s.z, 0), '#ff4030'));
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
    setNight(level, time = 0) {
      const dark = 1 - clamp01(level);
      const lit = clamp01((dark - 0.35) / 0.5);
      const lampLit = clamp01((dark - 0.18) / 0.34);
      warmMat.opacity = lit * 0.95;
      lampMat.opacity = lampLit;
      redMat.opacity = lampLit * (0.55 + 0.45 * Math.sin(time * 2.1));
      group.visible = dark > 0.16;
    },
  };
}

/* ------------------------------------------------------------------------------------------- */
/* Assemble                                                                                     */
/* ------------------------------------------------------------------------------------------- */

export function buildSettlements(terrain) {
  const group = new THREE.Group();
  group.name = 'settlements';
  const heightAt = terrain.heightAt;
  const rng = makeRng(WORLD.seed ^ 0x51e77);
  const size = WORLD.size;

  const sites = [];
  const clearings = [];

  /**
   * Road cost field. Low ground is cheap; water, the runway and the gorge floor are not. This is
   * what turns "draw a line across the map" into "find the valley".
   */
  const costAt = (x, z) => {
    const y = heightAt(x, z);
    let cost = y < 0 ? 9000 : y;
    if (y < 16) cost += 6000;                       // never route through the sea or a lake
    if (Math.abs(x) > size * 0.47 || Math.abs(z) > size * 0.47) cost += 4000;
    const { along, lateral } = runwayOffset(x, z);
    if (along < RUNWAY.length * 0.5 + 260 && lateral < 190) cost += 5000;
    return cost;
  };

  // --- The harbour site is needed before the roads, because a branch road has to reach it.
  let harbour = null;
  {
    let best = null;
    for (let i = 0; i < 140; i += 1) {
      const z = -size * 0.42 + (i / 139) * size * 0.84;
      const sx = coastAt(z);
      for (const back of [165, 235, 310, 390]) {
        const x = sx - back;
        const h = heightAt(x, z);
        if (h < 10 || h > 56) continue;
        if (flatness(heightAt, x, z, 170, 70) > 12) continue;
        if (heightAt(sx + 400, z) > -6) continue;
        if (runwayOffset(x, z).along < 700 && runwayOffset(x, z).lateral < 700) continue;
        const score = Math.abs(h - 22) + flatness(heightAt, x, z, 170, 70) * 1.6 - heightAt(sx + 400, z) * 0.1;
        if (!best || score < best.score) best = { x, z, h, score, angle: Math.PI * 0.5 };
        break;
      }
    }
    harbour = best;
  }

  // Snap the quay to the waterline.
  //
  // The candidate scan above only guarantees *flat ground near* the coast; where the shelf is
  // gentle — and here it is, a kilometre of coastal plain — "near" can still be 400 m inland. The
  // first build put the quay, cranes and transit sheds on dry grass and the port read as a
  // warehouse yard in a field, with the sea a faint blue line at the horizon. So the candidate is
  // only a starting point: march seaward (+X, the direction the heightfield falls) until the
  // ground drops under the *sea surface* — not under zero: the sea plane sits at y = 6, so a
  // zero threshold puts the deck five metres out into open water — and stand the quay back from
  // the crossing by half its own width.
  const SEA_LEVEL = 6;
  if (harbour) {
    let waterline = null;
    for (let x = harbour.x; x < harbour.x + 1600; x += 4) {
      if (heightAt(x, harbour.z) < SEA_LEVEL - 0.4) { waterline = x; break; }
    }
    if (waterline !== null && waterline > harbour.x) {
      // The quay deck is 20 m across in local z; its seaward face should just meet the water.
      harbour.x = waterline - 13;
      harbour.h = heightAt(harbour.x, harbour.z);
      harbour.score = 0;
    }
  }

  // --- Trunk road: west side of the valley to the coast, following low ground.
  const roadRoutes = [];
  let trunk = [];
  {
    const x0 = -size * 0.44;
    const x1 = size * 0.26;
    const raw = planRoadPath(costAt, x0, x1, -size * 0.42, size * 0.42);
    trunk = resample(smoothPolyline(raw, 3), 14);
    // Sink non-finite heights out of the ribbon before it is built.
    trunk = trunk.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
    roadRoutes.push({ kind: 'trunk', points: trunk, width: 11 });
  }
  /** Nearest point on the trunk, plus the tangent there. Used to hang villages off the road. */
  const nearTrunk = (t) => {
    const i = Math.max(1, Math.min(trunk.length - 2, Math.round(t * (trunk.length - 1))));
    const a = trunk[i - 1];
    const b = trunk[i + 1];
    let dx = b.x - a.x;
    let dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    return { x: trunk[i].x, z: trunk[i].z, dx, dz, i };
  };

  // --- Branch road to the harbour, so the port is connected to the valley rather than dropped on
  // the coast. Routed from the trunk's eastern end.
  if (harbour) {
    const start = trunk[trunk.length - 1];
    const raw = planRoadPath(
      (x, z) => (Math.abs(x - harbour.x) < 240 && Math.abs(z - harbour.z) < 240 ? -400 : costAt(x, z)),
      Math.min(start.x, harbour.x - 200), harbour.x,
      Math.min(harbour.z, start.z) - 300,
      Math.max(harbour.z, start.z) + 300,
    );
    const branch = resample(smoothPolyline(raw, 3), 14);
    roadRoutes.push({ kind: 'branch', points: branch, width: 8.5 });
  }

  // --- Villages and the town, hung along the trunk where the ground is flat.
  const streets = [];
  const houses = [];
  const churches = [];
  const towns = [];
  const villages = [];

  const usedSpan = [];
  const spanFree = (t, half) => usedSpan.every((u) => Math.abs(u - t) > half);

  // The towns go first, on the flattest stretches of trunk, so they get the best ground. Two of
  // them: one town in a valley this size reads as an isolated hamlet, and the night shot wants a
  // second cluster of lights in the middle distance. The second is smaller — a market town to the
  // first's county town.
  for (let townIndex = 0; townIndex < 2; townIndex += 1) {
  const scale = townIndex === 0 ? 1 : 0.7;
  let townT = null;
  {
    let bestScore = Infinity;
    for (let k = 0; k < 40; k += 1) {
      const t = 0.16 + (k / 39) * 0.68;
      if (!spanFree(t, 0.10)) continue;
      const p = nearTrunk(t);
      if (flatness(heightAt, p.x, p.z, 300, 300) > 26) continue;
      const { along, lateral } = runwayOffset(p.x, p.z);
      if (along < 2200 && lateral < 800) continue;
      const h = heightAt(p.x, p.z);
      if (h < 20 || h > 300) continue;
      const score = flatness(heightAt, p.x, p.z, 300, 300) + Math.abs(h - 90) * 0.12;
      if (score < bestScore) { bestScore = score; townT = t; }
    }
  }

  if (townT !== null) {
    const p = nearTrunk(townT);
    usedSpan.push(townT);
    const mainAngle = Math.atan2(p.dz, p.dx);
    const mainLen = 420 * scale;
    const mainHalf = 9;
    const main = { x: p.x, z: p.z, dx: p.dx, dz: p.dz, len: mainLen, halfWidth: mainHalf };
    /**
     * Registers a street: it gets a row of houses fronting it and a ribbon of asphalt under it.
     *
     * Both, always — a lane that exists only in the house placement is invisible from the air (the
     * roofs line up along nothing), and a ribbon with no houses is a road to nowhere. Keeping the
     * two together is why this is one function instead of two calls at every site.
     */
    const addStreet = (st, opts) => {
      streets.push(st);
      houses.push(...planStreetHouses(heightAt, st, rng, opts));
      // The main street is already the trunk road: drawing a second ribbon on top of it would
      // z-fight, so only the side streets get their own asphalt.
      if (st !== main) {
        const pts = [];
        const half = st.len * 0.5;
        for (let t = -half; t <= half + 0.01; t += 12) {
          pts.push({ x: st.x + st.dx * t, z: st.z + st.dz * t });
        }
        roadRoutes.push({ kind: 'street', points: pts, width: st.halfWidth * 2 });
      }
    };
    addStreet(main, { spacing: 26, setback: 8, max: 30, gapChance: 0.12, storeys2: 0.34 });

    // Back lanes. A town strung along one road is a ribbon, not a town: from the air it reads as a
    // single line of roofs and there is nothing behind it. Two lanes set 92 m either side of the
    // main street, each with its own frontage, give the settlement a second and third rank of roofs
    // — which is what makes it read as a place with a depth rather than a queue.
    const px = -p.dz;
    const pz = p.dx;
    for (const laneOff of [-92, 92]) {
      const lx = p.x + px * laneOff;
      const lz = p.z + pz * laneOff;
      if (flatness(heightAt, lx, lz, 260, 90) > 22) continue;
      const lane = { x: lx, z: lz, dx: p.dx, dz: p.dz, len: mainLen * 0.78, halfWidth: 5.2 };
      addStreet(lane, { spacing: 27, setback: 7, max: 17, gapChance: 0.24, storeys2: 0.14 });
    }

    // Two cross streets, perpendicular, 150 m either side of the main street's middle.
    for (const off of [-155 * scale, 155 * scale]) {
      const cx = p.x + p.dx * off;
      const cz = p.z + p.dz * off;
      if (flatness(heightAt, cx, cz, 150, 60) > 16) continue;
      const cross = { x: cx, z: cz, dx: px, dz: pz, len: 190 * scale, halfWidth: 7 };
      addStreet(cross, { spacing: 25, setback: 7, max: 14, gapChance: 0.2, storeys2: 0.12 });
    }

    // The church stands at the main street's head, which is where one actually stands.
    const chX = p.x - p.dx * (mainLen * 0.5 - 30);
    const chZ = p.z - p.dz * (mainLen * 0.5 - 30);
    if (flatness(heightAt, chX, chZ, 26, 40) < 5) {
      churches.push({ x: chX, z: chZ, y: heightAt(chX, chZ), rot: Math.atan2(-p.dx, -p.dz) });
    }
    towns.push({
      x: p.x, z: p.z, h: heightAt(p.x, p.z),
      streetAngle: Math.atan2(-p.dz, p.dx), houses: houses.length,
    });
    sites.push({ x: p.x, z: p.z, radius: 300 * scale, kind: 'town' });
    clearings.push({ x: p.x, z: p.z, r: 330 * scale });
  }
  }

  // Villages: shorter single-street settlements, spread along the trunk.
  {
    const wanted = 6;
    let made = 0;
    for (let k = 0; k < 60 && made < wanted; k += 1) {
      const t = 0.06 + ((k * 0.6180339887) % 1) * 0.86;
      if (!spanFree(t, 0.055)) continue;
      const p = nearTrunk(t);
      if (flatness(heightAt, p.x, p.z, 140, 140) > 20) continue;
      const { along, lateral } = runwayOffset(p.x, p.z);
      if (along < 1800 && lateral < 650) continue;
      const h = heightAt(p.x, p.z);
      if (h < 20 || h > 340) continue;
      if (Math.hypot(p.x - harbour?.x ?? 0, p.z - harbour?.z ?? 0) < 520) continue;
      usedSpan.push(t);
      const street = { x: p.x, z: p.z, dx: p.dx, dz: p.dz, len: 165 + rng() * 95, halfWidth: 6.5 };
      streets.push(street);
      const hs = planStreetHouses(heightAt, street, rng, {
        spacing: 25, setback: 7.5, max: 20, gapChance: 0.2, storeys2: 0.1,
      });
      if (hs.length < 5) { streets.pop(); usedSpan.pop(); continue; }
      houses.push(...hs);
      villages.push({ x: p.x, z: p.z, h: heightAt(p.x, p.z), count: hs.length });
      sites.push({ x: p.x, z: p.z, radius: 120, kind: 'village' });
      clearings.push({ x: p.x, z: p.z, r: 150 });
      made += 1;
    }
  }

  // --- Farmsteads, out among the fields, off the road: the layer between village and field.
  const farms = [];
  {
    let made = 0;
    for (let k = 0; k < 220 && made < 7; k += 1) {
      const x = (rng() - 0.5) * size * 0.78;
      const z = (rng() - 0.5) * size * 0.78;
      const h = heightAt(x, z);
      if (h < 22 || h > 330) continue;
      if (flatness(heightAt, x, z, 70, 50) > 6) continue;
      const { along, lateral } = runwayOffset(x, z);
      if (along < 1500 && lateral < 450) continue;
      if (sites.some((s) => Math.hypot(s.x - x, s.z - z) < s.radius + 150)) continue;
      if (farms.some((f) => Math.hypot(f.x - x, f.z - z) < 260)) continue;
      const parts = planFarm(heightAt, x, z, rng() * Math.PI);
      if (parts.length < 2) continue;
      farms.push(...parts);
      sites.push({ x, z, radius: 60, kind: 'farm' });
      clearings.push({ x, z, r: 90 });
      made += 1;
    }
  }

  // --- Fields. Sampled over the valley floor, rejected on slope, overlap and land use.
  const fields = [];
  {
    const CELL = 55;
    const occupancy = new Map();
    const key = (gx, gz) => `${gx},${gz}`;
    const occupied = (x, z, r) => {
      const gx0 = Math.floor((x - r) / CELL);
      const gx1 = Math.floor((x + r) / CELL);
      const gz0 = Math.floor((z - r) / CELL);
      const gz1 = Math.floor((z + r) / CELL);
      for (let i = gx0; i <= gx1; i += 1) {
        for (let j = gz0; j <= gz1; j += 1) if (occupancy.has(key(i, j))) return true;
      }
      return false;
    };
    const occupy = (x, z, r) => {
      const gx0 = Math.floor((x - r) / CELL);
      const gx1 = Math.floor((x + r) / CELL);
      const gz0 = Math.floor((z - r) / CELL);
      const gz1 = Math.floor((z + r) / CELL);
      for (let i = gx0; i <= gx1; i += 1) {
        for (let j = gz0; j <= gz1; j += 1) occupancy.set(key(i, j), 1);
      }
    };
    // Sites occupy their own footprint. Roads deliberately do NOT go into this grid: bucketing a
    // corridor onto a 55 m grid blocks a 55 m band every 42 m along the whole road, which is exactly
    // the band the fields are sampled from — it was rejecting the near-road plots that make farmland
    // read. Distance to the road is tested directly below instead, which is both exact and cheap.
    for (const s of sites) occupy(s.x, s.z, s.radius);

    /**
     * Shortest distance from a point to any road polyline, subsampled to every other station.
     * A field must clear the asphalt by its own half-width plus a verge, or the plot is ploughed
     * over the road it is supposed to be served by.
     */
    const roadClearance = (x, z) => {
      let best = Infinity;
      for (const route of roadRoutes) {
        const pts = route.points;
        for (let i = 0; i < pts.length; i += 2) {
          const d = Math.hypot(pts[i].x - x, pts[i].z - z) - route.width * 0.5;
          if (d < best) best = d;
        }
      }
      return best;
    };

    for (let k = 0; k < 9000 && fields.length < 340; k += 1) {
      // Sample along the road rather than uniformly over the map, and offset *perpendicular* to it.
      //
      // Farmland clusters where the access is: a field 3 km from any track has no reason to be
      // ploughed. Uniform sampling is why the first pass produced 61 fields spread over 7.7 km —
      // statistically present, visually absent. The first fix attempt offset by a random box around
      // a road point, which put field centres on the asphalt; the offset has to be measured across
      // the road's tangent, never along it.
      const pts = roadRoutes[0].points;
      const si = Math.floor(rng() * pts.length);
      const seed = pts[si];
      const prev = pts[Math.max(0, si - 1)];
      const next = pts[Math.min(pts.length - 1, si + 1)];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const tlen = Math.hypot(tx, tz) || 1;
      tx /= tlen; tz /= tlen;
      const across = 55 + rng() * 620;
      const side = rng() < 0.5 ? -1 : 1;
      const alongJitter = (rng() - 0.5) * 180;
      const x = seed.x - tz * across * side + tx * alongJitter;
      const z = seed.z + tx * across * side + tz * alongJitter;
      const h = heightAt(x, z);
      if (h < 20 || h > 340) continue;
      const { along, lateral } = runwayOffset(x, z);
      if (along < 1200 && lateral < 380) continue;
      // Bigger plots: a 100 m field is a smudge from 500 ft, a 200 m field reads as a patch.
      const w = 120 + rng() * 150;
      const d = 90 + rng() * 120;
      // Fields line up roughly with the road, give or take 20 degrees, the way real strip farming
      // does. A uniformly random angle turns the valley into patchwork confetti.
      const angle = Math.atan2(tz, tx) + (rng() - 0.5) * 0.7;
      const rr = Math.max(w, d) * 0.5;
      // Only other fields and sites block a plot: the road corridor is already excluded by the
      // perpendicular offset above, and testing against it rejects almost every candidate.
      if (occupied(x, z, rr * 0.62)) continue;
      // Gradient, not relief.
      //
      // The first version rejected a plot whose corner heights spanned more than 13 m, which sounds
      // reasonable and is fatal here: the heightfield carries a bench-and-gully wash of ±(18 + 46)
      // metres, so almost every 200 m square on the valley floor spans more than that even where the
      // ground is perfectly walkable. It rejected 99.4% of candidates and left 51 fields on a 7.7 km
      // map. What actually makes a field impossible is *steepness*, and the drape follows the ground
      // anyway — so the test is a gradient along the plot's own axes, at 18%.
      const gx = Math.abs(heightAt(x + w * 0.5, z) - heightAt(x - w * 0.5, z)) / Math.max(1, w);
      const gz = Math.abs(heightAt(x, z + d * 0.5) - heightAt(x, z - d * 0.5)) / Math.max(1, d);
      if (gx > 0.18 || gz > 0.18) continue;
      // Clear the asphalt and the verge, measured properly rather than by grid bucketing.
      if (roadClearance(x, z) < rr * 0.55 + 14) continue;
      occupy(x, z, rr * 0.72);
      fields.push({
        x, z, w, d, angle,
        crop: CROPS[Math.floor(rng() * CROPS.length)],
        hedged: rng() < 0.72,
        hedgeIdx: Math.floor(rng() * HEDGE.length),
      });
      clearings.push({ x, z, r: rr * 0.85 });
    }
  }

  // --- The works: near the town, on flat ground, clear of the approach.
  const yardLights = [];
  const stacks = [];
  if (towns.length) {
    const t = towns[0];
    let found = null;
    for (let i = 0; i < 16 && !found; i += 1) {
      const a = (i / 16) * Math.PI * 2;
      const wx = t.x + Math.cos(a) * 680;
      const wz = t.z + Math.sin(a) * 680;
      if (heightAt(wx, wz) < 22) continue;
      if (flatness(heightAt, wx, wz, 210, 100) > 34) continue;
      if (sites.some((s) => Math.hypot(s.x - wx, s.z - wz) < s.radius + 120)) continue;
      found = { x: wx, z: wz };
    }
    if (found) {
      const works = buildWorks(heightAt, found.x, found.z, rng() * Math.PI);
      if (works.geometry) {
        const m = new THREE.Mesh(works.geometry, new THREE.MeshStandardMaterial({
          vertexColors: true, roughness: 0.86, metalness: 0.02,
        }));
        m.castShadow = true; m.receiveShadow = true; m.name = 'works';
        group.add(m);
        sites.push({ x: found.x, z: found.z, radius: 150, kind: 'works' });
        clearings.push({ x: found.x, z: found.z, r: 190 });
        stacks.push(...works.stacks);
        for (const [lx, lz] of [[-46, -18], [46, -18], [-46, 18], [46, 18]]) {
          yardLights.push({ x: found.x + lx, z: found.z + lz, y: works.y + 6 });
        }
      }
    }
  }

  // --- Harbour geometry, and its quay floodlights.
  if (harbour) {
    const h = buildHarbour(heightAt, harbour.x, harbour.z, harbour.angle, 6);
    if (h.geometry) {
      const m = new THREE.Mesh(h.geometry, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.86, metalness: 0.02,
      }));
      m.castShadow = true; m.receiveShadow = true; m.name = 'harbour';
      group.add(m);
      sites.push({ x: harbour.x, z: harbour.z, radius: 180, kind: 'harbour' });
      clearings.push({ x: harbour.x, z: harbour.z, r: 220 });
      const ca = Math.cos(harbour.angle);
      const sa = Math.sin(harbour.angle);
      for (let i = 0; i < 6; i += 1) {
        // On the apron behind the quay edge, not floating over the water.
        const lx = -60 + i * 24;
        yardLights.push({ x: harbour.x + lx * ca - 30 * sa, y: h.y + 16, z: harbour.z + lx * sa - 30 * ca });
      }
    }
  }

  /* --- Geometry ------------------------------------------------------------------------- */

  const wallMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.86, metalness: 0.02, flatShading: false,
  });

  let glowParts = [];
  {
    const built = buildStructures(houses, farms, churches);
    glowParts = built.glow;
    if (built.geometry) {
      const m = new THREE.Mesh(built.geometry, wallMat);
      m.castShadow = true; m.receiveShadow = true; m.name = 'buildings';
      group.add(m);
    }
  }

  {
    const geo = buildFields(heightAt, fields);
    if (geo) {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.97, metalness: 0, polygonOffset: true,
        polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }));
      m.name = 'fields';
      m.receiveShadow = true;
      group.add(m);
    }
  }

  {
    const geo = buildRoads(heightAt, roadRoutes);
    if (geo) {
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.95, metalness: 0, polygonOffset: true,
        polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      }));
      m.name = 'roads';
      m.receiveShadow = true;
      group.add(m);
    }
  }

  /* --- Night ----------------------------------------------------------------------------- */

  // Road-corridor clearings, so the forest stops at the verge.
  for (const route of roadRoutes) {
    for (let i = 0; i < route.points.length; i += 4) {
      const p = route.points[i];
      clearings.push({ x: p.x, z: p.z, r: route.width * 0.5 + 15 });
    }
  }

  const night = buildNightLights(streets, heightAt, yardLights, stacks);
  group.add(night.group);

  // The window plates ride the night layer's own additive material, so one day-cycle curve fades
  // windows and street lamps together — and the layer's `visible` flag switches both off at noon.
  if (glowParts.length) {
    const glowGeo = merge(glowParts);
    if (glowGeo) {
      const glow = new THREE.Mesh(glowGeo, night.warmMat);
      glow.name = 'window-glow';
      glow.renderOrder = 2;
      night.group.add(glow);
    }
  }

  return {
    group,
    sites,
    towns,
    villages,
    fields,
    farms: farms.filter((f) => f.kind === 'house'),
    clearings,
    night,
    road: trunk,
  };
}
