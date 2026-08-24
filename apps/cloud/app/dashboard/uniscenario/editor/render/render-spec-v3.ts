import {
  parseRenderSpecV3,
  type ActorSensor,
  type RenderModality,
  type RenderSpecV3,
  type ScenarioTemplateV2,
} from "@uniscenarios/scenario-model";

export type AuthoredRenderSensor = {
  actorId: string;
  actorLabel: string;
  sensor: ActorSensor;
};

export type SensorModalitySelection = {
  actorId: string;
  sensorId: string;
  modalities: readonly RenderModality[];
};

export type CanonicalRenderSpecInput = {
  content: ScenarioTemplateV2;
  selections: readonly SensorModalitySelection[];
  clip: { startSeconds: number; endSeconds: number };
  video: {
    width: number;
    height: number;
    fps: number;
    container: "webm";
    codec: string;
    quality: "draft" | "standard" | "high";
  } | null;
  artifacts: readonly ("video" | "manifest" | "frames" | "sensorArchive" | "annotations" | "trace")[];
  staticSemantics: boolean;
  fidelity: "review" | "dataset";
};

export const RENDER_MODALITY_ORDER: readonly RenderModality[] = [
  "rgb",
  "depth",
  "semantic",
  "instance",
  "lidar",
  "radar",
];

/**
 * What a pass is called in the interface.
 *
 * `humanize` title-cases each word, which turns the two initialisms into "Rgb" and "Lidar". That
 * was survivable as body text inside a card and is not as a column header.
 */
const RENDER_MODALITY_LABELS: Record<string, string> = {
  rgb: "RGB",
  depth: "Depth",
  semantic: "Semantic",
  instance: "Instance",
  lidar: "LiDAR",
  radar: "Radar",
};

export function renderModalityLabel(modality: RenderModality): string {
  return RENDER_MODALITY_LABELS[modality] ?? modality;
}

export function authoredRenderSensors(content: ScenarioTemplateV2 | null): AuthoredRenderSensor[] {
  if (!content) return [];
  return content.roles.flatMap((role) => role.actor.sensors
    .filter((sensor) => sensor.enabled)
    .map((sensor) => ({
      actorId: role.id,
      actorLabel: role.label ?? role.id,
      sensor,
    })));
}

export function supportedModalities(sensor: ActorSensor): readonly RenderModality[] {
  if (sensor.type === "dash_camera") return ["rgb", "depth", "semantic", "instance"];
  if (sensor.type === "lidar") return ["lidar"];
  return ["radar"];
}

export function defaultModalities(sensor: ActorSensor): readonly RenderModality[] {
  if (sensor.type === "dash_camera") return ["rgb"];
  if (sensor.type === "lidar") return ["lidar"];
  return ["radar"];
}

export function buildCanonicalRenderSpec(input: CanonicalRenderSpecInput): RenderSpecV3 {
  const sensorByKey = new Map(
    authoredRenderSensors(input.content).map((option) => [sensorKey(option.actorId, option.sensor.id), option.sensor]),
  );
  const sources = input.selections.flatMap((selection) => {
    const sensor = sensorByKey.get(sensorKey(selection.actorId, selection.sensorId));
    if (!sensor) throw new Error(`Unknown authored sensor ${selection.actorId}/${selection.sensorId}.`);
    const supported = new Set(supportedModalities(sensor));
    return RENDER_MODALITY_ORDER
      .filter((modality) => selection.modalities.includes(modality))
      .map((modality) => {
        if (!supported.has(modality)) {
          throw new Error(`${sensor.type} sensor ${sensor.id} does not support ${modality}.`);
        }
        const common = {
          actorId: selection.actorId,
          sensorId: sensor.id,
          outputName: `${selection.actorId}-${sensor.id}-${modality}`,
          transform: {
            position: sensor.mount.position,
            rotation: sensor.mount.rotation,
          },
          modality,
        };
        if (sensor.type === "dash_camera") {
          return {
            ...common,
            modality,
            attributes: {
              width: input.video?.width ?? 1280,
              height: input.video?.height ?? 720,
              fps: input.video?.fps ?? 24,
              horizontalFovDeg: sensor.camera.horizontalFovDeg,
              nearM: sensor.camera.nearM,
              farM: sensor.camera.farM,
            },
          };
        }
        if (sensor.type === "lidar") {
          return {
            ...common,
            modality: "lidar" as const,
            attributes: {
              channels: 32,
              rangeM: sensor.field.farM,
              pointsPerSecond: 100_000,
              rotationFrequencyHz: 10,
              upperFovDeg: sensor.field.verticalFovDeg / 2,
              lowerFovDeg: -sensor.field.verticalFovDeg / 2,
            },
          };
        }
        return {
          ...common,
          modality: "radar" as const,
          attributes: {
            horizontalFovDeg: sensor.field.horizontalFovDeg,
            verticalFovDeg: sensor.field.verticalFovDeg,
            rangeM: sensor.field.farM,
            pointsPerSecond: 1_500,
          },
        };
      });
  });

  const artifacts = [...new Set(["manifest" as const, ...input.artifacts])];
  const required = [
    ...sources.map((source) => `sensor.${source.modality}`),
    ...artifacts.map((artifact) => artifact === "sensorArchive" ? "artifact.sensor_archive" : `artifact.${artifact}`),
    "environment.authored",
    "timing.fixed_step",
    ...(input.staticSemantics && sources.some((source) => source.modality === "semantic")
      ? ["map.static_semantics"]
      : []),
  ];
  return parseRenderSpecV3({
    schema: "uniscenario.render-spec/v3",
    sources,
    clip: input.clip,
    ...(input.video ? { video: input.video } : {}),
    artifacts,
    capabilityIntent: {
      required: [...new Set(required)],
      preferred: [],
      fidelity: input.fidelity,
    },
    authoredEnvironment: input.content.environment,
  });
}


/**
 * What the browser renderer can do for this spec, as a set.
 *
 * A capability list answers "can this renderer produce RGB", not "how many cameras asked for it",
 * and the capture-manifest schema enforces that by rejecting duplicates. Deriving it straight from
 * `sources` therefore broke the moment a scenario carried two RGB cameras: two sources, one
 * capability, and a manifest refused client-side with `duplicate capability "sensor.rgb"` — so the
 * multi-camera default the cameras step opens with could not be recorded at all.
 */
export function browserRendererCapabilities(
  spec: Pick<RenderSpecV3, "sources" | "artifacts" | "video">,
  options: { staticSemantics: boolean },
): string[] {
  const capabilities = new Set<string>();
  for (const source of spec.sources) capabilities.add(`sensor.${source.modality}`);
  for (const artifact of spec.artifacts) {
    capabilities.add(
      artifact === "sensorArchive" ? "artifact.sensor_archive" : `artifact.${artifact}`,
    );
  }
  if (spec.video) {
    capabilities.add("artifact.video");
  }
  // Every camera source emits its own encoded video stream; lidar/radar add
  // visualization videos when a video output is requested.
  if (spec.sources.length > 0) {
    capabilities.add("artifact.sensor_video");
  }
  capabilities.add("environment.authored");
  capabilities.add("timing.fixed_step");
  if (options.staticSemantics) capabilities.add("map.static_semantics");
  return [...capabilities];
}

export function sensorKey(actorId: string, sensorId: string): string {
  return `${actorId}:${sensorId}`;
}
