// The aircraft itself: a low-wing single-engine monoplane built from primitives, with a turning
// propeller, a canopy, control surfaces that move with the stick and a livery that belongs to this
// game alone. Built around +Z as forward, +Y up, +X to the aircraft's right.

import * as THREE from '../vendor/three.module.min.js';
import { AIRCRAFT, PALETTE } from './config.js';
import { buildFuselage, buildWingPanel } from './aircraft-shape.js';

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

  // Fuselage: one body of revolution, nose to tail. The radius profile is the airframe's real
  // shape — widest just behind the cockpit, falling away to the fin — so the silhouette is a
  // continuous curve instead of three cylinders butted together, which is what gave the old model
  // its toy look. The cowling and the tail get their own lathes so the paint break falls on a
  // real seam rather than halfway along a tube.
  const fuselageProfile = [
    // z, radius
    [5.62, 0.10], [5.50, 0.30], [5.30, 0.47], [5.05, 0.60],
    [4.75, 0.70], [4.30, 0.80], [3.70, 0.88], [3.00, 0.94],
    [2.10, 0.98], [1.20, 0.99], [0.30, 0.97], [-0.60, 0.92],
    [-1.50, 0.83], [-2.40, 0.71], [-3.20, 0.57], [-3.90, 0.44],
    [-4.45, 0.33], [-4.85, 0.25], [-5.05, 0.19],
  ];
  const body = new THREE.Mesh(buildFuselage(fuselageProfile, 24), hull);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // The cowling: a separate lathe over the nose so the accent paint ends on the seam behind the
  // engine, the way a real cowl does.
  const cowlProfile = [
    [4.78, 0.72], [4.55, 0.79], [4.20, 0.85], [3.75, 0.91], [3.30, 0.95],
  ];
  const cowl = new THREE.Mesh(buildFuselage(cowlProfile, 24), accent);
  cowl.scale.setScalar(1.035);
  cowl.castShadow = true;
  group.add(cowl);

  const spinner = new THREE.Mesh(new THREE.ConeGeometry(0.44, 1.05, 16), dark);
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.z = 5.62;
  group.add(spinner);

  // Canopy: a half-capsule over the wing, its front edge raked forward and its rear faired into
  // the spine. Scaled and positioned off the fuselage radius so it sits on the hull, not floating.
  const canopy = new THREE.Mesh(
    new THREE.SphereGeometry(0.80, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), glass,
  );
  canopy.scale.set(0.90, 0.72, 1.95);
  canopy.position.set(0, 0.72, 0.55);
  group.add(canopy);
  // A frame hoop at the canopy's rear, which is what stops glass reading as a bubble.
  const canopyFrame = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.035, 6, 20, Math.PI), dark);
  canopyFrame.position.set(0, 0.74, -0.55);
  canopyFrame.scale.set(1.0, 0.80, 1.0);
  group.add(canopyFrame);

  // Wing: two extruded aerofoil panels, tapered, with washout and five degrees of dihedral. Each
  // is its own panel rather than one spar through the fuselage, because that is how the dihedral
  // and the root fillet stay honest on both sides.
  const halfSpan = AIRCRAFT.span * 0.5;
  const dihedral = 0.09;
  const ailerons = [];
  let navL = null;
  let navR = null;
  for (const side of [-1, 1]) {
    const panel = buildWingPanel({
      rootChord: 1.95,
      tipChord: 1.15,
      semispan: halfSpan,
      thickness: 1.0,
      twist: -0.045,
      sweep: 0.16,
      side,
    });
    const wing = new THREE.Mesh(panel, hull);
    // Placed through an explicit basis rather than a pile of Euler angles: the panel is extruded
    // with its chord along local X, thickness along Y and span along Z, and this says directly
    // where each of those ends up. Local X (leading edge at 0) goes to -Z, so the leading edge sits
    // forward and the trailing edge behind; local Z (span) goes to +X, outboard.
    wing.setRotationFromMatrix(new THREE.Matrix4().makeBasis(
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(1, 0, 0),
    ));
    // The dihedral is a roll in the parent frame, so it needs a wrapper: applied to the mesh it
    // would roll the section about its own span instead of tipping the tip up.
    const wingMount = new THREE.Group();
    wingMount.rotation.z = side * dihedral;
    wingMount.position.set(0, -0.10, 1.52);
    wing.castShadow = true;
    wing.receiveShadow = true;
    wingMount.add(wing);
    group.add(wingMount);

    // The aileron sits in the panel's own frame at the trailing edge outboard, as a flat plate.
    const aileronPivot = new THREE.Group();
    aileronPivot.position.set(side * (halfSpan * 0.62), -0.03, 1.42);
    const panelAil = new THREE.Mesh(
      new THREE.BoxGeometry(halfSpan * 0.52, 0.09, 0.46), accent,
    );
    panelAil.position.x = side * halfSpan * 0.26;
    aileronPivot.add(panelAil);
    group.add(aileronPivot);
    ailerons.push({ pivot: aileronPivot, side });

    // Nav light in the wingtip, on a small fairing.
    const lightMat = side > 0
      ? new THREE.MeshStandardMaterial({ color: 0xff2b1f, emissive: 0xff2b1f, emissiveIntensity: 4 })
      : new THREE.MeshStandardMaterial({ color: 0x2bff6a, emissive: 0x2bff6a, emissiveIntensity: 4 });
    const nav = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), lightMat);
    nav.position.set(side * (halfSpan + 0.06), -0.12, 1.10);
    group.add(nav);
    if (side > 0) navL = nav; else navR = nav;
  }

  // Horizontal stabiliser: the same aerofoil at a much smaller scale, so the tail is not a plank.
  const stab = new THREE.Mesh(
    buildWingPanel({ rootChord: 1.15, tipChord: 0.62, semispan: 2.20, thickness: 0.62, twist: 0, sweep: 0.10 }),
    hull,
  );
  stab.setRotationFromMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(1, 0, 0),
  ));
  stab.position.set(0, 0.30, -3.62);
  stab.castShadow = true;
  group.add(stab);

  // Fin: a swept vertical surface, built from the same section rotated into the vertical plane.
  const fin = new THREE.Mesh(
    buildWingPanel({ rootChord: 1.45, tipChord: 0.62, semispan: 1.72, thickness: 0.55, twist: 0, sweep: 0.46 }),
    accent,
  );
  // A vertical surface: the chord still runs fore-and-aft, but the span goes up. The thickness
  // axis lands on -X, which is only a mirror of the symmetric section, so it changes nothing.
  fin.setRotationFromMatrix(new THREE.Matrix4().makeBasis(
    new THREE.Vector3(0, 0, -1),
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, 0),
  ));
  fin.position.set(0, 0.62, -3.60);
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

  group.scale.setScalar(1.0);
  return { group, propHub, disc, ailerons, elevatorPivot, rudderPivot, navL, navR };
}
