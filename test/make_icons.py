#!/usr/bin/env python3
"""Erzeugt einfache Icons (blaues Quadrat + weißer Download-Pfeil) via PIL."""
from PIL import Image, ImageDraw
import os

def make_icon(size, path):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # abgerundetes blaues Quadrat
    r = int(size * 0.22)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=(30, 136, 229, 255))
    # Pfad: senkrechter Strich mit Pfeilspitze, unten eine "Basislinie"
    cx = size / 2
    # Strich
    sw = max(2, int(size * 0.09))
    top = size * 0.22
    bottom = size * 0.66
    d.line([(cx, top), (cx, bottom)], fill=(255, 255, 255, 255), width=sw)
    # Pfeilspitze (Dreieck)
    tip_y = size * 0.80
    half = size * 0.19
    d.polygon([
        (cx - half, bottom),
        (cx + half, bottom),
        (cx, tip_y)
    ], fill=(255, 255, 255, 255))
    # Basislinie (Teller)
    bar_y0 = size * 0.86
    bar_y1 = size * 0.86 + sw
    d.rounded_rectangle(
        [size * 0.25, bar_y0, size * 0.75, bar_y1],
        radius=sw // 2, fill=(255, 255, 255, 255))
    img.save(path, "PNG")
    print("erstellt:", path)

if __name__ == "__main__":
    outdir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(outdir, exist_ok=True)
    make_icon(48, os.path.join(outdir, "icon-48.png"))
    make_icon(96, os.path.join(outdir, "icon-96.png"))
