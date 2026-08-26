import argparse
from array import array
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys

import bpy
from mathutils import Vector

FFMPEG_BIN = 'ffmpeg'

def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--cell-size', type=float, default=100.0)
    parser.add_argument('--material-bindings', required=True)
    parser.add_argument('--ffmpeg', required=True)
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

def normalized_material_name(value):
    return re.sub(r'\\.\\d{3}$', '', value).split(':')[-1].strip().lower()


def converted_texture(binding, output, cache):
    source = binding['file']
    key = (source, binding['role'])
    if key in cache:
        return cache[key]
    needs_normal_flip = binding['role'] == 'normal' and binding.get('normalConvention') == 'directx'
    needs_format_conversion = os.path.splitext(source)[1].lower() in ('.exr', '.tga')
    with open(source, 'rb') as handle:
        digest = hashlib.sha256(handle.read() + binding['role'].encode('ascii')).hexdigest()
    converted_dir = os.path.join(output, '.converted-textures')
    os.makedirs(converted_dir, exist_ok=True)
    load_path = source
    if needs_format_conversion:
        load_path = os.path.join(converted_dir, f'{digest}.source.png')
        command = [FFMPEG_BIN, '-loglevel', 'error', '-threads', '1', '-y', '-i', source, '-frames:v', '1']
        if binding['colorSpace'] == 'srgb' and source.lower().endswith('.exr'):
            command.extend(['-vf', "lutrgb=r='pow(val,1/2.2)':g='pow(val,1/2.2)':b='pow(val,1/2.2)'"])
        command.append(load_path)
        subprocess.run(command, check=True)
    image = bpy.data.images.load(load_path, check_existing=True)
    image.colorspace_settings.name = 'sRGB' if binding['colorSpace'] == 'srgb' else 'Non-Color'
    if not needs_normal_flip:
        cache[key] = image
        return image
    pixels = array('f', [0.0]) * (image.size[0] * image.size[1] * 4)
    image.pixels.foreach_get(pixels)
    for index in range(1, len(pixels), 4):
        pixels[index] = 1.0 - pixels[index]
    converted = bpy.data.images.new(f'{image.name}_OpenGL', width=image.size[0], height=image.size[1], alpha=True)
    converted.colorspace_settings.name = 'Non-Color'
    converted.pixels.foreach_set(pixels)
    converted.filepath_raw = os.path.join(converted_dir, f'{digest}.png')
    converted.file_format = 'PNG'
    converted.save()
    cache[key] = converted
    return converted


def first_texture(bindings, *roles):
    for role in roles:
        for binding in bindings:
            if binding['role'] == role:
                return binding
    return None


def material_input(bsdf, *names):
    for name in names:
        value = bsdf.inputs.get(name)
        if value is not None:
            return value
    return None


def apply_binding(material, binding, output, image_cache):
    material.use_nodes = True
    material.surface_render_method = 'BLENDED' if binding['alphaMode'] == 'BLEND' else 'DITHERED'
    material.use_transparency_overlap = binding['alphaMode'] != 'OPAQUE'
    material.diffuse_color[3] = 1.0
    material.use_backface_culling = not binding['doubleSided']
    material['simforge_alpha_mode'] = binding['alphaMode']
    if 'alphaCutoff' in binding:
        material['simforge_alpha_cutoff'] = binding['alphaCutoff']
        material.alpha_threshold = binding['alphaCutoff']
    if 'anisotropy' in binding:
        material['simforge_sampler_anisotropy'] = binding['anisotropy']
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    output_node = nodes.new('ShaderNodeOutputMaterial')
    bsdf = nodes.new('ShaderNodeBsdfPrincipled')
    links.new(bsdf.outputs['BSDF'], output_node.inputs['Surface'])

    def image_node(texture):
        node = nodes.new('ShaderNodeTexImage')
        node.image = converted_texture(texture, output, image_cache)
        node.interpolation = 'Linear'
        node.extension = 'REPEAT'
        return node

    base = first_texture(binding['textures'], 'baseColor')
    if base:
        node = image_node(base)
        links.new(node.outputs['Color'], material_input(bsdf, 'Base Color'))
        if binding['alphaMode'] != 'OPAQUE':
            links.new(node.outputs['Alpha'], material_input(bsdf, 'Alpha'))
    normal = first_texture(binding['textures'], 'normal')
    if normal:
        node = image_node(normal)
        normal_node = nodes.new('ShaderNodeNormalMap')
        links.new(node.outputs['Color'], normal_node.inputs['Color'])
        links.new(normal_node.outputs['Normal'], material_input(bsdf, 'Normal'))
    orm = first_texture(binding['textures'], 'orm')
    if orm:
        node = image_node(orm)
        separate = nodes.new('ShaderNodeSeparateColor')
        links.new(node.outputs['Color'], separate.inputs['Color'])
        links.new(separate.outputs['Green'], material_input(bsdf, 'Roughness'))
        links.new(separate.outputs['Blue'], material_input(bsdf, 'Metallic'))
        group = bpy.data.node_groups.get('glTF Material Output')
        if group is None:
            group = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
            group.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
        occlusion = nodes.new('ShaderNodeGroup')
        occlusion.node_tree = group
        links.new(separate.outputs['Red'], occlusion.inputs['Occlusion'])
    else:
        roughness = first_texture(binding['textures'], 'roughness')
        metallic = first_texture(binding['textures'], 'metallic')
        occlusion_texture = first_texture(binding['textures'], 'occlusion')
        if roughness:
            links.new(image_node(roughness).outputs['Color'], material_input(bsdf, 'Roughness'))
        if metallic:
            links.new(image_node(metallic).outputs['Color'], material_input(bsdf, 'Metallic'))
        if occlusion_texture:
            node = image_node(occlusion_texture)
            group = bpy.data.node_groups.get('glTF Material Output')
            if group is None:
                group = bpy.data.node_groups.new('glTF Material Output', 'ShaderNodeTree')
                group.interface.new_socket(name='Occlusion', in_out='INPUT', socket_type='NodeSocketFloat')
            occlusion = nodes.new('ShaderNodeGroup')
            occlusion.node_tree = group
            links.new(node.outputs['Color'], occlusion.inputs['Occlusion'])
    opacity = first_texture(binding['textures'], 'opacity', 'mask')
    if opacity and binding['alphaMode'] != 'OPAQUE':
        links.new(image_node(opacity).outputs['Color'], material_input(bsdf, 'Alpha'))
    emissive = first_texture(binding['textures'], 'emissive')
    if emissive:
        links.new(image_node(emissive).outputs['Color'], material_input(bsdf, 'Emission Color', 'Emission'))

