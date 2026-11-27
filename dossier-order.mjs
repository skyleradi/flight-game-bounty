// Which sources reach the judge, and in what order.
//
// The dossier caps its text at 163,840 bytes and cuts the tail. Files are visited by a depth-first
// walk of `game.js`'s imports, in the order those imports appear, so the order of the import block
// decides what the judge reads and what is thrown away. That makes the import list a budget, not a
// style choice — this script reads the same tree the builder reads and reports the split.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importOrder, readGameTree, htmlFacts, INDEX_HTML } from './vendor/makefun-game.ts';

const GAME = 'game';
const CAP = 163840;

const tree = readGameTree(GAME, { game_max_files: 993, game_max_bytes: 50331648, game_path_max_bytes: 1000 });
const html = htmlFacts(readFileSync(join(GAME, 'index.html'), 'utf8'));
const sources = tree.files
  .filter((f) => f.cls === 'source')
  .map((f) => ({ path: f.path, bytes: new Uint8Array(readFileSync(join(GAME, f.path))) }));

const ordered = importOrder(sources, html).filter((p) => p !== INDEX_HTML);
const seen = new Set([INDEX_HTML, ...ordered]);
const rest = sources.map((s) => s.path).filter((p) => !seen.has(p)).sort();
const order = [INDEX_HTML, ...ordered, ...rest];

const byPath = new Map(sources.map((s) => [s.path, s]));
const bytesOf = (p) => (byPath.get(p)?.bytes.length ?? 0) + 60;

let used = 0;
let cut = 0;
const shown = [];
for (const p of order) {
  const b = bytesOf(p);
  // The heading is ~60 bytes and the fence another 20; measure with a margin so the report is not
  // optimistic by a few bytes per file.
  if (used + b > CAP) {
    cut += byPath.get(p)?.bytes.length ?? 0;
    continue;
  }
  used += b;
  shown.push({ path: p, bytes: byPath.get(p)?.bytes.length ?? 0 });
}

const total = sources.reduce((n, s) => n + s.bytes.length, 0);
console.log(`${shown.length} of ${sources.length} source files reach the judge\n`);
for (const s of shown) console.log(`  IN    ${s.path.padEnd(28)} ${String(s.bytes).padStart(7)} bytes`);
console.log('');
for (const p of order) {
  if (shown.some((s) => s.path === p)) continue;
  const b = byPath.get(p)?.bytes.length ?? 0;
  console.log(`  CUT   ${p.padEnd(28)} ${String(b).padStart(7)} bytes`);
}
console.log(`\ntext used ~${used} of ${CAP} bytes (${((used / CAP) * 100).toFixed(1)}%)`);
console.log(`left out ${cut} bytes of ${total}`);
console.log(`\norder: ${order.join(' -> ')}`);
