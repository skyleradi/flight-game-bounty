// The land the sortie is flown over. A seeded value-noise field shapes a heightfield mesh in
// light bands, so the same seed always builds the same valley; a flat basin is cut for the
// airfield and the terrain blends back up into the hills around it. Everything here is plain
// arithmetic on typed arrays: no textures are loaded, every surface is shaded by the scene lights.

import * as THREE from '../vendor/three.module.min.js';
import { WORLD, RUNWAY, PALETTE } from './config.js';

/**
 * A small, fast, deterministic noise: octaves of value noise sampled on a lattice, with a
 * smoothstep between lattice points.
 *
 * The lattice hash matters more than the octave count. The obvious way to index a shuffled table —
 * `(x * 73 + y * 151) % 1024` — is a *linear* combination, so every lattice point at
 * `(x + 151k, y - 73k)` reads the same entry. The result is not random at all: it is a set of
 * diagonal streaks running across the whole valley at a fixed angle, which is exactly the banding
 * that makes procedural land look like brushed metal instead of rock. A proper integer hash (two
 * multiplications and two xor-shifts, mixed per axis) has no such invariant, and the same octave
 * count then produces genuinely irregular ridges.
 */
function makeNoise(seed) {
  // A 32-bit integer hash with good avalanche. Constants are the usual murmur3 finaliser.
  function hash(ix, iy) {
    let h = (ix * 0x27d4eb2d) ^ (iy * 0x165667b1) ^ seed;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const smooth = (t) => t * t * t * (t * (t * 6 - 15) + 10);

  return function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = hash(xi, yi), b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
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

/**
 * Height of the land at (x, z) in metres, the runway basin and any gorge included.
 *
 * Three things make this read as a mountain range rather than as a field of dunes:
 *
 *  - **Domain warping.** The sample point is displaced by a slow noise before the ridge noise is
 *    read, so ridgelines wander, braid and sometimes terminate instead of running as parallel
 *    corrugations across the whole valley. This is the single biggest difference between noise
 *    that looks like land and noise that looks like noise.
 *  - **Ridged multifractal.** 1 - |2n - 1| turns each octave's crests into sharp ridges; the
 *    octaves are weighted by the previous one's value so detail settles into the hollows and the
 *    crests stay clean, which is what real erosion does.
 *  - **A stratified detail wash.** A final, low-amplitude octave at ~180 m breaks the big slopes
 *    into benches and gullies. Without it a 1 km face is one smooth ramp no matter how many
 *    polygons it is made of.
 */
function heightAt(noise, x, z, gorge = null) {
  // Domain warp: two independent slow fields push the sample point around by up to ~340 m. The
  // warp is applied to the ridge sampling only, so the basin and the rivers below stay put.
  const wx = (noise(x * 0.000155 + 41.7, z * 0.000155 - 18.3) - 0.5) * 680;
  const wz = (noise(x * 0.000148 - 27.1, z * 0.000148 + 53.9) - 0.5) * 680;
  const sx = x + wx;
  const sz = z + wz;

  let h = 0;
  let amp = 1;
  let freq = 1 / 2600;
  let norm = 0;
  // `carve` is the previous octave's ridged value: it weights the next octave so detail is spent
  // where there is already a slope to carry it.
  let carve = 1;
  for (let octave = 0; octave < 7; octave += 1) {
    const n = noise(sx * freq, sz * freq);
    const ridged = 1 - Math.abs(2 * n - 1);
    // Octaves 0-4 build the massif, weighted by `carve`. The last two are a detail wash rather
    // than more ridges: full-weight ridged noise at 40 m corrugates every slope.
    const weight = octave < 5 ? amp * (0.55 + 0.45 * carve) : amp * 0.5;
    h += ridged * weight;
    norm += weight;
    carve = ridged;
    amp *= 0.52;
    freq *= 2.09;
  }
  h /= norm;

  // A broad bowl: the land rises away from the airfield in every direction, so the valley the
  // course runs up is enclosed by higher ground on both sides and the horizon is never flat.
  const dist = Math.hypot(x - RUNWAY.x, z - RUNWAY.z);
  const bowl = Math.min(1, Math.pow(dist / 3600, 0.85));
  // `h * h` keeps the valley floor broad and pushes the height into the peaks: a linear ramp makes
  // every hillside the same slope from the runway to the summit.
  let elevation = 26 + h * h * WORLD.peak * (0.35 + 0.65 * bowl);

  // Benches and gullies: a slow noise quantised into steps, which is what a sedimentary face
  // looks like from the air — flat shelves separated by short steep risers.
  const shelfField = noise(sx * 0.00072 + 63.1, sz * 0.00072 + 9.4);
  const bench = (shelfField - Math.floor(shelfField)) - 0.5;
  elevation += bench * (18 + bowl * 46);
  // Scree fans and ravines, at the scale a wing sees best.
  elevation += (noise(sx * 0.0041 - 12.7, sz * 0.0041 + 44.2) - 0.5) * (5 + bowl * 15);
  elevation += (noise(sx * 0.0126 + 71.3, sz * 0.0126 - 33.8) - 0.5) * (1.4 + bowl * 4.4);

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
 * Colour of the land at a height and slope: valley grass, meadow, forest floor, scree, then rock
 * and snow on the peaks.
 *
 * The ramp is deliberately over-specified — eight bands rather than four — because a terrain
 * shader can only modulate what the vertex colour already says. A single "green below 300 m" band
 * gives the fragment stage nothing to work with: it can darken a green, but it cannot invent the
 * straw-coloured shelf, the grey scree fan or the pale dry rock that make a slope read as land
 * instead of as a painted surface. Two extra bands cost nothing at build time and give the detail
 * shader somewhere to live.
 */
function shadeFor(elevation, slope) {
  const c = new THREE.Color();

  // How exposed the ground is: a cliff face is bare whatever its altitude.
  const bare = Math.min(1, Math.max(0, (slope - 0.40) / 0.28));
  // How far up the mountain this is: 0 at the valley floor, 1 at the snowline.
  const high = Math.min(1, Math.max(0, (elevation - RUNWAY.elevation) / 900));

  if (elevation < 11 && slope < 0.34) {
    // Wet ground at the water's edge, darker than the sand above it.
    c.setHex(PALETTE.sand).lerp(new THREE.Color(PALETTE.water), 0.35);
  } else if (elevation < RUNWAY.elevation + 6 && slope < 0.40) {
    // The valley floor: mown grass, turning to sand at the water's edge.
    c.setHex(elevation < 14 ? PALETTE.sand : PALETTE.grassLow);
    // Meadow patches: the floor is not one green, it is a patchwork of mown and rank grass.
    c.lerp(new THREE.Color(PALETTE.grassHigh), 0.18 + high * 0.3);
  } else if (bare > 0) {
    // Steep ground shows rock whatever its height: this is what makes the cliffs read. The base
    // rock darkens down in the shadowed gullies and pales on the sunlit buttresses.
    c.setHex(PALETTE.rock);
    if (slope > 0.62) c.lerp(new THREE.Color(PALETTE.rockDark), Math.min(1, (slope - 0.62) / 0.26));
    // Above the treeline the rock is paler and drier, which gives the high faces a different
    // value from the ones down in the valley.
    if (elevation > 380) c.lerp(new THREE.Color(PALETTE.rockLight), Math.min(1, (elevation - 380) / 460) * 0.85);
    // Bare rock low down is dirt and scree, warmer than the cliffs above it.
    if (elevation < 300) c.lerp(new THREE.Color(PALETTE.scree), (1 - elevation / 300) * 0.55);
  } else if (elevation < 240) {
    // Valley floor and the first slopes: grass, with the forest floor beginning to show through.
    c.setHex(PALETTE.grassLow).lerp(new THREE.Color(PALETTE.grassHigh), high * 2.4);
    c.lerp(new THREE.Color(PALETTE.forest), Math.min(1, high * 3.2) * 0.42);
  } else if (elevation < 420) {
    // The wooded belt: forest floor, which is what the canopy shadows land on.
    c.setHex(PALETTE.forest).lerp(new THREE.Color(PALETTE.grassHigh), 0.34 - (elevation - 240) / 180 * 0.2);
  } else if (elevation < 620) {
    // The upper slopes: thinning forest, straw and lichen over rock.
    c.setHex(PALETTE.forest).lerp(new THREE.Color(PALETTE.alpine), (elevation - 420) / 200);
    c.lerp(new THREE.Color(PALETTE.rockLight), Math.max(0, (elevation - 540) / 80) * 0.4);
  } else if (elevation < 830) {
    // Above the treeline: alpine tundra, then bare rock with snow in the gullies.
    c.setHex(PALETTE.alpine).lerp(new THREE.Color(PALETTE.rockLight), (elevation - 620) / 210);
  } else if (elevation < 960) {
    // The snowline: a ragged edge rather than a contour, so the snow sits in patches and gullies.
    c.setHex(PALETTE.rockLight).lerp(new THREE.Color(PALETTE.snow), Math.min(1, (elevation - 830) / 130));
  } else {
    c.setHex(PALETTE.snow);
    // Snow in shadow goes blue, which is what makes a peak read as cold rather than as white paint.
    c.lerp(new THREE.Color(PALETTE.snowShade), Math.min(1, (elevation - 980) / 220) * 0.3);
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
        varying float vTerrainUp;
        varying float vTerrainHeight;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vTerrainWorld = (modelMatrix * vec4(position, 1.0)).xyz;
        vTerrainUp = normalize(mat3(modelMatrix) * normal).y;
        vTerrainHeight = position.y;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTerrainWorld;
        varying float vTerrainUp;
        varying float vTerrainHeight;

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
          for (int i = 0; i < 5; i++) {
            v += tNoise(p) * a;
            p = p * 2.03 + vec2(17.3, 9.1);
            a *= 0.5;
          }
          return v;
        }
        // Ridged variant: crests instead of blobs. Used for the rock's own fracturing, because a
        // cliff face is a set of sharp edges rather than a soft mottle.
        float tRidge(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += (1.0 - abs(2.0 * tNoise(p) - 1.0)) * a;
            p = p * 2.07 + vec2(5.7, 23.1);
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
          float upness = clamp(vTerrainUp, 0.0, 1.0);
          // Rockness: how much of this fragment is bare rock rather than vegetation. Steepness is
          // the primary signal; altitude thins the vegetation out, so a 700 m slope is rockier
          // than a 200 m slope at the same pitch.
          float alt = clamp((vTerrainHeight - 60.0) / 780.0, 0.0, 1.0);
          float rockness = clamp((0.66 - upness) * 2.4, 0.0, 1.0);
          rockness = clamp(rockness + alt * alt * 0.42, 0.0, 1.0);
          // Snow: high and flat-ish holds it, steep sheds it.
          float snowness = smoothstep(690.0, 880.0, vTerrainHeight + (1.0 - upness) * -260.0);

          // --- Four bands of noise, each at a scale the eye reads differently.
          // Broad: fields, stands, the patchwork of the valley floor (300 m across).
          float broad = tFbm(wp * 0.0034);
          // Medium: copses, banks, scree fans (25 m).
          float medium = tFbm(wp * 0.041 + 31.7);
          // Tufts and rubble (2.5 m).
          float fine = tFbm(wp * 0.4 + 91.3);
          // Grain: the scale that reads as surface when the camera is low (0.4 m).
          float grain = tNoise(wp * 2.6 + 11.3);

          // Vegetation: soft, broad breakup. Rock: hard, high-frequency, fractured.
          float vegDetail = broad * 0.46 + medium * 0.34 + fine * 0.20;
          float rockDetail = medium * 0.24 + fine * 0.34 + grain * 0.26 + tRidge(wp * 0.13 + 7.7) * 0.16;
          float detail = mix(vegDetail, rockDetail, rockness);

          // Keep the mean where it was: only the spread changes, so the round's palette still
          // rules. Rock gets a much wider spread than grass — a cliff has deep shadow in its
          // joints and bright faces, a meadow does not.
          float spread = mix(0.34, 0.86, rockness);
          diffuseColor.rgb *= (1.0 - spread * 0.5) + detail * spread;

          // --- Sedimentary strata. The single most convincing thing on a big face: horizontal
          // beds of different hardness, so the cliff is banded rather than smooth. Keyed off world
          // height so the layers are level and continuous across a whole wall, warped by a slow
          // noise so no band is ruler-straight, and eased so each bed has a soft top and a hard
          // base — which is what a ledge in sunlight actually looks like.
          float warpY = vTerrainWorld.y + (tFbm(wp * 0.017 + 17.3) - 0.5) * 34.0;
          float bandBig = fract(warpY * 0.0165);
          float bandMid = fract(warpY * 0.058 + 0.31);
          float bandFine = fract(warpY * 0.185 + 0.63);
          float strataBig = smoothstep(0.0, 0.34, bandBig) * smoothstep(1.0, 0.46, bandBig);
          float strataMid = smoothstep(0.0, 0.30, bandMid) * smoothstep(1.0, 0.52, bandMid);
          float strataFine = smoothstep(0.0, 0.26, bandFine) * smoothstep(1.0, 0.58, bandFine);
          float strata = strataBig * 0.56 + strataMid * 0.30 + strataFine * 0.14;
          // Layers are not equal: a slow noise decides which beds are hard pale limestone and
          // which are soft dark shale.
          float bandTone = tFbm(vec2(warpY * 0.024, wp.x * 0.0031 + wp.y * 0.0031));
          vec3 strataTint = mix(vec3(0.52, 0.49, 0.45), vec3(1.26, 1.20, 1.09), bandTone);
          // A ledge's underside is in shadow and its top catches the sun: the derivative of the
          // band function gives that for free.
          float ledge = smoothstep(0.0, 0.10, bandBig) * (1.0 - smoothstep(0.10, 0.20, bandBig));
          float ledgeDark = 1.0 - ledge * 0.42;
          diffuseColor.rgb *= mix(vec3(1.0), strataTint * (0.60 + strata * 0.72) * ledgeDark, rockness);

          // --- Vertical joints and fractures. They run down the face, so they are keyed off the
          // horizontal angle and the horizontal distance rather than off height: two sets, one
          // coarse enough to split the wall into buttresses, one fine enough to read at 200 m.
          float jointA = tRidge(vec2(atan(wp.y, wp.x) * 34.0, vTerrainWorld.y * 0.006));
          float crack = smoothstep(0.62, 0.78, jointA);
          float jointB = tRidge(vec2(atan(wp.y, wp.x) * 96.0 + 41.0, vTerrainWorld.y * 0.021));
          float crackFine = smoothstep(0.70, 0.84, jointB);
          diffuseColor.rgb *= 1.0 - (crack * 0.34 + crackFine * 0.18) * rockness;

          // --- Cavity: the ground's own hollows are darker. A finite-difference of the medium
          // noise against its local mean is a cheap ambient-occlusion proxy, and it is what stops
          // a rough surface from reading as uniformly lit. Applied everywhere, harder on rock.
          float cavity = tFbm(wp * 0.09 + 55.1) - tFbm(wp * 0.018 + 12.4);
          diffuseColor.rgb *= 1.0 - clamp(cavity * 1.5 + 0.16, 0.0, 0.62) * mix(0.34, 0.72, rockness);

          // --- Snow. It settles on flat ground and in gullies, and it is not pure white: the
          // shaded side of a drift goes blue, and wind-scoured crests show the rock under it.
          if (snowness > 0.0) {
            float drift = tFbm(wp * 0.06 + 5.1);
            float cover = clamp(snowness * (0.72 + drift * 0.55), 0.0, 1.0);
            // Scoured ridges: the fine ridge field punches holes in the snow.
            cover *= 1.0 - smoothstep(0.72, 0.95, tRidge(wp * 0.024 + 88.2)) * 0.45;
            vec3 snowCol = mix(vec3(0.80, 0.86, 0.94), vec3(1.02, 1.03, 1.05), clamp(upness * 1.4, 0.0, 1.0));
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * snowCol * 1.6, cover);
          }

          // --- A slow hue lean, moss-green in the hollows and dry straw on the ridges. It gives
          // the vegetation a reason to be the colour it is instead of one flat green field.
          float lean = tFbm(wp * 0.021 + 5.9) - 0.5;
          float warm = clamp(lean * 1.6 + 0.5, 0.0, 1.0);
          diffuseColor.rgb = mix(
            diffuseColor.rgb,
            diffuseColor.rgb * vec3(1.10, 1.02, 0.74),
            warm * 0.42 * (1.0 - rockness) * (1.0 - snowness)
          );
          // Cool shadow in the hollows, so the vegetation is not all one temperature.
          diffuseColor.rgb = mix(
            diffuseColor.rgb,
            diffuseColor.rgb * vec3(0.86, 0.94, 0.98),
            (1.0 - warm) * 0.24 * (1.0 - rockness)
          );
        }`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        {
          // Finite-difference the same noise field for a relief normal: no texture fetch, and it
          // follows the ground's own colour breakup because it is the same field. Two octaves of
          // relief — a coarse one for boulders and banks, a fine one for grit — so the surface has
          // structure at both the scale seen from 300 m and the scale seen from 30 m.
          vec2 wp = vTerrainWorld.xz;
          float upnessN = clamp(vTerrainUp, 0.0, 1.0);
          float rocknessN = clamp((0.66 - upnessN) * 2.4, 0.0, 1.0);

          // Coarse relief: 6 m features.
          float d1 = 3.2;
          float h0 = tFbm(wp * 0.16);
          float hx = tFbm((wp + vec2(d1, 0.0)) * 0.16);
          float hz = tFbm((wp + vec2(0.0, d1)) * 0.16);
          vec3 relief = vec3((hx - h0), 0.0, (hz - h0));

          // Fine relief: 0.35 m grit. Only matters close up, which is exactly when it is needed.
          float d2 = 0.35;
          float g0 = tNoise(wp * 2.9);
          float gx = tNoise((wp + vec2(d2, 0.0)) * 2.9);
          float gz = tNoise((wp + vec2(0.0, d2)) * 2.9);
          vec3 grit = vec3((gx - g0), 0.0, (gz - g0));

          // Rock wants both, hard; grass wants a little of the coarse one only.
          vec3 bump = relief * (0.9 + rocknessN * 5.6) + grit * (0.28 + rocknessN * 1.5);
          normal = normalize(normal + bump);
        }`,
      );
  };
  // A shader edit needs a new program key, or three reuses the one it compiled before the edit.
  material.customProgramCacheKey = () => 'terrain-detail-v5';
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
 * Builds one conifer's merged geometry: a trunk and a stack of jittered canopy tiers.
 *
 * The tier count and the jitter are the whole point. A three-tier cone with eight identical sides
 * reads as a traffic cone from any distance, and a hillside of traffic cones is the single most
 * recognisable "low-poly placeholder" signature there is. Six or seven tiers, each with its own
 * radius, height, spin and lateral drift, produce a ragged, slightly asymmetric silhouette whose
 * underside catches shadow between the tiers — which is what a spruce actually looks like against
 * the sky when you are looking down on it from a thousand feet.
 *
 * `seedJitter` is deterministic per variant, so the same build always produces the same forest.
 */
function buildConiferGeometry({ trunkRadius, trunkHeight, tiers, sides = 8, seedJitter = 1 }) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(trunkRadius * 0.5, trunkRadius, trunkHeight, 5);
  trunk.translate(0, trunkHeight * 0.5, 0);
  parts.push(trunk);
  let spin = seedJitter * 0.7;
  tiers.forEach((t, i) => {
    // Each tier is spun a different amount and squashed on one axis, so no two tiers line up and
    // the silhouette never has a straight edge running up it.
    spin += 0.63 + seedJitter * 0.31;
    const cone = new THREE.ConeGeometry(t.r, t.h, sides, 1, true);
    cone.scale(1, 1, 0.78 + ((i * 7 + seedJitter * 13) % 10) * 0.045);
    cone.rotateY(spin);
    cone.translate(t.dx ?? 0, t.y, t.dz ?? 0);
    parts.push(cone);
    // A skirt of short, wider branches under each tier: the ragged fringe that a cone is missing.
    // Four small cones pointing outward and down, which is the cheapest way to break a silhouette.
    const skirtCount = i === 0 ? 0 : 4;
    for (let k = 0; k < skirtCount; k += 1) {
      const a = (k / skirtCount) * Math.PI * 2 + spin * 1.7;
      const len = t.r * (0.44 + ((k * 3 + i * 5 + seedJitter * 11) % 7) * 0.028);
      const branch = new THREE.ConeGeometry(t.r * 0.20, len, 4);
      branch.rotateZ(Math.PI * 0.5 + 0.42);
      branch.rotateY(-a);
      branch.translate(
        Math.cos(a) * t.r * 0.58,
        t.y - t.h * 0.30 - len * 0.18,
        Math.sin(a) * t.r * 0.58,
      );
      parts.push(branch);
    }
  });
  return mergeGeometries(parts);
}

