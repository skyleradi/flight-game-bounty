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
import { ENEMY, RUNWAY } from './config.js';
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
 * An interceptor: a small delta drone with a pusher prop and a red eye. Built low and wide so it
 * reads as a machine hunting the aircraft rather than as another tree.
 */
function buildDrone() {
  const group = new THREE.Group();

  const skin = new THREE.MeshStandardMaterial({
    color: 0x4a4f56, roughness: 0.42, metalness: 0.68, flatShading: true, envMapIntensity: 1.1,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0xb03a30, roughness: 0.5, metalness: 0.3, flatShading: true,
  });
  const eye = new THREE.MeshBasicMaterial({ color: 0xff3826 });

  // A flattened delta body.
  const body = new THREE.Mesh(new THREE.ConeGeometry(2.2, 7.6, 4), skin);
  body.rotation.x = -Math.PI * 0.5;
  body.rotation.z = Math.PI * 0.25;
  body.scale.set(1, 0.55, 1);
  body.castShadow = true;
  group.add(body);

  // Winglets, swept back, so the silhouette is a chevron.
  for (const side of [-1, 1]) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.32, 1.7), skin);
    wing.position.set(side * 3.1, 0, 1.4);
    wing.rotation.z = side * 0.30;
    wing.rotation.y = side * -0.34;
    wing.castShadow = true;
    group.add(wing);
    // A red stripe on each wing tip: the single cue that says "not yours" at a distance.
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.36, 1.1), accent);
    stripe.position.set(side * 5.0, 0.02, 1.9);
    stripe.rotation.z = side * 0.30;
    stripe.rotation.y = side * -0.34;
    group.add(stripe);
  }

  // The eye: a glowing sensor in the nose, which is where the tracers come from.
  const lens = new THREE.Mesh(new THREE.SphereGeometry(0.62, 8, 6), eye);
  lens.position.set(0, 0.2, -3.8);
  group.add(lens);

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
  function placeDrones(count) {
    for (let i = 0; i < count; i += 1) {
      const along = 2000 + (i / Math.max(1, count)) * 2600 + rng() * 400;
      const lateral = (rng() * 2 - 1) * 900;
      const x = RUNWAY.x + Math.sin(RUNWAY.heading) * along + Math.cos(RUNWAY.heading) * lateral;
      const z = RUNWAY.z - Math.cos(RUNWAY.heading) * along + Math.sin(RUNWAY.heading) * lateral;
      const y = Math.max(terrain.heightAt(x, z) + 220, 380);
      const built = buildDrone();
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
      });
    }
  }

  placeTurrets(cfg.flak ?? 0);
  placeDrones(cfg.drones ?? 0);

  // One squad book per round, shared by every interceptor: it is what stops three of them from
  // stacking into a single gun. One ace per flight, so there is a leader worth fearing.
  const squad = createSquad(drones.length);
  const aceIndex = drones.length > 1 ? Math.floor(rng() * drones.length) : 0;
  drones.forEach((d, i) => {
    d.brain = createDogfight({
      seed: round.id * 3701 + i * 911 + 17,
      ace: i === aceIndex && drones.length > 1,
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
  function update(dt, aircraftState, sortieTime) {
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
            if (d.hp <= 0) {
              d.alive = false;
              d.group.visible = false;
              // A drone that dies falls: a short puff and a tumbling body.
              spawnSpark(d.position, 0xff7040, 1.8);
              events.push({ type: 'kill', kind: 'drone', position: d.position.clone() });
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

    writeTracers();
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
    update, fireGuns, status, dispose, track,
    group,
    get turrets() { return turrets; },
    get drones() { return drones; },
    get bullets() { return bullets; },
    get slugs() { return slugs; },
  };
}
