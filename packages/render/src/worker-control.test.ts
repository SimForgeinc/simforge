import { describe, expect, it } from 'vitest';

import { JobLeasedResponseSchema } from './worker-control.js';

describe('leased job control digest', () => {
  it('requires a lowercase SHA-256 execution package control digest', () => {
    const digestSchema = JobLeasedResponseSchema.shape.executionPackageControlSha256;

    expect(digestSchema.safeParse('a'.repeat(64)).success).toBe(true);
    expect(digestSchema.safeParse('A'.repeat(64)).success).toBe(false);
    expect(digestSchema.safeParse(undefined).success).toBe(false);
  });
});
