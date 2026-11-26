// Every tuning number, colour and world dimension in one place. Distances are metres, speeds
// metres per second, angles radians. The simulation runs on a fixed step so a frame's length
// never changes how the aircraft flies.
//
// The campaign lives here too: five sorties, each with its own wind, cloud, visibility, course
// geometry and par score. Everything a round changes about the world is data, so the flight model
// and the renderer both read the same numbers.

/** The simulation's fixed step, in seconds: 120 updates a second whatever the display's rate. */
export const STEP = 1 / 120;

export const WORLD = {
  /** The heightfield is this many metres across, centred on the origin. */
  size: 9000,
  /**
   * Segments per side of the heightfield mesh: (this + 1) squared vertices.
   *
   * At 260 the quads were 35 m across, which is coarse enough that a ridge line turns into a
   * staircase at the silhouette and the ground reads as faceted card. 384 puts a quad every 23 m
   * — 148k vertices, still one draw call, and the ridgelines hold their shape out to the horizon.
   */
  grid: 384,
  seed: 20261126,
  /** Highest peak the noise may reach, before the runway basin is flattened. */
  peak: 1150,
};

/** The airfield the sortie starts and ends on: a flat basin cut into the foothills. */
export const RUNWAY = {
  x: -700,
  z: 1250,
  elevation: 58,
  length: 1600,
  width: 48,
  /**
   * The direction an aircraft takes off in, in the flight model's own heading convention: 0 points
   * along -Z (up the valley, which is where the course runs) and positive turns right. The strip
   * is laid along this line, so the departure end is behind the start and the course is ahead.
   */
  heading: -Math.PI * 0.06,
  /** Radius over which the terrain blends from basin floor up to the surrounding hills. */
  basinRadius: 1150,
};

export const AIRCRAFT = {
  /** Wingspan, used by the model builder and for the crash extents. */
  span: 11.2,
  length: 8.6,
  /** Mass in kilograms, only used to make the fuel burn read sensibly. */
  mass: 1150,

  /** Speed the airframe is trimmed for: control authority is 1 here. */
  cruise: 68,
  /** Below this the wing stops carrying the aircraft and the nose falls. */
  stall: 27,
  /** Never faster than this, however steep the dive. */
  vne: 132,

  /** Acceleration from a full throttle, in m/s per second, before drag. */
  maxThrust: 11.5,
  /** Quadratic drag coefficient: deceleration at speed v is drag * v * v. */
  drag: 0.00082,
  /** How much of gravity a climb takes out of the airspeed, 0 to 1. */
  climbCost: 0.92,

  /** Degrees per second at cruise speed, and how they fade at the extremes of the envelope. */
  pitchRate: 1.35,
  rollRate: 3.1,
  yawRate: 0.55,
  /** Above cruise the controls stiffen by this much per metre per second. */
  stiffening: 0.004,

  /** Fraction of a bank turned into a heading change each second, the wing's own coordination. */
  coordination: 0.92,

  fuel: 96,
  /** Kilograms a second at full throttle, and the fraction that idle still burns. */
  fuelBurn: 0.42,
  idleBurn: 0.06,

  health: 100,
  /** Health taken by a hard touchdown, scaled by how far past the limits it was. */
  crashDamage: 46,

  /** Two notches of flap: each lowers the stall by this fraction and adds this much drag. */
  flapStallRelief: 0.11,
  flapDrag: 0.32,
  /** Flaps hold the aircraft up when the wing is slow: sink lost per notch, in m/s. */
  flapSupport: 3.6,

  /** Crosswind above this many metres a second starts costing airframe on touchdown. */
  crosswindLimit: 5.5,
};

/**
 * The gate course's shared numbers. Each round supplies its own count, radius and clearance
 * profile; these are what every round has in common.
 */
export const MISSION = {
  radius: 34,
  /** The gate ring is drawn this much thicker than a hairline so it reads at distance. */
  tube: 2.6,
  /** Gate centres this far apart at the closest, so the course never folds onto itself. */
  spacing: 540,
};

/**
 * The campaign: five sorties flown from Harrow Field, in rising difficulty. Each entry is the
 * complete description of a round's world, so loading a round is just handing these numbers to
 * the terrain-independent parts of the sim.
 *
 * `wind.from` is meteorological: the compass bearing the wind blows FROM, so 270 is a westerly
 * blowing toward the east. `wind.speed` is in metres a second.
 */
