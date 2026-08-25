import { Buffer } from "node:buffer";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

export type GlbJson = {
  buffers?: Array<{ uri?: unknown; [key: string]: unknown }>;
  nodes?: Array<{ name?: string; [key: string]: unknown }>;
  materials?: Array<{ name?: string; [key: string]: unknown }>;
  meshes?: Array<{
    name?: string;
    primitives?: Array<{ material?: number; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
};

export type GlbDocument = {
  json: GlbJson;
  bin: Buffer;
};

export function readGlb(buffer: Buffer): GlbDocument {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC || buffer.readUInt32LE(4) !== 2) {
    throw new Error("Expected a binary glTF 2.0 file");
  }
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error("GLB length header mismatch");
  let offset = 12;
  let json: GlbJson | null = null;
  let bin = Buffer.alloc(0);
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const payload = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === JSON_CHUNK) {
      json = JSON.parse(payload.toString("utf8").replace(/[\0 ]+$/, "")) as GlbJson;
    } else if (type === BIN_CHUNK) {
      bin = Buffer.from(payload);
    }
    offset += 8 + length;
  }
  if (!json) throw new Error("GLB has no JSON chunk");
  if ((json.buffers ?? []).some((entry) => entry.uri)) {
    throw new Error("External buffers are unsupported; refusing a partial derivative");
  }
  return { json, bin };
}
