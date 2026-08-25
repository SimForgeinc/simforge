import argparse
import hashlib
import json
import math
import os
import re
import shutil
import sys

import bpy
from mathutils import Vector


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--cell-size', type=float, default=100.0)
    return parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def reset_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images):
        for item in list(collection):
            if item.users == 0:
                collection.remove(item)


def source_files(source):
    if os.path.isfile(source):
        return [source]
    directory_name = os.path.basename(os.path.abspath(source))
    preferred = os.path.join(source, f'{directory_name}.fbx')
    if os.path.isfile(preferred):
        return [preferred]
    accepted = ('.fbx', '.glb', '.gltf')
    return [os.path.join(source, name) for name in sorted(os.listdir(source))
            if name.lower().endswith(accepted) and os.path.isfile(os.path.join(source, name))]


def import_source(filename):
    suffix = os.path.splitext(filename)[1].lower()
    if suffix == '.fbx':
        bpy.ops.import_scene.fbx(filepath=filename, use_anim=False, automatic_bone_orientation=False)
    else:
        bpy.ops.import_scene.gltf(filepath=filename, import_pack_images=True)


def normalize_source_images(output):
    converted_dir = os.path.join(output, '.converted-textures')
    replacements = {}
    for image in sorted(list(bpy.data.images), key=lambda value: value.name):
        if not image.has_data or image.size[0] <= 0 or image.size[1] <= 0:
            continue
        source_path = bpy.path.abspath(image.filepath) if image.filepath else ''
        if os.path.splitext(source_path)[1].lower() not in ('.exr', '.tga'):
            continue
        if os.path.isfile(source_path):
            with open(source_path, 'rb') as source_handle:
                digest_source = source_handle.read()
        else:
            digest_source = image.name.encode('utf8')
        digest = hashlib.sha256(digest_source).hexdigest()
        os.makedirs(converted_dir, exist_ok=True)
        target = os.path.join(converted_dir, f'{digest}.png')
        image.save_render(target, scene=bpy.context.scene)
        replacements[image] = bpy.data.images.load(target, check_existing=False)
    for material in bpy.data.materials:
        if not material.use_nodes or material.node_tree is None:
            continue
        for node in material.node_tree.nodes:
            if node.type == 'TEX_IMAGE' and node.image in replacements:
                node.image = replacements[node.image]
    return converted_dir

