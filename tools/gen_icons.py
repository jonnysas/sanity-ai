#!/usr/bin/env python3
"""Generate the Sanity AI toolbar icons (icon16/32/48/128.png).

Pure stdlib — no PIL. Draws with 4x supersampling and writes PNGs by hand.

The mark: "Still Horizon" — a warm white sun settling into still indigo
water. The day is done; you can stop watching. Sky above the horizon,
deeper water below, the sun half-dipped, one quiet reflection.

Run from the repo root:  python3 tools/gen_icons.py
"""
import math
import os
import struct
import zlib

SKY_TOP = (0x60, 0x57, 0xF4)     # indigo sky, vertical gradient
SKY_BOT = (0x4C, 0x43, 0xDF)
WATER_TOP = (0x39, 0x31, 0xB9)   # deeper indigo water
WATER_BOT = (0x2F, 0x28, 0x9E)
SUN = (0xFF, 0xFD, 0xF4)         # warm paper white
GLOW_A = 0.14                    # soft halo around the sun (sky only)
LINE_A = 0.22                    # hairline at the waterline
REFL_A = 0.38                    # reflection dash opacity
HORIZON_Y = 0.615                # waterline, fraction of edge
SS = 4


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def mix(c, d, t):
    return tuple(lerp(c[i], d[i], t) for i in range(3))


def rounded_rect_dist(x, y, cx, cy, half, r):
    qx = abs(x - cx) - (half - r)
    qy = abs(y - cy) - (half - r)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return math.hypot(ax, ay) + min(max(qx, qy), 0.0) - r


def capsule_dist(x, y, x0, x1, cy, r):
    px = min(max(x, x0), x1)
    return math.hypot(x - px, y - cy) - r


def render(size, sun_frac, dip_frac=0.30, refl=False, refl_w_frac=0.025,
           tile_r_frac=0.27, glow=True, line=True):
    """sun_frac: sun diameter as fraction of edge.
    dip_frac: how much of the sun's diameter sits below the waterline."""
    S = size * SS
    cx = S / 2.0
    half = S / 2.0
    tile_r = S * tile_r_frac
    hy = S * HORIZON_Y
    sun_r = S * sun_frac / 2.0
    sun_cy = hy - sun_r + (2 * sun_r * dip_frac)
    aa = SS * 0.75

    buf = [[(0, 0, 0, 0)] * S for _ in range(S)]
    for j in range(S):
        for i in range(S):
            x, y = i + 0.5, j + 0.5
            d_tile = rounded_rect_dist(x, y, cx, half, half - S * 0.004, tile_r)
            a_tile = 1.0 - smoothstep(-aa, aa, d_tile)
            if a_tile <= 0.0:
                continue

            water = smoothstep(hy - aa, hy + aa, y)  # 0 sky, 1 water
            sky_c = mix(SKY_TOP, SKY_BOT, y / max(1.0, hy))
            wat_c = mix(WATER_TOP, WATER_BOT,
                        (y - hy) / max(1.0, S - hy))
            r, g, b = mix(sky_c, wat_c, water)

            d_sun_c = math.hypot(x - cx, y - sun_cy)
            # soft halo in the sky only — the last light of the day
            if glow and water < 1.0:
                halo = (1.0 - smoothstep(sun_r, sun_r * 2.6, d_sun_c))
                halo *= GLOW_A * (1.0 - water)
                if halo > 0:
                    r, g, b = mix((r, g, b), SUN, halo)
            # hairline at the waterline for crispness
            if line:
                d_line = abs(y - hy) - S * 0.006
                a_line = (1.0 - smoothstep(-aa, aa, d_line)) * LINE_A
                if a_line > 0:
                    r, g, b = mix((r, g, b), (255, 255, 255), a_line)
            # reflection dash on the water
            if refl:
                rr = S * refl_w_frac / 2.0
                rx = sun_r * 0.62
                ry = hy + S * 0.10
                d_refl = capsule_dist(x, y, cx - rx, cx + rx, ry, rr)
                a_refl = (1.0 - smoothstep(-aa, aa, d_refl)) * REFL_A
                if a_refl > 0:
                    r, g, b = mix((r, g, b), SUN, a_refl)
            # the sun — visible only above the waterline (it dips behind)
            a_sun = (1.0 - smoothstep(-aa, aa, d_sun_c - sun_r)) * (1.0 - water)
            if a_sun > 0:
                r, g, b = mix((r, g, b), SUN, a_sun)
            buf[j][i] = (r, g, b, 255.0 * a_tile)

    rows = []
    for j in range(size):
        row = bytearray()
        for i in range(size):
            R = G = B = A = 0.0
            for dj in range(SS):
                for di in range(SS):
                    r, g, b, a = buf[j * SS + dj][i * SS + di]
                    R += r * a
                    G += g * a
                    B += b * a
                    A += a
            if A > 0:
                row += bytes((int(R / A + 0.5), int(G / A + 0.5),
                              int(B / A + 0.5), int(A / (SS * SS) + 0.5)))
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    raw = b"".join(b"\x00" + r for r in rows)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    specs = {
        # 16: sky/water split + half-dipped dot; no halo/line noise
        16: dict(sun_frac=0.44, dip_frac=0.32, tile_r_frac=0.28,
                 glow=False, line=False),
        32: dict(sun_frac=0.40, dip_frac=0.31, glow=False, line=True),
        48: dict(sun_frac=0.38, dip_frac=0.30, refl=True,
                 refl_w_frac=0.032, line=True),
        128: dict(sun_frac=0.36, dip_frac=0.30, refl=True,
                  refl_w_frac=0.022, line=True),
    }
    for size, kw in specs.items():
        path = os.path.join(root, f"icon{size}.png")
        write_png(path, size, render(size, **kw))
        print(f"wrote icon{size}.png")


if __name__ == "__main__":
    main()
