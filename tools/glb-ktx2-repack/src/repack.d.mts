export interface RepackOptions {
  ktxBinDir?: string;
  keepCoreSource?: boolean;
  colorCodec?: 'uastc' | 'etc1s';
}

export function repackGlb(
  source: Buffer,
  options?: RepackOptions,
): Promise<{ glb: Buffer; report: Record<string, unknown> }>;