export const CAMPAIGN = [
  {
    id: 0,
    name: 'FIRST LIGHT',
    subtitle: 'Calm air, clear sky',
    brief:
      'The valley is still. Six gates out and back, ceiling unlimited, and a light westerly that '
      + 'barely moves the windsock. Learn the aircraft here: the stall, the turn, the flare.',
    gates: 6,
    radius: 38,
    time: 340,
    fuel: 96,
    wind: { from: 258, speed: 2.4 },
    turbulence: 0,
    rain: 0,
    visibility: 13500,
    difficulty: 1.0,
    objective: 'Thread six gates, then land back at Harrow Field.',
    debrief: 'A clean first sortie. The aircraft is yours now.',
    sky: {
      // Golden hour: a deep blue zenith falling through rose to an orange horizon. The contrast
      // between the cold top of the frame and the warm bottom is what makes the still read as a
      // photograph rather than a flat blue day.
      top: '#0e2a55', mid: '#2a5589', low: '#8d6f7d', horizon: '#ffc089',
      fog: 0xefab74, sun: 0xffc07a, sunIntensity: 3.6, hemi: 1.15,
      sunAzimuth: 2.78, sunElevation: 0.16,
    },
    course: {
      shape: 'out-and-back',
      startAlong: 900, outAlong: 4300,
      outLateral: [-130, -290], homeLateral: [330, 190],
      wiggleAmp: 60, wiggleFreq: 1.5,
      clearance: { base: 95, arc: 190, min: 150, perT: 420 },
    },
  },
  {
    id: 1,
    name: 'VALLEY WIND',
    subtitle: 'Crosswind on the strip',
    brief:
      'A north-westerly at nine metres a second has set up across the runway. The course is a gate '
      + 'longer and the valley is funnelling the wind through the gaps, so hold a crab on every '
      + 'leg and expect the flare to want to weathercock on you.',
    gates: 7,
    radius: 36,
    time: 320,
    fuel: 92,
    wind: { from: 302, speed: 9 },
    turbulence: 0.35,
    rain: 0,
    visibility: 11500,
    difficulty: 1.15,
    objective: 'Seven gates with a nine-metre crosswind. Land it straight.',
    debrief: 'You flew the crab instead of fighting it. That is the whole trick.',
    sky: {
      top: '#1d5695', mid: '#4680ba', low: '#9ac0d6', horizon: '#e2ecef',
      fog: 0xc2d7e2, sun: 0xfff0d4, sunIntensity: 2.5, hemi: 1.05,
      sunAzimuth: 2.05, sunElevation: 0.58,
    },
    course: {
      shape: 'out-and-back',
      startAlong: 900, outAlong: 4600,
      outLateral: [-150, -320], homeLateral: [360, 200],
      wiggleAmp: 90, wiggleFreq: 1.7,
      clearance: { base: 90, arc: 230, min: 150, perT: 470 },
    },
  },
  {
    id: 2,
    name: 'CLOUD BASE',
    subtitle: 'A climb into the murk',
    brief:
      'The cloud has come down to five hundred feet and the course climbs straight into it. '
      + 'Eight gates, most of them with nothing outside the windscreen but grey. Fly the heading, '
      + 'fly the numbers, and trust the gate when it appears.',
    gates: 8,
    radius: 34,
    time: 340,
    fuel: 96,
    wind: { from: 196, speed: 7 },
    turbulence: 0.5,
    rain: 0.12,
    visibility: 5800,
    difficulty: 1.3,
    objective: 'Eight gates, most of them inside cloud. Climb to the tops.',
    debrief: 'Instrument flying with a stick and a gate. Neatly done.',
    sky: {
      top: '#5d6f80', mid: '#8395a3', low: '#aab8c2', horizon: '#d8dfe3',
      fog: 0xc6d0d6, sun: 0xf2f4f4, sunIntensity: 1.35, hemi: 1.35,
      sunAzimuth: 2.2, sunElevation: 0.44,
    },
    course: {
      shape: 'climb',
      startAlong: 820, outAlong: 4000,
      outLateral: [-120, -260], homeLateral: [300, 170],
      wiggleAmp: 70, wiggleFreq: 1.4,
      clearance: { base: 120, arc: 360, min: 200, perT: 780 },
    },
  },
  {
    id: 3,
    name: 'CANYON RUN',
    subtitle: 'Low, fast, tight',
    brief:
      'No ceiling worth the name and a gorge that will not forgive a lazy turn. Eight gates, most '
      + 'of them under a hundred metres off the rock, and twenty seconds less on the clock than '
      + 'you would like. Fly it fast and fly it precisely.',
    gates: 8,
    radius: 30,
    time: 280,
    fuel: 74,
    wind: { from: 342, speed: 6 },
    turbulence: 0.75,
    rain: 0,
    visibility: 14000,
    difficulty: 1.55,
    objective: 'Eight gates down in the gorge. Low, fast, precise.',
    debrief: 'That is the run the old hands talk about. Except they did it slower.',
    sky: {
      top: '#12457f', mid: '#2f6ba6', low: '#7fa9c8', horizon: '#d6e4ea',
      fog: 0xaec9d8, sun: 0xfff2d8, sunIntensity: 2.9, hemi: 1.0,
      sunAzimuth: 1.72, sunElevation: 0.66,
    },
    course: {
      shape: 'canyon',
      startAlong: 780, outAlong: 3400,
      outLateral: [-90, -200], homeLateral: [230, 130],
      wiggleAmp: 150, wiggleFreq: 2.6,
      clearance: { base: 46, arc: 34, min: 52, perT: 110 },
    },
    /**
     * The gorge itself. `from`/`to` are up-valley distances in the runway's frame, `center` is the
     * lateral offset of the centreline and `floorHalf` the half-width of the flat floor. The gates
     * are laid between `outLateral` and `homeLateral`, both of which sit inside the floor.
     */
    gorge: {
      from: 600, to: 3800,
      center: 15, wander: 60, wanderScale: 560,
      floorHalf: 320, wallRun: 150, wallHeight: 300,
      taperIn: 560, taperOut: 700,
    },
  },
  {
    id: 4,
    name: 'STORM FRONT',
    subtitle: 'The last one',
    brief:
      'A north-easterly gale at seventeen metres a second, cloud to the deck and rain on the glass. '
      + 'Ten gates on a wide circuit, and the wind will take more off your ground speed on the way '
      + 'out than you think. There is no margin left in the fuel. Bring her home.',
    gates: 10,
    radius: 33,
    time: 380,
    fuel: 100,
    wind: { from: 34, speed: 17 },
    turbulence: 1.0,
    rain: 0.85,
    visibility: 4400,
    difficulty: 1.9,
    objective: 'Ten gates in a gale, then a crosswind landing in the rain.',
    debrief: 'Storm front, ten gates, and a landing in one piece. That is the campaign.',
    sky: {
      top: '#2b3540', mid: '#48555f', low: '#6d7981', horizon: '#98a2a7',
      fog: 0x8b959b, sun: 0xd8dde0, sunIntensity: 0.75, hemi: 1.15,
      sunAzimuth: 1.35, sunElevation: 0.30,
    },
    course: {
      shape: 'oval',
      startAlong: 900, outAlong: 4800,
      outLateral: [-240, -430], homeLateral: [430, 240],
      wiggleAmp: 80, wiggleFreq: 1.2,
      clearance: { base: 140, arc: 300, min: 220, perT: 500 },
    },
  },
];

