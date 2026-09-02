#!/usr/bin/env python3
"""Convert the public-domain NASA celestial plates into the renderer's
`SKYTEX01` container.

Inputs (downloaded verbatim, checksums recorded in the emitted manifest):

* `starmap_2020_8k.exr` - NASA/Goddard SVS "Deep Star Maps 2020" (SVS id 4851),
  8192x4096 linear float equirectangular plate carree built from Gaia DR2,
  Hipparcos-2, Tycho-2 and the Yale Bright Star Catalog. Public domain.
* `lroc_color_poles_4k.tif` - NASA/Goddard SVS "CGI Moon Kit" (SVS id 4720),
  4096x2048 LROC WAC colour albedo of the lunar surface. Public domain.

The star plate's texel convention was established empirically (see
`verify_star_plate`) and is asserted here so a future re-download that changes
convention fails loudly instead of silently rotating the sky:

    u = frac(0.5 - RA_deg / 360)      v = (90 - Dec_deg) / 180

`SKYTEX01` layout (little endian):

    0   char[8]  "SKYTEX01"
    8   u32      width
    12  u32      height
    16  u32      format   0 = Rgba16Float, 1 = Rgba8UnormSrgb
    20  u32      reserved (0)
    24  ...      tightly packed rows, top row first
"""
from __future__ import annotations

import hashlib
import json
import struct
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

# renderer/tools/ -> renderer/. Downloads go to renderer/assets-src/ (not
# committed); products land beside SOURCES.json.
ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "assets-src"
OUT = ROOT / "render-core" / "assets" / "sky"

FORMAT_RGBA16F = 0
FORMAT_RGBA8_SRGB = 1

# Bright stars with J2000 positions, used to prove the plate's texel convention.
# (name, RA deg, Dec deg)
ANCHORS = [
    ("Sirius", 101.287, -16.716),
    ("Canopus", 95.988, -52.696),
    ("Vega", 279.234, 38.784),
    ("Arcturus", 213.915, 19.182),
    ("Betelgeuse", 88.793, 7.407),
    ("Rigel", 78.634, -8.202),
    ("Antares", 247.352, -26.432),
    ("Altair", 297.696, 8.868),
]
# Deep-sky anchors that must be bright, and a genuinely empty field.
EXTENDED = [("LMC", 80.894, -69.756), ("SMC", 13.187, -72.829)]
BLANK = ("blank-field", 40.0, -20.0)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def write_skytex(path: Path, width: int, height: int, fmt: int, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as fh:
        fh.write(b"SKYTEX01")
        fh.write(struct.pack("<IIII", width, height, fmt, 0))
        fh.write(payload)


def decode_exr(path: Path, width: int, height: int) -> np.ndarray:
    """Decode via ffmpeg to planar float32 GBR, return HxWx3 float32 RGB."""
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path),
         "-pix_fmt", "gbrpf32le", "-f", "rawvideo", "-"],
        capture_output=True, check=True,
    )
    planes = np.frombuffer(proc.stdout, dtype="<f4").reshape(3, height, width)
    return np.stack([planes[2], planes[0], planes[1]], axis=-1)


def texel(width: int, height: int, ra_deg: float, dec_deg: float) -> tuple[int, int]:
    u = (0.5 - ra_deg / 360.0) % 1.0
    v = (90.0 - dec_deg) / 180.0
    return int(u * width) % width, min(height - 1, int(v * height))


