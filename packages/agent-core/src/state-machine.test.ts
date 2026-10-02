import { describe, expect, it } from 'vitest';
import { JOB_RUN_EVENTS, JOB_RUN_STATUSES, type JobRunEventKind } from '@jobagent/shared';
import {
  JOB_RUN_TRANSITIONS,
  canCancel,
  isScannableStatus,
  isTerminalStatus,
  planTransition,
} from './state-machine.js';

describe('planTransition', () => {
  it('drives the stage-1 happy path: created → configured → watching → recommending → awaiting_approval → tracking', () => {
    expect(planTransition('created', 'validate')).toEqual({
      ok: true,
      event: 'validate',
      from: 'created',
      to: 'configured',
    });
    expect(planTransition('configured', 'start')).toMatchObject({ ok: true, to: 'watching' });
    expect(planTransition('watching', 'candidates_ready')).toMatchObject({ ok: true, to: 'recommending' });
    expect(planTransition('recommending', 'generated')).toMatchObject({ ok: true, to: 'awaiting_approval' });
    // 阶段 1 的「已投」由用户在待投清单上回填：awaiting_approval --submitted--> tracking
    expect(planTransition('awaiting_approval', 'submitted')).toMatchObject({ ok: true, to: 'tracking' });
  });

  it('keeps the run on the human gate when an item is approved, and returns to watching when rejected', () => {
    expect(planTransition('awaiting_approval', 'approve')).toMatchObject({ ok: true, to: 'awaiting_approval' });
    expect(planTransition('awaiting_approval', 'reject')).toMatchObject({ ok: true, to: 'watching' });
  });

  it('reserves submitting/submitted for stage 2 without changing their shape', () => {
    expect(planTransition('submitting', 'submitted')).toMatchObject({ ok: true, to: 'submitted' });
    expect(planTransition('submitted', 'track')).toMatchObject({ ok: true, to: 'tracking' });
    expect(planTransition('tracking', 'archive')).toMatchObject({ ok: true, to: 'archived' });
  });

  it('rejects events that the current status does not accept', () => {
    expect(planTransition('created', 'start')).toEqual({
      ok: false,
      event: 'start',
      from: 'created',
      reason: 'not_allowed',
    });
    expect(planTransition('watching', 'generated')).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(planTransition('tracking', 'validate')).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('refuses unknown status/event strings that came from the database', () => {
    expect(planTransition('bogus' as never, 'start')).toMatchObject({ ok: false, reason: 'unknown_status' });
    expect(planTransition('created', 'bogus' as never)).toMatchObject({ ok: false, reason: 'unknown_status' });
  });

  it('treats archived/cancelled/failed as terminal (no out-edges, not cancellable)', () => {
    for (const status of ['archived', 'cancelled', 'failed'] as const) {
      expect(Object.keys(JOB_RUN_TRANSITIONS[status])).toHaveLength(0);
      expect(isTerminalStatus(status)).toBe(true);
      expect(canCancel(status)).toBe(false);
      for (const event of JOB_RUN_EVENTS) {
        expect(planTransition(status, event)).toMatchObject({ ok: false, reason: 'not_allowed' });
      }
    }
  });

  it('lets a user cancel any non-terminal status, and only tick the scannable ones', () => {
    for (const status of JOB_RUN_STATUSES) {
      const terminal = status === 'archived' || status === 'cancelled' || status === 'failed';
      expect(canCancel(status)).toBe(!terminal);
      expect(isScannableStatus(status)).toBe(
        status === 'configured' || status === 'watching' || status === 'recommending',
      );
    }
  });

  it('keeps the table honest: every target is a real status and every key is a real event', () => {
    const statuses = new Set<string>(JOB_RUN_STATUSES);
    const events = new Set<string>(JOB_RUN_EVENTS);
    for (const [from, edges] of Object.entries(JOB_RUN_TRANSITIONS)) {
      expect(statuses.has(from)).toBe(true);
      for (const [event, to] of Object.entries(edges)) {
        expect(events.has(event), `${from} -> ${event} is not a known event`).toBe(true);
        expect(statuses.has(to as string), `${from} -> ${event} targets unknown ${to}`).toBe(true);
      }
    }
  });

  it('exposes cancel as a real transition for a non-terminal status', () => {
    expect(planTransition('watching', 'cancel' as JobRunEventKind)).toMatchObject({ ok: true, to: 'cancelled' });
  });
});
