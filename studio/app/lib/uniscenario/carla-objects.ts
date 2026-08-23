import type { ScenarioTemplateV2 } from "@simforge/scenario";
import {
  PROP_TAGS,
  registerExternalCatalogEntry,
  type CatalogActorClass,
  type Dims,
  type ExternalCatalogEntry,
  type PropClass,
  type PropTag,
} from "@simforge/asset-catalog";

export interface CarlaObjectDto {
  readonly catalogId: string;
  readonly label: string;
  readonly class: PropClass;
  readonly actorClass: CatalogActorClass;
  readonly dims: Dims;
  readonly tags: string[];
  readonly blueprintId: string;
  readonly size?: string;
}

interface CarlaObjectCatalogResponse {
  readonly carlaVersion: string;
  readonly objects: CarlaObjectDto[];
}

const PROP_TAG_SET = new Set<string>(PROP_TAGS);
const CLASS_TINTS: Readonly<Record<PropClass, string>> = {
  vehicle: "#68a5ff",
  pedestrian: "#f2b35f",
  sidewalk_robot: "#73d5ff",
  drone: "#9ea7ff",
  animal: "#d7ae76",
  construction: "#ff9250",
  street: "#72c4ae",
  occluder: "#a68de7",
  hazard: "#e06767",
};

let catalogRequest: Promise<CarlaObjectCatalogResponse> | null = null;
const objectsById = new Map<string, CarlaObjectDto>();

/** Fetch and synchronously register every measured CARLA object in this window. */
export async function registerCarlaObjects(): Promise<readonly CarlaObjectDto[]> {
  const catalog = await loadCatalog();
  for (const dto of catalog.objects) registerDto(dto);
  return catalog.objects;
}

/** Resolve one CARLA catalog id, registering its proxy before returning it. */
export async function carlaObjectById(catalogId: string): Promise<CarlaObjectDto | undefined> {
  if (!isCarlaCatalogId(catalogId)) return undefined;
  const cached = objectsById.get(catalogId);
  if (cached) {
    registerDto(cached);
    return cached;
  }
  await registerCarlaObjects();
  return objectsById.get(catalogId);
}

/** Register CARLA references before a scenario document reaches editor-core. */
export async function primeCarlaObjectsForDocument(template: ScenarioTemplateV2): Promise<string[]> {
  const ids = collectCarlaCatalogIds(template);
  if (!ids.length) return [];
  await registerCarlaObjects();
  return ids.filter((id) => !objectsById.has(id));
}

function loadCatalog(): Promise<CarlaObjectCatalogResponse> {
  catalogRequest ??= fetch("/api/carla-objects").then(async (response) => {
    if (!response.ok) throw new Error(`Could not load CARLA objects (${response.status}).`);
    const catalog = (await response.json()) as CarlaObjectCatalogResponse;
    for (const dto of catalog.objects) objectsById.set(dto.catalogId, dto);
    return catalog;
  });
  return catalogRequest;
}

function registerDto(dto: CarlaObjectDto): void {
  const entry: ExternalCatalogEntry = {
    id: dto.catalogId,
    label: dto.label,
    class: dto.class,
    actorClass: dto.actorClass,
    description: `${dto.label} (${dto.blueprintId}), measured from CARLA 0.10.0.`,
    dims: dto.dims,
    tags: dto.tags.filter((tag): tag is PropTag => PROP_TAG_SET.has(tag)),
    defaultParams: {},
    model: { kind: "proxy", tint: CLASS_TINTS[dto.class] },
  };
  registerExternalCatalogEntry(entry);
}

function collectCarlaCatalogIds(value: unknown): string[] {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  const visit = (current: unknown): void => {
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (key === "catalogId" && isCarlaCatalogId(child)) ids.add(child);
      else visit(child);
    }
  };
  visit(value);
  return [...ids];
}

function isCarlaCatalogId(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("carla.");
}
