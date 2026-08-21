import { describe, expect, it, vi } from 'vitest';
import { EngineCapabilityDeclarationSchema } from '@uniscenarios/render-runtime';
import { decodePlaybackArtifact, createRenderEngine } from './engine.js';
const parsePlaybackPair = vi.hoisted(() => vi.fn(() => ({ actors: [{ id: 'ego' }] })));
vi.mock('@uniscenarios/playback', () => ({ parsePlaybackPair }));

describe('browser render engine registration', () => {
  it('publishes the canonical worker capability declaration', () => {
    const engine = createRenderEngine({ engineVersion: 'test-build' });

    expect(EngineCapabilityDeclarationSchema.parse(engine.capabilities)).toMatchObject({
      schema: 'uniscenario.render-engine-capabilities/v1',
      engineId: 'browser',
      engineVersion: 'test-build',
      backend: 'browser',
      protocolVersion: 1,
      modalities: ['rgb', 'depth', 'semantic', 'instance', 'lidar', 'radar'],
      requiresGpu: true,
    });
  });

  it('unwraps persisted SimCloud preview artifacts before rendering', () => {
    const instance = { manifest: {}, input: {} };
    const trace = { header: {}, ticks: [] };
    const decoded = decodePlaybackArtifact({
      schema: 'simforge.uniscenario-browser-preview/v2',
      draftVersion: 3,
      instance,
      trace,
      mapCollisions: { available: true },
    });

    expect(parsePlaybackPair).toHaveBeenCalledWith(instance, trace, {
      instanceName: 'saved scenario',
      traceName: 'saved simulation',
    });
    expect(decoded).toMatchObject({
      actors: [{ id: 'ego' }],
      mapCollisions: { available: true },
    });
  });
});
