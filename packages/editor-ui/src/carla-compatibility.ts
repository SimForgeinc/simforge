export type CarlaCompatibilityStatus = "native" | "generated-pack" | "browser-only";

type DimensionalAgreement = "exact" | "close" | "loose";

export type CarlaCompatibility =
  | { status: "native"; blueprintId: string; dimensionalAgreement: DimensionalAgreement }
  | { status: "generated-pack"; reason: string }
  | { status: "browser-only"; reason: string };

export interface CarlaCompatibilityTable {
  carlaVersion: string;
  native: Record<string, {
    blueprintId: string;
    dimensionalAgreement: DimensionalAgreement;
  }>;
  unavailable: Record<string, string>;
}

export const CARLA_COMPATIBILITY_LABEL: Record<CarlaCompatibilityStatus, string> = {
  native: "CARLA ready",
  "generated-pack": "CARLA pack required",
  "browser-only": "Browser only",
};

export const CARLA_COMPATIBILITY_HINT: Record<CarlaCompatibilityStatus, string> = {
  native: "Runs in CARLA with a measured runtime blueprint.",
  "generated-pack": "Requires a generated CARLA asset pack before it can run in CARLA.",
  "browser-only": "Renders in browser preview and browser-recorded renders only.",
};

const GALLERY_BROWSER_ONLY_REASON =
  "User-uploaded model has no CARLA runtime blueprint; it renders in browser preview and browser-recorded renders only.";
const MISSING_BINDING_REASON = "no CARLA binding is recorded for this catalog id";

/** Resolve one catalog id against a previously loaded CARLA compatibility table. */
export function carlaCompatibilityFor(
  catalogId: string,
  table: CarlaCompatibilityTable,
): CarlaCompatibility {
  if (Object.prototype.hasOwnProperty.call(table.native, catalogId)) {
    const entry = table.native[catalogId]!;
    return {
      status: "native",
      blueprintId: entry.blueprintId,
      dimensionalAgreement: entry.dimensionalAgreement,
    };
  }
  if (Object.prototype.hasOwnProperty.call(table.unavailable, catalogId)) {
    return { status: "generated-pack", reason: table.unavailable[catalogId]! };
  }
  if (catalogId.startsWith("gallery.")) {
    return { status: "browser-only", reason: GALLERY_BROWSER_ONLY_REASON };
  }
  return { status: "generated-pack", reason: MISSING_BINDING_REASON };
}
