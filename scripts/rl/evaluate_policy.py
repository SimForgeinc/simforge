#!/usr/bin/env python3
"""Phase 3 held-out evaluation: trained PPO policy vs scripted-authoring baseline.

Protocol
- Held-out episode bank: scripts/rl/episodes/*-eval.json (disjoint seeds),
  served by the reactive-ambient shim.
- Arms, same episodes, same order:
    1. `baseline` — empty action every decision (authored choreography ego).
    2. `policy`   — deterministic PPO mean action each decision.
- Metrics per arm/class: mean episode return, collision rate, goal rate,
  mean length.
- Byte-replay verification: ≥3 policy episodes are re-run from reset with
  the recorded action channel; the stream digest (sha256 over sv ‖ bev ‖
  reward ‖ t bytes of every frame including reset) must be identical.

Outputs: runs/<name>/eval_report.json (+ stdout summary).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import struct
import subprocess
import time

import numpy as np
import torch

from env_client import EnvClient
from train_ppo import ACT_HALF_T, ACT_MID_T, Policy

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
MAX_STEPS = 1000


def ensure_server(socket_path: str, reward_json: str | None = None) -> subprocess.Popen | None:
    def alive() -> bool:
        if not pathlib.Path(socket_path).exists():
            return False
        try:
            import socket as pysocket

            probe = pysocket.socket(pysocket.AF_UNIX, pysocket.SOCK_STREAM)
            probe.settimeout(2)
            probe.connect(str(socket_path))
            probe.close()
            return True
        except OSError:
            pathlib.Path(socket_path).unlink(missing_ok=True)
            return False

    if alive():
        return None
    specs = sorted((HERE / "episodes").glob("*-eval.json"))
    cmd = [
        "node", str(HERE / "reactive-env-server.mjs"),
        "--episodes", ",".join(str(s) for s in specs),
        "--socket", socket_path, "--decision-hz", "5",
        *(["--reward", reward_json] if reward_json else []),
    ]
    proc = subprocess.Popen(cmd, cwd=str(REPO_ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 120
    while time.time() < deadline and not pathlib.Path(socket_path).exists():
        time.sleep(0.5)
    if not pathlib.Path(socket_path).exists():
        proc.terminate()
        raise RuntimeError("eval env server did not become ready")
    return proc


class Episode:
    def __init__(self, session: int, seed: str, kind: str, map_: str, site: str) -> None:
        self.session = session
        self.seed = seed
        self.kind = kind
        self.map = map_
        self.site = site


def build_episode_list(client: EnvClient) -> list[Episode]:
    eps: list[Episode] = []
    sid = 0
    for spec in sorted((HERE / "episodes").glob("*-eval.json")):
        doc = json.loads(spec.read_text())
        kind = "dartout" if spec.name.startswith("dartout") else "merge"
        for seed in doc["seeds"]:
            eps.append(Episode(sid, str(seed), kind, doc["map"], doc["site"]))
            sid += 1
    n = client.hello()["sessions"]
    assert sid == n, f"spec episodes {sid} != server sessions {n}"
    return eps


def _digest_frame(h, f: dict) -> None:
    h.update(f["sv"].astype("<f8").tobytes())
    if f["bev"] is not None:
        h.update(f["bev"].astype("<f4").tobytes())
    h.update(struct.pack("<d", float(f["reward"])))
    h.update(struct.pack("<d", float(f["t"])))


@torch.no_grad()
def run_episode(
    client: EnvClient,
    ep: Episode,
    policy: Policy | None,
    device: str,
    replay_actions: list[list[float]] | None = None,
):
    """One episode. policy=None → scripted baseline. Returns (stats, actions)."""
    f = client.reset(ep.session, ep.seed)
    h = hashlib.sha256()
    _digest_frame(h, f)
    total, steps = 0.0, 0
    collision = goal = False
    actions: list[list[float]] = []
    while True:
        if replay_actions is not None:
            speed, accel = replay_actions[steps]
        elif policy is not None:
            sv = torch.tensor((f["sv"] / np.array([100, 100, 1, 1, 15, 4, 3, 2, 100, 60])).astype(np.float32), device=device).unsqueeze(0)
            bev = torch.tensor(f["bev"].transpose(2, 0, 1), dtype=torch.float32, device=device).unsqueeze(0)
            raw = policy.raw_dist(sv, bev).mean
            sp = (ACT_MID_T + ACT_HALF_T * torch.tanh(raw))[0].cpu().numpy()
            speed, accel = float(sp[0]), float(sp[1])
        else:
            speed = accel = None
        actions.append([speed, accel])
        f = client.batch_step([(ep.session, None if speed is None else {
            "target_speed_mps": speed, "target_acceleration_mps2": accel})])[0]
        _digest_frame(h, f)
        total += f["reward"]
        steps += 1
        collision = collision or f["collision"]
        goal = goal or f["goal"]
        done = f["terminated"] or f["truncated"]
        if done or steps >= MAX_STEPS:
            break
    stats = {
        "return": round(total, 4), "length": steps, "collision": collision,
        "goal": goal, "terminated": bool(f["terminated"]), "digest": h.hexdigest(),
        "final_t": f["t"],
    }
    return stats, actions


def summarize(rows_by_arm: dict[str, list[dict]]) -> dict:
    out = {}
    for arm, rows in rows_by_arm.items():
        entry: dict[str, dict] = {}
        for label, sel in (("all", lambda r: True),
                           ("dartout", lambda r: r["kind"] == "dartout"),
                           ("merge", lambda r: r["kind"] == "merge"),
                           ("critical", lambda r: r.get("band") == "critical"),
                           ("trivially_safe", lambda r: r.get("band") == "trivially-safe"),
                           ("unavoidable", lambda r: r.get("band") == "unavoidable")):
            rs = [r for r in rows if sel(r)]
            if not rs:
                continue
            entry[label] = {
                "n": len(rs),
                "mean_return": round(float(np.mean([r["return"] for r in rs])), 3),
                "collision_rate": round(float(np.mean([r["collision"] for r in rs])), 3),
                "goal_rate": round(float(np.mean([r["goal"] for r in rs])), 3),
                "mean_length": round(float(np.mean([r["length"] for r in rs])), 1),
            }
        out[arm] = entry
    return out


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--socket", default="/tmp/rl-eval.sock")
    p.add_argument("--checkpoint", default=str(HERE / "runs/ppo-phase3-r2/policy.pt"))
    p.add_argument("--reward-json", default='{"progressWeight":0.1}',
                   help="must match the training run's reward config")
    p.add_argument("--bands", default=str(HERE / "bands.json"))
    p.add_argument("--out", default=str(HERE / "runs/ppo-phase3-r2/eval_report.json"))
    p.add_argument("--replay-count", type=int, default=3)
    args = p.parse_args()

    device = "cuda" if torch.cuda.is_available() else "cpu"
    policy = Policy().to(device)
    policy.load_state_dict(torch.load(args.checkpoint, map_location=device, weights_only=True))
    policy.eval()

    bands = {f"{r['kind']}|{r['map']}|{r['site']}|{r['seed']}": r
             for r in json.loads(pathlib.Path(args.bands).read_text())["rows"]}

    server = ensure_server(args.socket, args.reward_json)
    try:
        client = EnvClient(args.socket)
        episodes = build_episode_list(client)
        print(f"{len(episodes)} held-out episodes")

        arms: dict[str, list[dict]] = {"baseline": [], "policy": []}
        recorded: list[tuple[Episode, list[list[float]], str]] = []
        for arm in ("baseline", "policy"):
            for ep in episodes:
                stats, actions = run_episode(client, ep, policy if arm == "policy" else None, device)
                row = {**vars(ep), **stats,
                       "band": bands.get(f"{ep.kind}|{ep.map}|{ep.site}|{ep.seed}", {}).get("band")}
                arms[arm].append(row)
            s = summarize({arm: arms[arm]})
            print(f"[{arm}] {json.dumps(s[arm]['all'])} dartout={s[arm]['dartout']['mean_return']:.2f} merge={s[arm]['merge']['mean_return']:.2f}", flush=True)

        # ---- byte-replay verification of the first --replay-count policy episodes
        replays = []
        count = 0
        for row, ep in zip(arms["policy"], episodes):
            if count >= args.replay_count:
                break
            stats_ref, rec = run_episode(client, ep, policy, device)
            stats_replay, _ = run_episode(client, ep, policy, device, replay_actions=rec)
            replays.append({
                "kind": ep.kind, "map": ep.map, "site": ep.site, "seed": ep.seed,
                "digest_run1": stats_ref["digest"],
                "digest_replay": stats_replay["digest"],
                "match": stats_ref["digest"] == stats_replay["digest"]
                and stats_ref["length"] == stats_replay["length"],
            })
            count += 1
        replay_ok = all(r["match"] for r in replays)

        report = {
            "checkpoint": args.checkpoint,
            "held_out_episodes": len(episodes),
            "arms": summarize(arms),
            "byte_replay": {"verified": replay_ok, "episodes": replays},
            "per_episode": arms,
        }
        out = pathlib.Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, indent=1))
        print("\n== summary ==")
        print(json.dumps(report["arms"], indent=1))
        print("byte-replay:", "PASS" if replay_ok else "FAIL",
              f"({len(replays)} episodes)")
        client.close()
    finally:
        if server is not None:
            server.terminate()


if __name__ == "__main__":
    main()
