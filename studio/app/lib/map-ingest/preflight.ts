import { buildMapTopologyIndex } from "@simforge-oss/studio-shared/map-topology/build-topology-index";
import type { MapPreflight } from "@/app/lib/map-ingest/contracts";

export type MapPreflightResult =
  | { ok: true; preflight: MapPreflight; mapName: string }
  | { ok: false; reason: string };

const GEOMETRY_KINDS = ["line", "arc", "spiral", "poly3", "paramPoly3"] as const;

function extractMapName(xodrText: string): string | null {
  const header = /<header\b[^>]*>/i.exec(xodrText)?.[0];
  if (!header) return null;
  const match = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(header);
  const mapName = (match?.[1] ?? match?.[2] ?? "").trim();
  return mapName || null;
}

function geometryKindsIn(xodrText: string): string[] {
  const present = new Set<string>();
  const geometryPattern = /<geometry\b[^>]*>([\s\S]*?)<\/geometry\s*>/g;
  const childPattern = /<(line|arc|spiral|poly3|paramPoly3)\b/g;
  for (const geometry of xodrText.matchAll(geometryPattern)) {
    for (const child of (geometry[1] ?? "").matchAll(childPattern)) {
      present.add(child[1]!);
    }
  }
  return GEOMETRY_KINDS.filter((kind) => present.has(kind));
}

function hasGeoReference(xodrText: string): boolean {
  const payload = /<geoReference\b[^>]*>([\s\S]*?)<\/geoReference\s*>/i.exec(xodrText)?.[1];
  if (payload === undefined) return false;
  return payload.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim().length > 0;
}


export function runMapPreflight(xodrText: string): MapPreflightResult {
  const mapName = extractMapName(xodrText);
  if (!mapName) {
    return {
      ok: false,
      reason: "The OpenDRIVE file must have a non-empty name attribute on its <header> element.",
    };
  }

  const geometryKinds = geometryKindsIn(xodrText);
  const unsupported = geometryKinds.filter(
    (kind) => kind === "poly3" || kind === "paramPoly3",
  );
  if (unsupported.length > 0) {
    return {
      ok: false,
      reason: `Unsupported OpenDRIVE plan-view geometry: ${unsupported.join(", ")}. The topology builder supports line, arc and spiral only.`,
    };
  }

  try {
    const topology = buildMapTopologyIndex({ mapName, xodr: xodrText });
    const lanes = Object.values(topology.lanes);
    const laneCount = lanes.length;
    const drivableLaneCount = lanes.filter((lane) => lane.laneType === "driving").length;

    if (laneCount === 0) {
      return {
        ok: false,
        reason: "The OpenDRIVE file contains no usable lanes, so the editor cannot place an actor on this map.",
      };
    }
    if (drivableLaneCount === 0) {
      return {
        ok: false,
        reason: "The OpenDRIVE file contains no driving lanes, so the editor cannot place an actor on this map.",
      };
    }

    return {
      ok: true,
      mapName,
      preflight: {
        laneCount,
        junctionCount: Object.keys(topology.junctions).length,
        drivableLaneCount,
        geometryKinds,
        georeferenced: hasGeoReference(xodrText),
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: `The OpenDRIVE topology could not be built: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
