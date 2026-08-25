#!/usr/bin/env python3
"""SimForge CARLA vehicle GLB assembly pipeline.

Input : CUE4Parse export tree (produced by tools/extract):
          <export>/**/*.glb            per-mesh geometry (skinned, MI-named materials)
          <export>/**/*.png            decoded textures
          <export>/**/*.json           CMaterialParams2 dumps per material
          <export>/materials-sidecar.json
Output: one self-contained GLB per vehicle — rigid nodes split by bone
        (body / wheel_* / handlebar), PBR materials (baseColor/normal/ORM),
        embedded PNG textures, neutral `body_paint` slot for tinting.

Post-process (size): meshes over ~100k tris are decimated with
  npx @gltf-transform/cli simplify --ratio 0.18 --error 0.0008
then validated with the Khronos validator (see tools/README.md).

Deps: numpy, Pillow. Usage: assemble.py <export-dir> <out-dir>
"""
import io
import json
import math
import os
import glob
import re
import struct
import sys

import numpy as np
from PIL import Image

E = sys.argv[1] if len(sys.argv) > 1 else '/home/path/tmp/sf-vehicles-work/export'
OUT = sys.argv[2] if len(sys.argv) > 2 else '/home/path/tmp/sf-vehicles-work/assembled'
# extras.json: per-vehicle BP-harvested door/glass/emissive static-mesh components
# (see tools/README.md step 1b): {vid: [{mesh, socket, t, overrides}]}
EXTRAS_PATH = sys.argv[3] if len(sys.argv) > 3 else '/home/path/tmp/sf-vehicles-work/extras.json'
EXTRAS = json.load(open(EXTRAS_PATH)) if os.path.exists(EXTRAS_PATH) else {}

glbs = {os.path.basename(p)[:-4]: p for p in glob.glob(E + '/**/*.glb', recursive=True)}
mats = {os.path.basename(p)[:-5]: p for p in glob.glob(E + '/**/*.json', recursive=True) if 'sidecar' not in p}
pngs = {os.path.basename(p)[:-4]: p for p in glob.glob(E + '/**/*.png', recursive=True)}
SC = json.load(open(E + '/materials-sidecar.json')) if os.path.exists(E + '/materials-sidecar.json') else {}

CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    with open(path, 'rb') as f:
        data = f.read()
    magic, ver, length = struct.unpack_from('<III', data, 0)
    assert magic == 0x46546C67
    off = 12
    js = None
    bin_ = None
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off)
        off += 8
        chunk = data[off:off + clen]
        off += clen
        if ctype == 0x4E4F534A:
            js = json.loads(chunk)
        elif ctype == 0x004E4942:
            bin_ = chunk
    return js, bin_


