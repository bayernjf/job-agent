// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RecruiterPostings from './RecruiterPostings';

const labels = {
  title: 'My job descriptions',
  subtitle: 'Private postings never enter the public job pool.',
  formTitle: 'Publish a posting',
  fieldTitle: 'Job title',
  fieldTitlePlaceholder: 'ph-title',
  fieldCompany: 'Company / team',
  fieldCompanyPlaceholder: 'ph-company',
  fieldLocation: 'Location (optional)',
  fieldRemote: 'Remote role',
  fieldTags: 'Skill tags (comma-separated)',
  fieldTagsPlaceholder: 'ph-tags',
  fieldDescription: 'Job description (optional)',
  submit: 'Publish',
  submitting: 'Publishing…',
  published: 'Published',
  formError: 'Could not publish',
  listError: 'Could not load your postings',
  reload: 'Retry',
  empty: 'No postings yet.',
  retire: 'Retire',
  retiring: 'Retiring…',
  statusActive: 'Active',
  statusInactive: 'Retired',
  findCandidates: 'Rank candidates',
  needTags: 'Add a skill tag first',
  candidatesLoading: 'Ranking candidates…',
  candidatesError: 'Could not load candidates',
  candidatesEmpty: 'No candidate matched.',
  candidatesCount: '{count} candidates matched',
  verifiedClaims: 'Verified {count} claims',
  interviewsTitle: 'Interviews under this posting',
  interviewsEmpty: 'No interviews linked yet.',
  interviewsError: 'Could not load interviews',
  applicationsTitle: 'Applications on this posting',
  applicationsEmpty: 'No candidate has applied yet',
  applicationsError: 'Could not load applications',
  advanceStage: 'Move to {stage}',
  stageChangeFailed: 'Stage update failed',
  stageLabels: {
    new: 'New',
    screening: 'Screening',
    interview: 'Interview',
    offer: 'Offer',
    hired: 'Hired',
    rejected: 'Rejected',
  },
  statusLabels: {
    scheduled: 'Scheduled',
    completed: 'Completed',
    cancelled: 'Cancelled',
    no_show: 'No show',
    rescheduled: 'Rescheduled',
  },
};

const props = {
  apiBase: 'https://api.example',
  reportBasePath: '/en/report',
  locale: 'en-US',
  labels,
};

function interview(overrides: Record<string, unknown> = {}) {
  return {
    id: 'int-1',
    profileId: 'prof-9',
    roundLabel: '一面 · 技术筛',
    scheduledStart: '2026-10-20T09:00:00.000Z',
    status: 'scheduled',
    outcome: null,
    ...overrides,
  };
}

function posting(overrides: Record<string, unknown> = {}) {
  return {
    id: 'jp-1',
    title: 'Staff Agent Engineer',
    company: 'In-house',
    location: 'Shanghai',
    remote: false,
    tags: ['typescript', 'agents'],
    status: 'active',
    postedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    profileId: 'prof-9',
    login: 'dev-nine',
    displayName: 'Dev Nine',
    headline: 'Builds agent tooling',
    matchedSkills: ['typescript'],
    verifiedClaimCount: 3,
    ...overrides,
  };
}

/** 按 method+path 分派的路由表；未登记的调用直接失败，避免测试对意外请求装作没事。 */
function route(handlers: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url).pathname;
    const key = `${method} ${path}`;
    if (!(key in handlers)) throw new Error(`unhandled fetch: ${key}`);
    const value = handlers[key];
    return Response.json(
      typeof value === 'function' ? (value as (init?: RequestInit) => unknown)(init) : value,
    );
  });
}

