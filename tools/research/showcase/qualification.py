#!/usr/bin/env python3
"""Qualification and reviewer calibration for the showcase production restart.

`review_contract.py` is the only acceptance authority this workflow has.  It owns
the review version, the frozen contract hash, both predicates, and the defect
vocabulary, so nothing here re-derives an acceptance formula or a taxonomy.  What
this module adds is the evidence discipline around that contract:

    semanticAccepted      the visible scene implements the requested mechanism
    presentationAccepted  the footage is usable as delivered
    defectCodes           sorted subset of the contract's defect vocabulary
    unsupportedReason     non-null only when the evidence cannot be attributed

Gold decisions are immutable human labels.  The manifest is sealed with a digest
over its contract binding and its entries, every entry is bound to the sha256 of
the bytes a reviewer actually saw, and any label carrying model provenance is
rejected outright.  Every loader fails closed: a superseded contract, a hash
mismatch, a missing evidence file, or an under-labelled manifest raises instead
of degrading into a soft verdict.

Nothing in this module performs network, simulator, or renderer work.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
import benchmark_report as bench  # noqa: E402
import review_contract as contract  # noqa: E402


GOLD_SCHEMA = "uniscenarios.showcase-reviewer-gold.v1"
CALIBRATION_SCHEMA = "uniscenarios.showcase-reviewer-calibration.v1"
QUALIFICATION_SCHEMA = "uniscenarios.showcase-qualification.v1"
BREADTH_SCHEMA = "uniscenarios.showcase-breadth.v1"
VERDICT_SCHEMA = "uniscenarios.showcase-qualification-verdict.v1"
# Artifacts the integrated pipeline writes and this workflow reads as evidence:
# the deliverable product decision and the per-attempt benchmark record.
PRODUCT_SCHEMA = "uniscenarios.showcase-product-decision.v1"
ATTEMPT_RECORD_SCHEMA = "showcase-benchmark-attempt/v1"

# Every acceptance term below is the contract's, never this module's.
REVIEW_VERSION = contract.REVIEW_VERSION
CONTRACT_VERSION = contract.CONTRACT_VERSION
CONTRACT_SHA256 = contract.CONTRACT_SHA256
REALISM_MIN = contract.REALISM_MIN
CONFIDENCE_MIN = contract.CONFIDENCE_MIN
DEFECT_CODES = tuple(contract.CODES)

DECISION_FIELDS = ("semanticAccepted", "presentationAccepted", "defectCodes", "unsupportedReason")
BOOLEAN_DECISION_FIELDS = ("semanticAccepted", "presentationAccepted")

# Keys and labeller names that only a model-produced review can carry.  Their
# presence proves the label was not hand-entered, so calibration must refuse it.
MODEL_PROVENANCE_KEYS = (
    "acceptance",
    "confidence",
    "contract",
    "effort",
    "explanation",
    "frameBasis",
    "framesUsed",
    "latencyS",
    "model",
    "rawResponseSha256",
    "tier",
    "tokens",
    "version",
    "visionAsserted",
)
MODEL_LABELLER = re.compile(
    r"(?:^|[^a-z0-9])(?:gpt|claude|gemini|llama|o[0-9]|sol|luna|terra|vista|judge|model|llm|agent|bot)(?:[^a-z0-9]|$)",
    re.IGNORECASE,
)

# The integrated pipeline's artifact stages, in numeric order.  Every name is the
# artifact a runner can observe: `apps/showcase/server/index.mjs` resolves saved
# stages from exactly these files, and `95-benchmark` is the attempt record that
# is rewritten after every stage.
STAGES = (
    "00-brief",
    "10-route",
    "15-precheck",
    "20-author",
    "30-sites",
    "40-cells",
    "50-gate",
    "55-eligibility",
    "60-render2d",
    "62-semantic2d",
    "62-mutation-01",
    "62-mutation-02",
    "62-fallback-author",
    "65-render3d",
    "70-judge",
    "75-product",
    "80-presentation-retry",
    "80-reauthor-01",
    "90-gallery",
    "95-benchmark",
)
# Repair branches are bounded and only a rejected attempt reaches any of them,
# so none may be required of a healthy attempt: the two 62-mutation rounds plus
# the action-capped fallback author repair semantics before 3D, and the two
# 80-* branches repair presentation or (ungated) semantics after 3D.
OPTIONAL_STAGES = ("62-mutation-01", "62-mutation-02", "62-fallback-author",
                   "80-presentation-retry", "80-reauthor-01")
REQUIRED_STAGES = tuple(stage for stage in STAGES if stage not in OPTIONAL_STAGES)
# The attempt record's stage ledger names the reauthor branch by the control it
# ran; the branch's artifacts live in the numbered directory the ledger above
# names, so both spellings describe the same stage.
STAGE_ALIASES = {"80-reauthor": "80-reauthor-01"}

# Stage outcomes a runner may record.  `pending` and `running` are the lifecycle
# states the pipeline emits as stage events; `reused`, `complete`, `skipped`, and
# `error` are the statuses its stage ledger writes into the attempt record; and
# `failed` is what the reauthor branch reports when a promoted repair does not
# complete.
STAGE_OUTCOMES = ("pending", "running", "reused", "complete", "skipped", "failed", "error")

# Funnel stage ids in order, taken from the benchmark reader so a qualification
# verdict names the same stages the attempt record it read does.
FUNNEL_STAGES = tuple(stage for stage, _ in bench.FUNNEL_STAGES)

ATTEMPT_OUTCOMES = ("semantic-accepted", "semantic-rejected", "unsupported", "operational-failure")

SHA256 = re.compile(r"^[a-f0-9]{64}$")
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]*$")
CASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]*$")

EXIT_QUALIFIED = 0
EXIT_NOT_QUALIFIED = 2


class QualificationError(ValueError):
    """Fail-closed refusal: never downgrade one of these into a soft verdict."""


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def sha256_json(value):
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def dump_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.tmp")
    temp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    temp.replace(path)


# ------------------------------------------------------------------ contract

def contract_binding():
    """The contract identity every artifact of this workflow is bound to."""
    return {"version": CONTRACT_VERSION, "sha256": CONTRACT_SHA256, "reviewVersion": REVIEW_VERSION}


def assert_current_contract(identity, context):
    """Fail closed unless `identity` names the contract that is in force now.

    A superseded predicate cannot reproduce the frozen body hash, so the sha256 is
    the currency test and the version strings are only there to name the drift.
    """
    if not isinstance(identity, dict):
        raise QualificationError(f"{context} carries no review contract identity")
    review_version = identity.get("reviewVersion")
    if review_version is not None and review_version != REVIEW_VERSION:
        raise QualificationError(
            f"{context} was produced by {review_version!r}, not the current {REVIEW_VERSION}")
    version = identity.get("version")
    if version is not None and version != CONTRACT_VERSION:
        raise QualificationError(
            f"{context} names review contract {version!r}, not the current {CONTRACT_VERSION}")
    digest = identity.get("sha256")
    if digest != CONTRACT_SHA256:
        raise QualificationError(
            f"{context} names review contract hash {digest!r}, not the current {CONTRACT_SHA256}")
    return contract_binding()


def assert_current_review(review, context="review"):
    """Fail closed unless one reviewer emission came from the current contract.

    An emission that declares no contract at all is refused too: the acceptance
    fields of an unattributed review are not evidence about this contract.
    """
    if not isinstance(review, dict):
        raise QualificationError(f"{context} must be an object")
    version = review.get("version")
    if version is not None and version != REVIEW_VERSION:
        raise QualificationError(
            f"{context} declares review version {version!r}, not the current {REVIEW_VERSION}")
    return assert_current_contract(review.get("contract"), context)


def decision_from_review(review, context="review"):
    """Project one current-contract reviewer emission onto the shared decision.

    `review_contract.evaluate` is the only predicate, and the emission carries no
    verdict of its own for it to disagree with: `stages.py review3d` emits the
    reviewer's raw evidence and nothing derived from it.  What this adds is the
    fail-closed check that the evidence came from the contract in force.
    """
    assert_current_review(review, context)
    return normalize_decision(contract.acceptance_fields(contract.evaluate(review)), context)


def normalize_decision(value, context="decision"):
    """Validate the four shared fields and return them in canonical form."""
    if not isinstance(value, dict):
        raise QualificationError(f"{context} must be an object")
    unknown = sorted(set(value) - set(DECISION_FIELDS))
    if unknown:
        raise QualificationError(f"{context} carries fields outside the contract: {', '.join(unknown)}")
    missing = [field for field in DECISION_FIELDS if field not in value]
    if missing:
        raise QualificationError(f"{context} is missing {', '.join(missing)}")
    for field in BOOLEAN_DECISION_FIELDS:
        if not isinstance(value[field], bool):
            raise QualificationError(f"{context}.{field} must be a boolean")
    codes = value["defectCodes"]
    if not isinstance(codes, list) or any(not isinstance(code, str) for code in codes):
        raise QualificationError(f"{context}.defectCodes must be a list of strings")
    if len(set(codes)) != len(codes):
        raise QualificationError(f"{context}.defectCodes repeats a code")
    reason = value["unsupportedReason"]
    if reason is not None and (not isinstance(reason, str) or not reason.strip()):
        raise QualificationError(f"{context}.unsupportedReason must be null or a non-empty string")
    # The contract itself says whether a decision it did not derive could have come
    # from it, so the vocabulary and both predicates stay in exactly one place.
    problems = contract.decision_contradictions(value)
    if problems:
        raise QualificationError(f"{context} contradicts the review contract: {'; '.join(problems)}")
    return {
        "semanticAccepted": value["semanticAccepted"],
        "presentationAccepted": value["presentationAccepted"],
        "defectCodes": sorted(codes),
        "unsupportedReason": reason,
    }


def decision_of(record, context="decision"):
    return normalize_decision({field: record.get(field) for field in DECISION_FIELDS}, context)


# ------------------------------------------------------------- gold manifest

def _artifact(entry, key, context):
    artifact = entry.get(key)
    if not isinstance(artifact, dict):
        raise QualificationError(f"{context}.{key} must be an object with file and sha256")
    file = artifact.get("file")
    digest = artifact.get("sha256")
    if not isinstance(file, str) or not file or file.startswith("/") or ".." in Path(file).parts:
        raise QualificationError(f"{context}.{key}.file must be a repository-relative path")
    if not isinstance(digest, str) or not SHA256.match(digest):
        raise QualificationError(f"{context}.{key}.sha256 must be a lowercase sha256")
    return {"file": file, "sha256": digest}


def gold_seal(manifest):
    """Digest over everything a calibration run is allowed to depend on."""
    return sha256_json({
        "schema": manifest.get("schema"),
        "labelProvenance": manifest.get("labelProvenance"),
        "reviewContract": manifest.get("reviewContract"),
        "entries": manifest.get("entries"),
    })


def assert_human_label(label, context):
    if not isinstance(label, dict):
        raise QualificationError(f"{context} must be an object")
    inferred = sorted(set(label) & set(MODEL_PROVENANCE_KEYS))
    if inferred:
        raise QualificationError(
            f"{context} carries model provenance ({', '.join(inferred)}); gold decisions must be human labels")
    labeller = label.get("labeler")
    if not isinstance(labeller, str) or not labeller.strip():
        raise QualificationError(f"{context}.labeler is required")
    if MODEL_LABELLER.search(labeller):
        raise QualificationError(f"{context}.labeler {labeller!r} names a model; gold decisions must be human labels")
    labelled_at = label.get("labeledAt")
    if not isinstance(labelled_at, str) or not labelled_at.strip():
        raise QualificationError(f"{context}.labeledAt is required")
    unknown = sorted(set(label) - {"labeler", "labeledAt", *DECISION_FIELDS})
    if unknown:
        raise QualificationError(f"{context} carries unexpected fields: {', '.join(unknown)}")
    return {
        "labeler": labeller,
        "labeledAt": labelled_at,
        **decision_of(label, context),
    }


def gold_contract_block():
    """The contract binding a gold manifest is sealed against.

    Resealing after a contract change is deterministic because every value here is
    read out of `config/showcase-review-contract.json`; no human label is touched.
    """
    return {
        "fields": list(DECISION_FIELDS),
        "defectCodes": list(DEFECT_CODES),
        **contract_binding(),
        "realismMin": REALISM_MIN,
        "confidenceMin": CONFIDENCE_MIN,
    }


def load_gold(path, root):
    """Read, re-hash, and validate the gold manifest.  Raises on any doubt."""
    root = Path(root).resolve()
    manifest = load_json(path)
    if manifest.get("schema") != GOLD_SCHEMA:
        raise QualificationError(f"gold manifest schema {manifest.get('schema')!r} is not {GOLD_SCHEMA}")
    if manifest.get("labelProvenance") != "human":
        raise QualificationError("gold manifest labelProvenance must be human")
    binding = manifest.get("reviewContract")
    if not isinstance(binding, dict) or list(binding.get("fields", [])) != list(DECISION_FIELDS):
        raise QualificationError("gold manifest reviewContract.fields must be the shared decision contract")
    assert_current_contract(binding, "gold manifest reviewContract")
    if list(binding.get("defectCodes", [])) != list(DEFECT_CODES):
        raise QualificationError("gold manifest reviewContract.defectCodes must be the contract's defect vocabulary")
    if binding.get("realismMin") != REALISM_MIN or binding.get("confidenceMin") != CONFIDENCE_MIN:
        raise QualificationError("gold manifest reviewContract must bind the contract's acceptance thresholds")
    entries = manifest.get("entries")
    if not isinstance(entries, list) or not entries:
        raise QualificationError("gold manifest requires a non-empty entries array")
    if manifest.get("manifestSha256") != gold_seal(manifest):
        raise QualificationError("gold manifest seal does not match its contents; the manifest is immutable")

    seen_ids = set()
    by_video = {}
    resolved = []
    for entry in entries:
        evidence_id = entry.get("evidenceId")
        if not isinstance(evidence_id, str) or not evidence_id.strip():
            raise QualificationError("every gold entry requires an evidenceId")
        if evidence_id in seen_ids:
            raise QualificationError(f"gold entry {evidence_id} is duplicated")
        seen_ids.add(evidence_id)
        context = f"gold entry {evidence_id}"
        case_id = entry.get("caseId")
        if case_id is not None and (not isinstance(case_id, str) or not CASE_ID.match(case_id)):
            raise QualificationError(f"{context}.caseId must be null or a case id")
        request_text = entry.get("requestText")
        if not isinstance(request_text, str) or not request_text.strip():
            raise QualificationError(f"{context}.requestText is required to reproduce the brief-aware review")
        artifacts = {key: _artifact(entry, key, context) for key in ("video", "instance", "trace")}
        frames = entry.get("frames")
        if not isinstance(frames, list) or not frames:
            raise QualificationError(f"{context}.frames must list the exact reviewed key frames")
        frames = [_artifact({"frame": frame}, "frame", f"{context}.frames[{index}]")
                  for index, frame in enumerate(frames)]
        for key, artifact in [*artifacts.items(), *((f"frames[{index}]", frame)
                                                    for index, frame in enumerate(frames))]:
            file = (root / artifact["file"]).resolve()
            if not str(file).startswith(str(root)):
                raise QualificationError(f"{context}.{key}.file escapes the repository root")
            if not file.is_file():
                raise QualificationError(f"{context}.{key} evidence is missing: {artifact['file']}")
            observed = sha256_file(file)
            if observed != artifact["sha256"]:
                raise QualificationError(
                    f"{context}.{key} digest mismatch: manifest {artifact['sha256']} but bytes hash {observed}")
        label = entry.get("label")
        if label is not None:
            label = assert_human_label(label, f"{context}.label")
        video_sha = artifacts["video"]["sha256"]
        previous = by_video.get(video_sha)
        if previous is not None and previous.get("label") != label:
            raise QualificationError(
                f"identical footage {video_sha[:12]} carries conflicting gold labels "
                f"({previous['evidenceId']} and {evidence_id})")
        record = {"evidenceId": evidence_id, "caseId": case_id, "requestText": request_text,
                  **artifacts, "frames": frames, "label": label}
        by_video[video_sha] = record
        resolved.append(record)
    return {**manifest, "entries": resolved}


def eligible_gold(manifest):
    """Labelled, supported entries keyed by video digest — the calibration set."""
    eligible = {}
    for entry in manifest["entries"]:
        label = entry.get("label")
        if label is None or label["unsupportedReason"] is not None:
            continue
        eligible[entry["video"]["sha256"]] = entry
    return eligible


def carried_gold_labels(path):
    """Human labels from a predecessor manifest, verified but not re-bound.

    A manifest sealed under a superseded contract still holds real human work, so a
    reseal reads its labels through this door rather than `load_gold`, which refuses
    anything not bound to the contract in force.  A label the current contract
    cannot express is refused instead of translated: restating a human verdict in a
    vocabulary the labeller never saw would be fabrication.  Entries that were never
    labelled stay unlabelled.
    """
    manifest = load_json(path)
    if manifest.get("schema") != GOLD_SCHEMA:
        raise QualificationError(f"gold manifest schema {manifest.get('schema')!r} is not {GOLD_SCHEMA}")
    if manifest.get("labelProvenance") != "human":
        raise QualificationError("gold manifest labelProvenance must be human")
    if manifest.get("manifestSha256") != gold_seal(manifest):
        raise QualificationError("gold manifest seal does not match its contents; the manifest is immutable")
    carried = {}
    for entry in manifest.get("entries") or []:
        evidence_id = entry.get("evidenceId")
        digest = (entry.get("video") or {}).get("sha256")
        if not isinstance(digest, str) or not SHA256.match(digest):
            raise QualificationError(f"gold entry {evidence_id!r} carries no video sha256")
        label = entry.get("label")
        carried[digest] = {
            "caseId": entry.get("caseId"),
            "label": None if label is None else assert_human_label(label, f"gold entry {evidence_id}.label"),
        }
    return carried


# ---------------------------------------------------- repetitions and metrics

def review_row(review, *, gold_sha256, evidence_id, video_sha256, repetition):
    """One persisted calibration row: the canonical evaluator output and its provenance.

    The reviewer emission arrives from `stages.py review3d` as raw evidence, so the
    contract's verdict over that evidence is derived here -- exactly once, with no
    upstream copy to reconcile -- and stored beside the identity of the contract
    that derived it.
    """
    decision = decision_from_review(review, f"review of {evidence_id}")
    # Clamped by the contract's own bound, never a raw model number.
    realism = contract.clamp_number(review.get("realism"), 0.0, 10.0)
    return {
        "goldSha256": gold_sha256,
        "evidenceId": evidence_id,
        "videoSha256": video_sha256,
        "repetition": repetition,
        "reviewVersion": REVIEW_VERSION,
        "contractVersion": CONTRACT_VERSION,
        "contractSha256": CONTRACT_SHA256,
        "model": review.get("model"),
        "effort": review.get("effort"),
        "realism": realism,
        "rawResponseSha256": review.get("rawResponseSha256"),
        **decision,
    }


def group_reviews_by_evidence(reviews, repetitions, gold=None):
    """Group repeated reviews by the digest of the footage that was reviewed.

    Grouping is on evidence bytes, never on a scenario or case name: two reviews
    only belong together when the reviewer saw byte-identical footage.  Every row
    must name the contract in force, so a batch that mixes contract hashes is
    refused instead of averaged into one reviewer-stability number.
    """
    if not isinstance(repetitions, int) or repetitions < 2:
        raise QualificationError("repetitions must be an integer of at least 2")
    groups = {}
    for index, review in enumerate(reviews):
        context = f"review {index}"
        digest = review.get("videoSha256")
        if not isinstance(digest, str) or not SHA256.match(digest):
            raise QualificationError(f"{context} is missing a videoSha256 evidence digest")
        assert_current_contract({"version": review.get("contractVersion"),
                                 "sha256": review.get("contractSha256"),
                                 "reviewVersion": review.get("reviewVersion")}, context)
        realism = review.get("realism")
        if not isinstance(realism, (int, float)) or isinstance(realism, bool):
            raise QualificationError(f"{context} is missing a numeric realism score")
        groups.setdefault(digest, []).append({
            "videoSha256": digest,
            "repetition": review.get("repetition"),
            "realism": float(realism),
            **decision_of(review, context),
        })
    if gold is not None:
        unknown = sorted(set(groups) - set(gold))
        if unknown:
            raise QualificationError(
                f"reviews reference footage absent from the gold manifest: {', '.join(item[:12] for item in unknown)}")
        missing = sorted(set(gold) - set(groups))
        if missing:
            raise QualificationError(
                f"gold footage was never reviewed: {', '.join(item[:12] for item in missing)}")
    short = sorted(digest for digest, items in groups.items() if len(items) != repetitions)
    if short:
        raise QualificationError(
            f"identical-footage repetitions must be exactly {repetitions} per evidence; "
            f"wrong count for {', '.join(item[:12] for item in short)}")
    return {digest: groups[digest] for digest in sorted(groups)}


def _rate(numerator, denominator):
    return None if denominator == 0 else round(numerator / denominator, 6)


def confusion_matrix(gold, groups, field):
    """Per-review confusion against gold; every repetition counts as one call."""
    counts = {"truePositive": 0, "falsePositive": 0, "trueNegative": 0, "falseNegative": 0}
    for digest, reviews in groups.items():
        truth = gold[digest]["label"][field]
        for review in reviews:
            observed = review[field]
            if truth and observed:
                counts["truePositive"] += 1
            elif truth and not observed:
                counts["falseNegative"] += 1
            elif not truth and observed:
                counts["falsePositive"] += 1
            else:
                counts["trueNegative"] += 1
    counts["reviews"] = sum(counts[key] for key in
                            ("truePositive", "falsePositive", "trueNegative", "falseNegative"))
    counts["falsePositiveRate"] = _rate(counts["falsePositive"], counts["falsePositive"] + counts["trueNegative"])
    counts["falseNegativeRate"] = _rate(counts["falseNegative"], counts["falseNegative"] + counts["truePositive"])
    counts["accuracy"] = _rate(counts["truePositive"] + counts["trueNegative"], counts["reviews"])
    return counts


def _field_value(review, field):
    if field == "defectCodes":
        return tuple(review[field])
    return review[field]


def flip_rates(groups):
    """A field flips when repeated reviews of identical footage disagree."""
    per_field = {}
    flipped_groups = set()
    for field in DECISION_FIELDS:
        flipped = [digest for digest, reviews in groups.items()
                   if len({_field_value(review, field) for review in reviews}) > 1]
        flipped_groups.update(flipped)
        per_field[field] = {"evidence": len(groups), "flipped": len(flipped),
                            "rate": _rate(len(flipped), len(groups))}
    return {
        "evidence": len(groups),
        "flippedEvidence": len(flipped_groups),
        "rate": _rate(len(flipped_groups), len(groups)),
        "byField": per_field,
    }


def _stdev(values):
    if len(values) < 2:
        return 0.0
    mean = sum(values) / len(values)
    return math.sqrt(sum((value - mean) ** 2 for value in values) / (len(values) - 1))


def realism_dispersion(groups):
    """Within-footage realism spread: the same video judged repeatedly."""
    per_group = {digest: round(_stdev([review["realism"] for review in reviews]), 6)
                 for digest, reviews in groups.items()}
    values = list(per_group.values())
    return {
        "evidence": len(values),
        "meanSd": round(sum(values) / len(values), 6) if values else None,
        "maxSd": round(max(values), 6) if values else None,
        "pooledSd": round(math.sqrt(sum(value ** 2 for value in values) / len(values)), 6) if values else None,
        "byEvidence": per_group,
    }


def build_calibration(manifest, reviews, repetitions):
    """Reviewer stability against human gold, all under one contract hash.

    `load_gold` has already refused any label carrying model provenance, so the
    manifest reaching this point holds hand-entered decisions only; the binding is
    re-checked here because a calibration report is what the exit evaluator trusts.
    """
    assert_current_contract(manifest.get("reviewContract"), "gold manifest reviewContract")
    if manifest.get("labelProvenance") != "human":
        raise QualificationError("calibration requires a gold manifest of human labels")
    gold = eligible_gold(manifest)
    if not gold:
        raise QualificationError("the gold manifest carries no labelled, supported entries to calibrate against")
    groups = group_reviews_by_evidence(reviews, repetitions, gold)
    unsupported = [entry["evidenceId"] for entry in manifest["entries"]
                   if entry.get("label") and entry["label"]["unsupportedReason"] is not None]
    return {
        "schema": CALIBRATION_SCHEMA,
        "reviewContract": contract_binding(),
        "reviewVersion": REVIEW_VERSION,
        "goldSha256": manifest["manifestSha256"],
        "repetitions": repetitions,
        "labelledEvidence": len(gold),
        "unlabelledEvidence": sum(1 for entry in manifest["entries"] if entry.get("label") is None),
        "unsupportedEvidence": sorted(unsupported),
        "reviews": sum(len(items) for items in groups.values()),
        "confusion": {field: confusion_matrix(gold, groups, field) for field in BOOLEAN_DECISION_FIELDS},
        "flip": flip_rates(groups),
        "realism": realism_dispersion(groups),
    }


# --------------------------------------------------------------- run configs

def load_breadth(path):
    config = load_json(path)
    if config.get("schema") != BREADTH_SCHEMA:
        raise QualificationError(f"breadth config schema {config.get('schema')!r} is not {BREADTH_SCHEMA}")
    cases = config.get("cases")
    if not isinstance(cases, list) or not cases:
        raise QualificationError("breadth config requires a non-empty cases array")
    expected = config.get("caseCount")
    if not isinstance(expected, int) or expected != len(cases):
        raise QualificationError(f"breadth config declares caseCount {expected!r} but carries {len(cases)} cases")
    stages = list(config.get("stages", []))
    if stages != list(STAGES):
        raise QualificationError("breadth config stages must be the exact showcase pipeline stages")
    required = list(config.get("requiredStages", []))
    # Only the two stage-local retry branches may be absent: a healthy attempt
    # reaches every other stage, so requiring less would hide a truncated run.
    if required != list(REQUIRED_STAGES):
        raise QualificationError(
            "breadth config requiredStages must be every stage except the optional retry branches "
            f"({', '.join(OPTIONAL_STAGES)})")
    vocabulary = list(config.get("stageOutcomeVocabulary", []))
    if vocabulary != list(STAGE_OUTCOMES):
        raise QualificationError("breadth config stageOutcomeVocabulary must be the current stage outcomes")
    ids = []
    for case in cases:
        case_id = case.get("id")
        if not isinstance(case_id, str) or not SLUG.match(case_id):
            raise QualificationError(f"breadth case id {case_id!r} must be a lowercase slug")
        if not isinstance(case.get("title"), str) or not case["title"].strip():
            raise QualificationError(f"breadth case {case_id} requires a title")
        outcomes = case.get("stageOutcomes")
        if not isinstance(outcomes, dict) or sorted(outcomes) != sorted(stages):
            raise QualificationError(f"breadth case {case_id} must record an outcome for every stage")
        unknown = sorted({value for value in outcomes.values() if value not in STAGE_OUTCOMES})
        if unknown:
            raise QualificationError(f"breadth case {case_id} has unknown stage outcomes: {', '.join(unknown)}")
        ids.append(case_id)
    if len(set(ids)) != len(ids):
        raise QualificationError("breadth config repeats a case id")
    return {**config, "caseIds": ids}


def load_qualification(path, breadth):
    config = load_json(path)
    if config.get("schema") != QUALIFICATION_SCHEMA:
        raise QualificationError(f"qualification config schema {config.get('schema')!r} is not {QUALIFICATION_SCHEMA}")
    assert_current_contract(config.get("reviewContract"), "qualification config reviewContract")
    attempts = config.get("attemptsPerCase")
    if not isinstance(attempts, int) or attempts < 1:
        raise QualificationError("qualification attemptsPerCase must be a positive integer")
    cases = config.get("cases")
    if not isinstance(cases, list) or not cases:
        raise QualificationError("qualification config requires a non-empty cases array")
    known = set(breadth["caseIds"])
    ids = []
    for case in cases:
        case_id = case.get("id")
        if not isinstance(case_id, str) or not CASE_ID.match(case_id):
            raise QualificationError(f"qualification case id {case_id!r} is not a case id")
        breadth_id = case.get("breadthCaseId")
        if breadth_id not in known:
            raise QualificationError(
                f"qualification case {case_id} maps to breadthCaseId {breadth_id!r}, which is not in the breadth config")
        if not isinstance(case.get("family"), str) or not case["family"].strip():
            raise QualificationError(f"qualification case {case_id} requires a family")
        ids.append(case_id)
    if len(set(ids)) != len(ids):
        raise QualificationError("qualification config repeats a case id")
    exit_criteria = config.get("exit")
    if not isinstance(exit_criteria, dict):
        raise QualificationError("qualification config requires an exit object")
    numbers = {
        "semanticYieldMin": (float, 0.0, 1.0),
        "reviewerFlipRateMax": (float, 0.0, 1.0),
        "casesMeetingYieldMin": (int, 1, len(cases)),
        "maxOperationalFailures": (int, 0, attempts * len(cases)),
        "reviewRepetitions": (int, 2, 100),
        "minimumGoldLabels": (int, 1, 10_000),
    }
    for key, (kind, low, high) in numbers.items():
        value = exit_criteria.get(key)
        if kind is int and (not isinstance(value, int) or isinstance(value, bool)):
            raise QualificationError(f"qualification exit.{key} must be an integer")
        if kind is float and (not isinstance(value, (int, float)) or isinstance(value, bool)):
            raise QualificationError(f"qualification exit.{key} must be a number")
        if not low <= value <= high:
            raise QualificationError(f"qualification exit.{key} must be within [{low}, {high}]")
    return {**config, "caseIds": ids}


# ------------------------------------------------------------ exit evaluation

def attempt_record_facts(record, context="attempt record"):
    """Stage and funnel facts for one attempt, read only from its 95-benchmark record.

    The attempt record is the pipeline's own continuously rewritten evidence, so a
    crashed attempt still reports the stages it paid for.  Nothing about acceptance
    is read here: this answers only how far the attempt got and why it stopped.
    """
    if record is None:
        return {"attemptRecord": None, "funnel": None, "furthestStage": None,
                "stageOutcomes": {}, "censoredAtStage": None, "failedStage": None,
                "operational": None, "recordOutcome": None}
    if not isinstance(record, dict):
        raise QualificationError(f"{context} must be an object")
    if record.get("schema") != ATTEMPT_RECORD_SCHEMA:
        raise QualificationError(f"{context} schema {record.get('schema')!r} is not {ATTEMPT_RECORD_SCHEMA}")
    funnel = record.get("funnel")
    if not isinstance(funnel, dict):
        raise QualificationError(f"{context} carries no funnel")
    unknown = sorted(set(funnel) - set(FUNNEL_STAGES))
    if unknown:
        raise QualificationError(f"{context} funnel names unknown stages: {', '.join(unknown)}")
    reached = [stage for stage in FUNNEL_STAGES if funnel.get(stage) is True]
    outcomes = {}
    for row in record.get("stages") or []:
        if not isinstance(row, dict):
            raise QualificationError(f"{context} stage ledger rows must be objects")
        name = STAGE_ALIASES.get(row.get("name"), row.get("name"))
        if name not in STAGES:
            raise QualificationError(
                f"{context} ledger names stage {row.get('name')!r}, which is not a pipeline stage")
        status = row.get("status")
        if status not in STAGE_OUTCOMES:
            raise QualificationError(
                f"{context} stage {name} reports outcome {status!r}, which is not a stage outcome")
        outcomes[name] = status
    outcome = record.get("outcome") if isinstance(record.get("outcome"), dict) else {}
    return {
        "attemptRecord": ATTEMPT_RECORD_SCHEMA,
        "funnel": {stage: funnel.get(stage) is True for stage in FUNNEL_STAGES},
        "furthestStage": reached[-1] if reached else None,
        "stageOutcomes": outcomes,
        "censoredAtStage": outcome.get("censoredAtStage"),
        "failedStage": outcome.get("failedStage"),
        "operational": outcome.get("operational"),
        "recordOutcome": outcome.get("kind"),
    }


def decision_document(product=None, judge=None, context="attempt"):
    """The document whose acceptance decision governs one attempt.

    `75-product.json` is the deliverable decision: it rations presentation to the
    job's `topK`, folds in the deterministic defect codes that rejected cells before
    any reviewer saw them, and names the attempt whose render was promoted.
    `70-judge.json` is consulted only when no product decision exists, and then only
    as current-contract source evidence -- never as an acceptance of its own.
    """
    for name, document, schema in (("75-product.json", product, PRODUCT_SCHEMA),
                                   ("70-judge.json", judge, None)):
        if document is None:
            continue
        if not isinstance(document, dict):
            raise QualificationError(f"{context} {name} must be an object")
        if schema is not None and document.get("schema") != schema:
            raise QualificationError(f"{context} {name} schema {document.get('schema')!r} is not {schema}")
        assert_current_contract(document.get("contract"), f"{context} {name}")
        return name, document
    return None, None


def _decided_rows(document):
    """Rows the contract actually decided, in the document's own ranking order."""
    return [row for row in (document or {}).get("cells") or []
            if isinstance(row, dict) and all(field in row for field in DECISION_FIELDS)]


