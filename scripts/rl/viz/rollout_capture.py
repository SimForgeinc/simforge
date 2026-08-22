#!/usr/bin/env python3
"""Rollout capture: baseline / mid / end policy on identical held-out episodes.

Runs each stage through the same EnvSession setup used by Phase-3 training
(reactive ambient traffic, BEV shim, decisionHz 5) via viz/capture-server.mjs,
recording per-decision actor poses, ego state, reward terms, TTC/proximity
minima, terminal flags, and the action taken → JSONL under viz/data/.

Stages:
  baseline — no action hook (authored choreography, actions = null)
  mid      — runs/ppo-phase3-r1/policy.pt   (+320k decisions)
  end      — runs/ppo-phase3-r2/policy.pt   (warm start, +240k decisions)

Determinism guard: the baseline rollout is executed twice per episode and the
two JSONL streams must match exactly, or capture aborts.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import numpy as np
import torch

HERE = pathlib.Path(__file__).resolve().parent
RL_DIR = HERE.parent
sys.path.insert(0, str(RL_DIR))

from train_ppo import ACT_MID_T, ACT_HALF_T, SV_SCALE, Policy  # noqa: E402

DATA_DIR = HERE / "data"
OUT_DIR = HERE / "out"
NODE = "node"

# One representative held-out episode per scenario class.
# Picked from bands.json criticality + r2 eval_report deltas.
EPISODES = [
    {
        "label": "critical-dartout",
        "bank": RL_DIR / "episodes/dartout-yale-street-5913fada2fca9e8a-eval.json",
        "seed": "9000",
        "kind": "dartout",
        "band": "critical",
        "note": "yale-street parked-row dart-out, criticality 1.071 s",
    },
    {
        "label": "critical-merge",
        "bank": RL_DIR / "episodes/merge-el-camino-road-356f47801fdae38d-eval.json",
        "seed": "9000",
        "kind": "merge",
        "band": "critical",
        "note": "el-camino-road merge-gap-collapse, critical band",
    },
    {
        "label": "moderate-dartout",
        "bank": RL_DIR / "episodes/dartout-yale-street-c8465165b9447d47-eval.json",
        "seed": "9000",
        "kind": "dartout",
        "band": "moderate (lowest accepted criticality 0.885)",
        "note": "yale-street dart-out, mildest accepted criticality",
    },
]

STAGES = [
    {"stage": "baseline", "checkpoint": None},
    {"stage": "mid", "checkpoint": RL_DIR / "runs/ppo-phase3-r1/policy.pt"},
    {"stage": "end", "checkpoint": RL_DIR / "runs/ppo-phase3-r2/policy.pt"},
]

MAX_DECISIONS = 1000


class CaptureSession:
    """NDJSON client for viz/capture-server.mjs."""

    def __init__(self, bank: pathlib.Path) -> None:
        self.proc = subprocess.Popen(
            [NODE, str(HERE / "capture-server.mjs"), "--episodes", str(bank)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        self._next_id = 0

    def _rpc(self, doc: dict) -> dict:
        doc = {"i": self._next_id, **doc}
        self._next_id += 1
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps(doc) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("capture-server died")
            res = json.loads(line)
            if res.get("i") != doc["i"]:
                continue
            if not res.get("ok"):
                raise RuntimeError(f"capture-server error: {res.get('e')}")
            return res["r"]

    def hello(self) -> dict:
        return self._rpc({"op": "hello"})

    def reset(self, seed: str) -> dict:
        return self._rpc({"op": "reset", "seed": seed})

    def step(self, action: dict | None) -> dict:
        return self._rpc({"op": "step", "a": action})

    def close(self) -> None:
        try:
            self._rpc({"op": "close"})
        except Exception:
            pass
        self.proc.terminate()


def load_policy(checkpoint: pathlib.Path, device: str) -> Policy:
    policy = Policy()
    state = torch.load(checkpoint, map_location=device, weights_only=True)
    policy.load_state_dict(state)
    policy.to(device).eval()
    return policy


@torch.no_grad()
def policy_action(policy: Policy, sv: np.ndarray, bev: np.ndarray, device: str) -> tuple[float, float]:
    sv_t = torch.tensor((sv / SV_SCALE).astype(np.float32), device=device).unsqueeze(0)
    bev_t = torch.tensor(bev.transpose(2, 0, 1), dtype=torch.float32, device=device).unsqueeze(0)
    raw = policy.raw_dist(sv_t, bev_t).mean
    sp = (ACT_MID_T + ACT_HALF_T * torch.tanh(raw))[0].cpu().numpy()
    return float(sp[0]), float(sp[1])


def decode_frame(frame: dict, statics: list[dict]) -> dict:
    """Wire frame → visualization record."""
    actors = {}
    for aid, x, y, h, v, a, present in frame["actors"]:
        meta = next(s for s in statics if s["id"] == aid)
        actors[aid] = {
            "x": x, "y": y, "headingRad": h,
            "speedMps": v, "accelMps2": a,
            "present": bool(present),
            "kind": meta["kind"], "dims": meta["dims"],
        }
    minima = frame["minima"]
    nearest = min((m["d"] for m in minima if m["d"] is not None), default=None)
    min_ttc = min((m["ttc"] for m in minima if m["ttc"] is not None), default=None)
    min_pet = min((m["pet"] for m in minima if m["pet"] is not None), default=None)
    return {
        "t": frame["t"],
        "decisions": frame["decisions"],
        "actors": actors,
        "reward": frame["rw"],
        "terms": frame["terms"],
        "collision": bool(frame["col"]),
        "goal": bool(frame["goal"]),
        "terminated": bool(frame["term"]),
        "truncated": bool(frame["trunc"]),
        "nearestDistanceM": nearest,
        "minTtcS": min_ttc,
        "minPetS": min_pet,
    }

def run_rollout(
    bank: pathlib.Path,
    seed: str,
    policy: Policy | None,
    device: str,
) -> tuple[list[dict], dict]:
    """One episode. policy=None → scripted-authoring baseline."""
    session = CaptureSession(bank)
    try:
        info = session.hello()
        statics = info["static"]
        frame = session.reset(seed)
        records: list[dict] = []
        cum_reward = 0.0
        while True:
            rec = decode_frame(frame, statics)
            rec["cumReward"] = round(cum_reward, 6)
            if policy is None:
                action, rec["action"] = None, None  # authored choreography
            else:
                speed, accel = policy_action(policy, np.array(frame["sv"]), np.array(frame["bev"]["d"]).reshape(frame["bev"]["h"], frame["bev"]["w"], frame["bev"]["c"]), device)
                action = {"ts": speed, "ta": accel}
                rec["action"] = {"targetSpeedMps": speed, "targetAccelerationMps2": accel}

            if frame["done"] or frame["decisions"] >= MAX_DECISIONS:
                break
            frame = session.step(action)
            cum_reward += frame["rw"]
            records.append(rec)
        summary = {
            "ego": info["ego"],
            "clipSeconds": info["clipSeconds"],
            "decisionHz": info["decisionHz"],
            "steps": len(records),
            "return": round(sum(r["reward"] for r in records), 4),
            "collision": any(r["collision"] for r in records),
            "goal": any(r["goal"] for r in records),
            "terminated": bool(frame["term"]),
            "finalT": records[-1]["t"] if records else None,
        }
        return records, summary
    finally:
        session.close()




def main() -> None:
    device = "cuda" if torch.cuda.is_available() else "cpu"
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    policies = {
        spec["stage"]: (None if spec["checkpoint"] is None else load_policy(spec["checkpoint"], device))
        for spec in STAGES
    }

    for ep in EPISODES:
        geo = capture_geometry(ep["bank"])
        (DATA_DIR / f"{ep['label']}__geometry.json").write_text(json.dumps(geo))
        print(f"geometry {ep['label']}: {len(geo['lanes'])} lanes")

        for spec in STAGES:
            out_path = DATA_DIR / f"{ep['label']}__{spec['stage']}.jsonl"
            records_a, summary_a = run_rollout(ep["bank"], ep["seed"], policies[spec["stage"]], device)
            records_b, summary_b = run_rollout(ep["bank"], ep["seed"], policies[spec["stage"]], device)
            if json.dumps(records_a, sort_keys=True) != json.dumps(records_b, sort_keys=True):
                raise SystemExit(
                    f"DETERMINISM FAILURE: {ep['label']} / {spec['stage']} rollouts differ across two runs"
                )
            print(f"ok {ep['label']:18s} {spec['stage']:8s} steps={summary_a['steps']:3d} "
                  f"return={summary_a['return']:9.3f} collision={summary_a['collision']} goal={summary_a['goal']}")
            with open(out_path.with_suffix(".tmp"), "w") as fh:
                fh.write(json.dumps({
                    "type": "meta",
                    "label": ep["label"],
                    "bank": ep["bank"].name,
                    "seed": ep["seed"],
                    "stage": spec["stage"],
                    "checkpoint": str(spec["checkpoint"]) if spec["checkpoint"] else None,
                    "kind": ep["kind"],
                    "band": ep["band"],
                    "note": ep["note"],
                    **summary_a,
                }) + "\n")
                for rec in records_a:
                    fh.write(json.dumps(rec) + "\n")
            out_path.with_suffix(".tmp").replace(out_path)
    print("capture complete →", DATA_DIR)

def capture_geometry(bank: pathlib.Path) -> dict:
    session = CaptureSession(bank)
    try:
        return session.hello()
    finally:
        session.close()


if __name__ == "__main__":
    main()
