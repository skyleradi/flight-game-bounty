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

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The scorer's caps, from reference/gate.json. Only text_max_bytes shapes the dossier's bytes;
 *  the rest refuse an entry the scorer would refuse. */
const GATE = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144, long_max: 1280, short_min: 480 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

const SHOT_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg']);

/**
 * Reads an image's pixel size out of its own header.
 *
 * PNG carries it at a fixed offset; JPEG needs a walk through the marker segments until the
 * start-of-frame, because the size is only there and the markers before it vary in length. Both
 * are read rather than decoded, which keeps this to a few bytes and no image library.
 *
 * Returns [0, 0] for anything it cannot read, which then fails the shape check rather than
 * passing it by default.
 */
function imageSize(buf) {
  // PNG: 8-byte signature, then the IHDR chunk's width and height as big-endian dwords.
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  }
  // JPEG: walk segments from the start-of-image marker looking for any start-of-frame.
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      // SOF0-SOF15, excluding the four that are not frame headers (DHT, JPG, DAC, and DNL).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
      }
      // Standalone markers carry no length; everything else is followed by a 2-byte length.
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return [0, 0];
}

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
  // The byte cap is only half the rule. RULES.txt also fixes the shape: the long side at most
  // 1280 and the short side at least 480. A 1600x900 render passes every byte check and is still
  // refused by the scorer, so the frame size is read back out of the file header rather than
  // trusted from whatever took the shot.
  const [w, h] = imageSize(readFileSync(shot.path));
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long > GATE.screenshots.long_max || short < GATE.screenshots.short_min) {
    refuse(
      `screenshots/${shot.name} is ${w}x${h}, and the long side must be at most `
      + `${GATE.screenshots.long_max} with the short side at least ${GATE.screenshots.short_min}`,
    );
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
