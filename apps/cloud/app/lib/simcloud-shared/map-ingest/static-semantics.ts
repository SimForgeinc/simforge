import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { readGlb } from "./glb";

export const STATIC_SEMANTICS_SCHEMA = "uniscenario.static-semantics/v1";
export const STATIC_SEMANTIC_CLASSES = Object.freeze([
  "road", "sidewalk", "building", "vegetation", "pole", "traffic_light",
  "traffic_sign", "furniture", "terrain", "other",
] as const);

export type StaticSemanticClass = (typeof STATIC_SEMANTIC_CLASSES)[number];

const SEMANTIC_NAME_RULES: ReadonlyArray<readonly [StaticSemanticClass, RegExp]> = Object.freeze([
  ["traffic_light", /(?:traffic[_ .-]*light|stop[_ .-]*light|signal[_ .-]*(?:head|light))/i],
  ["traffic_sign", /(?:traffic[_ .-]*sign|road[_ .-]*sign|street[_ .-]*sign|signpost)/i],
  ["sidewalk", /(?:sidewalk|footpath|walkway|pavement|curb)/i],
  ["building", /(?:building|house|garage|warehouse|structure|facade|roof)/i],
  ["vegetation", /(?:vegetation|tree|shrub|bush|grass|plant|foliage|flower)/i],
  ["pole", /(?:pole|bollard|lamppost|lightpost)/i],
  ["furniture", /(?:bench|table|chair|trash|bin|mailbox|hydrant|furniture)/i],
  ["terrain", /(?:terrain|ground|landscape|soil|earth)/i],
  ["road", /(?:road|asphalt|lane|street|highway|crosswalk|marking)/i],
]);

function semanticClass(name: string, role: string): StaticSemanticClass {
  if (role === "vegetation") return "vegetation";
  for (const [className, pattern] of SEMANTIC_NAME_RULES) {
    if (pattern.test(name)) return className;
  }
  if (role === "static") return "road";
  return "other";
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value))}\n`;
}

export type StaticSemanticsInput = {
  sourcePath: string;
  role: string;
  bytes: Buffer;
};

export type StaticSemanticObject = {
  node: string;
  class: StaticSemanticClass;
  instanceId: number;
};

export type StaticSemantics = {
  schema: typeof STATIC_SEMANTICS_SCHEMA;
  classes: StaticSemanticClass[];
  objects: StaticSemanticObject[];
};

export type StaticSemanticsBuild = {
  semantics: StaticSemantics;
  bytes: Buffer;
};

/**
 * Instance ids use content identities so unrelated additions cannot renumber
 * existing authored objects.
 */
export function buildStaticSemantics(glbs: readonly StaticSemanticsInput[]): StaticSemanticsBuild {
  const instanceIds = new Map<number, string>();
  const objectByNode = new Map<string, StaticSemanticObject>();
  const nodeByViewerName = new Map<string, string>();
  for (const glb of [...glbs].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath))) {
    const { json } = readGlb(glb.bytes);
    for (const node of json.nodes ?? []) {
      if (typeof node.name !== "string" || node.name.length === 0) continue;
      const className = semanticClass(node.name, glb.role);
      const priorNode = objectByNode.get(node.name);
      if (priorNode) {
        if (priorNode.class !== className) {
          throw new Error(`conflicting static semantic class for node: ${node.name}`);
        }
        // Repeated authored names let every LOD receive the same stable id.
        continue;
      }
      const viewerName = node.name.replace(/\s/g, "_").replace(/[\[\]\.:/]/g, "");
      const priorViewerNode = nodeByViewerName.get(viewerName);
      if (priorViewerNode) {
        throw new Error(`static semantic nodes collide in the viewer: ${priorViewerNode} and ${node.name}`);
      }
      const identity = sha256(Buffer.from(`${STATIC_SEMANTICS_SCHEMA}\0${node.name}`));
      const instanceId = 1 + (Number.parseInt(identity.slice(0, 8), 16) % 0xffffff);
      const priorId = instanceIds.get(instanceId);
      if (priorId) {
        // Order-dependent probing would let unrelated nodes renumber existing ids.
        throw new Error(`static semantic instance id collision: ${priorId} and ${node.name}`);
      }
      instanceIds.set(instanceId, node.name);
      objectByNode.set(node.name, { node: node.name, class: className, instanceId });
      nodeByViewerName.set(viewerName, node.name);
    }
  }
  const objects = [...objectByNode.values()].sort((a, b) => a.node.localeCompare(b.node));
  const semantics: StaticSemantics = {
    schema: STATIC_SEMANTICS_SCHEMA,
    classes: [...STATIC_SEMANTIC_CLASSES],
    objects,
  };
  return { semantics, bytes: Buffer.from(canonicalJson(semantics)) };
}
