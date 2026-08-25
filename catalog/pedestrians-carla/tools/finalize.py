#!/usr/bin/env python3
"""Generate pedestrian catalog manifests from assembly-stats.json."""
import json
from pathlib import Path
import sys

root = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent)
stats = json.loads((root / "assembly-stats.json").read_text())
attribution = (
    '"{display}" pedestrian model © CARLA Simulator contributors (carla.org), '
    "CC BY 4.0; converted to glTF for SimForge."
)
manifest = {
    "version": 1,
    "source": "CARLA 0.10.0 UE5 cooked content",
    "license": "CC-BY-4.0",
    "pedestrians": stats,
}
entries = {}
assets = []
for blueprint, item in sorted(stats.items()):
    line = attribution.format(display=item["display"])
    entries[blueprint] = {
        "model": {
            "glbPath": f"catalog/pedestrians-carla/{item['file']}",
            "attribution": line,
            "source": "carla-0.10.0-ue5",
        },
        "tintable": False,
        "scaleToDims": False,
        "age": item["age"],
        "gender": item["gender"],
    }
    assets.append({
        "id": blueprint,
        "file": item["file"],
        "sourceMesh": item["sourceMesh"],
        "license": "CC-BY-4.0",
        "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
        "source": "CARLA 0.10.0 UE5 cooked content",
        "attribution": line,
        "modifications": [
            "exported from Unreal Engine cooked skeletal mesh",
            "converted to self-contained glTF 2.0 binary",
            "material textures embedded and PBR channels normalized",
            "skeleton and bind pose preserved",
        ],
    })
(root / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
(root / "catalog-models.json").write_text(json.dumps({"version": 1, "entries": entries}, indent=2, sort_keys=True) + "\n")
(root / "ATTRIBUTION.json").write_text(json.dumps({
    "catalog": "CARLA pedestrians for SimForge",
    "license": "CC-BY-4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "assets": assets,
}, indent=2, sort_keys=True) + "\n")
print(f"finalized {len(entries)} pedestrian catalog entries")
