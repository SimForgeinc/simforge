#!/usr/bin/env python3
"""Assemble CARLA walker skeletal exports into self-contained bind-pose GLBs."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import struct
import sys

EXPORT = Path(sys.argv[1])
BP_DUMPS = Path(sys.argv[2])
OUT = Path(sys.argv[3])
WALKER_PARAMETERS = Path(sys.argv[4])

vehicle_assembler = Path(__file__).resolve().parents[2] / "vehicles-carla" / "tools" / "assemble.py"
spec = importlib.util.spec_from_file_location("vehicle_assemble", vehicle_assembler)
base = importlib.util.module_from_spec(spec)
sys.argv = [str(vehicle_assembler), str(EXPORT), str(OUT)]
spec.loader.exec_module(base)


def object_name(value):
    if not isinstance(value, dict):
        return None
    match = re.search(r"'([^']+)'", value.get("ObjectName", ""))
    return match.group(1) if match else None


def blueprint_recipe(path):
    overrides = []
    for export in json.loads(path.read_text()):
        if export.get("Type") != "SkeletalMeshComponent":
            continue
        props = export.get("Properties", {})
        overrides = [object_name(value) for value in props.get("OverrideMaterials", [])]
        mesh = object_name(props.get("SkeletalMesh") or props.get("SkinnedAsset"))
        if mesh:
            return mesh, overrides
    stem = path.stem.removeprefix("BP_")
    candidates = [
        f"SK_{stem}",
        f"SK_{re.sub(r'_[B-D]_G', '_A_G', stem)}",
        f"SK_{re.sub(r'_A_G', '_G', stem)}",
    ]
    for mesh in candidates:
        if mesh in base.glbs:
            return mesh, overrides
    raise RuntimeError(f"no source skeletal mesh for {path}")


def accessor_bounds(doc):
    mins = []
    maxs = []
    for mesh in doc.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            accessor = doc["accessors"][primitive["attributes"]["POSITION"]]
            if "min" in accessor and "max" in accessor:
                mins.append(accessor["min"])
                maxs.append(accessor["max"])
    if not mins:
        return None, None
    low = [min(row[i] for row in mins) for i in range(3)]
    high = [max(row[i] for row in maxs) for i in range(3)]
    return low, high


def finish_glb(doc, binary):
    while len(binary) % 4:
        binary.append(0)
    doc["buffers"] = [{"byteLength": len(binary)}]
    encoded = json.dumps(doc, separators=(",", ":")).encode()
    while len(encoded) % 4:
        encoded += b" "
    length = 12 + 8 + len(encoded) + 8 + len(binary)
    return (
        struct.pack("<III", 0x46546C67, 2, length)
        + struct.pack("<II", len(encoded), 0x4E4F534A)
        + encoded
        + struct.pack("<II", len(binary), 0x004E4942)
        + bytes(binary)
    )


def assemble_walker(walker):
    walker_id = walker["Id"]
    bp_name = walker["Class"].split("/")[-1].split(".")[0]
    mesh_name, overrides = blueprint_recipe(BP_DUMPS / f"{bp_name}.json")
    source_path = base.glbs[mesh_name]
    doc, binary = base.read_glb(source_path)
    writer = base.GlbWriter()
    writer.buf = bytearray(binary)
    writer.views = list(doc.get("bufferViews", []))
    writer._matcache = {}
    material_map = {}
    original_materials = list(doc.get("materials", []))
    material_spec = {"body": [], "tintable": False, "id": f"pedestrian_{walker_id}"}
    for old_index, material in enumerate(original_materials):
        selected = overrides[old_index] if old_index < len(overrides) and overrides[old_index] else material.get("name")
        if selected not in base.mats:
            selected = material.get("name")
        material_map[old_index] = base.build_material(writer, selected, material_spec)
    for mesh in doc.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            if "material" in primitive:
                primitive["material"] = material_map[primitive["material"]]
    doc["materials"] = writer.materials
    doc["bufferViews"] = writer.views
    if writer.images:
        doc["images"] = writer.images
        doc["textures"] = writer.textures
        doc["samplers"] = writer.samplers
    doc.setdefault("asset", {})["generator"] = "simforge-carla-pedestrian-pipeline"
    doc["asset"]["extras"] = {
        "convention": "y-up, meters, +X forward, bind pose",
        "source": "CARLA (CC BY 4.0)",
        "id": f"walker.pedestrian.{walker_id}",
        "skeletonPreserved": True,
    }
    low, high = accessor_bounds(doc)
    output = finish_glb(doc, writer.buf)
    filename = f"pedestrian_{walker_id}.glb"
    (OUT / filename).write_bytes(output)
    dims = [round(high[i] - low[i], 4) for i in range(3)] if low else None
    return {
        "blueprint": f"walker.pedestrian.{walker_id}",
        "file": f"models/{filename}",
        "display": f"CARLA pedestrian {walker_id}",
        "gender": walker["Gender"].lower(),
        "age": walker["Age"].lower(),
        "generation": walker["Generation"],
        "sourceMesh": mesh_name,
        "dims_xyz_m": dims,
        "materials": len(writer.materials),
        "textures": len(writer.images),
        "bytes": len(output),
        "sha256": hashlib.sha256(output).hexdigest(),
        "skeletonPreserved": True,
    }


OUT.mkdir(parents=True, exist_ok=True)
walkers = json.loads(WALKER_PARAMETERS.read_text())["Walkers"]
entries = {f"walker.pedestrian.{walker['Id']}": assemble_walker(walker) for walker in walkers}
(Path(OUT).parent / "assembly-stats.json").write_text(json.dumps(entries, indent=2, sort_keys=True) + "\n")
print(f"assembled {len(entries)} pedestrian GLBs")
