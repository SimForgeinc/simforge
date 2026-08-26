import type { CandidateLocation, MapAsset } from "@simforge-oss/studio-shared";
import { getBrowserAssetUrl } from "@/app/lib/assets/asset-url-service";
import type { Bounds, MapRecord, RoadRecord } from "@/app/lib/runtime/map-data";
import type {
  CarlaSessionStatus,
  RuntimeMapResponse,
} from "@/app/lib/runtime/runtime-types";
import { lngLatToLocalPoint } from "./coordinates";
import { semanticRoadSegments } from "@/app/lib/maps/topology/semantic-road-segments";
import { readAcceptedSemanticGraphPublication } from "@/app/lib/maps/topology/server/semantic-graph-publication-store";
import { getCandidateLocationsByMapAssetId } from "@/app/lib/db/map-candidate-location-store";
import { getMapAssetEnrichmentById } from "@/app/lib/db/map-asset-enrichment-store";
import { getMapAssetByIdFromDb, getMapArtifactLocation } from "@/app/lib/db/map-asset-store";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";
import type {
  ApproachRoad,
  BridgedMapBundle,
  GeoJsonFeature,
  GeoJsonFeatureCollection,
  LocalPoint,
  LocationFeatureFlags,
  MapLocation,
} from "./types";

type LaneBridgeIndex = {
  laneGuidToRoadIds: Map<string, string[]>;
};

const cache = new Map<string, BridgedMapBundle>();

type BridgedMapBundleOptions = {
  includeDerivedLocations?: boolean;
  forceRefresh?: boolean;
  runtime?: string | null;
};

function normalizeMapName(name: string | null | undefined): string {
  if (!name) return "";
  const normalized = name.replace(/\\/g, "/").split("/").pop() ?? name;
  return normalized.endsWith(".xodr") ? normalized.slice(0, -5) : normalized;
}

function staticEditorCarlaStatus(): CarlaSessionStatus {
  return {
    connected: false,
    current_map: null,
    normalized_map_name: null,
    server_version: null,
    client_version: null,
    available_maps: [],
    warnings: [],
  };
}

async function getGeoJsonArtifact(
  mapAssetId: string,
  artifactType: "geojson" | "signals_geojson",
): Promise<GeoJsonFeatureCollection | null> {
  const location = await getMapArtifactLocation(mapAssetId, artifactType as never);
  if (!location) return null;
  const raw = await getS3ObjectUtf8(location.bucket, location.key);
  return JSON.parse(raw) as GeoJsonFeatureCollection;
}

async function getGeoJsonPresignedUrl(mapAssetId: string): Promise<string | null> {
  const location = await getMapArtifactLocation(mapAssetId, "geojson");
  if (!location) return null;
  return getBrowserAssetUrl({
    bucket: location.bucket,
    key: location.key,
    allowedPrefix: `maps/${mapAssetId}/`,
    responseContentType: "application/geo+json; charset=utf-8",
  });
}

function cacheableBundle(bundle: BridgedMapBundle): BridgedMapBundle {
  return {
    ...bundle,
    // Presigned URLs expire independently from the stable bundle payload. The
    // server cache stores only stable map data; each API response attaches a
    // fresh URL.
    geojson_url: null,
  };
}

async function withFreshGeoJsonUrl(
  bundle: BridgedMapBundle,
  mapAssetId: string,
): Promise<BridgedMapBundle> {
  return {
    ...bundle,
    geojson_url: await getGeoJsonPresignedUrl(mapAssetId),
  };
}

function writeBundleCache(cacheKey: string, bundle: BridgedMapBundle): void {
  cache.set(cacheKey, cacheableBundle(bundle));
}

async function readBundleCache(
  cacheKey: string,
  mapAssetId: string,
): Promise<BridgedMapBundle | null> {
  const cached = cache.get(cacheKey);
  return cached ? withFreshGeoJsonUrl(cached, mapAssetId) : null;
}

function emptyFeatureFlags(): LocationFeatureFlags {
  return {
    has_stop_control: false,
    has_crosswalk: false,
    has_traffic_light: false,
    has_parking: false,
    has_sidewalk: false,
    has_bike_lane: false,
    road_markings: [],
    signal_categories: [],
  };
}

function parseSvgPathPoints(path: string): LocalPoint[] {
  const points: LocalPoint[] = [];
  const re = /([ML])\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(path)) !== null) {
    points.push({ x: Number(match[2]), y: Number(match[3]) });
  }
  return points;
}

function boundsFromPoints(points: LocalPoint[]): Bounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function boundsFromRoads(roads: RoadRecord[]): Bounds {
  if (roads.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return {
    minX: Math.min(...roads.map((road) => road.bounds.minX)),
    minY: Math.min(...roads.map((road) => road.bounds.minY)),
    maxX: Math.max(...roads.map((road) => road.bounds.maxX)),
    maxY: Math.max(...roads.map((road) => road.bounds.maxY)),
    width: Math.max(...roads.map((road) => road.bounds.maxX)) - Math.min(...roads.map((road) => road.bounds.minX)),
    height: Math.max(...roads.map((road) => road.bounds.maxY)) - Math.min(...roads.map((road) => road.bounds.minY)),
  };
}

function boundsOverlap(left: Bounds, right: Bounds, margin = 0): boolean {
  return (
    left.minX - margin <= right.maxX + margin &&
    left.maxX + margin >= right.minX - margin &&
    left.minY - margin <= right.maxY + margin &&
    left.maxY + margin >= right.minY - margin
  );
}

function centroidFromBounds(bounds: Bounds): LocalPoint {
  return { x: bounds.minX + bounds.width / 2, y: bounds.minY + bounds.height / 2 };
}

function distancePointToSegment(point: LocalPoint, start: LocalPoint, end: LocalPoint): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    return Math.sqrt(px * px + py * py);
  }
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy)));
  const projX = start.x + t * dx;
  const projY = start.y + t * dy;
  const px = point.x - projX;
  const py = point.y - projY;
  return Math.sqrt(px * px + py * py);
}

