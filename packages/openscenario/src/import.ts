import { parseTemplate, Sha256, type ScenarioTemplateV2 } from '@simforge-oss/scenario';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export const MAX_XOSC_BYTES = 1_048_576;
const MAX_XML_TAGS = 50_000;
const MAX_XML_DEPTH = 128;
const MAX_ACTORS = 64;

export type ImportDisposition = 'supported' | 'approximated' | 'unsupported';

export interface OpenScenarioImportDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly disposition: ImportDisposition;
  readonly message: string;
}

export interface OpenScenarioImportMapCandidate {
  readonly mapVersionId: string;
  /** Canonical compiler-facing identity supplied by the map catalog. */
  readonly sourceMapId: string;
  readonly label: string;
  readonly xodrSha256?: string | undefined;
  readonly aliases?: readonly string[] | undefined;
}

export interface OpenScenarioMapResolution {
  readonly status: 'resolved' | 'ambiguous' | 'unresolved' | 'conflict';
  readonly source: 'embedded-identity' | 'logic-file' | 'explicit' | null;
  readonly requestedIdentity: string | null;
  readonly candidates: readonly OpenScenarioImportMapCandidate[];
  readonly selectedMapVersionId: string | null;
  readonly diagnostic: OpenScenarioImportDiagnostic | null;
}

interface ImportedActor {
  readonly id: string;
  readonly kind: 'car' | 'truck' | 'bus' | 'van' | 'motorcycle' | 'bicycle' | 'pedestrian' | 'static_object';
  readonly catalogId?: string | undefined;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly heading: number;
  readonly speedKph?: number | undefined;
}

export interface OpenScenarioImportAnalysis {
  readonly standard: string;
  readonly source: {
    readonly byteLength: number;
    readonly sha256: string;
    readonly fileName: string;
    readonly mediaType: 'application/xml';
  };
  readonly title: string;
  readonly description: string;
  readonly logicFile: string | null;
  readonly embeddedMapIdentity: {
    readonly mapVersionId: string | null;
    readonly mapId: string | null;
    readonly xodrSha256: string | null;
  };
  readonly actors: readonly ImportedActor[];
  readonly diagnostics: readonly OpenScenarioImportDiagnostic[];
  readonly capabilities: Readonly<Record<ImportDisposition, number>>;
}

export class OpenScenarioImportError extends Error {
  override readonly name = 'OpenScenarioImportError';
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type XmlNode = Record<string, unknown>;
type ParsedXml = readonly XmlNode[];

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: false,
  htmlEntities: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
});

function nodeName(node: XmlNode): string | null {
  return Object.keys(node).find((key) => key !== ':@' && key !== '#text' && key !== '?xml') ?? null;
}

function nodeChildren(node: XmlNode): ParsedXml {
  const name = nodeName(node);
  return name && Array.isArray(node[name]) ? node[name] as ParsedXml : [];
}

function nodeAttrs(node: XmlNode): Record<string, string> {
  const raw = node[':@'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.replace(/^@_/, ''), String(value)]));
}

function descendants(nodes: ParsedXml, name: string): XmlNode[] {
  const found: XmlNode[] = [];
  for (const node of nodes) {
    if (nodeName(node) === name) found.push(node);
    found.push(...descendants(nodeChildren(node), name));
  }
  return found;
}

function firstDescendant(nodes: ParsedXml, name: string): XmlNode | null {
  return descendants(nodes, name)[0] ?? null;
}

function requiredFinite(raw: string | undefined, path: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new OpenScenarioImportError('invalid_number', `${path} must be a finite number.`);
  return value;
}

