// Time of day: one clock that drives the sun, the moon, the stars, the sky's palette and the cloud
// lighting, so a round flown at dawn actually looks like dawn and the same round flown at midnight
// actually looks like midnight.
//
// The model is deliberately astronomical enough to be believable and no more:
//
//   * The sun rides a circle whose height and azimuth come from a settable hour. `hour` is a float
//     in [0, 24), so 6.5 is half past six in the morning local time.
//   * The moon is opposite the sun, with its own phase, so a night with a full moon is lit and a
//     night with a new moon is genuinely dark.
//   * Stars are a point cloud on the same dome, faded in by how far the sun is below the horizon.
//     A star field that is visible at noon is the tell that a "night" was a filter, not a sun.
//   * The palette is keyed to the sun's elevation in degrees, not to a table of named times, so
//     every hour has its own colour and nothing steps.
//
// The phase boundaries are the useful part for the game: `isNight()` is what air defence and the
// HUD read, and `lightLevel()` is a single 0..1 number that anything can scale by.

import * as THREE from '../vendor/three.module.min.js';
import { WORLD } from './config.js';
import { rethemeLights } from './sky.js';

/** Clamps to a range. */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Degrees to radians. */
const RAD = Math.PI / 180;

/**
 * The sun's direction for a given hour, as a unit vector pointing FROM the ground TOWARD the sun.
 *
 * The path is a great circle tilted by `tilt` from vertical, which is what gives a summer arc that
 * rises in the north-east and sets in the north-west rather than straight overhead. `azimuth0` is
 * where the sun is at noon; the arc swings around it.
 */
export function sunDirection(hour, { tilt = 62, azimuth0 = 2.5 } = {}) {
  // 0 at midnight, 12 at noon: the hour angle runs half a turn per twelve hours.
  const h = ((hour - 12) / 24) * Math.PI * 2;
  // The sun's altitude follows cos(h), scaled so a tilt of 62 degrees gives a 28 degree noon sun.
  const alt = Math.cos(h) * (90 - tilt) * RAD;
  const az = azimuth0 + Math.sin(h) * 0.9;
  const cosAlt = Math.cos(alt);
  return new THREE.Vector3(
    Math.sin(az) * cosAlt,
    Math.sin(alt),
    Math.cos(az) * cosAlt,
  ).normalize();
}

/** The sun's altitude in degrees for an hour: negative below the horizon. */
export function sunAltitude(hour, opts = {}) {
  const d = sunDirection(hour, opts);
  return Math.asin(clamp(d.y, -1, 1)) / RAD;
}

/**
 * A 0..1 measure of how much light there is. 1 is full day, 0 is astronomical night, and the band
 * between is twilight. Used by the sky, the lights, the stars and anything that wants to know
 * whether it is dark without testing the clock itself.
 */
export function lightLevel(hour) {
  const alt = sunAltitude(hour);
  // Full daylight above 12 degrees, full night below -12: a twenty-four degree band for the whole
  // of dawn and dusk, which is roughly what a real one feels like from the cockpit.
  return clamp((alt + 12) / 24, 0, 1);
}

/** True when the sun is far enough down that the world should be lit by the moon. */
export function isNight(hour) {
  return sunAltitude(hour) < -2;
}

/** True during the two bands either side of the horizon. */
export function isTwilight(hour) {
  const alt = sunAltitude(hour);
  return alt > -12 && alt < 8;
}

/** A readable phase name, for the HUD and the debrief. */
export function phaseName(hour) {
  const alt = sunAltitude(hour);
  if (alt > 8) return 'day';
  if (alt > -2) return hour < 12 ? 'dawn' : 'dusk';
  if (alt > -12) return hour < 12 ? 'first light' : 'last light';
  return 'night';
}

/** Interpolates between two hex colours in linear space and returns a THREE.Color. */
function mix(a, b, t) {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return ca.lerp(cb, clamp(t, 0, 1));
}

/**
 * The sky's palette for an hour. Returns the same shape a round's `sky` block has, so the existing
 * sky/light/haze builders take it unchanged — the clock is a theme generator, not a second
 * rendering path.
 *
 * The colours are keyed to sun altitude:
 *   * +30 and above: a deep blue zenith with a pale horizon; the middle of the day.
 *   * 5 to 30: warming; the zenith keeps its blue while the horizon goes to cream.
 *   * -6 to 5: the golden band. The horizon burns, the zenith goes violet, the light turns orange.
 *   * below -6: blue hour into night. The zenith goes near-black, the horizon a cold indigo.
 */
