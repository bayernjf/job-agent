/**
 * 逐条声明核验路由（决策 #23 批次 2）：把"用户带来的简历逐条话，GitHub 痕迹支撑得起吗"
 * 这条反向通路接上 HTTP。判定内核在 `packages/claim-core`（纯函数），本层只做
 * 读画像 → 读证据 → 调内核 → 落库 → 投影，绝不改写任何画像字段。
 *
 * 端点（design-claim-verification §6，命名与表名同名以防撞上既有的"认领画像" /claim）：
 *   - POST   /profiles/:id/claim-verifications   建声明并核验
 *   - GET    /profiles/:id/claim-verifications   列出该画像的全部结论
 *   - DELETE /claim-verifications/:id            撤回一条（创建者或画像本人）
 *
 * 首版授权（§6，已拍板）：只对"已登录 user 且（画像本人且已认领 / 已声明招聘方）"开放，
 * **不向 anonymous 开放**；未认领画像只允许已声明招聘方核验。声明是可撤回的用户输入，
 * 不进画像快照、不进 /exportable、不进 MCP 面。
 */
import type { Hono, Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { AUTH_ERROR_CODES } from '@jobagent/shared';
import { assessClaim, SUPPORTABLE_MIN_EVIDENCE, type ClaimEvidence } from '@jobagent/claim-core';
import type { StoredClaimVerification, StoredProfile } from '@jobagent/storage';
import { ClaimVerificationCreateSchema, ProfileIdParamSchema } from './schemas.js';
import type { HonoEnv } from './types.js';
import type { RouteDeps } from './context.js';

/**
 * 对外投影：与表列一一对应，只给"结论 + 证据指针"，不拼自然语言句子
 * （句子由渲染侧按 locale 用 verdict 现拼，见 design §5 的 code+facts 口径）。
 * `requiredEvidenceCount` 随行返回，让 UI 能解释 `partial` 差多少而不必内置规则常量。
 */
function formatClaimVerification(row: StoredClaimVerification) {
  return {
    id: row.id,
    profileId: row.profileId,
    subject: { platform: row.subjectPlatform, login: row.subjectLogin },
    claimText: row.claimText,
    claimSource: row.claimSource,
    claimRef: row.claimRef,
    verdict: row.verdict,
    matchedEvidenceRefs: row.matchedEvidenceRefs,
    confidence: row.confidence,
    ruleVersion: row.ruleVersion,
    requiredEvidenceCount: SUPPORTABLE_MIN_EVIDENCE,
    createdAt: row.createdAt,
  };
}

/**
 * 核验通路授权（§6）：登录 user 且（画像本人且已认领 / 已声明招聘方）。
 *
 * 明确区分两种拒绝，不做静默降级：
 *   - 未登录 → 401 AUTH_REQUIRED
 *   - 已认领画像但不是本人（且非招聘方）→ 403 AUTH_NOT_PROFILE_OWNER
 *   - 未认领画像的非招聘方 → 403 RECRUITER_DECLARATION_REQUIRED（此时没有可授权的本人）
 * 融合画像（subjectPlatform='all'）沿用认领口径：任一源 login 与登录名一致即视为本人。
 */
async function authorizeVerifier(
  c: Context<HonoEnv>,
  d: RouteDeps,
  profile: StoredProfile,
): Promise<Response | undefined> {
  const principal = c.get('principal');
  if (principal.kind !== 'user') {
    return c.json({ error: 'authentication required', code: AUTH_ERROR_CODES.authRequired }, 401);
  }
  const account = await d.repos.accounts.getById(principal.accountId);
  const isRecruiter = Boolean(account?.recruiterDeclaredAt);
  const isOwner =
    profile.subjectClaimed &&
    (profile.subjectPlatform === 'all'
      ? profile.subjectLogin === principal.login
      : profile.subjectPlatform === principal.platform && profile.subjectLogin === principal.login);
  if (isRecruiter || isOwner) return undefined;
  if (profile.subjectClaimed) {
    return c.json({ error: 'not the profile owner', code: AUTH_ERROR_CODES.notProfileOwner }, 403);
  }
  return c.json(
    { error: 'recruiter declaration required', code: AUTH_ERROR_CODES.recruiterRequired },
    403,
  );
}

export function registerClaimVerifications(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos } = d;

  // POST /profiles/:id/claim-verifications：建一条结构化声明并核验（B 主干，无解析风险）
  app.post('/profiles/:id/claim-verifications', async (c) => {
    const param = ProfileIdParamSchema.safeParse(c.req.param());
    if (!param.success) return c.json({ error: 'invalid profile id' }, 400);
    const profile = await repos.profiles.getById(param.data.id);
    if (!profile) return c.json({ error: 'profile not found' }, 404);
    const gate = await authorizeVerifier(c, d, profile);
    if (gate) return gate;

    const parsed = ClaimVerificationCreateSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ error: 'invalid claim', details: parsed.error.flatten() }, 400);
    }
    // 没有快照就没有可核验的画像事实——如实拒绝，不给一份"看起来完整"的结论。
    const snapshot = profile.snapshot;
    if (!snapshot) return c.json({ error: 'profile snapshot unavailable' }, 409);

    const principal = c.get('principal');
    const accountId = principal.kind === 'user' ? principal.accountId : null;

    // 证据行 → 内核输入（内核不碰 DB；这里只做字段搬运，不做判定）
    const evidenceRows = await repos.evidence.listByProfile(profile.id);
    const evidence: ClaimEvidence[] = evidenceRows
      .filter((e) => e.url.length > 0)
      .map((e) => ({
        evidenceId: e.id,
        url: e.url,
        rawRef: e.rawRef,
        sourceType: e.sourceType,
        claim: e.claim,
      }));

    const id = `claimv-${randomUUID()}`;
    const assessment = assessClaim({
      claim: {
        id,
        text: parsed.data.text,
        source: 'manual', // resume_import 属 A 导入器（未获批），本刀不开放
        ...(parsed.data.claimRef ? { claimRef: parsed.data.claimRef } : {}),
      },
      profile: {
        skillTags: snapshot.skillTags.map((s) => ({
          name: s.name,
          kind: s.kind,
          depth: s.depth,
          confidence: s.confidence,
          evidenceRefs: s.evidenceRefs,
        })),
      },
      evidence,
    });

    // 融合画像的 subjectPlatform 是作业参数 'all'，不是主体平台；核验行只认主体平台，
    // 沿用融合主源 GitHub（login 两源一致，主体标识不受影响）。
    const subjectPlatform = profile.subjectPlatform === 'gitee' ? 'gitee' : 'github';
    await repos.claimVerifications.insert({
      id,
      profileId: profile.id,
      subjectPlatform,
      subjectLogin: profile.subjectLogin,
      claimText: parsed.data.text,
      claimSource: 'manual',
      claimRef: parsed.data.claimRef ?? null,
      verdict: assessment.verdict,
      matchedEvidenceRefs: assessment.evidenceIds,
      confidence: assessment.confidence,
      verifierAccountId: accountId,
      ruleVersion: assessment.ruleVersion,
    });

    const row = await repos.claimVerifications.getById(id);
    return c.json(formatClaimVerification(row!), 201);
  });

  // GET /profiles/:id/claim-verifications：列出该画像的全部结论（稳定顺序＝可复核）
  app.get('/profiles/:id/claim-verifications', async (c) => {
    const param = ProfileIdParamSchema.safeParse(c.req.param());
    if (!param.success) return c.json({ error: 'invalid profile id' }, 400);
    const profile = await repos.profiles.getById(param.data.id);
    if (!profile) return c.json({ error: 'profile not found' }, 404);
    const gate = await authorizeVerifier(c, d, profile);
    if (gate) return gate;

    const items = await repos.claimVerifications.listByProfile(profile.id);
    return c.json({ items: items.map(formatClaimVerification) });
  });

  // DELETE /claim-verifications/:id：撤回一条声明（创建者本人或画像本人）
  app.delete('/claim-verifications/:id', async (c) => {
    const principal = c.get('principal');
    if (principal.kind !== 'user') {
      return c.json({ error: 'authentication required', code: AUTH_ERROR_CODES.authRequired }, 401);
    }
    const id = c.req.param('id');
    const row = await repos.claimVerifications.getById(id);
    if (!row) return c.json({ error: 'claim verification not found' }, 404);

    const isCreator = row.verifierAccountId === principal.accountId;
    // 画像本人只在"已认领"时可判定（未认领画像没有可授权的本人，与 POST 同口径）
    let isProfileOwner = false;
    if (!isCreator && row.profileId) {
      const profile = await repos.profiles.getById(row.profileId);
      if (profile?.subjectClaimed) {
        isProfileOwner =
          profile.subjectPlatform === 'all'
            ? profile.subjectLogin === principal.login
            : profile.subjectPlatform === principal.platform &&
              profile.subjectLogin === principal.login;
      }
    }
    if (!isCreator && !isProfileOwner) {
      return c.json({ error: 'not allowed to withdraw this claim', code: AUTH_ERROR_CODES.notProfileOwner }, 403);
    }

    await repos.claimVerifications.delete(id);
    return c.json({ deleted: true, id });
  });
}