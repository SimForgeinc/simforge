#!/usr/bin/env python3
"""Band every episode-bank entry by catalog criticality.

For each (class, map, site, seed): `instantiate` → `simulate` (authored
choreography trace) → `uniscenarios evaluate --filter all`; record the
criticality band (`critical` / `trivially-safe` / `no-interaction` / …), the
scalar criticality (min TTC or PET inside the criticality window) and minTTC.

Output: scripts/rl/bands.json — the curriculum ordering input for training.
Note: banding traces are authored-choreography passes through the plain
engine; the reactive-ambient training env shares the same materialization
path, so the ordering is a proxy measured on the identical scenario inputs.
"""
from __future__ import annotations

import concurrent.futures as futures
import json
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parents[1]
CLI = REPO / "packages/cli/bin/uniscenarios.js"
SCRATCH = pathlib.Path("/tmp/rl-banding")
OUT = HERE / "bands.json"
WORKERS = 16


def episode_keys() -> list[dict]:
    keys = []
    for spec in sorted(HERE.glob("episodes/*.json")):
        doc = json.loads(spec.read_text())
        kind = "dartout" if spec.name.startswith("dartout") else "merge"
        split = "eval" if spec.name.endswith("eval.json") else "train"
        for seed in doc["seeds"]:
            keys.append(
                {
                    "kind": kind,
                    "split": split,
                    "map": doc["map"],
                    "site": doc["site"],
                    "seed": seed,
                }
            )
    return keys
def run_json(args: list[str], accept_codes=(0,)) -> dict:
    proc = subprocess.run(
        ["node", str(CLI), *args], capture_output=True, text=True, check=False
    )
    if proc.returncode not in accept_codes:
        raise RuntimeError(f"{' '.join(args)}\n{proc.stdout[-800:]}\n{proc.stderr[-800:]}")
    return json.loads(proc.stdout)




def band_one(key: dict) -> dict:
    SCRATCH.mkdir(parents=True, exist_ok=True)
    base = SCRATCH / f"{key['kind']}-{key['map']}-{key['site']}-{key['seed']}"
    inst_path = base.with_name(base.name + ".instance.json")
    trace_path = base.with_name(base.name + ".trace.json")
    template = (HERE / "episodes" / f"{key['kind']}-{key['map']}-{key['site']}-{'eval' if key['split']=='eval' else 'train'}.json")
    # resolve the spec's template path (relative to episodes/)
    spec_doc = json.loads(template.read_text())
    template_path = (HERE / "episodes" / spec_doc["template"]).resolve()
    run_json(
        [
            "instantiate",
            str(template_path),
            "--map", key["map"],
            "--site", key["site"],
            "--seed", key["seed"],
            "--out", str(inst_path),
        ]
    )
    proc = subprocess.run(
        ["node", str(CLI), "simulate", str(inst_path), "--trace", str(trace_path)],
        capture_output=True, text=True, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"simulate {base.name}: {proc.stdout[-500:]} {proc.stderr[-500:]}")
    # `evaluate` exits 2 ("validation findings") when its verdict is reject;
    # the JSON payload on stdout is still the authoritative result.
    ev = run_json(["evaluate", str(trace_path), "--filter", "all"], accept_codes=(0, 2))
    summary = ev.get("summary", {})
    return {
        **{k: key[k] for k in ("kind", "split", "map", "site", "seed")},
        "band": ev.get("band"),
        "verdict": ev.get("verdict"),
        "criticalityKind": summary.get("criticalityKind"),
        "criticality": summary.get("criticality"),
        "criticalityT": summary.get("criticalityT"),
        "minTTC": summary.get("minTTC"),
        "collisions": summary.get("collisions"),
    }


def main() -> None:
    keys = episode_keys()
    print(f"banding {len(keys)} episodes with {WORKERS} workers…", flush=True)
    rows: list[dict] = []
    errors = 0
    with futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futs = {pool.submit(band_one, k): k for k in keys}
        done = 0
        for fut in futures.as_completed(futs):
            k = futs[fut]
            try:
                rows.append(fut.result())
            except Exception as exc:  # noqa: BLE001 - record and continue
                errors += 1
                print(f"FAILED {k['kind']}/{k['map']}/{k['site']}/{k['seed']}: {exc}", file=sys.stderr)
            done += 1
            if done % 20 == 0:
                print(f"  {done}/{len(keys)}", flush=True)
    rows.sort(key=lambda r: (r["kind"], r["split"], r["map"], r["site"], r["seed"]))
    OUT.write_text(json.dumps({"rows": rows}, indent=1))
    from collections import Counter

    print("bands:", Counter(r["band"] for r in rows))
    print(f"errors: {errors}; wrote {OUT}")


if __name__ == "__main__":
    main()
