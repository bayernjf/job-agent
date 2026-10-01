/** 测试夹具：内存 SQLite + createApp，灌一份带证据/面试题/岗位的画像，供 MCP 端到端测试用。 */
import type { AbilityProfile, SkillTag } from '@jobagent/shared';
import { createStorage, type NewJobPosting, type StorageContext } from '@jobagent/storage';
import { createApp, type ApiDeps } from '@jobagent/api';

export const NOW = '2026-09-10T00:00:00.000Z';
export const PROFILE_ID = 'p-mcp-1';
export const SUBJECT = { platform: 'github' as const, login: 'alice' };

export function makeProfile(): AbilityProfile {
  const tags: SkillTag[] = [
    { name: 'typescript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['repo:alice/core'] },
    { name: 'ai agents', kind: 'framework', depth: 'proficient', confidence: 0.8, evidenceRefs: ['repo:alice/agent'] },
  ];
  return {
    profileId: PROFILE_ID,
    analyzerVersion: 'schema-0.1-engine-0.8.0',
    generatedAt: '2026-09-01T00:00:00.000Z',
    dataWindow: { since: '2024-01-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform: 'github',
      login: SUBJECT.login,
      displayName: 'Alice',
      profileUrl: 'https://github.com/alice',
      claimed: false,
    },
    summary: { headline: 'TypeScript developer building agents' },
    skillTags: tags,
    activity: { longevityMonths: 24, metrics: { commitCount: 120 } },
    collaboration: { evidenceRefs: [], prSummary: 'Merged 10 PRs' },
    authenticity: {
      status: 'likely_authentic',
      confidence: 0.82,
      signals: [
        {
          code: 'external_merged_pr',
          severity: 'info',
          label: 'Has merged external pull requests',
          detail: 'Merged 2 PRs into other repositories; see https://github.com/other/repo/pull/3',
          evidenceRefs: ['pr:other/3'],
        },
      ],
    },
    interviewQuestions: [
      {
        question: 'Walk through the hardest agent loop you shipped.',
        intent: 'Probe self-owned repo depth',
        basisEvidenceRef: 'repo:alice/agent',
        kind: 'self_repo_depth',
      },
    ],
    caveats: [],
  };
}

let seq = 0;
function posting(overrides: Partial<NewJobPosting> & { title: string }): NewJobPosting {
  seq += 1;
  const { title, ...rest } = overrides;
  return {
    jobId: `ext-${seq}`,
    source: 'remoteok',
    sourceUrl: `https://example.test/jobs/${seq}`,
    title,
    company: 'Acme',
    remote: true,
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: NOW,
    tags: [],
    ...rest,
    normalizedKey: `nk-${seq}`,
  };
}

export async function buildHarness() {
  const repos: StorageContext = await createStorage({ sqlitePath: ':memory:' });
  await repos.profiles.insert({
    id: PROFILE_ID,
    analyzerVersion: 'schema-0.1-engine-0.8.0',
    subjectLogin: SUBJECT.login,
    dataWindowSince: '2024-01-01T00:00:00.000Z',
    dataWindowUntil: '2026-09-01T00:00:00.000Z',
    status: 'complete',
    snapshot: makeProfile(),
  });
  await repos.evidence.insert({
    id: 'ev-1',
    profileId: PROFILE_ID,
    sourceType: 'pull_request',
    url: 'https://github.com/other/repo/pull/3',
    layer: 'L1',
    claim: 'Merged an external PR',
    rawRef: 'pr:other/3',
  });
  await repos.jobPostings.upsertBatch(
    [posting({ title: 'Senior AI Engineer', tags: ['typescript', 'ai agents'], description: 'agent role' })],
    NOW,
  );
  const app = await createApp({ repos, now: () => NOW });
  return { repos, app };
}
