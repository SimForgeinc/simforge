import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { canonicalJson, filesUnder, hashFile, sha256 } from './closure.js';
import { resolveMasterSource } from './master.js';
import { resolveSkyPath, resolveXodrPath } from './sidecars.js';
import { collectLibraryDonors, terrainDonorLibrary, terrainDonorPoolDigest, terrainLayerBase } from './terrain-layer-textures.js';

export interface MapSourceManifest {
  schema: 'simforge.map-source.v1';
  name: string;
  glb: string;
  xodr?: string;
  sky?: string;
  donorMasters?: string[];
}

export interface MapSourceOptions {
  sourceDir: string;
  name: string;
  sourceManifest?: string;
  sourcePath?: string;
  xodrPath?: string;
  donorLibrary?: readonly string[];
}

export interface ResolvedMapSource {
  sourceDir: string;
  sourcePath: string;
  xodrPath?: string;
  skyPath: string;
  donorLibrary: readonly string[];
}

/** A submitted manifest identifies complete inputs; unrelated exports never enter a cache key. */
export async function resolveMapSource(options: MapSourceOptions): Promise<ResolvedMapSource> {
  const sourceDir = path.resolve(options.sourceDir);
  let manifestPath = options.sourceManifest ? path.resolve(options.sourceManifest) : path.join(sourceDir, 'map-source.json');
  let manifest: MapSourceManifest | undefined;
  try {
    await access(manifestPath);
  } catch (error) {
    if (options.sourceManifest || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    manifestPath = '';
  }
  if (manifestPath) {
    const candidate = JSON.parse(await readFile(manifestPath, 'utf8')) as MapSourceManifest;
    if (candidate.schema !== 'simforge.map-source.v1' || candidate.name !== options.name || typeof candidate.glb !== 'string' || !candidate.glb) {
      throw new Error(`invalid map source manifest or map name mismatch: ${manifestPath}`);
    }
    for (const field of ['xodr', 'sky'] as const) {
      if (candidate[field] !== undefined && (typeof candidate[field] !== 'string' || !candidate[field])) throw new Error(`invalid source manifest ${field}`);
    }
    if (candidate.donorMasters !== undefined && (!Array.isArray(candidate.donorMasters) || candidate.donorMasters.some((entry) => typeof entry !== 'string' || !entry))) {
      throw new Error('invalid source manifest donorMasters');
    }
    manifest = candidate;
  }
  const fromManifest = (file: string): string => path.resolve(path.dirname(manifestPath), file);
  const sourcePath = await resolveMasterSource(sourceDir, options.sourcePath ?? (manifest ? fromManifest(manifest.glb) : undefined));
  const xodrPath = await resolveXodrPath(sourceDir, options.xodrPath ?? (manifest?.xodr ? fromManifest(manifest.xodr) : undefined));
  const skyPath = manifest?.sky ? fromManifest(manifest.sky) : await resolveSkyPath(sourceDir);
  await access(skyPath);
  const donorLibrary = options.donorLibrary ?? manifest?.donorMasters?.map(fromManifest) ?? terrainDonorLibrary();
  return { sourceDir, sourcePath, ...(xodrPath ? { xodrPath } : {}), skyPath, donorLibrary };
}

export async function sceneSourceDigest(sourcePath: string): Promise<string> {
  const source = await hashFile(sourcePath);
  if (path.extname(sourcePath).toLowerCase() === '.glb') return source.sha256;
  const document = JSON.parse(await readFile(sourcePath, 'utf8')) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
  const rows: Record<string, string> = { source: source.sha256 };
  for (const resource of [...(document.buffers ?? []), ...(document.images ?? [])]) {
    if (!resource.uri || resource.uri.startsWith('data:')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(resource.uri)) throw new Error('map source resources must be local files');
    rows[resource.uri] = (await hashFile(path.resolve(path.dirname(sourcePath), decodeURIComponent(resource.uri)))).sha256;
  }
  return sha256(canonicalJson(rows));
}

/** Hash the actual donor sampling inputs, retaining library precedence, not mutable filesystem paths. */
export async function donorLibraryDigest(library: readonly string[]): Promise<string> {
  const bases = new Set<string>();
  for (const file of library) {
    const document = JSON.parse(await readFile(path.resolve(file), 'utf8')) as { materials?: { name?: string }[] };
    for (const material of document.materials ?? []) {
      const base = terrainLayerBase(material.name ?? '');
      if (base) bases.add(base);
    }
  }
  return terrainDonorPoolDigest(await collectLibraryDonors(bases, library));
}

export async function semanticSourceDigest(source: ResolvedMapSource, name: string): Promise<string> {
  const inputs: Record<string, string> = { name, sky: (await hashFile(source.skyPath)).sha256 };
  if (source.xodrPath) inputs.xodr = (await hashFile(source.xodrPath)).sha256;
  // Match every optional authored file shape accepted by the semantic source loader.
  for (const file of await filesUnder(source.sourceDir)) {
    if (!/\.geojson(?:\.gz)?$/i.test(file) && !/(?:^|[/.])search-index\.json(?:\.gz)?$/i.test(file) && !file.endsWith('enrichment/overlay-payload.json')) continue;
    inputs[file] = (await hashFile(path.join(source.sourceDir, file))).sha256;
  }
  return sha256(canonicalJson(inputs));
}
