import { describe, expect, it } from 'vitest';
import { ESMINI_OBSERVABLE_EVENT_KINDS, EsminiCsvParseError, parseEsminiCsv } from '../esmini-csv.js';

const FIELDS = [
  'Entity_Name [-]', 'Entity_ID [-]', 'Current_Speed [m/s]', 'Wheel_Angle [deg]', 'Wheel_Rotation [-]',
  'bb_x [m]', 'bb_y [m]', 'bb_z [m]', 'bb_length [m]', 'bb_width [m]', 'bb_height [m]',
  'World_Position_X [m]', 'World_Position_Y [m]', 'World_Position_Z [m]',
  'Vel_X [m/s]', 'Vel_Y [m/s]', 'Vel_Z [m/s]', 'Acc_X [m/s2]', 'Acc_Y [m/s2]', 'Acc_Z [m/s2]',
  'Distance_Travelled_Along_Road_Segment [m]', 'Lateral_Distance_Lanem [m]', 'lane_id', 'lane_offset[m]',
  'World_Heading_Angle [rad]', 'Heading_Angle_Rate [rad/s]', 'Relative_Heading_Angle [rad]',
  'Relative_Heading_Angle_Drive_Direction [rad]', 'World_Pitch_Angle [rad]', 'Road_Curvature [1/m]', 'collision_ids',
] as const;

function actor(name: string, id: number, x: number, options: { collisions?: string; ax?: number; heading?: number } = {}): string {
  return [
    name, id, 5, 0, 0, 0, 0, 0, 4, 2, 1.5, x, 2, 0, 5, 0, 0,
    options.ax ?? 1, 0, 0, x, 0, -1, 0.2, options.heading ?? 0, 0, 0, 0, 0, 0, options.collisions ?? '',
  ].join(', ');
}

function fixture(options: {
  times?: readonly number[];
  secondRowName?: string;
  malformedLastRow?: boolean;
  headerMutator?: (header: string) => string;
  ax?: number;
  firstCollision?: string;
  secondCollision?: string;
} = {}): string {
  const groups = [1, 2].flatMap((ordinal) => FIELDS.map((field) => `#${ordinal} ${field}`));
  const header = options.headerMutator?.(`Index [-], TimeStamp [s], ${groups.join(', ')},`) ?? `Index [-], TimeStamp [s], ${groups.join(', ')},`;
  const times = options.times ?? [0, 20];
  const data = times.map((t, index) => {
    const row = `${index}, ${t.toFixed(6)}, ${actor('actor_test_car', 0, t * 5, { collisions: index === times.length - 1 ? (options.firstCollision ?? '1') : '', ax: options.ax })}, ${actor(index === 1 && options.secondRowName ? options.secondRowName : 'other_car', 1, 10 + t * 5, { collisions: index === times.length - 1 ? (options.secondCollision ?? '0') : '' })},`;
    return options.malformedLastRow && index === times.length - 1 ? row.split(',').slice(0, -5).join(',') : row;
  });
  return [
    'esmini GIT REV: abcdef', 'esmini GIT TAG: v3.6.0', 'esmini GIT BRANCH: release',
    'esmini BUILD VERSION: 3.6.0', 'Scenario File Name: scenario.xosc', 'Number of Vehicles: 2',
    header, ...data,
  ].join('\n');
}

function issueCodes(action: () => unknown): string[] {
  try { action(); return []; }
  catch (error) {
    expect(error).toBeInstanceOf(EsminiCsvParseError);
    return (error as EsminiCsvParseError).issues.map((issue) => issue.code);
  }
}

describe('parseEsminiCsv', () => {
  it('parses the pinned wide logger, maps true actor ids, and deduplicates collision pairs', () => {
    const trace = parseEsminiCsv(fixture(), {
      durationS: 20,
      entityIdMap: { actor_test_car: 'ego', 'id:1': 'npc' },
    });
    expect(trace.completed).toBe(true);
    expect(trace.entities.map((entity) => [entity.id, entity.name])).toEqual([['ego', 'actor_test_car'], ['npc', 'other_car']]);
    expect(trace.entities[0]?.samples).toHaveLength(2);
    expect(trace.collisions).toEqual([{ t: 20, actorIds: ['ego', 'npc'] }]);
    expect(ESMINI_OBSERVABLE_EVENT_KINDS).toEqual([]);
  });

  it('preserves signed longitudinal braking acceleration', () => {
    const trace = parseEsminiCsv(fixture({ ax: -4 }), { durationS: 20 });
    expect(trace.entities.find((entity) => entity.id === 'actor_test_car')!.samples[0]!.accelerationMps2).toBe(-4);
  });

  it('rejects missing required columns and malformed/truncated entity groups', () => {
    expect(issueCodes(() => parseEsminiCsv(fixture({
      headerMutator: (header) => header.replace('#1 World_Position_X [m]', '#1 Unknown_X [m]'),
    }), { durationS: 20 }))).toContain('missing-column');
    expect(issueCodes(() => parseEsminiCsv(fixture({ malformedLastRow: true }), { durationS: 20 }))).toContain('row-width');
  });

  it('rejects duplicate and nonmonotonic samples', () => {
    expect(issueCodes(() => parseEsminiCsv(fixture({ times: [0, 0, 20] }), { durationS: 20 }))).toContain('duplicate-sample');
    expect(issueCodes(() => parseEsminiCsv(fixture({ times: [0, 5, 4, 20] }), { durationS: 20 }))).toContain('nonmonotonic-sample');
  });

  it('rejects incomplete 20-second coverage by default and can expose it as incomplete when requested', () => {
    expect(issueCodes(() => parseEsminiCsv(fixture({ times: [0, 19.9] }), { durationS: 20 }))).toContain('truncated-clip');
    const trace = parseEsminiCsv(fixture({ times: [0, 19.9] }), { durationS: 20, requireCompleteClip: false });
    expect(trace.completed).toBe(false);
  });

  it('rejects entity identity changes and alias collisions', () => {
    expect(issueCodes(() => parseEsminiCsv(fixture({ secondRowName: 'replacement_car' }), { durationS: 20 }))).toContain('entity-identity-changed');
    expect(issueCodes(() => parseEsminiCsv(fixture(), {
      durationS: 20, entityIdMap: { actor_test_car: 'same', other_car: 'same' },
    }))).toContain('duplicate-entity');
  });

  it('rejects malformed quoted CSV and wrong pinned versions', () => {
    expect(issueCodes(() => parseEsminiCsv(`${fixture()}\n"unfinished`, { durationS: 20 }))).toContain('malformed-csv');
    expect(issueCodes(() => parseEsminiCsv(fixture().replaceAll('3.6.0', '3.7.0'), { durationS: 20 }))).toContain('version-mismatch');
  });

  it('fails closed on malformed collision fields instead of extracting incidental digits', () => {
    expect(issueCodes(() => parseEsminiCsv(fixture({ firstCollision: 'actor=1?' }), { durationS: 20 })))
      .toContain('malformed-collision-ids');
  });

  it('fails closed when collision evidence references an unknown external entity', () => {
    expect(issueCodes(() => parseEsminiCsv(fixture({ firstCollision: '7' }), { durationS: 20 })))
      .toContain('unknown-collision-target');
  });
});
