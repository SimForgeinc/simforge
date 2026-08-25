import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { MapDraftIdSchema } from "@/app/lib/map-ingest/contracts";
import { requireRouteSession } from "@/app/lib/auth/route-session";
import { getAppContext } from "@/app/lib/db/app-context";
import { queryOne } from "@/app/lib/db/data-api";
import { upsertMapAsset } from "@/app/lib/db/map-asset-store";
import { S3_BUCKET } from "@/app/lib/s3/s3-config";
import {
  requireScenarioMutationOrigin,
} from "@/app/lib/scenario/http";
import { buildCityManifest, buildSemantics } from "@/app/lib/map-ingest/server/city-manifest";
import { buildMapColliderDerivative } from "@/app/lib/map-ingest/server/colliders";
import { publishedMapReleaseId } from "@/app/lib/map-ingest/server/release-id";
import { buildDerivedArtifacts, MAP_INTEL_BUILDER_VERSION } from "@/app/lib/map-ingest/server/derived";
import { buildRoadSidecars } from "@/app/lib/map-ingest/server/sidecars";
import {
  getMapUploadDraft,
  mapSlugFromLabel,
  markMapUploadDraftFailed,
  markMapUploadDraftPublished,
  markMapUploadDraftPublishing,
} from "@/app/lib/map-ingest/server/store";
import {
  mapClosureKey,
  mapUploadKey,
  readMapUpload,
  storeMapClosureMember,
  verifyMapUpload,
} from "@/app/lib/map-ingest/server/storage";
import type { MapClosureMember } from "@/app/lib/map-ingest/server/storage";
import { planUploadedMapClosure } from "@/app/lib/map-ingest/server/closure";
import { publishUploadedMapVersion } from "@/app/lib/map-ingest/server/publication";
import { simforgeEnv } from "@/lib/compat-env";

export const maxDuration = 300;

