/**
 * Pure presentation logic for the render, details and artifact tabs.
 *
 * Everything here is a function over plain data, for the same reason
 * `status/notification-model.ts` is: the rules that decide what a state *looks* like — which tone,
 * which verb, whether a progress bar is honest, what a failure code means in English — are the part
 * worth testing, and testing them through a DOM would be testing React instead.
 */

import type {
  ScenarioGalleryItemDto,
  ScenarioPresignedArtifactDto,
  ScenarioRenderArtifactDto,
  ScenarioRenderJobMode,
  ScenarioRenderJobState,
} from "@/app/lib/scenario/render/contracts";

export type RenderStateTone = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type RenderStateVisual = {
  label: string;
  tone: RenderStateTone;
  /** Whether the state is still advancing. Drives polling and the pulse. */
  live: boolean;
};

const STATE_VISUALS: Record<ScenarioRenderJobState, RenderStateVisual> = {
  queued: { label: "Queued", tone: "queued", live: true },
  // `leased` is a control-plane detail: a worker has claimed the job but has not reported a first
  // event. To an author that is indistinguishable from starting, so it does not get its own word.
  leased: { label: "Starting", tone: "running", live: true },
  running: { label: "Running", tone: "running", live: true },
  succeeded: { label: "Done", tone: "succeeded", live: false },
  failed: { label: "Failed", tone: "failed", live: false },
  cancelled: { label: "Cancelled", tone: "cancelled", live: false },
};

export function renderStateVisual(state: ScenarioRenderJobState): RenderStateVisual {
  return STATE_VISUALS[state] ?? { label: state, tone: "queued", live: false };
}

/** Tokenized chip classes per tone. No hex, no white-alpha — parity plan §5.1. */
export function renderStateChipClass(tone: RenderStateTone): string {
  switch (tone) {
    case "running":
      return "bg-primary/20 text-primary";
    case "succeeded":
      return "bg-primary/15 text-primary";
    case "failed":
      return "bg-destructive/20 text-destructive";
    case "cancelled":
      return "bg-muted text-muted-foreground";
    default:
      return "bg-secondary text-secondary-foreground";
  }
}

const JOB_MODE_LABELS: Record<ScenarioRenderJobMode, string> = {
  interaction_2d: "2D interaction",
  full_render: "CARLA render",
  browser_render: "Browser render",
  cosmos_augment: "Cosmos augment",
  vlm_annotate: "VLM annotate",
};

export function jobModeLabel(mode: ScenarioRenderJobMode): string {
  return JOB_MODE_LABELS[mode] ?? mode;
}

/** Which gallery filter tag a managed job belongs to. */
export function jobModeTag(mode: ScenarioRenderJobMode): "carla" | "browser" {
  return mode === "browser_render" ? "browser" : "carla";
}

export function isPostprocessMode(
  mode: ScenarioRenderJobMode,
): mode is "cosmos_augment" | "vlm_annotate" {
  return mode === "cosmos_augment" || mode === "vlm_annotate";
}

/**
 * The width of the progress bar, and whether to announce a number at all.
 *
 * `progressPercent` is null wherever the worker has not reported one, which is most of a queued job's
 * life. A bar at 0 reads as "stuck at zero" and a bar with no `aria-valuenow` reads as broken, so an
 * unreported progress is an indeterminate bar with no value — not a zero.
 *
 * A reported 0 keeps a 4% sliver so a just-started job shows something, while the *announced* value
 * stays honest. Same trick, and same reason, as `states/ScenarioJobDetails.tsx`.
 */
export function renderProgressBar(item: {
  jobState: ScenarioRenderJobState;
  progressPercent: number | null;
}): { indeterminate: boolean; percent: number | null; widthPercent: number } {
  const visual = renderStateVisual(item.jobState);
  if (item.jobState === "succeeded") return { indeterminate: false, percent: 100, widthPercent: 100 };
  if (!visual.live) return { indeterminate: false, percent: null, widthPercent: 0 };
  if (item.progressPercent == null) return { indeterminate: true, percent: null, widthPercent: 0 };
  const percent = Math.max(0, Math.min(100, Math.round(item.progressPercent)));
  return { indeterminate: false, percent, widthPercent: Math.max(4, percent) };
}

