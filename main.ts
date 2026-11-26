/**
 * Ridge Runner — hand-in program.
 *
 * Copies game/ and screenshots/ beside this file into the output directory and writes
 * dossier.json there, the summary the judge reads, using the vendored make.fun library.
 *
 * Unlike the starter this refuses to write a half-entry: every cap the scorer enforces is
 * checked before the dossier is built, so a submission either lands complete or says exactly
 * which file broke which limit. Run it as
 *
 *   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
 *
 * Outside the grader's container MAKEFUN_OUTPUT_DIR stands in for /output.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The scorer's caps, from reference/gate.json. Only text_max_bytes shapes the dossier's bytes;
 *  the rest refuse an entry the scorer would refuse. */
const GATE = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

const SHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

/** Walks a directory, returning every entry's path and byte size. */
function walk(dir) {
  const found = [];
  const queue = [dir];
  while (queue.length) {
    const current = queue.pop();
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const info = statSync(path);
      found.push({ path, bytes: info.isDirectory() ? 0 : info.size, isDirectory: info.isDirectory() });
      if (info.isDirectory()) queue.push(path);
    }
  }
  return found;
}

/** Stops the build with a message naming the file and the cap it broke. */
function refuse(message) {
  process.stderr.write(`ridge-runner: ${message}\n`);
  process.exit(1);
}

// The two directories the entry is made of must be here before anything is copied.
for (const required of ['game', 'screenshots']) {
  if (!existsSync(join(ROOT, required))) refuse(`no ${required}/ beside main.ts: nothing to hand in`);
}
if (!existsSync(join(ROOT, 'game', 'index.html'))) refuse('game/index.html is missing: the browser has nothing to open');

// Screenshots: 3 or 4 are required, each a whole PNG or JPEG under the per-file cap. The judge
// sees these before it sees any code, so an entry short of them is not worth building.
const shots = readdirSync(join(ROOT, 'screenshots'))
  .filter((name) => !name.startsWith('.'))
  .map((name) => ({ name, path: join(ROOT, 'screenshots', name) }))
  .filter((shot) => SHOT_EXTENSIONS.has(extname(shot.name).toLowerCase()));

if (shots.length < 3) refuse(`screenshots/ holds ${shots.length} image(s), and at least 3 are needed`);
if (shots.length > GATE.screenshots.max) refuse(`screenshots/ holds ${shots.length} images, and at most ${GATE.screenshots.max} are allowed`);
for (const shot of shots) {
  const { size } = statSync(shot.path);
  if (size > GATE.screenshots.max_bytes) {
    refuse(`screenshots/${shot.name} is ${size} bytes, over the ${GATE.screenshots.max_bytes}-byte cap`);
  }
}

// game/: plain files only, within the entry and byte caps, and no path long enough to trip a
// filesystem on the way in.
const gameFiles = walk(join(ROOT, 'game'));
for (const file of gameFiles) {
  const path = relative(ROOT, file.path);
  if (Buffer.byteLength(path, 'utf8') > GATE.game_path_max_bytes) {
    refuse(`${path} is longer than ${GATE.game_path_max_bytes} bytes as a path`);
  }
}
// Directories count toward the cap the scorer applies, so they are measured with the files.
if (gameFiles.length > GATE.game_max_files) {
  refuse(`game/ holds ${gameFiles.length} files and directories, over the ${GATE.game_max_files} allowed`);
}
const gameBytes = gameFiles.reduce((total, file) => total + file.bytes, 0);
if (gameBytes > GATE.game_max_bytes) {
  refuse(`game/ is ${gameBytes} bytes, over the ${GATE.game_max_bytes} allowed`);
}

mkdirSync(OUT, { recursive: true });
cpSync(join(ROOT, 'game'), join(OUT, 'game'), { recursive: true });
mkdirSync(join(OUT, 'screenshots'), { recursive: true });
cpSync(join(ROOT, 'screenshots'), join(OUT, 'screenshots'), { recursive: true });

writeFileSync(join(OUT, 'dossier.json'), buildDossier(OUT, GATE));

const dossier = statSync(join(OUT, 'dossier.json')).size;
process.stdout.write(
  `ridge-runner: ${gameFiles.length} game entr${gameFiles.length === 1 ? 'y' : 'ies'} (${gameBytes} bytes), `
  + `${shots.length} screenshots, dossier ${dossier} bytes\n`,
);
