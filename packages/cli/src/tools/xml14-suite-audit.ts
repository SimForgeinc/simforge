import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { buildLaneGraph, parseSimScenarioInput, type LaneGraph, type TopologyIndex } from '@uniscenarios/sim-engine';
import { AsamExportError, exportOpenScenarioXml14 } from '@uniscenarios/openscenario/export';
import { validateOpenScenarioXml14 } from '@uniscenarios/openscenario/node';
import { DEV_ASSETS } from '@uniscenarios/scenario-materializer';

export type AuditVerdict = 'xsd-validated' | 'unsupported-fail-closed' | 'asset-blocked' | 'unexpected-failure';

export interface AuditResult {
  readonly id: string;
  readonly mapId?: string;
  readonly verdict: AuditVerdict;
  readonly [key: string]: unknown;
}

export interface AuditCounts {
  readonly total: number;
  readonly xsdValidated: number;
  readonly unsupportedFailClosed: number;
  readonly assetBlocked: number;
  readonly unexpectedFailures: number;
  readonly expectationMismatches: number;
}

export type SuiteExpectation =
  | { readonly verdict: 'xsd-validated'; readonly warningCodeCounts: Readonly<Record<string, number>> }
  | { readonly verdict: 'unsupported-fail-closed'; readonly issueCodeCounts: Readonly<Record<string, number>> };

export const XML14_CURATED_SUITE_EXPECTATIONS: Readonly<Record<string, SuiteExpectation>> = Object.freeze({
  'ec-01-01-construction-chicane-reversing-truck-v2#0': { verdict: 'unsupported-fail-closed', issueCodeCounts: { missing_signal_map_binding: 2, unsupported_prop: 12 } },
  'ec-02-02-police-roadside-stop-v2#0': { verdict: 'xsd-validated', warningCodeCounts: { catalog_appearance_approximate: 4, field_omitted: 1, nonportable_emergency_cue: 1, semantic_intent_flattened: 3 } },
  'ec-03-03-red-light-ambulance-preemption-v2#0': { verdict: 'xsd-validated', warningCodeCounts: { catalog_appearance_approximate: 5, field_omitted: 1, nonportable_emergency_cue: 5, semantic_intent_flattened: 3 } },
  'ec-04-04-child-emerging-behind-bus-v2#0': { verdict: 'xsd-validated', warningCodeCounts: { catalog_appearance_approximate: 5, field_omitted: 2, semantic_intent_flattened: 4, user_defined_animation: 1 } },
  'ec-05-05-cyclist-occlusion-conflict-v2#0': { verdict: 'unsupported-fail-closed', issueCodeCounts: { unsupported_prop: 1 } },
  'ec-06-06-wrong-way-vehicle-blind-approach-v2#0': { verdict: 'unsupported-fail-closed', issueCodeCounts: { unsupported_prop: 19 } },
  'ec-07-07-protected-left-red-runner-v2#0': { verdict: 'xsd-validated', warningCodeCounts: { catalog_appearance_approximate: 4, field_omitted: 2, semantic_intent_flattened: 4 } },
  'ec-08-08-zipper-merge-lane-closure-v2#0': { verdict: 'unsupported-fail-closed', issueCodeCounts: { missing_signal_map_binding: 1, unsupported_prop: 16 } },
  'ec-09-09-stalled-vehicle-beyond-sight-v2#0': { verdict: 'unsupported-fail-closed', issueCodeCounts: { unsupported_set_action: 1 } },
  'ec-10-10-officer-flashing-red-junction-v2#0': { verdict: 'unsupported-fail-closed', issueCodeCounts: { unsupported_prop: 3 } },
  'ec-11-11-double-threat-crosswalk-v2#0': { verdict: 'xsd-validated', warningCodeCounts: { catalog_appearance_approximate: 4, field_omitted: 2, semantic_intent_flattened: 4 } },
  'ec-12-12-fire-engine-gridlock-escape-v2#0': { verdict: 'xsd-validated', warningCodeCounts: { catalog_appearance_approximate: 5, field_omitted: 1, nonportable_emergency_cue: 5, semantic_intent_flattened: 3 } },
});

export class AuditAssetError extends Error {
  override readonly name = 'AuditAssetError';
  constructor(readonly code: 'asset-missing' | 'asset-invalid' | 'asset-stale' | 'instance-topology-stale', message: string) {
    super(message);
  }
}

