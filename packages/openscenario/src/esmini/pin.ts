import type { ExternalRunnerIdentity, Sha256Digest } from './contracts.js';

export const ESMINI_PIN = Object.freeze({
  version: '3.6.0',
  tag: 'v3.6.0',
  sourceRevision: '131a5651737fd1e8bd5d800d8e77e89bb3178a1e',
  releaseUrl: 'https://github.com/esmini/esmini/releases/tag/v3.6.0',
  license: 'MPL-2.0',
  archives: {
    linuxX64: {
      url: 'https://github.com/esmini/esmini/releases/download/v3.6.0/esmini-bin_Linux.zip',
      sha256: '2f45358d21d0dc061692edd97cf9ad6b30d8721e7c0bcc791cff1e1911aaed87',
    },
    macosUniversal: {
      url: 'https://github.com/esmini/esmini/releases/download/v3.6.0/esmini-bin_macOS.zip',
      sha256: '49e157478b5839216a314fe21167cf8d13ccb3740b24432b71a62623e0cbaf3b',
      /** SHA-256 of demo/esmini-demo/bin/esmini in the official macOS v3.6.0 release. */
      binarySha256: '7b3f8c1aa140ace3edea8435c1141f289d358037c07dcd2d7b49d2b53f26c749',
    },
  },
} as const);

export function runnerIdentity(digest: Sha256Digest, isolation: ExternalRunnerIdentity['isolation']): ExternalRunnerIdentity {
  return {
    name: 'esmini',
    version: ESMINI_PIN.version,
    sourceRevision: ESMINI_PIN.sourceRevision,
    digest,
    isolation,
  };
}
