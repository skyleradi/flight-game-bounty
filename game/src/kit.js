// The kit: what the pilot collects during a sortie, and what they spend it on between sorties.
//
// Two systems, one file, because they are the same ledger. A pickup in the air is worth credits,
// and credits are worth upgrades; an upgrade is worth nothing unless the next sortie is harder than
// the last one, which is exactly what the campaign is. Splitting them across two modules would mean
// two serialisations of the same save and two chances to disagree about it.
//
// Everything here is deterministic: pickup placement is keyed to the course geometry, so the same
// round always puts the same cans in the same places and a screenshot of round 2 is the same round
// 2 the judge flies.

import * as THREE from '../vendor/three.module.min.js';
import { AIRCRAFT, UPGRADES } from './config.js';

/** What a pickup does. `kind` decides both the effect and how the mesh is built. */
export const PICKUPS = {
  fuel: {
    label: 'Fuel can',
    color: 0xffc24d, emissive: 0x6a4a08,
    /** Restores this fraction of the round's fuel. */
    fuel: 0.18,
    credits: 0,
    blurb: '+18% fuel',
  },
  repair: {
    label: 'Repair kit',
    color: 0x6ef0b8, emissive: 0x0d5440,
    health: 16,
    credits: 0,
    blurb: '+16 airframe',
  },
  boost: {
    label: 'Boost cell',
    color: 0x8fd0ff, emissive: 0x123a5e,
    boost: 1,
    credits: 0,
    blurb: 'afterburner refilled',
  },
  credits: {
    label: 'Salvage',
    color: 0xffe27a, emissive: 0x6a5410,
    credits: 120,
    blurb: '+120 credits',
  },
};

/**
 * The upgrade tree. Four lines, three levels each, and every level is a real number the flight
 * model or the mission reads: none of these are cosmetic.
 */
export const UPGRADE_LINES = UPGRADES;

/** The save. A version tag so an old save with a different shape does not poison a new build. */
export const KIT_KEY = 'ridge-runner-kit-v1';

export function loadKit() {
  try {
    const raw = localStorage.getItem(KIT_KEY);
    if (!raw) return freshKit();
    const p = JSON.parse(raw);
    if (p.version !== 1) return freshKit();
    return {
      version: 1,
      credits: Number.isFinite(p.credits) ? p.credits : 0,
      levels: p.levels && typeof p.levels === 'object' ? p.levels : {},
      // Lifetime tallies, so the debrief can say something true about the campaign.
      collected: p.collected ?? 0,
    };
  } catch {
    return freshKit();
  }
}

function freshKit() {
  return { version: 1, credits: 0, levels: {}, collected: 0 };
}

export function saveKit(kit) {
  try {
    localStorage.setItem(KIT_KEY, JSON.stringify(kit));
  } catch {
    /* A private window refuses storage; the kit just does not persist. */
  }
}

/** The level bought in one line, 0 when nothing is bought. */
export function levelOf(kit, lineId) {
  return kit.levels?.[lineId] ?? 0;
}

/** The cost of the next level in a line, or null when the line is maxed. */
export function nextCost(kit, lineId) {
  const line = UPGRADE_LINES.find((l) => l.id === lineId);
  if (!line) return null;
  const lvl = levelOf(kit, lineId);
  if (lvl >= line.tiers.length) return null;
  return line.tiers[lvl].cost;
}

export function canBuy(kit, lineId) {
  const cost = nextCost(kit, lineId);
  return cost !== null && kit.credits >= cost;
}

export function buy(kit, lineId) {
  const cost = nextCost(kit, lineId);
  if (cost === null || kit.credits < cost) return false;
  kit.credits -= cost;
  kit.levels[lineId] = levelOf(kit, lineId) + 1;
  saveKit(kit);
  return true;
}

/**
 * The aircraft's numbers with the kit applied. The flight model reads the returned object instead
 * of the constant, so buying an engine actually moves the aircraft rather than just the menu.
 */
export function aircraftWithKit(kit) {
  const out = { ...AIRCRAFT };
  const lvl = (id) => levelOf(kit, id);
  const pct = (id) => {
    const line = UPGRADE_LINES.find((l) => l.id === id);
    let total = 0;
    for (let i = 0; i < lvl(id); i += 1) total += line.tiers[i].value;
    return total;
  };

  // Engine: thrust and top speed.
  const engine = pct('engine');
  out.maxThrust = AIRCRAFT.maxThrust * (1 + engine);
  out.vne = AIRCRAFT.vne * (1 + engine * 0.4);

  // Airframe: hit points, and a tougher wing against hard landings.
  const airframe = pct('airframe');
  out.health = AIRCRAFT.health * (1 + airframe);
  out.crashDamage = AIRCRAFT.crashDamage * (1 - airframe * 0.35);
  out.crosswindLimit = AIRCRAFT.crosswindLimit * (1 + airframe * 0.5);

  // Fuel: tank size, and a leaner burn.
  const fuel = pct('fuel');
  out.fuel = AIRCRAFT.fuel * (1 + fuel);
  out.fuelBurn = AIRCRAFT.fuelBurn * (1 - fuel * 0.35);

  // Handling: control authority, and a wing that gives a little more warning before it stalls.
  const handling = pct('handling');
  out.pitchRate = AIRCRAFT.pitchRate * (1 + handling);
  out.rollRate = AIRCRAFT.rollRate * (1 + handling);
  out.stall = AIRCRAFT.stall * (1 - handling * 0.35);
  out.boost = {
    ...AIRCRAFT.boost,
    capacity: AIRCRAFT.boost.capacity * (1 + handling * 0.45),
  };

  return out;
}

