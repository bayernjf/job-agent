import { describe, expect, it } from 'vitest';
import {
  TIER_ORDER,
  filterPostingsForPreference,
  isPreferredCompany,
  normalizeText,
  passesQualityGate,
  preferenceSkills,
  preferenceToMatchCriteria,
  type PreferencePostingLike,
} from './preferences.js';

function posting(overrides: Partial<PreferencePostingLike> = {}): PreferencePostingLike {
  return {
    jobId: 'job-1',
    source: 'greenhouse',
    title: 'Senior Full Stack Engineer',
    company: 'Acme Inc',
    location: 'Remote - US',
    remote: true,
    salaryMin: 120000,
    salaryMax: 160000,
    tags: ['TypeScript', 'React'],
    description: 'Build web apps with Node.js',
    postedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

const basePreference = {
  targetTitles: ['full stack'],
  locations: [],
  remoteOnly: false,
  companyWhitelist: [],
  companyBlacklist: [],
};

describe('normalizeText', () => {
  it('matches the job-source normalization口径 on tricky inputs (lowercase, punctuation → space, collapse)', () => {
    expect(normalizeText('Node.js')).toBe('node js');
    expect(normalizeText('C++ / C#')).toBe('c c');
    expect(normalizeText('  Senior   Front-End  ')).toBe('senior front end');
    expect(normalizeText('全栈工程师')).toBe('全栈工程师');
    expect(normalizeText(null)).toBe('');
  });
});

describe('preferenceSkills / preferenceToMatchCriteria', () => {
  it('prefers the preference skills and falls back to the profile skills', () => {
    expect(preferenceSkills({ skills: ['Go'] }, ['TypeScript'])).toEqual(['Go']);
    expect(preferenceSkills({ skills: [] }, ['TypeScript', ' React '])).toEqual(['TypeScript', 'React']);
    expect(preferenceSkills({ skills: [] }, [])).toEqual([]);
  });

  it('projects硬过滤 fields with the same semantics as matchJobs (absent = no filter)', () => {
    expect(preferenceToMatchCriteria({ skills: [], remoteOnly: false, salaryMinUsd: null, sources: [] }, ['Rust'])).toEqual({
      skills: ['Rust'],
    });
    expect(
      preferenceToMatchCriteria(
        { skills: ['Go'], remoteOnly: true, salaryMinUsd: 100000, sources: ['remoteok', 'lever'] },
        ['Rust'],
      ),
    ).toEqual({ skills: ['Go'], remote: true, salaryMinUsd: 100000, sources: ['remoteok', 'lever'] });
  });
});

describe('filterPostingsForPreference', () => {
  it('keeps a posting when any target title matches title, tags or description', () => {
    expect(filterPostingsForPreference([posting()], basePreference)).toHaveLength(1);
    expect(
      filterPostingsForPreference(
        [posting({ title: 'Backend Engineer', tags: [], description: 'we do full-stack work' })],
        basePreference,
      ),
    ).toHaveLength(1);
    expect(
      filterPostingsForPreference([posting({ title: 'Data Scientist', tags: ['python'], description: 'ml only' })], basePreference),
    ).toHaveLength(0);
  });

  it('drops blacklisted companies and does not drop whitelisted-only misses', () => {
    const pref = { ...basePreference, companyWhitelist: ['Stripe'], companyBlacklist: ['Acme'] };
    expect(filterPostingsForPreference([posting()], pref)).toHaveLength(0);
    const other = posting({ company: 'Globex' });
    expect(filterPostingsForPreference([other], pref)).toHaveLength(1);
    expect(isPreferredCompany('Stripe, Inc.', pref)).toBe(true);
    expect(isPreferredCompany('Globex', pref)).toBe(false);
  });

  it('applies the location filter only for on-site searches (remote postings have no usable location)', () => {
    const pref = { ...basePreference, locations: ['shenzhen'] };
    expect(filterPostingsForPreference([posting({ location: 'Shenzhen, China', remote: false })], pref)).toHaveLength(1);
    expect(filterPostingsForPreference([posting({ location: 'Beijing, China', remote: false })], pref)).toHaveLength(0);
    // remoteOnly 时不看地区
    expect(
      filterPostingsForPreference([posting({ remote: true })], { ...pref, remoteOnly: true }),
    ).toHaveLength(1);
  });
});

describe('passesQualityGate', () => {
  it('orders tiers low < mid < high and gates at the preference floor', () => {
    expect(TIER_ORDER).toEqual({ low: 0, mid: 1, high: 2 });
    expect(passesQualityGate('high', 'mid')).toBe(true);
    expect(passesQualityGate('mid', 'mid')).toBe(true);
    expect(passesQualityGate('low', 'mid')).toBe(false);
    expect(passesQualityGate('low', 'low')).toBe(true);
    expect(passesQualityGate('mid', 'high')).toBe(false);
  });
});
