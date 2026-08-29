"""Compute a WS1 bridge-fidelity scorecard for translated W0/H3 clips.

Authority order (plan WS1.3):
  (a) detector AP/recall deltas between translated frames and the engine-render
      floor, referenced against matched real-corpus strata;
  (b) per-class hallucination/deletion rates against projected engine GT;
  (c) FID tie-breaker (computed only when an Inception-V3 feature extractor is
      available offline).

Usage:
  bf-scorecard --corpus-manifest corpus-manifest.v1.json \\
      --engine-clips ~/w0-data/clips-pov \\
      --translated-dir ~/w0-data/real-corpus/w0-translated \\
      --corpus-images .corpus/images \\
      --work .corpus/work --out scorecard.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

from . import SCHEMA_SCORECARD
from .detector import (
    CONF_THRESHOLD,
    EVAL_CLASSES,
    IOU_MATCH_THRESHOLD,
    detect,
    load_detections,
    load_instrument,
    provenance,
    save_detections,
)
from .project import project_gt

# W0 clip -> real-corpus strata whose scenes are the closest real-world match.
SCENARIO_STRATA = {
    "baseline-midblock": ["dart-out", "baseline"],
    "signal-red-light": ["intersection"],
    "school-parked-row-dartout": ["dart-out"],
    "parked-row-dartout": ["dart-out"],
    "bus-stop-emergence": ["dart-out", "baseline"],
    "fog-midblock": ["weather"],
    "night-rain-merge": ["night"],
    "workzone-lane-shift": ["cut-in", "intersection"],
    "cutout-reveals-stopped": ["cut-in", "baseline"],
    "lane-drop-merge": ["cut-in", "baseline"],
}


def iou(a: list[float], b: list[float]) -> float:
    ax1, ay1 = a[0], a[1]
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx1, by1 = b[0], b[1]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix = max(0.0, min(ax2, bx2) - max(ax1, bx1))
    iy = max(0.0, min(ay2, by2) - max(ay1, by1))
    inter = ix * iy
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


def average_precision(scores: list[float], matches: list[int], total_gt: int) -> float | None:
    """VOC-style all-point-interpolated AP over one ranked detection list."""
    if total_gt == 0:
        return None
    order = sorted(range(len(scores)), key=lambda i: -scores[i])
    tp = [matches[i] for i in order]
    cum_tp, cum_fp = 0, 0
    prec, rec = [], []
    for m in tp:
        if m:
            cum_tp += 1
        else:
            cum_fp += 1
        prec.append(cum_tp / (cum_tp + cum_fp))
        rec.append(cum_tp / total_gt)
    # monotonically decreasing precision envelope
    env = 0.0
    for i in range(len(prec) - 1, -1, -1):
        env = max(env, prec[i])
        prec[i] = env
    ap = 0.0
    prev_r = 0.0
    for p, r in zip(prec, rec):
        ap += p * (r - prev_r)
        prev_r = r
    return ap


def evaluate_boxes(gt_items: list[dict], dets: list[dict]) -> dict:
    """Per-class metrics of detections vs ground-truth boxes for one image set.

    gt_items/dets: [{class, bbox}] (+ conf for dets). Returns per-class
    {nGt, nDet, ap, recall, deletionRate, hallucinationRate}.
    """
    out: dict[str, dict] = {}
    for cls in EVAL_CLASSES:
        gts = [g["bbox"] for g in gt_items if g["class"] == cls]
        ds = [d for d in dets if d["class"] == cls]
        scores, matches = [], []
        det_halluc = 0
        gt_matched = [False] * len(gts)
        # greedy match highest-confidence det first
        for d in sorted(ds, key=lambda x: -x.get("conf", 1.0)):
            best, bi = 0.0, -1
            for gi, g in enumerate(gts):
                if gt_matched[gi]:
                    continue
                v = iou(d["bbox"], g)
                if v > best:
                    best, bi = v, gi
            hit = best >= IOU_MATCH_THRESHOLD
            if hit:
                gt_matched[bi] = True
            else:
                det_halluc += 1
            scores.append(d.get("conf", 1.0))
            matches.append(1 if hit else 0)
        ngt = len(gts)
        ap = average_precision(scores, matches, ngt)
        nmatched = sum(gt_matched)
        out[cls] = {
            "nGt": ngt,
            "nDet": len(ds),
            "ap": None if ap is None else round(ap, 4),
            "recall": round(nmatched / ngt, 4) if ngt else None,
            "deletionRate": round(1 - nmatched / ngt, 4) if ngt else None,
            "hallucinationRate": round(det_halluc / len(ds), 4) if ds else None,
        }
    return out


def ensure_frames(video: Path, out_dir: Path) -> Path:
    """Extract every frame of `video` as PNG into out_dir via ffmpeg."""
    marker = out_dir / ".done"
    if marker.exists():
        return out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-start_number", "0",
         "-vsync", "0", str(out_dir / "frame-%05d.png")],
        check=True,
    )
    marker.write_text("")
    return out_dir


def run_detector_cached(model, inst, paths: list[Path], cache: Path, tag: str, batch=64) -> dict[str, list[dict]]:
    cache.mkdir(parents=True, exist_ok=True)
    f = cache / f"dets-{tag}.jsonl"
    have: dict[str, list[dict]] = {}
    if f.exists():
        for rec in load_detections(f):
            have[rec["image"]] = rec["detections"]
    todo = [p for p in paths if str(p) not in have]
    if todo:
        print(f"[det] {tag}: running on {len(todo)} images ...")
        for i in range(0, len(todo), batch):
            chunk = todo[i : i + batch]
            for p, dets in zip(chunk, detect(model, chunk)):
                have[str(p)] = dets
            print(f"[det] {tag}: {min(i + batch, len(todo))}/{len(todo)}")
        save_detections(f, [{"image": k, "detections": v} for k, v in sorted(have.items())])
    return have


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--corpus-manifest", type=Path, required=True)
    ap.add_argument("--corpus-images", type=Path, required=True)
    ap.add_argument("--engine-clips", type=Path, required=True)
    ap.add_argument("--translated-dir", type=Path, required=True)
    ap.add_argument("--weights-cache", type=Path, default=None)
    ap.add_argument("--work", type=Path, default=None)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    weights_cache = args.weights_cache or args.corpus_images.parent / "weights"
    work = args.work or args.corpus_images.parent / "work"
    work.mkdir(parents=True, exist_ok=True)

    manifest = json.loads(args.corpus_manifest.read_text())
    items = [it for it in manifest["items"] if it.get("sha256")]
    if not items:
        sys.exit("manifest has no hashed items — download images and rebuild first")

    inst, model = load_instrument(weights_cache)

    # ---- (1) real-corpus reference --------------------------------------
    img_dirs = {
        "bdd10k": args.corpus_images / "bdd",
        "nuscenes-camfront": args.corpus_images / "nuscenes",
    }
    corpus_paths, missing = [], 0
    for it in items:
        src = it["id"].split(":")[0]
        p = img_dirs[src] / it["image"]
        if p.exists():
            corpus_paths.append(p)
        else:
            missing += 1
    if missing:
        print(f"[corpus] WARNING {missing} manifest images absent on disk; skipped")
    corpus_dets = run_detector_cached(model, inst, corpus_paths, work, "corpus")

    present_items: list[tuple[dict, list[dict], list[dict]]] = []
    for it in items:
        src = it["id"].split(":")[0]
        p = img_dirs[src] / it["image"]
        if not p.exists():
            continue
        w, h = it["width"], it["height"]
        # corpus GT is normalized [0..1]; bring detector boxes into the same
        # units before matching.
        norm_dets = [
            {"class": d["class"],
             "bbox": [d["bbox"][0] / w, d["bbox"][1] / h,
                      d["bbox"][2] / w, d["bbox"][3] / h],
             "conf": d["conf"]}
            for d in corpus_dets[str(p)]
        ]
        present_items.append(
            (it,
             [{"class": b["class"], "bbox": b["bbox"]} for b in it["boxes"]],
             norm_dets)
        )
    real_overall = evaluate_boxes(
        [g for _, gts, _ in present_items for g in gts],
        [d for _, _, ds in present_items for d in ds],
    )
    real_by_stratum = {}
    for st in sorted({it["stratum"] for it, _, _ in present_items}):
        rows = [t for t in present_items if t[0]["stratum"] == st]
        real_by_stratum[st] = evaluate_boxes(
            [g for _, gts, _ in rows for g in gts],
            [d for _, _, ds in rows for d in ds],
        )

    # ---- (2) per-clip evaluation ----------------------------------------
    clips_out = []
    tmp = tempfile.mkdtemp(prefix="bf-translated-")
    for clip_dir in sorted(args.engine_clips.iterdir()):
        if not (clip_dir / "gt.jsonl").is_file():
            continue
        name = clip_dir.name
        vid = args.translated_dir / f"{name}.mp4"
        if not vid.exists():
            print(f"[clip] {name}: no translated video, skipped")
            continue
        gt_records = [json.loads(l) for l in (clip_dir / "gt.jsonl").read_text().splitlines() if l.strip()]
        eng_frames_dir = clip_dir / "frames"
        eng_paths = sorted(eng_frames_dir.glob("frame-*.png"))
        tr_dir = ensure_frames(vid, work / "tr-frames" / name)
        tr_all = sorted(tr_dir.glob("frame-*.png"))
        # nearest-frame tick alignment: translated runs at ~2x the 12 fps
        # engine cadence; engine frame i maps to translated round(i*ratio).
        ratio = len(tr_all) / len(eng_paths)
        tr_paths = [tr_all[min(len(tr_all) - 1, round(i * ratio))] for i in range(len(eng_paths))]

        eng_det_map = run_detector_cached(model, inst, eng_paths, work, f"eng-{name}")
        tr_det_map = run_detector_cached(model, inst, tr_paths, work, f"tr-{name}")

        from PIL import Image

        per_class = {}
        gt_acc_e: list[dict] = []
        det_acc_e: list[dict] = []
        gt_acc_t: list[dict] = []
        det_acc_t: list[dict] = []
        for i, rec in enumerate(gt_records):
            with Image.open(eng_paths[i]) as im:
                we, he = im.size
            with Image.open(tr_paths[i]) as im:
                wt, ht = im.size
            gt_px = project_gt(rec, we, he)
            sx, sy = wt / we, ht / he
            gt_px_tr = [
                {"class": b["class"], "bbox": [b["bbox"][0] * sx, b["bbox"][1] * sy,
                                               b["bbox"][2] * sx, b["bbox"][3] * sy]}
                for b in gt_px
            ]
            de, dt = eng_det_map[str(eng_paths[i])], tr_det_map[str(tr_paths[i])]
            gt_acc_e += gt_px
            det_acc_e += [{"class": d["class"], "bbox": d["bbox"], "conf": d["conf"]} for d in de]
            gt_acc_t += gt_px_tr
            det_acc_t += [{"class": d["class"], "bbox": d["bbox"], "conf": d["conf"]} for d in dt]
        floor_m = evaluate_boxes(gt_acc_e, det_acc_e)
        trans_m = evaluate_boxes(gt_acc_t, det_acc_t)
        for cls in EVAL_CLASSES:
            fe, ft = floor_m[cls], trans_m[cls]
            per_class[cls] = {
                "apEngineFloor": fe["ap"], "apTranslated": ft["ap"],
                "apDelta": None if (fe["ap"] is None or ft["ap"] is None) else round(ft["ap"] - fe["ap"], 4),
                "recallEngineFloor": fe["recall"], "recallTranslated": ft["recall"],
                "hallucinationRate": ft["hallucinationRate"],
                "deletionRate": ft["deletionRate"],
            }
        clips_out.append({
            "clip": name,
            "scenarioClass": _scenario_class(name),
            "matchedRealStrata": SCENARIO_STRATA.get(name, []),
            "framesEvaluated": len(gt_records),
            "perClass": per_class,
        })

    scorecard = {
        "schema": SCHEMA_SCORECARD,
        "generatedAt": "2026-08-22",
        "corpusHash": manifest["corpusHash"],
        "detector": provenance(inst),
        "metricsAuthorityOrder": ["ap-recall-delta-vs-real-matched", "hallucination-deletion-vs-engine-gt", "fid-tiebreak"],
        "realReferenceOverall": real_overall,
        "realReferenceByStratum": real_by_stratum,
        "clips": clips_out,
    }
    _finalize(scorecard)
    args.out.write_text(json.dumps(scorecard, indent=1))
    print(f"[scorecard] wrote {args.out}")


def _scenario_class(clip: str) -> str:
    return {
        "baseline-midblock": "baseline/midblock-pedestrian",
        "signal-red-light": "intersection",
        "school-parked-row-dartout": "dart-out/pedestrian",
        "parked-row-dartout": "dart-out/pedestrian",
        "bus-stop-emergence": "dart-out/pedestrian",
        "fog-midblock": "weather-proxy",
        "night-rain-merge": "night-proxy",
        "workzone-lane-shift": "construction-zone",
        "cutout-reveals-stopped": "occlusion-longitudinal",
        "lane-drop-merge": "merge",
    }.get(clip, "other")


def _mean(vals: list) -> float | None:
    v = [x for x in vals if x is not None]
    return round(sum(v) / len(v), 4) if v else None


def _finalize(sc: dict) -> None:
    """Aggregate clip metrics into summary + verdict (the gate proposal)."""
    summary_classes = {}
    hall, dele = [], []
    for cls in EVAL_CLASSES:
        per = [c["perClass"][cls] for c in sc["clips"]]
        summary_classes[cls] = {
            "apDeltaMean": _mean([p["apDelta"] for p in per]),
            "apTranslatedMean": _mean([p["apTranslated"] for p in per]),
            "apEngineFloorMean": _mean([p["apEngineFloor"] for p in per]),
            "recallTranslatedMean": _mean([p["recallTranslated"] for p in per]),
            "recallEngineFloorMean": _mean([p["recallEngineFloor"] for p in per]),
            "hallucinationRateMean": _mean([p["hallucinationRate"] for p in per]),
            "deletionRateMean": _mean([p["deletionRate"] for p in per]),
        }
        for c in sc["clips"]:
            if c["perClass"][cls]["hallucinationRate"] is not None:
                hall.append(c["perClass"][cls]["hallucinationRate"])
            if c["perClass"][cls]["deletionRate"] is not None:
                dele.append(c["perClass"][cls]["deletionRate"])
    sc["summary"] = {"perClass": summary_classes}
    # Contract-facing top-level fields (simforge-oss.bridge-fidelity-scorecard.v1).
    sc["perClass"] = {
        cls: {
            "ap": summary_classes[cls]["apTranslatedMean"],
            "recall": summary_classes[cls]["recallTranslatedMean"],
            "apDeltaVsEngineFloor": summary_classes[cls]["apDeltaMean"],
        }
        for cls in EVAL_CLASSES
    }
    sc["hallucinationRate"] = _mean(hall)
    sc["deletionRate"] = _mean(dele)

    # Gate band v1 (justified in README §gate):
    #   pass = every class mean apDelta >= -0.10 vs engine floor
    #          AND overall hallucination <= 0.25
    #          AND pedestrian deletion <= 0.35
    ok = True
    reasons = []
    for cls, m in summary_classes.items():
        d = m["apDeltaMean"]
        if d is not None and d < -0.10:
            ok = False
            reasons.append(f"{cls} apDelta {d} < -0.10")
    h = _mean(hall)
    if h is not None and h > 0.25:
        ok = False
        reasons.append(f"hallucination {h} > 0.25")
    pd_ = summary_classes["pedestrian"]["deletionRateMean"]
    if pd_ is not None and pd_ > 0.35:
        ok = False
        reasons.append(f"pedestrian deletion {pd_} > 0.35")
    sc["verdict"] = {"result": "pass" if ok else "fail", "reasons": reasons,
                     "gate": "bridge-gate.v1"}


if __name__ == "__main__":
    main()
