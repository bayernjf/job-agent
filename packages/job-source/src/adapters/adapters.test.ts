import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRemoteOkPosts } from './remoteok.js';
import { parseRemotiveJobs } from './remotive.js';
import { parseGreenhouseJobs } from './greenhouse.js';
import { parseLeverPostings } from './lever.js';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/fixtures/jobs',
);
function load(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

const FETCHED = '2026-09-13T00:00:00.000Z';

describe('RemoteOK adapter parse (real fixture)', () => {
  const result = parseRemoteOkPosts(load('remoteok.sample.json'), FETCHED);

  it('skips meta header and maps 3 jobs', () => {
    expect(result.invalid).toBe(0);
    expect(result.postings).toHaveLength(3);
  });

  it('maps fields and cleans empty/zero values', () => {
    const p = result.postings[0]!;
    expect(p.jobId).toBe('1137386');
    expect(p.source).toBe('remoteok');
    expect(p.title).toBe('HR Operations Specialist');
    expect(p.company).toBe('Law Offices of Sabrina Li');
    expect(p.location).toBeNull(); // empty string -> null
    expect(p.remote).toBe(true);
    expect(p.salaryMin).toBeNull(); // 0 -> null
    expect(p.salaryMax).toBeNull();
    expect(p.salaryCurrency).toBeNull();
    // host lowercased by canonicalizeUrl
    expect(p.sourceUrl).toBe('https://remoteok.com/remote-jobs/remote-hr-operations-specialist-law-offices-of-sabrina-li-1137386');
    expect(p.postedAt).toBe('2026-09-12T00:00:05.000Z'); // epoch seconds
  });

  it('strips html (including double-escaped) from description', () => {
    const second = result.postings[1]!;
    expect(second.description).toContain('Marketing Student Assistant');
    expect(second.description).not.toContain('&lt;');
    expect(second.description).not.toContain('<h3');
  });
});

describe('Remotive adapter parse (real fixture)', () => {
  const result = parseRemotiveJobs(load('remotive.sample.json'), FETCHED);

  it('maps 3 jobs', () => {
    expect(result.postings).toHaveLength(3);
    expect(result.invalid).toBe(0);
  });

  it('parses salary strings and timezone-less dates as UTC', () => {
    const a = result.postings[0]!;
    expect(a.salaryMin).toBe(10_000);
    expect(a.salaryMax).toBe(20_000);
    expect(a.salaryCurrency).toBe('USD');
    expect(a.postedAt).toBe('2026-09-11T06:49:00.000Z');
    expect(a.location).toContain('France');
    expect(a.tags).toContain('Artificial Intelligence'); // category merged into tags

    const b = result.postings[1]!;
    expect(b.salaryMin).toBe(25_000);
    expect(b.salaryMax).toBe(35_000);
  });

  it('treats empty salary string as null', () => {
    const c = result.postings[2]!;
    expect(c.salaryMin).toBeNull();
    expect(c.salaryMax).toBeNull();
    expect(c.salaryCurrency).toBeNull();
  });
});

describe('Greenhouse adapter parse (real fixture)', () => {
  const result = parseGreenhouseJobs(load('greenhouse.sample.json'), FETCHED, 'Airtable');

  it('maps 3 jobs with company_name', () => {
    expect(result.postings).toHaveLength(3);
    expect(result.postings.every((p) => p.company === 'Airtable')).toBe(true);
  });

  it('un-doubles escaped content and infers remote from location', () => {
    const remoteRole = result.postings[0]!;
    expect(remoteRole.location).toBe('Remote - US');
    expect(remoteRole.remote).toBe(true);
    expect(remoteRole.description).toContain('Airtable is the no-code app platform');
    expect(remoteRole.description).not.toContain('&lt;');
    expect(remoteRole.description).not.toContain('<div');
    expect(remoteRole.tags).toContain('Sales'); // department
  });

  it('converts offset first_published to UTC ISO', () => {
    // 2026-02-28T09:04:24-05:00 -> 14:04:24Z
    expect(result.postings[0]!.postedAt).toBe('2026-02-28T14:04:24.000Z');
  });
});

describe('Lever adapter parse (real fixture)', () => {
  const result = parseLeverPostings(load('lever.sample.json'), FETCHED, 'Alluxio');

  it('maps 3 jobs with board-provided company', () => {
    expect(result.postings).toHaveLength(3);
    expect(result.postings.every((p) => p.company === 'Alluxio')).toBe(true);
  });

  it('handles ms epoch, workplaceType, plain description and applyUrl', () => {
    const a = result.postings[0]!;
    expect(a.jobId).toBe('ab568a91-31db-4ef1-89ff-66543e5d3149');
    expect(a.remote).toBe(false); // workplaceType onsite
    expect(a.postedAt).toBe(new Date(1789110372398).toISOString()); // ms epoch
    expect(a.description).toContain('Job description'); // descriptionPlain preferred
    expect(a.applyUrl).toContain('/apply');
    expect(a.tags).toContain('Engineering'); // team
  });

  it('falls back to lists when description is empty', () => {
    const b = result.postings[1]!;
    expect(b.description).not.toBeNull();
    expect(b.description).toContain('Senior Software Engineer');
  });
});
