"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Camera,
  Clock,
  FlaskConical,
  MonitorPlay,
  Server,
  Sparkles,
} from "lucide-react";
import { CloudActivityIndicator } from "@/app/components/CloudLoadingSurface";
import {
  type ActorSensor,
  type RenderModality,
  type ScenarioTemplateV2,
} from "@uniscenarios/scenario-model";
import { cn } from "@/app/lib/utils";
import {
  RenderOptionCard,
  RenderWizardBody,
  RenderWizardFooter,
  RenderWizardStepRail,
  type RenderWizardStep,
} from "./RenderWizardChrome";
import { formatElapsed } from "./render-view-model";
import {
  createValidationRun,
  fetchOpenScenarioExport,
  listOpenScenarioExports,
  prepareOpenScenarioExport,
  submitRenderIntent,
} from "./api";
import {
  authoredRenderSensors,
  buildCanonicalRenderSpec,
  defaultModalities,
  renderModalityLabel,
  sensorKey,
  supportedModalities,
  type AuthoredRenderSensor,
} from "./render-spec-v3";
type RenderBackend = "browser" | "carla" | "esmini";

const ESMINI_VALIDATOR_VERSION = "3.6.0";

/** RTX 5080 admission profile: all 18 Pronto sources at once, costed by modality. */
const MANAGED_MAX_SENSORS = 18;
const MANAGED_MAX_ESTIMATED_GPU_BYTES = 15_000 * 1024 * 1024;
const CARLA_RESOLUTIONS = [
  { width: 1280, height: 720, label: "720p" },
] as const;
const CARLA_FPS_OPTIONS = [24] as const;
const CARLA_QUALITIES = ["preview", "standard", "high", "cinematic"] as const;
const EXPORT_POLL_MS = 1_000;
/**
 * How long an export may sit queued with no attempt before the wait is called off.
 *
 * A `running` export is progressing and gets as long as it needs. One nothing has claimed is a
 * different situation, and the previous unbounded loop made a deployment with no compiler worker
 * indistinguishable from a slow one — it waited for the life of the tab behind one static label.
 */
const EXPORT_CLAIM_TIMEOUT_MS = 120_000;

/**
 * Where UniScenarios executes the immutable render intent.
 *
 * Both renderers are registered GPU workers. The tab only submits and observes the durable job;
 * closing it cannot interrupt execution.
 */
const ENGINE_OPTIONS: {
  id: RenderBackend;
  label: string;
  icon: typeof MonitorPlay;
  hint: string;
}[] = [
  {
    id: "browser",
    label: "Browser",
    icon: MonitorPlay,
    hint: "Optimized Three.js renderer on a registered GPU worker.",
  },
  {
    id: "carla",
    label: "CARLA",
    icon: Server,
    hint: "CARLA-native render on a registered GPU worker.",
  },
  {
    id: "esmini",
    label: "esmini",
    icon: FlaskConical,
    hint: "Headless cross-engine replay. State trace and validation report, no imagery.",
  },
];


const SENSOR_KINDS: {
  id: RenderModality;
  label: string;
  hint: string;
}[] = [
  { id: "rgb", label: "RGB", hint: "Color video and image frames" },
  { id: "depth", label: "Depth", hint: "Metric depth image frames" },
  { id: "semantic", label: "Semantic", hint: "Semantic segmentation" },
  { id: "instance", label: "Instance", hint: "Instance segmentation" },
  { id: "lidar", label: "LiDAR", hint: "Point-cloud captures" },
  { id: "radar", label: "Radar", hint: "Range, angle and radial-velocity captures" },
];

const OUTPUT_OPTIONS: { id: "video" | "frames" | "annotations"; label: string; hint: string }[] = [
  { id: "video", label: "Videos", hint: "MP4 from the first RGB sensor" },
  { id: "frames", label: "Sensor data", hint: "Archive per requested sensor" },
  { id: "annotations", label: "Annotations", hint: "Frame-aligned NDJSON" },
];

const ENGINE_STEP: RenderWizardStep = { id: "engine", label: "Engine" };
const CAMERA_STEP: RenderWizardStep = { id: "cameras", label: "Cameras" };
const OUTPUT_STEP: RenderWizardStep = { id: "output", label: "Output" };
const REVIEW_STEP: RenderWizardStep = { id: "review", label: "Review" };

/**
 * The steps each engine actually has decisions for.
 *
 * esmini has none: it replays the frozen export at a pinned timestep with no cameras and no
 * format, so offering it a sensor step would be offering a choice that changes nothing.
 */
