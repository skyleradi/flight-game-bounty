// The cockpit the pilot sits in: a glare shield, an instrument panel with lit dials, a glass
// readout showing the live numbers, the canopy frame and the side coamings.
//
// Geometry is built in the aircraft root's own frame, whose forward is -Z (the same axis the
// cockpit camera looks down), so the panel sits at negative Z ahead of the eye and the seat is at
// the origin. Every dimension is chosen against the camera's 58-degree vertical field of view:
//
//   eye at (0, 0.58, 0); panel centre at (0, 0.22, -0.88)
//   → the eye-to-panel ray is atan(0.36 / 0.88) = 22.2° below the axis
//   → the panel is tilted by -0.39 rad (22.3°) so its face is square-on to that ray
//   → the panel's half-height 0.28 m at 0.95 m from the eye subtends 16.4°, so the face spans
//     5.8° to 38.6° below the axis, and the 29° half-field shows the upper 68% of it
//   → the dials are painted in the top 58% of the canvas, which is inside that band with margin
//
// Anything below 29° is off-screen, which is why the rudder pedals are modelled but never seen: the
// band the pilot can actually see is the panel and the canopy frame, exactly as in a real cockpit.

import * as THREE from '../vendor/three.module.min.js';
import { PALETTE } from './config.js';

const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** The eye's height above the seat, shared with the camera so the panel is framed for it. */
export const EYE_HEIGHT = 0.58;
/** The eye's distance behind the aircraft's origin, which is the panel's own reference point. */
export const EYE_Z = 0.0;
/** The panel's centre, in the aircraft's frame. */
export const PANEL = { y: 0.22, z: -0.88, width: 1.52, height: 0.56, tilt: -0.39 };

/**
 * Paints the instrument panel's face. The layout puts every dial inside the top 58% of the canvas,
 * because that is the part of the panel the pilot's 58-degree view actually shows.
 */
