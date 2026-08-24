"""Runner CLI.

Executes policies over the frozen policy-eval-suite.v1 and writes a
suite-hash-keyed report; with --baseline --gate it exits nonzero on
regression (exit 3).

    python3 -m policy_eval_runner \
      --repo-root /path/to/SimForge \
      [--checkpoint runs/ppo/policy.pt --rl-scripts-dir scripts/rl] \
      [--latency-ticks K --ego-noise-std S] \
      [--limit N] [--out report.json]
      [--baseline pinned.json --gate]

Arms: `authored` always; plus one arm per checkpoint when --checkpoint is
given. Perturbation flags add a paired perturbed variant of every arm
(suffixed +latK / +nsS), so clean and degraded numbers land in one report.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import time
from typing import Any

from .client import EvalEnvClient
from .metrics import aggregate, digest_frame, ego_minima, episode_record
from .perturb import EgoStateNoisePolicy, LatencyPolicy, episode_noise_seed
from .policies import AuthoredChoreographyPolicy, PpoPolicy, EvalPolicy
from .report import (
    EXIT_GATE_ERROR,
    EXIT_OK,
    EXIT_REGRESSION,
    build_report,
    check_regression,
)

MAX_DECISIONS = 1000


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="policy_eval_runner", description=__doc__)
    p.add_argument("--repo-root", required=True, help="worktree containing the suite + packages")
    p.add_argument("--suite", default="qualification/policy-eval-suite.v1.json")
    p.add_argument("--socket", default="/tmp/policy-eval-runner.sock")
    p.add_argument("--checkpoint", default=None, help="PPO checkpoint (.pt) from scripts/rl training")
    p.add_argument("--rl-scripts-dir", default=None, help="directory holding train_ppo.py (rl checkout)")
    p.add_argument("--limit", type=int, default=0, help="run only the first N suite entries (0 = all)")
    p.add_argument("--latency-ticks", type=int, default=0)
    p.add_argument("--ego-noise-std", type=float, default=0.0)
    p.add_argument("--out", default="policy-eval-report.json")
    p.add_argument("--baseline", default=None)
    p.add_argument("--gate", action="store_true", help="exit 3 on regression vs --baseline")
    return p.parse_args(argv)


def ensure_server(args: argparse.Namespace, suite_path: pathlib.Path) -> subprocess.Popen:
    socket_path = pathlib.Path(args.socket)
    if socket_path.exists():
        socket_path.unlink()
    server_js = pathlib.Path(args.repo_root) / "packages/evaluation/dist/eval-server.js"
    cmd = [
        "node", str(server_js),
        "--suite", str(suite_path),
        "--socket", str(socket_path),
    ]
    env = dict(os.environ)
    proc = subprocess.Popen(cmd, cwd=str(args.repo_root), stdout=sys.stderr, stderr=sys.stderr, env=env)
    deadline = time.time() + 300
    while time.time() < deadline:
        if socket_path.exists():
            try:
                probe = EvalEnvClient(socket_path)
                probe.close()
                return proc
            except OSError:
                pass
        if proc.poll() is not None:
            raise RuntimeError(f"eval server exited early with {proc.returncode}")
        time.sleep(0.5)
    proc.terminate()
    raise RuntimeError("eval server did not become ready in 300s")


def run_episode(
    client: EvalEnvClient,
    session: int,
    entry: dict[str, Any],
    ego: str,
    policy: EvalPolicy,
    suite_hash: str,
) -> dict[str, Any]:
    if hasattr(policy, "reset_episode"):
        policy.reset_episode(entry["entryId"])
    frame = client.reset(session, entry["seed"])
    digest = hashlib.sha256()
    digest_frame(digest, frame)
    total, steps = 0.0, 0
    collision = goal = False
    min_d = min_ttc = min_path = min_pet = float("inf")
    done = False
    while not done and steps < MAX_DECISIONS:
        action = policy.act(frame)
        frame = client.step(session, action)
        digest_frame(digest, frame)
        total += frame["reward"]
        steps += 1
        collision = collision or frame["collision"]
        goal = goal or frame["goal"]
        d, ttc, path_ttc, pet = ego_minima(frame, ego)
        min_d, min_ttc, min_path, min_pet = min(min_d, d), min(min_ttc, ttc), min(min_path, path_ttc), min(min_pet, pet)
        done = frame["terminated"] or frame["truncated"]
    meta = {
        "return": round(total, 4),
        "length": steps,
        "collision": collision,
        "goal": goal,
        "terminated": frame["terminated"],
        "truncated": frame["truncated"],
        "minDistanceM": None if min_d == float("inf") else round(min_d, 4),
        "minTtcS": None if min_ttc == float("inf") else round(min_ttc, 4),
        "minPathTtcS": None if min_path == float("inf") else round(min_path, 4),
        "minPetS": None if min_pet == float("inf") else round(min_pet, 4),
        "finalT": frame["t"],
        "digest": digest.hexdigest(),
    }
    return episode_record(entry, meta)


def build_arms(args: argparse.Namespace, suite_hash: str) -> list[EvalPolicy]:
    base: list[EvalPolicy] = [AuthoredChoreographyPolicy()]
    if args.checkpoint:
        rl_scripts_dir = args.rl_scripts_dir
        if rl_scripts_dir is None:
            raise SystemExit("--checkpoint requires --rl-scripts-dir (dir holding train_ppo.py)")
        base.append(PpoPolicy(args.checkpoint, rl_scripts_dir))
    arms: list[EvalPolicy] = []
    for policy in base:
        arms.append(policy)
        inner: EvalPolicy = policy
        if args.ego_noise_std > 0:
            # Noise seeding is per-arm; the per-episode salt is applied inside
            # the runner loop via reset_episode-style re-creation below.
            inner = _PerEpisodeNoise(policy, args.ego_noise_std, suite_hash, policy.name)
        if args.latency_ticks > 0:
            inner = LatencyPolicy(inner, args.latency_ticks)
        if inner is not policy:
            arms.append(inner)
    return arms


class _PerEpisodeNoise:
    """EgoStateNoisePolicy re-seeded per episode from the replay key."""

    def __init__(self, inner: EvalPolicy, std: float, suite_hash: str, arm_name: str) -> None:
        self.std = std
        self.suite_hash = suite_hash
        self.arm_name = arm_name
        self.base = inner
        self.inner: EvalPolicy | None = None

    def reset_episode(self, entry_id: str) -> None:
        seed = episode_noise_seed(self.suite_hash, self.arm_name, entry_id, f"ns{self.std:g}")
        assert self.base is not None
        self.inner = EgoStateNoisePolicy(self.base, self.std, seed)

    @property
    def name(self) -> str:
        return f"{self.arm_name}+ns{self.std:g}"

    def act(self, frame: dict[str, Any]) -> dict[str, float] | None:
        assert self.inner is not None
        return self.inner.act(frame)

    def close(self) -> None:
        pass


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = pathlib.Path(args.repo_root)
    suite_path = repo_root / args.suite if not pathlib.Path(args.suite).is_absolute() else pathlib.Path(args.suite)
    suite = json.loads(suite_path.read_text())
    entries = suite["entries"]
    if args.limit > 0:
        entries = entries[: args.limit]

    proc = ensure_server(args, suite_path)
    try:
        client = EvalEnvClient(args.socket)
        hello = client.hello()
        assert hello["suiteHash"] == suite["suiteHash"], "server serves a different suite!"
        egos = hello["egos"]

        arm_policies = build_arms(args, suite["suiteHash"])
        arms: dict[str, dict[str, Any]] = {}
        for policy in arm_policies:
            records = []
            for session_index, entry in enumerate(entries):
                if isinstance(policy, _PerEpisodeNoise):
                    policy.reset_episode(entry["entryId"])
                record = run_episode(client, session_index, entry, egos[session_index], policy, suite["suiteHash"])
                records.append(record)
            arms[policy.name] = aggregate(records)
            composite = arms[policy.name]["composite"]
            print(f"[{policy.name}] success={composite['successRate']} collisions={composite['microCollisionRate']} "
                  f"meanReturn={composite['meanReturn']} over {composite['episodes']} episodes", flush=True)
        client.close()
    finally:
        proc.terminate()

    report = build_report(
        suite=suite,
        arms=arms,
        checkpoint=args.checkpoint,
        perturbations={"latencyTicks": args.latency_ticks, "egoNoiseStd": args.ego_noise_std},
        entries_run=len(entries),
    )
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=1) + "\n")
    print(f"report → {out} (suite {suite['suiteHash'][:12]})")

    if args.gate:
        if not args.baseline:
            print("--gate requires --baseline", file=sys.stderr)
            return EXIT_GATE_ERROR
        passed, problems = check_regression(report, args.baseline)
        if passed:
            print(f"gate PASS vs {args.baseline}")
            return EXIT_OK
        print("gate FAIL:")
        for problem in problems:
            print(f"  - {problem}")
        return EXIT_REGRESSION
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
