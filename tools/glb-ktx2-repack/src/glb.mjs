/**
 * Minimal GLB container codec.
 *
 * Deliberately NOT glTF-Transform: the whole point of this tool is to touch
 * image payloads only. glTF-Transform 4.x decodes/re-encodes
 * EXT_meshopt_compression on write, changing geometry identity (see
 * docs/product/runtime-surface-materials.md "Pinned KTX toolchain"). Here the
 * JSON chunk is edited as plain JSON and the BIN chunk is rebuilt from byte
 * slices, so untouched ranges stay byte-identical.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_BIN = 0x004e4942; // 'BIN\0'

/** @returns {{ json: object, bin: Buffer }} */
export function parseGlb(buf) {
  if (buf.length < 12 || buf.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('not a GLB file');
  }
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
  const total = buf.readUInt32LE(8);
  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset + 8 <= total) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const body = buf.subarray(offset + 8, offset + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(body.toString('utf8'));
    else if (type === CHUNK_BIN) bin = body;
    offset += 8 + len;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  return { json, bin };
}

/** @returns {Buffer} */
export function writeGlb(json, bin) {
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
  if (jsonPad) jsonBytes = Buffer.concat([jsonBytes, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = (4 - (bin.length % 4)) % 4;
  const paddedBin = binPad ? Buffer.concat([bin, Buffer.alloc(binPad, 0)]) : bin;
  const total = 12 + 8 + jsonBytes.length + 8 + paddedBin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonBytes.length, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonBytes.copy(out, 20);
  const binHeader = 20 + jsonBytes.length;
  out.writeUInt32LE(paddedBin.length, binHeader);
  out.writeUInt32LE(CHUNK_BIN, binHeader + 4);
  paddedBin.copy(out, binHeader + 8);
  return out;
}
