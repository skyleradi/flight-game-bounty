// The air defence: flak towers on the ridges, interceptors in the air, and the rounds both of them
// fire.
//
// The design constraint that shaped everything here is that a hit has to be the pilot's fault. So
// there are no hitscan weapons and no auto-aim: a turret tracks the aircraft, leads it, and throws a
// tracer that takes a visible fraction of a second to arrive, and the aircraft's job is to not be
// there when it does. Drones chase, but they turn slower than the aircraft does, so the way out is
// to turn inside them. Every projectile is a real object in the world with a position and a
// velocity, drawn as a glowing tracer, so the pilot can always see what is coming.
//
// The aircraft can shoot back. Guns are short-ranged and hard to aim — a cone from the nose — so
// killing a turret is a deliberate strafing run rather than something that happens by accident on
// the way past. Kills score.

import * as THREE from '../vendor/three.module.min.js';
import { ENEMY, ORDNANCE, RUNWAY } from './config.js';
import { createDogfight, createSquad, stepDogfight } from './dogfight.js';

const tmp = new THREE.Vector3();
const V_fwd = new THREE.Vector3();

/** A cheap deterministic RNG, seeded per placement pass. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * A flak tower: a concrete base, a lattice mast and a gun house that swings to track the aircraft.
 *
 * The model is deliberately built as three objects rather than one, because the gun house has to
 * *point at the aircraft*: a turret whose barrel does not follow the target reads as a static prop,
 * and half the tension of flying past one is seeing it swing onto you and knowing the next burst is
 * on its way. The base is the only thing that casts a shadow; the barrel is 8 triangles.
 */
function buildTurretGeometry() {
  const group = new THREE.Group();

  const concrete = new THREE.MeshStandardMaterial({
    color: 0x6f6d68, roughness: 0.94, metalness: 0.04, flatShading: true,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x3a4048, roughness: 0.55, metalness: 0.62, flatShading: true,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x22262b, roughness: 0.6, metalness: 0.5,
  });

  // Base: a squat, tapered plinth. Wider at the bottom, so it sits on the ground rather than
  // hovering, and the taper is the whole silhouette.
  const base = new THREE.Mesh(new THREE.CylinderGeometry(6.4, 8.6, 9.5, 8), concrete);
  base.position.y = 4.75;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  // The mast: four legs and three braces, so it reads as a lattice rather than as a pole.
  const legGeo = new THREE.BoxGeometry(0.55, 17, 0.55);
  for (let i = 0; i < 4; i += 1) {
    const a = (i / 4) * Math.PI * 2 + Math.PI * 0.25;
    const leg = new THREE.Mesh(legGeo, steel);
    leg.position.set(Math.cos(a) * 3.4, 18, Math.sin(a) * 3.4);
    leg.rotation.z = Math.cos(a) * 0.055;
    leg.rotation.x = -Math.sin(a) * 0.055;
    leg.castShadow = true;
    group.add(leg);
  }
  for (let i = 0; i < 3; i += 1) {
    const brace = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.42, 0.42), steel);
    brace.position.y = 12 + i * 5.4;
    brace.rotation.y = i * 0.6;
    group.add(brace);
  }

  // The gun house, on top. Its own group so the game can yaw it at the aircraft.
  const head = new THREE.Group();
  head.position.y = 27;
  const shell = new THREE.Mesh(new THREE.BoxGeometry(6.2, 3.4, 5.0), steel);
  shell.castShadow = true;
  head.add(shell);
  // Two barrels, offset, pointing out along -Z in the head's own frame.
  const barrelGeo = new THREE.CylinderGeometry(0.36, 0.42, 8.4, 6);
  for (const side of [-1, 1]) {
    const barrel = new THREE.Mesh(barrelGeo, dark);
    barrel.rotation.x = Math.PI * 0.5;
    barrel.position.set(side * 1.5, 0.2, -5.4);
    head.add(barrel);
  }
  // A muzzle flash: a bright cone that is switched on for a few hundredths of a second per shot.
  const flash = new THREE.Mesh(
    new THREE.ConeGeometry(1.5, 4.4, 6, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffd08a, transparent: true, opacity: 0.9, depthWrite: false }),
  );
  flash.rotation.x = -Math.PI * 0.5;
  flash.position.set(0, 0.2, -10.4);
  flash.visible = false;
  head.add(flash);

  // The obstruction light, which is what makes the tower findable against a dark ridge.
  const lamp = new THREE.Mesh(
    new THREE.SphereGeometry(0.85, 8, 6),
    new THREE.MeshBasicMaterial({ color: 0xff4a3c }),
  );
  lamp.position.y = 2.6;
  head.add(lamp);

  group.add(head);
  return { group, head, flash, lamp };
}

/**
 * Builds an interceptor: a small delta drone, built low and wide so it reads as a machine hunting
 * the aircraft rather than as another tree.
 *
 * `ace` swaps the livery and adds the parts that only a flight leader carries, so the pilot can
 * tell which machine in a formation is the one that matters before it starts shooting. Without a
 * visual difference the ace flag is a hidden stat — the same silhouette that flies tighter and
 * shoots straighter — and the player has no way to read it.
 */
