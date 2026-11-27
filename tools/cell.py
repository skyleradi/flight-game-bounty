#!/usr/bin/env python3
"""Crops what the judge actually sees of one screenshot: a cover box or a strip cell.

The contact sheet fits the cover inside 768x480 and each other screenshot into a cell
253x158 (three others, four columns' worth of 768 less gaps). Anything unreadable at that
size is unreadable to the judge, whatever it looks like at 1280x720.

Usage: python3 tools/cell.py <out.png> <cover|cell> <image>
"""
import sys
from PIL import Image, ImageOps


def fit(path, box, scale=1):
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGBA")
    flat = Image.new("RGB", img.size, (0, 0, 0))
    flat.paste(img, mask=img.split()[3])
    s = min(box[0] / flat.width, box[1] / flat.height, 1.0)
    size = (max(1, round(flat.width * s)), max(1, round(flat.height * s)))
    out = flat.resize(size, Image.LANCZOS)
    if scale != 1:
        out = out.resize((out.width * scale, out.height * scale), Image.NEAREST)
    return out


def main():
    out, kind, src = sys.argv[1], sys.argv[2], sys.argv[3]
    if kind == "cover":
        img = fit(src, (768, 480))
    else:
        img = fit(src, (253, 158))
    img.save(out)
    print(f"wrote {out}: {img.width}x{img.height}")


if __name__ == "__main__":
    main()