def apply_material_bindings(objects, plan, output, report, prototype_id=None):
    by_name = {}
    for row in plan['materials']:
        by_name.setdefault(normalized_material_name(row['name']), []).append(row)

    def resolve(name):
        normalized = normalized_material_name(name)
        candidates = by_name.get(normalized, [])
        if not candidates:
            candidates = by_name.get(re.sub(r'_\d+$', '', normalized), [])
        return candidates

    expected = plan.get('prototypeMaterials', {}).get((prototype_id or '').lower(), [])
    image_cache = {}
    seen = set()
    for obj in objects:
        for slot_index, slot in enumerate(obj.material_slots):
            if slot.material is None:
                continue
            material = slot.material
            if material.name in seen:
                continue
            seen.add(material.name)
            candidates = resolve(material.name)
            if not candidates and slot_index < len(expected):
                candidates = resolve(expected[slot_index])
            if not candidates:
                report['unmatchedMaterials'].append({'prototype': prototype_id, 'material': material.name})
                continue
            if len(candidates) > 1:
                report['ambiguousMaterials'].append({
                    'prototype': prototype_id,
                    'material': material.name,
                    'sourcePaths': [candidate['sourcePath'] for candidate in candidates],
                })
            binding = candidates[0]
            apply_binding(material, binding, output, image_cache)
            report['matchedMaterials'].append({'prototype': prototype_id, 'material': material.name,
                                               'sourcePath': binding['sourcePath']})

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


def export_vegetation_prototypes(source, output, plan, report):
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
        apply_material_bindings(objects, plan, output, report, stem)
        # The stem is also the vegetation.json mesh_asset_name and the closure prototype id.
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
    global FFMPEG_BIN
    FFMPEG_BIN = args.ffmpeg
    with open(args.material_bindings, 'r', encoding='utf8') as handle:
        binding_plan = json.load(handle)
    report = {
        'schema': 'simforge.material-binding-report.v1',
        'matchedMaterials': [],
        'unmatchedMaterials': [],
        'ambiguousMaterials': [],
        'roleCounts': binding_plan['roleCounts'],
        'ormChannels': binding_plan['ormChannels'],
        'normalConversion': 'DirectX green-down to glTF/OpenGL green-up (G := 1-G)',
        'unresolvedTextures': binding_plan['unresolvedTextures'],
        'fidelityLimitations': binding_plan['fidelityLimitations'],
    }
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
    apply_material_bindings(objects, binding_plan, args.output, report)
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

    prototypes = export_vegetation_prototypes(args.source, args.output, binding_plan, report)
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
    report['unmatchedMaterials'] = sorted(
        report['unmatchedMaterials'], key=lambda row: ((row['prototype'] or ''), row['material']))
    report['ambiguousMaterials'] = sorted(
        report['ambiguousMaterials'], key=lambda row: ((row['prototype'] or ''), row['material']))
    with open(os.path.join(args.output, 'material-binding-report.json'), 'w', encoding='utf8', newline='\n') as handle:
        json.dump(report, handle, sort_keys=True, separators=(',', ':'))
        handle.write('\n')
    shutil.rmtree(converted_dir, ignore_errors=True)

if __name__ == '__main__':
    main()
