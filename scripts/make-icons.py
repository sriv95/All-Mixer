"""Draws public/icons/icon-{16,32,48,128}.png: a red rounded square, a white karaoke mic in front of three mixer sliders (white at 60 %, black knobs). Needs Pillow (python3 scripts/make-icons.py)."""
from PIL import Image, ImageDraw

RED, WHITE, BLACK = (225, 29, 46, 255), (255, 255, 255, 255), (17, 17, 17, 255)
TRACK = (243, 165, 171, 255)  # white at 60 % over RED
S = 8  # supersampling


def draw(size: int) -> Image.Image:
    n = size * S
    u = n / 128  # the design is drawn on a 128 grid
    base = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(base)
    d.rounded_rectangle((0, 0, n - 1, n - 1), radius=30 * u, fill=RED)
    # Sliders: round-capped tracks, knobs at three heights.
    r = 4.5 * u
    for x in (24, 62, 104):
        d.line((x * u, 18 * u, x * u, 110 * u), fill=TRACK, width=round(2 * r))
        for y in (18, 110):
            d.ellipse((x * u - r, y * u - r, x * u + r, y * u + r), fill=TRACK)
    for x, y in ((9, 76), (47, 92), (89, 46)):
        d.rounded_rectangle((x * u, y * u, (x + 30) * u, (y + 20) * u), radius=10 * u, fill=BLACK)
    # Mic, drawn upright then tilted 24 degrees about the tile centre.
    mic = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    m = ImageDraw.Draw(mic)
    box = (35 * u, 15 * u, 85 * u, 65 * u)
    m.ellipse(box, fill=WHITE)
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).ellipse(box, fill=255)
    bar = Image.new('L', (n, n), 0)
    ImageDraw.Draw(bar).rectangle((30 * u, 44 * u, 92 * u, 53 * u), fill=255)
    red = Image.new('RGBA', (n, n), RED)
    mic.paste(red, (0, 0), Image.composite(bar, Image.new('L', (n, n), 0), mask))
    handle = [(45, 62), (75, 62), (70, 104), (68.5, 108), (65, 111), (60, 112), (55, 111), (51.5, 108), (50, 104)]
    m.polygon([(x * u, y * u) for x, y in handle], fill=WHITE)
    mic = mic.rotate(24, resample=Image.BICUBIC, center=(64 * u, 64 * u))
    base.alpha_composite(mic)
    return base.resize((size, size), Image.LANCZOS)


for s in (16, 32, 48, 128):
    draw(s).save(f'public/icons/icon-{s}.png')
