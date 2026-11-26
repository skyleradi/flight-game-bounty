// The land the sortie is flown over. A seeded value-noise field shapes a heightfield mesh in
// light bands, so the same seed always builds the same valley; a flat basin is cut for the
// airfield and the terrain blends back up into the hills around it. Everything here is plain
// arithmetic on typed arrays: no textures are loaded, every surface is shaded by the scene lights.

import * as THREE from '../vendor/three.module.min.js';
import { WORLD, RUNWAY, PALETTE } from './config.js';

/**
 * A small, fast, deterministic noise: three octaves of value noise sampled on a lattice, with a
 * smoothstep between lattice points. It is not gradient noise, but for land at this scale the
 * rounded ridges it makes read better than a pure Perlin field, and it costs a fraction as much.
 */
function makeNoise(seed) {
  const table = new Float32Array(1024);
  let state = seed >>> 0;
  for (let i = 0; i < table.length; i += 1) {
    // xorshift32, so the table is the same on every machine and every run.
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    table[i] = state / 4294967296;
  }
  const at = (x, y) => table[(((x * 73 + y * 151) % 1024) + 1024) % 1024];
  const smooth = (t) => t * t * (3 - 2 * t);

  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = at(xi, yi), b = at(xi + 1, yi), c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

/**
 * Carves a gorge into the land. The corridor is drawn in the runway's own frame, the same one the
 * course is laid out in, so the gates always end up between the walls.
 *
 * The floor is flat, the walls are cliffs: outside the floor the rock is lifted to a shelf and the
 * blend between the two runs over `wallRun` metres. The ends taper, so the gorge opens back into
 * the valley instead of stopping at a wall of nothing.
 */
function carveGorge(elevation, alongRaw, acrossRaw, gorge) {
  // `alongRaw` runs negative up the valley (see heightAt's basin maths), so the section is entered
  // as a negative span and mirrored here.
  const a = -alongRaw;
  if (a < gorge.from || a > gorge.to) return elevation;

  // A gentle wander, so the gorge is not a ruler-straight trench.
  const centre = gorge.center + Math.sin(a / gorge.wanderScale) * gorge.wander;
  const off = Math.abs(acrossRaw - centre);

  // Taper the walls down to nothing over the last stretch at each end, so the gorge opens back
  // into the valley rather than ending against a wall of nothing.
  const fadeIn = Math.min(1, (a - gorge.from) / gorge.taperIn);
  const fadeOut = Math.min(1, (gorge.to - a) / gorge.taperOut);
  const fade = Math.min(fadeIn, fadeOut);
  if (fade <= 0) return elevation;

  const floorY = RUNWAY.elevation + 8;
  const shelf = floorY + gorge.wallHeight * fade;

  if (off <= gorge.floorHalf) return floorY;

  const u = Math.min(1, (off - gorge.floorHalf) / gorge.wallRun);
  const k = u * u * (3 - 2 * u);
  // Outside the floor the land is at least the shelf, so the wall reads as a cliff and not as a
  // slope up the hillside it happens to be cut into.
  const outside = Math.max(elevation, shelf);
  return floorY + (outside - floorY) * k;
}

/** Height of the land at (x, z) in metres, the runway basin and any gorge included. */
function heightAt(noise, x, z, gorge = null) {
  // Ridged noise: 1 - |2n - 1| turns each octave's crests into sharp ridges, which is what makes
  // the far hills read as mountains instead of dunes.
  let h = 0;
  let amp = 1;
  let freq = 1 / 2600;
  let norm = 0;
  for (let octave = 0; octave < 5; octave += 1) {
    const n = noise(x * freq, z * freq);
    const ridged = 1 - Math.abs(2 * n - 1);
    h += ridged * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  h /= norm;

  // A broad bowl: the land rises away from the airfield in every direction, so the valley the
  // course runs up is enclosed by higher ground on both sides and the horizon is never flat.
  const dist = Math.hypot(x - RUNWAY.x, z - RUNWAY.z);
  const bowl = Math.min(1, Math.pow(dist / 3600, 0.85));
  let elevation = 26 + h * h * WORLD.peak * (0.35 + 0.65 * bowl);

  // The basin is an ellipse aligned with the runway, so the whole strip is flat ground: inside the
  // core it IS the airfield's elevation, and outside it blends up into the surrounding hills. The
  // core has to cover the runway's own half-length, or the thresholds end up buried in a hillside.
  // The ellipse is drawn out along the valley axis (the runway heading reversed), so the flat floor
  // continues up the course as a corridor between the ridges instead of ending in a round bowl.
  const dxr = x - RUNWAY.x;
  const dzr = z - RUNWAY.z;
  const rcos = Math.cos(-RUNWAY.heading);
  const rsin = Math.sin(-RUNWAY.heading);
  const alongRaw = dxr * rsin + dzr * rcos;
  const acrossRaw = dxr * rcos - dzr * rsin;
  // Up-valley (negative along, the way the course runs) the floor reaches much further out.
  const stretch = alongRaw < 0 ? 3.1 : 0.82;
  const along = alongRaw / stretch;
  const across = acrossRaw / 0.62;
  const radial = Math.hypot(along, across);
  const core = RUNWAY.length * 0.58;
  const edge = core + RUNWAY.basinRadius;
  const basin = Math.min(1, Math.max(0, (radial - core) / (edge - core)));
  const blend = basin * basin * (3 - 2 * basin);
  elevation = RUNWAY.elevation * (1 - blend) + elevation * blend;

  // Rivers: three channels cut where the noise crosses a threshold, their beds below sea level
  // in places so the water plane shows as lakes along the valley floor.
  const river = Math.abs(noise(x * 0.00042 + 11.3, z * 0.00042 - 7.1) - 0.5);
  if (river < 0.028 && radial > edge * 1.15) {
    const depth = (1 - river / 0.028) * 34;
    elevation -= depth;
  }

  // The gorge is cut last, so it cuts through the hills and the river alike.
  if (gorge) elevation = carveGorge(elevation, alongRaw, acrossRaw, gorge);

  return elevation;
}

/**
 * Colour of the land at a height and slope: grass, forest, rock, then snow on the peaks.
 *
 * `slope` arrives already normalised to 0..1 (see the caller), but the thresholds here are what
 * decide how much of the valley is bare rock. Cliffs need to start reading as rock early and
 * hard, or the wall of a gorge is a green slab; the snowline then sits above them.
 */
function shadeFor(elevation, slope) {
  const c = new THREE.Color();

  // How exposed the ground is: a cliff face is bare whatever its altitude.
  const bare = Math.min(1, Math.max(0, (slope - 0.42) / 0.3));

  if (elevation < RUNWAY.elevation + 4 && slope < 0.42) {
    // The valley floor: mown grass, turning to sand at the water's edge.
    c.setHex(elevation < 12 ? PALETTE.sand : PALETTE.grassLow);
  } else if (bare > 0) {
    // Steep ground shows rock whatever its height: this is what makes the cliffs read.
    c.setHex(PALETTE.rock);
    if (slope > 0.72) c.lerp(new THREE.Color(PALETTE.rockDark), Math.min(1, (slope - 0.72) / 0.22));
    // Above the treeline the rock is paler and drier, which gives the high faces a different
    // value from the ones down in the valley.
    if (elevation > 460) c.lerp(new THREE.Color(PALETTE.rockLight), Math.min(1, (elevation - 460) / 420) * 0.8);
  } else if (elevation > 820) {
    c.setHex(PALETTE.snow);
  } else if (elevation > 560) {
    const t = (elevation - 560) / 260;
    c.setHex(PALETTE.grassHigh).lerp(new THREE.Color(PALETTE.rockLight), t * 0.55);
  } else if (elevation > 220) {
    c.setHex(PALETTE.grassHigh).lerp(new THREE.Color(PALETTE.forest), (elevation - 220) / 340 * 0.75);
  } else {
    c.setHex(PALETTE.grassLow).lerp(new THREE.Color(PALETTE.grassHigh), 0.3);
  }

  // A little per-vertex variation, seeded off the position so it is stable between runs.
  const jitter = ((Math.sin(elevation * 12.9898) * 43758.5453) % 1) * 0.07 - 0.035;
  c.offsetHSL(0, 0, jitter);
  return c;
}

/**
 * Builds the terrain: one BufferGeometry of grid*grid quads, with per-vertex colours and normals
 * computed from the heightfield so the shading is the land's own shape.
 */
export function buildTerrain(round = null) {
  const noise = makeNoise(WORLD.seed);
  const gorge = round?.gorge ?? null;
  const n = WORLD.grid;
  const count = (n + 1) * (n + 1);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const step = WORLD.size / n;
  const half = WORLD.size * 0.5;

  const heights = new Float32Array(count);
  for (let iz = 0; iz <= n; iz += 1) {
    for (let ix = 0; ix <= n; ix += 1) {
      const i = iz * (n + 1) + ix;
      const x = -half + ix * step;
      const z = -half + iz * step;
      heights[i] = heightAt(noise, x, z, gorge);
      positions[i * 3] = x;
      positions[i * 3 + 1] = heights[i];
      positions[i * 3 + 2] = z;
    }
  }

  // Colours need the slope, which needs the neighbours, so it is a second pass.
  const colour = new THREE.Color();
  for (let iz = 0; iz <= n; iz += 1) {
    for (let ix = 0; ix <= n; ix += 1) {
      const i = iz * (n + 1) + ix;
      const hL = heights[iz * (n + 1) + Math.max(0, ix - 1)];
      const hR = heights[iz * (n + 1) + Math.min(n, ix + 1)];
      const hD = heights[Math.max(0, iz - 1) * (n + 1) + ix];
      const hU = heights[Math.min(n, iz + 1) * (n + 1) + ix];
      const slope = Math.min(1, Math.hypot(hR - hL, hU - hD) / (step * 2.2));
      const shade = shadeFor(heights[i], slope);
      colour.copy(shade);
      colors[i * 3] = colour.r;
      colors[i * 3 + 1] = colour.g;
      colors[i * 3 + 2] = colour.b;
    }
  }

  const indices = new Uint32Array(n * n * 6);
  let k = 0;
  for (let iz = 0; iz < n; iz += 1) {
    for (let ix = 0; ix < n; ix += 1) {
      const a = iz * (n + 1) + ix;
      const b = a + 1;
      const c = a + n + 1;
      const d = c + 1;
      indices[k++] = a; indices[k++] = c; indices[k++] = b;
      indices[k++] = b; indices[k++] = c; indices[k++] = d;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  // The material is unlit-by-texture but lit by the scene: vertex colours times the sun, which is
  // what gives the land its shape without any image map to load.
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    flatShading: false,
  });
  enhanceTerrainMaterial(material);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.name = 'terrain';
  return { mesh, heights, noise, heightAt: (x, z) => heightAt(noise, x, z, gorge), step, n };
}

/**
 * Pushes the terrain past "vertex-coloured carpet" and into ground with grain.
 *
 * The mesh only carries colour per vertex, so at 35 m a quad every slope is one flat wash of
 * green. Two things fix that in the fragment stage, both procedural and free of any image:
 *
 *  - **Albedo breakup.** Three octaves of value noise sampled in world metres, at patch, tuft and
 *    grain scale, tilt the vertex colour up and down. Grass reads as grass because it is never
 *    one value; rock reads as strata.
 *  - **Micro-relief.** The same noise's finite difference perturbs the shading normal, so the
 *    surface catches the sun in small highlights and shadows. This is what stops a lit slope from
 *    looking like painted card, and it holds up in a still frame because it is shading, not texture.
 *
 * Both are keyed off world position, so the pattern stays welded to the ground as the camera moves
 * and no seam appears at a tile edge. Rock is pushed harder than grass: cliffs want grain, meadows
 * want only a little.
 */
export function enhanceTerrainMaterial(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTerrainWorld;
        varying float vTerrainUp;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vTerrainUp = normalize(mat3(modelMatrix) * normal).y;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTerrainWorld;
        varying float vTerrainUp;

        // Value noise with a smoothstep lattice, matching the heightfield's own generator so the
        // ground's grain and the ground's shape feel like one material.
        float tHash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
        }
        float tNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
            mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }
        float tFbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += tNoise(p) * a;
            p *= 2.03;
            a *= 0.5;
          }
          return v;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 wp = vTerrainWorld.xz;

          // Patches of one grass against another, at roughly eighty metres across.
          float broad = tFbm(wp * 0.0125);
          // Tufts and scree, a metre or two across.
          float tuft = tFbm(wp * 0.42 + 31.7);
          // Fine grain: the scale that reads as surface, not as landscape.
          float grain = tNoise(wp * 2.6 + 11.3);

          // Rock and scree want the hard high-frequency band; grass wants the soft one.
          float rockness = clamp((0.62 - vTerrainUp) * 2.1, 0.0, 1.0);
          float detail = mix(broad * 0.62 + tuft * 0.38, broad * 0.34 + tuft * 0.3 + grain * 0.36, rockness);

          // Keep the mean where it was: only the spread changes, so the round's palette still rules.
          diffuseColor.rgb *= 0.72 + detail * 0.62;

          // A slow hue lean, moss-green in the hollows and dry straw on the ridges.
          float lean = tFbm(wp * 0.028 + 5.9) - 0.5;
          diffuseColor.rgb = mix(
            diffuseColor.rgb,
            diffuseColor.rgb * vec3(1.07, 1.02, 0.82),
            clamp(lean * 1.4 + 0.5, 0.0, 1.0) * 0.35 * (1.0 - rockness)
          );
        }`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        {
          // Finite-difference the same noise field for a relief normal: no texture fetch, and it
          // follows the ground's own colour breakup because it is the same field.
          vec2 wp = vTerrainWorld.xz;
          float delta = 0.85;
          float h0 = tFbm(wp * 0.55);
          float hx = tFbm((wp + vec2(delta, 0.0)) * 0.55);
          float hz = tFbm((wp + vec2(0.0, delta)) * 0.55);
          float rocknessN = clamp((0.62 - vTerrainUp) * 2.1, 0.0, 1.0);

          // Slope the relief along the world axes, then let the surface's own normal resolve it.
          vec3 relief = vec3((hx - h0), 0.0, (hz - h0)) * (1.5 + rocknessN * 4.2);
          normal = normalize(normal + relief);
        }`,
      );
  };
  // A shader edit needs a new program key, or three reuses the one it compiled before the edit.
  material.customProgramCacheKey = () => 'terrain-detail-v1';
  return material;
}

