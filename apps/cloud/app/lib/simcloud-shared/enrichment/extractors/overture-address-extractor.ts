import type { MapAssetAddress } from "../../map-asset-address";
import { pointInBbox, pointInPolygon } from "../point-in-polygon";
import { filterByRoadProximity, ROAD_PROXIMITY_THRESHOLD_M } from "../road-proximity-filter";
import type { ExtractedBuilding } from "./overture-building-extractor";
import { mapAssetAddressRowId } from "./overture-row-ids";

export interface OvertureAddressInput {
  id: string;
  number: string | null;
  street: string | null;
  postcode: string | null;
  country: string | null;
  region: string | null;
  locality: string | null;
  lng: number;
  lat: number;
}

export interface ExtractedAddress {
  /** Aurora-row shape ready for batch insert. */
  row: MapAssetAddress;
  /** GeoJSON Feature for the S3 `addresses` overlay layer. */
  feature: {
    type: "Feature";
    id: string;
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: Record<string, unknown>;
  };
}

export interface ExtractAddressesResult {
  addresses: ExtractedAddress[];
  /**
   * Buildings with the `address_count` field updated from the spatial
   * join. The same array is mutated in place (so callers don't need to
   * re-thread) but returned for clarity.
   */
  buildings: ExtractedBuilding[];
}

/** Lowercase, collapse whitespace, drop punctuation. Conservative on purpose
 *  — we let the trigram index handle near-misses (e.g. "Main St" vs
 *  "Main Street") so we don't have to encode every postal abbreviation here.
 */
