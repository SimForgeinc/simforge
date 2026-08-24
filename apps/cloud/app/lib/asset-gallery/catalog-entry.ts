import {
  PROP_TAGS,
  type ExternalCatalogEntry,
  type PropTag,
} from "@uniscenarios/prop-catalog";
import type { GalleryCatalogEntryDto } from "./contracts";

const PROP_TAG_SET = new Set<string>(PROP_TAGS);

/** Convert persisted gallery metadata into the catalog contract shared by editor and compiler. */
export function galleryCatalogEntry(dto: GalleryCatalogEntryDto): ExternalCatalogEntry {
  const actorClass = dto.actorClass === "vehicle" ? "car" : dto.actorClass;
  const propClass = dto.actorClass === "static_object" ? "street" : dto.actorClass;
  return {
    id: dto.catalogId,
    label: dto.label,
    class: propClass,
    actorClass,
    description: dto.label,
    dims: dto.dims,
    tags: dto.tags.filter((tag): tag is PropTag => PROP_TAG_SET.has(tag)),
    defaultParams: {},
    model: { kind: "glb", ...dto.model },
  };
}

/** Find immutable gallery references anywhere in persisted scenario content. */
export function collectGalleryCatalogIds(value: unknown): string[] {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (current: unknown) => {
    if (!current || typeof current !== "object") return;
    if (seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "catalogId" && isGalleryCatalogId(child)) ids.add(child);
      else visit(child);
    }
  };
  visit(value);
  return [...ids];
}

function isGalleryCatalogId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("gallery.");
}
