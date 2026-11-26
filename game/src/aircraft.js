// The aircraft itself: a low-wing single-engine monoplane built from primitives, with a turning
// propeller, a canopy, control surfaces that move with the stick and a livery that belongs to this
// game alone. Built around +Z as forward, +Y up, +X to the aircraft's right.

import * as THREE from '../vendor/three.module.min.js';
import { AIRCRAFT, PALETTE } from './config.js';

/**
 * The flight model's own state lives beside the model: the renderer only reads it. Angles are
 * radians, speeds metres per second, y in metres above sea level.
 */
export function createAircraftState() {
  return {
    position: new THREE.Vector3(),
    // heading: 0 points along -Z (north). Positive turns right, the way a compass reads.
    heading: 0,
    pitch: 0,
    bank: 0,
    speed: 0,
    /** Vertical speed in m/s, tracked separately so the HUD's needle is honest. */
    climb: 0,
    throttle: 0,
    fuel: AIRCRAFT.fuel,
    health: AIRCRAFT.health,
    onGround: true,
    /** True while the wheels are on the runway: the ground steering and brakes act then. */
    wheelsDown: true,
    /** Seconds since the last touchdown, so the wheels-up rule can be forgiving at the start. */
    sinceTakeoff: 0,
    /** Set once the airframe is destroyed: the model stops flying and the sortie ends. */
    destroyed: false,
  };
}

