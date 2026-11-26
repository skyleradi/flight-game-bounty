// The airfield at the mouth of the valley: a runway with its markings, taxiway, apron, hangars,
// a windsock and the approach masts. Everything is built from primitives at run time, so the
// ground the aircraft leaves from and lands on is part of the game's own code.

import * as THREE from '../vendor/three.module.min.js';
import { RUNWAY, PALETTE, RUNWAY as RW } from './config.js';

/** A group holding the whole airfield, positioned and rotated onto its heading. */
export function buildAirfield() {
  const field = new THREE.Group();
  field.name = 'airfield';
  field.position.set(RW.x, RW.elevation, RW.z);
  // The field's local +Z must run along the strip's take-off direction, which is
  // (sin h, 0, -cos h) in world space; a Y rotation of PI - h sends local +Z there.
  field.rotation.y = Math.PI - RW.heading;

  const asphalt = new THREE.MeshStandardMaterial({ color: PALETTE.runway, roughness: 0.88, metalness: 0.02 });
  const paint = new THREE.MeshStandardMaterial({ color: PALETTE.runwayLine, roughness: 0.7, metalness: 0 });
  const taxiMat = new THREE.MeshStandardMaterial({ color: PALETTE.taxiway, roughness: 0.9, metalness: 0.02 });
  const wall = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.8, metalness: 0.12 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x5b6167, roughness: 0.65, metalness: 0.3 });

  // Runway slab: a box just proud of the grass so it never z-fights the terrain.
  const strip = new THREE.Mesh(new THREE.BoxGeometry(RW.width, 0.5, RW.length), asphalt);
  strip.position.y = 0.25;
  strip.receiveShadow = true;
  field.add(strip);

  // Shoulders either side, a metre lower, so the edge is a visible lip.
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Mesh(new THREE.BoxGeometry(9, 0.28, RW.length), taxiMat);
    shoulder.position.set(side * (RW.width * 0.5 + 4.5), 0.14, 0);
    shoulder.receiveShadow = true;
    field.add(shoulder);
  }

  // Centreline dashes: 30 m of paint every 50 m, the way a real runway is marked.
  const dashGeo = new THREE.BoxGeometry(1.5, 0.06, 30);
  const dashCount = Math.floor(RW.length / 50);
  for (let i = 0; i < dashCount; i += 1) {
    const dash = new THREE.Mesh(dashGeo, paint);
    dash.position.set(0, 0.53, -RW.length * 0.5 + 25 + i * 50);
    field.add(dash);
  }

  // Threshold bars at each end, and the aiming blocks a pilot lines up on.
  for (const end of [-1, 1]) {
    for (let i = 0; i < 8; i += 1) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.06, 26), paint);
      bar.position.set(-RW.width * 0.42 + i * (RW.width * 0.84 / 7), 0.53, end * (RW.length * 0.5 - 18));
      field.add(bar);
    }
    const number = new THREE.Mesh(new THREE.BoxGeometry(7, 0.06, 15), paint);
    number.position.set(0, 0.53, end * (RW.length * 0.5 - 62));
    field.add(number);
  }

  // Edge lights: small warm posts down both sides, read as a lit runway at dusk.
  const lightGeo = new THREE.SphereGeometry(0.7, 6, 5);
  const lightMat = new THREE.MeshStandardMaterial({
    color: 0xfff0c0, emissive: 0xffd98a, emissiveIntensity: 2.4, roughness: 0.4,
  });
  for (let i = 0; i < 40; i += 1) {
    for (const side of [-1, 1]) {
      const lamp = new THREE.Mesh(lightGeo, lightMat);
      lamp.position.set(side * (RW.width * 0.5 + 2.2), 0.9, -RW.length * 0.5 + 20 + i * (RW.length - 40) / 39);
      field.add(lamp);
    }
  }

  // Taxiway from the runway to the apron, and the apron itself.
  const taxi = new THREE.Mesh(new THREE.BoxGeometry(20, 0.4, 200), taxiMat);
  taxi.position.set(-RW.width * 0.5 - 18, 0.2, -RW.length * 0.32);
  taxi.receiveShadow = true;
  field.add(taxi);

  const apron = new THREE.Mesh(new THREE.BoxGeometry(150, 0.4, 130), taxiMat);
  apron.position.set(-RW.width * 0.5 - 96, 0.2, -RW.length * 0.32 - 10);
  apron.receiveShadow = true;
  field.add(apron);

  // Two hangars on the apron: a box with a barrel roof, doors facing the taxiway.
  for (let i = 0; i < 2; i += 1) {
    const hangar = new THREE.Group();
    hangar.position.set(-RW.width * 0.5 - 96 + i * 0, -RW.length * 0.32 - 10 - 40 + i * 78 - 39, 0);
    hangar.position.set(-RW.width * 0.5 - 96, 0, -RW.length * 0.32 - 58 + i * 72);

    const body = new THREE.Mesh(new THREE.BoxGeometry(46, 15, 34), wall);
    body.position.y = 7.5;
    body.castShadow = true;
    body.receiveShadow = true;
    hangar.add(body);

    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(17, 17, 46, 14, 1, false, 0, Math.PI), roof);
    barrel.rotation.z = Math.PI / 2;
    barrel.rotation.y = Math.PI / 2;
    barrel.position.y = 15;
    barrel.castShadow = true;
    hangar.add(barrel);

    const door = new THREE.Mesh(new THREE.BoxGeometry(24, 12, 0.6), roof);
    door.position.set(0, 6, 17.2);
    hangar.add(door);
    field.add(hangar);
  }

  // A control tower: shaft, glass cab and a mast, off the apron's far corner.
  const tower = new THREE.Group();
  tower.position.set(-RW.width * 0.5 - 120, 0, -RW.length * 0.32 + 74);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 6.2, 26, 10), wall);
  shaft.position.y = 13;
  shaft.castShadow = true;
  tower.add(shaft);
  const cab = new THREE.Mesh(
    new THREE.CylinderGeometry(7.4, 6.6, 6.4, 10),
    new THREE.MeshStandardMaterial({ color: PALETTE.glass, roughness: 0.18, metalness: 0.55, transparent: true, opacity: 0.82 }),
  );
  cab.position.y = 29;
  cab.castShadow = true;
  tower.add(cab);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(7.8, 7.8, 1.1, 10), roof);
  cap.position.y = 32.8;
  tower.add(cap);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 9, 5), roof);
  mast.position.y = 37.5;
  tower.add(mast);
  const beacon = new THREE.Mesh(lightGeo, new THREE.MeshStandardMaterial({
    color: 0xff5a4a, emissive: 0xff3b28, emissiveIntensity: 3, roughness: 0.4,
  }));
  beacon.position.y = 42.2;
  tower.add(beacon);
  field.add(tower);

  // Windsock on a pole beside the threshold, its bag a cone that hangs downwind.
  const sockPole = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 11, 6), roof);
  sockPole.position.set(RW.width * 0.5 + 26, 5.5, -RW.length * 0.5 + 40);
  field.add(sockPole);
  const sock = new THREE.Mesh(
    new THREE.ConeGeometry(1.7, 8, 8, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xff8c2b, roughness: 0.85, side: THREE.DoubleSide }),
  );
  sock.position.set(RW.width * 0.5 + 26 + 4, 9.6, -RW.length * 0.5 + 40);
  sock.rotation.z = -Math.PI * 0.42;
  sock.rotation.y = 0.4;
  field.add(sock);

  return field;
}

/** Approach masts and a marker board on the centreline, so the runway reads from the air. */
export function buildApproachMarkers() {
  const group = new THREE.Group();
  group.name = 'approach';
  const postMat = new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.8 });
  for (let i = 0; i < 6; i += 1) {
    const dist = 130 + i * 95;
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(1.4, 4.5 + i * 0.4, 1.4), postMat);
      const x = RW.x + Math.sin(RW.heading) * dist + Math.cos(RW.heading) * side * 26;
      const z = RW.z + Math.cos(RW.heading) * dist - Math.sin(RW.heading) * side * 26;
      post.position.set(x, RW.elevation + 2, z);
      group.add(post);
    }
  }
  return group;
}
