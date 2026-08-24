/**
 * `evaluateTrace` — the reject filters that do the quality control an LLM
 * cannot. Each filter is exercised both on a synthetic metrics block (so the
 * boundary is exact) and, where practical, on a real run.
 */

import { describe, expect, it } from 'vitest';
import { evaluateMetrics, evaluateTrace } from '../trace/evaluate.js';
import { criticalityWindow } from '../trace/metrics.js';
import { runSimulation } from '../sim/engine.js';
import type { EpisodeMetrics } from '../trace/trace.js';
import { LANE_LEFT, scenario, syntheticGraph, vehicle } from './fixtures/scenarios.js';

const graph = syntheticGraph();

function metrics(over: Partial<EpisodeMetrics> = {}): EpisodeMetrics {
  return {
    minTTC: { value: 1.4, t: 9, pair: ['challenger', 'ego'] },
    minDistance: [{ pair: ['challenger', 'ego'], minDistanceM: 2.1, t: 9.4 }],
    requiredDecelMax: { challenger: 2.0, ego: 4.1 },
    collisions: [],
    triggerNeverFired: [],
    clippedCriticality: false,
    ticksSimulated: 1001,
    ...over,
  };
}

describe('reject filters', () => {
  it('accepts a well-formed critical episode', () => {
    const r = evaluateMetrics(metrics(), 20);
    expect(r.verdict).toBe('accept');
    expect(r.findings).toEqual([]);
    expect(r.summary.minTTC).toBe(1.4);
  });

  it('rejects trivially safe episodes and tags them negative-control', () => {
    const r = evaluateMetrics(metrics({ minTTC: { value: 6.2, t: 9, pair: ['a', 'b'] } }), 20);
    expect(r.verdict).toBe('reject');
    expect(r.findings.map((f) => f.code)).toContain('trivially_safe');
    expect(r.tags).toContain('negative-control');
  });

  it('accepts a trivially safe episode declared as a negative control', () => {
    const r = evaluateMetrics(metrics({ minTTC: { value: 6.2, t: 9, pair: ['a', 'b'] } }), 20, {
      negativeControl: true,
    });
    expect(r.verdict).toBe('accept');
    expect(r.findings.map((f) => f.code)).toContain('trivially_safe');
  });

  it('rejects physically unavoidable episodes above the friction ceiling', () => {
    const r = evaluateMetrics(metrics({ requiredDecelMax: { ego: 9.6, challenger: 1 } }), 20);
    expect(r.verdict).toBe('reject');
    const found = r.findings.find((f) => f.code === 'physically_unavoidable');
    expect(found!.detail).toMatchObject({ actorId: 'ego' });
    // Right at the ceiling is still acceptable.
    expect(evaluateMetrics(metrics({ requiredDecelMax: { ego: 7.8 } }), 20).verdict).toBe('accept');
  });

  it('rejects never-fired triggers, and can scope the check', () => {
    const m = metrics({ triggerNeverFired: ['flavour-chip'] });
    expect(evaluateMetrics(m, 20).verdict).toBe('reject');
    expect(evaluateMetrics(m, 20, { requiredTriggers: ['cut-in'] }).verdict).toBe('accept');
    expect(evaluateMetrics(m, 20, { requiredTriggers: ['flavour-chip'] }).verdict).toBe('reject');
  });

  it('rejects criticality clipped to the ends of the clip', () => {
    for (const t of [2.5, 17.5]) {
      const r = evaluateMetrics(metrics({ minTTC: { value: 1.2, t, pair: ['a', 'b'] } }), 20);
      expect(r.findings.map((f) => f.code)).toContain('out_of_window');
    }
    for (const t of [4, 10, 16]) {
      const r = evaluateMetrics(metrics({ minTTC: { value: 1.2, t, pair: ['a', 'b'] } }), 20);
      expect(r.findings.map((f) => f.code)).not.toContain('out_of_window');
    }
  });

  it('keeps compact clips evidence-gated rather than imposing a long-clip floor', () => {
    expect(criticalityWindow(3)).toEqual([0.6000000000000001, 2.4]);
    for (const t of [0.4, 2.7]) {
      expect(evaluateMetrics(metrics({ minTTC: { value: 1.2, t, pair: ['a', 'b'] } }), 3).findings
        .map((f) => f.code)).toContain('out_of_window');
    }
    expect(evaluateMetrics(metrics({ minTTC: { value: 1.2, t: 1.5, pair: ['a', 'b'] } }), 3).findings
      .map((f) => f.code)).not.toContain('out_of_window');
  });

  it('flags an episode with no interaction at all', () => {
    const r = evaluateMetrics(metrics({ minTTC: null, minPathTTC: null }), 20);
    expect(r.findings.map((f) => f.code)).toContain('no_interaction');
  });

  it('uses finite crossing path-TTC as hard criticality when circle TTC is absent', () => {
    const r = evaluateMetrics(metrics({
      minTTC: null,
      minPathTTC: {
        value: 1.1,
        t: 8,
        pair: ['cyclist', 'ego'],
        conflictPoint: { x: 4, y: 7 },
      },
    }), 20);
    expect(r.verdict).toBe('accept');
    expect(r.findings).toEqual([]);
    expect(r.summary).toMatchObject({
      minTTC: null,
      criticalityKind: 'path-ttc',
      criticality: 1.1,
      criticalityT: 8,
    });
  });

  it('uses positive PET for a separated crossing instead of longitudinal TTC', () => {
    const r = evaluateMetrics(metrics({
      minTTC: { value: 4.1, t: 6, pair: ['ego', 'pedestrian'] },
      minPathTTC: null,
      minPET: {
        value: 0.87,
        t: 7,
        pair: ['ego', 'pedestrian'],
        conflictPoint: { x: 2, y: 3 },
        firstActor: 'pedestrian',
        secondActor: 'ego',
      },
    }), 20);
    expect(r.verdict).toBe('accept');
    expect(r.summary).toMatchObject({ criticalityKind: 'pet', criticality: 0.87, criticalityT: 7 });
    expect(r.findings.map((finding) => finding.code)).not.toContain('trivially_safe');
  });

  it('rejects a crossing whose positive PET is only a trivial separation', () => {
    const r = evaluateMetrics(metrics({
      minTTC: null,
      minPathTTC: null,
      minPET: {
        value: 2.5,
        t: 8,
        pair: ['bicycle', 'ego'],
        conflictPoint: { x: 1, y: 1 },
        firstActor: 'bicycle',
        secondActor: 'ego',
      },
    }), 20);
    expect(r.findings.map((finding) => finding.code)).toContain('trivially_safe');
  });

  it('applies the criticality window to the mechanism-aware winner', () => {
    const r = evaluateMetrics(metrics({
      minTTC: { value: 2, t: 9, pair: ['ego', 'lead'] },
      minPathTTC: {
        value: 0.8,
        t: 2,
        pair: ['cyclist', 'ego'],
        conflictPoint: { x: 4, y: 7 },
      },
    }), 20);
    expect(r.summary.criticalityKind).toBe('path-ttc');
    expect(r.findings.map((finding) => finding.code)).toContain('out_of_window');
  });

  it('selects the minimum inside the window while preserving the global minimum', () => {
    const global = { value: 0.4, t: 1, pair: ['crossing', 'ego'] as [string, string] };
    const r = evaluateMetrics(metrics({
      minTTC: global,
      criticalitySamples: {
        ttc: [{ pair: ['crossing', 'ego'], t: [1, 7], value: [0.4, 1.2] }],
        pathTTC: [],
        pet: [],
      },
    }), 20);
    expect(r.verdict).toBe('accept');
    expect(r.summary).toMatchObject({ criticalityKind: 'ttc', criticality: 1.2, criticalityT: 7 });
    expect(r.findings.map((finding) => finding.code)).not.toContain('out_of_window');
    expect(global).toEqual({ value: 0.4, t: 1, pair: ['crossing', 'ego'] });
  });

  it('ignores an overlap PET sentinel and selects the later positive PET in the window', () => {
    const r = evaluateMetrics(metrics({
      minTTC: { value: 4.1, t: 6, pair: ['bus', 'ego'] },
      minPathTTC: { value: 0.7, t: 5, pair: ['bus', 'ego'], conflictPoint: { x: 2, y: 3 } },
      minPET: { value: 0, t: 5, pair: ['bus', 'ego'], conflictPoint: { x: 2, y: 3 }, firstActor: 'bus', secondActor: 'ego' },
      criticalitySamples: {
        ttc: [{ pair: ['bus', 'ego'], t: [5, 7], value: [4.1, 4.1] }],
        pathTTC: [{ pair: ['bus', 'ego'], t: [5], value: [0.7], conflictX: [2], conflictY: [3] }],
        pet: [{
          pair: ['bus', 'ego'], t: [5, 7], value: [0, 0.8], conflictX: [2, 2], conflictY: [3, 3],
          firstActor: ['bus', 'bus'], secondActor: ['ego', 'ego'],
        }],
      },
    }), 20, { window: [6, 8] });

    expect(r.verdict).toBe('accept');
    expect(r.summary).toMatchObject({ criticalityKind: 'pet', criticality: 0.8, criticalityT: 7 });
  });

  it('rejects when retained evidence has no finite sample inside the window', () => {
    const global = { value: 0.4, t: 1, pair: ['crossing', 'ego'] as [string, string] };
    const r = evaluateMetrics(metrics({
      minTTC: global,
      criticalitySamples: { ttc: [{ pair: ['crossing', 'ego'], t: [1], value: [0.4] }], pathTTC: [], pet: [] },
    }), 20);
    expect(r.findings.map((finding) => finding.code)).toContain('out_of_window');
    expect(r.findings.map((finding) => finding.code)).not.toContain('no_interaction');
  });

  it('tags collisions, and only rejects them when asked', () => {
    const m = metrics({ collisions: [{ t: 11, a: 'challenger', b: 'ego' }] });
    expect(evaluateMetrics(m, 20).verdict).toBe('accept');
    expect(evaluateMetrics(m, 20).tags).toContain('collision');
    expect(evaluateMetrics(m, 20, { rejectCollisions: true }).verdict).toBe('reject');
  });

  it('runs end to end on a real trace', () => {
    const input = scenario(graph, {
      metricSubject: 'ego',
      actors: [
        vehicle(graph, { id: 'ego', rsl: LANE_LEFT, s: 300, speedMps: 12, cruiseSpeedMps: 12 }),
        vehicle(graph, { id: 'far', rsl: LANE_LEFT, s: 20, speedMps: 12, cruiseSpeedMps: 12 }),
      ],
    });
    const { trace } = runSimulation(input, { graph, guards: 'collect' });
    const r = evaluateTrace(trace);
    // Two cars cruising in convoy never close — trivially safe by construction.
    expect(r.verdict).toBe('reject');
    expect(r.findings.map((f) => f.code)).toEqual(
      expect.arrayContaining([expect.stringMatching(/trivially_safe|no_interaction/)]),
    );
  });
});
