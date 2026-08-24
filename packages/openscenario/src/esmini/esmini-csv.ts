import type { FrameTransform, ObservableCollision, RawExternalTrace, RawTraceEntity, RawTraceSample } from '../trace-diff/index.js';

/** esmini CSV exposes collisions, but not semantic action/trigger lifecycle. */
export const ESMINI_OBSERVABLE_EVENT_KINDS: readonly string[] = Object.freeze([]);

export interface ParseEsminiCsvOptions {
  readonly durationS: number;
  readonly frameTransform?: FrameTransform;
  readonly completionToleranceS?: number;
  readonly requireCompleteClip?: boolean;
  readonly timeOffsetS?: number;
  /** esmini Entity_Name or `id:<numeric Entity_ID>` -> canonical actor id. */
  readonly entityIdMap?: Readonly<Record<string, string>>;
  readonly expectedVersion?: string;
}

export type EsminiCsvIssueCode =
  | 'malformed-csv' | 'missing-metadata' | 'version-mismatch' | 'missing-header'
  | 'missing-column' | 'row-width' | 'invalid-number' | 'entity-identity-changed'
  | 'duplicate-entity' | 'duplicate-sample' | 'nonmonotonic-sample' | 'truncated-clip'
  | 'malformed-collision-ids' | 'unknown-collision-target';

export interface EsminiCsvIssue {
  readonly code: EsminiCsvIssueCode;
  readonly message: string;
  readonly row?: number;
  readonly column?: string;
}

export class EsminiCsvParseError extends Error {
  readonly issues: readonly EsminiCsvIssue[];
  constructor(issues: readonly EsminiCsvIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'EsminiCsvParseError';
    this.issues = issues;
  }
}

const REQUIRED_FIELDS = [
  'entity_name', 'entity_id', 'current_speed', 'world_position_x', 'world_position_y', 'world_position_z',
  'acc_x', 'acc_y', 'acc_z', 'distance_travelled_along_road_segment', 'lane_id', 'lane_offset',
  'world_heading_angle', 'collision_ids',
] as const;

interface EntityColumns { readonly ordinal: number; readonly fields: ReadonlyMap<string, number> }

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(value.trim()); value = ''; }
    else if (char === '\n') { row.push(value.trim()); rows.push(row); row = []; value = ''; }
    else if (char !== '\r') value += char;
  }
  if (quoted) throw new EsminiCsvParseError([{ code: 'malformed-csv', message: 'CSV ends inside a quoted field' }]);
  if (value.length > 0 || row.length > 0) { row.push(value.trim()); rows.push(row); }
  return rows.filter((candidate) => candidate.some((entry) => entry !== ''));
}

function withoutTrailingEmpty(row: readonly string[]): string[] {
  const result = [...row];
  // esmini emits one delimiter after the final field. Remove that structural
  // cell only; a preceding empty cell may be the meaningful collision_ids.
  if (result.at(-1) === '') result.pop();
  return result;
}

function normalizedField(value: string): string {
  return value.replace(/^#\d+\s+/, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim()
    .toLocaleLowerCase('en-US').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function parseMetadata(rows: readonly string[][]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    const joined = row.join(',');
    const split = joined.indexOf(':');
    if (split >= 0) result.set(joined.slice(0, split).trim(), joined.slice(split + 1).trim());
  }
  return result;
}

function parseHeader(header: readonly string[], issues: EsminiCsvIssue[]): { readonly time: number; readonly entities: EntityColumns[] } {
  const time = header.findIndex((cell) => normalizedField(cell) === 'timestamp');
  if (time < 0) issues.push({ code: 'missing-column', column: 'TimeStamp [s]', message: 'esmini CSV is missing TimeStamp [s]' });
  const grouped = new Map<number, Map<string, number>>();
  header.forEach((cell, index) => {
    const match = /^#(\d+)\s+/.exec(cell);
    if (!match) return;
    const ordinal = Number(match[1]);
    const fields = grouped.get(ordinal) ?? new Map<string, number>();
    fields.set(normalizedField(cell), index);
    grouped.set(ordinal, fields);
  });
  if (grouped.size === 0) issues.push({ code: 'missing-column', column: '#1 Entity_Name [-]', message: 'esmini CSV has no entity groups' });
  const entities = [...grouped.entries()].sort(([a], [b]) => a - b).map(([ordinal, fields]) => {
    for (const field of REQUIRED_FIELDS) if (!fields.has(field)) issues.push({
      code: 'missing-column', column: `#${ordinal} ${field}`,
      message: `esmini entity group #${ordinal} is missing ${field}`,
    });
    return { ordinal, fields };
  });
  return { time, entities };
}

function read(row: readonly string[], columns: EntityColumns, field: string): string | undefined {
  const index = columns.fields.get(field);
  return index === undefined ? undefined : row[index];
}

function finite(raw: string | undefined, row: number, column: string, issues: EsminiCsvIssue[]): number | null {
  const parsed = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(parsed)) {
    issues.push({ code: 'invalid-number', row, column, message: `Row ${row}: ${column} must be finite` });
    return null;
  }
  return parsed;
}

