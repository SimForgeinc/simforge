import type { ScenarioTemplateV2 } from "@simforge/scenario";

export type CanonicalMapIdentity = {
  readonly mapVersionId: string;
  readonly sourceMapId: string;
  readonly label: string;
};

/**
 * Bind an unbound template, or repair the one proven legacy representation.
 *
 * Before the catalog exposed `sourceMapId`, generic authoring wrote the active
 * immutable `usmap_*` version id into both bindings. That exact pair is safe to
 * migrate because the active version supplies the authoritative FK-backed
 * source asset. Any other identity may be a valid template for another map and
 * is preserved so compiler validation fails closed instead of silently
 * retargeting it.
 */
export function reconcileTemplateMapIdentity(
  template: ScenarioTemplateV2,
  map: CanonicalMapIdentity,
): ScenarioTemplateV2 {
  const sourceMapId = template.sourceMap?.mapId;
  const pinMapId = template.anchor.pin?.mapId;
  const unbound = sourceMapId === undefined && pinMapId === undefined;
  const alreadyCanonical = sourceMapId === map.sourceMapId && pinMapId === map.sourceMapId;
  const provenLegacy = map.mapVersionId.startsWith("usmap_")
    && pinMapId === map.mapVersionId
    && (sourceMapId === undefined || sourceMapId === map.mapVersionId);

  if (!unbound && !alreadyCanonical && !provenLegacy) return template;
  return {
    ...template,
    sourceMap: { ...template.sourceMap, mapId: map.sourceMapId, mapName: map.label },
    anchor: {
      ...template.anchor,
      pin: { ...template.anchor.pin, mapId: map.sourceMapId },
    },
  };
}
