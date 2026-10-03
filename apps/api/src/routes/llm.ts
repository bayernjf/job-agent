/**
 * LLM 模型供给路由（decision #21，design-llm-model-provisioning-20261003 §4）。
 *
 * 两条独立面：
 * - `/admin/llm-catalog`：平台管理员维护内置目录（迁移 024）。凭证永远在 env，
 *   本面只读写目录字段（白名单不变量在 mergeBuiltinCatalog 里强制）。
 * - `/account/llm-config`：登录用户管理自己的 BYOK 配置（迁移 025）。apiKey 只以
 *   AES-256-GCM 密文落库（LLM_ENC_KEY），对外只回显掩码。
 *
 * 鉴权：两个面都要求 kind='user'（401）；admin 面额外要求 accounts.is_admin（403）。
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  AdminLlmCatalogViewSchema,
  LlmCatalogUpsertSchema,
  UserLlmConfigSaveSchema,
  UserLlmConfigViewSchema,
  type LlmCatalogModel,
  type StoredUserLlmConfig,
} from '@jobagent/shared';
import {
  decryptApiKey,
  encryptApiKey,
  maskApiKey,
  OpenAICompatibleClient,
} from '@jobagent/llm';
import type { RouteDeps } from './context.js';
import type { HonoEnv } from './types.js';

const AUTH_REQUIRED = 'AUTH_REQUIRED';
const FORBIDDEN = 'FORBIDDEN';
const ENCRYPTION_NOT_CONFIGURED = 'ENCRYPTION_NOT_CONFIGURED';
const NOT_FOUND = 'NOT_FOUND';
const LLM_VALIDATION_FAILED = 'LLM_VALIDATION_FAILED';
const BAD_REQUEST = 'BAD_REQUEST';

/** 守卫结果：ok=true 携带 accountId；ok=false 携带已写入的 Response。 */
type GuardResult = { ok: true; accountId: string } | { ok: false; response: Response };

/** 只允许登录用户（kind='user'）；匿名/demo 一律 401。 */
async function requireUser(c: Context, d: RouteDeps): Promise<GuardResult> {
  const principal = c.get('principal');
  if (principal.kind !== 'user') {
    return { ok: false, response: c.json({ error: 'login required', code: AUTH_REQUIRED }, 401) };
  }
  const account = await d.repos.accounts.getById(principal.accountId);
  if (!account) {
    return { ok: false, response: c.json({ error: 'account not found', code: AUTH_REQUIRED }, 401) };
  }
  return { ok: true, accountId: principal.accountId };
}

/** admin 面：登录用户 + is_admin；非 admin 一律 403。 */
async function requireAdmin(c: Context, d: RouteDeps): Promise<GuardResult> {
  const user = await requireUser(c, d);
  if (!user.ok) return user;
  const account = await d.repos.accounts.getById(user.accountId);
  if (!account?.isAdmin) {
    return { ok: false, response: c.json({ error: 'admin privilege required', code: FORBIDDEN }, 403) };
  }
  return { ok: true, accountId: user.accountId };
}

/** 目录行 → admin 视图（白名单字段已在合并层保证；凭证字段结构上不存在）。 */
function toCatalogView(d: RouteDeps): { models: LlmCatalogModel[]; envConfigured: boolean } {
  return {
    models: [...d.catalogCache.get()],
    // 只回"内置凭证是否已配置"，绝不回显任何 key 内容
    envConfigured: Boolean(process.env.LLM_API_KEY?.trim()),
  };
}

/** 仓储行 → BYOK 对外视图（只给掩码）。 */
function toConfigView(cfg: StoredUserLlmConfig, encKey: string): unknown {
  const plaintext = decryptApiKey(cfg.apiKeyEncrypted, encKey);
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    keyMasked: maskApiKey(plaintext),
  };
}

/** 简化审计日志（完整审计表缓做，见 design §4.2）：不记凭证、不记价格。 */
function logAdminAction(action: string, actor: string, modelIds: string[]) {
  console.log(
    `[admin-catalog] action=${action} actor=${actor} models=${modelIds.join(',') || '-'}`,
  );
}

