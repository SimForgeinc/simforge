import catalog from "@/app/generated/carla-object-catalog.json";
import type { CarlaObjectDto } from "@/app/lib/scenario/carla-objects";

export type CarlaDimensionalAgreement = "exact" | "close" | "loose";

export interface CarlaObjectCatalogFile {
  readonly carlaVersion: string;
  readonly generatedFrom: { readonly inventorySha256: string };
  readonly objects: Array<{
    readonly id: string;
    readonly label: string;
    readonly class: CarlaObjectDto["class"];
    readonly actorClass: CarlaObjectDto["actorClass"];
    readonly dims: CarlaObjectDto["dims"];
    readonly tags: string[];
    readonly carla: { readonly blueprintId: string; readonly size?: string };
  }>;
  readonly equivalents: Array<{
    readonly catalogId: string;
    readonly blueprintId: string;
    readonly dimensionalAgreement: CarlaDimensionalAgreement;
  }>;
  readonly unavailable: Array<{
    readonly catalogId: string;
    readonly reason: string;
  }>;
}

/**
 * The catalog is imported, not read from disk.
 *
 * `config/scenario/carla/carla-object-catalog.json` lives outside `apps/web`
 * and is not traced into a serverless bundle, so a runtime `readFile` resolved
 * in development and threw in every deployed environment. The generator writes
 * a byte-identical copy into `app/generated/`, which the bundler links into
 * whatever needs it; `npm run carla:catalog:check` fails when the two drift.
 */
const catalogFile = catalog as unknown as CarlaObjectCatalogFile;

/** The generated CARLA object catalog, bundled at build time. */
export function loadCarlaObjectCatalogFile(): Promise<CarlaObjectCatalogFile> {
  return Promise.resolve(catalogFile);
}
