import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { posix, resolve, sep } from "node:path";
import { nativeMasterResources } from "../app/lib/map-ingest/native-master-resources";

const SHA256 = /^[a-f0-9]{64}$/u;
const MAP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type NativeReadyPayload = {
  relativePath: string;
  path: string;
  sha256: string;
  sizeBytes: number;
};

export type NativeReadyMap = {
  mapDigest: string;
  releaseDigest: string;
  corpusDir: string;
  masterPath: string;
  payloads: NativeReadyPayload[];
};

/** A failure with a stable API/worker error code. */
export class HifiPreviewFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type InstallationMember = { sha256: string; bytes: number };
type InstallationReceipt = {
  schema: "simforge.map-installation.v1";
  name: string;
  version: string;
  releaseDigest: string;
  canonicalDigest: string;
  webDigest?: string;
  profile: "semantic" | "native" | "web";
  members: Record<string, InstallationMember>;
};

function safeMemberPath(relativePath: string): boolean {
  return relativePath.length > 0
    && !/[\\:%?#\u0000-\u001f]/u.test(relativePath)
    && relativePath.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isInstallationMember(value: unknown): value is InstallationMember {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && "sha256" in value && typeof value.sha256 === "string" && SHA256.test(value.sha256)
    && "bytes" in value && Number.isSafeInteger(value.bytes) && Number(value.bytes) >= 0;
}

function isReceipt(value: unknown): value is InstallationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !("schema" in value) || value.schema !== "simforge.map-installation.v1"
    || !("name" in value) || typeof value.name !== "string" || value.name.length === 0
    || !("version" in value) || typeof value.version !== "string" || value.version.length === 0
    || !("releaseDigest" in value) || typeof value.releaseDigest !== "string" || !SHA256.test(value.releaseDigest)
    || !("canonicalDigest" in value) || typeof value.canonicalDigest !== "string" || !SHA256.test(value.canonicalDigest)
    || !("profile" in value) || value.profile !== "native"
    || !("members" in value) || !value.members || typeof value.members !== "object" || Array.isArray(value.members)) return false;
  if ("webDigest" in value
    && value.webDigest !== undefined
    && (typeof value.webDigest !== "string" || !SHA256.test(value.webDigest))) return false;
  return Object.entries(value.members).every(([relativePath, member]) =>
    safeMemberPath(relativePath)
    && relativePath !== ".map-release.json"
    && isInstallationMember(member));
}

async function digestFile(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

/** Validate active runtime resources, not unused archival raster fallbacks. */
async function validateMasterClosure(corpusDir: string, receipt: InstallationReceipt): Promise<void> {
  const masterPath = resolve(corpusDir, "master.gltf");
  let document: unknown;
  try {
    document = JSON.parse(await readFile(masterPath, "utf8"));
  } catch (error) {
    throw new HifiPreviewFailure("native_payload_master_invalid", "native master.gltf is not valid JSON", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!document || typeof document !== "object" || Array.isArray(document)
    || !("asset" in document)
    || !document.asset || typeof document.asset !== "object" || Array.isArray(document.asset)
    || !("version" in document.asset) || document.asset.version !== "2.0") {
    throw new HifiPreviewFailure("native_payload_master_invalid", "native master.gltf is not glTF 2.0");
  }
  for (const uri of nativeMasterResources(document)) {
    const memberPath = posix.normalize(uri);
    if (!safeMemberPath(memberPath) || !receipt.members[memberPath]) {
      throw new HifiPreviewFailure(
        "native_payload_resource_missing",
        `master.gltf references undeclared native member: ${uri}`,
        { relativePath: uri },
      );
    }
  }
}

/**
 * Resolve exactly the common-cache native installation for an immutable map
 * version. The receipt and every declared member are checked before a path is
 * handed to the renderer; an old corpus or another registry release can never
 * satisfy this lookup.
 */
export async function resolveNativeReadyMap(input: {
  mapId: string;
  releaseDigest: string;
  corpusRoot: string;
}): Promise<NativeReadyMap> {
  if (!MAP_NAME.test(input.mapId) || !SHA256.test(input.releaseDigest)) {
    throw new HifiPreviewFailure("native_payload_identity_invalid", "native map identity is invalid", {
      mapId: input.mapId,
      releaseDigest: input.releaseDigest,
    });
  }
  const corpusRoot = resolve(input.corpusRoot);
  const corpusDir = resolve(corpusRoot, input.mapId);
  if (!corpusDir.startsWith(`${corpusRoot}${sep}`)) {
    throw new HifiPreviewFailure("native_payload_identity_invalid", "native map path escapes the corpus root", {
      mapId: input.mapId,
    });
  }
  const receiptPath = resolve(corpusDir, ".map-release.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch (error) {
    throw new HifiPreviewFailure("native_payload_unavailable", `native installation is unavailable for ${input.mapId}`, {
      mapId: input.mapId,
      releaseDigest: input.releaseDigest,
      corpusDir,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!isReceipt(parsed)
    || parsed.name !== input.mapId
    || parsed.releaseDigest !== input.releaseDigest) {
    throw new HifiPreviewFailure("native_payload_receipt_mismatch", `native installation does not match ${input.mapId}`, {
      mapId: input.mapId,
      releaseDigest: input.releaseDigest,
      corpusDir,
    });
  }
  if (!parsed.members["master.gltf"]) {
    throw new HifiPreviewFailure("native_payload_master_missing", `native installation has no master.gltf for ${input.mapId}`, {
      mapId: input.mapId,
      releaseDigest: input.releaseDigest,
      corpusDir,
    });
  }

  const payloads: NativeReadyPayload[] = [];
  for (const [relativePath, expected] of Object.entries(parsed.members).sort(([left], [right]) => left.localeCompare(right))) {
    const path = resolve(corpusDir, ...relativePath.split("/"));
    if (!path.startsWith(`${corpusDir}${sep}`)) {
      throw new HifiPreviewFailure("native_payload_member_invalid", `native member path is unsafe: ${relativePath}`);
    }
    let sizeBytes: number;
    let actualSha256: string;
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) throw new Error("not a regular file");
      sizeBytes = metadata.size;
      actualSha256 = await digestFile(path);
    } catch (error) {
      throw new HifiPreviewFailure("native_payload_member_missing", `native member is unavailable: ${relativePath}`, {
        mapId: input.mapId,
        releaseDigest: input.releaseDigest,
        relativePath,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (sizeBytes !== expected.bytes || actualSha256 !== expected.sha256) {
      throw new HifiPreviewFailure("native_payload_member_mismatch", `native member does not match its receipt: ${relativePath}`, {
        mapId: input.mapId,
        releaseDigest: input.releaseDigest,
        relativePath,
        expectedSha256: expected.sha256,
        actualSha256,
        expectedSizeBytes: expected.bytes,
        actualSizeBytes: sizeBytes,
      });
    }
    payloads.push({
      relativePath,
      path,
      sha256: expected.sha256,
      sizeBytes,
    });
  }
  await validateMasterClosure(corpusDir, parsed);
  const master = payloads.find((payload) => payload.relativePath === "master.gltf")!;
  return {
    mapDigest: input.releaseDigest,
    releaseDigest: input.releaseDigest,
    corpusDir,
    masterPath: master.path,
    payloads,
  };
}
