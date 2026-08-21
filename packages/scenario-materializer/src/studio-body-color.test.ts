import type { ScenarioTemplateV2 } from '@uniscenarios/scenario-model';
import type { SimScenarioInput } from '@uniscenarios/sim-engine';
import { describe, expect, it } from 'vitest';

import {
  normalizeStudioBodyColor,
  studioBodyColorTag,
  withStudioBodyColorTags,
} from './materialize.js';

describe('Studio body color materialization', () => {
  it('normalizes supported authored colors into playback tags', () => {
    expect(studioBodyColorTag('#8C2F2F')).toBe('studio:body-color:#8c2f2f');
    expect(studioBodyColorTag('#abc')).toBe('studio:body-color:#aabbcc');
    expect(studioBodyColorTag('rgb(47, 107, 63)')).toBe('studio:body-color:#2f6b3f');
    expect(studioBodyColorTag('201,138,46')).toBe('studio:body-color:#c98a2e');
  });

  it('does not project malformed presentation metadata into simulator input', () => {
    for (const value of [undefined, '', '#12', '#xyzxyz', '256,0,0', '1.5,2,3']) {
      expect(normalizeStudioBodyColor(value)).toBeNull();
      expect(studioBodyColorTag(value)).toBeNull();
    }
  });

  it('authoritatively reconciles stored input tags with the current template', () => {
    const input = {
      actors: [{
        id: 'car',
        tags: ['role:hero', 'motion:reverse', 'studio:body-color:#0d0f12'],
      }],
    } as SimScenarioInput;
    const template = {
      roles: [{
        id: 'hero',
        extensions: { 'studio.presentation.bodyColor': '#E8E9EA' },
      }],
    } as unknown as ScenarioTemplateV2;

    const result = withStudioBodyColorTags(input, template);
    expect(result.actors[0]?.tags).toEqual([
      'role:hero',
      'motion:reverse',
      'studio:body-color:#e8e9ea',
    ]);
    expect(withStudioBodyColorTags(result, template)).toBe(result);
  });

  it('leaves unrelated actors and inputs untouched by identity', () => {
    const input = { actors: [{ id: 'ambient', tags: ['ambient'] }] } as SimScenarioInput;
    const template = { roles: [] } as unknown as ScenarioTemplateV2;
    expect(withStudioBodyColorTags(input, template)).toBe(input);
  });
});
