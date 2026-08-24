import { describe, expect, it } from 'vitest';
import { buildDockerInvocation } from '../docker.js';
import { DEFAULT_LIMITS } from '../runner.js';

describe('production container profile', () => {
  it('disables network and privilege while mounting input read-only', () => {
    const args = buildDockerInvocation({ inputDir: '/safe/in', outputDir: '/safe/out' }, DEFAULT_LIMITS, 'scenario.xosc', `registry.test/esmini@sha256:${'a'.repeat(64)}`);
    expect(args).toContain('--network=none'); expect(args).toContain('--read-only'); expect(args).toContain('--cap-drop=ALL');
    expect(args).toContain('type=bind,src=/safe/in,dst=/input,readonly'); expect(args).toContain('--fixed_timestep'); expect(args).toContain('0.02');
    expect(args.slice(args.indexOf('--traj_filter'), args.indexOf('--traj_filter') + 2)).toEqual(['--traj_filter', '0']);
  });

  it('rejects mutable container tags', () => {
    expect(() => buildDockerInvocation({ inputDir: '/safe/in', outputDir: '/safe/out' }, DEFAULT_LIMITS, 'scenario.xosc', 'registry.test/esmini:3.6.0')).toThrow(/immutable sha256/);
  });
});
