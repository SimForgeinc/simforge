import type { Document } from '@gltf-transform/core';

/**
 * Unreal's glTF exporter writes RoadRunner grass with `roughnessFactor: 2`
 * (and a `Paint` material at 10). The spec range is [0, 1]; Bevy's shader
 * clamps the value for the direct-light BRDF but feeds it raw into the
 * split-sum environment lookup (`F_AB`, radiance mip selection), so out of
 * range roughness turns every sun-lit lawn into a white specular sheet as
 * soon as the camera is close enough for the polynomial to blow up.
 *
 * Derived closures only; the canonical stays verbatim.
 */
export interface MaterialRangeReport {
  clamped: number;
  byName: Record<string, string[]>;
}

export function clampPbrFactors(document: Document): MaterialRangeReport {
  const report: MaterialRangeReport = { clamped: 0, byName: {} };
  for (const material of document.getRoot().listMaterials()) {
    const fixed: string[] = [];
    const roughness = material.getRoughnessFactor();
    if (roughness < 0 || roughness > 1) {
      material.setRoughnessFactor(Math.min(1, Math.max(0, roughness)));
      fixed.push(`roughnessFactor:${roughness}`);
    }
    const metallic = material.getMetallicFactor();
    if (metallic < 0 || metallic > 1) {
      material.setMetallicFactor(Math.min(1, Math.max(0, metallic)));
      fixed.push(`metallicFactor:${metallic}`);
    }
    if (fixed.length > 0) {
      report.clamped += 1;
      report.byName[material.getName()] = fixed;
    }
  }
  return report;
}
