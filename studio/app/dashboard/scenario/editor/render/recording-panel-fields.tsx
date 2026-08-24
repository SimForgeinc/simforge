"use client";

import { CloudSun } from "lucide-react";
import type { ScenarioTemplateV2 } from "@simforge/scenario";
import type { AuthoredRenderSensor } from "./render-spec-v3";

/**
 * Reusable leaf controls and read-outs for render configuration surfaces.
 *
 * These stay presentation-only: renderer execution and artifact transfer belong to the registered
 * SimForge worker, never to a component using these fields.
 */

export type CameraOption = AuthoredRenderSensor & {
  sensor: Extract<AuthoredRenderSensor["sensor"], { type: "dash_camera" }>;
};

export function cameraKey(camera: AuthoredRenderSensor) {
  return `${camera.actorId}:${camera.sensor.id}`;
}

export function humanize(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function EnvironmentSummary({ content }: { content: ScenarioTemplateV2 | null }) {
  const environment = content?.environment;
  if (!environment) return null;
  return (
    <section className="mt-3 border-t render-hairline pt-3" aria-labelledby="recording-environment-heading">
      <div className="flex items-center gap-2">
        <CloudSun aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <h3 className="text-micro font-bold uppercase tracking-meta text-muted-foreground" id="recording-environment-heading">
          Environment included
        </h3>
      </div>
      <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-4">
        <SummaryValue label="Weather" value={humanize(environment.weather)} />
        <SummaryValue label="Time of day" value={humanize(environment.timeOfDay)} />
        <SummaryValue
          label="Friction"
          value={environment.frictionScale == null
            ? "Preset default"
            : typeof environment.frictionScale === "number"
              ? `${environment.frictionScale}×`
              : "Parameterized"}
        />
        <SummaryValue label="Surface patches" value={String(environment.surfacePatches.length)} />
      </dl>
      <p className="mt-1.5 text-micro text-muted-foreground">
        Weather, lighting, friction and surface configuration are frozen into the recording manifest.
      </p>
    </section>
  );
}

function SummaryValue({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-muted-foreground">{label}</dt><dd className="font-medium">{value}</dd></div>;
}

export function NumberInput({ label, value, onChange, ...input }: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <label className="space-y-1 text-xs">
      <span className="font-medium">{label}</span>
      <input {...input} className="h-9 w-full render-glass border px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onChange={(event) => onChange(event.currentTarget.valueAsNumber)} type="number" value={value} />
    </label>
  );
}

export function SelectInput({ label, value, onChange, options, disabled }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  disabled?: boolean;
}) {
  return (
    <label className="space-y-1 text-xs">
      <span className="font-medium">{label}</span>
      <select className="h-9 w-full render-glass border px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" disabled={disabled} onChange={(event) => onChange(event.currentTarget.value)} value={value}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}
