/**
 * SimForge provenance carried in an .xosc `FileHeader@description`.
 *
 * ## The problem
 *
 * An OpenSCENARIO file names its OpenDRIVE map (`RoadNetwork/LogicFile`) and
 * nothing else about where it came from. That is not enough to reopen one of
 * OUR exports in the editor: the writer's `logicFile` is the basename of the
 * map asset's XODR artifact (`san-ramon-part-1_20260522-091430.xodr`), which
 * matches neither the map asset's display `name` nor its runtime map name.
 * Importing by LogicFile name alone therefore fails to resolve the map for
 * exactly the files we wrote ourselves.
 *
 * ## The carrier, and why it is this one
 *
 * The id rides as a structured suffix on `FileHeader@description`:
 *
 *     description="dsc_f38689a3 [simforge:map_asset=ma_123;map=San_Ramon_P1]"
 *
 * Alternatives considered and rejected:
 *
 * * **`ParameterDeclarations`.** Structurally the "right" OSC home for
 *   name/value metadata, but it turns the writer's `<ParameterDeclarations/>`
 *   from an empty element into a container — a real change to the document
 *   tree that every consumer walks, and one esmini registers as scenario
 *   parameters (`--param_value` addressable, listed by its parameter tooling).
 * * **`author`.** Free text like `description`, but it is the field a human
 *   reads to know who produced the file; overloading it is worse for no gain.
 *
 * `description` wins because the change is confined to the TEXT of an
 * attribute that already exists and that OSC 1.0 gives no semantics to
 * whatsoever — no runner branches on it, so the suffix is inert by
 * construction rather than by testing. Our own writer already puts a machine
 * identifier there (`metadata.sourceScenarioId`), so it was never a prose
 * field to begin with.
 *
 * ## Format
 *
 * A single trailing ` [simforge:<k>=<v>;<k>=<v>]` group. Values are
 * percent-encoded, so a `;`, `]` or `%` inside an id or map name round-trips.
 * Unknown keys are ignored on read, which is what makes the format extensible
 * without a version number: a reader older than the writer drops what it does
 * not know and still gets the keys it does.
 *
 * Nothing here throws. A description with no group, a malformed group, or a
 * group with no recognised keys all read back as "no metadata" with the raw
 * text preserved as the description.
 */

/** Keys currently defined in the group. Readers ignore anything else. */
const MAP_ASSET_KEY = "map_asset";
const MAP_NAME_KEY = "map";

/**
 * The trailing group. `[^\]]*` keeps it to ONE bracket group anchored at the
 * end, so a description that itself contains brackets is not mistaken for one.
 */
const GROUP_PATTERN = /\s*\[simforge:([^\]]*)\]\s*$/;

export type XoscFileHeaderMetadata = {
  /** The description with any SimForge group stripped. Never null; may be "". */
  description: string;
  /** The exported scenario's map asset id, or null when the file carries none. */
  mapAssetId: string | null;
  /** The map name the export was authored against, or null. */
  mapName: string | null;
};

function encodeValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray `%` that is not a valid escape. Take the text as written rather
    // than losing the whole field.
    return value;
  }
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Strip any SimForge group from a description, returning the human half.
 *
 * Exported for the writer, which re-encodes from the draft rather than from
 * whatever a caller handed it: without this, re-exporting an imported file
 * would nest one group inside the next.
 */
export function stripXoscFileHeaderMetadata(description: string): string {
  return description.replace(GROUP_PATTERN, "").trim();
}

/**
 * Build the `FileHeader@description` for an export.
 *
 * With neither a map asset id nor a map name the description is returned
 * untouched, so a draft with no map metadata emits exactly what it always did.
 */
export function encodeXoscFileHeaderDescription(input: {
  description: string;
  mapAssetId?: string | null;
  mapName?: string | null;
}): string {
  const base = stripXoscFileHeaderMetadata(input.description);
  const parts: string[] = [];
  const mapAssetId = clean(input.mapAssetId);
  const mapName = clean(input.mapName);
  if (mapAssetId) parts.push(`${MAP_ASSET_KEY}=${encodeValue(mapAssetId)}`);
  if (mapName) parts.push(`${MAP_NAME_KEY}=${encodeValue(mapName)}`);
  if (parts.length === 0) return base;
  const group = `[simforge:${parts.join(";")}]`;
  return base ? `${base} ${group}` : group;
}

/** Read a `FileHeader@description` back into its human half and its metadata. */
export function parseXoscFileHeaderDescription(
  description: string | null | undefined,
): XoscFileHeaderMetadata {
  const raw = description ?? "";
  const match = GROUP_PATTERN.exec(raw);
  if (!match) {
    return { description: raw.trim(), mapAssetId: null, mapName: null };
  }

  let mapAssetId: string | null = null;
  let mapName: string | null = null;
  for (const entry of match[1]!.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    const value = clean(decodeValue(entry.slice(separator + 1)));
    if (!value) continue;
    if (key === MAP_ASSET_KEY) mapAssetId = value;
    else if (key === MAP_NAME_KEY) mapName = value;
  }

  return {
    // A group with nothing readable in it is still OUR group; stripping it
    // keeps the description a description rather than leaking the marker into
    // the scenario id.
    description: raw.slice(0, match.index).trim(),
    mapAssetId,
    mapName,
  };
}
