"""CLI: run seeded policy_step episodes and write JSONL traces.

Example (from the repo root, after building @simforge/training-env):

    python -m simforge_policy_runner \
        --spec adapters/policy-runner/fixtures/synthetic-episode-dynamic.json \
        --policy torch --seed 42 --steps 30 --deadline-ms 50 \
        --fallback repeat-last --force-miss-at 13 --out /tmp/trace.jsonl
"""

from __future__ import annotations

import argparse
import json
import sys

from .policies import make_policy
from .protocol import PolicyServer
from .runner import run_episode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="simforge-policy-runner")
    parser.add_argument("--spec", required=True, help="episode spec JSON for the env-server")
    parser.add_argument("--session", type=int, default=0, help="env session index inside the spec")
    parser.add_argument("--policy", choices=("scripted", "trajectory", "torch"), default="scripted")
    parser.add_argument("--seed", default="42", help="episode seed (int or string)")
    parser.add_argument("--policy-seed", type=int, default=0, help="torch weight seed")
    parser.add_argument("--steps", type=int, default=30)
    parser.add_argument("--deadline-ms", type=float, default=50.0)
    parser.add_argument("--fallback", choices=("repeat-last", "zero-control", "scripted"), default="repeat-last")
    parser.add_argument("--force-miss-at", type=int, action="append", default=[], help="step index whose elapsedMs is forced over the deadline (repeatable)")
    parser.add_argument("--decision-hz", type=int, default=None)
    parser.add_argument("--out", default=None, help="trace JSONL path")
    args = parser.parse_args(argv)

    seed: int | str = int(args.seed) if args.seed.lstrip("-").isdigit() else args.seed
    policy = make_policy(args.policy, args.policy_seed)

    with PolicyServer(PolicyServer.default_command(args.spec, args.decision_hz)) as server:
        summary = run_episode(
            server,
            policy,
            session=args.session,
            seed=seed,
            deadline_ms=args.deadline_ms,
            fallback=args.fallback,
            max_steps=args.steps,
            force_miss_at=tuple(args.force_miss_at),
            trace_path=args.out,
        )
    json.dump(summary.__dict__, sys.stdout, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
