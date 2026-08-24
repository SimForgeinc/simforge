import type {
  SdgDirectRenderDraft,
  SdgOutput,
  SdgRenderOutputPlan,
  RenderOutputSpec,
  Sensor,
} from "@simcloud/shared";
import {
  DEFAULT_SDG_DIRECT_RENDER_DRAFT,
  SDG_OUTPUTS,
  SDG_OUTPUT_DEPENDENCIES,
  SDG_RENDER_FPS,
  SDG_RENDER_RESOLUTION,
  SdgRenderOutputPlanSchema,
  expandSdgOutputs,
  getRequiredSdgRawModalities,
  orderedSdgOutputs,
} from "@simcloud/shared";
import { getSdgSensorConfigWarning } from "@/app/lib/scenario-sdg/sdg-camera-mounts";
import {
  ALPAMAYO_PAI_CAMERA_MOUNT_IDS,
  PRESET_ALPAMAYO_PAI,
} from "@/app/lib/scenario-editor/sensor-rigs";

const SDG_FRAME_OUTPUTS = [
  "rgb",
  "depth",
  "semantic_segmentation",
  "instance_segmentation",
  "normals",
  "edges",
  "masks",
] as const satisfies readonly SdgOutput[];

const SDG_ANNOTATION_OUTPUTS = [
  "odvg",
  "objects",
  "instances",
  "rgb_bboxed",
] as const satisfies readonly SdgOutput[];

const SDG_MEDIA_OUTPUTS = ["videos"] as const satisfies readonly SdgOutput[];

export const DEFAULT_SDG_DATASET_COMPILE_DRAFT: SdgDirectRenderDraft = {
  ...DEFAULT_SDG_DIRECT_RENDER_DRAFT,
  outputs: ["rgb", "odvg", "rgb_bboxed", "videos"],
};

function addOutputWithDependencies(
  output: SdgOutput,
  selected: Set<SdgOutput>,
) {
  for (const dependency of SDG_OUTPUT_DEPENDENCIES[output]) {
    addOutputWithDependencies(dependency, selected);
  }
  selected.add(output);
}

function removeOutputAndDependents(
  output: SdgOutput,
  selected: Set<SdgOutput>,
) {
  selected.delete(output);
  for (const candidate of SDG_OUTPUTS) {
    if (!selected.has(candidate)) continue;
    const dependencies = SDG_OUTPUT_DEPENDENCIES[candidate] as readonly SdgOutput[];
    if (!dependencies.includes(output)) continue;
    removeOutputAndDependents(candidate, selected);
  }
}

function includesAnyOutput(
  selected: Set<SdgOutput>,
  candidates: readonly SdgOutput[],
) {
  return candidates.some((candidate) => selected.has(candidate));
}

function ensurePlanCompatibleOutputs(outputs: SdgOutput[]) {
  const selected = new Set(outputs);
  const fallbacks: SdgOutput[] = [];
  if (!includesAnyOutput(selected, SDG_FRAME_OUTPUTS)) fallbacks.push("rgb");
  if (!includesAnyOutput(selected, SDG_MEDIA_OUTPUTS)) fallbacks.push("videos");
  return expandSdgOutputs([...outputs, ...fallbacks]);
}

function groupSdgPlanOutputs(outputs: SdgOutput[]): SdgRenderOutputPlan["outputs"] {
  const selected = new Set(ensurePlanCompatibleOutputs(outputs));
  const frames = SDG_FRAME_OUTPUTS.filter((output) => selected.has(output));
  const annotations = SDG_ANNOTATION_OUTPUTS.filter((output) => selected.has(output));
  const media = SDG_MEDIA_OUTPUTS.filter((output) => selected.has(output));
  return { frames, annotations, media };
}

function normalizeCameraMountIds(cameraMountIds: string[] | undefined) {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const rawId of cameraMountIds ?? []) {
    const id = rawId.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }
  return normalized.length > 0 ? normalized : ["scenario_default"];
}

