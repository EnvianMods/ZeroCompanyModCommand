"""
Zero Company Mod Command — application icon generator.

Draws the app's signature holo emblem (cyan hexagon + amber six-spoke command
burst on a dark space tile) with Pillow at 4x supersampling, then emits:
  build/icon.ico   (16,24,32,48,64,128,256 — Windows exe + window icon)
  build/icon.png   (512 — Linux AppImage)
  src/assets/app-icon.png (256 — reference / in-app use)

Palette matches src/styles.css / nexus-header.svg:
  holo cyan  #4fd1ff   amber #ffc857   space #0e1c33 -> #03060c
"""
import math, os
from PIL import Image, ImageDraw

# ---- palette -------------------------------------------------------------
CYAN   = (79, 209, 255)
AMBER  = (255, 200, 87)
SPACE_HI = (16, 30, 54)     # #101e36  (a touch brighter than the header for punch)
SPACE_LO = (3, 6, 12)       # #03060c
STAR   = (207, 233, 247)

SS = 4                       # supersample factor
BASE = 1024                  # master logical size
S = BASE * SS                # canvas px
C = S / 2                    # center


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def radial_bg():
    """Dark space tile: bright-ish core top-left-of-center fading to near black,
    built from concentric ellipses (no numpy needed)."""
    img = Image.new("RGBA", (S, S), SPACE_LO + (255,))
    d = ImageDraw.Draw(img)
    cx, cy = C, C * 0.92                      # glow origin slightly high
    maxr = S * 0.95
    steps = 480
    for i in range(steps):
        t = i / (steps - 1)
        r = maxr * (1 - t)
        col = lerp(SPACE_LO, SPACE_HI, t)     # outer dark -> inner bright
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col + (255,))
    return img


def grid_layer():
    """Faint holo grid on its own transparent layer (matches the header grid)."""
    g = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    step = int(S / 12)
    col = CYAN + (14,)
    for x in range(0, S, step):
        d.line([(x, 0), (x, S)], fill=col, width=SS)
    for y in range(0, S, step):
        d.line([(0, y), (S, y)], fill=col, width=SS)
    return g


def glow_layer(radius, color, peak=120):
    """Soft radial glow as its own layer, additively blended."""
    g = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    steps = 220
    for i in range(steps):
        t = i / (steps - 1)
        r = radius * (1 - t)
        a = int(peak * (t ** 2))              # brightest at center
        d.ellipse([C - r, C - r, C + r, C + r], fill=color + (a,))
    return g


def hexagon(cx, cy, R):
    # pointy-top hexagon (vertex straight up), matching nexus-header.svg
    pts = [(0, -100), (86.6, -50), (86.6, 50), (0, 100), (-86.6, 50), (-86.6, -50)]
    return [(cx + px / 100 * R, cy + py / 100 * R) for px, py in pts]


def draw_emblem(d):
    """Draw onto a transparent overlay's ImageDraw `d` (so alphas are preserved
    and get alpha_composited over the background)."""
    R = S * 0.30                              # hexagon circumradius

    # inner faint hexagon "glass panel" fill + stroke
    inner = hexagon(C, C, R * 0.74)
    d.polygon(inner, fill=CYAN + (40,))
    d.line(inner + [inner[0]], fill=CYAN + (150,), width=max(2, int(R * 0.015)))

    # two horizontal scan bars across the panel (header motif) — under the burst
    bw = R * 1.02
    d.rectangle([C - bw, C - R * 0.24, C + bw, C - R * 0.24 + SS * 3], fill=CYAN + (34,))
    d.rectangle([C - bw, C + R * 0.36, C + bw, C + R * 0.36 + SS * 2], fill=CYAN + (24,))

    # outer hexagon outline (bright cyan)
    outer = hexagon(C, C, R)
    d.line(outer + [outer[0]], fill=CYAN + (255,), width=max(3, int(R * 0.05)))

    # six-spoke amber command burst (spokes at 30,90,...,330; radial gap at center)
    rin, rout = R * 0.14, R * 0.42
    w = max(3, int(R * 0.052))
    cap = w / 2
    for k in range(6):
        a = math.radians(30 + k * 60)
        x0, y0 = C + rin * math.cos(a), C + rin * math.sin(a)
        x1, y1 = C + rout * math.cos(a), C + rout * math.sin(a)
        d.line([(x0, y0), (x1, y1)], fill=AMBER + (255,), width=w)
        d.ellipse([x1 - cap, y1 - cap, x1 + cap, y1 + cap], fill=AMBER + (255,))

    # center core: dark backing separates the dot from the spoke ends, then a
    # crisp amber dot ringed in cyan (the emblem's focal "command" point)
    dot = R * 0.10
    back = dot * 1.7
    d.ellipse([C - back, C - back, C + back, C + back], fill=SPACE_LO + (235,))
    d.ellipse([C - dot * 1.28, C - dot * 1.28, C + dot * 1.28, C + dot * 1.28],
              outline=CYAN + (200,), width=max(2, int(R * 0.014)))
    d.ellipse([C - dot, C - dot, C + dot, C + dot], fill=AMBER + (255,))