def _decisive_row(rows):
    """The row an attempt is judged on: the cell it shipped, else its best verdict.

    Each row's decision is internally consistent because the contract derived it; a
    union across cells would not be, so the attempt is judged on one row and the
    other rows' codes travel beside it as evidence.
    """
    for field in ("presentationAccepted", "semanticAccepted"):
        for row in rows:
            if row.get(field) is True:
                return row
    return rows[0]


def _evidence_codes(document, rows, context):
    codes = {code for row in rows for code in row.get("defectCodes") or []}
    codes.update(document.get("defectCodes") or [])
    unplaceable = sorted(code for code in codes if not contract.is_contract_code(code))
    if unplaceable:
        raise QualificationError(
            f"{context} carries defect codes the contract cannot place: {', '.join(unplaceable)}")
    return sorted(codes)


def attempt_outcome(attempt, product=None, judge=None, record=None):
    """Classify one campaign attempt into exactly one qualification outcome.

    Evidence authority is the pipeline's own.  `75-product.json` is the deliverable
    decision and outranks everything; `70-judge.json` is source evidence when no
    product decision was written; `95-benchmark.json` supplies the stage and funnel
    facts.  Operational failures (infrastructure, gateway, crash) are never a
    semantic verdict, so they stay out of the yield denominator and are counted on
    their own.  An unsupported attempt is a representability result, not a defect,
    and carries no manufactured defect code.
    """
    if not isinstance(attempt, dict):
        raise QualificationError("attempt must be an object")
    number = attempt.get("number")
    if not isinstance(number, int) or isinstance(number, bool) or number < 1:
        raise QualificationError("attempt.number must be a positive integer")
    context = f"attempt {number}"
    row = {"number": number, "jobId": attempt.get("jobId"), "outcome": None, "decision": None,
           "unsupportedReason": None, "evidence": None, "acceptedAttempt": None, "renderDir": None,
           "videoSha256": attempt.get("videoSha256"), "defectCodes": [],
           **attempt_record_facts(record, f"{context} record")}
    reason = attempt.get("unsupportedReason")
    if isinstance(reason, str) and reason.strip():
        return {**row, "outcome": "unsupported", "unsupportedReason": reason.strip()}
    if (attempt.get("status") != "complete" or row["operational"] is not None
            or row["censoredAtStage"] is not None):
        return {**row, "outcome": "operational-failure"}
    name, document = decision_document(product, judge, context)
    rows = _decided_rows(document)
    if not rows:
        # No cell reached a verdict under this contract, so the attempt spent its
        # renders without producing reviewable evidence. That is an operational
        # outcome and never a statement about the requested scenario.
        return {**row, "outcome": "operational-failure", "evidence": name}
    decisive = _decisive_row(rows)
    decision = decision_of(decisive, f"{context} {name} cell {decisive.get('cellId')}")
    outcome = ("unsupported" if decision["unsupportedReason"] is not None
               else "semantic-accepted" if decision["semanticAccepted"] else "semantic-rejected")
    return {**row, "outcome": outcome, "decision": decision, "evidence": name,
            "unsupportedReason": decision["unsupportedReason"],
            "defectCodes": _evidence_codes(document, rows, f"{context} {name}"),
            "acceptedAttempt": document.get("acceptedAttempt"),
            "renderDir": decisive.get("renderDir")}


