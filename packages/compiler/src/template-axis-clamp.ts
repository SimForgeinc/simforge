import { validateTemplate, type ScenarioTemplateV2, type ValidationReport } from '@simforge-oss/scenario';

/** One mechanical `until` truncation, recorded into compiler provenance. */
export type AxisUntilClamp = {
  path: string;
  interactionId: string;
  fromT: number;
  toT: number;
};

const UNTIL_PATH = /^choreography\.interactions\.(\d+)\.until$/;
const REQUIRED_UNTIL = /^until <= (-?\d+(?:\.\d+)?)$/;
const MAX_ROUNDS = 8;

/**
 * Mechanically truncate declared axis holds that a later exact start preempts.
 *
 * The validator reports an axis conflict when an explicit `until` outlives a
 * later exact takeover of the same axis. Runtime takeover already wins, so the
 * clamp preserves execution semantics while making the schedule honest. Equal
 * starts, windowed overlaps, and expression-valued holds remain validation
 * errors because they have no mechanically knowable winner.
 *
 * The input is never mutated. Applied clamps are returned for provenance.
 */
export function clampDeclaredAxisHolds(template: ScenarioTemplateV2): {
  template: ScenarioTemplateV2;
  clamps: AxisUntilClamp[];
  report: ValidationReport;
} {
  let current = template;
  const clamps: AxisUntilClamp[] = [];
  let report = validateTemplate(current);
  for (let round = 0; round < MAX_ROUNDS && !report.ok; round += 1) {
    const clampToByIndex = new Map<number, number>();
    for (const issue of report.issues) {
      if (issue.severity !== 'error' || issue.code !== 'axis_conflict') continue;
      const pathMatch = UNTIL_PATH.exec(issue.path);
      const requiredMatch = typeof issue.required === 'string' ? REQUIRED_UNTIL.exec(issue.required) : null;
      if (!pathMatch || !requiredMatch) continue;
      const index = Number(pathMatch[1]);
      const takeoverT = Number(requiredMatch[1]);
      const interaction = current.choreography.interactions[index];
      if (!interaction || interaction.until?.kind !== 'at' || typeof interaction.until.t !== 'number') continue;
      if (!(Number.isFinite(takeoverT) && takeoverT < interaction.until.t)) continue;
      const existing = clampToByIndex.get(index);
      if (existing === undefined || takeoverT < existing) clampToByIndex.set(index, takeoverT);
    }
    if (clampToByIndex.size === 0) break;
    const interactions = current.choreography.interactions.map((interaction, index) => {
      const toT = clampToByIndex.get(index);
      if (toT === undefined || interaction.until?.kind !== 'at' || typeof interaction.until.t !== 'number') return interaction;
      clamps.push({
        path: `choreography.interactions.${index}.until`,
        interactionId: interaction.id,
        fromT: interaction.until.t,
        toT,
      });
      return { ...interaction, until: { ...interaction.until, t: toT } };
    });
    current = { ...current, choreography: { ...current.choreography, interactions } };
    report = validateTemplate(current);
  }
  return { template: current, clamps, report };
}
