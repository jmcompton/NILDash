"""
Generate NILDash logo PNGs using Pillow (no cairo required).
Outputs:
  public/images/nildash-icon-120x120.png   — square N icon
  public/images/nildash-logo-header.png    — 400x80 horizontal header logo
  public/images/nildash-logo-full.png      — 600x180 full landing logo
"""
from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs("public/images", exist_ok=True)

# ── Color palette ─────────────────────────────────────────────────────────────
BG        = (6, 9, 16)          # #060910
GREEN     = (163, 230, 53)      # #A3E635  (lime)
GREEN2    = (22, 163, 74)       # #16A34A  (darker green)
WHITE     = (255, 255, 255)
DARK_TEXT = (6, 9, 16)          # text on green bg

# ── Font setup ────────────────────────────────────────────────────────────────
FONT_PATH = "/System/Library/Fonts/Helvetica.ttc"

def get_font(size, bold=True):
    try:
        return ImageFont.truetype(FONT_PATH, size, index=1 if bold else 0)
    except Exception:
        return ImageFont.load_default()

def draw_rounded_rect(draw, xy, radius, fill):
    """Draw a filled rounded rectangle."""
    x0, y0, x1, y1 = xy
    draw.rounded_rectangle([x0, y0, x1, y1], radius=radius, fill=fill)

def draw_gradient_rect(img, xy, r, color_top, color_bot):
    """Approximate vertical gradient with many thin horizontal slices."""
    x0, y0, x1, y1 = xy
    h = y1 - y0
    # Create a temp RGBA image for the gradient then composite
    tmp = Image.new("RGBA", (x1 - x0, h), (0, 0, 0, 0))
    td = ImageDraw.Draw(tmp)
    for i in range(h):
        t = i / max(h - 1, 1)
        r_c = int(color_top[0] + t * (color_bot[0] - color_top[0]))
        g_c = int(color_top[1] + t * (color_bot[1] - color_top[1]))
        b_c = int(color_top[2] + t * (color_bot[2] - color_top[2]))
        td.line([(0, i), (x1 - x0, i)], fill=(r_c, g_c, b_c, 255))
    # Mask with rounded rect
    mask = Image.new("L", (x1 - x0, h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, x1 - x0 - 1, h - 1], radius=r, fill=255)
    tmp.putalpha(mask)
    img.paste(tmp, (x0, y0), tmp)


# ─────────────────────────────────────────────────────────────────────────────
# 1. ICON  120×120
# ─────────────────────────────────────────────────────────────────────────────
W, H = 120, 120
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d   = ImageDraw.Draw(img)

# Dark outer bg (square, no radius — shows as square favicon)
d.rectangle([0, 0, W - 1, H - 1], fill=BG)

# Green rounded-rect tile (gradient top→bottom)
draw_gradient_rect(img, [8, 8, 112, 112], 14, GREEN, GREEN2)

# "N" glyph
font_n = get_font(76)
d2 = ImageDraw.Draw(img)
bbox = d2.textbbox((0, 0), "N", font=font_n)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
tx = (W - tw) // 2 - bbox[0]
ty = (H - th) // 2 - bbox[1] + 4
d2.text((tx, ty), "N", font=font_n, fill=DARK_TEXT)

img.save("public/images/nildash-icon-120x120.png")
print("✓ nildash-icon-120x120.png")


# ─────────────────────────────────────────────────────────────────────────────
# 2. HEADER LOGO  400×80  (transparent background)
# ─────────────────────────────────────────────────────────────────────────────
W, H = 400, 80
img = Image.new("RGBA", (W, H), (0, 0, 0, 0))

# Green icon tile (46×46 at y=8)
draw_gradient_rect(img, [0, 8, 46, 54], 8, GREEN, GREEN2)
d2 = ImageDraw.Draw(img)
font_n2 = get_font(30)
bbox = d2.textbbox((0, 0), "N", font=font_n2)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
tx = 23 - tw // 2 - bbox[0]
ty = 31 - th // 2 - bbox[1]
d2.text((tx, ty), "N", font=font_n2, fill=DARK_TEXT)

# "NIL" white
font_word = get_font(28)
d2.text((58, 9), "NIL", font=font_word, fill=WHITE)
# "DASH" green
d2.text((58, 40), "DASH", font=font_word, fill=GREEN)

img.save("public/images/nildash-logo-header.png")
print("✓ nildash-logo-header.png")


# ─────────────────────────────────────────────────────────────────────────────
# 3. FULL LOGO  600×180  (dark bg)
# ─────────────────────────────────────────────────────────────────────────────
W, H = 600, 180
img = Image.new("RGBA", (W, H), BG)
d   = ImageDraw.Draw(img)

# Subtle border
d.rounded_rectangle([0, 0, W - 1, H - 1], radius=14, outline=(*GREEN, 70), width=1)

# Green accent bar at top
d.rounded_rectangle([0, 0, W - 1, 3], radius=1, fill=GREEN)

# Large icon tile  108×108 at (28, 28)
draw_gradient_rect(img, [28, 28, 136, 136], 14, GREEN, GREEN2)
d2 = ImageDraw.Draw(img)
font_n3 = get_font(74)
bbox = d2.textbbox((0, 0), "N", font=font_n3)
tw = bbox[2] - bbox[0]
th = bbox[3] - bbox[1]
tx = 82 - tw // 2 - bbox[0]
ty = 82 - th // 2 - bbox[1] + 4
d2.text((tx, ty), "N", font=font_n3, fill=DARK_TEXT)

# "NIL" white large
font_big = get_font(58)
d2.text((158, 22), "NIL", font=font_big, fill=WHITE)
# "DASH" green large
d2.text((158, 80), "DASH", font=font_big, fill=GREEN)

# Tagline bar
d2.rounded_rectangle([158, 150, 358, 166], radius=3, fill=(10, 26, 10))
font_tag = get_font(9, bold=False)
d2.text((166, 154), "NIL INTELLIGENCE PLATFORM", font=font_tag, fill=GREEN)

img.save("public/images/nildash-logo-full.png")
print("✓ nildash-logo-full.png")

print("\nAll logo files generated in public/images/")
