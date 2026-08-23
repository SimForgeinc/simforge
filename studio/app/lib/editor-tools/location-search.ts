import type {
  BridgedMapBundle,
  GetLocationInput,
  ListLocationsInput,
  LocationCatalogOption,
  LocationCatalogFacet,
  LocationCatalogResult,
  LocationCatalogFacets,
  LocationCatalogItem,
  LocationSearchInput,
  MapLocation,
} from "@/app/lib/editor-map/types";

function normalized(value: string): string {
  return value.trim().toLowerCase();
}

const FEATURE_TO_KINDS: Record<string, string[]> = {
  intersection: ["junction"],
  crosswalk: ["crosswalk"],
  parking: ["street_parking", "parking", "parking_zone"],
  stop_control: [],
  single_lane_road: ["single_lane_road"],
  single_lane_each_way: ["single_lane_each_way"],
  two_lane_one_way: ["two_lane_one_way"],
  two_lane_each_way: ["two_lane_each_way"],
};

const TEXT_HINTS: Array<{ terms: string[]; kinds?: string[]; tags?: string[] }> = [
  { terms: ["school", "school zone"], kinds: ["school_frontage"], tags: ["SCHOOL_ZONE_BOUNDARY"] },
  { terms: ["hospital", "emergency"], kinds: ["hospital_approach"], tags: ["EMERGENCY_VEHICLE_HOSPITAL"] },
  { terms: ["bus stop", "transit"], kinds: ["bus_stop_corridor", "transit_stop_corridor"], tags: ["TRANSIT_BUS_STOP", "TRANSIT_STOP_CORRIDOR"] },
  { terms: ["intersection", "junction", "four-way", "t-junction"], kinds: ["junction"] },
  { terms: ["crosswalk", "crossing"], kinds: ["crosswalk"] },
  { terms: ["retail", "store", "shop"], kinds: ["retail_frontage"], tags: ["RETAIL_FRONTAGE"] },
  { terms: ["restaurant", "cafe", "diner"], kinds: ["restaurant_frontage"], tags: ["RESTAURANT_FRONTAGE"] },
  { terms: ["hotel", "motel", "lodging"], kinds: ["hotel_approach"], tags: ["HOTEL_APPROACH"] },
  { terms: ["airport", "terminal"], kinds: ["airport_approach"], tags: ["AIRPORT_APPROACH"] },
  { terms: ["mall", "shopping mall", "shopping center"], kinds: ["shopping_mall_approach"], tags: ["SHOPPING_MALL_APPROACH"] },
  { terms: ["train station", "transit hub", "rail station"], kinds: ["transit_stop_corridor"], tags: ["TRANSIT_STOP_CORRIDOR"] },
];

function matchesText(location: MapLocation, query: string): boolean {
  if (!query.trim()) return true;
  const q = normalized(query);
  const haystack = [
    location.kind,
    location.classification,
    location.label,
    location.description,
    ...location.tags,
    ...(location.related_road_names ?? []),
  ]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}

function hintedKindsAndTags(text: string): { kinds: Set<string>; tags: Set<string> } {
  const kinds = new Set<string>();
  const tags = new Set<string>();
  const lowered = normalized(text);
  for (const hint of TEXT_HINTS) {
    if (hint.terms.some((term) => lowered.includes(term))) {
      for (const kind of hint.kinds ?? []) kinds.add(kind);
      for (const tag of hint.tags ?? []) tags.add(tag);
    }
  }
  return { kinds, tags };
}

function locationHasLaneTypes(location: MapLocation, laneTypes: string[]): boolean {
  if (laneTypes.length === 0) return true;
  const available = new Set(
    (location.approaches ?? []).flatMap((approach) =>
      approach.lane_types.map((laneType) => normalized(laneType)),
    ),
  );
  return laneTypes.every((laneType) => available.has(normalized(laneType)));
}

function locationHasName(location: MapLocation, value: string): boolean {
  if (!value.trim()) return true;
  const needle = normalized(value);
  return (location.related_road_names ?? []).some((name) => normalized(name).includes(needle));
}

function locationMatchesFeatures(location: MapLocation, features: string[]): boolean {
  if (features.length === 0) return true;
  return features.every((feature) => {
    const key = normalized(feature);
    if (key === "intersection") return location.kind === "junction";
    if (key === "crosswalk") return location.feature_flags.has_crosswalk;
    if (key === "stop_control") return location.feature_flags.has_stop_control;
    if (key === "parking") return location.feature_flags.has_parking || location.kind.includes("parking");
    if (
      key === "single_lane_road" ||
      key === "single_lane_each_way" ||
      key === "two_lane_one_way" ||
      key === "two_lane_each_way"
    ) {
      return location.kind === key || location.classification === key.replace(/_/g, " ");
    }
    return false;
  });
}

