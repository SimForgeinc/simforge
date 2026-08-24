"use client";

import { Camera, Radar } from "lucide-react";
import type { RenderModality } from "@simforge/scenario";
import { cn } from "@/app/lib/utils";
import { humanize } from "./recording-panel-fields";
import { RenderWizardBody, RenderWizardFooter } from "./RenderWizardChrome";
import {
  defaultModalities,
  RENDER_MODALITY_ORDER,
  renderModalityLabel,
  sensorKey,
  supportedModalities,
  type AuthoredRenderSensor,
} from "./render-spec-v3";

/**
 * The browser lane's sensor step: one row per sensor, one column per pass.
 *
 * Every enabled sensor is captured, so this step is not a selection — it is where the author says
 * which camera the *video* comes from, and trims the passes each sensor writes. The point of view is
 * exclusive and the passes are not, so the sensor name is a radio and the cells are checkboxes.
 *
 * A grid rather than a card per sensor. One car carrying a full rig is the normal case, not the
 * exception, and as cards that read as a dozen separate panels each repeating the same actor name,
 * with the passes wrapping differently in every one. Lined up in columns the same pass is in the
 * same place on every row, the actor is named once per group, and the header cell toggles a whole
 * column — so "capture depth on everything" is one click instead of one per sensor.
 */
