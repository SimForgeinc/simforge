
import { readTemplate } from '../src/template-io.ts';
import { findSite } from '../src/sites.ts';
import { materialize } from '../src/materialize.ts';
import { createAmbientCandidatePool, materializeAmbientCandidatePool, resolveAmbientTrafficProfile } from '@simforge-oss/engine';

const [tpl, mapId, siteId] = process.argv.slice(2);
const template = await readTemplate(tpl);
const { bundle, site } = await findSite(template, mapId, siteId, {});
const { input } = materialize(template, bundle, site, { drawIndex: 0 });
for (const [radiusM, density, maxActors] of [[90,24,40],[120,16,40],[120,40,64]] as const) {
  const profile = { version: 1 as const, preset: 'city' as const, radiusM, densityVehiclesPerKm: density, maxActors };
  const pool = createAmbientCandidatePool(bundle.graph, profile);
  const r = materializeAmbientCandidatePool(input, bundle.graph, pool);
  const placed = r.input.actors.filter((a) => a.tags.includes('ambient'));
  console.log(JSON.stringify({
    radiusM, density, maxActors,
    poolCandidates: pool.candidates.length,
    eligibleLaneKm: +r.provenance.eligibleLaneKm.toFixed(3),
    target: Math.min(maxActors, Math.round(r.provenance.eligibleLaneKm * density)),
    placed: placed.length,
    rejected: r.provenance.rejectedSpawnCount,
    corridorRejects: r.provenance.authoredCorridorRejects,
    corridorLanes: r.provenance.authoredCorridorLaneRsls.length,
  }));
}
