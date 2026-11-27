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
   * staircase at the silhouette and the ground reads as faceted card. 384 put a quad every 23 m,
   * 512 a quad every 17.6 m. 768 is 590k vertices and a 13 m quad, which is where a ridge crest
   * stops being a chain of visible facets and starts reading as a line — the difference between
   * "mountain" and "origami" in a still. It is one draw call and still builds in a second.
   */
  grid: 768,
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

  /**
   * Afterburner, on the throttle quadrant's own detent. A limited charge that multiplies thrust and
   * lifts the never-exceed speed, so the pilot can trade a burst of energy for a tighter line
   * through the gorge or a way out of a bad approach. It recharges slowly, which is what stops it
   * from being the answer to every corner: spend it on the straight and the next gate is flown at
   * whatever the wing will still give.
   */
  boost: {
    /** Thrust multiplier while lit. */
    thrust: 2.35,
    /** Extra top speed over VNE, in metres a second. */
    overspeed: 34,
    /** Charge, in seconds of continuous burn, and how long a full tank takes to come back. */
    capacity: 3.6,
    recharge: 12.0,
    /** How fast the burn winds up and down, so it hits as a shove and not as a step. */
    spool: 4.4,
    /** Fuel is drunk faster while lit. */
    burn: 3.1,
  },
};

/**
 * The air defence the later rounds put up.
 *
 * Two kinds, because a single one is a shooting gallery: **flak towers** are fixed, they track the
 * aircraft and throw a burst of tracer at it, and the answer is to break the line of sight or fly
 * outside their reach; **interceptors** are drones that actually chase, and the answer is to turn
 * inside them or outrun them on the boost. Both fire real projectiles that take real time to
 * arrive, so a hit is something the pilot could have seen coming.
 */
export const ENEMY = {
  /** A tracer's speed, metres a second. Slow enough to be visibly dodged at range. */
  bulletSpeed: 300,
  /** Rounds fired per second, and how far apart the pair in a burst sits. */
  fireRate: 3.2,
  burst: 3,
  /** How far a turret can see and shoot, metres. */
  range: 1150,
  /** The cone a turret can actually hit inside, radians. */
  spread: 0.028,
  /** Damage one round does to the airframe. */
  damage: 4.2,
  /** A turret's own hit points: they can be strafed, and killing one is worth points. */
  turretHealth: 26,
  /** Interceptor behaviour. */
  drone: {
    speed: 78,
    turn: 1.15,
    range: 900,
    health: 18,
    /** How far ahead of the aircraft a drone aims, seconds. */
    lead: 1.5,
    damage: 3.4,
    /** Range at which it stops patrolling and turns in. */
    engageRange: 2600,
    /**
     * Seconds the nose must stay inside the firing cone before the gun actually fires.
     *
     * This is the interceptor's whole fairness contract. A snapshot misses even when the geometry
     * momentarily lines up, so a hard break at the right moment beats a shot that was "aimed". It
     * also means an interceptor cannot hit on the first frame it sees you, which is what made the
     * old chase feel arbitrary.
     */
    settleTime: 0.55,
    /** Rounds per burst, and the pause after one. A stream would be a wall; a burst is readable. */
    burst: 4,
  },
  /** Points for a kill, before the round's difficulty scales it. */
  killScore: 60,
  /**
   * A surface-to-air missile site.
   *
   * The turret is a tax on flying straight: its tracers are fast and flat, and the answer is to be
   * somewhere else when they arrive. A SAM is a different problem. Its round follows, so the answer
   * is not distance but geometry — put the nose across it, make it turn, and out-turn the motor. That
   * is a second kind of defensive flying, which is what the campaign was missing: before this, every
   * ground threat could be beaten by the same manoeuvre.
   *
   * The numbers are deliberately patient. `reload` is long enough that a site gets two or three
   * shots at a pass, `turnRate` is below the aircraft's own so a hard break always wins, and `life`
   * is short enough that a round fired at long range runs out before it arrives. A SAM you cannot
   * out-turn is not a threat, it is a dice roll.
   */
  sam: {
    health: 34,
    /** How far it will engage, metres. Longer than the guns, because a missile carries. */
    range: 2300,
    /** Seconds between launches. */
    reload: 5.4,
    /** The round's motor and how hard it can turn. Under the aircraft's rate on purpose. */
    speed: 205,
    turnRate: 1.3,
    /** Seconds of flight: a round launched at extreme range coasts out before it arrives. */
    life: 8.5,
    /** Warhead. Two hits and a half kill an aircraft at full health. */
    damage: 24,
    /** Metres at which the warhead detonates. Forgiving, so near misses still hurt. */
    fuse: 17,
  },
  /**
   * A bomber: big, slow, and carrying enough to end a round if it gets through.
   *
   * The interceptors are a dogfight and the guns are a tax; neither asks the pilot to *stop*
   * something. A bomber flight does. It flies a straight line at a fixed speed toward the town, it
   * does not manoeuvre, and it has enough health that it takes a sustained pass rather than a
   * snapshot — so the round becomes about arriving with height and ammunition rather than about
   * surviving.
   */
  bomber: {
    health: 96,
    /** Metres a second. Slower than the aircraft by a factor of three, so it can always be caught. */
    speed: 46,
    /** The dorsal gun it defends itself with. */
    damage: 3.2,
    range: 820,
    burst: 3,
    /** Points for stopping one, before difficulty. A flight of three is a round's worth of score. */
    score: 260,
  },
  /**
   * What a flight leader is worth on top of its own kill.
   *
   * A leader flies tighter, leads its shots better and shoots at longer range, so downing one is a
   * different class of flying from downing a wingman. Paying the same for both would tell the
   * pilot the distinction the livery makes does not exist.
   */
  aceBonus: 3.0,
};

