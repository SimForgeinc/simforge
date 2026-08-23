"use client";

import { useRef, useState } from "react";
import { AlertCircle, Palette, Trash2, Upload } from "lucide-react";
import { Switch } from "@/app/components/ui/switch";
import { cn } from "@/app/lib/utils";
import {
  MAX_UPLOAD_BYTES,
  MAX_USER_GEOJSON_THICKNESS,
  MIN_USER_GEOJSON_THICKNESS,
  USER_GEOJSON_PALETTE,
  parseUserGeoJson,
  type UserGeoJsonLayer,
} from "@/app/lib/maps/frontend/user-geojson-layers";

/** Props for the UserGeoJsonSection component. */
export type UserGeoJsonSectionProps = {
  layers: UserGeoJsonLayer[];
  onAddLayer: (name: string, data: object, featureCount: number) => void;
  onRemoveLayer: (id: string) => void;
  onToggleLayer: (id: string) => void;
  onSetColor: (id: string, color: string) => void;
  onSetOpacity: (id: string, opacity: number) => void;
  onSetThickness: (id: string, thickness: number) => void;
};

/** Labelled range input + read-out, shared by the per-layer sliders. */
function SliderRow({
  label,
  ariaLabel,
  min,
  max,
  step,
  value,
  onChange,
  display,
}: {
  label: string;
  ariaLabel: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  display: string;
}) {
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <span className="w-14 shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-primary"
        aria-label={ariaLabel}
      />
      <span className="w-8 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
        {display}
      </span>
    </div>
  );
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Upload + manage user-provided GeoJSON overlays. Rendered at the top of the
 * Layers tab so uploaded layers sit above the built-in map layers. Parsing and
 * validation happen here; the parent hook only stores validated layers.
 */
export function UserGeoJsonSection({
  layers,
  onAddLayer,
  onRemoveLayer,
  onToggleLayer,
  onSetColor,
  onSetOpacity,
  onSetThickness,
}: UserGeoJsonSectionProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Which layer's color palette is currently expanded (null = none).
  const [openColorId, setOpenColorId] = useState<string | null>(null);

  function handleFiles(fileList: FileList | null) {
    setError(null);
    const file = fileList?.[0];
    if (!file) return;

    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `File is too large (${humanBytes(file.size)}). Maximum is ${humanBytes(MAX_UPLOAD_BYTES)}.`,
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const result = parseUserGeoJson(text);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      // Strip the extension for a cleaner label but keep it unique enough.
      const name = file.name.replace(/\.(geo)?json$/i, "") || file.name;
      onAddLayer(name, result.data, result.featureCount);
    };
    reader.onerror = () => setError("Could not read the file.");
    reader.readAsText(file);
  }

  return (
    <section data-testid="user-geojson-section">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Uploaded GeoJSON
        </span>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex items-center gap-1.5 rounded border border-border bg-muted/20 px-2 py-1 text-[11px] font-medium text-foreground/90 transition-colors hover:bg-muted/40"
          data-testid="upload-geojson-button"
        >
          <Upload className="size-3" />
          Upload GeoJSON
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".geojson,.json,application/geo+json,application/json"
          className="hidden"
          data-testid="upload-geojson-input"
          onChange={(e) => {
            handleFiles(e.target.files);
            // Reset so re-selecting the same file re-triggers onChange.
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <div
          className="mt-2 flex items-start gap-1.5 rounded border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-[11px] text-destructive"
          data-testid="upload-geojson-error"
          role="alert"
        >
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {layers.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {layers.map((layer) => {
            const paletteOpen = openColorId === layer.id;
            return (
              <li
                key={layer.id}
                className="rounded border border-border bg-muted/20 px-2.5 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setOpenColorId(paletteOpen ? null : layer.id)}
                    className="relative flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-inset ring-black/20"
                    style={{ backgroundColor: layer.color }}
                    title="Change color"
                    aria-label={`Change color for ${layer.name}`}
                  >
                    <Palette className="size-2.5 text-white/80" />
                  </button>
                  <span
                    className="min-w-0 flex-1 truncate text-xs text-foreground/90"
                    title={layer.name}
                  >
                    {layer.name}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {layer.featureCount.toLocaleString()}
                  </span>
                  <Switch
                    checked={layer.visible}
                    onCheckedChange={() => onToggleLayer(layer.id)}
                    aria-label={`Toggle ${layer.name}`}
                  />
                  <button
                    type="button"
                    onClick={() => onRemoveLayer(layer.id)}
                    className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
                    title="Remove layer"
                    aria-label={`Remove ${layer.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>

                {paletteOpen && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {USER_GEOJSON_PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => {
                          onSetColor(layer.id, c);
                          setOpenColorId(null);
                        }}
                        className={cn(
                          "size-4 rounded-full ring-1 ring-inset ring-black/20 transition-transform hover:scale-110",
                          layer.color === c && "ring-2 ring-foreground",
                        )}
                        style={{ backgroundColor: c }}
                        aria-label={`Set color ${c}`}
                        aria-pressed={layer.color === c}
                      />
                    ))}
                  </div>
                )}

                <SliderRow
                  label="Opacity"
                  ariaLabel={`Opacity for ${layer.name}`}
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={layer.opacity}
                  onChange={(v) => onSetOpacity(layer.id, v)}
                  display={`${Math.round(layer.opacity * 100)}%`}
                />
                <SliderRow
                  label="Thickness"
                  ariaLabel={`Thickness for ${layer.name}`}
                  min={MIN_USER_GEOJSON_THICKNESS}
                  max={MAX_USER_GEOJSON_THICKNESS}
                  step={0.25}
                  value={layer.thickness}
                  onChange={(v) => onSetThickness(layer.id, v)}
                  display={`${layer.thickness}×`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
