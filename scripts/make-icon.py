"""Draw the Team Room app icon (1024x1024 PNG) with the standard library only.

Two overlapping discs, Claude's orange and Codex's teal, on a dark rounded
square; the overlap is where the room happens. Usage: python3 make-icon.py out.png
"""
import struct
import sys
import zlib

SIZE = 1024
SS = 2  # supersampling per axis, for smooth edges

BG = (23, 25, 30)
CLAUDE = (233, 138, 85)
CODEX = (79, 184, 196)
BLEND = (236, 232, 222)  # the shared space, warm white


def inside_rounded_square(x, y, margin=100, radius=185):
    lo, hi = margin, SIZE - margin
    if x < lo or x > hi or y < lo or y > hi:
        return False
    cx = min(max(x, lo + radius), hi - radius)
    cy = min(max(y, lo + radius), hi - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def pixel(x, y):
    if not inside_rounded_square(x, y):
        return None
    r = 205
    in_a = (x - 405) ** 2 + (y - 512) ** 2 <= r * r
    in_b = (x - 619) ** 2 + (y - 512) ** 2 <= r * r
    if in_a and in_b:
        return BLEND
    if in_a:
        return CLAUDE
    if in_b:
        return CODEX
    return BG


def render():
    rows = []
    step = 1 / SS
    for y in range(SIZE):
        row = bytearray([0])  # PNG filter type: none
        for x in range(SIZE):
            acc = [0, 0, 0, 0]
            for sy in range(SS):
                for sx in range(SS):
                    c = pixel(x + (sx + 0.5) * step, y + (sy + 0.5) * step)
                    if c:
                        acc[0] += c[0]
                        acc[1] += c[1]
                        acc[2] += c[2]
                        acc[3] += 255
            n = SS * SS
            a = acc[3] // n
            if a:
                cov = acc[3] / 255
                row += bytes((int(acc[0] / cov), int(acc[1] / cov), int(acc[2] / cov), a))
            else:
                row += b"\x00\x00\x00\x00"
        rows.append(bytes(row))
    return b"".join(rows)


def png(path, raw):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    png(sys.argv[1], render())
