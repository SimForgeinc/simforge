/**
 * Extract signal/sign features from an XODR file as a GeoJSON FeatureCollection.
 *
 * Each signal becomes a Point feature with properties including classification,
 * position, MUTCD enrichment, and the originating road ID.
 */

import { attr, stripXmlComments, extractGeoReferenceText } from "./xodr";
import { parseProjOrigin } from "./parse-proj";
import {
  type CoordTransform,
  type GeometrySegment,
  localToLonLat,
  parseGeometrySegments,
  resolveSTtoXY,
  resolveSTtoXYWithHeading,
} from "./xodr-geometry";
import { lookupSignInfo } from "./mutcd-signs";

// ---------------------------------------------------------------------------
// Signal classification — single source of truth
// ---------------------------------------------------------------------------

export type SignalEnrichment = {
  signal_category: string;
  mutcd_code?: string;
  sign_description?: string;
  sign_group?: string;
  speed_limit_mph?: number;
  street_name?: string;
};

/**
 * Classify an XODR signal by its name and type attributes, returning
 * the signal category plus any enrichment metadata (MUTCD code, description,
 * speed limit, street name).
 *
 * This is the **single source of truth** for signal classification.
 * Used by xodr-signals.ts (GeoJSON extraction), xodr.ts (stats), and
 * xodr-to-geojson.ts (CLI script).
 */
export function classifyAndEnrichSignal(name: string, type: string): SignalEnrichment {
  const n = name.toLowerCase();
  const t = type.toLowerCase();

  // 1. Traffic lights and pedestrian walk signals (not MUTCD-coded in XODR)
  if (/signal_.*light|walk_light/i.test(n)) {
    return { signal_category: "traffic_light" };
  }

  // 2. Stop lines and road markings
  if (/stopline/i.test(n)) {
    return { signal_category: "stop_line" };
  }
  if (t === "roadmark") {
    return { signal_category: "stop_line" };
  }

  // 3. Bus stops
  if (/^bus.?stop$/i.test(n.replace(/^sign_/i, ""))) {
    return { signal_category: "bus_stop" };
  }

  // 4. MUTCD lookup (handles both coded signs and RR shorthand)
  const lookup = lookupSignInfo(name);
  if (lookup) {
    return {
      signal_category: lookup.info.category,
      mutcd_code: lookup.info.code || undefined,
      sign_description: lookup.info.description,
      sign_group: lookup.info.group,
      speed_limit_mph: lookup.speedLimitMph,
    };
  }

  // 5. Generic Sign_ prefix with no MUTCD match — "other_sign"
  if (/^sign_/i.test(n)) {
    return { signal_category: "other_sign" };
  }

  // 6. Bare text parking/no-parking signs (no Sign_ prefix)
  if (/^no\s*parking|^parking/i.test(name.trim())) {
    return {
      signal_category: "parking_sign",
      sign_description: name.trim(),
      sign_group: "regulatory",
    };
  }

  // 7. Bare text names → street name signs (e.g. "Page mill", "EL CAMINO")
  //    But skip empty names and generic placeholders
  if (name.trim() && !/^(new sign|info board|street name)/i.test(name.trim())) {
    // Title-case the street name
    const streetName = name
      .trim()
      .replace(/\s*\(\d+\)\s*/g, "") // strip "(2)" suffixes
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      signal_category: "street_name_sign",
      street_name: streetName,
    };
  }

  return { signal_category: "unknown" };
}

// ---------------------------------------------------------------------------
// Display name builder
// ---------------------------------------------------------------------------