export function paletteFor(hour, base = {}) {
  const alt = sunAltitude(hour);
  const night = alt < -6;

  // Key stops, defined as (altitude, colour) and interpolated, so nothing steps at a boundary.
  const topDay = '#0a2a5e';
  const topDusk = '#2a2a5e';
  const topNight = '#05070f';
  const midDay = '#2c6499';
  const midDusk = '#7a5a7a';
  const midNight = '#0a1020';
  const lowDay = '#7fa8c4';
  const lowDusk = '#e08a52';
  const lowNight = '#141c2e';
  const horDay = '#d9e8f0';
  const horDusk = '#ffb070';
  const horNight = '#1a2436';

  // Two weights, not three bands: `day` fades in as the sun climbs, `dusk` as it approaches the
  // horizon. The first version keyed day off `alt > 20`, but this model's noon sun is only 28
  // degrees, so the day weight never left zero and every hour from dawn to dusk produced the same
  // palette. The scale below is matched to the arc the sun actually flies.
  const dayT = clamp((alt - 4) / 26, 0, 1);
  const duskT = clamp((alt + 10) / 20, 0, 1);

  // Below the horizon the dusk colours are held, then blended into night: `nightT` is how far the
  // sun is past the end of twilight.
  const nightT = clamp((-alt - 10) / 10, 0, 1);

  const top = night ? mix(topNight, topDusk, duskT) : mix(topDusk, topDay, dayT);
  const mid = night ? mix(midNight, midDusk, duskT) : mix(midDusk, midDay, dayT);
  const low = night ? mix(lowNight, lowDusk, duskT) : mix(lowDusk, lowDay, dayT);
  const horizon = night ? mix(horNight, horDusk, duskT) : mix(horDusk, horDay, dayT);

  // The sun's own colour: white overhead, orange on the horizon, and it does not matter below it.
  const sunWarm = clamp(1 - (alt - 2) / 34, 0, 1);
  const sunColour = mix('#fffaf0', '#ff8a3c', sunWarm);
  // The key light: a moonlit night is dim and blue, not black.
  const light = night ? mix('#4a5a80', '#8a7a6a', duskT) : mix('#ffd0a0', '#fff6e6', dayT);

  const theme = {
    top: `#${top.getHexString()}`,
    mid: `#${mid.getHexString()}`,
    low: `#${low.getHexString()}`,
    horizon: `#${horizon.getHexString()}`,

    // The haze follows the horizon, slightly bluer, because that is what distance does.
    fog: horizon.clone().lerp(new THREE.Color('#8fa8bc'), 0.35).getHex(),
    haze: horizon.clone().lerp(new THREE.Color('#7f9ab0'), 0.5).getHex(),
    hazeWarm: sunColour.clone().lerp(new THREE.Color('#ffd9a0'), 0.4).getHex(),
    hazeStrength: 0.16 + 0.39 * (1 - nightT),
    hazeScaleLow: 1600 + 1400 * (1 - nightT),

    sun: sunColour.getHex(),
    // Light falls off smoothly from noon to astronomical night: the exponent keeps a usable
    // twilight glow rather than dropping straight to black at sunset.
    sunIntensity: (0.10 + 3.0 * dayT) * (nightT > 0 ? 1 - nightT * 0.55 : 1),
    hemi: 0.22 + 1.03 * dayT,
    sunAzimuth: 0, // filled by the caller from the direction vector
    sunElevation: 0,

    // Carried for the systems that add to a theme rather than replace it.
    hour,
    lightLevel: lightLevel(hour),
    isNight: night,
    phase: phaseName(hour),
    starOpacity: clamp(-alt / 9, 0, 1),
    moonOpacity: clamp((6 - alt) / 14, 0, 1),
    keyLight: `#${light.getHexString()}`,
  };

  // A round may pin its own *weather* through the clock — the fog colour and strength of a storm,
  // for one. It may not pin the light: the sun's intensity and colour are the clock's whole job, and
  // letting a round override them is what left every hour of the day lit like noon.
  for (const k of ['fog', 'haze', 'hazeWarm']) {
    if (base[k] !== undefined) theme[k] = base[k];
  }
  // The storm's haze is thicker than the clock would make it, but still follows the light: a storm
  // at night is darker than a storm at noon.
  if (base.hazeStrength !== undefined) {
    theme.hazeStrength = base.hazeStrength * (0.35 + 0.65 * (1 - nightT));
  }
  return theme;
}

/**
 * The star field: a point cloud on a large sphere, with per-star size and colour so it is not a
 * uniform dusting. Faded by the theme's `starOpacity`, which is zero by day.
 *
 * The stars are placed on the celestial sphere and ride with the sky dome, so they do not parallax
 * as the aircraft moves: that is what makes them read as distant rather than as snow.
 */