def summarize_case(case_id, attempts_per_case, outcomes):
    counted = [item for item in outcomes if item["outcome"] != "operational-failure"]
    accepted = [item for item in counted if item["outcome"] == "semantic-accepted"]
    furthest = {}
    for item in outcomes:
        stage = item.get("furthestStage")
        if stage is not None:
            furthest[stage] = furthest.get(stage, 0) + 1
    return {
        "caseId": case_id,
        "attemptsPlanned": attempts_per_case,
        "attemptsObserved": len(outcomes),
        "operationalFailures": sum(1 for item in outcomes if item["outcome"] == "operational-failure"),
        "unsupported": sum(1 for item in outcomes if item["outcome"] == "unsupported"),
        "semanticAccepted": len(accepted),
        "semanticRejected": sum(1 for item in counted if item["outcome"] == "semantic-rejected"),
        "countedAttempts": len(counted),
        "semanticYield": _rate(len(accepted), len(counted)),
        # Stage facts come from the attempt records, so a run can be read for where
        # it stopped and not only for whether it was accepted.
        "attemptRecords": sum(1 for item in outcomes if item.get("attemptRecord")),
        "furthestStages": {stage: furthest[stage] for stage in FUNNEL_STAGES if stage in furthest},
        "productDecisions": sum(1 for item in outcomes if item.get("evidence") == "75-product.json"),
        "outcomes": outcomes,
    }


