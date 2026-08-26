"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import type { CityViewer } from "@simforge-oss/viewer";
import { cameraStateReport } from "@simforge-oss/viewer";
import type { EditorState, ScenarioMapEntry } from "@simforge-oss/editor";
import { editorSourceMapId } from "@simforge-oss/editor";
import { actorClassForCatalogEntry, getEntry, type CatalogActorClass } from "@simforge-oss/asset-catalog";
import { Button } from "@/app/components/ui/button";
import { cn } from "@/app/lib/utils";
import {
  contractCameraReportAsWire,
  type CreateHifiPreviewInput,
  type HifiPreviewProfile,
  type HifiPreviewRecord,
} from "@/app/lib/hifi-preview/contracts";

/** Catalog physics families -> scene-state.v1 actor classes (renderer cuboid interim). */
const SCENE_ACTOR_CLASS: Record<CatalogActorClass, CreateHifiPreviewInput["scene"]["actors"][number]["actorClass"]> = {
  car: "car",
  van: "car",
  truck: "truck",
  bus: "bus",
  motorcycle: "motorcycle",
  scooter: "motorcycle",
  bicycle: "bicycle",
  pedestrian: "pedestrian",
  sidewalk_robot: "prop",
  drone: "prop",
  animal: "prop",
  static_object: "prop",
};

const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 5 * 60_000;
const MAX_FRAME_WIDTH = 1280;
const MAX_FRAME_HEIGHT = 1080;
const FRIENDLY_ERRORS: Record<string, string> = {
  renderer_unavailable: "The native renderer isn't available on this machine (renderer/service is not built).",
  renderer_exited: "The native renderer crashed while preparing the scene.",
  renderer_connect_timeout: "The native renderer took too long to prewarm the map.",
  map_payload_unavailable: "This map has no published payloads the native renderer can load.",
  native_payload_unavailable:
    "This map's native-ready corpus is unavailable. Build its sensor corpus before requesting a Bevy frame.",
  native_payload_build_unavailable: "Native payload building isn't available on this Studio worker.",
  native_payload_build_invalid: "The native payload build did not match the published map.",
  native_payload_build_failed: "The native payload build failed. Check the Studio worker log for details.",
  render_export_timeout: "The renderer produced no frame in time.",
  camera_sees_nothing:
    "The native camera still sees no map geometry after automatic framing. Rebuild the map's native corpus, then retry; if it persists, inspect the reported world bounds in the worker log.",
};

type PreviewState =
  | { phase: "idle" }
  | { phase: "pending"; requestId: string | null; startedAt: number }
  | { phase: "done"; record: HifiPreviewRecord }
  | { phase: "failed"; message: string; code: string | null };

/** Snapshot the CURRENT editor scene + viewport camera as one preview request. */
function buildRequest(
  viewer: CityViewer,
  map: ScenarioMapEntry,
  state: EditorState | null,
  documentId: string | null,
  scenarioRevision: number | null,
  profile: HifiPreviewProfile,
): CreateHifiPreviewInput {
  const camera = contractCameraReportAsWire(cameraStateReport(viewer));
  const canvas = viewer.renderer.domElement;
  const sourceWidth = Math.max(canvas.clientWidth, 64);
  const sourceHeight = Math.max(canvas.clientHeight, 64);
  // Fit both axes together so the service's width/height-derived aspect stays
  // identical to the Three camera aspect carried in the contract report.
  const scale = Math.min(1, MAX_FRAME_WIDTH / sourceWidth, MAX_FRAME_HEIGHT / sourceHeight);
  const width = Math.max(64, 2 * Math.round((sourceWidth * scale) / 2));
  const height = Math.max(64, 2 * Math.round((sourceHeight * scale) / 2));
  const actors = (state?.actors ?? []).map((actor) => {
    let catalogClass: CatalogActorClass = "static_object";
    try {
      catalogClass = actorClassForCatalogEntry(getEntry(actor.catalogId));
    } catch {
      // external/unknown catalog entries render as props
    }
    return {
      id: actor.id,
      kind: "spawn" as const,
      catalogId: actor.catalogId,
      actorClass: SCENE_ACTOR_CLASS[catalogClass],
      transform: {
        position: [actor.x, actor.y, actor.z] as [number, number, number],
        rotation: [0, Math.sin(actor.headingRad / 2), 0, Math.cos(actor.headingRad / 2)] as [
          number, number, number, number,
        ],
      },
      velocity: [0, 0, 0] as [number, number, number],
    };
  });
  return {
    documentId,
    scenarioRevision,
    mapVersionId: map.versionId,
    profile,
    // The editor authors the t=0 scene; timeline playback previews stay Three-side.
    tick: 0,
    width,
    height,
    camera,
    scene: {
      version: "scene-state.v1",
      mapId: editorSourceMapId(map),
      tick: 0,
      tickHz: 50,
      groundY: null,
      actors,
    },
  };
}

