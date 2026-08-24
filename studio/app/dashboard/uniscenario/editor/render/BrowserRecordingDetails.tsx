"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Download } from "lucide-react";
import { Button } from "@/app/components/ui/button";
import { WorkspacePaneLoading } from "@/app/components/WorkspacePaneLoading";
import { useVisiblePolling } from "@/app/lib/use-visible-polling";
import { getBrowserRecordingClient as getBrowserRecording } from "@/app/lib/uniscenario/recording-client";
import type { BrowserRecordingDetailDto } from "@/app/lib/uniscenario/recording-contracts";

const POLL_INTERVAL_MS = 3_000;


export function BrowserRecordingDetails({
  recordingId,
  onBack,
}: {
  recordingId: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<BrowserRecordingDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getBrowserRecording(recordingId, signal);
      if (!signal?.aborted) {
        setDetail(next);
        setError(null);
      }
    } catch (reason) {
      if (!signal?.aborted) setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [recordingId]);

  useEffect(() => {
    const abort = new AbortController();
    void load(abort.signal);
    return () => abort.abort();
  }, [load]);
  useVisiblePolling(() => load(), POLL_INTERVAL_MS, detail?.status === "running");
  const sensorVideos = detail?.artifacts.filter(
    (artifact) => artifact.role === "sensor_video" && artifact.downloadUrl,
  ) ?? [];


  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="flex items-center gap-2">
        <Button aria-label="Back to render runs" onClick={onBack} size="icon" type="button" variant="ghost">
          <ArrowLeft aria-hidden="true" className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Three.js recording</h3>
          <p className="truncate font-mono text-micro text-muted-foreground">{recordingId}</p>
        </div>
        {detail ? <RecordingStatus status={detail.status} /> : null}
      </div>
      {error ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
      {!detail ? (
        <WorkspacePaneLoading
          className="min-h-72"
          hint="Reading the recording timeline and generated artifacts."
          message="Loading recording details…"
        />
      ) : (
        <>
          {detail.artifacts.find((artifact) => artifact.role === "video" && artifact.downloadUrl) ? (
            <video
              aria-label="Three.js recording preview"
              className="mt-4 aspect-video w-full render-glass border"
              controls
              playsInline
              preload="metadata"
              src={detail.artifacts.find((artifact) => artifact.role === "video" && artifact.downloadUrl)?.downloadUrl ?? undefined}
            />
          ) : null}
          {sensorVideos.length > 0 ? (
            <section className="mt-4" aria-labelledby="active-sensor-videos-heading">
              <div className="flex items-baseline justify-between gap-3">
                <h4 className="text-xs font-semibold uppercase tracking-meta" id="active-sensor-videos-heading">
                  LiDAR and radar views
                </h4>
                <span className="font-mono text-micro text-muted-foreground">
                  {sensorVideos.length} videos
                </span>
              </div>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                {sensorVideos.map((artifact) => (
                  <figure className="render-glass border p-2" key={artifact.artifactId}>
                    <video
                      aria-label={`${artifact.sensor?.modality ?? "Sensor"} visualization for ${artifact.sensor?.sensorId ?? "sensor"}`}
                      className="aspect-video w-full bg-black"
                      controls
                      playsInline
                      preload="metadata"
                      src={artifact.downloadUrl ?? undefined}
                    />
                    <figcaption className="mt-1.5 truncate font-mono text-micro text-muted-foreground">
                      {artifact.sensor?.sensorId} · {artifact.sensor?.modality}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </section>
          ) : null}
          <dl className="mt-4 grid grid-cols-2 gap-3 border-y render-hairline py-3 text-xs">
            <DetailValue label="Phase" value={formatPhase(detail.phase)} />
            <DetailValue label="Progress" value={`${Math.round(detail.progress * 100)}%`} />
            <DetailValue label="Created" value={formatTimestamp(detail.createdAt)} />
            <DetailValue label="Completed" value={detail.completedAt ? formatTimestamp(detail.completedAt) : "—"} />
            <DetailValue label="Revision" value={detail.revisionId} mono />
            <DetailValue label="Request digest" value={detail.requestPayloadSha256} mono />
          </dl>
          {detail.failureCode ? (
            <div className="mt-3 border border-destructive/40 p-3 text-xs text-destructive" role="alert">
              <p className="font-medium">{formatPhase(detail.failureCode)}</p>
              {detail.failureDetail ? <pre className="mt-1 whitespace-pre-wrap text-micro">{JSON.stringify(detail.failureDetail, null, 2)}</pre> : null}
            </div>
          ) : null}
          <section className="mt-4" aria-labelledby="browser-recording-files-heading">
            <h4 className="text-xs font-semibold uppercase tracking-meta" id="browser-recording-files-heading">Files</h4>
            {detail.artifacts.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">Files appear after encoding and checksum verification.</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {detail.artifacts.map((artifact) => (
                  <li className="flex items-center gap-2 render-glass border p-2 text-xs" key={artifact.artifactId}>
                    <span className="min-w-0 flex-1 truncate">
                      {formatPhase(artifact.role)}
                      {artifact.sensor
                        ? ` · ${artifact.sensor.actorId}/${artifact.sensor.sensorId}/${artifact.sensor.modality}`
                        : ""}
                      {" · "}{formatBytes(artifact.sizeBytes)}
                    </span>
                    {artifact.downloadUrl ? (
                      <a aria-label={`Download ${artifact.role}${artifact.sensor ? ` ${artifact.sensor.sensorId} ${artifact.sensor.modality}` : ""}`} className="editor-motion grid size-8 place-items-center render-glass border render-glass-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" download href={artifact.downloadUrl}>
                        <Download aria-hidden="true" className="size-3.5" />
                      </a>
                    ) : <span className="text-micro text-muted-foreground">{artifact.state}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function RecordingStatus({ status }: { status: BrowserRecordingDetailDto["status"] }) {
  return <span className="border render-hairline px-1.5 py-0.5 text-micro uppercase tracking-meta text-muted-foreground">{status}</span>;
}

function DetailValue({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className={mono ? "truncate font-mono text-micro" : "truncate font-medium"}>{value}</dd></div>;
}

function formatPhase(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : value;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