/**
 * A deciduous tree: a trunk that forks, and a crown built from several overlapping lobes so the
 * outline is a mass of foliage rather than a golf ball on a stick.
 */
function buildBroadleafGeometry({ trunkRadius = 0.42, trunkHeight = 5.0, crown = 4.0, seedJitter = 1 } = {}) {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(trunkRadius * 0.62, trunkRadius, trunkHeight, 5);
  trunk.translate(0, trunkHeight * 0.5, 0);
  parts.push(trunk);

  // Two limbs, angled out of the trunk, so the crown sits on a fork instead of on a pole.
  for (let k = 0; k < 2; k += 1) {
    const a = seedJitter * 1.9 + k * Math.PI;
    const limb = new THREE.CylinderGeometry(trunkRadius * 0.32, trunkRadius * 0.55, crown * 0.9, 4);
    limb.rotateZ(0.44);
    limb.rotateY(a);
    limb.translate(Math.cos(a) * crown * 0.26, trunkHeight + crown * 0.30, Math.sin(a) * crown * 0.26);
    parts.push(limb);
  }

  // Five lobes at different offsets and radii: the crown reads as a cluster of foliage clumps.
  const lobes = [
    { r: 1.00, dx: 0.00, dy: 0.58, dz: 0.00 },
    { r: 0.66, dx: 0.46, dy: 0.94, dz: -0.22 },
    { r: 0.58, dx: -0.40, dy: 0.86, dz: 0.30 },
    { r: 0.50, dx: 0.12, dy: 1.24, dz: 0.16 },
    { r: 0.44, dx: -0.22, dy: 0.44, dz: -0.42 },
  ];
  lobes.forEach((l, i) => {
    const lobe = new THREE.IcosahedronGeometry(crown * l.r * (0.9 + ((i * 5 + seedJitter * 7) % 6) * 0.03), 1);
    lobe.scale(1, 0.80 + (i % 3) * 0.09, 1);
    lobe.rotateY(seedJitter * 2.1 + i * 0.9);
    lobe.translate(l.dx * crown, trunkHeight + l.dy * crown, l.dz * crown);
    parts.push(lobe);
  });
  return mergeGeometries(parts);
}

