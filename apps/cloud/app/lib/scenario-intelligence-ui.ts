/**
 * Scenario Intelligence UI helpers.
 *
 * Pure logic module — no React. Single source of truth for scenario family
 * definitions, tag→family mapping, candidate grouping, and evidence formatting.
 */

import {
  MAP_ASSET_DESCRIPTOR_TAGS,
  type CandidateLocation,
  type CandidateLocationKind,
} from "@simcloud/shared";

/** Matches the CandidateExplanation shape from the candidate engine. */
type CandidateExplanation = {
  summary: string;
  detectorBreakdown: {
    detectorId: string;
    confidence: number;
    explanation: string;
    matchedTags: string[];
  }[];
  primitiveSnapshot: Record<string, number | boolean | string>;
};

// ── Types ──────────────────────────────────────────────────────────────────

/** A user-facing grouping of related scenario tags and candidate locations. */
export interface ScenarioFamily {
  id: string;
  name: string;
  description: string;
  /** Lucide icon name — resolved to a component at render time. */
  iconName: string;
  /** Tag ID prefixes that belong to this family (longest-first for matching). */
  tagPrefixes: string[];
  /** CandidateLocation.kind values that map here as a fallback. */
  kindMappings: CandidateLocationKind[];
}

/** A scenario tag with its display name, definition, and candidate count. */
export interface ScenarioFamilyTag {
  id: string;
  display: string;
  definition?: string;
  candidateCount: number;
}

/** A scenario family with its tags, candidates, and summary stats. */
export interface ScenarioFamilyGroup {
  family: ScenarioFamily;
  tags: ScenarioFamilyTag[];
  candidates: CandidateLocation[];
  representativeCandidate: CandidateLocation | null;
  highConfidenceCount: number;
}

// ── Family definitions ─────────────────────────────────────────────────────

const OTHER_FAMILY: ScenarioFamily = {
  id: "other",
  name: "Other",
  description: "Scenarios that don\u2019t fall into a specific family.",
  iconName: "CircleDot",
  tagPrefixes: [],
  kindMappings: [],
};

/** The 7 scenario families used to group tags and candidate locations. */
export const SCENARIO_FAMILIES: readonly ScenarioFamily[] = [
  {
    id: "intersections",
    name: "Intersection Dynamics",
    description:
      "Signal timing, stop control, turning conflicts, and multi-leg negotiation.",
    iconName: "GitFork",
    tagPrefixes: ["INTERSECTION", "TURN"],
    kindMappings: ["junction"],
  },
  {
    id: "pedestrian",
    name: "Pedestrian Safety",
    description:
      "Crosswalk compliance, midblock crossings, and pedestrian-vehicle interactions.",
    iconName: "PersonStanding",
    tagPrefixes: [
      "SIDEWALK",
      "HIGH_PEDESTRIAN",
      "CROSSWALK",
      "PEDESTRIAN",
    ],
    kindMappings: ["crosswalk_zone"],
  },
  {
    id: "parking",
    name: "Parking & Loading",
    description:
      "Curbside conflicts, lot circulation, and occlusion from parked vehicles.",
    iconName: "SquareParking",
    tagPrefixes: ["PARKING", "CURBSIDE", "DRIVEWAY"],
    kindMappings: ["parking_cluster", "street_parking"],
  },
  {
    id: "bike",
    name: "Bike & Micromobility",
    description:
      "Protected lanes, mixing zones, and shared-use path conflicts.",
    iconName: "Bike",
    tagPrefixes: ["BIKE", "SHARED_USE"],
    kindMappings: [],
  },
  {
    id: "highway",
    name: "Road & Speed",
    description:
      "Multi-lane arterials, high-speed segments, grade changes, and lane configurations.",
    iconName: "Route",
    tagPrefixes: [
      "FREEWAY_HIGHWAY",
      "FREEWAY",
      "LANE_DROP",
      "HIGH_REAR",
      "HIGH_SPEED",
      "NARROW",
      "SPEED_LIMIT",
      "ROAD_GRADE",
    ],
    kindMappings: [],
  },
  {
    id: "school_zones",
    name: "School & Special Zones",
    description:
      "School zones, work zones, transit stops, and emergency corridors.",
    iconName: "Shield",
    tagPrefixes: [
      "SCHOOL",
      "CROSSING_GUARD",
      "TRAFFIC_SIGNAL",
      "WORK_ZONE",
      "TRANSIT",
      "EMERGENCY",
      "HEAVY_VEHICLE",
      "HOSPITAL",
      "GAS_STATION",
    ],
    kindMappings: [
      "school_frontage",
      "bus_stop_corridor",
      "hospital_approach",
      "gas_station_approach",
      // Larger transit hubs (rail, light-rail, bus station) belong with the
      // transit-stop family alongside bus_stop_corridor — same pickup/dwell
      // semantic at a different scale.
      "transit_stop_corridor",
    ],
  },
  {
    id: "visibility",
    name: "Visibility & Occlusion",
    description:
      "Sightline blockages, hard corners, and low-lighting conditions.",
    iconName: "Eye",
    tagPrefixes: ["SIGHTLINE", "LOW_LIGHTING", "OCCLUSION"],
    kindMappings: ["occlusion"],
  },
  {
    id: "commercial",
    name: "Commercial Activity",
    description:
      "Storefronts, malls, hotels, airports, and other high-density commercial zones with valet, drop-off, and pedestrian flow.",
    iconName: "Store",
    tagPrefixes: ["RETAIL", "RESTAURANT", "HOTEL", "AIRPORT", "SHOPPING_MALL"],
    kindMappings: [
      "retail_frontage",
      "restaurant_frontage",
      "hotel_approach",
      "airport_approach",
      "shopping_mall_approach",
    ],
  },
];

