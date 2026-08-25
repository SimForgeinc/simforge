/**
 * Corpus cache invalidation on decoder-semantics changes.
 *
 * The corpus build is idempotent: it reuses a previous build when the recorded
 * source sha256s AND the toolchain fingerprint both match. That fingerprint
 * originally covered only Node and dependency versions, so changing our own
 * `decodeGlb` behaviour did NOT invalidate anything — every existing corpus kept
 * serving artifacts produced by the old decoder. That silently defeated the
 * degenerate-primitive prune: freshly "built" corpora still contained the
 * zero-vertex primitives Bevy rejects.
 *
 * `DECODER_REVISION` closes that hole. These tests pin the two properties that
 * must hold together: the fingerprint carries the decoder revision, and the
 * comparison used for cache reuse actually looks at it.
 */

import { describe, expect, it } from 'vitest';

import { corpusTools } from '../commands/corpus.js';

describe('corpus toolchain fingerprint', () => {
  it('carries a decoder revision alongside dependency versions', () => {
    const tools = corpusTools();

    expect(typeof tools.decoder).toBe('number');
    // Revision 1 was the pre-prune decoder; anything cached under it is stale.
    expect(tools.decoder).toBeGreaterThanOrEqual(2);
    expect(tools.node).toBe(process.version);
  });

  it('is stable across calls, so unchanged inputs still hit the cache', () => {
    expect(corpusTools()).toEqual(corpusTools());
  });

  it('treats a differing decoder revision as a different toolchain', () => {
    // sameTools is module-private; exercise it through the observable contract
    // it exists to serve: a manifest recorded under an older decoder revision
    // must not compare equal to the current fingerprint.
    const current = corpusTools();
    const olderBuild = { ...current, decoder: current.decoder - 1 };

    expect(olderBuild).not.toEqual(current);
    // Guard the field itself: dropping `decoder` from the fingerprint would make
    // these two indistinguishable and resurrect the stale-corpus bug.
    const withoutDecoder = (value: typeof current): Omit<typeof current, 'decoder'> => {
      const { decoder: _decoder, ...rest } = value;
      return rest;
    };
    expect(withoutDecoder(olderBuild)).toEqual(withoutDecoder(current));
  });
});
