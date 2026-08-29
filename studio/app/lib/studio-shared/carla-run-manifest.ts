import { z } from "zod";
import { SensorSchema } from "@simforge-oss/scenario/contracts";
import { ScenarioEditorActorDraftSchema } from "./scenario-editor";
import { ArtifactManifestItemSchema } from "@simforge-oss/scenario/contracts";

export const CarlaDeterminismSchema = z.object({
  synchronousMode: z.boolean(),
  fixedDeltaSeconds: z.number().positive(),
  seed: z.number().int().nullable().optional(),
  trafficManagerSeed: z.number().int().nullable().optional(),
  deterministic: z.boolean().default(false),
  nonDeterministicReason: z.string().nullable().optional(),
});
export type CarlaDeterminism = z.infer<typeof CarlaDeterminismSchema>;

export const CarlaRunManifestSchema = z.object({
  contractVersion: z.literal("simforge.carla-run-manifest.v1"),
  carlaJobId: z.string().min(1),
  workspaceId: z.string().min(1),
  scenarioId: z.string().nullable().optional(),
  carlaServerVersion: z.string().nullable().optional(),
  carlaClientVersion: z.string().nullable().optional(),
  mapName: z.string().min(1),
  mapHash: z.string().nullable().optional(),
  generatedAt: z.string(),
  determinism: CarlaDeterminismSchema,
  weatherJson: z.record(z.unknown()).nullable().optional(),
  trafficManagerJson: z.record(z.unknown()).nullable().optional(),
  actors: z.array(ScenarioEditorActorDraftSchema.passthrough()).default([]),
  sensors: z.array(SensorSchema.passthrough()).default([]),
  frameCount: z.number().int().min(0).default(0),
  durationSeconds: z.number().nonnegative().nullable().optional(),
  artifacts: z.array(ArtifactManifestItemSchema).default([]),
  warnings: z.array(z.string()).default([]),
});
export type CarlaRunManifest = z.infer<typeof CarlaRunManifestSchema>;