// ── Pre-computed lookup tables ─────────────────────────────────────────────

/** Map of tagId prefix → family, sorted longest prefix first to avoid ambiguity. */
const PREFIX_TO_FAMILY: { prefix: string; family: ScenarioFamily }[] = [];
for (const family of SCENARIO_FAMILIES) {
  for (const prefix of family.tagPrefixes) {
    PREFIX_TO_FAMILY.push({ prefix, family });
  }
}
PREFIX_TO_FAMILY.sort((a, b) => b.prefix.length - a.prefix.length);

/** Map of CandidateLocation.kind → family. */
const KIND_TO_FAMILY = new Map<string, ScenarioFamily>();
for (const family of SCENARIO_FAMILIES) {
  for (const kind of family.kindMappings) {
    KIND_TO_FAMILY.set(kind, family);
  }
}

/** Tag definitions keyed by tag ID. */
const TAG_DEFS = new Map(
  MAP_ASSET_DESCRIPTOR_TAGS.map((t) => [t.id, t.shortDefinition]),
);

// ── Public helpers ─────────────────────────────────────────────────────────

/** Convert a TAG_ID to "Tag Id" for display. */
export function humanizeTag(tagId: string): string {
  return tagId
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Return the scenario family a tag belongs to, or the "Other" fallback. */
export function getFamilyForTag(tagId: string): ScenarioFamily {
  for (const entry of PREFIX_TO_FAMILY) {
    if (tagId.startsWith(entry.prefix)) return entry.family;
  }
  return OTHER_FAMILY;
}

/** Merge `candidate.tags` and `candidate.scenarioTags`, deduplicated. */
export function getAllCandidateTags(candidate: CandidateLocation): string[] {
  const set = new Set(candidate.tags);
  if (candidate.scenarioTags) {
    for (const t of candidate.scenarioTags) set.add(t);
  }
  return [...set];
}

/** Assign a candidate to a scenario family. Tags-first, then kind fallback. */
export function assignCandidateToFamily(
  candidate: CandidateLocation,
): ScenarioFamily {
  const allTags = getAllCandidateTags(candidate);
  for (const tag of allTags) {
    const family = getFamilyForTag(tag);
    if (family !== OTHER_FAMILY) return family;
  }
  return KIND_TO_FAMILY.get(candidate.kind) ?? OTHER_FAMILY;
}

/**
 * Build the full scenario-family hierarchy from asset tags and candidate
 * locations. Returns groups sorted by total candidate count descending
 * (families with more evidence first), with empty families filtered out.
 */
export function buildScenarioFamilyGroups(
  assetTags: string[],
  candidates: CandidateLocation[],
): ScenarioFamilyGroup[] {
  // Accumulator: familyId → { tags (Set), tagCandidateCounts, candidates[] }
  const acc = new Map<
    string,
    {
      family: ScenarioFamily;
      tagIds: Set<string>;
      tagCandidateCounts: Map<string, number>;
      candidates: CandidateLocation[];
    }
  >();

  function ensure(family: ScenarioFamily) {
    if (!acc.has(family.id)) {
      acc.set(family.id, {
        family,
        tagIds: new Set(),
        tagCandidateCounts: new Map(),
        candidates: [],
      });
    }
    return acc.get(family.id)!;
  }

  // Assign each asset-level tag to a family.
  for (const tagId of assetTags) {
    const family = getFamilyForTag(tagId);
    ensure(family).tagIds.add(tagId);
  }

  // Assign each candidate to a family and count tag support.
  // Tag counts only include candidates actually assigned to this family,
  // so the count matches what's filterable within the family card.
  for (const candidate of candidates) {
    const family = assignCandidateToFamily(candidate);
    const bucket = ensure(family);
    bucket.candidates.push(candidate);

    for (const tag of getAllCandidateTags(candidate)) {
      bucket.tagCandidateCounts.set(
        tag,
        (bucket.tagCandidateCounts.get(tag) ?? 0) + 1,
      );
      bucket.tagIds.add(tag);
    }
  }

  // Build the output groups.
  const groups: ScenarioFamilyGroup[] = [];

  for (const { family, tagIds, tagCandidateCounts, candidates: familyCandidates } of acc.values()) {
    // Sort candidates within family: rank first, then confidence.
    const sorted = [...familyCandidates].sort((a, b) => {
      if (a.rank != null && b.rank != null) return a.rank - b.rank;
      if (a.rank != null) return -1;
      if (b.rank != null) return 1;
      return b.confidence - a.confidence;
    });

    // Build tag list sorted by candidate count descending.
    const tags: ScenarioFamilyTag[] = [...tagIds]
      .map((id) => ({
        id,
        display: humanizeTag(id),
        definition: TAG_DEFS.get(id),
        candidateCount: tagCandidateCounts.get(id) ?? 0,
      }))
      .sort((a, b) => b.candidateCount - a.candidateCount);

    const highConfidenceCount = sorted.filter(
      (c) => c.confidence >= 0.85,
    ).length;

    groups.push({
      family,
      tags,
      candidates: sorted,
      representativeCandidate: sorted[0] ?? null,
      highConfidenceCount,
    });
  }

  // Drop the "Other" family if it has no candidates (tags-only clutter).
  const filtered = groups.filter(
    (g) => g.family.id !== "other" || g.candidates.length > 0,
  );

  // Sort groups by candidate count desc, then tag count desc.
  filtered.sort(
    (a, b) =>
      b.candidates.length - a.candidates.length ||
      b.tags.length - a.tags.length,
  );

  return filtered;
}

/**
 * Return up to `limit` diversity-aware candidates from a family group.
 * Picks at most one per `kind` before filling the rest by rank/confidence.
 */
export function getTopCandidatesPerFamily(
  group: ScenarioFamilyGroup,
  limit = 3,
): CandidateLocation[] {
  if (group.candidates.length <= limit) return group.candidates;

  const result: CandidateLocation[] = [];
  const usedKinds = new Set<string>();

  // Round 1: one per kind.
  for (const c of group.candidates) {
    if (result.length >= limit) break;
    if (!usedKinds.has(c.kind)) {
      result.push(c);
      usedKinds.add(c.kind);
    }
  }

  // Round 2: fill remaining slots.
  for (const c of group.candidates) {
    if (result.length >= limit) break;
    if (!result.includes(c)) result.push(c);
  }

  return result;
}

// ── Evidence formatting ────────────────────────────────────────────────────

/** Safely parse and validate the JSON `explanation` field on a candidate. */
export function parseExplanation(
  candidate: CandidateLocation,
): CandidateExplanation | null {
  if (!candidate.explanation) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.explanation);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("detectorBreakdown" in parsed) ||
      !Array.isArray((parsed as { detectorBreakdown: unknown }).detectorBreakdown) ||
      !("primitiveSnapshot" in parsed) ||
      typeof (parsed as { primitiveSnapshot: unknown }).primitiveSnapshot !== "object" ||
      (parsed as { primitiveSnapshot: unknown }).primitiveSnapshot === null
    ) {
      return null;
    }
    return parsed as CandidateExplanation;
  } catch {
    return null;
  }
}

