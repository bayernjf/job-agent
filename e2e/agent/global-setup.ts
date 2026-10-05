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
import { openSqlite } from '../../packages/storage/dist/sqlite/connection.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * 与 playwright.agent.config.ts 的 AGENT_DB 保持**同一固定路径**（确定性硬要求）：
 * globalSetup 在 Playwright 独立进程中运行，跨进程传路径只能靠 env 继承，而继承并不可靠
 * （实测曾出现 globalSetup 回退到自己的 pid-ts 文件、与 webServer 各用一库，导致
 * "导航已登录、页面恒登录墙"）。固定文件名消除该不确定性；并发冲突风险极低
 * （本地单跑 / CI 每 job 独立 checkout），配置加载期会先清理残留。
 */
export const AGENT_DB =
  process.env.JA_AGENT_DB ?? resolve(HERE, '..', '.tmp-agent', 'agent-e2e.db');

export const FIXTURE_PROFILE_ID = 'prof-agent-e2e';
export const FIXTURE_ACCOUNT_ID = 'acc-agent-e2e';
export const FIXTURE_SESSION_TOKEN = 'agent-e2e-session-token-0123456789abcdef';
export const FIXTURE_LOGIN = 'agent-e2e';

// 第二个身份：已声明招聘方（login 与画像主体不同），用于在真链路上验证 B 端
// claim 核验视图对"已认领但非本人画像"的授权（authorizeVerifier 的 isRecruiter 分支）。
export const FIXTURE_RECRUITER_ACCOUNT_ID = 'acc-recruiter-e2e';
export const FIXTURE_RECRUITER_SESSION_TOKEN =
  'agent-e2e-recruiter-session-token-0123456789abcdef';
export const FIXTURE_RECRUITER_LOGIN = 'recruiter-e2e';

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
  // 幂等重灌（不删库文件、不重建 schema）：
  // 1) 若删除/重建文件，会替换其他进程（API/report）已打开连接的底层文件，
  //    触发 SQLITE_READONLY_DBMOVED（写库即 500）或「readonly 连接缓存空库」；
  // 2) 本函数既在配置加载期执行（Playwright 可能多次 import 配置 → 多次执行），
  //    也在需要时手动执行——必须对多次运行安全。
  // 流程：确保 schema（幂等迁移）→ 清空业务表 → 灌夹具。
  mkdirSync(dirname(AGENT_DB), { recursive: true });
  const bootstrap = await createStorage({ sqlitePath: AGENT_DB });
  await bootstrap.close();
  const raw = openSqlite(AGENT_DB, { readonly: false });
  try {
    raw.client.exec(`
      DELETE FROM claim_verifications;
      DELETE FROM submit_intents;
      DELETE FROM job_run_events;
      DELETE FROM job_runs;
      DELETE FROM job_preferences;
      DELETE FROM applications;
      DELETE FROM interviews;
      DELETE FROM profile_removal_requests;
      DELETE FROM demo_rate_events;
      DELETE FROM demo_sessions;
      DELETE FROM waitlist;
      DELETE FROM analysis_jobs;
      DELETE FROM job_postings;
      DELETE FROM auth_sessions;
      DELETE FROM accounts;
      DELETE FROM evidence;
      DELETE FROM profiles;
    `);
  } finally {
    raw.client.close();
  }
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
  // 已声明招聘方（与画像主体不同 login）：用于 B 端 claim 核验视图真链路授权。
  await repos.accounts.upsertFromProvider({
    id: FIXTURE_RECRUITER_ACCOUNT_ID,
    identity: {
      platform: 'github',
      providerAccountId: '888002',
      login: FIXTURE_RECRUITER_LOGIN,
      name: 'Recruiter E2E',
      email: null,
      avatarUrl: null,
    },
  });
  await repos.accounts.declareRecruiter(FIXTURE_RECRUITER_ACCOUNT_ID, ISO(1));
  await repos.authSessions.create({
    id: FIXTURE_RECRUITER_SESSION_TOKEN,
    accountId: FIXTURE_RECRUITER_ACCOUNT_ID,
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
