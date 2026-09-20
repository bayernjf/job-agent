/**
 * Playwright global setup：构建 report 应用并预置一个 fixture 画像到临时 SQLite，
 * 让报告页 SSR 有数据可渲染。浏览器全部关闭后在 teardown 清理。
 */
import { rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createStorage } from '@jobagent/storage';
import {
  buildFixtureProfile,
  buildFusedFixtureProfile,
  FIXTURE_PROFILE_ID,
  FIXTURE_FUSED_PROFILE_ID,
  FIXTURE_LOGIN,
  FIXTURE_ACCOUNT_PROVIDER_ID,
  FIXTURE_SESSION_TOKEN,
} from './fixtures/sample-profile.js';

const TMP_DIR = resolve(process.cwd(), 'e2e', '.tmp');
const DB_FILE = resolve(TMP_DIR, 'e2e.db');

export default async function globalSetup(): Promise<() => Promise<void>> {
  // 干净起步
  rmSync(TMP_DIR, { recursive: true, force: true });
  mkdirSync(TMP_DIR, { recursive: true });

  // storage 包需要 dist 产物（report 通过 @jobagent/storage 引用）
  execSync('pnpm --filter @jobagent/storage build', { stdio: 'inherit' });

  const storage = await createStorage({ sqlitePath: DB_FILE, autoMigrate: true });
  const profile = buildFixtureProfile();
  await storage.profiles.insert({
    id: FIXTURE_PROFILE_ID,
    analyzerVersion: profile.analyzerVersion,
    subjectLogin: profile.subject.login,
    subjectClaimed: profile.subject.claimed,
    dataWindowSince: profile.dataWindow.since,
    dataWindowUntil: profile.dataWindow.until,
    status: 'complete',
    snapshot: profile,
  });

  // 融合画像：snapshot 与普通画像同形（subject.platform 仍 github），仅存储行 subject_platform=all
  const fusedProfile = buildFusedFixtureProfile();
  await storage.profiles.insert({
    id: FIXTURE_FUSED_PROFILE_ID,
    analyzerVersion: fusedProfile.analyzerVersion,
    subjectPlatform: 'all',
    subjectLogin: fusedProfile.subject.login,
    subjectClaimed: fusedProfile.subject.claimed,
    dataWindowSince: fusedProfile.dataWindow.since,
    dataWindowUntil: fusedProfile.dataWindow.until,
    status: 'complete',
    snapshot: fusedProfile,
  });

  // 授权分级闸（2026-09-19）：本人账号 + 固定未过期会话 + 一条可点击外部 PR 证据，
  // 供 gated-content spec 用 jobagent_session cookie 模拟已登录 user。
  const account = await storage.accounts.upsertFromProvider({
    id: 'acc-e2e-fixture',
    identity: {
      platform: 'github',
      providerAccountId: FIXTURE_ACCOUNT_PROVIDER_ID,
      login: FIXTURE_LOGIN,
      name: 'E2E Fixture',
      email: null,
      avatarUrl: null,
    },
  });
  await storage.authSessions.create({
    id: FIXTURE_SESSION_TOKEN,
    accountId: account.id,
    expiresAt: '2030-01-01T00:00:00.000Z',
  });
  await storage.evidence.importFromProfile(FIXTURE_PROFILE_ID, [
    {
      evidenceId: 'evt-ext-pr-1',
      sourcePlatform: 'github',
      sourceType: 'pr',
      url: 'https://github.com/e2e-fixture-user/core/pull/42',
      layer: 'L1',
      claim: 'Authored and merged an external pull request.',
      rawRef: 'e2e-fixture-user/core#42',
    },
  ]);

  await storage.close();

  // 自检：重新以 readonly 打开，确认 fixture 确实落盘（避免 webServer 读到空库）
  const verify = await createStorage({ readonly: true, sqlitePath: DB_FILE });
  const record = await verify.profiles.getById(FIXTURE_PROFILE_ID);
  await verify.close();
  if (!record) {
    throw new Error(`[e2e] fixture profile ${FIXTURE_PROFILE_ID} not found after insert at ${DB_FILE}`);
  }

  // eslint-disable-next-line no-console
  console.log(`[e2e] fixture DB ready at ${DB_FILE} (login=${record.snapshot?.subject.login})`);

  // 返回 teardown：浏览器全部关闭后清理临时目录。
  // webServer 关闭时 better-sqlite3 句柄可能延迟释放导致 Windows EBUSY，
  // 残留文件无害（下次 globalSetup 开头会先 rmSync 清空），故吞掉清理错误。
  return async () => {
    try {
      rmSync(TMP_DIR, { recursive: true, force: true });
    } catch {
      // ignore: cleaned at next globalSetup start
    }
  };
}