function validateBoundedXml(bytes: Uint8Array): ParsedXml {
  if (bytes.byteLength === 0) throw new OpenScenarioImportError('empty_file', 'The OpenSCENARIO file is empty.');
  if (bytes.byteLength > MAX_XOSC_BYTES) throw new OpenScenarioImportError('file_too_large', `OpenSCENARIO input exceeds ${MAX_XOSC_BYTES} bytes.`);
  let xml: string;
  try {
    xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new OpenScenarioImportError('invalid_encoding', 'OpenSCENARIO input must be valid UTF-8.');
  }
  if (/<!DOCTYPE\b/i.test(xml) || /<!ENTITY\b/i.test(xml)) {
    throw new OpenScenarioImportError('xml_declarations_forbidden', 'DTD and entity declarations are not allowed.');
  }
  const badEntity = xml.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/);
  if (badEntity) throw new OpenScenarioImportError('unknown_entity', 'Only built-in XML character references are allowed.');

  const tags = xml.match(/<[^>]*>/g) ?? [];
  if (tags.length > MAX_XML_TAGS) throw new OpenScenarioImportError('xml_too_complex', `XML contains more than ${MAX_XML_TAGS} tags.`);
  const validation = XMLValidator.validate(xml, { allowBooleanAttributes: false });
  if (validation !== true) throw new OpenScenarioImportError('malformed_xml', validation.err.msg || 'Malformed XML input.');
  let parsed: ParsedXml;
  try {
    parsed = xmlParser.parse(xml) as ParsedXml;
  } catch {
    throw new OpenScenarioImportError('malformed_xml', 'Malformed XML input.');
  }
  const root = parsed.find((node) => nodeName(node) === 'OpenSCENARIO');
  if (!root) throw new OpenScenarioImportError('not_openscenario', 'Root OpenSCENARIO element was not found.');
  const depth = (nodes: ParsedXml, current: number): number => nodes.reduce((max, node) => Math.max(max, depth(nodeChildren(node), current + 1)), current);
  if (depth([root], 1) > MAX_XML_DEPTH) throw new OpenScenarioImportError('xml_too_deep', `XML nesting exceeds ${MAX_XML_DEPTH}.`);
  return [root];
}

function safeId(value: string, index: number): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `actor_${index + 1}`;
}

function propertyMap(xml: ParsedXml): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const property of descendants(xml, 'Property')) {
    const attribute = nodeAttrs(property);
    if (!attribute.name || attribute.value === undefined) continue;
    values.set(attribute.name, [...(values.get(attribute.name) ?? []), attribute.value]);
  }
  return values;
}

function actorKind(tag: string, catalog: string | undefined): ImportedActor['kind'] {
  if (tag === 'Pedestrian') return 'pedestrian';
  if (tag === 'MiscObject') return 'static_object';
  const lower = (catalog ?? '').toLowerCase();
  if (lower.includes('truck')) return 'truck';
  if (lower.includes('bus')) return 'bus';
  if (lower.includes('van')) return 'van';
  if (lower.includes('motorcycle') || lower.includes('bike')) return 'motorcycle';
  return 'car';
}

