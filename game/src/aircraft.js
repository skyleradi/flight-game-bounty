// The aircraft itself: a low-wing single-engine monoplane built from primitives, with a turning
// propeller, a canopy, control surfaces that move with the stick and a livery that belongs to this
// game alone. Built around +Z as forward, +Y up, +X to the aircraft's right.

import * as THREE from '../vendor/three.module.min.js';
import { AIRCRAFT, PALETTE } from './config.js';
import { buildFuselage, buildWingPanel } from './aircraft-shape.js';
import { enhanceHullMaterial } from './aircraft-livery.js';

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
    /** Afterburner charge, 0 to 1, and how far the burner has spooled up. */
    boost: 1,
    boostSpool: 0,
    /** Airspeed the wing is actually flying on, which is not the ground speed with wind in it. */
    airspeed: 0,
  };
}

/** Builds the aircraft model and returns the group plus the handles the animation turns. */
export function buildAircraft() {
  const group = new THREE.Group();
  group.name = 'aircraft';

  const hull = new THREE.MeshStandardMaterial({
    color: PALETTE.hull, roughness: 0.34, metalness: 0.52, envMapIntensity: 1.15,
  });
  // The livery's seams and staining are keyed off the fuselage's own frame — Z down the spine, a
  // metre of radius around it — so they only make sense on the body. The wings, rudder and
  // elevator keep the plain `hull` material: their local frames are chord/span, and the same
  // shader on them would draw seams across the span instead of around the barrel.
  const hullBody = hull.clone();
  enhanceHullMaterial(hullBody);
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
  const body = new THREE.Mesh(buildFuselage(fuselageProfile, 24), hullBody);
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
  // (nav lights are built at the end of the function, alongside the strobe and the beacon)
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
    // The wingtip nav lights are built with the rest of the lighting further down, so this loop
    // only builds structure. `halfSpan` is still needed for the aileron above.
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

  // --- The lights a pilot actually flies by.
  //
  // The old model had two nav lights and blinked them together, which is wrong in a way that is
  // obvious from outside: a real aircraft's red and green are *steady*, and it is the white strobe
  // on the tail and the beacon on the fin that flash. Blinking all of them turns the aircraft into
  // a Christmas tree and destroys the one thing nav lights are for — telling you which way the
  // aircraft is pointing at night.
  //
  // So: red left, green right, both steady, plus a white tail strobe and a red anti-collision
  // beacon, both double-flashing on the same 1.2 s cycle the real ones use. Materials are basic and
  // additive so they read as lights rather than as painted spheres, and each has a halo sprite so
  // it stays visible at range instead of shrinking to a sub-pixel dot.
  const haloTexture = (() => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();

  function makeLamp(hex, size, haloScale) {
    const mat = new THREE.MeshBasicMaterial({
      color: hex, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, toneMapped: false,
    });
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(size, 8, 6), mat);
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: haloTexture, color: hex, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.85, toneMapped: false,
    }));
    halo.scale.setScalar(haloScale);
    return { bulb, halo, mat, haloMat: halo.material };
  }

  // Steady nav lights, at the wingtips where the old ones were.
  const navLampL = makeLamp(0xff2b1f, 0.13, 2.0);
  navLampL.bulb.position.set(+2, -0.12, 1.10);
  navLampL.halo.position.copy(navLampL.bulb.position);
  group.add(navLampL.bulb, navLampL.halo);

  const navLampR = makeLamp(0x2bff6a, 0.13, 2.0);
  navLampR.bulb.position.set(-2, -0.12, 1.10);
  navLampR.halo.position.copy(navLampR.bulb.position);
  group.add(navLampR.bulb, navLampR.halo);

  // White tail strobe: two fast flashes then a pause, which is the pattern that reads as a strobe
  // rather than as a blinking light.
  const strobe = makeLamp(0xffffff, 0.10, 2.6);
  strobe.bulb.position.set(0, 0.42, -4.92);
  strobe.halo.position.copy(strobe.bulb.position);
  group.add(strobe.bulb, strobe.halo);

  // Red anti-collision beacon on the fin.
  const beacon = makeLamp(0xff3311, 0.11, 2.2);
  beacon.bulb.position.set(0, 0.36, -4.35);
  beacon.halo.position.copy(beacon.bulb.position);
  group.add(beacon.bulb, beacon.halo);

  // --- Exhaust stacks: two short pipes under the cowl. Unlit, they are almost invisible; when the
  // pilot is on the boost they show a hot glow, which is the only cue from a chase camera that the
  // engine is working hard.
  const exhaustMat = new THREE.MeshBasicMaterial({
    color: 0xff7722, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
    depthWrite: false, toneMapped: false,
  });
  for (const side of [-1, 1]) {
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.09, 0.34, 6), dark);
    pipe.rotation.x = Math.PI * 0.5;
    pipe.position.set(side * 0.52, -0.30, 3.95);
    group.add(pipe);
    const glow = new THREE.Mesh(new THREE.ConeGeometry(0.10, 0.55, 6), exhaustMat);
    glow.rotation.x = -Math.PI * 0.5;
    glow.position.set(side * 0.52, -0.30, 3.68);
    group.add(glow);
  }

  group.scale.setScalar(1.0);
  return {
    group, propHub, disc, ailerons, elevatorPivot, rudderPivot,
    lights: { navLampL, navLampR, strobe, beacon },
    exhaustMat,
    /**
     * The light show, as a function of time and how hard the engine is working.
     *
     * `boost` is 0..1: it lifts the exhaust glow from nothing to a visible cone and brightens the
     * strobe halo a little, so a pilot on the burner sees their own aircraft lit up.
     */
    update(time, boost = 0) {
      // Strobe and beacon: a 1.2 s cycle with two short flashes in the first fifth of it, which is
      // the standard double-flash transport pattern and reads at a glance as aviation lighting.
      const c = (time / 1.2) % 1;
      const flash = c < 0.06 || (c > 0.13 && c < 0.19);
      strobe.bulb.visible = flash;
      strobe.halo.visible = flash;
      beacon.bulb.visible = flash;
      beacon.halo.visible = flash;
      // Nav lights are steady, always. Their halo does breathe slightly with the boost because the
      // electrical bus is being loaded, which is a detail nobody will name but everybody sees.
      navLampL.halo.scale.setScalar(2.0 + boost * 0.25);
      navLampR.halo.scale.setScalar(2.0 + boost * 0.25);
      // Exhaust: scales with boost and never quite goes out, because an idling engine still glows.
      exhaustMat.opacity = 0.05 + boost * 0.85;
    },
  };
}
