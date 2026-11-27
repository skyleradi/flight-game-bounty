// The campaign's own interface: the title card's round picker, the briefing sheet that opens each
// sortie, the debrief that closes it, and the pause card.
//
// None of this touches the renderer. It is plain DOM laid over the canvas, which keeps the text
// crisp at any size and means the screenshots of the briefing and debrief are the browser's own
// type rather than something painted into a texture.
//
// The flow is: title → (pick a round) → briefing → flying → debrief → (next round | retry | title).
// Escape out of a briefing drops back to the title; Escape in the air pauses.

import { CAMPAIGN, UPGRADES, campaignPar } from './config.js';
import { buy, canBuy, levelOf, nextCost } from './kit.js';

const GRADE_BANDS = [
  { min: 0.86, grade: 'A', line: 'Textbook.' },
  { min: 0.72, grade: 'B', line: 'Well flown.' },
  { min: 0.56, grade: 'C', line: 'Through it, at least.' },
  { min: 0.36, grade: 'D', line: 'A pass, of a sort.' },
  { min: 0, grade: 'F', line: 'The aeroplane disagrees.' },
];

function gradeFor(score, par) {
  const ratio = par > 0 ? score / par : 0;
  return GRADE_BANDS.find((b) => ratio >= b.min) ?? GRADE_BANDS[GRADE_BANDS.length - 1];
}

/** The compass label for a meteorological wind bearing. */
function windLabel(from) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round((((from % 360) + 360) % 360) / 22.5) % 16];
}

/** The wind as felt from the runway: how much of it is across the strip. */
function crosswindOf(round) {
  // The strip runs on RUNWAY.heading; the wind blows toward (from + 180).
  const toward = ((round.wind.from + 180) * Math.PI) / 180;
  // Only the magnitude matters here, and the runway's own bearing is fixed, so this is a stable
  // number per round rather than something that needs the world's geometry.
  const runwayToward = -Math.PI * 0.06;
  const angle = Math.abs(((toward - runwayToward + Math.PI) % (Math.PI * 2)) - Math.PI);
  return Math.abs(Math.sin(angle)) * round.wind.speed;
}

function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

/**
 * Builds the overlay and returns the handles the game calls: `showTitle`, `showBriefing`,
 * `showDebrief`, `showPause`, `hide`.
 */
