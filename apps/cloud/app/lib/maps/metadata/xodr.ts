import type { MapCoordinateRef, MapSource, XodrJunctionMatchInfo } from "@simcloud/shared";
import {
  parseDatum,
  parseHorizontalUnits,
  parseProjOrigin,
  parseVerticalUnits,
  projProjectionType,
  utmZoneFromLonLat,
} from "./parse-proj";
import { classifyAndEnrichSignal } from "./xodr-signals";
import {
  type CoordTransform,
  localToLonLat,
  parseGeometrySegments,
  resolveSTtoXY,
} from "./xodr-geometry";

export function attr(xml: string, name: string): string | undefined {
  // \b anchors the attribute name so e.g. `attr(s, "t")` can't match the
  // trailing `t="` inside `height="…"`, or `type` inside `subtype`.
  const re = new RegExp(`\\b${name}="([^"]*)"`, "i");
  const m = xml.match(re);
  return m?.[1]?.trim();
}

/** GeoReference may use CDATA and optional namespaces on the tag. */
export function extractGeoReferenceText(xodr: string): string | undefined {
  const cleaned = stripXmlComments(xodr);
  const m = cleaned.match(/<geoReference[^>]*>([\s\S]*?)<\/geoReference>/i);
  if (!m?.[1]) return undefined;
  let inner = m[1].trim();
  const cdata = inner.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata?.[1]) inner = cdata[1].trim();
  return inner.replace(/\s+/g, " ").trim() || undefined;
}

export function stripXmlComments(s: string): string {
  return s.replace(/<!--[\s\S]*?-->/g, "");
}

function countRegex(re: RegExp, s: string): number {
  const m = s.match(re);
  return m?.length ?? 0;
}

export function extractVectorSceneFromHeader(xodr: string): { program?: string; version?: string } {
  const cleaned = stripXmlComments(xodr);
  const headerEnd = cleaned.search(/<\/header>/i);
  const headerSlice = headerEnd >= 0 ? cleaned.slice(0, headerEnd) : cleaned.slice(0, 8000);
  const vs = headerSlice.match(
    /<vectorScene[^>]*\bprogram="([^"]*)"[^>]*\bversion="([^"]*)"[^>]*>/i,
  );
  if (vs) {
    return { program: vs[1], version: vs[2] };
  }
  const vs2 = headerSlice.match(
    /<vectorScene[^>]*\bversion="([^"]*)"[^>]*\bprogram="([^"]*)"[^>]*>/i,
  );
  if (vs2) {
    return { program: vs2[2], version: vs2[1] };
  }
  const loose = headerSlice.match(/<vectorScene([^>]*)>/i);
  if (loose?.[1]) {
    const attrs = loose[1];
    return {
      program: attr(attrs, "program"),
      version: attr(attrs, "version"),
    };
  }
  return {};
}

export function extractMapSourceFromXodr(xodr: string, rrdataSchemaVersion?: string): MapSource {
  const cleaned = stripXmlComments(xodr);
  const headerOpen = cleaned.match(/<header([^>]*)\/?>/i);
  const h = headerOpen?.[1] ?? "";
  const revMajor = attr(h, "revMajor");
  const revMinor = attr(h, "revMinor");
  const opendrive_version =
    revMajor != null && revMinor != null ? `${revMajor}.${revMinor}` : undefined;
  const dateRaw = attr(h, "date");
  const exported_at = dateRaw
    ? dateRaw.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(dateRaw)
      ? dateRaw
      : `${dateRaw}Z`
    : undefined;
  const { program, version } = extractVectorSceneFromHeader(cleaned);
  const vendor = attr(h, "vendor");
  const tool =
    vendor?.toLowerCase().includes("mathworks") || (program?.trim().length ?? 0) > 0
      ? "RoadRunner"
      : undefined;

  return {
    tool,
    tool_version: version,
    vendor,
    opendrive_version,
    rrdata_schema_version: rrdataSchemaVersion,
    exported_at,
  };
}

export function extractCoordinateRefFromXodr(
  xodr: string,
  rrVersion?: string,
): MapCoordinateRef {
  const proj_string = extractGeoReferenceText(xodr);
  if (!proj_string) {
    return { source_file: "xodr", rr_version: rrVersion, editor_offset_m: { x: 0, y: 0 } };
  }
  const origin = parseProjOrigin(proj_string);
  const projection_type = projProjectionType(proj_string);
  const datum = parseDatum(proj_string);
  const horizontal_units = parseHorizontalUnits(proj_string);
  const vertical_units = parseVerticalUnits(proj_string);
  let utm_zone: string | undefined;
  if (origin) {
    utm_zone = utmZoneFromLonLat(origin.lon, origin.lat);
  }

  const euclidean_bbox_m = extractEuclideanBboxFromHeader(xodr);

  return {
    proj_string,
    origin_lat: origin?.lat,
    origin_lon: origin?.lon,
    origin_alt_m: 0,
    projection_type,
    datum,
    utm_zone,
    euclidean_bbox_m,
    editor_offset_m: { x: 0, y: 0 },
    vertical_units: vertical_units ?? horizontal_units,
    horizontal_units,
    source_file: "xodr",
    rr_version: rrVersion,
  };
}

