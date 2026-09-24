import { and, desc, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { InterviewPatchInput } from '@jobagent/shared';
import {
  toStoredInterview,
  type NewInterview,
  type StoredInterview,
} from '../entities/index.js';
import type { IInterviewsRepository, InterviewListFilter } from '../repositories/interviews.js';
import { interviews as t, type InterviewInsert } from './schema.js';

/** interviews 仓储的 Postgres 实现（全异步）。 */
export class PgInterviewsRepository implements IInterviewsRepository {
  constructor(private readonly db: PostgresJsDatabase) {}

  async insert(interview: NewInterview): Promise<void> {
    await this.db.insert(t).values({
      id: interview.id,
      profileId: interview.profileId,
      applicationId: interview.applicationId ?? null,
      targetTitle: interview.targetTitle,
      targetCompany: interview.targetCompany ?? null,
      scheduledStart: interview.scheduledStart,
      scheduledEnd: interview.scheduledEnd,
      format: interview.format,
      roundLabel: interview.roundLabel,
      interviewerName: interview.interviewerName ?? null,
      interviewerEmail: interview.interviewerEmail ?? null,
      status: interview.status ?? 'scheduled',
      outcome: interview.outcome ?? null,
      feedbackNote: interview.feedbackNote ?? null,
      rating: interview.rating ?? null,
      createdByAccountId: interview.createdByAccountId,
    });
  }

  async getById(id: string): Promise<StoredInterview | undefined> {
    const rows = await this.db.select().from(t).where(eq(t.id, id)).limit(1);
    return rows[0] ? toStoredInterview(rows[0]!) : undefined;
  }

  async listByOwner(
    createdByAccountId: string,
    filter: InterviewListFilter = {},
  ): Promise<StoredInterview[]> {
    const conditions = [eq(t.createdByAccountId, createdByAccountId)];
    if (filter.profileId) conditions.push(eq(t.profileId, filter.profileId));
    if (filter.status) conditions.push(eq(t.status, filter.status));
    const rows = await this.db
      .select()
      .from(t)
      .where(and(...conditions))
      .orderBy(desc(t.scheduledStart));
    return rows.map(toStoredInterview);
  }

  async update(id: string, patch: InterviewPatchInput): Promise<StoredInterview | undefined> {
    const set: Partial<InterviewInsert> & { updatedAt: string } = {
      updatedAt: new Date().toISOString(),
    };
    if (patch.targetTitle !== undefined) set.targetTitle = patch.targetTitle;
    if (patch.targetCompany !== undefined) set.targetCompany = patch.targetCompany;
    if (patch.scheduledStart !== undefined) set.scheduledStart = patch.scheduledStart;
    if (patch.scheduledEnd !== undefined) set.scheduledEnd = patch.scheduledEnd;
    if (patch.format !== undefined) set.format = patch.format;
    if (patch.roundLabel !== undefined) set.roundLabel = patch.roundLabel;
    if (patch.interviewerName !== undefined) set.interviewerName = patch.interviewerName;
    if (patch.interviewerEmail !== undefined) set.interviewerEmail = patch.interviewerEmail;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.outcome !== undefined) set.outcome = patch.outcome;
    if (patch.feedbackNote !== undefined) set.feedbackNote = patch.feedbackNote;
    if (patch.rating !== undefined) set.rating = patch.rating;
    await this.db.update(t).set(set).where(eq(t.id, id));
    return this.getById(id);
  }
}
