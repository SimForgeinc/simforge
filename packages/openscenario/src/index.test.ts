import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { exportOpenScenarioXml14 } from './index.js';
import { OFFICIAL_OPENSCENARIO_140_XSD } from './node/index.js';

describe('./index.js public boundary', () => {
  it('exposes the canonical OpenSCENARIO XML exporter', () => {
    expect(exportOpenScenarioXml14).toBeTypeOf('function');
  });

  it('ships the exact official OpenSCENARIO 1.4 schema used by every runtime', async () => {
    const schema = await readFile(new URL('../schema/OpenSCENARIO.xsd', import.meta.url));
    expect(createHash('sha256').update(schema).digest('hex')).toBe(
      OFFICIAL_OPENSCENARIO_140_XSD.xsdSha256,
    );
  });
});