function extractActors(xml: ParsedXml, diagnostics: OpenScenarioImportDiagnostic[]): ImportedActor[] {
  const entities = new Map<string, { tag: string; catalog?: string }>();
  for (const scenarioObject of descendants(xml, 'ScenarioObject')) {
    const name = nodeAttrs(scenarioObject).name;
    if (!name) continue;
    const kindNode = ['Vehicle', 'Pedestrian', 'MiscObject'].map((kind) => firstDescendant(nodeChildren(scenarioObject), kind)).find(Boolean);
    if (!kindNode) {
      diagnostics.push({ code: 'entity_type_unsupported', path: `Entities.${name}`, disposition: 'unsupported', message: 'Only Vehicle, Pedestrian, and MiscObject entities are translated.' });
      continue;
    }
    const catalog = firstDescendant(nodeChildren(scenarioObject), 'CatalogReference');
    const catalogId = catalog ? nodeAttrs(catalog).entryName : undefined;
    if (!catalogId) {
      diagnostics.push({ code: 'catalog_appearance_approximated', path: `Entities.${name}`, disposition: 'approximated', message: 'The ASAM entity class is preserved, but non-catalog appearance is resolved by the v2 editor catalog.' });
    }
    entities.set(name, { tag: nodeName(kindNode)!, catalog: catalogId });
  }
  if (entities.size > MAX_ACTORS) throw new OpenScenarioImportError('too_many_actors', `OpenSCENARIO contains more than ${MAX_ACTORS} supported actors.`);

  const actors: ImportedActor[] = [];
  let index = 0;
  for (const [name, entity] of entities) {
    const init = descendants(xml, 'Private').find((node) => nodeAttrs(node).entityRef === name);
    const world = init ? firstDescendant(nodeChildren(init), 'WorldPosition') : null;
    if (!world) {
      diagnostics.push({ code: 'actor_position_unsupported', path: `Storyboard.Init.${name}`, disposition: 'unsupported', message: 'Actor has no WorldPosition in Init; it was not translated because map-relative positions must not be guessed.' });
      continue;
    }
    const position = nodeAttrs(world);
    const speed = init ? firstDescendant(nodeChildren(init), 'AbsoluteTargetSpeed') : null;
    const speedValue = speed ? requiredFinite(nodeAttrs(speed).value, `Storyboard.Init.${name}.speed`) * 3.6 : undefined;
    actors.push({
      id: safeId(name, index),
      kind: actorKind(entity.tag, entity.catalog),
      catalogId: entity.catalog,
      x: requiredFinite(position.x, `Storyboard.Init.${name}.x`),
      y: requiredFinite(position.z ?? '0', `Storyboard.Init.${name}.z`),
      z: requiredFinite(position.y, `Storyboard.Init.${name}.y`),
      heading: requiredFinite(position.h ?? '0', `Storyboard.Init.${name}.h`),
      speedKph: speedValue,
    });
    index += 1;
  }
  return actors;
}