/**
 * On-demand high-fidelity (Bevy `native-render-service`) still of the current
 * viewport, shown beside the live Three canvas with a provenance strip.
 * Mirrors the notification-dock slot pattern: self-contained fixed overlay,
 * non-blocking, pointer events only on its own cards.
 */
export function HifiPreviewSlot({
  viewer,
  map,
  state,
  documentId,
  scenarioRevision,
  active = true,
}: {
  viewer: CityViewer | null;
  map: ScenarioMapEntry;
  state: EditorState | null;
  documentId: string | null;
  scenarioRevision: number | null;
  active?: boolean;
}) {
  const [preview, setPreview] = useState<PreviewState>({ phase: "idle" });
  const [profile, setProfile] = useState<HifiPreviewProfile>("cinematic");
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(() => () => pollAbort.current?.abort(), []);

  const start = useCallback(async () => {
    if (!viewer) return;
    pollAbort.current?.abort();
    const abort = new AbortController();
    pollAbort.current = abort;
    setPreview({ phase: "pending", requestId: null, startedAt: Date.now() });
    try {
      const body = buildRequest(viewer, map, state, documentId, scenarioRevision, profile);
      const created = await fetch("/api/hifi-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!created.ok) throw new Error(`request rejected (${created.status})`);
      const record = (await created.json()) as HifiPreviewRecord;
      setPreview({ phase: "pending", requestId: record.id, startedAt: Date.now() });
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await new Promise((settle) => setTimeout(settle, POLL_INTERVAL_MS));
        if (abort.signal.aborted) return;
        const polled = await fetch(`/api/hifi-preview/${record.id}`, { signal: abort.signal });
        if (!polled.ok) throw new Error(`status poll failed (${polled.status})`);
        const current = (await polled.json()) as HifiPreviewRecord;
        if (current.status === "succeeded") {
          setPreview({ phase: "done", record: current });
          return;
        }
        if (current.status === "failed") {
          setPreview({
            phase: "failed",
            code: current.errorCode,
            message:
              FRIENDLY_ERRORS[current.errorCode ?? ""] ??
              `High-fidelity render failed (${current.errorCode ?? "unknown"}).`,
          });
          return;
        }
      }
      setPreview({ phase: "failed", code: "poll_timeout", message: "High-fidelity render timed out." });
    } catch (error) {
      if (abort.signal.aborted) return;
      setPreview({
        phase: "failed",
        code: null,
        message: error instanceof Error ? error.message : "High-fidelity render failed.",
      });
    }
  }, [documentId, map, profile, scenarioRevision, state, viewer]);

  const dismiss = useCallback(() => {
    pollAbort.current?.abort();
    setPreview({ phase: "idle" });
  }, []);

  if (!active) return null;

  return (

    <div
      className={cn(
        "pointer-events-none fixed right-5 top-16 z-[60] flex flex-col items-end gap-2",
        preview.phase === "done"
          ? "w-[min(720px,calc(50vw-1.5rem))]"
          : "w-[min(460px,calc(100vw-2rem))]",
      )}
      data-testid="hifi-preview-slot"
    >
      <div className="pointer-events-auto flex items-center gap-1.5">
        {preview.phase === "idle" || preview.phase === "failed" ? (
          <select
            aria-label="High-fidelity render profile"
            className="h-8 rounded-none border border-border/70 bg-card/90 px-2 text-xs text-foreground shadow-sm backdrop-blur"
            data-testid="hifi-preview-profile"
            onChange={(event) => setProfile(event.target.value as HifiPreviewProfile)}
            value={profile}
          >
            <option value="cinematic">Cinematic</option>
            <option value="sensor">Sensor</option>
          </select>
        ) : null}
        <Button
          aria-label="High-fidelity preview"
          className="h-8 gap-2 rounded-none border border-[#7DD3FC]/45 bg-card/90 px-3 text-[#7DD3FC] shadow-sm backdrop-blur hover:border-[#7DD3FC] hover:bg-[#7DD3FC] hover:text-black disabled:border-border disabled:text-muted-foreground"
          data-testid="hifi-preview-button"
          disabled={!viewer || preview.phase === "pending"}
          onClick={() => void start()}
          size="sm"
          title={viewer ? "Render this exact view with the native Bevy renderer" : "Viewport still loading"}
          type="button"
          variant="outline"
        >
          {preview.phase === "pending" ? (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          ) : (
            <Sparkles aria-hidden="true" className="size-4" />
          )}
          <span>High-fidelity preview</span>
        </Button>
      </div>

      {preview.phase === "pending" ? (
        <div
          className="pointer-events-auto flex w-full items-center gap-2 border border-border/70 bg-card/95 p-3 text-xs text-muted-foreground shadow-lg backdrop-blur"
          data-testid="hifi-preview-progress"
        >
          <Loader2 aria-hidden="true" className="size-4 animate-spin text-[#7DD3FC]" />
          <span>
            Rendering one {profile} frame with the native renderer… the map prewarm can take a minute on
            first use. The editor stays fully interactive.
          </span>
          <Button className="ml-auto h-6 px-2" onClick={dismiss} size="sm" type="button" variant="ghost">
            Cancel
          </Button>
        </div>
      ) : null}

      {preview.phase === "failed" ? (
        <div
          className="pointer-events-auto flex w-full items-start gap-2 border border-red-500/50 bg-card/95 p-3 text-xs text-red-200 shadow-lg backdrop-blur"
          data-testid="hifi-preview-error"
          role="alert"
        >
          <span className="min-w-0">{preview.message}</span>
          <Button
            aria-label="Dismiss high-fidelity preview error"
            className="ml-auto h-6 px-2"
            onClick={dismiss}
            size="sm"
            type="button"
            variant="ghost"
          >
            <X aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
      ) : null}

      {preview.phase === "done" ? (
        <figure
          className="pointer-events-auto w-full border border-border/70 bg-card/95 shadow-xl backdrop-blur"
          data-testid="hifi-preview-frame"
        >
          <div className="flex items-center justify-between border-b border-border/60 px-2 py-1">
            <span className="text-[11px] font-medium uppercase tracking-wide text-[#7DD3FC]">
              High-fidelity preview
            </span>
            <Button
              aria-label="Close high-fidelity preview"
              className="h-6 px-1.5"
              data-testid="hifi-preview-close"
              onClick={dismiss}
              size="sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
          {preview.record.artifactUrl ? (
            // Not next/image: the artifact URL is a local presigned object route.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt="High-fidelity native render of the current viewport"
              className="block w-full"
              src={preview.record.artifactUrl}
            />
          ) : null}
          <figcaption
            className={cn(
              "flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border/60 px-2 py-1",
              "font-mono text-[10px] leading-4 text-muted-foreground",
            )}
            data-testid="hifi-preview-provenance"
          >
            <span title="Renderer implementation">
              renderer {preview.record.provenance?.renderer ?? "bevy-native"}
            </span>
            <span title="Render profile">profile {preview.record.provenance?.profile ?? preview.record.profile}</span>
            <span title="Scene tick">tick {preview.record.provenance?.tick ?? preview.record.tick}</span>
            {preview.record.provenance ? (
              <>
                <span title="Frame digest (sha256)">
                  frame {preview.record.provenance.frame.sha256.slice(0, 12)}
                </span>
                <span title="Native-ready payloads rendered">
                  native tiles {preview.record.provenance.map.tileCount}
                </span>
                <span title="Non-background instance-ID pixel coverage">
                  coverage {(preview.record.provenance.coverage * 100).toFixed(1)}%
                </span>
                {preview.record.provenance.fallbackFraming ? (
                  <span title="The caller camera was empty; world-bounds framing was used">
                    fallback framing
                  </span>
                ) : null}
                <span title="Render wall time">
                  {(preview.record.provenance.timings.renderMs / 1000).toFixed(2)}s render
                </span>
              </>
            ) : null}
          </figcaption>
        </figure>
      ) : null}
    </div>
  );
}