def world_bounds(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    transformed = [Vector((value.x, value.z, -value.y)) for value in corners]
    return ([min(value[i] for value in transformed) for i in range(3)],
            [max(value[i] for value in transformed) for i in range(3)])


def classify(obj):
    text = ' '.join([obj.name] + [slot.material.name for slot in obj.material_slots if slot.material]).lower()
    if re.search(r'veg|tree|bush|grass|foliage|plant', text):
        return 'vegetation'
    if re.search(r'road|asphalt|ground|terrain|pavement|marking|lane', text):
        return 'road'
    return 'static'


def export_objects(objects, filename):
    bpy.ops.object.select_all(action='DESELECT')
    ordered = sorted(objects, key=lambda value: value.name)
    for obj in ordered:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = ordered[0]
    bpy.ops.export_scene.gltf(
        filepath=filename,
        export_format='GLB',
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
        export_image_format='AUTO',
        export_materials='EXPORT',
        export_original_specular=False,
    )


def aggregate_bounds(objects):
    rows = [world_bounds(obj) for obj in objects]
    return {
        'min': [min(row[0][axis] for row in rows) for axis in range(3)],
        'max': [max(row[1][axis] for row in rows) for axis in range(3)],
    }


def export_vegetation_prototypes(source, output):
    if not os.path.isdir(source):
        return []
    prototype_dir = os.path.join(source, 'vegetation_prototypes')
    if not os.path.isdir(prototype_dir):
        return []
    rows = []
    destination = os.path.join(output, 'tiles', 'prototypes')
    os.makedirs(destination, exist_ok=True)
    for filename in sorted(os.listdir(prototype_dir)):
        if not filename.lower().endswith('.fbx'):
            continue
        source_file = os.path.join(prototype_dir, filename)
        if not os.path.isfile(source_file):
            continue
        reset_scene()
        import_source(source_file)
        objects = sorted([obj for obj in bpy.context.scene.objects if obj.type == 'MESH'], key=lambda value: value.name)
        if not objects:
            continue
        for obj in objects:
            obj.data.calc_loop_triangles()
        normalize_source_images(output)
        stem = re.sub(r'[^a-zA-Z0-9_.-]+', '-', os.path.splitext(filename)[0]).strip('-')
        relative_file = f'tiles/prototypes/{stem}.glb'
        export_objects(objects, os.path.join(output, relative_file))
        rows.append({'id': stem, 'file': relative_file, 'bounds': aggregate_bounds(objects),
                     'triangles': triangle_count(objects)})
    return rows


def triangle_count(objects):
    return sum(len(obj.data.loop_triangles) if obj.data.loop_triangles else len(obj.data.polygons) * 2
               for obj in objects if obj.type == 'MESH')


def main():
    args = parse_args()
    reset_scene()
    sources = source_files(args.source)
    if not sources:
        raise RuntimeError('source contains no top-level FBX, GLB, or glTF files')
    for filename in sorted(sources):
        import_source(filename)

    objects = sorted([obj for obj in bpy.context.scene.objects if obj.type == 'MESH'], key=lambda value: value.name)
    if not objects:
        raise RuntimeError('source contains no mesh objects')
    for obj in objects:
        obj.data.calc_loop_triangles()

    converted_dir = normalize_source_images(args.output)
    categories = {key: [] for key in ('road', 'static', 'vegetation')}
    for obj in objects:
        categories[classify(obj)].append(obj)
    if not categories['road']:
        ground = min(objects, key=lambda obj: (world_bounds(obj)[0][1], obj.name))
        categories[classify(ground)].remove(ground)
        categories['road'].append(ground)

    scene_bounds = aggregate_bounds(objects)
    origin_x = math.floor(scene_bounds['min'][0] / args.cell_size) * args.cell_size
    origin_z = math.floor(scene_bounds['min'][2] / args.cell_size) * args.cell_size
    os.makedirs(os.path.join(args.output, 'tiles'), exist_ok=True)

    rows = []
    export_objects(categories['road'], os.path.join(args.output, 'tiles', 'road.glb'))
    rows.append({'kind': 'road', 'file': 'tiles/road.glb', 'bounds': aggregate_bounds(categories['road']),
                 'triangles': triangle_count(categories['road'])})

    for kind in ('static', 'vegetation'):
        cells = {}
        for obj in categories[kind]:
            bounds = world_bounds(obj)
            center_x = (bounds[0][0] + bounds[1][0]) / 2
            center_z = (bounds[0][2] + bounds[1][2]) / 2
            cell = (math.floor((center_x - origin_x) / args.cell_size),
                    math.floor((center_z - origin_z) / args.cell_size))
            cells.setdefault(cell, []).append(obj)
        prefix = 'tile' if kind == 'static' else 'veg'
        for (grid_x, grid_z), members in sorted(cells.items()):
            name = f'{prefix}_{grid_x}_{grid_z}.lod0.glb'
            export_objects(members, os.path.join(args.output, 'tiles', name))
            rows.append({'kind': kind, 'file': f'tiles/{name}', 'gridX': grid_x, 'gridZ': grid_z,
                         'bounds': aggregate_bounds(members), 'triangles': triangle_count(members)})

    prototypes = export_vegetation_prototypes(args.source, args.output)
    inventory = {
        'schema': 'simforge.fbx-tiles.v1',
        'cellSize': args.cell_size,
        'origin': [origin_x, scene_bounds['min'][1], origin_z],
        'bounds': scene_bounds,
        'objects': rows,
        'vegetationPrototypes': prototypes,
    }
    with open(os.path.join(args.output, 'inventory.json'), 'w', encoding='utf8', newline='\n') as handle:
        json.dump(inventory, handle, sort_keys=True, separators=(',', ':'))
        handle.write('\n')
    shutil.rmtree(converted_dir, ignore_errors=True)

if __name__ == '__main__':
    main()
