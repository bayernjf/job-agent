import type { MatchReport, MatchScoreTier, SubmitIntentJob } from '@jobagent/shared';
import { buildMatchReport, type CandidateLike } from './match-report.js';
import type { PreferencePostingLike } from './preferences.js';

/**
 * 一轮扫描的产出计划（纯函数）：候选 → 待投票据的数据部分。
 *
 * 票据里内嵌岗位精简快照：岗位池会被日更覆盖、下架或改价，票据必须自证「当时投的是哪一条」。
 * 只存展示与回溯所需的字段（不存 description——那是源站大字段，进票据只会膨胀库）。
 */

export interface IntentJobSnapshotSource extends PreferencePostingLike {
  /** 岗位池主键（`job_postings.id`）——票据据此回查活岗位行、生成定向简历 */
  id: string;
  sourceUrl: string;
  applyUrl?: string | null;
  salaryCurrency?: string | null;
}

export function toSubmitIntentJob(posting: IntentJobSnapshotSource): SubmitIntentJob {
  const snapshot: SubmitIntentJob = {
    jobId: posting.jobId,
    postingId: posting.id,
    source: posting.source,
    sourceUrl: posting.sourceUrl,
    title: posting.title,
    company: posting.company,
    remote: posting.remote === true,
    tags: [...(posting.tags ?? [])],
    postedAt: posting.postedAt,
  };
  if (posting.applyUrl) snapshot.applyUrl = posting.applyUrl;
  if (posting.location !== undefined) snapshot.location = posting.location;
  if (posting.salaryMin !== undefined) snapshot.salaryMin = posting.salaryMin;
  if (posting.salaryMax !== undefined) snapshot.salaryMax = posting.salaryMax;
  if (posting.salaryCurrency !== undefined) snapshot.salaryCurrency = posting.salaryCurrency;
  return snapshot;
}

export interface PlannedIntent {
  job: SubmitIntentJob;
  matchScore: number;
  matchTier: MatchScoreTier;
  report: MatchReport;
}

/**
 * 候选 → 票据数据。质量闸与排序已由 `selectCandidates` 完成，这里只做投影，
 * 保证「报告里的分数」与「选择时的分数」同源（同一 match 对象）。
 */
export function planIntents(
  candidates: readonly CandidateLike[],
  options: { profileSkills: readonly string[]; maxGaps?: number },
): PlannedIntent[] {
  return candidates.map((candidate) => {
    const posting = candidate.posting as IntentJobSnapshotSource;
    const report = buildMatchReport({
      match: candidate.match,
      tags: posting.tags ?? [],
      profileSkills: options.profileSkills,
      ...(options.maxGaps !== undefined ? { maxGaps: options.maxGaps } : {}),
    });
    return {
      job: toSubmitIntentJob(posting),
      matchScore: report.score,
      matchTier: report.tier,
      report,
    };
  });
}
