// Read side of the stop-family control ATTRIBUTION: a map's `signals_geojson`
// map-asset artifact (extracted from the same XODR the generator reasons over,
// so `road_id` is a direct match — no fuzzy geometry). We do NOT route to a
// specific control; we stop the subject at ANY junction approach and TAG the scenario
// by whichever control the geojson shows on that approach road (or `uncontrolled`).
// Crosswalk polygons ride in the same file, so pedestrian placement comes from here too.
//
// Mirrors extent-source.ts: server-only DB/S3 helpers are dynamically imported so
// standalone tsx tools keep a safe module graph, and every miss degrades to null.

export type SignalCategory =
  | "stop_sign"
  | "stop_line"
  | "yield_sign"
  | "traffic_light"
  | "crosswalk"
  | "other";

/** The four control classes a junction approach is tagged with. */
export type JunctionControl =
  | "uncontrolled"
  | "stop_sign"
  | "yield_sign"
  | "traffic_light";

export type SignalFeature = {
  category: SignalCategory;
  roadId: number | null;
  /** station along the road (XODR s), when the source carries it. */
  s: number | null;
  /** representative point (lon, lat) — signal point, or crosswalk centroid. */
  lon: number;
  lat: number;
  /** crosswalk polygon ring [ [lon,lat], … ] (crosswalk features only). */
  polygon?: Array<[number, number]>;
};

export type MapSignals = {
  signals: SignalFeature[];
  crosswalks: SignalFeature[];
};

function classify(signalCategory: string | undefined, featureKind: string | undefined): SignalCategory {
  if (featureKind === "crosswalk") return "crosswalk";
  switch (signalCategory) {
    case "stop_sign":
      return "stop_sign";
    case "stop_line":
      return "stop_line";
    case "yield_sign":
      return "yield_sign";
    case "traffic_light":
      return "traffic_light";
    default:
      return "other";
  }
}

function centroid(coords: unknown): [number, number] | null {
  // Point: [lon, lat]; Polygon: [[[lon,lat],…]] — average the first ring.
  if (!Array.isArray(coords)) return null;
  if (typeof coords[0] === "number" && typeof coords[1] === "number") {
    return [coords[0], coords[1]];
  }
  const ring = Array.isArray(coords[0]) && Array.isArray((coords[0] as unknown[])[0])
    ? (coords[0] as Array<[number, number]>)
    : (coords as Array<[number, number]>);
  if (!Array.isArray(ring) || ring.length === 0) return null;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of ring) {
    if (Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number") {
      sx += p[0];
      sy += p[1];
      n += 1;
    }
  }
  return n ? [sx / n, sy / n] : null;
}

/** Parse a signals.geojson FeatureCollection into the control model. Pure; safe
 * to unit-test against a fixture. Returns null only on unparseable input. */
export function parseSignalsGeojson(text: string): MapSignals | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const features = (doc as { features?: unknown[] })?.features;
  if (!Array.isArray(features)) return null;
  const signals: SignalFeature[] = [];
  const crosswalks: SignalFeature[] = [];
  for (const f of features) {
    const props = (f as { properties?: Record<string, unknown> })?.properties ?? {};
    const geom = (f as { geometry?: { type?: string; coordinates?: unknown } })?.geometry ?? {};
    const cat = classify(props.signal_category as string, props.feature_kind as string);
    const c = centroid(geom.coordinates);
    if (!c) continue;
    const roadIdRaw = props.road_id;
    const roadId =
      typeof roadIdRaw === "number"
        ? roadIdRaw
        : typeof roadIdRaw === "string" && roadIdRaw.trim() !== ""
          ? Number(roadIdRaw)
          : null;
    const feat: SignalFeature = {
      category: cat,
      roadId: roadId !== null && Number.isFinite(roadId) ? roadId : null,
      s: typeof props.s === "number" ? props.s : null,
      lon: c[0],
      lat: c[1],
    };
    if (cat === "crosswalk") {
      const ring = geom.type === "Polygon" ? (geom.coordinates as Array<Array<[number, number]>>)?.[0] : undefined;
      if (Array.isArray(ring)) feat.polygon = ring;
      crosswalks.push(feat);
    } else {
      signals.push(feat);
    }
  }
  return { signals, crosswalks };
}

// stop_line accompanies a stop sign (it's the paint at a stop-controlled entry),
// so both map to the stop_sign control class.
const CONTROL_OF: Partial<Record<SignalCategory, JunctionControl>> = {
  traffic_light: "traffic_light",
  stop_sign: "stop_sign",
  stop_line: "stop_sign",
  yield_sign: "yield_sign",
};

/**
 * Tag a junction approach by the control on its approach road. A junction entry
 * is regulated by the control near the END of the approach lane; we match by
 * `road_id` and, when both the signal and the segment carry `s`, prefer the
 * control closest to the segment's junction end. Priority when a road carries
 * more than one (a light-controlled intersection can also have a painted stop
 * line): traffic_light > stop_sign > yield_sign.
 */
export function attributeControl(
  signals: MapSignals | null,
  roadId: number,
  opts?: { sEnd?: number; sTolerance?: number },
): JunctionControl {
  if (!signals) return "uncontrolled";
  const tol = opts?.sTolerance ?? Infinity;
  const onRoad = signals.signals.filter((f) => {
    if (f.roadId !== roadId) return false;
    if (opts?.sEnd != null && f.s != null && Number.isFinite(tol)) {
      return Math.abs(f.s - opts.sEnd) <= tol;
    }
    return true;
  });
  const classes = new Set<JunctionControl>();
  for (const f of onRoad) {
    const c = CONTROL_OF[f.category];
    if (c) classes.add(c);
  }
  if (classes.has("traffic_light")) return "traffic_light";
  if (classes.has("stop_sign")) return "stop_sign";
  if (classes.has("yield_sign")) return "yield_sign";
  return "uncontrolled";
}

/** Fetch a map's signals overlay from its `signals_geojson` map-asset artifact.
 * Returns null on ANY miss (no asset, no artifact, unreadable S3, malformed) so
 * the caller degrades to uncontrolled-only tagging. Never throws. */
export async function fetchMapSignals(mapName: string): Promise<MapSignals | null> {
  try {
    const [{ resolveMapAssetReference }, { getMapArtifactLocation }, { getS3ObjectBytes }, { gunzipToUtf8 }] =
      await Promise.all([
        import("@/app/lib/scenario-editor/scenario-api-store"),
        import("@/app/lib/db/map-asset-store"),
        import("@/app/lib/s3/s3-get-object"),
        import("@/app/lib/s3/gzip"),
      ]);
    const ref = await resolveMapAssetReference(mapName);
    if (!ref?.mapAssetId) return null;
    const location = await getMapArtifactLocation(ref.mapAssetId, "signals_geojson");
    if (!location) return null;
    const bytes = await getS3ObjectBytes(location.bucket, location.key);
    // signals_geojson is stored gzipped (gzip-existing-map-artifacts.ts), but the
    // Content-Encoding metadata getS3ObjectUtf8 relies on isn't set consistently across
    // uploads — sniff the gzip magic (1f 8b) and inflate ourselves.
    const isGzip = bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
    const text = isGzip ? await gunzipToUtf8(bytes) : Buffer.from(bytes).toString("utf8");
    return parseSignalsGeojson(text);
  } catch {
    return null;
  }
}
