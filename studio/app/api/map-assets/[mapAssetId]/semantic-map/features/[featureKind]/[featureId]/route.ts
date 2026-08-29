import { NextRequest, NextResponse } from "next/server";
import {
  RuntimeTopologyFamilySchema,
} from "@simforge-oss/maps/topology";
import { z } from "zod";
import { getCurrentSession } from "@/app/lib/auth/session";
import { getMapAssetByIdFromDb } from "@/app/lib/db/map-asset-store";
import {
  readAcceptedSemanticGraphPublication,
  SemanticGraphPublicationError,
} from "@/app/lib/maps/topology/server/semantic-graph-publication-store";

const FeatureKindSchema = z.enum([
  "corridor",
  "approach",
  "movement",
  "variant",
  "conflict_zone",
  "environment_feature",
]);

type RouteContext = {
  params: Promise<{ mapAssetId: string; featureKind: string; featureId: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  if (!(await getCurrentSession())) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }
  const runtime = RuntimeTopologyFamilySchema.safeParse(request.nextUrl.searchParams.get("runtime"));
  if (!runtime.success) {
    return NextResponse.json({ error: "A valid runtime is required." }, { status: 400 });
  }
  const params = await context.params;
  const featureKind = FeatureKindSchema.safeParse(params.featureKind);
  if (!featureKind.success) {
    return NextResponse.json({ error: "Unsupported semantic feature kind." }, { status: 400 });
  }
  if (!(await getMapAssetByIdFromDb(params.mapAssetId))) {
    return NextResponse.json({ error: "Map asset not found." }, { status: 404 });
  }

  try {
    const publication = await readAcceptedSemanticGraphPublication({
      mapAssetId: params.mapAssetId,
      runtime: runtime.data,
    });
    if (!publication) {
      return NextResponse.json(
        { error: "No accepted semantic map publication exists.", code: "semantic_publication_missing" },
        { status: 422 },
      );
    }
    const { semanticMap: graph, semanticFeatureGraph: featureGraph, manifest } = publication;
    const id = params.featureId;
    const diagnostics = graph.diagnostics.filter((item) => item.entityId === id);
    let entity: unknown = null;
    let related: Record<string, unknown> = {};

    switch (featureKind.data) {
      case "corridor": {
        entity = graph.corridors.find((item) => item.id === id) ?? null;
        const approaches = graph.approaches.filter((item) => item.corridorIds.includes(id));
        const variants = graph.movementVariants.filter(
          (item) => item.incomingCorridorId === id || item.outgoingCorridorId === id,
        );
        const movementIds = new Set(variants.map((item) => item.movementId));
        related = {
          approaches,
          movementVariants: variants,
          movements: graph.movements.filter((item) => movementIds.has(item.id)),
        };
        break;
      }
      case "approach": {
        entity = graph.approaches.find((item) => item.id === id) ?? null;
        const approach = entity as (typeof graph.approaches)[number] | null;
        related = approach ? {
          corridors: graph.corridors.filter((item) => approach.corridorIds.includes(item.id)),
          movements: graph.movements.filter((item) => approach.movementIds.includes(item.id)),
        } : {};
        break;
      }
      case "movement": {
        entity = graph.movements.find((item) => item.id === id) ?? null;
        const movement = entity as (typeof graph.movements)[number] | null;
        related = movement ? {
          approaches: graph.approaches.filter(
            (item) => item.id === movement.incomingApproachId || item.id === movement.outgoingApproachId,
          ),
          movementVariants: graph.movementVariants.filter((item) => movement.variantIds.includes(item.id)),
          conflictZones: graph.conflictZones.filter((item) => movement.conflictZoneIds.includes(item.id)),
        } : {};
        break;
      }
      case "variant": {
        entity = graph.movementVariants.find((item) => item.id === id) ?? null;
        const variant = entity as (typeof graph.movementVariants)[number] | null;
        related = variant ? {
          movement: graph.movements.find((item) => item.id === variant.movementId) ?? null,
          corridors: graph.corridors.filter(
            (item) => item.id === variant.incomingCorridorId || item.id === variant.outgoingCorridorId,
          ),
        } : {};
        break;
      }
      case "conflict_zone": {
        entity = graph.conflictZones.find((item) => item.id === id) ?? null;
        const zone = entity as (typeof graph.conflictZones)[number] | null;
        related = zone ? {
          movements: graph.movements.filter((item) => zone.movementIds.includes(item.id)),
          movementVariants: graph.movementVariants.filter((item) =>
            zone.encounters.some(
              (encounter) => encounter.leftVariantId === item.id || encounter.rightVariantId === item.id,
            )),
        } : {};
        break;
      }
      case "environment_feature": {
        entity = featureGraph.features.find((item) => item.id === id) ?? null;
        const relations = featureGraph.relations.filter(
          (item) => item.fromFeatureId === id || item.toFeatureId === id,
        );
        const relatedIds = new Set(relations.flatMap((item) => [item.fromFeatureId, item.toFeatureId]));
        relatedIds.delete(id);
        related = {
          relations,
          features: featureGraph.features.filter((item) => relatedIds.has(item.id)),
        };
        break;
      }
    }

    if (!entity) {
      return NextResponse.json({ error: "Semantic feature not found." }, { status: 404 });
    }
    return NextResponse.json({
      schemaVersion: "simforge.semantic-feature-detail.v1",
      publicationRevision: manifest.publicationRevision,
      graphRevision: graph.graphRevision,
      kind: featureKind.data,
      entity,
      diagnostics,
      related,
    }, { headers: { "cache-control": "private, max-age=60" } });
  } catch (error) {
    if (error instanceof SemanticGraphPublicationError) {
      return NextResponse.json(
        { error: "The accepted semantic map publication failed integrity validation.", code: error.code },
        { status: 503 },
      );
    }
    console.error("semantic map feature route error", error);
    return NextResponse.json({ error: "Failed to read semantic map feature." }, { status: 500 });
  }
}
