/**
 * OpenDRIVE `<header>` parsing.
 *
 * RoadRunner-authored `.xodr` files are large (Yale Street is ~6 MB) but the
 * only part needed to georeference a map is the first few kilobytes: the
 * `north/south/east/west` extents attribute set and the `<geoReference>` PROJ
 * string. Everything here is a streaming/regex parse over a text prefix, so it
 * never materialises the road network.
 */

/** Bounding rectangle of the road network in OpenDRIVE-local metres. */
export interface MapExtents {
  /** Maximum local Y (northing), metres. */
  north: number;
  /** Minimum local Y (northing), metres. */
  south: number;
  /** Maximum local X (easting), metres. */
  east: number;
  /** Minimum local X (westing), metres. */
  west: number;
}

/** Everything the toolkit needs from an OpenDRIVE header. */
export interface XodrHeader {
  /** PROJ.4 string from `<geoReference>`, e.g. `+proj=tmerc +lat_0=... `. */
  projString: string;
  /** Road-network extents in OpenDRIVE-local metres. */
  extents: MapExtents;
  /** `revMajor.revMinor`, e.g. `1.4`. */
  revision: string;
  /** Optional `name` attribute (often empty in RoadRunner exports). */
  name: string;
  /** Optional `vendor` attribute, e.g. `MathWorks`. */
  vendor: string;
  /** Optional ISO-ish `date` attribute. */
  date: string;
}

const HEADER_RE = /<header\b([^>]*)>/;
const GEOREF_RE = /<geoReference\b[^>]*>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/geoReference>/;

function attr(attrs: string, key: string): string | undefined {
  const m = new RegExp(`\\b${key}="([^"]*)"`).exec(attrs);
  return m?.[1];
}

function numAttr(attrs: string, key: string): number {
  const raw = attr(attrs, key);
  const n = raw === undefined ? Number.NaN : Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`xodr header: missing or non-numeric "${key}" attribute`);
  }
  return n;
}

/**
 * Parse an OpenDRIVE header out of raw `.xodr` text.
 *
 * Only a prefix of the document is required — passing the first ~4 KB is
 * enough for RoadRunner exports (see `fixtures/yale-header.xodr`).
 *
 * @param text Raw XML text (full document or a leading slice of it).
 * @throws If the `<header>` element, its extents, or `<geoReference>` are absent.
 */
export function parseXodrHeader(text: string): XodrHeader {
  const header = HEADER_RE.exec(text);
  if (!header?.[1]) throw new Error('xodr header: no <header ...> element found');
  const attrs = header[1];

  const geo = GEOREF_RE.exec(text);
  const projString = geo?.[1]?.trim();
  if (!projString) throw new Error('xodr header: no <geoReference> PROJ string found');

  return {
    projString,
    extents: {
      north: numAttr(attrs, 'north'),
      south: numAttr(attrs, 'south'),
      east: numAttr(attrs, 'east'),
      west: numAttr(attrs, 'west'),
    },
    revision: `${attr(attrs, 'revMajor') ?? '?'}.${attr(attrs, 'revMinor') ?? '?'}`,
    name: attr(attrs, 'name') ?? '',
    vendor: attr(attrs, 'vendor') ?? '',
    date: attr(attrs, 'date') ?? '',
  };
}

/**
 * Fetch just the header of a remote `.xodr` without downloading the whole file.
 *
 * Issues a HTTP Range request for the first `byteLength` bytes and falls back
 * to a full `GET` (reading only the prefix) when the server ignores ranges.
 *
 * @param url Location of the `.xodr`.
 * @param byteLength Prefix size to request. 16 KB comfortably covers RoadRunner headers.
 */
export async function fetchXodrHeader(url: string, byteLength = 16384): Promise<XodrHeader> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${byteLength - 1}` } });
  if (!res.ok) throw new Error(`xodr header: fetch ${url} failed (${res.status})`);
  const buf = await res.arrayBuffer();
  const text = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, byteLength)));
  return parseXodrHeader(text);
}
