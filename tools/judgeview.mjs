// Reproduces the judge view (dossier-view/v1) that the bounty's judge actually receives:
// the outline text at 1,536 input tokens for the entry, minus the contact sheet's share.
//
// The CLI is a bundle; the pieces are not exported, so this re-implements the parts the
// outline depends on: readKitText, declarationLines/jsDeclares, jsonBytes4, fitLines2,
// cutLine, firstLine11 and viewText's outline branch. Kept in step with the CLI by
// comparing this script's output for the shipped dossier against the dossier's own text.
//
// Usage: node tools/judgeview.mjs [dossier.json]

import { readFileSync } from 'node:fs';

const DOSSIER_VIEW_ENTRY_TOKENS = 1536;
// The contact sheet's own share: 4 screenshots, the cover in a 768x480 box, the rest in a
// row beneath. 1,120 tokens is the figure the rules publish for a three- or four-shot sheet
// ("the screenshots go on one contact sheet (1,120 tokens) and the outline has the rest").
const SHEET_TOKENS = 1120;
// The budget viewText is handed is in JSON bytes of the request fragment: the rules give it as
// (1,536 - 1,120) x 3 = 1,248 bytes.
const BUDGET_BYTES = (DOSSIER_VIEW_ENTRY_TOKENS - SHEET_TOKENS) * 3;

const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');
const jsonBytes = (s) => utf8Bytes(JSON.stringify(s)) - 2;

const CSS_PALETTE = 'css-palette';
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'do', 'else', 'try',
  'with', 'new', 'typeof', 'delete', 'void', 'in', 'of', 'instanceof', 'await', 'yield',
]);

function jsDeclares(t, top) {
  if (/^(export\s+(default\s+)?)?(async\s+)?function\b/.test(t)) return true;
  if (/^(export\s+(default\s+)?)?(abstract\s+)?class\s+[\w$]/.test(t)) return true;
  if (/^export\b/.test(t)) return true;
  if (/^(const|let|var)\s+[\w$]+\s*(:[^=]+)?=\s*(async\s+)?(function\b|\([^)]*\)\s*(:[^=]+)?=>|[\w$]+\s*=>)/.test(t)) return true;
  if (/^[\w$]+\s*:\s*(async\s+)?(function\b|\([^)]*\)\s*=>)/.test(t)) return true;
  if (top && /^((const|let|var)\s|(interface|type|enum|declare)\s|[\w$]+(\.[\w$]+)+\s*=[^=])/.test(t)) return true;
  const method = /^(static\s+)?(async\s+)?((get|set)\s+)?\*?#?([\w$]+)\s*\([^()]*\)\s*(:\s*[^{]+)?\{\s*\}?\s*$/.exec(t);
  return method !== null && !JS_KEYWORDS.has(method[5]);
}

function declarationLines(language, lines) {
  const out = [];
  let block = null;
  const closers = { js: [['/*', '*/']], css: [['/*', '*/']], html: [['<!--', '-->']] };
  for (let at = 0; at < lines.length; at++) {
    const raw = lines[at];
    const push = (text) => out.push({ line: at, text });
    let t = raw.trim();
    if (block !== null) {
      const end = t.indexOf(block);
      if (end < 0) continue;
      t = t.slice(end + block.length).trim();
      block = null;
    }
    const opener = (closers[language] ?? []).find(([open]) => t.startsWith(open));
    if (opener !== undefined) {
      const end = t.indexOf(opener[1], opener[0].length);
      if (end < 0) { block = opener[1]; continue; }
      t = t.slice(end + opener[1].length).trim();
    }
    if (t === '') continue;
    const top = raw.length > 0 && raw[0] !== ' ' && raw[0] !== '\t';
    switch (language) {
      case 'js':
        if (t.startsWith('//') || t.startsWith('*')) continue;
        if (jsDeclares(t, top)) push(t);
        break;
      case 'css': {
        const brace = t.indexOf('{');
        const selector = brace > 0 ? t.slice(0, brace).trim() : '';
        if (selector !== '' && !selector.startsWith('}') && !/^[\w-]+\s*:\s*/.test(selector)) push(selector);
        break;
      }
      case 'html':
        if (/<[A-Za-z][^>]*\sid\s*=/.test(t) || /<script\b/i.test(t) || /<link\b/i.test(t)) push(t);
        break;
      default:
        break;
    }
  }
  return out;
}

function languageOfPath(path) {
  if (path.endsWith('.html')) return 'html';
  if (path.endsWith('.css')) return 'css';
  return 'js';
}

