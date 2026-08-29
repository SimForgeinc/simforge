"""Frozen-perception auto-reject auditor (plan WS3 item 2 / W0 audit hardening).

Compares frozen-detector detections on translated frames against engine ground
truth boxes projected into the same camera, and REJECTS a translated clip when
safety-relevant actors are hallucinated or deleted beyond thresholds.

Inputs are the cached artifacts of the W0 audit corpus:
  --gt-boxes-dir   projected GT boxes per clip  (~/w0-audit/gt_boxes/<set>/<clip>.json)
  --dets-dir       frozen detector output per clip (~/w0-audit/det/trans_<set>_<clip>.json)
Both formats are read-only; the auditor re-implements matching independently.

Decision rule per clip (defaults):
  reject if any of
    - near_deletion_rate > 0.30   (GT actor within NEAR_M unmatched by any detection)
    - frames_with_hallucination_fraction > 0.25
    - supported_detection_fraction < 0.10  (catastrophic rebind: detections
      overwhelmingly unsupported by engine geometry)

Outputs: JSON report + markdown summary; aggregate rejection rate.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os


SAFETY_KINDS = {"car", "truck", "bus", "pedestrian", "bicycle", "motorcycle", "rider"}


def iou(a, b) -> float:
    ax0, ay0, ax1, ay1 = a[:4]
    bx0, by0, bx1, by1 = b[:4]
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    iw, ih = max(0.0, ix1 - ix0), max(0.0, iy1 - iy0)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax1 - ax0) * max(0.0, ay1 - ay0)
    area_b = max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
    union = area_a + area_b - inter
    return inter / union if union > 0 else 0.0


def box_area(b) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def audit_clip(gt_frames: list[dict], det_frames: dict, cfg: dict, clip: str = "") -> dict:
    """gt_frames: list of {frame, boxes:[...]}; det_frames: key-> {dets:[...]}
    where key is '<clip>/<NNNNN>.png' or bare '<NNNNN>.png'."""
    total_gt = deleted_gt = deleted_gt_near = total_near = 0
    total_det_hi = halluc_det = 0
    supported = matched_dets = 0
    frames_with_halluc = frames_with_del = n_frames = 0

    for fr in gt_frames:
        fidx = fr["frame"]
        prefix = f"{clip}/" if clip else ""
        fname = f"{prefix}{fidx:05d}.png"
        hit = det_frames.get(fname) or det_frames.get(f"{fidx:05d}.png") or {"dets": []}
        dets = hit.get("dets", []) if isinstance(hit, dict) else list(hit)
        gt_boxes = [
            b for b in fr.get("boxes", [])
            if b.get("in_frame") and b.get("visible")
        ]
        near_boxes = [b for b in gt_boxes if b.get("dist_m", 1e9) <= cfg.near_m]
        dets_hi = [d for d in dets if d["conf"] >= cfg.halluc_conf_min]
        total_gt += len(gt_boxes)
        total_near += len(near_boxes)
        total_det_hi += len(dets_hi)

        # greedy match: GT <-> detection, same kind, IoU desc
        pairs = []
        for gi, g in enumerate(gt_boxes):
            for di, d in enumerate(dets):
                if d["cls"] != g["kind"]:
                    continue
                ov = iou(g["bbox_xyxy"], d["xyxy"])
                if ov >= cfg.iou_tau:
                    pairs.append((ov, gi, di))
        pairs.sort(reverse=True)
        used_g, used_d = set(), set()
        for ov, gi, di in pairs:
            if gi in used_g or di in used_d:
                continue
            used_g.add(gi); used_d.add(di)
        matched_dets += len(used_d)

        frame_deleted = False
        for gi, g in enumerate(gt_boxes):
            if gi not in used_g:
                deleted_gt += 1
                frame_deleted = True
                if g.get("dist_m", 1e9) <= cfg.near_m:
                    deleted_gt_near += 1

        frame_halluc = False
        for di, d in enumerate(dets_hi):
            support = any(
                iou(d["xyxy"], g["bbox_xyxy"]) >= cfg.halluc_iou_support
                for g in gt_boxes
            )
            if support:
                supported += 1
            elif box_area(d["xyxy"]) >= cfg.min_halluc_area_px2:
                halluc_det += 1
                frame_halluc = True

        n_frames += 1
        frames_with_halluc += int(frame_halluc)
        frames_with_del += int(frame_deleted)

    near_deletion_rate = deleted_gt_near / total_near if total_near else 0.0
    deletion_rate = deleted_gt / total_gt if total_gt else 0.0
    halluc_frame_frac = frames_with_halluc / n_frames if n_frames else 0.0
    # supported fraction over high-conf dets; guard against zero-detection clips
    sup_frac = supported / total_det_hi if total_det_hi else None

    reasons = []
    if total_near and near_deletion_rate > cfg.max_near_deletion_rate:
        reasons.append(f"near_deletion_rate={near_deletion_rate:.3f}>{cfg.max_near_deletion_rate}")
    if halluc_frame_frac > cfg.max_halluc_frame_frac:
        reasons.append(f"halluc_frame_frac={halluc_frame_frac:.3f}>{cfg.max_halluc_frame_frac}")
    if sup_frac is not None and sup_frac < cfg.min_supported_fraction:
        reasons.append(f"supported_det_fraction={sup_frac:.3f}<{cfg.min_supported_fraction} (rebind)")

    return {
        "frames": n_frames,
        "total_gt": total_gt,
        "deleted_gt": deleted_gt,
        "total_near": total_near,
        "deleted_gt_near": deleted_gt_near,
        "deletion_rate": round(deletion_rate, 4),
        "near_deletion_rate": round(near_deletion_rate, 4),
        "high_conf_detections": total_det_hi,
        "supported_detections": supported,
        "hallucinated_detections": halluc_det,
        "hallucination_frame_fraction": round(halluc_frame_frac, 4),
        "supported_detection_fraction": round(sup_frac, 4) if sup_frac is not None else None,
        "reject": bool(reasons),
        "reasons": reasons,
    }


DEFAULTS = dict(
    iou_tau=0.25,
    near_m=60.0,
    min_gt_area_px2=60.0,
    halluc_conf_min=0.5,
    halluc_iou_support=0.10,
    min_halluc_area_px2=200.0,
    max_near_deletion_rate=0.30,
    max_halluc_frame_frac=0.25,
    min_supported_fraction=0.10,
)


class Cfg:
    def __init__(self, overrides: dict | None = None):
        d = dict(DEFAULTS)
        if overrides:
            d.update(overrides)
        for k, v in d.items():
            setattr(self, k, v)


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--gt-boxes-dir", required=True,
                   help="dir with <clip>.json projected GT boxes")
    p.add_argument("--dets-dir", required=True,
                   help="dir with trans[_pov]_<clip>.json frozen-detector dumps")
    p.add_argument("--set-tag", default="pov",
                   help="det filename tag between 'trans' and clip name ('', '_pov')")
    p.add_argument("--out", required=True)
    p.add_argument("--detector-meta", default=None,
                   help="path to a det json to copy detector provenance from")
    args = p.parse_args(argv)

    cfg = Cfg()
    suffix = f"trans{args.set_tag}_"
    report = {
        "schema": "simforge-oss.bridge-auditor.v1",
        "frozen_detector": {},
        "thresholds": DEFAULTS,
        "clips": {},
    }
    if args.detector_meta:
        with open(args.detector_meta) as f:
            m = json.load(f)
        report["frozen_detector"] = {
            "name": m.get("detector"), "classes": m.get("classes"), "conf_floor": m.get("conf"),
        }

    clips = sorted(
        f[:-5] for f in os.listdir(args.gt_boxes_dir)
        if f.endswith(".json") and not fnmatch.fnmatch(f, "_*")
    )
    n_reject = 0
    for clip in clips:
        det_path = os.path.join(args.dets_dir, f"{suffix}{clip}.json")
        if not os.path.isfile(det_path):
            print("missing detections for", clip, "- skipping", flush=True)
            continue
        with open(os.path.join(args.gt_boxes_dir, f"{clip}.json")) as f:
            gt = json.load(f)
        with open(det_path) as f:
            det = json.load(f)
        det_by_key = {}
        for d in det["detections"]:
            key = f"{d['clip']}/{d['file']}" if "clip" in d else d["file"]
            det_by_key[key] = d
        res = audit_clip(gt["frames"], det_by_key, cfg, clip=clip)
        report["clips"][clip] = res
        n_reject += int(res["reject"])
        status = "REJECT" if res["reject"] else "accept"
        print(f"{status:6s} {clip}: del_near={res['near_deletion_rate']:.3f} "
              f"del={res['deletion_rate']:.3f} halluc_ff={res['hallucination_frame_fraction']:.3f} "
              f"sup={res['supported_detection_fraction']} {res['reasons']}", flush=True)

    audited = len(report["clips"])
    report["aggregate"] = {
        "clips_audited": audited,
        "clips_rejected": n_reject,
        "rejection_rate": round(n_reject / audited, 4) if audited else None,
        "gate_max_rejection_rate": 0.20,
        "gate_passed": bool(audited and n_reject / audited <= 0.20),
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(report, f, indent=2)

    md_path = os.path.splitext(args.out)[0] + ".md"
    agg = report["aggregate"]
    lines = [
        "# Bridge auditor — auto-reject report",
        "",
        f"- Detector: `{report['frozen_detector'].get('name')}` (frozen, conf≥{report['frozen_detector'].get('conf_floor')})",
        f"- Clips audited: **{agg['clips_audited']}**, rejected: **{agg['clips_rejected']}** "
        f"(rejection rate **{agg['rejection_rate']}**)",
        f"- Gate (<20% rejection): {'PASS' if agg['gate_passed'] else '**FAIL**'}",
        "",
        "| clip | verdict | near-del | del | halluc-frame-frac | supported-det |",
        "|---|---|---|---|---|---|",
    ]
    for clip, r in report["clips"].items():
        lines.append(
            f"| {clip} | {'REJECT' if r['reject'] else 'accept'} | {r['near_deletion_rate']} "
            f"| {r['deletion_rate']} | {r['hallucination_frame_fraction']} "
            f"| {r['supported_detection_fraction']} |"
        )
    with open(md_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    print("report:", args.out, "summary:", md_path, flush=True)


if __name__ == "__main__":
    main()