/** True when at least one job is still advancing, so the surface should keep polling. */
export function hasLiveJob(items: readonly { jobState: ScenarioRenderJobState }[]): boolean {
  return items.some((item) => renderStateVisual(item.jobState).live);
}

/**
 * Plain English for the control plane's failure codes.
 *
 * `failure_detail` is a JSON blob written by a worker and is shown separately, verbatim, in the
 * details tab. This is the one-line version an author reads first, and it exists because
 * `lease_expired` and `parity_threshold_failed` mean nothing to someone who did not write the
 * scheduler. An unmapped code falls back to a humanized form rather than being hidden — a code we
 * have no copy for is still the most useful thing on screen.
 */
const FAILURE_MESSAGES: Record<string, string> = {
  lease_expired: "The render worker stopped reporting and its lease expired.",
  parity_threshold_failed: "The render finished but missed its 2D parity thresholds.",
  cancelled_by_request: "This render was cancelled.",
  worker_error: "The render worker reported an error.",
  compile_failed: "The scenario could not be compiled for this render.",
  upload_failed: "The render finished but its output could not be uploaded.",
};

export function failureMessage(code: string | null): string | null {
  if (!code) return null;
  return FAILURE_MESSAGES[code] ?? humanizeCode(code);
}

export function humanizeCode(code: string): string {
  const words = code.replace(/[_-]+/g, " ").trim();
  if (!words) return code;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What an artifact can do right now.
 *
 * `pending` has no complete object behind it and `quarantined` failed checksum verification, so
 * neither may be offered as a link — the route already returns `url: null` for both. `available` with
 * a null url means the object was cleaned up between the metadata read and the signing call; that is
 * a downgrade, not an error, and it gets its own message so it is not mistaken for "still uploading".
 */
export type ArtifactAvailability =
  | { kind: "ready"; url: string }
  /** Available, but this payload was not signed. The caller signs on demand via `downloads`. */
  | { kind: "resolvable"; message: string }
  | { kind: "pending"; message: string }
  | { kind: "quarantined"; message: string }
  | { kind: "deleted"; message: string }
  | { kind: "unavailable"; message: string };

/**
 * `signed` says whether this payload came from a route that mints URLs.
 *
 * It has to be told, because `url: null` is ambiguous on its own: from `downloads` it means the object
 * vanished between the metadata read and the signing call, while from `artifact-index` or `detail` it
 * means nothing at all — those routes never sign. Guessing from url presence would report every
 * browsable artifact in the workspace as missing from storage.
 *
 * The `switch` leads on `artifactState` for the same reason the route contract requires it: a state
 * added later must fall through to "not ready", not to an error or a broken link.
 */
export function artifactAvailability(
  artifact: Pick<ScenarioRenderArtifactDto, "artifactState"> & { url?: string | null },
  options: { signed?: boolean } = {},
): ArtifactAvailability {
  const signed = options.signed ?? true;
  switch (artifact.artifactState) {
    case "available":
      if (artifact.url) return { kind: "ready", url: artifact.url };
      return signed
        ? { kind: "unavailable", message: "This file is no longer in storage." }
        : { kind: "resolvable", message: "Ready" };
    case "pending":
      return { kind: "pending", message: "Still uploading." };
    case "quarantined":
      return { kind: "quarantined", message: "Failed checksum verification." };
    case "deleted":
      return { kind: "deleted", message: "Deleted." };
    default:
      return { kind: "unavailable", message: humanizeCode(artifact.artifactState) };
  }
}

/** True where the artifact is a video we can put in a `<video>` element. */
export function isPlayableVideo(
  artifact: Pick<ScenarioRenderArtifactDto, "mediaType" | "artifactState"> & {
    url?: string | null;
  },
): boolean {
  return (
    artifact.mediaType.startsWith("video/")
    && artifactAvailability(artifact).kind === "ready"
  );
}

export function isImage(artifact: Pick<ScenarioRenderArtifactDto, "mediaType">): boolean {
  return artifact.mediaType.startsWith("image/");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // `noUncheckedIndexedAccess` makes this possibly-undefined; the loop bound guarantees it is not.
  const unit = units[unitIndex] ?? "TB";
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${unit}`;
}

/** Short digest for a provenance row. Full value stays in the `title`, never truncated in the DOM. */
export function shortDigest(value: string | null): string {
  if (!value) return "—";
  return value.length <= 16 ? value : `${value.slice(0, 12)}…${value.slice(-4)}`;
}

export function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatElapsed(fromIso: string | null, toIso: string | null): string {
  if (!fromIso) return "—";
  const from = new Date(fromIso).getTime();
  const to = toIso ? new Date(toIso).getTime() : Date.now();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return "—";
  const seconds = Math.round((to - from) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * The managed pipeline's linear stages, in the order the control plane emits them.
 *
 * Only the kinds that happen once and mean "we got this far". `progress` is excluded because it
 * repeats and carries the percentage instead; `retry_queued`, `failed` and `cancelled` are outcomes
 * rather than steps. Both are shown, just not as rungs on this ladder.
 */
export const RENDER_PIPELINE_STAGES: readonly { kind: string; label: string; hint: string }[] = [
  { kind: "accepted", label: "Accepted", hint: "The control plane took the request" },
  { kind: "assets_validated", label: "Assets checked", hint: "Map and actor assets resolved" },
  { kind: "plan_compiled", label: "Plan compiled", hint: "The frozen scenario became a run plan" },
  { kind: "render_started", label: "Rendering", hint: "A worker is producing frames" },
  { kind: "artifact_uploaded", label: "Artifacts uploaded", hint: "Output is landing in storage" },
  { kind: "completed", label: "Completed", hint: "Every artifact is verified" },
];

export type RenderStageState = "done" | "active" | "pending" | "stopped";

/**
 * Which pipeline stages a job has reached, from its real event stream.
 *
 * The point is to answer "is anything happening" without inventing anything. A stage is `done` only
 * when an event says so, and it carries that event's own timestamp.
 *
 * Progress along the ladder is monotonic, so `active` — the one thing being waited on — is the first
 * unreported stage *after the furthest one reached*, not the first unreported stage overall. A job
 * that reported `render_started` without `plan_compiled` has plainly passed the plan, and pointing
 * at it as the current step would send the author looking for a problem that is behind them. An
 * earlier gap like that is left `stopped`: no event said it happened, and nothing is waiting on it.
 *
 * Once the job stops moving, everything unreported is `stopped` rather than left looking imminent.
 */
export function renderPipelineStages(
  events: readonly { eventKind: string; createdAt: string }[],
  jobState: ScenarioRenderJobState,
): { kind: string; label: string; hint: string; at: string | null; state: RenderStageState }[] {
  const live = renderStateVisual(jobState).live;
  const reached = RENDER_PIPELINE_STAGES.map((stage) =>
    events.find((candidate) => candidate.eventKind === stage.kind) ?? null);
  const furthest = reached.reduce((last, event, index) => (event ? index : last), -1);
  const activeIndex = live
    ? reached.findIndex((event, index) => event === null && index > furthest)
    : -1;
  return RENDER_PIPELINE_STAGES.map((stage, index) => {
    const event = reached[index];
    if (event) return { ...stage, at: event.createdAt, state: "done" as const };
    if (index === activeIndex) return { ...stage, at: null, state: "active" as const };
    if (!live || index < furthest) return { ...stage, at: null, state: "stopped" as const };
    return { ...stage, at: null, state: "pending" as const };
  });
}

/** The newest event, by ordinal rather than array order. Drives the "last heard from" line. */
export function latestRenderEvent<T extends { eventOrdinal: number }>(
  events: readonly T[],
): T | null {
  return events.reduce<T | null>(
    (newest, event) => (newest === null || event.eventOrdinal > newest.eventOrdinal ? event : newest),
    null,
  );
}

export function formatCostCents(cents: number): string {
  if (!Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Group artifacts for display: videos first, then images, then everything else, each alphabetical by
 * kind. Videos lead because that is what an author opened the tab for; the rest is evidence.
 */
export function groupArtifacts<T extends ScenarioRenderArtifactDto & { url?: string | null }>(
  artifacts: readonly T[],
): { title: string; items: T[] }[] {
  const videos: T[] = [];
  const images: T[] = [];
  const others: T[] = [];
  for (const artifact of artifacts) {
    if (artifact.mediaType.startsWith("video/")) videos.push(artifact);
    else if (isImage(artifact)) images.push(artifact);
    else others.push(artifact);
  }
  const byKind = (left: T, right: T) => left.artifactKind.localeCompare(right.artifactKind);
  return [
    { title: "Videos", items: videos.sort(byKind) },
    { title: "Images", items: images.sort(byKind) },
    { title: "Files", items: others.sort(byKind) },
  ].filter((group) => group.items.length > 0);
}

/**
 * The accessible name for a gallery tile.
 *
 * A tile is a picture, a chip and two numbers; without this it announces as an unlabelled button.
 * The state and the failure reason are both in the name because that is what decides whether the
 * author opens it.
 */
export function galleryItemAccessibleName(item: ScenarioGalleryItemDto): string {
  const visual = renderStateVisual(item.jobState);
  const parts = [
    jobModeLabel(item.jobMode),
    formatTimestamp(item.createdAt),
    visual.label,
    item.artifactCount === 1 ? "1 artifact" : `${item.artifactCount} artifacts`,
  ];
  const failure = failureMessage(item.failureCode);
  if (failure) parts.push(failure);
  return parts.join(", ");
}

/**
 * A stable idempotency key for a postprocess submission.
 *
 * Keyed on what the run *is* — parent, source artifact, mode, model, config — rather than on a
 * random value or a clock, so a double-click, a retried fetch and a reloaded tab all resolve to the
 * same job instead of queueing three. `createPostprocessJob` returns `created: false` for the
 * repeats.
 */
export function postprocessIdempotencyKey(input: {
  parentRenderJobId: string;
  sourceArtifactId: string;
  jobMode: string;
  modelFamily: string;
  modelConfig: Record<string, unknown>;
}): string {
  const config = JSON.stringify(input.modelConfig, Object.keys(input.modelConfig).sort());
  return [
    "pp",
    input.jobMode,
    input.parentRenderJobId,
    input.sourceArtifactId,
    input.modelFamily.trim(),
    fnv1a32(config),
  ].join(":");
}

/**
 * A short, stable hash for the idempotency key's config component.
 *
 * FNV-1a rather than SHA-256 because `crypto.subtle.digest` is async and this is called inside a
 * render path. The server hashes the config properly into `model_config_sha256`; this only has to
 * distinguish two configs the same user submits, where a 32-bit space is ample.
 */
function fnv1a32(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Artifacts a postprocess run can be fed: an available video output of the parent render. */
export function postprocessSourceCandidates(
  artifacts: readonly ScenarioPresignedArtifactDto[] | readonly (ScenarioRenderArtifactDto & {
    url: string | null;
  })[],
): (ScenarioRenderArtifactDto & { url: string | null })[] {
  return artifacts.filter(
    (artifact): artifact is ScenarioRenderArtifactDto & { url: string | null } =>
      artifact.artifactState === "available" && artifact.mediaType.startsWith("video/"),
  );
}
