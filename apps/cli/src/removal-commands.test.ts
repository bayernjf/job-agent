import { describe, expect, it } from 'vitest';
import {
  createStorage,
  type NewApplication,
  type NewEvidence,
  type StorageContext,
} from '@jobagent/storage';
import type { AbilityProfile } from '@jobagent/shared';
import { run, type CliDeps } from './index.js';

async function harness(): Promise<{
  storage: StorageContext;
  deps: CliDeps;
  out: () => string;
  err: () => string;
}> {
  let out = '';
  let err = '';
  const storage = await createStorage({ sqlitePath: ':memory:' });
  const deps: CliDeps = {
    storage,
    now: () => '2026-10-01T00:00:00.000Z',
    stdout: { write: (c: string) => void (out += c) },
    logger: {
      log: () => undefined,
      info: () => undefined,
      warn: (m: string) => void (err += `${m}\n`),
      error: (m: string) => void (err += `${m}\n`),
    },
  };
  return { storage, deps, out: () => out, err: () => err };
}

function sampleProfile(profileId: string): AbilityProfile {
  return {
    profileId,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: '2026-09-25T00:00:00.000Z',
    dataWindow: { since: '2025-09-25T00:00:00.000Z', until: '2026-09-25T00:00:00.000Z' },
    analysisLayers: ['L0', 'L1'],
    subject: { platform: 'github', login: 'rem-user', profileUrl: 'https://github.com/rem-user', claimed: false },
    summary: { headline: 'Test developer' },
    skillTags: [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.7, signals: [] },
    interviewQuestions: [],
  } as unknown as AbilityProfile;
}

async function seedProfile(storage: StorageContext, profileId: string, removalRequestedAt: string | null = null): Promise<void> {
  const snapshot = sampleProfile(profileId);
  await storage.profiles.insert({
    id: profileId,
    analyzerVersion: snapshot.analyzerVersion,
    subjectLogin: 'rem-user',
    subjectClaimed: false,
    dataWindowSince: snapshot.dataWindow.since,
    dataWindowUntil: snapshot.dataWindow.until,
    status: 'complete',
    snapshot,
    removalRequestedAt,
  });
  const evidence: NewEvidence = {
    id: `ev-${profileId}`,
    profileId,
    sourcePlatform: 'github',
    sourceType: 'commit',
    url: `https://github.com/rem-user/repo/commit/abc`,
    occurredAt: '2026-09-01T00:00:00.000Z',
    layer: 'L1',
    claim: 'authored commit Fix login flow',
    rawRef: 'repo/commit/abc',
  };
  await storage.evidence.insert(evidence);
  const app: NewApplication = {
    id: `app-${profileId}`,
    profileId,
    targetTitle: 'Engineer',
    targetCompany: 'Acme',
    appliedAt: '2026-09-20T00:00:00.000Z',
  };
  await storage.applications.insert(app);
}

async function seedRequest(
  storage: StorageContext,
  id: string,
  profileId: string,
): Promise<void> {
  await storage.profileRemovalRequests.insert({
    id,
    profileId,
    status: 'pending',
    reason: 'not me',
    contact: 'a@b.com',
    ipHash: null,
    createdAt: '2026-10-01T00:00:00.000Z',
  });
}

describe('removal list', () => {
  it('lists pending requests by default and filters by status', async () => {
    const { storage, deps, out } = await harness();
    await seedProfile(storage, 'prof-r1', '2026-10-01T00:00:00.000Z');
    await seedRequest(storage, 'rem-1', 'prof-r1');

    const code = await run(['removal', 'list'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('rem-1');
    expect(out()).toContain('prof-r1');
    expect(out()).toContain('pending');
  });

  it('rejects an invalid --status', async () => {
    const { deps, err } = await harness();
    const code = await run(['removal', 'list', '--status', 'bogus'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('pending');
  });
});

describe('removal approve', () => {
  it('cascade-deletes the profile and marks the request approved', async () => {
    const { storage, deps, out } = await harness();
    await seedProfile(storage, 'prof-r2', '2026-10-01T00:00:00.000Z');
    await seedRequest(storage, 'rem-2', 'prof-r2');

    const code = await run(['removal', 'approve', '--request', 'rem-2'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('approved rem-2');
    expect(await storage.profiles.getById('prof-r2')).toBeUndefined();
    expect(await storage.evidence.listByProfile('prof-r2')).toHaveLength(0);
    expect(await storage.applications.listByProfile('prof-r2')).toHaveLength(0);
    const req = await storage.profileRemovalRequests.getById('rem-2');
    expect(req!.status).toBe('approved');
    expect(req!.decidedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('fails with 1 when the request does not exist', async () => {
    const { deps, err } = await harness();
    const code = await run(['removal', 'approve', '--request', 'rem-ghost'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('removal request not found: rem-ghost');
  });

  it('fails with 2 when the request is already decided', async () => {
    const { storage, deps, err } = await harness();
    await seedProfile(storage, 'prof-r3', '2026-10-01T00:00:00.000Z');
    await seedRequest(storage, 'rem-3', 'prof-r3');
    await storage.profileRemovalRequests.decide('rem-3', 'approved', '2026-10-01T00:00:00.000Z');

    const code = await run(['removal', 'approve', '--request', 'rem-3'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('already decided');
  });

  it('fails with 2 when --request is missing', async () => {
    const { deps, err } = await harness();
    const code = await run(['removal', 'approve'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('--request');
  });
});

describe('removal reject', () => {
  it('clears the soft-hold and marks the request rejected', async () => {
    const { storage, deps, out } = await harness();
    await seedProfile(storage, 'prof-r4', '2026-10-01T00:00:00.000Z');
    await seedRequest(storage, 'rem-4', 'prof-r4');

    const code = await run(['removal', 'reject', '--request', 'rem-4'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('rejected rem-4');
    const profile = await storage.profiles.getById('prof-r4');
    expect(profile).toBeDefined();
    expect(profile!.removalRequestedAt).toBeNull();
    const req = await storage.profileRemovalRequests.getById('rem-4');
    expect(req!.status).toBe('rejected');
  });
});

describe('removal dispatch', () => {
  it('fails with 2 for an unknown subcommand', async () => {
    const { deps, err } = await harness();
    const code = await run(['removal', 'explode'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('Usage: jobagent removal');
  });
});
