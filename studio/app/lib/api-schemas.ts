/**
 * Zod schemas used for OpenAPI documentation.
 * Exported here so route files only export HTTP handlers (GET, POST, etc.) and stay valid Next.js routes.
 */
import { z } from "zod";
import {
  MapAssetSchema,
  ScenarioSchema,
  CandidateLocationSchema,
} from "@simforge/studio-shared";

// ---- Path params ----
export const ScenarioIdParams = z.object({ scenarioId: z.string().describe("Scenario identifier") });
export const MapAssetIdParams = z.object({ mapAssetId: z.string().describe("Map asset identifier") });

// ---- Query params ----
export const MediaQueryParams = z.object({
  key: z.string().describe("S3 object key, e.g. runs/{runId}/file.mp4 or maps/{id}/file.mp4"),
});

// ---- Scenarios list ----
export const ScenariosListResponse = z.array(ScenarioSchema);
/** @deprecated Use ScenariosListResponse */
export const RunsListResponse = ScenariosListResponse;

export const PostprocessGenerateBodySchema = z.object({
  artifact_ids: z.array(z.string().min(1)).min(1).max(16),
  prompt: z.string().optional(),
  service: z.string().optional(),
  trajectory_output: z.record(z.unknown()).optional(),
  dataset_snapshot_id: z.string().optional(),
  datasetSnapshotId: z.string().optional(),
});
export type PostprocessGenerateBody = z.infer<typeof PostprocessGenerateBodySchema>;

export const PostprocessGenerateResponseSchema = z.object({
  jobs: z.array(z.object({
    id: z.string(),
    status: z.string(),
    source_artifact_id: z.string().nullable().optional(),
    source_artifact_ids: z.array(z.string()).optional(),
    source_artifact_label: z.string().nullable().optional(),
    dataset_snapshot_id: z.string().nullable().optional(),
  })),
});

// ---- Simulations: persist-s3 ----
export const PersistRunBody = z.object({ run: ScenarioSchema });
export const PersistRunResponse = z.object({
  ok: z.literal(true),
  count: z.number(),
  message: z.string(),
});

// ---- Simulations: update-s3 ----
export const UpdateRunBody = z.object({ run: ScenarioSchema });
export const UpdateRunResponse = z.object({
  ok: z.literal(true),
  count: z.number(),
  message: z.string(),
});

// ---- Simulations: delete run ----
export const DeleteRunResponse = z.object({
  ok: z.literal(true),
  prefix: z.string(),
  deletedObjects: z.number(),
  message: z.string(),
});

// ---- Simulations: upload-artifact ----
export const UploadArtifactResponse = z.object({
  uri: z.string().describe("s3:// URI of the artifact"),
});

// ---- Map assets ----
export const MapAssetsListResponse = z.array(MapAssetSchema);
export const CreateMapAssetResponse = z.object({ mapAssetId: z.string() });
export const UpdateMapAssetResponse = z.object({ mapAssetId: z.string() });

// ---- Map assets: single-file upload URL ----
export const UploadUrlBody = z.object({
  mapAssetId: z.string().describe("Map asset identifier"),
  fileId: z.string().describe("File slot ID (e.g. 'geojson', 'xodr', 'rrdata_xml', 'artifact-0')"),
  filename: z.string().describe("Original filename with extension"),
  contentType: z.string().optional().describe("MIME type (default application/octet-stream)"),
});
export const UploadUrlResponse = z.object({
  url: z.string().describe("Presigned S3 PUT URL (valid 15 min)"),
  key: z.string().describe("S3 object key"),
});