/**
 * The rocket pod: the aircraft's second weapon.
 *
 * The guns are a strafing tool — short range, small damage per round, and the pilot has to hold
 * the nose on the target while the rounds fly. The pod is the answer to the two situations the
 * guns cannot solve: a gun emplacement that has the aircraft in its cone, and an interceptor that
 * is turning inside the aircraft's turn circle. Both need a shot that does not require holding
 * still, which is what a guided round buys.
 *
 * The lock is deliberately slow and deliberately narrow. A lock that comes easily is a lock the
 * pilot never has to fly for, and the point of the weapon is the approach: get the nose inside the
 * cone, hold it there while the seeker settles, and the shot is yours.
 */
export const ORDNANCE = {
  /** Rounds carried. Four is two passes at two targets. */
  count: 4,
  /** Seconds the nose must stay inside the cone before the seeker has a solution. */
  lockTime: 1.15,
  /** Half-angle of the lock cone, radians. Roughly eight degrees. */
  coneAngle: 0.14,
  /** Maximum range at which a lock can be had, metres. */
  lockRange: 1500,
  /** Beyond this the seeker loses what it was tracking, so a lock has to be launched on. */
  loseRange: 1900,
  /** Metres a second at launch; the motor burns for `burn` seconds and then it coasts. */
  speed: 260,
  burn: 2.4,
  /** How hard the round can turn, radians a second. A hard break beats it; a straight run does not. */
  turnRate: 2.5,
  /** Damage on arrival. Enough to take a turret or an interceptor in one. */
  damage: 120,
  /** Seconds of flight before the motor gives out and the round falls away. */
  life: 7,
  /**
   * How far the seeker looks for its target each step, metres. Too small and the round tunnels
   * past a fast target between steps; too large and it turns onto something it never saw.
   */
  seekRadius: 45,
};

/**
 * The upgrade tree. Four lines, three levels each. Every `value` here is read by the flight model
 * through `aircraftWithKit`, so a purchase changes the aircraft rather than a menu label.
 */