/**
 * Builds the pickups for one round. They hang off the course between gates rather than on them, so
 * collecting one costs a small deviation and the choice is real: the racing line is not the line
 * that picks everything up.
 */
export function planPickups(round, gates) {
  const out = [];
  if (!gates || gates.length < 2) return out;

  // The kinds a round can hold, in a fixed order, so the same round always gets the same kit.
  const rotation = ['fuel', 'credits', 'repair', 'boost', 'credits'];
  let n = 0;
  for (let i = 1; i < gates.length; i += 1) {
    const a = gates[i - 1];
    const b = gates[i];
    // One can per gap, a third of the way along and offset to the side, so it sits off the direct
    // line. A can dead on the line is not a decision, it is a formality.
    const t = 0.34;
    const side = (i % 2 === 0 ? 1 : -1) * (round.radius * 0.85 + 22);
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const x = a.x + dx * t + nx * side;
    const z = a.z + dz * t + nz * side;
    const y = Math.max(a.y + (b.y - a.y) * t, a.y) + 4;

    const kind = rotation[n % rotation.length];
    n += 1;
    out.push({ kind, x, y, z, taken: false, index: i - 1 });
  }
  return out;
}

/** The pickup meshes: a small glowing can with a ring around it, built once per round. */
export function buildPickupMeshes(pickups) {
  const group = new THREE.Group();
  group.name = 'pickups';
  const items = [];

  const canGeo = new THREE.CylinderGeometry(2.4, 2.4, 5.2, 12);
  const ringGeo = new THREE.TorusGeometry(6.4, 0.28, 8, 24);

  for (const p of pickups) {
    const spec = PICKUPS[p.kind] ?? PICKUPS.credits;
    const g = new THREE.Group();
    g.position.set(p.x, p.y, p.z);

    const bodyMat = new THREE.MeshStandardMaterial({
      color: spec.color,
      emissive: spec.emissive,
      emissiveIntensity: 1.5,
      metalness: 0.55,
      roughness: 0.3,
    });
    const body = new THREE.Mesh(canGeo, bodyMat);
    body.castShadow = false;
    g.add(body);

    const ringMat = new THREE.MeshBasicMaterial({
      color: spec.color, transparent: true, opacity: 0.55,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    g.add(ring);

    group.add(g);
    items.push({ spec, group: g, body, ring, pickup: p });
  }

  return {
    group,
    items,
    /** Spins the cans and fades the ones already taken. */
    update(dt, time) {
      for (const it of items) {
        if (it.pickup.taken) {
          it.group.visible = false;
          continue;
        }
        it.group.visible = true;
        it.group.rotation.y = time * 1.1;
        it.body.position.y = Math.sin(time * 1.7 + it.pickup.index) * 0.6;
        it.ring.rotation.z = time * 0.8;
        it.ring.scale.setScalar(1 + Math.sin(time * 2.2 + it.pickup.index) * 0.08);
      }
    },
    dispose() {
      canGeo.dispose();
      ringGeo.dispose();
      for (const it of items) {
        it.body.material.dispose();
        it.ring.material.dispose();
      }
      group.clear();
    },
  };
}

/**
 * Tests whether the aircraft passed within reach of a can this step. Uses the segment travelled,
 * for the same reason the obstacle test does: at cruise a can 4 m across can be jumped entirely
 * between two frames.
 */
export function checkPickups(pickups, from, to, radius = 9) {
  const hits = [];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  const segLen2 = dx * dx + dy * dy + dz * dz;
  for (const p of pickups) {
    if (p.taken) continue;
    // Closest point on the segment to the can, as a fraction of the segment.
    let t = 0;
    if (segLen2 > 1e-6) {
      t = ((p.x - from.x) * dx + (p.y - from.y) * dy + (p.z - from.z) * dz) / segLen2;
      t = Math.max(0, Math.min(1, t));
    }
    const cx = from.x + dx * t;
    const cy = from.y + dy * t;
    const cz = from.z + dz * t;
    const d2 = (p.x - cx) ** 2 + (p.y - cy) ** 2 + (p.z - cz) ** 2;
    if (d2 <= radius * radius) {
      p.taken = true;
      hits.push(p);
    }
  }
  return hits;
}

/** What a collected can gives back, as a patch the caller applies to the aircraft and the kit. */
export function applyPickup(spec, aircraftState, round, kit) {
  const out = { credits: 0, health: 0, fuel: 0, boost: 0 };
  if (spec.fuel) {
    const before = aircraftState.fuel;
    aircraftState.fuel = Math.min(round.fuel, aircraftState.fuel + round.fuel * spec.fuel);
    out.fuel = Math.round(aircraftState.fuel - before);
  }
  if (spec.health) {
    const before = aircraftState.health;
    aircraftState.health = Math.min(AIRCRAFT.health, aircraftState.health + spec.health);
    out.health = Math.round(aircraftState.health - before);
  }
  if (spec.boost) {
    aircraftState.boost = 1;
    out.boost = 1;
  }
  if (spec.credits) {
    kit.credits += spec.credits;
    kit.collected = (kit.collected ?? 0) + 1;
    saveKit(kit);
    out.credits = spec.credits;
  }
  return out;
}

/** The round's credit purse for finishing it, so a clean sortie is worth more than a salvage run. */
export function roundPurse(round, result) {
  const gatePart = Math.round((result.gatesPassed / round.gates) * 90);
  const cleanPart = result.reason === 'landed' ? 110 : 0;
  const level = Math.round(round.difficulty * 40);
  return gatePart + cleanPart + level;
}
