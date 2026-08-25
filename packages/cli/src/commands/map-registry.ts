import {
  closureFromDirectory,
  createRegistryBackend,
  listMaps,
  loadDerivedClosure,
  promoteVersion,
  publishVersion,
  pullVersion,
  pushSourceArchive,
  resolveVersion,
  type MapClosure,
  type DerivedClosureInput,
  type DerivedClosureKind,
  type MapVersion,
  type RegistryBackend,
} from '@simforge/map-registry';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { EXIT } from '../errors.js';
import { emit, emitLines } from '../output.js';

function defaultRegistryUrl(): string {
  return `file://${join(homedir(), 'simforge-assets', 'registry')}`;
}

export function registryUrl(explicit?: string): string {
  return explicit ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? process.env['SIMFORGE_MAPS_PUBLIC_URL'] ?? defaultRegistryUrl();
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

export interface RegistryIngestOptions {
  directory: string;
  name: string;
  registry?: string;
  version?: MapVersion;
  label?: string;
  sourceRef?: string;
  browserDirectory?: string;
  browserFingerprint?: string;
  ktx2Directory?: string;
  ktx2Fingerprint?: string;
  nativeDirectory?: string;
  nativeFingerprint?: string;
  pretty: boolean;
}

async function optionalDerived(
  directory: string | undefined,
  kind: DerivedClosureKind,
  fingerprint: string | undefined,
): Promise<DerivedClosureInput | undefined> {
  if (directory === undefined) return undefined;
  if (fingerprint === undefined) throw new Error(`${kind} directory requires its tool fingerprint`);
  return closureFromDirectory(resolve(directory), kind, fingerprint);
}

export async function registryMapsIngest(options: RegistryIngestOptions): Promise<number> {
  const canonical = await closureFromDirectory(resolve(options.directory));
  const candidates = await Promise.all([
    optionalDerived(options.browserDirectory, 'browser-optimized', options.browserFingerprint),
    optionalDerived(options.ktx2Directory, 'ktx2', options.ktx2Fingerprint),
    optionalDerived(options.nativeDirectory, 'native-corpus', options.nativeFingerprint),
  ]);
  const derived = candidates.filter((value): value is DerivedClosureInput => value !== undefined);
  const url = registryUrl(options.registry);
  const published = await publishVersion(writableBackend(url), {
    name: options.name,
    version: options.version,
    closure: canonical.closure,
    files: canonical.files,
    derived,
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
  browserFingerprint?: string;
  ktx2Fingerprint?: string;
  nativeFingerprint?: string;
  pretty: boolean;
}

export async function registryMapsPull(options: RegistryPullOptions): Promise<number> {
  const url = registryUrl(options.registry);
  const backend = writableBackend(url);
  const resolved = await resolveVersion(backend, options.reference);
  const fingerprints: Array<[DerivedClosureKind, string | undefined]> = [
    ['browser-optimized', options.browserFingerprint],
    ['ktx2', options.ktx2Fingerprint],
    ['native-corpus', options.nativeFingerprint],
  ];
  const derived: MapClosure[] = [];
  for (const [kind, fingerprint] of fingerprints) {
    if (fingerprint !== undefined) {
      derived.push(await loadDerivedClosure(backend, resolved.name, resolved.record.version, kind, fingerprint));
    }
  }
  const cacheRoot = resolve(options.cacheRoot ?? join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), 'simforge', 'maps'));
  const result = await pullVersion(backend, options.reference, {
    layouts: {
      browserBundlesRoot: resolve(options.browserRoot ?? join(cacheRoot, 'map-bundles')),
      devAssetsRoot: resolve(options.devAssetsRoot ?? join(cacheRoot, 'dev-assets')),
      nativeCorpusRoot: resolve(options.nativeCorpusRoot ?? join(cacheRoot, '.corpus')),
    },
    ...(derived.length === 0 ? {} : { derivedClosures: derived }),
  });
  emit({ registry: url, ...result }, options);
  return EXIT.ok;
}

export interface RegistryPromoteOptions {
  reference: string;
  sourceRegistry?: string;
  destinationRegistry?: string;
  pretty: boolean;
}

export async function registryMapsPromote(options: RegistryPromoteOptions): Promise<number> {
  const sourceUrl = options.sourceRegistry ?? process.env['SIMFORGE_MAPS_REGISTRY'] ?? internalRegistryUrl();
  const destinationUrl = options.destinationRegistry ?? process.env['SIMFORGE_MAPS_PUBLIC_URL'];
  if (destinationUrl === undefined) throw new Error('promotion needs --destination-registry or SIMFORGE_MAPS_PUBLIC_URL');
  const result = await promoteVersion(writableBackend(sourceUrl), writableBackend(destinationUrl), {
    reference: options.reference,
    sourceRegistry: sourceUrl,
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