export const UPGRADES = [
  {
    id: 'engine',
    name: 'Engine',
    blurb: 'Thrust and top speed. The straight-line answer to a tight course.',
    tiers: [
      { value: 0.09, cost: 260, label: '+9% thrust' },
      { value: 0.10, cost: 520, label: '+10% thrust' },
      { value: 0.12, cost: 900, label: '+12% thrust' },
    ],
  },
  {
    id: 'airframe',
    name: 'Airframe',
    blurb: 'Hit points, and a wing that forgives a firm landing.',
    tiers: [
      { value: 0.15, cost: 240, label: '+15% hull' },
      { value: 0.18, cost: 480, label: '+18% hull' },
      { value: 0.22, cost: 840, label: '+22% hull' },
    ],
  },
  {
    id: 'fuel',
    name: 'Fuel system',
    blurb: 'A bigger tank and a leaner burn. Range is a weapon.',
    tiers: [
      { value: 0.12, cost: 220, label: '+12% tank' },
      { value: 0.14, cost: 440, label: '+14% tank' },
      { value: 0.16, cost: 780, label: '+16% tank' },
    ],
  },
  {
    id: 'handling',
    name: 'Handling',
    blurb: 'Faster controls, a later stall, a longer afterburner.',
    tiers: [
      { value: 0.10, cost: 300, label: '+10% control' },
      { value: 0.12, cost: 560, label: '+12% control' },
      { value: 0.14, cost: 960, label: '+14% control' },
    ],
  },
];

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
    /** Local hour the sortie is flown at: the clock drives sun, moon, stars and palette. */
    hour: 7.4,
    /** The valley is friendly airspace: no air defence, so the first round teaches the airframe. */
    airDefence: { flak: 0, drones: 0 },
    objective: 'Thread six gates, then land back at Harrow Field.',
    debrief: 'A clean first sortie. The aircraft is yours now.',
    sky: {
      // A clean alpine morning. The palette is deliberately cool and neutral: a golden-hour sun
      // warm enough to tint the light orange turns every green slope tan and every grey cliff
      // beige, which is the single fastest way to make procedural land look like painted card.
      // A near-white sun at 42 degrees keeps the greens green and the rock grey, and it is the
      // angle that produces the long visible shadows a mountain range needs to read as one.
      top: '#0a2a5e', mid: '#2c6499', low: '#7fa8c4', horizon: '#d9e8f0',
      fog: 0xbcd2df, haze: 0xa8c4d8, hazeWarm: 0xffe4bc, hazeStrength: 0.55,
      hazeScaleLow: 3000,
      sun: 0xfff6e6, sunIntensity: 3.1, hemi: 1.25,
      sunAzimuth: 2.62, sunElevation: 0.74,
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
    hour: 15.6,
    /** A single flak site on the ridge, so the pilot meets ground fire with room to avoid it. */
    airDefence: { flak: 2, drones: 0 },
    /** One gun, and only one: the first taste of ground fire should not be a course requirement. */
    winCondition: { flak: 1, drones: 0 },
    objective: 'Seven gates with a nine-metre crosswind. Strafe the ridge gun. Land it straight.',
    debrief: 'You flew the crab instead of fighting it. That is the whole trick.',
    sky: {
      top: '#164d8f', mid: '#3f7cb8', low: '#95bdd8', horizon: '#dfeaef',
      fog: 0xbed4e0, haze: 0xa4c2d8, hazeWarm: 0xffeed2, hazeStrength: 0.5,
      hazeScaleLow: 3000, sun: 0xfff8ec, sunIntensity: 2.9, hemi: 1.2,
      sunAzimuth: 2.05, sunElevation: 0.66,
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
    hour: 11.2,
    airDefence: { flak: 3, drones: 1 },
    /**
     * One gun tower has to come down.
     *
     * Deliberately a turret and not the interceptor: a static gun sits on a ridge and can be found
     * and strafed, while a drone in five kilometres of visibility is a target the pilot may never
     * see. A requirement the pilot cannot satisfy is not difficulty, it is a stuck round.
     */
    winCondition: { flak: 1, drones: 0 },
    objective: 'Eight gates, most of them inside cloud. Silence the ridge gun.',
    debrief: 'Instrument flying with a stick and a gate. Neatly done.',
    sky: {
      top: '#55677a', mid: '#7d90a0', low: '#a6b5c0', horizon: '#d4dce1',
      fog: 0xc2ccd3, haze: 0xbfc9d0, hazeWarm: 0xe6ebee, hazeStrength: 1.15,
      hazeScaleLow: 1700, sun: 0xf4f6f6, sunIntensity: 1.7, hemi: 1.4,
      sunAzimuth: 2.2, sunElevation: 0.52,
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
    hour: 18.9,
    /** The gorge is a shooting gallery: guns on the rims and drones running the floor. */
    airDefence: { flak: 4, drones: 2, sams: 1 },
    /**
     * Two of the four rim guns have to come down before the course counts as flown.
     *
     * The gorge is the one round whose terrain already asks the pilot to fly low and slow through
     * a slot; putting two guns on the rim turns that slot into a decision — run it clean and take
     * the fire, or spend a pass and a burst of afterburner to silence the guns first. Either answer
     * is flying, which is the point.
     *
     * The SAM site is not a requirement, and that is deliberate: it is the round's first look at a
     * weapon that follows, and meeting it while the gates still have to be flown is the lesson. A
     * pilot who ignores it can still finish; a pilot who tries to fight it low and slow in a gorge
     * will learn why nobody does that.
     */
    winCondition: { flak: 2, drones: 0 },
    objective: 'Silence two rim guns, then eight gates down in the gorge.',
    debrief: 'That is the run the old hands talk about. Except they did it slower.',
    sky: {
      // Hard midday: the sun is high and the air is thin, so the rock walls get a bright face and
      // a deep shadowed one. That single high-contrast split is what makes a gorge read as a
      // gorge rather than as two grey ramps meeting a green floor.
      top: '#0d3f7c', mid: '#2a6ba8', low: '#7fadcc', horizon: '#d3e3ec',
      fog: 0xa8c6d6, haze: 0xa6c4d6, hazeWarm: 0xffe6bc, hazeStrength: 0.35,
      hazeScaleLow: 3600, sun: 0xfffaf0, sunIntensity: 3.5, hemi: 1.1,
      sunAzimuth: 1.72, sunElevation: 0.98,
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
    hour: 21.6,
    airDefence: { flak: 5, drones: 3, sams: 2, bombers: 3 },
    /**
     * The campaign's last sortie asks for the whole aeroplane: a gun line to break, an interceptor
     * flight to survive, and a bomber flight to stop before it reaches the town.
     *
     * One bomber, not three — the flight arrives as a line and the pilot has to break it, but a
     * requirement of three would mean a pilot who killed two and ran out of ammunition is stuck in
     * the last round of the campaign with nothing to learn. One is the mission; the other two are
     * the score.
     */
    winCondition: { flak: 3, drones: 2, bombers: 1 },
    objective: 'Break three guns, two interceptors and a bomber, fly ten gates, land in the gale.',
    debrief: 'Storm front, ten gates, and a landing in one piece. That is the campaign.',
    sky: {
      top: '#28323d', mid: '#44515c', low: '#69767e', horizon: '#95a0a6',
      fog: 0x899399, haze: 0x828c92, hazeWarm: 0xb8bcbd, hazeStrength: 1.9,
      hazeScaleLow: 1400, hazeScaleHigh: 3200, sun: 0xdde2e5, sunIntensity: 1.05, hemi: 1.25,
      sunAzimuth: 1.35, sunElevation: 0.36,
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

  grassLow: 0x6d8a41,
  grassHigh: 0x93a256,
  forest: 0x2f4a27,
  alpine: 0x8a8a5c,
  scree: 0x9a8b74,
  rock: 0x857d72,
  rockDark: 0x474038,
  rockLight: 0xa8a196,
  snow: 0xf6f9fc,
  snowShade: 0xc3d4e6,
  sand: 0xcbb287,
  water: 0x1b4a66,

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
