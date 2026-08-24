'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ViewerAccordionSection } from './ViewerAccordion';
import {
  exportConfigJSON,
  flushVisualConfig,
  importConfigJSON,
  loadVisualConfig,
  resetVisualConfig,
  saveVisualConfig,
  subscribeVisualConfig,
  type LayerKind,
  type LayerMultipliers,
  type ToneMappingAlgorithm,
  type VegetationLayerMultipliers,
  type VisualConfig,
} from './visual-config';
import { clearMapAssetCache } from '@/app/lib/maps/frontend/map-asset-cache';

// Dev-only visual-config HUD. Imported by `CityViewer.tsx` only on dev/staging
// builds; the dynamic-import wrapper there tree-shakes this file out of
// production bundles entirely. Rendered as a section inside the viewer's
// right-side accordion shell (ABH-65) rather than as a floating draggable
// overlay.

type TabId = 'central' | 'asset' | 'road' | 'vegetation';

const TABS: { id: TabId; label: string }[] = [
  { id: 'central', label: 'Central' },
  { id: 'asset', label: 'Asset' },
  { id: 'road', label: 'Road' },
  { id: 'vegetation', label: 'Vegetation' },
];

interface VisualConfigHudProps {
  /**
   * Triggers a one-shot shadow rebake. Wired to sun-direction and
   * shadow-bias slider `onMouseUp` so dragging stays smooth (autoUpdate=false)
   * and the shadow updates once the user commits.
   */
  onSunCommit?: () => void;
}

function rgbToHex({ r, g, b }: { r: number; g: number; b: number }): string {
  const toByte = (v: number): string =>
    Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.replace('#', '');
  return {
    r: parseInt(m.slice(0, 2), 16) / 255,
    g: parseInt(m.slice(2, 4), 16) / 255,
    b: parseInt(m.slice(4, 6), 16) / 255,
  };
}

function formatSliderValue(value: number, step: number): string {
  if (step >= 1) return value.toFixed(0);
  if (step >= 0.1) return value.toFixed(1);
  if (step >= 0.01) return value.toFixed(2);
  if (step >= 0.001) return value.toFixed(3);
  return value.toFixed(4);
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
  unit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  onCommit?: () => void;
  unit?: string;
}) {
  return (
    <label className="flex items-center gap-2 py-0.5">
      <span className="w-20 shrink-0 truncate text-[10px]">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={onCommit}
        onTouchEnd={onCommit}
        className="flex-1 h-1 rounded-full appearance-none cursor-pointer bg-border accent-primary"
      />
      <span className="w-12 shrink-0 text-right text-[10px] tabular-nums">
        {formatSliderValue(value, step)}
        {unit ?? ''}
      </span>
    </label>
  );
}

function ColorRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { r: number; g: number; b: number };
  onChange: (c: { r: number; g: number; b: number }) => void;
}) {
  return (
    <label className="flex items-center gap-2 py-0.5">
      <span className="w-20 shrink-0 truncate text-[10px]">{label}</span>
      <input
        type="color"
        value={rgbToHex(value)}
        onChange={(e) => onChange(hexToRgb(e.target.value))}
        className="h-5 w-12 cursor-pointer rounded border border-border bg-transparent p-0"
      />
      <span className="flex-1 text-[10px] tabular-nums opacity-60">
        {rgbToHex(value)}
      </span>
    </label>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground/80">
        {label}
      </div>
      {children}
    </div>
  );
}

function ReloadPill() {
  return (
    <span
      className="ml-1 rounded-sm bg-amber-500/20 px-1 py-px text-[8px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400"
      title="Reload required to apply"
    >
      reload
    </span>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 py-0.5">
      <span className="w-20 shrink-0 truncate text-[10px]">
        {label}
        <ReloadPill />
      </span>
      <input
        type="checkbox"
        checked={value}
        onChange={(e) => onChange(e.target.checked)}
        className="h-3 w-3 cursor-pointer accent-primary"
      />
      <span className="flex-1 text-[10px] tabular-nums opacity-60">
        {value ? 'on' : 'off'}
      </span>
    </label>
  );
}

