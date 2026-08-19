#!/usr/bin/env python3
"""Deterministic brief-to-template obligations for showcase authoring."""
import copy
import math
import re


def derive_contract(brief, structures):
    text = brief["brief"].lower()
    obligations = []
    def add(kind, **detail):
        if not any(item["kind"] == kind for item in obligations):
            obligations.append({"kind": kind, **detail})
    if "junction_signalized" in structures: add("signalized_junction")
    elif "junction_any" in structures: add("junction")
    if "oncoming_lane" in structures or re.search(r"\boncoming|opposing\b", text): add("oncoming_actor")
    if re.search(r"\bleft turn|turn(?:s|ing)? left\b", text): add("ego_left_turn")
    if re.search(r"\bocclud|blocks? (?:the )?(?:ego(?:'s|’s) )?view|hidden|emerges? late|reveal", text):
        add("declared_occlusion", observer="ego", occluderCatalog="vehicle.suv" if "suv" in text else None, targetClass="motorcycle" if "motorcycl" in text else None)
    if re.search(r"lane[ -]?splitt|filter(?:s|ing)? between", text): add("lane_splitting_actor")
    if re.search(r"\bbrak(?:e|es|ing)|hard stop", text): add("ego_braking_response")
    if re.search(r"\bstop(?:s|ped|ping)? partially|partially across|comes? to a stop", text): add("ego_stop_response")
    if re.search(r"\bmotorcycl", text): add("actor_class", actorClass="motorcycle")
    if re.search(r"\bsuv\b", text): add("actor_catalog", catalog="vehicle.suv")
    if re.search(r"\bwithout collid|no collision|collision[- ]free", text): add("collision_free")
    return {"version": "showcase-semantic-contract-v1", "briefId": brief["id"], "structures": sorted(set(structures)), "obligations": obligations}

def complete_template(template):
    """Fill representation-owned safety invariants without inventing behavior."""
    completed = copy.deepcopy(template)
    if completed.get("invariants"):
        return completed, []
    role_ids = [role.get("id") for role in completed.get("roles", []) if role.get("id")]
    subject = completed.get("metricSubject")
    if subject not in role_ids:
        subject = "ego" if "ego" in role_ids else (role_ids[0] if role_ids else None)
    if subject is None:
        return completed, []
    invariant = {
        "id": "product-decel-budget",
        "kind": "decel_budget",
        "essentiality": "required",
        "of": subject,
        "maxMps2": 8,
    }
    completed["invariants"] = [invariant]
    return completed, [invariant]


def _required_value(value):
    if not isinstance(value, dict) or value.get("essentiality") != "required": return None
    return value.get("value")


def _features(template, kind):
    return [item for item in template.get("anchor", {}).get("features", []) if item.get("kind") == kind and item.get("essentiality") == "required"]


def _occlusions(template):
    for item in [*template.get("roles", []), *template.get("props", [])]:
        relation = item.get("occludes") or item.get("extensions", {}).get("occludes")
        if isinstance(relation, dict): yield item, relation


def validate_template(template, contract):
    failures = []
    roles = template.get("roles", [])
    role_by_id = {role.get("id"): role for role in roles}
    corridor = template.get("anchor", {}).get("corridor", {})
    junctions = _features(template, "junction")
    interactions = template.get("choreography", {}).get("interactions", [])
    for obligation in contract["obligations"]:
        kind, ok = obligation["kind"], True
        if kind == "signalized_junction": ok = any("signalized" in (_required_value(item.get("control")) or []) for item in junctions)
        elif kind == "junction": ok = bool(junctions)
        elif kind == "ego_left_turn": ok = any("left" in (_required_value(item.get("egoTurn")) or []) for item in junctions)
        elif kind == "oncoming_actor":
            ok = any(role.get("kind") == "conflicting_gate" and role.get("from") == "opposing" or abs(abs(float(role.get("headingOffsetRad", 0))) - math.pi) < 0.45 for role in roles if role.get("id") != "ego")
        elif kind == "declared_occlusion":
            ok = any(relation.get("observer") == obligation.get("observer", "ego") and relation.get("target") in role_by_id and (not obligation.get("occluderCatalog") or item.get("actor", {}).get("catalogId") == obligation["occluderCatalog"]) and (not obligation.get("targetClass") or role_by_id[relation["target"]].get("actor", {}).get("class") == obligation["targetClass"]) for item, relation in _occlusions(template))
        elif kind == "lane_splitting_actor":
            lane_count = _required_value(corridor.get("throughLanesOpposing")) or [0, 0]
            motorcycle = next((role for role in roles if role.get("actor", {}).get("class") == "motorcycle"), None)
            motion_boundary = any(item.get("actor") == motorcycle.get("id") and item.get("verb") == "laneOffset" and abs(float(item.get("target", {}).get("tFrac", 0))) >= 0.45 for item in interactions) if motorcycle else False
            boundary = motorcycle and (abs(float(motorcycle.get("tFrac", 0))) >= 0.45 or abs(float(motorcycle.get("lateralM", 0))) >= 1.2 or motion_boundary)
            ok = bool(lane_count[0] >= 2 and boundary)
        elif kind in ("ego_braking_response", "ego_stop_response"):
            ok = any(item.get("actor") == "ego" and item.get("verb") == "speed" and item.get("target", {}).get("mode") == "stop" and (item.get("trigger", {}).get("kind") != "at" or float(item.get("trigger", {}).get("t", 0)) > 0) for item in interactions)
        elif kind == "actor_class": ok = any(role.get("actor", {}).get("class") == obligation["actorClass"] for role in roles)
        elif kind == "actor_catalog": ok = any(role.get("actor", {}).get("catalogId") == obligation["catalog"] for role in roles)
        elif kind == "collision_free": ok = True
        if not ok: failures.append({"kind": kind, "reason": f"template does not execute required obligation: {kind}"})
    if float(template.get("choreography", {}).get("clipSeconds", 0)) < 20: failures.append({"kind": "minimum_clip", "reason": "clipSeconds must be at least 20"})
    if not template.get("invariants"): failures.append({"kind": "required_invariants", "reason": "template has no mechanism invariants"})
    return failures


def repair_prompt(contract, failures):
    lines = ["HARD EXECUTABLE CONTRACT. The emitted template is rejected unless every item is represented in executable fields, not merely repeated in meta.description:", *[f"- {item['kind']}: {item}" for item in contract["obligations"]], "- clipSeconds >= 20", "- at least one required mechanism invariant"]
    if failures: lines.extend(["PREVIOUS ATTEMPT FAILURES:", *[f"- {item['reason']}" for item in failures]])
    lines.append("Inspect, simulate, repair, and emit before the action budget expires. Never route around a missing mechanism.")
    return "\n".join(lines)
