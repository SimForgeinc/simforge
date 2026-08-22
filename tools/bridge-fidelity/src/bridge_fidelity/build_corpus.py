"""Build the WS1 real-data eval corpus manifest.

Stratifies two ungated real dashcam sources into the scenario classes the W0
kill-test clips cover:

- BDD100K det-10k split (images via public mirrors; labels + weather/scene/
  timeofday attributes from the official 100k label release, which covers the
  10k ids). The 10k split ships no attribute table of its own, so strata are
  joined by filename from ``bdd100k_labels_images_{train,val}`` content.
- nuScenes v1.0-trainval CAM_FRONT keyframes (research license permits eval
  use), selected geometrically from sample annotations transformed into the
  ego frame.

Strata (one per item, priority order):
  night        real night footage            (timeofday == night)
  weather      rain / fog / snow footage     (weather != clear)
  dart-out     near-field pedestrians        (proxy for dart-out/pedestrian)
  cut-in       adjacent-lane close vehicles  (single-frame cut-in proxy)
  intersection traffic-light presence        (signalized-intersection proxy)
  baseline     clear daytime driving

Output manifest schema: uniscenarios.bridge-fidelity-corpus-manifest.v1.
Raw images live OUTSIDE version control (see README); the manifest carries a
sha256 per item so the corpus is verifiable/reconstructable.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
from collections import Counter
from pathlib import Path

import numpy as np
from PIL import Image

MANIFEST_SCHEMA = "uniscenarios.bridge-fidelity-corpus-manifest.v1"

# Priority order; first match wins. Night/weather first because they are the
# rarest conditions and the W0 novel-content classes map onto them directly.
STRATA_ORDER = ["night", "weather", "dart-out", "cut-in", "intersection", "baseline"]

BDD_CLASS_TO_EVAL = {
    "car": "vehicle",
    "bus": "vehicle",
    "truck": "vehicle",
    "pedestrian": "pedestrian",
    "rider": "pedestrian",
    "bicycle": "bicycle",
    "motorcycle": "motorcycle",
}

NUSCENES_CAT_TO_EVAL = {
    "vehicle.car": "vehicle",
    "vehicle.truck": "vehicle",
    "vehicle.bus.bendy": "vehicle",
    "vehicle.bus.rigid": "vehicle",
    "vehicle.construction": "vehicle",
    "vehicle.trailer": "vehicle",
    "human.pedestrian.adult": "pedestrian",
    "human.pedestrian.child": "pedestrian",
    "human.pedestrian.wheelchair": "pedestrian",
    "human.pedestrian.stroller": "pedestrian",
    "human.pedestrian.personal_mobility": "pedestrian",
    "human.pedestrian.police_officer": "pedestrian",
    "human.pedestrian.construction_worker": "pedestrian",
    "vehicle.bicycle": "bicycle",
    "vehicle.motorcycle": "motorcycle",
}


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _norm_box(box: dict, w: int, h: int) -> list[float] | None:
    x1, y1, x2, y2 = box["x1"], box["y1"], box["x2"], box["y2"]
    bw, bh = x2 - x1, y2 - y1
    if bw <= 1 or bh <= 1:
        return None
    return [
        round(max(0.0, x1 / w), 5),
        round(max(0.0, y1 / h), 5),
        round(min(1.0, bw / w), 5),
        round(min(1.0, bh / h), 5),
    ]


def _quat_rotmat(q: list[float]) -> np.ndarray:
    w, x, y, z = q
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
            [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
            [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
        ]
    )


def _global_to_ego(pts: np.ndarray, ep: dict) -> np.ndarray:
    """nuScenes global-frame points -> ego-vehicle frame (+x fwd, +y left).

    Row-vector form of the inverse pose transform R^T (p - t).
    """
    Q = _quat_rotmat(ep["rotation"])
    return (pts - np.array(ep["translation"])) @ Q


def _ego_to_camera(pts: np.ndarray, cs: dict) -> np.ndarray:
    """nuScenes ego frame -> camera frame (+x right, +y down, +z fwd)."""
    Q = _quat_rotmat(cs["rotation"])
    return (pts - np.array(cs["translation"])) @ Q


def _annotation_corners_global(a: dict) -> np.ndarray:
    """8 corners of an annotated oriented box in the global frame."""
    R = _quat_rotmat(a["rotation"])
    l, w, h = a["size"]  # nuScenes size order: [length, width, height]
    xs = [-l / 2, l / 2]
    ys = [-w / 2, w / 2]
    zs = [0.0, h]  # translation is the bottom-center
    c = np.array([[x, y, z] for x in xs for y in ys for z in zs])
    return c @ R.T + np.array(a["translation"])


def project_annotation_pixels(a: dict, ep: dict, cs: dict, width: int, height: int) -> list[float] | None:
    """Project one annotated 3D box to a normalized [x,y,w,h] AABB, or None."""
    K = np.array(cs["camera_intrinsic"])
    corners = _annotation_corners_global(a)
    cam = _ego_to_camera(_global_to_ego(corners, ep), cs)
    if not (cam[:, 2] > 0.1).any():
        return None
    proj = (K @ cam.T).T
    pts = []
    for row in proj:
        if row[2] <= 0.1:
            continue
        pts.append((row[0] / row[2], row[1] / row[2]))
    if len(pts) < 4:
        return None
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
    if x1 >= width or y1 >= height or x2 <= 0 or y2 <= 0:
        return None
    bw, bh = min(x2, width) - max(x1, 0), min(y2, height) - max(y1, 0)
    if bw < 4 or bh < 4:
        return None
    return [
        round(max(0.0, x1 / width), 5),
        round(max(0.0, y1 / height), 5),
        round(bw / width, 5),
        round(bh / height, 5),
    ]


def load_bdd_attributes(labels_dir: Path, wanted: set[str]) -> dict[str, dict]:
    attrs: dict[str, dict] = {}
    for split in ("train", "val"):
        d = labels_dir / "bdd100k" / "labels" / "100k" / split
        if not d.is_dir():
            continue
        for p in d.iterdir():
            name = p.stem
            if name not in wanted or name in attrs:
                continue
            doc = json.loads(p.read_text())
            attrs[name] = doc.get("attributes", {})
    return attrs


def select_bdd(samples_path: Path, labels_dir: Path, per_stratum: dict[str, int], seed: int) -> dict[str, list[dict]]:
    samples = json.loads(Path(samples_path).read_text())["samples"]
    wanted = {Path(s["filepath"]).stem for s in samples}
    print(f"[bdd] joining attributes for {len(wanted)} ids ...")
    attrs = load_bdd_attributes(labels_dir, wanted)
    print(f"[bdd] attribute records found: {len(attrs)}")

    rng = random.Random(seed)
    buckets: dict[str, list[dict]] = {s: [] for s in STRATA_ORDER}
    for s in samples:
        name = Path(s["filepath"]).stem
        a = attrs.get(name)
        if a is None:
            continue
        meta = s.get("metadata", {})
        w, h = meta.get("width", 1280), meta.get("height", 720)
        eval_boxes = []
        ped_near = False
        tl_present = False
        adj_close_vehicle = False
        for d in s.get("detections", {}).get("detections", []):
            cls = BDD_CLASS_TO_EVAL.get(d["label"])
            bb = {"x1": d["bounding_box"][0] * w, "y1": d["bounding_box"][1] * h,
                  "x2": (d["bounding_box"][0] + d["bounding_box"][2]) * w,
                  "y2": (d["bounding_box"][1] + d["bounding_box"][3]) * h}
            nb = _norm_box(bb, w, h)
            if nb is None:
                continue
            if cls is not None:
                eval_boxes.append({"class": cls, "bbox": nb})
            if d["label"] == "pedestrian" and nb[3] >= 0.22 and nb[1] + nb[3] >= 0.45:
                ped_near = True
            if d["label"] == "traffic light":
                tl_present = True
            if d["label"] == "car":
                cx = nb[0] + nb[2] / 2
                bottom = nb[1] + nb[3]
                lateral = cx < 0.35 or cx > 0.65
                if lateral and bottom >= 0.78 and nb[2] >= 0.14:
                    adj_close_vehicle = True

        weather = a.get("weather", "clear")
        timeofday = a.get("timeofday", "daytime")
        # One stratum per item, priority order.
        if timeofday == "night":
            st = "night"
        elif weather in ("rainy", "foggy", "snowy"):
            st = "weather"
        elif ped_near:
            st = "dart-out"
        elif adj_close_vehicle:
            st = "cut-in"
        elif tl_present and weather == "clear" and timeofday == "daytime":
            st = "intersection"
        elif weather == "clear" and timeofday == "daytime" and eval_boxes:
            st = "baseline"
        else:
            continue
        buckets[st].append(
            {
                "id": f"bdd10k:{name}",
                "image": f"{name}.jpg",
                "width": w,
                "height": h,
                "stratum": st,
                "attributes": {"weather": weather, "scene": a.get("scene"), "timeofday": timeofday},
                "boxes": eval_boxes,
            }
        )

    picked: dict[str, list[dict]] = {}
    for st in STRATA_ORDER:
        pool = buckets[st]
        rng.shuffle(pool)
        n = per_stratum.get(st, 0)
        picked[st] = pool[:n]
        print(f"[bdd] stratum {st}: pool={len(pool)} picked={min(n, len(pool))}")
    return picked



def select_nuscenes(meta_dir: Path, per_stratum: dict[str, int], seed: int) -> dict[str, list[dict]]:
    def load(name):
        with open(meta_dir / f"{name}.json") as f:
            return json.load(f)
    print("[nus] loading metadata tables ...")
    sample = load("sample")
    sd_all = load("sample_data")
    ann_all = load("sample_annotation")
    cs_all = load("calibrated_sensor")
    ep_all = load("ego_pose")
    inst_all = load("instance")

    cs_by_tok = {c["token"]: c for c in cs_all}
    ep_by_tok = {e["token"]: e for e in ep_all}
    # v1.0 sample_annotation rows carry no category_token; resolve it through
    # the annotation's instance.
    cat_by_tok = {}
    with open(meta_dir / "category.json") as f:
        for c in json.load(f):
            cat_by_tok[c["token"]] = c["name"]
    cat_of_ann: dict[str, str] = {}
    cat_of_inst = {i["token"]: i["category_token"] for i in inst_all}


    for a in ann_all:
        ct = cat_of_inst.get(a["instance_token"])
        if ct is not None:
            cat_of_ann[a["token"]] = ct
    # v1.0-trainval sample_data has no `channel` column; it is encoded in the
    # filename: <log>__<CHANNEL>__<timestamp>.<ext>
    cam_front_keys = [
        sd for sd in sd_all
        if sd["is_key_frame"] and "__CAM_FRONT__" in sd["filename"]
    ]
    print(f"[nus] CAM_FRONT keyframes: {len(cam_front_keys)}")

    ann_by_sample: dict[str, list[dict]] = {}
    for a in ann_all:
        ann_by_sample.setdefault(a["sample_token"], []).append(a)

    sd_by_token = {sd["token"]: sd for sd in sd_all}

    rng = random.Random(seed + 1)
    buckets: dict[str, list[dict]] = {s: [] for s in ("dart-out", "cut-in")}
    sample_by_tok = {s["token"]: s for s in sample}
    for sd in cam_front_keys:
        smp = sample_by_tok.get(sd["sample_token"])
        if smp is None or len(ann_by_sample.get(sd["sample_token"], [])) == 0:
            continue
        cs = cs_by_tok[sd["calibrated_sensor_token"]]
        ep = ep_by_tok[sd["ego_pose_token"]]
        anns = ann_by_sample[sd["sample_token"]]
        boxes = []
        ped_near = False
        adj_close = False
        for a in anns:
            cls = NUSCENES_CAT_TO_EVAL.get(cat_by_tok.get(cat_of_ann.get(a["token"], ""), ""))
            if cls is None:
                continue
            # annotation translation is a single global point (box center);
            # transform to the ego frame for proximity tests.
            p = np.array([a["translation"]])
            e = _global_to_ego(p, ep)[0]
            # nuScenes ego frame: +x forward, +y left, +z up.
            fwd, lat = float(e[0]), float(e[1])
            if cls == "pedestrian" and 2 < fwd < 25 and abs(lat) < 8:
                ped_near = True
            if cls in ("vehicle", "bicycle", "motorcycle") and 2 < fwd < 20 and 1.8 < abs(lat) < 6.5:
                adj_close = True
            px = project_annotation_pixels(a, ep, cs, sd["width"], sd["height"])
            boxes.append({"class": cls, "bbox": px})
        if not boxes:
            continue
        st = "dart-out" if ped_near else ("cut-in" if adj_close else None)
        if st is None:
            continue
        buckets[st].append(
            {
                "id": f"nuscenes-camfront:{sd['token']}",
                "image": Path(sd["filename"]).name,
                "width": sd["width"],
                "height": sd["height"],
                "stratum": st,
                "attributes": {"source_scene": smp["scene_token"]},
                "boxes": [b for b in boxes if b.get("bbox") is not None],
            }
        )


    picked: dict[str, list[dict]] = {}
    for st, pool in buckets.items():
        rng.shuffle(pool)
        n = per_stratum.get(st, 0)
        picked[st] = pool[:n]
        print(f"[nus] stratum {st}: pool={len(pool)} picked={min(n, len(pool))}")
    return picked


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bdd-samples", type=Path, required=True, help="samples.json (FiftyOne export of the det-10k labels)")
    ap.add_argument("--bdd-labels-dir", type=Path, required=True, help="extracted official bdd100k label release root")
    ap.add_argument("--nuscenes-meta", type=Path, required=True, help="nuScenes v1.0-trainval metadata dir")
    ap.add_argument("--out", type=Path, required=True, help="manifest output path")
    ap.add_argument("--images-root", type=Path, default=Path(".corpus/images"),
                    help="directory holding fetched bdd/ and nuscenes/ images")
    ap.add_argument("--seed", type=int, default=20260822)
    args = ap.parse_args()

    bdd_per_stratum = {
        "night": 150, "weather": 150, "dart-out": 300, "cut-in": 250,
        "intersection": 250, "baseline": 200,
    }
    nus_per_stratum = {"dart-out": 250, "cut-in": 250}

    bdd = select_bdd(args.bdd_samples, args.bdd_labels_dir, bdd_per_stratum, args.seed)
    nus = select_nuscenes(args.nuscenes_meta, nus_per_stratum, args.seed)

    items: list[dict] = []
    counts: Counter = Counter()
    for group in (bdd, nus):
        for st, rows in group.items():
            for r in rows:
                items.append(r)
                counts[(r["id"].split(":")[0], st)] += 1

    print("[manifest] hashing images ...")
    missing = 0
    for it in items:
        img = args.images_root / (
            "bdd" if it["id"].startswith("bdd10k:") else "nuscenes"
        ) / it["image"]
        if img.exists():
            it["sha256"] = sha256_file(img)
            with Image.open(img) as im:
                it["width"], it["height"] = im.size
        else:
            it["sha256"] = None
            missing += 1
    if missing:
        print(f"[manifest] WARNING: {missing} images not yet downloaded (sha256 null)")

    items.sort(key=lambda r: r["id"])
    corpus_hash = hashlib.sha256(
        "\n".join(f"{r['id']}:{r['sha256']}" for r in items if r["sha256"]).encode()
    ).hexdigest()

    manifest = {
        "schema": MANIFEST_SCHEMA,
        "version": "v1",
        "built": "2026-08-22",
        "seed": args.seed,
        "sources": {
            "bdd10k": {
                "name": "BDD100K detection 10k split",
                "license": "BDD100K License (non-commercial research/eval use)",
                "images": "public mirror (HuggingFace datasets dgural/bdd100k, filenames identical to the det-10k release)",
                "labels": "official bdd100k_labels release (weather/scene/timeofday attributes joined by filename)",
            },
            "nuscenes-camfront": {
                "name": "nuScenes v1.0-trainval CAM_FRONT keyframes",
                "license": "CC BY-NC-SA 4.0 (eval use permitted)",
                "labels": "official v1.0-trainval sample annotations projected to the ego frame at build time",
            },
        },
        "strataCounts": {f"{src}:{st}": n for (src, st), n in sorted(counts.items())},
        "corpusHash": corpus_hash,
        "items": items,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(manifest, indent=1))
    print(f"[manifest] wrote {args.out} items={len(items)} corpusHash={corpusHash_display(manifest)}")


def corpusHash_display(manifest: dict) -> str:
    return manifest["corpusHash"][:16] + "..."


if __name__ == "__main__":
    main()