// ---- Map assets: upload-urls (initial upload with all required files) ----
export const UploadUrlsBody = z.object({
  mapAssetId: z.string().describe("Map asset identifier"),
  name: z.string().describe("Display name for the map asset"),
  description: z.string().optional().describe("Optional description"),
  crs: z.string().optional().describe("Coordinate reference system (default EPSG:4326)"),
  tags: z.array(z.string()).optional().describe("Optional tags"),
  mapCenter: z.object({ lat: z.number(), lng: z.number() }).optional().describe("Map center point"),
  bbox: z.object({ min_lat: z.number(), min_lng: z.number(), max_lat: z.number(), max_lng: z.number() }).optional().describe("Bounding box"),
  files: z.array(z.object({
    id: z.string().describe("File slot ID"),
    filename: z.string().describe("Original filename"),
    contentType: z.string().optional().describe("MIME type"),
  })).describe("Files to upload"),
});
export const UploadUrlsResponse = z.object({
  uploads: z.array(z.object({
    id: z.string(),
    url: z.string().describe("Presigned S3 PUT URL"),
    key: z.string().describe("S3 object key"),
  })),
  mapAssetId: z.string(),
});

// ---- Map assets: complete (finalize after upload) ----
export const CompleteMapAssetBody = z.object({
  mapAssetId: z.string().describe("Map asset identifier"),
  name: z.string().describe("Display name"),
  description: z.string().optional().describe("Optional description"),
  carlaMapName: z.string().nullish().describe("CARLA simulator map name for this asset"),
  crs: z.string().optional().describe("Coordinate reference system (default EPSG:4326)"),
  tags: z.array(z.string()).optional().describe("Optional tags"),
  mapCenter: z.object({ lat: z.number(), lng: z.number() }).describe("Map center point"),
  bbox: z.object({ min_lat: z.number(), min_lng: z.number(), max_lat: z.number(), max_lng: z.number() }).describe("Bounding box"),
  artifacts: z.array(z.object({
    key: z.string().describe("S3 object key"),
    artifact_type: z.string().describe("Type: geojson, xodr, rrdata_xml, fbx, mp4, image"),
    sha256: z.string().describe("SHA-256 hash of the uploaded file"),
  })).describe("Uploaded artifact metadata"),
});

// ---- Map assets: media upload URLs (add videos/images to existing map) ----
export const MediaUploadUrlsBody = z.object({
  files: z.array(z.object({
    id: z.string().describe("File identifier"),
    filename: z.string().describe("Original filename"),
    contentType: z.string().optional().describe("MIME type"),
  })).describe("Media files to upload"),
});
export const MediaUploadUrlsResponse = z.object({
  uploads: z.array(z.object({
    id: z.string(),
    url: z.string().describe("Presigned S3 PUT URL"),
    key: z.string().describe("S3 object key"),
  })),
});

// ---- Map assets: 3D tile upload URLs ----
export const Upload3dUrlsBody = z.object({
  files: z.array(z.object({
    id: z.string().describe("File identifier"),
    relativePath: z.string().describe("Relative path preserving folder structure"),
    contentType: z.string().optional().describe("MIME type"),
  })).describe("3D tile files to upload"),
});
export const Upload3dUrlsResponse = z.object({
  uploads: z.array(z.object({
    id: z.string(),
    url: z.string().describe("Presigned S3 PUT URL"),
    key: z.string().describe("S3 object key"),
    contentType: z.string(),
  })),
});

// ---- Map assets: enrich (enqueue 3rd-party-enrichment job) ----
export const EnrichMapAssetBody = z.object({
  providerRelease: z.string().default("2026-06-17.0").describe("Overture release tag"),
});
export const EnrichMapAssetResponse = z.object({
  job_id: z.string().describe("ID of the enqueued enrichment job"),
  job_type: z.literal("third_party_enrichment"),
  status: z.enum(["pending", "running", "succeeded", "failed", "timeout"]),
  reused: z.boolean().describe("True when an already-pending job was returned instead of a new one."),
});

// ---- Map assets: enrichment status (polling) ----
export const EnrichmentStatusResponse = z.object({
  jobs: z.array(z.object({
    id: z.string(),
    job_type: z.literal("third_party_enrichment"),
    status: z.enum(["pending", "running", "succeeded", "failed", "timeout"]),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    error_message: z.string().nullable(),
    result_json: z.record(z.unknown()).nullable(),
  })),
  enrichment: z.record(z.unknown()).nullable().describe("Latest persisted snapshot, if any."),
});

