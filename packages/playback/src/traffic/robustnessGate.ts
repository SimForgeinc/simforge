export interface IntentVerdicts {
  readonly baseline: 'accept' | 'reject';
  readonly cases: Readonly<Record<string, 'accept' | 'reject'>>;
}

export function ambientRobustnessGate(
  robustnessAccepted: boolean,
  intent: IntentVerdicts | null,
): { accepted: boolean; overall: 'accepted' | 'rejected' | 'incomplete' } {
  if (!intent) return { accepted: false, overall: 'incomplete' };
  const accepted = robustnessAccepted
    && intent.baseline === 'accept'
    && Object.values(intent.cases).every((verdict) => verdict === 'accept');
  return { accepted, overall: accepted ? 'accepted' : 'rejected' };
}

