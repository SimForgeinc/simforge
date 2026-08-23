#!/usr/bin/env python
"""Run the WS3 auditor over yolo11s detection dumps for one or more sets.

Produces reports/auditor-yolo11s-<set>.json with per-clip verdicts and the
aggregate rejection rate against the <20% gate.

  python scripts/run_auditor_yolo11s.py --det-dir ~/ws3-bridge/det \
      --sets yolo11s-h3-pov \
      --gt-dir ~/w0-audit/gt_boxes/pov --out-dir ~/ws3-bridge/reports
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
from bridge_student.auditor import DEFAULTS, Cfg, audit_clip  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--det-dir", required=True)
    ap.add_argument("--gt-dir", required=True)
    ap.add_argument("--sets", nargs="+", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    cfg = Cfg()
    os.makedirs(args.out_dir, exist_ok=True)
    gt_files = sorted(f for f in os.listdir(args.gt_dir) if f.endswith(".json"))

    for name in args.sets:
        det = json.load(open(os.path.join(args.det_dir, f"{name}.json")))
        by = {}
        for d in det["detections"]:
            by[f"{d['clip']}/{d['file']}"] = d
        res, nrej = {}, 0
        for f in gt_files:
            clip = f[:-5]
            g = json.load(open(os.path.join(args.gt_dir, f)))
            r = audit_clip(g["frames"], by, cfg, clip=clip)
            res[clip] = r
            nrej += int(r["reject"])
            print(("REJECT" if r["reject"] else "accept"), clip,
                  "del_near=%.2f del=%.2f hall_ff=%.2f sup=%s" % (
                      r["near_deletion_rate"], r["deletion_rate"],
                      r["hallucination_frame_fraction"],
                      r["supported_detection_fraction"]),
                  r["reasons"], flush=True)
        n = len(res)
        report = {
            "schema": "uniscenarios.bridge-auditor.v1",
            "frozen_detector": {
                "name": det["detector"],
                "weights_sha256": det.get("weights_sha256"),
                "conf": det["conf"], "iou": det["iou"],
                "classes": det["classes"],
            },
            "thresholds": DEFAULTS,
            "clips": res,
            "aggregate": {
                "clips_audited": n,
                "clips_rejected": nrej,
                "rejection_rate": round(nrej / n, 4) if n else None,
                "gate_max_rejection_rate": 0.20,
                "gate_passed": bool(n and nrej / n <= 0.20),
            },
        }
        out = os.path.join(args.out_dir, f"auditor-{name}.json")
        json.dump(report, open(out, "w"), indent=2)
        agg = report["aggregate"]
        print(f"== {name}: rejected {nrej}/{n} -> rate {agg['rejection_rate']} "
              f"gate {'PASS' if agg['gate_passed'] else 'FAIL'}; {out}", flush=True)


if __name__ == "__main__":
    main()