const RoadwayReportSchema = z.object({
  format: z.string(),
  validatorVersion: z.string(),
  verdict: z.string(),
  stats: z.record(z.string(), z.unknown()),
  sourceDigests: z.object({
    xodrSha256: z.string().regex(/^[a-f0-9]{64}$/),
    topologySha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRoadGeometrySha256: z.string().regex(/^[a-f0-9]{64}$/),
    finalRoadSha256: z.string().regex(/^[a-f0-9]{64}$/),
    roadAuditSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
});
const LocationsSchema = z.object({ catalogRevision: z.string().min(1) });

type PublicationBindingRow = {
  derivative_release_id: string;
  asset_catalog_version_id: string;
};

type ClosureIdentity = {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  bucket: string;
  key: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}


function errorReason(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "map publication failed";
}

function generatedMember(
  relativePath: string,
  mediaType: string,
  bytes: Buffer,
): MapClosureMember {
  return {
    relativePath,
    mediaType,
    bytes,
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
  };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ draftId: string }> },
) {
  const originError = requireScenarioMutationOrigin(request);
  if (originError) return originError;

  const auth = await requireRouteSession(request);
  if (!auth.ok) return auth.response;

  const parsedDraftId = MapDraftIdSchema.safeParse((await params).draftId);
  if (!parsedDraftId.success) {
    return auth.apply(
      NextResponse.json(
        { error: "invalid_map_upload_publish", details: parsedDraftId.error.flatten() },
        { status: 400 },
      ),
    );
  }

  const context = getAppContext(auth.session);
  const draft = await getMapUploadDraft(parsedDraftId.data);
  if (!draft) {
    return auth.apply(NextResponse.json({ error: "map_upload_not_found" }, { status: 404 }));
  }
  if (draft.workspaceId !== context.workspaceId) {
    return auth.apply(NextResponse.json({ error: "map_upload_forbidden" }, { status: 403 }));
  }
  if (draft.state === "published") {
    return auth.apply(
      NextResponse.json({ error: "map_upload_already_published" }, { status: 409 }),
    );
  }
  if (draft.state === "publishing") {
    return auth.apply(
      NextResponse.json({ error: "map_upload_already_publishing" }, { status: 409 }),
    );
  }

  try {
    const authored = [
      { path: "map.xodr", sha256: draft.xodrSha256, byteLength: draft.xodrByteLength },
      ...draft.layers
        .slice()
        .sort((left, right) => left.layerId.localeCompare(right.layerId))
        .map((layer) => ({
          path: `3d/${layer.layerId}.glb`,
          sha256: layer.sha256,
          byteLength: layer.byteLength,
        })),
      {
        path: "thumbnail.webp",
        sha256: draft.thumbnailSha256,
        byteLength: draft.thumbnailByteLength,
      },
    ];
    for (const member of authored) {
      const verification = await verifyMapUpload(member.sha256, member.byteLength);
      if (!verification.ok) {
        throw new Error(`map upload member ${member.path} ${verification.reason}`);
      }
    }

    const claimed = await markMapUploadDraftPublishing(draft.id, draft.workspaceId);
    if (!claimed) throw new Error("map upload draft could not enter publishing state");

    // The thumbnail is never read back: it is already verified in place at its
    // content-addressed key, and the artifact row it gets registered under
    // points straight at those bytes.
    const [xodrBytes, ...layerBytes] = await Promise.all([
      readMapUpload(draft.xodrSha256),
      ...draft.layers.map((layer) => readMapUpload(layer.sha256)),
    ]);
    const xodrText = xodrBytes.toString("utf8");
    const generatorLayers = draft.layers.map((layer, index) => ({
      layerId: layer.layerId,
      fileName: `${layer.layerId}.glb`,
      bytes: layerBytes[index]!,
    }));
    const city = buildCityManifest(generatorLayers);
    const semantics = buildSemantics(generatorLayers);
    if (!semantics) throw new Error("map semantics generation produced no document");
    const sidecars = buildRoadSidecars({
      xodrText,
      xodrSha256: draft.xodrSha256,
      mapName: draft.sourceMapId,
    });
    const roadLayerIndex = draft.layers.findIndex((layer) => layer.layerId === "road");
    if (roadLayerIndex < 0) throw new Error("map upload requires a road layer");
    const derived = buildDerivedArtifacts({
      // map-intel brands this with asMapId (^[a-z0-9][a-z0-9-]*$), and it becomes
      // part of every derived location identity, so it takes the logical slug —
      // not the underscored provenance id.
      mapId: mapSlugFromLabel(draft.label),
      xodrText,
      xodrSha256: draft.xodrSha256,
      topologyIndex: sidecars.topology.index,
      topologyBytes: sidecars.topology.bytes,
      lanePolygonsJson: sidecars.lanePolygons.json,
      signalsJson: sidecars.signals.json,
      manifest: city.manifest,
      roadGlbBytes: layerBytes[roadLayerIndex]!,
    });

    const colliders = buildMapColliderDerivative({
      mapId: mapSlugFromLabel(draft.label),
      manifest: city.manifest,
      manifestBytes: city.bytes,
      topologyIndex: sidecars.topology.index,
      layers: generatorLayers,
    });

    const generated = [
      generatedMember("3d/manifest.json", "application/json", city.bytes),
      generatedMember("3d/semantics.json", "application/json", semantics.bytes),
      generatedMember("topology-index.json.gz", "application/gzip", sidecars.topology.bytes),
      generatedMember("lane-polygons.geojson.gz", "application/gzip", sidecars.lanePolygons.bytes),
      generatedMember("signals.geojson.gz", "application/gzip", sidecars.signals.bytes),
      generatedMember("derived/topology-derived.json.gz", "application/gzip", derived.derivedTopology.bytes),
      generatedMember("derived/locations.json.gz", "application/gzip", derived.locations.bytes),
      generatedMember(
        "derived/roadway-consistency.json.gz",
        "application/gzip",
        derived.roadwayConsistency.bytes,
      ),
      // Without these two the map renders but the browser simulation refuses it:
      // @simforge/playback fetches variants/manifest.json beside the city
      // manifest and fails closed when the static-collider variant is absent.
      generatedMember(
        colliders.variantManifest.relativePath,
        "application/json",
        colliders.variantManifest.bytes,
      ),
      generatedMember(colliders.artifact.relativePath, "application/json", colliders.artifact.bytes),
    ].sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    const artifactBucket = simforgeEnv("ARTIFACT_BUCKET")?.trim();
    if (!artifactBucket) throw new Error("SIMFORGE_ARTIFACT_BUCKET is required.");

    // The authored bytes are promoted into the immutable artifact bucket rather
    // than referenced where the browser staged them. `map-uploads/` is a staging
    // area the client can write to; the closure a map version binds must live
    // entirely in the environment-fenced artifact bucket, so every member —
    // authored or generated — is stored the same way and located the same way.
    const closureAuthored = [
      {
        relativePath: "map.xodr",
        sha256: draft.xodrSha256,
        byteLength: draft.xodrByteLength,
        mediaType: "application/xml",
        bytes: xodrBytes,
      },
      ...draft.layers.map((layer, index) => ({
        relativePath: `3d/${layer.layerId}.glb`,
        sha256: layer.sha256,
        byteLength: layer.byteLength,
        mediaType: "model/gltf-binary",
        bytes: layerBytes[index]!,
      })),
    ];
    await Promise.all(
      [...closureAuthored, ...generated].map((member) => storeMapClosureMember(member)),
    );

    const closureMembers: ClosureIdentity[] = [...closureAuthored, ...generated].map((member) => ({
      relativePath: member.relativePath,
      sha256: member.sha256,
      byteLength: member.byteLength,
      mediaType: member.mediaType,
      bucket: artifactBucket,
      key: mapClosureKey(member.sha256),
    }));

    const binding = await queryOne<PublicationBindingRow>(
      `SELECT id AS derivative_release_id, asset_catalog_version_id
       FROM simforge.editor_asset_releases
       WHERE workspace_id = :workspace_id AND release_state = 'active'
       LIMIT 1`,
      { workspace_id: draft.workspaceId },
    );
    if (!binding) throw new Error("active editor asset release not found for workspace");

    await upsertMapAsset({
      map_asset_id: draft.sourceMapId,
      name: draft.label,
      carla_map_name: draft.carlaMapName,
      description: `Uploaded map for ${draft.locality}`,
      crs: "OpenDRIVE",
      bbox: { min_lat: 0, min_lng: 0, max_lat: 0, max_lng: 0 },
      center: { lat: 0, lng: 0 },
      created_at: draft.createdAt,
      artifacts: [
        {
          artifact_type: "xodr",
          uri: `s3://${S3_BUCKET}/${mapUploadKey(draft.xodrSha256)}`,
          sha256: draft.xodrSha256,
          size_bytes: draft.xodrByteLength,
          created_at: draft.createdAt,
        },
        {
          artifact_type: "thumbnail",
          uri: `s3://${S3_BUCKET}/${mapUploadKey(draft.thumbnailSha256)}`,
          sha256: draft.thumbnailSha256,
          size_bytes: draft.thumbnailByteLength,
          created_at: draft.createdAt,
        },
      ],
      tags: [],
      map_source: { tool: "SimCloud map upload" },
      place_context: { city: draft.locality, geocoder: "manual" },
    });

    // The release id carries a content discriminator so republishing a map whose
    // bytes changed produces a new version instead of colliding with the old one.
    const derivativeReleaseId = publishedMapReleaseId({
      activeReleaseId: binding.derivative_release_id,
      members: closureMembers,
    });
    const plan = planUploadedMapClosure({
      workspaceId: draft.workspaceId,
      sourceMapId: draft.sourceMapId,
      derivativeReleaseId,
      manifest: city.manifest,
      members: closureMembers,
    });
    const roadwayReport = RoadwayReportSchema.parse(
      JSON.parse(gunzipSync(derived.roadwayConsistency.bytes).toString("utf8")),
    );
    const locations = LocationsSchema.parse(
      JSON.parse(gunzipSync(derived.locations.bytes).toString("utf8")),
    );
    const sourceHashes = {
      xodr: draft.xodrSha256,
      "topology-index": sha256(sidecars.topology.bytes),
      "lane-polygons": sha256(sidecars.lanePolygons.bytes),
      signals: sha256(sidecars.signals.bytes),
    };
    const outputs = {
      locations: {
        path: "derived/locations.json.gz",
        sha256: sha256(derived.locations.bytes),
        sizeBytes: derived.locations.bytes.byteLength,
      },
      derivedTopology: {
        path: "derived/topology-derived.json.gz",
        sha256: sha256(derived.derivedTopology.bytes),
        sizeBytes: derived.derivedTopology.bytes.byteLength,
      },
    };
    const receipt = {
      contractVersion: "uniscenario.map-intel-build/v1",
      builder: { package: "@simforge/maps", version: MAP_INTEL_BUILDER_VERSION },
      mapId: mapSlugFromLabel(draft.label),
      catalogRevision: locations.catalogRevision,
      sourceHashes,
      outputs,
      locationsBytes: derived.locations.bytes.byteLength,
      derivedBytes: derived.derivedTopology.bytes.byteLength,
    };
    const map = await publishUploadedMapVersion({
      draftId: draft.id,
      plan,
      workspaceId: draft.workspaceId,
      sourceMapId: draft.sourceMapId,
      sourceMapAssetId: draft.sourceMapId,
      assetCatalogVersionId: binding.asset_catalog_version_id,
      derivativeReleaseId,
      label: draft.label,
      locality: draft.locality,
      carlaMapName: draft.carlaMapName,
      provenance: {
        kind: "map-upload",
        draftId: draft.id,
        createdByUserId: draft.createdByUserId,
      },
      thumbnail: {
        bucket: S3_BUCKET,
        key: mapUploadKey(draft.thumbnailSha256),
        sha256: draft.thumbnailSha256,
        byteLength: draft.thumbnailByteLength,
        mediaType: "image/webp",
        recipe: "client-rendered-map-upload/v1",
        sourceBucket: S3_BUCKET,
        sourceKey: mapUploadKey(draft.thumbnailSha256),
      },
      mapIntel: {
        ...receipt,
        receiptSha256: sha256(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`)),
        locationCount: derived.locations.count,
        laneCount: Object.keys(sidecars.topology.index.lanes).length,
        junctionCount: Object.keys(sidecars.topology.index.junctions).length,
        roadwayConsistency: {
          ...roadwayReport,
          artifactSha256: sha256(derived.roadwayConsistency.bytes),
        },
      },
      triangleCount: draft.layers.reduce((sum, layer) => sum + layer.triangleCount, 0),
    });
    await markMapUploadDraftPublished(draft.id, draft.workspaceId, map.mapVersionId);

    return auth.apply(
      NextResponse.json(
        { map },
        { headers: { "Cache-Control": "private, no-store" } },
      ),
    );
  } catch (error) {
    const reason = errorReason(error);
    await markMapUploadDraftFailed(draft.id, draft.workspaceId, reason);
    return auth.apply(NextResponse.json({ error: reason }, { status: 409 }));
  }
}
