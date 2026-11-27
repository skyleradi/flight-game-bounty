import * as THREE from '../vendor/three.module.min.js';
import { WORLD, PALETTE } from './config.js';

/**
 * The coast, and the sea behind it.
 *
 * The world had a water plane and no water: the heightfield's lowest point is 11 m and the plane
 * sits at 6 m, so it was buried everywhere and the harbour's breakwater ran out into dry grass. Two
 * things fix that, and they have to be done in this order:
 *
 *  1. **Carve the land.** `coastAt()` is the shoreline, a gentle curve down the +X side of the map,
 *     and `carveCoast()` is spliced into the terrain's height function so the ground actually falls
 *     below sea level on the seaward side. The +X side is chosen because every gate of every sortie
 *     lives between x = -1800 and x = -640: the course never sees the coast, so the carve cannot
 *     move a gate or a ridge on the racing line.
 *  2. **Build water that moves.** A flat plane with a painted-on water colour reads as tinted glass.
 *     The surface here is a displaced grid: two crossing wave trains plus a swell, evaluated in the
 *     vertex shader and differentiated in the fragment shader for the normal, so the sun glints off
 *     real slopes instead of a uniform sheen.
 *
 * The carve is a smooth blend rather than a cut, because a hard edge shows as a cliff of triangles
 * along the shoreline at the one place the player is guaranteed to look.
 */

/**
 * The shoreline's x for a given z.
 *
 * Two sine terms of different wavelength, so the coast is a bay and a headland rather than a ruled
 * line. Kept far from the course and off the map edge: at the extremes it sits near x = 2400, which
 * leaves 2 km of sea before the world ends.
 */
export function coastAt(z) {
  return 2380 + 230 * Math.sin(z * 0.00034) + 140 * Math.sin(z * 0.00091 + 1.2);
}

/** How far inland the coastal plain reaches, in metres. */
const PLAIN = 1500;

/**
 * Applies the sea to a land elevation. Returns the new elevation.
 *
 * The first version dropped the land to the waterline over a 320 m shelf. With peaks of 560 m within
 * 400 m of the shore that is a 60-degree cliff, and it made the harbour impossible: every candidate
 * site measured a 300 m fall across its own footprint. A coast is not a wall, so what is built here
 * is a **coastal plain**: from `PLAIN` metres inland the ground is eased down to a low, gently
 * falling bench, and only the last few hundred metres become beach.
 *
 * The three zones:
 *   - inland of `shore - PLAIN`: untouched.
 *   - the plain: blended from the land's own height to a bench that falls from 26 m to 6 m.
 *   - seaward of the shoreline: the floor keeps dropping to -34 m over 700 m, so the water is deep
 *     enough for a hull a few hundred metres out.
 */
export function carveCoast(elevation, x, z) {
  const shore = coastAt(z);

  // --- The plain.
  const t = (x - (shore - PLAIN)) / PLAIN;
  if (t > 0) {
    const k = Math.min(1, t);
    // The bench the land is pulled toward: 26 m at the inland edge, 6 m at the waterline. Linear,
    // because a plain with a curve in it reads as a bowl.
    const bench = 26 - 20 * k;
    // Blend hard only past the halfway point: the inland edge of the plain has to meet the hills
    // without a visible seam, and the seaward half has to be genuinely flat for the harbour.
    const w = Math.min(1, Math.max(0, (k - 0.18) / 0.42));
    const blend = w * w * (3 - 2 * w);
    elevation = elevation * (1 - blend) + bench * blend;
    // Micro-relief on the flat part, so the plain is not a billiard table under the runway lighting.
    // Scaled by the same blend, so it fades out before it can ripple the hills.
    if (blend > 0.02) {
      const grain = Math.sin(x * 0.0091 + 1.7) * Math.cos(z * 0.0077 - 0.4)
        + Math.sin(x * 0.021 + z * 0.019) * 0.5;
      elevation += grain * 2.4 * blend;
    }
  }
  if (x <= shore) return elevation;

  // --- The sea floor. `beach` is whatever the shore ended at, so a headland still runs out into
  // deeper water than a bay does.
  const out = (x - shore) / 700;
  if (out <= 0) return elevation;
  const d = Math.min(1, out);
  const deep = d * d * (3 - 2 * d);
  return elevation * (1 - deep) + -34 * deep;
}

