import { create } from "zustand";
import type { Sensor } from "@simforge/studio-shared";
import type { NormalizedScenarioDraft } from "@/app/lib/scenario-editor/draft-normalization";
import type { EditorActorRecord } from "@/app/lib/scenario-editor/types";
import { TRAILING_CAMERA_SENSOR } from "@/app/lib/scenario-editor/sensor-rigs";

type WorldSensorRecord = NormalizedScenarioDraft["worldSensors"][number];

interface SensorsState {
  worldSensors: WorldSensorRecord[];
  setWorldSensors: (
    sensors:
      | WorldSensorRecord[]
      | ((current: WorldSensorRecord[]) => WorldSensorRecord[]),
  ) => void;
  addWorldSensor: (sensor: WorldSensorRecord) => void;
  removeWorldSensor: (id: string) => void;
}

export const useSensorsStore = create<SensorsState>()((set) => ({
  worldSensors: [],
  setWorldSensors: (sensorsOrFn) =>
    set((state) => ({
      worldSensors:
        typeof sensorsOrFn === "function"
          ? sensorsOrFn(state.worldSensors)
          : sensorsOrFn,
    })),
  addWorldSensor: (sensor) =>
    set((state) => ({ worldSensors: [...state.worldSensors, sensor] })),
  removeWorldSensor: (id) =>
    set((state) => ({
      worldSensors: state.worldSensors.filter((s) => s.id !== id),
    })),
}));

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function actorScopedId(actorId: string, id: string) {
  return `${actorId}__${id}`;
}

function actorScopedLabel(actorLabel: string, label: string) {
  const base = nonEmpty(label) ?? "Camera";
  return base.toLowerCase().startsWith(`${actorLabel.toLowerCase()} ·`)
    ? base
    : `${actorLabel} · ${base}`;
}

function isTrailingCamera(sensor: Sensor) {
  return (
    sensor.sensorCategory === "camera" &&
    sensor.attachmentType === "spring_arm_ghost" &&
    sensor.mountRole === "preview" &&
    (sensor.mountId ?? sensor.id) === "preview_trailing"
  );
}

function actorSensorToRenderSensor(actor: EditorActorRecord, sensor: Sensor): Sensor {
  const actorId = actor.draft.id;
  const actorLabel = actor.draft.label;
  const baseMountId = nonEmpty(sensor.mountId) ?? sensor.id;
  const baseLabel = nonEmpty(sensor.mountLabel) ?? nonEmpty(sensor.label) ?? baseMountId;
  return {
    ...sensor,
    id: actorScopedId(actorId, sensor.id),
    label: actorScopedLabel(actorLabel, sensor.label),
    mountId: actorScopedId(actorId, baseMountId),
    mountLabel: actorScopedLabel(actorLabel, baseLabel),
    attachTo: actorLabel,
    sourceSensorId: sensor.sourceSensorId ?? sensor.id,
    pose: { ...sensor.pose },
    supportedOutputModalities: sensor.supportedOutputModalities
      ? [...sensor.supportedOutputModalities]
      : undefined,
  };
}

function worldSensorToRenderSensor(sensor: WorldSensorRecord): Sensor {
  const mountId = nonEmpty(sensor.mountId) ?? sensor.id;
  return {
    ...sensor,
    mountId,
    mountLabel: nonEmpty(sensor.mountLabel) ?? nonEmpty(sensor.label) ?? mountId,
    attachTo: sensor.attachTo || "world",
    pose: { ...sensor.pose },
    supportedOutputModalities: sensor.supportedOutputModalities
      ? [...sensor.supportedOutputModalities]
      : undefined,
  };
}

function actorNeedsTrailingCamera(actor: EditorActorRecord, sensors: Sensor[]) {
  if (actor.draft.kind !== "vehicle") return false;
  if (sensors.length === 0) return false;
  return !sensors.some(isTrailingCamera);
}

/** Aggregate sensors from all actors + world-placed sensors for simulation submission. */
export function buildSensorPayload({
  actors,
  worldSensors,
  includePerActorTrailingCameras = false,
}: {
  actors: EditorActorRecord[];
  worldSensors: WorldSensorRecord[];
  includePerActorTrailingCameras?: boolean;
}): Sensor[] {
  const actorSensors = actors.flatMap((actor) => {
    const authoredSensors = actor.draft.sensors ?? [];
    const sensors =
      includePerActorTrailingCameras && actorNeedsTrailingCamera(actor, authoredSensors)
        ? [...authoredSensors, TRAILING_CAMERA_SENSOR]
        : authoredSensors;
    return sensors.map((sensor) => actorSensorToRenderSensor(actor, sensor));
  });
  return [...actorSensors, ...worldSensors.map(worldSensorToRenderSensor)];
}
