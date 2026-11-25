#!/usr/bin/env python3
"""Verify the brand mark geometry on the vector masters and every raster icon.

The reference is the popup header tile: the thin key on a flat blue rounded
badge. On a canvas the badge is 80% wide (10% margin on every side), the corner
radius is 30% of the badge, and the key box is 50% of the badge (the visible
glyph is ~46%), centred. The 16-19 px slots use the optical variants with a
78% key box so the thin stroke survives antialiasing.

Run after scripts/render-icons.sh:

    python3 scripts/check-icons.py
"""

from __future__ import annotations

import glob
import os
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image

SVG_NS = "{http://www.w3.org/2000/svg}"

BADGE_RATIO = 0.80               # badge width / canvas width
RADIUS_RATIO = 0.30              # corner radius / badge width
KEY_BOX_RATIO = 0.50             # key box / badge width
SMALL_KEY_BOX_RATIO = 0.78       # optical variants for 16-19 px slots
KEY_RATIO = (0.35, 0.60)         # visible key width / badge width
SMALL_KEY_RATIO = (0.50, 0.95)   # optical variants enlarge the key
CENTER_TOLERANCE = 0.02          # key centre offset / badge width
MARGIN_TOLERANCE = 1             # px, asymmetry of the badge margins
BRAND_BLUE = (0, 125, 243)       # popup --mac-blue: oklch(0.6 0.2 255)
COLOUR_TOLERANCE = 15            # per channel

SVG_MASTERS = {
    "SafariKeePassXC Extension/Resources/images/toolbar-icon.svg": (KEY_BOX_RATIO, False),
    "SafariKeePassXC Extension/Resources/images/toolbar-icon-small.svg": (SMALL_KEY_BOX_RATIO, False),
    "scripts/app-icon.svg": (KEY_BOX_RATIO, True),
    "scripts/app-icon-small.svg": (SMALL_KEY_BOX_RATIO, True),
    "SafariKeePassXC/Resources/Icon.svg": (KEY_BOX_RATIO, True),
}

TRANSFORM = re.compile(
    r"translate\(([-\d.]+) ([-\d.]+)\)\s+scale\(([-\d.]+)\)\s+translate\(([-\d.]+) ([-\d.]+)\)"
)


def check_svg(path: str, key_box_ratio: float, shadow: bool) -> list[str]:
    root = ET.parse(path).getroot()
    view_box = [float(value) for value in root.get("viewBox", "").split()]
    if len(view_box) != 4:
        return [f"{path}: missing viewBox"]
    _, _, canvas_w, canvas_h = view_box

    rect = root.find(f"{SVG_NS}rect")
    if rect is None:
        return [f"{path}: no badge rect"]
    x = float(rect.get("x", 0))
    y = float(rect.get("y", 0))
    width = float(rect.get("width", 0))
    height = float(rect.get("height", 0))
    radius = float(rect.get("rx", 0))

    errors: list[str] = []
    if (rect.get("fill") or "").lower() != "#007df3":
        errors.append(f"badge fill is {rect.get('fill')!r}, expected #007DF3")
    has_shadow = (rect.get("filter") or "").startswith("url(#shadow)")
    if has_shadow != shadow:
        errors.append("drop shadow is present" if has_shadow else "drop shadow is missing")
    if abs(width / canvas_w - BADGE_RATIO) > 0.005 or abs(height / canvas_h - BADGE_RATIO) > 0.005:
        errors.append(f"badge is {width / canvas_w:.1%} of the canvas, expected {BADGE_RATIO:.0%}")
    if abs(x / canvas_w - 0.1) > 0.005 or abs(y / canvas_h - 0.1) > 0.005:
        errors.append(f"badge is not centred (x={x}, y={y})")
    if abs(radius / width - RADIUS_RATIO) > 0.005:
        errors.append(f"corner radius is {radius / width:.1%} of the badge, expected {RADIUS_RATIO:.0%}")

    group = root.find(f"{SVG_NS}g")
    match = TRANSFORM.search(group.get("transform", "") if group is not None else "")
    if not match:
        return errors + [f"{path}: unexpected key transform"]
    tx, ty, scale, cx, cy = (float(value) for value in match.groups())
    expected_scale = key_box_ratio * width / 24
    if abs(scale - expected_scale) / expected_scale > 0.01:
        errors.append(f"key box is {scale / expected_scale:.1%} of the expected size")
    if abs(tx + scale * (12 + cx) - canvas_w / 2) > 0.01 * canvas_w:
        errors.append("key is not horizontally centred")
    if abs(ty + scale * (12 + cy) - canvas_h / 2) > 0.01 * canvas_h:
        errors.append("key is not vertically centred")
    return errors


def bbox(image: Image.Image, predicate) -> tuple[int, int, int, int] | None:
    width, height = image.size
    pixels = image.load()
    min_x, min_y, max_x, max_y = width, height, -1, -1
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a >= 128 and predicate(r, g, b):
                min_x = min(min_x, x)
                min_y = min(min_y, y)
                max_x = max(max_x, x)
                max_y = max(max_y, y)
    if max_x < 0:
        return None
    return min_x, min_y, max_x, max_y