function SelectRow<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <label className="flex items-center gap-2 py-0.5">
      <span className="w-20 shrink-0 truncate text-[10px]">
        {label}
        <ReloadPill />
      </span>
      <select
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const opt = options.find((o) => String(o.value) === raw);
          if (opt) onChange(opt.value);
        }}
        className="h-5 flex-1 rounded border border-border bg-transparent px-1 text-[10px]"
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ApplyReloadButton({ disabled }: { disabled: boolean }) {
  return (
    <div className="mt-2 border-t border-border/50 pt-2">
      <button
        type="button"
        disabled={disabled}
        onClick={async (e) => {
          e.stopPropagation();
          if (disabled) return;
          flushVisualConfig();
          // Ops tweaked the 3D config — flush the cached road GLB so the
          // reload refetches the model instead of serving stale bytes.
          // Awaited so the delete completes before the page reloads.
          await clearMapAssetCache();
          if (typeof window !== 'undefined') window.location.reload();
        }}
        data-testid="vc-apply-reload"
        className="w-full rounded bg-amber-500/20 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-amber-600 transition-colors hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground dark:text-amber-400"
        title={
          disabled
            ? 'No reload-knob changes vs the renderer boot snapshot'
            : 'Persist working draft and reload the page'
        }
      >
        Apply (reload)
      </button>
    </div>
  );
}

const TONE_MAPPING_OPTIONS: readonly { value: ToneMappingAlgorithm; label: string }[] = [
  { value: 'ACES', label: 'ACES' },
  { value: 'Linear', label: 'Linear' },
  { value: 'Reinhard', label: 'Reinhard' },
  { value: 'Cineon', label: 'Cineon' },
];

const GTAO_SAMPLE_OPTIONS = [
  { value: 4, label: '4' },
  { value: 8, label: '8' },
  { value: 16, label: '16' },
  { value: 32, label: '32' },
] as const;

const SHADOW_RES_OPTIONS = [
  { value: 512, label: '512' },
  { value: 1024, label: '1024' },
  { value: 2048, label: '2048' },
  { value: 4096, label: '4096' },
] as const;

/** Fields that are RELOAD-gated on the Central tab. Used by the dirty-vs-boot diff. */
const CENTRAL_RELOAD_KEYS = [
  'toneMappingAlgorithm',
  'fogEnabled',
  'postProcessingEnabled',
  'gtaoSamples',
  'smaaEnabled',
  'shadowsEnabled',
  'shadowResolution',
] as const;

function centralDiffersFromBoot(
  current: VisualConfig['central'],
  boot: VisualConfig['central'],
): boolean {
  for (const k of CENTRAL_RELOAD_KEYS) {
    if (current[k] !== boot[k]) return true;
  }
  return false;
}

function layerFlagsDifferFromBoot(
  current: LayerMultipliers,
  boot: LayerMultipliers,
): boolean {
  return current.forceFlatShading !== boot.forceFlatShading;
}

function vegetationFlagsDifferFromBoot(
  current: VegetationLayerMultipliers,
  boot: VegetationLayerMultipliers,
): boolean {
  return (
    current.forceFlatShading !== boot.forceFlatShading ||
    current.castShadows !== boot.castShadows
  );
}

