import { NextRequest, NextResponse } from "next/server";
import { ScenarioEditorRoadAnchorSchema } from "@simcloud/shared";
import { z } from "zod";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import { resolveRuntimeActorRoutes } from "@/app/lib/scenario-editor/runtime-route-planner-server";

type RouteContext = { params: Promise<{ mapAssetId: string }> };

const RuntimeRoutesRequestSchema = z.object({
  runtime: z.literal("carla_ue5"),
  routes: z
    .array(
      z.object({
        actor_id: z.string().min(1),
        anchors: z.array(ScenarioEditorRoadAnchorSchema).min(2).max(200),
      }),
    )
    .max(64),
});

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;
  const parsed = RuntimeRoutesRequestSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!parsed.success) {
    return auth.apply(
      NextResponse.json(
        { error: "Valid CARLA route anchors are required." },
        { status: 400 },
      ),
    );
  }

  const { mapAssetId } = await context.params;
  const asset = await getMapAssetByIdFromDb(mapAssetId);
  if (!asset) {
    return auth.apply(
      NextResponse.json({ error: "Map asset not found." }, { status: 404 }),
    );
  }
  try {
    const resolutions = await resolveRuntimeActorRoutes({
      asset,
      routes: parsed.data.routes.map((route) => ({
        actorId: route.actor_id,
        anchors: route.anchors,
      })),
    });
    return auth.apply(
      NextResponse.json(
        {
          schema_version: "simforge.runtime-routes.v1",
          resolutions,
        },
        { headers: { "cache-control": "private, no-store" } },
      ),
    );
  } catch (error) {
    console.error("runtime route resolution failed", error);
    return auth.apply(
      NextResponse.json(
        { error: "CARLA runtime route resolution is unavailable." },
        { status: 422 },
      ),
    );
  }
}
