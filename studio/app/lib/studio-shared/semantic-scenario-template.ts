import { z } from "zod";
import { SceneFormationConstraintKindSchema, SceneFormationKindSchema } from "./scene-formation";
import { SemanticFeatureKindSchema } from "./semantic-map/feature-graph";
import { SemanticSiteQuerySchema } from "./semantic-map/site-query";

export const SEMANTIC_SCENARIO_TEMPLATE_SCHEMA_VERSION =
  "simforge.semantic-scenario-template.v1" as const;

export const SemanticScenarioTemplateFamilySchema = z.enum([
  "lane_construction_closure",
  "pedestrian_emergence_between_parked_vehicles",
  "large_vehicle_occlusion",
  "cut_in_merge_lane_change",
  "double_parked_delivery",
  "queue_stop_and_go",
  "emergency_crash_perimeter",
  "temporary_intersection_control",
  "debris_cargo_field",
  "parking_lot_backing_conflict",
  "roadside_worker_intrusion",
]);

export const SemanticScenarioTemplateSchema = z.object({
  schemaVersion: z.literal(SEMANTIC_SCENARIO_TEMPLATE_SCHEMA_VERSION),
  id: z.string().trim().min(1),
  version: z.number().int().positive(),
  family: SemanticScenarioTemplateFamilySchema,
  displayName: z.string().trim().min(1),
  description: z.string().trim().min(1),
  status: z.enum(["qualified", "experimental"]),
  siteQuery: SemanticSiteQuerySchema,
  requiredFeatureKinds: z.array(SemanticFeatureKindSchema).default([]),
  formationKind: SceneFormationKindSchema,
  hardConstraintKinds: z.array(SceneFormationConstraintKindSchema).default([]),
  softConstraintKinds: z.array(SceneFormationConstraintKindSchema).default([]),
  parameters: z.array(z.object({
    id: z.string().trim().min(1),
    label: z.string().trim().min(1),
    unit: z.enum(["meters", "seconds", "kph", "count", "ratio", "degrees"]),
    minimum: z.number().finite(),
    maximum: z.number().finite(),
    default: z.number().finite(),
  }).strict()).default([]),
  runtimeVerification: z.object({
    required: z.boolean(),
    visibilityRequired: z.boolean(),
    measurements: z.array(z.enum([
      "spawn_pose",
      "trajectory",
      "clearance",
      "collision",
      "visibility",
      "event_timing",
    ])).default([]),
  }).strict(),
}).strict();

export type SemanticScenarioTemplateFamily = z.infer<typeof SemanticScenarioTemplateFamilySchema>;
export type SemanticScenarioTemplate = z.infer<typeof SemanticScenarioTemplateSchema>;
