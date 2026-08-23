import { describe, expect, it } from 'vitest';

import { createRenderEngine, resolveBinary } from './engine.js';
import { createTar } from './tar.js';

describe('deterministic tar', () => {
  it('produces byte-identical archives across invocations', () => {
    const entries = [
      { name: 'frame-00000.rgb.png', data: new Uint8Array([1, 2, 3]) },
      { name: 'frame-00001.rgb.png', data: new Uint8Array(700) },
    ];
    const first = Buffer.from(createTar(entries));
    const second = Buffer.from(createTar(entries));
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(257, 263).toString()).toBe('ustar\0');
    // Size field is octal with NUL padding.
    expect(Number.parseInt(first.subarray(124, 136).toString().replace(/\0.*/, ''), 8)).toBe(3);
    // Archive length is a whole number of 512-byte blocks including terminator.
    expect(first.length % 512).toBe(0);
  });
});

describe('native engine adapter', () => {
  it('declares a valid capability set', () => {
    const engine = createRenderEngine({ binary: '/bin/true' });
    expect(engine.capabilities.backend).toBe('native');
    expect(engine.capabilities.capabilities.length).toBeGreaterThan(0);
    expect(new Set(engine.capabilities.modalities).size).toBe(engine.capabilities.modalities.length);
  });

  it('resolves the binary from options over env over defaults', () => {
    expect(resolveBinary({ binary: '/opt/native-render-job' })).toBe('/opt/native-render-job');
  });
});
