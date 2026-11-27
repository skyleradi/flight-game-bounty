#!/usr/bin/env python3
"""Rebuild the judge's contact sheet (dossier-view/v1) from a set of screenshots.

The judge never sees a screenshot at full size. It sees one JPEG sheet: the cover (first by name)
fitted inside 768x480 on top, and the rest in a row beneath, each in a smaller cell, never
enlarged. Anything that only reads at 1280x720 is invisible to the judge, so this is the view worth
checking a candidate set against.
"""
import sys
import os
from PIL import Image

COVER_W, COVER_H = 768, 480
CELL_W, CELL_H = 256, 160
PAD = 8


def build(paths, out):
    ims = [Image.open(p).convert('RGB') for p in paths]
    cover = ims[0]
    scale = min(COVER_W / cover.width, COVER_H / cover.height, 1.0)
    cw, ch = int(cover.width * scale), int(cover.height * scale)
    sheet_w = COVER_W + PAD * 2
    row_h = CELL_H
    sheet_h = ch + row_h + PAD * 3
    sheet = Image.new('RGB', (sheet_w, sheet_h), (12, 12, 12))
    sheet.paste(cover.resize((cw, ch), Image.LANCZOS), ((sheet_w - cw) // 2, PAD))

    rest = ims[1:]
    if rest:
        total = len(rest) * CELL_W + (len(rest) - 1) * PAD
        x = max(PAD, (sheet_w - total) // 2)
        y = PAD * 2 + ch
        for im in rest:
            s = min(CELL_W / im.width, CELL_H / im.height, 1.0)
            w, h = int(im.width * s), int(im.height * s)
            cell = im.resize((w, h), Image.LANCZOS)
            sheet.paste(cell, (x + (CELL_W - w) // 2, y + (CELL_H - h) // 2))
            x += CELL_W + PAD

    sheet.save(out, 'JPEG', quality=88, optimize=True)
    print(f'{out}  {sheet.width}x{sheet.height}  {os.path.getsize(out)} bytes  from {len(paths)} shots')


if __name__ == '__main__':
    out = sys.argv[1]
    build(sys.argv[2:], out)
