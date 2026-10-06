import { describe, expect, it } from 'vitest';
import { hasUnseenApprovals } from './unseen.js';

const awaiting = {
  status: 'awaiting_approval',
  lastViewedAt: null,
  updatedAt: '2026-10-06T04:00:00.000Z',
} as const;

describe('hasUnseenApprovals', () => {
  it('flags an awaiting_approval run that was never viewed', () => {
    expect(hasUnseenApprovals(awaiting)).toBe(true);
  });

  it('flags when the last view predates the current batch landing', () => {
    expect(
      hasUnseenApprovals({ ...awaiting, lastViewedAt: '2026-10-06T03:00:00.000Z' }),
    ).toBe(true);
  });

  it('does not flag after the owner viewed the current batch', () => {
    expect(
      hasUnseenApprovals({ ...awaiting, lastViewedAt: '2026-10-06T05:00:00.000Z' }),
    ).toBe(false);
    // 同刻也算已读（只在严格更早时未读）
    expect(
      hasUnseenApprovals({ ...awaiting, lastViewedAt: '2026-10-06T04:00:00.000Z' }),
    ).toBe(false);
  });

  it('never flags outside the human gate', () => {
    for (const status of ['watching', 'submitting', 'submitted', 'tracking', 'failed', 'cancelled']) {
      expect(hasUnseenApprovals({ ...awaiting, status, lastViewedAt: null })).toBe(false);
    }
  });
});
