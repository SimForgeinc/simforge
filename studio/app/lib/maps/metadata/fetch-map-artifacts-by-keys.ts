import type { MapAssetArtifactType } from "@simforge/studio-shared";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";
import type { FetchedMapArtifacts } from "./fetch-map-artifacts-from-s3";

/** Fetch the required map artifact texts (GeoJSON, XODR, rrdata XML) from explicit S3 keys. */
export async function fetchRequiredMapArtifactTextsFromKeys(
  bucket: string,
  artifacts: Array<{ artifact_type: MapAssetArtifactType; key: string }>,
): Promise<{ ok: true; data: FetchedMapArtifacts } | { ok: false; missing: string[] }> {
  const byType = (t: MapAssetArtifactType) => artifacts.find((a) => a.artifact_type === t)?.key;

  const geoKey = byType("geojson");
  const xodrKey = byType("xodr");
  const rrKey = byType("rrdata_xml");

  const missing: string[] = [];
  if (!geoKey) missing.push("geojson");
  if (!xodrKey) missing.push("xodr");
  if (!rrKey) missing.push("rrdata_xml");
  if (missing.length > 0) return { ok: false, missing };

  // Guard above guarantees required keys exist; narrow for strict TS.
  const geoKeySafe = geoKey as string;
  const xodrKeySafe = xodrKey as string;
  const rrKeySafe = rrKey as string;

  const [geojsonText, xodrText, rrdataXmlText] = await Promise.all([
    getS3ObjectUtf8(bucket, geoKeySafe),
    getS3ObjectUtf8(bucket, xodrKeySafe),
    getS3ObjectUtf8(bucket, rrKeySafe),
  ]);

  return {
    ok: true,
    data: { geojsonText, xodrText, rrdataXmlText },
  };
}