/** Splits a dossier's text into its Game block and one section per source file. */
function readKitText(text) {
  const lines = text.split('\n');
  const sections = [];
  let head = [];
  let current = null;
  for (const line of lines) {
    const m = /^### (game\/\S+) \((\d+) lines?, (\d+) bytes\)$/.exec(line.trimEnd());
    if (m !== null) {
      if (current !== null) sections.push(current);
      current = { heading: line.trimEnd(), path: m[1], lines: [], fence: null, info: '' };
      continue;
    }
    if (current === null) { head.push(line); continue; }
    if (current.fence === null) {
      const f = /^(`{3,})(.*)$/.exec(line);
      if (f !== null) { current.fence = f[1]; current.info = f[2]; continue; }
      current.lines.push(line);
      continue;
    }
    if (line.trimEnd() === current.fence) { current.open = false; continue; }
    current.lines.push(line);
  }
  if (current !== null) sections.push(current);
  // The head is everything before the first heading, minus its own trailing blank lines.
  while (head.length > 0 && head.at(-1).trim() === '') head.pop();
  return { head, sections: sections.filter((s) => s.fence !== null) };
}

function keptHead(head) {
  return head.filter((l) => l.trim() !== '');
}

function cutLine(budget, headings, decls, bytes) {
  const what = headings > 0
    ? `${headings} file heading${headings === 1 ? '' : 's'}, ${decls} declaration line${decls === 1 ? '' : 's'}`
    : `${decls} declaration line${decls === 1 ? '' : 's'}`;
  return `[Cut at ${budget} bytes: ${what} and ${bytes} bytes of source left out.]`;
}

function firstLine(form, images) {
  const what = form === 'outline'
    ? "[An outline of the entry's source: each file's heading and its declarations, bodies and comments left out."
    : "[An outline of the entry's source: each file's heading, then its text whole in file order as far as it fits, and past that its declarations only, bodies and comments left out.";
  const sheet = ` The image: its ${images} screenshots on one sheet, the cover on top, the rest below in order.]`;
  return what + sheet;
}

function fitLines(lines, budget) {
  let used = 0;
  let k = 0;
  for (; k < lines.length; k++) {
    const cost = jsonBytes(`${lines[k]}\n`);
    if (used + cost > budget) break;
    used += cost;
  }
  return k;
}

/** The outline branch of viewText, for a source whose declaration lines do not all fit. */
function outlineOf(text, images) {
  const budget = BUDGET_BYTES;
  const whole = `${firstLine('whole', images)}\n${text}`;
  if (jsonBytes(whole) <= budget) return { form: 'whole', text: whole };

  const kit = readKitText(text);
  const outlineFirst = firstLine('outline', images);
  const head = keptHead(kit.head);
  const before = head.length === 0 ? [] : [...head, ''];
  const headings = kit.sections.map((s) => s.heading);
  const decls = kit.sections.map((s) => declarationLines(languageOfPath(s.path), s.lines)
    .map((d) => ({ line: d.line, text: d.text })));
  const totalDecls = decls.reduce((n, d) => n + d.length, 0);
  const sourceBytes = kit.sections.reduce((n, s) => n + utf8Bytes(s.lines.join('\n')) + 1, 0);
  const reserve = jsonBytes(cutLine(budget, kit.sections.length, totalDecls, sourceBytes));

  const fixedCost = [outlineFirst, ...before, ...headings]
    .reduce((n, l) => n + jsonBytes(`${l}\n`), 0);

  if (fixedCost + reserve > budget) {
    const lines = [outlineFirst, ...before, ...headings];
    const k = fitLines(lines, budget - reserve);
    const headingsShown = Math.min(Math.max(0, k - 1 - before.length), headings.length);
    return {
      form: 'outline',
      text: [...lines.slice(0, k), cutLine(budget, headings.length - headingsShown, totalDecls, sourceBytes)].join('\n'),
    };
  }

  let room = budget - fixedCost - reserve;
  const kept = decls.map(() => 0);
  const open = decls.map((d) => d.length > 0);
  // Round-robin: one declaration per file at a time, so every file keeps its heading and its
  // first declaration before any file gets a second.
  while (open.some(Boolean)) {
    for (let f = 0; f < decls.length; f++) {
      if (!open[f]) continue;
      const cost = jsonBytes(`${decls[f][kept[f]].text}\n`);
      if (cost > room) { open[f] = false; continue; }
      room -= cost;
      kept[f]++;
      if (kept[f] === decls[f].length) open[f] = false;
    }
  }

  const body = kit.sections.flatMap((s, f) => [headings[f], ...decls[f].slice(0, kept[f]).map((d) => d.text)]);
  const shownDecls = kept.reduce((n, k) => n + k, 0);
  return {
    form: 'outline',
    text: [
      outlineFirst,
      ...before,
      ...body,
      cutLine(budget, 0, totalDecls - shownDecls, sourceBytes),
    ].join('\n'),
    kept,
    decls,
    sections: kit.sections,
  };
}

const path = process.argv[2] ?? 'out/dossier.json';
const doc = JSON.parse(readFileSync(path, 'utf8'));
const images = doc.images.length;
const result = outlineOf(doc.text, images);

console.log(`dossier: ${path}`);
console.log(`images: ${images}  budget: ${BUDGET_BYTES} JSON bytes  form: ${result.form}`);
console.log(`dossier text: ${utf8Bytes(doc.text)} bytes`);
console.log('='.repeat(78));
console.log(result.text);
console.log('='.repeat(78));
console.log(`outline: ${utf8Bytes(result.text)} bytes, ${result.text.split('\n').length} lines`);
if (result.kept !== undefined) {
  const { kept, decls, sections } = result;
  console.log('\nPer-file declarations shown:');
  for (let f = 0; f < sections.length; f++) {
    const name = sections[f].path.replace('game/', '');
    const total = decls[f].length;
    console.log(`  ${kept[f] === total ? '  ' : 'CUT'} ${name}: ${kept[f]}/${total}`);
  }
}
