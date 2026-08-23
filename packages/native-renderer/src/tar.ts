/**
 * Deterministic POSIX ustar writer.
 *
 * The native engine packages per-sensor pass frames into tar archives rather
 * than zip so the container bytes are fully deterministic (no timestamps,
 * no uid/gid, fixed field values) — the artifact hashes must be stable
 * across runs for the golden-hash policy.
 */

const BLOCK = 512;

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

function octal(value: number, length: number): string {
  // Zero-padded octal, trailing NUL + space per ustar convention.
  const digits = value.toString(8);
  return `${'0'.repeat(Math.max(0, length - digits.length - 1))}${digits}\0`;
}

function writeString(header: Uint8Array, offset: number, value: string, length: number): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`tar field overflow: ${value}`);
  header.set(bytes, offset);
}

function checksum(header: Uint8Array): number {
  let sum = 0;
  for (const byte of header) sum += byte;
  return sum;
}

export function createTar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(BLOCK);
    writeString(header, 0, entry.name, 100);
    writeString(header, 100, '0000644', 8); // mode
    writeString(header, 108, '0000000', 8); // uid
    writeString(header, 116, '0000000', 8); // gid
    writeString(header, 124, octal(entry.data.length, 12), 12); // size
    writeString(header, 136, octal(0, 12), 12); // mtime: epoch — determinism
    writeString(header, 148, '        ', 8); // checksum placeholder (spaces)
    header[156] = 0x30; // typeflag '0' regular file
    writeString(header, 257, 'ustar\0', 6);
    writeString(header, 263, '00', 2);
    const sum = checksum(header);
    writeString(header, 148, `${octal(sum, 7).slice(0, 6)}\0 `, 8);

    blocks.push(Buffer.from(header));
    blocks.push(Buffer.from(entry.data));
    const padding = (BLOCK - (entry.data.length % BLOCK)) % BLOCK;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  // Two zero blocks terminate the archive.
  blocks.push(Buffer.alloc(BLOCK), Buffer.alloc(BLOCK));
  return Buffer.concat(blocks);
}

/** Wrap a single file into a one-entry deterministic tar. */
export function singleFileTar(name: string, data: Uint8Array): Buffer {
  return createTar([{ name, data }]);
}