/** Colours, in one palette so the terrain, sky and aircraft stay in one style. */
export const PALETTE = {
  skyTop: 0x1f4f8f,
  skyHorizon: 0x9fc4de,
  sun: 0xfff3dd,
  fog: 0xa8c6dc,

  grassLow: 0x5f7a3a,
  grassHigh: 0x7c8f4a,
  forest: 0x33512b,
  rock: 0x7a7268,
  rockDark: 0x4e4842,
  rockLight: 0x9c948a,
  snow: 0xf4f7fa,
  sand: 0xc8b184,
  water: 0x1d4a63,

  runway: 0x3a3d42,
  runwayLine: 0xe8e6df,
  taxiway: 0x4a4d53,

  hull: 0xe6e8ec,
  hullAccent: 0xb8342e,
  hullDark: 0x2b3038,
  glass: 0x8fb6c9,
  propeller: 0x22262c,

  ring: 0x2fd6a8,
  ringDone: 0x5b6a72,
  ringNext: 0xffc23d,
};

/** Where the sun sits, as a direction the light travels from. */
export const SUN = { azimuth: 2.35, elevation: 0.62, intensity: 2.55 };

/**
 * The wind as a vector in the world's own axes, from a meteorological bearing and a speed.
 *
 * A wind FROM the north blows toward the south, and south is +Z (heading 0 points along -Z), so
 * the mapping is a sign flip on both components: x = -sin(from), z = +cos(from).
 */
export function windVector(fromDeg, speed) {
  const a = (fromDeg * Math.PI) / 180;
  return { x: -Math.sin(a) * speed, z: Math.cos(a) * speed };
}

/** Total campaign par: what a tidy pilot should score across all five rounds. */
export function campaignPar() {
  return CAMPAIGN.reduce((sum, r) => sum + Math.round(1000 * r.difficulty), 0);
}
