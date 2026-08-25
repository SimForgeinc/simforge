import { NextRequest, NextResponse } from "next/server";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getAppContext } from "@/app/lib/db/app-context";
import { getBridgedMapBundleByAssetId } from "@/app/lib/editor-map/bridged-map";
import { executeEditorTool } from "@/app/lib/editor-tools/registry";
import type { EditorToolId, EditorToolInput } from "@/app/lib/editor-tools/types";
import type { MapLocation } from "@/app/lib/editor-map/types";

type ExecuteBody = {
  mapAssetId?: string;
  tool?: EditorToolId;
  input?: EditorToolInput;
  selectedRoadIds?: string[];
  selectedLocation?: MapLocation | null;
};

export async function POST(request: NextRequest) {
  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const rawBody = await request.json().catch(() => null);
  if (rawBody == null || typeof rawBody !== "object") {
    return auth.apply(
      NextResponse.json({ error: "invalid_json" }, { status: 400 }),
    );
  }
  const body = rawBody as ExecuteBody;
  const mapAssetId = body.mapAssetId?.trim();
  if (!mapAssetId) {
    return auth.apply(
      NextResponse.json({ error: "mapAssetId is required." }, { status: 400 }),
    );
  }

  if (!body.tool) {
    return auth.apply(
      NextResponse.json({ error: "tool is required." }, { status: 400 }),
    );
  }

  try {
    const bundle = await getBridgedMapBundleByAssetId(mapAssetId, {
      includeDerivedLocations: false,
    });

    const execution = await executeEditorTool(body.tool, body.input ?? {}, {
      appContext: getAppContext(auth.session),
      mapAssetId,
      bundle,
      selectedRoadIds: Array.isArray(body.selectedRoadIds)
        ? body.selectedRoadIds.filter((roadId): roadId is string => typeof roadId === "string")
        : [],
      selectedLocation: body.selectedLocation ?? null,
    });

    return auth.apply(
      NextResponse.json({
        ok: execution.ok,
        result: execution.result,
        uiActions: execution.uiActions,
        modelSummary: execution.modelSummary,
      }),
    );
  } catch (error) {
    console.error("scenario tool-execute error:", error);
    return auth.apply(
      NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Failed to execute scenario editor tool",
        },
        { status: 502 },
      ),
    );
  }
}