function paintPanel() {
  const w = 1024, h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');

  // A dark, slightly blue-grey panel, with a lighter wash along the top where the sky reflects.
  ctx.fillStyle = '#1b2127';
  ctx.fillRect(0, 0, w, h);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(84, 98, 108, 0.6)');
  grad.addColorStop(0.28, 'rgba(26, 31, 36, 0.12)');
  grad.addColorStop(1, 'rgba(6, 9, 12, 0.85)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Six instruments around a central glass panel, all inside the visible band.
  const dials = [
    { x: 128, y: 118, r: 62, label: 'AIRSPEED', kind: 'speed' },
    { x: 316, y: 118, r: 62, label: 'ATTITUDE', kind: 'adi' },
    { x: 708, y: 118, r: 62, label: 'ALTIMETER', kind: 'alt' },
    { x: 896, y: 118, r: 62, label: 'TURN', kind: 'turn' },
    { x: 128, y: 262, r: 54, label: 'VERT SPEED', kind: 'vsi' },
    { x: 896, y: 262, r: 54, label: 'HEADING', kind: 'hdg' },
  ];

  for (const d of dials) {
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r + 7, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0e11';
    ctx.fill();
    ctx.strokeStyle = '#4a545c';
    ctx.lineWidth = 2.4;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fillStyle = d.kind === 'adi' ? '#1b3a56' : '#070a0d';
    ctx.fill();

    if (d.kind === 'adi') {
      ctx.save();
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = '#3d7fb4';
      ctx.fillRect(d.x - d.r, d.y - d.r, d.r * 2, d.r);
      ctx.fillStyle = '#6b4b2c';
      ctx.fillRect(d.x - d.r, d.y, d.r * 2, d.r);
      ctx.strokeStyle = '#eef7ff';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(d.x - d.r, d.y);
      ctx.lineTo(d.x + d.r, d.y);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(238, 247, 255, 0.45)';
      ctx.lineWidth = 1.5;
      for (const dy of [-0.5, -0.26, 0.26, 0.5]) {
        const yy = d.y + dy * d.r;
        const half = Math.abs(dy) > 0.35 ? d.r * 0.28 : d.r * 0.16;
        ctx.beginPath();
        ctx.moveTo(d.x - half, yy);
        ctx.lineTo(d.x + half, yy);
        ctx.stroke();
      }
      ctx.restore();
      ctx.strokeStyle = '#ffc23d';
      ctx.lineWidth = 3.2;
      ctx.beginPath();
      ctx.moveTo(d.x - d.r * 0.46, d.y);
      ctx.lineTo(d.x - d.r * 0.15, d.y);
      ctx.lineTo(d.x, d.y + 8);
      ctx.lineTo(d.x + d.r * 0.15, d.y);
      ctx.lineTo(d.x + d.r * 0.46, d.y);
      ctx.stroke();
    } else {
      for (let i = 0; i < 11; i += 1) {
        const a = -Math.PI * 1.25 + (i / 10) * Math.PI * 1.5;
        const inner = d.r * (i % 5 === 0 ? 0.68 : 0.8);
        ctx.strokeStyle = i % 5 === 0 ? '#dceaf4' : '#6f7d88';
        ctx.lineWidth = i % 5 === 0 ? 2.4 : 1.3;
        ctx.beginPath();
        ctx.moveTo(d.x + Math.cos(a) * inner, d.y + Math.sin(a) * inner);
        ctx.lineTo(d.x + Math.cos(a) * d.r * 0.92, d.y + Math.sin(a) * d.r * 0.92);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(208, 228, 240, 0.75)';
      ctx.font = `600 11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < 5; i += 1) {
        const a = -Math.PI * 1.25 + (i / 4) * Math.PI * 1.5;
        ctx.fillText(String(i * 2), d.x + Math.cos(a) * d.r * 0.52, d.y + Math.sin(a) * d.r * 0.52);
      }
      const needleA = -Math.PI * 1.25 + Math.PI * 1.5 * 0.7;
      ctx.strokeStyle = '#f0f6ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(d.x - Math.cos(needleA) * d.r * 0.16, d.y - Math.sin(needleA) * d.r * 0.16);
      ctx.lineTo(d.x + Math.cos(needleA) * d.r * 0.74, d.y + Math.sin(needleA) * d.r * 0.74);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(d.x, d.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#c8d6e0';
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(186, 210, 224, 0.8)';
    ctx.font = `600 12.5px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(d.label, d.x, d.y + d.r + 18);

    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r * 0.94, Math.PI * 1.15, Math.PI * 1.82);
    ctx.strokeStyle = 'rgba(200, 230, 245, 0.12)';
    ctx.lineWidth = 5;
    ctx.stroke();
  }

  // The bezel for the glass readout that sits between the dials. The readout itself is a separate
  // small canvas the game repaints with the live numbers, so this is just its frame.
  ctx.fillStyle = '#05080a';
  ctx.beginPath();
  ctx.roundRect(414, 56, 196, 214, 8);
  ctx.fill();
  ctx.strokeStyle = '#3d474e';
  ctx.lineWidth = 2.4;
  ctx.stroke();

  // Warning lights along the panel's lower band.
  const lights = [
    { x: 250, y: 348, label: 'FUEL', colour: '#ffb347' },
    { x: 400, y: 348, label: 'OIL', colour: '#ff6a4a' },
    { x: 550, y: 348, label: 'GEAR', colour: '#5fe0a0' },
    { x: 700, y: 348, label: 'STALL', colour: '#ff4a3a' },
  ];
  for (const l of lights) {
    ctx.fillStyle = 'rgba(9, 12, 15, 0.9)';
    ctx.beginPath();
    ctx.roundRect(l.x - 62, l.y - 20, 124, 40, 6);
    ctx.fill();
    ctx.strokeStyle = 'rgba(92, 106, 116, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = l.colour;
    ctx.beginPath();
    ctx.arc(l.x - 38, l.y, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(212, 234, 246, 0.88)';
    ctx.font = `600 14px ${FONT}`;
    ctx.textAlign = 'left';
    ctx.fillText(l.label, l.x - 18, l.y + 5);
  }

  // The placard: the game's own name, not any real aircraft's.
  ctx.fillStyle = 'rgba(150, 180, 200, 0.45)';
  ctx.font = `700 16px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.fillText('RIDGE RUNNER  ·  RR-1', 512, 288);

  // Switch rows along the panel's bottom edge, the part just outside the view.
  for (let i = 0; i < 14; i += 1) {
    const x = 88 + i * 62;
    ctx.fillStyle = 'rgba(64, 78, 88, 0.85)';
    ctx.beginPath();
    ctx.roundRect(x, 398, 30, 44, 4);
    ctx.fill();
    ctx.fillStyle = i % 3 === 0 ? 'rgba(255, 190, 110, 0.85)' : 'rgba(130, 160, 180, 0.45)';
    ctx.fillRect(x + 11, 406, 8, 15);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/**
 * The glass readout: a small canvas the game repaints with the live numbers, so the panel in the
 * cockpit view shows the aircraft's actual speed, altitude, heading, fuel and score rather than
 * painted-on needles that never move.
 */
function makeReadout() {
  const w = 256, h = 288;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;

  const state = { last: 0 };

  function paint(d) {
    ctx.fillStyle = '#04120f';
    ctx.fillRect(0, 0, w, h);

    // A faint scanline wash, so the panel reads as a display rather than a painted card.
    ctx.fillStyle = 'rgba(60, 220, 180, 0.045)';
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);

    const line = (label, value, y, size = 21, colour = 'rgba(150, 250, 216, 1)') => {
      ctx.fillStyle = 'rgba(110, 190, 170, 0.75)';
      ctx.font = `600 9.5px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 10, y - 9);
      ctx.fillStyle = colour;
      ctx.font = `700 ${size}px ${FONT}`;
      ctx.textAlign = 'right';
      ctx.fillText(value, w - 10, y + 3);
    };

    line('SPD KTS', String(Math.round(d.speed)).padStart(3, ' '), 22);
    line('ALT FT', String(Math.round(d.altitude)), 56);
    line('V/S FPM', `${d.climb > 0 ? '+' : ''}${Math.round(d.climb / 10) * 10}`, 90,
      18, d.climb < -700 ? 'rgba(255, 170, 130, 1)' : 'rgba(150, 250, 216, 1)');
    line('HDG', `${String(Math.round(((d.heading % 360) + 360) % 360)).padStart(3, '0')}°`, 124);

    ctx.strokeStyle = 'rgba(110, 190, 170, 0.3)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(10, 142);
    ctx.lineTo(w - 10, 142);
    ctx.stroke();

    line('FUEL', `${Math.round(d.fuel * 100)}%`, 160, 19,
      d.fuel < 0.18 ? 'rgba(255, 150, 110, 1)' : 'rgba(255, 220, 150, 1)');
    line('AIRFRAME', `${Math.round(d.health * 100)}%`, 194, 19,
      d.health < 0.35 ? 'rgba(255, 130, 100, 1)' : 'rgba(150, 220, 250, 1)');
    line('FLAPS', d.flaps <= 0 ? 'UP' : d.flaps >= 2 ? 'FULL' : 'HALF', 228, 19,
      d.flaps > 0 ? 'rgba(255, 220, 150, 1)' : 'rgba(140, 200, 220, 1)');

    ctx.strokeStyle = 'rgba(110, 190, 170, 0.3)';
    ctx.beginPath();
    ctx.moveTo(10, 246);
    ctx.lineTo(w - 10, 246);
    ctx.stroke();

    line('GATES', `${d.gatesPassed}/${d.gatesTotal}`, 264, 18);
    line('SCORE', String(Math.round(d.score)), 284, 18, 'rgba(255, 226, 150, 1)');

    texture.needsUpdate = true;
  }

  return { canvas, texture, paint, state };
}