export function BrowserCameraStep({
  busy,
  modalitiesBySensor,
  onBack,
  onNext,
  onSelectPov,
  onToggleModality,
  povKey,
  povLabel,
  sensors,
  staticSemantics,
}: {
  busy: boolean;
  modalitiesBySensor: Record<string, readonly RenderModality[]>;
  onBack?: () => void;
  onNext?: () => void;
  onSelectPov: (key: string) => void;
  onToggleModality: (option: AuthoredRenderSensor, modality: RenderModality) => void;
  /** Key of the camera the video is taken from, or null when none is usable. */
  povKey: string | null;
  povLabel: string;
  sensors: readonly AuthoredRenderSensor[];
  staticSemantics: boolean;
}) {
  const hasCamera = sensors.some((option) => option.sensor.type === "dash_camera");
  const modalitiesOf = (option: AuthoredRenderSensor) =>
    modalitiesBySensor[sensorKey(option.actorId, option.sensor.id)] ?? defaultModalities(option.sensor);
  const unavailable = (modality: RenderModality) => modality === "semantic" && !staticSemantics;

  // Only the passes some visible sensor can actually write. A radar-only scenario has no business
  // showing four camera columns, and the widths come out of however many survive.
  const columns = RENDER_MODALITY_ORDER.filter((modality) =>
    sensors.some((option) => supportedModalities(option.sensor).includes(modality)));

  // Actors in first-appearance order, each keeping its sensors in authored order.
  const groups: { actorId: string; actorLabel: string; sensors: AuthoredRenderSensor[] }[] = [];
  for (const option of sensors) {
    const group = groups.find((candidate) => candidate.actorId === option.actorId);
    if (group) group.sensors.push(option);
    else groups.push({ actorId: option.actorId, actorLabel: option.actorLabel, sensors: [option] });
  }

  const columnState = (modality: RenderModality) => {
    const applicable = sensors.filter((option) => supportedModalities(option.sensor).includes(modality));
    const on = applicable.filter((option) => modalitiesOf(option).includes(modality));
    return { applicable, all: applicable.length > 0 && on.length === applicable.length, some: on.length > 0 };
  };

  const toggleColumn = (modality: RenderModality) => {
    const { applicable, all } = columnState(modality);
    // Turning a full column off, or filling the rest in — the same intent either way.
    for (const option of applicable) {
      if (modalitiesOf(option).includes(modality) === all) onToggleModality(option, modality);
    }
  };

  const selectedCount = sensors.reduce((total, option) => total + modalitiesOf(option).length, 0);

  return (
    <>
      <RenderWizardBody testId="recording-step-cameras">
        <div className="mb-3 flex shrink-0 items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-bold tracking-tight text-foreground" id="recording-camera-heading">
              Which camera is the video?
            </h3>
            <p className="mt-0.5 text-micro text-muted-foreground">
              Every enabled sensor is captured. The one you pick here is also the video&apos;s point of view.
            </p>
          </div>
          <span className="shrink-0 text-micro uppercase tracking-meta text-muted-foreground">
            {sensors.length} {sensors.length === 1 ? "sensor" : "sensors"} · {selectedCount}{" "}
            {selectedCount === 1 ? "pass" : "passes"}
          </span>
        </div>
        {hasCamera ? null : (
          <p className="border border-dashed render-hairline px-3 py-2 text-xs text-muted-foreground">
            No enabled dash cameras. Select a vehicle in the editor and add one in Sensors.
          </p>
        )}
        {sensors.length > 0 ? (
          <div
            aria-labelledby="recording-camera-heading"
            className="min-w-0 overflow-x-auto border render-hairline"
            data-testid="recording-sensor-matrix"
          >
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b render-hairline">
                  <th className="px-3 py-1.5 text-micro font-bold uppercase tracking-meta text-muted-foreground" scope="col">
                    Sensor
                  </th>
                  {columns.map((modality) => {
                    const { all, some } = columnState(modality);
                    return (
                      <th className="w-16 px-1 py-1 text-center" key={modality} scope="col">
                        <button
                          aria-label={`${all ? "Clear" : "Capture"} ${renderModalityLabel(modality)} on every sensor`}
                          aria-pressed={all}
                          className={cn(
                            "editor-motion w-full px-1 py-0.5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            all
                              ? "text-primary"
                              : some
                                ? "text-foreground"
                                : "text-muted-foreground hover:text-foreground",
                          )}
                          data-testid={`sensor-modality-column-${modality}`}
                          disabled={busy || unavailable(modality)}
                          onClick={() => toggleColumn(modality)}
                          title={unavailable(modality)
                            ? "This map version does not advertise map.static_semantics."
                            : `${all ? "Clear" : "Capture"} this pass on every sensor that supports it`}
                          type="button"
                        >
                          {renderModalityLabel(modality)}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              {groups.map((group) => (
                <tbody className="border-b render-hairline last:border-b-0" key={group.actorId}>
                  {groups.length > 1 ? (
                    <tr>
                      <th
                        className="px-3 pt-2 text-micro font-bold uppercase tracking-meta text-muted-foreground"
                        colSpan={columns.length + 1}
                        scope="colgroup"
                      >
                        {group.actorLabel}
                      </th>
                    </tr>
                  ) : null}
                  {group.sensors.map((option) => {
                    const key = sensorKey(option.actorId, option.sensor.id);
                    const isCamera = option.sensor.type === "dash_camera";
                    const isPov = key === povKey;
                    const selectedModalities = modalitiesOf(option);
                    const supported = supportedModalities(option.sensor);
                    return (
                      <tr
                        className={cn("border-t render-hairline first:border-t-0", isPov ? "bg-primary/10" : null)}
                        data-pov={isPov}
                        data-testid={`recording-sensor-card-${key}`}
                        key={key}
                      >
                        <th className="min-w-0 px-3 py-1" scope="row">
                          <button
                            aria-checked={isPov}
                            className="editor-motion flex w-full min-w-0 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={busy || !isCamera}
                            onClick={() => onSelectPov(key)}
                            role="radio"
                            title={isCamera
                              ? "Use this camera for the video"
                              : "LiDAR and radar have no video point of view"}
                            type="button"
                          >
                            {isCamera ? (
                              <Camera
                                aria-hidden="true"
                                className={cn("size-3.5 shrink-0", isPov ? "text-primary" : "text-muted-foreground")}
                              />
                            ) : (
                              <Radar aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                              {option.sensor.label ?? option.sensor.id}
                            </span>
                            <span className="shrink-0 text-micro uppercase tracking-meta text-muted-foreground">
                              {humanize(option.sensor.type)}
                            </span>
                            {isPov ? (
                              <span className="shrink-0 bg-primary px-1.5 py-0.5 text-micro font-bold uppercase tracking-meta text-primary-foreground">
                                Video
                              </span>
                            ) : null}
                          </button>
                        </th>
                        {columns.map((modality) => {
                          if (!supported.includes(modality)) {
                            return (
                              <td className="px-1 py-1 text-center text-micro text-muted-foreground/40" key={modality}>
                                <span aria-hidden="true">·</span>
                                <span className="sr-only">
                                  {humanize(option.sensor.type)} cannot write {renderModalityLabel(modality)}
                                </span>
                              </td>
                            );
                          }
                          return (
                            <td className="px-1 py-1 text-center" key={modality}>
                              <input
                                aria-label={`Capture ${renderModalityLabel(modality)} from ${option.sensor.label ?? option.sensor.id}`}
                                checked={selectedModalities.includes(modality)}
                                className="size-3 accent-primary"
                                data-testid={`sensor-modality-${key}-${modality}`}
                                disabled={busy || unavailable(modality)}
                                onChange={() => onToggleModality(option, modality)}
                                title={unavailable(modality)
                                  ? "This map version does not advertise map.static_semantics."
                                  : undefined}
                                type="checkbox"
                              />
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              ))}
            </table>
          </div>
        ) : null}
        {columns.some(unavailable) ? (
          // Once, under the grid. The old cards repeated this beside every camera, which is both
          // louder and less useful: the reason is a property of the map, not of any one sensor.
          <p className="mt-1.5 text-micro text-muted-foreground">
            Semantic passes are unavailable: this map version does not advertise
            {" "}
            <span className="font-mono">map.static_semantics</span>.
          </p>
        ) : null}
      </RenderWizardBody>
      <RenderWizardFooter
        note={`Video from ${povLabel}`}
        nextDisabled={povKey == null}
        onBack={onBack}
        onNext={onNext}
      />
    </>
  );
}