function distancePointToPath(point: LocalPoint, path: string): number {
  const points = parseSvgPathPoints(path);
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return distancePointToSegment(point, points[0]!, points[0]!);
  let best = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    best = Math.min(best, distancePointToSegment(point, points[index - 1]!, points[index]!));
  }
  return best;
}

function classifyApproachCount(count: number): string {
  if (count >= 5) return `${count}-leg junction`;
  if (count === 4) return "four-way intersection";
  if (count === 3) return "t-junction";
  if (count === 2) return "two-way connector";
  if (count === 1) return "dead end";
  return "junction";
}

function bearingToCardinal(yaw: number): string {
  const normalized = ((yaw % 360) + 360) % 360;
  if (normalized >= 337.5 || normalized < 22.5) return "eastbound";
  if (normalized < 67.5) return "north-east";
  if (normalized < 112.5) return "northbound";
  if (normalized < 157.5) return "north-west";
  if (normalized < 202.5) return "westbound";
  if (normalized < 247.5) return "south-west";
  if (normalized < 292.5) return "southbound";
  return "south-east";
}

function getRoadApproachBearing(road: RoadRecord, runtime: RuntimeMapResponse | null): string {
  const drivingSegments =
    runtime?.road_segments?.filter((segment) => String(segment.road_id) === road.id && segment.centerline.length > 0) ?? [];
  if (drivingSegments.length > 0) {
    const segment = drivingSegments[0]!;
    return bearingToCardinal(segment.centerline[segment.centerline.length - 1]?.yaw ?? 0);
  }
  const points = parseSvgPathPoints(road.path);
  if (points.length >= 2) {
    const start = points[0]!;
    const end = points[points.length - 1]!;
    const angle = (Math.atan2(-(end.y - start.y), end.x - start.x) * 180) / Math.PI;
    return bearingToCardinal(angle);
  }
  return "unknown";
}

function describeLaneConfig(road: RoadRecord): string {
  const section = road.sections[0];
  if (!section) return "road";
  const left = section.drivingLeft ?? 0;
  const right = section.drivingRight ?? 0;
  const total = left + right;
  let base = "road";
  if (left > 0 && right > 0) {
    base = left === 1 && right === 1 ? "1 lane each way" : `${total} lanes each way`;
  } else {
    base = `${Math.max(1, total)} lane${Math.max(1, total) !== 1 ? "s" : ""} one-way`;
  }
  const extras: string[] = [];
  if ((section.parkingLeft ?? 0) + (section.parkingRight ?? 0) > 0) extras.push("parking");
  if (section.laneTypes.includes("sidewalk")) extras.push("sidewalk");
  if (section.laneTypes.includes("biking")) extras.push("bike lane");
  return extras.length > 0 ? `${base}, ${extras.join(", ")}` : base;
}

function roadNamesForIds(roadIds: string[], roadsById: Map<string, RoadRecord>): string[] {
  return roadIds
    .map((roadId) => roadsById.get(roadId))
    .filter((road): road is RoadRecord => Boolean(road))
    .map((road) => road.name || `Road ${road.id}`);
}

function buildLaneBridgeIndex(xodr: string): LaneBridgeIndex {
  const laneGuidToRoadIds = new Map<string, string[]>();
  const roadPattern = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let roadMatch: RegExpExecArray | null;
  while ((roadMatch = roadPattern.exec(xodr)) !== null) {
    const attrs = roadMatch[1] ?? "";
    const body = roadMatch[2] ?? "";
    const roadId = attrs.match(/\bid="([^"]+)"/i)?.[1];
    if (!roadId) continue;
    const lanePattern = /<vectorLane\b[^>]*laneId="([^"]+)"/gi;
    let laneMatch: RegExpExecArray | null;
    while ((laneMatch = lanePattern.exec(body)) !== null) {
      const laneId = laneMatch[1]!;
      if (!laneGuidToRoadIds.has(laneId)) laneGuidToRoadIds.set(laneId, []);
      laneGuidToRoadIds.get(laneId)!.push(roadId);
    }
  }
  for (const [laneId, roadIds] of laneGuidToRoadIds) {
    laneGuidToRoadIds.set(laneId, [...new Set(roadIds)]);
  }
  return { laneGuidToRoadIds };
}

function lonLatToLocal(lon: number, lat: number, asset: MapAsset): LocalPoint | null {
  // Delegates to the proj4-backed helper so the y-down editor frame here
  // matches the projection the runtime overlay and authored GeoJSON layers
  // use. Earlier this function inlined the equirectangular formula and was a
  // hidden source of misalignment with the rest of the editor.
  return lngLatToLocalPoint(lon, lat, asset);
}