/** A tube between two points, so the canopy frame is placed by its ends rather than by angles. */
function strut(from, to, radius, material) {
  const a = new THREE.Vector3(...from);
  const b = new THREE.Vector3(...to);
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(radius, radius, len, 8);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.copy(mid);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  return mesh;
}

/**
 * The cockpit group, built around the seat at the origin with forward along -Z. It is parented to
 * the aircraft root and shown only in the cockpit view.
 *
 * Returns the group plus `updateReadout(d)`, which repaints the glass panel with live numbers at a
 * sensible rate rather than every frame.
 */
export function buildCockpit() {
  const group = new THREE.Group();
  group.name = 'cockpit';
  group.visible = false;

  const panelTexture = paintPanel();
  const panelMat = new THREE.MeshStandardMaterial({
    map: panelTexture,
    emissiveMap: panelTexture,
    emissive: 0xffffff,
    emissiveIntensity: 0.5,
    roughness: 0.62,
    metalness: 0.14,
  });
  const bodyMat = new THREE.MeshStandardMaterial({
    color: PALETTE.hullDark, roughness: 0.76, metalness: 0.2,
  });
  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x2f353d, roughness: 0.5, metalness: 0.46,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0x13181c, roughness: 0.9, metalness: 0.05,
  });

  // The instrument panel: a slab across the cockpit, tilted so its face looks back at the eye.
  // Material index 4 is a box's +Z face, which is the one turned toward the pilot.
  const panel = new THREE.Mesh(
    new THREE.BoxGeometry(PANEL.width, PANEL.height, 0.08),
    [bodyMat, bodyMat, bodyMat, bodyMat, panelMat, bodyMat],
  );
  panel.position.set(0, PANEL.y, PANEL.z);
  panel.rotation.x = PANEL.tilt;
  group.add(panel);

  // The live glass readout, sitting in the bezel painted into the panel. It is a child of the panel
  // so it inherits the tilt and stays exactly in its frame.
  const readout = makeReadout();
  const readoutMat = new THREE.MeshBasicMaterial({ map: readout.texture, toneMapped: false });
  const readoutMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.26, 0.293), readoutMat);
  readoutMesh.position.set(0, 0.052, 0.043);
  readoutMesh.renderOrder = 2;
  panel.add(readoutMesh);

  // The glare shield over the panel's top edge: it stops the sky showing through behind the dials,
  // which is what makes the bottom of the view read as an aircraft rather than a floating slab.
  const shield = new THREE.Mesh(new THREE.BoxGeometry(1.68, 0.05, 0.3), trimMat);
  shield.position.set(0, 0.44, -0.86);
  shield.rotation.x = -0.11;
  group.add(shield);

  // Side coamings: the trim that runs back from the panel either side of the pilot's knees. At the
  // frame's edges, which is exactly where a cockpit's interior shows in a 58-degree view.
  for (const side of [-1, 1]) {
    const coaming = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.46, 0.9), bodyMat);
    coaming.position.set(side * 0.74, 0.02, -0.62);
    coaming.rotation.z = side * 0.15;
    group.add(coaming);

    const console = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.2, 0.5), trimMat);
    console.position.set(side * 0.7, -0.28, -0.46);
    group.add(console);

    // The A-pillar: from the glare shield's corner up and back to the canopy bow.
    group.add(strut([side * 0.66, 0.42, -0.99], [side * 0.42, 0.9, -0.5], 0.028, frameMat));
  }

  // The canopy bow across the top, joining the pillars just inside the top of the frame: 0.32 m
  // above the eye at 0.5 m is 32.6°, which is at the edge of the field and reads as a frame.
  group.add(strut([-0.42, 0.9, -0.5], [0.42, 0.9, -0.5], 0.028, frameMat));
  // A centre post in the windscreen, so the glass reads as panes rather than open air.
  group.add(strut([0, 0.44, -0.99], [0, 0.895, -0.505], 0.013, frameMat));

  // The magnetic compass on the panel's top edge, where a real one sits.
  const compass = new THREE.Mesh(
    new THREE.SphereGeometry(0.042, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x0a0e11, roughness: 0.25, metalness: 0.3 }),
  );
  compass.position.set(0, 0.475, -0.9);
  group.add(compass);

  // A dim warm flood light so the panel is legible against a bright sky, the way a real cockpit's
  // post lights keep the dials readable at noon.
  const glow = new THREE.PointLight(0xffb08a, 0.85, 2.6);
  glow.position.set(0, 0.52, -0.72);
  group.add(glow);

  let lastPaint = -1;

  return {
    group,
    /**
     * Repaints the glass panel with the live numbers, at about 8 Hz: faster than the eye reads,
     * slower than the frame rate, so the texture upload costs nothing worth measuring.
     */
    updateReadout(d, time) {
      if (time - lastPaint < 0.125) return;
      lastPaint = time;
      readout.paint(d);
    },
    readout,
  };
}
