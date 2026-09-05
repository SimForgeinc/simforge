import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { runMapPipeline } from '@simforge-oss/map-pipeline';
import type { RegistryClosureArtifact } from '@simforge-oss/map-pipeline';
import {
  closureFromDirectory,
  createRegistryBackend,
  listMaps,
  listDerivedClosures,
  loadDerivedClosure,
  promoteVersion,
  publishVersion,
  pullVersion,
  pushSourceArchive,
  resolveVersion,
  type MapClosure,
  type DerivedClosureInput,
  type MapVersion,
  type RegistryBackend,
} from '@simforge-oss/map-registry';
import { basename, join, resolve } from 'node:path';
import { EXIT } from '../errors.js';
import { emit, emitLines } from '../output.js';

function defaultRegistryUrl(): string {
  return `file://${join(homedir(), 'simforge-assets', 'registry')}`;
}

export function registryUrl(explicit?: string): string {
  return explicit ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? process.env['SIMFORGE_MAPS_PUBLIC_URL'] ?? 'https://da3tufozhdsvl.cloudfront.net';
}

function writableBackend(url: string): RegistryBackend {
  return createRegistryBackend(url);
}

export interface RegistryListOptions {
  pretty: boolean;
  registry?: string;
}

export async function registryMapsList(options: RegistryListOptions): Promise<number> {
  const url = registryUrl(options.registry);
  const index = await listMaps(writableBackend(url));
  if (options.pretty) {
    const lines = [`registry: ${url}`, ''];
    for (const [name, entry] of Object.entries(index).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`${name}  ${entry.latest}  ${entry.summary['label'] ?? ''}`.trimEnd());
    }
    emitLines(lines);
  } else {
    emit({ registry: url, maps: index }, options);
  }
  return EXIT.ok;
}

export interface MapBuildOptions {
  directory: string;
  name: string;
  xodrPath?: string;
  sourcePath?: string;
  sourceManifest?: string;
  reuseMasterDir?: string;
  workDir: string;
  cellSize?: number;
  donorLibrary?: readonly string[];
  pretty: boolean;
}

/**
 * Build a map master and its web tier into `workDir` without publishing;
 * `maps ingest` publishes the same stages. Prints where the stage content
 * landed and the master/web reports.
 */
export async function registryMapsBuild(options: MapBuildOptions): Promise<number> {
  const started = Date.now();
  const pipeline = await runMapPipeline({
    sourceDir: resolve(options.directory),
    ...(options.xodrPath ? { xodrPath: resolve(options.xodrPath) } : {}),
    ...(options.sourcePath ? { sourcePath: resolve(options.sourcePath) } : {}),
    ...(options.sourceManifest ? { sourceManifest: resolve(options.sourceManifest) } : {}),
    ...(options.reuseMasterDir ? { reuseMasterDir: resolve(options.reuseMasterDir) } : {}),
    name: options.name,
    workDir: resolve(options.workDir),
    ...(options.cellSize ? { cellSize: options.cellSize } : {}),
    ...(options.donorLibrary ? { donorLibrary: options.donorLibrary } : {}),
  });
  emit({
    name: options.name,
    seconds: (Date.now() - started) / 1000,
    master: { contentDir: pipeline.stages.master.outputDir, closureDigest: pipeline.canonical.digest, report: pipeline.stages.master.report },
    web: pipeline.stages.web === undefined ? null : { contentDir: pipeline.stages.web.outputDir, closureDigest: pipeline.derived[0]!.digest, toolFingerprint: pipeline.stages.web.toolFingerprint, report: pipeline.stages.web.report },
  }, options);
  return EXIT.ok;
}

