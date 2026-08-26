import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement } from 'react';
import { CityViewer } from './viewer';
import type { CityViewerOptions } from './types';
import {
  installViewerRuntimeDiagnostics,
  type ViewerRuntimeDiagnostics,
} from './viewer-diagnostics';

export interface CityViewProps {
  /** Manifest URL, relative to `options.baseUrl` when set. */
  manifestUrl: string;
  options?: CityViewerOptions;
  className?: string;
  style?: CSSProperties;
  /** Called once the viewer exists — before the map has finished streaming. */
  onReady?: (viewer: CityViewer) => void;
  /** Called after this manifest has replaced the previous streamed map. */
  onMapLoaded?: (manifestUrl: string) => void;
  onError?: (error: unknown, manifestUrl: string) => void;
  /** Reports capabilities backed by metadata that loaded and validated. */
  onCapabilitiesChange?: (capabilities: readonly string[]) => void;
  /**
   * Accessible name for the scene. A `<canvas>` has no implicit name and no
   * inner text to fall back on, so without this the whole 3D surface announces
   * as nothing at all.
   */
  ariaLabel?: string;
  /**
   * ARIA role, normally `"application"` — the canvas handles its own keys, so
   * assistive tech has to stop intercepting them. Pair it with `tabIndex` or
   * there is no way to reach the scene from the keyboard.
   */
  role?: string;
  tabIndex?: number;
}

const CANVAS_STYLE: CSSProperties = { display: 'block', width: '100%', height: '100%' };

/**
 * Thin React wrapper: mounts a {@link CityViewer} on a canvas and disposes it
 * on unmount. All interaction stays on the viewer instance handed to `onReady`.
 */
export function CityView({
  manifestUrl,
  options,
  className,
  style,
  onReady,
  onMapLoaded,
  onError,
  onCapabilitiesChange,
  ariaLabel,
  role,
  tabIndex,
}: CityViewProps): ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<unknown>(null);
  const viewerRef = useRef<CityViewer | null>(null);
  const diagnosticsRef = useRef<ViewerRuntimeDiagnostics | null>(null);
  const loadGenerationRef = useRef(0);
  // Options are read once at mount; changing them later requires a remount.
  const optionsRef = useRef(options);
  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onMapLoadedRef = useRef(onMapLoaded);
  const onCapabilitiesChangeRef = useRef(onCapabilitiesChange);
  onReadyRef.current = onReady;
  onErrorRef.current = onError;
  onMapLoadedRef.current = onMapLoaded;
  onCapabilitiesChangeRef.current = onCapabilitiesChange;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const viewer = new CityViewer(canvas, optionsRef.current);
    diagnosticsRef.current = installViewerRuntimeDiagnostics(viewer);
    viewerRef.current = viewer;
    onReadyRef.current?.(viewer);
    return () => {
      diagnosticsRef.current?.dispose();
      diagnosticsRef.current = null;
      viewerRef.current = null;
      viewer.dispose();
    };
  }, []);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const generation = ++loadGenerationRef.current;
    setError(null);
    onCapabilitiesChangeRef.current?.([]);
    diagnosticsRef.current?.mapLoadStarted(manifestUrl);
    viewer.loadMap(manifestUrl)
      .then(() => {
        if (generation !== loadGenerationRef.current) return;
        diagnosticsRef.current?.mapLoadSucceeded(manifestUrl);
        onMapLoadedRef.current?.(manifestUrl);
        onCapabilitiesChangeRef.current?.(viewer.getCapabilities());
      })
      .catch((err: unknown) => {
        if (generation !== loadGenerationRef.current) return;
        diagnosticsRef.current?.mapLoadFailed(manifestUrl, err);
        setError(err);
        onErrorRef.current?.(err, manifestUrl);
        console.error('[city-renderer] loadMap failed', err);
      });
  }, [manifestUrl]);

  return (
    <canvas
      ref={canvasRef}
      aria-label={ariaLabel}
      className={className}
      role={role}
      style={{ ...CANVAS_STYLE, ...style }}
      tabIndex={tabIndex}
      data-error={error ? String(error) : undefined}
    />
  );
}