function scoreLocation(location: MapLocation, input: LocationSearchInput): number {
  let score = 0;
  if (location.source === "simcloud_candidate") score += 25;
  if (location.bridge === "guid") score += 20;
  if (location.bridge === "mixed") score += 18;
  if (location.kind === "junction") score += 12;
  if (location.feature_flags.has_traffic_light) score += 3;
  if (location.feature_flags.has_crosswalk) score += 2;
  if ((input.kinds ?? []).some((kind) => normalized(kind) === normalized(location.kind))) score += 15;
  if ((input.tags ?? []).some((tag) => location.tags.includes(tag))) score += 10;
  if (input.text && matchesText(location, input.text)) score += 8;
  return score;
}

export function searchLocations(bundle: BridgedMapBundle, input: LocationSearchInput): MapLocation[] {
  const features = (input.features ?? []).map(normalized);
  const explicitKinds = new Set((input.kinds ?? []).map(normalized));
  for (const feature of features) {
    for (const kind of FEATURE_TO_KINDS[feature] ?? []) explicitKinds.add(normalized(kind));
  }

  const explicitTags = new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean));
  if (input.text) {
    const hinted = hintedKindsAndTags(input.text);
    for (const kind of hinted.kinds) explicitKinds.add(normalized(kind));
    for (const tag of hinted.tags) explicitTags.add(tag);
  }

  const laneTypes = (input.lane_types ?? []).map(normalized);
  const junctionType = normalized(input.junction_type ?? "");
  const maxResults = Math.max(1, input.max_results ?? 8);

  return bundle.locations
    .filter((location) => {
      if (explicitKinds.size > 0 && !explicitKinds.has(normalized(location.kind))) return false;
      if (explicitTags.size > 0 && ![...explicitTags].every((tag) => location.tags.includes(tag))) return false;
      if (!locationMatchesFeatures(location, features)) return false;
      if (!matchesText(location, input.text ?? "")) return false;
      if (junctionType && !normalized(location.classification).includes(junctionType)) return false;
      if (!locationHasLaneTypes(location, laneTypes)) return false;
      if (!locationHasName(location, input.name_contains ?? "")) return false;
      if (input.has_parking && !location.feature_flags.has_parking) return false;
      if (input.has_sidewalk && !location.feature_flags.has_sidewalk) return false;
      if (input.has_bike_lane && !location.feature_flags.has_bike_lane) return false;
      if (input.has_stop_control && !location.feature_flags.has_stop_control) return false;
      if (input.has_crosswalk && !location.feature_flags.has_crosswalk) return false;
      if (input.has_traffic_light && !location.feature_flags.has_traffic_light) return false;
      return true;
    })
    .sort((left, right) => scoreLocation(right, input) - scoreLocation(left, input))
    .slice(0, maxResults);
}

export function getLocationById(bundle: BridgedMapBundle, locationId: string): MapLocation | null {
  return bundle.locations.find((location) => location.id === locationId) ?? null;
}

