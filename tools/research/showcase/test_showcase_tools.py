#!/usr/bin/env python3
"""Focused unit tests for P5 glue; no gateway, simulator, or renderer calls."""
import importlib.util
import json
from pathlib import Path
import tempfile
from contextlib import redirect_stdout
from io import StringIO
from types import SimpleNamespace
import unittest


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]


def load(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


author = load("author_one")
gallery = load("preseed_gallery")
semantic = load("semantic_contract")
review = load("review_contract")
stages = load("stages")
qual = load("qualification")
qualify_cli = load("qualify")

FULL_REVIEW = {"tier": "3d", "mechanismFidelity": "yes", "visualGrounding": "pass",
               "actorFidelity": "pass", "eventSequence": "pass", "plausible": True,
               "realism": 7, "confidence": 0.8, "defects": [],
               "explanation": "The requested mechanism happens on camera on solid ground."}


def candidate(root, cell, story, gate, realism, dynamism):
    return {"root": Path(root), "cell": Path(root) / cell,
            "meta": {"cellId": cell, "briefId": story, "gate": {"pass": gate}},
            "verdict": {"realism": realism, "dynamism": dynamism, "confidence": 0.8}}


class AuthorHelpersTest(unittest.TestCase):
    def test_stage_layout_and_category(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(author._stage_dir(tmp), Path(tmp).resolve() / "20-author")
        self.assertEqual(author._category("a slower lead vehicle brakes hard"), "longitudinal")
        self.assertEqual(author._category("a cyclist emerges from behind a van"), "vru")

    def test_slug_is_stable_and_bounded(self):
        value = author._slug("A" * 200)
        self.assertEqual(value, author._slug("A" * 200))
        self.assertLessEqual(len(value), 64)

    def test_authoring_enforces_twenty_second_minimum_clip(self):
        with tempfile.TemporaryDirectory() as tmp:
            template = Path(tmp) / "template.json"
            template.write_text(json.dumps({"choreography": {"clipSeconds": 16}}))
            self.assertEqual(author._enforce_minimum_clip(template), 20.0)
            self.assertEqual(json.loads(template.read_text())["choreography"]["clipSeconds"], 20.0)
            template.write_text(json.dumps({"choreography": {"clipSeconds": 24}}))
            self.assertEqual(author._enforce_minimum_clip(template), 24.0)


class SemanticContractTest(unittest.TestCase):
    BRIEF = {
        "id": "motorcycle-reveal",
        "brief": "At a signalized intersection the ego turns left. An oncoming SUV blocks the ego's view of a motorcycle lane-splitting between lanes. The motorcycle emerges late and the ego brakes and stops partially across the intersection without collision.",
    }

    def test_rejects_description_only_mechanism(self):
        contract = semantic.derive_contract(
            self.BRIEF, ["junction_any", "junction_signalized", "oncoming_lane"])
        template = {
            "anchor": {"corridor": {"throughLanesOpposing": {"value": [2, 4], "essentiality": "required"}}, "features": []},
            "roles": [
                {"id": "ego", "actor": {"class": "car", "catalogId": "vehicle.sedan"}},
                {"id": "motorcycle", "actor": {"class": "motorcycle", "catalogId": "vehicle.motorcycle"}, "tFrac": 0},
                {"id": "suv", "actor": {"class": "car", "catalogId": "vehicle.suv"}, "headingOffsetRad": 3.14159},
            ],
            "choreography": {"clipSeconds": 16, "interactions": []},
            "invariants": [],
        }
        failures = {item["kind"] for item in semantic.validate_template(template, contract)}
        self.assertTrue({"signalized_junction", "ego_left_turn", "declared_occlusion",
                         "lane_splitting_actor", "ego_braking_response",
                         "minimum_clip", "required_invariants"}.issubset(failures))

    def test_accepts_executable_contract(self):
        contract = semantic.derive_contract(
            self.BRIEF, ["junction_any", "junction_signalized", "oncoming_lane"])
        template = {
            "anchor": {
                "corridor": {"throughLanesOpposing": {"value": [2, 4], "essentiality": "required"}},
                "features": [{"id": "jx", "kind": "junction", "essentiality": "required",
                              "control": {"value": ["signalized"], "essentiality": "required"},
                              "egoTurn": {"value": ["left"], "essentiality": "required"}}],
            },
            "roles": [
                {"id": "ego", "actor": {"class": "car", "catalogId": "vehicle.sedan"}},
                {"id": "motorcycle", "actor": {"class": "motorcycle", "catalogId": "vehicle.motorcycle"},
                 "tFrac": 0.9, "headingOffsetRad": 3.14159},
                {"id": "suv", "actor": {"class": "car", "catalogId": "vehicle.suv"},
                 "headingOffsetRad": 3.14159,
                 "extensions": {"occludes": {"observer": "ego", "target": "motorcycle"}}},
            ],
            "choreography": {"clipSeconds": 20, "interactions": [
                {"actor": "ego", "verb": "speed", "trigger": {"kind": "at", "t": 5},
                 "target": {"mode": "stop"}},
            ]},
            "invariants": [{"id": "criticality", "kind": "ttc", "essentiality": "required"}],
        }
        self.assertEqual(semantic.validate_template(template, contract), [])


class ReviewContractTest(unittest.TestCase):
    """The acceptance contract is shared with JavaScript, so hash and verdicts are both frozen."""

    def test_declared_hash_matches_the_canonical_body(self):
        body = {key: value for key, value in review.CONTRACT.items() if key != "sha256"}
        self.assertEqual(review.CONTRACT_SHA256, review.sha256_text(review.canonical_json(body)))
        # Integral floats serialise as '1.0' here and '1' in JavaScript, which would fork the hash.
        self.assertEqual(review._integral_floats(body), [])

    def test_every_conformance_vector_agrees_with_the_predicates(self):
        self.assertGreaterEqual(len(review.CONTRACT["conformance"]), 10)
        for vector in review.CONTRACT["conformance"]:
            with self.subTest(vector["name"]):
                got = review.evaluate(vector["review"])
                self.assertEqual(
                    {"semanticAccepted": got["semanticAccepted"],
                     "presentationAccepted": got["presentationAccepted"],
                     "defectCodes": got["defectCodes"],
                     "unsupported": got["unsupportedReason"] is not None},
                    {"semanticAccepted": vector["expect"]["semanticAccepted"],
                     "presentationAccepted": vector["expect"]["presentationAccepted"],
                     "defectCodes": vector["expect"]["defectCodes"],
                     "unsupported": vector["expect"]["unsupported"]})

    def test_presentation_defects_never_reject_a_correct_scenario(self):
        got = review.evaluate({**FULL_REVIEW, "visualGrounding": "fail", "defects": [
            {"code": "render.camera.framing", "text": "the conflict is cropped at the right edge"},
            {"code": "render.asset.grounding", "text": "the sedan hovers above the lane",
             "confidence": 0.7}]})
        self.assertTrue(got["semanticAccepted"])
        self.assertFalse(got["presentationAccepted"])
        self.assertIsNone(got["unsupportedReason"])
        self.assertEqual(got["defectCodes"], ["render.asset.grounding", "render.camera.framing"])
        preserved = [(item["text"], item["confidence"]) for item in got["defects"]
                     if item["source"] == "model"]
        self.assertEqual(preserved, [("the conflict is cropped at the right edge", 0.8),
                                     ("the sedan hovers above the lane", 0.7)])

    def test_scenario_defects_and_silent_reviews_fail_both_verdicts(self):
        sequence = review.evaluate({**FULL_REVIEW, "eventSequence": "fail"})
        self.assertEqual((sequence["semanticAccepted"], sequence["presentationAccepted"]), (False, False))
        self.assertEqual(sequence["defectCodes"], ["scenario.sequence"])
        silent = review.evaluate({**FULL_REVIEW, "explanation": "  "})
        self.assertEqual((silent["semanticAccepted"], silent["presentationAccepted"]), (False, False))
        self.assertEqual(silent["defectCodes"], ["judge.uncertain"])
        self.assertIn("no explanatory text", silent["unsupportedReason"])

    def test_review_emission_preserves_raw_defect_evidence(self):
        self.assertEqual(
            stages.raw_defects([{"code": " render.camera.framing ", "text": "cropped", "confidence": 2},
                                "frozen_actor", {"description": "no text key"}]),
            [{"text": "cropped", "code": "render.camera.framing", "confidence": 1.0},
             "frozen_actor",
             {"text": "no text key"}])
        self.assertEqual(stages.raw_defects(None), [])


class GallerySelectionTest(unittest.TestCase):
    def test_map_id_comes_from_instance_evidence(self):
        instance = {"manifest": {"replayKey": {"mapId": "yale-street"}}}
        self.assertEqual(gallery._map_id(instance, {"map": "street"}), "yale-street")

    def test_gate_is_primary_rank(self):
        passing = candidate("/a", "pass", "one", True, 1, 1)
        failing = candidate("/a", "fail", "two", False, 10, 10)
        got = gallery.select({Path("/a"): [passing, failing]}, 1)
        self.assertEqual(got[0]["meta"]["cellId"], "pass")

    def test_each_live_root_gets_quota_and_stories_are_unique(self):
        roots = {}
        for root in ("/a", "/b"):
            roots[Path(root)] = [candidate(root, f"{root[-1]}-{n}", f"story-{root[-1]}-{n}",
                                           True, 9 - n, 8) for n in range(3)]
        got = gallery.select(roots, 4)
        self.assertEqual(len(got), 4)
        self.assertEqual({item["root"] for item in got}, {Path("/a"), Path("/b")})
        self.assertEqual(len({_story(item) for item in got}), 4)


def _human_label(semantic_accepted, presentation_accepted=True, codes=(), reason=None):
    return {"labeler": "hana.ito", "labeledAt": "2026-08-18T09:00:00Z",
            "semanticAccepted": semantic_accepted, "presentationAccepted": presentation_accepted,
            "defectCodes": list(codes), "unsupportedReason": reason}


def _emission(**overrides):
    """A canonical `stages.py review3d` emission under the contract in force."""
    answered = {"mechanismFidelity": "yes", "visualGrounding": "pass", "actorFidelity": "pass",
                "eventSequence": "pass", "plausible": True, "realism": 8.0, "confidence": 0.9,
                "defects": [],
                "explanation": "The requested mechanism happens on camera on solid ground."}
    answered.update(overrides)
    return {"cellId": "cell-a", "version": review.REVIEW_VERSION, "contract": review.contract_identity(),
            "model": "gpt-5.6-sol", "effort": "medium", "visionAsserted": True,
            "tier": review.FULL_TIER, **answered,
            "rawResponseSha256": "0" * 64}


def _judged_cell(cell_id, emission, **overrides):
    """One judge or product row, exactly as `applyProductDecision` writes it."""
    verdict = review.evaluate(emission)
    return {"cellId": cell_id, "status": "complete", "threeDReview": emission,
            **review.acceptance_fields(verdict),
            "acceptance": {"tier": verdict["tier"], "axes": verdict["axes"],
                           "defects": verdict["defects"], "contract": review.contract_identity(),
                           "gatePassed": True, "cappedByTopK": False},
            **overrides}


def _judge_document(cells, **overrides):
    return {"status": "complete", "contract": review.contract_identity(), "cells": cells, **overrides}


def _product_document(cells, **overrides):
    rows = [{"renderDir": f"65-render3d/{row['cellId']}", **row} for row in cells]
    return {"schema": qual.PRODUCT_SCHEMA, "status": "complete", "contract": review.contract_identity(),
            "acceptedAttempt": None, "acceptedCells": sum(1 for row in rows if row["presentationAccepted"]),
            "defectCodes": sorted({code for row in rows for code in row["defectCodes"]}),
            "cells": rows, **overrides}


def _attempt_record(furthest="presentation", stages=(), **overrides):
    """An attempt record whose funnel is reached up to and including `furthest`."""
    limit = qual.FUNNEL_STAGES.index(furthest)
    return {"schema": qual.ATTEMPT_RECORD_SCHEMA,
            "funnel": {stage: index <= limit for index, stage in enumerate(qual.FUNNEL_STAGES)},
            "stages": [{"name": name, "status": status} for name, status in stages],
            "outcome": {"kind": "accepted", "censoredAtStage": None, "failedStage": None,
                        "operational": None},
            **overrides}


def _write_evidence(root, evidence_id, payload):
    video = root / "videos" / f"{evidence_id}.mp4"
    frame = root / "videos" / f"{evidence_id}-frame-000.png"
    instance = root / "cells" / evidence_id / "instance.json"
    trace = root / "cells" / evidence_id / "trace.json.gz"
    for path, blob in ((video, payload), (frame, payload + b"f"),
                       (instance, b"{}"), (trace, b"\x1f\x8b")):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
    return {"evidenceId": evidence_id, "caseId": None, "requestText": f"request for {evidence_id}",
            "video": {"file": str(video.relative_to(root)), "sha256": qual.sha256_file(video)},
            "frames": [{"file": str(frame.relative_to(root)), "sha256": qual.sha256_file(frame)}],
            "instance": {"file": str(instance.relative_to(root)), "sha256": qual.sha256_file(instance)},
            "trace": {"file": str(trace.relative_to(root)), "sha256": qual.sha256_file(trace)},
            "label": None}


def _seal(root, entries, contract_block=None):
    manifest = {"schema": qual.GOLD_SCHEMA, "id": "test-gold", "labelProvenance": "human",
                "reviewContract": contract_block or qual.gold_contract_block(),
                "entries": entries}
    manifest["manifestSha256"] = qual.gold_seal(manifest)
    path = root / "gold.json"
    qual.dump_json(path, manifest)
    return path


class DecisionContractTest(unittest.TestCase):
    """The review contract is the only predicate; this module may only project it."""

    def test_decision_is_exactly_the_contract_evaluator_output(self):
        for emission in (_emission(),
                         _emission(mechanismFidelity="partial"),
                         _emission(visualGrounding="fail"),
                         _emission(defects=[{"code": "render.camera.framing", "text": "event is cropped"}]),
                         _emission(realism=2.0),
                         _emission(confidence=0.1)):
            expected = review.acceptance_fields(review.evaluate(emission))
            expected["defectCodes"] = sorted(expected["defectCodes"])
            self.assertEqual(qual.decision_from_review(emission), expected)

    def test_vocabulary_and_thresholds_are_the_contracts_own(self):
        self.assertEqual(qual.DEFECT_CODES, tuple(review.CODES))
        self.assertEqual(qual.REVIEW_VERSION, review.REVIEW_VERSION)
        self.assertEqual(qual.CONTRACT_SHA256, review.CONTRACT_SHA256)
        self.assertEqual(qual.CONTRACT_VERSION, review.CONTRACT_VERSION)
        self.assertEqual((qual.REALISM_MIN, qual.CONFIDENCE_MIN),
                         (review.REALISM_MIN, review.CONFIDENCE_MIN))
        self.assertEqual(qual.contract_binding(),
                         {"version": review.CONTRACT_VERSION, "sha256": review.CONTRACT_SHA256,
                          "reviewVersion": review.REVIEW_VERSION})

    def test_decisions_that_contradict_the_contract_are_refused(self):
        with self.assertRaisesRegex(qual.QualificationError, "cannot also be accepted"):
            qual.normalize_decision({"semanticAccepted": True, "presentationAccepted": False,
                                     "defectCodes": ["judge.uncertain"],
                                     "unsupportedReason": "no crossing primitive"})
        with self.assertRaisesRegex(qual.QualificationError, "outside the contract namespaces"):
            qual.normalize_decision({"semanticAccepted": False, "presentationAccepted": False,
                                     "defectCodes": ["mechanism-mismatch"], "unsupportedReason": None})
        with self.assertRaisesRegex(qual.QualificationError, "blocking defect code"):
            qual.normalize_decision({"semanticAccepted": True, "presentationAccepted": False,
                                     "defectCodes": ["scenario.mechanism"], "unsupportedReason": None})
        with self.assertRaisesRegex(qual.QualificationError, "scenario itself was rejected"):
            qual.normalize_decision({"semanticAccepted": False, "presentationAccepted": True,
                                     "defectCodes": [], "unsupportedReason": None})

    def test_deterministic_stage_codes_are_contract_evidence(self):
        # The deterministic stages extend the contract's namespaces; those codes are
        # evidence, and only a code outside every namespace is refused.
        for code in ("simulation.collision.contract_violation", "render.camera.composition_failed",
                     "scenario.no_eligible_simulation", "scenario.gate"):
            self.assertTrue(review.is_contract_code(code), code)
            self.assertEqual(qual.normalize_decision(
                {"semanticAccepted": False, "presentationAccepted": False,
                 "defectCodes": [code], "unsupportedReason": None})["defectCodes"], [code])
        self.assertFalse(review.is_contract_code("legacy.collision"))
        self.assertFalse(review.is_contract_code("scenario."))


class StaleContractTest(unittest.TestCase):
    """A superseded contract can never be read as a current verdict."""

    V4 = {"cellId": "cell-a", "version": "showcase-3d-product-review-v4", "mechanismFidelity": "yes",
          "visualGrounding": "pass", "actorFidelity": "pass", "eventSequence": "pass",
          "plausible": True, "realism": 8.0, "confidence": 0.9, "defects": [],
          "explanation": "the requested mechanism happens on camera"}

    def test_v4_reviewer_emission_is_refused(self):
        with self.assertRaisesRegex(qual.QualificationError, "showcase-3d-product-review-v4"):
            qual.decision_from_review(self.V4)

    def test_an_emission_without_contract_identity_is_refused(self):
        anonymous = {key: value for key, value in self.V4.items() if key != "version"}
        with self.assertRaisesRegex(qual.QualificationError, "no review contract identity"):
            qual.decision_from_review(anonymous)

    def test_a_judge_document_from_a_superseded_contract_is_refused(self):
        superseded = _judge_document([_judged_cell("cell-a", _emission())],
                                     contract={**review.contract_identity(), "sha256": "0" * 64})
        with self.assertRaisesRegex(qual.QualificationError, "names review contract hash"):
            qual.attempt_outcome({"number": 1, "status": "complete"}, judge=superseded)

    def test_a_product_decision_from_a_superseded_contract_is_refused(self):
        stale = _product_document([_judged_cell("cell-a", _emission())],
                                  contract={"version": "showcase-acceptance-contract-v0",
                                            "sha256": "0" * 64,
                                            "reviewVersion": "showcase-3d-product-review-v4"})
        with self.assertRaisesRegex(qual.QualificationError, "showcase-3d-product-review-v4"):
            qual.attempt_outcome({"number": 1, "status": "complete"}, product=stale)

    def test_a_gold_manifest_bound_to_v4_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entry = _write_evidence(root, "cell-a", b"footage-a")
            v4 = {"fields": list(qual.DECISION_FIELDS),
                  "defectCodes": ["actor-mismatch", "grounding-failure", "implausible", "low-realism",
                                  "mechanism-mismatch", "sequence-mismatch", "unsupported",
                                  "visible-defect"],
                  "reviewVersion": "showcase-3d-product-review-v4", "realismMin": 6.0}
            with self.assertRaisesRegex(qual.QualificationError, "showcase-3d-product-review-v4"):
                qual.load_gold(_seal(root, [entry], v4), root)

    def test_a_manifest_missing_the_contract_hash_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entry = _write_evidence(root, "cell-a", b"footage-a")
            unbound = {key: value for key, value in qual.gold_contract_block().items() if key != "sha256"}
            with self.assertRaisesRegex(qual.QualificationError, "names review contract hash"):
                qual.load_gold(_seal(root, [entry], unbound), root)

    def test_labels_survive_a_reseal_without_being_re_expressed(self):
        # Resealing binds new contract metadata; it must not invent, translate, or
        # drop a human decision.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            labelled = {**_write_evidence(root, "cell-a", b"footage-a"),
                        "label": _human_label(True, True)}
            unlabelled = _write_evidence(root, "cell-b", b"footage-b")
            path = _seal(root, [labelled, unlabelled])
            carried = qual.carried_gold_labels(path)
            self.assertEqual(carried[labelled["video"]["sha256"]]["label"],
                             {"labeler": "hana.ito", "labeledAt": "2026-08-18T09:00:00Z",
                              "semanticAccepted": True, "presentationAccepted": True,
                              "defectCodes": [], "unsupportedReason": None})
            self.assertIsNone(carried[unlabelled["video"]["sha256"]]["label"])
            manifest = json.loads(path.read_text())
            manifest["reviewContract"] = {**qual.gold_contract_block(), "sha256": "0" * 64}
            manifest["manifestSha256"] = qual.gold_seal(manifest)
            resealed = root / "resealed.json"
            qual.dump_json(resealed, manifest)
            # The predecessor is readable for its labels even though it is not current.
            self.assertEqual(qual.carried_gold_labels(resealed), carried)
            with self.assertRaisesRegex(qual.QualificationError, "names review contract hash"):
                qual.load_gold(resealed, root)

    def test_a_label_in_a_superseded_vocabulary_is_refused_not_translated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entry = {**_write_evidence(root, "cell-a", b"footage-a"),
                     "label": _human_label(False, False, ["mechanism-mismatch"])}
            with self.assertRaisesRegex(qual.QualificationError, "outside the contract namespaces"):
                qual.carried_gold_labels(_seal(root, [entry]))


class GoldManifestTest(unittest.TestCase):
    def test_hash_mismatch_and_missing_evidence_fail_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entry = _write_evidence(root, "cell-a", b"footage-a")
            path = _seal(root, [entry])
            self.assertEqual(len(qual.load_gold(path, root)["entries"]), 1)
            (root / entry["video"]["file"]).write_bytes(b"footage-a-edited")
            with self.assertRaisesRegex(qual.QualificationError, "digest mismatch"):
                qual.load_gold(path, root)
            (root / entry["video"]["file"]).unlink()
            with self.assertRaisesRegex(qual.QualificationError, "evidence is missing"):
                qual.load_gold(path, root)

    def test_seal_makes_the_manifest_immutable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = _seal(root, [_write_evidence(root, "cell-a", b"footage-a")])
            manifest = json.loads(path.read_text())
            manifest["entries"][0]["label"] = _human_label(True)
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(qual.QualificationError, "immutable"):
                qual.load_gold(path, root)

    def test_model_generated_labels_cannot_be_calibrated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            entry = _write_evidence(root, "cell-a", b"footage-a")
            for inferred, message in (
                ({**_human_label(True), "model": "gpt-5.6-sol", "confidence": 0.9}, "model provenance"),
                ({**_human_label(True), "contract": review.contract_identity()}, "model provenance"),
                ({**_human_label(True), "acceptance": {"tier": "3d"}}, "model provenance"),
                ({**_human_label(True), "labeler": "gpt-5.6-sol"}, "names a model"),
            ):
                with self.assertRaisesRegex(qual.QualificationError, message):
                    qual.load_gold(_seal(root, [{**entry, "label": inferred}]), root)
            manifest = json.loads(_seal(root, [{**entry, "label": _human_label(True)}]).read_text())
            manifest["labelProvenance"] = "model"
            path = root / "inferred.json"
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(qual.QualificationError, "labelProvenance must be human"):
                qual.load_gold(path, root)

    def test_unsupported_entries_are_recorded_but_not_calibrated(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            supported = {**_write_evidence(root, "cell-a", b"footage-a"), "label": _human_label(True)}
            unsupported = {**_write_evidence(root, "cell-b", b"footage-b"),
                           "label": _human_label(False, False, ["judge.uncertain"],
                                                 "no reversible-lane primitive")}
            manifest = qual.load_gold(_seal(root, [supported, unsupported]), root)
            self.assertEqual(sorted(entry["evidenceId"] for entry in manifest["entries"]), ["cell-a", "cell-b"])
            self.assertEqual([entry["evidenceId"] for entry in qual.eligible_gold(manifest).values()], ["cell-a"])
            with self.assertRaisesRegex(qual.QualificationError, "human labels"):
                qual.build_calibration({**manifest, "labelProvenance": "model"}, [], 3)


class CalibrationTest(unittest.TestCase):
    @staticmethod
    def _review(digest, repetition, semantic_accepted, realism, presentation=True):
        return {"videoSha256": digest, "repetition": repetition, "reviewVersion": qual.REVIEW_VERSION,
                "contractVersion": qual.CONTRACT_VERSION, "contractSha256": qual.CONTRACT_SHA256,
                "realism": realism, "semanticAccepted": semantic_accepted,
                "presentationAccepted": semantic_accepted and presentation,
                "defectCodes": [] if semantic_accepted else ["scenario.mechanism"],
                "unsupportedReason": None}

    def test_repeated_rows_project_the_canonical_evaluator_output(self):
        emission = _emission(defects=[{"code": "render.camera.framing", "text": "event is cropped"}])
        row = qual.review_row(emission, gold_sha256="f" * 64, evidence_id="cell-a",
                              video_sha256="a" * 64, repetition=2)
        self.assertEqual(row["contractSha256"], review.CONTRACT_SHA256)
        self.assertEqual(row["contractVersion"], review.CONTRACT_VERSION)
        self.assertEqual(row["reviewVersion"], review.REVIEW_VERSION)
        self.assertEqual(row["realism"], 8.0)
        self.assertEqual(row["defectCodes"], ["render.camera.framing"])
        self.assertEqual({field: row[field] for field in qual.DECISION_FIELDS},
                         qual.decision_from_review(emission))
        # Semantics survive a presentation defect; the contract decides both separately.
        self.assertTrue(row["semanticAccepted"])
        self.assertFalse(row["presentationAccepted"])

    def test_repetitions_group_by_evidence_digest_not_by_name(self):
        digest_a, digest_b = "a" * 64, "b" * 64
        reviews = [self._review(digest_a, n, True, 8.0) for n in (1, 2, 3)]
        reviews += [self._review(digest_b, n, False, 4.0) for n in (1, 2, 3)]
        groups = qual.group_reviews_by_evidence(reviews, 3)
        self.assertEqual(sorted(groups), [digest_a, digest_b])
        self.assertEqual([len(items) for items in groups.values()], [3, 3])
        with self.assertRaisesRegex(qual.QualificationError, "exactly 3"):
            qual.group_reviews_by_evidence(reviews[:-1], 3)

    def test_mixed_contract_hashes_are_refused(self):
        digest = "a" * 64
        reviews = [self._review(digest, n, True, 8.0) for n in (1, 2, 3)]
        reviews[2] = {**reviews[2], "contractSha256": "0" * 64}
        with self.assertRaisesRegex(qual.QualificationError, "names review contract hash"):
            qual.group_reviews_by_evidence(reviews, 3)
        reviews[2] = {**reviews[2], "contractSha256": qual.CONTRACT_SHA256,
                      "reviewVersion": "showcase-3d-product-review-v4"}
        with self.assertRaisesRegex(qual.QualificationError, "showcase-3d-product-review-v4"):
            qual.group_reviews_by_evidence(reviews, 3)

    def test_confusion_flip_and_realism_spread(self):
        digest_a, digest_b = "a" * 64, "b" * 64
        gold = {digest_a: {"label": _human_label(True)}, digest_b: {"label": _human_label(False, False)}}
        groups = qual.group_reviews_by_evidence(
            [self._review(digest_a, 1, True, 8.0), self._review(digest_a, 2, True, 8.0),
             self._review(digest_a, 3, False, 5.0),
             self._review(digest_b, 1, False, 3.0), self._review(digest_b, 2, False, 3.0),
             self._review(digest_b, 3, False, 3.0)], 3)
        matrix = qual.confusion_matrix(gold, groups, "semanticAccepted")
        self.assertEqual([matrix["truePositive"], matrix["falseNegative"],
                          matrix["falsePositive"], matrix["trueNegative"]], [2, 1, 0, 3])
        self.assertEqual(matrix["falsePositiveRate"], 0.0)
        self.assertEqual(round(matrix["falseNegativeRate"], 4), 0.3333)
        flips = qual.flip_rates(groups)
        self.assertEqual(flips["rate"], 0.5)
        self.assertEqual(flips["byField"]["semanticAccepted"]["flipped"], 1)
        self.assertEqual(flips["byField"]["presentationAccepted"]["flipped"], 1)
        realism = qual.realism_dispersion(groups)
        self.assertEqual(realism["byEvidence"][digest_b], 0.0)
        self.assertGreater(realism["byEvidence"][digest_a], 0.0)
        self.assertEqual(realism["maxSd"], realism["byEvidence"][digest_a])


class StageListTest(unittest.TestCase):
    """The stage lists must name the artifacts the integrated pipeline writes."""

    def test_stage_list_is_the_integrated_pipeline(self):
        self.assertEqual(qual.STAGES, (
            "00-brief", "10-route", "15-precheck", "20-author", "30-sites", "40-cells", "50-gate",
            "55-eligibility", "60-render2d", "62-semantic2d",
            "62-mutation-01", "62-mutation-02", "62-fallback-author",
            "65-render3d", "70-judge", "75-product",
            "80-presentation-retry", "80-reauthor-01", "90-gallery", "95-benchmark"))
        self.assertNotIn("80-repair", qual.STAGES)
        self.assertEqual(qual.OPTIONAL_STAGES, (
            "62-mutation-01", "62-mutation-02", "62-fallback-author",
            "80-presentation-retry", "80-reauthor-01"))
        self.assertEqual(qual.REQUIRED_STAGES,
                         tuple(stage for stage in qual.STAGES if stage not in qual.OPTIONAL_STAGES))
        self.assertEqual(qual.STAGE_OUTCOMES,
                         ("pending", "running", "reused", "complete", "skipped", "failed", "error"))

    def test_committed_breadth_config_declares_those_exact_stages(self):
        config = json.loads((REPO / "apps/showcase/campaigns/breadth.json").read_text())
        self.assertEqual(config["stages"], list(qual.STAGES))
        self.assertEqual(config["requiredStages"], list(qual.REQUIRED_STAGES))
        self.assertEqual(config["stageOutcomeVocabulary"], list(qual.STAGE_OUTCOMES))
        for override, message in (({"requiredStages": list(qual.STAGES)}, "optional retry branches"),
                                  ({"stages": list(qual.STAGES)[:-1]}, "exact showcase pipeline stages"),
                                  ({"stageOutcomeVocabulary": ["pending"]}, "stageOutcomeVocabulary")):
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "breadth.json"
                path.write_text(json.dumps({**config, **override}))
                with self.assertRaisesRegex(qual.QualificationError, message):
                    qual.load_breadth(path)

    def test_attempt_records_report_stages_in_the_current_vocabulary(self):
        facts = qual.attempt_record_facts(_attempt_record(
            stages=(("55-eligibility", "complete"), ("70-judge", "reused"),
                    ("80-reauthor", "failed"), ("75-product", "complete"))))
        self.assertEqual(facts["stageOutcomes"], {"55-eligibility": "complete", "70-judge": "reused",
                                                 "80-reauthor-01": "failed", "75-product": "complete"})
        self.assertEqual(facts["furthestStage"], "presentation")
        self.assertEqual(facts["attemptRecord"], qual.ATTEMPT_RECORD_SCHEMA)
        with self.assertRaisesRegex(qual.QualificationError, "not a stage outcome"):
            qual.attempt_record_facts(_attempt_record(stages=(("70-judge", "cached"),)))
        with self.assertRaisesRegex(qual.QualificationError, "not a pipeline stage"):
            qual.attempt_record_facts(_attempt_record(stages=(("80-repair", "complete"),)))
        with self.assertRaisesRegex(qual.QualificationError, "is not showcase-benchmark-attempt"):
            qual.attempt_record_facts({"schema": "showcase-benchmark-attempt/v0", "funnel": {}})


class BreadthAndQualificationConfigTest(unittest.TestCase):
    def test_committed_breadth_config_covers_every_campaign_case(self):
        breadth = qual.load_breadth(REPO / "apps/showcase/campaigns/breadth.json")
        campaign = qual.load_json(REPO / "apps/showcase/campaigns/edge-cases.json")
        expected = [case["id"] for case in campaign["cases"]]
        self.assertEqual(len(expected), 67)
        self.assertEqual(breadth["caseIds"], expected)
        self.assertEqual(breadth["caseCount"], 67)
        self.assertEqual(len(set(breadth["caseIds"])), 67)
        for case in breadth["cases"]:
            self.assertEqual(sorted(case["stageOutcomes"]), sorted(qual.STAGES))
            self.assertEqual(set(case["stageOutcomes"].values()), {"pending"})

    def test_committed_qualification_config_declares_the_exact_thresholds(self):
        breadth = qual.load_breadth(REPO / "apps/showcase/campaigns/breadth.json")
        config = qual.load_qualification(REPO / "apps/showcase/campaigns/qualification.json", breadth)
        self.assertEqual(config["caseIds"], ["blocked-normal-path", "unprotected-left-dense", "crossing-VRU"])
        self.assertEqual(config["attemptsPerCase"], 10)
        self.assertEqual(config["exit"], {"semanticYieldMin": 0.3, "casesMeetingYieldMin": 2,
                                          "reviewerFlipRateMax": 0.15, "maxOperationalFailures": 0,
                                          "reviewRepetitions": 3, "minimumGoldLabels": 12})
        self.assertEqual(config["reviewContract"], qual.contract_binding())
        for case in config["cases"]:
            self.assertIn(case["breadthCaseId"], breadth["caseIds"])

    def test_qualification_config_bound_to_a_superseded_contract_fails_closed(self):
        breadth = qual.load_breadth(REPO / "apps/showcase/campaigns/breadth.json")
        config = json.loads((REPO / "apps/showcase/campaigns/qualification.json").read_text())
        config["reviewContract"] = {"version": "showcase-acceptance-contract-v1", "sha256": "0" * 64,
                                    "reviewVersion": "showcase-3d-product-review-v4"}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "qualification.json"
            path.write_text(json.dumps(config))
            with self.assertRaisesRegex(qual.QualificationError, "showcase-3d-product-review-v4"):
                qual.load_qualification(path, breadth)

    def test_qualification_case_outside_the_breadth_set_fails_closed(self):
        breadth = qual.load_breadth(REPO / "apps/showcase/campaigns/breadth.json")
        config = json.loads((REPO / "apps/showcase/campaigns/qualification.json").read_text())
        config["cases"][2]["breadthCaseId"] = "not-a-real-case"
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "qualification.json"
            path.write_text(json.dumps(config))
            with self.assertRaisesRegex(qual.QualificationError, "not in the breadth config"):
                qual.load_qualification(path, breadth)

    def test_committed_gold_manifest_matches_the_committed_bytes(self):
        manifest = qual.load_gold(REPO / "apps/showcase/campaigns/reviewer-gold.json", REPO)
        self.assertEqual(len(manifest["entries"]), 24)
        self.assertTrue(all(entry["video"]["file"].endswith("rollout.mp4") for entry in manifest["entries"]))
        self.assertEqual(manifest["reviewContract"], qual.gold_contract_block())
        # Nothing in this cutover invented a human label.
        self.assertEqual([entry["evidenceId"] for entry in manifest["entries"] if entry["label"]], [])


class ProductAuthorityTest(unittest.TestCase):
    """`75-product.json` is the deliverable decision; nothing outranks it."""

    ATTEMPT = {"number": 1, "status": "complete", "jobId": "job-1"}

    def test_product_decision_outranks_the_judge_verdict(self):
        accepted = _judged_cell("cell-a", _emission())
        # The gate rejected this cell before any reviewer saw it, and topK rationed the
        # presentation: neither fact is expressible in the judge's own row.
        product = _product_document([{**accepted, "semanticAccepted": False,
                                      "presentationAccepted": False,
                                      "defectCodes": ["scenario.gate"]}])
        row = qual.attempt_outcome(self.ATTEMPT, product=product,
                                   judge=_judge_document([accepted]),
                                   record=_attempt_record("3d-ok"))
        self.assertEqual(row["evidence"], "75-product.json")
        self.assertEqual(row["outcome"], "semantic-rejected")
        self.assertEqual(row["defectCodes"], ["scenario.gate"])
        self.assertFalse(row["decision"]["semanticAccepted"])

    def test_judge_is_read_only_when_no_product_decision_exists(self):
        row = qual.attempt_outcome(self.ATTEMPT,
                                   judge=_judge_document([_judged_cell("cell-a", _emission())]),
                                   record=_attempt_record())
        self.assertEqual(row["evidence"], "70-judge.json")
        self.assertEqual(row["outcome"], "semantic-accepted")
        self.assertTrue(row["decision"]["presentationAccepted"])
        self.assertEqual(row["furthestStage"], "presentation")

    def test_a_promoted_retry_is_reported_from_the_product_decision(self):
        cell = _judged_cell("cell-a", _emission())
        product = _product_document([{**cell, "renderDir": "80-presentation-retry/65-render3d/cell-a"}],
                                    acceptedAttempt="80-presentation-retry")
        row = qual.attempt_outcome(self.ATTEMPT, product=product, judge=_judge_document([cell]),
                                   record=_attempt_record(stages=(("80-presentation-retry", "complete"),
                                                                  ("75-product", "complete"))))
        self.assertEqual(row["outcome"], "semantic-accepted")
        self.assertEqual(row["acceptedAttempt"], "80-presentation-retry")
        self.assertEqual(row["renderDir"], "80-presentation-retry/65-render3d/cell-a")
        self.assertEqual(row["stageOutcomes"]["80-presentation-retry"], "complete")

    def test_the_shipped_cell_decides_an_attempt_with_mixed_cells(self):
        rejected = _judged_cell("cell-a", _emission(mechanismFidelity="no"))
        accepted = _judged_cell("cell-b", _emission())
        row = qual.attempt_outcome(self.ATTEMPT, product=_product_document([rejected, accepted]))
        self.assertEqual(row["outcome"], "semantic-accepted")
        self.assertEqual(row["renderDir"], "65-render3d/cell-b")
        # The rejected cell's codes stay visible as evidence beside the decision.
        self.assertEqual(row["defectCodes"], ["scenario.mechanism"])
        self.assertEqual(row["decision"]["defectCodes"], [])

    def test_a_skipped_review_is_operational_not_a_rejection(self):
        skipped = {"status": "skipped", "reason": "OpenAI gateway unavailable at 127.0.0.1:4141",
                   "contract": review.contract_identity(), "cells": []}
        row = qual.attempt_outcome(self.ATTEMPT, judge=skipped, record=_attempt_record("3d-ok"))
        self.assertEqual(row["outcome"], "operational-failure")
        self.assertIsNone(row["decision"])
        self.assertEqual(row["evidence"], "70-judge.json")

    def test_a_censored_attempt_record_keeps_the_attempt_out_of_the_yield(self):
        censored = _attempt_record("3d-ok", outcome={
            "kind": "operational-failure", "censoredAtStage": "semantic-3d", "failedStage": "70-judge",
            "operational": {"class": "model-access", "detail": "HTTP 429: rate_limit_error"}})
        row = qual.attempt_outcome(self.ATTEMPT, record=censored,
                                   product=_product_document([_judged_cell("cell-a", _emission())]))
        self.assertEqual(row["outcome"], "operational-failure")
        self.assertEqual(row["censoredAtStage"], "semantic-3d")
        self.assertIsNone(row["decision"])

    def test_unsupported_attempts_carry_no_manufactured_defect_code(self):
        row = qual.attempt_outcome({"number": 1, "status": "complete",
                                    "unsupportedReason": "no reversible-lane primitive"})
        self.assertEqual(row["outcome"], "unsupported")
        self.assertEqual(row["unsupportedReason"], "no reversible-lane primitive")
        self.assertIsNone(row["decision"])
        self.assertEqual(row["defectCodes"], [])

    def test_contract_reported_unsupported_evidence_is_representability_too(self):
        blind = _judged_cell("cell-a", _emission(confidence=0.1))
        row = qual.attempt_outcome(self.ATTEMPT, product=_product_document([blind]))
        self.assertEqual(row["outcome"], "unsupported")
        self.assertIsNotNone(row["unsupportedReason"])
        self.assertEqual(row["decision"]["defectCodes"], ["judge.uncertain"])


class ExitEvaluatorTest(unittest.TestCase):
    CALIBRATION = {"schema": qual.CALIBRATION_SCHEMA, "reviewContract": qual.contract_binding(),
                   "reviewVersion": qual.REVIEW_VERSION, "goldSha256": "0" * 64, "repetitions": 3,
                   "labelledEvidence": 12, "flip": {"rate": 0.08, "byField": {}},
                   "realism": {"meanSd": 0.4}}

    def _config(self):
        breadth = qual.load_breadth(REPO / "apps/showcase/campaigns/breadth.json")
        return qual.load_qualification(REPO / "apps/showcase/campaigns/qualification.json", breadth)

    @staticmethod
    def _outcomes(accepted, attempts=10, operational=0):
        rows = []
        for number in range(1, attempts + 1):
            if number <= operational:
                rows.append(qual.attempt_outcome({"number": number, "status": "failed"}))
                continue
            good = number <= operational + accepted
            cell = _judged_cell("cell-a", _emission(mechanismFidelity="yes" if good else "no",
                                                    realism=8.0 if good else 3.0))
            rows.append(qual.attempt_outcome(
                {"number": number, "status": "complete", "jobId": f"job-{number}"},
                product=_product_document([cell]),
                record=_attempt_record("presentation" if good else "3d-ok",
                                       stages=(("75-product", "complete"),))))
        return rows

    def test_operational_failures_are_not_semantic_verdicts(self):
        rows = self._outcomes(accepted=3, attempts=10, operational=2)
        summary = qual.summarize_case("blocked-normal-path", 10, rows)
        self.assertEqual(summary["operationalFailures"], 2)
        self.assertEqual(summary["countedAttempts"], 8)
        self.assertEqual(summary["semanticAccepted"], 3)
        self.assertEqual(summary["semanticYield"], 0.375)
        # The stage facts come from the attempt records, not from the decision.
        self.assertEqual(summary["attemptRecords"], 8)
        self.assertEqual(summary["productDecisions"], 8)
        self.assertEqual(summary["furthestStages"], {"3d-ok": 5, "presentation": 3})

    def test_two_of_three_cases_at_thirty_percent_qualifies(self):
        config = self._config()
        verdict = qual.evaluate_exit(config, self.CALIBRATION, {
            "blocked-normal-path": self._outcomes(accepted=3),
            "unprotected-left-dense": self._outcomes(accepted=5),
            "crossing-VRU": self._outcomes(accepted=1),
        })
        self.assertTrue(verdict["qualified"])
        self.assertEqual(verdict["exitCode"], 0)
        self.assertEqual(verdict["blockers"], [])
        self.assertEqual(verdict["reviewContract"], qual.contract_binding())
        self.assertEqual(verdict["totals"]["productDecisions"], 30)

    def test_one_case_at_yield_blocks_the_restart(self):
        config = self._config()
        verdict = qual.evaluate_exit(config, self.CALIBRATION, {
            "blocked-normal-path": self._outcomes(accepted=3),
            "unprotected-left-dense": self._outcomes(accepted=2),
            "crossing-VRU": self._outcomes(accepted=1),
        })
        self.assertFalse(verdict["qualified"])
        self.assertEqual(verdict["exitCode"], 2)
        self.assertEqual(verdict["blockers"], ["semantic-yield"])

    def test_flip_rate_and_operational_failures_block_independently(self):
        config = self._config()
        unstable = {**self.CALIBRATION, "flip": {"rate": 0.15, "byField": {}}}
        cases = {"blocked-normal-path": self._outcomes(accepted=5),
                 "unprotected-left-dense": self._outcomes(accepted=5),
                 "crossing-VRU": self._outcomes(accepted=5)}
        self.assertEqual(qual.evaluate_exit(config, unstable, cases)["blockers"], ["reviewer-flip"])
        degraded = dict(cases, **{"crossing-VRU": self._outcomes(accepted=5, operational=1)})
        self.assertEqual(qual.evaluate_exit(config, self.CALIBRATION, degraded)["blockers"],
                         ["operational-failures"])

    def test_insufficient_gold_labels_block_the_restart(self):
        config = self._config()
        thin = {**self.CALIBRATION, "labelledEvidence": 11}
        verdict = qual.evaluate_exit(config, thin, {
            "blocked-normal-path": self._outcomes(accepted=5),
            "unprotected-left-dense": self._outcomes(accepted=5),
            "crossing-VRU": self._outcomes(accepted=5),
        })
        self.assertEqual(verdict["blockers"], ["gold-labels"])

    def test_calibration_from_a_different_repetition_count_is_refused(self):
        config = self._config()
        with self.assertRaisesRegex(qual.QualificationError, "repetitions"):
            qual.evaluate_exit(config, {**self.CALIBRATION, "repetitions": 2},
                               {case: self._outcomes(accepted=5) for case in config["caseIds"]})

    def test_calibration_from_a_superseded_contract_is_refused(self):
        config = self._config()
        stale = {**self.CALIBRATION, "reviewContract": {**qual.contract_binding(), "sha256": "0" * 64}}
        with self.assertRaisesRegex(qual.QualificationError, "names review contract hash"):
            qual.evaluate_exit(config, stale,
                               {case: self._outcomes(accepted=5) for case in config["caseIds"]})

    def test_a_short_run_is_refused_rather_than_scored(self):
        config = self._config()
        with self.assertRaisesRegex(qual.QualificationError, "recorded 9 attempts"):
            qual.evaluate_exit(config, self.CALIBRATION, {
                "blocked-normal-path": self._outcomes(accepted=5, attempts=9),
                "unprotected-left-dense": self._outcomes(accepted=5),
                "crossing-VRU": self._outcomes(accepted=5),
            })

class ReviewFrameTimebaseTest(unittest.TestCase):
    def test_clipped_video_seeks_are_relative_to_clip_start(self):
        self.assertEqual(stages._video_seek_time(5.42, 5.42), 0.0)
        self.assertAlmostEqual(stages._video_seek_time(7.68, 5.42), 2.26)
        self.assertEqual(stages._video_seek_time(4.0, 5.42), 0.0)


class HumanGoldLabelCommandTest(unittest.TestCase):
    def test_human_patch_reseals_the_manifest(self):
        source = REPO / "apps/showcase/campaigns/reviewer-gold.json"
        with tempfile.TemporaryDirectory() as tmp:
            gold = Path(tmp) / "gold.json"
            gold.write_bytes(source.read_bytes())
            evidence_id = json.loads(gold.read_text())["entries"][0]["evidenceId"]
            patch = Path(tmp) / "labels.json"
            patch.write_text(json.dumps({"labels": [{
                "evidenceId": evidence_id,
                "label": {
                    "labeler": "reviewer@example.com",
                    "labeledAt": "2026-08-18T00:00:00Z",
                    "semanticAccepted": False,
                    "presentationAccepted": False,
                    "defectCodes": ["scenario.mechanism"],
                    "unsupportedReason": None,
                },
            }]}))
            with redirect_stdout(StringIO()):
                qualify_cli.label(SimpleNamespace(
                    root=str(REPO), gold=str(gold), labels=str(patch)))
            loaded = qual.load_gold(gold, REPO)
            self.assertEqual(loaded["entries"][0]["label"]["labeler"],
                             "reviewer@example.com")
            self.assertEqual(loaded["manifestSha256"], qual.gold_seal(loaded))

    def test_model_authored_patch_is_refused(self):
        source = REPO / "apps/showcase/campaigns/reviewer-gold.json"
        with tempfile.TemporaryDirectory() as tmp:
            gold = Path(tmp) / "gold.json"
            gold.write_bytes(source.read_bytes())
            evidence_id = json.loads(gold.read_text())["entries"][0]["evidenceId"]
            patch = Path(tmp) / "labels.json"
            patch.write_text(json.dumps([{
                "evidenceId": evidence_id,
                "label": {
                    "labeler": "gpt-5.6-sol",
                    "labeledAt": "2026-08-18T00:00:00Z",
                    "semanticAccepted": False,
                    "presentationAccepted": False,
                    "defectCodes": ["scenario.mechanism"],
                    "unsupportedReason": None,
                },
            }]))
            with self.assertRaisesRegex(qualify_cli.q.QualificationError, "names a model"):
                qualify_cli.label(SimpleNamespace(
                    root=str(REPO), gold=str(gold), labels=str(patch)))



def _story(item):
    return gallery._story_key(item["meta"])


if __name__ == "__main__":
    unittest.main()
