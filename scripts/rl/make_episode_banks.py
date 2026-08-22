#!/usr/bin/env python3
"""Materialize Phase 3 episode-bank spec files (env-server form B).

Two scenario classes with reactive ambient:

- dart-out : examples/cpnco-parked-row.template.json (child darts from between
             parked cars) on yale-street (exact sites) and
             easterbrook-discovery-school.
- merge    : examples/mechanisms/corridor/merge-gap-collapse.template.json on
             belmont-research-center and el-camino-road.

Train and held-out eval seeds are disjoint integer ranges so an eval seed can
never appear in training materialization.
"""
import json
import pathlib
import sys

DARTOUT_TEMPLATE = "../../../examples/cpnco-parked-row.template.json"
MERGE_TEMPLATE = "../../../examples/mechanisms/corridor/merge-gap-collapse.template.json"

REPO = pathlib.Path(__file__).resolve().parents[2]
OUT = pathlib.Path(__file__).resolve().parent / "episodes"


# siteId lists from `uniscenarios sites match` (verdict in parentheses).
DARTOUT_SITES = {
    "yale-street": [
        ("4783ce656e89ff59", "exact"),
        ("4b734228af447bad", "exact"),
        ("4e4d98758b8a8fd5", "exact"),
        ("5189fe9553c4a635", "exact"),
        ("5913fada2fca9e8a", "exact"),
        ("9c231a64d240c9ae", "exact"),
        ("c8465165b9447d47", "exact"),
    ],
    "easterbrook-discovery-school": [
        ("42d1a8ce33e0aefd", "degraded"),
        ("a071e3466c9b3f8e", "degraded"),
    ],
}
MERGE_SITES = {
    "belmont-research-center": [
        ("0ad5be6ac44af181", "exact"),
        ("b7e9b86ddb3218d9", "exact"),
    ],
    "el-camino-road": [
        ("356f47801fdae38d", "exact"),
        ("6605964bee9effe9", "exact"),
    ],
}

TRAIN_SEEDS_PER_SITE = list(range(2000, 2005))   # 5 seeds × site
EVAL_SEEDS_PER_SITE = list(range(9000, 9003))    # 3 disjoint held-out seeds


def write_specs(kind: str, template: str, sites: dict, tag: str) -> list[pathlib.Path]:
    seeds_by_split = {"train": TRAIN_SEEDS_PER_SITE, "eval": EVAL_SEEDS_PER_SITE}
    written = []
    for split, seeds in seeds_by_split.items():
        for map_id, entries in sites.items():
            for site_id, verdict in entries:
                spec = {
                    "template": template,
                    "map": map_id,
                    "site": site_id,
                    "seeds": [str(s) for s in seeds],
                }
                name = f"{kind}-{map_id}-{site_id}-{split}.json"
                path = OUT / name
                path.write_text(json.dumps(spec, indent=2) + "\n")
                written.append(path)
    return written


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    written = []
    written += write_specs("dartout", DARTOUT_TEMPLATE, DARTOUT_SITES, "dartout")
    written += write_specs("merge", MERGE_TEMPLATE, MERGE_SITES, "merge")
    n_train = sum(1 for p in written if p.name.endswith("train.json"))
    n_eval = len(written) - n_train
    print(f"wrote {len(written)} spec files ({n_train} train, {n_eval} eval) under {OUT}")


if __name__ == "__main__":
    sys.exit(main())