/**
 * Extract the euclidean bounding box from the OpenDRIVE <header> attributes.
 *
 * The xodr <header> carries authoritative north/south/east/west attributes in
 * the RoadRunner euclidean frame (metres from the projection origin), stored in
 * scientific notation e.g. north="4.2094731190376535e+01". JavaScript's
 * Number() handles scientific notation natively, so the full attribute value
 * just needs to be captured intact — the regex [^"]+ does this correctly.
 *
 * The previous implementation (computeEuclideanBboxFromXodr) derived the bbox
 * from <geometry x= y=> start-point coordinates instead. Geometry start points
 * are only the beginning of each road segment — they systematically under-represent
 * the true map extent, producing a bbox that is both smaller and offset from the
 * correct values (e.g. north=-5.23 instead of +42.09).
 */
export function extractEuclideanBboxFromHeader(
  xodr: string,
): MapCoordinateRef["euclidean_bbox_m"] {
  const cleaned = stripXmlComments(xodr);
  const headerMatch = cleaned.match(/<header([^>]*)>/i);
  if (!headerMatch?.[1]) return undefined;
  const h = headerMatch[1];

  function headerAttrNum(name: string): number | undefined {
    // Use [^"]+ to capture the full value including scientific notation exponent.
    const m = h.match(new RegExp(`\\b${name}="([^"]+)"`));
    if (!m?.[1]) return undefined;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : undefined;
  }

  const north = headerAttrNum("north");
  const south = headerAttrNum("south");
  const east = headerAttrNum("east");
  const west = headerAttrNum("west");

  if (north == null || south == null || east == null || west == null) return undefined;
  return { north, south, east, west };
}

export type JunctionRoadDegreeCounts = {
  /** Junctions where 1-2 roads meet (parking lot entrances, road merges/splits). */
  "2_or_fewer": number;
  /** T-intersections: 3 roads meeting. */
  "3": number;
  /** Standard 4-way intersections. */
  "4": number;
  /** Complex intersections: 5 or more roads meeting. */
  "5_plus": number;
};

/** Breakdown of <signal> elements by category, classified from the name= attribute.
 *  RoadRunner uses MUTCD naming conventions (Sign_R1-1 = stop sign, etc.). */
export type SignalBreakdown = {
  traffic_lights: number;
  stop_signs: number;
  yield_signs: number;
  speed_limit_signs: number;
  regulatory_signs: number;
  turn_restriction_signs: number;
  parking_signs: number;
  warning_signs: number;
  school_signs: number;
  street_name_signs: number;
  bus_stops: number;
  stop_lines: number;
  other_signs: number;
  unknown: number;
};

/** Junction-level control counts derived by cross-referencing signals on
 *  incoming roads with junction topology. */
export type JunctionControlCounts = {
  /** Junctions with at least one traffic light on an incoming road. */
  signalized: number;
  /** Junctions with at least one stop sign on an incoming road. */
  stop_sign_controlled: number;
  /** Junctions where ALL incoming roads (degree ≥ 2) have stop signs. */
  allway_stop: number;
};

export type XodrRoadStats = {
  total_roads: number;
  total_junctions: number;
  total_centerline_length_m: number;
  lane_counts: Record<string, number>;
  roads_with_bike_lanes: number;
  /** Total length (metres) of roads with at least one biking lane. */
  bike_lane_length_m: number;
  /** Length (metres) of roads with both biking and driving lanes (shared road). */
  shared_bike_lane_length_m: number;
  roads_with_sidewalks: number;
  sidewalk_length_m: number;
  roads_with_parking_lanes: number;
  /** Total length (metres) of roads with at least one parking lane. */
  parking_lane_length_m: number;
  signal_count: number;
  signal_breakdown: SignalBreakdown;
  crosswalk_count: number;
  speed_limits_mph: number[];
  max_grade_pct: number;
  segments_above_4pct_grade: number;
  /** Total length (metres) of roads with net grade above 4%. */
  length_above_4pct_grade_m: number;
  /** Count of junctions bucketed by number of distinct incoming roads.
   *  Derived from distinct incomingRoad= values across <connection> elements
   *  within each <junction> block. Enables queries like "maps with 5-way intersections". */
  junction_road_degree_counts: JunctionRoadDegreeCounts;
  /** Junction-level signal/sign control counts. */
  junction_control_counts: JunctionControlCounts;
};