// ---- Map assets: enrichment (retrieve snapshot) ----
// The route returns the snapshot object directly (not wrapped), matching how
// the existing client code + use-map-asset-detail-data hook consume it. The
// schema must follow the wire shape so generated OpenAPI clients stay valid.
export const GetEnrichmentResponse = z.record(z.unknown()).describe(
  "MapAssetEnrichmentSnapshot — returned directly, not wrapped under `snapshot`.",
);

// ---- Map assets: search ----
export const MapSearchRequestBody = z.object({
  query: z.string().describe("Free-text search query"),
  limit: z.number().int().positive().max(200).optional().describe("Max results to return (default 50)"),
});
export const MapSearchSuggestionsQuery = z.object({
  q: z.string().describe("In-progress query fragment"),
  limit: z.number().int().positive().max(50).optional().describe("Max suggestions to return (default 6)"),
});
const SearchFilterChipSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(["subject", "relation"]).optional(),
  operatorLabel: z.string().optional(),
  objectLabel: z.string().optional(),
});
const MapSearchDocumentGeometryRefSchema = z.object({
  kind: z.enum(["candidate", "geojson_feature", "overlay_feature", "road_aggregate"]),
  candidateId: z.string().optional(),
  geojsonFeatureId: z.number().optional(),
  geojsonFeatureIds: z.array(z.number()).optional(),
  overlayLayerId: z.string().optional(),
  overlayFeatureId: z.string().optional(),
});
const CentroidSchema = z.tuple([z.number(), z.number()]);
const TopologyPathStepSchema = z.object({
  objectId: z.string(),
  cumulativeM: z.number(),
  title: z.string().optional(),
  kind: z.string().optional(),
  centroid: CentroidSchema.optional(),
});
const RelatedObjectRefSchema = z.object({
  objectId: z.string(),
  relation: z.enum([
    "near",
    "adjacent_to",
    "within",
    "leads_to",
    "connected_to",
    "upstream_of",
    "downstream_of",
  ]),
  distance_m: z.number().optional(),
  title: z.string().optional(),
  subtype: z.string().optional(),
  objectFamily: z.enum(["junction", "street", "poi"]).optional(),
  geometryReference: MapSearchDocumentGeometryRefSchema.optional(),
  centroid: CentroidSchema.optional(),
  path: z.array(TopologyPathStepSchema).optional(),
  pathTruncated: z.boolean().optional(),
});
const MapSearchResultSchema = z.object({
  id: z.string(),
  candidateId: z.string(),
  objectFamily: z.enum(["junction", "street", "poi"]),
  subtype: z.string(),
  title: z.string(),
  description: z.string(),
  exactMapAttributes: z.array(z.string()),
  relatedObjects: z.array(z.string()),
  relatedObjectRefs: z.array(RelatedObjectRefSchema).optional(),
  scenarioTags: z.array(z.string()),
  candidateConfidence: z.number(),
  matchReasons: z.array(z.string()),
  geometryReference: MapSearchDocumentGeometryRefSchema.optional(),
  centroid: CentroidSchema.optional(),
});
const MapSearchParseHintSchema = z.object({
  code: z.string(),
  message: z.string(),
});
export const MapSearchResponse = z.object({
  query: z.string(),
  chips: z.array(SearchFilterChipSchema),
  results: z.array(MapSearchResultSchema),
  /** Leftover tokens after family + semantic aliases consume their matches.
   *  Surfaced for the in-panel debug view while search features are iterated. */
  freeText: z.array(z.string()),
  /** Diagnostics surfaced when a relation operator couldn't be fully resolved. */
  parseHints: z.array(MapSearchParseHintSchema).optional(),
});
export const MapSearchSuggestionsResponse = z.object({
  suggestions: z.array(z.object({
    id: z.string(),
    label: z.string(),
    applyValue: z.string(),
  })),
});