function normalizeCoordinate(value: [number, number] | [number, number, number]): [number, number] {
  return [value[0], value[1]];
}

function overlayBoundsFromGeometry(geometry: GeoJsonFeature["geometry"], asset: MapAsset): { bounds: Bounds | null; center: LocalPoint | null } {
  if (!geometry) return { bounds: null, center: null };
  if (geometry.type === "Point") {
    const point = lonLatToLocal(...normalizeCoordinate(geometry.coordinates), asset);
    if (!point) return { bounds: null, center: null };
    return { bounds: { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y, width: 0, height: 0 }, center: point };
  }
  const allPoints: LocalPoint[] = [];
  const addPoints = (coordinates: Array<[number, number] | [number, number, number]>) => {
    const points = coordinates.map(normalizeCoordinate).map(([lon, lat]) => lonLatToLocal(lon, lat, asset)).filter((p): p is LocalPoint => Boolean(p));
    allPoints.push(...points);
  };
  if (geometry.type === "LineString") addPoints(geometry.coordinates);
  if (geometry.type === "MultiLineString") geometry.coordinates.forEach(addPoints);
  if (geometry.type === "Polygon") geometry.coordinates.forEach(addPoints);
  if (geometry.type === "MultiPolygon") geometry.coordinates.forEach((polygon) => polygon.forEach(addPoints));
  if (allPoints.length === 0) return { bounds: null, center: null };
  const bounds = boundsFromPoints(allPoints);
  return { bounds, center: centroidFromBounds(bounds) };
}

function overlayBoundsFromCandidate(location: CandidateLocation, asset: MapAsset): { bounds: Bounds | null; center: LocalPoint | null } {
  const region = location.region;
  if (region.type === "Point") {
    const point = lonLatToLocal(region.coordinates[0], region.coordinates[1], asset);
    if (!point) return { bounds: null, center: null };
    return { bounds: { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y, width: 0, height: 0 }, center: point };
  }
  if (region.type === "BBOX") {
    const sw = lonLatToLocal(region.bbox.min_lng, region.bbox.min_lat, asset);
    const ne = lonLatToLocal(region.bbox.max_lng, region.bbox.max_lat, asset);
    if (!sw || !ne) return { bounds: null, center: null };
    const bounds = {
      minX: Math.min(sw.x, ne.x),
      minY: Math.min(sw.y, ne.y),
      maxX: Math.max(sw.x, ne.x),
      maxY: Math.max(sw.y, ne.y),
      width: Math.abs(sw.x - ne.x),
      height: Math.abs(sw.y - ne.y),
    };
    return { bounds, center: centroidFromBounds(bounds) };
  }
  if (region.type === "LineString") {
    return overlayBoundsFromGeometry({ type: "LineString", coordinates: region.coordinates }, asset);
  }
  return overlayBoundsFromGeometry({ type: "Polygon", coordinates: region.coordinates }, asset);
}

function signalCategoriesForBounds(bounds: Bounds, signals: GeoJsonFeatureCollection | null, asset: MapAsset): string[] {
  if (!signals) return [];
  const categories = new Set<string>();
  for (const feature of signals.features) {
    const projected = overlayBoundsFromGeometry(feature.geometry, asset);
    if (!projected.bounds) continue;
    if (!boundsOverlap(bounds, projected.bounds, 18)) continue;
    const category = String(feature.properties?.signal_category ?? "").trim();
    if (category) categories.add(category);
  }
  return [...categories];
}

function parseObjectName(name: string): string | null {
  if (name.startsWith("Stencil_STOP")) return "stop stencil";
  if (name.startsWith("Stencil_Arrow")) return "arrow marking";
  if (name.startsWith("Stencil_SLOW")) return "slow zone marking";
  if (name.startsWith("Stencil_SCHOOL")) return "school zone marking";
  if (name.startsWith("Stencil_XING")) return "crossing marking";
  if (name.startsWith("Stencil_Bicycle")) return "bike lane marking";
  if (name.startsWith("SolidSingleWhite")) return "solid white line";
  if (name.startsWith("SolidDoubleYellow")) return "solid double yellow line";
  if (name.startsWith("StopLine")) return "stop line";
  return null;
}

function featureFlagsForRoads(roads: RoadRecord[], overlayBounds: Bounds | null, signals: GeoJsonFeatureCollection | null, asset: MapAsset): LocationFeatureFlags {
  const flags = emptyFeatureFlags();
  const markings = new Set<string>();
  for (const road of roads) {
    if (road.tags.includes("stop_control" as never)) flags.has_stop_control = true;
    if (road.tags.includes("crosswalk" as never)) flags.has_crosswalk = true;
    if (road.tags.includes("parking" as never)) flags.has_parking = true;
    for (const section of road.sections) {
      if (section.laneTypes.includes("sidewalk")) flags.has_sidewalk = true;
      if (section.laneTypes.includes("biking")) flags.has_bike_lane = true;
      if ((section.parkingLeft ?? 0) + (section.parkingRight ?? 0) > 0) flags.has_parking = true;
    }
    for (const object of road.objects) {
      const parsed = parseObjectName(object.name);
      if (parsed) markings.add(parsed);
      if (object.tags.includes("crosswalk" as never)) flags.has_crosswalk = true;
      if (object.tags.includes("stop_control" as never)) flags.has_stop_control = true;
    }
  }
  flags.road_markings = [...markings];
  if (overlayBounds) {
    flags.signal_categories = signalCategoriesForBounds(overlayBounds, signals, asset);
    flags.has_traffic_light = flags.signal_categories.includes("traffic_light");
    flags.has_stop_control =
      flags.has_stop_control ||
      flags.signal_categories.includes("stop_sign") ||
      flags.signal_categories.includes("stop_line");
  }
  return flags;
}

