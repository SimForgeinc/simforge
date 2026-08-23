"use client";

import { CheckCircle2, FileUp, MapPin } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Input } from "@/app/components/ui/input";
import {
  SERVER_GENERATED_CLOSURE_PATHS,
  type CreateMapUploadInput,
  type CreateMapUploadResult,
  type PublishedMapSummary,
} from "@/app/lib/map-ingest/contracts";
import type { ImportedMap } from "@/app/lib/map-ingest/map-import";

/**
 * Where the map upload is in its lifecycle. The dialog owns the shared progress
 * bar, error line and footer, so it needs one value — not five booleans — to
 * decide whether closing is safe and what the primary action means.
 */
export type MapUploadPhase = "empty" | "parsing" | "ready" | "uploading" | "generating" | "published";

/**
 * Structural type of the dialog's `uploadBlob`. Declared here rather than
 * imported so the panel does not import the component that renders it.
 */
type BlobUploader = (
  target: { url: string; headers: Record<string, string> },
  blob: Blob,
  onProgress: (fraction: number) => void,
) => Promise<void>;

type ResponseErrorReader = (response: Response, fallback: string) => Promise<string>;

/**
 * What each server-generated closure member is, in the user's terms. Keyed on the
 * frozen contract list so adding a member to the closure fails the build here
 * instead of quietly shipping an unexplained artifact.
 */
const GENERATED_ARTIFACT_LABELS: Record<(typeof SERVER_GENERATED_CLOSURE_PATHS)[number], string> = {
  "3d/manifest.json": "City manifest — scene bounds, triangle totals and the static layer index",
  "3d/semantics.json": "Static semantics — per-node classification for every layer",
  "3d/variants/manifest.json":
    "Static collision — building and barrier colliders the browser simulation needs",
  "topology-index.json.gz": "Road topology — lanes, junctions and turn gates",
  "lane-polygons.geojson.gz": "Lane polygons — the drivable surface footprint",
  "signals.geojson.gz": "Traffic signals — signal heads and the lanes they control",
  "derived/topology-derived.json.gz": "Derived topology — the editor's routing and search structures",
  "derived/locations.json.gz": "Named locations — the junctions, crosswalks and streets map search resolves",
  "derived/roadway-consistency.json.gz": "Roadway consistency — the road geometry checked against the topology",
};

function formatBytes(bytes: number) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/[0.07] bg-white/[0.03] p-3">
      <p className="text-[10px] uppercase tracking-wider text-white/35">{label}</p>
      <p className="mt-1 text-sm tabular-nums">{value}</p>
    </div>
  );
}

