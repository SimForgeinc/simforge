"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { RotateCcw, Settings2, X } from "lucide-react";
import type { CityViewer } from "@simforge/viewer";
import {
  UNISCENARIO_AUTHORING_QUALITY_CHOICES,
  type UniScenarioAuthoringQuality,
} from "@/app/lib/uniscenario/contracts";
import type { CameraControlPreferences } from "@simforge/viewer";
import { Button } from "@/app/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "@/app/components/ui/sheet";
import { cn } from "@/app/lib/utils";
import type { EditorExperience } from "../../simple-timed-routes";
import { CopyDebugInformationButton } from "../CopyDebugInformationButton";
import {
  DEFAULT_VIEWPORT_SETTINGS,
  isDefaultViewportSettings,
  LOOK_SENSITIVITY_RANGE,
  loadViewportSettings,
  SENSITIVITY_RANGE,
  saveViewportSettings,
  type ViewportLayerKey,
  type ViewportSettings,
} from "./viewport-settings";

/**
 * Editor, viewport, and camera settings for either the editor top bar or the idle canvas.
 *
 * Collapsed to a single button by default. This sits over the scene, and a permanently open 300px panel
 * would cover the part of the map most people orbit around.
 *
 * Everything here writes straight through to the live viewer — there is no Apply button. Tuning a look
 * sensitivity is a feel judgement: you find the right value by moving the slider and dragging the scene,
 * which is impossible if the value only lands on confirm.
 */