function buildDrone({ ace = false } = {}) {
  const group = new THREE.Group();

  // The ace wears a darker, glossier skin with a black spine and a brighter accent, so it reads as
  // a different machine even at 300 m in a grey sky.
  const skin = new THREE.MeshStandardMaterial({
    color: ace ? 0x24262b : 0x4a4f56,
    roughness: ace ? 0.28 : 0.42,
    metalness: ace ? 0.85 : 0.68,
    flatShading: true,
    envMapIntensity: ace ? 1.6 : 1.1,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: ace ? 0xff2a18 : 0xb03a30,
    roughness: 0.5, metalness: 0.3, flatShading: true,
    emissive: ace ? 0x5a0c06 : 0x000000,
    emissiveIntensity: ace ? 1 : 0,
  });
  const eye = new THREE.MeshBasicMaterial({ color: ace ? 0xff5a20 : 0xff3826 });

  // A flattened delta body.
  const body = new THREE.Mesh(new THREE.ConeGeometry(2.2, 7.6, 4), skin);
  body.rotation.x = -Math.PI * 0.5;
  body.rotation.z = Math.PI * 0.25;
  body.scale.set(1, 0.55, 1);
  body.castShadow = true;
  group.add(body);

  // Winglets, swept back, so the silhouette is a chevron. The ace's are longer and canted further
  // forward, which changes the shape of the machine and not only its paint.
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(
      new THREE.BoxGeometry(ace ? 6.4 : 5.2, ace ? 0.38 : 0.32, ace ? 2.0 : 1.7),
      skin,
    );
    wing.position.set(side * (ace ? 3.7 : 3.1), 0, 1.4);
    wing.rotation.z = side * (ace ? 0.40 : 0.30);
    wing.rotation.y = side * -0.34;
    wing.castShadow = true;
    group.add(wing);
    // A stripe on each wing tip: the single cue that says "not yours" at a distance.
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(ace ? 1.9 : 1.5, ace ? 0.42 : 0.36, ace ? 1.4 : 1.1),
      accent,
    );
    stripe.position.set(side * (ace ? 6.0 : 5.0), 0.02, 1.9);
    stripe.rotation.z = side * (ace ? 0.40 : 0.30);
    stripe.rotation.y = side * -0.34;
    group.add(stripe);
  }

  // The eye: a glowing sensor in the nose, which is where the tracers come from.
  const lens = new THREE.Mesh(new THREE.SphereGeometry(ace ? 0.78 : 0.62, 8, 6), eye);
  lens.position.set(0, 0.2, -3.8);
  group.add(lens);

  // Only the leader carries the dorsal fin and the twin tail lights. Two extra shapes is enough
  // for the silhouette to differ at the range the player first sees it, which a paint job alone
  // does not manage against a flat sky.
  if (ace) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.36, 2.0, 2.4), skin);
    fin.position.set(0, 1.1, 2.0);
    fin.rotation.x = -0.22;
    fin.castShadow = true;
    group.add(fin);

    // Inlets either side of the spine: the interdiction mark, and two more bright points.
    for (const side of [-1, 1]) {
      const inlet = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 1.9), accent);
      inlet.position.set(side * 1.5, 0.45, 1.1);
      group.add(inlet);
    }
    // A second, hotter sensor under the nose, so the ace is lit from two points rather than one.
    const chin = new THREE.Mesh(new THREE.SphereGeometry(0.42, 7, 6), eye);
    chin.position.set(0, -0.7, -3.1);
    group.add(chin);
  }

  return { group, lens };
}

/**
 * The air defence for one round.
 *
 * `state` is the same aircraft state the flight model steps; the module reads its position,
 * velocity and heading and never writes to it except through `applyDamage`, which the game owns.
 */
