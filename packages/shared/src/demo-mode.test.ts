import { describe, expect, it } from 'vitest';
import {
  DEMO_ERROR_CODES,
  DEMO_RATE_KINDS,
  REQUESTER_KINDS,
  DemoMeSchema,
  DemoPresetSchema,
  DemoRateKindSchema,
  RequesterKindSchema,
} from './index.js';

describe('RequesterKindSchema', () => {
  it('accepts the three principal kinds', () => {
    for (const kind of REQUESTER_KINDS) {
      expect(RequesterKindSchema.safeParse(kind).success).toBe(true);
    }
  });

  it('rejects an unknown requester kind', () => {
    expect(RequesterKindSchema.safeParse('admin').success).toBe(false);
  });
});

describe('DemoRateKindSchema', () => {
  it('accepts session and analyze buckets only', () => {
    expect(DEMO_RATE_KINDS).toEqual(['session', 'analyze']);
    expect(DemoRateKindSchema.safeParse('session').success).toBe(true);
    expect(DemoRateKindSchema.safeParse('analyze').success).toBe(true);
    expect(DemoRateKindSchema.safeParse('match').success).toBe(false);
  });
});

describe('DemoMeSchema', () => {
  it('accepts the anonymous minimal shape', () => {
    const result = DemoMeSchema.safeParse({ kind: 'anonymous' });
    expect(result.success).toBe(true);
  });

  it('accepts the full demo shape with quota fields', () => {
    const result = DemoMeSchema.safeParse({
      kind: 'demo',
      sessionId: 'demo-abc',
      expiresAt: '2026-09-22T00:00:00.000Z',
      analyzeQuota: 3,
      analyzeUsed: 1,
      analyzeRemaining: 2,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing kind', () => {
    expect(DemoMeSchema.safeParse({ analyzeQuota: 3 }).success).toBe(false);
  });

  it('rejects a negative remaining quota', () => {
    expect(
      DemoMeSchema.safeParse({ kind: 'demo', analyzeRemaining: -1 }).success,
    ).toBe(false);
  });
});

describe('DemoPresetSchema', () => {
  it('accepts a ready preset with a profile id', () => {
    const result = DemoPresetSchema.safeParse({
      platform: 'github',
      login: 'torvalds',
      authenticity: 'likely_authentic',
      profileId: 'prof_1',
      ready: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a not-ready preset with null profile id and unknown authenticity', () => {
    const result = DemoPresetSchema.safeParse({
      platform: 'gitee',
      login: 'someone',
      authenticity: 'unknown',
      profileId: null,
      ready: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unsupported platform', () => {
    expect(
      DemoPresetSchema.safeParse({
        platform: 'gitlab',
        login: 'x',
        authenticity: 'unknown',
        profileId: null,
        ready: false,
      }).success,
    ).toBe(false);
  });
});

describe('DEMO_ERROR_CODES', () => {
  it('keeps stable wire error codes shared with the frontend', () => {
    expect(DEMO_ERROR_CODES).toEqual({
      demoRequired: 'DEMO_REQUIRED',
      quotaExceeded: 'DEMO_QUOTA_EXCEEDED',
      rateLimited: 'DEMO_RATE_LIMITED',
    });
  });
});
