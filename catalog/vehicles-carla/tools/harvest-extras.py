#!/usr/bin/env python3
"""Merge static-mesh components harvested from cooked vehicle blueprint dumps."""
import json
from pathlib import Path
import re
import sys

extras_path = Path(sys.argv[1])
extras = json.loads(extras_path.read_text())
for assignment in sys.argv[2:]:
    catalog_id, dump_path = assignment.split("=", 1)
    components = []
    for exported in json.loads(Path(dump_path).read_text()):
        if exported.get("Type") != "StaticMeshComponent":
            continue
        props = exported.get("Properties", {})
        mesh_obj = props.get("StaticMesh") or {}
        match = re.search(r"'([^']+)'", mesh_obj.get("ObjectName", ""))
        if not match:
            continue
        mesh = match.group(1)
        if mesh.startswith("SM_sc_") or "PlagueDoll" in mesh:
            continue
        socket = None
        if mesh.endswith("Door_FL"):
            socket = "Door_L"
        elif mesh.endswith("Door_FR"):
            socket = "Door_R"
        location = props.get("RelativeLocation") or {}
        translation = [
            location.get("X", 0.0) / 100.0,
            location.get("Z", 0.0) / 100.0,
            location.get("Y", 0.0) / 100.0,
        ]
        overrides = []
        for value in props.get("OverrideMaterials") or []:
            override = re.search(r"'([^']+)'", (value or {}).get("ObjectName", ""))
            overrides.append(override.group(1) if override else None)
        components.append({"mesh": mesh, "socket": socket, "t": translation, "overrides": overrides})
    extras[catalog_id] = components
    print(f"{catalog_id}: {len(components)} components")
extras_path.write_text(json.dumps(extras, indent=1, sort_keys=True) + "\n")