interface InstanceFile {
  readonly input: unknown;
  readonly manifest?: {
    readonly instanceId?: string;
    readonly replayKey?: { readonly mapId?: string; readonly engineGraphDigest?: string };
  };
}

export interface ProductionAuditMap {
  readonly mapId: string;
  readonly graph: LaneGraph;
  readonly xodrSha256: string;
  readonly xodrPath: string;
  readonly topologyPath: string;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const codeCounts = (entries: readonly { readonly code: string }[]): Record<string, number> => Object.fromEntries(
  [...entries.reduce((counts, entry) => counts.set(entry.code, (counts.get(entry.code) ?? 0) + 1), new Map<string, number>())]
    .sort(([left], [right]) => left.localeCompare(right)),
);

/** Load the exact checked production XODR/topology pair; never synthesize a graph. */
export async function loadProductionAuditMap(mapId: string, assetRoot = DEV_ASSETS): Promise<ProductionAuditMap> {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(mapId)) throw new AuditAssetError('asset-invalid', `unsafe map id ${mapId}`);
  const mapRoot = path.resolve(assetRoot, mapId);
  const boundary = `${path.resolve(assetRoot)}${path.sep}`;
  if (!mapRoot.startsWith(boundary)) throw new AuditAssetError('asset-invalid', `map ${mapId} escaped the asset root`);
  const xodrPath = path.join(mapRoot, 'map.xodr');
  const topologyPath = path.join(mapRoot, 'topology-index.json.gz');
  let xodrBytes: Uint8Array, topologyBytes: Uint8Array;
  try {
    [xodrBytes, topologyBytes] = await Promise.all([readFile(xodrPath), readFile(topologyPath)]);
  } catch (error) {
    throw new AuditAssetError('asset-missing', `production map assets unavailable for ${mapId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const xodrSha256 = sha256(xodrBytes);
  let topology: TopologyIndex;
  try {
    const plain = topologyBytes[0] === 0x1f && topologyBytes[1] === 0x8b ? gunzipSync(topologyBytes) : topologyBytes;
    topology = JSON.parse(Buffer.from(plain).toString('utf8')) as TopologyIndex;
  } catch (error) {
    throw new AuditAssetError('asset-invalid', `invalid production topology for ${mapId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (topology.source?.xodrSha256 !== xodrSha256) throw new AuditAssetError(
    'asset-stale',
    `production topology/XODR digest mismatch for ${mapId}: topology ${topology.source?.xodrSha256 ?? 'none'}, XODR ${xodrSha256}`,
  );
  return { mapId, graph: buildLaneGraph(topology), xodrSha256, xodrPath, topologyPath };
}

export async function auditXml14Instance(
  file: string,
  xsdPath: string,
  loadMap: (mapId: string) => Promise<ProductionAuditMap> = (mapId) => loadProductionAuditMap(mapId),
): Promise<AuditResult> {
  let parsed: InstanceFile;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8')) as InstanceFile;
  } catch (error) {
    return { id: path.basename(path.dirname(file)), verdict: 'unexpected-failure', stage: 'instance-read', message: error instanceof Error ? error.message : String(error) };
  }
  const id = parsed.manifest?.instanceId ?? path.basename(path.dirname(file));
  let mapId: string | undefined;
  let productionMap: ProductionAuditMap | undefined;
  try {
    const input = parseSimScenarioInput(parsed.input);
    mapId = input.mapId;
    productionMap = await loadMap(input.mapId);
    const replayKey = parsed.manifest?.replayKey;
    if (replayKey?.mapId && replayKey.mapId !== input.mapId) throw new AuditAssetError(
      'instance-topology-stale', `instance replay map ${replayKey.mapId} does not match input map ${input.mapId}`,
    );
    if (replayKey?.engineGraphDigest && replayKey.engineGraphDigest !== productionMap.graph.topologyDigest) throw new AuditAssetError(
      'instance-topology-stale',
      `instance graph ${replayKey.engineGraphDigest} does not match production graph ${productionMap.graph.topologyDigest}`,
    );
    const exported = exportOpenScenarioXml14(input, {
      graph: productionMap.graph,
      executionMode: 'trajectory-replay',
      roadFile: `${input.mapId}.xodr`,
      headerDate: '1970-01-01T00:00:00.000Z',
    });
    const validation = await validateOpenScenarioXml14(exported.content, xsdPath);
    const warningCodeCounts = codeCounts(exported.warnings);
    return validation.valid
      ? { id, mapId: input.mapId, verdict: 'xsd-validated', warnings: exported.warnings, warningCodeCounts, warningCount: exported.warnings.length, xodrSha256: productionMap.xodrSha256 }
      : { id, mapId: input.mapId, verdict: 'unexpected-failure', stage: 'official-xsd', diagnostics: validation.diagnostics };
  } catch (error) {
    if (error instanceof AuditAssetError) return { id, ...(mapId ? { mapId } : {}), verdict: 'asset-blocked', assetCode: error.code, message: error.message };
    if (error instanceof AsamExportError && error.issues.length > 0) return {
      id,
      ...(mapId ? { mapId } : {}),
      verdict: 'unsupported-fail-closed',
      ...(productionMap ? { xodrSha256: productionMap.xodrSha256 } : {}),
      issueCodes: [...new Set(error.issues.map((issue) => issue.code))].sort(),
      issueCodeCounts: codeCounts(error.issues),
      issueReasons: [...new Set(error.issues.map((issue) => issue.reason))].sort(),
      issueCount: error.issues.length,
    };
    return { id, ...(mapId ? { mapId } : {}), verdict: 'unexpected-failure', stage: 'export', message: error instanceof Error ? error.message : String(error) };
  }
}

export function auditExpectationMismatches(
  results: readonly AuditResult[],
  expectations: Readonly<Record<string, SuiteExpectation>> = XML14_CURATED_SUITE_EXPECTATIONS,
): readonly { readonly id: string; readonly message: string }[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  const mismatches: { id: string; message: string }[] = [];
  for (const id of [...new Set([...Object.keys(expectations), ...byId.keys()])].sort()) {
    const expected = expectations[id], actual = byId.get(id);
    if (!expected) { mismatches.push({ id, message: `scenario has no explicit support baseline; actual ${actual?.verdict ?? 'missing'}` }); continue; }
    if (!actual) { mismatches.push({ id, message: `expected ${expected.verdict}, scenario result is missing` }); continue; }
    if (actual.verdict !== expected.verdict) {
      mismatches.push({ id, message: `expected ${expected.verdict}, received ${actual.verdict}` });
      continue;
    }
    const rawCounts = expected.verdict === 'unsupported-fail-closed'
      ? actual['issueCodeCounts']
      : actual['warningCodeCounts'];
    const actualCounts: Record<string, number> = rawCounts !== null && typeof rawCounts === 'object' && !Array.isArray(rawCounts)
      ? Object.fromEntries(Object.entries(rawCounts).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
      : {};
    const ordered = (counts: Readonly<Record<string, number>>): Record<string, number> => Object.fromEntries(
      Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)),
    );
    const expectedCounts = ordered(expected.verdict === 'unsupported-fail-closed' ? expected.issueCodeCounts : expected.warningCodeCounts);
    const receivedCounts = ordered(actualCounts);
    if (JSON.stringify(receivedCounts) !== JSON.stringify(expectedCounts)) mismatches.push({
      id, message: `expected ${expected.verdict === 'unsupported-fail-closed' ? 'issue' : 'warning'} counts ${JSON.stringify(expectedCounts)}, received ${JSON.stringify(receivedCounts)}`,
    });
  }
  return mismatches;
}

export function summarizeAuditResults(
  results: readonly AuditResult[],
  expectations: Readonly<Record<string, SuiteExpectation>> = XML14_CURATED_SUITE_EXPECTATIONS,
): AuditCounts {
  return {
    total: results.length,
    xsdValidated: results.filter((item) => item.verdict === 'xsd-validated').length,
    unsupportedFailClosed: results.filter((item) => item.verdict === 'unsupported-fail-closed').length,
    assetBlocked: results.filter((item) => item.verdict === 'asset-blocked').length,
    unexpectedFailures: results.filter((item) => item.verdict === 'unexpected-failure').length,
    expectationMismatches: auditExpectationMismatches(results, expectations).length,
  };
}

export function auditGatePassed(counts: AuditCounts): boolean {
  return counts.total > 0 && counts.xsdValidated > 0 && counts.assetBlocked === 0
    && counts.unexpectedFailures === 0 && counts.expectationMismatches === 0;
}