// ---- Map assets: LLM search (conversational) ----
//
// Multi-turn natural-language candidate-location chat. The user holds a
// conversation with Claude about which locations on the map match the
// scenario they want to build. Each request submits the entire chat history
// plus a fresh user turn; the response is a single new assistant turn that
// may include text, ranked candidate suggestions (drawn from the same
// indexed corpus the keyword search uses), and follow-up prompt chips. The
// LLM never invents object ids — any ids it returns that aren't in the
// corpus are dropped server-side before the response is built.
const MapSearchLlmRoleSchema = z.enum(["user", "assistant"]);
const MapSearchLlmInputMessageSchema = z.object({
  role: MapSearchLlmRoleSchema,
  content: z
    .string()
    .trim()
    .min(1, "Message content cannot be empty")
    .max(4000, "Message is too long"),
});
export const MapSearchLlmRequestBody = z.object({
  messages: z
    .array(MapSearchLlmInputMessageSchema)
    .min(1, "messages must contain at least the latest user turn")
    .max(40, "Too many turns — start a new conversation")
    // The conversation must end with a user turn — the assistant only ever
    // produces a single new turn, so a transcript that ends in `assistant`
    // is malformed input, not a runtime failure. Catching it at the schema
    // level surfaces it as a 400 instead of leaking out of the service as 500.
    .refine(
      (msgs) => msgs[msgs.length - 1]?.role === "user",
      { message: "the last message must be from the user" },
    ),
  maxCandidates: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe("Max candidates to return per turn (default 6)"),
});
const MapSearchLlmCandidateSchema = MapSearchResultSchema.extend({
  llmScore: z
    .number()
    .min(0)
    .max(1)
    .describe("Fit score 0–1 assigned by the LLM"),
  llmRationale: z
    .string()
    .describe("One-to-two sentence explanation of why this object fits the prompt"),
  llmAffordances: z
    .array(z.string())
    .describe("Scenario affordances the LLM keyed on for this candidate"),
});
// Structured-query record echoed back so the AI Search panel's debug
// toggle can show under-the-hood: what subject + relation the LLM
// composed for the user prompt, what came back. Lean — top-5 results
// only — so the wire payload doesn't bloat with full result sets the
// debug surface doesn't need.
const MapSearchLlmStructuredObjectIntentSchema = z.object({
  families: z.array(z.enum(["junction", "street", "poi"])).optional(),
  semantic: z.array(z.string()).optional(),
  freeText: z.array(z.string()).optional(),
});
const MapSearchLlmToolCallSchema = z.object({
  callIndex: z.number().int().nonnegative(),
  structured: z.object({
    subject: MapSearchLlmStructuredObjectIntentSchema,
    relation: z
      .object({
        op: z.enum([
          "near",
          "adjacent_to",
          "within",
          "leads_to",
          "connected_to",
          "upstream_of",
          "downstream_of",
        ]),
        distance_m: z.number().positive().optional(),
        object: MapSearchLlmStructuredObjectIntentSchema,
      })
      .optional(),
  }),
  limit: z.number().int().positive().optional(),
  result: z.object({
    totalDocuments: z.number().int().nonnegative(),
    resultCount: z.number().int().nonnegative(),
    parseHints: z
      .array(z.object({ code: z.string(), message: z.string() }))
      .optional(),
    topResults: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        subtype: z.string(),
        family: z.string(),
      }),
    ),
  }),
});
// Scenario drafts the assistant created during this turn via the
// `propose_scenario_draft` tool. The panel renders an "Open in editor"
// affordance per entry; the route is the same destination the manual
// "Create blank scenario" path lands on. Empty when the turn was
// discovery-only.
const MapSearchLlmProposedScenarioSchema = z.object({
  scenarioId: z.string(),
  datasetId: z.string(),
  mapAssetId: z.string(),
  /** Document id the LLM picked from the corpus (search_map result or catalog id). */
  documentId: z.string(),
  /** Backing CandidateLocation.id when the document was candidate-backed; null otherwise. */
  candidateId: z.string().nullable(),
  /** Human-readable label used as the scenario's display_name. */
  displayName: z.string(),
  /** Pre-built editor href the panel can link to without re-deriving. */
  editorHref: z.string(),
  /** Collision family the populated-draft builder instantiated. Null when the
   *  draft came from the legacy location-only path (no family selected). */
  family: z.string().nullable().default(null),
  /** Number of actors the builder placed. Null on the legacy path. */
  actorCount: z.number().int().nonnegative().nullable().default(null),
  /** Markdown summary the panel renders inside the draft-created card —
   *  family, intent, location, aggressiveness, environment, success
   *  condition, planner rationale. Null on the legacy location-only path. */
  description: z.string().nullable().default(null),
});
const MapSearchLlmAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z
    .string()
    .describe("Conversational reply text — explains, narrows, or asks a clarifying question"),
  candidates: z
    .array(MapSearchLlmCandidateSchema)
    .describe("Optional ranked candidate cards to show beneath the message"),
  followUps: z
    .array(z.string())
    .describe("Suggested user follow-up prompts; the UI renders these as one-tap chips"),
  toolCalls: z
    .array(MapSearchLlmToolCallSchema)
    .describe(
      "Per-turn structured queries the LLM made + their result summaries. Empty when no `search_map` calls happened (catalog fast-path or graceful empty turn).",
    ),
  proposedScenarios: z
    .array(MapSearchLlmProposedScenarioSchema)
    .default([])
    .describe(
      "Scenario drafts created this turn via the `propose_scenario_draft` tool. The UI renders an 'Open in editor' button per entry. Empty when the turn was discovery-only.",
    ),
  reasoning: z
    .array(z.string())
    .default([])
    .describe(
      "Extended-thinking text emitted by the model, one entry per tool-loop iteration. Populated only when ANTHROPIC_THINKING_ENABLED=true (dev only by default). Visible in the panel's debug toggle for inspecting the LLM's reasoning between tool calls. Empty when thinking is disabled or on graceful empty turns.",
    ),
});
export const MapSearchLlmResponse = z.object({
  mapAssetId: z.string(),
  /** Single new assistant turn produced for this request. */
  message: MapSearchLlmAssistantMessageSchema,
  /** Total documents the LLM considered (after any pre-filter). */
  consideredDocuments: z.number(),
  /** Total documents in the underlying map corpus. */
  totalDocuments: z.number(),
  /** True when the corpus was capped before being shown to the LLM. */
  corpusTruncated: z.boolean(),
});

