#!/usr/bin/env python3
"""Qualification and reviewer-calibration workflow for the production restart.

    qualify.py breadth        refresh the 67-case breadth config from the campaign
    qualify.py gold-template  seal a hash-bound gold manifest for humans to label
    qualify.py label          validate human label patches and reseal the gold manifest
    qualify.py calibrate      confusion matrix, FPR/FNR, field flip rate, realism SD
    qualify.py evaluate       machine exit evaluator over a qualification run

The human-review commands bind `config/showcase-review-contract.json` and refuse
evidence from a superseded contract.  `evaluate` reads each attempt the way the
pipeline decides it: `75-product.json` is the deliverable decision,
`62-semantic2d.json` is the semantic source evidence it quotes, and
`95-benchmark.json` supplies the stage and funnel facts.

Exit codes follow the repository convention: 0 qualified, 1 fail-closed refusal
or operational error, 2 the run completed but did not meet the exit criteria.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
import qualification as q  # noqa: E402



def _relative(path, root):
    return str(Path(path).resolve().relative_to(Path(root).resolve())).replace(os.sep, "/")


def _artifact(path, root):
    return {"file": _relative(path, root), "sha256": q.sha256_file(path)}


def _emit(value):
    print(json.dumps(value, indent=2, sort_keys=True))


# ------------------------------------------------------------------- breadth

def breadth(args):
    """Project the campaign case list onto a breadth config with stage outcomes."""
    source = Path(args.source)
    campaign = q.load_json(source)
    cases = campaign.get("cases")
    if not isinstance(cases, list) or not cases:
        raise q.QualificationError(f"{source} carries no cases")
    config = {
        "schema": q.BREADTH_SCHEMA,
        "id": args.id,
        "source": _relative(source, ROOT),
        "sourceSha256": q.sha256_file(source),
        "attemptsPerCase": args.attempts,
        "caseCount": len(cases),
        "stages": list(q.STAGES),
        "requiredStages": list(q.REQUIRED_STAGES),
        "stageOutcomeVocabulary": list(q.STAGE_OUTCOMES),
        "cases": [{
            "id": case["id"],
            "title": case["title"],
            "priority": case.get("priority", 0),
            "stageOutcomes": {stage: "pending" for stage in q.STAGES},
        } for case in cases],
    }
    q.dump_json(args.out, config)
    loaded = q.load_breadth(args.out)
    _emit({"breadth": str(args.out), "caseCount": loaded["caseCount"],
           "requiredStages": loaded["requiredStages"]})


# ------------------------------------------------------------- gold manifest

def _discover_evidence(root, evidence_root):
    """Pair every committed 2D render with the contract cell it was rendered from."""
    found = []
    for gallery in sorted(Path(evidence_root).glob("*/90-gallery.json")):
        card = q.load_json(gallery)
        seed = gallery.parent
        cell_id = card.get("cellId")
        if not isinstance(cell_id, str) or not cell_id:
            raise q.QualificationError(f"{gallery} has no cellId")
        cell = seed / "40-cells" / cell_id
        render = seed / "60-render2d" / cell_id
        video = render / "rollout.mp4"
        instance = cell / "instance.json"
        trace = cell / "trace.json.gz"
        frames = sorted(render.glob("frames/frame-*.png"))
        missing = [str(path) for path in (video, instance, trace) if not path.is_file()]
        if missing or not frames:
            raise q.QualificationError(f"{seed}: incomplete evidence ({', '.join(missing) or 'no frames'})")
        request = card.get("brief")
        if not isinstance(request, str) or not request.strip():
            raise q.QualificationError(f"{gallery} has no brief to reproduce the review request")
        found.append({
            "evidenceId": cell_id,
            "caseId": None,
            "requestText": request.strip(),
            "video": _artifact(video, root),
            "frames": [_artifact(frame, root) for frame in frames],
            "instance": _artifact(instance, root),
            "trace": _artifact(trace, root),
            "label": None,
        })
    if not found:
        raise q.QualificationError(f"no committed showcase evidence under {evidence_root}")
    return sorted(found, key=lambda entry: entry["evidenceId"])


def gold_template(args):
    """Seal a manifest over real bytes.  Existing human labels are never lost."""
    out = Path(args.out)
    entries = _discover_evidence(args.root, args.evidence)
    if out.is_file():
        carried = q.carried_gold_labels(out)
        for entry in entries:
            previous = carried.get(entry["video"]["sha256"])
            if previous is not None and previous["label"] is not None:
                entry["label"] = previous["label"]
                entry["caseId"] = previous["caseId"]
        discoverable = {item["video"]["sha256"] for item in entries}
        dropped = sorted(digest for digest, previous in carried.items()
                         if previous["label"] is not None and digest not in discoverable)
        if dropped:
            raise q.QualificationError(
                "refusing to drop labelled gold evidence that is no longer discoverable: "
                + ", ".join(item[:12] for item in dropped))
    manifest = {
        "schema": q.GOLD_SCHEMA,
        "id": args.id,
        "labelProvenance": "human",
        "labelInstructions": (
            "Human reviewers only. Watch the exact video referenced by its sha256, then set "
            "semanticAccepted (the scene implements the requested mechanism, actors, and event order) "
            "and presentationAccepted (grounded, plausible, defect-free render). Use defectCodes from "
            "the review contract's vocabulary below and leave unsupportedReason null unless the stack "
            "cannot represent the request at all. Any model-produced field makes the entry unusable "
            "for calibration."),
        "reviewContract": q.gold_contract_block(),
        "entries": entries,
    }
    manifest["manifestSha256"] = q.gold_seal(manifest)
    q.dump_json(out, manifest)
    loaded = q.load_gold(out, args.root)
    _emit({
        "gold": str(out),
        "manifestSha256": loaded["manifestSha256"],
        "entries": len(loaded["entries"]),
        "labelled": sum(1 for entry in loaded["entries"] if entry["label"] is not None),
        "eligible": len(q.eligible_gold(loaded)),
    })

def label(args):
    """Apply separately authored human labels, then reseal the immutable manifest."""
    manifest = q.load_gold(args.gold, args.root)
    document = q.load_json(args.labels)
    patches = document.get("labels") if isinstance(document, dict) else document
    if not isinstance(patches, list) or not patches:
        raise q.QualificationError("label patch must be a non-empty array or an object with labels")
    entries = {entry["evidenceId"]: entry for entry in manifest["entries"]}
    seen = set()
    for index, patch in enumerate(patches):
        if not isinstance(patch, dict):
            raise q.QualificationError(f"labels[{index}] must be an object")
        unknown = sorted(set(patch) - {"evidenceId", "label"})
        if unknown:
            raise q.QualificationError(
                f"labels[{index}] carries unexpected fields: {', '.join(unknown)}")
        evidence_id = patch.get("evidenceId")
        if evidence_id in seen:
            raise q.QualificationError(f"label patch duplicates evidenceId {evidence_id!r}")
        if evidence_id not in entries:
            raise q.QualificationError(f"label patch names unknown evidenceId {evidence_id!r}")
        seen.add(evidence_id)
        entries[evidence_id]["label"] = q.assert_human_label(
            patch.get("label"), f"labels[{index}].label")
    manifest["entries"] = list(entries.values())
    manifest["manifestSha256"] = q.gold_seal(manifest)
    q.dump_json(args.gold, manifest)
    loaded = q.load_gold(args.gold, args.root)
    _emit({
        "gold": str(args.gold),
        "manifestSha256": loaded["manifestSha256"],
        "labelled": sum(1 for entry in loaded["entries"] if entry["label"] is not None),
        "eligible": len(q.eligible_gold(loaded)),
    })






def _read_reviews(path, gold_sha256):
    records = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get("goldSha256") != gold_sha256:
            raise q.QualificationError(f"{path} mixes reviews from a different gold manifest")
        records.append(record)
    if not records:
        raise q.QualificationError(f"{path} contains no reviews")
    return records


def calibrate(args):
    manifest = q.load_gold(args.gold, args.root)
    reviews = _read_reviews(args.reviews, manifest["manifestSha256"])
    report = q.build_calibration(manifest, reviews, args.repetitions)
    q.dump_json(args.out, report)
    _emit({key: value for key, value in report.items() if key != "realism"}
          | {"realism": {key: value for key, value in report["realism"].items() if key != "byEvidence"}})


# ------------------------------------------------------------ exit evaluation

def _attempt_evidence(attempt, data_root):
    """The two artifacts one attempt is classified from, or None where absent.

    `75-product.json` is the deliverable decision and `95-benchmark.json` is the
    attempt record.  The product decision quotes `62-semantic2d.json` as its
    semantic source evidence, so qualification does not load that source separately.
    A job that crashed before writing either artifact is honestly missing it rather
    than defaulted.
    """
    job_id = attempt.get("jobId")
    if not isinstance(job_id, str) or not job_id:
        return {}
    job_dir = Path(data_root) / "jobs" / job_id
    names = {"product": "75-product.json", "record": "95-benchmark.json"}
    return {key: q.load_json(job_dir / name) for key, name in names.items()
            if (job_dir / name).is_file()}


def _case_attempts(config, state, data_root):
    """Collect one classified outcome per attempt, keyed by qualification case."""
    by_id = {case.get("id"): case for case in state.get("cases", []) if isinstance(case, dict)}
    collected = {}
    for case in config["cases"]:
        run_case = by_id.get(case["id"]) or by_id.get(case["breadthCaseId"])
        if run_case is None:
            raise q.QualificationError(
                f"the run has no case named {case['id']} or {case['breadthCaseId']}")
        outcomes = []
        for attempt in sorted(run_case.get("attempts", []), key=lambda item: item.get("number", 0)):
            outcomes.append(q.attempt_outcome(attempt, **_attempt_evidence(attempt, data_root)))
        collected[case["id"]] = outcomes
    return collected


def evaluate(args):
    breadth_config = q.load_breadth(args.breadth)
    config = q.load_qualification(args.config, breadth_config)
    manifest = q.load_gold(args.gold, args.root)
    calibration = q.load_json(args.calibration)
    if calibration.get("goldSha256") != manifest["manifestSha256"]:
        raise q.QualificationError("the calibration report was produced against a different gold manifest")
    state = q.load_json(args.state)
    verdict = q.evaluate_exit(config, calibration, _case_attempts(config, state, args.data))
    if args.out:
        q.dump_json(args.out, verdict)
    _emit({key: value for key, value in verdict.items() if key != "cases"}
          | {"cases": [{key: value for key, value in case.items() if key != "outcomes"}
                       for case in verdict["cases"]]})
    return verdict["exitCode"]


# ------------------------------------------------------------------------ cli

def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--root", default=str(ROOT), help="repository root used to resolve evidence")
    sub = parser.add_subparsers(dest="command", required=True)

    cmd = sub.add_parser("breadth")
    cmd.add_argument("--source", default=str(ROOT / "apps/showcase/campaigns/edge-cases.json"))
    cmd.add_argument("--out", default=str(ROOT / "apps/showcase/campaigns/breadth.json"))
    cmd.add_argument("--id", default="breadth-67")
    cmd.add_argument("--attempts", type=int, default=10)
    cmd.set_defaults(func=breadth)

    cmd = sub.add_parser("gold-template")
    cmd.add_argument("--evidence", default=str(ROOT / "showcase-data/gallery-seed"))
    cmd.add_argument("--out", default=str(ROOT / "apps/showcase/campaigns/reviewer-gold.json"))
    cmd.add_argument("--id", default="reviewer-gold-v1")
    cmd.set_defaults(func=gold_template)

    cmd = sub.add_parser("label")
    cmd.add_argument("--gold", default=str(ROOT / "apps/showcase/campaigns/reviewer-gold.json"))
    cmd.add_argument("--labels", required=True,
                     help="human-authored JSON patches; model-produced labels are refused")
    cmd.set_defaults(func=label)


    cmd = sub.add_parser("calibrate")
    cmd.add_argument("--gold", default=str(ROOT / "apps/showcase/campaigns/reviewer-gold.json"))
    cmd.add_argument("--reviews", required=True)
    cmd.add_argument("--out", required=True)
    cmd.add_argument("--repetitions", type=int, default=3)
    cmd.set_defaults(func=calibrate)

    cmd = sub.add_parser("evaluate")
    cmd.add_argument("--config", default=str(ROOT / "apps/showcase/campaigns/qualification.json"))
    cmd.add_argument("--breadth", default=str(ROOT / "apps/showcase/campaigns/breadth.json"))
    cmd.add_argument("--gold", default=str(ROOT / "apps/showcase/campaigns/reviewer-gold.json"))
    cmd.add_argument("--calibration", required=True)
    cmd.add_argument("--state", required=True)
    cmd.add_argument("--data", default=str(ROOT / "showcase-data"))
    cmd.add_argument("--out")
    cmd.set_defaults(func=evaluate)

    args = parser.parse_args()
    try:
        return args.func(args) or 0
    except q.QualificationError as error:
        print(f"fail-closed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
