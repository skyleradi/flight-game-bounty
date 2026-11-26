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
  const { sun, hemi, ambient } = group.userData;
  sun.color.setHex(theme.sun);
  sun.intensity = theme.sunIntensity;
  sun.position.copy(sunDir).multiplyScalar(4200);
  hemi.intensity = theme.hemi;
  ambient.intensity = theme.sunIntensity < 1.2 ? 0.55 : 0.35;
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

  const count = Math.round(34 * cover);
  const puffs = [];
  for (let i = 0; i < count; i += 1) {
    const sprite = new THREE.Sprite(material.clone());
    const angle = rnd() * Math.PI * 2;
    const radius = 900 + rnd() * WORLD.size * 0.42;
    const scale = 900 + rnd() * 1500;
    sprite.position.set(
      Math.cos(angle) * radius,
      (900 + rnd() * 1500) * deck,
      Math.sin(angle) * radius,
    );
    sprite.scale.set(scale, scale * (0.4 + rnd() * 0.16), 1);
    sprite.material.opacity = (0.34 + rnd() * 0.4) * Math.min(1, cover * 1.1);
    group.add(sprite);
    puffs.push({ sprite, drift: (3.5 + rnd() * 6) * drift });
  }

  return {
    group,
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

/** Distance haze: fog in the sky's horizon colour, so the far edge of the land dissolves. */
export function applyFog(scene, theme = null) {
  const near = theme ? Math.max(300, theme.visibility * 0.16) : 2600;
  const far = theme ? theme.visibility : 11500;
  scene.fog = new THREE.Fog(theme?.fog ?? PALETTE.fog, near, far);
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
