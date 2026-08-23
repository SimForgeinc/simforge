import { createHash } from "node:crypto";
import { posix } from "node:path";

export const BROWSER_ASSET_SET_CONTRACT = "uniscenario.browser-asset-set/v1";

export const REQUIRED_BROWSER_MEMBERS = Object.freeze([
  "3d/manifest.json",
  "map.xodr",
  "topology-index.json.gz",
  "lane-polygons.geojson.gz",
  "signals.geojson.gz",
  "derived/topology-derived.json.gz",
  "derived/locations.json.gz",
  "derived/roadway-consistency.json.gz",
] as const);

const SHA256 = /^[a-f0-9]{64}$/;

const ARTIFACT_KIND_BY_PATH = Object.freeze({
  "map.xodr": "source-map-xodr",
  "topology-index.json.gz": "map-topology-v2",
  "derived/topology-derived.json.gz": "map-derived-topology-v2",
  "derived/locations.json.gz": "map-locations-v2",
  "derived/roadway-consistency.json.gz": "map-roadway-consistency-v1",
  "signals.geojson.gz": "map-signals-v2",
  "3d/manifest.json": "map-browser-manifest-v2",
  "3d/semantics.json": "map-static-semantics-v1",
} satisfies Record<string, string>);

export type UploadedMapClosureMemberInput = {
  relativePath: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  bucket: string;
  key: string;
  objectVersionId?: string | null;
};

export type UploadedMapClosureMember = UploadedMapClosureMemberInput & {
  objectVersionId: string | null;
  role: "manifest" | "environment" | "geometry" | "texture" | "runtime" | "metadata";
  required: boolean;
  blobId: string;
  artifactKind: string | null;
  artifactId: string | null;
};

export type UploadedMapClosurePlan = {
  contractVersion: typeof BROWSER_ASSET_SET_CONTRACT;
  id: string;
  workspaceId: string;
  mapVersionId: string;
  sourceMapId: string;
  derivativeReleaseId: string;
  closureSha256: string;
  sumoNetworkSha256: string | null;
  objectCount: number;
  byteLength: number;
  members: UploadedMapClosureMember[];
};

export type PlanUploadedMapClosureInput = {
  workspaceId: string;
  sourceMapId: string;
  derivativeReleaseId: string;
  manifest: unknown;
  members: UploadedMapClosureMemberInput[];
};

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateRelativePath(value: string) {
  if (
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    value.includes("//") ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`invalid_browser_asset_path:${value}`);
  }
  return value;
}

function role(relativePath: string): UploadedMapClosureMember["role"] {
  if (relativePath === "3d/manifest.json" || relativePath.endsWith("/manifest.json")) {
    return "manifest";
  }
  if (relativePath.startsWith("3d/env/")) return "environment";
  if (/\.(?:glb|bin)$/i.test(relativePath)) return "geometry";
  if (/\.(?:webp|png|jpe?g|ktx2)$/i.test(relativePath)) return "texture";
  if (/\.(?:js|wasm)$/i.test(relativePath)) return "runtime";
  return "metadata";
}

function artifactKind(relativePath: string) {
  return ARTIFACT_KIND_BY_PATH[relativePath as keyof typeof ARTIFACT_KIND_BY_PATH] ?? null;
}

function parseManifest(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new Error("browser_bundle_invalid_manifest");
    }
  }
  if (value instanceof Uint8Array) {
    return parseManifest(new TextDecoder().decode(value));
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("browser_bundle_invalid_manifest");
  }
  return value;
}

function explicitManifestReferences(manifest: unknown) {
  const references = new Set<string>(["3d/manifest.json"]);
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if ((key === "file" || key === "instanceFile") && typeof child === "string") {
        references.add(validateRelativePath(posix.join("3d", child)));
      } else {
        visit(child);
      }
    }
  };
  visit(parseManifest(manifest));
  return references;
}

/**
 * These identity formulas are kept byte-for-byte equivalent to
 * scripts/lib/uniscenario-browser-bundle.mjs, the operator publisher's original source.
 */
export function planUploadedMapClosure(input: PlanUploadedMapClosureInput): UploadedMapClosurePlan {
  if (!input.workspaceId || !input.sourceMapId || !input.derivativeReleaseId) {
    throw new Error("workspaceId, sourceMapId, and derivativeReleaseId are required");
  }

  const paths = new Set<string>();
  const sortedInputs = [...input.members].sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
  );
  for (const member of sortedInputs) {
    validateRelativePath(member.relativePath);
    if (paths.has(member.relativePath)) {
      throw new Error(`browser_bundle_duplicate_member:${member.relativePath}`);
    }
    paths.add(member.relativePath);
    if (!SHA256.test(member.sha256)) {
      throw new Error(`browser_bundle_invalid_member_digest:${member.relativePath}`);
    }
    if (!Number.isSafeInteger(member.byteLength) || member.byteLength < 0) {
      throw new Error(`browser_bundle_invalid_member_size:${member.relativePath}`);
    }
    if (!member.mediaType || !member.bucket || !member.key) {
      throw new Error(`browser_bundle_invalid_member_storage:${member.relativePath}`);
    }
  }

  for (const required of REQUIRED_BROWSER_MEMBERS) {
    if (!paths.has(required)) throw new Error(`browser_bundle_required_member_missing:${required}`);
  }
  for (const reference of explicitManifestReferences(input.manifest)) {
    if (!paths.has(reference)) throw new Error(`browser_bundle_reference_missing:${reference}`);
  }

  const mapVersionId = `usmap_${sha256(`${input.workspaceId}\0${input.sourceMapId}\0${input.derivativeReleaseId}`).slice(0, 32)}`;
  const members = sortedInputs.map((member): UploadedMapClosureMember => {
    const memberRole = role(member.relativePath);
    const required = !/(?:^|\/)(?:colliders?|static-collider)(?:\/|\.|$)/i.test(member.relativePath);
    const kind = artifactKind(member.relativePath);
    return {
      ...member,
      objectVersionId: member.objectVersionId ?? null,
      role: memberRole,
      required,
      blobId: `usblob_${sha256(`${member.sha256}\0${member.byteLength}\0${member.mediaType}`).slice(0, 32)}`,
      artifactKind: kind,
      artifactId: kind
        ? `usart_${sha256(`${input.workspaceId}\0${mapVersionId}\0${kind}\0${member.sha256}`).slice(0, 32)}`
        : null,
    };
  });
  const closureMembers = members.map(({ bucket: _bucket, key: _key, objectVersionId: _objectVersionId,
    blobId: _blobId, artifactKind: _artifactKind, artifactId: _artifactId, ...member }) => member);
  const closureSha256 = sha256(canonicalJson({
    contractVersion: BROWSER_ASSET_SET_CONTRACT,
    members: closureMembers,
  }));

  return {
    contractVersion: BROWSER_ASSET_SET_CONTRACT,
    id: `usbset_${sha256(`${input.workspaceId}\0${mapVersionId}\0${closureSha256}`).slice(0, 32)}`,
    workspaceId: input.workspaceId,
    mapVersionId,
    sourceMapId: input.sourceMapId,
    derivativeReleaseId: input.derivativeReleaseId,
    closureSha256,
    sumoNetworkSha256:
      members.find((member) => member.relativePath === "derived/sumo/map.net.xml")?.sha256 ?? null,
    objectCount: members.length,
    byteLength: members.reduce((sum, member) => sum + member.byteLength, 0),
    members,
  };
}
