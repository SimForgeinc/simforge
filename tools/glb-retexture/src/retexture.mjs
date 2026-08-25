import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { parseGlb, writeGlb } from '../../glb-ktx2-repack/src/glb.mjs';
import { verifyGeometryIdentity } from '../../glb-ktx2-repack/src/repack.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const align4 = (value) => (value + 3) & ~3;

function imageBytes(parsed, image) {
  if (!Number.isInteger(image.bufferView)) throw new Error(`external image ${image.name ?? '<unnamed>'} is unsupported`);
  const view = parsed.json.bufferViews[image.bufferView];
  const offset = view.byteOffset ?? 0;
  return parsed.bin.subarray(offset, offset + view.byteLength);
}

function mimeFor(file) {
  if (/\.png$/i.test(file)) return 'image/png';
  if (/\.webp$/i.test(file)) return 'image/webp';
  if (/\.jpe?g$/i.test(file)) return 'image/jpeg';
  throw new Error(`unsupported replacement image extension: ${file}`);
}

export function scanImageHashes(glb, forbiddenHashes) {
  const parsed = parseGlb(glb);
  const forbidden = new Set(forbiddenHashes.map((hash) => hash.toLowerCase()));
  return (parsed.json.images ?? []).flatMap((image, index) => {
    const digest = sha256(imageBytes(parsed, image));
    return forbidden.has(digest) ? [{ index, name: image.name ?? null, sha256: digest }] : [];
  });
}

export function retextureGlb(source, manifest, { manifestDir = process.cwd() } = {}) {
  const parsed = parseGlb(source);
  const json = structuredClone(parsed.json);
  const replacements = new Map();
  const rows = [];
  for (let index = 0; index < (parsed.json.images ?? []).length; index++) {
    const image = parsed.json.images[index];
    const entry = manifest.replacements?.[image.name];
    if (!entry) continue;
    const file = typeof entry === 'string' ? entry : entry.file;
    const absolute = path.resolve(manifestDir, file);
    const bytes = fs.readFileSync(absolute);
    replacements.set(image.bufferView, { bytes, index, mimeType: mimeFor(file) });
    rows.push({
      image: index,
      name: image.name ?? null,
      sourceSha256: sha256(imageBytes(parsed, image)),
      replacementSha256: sha256(bytes),
      replacement: file,
      class: typeof entry === 'string' ? null : entry.class ?? null,
      scaleFactor: typeof entry === 'string' ? 1 : entry.scaleFactor ?? 1,
      license: typeof entry === 'string' ? null : entry.license ?? null,
    });
  }
  const required = new Set(manifest.requiredImageNames ?? []);
  for (const row of rows) required.delete(row.name);
  if (required.size) throw new Error(`required image names not present: ${[...required].join(', ')}`);
  if (!rows.length) throw new Error('manifest matched no embedded image names');

  const segments = [];
  (parsed.json.bufferViews ?? []).forEach((view, viewIndex) => {
    const meshopt = view.extensions?.EXT_meshopt_compression;
    if (meshopt && (meshopt.buffer ?? 0) === 0) {
      segments.push({ viewIndex, kind: 'meshopt', offset: meshopt.byteOffset ?? 0, length: meshopt.byteLength });
    }
    if ((view.buffer ?? 0) !== 0) return;
    if (json.buffers?.[view.buffer ?? 0]?.extensions?.EXT_meshopt_compression?.fallback) return;
    segments.push({ viewIndex, kind: replacements.has(viewIndex) ? 'image' : 'view', offset: view.byteOffset ?? 0, length: view.byteLength });
  });
  segments.sort((a, b) => a.offset - b.offset || a.length - b.length);
  for (let index = 1; index < segments.length; index++) {
    const previous = segments[index - 1];
    const current = segments[index];
    if (current.offset < previous.offset + previous.length && !(current.offset === previous.offset && current.length === previous.length)) {
      throw new Error(`overlapping buffer ranges ${previous.viewIndex}/${current.viewIndex}`);
    }
  }

  const parts = [];
  let cursor = 0;
  for (const segment of segments) {
    const replacement = replacements.get(segment.viewIndex);
    const bytes = segment.kind === 'image' ? replacement.bytes : parsed.bin.subarray(segment.offset, segment.offset + segment.length);
    const start = align4(cursor);
    if (start > cursor) parts.push(Buffer.alloc(start - cursor));
    parts.push(bytes);
    cursor = start + bytes.length;
    const view = json.bufferViews[segment.viewIndex];
    if (segment.kind === 'meshopt') view.extensions.EXT_meshopt_compression.byteOffset = start;
    else {
      view.byteOffset = start;
      if (segment.kind === 'image') {
        view.byteLength = bytes.length;
        json.images[replacement.index].mimeType = replacement.mimeType;
      }
    }
  }
  const bin = Buffer.concat(parts);
  json.buffers[0].byteLength = bin.length;
  const glb = writeGlb(json, bin);
  const geometry = verifyGeometryIdentity(source, glb);
  if (!geometry.ok) throw new Error(`geometry identity failed: ${JSON.stringify(geometry.failures)}`);
  return {
    glb,
    report: {
      replacements: rows.sort((a, b) => a.name.localeCompare(b.name)),
      geometry: { identical: true, ranges: geometry.ranges.length, digest: sha256(Buffer.from(geometry.ranges.map((range) => range.sha256).join('\n'))) },
      sourceSha256: sha256(source),
      outputSha256: sha256(glb),
    },
  };
}