export function extractXodrRoadStats(xodr: string): XodrRoadStats {
  const cleaned = stripXmlComments(xodr);
  const total_roads = countRegex(/<road\s/gi, cleaned);
  const total_junctions = countRegex(/<junction\s/gi, cleaned);
  const signal_count = countRegex(/<signal\s/gi, cleaned);

  // Classify signals using the shared classifier (single source of truth).
  const signal_breakdown: SignalBreakdown = {
    traffic_lights: 0,
    stop_signs: 0,
    yield_signs: 0,
    speed_limit_signs: 0,
    regulatory_signs: 0,
    turn_restriction_signs: 0,
    parking_signs: 0,
    warning_signs: 0,
    school_signs: 0,
    street_name_signs: 0,
    bus_stops: 0,
    stop_lines: 0,
    other_signs: 0,
    unknown: 0,
  };

  // Map signal_category → SignalBreakdown key
  const categoryToKey: Record<string, keyof SignalBreakdown> = {
    traffic_light: "traffic_lights",
    stop_sign: "stop_signs",
    yield_sign: "yield_signs",
    speed_limit_sign: "speed_limit_signs",
    regulatory_sign: "regulatory_signs",
    turn_restriction_sign: "turn_restriction_signs",
    parking_sign: "parking_signs",
    warning_sign: "warning_signs",
    school_sign: "school_signs",
    street_name_sign: "street_name_signs",
    bus_stop: "bus_stops",
    stop_line: "stop_lines",
    other_sign: "other_signs",
    unknown: "unknown",
  };

  const signalRe = /<signal\b[^>]*>/gi;
  let sigM: RegExpExecArray | null;
  while ((sigM = signalRe.exec(cleaned)) !== null) {
    const tag = sigM[0];
    const name = tag.match(/\bname="([^"]*)"/i)?.[1] ?? "";
    const type = tag.match(/\btype="([^"]*)"/i)?.[1] ?? "";
    const { signal_category } = classifyAndEnrichSignal(name, type);
    const key = categoryToKey[signal_category] ?? "unknown";
    signal_breakdown[key]++;
  }

  // Sum road[@length] — one entry per road, authoritative centerline length.
  // The previous implementation summed geometry[@length] (1722 geometry elements
  // vs 342 roads) which happens to produce the same total for this map because
  // RoadRunner emits one geometry per road for straight segments; but it would
  // over-count on maps with multiple geometry entries per road (curves, spirals).
  let lengthSum = 0;
  const lenRe = /<road\b[^>]*\blength="([-0-9.eE+]+)"/gi;
  let lm: RegExpExecArray | null;
  while ((lm = lenRe.exec(cleaned)) !== null) {
    const L = Number(lm[1]);
    if (Number.isFinite(L) && L >= 0) lengthSum += L;
  }

  const laneCounts: Record<string, number> = {};
  const laneRe = /<lane\b[^>]*\btype="([^"]+)"/gi;
  let jam: RegExpExecArray | null;
  while ((jam = laneRe.exec(cleaned)) !== null) {
    const laneType = jam[1];
    if (!laneType) continue;
    const t = laneType.toLowerCase();
    laneCounts[t] = (laneCounts[t] ?? 0) + 1;
  }

  let roads_with_bike_lanes = 0;
  let bike_lane_length_m = 0;
  let shared_bike_lane_length_m = 0;
  let roads_with_sidewalks = 0;
  let sidewalk_length_m = 0;
  let roads_with_parking_lanes = 0;
  let parking_lane_length_m = 0;
  // Track which signal categories are present on each road (road_id → Set<signal_category>).
  // Used later to determine junction-level signal/sign control by cross-referencing
  // with junction incoming roads AND connecting roads.
  const roadSignalCategories = new Map<string, Set<string>>();
  // Map connecting road → junction ID. In OpenDRIVE, a road with junction="238"
  // is a connecting road inside that junction. Traffic lights and stop signs are
  // often placed on these connecting roads, not on the incoming approach roads.
  const connectingRoadJunction = new Map<string, string>();
  const roadBlocks = cleaned.split(/<\/road>/i);
  for (const block of roadBlocks) {
    if (!/<road\s/i.test(block)) continue;
    const hasBikeLane = /<lane\b[^>]*\btype="biking"/i.test(block);
    if (hasBikeLane) {
      roads_with_bike_lanes += 1;
      const rl = block.match(/<road\b[^>]*\blength="([-0-9.eE+]+)"/i);
      const roadLen = rl?.[1] != null ? Number(rl[1]) : 0;
      if (Number.isFinite(roadLen) && roadLen > 0) {
        bike_lane_length_m += roadLen;
        // Shared = road has both biking and driving lanes
        if (/<lane\b[^>]*\btype="driving"/i.test(block)) {
          shared_bike_lane_length_m += roadLen;
        }
      }
    }
    const hasSidewalk = /<lane\b[^>]*\btype="sidewalk"/i.test(block);
    if (hasSidewalk) {
      roads_with_sidewalks += 1;
      const rl = block.match(/<road\b[^>]*\blength="([-0-9.eE+]+)"/i);
      const roadLen = rl?.[1] != null ? Number(rl[1]) : 0;
      if (Number.isFinite(roadLen) && roadLen > 0) sidewalk_length_m += roadLen;
    }
    if (/<lane\b[^>]*\btype="parking"/i.test(block)) {
      roads_with_parking_lanes += 1;
      const rl2 = block.match(/<road\b[^>]*\blength="([-0-9.eE+]+)"/i);
      const rl2Len = rl2?.[1] != null ? Number(rl2[1]) : 0;
      if (Number.isFinite(rl2Len) && rl2Len > 0) parking_lane_length_m += rl2Len;
    }

    // Build per-road signal category set
    const roadIdMatch = block.match(/<road\b[^>]*\bid="([^"]+)"/i);
    const roadId = roadIdMatch?.[1];
    if (roadId) {
      // Track connecting road → junction mapping
      const juncAttr = block.match(/<road\b[^>]*\bjunction="([^"]+)"/i)?.[1];
      if (juncAttr && juncAttr !== "-1") {
        connectingRoadJunction.set(roadId, juncAttr);
      }

      if (/<signal\b/i.test(block)) {
        const blockSignalRe = /<signal\b[^>]*>/gi;
        let bsm: RegExpExecArray | null;
        while ((bsm = blockSignalRe.exec(block)) !== null) {
          const tag = bsm[0];
          const sName = tag.match(/\bname="([^"]*)"/i)?.[1] ?? "";
          const sType = tag.match(/\btype="([^"]*)"/i)?.[1] ?? "";
          const { signal_category } = classifyAndEnrichSignal(sName, sType);
          let cats = roadSignalCategories.get(roadId);
          if (!cats) { cats = new Set(); roadSignalCategories.set(roadId, cats); }
          cats.add(signal_category);
        }
      }
    }
  }

  // OpenDRIVE crosswalk objects are <object type="crosswalk" ...> elements,
  // but RoadRunner has an export bug where duplicated/renamed crosswalks
  // (e.g. named "SimpleCrosswalk (2)" or "Crosswalk 2") lose their type
  // attribute and end up tagged type="-1". Across our 7-map dataset that
  // hides 47/86 crosswalks (Belmont and Saratoga showed 0 instead of 8).
  // We catch them by matching either type="crosswalk" or a RoadRunner-shaped
  // name attribute. The name pattern is intentionally tight — an optional
  // CamelCase prefix followed by literal "Crosswalk" and an optional " (N)"
  // or " N" suffix — because all 86 observed crosswalk-named objects fit it
  // and the trailing-digit / parenthesised-digit guards prevent false
  // positives like name="Crosswalk Sign". Each <object> opening tag is
  // counted at most once even if both predicates match, so the total is
  // unambiguous.
  const objOpenTagRe = /<object\b[^>]*>/gi;
  const xwByTypeRe = /\btype="crosswalk"/;
  const xwByNameRe = /\bname="(?:[A-Z][a-z]*)?Crosswalk(?:\s*(?:\(\d+\)|\d+))?"/;
  let crosswalk_count = 0;
  {
    let mObj: RegExpExecArray | null;
    while ((mObj = objOpenTagRe.exec(cleaned)) !== null) {
      const tag = mObj[0];
      if (xwByTypeRe.test(tag) || xwByNameRe.test(tag)) crosswalk_count++;
    }
  }

  // OpenDRIVE speed limits are on <speed max="VALUE" unit="mph"/> elements.
  // The previous regex matched speed="VALUE" as an attribute name — that
  // attribute does not exist in xodr; the correct attribute is max= on a
  // <speed> element. RoadRunner emits values in both integer ("40") and
  // scientific notation ("4.0000000000000000e+01") form.
  const speedSet = new Set<number>();
  // Attribute-order agnostic: RoadRunner emits max= before unit=, but the
  // OpenDRIVE spec doesn't require it. km/h (spec spellings "km/h"/"kmh",
  // and the spec default when unit is omitted is m/s — not seen in our
  // exports, so only the two common unit spellings are handled) converts
  // to mph so metric maps still contribute.
  const speedTagRe = /<speed\b[^>]*>/gi;
  let sm: RegExpExecArray | null;
  while ((sm = speedTagRe.exec(cleaned)) !== null) {
    const tag = sm[0];
    const maxM = tag.match(/\bmax="([-0-9.eE+]+)"/i);
    if (!maxM) continue;
    const unitM = tag.match(/\bunit="([^"]*)"/i);
    const unit = unitM?.[1]?.toLowerCase() ?? "";
    let v = Number(maxM[1]);
    if (unit === "km/h" || unit === "kmh") v = v / 1.609344;
    else if (unit !== "mph") continue;
    if (Number.isFinite(v) && v > 0 && v < 500) speedSet.add(Math.round(v));
  }
  const speed_limits_mph = [...speedSet].sort((a, b) => a - b);

  // OpenDRIVE elevation uses a cubic polynomial: a + b*s + c*s² + d*s³.
  // Per-polynomial-segment averaging (even with a sub-metre filter) still produces
  // spurious high grades on transition segments: e.g. a c-term ramp-up polynomial
  // that carries grade from ~0% to 68% over 5–6 m yields 34% average even though
  // the road's true sustained grade is ~20%.
  //
  // Instead, compute the net grade per road:
  //   net_grade = |z_end − z_start| / road_length
  // where z_start = a of the first elevation entry and z_end is the last
  // elevation polynomial evaluated at (road_length − s_last).
  // This eliminates all transition-polynomial artefacts and gives one stable
  // grade value per road regardless of how many polynomial pieces it uses.
  let max_grade_pct = 0;
  let segments_above_4pct_grade = 0;
  let length_above_4pct_grade_m = 0;
  for (const roadBlock of roadBlocks) {
    if (!/<road\s/i.test(roadBlock)) continue;
    // Skip roads with no driving lanes (sidewalks, paths, bike lanes, etc.)
    const hasDrivingLane = /<lane\b[^>]*\btype="driving"/i.test(roadBlock);
    if (!hasDrivingLane) continue;
    const roadLenM = roadBlock.match(/<road\b[^>]*\blength="([-0-9.eE+]+)"/i);
    const roadLength = roadLenM?.[1] != null ? Number(roadLenM[1]) : undefined;
    if (!roadLength || roadLength <= 20) continue;
    const elevEntries: { s: number; a: number; b: number; c: number; d: number }[] = [];
    const elevTagRe = /<elevation\b[^>]*>/gi;
    let em: RegExpExecArray | null;
    while ((em = elevTagRe.exec(roadBlock)) !== null) {
      const tag = em[0];
      const sm = tag.match(/\bs="([-0-9.eE+]+)"/); const s = sm ? Number(sm[1]) : NaN;
      const am = tag.match(/\ba="([-0-9.eE+]+)"/); const a = am ? Number(am[1]) : NaN;
      const bm = tag.match(/\bb="([-0-9.eE+]+)"/); const b = bm ? Number(bm[1]) : NaN;
      const cm = tag.match(/\bc="([-0-9.eE+]+)"/); const c = cm ? Number(cm[1]) : 0;
      const dm = tag.match(/\bd="([-0-9.eE+]+)"/); const d = dm ? Number(dm[1]) : 0;
      if (Number.isFinite(s) && Number.isFinite(a) && Number.isFinite(b))
        elevEntries.push({ s, a, b, c, d });
    }
    if (elevEntries.length === 0) continue;
    elevEntries.sort((x, y) => x.s - y.s);
    const z_start = elevEntries[0]!.a;
    const last = elevEntries[elevEntries.length - 1]!;
    const ds = roadLength - last.s;
    const z_end = last.a + last.b * ds + last.c * ds * ds + last.d * ds * ds * ds;
    const pct = (Math.abs(z_end - z_start) / roadLength) * 100;
    if (pct > max_grade_pct) max_grade_pct = pct;
    if (pct > 4) {
      segments_above_4pct_grade += 1;
      length_above_4pct_grade_m += roadLength;
    }
  }

  // Build junction_id → Set<connecting_road_id> from the connectingRoadJunction map
  // (inverted: road→junction becomes junction→Set<road>).
  const junctionConnectingRoads = new Map<string, Set<string>>();
  for (const [roadId, juncId] of connectingRoadJunction) {
    let roads = junctionConnectingRoads.get(juncId);
    if (!roads) { roads = new Set(); junctionConnectingRoads.set(juncId, roads); }
    roads.add(roadId);
  }

  // Junction road-degree counts + junction-level signal/sign control.
  // Each OpenDRIVE <junction> block contains <connection incomingRoad="..."> elements.
  // The number of distinct incomingRoad values = the number of road arms meeting at that
  // junction. This is road-level degree, not lane-level — a 4-way intersection with 2
  // lanes per arm has 4 incoming roads, not 8.
  //
  // Degree 1-2 junctions are real xodr junction elements (parking lot entrances,
  // road merges, divided-road crossings) but are not meaningful intersections for
  // scenario complexity queries, so they are bucketed separately as "2_or_fewer".
  //
  // Junction control is determined by checking signals on:
  //   1. Incoming roads (roads approaching the junction)
  //   2. Connecting roads (internal roads with junction="<juncId>")
  // RoadRunner places traffic lights on connecting roads inside the junction,
  // not on the incoming approach roads.
  const junctionDegreeCounts: JunctionRoadDegreeCounts = {
    "2_or_fewer": 0,
    "3": 0,
    "4": 0,
    "5_plus": 0,
  };
  const junctionControlCounts: JunctionControlCounts = {
    signalized: 0,
    stop_sign_controlled: 0,
    allway_stop: 0,
  };
  // Match <junction ...>...</junction> blocks (non-self-closing) to count degree.
  // Self-closing <junction .../> tags are counted by total_junctions but have no
  // children — they represent empty (degree 0) junctions and are bucketed in "2_or_fewer".
  const junctionBlockRe = /<junction\b[^>]*>([\s\S]*?)<\/junction>/gi;
  let jb: RegExpExecArray | null;
  let junctionsWithBlocks = 0;
  while ((jb = junctionBlockRe.exec(cleaned)) !== null) {
    const junctionBody = jb[1];
    if (junctionBody === undefined) continue;
    junctionsWithBlocks += 1;
    const incomingRoads = new Set<string>();
    const connRe = /\bincomingRoad="([^"]+)"/gi;
    let cm: RegExpExecArray | null;
    while ((cm = connRe.exec(junctionBody)) !== null) {
      const road = cm[1];
      if (road !== undefined) incomingRoads.add(road);
    }
    const degree = incomingRoads.size;
    if (degree <= 2) junctionDegreeCounts["2_or_fewer"] += 1;
    else if (degree === 3) junctionDegreeCounts["3"] += 1;
    else if (degree === 4) junctionDegreeCounts["4"] += 1;
    else junctionDegreeCounts["5_plus"] += 1;

    // Determine junction control type from signals on incoming roads
    // AND connecting roads (internal roads with junction="<juncId>").
    // RoadRunner places traffic lights and stop signs on connecting roads
    // inside the junction, not on the incoming approach roads.
    //
    // For all-way stop detection, we need per-approach coverage: a connecting
    // road's stop sign counts toward the incoming road it serves. We parse
    // <connection incomingRoad="..." connectingRoad="..."> pairs to build this
    // mapping, then check if ALL incoming roads are stop-sign-covered.
    const juncIdMatch = jb[0].match(/<junction\b[^>]*\bid="([^"]+)"/i);
    const juncId = juncIdMatch?.[1];

    let hasTrafficLight = false;
    const incomingRoadsWithStopSign = new Set<string>();

    // Check incoming roads directly
    for (const roadId of incomingRoads) {
      const cats = roadSignalCategories.get(roadId);
      if (!cats) continue;
      if (cats.has("traffic_light")) hasTrafficLight = true;
      if (cats.has("stop_sign")) incomingRoadsWithStopSign.add(roadId);
    }

    // Map connecting road signals back to their incoming approach via
    // <connection incomingRoad="X" connectingRoad="Y"> pairs.
    if (juncId) {
      const connPairRe = /<connection\b[^>]*>/gi;
      let connectionPair: RegExpExecArray | null;
      while ((connectionPair = connPairRe.exec(junctionBody)) !== null) {
        const tag = connectionPair[0];
        const incRoad = tag.match(/\bincomingRoad="([^"]+)"/i)?.[1];
        const conRoad = tag.match(/\bconnectingRoad="([^"]+)"/i)?.[1];
        if (!incRoad || !conRoad) continue;
        const cats = roadSignalCategories.get(conRoad);
        if (!cats) continue;
        if (cats.has("traffic_light")) hasTrafficLight = true;
        if (cats.has("stop_sign")) incomingRoadsWithStopSign.add(incRoad);
      }
    }

    const roadsWithStopSign = incomingRoadsWithStopSign.size;
    if (hasTrafficLight) junctionControlCounts.signalized += 1;
    if (roadsWithStopSign > 0) junctionControlCounts.stop_sign_controlled += 1;
    if (degree >= 2 && roadsWithStopSign === degree) junctionControlCounts.allway_stop += 1;
  }
  // Any junctions not captured by the block regex (self-closing or empty) have degree 0 → "2_or_fewer"
  const uncaptured = total_junctions - junctionsWithBlocks;
  if (uncaptured > 0) junctionDegreeCounts["2_or_fewer"] += uncaptured;

  return {
    total_roads,
    total_junctions,
    total_centerline_length_m: Math.round(lengthSum),
    lane_counts: laneCounts,
    roads_with_bike_lanes,
    bike_lane_length_m: Math.round(bike_lane_length_m),
    shared_bike_lane_length_m: Math.round(shared_bike_lane_length_m),
    roads_with_sidewalks,
    sidewalk_length_m: Math.round(sidewalk_length_m),
    roads_with_parking_lanes,
    parking_lane_length_m: Math.round(parking_lane_length_m),
    signal_count,
    signal_breakdown,
    crosswalk_count,
    speed_limits_mph,
    max_grade_pct: Math.round(max_grade_pct * 10) / 10,
    segments_above_4pct_grade,
    length_above_4pct_grade_m: Math.round(length_above_4pct_grade_m),
    junction_road_degree_counts: junctionDegreeCounts,
    junction_control_counts: junctionControlCounts,
  };
}

