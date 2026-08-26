import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

import {
  ENGINE_VERSION,
  serializeTrace,
  type LaneGraph,
  type SimScenarioInput,
  type SimTrace,
} from '@simforge-oss/engine';

import {
  analyzeEsminiCompatibility,
  exportOpenScenarioXml13Esmini,
  type EsminiCompatibilityReport,
  type EsminiExportMode,
} from '../export/xml-1.3-esmini.js';

export const ESMINI_BUNDLE_VERSION = 1 as const;
export const OFFICIAL_OPENSCENARIO_131_XSD = {
  version: '1.3.1',
  url: 'https://publications.pages.asam.net/standards/ASAM_OpenSCENARIO/ASAM_OpenSCENARIO_XML/v1.3.1/_attachments/generated/ASAM_OpenSCENARIO_v1.3.1_Schema.zip',
  archiveSha256: '25044a2ffdab426c894ea441aee4dfc5eff45ab86cbb64835e6861d6f65f7cb6',
  xsdSha256: '1c86539c61264c691c1031ec78e3a93dcde63876f7f769428c330d4fd86c26a4',
} as const;

export interface FullOpenDriveDependency {
  readonly mapId: string;
  readonly xodrSha256: string;
  readonly bytes: Uint8Array;
  /** Server-side immutable source; never serialized into browser-visible provenance. */
  readonly source: 'server-map-store';
}

export interface MapDependencyResolver {
  resolveFullOpenDrive(mapId: string, expectedXodrSha256: string): Promise<FullOpenDriveDependency>;
}

export interface EsminiBundleRequest {
  readonly instanceId: string;
  readonly input: SimScenarioInput;
  readonly inputHash: string;
  readonly graph: LaneGraph;
  readonly canonicalTrace: SimTrace;
  readonly expectedXodrSha256: string;
  readonly mapResolver: MapDependencyResolver;
  /** Official pinned OpenSCENARIO 1.3.1 XSD. Bundle creation fails if absent/stale. */
  readonly xsdPath: string;
  readonly mode?: EsminiExportMode;
  readonly author?: string;
  readonly description?: string;
}

export interface EsminiBundleFile {
  readonly path: string;
  readonly mediaType: string;
  readonly bytes: number;
  readonly sha256: string;
}

/** Stable hand-off contract consumed by ../esmini/index.js. */
export interface EsminiBundleManifest {
  readonly kind: 'simforge-esmini-runnable-bundle';
  readonly version: typeof ESMINI_BUNDLE_VERSION;
  readonly scenarioEntry: 'scenario.xosc';
  readonly roadEntry: 'maps/map.xodr';
  readonly canonicalTraceEntry: 'trace/canonical.trace.json';
  readonly capabilityEntry: 'reports/capability.json';
  readonly provenanceEntry: 'reports/provenance.json';
  readonly openScenarioVersion: '1.3.1';
  readonly esminiVersion: 'runner-pinned';
  readonly engineVersion: string;
  readonly behaviorParityScope: 'semantic-actions' | 'motion-only';
  readonly files: readonly EsminiBundleFile[];
}

