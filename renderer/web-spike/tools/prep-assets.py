#!/usr/bin/env python3
"""Offline asset prep for the web-spike feasibility gate (NON-PRODUCT).

1. bc7: rewrite a KTX2-repacked tile GLB (KHR_texture_basisu, UASTC+zstd) so every
   embedded KTX2 image is transcoded UASTC -> BC7 (still zstd-supercompressed) via the
   KTX-Software `ktx transcode` CLI. WebGPU cannot sample UASTC directly; shipping a
   basis transcoder in the spike wasm is out of scope, so we pre-transcode to the BC
   family the desktop GPU consumes anyway. Texture *container* stays KTX2 and the wasm
   loader parses it (header, level index, zstd) at runtime.
2. animate: inject a glTF animation into a static vehicle GLB: root node drives a
   circle (translation + yaw rotation), wheels spin. Produces a real animated actor
   from the CC-BY CARLA vehicle catalog without hand-authoring assets.

Usage:
  prep-assets.py bc7     <in.glb> <out.glb> --ktx <ktx-binary>
  prep-assets.py animate <in.glb> <out.glb> [--radius 8] [--period 8] [--wheel-radius 0.33]
"""

import argparse
import json
import math
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def read_glb(path):
    data = Path(path).read_bytes()
    magic, version, _length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67 and version == 2, "not a glb2"
    off = 12
    js = None
    bin_ = b""
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        off += 8
        chunk = data[off : off + clen]
        off += clen
        if ctype == JSON_CHUNK:
            js = json.loads(chunk)
        elif ctype == BIN_CHUNK:
            bin_ = chunk
    return js, bin_


def write_glb(path, js, bin_):
    jb = json.dumps(js, separators=(",", ":")).encode()
    jb += b" " * (-len(jb) % 4)
    bin_ = bytes(bin_) + b"\x00" * (-len(bin_) % 4)
    total = 12 + 8 + len(jb) + 8 + len(bin_)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(jb), JSON_CHUNK))
        f.write(jb)
        f.write(struct.pack("<II", len(bin_), BIN_CHUNK))
        f.write(bin_)


def bv_bytes(js, bin_, i):
    bv = js["bufferViews"][i]
    o = bv.get("byteOffset", 0)
    return bin_[o : o + bv["byteLength"]]


def cmd_bc7(args):
    js, bin_ = read_glb(args.input)
    replaced = {}
    with tempfile.TemporaryDirectory() as td:
        for idx, img in enumerate(js.get("images", [])):
            if img.get("mimeType") != "image/ktx2":
                continue
            src = Path(td) / f"{idx}.ktx2"
            dst = Path(td) / f"{idx}.bc7.ktx2"
            src.write_bytes(bv_bytes(js, bin_, img["bufferView"]))
            subprocess.run(
                [args.ktx, "transcode", "--target", "bc7", "--zstd", "18", str(src), str(dst)],
                check=True,
                capture_output=True,
            )
            replaced[img["bufferView"]] = dst.read_bytes()
    # rebuild BIN: every bufferView re-emitted 4-aligned, image views swapped for BC7 payloads
    out = bytearray()
    for i, bv in enumerate(js["bufferViews"]):
        payload = replaced.get(i, bv_bytes(js, bin_, i))
        out += b"\x00" * (-len(out) % 4)
        bv["byteOffset"] = len(out)
        bv["byteLength"] = len(payload)
        out += payload
    js["buffers"][0]["byteLength"] = len(out)
    write_glb(args.output, js, out)
    print(f"{args.output}: {len(replaced)} images -> BC7, {Path(args.output).stat().st_size} bytes")


def cmd_animate(args):
    js, bin_ = read_glb(args.input)
    bin_ = bytearray(bin_)
    nodes = js["nodes"]
    root = js["scenes"][js.get("scene", 0)]["nodes"][0]
    wheel_ids = [i for i, n in enumerate(nodes) if "wheel" in (n.get("name") or "")]

    period = args.period
    nkeys = 65
    times = [period * i / (nkeys - 1) for i in range(nkeys)]
    r = args.radius
    root_t, root_r = [], []
    for t in times:
        a = 2 * math.pi * t / period
        # circle in XZ plane (glTF Y-up), heading tangent to the circle
        root_t += [r * math.sin(a), 0.0, r * math.cos(a)]
        half = a / 2  # yaw about +Y by angle a
        root_r += [0.0, math.sin(half), 0.0, math.cos(half)]
    # wheel spin about local Z, angular speed = v / wheel_radius
    v = 2 * math.pi * r / period
    wheel_r = []
    for t in times:
        ang = -(v / args.wheel_radius) * t
        half = ang / 2
        wheel_r += [0.0, 0.0, math.sin(half), math.cos(half)]

    def push(data, fmt):
        nonlocal bin_
        raw = struct.pack(f"<{len(data)}{fmt}", *data)
        bin_ += b"\x00" * (-len(bin_) % 4)
        off = len(bin_)
        bin_ += raw
        js["bufferViews"].append({"buffer": 0, "byteOffset": off, "byteLength": len(raw)})
        return len(js["bufferViews"]) - 1

    def accessor(bv, count, type_, comp=5126, mn=None, mx=None):
        a = {"bufferView": bv, "componentType": comp, "count": count, "type": type_}
        if mn is not None:
            a["min"], a["max"] = mn, mx
        js["accessors"].append(a)
        return len(js["accessors"]) - 1

    t_acc = accessor(push(times, "f"), nkeys, "SCALAR", mn=[times[0]], mx=[times[-1]])
    rt_acc = accessor(push(root_t, "f"), nkeys, "VEC3")
    rr_acc = accessor(push(root_r, "f"), nkeys, "VEC4")
    wr_acc = accessor(push(wheel_r, "f"), nkeys, "VEC4")

    samplers = [
        {"input": t_acc, "output": rt_acc, "interpolation": "LINEAR"},
        {"input": t_acc, "output": rr_acc, "interpolation": "LINEAR"},
    ]
    channels = [
        {"sampler": 0, "target": {"node": root, "path": "translation"}},
        {"sampler": 1, "target": {"node": root, "path": "rotation"}},
    ]
    for w in wheel_ids:
        samplers.append({"input": t_acc, "output": wr_acc, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": w, "path": "rotation"}})

    js["animations"] = [{"name": "drive_circle", "samplers": samplers, "channels": channels}]
    js["buffers"][0]["byteLength"] = len(bin_)
    write_glb(args.output, js, bin_)
    print(f"{args.output}: animation drive_circle ({nkeys} keys, {len(channels)} channels, wheels={wheel_ids})")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("bc7")
    b.add_argument("input")
    b.add_argument("output")
    b.add_argument("--ktx", required=True)
    b.set_defaults(fn=cmd_bc7)
    a = sub.add_parser("animate")
    a.add_argument("input")
    a.add_argument("output")
    a.add_argument("--radius", type=float, default=8.0)
    a.add_argument("--period", type=float, default=8.0)
    a.add_argument("--wheel-radius", type=float, default=0.33)
    a.set_defaults(fn=cmd_animate)
    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
