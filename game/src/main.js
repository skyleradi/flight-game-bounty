// The page's entry point: it builds the game, wires the campaign's screens together, applies a
// screenshot scene when the address names one, and otherwise lets the pilot fly.
//
// A shot is taken by opening the page with ?shot=<name>: the scene sets the aircraft into a state
// the real flight model produced and renders one frame, so the screenshot is the game's own code.

import { CAMPAIGN } from './config.js';
import { createGame } from './game.js';
import { createUI } from './ui.js';
import { applyScene, sceneFromLocation } from './scenes.js';

const view = document.getElementById('view');
const hudCanvas = document.getElementById('hud');
const uiRoot = document.getElementById('ui');
const title = document.getElementById('title');
const go = document.getElementById('go');
const status = document.getElementById('status');

const game = createGame({ canvas: view, hudCanvas });
// Exposed for the screenshot harness and for playing about from a console.
window.__flight = game;

const ui = createUI({
  root: uiRoot,
  game,
  onStartRound: (index) => {
    game.loadRound(index);
    ui.showBriefing(game.round);
  },
  onRetry: () => {
    game.restart();
  },
  onNext: (index) => {
    game.loadRound(index);
    ui.showBriefing(game.round);
  },
  onQuit: () => {
    game.setPhase('briefing');
  },
});
window.__ui = ui;

function announce(text) {
  if (status) status.textContent = text;
}

const shot = sceneFromLocation();
if (shot) {
  // A screenshot frame: no campaign UI, no live loop, one deterministic render.
  title?.classList.add('hidden');
  uiRoot.classList.add('hidden');
  game.resize();
  applyScene(game, shot);
  announce(`Screenshot scene: ${shot}.`);
  window.__shotReady = true;
} else {
  go?.addEventListener('click', () => {
    title?.classList.add('hidden');
    announce('Campaign open. Pick a round.');
    ui.showTitle();
    view.focus?.();
  });

  // The loop runs from the first frame so the briefing's background is the live world; the
  // simulation itself only advances while a round is in its flying phase.
  game.start();

  // The pause card follows the game's own flag, without re-opening every frame.
  let wasPaused = false;
  setInterval(() => {
    const nowPaused = game.isPaused();
    if (nowPaused !== wasPaused) {
      wasPaused = nowPaused;
      if (nowPaused) ui.showPause(true);
      else if (ui.isOpen()) ui.hide();
    }

    const { sortie } = game;
    const line = sortie.phase === 'debrief'
      ? `Round over: ${sortie.score} points.`
      : sortie.phase === 'briefing'
        ? 'Briefing.'
        : `Flying round ${game.round.id + 1}: ${sortie.gatesPassed} of ${game.round.gates} gates.`;
    announce(line);
  }, 1500);

  // The debrief opens once, when a round ends.
  let lastResult = null;
  setInterval(() => {
    if (game.sortie.result && game.sortie.result !== lastResult) {
      lastResult = game.sortie.result;
      ui.showDebrief(game.round, game.sortie.result);
    }
  }, 260);

  // Escape: out of the air and into the campaign. The game menu is not a modal over a live sim.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Escape') return;
    if (game.sortie.phase === 'flying') {
      game.setPaused(!game.isPaused());
    } else if (game.sortie.phase === 'briefing') {
      ui.showTitle();
      game.setPhase('briefing');
    }
  });
}

export { game, ui, CAMPAIGN };