def verify_star_plate(rgb: np.ndarray) -> dict:
    """Assert the u/v convention by probing catalogued positions."""
    height, width, _ = rgb.shape
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    probes = {}
    for name, ra, dec in ANCHORS + EXTENDED + [BLANK]:
        x, y = texel(width, height, ra, dec)
        win = lum[max(0, y - 4):y + 5, max(0, x - 4):x + 5]
        probes[name] = round(float(win.max()), 5)
    faint = probes.pop(BLANK[0])
    for name, _, _ in ANCHORS:
        if probes[name] < 0.5:
            raise SystemExit(
                f"star plate convention check failed: {name} peak {probes[name]} < 0.5"
            )
    for name, _, _ in EXTENDED:
        if probes[name] < 0.02:
            raise SystemExit(
                f"star plate convention check failed: {name} peak {probes[name]} < 0.02"
            )
    if faint > 0.05:
        raise SystemExit(f"blank field is not blank: {faint}")

    # Mean luminance over the sphere (solid-angle weighted) closes the
    # display-referred gain against the ledger's natural sky illuminance.
    v = (np.arange(height, dtype=np.float64) + 0.5) / height
    weights = np.sin(v * np.pi)
    mean_lum = float((lum.mean(axis=1).astype(np.float64) * weights).sum() / weights.sum())
    return {
        "convention": "u = frac(0.5 - RA/360), v = (90 - Dec)/180",
        "anchor_peaks": probes,
        "blank_field_peak": faint,
        "solid_angle_mean_luminance": round(mean_lum, 8),
    }


def main() -> int:
    star_src = SRC / "starmap_2020_8k.exr"
    moon_src = SRC / "lroc_color_poles_4k.tif"
    for path in (star_src, moon_src):
        if not path.exists():
            raise SystemExit(f"missing input {path}")

    star_w, star_h = 8192, 4096
    rgb = decode_exr(star_src, star_w, star_h)
    report = verify_star_plate(rgb)

    rgba = np.empty((star_h, star_w, 4), dtype=np.float16)
    rgba[..., :3] = rgb.astype(np.float16)
    rgba[..., 3] = np.float16(1.0)
    star_out = OUT / "starmap_2020_8k.skytex"
    write_skytex(star_out, star_w, star_h, FORMAT_RGBA16F, rgba.tobytes())
    del rgba, rgb

    moon = Image.open(moon_src).convert("RGBA")
    moon_w, moon_h = moon.size
    moon_out = OUT / "moon_lroc_4k.skytex"
    write_skytex(moon_out, moon_w, moon_h, FORMAT_RGBA8_SRGB, moon.tobytes())

    manifest = {
        "schema": "simforge.sky-assets/v1",
        "generator": "tools/prepare_sky_assets.py",
        "sources": [
            {
                "id": "nasa-svs-4851-deep-star-maps-2020",
                "title": "Deep Star Maps 2020",
                "authority": "NASA/Goddard Space Flight Center Scientific Visualization Studio",
                "credit": "NASA/Goddard Space Flight Center Scientific Visualization Studio; "
                          "Gaia DR2, Hipparcos-2, Tycho-2, Yale Bright Star Catalog",
                "url": "https://svs.gsfc.nasa.gov/4851/",
                "file_url": "https://svs.gsfc.nasa.gov/vis/a000000/a004800/a004851/starmap_2020_8k.exr",
                "license": "Public domain (NASA media usage guidelines)",
                "download": star_src.name,
                "download_sha256": sha256(star_src),
                "download_bytes": star_src.stat().st_size,
                "product": star_out.name,
                "product_sha256": sha256(star_out),
                "product_bytes": star_out.stat().st_size,
                "width": star_w,
                "height": star_h,
                "format": "Rgba16Float",
                "verification": report,
            },
            {
                "id": "nasa-svs-4720-cgi-moon-kit",
                "title": "CGI Moon Kit - LROC colour albedo",
                "authority": "NASA/Goddard Space Flight Center Scientific Visualization Studio",
                "credit": "NASA/Goddard Space Flight Center Scientific Visualization Studio; "
                          "Lunar Reconnaissance Orbiter Camera (LROC) WAC colour, LOLA topography",
                "url": "https://svs.gsfc.nasa.gov/4720/",
                "file_url": "https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif",
                "license": "Public domain (NASA media usage guidelines)",
                "download": moon_src.name,
                "download_sha256": sha256(moon_src),
                "download_bytes": moon_src.stat().st_size,
                "product": moon_out.name,
                "product_sha256": sha256(moon_out),
                "product_bytes": moon_out.stat().st_size,
                "width": moon_w,
                "height": moon_h,
                "format": "Rgba8UnormSrgb",
                "projection": "simple cylindrical, lon 0 at texture centre, +90 lat at top row",
            },
        ],
    }
    (OUT / "SOURCES.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    print(f"wrote {star_out} and {moon_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
