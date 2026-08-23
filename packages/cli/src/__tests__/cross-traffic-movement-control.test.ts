import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CliError } from '../errors.js';
import { REPO_ROOT, artifactPresence } from '@uniscenarios/scenario-materializer';
import { materialize } from '../materialize.js';
import { matchOnMap } from '@uniscenarios/scenario-materializer';
import { readTemplate } from '@uniscenarios/scenario-materializer';

const TEMPLATE = path.join(
  REPO_ROOT,
  'examples',
  'mechanisms',
  'remaining',
  'cross-traffic-stop-violation.template.json',
);
const EASTERBROOK = 'easterbrook-discovery-school';
const RICHMOND = 'richmond-field-station';
const haveArtifacts = [EASTERBROOK, RICHMOND].every((mapId) => {
  const present = artifactPresence(mapId);
  return present.topologyIndex && present.derivedTopology && present.locations;
});

describe.skipIf(!haveArtifacts)('cross-traffic stop violation movement controls', () => {
  it('rejects Easterbrook when the physical stop belongs to ego rather than the violator', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, EASTERBROOK);
    const site = matched.report.sites.find((candidate) => candidate.siteId === '7d84024ee796fff8');
    expect(site).toBeDefined();

    let finding: CliError | undefined;
    try {
      materialize(template, matched.bundle, site!, { drawIndex: 0 });
    } catch (error) {
      if (error instanceof CliError) finding = error;
      else throw error;
    }
    expect(finding).toMatchObject({
      code: 'movement_priority_missing',
      path: 'roles.ego.requiredMovementControl',
    });
    expect(finding?.message).toContain('physically stop-controlled');
  }, 30_000);

  it('keeps a globally truthful exact site with stop-controlled violator and priority ego', async () => {
    const template = await readTemplate(TEMPLATE);
    const matched = await matchOnMap(template, RICHMOND);
    const site = matched.report.sites.find((candidate) => candidate.siteId === '2cda652b106a107f');
    expect(site).toBeDefined();

    const result = materialize(template, matched.bundle, site!, { drawIndex: 0 });
    expect(result.manifest.feasible).toBe(true);
    expect(result.manifest.issues).toEqual([]);
    expect(template.roles.find((role) => role.id === 'violator')).toMatchObject({
      requiredMovementControl: 'stop',
    });
    expect(template.roles.find((role) => role.id === 'ego')).toMatchObject({
      requiredMovementControl: 'uncontrolled',
    });
  }, 30_000);
});
