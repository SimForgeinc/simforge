import { crc32 } from "./png";

export type DeterministicZipEntry = Readonly<{ path: string; bytes: Uint8Array }>;

const encoder = new TextEncoder();
const UTF8_FLAG = 0x0800;
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01, the earliest ZIP timestamp.

/** Store-only ZIP with lexical entry order, fixed timestamps, and no ambient metadata. */
export function writeDeterministicZip(entries: readonly DeterministicZipEntry[]): Uint8Array {
  const ordered = entries.map((entry) => ({ ...entry, name: validatedName(entry.path) }))
    .sort((left, right) => compareBytes(left.name, right.name));
  for (let index = 1; index < ordered.length; index += 1) {
    if (equalBytes(ordered[index - 1]!.name, ordered[index]!.name)) {
      throw new Error(`Duplicate ZIP entry path: ${ordered[index]!.path}`);
    }
  }

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;
  for (const entry of ordered) {
    const checksum = crc32(entry.bytes);
    const local = new Uint8Array(30 + entry.name.byteLength + entry.bytes.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, UTF8_FLAG, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, DOS_TIME, true);
    localView.setUint16(12, DOS_DATE, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.bytes.byteLength, true);
    localView.setUint32(22, entry.bytes.byteLength, true);
    localView.setUint16(26, entry.name.byteLength, true);
    local.set(entry.name, 30);
    local.set(entry.bytes, 30 + entry.name.byteLength);
    localParts.push(local);

    const central = new Uint8Array(46 + entry.name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, UTF8_FLAG, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, DOS_TIME, true);
    centralView.setUint16(14, DOS_DATE, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.bytes.byteLength, true);
    centralView.setUint32(24, entry.bytes.byteLength, true);
    centralView.setUint16(28, entry.name.byteLength, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true);
    central.set(entry.name, 46);
    centralParts.push(central);
    localOffset += local.byteLength;
  }

  if (ordered.length > 0xffff || localOffset > 0xffffffff) {
    throw new Error("ZIP64 is not supported by deterministic sensor archives.");
  }
  const centralSize = centralParts.reduce((total, part) => total + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, ordered.length, true);
  endView.setUint16(10, ordered.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, localOffset, true);
  return concat(...localParts, ...centralParts, end);
}

export function sensorFramePath(sensorId: string, outputFrameIndex: number, extension: "png" | "ply" | "csv"): string {
  if (!sensorId || sensorId.includes("/") || sensorId.includes("\\") || sensorId === "." || sensorId === "..") {
    throw new Error("Sensor id cannot contain a path separator.");
  }
  if (!Number.isSafeInteger(outputFrameIndex) || outputFrameIndex < 0 || outputFrameIndex > 99_999_999) {
    throw new Error("Output frame index must fit the eight-digit artifact layout.");
  }
  return `${sensorId}/${outputFrameIndex.toString().padStart(8, "0")}.${extension}`;
}

function validatedName(path: string): Uint8Array {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Unsafe ZIP entry path: ${path}`);
  }
  const name = encoder.encode(path);
  if (name.byteLength > 0xffff) throw new Error("ZIP entry path is too long.");
  return name;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
