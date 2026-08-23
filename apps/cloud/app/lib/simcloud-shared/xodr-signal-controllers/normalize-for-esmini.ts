/**
 * Force `<signal>` country metadata into the one shape esmini accepts for a
 * controllable traffic light.
 *
 * ## The upstream rule (esmini v3.1.0, RoadManager.cpp)
 *
 * A `<signal>` is constructed as a `TrafficLight` — the only signal class
 * `TrafficSignalStateAction` can resolve — solely when
 *
 *     country == "opendrive" && country_revision < 2013 && dynamic
 *                                                   (RoadManager.cpp:4857)
 *
 * and `country_revision` is read through an inverted condition:
 *
 *     unsigned int country_revision = 2013;  // default
 *     if (signal.attribute("countryRevision").empty())
 *         country_revision = signal.attribute("countryRevision").as_uint();
 *                                             (RoadManager.cpp:4789-4791)
 *
 * The revision is therefore only ever read when the attribute is ABSENT
 * (yielding 0), and any signal that actually declares one is pinned to the
 * 2013 default and fails the gate. `country="OpenDRIVE"` with no
 * `countryRevision` is the only combination that passes.
 *
 * ## Why every real map needs this
 *
 * RoadRunner writes no `country` attribute at all (San Ramon: 149 dynamic
 * type-1000001 heads, zero country attributes), so esmini builds them as plain
 * `Signal`s and `TrafficSignalStateAction` hard-quits with "No matching traffic
 * signal with id ..." — it throws rather than warning, taking the whole
 * validation run with it (exit 255). Without this normalization no authored
 * signal plan can run against a real map.
 *
 * The rewrite applies to the copy of the map handed to esmini, never to the
 * stored artifact: `maps/<id>/<id>.xodr` is content-hashed into
 * `map_asset_artifacts.checksum_sha256` and source artifacts are immutable
 * house policy (see enrich-xodr.ts for the same rule).
 *
 * ## Why string surgery rather than parse + re-serialize
 *
 * Production XODRs run to ~12 MB (San Ramon) and are read by esmini, CARLA and
 * our own line-oriented parsers. A DOM round-trip would rewrite attribute
 * order, quoting, float formatting and whitespace across the entire document —
 * a large diff whose only intended content is two attributes per traffic
 * light, and one that risks changing geometry text that downstream consumers
 * compare byte-wise. Editing inside the matched `<signal ...>` tag leaves
 * every other byte, including the tag's own children, exactly as authored.
 */

/** OpenDRIVE signal types esmini maps to a controllable traffic light. */
const ESMINI_TRAFFIC_LIGHT_TYPES = ["1000001", "1000011"];

/** The only `country` value esmini's traffic-light gate accepts (lowercased). */
const ESMINI_COUNTRY = "OpenDRIVE";

const ATTR_RE = /([A-Za-z_][\w.-]*)\s*=\s*"([^"]*)"/g;

/**
 * Opening `<signal>` tags only. The `\b` cannot match `<signals>` or
 * `<signalReference>` (it requires a non-word character after "signal"), the
 * same tag-disambiguation trick the other XODR string passes rely on. The
 * optional `/` is captured separately so self-closing and container forms
 * reconstruct identically.
 */
const SIGNAL_TAG_RE = /(<signal\b)([^>]*?)(\/?)>/gi;

const COUNTRY_REVISION_RE = /\s*countryRevision\s*=\s*"[^"]*"/gi;

/** `country=` cannot match `countryRevision=`: the `=` must follow "country". */
const COUNTRY_RE = /(\bcountry\s*=\s*")([^"]*)(")/i;

function parseAttrs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(text)) !== null) out[match[1]!] = match[2]!;
  return out;
}

/**
 * Is this `<signal>` one esmini would treat as a traffic light once its
 * country metadata is normalized?
 *
 * Deliberately identical to `isEsminiControllableSignal` in the web app's
 * xosc-writer signal catalog (apps/web/app/lib/scenario-editor/xosc-writer/
 * signal-catalog.ts): the catalog decides which ids a scenario may command,
 * this decides which signals get made commandable, and the two sets must be
 * the same set or the writer emits ids esmini will reject. It is stricter than
 * `derive-signal-groups.ts`'s `isTrafficLightSignal`, which also accepts a name
 * heuristic — grouping tolerates a false positive, this does not.
 */
export function isEsminiTrafficLightSignal(attrs: Record<string, string>): boolean {
  if ((attrs.dynamic ?? "").trim().toLowerCase() !== "yes") return false;
  const type = (attrs.type ?? "").trim();
  return ESMINI_TRAFFIC_LIGHT_TYPES.some(
    (allowed) => type === allowed || type.startsWith(`${allowed}.`),
  );
}

export type NormalizeXodrForEsminiResult = {
  /** The normalized document. Byte-identical to the input when nothing applied. */
  xodr: string;
  stats: {
    /** Dynamic light-type `<signal>` elements found. */
    traffic_lights_seen: number;
    /** Of those, the ones whose country metadata actually changed. */
    traffic_lights_rewritten: number;
  };
};

/** Rewrite one tag's attribute text, or return it unchanged if already valid. */
function normalizeAttrText(attrText: string): string {
  let out = attrText.replace(COUNTRY_REVISION_RE, "");

  const country = COUNTRY_RE.exec(out);
  if (country) {
    if (country[2]!.trim().toLowerCase() !== ESMINI_COUNTRY.toLowerCase()) {
      out = out.replace(COUNTRY_RE, `$1${ESMINI_COUNTRY}$3`);
    }
    return out;
  }

  // Insert before any trailing whitespace so `<signal ... />` keeps its space.
  const trailing = /\s*$/.exec(out)![0];
  const head = out.slice(0, out.length - trailing.length);
  return `${head} country="${ESMINI_COUNTRY}"${trailing}`;
}

/** `normalizeXodrForEsmini` with the counts a caller may want to log. */
export function normalizeXodrForEsminiWithStats(xodrText: string): NormalizeXodrForEsminiResult {
  let seen = 0;
  let rewritten = 0;

  const xodr = xodrText.replace(
    SIGNAL_TAG_RE,
    (whole, open: string, attrText: string, slash: string) => {
      if (!isEsminiTrafficLightSignal(parseAttrs(attrText))) return whole;
      seen += 1;
      const normalized = normalizeAttrText(attrText);
      if (normalized === attrText) return whole;
      rewritten += 1;
      return `${open}${normalized}${slash}>`;
    },
  );

  return {
    xodr,
    stats: { traffic_lights_seen: seen, traffic_lights_rewritten: rewritten },
  };
}

/**
 * Make every dynamic traffic light in `xodrText` addressable by an esmini
 * `TrafficSignalStateAction`: `country="OpenDRIVE"`, no `countryRevision`.
 *
 * Idempotent, and a no-op (byte-identical output) for documents with no
 * dynamic light-type signals.
 */
export function normalizeXodrForEsmini(xodrText: string): string {
  return normalizeXodrForEsminiWithStats(xodrText).xodr;
}
