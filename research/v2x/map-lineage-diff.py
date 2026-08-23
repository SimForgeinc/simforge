#!/usr/bin/env python3
"""Structural diff between the two Richmond Field Station XODR lineages.

Lineage A ("deployed"): CARLA 0.10 cache export, sha256 0737f3d9…,
        Richmond_Field_Station_Richmond_CA.xodr (2026-06-11).
Lineage B ("uni"):      UniScenarios bundle dev-assets/richmond-field-station,
        sha256 80704cd1…, richmond-field-station_20260410-185647.xodr (2026-04-09).

Stdlib-only. Reports header/georef/extents, network counts, id overlap, and
windowed reference-line geometry deltas around the calibration sites that the
V2XCarla digital twin depends on (the shared camera pole and the signalised
junction the cameras face). Evidence for the V5 lineage decision.
"""

from __future__ import annotations

import json
import math
import sys
import xml.etree.ElementTree as ET

# --- legacy flat-earth projection (V2XCarla geo_utils.py contract) ----------
LAT0 = 37.9150891287087
LON0 = -122.333308830857
M_PER_DEG_LAT = 111_320.0


def flat_earth(lat: float, lon: float) -> tuple[float, float]:
    x = (lon - LON0) * M_PER_DEG_LAT * math.cos(math.radians(LAT0))
    y = -((lat - LAT0) * M_PER_DEG_LAT)
    return x, y


# --- OpenDRIVE planView evaluation ------------------------------------------

def _poly3(c, s):
    a, b, cc, d = c
    ds = s
    return a + ds * (b + ds * (cc + ds * d))


def road_samples(road_el, step_m=2.0):
    """Sample a road's reference line as [(x, y)] in xodr-local metres."""
    plan = road_el.find("planView")
    if plan is None:
        return []
    pts = []
    for geo in plan.findall("geometry"):
        s = float(geo.get("s"))
        x = float(geo.get("x"))
        y = float(geo.get("y"))
        h = float(geo.get("hdg"))
        length = float(geo.get("length"))
        inner = next(iter(geo))
        tag = inner.tag.split("}")[-1]
        n = max(2, int(length / step_m) + 1)
        local = []
        if tag == "line":
            for i in range(n):
                t = length * i / (n - 1)
                local.append((x + math.cos(h) * t, y + math.sin(h) * t))
        elif tag == "arc":
            k = float(inner.get("curvature"))
            cx, cy, ch = x, y, h
            seg = length / (n - 1)
            local.append((cx, cy))
            for _ in range(n - 1):
                ch += k * seg
                cx += math.cos(ch) * seg
                cy += math.sin(ch) * seg
                local.append((cx, cy))
        elif tag == "spiral":
            cu = float(inner.get("curvStart", 0.0))
            cv = float(inner.get("curvEnd", 0.0)) - cu
            dot = cv / length if length else 0.0
            cx, cy, ch = x, y, h
            local.append((cx, cy))
            remaining = length
            while remaining > 1e-9:
                st = min(0.5, remaining)
                tx, ty, th = cx, cy, ch
                steps = 4
                step = st / steps
                for i in range(steps):
                    k = cu + dot * step * (i + 0.5)
                    th += k * step
                    tx += math.cos(th) * step
                    ty += math.sin(th) * step
                local.append((tx, ty))
                cx, cy, ch = tx, ty, th
                remaining -= st
        elif tag == "paramPoly3":
            au, bu, cu_, du = (float(inner.get(f"{k}U", 0.0)) for k in "abcd")
            av, bv, cv_, dv = (float(inner.get(f"{k}V", 0.0)) for k in "abcd")
            prange = inner.get("pRange")
            for i in range(n):
                p = (float(prange) if prange else length) * i / (n - 1)
                u = _poly3((au, bu, cu_, du), p)
                v = _poly3((av, bv, cv_, dv), p)
                local.append(
                    (
                        x + math.cos(h) * u - math.sin(h) * v,
                        y + math.sin(h) * u + math.cos(h) * v,
                    )
                )
        else:
            continue
        pts.extend(local)
    return pts