export function ViewportSettingsPanel({
  viewer,
  quality,
  onQualityChange,
  placement = "canvas",
  experience = null,
  onExperienceToggle,
  getDebugInformation,
}: {
  viewer: CityViewer | null;
  quality?: UniScenarioAuthoringQuality;
  onQualityChange?: (quality: UniScenarioAuthoringQuality) => void;
  placement?: "canvas" | "topbar";
  experience?: EditorExperience | null;
  onExperienceToggle?: () => void;
  getDebugInformation?: () => string;
}) {
  const [open, setOpen] = useState(false);
  // Read from storage lazily so the first render already has the user's own settings and the camera never
  // briefly runs on defaults.
  const [settings, setSettings] = useState<ViewportSettings>(() => loadViewportSettings());
  const panelId = useId();

  const update = useCallback((next: ViewportSettings) => {
    setSettings(next);
    saveViewportSettings(next);
  }, []);

  const setControls = useCallback(
    (patch: Partial<CameraControlPreferences>) =>
      update({ ...settings, controls: { ...settings.controls, ...patch } }),
    [settings, update],
  );

  // Push the whole state at the viewer whenever either changes. Keyed on `viewer` as well as `settings`
  // because the viewer arrives after first paint, and is replaced whenever the quality preset remounts
  // it — a one-shot apply would silently revert to defaults on both.
  useEffect(() => {
    if (!viewer) return;
    viewer.setCameraControlPreferences(settings.controls);
    viewer.setCameraMode(settings.cameraMode);
    for (const [layer, visible] of Object.entries(settings.layers)) {
      viewer.setLayerVisible(layer as ViewportLayerKey, visible);
    }
  }, [viewer, settings]);

  const modified = !isDefaultViewportSettings(settings);

  const trigger = (
    <Button
      type="button"
      size={placement === "topbar" ? "sm" : "icon"}
      variant="outline"
      className={cn(
        "h-8 border-border bg-card/90 shadow-sm backdrop-blur",
        placement === "topbar" ? "gap-2 rounded-none px-3" : "w-8 shadow-xl",
      )}
      aria-expanded={open}
      aria-controls={panelId}
      aria-label={placement === "topbar" ? "Settings" : "Viewport and camera settings"}
      title="Viewport and camera settings"
      onClick={placement === "canvas" ? () => setOpen((value) => !value) : undefined}
    >
      <Settings2 className="size-4" aria-hidden="true" />
      {placement === "topbar" ? <span>Settings</span> : null}
    </Button>
  );

  if (!open && placement === "canvas") {
    return <div className="absolute right-4 top-4">{trigger}</div>;
  }

  const panel = (
    <div
      id={panelId}
      className={cn(
        "flex flex-col",
        placement === "topbar"
          ? "min-h-0 flex-1"
          : "absolute right-4 top-4 max-h-[calc(100%-2rem)] w-[300px] border border-border bg-card/95 shadow-xl backdrop-blur",
      )}
      role="group"
      aria-label="Viewport and camera settings"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-2 py-1.5">
        <span className="font-meta text-micro uppercase tracking-meta-wider text-muted-foreground">
          Settings
        </span>
        <div className="flex items-center gap-0.5">
          {modified ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Reset all viewport settings to defaults"
              title="Reset to defaults"
              onClick={() => update({ ...DEFAULT_VIEWPORT_SETTINGS })}
            >
              <RotateCcw className="size-3" aria-hidden="true" />
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6"
            aria-expanded
            aria-label="Close viewport settings"
            onClick={() => setOpen(false)}
          >
            <X className="size-3" aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {experience && onExperienceToggle ? (
          <Section label="Editor mode">
            <Toggle
              checked={experience === "simple"}
              label="Simple mode"
              onChange={onExperienceToggle}
            />
            <p className="mt-1.5 text-micro leading-snug text-muted-foreground">
              Simple mode keeps the workspace focused. Weather and scene time stay available; turn
              it off for traffic and reasoning controls.
            </p>
          </Section>
        ) : null}
        {quality && onQualityChange ? (
          <Section label="Render quality">
            <div className="grid grid-cols-2 gap-1">
              {UNISCENARIO_AUTHORING_QUALITY_CHOICES.map((choice) => (
                <button
                  aria-pressed={quality === choice.id}
                  className={cn(
                    "min-h-7 border px-1.5 font-meta text-[9px] font-bold uppercase tracking-meta transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    quality === choice.id
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border bg-surface-raised text-muted-foreground hover:text-foreground",
                  )}
                  key={choice.id}
                  onClick={() => onQualityChange(choice.id)}
                  type="button"
                >
                  {choice.label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-micro leading-snug text-muted-foreground">
              Balanced is recommended for most devices. High uses more graphics memory.
            </p>
          </Section>
        ) : null}
        <Section label="Camera mode">
          <div className="grid grid-cols-2 gap-1">
            {(["orbit", "fly"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                aria-pressed={settings.cameraMode === mode}
                onClick={() => update({ ...settings, cameraMode: mode })}
                className={cn(
                  "h-7 border font-meta text-micro font-bold uppercase tracking-meta transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  settings.cameraMode === mode
                    ? "border-primary bg-primary/15 text-foreground"
                    : "border-border bg-surface-raised text-muted-foreground hover:text-foreground",
                )}
              >
                {mode}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-micro leading-snug text-muted-foreground">
            {settings.cameraMode === "orbit"
              ? "Drag orbits · middle or right drag pans · wheel zooms · WASD pans · Q/E rotates."
              : "Pointer-lock mouse look · WASD moves · Q/E rolls."}
          </p>
        </Section>

        <Section label="Invert">
          <Toggle
            label="Horizontal look"
            checked={settings.controls.reverseHorizontalLook}
            onChange={(value) => setControls({ reverseHorizontalLook: value })}
          />
          <Toggle
            label="Vertical look"
            checked={settings.controls.reverseVerticalLook}
            onChange={(value) => setControls({ reverseVerticalLook: value })}
          />
          <Toggle
            label="Horizontal pan"
            checked={settings.controls.reverseHorizontalPan}
            onChange={(value) => setControls({ reverseHorizontalPan: value })}
          />
          <Toggle
            label="Vertical pan"
            checked={settings.controls.reverseVerticalPan}
            onChange={(value) => setControls({ reverseVerticalPan: value })}
          />
        </Section>

        <Section label="Sensitivity">
          <Slider
            label="Look X"
            value={settings.controls.horizontalLookSensitivity}
            range={LOOK_SENSITIVITY_RANGE}
            onChange={(value) => setControls({ horizontalLookSensitivity: value })}
          />
          <Slider
            label="Look Y"
            value={settings.controls.verticalLookSensitivity}
            range={LOOK_SENSITIVITY_RANGE}
            onChange={(value) => setControls({ verticalLookSensitivity: value })}
          />
          <Slider
            label="Pan (middle)"
            value={settings.controls.middlePanSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ middlePanSensitivity: value })}
          />
          <Slider
            label="Pan (right)"
            value={settings.controls.rightPanSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ rightPanSensitivity: value })}
          />
          <Slider
            label="Wheel zoom"
            value={settings.controls.wheelZoomSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ wheelZoomSensitivity: value })}
          />
          <Slider
            label="Keyboard move"
            value={settings.controls.keyboardMoveSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ keyboardMoveSensitivity: value })}
          />
          <Slider
            label="Keyboard turn"
            value={settings.controls.keyboardTurnSensitivity}
            range={SENSITIVITY_RANGE}
            onChange={(value) => setControls({ keyboardTurnSensitivity: value })}
          />
        </Section>

        <Section label="Layers" last={!getDebugInformation}>
          <Toggle
            label="Buildings"
            checked={settings.layers.city}
            onChange={(value) => update({ ...settings, layers: { ...settings.layers, city: value } })}
          />
          <Toggle
            label="Vegetation"
            checked={settings.layers.vegetation}
            onChange={(value) =>
              update({ ...settings, layers: { ...settings.layers, vegetation: value } })
            }
          />
          <Toggle
            label="Roads"
            checked={settings.layers.road}
            onChange={(value) => update({ ...settings, layers: { ...settings.layers, road: value } })}
          />
          <p className="mt-1.5 text-micro leading-snug text-muted-foreground">
            The quality preset can hide buildings and vegetation regardless of these.
          </p>
        </Section>
        {getDebugInformation ? (
          <Section label="Support" last>
            <CopyDebugInformationButton
              className="w-full justify-start"
              getDebugInformation={getDebugInformation}
            />
            <p className="mt-1.5 text-micro leading-snug text-muted-foreground">
              Copies scenario and editor diagnostics for troubleshooting.
            </p>
          </Section>
        ) : null}
      </div>
    </div>
  );

  return placement === "topbar" ? (
    <Sheet onOpenChange={setOpen} open={open}>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        className="flex w-[min(420px,calc(100vw-1rem))] flex-col gap-0 overflow-hidden border-border bg-background p-0 pr-0 sm:max-w-[420px] [&>button:last-child]:hidden"
        data-testid="viewport-settings-drawer"
        side="right"
      >
        <SheetTitle className="sr-only">Editor settings</SheetTitle>
        <SheetDescription className="sr-only">
          Configure the editor mode, rendering quality, camera controls, and visible map layers.
        </SheetDescription>
        {panel}
      </SheetContent>
    </Sheet>
  ) : panel;
}

