// The sky, the sun and the air. A gradient dome painted into a canvas texture at run time, a
// distant haze band that hides the heightfield's edge, drifting cloud billboards and the lights
// that make the land read as lit ground rather than flat colour.
//
// Everything here takes a round's `sky` block, so the same code paints a clear dawn and a storm
// deck without a second implementation: a round changes the palette, the haze distance, the sun's
// height and the amount of rain, and the world follows.

import * as THREE from '../vendor/three.module.min.js';
import { PALETTE, SUN, WORLD } from './config.js';

/** Builds a gradient dome from two or three colour stops, drawn once into a canvas. */
export function buildSky(theme = null) {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, size);

  if (theme) {
    // A round-supplied palette: zenith, middle, and the pale band at the horizon.
    gradient.addColorStop(0.0, theme.top);
    gradient.addColorStop(0.30, theme.mid);
    gradient.addColorStop(0.58, theme.low);
    gradient.addColorStop(0.80, theme.horizon);
    gradient.addColorStop(1.0, theme.horizon);
  } else {
    gradient.addColorStop(0.0, '#1c4d86');
    gradient.addColorStop(0.18, '#2c67a4');
    gradient.addColorStop(0.38, '#4d86b9');
    gradient.addColorStop(0.56, '#78a7ca');
    gradient.addColorStop(0.70, '#9dc3d9');
    gradient.addColorStop(0.82, '#c4dae5');
    gradient.addColorStop(0.92, '#dde9ee');
    gradient.addColorStop(1.0, '#e9eff1');
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 16, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;

  // The dome is small enough to sit inside the camera's far plane and is re-centred on the camera
  // every frame, so the aircraft can never fly out from under it or past its far wall.
  const geometry = new THREE.SphereGeometry(WORLD.size * 1.5, 32, 24);
  const material = new THREE.MeshBasicMaterial({
    map: texture, side: THREE.BackSide, depthWrite: false, fog: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'sky';
  mesh.renderOrder = -1;
  mesh.frustumCulled = false;
  /** Replaces the gradient in place, for a round change without a rebuild. */
  mesh.userData.repaint = (nextTheme) => {
    const g2 = ctx.createLinearGradient(0, 0, 0, size);
    g2.addColorStop(0.0, nextTheme.top);
    g2.addColorStop(0.30, nextTheme.mid);
    g2.addColorStop(0.58, nextTheme.low);
    g2.addColorStop(0.80, nextTheme.horizon);
    g2.addColorStop(1.0, nextTheme.horizon);
    ctx.fillStyle = g2;
    ctx.fillRect(0, 0, 16, size);
    texture.needsUpdate = true;
  };
  return mesh;
}

/** The sun's own disc, drawn as a sprite so it reads through the haze. */
export function buildSun(theme = null) {
  const azimuth = theme?.sunAzimuth ?? SUN.azimuth;
  const elevation = theme?.sunElevation ?? SUN.elevation;
  const dir = new THREE.Vector3(
    Math.cos(elevation) * Math.sin(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.cos(azimuth),
  ).normalize();

  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255, 253, 246, 1)');
  gradient.addColorStop(0.12, 'rgba(255, 248, 222, 0.92)');
  gradient.addColorStop(0.30, 'rgba(255, 226, 168, 0.28)');
  gradient.addColorStop(0.62, 'rgba(255, 208, 150, 0.07)');
  gradient.addColorStop(1, 'rgba(255, 196, 140, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture, transparent: true, depthWrite: false, depthTest: false, fog: false,
    blending: THREE.AdditiveBlending,
    opacity: theme ? Math.max(0.25, Math.min(1, (theme.sunIntensity ?? 2.5) / 2.6)) : 1,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(WORLD.size * 0.34);
  sprite.position.copy(dir).multiplyScalar(WORLD.size * 2.4);
  sprite.name = 'sun';
  return {
    sprite,
    direction: dir,
    /** Re-aims the sun for a new round, and dims it under cloud. */
    retheme(nextTheme) {
      const az = nextTheme.sunAzimuth;
      const el = nextTheme.sunElevation;
      dir.set(
        Math.cos(el) * Math.sin(az),
        Math.sin(el),
        Math.cos(el) * Math.cos(az),
      ).normalize();
      sprite.material.opacity = Math.max(0.22, Math.min(1, (nextTheme.sunIntensity ?? 2.5) / 2.6));
      sprite.material.needsUpdate = true;
    },
  };
}

/** The lights: a warm key sun with shadows, a cool sky fill, and a low bounce off the ground. */
export function buildLights(sunDir, theme = null) {
  const group = new THREE.Group();
  group.name = 'lights';

  const sun = new THREE.DirectionalLight(theme?.sun ?? 0xfff0d2, theme?.sunIntensity ?? SUN.intensity);
  sun.position.copy(sunDir).multiplyScalar(4200);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 200;
  sun.shadow.camera.far = 9000;
  const extent = 1400;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 2.4;
  group.add(sun);

  const hemi = new THREE.HemisphereLight(PALETTE.skyHorizon, 0x4a5136, theme?.hemi ?? 1.05);
  group.add(hemi);

  const fill = new THREE.DirectionalLight(0xbdd8ea, 0.42);
  fill.position.set(-sunDir.x * 2000, 900, -sunDir.z * 2000);
  group.add(fill);

  const ambient = new THREE.AmbientLight(0xdfe9f2, 0.35);
  group.add(ambient);

  group.userData = { sun, hemi, fill, ambient };
  return group;
}

/** Repaints the lights for a round: the sun's colour and strength, and the sky's fill. */
export function rethemeLights(group, theme, sunDir) {
  const { sun, hemi, fill, ambient } = group.userData;
  sun.color.setHex(theme.sun);
  sun.intensity = theme.sunIntensity;
  sun.position.copy(sunDir).multiplyScalar(4200);
  hemi.intensity = theme.hemi;

  // The fill and the ambient are the two lights that decide whether a wall is *white* or *dark*,
  // and both used to ignore the clock entirely.
  //
  // `fill` was constructed at a constant 0.42 and never touched here at all, so a second key light
  // kept shining from above at 2 a.m.; a town's white plaster walls therefore stayed white however
  // far the sun went down, and the window glow next to them had nothing to read against. The ambient
  // had the same bug in a worse form: it *rose* at night (`sunIntensity < 1.2 ? 0.55 : 0.35`) on the
  // theory that a dark scene needs lifting, which is backwards — it lifted the scene to daylight.
  //
  // Both are now scaled by `lightLevel`, the day cycle's own 0..1 measure of how much light there
  // is, so they fall with the sun instead of ignoring it. The floors are non-zero on purpose: at
  // 0.10 ambient and 0.06 fill a moonlit wall still has a silhouette and the town reads as *dark*
  // rather than as a black hole, which is the difference between night and a rendering mistake.
  const level = theme.lightLevel ?? 1;
  fill.intensity = 0.06 + level * 0.36;
  ambient.intensity = 0.10 + level * 0.30;
}

/**
 * Cloud billboards over the valley: soft ellipses in a few sizes, drifting slowly on the wind.
 * They are sprites, so they always face the camera and never need geometry.
 *
 * The round's cloud deck sets how low the puffs sit: a storm round's cloud is on the deck, which
 * is what makes the cockpit view go grey.
 */
export function buildClouds(opts = {}) {
  const deck = opts.deck ?? 1;
  const cover = opts.cover ?? 1;
  const drift = opts.drift ?? 1;

  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  // A cloud is a handful of overlapping radial blobs, seeded so it is the same each run.
  let seed = 8821;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < 26; i += 1) {
    const x = size * (0.2 + rnd() * 0.6);
    const y = size * (0.34 + rnd() * 0.36);
    const r = size * (0.08 + rnd() * 0.19);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const alpha = 0.1 + rnd() * 0.14;
    g.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    g.addColorStop(0.6, `rgba(248, 251, 255, ${alpha * 0.55})`);
    g.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const group = new THREE.Group();
  group.name = 'clouds';
  const material = new THREE.SpriteMaterial({
    map: texture, transparent: true, opacity: 0.9, depthWrite: false, fog: false,
  });

  // Two decks, not one.
  //
  // A single layer of puffs all at the same altitude reads as a flat ceiling, which is the giveaway
  // that it is a set of sprites. Real sky has a low deck that is fast, detailed and close, and a
  // high deck that is slow, thin and far — and the gap between them is what gives the cockpit a
  // sense of height. The high deck is dimmer and much larger so it never competes with the low one
  // for attention; it is the thing you fly past, not the thing you fly through.
  //
  // Both decks drift on the same wind but at different rates (the high deck sees stronger wind),
  // which stops the two layers moving as one rigid sheet.
  const decks = [
    { layer: 'low', count: Math.round(30 * cover), scale: 1.0, alt: 1.0, alpha: 1.0, drift: 1.0 },
    { layer: 'high', count: Math.round(16 * cover), scale: 2.4, alt: 2.6, alpha: 0.5, drift: 2.1 },
  ];

  const puffs = [];
  for (const d of decks) {
    for (let i = 0; i < d.count; i += 1) {
      const sprite = new THREE.Sprite(material.clone());
      const angle = rnd() * Math.PI * 2;
      // The high deck reaches further out, because it is seen from further away.
      const radius = (d.layer === 'high' ? 1500 : 900) + rnd() * WORLD.size * 0.42;
      const scale = (900 + rnd() * 1500) * d.scale;
      sprite.position.set(
        Math.cos(angle) * radius,
        (900 + rnd() * 1500) * deck * d.alt,
        Math.sin(angle) * radius,
      );
      sprite.scale.set(scale, scale * (0.4 + rnd() * 0.16), 1);
      sprite.material.opacity = (0.34 + rnd() * 0.4) * Math.min(1, cover * 1.1) * d.alpha;
      sprite.userData.layer = d.layer;
      // The opacity as built, kept so a retheme can dim it without compounding: `retheme` runs on
      // every hour change, and a plain `opacity *= 0.45` would fade the deck to nothing by dusk.
      sprite.userData.baseOpacity = sprite.material.opacity;
      group.add(sprite);
      puffs.push({ sprite, drift: (3.5 + rnd() * 6) * drift * d.drift, layer: d.layer });
    }
  }

  return {
    group,
    /**
     * Recolours the deck for the hour. By day the puffs are white; at dusk and dawn they take the
     * sun's own colour, which is what makes a sunset look like a sunset rather than a white ceiling
     * with an orange sky behind it; at night they go a dim blue-grey and nearly vanish, because a
     * cloud at night is only visible where it occludes stars.
     */
    retheme(theme) {
      const sun = theme?.sun ?? { r: 1, g: 1, b: 1 };
      const light = theme?.lightLevel ?? 1;
      const night = theme?.isNight ?? false;
      const tint = new THREE.Color(
        night ? 0.22 : 0.55 + light * 0.45,
        night ? 0.24 : 0.58 + light * 0.42,
        night ? 0.30 : 0.66 + light * 0.34,
      );
      // A warm wash at low sun. `sun` is the theme's own sun colour, so this tracks the palette
      // rather than being a second guess at what sunset looks like.
      if (!night && light < 0.62) {
        const w = 1 - light / 0.62;
        tint.r = Math.min(1, tint.r + sun.r * w * 0.32);
        tint.g = Math.min(1, tint.g + sun.g * w * 0.16);
        tint.b = Math.min(1, tint.b + sun.b * w * 0.02);
      }
      for (const p of puffs) {
        p.sprite.material.color.copy(tint);
        p.sprite.material.opacity = p.sprite.userData.baseOpacity * (night ? 0.45 : 1);
      }
    },
    update(dt, wind = null) {
      const wx = wind ? wind.x : 0;
      const wz = wind ? wind.z : 0;
      for (const puff of puffs) {
        puff.sprite.position.x += (puff.drift + wx * 1.6) * dt;
        puff.sprite.position.z += wz * 1.6 * dt;
        if (puff.sprite.position.x > WORLD.size * 0.95) puff.sprite.position.x = -WORLD.size * 0.95;
        if (puff.sprite.position.x < -WORLD.size * 0.95) puff.sprite.position.x = WORLD.size * 0.95;
        if (puff.sprite.position.z > WORLD.size * 0.95) puff.sprite.position.z = -WORLD.size * 0.95;
        if (puff.sprite.position.z < -WORLD.size * 0.95) puff.sprite.position.z = WORLD.size * 0.95;
      }
    },
  };
}

/**
 * The rain: a fixed volume of falling streaks that is moved to follow the camera, so the aircraft
 * always flies through rain rather than out of it. Only built for rounds that have any.
 */
export function buildRain(amount) {
  if (!amount || amount <= 0) return null;
  const count = Math.round(2600 * Math.min(1, amount));
  const positions = new Float32Array(count * 2 * 3);
  const spread = 240;
  const height = 220;

  let seed = 4177;
  const rnd = () => {
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < count; i += 1) {
    const x = (rnd() - 0.5) * spread * 2;
    const y = rnd() * height;
    const z = (rnd() - 0.5) * spread * 2;
    const len = 5 + rnd() * 9;
    positions[i * 6 + 0] = x; positions[i * 6 + 1] = y; positions[i * 6 + 2] = z;
    positions[i * 6 + 3] = x + 1.1; positions[i * 6 + 4] = y - len; positions[i * 6 + 5] = z + 0.4;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.LineBasicMaterial({
    color: 0xcfdce6, transparent: true, opacity: 0.16 + 0.2 * amount, depthWrite: false, fog: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.name = 'rain';
  lines.frustumCulled = false;
  lines.userData.speed = 0.55 + amount * 0.5;

  return {
    object: lines,
    update(dt, camera, wind = null) {
      lines.position.set(camera.position.x, camera.position.y - 90, camera.position.z);
      lines.rotation.z = (wind ? wind.x : 0) * 0.006;
    },
  };
}

/**
 * Distance haze: fog in the sky's horizon colour, so the far edge of the land dissolves.
 *
 * A plain linear fog is only half of what makes distance read. Real air does two things a linear
 * fog cannot: it thickens as you look down into a valley (the path through the air is longer than
 * the straight line), and it thins as you climb, so a ridge 8 km away and 2 km below the camera is
 * veiled far more heavily than one 8 km away at eye level. That is why a photo of mountains has
 * pale, low-contrast foothills under sharp, saturated peaks, and why a single linear fog leaves the
 * land looking like a table-top model: every ridge the same value regardless of where it sits.
 *
 * So `applyFog` keeps the linear term for the hard cut at the world's edge, and
 * `installAtmosphericHaze` adds the part that depends on height: a per-fragment aerial-perspective
 * term injected into every scene material, which mixes each surface toward the haze colour by the
 * length of the air path between it and the camera, and by how much of that air is dense.
 */
export function applyFog(scene, theme = null) {
  const visibility = theme ? theme.visibility : 11500;
  // The linear fog starts late and never quite reaches full: it is the floor the height-aware term
  // builds on, not the only thing standing between the camera and the horizon.
  const near = Math.max(900, visibility * 0.30);
  const far = visibility;
  scene.fog = new THREE.Fog(theme?.fog ?? PALETTE.fog, near, far);
}

/**
 * Aerial perspective, the part a linear fog cannot do: the air's density is highest at the ground
 * and falls off with altitude, so the haze a surface collects depends on the *air path* between it
 * and the camera, not just the distance.
 *
 * The model is an exponential atmosphere integrated along the view ray. For a ray of length `d`
 * whose midpoint sits at height `y`, the optical depth is close to
 *
 *     tau = d * density(y)      density(y) = exp(-y / scaleHeight)
 *
 * which is cheap, stable, and gives the behaviour the eye expects: looking down into a valley
 * gathers more air than looking level, and the peaks stand out of the murk while the floor sinks
 * into it. Two terms are summed, a broad one at 2.2 km and a thin high one at 7 km, so the fade is
 * not a single clean exponential (which reads as a gradient) but has the slight lift real haze has.
 *
 * The colour is not a flat grey: it takes the round's haze colour and brightens toward the sun's
 * own azimuth, so flying toward the light gives a warm glare and flying away gives the cool blue of
 * the sky behind. That asymmetry is most of what separates a photograph of mountains from a render.
 *
 * Implemented by rewriting the shader of every material in the scene once per round, keyed off
 * world position, so it costs nothing per frame and nothing to author: no texture, no per-object
 * setup. `toneMapped: false` is not needed because the mix happens before tone mapping.
 */
export function installAtmosphericHaze(scene, theme = null, sunDirection = null) {
  const hazeColor = new THREE.Color(theme?.haze ?? theme?.fog ?? PALETTE.fog);
  const scaleLow = theme?.hazeScaleLow ?? 2200;
  const scaleHigh = theme?.hazeScaleHigh ?? 7000;
  const strength = theme?.hazeStrength ?? 1.0;
  // The sun's azimuth, so the haze warms on the lit side of the sky. Y is dropped: this is about
  // which way you are looking, not how high the sun is.
  const sunAzimuth = sunDirection
    ? new THREE.Vector3(sunDirection.x, 0, sunDirection.z).normalize()
    : new THREE.Vector3(0.6, 0, 0.8).normalize();

  const uniforms = {
    uHazeColor: { value: hazeColor.clone() },
    uHazeSunAzimuth: { value: sunAzimuth.clone() },
    uHazeWarm: { value: new THREE.Color(theme?.hazeWarm ?? 0xffe6c2) },
    uHazeScaleLow: { value: scaleLow },
    uHazeScaleHigh: { value: scaleHigh },
    uHazeStrength: { value: strength },
  };

  const patched = new Set();
  const patch = (material) => {
    if (!material || patched.has(material.uuid)) return;
    if (material.isMeshBasicMaterial || material.isSpriteMaterial || material.isPointsMaterial) return;
    if (material.fog === false) return;
    patched.add(material.uuid);

    // A material may already own `onBeforeCompile` for its own surface details (the terrain's grain
    // and micro-relief are exactly that). Chaining rather than replacing is what keeps both: the
    // original runs first against the unmodified source, then the haze pass edits what it produced.
    const previous = material.onBeforeCompile;

    material.onBeforeCompile = (shader, renderer) => {
      if (typeof previous === 'function') previous(shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vHazeWorld;`,
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
          vHazeWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
          varying vec3 vHazeWorld;
          uniform vec3 uHazeColor;
          uniform vec3 uHazeSunAzimuth;
          uniform vec3 uHazeWarm;
          uniform float uHazeScaleLow;
          uniform float uHazeScaleHigh;
          uniform float uHazeStrength;

          // Optical depth of the air between the camera and this fragment. The ray is sampled at
          // three points rather than integrated exactly: the midpoint alone over-veils a ridge whose
          // near face is close, and three samples cost nothing while fixing that.
          float hazeDepth(vec3 a, vec3 b) {
            vec3 d = b - a;
            float len = length(d);
            float t0 = exp(-max(a.y, 0.0) / uHazeScaleLow);
            float t1 = exp(-max(mix(a.y, b.y, 0.5), 0.0) / uHazeScaleLow);
            float t2 = exp(-max(b.y, 0.0) / uHazeScaleLow);
            float low = (t0 + 4.0 * t1 + t2) * (1.0 / 6.0);
            float h0 = exp(-max(a.y, 0.0) / uHazeScaleHigh);
            float h1 = exp(-max(mix(a.y, b.y, 0.5), 0.0) / uHazeScaleHigh);
            float h2 = exp(-max(b.y, 0.0) / uHazeScaleHigh);
            float high = (h0 + 4.0 * h1 + h2) * (1.0 / 6.0);
            return len * (low * 0.72 + high * 0.28);
          }`,
        )
        .replace(
          // Injected before tone mapping, not after: the haze colour is defined in the linear
          // working space, and `fog_fragment` sits past `colorspace_fragment`, so mixing there
          // would combine an sRGB-encoded fragment with a linear haze and land on a muddy
          // midtone. Here the mix is linear, which is where scattering actually happens, and the
          // result then goes through the same tone curve as everything else.
          '#include <tonemapping_fragment>',
          `{
            // The air path from the eye to this surface, in metres.
            float path = hazeDepth(cameraPosition, vHazeWorld);
            // Aerial perspective: how much of the surface's colour the air has replaced.
            float aerial = 1.0 - exp(-path * 0.000185 * uHazeStrength);

            // The haze is warmer looking into the sun and cooler looking away, the way real
            // scattering is: forward-scattered light carries the sun's colour, backward the sky's.
            vec3 toFragment = normalize(vHazeWorld - cameraPosition);
            float towardSun = max(dot(normalize(vec3(toFragment.x, 0.0, toFragment.z)), uHazeSunAzimuth), 0.0);
            vec3 haze = mix(uHazeColor, uHazeWarm, pow(towardSun, 2.4) * 0.55);

            gl_FragColor.rgb = mix(gl_FragColor.rgb, haze, clamp(aerial, 0.0, 0.92));
          }
          #include <tonemapping_fragment>`,
        );
    };
    material.needsUpdate = true;
  };

  scene.traverse((object) => {
    if (!object.isMesh && !object.isInstancedMesh && !object.isPoints && !object.isLine) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(patch);
  });

  /** Applies the haze to anything added to the scene later (a new round's meshes, for instance). */
  return {
    uniforms,
    /** Re-tints in place when the round changes, without rebuilding the world. */
    retheme(nextTheme, nextSunDirection) {
      uniforms.uHazeColor.value.set(nextTheme?.haze ?? nextTheme?.fog ?? PALETTE.fog);
      uniforms.uHazeWarm.value.set(nextTheme?.hazeWarm ?? 0xffe6c2);
      uniforms.uHazeScaleLow.value = nextTheme?.hazeScaleLow ?? 2200;
      uniforms.uHazeScaleHigh.value = nextTheme?.hazeScaleHigh ?? 7000;
      uniforms.uHazeStrength.value = nextTheme?.hazeStrength ?? 1.0;
      if (nextSunDirection) {
        uniforms.uHazeSunAzimuth.value
          .set(nextSunDirection.x, 0, nextSunDirection.z)
          .normalize();
      }
    },
    /** Patches a mesh the caller has just built, so late additions are hazed too. */
    patch,
    patchObject(root) {
      root.traverse((object) => {
        if (!object.isMesh && !object.isInstancedMesh && !object.isPoints && !object.isLine) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach(patch);
      });
    },
  };
}

/**
 * Bakes the sky into an environment map the metal can actually reflect.
 *
 * Without this every `metalness` surface has nothing to mirror and the renderer falls back to a
 * flat grey, which is exactly why a painted airframe reads as plastic: real aluminium is legible
 * because you can see the horizon bend across the cowling and the sun flare down the wing. The
 * dome is rendered into a cube once per round and prefiltered to roughness mips, so a rough
 * surface gets a blurred sky and polished glass gets the sun's own disc.
 *
 * It costs one offscreen pass at load time and nothing per frame.
 */
export function buildEnvironment(renderer, theme = null) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileCubemapShader();

  // A private scene holding only the dome: the land must not appear in the reflections, or the
  // aircraft ends up reflecting a green smear it is flying over.
  const envScene = new THREE.Scene();
  const dome = buildSky(theme);
  // The dome is drawn for a camera inside it; the cube camera sits at the origin, so it has to be
  // shrunk to keep the horizon at a believable distance rather than the sphere's own radius.
  dome.geometry.dispose();
  dome.geometry = new THREE.SphereGeometry(100, 32, 24);
  envScene.add(dome);

  // A ground disc below the horizon: sky above, lit haze below, which is what a wing actually
  // mirrors when it is banked toward the earth. Without it the reflection goes black and reads
  // as a hole in the paint.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(99, 32),
    new THREE.MeshBasicMaterial({ color: theme?.fog ?? PALETTE.fog, side: THREE.DoubleSide }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -14;
  envScene.add(floor);

  const target = pmrem.fromScene(envScene, 0.02, 0.1, 400);
  dome.geometry.dispose();
  dome.material.map?.dispose();
  dome.material.dispose();
  floor.geometry.dispose();
  floor.material.dispose();
  pmrem.dispose();
  return target.texture;
}
