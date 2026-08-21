import type { CatalogActorClass, Dims, PropClass } from "@uniscenarios/prop-catalog";

/**
 * One measured CARLA object, as the add-actor panel merges it into the bundled
 * catalog. Fetching and registering these is a product concern; the rail takes
 * them as a prop.
 */
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
