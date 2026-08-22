"""Fetch raw corpus images listed in a built manifest into .corpus/images/.

- bdd10k items come from a public mirror of the BDD100K images
  (HuggingFace dataset ``dgural/bdd100k``, per-file ``data/<name>.jpg``;
  filenames are identical to the official det-10k release).
- nuscenes-camfront items are rsynced from simforge1's ungated v1.0-trainval
  CAM_FRONT sample directory.

Run AFTER bf-build-corpus produced the manifest (selection does not need the
images), then RE-RUN bf-build-corpus to fill in per-item sha256.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HF_BASE = "https://huggingface.co/datasets/dgural/bdd100k/resolve/main/data/"
NUSCENES_REMOTE = "ubuntu@216.151.21.122:real-corpus/nuscenes/samples/CAM_FRONT"


def fetch_bdd(items: list[dict], out_dir: Path, workers: int = 16) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    todo = [it for it in items if not (out_dir / it["image"]).exists()]
    print(f"[fetch] bdd10k: {len(todo)} to download")

    def one(it: dict) -> bool:
        dest = out_dir / it["image"]
        try:
            urllib.request.urlretrieve(HF_BASE + it["image"], dest)
            return True
        except Exception as e:  # noqa: BLE001 - report and continue
            print(f"[fetch] FAIL {it['image']}: {e}", file=sys.stderr)
            dest.unlink(missing_ok=True)
            return False

    ok = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for i, r in enumerate(ex.map(one, todo)):
            ok += r
            if (i + 1) % 200 == 0:
                print(f"[fetch] bdd10k {i + 1}/{len(todo)}")
    print(f"[fetch] bdd10k done: {ok}/{len(todo)}")
    return len(todo) - ok


def fetch_nuscenes(items: list[dict], out_dir: Path, remote: str) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    todo = [it["image"] for it in items if not (out_dir / it["image"]).exists()]
    if not todo:
        print("[fetch] nuscenes: nothing to do")
        return
    print(f"[fetch] nuscenes: rsyncing {len(todo)} files ...")
    listfile = out_dir / ".files.txt"
    listfile.write_text("\n".join(todo))
    subprocess.run(
        ["rsync", "-az", f"--files-from={listfile}", remote + "/", str(out_dir) + "/"],
        check=True,
    )
    print("[fetch] nuscenes done")

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--manifest", type=Path, required=True)
    ap.add_argument("--images-root", type=Path, required=True)
    ap.add_argument("--nuscenes-host", default=NUSCENES_REMOTE)
    args = ap.parse_args()
    manifest = json.loads(args.manifest.read_text())
    by_src: dict[str, list[dict]] = {}
    for it in manifest["items"]:
        by_src.setdefault(it["id"].split(":")[0], []).append(it)
    fail = 0
    if "bdd10k" in by_src:
        fail += fetch_bdd(by_src["bdd10k"], args.images_root / "bdd")
    if "nuscenes-camfront" in by_src:
        fetch_nuscenes(by_src["nuscenes-camfront"], args.images_root / "nuscenes", args.nuscenes_host)
    sys.exit(1 if fail else 0)


if __name__ == "__main__":
    main()
