"use client";

import { useCallback, useEffect, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import {
  CityView,
  type CityViewProps,
} from "@uniscenarios/city-renderer/react";
import type { CityViewer } from "@uniscenarios/city-renderer";
import type {
  EditorState,
  UniScenarioMapEntry,
} from "@uniscenarios/editor-core";
import type { UniScenarioAuthoringQuality } from "@/app/lib/uniscenario/contracts";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { cn } from "@/app/lib/utils";
import { AUTHORING_QUALITY } from "../authoring-quality";

/**
 * OWNS: the `CityView` host element and the actor-library overlay.
 *
 * `hostRef` is owned by the surface, not by this region: `useEditorRuntime`
 * attaches the input controller to it, and the runtime hook has to live above
 * both this region and the inspector that reads its state.
 *
 * `CityView` is keyed on `quality` because `maxPixelRatio` and `antialias` are
 * WebGL context-creation options — they cannot be changed on a live context, so
 * a quality change genuinely is a new viewer. Nothing else here may remount.
 */
export function EditorCanvasRegion({
  hostRef,
  map,
  quality,
  onViewerReady,
  onMapLoaded,
  state,
  error,
  externalWorld = false,
  children,
}: {
  hostRef: RefObject<HTMLDivElement | null>;
  map: UniScenarioMapEntry;
  quality: UniScenarioAuthoringQuality;
  onViewerReady: (viewer: CityViewer) => void;
  onMapLoaded?: (manifestUrl: string) => void;
  state: EditorState | null;
  error: string | null;
  /** Use the already-mounted datasets world instead of creating a second viewer. */
  externalWorld?: boolean;
  children?: ReactNode;
}) {
  const preset = AUTHORING_QUALITY[quality];
  const activeViewerRef = useRef<CityViewer | null>(null);
  const registerViewer = useCallback((viewer: CityViewer) => {
    activeViewerRef.current = viewer;
    onViewerReady(viewer);
  }, [onViewerReady]);
  const reportMapLoaded = useCallback((viewer: CityViewer, manifestUrl: string) => {
    if (activeViewerRef.current !== viewer) return;
    onMapLoaded?.(manifestUrl);
  }, [onMapLoaded]);

  return (
    <div
      ref={hostRef}
      className={cn(
        "relative min-w-0 flex-1 overflow-hidden",
        externalWorld ? "pointer-events-none bg-transparent" : "bg-background",
      )}
      data-tutorial="canvas"
      data-testid="uniscenario-editor-canvas-region"
      data-external-world={String(externalWorld)}
    >
      {/* The name, role and tab stop go on the canvas itself. `tabIndex` is the
          load-bearing one: the viewer binds its key handling to this element, so
          without a tab stop there is no keyboard route into the scene at all. */}
      {!externalWorld ? (
        <EditorCityViewInstance
          key={quality}
          manifestUrl={map.manifestUrl}
          options={{
            maxPixelRatio: preset.maxPixelRatio,
            antialias: preset.antialias,
            cinematicLighting: preset.cinematicLighting,
          }}
          onViewerReady={registerViewer}
          onViewerMapLoaded={reportMapLoaded}
          className="h-full w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          ariaLabel={`${map.label} 3D scene. Click an actor to select it, drag to orbit.`}
          role="application"
          tabIndex={0}
        />
      ) : null}
      {!state ? (
        error ? (
          <div
            className="pointer-events-none absolute bottom-4 right-4 z-20 max-w-sm border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive shadow-lg"
            data-testid="uniscenario-map-status"
            role="alert"
            aria-live="assertive"
          >
            {error}
          </div>
        ) : (
          <CloudActivityIndicator
            className="pointer-events-none absolute bottom-4 right-4 z-20 text-xs text-white/65"
            label="Loading map and lane topology…"
            testId="uniscenario-map-status"
          />
        )
      ) : null}

      <div className="pointer-events-auto">
        {children}
      </div>
    </div>
  );
}

/** Give each keyed CityView its own viewer identity so stale loads cannot ready a replacement. */
function EditorCityViewInstance({
  onViewerMapLoaded,
  onViewerReady,
  ...props
}: Omit<CityViewProps, "onMapLoaded" | "onReady"> & {
  readonly onViewerMapLoaded: (viewer: CityViewer, manifestUrl: string) => void;
  readonly onViewerReady: (viewer: CityViewer) => void;
}) {
  const viewerRef = useRef<CityViewer | null>(null);
  useEffect(() => () => {
    viewerRef.current = null;
  }, []);

  return (
    <CityView
      {...props}
      onReady={(viewer) => {
        viewerRef.current = viewer;
        onViewerReady(viewer);
      }}
      onMapLoaded={(manifestUrl) => {
        const viewer = viewerRef.current;
        if (viewer) onViewerMapLoaded(viewer, manifestUrl);
      }}
    />
  );
}
