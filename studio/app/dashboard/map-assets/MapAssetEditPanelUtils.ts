import type { MapAssetArtifactType, MapCoordinateRef, MapPlaceContext } from "@simforge-oss/studio-shared";

/** Display a tag ID with underscores replaced by spaces for readability. */
export function displayTag(tagId: string): string {
  return tagId.replace(/_/g, " ");
}

export type MediaEntry = { id: string; file: File; label: string };

export function newEntry(file: File): MediaEntry {
  return { id: crypto.randomUUID(), file, label: "" };
}

export function artifactTypeFromFilename(filename: string): MapAssetArtifactType {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  if (ext === "mp4") return "mp4";
  if (ext === "jpg" || ext === "jpeg" || ext === "png" || ext === "webp") return "image";
  return "image";
}

export async function sha256Hex(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Build the place_context payload for the PATCH body.
 * Preserves existing geocoder + country_code when the user only edits the text fields.
 */
export function buildPlaceContextPayload(
  city: string,
  state: string,
  country: string,
  existing: MapPlaceContext | undefined,
): MapPlaceContext {
  const cityVal = city.trim() || existing?.city;
  const stateVal = state.trim() || existing?.state;
  const countryVal = country.trim() || existing?.country;
  // If the user changed any field, mark the record as manually overridden.
  const wasEdited = city.trim() || state.trim() || country.trim();
  return {
    city: cityVal,
    state: stateVal,
    country: countryVal,
    country_code: existing?.country_code,
    geocoder: wasEdited ? "manual" : existing?.geocoder ?? "geonames-local",
  };
}

function parseOffsetInput(value: string, label: string): number {
  const parsed = Number.parseFloat(value.trim() || "0");
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number.`);
  }
  return parsed;
}

export function buildMapCoordinateRefPayload(
  xInput: string,
  yInput: string,
  existing: MapCoordinateRef | undefined,
): MapCoordinateRef {
  return {
    ...(existing ?? {}),
    editor_offset_m: {
      x: parseOffsetInput(xInput, "Editor X offset"),
      y: parseOffsetInput(yInput, "Editor Y offset"),
    },
  };
}
