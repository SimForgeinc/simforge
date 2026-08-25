#!/usr/bin/env python3
"""Deterministic replay assert: re-feed a bag's recorded action channel into a
fresh env-server session and compare trace digests.

Reads ``/simforge/episode`` (begin: seed + spec; end: recorded digest) and
``/simforge/applied_action`` (ordered canonical-JSON wire actions) from the
bag, replays them, and exits 0 iff the recomputed digest equals the recorded
one.

Usage: replay_assert.py <bag_dir> [--episodes SPEC]  (spec defaults to the
one recorded in the bag's begin event)
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from simforge_ros2_bridge.bag_io import read_bag  # noqa: E402
from simforge_ros2_bridge.env_client import EnvServerClient, default_server_command  # noqa: E402
from simforge_ros2_bridge.trace import TraceDigest  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bag", help="bag directory written by the bridge")
    parser.add_argument("--episodes", default=None, help="episode spec JSON (defaults to the recorded one)")
    args = parser.parse_args()

    begin: dict | None = None
    end: dict | None = None
    actions: list[dict] = []
    for topic, msg, _t_ns in read_bag(args.bag, ["/simforge/episode", "/simforge/applied_action"]):
        if topic == "/simforge/episode":
            event = json.loads(msg.data)
            if event["event"] == "begin":
                begin = event
            elif event["event"] == "end":
                end = event
        else:
            actions.append(json.loads(msg.data))

    if begin is None or end is None:
        print("bag is missing episode begin/end events", file=sys.stderr)
        return 2
    if len(actions) != end["ticks"]:
        print(f"bag holds {len(actions)} actions but episode ran {end['ticks']} ticks", file=sys.stderr)
        return 2

    spec = args.episodes or begin["episodes"]
    digest = TraceDigest()
    with EnvServerClient(default_server_command(spec)) as client:
        client.hello()
        frame = client.reset(begin["seed"], session=begin["session"])
        digest.update(frame)
        for action in actions:
            frame = client.step(action or None, session=begin["session"])
            digest.update(frame)

    recorded = end["digest"]
    replayed = digest.hexdigest()
    match = recorded == replayed
    print(f"recorded digest: {recorded}")
    print(f"replayed digest: {replayed}")
    print(f"frames hashed:   {digest.frames} (recorded {end['frames_hashed']})")
    print("REPLAY MATCH" if match else "REPLAY MISMATCH")
    return 0 if match else 1


if __name__ == "__main__":
    sys.exit(main())
