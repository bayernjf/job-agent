import { describe, expect, it } from 'vitest';
import { createStorage, type NewEvidence, type StorageContext } from '@jobagent/storage';
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
    now: () => new Date().toISOString(),
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
    subject: { platform: 'github', login: 'del-user', profileUrl: 'https://github.com/del-user', claimed: false },
    summary: { headline: 'Test developer' },
    skillTags: [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.7, signals: [] },
    interviewQuestions: [],
  } as unknown as AbilityProfile;
}

async function seedProfile(storage: StorageContext, profileId: string): Promise<void> {
  const snapshot = sampleProfile(profileId);
  await storage.profiles.insert({
    id: profileId,
    analyzerVersion: snapshot.analyzerVersion,
    subjectLogin: 'del-user',
    subjectClaimed: false,
    dataWindowSince: snapshot.dataWindow.since,
    dataWindowUntil: snapshot.dataWindow.until,
    status: 'complete',
    snapshot,
  });
  const evidence: NewEvidence = {
    id: `ev-${profileId}`,
    profileId,
    sourcePlatform: 'github',
    sourceType: 'commit',
    url: `https://github.com/del-user/repo/commit/abc`,
    occurredAt: '2026-09-01T00:00:00.000Z',
    layer: 'L1',
    claim: 'authored commit Fix login flow',
    rawRef: 'repo/commit/abc',
  };
  await storage.evidence.insert(evidence);
}

describe('profiles delete（T26 删除与解绑最小版）', () => {
  it('deletes the profile and its evidence; page/API readers then find nothing', async () => {
    const { storage, deps, out, err } = await harness();
    await seedProfile(storage, 'prof-del-1');

    const code = await run(['profiles', 'delete', '--profile', 'prof-del-1'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('deleted profile prof-del-1');
    expect(err()).toBe('');
    expect(await storage.profiles.getById('prof-del-1')).toBeUndefined();
    expect(await storage.evidence.listByProfile('prof-del-1')).toHaveLength(0);
  });

  it('fails with 2 when --profile is missing', async () => {
    const { deps, err } = await harness();
    const code = await run(['profiles', 'delete'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('--profile');
  });

  it('fails with 1 when the profile does not exist (idempotent guard)', async () => {
    const { deps, err } = await harness();
    const code = await run(['profiles', 'delete', '--profile', 'prof-ghost'], deps);
    expect(code).toBe(1);
    expect(err()).toContain('profile not found: prof-ghost');
  });

  it('fails with 2 for an unknown profiles subcommand', async () => {
    const { deps, err } = await harness();
    const code = await run(['profiles', 'explode'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('Usage: jobagent profiles delete');
  });
});
