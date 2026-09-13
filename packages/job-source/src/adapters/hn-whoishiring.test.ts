import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  HnWhoIsHiringAdapter,
  parseHnThread,
  pickHiringStoryId,
} from './hn-whoishiring.js';
import type { JobHttpClient } from '../types.js';
import type { JobPosting } from '@jobagent/shared';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../tests/fixtures/jobs',
);
function load(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), 'utf8'));
}

const FETCHED = '2026-09-13T00:00:00.000Z';
const SEARCH = load('hn-search.sample.json');
const THREAD = load('hn-thread.sample.json');

function byJobId(postings: JobPosting[], id: string): JobPosting {
  const p = postings.find((x) => x.jobId === id);
  if (!p) throw new Error(`missing posting ${id}; got ${postings.map((x) => x.jobId).join(',')}`);
  return p;
}

describe('pickHiringStoryId', () => {
  it('picks the newest "Who is hiring" thread and skips "wants to be hired"', () => {
    expect(pickHiringStoryId(SEARCH)).toBe('49522897');
  });

  it('returns null on malformed input', () => {
    expect(pickHiringStoryId(null)).toBeNull();
    expect(pickHiringStoryId({})).toBeNull();
    expect(pickHiringStoryId({ hits: [] })).toBeNull();
    expect(pickHiringStoryId({ hits: [{ title: 'Ask HN: Who wants to be hired? (x)' }] })).toBeNull();
  });
});

describe('parseHnThread (real September 2026 fixture)', () => {
  const result = parseHnThread(THREAD, FETCHED);

  it('keeps 6 well-formed posts and counts 2 low-confidence skips as invalid', () => {
    expect(result.postings).toHaveLength(6);
    expect(result.invalid).toBe(2); // 4DWW (1 segment) + Pomelo (2 segments)
  });

  it('tags every posting with source and a comment permalink', () => {
    for (const p of result.postings) {
      expect(p.source).toBe('hn_whoishiring');
      expect(p.sourceUrl).toBe(`https://news.ycombinator.com/item?id=${p.jobId}`);
      expect(p.postedAt.endsWith('Z')).toBe(true);
    }
  });

  it('parses a non-USD salary: keeps EUR currency but nulls numbers', () => {
    const modash = byJobId(result.postings, '49522903');
    expect(modash.company).toBe('Modash.io');
    expect(modash.title).toBe('Senior Product Engineer');
    expect(modash.remote).toBe(true);
    expect(modash.location).toBe('Europe');
    expect(modash.salaryMin).toBeNull();
    expect(modash.salaryMax).toBeNull();
    expect(modash.salaryCurrency).toBe('EUR');
    expect(modash.tags).toContain('full-time');
    expect(modash.applyUrl).toBe('https://modash.io/');
  });

  it('expands a shared K unit and parses a USD range out of order', () => {
    const quill = byJobId(result.postings, '49522912');
    expect(quill.remote).toBe(true);
    expect(quill.salaryMin).toBe(150_000);
    expect(quill.salaryMax).toBe(210_000);
    expect(quill.salaryCurrency).toBe('USD');
    // root path keeps a single trailing slash after URL normalization
    expect(quill.applyUrl).toBe('https://quill.co/');
  });

  it('decodes entities in company/title, treats HYBRID as non-remote, falls back to body link', () => {
    const oe = byJobId(result.postings, '49522929');
    expect(oe.company).toBe('Open Education Applications / Neon');
    expect(oe.title).toContain('Platform & DevOps Engineer');
    expect(oe.location).toBe('Utrecht, The Netherlands');
    expect(oe.remote).toBe(false); // HYBRID, no remote token
    expect(oe.applyUrl).toBe('https://openeducation.foundation/'); // header has no link
  });

  it('extracts worldwide location, multiple job types and strips utm params', () => {
    const fw = byJobId(result.postings, '49522930');
    expect(fw.company).toBe('We The Flywheel');
    expect(fw.remote).toBe(true);
    expect(fw.location).toBe('worldwide');
    expect(fw.tags).toEqual(expect.arrayContaining(['contract', 'part-time']));
    // "10–40 hrs/wk" must NOT be mistaken for a salary
    expect(fw.salaryMin).toBeNull();
    expect(fw.applyUrl).toBe('https://wetheflywheel.com/en/careers'); // utm_* stripped
  });

  it('reads ONSITE/REMOTE as remote while keeping the city as location', () => {
    const orig = byJobId(result.postings, '49522949');
    expect(orig.location).toBe('San Francisco');
    expect(orig.remote).toBe(true);
    expect(orig.applyUrl).toContain('origamics.ai/join-us');
  });

  it('strips an anchor embedded in the company segment and uses its href', () => {
    const snout = byJobId(result.postings, '49522989');
    expect(snout.company).toBe('Snout'); // anchor text removed from company name
    expect(snout.title).toBe('Multiple Engineering + Product Roles');
    expect(snout.remote).toBe(true);
    expect(snout.location).toBe('US or Ontario, Canada');
    expect(snout.tags).toContain('full-time');
    // header-embedded company link wins over the body apply link
    expect(snout.applyUrl).toBe('https://snout.com/');
  });

  it('removes empty parentheses left after an anchor is stripped from company', () => {
    const inline = {
      id: 1,
      children: [
        {
          id: 999,
          created_at: '2026-09-01T10:00:00.000Z',
          text: 'Acme (<a href="https://acme.example/">acme.example</a>) | Senior Engineer | Remote | Full-time<p>body text',
        },
      ],
    };
    const r = parseHnThread(inline, FETCHED);
    expect(r.postings).toHaveLength(1);
    expect(r.postings[0]!.company).toBe('Acme');
  });
});

describe('HnWhoIsHiringAdapter.collect', () => {
  function fakeHttp(): JobHttpClient {
    const getJson = vi.fn(async (url: string) => {
      if (url.includes('search_by_date')) return SEARCH;
      if (url.includes('/items/')) return THREAD;
      throw new Error(`unexpected url ${url}`);
    });
    return { getJson } as unknown as JobHttpClient;
  }

  it('resolves the latest thread via search then parses it', async () => {
    const http = fakeHttp();
    const adapter = new HnWhoIsHiringAdapter();
    const result = await adapter.collect({ fetchedAt: FETCHED, http });
    expect(result.postings).toHaveLength(6);
    expect(http.getJson).toHaveBeenCalledTimes(2);
  });

  it('skips search when a storyId is provided', async () => {
    const http = fakeHttp();
    const adapter = new HnWhoIsHiringAdapter({ storyId: '49522897' });
    const result = await adapter.collect({ fetchedAt: FETCHED, http });
    expect(result.postings).toHaveLength(6);
    expect(http.getJson).toHaveBeenCalledTimes(1);
    expect(http.getJson).toHaveBeenCalledWith(expect.stringContaining('/items/49522897'));
  });

  it('throws when no hiring thread can be located', async () => {
    const http = { getJson: vi.fn(async () => ({ hits: [] })) } as unknown as JobHttpClient;
    const adapter = new HnWhoIsHiringAdapter();
    await expect(adapter.collect({ fetchedAt: FETCHED, http })).rejects.toThrow(/Who is hiring/);
  });
});
