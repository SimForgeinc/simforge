/**
 * Reading and writing the three file kinds the CLI moves between commands:
 * templates (`*.template.json`), instances (`*.instance.json`) and traces
 * (`*.trace.json.gz`).
 *
 * Every reader returns structured issues rather than throwing a parse error at
 * an agent, because "your document is wrong at this path" is repairable and
 * "SyntaxError: Unexpected token" is not.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  ScenarioTemplateV2Schema,
  serializeTemplate,
  toScenarioIssues,
  type ScenarioTemplateV2,
} from '@uniscenarios/scenario-model';
import {
  decodeTraceGz,
  encodeTraceGz,
  parseSimScenarioInput,
  safeParseSimScenarioInput,
  type SimScenarioInput,
  type SimTrace,
} from '@uniscenarios/sim-engine';

import { CliError, EXIT } from './errors.js';
export interface CatalogArtifactProvenance {
  readonly identity: string;
  readonly seed: string;
  readonly attemptSeed: string;
  readonly designDigest: string;
  readonly mapId: string;
  readonly incidentId: string;
  readonly selectedLocationId: string;
  readonly selectedMatcherSiteId: string;
  readonly variant: {
    readonly id: string;
    readonly title: string;
    readonly weather: string;
    readonly timeOfDay: string;
    readonly traffic: string;
    readonly visibility: string;
  };
  readonly provenance: {
    readonly namespace: string;
    readonly generatorVersion: string;
    readonly mapCatalogRevision: string;
    readonly matcherIndexDigest: string;
    readonly engineGraphDigest: string;
    readonly locationCatalogDigest: string;
    readonly taxonomyDigest: string;
    readonly templateDigest: string;
  };
  readonly templateId: string;
}
import type { InstanceManifest } from './materialize.js';

export interface InstanceFile {
  readonly kind: 'scenario-instance';
  readonly version: 1;
  readonly catalogSlot?: CatalogArtifactProvenance;
  readonly manifest: InstanceManifest;
  readonly input: SimScenarioInput;
}

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new CliError('file_not_found', `cannot read ${file}`, { path: file });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError('invalid_json', error instanceof Error ? error.message : String(error), {
      path: file,
    });
  }
}

/** Parse a v2 template, reporting schema failures as structured issues. */
export async function readTemplate(file: string): Promise<ScenarioTemplateV2> {
  const json = await readJson(file);
  const parsed = ScenarioTemplateV2Schema.safeParse(json);
  if (!parsed.success) {
    throw new CliError('template_invalid', 'the document is not a valid v2 scenario template', {
      path: file,
      detail: { issues: toScenarioIssues(parsed.error.issues) },
      exitCode: EXIT.validationFindings,
    });
  }
  return parsed.data;
}

/** Read either an instance file or a bare `SimScenarioInput`. */
export async function readInstance(file: string): Promise<InstanceFile> {
  const json = (await readJson(file)) as Record<string, unknown>;
  if (json && json['kind'] === 'scenario-instance') {
    const parsed = safeParseSimScenarioInput(json['input']);
    if (!parsed.ok) {
      throw new CliError('instance_invalid', 'the instance does not satisfy the engine contract', {
        path: file,
        detail: { issues: parsed.issues },
        exitCode: EXIT.validationFindings,
      });
    }
    return {
      kind: 'scenario-instance',
      version: 1,
      ...(json['catalogSlot'] === undefined ? {} : { catalogSlot: json['catalogSlot'] as CatalogArtifactProvenance }),
      manifest: json['manifest'] as InstanceManifest,
      input: parsed.value,
    };
  }
  const parsed = safeParseSimScenarioInput(json);
  if (!parsed.ok) {
    throw new CliError('instance_invalid', 'the document is neither an instance nor a SimScenarioInput', {
      path: file,
      detail: { issues: parsed.issues },
      exitCode: EXIT.validationFindings,
    });
  }
  return {
    kind: 'scenario-instance',
    version: 1,
    manifest: undefined as unknown as InstanceManifest,
    input: parsed.value,
  };
}

/** Detect whether a file is a template or an instance without parsing twice. */
export async function detectKind(file: string): Promise<'template' | 'instance'> {
  const json = (await readJson(file)) as Record<string, unknown>;
  if (json && json['scenarioVersion'] === 2) return 'template';
  return 'instance';
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function writeTemplateFile(file: string, template: ScenarioTemplateV2): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, serializeTemplate(template), 'utf8');
}

export async function writeTraceFile(file: string, trace: SimTrace): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, Buffer.from(await encodeTraceGz(trace)));
}

export async function readTraceFile(file: string): Promise<SimTrace> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch {
    throw new CliError('file_not_found', `cannot read ${file}`, { path: file });
  }
  try {
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) return await decodeTraceGz(new Uint8Array(bytes));
    return JSON.parse(bytes.toString('utf8')) as SimTrace;
  } catch (error) {
    throw new CliError('invalid_trace', error instanceof Error ? error.message : String(error), {
      path: file,
    });
  }
}

export { parseSimScenarioInput };