function Section({
  label,
  children,
  last = false,
}: {
  label: string;
  children: React.ReactNode;
  last?: boolean;
}) {
  return (
    <section className={cn("pb-3", !last && "mb-3 border-b border-border/60")}>
      <h3 className="mb-1.5 font-meta text-micro uppercase tracking-meta-wider text-muted-foreground/70">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** A compact switch row. `role="switch"` so its on/off state is announced, not just its name. */
function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-2 py-1 text-left text-meta text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span>{label}</span>
      <span
        aria-hidden="true"
        className={cn(
          "relative h-3.5 w-7 shrink-0 border transition-colors",
          checked ? "border-primary bg-primary/30" : "border-border bg-surface-raised",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-2 transition-all",
            checked ? "left-[calc(100%-0.625rem)] bg-primary" : "left-0.5 bg-muted-foreground",
          )}
        />
      </span>
    </button>
  );
}

function Slider({
  label,
  value,
  range,
  onChange,
}: {
  label: string;
  value: number;
  range: { readonly min: number; readonly max: number };
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="py-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-meta text-muted-foreground">
          {label}
        </label>
        <span className="font-meta text-micro tabular-nums text-muted-foreground/70">{value}%</span>
      </div>
      <input
        id={id}
        type="range"
        min={range.min}
        max={range.max}
        step={5}
        value={value}
        // Percent, not the raw number, or a screen reader announces "100" with no unit and no sense of
        // whether that is fast or slow.
        aria-valuetext={`${value} percent`}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="mt-1 h-1 w-full cursor-pointer appearance-none bg-muted accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </div>
  );
}
