"use client";

import { useState } from "react";
import { Download, FileText, Film, Image as ImageIcon, Play, ShieldAlert } from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import { Button } from "@/app/components/ui/button";
import { openArtifactUrl, type DisplayArtifact, type PresignedArtifact } from "./api";
import {
  artifactAvailability,
  formatBytes,
  groupArtifacts,
  isImage,
  shortDigest,
} from "./render-view-model";

/**
 * Artifact rows with previews and downloads — manifest #148.
 *
 * Serves two payload shapes. `[jobId]/downloads` arrives already signed; `artifact-index` and
 * `[jobId]/detail` arrive as metadata only, because those routes deliberately never presign. `signed`
 * tells the row which it has, and an unsigned-but-available row gets its URL minted on click through
 * `resolve` rather than up front — which is what keeps browsing a workspace from minting a 3600-second
 * credential per file nobody opened.
 *
 * Every row goes through `artifactAvailability`, which leads on `artifactState`. A `pending` artifact
 * has no complete object and a `quarantined` one failed its checksum, so neither gets a link: they get
 * an explicit state, because a download button that 404s or serves an unverified file is worse than a
 * sentence saying why there is no button.
 */
export function RenderArtifactList({
  artifacts,
  signed = true,
  emptyMessage = "This render has produced no files yet.",
  onPreview,
  resolve,
}: {
  artifacts: readonly DisplayArtifact[];
  /** True when this payload came from `downloads`. False for `artifact-index` / `detail`. */
  signed?: boolean;
  emptyMessage?: string;
  onPreview?: (artifact: PresignedArtifact) => void;
  /** Mint a URL for one unsigned row. Required when `signed` is false. */
  resolve?: (artifact: DisplayArtifact) => Promise<PresignedArtifact | null>;
}) {
  if (artifacts.length === 0) {
    return <p className="px-1 py-6 text-center text-xs text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      {groupArtifacts(artifacts).map((group) => (
        <section className="flex flex-col gap-1" key={group.title}>
          <h4 className="text-micro font-semibold uppercase tracking-meta text-muted-foreground">
            {group.title} · {group.items.length}
          </h4>
          <ul className="render-divide divide-y render-glass border">
            {group.items.map((artifact) => (
              <ArtifactRow
                artifact={artifact}
                key={artifact.id}
                onPreview={onPreview}
                resolve={resolve}
                signed={signed}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ArtifactRow({
  artifact,
  signed,
  onPreview,
  resolve,
}: {
  artifact: DisplayArtifact;
  signed: boolean;
  onPreview?: (artifact: PresignedArtifact) => void;
  resolve?: (artifact: DisplayArtifact) => Promise<PresignedArtifact | null>;
}) {
  const [busy, setBusy] = useState<"preview" | "download" | null>(null);
  const [resolveFailed, setResolveFailed] = useState(false);

  const availability = artifactAvailability(artifact, { signed });
  const Icon = artifact.mediaType.startsWith("video/")
    ? Film
    : isImage(artifact)
      ? ImageIcon
      : artifact.artifactState === "quarantined"
        ? ShieldAlert
        : FileText;
  const openable = availability.kind === "ready" || availability.kind === "resolvable";
  const media = artifact.mediaType.startsWith("video/") || isImage(artifact);
  const displayName = artifact.identity?.actorId
    ? `${artifact.identity.actorId}/${artifact.identity.sensorId} · ${artifact.identity.modality} · ${artifact.identity.role}`
    : artifact.identity?.role ?? artifact.artifactKind;

  /** Signed rows act immediately; unsigned rows mint a URL first, then act on the result. */
  async function act(intent: "preview" | "download") {
    if (availability.kind === "ready") {
      if (intent === "preview") onPreview?.(artifact as PresignedArtifact);
      else openArtifactUrl(availability.url);
      return;
    }
    if (!resolve) return;
    setBusy(intent);
    setResolveFailed(false);
    try {
      const resolved = await resolve(artifact);
      const url = resolved && "url" in resolved ? resolved.url : null;
      // A row that was available at index time can have been cleaned up since. Say so on the row
      // rather than opening a dead tab.
      if (!resolved || !url) {
        setResolveFailed(true);
        return;
      }
      if (intent === "preview") onPreview?.(resolved);
      else openArtifactUrl(url);
    } catch {
      setResolveFailed(true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className="flex items-center gap-3 px-2.5 py-2">
      <Icon
        aria-hidden="true"
        className={
          artifact.artifactState === "quarantined"
            ? "size-4 shrink-0 text-destructive"
            : "size-4 shrink-0 text-muted-foreground"
        }
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-foreground">{displayName}</p>
        <p className="truncate text-micro text-muted-foreground">
          {formatBytes(artifact.byteLength)} · {artifact.mediaType}
          {artifact.relationship ? ` · ${artifact.relationship}` : ""}
          {" · "}
          <span title={artifact.sha256}>{shortDigest(artifact.sha256)}</span>
        </p>
      </div>
      {resolveFailed ? (
        <span className="shrink-0 text-micro uppercase tracking-meta text-destructive">
          No longer in storage
        </span>
      ) : openable && (availability.kind === "ready" || resolve) ? (
        <div className="flex shrink-0 items-center gap-1">
          {media && onPreview ? (
            <Button
              aria-label={`Preview ${displayName}`}
              disabled={busy != null}
              onClick={() => void act("preview")}
              size="icon"
              variant="ghost"
            >
              {busy === "preview" ? (
                <CloudActivityIndicator iconClassName="size-3.5" />
              ) : (
                <Play aria-hidden="true" className="size-3.5" />
              )}
            </Button>
          ) : null}
          <Button
            aria-label={`Download ${displayName}`}
            disabled={busy != null}
            onClick={() => void act("download")}
            size="icon"
            variant="ghost"
          >
            {busy === "download" ? (
              <CloudActivityIndicator iconClassName="size-3.5" />
            ) : (
              <Download aria-hidden="true" className="size-3.5" />
            )}
          </Button>
        </div>
      ) : (
        <span
          className={
            availability.kind === "quarantined"
              ? "shrink-0 text-micro uppercase tracking-meta text-destructive"
              : "shrink-0 text-micro uppercase tracking-meta text-muted-foreground"
          }
          data-artifact-state={artifact.artifactState}
        >
          {availability.message}
        </span>
      )}
    </li>
  );
}