export interface RegistryIngestOptions {
  directory: string;
  name: string;
  xodrPath?: string;
  sourcePath?: string;
  sourceManifest?: string;
  reuseMasterDir?: string;
  workDir?: string;
  target?: 'private' | 'public';
  registry?: string;
  version?: MapVersion;
  label?: string;
  sourceRef?: string;
  /** Prebuilt web tier (`3d/**` + `images/*.ktx2`) to publish beside a prebuilt master. */
  webDirectory?: string;
  webFingerprint?: string;
  /** Web tier cell size in metres when the pipeline runs (default 100). */
  cellSize?: number;
  /** `master.gltf` files of already-built maps consulted as terrain-texture donors. */
  donorLibrary?: readonly string[];
  pretty: boolean;
}

function pipelineArtifactInput(artifact: RegistryClosureArtifact): DerivedClosureInput {
  const files = Object.fromEntries(
    Object.keys(artifact.closure.members).map((memberPath) => [
      memberPath,
      join(artifact.contentDir, ...memberPath.split('/')),
    ]),
  );
  return { closure: artifact.closure, files };
}

/**
 * Publish a map. `directory` is either a prebuilt master (has `master.gltf`;
 * published as-is, with `--web-dir` for its tier) or a source export
 * directory (one RoadRunner/Unreal GLB plus its .xodr) that the pipeline
 * turns into a master and a web tier first.
 */
export async function registryMapsIngest(options: RegistryIngestOptions): Promise<number> {
  const directory = resolve(options.directory);
  let prebuilt = true;
  try {
    await access(join(directory, 'master.gltf'));
  } catch {
    prebuilt = false;
  }

  let canonical: DerivedClosureInput;
  let derived: DerivedClosureInput[];
  if (prebuilt) {
    canonical = await closureFromDirectory(directory);
    if (options.webDirectory === undefined) throw new Error('publishing a map master requires --web-dir');
    let fingerprint = options.webFingerprint;
    if (!fingerprint) {
      // Use the actual completed build descriptor, not an invented basename fingerprint.
      const webClosure = JSON.parse(await readFile(join(resolve(options.webDirectory), '..', 'closure.json'), 'utf8')) as MapClosure;
      if (webClosure.kind !== 'web' || !webClosure.toolFingerprint) throw new Error('prebuilt web tier has no recorded tool fingerprint');
      fingerprint = webClosure.toolFingerprint;
    }
    derived = [await closureFromDirectory(resolve(options.webDirectory), 'web', fingerprint)];
  } else {
    const workDir = options.workDir ?? process.env['SIMFORGE_MAP_WORK_DIR'];
    if (!workDir) throw new Error('source ingestion requires --work-dir or SIMFORGE_MAP_WORK_DIR for durable resumable builds');
    const pipeline = await runMapPipeline({
      sourceDir: directory,
      ...(options.xodrPath ? { xodrPath: resolve(options.xodrPath) } : {}),
      ...(options.sourcePath ? { sourcePath: resolve(options.sourcePath) } : {}),
      ...(options.sourceManifest ? { sourceManifest: resolve(options.sourceManifest) } : {}),
      ...(options.reuseMasterDir ? { reuseMasterDir: resolve(options.reuseMasterDir) } : {}),
      name: options.name,
      workDir: resolve(workDir),
      ...(options.cellSize ? { cellSize: options.cellSize } : {}),
      ...(options.donorLibrary ? { donorLibrary: options.donorLibrary } : {}),
    });
    canonical = pipelineArtifactInput(pipeline.canonical);
    derived = pipeline.derived.map(pipelineArtifactInput);
  }
  const url = options.registry ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? internalRegistryUrl();
  const published = await publishVersion(writableBackend(url), {
    name: options.name,
    version: options.version,
    closure: canonical.closure,
    files: canonical.files,
    derived,
    target: options.target ?? 'private',
    summary: options.label === undefined ? {} : { label: options.label },
    sourceRef: options.sourceRef,
  });
  emit({ registry: url, ...published }, options);
  return EXIT.ok;
}

