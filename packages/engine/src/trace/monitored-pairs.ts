/** Versioned selection boundary for expensive episode metrics. Collision detection remains global. */
export const MONITORED_PAIR_POLICY_VERSION = 'episode-metric-pairs.v1';

/**
 * Generated background road users are excluded from episode criticality pairs.
 *
 * WHY THIS IS NOT A LOOSENING. Ambient traffic exists to make the road look and
 * behave like a road; it is never the lesson a scenario teaches. Every episode
 * criticality metric (`minTTC`, `minPathTTC`, `minPET`, `minDistance`, and the
 * `criticalitySamples` those are read from) answers the question "how close did
 * the *authored* conflict come". An ambient car that happens to pass nearer to
 * the metric subject than the authored challenger would silently take that
 * pair over, and every downstream number — band, verdict, the corpus gate's
 * closest-approach pair — would then describe the wrong two bodies.
 *
 * What is deliberately NOT excluded:
 *   - collision detection, which stays global, so an ambient body the ego
 *     actually hits still fails the clip rather than disappearing from it;
 *   - physics and control, so the ego really does follow, yield to and queue
 *     behind ambient traffic;
 *   - an explicitly declared occlusion/monitor pair, which is authored intent.
 *
 * EQUIVALENCE. With an empty `ambientActorIds` set this file is byte-for-byte
 * the v1 policy: the only new branch is guarded by `isAmbient(...)`, which is
 * unreachable when the set is empty. Authored-only scenarios therefore keep
 * identical metrics and identical trace digests.
 */
export const AMBIENT_METRIC_EXCLUSION_VERSION = 'ambient-metric-exclusion.v1';

export interface MonitoredPairPolicy {
  version: typeof MONITORED_PAIR_POLICY_VERSION;
  metricSubject: string | null;
  explicitPairs: ReadonlySet<string>;
  /**
   * Ids of generated background road users. Optional so every existing caller
   * keeps exactly the v1 behaviour without being rewritten.
   */
  ambientActorIds?: ReadonlySet<string> | undefined;
}

export interface MetricPairSelection {
  monitored: boolean;
  scored: boolean;
  reason:
    | 'metric-subject'
    | 'all-pairs'
    | 'explicit-monitor'
    | 'articulated-static'
    | 'ambient-excluded'
    | 'not-selected';
}

/** Exactly preserves v1 metrics semantics; ambient pruning proves its equivalence above. */
export function selectMetricPair(policy: MonitoredPairPolicy, a: string, b: string, hasArticulatedStaticShape = false): MetricPairSelection {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const monitored = policy.explicitPairs.has(key);
  const subjectScored = policy.metricSubject === null || a === policy.metricSubject || b === policy.metricSubject;
  if (monitored) return { monitored: true, scored: subjectScored, reason: 'explicit-monitor' };
  // Ambient exclusion sits *below* an explicit monitor (authored intent wins)
  // and *above* every other rule, including the articulated-static escape
  // hatch: a generated actor is never the subject of a criticality metric.
  const ambient = policy.ambientActorIds;
  if (ambient !== undefined && ambient.size > 0 && (ambient.has(a) || ambient.has(b))) {
    return { monitored: false, scored: false, reason: 'ambient-excluded' };
  }
  if (hasArticulatedStaticShape) return { monitored: false, scored: true, reason: 'articulated-static' };
  if (policy.metricSubject === null) return { monitored: false, scored: true, reason: 'all-pairs' };
  if (subjectScored) return { monitored: false, scored: true, reason: 'metric-subject' };
  return { monitored: false, scored: false, reason: 'not-selected' };
}
