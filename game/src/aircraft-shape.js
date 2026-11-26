import * as THREE from '../vendor/three.module.min.js';

/**
 * Airfoil section tables, in fractions of chord.
 *
 * A wing built from boxes reads as a plank because it *is* one: constant thickness, square
 * leading edge, no camber. The eye picks that up instantly in a still frame, more so than any
 * missing detail, because the silhouette is the thing that says "aeroplane". So the wing here is
 * an extruded section with a real NACA-style profile, and the tail surfaces use the same table.
 *
 * `NACA_2412` is the classic light-aircraft section: 2% camber, 12% thickness, benign stall —
 * which is exactly the sort of wing the aircraft in this game would have.
 */
const NACA_2412 = [
  // Upper surface, leading edge to trailing edge: [x/c, y/c].
  [0.0, 0.0], [0.008, 0.0158], [0.025, 0.0272], [0.05, 0.0379], [0.1, 0.0521],
  [0.2, 0.0658], [0.3, 0.0701], [0.4, 0.0682], [0.5, 0.0626], [0.6, 0.0544],
  [0.7, 0.0442], [0.8, 0.0326], [0.9, 0.0197], [0.95, 0.0128], [1.0, 0.0012],
];

/** The same section mirrored below the chord line, which is what makes it a lifting surface. */
const LOWER = NACA_2412.map(([x, y]) => [x, -y * 0.62]).reverse();

/**
 * Builds a wing panel: a tapered, twisted, dihedral aerofoil extruded from root to tip.
 *
 * `points` is the closed loop of the section in the X (chordwise) / Y (thickness) plane, and the
 * extrusion runs along +X in the panel's own space. The caller then places and rotates the panel,
 * which is what keeps the taper and dihedral arithmetic in one readable place instead of spread
 * through a chain of matrix multiplications.
 */
export function buildWingPanel({
  rootChord, tipChord, semispan, thickness = 1, twist = 0, sweep = 0, side = 1,
}) {
  const section = [...NACA_2412, ...LOWER];
  const ring = section.length;
  // Two rings are not enough for an aerofoil: the shading needs the camber curve, so the panel is
  // subdivided into spanwise stations, each interpolating chord, sweep and twist.
  const stations = 7;
  const positions = [];
  const indices = [];

  for (let s = 0; s < stations; s += 1) {
    const t = s / (stations - 1);
    const chord = rootChord + (tipChord - rootChord) * t;
    const xOffset = sweep * t;
    // Washout: the tip carries less angle of attack than the root, which is what stops a wing
    // stalling at the tip first and dropping a wingtip in a tight turn.
    const rot = twist * t;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    for (let i = 0; i < ring; i += 1) {
      const [cx, cy] = section[i];
      const px = cx * chord;
      const py = cy * chord * thickness;
      // Rotate the section about its own leading edge by the local twist.
      // The span runs along +Z, and `side` mirrors it here rather than through a negative scale:
      // scaling a group by -1 inverts the triangle winding, which turns the mesh inside out and
      // makes the far wing read as a flat plank lit from behind.
      positions.push(px * cos - py * sin + xOffset, px * sin + py * cos, side * t * semispan);
    }
  }

  for (let s = 0; s < stations - 1; s += 1) {
    for (let i = 0; i < ring; i += 1) {
      const j = (i + 1) % ring;
      const a = s * ring + i;
      const b = s * ring + j;
      const c = (s + 1) * ring + i;
      const d = (s + 1) * ring + j;
      // A mirrored panel needs its winding reversed to keep the faces pointing out.
      if (side >= 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, b, c, b, d, c);
    }
  }
  // Cap the tip so the panel is solid; the root is buried in the fuselage and needs no cap.
  const tipBase = (stations - 1) * ring;
  for (let i = 1; i < ring - 1; i += 1) {
    if (side >= 0) indices.push(tipBase, tipBase + i, tipBase + i + 1);
    else indices.push(tipBase, tipBase + i + 1, tipBase + i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * A body of revolution from a radius profile, which is how every fuselage is actually shaped:
 * a smooth taper from spinner to tail, widest at the cockpit, never a stack of cylinders.
 *
 * The profile is [z, radius] pairs running nose to tail. Lathe works around Y, so the result is
 * turned to lie along Z afterwards.
 */
export function buildFuselage(profile, segments = 20) {
  const points = profile.map(([z, r]) => new THREE.Vector2(Math.max(0.001, r), z));
  const geometry = new THREE.LatheGeometry(points, segments);
  geometry.rotateX(Math.PI / 2);
  // Lathe leaves the profile's own normals facing outward along Y before the rotation, and the
  // rotate does not fix them; recomputing gives the smooth shading the taper needs.
  geometry.computeVertexNormals();
  return geometry;
}
