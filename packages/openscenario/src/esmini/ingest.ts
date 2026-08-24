import { createHash } from 'node:crypto';
import type { EsminiRunnableBundle } from '../node/index.js';
import type { EsminiExecutionJob, EsminiExecutionOptions } from './contracts.js';
import { assertSafeRelativePath, BundleSecurityError } from './security.js';

export interface WritableContentStore {
  /** Stores immutable bytes and returns an opaque, path-free handle. */
  put(content: Uint8Array, expectedSha256: string): Promise<string>;
}

export async function ingestRunnableBundle(
  bundle: EsminiRunnableBundle,
  store: WritableContentStore,
  request: Readonly<{ jobId: string; options?: Partial<EsminiExecutionOptions> }>,
): Promise<EsminiExecutionJob> {
  if (bundle.manifest.kind !== 'uniscenarios-esmini-runnable-bundle' || bundle.manifest.version !== 1) {
    throw new BundleSecurityError('bad_schema', 'unsupported CLI esmini bundle manifest');
  }
  const declared = new Set(bundle.manifest.files.map((file) => file.path));
  const unexpected = [...bundle.files.keys()].filter((path) => path !== 'bundle.json' && !declared.has(path));
  if (unexpected.length > 0) throw new BundleSecurityError('content_closure', `bundle contains undeclared files: ${unexpected.join(', ')}`);
  const contentIds: Record<string, string> = {};
  for (const file of bundle.manifest.files) {
    assertSafeRelativePath(file.path);
    const bytes = bundle.files.get(file.path);
    if (!bytes) throw new BundleSecurityError('content_closure', `bundle is missing ${file.path}`);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== file.bytes || actual !== file.sha256) throw new BundleSecurityError('content_digest_mismatch', `bundle content mismatch for ${file.path}`);
    const contentId = await store.put(bytes, file.sha256);
    if (!contentId || contentId.includes('/') || contentId.includes('\\') || /(?:https?|ftp|file|data):/iu.test(contentId)) {
      throw new BundleSecurityError('unsafe_content_id', `content store returned an unsafe handle for ${file.path}`);
    }
    contentIds[file.path] = contentId;
  }
  const options: EsminiExecutionOptions = {
    fixedTimestepS: 0.02,
    durationS: request.options?.durationS ?? 20,
    record: request.options?.record ?? ['csv', 'dat', 'osi', 'log'],
    ...(request.options?.evidenceProfile ? { evidenceProfile: request.options.evidenceProfile } : {}),
    ...(request.options?.render ? { render: request.options.render } : {}),
  };
  return { schema: 'uniscenarios.esmini-job/v1', id: request.jobId, bundle: { manifest: bundle.manifest, contentIds }, options };
}
