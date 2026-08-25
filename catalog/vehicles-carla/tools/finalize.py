#!/usr/bin/env python3
"""Generate manifest.json, ATTRIBUTION.json and catalog-models.json from the
final GLBs. Usage: finalize.py <models-dir> <out-dir>"""
import hashlib
import io
import json
import os
import sys

import numpy as np
from PIL import Image

ARGS = sys.argv[1:]
sys.argv = [sys.argv[0]]  # keep assemble's module-level arg parsing inert
import assemble  # noqa: E402  (VEHICLES table + GLB readers)

def glb_summary(path):
    js, b = assemble.read_glb(path)
    tris = sum(js['accessors'][p['indices']]['count'] // 3 for m in js['meshes'] for p in m['primitives'])
    verts = sum(js['accessors'][p['attributes']['POSITION']]['count'] for m in js['meshes'] for p in m['primitives'])
    texs = []
    for img in js.get('images', []):
        bv = js['bufferViews'][img['bufferView']]
        im = Image.open(io.BytesIO(b[bv.get('byteOffset', 0):bv.get('byteOffset', 0) + bv['byteLength']]))
        texs.append(dict(name=img.get('name', ''), w=im.width, h=im.height))
    nodes = sorted({n['name'] for n in js['nodes'] if 'mesh' in n})
    mats = [m['name'] for m in js.get('materials', [])]

    def quat_mat(q):
        x, y, z, w = q
        return np.array([
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])

    mn = np.full(3, np.inf)
    mx = np.full(3, -np.inf)
    for n in js['nodes']:
        if 'mesh' not in n:
            continue
        t = np.array(n.get('translation', [0.0, 0.0, 0.0]))
        R = quat_mat(n.get('rotation', [0.0, 0.0, 0.0, 1.0]))
        m = js['meshes'][n['mesh']]
        nmn = np.min([js['accessors'][p['attributes']['POSITION']]['min'] for p in m['primitives']], axis=0)
        nmx = np.max([js['accessors'][p['attributes']['POSITION']]['max'] for p in m['primitives']], axis=0)
        for sx in (0, 1):
            for sy in (0, 1):
                for sz in (0, 1):
                    c = np.array([nmn[0] if sx == 0 else nmx[0],
                                  nmn[1] if sy == 0 else nmx[1],
                                  nmn[2] if sz == 0 else nmx[2]])
                    p = R @ c + t
                    mn = np.minimum(mn, p)
                    mx = np.maximum(mx, p)
    return dict(tris=tris, verts=verts, textures=texs, nodes=nodes, materials=mats,
                bbox=(mn.round(3).tolist(), mx.round(3).tolist()))
def main(models_dir, out_dir):
    manifest = {'version': 1,
                'convention': {
                    'axes': 'y-up, right-handed; +X = vehicle forward; -Z = vehicle left; meters',
                    'origin': 'CARLA vehicle pivot projected to ground (y=0); matches CARLA actor transforms',
                    'nodes': 'body (+ wheel_fl/fr/rl/rr, door_fl/fr/rl/rr on rigged vehicles; wheel_f/r + handlebar on two-wheelers); wheel/door node origins at wheel centers / door hinges',
                    'tint': "materials named 'body_paint' are neutral (white baseColorFactor): set baseColorFactor to the authored catalog color; 'body_livery' materials MUST NOT be tinted",
                    'textures': 'PNG, <=2048px body/livery, <=1024px details; ORM packed occlusion(R) roughness(G) metallic(B); normal maps OpenGL +Y',
                },
                'vehicles': {}}
    attribution = {'license': 'CC-BY-4.0',
                   'license_url': 'https://creativecommons.org/licenses/by/4.0/',
                   'source': 'CARLA Simulator content (carla-simulator, CVC/UAB Barcelona), cooked UE assets from the CARLA 0.10.0 UE5 distribution',
                   'source_url': 'https://github.com/carla-simulator/carla',
                   'notice': 'CARLA-specific assets are distributed under CC BY 4.0 per the CARLA project README. Meshes and textures were extracted from cooked Unreal Engine packages with CUE4Parse, door/glass/emissive blueprint components merged, decimated with meshoptimizer, and re-authored as glTF 2.0 binaries. No RoadRunner Asset Library content is included.',
                   'assets': {}}
    for spec in assemble.VEHICLES:
        vid = f"vehicle_{spec['id']}"
        p = os.path.join(models_dir, f'{vid}.glb')
        s = glb_summary(p)
        raw = open(p, 'rb').read()
        bbox = s['bbox']
        manifest['vehicles'][vid] = dict(
            file=f'models/{vid}.glb', family=spec['family'], display=spec['disp'],
            carla_blueprint=spec['bp'], tintable=spec['tintable'],
            dims_lwh_m=[round(bbox[1][0] - bbox[0][0], 2), round(bbox[1][2] - bbox[0][2], 2), round(bbox[1][1] - bbox[0][1], 2)],
            bbox=dict(min=bbox[0], max=bbox[1]),
            tris=s['tris'], verts=s['verts'], nodes=s['nodes'], materials=s['materials'],
            textures=[f"{t['name'].split('@')[0]} {t['w']}x{t['h']}" for t in s['textures']],
            size_bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
        attribution['assets'][vid] = dict(
            title=spec['disp'],
            source_packages=[f'Content/Carla/Static (CARLA UE5 0.10.0 cooked content): {src}' for src in spec['src']],
            license='CC-BY-4.0',
            attribution=f"\"{spec['disp']}\" vehicle model © CARLA Simulator contributors (carla.org), licensed CC BY 4.0; converted to glTF for SimForge.",
            modifications='UE->glTF conversion (CUE4Parse), rigid-node re-rig by bone, blueprint door/glass/emissive merge, mesh decimation (meshoptimizer), PBR re-wire (baseColor/normal/ORM), texture downscale + normal-map green-channel flip, neutral body_paint slot for tinting.')

    def centry(vid, note=None, scale=True):
        v = manifest['vehicles'][vid]
        e = {'model': {'glbPath': f'catalog/vehicles-carla/models/{vid}.glb',
                       'attribution': attribution['assets'][vid]['attribution'],
                       'source': 'carla-0.10.0-ue5'},
             'tintable': v['tintable'], 'scaleToDims': scale}
        if note:
            e['note'] = note
        return e

    sidecar = {
        'comment': 'Merge into packages/asset-catalog/catalog.json per PATCH-NOTES.md. Keys are existing catalog ids.',
        'entries': {
            'vehicle.sedan': centry('vehicle_sedan_lincoln_mkz'),
            'vehicle.hatchback': centry('vehicle_hatchback_mini_cooper'),
            'vehicle.suv': centry('vehicle_suv_nissan_patrol'),
            'vehicle.pickup': centry('vehicle_pickup_tesla_cybertruck'),
            'vehicle.van': centry('vehicle_van_mercedes_sprinter'),
            'vehicle.delivery_van': centry('vehicle_van_mercedes_sprinter'),
            'vehicle.minivan': centry('vehicle_minivan_bmw_gran_tourer'),
            'vehicle.kia.carnival': centry('vehicle_minivan_bmw_gran_tourer', note='closest available CC-BY MPV silhouette; the packaged Kia Carnival has a separate non-CARLA license'),
            'vehicle.box_truck': centry('vehicle_truck_carlacola'),
            'vehicle.semi_truck': centry('vehicle_truck_european_hgv', note='tractor unit only; catalog dims include a trailer — scale by width/height, not length', scale=False),
            'vehicle.bus': centry('vehicle_bus_mitsubishi_fusorosa', note='minibus stand-in for a 12m transit bus'),
            'vehicle.shuttle_bus': centry('vehicle_bus_mitsubishi_fusorosa'),
            'vehicle.motorcycle': centry('vehicle_motorcycle_harley'),
            'vehicle.bicycle': centry('vehicle_bicycle_bh_crossbike'),
            'vehicle.ambulance': centry('vehicle_ambulance_ford'),
            'vehicle.tesla_model_3': centry('vehicle_sedan_tesla_model3'),
            'vehicle.ford_mustang': centry('vehicle_coupe_ford_mustang'),
            'vehicle.taxi': centry('vehicle_sedan_ford_crown'),
            'vehicle.police_cruiser': centry('vehicle_police_dodge_charger'),
            'vehicle.honda_civic': centry('vehicle_sedan_dodge_charger', note='visual stand-in (no Civic in CARLA content); tintable sedan'),
            'vehicle.toyota_camry': centry('vehicle_sedan_lincoln_mkz', note='visual stand-in; tintable sedan'),
        },
        'extras': {
            vid: {'model': {'glbPath': f'catalog/vehicles-carla/models/{vid}.glb',
                            'attribution': attribution['assets'][vid]['attribution'],
                            'source': 'carla-0.10.0-ue5'},
                  'tintable': manifest['vehicles'][vid]['tintable'], 'note': note}
            for vid, note in [('vehicle_van_volkswagen_t2', 'classic van, no catalog id yet'),
                              ('vehicle_motorcycle_kawasaki_ninja', 'sport bike variant'),
                              ('vehicle_scooter_vespa', 'scooter variant')]
        }}
    # Every CARLA blueprint id resolves directly, in addition to SimForge's
    # coarser authoring catalog ids above.
    for spec in assemble.VEHICLES:
        vid = f"vehicle_{spec['id']}"
        sidecar['entries'][spec['bp']] = centry(vid)
    server_aliases = {
        'vehicle.ambulance.ford': 'vehicle_ambulance_ford',
        'vehicle.carlacola.actors': 'vehicle_truck_carlacola',
        'vehicle.dodge.charger': 'vehicle_sedan_dodge_charger',
        'vehicle.dodgecop.charger': 'vehicle_police_dodge_charger',
        'vehicle.firetruck.actors': 'vehicle_firetruck_actros',
        'vehicle.fuso.mitsubishi': 'vehicle_bus_mitsubishi_fusorosa',
        'vehicle.lincoln.mkz': 'vehicle_sedan_lincoln_mkz',
        'vehicle.mini.cooper': 'vehicle_hatchback_mini_cooper',
        'vehicle.nissan.patrol': 'vehicle_suv_nissan_patrol',
        'vehicle.sprinter.mercedes': 'vehicle_van_mercedes_sprinter',
        'vehicle.taxi.ford': 'vehicle_sedan_ford_crown',
    }
    for blueprint, vid in server_aliases.items():
        sidecar['entries'][blueprint] = centry(vid)

    json.dump(manifest, open(os.path.join(out_dir, 'manifest.json'), 'w'), indent=2)
    json.dump(attribution, open(os.path.join(out_dir, 'ATTRIBUTION.json'), 'w'), indent=2)
    json.dump(sidecar, open(os.path.join(out_dir, 'catalog-models.json'), 'w'), indent=2)
    total = sum(v['size_bytes'] for v in manifest['vehicles'].values())
    print(f"wrote manifest/attribution/catalog-models for {len(manifest['vehicles'])} vehicles, total {total/1e6:.1f} MB")
    for vid, v in manifest['vehicles'].items():
        print(f"  {vid:36s} {v['tris']:7d} tris {len(v['textures']):2d} tex {v['size_bytes']/1e6:5.1f} MB dims={v['dims_lwh_m']}")


if __name__ == '__main__':
    main(ARGS[0] if len(ARGS) > 0 else '../models',
         ARGS[1] if len(ARGS) > 1 else '..')
