import {
  RenderOutputSpecSchema,
  normalizeRenderDurationOverrideSeconds,
  type RenderOutputAnnotation,
  type RenderOutputEncoding,
  type RenderOutputMetadata,
  type RenderOutputProfile,
  type RenderOutputSpec,
  type SensorOutputModality,
} from "@simforge-oss/scenario/contracts";

export type ScenarioSetupRenderConfig = {
  renderOutputProfile: RenderOutputProfile;
  renderOutputCustomModalities?: SensorOutputModality[];
  renderOutputCustomAnnotations?: RenderOutputAnnotation[];
  renderOutputCustomMetadata?: RenderOutputMetadata[];
  renderOutputCustomEncodings?: RenderOutputEncoding[];
  outputSpec: RenderOutputSpec;
  sdgRenderDraft?: Record<string, unknown>;
  sdgCameraMountIds?: string[];
  environmentPreset?: Record<string, unknown>;
  lidarCapture?: boolean;
  lidarBevMp4?: boolean;
  saveArtifacts?: boolean;
  bboxCategories?: {
    dynamicActors: boolean;
    trafficLights: boolean;
    trafficSigns: boolean;
    emit2dVisiblePixel?: boolean;
    emit3dCamera?: boolean;
    emit3dWorld?: boolean;
    emit3dProjection?: boolean;
  };
  renderDurationOverrideSeconds?: number | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function parseRenderConfig(value: unknown): ScenarioSetupRenderConfig | null {
  const record = asRecord(value);
  const outputSpecInput = record.outputSpec ?? record.output_spec;
  const parsedOutputSpec = RenderOutputSpecSchema.safeParse(outputSpecInput);
  if (!parsedOutputSpec.success) return null;
  const profile =
    typeof record.renderOutputProfile === "string"
      ? record.renderOutputProfile
      : parsedOutputSpec.data.profile;
  const renderOutputProfile =
    profile === "playback" ||
    profile === "training_basic" ||
    profile === "training_multimodal" ||
    profile === "raw_multisensor" ||
    profile === "tao_detection" ||
    profile === "sdg" ||
    profile === "custom"
      ? profile
      : parsedOutputSpec.data.profile;
  const bboxCategories = asRecord(record.bboxCategories);

  return {
    renderOutputProfile,
    renderOutputCustomModalities: asStringArray(
      record.renderOutputCustomModalities,
    ) as SensorOutputModality[],
    renderOutputCustomAnnotations: asStringArray(
      record.renderOutputCustomAnnotations,
    ) as RenderOutputAnnotation[],
    renderOutputCustomMetadata: asStringArray(
      record.renderOutputCustomMetadata,
    ) as RenderOutputMetadata[],
    renderOutputCustomEncodings: asStringArray(
      record.renderOutputCustomEncodings,
    ) as RenderOutputEncoding[],
    outputSpec: parsedOutputSpec.data,
    sdgCameraMountIds: asStringArray(record.sdgCameraMountIds),
    ...(hasOwn(record, "sdgRenderDraft")
      ? { sdgRenderDraft: asRecord(record.sdgRenderDraft) }
      : {}),
    ...(hasOwn(record, "environmentPreset")
      ? { environmentPreset: asRecord(record.environmentPreset) }
      : {}),
    lidarCapture:
      typeof record.lidarCapture === "boolean"
        ? record.lidarCapture
        : parsedOutputSpec.data.lidar_capture,
    lidarBevMp4:
      typeof record.lidarBevMp4 === "boolean"
        ? record.lidarBevMp4
        : parsedOutputSpec.data.lidar_bev_mp4,
    saveArtifacts:
      typeof record.saveArtifacts === "boolean"
        ? record.saveArtifacts
        : parsedOutputSpec.data.save_artifacts,
    bboxCategories: {
      dynamicActors: bboxCategories.dynamicActors !== false,
      trafficLights: bboxCategories.trafficLights === true,
      trafficSigns: bboxCategories.trafficSigns === true,
      emit2dVisiblePixel: bboxCategories.emit2dVisiblePixel !== false,
      emit3dCamera: bboxCategories.emit3dCamera !== false,
      emit3dWorld: bboxCategories.emit3dWorld !== false,
      emit3dProjection: bboxCategories.emit3dProjection !== false,
    },
    renderDurationOverrideSeconds: hasOwn(record, "renderDurationOverrideSeconds")
      ? normalizeRenderDurationOverrideSeconds(
          record.renderDurationOverrideSeconds,
        )
      : null,
  };
}