/** Build a human-readable display name for tooltip/inspector from enrichment data. */
export function buildDisplayName(sourceName: string, enrichment: SignalEnrichment): string {
  const { signal_category, sign_description, mutcd_code, speed_limit_mph, street_name } = enrichment;

  // Speed limit signs: "Speed Limit 35 MPH (R2-1)"
  if (signal_category === "speed_limit_sign" && speed_limit_mph) {
    return mutcd_code ? `Speed Limit ${speed_limit_mph} MPH (${mutcd_code})` : `Speed Limit ${speed_limit_mph} MPH`;
  }

  // MUTCD-coded signs with description: "No Parking Any Time (R7-1)"
  if (sign_description && mutcd_code) {
    return `${sign_description} (${mutcd_code})`;
  }

  // Shorthand signs with description but no MUTCD code: "Left Turn, No U-Turn"
  if (sign_description) {
    return sign_description;
  }

  // Street name signs: the cleaned street name
  if (street_name) {
    return street_name;
  }

  // Traffic lights: humanize the RR name  "Signal_3Light_Post01" → "Traffic Light (3-Light Post)"
  if (signal_category === "traffic_light") {
    const m = sourceName.match(/Signal_(\d+Light)_?(\w+?)(\d*)$/i);
    if (m) return `Traffic Light (${m[1]!.replace("Light", "-Light")} ${m[2]})`.trim();
    if (/walk_light/i.test(sourceName)) return "Pedestrian Walk Signal";
    return "Traffic Light";
  }

  // Stop line
  if (signal_category === "stop_line") {
    return "Stop Line";
  }

  // Bus stop
  if (signal_category === "bus_stop") {
    return "Bus Stop";
  }

  // Fallback: use source name if non-empty, otherwise category label
  if (sourceName.trim()) return sourceName;
  return signal_category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// GeoJSON types (inline to avoid external dependency)
// ---------------------------------------------------------------------------

type GeoJSONPoint = { type: "Point"; coordinates: [number, number] };
type GeoJSONPolygon = { type: "Polygon"; coordinates: [number, number][][] };

/**
 * Discriminator on every overlay feature so consumers (MapLibre filters,
 * counters) can distinguish point-shaped signals/signs from polygon-shaped
 * crosswalks without inspecting geometry. The legacy point payload keeps
 * its existing shape (no `feature_kind` was emitted before this change);
 * the field is added for forward-compat and is required on every new
 * snapshot.
 */
export type IntersectionOverlayFeatureKind = "signal" | "crosswalk";

type SignalFeature = {
  type: "Feature";
  geometry: GeoJSONPoint;
  properties: {
    feature_kind: "signal";
    id: string;
    /** Human-readable display name (e.g. "Stop (R1-1)", "Speed Limit 35 MPH") */
    name: string;
    /** Original RoadRunner signal name from the XODR (e.g. "Sign_R1-1", "Signal_3Light_Post01") */
    source_name: string;
    road_id: string;
    s: number;
    t: number;
    signal_category: string;
    dynamic: string;
    type: string;
    subtype: string;
    height: number | undefined;
    width: number | undefined;
    z_offset: number | undefined;
    mutcd_code: string | undefined;
    sign_description: string | undefined;
    sign_group: string | undefined;
    speed_limit_mph: number | undefined;
    street_name: string | undefined;
  };
};

type CrosswalkFeature = {
  type: "Feature";
  geometry: GeoJSONPolygon;
  properties: {
    feature_kind: "crosswalk";
    id: string;
    /** Human-readable label, e.g. "Crosswalk (LadderCrosswalk)". */
    name: string;
    /** RoadRunner-exported name from the XODR (e.g. "LadderCrosswalk", "SimpleCrosswalk (2)"). */
    source_name: string;
    road_id: string;
    s: number;
    t: number;
    /** Heading offset (radians) of the crosswalk relative to the road reference line, from the XODR `<object>` element. */
    hdg: number;
    /** Crosswalk extent perpendicular to the heading, metres. */
    width: number;
    /** Crosswalk extent along the heading, metres. Typically 5–15 m to span the road. */
    length: number;
    /**
     * The original `type` attribute on the `<object>` element. RoadRunner
     * exports duplicated crosswalks with type="-1"; preserving it lets
     * downstream code distinguish the two ingestion paths if needed.
     */
    source_type: string;
  };
};

export type IntersectionOverlayFeature = SignalFeature | CrosswalkFeature;

/**
 * The intersection-elements overlay artifact. Despite the historical name,
 * this collection now carries both signals/signs AND crosswalk polygons —
 * see the design note in `apps/web/app/api/map-assets/[mapAssetId]/signals-geojson/route.ts`.
 * The artifact id and S3 key still reference "signals" for backward
 * compatibility with deployed snapshots; renaming would invalidate every
 * persisted artifact row.
 */
export type SignalFeatureCollection = {
  type: "FeatureCollection";
  features: IntersectionOverlayFeature[];
};

// ---------------------------------------------------------------------------
// Main extraction
// ---------------------------------------------------------------------------

/**
 * Match the `<object>` opening tag for a crosswalk. Mirrors the regex pair
 * used by `extractXodrRoadStats` for `crosswalk_count` so that what gets
 * counted is exactly what gets emitted as overlay geometry. RoadRunner
 * duplicates lose `type="crosswalk"` and rely on the name match.
 */
const CROSSWALK_TYPE_RE = /\btype="crosswalk"/;
const CROSSWALK_NAME_RE = /\bname="(?:[A-Z][a-z]*)?Crosswalk(?:\s*(?:\(\d+\)|\d+))?"/;

function isCrosswalkObjectTag(openTag: string): boolean {
  return CROSSWALK_TYPE_RE.test(openTag) || CROSSWALK_NAME_RE.test(openTag);
}

/**
 * Build a rotated rectangle polygon for a crosswalk anchored at (s, t) on a
 * road. The crosswalk's `hdg` attribute is its heading offset relative to
 * the road's reference-line heading at that s.
 *
 * Outer ring is emitted counter-clockwise (RFC 7946 outer-ring convention).
 * Returns null if the (s, t) cannot be resolved against the road's
 * geometry segments.
 */
function buildCrosswalkPolygon(
  segments: GeometrySegment[],
  s: number,
  t: number,
  hdgOffset: number,
  width: number,
  length: number,
  transform: CoordTransform,
): [number, number][][] | null {
  const anchor = resolveSTtoXYWithHeading(segments, s, t);
  if (!anchor) return null;
  const center = anchor.xy;
  const heading = anchor.heading + hdgOffset;
  const cosH = Math.cos(heading);
  const sinH = Math.sin(heading);
  const halfL = length / 2;
  const halfW = width / 2;

  // forward = (cos H, sin H); left = (-sin H, cos H). CCW corner sequence
  // starting at front-right gives the outer-ring winding required by
  // RFC 7946 section 3.1.6.
  const cornersLocal = [
    { x: center.x + halfL * cosH + halfW * sinH, y: center.y + halfL * sinH - halfW * cosH }, // front-right
    { x: center.x + halfL * cosH - halfW * sinH, y: center.y + halfL * sinH + halfW * cosH }, // front-left
    { x: center.x - halfL * cosH - halfW * sinH, y: center.y - halfL * sinH + halfW * cosH }, // back-left
    { x: center.x - halfL * cosH + halfW * sinH, y: center.y - halfL * sinH - halfW * cosH }, // back-right
  ];
  const ring = cornersLocal.map((p) => localToLonLat(p, transform));
  ring.push(ring[0]!);
  return [ring];
}

/**
 * Parse `<object>` elements that match the crosswalk regex and project them
 * into oriented rectangle polygons in WGS-84.
 */
function extractCrosswalkFeatures(
  cleaned: string,
  transform: CoordTransform,
): CrosswalkFeature[] {
  const out: CrosswalkFeature[] = [];
  const roadBlockRe = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm: RegExpExecArray | null;

  while ((rm = roadBlockRe.exec(cleaned)) !== null) {
    const roadAttrs = rm[1]!;
    const roadBody = rm[2]!;
    if (!roadBody.includes("<object")) continue;

    const roadId = attr(roadAttrs, "id") ?? "";
    const segments = parseGeometrySegments(roadBody);

    const objRe = /<object\b([^>]*)>/gi;
    let om: RegExpExecArray | null;
    while ((om = objRe.exec(roadBody)) !== null) {
      const tag = om[0];
      if (!isCrosswalkObjectTag(tag)) continue;
      const oAttrs = om[1]!;

      const oId = attr(oAttrs, "id") ?? "";
      const oName = attr(oAttrs, "name") ?? "";
      const oType = attr(oAttrs, "type") ?? "";
      const sVal = Number(attr(oAttrs, "s") ?? "0");
      const tVal = Number(attr(oAttrs, "t") ?? "0");
      const hdgVal = Number(attr(oAttrs, "hdg") ?? "0");
      const widthVal = Number(attr(oAttrs, "width") ?? "0");
      const lengthVal = Number(attr(oAttrs, "length") ?? "0");

      // A zero-extent rectangle would render as a degenerate polygon.
      // RoadRunner has occasionally emitted width=0 length=0 for very small
      // pedestrian-island markings — skip them rather than ship invalid
      // geometry to MapLibre.
      if (!(widthVal > 0) || !(lengthVal > 0)) continue;

      const ring = buildCrosswalkPolygon(
        segments,
        sVal,
        tVal,
        hdgVal,
        widthVal,
        lengthVal,
        transform,
      );
      if (!ring) continue;

      out.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: ring },
        properties: {
          feature_kind: "crosswalk",
          id: oId,
          name: oName ? `Crosswalk (${oName})` : "Crosswalk",
          source_name: oName,
          road_id: roadId,
          s: sVal,
          t: tVal,
          hdg: hdgVal,
          width: widthVal,
          length: lengthVal,
          source_type: oType,
        },
      });
    }
  }
  return out;
}