export function createAirDefence({ scene, terrain, round, haze }) {
  const cfg = round.airDefence ?? { flak: 0, drones: 0 };
  const group = new THREE.Group();
  group.name = 'airDefence';
  scene.add(group);

  const rng = makeRng(round.id * 7919 + 104729);

  /** Every live turret. `head` is the yawing gun house. */
  const turrets = [];
  /** Every live drone. */
  const drones = [];
  /** Rounds in flight: { pos, vel, life, from }. */
  const bullets = [];
  /** The aircraft's own rounds: { pos, vel, life }. */
  const slugs = [];
  /** Short-lived visual effects: { mesh, life, max }. */
  const effects = [];

  // --- Tracers, as one instanced mesh. A tracer is a stretched, emissive sliver; there can be a
  // hundred in the air at once and each one is six triangles.
  //
  // The sliver's *thickness* is what decides whether the player can see it at all. A real round is
  // 30 mm across, which at 150 m is a fifth of a pixel — invisible. The tracer is the burning
  // element behind it, and it reads on screen because it is bright and several metres long, so the
  // box is deliberately fatter than the projectile it stands in for: 1.15 m across is about four
  // pixels at 150 m, which is the width a tracer line needs to register as a line.
  const TRACER_MAX = 240;
  const tracerGeo = new THREE.BoxGeometry(1.45, 1.45, 11.0);
  const tracerMat = new THREE.MeshBasicMaterial({
    color: 0xffd9a0, transparent: true, opacity: 0.95, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const tracers = new THREE.InstancedMesh(tracerGeo, tracerMat, TRACER_MAX);
  tracers.frustumCulled = false;
  tracers.count = 0;
  scene.add(tracers);

  // The aircraft's own rounds, in a colder colour so the two are never confused in a furball.
  const SLUG_MAX = 180;
  const slugGeo = new THREE.BoxGeometry(0.95, 0.95, 9.0);
  const slugMat = new THREE.MeshBasicMaterial({
    color: 0xa8f0ff, transparent: true, opacity: 0.95, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const slugsMesh = new THREE.InstancedMesh(slugGeo, slugMat, SLUG_MAX);
  slugsMesh.frustumCulled = false;
  slugsMesh.count = 0;
  scene.add(slugsMesh);

  const tracerMatrix = new THREE.Matrix4();
  const tracerQuat = new THREE.Quaternion();
  const tracerScale = new THREE.Vector3(1, 1, 1);
  const tracerPos = new THREE.Vector3();
  const dirVec = new THREE.Vector3();
  const upVec = new THREE.Vector3(0, 1, 0);

  // --- Placement. Turrets go on high, open ground away from the airfield, and they are kept off
  // the gate line: a gun sitting on top of a gate is not a threat, it is a tax.
  function placeTurrets(count) {
    let placed = 0;
    for (let tries = 0; tries < 4000 && placed < count; tries += 1) {
      // Sample along the course's own span so the guns are where the flying is.
      const along = 1400 + rng() * 3600;
      const lateral = (rng() * 2 - 1) * 1500;
      const x = RUNWAY.x + Math.sin(RUNWAY.heading) * along + Math.cos(RUNWAY.heading) * lateral;
      const z = RUNWAY.z - Math.cos(RUNWAY.heading) * along + Math.sin(RUNWAY.heading) * lateral;
      const y = terrain.heightAt(x, z);
      if (y < 90) continue;
      // On a ridge or a shoulder, not in a hollow: a turret in a valley cannot see the sky.
      const slope = Math.abs(terrain.heightAt(x + 30, z) - y) + Math.abs(terrain.heightAt(x, z + 30) - y);
      if (slope / 30 > 0.55) continue;
      // Keep them apart from each other, so they do not stack into one super-gun.
      let tooClose = false;
      for (const t of turrets) {
        if (Math.hypot(t.x - x, t.z - z) < 620) { tooClose = true; break; }
      }
      if (tooClose) continue;

      const built = buildTurretGeometry();
      built.group.position.set(x, y - 1.0, z);
      built.group.rotation.y = rng() * Math.PI * 2;
      group.add(built.group);
      turrets.push({
        x, z, y: y - 1.0,
        root: built.group,
        head: built.head,
        flash: built.flash,
        lamp: built.lamp,
        hp: ENEMY.turretHealth,
        alive: true,
        cooldown: 0.4 + rng() * 1.6,
        burstLeft: 0,
        burstTimer: 0,
        flashTimer: 0,
        // Each gun has its own slight inaccuracy, so they do not all pattern identically.
        spread: ENEMY.spread * (0.7 + rng() * 0.8),
        yaw: 0,
        pitch: 0,
      });
      placed += 1;
    }
  }

  // --- Drones start in the air, spread along the course at gate height, hunting.
  //
  // `aceIndex` is decided by the caller before placement, not after: the livery is baked into the
  // geometry, so a drone built as a wingman cannot later be promoted to leader without rebuilding
  // it. Deciding first is also what makes the leader's position in the formation deliberate rather
  // than a coin toss over an array that has already been filled.
  function placeDrones(count, aceIndex) {
    for (let i = 0; i < count; i += 1) {
      const along = 2000 + (i / Math.max(1, count)) * 2600 + rng() * 400;
      const lateral = (rng() * 2 - 1) * 900;
      const x = RUNWAY.x + Math.sin(RUNWAY.heading) * along + Math.cos(RUNWAY.heading) * lateral;
      const z = RUNWAY.z - Math.cos(RUNWAY.heading) * along + Math.sin(RUNWAY.heading) * lateral;
      const y = Math.max(terrain.heightAt(x, z) + 220, 380);
      const isAce = i === aceIndex && count > 1;
      const built = buildDrone({ ace: isAce });
      built.group.position.set(x, y, z);
      group.add(built.group);
      drones.push({
        group: built.group,
        position: new THREE.Vector3(x, y, z),
        velocity: new THREE.Vector3(),
        heading: rng() * Math.PI * 2,
        hp: ENEMY.drone.health,
        alive: true,
        cooldown: 1.2 + rng() * 2.4,
        bank: 0,
        pitch: 0,
        /** True for the one flight leader per round, so the kill can be reported as an ace. */
        ace: isAce,
      });
    }
  }

  // The leader is chosen before anything is built, because the machine's shape depends on it.
  const droneCount = cfg.drones ?? 0;
  const aceIndex = droneCount > 1 ? Math.floor(rng() * droneCount) : 0;

  placeTurrets(cfg.flak ?? 0);
  placeDrones(droneCount, aceIndex);

  // One squad book per round, shared by every interceptor: it is what stops three of them from
  // stacking into a single gun. One ace per flight, so there is a leader worth fearing.
  const squad = createSquad(drones.length);
  drones.forEach((d, i) => {
    d.brain = createDogfight({
      seed: round.id * 3701 + i * 911 + 17,
      ace: d.ace,
      skill: 0.92 + rng() * 0.18,
    });
    d.speedNow = ENEMY.drone.speed;
    d.hpLast = d.hp;
  });

  if (haze) haze.patchObject(group);

  /** Muzzle flash on a turret, as a short-lived emissive cone. */
  function flashOn(turret) {
    turret.flash.visible = true;
    turret.flashTimer = 0.055;
  }

  /**
   * Fires one tracer from a world point along a direction, with the gun's own spread applied.
   * Returns the bullet so the caller can chain a burst.
   */
  function fireBullet(from, dir, speed, damage, owner) {
    const spread = owner.spread ?? 0.01;
    const b = {
      pos: from.clone(),
      vel: dir.clone().multiplyScalar(speed),
      life: 4.2,
      damage,
      owner,
      // A tiny random cone, so a burst is a group of rounds rather than one round drawn three
      // times. Two independent gaussians is an acceptable approximation here.
      wobble: (rng() + rng() + rng() - 1.5) * 2,
    };
    // Rotate the direction by a small random angle in two axes.
    const a = (rng() - 0.5) * spread * 2;
    const bAngle = (rng() - 0.5) * spread * 2;
    const axis = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).normalize();
    dir.applyAxisAngle(upVec, a);
    dir.applyAxisAngle(axis, bAngle);
    b.vel = dir.multiplyScalar(speed);
    bullets.push(b);
    return b;
  }

  /**
   * Advances everything: turrets track and fire, drones chase and fire, rounds fly and expire.
   *
   * `dt` is the fixed step. Returns the events the game turns into damage, messages and score:
   * `{ type: 'hit', damage }`, `{ type: 'kill', kind, position, score }`.
   */
  function update(dt, aircraftState, sortieTime, controls = null) {
    const events = [];
    const aircraftPos = aircraftState.position;
    const aircraftVel = tmp.set(
      Math.sin(aircraftState.heading) * Math.cos(aircraftState.pitch),
      Math.sin(aircraftState.pitch),
      -Math.cos(aircraftState.heading) * Math.cos(aircraftState.pitch),
    ).multiplyScalar(aircraftState.speed);

    // --- Turrets. Each one tracks the aircraft, and fires a burst when it is inside range and
    // inside its arc. The lead is not exact: a gun that always leads perfectly is unsurvivable,
    // and the whole point is that the pilot can see the tracer and turn.
    for (const t of turrets) {
      if (!t.alive) continue;

      const dx = aircraftPos.x - t.x;
      const dy = aircraftPos.y - (t.y + 27);
      const dz = aircraftPos.z - t.z;
      const dist = Math.hypot(dx, dy, dz);

      // The head swings toward the aircraft whatever the range, so a distant gun still visibly
      // tracks: that is the warning.
      const wantYaw = Math.atan2(dx, -dz);
      const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
      let yawDelta = ((wantYaw - t.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      if (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
      // A turret traverses at a finite rate, so a fast pass can outrun its tracking.
      const maxYaw = 1.5 * dt;
      t.yaw += Math.max(-maxYaw, Math.min(maxYaw, yawDelta));
      const maxPitch = 1.1 * dt;
      t.pitch += Math.max(-maxPitch, Math.min(maxPitch, wantPitch - t.pitch));

      t.head.rotation.y = t.yaw;
      t.head.rotation.x = -t.pitch;

      // Muzzle flash decay.
      if (t.flashTimer > 0) {
        t.flashTimer -= dt;
        if (t.flashTimer <= 0) t.flash.visible = false;
      }

      // The obstruction light blinks, which is the only thing that makes a mast findable at dusk.
      t.lamp.visible = (sortieTime * 0.9) % 1 > 0.5;

      if (dist > ENEMY.range) { t.cooldown = Math.max(t.cooldown, 0.35); continue; }
      // It cannot shoot through itself: a gun below the aircraft does not fire straight up through
      // its own mast, so the arc is limited to roughly level and up.
      if (Math.abs(t.pitch) > 1.25) continue;

      t.cooldown -= dt;
      if (t.burstLeft > 0) {
        t.burstTimer -= dt;
        if (t.burstTimer <= 0) {
          // Aim with a lead the pilot can beat: it leads where the aircraft will be, not where it
          // is, but only by the round's flight time with no correction for a turn.
          const tof = dist / ENEMY.bulletSpeed;
          const aimX = aircraftPos.x + aircraftVel.x * tof * 0.82;
          const aimY = aircraftPos.y + aircraftVel.y * tof * 0.82;
          const aimZ = aircraftPos.z + aircraftVel.z * tof * 0.82;
          const aim = new THREE.Vector3(aimX - t.x, aimY - (t.y + 27), aimZ - t.z).normalize();
          fireBullet(
            new THREE.Vector3(t.x + aim.x * 9, t.y + 27 + aim.y * 9, t.z + aim.z * 9),
            aim,
            ENEMY.bulletSpeed,
            ENEMY.damage,
            t,
          );
          flashOn(t);
          t.burstLeft -= 1;
          t.burstTimer = 0.11;
          if (t.burstLeft <= 0) t.cooldown = ENEMY.fireRate * (0.7 + rng() * 0.6);
        }
      } else if (t.cooldown <= 0) {
        t.burstLeft = ENEMY.burst;
        t.burstTimer = 0;
      }
    }

    // --- Interceptors. Each one is a small state machine (see dogfight.js): patrol, pursue, attack,
    // extend, evade. The squad book caps how many may press an attack at once, so a flight of three
    // does not stack into one laser-accurate gun.
    for (const d of drones) {
      if (!d.alive) continue;

      const dx = aircraftPos.x - d.position.x;
      const dy = aircraftPos.y - d.position.y;
      const dz = aircraftPos.z - d.position.z;
      const dist = Math.hypot(dx, dy, dz);
      const cfgD = ENEMY.drone;

      if (dist < cfgD.engageRange * 3.2) {
        const brain = d.brain;

        const shot = stepDogfight(d, {
          cfg: cfgD,
          terrain,
          aircraftPos,
          aircraftVel,
          aircraftSpeed: aircraftState.speed,
          squad,
          time: sortieTime,
          rng,
        }, dt);

        // Integrate. The brain set heading/pitch/speedNow; the caller owns position.
        V_fwd.set(
          Math.sin(d.heading) * Math.cos(d.pitch),
          Math.sin(d.pitch),
          -Math.cos(d.heading) * Math.cos(d.pitch),
        );
        d.velocity.copy(V_fwd).multiplyScalar(d.speedNow);
        d.position.addScaledVector(d.velocity, dt);
        d.group.position.copy(d.position);
        d.group.rotation.set(d.pitch, -d.heading, d.bank, 'YXZ');

        if (shot.fire) {
          fireBullet(
            d.position.clone().addScaledVector(V_fwd, 5),
            new THREE.Vector3(dx, dy, dz).normalize(),
            ENEMY.bulletSpeed * 0.95,
            cfgD.damage,
            { spread: 0.022 },
          );
        }

        // Being hit makes it break. This is set here rather than in the damage path because the
        // brain needs it before its next decision, and `hp` is all the damage path touches.
        if (d.hp < (d.hpLast ?? d.hp)) {
          brain.hitFlash = 0.9;
          d.hpLast = d.hp;
        }
      } else {
        // Out of contact: keep flying a patrol line so it is not a stationary target.
        d.brain.timer = Math.min(d.brain.timer, 0.6);
      }
    }

    // The squad book is derived, not accumulated: it is the number of live interceptors actually in
    // the attack state right now. Recomputing it here means no transition can leak a slot, which is
    // the bug the previous incremental version had.
    let attacking = 0;
    for (const d of drones) {
      if (d.alive && d.brain.state === 'attack') attacking += 1;
    }
    squad.attackers = attacking;

    // --- Rounds. Integrated, then tested against the aircraft's position as a sphere. The aircraft
    // is 11 m across, so the hit sphere is generous enough that a round which visibly passes
    // through the fuselage counts.
    const HIT_RADIUS = 7.2;
    for (let i = bullets.length - 1; i >= 0; i -= 1) {
      const b = bullets[i];
      b.pos.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.life <= 0) { bullets.splice(i, 1); continue; }
      // Terrain stop: a round that hits the hill in front of the aircraft is a near miss the pilot
      // can see, not a phantom.
      if (b.pos.y < terrain.heightAt(b.pos.x, b.pos.z)) { bullets.splice(i, 1); continue; }
      const d2 = b.pos.distanceToSquared(aircraftPos);
      if (d2 < HIT_RADIUS * HIT_RADIUS) {
        events.push({ type: 'hit', damage: b.damage, position: b.pos.clone() });
        // A small spark at the impact point.
        spawnSpark(b.pos, 0xffc080);
        bullets.splice(i, 1);
      }
    }

    // --- The aircraft's own rounds, against turrets and drones.
    for (let i = slugs.length - 1; i >= 0; i -= 1) {
      const s = slugs[i];
      s.pos.addScaledVector(s.vel, dt);
      s.life -= dt;
      if (s.life <= 0) { slugs.splice(i, 1); continue; }
      if (s.pos.y < terrain.heightAt(s.pos.x, s.pos.z)) { slugs.splice(i, 1); continue; }

      let consumed = false;
      for (const t of turrets) {
        if (!t.alive) continue;
        if (Math.abs(s.pos.y - (t.y + 27)) > 15) continue;
        if (Math.hypot(s.pos.x - t.x, s.pos.z - t.z) > 7.5) continue;
        t.hp -= 9;
        spawnSpark(s.pos, 0xffe0a0);
        // Every round that lands is reported, not only the one that kills. A gun that gives no
        // feedback until the target dies cannot be aimed: the pilot has no way to tell a near miss
        // from a hit, and the only way to learn the lead is to watch the thing fall over.
        events.push({
          type: 'hitmark',
          kind: 'turret',
          damage: 9,
          killed: t.hp <= 0,
          position: s.pos.clone(),
        });
        if (t.hp <= 0) {
          t.alive = false;
          t.head.visible = false;
          // A killed turret slumps: the mast is still there, but the gun house is gone and the
          // light is out, which is what the pilot sees as "that one is dead".
          events.push({ type: 'kill', kind: 'turret', position: new THREE.Vector3(t.x, t.y + 27, t.z) });
        }
        consumed = true;
        break;
      }
      if (!consumed) {
        for (const d of drones) {
          if (!d.alive) continue;
          if (s.pos.distanceToSquared(d.position) < 8.5 * 8.5) {
            d.hp -= 9;
            spawnSpark(s.pos, 0xff9040);
            events.push({
              type: 'hitmark',
              kind: 'drone',
              damage: 9,
              killed: d.hp <= 0,
              ace: d.ace === true,
              position: s.pos.clone(),
            });
            if (d.hp <= 0) {
              d.alive = false;
              d.group.visible = false;
              // A drone that dies falls: a short puff and a tumbling body.
              spawnSpark(d.position, d.ace ? 0xffb040 : 0xff7040, d.ace ? 2.6 : 1.8);
              events.push({
                type: 'kill',
                kind: 'drone',
                ace: d.ace === true,
                position: d.position.clone(),
              });
            }
            consumed = true;
            break;
          }
        }
      }
      if (consumed) slugs.splice(i, 1);
    }

    // --- Effects decay.
    for (let i = effects.length - 1; i >= 0; i -= 1) {
      const e = effects[i];
      e.life -= dt;
      if (e.life <= 0) {
        group.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.mesh.material.dispose();
        effects.splice(i, 1);
        continue;
      }
      const k = 1 - e.life / e.max;
      e.mesh.scale.setScalar(1 + k * (e.grow ?? 1.6));
      if (e.mesh.material.opacity !== undefined) e.mesh.material.opacity = (1 - k) * 0.85;
    }

    // --- The rocket pod: the seeker's solution and the live rounds, stepped after the guns so a
    // round launched this step is not also flown this step.
    ordnance = stepOrdnance(dt, aircraftState, controls);
    stepRockets(dt);
    // Rocket kills were collected during guidance; hand them to the step's event list now, and
    // clear the buffer so the next step cannot report the same kill twice.
    if (killed.length) {
      events.push(...killed);
      killed = [];
    }

    writeTracers();
    writeRockets();
    return events;
  }

  /** A small expanding puff of light, used for impacts and kills. */
  function spawnSpark(position, colour, size = 1.0) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1.1 * size, 6, 5),
      new THREE.MeshBasicMaterial({
        color: colour, transparent: true, opacity: 0.85, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    mesh.position.copy(position);
    group.add(mesh);
    effects.push({ mesh, life: 0.34, max: 0.34, grow: 2.4 * size });
  }

  /** Rebuilds the tracer instance buffers from the live round list. */
  function writeTracers() {
    const n = Math.min(bullets.length, TRACER_MAX);
    for (let i = 0; i < n; i += 1) {
      const b = bullets[i];
      tracerPos.copy(b.pos);
      dirVec.copy(b.vel).normalize();
      tracerQuat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dirVec);
      tracerMatrix.compose(tracerPos, tracerQuat, tracerScale);
      tracers.setMatrixAt(i, tracerMatrix);
    }
    tracers.count = n;
    tracers.instanceMatrix.needsUpdate = true;

    const m = Math.min(slugs.length, SLUG_MAX);
    for (let i = 0; i < m; i += 1) {
      const s = slugs[i];
      tracerPos.copy(s.pos);
      dirVec.copy(s.vel).normalize();
      tracerQuat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dirVec);
      tracerMatrix.compose(tracerPos, tracerQuat, tracerScale);
      slugsMesh.setMatrixAt(i, tracerMatrix);
    }
    slugsMesh.count = m;
    slugsMesh.instanceMatrix.needsUpdate = true;
  }

  let slugCooldown = 0;

  // --- The rocket pod. Four rounds, a seeker that needs the nose held on the target, and a
  // launch that leaves the rail with the aircraft's own velocity added to the motor's.
  const rockets = [];
  /**
   * Rounds fired this round, counted separately from the live list.
   *
   * The pod's ammunition cannot be derived from `rockets.length`: that list shrinks on impact and
   * expiry, which would hand the pilot a fresh magazine every time a round connected. This counter
   * only ever goes up.
   */
  let fired = 0;
  /** The seeker's current problem: which target, how long the nose has been on it. */
  let lock = { target: null, held: 0 };
  // Three vectors owned by the seeker, kept out of the shared scratch set so a lock calculation
  // cannot corrupt a firing solution elsewhere in the same step.
  const lockFwd = new THREE.Vector3();
  const lockScratch = new THREE.Vector3();
  // And three more for the guidance loop, for the same reason: a round's steering must not share a
  // buffer with the seeker that launched it, or a launch and a lock in the same step fight.
  const rocketAim = new THREE.Vector3();
  const rocketWant = new THREE.Vector3();
  const rocketCur = new THREE.Vector3();
  /**
   * Kills produced by rocket impacts during a step.
   *
   * `update` owns the step's event list, and the guidance loop runs inside it, so a rocket kill has
   * to be handed back through a buffer this scope owns rather than reaching for a local it cannot
   * see. Drained at the end of the step, in the same order the guns would have reported them.
   */
  let killed = [];
  // A lock is not a state the HUD can infer from the target list: it is the *seeker's* progress,
  // and it has to survive the frame where the target dies and be dropped cleanly.
  const ROCKET_MESH_MAX = 12;
  const rocketsMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.28, 0.28, 3.0, 6),
    new THREE.MeshStandardMaterial({
      color: 0xd8d2c4, roughness: 0.5, metalness: 0.4,
      emissive: 0xff7a20, emissiveIntensity: 0.6,
    }),
    ROCKET_MESH_MAX,
  );
  rocketsMesh.frustumCulled = false;
  rocketsMesh.count = 0;
  group.add(rocketsMesh);

  /**
   * The best lock candidate: the target closest to the nose that is inside the cone and in range.
   *
   * "Closest to the nose" rather than "closest to the aircraft" on purpose. A gun 400 m away and
   * sixty degrees off the nose is not a target; a gun 1200 m away and two degrees off is, and the
   * seeker should say so. Choosing by distance alone would make the weapon fight the pilot.
   */
  function findLockTarget(aircraftState) {
    // Deliberately its own vector, not the shared `tmp`: `consider` is handed a scratch vector for
    // each candidate, and reusing one buffer for the nose direction as well would overwrite the
    // direction on the first turret and then test every later candidate against the wrong cone.
    const fwd = lockFwd.set(
      Math.sin(aircraftState.heading) * Math.cos(aircraftState.pitch),
      Math.sin(aircraftState.pitch),
      -Math.cos(aircraftState.heading) * Math.cos(aircraftState.pitch),
    ).normalize();

    let best = null;
    let bestAngle = ORDNANCE.coneAngle;

    const consider = (pos, kind, ref, ace = false) => {
      const dx = pos.x - aircraftState.position.x;
      const dy = pos.y - aircraftState.position.y;
      const dz = pos.z - aircraftState.position.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > ORDNANCE.lockRange || dist < 60) return;
      const dot = (dx * fwd.x + dy * fwd.y + dz * fwd.z) / dist;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
      if (angle > bestAngle) return;
      bestAngle = angle;
      // Replaced wholesale rather than mutated: carrying `ace` across from a previous candidate
      // would label a wingman as the leader the moment a closer turret won the cone test.
      best = {
        position: new THREE.Vector3(pos.x, pos.y, pos.z),
        kind,
        ref,
        ace,
        angle,
      };
    };

    const scratch = lockScratch;
    for (const t of turrets) {
      if (!t.alive) continue;
      consider(scratch.set(t.x, t.y + 27, t.z), 'turret', t);
    }
    for (const d of drones) {
      if (!d.alive) continue;
      consider(d.position, 'drone', d, d.ace === true);
    }
    return best;
  }

  /**
   * Steps the seeker and fires if asked.
   *
   * Returns the lock state for the HUD, and whether a round left the rail this step. The lock
   * decays rather than resetting: losing the nose for a moment costs progress, which is what makes
   * a wobbling approach feel like a wobbling approach instead of a failure.
   */
  function stepOrdnance(dt, aircraftState, controls) {
    const want = controls?.launch === true && !aircraftState.destroyed;
    const candidate = findLockTarget(aircraftState);
    const same = candidate && lock.target === candidate.ref;

    if (candidate && (same || !lock.target)) {
      lock.target = candidate.ref;
      lock.kind = candidate.kind;
      lock.ace = candidate.ace === true;
      lock.held += dt;
    } else if (candidate && !same) {
      // A different machine inside the cone: start again on it rather than carrying progress
      // across, which is what would let a pilot sweep the nose and collect a lock for free.
      lock.target = candidate.ref;
      lock.kind = candidate.kind;
      lock.ace = candidate.ace === true;
      lock.held = 0;
    } else if (lock.target) {
      const stillUp = lock.kind === 'turret' ? lock.target.alive : lock.target.alive;
      if (!stillUp) { lock.target = null; lock.held = 0; }
      else {
        // It is still alive but out of the cone or out of range: the seeker coasts on what it had.
        lock.held = Math.max(0, lock.held - dt * 0.6);
      }
    }

    const locked = lock.target !== null && lock.held >= ORDNANCE.lockTime;

    let launched = false;
    if (want && locked && fired < ORDNANCE.count) {
      launchRocket(aircraftState, lock.target, lock.kind, lock.ace === true);
      fired += 1;
      launched = true;
      // A launch spends the lock: the seeker has to be flown onto the next target.
      lock = { target: null, held: 0 };
    }

    return {
      ...lockReadout(candidate, locked && !launched),
      fired: launched,
    };
  }

  function lockReadout(candidate, locked) {
    return {
      /** 0..1 progress toward a solution, for the HUD's growing ring. */
      progress: Math.min(1, lock.held / ORDNANCE.lockTime),
      locked: !!locked,
      hasTarget: lock.target !== null,
      kind: lock.kind ?? null,
      ace: lock.ace === true,
      range: candidate ? candidate.position.distanceTo(lastPos) : null,
      /** The pod's full complement, so the HUD can draw one pip per round without guessing. */
      count: ORDNANCE.count,
      remaining: ORDNANCE.count - fired,
      /** True when there is nothing left to shoot: the HUD greys the pod out. */
      empty: fired >= ORDNANCE.count,
    };
  }

  /** Puts a round on the rail and gives it the aircraft's velocity as well as the motor's. */
  function launchRocket(aircraftState, target, kind, ace) {
    const fwd = new THREE.Vector3(
      Math.sin(aircraftState.heading) * Math.cos(aircraftState.pitch),
      Math.sin(aircraftState.pitch),
      -Math.cos(aircraftState.heading) * Math.cos(aircraftState.pitch),
    );
    const side = new THREE.Vector3(
      Math.cos(aircraftState.heading), 0, Math.sin(aircraftState.heading),
    );
    // Alternate the rails so two launches read as two rounds, not one.
    const rail = rockets.length % 2 === 0 ? -1 : 1;
    const from = aircraftState.position.clone()
      .addScaledVector(fwd, 4)
      .addScaledVector(side, rail * 3.2);
    from.y -= 0.8;

    const vel = fwd.clone().multiplyScalar(ORDNANCE.speed);
    // The aircraft is already moving; the round leaves with that motion plus the motor. Without
    // this a launch at 120 m/s looks like the round stops dead relative to the aircraft.
    const aircraftSpeed = aircraftState.speed ?? 0;
    vel.x += Math.sin(aircraftState.heading) * aircraftSpeed;
    vel.z += -Math.cos(aircraftState.heading) * aircraftSpeed;

    rockets.push({
      pos: from,
      vel,
      life: ORDNANCE.life,
      target,
      kind,
      ace,
      /**
       * The speed this round tops out at.
       *
       * The motor adds to what the aircraft already gave it, so a launch at 220 m/s throws a round
       * that reaches 220 more than one launched at a standstill. Rescaling the velocity to a fixed
       * absolute figure instead — which is what `speed + 40` alone does — would erase the
       * aircraft's contribution one step after launch and make speed irrelevant to the weapon.
       */
      topSpeed: ORDNANCE.speed + 40 + aircraftSpeed,
      /** Set once the motor is out: after this the round only turns, it does not accelerate. */
      burned: 0,
    });
    spawnSpark(from, 0xffd090, 1.4);
  }

  /**
   * Flies the live rounds. Each one steers toward its target's current position with a bounded
   * turn, which is what makes a hard break a real defence and a straight run a certainty.
   */
  function stepRockets(dt) {
    for (let i = rockets.length - 1; i >= 0; i -= 1) {
      const r = rockets[i];
      r.life -= dt;
      if (r.life <= 0) { rockets.splice(i, 1); continue; }

      const t = r.target;
      const live = t && t.alive !== false;
      if (live) {
        // A turret is a place, a drone is a thing that moves: the seeker aims at the gun house for
        // one and at the airframe for the other.
        const tp = r.kind === 'turret'
          ? rocketAim.set(t.x, t.y + 27, t.z)
          : rocketAim.copy(t.position);
        const dist = r.pos.distanceTo(tp);
        // Beyond its seeker's reach the round stops guiding rather than turning for a target it
        // has lost: a missile that chases across the whole map is a missile the pilot cannot dodge.
        if (dist <= ORDNANCE.loseRange) {
          const want = rocketWant.copy(tp).sub(r.pos).normalize();
          const speed = r.vel.length() || 1;
          const cur = rocketCur.copy(r.vel).divideScalar(speed);
          const maxTurn = ORDNANCE.turnRate * dt;
          const angle = Math.acos(Math.max(-1, Math.min(1, cur.dot(want))));
          if (angle > 1e-4) {
            // Turn by at most what the fins allow this step; when the error is smaller than that,
            // snap rather than lerp, or the round spirals around a target it should have hit.
            const k = Math.min(1, maxTurn / angle);
            cur.lerp(want, k).normalize();
          }
          r.vel.copy(cur).multiplyScalar(speed);

          // Terminal: close enough that the next step would tunnel through the target.
          if (dist < ORDNANCE.seekRadius * 0.5) {
            impactRocket(r, tp.clone());
            rockets.splice(i, 1);
            continue;
          }
        }
      }

      // Motor: burns for its couple of seconds, then the round coasts and slowly falls.
      if (r.burned < ORDNANCE.burn) {
        r.burned += dt;
        const speed = r.vel.length();
        if (speed > 1) {
          // Thrust along the round's own axis, capped at the round's top speed for the speed it was
          // launched at. Adding speed rather than rescaling it to a constant is what keeps the
          // aircraft's own velocity meaningful: the motor is a boost, not a governor.
          const next = Math.min(r.topSpeed ?? ORDNANCE.speed + 40, speed + 150 * dt);
          r.vel.setLength(next);
        }
      } else {
        r.vel.y -= 9.8 * dt;
      }

      r.pos.addScaledVector(r.vel, dt);

      // Ground: a round that flies into the hill is gone, and it is gone where the pilot can see.
      if (r.pos.y < terrain.heightAt(r.pos.x, r.pos.z)) {
        spawnSpark(r.pos, 0xffb060, 1.6);
        rockets.splice(i, 1);
        continue;
      }

      // A target that died while the round was in the air leaves it with nothing to guide on.
      if (!t || t.alive === false) {
        if (r.burned > ORDNANCE.burn * 0.5) { rockets.splice(i, 1); continue; }
      }
    }
  }

  /** A rocket arriving: damage the target through the same path the guns use, and report it. */
  function impactRocket(r, at) {
    spawnSpark(at, 0xffd8a0, 3.2);
    const t = r.target;
    if (!t || t.alive === false) return;
    if (r.kind === 'turret') {
      t.hp -= ORDNANCE.damage;
      if (t.hp <= 0) {
        t.alive = false;
        t.head.visible = false;
        killed.push({ type: 'kill', kind: 'turret', position: new THREE.Vector3(t.x, t.y + 27, t.z) });
      }
    } else {
      t.hp -= ORDNANCE.damage;
      if (t.hp <= 0) {
        t.alive = false;
        t.group.visible = false;
        spawnSpark(t.position, t.ace ? 0xffb040 : 0xff7040, t.ace ? 2.6 : 1.8);
        killed.push({ type: 'kill', kind: 'drone', ace: t.ace === true, position: t.position.clone() });
      }
    }
  }

  /** Rebuilds the rocket instance buffer, one matrix per live round. */
  function writeRockets() {
    const n = Math.min(rockets.length, ROCKET_MESH_MAX);
    for (let i = 0; i < n; i += 1) {
      const r = rockets[i];
      tracerPos.copy(r.pos);
      dirVec.copy(r.vel).normalize();
      tracerQuat.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dirVec);
      tracerMatrix.compose(tracerPos, tracerQuat, tracerScale);
      rocketsMesh.setMatrixAt(i, tracerMatrix);
    }
    rocketsMesh.count = n;
    rocketsMesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * The aircraft's guns. Called by the game with the current controls; fires a pair of rounds down
   * the nose at a fixed rate. Short range and a slight cone, so it is a strafing tool, not a
   * death ray.
   */
  function fireGuns(dt, aircraftState, controls) {
    slugCooldown = Math.max(0, slugCooldown - dt);
    if (!controls.fire || slugCooldown > 0 || aircraftState.destroyed) return false;
    slugCooldown = 0.075;
    const fwd = new THREE.Vector3(
      Math.sin(aircraftState.heading) * Math.cos(aircraftState.pitch),
      Math.sin(aircraftState.pitch),
      -Math.cos(aircraftState.heading) * Math.cos(aircraftState.pitch),
    );
    for (const side of [-1, 1]) {
      const sideVec = new THREE.Vector3(
        Math.cos(aircraftState.heading), 0, Math.sin(aircraftState.heading),
      ).multiplyScalar(side * 2.4);
      const from = aircraftState.position.clone()
        .addScaledVector(fwd, 5.5)
        .add(sideVec);
      // A cone so the rounds do not stack into a single line of light.
      const dir = fwd.clone();
      dir.applyAxisAngle(upVec, (rng() - 0.5) * 0.010);
      dir.applyAxisAngle(new THREE.Vector3(0, 1, 0).cross(fwd).normalize(), (rng() - 0.5) * 0.010);
      slugs.push({
        pos: from,
        vel: dir.multiplyScalar(620),
        life: 1.5,
      });
    }
    return true;
  }

  let ordnance = null;

  /**
   * The seeker's readout, for the HUD and for the game's own launch bookkeeping.
   *
   * Exposed as a getter rather than folded into `status()` because the two are asked for at
   * different rates: the HUD redraws every frame, while `status()` walks the whole enemy list, and
   * the lock is already computed once per step inside `update`.
   */
  function ordnanceStatus() {
    return ordnance;
  }

  /** Live counts, for the HUD and for the debrief. */
  function status() {
    let turretsAlive = 0;
    for (const t of turrets) if (t.alive) turretsAlive += 1;
    let dronesAlive = 0;
    for (const d of drones) if (d.alive) dronesAlive += 1;
    return {
      turretsAlive,
      dronesAlive,
      turretsTotal: turrets.length,
      dronesTotal: drones.length,
      /** Per-slot alive flags, so the HUD's pips go dark in place rather than shifting. */
      turretSlots: turrets.map((t) => t.alive),
      droneSlots: drones.map((d) => d.alive),
      /** The nearest live threat, for the HUD's warning. */
      nearest: nearestThreat(),
      /**
       * The flight leader, if one is still in the air.
       *
       * Handed over as the live object rather than a copy of its numbers because the HUD has to
       * project it through the camera, and that projection belongs to the game, not to the enemy
       * list. Null when the leader is down, which is also how the bracket disappears.
       */
      ace: (() => {
        for (const d of drones) if (d.alive && d.ace) return d;
        return null;
      })(),
      /** How many rounds are in the air toward the aircraft. */
      incoming: bullets.length,
    };
  }

  function nearestThreat() {
    let best = Infinity;
    let kind = null;
    let at = null;
    for (const t of turrets) {
      if (!t.alive) continue;
      const d = Math.hypot(t.x - lastPos.x, t.z - lastPos.z);
      if (d < best) { best = d; kind = 'flak'; at = t; }
    }
    for (const d of drones) {
      if (!d.alive) continue;
      const dd = d.position.distanceTo(lastPos);
      if (dd < best) { best = dd; kind = 'drone'; at = d; }
    }
    if (!kind) return null;
    // The bearing is what the HUD needs to point a chevron at it: without a position the warning
    // could only say "something is close", which is not enough to turn the right way.
    const root = kind === 'flak' ? at.root.position : at.position;
    const bearing = Math.atan2(root.x - lastPos.x, -(root.z - lastPos.z));
    return {
      distance: best,
      kind,
      bearing,
      x: root.x,
      y: kind === 'flak' ? at.y + 27 : root.y,
      z: root.z,
    };
  }

  const lastPos = new THREE.Vector3();

  /** Called every step by the game before `update`, so the HUD's nearest-threat read is current. */
  function track(position) {
    lastPos.copy(position);
  }

  /** Removes everything this round put in the scene. */
  function dispose() {
    scene.remove(group);
    scene.remove(tracers);
    scene.remove(slugsMesh);
    tracers.geometry.dispose();
    tracers.material.dispose();
    slugsMesh.geometry.dispose();
    slugsMesh.material.dispose();
    group.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    });
    for (const e of effects) {
      e.mesh.geometry.dispose();
      e.mesh.material.dispose();
    }
  }

  return {
    update, fireGuns, status, dispose, track, ordnanceStatus,
    group,
    get turrets() { return turrets; },
    get drones() { return drones; },
    get bullets() { return bullets; },
    get slugs() { return slugs; },
    get rockets() { return rockets; },
  };
}
