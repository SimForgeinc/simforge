/**
 * Pure utility functions for the Add Map form. Extracted from AddMapForm.tsx
 * for testability. No React hooks, no DOM access.
 */

import type { MapAssetArtifactType } from "@simcloud/shared";

// ---------------------------------------------------------------------------
// Types (shared with AddMapForm)
// ---------------------------------------------------------------------------

export type ComputedGeo = {
  center: { lat: number; lng: number };
  bbox: { min_lat: number; min_lng: number; max_lat: number; max_lng: number };
};

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Convert a map name to a URL-safe kebab-case slug (max 48 chars). */
export function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[\s\W_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-")
      .slice(0, 48)
      .replace(/-+$/, "") || "map"
  );
}

/** Format a date as `YYYYMMDD-hhmmss`. */
export function formatTimestamp(d: Date): string {
  const y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, "0");
  const D = String(d.getDate()).padStart(2, "0");
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${y}${M}${D}-${h}${m}${s}`;
}

/** Generate a map asset ID from a name and timestamp: `{slugified}_{timestamp}`. */
export function generateMapAssetId(name: string, now: Date): string {
  return `${slugify(name)}_${formatTimestamp(now)}`;
}

// ---------------------------------------------------------------------------
// GeoJSON parsing
// ---------------------------------------------------------------------------

/** Recursively collect all [lng, lat] coordinate pairs from any GeoJSON geometry or feature. */
export function collectCoordinates(obj: unknown): [number, number][] {
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;

  if (o.type === "Point" && Array.isArray(o.coordinates)) {
    const c = o.coordinates as number[];
    return [[c[0]!, c[1]!] as [number, number]];
  }
  if ((o.type === "LineString" || o.type === "MultiPoint") && Array.isArray(o.coordinates)) {
    return (o.coordinates as number[][]).map((c) => [c[0]!, c[1]!] as [number, number]);
  }
  if ((o.type === "Polygon" || o.type === "MultiLineString") && Array.isArray(o.coordinates)) {
    return (o.coordinates as number[][][]).flatMap((ring) =>
      ring.map((c) => [c[0]!, c[1]!] as [number, number]),
    );
  }
  if (o.type === "MultiPolygon" && Array.isArray(o.coordinates)) {
    return (o.coordinates as number[][][][]).flatMap((poly) =>
      poly.flatMap((ring) => ring.map((c) => [c[0]!, c[1]!] as [number, number])),
    );
  }
  if (o.type === "GeometryCollection" && Array.isArray(o.geometries)) {
    return (o.geometries as unknown[]).flatMap(collectCoordinates);
  }
  if (o.type === "Feature") {
    return collectCoordinates(o.geometry);
  }
  if (o.type === "FeatureCollection" && Array.isArray(o.features)) {
    return (o.features as unknown[]).flatMap(collectCoordinates);
  }
  return [];
}

/** Parse a GeoJSON string, validate it has coordinates, and compute bbox + center. */
export function parseGeoJson(text: string): { geo: ComputedGeo; data: object } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { error: "Invalid JSON — could not parse the file." };
  }

  const coords = collectCoordinates(json);
  if (coords.length === 0) {
    return { error: "No coordinates found in GeoJSON." };
  }

  let min_lng = Infinity,
    max_lng = -Infinity;
  let min_lat = Infinity,
    max_lat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < min_lng) min_lng = lng;
    if (lng > max_lng) max_lng = lng;
    if (lat < min_lat) min_lat = lat;
    if (lat > max_lat) max_lat = lat;
  }

  return {
    geo: {
      center: { lat: (min_lat + max_lat) / 2, lng: (min_lng + max_lng) / 2 },
      bbox: { min_lat, min_lng, max_lat, max_lng },
    },
    data: json as object,
  };
}

// ---------------------------------------------------------------------------
// File / artifact helpers
// ---------------------------------------------------------------------------

/** Map a file extension to its artifact type. Returns null for unsupported extensions. */
export function artifactTypeFromExtension(filename: string): MapAssetArtifactType | null {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (ext === "geojson" || ext === "json") return "geojson";
  if (ext === "xodr") return "xodr";
  if (ext === "xml") return "rrdata_xml";
  if (ext === "fbx") return "fbx";
  if (ext === "mp4") return "mp4";
  if (ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp") return "image";
  return null;
}

/** Compute SHA-256 hash of a file in the browser; returns hex string. */
export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Display a tag ID with underscores replaced by spaces for readability. */
export function displayTag(tagId: string): string {
  return tagId.replace(/_/g, " ");
}

/** Build a default map name like "Map of San Jose, California, United States". */
export function buildDefaultMapName(city?: string, state?: string, country?: string): string {
  const parts = [city, state, country].filter(Boolean);
  return parts.length > 0 ? `Map of ${parts.join(", ")}` : "";
}

/** Normalize lane count keys from various casing to standard format. */
export function mapLaneCountsLocal(raw: Record<string, number>) {
  const get = (k: string) => raw[k] ?? raw[k.toLowerCase()] ?? 0;
  return {
    driving: get("driving"),
    sidewalk: get("sidewalk"),
    biking: get("biking"),
    shoulder: get("shoulder"),
    restricted: get("restricted"),
    bidirectional: get("bidirectional"),
    none: get("none"),
  };
}