export function analyzeOpenScenarioImport(bytes: Uint8Array, fileName = 'scenario.xosc'): OpenScenarioImportAnalysis {
  const xml = validateBoundedXml(bytes);
  const diagnostics: OpenScenarioImportDiagnostic[] = [];
  const header = firstDescendant(xml, 'FileHeader');
  const headerAttrs = header ? nodeAttrs(header) : {};
  const revMajor = headerAttrs.revMajor ?? 'unknown';
  const revMinor = headerAttrs.revMinor ?? 'unknown';
  if (revMajor !== '1') diagnostics.push({ code: 'version_unsupported', path: 'FileHeader.revMajor', disposition: 'unsupported', message: `OpenSCENARIO major version ${revMajor} is not supported.` });
  else if (!['0', '1', '2', '3', '4'].includes(revMinor)) diagnostics.push({ code: 'version_newer_than_supported', path: 'FileHeader.revMinor', disposition: 'approximated', message: `Version 1.${revMinor} is parsed using the supported 1.x subset.` });

  const properties = propertyMap(xml);
  const logicNode = firstDescendant(xml, 'LogicFile');
  const logicFile = logicNode ? nodeAttrs(logicNode).filepath ?? null : null;
  const actors = extractActors(xml, diagnostics);
  diagnostics.push({ code: 'world_positions_preserved', path: 'Storyboard.Init', disposition: 'supported', message: `${actors.length} actor world position${actors.length === 1 ? '' : 's'} preserved exactly in a map-pinned v2 draft.` });
  if (actors.some((actor) => actor.speedKph !== undefined)) diagnostics.push({ code: 'initial_speeds_preserved', path: 'Storyboard.Init', disposition: 'supported', message: 'Absolute initial actor speeds were converted from m/s to km/h.' });
  if (descendants(xml, 'Trajectory').length || descendants(xml, 'FollowTrajectoryAction').length) diagnostics.push({ code: 'trajectory_not_editable', path: 'Storyboard', disposition: 'unsupported', message: 'Trajectory vertices remain in the source artifact but are not translated into editable v2 choreography.' });
  if (descendants(xml, 'ManeuverGroup').length || descendants(xml, 'Event').length || descendants(xml, 'Condition').length) diagnostics.push({ code: 'storyboard_semantics_not_translated', path: 'Storyboard.Story', disposition: 'unsupported', message: 'Storyboard events, triggers, conditions, and dynamics are preserved only in the source artifact.' });
  if (descendants(xml, 'TrafficSignalController').length || descendants(xml, 'TrafficSignalStateAction').length) diagnostics.push({ code: 'signal_semantics_not_translated', path: 'RoadNetwork.Signals', disposition: 'unsupported', message: 'Traffic-signal programs are preserved only in the source artifact.' });
  if (descendants(xml, 'EnvironmentAction').length) diagnostics.push({ code: 'environment_approximated', path: 'Storyboard.Init.EnvironmentAction', disposition: 'approximated', message: 'OpenSCENARIO environment details are retained in the source artifact; the v2 draft uses neutral environment defaults.' });
  const capabilities = diagnostics.reduce<Record<ImportDisposition, number>>((counts, item) => ({ ...counts, [item.disposition]: counts[item.disposition] + 1 }), { supported: 0, approximated: 0, unsupported: 0 });
  const identityProp = (names: string[], path: string, normalize: (value: string) => string = (value) => value) => {
    const values = names.flatMap((name) => properties.get(name) ?? []).map((value) => value.trim()).filter(Boolean);
    const distinct = new Map(values.map((value) => [normalize(value), value]));
    if (distinct.size > 1) {
      throw new OpenScenarioImportError(
        'map_identity_conflict',
        `${path} contains contradictory embedded values (${[...distinct.values()].join(', ')}).`,
      );
    }
    return distinct.values().next().value ?? null;
  };
  return {
    standard: `ASAM OpenSCENARIO ${revMajor}.${revMinor}`,
    source: { byteLength: bytes.byteLength, sha256: new Sha256().update(bytes).digestHex(), fileName, mediaType: 'application/xml' },
    title: headerAttrs.description?.trim() || fileName.replace(/\.xosc$/i, '') || 'Imported OpenSCENARIO',
    description: headerAttrs.description ?? '',
    logicFile,
    embeddedMapIdentity: {
      mapVersionId: identityProp(
        ['uniscenarios.mapVersionId', 'uniscenarios.provenance.mapVersionId'],
        'FileHeader.Properties.mapVersionId',
      ),
      mapId: identityProp(
        ['uniscenarios.mapId', 'uniscenarios.provenance.mapId'],
        'FileHeader.Properties.mapId',
      ),
      xodrSha256: identityProp(
        ['uniscenarios.xodrSha256', 'uniscenarios.provenance.xodrSha256'],
        'FileHeader.Properties.xodrSha256',
        (value) => value.toLowerCase(),
      )?.toLowerCase() ?? null,
    },
    actors,
    diagnostics,
    capabilities,
  };
}

