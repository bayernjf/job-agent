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
  buildClaimedFixtureProfile,
  buildFusedFixtureProfile,
  buildGiteeFixtureProfile,
  buildNextStepsFixtureProfile,
  buildPartialFixtureProfile,
  FIXTURE_PROFILE_ID,
  FIXTURE_CLAIMED_PROFILE_ID,
  FIXTURE_FUSED_PROFILE_ID,
  FIXTURE_GITEE_PROFILE_ID,
  FIXTURE_NEXT_STEPS_PROFILE_ID,
  FIXTURE_NEXT_STEPS_EVIDENCE_ID,
  FIXTURE_PARTIAL_PROFILE_ID,
  FIXTURE_LOGIN,
  FIXTURE_ACCOUNT_PROVIDER_ID,
  FIXTURE_SESSION_TOKEN,
  FIXTURE_EMPTY_LOGIN,
  FIXTURE_EMPTY_SESSION_TOKEN,
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

  // 已认领画像（决策 #17-F11）：主体与下面种下的本人账号一致且 subject_claimed=true，
  // 供 application-privacy spec 断言"投递管道只对本人挂载"。
  const claimedProfile = buildClaimedFixtureProfile();
  await storage.profiles.insert({
    id: FIXTURE_CLAIMED_PROFILE_ID,
    analyzerVersion: claimedProfile.analyzerVersion,
    subjectPlatform: claimedProfile.subject.platform,
    subjectLogin: claimedProfile.subject.login,
    subjectClaimed: true,
    dataWindowSince: claimedProfile.dataWindow.since,
    dataWindowUntil: claimedProfile.dataWindow.until,
    status: 'complete',
    snapshot: claimedProfile,
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

  // Gitee 主体画像（2026-09-20）：subject.platform='gitee'，供授权分级闸 SSR 登录墙
  // 按画像主体平台引导到 Gitee OAuth 的 E2E（gated-content spec）。
  const giteeProfile = buildGiteeFixtureProfile();
  await storage.profiles.insert({
    id: FIXTURE_GITEE_PROFILE_ID,
    analyzerVersion: giteeProfile.analyzerVersion,
    subjectPlatform: 'gitee',
    subjectLogin: giteeProfile.subject.login,
    subjectClaimed: giteeProfile.subject.claimed,
    dataWindowSince: giteeProfile.dataWindow.since,
    dataWindowUntil: giteeProfile.dataWindow.until,
    status: 'complete',
    snapshot: giteeProfile,
  });

  // "下一步动作"画像（T10）：带 improvementSuggestions + 一条可点开的提交证据，
  // 供 report-render spec 断言建议随读者语言渲染、证据外链仍受登录闸约束。
  const nextStepsProfile = buildNextStepsFixtureProfile();
  await storage.profiles.insert({
    id: FIXTURE_NEXT_STEPS_PROFILE_ID,
    analyzerVersion: nextStepsProfile.analyzerVersion,
    subjectPlatform: nextStepsProfile.subject.platform,
    subjectLogin: nextStepsProfile.subject.login,
    subjectClaimed: nextStepsProfile.subject.claimed,
    dataWindowSince: nextStepsProfile.dataWindow.since,
    dataWindowUntil: nextStepsProfile.dataWindow.until,
    status: 'complete',
    snapshot: nextStepsProfile,
  });
  await storage.evidence.importFromProfile(FIXTURE_NEXT_STEPS_PROFILE_ID, [
    {
      evidenceId: FIXTURE_NEXT_STEPS_EVIDENCE_ID,
      sourcePlatform: 'github',
      sourceType: 'commit',
      url: 'https://github.com/e2e-next-steps-user/core/commit/aa11bb2',
      layer: 'L1',
      claim: '42 commits across 3 own repositories.',
      rawRef: 'e2e-next-steps-user/core@aa11bb2',
    },
  ]);

  // T29：partial 终态画像（T25 语义），供批次 6 表面「partial 提示条」浏览器级验证。
  const partialProfile = buildPartialFixtureProfile();
  await storage.profiles.insert({
    id: FIXTURE_PARTIAL_PROFILE_ID,
    analyzerVersion: partialProfile.analyzerVersion,
    subjectPlatform: partialProfile.subject.platform,
    subjectLogin: partialProfile.subject.login,
    subjectClaimed: partialProfile.subject.claimed,
    dataWindowSince: partialProfile.dataWindow.since,
    dataWindowUntil: partialProfile.dataWindow.until,
    status: 'partial',
    snapshot: partialProfile,
  });

  // T29：「我的」页空态账号——登录但名下没有任何画像（供 my-page 空态断言）。
  const emptyAccount = await storage.accounts.upsertFromProvider({
    id: 'acc-e2e-empty',
    identity: {
      platform: 'github',
      providerAccountId: '9002',
      login: FIXTURE_EMPTY_LOGIN,
      name: 'E2E Empty User',
      email: null,
      avatarUrl: null,
    },
  });
  await storage.authSessions.create({
    id: FIXTURE_EMPTY_SESSION_TOKEN,
    accountId: emptyAccount.id,
    expiresAt: '2030-01-01T00:00:00.000Z',
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
