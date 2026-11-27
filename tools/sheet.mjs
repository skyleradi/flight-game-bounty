// Builds the contact sheet the judge actually sees: the cover fitted inside 768x480, the other
// screenshots in a row beneath at 253x158 each (3 others), on black, 4px gaps.
//
// Usage: node tools/sheet.mjs <out.png> <cover.jpg> <other.jpg> [other...]
import sharp from '/root/kit-fresh-flight/best-flight-game-20261126-0057-kit/node_modules/sharp/lib/index.js';

const [, , out, ...files] = process.argv;
const SHEET_WIDTH = 768;
const COVER_BOX = { width: 768, height: 480 };
const GAP = 4;

const fit = async (path, box) => sharp(path)
  .rotate().flatten({ background: { r: 0, g: 0, b: 0 } })
  .resize({ ...box, fit: 'inside', withoutEnlargement: true, kernel: 'lanczos3' })
  .removeAlpha().toBuffer({ resolveWithObject: true });

const cover = await fit(files[0], COVER_BOX);
const rest = files.slice(1);
const columns = Math.min(Math.max(rest.length, 2), 4);
const cellWidth = Math.floor((SHEET_WIDTH - (columns - 1) * GAP) / columns);
const cellHeight = Math.floor(cellWidth * 5 / 8);

const cells = [];
for (const f of rest) cells.push(await fit(f, { width: cellWidth, height: cellHeight }));

const sheetHeight = cover.info.height + (cells.length > 0 ? GAP + cellHeight : 0);
const sheet = sharp({
  create: { width: SHEET_WIDTH, height: sheetHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
});

const composites = [{ input: cover.data, left: 0, top: 0 }];
cells.forEach((cell, i) => {
  composites.push({ input: cell.data, left: i * (cellWidth + GAP), top: cover.info.height + GAP });
});

await sheet.composite(composites).png().toFile(out);
console.log(`wrote ${out}: ${SHEET_WIDTH}x${sheetHeight}, cover ${cover.info.width}x${cover.info.height}, cells ${cellWidth}x${cellHeight}`);
