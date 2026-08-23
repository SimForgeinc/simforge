"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Plus, Radar, Scan, X } from "lucide-react";
import {
  defaultDashCamera,
  defaultLidar,
  defaultRadar,
  instantiateSensorRig,
  resolveSensorMountPreset,
  sensorAperture,
  supportsDashCamera,
  type ActiveSensorField,
  type ActorSensor,
  type ActorSpec,
  type DashCameraSensor,
  type SensorMount,
} from "@uniscenarios/scenario-model";
import type { EditorDocument } from "@uniscenarios/editor-core";
import { Input } from "@/app/components/ui/input";
import { Switch } from "@/app/components/ui/switch";
import { cn } from "@/app/lib/utils";
import { SensorCoverageDiagram } from "./SensorCoverageDiagram";
import { EDITOR_SENSOR_RIGS } from "./sensor-rig-presets";
import {
  appliedRigPreset,
  clamp,
  deg,
  DEG_TO_RAD,
  fovPresetsFor,
  matchAimPreset,
  modalityLabel,
  mountPresetFor,
  SENSOR_AIM_PRESETS,
  SENSOR_MOUNT_PRESETS,
  sensorCounts,
  sensorCountSummary,
  sensorName,
  type SensorModality,
} from "./sensor-presentation";

/**
 * The sensor workbench.
 *
 * Sensor authoring used to live in the 192px actor rail, where a nine-sensor
 * rig became nine accordions of eleven numeric fields and the "Add dash camera"
 * button was clipped mid-word. Configuration moved here, to a surface wide
 * enough to show the vehicle plan beside the controls; the rail keeps only the
 * summary and the enable switches.
 *
 * Two rules shape the interaction. Picking a rig is one click, not a dropdown
 * plus an Apply button, because it is a single undoable command. And every
 * geometric control leads with named choices — roof, windscreen, forward, wide
 * — with the raw numbers underneath for the calibration cases that need them.
 */