export function createUI({ root, game, onStartRound, onRetry, onNext, onQuit }) {
  root.innerHTML = '';

  const scrim = el('div', 'ui-scrim');
  const card = el('div', 'ui-card');
  scrim.appendChild(card);
  root.appendChild(scrim);

  const toast = el('div', 'ui-toast');
  root.appendChild(toast);

  let toastTimer = 0;

  function show(on) {
    scrim.classList.toggle('open', on);
  }

  function toastLine(text, ms = 1900) {
    toast.textContent = text;
    toast.classList.add('open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('open'), ms);
  }

  // --- The title: the campaign's front page, with a row per round. -------------------------------
  function showTitle() {
    const { progress } = game;
    const totalBest = progress.total ?? 0;
    const par = campaignPar();
    const complete = Object.keys(progress.best ?? {}).length === CAMPAIGN.length;

    card.className = 'ui-card title';
    card.innerHTML = `
      <header>
        <div class="kicker">Harrow Field &middot; a five-sortie campaign</div>
        <h1>Ridge Runner</h1>
        <p class="lead">
          A light single-engine monoplane, a mountain valley, and five sorties that get worse.
          Thread every gate, keep the wing flying and the fuel in the tanks, and put her back on the
          strip. Each round brings its own weather: still air first, then a crosswind, then cloud,
          then a gorge, then the storm.
        </p>
      </header>

      <div class="campaign-body">
      <div class="rounds">
        ${CAMPAIGN.map((r, i) => {
          const locked = i + 1 > progress.unlocked;
          const best = progress.best?.[i];
          const wx = [
            `${windLabel(r.wind.from)} ${r.wind.speed} m/s`,
            r.rain > 0.5 ? 'rain' : r.rain > 0 ? 'drizzle' : 'dry',
            r.turbulence > 0.6 ? 'turbulent' : r.turbulence > 0.2 ? 'bumpy' : 'smooth',
          ].join(' · ');
          return `
            <button class="round ${locked ? 'locked' : ''}" data-round="${i}" ${locked ? 'disabled' : ''}>
              <span class="num">${String(i + 1).padStart(2, '0')}</span>
              <span class="body">
                <span class="name">${r.name}</span>
                <span class="sub">${r.subtitle}</span>
                <span class="wx">${wx} &middot; ${r.gates} gates</span>
              </span>
              <span class="score">${locked ? 'LOCKED' : best ? best : '—'}</span>
            </button>`;
        }).join('')}
      </div>

      <div class="shop">
        <div class="shop-head">
          <span class="shop-title">Hangar</span>
          <span class="shop-bank">${Math.round(game.kit?.credits ?? 0)} credits</span>
        </div>
        <div class="shop-lines">
          ${UPGRADES.map((line) => {
            const lvl = levelOf(game.kit, line.id);
            const cost = nextCost(game.kit, line.id);
            const maxed = cost === null;
            const afford = cost !== null && game.kit.credits >= cost;
            return `
              <button class="shop-line ${maxed ? 'maxed' : ''} ${afford ? 'afford' : ''}"
                      data-upgrade="${line.id}" ${maxed ? 'disabled' : ''}
                      title="${line.blurb}">
                <span class="sl-name">${line.name}</span>
                <span class="sl-pips">${line.tiers.map((t, i) => `<i class="${i < lvl ? 'on' : ''}"></i>`).join('')}</span>
                <span class="sl-cost">${maxed ? 'MAX' : `${cost} cr`}</span>
                <span class="sl-next">${maxed ? '' : line.tiers[lvl].label}</span>
              </button>`;
          }).join('')}
        </div>
        <p class="shop-note">Credits come from flying rounds clean and from salvage picked up on course.</p>
      </div>
      </div>

      <footer>
        <div class="totals">
          <span><b>${totalBest}</b> campaign score</span>
          <span><b>${par}</b> par</span>
          <span>${complete ? 'All five flown' : `${progress.unlocked} of ${CAMPAIGN.length} open`}</span>
        </div>
        <div class="keys">
          <span><b>W/S</b> pitch</span><span><b>A/D</b> roll</span><span><b>Q/E</b> rudder</span>
          <span><b>Shift/Ctrl</b> throttle</span><span><b>F/V</b> flaps</span>
          <span><b>T</b> autopilot</span><span><b>C</b> view</span><span><b>R</b> restart</span><span><b>P</b> pause</span>
        </div>
      </footer>`;

    card.querySelectorAll('button.round').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.dataset.round);
        onStartRound(index);
      });
    });

    // The hangar. A purchase refits the aircraft and repaints the card, so the pips and the bank
    // move together rather than one lagging the other.
    card.querySelectorAll('button.shop-line').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (buy(game.kit, btn.dataset.upgrade)) {
          game.refit();
          showTitle();
        }
      });
    });

    show(true);
  }

  // --- The briefing: the round's weather, objective and what to watch for. -----------------------
  function showBriefing(round) {
    const xw = crosswindOf(round);
    const gusty = round.turbulence > 0.45;
    const notes = [];
    if (xw > 8) notes.push(`Crosswind ${Math.round(xw)} m/s across the strip: hold the crab, take it out in the flare.`);
    else if (round.wind.speed > 4) notes.push(`A ${windLabel(round.wind.from)} wind at ${round.wind.speed} m/s: enough to notice, not enough to fight.`);
    else notes.push('Almost no wind. The aircraft will do exactly what you ask of it.');
    if (round.rain > 0.4) notes.push('Rain on the glass and a low deck: the horizon goes away, so fly the numbers.');
    else if (round.visibility < 7000) notes.push('Reduced visibility. The gates appear late, and late is close.');
    if (gusty) notes.push('Turbulence: the wings will not sit still, and neither will your altitude.');
    if (round.course.clearance.base < 70) notes.push('The gates are low. The rock is closer than it looks from the airfield.');
    if (round.fuel < 80) notes.push(`Only ${round.fuel} units of fuel. The course is longer than the tank is deep.`);

    card.className = 'ui-card briefing';
    card.innerHTML = `
      <header>
        <div class="kicker">Round ${round.id + 1} of ${CAMPAIGN.length} &middot; par ${Math.round(1000 * round.difficulty)}</div>
        <h1>${round.name}</h1>
        <h2>${round.subtitle}</h2>
      </header>

      <p class="lead">${round.brief}</p>

      <div class="grid">
        <div class="stat"><span class="k">Gates</span><span class="v">${round.gates}</span></div>
        <div class="stat"><span class="k">Gate radius</span><span class="v">${round.radius} m</span></div>
        <div class="stat"><span class="k">Clock</span><span class="v">${Math.floor(round.time / 60)}:${String(round.time % 60).padStart(2, '0')}</span></div>
        <div class="stat"><span class="k">Fuel</span><span class="v">${round.fuel}</span></div>
        <div class="stat"><span class="k">Wind</span><span class="v">${windLabel(round.wind.from)} ${round.wind.speed} m/s</span></div>
        <div class="stat"><span class="k">Crosswind</span><span class="v ${xw > 8 ? 'warn' : ''}">${Math.round(xw)} m/s</span></div>
        <div class="stat"><span class="k">Visibility</span><span class="v ${round.visibility < 7000 ? 'warn' : ''}">${(round.visibility / 1000).toFixed(1)} km</span></div>
        <div class="stat"><span class="k">Turbulence</span><span class="v ${gusty ? 'warn' : ''}">${round.turbulence === 0 ? 'none' : round.turbulence < 0.4 ? 'light' : round.turbulence < 0.8 ? 'moderate' : 'severe'}</span></div>
      </div>

      <ul class="notes">
        <li class="obj">${round.objective}</li>
        ${notes.map((n) => `<li>${n}</li>`).join('')}
      </ul>

      <footer>
        <button class="primary" id="launch">Fly round ${round.id + 1}</button>
        <button class="ghost" id="back">Back to the campaign</button>
      </footer>`;

    card.querySelector('#launch').addEventListener('click', () => {
      show(false);
      game.beginRound();
      toastLine(`${round.name}: the clock starts when the wheels roll.`, 2600);
    });
    card.querySelector('#back').addEventListener('click', () => {
      showTitle();
      onQuit?.();
    });

    show(true);
  }

  // --- The debrief: the score, its parts, and where to go next. ---------------------------------
  function showDebrief(round, result) {
    const { grade, line } = gradeFor(result.score, result.par);
    const complete = result.gatesPassed >= result.gatesTotal;
    const lastRound = round.id + 1 >= CAMPAIGN.length;
    const nextOpen = game.progress.unlocked > round.id + 1 || complete;

    const reasonLine = {
      landed: 'Down on the strip, engine running.',
      crash: 'The airframe is a write-off.',
      timeout: 'The clock beat you home.',
      fuel: 'Dry tanks on the ground.',
    }[result.reason] ?? 'Sortie complete.';

    const breakdown = [
      ['Gates', `${result.gatesPassed}/${result.gatesTotal}`, Math.round((result.gatesPassed / result.gatesTotal) * 620)],
      ['Landing', result.reason === 'landed' ? 'clean' : result.reason === 'crash' ? 'destroyed' : 'none',
        result.reason === 'landed' ? 200 : result.reason === 'crash' ? 0 : 80],
      ['Airframe', `${result.health}%`, Math.round((result.health / 100) * 70)],
      ['Fuel', `${result.fuelPct}%`, Math.round((result.fuelPct / 100) * 40)],
      ['Time', `${result.timeLeft}s left`, Math.round((result.timeLeft / round.time) * 70)],
    ];

    card.className = 'ui-card debrief';
    card.innerHTML = `
      <header>
        <div class="kicker">Round ${round.id + 1} &middot; ${round.name} &middot; par ${result.par}</div>
        <div class="scoreline">
          <span class="big">${result.score}</span>
          <span class="grade ${grade}">${grade}</span>
        </div>
        <h2>${line} ${reasonLine}</h2>
      </header>

      <table class="breakdown">
        ${breakdown.map(([k, v, pts]) => `<tr><th>${k}</th><td>${v}</td><td class="pts">${pts}</td></tr>`).join('')}
      </table>

      <div class="extras">
        <span>Flew <b>${result.elapsed}s</b></span>
        ${result.peakAltitude ? `<span>Peak <b>${result.peakAltitude} m</b></span>` : ''}
        ${result.touchdown ? `<span>Touchdown <b>${result.touchdown.sink} m/s</b> sink, <b>${result.touchdown.crosswind} m/s</b> crosswind</span>` : ''}
      </div>

      <p class="debriefline">${round.debrief}</p>

      <footer>
        ${lastRound
          ? `<button class="primary" id="next" disabled>Campaign complete</button>`
          : complete
            ? `<button class="primary" id="next">Round ${round.id + 2}</button>`
            : `<button class="primary" id="next" disabled>Flown all ${result.gatesTotal} gates to unlock round ${round.id + 2}</button>`}
        <button class="ghost" id="retry">Fly it again</button>
        <button class="ghost" id="title">Campaign</button>
      </footer>`;

    card.querySelector('#retry')?.addEventListener('click', () => {
      show(false);
      onRetry?.();
    });
    card.querySelector('#title')?.addEventListener('click', () => {
      showTitle();
    });
    const nextBtn = card.querySelector('#next');
    if (nextBtn && !nextBtn.disabled) {
      nextBtn.addEventListener('click', () => {
        show(false);
        onNext?.(round.id + 1);
      });
    }

    show(true);
  }

  // --- Pause ------------------------------------------------------------------------------------
  function showPause(on) {
    if (!on) {
      show(false);
      return;
    }
    card.className = 'ui-card pause';
    card.innerHTML = `
      <header><h1>Paused</h1><h2>${game.round.name}</h2></header>
      <p class="lead">The valley will wait. Press P to fly on.</p>
      <footer>
        <button class="primary" id="resume">Resume</button>
        <button class="ghost" id="restart">Restart round</button>
        <button class="ghost" id="quit">Campaign</button>
      </footer>`;
    card.querySelector('#resume').addEventListener('click', () => {
      game.setPaused(false);
      show(false);
    });
    card.querySelector('#restart').addEventListener('click', () => {
      game.setPaused(false);
      show(false);
      game.restart();
    });
    card.querySelector('#quit').addEventListener('click', () => {
      game.setPaused(false);
      showTitle();
    });
    show(true);
  }

  return { showTitle, showBriefing, showDebrief, showPause, hide: () => show(false), toast: toastLine, isOpen: () => scrim.classList.contains('open') };
}
