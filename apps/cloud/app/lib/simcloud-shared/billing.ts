import {
  expandSdgOutputs,
  SDG_OUTPUTS,
  type SdgOutput,
} from "./recipes";

export const BILLING = {
  renderCentsPerSensor: 500,
  renderCentsPerOutputMethod: 500,
  cosmosCentsPerVideo: 500,
} as const;

export type BillingRates = typeof BILLING;

export const RENDER_PRICE_MODEL = "render-v2" as const;
export const RENDER_QUEUE_PRICE_MODEL = "render-v3-queue-tier-v1" as const;
export const COSMOS_PRICE_MODEL = "cosmos-v1" as const;
export const NORMAL_QUEUE_MULTIPLIER_BPS = 10000;
export const PRIORITY_QUEUE_MULTIPLIER_BPS = 15000;

export type CarlaQueueTier = "normal" | "priority";

type UnknownRecord = Record<string, unknown>;

export type RenderCostEstimate = {
  priceModel: typeof RENDER_PRICE_MODEL | typeof RENDER_QUEUE_PRICE_MODEL;
  queueTier: CarlaQueueTier;
  costMultiplierBps: number;
  sensorCount: number;
  outputMethodCount: number;
  expandedOutputMethods: SdgOutput[];
  sensorCostCents: number;
  outputMethodCostCents: number;
  baseTotalCents: number;
  premiumCents: number;
  totalCents: number;
  renderCentsPerSensor: number;
  renderCentsPerOutputMethod: number;
};

export type CosmosCostEstimate = {
  priceModel: typeof COSMOS_PRICE_MODEL;
  videoCount: number;
  weatherCount: number;
  outputCount: number;
  unitCents: number;
  totalCents: number;
};

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function arrayValue(record: UnknownRecord, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

export function countRenderSensors(input: UnknownRecord): number {
  const directSensors = arrayValue(input, "sensors").length;
  if (directSensors > 0) return directSensors;

  const actorRigSensors = arrayValue(input, "actor_sensor_rigs").reduce<number>(
    (count, rig) => {
      if (!isRecord(rig)) return count;
      return count + arrayValue(rig, "sensors").length;
    },
    0,
  );
  if (actorRigSensors > 0) return actorRigSensors;

  const renderOutputPlan = input.render_output_plan ?? input.renderOutputPlan;
  if (!isRecord(renderOutputPlan)) return 0;
  const uniqueCameraMounts = new Set(
    arrayValue(renderOutputPlan, "cameraMountIds")
      .map((mountId) => (typeof mountId === "string" ? mountId.trim() : ""))
      .filter(Boolean),
  );
  return uniqueCameraMounts.size;
}

function isSdgOutput(value: unknown): value is SdgOutput {
  return typeof value === "string" && (SDG_OUTPUTS as readonly string[]).includes(value);
}

function collectSdgOutputsFromPlan(plan: unknown): SdgOutput[] {
  if (!isRecord(plan)) return [];
  const outputs = plan.outputs;
  if (!isRecord(outputs)) return [];
  const selected = [
    ...arrayValue(outputs, "frames"),
    ...arrayValue(outputs, "annotations"),
    ...arrayValue(outputs, "media"),
  ].filter(isSdgOutput);
  return expandSdgOutputs(selected);
}

function collectLegacyOutputSpecMethods(outputSpec: unknown): SdgOutput[] {
  if (!isRecord(outputSpec)) return [];
  const selected = [
    ...arrayValue(outputSpec, "modalities"),
    ...arrayValue(outputSpec, "annotations"),
  ].filter(isSdgOutput);
  return expandSdgOutputs(selected);
}

export function normalizeCarlaQueueTier(value: unknown): CarlaQueueTier {
  return value === "priority" ? "priority" : "normal";
}

function multiplierForQueueTier(queueTier: CarlaQueueTier) {
  return queueTier === "priority"
    ? PRIORITY_QUEUE_MULTIPLIER_BPS
    : NORMAL_QUEUE_MULTIPLIER_BPS;
}

export function estimateRenderCostCents(
  input: UnknownRecord,
  options: { queueTier?: CarlaQueueTier | null } = {},
): RenderCostEstimate {
  const queueTier = normalizeCarlaQueueTier(options.queueTier ?? input.queue_tier ?? input.queueTier);
  const costMultiplierBps = multiplierForQueueTier(queueTier);
  const sensorCount = countRenderSensors(input);
  const renderOutputPlan = input.render_output_plan ?? input.renderOutputPlan;
  const outputSpec = input.output_spec ?? input.outputSpec;
  const sdgOutputMethods = collectSdgOutputsFromPlan(renderOutputPlan);
  const expandedOutputMethods =
    sdgOutputMethods.length > 0
      ? sdgOutputMethods
      : collectLegacyOutputSpecMethods(outputSpec);
  const sensorCostCents = sensorCount * BILLING.renderCentsPerSensor;
  const outputMethodCostCents =
    expandedOutputMethods.length * BILLING.renderCentsPerOutputMethod;
  const baseTotalCents = sensorCostCents + outputMethodCostCents;
  const totalCents = Math.ceil((baseTotalCents * costMultiplierBps) / 10000);

  return {
    priceModel: queueTier === "priority" ? RENDER_QUEUE_PRICE_MODEL : RENDER_PRICE_MODEL,
    queueTier,
    costMultiplierBps,
    sensorCount,
    outputMethodCount: expandedOutputMethods.length,
    expandedOutputMethods,
    sensorCostCents,
    outputMethodCostCents,
    baseTotalCents,
    premiumCents: totalCents - baseTotalCents,
    totalCents,
    renderCentsPerSensor: BILLING.renderCentsPerSensor,
    renderCentsPerOutputMethod: BILLING.renderCentsPerOutputMethod,
  };
}

export function estimateCosmosCostCents(input: {
  videoCount: number;
  weatherCount: number;
}): CosmosCostEstimate {
  const videoCount = Math.max(0, Math.trunc(input.videoCount));
  const weatherCount = Math.max(0, Math.trunc(input.weatherCount));
  const outputCount = videoCount * weatherCount;
  return {
    priceModel: COSMOS_PRICE_MODEL,
    videoCount,
    weatherCount,
    outputCount,
    unitCents: BILLING.cosmosCentsPerVideo,
    totalCents: outputCount * BILLING.cosmosCentsPerVideo,
  };
}

export const DEFAULT_WORKSPACE_CREDITS_CENTS = 50000;

export const TOP_UP_TIERS = [
  { key: "topup_10000", label: "$100", amountCents: 10000 },
  { key: "topup_25000", label: "$250", amountCents: 25000 },
  { key: "topup_50000", label: "$500", amountCents: 50000 },
  { key: "topup_100000", label: "$1,000", amountCents: 100000 },
] as const;

export const CUSTOM_TOPUP = {
  minCents: 10000,
  maxCents: 1000000,
} as const;

export type TopUpTier = (typeof TOP_UP_TIERS)[number];