function CentralTab({
  config,
  bootCentral,
  onSunCommit,
}: {
  config: VisualConfig;
  bootCentral: VisualConfig['central'];
  onSunCommit?: () => void;
}) {
  const c = config.central;
  // Patch helper: every saveVisualConfig call here mutates the in-memory state
  // synchronously and notifies CityViewerCore's subscriber, which coalesces
  // into one rAF tick before applyLiveConfig fires — so multi-field updates
  // (e.g. an import or reset) don't thrash the renderer.
  const patchCentral = (patch: Partial<typeof c>) =>
    saveVisualConfig({ central: patch });
  const reloadDirty = centralDiffersFromBoot(c, bootCentral);

  return (
    <div className="space-y-2.5">
      <Section label="Sun">
        <Slider
          label="Azimuth"
          value={c.sunAzimuthDeg}
          min={0}
          max={360}
          step={0.1}
          onChange={(v) => patchCentral({ sunAzimuthDeg: v })}
          onCommit={onSunCommit}
          unit="°"
        />
        <Slider
          label="Elevation"
          value={c.sunElevationDeg}
          min={0}
          max={90}
          step={0.1}
          onChange={(v) => patchCentral({ sunElevationDeg: v })}
          onCommit={onSunCommit}
          unit="°"
        />
        <ColorRow
          label="Color"
          value={c.sunColor}
          onChange={(rgb) => patchCentral({ sunColor: rgb })}
        />
        <Slider
          label="Intensity"
          value={c.sunIntensity}
          min={0}
          max={5}
          step={0.05}
          onChange={(v) => patchCentral({ sunIntensity: v })}
        />
      </Section>

      <Section label="Ambient & hemi">
        <Slider
          label="Ambient int."
          value={c.ambientIntensity}
          min={0}
          max={5}
          step={0.05}
          onChange={(v) => patchCentral({ ambientIntensity: v })}
        />
        <ColorRow
          label="Hemi sky"
          value={c.hemiSkyColor}
          onChange={(rgb) => patchCentral({ hemiSkyColor: rgb })}
        />
        <ColorRow
          label="Hemi ground"
          value={c.hemiGroundColor}
          onChange={(rgb) => patchCentral({ hemiGroundColor: rgb })}
        />
        <Slider
          label="Hemi int."
          value={c.hemiIntensity}
          min={0}
          max={5}
          step={0.05}
          onChange={(v) => patchCentral({ hemiIntensity: v })}
        />
      </Section>

      <Section label="Tone-mapping">
        <SelectRow
          label="Algorithm"
          value={c.toneMappingAlgorithm}
          options={TONE_MAPPING_OPTIONS}
          onChange={(toneMappingAlgorithm) => patchCentral({ toneMappingAlgorithm })}
        />
        <Slider
          label="Exposure"
          value={c.toneMappingExposure}
          min={0}
          max={3}
          step={0.01}
          onChange={(v) => patchCentral({ toneMappingExposure: v })}
        />
      </Section>

      <Section label="Fog">
        <ToggleRow
          label="Enabled"
          value={c.fogEnabled}
          onChange={(fogEnabled) => patchCentral({ fogEnabled })}
        />
        <ColorRow
          label="Color"
          value={c.fogColor}
          onChange={(rgb) => patchCentral({ fogColor: rgb })}
        />
        <Slider
          label="Density"
          value={c.fogDensity}
          min={0}
          max={0.01}
          step={0.0001}
          onChange={(v) => patchCentral({ fogDensity: v })}
        />
      </Section>

      <Section label="Environment">
        <Slider
          label="Intensity"
          value={c.environmentIntensity}
          min={0}
          max={3}
          step={0.01}
          onChange={(v) => patchCentral({ environmentIntensity: v })}
        />
        <Slider
          label="Bg blur"
          value={c.backgroundBlurriness}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => patchCentral({ backgroundBlurriness: v })}
        />
      </Section>

      <Section label="Post-process">
        <ToggleRow
          label="Enabled"
          value={c.postProcessingEnabled}
          onChange={(postProcessingEnabled) => patchCentral({ postProcessingEnabled })}
        />
        <SelectRow
          label="GTAO samples"
          value={c.gtaoSamples}
          options={GTAO_SAMPLE_OPTIONS}
          onChange={(gtaoSamples) => patchCentral({ gtaoSamples })}
        />
        <ToggleRow
          label="SMAA"
          value={c.smaaEnabled}
          onChange={(smaaEnabled) => patchCentral({ smaaEnabled })}
        />
        <Slider
          label="GTAO radius"
          value={c.gtaoRadius}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => patchCentral({ gtaoRadius: v })}
        />
        <Slider
          label="GTAO dist exp"
          value={c.gtaoDistanceExponent}
          min={0}
          max={5}
          step={0.05}
          onChange={(v) => patchCentral({ gtaoDistanceExponent: v })}
        />
        <Slider
          label="Den. lumaPhi"
          value={c.denoiseLumaPhi}
          min={0}
          max={20}
          step={0.1}
          onChange={(v) => patchCentral({ denoiseLumaPhi: v })}
        />
        <Slider
          label="Den. depthPhi"
          value={c.denoiseDepthPhi}
          min={0}
          max={20}
          step={0.1}
          onChange={(v) => patchCentral({ denoiseDepthPhi: v })}
        />
        <Slider
          label="Den. normalPhi"
          value={c.denoiseNormalPhi}
          min={0}
          max={20}
          step={0.1}
          onChange={(v) => patchCentral({ denoiseNormalPhi: v })}
        />
        <Slider
          label="Den. radius"
          value={c.denoiseRadius}
          min={0}
          max={10}
          step={0.1}
          onChange={(v) => patchCentral({ denoiseRadius: v })}
        />
      </Section>

      <Section label="Shadows">
        <ToggleRow
          label="Enabled"
          value={c.shadowsEnabled}
          onChange={(shadowsEnabled) => patchCentral({ shadowsEnabled })}
        />
        <SelectRow
          label="Resolution"
          value={c.shadowResolution}
          options={SHADOW_RES_OPTIONS}
          onChange={(shadowResolution) => patchCentral({ shadowResolution })}
        />
        <Slider
          label="Bias"
          value={c.shadowBias}
          min={-0.01}
          max={0.01}
          step={0.0001}
          onChange={(v) => patchCentral({ shadowBias: v })}
          onCommit={onSunCommit}
        />
        <Slider
          label="Normal bias"
          value={c.shadowNormalBias}
          min={0}
          max={0.1}
          step={0.001}
          onChange={(v) => patchCentral({ shadowNormalBias: v })}
          onCommit={onSunCommit}
        />
      </Section>

      <ApplyReloadButton disabled={!reloadDirty} />
    </div>
  );
}