/**
 * The moving sea surface.
 *
 * `detail` sets the grid: 220 segments over 10.8 km is a vertex every 49 m, which sounds coarse and
 * is deliberate — the wave trains have wavelengths of 90 m and up, so they are sampled properly,
 * and the fine chop is carried by the normal map in the fragment shader instead of by geometry. A
 * grid dense enough to resolve 5 m chop would be a million vertices for something the eye reads
 * from 400 m up.
 */
export function buildSea({ detail = 220, size = WORLD.size * 1.2 } = {}) {
  const geometry = new THREE.PlaneGeometry(size, size, detail, detail);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshStandardMaterial({
    color: new THREE.Color(PALETTE.water).multiplyScalar(0.72),
    roughness: 0.14,
    metalness: 0.28,
    transparent: true,
    opacity: 0.94,
  });

  // Uniforms shared by both stages. `uTime` is the whole animation; `uSunDir` is re-aimed by the
  // day cycle so the glitter follows the sun and dies at night.
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.3).normalize() },
    uSunColor: { value: new THREE.Color(0xfff3dd) },
    uLight: { value: 1 },
    uShallow: { value: new THREE.Color(PALETTE.water).lerp(new THREE.Color('#4f9fb0'), 0.55) },
    uDeep: { value: new THREE.Color('#0b2437') },
  };

  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof previous === 'function') previous(shader, renderer);
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        varying vec3 vSeaWorld;
        varying float vSeaWave;

        // Three travelling waves. Each is a sine of (direction . position - speed * time), so they
        // move without any per-frame CPU work and stay in phase across the whole surface — a sea
        // built from per-vertex noise would shimmer as the camera turns.
        float seaHeight(vec2 p) {
          float h = 0.0;
          h += sin(dot(p, vec2(0.86, 0.51)) * 0.0690 - uTime * 1.05) * 3.1;
          h += sin(dot(p, vec2(-0.42, 0.91)) * 0.1130 - uTime * 1.62) * 1.7;
          h += sin(dot(p, vec2(0.60, -0.80)) * 0.2010 - uTime * 2.30) * 0.85;
          return h;
        }`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 seaWorld = modelMatrix * vec4(transformed, 1.0);
        float seaY = seaHeight(seaWorld.xz);
        transformed.y += seaY;
        vSeaWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vSeaWave = seaY;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform float uTime;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        uniform float uLight;
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        varying vec3 vSeaWorld;
        varying float vSeaWave;

        float seaHeightF(vec2 p) {
          float h = 0.0;
          h += sin(dot(p, vec2(0.86, 0.51)) * 0.0690 - uTime * 1.05) * 3.1;
          h += sin(dot(p, vec2(-0.42, 0.91)) * 0.1130 - uTime * 1.62) * 1.7;
          h += sin(dot(p, vec2(0.60, -0.80)) * 0.2010 - uTime * 2.30) * 0.85;
          return h;
        }

        // The analytic normal of the three waves, plus a two-octave ripple that is too fine to be
        // geometry at this grid spacing but is what gives the surface its texture at close range.
        vec3 seaNormal(vec2 p) {
          float e = 2.0;
          float hx = seaHeightF(p + vec2(e, 0.0)) - seaHeightF(p - vec2(e, 0.0));
          float hz = seaHeightF(p + vec2(0.0, e)) - seaHeightF(p - vec2(0.0, e));
          // Ripple: a cheap high-frequency perturbation of the slope, faded in with distance so it
          // does not alias into noise on the horizon.
          float d = length(p - cameraPosition.xz);
          float fade = 1.0 - smoothstep(900.0, 4200.0, d);
          float r1 = sin(p.x * 0.071 + uTime * 2.1) * cos(p.y * 0.063 - uTime * 1.7);
          float r2 = sin(p.x * 0.171 - uTime * 3.3) * cos(p.y * 0.149 + uTime * 2.6);
          hx += (r1 * 0.9 + r2 * 0.35) * fade;
          hz += (r1 * 0.75 - r2 * 0.4) * fade;
          return normalize(vec3(-hx / (2.0 * e), 1.0, -hz / (2.0 * e)));
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        // Depth tint: shallow water over the shelf is green-blue and the deep is near-black, which
        // is what makes a coastline read as a coastline from the air.
        float depthMix = smoothstep(6.0, 120.0, vSeaWorld.y * -1.0 + 12.0);
        diffuseColor.rgb = mix(uShallow, uDeep, clamp(depthMix, 0.0, 1.0));`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        // The displaced grid only carries the big swell; the wave normal carries the shape. This
        // replaces the interpolated normal entirely, because a smooth-normal plane has no visible
        // wave structure no matter how far the vertices move.
        normal = normalize((viewMatrix * vec4(seaNormal(vSeaWorld.xz), 0.0)).xyz);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // Sun glitter: a tight specular lobe on the wave normal, plus a broad sheen. Without this
        // the sea at dawn is a flat blue sheet even with the sun directly in frame.
        vec3 seaN = seaNormal(vSeaWorld.xz);
        vec3 seaV = normalize(cameraPosition - vSeaWorld);
        vec3 seaH = normalize(uSunDir + seaV);
        float spec = pow(max(dot(seaN, seaH), 0.0), 220.0);
        float sheen = pow(max(dot(seaN, seaH), 0.0), 14.0) * 0.16;
        totalEmissiveRadiance += uSunColor * (spec * 1.9 + sheen) * uLight;
        // Foam: the crests of the swell go white where the wave is highest, which is what sells the
        // motion at a glance better than the displacement does.
        float crest = smoothstep(3.2, 5.4, vSeaWave);
        totalEmissiveRadiance += vec3(0.82, 0.90, 0.94) * crest * 0.30 * uLight;`,
      );

    material.userData.shader = shader;
  };
  material.customProgramCacheKey = () => 'sea-v1';

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 6;
  mesh.name = 'sea';
  mesh.receiveShadow = false;

  return {
    mesh,
    /** True where the ground is below the waterline, so the caller can put a boat there. */
    isWater(x, z, heightAt) {
      return heightAt(x, z) < 6 - 1.2;
    },
    update(dt, { sunDirection = null, sunColor = null, light = 1 } = {}) {
      uniforms.uTime.value += dt;
      if (sunDirection) uniforms.uSunDir.value.copy(sunDirection).normalize();
      if (sunColor) uniforms.uSunColor.value.set(sunColor);
      uniforms.uLight.value = light;
    },
  };
}

/**
 * A cargo ship: hull, deckhouse, containers, and a bow wave.
 *
 * Built from boxes and merged into one geometry with per-vertex colour, so a whole ship is one draw
 * call. The shape is what matters at the distance a pilot sees it from: a long low hull, a tall
 * house aft, and a stack of containers forward of it — the silhouette is recognisable from 2 km,
 * which a more detailed model at this poly count would not be.
 */
export function buildShip({ length = 92, beam = 15, x = 0, z = 0, heading = 0, load = 1 }) {
  const parts = [];
  const push = (geo, hex) => {
    const colour = new THREE.Color(hex);
    const count = geo.attributes.position.count;
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      arr[i * 3] = colour.r;
      arr[i * 3 + 1] = colour.g;
      arr[i * 3 + 2] = colour.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    parts.push(geo);
  };
  const box = (w, h, d, px, py, pz) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(px, py, pz);
    return g;
  };

  const hullHex = '#3b4a54';
  const boot = '#8c2f2a';

  // Hull: two boxes, the lower one slightly narrower, so the waterline reads as a step.
  push(box(beam, 5.2, length, 0, 2.0, 0), hullHex);
  push(box(beam - 1.6, 2.0, length - 3, 0, -0.9, 0), boot);

  // Forecastle and a raised bow, because a flat-topped box looks like a barge.
  push(box(beam - 1.2, 2.4, 9, 0, 5.6, -length * 0.5 + 4.5), '#4a5a64');

  // Deckhouse aft, three tiers stepping in.
  const houseZ = length * 0.30;
  push(box(beam - 3.4, 3.6, 11, 0, 7.4, houseZ), '#d8d6ce');
  push(box(beam - 5.0, 3.0, 8.4, 0, 10.9, houseZ), '#e2e0d8');
  push(box(3.4, 2.2, 4.2, 0, 13.4, houseZ + 2.0), '#e8e6de');
  // Funnel.
  push(box(2.6, 5.0, 3.0, 0, 15.4, houseZ - 2.0), '#20262c');
  // Bridge wing windows: one dark band each side of the top tier.
  push(box(beam - 4.6, 1.0, 0.3, 0, 11.4, houseZ + 4.2), '#22303a');

  // Containers: a stack forward of the house, in block colours. `load` scales how many are carried,
  // so an empty ship and a full one are the same function.
  const lanes = 4;
  const bays = Math.round(7 * load);
  const colours = ['#b6522f', '#2f6a9b', '#c9a227', '#4e7a44', '#8b8f96', '#a8443f', '#356b78'];
  for (let b = 0; b < bays; b += 1) {
    const tiers = 1 + ((b * 7 + 3) % 3);
    for (let l = 0; l < lanes; l += 1) {
      for (let t = 0; t < tiers; t += 1) {
        const px = (l - (lanes - 1) / 2) * 3.1;
        const pz = -length * 0.10 - b * 6.6;
        const hex = colours[(b * 3 + l + t) % colours.length];
        push(box(2.9, 2.5, 5.9, px, 6.4 + t * 2.62, pz), hex);
      }
    }
  }
  // Masts.
  push(box(0.5, 7.0, 0.5, 0, 9.6, -length * 0.5 + 7.0), '#6a7078');
  push(box(0.5, 6.0, 0.5, 0, 13.6, houseZ - 3.4), '#6a7078');

  // Bow wave: a flat wedge on the water, opaque enough to read as broken water.
  const wave = new THREE.BufferGeometry();
  const L = length * 0.5;
  const verts = new Float32Array([
    -2, 0, -L - 16, 2, 0, -L - 16, -6, 0, -L + 4,
    2, 0, -L - 16, 6, 0, -L + 4, -6, 0, -L + 4,
    -5, 0, L - 6, 5, 0, L - 6, -9, 0, L + 20,
    5, 0, L - 6, 9, 0, L + 20, -9, 0, L + 20,
  ]);
  wave.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  wave.computeVertexNormals();
  push(wave, '#cfe0e6');

  // Merge every part into one buffer.
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const idx = [];
  let offset = 0;
  for (const g of parts) {
    const gp = g.attributes.position.array;
    const gc = g.attributes.color.array;
    pos.set(gp, offset * 3);
    col.set(gc, offset * 3);
    const gi = g.index ? g.index.array : null;
    if (gi) for (let i = 0; i < gi.length; i += 1) idx.push(gi[i] + offset);
    else for (let i = 0; i < g.attributes.position.count; i += 1) idx.push(i + offset);
    offset += g.attributes.position.count;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  merged.setIndex(idx);
  merged.computeVertexNormals();

  const mesh = new THREE.Mesh(
    merged,
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.74, metalness: 0.14 }),
  );
  mesh.position.set(x, 6, z);
  mesh.rotation.y = -heading;
  mesh.name = 'ship';
  return mesh;
}

/**
 * Places a small fleet in the water the carve actually created.
 *
 * Ships are not dropped at hand-written coordinates: the caller passes `heightAt` and each candidate
 * is tested with `isWater`, so a change to the coastline cannot leave a freighter parked on a hill.
 * Anchored ones face into the wind, moving ones are strung along a channel.
 */
export function buildFleet(heightAt, { count = 7, seed = 4711, near = null } = {}) {
  const group = new THREE.Group();
  group.name = 'fleet';
  let s = seed >>> 0;
  const rnd = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };

  const ships = [];
  const place = (x, z, { anchored, minGap }) => {
    if (Math.abs(x) > WORLD.size * 0.49) return false;
    if (!(heightAt(x, z) < 3)) return false;
    if (ships.some((p) => Math.hypot(p.x - x, p.z - z) < minGap)) return false;
    const ship = buildShip({
      length: 62 + rnd() * 74,
      beam: 12 + rnd() * 7,
      x, z,
      heading: anchored ? rnd() * Math.PI * 2 : Math.PI * 0.5 + (rnd() - 0.5) * 1.1,
      load: 0.35 + rnd() * 0.65,
    });
    ship.userData.anchor = { x, z };
    ship.userData.drift = anchored ? 0 : 5 + rnd() * 7;
    ship.userData.phase = rnd() * Math.PI * 2;
    group.add(ship);
    ships.push({ x, z, ship, anchored });
    return true;
  };

  // --- The harbour watch first. Two hulls lying off the quay is what makes a port read as working
  // rather than as a concrete apron with cranes on it; placed relative to the harbour so they follow
  // it if the coastline shifts.
  if (near) {
    for (let i = 0; i < 24 && ships.length < 3; i += 1) {
      const off = 420 + i * 55 + rnd() * 120;
      const along = (rnd() - 0.5) * 900;
      place(near.x + off, near.z + along, { anchored: true, minGap: 260 });
    }
  }

  // --- Then the open water: coasters and one underway, scattered down the shoreline.
  let guard = 0;
  while (ships.length < count && guard < 500) {
    guard += 1;
    const z = (rnd() - 0.5) * WORLD.size * 0.82;
    const shore = coastAt(z);
    // Between 500 m and 2.6 km offshore: close enough to be seen, far enough that none of them sits
    // in the surf where the carve is still shallow.
    const x = shore + 500 + rnd() * 2100;
    place(x, z, { anchored: rnd() < 0.55, minGap: 420 });
  }

  return {
    group,
    ships,
    /** Bobs each hull on the same wave function the shader uses, so the water and the boat agree. */
    update(dt, time) {
      for (const s2 of ships) {
        const p = s2.ship.position;
        if (!s2.anchored) {
          // A slow run down the channel, wrapped inside the sea band.
          p.z += s2.ship.userData.drift * dt;
          const shore = coastAt(p.z);
          if (p.z > WORLD.size * 0.45 || p.z < -WORLD.size * 0.45) {
            p.z = -WORLD.size * 0.45;
            p.x = shore + 600 + (s2.ship.userData.phase * 300) % 1800;
          }
        }
        // Heave and roll from the same three sine trains. The amplitudes are small — a 90 m hull
        // does not pitch like a dinghy — but they stop the fleet reading as decals.
        const t = time + s2.ship.userData.phase;
        const h = Math.sin(t * 1.05) * 0.55 + Math.sin(t * 1.62 + 1.1) * 0.3;
        s2.ship.position.y = 6 + h * 0.5;
        s2.ship.rotation.z = Math.sin(t * 1.05 + 0.6) * 0.012;
        s2.ship.rotation.x = Math.sin(t * 1.62) * 0.008;
      }
    },
  };
}

/**
 * Shore foam: a band of translucent white that hugs the waterline.
 *
 * The terrain shader cannot know where the water is, so the foam is its own ribbon: for each z the
 * shoreline's x is known, so a strip is laid from just inland to just offshore and faded out from
 * the middle. It is the one detail that makes a coast look like a coast rather than like a height
 * field that happens to end under a plane.
 */
export function buildShoreFoam({ rows = 180, width = 46 } = {}) {
  const positions = [];
  const alphas = [];
  const indices = [];
  const zMin = -WORLD.size * 0.48;
  const zMax = WORLD.size * 0.48;
  const step = (zMax - zMin) / rows;

  for (let i = 0; i <= rows; i += 1) {
    const z = zMin + i * step;
    const shore = coastAt(z);
    // Four points across the band: inland edge, two mid, offshore edge. The alpha peaks at the
    // middle and falls to zero at both edges, so no hard boundary is visible.
    const offsets = [-width * 0.5, -width * 0.16, width * 0.16, width * 0.5];
    const alpha = [0, 0.75, 0.62, 0];
    for (let k = 0; k < 4; k += 1) {
      positions.push(shore + offsets[k], 6.35 + k * 0.02, z);
      alphas.push(alpha[k]);
    }
  }
  for (let i = 0; i < rows; i += 1) {
    for (let k = 0; k < 3; k += 1) {
      const a = i * 4 + k;
      const b = a + 1;
      const c = a + 4;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('aAlpha', new THREE.Float32BufferAttribute(alphas, 1));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const material = new THREE.MeshBasicMaterial({
    color: 0xdfeef2, transparent: true, opacity: 0.55, depthWrite: false,
  });
  // Fade the band by the per-vertex alpha the strip was built with.
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vAlpha;');
  };
  material.customProgramCacheKey = () => 'shore-foam-v1';

  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'shore-foam';
  mesh.renderOrder = 2;
  return mesh;
}
