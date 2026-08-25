import os
import sys

import bpy


output = sys.argv[sys.argv.index('--') + 1]
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

image = bpy.data.images.new('checker', width=4, height=4)
pixels = []
for y in range(4):
    for x in range(4):
        tone = 0.75 if (x + y) % 2 == 0 else 0.2
        pixels.extend((tone, 0.35, 0.15, 1.0))
image.pixels = pixels
image.pack()

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

os.makedirs(os.path.dirname(output), exist_ok=True)
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