function normalize(parts: Array<string | null | undefined>): string {
  return parts
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatAddress(parts: {
  number: string | null;
  street: string | null;
  postcode: string | null;
  locality: string | null;
  region: string | null;
}): string {
  const head = [parts.number, parts.street].filter((s) => s && s.length > 0).join(" ");
  const tail = [parts.locality, parts.region, parts.postcode]
    .filter((s) => s && s.length > 0)
    .join(", ");
  if (head && tail) return `${head}, ${tail}`;
  return head || tail;
}

/**
 * Convert raw Overture address rows into Aurora-ready rows and link each
 * to its enclosing building via point-in-polygon. Updates each affected
 * building's `address_count` in place.
 *
 * Filtering rules:
 *   - Drop addresses with no street (Overture sometimes emits postal-code-
 *     only entries that aren't useful for "600 Main St" style queries).
 *   - When `roadNetworkPoints` is provided, drop addresses farther than
 *     `proximityM` from any road point AND not inside a kept building.
 *     Addresses inside a kept building are always retained — buildings
 *     already passed their own road-proximity gate, so an address inside
 *     one is by definition near the drivable surface even if its centroid
 *     lat/lng falls outside the radius.
 */
export function extractAddresses(
  rows: OvertureAddressInput[],
  mapAssetId: string,
  buildings: ExtractedBuilding[],
  roadNetworkPoints: { lat: number; lng: number }[] | undefined,
  proximityM: number = ROAD_PROXIMITY_THRESHOLD_M,
): ExtractAddressesResult {
  if (rows.length === 0) {
    // No addresses → buildings keep their default primary_address (null).
    for (const b of buildings) b.row.primary_address = null;
    return { addresses: [], buildings };
  }

  const usable = rows.filter((r) => typeof r.street === "string" && r.street.trim().length > 0);

  // Spatial join first, since whether an address is inside a building drives
  // whether it survives the road-proximity filter below.
  const addressBuildingIdByIndex: Array<string | null> = new Array(usable.length).fill(null);
  const buildingIdToRef = new Map<string, ExtractedBuilding>();
  for (const b of buildings) buildingIdToRef.set(b.row.id, b);

  for (let i = 0; i < usable.length; i++) {
    const a = usable[i]!;
    for (const b of buildings) {
      if (!pointInBbox(a.lng, a.lat, b.bbox)) continue;
      if (b.rings == null) continue;
      const inside = b.rings.some((rings) => pointInPolygon(a.lng, a.lat, rings));
      if (inside) {
        addressBuildingIdByIndex[i] = b.row.id;
        b.row.address_count += 1;
        break;
      }
    }
  }

  // Road-proximity gate. Addresses already linked to a kept building skip
  // the check (see docstring).
  const indices: number[] = [];
  if (roadNetworkPoints && roadNetworkPoints.length > 0) {
    const gate = filterByRoadProximity(
      usable.map((a, i) => ({ a, i })),
      ({ a }) => ({ lat: a.lat, lng: a.lng }),
      roadNetworkPoints,
      proximityM,
    );
    const passedIdx = new Set(gate.map(({ i }) => i));
    for (let i = 0; i < usable.length; i++) {
      if (passedIdx.has(i) || addressBuildingIdByIndex[i] != null) indices.push(i);
    }
  } else {
    for (let i = 0; i < usable.length; i++) indices.push(i);
  }

  const out: ExtractedAddress[] = [];
  for (const i of indices) {
    const r = usable[i]!;
    const id = mapAssetAddressRowId(mapAssetId, r.id);
    const formatted = formatAddress({
      number: r.number,
      street: r.street,
      postcode: r.postcode,
      locality: r.locality,
      region: r.region,
    });
    const normalized = normalize([
      r.number,
      r.street,
      r.locality,
      r.region,
      r.postcode,
    ]);
    out.push({
      row: {
        id,
        map_asset_id: mapAssetId,
        building_id: addressBuildingIdByIndex[i] ?? null,
        number: r.number ?? null,
        street: r.street ?? null,
        postcode: r.postcode ?? null,
        formatted,
        normalized,
        lat: Number(r.lat),
        lng: Number(r.lng),
        // Filled in by attachRoadAccessToAddresses() once road segments
        // are available. Stays null when no segment is in range.
        road_access_lat: null,
        road_access_lng: null,
        road_access_distance_m: null,
        road_access_road_name: null,
      },
      feature: {
        type: "Feature",
        id,
        geometry: { type: "Point", coordinates: [Number(r.lng), Number(r.lat)] },
        properties: {
          id,
          overture_id: r.id,
          layer_id: "addresses",
          number: r.number ?? null,
          street: r.street ?? null,
          postcode: r.postcode ?? null,
          locality: r.locality ?? null,
          region: r.region ?? null,
          building_id: addressBuildingIdByIndex[i] ?? null,
          formatted,
        },
      },
    });
  }

  // Recompute address_count from kept addresses only — the in-place
  // increments above counted dropped addresses too. While we're walking
  // the kept set, also pick each building's primary_address: the formatted
  // text of the address closest to the building centroid. "Closest to
  // centroid" picks a representative even when multiple unit numbers fall
  // inside one footprint (apartment building, mall — Overture sometimes
  // emits a few hundred address points inside a single mall polygon).
  const keptByBuilding = new Map<string, number>();
  const closestByBuilding = new Map<string, { distSq: number; formatted: string }>();
  const buildingById = new Map<string, ExtractedBuilding>();
  for (const b of buildings) buildingById.set(b.row.id, b);

  for (const a of out) {
    const bid = a.row.building_id;
    if (!bid) continue;
    keptByBuilding.set(bid, (keptByBuilding.get(bid) ?? 0) + 1);
    const b = buildingById.get(bid);
    if (!b) continue;
    // Pseudo-metric squared distance — we only need an ordering for picking
    // the winner, not a real distance, so skip the sqrt + earth-radius
    // multiply. But longitude must be scaled by cos(lat) before squaring,
    // otherwise at non-equatorial latitudes a north-south address can beat
    // an actually-closer east-west address: at 37°N (Bay Area) one degree
    // of longitude is ~80% the length of one degree of latitude, so raw
    // degree-squared distance treats east-west separation as ~25% too
    // large and biases the ordering accordingly.
    const cosLat = Math.cos((b.row.centroid_lat * Math.PI) / 180);
    const dLat = a.row.lat - b.row.centroid_lat;
    const dLng = (a.row.lng - b.row.centroid_lng) * cosLat;
    const distSq = dLat * dLat + dLng * dLng;
    const prev = closestByBuilding.get(bid);
    if (prev === undefined || distSq < prev.distSq) {
      closestByBuilding.set(bid, { distSq, formatted: a.row.formatted });
    }
  }

  for (const b of buildings) {
    b.row.address_count = keptByBuilding.get(b.row.id) ?? 0;
    b.row.primary_address = closestByBuilding.get(b.row.id)?.formatted ?? null;
  }

  return { addresses: out, buildings };
}
