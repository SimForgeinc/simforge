import { posix } from 'node:path';
import type { EsminiExecutionJob } from './contracts.js';

export class BundleSecurityError extends Error {
  override readonly name = 'BundleSecurityError';
  constructor(readonly code: string, message: string) { super(message); }
}

const SAFE_MEDIA = new Set([
  'application/xml', 'text/xml', 'application/json', 'text/plain',
  'application/octet-stream', 'model/x-opendrive+xml',
]);
const REMOTE_REF_RE = /(?:https?|ftp|file|data):\/\//iu;
const XML_DANGER_RE = /<!DOCTYPE|<!ENTITY|SYSTEM\s+["']|PUBLIC\s+["']/iu;
const REF_RE = /\b(?:filepath|file)\s*=\s*["']([^"']+)["']/giu;

export function assertSafeRelativePath(value: string, label = 'path'): void {
  if (!value || value.includes('\\') || value.includes('\0')) throw new BundleSecurityError('unsafe_path', `${label} is not a normalized POSIX path`);
  if (value.startsWith('/') || /^[A-Za-z]:/u.test(value)) throw new BundleSecurityError('absolute_path', `${label} must be relative`);
  if (posix.normalize(value) !== value || value.split('/').includes('..') || value.split('/').includes('.')) {
    throw new BundleSecurityError('path_traversal', `${label} contains traversal or non-normalized segments`);
  }
}

export function validateJobShape(job: EsminiExecutionJob, limits: { maxBundleBytes: number; maxFileCount: number }): void {
  if (!job || typeof job !== 'object' || job.schema !== 'uniscenarios.esmini-job/v1' || !job.bundle || !job.bundle.manifest || job.bundle.manifest.kind !== 'uniscenarios-esmini-runnable-bundle' || job.bundle.manifest.version !== 1) {
    throw new BundleSecurityError('bad_schema', 'unsupported external runner job schema');
  }
  if (job.options.fixedTimestepS !== 0.02) throw new BundleSecurityError('bad_timestep', 'esmini must run at fixed 0.02 s');
  if (!Number.isFinite(job.options.durationS) || job.options.durationS <= 0 || job.options.durationS > 300) {
    throw new BundleSecurityError('bad_duration', 'duration must be in (0, 300] seconds');
  }
  const records = new Set(job.options.record);
  const required = job.options.evidenceProfile === 'local-trace-no-osi'
    ? ['csv', 'dat', 'log'] as const
    : ['csv', 'dat', 'osi', 'log'] as const;
  if (records.size !== required.length || !required.every((kind) => records.has(kind))) {
    throw new BundleSecurityError('recording_contract', job.options.evidenceProfile === 'local-trace-no-osi'
      ? 'local trace runs must record exactly csv, dat, and log evidence'
      : 'every full-evidence run must record exactly csv, dat, osi, and log evidence');
  }
  if (job.options.render && (!Number.isInteger(job.options.render.width) || !Number.isInteger(job.options.render.height)
    || job.options.render.width < 320 || job.options.render.width > 3840 || job.options.render.height < 240 || job.options.render.height > 2160
    || !Number.isInteger(job.options.render.fps) || job.options.render.fps < 1 || job.options.render.fps > 60)) {
    throw new BundleSecurityError('render_bounds', 'optional evidence rendering dimensions or frame rate are outside limits');
  }
  if (job.bundle.manifest.files.length === 0 || job.bundle.manifest.files.length > limits.maxFileCount) {
    throw new BundleSecurityError('file_count', 'bundle file count exceeds the runner limit');
  }
  assertSafeRelativePath(job.bundle.manifest.scenarioEntry, 'entrypoint');
  const paths = new Set<string>();
  let total = 0;
  for (const file of job.bundle.manifest.files) {
    validateFile(file);
    if (paths.has(file.path)) throw new BundleSecurityError('duplicate_path', `duplicate bundle path: ${file.path}`);
    paths.add(file.path);
    total += file.bytes;
  }
  if (!paths.has(job.bundle.manifest.scenarioEntry)) throw new BundleSecurityError('missing_entrypoint', 'entrypoint is absent from bundle files');
  if (!paths.has(job.bundle.manifest.roadEntry)) throw new BundleSecurityError('missing_map', 'road entry is absent from bundle files');
  if (Object.keys(job.bundle.contentIds).length !== paths.size || [...paths].some((path) => !(path in job.bundle.contentIds))) {
    throw new BundleSecurityError('content_closure', 'content handles do not exactly cover manifest files');
  }
  for (const [path, contentId] of Object.entries(job.bundle.contentIds)) {
    assertSafeRelativePath(path, 'content path');
    if (!contentId || REMOTE_REF_RE.test(contentId) || contentId.includes('/') || contentId.includes('\\')) {
      throw new BundleSecurityError('unsafe_content_id', `unsafe content handle for ${path}`);
    }
  }
  if (total > limits.maxBundleBytes) throw new BundleSecurityError('bundle_too_large', 'bundle exceeds the byte limit');
}

function validateFile(file: EsminiExecutionJob['bundle']['manifest']['files'][number]): void {
  assertSafeRelativePath(file.path, `file ${JSON.stringify(file.path)}`);
  if (!/^[0-9a-f]{64}$/u.test(file.sha256)) throw new BundleSecurityError('bad_digest', `invalid digest for ${file.path}`);
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new BundleSecurityError('bad_size', `invalid size for ${file.path}`);
  if (!SAFE_MEDIA.has(file.mediaType)) throw new BundleSecurityError('media_type', `unsupported media type for ${file.path}`);
}

export function validateXmlContent(xml: string, filePaths: ReadonlySet<string>, sourcePath: string): void {
  if (XML_DANGER_RE.test(xml)) throw new BundleSecurityError('unsafe_xml', `${sourcePath} contains a DTD or external entity declaration`);
  if (REMOTE_REF_RE.test(xml)) throw new BundleSecurityError('remote_reference', `${sourcePath} contains a remote reference`);
  for (const match of xml.matchAll(REF_RE)) {
    const ref = match[1]!.trim();
    if (!ref || ref.startsWith('$')) continue;
    assertSafeRelativePath(ref, `reference in ${sourcePath}`);
    const resolved = posix.normalize(posix.join(posix.dirname(sourcePath), ref));
    assertSafeRelativePath(resolved, `resolved reference in ${sourcePath}`);
    if (!filePaths.has(resolved)) throw new BundleSecurityError('missing_reference', `${sourcePath} references absent file ${resolved}`);
  }
}