export function buildStars(count = 1400, radius = 12000) {
  const positions = new Float32Array(count * 3);
  const colours = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  let s = 0x5eed1234;
  const rnd = () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  const c = new THREE.Color();
  for (let i = 0; i < count; i += 1) {
    // A hemisphere. `theta` is measured from the zenith, so the point's height above the horizon is
    // directly `cos(theta)` — the obvious formula, and the one the first version got wrong by
    // writing `cos(theta) * 0.5 + 0.5`. That squashed the whole field into the top of the sky: the
    // lowest star sat at 26 degrees of elevation, so a scene looking anywhere near the horizon was
    // starless no matter how bright the points were. The fix is one term, and it is the difference
    // between stars and no stars in every shot that frames the sky the way a pilot actually sees it.
    const u = rnd();
    const v = rnd();
    // u=0 at the zenith, u=1 at the horizon. acos keeps the density even over the cap.
    const theta = Math.acos(u);
    const phi = v * Math.PI * 2;
    const sinT = Math.sin(theta);
    const r = radius;
    positions[i * 3] = sinT * Math.cos(phi) * r;
    positions[i * 3 + 1] = Math.cos(theta) * r;
    positions[i * 3 + 2] = sinT * Math.sin(phi) * r;

    // Real star colour is mostly white with a blue or orange cast. A few bright ones carry it.
    const t = rnd();
    if (t < 0.12) c.setHex(0xaaccff);
    else if (t < 0.2) c.setHex(0xffddaa);
    else c.setHex(0xffffff);
    // Brightness is biased low on purpose. A sky where every star is as bright as every other reads
    // as noise; the eye reads a starfield by a few bright ones and a lot of faint ones.
    const brightness = 0.35 + Math.pow(rnd(), 2.2) * 0.65;
    colours[i * 3] = c.r * brightness;
    colours[i * 3 + 1] = c.g * brightness;
    colours[i * 3 + 2] = c.b * brightness;
    sizes[i] = 0.6 + rnd() * 2.2;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.PointsMaterial({
    // Sized in PIXELS, not metres. These points sit 12 km out, so with attenuation on they were
    // scaled down to a fraction of a pixel and the night sky rendered starless no matter how high
    // the opacity went. A star is a point source: constant screen size is also the correct look.
    size: 2.4,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    blending: THREE.AdditiveBlending,
    // ACES tone mapping, which the renderer uses for everything else, maps a dim additive point
    // down to nearly zero: a star at luminance 0.5 came out indistinguishable from the sky. Stars
    // are emissive point sources at a fixed brightness and are exactly the case tone mapping should
    // not touch, so they opt out. This is what turned a starless sky into a sky with stars.
    toneMapped: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'stars';
  points.frustumCulled = false;
  // Drawn after the sky dome (which is renderOrder -1) so the dome cannot cover them.
  points.renderOrder = 1;
  points.userData.setOpacity = (o) => { material.opacity = o; points.visible = o > 0.01; };
  return points;
}

/**
 * The moon: a disc with a phase, drawn as a textured sprite so the terminator is visible rather
 * than a flat circle.
 *
 * The phase is painted into a canvas: the lit part is a crescent whose width is `phase` (0 = new,
 * 1 = full). A halo is drawn behind it, scaled by the phase, so a full moon lights the sky around
 * it and a new moon is only its own faint earthshine.
 */
export function buildMoon(radius = 11000) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  const paintMoon = (phase) => {
    ctx.clearRect(0, 0, size, size);
    const c = size * 0.5;
    const r = size * 0.30;

    // Halo first, so the disc sits on top of it.
    const halo = ctx.createRadialGradient(c, c, r * 0.9, c, c, size * 0.5);
    halo.addColorStop(0, `rgba(200,215,255,${0.30 * phase + 0.06})`);
    halo.addColorStop(1, 'rgba(180,200,255,0)');
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, size, size);

    // Unlit disc: earthshine, so the dark limb is not simply missing.
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(70,82,110,0.55)';
    ctx.fill();

    // The lit part: a crescent whose inner edge is an ellipse of width (1 - 2*phase).
    const k = 1 - phase * 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(c, c, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    if (Math.abs(k) < 0.02) {
      // Near half moon: a straight-edged half disc.
      ctx.rect(c, c - r, r, r * 2);
    } else {
      ctx.ellipse(c, c, Math.abs(k) * r, r, 0, 0, Math.PI * 2);
    }
    ctx.fillStyle = '#eef2ff';
    // For a waning moon the lit side is on the other side, so the ellipse is shifted rather than
    // drawn from the centre.
    if (k < 0) {
      ctx.beginPath();
      ctx.rect(c, c - r, r, r * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.ellipse(c, c, Math.abs(k) * r, r, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    } else {
      ctx.fill();
    }
    ctx.restore();

    // A little maria, so the disc has features rather than being a white blob.
    ctx.globalAlpha = 0.16 * phase;
    ctx.fillStyle = '#8f9ab8';
    for (const [dx, dy, rr] of [[-0.10, -0.08, 0.10], [0.08, 0.06, 0.07], [-0.02, 0.16, 0.06]]) {
      ctx.beginPath();
      ctx.arc(c + dx * size, c + dy * size, rr * size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  paintMoon(0.72);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.SpriteMaterial({
    map: texture, transparent: true, opacity: 0, depthWrite: false, fog: false,
    blending: THREE.AdditiveBlending,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(radius * 0.085);
  sprite.name = 'moon';
  sprite.renderOrder = -1;
  sprite.userData.set = ({ opacity, phase }) => {
    material.opacity = opacity;
    sprite.visible = opacity > 0.01;
    if (phase !== undefined) { paintMoon(phase); texture.needsUpdate = true; }
  };
  return sprite;
}

/**
 * The clock. Holds the hour, advances it if the caller asks, and pushes the whole set of systems to
 * match. This is the one object the game talks to.
 */
export function createDayCycle({
  hour = 8.5, sun, moon, stars, sky, lights, haze, scene, speed = 0,
} = {}) {
  let current = clamp(hour, 0, 23.999);
  let base = {};
  let sunTilt = 62;
  let azimuth0 = 2.5;

  const state = {
    hour: current,
    phase: 'day',
    lightLevel: 1,
    night: false,
  };

  function apply() {
    const theme = paletteFor(current, base);
    const dir = sunDirection(current, { tilt: sunTilt, azimuth0 });
    const alt = Math.asin(clamp(dir.y, -1, 1)) / RAD;
    theme.sunAzimuth = Math.atan2(dir.x, dir.z);
    theme.sunElevation = alt * RAD;

    state.hour = current;
    state.phase = theme.phase;
    state.lightLevel = theme.lightLevel;
    state.night = theme.isNight;

    if (sky?.userData?.repaint) sky.userData.repaint(theme);
    // `sun` is a handle, not a mesh: {sprite, direction, retheme}. retheme re-aims `direction` in
    // place from the theme's azimuth/elevation, so the sprite is moved after it, not before.
    if (sun?.retheme) sun.retheme(theme);
    if (sun?.sprite) {
      const sd = sun.direction ?? dir;
      sun.sprite.position.copy(sd).multiplyScalar(WORLD.size * 2.4);
      sun.sprite.visible = alt > -8;
    }
    if (moon) {
      moon.position.copy(dir).multiplyScalar(-11000);
      // The moon's phase is not the sun's, so it is set from the hour's own slow cycle: this makes
      // a round that spans several hours see the moon change, which is a nice thing to notice.
      const phase = 0.5 + 0.5 * Math.cos(((current - 3) / 24) * Math.PI * 2);
      moon.userData.set({
        opacity: theme.moonOpacity * (theme.isNight ? 1 : 0.0),
        phase,
      });
    }
    if (stars?.userData?.setOpacity) stars.userData.setOpacity(theme.starOpacity);
    if (lights?.userData?.sun) {
      // rethemeLights re-aims the key light from the direction vector, so the same vector the
      // sprite was moved with is the one the shadows are cast along.
      rethemeLights(lights, theme, sun?.direction ?? dir);
    }
    if (haze?.retheme) haze.retheme(theme, sun?.direction ?? dir);
    return theme;
  }

  return {
    /** The current theme, recomputed. */
    theme: apply,
    /** Sets the clock and pushes everything to match. */
    setHour(h) {
      current = clamp(h, 0, 23.999);
      return apply();
    },
    /** Advances the clock by a number of hours; negative runs backwards. */
    advance(hours) {
      current = (current + hours + 24 * 1000) % 24;
      return apply();
    },
    /** The round's own palette, laid underneath the clock's: fog and haze survive. */
    setBase(next) { base = next ?? {}; return apply(); },
    /** Where the sun rises, in radians of azimuth: shifts the whole day around the compass. */
    setArc({ tilt, azimuth }) {
      if (tilt !== undefined) sunTilt = tilt;
      if (azimuth !== undefined) azimuth0 = azimuth;
      return apply();
    },
    /** How many hours pass per real second. Zero freezes the clock. */
    setSpeed(h) { speed = h; return apply(); },
    update(dt) { if (speed) { this.advance(speed * dt / 3600); } },
    get hour() { return current; },
    get state() { return { ...state }; },
    get speed() { return speed; },
    isNight: () => state.night,
    lightLevel: () => state.lightLevel,
  };
}