const STEPS_BY_ENGINE: Record<RenderBackend, readonly RenderWizardStep[]> = {
  browser: [ENGINE_STEP, CAMERA_STEP, OUTPUT_STEP, REVIEW_STEP],
  carla: [ENGINE_STEP, CAMERA_STEP, OUTPUT_STEP, REVIEW_STEP],
  esmini: [ENGINE_STEP, REVIEW_STEP],
};

const managedSensorOptions = authoredRenderSensors;

function sensorOptionKey(option: AuthoredRenderSensor) {
  return sensorKey(option.actorId, option.sensor.id);
}

function sensorLabel(sensor: ActorSensor) {
  if (sensor.label?.trim()) return sensor.label;
  if (sensor.type === "dash_camera") return "Dash camera";
  if (sensor.type === "lidar") return "LiDAR";
  return "Radar";
}

function sensorDetail(option: AuthoredRenderSensor) {
  const fov = option.sensor.type === "dash_camera"
    ? option.sensor.camera.horizontalFovDeg
    : option.sensor.field.horizontalFovDeg;
  return `${option.actorLabel} · ${option.sensor.type.replace("_", " ")} · ${Math.round(fov)}° FOV`;
}

const IMAGE_MODALITIES: readonly RenderModality[] = ["rgb", "depth", "semantic", "instance"];

function sourceGpuBytes(option: AuthoredRenderSensor, modalities: readonly RenderModality[], width: number, height: number) {
  return modalities.reduce((total, modality) => {
    if (IMAGE_MODALITIES.includes(modality)) {
      const bytesPerPixel = modality === "rgb" ? 4 : 8;
      return total + width * height * bytesPerPixel * 3;
    }
    if (modality === "lidar") return total + 256 * 1024 * 1024;
    if (modality === "radar") return total + 64 * 1024 * 1024;
    return total;
  }, 0);
}

