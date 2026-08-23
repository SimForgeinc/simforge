import { describe, expect, it } from 'vitest';
import { MONITORED_PAIR_POLICY_VERSION, selectMetricPair, type MonitoredPairPolicy } from '../trace/monitored-pairs.js';

describe('episode metric monitored-pair boundary', () => {
  const policy = (metricSubject: string | null, pairs: string[] = []): MonitoredPairPolicy => ({ version: MONITORED_PAIR_POLICY_VERSION, metricSubject, explicitPairs: new Set(pairs) });
  it('preserves all-pairs behavior when no metric subject is declared', () => expect(selectMetricPair(policy(null), 'a', 'b').scored).toBe(true));
  it('scores only pairs containing the metric subject', () => {
    expect(selectMetricPair(policy('ego'), 'ego', 'car').reason).toBe('metric-subject');
    expect(selectMetricPair(policy('ego'), 'car', 'truck').scored).toBe(false);
  });
  it('retains explicit monitors and articulated static hazards', () => {
    expect(selectMetricPair(policy('ego', ['car|truck']), 'truck', 'car').monitored).toBe(true);
    expect(selectMetricPair(policy('ego'), 'parked', 'door-user', true).reason).toBe('articulated-static');
  });
});
