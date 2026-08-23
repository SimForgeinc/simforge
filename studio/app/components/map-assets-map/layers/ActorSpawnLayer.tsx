import { Marker } from "react-map-gl/maplibre";
import { ActorIcon } from "@/app/lib/scenario-editor/actor-svgs";
import type { ActorSpawn2D } from "@/app/lib/maps/frontend/scenario-actor-spawns";

/**
 * 2D map overlay rendering one spawn marker per actor for the highlighted
 * AI-proposed scenario. Sits alongside the trajectory `LineString` layer
 * and the collision-point red-X marker — the three together give a
 * reviewer the whole story of a draft (where each actor starts, where it
 * goes, where the planner expected the pair to meet) without opening the
 * editor.
 *
 * Icon: the same `ActorIcon` SVGs the scenario editor renders inside
 * `RuntimeActorLayers`, tinted with the per-id hex from
 * `deriveActorColor` so the marker reads as "that actor" — matching its
 * trajectory line's color.
 */

type ActorSpawnLayerProps = {
  spawns: ActorSpawn2D[];
};

const VEHICLE_SIZE = 40;
const WALKER_SIZE = 22;
const PROP_SIZE = 24;

function markerSize(kind: ActorSpawn2D["kind"]): number {
  switch (kind) {
    case "walker":
      return WALKER_SIZE;
    case "prop":
      return PROP_SIZE;
    default:
      return VEHICLE_SIZE;
  }
}

export function ActorSpawnLayer({ spawns }: ActorSpawnLayerProps) {
  if (spawns.length === 0) return null;
  return (
    <>
      {spawns.map((spawn) => {
        const size = markerSize(spawn.kind);
        const rotation = spawn.rotationDeg ?? 0;
        return (
          <Marker
            key={spawn.id}
            longitude={spawn.lng}
            latitude={spawn.lat}
            anchor="center"
            pitchAlignment="map"
            rotationAlignment="map"
          >
            <div
              aria-label={`Spawn point: ${spawn.label}`}
              title={spawn.label}
              style={{
                width: size,
                height: size,
                pointerEvents: "auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                // Per-actor color matches the trajectory line + heading
                // arrowhead. The ActorIcon SVG uses `currentColor` for
                // fills, so this `color` plumbs straight through.
                color: spawn.color,
                transform: `rotate(${rotation}deg)`,
                filter:
                  "drop-shadow(0 1px 1.5px rgba(0,0,0,0.55)) drop-shadow(0 0 1px rgba(0,0,0,0.55))",
              }}
            >
              <ActorIcon
                kind={spawn.kind}
                blueprint={spawn.blueprint ?? undefined}
                variant="draft"
                style={{ width: size, height: size }}
              />
            </div>
          </Marker>
        );
      })}
    </>
  );
}