function normalizeCameraMounts(
  cameraMounts: SdgRenderOutputPlan["cameraMounts"] | undefined,
  cameraMountIds: string[],
): SdgRenderOutputPlan["cameraMounts"] {
  const selected = new Set(cameraMountIds);
  const normalized: SdgRenderOutputPlan["cameraMounts"] = [];
  const seen = new Set<string>();
  for (const mount of cameraMounts ?? []) {
    const id = mount.id.trim();
    if (!id || !selected.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push({
      id,
      ...(mount.label?.trim() ? { label: mount.label.trim() } : {}),
      ...(mount.attachTo?.trim() ? { attachTo: mount.attachTo.trim() } : {}),
      ...(mount.sensorId?.trim() ? { sensorId: mount.sensorId.trim() } : {}),
      ...(mount.sourceSensorId?.trim()
        ? { sourceSensorId: mount.sourceSensorId.trim() }
        : {}),
      ...(mount.kind ? { kind: mount.kind } : {}),
    });
  }
  return normalized;
}

export function setSdgOutputEnabled(
  draft: SdgDirectRenderDraft,
  output: SdgOutput,
  enabled: boolean,
): SdgDirectRenderDraft {
  const selected = new Set(getSdgDraftRequestedOutputs(draft));

  if (enabled) {
    addOutputWithDependencies(output, selected);
  } else {
    removeOutputAndDependents(output, selected);
  }

  if (selected.size === 0) {
    addOutputWithDependencies("rgb", selected);
  }

  const outputs = orderedSdgOutputs(selected);
  return {
    ...draft,
    outputs,
  };
}

export function getSdgDraftRequestedOutputs(
  draft: SdgDirectRenderDraft,
): SdgOutput[] {
  const configured = expandSdgOutputs(draft.outputs);
  return configured.length > 0 ? configured : [...SDG_OUTPUTS];
}

export function buildSdgRenderOutputSpec(
  draft: SdgDirectRenderDraft,
): RenderOutputSpec {
  const outputs = getSdgDraftRequestedOutputs(draft);
  const selected = new Set(outputs);

  return {
    version: 1,
    profile: "sdg",
    modalities: getRequiredSdgRawModalities(outputs),
    annotations:
      selected.has("odvg") ||
      selected.has("objects") ||
      selected.has("instances") ||
      selected.has("rgb_bboxed")
        ? ["odvg", "objects", "instances"]
        : [],
    metadata: ["manifest", "calibration", "timestamps", "opendrive"],
    encodings: ["image_sequence", "mp4"],
  };
}

export function buildSdgRenderOutputPlan(input: {
  draft: SdgDirectRenderDraft;
  cameraMountIds?: string[];
  cameraMounts?: SdgRenderOutputPlan["cameraMounts"];
  alpamayoTrainingProfile?: boolean;
  stagePolicy?: Partial<SdgRenderOutputPlan["stagePolicy"]>;
  bbox?: Partial<SdgRenderOutputPlan["bbox"]>;
  retention?: Partial<SdgRenderOutputPlan["retention"]>;
}): SdgRenderOutputPlan {
  const outputs = getSdgDraftRequestedOutputs(input.draft);
  const bbox = input.bbox ?? {};
  const cameraMountIds = normalizeCameraMountIds(input.cameraMountIds);
  return SdgRenderOutputPlanSchema.parse({
    schemaVersion: "simforge.render-output-plan.v1",
    profile: "sdg",
    cameraMountIds,
    cameraMounts: normalizeCameraMounts(input.cameraMounts, cameraMountIds),
    ...(input.alpamayoTrainingProfile
      ? {
          trainingProfile: {
            id: "alpamayo_pai_sft",
            datasetFormat: "PAI",
            cameraMountIds: [...ALPAMAYO_PAI_CAMERA_MOUNT_IDS],
            requiredLabels: ["egomotion"],
            clipDurationSeconds: 20,
            defaultKeyframeTimestampUs: 5_100_000,
            historySteps: 16,
            futureSteps: 64,
            timeStepSeconds: 0.1,
          },
        }
      : {}),
    outputs: groupSdgPlanOutputs(outputs),
    recorder: {
      startTime: input.draft.recorder.startTime,
      durationSeconds: input.draft.recorder.durationSeconds,
      fps: SDG_RENDER_FPS,
      resolution: { ...SDG_RENDER_RESOLUTION },
      timeFactor: input.draft.recorder.timeFactor,
      limitDistance: input.draft.recorder.limitDistance,
      areaThreshold: input.draft.recorder.areaThreshold,
      detectCollisions: input.draft.recorder.detectCollisions,
    },
    bbox: {
      dynamicActors: bbox.dynamicActors ?? true,
      trafficLights: bbox.trafficLights ?? false,
      trafficSigns: bbox.trafficSigns ?? false,
    },
    retention: {
      uploadStageInputs: input.retention?.uploadStageInputs ?? true,
      uploadRawBundle: input.retention?.uploadRawBundle ?? false,
    },
    stagePolicy: {
      groundTruth: input.stagePolicy?.groundTruth ?? true,
      cosmos: input.stagePolicy?.cosmos ?? false,
      postprocess: input.stagePolicy?.postprocess ?? false,
    },
  });
}

export function buildSdgDatasetCompileOutputPlan(input: {
  cameraMountIds?: string[];
  cameraMounts?: SdgRenderOutputPlan["cameraMounts"];
  alpamayoTrainingProfile?: boolean;
  outputs?: SdgOutput[];
  stagePolicy?: Partial<SdgRenderOutputPlan["stagePolicy"]>;
}): SdgRenderOutputPlan {
  return buildSdgRenderOutputPlan({
    draft: {
      ...DEFAULT_SDG_DATASET_COMPILE_DRAFT,
      ...(input.outputs ? { outputs: input.outputs } : {}),
    },
    cameraMountIds: input.cameraMountIds,
    cameraMounts: input.cameraMounts,
    alpamayoTrainingProfile: input.alpamayoTrainingProfile,
    stagePolicy: input.stagePolicy,
  });
}

export function buildAlpamayoPaiCameraMounts(): SdgRenderOutputPlan["cameraMounts"] {
  return PRESET_ALPAMAYO_PAI.sensors.map((sensor) => ({
    id: sensor.mountId ?? sensor.id,
    label: sensor.mountLabel ?? sensor.label,
    attachTo: sensor.attachTo,
    sensorId: sensor.id,
    kind: sensor.attachTo === "world" ? "world" : "actor",
  }));
}

export { ALPAMAYO_PAI_CAMERA_MOUNT_IDS };

export function resolveSdgDraftForSensors(
  draft: SdgDirectRenderDraft,
  sensors: Sensor[],
): SdgDirectRenderDraft {
  const requested = getSdgDraftRequestedOutputs(draft);
  const hasEligibleCamera = getSdgSensorConfigWarning(sensors) === null;
  const outputs = hasEligibleCamera ? requested : [];
  return {
    ...draft,
    outputs,
  };
}

export { DEFAULT_SDG_DIRECT_RENDER_DRAFT, getSdgSensorConfigWarning };