describe('RecruiterPostings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('loads my postings and shows status per row', async () => {
    const fetchMock = route({
      'GET /job-postings/recruiter': { items: [posting(), posting({ id: 'jp-2', status: 'inactive', title: 'Retired Role' })] },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RecruiterPostings {...props} />);

    await waitFor(() => expect(screen.getAllByTestId('jd-item')).toHaveLength(2));
    expect(screen.getByText('Staff Agent Engineer')).toBeTruthy();
    expect(screen.getByText('Retired Role')).toBeTruthy();
    expect(screen.getAllByText('Active')).toHaveLength(1);
    expect(screen.getAllByText('Retired')).toHaveLength(1);
    // 每个请求都带同源凭证，否则招聘方身份丢失
    expect(fetchMock.mock.calls[0]![1]?.credentials).toBe('include');
  });

  it('shows the empty state when nothing is published', async () => {
    vi.stubGlobal('fetch', route({ 'GET /job-postings/recruiter': { items: [] } }));
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByText(labels.empty)).toBeTruthy());
  });

  it('publishes a posting and prepends it without another list fetch', async () => {
    const created = posting({ id: 'jp-new', title: 'New Role', tags: ['go', 'rag'] });
    const listFetch = route({
      'GET /job-postings/recruiter': { items: [] },
      'POST /job-postings/recruiter': () => created,
    });
    vi.stubGlobal('fetch', listFetch);
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByText(labels.empty)).toBeTruthy());

    await userEvent.type(screen.getByTestId('jd-title'), 'New Role');
    await userEvent.type(screen.getByTestId('jd-company'), 'In-house');
    await userEvent.type(screen.getByTestId('jd-tags'), 'go, rag, go');
    await userEvent.click(screen.getByTestId('jd-submit'));

    await waitFor(() => expect(screen.getByText('New Role')).toBeTruthy());
    expect(screen.getByText(labels.published)).toBeTruthy();
    const body = JSON.parse(String(listFetch.mock.calls[1]![1]?.body));
    expect(body).toMatchObject({ title: 'New Role', company: 'In-house', tags: ['go', 'rag'], remote: false });
    // 输入去重发生在客户端：'go, rag, go' 只发两条
    expect(body.tags).toHaveLength(2);
  });

  it('blocks publishing without the required fields and never calls the API', async () => {
    const fetchMock = route({
      'GET /job-postings/recruiter': { items: [] },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByTestId('jd-submit')).toBeTruthy());

    await userEvent.click(screen.getByTestId('jd-submit'));
    await waitFor(() => expect(screen.getByTestId('jd-form-error')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(1); // 只有挂载时的列表读取
  });

  it('retires a posting and keeps it in the list as inactive', async () => {
    vi.stubGlobal(
      'fetch',
      route({
        'GET /job-postings/recruiter': { items: [posting()] },
        'DELETE /job-postings/recruiter/jp-1': () => posting({ status: 'inactive' }),
      }),
    );
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByTestId('jd-retire')).toBeTruthy());

    await userEvent.click(screen.getByTestId('jd-retire'));
    await waitFor(() => expect(screen.getByText('Retired')).toBeTruthy());
    expect(screen.queryByTestId('jd-retire')).toBeNull(); // 已下线的行不再给下线按钮
  });

  it('ranks candidates for a posting through the existing /candidates filter', async () => {
    const fetchMock = route({
      'GET /job-postings/recruiter': { items: [posting()] },
      'GET /candidates': { items: [candidate()], total: 12 },
      'GET /interviews': { items: [interview()] },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByTestId('jd-rank')).toBeTruthy());

    await userEvent.click(screen.getByTestId('jd-rank'));
    await waitFor(() => expect(screen.getByTestId('jd-cand-link')).toBeTruthy());

    expect(screen.getByText('Dev Nine')).toBeTruthy();
    expect(screen.getByText('12 candidates matched')).toBeTruthy();
    expect(screen.getByText('Verified 3 claims')).toBeTruthy();
    const rankUrl = new URL(String(fetchMock.mock.calls[1]![0]));
    expect(rankUrl.searchParams.get('skills')).toBe('typescript,agents');
    expect(rankUrl.searchParams.get('sortBy')).toBe('skills');
    expect(rankUrl.searchParams.get('skillMatch')).toBe('any');
    expect(rankUrl.pathname).toBe('/candidates');
  });

  it('shows the interviews already linked to this posting, scoped by postingId', async () => {
    const fetchMock = route({
      'GET /job-postings/recruiter': { items: [posting()] },
      'GET /candidates': { items: [], total: 0 },
      'GET /interviews': {
        items: [interview(), interview({ id: 'int-2', roundLabel: '二面 · 终面', status: 'completed' })],
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByTestId('jd-rank')).toBeTruthy());

    await userEvent.click(screen.getByTestId('jd-rank'));
    await waitFor(() => expect(screen.getAllByTestId('jd-interview-item')).toHaveLength(2));

    // 读的是同一个"只看本人"的列表端点，只是按岗位收窄
    const interviewsUrl = new URL(String(fetchMock.mock.calls[2]![0]));
    expect(interviewsUrl.pathname).toBe('/interviews');
    expect(interviewsUrl.searchParams.get('postingId')).toBe('jp-1');
    expect(screen.getByText('一面 · 技术筛')).toBeTruthy();
    expect(screen.getAllByText('Scheduled')).toHaveLength(1);
    expect(screen.getAllByText('Completed')).toHaveLength(1);
    expect(screen.queryByTestId('jd-interviews-empty')).toBeNull();
    // 面试的候选人链接仍指向报告页核验视图
    expect(screen.getAllByTestId('jd-interview-link')[0]!.getAttribute('href')).toBe(
      '/en/report/prof-9?view=recruiter',
    );
  });

  it('says so when the posting has no linked interviews yet', async () => {
    vi.stubGlobal('fetch', route({
      'GET /job-postings/recruiter': { items: [posting()] },
      'GET /candidates': { items: [], total: 0 },
      'GET /interviews': { items: [] },
    }));
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByTestId('jd-rank')).toBeTruthy());
    await userEvent.click(screen.getByTestId('jd-rank'));
    await waitFor(() => expect(screen.getByTestId('jd-interviews-empty')).toBeTruthy());
    expect(screen.getByText(labels.interviewsEmpty)).toBeTruthy();
  });

  it('keeps the candidates block usable when the interviews read fails', async () => {
    vi.stubGlobal('fetch', route({
      'GET /job-postings/recruiter': { items: [posting()] },
      'GET /candidates': { items: [candidate()], total: 1 },
      'POST /interviews': () => {
        throw new Error('boom');
      },
      'GET /interviews': () => {
        throw new Error('boom');
      },
    }));
    // 第二条读取失败不能把整个面板带走：候选人仍要出现，面试区单独报错
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByTestId('jd-rank')).toBeTruthy());
    await userEvent.click(screen.getByTestId('jd-rank'));
    await waitFor(() => expect(screen.getByTestId('jd-interviews-error')).toBeTruthy());
    expect(screen.getByText('Dev Nine')).toBeTruthy();
    consoleError.mockRestore();
  });

  it('disables ranking when the posting has no skill tags', async () => {
    vi.stubGlobal('fetch', route({
      'GET /job-postings/recruiter': { items: [posting({ tags: [] })] },
    }));
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByTestId('jd-rank')).toBeTruthy());
    expect(screen.getByTestId('jd-rank')).toBeDisabled();
    expect(screen.getByTestId('jd-rank')).toHaveAttribute('title', labels.needTags);
  });

  it('surfaces a list read failure instead of pretending the account has no postings', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    render(<RecruiterPostings {...props} />);
    await waitFor(() => expect(screen.getByText(labels.listError)).toBeTruthy());
    expect(screen.queryByText(labels.empty)).toBeNull();
  });
});
