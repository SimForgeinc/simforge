import { describe, expect, it } from 'vitest';

import { createRenderEngine, resolveBinary } from './engine.js';
import { stripRgbaPadding } from './service-client.js';

describe('native retained engine adapter', () => {
  it('declares only the observable RGB and artifact contract', () => {
    const engine = createRenderEngine({ binary: '/bin/true' });
    expect(engine.capabilities).toMatchObject({
      engineId: 'bevy-retained',
      backend: 'native',
      modalities: ['rgb'],
      requiresGpu: true,
    });
    expect(engine.capabilities.capabilities).toEqual(expect.arrayContaining([
      'sensor.rgb', 'artifact.video', 'artifact.manifest', 'artifact.trace',
    ]));
    expect(engine.capabilities.capabilities).not.toEqual(expect.arrayContaining([
      'sensor.depth', 'sensor.semantic', 'sensor.instance', 'sensor.lidar', 'sensor.radar',
    ]));
  });

  it('resolves the retained service binary from explicit options', () => {
    expect(resolveBinary({ binary: '/opt/native-render-service' })).toBe('/opt/native-render-service');
  });

  it('removes wgpu row padding before rawvideo encoding', () => {
    const width = 65;
    const height = 2;
    const stride = 512;
    const padded = Buffer.alloc(stride * height, 0xee);
    padded.fill(1, 0, width * 4);
    padded.fill(2, stride, stride + width * 4);
    const packed = stripRgbaPadding(padded, width, height);
    expect(packed).toHaveLength(width * height * 4);
    expect([...packed.subarray(0, width * 4)]).toEqual(new Array(width * 4).fill(1));
    expect([...packed.subarray(width * 4)]).toEqual(new Array(width * 4).fill(2));
  });
});
