/**
 * 扩展 E2E 的静态测试数据：ATS 模拟页 HTML 与岗位匹配响应。
 * 画像复用 e2e/fixtures/sample-profile.ts（经 toExportableProfile 转换），
 * 本文件只放扩展面板特有的匹配响应与页面壳。
 */

/** 模拟一个 Lever 岗位申请页：含 "lever" 文本与 #job-application-form，命中 lever.detect。 */
export const ATS_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Senior Engineer · Lever</title></head>
  <body>
    <main>
      <h1>Senior Software Engineer</h1>
      <p>Apply via Lever.</p>
      <form id="job-application-form">
        <label>Full name <input name="name" /></label>
        <label>Email <input name="email" type="email" /></label>
      </form>
    </main>
  </body>
</html>`;

export const ATS_PAGE_URL = 'https://example.com/jobs';

/** 一条证据字典项（顶层 evidence，面板据此渲染可回溯外链）。 */
const EVIDENCE_DICT = {
  'evt-skill-ts': {
    sourceType: 'pull_request',
    url: 'https://github.com/acme/awesome-lib/pull/12',
    claim: 'Authored a TypeScript type-level refactor merged upstream.',
    occurredAt: '2026-03-01T10:00:00.000Z',
    layer: 'L1',
  },
};

/**
 * 三条匹配刻意覆盖 shared.matchScoreTier 三档（每技能满分 6 = title3+tags2+desc1）：
 * - job-high：单技能 6/6 = 100% → high
 * - job-mid：双技能合计 6/12 = 50% → mid
 * - job-low：单技能 2/6 = 33% → low
 */
export const THREE_TIER_MATCHES = {
  profileSkills: ['TypeScript', 'React'],
  total: 3,
  matches: [
    {
      score: 6,
      matchedSkills: ['TypeScript'],
      fieldScores: { title: 3, tags: 2, description: 1 },
      skillHits: [{ skill: 'TypeScript', score: 6, fields: ['title', 'tags', 'description'] }],
      skillReasons: [
        {
          skill: 'TypeScript',
          score: 6,
          fields: ['title', 'tags', 'description'],
          kind: 'language',
          depth: 'proficient',
          confidence: 0.9,
          evidenceRefs: ['evt-skill-ts'],
        },
      ],
      posting: {
        id: 'row-job-high',
        jobId: 'job-high',
        source: 'lever',
        sourceUrl: 'https://example.test/job-high',
        title: 'Senior TypeScript Engineer',
        company: 'Acme Corp',
        location: 'Remote',
        remote: true,
        postedAt: '2026-09-01T00:00:00.000Z',
      },
    },
    {
      score: 6,
      matchedSkills: ['TypeScript', 'React'],
      fieldScores: { title: 3, tags: 2, description: 1 },
      skillHits: [
        { skill: 'TypeScript', score: 4, fields: ['title', 'tags'] },
        { skill: 'React', score: 2, fields: ['title', 'description'] },
      ],
      posting: {
        id: 'row-job-mid',
        jobId: 'job-mid',
        source: 'remoteok',
        sourceUrl: 'https://example.test/job-mid',
        title: 'Full-stack Developer',
        company: 'Beta Ltd',
        location: 'Remote EU',
        remote: true,
        postedAt: '2026-09-02T00:00:00.000Z',
      },
    },
    {
      score: 2,
      matchedSkills: ['React'],
      fieldScores: { title: 2, tags: 0, description: 0 },
      skillHits: [{ skill: 'React', score: 2, fields: ['title'] }],
      posting: {
        id: 'row-job-low',
        jobId: 'job-low',
        source: 'remotive',
        sourceUrl: 'https://example.test/job-low',
        title: 'Junior Frontend Helper',
        company: 'Gamma Inc',
        location: 'Onsite',
        remote: false,
        postedAt: '2026-09-03T00:00:00.000Z',
      },
    },
  ],
  evidence: EVIDENCE_DICT,
};

export const EMPTY_MATCHES = { profileSkills: ['TypeScript', 'React'], total: 0, matches: [] };
