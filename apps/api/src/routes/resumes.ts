/**
 * 岗位定向简历路由（Q1 单文件拆分，P-R2）：按需生成、不入库、不记日志。
 * 纯计算只读端点：不触发新分析、不消耗采集配额，对所有身份公开；
 * polish=true 真实调用 LLM（付费），只对已登录 user 开放。
 */
import type { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  JobPostingSchema,
  type AbilityProfile,
  type JobPosting,
  type LocalResumeFields,
  type ResumeLocale,
} from '@jobagent/shared';
import { toEvidenceItems } from '@jobagent/storage';
import { matchJobs } from '@jobagent/job-source';
import {
  aiAssistedDisclosure,
  buildResume,
  fromJobMatch,
  polishResume,
  renderHtml,
  renderMarkdown,
} from '@jobagent/resume-core';
import type { LlmTokenUsage, MeteredResumePolishProvider } from '@jobagent/llm';
import type { RouteDeps } from './context.js';
import { resolveTextLlm } from './llm-resolve.js';
import { describeError } from './helpers.js';
import { CoverLetterRequestSchema, ResumeBuildRequestSchema } from './schemas.js';
import type { HonoEnv } from './types.js';

export function registerResumes(app: Hono<HonoEnv>, d: RouteDeps): void {
  const { repos, now } = d;

  app.post('/resumes/build', async (c) => {
    const buildPrincipal = c.get('principal');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = ResumeBuildRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }
    const req = parsed.data;
    if (req.polish === true && buildPrincipal.kind !== 'user') {
      return c.json({ error: 'polish requires an authenticated user', code: 'AUTH_REQUIRED' }, 403);
    }

    const storedProfile = await repos.profiles.getById(req.profileId);
    if (!storedProfile) return c.json({ error: 'profile not found' }, 404);
    if (!storedProfile.snapshot) return c.json({ error: 'profile has no snapshot' }, 404);
    const profile: AbilityProfile = storedProfile.snapshot;

    // T24② 岗位来源：jobId（池子）或 posting（粘贴 JD 直传，不入池；jobId 分支保持原行为）
    let posting: JobPosting;
    if (req.posting) {
      const nowIso = new Date().toISOString();
      posting = {
        jobId: `manual-${randomUUID()}`,
        source: 'manual',
        sourceUrl: `https://manual.local/${randomUUID()}`,
        title: req.posting.title,
        company: req.posting.company ?? '',
        description: req.posting.description,
        location: null,
        remote: false,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        tags: [],
        postedAt: nowIso,
        fetchedAt: nowIso,
      };
    } else {
      const postingRow = await repos.jobPostings.getById(req.jobId!);
      if (!postingRow) return c.json({ error: 'job posting not found' }, 404);
      const postingParse = JobPostingSchema.safeParse(postingRow);
      if (!postingParse.success) {
        return c.json({ error: 'stored job posting is invalid' }, 500);
      }
      posting = postingParse.data;
    }

    const evidenceRows = await repos.evidence.listByProfile(req.profileId);
    const evidence = toEvidenceItems(evidenceRows);

    // 匹配现算（单个岗位）；零命中 fromJobMatch(null) 走 low_match 降级（与 CLI 同路径）
    const skills = profile.skillTags.map((tag) => tag.name);
    const [matched] = matchJobs([posting], { skills, limit: 1 });
    const match = fromJobMatch(matched ?? null);

    const locale: ResumeLocale = req.locale ?? 'zh-CN';
    const ruleDraft = buildResume({
      profile,
      evidence,
      posting,
      match,
      local: req.local as LocalResumeFields | undefined,
      options: { locale, highlightLimit: req.highlightLimit, now: now() },
    });

    // 可选 B 档 LLM 措辞润色：只改措辞、安全层防臆造，任何失败/未配置都回退规则版（draft 引用不变）。
    // LLM 供给（决策 #21）：每次调用前解析 BYOK 优先 → 内置回落 → 规则版。
    let finalDraft = ruleDraft;
    let polish: { requested: boolean; applied: boolean; reason?: string } | undefined;
    if (req.polish === true) {
      polish = { requested: true, applied: false };
      const llm = await resolveTextLlm(c, d);
      if (llm.source === 'none') {
        polish.reason = 'not_configured';
      } else {
        // 成本回采（决策 #25 ④ Wave B）：给 provider 包一层计量装饰器注入 onUsage
        // 观察者；token 由响应 usage 透出，缺失记 null（绝不编数）。billingSource
        // 按当次 resolveTextLlm 的真实路由结果定（不是按账号有没有 BYOK 配置猜）。
        // 显式构造四字段对象而非 spread，避免把实现类的 private 字段拷出来。
        const usageHolder: { current: LlmTokenUsage | null; succeeded: boolean } = {
          current: null,
          succeeded: false,
        };
        const base = llm.polish!;
        const metered: MeteredResumePolishProvider = {
          provider: base.provider,
          model: base.model,
          promptVersion: base.promptVersion,
          polish: async (input) => {
            const out = await base.polish({
              ...input,
              onUsage: (u) => {
                usageHolder.current = u;
              },
            });
            // provider 不抛 ⇒ 本次 LLM 调用成功完成（schema 校验失败会抛，
            // 被 polishResume 吞成 provider_error，那种情形不记）。
            usageHolder.succeeded = true;
            return out;
          },
        };
        const result = await polishResume(ruleDraft, posting, metered, {
          locale,
          now: now(),
        });
        finalDraft = result.draft;
        polish.applied = result.applied;
        if (!result.applied && result.reason) polish.reason = result.reason;
        // 只记成功完成的 LLM 调用（口径与 cover-letter / JD 抽取一致）；
        // recorder 本身 fail-open，调用点不再包 try/catch。
        if (usageHolder.succeeded) {
          await d.usageRecorder.record({
            accountId: buildPrincipal.kind === 'user' ? buildPrincipal.accountId : null,
            category: 'llm',
            feature: 'resume_polish',
            billingSource: llm.source === 'byok' ? 'byok' : 'builtin',
            provider: base.provider,
            model: base.model,
            promptTokens: usageHolder.current?.promptTokens ?? null,
            completionTokens: usageHolder.current?.completionTokens ?? null,
            quantity: null,
          });
          // hub 模式：内置面用量同步到 hub（含 assignment_id）；BYOK 不上报。
          if (llm.assignmentId && llm.source === 'builtin') {
            await d.hubCatalog?.reportUsage({
              feature: 'resume_polish',
              assignmentId: llm.assignmentId,
              promptTokens: usageHolder.current?.promptTokens ?? undefined,
              completionTokens: usageHolder.current?.completionTokens ?? undefined,
            });
          }
        }
      }
    }

    if (req.format === 'html') {
      return c.json({
        format: 'html' as const,
        draft: finalDraft,
        html: renderHtml(finalDraft, locale),
        ...(polish ? { polish } : {}),
      });
    }
    if (req.format === 'md') {
      return c.json({
        format: 'md' as const,
        draft: finalDraft,
        markdown: renderMarkdown(finalDraft, locale),
        ...(polish ? { polish } : {}),
      });
    }
    return c.json({ draft: finalDraft, ...(polish ? { polish } : {}) });
  });

  // 求职信生成（A 档，2026-10-03）：LLM 生成性 prose，无规则版回退——
  // 未配置/失败一律如实报错（绝不伪造"伪求职信"）；仅登录 user 可调（付费）。
  app.post('/resumes/cover-letter', async (c) => {
    const buildPrincipal = c.get('principal');
    if (buildPrincipal.kind !== 'user') {
      return c.json(
        { error: 'cover letter requires an authenticated user', code: 'AUTH_REQUIRED' },
        403,
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = CoverLetterRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'validation failed', details: parsed.error.flatten() }, 400);
    }
    const req = parsed.data;
    // LLM 供给（决策 #21）：BYOK 优先 → 内置回落；两者都无 → 如实 LLM_NOT_CONFIGURED。
    const llm = await resolveTextLlm(c, d);
    if (!llm.cover) {
      return c.json(
        { error: 'LLM is not configured on the server', code: 'LLM_NOT_CONFIGURED' },
        503,
      );
    }
    const coverLetterProvider = llm.cover;

    const storedProfile = await repos.profiles.getById(req.profileId);
    if (!storedProfile) return c.json({ error: 'profile not found' }, 404);
    if (!storedProfile.snapshot) return c.json({ error: 'profile has no snapshot' }, 404);
    const profile: AbilityProfile = storedProfile.snapshot;

    let posting: JobPosting;
    if (req.posting) {
      const nowIso = new Date().toISOString();
      posting = {
        jobId: `manual-${randomUUID()}`,
        source: 'manual',
        sourceUrl: `https://manual.local/${randomUUID()}`,
        title: req.posting.title,
        company: req.posting.company ?? '',
        description: req.posting.description,
        location: null,
        remote: false,
        salaryMin: null,
        salaryMax: null,
        salaryCurrency: null,
        tags: [],
        postedAt: nowIso,
        fetchedAt: nowIso,
      };
    } else {
      const postingRow = await repos.jobPostings.getById(req.jobId!);
      if (!postingRow) return c.json({ error: 'job posting not found' }, 404);
      const postingParse = JobPostingSchema.safeParse(postingRow);
      if (!postingParse.success) {
        return c.json({ error: 'stored job posting is invalid' }, 500);
      }
      posting = postingParse.data;
    }

    const evidenceRows = await repos.evidence.listByProfile(req.profileId);
    const evidence = toEvidenceItems(evidenceRows);
    const skills = profile.skillTags.map((tag) => tag.name);
    const [matched] = matchJobs([posting], { skills, limit: 1 });
    const match = fromJobMatch(matched ?? null);
    const locale: ResumeLocale = req.locale ?? 'zh-CN';
    const ruleDraft = buildResume({
      profile,
      evidence,
      posting,
      match,
      local: req.local as LocalResumeFields | undefined,
      options: { locale, now: now() },
    });

    try {
      // 成本回采（决策 #25 ④ Wave B）：onUsage 观察者回采 token，缺失记 null；
      // billingSource 按当次 resolveTextLlm 的真实路由结果定。LLM 调用成功
      // （不抛错）后立即记录一次可计费调用；recorder fail-open，不包 try/catch。
      const usageHolder: { current: LlmTokenUsage | null } = { current: null };
      const out = await coverLetterProvider.generate({
        draft: ruleDraft,
        posting,
        locale,
        onUsage: (u) => {
          usageHolder.current = u;
        },
      });
      await d.usageRecorder.record({
        accountId: buildPrincipal.accountId,
        category: 'llm',
        feature: 'cover_letter',
        billingSource: llm.source === 'byok' ? 'byok' : 'builtin',
        provider: coverLetterProvider.provider,
        model: coverLetterProvider.model,
        promptTokens: usageHolder.current?.promptTokens ?? null,
        completionTokens: usageHolder.current?.completionTokens ?? null,
        quantity: null,
      });
      // hub 模式：内置面用量同步到 hub（含 assignment_id）；BYOK 不上报。
      if (llm.assignmentId && llm.source === 'builtin') {
        await d.hubCatalog?.reportUsage({
          feature: 'cover_letter',
          assignmentId: llm.assignmentId,
          promptTokens: usageHolder.current?.promptTokens ?? undefined,
          completionTokens: usageHolder.current?.completionTokens ?? undefined,
        });
      }
      return c.json({
        subject: out.subject,
        // E1 决策 #20-4：固定 AI 辅助投递披露，模型无法省略。
        body: `${out.body.trim()}\n\n${aiAssistedDisclosure(locale)}`,
        provenance: {
          provider: coverLetterProvider.provider,
          model: coverLetterProvider.model,
          promptVersion: coverLetterProvider.promptVersion,
        },
      });
    } catch (err) {
      // 失败只回传 reason、服务端一行日志都不落，等于让线上超时只能靠猜（2026-10-10 的
      // 两次 502 就是这样定性的）。这里把结构化诊断落到日志：跑的是哪个 provider/model、
      // 超时预算多少、上游回了什么状态。key、prompt、请求体一律不落。
      console.error(
        '[llm] cover letter failed:',
        JSON.stringify({
          provider: coverLetterProvider.provider,
          model: coverLetterProvider.model,
          profileId: req.profileId,
          jobId: req.jobId,
          locale,
          ...describeError(err),
        }),
      );
      return c.json(
        {
          error: 'cover letter generation failed',
          code: 'LLM_FAILED',
          reason: err instanceof Error ? err.message : 'unknown',
        },
        502,
      );
    }
  });
}
