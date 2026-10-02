/**
 * 工作台真全栈 E2E 的夹具（2026-10-03）。
 *
 * 造一个"生产形态但确定"的库：一张已认领画像（带证据）+ 一个账号 + 一个固定会话 +
 * 若干**可直接预期档位**的夹具岗位。**零网络、零 jobs sync**，因此用例可以对条数与档位做硬断言。
 *
 * 关键夹具设计：`jobId`（来源原生 id）**故意不等于**岗位池主键
 * （`job_postings.id = makeJobPostingId(source, sourceUrl)`，派生哈希）。
 * 这正是 2026-10-03 那个 404 的成因——若夹具让两者相等，回归就测不出来。
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStorage } from '@jobagent/storage';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 与 playwright.agent.config.ts 保持一致：库名带本轮唯一后缀由配置生成，这里用 glob 后的路径 */
export const AGENT_DB =
  process.env.JA_AGENT_DB ?? resolve(HERE, '..', '.tmp-agent', `agent-${process.pid}-${Date.now()}.db`);

export const FIXTURE_PROFILE_ID = 'prof-agent-e2e';
export const FIXTURE_ACCOUNT_ID = 'acc-agent-e2e';
export const FIXTURE_SESSION_TOKEN = 'agent-e2e-session-token-0123456789abcdef';
export const FIXTURE_LOGIN = 'agent-e2e';

const ISO = (day: number) => `2026-10-0${day}T00:00:00.000Z`;

/** 三条会进待投清单（high 1 + mid 2）+ 一条被偏好关键词挡掉的噪声岗位。 */
function fixturePostings() {
  const base = {
    source: 'greenhouse' as const,
    company: 'Fixture Corp',
    location: 'Remote',
    remote: true,
    salaryMin: 120_000,
    salaryMax: 160_000,
    salaryCurrency: 'USD',
    fetchedAt: ISO(9),
  };
  return [
    {
      ...base,
      jobId: 'native-1001', // ≠ 池主键：回归点
      sourceUrl: 'https://fixtures.test/jobs/1001',
      title: 'Senior TypeScript Platform Engineer',
      tags: ['typescript'],
      description: 'TypeScript platform work.',
      postedAt: ISO(3),
      normalizedKey: 'fixture-1001',
    },
    {
      ...base,
      jobId: 'native-1002',
      sourceUrl: 'https://fixtures.test/jobs/1002',
      title: 'TypeScript Engineer',
      tags: ['typescript', 'astro', 'react'],
      description: 'TypeScript, Astro and React.',
      postedAt: ISO(4),
      normalizedKey: 'fixture-1002',
    },
    {
      ...base,
      jobId: 'native-1003',
      sourceUrl: 'https://fixtures.test/jobs/1003',
      title: 'Backend Engineer',
      tags: ['typescript'],
      description: 'TypeScript services.',
      postedAt: ISO(5),
      normalizedKey: 'fixture-1003',
    },
    {
      ...base,
      jobId: 'native-1004',
      sourceUrl: 'https://fixtures.test/jobs/1004',
      title: 'Marketing Manager',
      tags: ['marketing'],
      description: 'Own campaigns and brand.',
      postedAt: ISO(6),
      normalizedKey: 'fixture-1004',
    },
  ];
}

const profile = {
  profileId: FIXTURE_PROFILE_ID,
  analyzerVersion: '0.1-0.8',
  generatedAt: ISO(1),
  dataWindow: { since: '2025-10-01T00:00:00.000Z', until: ISO(1) },
  analysisLayers: ['L0', 'L1'],
  subject: {
    platform: 'github',
    login: FIXTURE_LOGIN,
    displayName: 'Agent E2E',
    profileUrl: `https://github.com/${FIXTURE_LOGIN}`,
    claimed: true,
  },
  summary: { headline: 'TypeScript developer with verifiable evidence' },
  skillTags: [
    { name: 'TypeScript', kind: 'language', depth: 'proficient', confidence: 0.95, evidenceRefs: ['ev-a', 'ev-b'] },
    { name: 'Astro', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['ev-a'] },
    { name: 'React', kind: 'framework', depth: 'used', confidence: 0.7, evidenceRefs: ['ev-c'] },
  ],
  activity: { longevityMonths: 18, metrics: { totalRepos: 9, totalPullRequests: 6, mergedPullRequests: 5 } },
  collaboration: { prSummary: 'Opened 6 PRs, merged 5', evidenceRefs: ['ev-a'] },
  authenticity: { status: 'likely_authentic', confidence: 0.88, signals: [] },
  interviewQuestions: [],
  caveats: [],
};