export function MapUploadPanel({
  formId,
  uploadBlob,
  responseError,
  onPhaseChange,
  onStatusChange,
  onProgressChange,
  onErrorChange,
  onPublished,
}: {
  /** The dialog's shared form id, so its footer button submits this form. */
  formId: string;
  uploadBlob: BlobUploader;
  responseError: ResponseErrorReader;
  onPhaseChange: (phase: MapUploadPhase) => void;
  onStatusChange: (status: string) => void;
  onProgressChange: (progress: number) => void;
  onErrorChange: (error: string | null) => void;
  onPublished: (summary: PublishedMapSummary) => void;
}) {
  const carlaFieldId = useId();
  const carlaHelpId = useId();
  const [map, setMap] = useState<ImportedMap | null>(null);
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [locality, setLocality] = useState("");
  const [carlaMapName, setCarlaMapName] = useState("");
  const [phase, setPhase] = useState<MapUploadPhase>("empty");
  const [published, setPublished] = useState<PublishedMapSummary | null>(null);

  useEffect(() => () => {
    if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
  }, [thumbnailUrl]);

  const enterPhase = (next: MapUploadPhase) => {
    setPhase(next);
    onPhaseChange(next);
  };

  // A second selection landing mid-flight would race the first on `map` and on the
  // phase. Parsing is abandonable by closing the dialog, but not by overlapping it.
  const busy = phase === "parsing" || phase === "uploading" || phase === "generating";

  const chooseFiles = (selected: File[]) => {
    if (selected.length === 0 || busy) return;
    void importFiles(selected);
  };

  const importFiles = async (selected: File[]) => {
    enterPhase("parsing");
    onErrorChange(null);
    onStatusChange("Parsing OpenDRIVE and layer geometry…");
    onProgressChange(8);
    try {
      // Deliberately dynamic, exactly as the model path is: a static import would
      // pull three.js and the GLB parser into the dashboard's first-load bundle for
      // every visitor, when only the few who upload a map ever need them.
      const { importMapFiles } = await import("@/app/lib/map-ingest/map-import");
      const imported = await importMapFiles(selected);
      if (thumbnailUrl) URL.revokeObjectURL(thumbnailUrl);
      setMap(imported);
      setThumbnailUrl(URL.createObjectURL(imported.thumbnailBlob));
      // The OpenDRIVE header names the map. Carrying the previous label over would
      // publish the last map's name onto a different road network.
      setLabel(imported.mapName);
      enterPhase("ready");
      onStatusChange("Map ready to publish");
      onProgressChange(40);
    } catch (reason) {
      setMap(null);
      enterPhase("empty");
      onStatusChange("");
      onProgressChange(0);
      onErrorChange(reason instanceof Error ? reason.message : "The map files could not be read.");
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!map || phase !== "ready") return;
    enterPhase("uploading");
    onErrorChange(null);
    onProgressChange(44);
    onStatusChange("Creating map upload…");
    try {
      const input: CreateMapUploadInput = {
        label: label.trim(),
        locality: locality.trim(),
        carlaMapName: carlaMapName.trim() || null,
        xodr: { sha256: map.xodr.sha256, byteLength: map.xodr.blob.size },
        thumbnail: { sha256: map.thumbnailSha256, byteLength: map.thumbnailBlob.size },
        layers: map.layers.map((layer) => ({
          layerId: layer.layerId,
          fileName: layer.fileName,
          sha256: layer.sha256,
          byteLength: layer.blob.size,
          triangleCount: layer.triangleCount,
        })),
        preflight: map.preflight,
      };
      const createResponse = await fetch("/api/map-ingest/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!createResponse.ok) {
        throw new Error(await responseError(createResponse, "The map upload could not be created."));
      }
      const created = (await createResponse.json()) as CreateMapUploadResult;

      // The draft names its members by canonical path, and every one of them must
      // resolve to bytes this tab actually holds. A path we cannot resolve is a
      // contract break, not something to skip quietly.
      const bytesByPath = new Map<string, Blob>([
        ["map.xodr", map.xodr.blob],
        ["thumbnail.webp", map.thumbnailBlob],
        ...map.layers.map((layer): [string, Blob] => [`3d/${layer.layerId}.glb`, layer.blob]),
      ]);
      const transfers: Array<{ url: string; headers: Record<string, string>; blob: Blob }> = [];
      let storedAlready = 0;
      for (const target of created.uploads) {
        const blob = bytesByPath.get(target.path);
        if (!blob) {
          throw new Error(`The server asked for ${target.path}, which this upload does not contain.`);
        }
        // A null URL means the bucket already holds these exact content-addressed bytes.
        if (target.url === null) {
          storedAlready += 1;
          continue;
        }
        transfers.push({ url: target.url, headers: target.headers, blob });
      }

      if (transfers.length === 0) {
        onProgressChange(84);
        onStatusChange(`All ${storedAlready} files were already stored`);
      } else {
        onStatusChange(
          storedAlready > 0
            ? `Uploading ${transfers.length} files · ${storedAlready} already stored`
            : `Uploading ${transfers.length} files…`,
        );
        const totalBytes = transfers.reduce((total, target) => total + target.blob.size, 0);
        const loadedBytes = new Array<number>(transfers.length).fill(0);
        const updateProgress = () => {
          let loaded = 0;
          for (const value of loadedBytes) loaded += value;
          onProgressChange(44 + Math.round((loaded / totalBytes) * 40));
        };
        await Promise.all(
          transfers.map((target, index) =>
            uploadBlob({ url: target.url, headers: target.headers }, target.blob, (fraction) => {
              loadedBytes[index] = fraction * target.blob.size;
              updateProgress();
            }),
          ),
        );
      }

      enterPhase("generating");
      onProgressChange(86);
      onStatusChange("Publishing — generating derived map artifacts…");
      const publishResponse = await fetch(
        `/api/map-ingest/uploads/${encodeURIComponent(created.draftId)}/publish`,
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      );
      if (!publishResponse.ok) {
        throw new Error(await responseError(publishResponse, "The map could not be published."));
      }
      const { map: summary } = (await publishResponse.json()) as { map: PublishedMapSummary };
      setPublished(summary);
      enterPhase("published");
      onProgressChange(100);
      onStatusChange("Map version published");
      onPublished(summary);
    } catch (reason) {
      // Back to `ready`, not a dead end: the bytes are unchanged and content
      // addressing makes a second attempt cheap.
      enterPhase("ready");
      onStatusChange("Publish failed");
      onErrorChange(reason instanceof Error ? reason.message : "The map could not be published.");
    }
  };

  if (published) {
    return (
      <div className="mt-6 space-y-5">
        <div className="rounded-xl border border-emerald-400/20 bg-emerald-400/[0.04] p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-emerald-200">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
            {published.label} is published and available in the scenario editor
          </p>
          <p className="mt-1 flex items-center gap-1.5 text-xs text-white/45">
            <MapPin className="size-3 shrink-0" aria-hidden="true" />
            {published.locality} · roadway consistency: {published.generated.roadwayConsistencyVerdict}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile label="Lanes" value={published.generated.laneCount.toLocaleString()} />
          <StatTile label="Junctions" value={published.generated.junctionCount.toLocaleString()} />
          <StatTile label="Locations" value={published.generated.locationCount.toLocaleString()} />
          <StatTile label="Triangles" value={published.generated.triangleCount.toLocaleString()} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <StatTile label="Closure objects" value={`${published.objectCount.toLocaleString()} files`} />
          <StatTile label="Closure size" value={formatBytes(published.byteLength)} />
        </div>

        {published.browserOnly ? (
          <div className="rounded-xl border border-amber-300/25 bg-amber-300/[0.05] p-4">
            <p className="text-sm font-semibold text-amber-100">Browser-only map version</p>
            <p className="mt-1 text-xs leading-5 text-amber-100/70">
              No cooked CARLA map is bound to this version, so managed CARLA renders will refuse it. Scenarios author
              and render in the browser. To enable managed renders, cook a CARLA map, then publish again with its name
              in the CARLA map name field.
            </p>
          </div>
        ) : null}

        <dl className="space-y-2 text-xs">
          <div>
            <dt className="text-white/35">Map version</dt>
            <dd className="mt-1 break-all rounded-lg bg-black/30 px-3 py-2 font-mono text-white/60">{published.mapVersionId}</dd>
          </div>
          <div>
            <dt className="text-white/35">Closure digest</dt>
            <dd className="mt-1 break-all rounded-lg bg-black/30 px-3 py-2 font-mono text-white/60">{published.closureSha256}</dd>
          </div>
        </dl>
      </div>
    );
  }

  const totalLayerBytes = map?.layers.reduce((total, layer) => total + layer.blob.size, 0) ?? 0;

  return (
    <form id={formId} onSubmit={submit} className="mt-6 space-y-5">
      <label
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          chooseFiles(Array.from(event.dataTransfer.files));
        }}
        className="flex min-h-32 w-full cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed border-white/15 bg-white/[0.025] px-6 text-center transition-colors hover:border-[#E8E044]/40 hover:bg-[#E8E044]/[0.03] focus-within:border-[#E8E044] focus-within:outline-none"
      >
        <input
          type="file"
          multiple
          disabled={busy}
          className="sr-only"
          accept=".xodr,.glb"
          onChange={(event) => chooseFiles(Array.from(event.target.files ?? []))}
        />
        <FileUp className="mb-3 size-6 text-[#E8E044]" aria-hidden="true" />
        <span className="text-sm font-medium">Drop map.xodr and one GLB per layer here</span>
        <span className="mt-1 text-xs text-white/35">
          road.glb is required. Add sidewalk, building, vegetation, terrain, furniture, pole, signage or water as
          separate GLBs — the file name is the layer id.
        </span>
      </label>

      {map && thumbnailUrl ? (
        <>
          <div className="grid gap-5 md:grid-cols-[240px_1fr]">
            <div>
              {/* eslint-disable-next-line @next/next/no-img-element -- client-generated blob: URL for the pre-upload preview */}
              <img
                src={thumbnailUrl}
                alt="Rendered preview of the uploaded map"
                className="aspect-square w-full rounded-xl border border-white/10 bg-[radial-gradient(circle,#27303a,#101317)] object-contain"
              />
              <p className="mt-2 text-xs text-white/40">
                {map.totalTriangles.toLocaleString()} triangles · {formatBytes(totalLayerBytes)} of geometry
              </p>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/35">OpenDRIVE map name</p>
                <p className="mt-1 text-sm text-white/70">{map.mapName}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <StatTile label="Lanes" value={map.preflight.laneCount.toLocaleString()} />
                <StatTile label="Drivable lanes" value={map.preflight.drivableLaneCount.toLocaleString()} />
                <StatTile label="Junctions" value={map.preflight.junctionCount.toLocaleString()} />
                <StatTile
                  label="Georeferenced"
                  value={map.preflight.georeferenced ? "Yes" : "Local coordinates only"}
                />
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-white/35">Plan-view geometry</p>
                <p className="mt-1 text-sm text-white/70">{map.preflight.geometryKinds.join(", ")}</p>
              </div>
            </div>
          </div>

          <div>
            <p className="text-[10px] uppercase tracking-wider text-white/35">
              {map.layers.length === 1 ? "1 layer" : `${map.layers.length} layers`}
            </p>
            <ul className="mt-2 divide-y divide-white/[0.06] rounded-lg border border-white/[0.07]">
              {map.layers.map((layer) => (
                <li key={layer.layerId} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="shrink-0">{layer.layerId}</span>
                  <span className="truncate font-mono text-xs text-white/30">{layer.fileName}</span>
                  <span className="ml-auto shrink-0 tabular-nums text-xs text-white/40">
                    {layer.triangleCount.toLocaleString()} tris · {formatBytes(layer.blob.size)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-xs text-white/45">
          Label
          <Input
            required
            minLength={3}
            maxLength={120}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Downtown New Haven"
            className="mt-1"
          />
        </label>
        <label className="text-xs text-white/45">
          Locality
          <Input
            required
            minLength={2}
            maxLength={120}
            value={locality}
            onChange={(event) => setLocality(event.target.value)}
            placeholder="New Haven, Connecticut"
            className="mt-1"
          />
        </label>
        <div className="sm:col-span-2">
          <label htmlFor={carlaFieldId} className="text-xs text-white/45">CARLA map name, optional</label>
          <Input
            id={carlaFieldId}
            aria-describedby={carlaHelpId}
            maxLength={120}
            value={carlaMapName}
            onChange={(event) => setCarlaMapName(event.target.value)}
            placeholder="Town10HD_Opt"
            className="mt-1"
          />
          <p id={carlaHelpId} className="mt-1.5 text-xs leading-5 text-white/40">
            Fill this in only when a cooked CARLA map of the same road network already exists. Leave it empty and the
            map version is browser-only: you can author and render scenarios in the browser, but managed CARLA renders
            are not available for it.
          </p>
        </div>
      </div>

      {phase === "generating" ? (
        // Not a live region: the dialog's status line already announces the phase, and
        // announcing eight artifact names on top of it is noise, not information.
        <div className="rounded-xl border border-[#E8E044]/20 bg-[#E8E044]/[0.03] p-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#E8E044]">
            Generating on the server
          </p>
          <p className="mt-1.5 text-xs leading-5 text-white/50">
            Your files are stored. The publisher is now building the {SERVER_GENERATED_CLOSURE_PATHS.length} derived
            artifacts the editor loads, and binding them into one immutable map version. This usually takes up to a
            minute — keep this dialog open.
          </p>
          <ul className="mt-3 space-y-1.5">
            {SERVER_GENERATED_CLOSURE_PATHS.map((path) => (
              <li key={path} className="flex items-start gap-2 text-xs leading-5 text-white/50">
                <span aria-hidden="true" className="mt-2 size-1 shrink-0 rounded-full bg-[#E8E044]/60" />
                <span>
                  <span className="font-mono text-white/70">{path}</span> — {GENERATED_ARTIFACT_LABELS[path]}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}