/** A shrub: a low, dense clump that fills the space between the trunks and hides the ground. */
function buildShrubGeometry(seedJitter) {
  const parts = [];
  const lobes = 3;
  for (let i = 0; i < lobes; i += 1) {
    const r = 1.5 + ((i * 7 + seedJitter * 5) % 5) * 0.24;
    const lobe = new THREE.IcosahedronGeometry(r, 0);
    lobe.scale(1.12, 0.68, 1.02);
    lobe.rotateY(seedJitter + i * 1.4);
    lobe.translate(Math.cos(i * 2.2) * r * 0.62, r * 0.42, Math.sin(i * 2.2) * r * 0.62);
    parts.push(lobe);
  }
  return mergeGeometries(parts);
}

/**
 * A boulder: an icosahedron pushed around on its vertices, so each variant is a different rock
 * rather than a faceted ball. Broken rock on a scree slope is one of the things a hillside needs to
 * stop reading as a smooth painted surface, and instanced boulders cost almost nothing.
 */
function buildBoulderGeometry(radius, seedJitter) {
  const geo = new THREE.IcosahedronGeometry(radius, 1);
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 1) {
    v.fromBufferAttribute(pos, i);
    // A deterministic per-vertex push, so the rock is craggy and not a sphere.
    const n = Math.sin(v.x * 2.7 + seedJitter) * Math.cos(v.z * 3.1 - seedJitter * 1.7)
      + Math.sin(v.y * 4.3 + seedJitter * 2.2) * 0.6;
    v.multiplyScalar(1 + n * 0.22);
    v.y *= 0.72;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

/** Places one species' instances. Shared by every layer, so the layers cannot drift apart. */
function placeInstances({ group, geometry, list, scaleRange, tintFn, flat = true, cast = true }) {
  if (!list.length) return;
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.91, metalness: 0, flatShading: flat,
  });
  const instanced = new THREE.InstancedMesh(geometry, material, list.length);
  instanced.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);

  const matrix = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const tint = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);

  list.forEach(([x, y, z, a, b], i) => {
    const size = scaleRange[0] + a * (scaleRange[1] - scaleRange[0]);
    pos.set(x, y, z);
    quat.setFromAxisAngle(up, b * Math.PI * 2);
    scale.set(size, size * (0.86 + a * 0.30), size);
    matrix.compose(pos, quat, scale);
    instanced.setMatrixAt(i, matrix);
    tintFn(tint, a, b);
    instanced.setColorAt(i, tint);
  });

  instanced.instanceMatrix.needsUpdate = true;
  if (instanced.instanceColor) instanced.instanceColor.needsUpdate = true;
  instanced.castShadow = cast;
  instanced.receiveShadow = true;
  void up;
  group.add(instanced);
}