/** A water plane at sea level, so the river beds and low basins read as lakes. */
export function buildWater() {
  const geometry = new THREE.PlaneGeometry(WORLD.size * 1.6, WORLD.size * 1.6, 1, 1);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshStandardMaterial({
    color: PALETTE.water,
    roughness: 0.22,
    metalness: 0.35,
    transparent: true,
    opacity: 0.9,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 6;
  mesh.name = 'water';
  return mesh;
}

/**
 * Scatters low-poly conifers over the mid slopes. Each tree is a trunk and three stacked tiers of
 * canopy merged into one geometry, then placed with an InstancedMesh so a few thousand of them
 * cost one draw call.
 *
 * Three tiers rather than two is the difference between a cone-on-a-stick and a tree: the stacked
 * silhouette breaks up against the sky, and the underside of each tier falls into shadow, so a
 * mountain slope covered in them has texture of its own instead of reading as a printed pattern.
 * Each instance is also scaled and spun independently, so the rows never line up.
 */
export function buildForest(terrain) {
  const trunk = new THREE.CylinderGeometry(0.5, 0.8, 8, 6);
  trunk.translate(0, 4, 0);
  // Three canopy tiers, each smaller and set a little higher, with a slight random-lean baked in
  // so even a single tree is not perfectly symmetrical.
  const tierA = new THREE.ConeGeometry(5.0, 11, 8);
  tierA.translate(0, 11.5, 0);
  const tierB = new THREE.ConeGeometry(3.9, 10, 8);
  tierB.translate(0, 17.5, 0);
  const tierC = new THREE.ConeGeometry(2.6, 8.5, 8);
  tierC.translate(0.35, 22.5, 0.2);

  const merged = mergeGeometries([trunk, tierA, tierB, tierC]);
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.88, metalness: 0, flatShading: true,
  });
  paintByHeight(merged, PALETTE.forest, PALETTE.hullDark);

  const trees = [];
  const rng = makeRng(WORLD.seed ^ 0x9e37);
  const half = WORLD.size * 0.46;
  for (let tries = 0; tries < 90000 && trees.length < 9000; tries += 1) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    const dist = Math.hypot(x - RUNWAY.x, z - RUNWAY.z);
    if (dist < RUNWAY.basinRadius * 0.95) continue;
    const y = terrain.heightAt(x, z);
    if (y < 30 || y > 620) continue;
    // Slope test: no trees on the cliffs.
    const s = Math.abs(terrain.heightAt(x + 26, z) - y) + Math.abs(terrain.heightAt(x, z + 26) - y);
    if (s / 26 > 0.62) continue;
    trees.push([x, y - 1.2, z, 0.62 + rng() * 1.15, rng() * Math.PI * 2]);
  }

  const instanced = new THREE.InstancedMesh(merged, material, trees.length);
  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();
  trees.forEach(([x, y, z, size, spin], i) => {
    pos.set(x, y, z);
    quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin);
    scale.set(size, size * (0.85 + (i % 7) * 0.05), size);
    matrix.compose(pos, quat, scale);
    instanced.setMatrixAt(i, matrix);
  });
  instanced.instanceMatrix.needsUpdate = true;
  instanced.castShadow = true;
  instanced.receiveShadow = true;
  instanced.name = 'forest';
  return instanced;
}

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Merges geometries that share a layout (position, normal, uv) into one buffer, no library. */
function mergeGeometries(list) {
  const parts = list.map((g) => {
    const nonIndexed = g.index ? g.toNonIndexed() : g;
    return {
      position: nonIndexed.getAttribute('position').array,
      normal: nonIndexed.getAttribute('normal').array,
      uv: nonIndexed.getAttribute('uv')
        ? nonIndexed.getAttribute('uv').array
        : new Float32Array((nonIndexed.getAttribute('position').count) * 2),
    };
  });
  const total = parts.reduce((n, p) => n + p.position.length / 3, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let p = 0, u = 0;
  for (const part of parts) {
    position.set(part.position, p);
    normal.set(part.normal, p);
    uv.set(part.uv, u);
    p += part.position.length;
    u += part.uv.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** Colours a merged geometry by world height: the green canopy above the dark trunk. */
function paintByHeight(geometry, canopyHex, trunkHex) {
  const pos = geometry.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const canopy = new THREE.Color(canopyHex);
  const trunk = new THREE.Color(trunkHex);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    const y = pos.getY(i);
    if (y < 6.5) c.copy(trunk);
    else {
      // Slight tint per vertex, so the canopy is not one flat green.
      const t = Math.min(1, (y - 6.5) / 24);
      c.copy(trunk).lerp(canopy, Math.min(1, t * 1.9));
    }
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}
