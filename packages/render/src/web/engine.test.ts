import { describe, expect, it } from 'vitest';
import { EngineCapabilityDeclarationSchema } from '../index.js';
import { createRenderEngine } from './engine.js';

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
      requiresGpu: false,
    });
  });
});
