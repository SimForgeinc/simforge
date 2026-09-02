import type { Document, Material } from '@gltf-transform/core';

/**
 * Unreal's glTF exporter emits its "missing material" placeholder for any
 * material it could not bake: an untextured magenta base colour, usually with
 * a matching magenta emissive. The A6000 map exports carry hundreds of them
 * (car glass, street signs, sign posts, barricades). The canonical closure
 * keeps them verbatim as source truth; the presentation derivatives replace
 * them with a neutral material chosen from the material name so nothing glows
 * pink in the viewer or the native renderer.
 */

const MAGENTA_TOLERANCE = 1e-3;

export type ExportErrorMaterialClass = 'glass' | 'sign' | 'prop';

export interface ExportErrorMaterialReport {
  count: number;
  byClass: Record<ExportErrorMaterialClass, number>;
  names: string[];
}

function isMagenta(rgb: readonly number[]): boolean {
  return Math.abs(rgb[0]! - 1) < MAGENTA_TOLERANCE && Math.abs(rgb[1]!) < MAGENTA_TOLERANCE && Math.abs(rgb[2]! - 1) < MAGENTA_TOLERANCE;
}

export function isExportErrorMaterial(material: Material): boolean {
  if (material.getBaseColorTexture() !== null) return false;
  const base = material.getBaseColorFactor();
  return isMagenta(base) && (material.getEmissiveTexture() === null);
}

export function classifyExportErrorMaterial(name: string): ExportErrorMaterialClass {
  if (/glass/i.test(name)) return 'glass';
  // Sign faces ("Sign_R1-1", "Default_Sign_RIGHT TURN"), not signal posts.
  if (/sign(?!al)/i.test(name)) return 'sign';
  return 'prop';
}

function applyFallback(material: Material, kind: ExportErrorMaterialClass): void {
  material.setEmissiveFactor([0, 0, 0]);
  const strength = material.getExtension('KHR_materials_emissive_strength');
  if (strength !== null) strength.dispose();
  switch (kind) {
    case 'glass':
      material.setBaseColorFactor([0.02, 0.03, 0.04, 0.35]).setAlphaMode('BLEND').setMetallicFactor(0).setRoughnessFactor(0.15);
      break;
    case 'sign':
      material.setBaseColorFactor([0.72, 0.72, 0.7, 1]).setMetallicFactor(0).setRoughnessFactor(0.6);
      break;
    case 'prop':
      material.setBaseColorFactor([0.45, 0.45, 0.45, 1]).setMetallicFactor(0.3).setRoughnessFactor(0.65);
      break;
  }
}

/** gltf-transform `Transform`: rewrites every export-error material in place. */
export function neutralizeExportErrorMaterials(document: Document): ExportErrorMaterialReport {
  const report: ExportErrorMaterialReport = { count: 0, byClass: { glass: 0, sign: 0, prop: 0 }, names: [] };
  for (const material of document.getRoot().listMaterials()) {
    if (!isExportErrorMaterial(material)) continue;
    const kind = classifyExportErrorMaterial(material.getName());
    applyFallback(material, kind);
    report.count += 1;
    report.byClass[kind] += 1;
    report.names.push(material.getName());
  }
  return report;
}