function incrementCount(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function sortFacetCounts(counts: Map<string, number>) {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function buildFacet(
  locations: MapLocation[],
  values: string[],
  getter: (location: MapLocation) => string[],
): LocationCatalogFacet[] {
  return values.map((value) => ({
    value,
    count: locations.filter((location) => getter(location).includes(value)).length,
    examples: locations
      .filter((location) => getter(location).includes(value))
      .slice(0, 3)
      .map((location) => location.label),
  }));
}

export function getLocationCatalog(bundle: BridgedMapBundle): LocationCatalogResult {
  const locations = bundle.locations;
  const options: LocationCatalogOption[] = [
    ...buildFacet(
      locations,
      [...new Set(locations.map((location) => location.kind))].sort(),
      (location) => [location.kind],
    ).map((facet) => ({
      selector: `kind:${facet.value}`,
      selector_type: "kind" as const,
      count: facet.count,
      examples: facet.examples,
    })),
    ...buildFacet(
      locations,
      [...new Set(locations.map((location) => location.classification))].sort(),
      (location) => [location.classification],
    ).map((facet) => ({
      selector: `classification:${facet.value}`,
      selector_type: "classification" as const,
      count: facet.count,
      examples: facet.examples,
    })),
    ...buildFacet(
      locations,
      [...new Set(locations.flatMap((location) => location.tags))].sort(),
      (location) => location.tags,
    ).map((facet) => ({
      selector: `tag:${facet.value}`,
      selector_type: "tag" as const,
      count: facet.count,
      examples: facet.examples,
    })),
  ].sort((left, right) =>
    right.count - left.count ||
    left.selector_type.localeCompare(right.selector_type) ||
    left.selector.localeCompare(right.selector),
  );

  return {
    total_locations: locations.length,
    options,
  };
}

export function listLocations(bundle: BridgedMapBundle, input: ListLocationsInput = {}): {
  items: LocationCatalogItem[];
  facets: LocationCatalogFacets;
} {
  const kinds = new Set((input.kinds ?? []).map(normalized));
  const classifications = new Set((input.classifications ?? []).map(normalized));
  const tags = new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean));
  const roadNameNeedle = normalized(input.road_name_contains ?? "");
  const limit = Math.max(1, input.limit ?? 50);

  const filtered = bundle.locations.filter((location) => {
    if (kinds.size > 0 && !kinds.has(normalized(location.kind))) return false;
    if (classifications.size > 0 && !classifications.has(normalized(location.classification))) return false;
    if (tags.size > 0 && ![...tags].every((tag) => location.tags.includes(tag))) return false;
    if (roadNameNeedle && !(location.related_road_names ?? []).some((name) => normalized(name).includes(roadNameNeedle))) return false;
    if (input.has_parking && !location.feature_flags.has_parking) return false;
    if (input.has_sidewalk && !location.feature_flags.has_sidewalk) return false;
    if (input.has_bike_lane && !location.feature_flags.has_bike_lane) return false;
    if (input.has_stop_control && !location.feature_flags.has_stop_control) return false;
    if (input.has_crosswalk && !location.feature_flags.has_crosswalk) return false;
    if (input.has_traffic_light && !location.feature_flags.has_traffic_light) return false;
    return true;
  });

  const kindCounts = new Map<string, number>();
  const classificationCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  for (const location of filtered) {
    incrementCount(kindCounts, location.kind);
    incrementCount(classificationCounts, location.classification);
    for (const tag of location.tags) incrementCount(tagCounts, tag);
  }

  const items = filtered.slice(0, limit).map((location) => ({
    id: location.id,
    label: location.label,
    kind: location.kind,
    classification: location.classification,
    tags: location.tags,
    feature_flags: location.feature_flags,
    road_count: location.road_count,
    related_road_names: location.related_road_names,
  }));

  return {
    items,
    facets: {
      kinds: sortFacetCounts(kindCounts).map((entry) => ({
        ...entry,
        examples: filtered.filter((location) => location.kind === entry.value).slice(0, 3).map((location) => location.label),
      })),
      classifications: sortFacetCounts(classificationCounts).map((entry) => ({
        ...entry,
        examples: filtered.filter((location) => location.classification === entry.value).slice(0, 3).map((location) => location.label),
      })),
      tags: sortFacetCounts(tagCounts).map((entry) => ({
        ...entry,
        examples: filtered.filter((location) => location.tags.includes(entry.value)).slice(0, 3).map((location) => location.label),
      })),
    },
  };
}

export function getLocation(
  bundle: BridgedMapBundle,
  input: GetLocationInput,
) {
  const locationId = input.location_id?.trim();
  if (locationId) {
    const location = getLocationById(bundle, locationId);
    return {
      items: location ? [location] : [],
      total_matches: location ? 1 : 0,
    };
  }

  const selectors = (input.selectors ?? []).map((selector) => selector.trim()).filter(Boolean);
  const kinds = new Set<string>();
  const classifications = new Set<string>();
  const tags = new Set<string>();
  for (const selector of selectors) {
    const [rawType, ...rawValue] = selector.split(":");
    const value = rawValue.join(":").trim();
    if (!value) continue;
    const selectorType = normalized(rawType ?? "");
    if (selectorType === "kind") kinds.add(normalized(value));
    else if (selectorType === "classification") classifications.add(normalized(value));
    else if (selectorType === "tag") tags.add(value);
  }
  const limit = Math.max(1, input.limit ?? 25);

  const filtered = bundle.locations.filter((location) => {
    if (kinds.size > 0 && !kinds.has(normalized(location.kind))) return false;
    if (classifications.size > 0 && !classifications.has(normalized(location.classification))) return false;
    if (tags.size > 0 && ![...tags].every((tag) => location.tags.includes(tag))) return false;
    return true;
  });

  return {
    items: filtered.slice(0, limit),
    total_matches: filtered.length,
  };
}