// ---------------------------------------------------------------------------
// Per-junction info for candidate location matching
// ---------------------------------------------------------------------------

/** Alias for the shared type — same shape used by the candidate location extractor. */
export type { XodrJunctionMatchInfo as XodrJunctionInfo } from "@simcloud/shared";

/**
 * Extract per-junction data from an XODR file.
 *
 * For each junction, computes:
 * - road-level degree (from distinct incomingRoad values)
 * - centroid in WGS-84 (averaged from incoming road contact points)
 * - signal control flags (traffic light, stop sign, all-way stop)
 *
 * Centroids are computed by resolving each incoming road's geometry at its
 * contact point (start or end of road) to local (x, y) coordinates, then
 * converting to lon/lat via the file's geoReference.
 */
export function extractPerJunctionInfo(xodr: string): XodrJunctionMatchInfo[] {
  const cleaned = stripXmlComments(xodr);

  // Coordinate transform from geoReference
  const projString = extractGeoReferenceText(xodr);
  const origin = projString ? parseProjOrigin(projString) : undefined;
  const transform: CoordTransform = {
    originLat: origin?.lat ?? 0,
    originLon: origin?.lon ?? 0,
    // Pass the declared PROJ string through (CoordTransform docs: "Always
    // pass it through when you have it") — without it, non-vanilla
    // projections (UTM, tmerc with scale/false-easting) get a synthesized
    // tmerc that disagrees with the lane-polygon path.
    ...(projString ? { projString } : {}),
  };

  // Build road_id → { geometry segments, length, signal categories, junctionAttr }
  type RoadInfo = {
    segments: ReturnType<typeof parseGeometrySegments>;
    length: number;
    signalCategories: Set<string>;
    /** True when at least one signal on this road is a protected-left head. */
    hasProtectedLeftSignal: boolean;
    junctionAttr: string | undefined; // junction="X" attribute (-1 = not in a junction)
  };
  const roadInfoMap = new Map<string, RoadInfo>();

  const roadBlockRe = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = roadBlockRe.exec(cleaned)) !== null) {
    const roadAttrs = rm[1]!;
    const roadBody = rm[2]!;
    const roadId = attr(roadAttrs, "id");
    if (!roadId) continue;

    const roadLen = Number(attr(roadAttrs, "length") ?? "0");
    const juncAttrVal = attr(roadAttrs, "junction");
    const segments = parseGeometrySegments(roadBody);

    // Collect signal categories for this road
    const signalCategories = new Set<string>();
    let hasProtectedLeftSignal = false;
    const sigRe = /<signal\b[^>]*>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = sigRe.exec(roadBody)) !== null) {
      const tag = sm[0];
      const sName = tag.match(/\bname="([^"]*)"/i)?.[1] ?? "";
      const sType = tag.match(/\btype="([^"]*)"/i)?.[1] ?? "";
      const enriched = classifyAndEnrichSignal(sName, sType);
      signalCategories.add(enriched.signal_category);
      if (isProtectedLeftSignal(sName, enriched.mutcd_code)) {
        hasProtectedLeftSignal = true;
      }
    }

    roadInfoMap.set(roadId, {
      segments,
      length: roadLen,
      signalCategories,
      hasProtectedLeftSignal,
      junctionAttr: juncAttrVal && juncAttrVal !== "-1" ? juncAttrVal : undefined,
    });
  }

  // Build junction_id → Set<connecting_road_id> from road junction= attributes
  const juncConnRoads = new Map<string, Set<string>>();
  for (const [roadId, info] of roadInfoMap) {
    if (info.junctionAttr) {
      let roads = juncConnRoads.get(info.junctionAttr);
      if (!roads) { roads = new Set(); juncConnRoads.set(info.junctionAttr, roads); }
      roads.add(roadId);
    }
  }

  // Parse junctions and compute per-junction info
  const results: XodrJunctionMatchInfo[] = [];
  const junctionBlockRe2 = /<junction\b([^>]*)>([\s\S]*?)<\/junction>/gi;
  let jb: RegExpExecArray | null;
  while ((jb = junctionBlockRe2.exec(cleaned)) !== null) {
    const juncAttrs = jb[1]!;
    const juncBody = jb[2]!;
    const juncId = attr(juncAttrs, "id");
    if (!juncId) continue;

    // Collect incoming roads with contact points, and build
    // incomingRoad → connectingRoad[] mapping for per-approach signal tracing.
    const incomingRoads = new Map<string, string>(); // road_id → contactPoint
    const incomingToConnecting = new Map<string, string[]>(); // incomingRoad → [connectingRoad]
    const connRe = /<connection\b[^>]*>/gi;
    let cm: RegExpExecArray | null;
    while ((cm = connRe.exec(juncBody)) !== null) {
      const tag = cm[0];
      const road = tag.match(/\bincomingRoad="([^"]+)"/i)?.[1];
      const conRoad = tag.match(/\bconnectingRoad="([^"]+)"/i)?.[1];
      const contact = tag.match(/\bcontactPoint="([^"]+)"/i)?.[1] ?? "start";
      if (road && !incomingRoads.has(road)) {
        incomingRoads.set(road, contact);
      }
      if (road && conRoad) {
        const arr = incomingToConnecting.get(road) ?? [];
        arr.push(conRoad);
        incomingToConnecting.set(road, arr);
      }
    }

    const degree = incomingRoads.size;
    if (degree === 0) continue;

    // Compute centroid from incoming road contact points
    let sumLat = 0, sumLng = 0, pointCount = 0;
    let hasTrafficLight = false;
    let hasProtectedLeftSignal = false;
    const incomingRoadsWithStopSign = new Set<string>();

    // Check incoming roads for signals + compute centroid
    for (const [roadId, contactPoint] of incomingRoads) {
      const info = roadInfoMap.get(roadId);
      if (!info || info.segments.length === 0) continue;

      const s = contactPoint === "end" ? info.length : 0;
      const xy = resolveSTtoXY(info.segments, s, 0);
      if (xy) {
        const [lng, lat] = localToLonLat(xy, transform);
        sumLat += lat;
        sumLng += lng;
        pointCount += 1;
      }

      if (info.signalCategories.has("traffic_light")) hasTrafficLight = true;
      if (info.signalCategories.has("stop_sign")) incomingRoadsWithStopSign.add(roadId);
      if (info.hasProtectedLeftSignal) hasProtectedLeftSignal = true;
    }

    // Map connecting road signals back to their incoming approach
    for (const [incRoad, conRoads] of incomingToConnecting) {
      for (const conRoad of conRoads) {
        const info = roadInfoMap.get(conRoad);
        if (!info) continue;
        if (info.signalCategories.has("traffic_light")) hasTrafficLight = true;
        if (info.signalCategories.has("stop_sign")) incomingRoadsWithStopSign.add(incRoad);
        if (info.hasProtectedLeftSignal) hasProtectedLeftSignal = true;
      }
    }

    const roadsWithStopSign = incomingRoadsWithStopSign.size;

    if (pointCount === 0) continue;

    results.push({
      xodrJunctionId: juncId,
      roadDegree: degree,
      centroid: { lat: sumLat / pointCount, lng: sumLng / pointCount },
      hasTrafficLight,
      hasStopSign: roadsWithStopSign > 0,
      allWayStop: degree >= 2 && roadsWithStopSign === degree,
      incomingRoadIds: [...incomingRoads.keys()],
      hasProtectedLeftSignal,
    });
  }

  return results;
}

/**
 * Recognise an XODR signal as a protected left-turn head.
 *
 * Two cues we can trust from a RoadRunner export:
 *  - MUTCD code R10-6 ("Left Turn Signal") — the sign that accompanies a
 *    dedicated protected left-turn signal phase.
 *  - A signal name suggesting a left-arrow head, e.g. `Signal_Light_Left`,
 *    `signal_left_arrow`, `LeftArrow`. RoadRunner's naming is not strict, so
 *    we accept any name containing both "left" and "arrow", or the explicit
 *    "left turn signal" phrase.
 *
 * We do NOT treat MUTCD R10-12 ("Left Turn Yield on Green") as protected —
 * that sign explicitly marks an UNPROTECTED permissive-left arrangement.
 */
function isProtectedLeftSignal(name: string, mutcdCode?: string): boolean {
  if (mutcdCode && mutcdCode.toUpperCase() === "R10-6") return true;
  const n = name.toLowerCase();
  if (/left.*arrow|arrow.*left/.test(n)) return true;
  if (/left[_\s-]*turn[_\s-]*signal/.test(n)) return true;
  if (/signal_.*_left\b|signal_left_/.test(n)) return true;
  return false;
}