def acc(js, bin_, i):
    a = js['accessors'][i]
    bv = js['bufferViews'][a['bufferView']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    n = NC[a['type']]
    dt = CT[a['componentType']]
    stride = bv.get('byteStride')
    itemsize = np.dtype(dt).itemsize * n
    if stride and stride != itemsize:
        raw = np.frombuffer(bin_, dtype=np.uint8, count=stride * a['count'], offset=off).reshape(a['count'], stride)
        return raw[:, :itemsize].copy().view(dt).reshape(a['count'], n)
    return np.frombuffer(bin_, dtype=dt, count=a['count'] * n, offset=off).reshape(a['count'], n)


def rigid_decompose(m):
    t = m[:3, 3].copy()
    r = m[:3, :3]
    u, _, vt = np.linalg.svd(r)
    r = u @ vt
    tr = np.trace(r)
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        w = 0.25 * s
        x = (r[2, 1] - r[1, 2]) / s
        y = (r[0, 2] - r[2, 0]) / s
        z = (r[1, 0] - r[0, 1]) / s
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
        w = (r[2, 1] - r[1, 2]) / s
        x = 0.25 * s
        y = (r[0, 1] + r[1, 0]) / s
        z = (r[0, 2] + r[2, 0]) / s
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
        w = (r[0, 2] - r[2, 0]) / s
        x = (r[0, 1] + r[1, 0]) / s
        y = 0.25 * s
        z = (r[1, 2] + r[2, 1]) / s
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
        w = (r[1, 0] - r[0, 1]) / s
        x = (r[0, 2] + r[2, 0]) / s
        y = (r[1, 2] + r[2, 1]) / s
        z = 0.25 * s
    q = np.array([x, y, z, w])
    q /= np.linalg.norm(q)
    return t, q, r


class GlbWriter:
    def __init__(self):
        self.buf = bytearray()
        self.views = []
        self.accessors = []
        self.images = []
        self.textures = []
        self.samplers = [{'magFilter': 9729, 'minFilter': 9987, 'wrapS': 10497, 'wrapT': 10497}]
        self.materials = []
        self.meshes = []
        self.nodes = []
        self._imgcache = {}

    def _pad(self, align=4):
        while len(self.buf) % align:
            self.buf.append(0)

    def add_view(self, data, target=None):
        self._pad()
        off = len(self.buf)
        self.buf.extend(data)
        v = {'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}
        if target:
            v['target'] = target
        self.views.append(v)
        return len(self.views) - 1

    def add_acc(self, arr, type_, target=34962, minmax=False):
        arr = np.ascontiguousarray(arr)
        comp = {np.dtype(np.float32): 5126, np.dtype(np.uint32): 5125,
                np.dtype(np.uint16): 5123, np.dtype(np.uint8): 5121}[arr.dtype]
        vi = self.add_view(arr.tobytes(), target)
        a = {'bufferView': vi, 'componentType': comp, 'count': int(arr.shape[0]), 'type': type_}
        if minmax:
            a['min'] = [float(x) for x in np.asarray(arr).reshape(arr.shape[0], -1).min(0)]
            a['max'] = [float(x) for x in np.asarray(arr).reshape(arr.shape[0], -1).max(0)]
        self.accessors.append(a)
        return len(self.accessors) - 1

    def add_image_png(self, key, png_bytes):
        if key in self._imgcache:
            return self._imgcache[key]
        vi = self.add_view(png_bytes)
        self.images.append({'bufferView': vi, 'mimeType': 'image/png', 'name': key})
        self.textures.append({'source': len(self.images) - 1, 'sampler': 0})
        ti = len(self.textures) - 1
        self._imgcache[key] = ti
        return ti

    def finish(self, root_nodes, asset_extras=None):
        self._pad()
        js = {
            'asset': {'version': '2.0', 'generator': 'simforge-carla-vehicle-pipeline'},
            'scene': 0, 'scenes': [{'nodes': root_nodes}],
            'nodes': self.nodes, 'meshes': self.meshes,
            'materials': self.materials,
            'accessors': self.accessors, 'bufferViews': self.views,
            'buffers': [{'byteLength': len(self.buf)}],
            'samplers': self.samplers,
        }
        if asset_extras:
            js['asset']['extras'] = asset_extras
        if self.images:
            js['images'] = self.images
            js['textures'] = self.textures
        jb = json.dumps(js, separators=(',', ':')).encode()
        while len(jb) % 4:
            jb += b' '
        binb = bytes(self.buf)
        total = 12 + 8 + len(jb) + 8 + len(binb)
        out = struct.pack('<III', 0x46546C67, 2, total)
        out += struct.pack('<II', len(jb), 0x4E4F534A) + jb
        out += struct.pack('<II', len(binb), 0x004E4942) + binb
        return out


def tex_key(mi):
    t = mi.get('Textures', {})

    def pick(*keys):
        for k in keys:
            if k in t:
                return t[k].split('.')[-1]
        return None

    scalars = mi.get('Parameters', {}).get('Scalars', {})
    return dict(
        d=pick('PM_Diffuse', 'Diffuse', 'Sticker Diffuse'),
        n=pick('PM_Normals', 'Normals', 'Normal'),
        orm=pick('PM_SpecularMasks', 'SpecularMasks', 'ORM'),
        blend=mi.get('Parameters', {}).get('BlendMode'),
        shading=mi.get('Parameters', {}).get('ShadingModel'),
        metallic=scalars.get('Metallic', scalars.get('Metallic Value')),
        rough=scalars.get('Roughness', scalars.get('Roughness Value')),
        basecolor=mi.get('Parameters', {}).get('Colors', {}).get('Base Color', {}).get('Hex'),
    )


TEXCACHE = {}
SKIP_TEX = ('T_Noises03', 'T_Flakes03_msk', 'LightColors', 'T_8ColorMask_op', 'T_VerticalStripes_n')


def prep_texture(tex_name, kind, cap):
    """kind: d|n|orm|livery ; returns (key, png_bytes) or None."""
    if (not tex_name or tex_name.startswith('T_Flat') or tex_name.startswith('T_Asphalt')
            or 'DirtMask' in tex_name or tex_name in SKIP_TEX):
        return None
    if tex_name not in pngs:
        print('  !! texture png missing:', tex_name)
        return None
    key = f'{tex_name}@{kind}{cap}'
    if key in TEXCACHE:
        return key, TEXCACHE[key]
    im = Image.open(pngs[tex_name])
    if max(im.size) > cap:
        s = cap / max(im.size)
        im = im.resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS)
    if kind == 'n':
        im = im.convert('RGB')
        a = np.asarray(im).copy()
        a[..., 1] = 255 - a[..., 1]  # UE DirectX-style green -> glTF OpenGL
        im = Image.fromarray(a)
    elif kind == 'orm':
        im = im.convert('RGB')
    else:  # d / livery: keep alpha only if meaningful
        if im.mode == 'RGBA':
            al = np.asarray(im)[..., 3]
            if al.min() > 250:
                im = im.convert('RGB')
    bio = io.BytesIO()
    im.save(bio, 'PNG', optimize=True)
    TEXCACHE[key] = bio.getvalue()
    return key, TEXCACHE[key]


UNTEXTURED = {
    'MI_Black': dict(color=[0.02, 0.02, 0.02, 1.0], metallic=0.0, rough=0.5),
    'Rubber': dict(color=[0.03, 0.03, 0.03, 1.0], metallic=0.0, rough=0.92),
    'Rubber_Inst': dict(color=[0.03, 0.03, 0.03, 1.0], metallic=0.0, rough=0.92),
    'PolishedAluminiumWhite_Inst': dict(color=[0.85, 0.85, 0.88, 1.0], metallic=1.0, rough=0.25),
    'plasticgrey_Inst': dict(color=[0.32, 0.32, 0.34, 1.0], metallic=0.0, rough=0.7),
}


def snake(s):
    s = re.sub(r'^(MI?_)', '', s)
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', s)
    return s.lower()


def build_material(w, mi_name, spec):
    mkey = mi_name or 'default'
    if mkey in w._matcache:
        return w._matcache[mkey]
    body_slots = spec.get('body', [])
    mj = json.load(open(mats[mi_name])) if (mi_name in mats) else {}
    info = tex_key(mj) if mj else {}
    m = {'name': snake(mi_name) if mi_name else 'default', 'pbrMetallicRoughness': {}}
    pbr = m['pbrMetallicRoughness']

    is_body = mi_name in body_slots
    is_glass = (info.get('blend') == 2) or ('glass' in (mi_name or '').lower())
    is_masked = info.get('blend') == 1

    is_emissive = 'emissive' in (mi_name or '').lower()

    if is_body:
        if spec.get('tintable', True):
            m['name'] = 'body_paint'
            pbr['baseColorFactor'] = [1.0, 1.0, 1.0, 1.0]
            pbr['metallicFactor'] = 0.4
            pbr['roughnessFactor'] = 0.35
        elif spec.get('body_color'):
            # Authored flat paint (linear RGB from the MI 'Base Color' param);
            # used where the diffuse texture is a decal mask, not an albedo.
            m['name'] = 'body_livery'
            pbr['baseColorFactor'] = list(spec['body_color']) + [1.0]
            pbr['metallicFactor'] = 0.4
            pbr['roughnessFactor'] = 0.35
        else:
            m['name'] = 'body_livery'
            t = prep_texture(info.get('d'), 'livery', 2048)
            if t:
                pbr['baseColorTexture'] = {'index': w.add_image_png(*t)}
            pbr['baseColorFactor'] = [1.0, 1.0, 1.0, 1.0]
            pbr['metallicFactor'] = 0.25
            pbr['roughnessFactor'] = 0.45
        t = prep_texture(info.get('n'), 'n', 1024)
        if t:
            m['normalTexture'] = {'index': w.add_image_png(*t)}
        t = prep_texture(info.get('orm'), 'orm', 1024)
        if t:
            pbr['metallicRoughnessTexture'] = {'index': w.add_image_png(*t)}
            m['occlusionTexture'] = {'index': pbr['metallicRoughnessTexture']['index']}
            pbr['metallicFactor'] = 1.0
            pbr['roughnessFactor'] = 1.0
    elif is_emissive:
        m['name'] = snake(mi_name)
        t = prep_texture(info.get('d'), 'd', 1024)
        if t:
            ti = w.add_image_png(*t)
            pbr['baseColorTexture'] = {'index': ti}
            m['emissiveTexture'] = {'index': ti}
        pbr['baseColorFactor'] = [1.0, 1.0, 1.0, 1.0]
        pbr['metallicFactor'] = 0.0
        pbr['roughnessFactor'] = 0.6
        m['emissiveFactor'] = [1.0, 1.0, 1.0]
        if info.get('blend') == 2:
            m['alphaMode'] = 'BLEND'
    elif is_glass:
        m['name'] = 'glass' if 'glass' in (mi_name or '').lower() else snake(mi_name)
        pbr['baseColorFactor'] = [0.03, 0.04, 0.05, 0.42]
        pbr['metallicFactor'] = 0.0
        pbr['roughnessFactor'] = 0.08
        m['alphaMode'] = 'BLEND'
        m['doubleSided'] = True
    elif mi_name in UNTEXTURED:
        u = UNTEXTURED[mi_name]
        pbr['baseColorFactor'] = u['color']
        pbr['metallicFactor'] = u['metallic']
        pbr['roughnessFactor'] = u['rough']
    else:
        t = prep_texture(info.get('d'), 'd', 1024)
        if t:
            pbr['baseColorTexture'] = {'index': w.add_image_png(*t)}
        pbr['baseColorFactor'] = [1.0, 1.0, 1.0, 1.0]
        t = prep_texture(info.get('n'), 'n', 1024)
        if t:
            m['normalTexture'] = {'index': w.add_image_png(*t)}
        t = prep_texture(info.get('orm'), 'orm', 1024)
        if t:
            pbr['metallicRoughnessTexture'] = {'index': w.add_image_png(*t)}
            m['occlusionTexture'] = {'index': pbr['metallicRoughnessTexture']['index']}
            pbr['metallicFactor'] = 1.0
            pbr['roughnessFactor'] = 1.0
        else:
            met = info.get('metallic')
            rgh = info.get('rough')
            pbr['metallicFactor'] = float(min(max(met if met is not None else 0.1, 0), 1))
            pbr['roughnessFactor'] = float(min(max(rgh if rgh is not None else 0.8, 0), 1))
        if is_masked:
            m['alphaMode'] = 'MASK'
            m['alphaCutoff'] = 0.33
    w.materials.append(m)
    w._matcache[mkey] = len(w.materials) - 1
    return w._matcache[mkey]


def canon_door(sock):
    n = sock.lower()
    fr = 'r' if ('rear' in n or 'back' in n or n.endswith('_rl') or n.endswith('_rr')) else 'f'
    lr = 'l' if ('left' in n or n.endswith('l')) else 'r'
    return f'door_{fr}{lr}'


def canon_node(name):
    n = name.lower()
    if 'wheel' in n:
        fr = 'f' if 'front' in n else ('r' if ('rear' in n or 'back' in n) else '')
        lr = 'l' if 'left' in n else ('r' if 'right' in n else '')
        if fr and lr:
            return f'wheel_{fr}{lr}'
        if fr:
            return f'wheel_{fr}'
        return snake(name)
    if 'base' in n or n == 'root' or 'body' in n:
        return 'body'
    if 'handler' in n or 'handle' in n:
        return 'handlebar'
    return snake(name)


def assemble(spec, out_path):
    w = GlbWriter()
    w._matcache = {}
    stats = dict(tris=0, verts=0, mats=set(), nodes=[], mixed_tris=0)
    root_children = []
    w.nodes.append({'name': spec['id']})  # root, index 0
    node_by_key = {}
    bboxes = []

    def get_node(key, t=None, q=None):
        if key in node_by_key:
            return node_by_key[key]
        nd = {'name': key}
        if t is not None and np.abs(t).max() > 1e-6:
            nd['translation'] = [float(x) for x in t]
        if q is not None and abs(q[3] - 1) > 1e-6:
            nd['rotation'] = [float(x) for x in q]
        w.nodes.append(nd)
        idx = len(w.nodes) - 1
        node_by_key[key] = idx
        root_children.append(idx)
        return idx

    jointbind = {}  # original joint name -> (t, q); doors have no skinned verts but exist as sockets
    for src in spec['src']:
        js, b = read_glb(glbs[src])
        matnames = [m['name'] for m in js['materials']]
        skin = js.get('skins', [None])[0]
        ibms = None
        jointnames = None
        if skin:
            ibms = acc(js, b, skin['inverseBindMatrices']).reshape(-1, 4, 4)
            jointnames = [js['nodes'][ni]['name'] for ni in skin['joints']]
            for ji, jn in enumerate(jointnames):
                gt_, gq_, _ = rigid_decompose(np.linalg.inv(ibms[ji].T))
                jointbind[jn] = (gt_, gq_)
        for mesh in js['meshes']:
            for prim in mesh['primitives']:
                A = prim['attributes']
                pos = acc(js, b, A['POSITION']).astype(np.float32)
                nrm = acc(js, b, A['NORMAL']).astype(np.float32)
                tan = acc(js, b, A['TANGENT']).astype(np.float32) if 'TANGENT' in A else None
                uv = acc(js, b, A['TEXCOORD_0']).astype(np.float32)
                idx = acc(js, b, prim['indices']).reshape(-1).astype(np.uint32)
                tris = idx.reshape(-1, 3)
                mi_name = matnames[prim['material']] if 'material' in prim else None
                if skin is not None and 'JOINTS_0' in A:
                    joints = acc(js, b, A['JOINTS_0'])
                    weights = acc(js, b, A['WEIGHTS_0']).astype(np.float32)
                    dom = joints[np.arange(len(joints)), weights.argmax(1)].astype(np.int32)
                    tj = dom[tris]
                    same = (tj[:, 0] == tj[:, 1]) & (tj[:, 0] == tj[:, 2])
                    stats['mixed_tris'] += int((~same).sum())
                    tri_joint = np.where(same, tj[:, 0], np.median(tj, axis=1).astype(np.int32))
                    groups = {int(j): tris[tri_joint == j] for j in np.unique(tri_joint)}
                else:
                    groups = {-1: tris}
                for j, gtris in groups.items():
                    if len(gtris) == 0:
                        continue
                    vids = np.unique(gtris)
                    remap = np.full(int(vids.max()) + 1, -1, np.int64)
                    remap[vids] = np.arange(len(vids))
                    gp = pos[vids]
                    gn = nrm[vids]
                    gu = uv[vids]
                    gt = tan[vids] if tan is not None else None
                    gi = remap[gtris].astype(np.uint32)
                    if j >= 0:
                        ibm = ibms[j].T
                        R = ibm[:3, :3]
                        T = ibm[:3, 3]
                        gp = gp @ R.T + T
                        gn = gn @ R.T
                        if gt is not None:
                            gt = np.concatenate([gt[:, :3] @ R.T, gt[:, 3:4]], axis=1)
                        g = np.linalg.inv(ibm)
                        t, q, _ = rigid_decompose(g)
                        key = canon_node(jointnames[j])
                    else:
                        t = q = None
                        key = 'body'
                    nid = get_node(key, t, q)
                    mat_idx = build_material(w, mi_name, spec)
                    attrs = {'POSITION': w.add_acc(gp, 'VEC3', minmax=True),
                             'NORMAL': w.add_acc(gn / np.maximum(np.linalg.norm(gn, axis=1, keepdims=True), 1e-8), 'VEC3')}
                    if gt is not None:
                        gt3 = gt[:, :3] / np.maximum(np.linalg.norm(gt[:, :3], axis=1, keepdims=True), 1e-8)
                        attrs['TANGENT'] = w.add_acc(np.concatenate([gt3, gt[:, 3:4]], 1).astype(np.float32), 'VEC4')
                    attrs['TEXCOORD_0'] = w.add_acc(gu, 'VEC2')
                    new_prim = {'attributes': attrs,
                                'indices': w.add_acc(gi.reshape(-1), 'SCALAR', target=34963),
                                'material': mat_idx, 'mode': 4}
                    nd = w.nodes[nid]
                    if 'mesh' in nd:
                        w.meshes[nd['mesh']]['primitives'].append(new_prim)
                    else:
                        w.meshes.append({'name': key, 'primitives': [new_prim]})
                        nd['mesh'] = len(w.meshes) - 1
                    stats['tris'] += len(gi)
                    stats['verts'] += len(gp)
                    stats['mats'].add(w.materials[mat_idx]['name'])
                    if q is not None:
                        Rg = np.linalg.inv(ibm)[:3, :3]
                        Tg = np.linalg.inv(ibm)[:3, 3]
                        gpw = gp @ Rg.T + Tg
                    else:
                        gpw = gp
                    bboxes.append((gpw.min(0), gpw.max(0)))

    def emit_prim(gp, gn, gt, gu, gi, mi_name, key, nt, nq):
        nid = get_node(key, nt, nq)
        mat_idx = build_material(w, mi_name, spec)
        attrs = {'POSITION': w.add_acc(gp, 'VEC3', minmax=True),
                 'NORMAL': w.add_acc(gn / np.maximum(np.linalg.norm(gn, axis=1, keepdims=True), 1e-8), 'VEC3')}
        if gt is not None:
            gt3 = gt[:, :3] / np.maximum(np.linalg.norm(gt[:, :3], axis=1, keepdims=True), 1e-8)
            attrs['TANGENT'] = w.add_acc(np.concatenate([gt3, gt[:, 3:4]], 1).astype(np.float32), 'VEC4')
        attrs['TEXCOORD_0'] = w.add_acc(gu, 'VEC2')
        new_prim = {'attributes': attrs,
                    'indices': w.add_acc(gi.reshape(-1), 'SCALAR', target=34963),
                    'material': mat_idx, 'mode': 4}
        nd = w.nodes[nid]
        if 'mesh' in nd:
            w.meshes[nd['mesh']]['primitives'].append(new_prim)
        else:
            w.meshes.append({'name': key, 'primitives': [new_prim]})
            nd['mesh'] = len(w.meshes) - 1
        stats['tris'] += len(gi)
        stats['verts'] += len(gp)
        stats['mats'].add(w.materials[mat_idx]['name'])
        node_t = np.array(w.nodes[nid].get('translation', [0, 0, 0]), np.float32)
        bboxes.append((gp.min(0) + node_t, gp.max(0) + node_t))

    seen_extras = set()
    for ex in EXTRAS.get(spec['id'], []):
        mname = ex['mesh']
        if mname in seen_extras:
            continue
        seen_extras.add(mname)
        if mname not in glbs:
            print('  !! extra glb missing:', mname)
            continue
        t_off = np.array(ex.get('t') or [0, 0, 0], np.float32)
        sock = ex.get('socket')
        if sock and 'door' in sock.lower() and sock in jointbind:
            key = canon_door(sock)
            nt, nq = jointbind[sock]
        elif np.abs(t_off).max() > 1e-4:
            best = None
            for jn, (jt, jq) in jointbind.items():
                if 'door' not in jn.lower():
                    continue
                d = float(np.linalg.norm(np.asarray(jt, np.float32) + t_off))
                if d < 0.6 and (best is None or d < best[0]):
                    best = (d, jn)
            if best:
                key = canon_door(best[1])
                nt, nq = jointbind[best[1]]
            else:
                key, nt, nq = 'body', None, None
        else:
            key, nt, nq = 'body', None, None
        # per-slot material overrides from the blueprint component
        ov_by_mi = {}
        slots = SC.get(mname, {}).get('slots', [])
        for i, slot in enumerate(slots):
            ov = (ex.get('overrides') or [])
            if i < len(ov) and ov[i]:
                mi = (slot.get('material') or '').split('.')[-1]
                if mi:
                    ov_by_mi[mi] = ov[i]
        ejs, eb = read_glb(glbs[mname])
        ematnames = [m['name'] for m in ejs.get('materials', [])]
        for mesh in ejs['meshes']:
            for prim in mesh['primitives']:
                A = prim['attributes']
                gp = acc(ejs, eb, A['POSITION']).astype(np.float32) + t_off
                gn = acc(ejs, eb, A['NORMAL']).astype(np.float32)
                gt = acc(ejs, eb, A['TANGENT']).astype(np.float32) if 'TANGENT' in A else None
                gu = acc(ejs, eb, A['TEXCOORD_0']).astype(np.float32)
                gi = acc(ejs, eb, prim['indices']).reshape(-1).astype(np.uint32)
                mi_name = ematnames[prim['material']] if 'material' in prim else None
                mi_name = ov_by_mi.get(mi_name, mi_name)
                emit_prim(gp, gn, gt, gu, gi, mi_name, key, nt, nq)

    w.nodes[0]['children'] = root_children
    mn = np.min([bb[0] for bb in bboxes], axis=0)
    mx = np.max([bb[1] for bb in bboxes], axis=0)
    extras = dict(convention='y-up, meters, +X forward, origin=CARLA vehicle pivot at ground',
                  source='CARLA (CC BY 4.0)', id=spec['id'])
    data = w.finish([0], asset_extras=extras)
    open(out_path, 'wb').write(data)
    stats['nodes'] = sorted(node_by_key)
    stats['bbox'] = (mn.round(3).tolist(), mx.round(3).tolist())
    stats['size'] = len(data)
    stats['n_textures'] = len(w.images)
    stats['mats'] = sorted(stats['mats'])
    return stats


VEHICLES = [
    dict(id='sedan_lincoln_mkz', family='sedan', src=['SK_LincolnMKZ'], body=['MI_LincolnMKZ_Bodywork'], tintable=True, bp='vehicle.lincoln.mkz_2017', disp='Lincoln MKZ 2017'),
    dict(id='sedan_dodge_charger', family='sedan', src=['SK_DodgeCharger'], body=['MI_DodgeCharger_BodyWork'], tintable=True, bp='vehicle.dodge.charger_2020', disp='Dodge Charger 2020'),
    dict(id='police_dodge_charger', family='police', src=['SK_DodgeChargerCop'], body=['MI_DodgeChargerCop_Bodywork'], tintable=False, bp='vehicle.dodge.charger_police_2020', disp='Dodge Charger Police 2020'),
    dict(id='sedan_ford_crown', family='sedan', src=['SK_FordCrown2024'], body=['MI_FordCrown02_Bodywork'], tintable=False, bp='vehicle.ford.crown', disp='Ford Crown (taxi)'),
    dict(id='sedan_tesla_model3', family='sedan', src=['SM_Tesla'], body=['MI_CarExterior_TeslaM3'], tintable=False, bp='vehicle.tesla.model3', disp='Tesla Model 3'),
    dict(id='suv_nissan_patrol', family='suv', src=['SK_NissanPatrol'], body=['MI_BodyWork_NissanPatrol2024'], tintable=True, bp='vehicle.nissan.patrol_2021', disp='Nissan Patrol 2021'),
    dict(id='hatchback_mini_cooper', family='hatchback', src=['SK_MiniCooper'], body=['MI_MiniCooper_Bodywork'], tintable=True, bp='vehicle.mini.cooper_s_2021', disp='Mini Cooper S 2021'),
    dict(id='coupe_ford_mustang', family='coupe', src=['SK_Mustang'], body=['MI_CarPaint_Metallic_Black'], tintable=True, bp='vehicle.ford.mustang', disp='Ford Mustang'),
    dict(id='minivan_bmw_gran_tourer', family='minivan', src=['SK_BMWGranTourer'], body=['MI_CarPaint_Metallic_Blue01'], tintable=True, bp='vehicle.bmw.grandtourer', disp='BMW Gran Tourer'),
    dict(id='van_mercedes_sprinter', family='van', src=['SK_MercedesSprinter'], body=['MI_MercedesSprinter_Bodywork'], tintable=True, bp='vehicle.mercedes.sprinter', disp='Mercedes Sprinter'),
    dict(id='van_volkswagen_t2', family='van', src=['SM_VolkswagenT2_Parked', 'SM_VolkswagenT2_Glass_Parked'], body=['MI_VolkswagenT2_Bodywork'], tintable=False, bp='vehicle.volkswagen.t2_2021', disp='Volkswagen T2'),
    dict(id='bus_mitsubishi_fusorosa', family='bus', src=['SK_MitsubishiFusoRosa'], body=['MI_MitsubishiFusoRosa_Bodywork'], tintable=False, bp='vehicle.mitsubishi.fusorosa', disp='Mitsubishi Fuso Rosa'),
    dict(id='truck_carlacola', family='truck', src=['SK_CarlaCola'], body=['MI_CarlaCola_BodyWork'], tintable=True, bp='vehicle.carlamotors.carlacola', disp='CarlaCola box truck'),
    dict(id='truck_european_hgv', family='truck', src=['SM_EuropeanHGV_Parked'], body=['MI_EuropeanHGV_Bodywork'], tintable=True, bp='vehicle.carlamotors.european_hgv', disp='European HGV tractor'),
    dict(id='pickup_tesla_cybertruck', family='pickup', src=['SM_Cybertruck'], body=['M_Bodywork_Cybertruck'], tintable=False, bp='vehicle.tesla.cybertruck', disp='Tesla Cybertruck'),
    dict(id='motorcycle_harley', family='motorcycle', src=['SK_Harley'], body=['MI_CarPaint_Metallic_Pink01'], tintable=True, bp='vehicle.harley-davidson.low_rider', disp='Harley-Davidson Low Rider'),
    dict(id='motorcycle_kawasaki_ninja', family='motorcycle', src=['SK_KawasakiNinja'], body=['MI_KawasakiNinja_Body'], tintable=False, body_color=[0.585, 0.968, 0.0], bp='vehicle.kawasaki.ninja', disp='Kawasaki Ninja'),
    dict(id='scooter_vespa', family='motorcycle', src=['SK_Vespa'], body=['MI_Vespa_Body'], tintable=False, body_color=[0.113, 0.351, 0.287], bp='vehicle.vespa.zx125', disp='Vespa ZX 125'),
    dict(id='hatchback_audi_a2', family='hatchback', src=['SM_AudiA2'], body=['MI_CarPaint_Metallic_Blue01'], tintable=True, bp='vehicle.audi.a2', disp='Audi A2'),
    dict(id='suv_audi_etron', family='suv', src=['SM_EtronParked'], body=['MI_CarExterior_Etron'], tintable=True, bp='vehicle.audi.etron', disp='Audi e-tron'),
    dict(id='coupe_audi_tt', family='coupe', src=['SK_AudiTT'], body=['MI_CarPaint_Metallic_Black'], tintable=True, bp='vehicle.audi.tt', disp='Audi TT'),
    dict(id='sedan_chevrolet_impala', family='sedan', src=['SK_ChevroletImpala'], body=['MI_CarPaint_Metallic_Blue01'], tintable=True, bp='vehicle.chevrolet.impala', disp='Chevrolet Impala'),
    dict(id='hatchback_citroen_c3', family='hatchback', src=['SM_Citroen_C3'], body=['MI_BodyWStaticMesh1'], tintable=True, bp='vehicle.citroen.c3', disp='Citroen C3'),
    dict(id='ambulance_ford', family='ambulance', src=['SK_Ambulance'], body=['MI_Ambulance_Bodywork'], tintable=False, bp='vehicle.ford.ambulance', disp='Ford Ambulance'),
    dict(id='firetruck_actros', family='firetruck', src=['SK_ActrosFiretruck'], body=['MI_ActrosFiretruck_Bodtwork'], tintable=False, bp='vehicle.carlamotors.firetruck', disp='Mercedes Actros Firetruck'),
    dict(id='suv_jeep_wrangler', family='suv', src=['SM_JeepWranglerRubicon'], body=['JeepWranglerRubicon_bodyside_mat', 'MI_BodyWStaticMesh7'], tintable=True, bp='vehicle.jeep.wrangler_rubicon', disp='Jeep Wrangler Rubicon'),
    dict(id='sedan_lincoln_mkz_2020', family='sedan', src=['SM_Lincoln2020Parked'], body=['MI_Lincoln2020_bodywork'], tintable=True, bp='vehicle.lincoln.mkz_2020', disp='Lincoln MKZ 2020'),
    dict(id='coupe_mercedes_c', family='coupe', src=['SM_MercedesBenzCoupeC'], body=['MI_BodyWStaticMesh4'], tintable=True, bp='vehicle.mercedes.coupe', disp='Mercedes-Benz C-Class Coupe'),
    dict(id='coupe_mercedes_c_2020', family='coupe', src=['SK_MercedesCCC'], body=['MI_MercedesCCC_bodywork'], tintable=True, bp='vehicle.mercedes.coupe_2020', disp='Mercedes-Benz C-Class Coupe 2020'),
    dict(id='micro_microlino', family='micro', src=['SM_BMWIsetta'], body=['MI_BodyWStaticMesh7'], tintable=True, bp='vehicle.micro.microlino', disp='Microlino'),
    dict(id='hatchback_mini_cooper_s', family='hatchback', src=['SM_MiniCooperS'], body=['Vh_Car_MiniCooperS_MiniMat_Mat', 'MI_BodyWStaticMesh7'], tintable=True, bp='vehicle.mini.cooper_s', disp='Mini Cooper S'),
    dict(id='hatchback_nissan_micra', family='hatchback', src=['SM_NissanMicra'], body=['MI_NissanBodyWork2'], tintable=True, bp='vehicle.nissan.micra', disp='Nissan Micra'),
    dict(id='hatchback_seat_leon', family='hatchback', src=['SM_SeatLeon'], body=['MI_BodyWStaticMesh4'], tintable=True, bp='vehicle.seat.leon', disp='SEAT Leon'),
    dict(id='hatchback_toyota_prius', family='hatchback', src=['SM_ToyotaPrius_Parked'], body=['MI_ToyotaPrius_Bodywork_Parked'], tintable=True, bp='vehicle.toyota.prius', disp='Toyota Prius'),
    dict(id='motorcycle_yamaha_yzf', family='motorcycle', src=['SK_Yamaha'], body=['MI_Yamaha_Bodywork'], tintable=True, bp='vehicle.yamaha.yzf', disp='Yamaha YZF'),
    dict(id='bicycle_bh_crossbike', family='bicycle', src=['SK_CrossBike'], body=['MI_CrossBike_Body'], tintable=True, bp='vehicle.bh.crossbike', disp='BH Crossbike'),
    dict(id='bicycle_diamondback_century', family='bicycle', src=['SK_RoadBike'], body=['MI_RoadBike_Blue'], tintable=True, bp='vehicle.diamondback.century', disp='Diamondback Century'),
    dict(id='bicycle_gazelle_omafiets', family='bicycle', src=['SK_LeisureBike'], body=['MI_Blue'], tintable=True, bp='vehicle.gazelle.omafiets', disp='Gazelle Omafiets'),
]

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    for spec in VEHICLES:
        out = f"{OUT}/vehicle_{spec['id']}.glb"
        s = assemble(spec, out)
        print(spec['id'], s['tris'], 'tris', round(s['size'] / 1e6, 1), 'MB', s['nodes'])