export interface RegistryPullOptions {
  reference: string;
  registry?: string;
  cacheRoot?: string;
  browserRoot?: string;
  devAssetsRoot?: string;
  nativeCorpusRoot?: string;
  blobCacheRoot?: string;
  /** Pull one specific web tier by its tool fingerprint instead of every published one. */
  webFingerprint?: string;
  /** Also materialize the verbatim source rasters under dev-assets. */
  archive?: boolean;
  pretty: boolean;
}

/**
 * Pull a map version into the local layouts: `.corpus/<map>` for the native
 * renderer (master + KTX2 + sidecars), `map-bundles/<map>` for the viewer
 * (web tier + KTX2) and `dev-assets/<map>` for the sidecars alone.
 */
export async function registryMapsPull(options: RegistryPullOptions): Promise<number> {
  const url = registryUrl(options.registry);
  const backend = writableBackend(url);
  const resolved = await resolveVersion(backend, options.reference);
  const derived: MapClosure[] = options.webFingerprint === undefined
    ? await listDerivedClosures(backend, resolved.name, resolved.record.version)
    : [await loadDerivedClosure(backend, resolved.name, resolved.record.version, 'web', options.webFingerprint)];
  const cacheRoot = resolve(options.cacheRoot ?? process.env['SIMFORGE_MAPS_CACHE_ROOT'] ?? join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'simforge', 'maps'));
  const result = await pullVersion(backend, options.reference, {
    layouts: {
      browserBundlesRoot: resolve(options.browserRoot ?? join(cacheRoot, 'map-bundles')),
      devAssetsRoot: resolve(options.devAssetsRoot ?? join(cacheRoot, 'dev-assets')),
      nativeCorpusRoot: resolve(options.nativeCorpusRoot ?? join(cacheRoot, '.corpus')),
      blobCacheRoot: resolve(options.blobCacheRoot ?? join(cacheRoot, '.blobs')),
    },
    derivedClosures: derived,
    ...(options.archive === true ? { archive: true } : {}),
  });
  emit({ registry: url, ...result }, options);
  return EXIT.ok;
}

export interface RegistryPromoteOptions {
  reference: string;
  sourceRegistry?: string;
  destinationRegistry?: string;
  target?: 'private' | 'public';
  pretty: boolean;
}

export async function registryMapsPromote(options: RegistryPromoteOptions): Promise<number> {
  const sourceUrl = options.sourceRegistry ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? internalRegistryUrl();
  const destinationUrl = options.destinationRegistry ?? process.env['SIMFORGE_MAPS_PUBLIC_URL'];
  if (destinationUrl === undefined) throw new Error('promotion needs --destination-registry or SIMFORGE_MAPS_PUBLIC_URL');
  const result = await promoteVersion(writableBackend(sourceUrl), writableBackend(destinationUrl), {
    reference: options.reference,
    sourceRegistry: sourceUrl,
    target: options.target ?? 'public',
  });
  emit({ sourceRegistry: sourceUrl, destinationRegistry: destinationUrl, ...result }, options);
  return EXIT.ok;
}

function internalRegistryUrl(): string {
  const bucket = process.env['SIMFORGE_MAPS_INTERNAL_BUCKET'];
  if (bucket === undefined) return defaultRegistryUrl();
  return bucket.startsWith('s3://') ? bucket : `s3://${bucket}`;
}

export interface RegistrySourcePushOptions {
  archivePath: string;
  name: string;
  label?: string;
  date?: string;
  resumeFile?: string;
  registry?: string;
  pretty: boolean;
}

export async function registryMapsSourcePush(options: RegistrySourcePushOptions): Promise<number> {
  const url = options.registry ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? internalRegistryUrl();
  const archiveName = basename(options.archivePath).replace(/\.[^.]+$/, '');
  const label = options.label ?? archiveName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const key = await pushSourceArchive(writableBackend(url), {
    name: options.name,
    archivePath: resolve(options.archivePath),
    label,
    date: options.date,
    resumeFile: options.resumeFile,
  });
  emit({ registry: url, key }, options);
  return EXIT.ok;
}