function budgetedSensorKeys(
  options: readonly AuthoredRenderSensor[],
  kinds: readonly RenderModality[],
  budget: { maxSensors: number; maxGpuBytes: number; width: number; height: number },
): string[] {
  const keys: string[] = [];
  let requested = 0;
  let gpuBytes = 0;
  for (const option of options) {
    const modalities = supportedModalities(option.sensor).filter((modality) => kinds.includes(modality));
    if (modalities.length === 0) continue;
    const cost = sourceGpuBytes(option, modalities, budget.width, budget.height);
    if (requested + modalities.length > budget.maxSensors || gpuBytes + cost > budget.maxGpuBytes) continue;
    requested += modalities.length;
    gpuBytes += cost;
    keys.push(sensorOptionKey(option));
  }
  return keys;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function StepHeading({ title, hint, aside }: { title: string; hint?: string; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex shrink-0 items-start justify-between gap-4">
      <div className="min-w-0">
        <h3 className="text-sm font-bold tracking-tight text-foreground">{title}</h3>
        {hint ? <p className="mt-0.5 text-micro text-muted-foreground">{hint}</p> : null}
      </div>
      {aside ? (
        <span className="shrink-0 text-micro uppercase tracking-meta text-muted-foreground">{aside}</span>
      ) : null}
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b render-hairline py-1.5 last:border-b-0">
      <dt className="text-micro uppercase tracking-meta text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-xs font-semibold text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The "New render" view authors one canonical render-spec/v3 across browser and managed targets.
 *
 * It is a short wizard rather than one form. Every control used to be on screen at once — engine,
 * sensors, kinds, clip, outputs, resolution, FPS, quality, preflight, submit — inside a scrolling
 * column, which made the cheapest possible render (this browser, the cameras already mounted)
 * indistinguishable in effort from the most expensive one. The steps are Engine, Cameras, Output,
 * Review; esmini skips the two it has no decisions for.
 *
 * Physical sensors, modalities, clip and artifacts remain explicit author controls. Both renderer
 * engines receive the byte-identical render-spec/v3 inside one immutable render intent. The
 * renderer choice is an admission constraint, not a backend-specific lowering.
 */
export function RenderConfigPanel({
  ensureSnapshot,
  currentContent,
  onClose,
  onManagedJobCreated,
  onEsminiRunCreated,
}: {
  /**
   * Freezes the open draft into an immutable snapshot and resolves its id. Called once a submit
   * begins, never on open: configuring a render must not write.
   */
  ensureSnapshot: (signal?: AbortSignal) => Promise<string>;
  currentContent: ScenarioTemplateV2 | null;
  onClose: () => void;
  onManagedJobCreated: (jobId: string) => void;
  onEsminiRunCreated: () => void;
}) {
  const [backend, setBackend] = useState<RenderBackend>("browser");
  const [stepIndex, setStepIndex] = useState(0);
  const sensorOptions = useMemo(
    () => managedSensorOptions(currentContent),
    [currentContent],
  );
  const [selectedSensorKeys, setSelectedSensorKeys] = useState<string[]>([]);
  const [modalitiesBySensor, setModalitiesBySensor] = useState<Record<string, RenderModality[]>>({});
  const [kinds, setKinds] = useState<RenderModality[]>(["rgb", "lidar", "radar"]);
  const [resolutionIndex, setResolutionIndex] = useState(0);
  const [fps, setFps] = useState<(typeof CARLA_FPS_OPTIONS)[number]>(24);
  const [quality, setQuality] = useState<(typeof CARLA_QUALITIES)[number]>("standard");
  const [outputs, setOutputs] = useState<("video" | "frames" | "annotations")[]>(["video", "annotations"]);
  const [stage, setStage] = useState<null | "package" | "submit">(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /** What the export queue is doing while `stage === "package"`. Null when nothing is waiting. */
  const [packageWait, setPackageWait] = useState<
    null | { exportId: string; status: string; claimed: boolean; startedAtMs: number }
  >(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (stage === null) return;
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [stage]);

  const steps = STEPS_BY_ENGINE[backend];
  const step = steps[Math.min(stepIndex, steps.length - 1)] ?? ENGINE_STEP;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const clipSeconds = currentContent?.choreography.clipSeconds ?? 20;
  useEffect(() => {
    setSelectedSensorKeys((current) => {
      const available = new Set(sensorOptions.map(sensorOptionKey));
      const kept = current.filter((key) => available.has(key));
      if (kept.length > 0) return kept;
      const opening = CARLA_RESOLUTIONS[0];
      return budgetedSensorKeys(sensorOptions, ["rgb", "lidar", "radar"], {
        maxSensors: MANAGED_MAX_SENSORS,
        maxGpuBytes: MANAGED_MAX_ESTIMATED_GPU_BYTES,
        width: opening.width,
        height: opening.height,
      });
    });
  }, [sensorOptions]);

  useEffect(() => {
    setModalitiesBySensor((current) => Object.fromEntries(sensorOptions.map((option) => {
      const key = sensorOptionKey(option);
      const supported = new Set(supportedModalities(option.sensor));
      const preserved = current[key]?.filter((modality) => supported.has(modality));
      return [key, preserved && preserved.length > 0 ? preserved : [...defaultModalities(option.sensor)]];
    })));
  }, [sensorOptions]);

  const selectedSensors = useMemo(() => {
    const selected = new Set(selectedSensorKeys);
    return sensorOptions.filter((option) => selected.has(sensorOptionKey(option)));
  }, [selectedSensorKeys, sensorOptions]);
  const resolution = CARLA_RESOLUTIONS[resolutionIndex] ?? CARLA_RESOLUTIONS[0]!;
  const selectedModalities = useMemo(
    () => selectedSensors.map((option) => ({
      actorId: option.actorId,
      sensorId: option.sensor.id,
      modalities: (modalitiesBySensor[sensorOptionKey(option)] ?? []).filter(
        (modality) => supportedModalities(option.sensor).includes(modality),
      ),
    })).filter((selection) => selection.modalities.length > 0),
    [modalitiesBySensor, selectedSensors],
  );
  const sensorHostAssets = useMemo(() => {
    if (!currentContent) return [];
    const selectedActors = new Set(selectedSensors.map((option) => option.actorId));
    return [...new Set(
      currentContent.roles
        .filter((role) => selectedActors.has(role.id))
        .map((role) => role.actor.catalogId),
    )];
  }, [currentContent, selectedSensors]);
  const selectedKinds = [...new Set(selectedModalities.flatMap((selection) => selection.modalities))];
  const selectedHostActorCount = new Set(selectedSensors.map((option) => option.actorId)).size;
  const sensorCount = selectedModalities.reduce((total, selection) => total + selection.modalities.length, 0);
  const estimatedGpuBytes = selectedSensors.reduce((total, option) => {
    const selection = selectedModalities.find(
      (candidate) => candidate.actorId === option.actorId && candidate.sensorId === option.sensor.id,
    );
    return total + sourceGpuBytes(option, selection?.modalities ?? [], resolution.width, resolution.height);
  }, 0);

  const issues = useMemo(() => {
    const list: string[] = [];
    if (sensorOptions.length === 0) {
      list.push(backend === "carla" ? "Add the Pronto sensor rig before rendering." : "Add a camera or sensor before rendering.");
    } else if (selectedSensors.length === 0) {
      list.push("Select at least one sensor.");
    } else if (selectedModalities.length !== selectedSensors.length) {
      list.push("Every selected sensor needs at least one modality.");
    }
    if (selectedSensors.length > MANAGED_MAX_SENSORS) {
      list.push(
        `The RTX 5080 worker accepts at most ${MANAGED_MAX_SENSORS} simultaneous physical sensors; this request has ${selectedSensors.length}.`,
      );
    }
    if (
      backend === "carla"
      && (
        selectedHostActorCount !== 1
        || sensorHostAssets.length !== 1
        || sensorHostAssets[0] !== "vehicle.kia.carnival"
      )
    ) {
      list.push("The Pronto sensor rig must attach to the Kia Carnival asset (vehicle.kia.carnival).");
    }
    if (backend === "browser" && selectedHostActorCount !== 1) {
      list.push("Browser renders capture sensors from one vehicle at a time.");
    }
    if (estimatedGpuBytes > MANAGED_MAX_ESTIMATED_GPU_BYTES) {
      list.push("This modality mix exceeds the RTX 5080 memory profile. Lower the modality count.");
    }
    if (
      outputs.includes("video")
      && !selectedModalities.some((selection) => selection.modalities.includes("rgb"))
    ) {
      list.push("Video output requires an RGB modality.");
    }
    if (outputs.length === 0) list.push("Enable at least one output.");
    return list;
  }, [
    backend,
    estimatedGpuBytes,
    outputs,
    selectedHostActorCount,
    selectedModalities,
    selectedSensors.length,
    sensorHostAssets,
    sensorOptions.length,
  ]);

  const submitDisabled = stage != null || issues.length > 0;

  function selectBackend(next: RenderBackend) {
    setBackend(next);
    setSubmitError(null);
    setStepIndex(0);
  }

  function toggleSensor(key: string, enabled: boolean) {
    setSelectedSensorKeys((current) => {
      const next = new Set(current);
      if (enabled) next.add(key);
      else next.delete(key);
      return sensorOptions.map(sensorOptionKey).filter((candidate) => next.has(candidate));
    });
  }

  function toggleKind(kind: RenderModality) {
    const enabling = !kinds.includes(kind);
    setKinds((current) => enabling
      ? [...current, kind]
      : current.filter((candidate) => candidate !== kind));
    setModalitiesBySensor((current) => Object.fromEntries(sensorOptions.map((option) => {
      const key = sensorOptionKey(option);
      const supported = supportedModalities(option.sensor);
      const values = current[key] ?? [...defaultModalities(option.sensor)];
      if (!supported.includes(kind)) return [key, values];
      return [key, enabling
        ? [...new Set([...values, kind])]
        : values.filter((candidate) => candidate !== kind)];
    })));
  }

  function toggleSensorModality(key: string, modality: RenderModality) {
    setModalitiesBySensor((current) => {
      const values = current[key] ?? [];
      return {
        ...current,
        [key]: values.includes(modality)
          ? values.filter((candidate) => candidate !== modality)
          : [...values, modality],
      };
    });
  }

  function toggleOutput(id: "video" | "frames" | "annotations") {
    setOutputs((current) =>
      current.includes(id) ? current.filter((candidate) => candidate !== id) : [...current, id],
    );
  }

  /**
   * Freeze the scenario, then make sure that snapshot has an execution package.
   *
   * The snapshot is taken here rather than when the pane opened: this is the first moment the
   * scenario has to be immutable, because it is what the worker executes and what the author can
   * later restore. `ensureSnapshot` is idempotent per draft version.
   */
  async function ensureExecutionPackage(): Promise<{
    revisionId: string;
    executionPackageId: string;
  }> {
    const revisionId = await ensureSnapshot();
    // Reconcile by immutable revision before creating anything — survives reloads and lost POSTs.
    const existing = await listOpenScenarioExports(revisionId);
    let record =
      existing.find((candidate) => candidate.status === "succeeded" && candidate.executionPackageId)
      ?? existing.find((candidate) => candidate.status === "queued" || candidate.status === "running")
      ?? null;
    record ??= await prepareOpenScenarioExport(
      revisionId,
      `render-tab-export:${revisionId}:${crypto.randomUUID()}`,
    );
    const waitStartedMs = Date.now();
    let unclaimedSinceMs: number | null = null;
    while (record.status === "queued" || record.status === "running") {
      // The author sees this while it happens. Waiting behind a static label is how a compiler
      // outage looks identical to a compiler working, which is the whole complaint.
      setPackageWait({
        exportId: record.id,
        status: record.status,
        claimed: record.startedAt !== null,
        startedAtMs: waitStartedMs,
      });
      // A `running` export is progressing and gets as long as it needs. One still queued with no
      // `startedAt` has not been claimed at all, and more waiting will not change that: on a
      // deployment with no compiler worker this loop otherwise spins for the life of the tab.
      const unclaimed = record.status === "queued" && record.startedAt === null;
      unclaimedSinceMs = unclaimed ? unclaimedSinceMs ?? Date.now() : null;
      if (unclaimedSinceMs !== null && Date.now() - unclaimedSinceMs > EXPORT_CLAIM_TIMEOUT_MS) {
        throw new Error(
          "No OpenSCENARIO compiler picked this export up — it is still queued, unclaimed. The "
          + "render cannot be submitted until a compiler worker is running.",
        );
      }
      await delay(EXPORT_POLL_MS);
      record = await fetchOpenScenarioExport(record.id);
    }
    if (record.status !== "succeeded" || !record.executionPackageId) {
      throw new Error(record.errorCode ?? "The OpenSCENARIO export did not produce an execution package.");
    }
    return { revisionId, executionPackageId: record.executionPackageId };
  }

  async function submitGpuRender() {
    if (stage != null || backend === "esmini") return;
    setSubmitError(null);
    setStage("package");
    try {
      if (!currentContent) throw new Error("The scenario is not ready to render.");
      const renderSpec = buildCanonicalRenderSpec({
        content: currentContent,
        selections: selectedModalities,
        clip: { startSeconds: 0, endSeconds: clipSeconds },
        video: outputs.includes("video") ? {
          width: resolution.width,
          height: resolution.height,
          fps,
          container: "webm",
          codec: "vp9",
          quality: quality === "preview" ? "draft" : quality === "cinematic" ? "high" : quality,
        } : null,
        artifacts: [...new Set([
          ...outputs,
          "sensorArchive" as const,
          "trace" as const,
          "manifest" as const,
        ])],
        staticSemantics: false,
        fidelity: "dataset",
      });
      const { revisionId, executionPackageId } = await ensureExecutionPackage();
      setStage("submit");
      const job = await submitRenderIntent({
        schema: "uniscenario.render-intent-submission/v1",
        engine: backend,
        revisionId,
        executionPackageId,
        renderSpec,
        idempotencyKey: `render-intent:${revisionId}:${crypto.randomUUID()}`,
      });
      onManagedJobCreated(job.id);
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "The render could not be submitted.");
    } finally {
      setStage(null);
      setPackageWait(null);
    }
  }

  async function submitEsminiRun() {
    if (stage != null) return;
    setSubmitError(null);
    setStage("package");
    try {
      // The esmini validator executes the same frozen execution package the CARLA path renders, so
      // the export must exist before the run is queued — the CPU claim gates on a succeeded export.
      const { revisionId } = await ensureExecutionPackage();
      setStage("submit");
      await createValidationRun({
        revisionId,
        validatorKind: "esmini",
        validatorVersion: ESMINI_VALIDATOR_VERSION,
        idempotencyKey: `esmini:${revisionId}:${crypto.randomUUID()}`,
      });
      onEsminiRunCreated();
    } catch (cause) {
      setSubmitError(cause instanceof Error ? cause.message : "The esmini run could not be submitted.");
    } finally {
      setStage(null);
      setPackageWait(null);
    }
  }

  const engineOption = ENGINE_OPTIONS.find((option) => option.id === backend)!;

  return (
    <section
      aria-label="New render configuration"
      className="render-view-enter flex min-h-0 flex-1 flex-col overflow-hidden"
      data-render-engine={backend}
      data-render-step={step.id}
      data-testid="render-config-panel"
    >
      <header className="relative flex shrink-0 items-center justify-between gap-4 border-b render-hairline px-6 py-3">
        <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-primary/70 via-primary/15 to-transparent" />
        <div className="flex min-w-0 items-center gap-3">
          <button
            aria-label="Back to the render gallery"
            className="editor-motion grid size-8 shrink-0 place-items-center border render-hairline render-glass text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="render-config-back"
            onClick={onClose}
            type="button"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
          </button>
          <div className="min-w-0">
            <p className="font-mono text-micro font-bold uppercase tracking-meta text-primary/90">New render</p>
            <h2 className="text-base font-extrabold leading-tight tracking-tight text-foreground">
              {engineOption.label}
            </h2>
          </div>
        </div>
        <RenderWizardStepRail
          activeIndex={steps.indexOf(step)}
          onSelect={setStepIndex}
          steps={steps}
        />
      </header>

      {step.id === "engine" ? (
        <>
          <RenderWizardBody>
            <StepHeading
              hint="Both renderers run on registered GPU workers. You can close this tab after submission."
              title="How should this scenario be rendered?"
            />
            <div aria-label="Render engine" className="grid gap-2 sm:grid-cols-3" role="radiogroup">
              {ENGINE_OPTIONS.map((option) => (
                <RenderOptionCard
                  hint={option.hint}
                  icon={option.icon}
                  key={option.id}
                  label={option.label}
                  onClick={() => selectBackend(option.id)}
                  selected={backend === option.id}
                  selection="single"
                  testId={`render-backend-${option.id}`}
                />
              ))}
            </div>
            {backend !== "esmini" ? (
              <p className="mt-5 border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
                UniScenarios owns execution; SimCloud persists the immutable intent, lease and progress.
              </p>
            ) : null}
          </RenderWizardBody>
          <RenderWizardFooter
            note={backend === "esmini"
              ? "Runs on the CPU job fleet — no GPU worker required."
              : `${clipSeconds}s frozen scenario · registered ${backend} GPU lane`}
            onNext={() => setStepIndex(1)}
          />
        </>
      ) : backend === "esmini" ? (
        <>
          <RenderWizardBody>
            <StepHeading
              hint={`Fixed 0.02 s timestep, pinned seed, esmini ${ESMINI_VALIDATOR_VERSION}.`}
              title="Replay the frozen export and check it"
            />
            <p className="render-glass border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
              The frozen revision&apos;s OpenSCENARIO 1.4 export and its OpenDRIVE road network are
              replayed headlessly. It is a cross-engine check of the exported scenario — no cameras,
              no imagery.
            </p>
            <ul className="mt-3 grid gap-1.5 text-xs sm:grid-cols-2">
              <li className="flex items-baseline justify-between gap-2 render-glass border px-3 py-2">
                <span className="font-semibold text-foreground">State trace</span>
                <span className="text-micro text-muted-foreground">CSV · pose and speed per step</span>
              </li>
              <li className="flex items-baseline justify-between gap-2 render-glass border px-3 py-2">
                <span className="font-semibold text-foreground">Validation report</span>
                <span className="text-micro text-muted-foreground">JSON · XSD, entities, collisions</span>
              </li>
            </ul>
            {submitError ? (
              <p className="mt-3 break-words text-xs text-destructive" role="alert">
                {submitError}
              </p>
            ) : null}
          </RenderWizardBody>
          <RenderWizardFooter
            note="Runs on the CPU job fleet — no GPU worker required."
            onBack={() => setStepIndex(0)}
            primary={
              <button
                className={cn(
                  "editor-motion inline-flex h-9 shrink-0 items-center justify-center gap-2 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  stage != null
                    ? "cursor-not-allowed render-glass border text-muted-foreground"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
                data-testid="esmini-run-button"
                disabled={stage != null}
                onClick={() => void submitEsminiRun()}
                type="button"
              >
                {stage != null ? (
                  <>
                    <CloudActivityIndicator />
                    {stage === "package" ? "Preparing package…" : "Submitting…"}
                  </>
                ) : (
                  <>
                    <FlaskConical aria-hidden="true" className="size-3.5" />
                    Run esmini
                  </>
                )}
              </button>
            }
          />
        </>
      ) : step.id === "cameras" ? (
        <>
          <RenderWizardBody>
            <StepHeading
              aside={sensorOptions.length > 0
                ? `${selectedSensors.length}/${sensorOptions.length} selected`
                : "None configured"}
              hint={backend === "carla"
                ? "All 18 Pronto sources can run simultaneously. Modalities apply to all selected sensors that support them."
                : "Choose the authored sensors and modalities this browser render should capture."}
              title={`Which sensors should ${engineOption.label} capture?`}
            />
            {sensorOptions.length > 0 ? (
              <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
                {sensorOptions.map((option) => {
                  const key = sensorOptionKey(option);
                  return (
                    <div
                      className={cn(
                        "editor-motion border px-3 py-2",
                        selectedSensorKeys.includes(key)
                          ? "border-primary bg-primary/10"
                          : "render-glass",
                      )}
                      key={key}
                    >
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          checked={selectedSensorKeys.includes(key)}
                          className="mt-0.5 size-3.5 accent-primary"
                          data-testid={`render-sensor-${option.sensor.id}`}
                          disabled={stage != null}
                          onChange={(event) => toggleSensor(key, event.target.checked)}
                          type="checkbox"
                        />
                        <Camera aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-primary" />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-semibold text-foreground">
                            {sensorLabel(option.sensor)}
                          </span>
                          <span className="block truncate text-micro uppercase tracking-meta text-muted-foreground">
                            {sensorDetail(option)}
                          </span>
                        </span>
                      </label>
                      <div className="mt-2 flex flex-wrap gap-1 pl-6">
                        {supportedModalities(option.sensor).map((modality) => {
                          const enabled = modalitiesBySensor[key]?.includes(modality) ?? false;
                          return (
                            <button
                              aria-pressed={enabled}
                              className={cn(
                                "border px-1.5 py-0.5 text-micro uppercase tracking-meta",
                                enabled ? "border-primary bg-primary text-primary-foreground" : "render-glass text-muted-foreground",
                              )}
                              disabled={stage != null || !selectedSensorKeys.includes(key)}
                              key={modality}
                              onClick={() => toggleSensorModality(key, modality)}
                              type="button"
                            >
                              {renderModalityLabel(modality)}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="border border-dashed render-hairline px-3 py-2 text-xs text-muted-foreground">
                Add a camera, LiDAR or radar to an actor in the editor before rendering.
              </p>
            )}
            <div className="mt-4">
              <StepHeading hint="What each selected sensor produces." title="Kinds" />
              <div className="flex flex-wrap gap-1.5">
                {SENSOR_KINDS.map((kind) => {
                  const enabled = kinds.includes(kind.id);
                  return (
                    <button
                      aria-pressed={enabled}
                      className={cn(
                        "editor-motion border px-2.5 py-1 text-micro uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        enabled
                          ? "border-primary bg-primary text-primary-foreground"
                          : "render-glass text-muted-foreground hover:text-foreground",
                      )}
                      key={kind.id}
                      onClick={() => toggleKind(kind.id)}
                      title={kind.hint}
                      type="button"
                    >
                      {kind.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </RenderWizardBody>
          <RenderWizardFooter
            note={`${selectedSensors.length}/${MANAGED_MAX_SENSORS} physical sensors · ${sensorCount} modality sources`}
            nextDisabled={sensorCount === 0}
            onBack={() => setStepIndex(0)}
            onNext={() => setStepIndex(2)}
          />
        </>
      ) : step.id === "output" ? (
        <>
          <RenderWizardBody>
            <StepHeading
              aside={`${outputs.length} selected`}
              hint="A behavior trace, manifest and parity report are always included as run evidence."
              title="What should the render return?"
            />
            <div className="grid gap-1.5 sm:grid-cols-3">
              {OUTPUT_OPTIONS.map((option) => (
                <RenderOptionCard
                  hint={option.hint}
                  key={option.id}
                  label={option.label}
                  onClick={() => toggleOutput(option.id)}
                  selected={outputs.includes(option.id)}
                  selection="multi"
                  testId={`render-output-${option.id}`}
                />
              ))}
            </div>
            <div className="mt-5">
              <StepHeading hint="Applies to every image sensor in the request." title="Format" />
              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span className="text-micro uppercase tracking-meta text-muted-foreground">Resolution</span>
                  <select
                    className="render-glass border px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={stage != null}
                    onChange={(event) => setResolutionIndex(Number(event.target.value))}
                    value={String(resolutionIndex)}
                  >
                    {CARLA_RESOLUTIONS.map((item, index) => (
                      <option key={item.label} value={String(index)}>
                        {item.label} ({item.width}×{item.height})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-micro uppercase tracking-meta text-muted-foreground">FPS</span>
                  <select
                    className="render-glass border px-2 py-1.5 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={stage != null}
                    onChange={(event) => setFps(Number(event.target.value) as (typeof CARLA_FPS_OPTIONS)[number])}
                    value={String(fps)}
                  >
                    {CARLA_FPS_OPTIONS.map((value) => (
                      <option key={value} value={String(value)}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-micro uppercase tracking-meta text-muted-foreground">Quality</span>
                  <select
                    className="render-glass border px-2 py-1.5 capitalize text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    disabled={stage != null}
                    onChange={(event) => setQuality(event.target.value as (typeof CARLA_QUALITIES)[number])}
                    value={quality}
                  >
                    {CARLA_QUALITIES.map((value) => (
                      <option className="capitalize" key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div className="mt-5 flex items-center gap-2 border border-primary/30 bg-primary/5 px-3 py-2">
              <Clock aria-hidden="true" className="size-3.5 shrink-0 text-primary/80" />
              <p className="text-xs text-foreground">
                {clipSeconds}s
                <span className="ml-2 text-micro font-normal uppercase tracking-meta text-muted-foreground">
                  durable submission — closing this tab does not stop the worker
                </span>
              </p>
            </div>
          </RenderWizardBody>
          <RenderWizardFooter
            note={`${resolution.label} · ${fps} fps · ${quality}`}
            nextDisabled={outputs.length === 0}
            onBack={() => setStepIndex(1)}
            onNext={() => setStepIndex(3)}
          />
        </>
      ) : (
        <>
          <RenderWizardBody>
            <StepHeading
              hint="Submitting freezes the scenario and persists one immutable UniScenarios render intent."
              title={`Ready to render with ${engineOption.label}`}
            />
            <dl className="render-glass border px-3 py-1.5">
              <ReviewRow label="Engine" value={`${engineOption.label} · registered GPU worker`} />
              <ReviewRow
                label="Sensors"
                value={selectedSensors.length > 0
                  ? selectedSensors.map((option) => sensorLabel(option.sensor)).join(", ")
                  : "None selected"}
              />
              <ReviewRow label="Kinds" value={selectedKinds.length > 0 ? selectedKinds.join(", ") : "None enabled"} />
              <ReviewRow label="Format" value={`${resolution.label} · ${fps} fps · ${quality}`} />
              <ReviewRow label="Outputs" value={outputs.length > 0 ? outputs.join(", ") : "None"} />
              <ReviewRow label="Duration" value={`${clipSeconds}s · full frozen scenario`} />
              <ReviewRow
                label="Sensor host"
                value={sensorHostAssets[0] === "vehicle.kia.carnival"
                  ? "Kia Carnival · vehicle.kia.carnival"
                  : sensorHostAssets.length > 0 ? sensorHostAssets.join(", ") : "No bound host asset"}
              />
              {backend === "carla" ? (
                <>
                  <ReviewRow label="Rig capacity" value="8 cameras · 6 LiDAR · 4 radar" />
                  <ReviewRow label="CARLA source" value="carla-rfs-munich-belmont · f17c639e5f86" />
                </>
              ) : null}
            </dl>
            {issues.length > 0 ? (
              <div
                className="mt-3 border border-destructive/40 px-3 py-2 text-xs text-muted-foreground"
                data-testid="render-config-issues"
              >
                {issues.map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
              </div>
            ) : null}
            {stage !== null ? (
              // Submitting takes two waits an author cannot otherwise see: freezing the revision and
              // then a compile they are queued behind. Naming which one, and how long, is the
              // difference between a slow pipeline and an apparently dead button.
              <section
                aria-live="polite"
                className="mt-3 render-glass border p-3"
                data-testid="render-submit-progress"
              >
                <div className="flex items-center gap-2 text-xs font-medium">
                  <CloudActivityIndicator />
                  <span className="min-w-0 flex-1 truncate">
                    {stage === "package"
                      ? packageWait === null
                        ? "Freezing the scenario into an immutable revision"
                        : `Compiling the execution package · export ${packageWait.status}`
                      : "Submitting to the GPU fleet"}
                  </span>
                  <span className="shrink-0 font-mono text-micro text-muted-foreground">
                    {formatElapsed(
                      new Date(packageWait?.startedAtMs ?? nowMs).toISOString(),
                      new Date(nowMs).toISOString(),
                    )}
                  </span>
                </div>
                {packageWait !== null ? (
                  <p className="mt-1.5 text-micro text-muted-foreground" data-testid="render-submit-export">
                    {packageWait.claimed
                      ? "A compiler has it and is working."
                      : "Waiting for an OpenSCENARIO compiler to pick it up."}
                    <span className="ml-1 font-mono opacity-80">{packageWait.exportId}</span>
                  </p>
                ) : null}
              </section>
            ) : null}
            {submitError ? (
              <p className="mt-3 break-words text-xs text-destructive" role="alert">
                {submitError}
              </p>
            ) : null}
          </RenderWizardBody>
          <RenderWizardFooter
            note={`${selectedSensors.length}/${MANAGED_MAX_SENSORS} physical sensors · ${sensorCount} modality sources · reconnectable`}
            onBack={() => setStepIndex(2)}
            primary={
              <button
                className={cn(
                  "editor-motion inline-flex h-9 shrink-0 items-center justify-center gap-2 px-5 text-micro font-bold uppercase tracking-meta focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  submitDisabled
                    ? "cursor-not-allowed render-glass border text-muted-foreground"
                    : "bg-primary text-primary-foreground hover:bg-primary/90",
                )}
                data-testid="render-run-button"
                disabled={submitDisabled}
                onClick={() => void submitGpuRender()}
                type="button"
              >
                {stage != null ? (
                  <>
                    <CloudActivityIndicator />
                    {stage === "package" ? "Preparing package…" : "Submitting…"}
                  </>
                ) : (
                  <>
                    <Sparkles aria-hidden="true" className="size-3.5" />
                    Create render
                  </>
                )}
              </button>
            }
          />
        </>
      )}
    </section>
  );
}
