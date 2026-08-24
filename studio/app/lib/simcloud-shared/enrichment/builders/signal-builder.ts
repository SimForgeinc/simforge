/**
 * Signal and sign scene-graph builder.
 *
 * Extracts signal/sign entities from XODR <signal> elements with
 * geographic position resolution and MUTCD-based classification.
 */

import type { SignalEntity } from "../../map-intelligence";
import type { CoordTransform } from "../xodr-geometry";
import { attr, stripXmlComments } from "../xodr-utils";
import { parseGeometrySegments, resolveSTtoXY, localToLonLat } from "../xodr-geometry";

export type BuildSignalsResult = {
  signals: SignalEntity[];
  signs: SignalEntity[];
  warnings: string[];
};

export function buildSignals(
  xodrText: string,
  coordTransform: CoordTransform,
): BuildSignalsResult {
  const warnings: string[] = [];
  if (!xodrText.trim()) {
    warnings.push("signal-builder: empty XODR text");
    return { signals: [], signs: [], warnings };
  }

  const cleaned = stripXmlComments(xodrText);
  const signals: SignalEntity[] = [];
  const signs: SignalEntity[] = [];

  // Build road geometry index
  const roadGeometries = new Map<string, ReturnType<typeof parseGeometrySegments>>();
  const roadBlockRe = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm: RegExpExecArray | null;
  while ((rm = roadBlockRe.exec(cleaned)) !== null) {
    const roadAttrs = rm[1]!;
    const roadBody = rm[2]!;
    const roadId = attr(roadAttrs, "id");
    if (!roadId) continue;
    const segments = parseGeometrySegments(roadBody);
    if (segments.length > 0) roadGeometries.set(roadId, segments);
  }

  // Scan roads for signals
  const roadBlockRe2 = /<road\b([^>]*)>([\s\S]*?)<\/road>/gi;
  let rm2: RegExpExecArray | null;
  let idx = 0;
  while ((rm2 = roadBlockRe2.exec(cleaned)) !== null) {
    const roadAttrs = rm2[1]!;
    const roadBody = rm2[2]!;
    const roadId = attr(roadAttrs, "id");
    if (!roadId) continue;

    const segments = roadGeometries.get(roadId);
    if (!segments || segments.length === 0) continue;

    const sigRe = /<signal\b([^>]*)(?:\/>|>([\s\S]*?)<\/signal>)/gi;
    let sm: RegExpExecArray | null;
    while ((sm = sigRe.exec(roadBody)) !== null) {
      const sigAttrs = sm[1] ?? "";
      const name = attr(sigAttrs, "name") ?? "";
      const s = Number(attr(sigAttrs, "s") ?? "0");
      const t = Number(attr(sigAttrs, "t") ?? "0");

      const category = classifySignalCategory(name);
      if (category === "stop_line") continue; // Skip road markings

      // Resolve position
      let center = { lat: coordTransform.originLat, lng: coordTransform.originLon };
      const xy = resolveSTtoXY(segments, s, t);
      if (xy) {
        const [lon, lat] = localToLonLat(xy, coordTransform);
        center = { lat, lng: lon };
      }

      const isSignal = category === "traffic_light";
      const kind = isSignal ? "signal" as const : "sign" as const;
      const displayName = name || `${category} on road ${roadId}`;

      const entity: SignalEntity = {
        entityId: `${kind}_${idx}`,
        kind,
        center,
        region: { type: "Point", coordinates: [center.lng, center.lat] },
        provenance: {
          sourceFile: "xodr",
          sourceIds: [roadId],
          extractorVersion: "1.0.0",
        },
        signalCategory: category,
        roadId,
        mutcdCode: extractMutcdCode(name),
        displayName,
      };

      if (isSignal) {
        signals.push(entity);
      } else {
        signs.push(entity);
      }
      idx += 1;
    }
  }

  return { signals, signs, warnings };
}

function classifySignalCategory(name: string): string {
  const n = name.toLowerCase();
  if (/signal_.*light|walk_light/i.test(n)) return "traffic_light";
  if (/stopline/i.test(n)) return "stop_line";
  if (/^sign_r1[_-]1/i.test(n) || /stop.*sign/i.test(n)) return "stop_sign";
  if (/^sign_r1[_-]2/i.test(n) || /yield/i.test(n)) return "yield_sign";
  if (/^sign_r2/i.test(n) || /speed.*limit/i.test(n)) return "speed_limit_sign";
  if (/bus.?stop/i.test(n)) return "bus_stop";
  if (/^sign_s/i.test(n) || /school/i.test(n)) return "school_sign";
  if (/^sign_w/i.test(n)) return "warning_sign";
  if (/^sign_/i.test(n)) return "regulatory_sign";
  return "unknown";
}

function extractMutcdCode(name: string): string | undefined {
  // MUTCD codes follow "Sign_R1-1" pattern
  const m = name.match(/^Sign_([A-Z][0-9]+(?:-[0-9]+[a-zA-Z]?)?)/i);
  return m?.[1]?.toUpperCase();
}