/**
 * Scatters the vegetation and the loose rock over the land.
 *
 * The placements are **clustered**, not uniform. A uniform scatter over a heightfield is the other
 * half of the low-poly look: real forest grows in stands with clearings between them, thinning at
 * the edges, denser in the hollows where water collects and on the shaded side of a ridge. So the
 * scatter runs in two passes — cluster centres are chosen on suitable ground, then trees are placed
 * around those centres with a falloff — and the density of the clusters themselves varies with
 * altitude, slope and a slow noise field.
 *
 * Four layers, because a forest with trees only has visible ground under it:
 *
 *  - **Canopy** — three conifer and two broadleaf variants, tall, the silhouette layer.
 *  - **Understory** — short trees and saplings, which fill the gap between canopy and ground.
 *  - **Shrub** — low clumps, which is what actually covers the soil in the clearings.
 *  - **Boulders** — instanced rock on the scree slopes and in the gorge, which is what makes the
 *    bare rock in the terrain shader look like it has something sitting on it.
 */
export function buildForest(terrain) {
  const CANOPY = {
    spruce: 0x3d5a30,
    fir: 0x4a6a3a,
    broadleaf: 0x5f7c40,
    shrub: 0x4a6234,
    boulder: 0x7d756a,
  };

  // --- Canopy variants. Two of each conifer, five lobes for the broadleaf: species × variant is
  // what stops a hillside from being one shape repeated.
  const spruceA = buildConiferGeometry({
    trunkRadius: 0.50, trunkHeight: 7, seedJitter: 1, sides: 8,
    tiers: [
      { r: 4.6, h: 9.5, y: 9.4 },
      { r: 4.0, h: 8.6, y: 13.6, dx: 0.28 },
      { r: 3.4, h: 8.0, y: 17.8 },
      { r: 2.8, h: 7.2, y: 22.0, dx: -0.22, dz: 0.18 },
      { r: 2.1, h: 6.2, y: 26.2 },
      { r: 1.4, h: 5.0, y: 30.2, dx: 0.18 },
    ],
  });
  paintByHeight(spruceA, CANOPY.spruce, PALETTE.hullDark);

  const spruceB = buildConiferGeometry({
    trunkRadius: 0.46, trunkHeight: 6, seedJitter: 5, sides: 7,
    tiers: [
      { r: 4.1, h: 9.0, y: 8.4 },
      { r: 3.6, h: 8.2, y: 12.4 },
      { r: 3.0, h: 7.4, y: 16.2, dx: -0.30 },
      { r: 2.4, h: 6.6, y: 20.2, dz: 0.26 },
      { r: 1.8, h: 5.6, y: 24.2 },
      { r: 1.1, h: 4.6, y: 27.8, dx: 0.14, dz: -0.12 },
    ],
  });
  paintByHeight(spruceB, CANOPY.spruce, PALETTE.hullDark);

  const firA = buildConiferGeometry({
    trunkRadius: 0.58, trunkHeight: 6, seedJitter: 3, sides: 8,
    tiers: [
      { r: 5.8, h: 8.6, y: 7.8 },
      { r: 5.0, h: 8.0, y: 11.6 },
      { r: 4.2, h: 7.2, y: 15.4 },
      { r: 3.4, h: 6.4, y: 19.2, dx: 0.26 },
      { r: 2.5, h: 5.6, y: 23.0 },
      { r: 1.7, h: 4.8, y: 26.6, dx: -0.20, dz: 0.22 },
      { r: 1.0, h: 4.0, y: 30.0 },
    ],
  });
  paintByHeight(firA, CANOPY.fir, PALETTE.hullDark);

  const firB = buildConiferGeometry({
    trunkRadius: 0.54, trunkHeight: 5, seedJitter: 7, sides: 7,
    tiers: [
      { r: 5.3, h: 8.0, y: 7.0 },
      { r: 4.6, h: 7.4, y: 10.6 },
      { r: 3.8, h: 6.8, y: 14.0 },
      { r: 3.0, h: 6.0, y: 17.6, dz: -0.28 },
      { r: 2.2, h: 5.2, y: 21.2 },
      { r: 1.4, h: 4.4, y: 24.6, dx: 0.24 },
    ],
  });
  paintByHeight(firB, CANOPY.fir, PALETTE.hullDark);

  const broadleafA = buildBroadleafGeometry({ seedJitter: 1, crown: 4.4, trunkHeight: 5.4 });
  paintByHeight(broadleafA, CANOPY.broadleaf, PALETTE.hullDark);
  const broadleafB = buildBroadleafGeometry({ seedJitter: 4, crown: 3.6, trunkHeight: 4.6 });
  paintByHeight(broadleafB, CANOPY.broadleaf, PALETTE.hullDark);

  const shrubGeo = buildShrubGeometry(2);
  paintByHeight(shrubGeo, CANOPY.shrub, 0x35401f);

  const boulderGeo = buildBoulderGeometry(2.6, 3.1);
  paintByHeight(boulderGeo, CANOPY.boulder, 0x5b554c);

  const species = [
    { geometry: spruceA, scale: [0.60, 1.42], weight: 0.22, cast: true },
    { geometry: spruceB, scale: [0.58, 1.36], weight: 0.20, cast: true },
    { geometry: firA, scale: [0.56, 1.30], weight: 0.16, cast: true },
    { geometry: firB, scale: [0.54, 1.26], weight: 0.14, cast: true },
    { geometry: broadleafA, scale: [0.72, 1.40], weight: 0.15, cast: true },
    { geometry: broadleafB, scale: [0.70, 1.34], weight: 0.13, cast: true },
  ];

  const rng = makeRng(WORLD.seed ^ 0x9e37);
  const half = WORLD.size * 0.47;
  const buckets = species.map(() => []);
  const shrubs = [];
  const boulders = [];

  /** True where a tree can stand: off the airfield, inside the treeline, not on a cliff. */
  function plantable(x, z) {
    const dist = Math.hypot(x - RUNWAY.x, z - RUNWAY.z);
    if (dist < RUNWAY.basinRadius * 0.92) return null;
    const y = terrain.heightAt(x, z);
    if (y < 26 || y > 700) return null;
    const s = Math.abs(terrain.heightAt(x + 24, z) - y) + Math.abs(terrain.heightAt(x, z + 24) - y);
    if (s / 24 > 0.66) return null;
    return y;
  }

  // --- Pass 1: cluster centres. The land decides how many stands it supports and how big they
  // are; a hillside with a stand on it then reads as one decision, not as noise.
  const CLUSTERS = 1500;
  const clusters = [];
  for (let i = 0; i < CLUSTERS * 4 && clusters.length < CLUSTERS; i += 1) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    const y = plantable(x, z);
    if (y === null) continue;
    // Altitude thins the stands out: above 560 m only the sheltered pockets hold trees.
    const treeline = Math.min(1, Math.max(0, (700 - y) / 170));
    if (rng() > treeline * 0.94 + 0.06) continue;
    // Cluster spread: a stand is 60–180 m across, and the big ones are rarer.
    const r = 55 + Math.pow(rng(), 1.8) * 130;
    clusters.push({ x, z, y, r });
  }

  // --- Pass 2: fill the stands. A tree lands near a centre with a radial falloff, so density is
  // highest in the middle of a stand and tails off at the edge — which is what a real treeline
  // looks like from above.
  const MAX_TREES = 17000;
  let placed = 0;
  for (let i = 0; i < clusters.length && placed < MAX_TREES; i += 1) {
    const c = clusters[i];
    const want = Math.round(10 + c.r * 0.16);
    for (let k = 0; k < want * 3 && placed < MAX_TREES; k += 1) {
      // Square-root radius keeps the distribution even inside the disc; cubing it biases toward
      // the centre so the stand has a dense core.
      const rad = c.r * Math.pow(rng(), 0.72);
      const ang = rng() * Math.PI * 2;
      const x = c.x + Math.cos(ang) * rad;
      const z = c.z + Math.sin(ang) * rad;
      const y = plantable(x, z);
      if (y === null) continue;
      // Species by altitude: conifers up high, broadleaf in the valley, plus a slow stand-level
      // noise so a hillside has pure conifer stands and mixed ones instead of a uniform blend.
      const stand = terrain.heightAt(x + 640, z - 460) - y;
      const coniferBias = Math.min(1, Math.max(0, (y - 110) / 360 + stand * 0.0022));
      const roll = rng();
      let pick = 4;
      if (roll < coniferBias * 0.72 + 0.16) {
        // Conifer: split between the four conifer variants, fir lower down (wider, blunter).
        const sub = rng();
        pick = sub < 0.30 ? 0 : sub < 0.58 ? 1 : sub < 0.80 ? 2 : 3;
      } else if (roll < 0.86) {
        pick = rng() < 0.55 ? 4 : 5;
      } else {
        pick = 0;
      }
      buckets[pick].push([x, y - 1.3, z, rng(), rng()]);
      placed += 1;

      // Understory: a sapling in the same stand, shorter and more common in the hollows.
      if (rng() < 0.34 && placed < MAX_TREES * 1.3) {
        const ux = x + (rng() - 0.5) * 16;
        const uz = z + (rng() - 0.5) * 16;
        const uy = plantable(ux, uz);
        if (uy !== null) {
          buckets[rng() < 0.65 ? 1 : 3].push([ux, uy - 1.1, uz, rng() * 0.42, rng()]);
        }
      }
      // Shrub in the gaps: the layer that covers the soil under a thinning canopy.
      if (rng() < 0.52) {
        const sx = x + (rng() - 0.5) * 30;
        const sz = z + (rng() - 0.5) * 30;
        const sy = plantable(sx, sz);
        if (sy !== null) shrubs.push([sx, sy - 0.5, sz, rng(), rng()]);
      }
    }
  }

  // --- Loose rock. Boulders go where nothing grows: the scree fans below the treeline, the gorge
  // walls, and the high bare shelves. Deliberately not clustered — scree lies in sheets, and a
  // scattered dress of rock still reads as rock because it sits on rock.
  for (let i = 0; i < 9000 && boulders.length < 4200; i += 1) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    const dist = Math.hypot(x - RUNWAY.x, z - RUNWAY.z);
    if (dist < RUNWAY.basinRadius * 0.7) continue;
    const y = terrain.heightAt(x, z);
    if (y < 14 || y > 900) continue;
    const s = Math.abs(terrain.heightAt(x + 20, z) - y) + Math.abs(terrain.heightAt(x, z + 20) - y);
    const slope = s / 20;
    // Rock lives on steep or high ground, and rarely in a meadow.
    const chance = Math.min(1, slope * 1.5) * 0.75 + Math.min(1, Math.max(0, (y - 420) / 400)) * 0.5;
    if (rng() > chance * 0.5) continue;
    boulders.push([x, y - 0.6, z, rng(), rng()]);
  }

  // --- Instancing. One draw call per layer.
  const group = new THREE.Group();
  group.name = 'forest';

  // Canopy tint: a multiplier around white. The vertex colours already carry the species green, so
  // a tint that only ever darkens turns the hillside into one black mass — the modulation has to
  // span above 1 as well as below it.
  const canopyTint = (tint, a, b) => {
    const bright = 0.80 + a * 0.72;
    const warm = (b - 0.5) * 0.18;
    const cool = (a - 0.5) * 0.10;
    tint.setRGB(
      Math.min(1.7, bright + warm - cool * 0.4),
      Math.min(1.7, bright + warm * 0.3 + cool * 0.2),
      Math.min(1.7, bright - warm + cool),
    );
  };

  species.forEach((sp, si) => {
    placeInstances({
      group, geometry: sp.geometry, list: buckets[si],
      scaleRange: sp.scale, tintFn: canopyTint, flat: true, cast: sp.cast,
    });
  });

  // Shrubs: short, matte, no shadow casting — they are the ground cover, not the canopy.
  placeInstances({
    group, geometry: shrubGeo, list: shrubs,
    scaleRange: [0.55, 1.35],
    tintFn: (tint, a, b) => {
      const bright = 0.72 + a * 0.68;
      tint.setRGB(Math.min(1.5, bright + (b - 0.5) * 0.14), Math.min(1.5, bright), Math.min(1.5, bright - (b - 0.5) * 0.10));
    },
    flat: true, cast: false,
  });

  // Boulders: bigger and greyer, and they do cast, because a boulder's shadow is a real shadow.
  placeInstances({
    group, geometry: boulderGeo, list: boulders,
    scaleRange: [0.7, 2.6],
    tintFn: (tint, a, b) => {
      const bright = 0.70 + a * 0.55;
      const warm = (b - 0.5) * 0.10;
      tint.setRGB(Math.min(1.4, bright + warm), Math.min(1.4, bright + warm * 0.6), Math.min(1.4, bright - warm * 0.5));
    },
    flat: false, cast: true,
  });

  return group;
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
