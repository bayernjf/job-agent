import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './sqlite/migrator.js';
import { openSqlite } from './sqlite/connection.js';
import { SqliteInterviewsRepository } from './sqlite/interviews-repo.js';
import {
  INTERVIEW_FORMATS,
  INTERVIEW_OUTCOMES,
  INTERVIEW_STATUSES,
  toStoredInterview,
  type NewInterview,
  type RawInterviewRow,
} from './entities/index.js';

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/sqlite',
);

function freshRepo(): { repo: SqliteInterviewsRepository; close: () => void } {
  const { client, db } = openSqlite(':memory:');
  runMigrations(client, MIGRATIONS_DIR);
  return { repo: new SqliteInterviewsRepository(db), close: () => client.close() };
}

function iv(
  overrides: Partial<NewInterview> &
    Pick<NewInterview, 'id' | 'profileId' | 'createdByAccountId'>,
): NewInterview {
  return {
    targetTitle: 'Senior Engineer',
    scheduledStart: '2026-09-24T09:00:00.000Z',
    scheduledEnd: '2026-09-24T10:00:00.000Z',
    format: 'video',
    roundLabel: 'Technical',
    ...overrides,
  };
}

describe('SqliteInterviewsRepository', () => {
  it('inserts with defaults and reads back by id (application_id nullable)', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      iv({ id: 'int-1', profileId: 'prof-1', createdByAccountId: 'acc-1' }),
    );
    const stored = await repo.getById('int-1');
    expect(stored).toBeDefined();
    expect(stored!.status).toBe('scheduled');
    expect(stored!.applicationId).toBeNull();
    expect(stored!.targetCompany).toBeNull();
    expect(stored!.interviewerName).toBeNull();
    expect(stored!.interviewerEmail).toBeNull();
    expect(stored!.outcome).toBeNull();
    expect(stored!.feedbackNote).toBeNull();
    expect(stored!.rating).toBeNull();
    expect(stored!.createdByAccountId).toBe('acc-1');
    close();
  });

  it('lists only the owner rows, ordered by scheduled_start desc, with filters', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      iv({
        id: 'int-1',
        profileId: 'prof-1',
        createdByAccountId: 'acc-1',
        scheduledStart: '2026-09-24T09:00:00.000Z',
        scheduledEnd: '2026-09-24T10:00:00.000Z',
      }),
    );
    await repo.insert(
      iv({
        id: 'int-2',
        profileId: 'prof-1',
        createdByAccountId: 'acc-1',
        scheduledStart: '2026-09-26T09:00:00.000Z',
        scheduledEnd: '2026-09-26T10:00:00.000Z',
        status: 'completed',
      }),
    );
    // another owner must never leak into acc-1's list
    await repo.insert(
      iv({
        id: 'int-3',
        profileId: 'prof-1',
        createdByAccountId: 'acc-2',
        scheduledStart: '2026-09-27T09:00:00.000Z',
        scheduledEnd: '2026-09-27T10:00:00.000Z',
      }),
    );

    const mine = await repo.listByOwner('acc-1');
    expect(mine.map((i) => i.id)).toEqual(['int-2', 'int-1']);

    const byStatus = await repo.listByOwner('acc-1', { status: 'completed' });
    expect(byStatus.map((i) => i.id)).toEqual(['int-2']);

    const byProfile = await repo.listByOwner('acc-1', { profileId: 'prof-1' });
    expect(byProfile).toHaveLength(2);

    const other = await repo.listByOwner('acc-2');
    expect(other.map((i) => i.id)).toEqual(['int-3']);
    close();
  });

  it('patches status/outcome/rating, clears nullable fields, and bumps updated_at', async () => {
    const { repo, close } = freshRepo();
    await repo.insert(
      iv({
        id: 'int-1',
        profileId: 'prof-1',
        createdByAccountId: 'acc-1',
        interviewerName: 'Jane Recruiter',
      }),
    );
    const before = (await repo.getById('int-1'))!.updatedAt;
    const updated = await repo.update('int-1', {
      status: 'completed',
      outcome: 'strong_yes',
      rating: 5,
      feedbackNote: 'Excellent system design',
    });
    expect(updated!.status).toBe('completed');
    expect(updated!.outcome).toBe('strong_yes');
    expect(updated!.rating).toBe(5);
    expect(updated!.feedbackNote).toBe('Excellent system design');
    expect(updated!.updatedAt >= before).toBe(true);

    // explicit null clears a previously set field
    const cleared = await repo.update('int-1', { interviewerName: null });
    expect(cleared!.interviewerName).toBeNull();

    expect(await repo.update('missing', { status: 'cancelled' })).toBeUndefined();
    close();
  });

  it('exposes the full enums', () => {
    expect(INTERVIEW_FORMATS).toEqual(['onsite', 'phone', 'video']);
    expect(INTERVIEW_STATUSES).toEqual([
      'scheduled',
      'completed',
      'cancelled',
      'no_show',
      'rescheduled',
    ]);
    expect(INTERVIEW_OUTCOMES).toEqual(['strong_yes', 'yes', 'neutral', 'no']);
  });

  it('coerces illegal enum values from raw rows instead of leaking them', () => {
    const base: RawInterviewRow = {
      id: 'int-x',
      profileId: 'prof-1',
      applicationId: null,
      targetTitle: 'Senior Engineer',
      targetCompany: null,
      scheduledStart: '2026-09-24T09:00:00.000Z',
      scheduledEnd: '2026-09-24T10:00:00.000Z',
      format: 'hologram',
      roundLabel: 'Technical',
      interviewerName: null,
      interviewerEmail: null,
      status: 'bogus',
      outcome: 'maybe',
      feedbackNote: null,
      rating: null,
      createdByAccountId: 'acc-1',
      createdAt: '2026-09-24T08:00:00.000Z',
      updatedAt: '2026-09-24T08:00:00.000Z',
    };
    const stored = toStoredInterview(base);
    expect(stored.format).toBe('onsite');
    expect(stored.status).toBe('scheduled');
    expect(stored.outcome).toBeNull();
  });
});