def draw_frame(d, radius):
    """Cyan holo border + four corner HUD brackets onto overlay draw `d`."""
    inset = int(S * 0.045)
    bw = max(2, int(S * 0.006))
    d.rounded_rectangle([inset, inset, S - inset, S - inset],
                        radius=radius - inset, outline=CYAN + (70,), width=bw)
    m = int(S * 0.11)          # bracket arm length
    o = int(S * 0.075)         # offset from edge
    cw = max(3, int(S * 0.009))
    col = CYAN + (210,)
    corners = [
        [(o, o + m), (o, o), (o + m, o)],                          # TL
        [(S - o - m, o), (S - o, o), (S - o, o + m)],              # TR
        [(S - o, S - o - m), (S - o, S - o), (S - o - m, S - o)],  # BR
        [(o + m, S - o), (o, S - o), (o, S - o - m)],              # BL
    ]
    for pts in corners:
        d.line(pts, fill=col, width=cw, joint="curve")


def build_master():
    radius = int(S * 0.14)
    img = radial_bg()                                             # opaque tile
    img = Image.alpha_composite(img, grid_layer())               # faint grid
    img = Image.alpha_composite(img, glow_layer(S * 0.44, CYAN, peak=90))  # glow

    overlay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    draw_emblem(d)
    draw_frame(d, radius)
    img = Image.alpha_composite(img, overlay)

    img.putalpha(rounded_mask(S, radius))                        # round corners
    return img


def main():
    # This script lives in <project>/build/ ; project root is its parent.
    here = os.path.dirname(os.path.abspath(__file__))
    proj = os.environ.get("PROJ") or os.path.dirname(here)
    build = os.path.join(proj, "build")
    assets = os.path.join(proj, "src", "assets")
    os.makedirs(build, exist_ok=True)

    master = build_master()
    master1024 = master.resize((BASE, BASE), Image.LANCZOS)

    # Linux 512 png
    master1024.resize((512, 512), Image.LANCZOS).save(os.path.join(build, "icon.png"))
    # reference 256
    master1024.resize((256, 256), Image.LANCZOS).save(os.path.join(assets, "app-icon.png"))
    # master reference
    master1024.save(os.path.join(build, "icon-1024.png"))

    # Windows multi-res ico
    sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_imgs = [master1024.resize((n, n), Image.LANCZOS) for n in sizes]
    ico_imgs[-1].save(os.path.join(build, "icon.ico"),
                      format="ICO", sizes=[(n, n) for n in sizes])
    # small-size preview strip (16/24/32/48/64/128) on a mid-grey ground
    prev_sizes = [16, 24, 32, 48, 64, 128]
    pad = 12
    W = sum(prev_sizes) + pad * (len(prev_sizes) + 1)
    H = max(prev_sizes) + pad * 2
    sheet = Image.new("RGBA", (W, H), (90, 96, 104, 255))
    x = pad
    for n in prev_sizes:
        ic = master1024.resize((n, n), Image.LANCZOS)
        sheet.alpha_composite(ic, (x, H - pad - n))
        x += n + pad
    sheet.save(os.path.join(os.path.dirname(__file__), "icon-preview.png"))

    print("wrote:")
    for p in ["build/icon.ico", "build/icon.png", "build/icon-1024.png", "src/assets/app-icon.png"]:
        fp = os.path.join(proj, p)
        print(f"  {p:26} {os.path.getsize(fp):>8} bytes")


if __name__ == "__main__":
    main()
