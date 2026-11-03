#!/usr/bin/env python3
"""Share images (og:image, 1200x630 PNG) in public/og/.
default.png: the README hero (assets/readme/hero.png) fitted onto the theme background.
r-0418.png / r-0419.png: the two demo story cards (Atlas, Forge).
Fonts: Manrope / DM Sans variable TTFs from google/fonts (pass their paths as FONT_DIR), DejaVu as fallback.
Run: FONT_DIR=/tmp/fonts python3 scripts/make_og.py"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'og')
W, H = 1200, 630
BG = (252, 252, 252)          # --bg in public/style.css (#fcfcfc), also the hero background
INK, MUTE, LINE = (36, 41, 44), (114, 120, 125), (230, 232, 235)
FD = os.environ.get('FONT_DIR', '/tmp/fonts')


def font(name, size, weight):
    p = os.path.join(FD, name)
    try:
        f = ImageFont.truetype(p, size)
        try: f.set_variation_by_axes([weight] if 'Manrope' in name else [14, weight])
        except Exception: pass
        return f
    except OSError:
        return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf' if weight >= 600 else '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', size)


def default():
    hero = Image.open(os.path.join(ROOT, 'assets', 'readme', 'hero.png')).convert('RGB')
    s = min(W / hero.width, H / hero.height)
    hero = hero.resize((round(hero.width * s), round(hero.height * s)), Image.LANCZOS)
    im = Image.new('RGB', (W, H), BG)
    im.paste(hero, ((W - hero.width) // 2, (H - hero.height) // 2))
    im.save(os.path.join(OUT, 'default.png'), optimize=True)


def circle(path, d):
    src = Image.open(path).convert('RGBA').resize((d, d), Image.LANCZOS)
    a = Image.new('RGBA', (d, d), (245, 246, 248, 255))  # --surface behind the transparent avatar
    a.alpha_composite(src)
    m = Image.new('L', (d * 4, d * 4), 0)
    ImageDraw.Draw(m).ellipse((0, 0, d * 4 - 1, d * 4 - 1), fill=255)
    a.putalpha(m.resize((d, d), Image.LANCZOS))
    return a


def sparkle(dr, cx, cy, r, col):
    k = r * 0.28
    dr.polygon([(cx, cy - r), (cx + k, cy - k), (cx + r, cy), (cx + k, cy + k), (cx, cy + r), (cx - k, cy + k), (cx - r, cy), (cx - k, cy - k)], fill=col)


def card(fname, avatar, ref, tag_col, title, status, status_col, by, mark):
    im = Image.new('RGB', (W, H), BG)
    dr = ImageDraw.Draw(im)
    brand, small = font('Manrope.ttf', 40, 700), font('Manrope.ttf', 20, 800)
    dr.text((72, 60), 'Muse', font=brand, fill=INK)
    bw = dr.textlength('Muse ', font=brand)
    dr.line((72 + bw + 4, 66, 72 + bw + 4, 100), fill=LINE, width=2)
    dr.text((72 + bw + 20, 72), 'R A I S E', font=small, fill=INK)
    dr.text((W - 72, 72), 'raise-demo.commonworld.one', font=font('DMSans.ttf', 24, 500), fill=MUTE, anchor='ra')
    av = circle(avatar, 260)
    ring = Image.new('RGBA', (280, 280), (0, 0, 0, 0)); ImageDraw.Draw(ring).ellipse((0, 0, 279, 279), fill=(255, 255, 255, 255), outline=LINE, width=2)
    im.paste(ring, (W - 72 - 280, 190), ring); im.paste(av, (W - 72 - 270, 200), av)
    tf = font('DMSans.ttf', 24, 700)
    tw = dr.textlength(ref, font=tf)
    dr.rounded_rectangle((72, 180, 72 + tw + 36, 226), radius=23, fill=tag_col[0]); dr.text((90, 203), ref, font=tf, fill=tag_col[1], anchor='lm')
    hf = font('Manrope.ttf', 72, 700)
    words, lines, cur = title.split(), [], ''
    for w_ in words:
        t = (cur + ' ' + w_).strip()
        if dr.textlength(t, font=hf) > 700 and cur: lines.append(cur); cur = w_
        else: cur = t
    lines.append(cur)
    y = 250
    for ln in lines:
        dr.text((70, y), ln, font=hf, fill=INK); y += 84
    sf = font('Manrope.ttf', 44, 800)
    y += 26
    dr.text((72, y), status, font=sf, fill=status_col)
    x = 72 + dr.textlength(status + ' ', font=sf)
    if mark == 'sparkle':
        sparkle(dr, x + 20, y + 26, 22, (242, 176, 46)); sparkle(dr, x + 48, y + 8, 10, (242, 176, 46))
    else:
        dr.text((x, y), '\u2713', font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 44), fill=status_col)
    dr.text((72, y + 66), by, font=font('DMSans.ttf', 28, 500), fill=MUTE)
    dr.text((72, H - 64), 'Missing a feature? RAISE it!', font=font('DMSans.ttf', 26, 600), fill=MUTE)
    im.save(os.path.join(OUT, fname), optimize=True)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    default()
    card('r-0418.png', os.path.join(ROOT, 'public/avatars/atlas.png'), 'RAISE #0418', ((227, 235, 251), (71, 106, 159)),
         'Wings to fly to the Moon', 'Granted', (66, 114, 85), 'Raised by Atlas \u00b7 granted by Wingsmith', 'sparkle')
    card('r-0419.png', os.path.join(ROOT, 'public/avatars/forge.png'), 'REPORT #0419', ((232, 225, 249), (120, 98, 148)),
         'Rocket countdown stuck at 1', 'Fixed', (66, 114, 85), 'Reported by Forge \u00b7 fixed by Wingsmith', 'check')