function collisionIds(raw: string | undefined, row: number, issues: EsminiCsvIssue[]): string[] {
  const value = raw?.trim() ?? '';
  if (value === '') return [];
  // esmini 3.6 emits a whitespace-delimited list of signed numeric entity IDs.
  // A permissive digit search would turn corrupt values such as `actor=7?`
  // into apparently authoritative contact evidence.
  if (!/^-?\d+(?:\s+-?\d+)*$/u.test(value)) {
    issues.push({
      code: 'malformed-collision-ids', row, column: 'collision_ids',
      message: `Row ${row}: collision_ids must be a whitespace-delimited list of numeric entity IDs`,
    });
    return [];
  }
  return value.split(/\s+/u);
}

/** Strict adapter for the horizontal entity-group format emitted by esmini 3.6.0 `--csv_logger`. */
export function parseEsminiCsv(csv: string, options: ParseEsminiCsvOptions): RawExternalTrace {
  const rows = parseCsvRows(csv);
  const headerIndex = rows.findIndex((row) => normalizedField(row[0] ?? '') === 'index' && row.some((cell) => normalizedField(cell) === 'timestamp'));
  if (headerIndex < 0) throw new EsminiCsvParseError([{ code: 'missing-header', message: 'esmini CSV Index/TimeStamp header was not found' }]);
  const issues: EsminiCsvIssue[] = [];
  const metadata = parseMetadata(rows.slice(0, headerIndex));
  // BUILD VERSION is a numeric build counter in official 3.6 binaries (for
  // example 6314), while GIT TAG carries the semantic release identity.
  const version = metadata.get('esmini GIT TAG') ?? metadata.get('esmini BUILD VERSION');
  if (!version) issues.push({ code: 'missing-metadata', message: 'esmini CSV has no build version or git tag metadata' });
  const expectedVersion = options.expectedVersion ?? '3.6.0';
  if (version && !version.includes(expectedVersion)) issues.push({
    code: 'version-mismatch', message: `Expected esmini ${expectedVersion}, received ${version}`,
  });
  const declaredCountText = metadata.get('Number of Vehicles');
  const declaredCount = Number(declaredCountText);
  if (declaredCountText === undefined || !Number.isInteger(declaredCount) || declaredCount < 1) issues.push({
    code: 'missing-metadata', message: 'esmini CSV has no valid Number of Vehicles metadata',
  });
  const header = withoutTrailingEmpty(rows[headerIndex]!);
  const columns = parseHeader(header, issues);
  if (Number.isInteger(declaredCount) && declaredCount >= 1 && declaredCount !== columns.entities.length) issues.push({
    code: 'missing-column', message: `Metadata declares ${declaredCount} entities but header contains ${columns.entities.length} groups`,
  });
  if (issues.length > 0) throw new EsminiCsvParseError(issues);

  const tracks = new Map<string, { sourceName: string; numericId: string; samples: RawTraceSample[] }>();
  const numericToActor = new Map<string, string>();
  const ordinalIdentity = new Map<number, string>();
  const collisionRows: { t: number; source: string; targetNumericId: string }[] = [];
  let previousRowT = -Infinity;
  for (let line = headerIndex + 1; line < rows.length; line++) {
    const rowNumber = line + 1;
    const row = withoutTrailingEmpty(rows[line]!);
    if (row.length !== header.length) {
      issues.push({ code: 'row-width', row: rowNumber, message: `Row ${rowNumber} has ${row.length} columns; expected ${header.length}` });
      continue;
    }
    const t = finite(row[columns.time], rowNumber, 'TimeStamp', issues);
    if (t === null) continue;
    if (t < previousRowT - 1e-9) issues.push({ code: 'nonmonotonic-sample', row: rowNumber, message: `Row ${rowNumber} time ${t} precedes ${previousRowT}` });
    else if (Math.abs(t - previousRowT) <= 1e-9) issues.push({ code: 'duplicate-sample', row: rowNumber, message: `Duplicate CSV frame at t=${t}` });
    previousRowT = t;
    for (const group of columns.entities) {
      const sourceName = read(row, group, 'entity_name')?.trim() ?? '';
      const numericId = read(row, group, 'entity_id')?.trim() ?? '';
      if (!sourceName && !numericId) continue;
      if (!sourceName || !numericId) {
        issues.push({ code: 'entity-identity-changed', row: rowNumber, message: `Entity group #${group.ordinal} has incomplete identity` });
        continue;
      }
      const actorId = options.entityIdMap?.[sourceName] ?? options.entityIdMap?.[`id:${numericId}`] ?? sourceName;
      const identity = `${sourceName}\0${numericId}\0${actorId}`;
      const priorIdentity = ordinalIdentity.get(group.ordinal);
      if (priorIdentity !== undefined && priorIdentity !== identity) issues.push({
        code: 'entity-identity-changed', row: rowNumber, message: `Entity group #${group.ordinal} changed identity`,
      });
      ordinalIdentity.set(group.ordinal, identity);
      const priorActor = numericToActor.get(numericId);
      if (priorActor !== undefined && priorActor !== actorId) issues.push({
        code: 'entity-identity-changed', row: rowNumber, message: `Numeric entity ${numericId} changed actor identity`,
      });
      const duplicate = tracks.get(actorId);
      if (duplicate && (duplicate.numericId !== numericId || duplicate.sourceName !== sourceName)) issues.push({
        code: 'duplicate-entity', row: rowNumber, message: `Multiple esmini entities map to actor ${actorId}`,
      });
      numericToActor.set(numericId, actorId);
      const x = finite(read(row, group, 'world_position_x'), rowNumber, 'World_Position_X', issues);
      const y = finite(read(row, group, 'world_position_y'), rowNumber, 'World_Position_Y', issues);
      const z = finite(read(row, group, 'world_position_z'), rowNumber, 'World_Position_Z', issues);
      const heading = finite(read(row, group, 'world_heading_angle'), rowNumber, 'World_Heading_Angle', issues);
      const speed = finite(read(row, group, 'current_speed'), rowNumber, 'Current_Speed', issues);
      const ax = finite(read(row, group, 'acc_x'), rowNumber, 'Acc_X', issues);
      const ay = finite(read(row, group, 'acc_y'), rowNumber, 'Acc_Y', issues);
      const az = finite(read(row, group, 'acc_z'), rowNumber, 'Acc_Z', issues);
      const s = finite(read(row, group, 'distance_travelled_along_road_segment'), rowNumber, 'Distance_Travelled', issues);
      const offsetM = finite(read(row, group, 'lane_offset'), rowNumber, 'lane_offset', issues);
      const laneId = read(row, group, 'lane_id')?.trim() ?? '';
      if (laneId === '' || !Number.isInteger(Number(laneId))) issues.push({
        code: 'invalid-number', row: rowNumber, column: 'lane_id', message: `Row ${rowNumber}: lane_id must be an integer`,
      });
      if ([x, y, z, heading, speed, ax, ay, az, s, offsetM].some((entry) => entry === null) || laneId === '' || !Number.isInteger(Number(laneId))) continue;
      const track = tracks.get(actorId) ?? { sourceName, numericId, samples: [] };
      if (track.samples.some((sample) => Math.abs(sample.t - t) <= 1e-9)) {
        issues.push({ code: 'duplicate-sample', row: rowNumber, message: `${actorId} has duplicate sample at t=${t}` });
        continue;
      }
      track.samples.push({
        t, x: x!, y: y!, z: z!, headingRad: heading!, speedMps: speed!,
        accelerationMps2: ax! * Math.cos(heading!) + ay! * Math.sin(heading!),
        laneId, s: s!, offsetM: offsetM!, present: true,
      });
      tracks.set(actorId, track);
      for (const targetNumericId of collisionIds(read(row, group, 'collision_ids'), rowNumber, issues)) {
        if (targetNumericId !== numericId) collisionRows.push({ t, source: actorId, targetNumericId });
      }
    }
  }
  if (tracks.size === 0) issues.push({ code: 'truncated-clip', message: 'esmini CSV contains no entity samples' });
  if (issues.length > 0) throw new EsminiCsvParseError(issues);
  const entities: RawTraceEntity[] = [...tracks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, track]) => ({
    id, name: track.sourceName, samples: track.samples,
  }));
  const offset = options.timeOffsetS ?? 0;
  const times = entities.flatMap((entity) => entity.samples.map((sample) => sample.t + offset));
  const firstT = Math.min(...times), lastT = Math.max(...times);
  const tolerance = options.completionToleranceS ?? 0.021;
  const complete = firstT <= tolerance && lastT >= options.durationS - tolerance;
  if ((options.requireCompleteClip ?? true) && !complete) throw new EsminiCsvParseError([{
    code: 'truncated-clip', message: `esmini CSV covers ${firstT.toFixed(3)}–${lastT.toFixed(3)}s; expected 0.000–${options.durationS.toFixed(3)}s`,
  }]);
  const collisions: ObservableCollision[] = [];
  const seenPairs = new Set<string>();
  for (const collision of collisionRows.sort((a, b) => a.t - b.t)) {
    const target = numericToActor.get(collision.targetNumericId);
    if (!target) {
      issues.push({
        code: 'unknown-collision-target', column: 'collision_ids',
        message: `Collision from ${collision.source} references unknown numeric entity ${collision.targetNumericId} at t=${collision.t}`,
      });
      continue;
    }
    if (target === collision.source) continue;
    const actorIds = [collision.source, target].sort() as [string, string];
    const key = actorIds.join('\0');
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    collisions.push({ t: collision.t, actorIds });
  }
  if (issues.length > 0) throw new EsminiCsvParseError(issues);
  return {
    format: 'esmini-csv-3.6.0', simulator: { name: 'esmini', version: version! },
    frameTransform: options.frameTransform ?? { translationM: [0, 0, 0], rotationRad: 0 },
    ...(options.timeOffsetS === undefined ? {} : { timeOffsetS: options.timeOffsetS }),
    durationS: Math.max(0, lastT - firstT), completed: complete, entities, collisions,
  };
}
