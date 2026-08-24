import { describe, expect, it } from 'vitest';
import { pruneDanglingAfterInteractions, type Interaction } from '../index.js';

const at = (id: string): Interaction => ({
  id, actorId: 'car', trigger: { kind: 'at', t: 1 }, verb: 'set', target: { key: 'audio.horn', value: true },
});
const after = (id: string, source: string): Interaction => ({
  id, actorId: 'car', trigger: { kind: 'after', interactionId: source, delayS: 0 }, verb: 'set', target: { key: 'audio.horn', value: false },
});

describe('concrete interaction repair', () => {
  it('atomically prunes direct and transitive orphaned commands', () => {
    const repaired = pruneDanglingAfterInteractions([
      at('kept-command'),
      after('cross-red', 'cross-traffic-clears'),
      after('ambulance-exempt', 'ambulance-siren'),
      after('horn-followup', 'ambulance-horn-1-on'),
      after('transitive-followup', 'horn-followup'),
    ]);
    expect(repaired.interactions.map((interaction) => interaction.id)).toEqual(['kept-command']);
    expect(repaired.removed).toEqual([
      { interactionId: 'cross-red', missingInteractionId: 'cross-traffic-clears' },
      { interactionId: 'ambulance-exempt', missingInteractionId: 'ambulance-siren' },
      { interactionId: 'horn-followup', missingInteractionId: 'ambulance-horn-1-on' },
      { interactionId: 'transitive-followup', missingInteractionId: 'horn-followup' },
    ]);
  });

  it('preserves a fully linked concrete timeline byte-semantically', () => {
    const interactions = [at('source'), after('dependent', 'source')];
    expect(pruneDanglingAfterInteractions(interactions)).toEqual({ interactions, removed: [] });
  });
});
