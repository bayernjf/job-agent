import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStorage, makeJobPostingId, type StorageContext } from '@jobagent/storage';
import type { AbilityProfile, EvidenceItem, JobPosting } from '@jobagent/shared';
import { run, type CliDeps } from './index.js';

const NOW = '2026-09-15T08:00:00.000Z';
const tmpDirs: string[] = [];
function tmpFile(name: string, body: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'resume-cli-'));
  tmpDirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  return file;
}
afterEach(() => {});

function makeProfile(): AbilityProfile {
  return {
    profileId: 'p-1',
    analyzerVersion: '0.1-0.2',
    generatedAt: NOW,
    dataWindow: { since: '2024-01-01T00:00:00.000Z', until: '2026-09-01T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login: 'alice', profileUrl: 'https://github.com/alice', claimed: false },
    summary: { headline: 'Backend developer' },
    skillTags: [
      { name: 'typescript', kind: 'language', depth: 'proficient', confidence: 0.9, evidenceRefs: ['ev-1'] },
      { name: 'rust', kind: 'language', depth: 'used', confidence: 0.5, evidenceRefs: ['ev-2'] },
    ],
    activity: {},
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

function makeEvidence(id: string, claim: string): EvidenceItem {
  return {
    evidenceId: id,
    sourcePlatform: 'github',
    sourceType: 'pr',
    url: `https://github.com/acme/repo/pull/${id}`,
    occurredAt: '2026-05-01T00:00:00.000Z',
    layer: 'L1',
    claim,
    rawRef: id,
  };
}

function makePosting(): JobPosting {
  return {
    jobId: 'gh-1',
    source: 'greenhouse',
    sourceUrl: 'https://example.com/jobs/gh-1',
    title: 'Senior TypeScript Backend Engineer',
    company: 'Acme',
    location: 'Remote',
    remote: true,
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    tags: ['typescript', 'node.js'],
    description: 'typescript services',
    postedAt: '2026-09-01T00:00:00.000Z',
    fetchedAt: '2026-09-02T00:00:00.000Z',
  };
}

async function seedStorage(): Promise<{ storage: StorageContext; jobId: string }> {
  const storage = await createStorage({ sqlitePath: ':memory:' });
  const profile = makeProfile();
  await storage.profiles.insert({
    id: profile.profileId,
    analyzerVersion: profile.analyzerVersion,
    subjectPlatform: 'github',
    subjectLogin: 'alice',
    subjectClaimed: false,
    dataWindowSince: profile.dataWindow.since,
    dataWindowUntil: profile.dataWindow.until,
    analysisLayers: profile.analysisLayers,
    status: 'complete',
    snapshot: profile,
  });
  await storage.evidence.importFromProfile(profile.profileId, [
    makeEvidence('ev-1', 'TypeScript PR'),
    makeEvidence('ev-2', 'Rust commit'),
  ]);
  const posting = makePosting();
  const jobId = makeJobPostingId(posting.source, posting.sourceUrl);
  await storage.jobPostings.upsertBatch([{ ...posting, normalizedKey: 'x' }], NOW);
  return { storage, jobId };
}

function harness(storage: StorageContext): { deps: CliDeps; out: () => string; err: () => string } {
  let out = '';
  let err = '';
  const deps: CliDeps = {
    storage,
    now: () => NOW,
    stdout: { write: (c: string) => void (out += c) },
    logger: {
      log: () => undefined,
      info: () => undefined,
      warn: (m: string) => void (err += `${m}\n`),
      error: (m: string) => void (err += `${m}\n`),
    },
  };
  return { deps, out: () => out, err: () => err };
}

describe('jobagent resume build', () => {
  it('builds a JSON draft from local DB (profileId + jobId), matched skill on top', async () => {
    const { storage, jobId } = await seedStorage();
    const { deps, out } = harness(storage);
    const code = await run(['resume', 'build', '--profile', 'p-1', '--job', jobId, '--format', 'json'], deps);
    expect(code).toBe(0);
    const draft = JSON.parse(out());
    expect(draft.matchedSkills.map((e: { text: string }) => e.text)).toEqual(['typescript']);
    expect(draft.otherSkills.map((e: { text: string }) => e.text)).toEqual(['rust']);
    expect(draft.evidenceHighlights.flatMap((e: { evidenceRefs: string[] }) => e.evidenceRefs)).toEqual(['ev-1']);
    expect(draft.provenance.profileId).toBe('p-1');
  });

  it('builds Markdown from offline files (profile file + job-file + evidence file)', async () => {
    const { storage } = await seedStorage();
    const { deps, out } = harness(storage);
    const profileFile = tmpFile('profile.json', makeProfile());
    const jobFile = tmpFile('job.json', makePosting());
    const evidenceFile = tmpFile('evidence.json', [makeEvidence('ev-1', 'TypeScript PR')]);
    const code = await run(
      ['resume', 'build', '--profile', profileFile, '--job-file', jobFile, '--evidence', evidenceFile, '--format', 'md', '--locale', 'en'],
      deps,
    );
    expect(code).toBe(0);
    const md = out();
    expect(md).toContain('# alice — Backend developer');
    expect(md).toContain('typescript');
    expect(md).toContain('TypeScript PR');
  });

  it('applies local fields from file', async () => {
    const { storage, jobId } = await seedStorage();
    const { deps, out } = harness(storage);
    const localFile = tmpFile('local.json', { fullName: 'Alice B', email: 'a@b.com' });
    const code = await run(
      ['resume', 'build', '--profile', 'p-1', '--job', jobId, '--format', 'json', '--local-fields', localFile],
      deps,
    );
    expect(code).toBe(0);
    const draft = JSON.parse(out());
    expect(draft.header.name).toBe('Alice B');
    expect(draft.header.contact.email).toBe('a@b.com');
  });

  it('returns 2 without --profile', async () => {
    const { storage } = await seedStorage();
    const { deps, err } = harness(storage);
    const code = await run(['resume', 'build', '--job', 'x'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('Usage');
  });

  it('returns 1 when job id missing in DB', async () => {
    const { storage } = await seedStorage();
    const { deps, err } = harness(storage);
    const code = await run(['resume', 'build', '--profile', 'p-1', '--job', 'nope', '--format', 'json'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('not found');
  });

  it('rejects an invalid --format', async () => {
    const { storage, jobId } = await seedStorage();
    const { deps } = harness(storage);
    const code = await run(['resume', 'build', '--profile', 'p-1', '--job', jobId, '--format', 'pdf'], deps);
    expect(code).toBe(2);
  });
});