def evaluate_exit(config, calibration, case_outcomes):
    """Machine exit evaluator: a verdict plus the process exit code to use."""
    criteria = config["exit"]
    if calibration.get("schema") != CALIBRATION_SCHEMA:
        raise QualificationError(f"calibration schema {calibration.get('schema')!r} is not {CALIBRATION_SCHEMA}")
    assert_current_contract(calibration.get("reviewContract"), "calibration reviewContract")
    if calibration.get("repetitions") != criteria["reviewRepetitions"]:
        raise QualificationError(
            f"calibration used {calibration.get('repetitions')} repetitions but the config requires "
            f"{criteria['reviewRepetitions']}")
    missing = sorted(set(config["caseIds"]) - set(case_outcomes))
    if missing:
        raise QualificationError(f"no attempts were supplied for {', '.join(missing)}")
    extra = sorted(set(case_outcomes) - set(config["caseIds"]))
    if extra:
        raise QualificationError(f"attempts were supplied for unknown cases: {', '.join(extra)}")

    cases = [summarize_case(case["id"], config["attemptsPerCase"], case_outcomes[case["id"]])
             for case in config["cases"]]
    for case in cases:
        if case["attemptsObserved"] != config["attemptsPerCase"]:
            raise QualificationError(
                f"case {case['caseId']} recorded {case['attemptsObserved']} attempts but the config plans "
                f"{config['attemptsPerCase']}")

    meeting = [case["caseId"] for case in cases
               if case["semanticYield"] is not None and case["semanticYield"] >= criteria["semanticYieldMin"]]
    operational = sum(case["operationalFailures"] for case in cases)
    labelled = calibration["labelledEvidence"]
    flip = calibration["flip"]["rate"]

    checks = [
        {
            "id": "semantic-yield",
            "threshold": f">= {criteria['semanticYieldMin']} on >= {criteria['casesMeetingYieldMin']} of {len(cases)} cases",
            "observed": {"casesMeeting": len(meeting), "cases": sorted(meeting),
                         "yields": {case["caseId"]: case["semanticYield"] for case in cases}},
            "pass": len(meeting) >= criteria["casesMeetingYieldMin"],
        },
        {
            "id": "reviewer-flip",
            "threshold": f"< {criteria['reviewerFlipRateMax']}",
            "observed": {"flipRate": flip, "byField": calibration["flip"]["byField"],
                         "realismSd": calibration["realism"]["meanSd"]},
            "pass": flip is not None and flip < criteria["reviewerFlipRateMax"],
        },
        {
            "id": "operational-failures",
            "threshold": f"<= {criteria['maxOperationalFailures']}",
            "observed": {"operationalFailures": operational},
            "pass": operational <= criteria["maxOperationalFailures"],
        },
        {
            "id": "gold-labels",
            "threshold": f">= {criteria['minimumGoldLabels']}",
            "observed": {"labelledEvidence": labelled},
            "pass": labelled >= criteria["minimumGoldLabels"],
        },
    ]
    qualified = all(check["pass"] for check in checks)
    verdict = {
        "schema": VERDICT_SCHEMA,
        "qualificationId": config.get("id"),
        "reviewContract": contract_binding(),
        "reviewVersion": REVIEW_VERSION,
        "goldSha256": calibration["goldSha256"],
        "qualified": qualified,
        "exitCode": EXIT_QUALIFIED if qualified else EXIT_NOT_QUALIFIED,
        "blockers": [check["id"] for check in checks if not check["pass"]],
        "checks": checks,
        "cases": cases,
        "totals": {
            "attempts": sum(case["attemptsObserved"] for case in cases),
            "countedAttempts": sum(case["countedAttempts"] for case in cases),
            "semanticAccepted": sum(case["semanticAccepted"] for case in cases),
            "unsupported": sum(case["unsupported"] for case in cases),
            "operationalFailures": operational,
            "attemptRecords": sum(case["attemptRecords"] for case in cases),
            "productDecisions": sum(case["productDecisions"] for case in cases),
        },
    }
    return verdict