/** Builds the aircraft model and returns the group plus the handles the animation turns. */
export function buildAircraft() {
  const group = new THREE.Group();
  group.name = 'aircraft';

  const hull = new THREE.MeshStandardMaterial({
    color: PALETTE.hull, roughness: 0.34, metalness: 0.52, envMapIntensity: 1.15,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: PALETTE.hullAccent, roughness: 0.36, metalness: 0.42, envMapIntensity: 1.05,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: PALETTE.hullDark, roughness: 0.46, metalness: 0.58, envMapIntensity: 1.1,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: PALETTE.glass, roughness: 0.05, metalness: 0.92, transparent: true, opacity: 0.62,
    envMapIntensity: 1.5,
  });
  const propMat = new THREE.MeshStandardMaterial({
    color: PALETTE.propeller, roughness: 0.44, metalness: 0.5, envMapIntensity: 1.0,
  });

  // Fuselage: a lathe profile would be smoother, but a tapered cylinder plus a nose cone and a
  // tail cone gives the same read for a fraction of the vertices.
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.98, 0.82, 6.4, 14), hull);
  body.rotation.x = Math.PI / 2;
  body.position.z = 0.2;
  body.castShadow = true;
  group.add(body);

  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.52, 1.5, 14), accent);
  nose.rotation.x = Math.PI / 2;
  nose.position.z = 4.15;
  nose.castShadow = true;
  group.add(nose);

  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.1, 12), dark);
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.z = 5.45;
  group.add(spinner);

  // Tail cone tapering to the fin.
  const tailCone = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.3, 2.6, 12), hull);
  tailCone.rotation.x = Math.PI / 2;
  tailCone.position.z = -4.1;
  tailCone.castShadow = true;
  group.add(tailCone);

  // Canopy: a half-capsule over the wing, its front edge raked forward.
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.86, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
  canopy.scale.set(0.92, 0.78, 1.85);
  canopy.position.set(0, 0.82, 0.45);
  group.add(canopy);

  // Wing: one box, tapered by scaling the tips through two trapezoans either side.
  const wingRoot = new THREE.Mesh(new THREE.BoxGeometry(AIRCRAFT.span, 0.26, 1.85), hull);
  wingRoot.position.set(0, 0.1, 0.5);
  wingRoot.castShadow = true;
  group.add(wingRoot);

  // Dihedral tips, so the wing is not a flat plank in the chase view.
  for (const side of [-1, 1]) {
    const tip = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.2, 1.5), accent);
    tip.position.set(side * (AIRCRAFT.span * 0.5 + 0.85), 0.24, 0.5);
    tip.rotation.z = side * -0.14;
    tip.castShadow = true;
    group.add(tip);
  }

  // Horizontal stabiliser and the fin.
  const stab = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.18, 1.15), hull);
  stab.position.set(0, 0.35, -4.5);
  stab.castShadow = true;
  group.add(stab);

  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.9, 1.5), accent);
  fin.position.set(0, 1.1, -4.55);
  fin.rotation.x = -0.12;
  fin.castShadow = true;
  group.add(fin);

  // Rudder, hinged at the fin's trailing edge.
  const rudderPivot = new THREE.Group();
  rudderPivot.position.set(0, 1.1, -5.28);
  const rudder = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.7, 0.7), hull);
  rudder.position.z = 0.35;
  rudderPivot.add(rudder);
  group.add(rudderPivot);

  // Elevator, hinged on the stabiliser.
  const elevatorPivot = new THREE.Group();
  elevatorPivot.position.set(0, 0.35, -5.05);
  const elevator = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.14, 0.62), hull);
  elevator.position.z = 0.31;
  elevatorPivot.add(elevator);
  group.add(elevatorPivot);

  // Ailerons: small slabs at each wing's trailing edge, moving opposite ways.
  const ailerons = [];
  for (const side of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(side * 3.4, 0.1, 1.42);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.14, 0.5), accent);
    panel.position.z = 0.25;
    pivot.add(panel);
    group.add(pivot);
    ailerons.push({ pivot, side });
  }

  // Propeller: a disc plus three blades, the disc fading in as the revs rise.
  const propHub = new THREE.Group();
  propHub.position.z = 5.9;
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.26, 3.5, 0.09), propMat);
  for (let i = 0; i < 3; i += 1) {
    const b = blade.clone();
    b.rotation.z = (i * Math.PI * 2) / 3;
    b.castShadow = true;
    propHub.add(b);
  }
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(1.78, 24),
    new THREE.MeshBasicMaterial({ color: 0xdfe6ea, transparent: true, opacity: 0.0, side: THREE.DoubleSide, depthWrite: false }),
  );
  propHub.add(disc);
  group.add(propHub);

  // Undercarriage: two main legs and a tail wheel, so the aircraft sits on the runway.
  const legMat = dark;
  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.15, 6), legMat);
    leg.position.set(side * 1.5, -0.85, 0.9);
    leg.rotation.z = side * 0.16;
    group.add(leg);
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 12), legMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * 1.62, -1.4, 0.9);
    wheel.castShadow = true;
    group.add(wheel);
  }
  const tailWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.2, 10), legMat);
  tailWheel.rotation.z = Math.PI / 2;
  tailWheel.position.set(0, -0.72, -4.3);
  group.add(tailWheel);

  // Nav lights: red left, green right, white on the tail, so the wing reads at distance.
  // Port is red and starboard green. The model is built nose-along +Z and then turned half a turn
  // into the flight frame, so the wing that ends up on the pilot's left is the one at +X here.
  const navL = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5),
    new THREE.MeshStandardMaterial({ color: 0xff2b1f, emissive: 0xff2b1f, emissiveIntensity: 4 }));
  navL.position.set(AIRCRAFT.span * 0.5 + 0.4, 0.24, 0.5);
  group.add(navL);
  const navR = new THREE.Mesh(new THREE.SphereGeometry(0.16, 6, 5),
    new THREE.MeshStandardMaterial({ color: 0x2bff6a, emissive: 0x2bff6a, emissiveIntensity: 4 }));
  navR.position.set(-AIRCRAFT.span * 0.5 - 0.4, 0.24, 0.5);
  group.add(navR);

  group.scale.setScalar(1.0);
  return { group, propHub, disc, ailerons, elevatorPivot, rudderPivot, navL, navR };
}
