#!/usr/bin/env python3
"""Builds the contact sheet the judge actually sees.

The bounty's dossier view puts the cover (the first screenshot by name) in a box of 768x480 and
the other screenshots in a row beneath, each in a cell 5/8 as tall as it is wide, on black, with
4px gaps. The sheet is the whole of what the judge sees of the game's art: the outline's share of
the 1,536-token entry budget is a few hundred bytes. So this is the picture to judge the entry by.

Usage: python3 tools/sheet.py out.png cover.jpg other.jpg [other.jpg ...]
"""
import sys
from PIL import Image, ImageOps

SHEET_WIDTH = 768
COVER_BOX = (768, 480)
GAP = 4


def fit(path, box):
    """Fits an image inside a box, never enlarging, flattened onto black like the sheet does."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    img = img.convert("RGBA")
    flat = Image.new("RGB", img.size, (0, 0, 0))
    flat.paste(img, mask=img.split()[3])
    scale = min(box[0] / flat.width, box[1] / flat.height, 1.0)
    size = (max(1, round(flat.width * scale)), max(1, round(flat.height * scale)))
    return flat.resize(size, Image.LANCZOS)


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    out, files = sys.argv[1], sys.argv[2:]
    cover = fit(files[0], COVER_BOX)
    rest = files[1:]
    sheet_h = cover.height + (GAP + (768 - 3 * GAP) // 4 * 5 // 8 if rest else 0)

    cells = []
    if rest:
        columns = min(max(len(rest), 2), 4)
        cell_w = (SHEET_WIDTH - (columns - 1) * GAP) // columns
        cell_h = cell_w * 5 // 8
        cells = [fit(f, (cell_w, cell_h)) for f in rest]
        sheet_h = cover.height + GAP + cell_h
    else:
        cell_w = cell_h = 0

    sheet = Image.new("RGB", (SHEET_WIDTH, sheet_h), (0, 0, 0))
    sheet.paste(cover, (0, 0))
    for i, cell in enumerate(cells):
        sheet.paste(cell, (i * (cell_w + GAP), cover.height + GAP))

    sheet.save(out)
    print(f"wrote {out}: {SHEET_WIDTH}x{sheet_h}, cover {cover.width}x{cover.height}, "
          f"{len(cells)} cells {cell_w}x{cell_h}" if cells else
          f"wrote {out}: {SHEET_WIDTH}x{sheet_h}, cover only")
    return 0


if __name__ == "__main__":
    sys.exit(main())
