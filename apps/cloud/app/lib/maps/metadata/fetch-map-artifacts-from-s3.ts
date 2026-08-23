import { getMapArtifactLocation } from "@/app/lib/db/map-asset-store";
import { getS3ObjectUtf8 } from "@/app/lib/s3/s3-get-object";

/** Raw text contents of the three required map artifact files. */
export type FetchedMapArtifacts = {
  geojsonText: string;
  xodrText: string;
  rrdataXmlText: string;
};

/** Fetch the required map artifact texts by looking up S3 locations from the database. */
export async function fetchRequiredMapArtifactTexts(
  mapAssetId: string,
): Promise<{ ok: true; data: FetchedMapArtifacts } | { ok: false; missing: string[] }> {
  const [geo, xodr, rr] = await Promise.all([
    getMapArtifactLocation(mapAssetId, "geojson"),
    getMapArtifactLocation(mapAssetId, "xodr"),
    getMapArtifactLocation(mapAssetId, "rrdata_xml"),
  ]);

  const missing: string[] = [];
  if (!geo) missing.push("geojson");
  if (!xodr) missing.push("xodr");
  if (!rr) missing.push("rrdata_xml");
  if (missing.length > 0) return { ok: false, missing };

  // Guard above guarantees required locations exist; narrow for strict TS.
  const geoSafe = geo as { bucket: string; key: string };
  const xodrSafe = xodr as { bucket: string; key: string };
  const rrSafe = rr as { bucket: string; key: string };

  const [geojsonText, xodrText, rrdataXmlText] = await Promise.all([
    getS3ObjectUtf8(geoSafe.bucket, geoSafe.key),
    getS3ObjectUtf8(xodrSafe.bucket, xodrSafe.key),
    getS3ObjectUtf8(rrSafe.bucket, rrSafe.key),
  ]);

  return {
    ok: true,
    data: { geojsonText, xodrText, rrdataXmlText },
  };
}
