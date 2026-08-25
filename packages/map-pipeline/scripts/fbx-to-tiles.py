import argparse
import json
import math
import os
import re
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
    accepted = ('.fbx', '.glb', '.gltf')
    return [os.path.join(root, name)
            for root, _, names in os.walk(source)
            for name in sorted(names)
            if name.lower().endswith(accepted)]


def import_source(filename):
    suffix = os.path.splitext(filename)[1].lower()
    if suffix == '.fbx':
        bpy.ops.import_scene.fbx(filepath=filename, use_anim=False, automatic_bone_orientation=False)
    else:
        bpy.ops.import_scene.gltf(filepath=filename, import_pack_images=True)


def world_bounds(obj):
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return ([min(value[i] for value in corners) for i in range(3)],
            [max(value[i] for value in corners) for i in range(3)])


def classify(obj):
    text = ' '.join([obj.name] + [slot.material.name for slot in obj.material_slots if slot.material]).lower()
    if re.search(r'veg|tree|bush|grass|foliage|plant', text):
        return 'vegetation'
    if re.search(r'road|asphalt|ground|terrain|pavement|marking|lane', text):
        return 'road'
    return 'static'


def export_objects(objects, filename):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in sorted(objects, key=lambda value: value.name):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = sorted(objects, key=lambda value: value.name)[0]
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


def triangle_count(objects):
    return sum(len(obj.data.loop_triangles) if obj.data.loop_triangles else len(obj.data.polygons) * 2
               for obj in objects if obj.type == 'MESH')


def main():
    args = parse_args()
    reset_scene()
    sources = source_files(args.source)
    if not sources:
        raise RuntimeError('source contains no FBX, GLB, or glTF files')
    for filename in sorted(sources):
        import_source(filename)

    objects = sorted([obj for obj in bpy.context.scene.objects if obj.type == 'MESH'], key=lambda value: value.name)
    if not objects:
        raise RuntimeError('source contains no mesh objects')
    for obj in objects:
        obj.data.calc_loop_triangles()

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
    road_bounds = aggregate_bounds(categories['road'])
    rows.append({'kind': 'road', 'file': 'tiles/road.glb', 'bounds': road_bounds,
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

    inventory = {
        'schema': 'simforge.fbx-tiles.v1',
        'cellSize': args.cell_size,
        'origin': [origin_x, scene_bounds['min'][1], origin_z],
        'bounds': scene_bounds,
        'objects': rows,
    }
    with open(os.path.join(args.output, 'inventory.json'), 'w', encoding='utf8', newline='\n') as handle:
        json.dump(inventory, handle, sort_keys=True, separators=(',', ':'))
        handle.write('\n')


if __name__ == '__main__':
    main()
