import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decodeTopologyIndex } from '../index.js';

const topology = {
  schemaVersion: 1,
  mapName: 'test-map',
  lanes: {},
  gates: [],
  junctions: {},
};

describe('decodeTopologyIndex', () => {
  it('decodes plain and gzip-compressed topology sidecars', async () => {
    const plain = new TextEncoder().encode(JSON.stringify(topology));
    await expect(decodeTopologyIndex(plain)).resolves.toEqual(topology);
    await expect(decodeTopologyIndex(gzipSync(plain))).resolves.toEqual(topology);
  });

  it('rejects JSON that is not a topology index', async () => {
    await expect(decodeTopologyIndex(new TextEncoder().encode('{}'))).rejects.toThrow(
      'missing its lanes object',
    );
  });
});