export interface EsminiRunnableBundle {
  readonly manifest: EsminiBundleManifest;
  /** Includes bundle.json. Keys are normalized POSIX paths relative to bundle root. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly capability: EsminiCompatibilityReport;
}

export interface OpenScenarioXsdValidation {
  readonly valid: boolean;
  readonly xsdSha256: string;
  readonly diagnostics: readonly string[];
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === 'object') {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, normalize(child)]));
    }
    return entry;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function assertBundlePath(file: string): void {
  if (file.length === 0 || file.startsWith('/') || file.includes('\\')) throw new Error(`unsafe bundle path: ${file}`);
  const normalized = path.posix.normalize(file);
  if (normalized !== file || normalized === '..' || normalized.startsWith('../')) throw new Error(`unsafe bundle path: ${file}`);
}

async function fileDigest(file: string): Promise<string> {
  return sha256(new Uint8Array(await readFile(file)));
}

/** Validate with the pinned official XSD via libxml2; schema absence is a failure, not a warning. */
export async function validateOpenScenarioXml13(xml: string, xsdPath: string): Promise<OpenScenarioXsdValidation> {
  if (!existsSync(xsdPath)) throw new Error(`OpenSCENARIO 1.3.1 XSD not found: ${xsdPath}`);
  const xsdSha256 = await fileDigest(xsdPath);
  if (xsdSha256 !== OFFICIAL_OPENSCENARIO_131_XSD.xsdSha256) {
    throw new Error(`OpenSCENARIO 1.3.1 XSD digest mismatch: expected ${OFFICIAL_OPENSCENARIO_131_XSD.xsdSha256}, got ${xsdSha256}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('xmllint', ['--noout', '--schema', xsdPath, '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({
      valid: code === 0,
      xsdSha256,
      diagnostics: stderr.split('\n').map((line) => line.trim()).filter(Boolean),
    }));
    child.stdin.end(xml);
  });
}

/**
 * Resolve the complete immutable OpenDRIVE file from server-owned assets.
 * The browser submits only mapId + digest; a 16KB preview can never satisfy it.
 */
export function createServerMapDependencyResolver(assetRoot: string): MapDependencyResolver {
  return {
    async resolveFullOpenDrive(mapId, expectedXodrSha256) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(mapId)) throw new Error(`unsafe mapId: ${mapId}`);
      if (!/^[a-f0-9]{64}$/.test(expectedXodrSha256)) throw new Error('expectedXodrSha256 must be a lowercase sha256 digest');
      const mapRoot = path.resolve(assetRoot, mapId);
      const assetBoundary = `${path.resolve(assetRoot)}${path.sep}`;
      if (!mapRoot.startsWith(assetBoundary)) throw new Error(`map dependency escaped asset root: ${mapId}`);
      const xodrFile = path.join(mapRoot, 'map.xodr');
      const topologyFile = path.join(mapRoot, 'topology-index.json.gz');
      const [bytes, topologyBytes] = await Promise.all([readFile(xodrFile), readFile(topologyFile)]);
      const digest = sha256(new Uint8Array(bytes));
      if (digest !== expectedXodrSha256) {
        throw new Error(`stale OpenDRIVE dependency for ${mapId}: expected ${expectedXodrSha256}, got ${digest}`);
      }
      const plain = topologyBytes[0] === 0x1f && topologyBytes[1] === 0x8b ? gunzipSync(topologyBytes) : topologyBytes;
      const topology = JSON.parse(plain.toString('utf8')) as { source?: { xodrSha256?: string } };
      if (topology.source?.xodrSha256 !== digest) {
        throw new Error(`stale topology dependency for ${mapId}: topology declares ${topology.source?.xodrSha256 ?? 'no digest'}, map is ${digest}`);
      }
      return { mapId, xodrSha256: digest, bytes: new Uint8Array(bytes), source: 'server-map-store' };
    },
  };
}

export async function buildEsminiRunnableBundle(request: EsminiBundleRequest): Promise<EsminiRunnableBundle> {
  if (request.graph.topologyDigest !== request.expectedXodrSha256) {
    throw new Error('export graph topologyDigest does not match requested OpenDRIVE dependency');
  }
  if (request.input.mapId !== request.canonicalTrace.header.mapId) throw new Error('trace mapId does not match scenario input');
  if (request.inputHash !== request.canonicalTrace.header.inputHash) throw new Error('trace inputHash does not match requested instance');
  if (request.expectedXodrSha256 !== request.canonicalTrace.header.engineGraphDigest) {
    throw new Error('trace engineGraphDigest does not match requested OpenDRIVE dependency');
  }
  const actorIds = [...request.input.actors.map((actor) => actor.id)].sort();
  const traceActorIds = [...request.canonicalTrace.header.actorIds].sort();
  if (JSON.stringify(actorIds) !== JSON.stringify(traceActorIds)) throw new Error('trace actor closure does not match scenario input');

  const road = await request.mapResolver.resolveFullOpenDrive(request.input.mapId, request.expectedXodrSha256);
  if (road.mapId !== request.input.mapId || road.xodrSha256 !== request.expectedXodrSha256 || sha256(road.bytes) !== road.xodrSha256) {
    throw new Error('resolved OpenDRIVE dependency identity or digest mismatch');
  }
  const mode = request.mode ?? 'deterministic-trajectory';
  const compatibility = analyzeEsminiCompatibility(request.input, mode);
  if (compatibility.blocking.length > 0) {
    throw new Error(`esmini bundle blocked by ${compatibility.blocking.map((entry) => entry.path).join(', ')}`);
  }
  const exported = exportOpenScenarioXml13Esmini(request.input, {
    graph: request.graph,
    roadFile: 'maps/map.xodr',
    executionMode: mode === 'supported-actions' ? 'actions' : 'trajectory-replay',
    esminiMode: mode,
    headerDate: '1970-01-01T00:00:00.000Z',
    ...(request.author ? { author: request.author } : {}),
    ...(request.description ? { description: request.description } : {}),
    provenance: { instanceId: request.instanceId, inputHash: request.inputHash, xodrSha256: road.xodrSha256 },
  });
  const validation = await validateOpenScenarioXml13(exported.content, request.xsdPath);
  if (!validation.valid) throw new Error(`OpenSCENARIO 1.3.1 XSD validation failed: ${validation.diagnostics.join('; ')}`);

  const traceBytes = serializeTrace(request.canonicalTrace);
  const capabilityBytes = utf8(canonicalJson({ ...compatibility, xsdValidation: validation }));
  const provenanceBytes = utf8(canonicalJson({
    kind: 'simforge-esmini-provenance',
    version: 1,
    instanceId: request.instanceId,
    inputHash: request.inputHash,
    traceSha256: sha256(traceBytes),
    mapId: request.input.mapId,
    xodrSha256: road.xodrSha256,
    mapResolution: 'server-map-store',
    openScenarioVersion: '1.3.1',
    xsdSha256: validation.xsdSha256,
    engineVersion: ENGINE_VERSION,
    esminiVersion: 'runner-pinned',
    exportMode: mode,
  }));
  const payloads = new Map<string, { mediaType: string; bytes: Uint8Array }>([
    ['scenario.xosc', { mediaType: 'application/xml', bytes: utf8(exported.content) }],
    ['maps/map.xodr', { mediaType: 'application/xml', bytes: road.bytes }],
    ['trace/canonical.trace.json', { mediaType: 'application/json', bytes: traceBytes }],
    ['reports/capability.json', { mediaType: 'application/json', bytes: capabilityBytes }],
    ['reports/provenance.json', { mediaType: 'application/json', bytes: provenanceBytes }],
    ['catalogs/manifest.json', { mediaType: 'application/json', bytes: utf8(canonicalJson({ kind: 'simforge-catalog-references', version: 1, catalogs: [], assets: [] })) }],
  ]);
  const fileEntries = [...payloads.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, payload]) => ({
    path: file,
    mediaType: payload.mediaType,
    bytes: payload.bytes.byteLength,
    sha256: sha256(payload.bytes),
  }));
  const manifest: EsminiBundleManifest = {
    kind: 'simforge-esmini-runnable-bundle',
    version: ESMINI_BUNDLE_VERSION,
    scenarioEntry: 'scenario.xosc',
    roadEntry: 'maps/map.xodr',
    canonicalTraceEntry: 'trace/canonical.trace.json',
    capabilityEntry: 'reports/capability.json',
    provenanceEntry: 'reports/provenance.json',
    openScenarioVersion: '1.3.1',
    esminiVersion: 'runner-pinned',
    engineVersion: ENGINE_VERSION,
    behaviorParityScope: compatibility.behaviorParityScope,
    files: fileEntries,
  };
  const files = new Map<string, Uint8Array>([...payloads.entries()].map(([file, payload]) => [file, payload.bytes]));
  files.set('bundle.json', utf8(canonicalJson(manifest)));
  return { manifest, files, capability: compatibility };
}

export async function writeEsminiRunnableBundle(bundle: EsminiRunnableBundle, outputDir: string): Promise<void> {
  const root = path.resolve(outputDir);
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink()) throw new Error(`bundle output root is a symbolic link: ${root}`);
  for (const [file, bytes] of bundle.files) {
    assertBundlePath(file);
    const destination = path.resolve(root, ...file.split('/'));
    if (!destination.startsWith(`${root}${path.sep}`)) throw new Error(`bundle path escaped output root: ${file}`);
    await mkdir(path.dirname(destination), { recursive: true });
    let cursor = path.dirname(destination);
    while (cursor !== root) {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`bundle output contains a symbolic-link directory: ${cursor}`);
      cursor = path.dirname(cursor);
    }
    try {
      if ((await lstat(destination)).isSymbolicLink()) throw new Error(`bundle output file is a symbolic link: ${destination}`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await writeFile(destination, bytes);
  }
}