export function SensorSetupModal({
  actor,
  document: editorDocument,
  label,
  onClose,
  roleId,
}: {
  actor: ActorSpec;
  document: EditorDocument;
  label: string;
  onClose: () => void;
  roleId: string;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const sensors: readonly ActorSensor[] = actor.sensors;
  const counts = sensorCounts(sensors);
  const canMountCamera = supportsDashCamera(actor);
  const rig = useMemo(
    () => appliedRigPreset(sensors, actor, EDITOR_SENSOR_RIGS),
    [actor, sensors],
  );
  const selected = sensors.find((sensor) => sensor.id === selectedId) ?? null;
  const dims = actor.dims ?? { length: 4.8, width: 1.9, height: 1.5 };

  function add(modality: SensorModality) {
    setError(null);
    try {
      const sensor = modality === "dash_camera"
        ? defaultDashCamera(actor)
        : modality === "lidar"
          ? defaultLidar(actor)
          : defaultRadar(actor);
      editorDocument.addActorSensor(roleId, sensor);
      setSelectedId(sensor.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `The ${modalityLabel(modality)} could not be added.`);
    }
  }

  if (!mounted) return null;
  return createPortal(
    <div
      aria-label={`Sensors on ${label}`}
      aria-modal="true"
      className="fixed inset-0 z-[90] grid place-items-center p-4 sm:p-6"
      data-testid="sensor-setup-modal"
      role="dialog"
    >
      <button
        aria-label="Close sensor setup"
        className="absolute inset-0 cursor-default bg-background/60 backdrop-blur-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onClose}
        type="button"
      />
      <div className="relative flex max-h-[calc(100vh-48px)] w-[min(880px,calc(100vw-32px))] flex-col overflow-hidden border border-border bg-card/90 shadow-2xl backdrop-blur-xl">
        <header className="relative flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-primary/70 via-primary/15 to-transparent" />
          <div className="min-w-0">
            <p className="font-mono text-micro font-bold uppercase tracking-meta text-primary/90">Sensors</p>
            <h2 className="mt-1 text-lg font-extrabold leading-tight tracking-tight text-foreground">
              {label}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {counts.total === 0
                ? "A vehicle with sensors records the scenario. Fit a rig, or add one sensor."
                : `${sensorCountSummary(counts)}${rig ? ` · ${rig.name}` : ""} · this vehicle records the scenario`}
            </p>
          </div>
          <button
            aria-label="Close sensor setup"
            className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 gap-0 overflow-hidden md:grid-cols-[300px_minmax(0,1fr)]">
          <div className="min-h-0 space-y-4 overflow-y-auto border-b border-border p-4 md:border-b-0 md:border-r [scrollbar-width:thin]">
            <section aria-labelledby="sensor-rig-heading" className="space-y-1.5">
              <h3 className="font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground" id="sensor-rig-heading">
                Production rigs
              </h3>
              {EDITOR_SENSOR_RIGS.map((preset) => {
                const compatible = preset.compatibleActorClasses.includes(actor.class);
                const applied = rig?.id === preset.id;
                const presetCounts = sensorCounts(preset.sensors);
                return (
                  <button
                    aria-label={`Fit ${preset.name}`}
                    aria-pressed={applied}
                    className={cn(
                      "editor-motion flex w-full items-center gap-3 border px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      applied
                        ? "border-primary bg-primary/10"
                        : "border-border hover:border-primary/50 hover:bg-muted/40",
                      compatible ? "" : "cursor-not-allowed opacity-40",
                    )}
                    disabled={!compatible}
                    key={preset.id}
                    onClick={() => {
                      setError(null);
                      try {
                        editorDocument.replaceActorSensors(roleId, instantiateSensorRig(preset, actor));
                        setSelectedId(null);
                      } catch (cause) {
                        setError(cause instanceof Error ? cause.message : "The rig could not be fitted.");
                      }
                    }}
                    title={compatible ? preset.description : `Not available for a ${actor.class}`}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-foreground">{preset.name}</span>
                      <span className="block truncate text-micro text-muted-foreground">
                        {sensorCountSummary(presetCounts)}
                      </span>
                    </span>
                    {applied ? (
                      <span className="shrink-0 font-mono text-micro font-bold uppercase tracking-meta text-primary">
                        Fitted
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </section>

            <section aria-labelledby="sensor-add-heading" className="space-y-1.5">
              <h3 className="font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground" id="sensor-add-heading">
                Add one sensor
              </h3>
              <div className="grid grid-cols-3 gap-1.5">
                <AddButton
                  disabled={!canMountCamera}
                  icon={Camera}
                  label="Camera"
                  onClick={() => add("dash_camera")}
                  title={canMountCamera ? "Add a dash camera" : `A ${actor.class} has no camera mount`}
                />
                <AddButton icon={Scan} label="LiDAR" onClick={() => add("lidar")} title="Add a roof LiDAR" />
                <AddButton icon={Radar} label="Radar" onClick={() => add("radar")} title="Add a bumper radar" />
              </div>
              {error ? (
                <p className="text-micro text-destructive" role="alert">{error}</p>
              ) : null}
            </section>

            <section aria-labelledby="sensor-list-heading" className="space-y-1.5">
              <h3 className="font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground" id="sensor-list-heading">
                Fitted{counts.total ? ` · ${counts.total}` : ""}
              </h3>
              {sensors.length === 0 ? (
                <p className="text-xs text-muted-foreground">Nothing fitted yet.</p>
              ) : (
                sensors.map((sensor) => (
                  <SensorListRow
                    key={sensor.id}
                    document={editorDocument}
                    onSelect={() => setSelectedId(sensor.id)}
                    roleId={roleId}
                    selected={sensor.id === selectedId}
                    sensor={sensor}
                  />
                ))
              )}
            </section>
          </div>

          <div className="flex min-h-0 flex-col overflow-y-auto p-4 [scrollbar-width:thin]">
            <div className="grid h-[240px] shrink-0 place-items-center border border-border bg-muted/20 p-2">
              {sensors.length === 0 ? (
                <p className="max-w-[24ch] text-center text-xs text-muted-foreground">
                  Coverage appears here once this vehicle carries a sensor.
                </p>
              ) : (
                <SensorCoverageDiagram
                  dims={dims}
                  onSelect={setSelectedId}
                  selectedId={selectedId}
                  sensors={sensors}
                />
              )}
            </div>

            {selected ? (
              <SensorEditor
                actor={actor}
                document={editorDocument}
                key={selected.id}
                roleId={roleId}
                sensor={selected}
              />
            ) : sensors.length > 0 ? (
              <p className="mt-4 text-xs text-muted-foreground">
                Select a sensor — in the list or on the plan — to place and aim it.
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    window.document.body,
  );
}

function AddButton({
  disabled,
  icon: Icon,
  label,
  onClick,
  title,
}: {
  disabled?: boolean;
  icon: typeof Camera;
  label: string;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      aria-label={`Add ${label}`}
      className="editor-motion flex flex-col items-center gap-1 border border-border px-2 py-2 text-micro font-semibold text-foreground hover:border-primary/50 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-35"
      disabled={disabled}
      onClick={onClick}
      title={title}
      type="button"
    >
      <span className="relative">
        <Icon aria-hidden="true" className="size-4" />
        <Plus aria-hidden="true" className="absolute -right-1.5 -top-1 size-2.5 text-primary" />
      </span>
      {label}
    </button>
  );
}

function SensorListRow({
  document: editorDocument,
  onSelect,
  roleId,
  selected,
  sensor,
}: {
  document: EditorDocument;
  onSelect: () => void;
  roleId: string;
  selected: boolean;
  sensor: ActorSensor;
}) {
  const aperture = sensorAperture(sensor);
  const name = sensorName(sensor);
  return (
    <div
      className={cn(
        "flex items-center gap-2 border px-2 py-1.5",
        selected ? "border-primary bg-primary/10" : "border-border",
      )}
      data-sensor-id={sensor.id}
    >
      <button
        aria-label={`Configure ${name}`}
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onSelect}
        type="button"
      >
        <span className="block truncate text-xs text-foreground">{name}</span>
        <span className="block truncate font-mono text-micro text-muted-foreground">
          {modalityLabel(sensor.type)} · {Math.round(aperture.horizontalFovDeg)}° · {Math.round(aperture.farM)} m
        </span>
      </button>
      <Switch
        aria-label={`${name} (${sensor.id}) enabled`}
        checked={sensor.enabled}
        onCheckedChange={(enabled) => replaceSensor(editorDocument, roleId, sensor, { enabled })}
      />
      <button
        aria-label={`Remove ${name} (${sensor.id})`}
        className="editor-motion text-muted-foreground hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => editorDocument.removeActorSensor(roleId, sensor.id)}
        title={`Remove ${name}`}
        type="button"
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  );
}

function SensorEditor({
  actor,
  document: editorDocument,
  roleId,
  sensor,
}: {
  actor: ActorSpec;
  document: EditorDocument;
  roleId: string;
  sensor: ActorSensor;
}) {
  const [showNumbers, setShowNumbers] = useState(false);
  const aperture = sensorAperture(sensor);
  const mountPreset = mountPresetFor(sensor, actor);
  const aimPreset = matchAimPreset(sensor.mount.rotation.yawRad);
  const name = sensorName(sensor);

  return (
    <div className="mt-4 space-y-4">
      <label className="block">
        <span className="font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground">Name</span>
        <Input
          aria-label={`Name for ${modalityLabel(sensor.type)} ${sensor.id}`}
          className="mt-1 h-8 text-xs"
          onChange={(event) => {
            const label = event.target.value.trim();
            replaceSensor(editorDocument, roleId, sensor, { label: label === "" ? undefined : label.slice(0, 200) });
          }}
          placeholder={modalityLabel(sensor.type)}
          value={sensor.label ?? ""}
        />
      </label>

      <ChipGroup
        active={mountPreset?.id}
        label="Position"
        note={mountPreset ? undefined : "Custom"}
        onSelect={(id) => {
          const preset = SENSOR_MOUNT_PRESETS.find((candidate) => candidate.id === id);
          if (!preset) return;
          const resolved = resolveSensorMountPreset(preset, actor);
          // A named position moves the sensor without re-aiming it: the author
          // set the aim separately and moving a camera to the roof must not
          // silently point it forward again.
          replaceSensor(editorDocument, roleId, sensor, {
            mount: { position: resolved.position, rotation: sensor.mount.rotation },
          });
        }}
        options={SENSOR_MOUNT_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }))}
      />

      <ChipGroup
        active={aimPreset?.id}
        label="Aim"
        note={aimPreset ? undefined : `${deg(sensor.mount.rotation.yawRad)}°`}
        onSelect={(id) => {
          const preset = SENSOR_AIM_PRESETS.find((candidate) => candidate.id === id);
          if (!preset) return;
          replaceSensor(editorDocument, roleId, sensor, {
            mount: {
              position: sensor.mount.position,
              rotation: { ...sensor.mount.rotation, yawRad: preset.yawDeg * DEG_TO_RAD },
            },
          });
        }}
        options={SENSOR_AIM_PRESETS.map((preset) => ({ id: preset.id, label: preset.label }))}
      />

      <ChipGroup
        active={fovPresetsFor(sensor.type).find(
          (preset) => Math.abs(preset.horizontalFovDeg - aperture.horizontalFovDeg) < 0.5,
        )?.label}
        label="Field of view"
        note={`${Math.round(aperture.horizontalFovDeg)}° wide · ${Math.round(aperture.verticalFovDeg)}° tall`}
        onSelect={(id) => {
          const preset = fovPresetsFor(sensor.type).find((candidate) => candidate.label === id);
          if (!preset) return;
          replaceAperture(editorDocument, roleId, sensor, { horizontalFovDeg: preset.horizontalFovDeg });
        }}
        options={fovPresetsFor(sensor.type).map((preset) => ({ id: preset.label, label: preset.label }))}
      />

      <div>
        <span className="font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground">Range</span>
        <div className="mt-1 grid grid-cols-2 gap-2">
          <NumberBox
            label={`Near range in metres for ${name}`}
            min={0}
            onChange={(nearM) => replaceAperture(editorDocument, roleId, sensor, { nearM })}
            step={0.1}
            suffix="m near"
            value={aperture.nearM}
          />
          <NumberBox
            label={`Far range in metres for ${name}`}
            min={0}
            onChange={(farM) => replaceAperture(editorDocument, roleId, sensor, { farM })}
            step={5}
            suffix="m far"
            value={aperture.farM}
          />
        </div>
      </div>

      <div className="border-t border-border pt-3">
        <button
          aria-expanded={showNumbers}
          className="editor-motion font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setShowNumbers((open) => !open)}
          type="button"
        >
          {showNumbers ? "Hide exact mount" : "Exact mount"}
        </button>
        {showNumbers ? (
          <div className="mt-2 space-y-2">
            <p className="text-micro text-muted-foreground">
              Actor-local metres: +X forward, +Y up, +Z left.
            </p>
            <div className="grid grid-cols-3 gap-2">
              {(["x", "y", "z"] as const).map((axis) => (
                <NumberBox
                  key={axis}
                  label={`${axis.toUpperCase()} offset in metres for ${name}`}
                  onChange={(value) =>
                    replaceSensor(editorDocument, roleId, sensor, {
                      mount: {
                        position: { ...sensor.mount.position, [axis]: value },
                        rotation: sensor.mount.rotation,
                      },
                    })
                  }
                  step={0.05}
                  suffix={`${axis} m`}
                  value={sensor.mount.position[axis]}
                />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(["yawRad", "pitchRad", "rollRad"] as const).map((axis) => {
                const limit = axis === "pitchRad" ? 90 : 180;
                const short = axis.slice(0, -3);
                return (
                  <NumberBox
                    key={axis}
                    label={`${short} in degrees for ${name}`}
                    onChange={(value) =>
                      replaceSensor(editorDocument, roleId, sensor, {
                        mount: {
                          position: sensor.mount.position,
                          rotation: {
                            ...sensor.mount.rotation,
                            [axis]: clamp(value, -limit, limit) * DEG_TO_RAD,
                          },
                        },
                      })
                    }
                    step={1}
                    suffix={`${short} °`}
                    value={deg(sensor.mount.rotation[axis])}
                  />
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChipGroup({
  active,
  label,
  note,
  onSelect,
  options,
}: {
  active: string | undefined;
  label: string;
  note?: string;
  onSelect: (id: string) => void;
  options: readonly { id: string; label: string }[];
}) {
  return (
    <div>
      <span className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-micro font-bold uppercase tracking-meta text-muted-foreground">{label}</span>
        {note ? <span className="font-mono text-micro text-muted-foreground">{note}</span> : null}
      </span>
      <div aria-label={label} className="mt-1 flex flex-wrap gap-1" role="group">
        {options.map((option) => {
          const selected = option.id === active;
          return (
            <button
              aria-pressed={selected}
              className={cn(
                "editor-motion border px-2 py-1 text-micro focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-primary bg-primary/15 text-primary"
                  : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground",
              )}
              key={option.id}
              onClick={() => onSelect(option.id)}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NumberBox({
  label,
  min,
  onChange,
  step,
  suffix,
  value,
}: {
  label: string;
  min?: number;
  onChange: (value: number) => void;
  step: number;
  suffix: string;
  value: number;
}) {
  return (
    <label className="block">
      <span className="sr-only">{label}</span>
      <span className="relative block">
        <Input
          aria-label={label}
          className="h-8 pr-12 text-xs"
          min={min}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          step={step}
          type="number"
          value={Math.round(value * 1000) / 1000}
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 font-mono text-micro text-muted-foreground">
          {suffix}
        </span>
      </span>
    </label>
  );
}

/**
 * Aperture edits are clamped to the modality's own schema bounds, because the
 * document parses on save and a rejected sensor would lose the whole edit.
 */
function replaceAperture(
  editorDocument: EditorDocument,
  roleId: string,
  sensor: ActorSensor,
  patch: Partial<ActiveSensorField>,
) {
  const current = sensorAperture(sensor);
  const camera = sensor.type === "dash_camera";
  const horizontalFovDeg = clamp(
    patch.horizontalFovDeg ?? current.horizontalFovDeg,
    camera ? 10 : 5,
    camera ? 170 : 360,
  );
  const verticalFovDeg = clamp(
    patch.verticalFovDeg ?? current.verticalFovDeg,
    camera ? 5 : 2,
    camera ? 170 : 180,
  );
  const nearM = clamp(patch.nearM ?? current.nearM, 0.001, Math.min(10, current.farM - 0.001));
  const farM = clamp(Math.max(patch.farM ?? current.farM, nearM + 0.001), nearM + 0.001, 100_000);
  const aperture = { horizontalFovDeg, verticalFovDeg, nearM, farM };

  if (sensor.type === "dash_camera") {
    replaceSensor(editorDocument, roleId, sensor, { camera: { ...sensor.camera, ...aperture } });
    return;
  }
  replaceSensor(editorDocument, roleId, sensor, { field: { ...sensor.field, ...aperture } });
}

function replaceSensor(
  editorDocument: EditorDocument,
  roleId: string,
  sensor: ActorSensor,
  patch: {
    enabled?: boolean;
    label?: string | undefined;
    mount?: SensorMount;
    camera?: DashCameraSensor["camera"];
    field?: ActiveSensorField;
  },
) {
  editorDocument.updateActorSensor(roleId, sensor.id, {
    ...sensor,
    ...patch,
    id: sensor.id,
  } as ActorSensor);
}
