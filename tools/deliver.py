#!/usr/bin/env python3
"""Writes a screenshot to the gate's delivery spec.

The gate wants a whole PNG or JPEG, at most 256 KiB, long side at most 1280, short side at
least 480. The screenshots are rendered at 1280x720, so only the byte cap and the JPEG
quality ever move; this walks the quality down until the file fits rather than guessing.

Usage: python3 tools/deliver.py <out.jpg> <in.png>
"""
import os
import sys
from PIL import Image, ImageOps

CAP = 262144
LONG_MAX = 1280
SHORT_MIN = 480


def main():
    out, src = sys.argv[1], sys.argv[2]
    img = ImageOps.exif_transpose(Image.open(src)).convert("RGB")

    # Fit inside 1280 on the long side, never enlarging, and refuse anything that would land
    # under the 480 short-side floor.
    scale = min(LONG_MAX / max(img.size), 1.0)
    if scale < 1.0:
        img = img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)
    long_side, short_side = max(img.size), min(img.size)
    if short_side < SHORT_MIN:
        raise SystemExit(f"{src}: short side {short_side} is under the {SHORT_MIN} floor")

    for quality in (94, 92, 90, 88, 86, 84, 82, 80, 78, 76, 74, 72, 70):
        img.save(out, "JPEG", quality=quality, optimize=True, progressive=True)
        size = os.path.getsize(out)
        if size <= CAP:
            print(f"wrote {out}: {img.width}x{img.height}, q{quality}, {size} bytes "
                  f"({size / 1024:.0f} KiB of {CAP // 1024} KiB)")
            return 0
    raise SystemExit(f"{src}: cannot fit {CAP} bytes even at q70")


if __name__ == "__main__":
    sys.exit(main())
