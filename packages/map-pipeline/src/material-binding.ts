import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type TextureRole =
  | 'baseColor' | 'normal' | 'orm' | 'occlusion' | 'roughness' | 'metallic'
  | 'opacity' | 'emissive' | 'specular' | 'height' | 'mask' | 'unknown';

export interface SourceRenderContract {
  blend_mode?: string;
  opacity_mask_clip_value?: number;
  two_sided?: boolean;
}

export interface SourceMaterialContract {
  path: string;
  class?: string;
  parent?: string | null;
  used_textures?: string[];
  texture_parameters?: Record<string, string>;
  scalar_parameters?: Record<string, number>;
  tags?: string[];
  render?: SourceRenderContract;
}

interface MaterialsFile {
  textures_dir?: string;
  exported_textures?: Record<string, string>;
  materials?: SourceMaterialContract[];
}

export interface TextureBinding {
  source: string;
  file: string;
  role: TextureRole;
  colorSpace: 'srgb' | 'linear';
  normalConvention?: 'directx';
}

export interface MaterialBinding {
  sourcePath: string;
  name: string;
  textures: TextureBinding[];
  alphaMode: 'OPAQUE' | 'BLEND' | 'MASK';
  alphaCutoff?: number;
  anisotropy?: number;
  doubleSided: boolean;
}

export interface MaterialBindingPlan {
  schema: 'simforge.material-bindings.v1';
  materials: MaterialBinding[];
  prototypeMaterials: Record<string, string[]>;
  roleCounts: Record<TextureRole, number>;
  unresolvedTextures: string[];
  fidelityLimitations: Array<{ material: string; reasons: string[] }>;
  ormChannels: { occlusion: 'R'; roughness: 'G'; metallic: 'B' };
}

export function ueAssetLeaf(value: string): string {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1) ?? value;
  return leaf.split('.', 1)[0] ?? leaf;
}

export function normalizeFbxMaterialName(value: string): string {
  return value.replace(/\.\d{3}$/u, '').split(':').at(-1)!.trim().toLowerCase();
}

export function matchMaterialName(value: string, materials: readonly SourceMaterialContract[]): SourceMaterialContract | undefined {
  const normalized = normalizeFbxMaterialName(value);
  const exact = materials.filter((material) => normalizeFbxMaterialName(ueAssetLeaf(material.path)) === normalized);
  if (exact.length === 1) return exact[0];
  const withoutFbxSuffix = normalized.replace(/_\d+$/u, '');
  const fallback = materials.filter((material) =>
    normalizeFbxMaterialName(ueAssetLeaf(material.path)) === withoutFbxSuffix);
  return fallback.length === 1 ? fallback[0] : undefined;
}

function parameterRole(parameter: string): TextureRole | undefined {
  const name = parameter.toLowerCase();
  if (/(base\s*color|diffuse|albedo|tex\s*col|color\s*map)/u.test(name)) return 'baseColor';
  if (/normal/u.test(name)) return 'normal';
  if (/(a?orm|occlu.*rough.*metal)/u.test(name)) return 'orm';
  if (/rough/u.test(name)) return 'roughness';
  if (/metal/u.test(name)) return 'metallic';
  if (/(opacity|alpha|transparen)/u.test(name)) return 'opacity';
  if (/emiss/u.test(name)) return 'emissive';
  if (/spec/u.test(name)) return 'specular';
  if (/(height|displace)/u.test(name)) return 'height';
  if (/mask/u.test(name)) return 'mask';
  return undefined;
}

export function classifyTextureRole(filename: string, parameter?: string): TextureRole {
  const hinted = parameter === undefined ? undefined : parameterRole(parameter);
  if (hinted !== undefined) return hinted;
  const stem = path.basename(filename, path.extname(filename)).toLowerCase();
  if (/(^|[_-])(base_?color|basecolou?r|diff(?:use)?|albedo|color)(?:$|[_-])/u.test(stem)) return 'baseColor';
  if (/(^|[_-])(normal|norm|nor|normaldx|directx|opengl|n)(?:$|[_-])/u.test(stem)) return 'normal';
  if (/(^|[_-])(aorm|ormh?\d*|occlusionroughnessmetallic|packed[ab])(?:$|[_-])/u.test(stem)) return 'orm';
  if (/(^|[_-])(ao|occlusion)(?:$|[_-])/u.test(stem)) return 'occlusion';
  if (/(^|[_-])(roughness|rough|r)(?:$|[_-])/u.test(stem)) return 'roughness';
  if (/(^|[_-])(metallic|metalness|metal|m)(?:$|[_-])/u.test(stem)) return 'metallic';
  if (/(^|[_-])(opacity|alpha|transparency|transparent)(?:$|[_-])/u.test(stem)) return 'opacity';
  if (/(^|[_-])(emissive|emmisive|glow)(?:$|[_-])/u.test(stem)) return 'emissive';
  if (/(^|[_-])(specular|spec|glossiness)(?:$|[_-])/u.test(stem)) return 'specular';
  if (/(^|[_-])(height|displacement)(?:$|[_-])/u.test(stem)) return 'height';
  if (/(^|[_-])(mask|masks|msk)(?:$|[_-])/u.test(stem)) return 'mask';
  return 'unknown';
}

