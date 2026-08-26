"use client";

import { Gauge, Plus, Trash2 } from "lucide-react";
import { defaultDashCamera, type ActorSensor } from "@simforge-oss/scenario";
import { Button } from "@/app/components/ui/button";
import { Switch } from "@/app/components/ui/switch";
import type { EditorDocument } from "@simforge-oss/editor";

type Role = EditorDocument["data"]["roles"][number];

/**
 * Compact sensor authoring beside the timeline.
 *
 * The inspector owns precise mount geometry; this dock keeps the clip-level
 * overview honest for every modality and provides the high-frequency
 * enable/remove actions without mislabelling LiDAR or radar as cameras.
 */
export function ActorCameras({
  document,
  role,
}: {
  document: EditorDocument;
  role: Role | null;
}) {
  return (
    <div className="w-editor-inspector shrink-0 overflow-y-auto border-l border-border bg-card p-3 text-foreground xl:w-editor-inspector-xl">
      <h2 className="flex items-center text-micro font-semibold uppercase tracking-meta-wide text-muted-foreground">
        <Gauge aria-hidden="true" className="mr-2 size-3" />
        Actor sensors
      </h2>
      {role ? (
        <>
          <div className="mt-3 flex items-center text-xs">
            <span>{sensorSummary(role.actor.sensors)}</span>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 text-primary hover:text-primary"
              onClick={() =>
                document.addActorSensor(
                  role.id,
                  defaultDashCamera(role.actor),
                )
              }
            >
              <Plus aria-hidden="true" />
              Camera
            </Button>
          </div>
          {role.actor.sensors.map((sensor) => {
            const kind = sensorKind(sensor);
            const name = sensor.label ?? kind;
            const controlName = `${name} (${sensor.id})`;
            return (
              <div
                key={sensor.id}
                className="mt-1 flex items-center gap-2 border border-border bg-muted/30 px-2 py-1.5 text-meta"
              >
                <span className="min-w-0 flex-1 truncate">
                  {name}
                  <span className="ml-2 text-micro text-muted-foreground">
                    {kind}
                  </span>
                </span>
                <Switch
                  aria-label={`${controlName} enabled in timeline`}
                  checked={sensor.enabled}
                  onCheckedChange={(enabled) =>
                    document.updateActorSensor(role.id, sensor.id, {
                      ...sensor,
                      enabled,
                      id: sensor.id,
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`Remove ${controlName} from timeline`}
                  className="editor-motion text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => document.removeActorSensor(role.id, sensor.id)}
                >
                  <Trash2 aria-hidden="true" className="size-3" />
                </button>
              </div>
            );
          })}
        </>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Select an actor to attach sensors.
        </p>
      )}
    </div>
  );
}

function sensorSummary(sensors: readonly ActorSensor[]) {
  const counts = sensors.reduce(
    (value, sensor) => {
      value[sensor.type] += 1;
      return value;
    },
    { dash_camera: 0, lidar: 0, radar: 0 },
  );
  return `${counts.dash_camera} camera · ${counts.lidar} LiDAR · ${counts.radar} radar`;
}

function sensorKind(sensor: ActorSensor) {
  if (sensor.type === "dash_camera") return "Camera";
  if (sensor.type === "lidar") return "LiDAR";
  return "Radar";
}
