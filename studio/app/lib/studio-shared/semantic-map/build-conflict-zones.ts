import type {
  ConflictZone,
  JunctionMovement,
  JunctionMovementVariant,
  SemanticMapBuildConfig,
  SemanticMapDiagnostic,
} from "./types";
import {
  distance2d,
  pointAtMean,
  quantize,
  segmentIntersection,
} from "./geometry";
import { diagnostic, semanticId } from "./internal";

type ConflictEncounter = ConflictZone["encounters"][number] & {
  elevationKnown: boolean;
};

export function buildConflictZones(
  movements: JunctionMovement[],
  variants: readonly JunctionMovementVariant[],
  scope: string,
  parityOk: boolean,
  config: SemanticMapBuildConfig,
): { zones: ConflictZone[]; diagnostics: SemanticMapDiagnostic[] } {
  const diagnostics: SemanticMapDiagnostic[] = [];
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const zones: ConflictZone[] = [];
  for (let leftIndex = 0; leftIndex < movements.length; leftIndex += 1) {
    const leftMovement = movements[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < movements.length; rightIndex += 1) {
      const rightMovement = movements[rightIndex]!;
      if (leftMovement.junctionId !== rightMovement.junctionId) continue;
      if (leftMovement.incomingApproachId === rightMovement.incomingApproachId) continue;
      const encounterByKey = new Map<string, ConflictEncounter>();
      let excludedEndpoint = false;
      for (const leftVariantId of leftMovement.variantIds) {
        const left = variantById.get(leftVariantId)!;
        for (const rightVariantId of rightMovement.variantIds) {
          const right = variantById.get(rightVariantId)!;
          let leftConsumed = 0;
          for (let leftSegment = 1; leftSegment < left.polyline.length; leftSegment += 1) {
            const leftA = left.polyline[leftSegment - 1]!;
            const leftB = left.polyline[leftSegment]!;
            const leftLength = Math.hypot(leftB.x - leftA.x, leftB.y - leftA.y);
            let rightConsumed = 0;
            for (let rightSegment = 1; rightSegment < right.polyline.length; rightSegment += 1) {
              const rightA = right.polyline[rightSegment - 1]!;
              const rightB = right.polyline[rightSegment]!;
              const rightLength = Math.hypot(rightB.x - rightA.x, rightB.y - rightA.y);
              const hit = segmentIntersection(leftA, leftB, rightA, rightB);
              if (!hit || hit.angleRad < config.minimumConflictAngleRad) {
                rightConsumed += rightLength;
                continue;
              }
              const leftStationM = leftConsumed + hit.leftT * leftLength;
              const rightStationM = rightConsumed + hit.rightT * rightLength;
              if (
                leftStationM < config.conflictEndpointExclusionM ||
                rightStationM < config.conflictEndpointExclusionM ||
                left.lengthM - leftStationM < config.conflictEndpointExclusionM ||
                right.lengthM - rightStationM < config.conflictEndpointExclusionM
              ) {
                excludedEndpoint = true;
                rightConsumed += rightLength;
                continue;
              }
              const leftZ = leftA.z == null || leftB.z == null
                ? null
                : leftA.z + hit.leftT * (leftB.z - leftA.z);
              const rightZ = rightA.z == null || rightB.z == null
                ? null
                : rightA.z + hit.rightT * (rightB.z - rightA.z);
              if (
                leftZ != null && rightZ != null &&
                Math.abs(leftZ - rightZ) > config.maximumSeamElevationDeltaM
              ) {
                rightConsumed += rightLength;
                continue;
              }
              const elevationKnown = leftZ != null && rightZ != null;
              const encounter: ConflictEncounter = {
                leftVariantId,
                rightVariantId,
                point: {
                  ...hit.point,
                  z: elevationKnown ? quantize((leftZ! + rightZ!) / 2, 0.001) : null,
                },
                leftStationM: quantize(leftStationM),
                rightStationM: quantize(rightStationM),
                crossingAngleRad: quantize(hit.angleRad),
                centerlineClearanceM: 0,
                elevationKnown,
              };
              const key = `${leftVariantId}|${rightVariantId}|${encounter.point.x}|${encounter.point.y}`;
              encounterByKey.set(key, encounter);
              rightConsumed += rightLength;
            }
            leftConsumed += leftLength;
          }
        }
      }
      if (excludedEndpoint) {
        diagnostics.push(diagnostic(
          "CONFLICT_ENDPOINT_ONLY",
          "info",
          "conflict_zone",
          "A movement contact at an entry or exit boundary was excluded from conflict zones.",
          { details: { movementIds: [leftMovement.id, rightMovement.id] } },
        ));
      }
      const encounters = [...encounterByKey.values()].sort((left, right) =>
        left.point.x - right.point.x ||
        left.point.y - right.point.y ||
        left.leftVariantId.localeCompare(right.leftVariantId) ||
        left.rightVariantId.localeCompare(right.rightVariantId));
      const clusters: ConflictEncounter[][] = [];
      for (const encounter of encounters) {
        const cluster = clusters.find((candidate) =>
          candidate.every((member) =>
            distance2d(member.point, encounter.point) <= config.conflictClusterRadiusM));
        if (cluster) cluster.push(encounter);
        else clusters.push([encounter]);
      }
      for (const cluster of clusters) {
        const movementIds = [leftMovement.id, rightMovement.id].sort() as [string, string];
        const id = semanticId(
          "cfz",
          scope,
          [
            ...movementIds,
            ...cluster.flatMap((encounter) => [encounter.leftVariantId, encounter.rightVariantId]),
            String(cluster[0]!.point.x),
            String(cluster[0]!.point.y),
          ],
        );
        const elevationUnknown = cluster.some((encounter) => !encounter.elevationKnown);
        const widths = cluster.flatMap((encounter) => [
          variantById.get(encounter.leftVariantId)?.representativeWidthM,
          variantById.get(encounter.rightVariantId)?.representativeWidthM,
        ]).filter((width): width is number => width != null);
        if (elevationUnknown) {
          diagnostics.push(diagnostic(
            "CONFLICT_ELEVATION_UNKNOWN",
            "warning",
            "conflict_zone",
            "An XY crossing lacks runtime elevation and is diagnostic-only.",
            { entityId: id, details: { movementIds } },
          ));
        }
        zones.push({
          id,
          junctionId: leftMovement.junctionId,
          kind: "crossing",
          movementIds,
          center: pointAtMean(cluster.map((encounter) => encounter.point)),
          radiusM: quantize(Math.max(1, (widths.length ? Math.max(...widths) : 2) + 1)),
          encounters: cluster.map(({ elevationKnown: _elevationKnown, ...encounter }) => encounter),
          authoringStatus:
            parityOk &&
            !elevationUnknown &&
            leftMovement.authoringStatus === "authorable" &&
            rightMovement.authoringStatus === "authorable"
              ? "authorable"
              : "diagnostic_only",
          diagnosticCodes: elevationUnknown ? ["CONFLICT_ELEVATION_UNKNOWN"] : [],
        });
      }
    }
  }
  zones.sort((left, right) => left.id.localeCompare(right.id));
  const zoneIdsByMovement = new Map<string, string[]>();
  for (const zone of zones) {
    for (const movementId of zone.movementIds) {
      zoneIdsByMovement.set(movementId, [...(zoneIdsByMovement.get(movementId) ?? []), zone.id]);
    }
  }
  for (const movement of movements) {
    movement.conflictZoneIds = [...new Set(zoneIdsByMovement.get(movement.id) ?? [])].sort();
  }
  return { zones, diagnostics };
}
