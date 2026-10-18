"""Draws public/icons/icon-{16,32,48,128}.png: a red rounded square with three white sliders. Needs Pillow (python3 scripts/make-icons.py)."""
from PIL import Image, ImageDraw

RED, WHITE = (225, 29, 46, 255), (255, 255, 255, 255)
S = 8  # supersampling


def draw(size: int) -> Image.Image:
    n = size * S
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = n / 24
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=7 * u, fill=RED)
    for x, knob in ((6, 15), (12, 8), (18, 13)):
        d.line((x * u, 4 * u, x * u, 20 * u), fill=WHITE, width=round(2.4 * u))
        r = 2.9 * u
        d.ellipse((x * u - r, knob * u - r, x * u + r, knob * u + r), fill=RED, outline=WHITE, width=round(1.7 * u))
    return img.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    draw(s).save(f'public/icons/icon-{s}.png')
