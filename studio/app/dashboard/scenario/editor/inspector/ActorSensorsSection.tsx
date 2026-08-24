"use client";

import { useState } from "react";
import { Radio, SlidersHorizontal } from "lucide-react";
import {
  defaultDashCamera,
  supportsDashCamera,
} from "@simforge/scenario";
import { Switch } from "@/app/components/ui/switch";
import type { ActorRecord, EditorDocument } from "@simforge/editor";
import { SensorSetupModal } from "./SensorSetupModal";
import {
  appliedRigPreset,
  modalityLabel,
  sensorCounts,
  sensorCountSummary,
  sensorName,
} from "./sensor-presentation";
import { EDITOR_SENSOR_RIGS } from "./sensor-rig-presets";

/**
 * Sensors, as much of them as a 192px rail can honestly show.
 *
 * The rail answers "what is fitted and is it live" — a summary, the applied rig
 * name and one switch per sensor. Placing and aiming happens in
 * `SensorSetupModal`, which has room for the vehicle plan; cramming that here
 * is what made the previous version unusable.
 *
 * Sensors are read from the document's role rather than from `ActorRecord`:
 * the mount is authored data that round-trips through export, while the
 * record's copy is a render-time projection.
 */
export function ActorSensorsSection({
  actor,
  document,
}: {
  actor: ActorRecord;
  document: EditorDocument;
}) {
  const [setupOpen, setSetupOpen] = useState(false);
  const role = document.data.roles.find((candidate) => candidate.id === actor.id);
  if (!role) return null;

  const sensors = role.actor.sensors;
  const counts = sensorCounts(sensors);
  const rig = appliedRigPreset(sensors, role.actor, EDITOR_SENSOR_RIGS);
  const canMountCamera = supportsDashCamera(role.actor);

  return (
    <section aria-labelledby="scenario-sensors-heading" className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span
          className="text-[9px] uppercase tracking-[0.12em] text-white/40"
          id="scenario-sensors-heading"
        >
          Sensors
        </span>
        {counts.total > 0 ? (
          <span className="font-mono text-[9px] text-white/45">{counts.total}</span>
        ) : null}
      </div>

      {counts.total === 0 ? (
        <p className="text-[9px] leading-3 text-white/35">
          {canMountCamera
            ? "A vehicle with a camera records the scenario."
            : `A ${role.actor.class} has no camera mount, but can carry LiDAR or radar.`}
        </p>
      ) : (
        <p className="text-[9px] leading-3 text-white/45">
          {rig ? rig.name : sensorCountSummary(counts)}
          <span className="mt-0.5 block text-white/30">Records the scenario</span>
        </p>
      )}

      {sensors.map((sensor) => {
        const name = sensorName(sensor);
        return (
          <div className="flex items-center gap-1.5" key={sensor.id} data-sensor-id={sensor.id}>
            <span className="min-w-0 flex-1 truncate text-[10px] text-white/70" title={name}>
              {name}
              <span className="ml-1 text-[8px] text-white/30">{modalityLabel(sensor.type)}</span>
            </span>
            <Switch
              aria-label={`${name} (${sensor.id}) enabled`}
              checked={sensor.enabled}
              className="scale-75"
              onCheckedChange={(enabled) =>
                document.updateActorSensor(role.id, sensor.id, { ...sensor, enabled })
              }
            />
          </div>
        );
      })}

      <div className="flex gap-1.5">
        <button
          className="editor-motion flex flex-1 items-center justify-center gap-1 rounded-lg border border-white/12 bg-white/[0.035] px-2 py-1.5 text-[9px] font-semibold text-white/70 hover:border-[#E8E044]/45 hover:bg-[#E8E044]/[0.08] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
          data-testid="open-sensor-setup"
          onClick={() => setSetupOpen(true)}
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" className="size-3" />
          {counts.total === 0 ? "Add sensors" : "Configure"}
        </button>
        {counts.total === 0 && canMountCamera ? (
          <button
            aria-label="Add dash camera"
            className="editor-motion flex items-center justify-center gap-1 rounded-lg border border-[#E8E044]/35 bg-[#E8E044]/10 px-2 py-1.5 text-[9px] font-semibold text-[#E8E044] hover:bg-[#E8E044]/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E8E044]"
            onClick={() => document.addActorSensor(role.id, defaultDashCamera(role.actor))}
            type="button"
          >
            <Radio aria-hidden="true" className="size-3" />
            Camera
          </button>
        ) : null}
      </div>

      {setupOpen ? (
        <SensorSetupModal
          actor={role.actor}
          document={document}
          label={role.label ?? actor.label ?? role.id}
          onClose={() => setSetupOpen(false)}
          roleId={role.id}
        />
      ) : null}
    </section>
  );
}
