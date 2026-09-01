export interface RepackOptions {
  ktxBinDir?: string;
  colorCodec?: 'uastc' | 'etc1s';
  /** Longest-edge cap applied before block alignment and encoding. */
  maxDimension?: number;
}

export function repackGlb(
  source: Buffer,
  options?: RepackOptions,
): Promise<{ glb: Buffer; report: Record<string, unknown> }>;