def is_blue(r: int, g: int, b: int) -> bool:
    return b > 120 and b > r


def is_key(r: int, g: int, b: int) -> bool:
    return min(r, g, b) > 150 and max(r, g, b) - min(r, g, b) < 70


def badge_colour(image: Image.Image, badge: tuple[int, int, int, int]) -> tuple[float, float, float] | None:
    bx0, by0, bx1, by1 = badge
    inset = max(1, int(min(bx1 - bx0 + 1, by1 - by0 + 1) * 0.25))
    pixels = image.load()
    samples = []
    for y in range(by0 + inset, by1 - inset + 1):
        for x in range(bx0 + inset, bx1 - inset + 1):
            r, g, b, a = pixels[x, y]
            if a < 200 or r > 40:  # skip the white key and its blends
                continue
            samples.append((r, g, b))
    if not samples:
        return None
    return tuple(sum(sample[i] for sample in samples) / len(samples) for i in range(3))


def check_png(path: str) -> list[str]:
    image = Image.open(path).convert("RGBA")
    width, height = image.size
    errors: list[str] = []

    badge = bbox(image, is_blue)
    key = bbox(image, is_key)
    if badge is None:
        return [f"{path}: no blue badge found"]
    if key is None:
        return [f"{path}: no white key found"]

    bx0, by0, bx1, by1 = badge
    badge_w = bx1 - bx0 + 1
    badge_h = by1 - by0 + 1
    margins = (bx0, by0, width - 1 - bx1, height - 1 - by1)
    badge_ratio = badge_w / width

    if not 0.72 <= badge_ratio <= 0.86:  # 16 px rounds down to 75%
        errors.append(f"badge is {badge_ratio:.0%} of the canvas, expected ~80%")
    if min(margins) < 1:
        errors.append(f"badge is full-bleed (margins {margins})")
    if abs(margins[0] - margins[2]) > MARGIN_TOLERANCE or abs(margins[1] - margins[3]) > MARGIN_TOLERANCE:
        errors.append(f"badge is not centred (margins {margins})")
    if abs(badge_w - badge_h) > 1:
        errors.append(f"badge is not square ({badge_w}x{badge_h})")

    kx0, ky0, kx1, ky1 = key
    key_w = kx1 - kx0 + 1
    key_ratio = key_w / badge_w
    key_range = SMALL_KEY_RATIO if width <= 24 else KEY_RATIO
    if not key_range[0] <= key_ratio <= key_range[1]:
        errors.append(f"key is {key_ratio:.0%} of the badge, expected {key_range[0]:.0%}-{key_range[1]:.0%}")

    badge_cx = (bx0 + bx1) / 2
    badge_cy = (by0 + by1) / 2
    key_cx = (kx0 + kx1) / 2
    key_cy = (ky0 + ky1) / 2
    dx = abs(key_cx - badge_cx) / badge_w
    dy = abs(key_cy - badge_cy) / badge_w
    # Sub-pixel rounding dominates below ~24 px, so allow half a pixel there.
    tolerance = max(CENTER_TOLERANCE, 0.5 / badge_w)
    if dx > tolerance or dy > tolerance:
        errors.append(f"key is off-centre by ({key_cx - badge_cx:+.1f}, {key_cy - badge_cy:+.1f}) px")

    colour = badge_colour(image, badge)
    if colour is None:
        errors.append("cannot sample the badge colour")
    elif any(abs(colour[i] - BRAND_BLUE[i]) > COLOUR_TOLERANCE for i in range(3)):
        errors.append(f"badge colour is rgb({colour[0]:.0f}, {colour[1]:.0f}, {colour[2]:.0f}), expected {BRAND_BLUE}")

    return errors


def main() -> int:
    os.chdir(Path(__file__).resolve().parent.parent)

    failures = 0
    for path, (key_box_ratio, shadow) in SVG_MASTERS.items():
        errors = check_svg(path, key_box_ratio, shadow)
        failures += bool(errors)
        for error in errors:
            print(f"FAIL {path}: {error}")
        if not errors:
            print(f"ok   {path}")

    paths = sorted(
        glob.glob("SafariKeePassXC Extension/Resources/images/*.png")
        + glob.glob("SafariKeePassXC/Assets.xcassets/AppIcon.appiconset/*.png")
    )
    for path in paths:
        errors = check_png(path)
        failures += bool(errors)
        for error in errors:
            print(f"FAIL {path}: {error}")
        if not errors:
            print(f"ok   {path}")

    if failures:
        print(f"\n{failures} item(s) failed")
        return 1
    print(f"\n{len(SVG_MASTERS)} masters and {len(paths)} rasters match the brand mark")
    return 0


if __name__ == "__main__":
    sys.exit(main())
