import { createHash } from "node:crypto";
import { GET, PUT } from "../app/api/local-objects/[bucket]/[...key]/route";
import { LOCAL_ARTIFACT_BUCKET } from "../app/lib/db/config";
import { getPresignedGetUrl, getPresignedPutUrl } from "../app/lib/s3/s3-presign";

const bytes = Buffer.from("uniscenarios-local-object-roundtrip\n");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const key = "smoke/roundtrip.txt";
const context = {
  params: Promise.resolve({ bucket: LOCAL_ARTIFACT_BUCKET, key: key.split("/") }),
};
const putUrl = await getPresignedPutUrl(key, "text/plain", LOCAL_ARTIFACT_BUCKET, 60, sha256);
const putResponse = await PUT(new Request(putUrl, {
  method: "PUT",
  body: bytes,
  headers: { "content-type": "text/plain", "content-length": String(bytes.byteLength) },
}), context);
if (!putResponse.ok) throw new Error(`PUT failed: ${putResponse.status}`);
const getUrl = await getPresignedGetUrl(key, LOCAL_ARTIFACT_BUCKET);
const getResponse = await GET(new Request(getUrl), context);
const received = new Uint8Array(await getResponse.arrayBuffer());
const receivedSha256 = createHash("sha256").update(received).digest("hex");
if (receivedSha256 !== sha256) throw new Error("local object round-trip checksum mismatch");
console.log(`local object round-trip: ${received.byteLength} bytes sha256=${receivedSha256}`);