function bridgeBoundsToRoadIds(bounds: Bounds | null, center: LocalPoint | null, roads: RoadRecord[], options: { limit?: number; preferNonIntersection?: boolean } = {}): string[] {
  if (!bounds || !center) return [];
  const scored = roads
    .map((road) => {
      const overlap = boundsOverlap(bounds, road.bounds, 12);
      const distance = distancePointToPath(center, road.path);
      if (!overlap && distance > 36) return null;
      let score = distance + (overlap ? 0 : 18);
      if (options.preferNonIntersection && !road.isIntersection) score -= 4;
      if (options.preferNonIntersection && road.isIntersection) score += 4;
      return { roadId: road.id, score };
    })
    .filter((item): item is { roadId: string; score: number } => Boolean(item))
    .sort((a, b) => a.score - b.score);
  return [...new Set(scored.slice(0, options.limit ?? 8).map((item) => item.roadId))];
}

function clusterRoadsByProximity(roads: RoadRecord[], margin = 30): RoadRecord[][] {
  const visited = new Set<string>();
  const clusters: RoadRecord[][] = [];
  for (const road of roads) {
    if (visited.has(road.id)) continue;
    const cluster: RoadRecord[] = [road];
    const queue = [road];
    visited.add(road.id);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const candidate of roads) {
        if (visited.has(candidate.id)) continue;
        if (boundsOverlap(current.bounds, candidate.bounds, margin)) {
          cluster.push(candidate);
          queue.push(candidate);
          visited.add(candidate.id);
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

function buildApproaches(roadIds: string[], roadsById: Map<string, RoadRecord>, runtime: RuntimeMapResponse | null): ApproachRoad[] {
  return roadIds
    .map((roadId) => roadsById.get(roadId))
    .filter((road): road is RoadRecord => road != null && !road.isIntersection)
    .map((road) => ({
      road_id: road.id,
      name: road.name,
      bearing: getRoadApproachBearing(road, runtime),
      lane_config: describeLaneConfig(road),
      lane_types: [...new Set(road.sections.flatMap((section) => section.laneTypes))],
      length_m: road.length,
    }));
}

function mapRoadsById(roads: RoadRecord[]): Map<string, RoadRecord> {
  return new Map(roads.map((road) => [road.id, road]));
}

function buildCandidateLocations(asset: MapAsset, candidates: CandidateLocation[], roads: RoadRecord[], roadsById: Map<string, RoadRecord>, laneBridge: LaneBridgeIndex, signals: GeoJsonFeatureCollection | null, runtime: RuntimeMapResponse | null): MapLocation[] {
  return candidates.map((candidate) => {
    const projected = overlayBoundsFromCandidate(candidate, asset);
    const laneGuids = [
      ...new Set(
        candidate.evidence.flatMap((item) =>
          Object.values(item).flatMap((value) =>
            Array.isArray(value)
              ? value
              : typeof value === "string" && /^[0-9a-f-]{20,}$/i.test(value)
                ? [value]
                : [],
          ),
        ),
      ),
    ] as string[];
    const guidRoadIds = [...new Set(laneGuids.flatMap((laneGuid) => laneBridge.laneGuidToRoadIds.get(laneGuid) ?? []))];
    const spatialRoadIds = bridgeBoundsToRoadIds(projected.bounds, projected.center, roads, {
      limit: candidate.kind === "junction" ? 16 : 8,
      preferNonIntersection:
        candidate.kind === "school_frontage" ||
        candidate.kind === "hospital_approach" ||
        candidate.kind === "bus_stop_corridor" ||
        // Commercial POIs anchor on the fronting/approach road, not the
        // adjacent intersection — e.g. a restaurant on a corner should label
        // against its frontage street, not against the cross-street.
        candidate.kind === "retail_frontage" ||
        candidate.kind === "restaurant_frontage" ||
        candidate.kind === "hotel_approach" ||
        candidate.kind === "airport_approach" ||
        candidate.kind === "shopping_mall_approach" ||
        candidate.kind === "transit_stop_corridor",
    });
    const road_ids = [...new Set([...guidRoadIds, ...spatialRoadIds])];
    const linkedRoads = road_ids.map((roadId) => roadsById.get(roadId)).filter((road): road is RoadRecord => Boolean(road));
    const bounds = projected.bounds ?? boundsFromRoads(linkedRoads);
    const feature_flags = featureFlagsForRoads(linkedRoads, bounds, signals, asset);
    return {
      id: candidate.id,
      source: "simcloud_candidate",
      kind: candidate.kind,
      classification: String(candidate.kind).replace(/_/g, " "),
      label: candidate.label,
      description: candidate.description || candidate.reason,
      bridge: guidRoadIds.length > 0 && spatialRoadIds.length > 0 ? "mixed" : guidRoadIds.length > 0 ? "guid" : "spatial",
      road_ids,
      road_count: road_ids.length,
      bounds,
      center: projected.center,
      tags: candidate.tags,
      evidence: candidate.evidence,
      feature_flags,
      approaches: buildApproaches(road_ids, roadsById, runtime),
      related_lane_guids: laneGuids,
      related_feature_ids: [],
      related_road_names: roadNamesForIds(road_ids, roadsById),
    };
  });
}

function deriveJunctionLocations(asset: MapAsset, geojson: GeoJsonFeatureCollection, roads: RoadRecord[], roadsById: Map<string, RoadRecord>, laneBridge: LaneBridgeIndex, signals: GeoJsonFeatureCollection | null, runtime: RuntimeMapResponse | null): MapLocation[] {
  return geojson.features
    .filter((feature) => String(feature.properties?.Type ?? feature.properties?.type ?? "") === "Junction")
    .map((feature) => {
      const props = feature.properties ?? {};
      const laneGuids = Array.isArray(props.Lanes)
        ? props.Lanes
            .map((item) => (item && typeof item === "object" ? String((item as { Id?: unknown }).Id ?? "") : ""))
            .filter(Boolean)
        : [];
      const guidRoadIds = [...new Set(laneGuids.flatMap((laneGuid) => laneBridge.laneGuidToRoadIds.get(laneGuid) ?? []))];
      const projected = overlayBoundsFromGeometry(feature.geometry, asset);
      const spatialRoadIds = guidRoadIds.length === 0 ? bridgeBoundsToRoadIds(projected.bounds, projected.center, roads, { limit: 12 }) : [];
      const road_ids = [...new Set([...guidRoadIds, ...spatialRoadIds])];
      const linkedRoads = road_ids.map((roadId) => roadsById.get(roadId)).filter((road): road is RoadRecord => Boolean(road));
      const approachRoadIds = linkedRoads.filter((road) => !road.isIntersection).map((road) => road.id);
      const classification = classifyApproachCount(new Set(approachRoadIds).size);
      const bounds = projected.bounds ?? boundsFromRoads(linkedRoads);
      const feature_flags = featureFlagsForRoads(linkedRoads, bounds, signals, asset);
      const gateIds = Array.isArray(props.Gates)
        ? props.Gates
            .map((item) => (item && typeof item === "object" ? String((item as { Id?: unknown }).Id ?? "") : ""))
            .filter(Boolean)
        : [];
      const tags = ["INTERSECTION"];
      if ((Array.isArray(props.Phases) ? props.Phases.length : 0) > 0 || feature_flags.has_traffic_light) {
        tags.push("INTERSECTION_SIGNALIZED");
      }
      return {
        id: `junction:${String(props.Id ?? "unknown")}`,
        source: "geojson_junction",
        kind: "junction",
        classification,
        label: classification,
        description: `${classification} bridged from GeoJSON junction geometry and related lanes.`,
        bridge: guidRoadIds.length > 0 && spatialRoadIds.length > 0 ? "mixed" : guidRoadIds.length > 0 ? "guid" : "spatial",
        road_ids,
        road_count: road_ids.length,
        bounds,
        center: projected.center,
        tags,
        evidence: [{
          junction_feature_id: props.Id,
          gate_count: Array.isArray(props.Gates) ? props.Gates.length : 0,
          lane_guid_count: laneGuids.length,
        }],
        feature_flags,
        approaches: buildApproaches(road_ids, roadsById, runtime),
        related_lane_guids: laneGuids,
        related_feature_ids: [String(props.Id ?? ""), ...gateIds].filter(Boolean),
        related_road_names: roadNamesForIds(road_ids, roadsById),
        junction_id: linkedRoads.find((road) => road.isIntersection && road.junctionId !== "-1")?.junctionId ?? undefined,
      };
    });
}

function deriveCrosswalkLocations(asset: MapAsset, geojson: GeoJsonFeatureCollection, roads: RoadRecord[], roadsById: Map<string, RoadRecord>, signals: GeoJsonFeatureCollection | null, runtime: RuntimeMapResponse | null): MapLocation[] {
  return geojson.features
    .filter((feature) => String(feature.properties?.Type ?? feature.properties?.type ?? "") === "Crosswalk")
    .map((feature) => {
      const props = feature.properties ?? {};
      const projected = overlayBoundsFromGeometry(feature.geometry, asset);
      const road_ids = bridgeBoundsToRoadIds(projected.bounds, projected.center, roads, { limit: 6 });
      const linkedRoads = road_ids.map((roadId) => roadsById.get(roadId)).filter((road): road is RoadRecord => Boolean(road));
      const bounds = projected.bounds ?? boundsFromRoads(linkedRoads);
      const feature_flags = featureFlagsForRoads(linkedRoads, bounds, signals, asset);
      feature_flags.has_crosswalk = true;
      return {
        id: `crosswalk:${String(props.Id ?? "unknown")}`,
        source: "geojson_crosswalk",
        kind: "crosswalk",
        classification: "crosswalk area",
        label: "Crosswalk",
        description: "Crosswalk area bridged to nearby OpenDRIVE roads.",
        bridge: "spatial",
        road_ids,
        road_count: road_ids.length,
        bounds,
        center: projected.center,
        tags: ["CROSSWALK"],
        evidence: [{ crosswalk_feature_id: props.Id }],
        feature_flags,
        approaches: buildApproaches(road_ids, roadsById, runtime),
        related_lane_guids: [],
        related_feature_ids: [String(props.Id ?? "")].filter(Boolean),
        related_road_names: roadNamesForIds(road_ids, roadsById),
      };
    });
}

function deriveFallbackFeatureLocations(roads: RoadRecord[], roadsById: Map<string, RoadRecord>, signals: GeoJsonFeatureCollection | null, asset: MapAsset, runtime: RuntimeMapResponse | null): MapLocation[] {
  const featureTags = ["parking", "stop_control", "single_lane_road", "single_lane_each_way", "two_lane_one_way", "two_lane_each_way"];
  const results: MapLocation[] = [];
  for (const featureTag of featureTags) {
    const matchedRoads = roads.filter((road) => !road.isIntersection && road.tags.includes(featureTag as never));
    const clusters = clusterRoadsByProximity(matchedRoads, 28);
    clusters.forEach((cluster, index) => {
      const bounds = boundsFromRoads(cluster);
      const feature_flags = featureFlagsForRoads(cluster, bounds, signals, asset);
      results.push({
        id: `fallback:${featureTag}:${index}`,
        source: "fallback_road_cluster",
        kind: featureTag,
        classification: featureTag.replace(/_/g, " "),
        label: featureTag.replace(/_/g, " "),
        description: `${featureTag.replace(/_/g, " ")} cluster derived from generated-map road tags.`,
        bridge: "heuristic",
        road_ids: cluster.map((road) => road.id),
        road_count: cluster.length,
        bounds,
        center: centroidFromBounds(bounds),
        tags: [featureTag.toUpperCase()],
        evidence: [{ feature: featureTag, fallback: true }],
        feature_flags,
        approaches: buildApproaches(cluster.map((road) => road.id), roadsById, runtime),
        related_lane_guids: [],
        related_feature_ids: [],
        related_road_names: cluster.map((road) => road.name || `Road ${road.id}`),
      });
    });
  }
  return results;
}

function dedupeLocations(locations: MapLocation[]): MapLocation[] {
  const byId = new Map<string, MapLocation>();
  for (const location of locations) byId.set(location.id, location);
  return [...byId.values()];
}

function semanticMapRecord(
  mapName: string,
  graph: NonNullable<Awaited<ReturnType<typeof readAcceptedSemanticGraphPublication>>>["semanticMap"],
): MapRecord {
  const roads: RoadRecord[] = graph.corridors.map((corridor) => {
    const points = corridor.polyline.map(({ x, y }) => ({ x, y }));
    const bounds = boundsFromPoints(points);
    return {
      id: corridor.id,
      name: `Semantic corridor ${corridor.id}`,
      junctionId: corridor.start.junctionId ?? corridor.end.junctionId ?? "-1",
      isIntersection: corridor.start.kind === "junction" || corridor.end.kind === "junction",
      length: corridor.lengthM,
      path: points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" "),
      surface: "",
      drivingSurface: "",
      laneLines: [],
      bounds,
      tags: [],
      sections: [{
        index: 0,
        label: "Semantic corridor",
        s: 0,
        drivingLeft: 0,
        drivingRight: 1,
        parkingLeft: 0,
        parkingRight: 0,
        totalDriving: 1,
        totalWidth: corridor.representativeWidthM ?? 0,
        laneTypes: [corridor.laneType],
        tags: [],
      }],
      objects: [],
    };
  });
  return {
    name: mapName,
    fileName: mapName,
    optimized: true,
    bounds: boundsFromRoads(roads),
    stats: {
      roads: roads.length,
      junctionDefinitions: new Set(graph.approaches.map((approach) => approach.junctionId)).size,
      laneTypes: roads.reduce<Record<string, number>>((counts, road) => {
        for (const section of road.sections) {
          for (const laneType of section.laneTypes) counts[laneType] = (counts[laneType] ?? 0) + 1;
        }
        return counts;
      }, {}),
      featureCounts: {
        intersection: graph.movements.length,
        parking: 0,
        single_lane_road: roads.length,
        single_lane_each_way: 0,
        two_lane_one_way: 0,
        two_lane_each_way: 0,
        crosswalk: 0,
        stop_control: 0,
      },
    },
    roads,
    crosswalks: [],
    stopMarkers: [],
  };
}

function semanticRuntimeMap(
  mapName: string,
  publication: NonNullable<Awaited<ReturnType<typeof readAcceptedSemanticGraphPublication>>>,
): RuntimeMapResponse {
  return {
    schema_version: 1,
    schema: { source: "accepted_semantic_publication", coordinates: "frontend_local" },
    map_name: mapName,
    normalized_map_name: mapName,
    map_info: {
      opendrive_sha256: publication.manifest.xodrSha256,
    },
    road_segments: semanticRoadSegments(publication.semanticMap, publication.topology),
    road_summaries: [],
    dataset_augmented: false,
  };
}

function semanticGeometryPoints(
  geometry: NonNullable<Awaited<ReturnType<typeof readAcceptedSemanticGraphPublication>>>["semanticFeatureGraph"]["features"][number]["geometry"],
): LocalPoint[] {
  if (geometry.type === "point") return [geometry.point];
  if (geometry.type === "polyline") return geometry.points;
  return geometry.rings.flat();
}

function semanticFeatureFlags(kind: string): LocationFeatureFlags {
  const flags = emptyFeatureFlags();
  flags.has_crosswalk = kind === "crosswalk" || kind === "pedestrian_conflict_zone";
  flags.has_parking = kind.startsWith("parking_");
  flags.has_sidewalk = kind === "walking_corridor" || kind === "sidewalk_surface";
  flags.has_bike_lane = kind === "bicycle_corridor";
  return flags;
}

function semanticToolLocations(
  publication: NonNullable<Awaited<ReturnType<typeof readAcceptedSemanticGraphPublication>>>,
  roads: RoadRecord[],
  roadsById: Map<string, RoadRecord>,
  runtime: RuntimeMapResponse,
): MapLocation[] {
  const graph = publication.semanticMap;
  const corridorByRsl = new Map<string, string>();
  for (const corridor of graph.corridors) {
    for (const fragment of corridor.runtimeFragments) {
      corridorByRsl.set(fragment.rsl, corridor.id);
    }
  }
  const locations: MapLocation[] = [];
  for (const feature of publication.semanticFeatureGraph.features) {
    const points = semanticGeometryPoints(feature.geometry);
    if (points.length === 0) continue;
    const bounds = boundsFromPoints(points);
    const exactRoadIds = feature.runtimeBinding.laneRsls
      .map((rsl) => corridorByRsl.get(rsl))
      .filter((id): id is string => Boolean(id));
    const road_ids = [...new Set(exactRoadIds.length > 0
      ? exactRoadIds
      : bridgeBoundsToRoadIds(bounds, centroidFromBounds(bounds), roads, { limit: 12 }))];
    if (road_ids.length === 0) continue;
    locations.push({
      id: feature.id,
      source: "semantic_feature",
      kind: feature.kind,
      classification: feature.kind.replaceAll("_", " "),
      label: feature.label,
      description: `Semantic ${feature.kind.replaceAll("_", " ")} (${feature.authoringStatus}).`,
      bridge: feature.runtimeBinding.status === "exact" ? "guid" : "spatial",
      road_ids,
      road_count: road_ids.length,
      bounds,
      center: centroidFromBounds(bounds),
      tags: [feature.kind.toUpperCase(), feature.authoringStatus.toUpperCase()],
      evidence: [{
        semantic_feature_id: feature.id,
        runtime_binding: feature.runtimeBinding.status,
        sources: feature.sources.map((source) => source.source),
      }],
      feature_flags: semanticFeatureFlags(feature.kind),
      approaches: buildApproaches(road_ids, roadsById, runtime),
      related_lane_guids: feature.runtimeBinding.laneRsls,
      related_feature_ids: [],
      related_road_names: roadNamesForIds(road_ids, roadsById),
    });
  }
  for (const approach of graph.approaches.filter((row) => row.authoringStatus === "authorable")) {
    const linked = approach.corridorIds.flatMap((id) => roadsById.get(id) ? [roadsById.get(id)!] : []);
    if (linked.length === 0) continue;
    const bounds = boundsFromRoads(linked);
    locations.push({
      id: approach.id,
      source: "semantic_approach",
      kind: "junction_approach",
      classification: `${approach.direction} junction approach`,
      label: `${approach.direction === "incoming" ? "Incoming" : "Outgoing"} approach ${approach.id}`,
      description: `Authorable ${approach.direction} approach with ${approach.laneSlots.length} semantic lane slot(s).`,
      bridge: "guid",
      road_ids: approach.corridorIds,
      road_count: approach.corridorIds.length,
      bounds,
      center: approach.boundaryCenter,
      tags: ["JUNCTION", `${approach.direction.toUpperCase()}_APPROACH`],
      evidence: [{ semantic_approach_id: approach.id, junction_id: approach.junctionId }],
      feature_flags: emptyFeatureFlags(),
      approaches: buildApproaches(approach.corridorIds, roadsById, runtime),
      junction_id: approach.junctionId,
      related_lane_guids: [],
      related_feature_ids: approach.movementIds,
      related_road_names: roadNamesForIds(approach.corridorIds, roadsById),
    });
  }
  const approachById = new Map(graph.approaches.map((row) => [row.id, row]));
  for (const movement of graph.movements.filter((row) => row.authoringStatus === "authorable")) {
    const incoming = approachById.get(movement.incomingApproachId);
    const outgoing = approachById.get(movement.outgoingApproachId);
    const road_ids = [...new Set([...(incoming?.corridorIds ?? []), ...(outgoing?.corridorIds ?? [])])];
    const linked = road_ids.flatMap((id) => roadsById.get(id) ? [roadsById.get(id)!] : []);
    if (linked.length === 0) continue;
    const bounds = boundsFromRoads(linked);
    locations.push({
      id: movement.id,
      source: "semantic_movement",
      kind: "junction_movement",
      classification: movement.turnRelation,
      label: `${movement.turnRelation} movement`,
      description: `Runtime-verified ${movement.turnRelation.toLowerCase()} movement through junction ${movement.junctionId}.`,
      bridge: "guid",
      road_ids,
      road_count: road_ids.length,
      bounds,
      center: centroidFromBounds(bounds),
      tags: ["JUNCTION_MOVEMENT", movement.turnRelation.toUpperCase()],
      evidence: [{
        semantic_movement_id: movement.id,
        representative_variant_id: movement.representativeVariantId,
      }],
      feature_flags: emptyFeatureFlags(),
      approaches: buildApproaches(road_ids, roadsById, runtime),
      junction_id: movement.junctionId,
      related_lane_guids: [],
      related_feature_ids: movement.conflictZoneIds,
      related_road_names: roadNamesForIds(road_ids, roadsById),
    });
  }
  return locations;
}

export async function getBridgedMapBundleByAssetId(
  mapAssetId: string,
  options: BridgedMapBundleOptions = {},
): Promise<BridgedMapBundle> {
  const includeDerivedLocations = options.includeDerivedLocations ?? true;
  const forceRefresh = options.forceRefresh ?? false;

  if (options.runtime && options.runtime !== "carla_ue5") {
    throw new Error(`Semantic editor tools support only carla_ue5, got ${options.runtime}.`);
  }

  const asset = await getMapAssetByIdFromDb(mapAssetId);
  if (!asset) throw new Error(`Unknown map asset: ${mapAssetId}`);

  const runtimeMapName = asset.ue5_carla_map_name;
  const assetCarlaMap = normalizeMapName(runtimeMapName);
  if (!assetCarlaMap) throw new Error(`Map asset "${mapAssetId}" has no UE5 map name.`);
  const runtimeAsset =
    runtimeMapName === asset.carla_map_name
      ? asset
      : { ...asset, carla_map_name: runtimeMapName };
  const publication = await readAcceptedSemanticGraphPublication({
    mapAssetId,
    runtime: "carla_ue5",
  });
  if (!publication) {
    throw new Error(`Accepted semantic publication missing for map "${runtimeMapName ?? assetCarlaMap}".`);
  }
  const generated = semanticMapRecord(assetCarlaMap, publication.semanticMap);
  const runtime = semanticRuntimeMap(assetCarlaMap, publication);
  const revision = publication.manifest.publicationRevision;

  if (!includeDerivedLocations) {
    const cacheKey = `${mapAssetId}:${revision}:semantic-tools:v2`;
    if (!forceRefresh) {
      const cached = await readBundleCache(cacheKey, mapAssetId);
      if (cached) return cached;
    }
    const roadsById = mapRoadsById(generated.roads);
    const locations = semanticToolLocations(
      publication,
      generated.roads,
      roadsById,
      runtime,
    );
    const bundle: BridgedMapBundle = {
      asset: runtimeAsset,
      bundle_version: publication.manifest.bundleVersion,
      runtime_bundle_key: null,
      candidate_locations: [],
      enrichment: null,
      geojson: { type: "FeatureCollection", features: [] },
      geojson_url: null,
      signals_geojson: null,
      generated,
      runtime,
      xodr: null,
      street_furniture: null,
      locations,
      bridge_summary: {
        lane_guid_count: 0,
        candidate_location_count: 0,
        derived_location_count: locations.length,
      },
      carla_status: staticEditorCarlaStatus(),
      map_match: true,
    };
    writeBundleCache(cacheKey, bundle);
    return bundle;
  }

  const carlaStatus = staticEditorCarlaStatus();
  const cacheKey = `${mapAssetId}:${revision}:semantic-full:v1`;
  if (!forceRefresh) {
    const cached = await readBundleCache(cacheKey, mapAssetId);
    if (cached) return cached;
  }

  const [candidate_locations, enrichment, geojson, signals_geojson, geojson_url] = await Promise.all([
    getCandidateLocationsByMapAssetId(mapAssetId),
    getMapAssetEnrichmentById(mapAssetId),
    getGeoJsonArtifact(mapAssetId, "geojson"),
    getGeoJsonArtifact(mapAssetId, "signals_geojson"),
    getGeoJsonPresignedUrl(mapAssetId),
  ]);

  if (!geojson) throw new Error(`GeoJSON artifact missing for map asset "${mapAssetId}".`);
  const roads = generated?.roads ?? [];
  const roadsById = mapRoadsById(roads);
  const laneBridge = buildLaneBridgeIndex("");
  const locations = dedupeLocations([
    ...semanticToolLocations(publication, roads, roadsById, runtime),
    ...buildCandidateLocations(runtimeAsset, candidate_locations, roads, roadsById, laneBridge, signals_geojson, runtime),
    ...deriveJunctionLocations(runtimeAsset, geojson, roads, roadsById, laneBridge, signals_geojson, runtime),
    ...deriveCrosswalkLocations(runtimeAsset, geojson, roads, roadsById, signals_geojson, runtime),
    ...deriveFallbackFeatureLocations(roads, roadsById, signals_geojson, runtimeAsset, runtime),
  ]).filter((location) => location.road_ids.length > 0);

  const bundle: BridgedMapBundle = {
    asset: runtimeAsset,
    bundle_version: publication.manifest.bundleVersion,
    runtime_bundle_key: null,
    candidate_locations,
    enrichment,
    geojson,
    geojson_url,
    signals_geojson,
    generated,
    runtime,
    xodr: null,
    street_furniture: null,
    locations,
    bridge_summary: {
      lane_guid_count: laneBridge.laneGuidToRoadIds.size,
      candidate_location_count: candidate_locations.length,
      derived_location_count: locations.length,
    },
    carla_status: carlaStatus,
    map_match: true,
  };

  writeBundleCache(cacheKey, bundle);
  return bundle;
}

export function clearEditorMapBundleCache(): void {
  cache.clear();
}