/**
 * Build a concise evidence summary for display, e.g.
 * "2 detectors \u00B7 7 approaches \u00B7 signalized"
 */
export function buildCompactEvidence(candidate: CandidateLocation): string {
  const parts: string[] = [];

  const parsed = parseExplanation(candidate);
  if (parsed) {
    // Surface interesting primitives (no detector count — that goes in the tooltip).
    const snap = parsed.primitiveSnapshot;
    if (typeof snap.approach_count === "number") {
      parts.push(`${snap.approach_count} approaches`);
    }
    if (snap.has_signal === true) parts.push("signalized");
    if (snap.is_marked === true) parts.push("marked");
    if (typeof snap.lane_count === "number") {
      parts.push(`${snap.lane_count} lanes`);
    }
    if (typeof snap.parking_spaces === "number") {
      parts.push(`${snap.parking_spaces} spaces`);
    }
  }

  return parts.length > 0 ? parts.join(" \u00B7 ") : "";
}

/** Build a tooltip-friendly string listing detector names and the full explanation. */
export function buildTooltipDetail(candidate: CandidateLocation): string {
  const lines: string[] = [];

  // Detector names
  const parsed = parseExplanation(candidate);
  if (parsed && parsed.detectorBreakdown.length > 0) {
    const names = parsed.detectorBreakdown.map((d) => d.detectorId.replace(/-/g, " "));
    lines.push(`Detectors: ${names.join(", ")}`);
  } else if (candidate.evidence.length > 0) {
    const names = candidate.evidence.map((e) => e.detectorId.replace(/-/g, " "));
    lines.push(`Detectors: ${[...new Set(names)].join(", ")}`);
  }

  // Full explanation / reason
  if (candidate.reason) {
    lines.push(candidate.reason);
  }

  return lines.join("\n");
}