export function renderBinding(render: SourceRenderContract | undefined): Pick<MaterialBinding, 'alphaMode' | 'alphaCutoff' | 'doubleSided'> {
  const blend = render?.blend_mode?.toLowerCase();
  const alphaMode = blend === 'translucent' || blend === 'additive' || blend === 'modulate'
    ? 'BLEND' : blend === 'masked' ? 'MASK' : 'OPAQUE';
  return {
    alphaMode,
    ...(alphaMode === 'MASK' ? { alphaCutoff: render?.opacity_mask_clip_value ?? 0.5 } : {}),
    doubleSided: render?.two_sided ?? false,
  };
}

function fidelityReasons(material: SourceMaterialContract): string[] {
  const text = [
    material.class ?? '',
    material.parent ?? '',
    ...Object.keys(material.texture_parameters ?? {}),
    ...Object.keys(material.scalar_parameters ?? {}),
  ].join(' ').toLowerCase();
  const reasons: string[] = [];
  if (/world.*position|wind|pivot|displace/u.test(text)) reasons.push('vertex displacement/world-position animation is not expressible in core glTF PBR');
  if (/subsurface|foliage/u.test(text)) reasons.push('subsurface/foliage shading is approximated by double-sided alpha PBR');
  if (/layer|blend|macrovariation/u.test(text)) reasons.push('layered material graph is reduced to one texture set');
  if (/clearcoat|anisotrop/u.test(text)) reasons.push('custom specular lobe is not represented by the canonical material binding');
  return reasons;
}

export async function buildMaterialBindingPlan(sourceDir: string): Promise<MaterialBindingPlan> {
  const contract = JSON.parse(await readFile(path.join(sourceDir, 'materials.json'), 'utf8').catch(() =>
    '{\"exported_textures\":{},\"materials\":[]}')) as MaterialsFile;
  const vegetation = JSON.parse(await readFile(path.join(sourceDir, 'vegetation.json'), 'utf8').catch(() => '{\"vegetation_prototypes\":[]}')) as {
    vegetation_prototypes?: Array<{ mesh_asset_name?: string; materials?: Array<string | null> }>;
  };
  const exported = contract.exported_textures ?? {};
  const textureDir = path.join(sourceDir, contract.textures_dir ?? 'textures');
  const files = new Map((await readdir(textureDir).catch(() => [])).map((file) => [path.parse(file).name.toLowerCase(), file]));
  const unresolvedTextures: string[] = [];
  const counts = Object.fromEntries([
    'baseColor', 'normal', 'orm', 'occlusion', 'roughness', 'metallic', 'opacity', 'emissive', 'specular', 'height', 'mask', 'unknown',
  ].map((role) => [role, 0])) as Record<TextureRole, number>;
  const materials = (contract.materials ?? []).map((material): MaterialBinding => {
    const parameterByTexture = new Map(Object.entries(material.texture_parameters ?? {}).map(([parameter, texture]) => [texture, parameter]));
    const textures = (material.used_textures ?? []).map((source): TextureBinding | undefined => {
      const relative = exported[source];
      const exportedFile = relative === undefined ? files.get(ueAssetLeaf(source).toLowerCase()) : path.basename(relative);
      if (exportedFile === undefined) {
        unresolvedTextures.push(source);
        return undefined;
      }
      const role = classifyTextureRole(exportedFile, parameterByTexture.get(source));
      counts[role] += 1;
      return {
        source,
        file: path.join(textureDir, exportedFile),
        role,
        colorSpace: role === 'baseColor' || role === 'emissive' ? 'srgb' : 'linear',
        ...(role === 'normal' ? { normalConvention: 'directx' as const } : {}),
      };
    }).filter((value): value is TextureBinding => value !== undefined);
    const groundMaterial = (material.tags ?? []).some((tag) =>
      /road|ground|terrain|pavement|marking|lane/iu.test(tag));
    return {
      sourcePath: material.path,
      name: ueAssetLeaf(material.path),
      textures,
      ...(groundMaterial ? { anisotropy: 16 } : {}),
      ...renderBinding(material.render),
    };
  });
  const prototypeMaterials: Record<string, string[]> = {};
  for (const prototype of vegetation.vegetation_prototypes ?? []) {
    if (prototype.mesh_asset_name === undefined) continue;
    prototypeMaterials[prototype.mesh_asset_name.toLowerCase()] = (prototype.materials ?? [])
      .filter((value): value is string => typeof value === 'string')
      .map(ueAssetLeaf);
  }
  const fidelityLimitations = (contract.materials ?? []).flatMap((material) => {
    const reasons = fidelityReasons(material);
    return reasons.length === 0 ? [] : [{ material: material.path, reasons }];
  });
  return {
    schema: 'simforge.material-bindings.v1',
    materials,
    prototypeMaterials,
    roleCounts: counts,
    unresolvedTextures: [...new Set(unresolvedTextures)].sort(),
    fidelityLimitations,
    ormChannels: { occlusion: 'R', roughness: 'G', metallic: 'B' },
  };
}
