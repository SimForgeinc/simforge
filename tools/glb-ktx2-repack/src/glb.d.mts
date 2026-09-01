export interface ParsedGlb {
  json: Record<string, unknown>;
  bin: Buffer;
}

export function parseGlb(buffer: Buffer): ParsedGlb;
export function writeGlb(json: Record<string, unknown>, bin: Buffer): Buffer;
