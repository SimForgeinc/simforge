import { NextRequest, NextResponse } from "next/server";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getAppContext } from "@/app/lib/db/app-context";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  searchMapLocationsLlm,
  LlmSearchUnavailableError,
  type InspectLocationGeometryToolInput,
  type ProposeScenarioDraftToolFn,
} from "@/app/lib/maps/search/server/map-search-llm-service";
import {
  inspectLocationGeometry,
  type GeometryReport,
} from "@/app/lib/maps/search/server/inspect-location-geometry";
import { ScenarioDraftBridgeError } from "@/app/lib/scenario-editor/draft-generator";
import { buildCollisionScenarioDraft } from "@/app/lib/llm/scenario-generation/collision-scenario-builder";
import { buildRevisionHint } from "@/app/lib/maps/search/server/revision-hint";
import {
  MapAssetIdParams,
  MapSearchLlmRequestBody,
  MapSearchLlmResponse,
} from "@/app/lib/api-schemas";
void MapAssetIdParams;
void MapSearchLlmRequestBody;
void MapSearchLlmResponse;

type RouteContext = { params: Promise<{ mapAssetId: string }> };

/**
 * Rank candidate locations against a natural-language prompt using Claude.
 * @description The same indexed corpus the keyword search uses, but ranked by
 *   an LLM so users can describe the scene they want and get back a small set
 *   of fits with per-pick rationale. The LLM is constrained to the catalog
 *   we hand it — no hallucinated ids reach the response.
 * @pathParams MapAssetIdParams
 * @body MapSearchLlmRequestBody
 * @response 200:MapSearchLlmResponse
 * @responseSet common
 * @add 404
 * @add 503
 * @tag Map assets
 * @openapi
 */
export async function POST(req: NextRequest, { params }: RouteContext) {
  const { mapAssetId } = await params;
  if (!mapAssetId?.trim()) {
    return NextResponse.json({ error: "Missing mapAssetId" }, { status: 400 });
  }

  const asset = await getMapAssetByIdFromDb(mapAssetId);
  if (!asset) {
    return NextResponse.json({ error: "Map asset not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = MapSearchLlmRequestBody.safeParse(body);
  if (!parseResult.success) {
    return NextResponse.json(
      { error: "Invalid request body", issues: parseResult.error.issues },
      { status: 400 },
    );
  }

  const { messages, maxCandidates } = parseResult.data;

  // The propose_scenario_draft + inspect_location_geometry tools require a
  // logged-in workspace context (the propose path writes to the scenarios
  // + datasets tables; the inspect path reads runtime road bundles tied
  // to the map). When the request has no session we leave both unwired —
  // the LLM still does discovery, matching the unauthed-search behavior
  // this route had pre-bridge. CARLA-incompatible maps (no carla_map_name)
  // also disable the tools to avoid the model proposing drafts that can
  // never run.
  const session = await getCurrentSession();
  const carlaReady = !!asset.carla_map_name?.trim();
  const collisionToolsEnabled = session != null && carlaReady;

  const inspectGeometryCallable:
    | ((input: InspectLocationGeometryToolInput) => Promise<GeometryReport>)
    | undefined = collisionToolsEnabled
    ? async (input) => {
        return inspectLocationGeometry({
          mapAsset: asset,
          documentId: input.documentId,
          ...(input.radius_m != null ? { radius_m: input.radius_m } : {}),
        });
      }
    : undefined;

  const proposeScenarioDraft: ProposeScenarioDraftToolFn | undefined =
    collisionToolsEnabled
      ? async (input) => {
          const context = getAppContext(session!);
          try {
            const draft = await buildCollisionScenarioDraft({
              context,
              mapAsset: {
                map_asset_id: asset.map_asset_id,
                name: asset.name,
                carla_map_name: asset.carla_map_name ?? null,
              },
              documentId: input.documentId,
              documentLabel: input.documentLabel,
              candidateId: input.candidateId,
              family: input.family,
              intent: input.intent,
              aggressivenessLabel: input.aggressivenessLabel,
              npcVehicleType: input.npcVehicleType,
              geometry: input.geometry,
              approachGeometries: input.approachGeometries,
            });
            return {
              scenarioId: draft.scenarioId,
              datasetId: draft.datasetId,
              mapAssetId: draft.mapAssetId,
              documentId: draft.documentId,
              candidateId: draft.candidateId,
              displayName: draft.displayName,
              editorHref: draft.editorHref,
              family: draft.family,
              actorCount: draft.actorCount,
              description: draft.description,
              validation: {
                verdict: draft.validation.verdict,
                reasons: draft.validation.reasons,
                repairAttempted: draft.validation.repair?.attempted ?? false,
                repairSucceeded: draft.validation.repair?.succeeded ?? false,
                needsRevision: draft.validation.verdict === "fail",
                revisionHint: buildRevisionHint(draft.validation),
              },
              plannerDebug: draft.plannerDebug ?? null,
            };
          } catch (err) {
            if (err instanceof ScenarioDraftBridgeError) {
              // Re-throw with the same message so the LLM can surface it
              // to the user via respond_to_user. The service-level wrapper
              // catches and converts to a tool error message.
              throw new Error(err.message);
            }
            throw err;
          }
        }
      : undefined;

  try {
    const result = await searchMapLocationsLlm({
      mapAssetId,
      messages,
      maxCandidates,
      ...(proposeScenarioDraft ? { proposeScenarioDraft } : {}),
      ...(inspectGeometryCallable ? { inspectLocationGeometry: inspectGeometryCallable } : {}),
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof LlmSearchUnavailableError) {
      return NextResponse.json(
        {
          error: "AI search is not configured for this environment",
          code: "llm_unavailable",
        },
        { status: 503 },
      );
    }
    console.error("[map-search-llm] failed:", err);
    return NextResponse.json(
      { error: "AI search failed. Please try again or use keyword search." },
      { status: 500 },
    );
  }
}