/**
 * Parse `<signal>` and crosswalk `<object>` elements from every `<road>` in
 * the XODR and convert their (s, t) positions to WGS-84 lat/lon using the
 * file's geoReference.
 *
 * Returns a single GeoJSON FeatureCollection. Signals are Point features;
 * crosswalks are Polygon features. Use `feature_kind` on properties to
 * discriminate. If the XODR has no geoReference, coordinates are emitted
 * in the local frame.
 *
 * Despite the function name, the output now also carries crosswalk
 * polygons — see `IntersectionOverlayFeature` for the discriminated union.
 */
export function extractSignalFeaturesFromXodr(xodrText: string): SignalFeatureCollection {
  const cleaned = stripXmlComments(xodrText);

  // Coordinate transform setup
  const projString = extractGeoReferenceText(xodrText);
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

  const features: IntersectionOverlayFeature[] = [];

  // Iterate road blocks
  const roadBlockRe = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm: RegExpExecArray | null;

  while ((rm = roadBlockRe.exec(cleaned)) !== null) {
    const roadAttrs = rm[1]!;
    const roadBody = rm[2]!;

    if (!roadBody.includes("<signal")) continue;

    const roadId = attr(roadAttrs, "id") ?? "";
    const segments = parseGeometrySegments(roadBody);

    const signalRe = /<signal\b([^>]*)\/?>/gi;
    let sm: RegExpExecArray | null;

    while ((sm = signalRe.exec(roadBody)) !== null) {
      const sAttrs = sm[1]!;

      const sigId = attr(sAttrs, "id") ?? "";
      const sigName = attr(sAttrs, "name") ?? "";
      const sVal = Number(attr(sAttrs, "s") ?? "0");
      const tVal = Number(attr(sAttrs, "t") ?? "0");
      const dynamic = attr(sAttrs, "dynamic") ?? "no";
      const sigType = attr(sAttrs, "type") ?? "";
      const sigSubtype = attr(sAttrs, "subtype") ?? "";
      const height = Number(attr(sAttrs, "height") ?? "0") || undefined;
      const width = Number(attr(sAttrs, "width") ?? "0") || undefined;
      const zOffset = Number(attr(sAttrs, "zOffset") ?? "0") || undefined;

      const enrichment = classifyAndEnrichSignal(sigName, sigType);

      let coords: [number, number];
      const pt = resolveSTtoXY(segments, sVal, tVal);
      if (pt) {
        coords = localToLonLat(pt, transform);
      } else {
        coords = [transform.originLon, transform.originLat];
      }

      const displayName = buildDisplayName(sigName, enrichment);

      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: coords },
        properties: {
          feature_kind: "signal",
          id: sigId,
          name: displayName,
          source_name: sigName,
          road_id: roadId,
          s: sVal,
          t: tVal,
          signal_category: enrichment.signal_category,
          dynamic,
          type: sigType,
          subtype: sigSubtype,
          height,
          width,
          z_offset: zOffset,
          mutcd_code: enrichment.mutcd_code,
          sign_description: enrichment.sign_description,
          sign_group: enrichment.sign_group,
          speed_limit_mph: enrichment.speed_limit_mph,
          street_name: enrichment.street_name,
        },
      });
    }
  }

  // Crosswalks share the same geoReference + segment-projection path as
  // signals but live in <object> elements rather than <signal>. They're
  // appended to the same overlay collection so the dashboard can render
  // both from a single sidecar fetch.
  features.push(...extractCrosswalkFeatures(cleaned, transform));

  return { type: "FeatureCollection", features };
}