function downloadConfigJson(json: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  a.download = `visual-config-${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function TintRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { r: number; g: number; b: number };
  onChange: (next: { r: number; g: number; b: number }) => void;
}) {
  return (
    <div className="py-0.5">
      <div className="text-[10px] mb-0.5">{label}</div>
      <Slider label="R" value={value.r} min={0} max={4} step={0.01}
        onChange={(r) => onChange({ ...value, r })} />
      <Slider label="G" value={value.g} min={0} max={4} step={0.01}
        onChange={(g) => onChange({ ...value, g })} />
      <Slider label="B" value={value.b} min={0} max={4} step={0.01}
        onChange={(b) => onChange({ ...value, b })} />
    </div>
  );
}

function LayerKnobs({
  kind,
  multipliers,
  onPatch,
  reloadDirty,
}: {
  kind: LayerKind;
  multipliers: LayerMultipliers;
  onPatch: (patch: Partial<LayerMultipliers>) => void;
  reloadDirty: boolean;
}) {
  const dataKey = `visual-config-knob-${kind}`;
  return (
    <div className="space-y-1" data-testid={dataKey}>
      <Slider label="Roughness ×" value={multipliers.roughnessMultiplier}
        min={0} max={4} step={0.01}
        onChange={(roughnessMultiplier) => onPatch({ roughnessMultiplier })} />
      <Slider label="Metalness ×" value={multipliers.metalnessMultiplier}
        min={0} max={4} step={0.01}
        onChange={(metalnessMultiplier) => onPatch({ metalnessMultiplier })} />
      <Slider label="Normal scale ×" value={multipliers.normalScaleMultiplier}
        min={0} max={4} step={0.01}
        onChange={(normalScaleMultiplier) => onPatch({ normalScaleMultiplier })} />
      <Slider label="AO map ×" value={multipliers.aoMapIntensityMultiplier}
        min={0} max={4} step={0.01}
        onChange={(aoMapIntensityMultiplier) => onPatch({ aoMapIntensityMultiplier })} />
      <Slider label="Env map ×" value={multipliers.envMapIntensityMultiplier}
        min={0} max={4} step={0.01}
        onChange={(envMapIntensityMultiplier) => onPatch({ envMapIntensityMultiplier })} />
      <TintRow label="Color tint" value={multipliers.colorTint}
        onChange={(colorTint) => onPatch({ colorTint })} />
      <ToggleRow
        label="Flat shading"
        value={multipliers.forceFlatShading}
        onChange={(forceFlatShading) => onPatch({ forceFlatShading })}
      />
      <ApplyReloadButton disabled={!reloadDirty} />
    </div>
  );
}

function VegetationKnobs({
  multipliers,
  bootMultipliers,
  onPatch,
}: {
  multipliers: VegetationLayerMultipliers;
  bootMultipliers: VegetationLayerMultipliers;
  onPatch: (patch: Partial<VegetationLayerMultipliers>) => void;
}) {
  // The vegetation tab carries one extra RELOAD knob (`castShadows`) on top
  // of `forceFlatShading`. We render the full LayerKnobs (LIVE multipliers +
  // forceFlatShading + an Apply button), then add the cast-shadows toggle
  // and re-render the Apply button with the vegetation-aware dirty diff so
  // the button is the last thing the user sees in the tab.
  const reloadDirty = vegetationFlagsDifferFromBoot(multipliers, bootMultipliers);
  return (
    <div className="space-y-1" data-testid="visual-config-knob-vegetation">
      <Slider label="Roughness ×" value={multipliers.roughnessMultiplier}
        min={0} max={4} step={0.01}
        onChange={(roughnessMultiplier) => onPatch({ roughnessMultiplier })} />
      <Slider label="Metalness ×" value={multipliers.metalnessMultiplier}
        min={0} max={4} step={0.01}
        onChange={(metalnessMultiplier) => onPatch({ metalnessMultiplier })} />
      <Slider label="Normal scale ×" value={multipliers.normalScaleMultiplier}
        min={0} max={4} step={0.01}
        onChange={(normalScaleMultiplier) => onPatch({ normalScaleMultiplier })} />
      <Slider label="AO map ×" value={multipliers.aoMapIntensityMultiplier}
        min={0} max={4} step={0.01}
        onChange={(aoMapIntensityMultiplier) => onPatch({ aoMapIntensityMultiplier })} />
      <Slider label="Env map ×" value={multipliers.envMapIntensityMultiplier}
        min={0} max={4} step={0.01}
        onChange={(envMapIntensityMultiplier) => onPatch({ envMapIntensityMultiplier })} />
      <TintRow label="Color tint" value={multipliers.colorTint}
        onChange={(colorTint) => onPatch({ colorTint })} />
      <Slider
        label="Tree density"
        value={multipliers.density}
        min={0.05}
        max={1}
        step={0.01}
        onChange={(density) => {
          onPatch({ density });
          // Bridge to the customer-facing slider in `DigitalTwinLayersPanel`.
          // The panel's slider also reads `loadVisualConfig().layers.vegetation.density`
          // on mount so the two stay in sync regardless of which one is moved.
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('city-viewer:vegetation-density', { detail: density }),
            );
          }
        }}
      />
      <ToggleRow
        label="Flat shading"
        value={multipliers.forceFlatShading}
        onChange={(forceFlatShading) => onPatch({ forceFlatShading })}
      />
      <ToggleRow
        label="Cast shadows"
        value={multipliers.castShadows}
        onChange={(castShadows) => onPatch({ castShadows })}
      />
      <ApplyReloadButton disabled={!reloadDirty} />
    </div>
  );
}

export function VisualConfigHud({ onSunCommit }: VisualConfigHudProps = {}) {
  const [activeTab, setActiveTab] = useState<TabId>('central');
  const [importError, setImportError] = useState<string | null>(null);
  const [config, setConfig] = useState<VisualConfig>(() => loadVisualConfig());

  // Renderer's boot-time RELOAD-knob baseline. Frozen on first paint so it
  // survives Reset (Reset restores defaults but the renderer still runs with
  // the boot config until reload, so RELOAD knobs remain dirty until the user
  // clicks Apply). Imports + slider edits diff against this same snapshot.
  const bootRef = useRef<VisualConfig | null>(null);
  if (bootRef.current === null) {
    bootRef.current = loadVisualConfig();
  }
  const boot = bootRef.current;

  useEffect(() => {
    return subscribeVisualConfig((next) => setConfig(next));
  }, []);

  const anyReloadDirty = useMemo(() => {
    return (
      centralDiffersFromBoot(config.central, boot.central) ||
      layerFlagsDifferFromBoot(config.layers.asset, boot.layers.asset) ||
      layerFlagsDifferFromBoot(config.layers.road, boot.layers.road) ||
      vegetationFlagsDifferFromBoot(
        config.layers.vegetation,
        boot.layers.vegetation,
      )
    );
  }, [config, boot]);

  const patchLayer = (
    layer: 'asset' | 'road',
    patch: Partial<LayerMultipliers>,
  ): void => {
    saveVisualConfig({ layers: { [layer]: patch } } as Parameters<typeof saveVisualConfig>[0]);
  };
  const patchVegetation = (patch: Partial<VegetationLayerMultipliers>): void => {
    saveVisualConfig({ layers: { vegetation: patch } } as Parameters<typeof saveVisualConfig>[0]);
  };

  // Re-render on every visual-config change (subscription is sync; the
  // CityViewerCore subscriber coalesces canvas mutations to one rAF tick, but
  // React UI updates happen synchronously so sliders track typed/imported
  // values instantly).
  useEffect(() => {
    setConfig(loadVisualConfig());
    return subscribeVisualConfig(setConfig);
  }, []);

  const handleImportClick = (): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await readFileAsText(file);
        const result = importConfigJSON(text);
        if (result.ok) {
          setImportError(null);
        } else {
          setImportError(result.error);
        }
      } catch (err) {
        setImportError(err instanceof Error ? err.message : String(err));
      }
    };
    input.click();
  };

  return (
    <ViewerAccordionSection
      id="visual-config"
      title="Visual config"
      defaultOpen={false}
      kind="dev"
      headerAdornment={
        anyReloadDirty ? (
          <span
            data-testid="vc-pending-reload-dot"
            className="inline-block size-1.5 rounded-full bg-amber-500"
            title="Pending reload — RELOAD knobs differ from the renderer's boot config"
          />
        ) : null
      }
    >
      <div className="text-[11px] leading-relaxed text-muted-foreground">
        <div className="-mx-3 flex border-b border-border/50">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-2 py-1.5 text-[10px] uppercase tracking-wider transition-colors ${
                activeTab === tab.id
                  ? 'bg-muted text-foreground'
                  : 'hover:bg-muted/50'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div
          className="py-3 max-h-[60vh] overflow-y-auto"
          data-testid={`visual-config-tab-${activeTab}`}
        >
          {activeTab === 'central' && (
            <CentralTab
              config={config}
              bootCentral={boot.central}
              onSunCommit={onSunCommit}
            />
          )}
          {activeTab === 'asset' && (
            <LayerKnobs
              kind="asset"
              multipliers={config.layers.asset}
              onPatch={(patch) => patchLayer('asset', patch)}
              reloadDirty={layerFlagsDifferFromBoot(
                config.layers.asset,
                boot.layers.asset,
              )}
            />
          )}
          {activeTab === 'road' && (
            <LayerKnobs
              kind="road"
              multipliers={config.layers.road}
              onPatch={(patch) => patchLayer('road', patch)}
              reloadDirty={layerFlagsDifferFromBoot(
                config.layers.road,
                boot.layers.road,
              )}
            />
          )}
          {activeTab === 'vegetation' && (
            <VegetationKnobs
              multipliers={config.layers.vegetation}
              bootMultipliers={boot.layers.vegetation}
              onPatch={patchVegetation}
            />
          )}
        </div>
        {importError && (
          <div className="-mx-3 border-t border-destructive/50 bg-destructive/10 px-3 py-1.5 text-[10px] text-destructive">
            Import failed: {importError}
          </div>
        )}
        <div className="-mx-3 flex items-center justify-end gap-1 border-t border-border/50 px-2 py-1.5">
          <button
            type="button"
            onClick={() => {
              resetVisualConfig();
              setImportError(null);
            }}
            className="rounded px-1.5 py-0.5 text-[10px] hover:bg-muted hover:text-foreground transition-colors"
            title="Restore every value to DEFAULT_VISUAL_CONFIG"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => downloadConfigJson(exportConfigJSON())}
            className="rounded px-1.5 py-0.5 text-[10px] hover:bg-muted hover:text-foreground transition-colors"
            title="Download the current config as JSON"
          >
            Export JSON
          </button>
          <button
            type="button"
            onClick={handleImportClick}
            className="rounded px-1.5 py-0.5 text-[10px] hover:bg-muted hover:text-foreground transition-colors"
            title="Import a saved JSON config (Zod-validated)"
          >
            Import JSON
          </button>
        </div>
      </div>
    </ViewerAccordionSection>
  );
}

export default VisualConfigHud;