def parse(path: str):
    root = ET.parse(path).getroot()
    hdr = root.find("header")
    info = {
        "date": hdr.get("date"),
        "vendor": hdr.get("vendor"),
        "north": float(hdr.get("north")),
        "south": float(hdr.get("south")),
        "east": float(hdr.get("east")),
        "west": float(hdr.get("west")),
    }
    georef = hdr.find("geoReference")
    info["georef"] = (georef.text or "").strip() if georef is not None else None
    roads = {}
    for r in root.findall("road"):
        rid = r.get("id")
        name = r.get("name") or ""
        length = float(r.get("length"))
        junction = r.get("junction")
        lanes = len(r.findall("./lanes/laneSection/left/lane")) + len(
            r.findall("./lanes/laneSection/right/lane")
        )
        roads[rid] = {"name": name, "length": length, "junction": junction, "lanes": lanes}
    juncs = {j.get("id"): [c.get("incomingRoad") for c in j.findall("connection")]
             for j in root.findall("junction")}
    signals = len(root.findall(".//signal"))
    objects = len(root.findall(".//object"))
    return info, roads, juncs, signals, objects, root


def grid_index(points, cell=10.0):
    g: dict[tuple[int, int], list] = {}
    for p in points:
        g.setdefault((int(p[0] // cell), int(p[1] // cell)), []).append(p)
    return g, cell


def nn_dist(p, g, cell):
    cx, cy = int(p[0] // cell), int(p[1] // cell)
    best = float("inf")
    for dx in (-1, 0, 1):
        for dy in (-1, 0, 1):
            for q in g.get((cx + dx, cy + dy), ()):
                d = math.hypot(p[0] - q[0], p[1] - q[1])
                if d < best:
                    best = d
    return best


def window_delta(samples_a, samples_b, center, radius):
    g, cell = grid_index(samples_b)
    ds = []
    inside = [p for p in samples_a if math.hypot(p[0] - center[0], p[1] - center[1]) <= radius]
    for p in inside:
        d = nn_dist(p, g, cell)
        if d != float("inf"):
            ds.append(d)
    if not ds:
        return {"n": 0}
    ds.sort()

    def pct(q):
        return ds[min(len(ds) - 1, int(q * len(ds)))]

    return {
        "n": len(ds),
        "median_m": round(pct(0.5), 3),
        "p90_m": round(pct(0.9), 3),
        "max_m": round(ds[-1], 3),
        "within_05m_pct": round(100 * sum(d <= 0.5 for d in ds) / len(ds), 1),
    }


def main():
    a_path = sys.argv[1]
    b_path = sys.argv[2]
    ia, ra, ja, sa, oa, _ = parse(a_path)
    ib, rb, jb, sb, ob, _ = parse(b_path)

    report = {"deployed": {"path": a_path, **ia, "roads": len(ra), "junctions": len(ja),
                           "signals": sa, "objects": oa},
              "uni": {"path": b_path, **ib, "roads": len(rb), "junctions": len(jb),
                      "signals": sb, "objects": ob}}

    ids_a, ids_b = set(ra), set(rb)
    shared = ids_a & ids_b
    report["id_overlap"] = {
        "shared_road_ids": len(shared),
        "only_deployed": sorted(ids_a - ids_b, key=int),
        "only_uni": sorted(ids_b - ids_a, key=int),
        "shared_junction_ids": len(set(ja) & set(jb)),
        "junction_only_deployed": sorted(set(ja) - set(jb), key=int),
        "junction_only_uni": sorted(set(jb) - set(ja), key=int),
    }

    # geometry identity among shared ids (same ref-line length within 1 cm)
    same_len = [rid for rid in shared if abs(ra[rid]["length"] - rb[rid]["length"]) <= 0.01]
    report["shared_geometry_identity"] = {
        "same_ref_length_within_1cm": len(same_len),
        "different_length": len(shared) - len(same_len),
    }

    only_a = {rid: ra[rid] for rid in ids_a - ids_b}
    report["roads_only_deployed"] = sorted(
        ({"id": rid, **v} for rid, v in only_a.items()),
        key=lambda e: -e["length"])[:15]
    only_b = {rid: rb[rid] for rid in ids_b - ids_a}
    report["roads_only_uni"] = sorted(
        ({"id": rid, **v} for rid, v in only_b.items()),
        key=lambda e: -e["length"])[:15]

    # --- windowed geometry deltas ------------------------------------------
    pole = flat_earth(37.91560117034595, -122.33478756387032)  # cameras.json site
    samples_a = []
    samples_b = []
    for el, acc in ((ET.parse(a_path).getroot(), samples_a),
                    (ET.parse(b_path).getroot(), samples_b)):
        for r in el.findall("road"):
            acc.extend(road_samples(r))

    report["camera_pole_window"] = {
        "center_xy_flat_earth": [round(v, 2) for v in pole],
        "radius_m": 120,
        "deployed_to_uni": window_delta(samples_a, samples_b, pole, 120),
    }

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