const evidence = [
  {
    evidenceId: 'ev-a',
    sourcePlatform: 'github',
    sourceType: 'pr',
    url: 'https://github.com/agent-e2e/app/pull/42',
    occurredAt: ISO(1),
    layer: 'L1',
    claim: 'Merged PR #42 in agent-e2e/app',
    rawRef: '42',
  },
  {
    evidenceId: 'ev-b',
    sourcePlatform: 'github',
    sourceType: 'commit',
    url: 'https://github.com/agent-e2e/app/commit/abc1234',
    occurredAt: ISO(1),
    layer: 'L1',
    claim: 'Committed to agent-e2e/app',
    rawRef: 'abc1234',
  },
  {
    evidenceId: 'ev-c',
    sourcePlatform: 'github',
    sourceType: 'issue',
    url: 'https://github.com/agent-e2e/web/issues/7',
    occurredAt: ISO(1),
    layer: 'L1',
    claim: 'Opened issue #7 in agent-e2e/web',
    rawRef: '7',
  },
];

export default async function globalSetup(): Promise<void> {
  mkdirSync(dirname(AGENT_DB), { recursive: true });
  // 目录与库文件由 playwright.agent.config.ts 在配置加载期准备（API 启动即打开它并自动迁移），
  // 这里只负责灌夹具——不要删库/重建目录，否则会踩到已启动的 API 连接。
  const repos = await createStorage({ sqlitePath: AGENT_DB });
  await repos.profiles.insert({
    id: FIXTURE_PROFILE_ID,
    analyzerVersion: '0.1-0.8',
    subjectPlatform: 'github',
    subjectLogin: FIXTURE_LOGIN,
    subjectClaimed: true,
    dataWindowSince: '2025-10-01T00:00:00.000Z',
    dataWindowUntil: ISO(1),
    analysisLayers: ['L0', 'L1'],
    status: 'complete',
    snapshot: profile,
  });
  await repos.evidence.importFromProfile(FIXTURE_PROFILE_ID, evidence);
  await repos.profiles.markClaimed(FIXTURE_PROFILE_ID);
  await repos.accounts.upsertFromProvider({
    id: FIXTURE_ACCOUNT_ID,
    identity: {
      platform: 'github',
      providerAccountId: '888001',
      login: FIXTURE_LOGIN,
      name: 'Agent E2E',
      email: null,
      avatarUrl: null,
    },
  });
  await repos.accounts.setClaimedProfile(FIXTURE_ACCOUNT_ID, FIXTURE_PROFILE_ID);
  await repos.authSessions.create({
    id: FIXTURE_SESSION_TOKEN,
    accountId: FIXTURE_ACCOUNT_ID,
    expiresAt: '2026-12-31T00:00:00.000Z',
    createdAt: ISO(1),
    lastSeenAt: ISO(1),
  });
  await repos.jobPostings.upsertBatch(fixturePostings(), ISO(9));

  // 自校验：夹具必须真的能产出 3 条 mid 以上候选，否则用例会以"没数据"这种含糊方式失败
  const pool = await repos.jobPostings.search({ status: 'active', limit: 100, orderBy: 'posted_desc' });
  if (pool.length < 4) {
    throw new Error(`[agent-e2e] fixture pool too small: ${pool.length}`);
  }
  if (pool.some((p) => p.jobId === p.id)) {
    throw new Error('[agent-e2e] fixture must keep native jobId different from the pool key (regression guard)');
  }
}
