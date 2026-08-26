import os
import json
import sys

import bpy


output = sys.argv[sys.argv.index('--') + 1]
source_dir = os.path.dirname(output)
os.makedirs(os.path.join(source_dir, 'textures'), exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

image = bpy.data.images.new('checker', width=4, height=4)
pixels = []
for y in range(4):
    for x in range(4):
        tone = 0.75 if (x + y) % 2 == 0 else 0.2
        pixels.extend((tone, 0.35, 0.15, 1.0))
image.pixels = pixels
image.filepath_raw = os.path.join(source_dir, 'textures', 'checker_BaseColor.png')
image.file_format = 'PNG'
image.save()

material = bpy.data.materials.new('Building_Checker')
material.use_nodes = True
nodes = material.node_tree.nodes
texture = nodes.new('ShaderNodeTexImage')
texture.image = image
material.node_tree.links.new(texture.outputs['Color'], nodes['Principled BSDF'].inputs['Base Color'])

def cube(name, location, scale):
    bpy.ops.mesh.primitive_cube_add(size=2, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(material)
    return obj

cube('Building_West', (-25, 5, -25), (4, 5, 4))
cube('Building_East', (125, 8, -25), (6, 8, 5))
cube('Tree_North', (25, 3, 125), (2, 3, 2))

bpy.ops.mesh.primitive_plane_add(size=240, location=(50, 0, 50))
ground = bpy.context.object
ground.name = 'Road_Ground'
road_material = bpy.data.materials.new('Asphalt_Road')
road_material.diffuse_color = (0.12, 0.12, 0.12, 1)
ground.data.materials.append(road_material)

materials = []
for name in ('Building_Checker', 'Asphalt_Road'):
    ue_path = f'/Game/Synthetic/{name}.{name}'
    texture_path = '/Game/Synthetic/checker_BaseColor.checker_BaseColor'
    materials.append({
        'path': ue_path,
        'used_textures': [texture_path],
        'texture_parameters': {'BaseColor': texture_path},
        'render': {'blend_mode': 'Opaque', 'opacity_mask_clip_value': 0.3333, 'two_sided': False},
        'tags': ['road'] if name == 'Asphalt_Road' else ['building'],
    })
with open(os.path.join(source_dir, 'materials.json'), 'w', encoding='utf8') as handle:
    json.dump({
        'textures_dir': 'textures',
        'exported_textures': {'/Game/Synthetic/checker_BaseColor.checker_BaseColor': 'textures/checker_BaseColor.png'},
        'materials': materials,
    }, handle)
with open(os.path.join(source_dir, 'vegetation.json'), 'w', encoding='utf8') as handle:
    json.dump({'vegetation_prototypes': []}, handle)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.fbx(
    filepath=output,
    use_selection=True,
    bake_anim=False,
    path_mode='COPY',
    embed_textures=True,
    axis_forward='-Z',
    axis_up='Y',
)
