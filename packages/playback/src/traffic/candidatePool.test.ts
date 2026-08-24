import { describe, expect, it } from 'vitest';
import { defaultAmbientTrafficProfile, profileForPreset } from './model';
import {
  ambientCandidatePoolRequestKey,
  ambientPreviewKey,
  AmbientPreviewCache,
  previewForRevision,
} from './candidatePool';

describe('ambient candidate pool preview cache', () => {
  const city = defaultAmbientTrafficProfile();

  it('reuses the exact compiled preview for repeated Play', () => {
    const cache = new AmbientPreviewCache<{ actors: string[] }>();
    const requestKey = ambientCandidatePoolRequestKey('map-a', city);
    const previewKey = ambientPreviewKey(requestKey, 'scenario-a');
    const value = { actors: ['ambient:1'] };
    cache.commit(cache.begin(), { candidatePoolRequestKey: requestKey, previewKey, revision: 1, value });
    expect(cache.playback()).toBe(value);
    expect(cache.playback()).toBe(value);
  });

  it('invalidates candidates only for map/profile/mix/seed changes', () => {
    const key = ambientCandidatePoolRequestKey('map-a', city);
    expect(ambientCandidatePoolRequestKey('map-a', city)).toBe(key);
    expect(ambientPreviewKey(key, 'scenario-a')).not.toBe(ambientPreviewKey(key, 'scenario-b'));
    expect(ambientCandidatePoolRequestKey('map-b', city)).not.toBe(key);
    expect(ambientCandidatePoolRequestKey('map-a', { ...city, seed: 'regenerate' })).not.toBe(key);
    expect(ambientCandidatePoolRequestKey('map-a', profileForPreset('light', city))).not.toBe(key);
  });

  it('retains the visible preview on errors and ignores stale work', () => {
    const cache = new AmbientPreviewCache<string>();
    cache.commit(cache.begin(), { candidatePoolRequestKey: 'a', previewKey: 'a:1', revision: 1, value: 'visible' });
    cache.fail(cache.begin());
    expect(cache.playback()).toBe('visible');
    const stale = cache.begin();
    const current = cache.begin();
    expect(cache.commit(stale, { candidatePoolRequestKey: 'old', previewKey: 'old', revision: 1, value: 'old' })).toBe(false);
    expect(cache.commit(current, { candidatePoolRequestKey: 'new', previewKey: 'new', revision: 2, value: 'new' })).toBe(true);
    expect(cache.playback(1)).toBeNull();
    expect(cache.playback(2)).toBe('new');
  });

  it('hides an authored preview immediately after edit, controller rebind, or undo', () => {
    const green = { selectedController: 'controller-a', phase: 'green' };
    const revisionOne = { previewKey: 'map:controller-a:green', revision: 1, value: green };

    expect(previewForRevision(revisionOne, revisionOne.previewKey, 1)).toBe(green);
    // A different map/source cannot borrow a coincidentally equal revision number.
    expect(previewForRevision(revisionOne, 'other-map:controller-a:green', 1)).toBeNull();
    // Editing the phase or rebinding its exact controller advances the document revision.
    expect(previewForRevision(revisionOne, 'map:controller-b:yellow', 2)).toBeNull();
    // Undo is a new document revision too; it must rebuild rather than revive revision 1.
    expect(previewForRevision(revisionOne, revisionOne.previewKey, 3)).toBeNull();
  });

  it('keeps a rejected rematerialization from reclaiming the visible revision', () => {
    const cache = new AmbientPreviewCache<string>();
    cache.commit(cache.begin(), {
      candidatePoolRequestKey: 'map',
      previewKey: 'map:green',
      revision: 1,
      value: 'green',
    });
    const rejected = cache.begin();

    expect(cache.fail(rejected)).toBe(true);
    expect(cache.playback(2)).toBeNull();
    expect(previewForRevision(null, 'map:yellow', 2)).toBeNull();
  });
});