export function registerLlmRoutes(app: Hono<HonoEnv>, d: RouteDeps): void {
  // ── 内置目录（admin 面，迁移 024）───────────────────────────────────────────
  app.get('/admin/llm-catalog', async (c) => {
    const guard = await requireAdmin(c, d);
    if (!guard.ok) return guard.response;
    const view = AdminLlmCatalogViewSchema.parse(toCatalogView(d));
    return c.json(view);
  });

  app.put('/admin/llm-catalog', async (c) => {
    const guard = await requireAdmin(c, d);
    if (!guard.ok) return guard.response;
    const body = LlmCatalogUpsertSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      c.status(400);
      return c.json({ error: 'invalid catalog payload', code: BAD_REQUEST });
    }
    const nowIso = d.now();
    // 整体替换：行的时间戳由服务端填，目录字段完全来自请求（白名单在合并层强制）
    await d.repos.llmCatalog.replaceAll(
      body.data.models.map((m) => ({ ...m, createdAt: nowIso, updatedAt: nowIso })),
    );
    d.catalogCache.refresh(body.data.models);
    logAdminAction(
      'catalog_update',
      guard.accountId,
      body.data.models.map((m) => m.id),
    );
    return c.json(AdminLlmCatalogViewSchema.parse(toCatalogView(d)));
  });

  app.post('/admin/llm-catalog/refresh', async (c) => {
    const guard = await requireAdmin(c, d);
    if (!guard.ok) return guard.response;
    // 显式重读仓储（例如外部 DDL 直改）：写后刷新缓存即生效，无需重启
    const rows = await d.repos.llmCatalog.listAll();
    d.catalogCache.refresh(rows);
    logAdminAction('catalog_refresh', guard.accountId, rows.map((r) => r.id));
    return c.json(AdminLlmCatalogViewSchema.parse(toCatalogView(d)));
  });

  // ── BYOK（登录用户，迁移 025）──────────────────────────────────────────────
  app.get('/account/llm-config', async (c) => {
    const guard = await requireUser(c, d);
    if (!guard.ok) return guard.response;
    const cfg = await d.repos.userLlmConfigs.getByAccountId(guard.accountId);
    if (!cfg) {
      c.status(404);
      return c.json({ error: 'no BYOK config yet', code: NOT_FOUND });
    }
    if (!d.llmEncKey) {
      c.status(503);
      return c.json({ error: 'encryption key not configured on the server', code: ENCRYPTION_NOT_CONFIGURED });
    }
    return c.json(UserLlmConfigViewSchema.parse(toConfigView(cfg, d.llmEncKey)));
  });

  app.put('/account/llm-config', async (c) => {
    const guard = await requireUser(c, d);
    if (!guard.ok) return guard.response;
    const body = UserLlmConfigSaveSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      c.status(400);
      return c.json({ error: 'invalid BYOK config payload', code: BAD_REQUEST });
    }
    if (!d.llmEncKey) {
      c.status(503);
      return c.json({ error: 'encryption key not configured on the server', code: ENCRYPTION_NOT_CONFIGURED });
    }
    const existing = await d.repos.userLlmConfigs.getByAccountId(guard.accountId);
    const apiKey = body.data.apiKey ?? (existing ? decryptApiKey(existing.apiKeyEncrypted, d.llmEncKey) : null);
    if (!apiKey) {
      // 既无旧配置又没给 key：无法保存一个没有凭证的 BYOK 配置
      c.status(400);
      return c.json({ error: 'apiKey is required when no config exists yet', code: BAD_REQUEST });
    }
    const nowIso = d.now();
    const saved = await d.repos.userLlmConfigs.upsert({
      accountId: guard.accountId,
      provider: body.data.provider,
      baseUrl: body.data.baseUrl,
      model: body.data.model,
      apiKeyEncrypted: encryptApiKey(apiKey, d.llmEncKey),
      createdAt: existing?.createdAt ?? nowIso,
      updatedAt: nowIso,
    });
    return c.json(UserLlmConfigViewSchema.parse(toConfigView(saved, d.llmEncKey)));
  });

  app.delete('/account/llm-config', async (c) => {
    const guard = await requireUser(c, d);
    if (!guard.ok) return guard.response;
    await d.repos.userLlmConfigs.deleteByAccountId(guard.accountId);
    c.status(204);
    return c.body(null);
  });

  app.post('/account/llm-config/validate', async (c) => {
    const guard = await requireUser(c, d);
    if (!guard.ok) return guard.response;
    const body = UserLlmConfigSaveSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success || !body.data.apiKey) {
      c.status(400);
      return c.json({ error: 'baseUrl/model/apiKey are required for validation', code: BAD_REQUEST });
    }
    try {
      // 最小验证：max_tokens=1 的真实请求（用户自己的 key 打用户自己的端点；
      // SSRF 面记录在 design §7 风险表，MVP 接受：该请求只携带用户自己提供的凭证）
      const client = new OpenAICompatibleClient({
        baseUrl: body.data.baseUrl,
        apiKey: body.data.apiKey,
        model: body.data.model,
      });
      await client.generateJson({
        messages: [{ role: 'user', content: 'ping' }],
        temperature: 0,
        requestId: `byok-validate-${guard.accountId}`,
      });
      return c.json({ ok: true, provider: client.provider, model: client.model });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      c.status(502);
      return c.json({
        ok: false,
        error: `validation failed: ${detail}`,
        code: LLM_VALIDATION_FAILED,
      });
    }
  });
}