function normalizedMapName(value: string): string {
  return value.split(/[\\/]/).at(-1)!.replace(/\.xodr$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolutionDiagnostic(code: string, path: string, message: string): OpenScenarioImportDiagnostic {
  return { code, path, disposition: 'unsupported', message };
}

function uniqueCandidates(candidates: readonly OpenScenarioImportMapCandidate[]) {
  return [...new Map(candidates.map((candidate) => [candidate.mapVersionId, candidate])).values()];
}

export function resolveOpenScenarioMap(analysis: OpenScenarioImportAnalysis, maps: readonly OpenScenarioImportMapCandidate[], explicitMapVersionId?: string | null): OpenScenarioMapResolution {
  const embedded = analysis.embeddedMapIdentity;
  if (embedded.mapVersionId || embedded.xodrSha256 || embedded.mapId) {
    const evidence = [
      embedded.mapVersionId ? { field: 'mapVersionId', value: embedded.mapVersionId, matches: maps.filter((map) => map.mapVersionId === embedded.mapVersionId) } : null,
      embedded.xodrSha256 ? { field: 'xodrSha256', value: embedded.xodrSha256, matches: maps.filter((map) => map.xodrSha256?.toLowerCase() === embedded.xodrSha256) } : null,
      // sourceMap.mapId is the canonical source-map identity, not the immutable map-version id.
      // Human-readable labels and aliases belong only to the weak LogicFile path below.
      embedded.mapId ? { field: 'mapId', value: embedded.mapId, matches: maps.filter((map) => map.sourceMapId === embedded.mapId) } : null,
    ].filter((value): value is { field: string; value: string; matches: OpenScenarioImportMapCandidate[] } => value !== null);
    const union = uniqueCandidates(evidence.flatMap((item) => item.matches));
    const commonIds = evidence.reduce<Set<string> | null>((common, item) => {
      const ids = new Set(item.matches.map((map) => map.mapVersionId));
      return common === null ? ids : new Set([...common].filter((id) => ids.has(id)));
    }, null) ?? new Set<string>();
    const selected = uniqueCandidates(maps.filter((map) => commonIds.has(map.mapVersionId)));
    const requestedIdentity = embedded.mapVersionId ?? embedded.xodrSha256 ?? embedded.mapId;
    const missing = evidence.filter((item) => item.matches.length === 0);

    if (explicitMapVersionId) {
      const explicit = uniqueCandidates(maps.filter((map) => map.mapVersionId === explicitMapVersionId));
      if (explicit.length !== 1) {
        return {
          status: 'unresolved', source: 'explicit', requestedIdentity: explicitMapVersionId,
          candidates: explicit, selectedMapVersionId: null,
          diagnostic: resolutionDiagnostic('explicit_map_not_found', 'mapVersionId', `Explicit map version ${explicitMapVersionId} is not available.`),
        };
      }
      const contradictions = evidence.filter((item) => !item.matches.some((map) => map.mapVersionId === explicitMapVersionId));
      if (contradictions.length > 0) {
        const detail = contradictions.map((item) => `${item.field}=${item.value}`).join(', ');
        return {
          status: 'conflict', source: 'embedded-identity', requestedIdentity,
          candidates: uniqueCandidates([...explicit, ...union]), selectedMapVersionId: null,
          diagnostic: resolutionDiagnostic(
            'map_identity_conflict',
            'FileHeader.Properties',
            `Explicit map version ${explicitMapVersionId} conflicts with strong embedded OpenSCENARIO identity (${detail}). Choose the map named by the file or correct the file identity.`,
          ),
        };
      }
    }

    if (missing.length === evidence.length) {
      return {
        status: 'unresolved', source: 'embedded-identity', requestedIdentity,
        candidates: [], selectedMapVersionId: null,
        diagnostic: resolutionDiagnostic('embedded_map_identity_not_found', 'FileHeader.Properties', 'No available map matches the strong embedded OpenSCENARIO identity.'),
      };
    }
    if (missing.length > 0 || selected.length === 0) {
      const detail = evidence.map((item) => `${item.field}=${item.value}`).join(', ');
      return {
        status: 'conflict', source: 'embedded-identity', requestedIdentity,
        candidates: union, selectedMapVersionId: null,
        diagnostic: resolutionDiagnostic('map_identity_conflict', 'FileHeader.Properties', `Strong embedded OpenSCENARIO identities do not converge on one map (${detail}).`),
      };
    }
    if (selected.length > 1) {
      return {
        status: 'ambiguous', source: 'embedded-identity', requestedIdentity,
        candidates: selected, selectedMapVersionId: null,
        diagnostic: resolutionDiagnostic('embedded_map_identity_ambiguous', 'FileHeader.Properties', 'Strong embedded OpenSCENARIO identity matches multiple map versions and cannot be disambiguated explicitly.'),
      };
    }
    return {
      status: 'resolved', source: 'embedded-identity', requestedIdentity,
      candidates: selected, selectedMapVersionId: selected[0]!.mapVersionId, diagnostic: null,
    };
  }

  if (explicitMapVersionId) {
    const selected = uniqueCandidates(maps.filter((map) => map.mapVersionId === explicitMapVersionId));
    return {
      status: selected.length === 1 ? 'resolved' : 'unresolved', source: 'explicit', requestedIdentity: explicitMapVersionId,
      candidates: selected, selectedMapVersionId: selected.length === 1 ? selected[0]!.mapVersionId : null,
      diagnostic: selected.length === 1 ? null : resolutionDiagnostic('explicit_map_not_found', 'mapVersionId', `Explicit map version ${explicitMapVersionId} is not available.`),
    };
  }
  if (analysis.logicFile) {
    const wanted = normalizedMapName(analysis.logicFile);
    const selected = uniqueCandidates(maps.filter((map) => [map.mapVersionId, map.label, ...(map.aliases ?? [])].some((name) => normalizedMapName(name) === wanted)));
    const status = selected.length === 1 ? 'resolved' : selected.length > 1 ? 'ambiguous' : 'unresolved';
    return {
      status, source: 'logic-file', requestedIdentity: analysis.logicFile, candidates: selected,
      selectedMapVersionId: selected.length === 1 ? selected[0]!.mapVersionId : null,
      diagnostic: status === 'resolved' ? null : resolutionDiagnostic(
        status === 'ambiguous' ? 'logic_file_ambiguous' : 'logic_file_not_found',
        'RoadNetwork.LogicFile',
        status === 'ambiguous' ? 'LogicFile matches multiple maps; choose one explicitly.' : 'LogicFile does not match an available map; choose one explicitly.',
      ),
    };
  }
  return {
    status: 'unresolved', source: null, requestedIdentity: null, candidates: [], selectedMapVersionId: null,
    diagnostic: resolutionDiagnostic('map_identity_missing', 'RoadNetwork', 'The OpenSCENARIO file has no embedded map identity; choose a map explicitly.'),
  };
}

export function translateOpenScenarioImport(
  analysis: OpenScenarioImportAnalysis,
  sourceArtifact: { artifactId: string; sha256: string; byteLength: number; mediaType: 'application/xml' },
  map: OpenScenarioImportMapCandidate,
  importedAt = new Date().toISOString(),
): ScenarioTemplateV2 {
  if (sourceArtifact.sha256 !== analysis.source.sha256 || sourceArtifact.byteLength !== analysis.source.byteLength || sourceArtifact.mediaType !== analysis.source.mediaType) {
    throw new OpenScenarioImportError('source_artifact_mismatch', 'The stored source artifact does not match the analyzed OpenSCENARIO bytes.');
  }
  const roles = analysis.actors.map((actor) => ({
    id: actor.id,
    kind: 'scene_absolute' as const,
    label: actor.id,
    actor: { class: actor.kind, ...(actor.catalogId ? { catalogId: actor.catalogId } : {}), static: actor.kind === 'static_object' },
    pose: { position: { x: actor.x, y: actor.y, z: actor.z }, headingRad: actor.heading },
    ...(actor.speedKph === undefined ? {} : { initialSpeedKph: actor.speedKph }),
  }));
  return parseTemplate({
    scenarioVersion: 2,
    meta: { name: analysis.title.slice(0, 200), description: analysis.description.slice(0, 4000), createdAt: importedAt, modifiedAt: importedAt, appVersion: 'xosc-import/v1', tags: ['openscenario-import'], author: 'OpenSCENARIO import' },
    sourceMap: { mapId: map.sourceMapId, mapName: map.label, ...(map.xodrSha256 ? { xodrSha256: map.xodrSha256 } : {}) },
    anchor: { id: 'imported_scene', pin: { mapId: map.sourceMapId } },
    roles,
    choreography: { clipSeconds: 20, warmupSeconds: 0, interactions: [] },
    metricSubject: roles[0]?.id,
    extensions: {
      openScenarioImport: {
        version: 1,
        importedAt,
        source: { ...analysis.source, artifactId: sourceArtifact.artifactId },
        mapResolution: { mapVersionId: map.mapVersionId, label: map.label },
        report: { standard: analysis.standard, logicFile: analysis.logicFile, embeddedMapIdentity: analysis.embeddedMapIdentity, diagnostics: analysis.diagnostics, capabilities: analysis.capabilities },
      },
    },
  });
}

