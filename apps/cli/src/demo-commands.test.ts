import { afterEach, describe, expect, it } from 'vitest';
import { createStorage, type StorageContext } from '@jobagent/storage';
import type { AbilityProfile, SupportedPlatform } from '@jobagent/shared';
import { run, type CliDeps } from './index.js';

const NOW = '2026-09-15T12:00:00.000Z';
const SAVED_ENV = process.env.DEMO_PRESET_LOGINS;

afterEach(() => {
  if (SAVED_ENV === undefined) delete process.env.DEMO_PRESET_LOGINS;
  else process.env.DEMO_PRESET_LOGINS = SAVED_ENV;
});

function sampleProfile(platform: SupportedPlatform, login: string): AbilityProfile {
  return {
    profileId: `prof-${login}`,
    analyzerVersion: 'schema-0.1-engine-0.1.0',
    generatedAt: NOW,
    dataWindow: { since: '2025-09-15T00:00:00.000Z', until: NOW },
    analysisLayers: ['L0', 'L1'],
    subject: {
      platform,
      login,
      profileUrl: `https://${platform === 'gitee' ? 'gitee.com' : 'github.com'}/${login}`,
      claimed: false,
    },
    summary: { headline: 'sample' },
    skillTags: [],
    activity: { longevityMonths: 12 },
    collaboration: { evidenceRefs: [] },
    authenticity: { status: 'likely_authentic', confidence: 0.8, signals: [] },
    interviewQuestions: [],
    caveats: [],
  };
}

async function insertComplete(
  storage: StorageContext,
  platform: SupportedPlatform,
  login: string,
): Promise<void> {
  const snapshot = sampleProfile(platform, login);
  await storage.profiles.insert({
    id: snapshot.profileId,
    analyzerVersion: snapshot.analyzerVersion,
    subjectPlatform: platform,
    subjectLogin: login,
    dataWindowSince: snapshot.dataWindow.since,
    dataWindowUntil: snapshot.dataWindow.until,
    status: 'complete',
    snapshot,
  });
}

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
    now: () => NOW,
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

describe('jobagent demo seed', () => {
  it('reports missing presets and exits 1 when no complete profile exists', async () => {
    const { deps, out } = await harness();
    const code = await run(['demo', 'seed', '--logins', 'github:alice,gitee:bob'], deps);
    expect(code).toBe(1);
    expect(out()).toContain('missing\tgithub:alice');
    expect(out()).toContain('missing\tgitee:bob');
    expect(out()).toContain('0 ready, 2 missing');
  });

  it('reports ready presets and exits 0 when complete profiles exist', async () => {
    const { storage, deps, out } = await harness();
    await insertComplete(storage, 'github', 'alice');
    await insertComplete(storage, 'gitee', 'bob');
    const code = await run(['demo', 'seed', '--logins', 'github:alice,gitee:bob'], deps);
    expect(code).toBe(0);
    expect(out()).toContain('ready\tgithub:alice\tprof-alice\tlikely_authentic');
    expect(out()).toContain('ready\tgitee:bob\tprof-bob\tlikely_authentic');
    expect(out()).toContain('2 ready, 0 missing');
  });

  it('exits 2 for a malformed preset entry', async () => {
    const { deps, err } = await harness();
    const code = await run(['demo', 'seed', '--logins', 'gitlab:alice'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('bad preset entry');
  });

  it('exits 2 when no presets are supplied and DEMO_PRESET_LOGINS is unset', async () => {
    delete process.env.DEMO_PRESET_LOGINS;
    const { deps, err } = await harness();
    const code = await run(['demo', 'seed'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('no presets');
  });
});

describe('jobagent demo cleanup', () => {
  it('purges expired sessions and older rate events while keeping active ones', async () => {
    const { storage, deps, out } = await harness();
    // 已过期 48h 的会话 + 一条旧限流事件；另留一个未过期 active 会话
    await storage.demoSessions.create({ id: 'demo-old', expiresAt: '2026-09-13T12:00:00.000Z', ipHash: 'iph' });
    await storage.demoSessions.create({ id: 'demo-live', expiresAt: '2026-09-16T12:00:00.000Z', ipHash: null });
    await storage.demoSessions.insertRateEvent('iph', 'analyze', '2026-09-13T12:00:00.000Z');

    const code = await run(['demo', 'cleanup', '--retain-hours', '0'], deps);
    expect(code).toBe(0);
    expect(out()).toMatch(/purged 1 .*session\(s\) and 1 rate event/);

    expect(await storage.demoSessions.getActive('demo-old', NOW)).toBeUndefined();
    expect(await storage.demoSessions.getActive('demo-live', NOW)).toBeDefined();
  });

  it('exits 2 for a negative retain-hours', async () => {
    const { deps, err } = await harness();
    const code = await run(['demo', 'cleanup', '--retain-hours=-1'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('non-negative');
  });
});

describe('jobagent demo dispatch', () => {
  it('exits 2 for an unknown demo subcommand', async () => {
    const { deps, err } = await harness();
    const code = await run(['demo', 'bogus'], deps);
    expect(code).toBe(2);
    expect(err()).toContain('Usage: jobagent demo');
  });
});