// ---- Map assets: reverse-geocode ----
export const ReverseGeocodeQuery = z.object({
  lat: z.number().describe("Latitude"),
  lon: z.number().describe("Longitude"),
});
export const ReverseGeocodeResponse = z.object({
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  country_code: z.string().optional(),
});

// ---- Candidate locations ----
export const CandidateLocationsResponse = z.object({
  mapAssetId: z.string(),
  locations: z.array(CandidateLocationSchema),
  count: z.number(),
});
export const CandidateLocationsDeleteResponse = z.object({
  ok: z.literal(true),
  mapAssetId: z.string(),
});
export const CrossMapCandidateLocationsResponse = z.object({
  tag: z.string(),
  results: z.array(z.object({
    map_asset_id: z.string(),
    map_name: z.string().optional(),
    locations: z.array(CandidateLocationSchema),
  })),
  total: z.number(),
});

// ---- Scenario runtime ----
export const ScenarioRuntimeRenderJobIdParams = z.object({
  jobId: z.string().min(1),
});
export const ScenarioRuntimeSimulationJobIdParams = z.object({
  jobId: z.string().min(1),
});
export const ScenarioRuntimeArtifactIdParams = z.object({
  artifactId: z.string().min(1),
});
export const ScenarioRuntimeRenderJobListQuery = z.object({
  scenarioId: z.string().optional(),
  editorDocumentId: z.string().optional(),
  datasetId: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().optional(),
});
export const ScenarioRuntimeArtifactListQuery = z.object({
  jobId: z.string().optional(),
  scenarioId: z.string().optional(),
  editorDocumentId: z.string().optional(),
  datasetSnapshotId: z.string().optional(),
  artifactType: z.string().optional(),
  modality: z.string().optional(),
  sensorId: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().optional(),
});
export const ScenarioRuntimeArtifactMetadataQuery = z.object({
  source: z.enum(["object"]).optional(),
});
export const ScenarioRuntimeCancelRenderJobBody = z.object({
  reason: z.string().trim().optional(),
});
export const ScenarioRuntimeCancelSimulationJobBody = z.object({
  reason: z.string().trim().optional(),
});
export const ScenarioRuntimeDeleteRenderJobResponse = z.object({
  deleted: z.literal(true),
  id: z.string().min(1),
});
